// Conversational "distill conversation into a skill" (整理为技能):
// - POST /api/skills/distill creates a new conversation in the caller's personal space linked to the source conversation
//   and returns a prefilled prompt (base template + extracted outline of the source). Nothing is auto-sent.
// - GET /api/skills/distill/:spaceId/:conversationId returns the linked source (404 for ordinary conversations).
// - Tool `session_trace` (overview / list / get / search) reads a conversation's traces progressively with redaction and ACL.
// - Prompt section `skill_distill` injects the built-in skill 「会话经验提炼」 ONLY into linked distill conversations.
import { readFileSync } from "node:fs";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, section, type EntryRecord, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { Hono } from "hono";
import type { AppContext, AppEnv, Principal, Space, ToolActor } from "../core/contracts.ts";
import type { Migration } from "../core/db.ts";
import { HttpError, jsonBody, newId, nowIso, principalOf } from "../core/http.ts";
import { runtimeActorResolver, type ActorResolver } from "../files/actor.ts";
import { redactText as redactLogText } from "../ops/log.ts";
import { textOfContent } from "../runtime/fixture-model.ts";
import type { Runtime } from "../runtime/service.ts";
import { redactText as redactCallText, type ToolCallLog } from "./calls.ts";
import {
	BUILTIN_DISTILL_SKILL_NAME,
	SESSION_TRACE_TOOL,
	type SessionTraceGetResponse,
	type SessionTraceItem,
	type SessionTraceItemKind,
	type SessionTraceListResponse,
	type SessionTraceOverview,
	type SessionTraceSearchHit,
	type SessionTraceSearchResponse,
	type SkillDistillLinkResponse,
	type SkillDistillSourceDTO,
	type SkillDistillStartRequest,
	type SkillDistillStartResponse,
} from "../../../shared/skill-distill.ts";

// ------------------------------------------------------------------ storage
/** Register in tools/module.ts with version + 1800. */
export const SKILL_DISTILL_MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "skill_distill_links",
		sql: `
CREATE TABLE skill_distill_links (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  distill_space_id TEXT NOT NULL,
  distill_conversation_id INTEGER NOT NULL,
  source_space_id TEXT NOT NULL,
  source_conversation_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (distill_space_id, distill_conversation_id)
);
CREATE INDEX skill_distill_links_source ON skill_distill_links(source_space_id, source_conversation_id);
`,
	},
];

export interface DistillLinkRow {
	id: string;
	org_id: string;
	user_id: string;
	distill_space_id: string;
	distill_conversation_id: number;
	source_space_id: string;
	source_conversation_id: number;
	created_at: string;
}

export const BUILTIN_DISTILL_SKILL_BODY = readFileSync(new URL("./builtin-skills/session-distill.md", import.meta.url), "utf8").trim();

// ------------------------------------------------------------------ redaction & formatting
const EXTRA_SECRET_PATTERNS: [RegExp, string][] = [
	[/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g, "<private-key>"],
	[/\bAIza[0-9A-Za-z_-]{35}\b/g, "<google-api-key>"],
];

export function redactTraceText(text: string): string {
	if (!text) return "";
	let out = redactLogText(redactCallText(text), "standard");
	for (const [re, rep] of EXTRA_SECRET_PATTERNS) out = out.replace(re, rep);
	return out;
}

