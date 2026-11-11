// E2B provider (official `e2b` JS SDK, exact version pinned in optionalDependencies, loaded lazily).
//
// Status: IMPLEMENTED, NOT CONNECTED. No E2B key existed when this was written, so every capability is "unverified" (see
// docs/research/sandbox-providers.md). Only the offline-verifiable facts are asserted (networkOff/networkOn exist in the typings:
// `allowInternetAccess`), and even those are "unverified" until a live contract run.
//
// Endpoint: `endpoint` = API URL (SDK `apiUrl`), `domain` = sandbox domain (SDK `domain`); both absent = official E2B cloud.
// An E2B-compatible service (e.g. Alibaba Cloud Agent Sandbox) is configured explicitly the same way; nothing here assumes that
// such a service supports every SDK feature.
import { UnsupportedError } from "../provider.ts";
import type {
	CreateOptions, ExecOptions, ExecResult, PauseOptions, ProviderCapabilities, ProviderConnection, ProviderHealth, RemoteEntry,
	RemoteProvider, RemoteSandboxInfo, RemoteSession,
} from "../provider.ts";

export const E2B_SDK_PACKAGE = "e2b";
export const E2B_SDK_VERSION = "2.63.0";
const ID = "e2b";

// ---- Minimal structural view of the parts of the SDK we use (keeps typecheck independent of the optional install). ----
interface E2bCommandHandle {
	wait(): Promise<{ exitCode: number }>;
	kill(): Promise<boolean>;
}
interface E2bEntryInfo {
	name: string;
	path: string;
	type?: string;
	size: number;
	modifiedTime?: Date;
	symlinkTarget?: string;
}
interface E2bSandboxInstance {
	readonly sandboxId: string;
	readonly commands: { run(cmd: string, opts: Record<string, unknown>): Promise<E2bCommandHandle> };
	readonly files: {
		read(path: string, opts: Record<string, unknown>): Promise<Uint8Array>;
		write(path: string, data: Uint8Array, opts?: Record<string, unknown>): Promise<unknown>;
		list(path: string, opts?: Record<string, unknown>): Promise<E2bEntryInfo[]>;
		remove(path: string, opts?: Record<string, unknown>): Promise<void>;
		makeDir(path: string, opts?: Record<string, unknown>): Promise<boolean>;
	};
	setTimeout(ms: number, opts?: Record<string, unknown>): Promise<void>;
}
interface E2bSandboxInfo {
	sandboxId: string;
	state?: string;
	metadata?: Record<string, string>;
	startedAt?: Date;
}
interface E2bPaginator {
	readonly hasNext: boolean;
	nextItems(): Promise<E2bSandboxInfo[]>;
}
export interface E2bModule {
	Sandbox: {
		create(opts: Record<string, unknown>): Promise<E2bSandboxInstance>;
		connect(id: string, opts: Record<string, unknown>): Promise<E2bSandboxInstance>;
		/** Static: pause by id. Resolves true when it got paused, false when it was already paused (SDK 2.63.0). */
		pause(id: string, opts: Record<string, unknown>): Promise<boolean>;
		list(opts: Record<string, unknown>): E2bPaginator;
		kill(id: string, opts: Record<string, unknown>): Promise<boolean>;
	};
}

export interface E2bProviderDeps {
	/** Test seam. Defaults to a lazy `import("e2b")`. */
	readonly loadSdk?: () => Promise<E2bModule>;
}

export const E2B_CAPABILITIES: ProviderCapabilities = {
	exec: "unverified",
	streamOutput: "unverified",
	cancel: "unverified",
	commandTimeout: "unverified",
	files: "unverified",
	networkOff: "unverified", // NOT USED by Workroom (round 9): create() never passes allowInternetAccess
	networkOn: "unverified", // not verified here (no credentials); the E2B template/account defaults decide
	// CPU/memory are properties of the E2B template, not of a create call.
	resourceLimits: "unsupported",
	reconnect: "unverified",
	services: "unsupported",
	pty: "unsupported",
	preview: "unsupported",
	snapshot: "unsupported",
	// Round 11: Sandbox.pause(id) / Sandbox.connect(id) (resumes a paused sandbox) / lifecycle.onTimeout "pause" exist in SDK 2.63.0 typings; never run against E2B (no key).
	pauseResume: "unverified",
	skills: "upload_readonly",
	isolation: "Firecracker microVM（E2B 官方云；自建/兼容服务的隔离由其实现决定，未验证）",
	location: "configurable",
};

