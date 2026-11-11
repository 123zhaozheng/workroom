// Daytona provider (official `@daytonaio/sdk`, exact version pinned in optionalDependencies, loaded lazily).
//
// Status: IMPLEMENTED, NOT CONNECTED (no Daytona key existed when this was written) — every capability is "unverified".
//
// Product status that matters to admins (see docs/research/sandbox-providers.md): the open-source daytonaio/daytona repository was
// archived on 2026-10-03 and its README states that core development moved to a private codebase in June 2026. Daytona is therefore
// treated here as a VENDOR-CLOUD service reached through its SDK; `endpoint` (API URL) exists for Daytona's own enterprise/regional
// deployments and is NOT a claim that a maintained self-hostable open-source Daytona exists.
import { UnsupportedError } from "../provider.ts";
import type {
	CreateOptions, ExecOptions, ExecResult, ProviderCapabilities, ProviderConnection, ProviderHealth, RemoteEntry,
	RemoteProvider, RemoteSandboxInfo, RemoteSession,
} from "../provider.ts";

export const DAYTONA_SDK_PACKAGE = "@daytonaio/sdk";
export const DAYTONA_SDK_VERSION = "0.231.1";
const ID = "daytona";

// ---- Minimal structural view of the SDK surface we use. ----
interface DaytonaSandbox {
	id: string;
	state?: string;
	labels?: Record<string, string>;
	createdAt?: string;
	process: {
		createSession(id: string): Promise<void>;
		executeSessionCommand(sessionId: string, req: { command: string; runAsync?: boolean }, timeoutSec?: number): Promise<{ cmdId?: string }>;
		getSessionCommand(sessionId: string, commandId: string): Promise<{ exitCode?: number }>;
		getSessionCommandLogs(sessionId: string, commandId: string, onStdout: (c: string) => void, onStderr: (c: string) => void): Promise<void>;
		deleteSession(sessionId: string): Promise<void>;
		executeCommand(command: string, cwd?: string, env?: Record<string, string>, timeoutSec?: number): Promise<{ exitCode: number; result: string }>;
	};
	fs: {
		uploadFile(file: Buffer, remotePath: string, timeoutSec?: number): Promise<void>;
		downloadFile(remotePath: string, timeoutSec?: number): Promise<Buffer>;
		deleteFile(path: string, recursive?: boolean): Promise<void>;
		createFolder(path: string, mode: string): Promise<void>;
	};
	start(timeoutSec?: number): Promise<void>;
	refreshActivity(): Promise<void>;
	setAutostopInterval(minutes: number): Promise<void>;
}
interface DaytonaClient {
	create(params: Record<string, unknown>, options?: { timeout?: number }): Promise<DaytonaSandbox>;
	get(idOrName: string): Promise<DaytonaSandbox>;
	list(query?: Record<string, unknown>): AsyncIterableIterator<DaytonaSandbox>;
	delete(sandbox: DaytonaSandbox, timeoutSec?: number): Promise<void>;
}
export interface DaytonaModule {
	Daytona: new (config: Record<string, unknown>) => DaytonaClient;
}
export interface DaytonaProviderDeps {
	/** Test seam. Defaults to a lazy `import("@daytonaio/sdk")`. */
	readonly loadSdk?: () => Promise<DaytonaModule>;
}

export const DAYTONA_CAPABILITIES: ProviderCapabilities = {
	exec: "unverified",
	streamOutput: "unverified",
	cancel: "unverified",
	// Enforced by us (client deadline + session delete); the remote side has no per-command kill primitive besides session deletion.
	commandTimeout: "unverified",
	files: "unverified",
	networkOff: "unverified", // networkBlockAll
	networkOn: "unverified",
	// Resources can only be set when creating from an image (not from a snapshot), which this adapter does not do yet.
	resourceLimits: "unsupported",
	reconnect: "unverified",
	services: "unsupported",
	pty: "unsupported",
	preview: "unsupported",
	snapshot: "unsupported",
	pauseResume: "unsupported",
	skills: "upload_readonly",
	isolation: "Daytona 托管沙箱（容器/运行时隔离由厂商决定，具体隔离强度未验证）",
	location: "vendor_cloud",
};

