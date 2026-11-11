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
	readonly network: "none" | "allowed";
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
	readonly network?: "none" | "allowed";
	readonly docker?: Partial<SandboxDockerSettingsDTO>;
	readonly maxConcurrent?: number;
}

/** GET /api/sandbox/:spaceId — compatible superset of the old info (isolation is the active driver id, or "unavailable"). */
export interface SandboxInfoDTO {
	readonly spaceId: string;
	readonly isolation: "namespaces" | "docker" | "unavailable";
	readonly isolationDetail: string;
	readonly driver: { readonly id: SandboxDriverId; readonly label: string; readonly state: SandboxDriverState; readonly summary: string; readonly howToEnable?: string; readonly network: "none" | "allowed" };
	readonly limits: SandboxLimitsDTO;
	readonly retentionHours: number;
	readonly usedBytes: number;
	readonly quotaBytes: number;
}

// ---------------- workspace (/work of a conversation) ----------------
export interface WorkspaceEntryDTO {
	readonly path: string;
	readonly kind: "file" | "directory";
	readonly size: number;
	readonly mtime: string;
	readonly expiresAt: string;
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
	readonly expiresAt: string;
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
	readonly networkOff: CapabilitySupport;
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
	/** Admin turned it on (it can then be chosen as the org default / by projects if allowed). */
	readonly enabled: boolean;
	readonly endpoint?: string;
	/** E2B-compatible services: sandbox domain. */
	readonly domain?: string;
	readonly template?: string;
	readonly apiKeySet: boolean;
	readonly apiKeyHint?: string;
	/** The endpoint resolves to a private/internal address and the admin explicitly allowed that (self-hosted intranet). */
	readonly allowPrivateNetwork: boolean;
	/** Vendor-cloud providers: admin acknowledged that workspace files and commands leave the organisation. Required to enable. */
	readonly egressAcknowledged: boolean;
	readonly createTimeoutSec: number;
	readonly idleTimeoutSec: number;
	readonly lifetimeSec: number;
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
	readonly apiKey?: string | null;
	readonly allowPrivateNetwork?: boolean;
	readonly egressAcknowledged?: boolean;
	readonly createTimeoutSec?: number;
	readonly idleTimeoutSec?: number;
	readonly lifetimeSec?: number;
}

/** Who may pick which sandbox. Enforced on the server. */
export interface SandboxSelectionPolicyDTO {
	/** Org default for every space (personal spaces always use it). "local" = the local driver setting (auto/namespaces/docker). */
	readonly orgDefault: "local" | SandboxProviderId;
	/** Project managers may choose another enabled provider for their project. */
	readonly allowProjectOverride: boolean;
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
	readonly state: "creating" | "ready" | "stopping" | "destroyed" | "lost" | "error";
	readonly createdAt: string;
	readonly lastUsedAt: string;
	readonly expiresAt?: string;
	readonly lastError?: string;
}