// ---- Small helpers (duplicated in daytona.ts on purpose: each provider file is self-contained). ----
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

async function defaultLoadSdk(): Promise<E2bModule> {
	const name = E2B_SDK_PACKAGE; // variable specifier: no static resolution, so the app starts and typechecks without the package
	try {
		return (await import(name)) as E2bModule;
	} catch (e) {
		throw new UnsupportedError(ID, `未安装 SDK（npm install --save-optional --save-exact ${E2B_SDK_PACKAGE}@${E2B_SDK_VERSION}）：${shortError(e)}`);
	}
}

function errName(e: unknown): string {
	return e && typeof e === "object" && typeof (e as { name?: unknown }).name === "string" ? (e as { name: string }).name : "";
}
function isNotFound(e: unknown): boolean {
	const n = errName(e);
	return n === "SandboxNotFoundError" || n === "NotFoundError" || n === "FileNotFoundError";
}
function isTimeout(e: unknown): boolean {
	return errName(e) === "TimeoutError";
}

export function createProvider(conn: ProviderConnection, deps: E2bProviderDeps = {}): RemoteProvider {
	return new E2bProvider(conn, deps);
}

class E2bProvider implements RemoteProvider {
	readonly id = ID;
	readonly label = "E2B";
	readonly capabilities = E2B_CAPABILITIES;
	readonly #conn: ProviderConnection;
	readonly #loadSdk: () => Promise<E2bModule>;
	#sdk?: Promise<E2bModule>;

	constructor(conn: ProviderConnection, deps: E2bProviderDeps) {
		this.#conn = conn;
		this.#loadSdk = deps.loadSdk ?? defaultLoadSdk;
	}

