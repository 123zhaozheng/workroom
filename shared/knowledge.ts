// Knowledge & memory DTOs (owner: group C). Consumed by web (B) and runtime (A).
// HTTP routes: see docs/knowledge.md. All ids are strings. Times are ISO-8601 strings.

// ---------- knowledge bases ----------
export type KbScope = "personal" | "project" | "department" | "org";

export interface KbPermissions {
	readonly read: boolean;
	/** Add/remove docs, retry, edit governance. */
	readonly write: boolean;
	/** Rename, maintainers, delete the KB. */
	readonly admin: boolean;
}

export interface KbSummary {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly scope: KbScope;
	readonly ownerUserId: string;
	readonly projectId?: string;
	readonly departmentId?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly stats: { readonly docs: number; readonly ready: number; readonly processing: number; readonly failed: number };
	readonly permissions: KbPermissions;
	readonly maintainers: readonly { userId: string; name: string }[];
}

export interface CreateKbRequest {
	readonly name: string;
	readonly description?: string;
	readonly scope: KbScope;
	/** Required for scope "project". */
	readonly projectId?: string;
	/** Required for scope "department". */
	readonly departmentId?: string;
}

// ---------- documents & processing ----------
/** Processing state of one document version. "ready" is the only state that means "knowledge available". */
export type KbProcessingStatus = "queued" | "parsing" | "indexing" | "ready" | "failed";

export interface KbDocVersionDTO {
	readonly docVersionId: string;
	readonly fileId: string;
	readonly versionId: string;
	readonly versionNo: number;
	readonly fileName: string;
	readonly mime: string;
	readonly size: number;
	readonly status: KbProcessingStatus;
	readonly error?: string;
	/** Machine code for failures, e.g. "unsupported_type", "parse_error", "no_text", "source_unavailable". */
	readonly errorCode?: string;
	readonly retryable?: boolean;
	readonly attempts: number;
	readonly chunkCount: number;
	readonly pageCount?: number;
	/** Pages (PDF) / images whose text came from OCR. */
	readonly ocrPages?: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	/** Set once a newer version became ready and replaced this one in the index. */
	readonly supersededAt?: string;
}

export type KbDocKind = "reference" | "policy" | "template";
/** Stored governance status. */
export type KbGovStatus = "draft" | "effective" | "expired" | "withdrawn";
/** Status as of now: stored status + dates ("pending" = effectiveFrom in the future; "expired" = expiresAt passed). */
export type KbGovEffectiveStatus = KbGovStatus | "pending";

export interface KbGovernanceDTO {
	readonly kind: KbDocKind;
	/** Responsible person (责任人). */
	readonly responsibleUserId?: string;
	readonly responsibleName?: string;
	/** Human version label of the policy text, e.g. "2026 版" (independent of file version numbers). */
	readonly versionLabel?: string;
	readonly status: KbGovStatus;
	readonly effectiveStatus: KbGovEffectiveStatus;
	readonly effectiveFrom?: string;
	readonly expiresAt?: string;
	readonly replacedByDocId?: string;
	readonly updatedAt: string;
	readonly updatedBy?: string;
	/** Whether default retrieval uses this doc (non-governed docs and effective policies only). */
	readonly retrievable: boolean;
}

