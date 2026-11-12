// Chat / runtime DTOs shared by server (group A, server/src/runtime) and web (group B).
// Owner: group A. Only extend compatibly (add optional fields / new union members); never rename or remove.
// pi-durable ids (conversation / entry / task / submission) are numbers; a conversation is addressed by (spaceId, conversationId).

// ---------------------------------------------------------------- conversations

/** chat: normal conversation; branch: created by fork/edit/regenerate; automation: started by an automation; subagent: task-owned child (read-only in UI). */
export type ConversationKind = "chat" | "branch" | "automation" | "subagent";

export interface ConversationSummary {
	readonly spaceId: string;
	readonly conversationId: number;
	readonly title: string;
	readonly kind: ConversationKind;
	readonly projectId?: string;
	/** Round 9: display name of the project (container or legacy). */
	readonly projectName?: string;
	/** Round 9: how the viewer reaches it: "own" = in my personal space; "member" = legacy project space; "shared" = read-only through a project share. */
	readonly access?: "own" | "member" | "shared";
	readonly createdBy: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly archived: boolean;
	/** Fork source, read from pi-durable's ConversationRecord.parent (never stored separately). */
	readonly parent?: { readonly conversationId: number; readonly entryId: number };
	/** Owner edge for subagent conversations (pi-durable ConversationRecord.owner). */
	readonly owner?: { readonly conversationId: number; readonly taskId: number };
	/** Best effort: present when the space runtime is open. */
	readonly status?: RunStatus;
	readonly assistantId?: string;
}

export interface CreateConversationRequest {
	readonly spaceId?: string;
	readonly projectId?: string;
	readonly title?: string;
	/** Platform model id (from GET /models) or "provider/modelId". */
	readonly modelId?: string;
	readonly assistantId?: string;
}

export interface ConversationDetailResponse {
	readonly conversation: ConversationSummary;
	readonly parent?: { readonly conversationId: number; readonly entryId: number };
	/** Direct branches forked from this conversation. */
	readonly branches: readonly ConversationSummary[];
	readonly agent: AgentDTO;
}

export interface AgentDTO {
	readonly model?: { readonly provider: string; readonly modelId: string };
	readonly thinkingLevel?: string;
	/** True when the model is the deterministic fixture ("测试模型，非真实 AI"). The UI must label it. */
	readonly fixture: boolean;
	readonly modelLabel: string;
	readonly tools: readonly string[];
	readonly maxTurns?: number;
	readonly assistant?: AssistantDTO;
}

// ---------------------------------------------------------------- entries

export interface AttachmentRef {
	readonly fileId: string;
	readonly versionId: string;
	readonly name: string;
}
export interface KnowledgeRef {
	readonly kbId: string;
	readonly docId?: string;
	readonly name: string;
}

interface EntryBase {
	readonly id: number;
	/** Conversation that physically holds the entry (a fork shows inherited parent entries with the parent's id). */
	readonly conversationId: number;
}

export interface UserEntryDTO extends EntryBase {
	readonly kind: "user";
	/** Raw input as sent to the model (unchanged; kept for compatibility, copy/edit). */
	readonly text: string;
	/** What the person wrote: `text` with test-model directives ([[call …]], [[slow]], [[fail]], [[reply]]) removed. Show this, not `text`. */
	readonly displayText?: string;
	/** True when `text` contained test-model directives (the UI shows a small 测试 badge). */
	readonly hasTestDirectives?: boolean;
	readonly userId?: string;
	readonly authorName?: string;
	readonly attachments?: readonly AttachmentRef[];
	readonly knowledgeRefs?: readonly KnowledgeRef[];
	/** Set for inputs written by the runtime itself (subagent report, automation). */
	readonly via?: { readonly kind: "automation" | "subagent_report" | "delegate"; readonly id?: string };
	/**
	 * Outcome of the submission this message belongs to (M02-C), re-read from pi-durable on every load:
	 * applied (run working on it) · done · unanswered (+reason: aborted, model_error, turn_limit, …) · withdrawn.
	 * Absent for entries written before outcomes were recorded.
	 */
	readonly submission?: { readonly submissionId: number; readonly status: SubmissionStatus; readonly reason?: string; readonly answerEntryId?: number };
	/** false = the input never reached the model (withdrawn / aborted while queued); shown as a marker of what was sent. */
	readonly placed?: boolean;
	/** Round 12: when the message was written (ms since epoch); absent for old entries. */
	readonly timestamp?: number;
}

