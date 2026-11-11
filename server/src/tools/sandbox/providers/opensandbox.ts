// OpenSandbox provider (https://github.com/opensandbox-group/OpenSandbox, Apache-2.0). Self-hosted: a lifecycle server (Docker or
// Kubernetes runtime) plus an in-sandbox daemon "execd". NOT E2B-compatible: its own lifecycle API (`/v1/sandboxes`, header
// `OPEN-SANDBOX-API-KEY`) and its own execd protocol (SSE command stream, multipart file upload).
//
// Official TypeScript SDK: `@alibaba-group/opensandbox` (repository field = github.com/opensandbox-group/OpenSandbox, license Apache-2.0),
// exact-pinned in optionalDependencies and imported lazily; a missing install produces a clear "not installed" error, never a fallback.
// Why the SDK instead of raw HTTP: it implements the execd SSE stream, the multipart upload and the lifecycle/endpoint resolution
// (including the server-side proxy); re-implementing those would duplicate a moving protocol. Its telemetry (create-latency report) is
// switched OFF here (`disableMetrics`).
//
// Facts below were verified against a real local server (opensandbox-server 1.2.0, Docker runtime, SDK 1.2.0) — see docs/research/opensandbox.md.
import { UnsupportedError } from "../provider.ts";
import type {
	CreateOptions, ExecOptions, ExecResult, PauseOptions, ProviderCapabilities, ProviderConnection, ProviderHealth, RemoteEntry,
	RemoteProvider, RemoteSandboxInfo, RemoteSession,
} from "../provider.ts";
import { HttpError } from "../../../core/http.ts";

export const OPENSANDBOX_SDK_PACKAGE = "@alibaba-group/opensandbox";
export const OPENSANDBOX_SDK_VERSION = "1.2.0";
const ID = "opensandbox" as const;
/** Default image when no template is configured: python3 + coreutils (sha256sum, find). Node-based skills need a configured template image with node. */
export const OPENSANDBOX_DEFAULT_IMAGE = "python:3.12-slim";
/** The unprivileged identity user code runs as inside the sandbox (root is used only for RemoteDriver's own setup commands). */
export const WORKLOAD_UID = 10001;
const OUTPUT_CAP = 256 * 1024;

export const OPENSANDBOX_CAPABILITIES: ProviderCapabilities = {
	exec: "supported", // verified: exit codes, stdout/stderr, cwd, env, uid/gid
	streamOutput: "supported", // verified: chunks arrive ~300 ms apart while the command runs
	cancel: "supported", // verified: aborting the request stopped `sleep 40` inside the container (ps found nothing)
	commandTimeout: "supported", // verified: server-side timeoutSeconds kills the whole process group (exit -1, "signal: killed")
	files: "supported", // verified: write (20 MB), read (+range), list (symlink/other typed, never followed), mkdir, delete, odd names
	networkOff: "unverified", // NOT USED by Workroom (round 9): create() never sends a networkPolicy. (Earlier finding: a deny policy still left the sidecar's upstream resolver reachable.)
	networkOn: "supported", // verified earlier on a local server: sandboxes created without networkPolicy can reach the network (the server's own network config decides)
	resourceLimits: "unverified", // `resource` is forwarded (cpu/memory); container limits were not independently confirmed by cgroup readout here
	reconnect: "supported", // verified: Sandbox.connect(id) after the creating object was dropped; unknown id → 404
	services: "unsupported",
	pty: "unsupported",
	preview: "unsupported",
	snapshot: "unsupported",
	// Round 11, verified live (opensandbox-server 1.2.0, Docker runtime): POST /v1/sandboxes/{id}/pause → state Paused (docker pause: processes frozen, filesystem and
	// memory kept, a file written before the pause was read back after resume, exec works again ~1 s later); /resume → Running; renew works while paused.
	// A paused sandbox STILL EXPIRES at its TTL (verified: a 60 s sandbox paused for 75 s was gone → 404), so pause() first extends the TTL to the retention window.
	pauseResume: "supported",
	skills: "upload_readonly",
	isolation: "Container started by the OpenSandbox server (Docker or Kubernetes runtime; self-hosted). Shares the host kernel unless the operator configured a microVM/gVisor runtime. Outbound network follows the OpenSandbox server's own configuration (Workroom sends no network policy).",
	location: "self_hosted",
};

