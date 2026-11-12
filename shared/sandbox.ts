// Sandbox drivers, workspace file API and admin status (round 4, SANDBOX group). Existing run/limit DTOs stay in shared/files.ts.
import type { SandboxLimitsDTO } from "./files.ts";

export type SandboxDriverId = "namespaces" | "docker" | "none";
export type SandboxDriverSetting = "auto" | SandboxDriverId;
export type SandboxDriverState = "ready" | "needs_setup" | "unavailable";

export interface SandboxDriverStatusDTO {
	readonly id: SandboxDriverId;
	readonly label: string;
	readonly state: SandboxDriverState;
	/** One line, safe for every member. */
	readonly summary: string;
	/** Admin-only diagnostics (versions, paths, image names). Empty for non-admins. */
	readonly details: readonly string[];
	readonly howToEnable?: string;
	readonly checkedAt: string;
	readonly capabilities: { readonly network: boolean; readonly services: boolean; readonly mounts: boolean; readonly cgroupLimits: boolean; readonly hostRuntimes: boolean };
	/** What the driver really isolates / does not isolate. */
	readonly isolates: readonly string[];
	readonly doesNotIsolate: readonly string[];
}

export interface SandboxDockerSettingsDTO {
	readonly image: string;
	readonly pythonImage: string;
	readonly nodeImage: string;
	readonly cpus: number;
	readonly autoPull: boolean;
	readonly bin?: string;
	readonly host?: string;
}

export interface SandboxPrepareDTO {
	readonly mode: "pull" | "build";
	readonly state: "running" | "done" | "failed";
	readonly startedAt: string;
	readonly finishedAt?: string;
	readonly log: readonly string[];
}

/** GET /api/sandbox/driver (org admins / sandbox.manage; members get `canManage: false` and no details) */
export interface SandboxDriverAdminDTO {
	/** What the admin chose (`auto` = first available of namespaces, docker). */
	readonly setting: SandboxDriverSetting;
	/** What is actually used right now. */
	readonly effective: SandboxDriverId;
	/** Why `effective` was chosen (or why nothing is available). */
	readonly reason: string;
	/** @deprecated Round 9: no Workroom network policy. Read-only mirror of what the active driver can do ("allowed" = it can reach a network); use `networkText`. */
	readonly network: "none" | "allowed";
	/** Round 9: what the active driver / provider actually gives, in plain words (a capability or a deployment setting, never a Workroom switch). */
	readonly networkText?: string;
	/** Round 9: the Docker network of sandbox containers, set by the DEPLOYMENT (env WORKROOM_DOCKER_NETWORK; "bridge" = Docker default). Not editable here. */
	readonly dockerNetwork?: { readonly name: string; readonly source: "default" | "env" | "invalid"; readonly warning?: string };
	/** Round 9: removed settings still present (old row / env) and ignored; also lists a `network` field sent to PUT. */
	readonly deprecations?: readonly string[];
	readonly docker: SandboxDockerSettingsDTO;
	readonly drivers: readonly SandboxDriverStatusDTO[];
	readonly prepare?: SandboxPrepareDTO;
	readonly maxConcurrent: number;
	readonly services: readonly { readonly key: string; readonly id: string; readonly runtime: string; readonly startedAt: string; readonly lastActivityAt: string; readonly driver: SandboxDriverId; readonly running: boolean }[];
	readonly canManage: boolean;
	/** True while the admin's setting is not yet persisted (value comes from WORKROOM_SANDBOX_DRIVER or the default). */
	readonly fromEnvironment: boolean;
}
/** PUT /api/sandbox/driver */
export interface SandboxDriverUpdate {
	readonly driver?: SandboxDriverSetting;
	/** @deprecated Round 9: accepted and ignored (the response says so in `deprecations`). */
	readonly network?: "none" | "allowed";
	readonly docker?: Partial<SandboxDockerSettingsDTO>;
	readonly maxConcurrent?: number;
}

/** GET /api/sandbox/:spaceId — compatible superset of the old info (isolation is the active driver id, or "unavailable"). */
export interface SandboxInfoDTO {
	readonly spaceId: string;
	readonly isolation: "namespaces" | "docker" | "unavailable";
	readonly isolationDetail: string;
	readonly driver: { readonly id: SandboxDriverId; readonly label: string; readonly state: SandboxDriverState; readonly summary: string; readonly howToEnable?: string; /** @deprecated mirror of the driver's capability; use `networkText`. */ readonly network: "none" | "allowed"; readonly networkText?: string };
	readonly limits: SandboxLimitsDTO;
	readonly retentionHours: number;
	readonly usedBytes: number;
	readonly quotaBytes: number;
	/** Round 10: the working directory inside the sandbox of this space ("/work" for local drivers, the provider's configured/default directory for a remote one). */
	readonly workDir?: string;
}