export interface ToolCallDTO {
	readonly id: string;
	readonly name: string;
	readonly arguments: unknown;
}

export interface AssistantEntryDTO extends EntryBase {
	readonly kind: "assistant";
	readonly text: string;
	readonly thinking?: string;
	readonly toolCalls: readonly ToolCallDTO[];
	/** pi-ai stop reason: stop | length | toolUse | error | aborted. */
	readonly stopReason: string;
	readonly errorMessage?: string;
	readonly model: { readonly provider: string; readonly modelId: string };
	readonly fixture: boolean;
	readonly usage?: UsageDTO;
	/** When the model request started (ms since epoch). */
	readonly timestamp?: number;
	/** Round 12: how long the model response took (ms), measured by pi-ai; absent for old entries. */
	readonly durationMs?: number;
}

export interface ToolResultEntryDTO extends EntryBase {
	readonly kind: "tool_result";
	readonly callId: string;
	readonly toolName: string;
	readonly text: string;
	readonly isError: boolean;
	readonly details?: unknown;
	readonly diagnostics?: readonly { readonly severity: string; readonly message: string; readonly code?: string }[];
	/** Round 12: when the result was written and how long the tool ran (ms, measured by pi-ai); absent for old entries. */
	readonly timestamp?: number;
	readonly durationMs?: number;
}

export interface MarkerEntryDTO extends EntryBase {
	/**
	 * start: conversation start marker; reset/compaction: context boundary; system: prompt change (hidden by default);
	 * notice: a runtime notice shown in the transcript (e.g. the assistant's default model was unavailable → fallback).
	 */
	readonly kind: "start" | "reset" | "compaction" | "system" | "notice";
	readonly text?: string;
	/** notice only: machine-readable code, e.g. "model_not_allowed" | "model_blocked". */
	readonly code?: string;
}

export interface OtherEntryDTO extends EntryBase {
	readonly kind: "other";
	/** Raw pi entry kind, e.g. "wr.note". */
	readonly rawKind: string;
	readonly data?: unknown;
}

/** Round 12: one thing that was prepared for a new conversation's workspace. */
export interface WorkspacePrepItem {
	readonly key: "storage" | "workdir" | "stores" | "env";
	readonly label: string;
	readonly detail?: string;
	readonly ok: boolean;
}
/** Round 12: what was prepared when the conversation was created, measured (ms = wall clock from the create request to ready). */
export interface WorkspacePrepDTO {
	readonly ms: number;
	readonly items: readonly WorkspacePrepItem[];
}
export interface WorkspaceEntryDTO extends EntryBase, WorkspacePrepDTO {
	readonly kind: "workspace";
}

export type EntryDTO = UserEntryDTO | AssistantEntryDTO | ToolResultEntryDTO | MarkerEntryDTO | WorkspaceEntryDTO | OtherEntryDTO;

export interface EntriesPage {
	readonly items: readonly EntryDTO[]; // ascending id order
	/** Pass as `before` to load the previous page; absent when the start was reached. */
	readonly next?: number;
}

// ---------------------------------------------------------------- live state

/**
 * Independent run states (M02-C):
 * idle (never ran) · running · waiting_approval (等待用户) · done (成功) · aborted (取消) · timeout (超时/轮数上限)
 * · failed (模型或执行失败) · interrupted (进程中断且重试耗尽).
 */
export type RunStatus = "idle" | "running" | "waiting_approval" | "done" | "aborted" | "timeout" | "failed" | "interrupted";