function collapseText(s: string): string {
	return s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

export function truncateText(s: string, max: number): string {
	if (max <= 0) return "";
	if (s.length <= max) return s;
	if (max === 1) return s.slice(0, 1);
	return `${s.slice(0, max - 1)}…`;
}

function makeSummary(prefix: string, body: string, max = 200): string {
	const clean = collapseText(redactTraceText(body));
	const full = clean ? `${prefix}${clean}` : prefix.trimEnd();
	return truncateText(full, max);
}

// ------------------------------------------------------------------ pure trace builder + pagination/slicing/search
export interface TraceToolCallRow {
	readonly id: string;
	readonly tool: string;
	readonly args_summary: string;
	readonly status: string;
	readonly error?: string | null;
	readonly result_summary?: string | null;
	readonly call_id?: string | null;
	readonly started_at: string;
	readonly started_ms: number;
	readonly duration_ms?: number | null;
}

export interface TraceFileVersionRow {
	readonly id: string;
	readonly file_id: string;
	readonly version_no: number;
	readonly name: string;
	readonly mime: string;
	readonly size: number;
	readonly origin: string;
	readonly tool?: string | null;
	readonly change_note?: string | null;
	readonly created_at: string;
}

export interface TraceItemInternal extends SessionTraceItem {
	readonly fullText: string;
	readonly sortMs: number;
	readonly seq: number;
}

const KIND_ORDER: Record<SessionTraceItemKind, number> = {
	user: 0,
	assistant: 1,
	tool_call: 2,
	file: 3,
	notice: 4,
};

function parseMs(val: unknown): number | undefined {
	if (typeof val === "number" && Number.isFinite(val)) return val;
	if (typeof val === "string") {
		const ms = Date.parse(val);
		if (Number.isFinite(ms)) return ms;
	}
	return undefined;
}

function entryTextUser(e: EntryRecord): { text: string; attachments: string[]; knowledge: string[] } {
	const d = (e.data ?? {}) as Record<string, any>;
	const msg = e.model?.[0] as { content?: unknown } | undefined;
	const raw = typeof d.text === "string" ? d.text : msg?.content !== undefined ? textOfContent(msg.content as any) : "";
	const attachments = Array.isArray(d.attachments) ? d.attachments.map((a: any) => `${a.name ?? "file"} (fileId=${a.fileId ?? ""}, versionId=${a.versionId ?? ""})`) : [];
	const knowledge = Array.isArray(d.knowledgeRefs) ? d.knowledgeRefs.map((k: any) => `${k.name ?? "kb"} (kbId=${k.kbId ?? ""})`) : [];
	return { text: raw, attachments, knowledge };
}

export function buildTraceItems(input: {
	entries: readonly EntryRecord[];
	toolCalls: readonly TraceToolCallRow[];
	files: readonly TraceFileVersionRow[];
	createdAt?: string;
}): { items: TraceItemInternal[]; firstUserRequest: string; userTurns: number; assistantTurns: number } {
	const baseMs = parseMs(input.createdAt) ?? 0;
	let lastMs = baseMs;
	let seq = 0;

	// Map pi.tool-result entries by toolCallId so we can enrich tool_calls rows with actual tool output.
	const toolResultByCallId = new Map<string, { entry: EntryRecord; text: string; isError: boolean; ms?: number }>();
	for (const e of input.entries) {
		if (e.kind !== "pi.tool-result") continue;
		const m = e.model?.[0] as { toolCallId?: string; toolName?: string; content?: unknown; isError?: boolean; timestamp?: number } | undefined;
		const callId = m?.toolCallId;
		const text = redactTraceText(textOfContent((m?.content ?? []) as any));
		if (callId) toolResultByCallId.set(callId, { entry: e, text, isError: !!m?.isError, ms: parseMs(m?.timestamp) });
	}

	const matchedCallIds = new Set<string>();
	const items: TraceItemInternal[] = [];
	let firstUserRequest = "";
	let userTurns = 0;
	let assistantTurns = 0;

	for (const e of input.entries) {
		const m0 = e.model?.[0] as any;
		const d = (e.data ?? {}) as Record<string, any>;
		const rawMs = parseMs(m0?.timestamp) ?? parseMs(d.at);
		const ms = rawMs ?? lastMs + 1;
		lastMs = Math.max(lastMs, ms);
		const at = ms > 0 ? new Date(ms).toISOString() : input.createdAt ?? "";

		if (e.kind === "wr.input" || e.kind === "pi.user") {
			userTurns++;
			const { text, attachments, knowledge } = entryTextUser(e);
			const redacted = redactTraceText(text);
			if (!firstUserRequest && redacted.trim()) firstUserRequest = truncateText(collapseText(redacted), 300);
			const extra: string[] = [];
			if (attachments.length) extra.push(`[附件]\n${attachments.map((x) => `- ${redactTraceText(x)}`).join("\n")}`);
			if (knowledge.length) extra.push(`[引用知识]\n${knowledge.map((x) => `- ${redactTraceText(x)}`).join("\n")}`);
			const fullText = [redacted, ...extra].filter(Boolean).join("\n\n");
			items.push({
				id: `e${e.id as number}`,
				kind: "user",
				at,
				summary: makeSummary("[用户] ", redacted),
				fullText,
				sortMs: ms,
				seq: ++seq,
			});
			continue;
		}

		if (e.kind === "pi.assistant") {
			assistantTurns++;
			const blocks = Array.isArray(m0?.content) ? m0.content : [];
			const textParts: string[] = [];
			const thinkParts: string[] = [];
			const callParts: string[] = [];
			const callNames: string[] = [];
			for (const c of blocks) {
				if (c?.type === "text" && typeof c.text === "string" && c.text) textParts.push(c.text);
				else if (c?.type === "thinking" && typeof c.thinking === "string" && c.thinking) thinkParts.push(c.thinking);
				else if (c?.type === "toolCall" && typeof c.name === "string") {
					callNames.push(c.name);
					let argsStr = "";
					try {
						argsStr = JSON.stringify(c.arguments ?? {});
					} catch {
						argsStr = "{}";
					}
					callParts.push(`${c.name}(${argsStr})`);
				}
			}
			const stopReason = typeof m0?.stopReason === "string" ? m0.stopReason : undefined;
			const errMsg = typeof m0?.errorMessage === "string" ? m0.errorMessage : undefined;
			const fullParts: string[] = [];
			if (thinkParts.length) fullParts.push(`[思考]\n${redactTraceText(thinkParts.join("\n"))}`);
			if (textParts.length) fullParts.push(redactTraceText(textParts.join("")));
			if (callParts.length) fullParts.push(`[工具调用]\n${callParts.map((x) => `- ${redactTraceText(x)}`).join("\n")}`);
			if (errMsg) fullParts.push(`[错误: ${stopReason ?? "error"}] ${redactTraceText(errMsg)}`);
			const fullText = fullParts.join("\n\n") || "(空回复)";
			const brief = textParts.join(" ") || (callNames.length ? `调用工具：${callNames.join("、")}` : errMsg ?? "(空回复)");
			const status = stopReason === "error" || stopReason === "aborted" ? stopReason : undefined;
			items.push({
				id: `e${e.id as number}`,
				kind: "assistant",
				at,
				...(status ? { status } : {}),
				summary: makeSummary("[助手] ", brief),
				fullText,
				sortMs: ms,
				seq: ++seq,
			});
			continue;
		}

		if (e.kind === "wr.notice" || e.kind === "pi.compaction") {
			const txt = e.kind === "wr.notice" ? String(d.text ?? "") : m0?.content ? textOfContent(m0.content) : "";
			if (!txt.trim()) continue;
			const code = typeof d.code === "string" && d.code ? d.code : e.kind === "pi.compaction" ? "compaction" : "notice";
			const redacted = redactTraceText(txt);
			items.push({
				id: `e${e.id as number}`,
				kind: "notice",
				at,
				summary: makeSummary(`[通知:${code}] `, redacted),
				fullText: `[${code}] ${redacted}`,
				sortMs: ms,
				seq: ++seq,
			});
			continue;
		}
	}

	// Tool call rows from tool_calls table
	for (const tc of input.toolCalls) {
		const ms = Number.isFinite(tc.started_ms) ? tc.started_ms : parseMs(tc.started_at) ?? ++lastMs;
		const at = tc.started_at || (ms > 0 ? new Date(ms).toISOString() : "");
		const linkedResult = tc.call_id ? toolResultByCallId.get(tc.call_id) : undefined;
		if (tc.call_id && linkedResult) matchedCallIds.add(tc.call_id);

		const lines = [
			`tool: ${tc.tool}`,
			`status: ${tc.status}`,
			`started_at: ${at}${tc.duration_ms != null ? ` (${tc.duration_ms}ms)` : ""}`,
			`args: ${redactTraceText(tc.args_summary)}`,
		];
		if (tc.error) lines.push(`error: ${redactTraceText(tc.error)}`);
		if (tc.result_summary) lines.push(`result_summary: ${redactTraceText(tc.result_summary)}`);
		if (linkedResult?.text && linkedResult.text !== tc.result_summary) {
			lines.push(`output:\n${linkedResult.text}`);
		}
		const fullText = lines.join("\n");
		const brief = tc.error ? `${tc.error}` : tc.args_summary;
		items.push({
			id: tc.id,
			kind: "tool_call",
			at,
			status: tc.status,
			summary: makeSummary(`[工具:${tc.tool}${tc.status !== "ok" ? `:${tc.status}` : ""}] `, brief),
			fullText,
			sortMs: ms,
			seq: ++seq,
		});
	}

	// Any pi.tool-result entry that did not have a matching tool_calls row (e.g. standalone harness tests)
	for (const e of input.entries) {
		if (e.kind !== "pi.tool-result") continue;
		const m = e.model?.[0] as { toolCallId?: string; toolName?: string; content?: unknown; isError?: boolean; timestamp?: number } | undefined;
		if (m?.toolCallId && matchedCallIds.has(m.toolCallId)) continue;
		const ms = parseMs(m?.timestamp) ?? ++lastMs;
		const at = ms > 0 ? new Date(ms).toISOString() : "";
		const tool = m?.toolName ?? "tool";
		const status = m?.isError ? "error" : "ok";
		const body = redactTraceText(textOfContent((m?.content ?? []) as any));
		const fullText = [`tool: ${tool}`, `status: ${status}`, ...(body ? [`output:\n${body}`] : [])].join("\n");
		items.push({
			id: `e${e.id as number}`,
			kind: "tool_call",
			at,
			status,
			summary: makeSummary(`[工具:${tool}${status !== "ok" ? `:${status}` : ""}] `, body || status),
			fullText,
			sortMs: ms,
			seq: ++seq,
		});
	}

	// File versions produced in this conversation
	for (const f of input.files) {
		const ms = parseMs(f.created_at) ?? ++lastMs;
		const lines = [
			`file: ${redactTraceText(f.name)} (v${f.version_no})`,
			`mime: ${f.mime}, size: ${f.size} bytes`,
			`origin: ${f.origin}${f.tool ? `, tool: ${f.tool}` : ""}`,
			...(f.change_note ? [`change_note: ${redactTraceText(f.change_note)}`] : []),
			`file_id: ${f.file_id}, version_id: ${f.id}`,
			`created_at: ${f.created_at}`,
		];
		items.push({
			id: `f_${f.id}`,
			kind: "file",
			at: f.created_at,
			status: f.origin,
			summary: makeSummary(`[文件] `, `${f.name} v${f.version_no} (${f.tool ?? f.origin})`),
			fullText: lines.join("\n"),
			sortMs: ms,
			seq: ++seq,
		});
	}

	items.sort((a, b) => a.sortMs - b.sortMs || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.seq - b.seq);
	return { items, firstUserRequest, userTurns, assistantTurns };
}

export function buildTraceOverview(input: {
	spaceId: string;
	conversationId: number;
	title: string;
	createdAt: string;
	items: readonly TraceItemInternal[];
	toolCalls: readonly TraceToolCallRow[];
	files: readonly TraceFileVersionRow[];
	firstUserRequest: string;
	userTurns: number;
	assistantTurns: number;
}): SessionTraceOverview {
	const toolStats = new Map<string, { tool: string; count: number; ok: number; failed: number }>();
	let toolCallsOk = 0;
	let toolCallsFailed = 0;

	if (input.toolCalls.length > 0) {
		for (const tc of input.toolCalls) {
			const ok = tc.status === "ok";
			if (ok) toolCallsOk++;
			else toolCallsFailed++;
			const cur = toolStats.get(tc.tool) ?? { tool: tc.tool, count: 0, ok: 0, failed: 0 };
			cur.count++;
			if (ok) cur.ok++;
			else cur.failed++;
			toolStats.set(tc.tool, cur);
		}
	} else {
		for (const it of input.items) {
			if (it.kind !== "tool_call") continue;
			const ok = it.status === "ok";
			if (ok) toolCallsOk++;
			else toolCallsFailed++;
			const m = /^tool:\s*([^\n]+)/.exec(it.fullText);
			const name = m?.[1]?.trim() || "tool";
			const cur = toolStats.get(name) ?? { tool: name, count: 0, ok: 0, failed: 0 };
			cur.count++;
			if (ok) cur.ok++;
			else cur.failed++;
			toolStats.set(name, cur);
		}
	}

	const toolsUsed = [...toolStats.values()].sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)).slice(0, 20);
	const filesProduced = input.files.slice(0, 20).map((f) => ({
		name: truncateText(redactTraceText(f.name), 80),
		versionNo: f.version_no,
		...(f.tool ? { tool: f.tool } : {}),
	}));

	let out: SessionTraceOverview = {
		spaceId: input.spaceId,
		conversationId: input.conversationId,
		title: truncateText(redactTraceText(input.title), 160),
		createdAt: input.createdAt,
		counts: {
			userTurns: input.userTurns,
			assistantTurns: input.assistantTurns,
			toolCallsOk,
			toolCallsFailed,
			filesProduced: input.files.length,
			totalItems: input.items.length,
		},
		firstUserRequest: truncateText(input.firstUserRequest, 300),
		toolsUsed,
		filesProduced,
	};

	// Guarantee overview JSON stays bounded (<= 3 KB).
	if (JSON.stringify(out).length > 2900) {
		out = { ...out, toolsUsed: toolsUsed.slice(0, 10), filesProduced: filesProduced.slice(0, 10), firstUserRequest: truncateText(out.firstUserRequest, 180) };
	}
	return out;
}

