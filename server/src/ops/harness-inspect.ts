// Harness 检视: records what the gateway hands to the model provider on every request, when the org switch is on.
// The capture point is Gateway.#runAttempts — the one place every agent-loop request passes with its final transcript
// (system prompt + tools + messages after pi-durable's hooks) — so the stored payload is the real one. Only the transcript and
// a whitelist of request options are read: apiKey / headers / env / fetch never reach this file.
import { getCurrentSystemMessage, getCurrentSystemPrompt, getCurrentTools, type Api, type AssistantMessage, type Message, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AppContext } from "../core/contracts.ts";
import { newId, nowIso } from "../core/http.ts";
import type {
	HarnessBuildDTO,
	HarnessRoundDetailDTO,
	HarnessRoundSummaryDTO,
	InspectContentBlock,
	InspectMessageDTO,
	InspectToolDTO,
	InspectUsageDTO,
} from "../../../shared/harness-inspect.ts";
import { logEvent, redactText } from "./log.ts";

export const HARNESS_INSPECT_KEY = "harness_inspect";

export interface InspectLimits {
	maxRoundsPerConversation: number;
	/** Serialized payload cap per round; text is truncated (then middle messages dropped) to fit. */
	maxRecordBytes: number;
	retentionDays: number;
}

function envInt(name: string, def: number): number {
	const n = Number(process.env[name]);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

export function defaultLimits(): InspectLimits {
	return {
		maxRoundsPerConversation: envInt("WORKROOM_HARNESS_INSPECT_MAX_ROUNDS", 200),
		maxRecordBytes: envInt("WORKROOM_HARNESS_INSPECT_MAX_BYTES", 1_500_000),
		retentionDays: envInt("WORKROOM_HARNESS_INSPECT_RETENTION_DAYS", 14),
	};
}

export interface InspectRequest {
	orgId?: string;
	spaceId?: string;
	userId?: string;
	conversationId?: number;
	taskId?: number;
	requestKey: string;
	startedAt: number;
	model: Model<Api>;
	context: { messages: Message[] };
	options: SimpleStreamOptions & { metadata?: Record<string, unknown> };
}

export interface InspectCapture {
	finish(message: AssistantMessage | undefined, error?: string): void;
}

export type BuildDetail = Omit<HarnessBuildDTO, "id" | "conversationId" | "runId" | "createdAt">;
type BuildProvider = (spaceId: string, conversationId: number) => Promise<BuildDetail | undefined>;

/** The stored JSON body of a round. */
interface Payload {
	systemPrompt: string;
	systemSections: { key: string; chars: number }[];
	tools: InspectToolDTO[];
	messages: InspectMessageDTO[];
	options: Record<string, unknown>;
	modelInfo?: HarnessRoundDetailDTO["modelInfo"];
}

const trunc = (s: string, cap: number, state: { truncated: boolean }): string => {
	if (s.length <= cap) return s;
	state.truncated = true;
	return `${s.slice(0, cap)}\n…[已截断：原长 ${s.length} 字符]`;
};

function jsonSafe(v: unknown, cap: number, state: { truncated: boolean }): unknown {
	let text: string;
	try {
		text = JSON.stringify(v) ?? "null";
	} catch {
		return "[无法序列化]";
	}
	if (text.length <= cap) return JSON.parse(redactText(text));
	state.truncated = true;
	return trunc(redactText(text), cap, state);
}

function blocks(content: unknown, cap: number, state: { truncated: boolean }): InspectContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: trunc(redactText(content), cap, state) }];
	if (!Array.isArray(content)) return [];
	const out: InspectContentBlock[] = [];
	for (const b of content as any[]) {
		if (!b || typeof b !== "object") continue;
		if (b.type === "text") out.push({ type: "text", text: trunc(redactText(String(b.text ?? "")), cap, state) });
		else if (b.type === "thinking") out.push({ type: "thinking", text: trunc(redactText(String(b.thinking ?? "")), cap, state), ...(b.redacted ? { redacted: true } : {}) });
		else if (b.type === "toolCall") out.push({ type: "toolCall", id: String(b.id ?? ""), name: String(b.name ?? ""), arguments: jsonSafe(b.arguments, cap, state) });
		else if (b.type === "image") out.push({ type: "image", mimeType: String(b.mimeType ?? "image/*"), bytes: Math.floor((String(b.data ?? "").length * 3) / 4) });
	}
	return out;
}