// ---- Small helpers (duplicated in e2b.ts on purpose: each provider file is self-contained). ----
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
function appendCapped(acc: string, chunk: string, cap: number): string {
	if (acc.length >= cap) return acc;
	const next = acc + chunk;
	return next.length > cap ? `${next.slice(0, cap)}\n[输出已截断]` : next;
}
/** Remove the API key and anything that looks like a credential from text that may reach logs / API responses. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
	let t = text;
	for (const s of secrets) if (s.length >= 4) t = t.split(s).join("[已隐藏]");
	return t
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer [已隐藏]")
		.replace(/\b(e2b|dtn|sk|ak)_[A-Za-z0-9_-]{8,}/g, "[已隐藏]")
		.replace(/((?:x-api-key|api[_-]?key|authorization|access[_-]?token)["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi, "$1[已隐藏]");
}
function shortError(e: unknown): string {
	return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}
function shq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `env K=V … /bin/sh -c 'cd CWD && CMD'` — cwd/env travel inside the command line (the session API has neither). */
export function buildShellLine(command: string, cwd: string, env?: Readonly<Record<string, string>>): string {
	const envArgs: string[] = [];
	for (const [k, v] of Object.entries(env ?? {})) {
		if (!ENV_KEY.test(k)) throw new Error(`非法环境变量名：${k.slice(0, 40)}`);
		envArgs.push(shq(`${k}=${v}`));
	}
	return `${envArgs.length ? `env ${envArgs.join(" ")} ` : ""}/bin/sh -c ${shq(`cd ${shq(cwd)} && ${command}`)}`;
}
function errName(e: unknown): string {
	return e && typeof e === "object" && typeof (e as { name?: unknown }).name === "string" ? (e as { name: string }).name : "";
}
function statusOf(e: unknown): number | undefined {
	const s = e && typeof e === "object" ? (e as { statusCode?: unknown }).statusCode : undefined;
	return typeof s === "number" ? s : undefined;
}
function isNotFound(e: unknown): boolean {
	return statusOf(e) === 404 || /NotFoundError$/.test(errName(e));
}
const GONE_STATES = new Set(["destroyed", "destroying", "error", "build_failed"]);
const STARTABLE_STATES = new Set(["stopped", "archived"]);

async function defaultLoadSdk(): Promise<DaytonaModule> {
	const name = DAYTONA_SDK_PACKAGE; // variable specifier: the app starts and typechecks without the optional package
	try {
		return (await import(name)) as DaytonaModule;
	} catch (e) {
		throw new UnsupportedError(ID, `未安装 SDK（npm install --save-optional --save-exact ${DAYTONA_SDK_PACKAGE}@${DAYTONA_SDK_VERSION}）：${shortError(e)}`);
	}
}

export function createProvider(conn: ProviderConnection, deps: DaytonaProviderDeps = {}): RemoteProvider {
	return new DaytonaProvider(conn, deps);
}

class DaytonaProvider implements RemoteProvider {
	readonly id = ID;
	readonly label = "Daytona";
	readonly capabilities = DAYTONA_CAPABILITIES;
	readonly #conn: ProviderConnection;
	readonly #loadSdk: () => Promise<DaytonaModule>;
	#client?: Promise<DaytonaClient>;