// ---------------- workspace (/work of a conversation) ----------------
export interface WorkspaceEntryDTO {
	readonly path: string;
	readonly kind: "file" | "directory";
	readonly size: number;
	readonly mtime: string;
	/** Absent for the persistent folders (memories/, project/): they do not expire. */
	readonly expiresAt?: string;
	readonly symlink?: boolean;
}
export interface WorkspaceUsageDTO {
	/** Bytes in this conversation's workspace. */
	readonly conversationBytes: number;
	/** Bytes in all workspaces of the space (what the quota applies to). */
	readonly spaceBytes: number;
	readonly quotaBytes: number;
	readonly maxFileBytes: number;
	readonly retentionHours: number;
	readonly fileCount: number;
}
/** GET /api/sandbox/:spaceId/files?conversationId= */
export interface WorkspaceFilesResponse {
	readonly entries: WorkspaceEntryDTO[];
	readonly usage: WorkspaceUsageDTO;
	/** More than the listing cap exist. */
	readonly truncated: boolean;
	/** Whether the caller may write (upload / mkdir / delete / publish). */
	readonly canWrite: boolean;
}
/** GET /api/sandbox/:spaceId/preview?path=&conversationId= */
export interface WorkspacePreviewDTO {
	readonly path: string;
	readonly name: string;
	readonly size: number;
	readonly mime: string;
	readonly mtime: string;
	/** Absent for files in the persistent folders (memories/, project/). */
	readonly expiresAt?: string;
	/** text: `text` holds up to 256 KB; image: render from the inline URL; binary: download only. */
	readonly kind: "text" | "image" | "binary";
	readonly text?: string;
	readonly truncated?: boolean;
	/** Language hint for text files (md, json, csv, py, …). */
	readonly language?: string;
}

// ---------------- work panel ----------------
export type WorkTabId = "tasks" | "terminal" | "files" | "browser";
/** Sandbox tools that read or write the workspace files: their result opens the 文件 tab. */
export const WORKSPACE_FILE_TOOLS: readonly string[] = ["sandbox_list", "sandbox_write_file", "sandbox_read_file", "sandbox_import", "sandbox_publish"];
/** Which work-panel tab shows the result of a tool call (null = none). */
export function workTabForTool(toolName: string): WorkTabId | null {
	if (WORKSPACE_FILE_TOOLS.includes(toolName)) return "files";
	if (toolName.startsWith("sandbox")) return "terminal";
	if (toolName === "browse" || toolName.startsWith("browser")) return "browser";
	if (toolName === "delegate" || toolName.startsWith("team")) return "tasks";
	return null;
}

// ---------------- round 7: pluggable remote sandbox providers (integrator-owned contract) ----------------
// Server types: server/src/tools/sandbox/provider.ts. Remote ids extend SandboxDriverId on the server side; the UI uses these DTOs.

export type SandboxProviderId = "opensandbox" | "e2b" | "daytona";
export type CapabilitySupport = "supported" | "unverified" | "unsupported";

export interface SandboxProviderCapabilitiesDTO {
	readonly exec: CapabilitySupport;
	readonly streamOutput: CapabilitySupport;
	readonly cancel: CapabilitySupport;
	readonly commandTimeout: CapabilitySupport;
	readonly files: CapabilitySupport;
	/** @deprecated Round 9: not used by Workroom (it never asks a provider to deny network). Kept for older clients. */
	readonly networkOff: CapabilitySupport;
	/** Whether a sandbox of this provider could be verified to reach the network with the provider's defaults (informational; the provider decides). */
	readonly networkOn: CapabilitySupport;
	readonly resourceLimits: CapabilitySupport;
	readonly reconnect: CapabilitySupport;
	readonly services: CapabilitySupport;
	readonly pty: CapabilitySupport;
	readonly preview: CapabilitySupport;
	readonly snapshot: CapabilitySupport;
	readonly pauseResume: CapabilitySupport;
	readonly skills: "upload_readonly" | "unsupported";
	readonly isolation: string;
	readonly location: "self_hosted" | "vendor_cloud" | "configurable";
}

