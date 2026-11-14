// 对话式「整理为技能」contract (shared by server/src/tools/skill-distill.ts and the web chat page).
//
// Flow: the user clicks 「整理为技能」 in a conversation (the SOURCE). The web calls POST /api/skills/distill { spaceId, conversationId }.
// The server checks the caller may read the source, creates a NEW conversation in the caller's personal space that is linked to the source
// (a "distill conversation"), and returns it together with a prefilled prompt (a base skill-prompt template filled with a short, automatically
// extracted outline of the source). The web opens the new conversation and puts `prompt` into the composer; nothing is sent automatically.
// When the user sends it, the agent in the distill conversation has:
//   - the built-in skill 「会话经验提炼」 (BUILTIN_DISTILL_SKILL_NAME) in its system prompt (only in distill conversations),
//   - the tool `session_trace` to read the source conversation's traces PIECE BY PIECE (overview → list pages → get one item → search),
//     never the whole trace at once,
//   - the existing `skill_manage` tool: it writes SKILL.md into its workspace and calls skill_manage submit_draft; the existing approval card
//     saves it as a personal skill, which then goes through the existing skill 提交审核 chain (market submit) like any other skill.

import type { ConversationSummary } from "./chat.ts";

export const BUILTIN_DISTILL_SKILL_NAME = "会话经验提炼";
export const SESSION_TRACE_TOOL = "session_trace";

export interface SkillDistillStartRequest {
	readonly spaceId: string;
	readonly conversationId: number;
}

export interface SkillDistillSourceDTO {
	readonly spaceId: string;
	readonly conversationId: number;
	readonly title: string;
}

export interface SkillDistillStartResponse {
	/** The new distill conversation (caller's personal space). Open /c/:spaceId/:conversationId. */
	readonly conversation: ConversationSummary;
	/** Prefilled composer text: the base skill-prompt template + an extracted outline of the source. The user may edit it before sending. */
	readonly prompt: string;
	readonly source: SkillDistillSourceDTO;
}

/** GET /api/skills/distill/:spaceId/:conversationId → which source a distill conversation is linked to (404 when it is not one). */
export interface SkillDistillLinkResponse {
	readonly source: SkillDistillSourceDTO;
}

// ----------------------------------------------------------------- session_trace tool (agent side)
// Arguments: { action: "overview" | "list" | "get" | "search", spaceId?, conversationId?, offset?, limit?, id?, query?, from?, length? }
// spaceId/conversationId default to the distill conversation's linked source; any other conversation needs read access (ACL).
//   overview: title, created time, counts (user turns, assistant turns, tool calls ok/failed, files produced), the first user request (≤300 chars),
//             tool names used with counts, files produced. Small and bounded (≤ ~3 KB).
//   list:     a page of trace items in order, `offset` (default 0) / `limit` (default 20, max 50); each item is { id, kind, at, status?, summary }
//             with summary ≤ 200 chars; returns { items, total, nextOffset|null }.
//   get:      one item by `id`, its full text sliced by `from` (default 0) / `length` (default 4000, max 8000); returns { item, text, total, nextFrom|null }.
//   search:   items whose text contains `query` (case-insensitive), at most 20 hits, each with a ≤200-char snippet.
export type SessionTraceItemKind = "user" | "assistant" | "tool_call" | "file" | "notice";

export interface SessionTraceItem {
	/** Stable within one conversation, e.g. "e12" (entry) or "t3f9…" (tool call). */
	readonly id: string;
	readonly kind: SessionTraceItemKind;
	readonly at: string;
	readonly status?: string;
	readonly summary: string;
}

export interface SessionTraceOverview {
	readonly spaceId: string;
	readonly conversationId: number;
	readonly title: string;
	readonly createdAt: string;
	readonly counts: {
		readonly userTurns: number;
		readonly assistantTurns: number;
		readonly toolCallsOk: number;
		readonly toolCallsFailed: number;
		readonly filesProduced: number;
		readonly totalItems: number;
	};
	readonly firstUserRequest: string;
	readonly toolsUsed: readonly { readonly tool: string; readonly count: number; readonly ok: number; readonly failed: number }[];
	readonly filesProduced: readonly { readonly name: string; readonly versionNo: number; readonly tool?: string }[];
}

export interface SessionTraceListResponse {
	readonly items: readonly SessionTraceItem[];
	readonly total: number;
	readonly nextOffset: number | null;
}

export interface SessionTraceGetResponse {
	readonly item: SessionTraceItem;
	readonly text: string;
	readonly total: number;
	readonly nextFrom: number | null;
}

export interface SessionTraceSearchHit {
	readonly id: string;
	readonly kind: SessionTraceItemKind;
	readonly at: string;
	readonly status?: string;
	readonly snippet: string;
}

export interface SessionTraceSearchResponse {
	readonly hits: readonly SessionTraceSearchHit[];
	readonly totalHits: number;
	readonly truncated: boolean;
}