// ---- minimal structural view of the SDK (typecheck must not depend on the optional install) ----
interface SdkMsg { text: string; isError?: boolean }
interface SdkExecution { exitCode?: number | null; error?: { name?: string; value?: string; traceback?: string[]; exitCode?: number }; logs: { stdout: SdkMsg[]; stderr: SdkMsg[] } }
interface SdkFileInfo { path: string; type?: string; size?: number; modifiedAt?: Date }
interface SdkSandbox {
	readonly id: string;
	commands: {
		run(command: string, opts?: Record<string, unknown>, handlers?: Record<string, unknown>, signal?: AbortSignal): Promise<SdkExecution>;
		interrupt(id: string): Promise<void>;
	};
	files: {
		writeFiles(entries: { path: string; data?: Uint8Array | string; mode?: number }[]): Promise<void>;
		readBytes(path: string, opts?: { range?: string }): Promise<Uint8Array>;
		getFileInfo(paths: string[]): Promise<Record<string, SdkFileInfo>>;
		listDirectory(e: { path: string; depth?: number }): Promise<SdkFileInfo[]>;
		createDirectories(entries: { path: string; mode?: number }[]): Promise<void>;
	};
	getInfo(): Promise<{ status: { state: string } }>;
	renew(timeoutSeconds: number): Promise<unknown>;
	close(): Promise<void>;
}
interface SdkInfo { id: string; status: { state: string }; metadata?: Record<string, string>; createdAt?: Date }
interface SdkManager {
	getSandboxInfo(id: string): Promise<{ status: { state: string } }>;
	pauseSandbox(id: string): Promise<void>;
	resumeSandbox(id: string): Promise<void>;
	renewSandbox(id: string, timeoutSeconds: number): Promise<void>;
	listSandboxInfos(f?: { states?: string[]; metadata?: Record<string, string>; page?: number; pageSize?: number }): Promise<{ items: SdkInfo[]; pagination?: { totalPages?: number; hasNextPage?: boolean } }>;
	killSandbox(id: string, signal?: AbortSignal): Promise<void>;
	close(): Promise<void>;
}
interface SdkModule {
	ConnectionConfig: new (o: Record<string, unknown>) => { closeTransport?: () => Promise<void> };
	Sandbox: {
		create(o: Record<string, unknown>): Promise<SdkSandbox>;
		connect(o: Record<string, unknown>): Promise<SdkSandbox>;
	};
	SandboxManager: { create(o: Record<string, unknown>): SdkManager };
}

let sdkLoader: () => Promise<SdkModule> = async () => {
	const spec = OPENSANDBOX_SDK_PACKAGE; // variable specifier: the optional package is not resolved at typecheck/start-up
	try {
		return (await import(spec)) as SdkModule;
	} catch {
		throw new HttpError(501, "adapter_missing", `OpenSandbox SDK（${OPENSANDBOX_SDK_PACKAGE}@${OPENSANDBOX_SDK_VERSION}）未安装：请在服务器上运行 npm install（optionalDependencies）。不会回退到本机执行。`);
	}
};
/** Tests only: replace the SDK loader (a clearly-labelled test double). */
export function setOpenSandboxSdkLoaderForTests(f: (() => Promise<SdkModule>) | null): void {
	sdkLoader = f ?? (async () => (await import(OPENSANDBOX_SDK_PACKAGE)) as SdkModule);
}

const statusOf = (e: any): number | undefined => (typeof e?.statusCode === "number" ? e.statusCode : undefined);
const isMissing = (e: any) => statusOf(e) === 404;
const msgOf = (e: any) => String(e?.error?.message ?? e?.message ?? e).replace(/\s+/g, " ").slice(0, 300);