function convertMessage(m: any, cap: number, state: { truncated: boolean }): InspectMessageDTO {
	const timestamp = typeof m.timestamp === "number" ? { timestamp: m.timestamp } : {};
	if (m.role === "user") return { role: "user", content: blocks(m.content, cap, state), ...timestamp };
	if (m.role === "assistant") return { role: "assistant", content: blocks(m.content, cap, state), model: `${m.provider ?? ""}/${m.model ?? ""}`, stopReason: m.stopReason, ...timestamp };
	if (m.role === "toolResult") return { role: "tool", content: blocks(m.content, cap, state), toolCallId: m.toolCallId, toolName: m.toolName, isError: !!m.isError, ...timestamp };
	return {
		role: "system",
		content: blocks(m.content, cap, state),
		...(m.sections ? { sections: Object.fromEntries(Object.entries(m.sections as Record<string, string | null>).map(([k, v]) => [k, v === null ? null : trunc(redactText(v), cap, state)])) } : {}),
		...(m.toolsAdded?.length ? { toolsAdded: (m.toolsAdded as { name: string }[]).map((t) => t.name) } : {}),
		...(m.toolsRemoved?.length ? { toolsRemoved: (m.toolsRemoved as { name: string }[]).map((t) => t.name) } : {}),
		...timestamp,
	};
}

/** Options that shape the request. Credentials, headers, env, fetch and callbacks are deliberately not listed. */
const OPTION_KEYS = ["reasoning", "temperature", "maxTokens", "toolChoice", "thinkingBudgets", "samplingParams", "cacheRetention", "transport", "timeoutMs", "maxRetries", "deferred"] as const;

function pickOptions(o: SimpleStreamOptions & { metadata?: Record<string, unknown> }): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of OPTION_KEYS) if ((o as Record<string, unknown>)[k] !== undefined) out[k] = (o as Record<string, unknown>)[k];
	const meta = Object.entries(o.metadata ?? {}).filter(([k, v]) => !k.startsWith("wr") && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"));
	if (meta.length) out.metadata = Object.fromEntries(meta.map(([k, v]) => [k, typeof v === "string" ? redactText(v).slice(0, 200) : v]));
	return out;
}

/** Builds the stored body. Text is capped per string; if the whole record is still too big it shrinks further, then drops middle messages. */
export function buildPayload(req: InspectRequest, maxBytes: number): { payload: Payload; truncated: boolean; bytes: number } {
	const all = req.context.messages as Message[];
	const lead = all[0]?.role === "system" ? 1 : 0;
	const rest = all.slice(lead);
	const systemPrompt = getCurrentSystemPrompt(all);
	const sections = getCurrentSystemMessage(all)?.sections ?? {};
	const tools: InspectToolDTO[] = getCurrentTools(all).map((t) => ({ name: t.name, description: t.description, parameters: JSON.parse(JSON.stringify(t.parameters ?? {})) }));
	const m = req.model;
	let truncated = false;
	let payload!: Payload;
	let bytes = 0;
	for (const cap of [100_000, 20_000, 4_000, 800]) {
		const state = { truncated: false };
		payload = {
			systemPrompt: trunc(redactText(systemPrompt), cap * 2, state),
			systemSections: Object.entries(sections).flatMap(([key, v]) => (v == null ? [] : [{ key, chars: v.length }])),
			tools: tools.map((t) => ({ ...t, description: trunc(t.description, cap, state) })),
			messages: rest.map((x) => convertMessage(x, cap, state)),
			options: pickOptions(req.options),
			modelInfo: { api: m.api, contextWindow: m.contextWindow, maxTokens: m.maxTokens, reasoning: m.reasoning },
		};
		truncated = state.truncated;
		bytes = Buffer.byteLength(JSON.stringify(payload));
		if (bytes <= maxBytes) break;
		truncated = true;
	}
	if (bytes > maxBytes && payload.messages.length > 12) {
		const head = payload.messages.slice(0, 4);
		const tail = payload.messages.slice(-8);
		const dropped = payload.messages.length - head.length - tail.length;
		payload.messages = [...head, { role: "system", content: [{ type: "text", text: `（为控制记录大小，省略了中间 ${dropped} 条消息）` }], omitted: dropped }, ...tail];
		truncated = true;
		bytes = Buffer.byteLength(JSON.stringify(payload));
	}
	return { payload, truncated, bytes };
}

