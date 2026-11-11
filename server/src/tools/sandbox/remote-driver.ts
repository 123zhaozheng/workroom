// RemoteDriver (round 7): implements the SandboxDriver contract on top of ONE RemoteProvider (OpenSandbox, E2B, Daytona).
//
// The conversation workspace stays authoritative on the Workroom host. A run is:
//   get-or-create the remote sandbox of (org, space, workspaceKey, provider)  →  upload changed workspace files (sha256 manifest) into the
//   working directory (round 10: configurable per provider, default per provider — see workdir.ts; "/work" only for OpenSandbox)
//   → upload + hash-verify the read-only mounts (skills, re-rooted next to the working directory)  →  exec  →  download changed files back (normalised paths, no symlinks,
//   size limits, quota)  →  delete host files the run deleted  →  persist the manifest.
// Nothing here ever executes on the host. Anything a provider cannot do is an UnsupportedError (HTTP 501), never a local fallback.
// pi-durable checkpoints never contain sandbox memory or files: a lost sandbox is recreated and re-synced from the host workspace.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppContext, Space } from "../../core/contracts.ts";
import type { AppDb } from "../../core/db.ts";
import { HttpError, newId, nowIso } from "../../core/http.ts";
import type { SandboxInstanceDTO } from "../../../../shared/sandbox.ts";
import type { DriverCapabilities, DriverRunSpec, DriverServiceProcess, DriverServiceSpec, DriverStatus, IsolationNotes, ProcessRef, RunResult, SandboxDriver, SandboxMount, SandboxTrigger } from "./driver.ts";
import { recordSandboxEvent, type SandboxEventKind, type SandboxEventTrigger } from "./lifecycle-events.ts";
import { DEFAULT_LIFECYCLE, UnsupportedError, type ExplicitResources, type LifecyclePolicy, type ProviderId, type RemoteProvider, type RemoteSession } from "./provider.ts";
import { capped, checkEnv, shQuote } from "./util.ts";
import { providerConfigsFor } from "./provider-config.ts";
import { isWithin, mapMountTarget, resolveWorkDir, skillsRootFor } from "./workdir.ts";
import { fmtSize, isStoreTop, STORE_NAMES, storeLabel, type StoreMount, type StoreName } from "./stores.ts";
import * as ws from "./workspace.ts";

const MB = 1024 * 1024;
export const MOUNT_MARKER = ".workroom-sha256";
/** Hard caps so a hostile or runaway sandbox cannot make a sync unbounded. */
export const MAX_SYNC_ENTRIES = 20_000;
const HELPER_TIMEOUT_MS = 90_000;
const quotaBytes = () => Number(process.env.WORKROOM_SANDBOX_QUOTA_MB ?? 512) * MB;

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const bad = (code: string, msg: string, status = 400) => new HttpError(status, code, msg);

/** Remove anything that looks like a credential from text that may reach a run record. */
function scrub(text: string): string {
	return String(text)
		.replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [已隐藏]")
		.replace(/\b(authorization|x-api-key|api[_-]?key|apikey|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi, "$1$2[已隐藏]")
		.replace(/\b(sk|e2b|dtn|key)[_-][A-Za-z0-9_-]{12,}/gi, "[已隐藏]")
		.slice(0, 600);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Isolation statement (honest, per provider capabilities)
// ---------------------------------------------------------------------------------------------------------------------------------
export function remoteNotes(label: string, caps?: { isolation: string; location: "self_hosted" | "vendor_cloud" | "configurable"; skills: string; networkOn?: string }, workDir?: string): IsolationNotes {
	const where = !caps ? "由所选沙箱提供方运行" : caps.location === "vendor_cloud" ? "在第三方云服务上运行（工作区文件和命令离开本组织）" : caps.location === "self_hosted" ? "在管理员自建的沙箱服务上运行" : "在管理员配置的沙箱服务上运行";
	return {
		isolates: [
			`代码在远端沙箱（${label}）中执行，${where}；宿主机上不执行任何用户代码，也不会回退到宿主机执行`,
			...(caps ? [`提供方的隔离方式：${caps.isolation}`] : []),
			"每个空间的每个会话使用独立的远端沙箱（不同空间、不同组织不共享沙箱或文件）；沙箱空闲后自动暂停（文件始终保存在宿主机工作区），长期不用才销毁",
			`沙箱工作目录${workDir ? `（${workDir}）` : ""}是宿主机工作区的副本：运行前上传改动的文件，运行后下载改动（路径规范化、不跟随符号链接、单文件与总量限制、配额）`,
			"技能等挂载以“上传 + sha256 校验”方式提供（不是绑定挂载），并设为只读",
		],
		doesNotIsolate: [
			"技能目录的只读由文件权限（chmod）实现，不是内核级只读挂载；每次运行前会校验其哈希，被篡改则重新上传",
			"远端沙箱内的内存、进程与临时文件不会随 pi-durable 检查点保存；沙箱丢失后只能从宿主机工作区重新同步",
			"沙箱的出站网络由提供方（及其账户/服务配置）决定：Workroom 不要求也不阻止联网，不修改提供方的网络设置；沙箱内的联网不受本平台的 URL 策略约束，是否能访问互联网请以提供方的实际行为为准",
			"不支持常驻服务（MCP stdio 等）、终端、预览端口与快照：这些操作会被拒绝（501），不会在本机执行",
			"符号链接与特殊文件（设备、管道）不会同步回宿主机；超过单文件上限或配额的文件不同步",
		],
	};
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Host tree helpers
// ---------------------------------------------------------------------------------------------------------------------------------
interface TreeFile { rel: string; size: number; mtimeMs: number; exec: boolean }
interface Tree { files: TreeFile[]; dirs: string[]; notes: string[] }

/** Walk a directory without following symlinks. Symlinks and special files are skipped with a note; invalid names are skipped. */
function walk(root: string, valid: (rel: string) => boolean, cap = MAX_SYNC_ENTRIES, opts: { skipTop?: (name: string) => boolean } = {}): Tree {
	const t: Tree = { files: [], dirs: [], notes: [] };
	let count = 0;
	const rec = (abs: string, rel: string) => {
		let list;
		try {
			list = readdirSync(abs, { withFileTypes: true });
		} catch {
			return;
		}
		list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const e of list) {
			if (!rel && opts.skipTop?.(e.name)) continue; // round 11: reserved top-level names (memories/, project/) are not part of the conversation tree
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (++count > cap) {
				if (count === cap + 1) t.notes.push(`文件数量超过 ${cap}，其余文件未同步`);
				return;
			}
			if (!valid(r)) {
				t.notes.push(`名称不合法，未同步：${JSON.stringify(r).slice(0, 120)}`);
				continue;
			}
			const f = join(abs, e.name);
			let st;
			try {
				st = lstatSync(f);
			} catch {
				continue;
			}
			if (st.isSymbolicLink()) t.notes.push(`符号链接未同步：${r}`);
			else if (st.isDirectory()) {
				t.dirs.push(r);
				rec(f, r);
			} else if (st.isFile()) t.files.push({ rel: r, size: st.size, mtimeMs: st.mtimeMs, exec: (st.mode & 0o111) !== 0 });
			else t.notes.push(`特殊文件未同步：${r}`);
		}
	};
	rec(root, "");
	return t;
}

const validWorkPath = (rel: string): boolean => {
	try {
		return ws.cleanPath(rel) === rel && !rel.split("/").some((s) => s === "..");
	} catch {
		return false;
	}
};
/** Remote path as reported by a provider: relative POSIX, nothing that could address outside the working directory or break a shell/escape rule. */
export function normalizeRemotePath(p: unknown): string | null {
	if (typeof p !== "string" || !p || p.includes("\0") || p.includes("\\") || p.startsWith("/")) return null;
	return validWorkPath(p) ? p : null;
}

/** Deterministic hash of a directory tree: sha256 over sorted "<sha256>  ./<path>\n" lines (the same lines `sha256sum` prints). */
export function treeHash(entries: readonly { rel: string; sha: string }[]): string {
	const lines = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.rel), Buffer.from(b.rel))).map((e) => `${e.sha}  ./${e.rel}\n`);
	return sha256(lines.join(""));
}

type Manifest = Record<string, string>; // "a/b.txt" → sha256; "a/dir/" → "dir"; "memories/x" → sha256 of a persistent-store file; "@store:memories" → who the folder was seeded for

/** Round 11 (R5): one host directory ↔ one remote directory (the conversation workspace, or a persistent store shown inside it). */
interface SyncTree {
	/** "" (conversation workspace) or the store folder name below the working directory. */
	readonly prefix: "" | StoreName;
	readonly hostDir: string;
	readonly readOnly: boolean;
	readonly store?: StoreMount;
}
interface RemoteSlice {
	files: Map<string, number>;
	dirs: Set<string>;
	opaque: Set<string>;
}
/** Manifest key marking whose content a store folder in this sandbox holds ("@store:memories"); ":" can never occur in a workspace path, so no file collides with it. */
const STORE_MARK = "@store:";
/** `k` (a full manifest key) as a key of the tree `prefix`, or null when it belongs to another tree. The conversation tree ("") owns everything outside memories/ and project/. */
function keyInTree(k: string, prefix: string): string | null {
	if (k.startsWith(STORE_MARK)) return null;
	if (prefix === "") return isStoreTop(k.split("/")[0]!) ? null : k;
	return k.startsWith(`${prefix}/`) && k.length > prefix.length + 1 ? k.slice(prefix.length + 1) : null;
}
function viewOf(m: Manifest, prefix: string): Manifest {
	const out: Manifest = {};
	for (const [k, v] of Object.entries(m)) {
		const r = keyInTree(k, prefix);
		if (r !== null) out[r] = v;
	}
	return out;
}
function mergeView(m: Manifest, prefix: string, view: Manifest): void {
	for (const k of Object.keys(m)) if (keyInTree(k, prefix) !== null) delete m[k];
	for (const [k, v] of Object.entries(view)) m[prefix ? `${prefix}/${k}` : k] = v;
}

