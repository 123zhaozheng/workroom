// DTOs for files, versions, previews, connectors (MCP), skills, sandbox runs and browse (owner: group D).
// Pure types only — imported by web via @shared/files and by the server.

// ---------------- files ----------------
export type FileOrigin = "upload" | "agent" | "automation";

export interface FileProvenanceDTO {
	readonly createdBy: string;
	readonly createdByName?: string;
	readonly spaceId: string;
	readonly projectId?: string;
	readonly conversationId?: number;
	readonly taskId?: number;
	readonly callId?: string;
	readonly submissionId?: number;
	/** File versions used as inputs (e.g. attachments the agent read). */
	readonly inputVersionIds?: readonly string[];
	readonly changeNote?: string;
	readonly origin: FileOrigin;
	/** Tool that produced it, when origin = agent (e.g. "file_create", "browse"). */
	readonly tool?: string;
}

/** Same shape as FileVersionRef in server contracts; carried by tool results as `details.artifact` (file card). */
export interface FileVersionRefDTO {
	readonly fileId: string;
	readonly versionId: string;
	readonly versionNo: number;
	readonly name: string;
	readonly mime: string;
	readonly size: number;
	readonly sha256: string;
}

export type PreviewKind = "text" | "markdown" | "html" | "image" | "pdf" | "docx" | "xlsx" | "pptx" | "csv" | "none";

export interface FileVersionDTO {
	readonly versionId: string;
	readonly versionNo: number;
	readonly name: string;
	readonly size: number;
	readonly mime: string;
	readonly sha256: string;
	readonly createdAt: string;
	readonly createdBy: string;
	readonly changeNote?: string;
	readonly provenance: FileProvenanceDTO;
	/** How the preview endpoint renders this version ("none" = download only). */
	readonly previewKind: PreviewKind;
	/** Relative API paths (prefix with /api). */
	readonly downloadUrl: string;
	readonly previewUrl: string;
}

export interface FileDTO {
	readonly id: string;
	readonly name: string;
	readonly spaceId: string;
	readonly spaceKind: "personal" | "project";
	readonly projectId?: string;
	readonly createdBy: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly latestVersionId: string;
	readonly latestVersionNo: number;
	readonly mime: string;
	readonly size: number;
	readonly origin: FileOrigin;
	/** The caller's effective permissions on this file (current membership). */
	readonly canWrite: boolean;
}

/** GET /files?spaceId=&projectId=&q=&origin=&limit= */
export interface FileListResponse {
	readonly files: FileDTO[];
}
/** POST /files (multipart: file, spaceId | projectId, changeNote?) and POST /files/:id/versions (multipart: file, changeNote). */
export interface FileUploadResponse {
	readonly file: FileDTO;
	readonly version: FileVersionDTO;
}
/** GET /files/:id */
export interface FileDetailResponse {
	readonly file: FileDTO;
	/** Newest first. */
	readonly versions: FileVersionDTO[];
}
/** GET /files/:id/versions/:vid/text → extracted plain text (bounded). */
export interface FileTextResponse {
	readonly text: string;
	readonly truncated: boolean;
	readonly kind: PreviewKind;
}

// ---------------- connectors (MCP) ----------------
export type ConnectorScope = "system" | "personal";
export type ConnectorTransport = "stdio" | "http";
/** ready = usable; needs_reconnect = was working, connection lost/credentials expired; unauthorized = server rejected credentials; error = cannot start/connect; unchecked = never checked; disabled = turned off by owner/admin. */
export type ConnectorStatus = "ready" | "needs_reconnect" | "unauthorized" | "error" | "unchecked" | "disabled";

export interface ConnectorToolDTO {
	/** Model-facing namespaced name: mcp__<handle>__<tool>. */
	readonly name: string;
	readonly tool: string;
	readonly description: string;
	readonly policy: "read" | "write";
	readonly inputSchema: unknown;
}

export interface ConnectorDTO {
	readonly id: string;
	readonly handle: string;
	readonly name: string;
	readonly scope: ConnectorScope;
	readonly transport: ConnectorTransport;
	/** stdio: command + args; http: url. Secret env/header VALUES are never returned, only their names. */
	readonly command?: string;
	readonly args?: readonly string[];
	readonly url?: string;
	readonly secretNames: readonly string[];
	readonly status: ConnectorStatus;
	readonly statusDetail?: string;
	readonly lastCheckedAt?: string;
	readonly tools: readonly ConnectorToolDTO[];
	/** For the caller: may they use it at all (server-side check), and have they enabled it for their runs. */
	readonly access: "allowed" | "forbidden";
	readonly accessReason?: string;
	readonly enabledForMe: boolean;
	readonly canManage: boolean;
}
/** GET /connectors → { connectors, secretStorage } */
export interface ConnectorListResponse {
	readonly connectors: ConnectorDTO[];
	/** "available" when WORKROOM_SECRET_KEY is configured; otherwise secrets cannot be stored. */
	readonly secretStorage: "available" | "unavailable";
	/** Third-party connectors we know about but cannot connect without credentials. */
	readonly blocked: readonly { readonly kind: string; readonly reason: string }[];
}
/** POST /connectors body */
export interface ConnectorCreateRequest {
	readonly name: string;
	readonly scope: ConnectorScope;
	readonly transport: ConnectorTransport;
	readonly command?: string;
	readonly args?: readonly string[];
	readonly url?: string;
	/** stdio: env vars; http: headers. Encrypted at rest; refused when no secret key is configured. */
	readonly secrets?: Readonly<Record<string, string>>;
	/** Plain (non-secret) env vars for stdio. */
	readonly env?: Readonly<Record<string, string>>;
	/** Per-tool policy override: tool name → read | write. */
	readonly toolPolicies?: Readonly<Record<string, "read" | "write">>;
}

