// Cloud execution sandbox (M11, round 4: pluggable drivers). Per-space, per-conversation working directories (/work, persistent);
// shell / Python / Node run through a driver chosen by the admin setting or auto-detection:
//   namespaces — Linux user/mount/pid/net namespaces (no daemon)   docker — Docker CLI (Windows/macOS/Linux)   none — says how to enable one
// This service owns policy (ACL is the caller's, quota, run records, concurrency, mounts, services, retention); drivers only isolate.
// If no driver can isolate, execution is refused (never run unisolated).
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppContext, Principal, Space } from "../core/contracts.ts";
import type { Migration } from "../core/db.ts";
import { HttpError, newId, nowIso } from "../core/http.ts";
import type { SandboxEntryDTO, SandboxLimitsDTO, SandboxRunDTO } from "../../../shared/files.ts";
import type { SandboxInfoDTO, WorkspaceFilesResponse, WorkspacePreviewDTO, WorkspaceUsageDTO } from "../../../shared/sandbox.ts";
import { normalizeTarget, type DriverId, type LocalDriverId, type DriverStatus, type Language, type ProcessRef, type RunResult, type SandboxDriver, type SandboxMount, type ServiceRuntime } from "./sandbox/driver.ts";
import { killStaleNamespaces, NAMESPACES_NOTES, probeNamespaces } from "./sandbox/namespaces.ts";
import { SandboxDrivers } from "./sandbox/registry.ts";
import { RemoteDriver, RemoteDrivers, remoteNotes } from "./sandbox/remote-driver.ts";
import { workspaceKeyOf, workspacePersistenceFor } from "./sandbox/persist.ts";
import { mergeSandboxEnv, sandboxEnvFor } from "./sandbox/env-vars.ts";
import { credentialsFor } from "./credentials/store.ts";
import { UnsupportedError } from "./sandbox/provider.ts";
import { SandboxService, type SandboxServiceInfo } from "./sandbox/services.ts";
import * as ws from "./sandbox/workspace.ts";
import { requirePermission } from "./sandbox/perm.ts";

export type { Language, RunResult, SandboxMount, SandboxService };
export { SandboxDrivers };

export const SANDBOX_MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "sandbox runs",
		sql: `
CREATE TABLE tool_sandbox_runs (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  conversation_id INTEGER,
  task_id INTEGER,
  call_id TEXT,
  user_id TEXT NOT NULL,
  language TEXT NOT NULL,
  code TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER,
  limits TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (space_id, task_id, call_id)
);
CREATE INDEX tool_sandbox_runs_conv ON tool_sandbox_runs(space_id, conversation_id, started_at);
`,
	},
	{
		version: 2,
		name: "sandbox driver settings",
		sql: `
CREATE TABLE tool_sandbox_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL);
ALTER TABLE tool_sandbox_runs ADD COLUMN driver TEXT;
`,
	},
	{
		// round 7: remote sandbox instances (one per org/space/workspace/provider). The workspace on the host stays authoritative;
		// `manifest` = path → sha256 of what the remote /work held at the last sync (directories: "dir/" → "dir").
		version: 3,
		name: "remote sandbox instances",
		sql: `
CREATE TABLE tool_sandbox_instances (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  space_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  remote_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('creating','ready','stopping','destroyed','lost','error')),
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT,
  last_error TEXT,
  org_id TEXT NOT NULL DEFAULT '',
  manifest TEXT NOT NULL DEFAULT '{}',
  network INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX tool_sandbox_instances_live ON tool_sandbox_instances(org_id, space_id, workspace_key, provider) WHERE state IN ('creating','ready','stopping');
CREATE INDEX tool_sandbox_instances_org ON tool_sandbox_instances(org_id, last_used_at);
`,
	},
];

export const DEFAULT_LIMITS: SandboxLimitsDTO = {
	timeoutMs: 30_000,
	memoryBytes: 512 * 1024 * 1024,
	cpuSeconds: 30,
	maxFileBytes: 64 * 1024 * 1024,
	maxProcesses: 64,
	network: false,
};
export const MAX_TIMEOUT_MS = 300_000;
/** Background jobs (M14-C) may run longer, within their declared budget. */
export const JOB_MAX_TIMEOUT_MS = Number(process.env.WORKROOM_JOB_MAX_TIMEOUT_MS ?? 3_600_000);
export const RETENTION_HOURS = Number(process.env.WORKROOM_SANDBOX_RETENTION_HOURS ?? 72);
/** Soft quota per space, read at call time so deployments (and tests) can change it without a restart. */
export const quotaBytes = () => Number(process.env.WORKROOM_SANDBOX_QUOTA_MB ?? 512) * 1024 * 1024;
export const QUOTA_BYTES = quotaBytes();