interface RoundRow {
	id: string;
	space_id: string;
	conversation_id: number;
	task_id: number | null;
	run_key: string;
	round_index: number;
	started_at: number;
	duration_ms: number | null;
	provider: string;
	model_id: string;
	served_by: string | null;
	thinking_level: string | null;
	stop_reason: string | null;
	error: string | null;
	usage: string | null;
	message_ts: number | null;
	message_count: number;
	tool_count: number;
	system_chars: number;
	size_bytes: number;
	truncated: number;
	payload?: string;
}

const SUMMARY_COLUMNS = "id, space_id, conversation_id, task_id, run_key, round_index, started_at, duration_ms, provider, model_id, served_by, thinking_level, stop_reason, error, usage, message_ts, message_count, tool_count, system_chars, size_bytes, truncated";

function summaryDto(r: RoundRow): HarnessRoundSummaryDTO {
	return {
		id: r.id,
		spaceId: r.space_id,
		conversationId: r.conversation_id,
		...(r.task_id != null ? { taskId: r.task_id } : {}),
		runId: r.run_key,
		roundIndex: r.round_index,
		startedAt: r.started_at,
		...(r.duration_ms != null ? { durationMs: r.duration_ms } : {}),
		model: { provider: r.provider, modelId: r.model_id },
		...(r.served_by ? { servedBy: r.served_by } : {}),
		...(r.thinking_level ? { thinkingLevel: r.thinking_level } : {}),
		...(r.stop_reason ? { stopReason: r.stop_reason } : {}),
		...(r.error ? { error: r.error } : {}),
		...(r.usage ? { usage: JSON.parse(r.usage) as InspectUsageDTO } : {}),
		...(r.message_ts != null ? { messageTimestamp: r.message_ts } : {}),
		messageCount: r.message_count,
		toolCount: r.tool_count,
		systemChars: r.system_chars,
		sizeBytes: r.size_bytes,
		truncated: !!r.truncated,
	};
}

export class HarnessInspect {
	readonly ctx: AppContext;
	readonly limits: InspectLimits;
	/** Set by the runtime: resolves the conversation's harness composition (extensions, tools, prompt sections, environment). */
	buildProvider?: BuildProvider;
	#inserts = 0;

	constructor(ctx: AppContext, limits: InspectLimits = defaultLimits()) {
		this.ctx = ctx;
		this.limits = limits;
	}

	enabled(orgId: string): boolean {
		return this.ctx.db.get<{ value: string }>("SELECT value FROM ops_settings WHERE org_id = ? AND key = ?", orgId, HARNESS_INSPECT_KEY)?.value === "on";
	}

	/** Flipping the switch off also deletes what was captured: nothing stays behind a disabled feature. */
	setEnabled(orgId: string, userId: string, on: boolean): void {
		const db = this.ctx.db;
		if (on) db.run("INSERT INTO ops_settings (org_id, key, value, updated_by, updated_at) VALUES (?, ?, 'on', ?, ?) ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at", orgId, HARNESS_INSPECT_KEY, userId, nowIso());
		else {
			db.run("DELETE FROM ops_settings WHERE org_id = ? AND key = ?", orgId, HARNESS_INSPECT_KEY);
			db.run("DELETE FROM ops_harness_rounds WHERE org_id = ?", orgId);
			db.run("DELETE FROM ops_harness_builds WHERE org_id = ?", orgId);
		}
	}