function clean(text: string, key: string | undefined): string {
	return key && key.length >= 4 ? text.split(key).join("[已隐藏]") : text;
}

/** Make the endpoint an absolute base URL for the SDK (`domain` accepts a full URL, path prefix preserved). */
function baseUrl(conn: ProviderConnection): string {
	if (!conn.endpoint) throw new HttpError(400, "invalid", "OpenSandbox 需要配置服务地址（endpoint）");
	let u: URL;
	try {
		u = new URL(conn.endpoint);
	} catch {
		throw new HttpError(400, "invalid", "OpenSandbox 服务地址无效");
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, "invalid", "OpenSandbox 服务地址必须是 http(s)://");
	if (u.username || u.password) throw new HttpError(400, "invalid", "OpenSandbox 服务地址不能包含用户名或密码");
	return u.toString().replace(/\/+$/, "");
}

export function createProvider(conn: ProviderConnection): RemoteProvider & { close(): Promise<void> } {
	const url = baseUrl(conn);
	const key = conn.apiKey;
	const image = conn.template || conn.options?.image || OPENSANDBOX_DEFAULT_IMAGE;
	let sdk: Promise<{ mod: SdkModule; cfg: any }> | undefined;
	const load = () =>
		(sdk ??= (async () => {
			const mod = await sdkLoader();
			// useServerProxy: every execd call goes through the (already SSRF-validated) lifecycle server URL, so the endpoint an
			// OpenSandbox server reports for a sandbox can never redirect Workroom to another address. Override: options.directEndpoints="1".
			const cfg = new mod.ConnectionConfig({ domain: url, apiKey: key, disableMetrics: true, useServerProxy: conn.options?.directEndpoints !== "1", requestTimeoutSeconds: 60 });
			return { mod, cfg };
		})());
	const wrap = <T>(what: string, p: Promise<T>): Promise<T> =>
		p.catch((e) => {
			if (e instanceof HttpError) throw e;
			throw new Error(`OpenSandbox ${what}失败：${clean(msgOf(e), key)}`);
		});

	function session(sb: SdkSandbox): RemoteSession {
		return {
			id: sb.id,
			async exec(o: ExecOptions): Promise<ExecResult> {
				const started = Date.now();
				const out: string[] = [];
				const err: string[] = [];
				let size = { o: 0, e: 0 };
				let execId: string | undefined;
				// Own deadline slightly after the server-side timeout, so a wedged stream cannot hang the run.
				const ac = new AbortController();
				const link = () => ac.abort();
				if (o.signal?.aborted) ac.abort();
				else o.signal?.addEventListener("abort", link, { once: true });
				let deadline = false;
				const timer = setTimeout(() => ((deadline = true), ac.abort()), o.timeoutMs + 4000);
				const take = (arr: string[], which: "o" | "e", text: string) => {
					if (size[which] >= OUTPUT_CAP) return;
					const line = /[\r\n]$/.test(text) ? text : `${text}\n`; // execd 1.1.0 delivers lines without their terminator; newer versions keep it
					arr.push(line.slice(0, OUTPUT_CAP - size[which]));
					size[which] += line.length;
				};
				try {
					const ex = await sb.commands.run(
						o.command,
						{ workingDirectory: o.cwd, envs: o.env ? { ...o.env } : undefined, timeoutSeconds: Math.max(1, Math.ceil(o.timeoutMs / 1000)), ...(o.privileged ? {} : { uid: WORKLOAD_UID, gid: WORKLOAD_UID }) },
						{
							skipAccumulation: true,
							onInit: (i: { id: string }) => void (execId = i.id),
							onStdout: (m: SdkMsg) => (take(out, "o", m.text), o.onStdout?.(/[\r\n]$/.test(m.text) ? m.text : `${m.text}\n`)),
							onStderr: (m: SdkMsg) => (take(err, "e", m.text), o.onStderr?.(/[\r\n]$/.test(m.text) ? m.text : `${m.text}\n`)),
						},
						ac.signal,
					);
					const code = ex.exitCode ?? ex.error?.exitCode ?? (ex.error ? null : 0);
					const stdout = out.join("");
					let stderr = err.join("");
					if (ex.error && code === null) stderr += `${ex.error.name ?? "error"}: ${ex.error.value ?? ""}\n`;
					// execd reports exit -1 ("signal: killed") both for its own timeout and for an external kill.
					const status: ExecResult["status"] = code === 0 ? "ok" : code === -1 ? (Date.now() - started >= o.timeoutMs - 1500 ? "timeout" : "killed") : "error";
					return { status, exitCode: code === -1 ? null : code, stdout, stderr };
				} catch (e: any) {
					if (ac.signal.aborted) {
						// Aborting the request makes execd drop the process (verified); interrupt explicitly as well.
						if (execId) await sb.commands.interrupt(execId).catch(() => {});
						return { status: deadline ? "timeout" : "killed", exitCode: null, stdout: out.join(""), stderr: err.join("") };
					}
					throw new Error(`OpenSandbox 执行失败：${clean(msgOf(e), key)}`);
				} finally {
					clearTimeout(timer);
					o.signal?.removeEventListener("abort", link);
				}
			},
			async writeFile(path, bytes) {
				await wrap("写文件", sb.files.writeFiles([{ path, data: bytes, mode: 644 }]));
			},
			async readFile(path, maxBytes) {
				let info: Record<string, SdkFileInfo>;
				try {
					info = await sb.files.getFileInfo([path]);
				} catch (e) {
					if (isMissing(e)) throw new Error(`远端文件不存在：${path}`);
					throw new Error(`OpenSandbox 读文件失败：${clean(msgOf(e), key)}`);
				}
				const fi = info[path];
				if (!fi) throw new Error(`远端文件不存在：${path}`);
				if (fi.type && fi.type !== "file") throw new Error(`远端路径不是普通文件：${path}`);
				if ((fi.size ?? 0) > maxBytes) throw new Error(`远端文件过大（${fi.size} 字节，上限 ${maxBytes}）`);
				return wrap("读文件", sb.files.readBytes(path));
			},
			async list(dir) {
				const prefix = dir.replace(/\/+$/, "");
				let items: SdkFileInfo[];
				try {
					items = await sb.files.listDirectory({ path: prefix || "/", depth: 64 });
				} catch (e) {
					if (isMissing(e)) return [];
					throw new Error(`OpenSandbox 列目录失败：${clean(msgOf(e), key)}`);
				}
				const out: RemoteEntry[] = [];
				for (const it of items) {
					if (!it.path.startsWith(`${prefix}/`)) continue; // anything not strictly below the listed directory is dropped
					const kind = it.type === "file" || it.type === "directory" || it.type === "symlink" ? it.type : "other";
					out.push({ path: it.path.slice(prefix.length + 1), kind, size: it.size ?? 0, ...(it.modifiedAt ? { mtimeMs: it.modifiedAt.getTime() } : {}) });
				}
				return out;
			},
			async remove(path) {
				const r = await this.exec({ command: `rm -rf -- '${path.replace(/'/g, `'\\''`)}'`, cwd: "/", timeoutMs: 60_000, privileged: true });
				if (r.status !== "ok") throw new Error(`OpenSandbox 删除失败：${r.stderr.trim().slice(0, 200)}`);
			},
			async mkdir(path) {
				await wrap("建目录", sb.files.createDirectories([{ path, mode: 755 }]));
			},
			async keepAlive(lifetimeMs) {
				await wrap("续期", sb.renew(Math.max(60, Math.ceil(lifetimeMs / 1000))));
			},
		};
	}

	/** Poll GET sandbox until `want` (or fail on Failed/Terminated). Pause/resume requests are asynchronous (202). */
	async function waitState(mgr: SdkManager, id: string, want: string, timeoutMs: number, what: string): Promise<void> {
		const until = Date.now() + timeoutMs;
		for (;;) {
			const st = (await mgr.getSandboxInfo(id)).status.state;
			if (st === want) return;
			if (st === "Failed" || st === "Terminated") throw new Error(`OpenSandbox ${what}失败：沙箱状态为 ${st}`);
			if (Date.now() > until) throw new Error(`OpenSandbox ${what}超时（当前状态 ${st}）`);
			await new Promise((r) => setTimeout(r, 300));
		}
	}
	/** Bring a Paused/Pausing/Resuming sandbox to Running; true when it is Running afterwards, false when it does not exist or is gone. */
	async function ensureRunning(mod: SdkModule, cfg: unknown, id: string, signal?: AbortSignal): Promise<boolean> {
		const mgr = mod.SandboxManager.create({ connectionConfig: cfg });
		try {
			let st: string;
			try {
				st = (await mgr.getSandboxInfo(id)).status.state;
			} catch (e: any) {
				if (isMissing(e)) return false;
				throw e;
			}
			if (st === "Running") return true;
			if (st === "Terminated" || st === "Failed") return false;
			if (signal?.aborted) throw new Error("已取消");
			if (st === "Pausing") await waitState(mgr, id, "Paused", 30_000, "等待暂停完成");
			if (st !== "Resuming") await mgr.resumeSandbox(id);
			await waitState(mgr, id, "Running", 60_000, "恢复");
			return true;
		} finally {
			await mgr.close().catch(() => {});
		}
	}

	const provider: RemoteProvider & { close(): Promise<void> } = {
		id: ID,
		label: "OpenSandbox",
		capabilities: OPENSANDBOX_CAPABILITIES,

		async health(signal) {
			try {
				const { mod, cfg } = await load();
				// Auth + reachability: an authenticated, cheap lifecycle call. (`/health` alone does not check the key.)
				const mgr = mod.SandboxManager.create({ connectionConfig: cfg });
				try {
					await mgr.listSandboxInfos({ pageSize: 1 });
				} finally {
					await mgr.close().catch(() => {});
				}
				let version: string | undefined;
				try {
					const r = await fetch(`${url}/openapi.json`, { signal: signal ?? AbortSignal.timeout(5000), redirect: "manual" });
					if (r.ok) {
						const v = String(((await r.json()) as any)?.info?.version ?? "").slice(0, 30);
						if (v) version = `API schema ${v}`; // the server reports its OpenAPI schema version, not the package version
					}
				} catch {
					/* version is optional */
				}
				return { ok: true, detail: "OpenSandbox 服务可达，密钥有效", ...(version ? { version } : {}) } satisfies ProviderHealth;
			} catch (e: any) {
				const st = statusOf(e);
				const why = e instanceof HttpError ? e.message : st === 401 || st === 403 ? "API 密钥被拒绝" : clean(msgOf(e), key);
				return { ok: false, detail: `OpenSandbox 不可用：${why}`.slice(0, 300) };
			}
		},

		async create(o: CreateOptions) {
			const { mod, cfg } = await load();
			const resource: Record<string, string> = {};
			if (o.resources?.diskGb !== undefined) throw new UnsupportedError("opensandbox", "创建时指定磁盘大小");
			if (o.resources?.cpus) resource.cpu = String(o.resources.cpus);
			// explicit memory wins; otherwise the platform's generic per-sandbox limit is applied as before
			const memMb = o.resources?.memoryGb ? Math.round(o.resources.memoryGb * 1024) : o.defaultMemoryMb;
			if (memMb) resource.memory = `${Math.max(64, Math.floor(memMb))}Mi`;
			try {
				const sb = await mod.Sandbox.create({
					connectionConfig: cfg,
					image,
					timeoutSeconds: Math.max(60, Math.ceil(o.lifetimeMs / 1000)),
					metadata: { ...o.metadata },
					...(o.env ? { env: { ...o.env } } : {}),
					...(Object.keys(resource).length ? { resource } : {}),
					// Round 9: NO networkPolicy — Workroom neither restricts nor requests egress; the OpenSandbox server's defaults/config apply.
					readyTimeoutSeconds: Math.max(10, Math.ceil(o.createTimeoutMs / 1000)),
					signal: o.signal,
				});
				return session(sb);
			} catch (e: any) {
				if (e instanceof HttpError) throw e;
				const m = clean(msgOf(e), key);
				throw new Error(`OpenSandbox 创建沙箱失败：${m}`);
			}
		},

		async connect(id, signal) {
			const { mod, cfg } = await load();
			try {
				const sb = await mod.Sandbox.connect({ sandboxId: id, connectionConfig: cfg, skipHealthCheck: false, readyTimeoutSeconds: 30, signal });
				const st = (await sb.getInfo()).status.state;
				if (st !== "Running") return null; // Terminated / Failed / Paused / Pending: the caller recreates (pause/resume is not used)
				return session(sb);
			} catch (e: any) {
				if (isMissing(e)) return null;
				throw new Error(`OpenSandbox 连接沙箱失败：${clean(msgOf(e), key)}`);
			}
		},

		async pause(id, o: PauseOptions) {
			const { mod, cfg } = await load();
			const mgr = mod.SandboxManager.create({ connectionConfig: cfg });
			try {
				// A paused sandbox still expires at its TTL (verified live): extend it to the retention window first (best effort; a failure only shortens the fast-resume window).
				await mgr.renewSandbox(id, Math.max(60, Math.ceil(o.retainMs / 1000))).catch(() => {});
				await mgr.pauseSandbox(id);
				await waitState(mgr, id, "Paused", 30_000, "暂停");
			} catch (e: any) {
				throw new Error(`OpenSandbox 暂停失败：${clean(msgOf(e), key)}`);
			} finally {
				await mgr.close().catch(() => {});
			}
		},

		async resume(id, signal) {
			const { mod, cfg } = await load();
			try {
				if (!(await ensureRunning(mod, cfg, id, signal))) return null;
				const sb = await mod.Sandbox.connect({ sandboxId: id, connectionConfig: cfg, skipHealthCheck: false, readyTimeoutSeconds: 30, signal });
				return session(sb);
			} catch (e: any) {
				if (isMissing(e)) return null;
				throw new Error(`OpenSandbox 恢复失败：${clean(msgOf(e), key)}`);
			}
		},

		async list(metadata) {
			const { mod, cfg } = await load();
			const mgr = mod.SandboxManager.create({ connectionConfig: cfg });
			try {
				const out: RemoteSandboxInfo[] = [];
				for (let page = 1; page <= 50; page++) {
					const r = await mgr.listSandboxInfos({ metadata: { ...metadata }, page, pageSize: 100 });
					for (const i of r.items) if (i.status.state !== "Terminated") out.push({ id: i.id, state: i.status.state, metadata: i.metadata ?? {}, ...(i.createdAt ? { createdAt: new Date(i.createdAt).toISOString() } : {}) });
					if (!r.pagination?.hasNextPage) break;
				}
				return out;
			} catch (e: any) {
				throw new Error(`OpenSandbox 列表失败：${clean(msgOf(e), key)}`);
			} finally {
				await mgr.close().catch(() => {});
			}
		},

		async destroy(id) {
			const { mod, cfg } = await load();
			const mgr = mod.SandboxManager.create({ connectionConfig: cfg });
			try {
				await mgr.killSandbox(id);
			} catch (e: any) {
				if (isMissing(e)) return; // idempotent
				throw new Error(`OpenSandbox 销毁失败：${clean(msgOf(e), key)}`);
			} finally {
				await mgr.close().catch(() => {});
			}
		},

		async close() {
			if (!sdk) return;
			const { cfg } = await sdk.catch(() => ({ cfg: undefined as any }));
			await cfg?.closeTransport?.().catch?.(() => {});
		},
	};
	return provider;
}