function parseManifest(s: string | null | undefined): Manifest {
	try {
		const o = JSON.parse(s || "{}");
		return o && typeof o === "object" && !Array.isArray(o) ? (o as Manifest) : {};
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------------------------------------------------------------
interface InstanceRow {
	id: string;
	org_id: string;
	space_id: string;
	workspace_key: string;
	provider: string;
	remote_id: string | null;
	state: SandboxInstanceDTO["state"];
	created_at: string;
	last_used_at: string;
	expires_at: string | null;
	last_error: string | null;
	manifest: string;
	network: number;
	/** Round 10: working directory the manifest refers to (NULL = instances of older versions: "/work"). */
	work_dir: string | null;
	/** Round 11: time of the last state change (ISO). NULL on rows of older versions (then last_used_at applies). */
	state_at: string | null;
	/** Round 11: for state paused: "provider" = the vendor holds the paused sandbox, "recreate" = it was destroyed (the host workspace is the only copy). */
	resume_mode: "provider" | "recreate" | null;
	/** Round 11: when the sandbox last STARTED running (create or resume), for the running-time (cost) of pause/destroy events. */
	running_since: string | null;
}
const LIVE = "('creating','ready','pausing','paused','resuming','archived','stopping')";
/** Safety margin on top of the idle-pause time for the provider-side timeout: reaper tick (60 s) + pause time. */
const TTL_MARGIN_SEC = 120;

/**
 * Round 8: what remote drivers are doing for a workspace RIGHT NOW (in process, nothing persisted), so the UI can say "preparing" truthfully.
 * `begin` while a run/prepare creates, reconnects or syncs the sandbox; `end` when that phase is over (the program itself then runs: not "preparing").
 * A failed phase leaves a failure marker (shown until the next successful phase); `ok` clears it. Keys: `activityKey(orgId, spaceId, workspaceKey, provider)`.
 */
export const remoteActivity = {
	preparing: new Map<string, number>(),
	failures: new Map<string, { error: string; at: number }>(),
	/** Round 11: keys whose current `preparing` phase is a RESUME of a paused/archived sandbox (the DTO says "resuming", not "preparing") → how it comes back. */
	resuming: new Map<string, "fast" | "archived" | "recreate">(),
	begin(key: string, now = Date.now()): void {
		this.preparing.set(key, now);
	},
	end(key: string): void {
		this.preparing.delete(key);
		this.resuming.delete(key);
	},
	fail(key: string, error: string, now = Date.now()): void {
		this.preparing.delete(key);
		this.resuming.delete(key);
		this.failures.set(key, { error: scrub(error).slice(0, 300), at: now });
	},
	ok(key: string): void {
		this.failures.delete(key);
	},
};
export const activityKey = (orgId: string, spaceId: string, workspaceKey: string, provider: string): string => `${orgId}|${spaceId}|${workspaceKey}|${provider}`;

export interface RemoteDriverDeps {
	readonly db: AppDb;
	readonly provider: RemoteProvider;
	readonly orgId: string;
	readonly lifecycle?: LifecyclePolicy;
	readonly template?: string;
	readonly image?: string;
	readonly resources?: ExplicitResources;
	/** Round 10: admin-configured working directory inside the sandbox; absent = the provider's default (workdir.ts). */
	readonly workDir?: string;
	readonly now?: () => number;
	/** Orphan sandboxes younger than this are left alone (a create may be in flight in another process). Default 2 min. */
	readonly orphanGraceMs?: number;
}

/** Stable per-installation id used to label remote sandboxes, so orphan reaping never touches another Workroom's sandboxes. */
export function installId(db: AppDb): string {
	const r = db.get<{ value: string }>("SELECT value FROM tool_sandbox_settings WHERE key = 'install_id'");
	if (r?.value) return r.value;
	const id = randomBytes(8).toString("hex");
	db.run("INSERT OR IGNORE INTO tool_sandbox_settings (key, value, updated_by, updated_at) VALUES ('install_id', ?, 'system', ?)", id, nowIso());
	return db.get<{ value: string }>("SELECT value FROM tool_sandbox_settings WHERE key = 'install_id'")!.value;
}

export class RemoteDriver implements SandboxDriver {
	readonly id: ProviderId;
	readonly label: string;
	readonly capabilities: DriverCapabilities;
	readonly notes: IsolationNotes;
	readonly provider: RemoteProvider;
	readonly orgId: string;
	readonly lifecycle: LifecyclePolicy;
	/** Round 10: the working directory inside the sandbox (cwd of every command; the host workspace is synced to/from it). */
	readonly workDir: string;
	/** Round 10: where read-only mounts (skills) are placed: next to the working directory ("/skills" while the working directory is "/work"). */
	readonly skillsRoot: string;
	readonly #db: AppDb;
	readonly #template: string | undefined;
	readonly #image: string | undefined;
	readonly #resources: ExplicitResources | undefined;
	readonly #now: () => number;
	readonly #orphanGraceMs: number;
	readonly #install: string;
	readonly #orgTag: string;
	readonly #locks = new Map<string, Promise<unknown>>();
	readonly #hashCache = new Map<string, { size: number; mtimeMs: number; sha: string }>();
	/** instance id → true while a run holds it (the idle reaper never destroys a busy instance). */
	readonly #busy = new Set<string>();

	constructor(d: RemoteDriverDeps) {
		this.provider = d.provider;
		this.id = d.provider.id;
		this.label = d.provider.label;
		this.orgId = d.orgId;
		this.#db = d.db;
		this.#template = d.template;
		this.#image = d.image;
		this.#resources = d.resources;
		this.#now = d.now ?? Date.now;
		this.#orphanGraceMs = d.orphanGraceMs ?? 120_000;
		this.lifecycle = d.lifecycle ?? DEFAULT_LIFECYCLE;
		this.workDir = resolveWorkDir(d.provider.id, d.workDir);
		this.skillsRoot = skillsRootFor(this.workDir);
		const c = d.provider.capabilities;
		this.capabilities = { network: c.networkOn !== "unsupported", services: false, mounts: c.skills === "upload_readonly", cgroupLimits: c.resourceLimits !== "unsupported", hostRuntimes: false };
		this.notes = remoteNotes(this.label, c, this.workDir);
		this.#install = installId(d.db);
		this.#orgTag = sha256(d.orgId).slice(0, 16);
	}

	// ---------- SandboxDriver: detect / services / stale ----------
	async detect(_force?: boolean): Promise<DriverStatus> {
		const checkedAt = new Date().toISOString();
		const h = await this.provider.health().catch((e) => ({ ok: false, detail: scrub(String(e?.message ?? e)), version: undefined as string | undefined }));
		return { id: this.id, state: h.ok ? "ready" : "unavailable", summary: h.ok ? `${this.label}：${h.detail}` : `${this.label} 不可用：${h.detail}`, details: [...(h.version ? [`version ${h.version}`] : []), `capabilities: ${JSON.stringify(this.provider.capabilities)}`], checkedAt };
	}
	async startService(_spec: DriverServiceSpec): Promise<DriverServiceProcess> {
		throw new UnsupportedError(this.label, "常驻服务（startService / MCP stdio）");
	}
	async killStale(_ref: ProcessRef): Promise<boolean> {
		return false; // remote runs have no local pid/container; leftovers are found by labels in reapStale()
	}

	// ---------- tiny utilities ----------
	#locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.#locks.get(key) ?? Promise.resolve();
		const next = prev.catch(() => {}).then(fn);
		this.#locks.set(key, next);
		const clear = () => this.#locks.get(key) === next && this.#locks.delete(key);
		next.then(clear, clear);
		return next;
	}
	#key(t: { orgId: string; spaceId: string; workspaceKey: string }) {
		return `${t.orgId}|${t.spaceId}|${t.workspaceKey}|${this.id}`;
	}
	/** Round 10: the path of a mount target (e.g. /skills/pdf) INSIDE this sandbox: unchanged for "/work", else next to the working directory. */
	mountTarget(target: string): string {
		return mapMountTarget(this.workDir, target);
	}

	/** Run a helper shell command remotely (privileged where the provider supports it). Throws with the remote stderr on failure. */
	async #sh(s: RemoteSession, command: string, o: { privileged?: boolean; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string> {
		const r = await s.exec({ command, cwd: "/", timeoutMs: o.timeoutMs ?? HELPER_TIMEOUT_MS, privileged: o.privileged ?? true, signal: o.signal });
		if (r.status !== "ok") throw new Error(`远端命令失败（${r.status}${r.exitCode === null ? "" : ` ${r.exitCode}`}）：${scrub(r.stderr || r.stdout).trim().slice(0, 300)}`);
		return r.stdout;
	}

	// ---------- instance table ----------
	#row(t: { orgId: string; spaceId: string; workspaceKey: string }): InstanceRow | undefined {
		return this.#db.get<InstanceRow>(`SELECT * FROM tool_sandbox_instances WHERE org_id = ? AND space_id = ? AND workspace_key = ? AND provider = ? AND state IN ${LIVE} ORDER BY created_at DESC LIMIT 1`, t.orgId, t.spaceId, t.workspaceKey, this.id);
	}
	#setState(id: string, state: SandboxInstanceDTO["state"], err?: string) {
		this.#db.run("UPDATE tool_sandbox_instances SET state = ?, state_at = ?, last_error = COALESCE(?, last_error) WHERE id = ?", state, new Date(this.#now()).toISOString(), err ? scrub(err) : null, id);
	}
	#tenantOf(r: InstanceRow): { orgId: string; spaceId: string; workspaceKey: string } {
		return { orgId: r.org_id, spaceId: r.space_id, workspaceKey: r.workspace_key };
	}
	#isoNow(): string {
		return new Date(this.#now()).toISOString();
	}
	/** Time this instance has been running since its last create/resume (ms), for cost accounting. */
	#runningMs(row: InstanceRow): number {
		return Math.max(0, this.#now() - Date.parse(row.running_since ?? row.created_at));
	}
	#event(t: { orgId: string; spaceId: string; workspaceKey: string }, kind: SandboxEventKind, trigger: SandboxEventTrigger, o: { durationMs?: number; runningMs?: number; detail?: string } = {}): void {
		recordSandboxEvent(this.#db, { orgId: t.orgId, spaceId: t.spaceId, workspaceKey: t.workspaceKey, provider: this.id, kind, trigger, at: this.#isoNow(), ...o, ...(o.detail ? { detail: scrub(o.detail) } : {}) });
	}
	/** Provider-side safety timeout while the sandbox is in use: idle-pause time + margin (+ the longest command that may run now). Extended on every use. */
	#ttlMs(runMs = 0): number {
		return (this.lifecycle.idlePauseSec + TTL_MARGIN_SEC) * 1000 + runMs;
	}
	get #canPause(): boolean {
		return this.provider.capabilities.pauseResume !== "unsupported" && typeof this.provider.pause === "function" && typeof this.provider.resume === "function";
	}

	async #destroyRow(row: InstanceRow, why: string, trigger: SandboxEventTrigger = "expiry"): Promise<void> {
		const running = row.state === "ready" || row.state === "pausing" || row.state === "resuming" ? this.#runningMs(row) : 0; // a paused sandbox is not running
		this.#setState(row.id, "stopping");
		try {
			if (row.remote_id) await this.provider.destroy(row.remote_id);
			this.#setState(row.id, "destroyed");
			this.#event(this.#tenantOf(row), "destroy", trigger, { runningMs: running, detail: why });
		} catch (e: any) {
			this.#setState(row.id, "error", `销毁失败（${why}）：${e?.message ?? e}`);
		}
	}

	/**
	 * Get the remote sandbox for this workspace: reuse (connect + verify), RESUME a paused/archived one, or create. Returns whether it is fresh (manifest reset).
	 * A failed resume never falls back to the host: the sandbox is recreated and the whole workspace is uploaded again (with a note).
	 */
	async #acquire(spec: DriverRunSpec, notes: string[]): Promise<{ row: InstanceRow; session: RemoteSession; fresh: boolean; moved?: string }> {
		const t = spec.tenant!;
		const trigger: SandboxTrigger = spec.trigger ?? "exec";
		let row = this.#row(t);
		// Round 9: instances created by older versions under the (removed) "no network" policy carry network=0, i.e. were created WITH a deny option.
		// They are recreated once, lazily, without it (the workspace is re-synced from the host copy), so the vendor's own network behaviour applies.
		if (row && row.network === 0) {
			notes.push("该远端沙箱创建于旧版本的“无网络”策略下：已重建（按提供方默认网络），并从宿主机工作区重新同步");
			await this.#destroyRow(row, "legacy network-deny instance", "expiry");
			row = undefined;
		}
		// Rows written before round 11 carry a hard expiry (the old max lifetime); it is honoured once, then the new lifecycle takes over (new rows have none).
		if (row && row.expires_at && Date.parse(row.expires_at) <= this.#now()) {
			notes.push("远端沙箱已达最长存活时间：重建并重新同步");
			await this.#destroyRow(row, "lifetime", "expiry");
			row = undefined;
		}
		let createDetail: string | undefined;
		if (row && row.resume_mode === "recreate" && (row.state === "paused" || row.state === "resuming")) {
			// The sandbox was destroyed when it went idle (provider cannot pause); the host workspace holds the files, dependencies must be reinstalled.
			remoteActivity.resuming.set(activityKey(t.orgId, t.spaceId, t.workspaceKey, this.id), "recreate");
			this.#setState(row.id, "destroyed");
			notes.push("远端沙箱因空闲已回收（提供方不支持暂停）：已重新创建，并从宿主机工作区重新同步（已安装的依赖需要重新安装）");
			createDetail = "after_pause_recreate";
			row = undefined;
		}
		if (row) {
			let session: RemoteSession | null = null;
			let resumedFrom: InstanceRow["state"] | undefined;
			if ((row.state === "paused" || row.state === "archived" || row.state === "resuming") && row.remote_id) {
				// ---- resume ----
				resumedFrom = row.state;
				remoteActivity.resuming.set(activityKey(t.orgId, t.spaceId, t.workspaceKey, this.id), resumedFrom === "archived" ? "archived" : "fast");
				const t0 = this.#now();
				this.#setState(row.id, "resuming");
				let failure: string | undefined;
				try {
					session = this.provider.resume ? await this.provider.resume(row.remote_id, spec.signal) : await this.provider.connect(row.remote_id, spec.signal);
					if (!session) failure = "沙箱已不存在（已过期或被删除）";
					else await this.#sh(session, "true", { privileged: false, timeoutMs: 20_000, signal: spec.signal });
				} catch (e: any) {
					if (spec.signal?.aborted) {
						this.#setState(row.id, resumedFrom); // cancelled: it is still paused (or running, which the next acquire tolerates)
						throw e;
					}
					session = null;
					failure = scrub(String(e?.message ?? e));
				}
				if (session) {
					this.#db.run("UPDATE tool_sandbox_instances SET state = 'ready', state_at = ?, running_since = ?, resume_mode = NULL WHERE id = ?", this.#isoNow(), this.#isoNow(), row.id);
					this.#event(t, "resume", trigger, { durationMs: this.#now() - t0, detail: resumedFrom === "archived" ? "from_archived" : undefined });
					row = { ...row, state: "ready", resume_mode: null };
				} else {
					this.#event(t, "resume_failed", trigger, { durationMs: this.#now() - t0, detail: failure });
					notes.push(`恢复已暂停的远端沙箱失败（${failure}）：已重新创建，并从宿主机工作区重新同步（已安装的依赖需要重新安装）`);
					createDetail = "after_resume_failed";
					this.#setState(row.id, "lost", `resume failed: ${failure}`);
					if (row.remote_id) await this.provider.destroy(row.remote_id).catch(() => {});
					row = undefined;
				}
			} else if ((row.state === "ready" || row.state === "pausing") && row.remote_id) {
				try {
					session = await this.provider.connect(row.remote_id, spec.signal);
				} catch (e: any) {
					throw new HttpError(503, "sandbox_provider_error", `无法连接到沙箱提供方 ${this.label}：${scrub(e?.message ?? e)}（不会回退到本机执行）`);
				}
				if (session) {
					try {
						await this.#sh(session, "true", { privileged: false, timeoutMs: 20_000, signal: spec.signal });
					} catch {
						session = null; // connected but not answering: treat as lost
					}
				}
				if (!session) {
					notes.push("远端沙箱已不存在（过期/被删除）：已重新创建，并从宿主机工作区重新同步");
					this.#setState(row.id, "lost", "remote sandbox missing");
					if (row.remote_id) await this.provider.destroy(row.remote_id).catch(() => {});
					row = undefined;
				} else if (row.state === "pausing") {
					this.#db.run("UPDATE tool_sandbox_instances SET state = 'ready', state_at = ? WHERE id = ?", this.#isoNow(), row.id);
					row = { ...row, state: "ready" };
				}
			} else {
				// a create that was interrupted (no live driver holds the lock) or a row without a remote id: it cannot be reused
				if (row.state === "creating") notes.push("远端沙箱已不存在（过期/被删除）：已重新创建，并从宿主机工作区重新同步");
				this.#setState(row.id, "lost", "no remote sandbox");
				if (row.remote_id) await this.provider.destroy(row.remote_id).catch(() => {});
				row = undefined;
			}
			if (row && session) {
				// keep the vendor-side timeout ahead of the idle-pause time (also the resume of E2B only gives a short default)
				await session.keepAlive(this.#ttlMs(spec.limits.timeoutMs)).catch(() => {}); // best effort (UnsupportedError or transient)
				// Round 10: the admin changed the working directory since this sandbox was last synced: the manifest describes the OLD directory,
				// so it is dropped and the whole workspace is uploaded into the new one (the old directory is left alone: it may hold anything).
				const was = row.work_dir ?? "/work";
				if (was !== this.workDir) {
					notes.push(`沙箱工作目录已从 ${was} 改为 ${this.workDir}：已把工作区完整同步到新目录（旧目录中的文件未删除）`);
					this.#db.run("UPDATE tool_sandbox_instances SET work_dir = ?, manifest = '{}' WHERE id = ?", this.workDir, row.id);
					return { row: { ...row, manifest: "{}", work_dir: this.workDir }, session, fresh: false, moved: was };
				}
				return { row, session, fresh: false };
			}
		}
		return { ...(await this.#create(spec, createDetail)), fresh: true };
	}

	async #create(spec: DriverRunSpec, detail?: string): Promise<{ row: InstanceRow; session: RemoteSession }> {
		const t = spec.tenant!;
		const trigger: SandboxTrigger = spec.trigger ?? "exec";
		const id = newId("sbi");
		const at = this.#isoNow();
		const t0 = this.#now();
		this.#db.run(
			"INSERT INTO tool_sandbox_instances (id, org_id, space_id, workspace_key, provider, remote_id, state, created_at, last_used_at, expires_at, manifest, network, work_dir, state_at, running_since) VALUES (?, ?, ?, ?, ?, NULL, 'creating', ?, ?, NULL, '{}', ?, ?, ?, ?)",
			id, t.orgId, t.spaceId, t.workspaceKey, this.id, at, at, 1, this.workDir, at, at,
		);
		let session: RemoteSession;
		try {
			session = await this.provider.create({
				...(this.#template ? { template: this.#template } : {}),
				...(this.#image ? { image: this.#image } : {}),
				// Only an admin's EXPLICIT resources are a request; the platform's generic memory limit is just a hint (OpenSandbox applies it,
				// E2B/Daytona ignore it). Passing the generic limit as `resources` made Daytona/E2B refuse every sandbox (round 10 fix).
				...(this.#resources ? { resources: this.#resources } : {}),
				defaultMemoryMb: Math.max(64, Math.floor(spec.limits.memoryBytes / MB)),
				metadata: { workroom: "1", workroom_install: this.#install, workroom_org: this.#orgTag, workroom_instance: id },
				lifetimeMs: this.#ttlMs(spec.limits.timeoutMs),
				lifecycle: { idlePauseSec: this.lifecycle.idlePauseSec, pausedRetentionSec: this.lifecycle.pausedRetentionSec, destroyAfterSec: this.lifecycle.destroyAfterSec },
				createTimeoutMs: this.lifecycle.createTimeoutSec * 1000,
				signal: spec.signal,
			});
		} catch (e: any) {
			this.#setState(id, "error", String(e?.message ?? e));
			this.#event(t, "create_failed", trigger, { durationMs: this.#now() - t0, detail: String(e?.message ?? e) });
			if (e instanceof UnsupportedError) throw e;
			if (e instanceof HttpError) throw e;
			throw new HttpError(503, "sandbox_provider_error", `沙箱提供方 ${this.label} 创建沙箱失败：${scrub(e?.message ?? e)}（不会回退到本机执行）`);
		}
		this.#db.run("UPDATE tool_sandbox_instances SET remote_id = ?, state = 'ready', state_at = ?, running_since = ? WHERE id = ?", session.id, this.#isoNow(), this.#isoNow(), id);
		this.#event(t, "create", trigger, { durationMs: this.#now() - t0, detail });
		return { row: this.#db.get<InstanceRow>("SELECT * FROM tool_sandbox_instances WHERE id = ?", id)!, session };
	}

	// ---------- hashing with a stat cache ----------
	#hostSha(workdir: string, f: TreeFile, maxBytes: number): string | null {
		const key = join(workdir, f.rel);
		const c = this.#hashCache.get(key);
		if (c && c.size === f.size && c.mtimeMs === f.mtimeMs) return c.sha;
		try {
			const sha = sha256(ws.readBytes(workdir, f.rel, maxBytes).bytes);
			if (this.#hashCache.size > 50_000) this.#hashCache.clear();
			this.#hashCache.set(key, { size: f.size, mtimeMs: f.mtimeMs, sha });
			return sha;
		} catch {
			return null;
		}
	}

	// ---------- mounts (skills): upload + verify + chmod a-w ----------
	async #ensureMounts(s: RemoteSession, mounts: readonly SandboxMount[], limits: DriverRunSpec["limits"], notes: string[], signal?: AbortSignal): Promise<void> {
		for (const m of mounts) {
			if (!m.readOnly) throw new UnsupportedError(this.label, `可写挂载 ${m.target}（远端沙箱只支持只读挂载与工作目录；已拒绝）`);
			const target = this.mountTarget(m.target); // round 10: re-rooted next to the working directory (unchanged for /work)
			if (isWithin(target, this.workDir) || isWithin(this.workDir, target)) throw bad("bad_mount", `挂载点 ${target} 与工作目录 ${this.workDir} 重叠：请管理员把工作目录改到别处（例如 …/work）`);
			const st = lstatSync(m.hostPath);
			if (!st.isDirectory()) throw new UnsupportedError(this.label, `单个文件挂载 ${m.target}（只支持目录）`);
			const tree = walk(m.hostPath, validWorkPath);
			for (const n of tree.notes) notes.push(`挂载 ${m.target}：${n}`);
			const files = tree.files.filter((f) => f.rel !== MOUNT_MARKER);
			const entries = files.map((f) => {
				const b = ws.readBytes(m.hostPath, f.rel, limits.maxFileBytes);
				return { rel: f.rel, bytes: b.bytes, sha: sha256(b.bytes), exec: f.exec };
			});
			const expected = treeHash(entries);
			const T = shQuote(target);
			const probe = `cd ${T} 2>/dev/null || exit 3; M=$(cat ${MOUNT_MARKER} 2>/dev/null); H=$(find . -type f ! -name ${MOUNT_MARKER} | LC_ALL=C sort | while IFS= read -r f; do sha256sum "$f"; done | sha256sum | cut -d' ' -f1); echo "$M $H"`;
			let current = "";
			try {
				current = (await this.#sh(s, probe, { signal })).trim();
			} catch {
				current = "";
			}
			if (current === `${expected} ${expected}`) continue; // marker and the actual remote content both match: nothing to upload
			// (Re)upload from scratch: a changed, partial or tampered directory is never patched in place.
			await this.#sh(s, `chmod -R u+w ${T} 2>/dev/null; rm -rf ${T}; mkdir -p ${T}`, { signal });
			const made = new Set<string>();
			for (const e of entries) {
				const dir = e.rel.includes("/") ? dirname(e.rel) : "";
				if (dir && !made.has(dir)) (made.add(dir), await s.mkdir(`${target}/${dir}`));
				await s.writeFile(`${target}/${e.rel}`, e.bytes);
			}
			const execs = entries.filter((e) => e.exec).map((e) => shQuote(`${target}/${e.rel}`));
			if (execs.length) await this.#sh(s, `chmod a+x ${execs.join(" ")}`, { signal });
			const got = (await this.#sh(s, `cd ${T} && find . -type f | LC_ALL=C sort | while IFS= read -r f; do sha256sum "$f"; done | sha256sum | cut -d' ' -f1`, { signal })).trim();
			if (got !== expected) {
				await this.#sh(s, `chmod -R u+w ${T}; rm -rf ${T}`, { signal }).catch(() => {});
				throw new HttpError(502, "sandbox_integrity", `挂载 ${target} 上传后哈希校验失败（期望 ${expected.slice(0, 12)}…，实际 ${got.slice(0, 12)}…）；已删除，运行被拒绝`);
			}
			await s.writeFile(`${target}/${MOUNT_MARKER}`, Buffer.from(expected));
			await this.#sh(s, `chmod -R a-w,a+rX ${T}`, { signal });
		}
	}

	/** Can the unprivileged workload user write into a mount? (Single-user providers can: reported, and the hash is re-verified every run.) */
	async #mountWritable(s: RemoteSession, mounts: readonly SandboxMount[], signal?: AbortSignal): Promise<boolean> {
		if (!mounts.length) return false;
		const r = await s.exec({ command: `test -w ${shQuote(this.mountTarget(mounts[0]!.target))} && echo writable || echo protected`, cwd: "/", timeoutMs: 20_000, signal }).catch(() => undefined);
		return r?.stdout.includes("writable") ?? false;
	}

	// ---------- working directory ----------
	/**
	 * Create the working directory and make sure the unprivileged workload user can write to it. A failure is a plain, visible error that tells the
	 * admin what to change (the Daytona user is not root: a root-level directory cannot be created). Never falls back to the host.
	 */
	async #ensureWorkDir(s: RemoteSession, signal?: AbortSignal): Promise<void> {
		const W = shQuote(this.workDir);
		try {
			await this.#sh(s, `mkdir -p ${W} && chmod a+rwx ${W}`, { signal });
		} catch (e) {
			if (signal?.aborted) throw e;
			throw await this.#workDirError(s, signal);
		}
		const r = await s.exec({ command: `test -d ${W} && test -w ${W} && test -x ${W}`, cwd: "/", timeoutMs: 20_000, privileged: false, signal });
		if (r.status !== "ok" || r.exitCode !== 0) throw await this.#workDirError(s, signal);
	}
	async #workDirError(s: RemoteSession, signal?: AbortSignal): Promise<HttpError> {
		let user = "未知";
		try {
			const r = await s.exec({ command: "id -un 2>/dev/null || whoami", cwd: "/", timeoutMs: 15_000, privileged: false, signal });
			const name = r.stdout.trim().split("\n")[0] ?? "";
			if (/^[A-Za-z0-9._@-]{1,64}$/.test(name)) user = name;
		} catch {
			/* keep "未知" */
		}
		return new HttpError(503, "sandbox_workdir_unwritable", `工作目录 ${this.workDir} 在沙箱内不可写（当前用户 ${user}）：请管理员在“沙箱提供方”中把工作目录改为该用户可写的路径`);
	}

	// ---------- workspace sync (round 11, R5: the working directory is ONE tree made of up to three host directories) ----------
	/**
	 * What one run syncs: the conversation workspace at the working directory and the persistent stores at <workdir>/memories and <workdir>/project.
	 * Each tree has its own host directory and its own slice of the manifest (keys `memories/…`, `project/…`, owner marker `@store:<name>`);
	 * the conversation tree never contains the two reserved top-level names, so a store is never written into a conversation directory and vice versa.
	 */
	#trees(spec: DriverRunSpec): SyncTree[] {
		return [{ prefix: "", hostDir: spec.workdir, readOnly: false }, ...(spec.stores ?? []).map((st): SyncTree => ({ prefix: st.name, hostDir: st.hostPath, readOnly: st.readOnly, store: st }))];
	}

	// ---------- workspace sync: host → remote ----------
	async #pushWork(s: RemoteSession, spec: DriverRunSpec, manifest: Manifest, notes: string[], persist: (m: Manifest) => void): Promise<void> {
		const W = this.workDir;
		await this.#ensureWorkDir(s, spec.signal); // remote root + permissions (the workload user is unprivileged; files are uploaded by the provider's file API)
		const trees = this.#trees(spec);
		// A store this run may not use (access revoked, conversation left the project, another member) must not stay in the sandbox.
		for (const name of STORE_NAMES) {
			if (trees.some((t) => t.prefix === name)) continue;
			if (!Object.keys(manifest).some((k) => k === `${STORE_MARK}${name}` || k.startsWith(`${name}/`))) continue;
			const R = shQuote(`${W}/${name}`);
			await this.#sh(s, `chmod -R u+w ${R}; rm -rf ${R}`, { signal: spec.signal });
			for (const k of Object.keys(manifest)) if (k === `${STORE_MARK}${name}` || k.startsWith(`${name}/`)) delete manifest[k];
			persist(manifest);
		}
		let anyChanged = false;
		for (const tree of trees) {
			const view = viewOf(manifest, tree.prefix);
			const remoteDir = tree.prefix ? `${W}/${tree.prefix}` : W;
			if (tree.store) {
				const R = shQuote(remoteDir);
				const mark = `${STORE_MARK}${tree.prefix}`;
				if (manifest[mark] !== tree.store.ownerKey) {
					// First use in this sandbox, or somebody else (or another access level) used it before: start from a clean folder.
					await this.#sh(s, `chmod -R u+w ${R} 2>/dev/null; rm -rf ${R}; mkdir -p ${R}`, { signal: spec.signal });
					for (const k of Object.keys(view)) delete view[k];
					manifest[mark] = tree.store.ownerKey;
					anyChanged = true;
				}
				await this.#sh(s, `mkdir -p ${R} && chmod a+rwx ${R}`, { signal: spec.signal });
				if (tree.readOnly) await this.#sh(s, `chmod -R u+w ${R} 2>/dev/null; true`, { signal: spec.signal });
			}
			try {
				if (await this.#pushTree(s, spec, tree, remoteDir, view, notes)) anyChanged = true;
			} finally {
				mergeView(manifest, tree.prefix, view); // also on failure: what did go up is recorded
				persist(manifest);
			}
		}
		if (anyChanged) await this.#sh(s, `chmod -R a+rwX ${shQuote(W)}`, { signal: spec.signal });
		for (const tree of trees) if (tree.store && tree.readOnly) await this.#sh(s, `chmod -R a-w,a+rX ${shQuote(`${W}/${tree.prefix}`)}`, { signal: spec.signal });
	}

	/** Upload one tree's host changes into `remoteDir` (manifest `view` is mutated). Returns whether anything changed remotely. */
	async #pushTree(s: RemoteSession, spec: DriverRunSpec, tree: SyncTree, remoteDir: string, manifest: Manifest, notes: string[]): Promise<boolean> {
		const wd = tree.hostDir;
		const W = remoteDir;
		const maxFile = spec.limits.maxFileBytes;
		const show = (p: string) => (tree.prefix ? `${tree.prefix}/${p}` : p);
		const walked = walk(wd, validWorkPath, MAX_SYNC_ENTRIES, tree.prefix === "" ? { skipTop: isStoreTop } : {});
		for (const n of walked.notes) notes.push(tree.prefix ? `${tree.prefix}/：${n}` : n);
		const hostFiles = new Map<string, { f: TreeFile; sha: string }>();
		for (const f of walked.files) {
			if (f.size > maxFile) {
				notes.push(`文件超过单文件上限（${Math.round(maxFile / MB)} MB），未上传：${show(f.rel)}`);
				continue;
			}
			const sha = this.#hostSha(wd, f, maxFile);
			if (sha) hostFiles.set(f.rel, { f, sha });
		}
		const hostDirs = new Set(walked.dirs);
		// deletions: things the host no longer has (files, then directories deepest-first)
		const delFiles: string[] = [];
		const delDirs: string[] = [];
		for (const k of Object.keys(manifest)) {
			if (k.endsWith("/")) {
				if (!hostDirs.has(k.slice(0, -1))) delDirs.push(k.slice(0, -1));
			} else if (!hostFiles.has(k)) delFiles.push(k);
		}
		const dels = [...delFiles, ...delDirs.sort((a, b) => b.length - a.length)];
		for (let i = 0; i < dels.length; i += 100) {
			const chunk = dels.slice(i, i + 100).map((p) => shQuote(`${W}/${p}`));
			await this.#sh(s, `rm -rf -- ${chunk.join(" ")}`, { signal: spec.signal });
		}
		for (const p of delFiles) delete manifest[p];
		for (const d of delDirs) delete manifest[`${d}/`];
		// directories
		let changed = dels.length > 0;
		const mk = new Set<string>();
		for (const d of hostDirs) if (manifest[`${d}/`] === undefined) mk.add(d);
		const toUpload = [...hostFiles.entries()].filter(([p, h]) => manifest[p] !== h.sha);
		for (const [p] of toUpload) {
			let d = dirname(p);
			while (d && d !== ".") (mk.add(d), (d = dirname(d)));
		}
		for (const d of [...mk].sort((a, b) => a.length - b.length)) {
			await s.mkdir(`${W}/${d}`);
			manifest[`${d}/`] = "dir";
			changed = true;
		}
		// files (small concurrency; manifest records only what really went up, with the bytes' own hash)
		let next = 0;
		let failure: unknown;
		const worker = async () => {
			while (next < toUpload.length && !failure) {
				const [p, h] = toUpload[next++]!;
				try {
					const b = ws.readBytes(wd, p, maxFile);
					const sha = sha256(b.bytes);
					await s.writeFile(`${W}/${p}`, b.bytes);
					manifest[p] = sha;
					changed = true;
					void h;
				} catch (e) {
					failure = e;
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(4, toUpload.length) }, worker));
		if (failure) throw failure;
		return changed;
	}

	// ---------- workspace sync: remote → host ----------
	async #pullWork(s: RemoteSession, spec: DriverRunSpec, manifest: Manifest, runId: string, notes: string[]): Promise<void> {
		const W = this.workDir;
		let entries;
		try {
			entries = await s.list(W);
		} catch (e: any) {
			notes.push(`无法列出远端工作目录 ${W}，文件未同步回宿主机：${scrub(e?.message ?? e)}`);
			return;
		}
		if (entries.length > MAX_SYNC_ENTRIES) {
			notes.push(`远端工作目录 ${W} 的文件数超过 ${MAX_SYNC_ENTRIES}，未同步回宿主机（请清理后重试）`);
			return;
		}
		const trees = this.#trees(spec);
		const parts = new Map<string, RemoteSlice>(trees.map((t) => [t.prefix, { files: new Map(), dirs: new Set(), opaque: new Set() }]));
		const orphanTops = new Set<string>(); // memories/ or project/ exists remotely but this run has no such store
		for (const e of entries) {
			const p = normalizeRemotePath(e.path);
			if (!p) {
				notes.push(`远端文件名不合法，未同步：${JSON.stringify(String(e.path)).slice(0, 120)}`);
				continue;
			}
			const top = p.split("/")[0]!;
			let prefix = "";
			let rel = p;
			if (isStoreTop(top)) {
				if (!parts.has(top)) {
					orphanTops.add(top);
					continue;
				}
				prefix = top;
				rel = p.slice(top.length + 1);
				if (!rel) continue; // the store folder itself
			}
			const slice = parts.get(prefix)!;
			const shown = prefix ? `${prefix}/${rel}` : rel;
			if (e.kind === "file") slice.files.set(rel, e.size);
			else if (e.kind === "directory") slice.dirs.add(rel);
			else {
				slice.opaque.add(rel);
				notes.push(`${e.kind === "symlink" ? "符号链接" : "特殊文件"}未同步到宿主机：${shown}`);
			}
		}
		for (const name of orphanTops) notes.push(`沙箱里的 ${name}/ 在这次运行中没有对应的持久目录（没有权限或会话不属于项目），其中的文件没有保存`);
		// remote hashes in one command (all trees); the result goes through a file so no output cap can truncate it
		const hashes = new Map<string, string>();
		const hf = `/tmp/.wr-h-${runId.replace(/[^A-Za-z0-9_-]/g, "")}`;
		try {
			await this.#sh(s, `cd ${shQuote(W)} && find . -type f -exec sha256sum {} + > ${shQuote(hf)} 2>/dev/null; true`, { signal: undefined });
			const raw = Buffer.from(await s.readFile(hf, 64 * MB)).toString("utf8");
			for (const line of raw.split("\n")) {
				const m = /^([0-9a-f]{64}) {2}\.\/(.+)$/.exec(line);
				if (m) hashes.set(m[2]!, m[1]!);
			}
		} catch (e: any) {
			notes.push(`远端哈希计算失败，改为逐个下载比对：${scrub(e?.message ?? e)}`);
		}
		await this.#sh(s, `rm -f ${shQuote(hf)}`).catch(() => {});

		for (const tree of trees) {
			const view = viewOf(manifest, tree.prefix);
			try {
				if (tree.store?.readOnly) this.#noteReadOnlyChanges(tree, parts.get(tree.prefix)!, view, hashes, notes);
				else await this.#pullTree(s, spec, tree, W, parts.get(tree.prefix)!, hashes, view, notes);
			} finally {
				mergeView(manifest, tree.prefix, view);
			}
		}
	}

	/** A read-only store is never synced back: say so when the run changed it. */
	#noteReadOnlyChanges(tree: SyncTree, slice: RemoteSlice, view: Manifest, hashes: Map<string, string>, notes: string[]): void {
		let n = 0;
		for (const [p] of slice.files) {
			const h = hashes.get(`${tree.prefix}/${p}`);
			if (h === undefined || view[p] !== h) n++;
		}
		for (const k of Object.keys(view)) if (!k.endsWith("/") && !slice.files.has(k)) n++;
		if (n) notes.push(`${storeLabel(tree.prefix as StoreName)}对你是只读的：沙箱里对它的 ${n} 处修改没有保存`);
	}

	/** Download one tree's remote changes into its host directory (conversation workspace, or a persistent store — never the other one). */
	async #pullTree(s: RemoteSession, spec: DriverRunSpec, tree: SyncTree, W: string, slice: RemoteSlice, hashes: Map<string, string>, manifest: Manifest, notes: string[]): Promise<void> {
		const wd = tree.hostDir;
		const maxFile = spec.limits.maxFileBytes;
		const isStore = !!tree.store;
		const show = (p: string) => (tree.prefix ? `${tree.prefix}/${p}` : p);
		const remote = (p: string) => (tree.prefix ? `${W}/${tree.prefix}/${p}` : `${W}/${p}`);
		const { files, dirs, opaque } = slice;
		let budget = isStore ? tree.store!.quotaBytes - ws.dirSize(wd).bytes : quotaBytes() - ws.dirSize(spec.scratchBase).bytes;
		for (const [p, size] of files) {
			const claimed = hashes.get(tree.prefix ? `${tree.prefix}/${p}` : p);
			if (claimed !== undefined && manifest[p] === claimed) continue; // unchanged since the last sync
			if (size > maxFile) {
				notes.push(`远端文件超过单文件上限（${Math.round(maxFile / MB)} MB），未同步：${show(p)}`);
				continue;
			}
			if (size > budget) {
				notes.push(isStore ? `${storeLabel(tree.prefix as StoreName)}已满（上限 ${fmtSize(tree.store!.quotaBytes)}），未保存：${show(p)}` : `工作区配额不足，未同步：${p}`);
				continue;
			}
			let bytes: Uint8Array;
			try {
				bytes = await s.readFile(remote(p), maxFile);
			} catch (e: any) {
				notes.push(`下载失败，未同步 ${show(p)}：${scrub(e?.message ?? e)}`);
				continue;
			}
			const sha = sha256(bytes);
			if (claimed !== undefined && claimed !== sha) {
				notes.push(`文件在同步期间被修改，本次未同步：${show(p)}`);
				continue;
			}
			if (manifest[p] === sha) continue;
			// The host copy changed since this sandbox last synced it (the same file edited somewhere else while the run was going).
			const hostNow = this.#hostNow(wd, p, maxFile);
			if (hostNow === "blocked") {
				notes.push(`宿主机上该路径不是普通文件，未覆盖：${show(p)}`);
				continue;
			}
			const hostChanged = (hostNow !== null && manifest[p] !== undefined && hostNow !== manifest[p]) || (hostNow !== null && manifest[p] === undefined && hostNow !== sha);
			if (hostChanged) {
				if (!isStore) {
					// conversation workspace: the host version wins (it uploads again next run) and the run says so
					notes.push(manifest[p] !== undefined ? `宿主机上同时修改了 ${p}，保留宿主机版本` : `宿主机上已有不同内容的 ${p}（运行期间新增），保留宿主机版本`);
					continue;
				}
				// persistent store (shared by other conversations): never drop either side — the sandbox's version is kept next to the file
				const copy = this.#conflictCopy(wd, p, bytes);
				if (copy) {
					budget -= size;
					notes.push(`${show(p)} 在别处（另一个会话）也被修改过：这次沙箱里的版本另存为 ${show(copy)}，原文件保留的是另一处的版本；请对比后自行合并`);
				} else notes.push(`${show(p)} 在别处也被修改过，且无法另存沙箱里的版本（写入失败）：沙箱里的修改没有保存`);
				continue;
			}
			try {
				this.#writeHost(wd, p, bytes);
			} catch (e: any) {
				notes.push(`写入宿主机失败 ${show(p)}：${scrub(e?.message ?? e)}`);
				continue;
			}
			manifest[p] = sha;
			budget -= size;
		}
		// deletions made remotely (only files we synced before, only when the host copy is still the synced version)
		for (const k of Object.keys(manifest)) {
			if (k.endsWith("/") || files.has(k) || opaque.has(k)) continue;
			const hostNow = this.#hostNow(wd, k, maxFile);
			if (hostNow === manifest[k]) {
				try {
					ws.remove(wd, k);
				} catch {
					/* already gone */
				}
				delete manifest[k];
			} else if (hostNow === null) delete manifest[k];
			else notes.push(`远端已删除 ${show(k)}，但宿主机上已修改，保留宿主机版本`);
		}
		// directories
		for (const d of dirs) {
			if (manifest[`${d}/`] !== undefined) continue;
			try {
				ws.mkdirp(wd, d);
				manifest[`${d}/`] = "dir";
			} catch (e: any) {
				notes.push(`创建目录失败 ${show(d)}：${scrub(e?.message ?? e)}`);
			}
		}
		for (const k of Object.keys(manifest).filter((x) => x.endsWith("/")).sort((a, b) => b.length - a.length)) {
			const d = k.slice(0, -1);
			if (dirs.has(d) || opaque.has(d)) continue;
			try {
				rmdirSync(join(wd, d)); // only when empty
			} catch {
				/* not empty (host files) or gone */
			}
			if (!existsSync(join(wd, d))) delete manifest[k];
		}
	}

	/** Write `bytes` next to `rel` as "<name>.conflict-<time>-<n><ext>" (never overwrites). Returns the new relative path, or null when it could not be written. */
	#conflictCopy(wd: string, rel: string, bytes: Uint8Array): string | null {
		const dir = dirname(rel) === "." ? "" : dirname(rel);
		const base = rel.slice(dir ? dir.length + 1 : 0);
		const dot = base.lastIndexOf(".");
		const stem = dot > 0 ? base.slice(0, dot) : base;
		const ext = dot > 0 ? base.slice(dot) : "";
		const stamp = new Date(this.#now()).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
		for (let i = 1; i < 100; i++) {
			const name = `${stem}.conflict-${stamp}${i > 1 ? `-${i}` : ""}${ext}`;
			const copy = dir ? `${dir}/${name}` : name;
			if (!validWorkPath(copy) || this.#hostNow(wd, copy, 1) !== null) continue;
			try {
				this.#writeHost(wd, copy, bytes);
				return copy;
			} catch {
				return null;
			}
		}
		return null;
	}

	/** sha of the host file now: string | null (absent) | "blocked" (a directory/symlink/special where a file would go). */
	#hostNow(wd: string, rel: string, max: number): string | null | "blocked" {
		let abs: string;
		try {
			abs = ws.resolveIn(wd, rel).abs;
		} catch {
			return "blocked";
		}
		let st;
		try {
			st = lstatSync(abs);
		} catch {
			return null;
		}
		if (!st.isFile()) return "blocked";
		try {
			return sha256(ws.readBytes(wd, rel, Math.max(max, st.size)).bytes);
		} catch {
			return "blocked";
		}
	}
	#writeHost(wd: string, rel: string, bytes: Uint8Array): void {
		const { abs, rel: clean } = ws.resolveIn(wd, rel);
		const parent = dirname(clean);
		ws.mkdirp(wd, parent === "." ? "" : parent);
		const tmp = join(dirname(abs), `.wr-tmp-${randomBytes(6).toString("hex")}`);
		try {
			writeFileSync(tmp, bytes, { flag: "wx", mode: 0o644 });
			renameSync(tmp, abs); // atomic replace; a symlink at `abs` is replaced, never followed
		} catch (e) {
			rmSync(tmp, { force: true });
			throw e;
		}
	}

	// ---------- run ----------
	/** Checks shared by run() and prepare(): tenant, env, mounts. Throws before anything is created. (No network refusal any more: round 9.) */
	#preflight(spec: DriverRunSpec): NonNullable<DriverRunSpec["tenant"]> {
		const t = spec.tenant;
		if (!t) throw new HttpError(500, "internal", "远端沙箱需要租户信息（org/space/workspaceKey）");
		if (t.orgId !== this.orgId) throw new HttpError(500, "internal", "沙箱驱动与组织不匹配");
		try {
			checkEnv(spec.env);
		} catch (e: any) {
			throw bad("bad_env", e.message);
		}
		for (const m of spec.mounts) if (!m.readOnly) throw new UnsupportedError(this.label, `可写挂载 ${m.target}（远端沙箱只支持只读挂载与工作目录；已拒绝）`);
		return t;
	}

	async run(spec: DriverRunSpec): Promise<RunResult> {
		const t = this.#preflight(spec);
		const started = Date.now();
		if (spec.signal?.aborted) return { status: "killed", exitCode: null, stdout: "", stderr: "[sandbox] 运行在开始前已被取消", durationMs: 0 };
		return this.#locked(this.#key(t), () => this.#run(spec, started)).catch((e) => {
			// cancelled while the sandbox was being created/connected: that is a cancelled run, not a provider failure
			if (spec.signal?.aborted && !(e instanceof UnsupportedError)) return { status: "killed" as const, exitCode: null, stdout: "", stderr: "[sandbox] 运行已被取消（沙箱创建/连接期间）", durationMs: Date.now() - started };
			throw e;
		});
	}

	/**
	 * Round 8: everything a run does BEFORE the program starts (create or reconnect the sandbox, sync the working directory, verify mounts), without running a program.
	 * Same code path and lock as run(); used only for an explicit "retry / prepare" request, never by sending a message.
	 */
	async prepare(spec: DriverRunSpec): Promise<void> {
		const t = this.#preflight(spec);
		await this.#locked(this.#key(t), () => this.#run(spec, Date.now(), true));
	}

	async #run(spec: DriverRunSpec, started: number, prepareOnly = false): Promise<RunResult> {
		const notes: string[] = [];
		const act = activityKey(spec.tenant!.orgId, spec.tenant!.spaceId, spec.tenant!.workspaceKey, this.id);
		remoteActivity.begin(act, this.#now());
		let acquired: { row: InstanceRow; session: RemoteSession; fresh: boolean };
		try {
			acquired = await this.#acquire(spec, notes);
		} catch (e: any) {
			if (spec.signal?.aborted) remoteActivity.end(act);
			else remoteActivity.fail(act, String(e?.message ?? e), this.#now());
			throw e;
		}
		const { row, session, fresh } = acquired;
		this.#busy.add(row.id);
		const manifest: Manifest = fresh ? {} : parseManifest(row.manifest);
		const persist = (m: Manifest) => this.#db.run("UPDATE tool_sandbox_instances SET manifest = ? WHERE id = ?", JSON.stringify(m), row.id);
		if (fresh) persist(manifest);
		const codeDir = `/tmp/.wr-${spec.runId.replace(/[^A-Za-z0-9_-]/g, "")}`;
		try {
			await this.#pushWork(session, spec, manifest, notes, persist);
			await this.#ensureMounts(session, spec.mounts, spec.limits, notes, spec.signal);
			remoteActivity.ok(act);
			remoteActivity.end(act); // sandbox is ready; from here on the program runs (not "preparing")
			if (prepareOnly) return { status: "ok", exitCode: 0, stdout: "", stderr: "", durationMs: Date.now() - started };
			if (await this.#mountWritable(session, spec.mounts, spec.signal)) notes.push(`提示：提供方 ${this.label} 的沙箱用户对技能目录有写权限（单用户沙箱）；每次运行前会校验其哈希，被篡改则重新上传`);

			// the program
			let argv: string;
			const memMb = Math.floor(spec.limits.memoryBytes / 2 / MB);
			if ("language" in spec.exec) {
				const { language, code } = spec.exec;
				const file = `${codeDir}/${language === "python" ? "main.py" : language === "node" ? "main.mjs" : "main.sh"}`;
				await this.#sh(session, `mkdir -p ${shQuote(codeDir)} && chmod 755 ${shQuote(codeDir)}`, { signal: spec.signal });
				await session.writeFile(file, Buffer.from(code, "utf8"));
				await this.#sh(session, `chmod 644 ${shQuote(file)}`, { signal: spec.signal });
				argv = language === "python" ? `python3 ${shQuote(file)}` : language === "node" ? `node --max-old-space-size=${memMb} ${shQuote(file)}` : `/bin/sh ${shQuote(file)}`;
			} else argv = spec.exec.argv.map(shQuote).join(" ");

			// exec: provider-side timeout + our own deadline, cancel = AbortSignal (the provider must really stop the process)
			const out = capped();
			const err = capped();
			let timedOut = false;
			let cancelled = false;
			const ac = new AbortController();
			const onAbort = () => ((cancelled = true), ac.abort());
			if (spec.signal?.aborted) onAbort();
			spec.signal?.addEventListener("abort", onAbort, { once: true });
			const timer = setTimeout(() => ((timedOut = true), ac.abort()), spec.limits.timeoutMs + 5000);
			let res;
			try {
				res = await session.exec({ command: argv, cwd: this.workDir, env: { HOME: "/tmp", TMPDIR: "/tmp", ...spec.env, WORKROOM_WORKDIR: this.workDir }, timeoutMs: spec.limits.timeoutMs, signal: ac.signal });
			} finally {
				clearTimeout(timer);
				spec.signal?.removeEventListener("abort", onAbort);
			}
			out.push(Buffer.from(res.stdout));
			err.push(Buffer.from(res.stderr));
			let status = res.status;
			if (timedOut) status = "timeout";
			else if (cancelled) status = "killed";

			// bring the results home even after a timeout/cancel (partial output files are the user's data)
			await this.#sh(session, `rm -rf ${shQuote(codeDir)}`).catch(() => {});
			await this.#pullWork(session, spec, manifest, spec.runId, notes);
			persist(manifest);

			let stderr = err.text();
			if (status === "timeout") stderr += `\n[sandbox] 超过时间限制 ${spec.limits.timeoutMs} ms，已请求远端终止`;
			else if (status === "killed" && cancelled) stderr += "\n[sandbox] 运行已被取消，已请求远端终止";
			if (notes.length) stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}${notes.map((n) => `[sandbox] ${n}`).join("\n")}`;
			return { status, exitCode: res.exitCode, stdout: out.text(), stderr, durationMs: Date.now() - started };
		} catch (e: any) {
			if (remoteActivity.preparing.has(act)) remoteActivity.fail(act, String(e?.message ?? e), this.#now()); // failed while syncing, before the program started
			throw e;
		} finally {
			this.#busy.delete(row.id);
			this.#db.run("UPDATE tool_sandbox_instances SET last_used_at = ? WHERE id = ?", new Date(this.#now()).toISOString(), row.id);
		}
	}

	// ---------- lifecycle: pause / archive / destroy (round 11), orphan reaping ----------
	#reaping = false;
	/**
	 * One reaper pass (RemoteDrivers runs it every 60 s; tests inject `now`). Per instance, under the same per-workspace lock a run holds:
	 *   ready    idle ≥ idlePauseSec → pause (provider pause, or "recreate": destroy the sandbox — the host workspace keeps the files)
	 *   paused   paused ≥ pausedRetentionSec → archive (providers that can), else stays paused
	 *   any      unused ≥ destroyAfterSec → destroy
	 * A busy instance is never touched; the decision is re-made inside the lock, so a run that arrived (or finished) while this pass was queued wins.
	 * Returns how many instances changed state. Overlapping passes in one process are skipped.
	 */
	async reapIdle(now = this.#now()): Promise<number> {
		if (this.#reaping) return 0;
		this.#reaping = true;
		try {
			const rows = this.#db.all<InstanceRow>(`SELECT * FROM tool_sandbox_instances WHERE org_id = ? AND provider = ? AND state IN ${LIVE}`, this.orgId, this.id);
			let n = 0;
			for (const r of rows) {
				if (this.#busy.has(r.id)) continue;
				const done = await this.#locked(`${r.org_id}|${r.space_id}|${r.workspace_key}|${this.id}`, () => this.#reapOne(r.id, now)).catch((e) => {
					console.error(`[sandbox] ${this.id}: lifecycle pass failed for ${r.id}:`, scrub(String(e?.message ?? e)));
					return false;
				});
				if (done) n++;
			}
			// purge old bookkeeping rows
			this.#db.run("DELETE FROM tool_sandbox_instances WHERE state IN ('destroyed','lost','error') AND COALESCE(state_at, last_used_at) < ?", new Date(this.#now() - 7 * 86400_000).toISOString()); // terminal rows are kept a week (by the driver clock, the same one that stamped them)
			return n;
		} finally {
			this.#reaping = false;
		}
	}

	async #reapOne(id: string, now: number): Promise<boolean> {
		const row = this.#db.get<InstanceRow>(`SELECT * FROM tool_sandbox_instances WHERE id = ? AND state IN ${LIVE}`, id);
		if (!row || this.#busy.has(id)) return false;
		const lc = this.lifecycle;
		const unusedMs = now - Date.parse(row.last_used_at);
		const inStateMs = now - Date.parse(row.state_at ?? row.last_used_at);
		const stuckMs = (lc.createTimeoutSec + 60) * 1000;
		const t = this.#tenantOf(row);
		switch (row.state) {
			case "creating":
			case "stopping":
				if (inStateMs <= stuckMs) return false;
				await this.#destroyRow(row, "stuck", "expiry");
				return true;
			case "pausing": // a pause that never finished (crash): the sandbox is probably still usable; the next pass decides again
				if (inStateMs <= stuckMs) return false;
				this.#setState(row.id, "ready");
				return true;
			case "resuming": // a resume that never finished: it is paused as far as we know; the next run retries
				if (inStateMs <= stuckMs) return false;
				this.#setState(row.id, "paused");
				return true;
			case "ready": {
				const legacyExpired = !!row.expires_at && Date.parse(row.expires_at) <= now;
				if (legacyExpired || unusedMs >= lc.destroyAfterSec * 1000) {
					await this.#destroyRow(row, legacyExpired ? "lifetime" : "unused", "expiry");
					return true;
				}
				if (unusedMs < lc.idlePauseSec * 1000) return false;
				return this.#pauseRow(row, "idle");
			}
			case "paused":
			case "archived":
				if (unusedMs >= lc.destroyAfterSec * 1000) {
					await this.#destroyRow(row, "unused", "expiry");
					return true;
				}
				if (row.state === "paused" && row.resume_mode !== "recreate" && row.remote_id && typeof this.provider.archive === "function" && inStateMs >= lc.pausedRetentionSec * 1000) {
					try {
						await this.provider.archive(row.remote_id);
						this.#setState(row.id, "archived");
						this.#event(t, "archive", "retention");
						return true;
					} catch (e: any) {
						this.#db.run("UPDATE tool_sandbox_instances SET last_error = ? WHERE id = ?", scrub(`归档失败：${e?.message ?? e}`), row.id); // stays paused (resumable); retried next pass
						return false;
					}
				}
				return false;
			default:
				return false;
		}
	}

	/** Pause one idle instance (lock held, not busy). Provider pause when it can; otherwise "recreate" mode: destroy it and remember to rebuild from the host workspace. */
	async #pauseRow(row: InstanceRow, trigger: SandboxEventTrigger): Promise<boolean> {
		const t = this.#tenantOf(row);
		const runningMs = this.#runningMs(row);
		const act = activityKey(row.org_id, row.space_id, row.workspace_key, this.id);
		this.#setState(row.id, "pausing");
		if (this.#canPause && row.remote_id) {
			try {
				await this.provider.pause!(row.remote_id, { retainMs: (this.lifecycle.pausedRetentionSec + TTL_MARGIN_SEC) * 1000 });
			} catch (e: any) {
				// still running as far as we know: back to ready, visible in the admin list, retried on the next pass
				this.#db.run("UPDATE tool_sandbox_instances SET state = 'ready', state_at = ?, last_error = ? WHERE id = ?", this.#isoNow(), scrub(`暂停失败：${e?.message ?? e}`), row.id);
				return false;
			}
			this.#db.run("UPDATE tool_sandbox_instances SET state = 'paused', state_at = ?, resume_mode = 'provider' WHERE id = ?", this.#isoNow(), row.id);
			this.#event(t, "pause", trigger, { runningMs });
		} else {
			try {
				if (row.remote_id) await this.provider.destroy(row.remote_id);
			} catch (e: any) {
				this.#setState(row.id, "error", `销毁失败（idle）：${e?.message ?? e}`);
				return false;
			}
			this.#db.run("UPDATE tool_sandbox_instances SET state = 'paused', state_at = ?, resume_mode = 'recreate', remote_id = NULL WHERE id = ?", this.#isoNow(), row.id);
			this.#event(t, "pause", trigger, { runningMs, detail: "recreate" });
		}
		remoteActivity.ok(act); // an old failure marker would otherwise keep the conversation "failed" while it is merely idle
		return true;
	}

	/** Startup: idle/expired instances, then orphans (our labels, not in the table). */
	async reapStale(): Promise<number> {
		let n = await this.reapIdle();
		let listed;
		try {
			listed = await this.provider.list({ workroom: "1", workroom_install: this.#install, workroom_org: this.#orgTag });
		} catch (e) {
			if (e instanceof UnsupportedError) return n;
			console.error(`[sandbox] ${this.id}: orphan listing failed`, scrub(String((e as Error)?.message ?? e)));
			return n;
		}
		const live = this.#db.all<{ id: string; remote_id: string | null; state: string }>(`SELECT id, remote_id, state FROM tool_sandbox_instances WHERE provider = ? AND state IN ${LIVE}`, this.id);
		const byRemote = new Set(live.map((r) => r.remote_id).filter(Boolean));
		const creating = new Set(live.filter((r) => r.state === "creating").map((r) => r.id));
		for (const s of listed) {
			if (byRemote.has(s.id)) continue;
			if (s.metadata.workroom_instance && creating.has(s.metadata.workroom_instance)) continue; // being created right now
			if (s.createdAt && this.#now() - Date.parse(s.createdAt) < this.#orphanGraceMs) continue; // grace for races
			try {
				await this.provider.destroy(s.id);
				n++;
			} catch (e) {
				console.error(`[sandbox] ${this.id}: could not destroy orphan ${s.id}`, scrub(String((e as Error)?.message ?? e)));
			}
		}
		return n;
	}

	/** Admin: destroy one tracked instance now. */
	async destroyInstance(id: string): Promise<boolean> {
		const r = this.#db.get<InstanceRow>("SELECT * FROM tool_sandbox_instances WHERE id = ? AND org_id = ? AND provider = ?", id, this.orgId, this.id);
		if (!r || !["ready", "creating", "stopping", "error", "pausing", "paused", "resuming", "archived"].includes(r.state)) return false;
		await this.#locked(`${r.org_id}|${r.space_id}|${r.workspace_key}|${this.id}`, () => this.#destroyRow(r, "admin", "admin"));
		return true;
	}

	close(): Promise<void> {
		return (this.provider as { close?: () => Promise<void> }).close?.().catch(() => {}) ?? Promise.resolve();
	}
}

export function instancesFor(db: AppDb, orgId: string, limit = 200): SandboxInstanceDTO[] {
	return db
		.all<InstanceRow>("SELECT * FROM tool_sandbox_instances WHERE org_id = ? ORDER BY last_used_at DESC LIMIT ?", orgId, limit)
		.map((r) => ({ id: r.id, provider: r.provider as ProviderId, spaceId: r.space_id, workspaceKey: r.workspace_key, remoteId: r.remote_id, state: r.state, ...(r.state === "paused" || r.state === "archived" ? { resumeMode: r.resume_mode ?? "provider" } : {}), createdAt: r.created_at, lastUsedAt: r.last_used_at, ...(r.expires_at ? { expiresAt: r.expires_at } : {}), ...(r.last_error ? { lastError: r.last_error } : {}) }));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Resolution: which RemoteDriver serves a space (uses S's provider-config; absent module / local choice → null = local drivers)
// ---------------------------------------------------------------------------------------------------------------------------------
interface ConfigsLike {
	effectiveFor(space: Space): { kind: "local" } | { kind: "provider"; provider: ProviderId; orgId: string };
	explain(space: Space): string;
	connection(orgId: string, provider: ProviderId): Promise<import("./provider.ts").ProviderConnection | null>;
	lifecycle(orgId: string, provider: ProviderId): LifecyclePolicy;
	/** Round 10: the admin-configured working directory of a provider (absent when none is set; sync, reads the stored row only). */
	workDirOf?(orgId: string, provider: ProviderId): string | undefined;
	factory: (conn: import("./provider.ts").ProviderConnection) => Promise<RemoteProvider>;
}

export class RemoteDrivers {
	readonly #ctx: AppContext;
	readonly #cache = new Map<string, { fp: string; driver: RemoteDriver }>();
	readonly #building = new Map<string, Promise<RemoteDriver>>();
	#configs: Promise<ConfigsLike | undefined> | undefined;
	#timer: NodeJS.Timeout | undefined;
	#override: (() => ConfigsLike | undefined) | undefined;

	constructor(ctx: AppContext, opts: { configs?: () => ConfigsLike | undefined } = {}) {
		this.#ctx = ctx;
		this.#override = opts.configs;
	}

	/** Synchronous view of the configuration (override or the per-context provider configs); undefined when not available. */
	#cfgSync(): ConfigsLike | undefined {
		if (this.#override) return this.#override();
		try {
			return providerConfigsFor(this.#ctx) as unknown as ConfigsLike;
		} catch {
			return undefined;
		}
	}

	#cfg(): Promise<ConfigsLike | undefined> {
		if (this.#override) return Promise.resolve(this.#override());
		return (this.#configs ??= (async () => {
			try {
				const spec = "./provider-config.ts"; // written by another group; absent → local behaviour only
				const mod = await import(spec);
				return typeof mod.providerConfigsFor === "function" ? (mod.providerConfigsFor(this.#ctx) as ConfigsLike) : undefined;
			} catch {
				return undefined;
			}
		})());
	}

	/** The remote driver for a space, or null when the space uses the local drivers. Throws a clear 503 when the chosen provider is unusable (never falls back). */
	async forSpace(space: Space): Promise<RemoteDriver | null> {
		const cfg = await this.#cfg();
		if (!cfg) return null;
		const eff = cfg.effectiveFor(space);
		if (eff.kind === "local") return null;
		const why = cfg.explain(space);
		if (why) throw new HttpError(503, "sandbox_provider_unavailable", why);
		return this.#driver(cfg, eff.orgId, eff.provider);
	}

	async #driver(cfg: ConfigsLike, orgId: string, provider: ProviderId): Promise<RemoteDriver> {
		const conn = await cfg.connection(orgId, provider);
		if (!conn) throw new HttpError(503, "sandbox_provider_unavailable", `沙箱提供方 ${provider} 未启用或未配置（不会回退到本机执行）`);
		const lc = cfg.lifecycle(orgId, provider);
		// The resolved working directory is part of the fingerprint: a change rebuilds the driver, whose runs then re-sync the whole workspace into the new directory.
		const fp = sha256(JSON.stringify([conn, lc, resolveWorkDir(provider, conn.workDir)]));
		const key = `${orgId}|${provider}`;
		const hit = this.#cache.get(key);
		if (hit && hit.fp === fp) return hit.driver;
		let p = this.#building.get(`${key}|${fp}`);
		if (!p) {
			p = (async () => {
				let prov: RemoteProvider;
				try {
					prov = await cfg.factory(conn);
				} catch (e: any) {
					if (e instanceof HttpError) throw e;
					throw new HttpError(503, "sandbox_provider_unavailable", `无法初始化沙箱提供方 ${provider}：${scrub(e?.message ?? e)}（不会回退到本机执行）`);
				}
				const driver = new RemoteDriver({ db: this.#ctx.db, provider: prov, orgId, lifecycle: lc, template: conn.template, image: conn.image, resources: conn.resources, workDir: conn.workDir });
				const old = this.#cache.get(key);
				this.#cache.set(key, { fp, driver });
				void old?.driver.close();
				return driver;
			})().finally(() => this.#building.delete(`${key}|${fp}`));
			this.#building.set(`${key}|${fp}`, p);
		}
		return p;
	}

	/**
	 * Round 10: where the workspace and the skills live inside the sandbox this space uses, from configuration only (never creates, connects or probes
	 * anything; cheap enough for every prompt render). null = the space uses a local driver ("/work", "/skills").
	 */
	layoutFor(space: Space): { provider: ProviderId; workDir: string; skillsRoot: string } | null {
		const cfg = this.#cfgSync();
		if (!cfg) return null;
		const eff = cfg.effectiveFor(space);
		if (eff.kind === "local") return null;
		const workDir = resolveWorkDir(eff.provider, cfg.workDirOf?.(eff.orgId, eff.provider));
		return { provider: eff.provider, workDir, skillsRoot: skillsRootFor(workDir) };
	}

	/** Notes for run records: from a cached driver of that provider, else the generic text. */
	notesFor(provider: string): IsolationNotes {
		for (const { driver } of this.#cache.values()) if (driver.id === provider) return driver.notes;
		return remoteNotes(provider);
	}
	/** Cached drivers (tests, admin). */
	drivers(): RemoteDriver[] {
		return [...this.#cache.values()].map((v) => v.driver);
	}

	/** Reap idle/expired/orphaned sandboxes for every (org, provider) that has tracked instances or a cached driver. Never throws. */
	async reapAll(orphans = false): Promise<number> {
		let n = 0;
		const cfg = await this.#cfg();
		if (!cfg) return 0;
		const pairs = new Map<string, [string, ProviderId]>();
		for (const r of this.#ctx.db.all<{ org_id: string; provider: string }>(`SELECT DISTINCT org_id, provider FROM tool_sandbox_instances WHERE state IN ${LIVE}`)) pairs.set(`${r.org_id}|${r.provider}`, [r.org_id, r.provider as ProviderId]);
		for (const { driver } of this.#cache.values()) pairs.set(`${driver.orgId}|${driver.id}`, [driver.orgId, driver.id]);
		for (const [orgId, provider] of pairs.values()) {
			try {
				const d = await this.#driver(cfg, orgId, provider);
				n += orphans ? await d.reapStale() : await d.reapIdle();
			} catch (e) {
				console.error(`[sandbox] remote reap (${provider}) skipped:`, scrub(String((e as Error)?.message ?? e)));
			}
		}
		return n;
	}

	start(): void {
		this.#timer = setInterval(() => void this.reapAll(false), 60_000);
		this.#timer.unref();
	}
	async stop(): Promise<void> {
		clearInterval(this.#timer);
		await Promise.all([...this.#cache.values()].map((v) => v.driver.close()));
	}
}
