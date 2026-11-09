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
