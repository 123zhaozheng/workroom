// Round 7b (group P): persistent workspace. Versions of a conversation's /work directory, kept in the content-addressed blob store.
//
// Layers (never conflate): pi-durable conversation checkpoints ≠ workspace file versions (this file) ≠ sandbox memory/process snapshots.
// The HOST working copy (<space.dir>/sandbox/<workspaceKey>) stays authoritative for runs; a version is a verified, immutable copy of it.
// Deliverables/uploads live in the file library (FileService) and are NOT duplicated here.
//
// Safety rules implemented here:
//  * commit never modifies the working copy; a failed/limit-exceeded/conflicting commit leaves it untouched and blocks reaping;
//  * symlinks and special files are never followed or saved (skipped with a note); paths are normalised and validated both ways;
//  * restore builds into a temp dir, verifies every sha256 (and the manifest hash), then swaps atomically; it never overwrites unsynced changes;
//  * nothing here deletes a working copy except reapWorkingCopies, which only removes idle copies equal to a committed head.
import { createHash, randomBytes } from "node:crypto";
import { constants, existsSync, readdirSync } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { AppContext, Principal, Space } from "../../core/contracts.ts";
import type { Migration } from "../../core/db.ts";
import { HttpError, newId, nowIso } from "../../core/http.ts";
import type { WorkspacePersistPolicyDTO, WorkspaceSaveState, WorkspaceSaveStatusDTO, WorkspaceVersionDTO } from "../../../../shared/workspace-safety.ts";

/** Export; the integrator wires these into toolsModule.migrations with version offset +1000. */
export const PERSIST_MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "persistent workspace versions, state, policy, run reconciliation",
		sql: `
CREATE TABLE workspace_versions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  parent_version INTEGER,
  manifest_sha256 TEXT NOT NULL,
  manifest TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (space_id, workspace_key, version)
);
CREATE INDEX workspace_versions_org ON workspace_versions(org_id, space_id);
CREATE TABLE workspace_state (
  space_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  org_id TEXT NOT NULL,
  state TEXT NOT NULL,
  head_version INTEGER,
  last_saved_at TEXT,
  last_attempt_at TEXT,
  failure TEXT,
  restore TEXT,
  PRIMARY KEY (space_id, workspace_key)
);
CREATE TABLE workspace_persist_policy (
  org_id TEXT PRIMARY KEY,
  policy TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE workspace_run_reconciliations (
  run_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  previous_status TEXT NOT NULL,
  note TEXT NOT NULL,
  reconciled_at TEXT NOT NULL
);
`,
	},
];

export const DEFAULT_PERSIST_POLICY: WorkspacePersistPolicyDTO = {
	exclude: ["node_modules/", ".venv/", "__pycache__/", ".cache/", ".npm/", ".pip/", "tmp/", ".skill-run/", "*.pyc", "*.tmp"],
	maxFileBytes: 50 * 1024 * 1024,
	maxFiles: 5000,
	maxTotalBytes: 500 * 1024 * 1024,
	keepVersions: 20,
	workingCopyRetentionHours: 72,
	periodicSyncSec: 0,
};

export const RUN_RECONCILED_NOTE = "服务重启时仍在运行，结果未知；不会自动重新执行";
export const LOCAL_LOSS_WINDOW = "本地沙箱直接使用服务器上的工作目录。最近一次保存之后的改动尚未写入版本历史；工作目录被清理或服务器磁盘损坏时，这部分改动无法找回。";
export const REMOTE_LOSS_WINDOW = "运行中的命令结束前，其在远程沙箱中的改动尚未同步回服务器，也未保存为版本；远程沙箱丢失时这些改动会丢失（服务器上的工作目录和已保存的版本不受影响）。";

const KEY_RE = /^(shared|c[0-9]{1,12})$/;
const MAX_DEPTH = 64;
const UNSYNCED_CAP = 50;

export const workspaceKeyOf = (conversationId: number | undefined): string => (conversationId === undefined ? "shared" : `c${conversationId}`);

export interface ManifestEntry {
	readonly path: string;
	readonly size: number;
	readonly sha256: string;
	readonly mode: number;
}

export interface CommitResult {
	/** True when the commit ended in state "saved" (including "nothing changed"). */
	readonly ok: boolean;
	/** True when a new version row was created (false: idempotent no-op, conflict or failure). */
	readonly created: boolean;
	readonly version: number | null;
	/** Skipped entries (symlinks, special files, unsafe names) — reported, never silently followed. */
	readonly notes: readonly string[];
	readonly status: WorkspaceSaveStatusDTO;
}

export interface RestoreResult {
	readonly fromVersion: number;
	readonly verified: true;
	/** Version id the previous (dirty) working copy was saved as when force "keep-both" was used. */
	readonly keptAsVersion?: number;
	readonly status: WorkspaceSaveStatusDTO;
}

