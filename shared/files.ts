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
	/** Switched off by the manager (policy "disabled") or by the caller (override): the model never sees it. */
	readonly disabled?: boolean;
	readonly userOverride?: "ask" | "disabled";
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
	/** Marketplace round: approval state of personal connectors, sandbox execution, per-user credentials. */
	readonly market?: ConnectorMarketInfoDTO;
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
	readonly source: "manual" | "from_task" | "package";
	readonly validation?: SkillValidationDTO;
	/** Package versions: author-declared semantic version and approval for distribution. */
	readonly semver?: string;
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
	readonly scope: MarketScope;
	/** Directory name under /skills/ in the sandbox. */
	readonly slug?: string;
	readonly ownerUserId: string;
	/** Newest version the caller can move to (authors: newest upload; others: newest approved). */
	readonly latestVersionNo: number;
	readonly publishedVersionNo?: number;
	readonly listed?: boolean;
	/** Active for the caller because an org / department / project install applies (not only a personal install). */
	readonly viaScope?: readonly ("org" | "department" | "project")[];
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

// ---------------- skills & MCP marketplace (round 4, MARKETPLACE group) ----------------
// A skill/MCP entry has a *scope* (who may use it) and versions that are immutable. Non-personal scopes are only
// distributed after a reviewer approved that exact version (the package sha256 is the version identity).
export type MarketScope = "personal" | "project" | "department" | "org";
export type SubmissionState = "checks_failed" | "pending_review" | "changes_requested" | "rejected" | "approved" | "published" | "unpublished" | "withdrawn" | "superseded";
export type SubmissionKind = "skill" | "mcp_catalog" | "mcp_connector";

export interface PackageFindingDTO {
	readonly severity: "error" | "warn" | "info";
	readonly code: string;
	readonly message: string;
	readonly path?: string;
	readonly line?: number;
}
export interface PackageCheckDTO {
	readonly ok: boolean;
	readonly at: string;
	readonly findings: readonly PackageFindingDTO[];
	readonly stats: { readonly fileCount: number; readonly totalBytes: number; readonly packageBytes: number; readonly scriptCount: number };
}
export interface SkillManifestDTO {
	/** Slug: also the directory name under /skills/<slug>/ inside the sandbox. */
	readonly name: string;
	readonly title?: string;
	readonly description: string;
	/** Semantic version declared by the author (the immutable version number is separate: versionNo). */
	readonly version: string;
	readonly license?: string;
	readonly compatibility?: string;
	readonly category?: string;
	readonly tags: readonly string[];
	readonly entry?: string;
	readonly kind: SkillKind;
	readonly requiredTools: readonly string[];
	readonly requiredPermissions: readonly SkillPermission[];
	readonly allowedTools?: string;
	readonly metadata: Readonly<Record<string, string>>;
}
export interface PackageFileDTO {
	readonly path: string;
	readonly size: number;
	readonly sha256: string;
}

export interface MarketSkillSummaryDTO {
	readonly id: string;
	readonly slug: string;
	readonly name: string;
	readonly description: string;
	readonly scope: MarketScope;
	readonly scopeRef?: string;
	readonly category?: string;
	readonly tags: readonly string[];
	readonly kind: SkillKind;
	readonly ownerUserId: string;
	readonly ownerName?: string;
	/** Latest approved (published) semver; absent for a personal skill that was never reviewed. */
	readonly version?: string;
	readonly versionNo?: number;
	readonly requiredPermissions: readonly SkillPermission[];
	readonly installCount: number;
	readonly ratingAvg?: number;
	readonly ratingCount: number;
	readonly listed: boolean;
	readonly updatedAt: string;
	/** Caller's installs: "me" and/or scopes the caller manages. */
	readonly installedFor: readonly { readonly target: "me" | "project" | "department" | "org"; readonly scopeRef?: string; readonly versionNo: number | null }[];
}
export interface MarketVersionDTO {
	readonly versionNo: number;
	readonly semver?: string;
	readonly packageSha256?: string;
	readonly packageSize?: number;
	readonly changeNote?: string;
	readonly createdAt: string;
	readonly createdBy: string;
	/** Approved for distribution at the skill's scope. */
	readonly approved: boolean;
	readonly submissionState?: SubmissionState;
	readonly checks?: PackageCheckDTO;
}
export interface MarketSkillDetailDTO extends MarketSkillSummaryDTO {
	readonly manifest?: SkillManifestDTO;
	readonly readme: string;
	readonly files: readonly PackageFileDTO[];
	readonly versions: readonly MarketVersionDTO[];
	readonly myRating?: { readonly stars: number; readonly comment?: string };
	readonly ratings: readonly { readonly stars: number; readonly comment?: string; readonly userName?: string; readonly at: string }[];
	readonly canManage: boolean;
	readonly canInstallOrg: boolean;
	readonly canSubmit: boolean;
	readonly unpublishedReason?: string;
	readonly latestVersionNo: number;
}