	#secrets(): string[] {
		return this.#conn.apiKey ? [this.#conn.apiKey] : [];
	}
	/** Errors from the SDK may echo request headers; never let the key out. */
	#wrap(e: unknown): Error {
		if (e instanceof UnsupportedError) return e;
		const err = new Error(scrubSecrets(e instanceof Error ? e.message : String(e), this.#secrets()));
		err.name = errName(e) || "Error";
		return err;
	}
	#sdkOnce(): Promise<E2bModule> {
		if (!this.#sdk) {
			this.#sdk = this.#loadSdk();
			this.#sdk.catch(() => { this.#sdk = undefined; }); // allow a retry after the admin installs the package
		}
		return this.#sdk;
	}
	/** Connection options common to every call. `apiUrl` is deprecated-but-present in 2.63.0 typings; it is the only per-call way to set the API URL. */
	#connOpts(extra: Record<string, unknown> = {}): Record<string, unknown> {
		const o: Record<string, unknown> = { ...extra };
		if (this.#conn.apiKey) o.apiKey = this.#conn.apiKey;
		if (this.#conn.endpoint) o.apiUrl = this.#conn.endpoint;
		if (this.#conn.domain) o.domain = this.#conn.domain;
		return o;
	}

	async health(signal?: AbortSignal): Promise<ProviderHealth> {
		if (!this.#conn.apiKey) return { ok: false, detail: "未配置 API Key" };
		let sdk: E2bModule;
		try {
			sdk = await this.#sdkOnce();
		} catch (e) {
			return { ok: false, detail: this.#wrap(e).message };
		}
		try {
			const p = sdk.Sandbox.list(this.#connOpts({ limit: 1, requestTimeoutMs: 15_000, ...(signal ? { signal } : {}) }));
			await p.nextItems();
			return { ok: true, detail: "已连接并通过认证（列出沙箱成功）" };
		} catch (e) {
			const n = errName(e);
			const msg = this.#wrap(e).message;
			if (n === "AuthenticationError" || /\b40[13]\b|unauthori[sz]ed|invalid api key/i.test(msg)) return { ok: false, detail: "认证失败（API Key 无效或无权限）" };
			return { ok: false, detail: `连接失败：${msg.slice(0, 200)}` };
		}
	}

	async create(o: CreateOptions): Promise<RemoteSession> {
		// Only EXPLICIT admin resources are a request (o.defaultMemoryMb is a hint E2B cannot apply: size comes from the template).
		if (o.resources && (o.resources.cpus !== undefined || o.resources.memoryGb !== undefined || o.resources.diskGb !== undefined)) {
			throw new UnsupportedError(ID, "创建时指定 CPU/内存（E2B 的资源规格由模板决定，请改用模板）");
		}
		const sdk = await this.#sdkOnce();
		const opts = this.#connOpts({
			metadata: { ...o.metadata },
			// Round 11: o.lifetimeMs is slightly above the idle-pause time and Workroom extends it on every use (keepAlive). If Workroom dies, the vendor
			// itself PAUSES the sandbox at the timeout instead of killing it. autoResume stays explicitly off: a sandbox wakes only when Workroom resumes it.
			timeoutMs: o.lifetimeMs,
			...(o.lifecycle ? { lifecycle: { onTimeout: "pause", autoResume: false } } : {}),
			requestTimeoutMs: o.createTimeoutMs,
			// Round 9: no allowInternetAccess option at all (neither false nor true) — the SDK/vendor default applies.
			...(o.template ? { template: o.template } : this.#conn.template ? { template: this.#conn.template } : {}),
			...(o.env && Object.keys(o.env).length ? { envs: { ...o.env } } : {}),
			...(o.signal ? { signal: o.signal } : {}),
		});
		try {
			return new E2bSession(await sdk.Sandbox.create(opts), (e) => this.#wrap(e));
		} catch (e) {
			throw this.#wrap(e);
		}
	}

	async connect(id: string, signal?: AbortSignal): Promise<RemoteSession | null> {
		const sdk = await this.#sdkOnce();
		try {
			// connect() also resumes a paused sandbox and only ever extends the timeout; a killed/expired sandbox raises not-found.
			const inst = await sdk.Sandbox.connect(id, this.#connOpts(signal ? { signal } : {}));
			return new E2bSession(inst, (e) => this.#wrap(e));
		} catch (e) {
			if (isNotFound(e)) return null;
			throw this.#wrap(e);
		}
	}

	/** Pause keeps the filesystem and (default mode "full") memory, so installed dependencies and running state survive. Paused E2B sandboxes carry no Workroom-side TTL. */
	async pause(id: string, _o: PauseOptions): Promise<void> {
		const sdk = await this.#sdkOnce();
		try {
			await sdk.Sandbox.pause(id, this.#connOpts()); // false = already paused: success
		} catch (e) {
			throw this.#wrap(e);
		}
	}

	/** connect() on a paused sandbox resumes it (and only ever extends the timeout); a killed sandbox raises not-found → null. */
	async resume(id: string, signal?: AbortSignal): Promise<RemoteSession | null> {
		return this.connect(id, signal);
	}

	async list(metadata: Readonly<Record<string, string>>): Promise<RemoteSandboxInfo[]> {
		const sdk = await this.#sdkOnce();
		try {
			const pager = sdk.Sandbox.list(this.#connOpts({ query: { metadata: { ...metadata } } }));
			const out: RemoteSandboxInfo[] = [];
			let pages = 0;
			while (pager.hasNext && pages++ < 50) {
				for (const s of await pager.nextItems()) {
					out.push({
						id: s.sandboxId,
						state: s.state ?? "unknown",
						metadata: { ...(s.metadata ?? {}) },
						...(s.startedAt ? { createdAt: s.startedAt.toISOString() } : {}),
					});
				}
			}
			return out;
		} catch (e) {
			throw this.#wrap(e);
		}
	}

	async destroy(id: string): Promise<void> {
		const sdk = await this.#sdkOnce();
		try {
			await sdk.Sandbox.kill(id, this.#connOpts()); // resolves false when the sandbox does not exist
		} catch (e) {
			if (isNotFound(e)) return;
			throw this.#wrap(e);
		}
	}
}

class E2bSession implements RemoteSession {
	readonly id: string;
	readonly #sbx: E2bSandboxInstance;
	readonly #wrap: (e: unknown) => Error;

	constructor(sbx: E2bSandboxInstance, wrap: (e: unknown) => Error) {
		this.id = sbx.sandboxId;
		this.#sbx = sbx;
		this.#wrap = wrap;
	}

	async exec(o: ExecOptions): Promise<ExecResult> {
		if (o.signal?.aborted) return { status: "killed", exitCode: null, stdout: "", stderr: "" };
		let stdout = "";
		let stderr = "";
		const onOut = (d: string): void => { stdout = appendCapped(stdout, d, MAX_STREAM_BYTES); o.onStdout?.(d); };
		const onErr = (d: string): void => { stderr = appendCapped(stderr, d, MAX_STREAM_BYTES); o.onStderr?.(d); };
		let handle: E2bCommandHandle;
		try {
			handle = await this.#sbx.commands.run(o.command, {
				background: true,
				cwd: o.cwd,
				...(o.env && Object.keys(o.env).length ? { envs: { ...o.env } } : {}),
				timeoutMs: o.timeoutMs, // remote-side deadline
				retainOutput: false, // we accumulate (capped) ourselves, so partial output survives a kill
				onStdout: onOut,
				onStderr: onErr,
			});
		} catch (e) {
			throw this.#wrap(e);
		}
		type Outcome = { k: "done"; exitCode: number } | { k: "err"; e: unknown } | { k: "timeout" } | { k: "abort" };
		const waiting: Promise<Outcome> = handle.wait().then(
			(r): Outcome => ({ k: "done", exitCode: r.exitCode }),
			(e: unknown): Outcome => {
				// The SDK throws CommandExitError (exitCode set) for non-zero exits.
				const code = e && typeof e === "object" ? (e as { exitCode?: unknown }).exitCode : undefined;
				if (errName(e) === "CommandExitError" && typeof code === "number") return { k: "done", exitCode: code };
				return { k: "err", e };
			},
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		const guards: Promise<Outcome>[] = [
			new Promise<Outcome>((res) => { timer = setTimeout(() => res({ k: "timeout" }), o.timeoutMs + 3000); }), // client deadline: remote one fires first
			new Promise<Outcome>((res) => {
				if (!o.signal) return;
				onAbort = () => res({ k: "abort" });
				o.signal.addEventListener("abort", onAbort, { once: true });
			}),
		];
		const outcome = await Promise.race([waiting, ...guards]);
		if (timer) clearTimeout(timer);
		if (onAbort) o.signal?.removeEventListener("abort", onAbort);
		if (outcome.k === "done") return { status: outcome.exitCode === 0 ? "ok" : "error", exitCode: outcome.exitCode, stdout, stderr };
		if (outcome.k === "err" && !isTimeout(outcome.e)) throw this.#wrap(outcome.e);
		// timeout (remote or client) and abort: the process must actually be stopped remotely, not merely abandoned.
		await handle.kill().catch(() => false);
		void waiting; // already caught; nothing to leak
		return { status: outcome.k === "abort" ? "killed" : "timeout", exitCode: null, stdout, stderr };
	}

	async writeFile(path: string, bytes: Uint8Array): Promise<void> {
		try {
			await this.#sbx.files.write(path, bytes);
		} catch (e) {
			throw this.#wrap(e);
		}
	}

	async readFile(path: string, maxBytes: number): Promise<Uint8Array> {
		try {
			const data = await this.#sbx.files.read(path, { format: "bytes" });
			if (data.byteLength > maxBytes) throw new Error(`文件超过大小上限（${data.byteLength} > ${maxBytes} 字节）`);
			return data;
		} catch (e) {
			throw this.#wrap(e);
		}
	}

	async list(dir: string): Promise<RemoteEntry[]> {
		const base = dir.replace(/\/+$/, "");
		let entries: E2bEntryInfo[];
		try {
			// envd lists with lstat semantics and reports symlinks (type "symlink" / symlinkTarget); it does not descend into them.
			entries = await this.#sbx.files.list(dir, { depth: 64 });
		} catch (e) {
			throw this.#wrap(e);
		}
		const out: RemoteEntry[] = [];
		for (const x of entries) {
			const rel = x.path.startsWith(`${base}/`) ? x.path.slice(base.length + 1) : x.name;
			const isLink = x.type === "symlink" || x.symlinkTarget !== undefined;
			out.push({
				path: rel,
				kind: isLink ? "symlink" : x.type === "file" ? "file" : x.type === "dir" ? "directory" : "other",
				size: x.size,
				...(x.modifiedTime ? { mtimeMs: x.modifiedTime.getTime() } : {}),
			});
		}
		return out;
	}

	async remove(path: string): Promise<void> {
		try {
			await this.#sbx.files.remove(path);
		} catch (e) {
			if (isNotFound(e)) return;
			throw this.#wrap(e);
		}
	}

	async mkdir(path: string): Promise<void> {
		try {
			await this.#sbx.files.makeDir(path);
		} catch (e) {
			throw this.#wrap(e);
		}
	}

	async keepAlive(lifetimeMs: number): Promise<void> {
		try {
			await this.#sbx.setTimeout(lifetimeMs); // resets the sandbox timeout from now
		} catch (e) {
			throw this.#wrap(e);
		}
	}
}
