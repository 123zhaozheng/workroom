// Cross-module correlation (M18-B). Modules contribute events for a trace query through
// `ctx.services.get("trace").register(source, lookup)`; the admin trace endpoint merges them with E's own records.
// Every contributed item is redacted here (WORKROOM_REDACT) regardless of what the contributor did, and the lookup
// is always called with the caller's orgId so a contributor can (and must) scope to that tenant.
import type { AppContext } from "../core/contracts.ts";
import { logEvent, redactValue } from "./log.ts";

export interface TraceQuery {
	readonly orgId: string;
	/** Raw search term (request id, run id, call id, …). */
	readonly q: string;
	readonly requestId?: string;
	readonly spaceId?: string;
	readonly conversationId?: number;
	readonly taskId?: number;
	readonly callId?: string;
	/** Conversations already linked to the query by other records (e.g. an automation run). */
	readonly conversations: readonly { spaceId: string; conversationId: number }[];
	readonly limit: number;
}

export interface TraceItem {
	readonly source: string; // "tools" | "retrieval" | …
	readonly kind: string; // "tool_call" | "retrieval" | …
	readonly id: string;
	readonly at: string;
	readonly spaceId?: string;
	readonly conversationId?: number;
	readonly taskId?: number;
	readonly callId?: string;
	readonly requestId?: string;
	readonly status?: string;
	readonly summary: string;
	readonly detail?: unknown;
}

export type TraceLookup = (q: TraceQuery) => Promise<readonly TraceItem[]> | readonly TraceItem[];

export class TraceService {
	readonly #ctx: AppContext;
	readonly #sources = new Map<string, TraceLookup>();
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
		this.register("tools", (q) => this.#toolCalls(q));
		this.register("retrieval", (q) => this.#retrieval(q));
	}

	/** C's retrieval events (`knowledgeAdmin.retrievalEvents(orgId, q)`, org-scoped, ≤200 per call). */
	#retrieval(q: TraceQuery): TraceItem[] {
		if (!this.#ctx.services.has("knowledgeAdmin")) return [];
		const k = this.#ctx.services.get("knowledgeAdmin") as { retrievalEvents?: (orgId: string, q: string) => any[] };
		if (typeof k.retrievalEvents !== "function") return [];
		const keys = new Set<string>([q.q]);
		if (q.spaceId && q.conversationId !== undefined) keys.add(`${q.spaceId}:${q.conversationId}`);
		for (const c of q.conversations) keys.add(`${c.spaceId}:${c.conversationId}`);
		const seen = new Map<string, any>();
		for (const key of keys) for (const e of k.retrievalEvents(q.orgId, key)) seen.set(e.id, e);
		return [...seen.values()]
			.filter((e) => q.taskId === undefined || e.taskId === undefined || e.taskId === q.taskId)
			.map((e) => ({
				source: "retrieval",
				kind: "retrieval",
				id: e.id,
				at: e.at,
				spaceId: e.spaceId,
				conversationId: e.conversationId,
				taskId: e.taskId,
				callId: e.callId,
				requestId: e.requestId,
				status: e.reason ?? "ok",
				summary: `kb_search(${e.source}) → ${e.reason ?? "ok"} · ${e.hitCount} hits · ${e.latencyMs} ms${e.cached ? " · cached" : ""}`,
				detail: { userId: e.userId, kbIds: e.kbIds, forbiddenKbIds: e.forbiddenKbIds, hitCount: e.hitCount, strategy: e.strategy, queryHash: e.queryHash, queryLength: e.queryLength, query: e.query },
			}));
	}

	/** Register (or replace) a contributor. */
	register(source: string, lookup: TraceLookup): void {
		this.#sources.set(source, lookup);
	}
	sources(): string[] {
		return [...this.#sources.keys()];
	}

	async collect(q: TraceQuery): Promise<{ items: TraceItem[]; errors: { source: string; error: string }[] }> {
		const items: TraceItem[] = [];
		const errors: { source: string; error: string }[] = [];
		const lookups = new Map(this.#sources);
		// Duck-typed lookups for modules that expose a method instead of registering.
		// A module may instead expose `traceEvents(q)`; it then replaces the built-in reader for its source.
		for (const [svc, method, source] of [["knowledgeAdmin", "traceEvents", "retrieval"], ["toolCalls", "traceEvents", "tools"]] as const) {
			if (!this.#ctx.services.has(svc)) continue;
			const s = this.#ctx.services.get(svc) as Record<string, unknown>;
			if (typeof s?.[method] === "function") lookups.set(source, (qq) => (s[method] as TraceLookup).call(s, qq));
		}
		for (const [source, fn] of lookups) {
			try {
				for (const it of await fn(q)) items.push({ ...(redactValue(it) as TraceItem), source: it.source ?? source });
			} catch (e) {
				errors.push({ source, error: String((e as Error)?.message ?? e) });
				logEvent("warn", "trace.lookup_failed", { source, error: String((e as Error)?.message ?? e) });
			}
		}
		items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
		return { items: items.slice(0, q.limit), errors };
	}

	/** Built-in contributor for D's tool call records (read-only; D redacts at write, we redact again on read). */
	#toolCalls(q: TraceQuery): TraceItem[] {
		const db = this.#ctx.db;
		if (!db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tool_calls'")) return [];
		const ors: string[] = ["call_id = ?", "id = ?"];
		const params: (string | number)[] = [q.q, q.q];
		const convs = [...q.conversations];
		if (q.spaceId && q.conversationId !== undefined) convs.push({ spaceId: q.spaceId, conversationId: q.conversationId });
		for (const c of convs) {
			if (q.taskId !== undefined) (ors.push("(space_id = ? AND conversation_id = ? AND task_id = ?)"), params.push(c.spaceId, c.conversationId, q.taskId));
			else (ors.push("(space_id = ? AND conversation_id = ?)"), params.push(c.spaceId, c.conversationId));
		}
		const rows = db.all<any>(`SELECT * FROM tool_calls WHERE org_id = ? AND (${ors.join(" OR ")}) ORDER BY started_at LIMIT ?`, q.orgId, ...params, q.limit);
		return rows.map((r) => ({
			source: "tools",
			kind: "tool_call",
			id: r.id,
			at: r.started_at,
			spaceId: r.space_id ?? undefined,
			conversationId: r.conversation_id ?? undefined,
			taskId: r.task_id ?? undefined,
			callId: r.call_id ?? undefined,
			status: r.status,
			summary: `${r.tool}${r.connector_id ? ` @${r.connector_id}` : ""} → ${r.status}${r.duration_ms != null ? ` (${r.duration_ms} ms)` : ""}`,
			detail: { tool: r.tool, connectorId: r.connector_id ?? undefined, args: r.args_summary, result: r.result_summary ?? undefined, error: r.error ?? undefined, attempts: r.attempts, durationMs: r.duration_ms ?? undefined, userId: r.user_id },
		}));
	}
}