	/**
	 * Called by the gateway right before a request is routed. Never throws and never waits: the record is written on a later tick.
	 * Returns undefined when the org has the switch off (or the request has no identifiable org / conversation).
	 */
	begin(req: InspectRequest): InspectCapture | undefined {
		try {
			let orgId = req.orgId;
			if (!orgId && req.spaceId && this.ctx.services.has("identity")) orgId = this.ctx.services.get("identity").space(req.spaceId)?.orgId;
			if (!orgId || !req.spaceId || req.conversationId == null || !this.enabled(orgId)) return undefined;
			const id = newId("hr");
			const messages = [...req.context.messages];
			const snapshot = { ...req, orgId, context: { messages } };
			setImmediate(() => this.#insert(id, snapshot as InspectRequest & { orgId: string }));
			return {
				finish: (message, error) => {
					setImmediate(() => this.#finish(id, req.startedAt, message, error));
				},
			};
		} catch (err) {
			logEvent("warn", "harness_inspect.begin_failed", { error: (err as Error).message });
			return undefined;
		}
	}

	#insert(id: string, req: InspectRequest & { orgId: string }): void {
		try {
			const db = this.ctx.db;
			const { payload, truncated, bytes } = buildPayload(req, this.limits.maxRecordBytes);
			// Every round is its own generation task, so a run is recognised by its transcript: a request whose newest message is a
			// user message starts a run (round 1); one that ends in a tool result continues the conversation's previous run.
			const lastRole = [...req.context.messages].reverse().find((m) => m.role !== "system")?.role;
			const prev = db.get<{ run_key: string; round_index: number }>("SELECT run_key, round_index FROM ops_harness_rounds WHERE space_id = ? AND conversation_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1", req.spaceId!, req.conversationId!);
			const continuing = !!prev && !!lastRole && lastRole !== "user";
			const runKey = continuing ? prev.run_key : req.requestKey;
			const roundIndex = continuing ? prev.round_index + 1 : 1;
			db.run(
				"INSERT INTO ops_harness_rounds (id, org_id, space_id, conversation_id, task_id, run_key, round_index, request_key, user_id, started_at, provider, model_id, thinking_level, message_count, tool_count, system_chars, size_bytes, truncated, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				id, req.orgId, req.spaceId!, req.conversationId!, req.taskId ?? null, runKey, roundIndex, req.requestKey, req.userId ?? null, req.startedAt,
				req.model.provider, req.model.id, (req.options.reasoning as string | undefined) ?? null, payload.messages.length, payload.tools.length, payload.systemPrompt.length, bytes, truncated ? 1 : 0, JSON.stringify(payload), nowIso(),
			);
			if (roundIndex === 1 || !db.get("SELECT 1 AS x FROM ops_harness_builds WHERE space_id = ? AND conversation_id = ? AND run_key = ?", req.spaceId!, req.conversationId!, runKey)) void this.#recordBuild(req, runKey);
			this.#prune(req.spaceId!, req.conversationId!);
		} catch (err) {
			logEvent("warn", "harness_inspect.insert_failed", { error: (err as Error).message });
		}
	}

	#finish(id: string, startedAt: number, message: AssistantMessage | undefined, error?: string): void {
		try {
			const u = message?.usage;
			const usage: InspectUsageDTO | undefined = u
				? { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, ...(u.reasoning != null ? { reasoning: u.reasoning } : {}), totalTokens: u.totalTokens, ...(u.cost ? { costTotal: u.cost.total } : {}) }
				: undefined;
			const err = error ?? message?.errorMessage;
			this.ctx.db.run(
				"UPDATE ops_harness_rounds SET stop_reason = ?, error = ?, usage = ?, duration_ms = ?, message_ts = ?, served_by = CASE WHEN ? IS NOT NULL AND ? <> provider || '/' || model_id THEN ? ELSE NULL END WHERE id = ?",
				message?.stopReason ?? (err ? "error" : null), err ? redactText(err).slice(0, 2000) : null, usage ? JSON.stringify(usage) : null, message?.durationMs ?? Date.now() - startedAt, message?.timestamp ?? null,
				message ? `${message.provider}/${message.model}` : null, message ? `${message.provider}/${message.model}` : null, message ? `${message.provider}/${message.model}` : null, id,
			);
		} catch (err) {
			logEvent("warn", "harness_inspect.finish_failed", { error: (err as Error).message });
		}
	}

