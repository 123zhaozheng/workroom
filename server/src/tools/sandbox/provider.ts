// Round 7 contract (integrator-owned): pluggable REMOTE sandbox providers (OpenSandbox, E2B or explicitly compatible endpoints, Daytona).
//
// Architecture: the conversation workspace stays authoritative on the Workroom host (<dataDir>/…/c<conversationId>), exactly as for the
// local drivers. Everything above the driver (file tools, preview, publish, skill drafts, skill materialisation) keeps reading the host
// directory. A remote provider is wrapped by `RemoteDriver` (remote-driver.ts), which implements the existing `SandboxDriver` contract
// (driver.ts) by: get-or-create the remote sandbox for the workspace → upload changed /work files (hash manifest) and the read-only skill
// packages (hash-verified, uploaded — never bind mounts) → exec → download changed /work files back (normalised paths, no symlinks, size limits).
// Nothing here may fall back to the host: an operation a provider cannot do throws `UnsupportedError` (HTTP 501, code "UNSUPPORTED").
import { HttpError } from "../../core/http.ts";

export type ProviderId = "opensandbox" | "e2b" | "daytona";
export const PROVIDER_IDS: readonly ProviderId[] = ["opensandbox", "e2b", "daytona"];

/** "supported": implemented here AND verified against the provider; "unverified": implemented, not yet run against a live service; "unsupported": refused with UnsupportedError. */
export type Support = "supported" | "unverified" | "unsupported";

export interface ProviderCapabilities {
	/** Run a command (shell string) with cwd/env and get exit code + stdout/stderr. */
	readonly exec: Support;
	/** Incremental stdout/stderr callbacks while a command runs. */
	readonly streamOutput: Support;
	/** Cancel a running command (AbortSignal) — must actually stop it remotely, not just stop waiting. */
	readonly cancel: Support;
	/** Per-command timeout enforced remotely (we also enforce a client-side deadline + cancel). */
	readonly commandTimeout: Support;
	/** Read / write / list / remove files and directories. */
	readonly files: Support;
	/** @deprecated Round 9: NOT USED by Workroom (it never asks a provider to deny network). Kept so stored capability snapshots / older clients stay valid. */
	readonly networkOff: Support;
	/** Informational: sandboxes of this provider were seen to reach the network with the provider's own defaults. Workroom neither requests nor restricts it. */
	readonly networkOn: Support;
	/** CPU / memory limits at creation. */
	readonly resourceLimits: Support;
	/** Reconnect to an existing sandbox by id after a Workroom restart. */
	readonly reconnect: Support;
	/** Long-lived stdio process (MCP stdio servers, startService). */
	readonly services: Support;
	readonly pty: Support;
	/** Public/preview URL for a port. */
	readonly preview: Support;
	readonly snapshot: Support;
	readonly pauseResume: Support;
	/** How skill packages reach the sandbox. "upload_readonly" = uploaded, hash-verified, chmod a-w (NOT a kernel read-only mount). */
	readonly skills: "upload_readonly" | "unsupported";
	/** Honest isolation statement shown to admins (e.g. "Firecracker microVM (vendor)", "container via Docker runtime (self-hosted)"). */
	readonly isolation: string;
	/** Where code and workspace files are processed. "vendor_cloud" means data leaves the organisation. */
	readonly location: "self_hosted" | "vendor_cloud" | "configurable";
}

export interface CreateOptions {
	/** Provider template / image / snapshot name; provider default when absent. */
	readonly template?: string;
	readonly env?: Readonly<Record<string, string>>;
	/** Labels written to the remote sandbox (workroom=1, instance id, org hash). Used to find orphans. No secrets, no user data. */
	readonly metadata: Readonly<Record<string, string>>;
	/** Remote lifetime / auto-stop (provider-side). */
	readonly lifetimeMs: number;
	/** Deadline for creation (distinct from command timeout). */
	readonly createTimeoutMs: number;
	// Round 9: no `network` option. Adapters must NOT pass any network-deny/allow option to the provider; vendor defaults apply.
	/**
	 * EXPLICIT resources an admin configured for this provider (never filled from generic platform defaults). An adapter that cannot honour
	 * them in its creation mode must refuse (UnsupportedError) — never silently ignore an explicit setting.
	 */
	readonly resources?: ExplicitResources;
	/** Daytona: create from this image (the only creation mode that accepts `resources`). Other providers: unused. */
	readonly image?: string;
	/**
	 * The platform's generic per-sandbox memory limit, as a HINT. Adapters that support limits in their normal creation mode may apply it
	 * (OpenSandbox); adapters that don't (E2B template, Daytona snapshot) ignore it — it is not a user request.
	 */
	readonly defaultMemoryMb?: number;
	readonly signal?: AbortSignal;
}