export interface KbDocDTO {
	readonly id: string;
	readonly kbId: string;
	readonly fileId: string;
	readonly fileName: string;
	/**
	 * Knowledge availability (separate from file storage status):
	 * "ready" = a version is indexed and searchable; "processing" = nothing searchable yet, work in progress;
	 * "failed" = nothing searchable and the latest attempt failed.
	 */
	readonly availability: "ready" | "processing" | "failed";
	/** Version currently served by retrieval (null until the first version is ready). */
	readonly serving: KbDocVersionDTO | null;
	/** Newest version added (may equal serving; may be processing/failed while an older one still serves). */
	readonly latest: KbDocVersionDTO;
	readonly governance: KbGovernanceDTO;
	readonly addedBy: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface AddKbDocRequest {
	readonly fileId: string;
	readonly versionId: string;
	readonly governance?: UpdateGovernanceRequest;
}

export interface UpdateGovernanceRequest {
	readonly kind?: KbDocKind;
	readonly responsibleUserId?: string | null;
	readonly versionLabel?: string | null;
	readonly status?: KbGovStatus;
	readonly effectiveFrom?: string | null;
	readonly expiresAt?: string | null;
	readonly replacedByDocId?: string | null;
}

/** GET /kb/files/:fileId/status — knowledge state of one file across the KBs the caller can read. */
export interface FileKnowledgeStatus {
	readonly fileId: string;
	readonly entries: readonly { kbId: string; kbName: string; docId: string; availability: KbDocDTO["availability"]; servingVersionNo?: number; latestVersionNo: number; latestStatus: KbProcessingStatus }[];
}

// ---------- retrieval ----------
/** Mirrors core Citation, plus locator fields for display. */
export interface CitationDTO {
	readonly kbId: string;
	readonly docId: string;
	readonly fileId: string;
	readonly versionId: string;
	readonly versionNo: number;
	readonly fileName: string;
	readonly chunkId: string;
	readonly page?: number;
	readonly section?: string;
	readonly snippet: string;
	readonly score: number;
	/** Extra anchors: paragraph ordinal (1-based), spreadsheet sheet + rows. */
	readonly paragraph?: number;
	readonly sheet?: string;
	readonly rowStart?: number;
	readonly rowEnd?: number;
	/** Text came from OCR (scanned PDF page / image): may contain recognition errors. */
	readonly ocr?: boolean;
	/** Display label, e.g. "第 3 页", "章节：制度 > 报销", "第 4 段", "Sheet1 第 2–9 行", "第 2 页（OCR 识别）". */
	readonly locator: string;
	readonly kbName: string;
	/** Citation number used in tool output text ([1], [2], ...); only set by kb_search. */
	readonly n?: number;
}

export type RetrievalFailure = "no_evidence" | "index_not_ready" | "forbidden" | "error";

export interface RetrievalDiagnostics {
	readonly reason?: RetrievalFailure;
	readonly detail?: string;
	readonly searchedKbIds: string[];
	/** Explicitly requested KB ids the caller may not read (never searched). */
	readonly forbiddenKbIds?: string[];
	/** Docs in searched KBs that are not searchable yet (queued/parsing/indexing). */
	readonly pendingDocs?: number;
	readonly failedDocs?: number;
	readonly readyDocs?: number;
	/** Matching strategy used: "fts" (trigram MATCH), "like" (short-term fallback) or both. */
	readonly strategy?: "fts" | "like" | "fts+like";
	readonly cached?: boolean;
	/** Set for a subagent member with a declared knowledge scope: the only KBs it may search. */
	readonly memberScope?: string[];
	readonly vector?: "blocked";
	readonly tookMs?: number;
}

export interface KbSearchRequest {
	readonly query: string;
	readonly kbIds?: string[];
	/** Restrict docs within the KBs (from knowledge chips that point at one doc). */
	readonly docIds?: string[];
	/** Context: a project conversation searches that project's KBs + org KBs by default (never personal ones unless explicitly referenced). */
	readonly projectId?: string;
	readonly limit?: number;
	/** Include draft/expired/withdrawn/pending governed docs (debug). */
	readonly includeInactive?: boolean;
	/** Return debug info (query plan, candidates). */
	readonly debug?: boolean;
}

/** Why one KB was (not) searched for this query (M07-C retrieval debug). Inaccessible KBs appear only if explicitly requested. */
export interface KbDecisionDTO {
	readonly kbId: string;
	readonly kbName?: string;
	readonly scope?: KbScope;
	readonly included: boolean;
	readonly reason: "searched" | "not_requested" | "outside_project_context" | "outside_member_scope" | "forbidden";
	/** Access basis (current membership): personal_owner, project_owner|editor|viewer, department_member, kb_owner, kb_maintainer, org_member. */
	readonly access?: string;
	/** Index readiness (docs by state). */
	readonly index?: { readonly ready: number; readonly processing: number; readonly failed: number };
	/** Governance among servable docs: how many are retrievable now, and how many are excluded by status. */
	readonly governance?: { readonly retrievable: number; readonly excluded: Partial<Record<"draft" | "expired" | "withdrawn" | "pending", number>>; readonly includeInactive: boolean };
	/** Matching chunks in this KB before the limit, and citations returned from it. */
	readonly candidates?: number;
	readonly hits?: number;
	/** Human-readable explanation lines. */
	readonly notes: string[];
}

export interface KbSearchDebug {
	readonly kbDecisions: KbDecisionDTO[];
	readonly ftsQuery: string | null;
	readonly likeTerms: string[];
	readonly accessibleKbIds: string[];
	readonly candidates: number;
	readonly embedding: "blocked";
}

export interface KbSearchResponse {
	readonly citations: CitationDTO[];
	readonly diagnostics: RetrievalDiagnostics;
	readonly debug?: KbSearchDebug;
}

/** GET /kb/citations/:chunkId/status — current validity of a cited chunk (for 失效提示 on old answers). */
export interface CitationStatusDTO {
	readonly chunkId: string;
	readonly status: "valid" | "superseded" | "deleted" | "withdrawn" | "expired" | "forbidden" | "not_found";
	/** When superseded: the version now served. */
	readonly current?: { versionId: string; versionNo: number };
	/** Version the citation pointed at (omitted when forbidden/not_found). */
	readonly cited?: { versionId: string; versionNo: number; fileName: string };
	readonly message: string;
}

/**
 * GET /kb/conversations/:spaceId/:conversationId/citation-status — every citation kb_search produced in a conversation
 * with its CURRENT validity for the caller. `calls[].entryId` is the pi tool-result entry; `byChunkId` keys the statuses.
 */
export interface ConversationCitationStatus {
	readonly spaceId: string;
	readonly conversationId: number;
	readonly calls: readonly { entryId: number; callId: string; chunkIds: string[] }[];
	readonly byChunkId: Record<string, CitationStatusDTO>;
	/** Number of cited chunks that are no longer valid (non-"valid" status). */
	readonly stale: number;
}

export interface KbCapabilities {
	readonly fulltext: { status: "ready"; detail: string };
	readonly vector: { status: "blocked"; detail: string };
	readonly ocr: { status: "ready" | "blocked"; detail: string };
	readonly formats: readonly string[];
}

// ---------- retrieval events (M18-B) ----------
/** One retrieval, as found by correlation id (GET /api/kb/admin/retrieval-events?q=, and E's /api/admin/trace). */
export interface RetrievalEventDTO {
	readonly id: string;
	readonly at: string;
	readonly userId: string;
	readonly source: "api" | "tool" | "eval";
	readonly requestId?: string;
	readonly spaceId?: string;
	readonly conversationId?: number;
	readonly taskId?: number;
	readonly callId?: string;
	readonly queryHash: string;
	/** Redacted query text; absent under WORKROOM_REDACT=strict. */
	readonly query?: string;
	readonly queryLength: number;
	readonly kbIds: string[];
	readonly forbiddenKbIds?: string[];
	readonly hitCount: number;
	readonly reason?: RetrievalFailure;
	readonly strategy?: string;
	readonly cached: boolean;
	readonly latencyMs: number;
}

// ---------- evaluation ----------
export interface KbEvalSample {
	readonly id: string;
	readonly query: string;
	/** Expected hit: file name (+ optional page / section substring / text substring in snippet). Empty → expect no_evidence. */
	readonly expect: { fileName?: string; page?: number; section?: string; contains?: string; reason?: RetrievalFailure };
}
export interface KbEvalResult {
	readonly total: number;
	readonly passed: number;
	readonly recallAt5: number;
	readonly mrr: number;
	/** kbDecisions: always for failed samples, for all samples when requested with `explain: true`. */
	readonly samples: readonly { id: string; pass: boolean; rank: number | null; reason?: RetrievalFailure; top?: string; kbDecisions?: KbDecisionDTO[] }[];
}

// ---------- memory ----------
export type MemoryScope = "private" | "project" | "org";
export type MemorySource = "user" | "extracted" | "corrected";
export type MemoryKind = "preference" | "fact" | "constraint" | "background";

export interface MemoryDTO {
	readonly id: string;
	readonly scope: MemoryScope;
	readonly projectId?: string;
	readonly kind: MemoryKind;
	readonly content: string;
	readonly source: MemorySource;
	/** Where an extracted memory came from. */
	readonly sourceRef?: { spaceId: string; conversationId: number; callId?: string; taskId?: number; entryId?: number };
	/** For a correction: the memory it replaced. */
	readonly correctsId?: string;
	readonly status: "active" | "superseded";
	readonly supersededById?: string;
	readonly version: number;
	readonly createdBy: string;
	readonly createdByName?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly permissions: { edit: boolean; delete: boolean };
}

export interface CreateMemoryRequest {
	readonly content: string;
	readonly scope: MemoryScope;
	readonly projectId?: string;
	readonly kind?: MemoryKind;
}
export interface UpdateMemoryRequest {
	readonly content?: string;
	readonly kind?: MemoryKind;
}
export interface CorrectMemoryRequest {
	readonly content: string;
	readonly note?: string;
}
/** Visible result of a correction: what changed, and what the model will see from now on. */
export interface MemoryCorrectionResult {
	readonly previous: MemoryDTO;
	readonly current: MemoryDTO;
	readonly change: { before: string; after: string; note?: string; at: string; by: string };
}
export interface MemoryRevisionDTO {
	readonly memoryId: string;
	readonly version: number;
	readonly change: "create" | "edit" | "correct" | "supersede" | "delete";
	readonly content: string;
	readonly note?: string;
	readonly by: string;
	readonly at: string;
}

/** GET /memory/context?spaceId= — exactly what the memory system-prompt section contains for that space and caller. */
export interface MemoryContextDTO {
	readonly spaceId: string;
	readonly spaceKind: "personal" | "project";
	readonly included: readonly MemoryDTO[];
	/** Rendered section text (undefined when nothing applies). */
	readonly section?: string;
	readonly rules: string;
}