export function toPublicItem(item: TraceItemInternal): SessionTraceItem {
	return {
		id: item.id,
		kind: item.kind,
		at: item.at,
		...(item.status ? { status: item.status } : {}),
		summary: item.summary,
	};
}

export function paginateTrace(items: readonly TraceItemInternal[], offset = 0, limit = 20): SessionTraceListResponse {
	const off = Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0));
	const lim = Math.min(Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 20)), 50);
	const page = items.slice(off, off + lim).map(toPublicItem);
	const nextOffset = off + page.length < items.length ? off + page.length : null;
	return { items: page, total: items.length, nextOffset };
}

export function sliceTraceItem(item: TraceItemInternal, from = 0, length = 4000): SessionTraceGetResponse {
	const start = Math.max(0, Math.floor(Number.isFinite(from) ? from : 0));
	const len = Math.min(Math.max(1, Math.floor(Number.isFinite(length) ? length : 4000)), 8000);
	const text = item.fullText.slice(start, start + len);
	const nextFrom = start + text.length < item.fullText.length ? start + text.length : null;
	return {
		item: toPublicItem(item),
		text,
		total: item.fullText.length,
		nextFrom,
	};
}

function extractSnippet(text: string, lowerQuery: string, max = 200): string {
	const lower = text.toLowerCase();
	const idx = lower.indexOf(lowerQuery);
	if (idx < 0) return truncateText(collapseText(text), max);
	const half = Math.floor((max - lowerQuery.length) / 2);
	let start = Math.max(0, idx - Math.max(20, half));
	let end = Math.min(text.length, start + max - 2);
	if (end - start < max - 2 && start > 0) start = Math.max(0, end - (max - 2));
	const body = collapseText(text.slice(start, end));
	const prefix = start > 0 ? "…" : "";
	const suffix = end < text.length ? "…" : "";
	return truncateText(`${prefix}${body}${suffix}`, max);
}