export interface UsageDTO {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly costTotal: number;
	/** True when (part of) the spend came from the fixture model: cost is 0 and not real. */
	readonly fixture?: boolean;
	/**
	 * True when (part of) these numbers come from a simulated model (the fixture): token counts are faux estimates and
	 * cost is 0. The UI must not present them as real usage.
	 */
	readonly simulated?: boolean;
	/** Conversation totals only: per "provider/modelId" (and per tool) breakdown, each flagged simulated or not. */
	readonly byModel?: readonly UsageByModelDTO[];
}

export interface UsageByModelDTO {
	/** "provider/modelId" for model spend, "tool:<name>" for tool-reported spend. */
	readonly key: string;
	readonly simulated: boolean;
	readonly input: number;
	readonly output: number;
	readonly totalTokens: number;
	readonly costTotal: number;
}

export interface LiveToolDTO {
	readonly callId: string;
	readonly name: string;
	readonly status: "pending" | "running" | "done";
	readonly output?: string;
	readonly details?: unknown;
	readonly taskId?: number;
	/** Present for delegate calls: the child conversation the UI can attach to. */
	readonly childConversationId?: number;
}

export interface LiveDTO {
	readonly status: RunStatus;
	readonly busy: boolean;
	/** Streaming partial of the current model response. */
	readonly partial?: { readonly text: string; readonly thinking?: string; readonly toolCalls: readonly ToolCallDTO[]; /** Round 12: when this model request started (ms since epoch). */ readonly startedAt?: number };
	readonly tools: readonly LiveToolDTO[];
	readonly turns?: number;
	readonly retry?: { readonly at: number; readonly error: string };
	/** Why the newest run ended without an answer (pi.live.runFailure). */
	readonly failure?: { readonly reason: string; readonly detail?: string };
}

export interface QueuedInputDTO {
	readonly submissionId: number;
	readonly mode: "steer" | "followUp" | "write";
	readonly text?: string;
	/** Round 8: what the queue UI needs to show and restore an item (followUp / steer items only). */
	readonly requestId?: string;
	readonly displayText?: string;
	readonly attachments?: readonly AttachmentRef[];
	readonly knowledgeRefs?: readonly KnowledgeRef[];
	readonly userId?: string;
}

// ---------------------------------------------------------------- submissions

export type SendMode = "auto" | "steer" | "followUp";

export interface SendMessageRequest {
	readonly text: string;
	/** Client-generated UUID; resending the same id returns the same submission and writes nothing new. */
	readonly requestId: string;
	readonly attachments?: readonly AttachmentRef[];
	readonly knowledgeRefs?: readonly KnowledgeRef[];
	/** auto (default) = steer the running work when busy, start a run when idle. */
	readonly mode?: SendMode;
}

/**
 * Feedback for a submitted message (M02-C):
 * received = admitted durably, waiting for the next boundary of the running work (steer)
 * queued   = admitted durably, waits for the current run to finish (follow-up)
 * applied  = placed in the transcript, the run is working on it
 * done     = answered
 * unanswered = will not be answered (reason: aborted, model_error, turn_limit, reset, run_failed, ...)
 * withdrawn  = withdrawn before it was applied (abort while queued)
 */
export type SubmissionStatus = "received" | "queued" | "applied" | "done" | "unanswered" | "withdrawn";

export interface SubmissionDTO {
	readonly submissionId: number;
	readonly conversationId: number;
	readonly requestId?: string;
	readonly status: SubmissionStatus;
	readonly reason?: string;
	readonly detail?: unknown;
	readonly entryId?: number;
	readonly answerEntryId?: number;
}

/** The input of a withdrawn queue item, returned so the composer can restore it for editing (text + attachments). */
export interface RestoredInputDTO {
	readonly text: string;
	readonly attachments?: readonly AttachmentRef[];
	readonly knowledgeRefs?: readonly KnowledgeRef[];
}