export interface ToolCallRecordDTO {
	readonly id: string;
	readonly tool: string;
	readonly connectorId?: string;
	readonly userId: string;
	readonly spaceId?: string;
	readonly conversationId?: number;
	readonly taskId?: number;
	readonly callId?: string;
	/** Arguments summary with secrets redacted and long values truncated. */
	readonly argsSummary: string;
	readonly status: "running" | "ok" | "error" | "denied" | "needs_reconciliation";
	readonly error?: string;
	readonly durationMs?: number;
	readonly resultSummary?: string;
	readonly startedAt: string;
	readonly finishedAt?: string;
}
/** GET /tool-calls?conversationId=&spaceId=&limit= */
export interface ToolCallListResponse {
	readonly calls: ToolCallRecordDTO[];
}

// ---------------- skills ----------------
/** prompt = a reusable prompt preset; context = SKILL.md instructions only; executable = scripts/resources + declared tool & permission requirements. */
export type SkillKind = "prompt" | "context" | "executable";
export type SkillPermission = "sandbox.exec" | "network" | "file.write" | `tool:${string}`;

export interface SkillVersionDTO {
	readonly versionId: string;
	readonly versionNo: number;
	readonly description: string;
	readonly instructions: string;
	readonly resources: readonly { readonly path: string; readonly size: number; readonly sha256: string }[];
	/** Entry script for executable skills (path within resources). */
	readonly entry?: string;
	readonly requiredTools: readonly string[];
	readonly requiredPermissions: readonly SkillPermission[];
	readonly changeNote?: string;
	readonly createdAt: string;
	readonly createdBy: string;
	readonly source: "manual" | "from_task";
	readonly validation?: SkillValidationDTO;
}

export interface SkillValidationDTO {
	readonly ok: boolean;
	readonly at: string;
	readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail?: string }[];
}

export interface SkillDTO {
	readonly id: string;
	readonly name: string;
	readonly kind: SkillKind;
	readonly scope: "personal" | "org";
	readonly ownerUserId: string;
	readonly latestVersionNo: number;
	readonly status: "active" | "archived";
	readonly versions?: SkillVersionDTO[];
	/** Caller's installation (absent when not installed). */
	readonly install?: {
		readonly enabled: boolean;
		/** null → follows latest. */
		readonly pinnedVersionNo: number | null;
		readonly effectiveVersionNo: number;
		/** Permissions the caller granted for the effective version (executable skills only). */
		readonly grantedPermissions: readonly SkillPermission[];
	};
	readonly canManage: boolean;
}
export interface SkillListResponse {
	readonly skills: SkillDTO[];
}
export interface SkillRunDTO {
	readonly id: string;
	readonly skillId: string;
	readonly versionId: string;
	readonly versionNo: number;
	readonly mode: "load" | "run" | "validate";
	readonly userId: string;
	readonly spaceId?: string;
	readonly conversationId?: number;
	readonly taskId?: number;
	readonly status: "ok" | "error" | "denied";
	readonly detail?: string;
	readonly at: string;
}
export interface SkillDraftDTO {
	readonly id: string;
	readonly name: string;
	readonly kind: SkillKind;
	readonly description: string;
	readonly instructions: string;
	readonly resources: readonly { readonly path: string; readonly size: number; readonly sha256: string }[];
	readonly entry?: string;
	readonly requiredTools: readonly string[];
	readonly requiredPermissions: readonly SkillPermission[];
	readonly source: { readonly spaceId?: string; readonly conversationId?: number };
	readonly sample?: { readonly input: string; readonly expectContains?: string };
	readonly validation?: SkillValidationDTO;
	readonly publishedSkillId?: string;
}