export function searchTraceItems(items: readonly TraceItemInternal[], query: string): SessionTraceSearchResponse {
	const q = query.trim().toLowerCase();
	if (!q) throw new HttpError(400, "invalid_args", "search 需要非空 query");
	const hits: SessionTraceSearchHit[] = [];
	let totalHits = 0;
	for (const it of items) {
		const matchFull = it.fullText.toLowerCase().includes(q);
		const matchSummary = !matchFull && it.summary.toLowerCase().includes(q);
		if (!matchFull && !matchSummary) continue;
		totalHits++;
		if (hits.length < 20) {
			hits.push({
				id: it.id,
				kind: it.kind,
				at: it.at,
				...(it.status ? { status: it.status } : {}),
				snippet: extractSnippet(matchFull ? it.fullText : it.summary, q, 200),
			});
		}
	}
	return { hits, totalHits, truncated: totalHits > hits.length };
}

// ------------------------------------------------------------------ prefilled prompt & section
export function buildDistillPrompt(source: SkillDistillSourceDTO, overview: SessionTraceOverview): string {
	const render = (reqLimit: number, toolLimit: number, fileLimit: number) => {
		const firstReq = overview.firstUserRequest ? truncateText(overview.firstUserRequest, reqLimit) : "（无文本输入）";
		const topTools = overview.toolsUsed.length
			? overview.toolsUsed
					.slice(0, toolLimit)
					.map((t) => `${t.tool}×${t.count}`)
					.join("、")
			: "无";
		const files = overview.filesProduced.length
			? overview.filesProduced
					.slice(0, fileLimit)
					.map((f) => `${f.name}(v${f.versionNo})`)
					.join("、")
			: "无";
		const totalCalls = overview.counts.toolCallsOk + overview.counts.toolCallsFailed;
		return [
			`请使用内置技能「${BUILTIN_DISTILL_SKILL_NAME}」和工具 \`${SESSION_TRACE_TOOL}\`，逐步分析源会话「${source.title}」（spaceId=${source.spaceId}，conversationId=${source.conversationId}），从中提炼可复用的标准技能。`,
			`请自行生成技能名称（name）、描述（description）、适用场景、参数化步骤与避坑注意，将 SKILL.md（及必要脚本）写入工作区目录，并调用 \`skill_manage\`（action="submit_draft"）提交保存。`,
			`完成后总结提炼内容，并提醒我可以在本对话继续微调，或在「能力 › 我的技能」点击「提交审核」。`,
			"",
			"源会话概览：",
			`- 首条需求：${firstReq}`,
			`- 轮次与工具：用户 ${overview.counts.userTurns} 轮 / 助手 ${overview.counts.assistantTurns} 轮，工具调用 ${totalCalls} 次（成功 ${overview.counts.toolCallsOk}，失败 ${overview.counts.toolCallsFailed}）`,
			`- 常用工具：${topTools}`,
			`- 产出文件：${files}`,
		].join("\n");
	};

	let text = render(300, 6, 6);
	if (Buffer.byteLength(text, "utf8") > 1536) text = render(180, 5, 4);
	if (Buffer.byteLength(text, "utf8") > 1536) text = render(100, 3, 3);
	return text;
}