/** One provider's admin configuration as the UI sees it. The API key is NEVER returned: only whether one is stored and its last 4 chars. */
export interface SandboxProviderConfigDTO {
	readonly provider: SandboxProviderId;
	readonly label: string;
	/** Round 10: this provider is THE active channel (only one provider is enabled at a time; enabling one disables the others and makes it the org default). */
	readonly enabled: boolean;
	readonly endpoint?: string;
	/** E2B-compatible services: sandbox domain. */
	readonly domain?: string;
	readonly template?: string;
	/** Daytona only: image-based creation (the only Daytona mode that accepts explicit resources). */
	readonly image?: string;
	/** Explicit admin-configured sandbox size (absent = template / snapshot / provider default). cpus in cores, memory/disk in GiB. */
	readonly resources?: SandboxResourcesDTO;
	/** Round 10: working directory INSIDE the sandbox as configured by the admin (absent = the provider default, see `defaultWorkDir`). */
	readonly workDir?: string;
	/** Round 10: the deterministic default used while `workDir` is empty (opensandbox /work, e2b /home/user/work, daytona /home/daytona/work). Always set by the server. */
	readonly defaultWorkDir?: string;
	readonly apiKeySet: boolean;
	readonly apiKeyHint?: string;
	/** The endpoint resolves to a private/internal address and the admin explicitly allowed that (self-hosted intranet). */
	readonly allowPrivateNetwork: boolean;
	/** Vendor-cloud providers: admin acknowledged that workspace files and commands leave the organisation. Required to enable. */
	readonly egressAcknowledged: boolean;
	readonly createTimeoutSec: number;
	/** Round 11: idle seconds before the sandbox is paused (default 300). Replaces idleTimeoutSec. */
	readonly idlePauseSec: number;
	/** Round 11: fast-resume window in seconds, counted from the pause (default 86400); afterwards archived (Daytona) or left paused. */
	readonly pausedRetentionSec: number;
	/** Round 11: unused for this many seconds → destroyed for good (default 604800). Replaces lifetimeSec. */
	readonly destroyAfterSec: number;
	readonly capabilities: SandboxProviderCapabilitiesDTO;
	/** Installed SDK package + exact version (or "not installed"). */
	readonly sdk: { readonly name: string; readonly version: string | null };
	readonly lastTest?: SandboxProviderTestDTO;
	readonly updatedAt?: string;
}

/** POST /api/sandbox/providers/:provider/test — never echoes credentials. */
export interface SandboxProviderTestDTO {
	readonly ok: boolean;
	readonly at: string;
	/** "health" = reachability/auth only; "roundtrip" = created a throwaway sandbox, ran a command, wrote/read a file, destroyed it. */
	readonly kind: "health" | "roundtrip";
	readonly detail: string;
	readonly version?: string;
	readonly durationMs: number;
	/** Steps of a roundtrip test with their own result (create / exec / file / destroy). */
	readonly steps?: readonly { readonly step: string; readonly ok: boolean; readonly ms: number; readonly detail?: string }[];
}

/** PUT /api/sandbox/providers/:provider (sandbox.policy.manage). `apiKey: null` deletes the stored key; omitted keeps it. */
export interface SandboxProviderUpdate {
	readonly enabled?: boolean;
	readonly endpoint?: string;
	readonly domain?: string;
	readonly template?: string;
	/** Daytona image ("" clears). */
	readonly image?: string;
	/** Explicit resources; null clears (back to template / snapshot / provider default). Refused where the provider/creation mode cannot honour them. */
	readonly resources?: SandboxResourcesDTO | null;
	/** Round 10: working directory inside the sandbox: absolute normalised POSIX path (no "..", not "/" or a system directory, <= 200 chars); null or "" clears it (provider default). Changing it re-syncs the workspace into the new directory. */
	readonly workDir?: string | null;
	readonly apiKey?: string | null;
	readonly allowPrivateNetwork?: boolean;
	readonly egressAcknowledged?: boolean;
	readonly createTimeoutSec?: number;
	/** 60..86400 s. */
	readonly idlePauseSec?: number;
	/** 300..2592000 s. */
	readonly pausedRetentionSec?: number;
	/** 3600..7776000 s; must be >= idlePauseSec + pausedRetentionSec. */
	readonly destroyAfterSec?: number;
}

/** Which sandbox channel the organisation uses (round 10: exactly ONE at a time, enforced on the server). */
export interface SandboxSelectionPolicyDTO {
	/** The active channel for every space: a cloud provider, or "local" = 平台内置沙箱 (the server's own driver setting: auto/namespaces/docker). */
	readonly orgDefault: "local" | SandboxProviderId;
	/** @deprecated Round 10: per-project choice was removed; always false. A PUT with `true` is refused. */
	readonly allowProjectOverride: false;
}