// ───────────────────────────── helpers ─────────────────────────────
class PersistFailure extends Error {}

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** A manifest path is relative, "/"-separated and free of "", ".", "..", NUL, backslash and drive letters. */
export function safeRelPath(rel: unknown): boolean {
	if (typeof rel !== "string" || !rel || rel.length > 1024) return false;
	if (rel.includes("\0") || rel.includes("\\") || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) return false;
	return rel.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

const normMode = (mode: number) => (mode & 0o111 ? 0o755 : 0o644);

function manifestHash(m: readonly ManifestEntry[]): string {
	return sha256(JSON.stringify(m.map((e) => [e.path, e.size, e.sha256, e.mode])));
}

const reEscape = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
function globRe(g: string): RegExp {
	let out = "";
	for (let i = 0; i < g.length; i++) {
		const ch = g[i]!;
		if (ch === "*") {
			if (g[i + 1] === "*") (out += ".*", i++);
			else out += "[^/]*";
		} else if (ch === "?") out += "[^/]";
		else out += reEscape(ch);
	}
	return new RegExp(`^${out}$`);
}
/** Patterns: "name/" = a directory of that name at any depth; "*.ext"/"name" = basename glob at any depth; a pattern containing "/" (or leading "/") is anchored at the root. */
export function compileExclude(patterns: readonly string[]): (rel: string, isDir: boolean) => boolean {
	const rules = patterns
		.map((raw) => raw.trim())
		.filter(Boolean)
		.map((raw) => {
			const dirOnly = raw.endsWith("/");
			let p = raw.replace(/\/+$/, "").replace(/^\.\//, "");
			const anchored = p.startsWith("/") || p.includes("/");
			p = p.replace(/^\/+/, "");
			return { dirOnly, anchored, re: globRe(p) };
		});
	return (rel, isDir) => {
		const base = rel.slice(rel.lastIndexOf("/") + 1);
		return rules.some((r) => (!r.dirOnly || isDir) && (r.anchored ? r.re.test(rel) : r.re.test(base)));
	};
}

interface ScanFile {
	readonly rel: string;
	readonly abs: string;
	readonly size: number;
	readonly mode: number;
}
interface Scan {
	readonly exists: boolean;
	readonly files: ScanFile[];
	readonly skipped: string[];
	readonly totalBytes: number;
}

interface Limits {
	maxFiles: number;
	maxFileBytes: number;
	maxTotalBytes: number;
}

/** lstat-only walk; symlinks and special files are never followed (skipped with a note). Limits throw when `limits` is given. */
async function walk(root: string, exclude: (rel: string, isDir: boolean) => boolean, limits?: Limits): Promise<Scan> {
	const files: ScanFile[] = [];
	const skipped: string[] = [];
	let total = 0;
	let rootStat;
	try {
		rootStat = await lstat(root);
	} catch {
		return { exists: false, files, skipped, totalBytes: 0 };
	}
	if (!rootStat.isDirectory()) throw new PersistFailure("工作目录不是普通目录（可能是符号链接），已拒绝保存");
	const go = async (dir: string, relDir: string, depth: number): Promise<void> => {
		const names = (await readdir(dir)).sort();
		for (const name of names) {
			const rel = relDir ? `${relDir}/${name}` : name;
			const abs = join(dir, name);
			const st = await lstat(abs);
			if (st.isSymbolicLink()) {
				if (!exclude(rel, false)) skipped.push(`${rel}（符号链接，未保存）`);
				continue;
			}
			if (st.isDirectory()) {
				if (exclude(rel, true)) continue;
				if (depth >= MAX_DEPTH) {
					skipped.push(`${rel}/（目录层级过深，未保存）`);
					continue;
				}
				await go(abs, rel, depth + 1);
				continue;
			}
			if (exclude(rel, false)) continue;
			if (!st.isFile()) {
				skipped.push(`${rel}（特殊文件，未保存）`);
				continue;
			}
			if (!safeRelPath(rel)) {
				skipped.push(`${rel.replace(/[\u0000-\u001f]/g, "?")}（文件名不安全，未保存）`);
				continue;
			}
			if (limits) {
				if (files.length + 1 > limits.maxFiles) throw new PersistFailure(`文件数超过上限 ${limits.maxFiles}；请删除不需要的文件，或让管理员调整策略（maxFiles）。未保存任何内容`);
				if (st.size > limits.maxFileBytes) throw new PersistFailure(`文件 ${rel} 大小 ${st.size} 字节，超过单文件上限 ${limits.maxFileBytes} 字节；请删除它，或让管理员调整策略（maxFileBytes）。未保存任何内容`);
				if (total + st.size > limits.maxTotalBytes) throw new PersistFailure(`工作目录总大小超过上限 ${limits.maxTotalBytes} 字节（在 ${rel} 处超出）；请删除不需要的文件，或让管理员调整策略（maxTotalBytes）。未保存任何内容`);
			}
			total += st.size;
			files.push({ rel, abs, size: st.size, mode: normMode(st.mode) });
		}
	};
	await go(root, "", 0);
	return { exists: true, files, skipped, totalBytes: total };
}

/** Read a regular file without following a final symlink; detects modification during the read (retries, then fails explicitly). */
async function readStable(abs: string, rel: string, maxBytes?: number): Promise<Buffer> {
	for (let attempt = 0; attempt < 3; attempt++) {
		let fh;
		try {
			fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (e) {
			throw new PersistFailure(`无法读取 ${rel}：${(e as NodeJS.ErrnoException).code ?? "错误"}（文件可能在保存过程中被删除或替换）`);
		}
		try {
			const before = await fh.stat();
			if (!before.isFile()) throw new PersistFailure(`${rel} 在保存过程中变成了非普通文件`);
			if (maxBytes !== undefined && before.size > maxBytes) throw new PersistFailure(`文件 ${rel} 大小 ${before.size} 字节，超过单文件上限 ${maxBytes} 字节。未保存任何内容`);
			const buf = await fh.readFile();
			const after = await fh.stat();
			if (buf.length === after.size && after.mtimeMs === before.mtimeMs && after.size === before.size) return buf;
		} finally {
			await fh.close();
		}
	}
	throw new PersistFailure(`文件 ${rel} 在保存过程中持续被修改，已放弃本次保存（工作目录未改动）；请待命令结束后重试`);
}

interface StateRow {
	space_id: string;
	workspace_key: string;
	org_id: string;
	state: string;
	head_version: number | null;
	last_saved_at: string | null;
	last_attempt_at: string | null;
	failure: string | null;
	restore: string | null;
}
interface VersionRow {
	id: string;
	version: number;
	parent_version: number | null;
	manifest_sha256: string;
	manifest: string;
	file_count: number;
	total_bytes: number;
	reason: string;
	created_by: string;
	created_at: string;
}

interface Diff {
	exists: boolean;
	changed: string[];
	skipped: string[];
}

const services = new WeakMap<AppContext, WorkspacePersistence>();
/** Lazy per-context accessor (also fine to `ctx.services.provide("workspacePersist", workspacePersistenceFor(ctx))` at init). */
export function workspacePersistenceFor(ctx: AppContext): WorkspacePersistence {
	let s = services.get(ctx);
	if (!s) services.set(ctx, (s = new WorkspacePersistence(ctx)));
	return s;
}

export class WorkspacePersistence {
	readonly #ctx: AppContext;
	readonly #chains = new Map<string, Promise<unknown>>();
	/** Operations running right now (so a "saving"/"restoring" row without one is known to be a crash leftover). */
	readonly #busy = new Set<string>();
	/** The integrator may set this to describe the active driver's loss window (e.g. REMOTE_LOSS_WINDOW for remote providers). */
	lossWindowFor: (space: Space, workspaceKey: string) => string | Promise<string> = () => LOCAL_LOSS_WINDOW;

	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}

	// ───────────── paths / auth ─────────────
	workingDir(space: Space, workspaceKey: string): string {
		this.#key(workspaceKey);
		return join(space.dir, "sandbox", workspaceKey);
	}
	#key(k: string): string {
		if (!KEY_RE.test(k)) throw new HttpError(400, "bad_workspace_key", "工作区标识无效（应为 shared 或 c<会话号>）");
		return k;
	}
	async #authorise(p: Principal, space: Space, key: string, action: "read" | "write"): Promise<void> {
		this.#key(key);
		if (space.orgId !== p.orgId) throw new HttpError(404, "space_not_found", "空间不存在");
		await this.#ctx.services.get("acl").require(p, action, { kind: "space", id: space.id });
	}
	async canManagePolicy(p: Principal): Promise<boolean> {
		if (!this.#ctx.services.has("authz")) return p.orgRole === "owner" || p.orgRole === "admin";
		try {
			return await this.#ctx.services.get("authz").has(p, "sandbox.policy.manage", { kind: "org" });
		} catch {
			return false;
		}
	}
	async #requireManage(p: Principal): Promise<void> {
		if (!(await this.canManagePolicy(p))) throw new HttpError(403, "forbidden", "没有权限：管理沙箱与工具策略（sandbox.policy.manage）。请联系组织管理员。");
	}

	/** Serialise operations per workspace. */
	#serial<T>(spaceId: string, key: string, fn: () => Promise<T>): Promise<T> {
		const k = `${spaceId}|${key}`;
		const prev = this.#chains.get(k) ?? Promise.resolve();
		const run = prev.catch(() => {}).then(async () => {
			this.#busy.add(k);
			try {
				return await fn();
			} finally {
				this.#busy.delete(k);
			}
		});
		const tail = run.catch(() => {});
		this.#chains.set(k, tail);
		void tail.then(() => {
			if (this.#chains.get(k) === tail) this.#chains.delete(k);
		});
		return run;
	}

	// ───────────── policy ─────────────
	policyFor(orgId: string): WorkspacePersistPolicyDTO {
		const row = this.#ctx.db.get<{ policy: string }>("SELECT policy FROM workspace_persist_policy WHERE org_id = ?", orgId);
		if (!row) return DEFAULT_PERSIST_POLICY;
		try {
			return this.#normalisePolicy({ ...DEFAULT_PERSIST_POLICY, ...(JSON.parse(row.policy) as Partial<WorkspacePersistPolicyDTO>) });
		} catch {
			return DEFAULT_PERSIST_POLICY;
		}
	}
	#normalisePolicy(x: Record<string, unknown>): WorkspacePersistPolicyDTO {
		const int = (name: string, min: number, max: number, extra?: (n: number) => boolean): number => {
			const v = x[name];
			if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max || (extra && !extra(v))) throw new HttpError(400, "invalid_policy", `${name} 必须是 ${min}–${max} 之间的整数`);
			return v;
		};
		const ex = x.exclude;
		if (!Array.isArray(ex) || ex.length > 100) throw new HttpError(400, "invalid_policy", "exclude 必须是最多 100 项的字符串数组");
		const exclude = ex.map((s) => {
			if (typeof s !== "string" || !s.trim() || s.length > 200 || s.includes("\0") || s.split("/").includes("..")) throw new HttpError(400, "invalid_policy", "exclude 中的模式无效（不能为空、不能含 .. 或超长）");
			return s.trim();
		});
		const maxFileBytes = int("maxFileBytes", 1, 2 * 1024 ** 3);
		const maxTotalBytes = int("maxTotalBytes", 1, 64 * 1024 ** 3);
		if (maxFileBytes > maxTotalBytes) throw new HttpError(400, "invalid_policy", "maxFileBytes 不能大于 maxTotalBytes");
		return {
			exclude,
			maxFileBytes,
			maxFiles: int("maxFiles", 1, 1_000_000),
			maxTotalBytes,
			keepVersions: int("keepVersions", 1, 1000),
			workingCopyRetentionHours: int("workingCopyRetentionHours", 1, 8760),
			periodicSyncSec: int("periodicSyncSec", 0, 86_400, (n) => n === 0 || n >= 30),
		};
	}
	async getPolicy(p: Principal): Promise<WorkspacePersistPolicyDTO> {
		await this.#requireManage(p);
		return this.policyFor(p.orgId);
	}
	async setPolicy(p: Principal, patch: Partial<WorkspacePersistPolicyDTO>): Promise<WorkspacePersistPolicyDTO> {
		await this.#requireManage(p);
		if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new HttpError(400, "invalid_policy", "请求体必须是对象");
		const known = new Set(Object.keys(DEFAULT_PERSIST_POLICY));
		const bad = Object.keys(patch).filter((k) => !known.has(k));
		if (bad.length) throw new HttpError(400, "invalid_policy", `未知字段：${bad.join("、")}`);
		const next = this.#normalisePolicy({ ...this.policyFor(p.orgId), ...patch });
		const at = nowIso();
		this.#ctx.db.run(
			"INSERT INTO workspace_persist_policy (org_id, policy, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(org_id) DO UPDATE SET policy = excluded.policy, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
			p.orgId, JSON.stringify(next), p.userId, at,
		);
		try {
			this.#ctx.db.run("INSERT INTO id_audit (id, org_id, actor_user_id, action, target, detail, at, category) VALUES (?, ?, ?, ?, ?, ?, ?, 'admin')", newId("aud"), p.orgId, p.userId, "workspace.persist.policy", p.orgId, JSON.stringify({ changed: Object.keys(patch) }), at);
		} catch {
			/* the audit table belongs to the identity module */
		}
		return next;
	}

	// ───────────── state / version rows ─────────────
	#state(spaceId: string, key: string): StateRow | undefined {
		return this.#ctx.db.get<StateRow>("SELECT * FROM workspace_state WHERE space_id = ? AND workspace_key = ?", spaceId, key);
	}
	#upsert(space: { id: string; orgId: string }, key: string, f: { state?: WorkspaceSaveState; head?: number | null; lastSavedAt?: string; lastAttemptAt?: string; failure?: string | null; restore?: unknown | null }): void {
		const cur = this.#state(space.id, key);
		const restore = "restore" in f ? (f.restore == null ? null : JSON.stringify(f.restore)) : (cur?.restore ?? null);
		this.#ctx.db.run(
			`INSERT INTO workspace_state (space_id, workspace_key, org_id, state, head_version, last_saved_at, last_attempt_at, failure, restore) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(space_id, workspace_key) DO UPDATE SET state = excluded.state, head_version = excluded.head_version, last_saved_at = excluded.last_saved_at, last_attempt_at = excluded.last_attempt_at, failure = excluded.failure, restore = excluded.restore`,
			space.id, key, space.orgId,
			f.state ?? cur?.state ?? "saved",
			"head" in f ? (f.head ?? null) : (cur?.head_version ?? null),
			f.lastSavedAt ?? cur?.last_saved_at ?? null,
			f.lastAttemptAt ?? cur?.last_attempt_at ?? null,
			"failure" in f ? (f.failure ?? null) : (cur?.failure ?? null),
			restore,
		);
	}
	#versionRow(spaceId: string, key: string, version: number): VersionRow | undefined {
		return this.#ctx.db.get<VersionRow>("SELECT * FROM workspace_versions WHERE space_id = ? AND workspace_key = ? AND version = ?", spaceId, key, version);
	}
	#headManifest(spaceId: string, key: string): { head: number | null; manifest: ManifestEntry[] } {
		const st = this.#state(spaceId, key);
		if (st?.head_version == null) return { head: null, manifest: [] };
		const row = this.#versionRow(spaceId, key, st.head_version);
		return { head: st.head_version, manifest: row ? (JSON.parse(row.manifest) as ManifestEntry[]) : [] };
	}

	// ───────────── diff / status ─────────────
	async #diff(space: { id: string; orgId: string }, wd: string, key: string): Promise<Diff> {
		const policy = this.policyFor(space.orgId);
		const scan = await walk(wd, compileExclude(policy.exclude));
		const { manifest } = this.#headManifest(space.id, key);
		const head = new Map(manifest.map((e) => [e.path, e]));
		const changed: string[] = [];
		const seen = new Set<string>();
		for (const f of scan.files) {
			seen.add(f.rel);
			const h = head.get(f.rel);
			if (!h || h.size !== f.size || h.mode !== f.mode) {
				changed.push(f.rel);
				continue;
			}
			try {
				if (sha256(await readStable(f.abs, f.rel)) !== h.sha256) changed.push(f.rel);
			} catch {
				changed.push(f.rel);
			}
		}
		for (const p of head.keys()) if (!seen.has(p)) changed.push(p);
		changed.sort();
		return { exists: scan.exists, changed, skipped: scan.skipped };
	}

	async #dto(space: Space, key: string, diff?: Diff): Promise<WorkspaceSaveStatusDTO> {
		const st = this.#state(space.id, key);
		const d = diff ?? (await this.#diff(space, this.workingDir(space, key), key));
		const policy = this.policyFor(space.orgId);
		let state = (st?.state ?? "saved") as WorkspaceSaveState;
		let failure = st?.failure ?? undefined;
		if ((state === "saving" || state === "restoring") && !this.#busy.has(`${space.id}|${key}`)) {
			state = "failed";
			failure = "上次保存/恢复被中断（服务重启或异常），工作目录未被改动；请重新保存";
		} else if ((state === "saved" || state === "restored") && d.changed.length) {
			state = "dirty";
			if (!d.exists) failure = "工作目录不存在；可从最近的版本恢复";
		}
		const restore = st?.restore ? (JSON.parse(st.restore) as NonNullable<WorkspaceSaveStatusDTO["restore"]>) : undefined;
		return {
			spaceId: space.id,
			workspaceKey: key,
			state,
			headVersion: st?.head_version ?? null,
			...(st?.last_saved_at ? { lastSavedAt: st.last_saved_at } : {}),
			...(st?.last_attempt_at ? { lastAttemptAt: st.last_attempt_at } : {}),
			...(failure ? { failure } : {}),
			unsynced: { count: d.changed.length, paths: d.changed.slice(0, UNSYNCED_CAP) },
			excludedPatterns: policy.exclude,
			...(restore ? { restore } : {}),
			lossWindow: await this.lossWindowFor(space, key),
		};
	}

	async status(p: Principal, space: Space, workspaceKey: string): Promise<WorkspaceSaveStatusDTO> {
		await this.#authorise(p, space, workspaceKey, "read");
		return this.#dto(space, workspaceKey);
	}

	// ───────────── commit ─────────────
	/** Save the working copy as a new version (idempotent). Failure / conflict are reported in the result (never thrown: callers are run hooks); the working copy is never touched. */
	async commit(p: Principal, space: Space, workspaceKey: string, reason: string, opts: { baseVersion?: number | null } = {}): Promise<CommitResult> {
		await this.#authorise(p, space, workspaceKey, "write");
		return this.#serial(space.id, workspaceKey, () => this.#commit(p, space, workspaceKey, reason, opts));
	}

	async #commit(p: Principal, space: Space, key: string, reason: string, opts: { baseVersion?: number | null }): Promise<CommitResult> {
		const wd = this.workingDir(space, key);
		const at = nowIso();
		const startHead = this.#state(space.id, key)?.head_version ?? null;
		const base = opts.baseVersion === undefined ? startHead : opts.baseVersion;
		this.#upsert(space, key, { state: "saving", lastAttemptAt: at });
		const notes: string[] = [];
		const result = (out: { created: boolean; version: number | null }, ok: boolean) => this.#dto(space, key).then((status) => ({ ok, created: out.created, version: out.version, notes, status }));
		const conflict = (head: number | null) => {
			const msg = `保存冲突：这次保存基于${base == null ? "空工作区" : `第 ${base} 版`}，但当前最新为${head == null ? "空" : `第 ${head} 版`}（已有其他保存或恢复）；没有覆盖任何内容，工作目录保持不变。可重新保存（基于最新版本）或选择恢复。`;
			this.#upsert(space, key, { state: "conflict", failure: msg });
			return result({ created: false, version: head }, false);
		};
		try {
			if (startHead !== base) return await conflict(startHead);
			const policy = this.policyFor(space.orgId);
			const scan = await walk(wd, compileExclude(policy.exclude), policy);
			if (!scan.exists) throw new PersistFailure("工作目录不存在，无可保存内容（可从最近的版本恢复）");
			notes.push(...scan.skipped);
			const manifest: ManifestEntry[] = [];
			let total = 0;
			for (const f of scan.files) {
				const bytes = await readStable(f.abs, f.rel, policy.maxFileBytes);
				const sha = sha256(bytes);
				if (!this.#ctx.blobs.has(sha)) {
					const put = this.#ctx.blobs.put(bytes);
					if (put.sha256 !== sha) throw new PersistFailure(`写入内容块时校验不一致：${f.rel}`);
				}
				total += bytes.length;
				if (total > policy.maxTotalBytes) throw new PersistFailure(`工作目录总大小超过上限 ${policy.maxTotalBytes} 字节。未保存任何内容`);
				manifest.push({ path: f.rel, size: bytes.length, sha256: sha, mode: f.mode });
			}
			manifest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
			const msha = manifestHash(manifest);
			type TxOut = { kind: "conflict"; head: number | null } | { kind: "ok"; created: boolean; version: number | null };
			const out = this.#ctx.db.tx((): TxOut => {
				const head = this.#state(space.id, key)?.head_version ?? null;
				if (head !== base) return { kind: "conflict", head };
				const headRow = head == null ? undefined : this.#versionRow(space.id, key, head);
				const saved = { state: "saved" as const, lastSavedAt: at, failure: null };
				if (headRow ? headRow.manifest_sha256 === msha : manifest.length === 0) {
					this.#upsert(space, key, saved);
					return { kind: "ok", created: false, version: head };
				}
				const max = this.#ctx.db.get<{ m: number | null }>("SELECT MAX(version) AS m FROM workspace_versions WHERE space_id = ? AND workspace_key = ?", space.id, key)?.m ?? 0;
				const version = max + 1;
				this.#ctx.db.run(
					"INSERT INTO workspace_versions (id, org_id, space_id, workspace_key, version, parent_version, manifest_sha256, manifest, file_count, total_bytes, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					newId("wsv"), space.orgId, space.id, key, version, head, msha, JSON.stringify(manifest), manifest.length, total, reason.slice(0, 40), p.userId, at,
				);
				this.#upsert(space, key, { ...saved, head: version });
				this.#prune(space.id, key, policy.keepVersions, version);
				return { kind: "ok", created: true, version };
			});
			if (out.kind === "conflict") return await conflict(out.head);
			return await result(out, true);
		} catch (e) {
			const msg = e instanceof PersistFailure ? e.message : `保存失败：${e instanceof Error ? e.message : String(e)}`;
			this.#upsert(space, key, { state: "failed", failure: msg });
			return await result({ created: false, version: null }, false);
		}
	}

	/** Keep the newest `keep` versions plus the head and the last restore source. Blobs are content-addressed and shared: they are never deleted here. */
	#prune(spaceId: string, key: string, keep: number, head: number): void {
		const st = this.#state(spaceId, key);
		const restoreFrom = st?.restore ? (JSON.parse(st.restore) as { fromVersion?: number }).fromVersion : undefined;
		const rows = this.#ctx.db.all<{ version: number }>("SELECT version FROM workspace_versions WHERE space_id = ? AND workspace_key = ? ORDER BY version DESC", spaceId, key);
		for (const r of rows.slice(keep)) if (r.version !== head && r.version !== restoreFrom) this.#ctx.db.run("DELETE FROM workspace_versions WHERE space_id = ? AND workspace_key = ? AND version = ?", spaceId, key, r.version);
	}

	// ───────────── versions ─────────────
	#dtoV(r: VersionRow): WorkspaceVersionDTO {
		return { version: r.version, createdAt: r.created_at, createdBy: r.created_by, reason: r.reason, fileCount: r.file_count, totalBytes: r.total_bytes, manifestSha256: r.manifest_sha256 };
	}
	async versions(p: Principal, space: Space, workspaceKey: string): Promise<WorkspaceVersionDTO[]> {
		await this.#authorise(p, space, workspaceKey, "read");
		return this.#ctx.db.all<VersionRow>("SELECT * FROM workspace_versions WHERE space_id = ? AND workspace_key = ? ORDER BY version DESC", space.id, workspaceKey).map((r) => this.#dtoV(r));
	}
	async manifest(p: Principal, space: Space, workspaceKey: string, version: number): Promise<ManifestEntry[]> {
		await this.#authorise(p, space, workspaceKey, "read");
		const r = this.#versionRow(space.id, workspaceKey, version);
		if (!r) throw new HttpError(404, "version_not_found", "版本不存在");
		return JSON.parse(r.manifest) as ManifestEntry[];
	}

	// ───────────── restore ─────────────
	/**
	 * Rebuild the working copy from a version (default: the head, else the newest). Never overwrites unsynced changes: when the working copy
	 * differs from the head the call fails with 409 (state "conflict" lists the paths) unless force "keep-both", which first saves the
	 * working copy as a new version. Verification failure → 500 `restore_verify_failed`, state "failed", working copy untouched.
	 */
	async restore(p: Principal, space: Space, workspaceKey: string, opts: { version?: number; force?: "keep-both"; emptyIsMissing?: boolean } = {}): Promise<RestoreResult> {
		await this.#authorise(p, space, workspaceKey, "write");
		if (opts.force !== undefined && opts.force !== "keep-both") throw new HttpError(400, "invalid", 'force 只能是 "keep-both"');
		if (opts.version !== undefined && !Number.isInteger(opts.version)) throw new HttpError(400, "invalid", "version 必须是整数");
		return this.#serial(space.id, workspaceKey, () => this.#restore(p, space, workspaceKey, opts));
	}

	async #restore(p: Principal, space: Space, key: string, opts: { version?: number; force?: "keep-both"; emptyIsMissing?: boolean }): Promise<RestoreResult> {
		const wd = this.workingDir(space, key);
		const st = this.#state(space.id, key);
		const target = opts.version ?? st?.head_version ?? this.#ctx.db.get<{ m: number | null }>("SELECT MAX(version) AS m FROM workspace_versions WHERE space_id = ? AND workspace_key = ?", space.id, key)?.m ?? null;
		if (target == null) throw new HttpError(404, "version_not_found", "还没有已保存的版本，无法恢复");
		const row = this.#versionRow(space.id, key, target);
		if (!row) throw new HttpError(404, "version_not_found", "版本不存在");
		const at = nowIso();
		const failRestore = (failure: string, conflicts: string[], status: 409 | 500, code: string): never => this.#failRestore(space, key, target, at, failure, conflicts, status, code);

		// 1. unsynced changes protect the working copy
		let diff = await this.#diff(space, wd, key);
		let keptAs: number | undefined;
		const existing = diff.exists && !(opts.emptyIsMissing && (await this.#isEmpty(wd, space.orgId)));
		if (existing && diff.changed.length) {
			if (opts.force !== "keep-both") failRestore(`工作目录有尚未保存的改动（${diff.changed.length} 处），为避免丢失未覆盖。请先保存，或选择“两者都保留”（先把当前内容另存为新版本再恢复）。`, diff.changed, 409, "workspace_dirty");
			const saved = await this.#commit(p, space, key, "restore", {});
			if (!saved.ok) failRestore(`恢复前先保存当前内容失败，未做任何改动：${saved.status.failure ?? "未知原因"}`, diff.changed, 409, "workspace_dirty");
			keptAs = saved.version ?? undefined;
			diff = await this.#diff(space, wd, key);
		}
		this.#upsert(space, key, { state: "restoring", lastAttemptAt: at });

		// 2. rebuild in a temp dir next to the working copy (same filesystem → atomic rename) and verify
		const sandboxDir = join(space.dir, "sandbox");
		const tmp = join(sandboxDir, ".restore-tmp", `${key}-${randomBytes(6).toString("hex")}`);
		try {
			let manifest: ManifestEntry[];
			try {
				manifest = JSON.parse(row.manifest) as ManifestEntry[];
			} catch {
				throw new PersistFailure("版本清单已损坏，无法解析");
			}
			if (manifestHash(manifest) !== row.manifest_sha256) throw new PersistFailure(`版本 ${target} 的清单校验失败（sha256 不一致），已拒绝恢复`);
			await mkdir(tmp, { recursive: true });
			const root = resolve(tmp);
			for (const e of manifest) {
				if (!safeRelPath(e.path)) throw new PersistFailure(`版本清单含不安全路径，已拒绝恢复：${String(e.path).slice(0, 80)}`);
				const dest = resolve(root, e.path);
				if (!dest.startsWith(root + sep)) throw new PersistFailure(`版本清单路径越界，已拒绝恢复：${e.path}`);
				if (typeof e.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(e.sha256)) throw new PersistFailure(`清单中 ${e.path} 的校验值无效`);
				const bytes = this.#ctx.blobs.get(e.sha256);
				if (!bytes) throw new PersistFailure(`缺少 ${e.path} 的内容块（sha256 ${e.sha256.slice(0, 12)}…），无法完整恢复`);
				if (sha256(bytes) !== e.sha256 || bytes.byteLength !== e.size) throw new PersistFailure(`${e.path} 的内容与清单 sha256 不一致（内容块被篡改或损坏），已拒绝恢复`);
				await mkdir(dirname(dest), { recursive: true });
				await writeFile(dest, bytes, { flag: "wx" });
				await chmod(dest, e.mode === 0o755 ? 0o755 : 0o644);
			}
			// 3. swap: old copy (if any) is moved aside, never deleted unless it was a clean, fully-saved copy
			let aside: string | undefined;
			if (diff.exists) {
				aside = join(sandboxDir, ".restore-backup", `${key}-${at.replace(/[:.]/g, "-")}`);
				await mkdir(dirname(aside), { recursive: true });
				await rename(wd, aside);
			}
			try {
				await mkdir(sandboxDir, { recursive: true });
				await rename(tmp, wd);
			} catch (e) {
				if (aside) await rename(aside, wd).catch(() => {});
				throw e;
			}
			if (aside && diff.changed.length === 0 && diff.skipped.length === 0) await rm(aside, { recursive: true, force: true }).catch(() => {});
			this.#upsert(space, key, { state: "restored", head: target, failure: null, lastAttemptAt: at, restore: { fromVersion: target, at, verified: true, conflicts: [] } });
		} catch (e) {
			await rm(tmp, { recursive: true, force: true }).catch(() => {});
			const msg = e instanceof PersistFailure ? e.message : `恢复失败：${e instanceof Error ? e.message : String(e)}`;
			failRestore(msg, [], 500, "restore_verify_failed");
		}
		return { fromVersion: target, verified: true, ...(keptAs !== undefined ? { keptAsVersion: keptAs } : {}), status: await this.#dto(space, key) };
	}

	#failRestore(space: { id: string; orgId: string }, key: string, target: number, at: string, failure: string, conflicts: string[], status: 409 | 500, code: string): never {
		this.#upsert(space, key, { state: status === 409 ? "conflict" : "failed", failure, lastAttemptAt: at, restore: { fromVersion: target, at, verified: false, conflicts: conflicts.slice(0, UNSYNCED_CAP) } });
		throw new HttpError(status, code, failure);
	}

	async #isEmpty(wd: string, orgId: string): Promise<boolean> {
		return (await walk(wd, compileExclude(this.policyFor(orgId).exclude))).files.length === 0;
	}

	/** Called before a run: when the working copy is absent (fresh host, reaped, lost) but versions exist, rebuild it. Returns the status; a failed/conflict state is reported, not thrown. Call BEFORE anything creates the directory (Sandbox.workdir mkdirs), or pass emptyIsMissing. */
	async ensureReady(p: Principal, space: Space, workspaceKey: string, opts: { emptyIsMissing?: boolean } = {}): Promise<WorkspaceSaveStatusDTO> {
		await this.#authorise(p, space, workspaceKey, "write");
		const wd = this.workingDir(space, workspaceKey);
		const has = this.#ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM workspace_versions WHERE space_id = ? AND workspace_key = ?", space.id, workspaceKey)!.n > 0;
		const missing = !existsSync(wd) || (opts.emptyIsMissing === true && (await this.#isEmpty(wd, space.orgId)));
		if (has && missing) {
			try {
				await this.restore(p, space, workspaceKey, { ...(opts.emptyIsMissing ? { emptyIsMissing: true } : {}) });
			} catch (e) {
				if (!(e instanceof HttpError)) throw e;
			}
		}
		return this.#dto(space, workspaceKey);
	}

	// ───────────── reaping ─────────────
	/** True only when the stored state is saved/restored and the working copy equals the head (no unsynced changes, nothing unsaved-by-design such as symlinks). */
	async isSafeToReap(space: Space, workspaceKey: string): Promise<boolean> {
		this.#key(workspaceKey);
		if (this.#busy.has(`${space.id}|${workspaceKey}`)) return false;
		return this.#safe(space, workspaceKey);
	}
	async #safe(space: { id: string; orgId: string; dir: string }, key: string): Promise<boolean> {
		const st = this.#state(space.id, key);
		if (st && st.state !== "saved" && st.state !== "restored") return false;
		const d = await this.#diff(space, join(space.dir, "sandbox", key), key);
		return d.changed.length === 0 && d.skipped.length === 0;
	}

	/**
	 * Replacement for the file-level sweep of Sandbox.reap(): removes a whole working copy only when it has been idle longer than the org's
	 * workingCopyRetentionHours AND is safe to reap. Dirty / failed / conflict / never-saved copies are kept (reported in `kept`).
	 */
	async reapWorkingCopies(now = Date.now()): Promise<{ removed: string[]; kept: { workspace: string; reason: string }[] }> {
		const removed: string[] = [];
		const kept: { workspace: string; reason: string }[] = [];
		const orgs = join(this.#ctx.config.dataDir, "orgs");
		if (!existsSync(orgs)) return { removed, kept };
		for (const orgId of readdirSync(orgs)) {
			const spaces = join(orgs, orgId, "spaces");
			if (!existsSync(spaces)) continue;
			const retentionMs = this.policyFor(orgId).workingCopyRetentionHours * 3600_000;
			for (const spaceId of readdirSync(spaces)) {
				const sb = join(spaces, spaceId, "sandbox");
				if (!existsSync(sb)) continue;
				for (const key of readdirSync(sb)) {
					if (!KEY_RE.test(key)) continue;
					const wd = join(sb, key);
					const label = `${spaceId}/${key}`;
					const space = { id: spaceId, orgId, dir: join(spaces, spaceId) };
					try {
						await this.#serial(spaceId, key, async () => {
							const idle = await this.#newestMtime(wd);
							if (idle === null || idle >= now - retentionMs) return;
							if (!(await this.#safe(space, key))) {
								kept.push({ workspace: label, reason: "有未保存的改动、保存失败/冲突或包含未保存的特殊条目；保留" });
								return;
							}
							await rm(wd, { recursive: true, force: true });
							removed.push(label);
						});
					} catch (e) {
						kept.push({ workspace: label, reason: `检查失败：${e instanceof Error ? e.message : String(e)}` });
					}
				}
			}
		}
		return { removed, kept };
	}

	/** Newest mtime of anything under `dir` (including the directory itself); null if unreadable. lstat only. */
	async #newestMtime(dir: string): Promise<number | null> {
		try {
			let newest = (await lstat(dir)).mtimeMs;
			const go = async (d: string, depth: number): Promise<void> => {
				for (const e of await readdir(d, { withFileTypes: true })) {
					const f = join(d, e.name);
					const m = (await lstat(f)).mtimeMs;
					if (m > newest) newest = m;
					if (e.isDirectory() && depth < MAX_DEPTH) await go(f, depth + 1);
				}
			};
			await go(dir, 0);
			return newest;
		} catch {
			return null;
		}
	}

	// ───────────── interrupted runs ─────────────
	/** Startup: sandbox runs still 'running' belong to a process that no longer exists. Mark them 'unknown' (never re-run). Call once, before accepting runs. */
	reconcileInterruptedRuns(): { count: number; runIds: string[] } {
		const db = this.#ctx.db;
		if (!db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'tool_sandbox_runs'")) return { count: 0, runIds: [] };
		const rows = db.all<{ id: string; space_id: string; stderr: string }>("SELECT id, space_id, stderr FROM tool_sandbox_runs WHERE status = 'running'");
		const at = nowIso();
		const identity = this.#ctx.services.has("identity") ? this.#ctx.services.get("identity") : undefined;
		db.tx(() => {
			for (const r of rows) {
				db.run("UPDATE tool_sandbox_runs SET status = 'unknown', stderr = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ? AND status = 'running'", r.stderr ? `${r.stderr}\n${RUN_RECONCILED_NOTE}` : RUN_RECONCILED_NOTE, at, r.id);
				db.run("INSERT OR IGNORE INTO workspace_run_reconciliations (run_id, org_id, space_id, previous_status, note, reconciled_at) VALUES (?, ?, ?, 'running', ?, ?)", r.id, identity?.space(r.space_id)?.orgId ?? "", r.space_id, RUN_RECONCILED_NOTE, at);
			}
		});
		return { count: rows.length, runIds: rows.map((r) => r.id) };
	}
	/** Runs reconciled as unknown in a space (read-only; the caller checks space access). */
	interruptedRuns(spaceId: string): { runId: string; reconciledAt: string; note: string }[] {
		return this.#ctx.db.all<{ run_id: string; reconciled_at: string; note: string }>("SELECT run_id, reconciled_at, note FROM workspace_run_reconciliations WHERE space_id = ? ORDER BY reconciled_at DESC LIMIT 200", spaceId).map((r) => ({ runId: r.run_id, reconciledAt: r.reconciled_at, note: r.note }));
	}
}