export function renderDistillSection(source: SkillDistillSourceDTO): string {
	return [
		`## 内置技能：${BUILTIN_DISTILL_SKILL_NAME}`,
		`本会话是技能提炼会话，关联的源会话为：「${source.title}」（spaceId=${source.spaceId}，conversationId=${source.conversationId}）。`,
		`调用 \`${SESSION_TRACE_TOOL}\` 时不传 spaceId / conversationId 即默认读取该源会话。`,
		"",
		BUILTIN_DISTILL_SKILL_BODY,
	].join("\n");
}

// ------------------------------------------------------------------ service
export interface LoadedTrace {
	overview: SessionTraceOverview;
	items: TraceItemInternal[];
}

export class SkillDistillService {
	readonly #ctx: AppContext;
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}
	get #db() {
		return this.#ctx.db;
	}
	#rt(): Runtime {
		if (!this.#ctx.services.has("runtime")) throw new HttpError(503, "runtime_unavailable", "运行内核未就绪");
		return this.#ctx.services.get("runtime") as Runtime;
	}

	linkForDistill(spaceId: string, conversationId: number): DistillLinkRow | undefined {
		return this.#db.get<DistillLinkRow>("SELECT * FROM skill_distill_links WHERE distill_space_id = ? AND distill_conversation_id = ?", spaceId, conversationId);
	}

	sourceTitle(spaceId: string, conversationId: number): string {
		const row = this.#db.get<{ title: string }>("SELECT title FROM rt_conversations WHERE space_id = ? AND conversation_id = ?", spaceId, conversationId);
		return row?.title || `会话 ${conversationId}`;
	}

	async loadTrace(p: Principal, spaceId: string, conversationId: number, context: Context = BACKGROUND_CONTEXT): Promise<LoadedTrace> {
		const rt = this.#rt();
		const { conv, row } = await rt.access(p, "read", spaceId, conversationId, context);
		const entries: EntryRecord[] = [];
		let cursor: any;
		for (let page = 0; page < 50; page++) {
			const res = await conv.entries({ order: "ascending" }, 200, cursor, context);
			entries.push(...res.items);
			if (!res.next) break;
			cursor = res.next;
		}
		const toolCalls = this.#db.all<TraceToolCallRow>(
			"SELECT id, tool, args_summary, status, error, result_summary, call_id, started_at, started_ms, duration_ms FROM tool_calls WHERE space_id = ? AND conversation_id = ? ORDER BY started_ms ASC, rowid ASC",
			spaceId,
			conversationId,
		);
		const files = this.#db.all<TraceFileVersionRow>(
			"SELECT v.id, v.file_id, v.version_no, v.name, v.mime, v.size, v.origin, v.tool, v.change_note, v.created_at FROM file_versions v JOIN file_files f ON f.id = v.file_id WHERE v.space_id = ? AND v.conversation_id = ? AND f.deleted_at IS NULL ORDER BY v.created_at ASC, v.version_no ASC",
			spaceId,
			conversationId,
		);
		const title = row?.title || `会话 ${conversationId}`;
		const createdAt = row?.created_at || nowIso();
		const built = buildTraceItems({ entries, toolCalls, files, createdAt });
		const overview = buildTraceOverview({
			spaceId,
			conversationId,
			title,
			createdAt,
			items: built.items,
			toolCalls,
			files,
			firstUserRequest: built.firstUserRequest,
			userTurns: built.userTurns,
			assistantTurns: built.assistantTurns,
		});
		return { overview, items: built.items };
	}

	async startDistill(p: Principal, sourceSpaceId: string, sourceConversationId: number): Promise<SkillDistillStartResponse> {
		if (typeof sourceSpaceId !== "string" || !sourceSpaceId.trim()) throw new HttpError(400, "invalid", "spaceId 必填");
		if (!Number.isInteger(sourceConversationId) || sourceConversationId <= 0) throw new HttpError(400, "invalid_id", "conversationId 无效");
		const rt = this.#rt();
		const { overview } = await this.loadTrace(p, sourceSpaceId, sourceConversationId, BACKGROUND_CONTEXT);
		const source: SkillDistillSourceDTO = { spaceId: sourceSpaceId, conversationId: sourceConversationId, title: overview.title };
		const personalSpace = this.#ctx.services.get("identity").personalSpace(p.userId, p.orgId);
		const title = `整理为技能：${overview.title}`.slice(0, 200);
		const { conversationId: distillConversationId } = await rt.createConversation(p, personalSpace.id, { title }, BACKGROUND_CONTEXT);
		this.#db.run(
			"INSERT INTO skill_distill_links (id, org_id, user_id, distill_space_id, distill_conversation_id, source_space_id, source_conversation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			newId("sdl"),
			p.orgId,
			p.userId,
			personalSpace.id,
			distillConversationId,
			sourceSpaceId,
			sourceConversationId,
			nowIso(),
		);
		const detail = await rt.detail(p, personalSpace.id, distillConversationId, BACKGROUND_CONTEXT);
		return {
			conversation: detail.conversation,
			prompt: buildDistillPrompt(source, overview),
			source,
		};
	}

	async getLink(p: Principal, distillSpaceId: string, distillConversationId: number): Promise<SkillDistillLinkResponse> {
		if (!Number.isInteger(distillConversationId) || distillConversationId <= 0) throw new HttpError(400, "invalid_id", "会话 id 无效");
		const rt = this.#rt();
		await rt.access(p, "read", distillSpaceId, distillConversationId, BACKGROUND_CONTEXT);
		const link = this.linkForDistill(distillSpaceId, distillConversationId);
		if (!link || link.org_id !== p.orgId) throw new HttpError(404, "not_found", "该会话不是技能提炼会话");
		return {
			source: {
				spaceId: link.source_space_id,
				conversationId: link.source_conversation_id,
				title: this.sourceTitle(link.source_space_id, link.source_conversation_id),
			},
		};
	}
}