/** GET /api/sandbox/providers (admins: full; members: 403). */
export interface SandboxProvidersAdminDTO {
	readonly providers: readonly SandboxProviderConfigDTO[];
	readonly policy: SandboxSelectionPolicyDTO;
	/** Server can store secrets (WORKROOM_SECRET_KEY configured). */
	readonly secretStorage: boolean;
	readonly canManage: boolean;
}

/** Remote sandbox instances Workroom tracks (admin view). */
export interface SandboxInstanceDTO {
	readonly id: string;
	readonly provider: SandboxProviderId;
	readonly spaceId: string;
	readonly workspaceKey: string;
	readonly remoteId: string | null;
	/** Round 11 added pausing / paused / resuming / archived. */
	readonly state: "creating" | "ready" | "pausing" | "paused" | "resuming" | "archived" | "stopping" | "destroyed" | "lost" | "error";
	/** Round 11: how a paused instance comes back: "provider" = the vendor kept it (fast), "recreate" = the sandbox was destroyed and is rebuilt from the host workspace. */
	readonly resumeMode?: "provider" | "recreate";
	readonly createdAt: string;
	readonly lastUsedAt: string;
	readonly expiresAt?: string;
	readonly lastError?: string;
}

// ---------------- round 8: execution environment of a conversation (integrator-owned contract) ----------------
/** GET /api/conversations/:spaceId/:conversationId/environment — what runs this conversation's commands. Never creates anything. */
export interface ConversationEnvironmentDTO {
	/** "local": a sandbox driver on the Workroom server (nothing to prepare); "remote": a provider sandbox that may need creating/restoring. */
	readonly kind: "local" | "remote" | "none";
	/** Driver / provider id actually in effect for this space ("namespaces" | "docker" | "opensandbox" | "e2b" | "daytona" | "none"). */
	readonly id: string;
	/** Plain label, e.g. "平台内置沙箱（Docker）", "OpenSandbox（自托管）". */
	readonly label: string;
	readonly location: "this_server" | "self_hosted" | "vendor_cloud";
	/** One plain sentence on isolation (honest, from the driver/provider notes). */
	readonly isolation: string;
	/** @deprecated Round 9: capability mirror ("allowed" = the driver/provider may reach a network); show `networkText`. */
	readonly network: "none" | "allowed";
	/** Round 9: plain text: "可联网" / "无网络（本机命名空间驱动的技术限制）" / "由提供方决定…". Never a Workroom policy. */
	readonly networkText?: string;
	/**
	 * none      = no remote sandbox exists for this conversation yet (created on first need — not by opening this panel)
	 * preparing = being created / reconnected / restored right now
	 * ready     = exists and was verified on last use
	 * failed    = last prepare failed (see error); a retry is possible
	 * lost      = it expired or was removed; the next command recreates it and restores saved files
	 * paused    = (round 11) idle for a while and paused/stopped to save cost; the next command resumes it (see `resumeMode` for how fast)
	 * resuming  = (round 11) being brought back from paused/archived right now ("preparing" stays = a first-time/recreate provisioning)
	 * For kind "local" the state is always "ready" (or "failed" when the driver is unavailable).
	 */
	readonly state: "none" | "preparing" | "ready" | "failed" | "lost" | "paused" | "resuming";
	/**
	 * Round 11, only with state "paused" / "resuming": how the workspace comes back.
	 * "fast"     = the provider kept the paused sandbox (files and installed dependencies survive; resumes in seconds)
	 * "archived" = the provider moved it to cold storage (files and dependencies survive; slower)
	 * "recreate" = the provider cannot pause: the sandbox was destroyed, a new one is created from the host workspace (files survive, installed dependencies do not)
	 */
	readonly resumeMode?: "fast" | "archived" | "recreate";
	readonly error?: string;
	readonly updatedAt?: string;
	/** True when an explicit prepare/retry is possible (remote, write access). */
	readonly canPrepare: boolean;
	/** Round 10: the real working directory of this conversation INSIDE the sandbox (every command runs there; "/work" for local drivers). Always set by the server. */
	readonly workDir?: string;
	/** Round 10: where read-only skills are mounted inside the sandbox ("/skills" for local drivers, next to the working directory for a remote provider). */
	readonly skillsDir?: string;
}

/** Explicit sandbox size an admin sets per provider (round 10). */
export interface SandboxResourcesDTO {
	readonly cpus?: number;
	readonly memoryGb?: number;
	readonly diskGb?: number;
}