	constructor(conn: ProviderConnection, deps: DaytonaProviderDeps) {
		this.#conn = conn;
		this.#loadSdk = deps.loadSdk ?? defaultLoadSdk;
	}
	#secrets(): string[] {
		return this.#conn.apiKey ? [this.#conn.apiKey] : [];
	}
	#wrap(e: unknown): Error {
		if (e instanceof UnsupportedError) return e;
		const err = new Error(scrubSecrets(e instanceof Error ? e.message : String(e), this.#secrets()));
		err.name = errName(e) || "Error";
		const st = statusOf(e);
		if (st !== undefined) (err as Error & { statusCode?: number }).statusCode = st;
		return err;
	}
	#clientOnce(): Promise<DaytonaClient> {
		if (!this.#client) {
			this.#client = (async () => {
				const sdk = await this.#loadSdk();
				const target = this.#conn.options?.target;
				// Explicit config only: never fall back to DAYTONA_* environment variables of the host for a missing key.
				return new sdk.Daytona({
					...(this.#conn.apiKey ? { apiKey: this.#conn.apiKey } : {}),
					...(this.#conn.endpoint ? { apiUrl: this.#conn.endpoint } : {}),
					...(target ? { target } : {}),
				});
			})();
			this.#client.catch(() => { this.#client = undefined; });
		}
		return this.#client;
	}
	#wrapSandbox(sb: DaytonaSandbox): DaytonaSession {
		return new DaytonaSession(sb, (e) => this.#wrap(e));
	}

	async health(signal?: AbortSignal): Promise<ProviderHealth> {
		if (!this.#conn.apiKey) return { ok: false, detail: "未配置 API Key" };
		try {
			const client = await this.#clientOnce();
			// cheap authenticated call: first page of the list, limit 1
			const it = client.list({ limit: 1 });
			let ht: ReturnType<typeof setTimeout> | undefined;
			const guard = new Promise<never>((_, rej) => {
				ht = setTimeout(() => rej(new Error("连接超时（15 秒）")), 15_000);
				signal?.addEventListener("abort", () => rej(new Error("已取消")), { once: true });
			});
			guard.catch(() => {});
			try { await Promise.race([it.next(), guard]); } finally { clearTimeout(ht); }
			void it.return?.();
			return { ok: true, detail: "已连接并通过认证（列出沙箱成功）" };
		} catch (e) {
			const msg = this.#wrap(e).message;
			if (e instanceof UnsupportedError) return { ok: false, detail: msg };
			const st = statusOf(e);
			if (st === 401 || st === 403 || /Authentication|Forbidden|Authorization/.test(errName(e))) return { ok: false, detail: "认证失败（API Key 无效或无权限）" };
			return { ok: false, detail: `连接失败：${msg.slice(0, 200)}` };
		}
	}

	async create(o: CreateOptions): Promise<RemoteSession> {
		if (o.resources && (o.resources.cpus !== undefined || o.resources.memoryMb !== undefined)) {
			throw new UnsupportedError(ID, "创建时指定 CPU/内存（仅镜像方式创建支持，本适配器使用快照/默认方式）");
		}
		const client = await this.#clientOnce();
		const lifetimeMin = Math.max(1, Math.ceil(o.lifetimeMs / 60_000));
		const template = o.template ?? this.#conn.template;
		const params: Record<string, unknown> = {
			labels: { ...o.metadata },
			...(o.env && Object.keys(o.env).length ? { envVars: { ...o.env } } : {}),
			...(template ? { snapshot: template } : {}),
			// Hard maximum age (wall clock) and an inactivity stop, both from the Workroom lifetime.
			ttlMinutes: lifetimeMin,
			autoStopInterval: lifetimeMin,
			// network=false MUST map to the SDK's block switch (networkBlockAll exists in 0.231.1). Network on = SDK default, left unset.
			...(o.network ? {} : { networkBlockAll: true }),
		};
		try {
			const create = client.create(params, { timeout: Math.max(1, Math.ceil(o.createTimeoutMs / 1000)) });
			const sb = await raceAbort(create, o.signal);
			return this.#wrapSandbox(sb);
		} catch (e) {
			throw this.#wrap(e);
		}
	}

	async connect(id: string, _signal?: AbortSignal): Promise<RemoteSession | null> {
		const client = await this.#clientOnce();
		try {
			const sb = await client.get(id);
			if (sb.state && GONE_STATES.has(sb.state)) return null;
			if (sb.state && STARTABLE_STATES.has(sb.state)) await sb.start(120);
			return this.#wrapSandbox(sb);
		} catch (e) {
			if (isNotFound(e)) return null;
			throw this.#wrap(e);
		}
	}

	async list(metadata: Readonly<Record<string, string>>): Promise<RemoteSandboxInfo[]> {
		const client = await this.#clientOnce();
		const out: RemoteSandboxInfo[] = [];
		try {
			for await (const sb of client.list({ labels: { ...metadata } })) {
				out.push({ id: sb.id, state: sb.state ?? "unknown", metadata: { ...(sb.labels ?? {}) }, ...(sb.createdAt ? { createdAt: sb.createdAt } : {}) });
				if (out.length >= 1000) break;
			}
		} catch (e) {
			throw this.#wrap(e);
		}
		return out;
	}

	async destroy(id: string): Promise<void> {
		const client = await this.#clientOnce();
		try {
			const sb = await client.get(id);
			await client.delete(sb, 60);
		} catch (e) {
			if (isNotFound(e)) return;
			throw this.#wrap(e);
		}
	}
}