	async #recordBuild(req: InspectRequest & { orgId: string }, runKey: string): Promise<void> {
		try {
			if (!this.buildProvider) return;
			const detail = await this.buildProvider(req.spaceId!, req.conversationId!);
			if (!detail) return;
			this.ctx.db.run(
				"INSERT OR IGNORE INTO ops_harness_builds (id, org_id, space_id, conversation_id, task_id, run_key, build, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				newId("hb"), req.orgId, req.spaceId!, req.conversationId!, req.taskId ?? null, runKey, JSON.stringify(detail), nowIso(),
			);
		} catch (err) {
			logEvent("debug", "harness_inspect.build_failed", { error: (err as Error).message });
		}
	}

	#prune(spaceId: string, conversationId: number): void {
		const db = this.ctx.db;
		db.run("DELETE FROM ops_harness_rounds WHERE id IN (SELECT id FROM ops_harness_rounds WHERE space_id = ? AND conversation_id = ? ORDER BY started_at DESC, round_index DESC LIMIT -1 OFFSET ?)", spaceId, conversationId, this.limits.maxRoundsPerConversation);
		db.run("DELETE FROM ops_harness_builds WHERE id IN (SELECT id FROM ops_harness_builds WHERE space_id = ? AND conversation_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?)", spaceId, conversationId, Math.max(20, Math.floor(this.limits.maxRoundsPerConversation / 2)));
		if (++this.#inserts % 50 === 0) {
			const cutoff = Date.now() - this.limits.retentionDays * 86_400_000;
			db.run("DELETE FROM ops_harness_rounds WHERE created_at < ?", new Date(cutoff).toISOString());
			db.run("DELETE FROM ops_harness_builds WHERE created_at < ?", new Date(cutoff).toISOString());
		}
	}

	// ------------------------------------------------------------------ reads (callers authorise; org + space + conversation are always in the WHERE)
	list(orgId: string, spaceId: string, conversationId: number, q: { from?: number; to?: number; limit?: number } = {}): HarnessRoundSummaryDTO[] {
		const where = ["org_id = ?", "space_id = ?", "conversation_id = ?"];
		const params: (string | number)[] = [orgId, spaceId, conversationId];
		if (q.from != null) where.push("started_at >= ?"), params.push(q.from);
		if (q.to != null) where.push("started_at <= ?"), params.push(q.to);
		const limit = Math.min(Math.max(Math.floor(q.limit ?? 100), 1), 500);
		const rows = this.ctx.db.all<RoundRow>(`SELECT ${SUMMARY_COLUMNS} FROM ops_harness_rounds WHERE ${where.join(" AND ")} ORDER BY started_at DESC, round_index DESC LIMIT ${limit}`, ...params);
		return rows.reverse().map(summaryDto);
	}

	get(orgId: string, spaceId: string, conversationId: number, roundId: string): HarnessRoundDetailDTO | undefined {
		const r = this.ctx.db.get<RoundRow>(`SELECT ${SUMMARY_COLUMNS}, payload FROM ops_harness_rounds WHERE id = ? AND org_id = ? AND space_id = ? AND conversation_id = ?`, roundId, orgId, spaceId, conversationId);
		if (!r) return undefined;
		return { ...summaryDto(r), ...(JSON.parse(r.payload!) as Payload) };
	}

	builds(orgId: string, spaceId: string, conversationId: number, runIds: readonly string[] | undefined, limit = 20): HarnessBuildDTO[] {
		const rows = this.ctx.db.all<{ id: string; conversation_id: number; run_key: string; build: string; created_at: string }>(
			"SELECT id, conversation_id, run_key, build, created_at FROM ops_harness_builds WHERE org_id = ? AND space_id = ? AND conversation_id = ? ORDER BY created_at DESC LIMIT ?",
			orgId, spaceId, conversationId, limit,
		);
		return rows
			.filter((b) => !runIds || runIds.includes(b.run_key))
			.reverse()
			.map((b) => ({ id: b.id, conversationId: b.conversation_id, runId: b.run_key, createdAt: b.created_at, ...(JSON.parse(b.build) as BuildDetail) }));
	}
}