/**
 * POST …/abort (停止). Queued inputs are withdrawn by pi-durable's abort (an inherent semantic: a stopped conversation keeps no queue);
 * the server hands every one of them back here so the client can put them into the composer. They are also kept as display-only
 * 「未送达」 markers in the transcript. The input that was already APPLIED (placed in the context) is never in `unsent`: it stays.
 */
export interface AbortResponse {
	readonly ok: true;
	readonly unsent: readonly (RestoredInputDTO & { readonly submissionId: number })[];
	/** Approvals that were waiting for a decision and were cancelled together with the stopped run. */
	readonly cancelledApprovals: number;
}

/** POST …/submissions/:id/withdraw. already_placed = it was applied before the withdraw reached it: nothing is restored. */
export interface WithdrawResponse {
	readonly result: "aborted" | "already_placed" | "settled" | "not_found";
	readonly submission: SubmissionDTO;
	/** Only with {restore:true} and result "aborted". */
	readonly input?: RestoredInputDTO;
}

/**
 * POST …/submissions/:id/promote (立即发送): withdraw the queued follow-up and resubmit the same input as a steer with the
 * deterministic requestId `${requestId}::now` (idempotent: a retry or double click returns the same submission).
 *  promoted        = the input now steers the run: it reaches the model at the running task's next step (it never interrupts a
 *                    running tool or a pending approval). `effect` "steered" = the run is working, "started" = nothing was
 *                    running, so the message simply started a new run (and any other queued items follow it).
 *  already_applied = the follow-up had already been placed in the conversation; nothing changed.
 *  not_found       = the submission is not in the queue (withdrawn, unknown, or not a user input).
 */
export interface PromoteResponse {
	readonly result: "promoted" | "already_applied" | "not_found";
	readonly effect?: "steered" | "started";
	readonly replayed?: boolean;
	readonly submission: SubmissionDTO;
}

export interface SendMessageResponse {
	readonly submissionId: number;
	readonly status: SubmissionStatus;
	readonly submission: SubmissionDTO;
}

export interface ForkRequest {
	readonly entryId: number;
	readonly title?: string;
}
export interface EditRequest {
	/** The user entry being edited. */
	readonly entryId: number;
	readonly text: string;
	readonly requestId: string;
}
export interface RegenerateRequest {
	/** An assistant entry (or the user entry of that turn) to answer again. */
	readonly entryId: number;
}
export interface BranchResponse {
	readonly conversation: ConversationSummary;
	readonly submissionId?: number;
}

// ---------------------------------------------------------------- approvals & effects

/** cancelled = the run was stopped (停止) while the approval was pending: the tool call was aborted, nothing was executed, nobody decided. */
export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface ApprovalDTO {
	readonly approvalId: string;
	readonly conversationId: number;
	readonly callId: string;
	readonly toolName?: string;
	readonly title: string;
	/** Exactly what will happen if approved. */
	readonly summary: string;
	readonly detail?: unknown;
	readonly risk: "low" | "medium" | "high";
	readonly status: ApprovalStatus;
	readonly requestedAt: string;
	readonly requestedFor?: string;
	readonly approverUserIds?: readonly string[];
	readonly decidedBy?: string;
	readonly decidedAt?: string;
	readonly note?: string;
}

export interface ApprovalDecisionRequest {
	readonly decision: "approved" | "rejected";
	readonly note?: string;
}

/** intent → dispatching → done; needs_reconciliation when the outcome is unknown (crash while dispatching); failed when the target refused. */
export type EffectStatus = "intent" | "dispatching" | "done" | "failed" | "needs_reconciliation";

export interface EffectDTO {
	readonly effectId: string;
	readonly conversationId: number;
	readonly callId: string;
	readonly key: string;
	readonly target: string;
	readonly summary: string;
	readonly idempotencyKey: string;
	readonly status: EffectStatus;
	readonly receipt?: unknown;
	readonly error?: string;
	readonly updatedAt: string;
	readonly reconciledBy?: string;
}