function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return p;
	if (signal.aborted) { p.catch(() => {}); return Promise.reject(new Error("已取消")); }
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => { p.catch(() => {}); reject(new Error("已取消")); };
		signal.addEventListener("abort", onAbort, { once: true });
		p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

/** find -printf record: type, size, mtime(epoch, fractional), path relative to the start dir — RS (0x1e)-terminated (NUL may not survive the JSON transport). */
const FIND_FORMAT = "%y\\t%s\\t%T@\\t%P\\036";

class DaytonaSession implements RemoteSession {
	readonly id: string;
	readonly #sb: DaytonaSandbox;
	readonly #wrap: (e: unknown) => Error;

	constructor(sb: DaytonaSandbox, wrap: (e: unknown) => Error) {
		this.id = sb.id;
		this.#sb = sb;
		this.#wrap = wrap;
	}

	async exec(o: ExecOptions): Promise<ExecResult> {
		if (o.signal?.aborted) return { status: "killed", exitCode: null, stdout: "", stderr: "" };
		const line = buildShellLine(o.command, o.cwd, o.env);
		const sessionId = `wr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		let stdout = "";
		let stderr = "";
		const onOut = (d: string): void => { stdout = appendCapped(stdout, d, MAX_STREAM_BYTES); o.onStdout?.(d); };
		const onErr = (d: string): void => { stderr = appendCapped(stderr, d, MAX_STREAM_BYTES); o.onStderr?.(d); };
		const proc = this.#sb.process;
		type Outcome = { k: "done"; exitCode: number | null } | { k: "err"; e: unknown } | { k: "timeout" } | { k: "abort" };
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			await proc.createSession(sessionId);
			const started = await proc.executeSessionCommand(sessionId, { command: line, runAsync: true });
			const cmdId = started.cmdId;
			if (!cmdId) throw new Error("Daytona 未返回命令 ID");
			const work: Promise<Outcome> = (async (): Promise<Outcome> => {
				await proc.getSessionCommandLogs(sessionId, cmdId, onOut, onErr); // resolves when the log stream ends (command finished)
				for (let i = 0; i < 25; i++) {
					const c = await proc.getSessionCommand(sessionId, cmdId);
					if (typeof c.exitCode === "number") return { k: "done", exitCode: c.exitCode };
					await new Promise<void>((r) => { const t = setTimeout(r, 200); t.unref?.(); });
				}
				return { k: "done", exitCode: null };
			})().catch((e: unknown): Outcome => ({ k: "err", e }));
			const guards: Promise<Outcome>[] = [
				new Promise<Outcome>((res) => { timer = setTimeout(() => res({ k: "timeout" }), o.timeoutMs); }),
				new Promise<Outcome>((res) => {
					if (!o.signal) return;
					onAbort = () => res({ k: "abort" });
					o.signal.addEventListener("abort", onAbort, { once: true });
				}),
			];
			const outcome = await Promise.race([work, ...guards]);
			if (outcome.k === "done") {
				if (outcome.exitCode === null) return { status: "error", exitCode: null, stdout, stderr };
				return { status: outcome.exitCode === 0 ? "ok" : "error", exitCode: outcome.exitCode, stdout, stderr };
			}
			if (outcome.k === "err") throw outcome.e;
			// timeout / abort: deleting the session (in `finally`) is the remote kill; it terminates the session's process group.
			return { status: outcome.k === "abort" ? "killed" : "timeout", exitCode: null, stdout, stderr };
		} catch (e) {
			throw this.#wrap(e);
		} finally {
			if (timer) clearTimeout(timer);
			if (onAbort) o.signal?.removeEventListener("abort", onAbort);
			await proc.deleteSession(sessionId).catch(() => undefined);
		}
	}

	async writeFile(path: string, bytes: Uint8Array): Promise<void> {
		try {
			await this.#sb.fs.uploadFile(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), path);
		} catch (e) {
			throw this.#wrap(e);
		}
	}

	async readFile(path: string, maxBytes: number): Promise<Uint8Array> {
		try {
			const buf = await this.#sb.fs.downloadFile(path);
			if (buf.byteLength > maxBytes) throw new Error(`文件超过大小上限（${buf.byteLength} > ${maxBytes} 字节）`);
			return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
		} catch (e) {
			throw this.#wrap(e);
		}
	}

	/**
	 * Daytona's FileInfo has no symlink flag (isDir/mode only), so listing goes through `find` (lstat semantics, never follows links,
	 * %y = l for symlinks). Requires GNU/busybox-with-printf `find` in the image; if absent, the call fails loudly instead of
	 * guessing — a missed symlink would be followed on download.
	 */
	async list(dir: string): Promise<RemoteEntry[]> {
		const cmd = `find ${shq(dir)} -mindepth 1 -printf '${FIND_FORMAT}'`;
		let res: { exitCode: number; result: string };
		try {
			res = await this.#sb.process.executeCommand(cmd, "/", undefined, 120);
		} catch (e) {
			throw this.#wrap(e);
		}
		if (res.exitCode !== 0) throw new Error(`列目录失败（exit ${res.exitCode}）：${res.result.slice(0, 200)}`);
		const out: RemoteEntry[] = [];
		for (const rec of res.result.split("\x1e")) {
			if (!rec) continue;
			const [y, size, mtime, ...rest] = rec.split("\t");
			const path = rest.join("\t");
			if (!path) continue;
			const kind = y === "f" ? "file" : y === "d" ? "directory" : y === "l" ? "symlink" : "other";
			const mt = Number(mtime);
			out.push({ path, kind, size: Number(size) || 0, ...(Number.isFinite(mt) ? { mtimeMs: Math.round(mt * 1000) } : {}) });
		}
		return out;
	}

	async remove(path: string): Promise<void> {
		try {
			await this.#sb.fs.deleteFile(path, true);
		} catch (e) {
			if (isNotFound(e)) return;
			throw this.#wrap(e);
		}
	}

	async mkdir(path: string): Promise<void> {
		try {
			await this.#sb.fs.createFolder(path, "755");
		} catch (e) {
			throw this.#wrap(e);
		}
	}

	/** Refreshes the inactivity window only; the hard TTL set at creation (ttlMinutes) is the Workroom lifetime cap and is deliberately not extended. */
	async keepAlive(lifetimeMs: number): Promise<void> {
		const min = Math.max(1, Math.ceil(lifetimeMs / 60_000));
		try {
			await this.#sb.refreshActivity();
			await this.#sb.setAutostopInterval(min);
		} catch (e) {
			throw this.#wrap(e);
		}
	}
}