/** Admin-configured sandbox size. cpus in cores, memory/disk in GiB. */
export interface ExplicitResources {
	readonly cpus?: number;
	readonly memoryGb?: number;
	readonly diskGb?: number;
}

export interface ExecOptions {
	/** Shell command line (run with /bin/sh -c or the provider's equivalent). */
	readonly command: string;
	readonly cwd: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
	readonly onStdout?: (chunk: string) => void;
	readonly onStderr?: (chunk: string) => void;
	/**
	 * Additive (A1, round 7): run as the sandbox's administrative user (root / sudo) instead of the unprivileged workload user.
	 * RemoteDriver uses it ONLY for its own setup/verify commands (mkdir, chmod, hashing, rm); user code never runs privileged.
	 * A provider whose sandbox has a single user may ignore it; RemoteDriver then reports (in the run notes) that skill directories
	 * are write-protected only by file mode for that user and re-verifies their hash before every run.
	 */
	readonly privileged?: boolean;
}

export interface ExecResult {
	readonly status: "ok" | "error" | "timeout" | "killed";
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export interface RemoteEntry {
	/** Path relative to the listed directory, POSIX separators. */
	readonly path: string;
	readonly kind: "file" | "directory" | "symlink" | "other";
	readonly size: number;
	readonly mtimeMs?: number;
}

/** A connected remote sandbox. */
export interface RemoteSession {
	readonly id: string;
	exec(o: ExecOptions): Promise<ExecResult>;
	writeFile(path: string, bytes: Uint8Array): Promise<void>;
	readFile(path: string, maxBytes: number): Promise<Uint8Array>;
	/** Recursive listing below `dir` (absolute). Must report symlinks as such (never follow). */
	list(dir: string): Promise<RemoteEntry[]>;
	remove(path: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	/** Extend the provider-side lifetime; UnsupportedError if the provider cannot. */
	keepAlive(lifetimeMs: number): Promise<void>;
}

export interface ProviderHealth {
	readonly ok: boolean;
	/** One line, no secrets. */
	readonly detail: string;
	readonly version?: string;
}

export interface RemoteSandboxInfo {
	readonly id: string;
	readonly state: string;
	readonly metadata: Readonly<Record<string, string>>;
	readonly createdAt?: string;
}

export interface RemoteProvider {
	readonly id: ProviderId;
	readonly label: string;
	readonly capabilities: ProviderCapabilities;
	/** Reachability + auth check. Never throws for "down"; returns ok:false with a safe message. */
	health(signal?: AbortSignal): Promise<ProviderHealth>;
	create(o: CreateOptions): Promise<RemoteSession>;
	/** Reconnect by id. Returns null when the sandbox no longer exists (expired / deleted) — caller recreates and re-syncs. */
	connect(id: string, signal?: AbortSignal): Promise<RemoteSession | null>;
	/** Sandboxes carrying `metadata` labels (orphan reaping). UnsupportedError if the provider cannot list. */
	list(metadata: Readonly<Record<string, string>>): Promise<RemoteSandboxInfo[]>;
	/** Idempotent: a missing sandbox is success. */
	destroy(id: string): Promise<void>;
}

/** Provider connection settings, decrypted, for constructing a provider. Never logged. */
export interface ProviderConnection {
	readonly provider: ProviderId;
	/** OpenSandbox server URL; E2B API URL (official or compatible); Daytona API URL. */
	readonly endpoint?: string;
	/** E2B "domain" (sandbox traffic host) when using a compatible service. */
	readonly domain?: string;
	readonly apiKey?: string;
	readonly template?: string;
	/** Daytona image (image-based creation; required for explicit resources). */
	readonly image?: string;
	/** Explicit admin-configured resources (absent = provider/template/snapshot defaults). */
	readonly resources?: ExplicitResources;
	/** Daytona target/region, OpenSandbox extras, etc. Validated per provider. */
	readonly options?: Readonly<Record<string, string>>;
}

export class UnsupportedError extends HttpError {
	constructor(provider: string, what: string) {
		super(501, "UNSUPPORTED", `沙箱提供方 ${provider} 不支持：${what}（已拒绝，不会回退到宿主机执行）`);
	}
}

/** Lifecycle knobs (seconds), admin-configurable per provider; distinct concepts on purpose. */
export interface LifecyclePolicy {
	/** Max time to wait for create(). */
	readonly createTimeoutSec: number;
	/** Destroy the remote sandbox after this much inactivity (Workroom reaper). */
	readonly idleTimeoutSec: number;
	/** Hard maximum age of one remote sandbox; also passed to the provider as its own auto-stop. */
	readonly lifetimeSec: number;
}
export const DEFAULT_LIFECYCLE: LifecyclePolicy = { createTimeoutSec: 120, idleTimeoutSec: 30 * 60, lifetimeSec: 4 * 60 * 60 };