export interface ReconcileRequest {
	/** What the user verified at the target: it happened (with optional receipt) or it did not. */
	readonly outcome: "done" | "failed";
	readonly receipt?: unknown;
	readonly note?: string;
}

// ---------------------------------------------------------------- assistants / team / subagents

/** M03-C: distinct type tags and permission contracts. */
export type MemberType = "builtin_subagent" | "external_tool" | "third_party_agent";

export interface MemberDeclaration {
	readonly id: string;
	readonly name: string;
	readonly type: MemberType;
	readonly description?: string;
	readonly model?: { readonly provider: string; readonly modelId: string };
	readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	/** Explicit allowlist; [] = no tools. A child never inherits the parent's tools. */
	readonly tools: readonly string[];
	readonly knowledgeScope?: { readonly kbIds: readonly string[] };
	readonly maxTurns: number;
	readonly budget?: { readonly maxTokens?: number; readonly maxCostUsd?: number };
	readonly instructions?: string;
	/** third_party_agent / external_tool: connector or tool id the call goes through. */
	readonly connectorId?: string;
}

export interface AssistantDTO {
	readonly id: string;
	readonly name: string;
	readonly avatar?: string;
	readonly description: string;
	readonly instructions?: string;
	readonly model?: { readonly provider: string; readonly modelId: string };
	readonly tools?: readonly string[];
	readonly knowledge?: { readonly kbIds: readonly string[] };
	readonly members: readonly MemberDeclaration[];
	readonly scope: "personal" | "org";
	readonly createdBy: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly builtin?: boolean;
	/** For the caller: whether the default model may be used now (gateway list, current ACL / credentials). */
	readonly modelAvailability?: { readonly status: "ok" | "not_allowed" | "blocked"; readonly reason?: string };
}

export type SubagentStatus = "running" | "done" | "failed" | "aborted" | "unanswered";

export interface SubagentDTO {
	readonly delegationId: string;
	readonly memberId: string;
	readonly memberName: string;
	readonly memberType: MemberType;
	readonly mode: "foreground" | "background";
	/** 来源: the parent conversation and the call that started it. */
	readonly source: { readonly conversationId: number; readonly callId: string; readonly taskId: number };
	/** 负责人: the principal the work runs for. */
	readonly ownerUserId?: string;
	readonly childConversationId?: number;
	readonly status: SubagentStatus;
	readonly task: string;
	readonly resultSummary?: string;
	readonly failure?: string;
	readonly usage?: UsageDTO;
	readonly startedAt: string;
	readonly endedAt?: string;
}

export interface TaskNodeDTO {
	readonly taskId: number;
	readonly kind: string;
	readonly conversationId: number;
	readonly ownerTaskId?: number;
	readonly background: boolean;
	readonly abortRequested: boolean;
	readonly status: string;
	readonly phase?: string;
	readonly blocked?: string;
	readonly conversations: readonly number[];
}

export interface TasksResponse {
	readonly tasks: readonly TaskNodeDTO[];
	readonly subagents: readonly SubagentDTO[];
}

// ---------------------------------------------------------------- handoff (M09-B)

/** A decision already taken in the conversation (decided approval). */
export interface HandoffDecision {
	readonly approvalId: string;
	readonly conversationId: number;
	readonly title: string;
	readonly summary: string;
	readonly toolName?: string;
	readonly decision: "approved" | "rejected";
	readonly decidedBy: string;
	readonly decidedByName?: string;
	readonly decidedAt: string;
	readonly note?: string;
}

/** One user input and what became of it (progress). */
export interface HandoffRun {
	readonly submissionId?: number;
	readonly entryId: number;
	readonly requestedBy?: string;
	readonly requestedByName?: string;
	readonly text: string;
	readonly status?: SubmissionStatus;
	readonly reason?: string;
	readonly answerExcerpt?: string;
	readonly via?: UserEntryDTO["via"];
	readonly placed?: boolean;
}