const instances = new WeakMap<AppContext, SkillDistillService>();
export function skillDistillFor(ctx: AppContext): SkillDistillService {
	let svc = instances.get(ctx);
	if (!svc) instances.set(ctx, (svc = new SkillDistillService(ctx)));
	return svc;
}

// ------------------------------------------------------------------ agent extension (session_trace + distill prompt section)
export function createSkillDistillExtension(
	ctx: AppContext,
	opts: {
		resolveActor?: ActorResolver;
		loadTrace?: (p: Principal, spaceId: string, conversationId: number, context: Context) => Promise<LoadedTrace>;
	} = {},
): Extension {
	const resolve = (api: ToolExecutionApi<any>, c: Context) => (opts.resolveActor ?? runtimeActorResolver(ctx))(api, c);
	const svc = () => skillDistillFor(ctx);
	const log = () => ctx.services.get("toolCalls") as ToolCallLog;

	const sessionTrace = defineTool({
		name: SESSION_TRACE_TOOL,
		description:
			"渐进式读取会话历史轨迹（只读，默认读取当前技能提炼对话关联的源会话；读取其他会话需有读权限）。" +
			"overview 查看概览；list 分页浏览条目摘要（每条 ≤200 字）；get 按 id 分片读取全文（每次 ≤8000 字，from/nextFrom 续读）；search 搜索关键词（最多 20 条）。",
		parameters: obj({
			action: oneOf(["overview", "list", "get", "search"], { description: "overview | list | get | search" }),
			spaceId: opt(str({ description: "目标空间 ID（默认关联的源会话）" })),
			conversationId: opt(num({ description: "目标会话 ID（默认关联的源会话）" })),
			offset: opt(num({ description: "list 起始偏移（默认 0）" })),
			limit: opt(num({ description: "list 每页条数（默认 20，最大 50）" })),
			id: opt(str({ description: "get 目标条目 id" })),
			from: opt(num({ description: "get 字符偏移（默认 0）" })),
			length: opt(num({ description: "get 返回长度（默认 4000，最大 8000）" })),
			query: opt(str({ description: "search 关键词（不区分大小写）" })),
		}),
		replay: "safe",
		async execute(args, api, c) {
			const actor = await resolve(api, c);
			return log().around({ tool: SESSION_TRACE_TOOL, actor, args }, async () => {
				const p = actor.principal;
				const action = args.action;
				if (!["overview", "list", "get", "search"].includes(action)) throw new HttpError(400, "invalid_args", "action 必须是 overview、list、get 或 search");

				let targetSpaceId: string;
				let targetConvId: number;
				if (args.conversationId !== undefined) {
					const cid = Number(args.conversationId);
					if (!Number.isInteger(cid) || cid <= 0) throw new HttpError(400, "invalid_args", "conversationId 必须是正整数");
					targetConvId = cid;
					targetSpaceId = args.spaceId?.trim() || actor.space.id;
				} else if (args.spaceId !== undefined) {
					throw new HttpError(400, "invalid_args", "指定 spaceId 时必须同时提供 conversationId");
				} else {
					const link = svc().linkForDistill(actor.space.id, actor.conversationId);
					if (!link) throw new HttpError(400, "missing_target", "当前会话未关联源会话，请传入 spaceId 和 conversationId");
					targetSpaceId = link.source_space_id;
					targetConvId = link.source_conversation_id;
				}

				await ctx.services.get("acl").require(p, "read", { kind: "conversation", id: String(targetConvId), spaceId: targetSpaceId });
				const trace = opts.loadTrace ? await opts.loadTrace(p, targetSpaceId, targetConvId, c) : await svc().loadTrace(p, targetSpaceId, targetConvId, c);

				let payload: SessionTraceOverview | SessionTraceListResponse | SessionTraceGetResponse | SessionTraceSearchResponse;
				if (action === "overview") {
					payload = trace.overview;
				} else if (action === "list") {
					if (args.offset !== undefined && (!Number.isFinite(args.offset) || args.offset < 0)) throw new HttpError(400, "invalid_args", "offset 必须是不小于 0 的数字");
					if (args.limit !== undefined && (!Number.isFinite(args.limit) || args.limit < 1)) throw new HttpError(400, "invalid_args", "limit 必须是正整数");
					payload = paginateTrace(trace.items, args.offset, args.limit);
				} else if (action === "get") {
					const id = args.id?.trim();
					if (!id) throw new HttpError(400, "invalid_args", "get 需要 id");
					const item = trace.items.find((x) => x.id === id);
					if (!item) throw new HttpError(404, "not_found", `未找到轨迹条目 ${id}`);
					if (args.from !== undefined && (!Number.isFinite(args.from) || args.from < 0)) throw new HttpError(400, "invalid_args", "from 必须是不小于 0 的数字");
					if (args.length !== undefined && (!Number.isFinite(args.length) || args.length < 1)) throw new HttpError(400, "invalid_args", "length 必须是正整数");
					payload = sliceTraceItem(item, args.from, args.length);
				} else {
					if (!args.query?.trim()) throw new HttpError(400, "invalid_args", "search 需要非空 query");
					payload = searchTraceItems(trace.items, args.query);
				}

				return {
					output: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
					details: payload as any,
				};
			});
		},
	});

	const distillSection = section("skill_distill", async (input, context) => {
		try {
			if (!ctx.services.has("runtime")) return undefined;
			const rt = ctx.services.get("runtime") as { promptScope?: (i: unknown, c: Context) => Promise<{ space: Space; principal: Principal | null } | null> };
			const scope = typeof rt.promptScope === "function" ? await rt.promptScope(input, context) : null;
			if (!scope?.principal) return undefined;
			const convId = Number(input.conversationId);
			if (!Number.isInteger(convId) || convId <= 0) return undefined;
			const link = svc().linkForDistill(scope.space.id, convId);
			if (!link || link.org_id !== scope.principal.orgId) return undefined;
			const d = await ctx.services.get("acl").check(scope.principal, "read", { kind: "conversation", id: String(link.source_conversation_id), spaceId: link.source_space_id });
			if (!d.allow) return undefined;
			return renderDistillSection({
				spaceId: link.source_space_id,
				conversationId: link.source_conversation_id,
				title: svc().sourceTitle(link.source_space_id, link.source_conversation_id),
			});
		} catch {
			return undefined;
		}
	});

	return defineExtension({
		name: "wr.skill-distill",
		tools: [sessionTrace],
		sections: [distillSection],
	});
}

// ------------------------------------------------------------------ HTTP routes
export function registerSkillDistillRoutes(api: Hono<AppEnv>, ctx: AppContext): void {
	const svc = skillDistillFor(ctx);
	api.post("/skills/distill", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<SkillDistillStartRequest>(c);
		return c.json(await svc.startDistill(p, b?.spaceId, Number(b?.conversationId)));
	});
	api.get("/skills/distill/:spaceId/:conversationId", async (c) => {
		const p = principalOf(c);
		return c.json(await svc.getLink(p, c.req.param("spaceId"), Number(c.req.param("conversationId"))));
	});
}
