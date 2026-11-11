// Sandbox driver contract. A driver turns "run this code / this argv with these mounts and limits" into an isolated process.
// Drivers: `namespaces` (Linux user/mount/pid/net namespaces, no daemon), `docker` (Docker CLI: Docker Desktop on Windows/macOS,
// Docker Engine on Linux), `none` (nothing available; every call fails with a message that explains how to enable one).
// The `Sandbox` service (../sandbox.ts) owns policy (quota, run records, ACL, mount providers); drivers only isolate.
import type { Readable, Writable } from "node:stream";
import type { SandboxLimitsDTO } from "../../../../shared/files.ts";
import type { ProviderId } from "./provider.ts";

/** Local drivers, or a remote provider id (round 7: "opensandbox" | "e2b" | "daytona", implemented by RemoteDriver). */
export type DriverId = LocalDriverId | ProviderId;
/** The drivers that run on this host. */
export type LocalDriverId = "namespaces" | "docker" | "none";
export type Language = "shell" | "python" | "node";
/** Runtime a long-running service needs (selects the image for the docker driver; the namespace driver uses host runtimes). */
export type ServiceRuntime = "python" | "node" | "shell";

/**
 * A host directory made visible inside the sandbox.
 * - `hostPath`: absolute path on the machine running the server (native format, e.g. `C:\Users\me\data\sandbox-mounts\skills\x`).
 *   The Sandbox service validates it (must exist, must live under an allowed mount root — see `Sandbox.mountsRoot()`), the driver translates it
 *   (Windows drive letters for Docker Desktop, path maps when the server itself runs in a container).
 * - `target`: absolute POSIX path inside the sandbox, e.g. `/skills/pdf-report`. Reserved: `/`, `/work`, `/tmp`, `/code`, `/proc`, `/dev`, `/sys`, `/etc`, `/usr`, `/bin`, `/lib*`, `/sbin`, `/runtime`.
 * - `readOnly`: enforced by the kernel (bind remount ro / docker `readonly`). Mounts that are not read-only are only accepted for
 *   hostPaths under the conversation's own workspace tree.
 */
export interface SandboxMount {
	readonly hostPath: string;
	readonly target: string;
	readonly readOnly: boolean;
}

export type RunStatus = "ok" | "error" | "timeout" | "killed";
export interface RunResult {
	status: RunStatus;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
}

/** What the driver can do to a running process later (stale cleanup after a crash). */
export interface ProcessRef {
	readonly driver: DriverId;
	readonly pid?: number;
	/** docker: container name (labelled `workroom.sandbox=1`). */
	readonly container?: string;
}

/** Who the workspace belongs to. Set by Sandbox.run; local drivers ignore it, RemoteDriver needs it to find "its" remote sandbox. */
export interface DriverTenant {
	readonly orgId: string;
	readonly spaceId: string;
	/** "c<conversationId>" or "shared". */
	readonly workspaceKey: string;
}

export interface DriverRunSpec {
	readonly runId: string;
	/** Round 7 (optional, additive): required by RemoteDriver, ignored by the local drivers. */
	readonly tenant?: DriverTenant;
	/** Host directory the driver may use for per-run scratch (`<scratchBase>/.runs/<runId>`); removed by the driver when the run ends. */
	readonly scratchBase: string;
	/** Host directory mounted read-write at /work. */
	readonly workdir: string;
	readonly exec: { readonly language: Language; readonly code: string } | { readonly argv: readonly string[]; readonly runtime?: ServiceRuntime };
	readonly limits: SandboxLimitsDTO;
	readonly mounts: readonly SandboxMount[];
	readonly env: Readonly<Record<string, string>>;
	/**
	 * Round 9: no Workroom policy any more. `true` = the driver's own network applies (docker: WORKROOM_DOCKER_NETWORK, default bridge; remote:
	 * whatever the provider gives; namespaces: none, technical limit). `false` is used ONLY by server-internal isolated jobs (execIsolated:
	 * rendering untrusted documents), which stay offline.
	 */
	readonly network: boolean;
	readonly signal?: AbortSignal;
	readonly onSpawn?: (ref: ProcessRef) => void;
}