export const isolationText = (n: { isolates: readonly string[]; doesNotIsolate: readonly string[] }) => `${n.isolates.join("；")}。未隔离/限制：${n.doesNotIsolate.join("；")}。`;
/** Namespace-driver description (kept for callers that predate drivers; prefer `Sandbox.isolationFor`). */
export const ISOLATION_TEXT = isolationText(NAMESPACES_NOTES);

/** Whether this host can build the namespace sandbox (cached, synchronous). Docker is probed asynchronously through `Sandbox.drivers`. */
export function probeIsolation(): { ok: boolean; detail: string } {
	return probeNamespaces();
}
/** Kill a namespace sandbox process group left behind by a previous process (crash/restart), if it is still ours. */
export function killStaleSandbox(pid: number | null | undefined): boolean {
	return killStaleNamespaces(pid);
}

class Semaphore {
	#free: number;
	#capacity: number;
	readonly #q: (() => void)[] = [];
	constructor(n: number) {
		this.#free = this.#capacity = n;
	}
	resize(n: number) {
		this.#free += n - this.#capacity;
		this.#capacity = n;
		while (this.#free > 0 && this.#q.length) (this.#free--, this.#q.shift()!());
	}
	async acquire(): Promise<() => void> {
		if (this.#free > 0) this.#free--;
		else await new Promise<void>((r) => this.#q.push(r));
		let done = false;
		return () => {
			if (done) return;
			done = true;
			if (this.#q.length && this.#free >= 0) this.#q.shift()!();
			else this.#free++;
		};
	}
}

export interface MountContext {
	principal: Principal;
	space: Space;
	conversationId?: number;
	/** Providers may push human-readable notices (e.g. "N skills were not mounted"); a run appends them to its stderr so nothing is dropped silently. */
	notes?: string[];
}
export type MountProvider = (c: MountContext) => readonly SandboxMount[] | Promise<readonly SandboxMount[]>;

export interface RunInput {
	principal: Principal;
	space: Space;
	conversationId?: number;
	taskId?: number;
	callId?: string;
	language: Language;
	code: string;
	timeoutMs?: number;
	network?: boolean;
	signal?: AbortSignal;
	maxTimeoutMs?: number;
	cpuSeconds?: number;
	onSpawn?: (pid: number) => void;
	mounts?: readonly SandboxMount[];
	env?: Readonly<Record<string, string>>;
}

export interface StartServiceInput {
	principal: Principal;
	space: Space;
	conversationId?: number;
	runtime: ServiceRuntime;
	argv: readonly string[];
	cwd?: string;
	env?: Readonly<Record<string, string>>;
	mounts?: readonly SandboxMount[];
	network?: boolean;
	idleTimeoutMs?: number;
	maxLifetimeMs?: number;
	limits?: Partial<Pick<SandboxLimitsDTO, "memoryBytes" | "cpuSeconds" | "maxProcesses" | "maxFileBytes">>;
}

export interface SandboxCapabilities {
	driver: DriverId;
	state: "ready" | "needs_setup" | "unavailable";
	label: string;
	detail: string;
	network: { supported: boolean; allowed: boolean };
	services: boolean;
	mounts: boolean;
	runtimes: ServiceRuntime[];
}

export class Sandbox {
	readonly #ctx: AppContext;
	readonly drivers: SandboxDrivers;
	#timer: NodeJS.Timeout | undefined;
	#slots: Semaphore;
	readonly #providers = new Map<string, MountProvider>();
	readonly #roots = new Set<string>();
	/** Round 7: remote providers (OpenSandbox/E2B/Daytona) selected per space by the provider-config policy. */
	readonly remote: RemoteDrivers;
	readonly #services = new Map<string, SandboxService>();
	readonly #starting = new Map<string, Promise<SandboxService>>();
	#reaped: Promise<void> = Promise.resolve();
	#stopped = false;

	constructor(ctx: AppContext, opts: { drivers?: SandboxDrivers } = {}) {
		this.#ctx = ctx;
		this.drivers = opts.drivers ?? new SandboxDrivers(ctx);
		this.#slots = new Semaphore(this.drivers.settings().maxConcurrent);
		this.remote = new RemoteDrivers(ctx);
	}

	// ---------- paths ----------
	root(space: Space): string {
		return join(space.dir, "sandbox");
	}
	workdir(space: Space, conversationId: number | undefined): string {
		const d = join(this.root(space), conversationId === undefined ? "shared" : `c${conversationId}`);
		mkdirSync(d, { recursive: true });
		return d;
	}
	/** Resolve a path inside a workdir; refuses escapes (.., absolute, drive letters, symlinks pointing outside). */
	resolveIn(workdir: string, rel: string): string {
		return ws.resolveIn(workdir, rel).abs;
	}

	// ---------- drivers ----------
	async #driver(): Promise<SandboxDriver> {
		const r = await this.drivers.resolve();
		if (r.effective === "none") await r.driver.run({} as never); // throws the 503 with the reason and how to enable
		return r.driver;
	}
	/** The driver for a space: a remote provider when the org/project policy selects one (no fallback: unusable → 503), else the local driver. */
	async #driverFor(space: Space): Promise<SandboxDriver> {
		const remote = await this.remote.forSpace(space);
		return remote ?? (await this.#driver());
	}
	isolationFor(id: DriverId): string {
		if (id === "opensandbox" || id === "e2b" || id === "daytona") return isolationText(this.remote.notesFor(id));
		const d = id === "docker" ? this.drivers.docker : id === "namespaces" ? NAMESPACES_NOTES : undefined;
		return d ? isolationText("notes" in d ? d.notes : d) : "沙箱未启用";
	}

	async capabilities(): Promise<SandboxCapabilities> {
		const r = await this.drivers.resolve();
		const st = r.effective === "none" ? await r.driver.detect() : r.statuses[r.effective];
		const net = this.drivers.settings().network === "allowed";
		return {
			driver: r.effective,
			state: r.effective === "none" ? "unavailable" : st.state,
			label: r.driver.label,
			detail: r.reason,
			network: { supported: r.driver.capabilities.network, allowed: net && r.driver.capabilities.network },
			services: r.driver.capabilities.services,
			mounts: r.driver.capabilities.mounts,
			runtimes: r.effective === "none" ? [] : ["shell", "python", "node"],
		};
	}

	async info(space: Space): Promise<SandboxInfoDTO> {
		const rd = await this.remote.forSpace(space).catch((e: Error) => e);
		if (rd) {
			// A remote provider is selected for this space: report it honestly (an unusable provider is "unavailable", never the local driver).
			const net = this.drivers.settings().network;
			const st = rd instanceof Error ? undefined : await rd.detect();
			const id = rd instanceof Error ? "none" : rd.id;
			const ok = st?.state === "ready";
			return {
				spaceId: space.id,
				isolation: (ok ? id : "unavailable") as SandboxInfoDTO["isolation"],
				isolationDetail: rd instanceof Error ? rd.message : `${rd.label}：${isolationText(rd.notes)}`,
				driver: { id: id as DriverId as SandboxInfoDTO["driver"]["id"], label: rd instanceof Error ? "远端沙箱" : rd.label, state: ok ? "ready" : "unavailable", summary: rd instanceof Error ? rd.message : st!.summary, network: net },
				limits: { ...DEFAULT_LIMITS, network: ok && net === "allowed" && !(rd instanceof Error) && rd.capabilities.network },
				retentionHours: RETENTION_HOURS,
				usedBytes: ws.dirSize(this.root(space)).bytes,
				quotaBytes: quotaBytes(),
			};
		}
		const r = await this.drivers.resolve();
		const st: DriverStatus = r.effective === "none" ? await r.driver.detect() : r.statuses[r.effective];
		const ok = r.effective !== "none";
		const net = this.drivers.settings().network;
		return {
			spaceId: space.id,
			isolation: ok ? (r.effective as "namespaces" | "docker") : "unavailable",
			isolationDetail: ok ? `${r.driver.label}：${isolationText(r.driver.notes)}` : r.reason,
			driver: { id: r.effective, label: r.driver.label, state: ok ? st.state : "unavailable", summary: ok ? st.summary : r.reason, howToEnable: ok ? undefined : st.howToEnable, network: net },
			limits: { ...DEFAULT_LIMITS, network: ok && net === "allowed" && r.driver.capabilities.network },
			retentionHours: RETENTION_HOURS,
			usedBytes: ws.dirSize(this.root(space)).bytes,
			quotaBytes: quotaBytes(),
		};
	}

	// ---------- mounts ----------
	/** Root below which skills / MCP packages may be materialised for read-only mounting: `<dataDir>/sandbox-mounts`. */
	mountsRoot(): string {
		const d = join(this.#ctx.config.dataDir, "sandbox-mounts");
		mkdirSync(d, { recursive: true });
		return d;
	}
	/** Allow another host directory tree as a mount source (call once at init). Mounts must be strictly below a registered root. */
	registerMountRoot(dir: string): void {
		mkdirSync(dir, { recursive: true });
		this.#roots.add(realpathSync.native(dir));
	}
	/** Register a function that contributes mounts to every run/service of a conversation. Returns an unregister function. */
	addMountProvider(name: string, fn: MountProvider): () => void {
		this.#providers.set(name, fn);
		return () => void this.#providers.delete(name);
	}

	async #collectMounts(c: MountContext, extra: readonly SandboxMount[] = []): Promise<SandboxMount[]> {
		const all: SandboxMount[] = [...extra];
		for (const [name, fn] of this.#providers) {
			try {
				all.push(...(await fn(c)));
			} catch (e) {
				console.error(`[sandbox] mount provider ${name} failed`, e);
			}
		}
		const roots = [realpathSync.native(this.mountsRoot()), ...this.#roots];
		const workRoot = existsSync(this.root(c.space)) ? realpathSync.native(this.root(c.space)) : undefined;
		const seen = new Set<string>();
		const out: SandboxMount[] = [];
		for (const m of all) {
			let target: string;
			try {
				target = normalizeTarget(m.target);
			} catch (e: any) {
				throw new HttpError(400, "bad_mount", e.message);
			}
			if (seen.has(target)) throw new HttpError(400, "bad_mount", `重复的挂载点 ${target}`);
			seen.add(target);
			if (!resolve(m.hostPath) || !existsSync(m.hostPath)) throw new HttpError(400, "bad_mount", `挂载源不存在：${m.hostPath}`);
			const real = realpathSync.native(m.hostPath);
			if (/[\t\r\n\0"]/.test(real)) throw new HttpError(400, "bad_mount", "挂载源路径含有非法字符");
			const under = (root: string) => ws.isInside(root, real) && real.length > root.length;
			const inRoot = roots.some(under);
			const inWork = !!workRoot && under(workRoot);
			if (!inRoot && !(inWork && !m.readOnly)) throw new HttpError(400, "bad_mount", `挂载源 ${m.hostPath} 不在允许的目录（${this.mountsRoot()}）内`);
			if (!m.readOnly && !inWork) throw new HttpError(400, "bad_mount", "只有会话自己的工作区可以读写挂载；其余挂载必须 readOnly");
			out.push({ hostPath: real, target, readOnly: m.readOnly });
		}
		return out;
	}

	async #networkAllowed(driver: SandboxDriver, want: boolean | undefined, p?: Principal): Promise<boolean> {
		if (!want) return false;
		if (p) await requirePermission(this.#ctx, p, "sandbox.network");
		if (this.drivers.settings().network !== "allowed") throw new HttpError(403, "network_disabled", "沙箱默认不允许联网；管理员未开启“允许沙箱联网”");
		if (!driver.capabilities.network) throw new HttpError(403, "network_unsupported", `当前沙箱驱动（${driver.label}）无法提供网络；请使用 Docker 驱动`);
		return true;
	}

	// ---------- run ----------
	/** Execute code in the sandbox. Records a run row (idempotent per tool call). */
	async run(input: RunInput): Promise<SandboxRunDTO> {
		if (!["shell", "python", "node"].includes(input.language)) throw new HttpError(400, "bad_language", "language 必须是 shell、python 或 node");
		const driver = await this.#driverFor(input.space);
		const network = await this.#networkAllowed(driver, input.network, input.principal);
		const timeoutMs = Math.min(Math.max(input.timeoutMs ?? DEFAULT_LIMITS.timeoutMs, 1000), input.maxTimeoutMs ?? MAX_TIMEOUT_MS);
		const cpuSeconds = Math.max(1, Math.min(input.cpuSeconds ?? Math.ceil(timeoutMs / 1000), Math.ceil(timeoutMs / 1000)));
		const limits: SandboxLimitsDTO = { ...DEFAULT_LIMITS, timeoutMs, cpuSeconds, network };
		// Round 7b: the working copy is restored from its last saved version when it is missing (sandbox/host copy expired); never overwrites.
		const persist = workspacePersistenceFor(this.#ctx);
		const wsKey = workspaceKeyOf(input.conversationId);
		const ready = await persist.ensureReady(input.principal, input.space, wsKey);
		if ((ready.state === "failed" || ready.state === "conflict") && !existsSync(join(this.root(input.space), input.conversationId === undefined ? "shared" : `c${input.conversationId}`)))
			throw new HttpError(409, "workspace_not_restored", `工作区未能恢复，已停止运行以免在空目录上工作：${ready.failure ?? ready.state}`);
		const wd = this.workdir(input.space, input.conversationId);
		const used = ws.dirSize(this.root(input.space)).bytes;
		if (used > quotaBytes()) throw new HttpError(507, "sandbox_quota", `工作目录已用 ${Math.round(used / 1048576)} MB，超过配额 ${Math.round(quotaBytes() / 1048576)} MB；请先发布需要的文件并清理`);
		const mountNotes: string[] = [];
		const mounts = await this.#collectMounts({ principal: input.principal, space: input.space, conversationId: input.conversationId, notes: mountNotes }, input.mounts);
		await this.#reaped;
		// Environment: ordinary variables (org < project < user < conversation, locked org vars win) under the platform/caller variables;
		// credentials consented for env use in THIS conversation are added for this run only and never recorded.
		const { env: userEnv } = sandboxEnvFor(this.#ctx).resolve(input.principal, input.space, input.conversationId);
		const cred = input.conversationId === undefined ? { env: {} as Record<string, string>, names: [] as string[], cleanup: () => {} } : await credentialsFor(this.#ctx).envFor(input.principal, input.space, input.conversationId);
		if (cred.names.length && driver instanceof RemoteDriver) {
			cred.cleanup();
			throw new UnsupportedError(driver.label, `把凭据注入远端沙箱进程环境（${cred.names.join("、")}）；该提供方未验证不会持久化进程环境，已拒绝。请改用“经服务器代为调用”的方式使用凭据`);
		}
		const env = { ...mergeSandboxEnv(userEnv, input.env ?? {}), ...cred.env };
		const id = newId("run");
		const started = Date.now();
		this.#ctx.db.run(
			"INSERT INTO tool_sandbox_runs (id, space_id, conversation_id, task_id, call_id, user_id, language, code, status, limits, started_at, driver) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)",
			id, input.space.id, input.conversationId ?? null, input.taskId ?? null, input.callId ?? null, input.principal.userId, input.language, input.code.slice(0, 200_000), JSON.stringify(limits), nowIso(), driver.id,
		);
		let r: RunResult;
		const release = await this.#slots.acquire();
		try {
			r = await driver.run({ runId: id, tenant: { orgId: input.space.orgId, spaceId: input.space.id, workspaceKey: wsKey }, scratchBase: this.root(input.space), workdir: wd, exec: { language: input.language, code: input.code }, limits, mounts, env, network, signal: input.signal, onSpawn: (ref: ProcessRef) => ref.pid && input.onSpawn?.(ref.pid) });
		} catch (e: any) {
			this.#ctx.db.run("UPDATE tool_sandbox_runs SET status = 'error', stderr = ?, duration_ms = ?, finished_at = ? WHERE id = ?", String(e?.message ?? e).slice(0, 4000), Date.now() - started, nowIso(), id);
			throw e;
		} finally {
			release();
			cred.cleanup();
			// Save point: after every run (also failed/timed-out ones), after the remote sync-back. Failures are recorded in the workspace status, never thrown.
			await persist.commit(input.principal, input.space, wsKey, "run_end").catch((e) => console.error("[sandbox] workspace commit failed", e));
		}
		if (cred.names.length) r = { ...r, stderr: `${r.stderr ? `${r.stderr}\n` : ""}[凭据] 本次运行注入了环境变量：${cred.names.join("、")}（进程及其子进程可读取）` };
		if (mountNotes.length) r = { ...r, stderr: `${r.stderr ? `${r.stderr}\n` : ""}${mountNotes.join("\n")}` };
		this.#ctx.db.run("UPDATE tool_sandbox_runs SET status = ?, exit_code = ?, stdout = ?, stderr = ?, duration_ms = ?, finished_at = ? WHERE id = ?", r.status, r.exitCode, r.stdout, r.stderr, Date.now() - started, nowIso(), id);
		return this.runDTO(id)!;
	}

	/**
	 * Run code isolated in an arbitrary working directory (server-internal jobs such as rendering untrusted documents).
	 * Same driver and limits; no run record. `hostTools: true` means the command needs programs installed on the host (e.g. LibreOffice):
	 * only the namespace driver provides them, so other drivers refuse.
	 */
	async execIsolated(workdir: string, language: Language, code: string, limits: Partial<SandboxLimitsDTO> = {}, opts: { hostTools?: boolean } = {}): Promise<RunResult> {
		const r = await this.drivers.resolve();
		let driver: SandboxDriver;
		if (opts.hostTools) {
			if (r.statuses.namespaces.state !== "ready") throw new HttpError(503, "sandbox_unavailable", `该任务需要宿主机上的程序，只有命名空间驱动能提供（${r.statuses.namespaces.summary}）`);
			driver = this.drivers.namespaces;
		} else driver = await this.#driver();
		mkdirSync(workdir, { recursive: true });
		const timeoutMs = limits.timeoutMs ?? DEFAULT_LIMITS.timeoutMs;
		const lim: SandboxLimitsDTO = { ...DEFAULT_LIMITS, cpuSeconds: Math.ceil(timeoutMs / 1000), ...limits, timeoutMs, network: false };
		await this.#reaped;
		const release = await this.#slots.acquire();
		try {
			return await driver.run({ runId: newId("iso"), scratchBase: join(workdir, ".."), workdir, exec: { language, code }, limits: lim, mounts: [], env: {}, network: false });
		} finally {
			release();
		}
	}

	// ---------- services ----------
	async startService(input: StartServiceInput & { key?: string }): Promise<SandboxService> {
		const driver = await this.#driverFor(input.space);
		if (!driver.capabilities.services && !(["opensandbox", "e2b", "daytona"] as string[]).includes(driver.id)) throw new HttpError(503, "sandbox_unavailable", `当前沙箱驱动（${driver.label}）不支持常驻服务`);
		if (!driver.capabilities.services) throw new UnsupportedError(driver.label, "常驻服务（MCP stdio 等）");
		await this.#ctx.services.get("acl").require(input.principal, "write", { kind: "space", id: input.space.id });
		if (!Array.isArray(input.argv) || !input.argv.length || input.argv.some((a) => typeof a !== "string" || a.includes("\0"))) throw new HttpError(400, "invalid", "argv 必须是非空字符串数组");
		if (!["node", "python", "shell"].includes(input.runtime)) throw new HttpError(400, "invalid", "runtime 必须是 node、python 或 shell");
		const maxServices = Number(process.env.WORKROOM_SANDBOX_MAX_SERVICES ?? 16);
		if ([...this.#services.values()].filter((s) => s.running).length >= maxServices) throw new HttpError(429, "too_many_services", `常驻沙箱服务已达上限 ${maxServices}`);
		const network = await this.#networkAllowed(driver, input.network, input.principal);
		const mounts = await this.#collectMounts(input, input.mounts);
		await this.#reaped;
		const id = newId("svc");
		const idleTimeoutMs = Math.max(1000, input.idleTimeoutMs ?? 15 * 60_000);
		const maxLifetimeMs = Math.max(1000, input.maxLifetimeMs ?? 3600_000);
		const limits: SandboxLimitsDTO = { ...DEFAULT_LIMITS, cpuSeconds: 4 * 3600, timeoutMs: maxLifetimeMs, ...input.limits, network };
		const wd = this.workdir(input.space, input.conversationId);
		// Ordinary sandbox env vars apply when a service starts (running services keep theirs); the service's own env (connector config) wins.
		input = { ...input, env: mergeSandboxEnv(sandboxEnvFor(this.#ctx).resolve(input.principal, input.space, input.conversationId).env, input.env ?? {}) };
		const proc = await driver.startService({ serviceId: id, scratchBase: this.root(input.space), workdir: wd, argv: input.argv, runtime: input.runtime, cwd: input.cwd, limits, mounts, env: input.env ?? {}, network });
		const key = input.key ?? id;
		const svc = new SandboxService({ key, id, spaceId: input.space.id, conversationId: input.conversationId, runtime: input.runtime, driver: driver.id, proc, idleTimeoutMs, maxLifetimeMs, onGone: (s) => this.#services.get(`${s.spaceId}:${s.key}`) === s && this.#services.delete(`${s.spaceId}:${s.key}`) });
		this.#services.set(`${input.space.id}:${key}`, svc);
		return svc;
	}
	/** Same key → the running service is reused (start once per conversation/connector). */
	async acquireService(key: string, input: StartServiceInput): Promise<SandboxService> {
		const k = `${input.space.id}:${key}`;
		const cur = this.#services.get(k);
		if (cur?.running) return cur;
		let p = this.#starting.get(k);
		if (!p) {
			p = this.startService({ ...input, key }).finally(() => this.#starting.delete(k));
			this.#starting.set(k, p);
		}
		return p;
	}
	listServices(): SandboxServiceInfo[] {
		return [...this.#services.values()].map((s) => s.info());
	}
	async stopServices(filter: (s: SandboxServiceInfo) => boolean = () => true): Promise<number> {
		const victims = [...this.#services.values()].filter((s) => filter(s.info()));
		await Promise.all(victims.map((s) => s.stop()));
		return victims.length;
	}

	// ---------- records ----------
	runDTO(id: string): SandboxRunDTO | null {
		const r = this.#ctx.db.get<any>("SELECT * FROM tool_sandbox_runs WHERE id = ?", id);
		if (!r) return null;
		return {
			id: r.id,
			spaceId: r.space_id,
			conversationId: r.conversation_id ?? undefined,
			taskId: r.task_id ?? undefined,
			callId: r.call_id ?? undefined,
			userId: r.user_id,
			language: r.language,
			code: r.code,
			status: r.status,
			exitCode: r.exit_code ?? undefined,
			stdout: r.stdout,
			stderr: r.stderr,
			durationMs: r.duration_ms ?? undefined,
			startedAt: r.started_at,
			finishedAt: r.finished_at ?? undefined,
			limits: JSON.parse(r.limits),
			isolation: this.isolationFor((r.driver ?? "namespaces") as DriverId),
			driver: r.driver ?? "namespaces",
		} as SandboxRunDTO;
	}
	runByCall(spaceId: string, taskId: number, callId: string): SandboxRunDTO | null {
		const r = this.#ctx.db.get<{ id: string }>("SELECT id FROM tool_sandbox_runs WHERE space_id = ? AND task_id = ? AND call_id = ?", spaceId, taskId, callId);
		return r ? this.runDTO(r.id) : null;
	}
	runs(spaceId: string, conversationId?: number, limit = 50): SandboxRunDTO[] {
		const rows = conversationId === undefined
			? this.#ctx.db.all<{ id: string }>("SELECT id FROM tool_sandbox_runs WHERE space_id = ? ORDER BY started_at DESC LIMIT ?", spaceId, limit)
			: this.#ctx.db.all<{ id: string }>("SELECT id FROM tool_sandbox_runs WHERE space_id = ? AND conversation_id = ? ORDER BY started_at DESC LIMIT ?", spaceId, conversationId, limit);
		return rows.map((r) => this.runDTO(r.id)!);
	}

	// ---------- workspace file API ----------
	#owner() {
		return this.drivers.current()?.effective === "docker" ? this.drivers.docker.workspaceOwner() : undefined;
	}
	usage(space: Space, conversationId: number | undefined): WorkspaceUsageDTO {
		const conv = ws.dirSize(this.workdir(space, conversationId));
		return { conversationBytes: conv.bytes, spaceBytes: ws.dirSize(this.root(space)).bytes, quotaBytes: quotaBytes(), maxFileBytes: DEFAULT_LIMITS.maxFileBytes, retentionHours: RETENTION_HOURS, fileCount: conv.files };
	}
	workspace(space: Space, conversationId: number | undefined): Omit<WorkspaceFilesResponse, "canWrite"> {
		const { entries, truncated } = ws.listEntries(this.workdir(space, conversationId), RETENTION_HOURS);
		return { entries, truncated, usage: this.usage(space, conversationId) };
	}
	entries(space: Space, conversationId: number | undefined): SandboxEntryDTO[] {
		return ws.listEntries(this.workdir(space, conversationId), RETENTION_HOURS).entries;
	}
	preview(space: Space, conversationId: number | undefined, path: string): WorkspacePreviewDTO {
		return ws.preview(this.workdir(space, conversationId), path, RETENTION_HOURS);
	}
	readFile(space: Space, conversationId: number | undefined, path: string): { bytes: Uint8Array; name: string } {
		const f = ws.readBytes(this.workdir(space, conversationId), path, 100 * 1024 * 1024);
		return { bytes: f.bytes, name: f.name };
	}
	#checkQuota(space: Space, incoming: number, replacing = 0): void {
		if (incoming > DEFAULT_LIMITS.maxFileBytes) throw new HttpError(413, "too_large", `单个文件不能超过 ${Math.round(DEFAULT_LIMITS.maxFileBytes / 1048576)} MB`);
		const used = ws.dirSize(this.root(space)).bytes;
		if (used - replacing + incoming > quotaBytes()) throw new HttpError(507, "sandbox_quota", `工作目录配额不足：已用 ${Math.round(used / 1048576)} MB，配额 ${Math.round(quotaBytes() / 1048576)} MB；请先发布需要的文件并删除不需要的文件`);
	}
	writeFile(space: Space, conversationId: number | undefined, path: string, bytes: Uint8Array): string {
		const wd = this.workdir(space, conversationId);
		this.#checkQuota(space, bytes.length, ws.existingSize(wd, path));
		return ws.writeBytes(wd, path, bytes, this.#owner());
	}
	mkdir(space: Space, conversationId: number | undefined, path: string): string {
		const wd = this.workdir(space, conversationId);
		const { rel } = ws.resolveIn(wd, path);
		if (!rel) throw new HttpError(400, "bad_path", "需要目录路径");
		ws.mkdirp(wd, rel, this.#owner());
		return rel;
	}
	remove(space: Space, conversationId: number | undefined, path: string) {
		return ws.remove(this.workdir(space, conversationId), path);
	}
	move(space: Space, conversationId: number | undefined, from: string, to: string) {
		return ws.move(this.workdir(space, conversationId), from, to);
	}

	/** Re-read settings that live outside the drivers (concurrency). */
	applySettings(): void {
		this.#slots.resize(this.drivers.settings().maxConcurrent);
	}

	// ---------- lifecycle ----------
	/** Lifecycle: delete workspace files idle longer than the retention period (published files live on in the library). */
	/**
	 * Lifecycle (round 7b): remove whole working copies idle past the org's retention, ONLY when they are saved (working copy == head
	 * version). Dirty / failed / conflicting / never-saved copies are kept — the old per-file sweep could delete the only copy.
	 * Returns how many working copies were removed.
	 */
	async reap(now = Date.now()): Promise<number> {
		return (await workspacePersistenceFor(this.#ctx).reapWorkingCopies(now)).removed.length;
	}


	/** Kill what a previous process left behind (job recovery): namespace process group by pid, docker container by name. */
	async killStale(ref: ProcessRef): Promise<boolean> {
		if (ref.driver !== "docker" && ref.driver !== "namespaces") return false; // remote sandboxes are reaped by label (RemoteDrivers.reapAll)
		return ref.driver === "docker" ? this.drivers.docker.killStale(ref) : killStaleNamespaces(ref.pid);
	}

	start(): void {
		this.#stopped = false;
		this.#timer = setInterval(() => {
			void this.reap().catch((e) => console.error("[sandbox] reap failed", e));
		}, 3600_000);
		this.#timer.unref();
		this.remote.start();
		// Orphaned containers of a previous server process are removed before the first run starts (bounded wait: a wedged daemon must not block runs).
		const reap = (async () => {
			const st = await this.drivers.docker.detect();
			if (st.state !== "unavailable") {
				const n = await this.drivers.docker.reapStale();
				if (n) console.log(`[sandbox] removed ${n} orphaned container(s)`);
			}
		})().catch(() => {});
		this.#reaped = Promise.race([reap, new Promise<void>((r) => setTimeout(r, 4000).unref())]);
		// Remote sandboxes: idle/expired instances and labelled orphans of a previous process (never blocks runs; errors are logged).
		void this.remote.reapAll(true).then((n) => n && console.log(`[sandbox] removed ${n} remote sandbox(es) (idle/orphaned)`)).catch(() => {});
	}
	async stop(): Promise<void> {
		this.#stopped = true;
		clearInterval(this.#timer);
		await Promise.all([...this.#services.values()].map((s) => s.stopFor("shutdown").catch(() => {})));
		await this.remote.stop().catch(() => {});
		await this.drivers.docker.shutdown().catch(() => {});
	}
}