export interface HandoffPending {
	readonly approvals: readonly ApprovalDTO[];
	/** External writes whose outcome is unknown (待核对). */
	readonly effects: readonly EffectDTO[];
	readonly queued: readonly QueuedInputDTO[];
	/** Present when the last run ended without an answer and can be resumed with POST …/continue. */
	readonly continuable?: { readonly reason: string; readonly detail?: string };
	readonly runningSubagents: readonly SubagentDTO[];
}

/** A file version whose provenance points at this conversation. */
export interface HandoffDeliverable {
	readonly fileId: string;
	readonly versionId: string;
	readonly versionNo: number;
	readonly name: string;
	readonly mime: string;
	readonly createdAt: string;
	readonly createdBy: string;
	readonly createdByName?: string;
	readonly conversationId?: number;
	readonly downloadUrl?: string;
	readonly previewUrl?: string;
}

export interface HandoffParticipant {
	readonly userId: string;
	readonly name?: string;
	/** Current project role ("owner" of a personal space); null = no longer a member. */
	readonly role: "owner" | "editor" | "viewer" | null;
	readonly messages: number;
	readonly decisions: number;
}

/** GET /conversations/:spaceId/:id/handoff — everything derived from pi-durable state + the files service. */
export interface ConversationHandoff {
	readonly conversation: ConversationSummary;
	readonly status: RunStatus;
	readonly generatedAt: string;
	readonly decisions: readonly HandoffDecision[];
	readonly runs: readonly HandoffRun[];
	readonly pending: HandoffPending;
	readonly deliverables: readonly HandoffDeliverable[];
	/** Set when the files service is unavailable (deliverables could not be listed). */
	readonly deliverablesUnavailable?: string;
	readonly participants: readonly HandoffParticipant[];
	readonly subagents: readonly SubagentDTO[];
	readonly lastAnswer?: string;
	/** What the caller may do now (current ACL). */
	readonly access: { readonly canWrite: boolean; readonly reason: string };
}

export interface ProjectHandoffConversation {
	readonly conversation: ConversationSummary;
	readonly status: RunStatus;
	readonly pendingApprovals: number;
	readonly needsReconciliation: number;
	readonly queued: number;
	readonly continuable: boolean;
	readonly deliverables: number;
	readonly lastAnswer?: string;
}

/** GET /projects/:projectId/handoff */
export interface ProjectHandoff {
	readonly project: { readonly id: string; readonly name: string; readonly description?: string; readonly spaceId: string };
	readonly generatedAt: string;
	readonly members: readonly HandoffParticipant[];
	readonly conversations: readonly ProjectHandoffConversation[];
	readonly deliverables: readonly HandoffDeliverable[];
	readonly deliverablesUnavailable?: string;
	readonly access: { readonly canWrite: boolean; readonly reason: string };
}

// ---------------------------------------------------------------- SSE

/**
 * Full conversation state, sent as SSE `snapshot` on connect and `state` (throttled) on every change.
 * `entries` is a window (newest ≤100); page older ones with GET .../entries?before=<entries[0].id>.
 */
export interface ConversationState {
	readonly conversation: ConversationSummary;
	readonly entries: readonly EntryDTO[];
	readonly hasEarlier: boolean;
	readonly live: LiveDTO;
	readonly queue: readonly QueuedInputDTO[];
	readonly approvals: readonly ApprovalDTO[];
	readonly effects: readonly EffectDTO[];
	readonly subagents: readonly SubagentDTO[];
	readonly usage: UsageDTO;
	readonly agent: AgentDTO;
	/** Background jobs and live browser sessions of this conversation (group D's `work` service; absent without it). */
	readonly work?: import("./files.ts").ConversationWorkDTO;
	/** Monotonic per connection. */
	readonly revision: number;
	readonly at: string;
}

/** SSE event names: `snapshot` | `state` carry ConversationState; `ping` carries {at}; `error` carries {code, message} and the server closes. */
export type ConversationEventName = "snapshot" | "state" | "ping" | "error";

export const FIXTURE_LABEL = "测试模型（非真实 AI）";