export interface SubmissionEventDTO {
	readonly at: string;
	readonly actorId: string;
	readonly actorName?: string;
	readonly action: string;
	readonly fromState?: SubmissionState;
	readonly toState?: SubmissionState;
	readonly comment?: string;
}
export interface SubmissionDTO {
	readonly id: string;
	readonly kind: SubmissionKind;
	readonly subjectId: string;
	readonly subjectName: string;
	readonly versionNo?: number;
	readonly semver?: string;
	readonly targetScope: MarketScope;
	readonly targetRef?: string;
	readonly submitterId: string;
	readonly submitterName?: string;
	readonly state: SubmissionState;
	readonly note?: string;
	readonly forced: boolean;
	readonly decidedBy?: string;
	readonly decisionComment?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly warnCount: number;
	readonly errorCount: number;
	/** The caller may decide this submission (scoped permission and not the submitter). */
	readonly canDecide: boolean;
}
export interface SubmissionDetailDTO extends SubmissionDTO {
	readonly manifest?: SkillManifestDTO;
	readonly checks?: PackageCheckDTO;
	readonly files: readonly PackageFileDTO[];
	/** Permissions newly requested compared with the previous approved version. */
	readonly permissionDelta: { readonly added: readonly string[]; readonly removed: readonly string[] };
	readonly previousVersionNo?: number;
	readonly diff: readonly {
		readonly path: string;
		readonly status: "added" | "removed" | "modified" | "unchanged";
		readonly binary?: boolean;
		readonly tooLarge?: boolean;
		readonly added?: number;
		readonly removed?: number;
		readonly hunks?: readonly { readonly oldStart: number; readonly newStart: number; readonly lines: readonly { readonly t: " " | "+" | "-"; readonly s: string }[] }[];
	}[];
	readonly events: readonly SubmissionEventDTO[];
	/** MCP submissions: summary of what would be installed. */
	readonly mcp?: McpSubmissionInfoDTO;
}

export interface MarketPolicyDTO {
	/** Personal skills: free = usable right after upload; review = need approval first; disabled = not allowed. */
	readonly personalSkill: "free" | "review" | "disabled";
	/** Personal MCP connectors: free = usable right after adding; approval = reviewer must approve before the first connection. */
	readonly personalMcp: "free" | "approval" | "disabled";
}
export interface MarketMeDTO {
	readonly canUploadSkill: boolean;
	readonly canReviewSkills: boolean;
	readonly canReviewMcp: boolean;
	readonly canManageMarket: boolean;
	readonly canPublishOrg: boolean;
	readonly canAddOrgConnector: boolean;
	readonly policy: MarketPolicyDTO;
	readonly sandbox: { readonly state: string; readonly detail?: string; readonly mounts: boolean; readonly services: boolean };
	readonly limits: { readonly uploadBytes: number; readonly totalBytes: number; readonly fileBytes: number; readonly files: number };
}