// ---------------- sandbox & browse ----------------
export interface SandboxRunDTO {
	readonly id: string;
	readonly spaceId: string;
	readonly conversationId?: number;
	readonly taskId?: number;
	readonly callId?: string;
	readonly userId: string;
	readonly language: "shell" | "python" | "node" | "js";
	readonly code: string;
	readonly status: "running" | "ok" | "error" | "timeout" | "killed";
	readonly exitCode?: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly durationMs?: number;
	readonly startedAt: string;
	readonly finishedAt?: string;
	readonly limits: SandboxLimitsDTO;
	readonly isolation: string;
}
export interface SandboxLimitsDTO {
	readonly timeoutMs: number;
	readonly memoryBytes: number;
	readonly cpuSeconds: number;
	readonly maxFileBytes: number;
	readonly maxProcesses: number;
	readonly network: boolean;
}
export interface SandboxInfoDTO {
	readonly spaceId: string;
	readonly isolation: "namespaces" | "unavailable";
	readonly isolationDetail: string;
	readonly limits: SandboxLimitsDTO;
	/** Workspace lifetime rule: files idle longer than this are deleted; publish with file_create/sandbox_publish before. */
	readonly retentionHours: number;
	readonly usedBytes: number;
	readonly quotaBytes: number;
}
export interface SandboxEntryDTO {
	readonly path: string;
	readonly kind: "file" | "directory";
	readonly size: number;
	readonly mtime: string;
	readonly expiresAt: string;
}
/** GET /sandbox/:spaceId → info; GET /sandbox/:spaceId/files?conversationId= ; GET /sandbox/:spaceId/runs?conversationId= ; GET /sandbox/:spaceId/runs/:runId ; GET /sandbox/:spaceId/file?path=&conversationId= (download) */
export interface SandboxFilesResponse {
	readonly entries: SandboxEntryDTO[];
}
export interface SandboxRunsResponse {
	readonly runs: SandboxRunDTO[];
}
export interface BrowseResultDTO {
	readonly url: string;
	readonly finalUrl: string;
	readonly title: string;
	readonly text: string;
	readonly status?: number;
	readonly screenshot?: FileVersionRefDTO;
}

// ---------------- background jobs (M14-C) ----------------
export type JobKind = "sandbox" | "browse" | "generate";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "timeout";
export interface JobBudgetDTO {
	/** Wall-clock budget; the job is stopped (status timeout) when it is exceeded. */
	readonly timeoutMs: number;
	/** CPU seconds (sandbox jobs). */
	readonly cpuSeconds: number;
	readonly memoryBytes: number;
}
export interface JobDTO {
	readonly id: string;
	readonly kind: JobKind;
	readonly title: string;
	readonly status: JobStatus;
	readonly spaceId: string;
	readonly conversationId: number;
	readonly userId: string;
	/** pi-durable task id of the background job task. */
	readonly taskId?: number;
	readonly budget: JobBudgetDTO;
	/** rerun = restart from scratch after a server restart; fail = mark failed (default for scripts with side effects). */
	readonly restartPolicy: "rerun" | "fail";
	readonly attempts: number;
	readonly progress?: string;
	/** Short result text (stdout tail, page title, …). */
	readonly summary?: string;
	readonly error?: string;
	/** Results published to the file library. */
	readonly outputs: readonly FileVersionRefDTO[];
	readonly sandboxRunId?: string;
	readonly cancelRequestedBy?: string;
	readonly createdAt: string;
	readonly startedAt?: string;
	readonly finishedAt?: string;
	readonly updatedAt: string;
	/** Caller may cancel (space write access). */
	readonly canCancel?: boolean;
}
/** GET /jobs?spaceId=&conversationId=&status= */
export interface JobListResponse {
	readonly jobs: JobDTO[];
}

// ---------------- interactive browser sessions (M11-B) ----------------
export type BrowserActionType = "navigate" | "click" | "type" | "press" | "scroll" | "back" | "forward" | "reload";
export interface BrowserActionRequest {
	readonly type: BrowserActionType;
	readonly url?: string;
	/** click: viewport coordinates of the last screenshot (CSS pixels). */
	readonly x?: number;
	readonly y?: number;
	/** type: text to insert at the focused element. press: a key name such as "Enter". */
	readonly text?: string;
	readonly key?: string;
	/** scroll: pixels (positive = down). */
	readonly deltaY?: number;
}
export interface BrowserSessionDTO {
	readonly id: string;
	readonly spaceId: string;
	readonly conversationId: number;
	readonly url: string;
	readonly title: string;
	/** Who drives the session now: the agent (tools) or a user who took over. */
	readonly controller: { readonly kind: "agent" } | { readonly kind: "user"; readonly userId: string; readonly name?: string };
	readonly viewport: { readonly width: number; readonly height: number };
	/** Increments on every action; append `?v=<n>` to the screenshot URL to refresh. */
	readonly version: number;
	readonly screenshotUrl: string;
	readonly lastAction?: string;
	readonly blockedRequests: number;
	readonly createdBy: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly expiresAt: string;
	/** For the caller: may act / take over (space write) or only watch (read). */
	readonly canControl?: boolean;
}
export interface BrowserSessionListResponse {
	readonly sessions: BrowserSessionDTO[];
}
/** Work items of a conversation shown next to the chat (also embeddable in ConversationState as `work`). */
export interface ConversationWorkDTO {
	readonly jobs: JobDTO[];
	readonly browserSessions: BrowserSessionDTO[];
}