export interface DriverServiceSpec {
	readonly serviceId: string;
	readonly scratchBase: string;
	readonly workdir: string;
	readonly argv: readonly string[];
	readonly runtime: ServiceRuntime;
	/** Directory inside the sandbox (default /work). */
	readonly cwd?: string;
	readonly limits: SandboxLimitsDTO;
	readonly mounts: readonly SandboxMount[];
	readonly env: Readonly<Record<string, string>>;
	readonly network: boolean;
	readonly onSpawn?: (ref: ProcessRef) => void;
}

/** A long-lived process with stdin/stdout piped to the server. Stopping it kills everything it started. */
export interface DriverServiceProcess {
	readonly ref: ProcessRef;
	readonly stdin: Writable;
	readonly stdout: Readable;
	readonly stderr: Readable;
	/** Resolves once the whole sandbox is gone. */
	readonly exited: Promise<{ exitCode: number | null; signal: string | null }>;
	/** Idempotent. Guarantees the sandbox (all descendants) is dead and its scratch/container removed when the promise resolves. */
	kill(): Promise<void>;
}

export interface DriverCapabilities {
	/** The driver can give a run/service network access (a technical capability, not a policy; docker: false only if the operator set WORKROOM_DOCKER_NETWORK=none). */
	readonly network: boolean;
	/** Supports startService(). */
	readonly services: boolean;
	/** Supports mounts[] (all drivers except `none`). */
	readonly mounts: boolean;
	/** Memory/CPU/pids are cgroup totals (docker) rather than per-process rlimits (namespaces). */
	readonly cgroupLimits: boolean;
	/** Runs the host's own python3/node (namespaces) rather than an image. */
	readonly hostRuntimes: boolean;
}

export type DriverState = "ready" | "needs_setup" | "unavailable";
export interface DriverStatus {
	readonly id: DriverId;
	readonly state: DriverState;
	/** One line, safe to show to every member. */
	readonly summary: string;
	/** Diagnostic lines for admins (versions, image names, probe errors). */
	readonly details: readonly string[];
	/** Human steps to turn this driver on (shown when not ready). */
	readonly howToEnable?: string;
	readonly checkedAt: string;
}

export interface IsolationNotes {
	/** What the driver really isolates. */
	readonly isolates: readonly string[];
	/** What it does not (honest limits). */
	readonly doesNotIsolate: readonly string[];
}

export interface SandboxDriver {
	readonly id: DriverId;
	readonly label: string;
	readonly capabilities: DriverCapabilities;
	readonly notes: IsolationNotes;
	/** Probe this host. Cheap results are cached by the registry; `force` bypasses the driver's own cache. */
	detect(force?: boolean): Promise<DriverStatus>;
	run(spec: DriverRunSpec): Promise<RunResult>;
	startService(spec: DriverServiceSpec): Promise<DriverServiceProcess>;
	/** Kill leftovers from a previous server process (crash/restart). Returns how many sandboxes were removed. */
	reapStale(): Promise<number>;
	/** Kill one specific leftover (job recovery). */
	killStale(ref: ProcessRef): Promise<boolean>;
}

export const RESERVED_TARGETS = ["/", "/work", "/tmp", "/code", "/proc", "/dev", "/sys", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/runtime", "/run", "/var"];

/** Validate and normalise a mount target (POSIX, absolute, no `..`, not reserved or inside a reserved system directory). */
export function normalizeTarget(target: string): string {
	if (typeof target !== "string" || !target.startsWith("/") || target.includes("\0") || target.includes("\\") || target.includes(",") || /[\r\n"]/.test(target)) throw new Error(`mount target must be an absolute POSIX path: ${JSON.stringify(target)}`);
	const parts: string[] = [];
	for (const seg of target.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") throw new Error(`mount target may not contain '..': ${target}`);
		parts.push(seg);
	}
	const t = `/${parts.join("/")}`;
	if (t === "/" || RESERVED_TARGETS.some((r) => r !== "/" && (t === r || t.startsWith(`${r}/`)))) throw new Error(`mount target ${t} is reserved`);
	return t;
}