// ---- MCP catalog (server.json of the official MCP Registry, https://static.modelcontextprotocol.io/schemas/…/server.schema.json)
export interface ServerJsonInput {
	readonly name: string;
	readonly description?: string;
	readonly isRequired?: boolean;
	readonly isSecret?: boolean;
	readonly default?: string;
	readonly choices?: readonly string[];
	readonly value?: string;
}
export interface ServerJson {
	readonly $schema?: string;
	/** Reverse-DNS namespace + slash + name, e.g. io.github.user/weather. */
	readonly name: string;
	readonly description: string;
	readonly title?: string;
	readonly version: string;
	readonly websiteUrl?: string;
	readonly repository?: { readonly url: string; readonly source?: string; readonly subfolder?: string };
	readonly packages?: readonly {
		readonly registryType: string;
		readonly registryBaseUrl?: string;
		readonly identifier: string;
		readonly version?: string;
		readonly fileSha256?: string;
		readonly runtimeHint?: string;
		readonly transport?: { readonly type: string; readonly url?: string };
		readonly runtimeArguments?: readonly { readonly type?: string; readonly name?: string; readonly value?: string; readonly valueHint?: string }[];
		readonly packageArguments?: readonly { readonly type?: string; readonly name?: string; readonly value?: string; readonly valueHint?: string }[];
		readonly environmentVariables?: readonly ServerJsonInput[];
	}[];
	readonly remotes?: readonly {
		readonly type: string;
		readonly url: string;
		readonly headers?: readonly ServerJsonInput[];
		readonly variables?: Readonly<Record<string, Omit<ServerJsonInput, "name">>>;
	}[];
	readonly _meta?: Readonly<Record<string, unknown>>;
}
/** One way to run/connect an entry, derived from server.json for the install dialog. */
export interface McpInstallOptionDTO {
	readonly index: number;
	readonly kind: "remote" | "package";
	readonly label: string;
	readonly transport: "http" | "stdio";
	readonly url?: string;
	readonly registryType?: string;
	readonly identifier?: string;
	readonly inputs: readonly { readonly name: string; readonly description?: string; readonly secret: boolean; readonly required: boolean; readonly where: "env" | "header" | "variable" }[];
	/** Why it cannot be installed here (e.g. stdio package needs sandbox network; sandbox unavailable). */
	readonly blocked?: string;
}
export interface McpSubmissionInfoDTO {
	readonly name: string;
	readonly transport: "http" | "stdio";
	readonly url?: string;
	readonly command?: string;
	readonly secretNames: readonly string[];
	readonly execMode?: "host" | "sandbox";
}
export interface McpCatalogSummaryDTO {
	readonly id: string;
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly scope: MarketScope;
	readonly category?: string;
	readonly tags: readonly string[];
	readonly version?: string;
	readonly versionNo?: number;
	readonly transports: readonly ("http" | "stdio")[];
	readonly installCount: number;
	readonly listed: boolean;
	readonly ownerUserId: string;
	readonly updatedAt: string;
	readonly installed: boolean;
	readonly status: "published" | "pending_review" | "draft" | "unpublished";
}
export interface McpCatalogDetailDTO extends McpCatalogSummaryDTO {
	readonly serverJson: ServerJson;
	readonly options: readonly McpInstallOptionDTO[];
	readonly versions: readonly { readonly versionNo: number; readonly semver: string; readonly createdAt: string; readonly approved: boolean; readonly changeNote?: string }[];
	readonly canManage: boolean;
	readonly canSubmit: boolean;
	readonly latestVersionNo: number;
}
export interface ConnectorMarketInfoDTO {
	readonly approvalState: "approved" | "pending" | "rejected";
	readonly submissionId?: string;
	readonly execMode: "host" | "sandbox";
	readonly credentialMode: "shared" | "per_user";
	readonly catalogId?: string;
	/** Names of secrets the caller has stored for this connector (values are never returned). */
	readonly mySecretNames: readonly string[];
	readonly toolOverrides: Readonly<Record<string, "ask" | "disabled">>;
	/** Secret names a per-user connector needs from each user. */
	readonly requiredSecretNames: readonly string[];
}
