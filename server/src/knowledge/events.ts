// Retrieval events (M18-B): one row per search (HTTP, tool, eval, refusal) with correlation ids, kept in kb_retrieval_events
// and mirrored as a structured log line through E's logEvent. The query text is never logged; in the table it is stored
// redacted per WORKROOM_REDACT (strict: not at all — only a hash and the length).
import { createHash } from "node:crypto";
import type { AppDb } from "../core/db.ts";
import type { Principal } from "../core/contracts.ts";
import { newId, nowIso } from "../core/http.ts";
import { logEvent, redactMode, redactText } from "../ops/log.ts";
import type { RetrievalEventDTO } from "../../../shared/knowledge.ts";
import { normalizeQuery } from "./query.ts";
import type { RetrievalTrace, SearchResult } from "./service.ts";

export function queryHash(orgId: string, query: string): string {
	return createHash("sha256").update(`${orgId}\u0000${normalizeQuery(query)}`).digest("hex").slice(0, 16);
}

export function recordRetrieval(db: AppDb, p: Principal, query: string, r: SearchResult, trace: RetrievalTrace = { source: "api" }): void {
	try {
		const d = r.diagnostics;
		const mode = redactMode();
		const redacted = mode === "strict" ? null : mode === "off" ? query.slice(0, 500) : redactText(query).slice(0, 200);
		const hash = queryHash(p.orgId, query);
		const id = newId("kbe");
		db.run(
			"INSERT INTO kb_retrieval_events (id, org_id, user_id, source, request_id, space_id, conversation_id, task_id, call_id, query_hash, query_redacted, query_len, kb_ids, forbidden_kb_ids, hit_count, reason, strategy, cached, latency_ms, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			id, p.orgId, p.userId, trace.source, trace.requestId ?? null, trace.spaceId ?? null, trace.conversationId ?? null, trace.taskId ?? null, trace.callId ?? null,
			hash, redacted, query.length, JSON.stringify(d.searchedKbIds ?? []), d.forbiddenKbIds?.length ? JSON.stringify(d.forbiddenKbIds) : null,
			r.citations.length, d.reason ?? null, d.strategy ?? null, d.cached ? 1 : 0, d.tookMs ?? 0, nowIso(),
		);
		logEvent(d.reason === "error" ? "warn" : "info", "kb.search", {
			eventId: id, requestId: trace.requestId, spaceId: trace.spaceId, conversationId: trace.conversationId, taskId: trace.taskId, callId: trace.callId,
			orgId: p.orgId, userId: p.userId, source: trace.source, queryHash: hash, queryLen: query.length, kbIds: d.searchedKbIds, forbiddenKbIds: d.forbiddenKbIds,
			hits: r.citations.length, reason: d.reason, strategy: d.strategy, cached: !!d.cached, latencyMs: d.tookMs,
		});
	} catch (e) {
		console.error("[knowledge] could not record retrieval event", e);
	}
}

interface Row {
	id: string; user_id: string; source: string; request_id: string | null; space_id: string | null; conversation_id: number | null; task_id: number | null; call_id: string | null;
	query_hash: string; query_redacted: string | null; query_len: number; kb_ids: string; forbidden_kb_ids: string | null; hit_count: number; reason: string | null; strategy: string | null;
	cached: number; latency_ms: number; at: string;
}

/**
 * Lookup for E's /admin/trace: q = event id | requestId | "<spaceId>:<conversationId>" | callId | query hash.
 * Org-scoped: callers pass the admin's orgId.
 */
export function findRetrievalEvents(db: AppDb, orgId: string, q: string, limit = 200): RetrievalEventDTO[] {
	const [spaceId, conv] = /^[^:]+:\d+$/.test(q) ? q.split(":") : [null, null];
	const rows = db.all<Row>(
		`SELECT * FROM kb_retrieval_events WHERE org_id = ? AND (id = ? OR request_id = ? OR call_id = ? OR query_hash = ? OR (space_id = ? AND conversation_id = ?)) ORDER BY at, id LIMIT ?`,
		orgId, q, q, q, q, spaceId ?? "", conv ? Number(conv) : -1, limit,
	);
	return rows.map((r) => ({
		id: r.id,
		at: r.at,
		userId: r.user_id,
		source: r.source as RetrievalEventDTO["source"],
		...(r.request_id ? { requestId: r.request_id } : {}),
		...(r.space_id ? { spaceId: r.space_id } : {}),
		...(r.conversation_id !== null ? { conversationId: r.conversation_id } : {}),
		...(r.task_id !== null ? { taskId: r.task_id } : {}),
		...(r.call_id ? { callId: r.call_id } : {}),
		queryHash: r.query_hash,
		...(r.query_redacted !== null ? { query: r.query_redacted } : {}),
		queryLength: r.query_len,
		kbIds: JSON.parse(r.kb_ids),
		...(r.forbidden_kb_ids ? { forbiddenKbIds: JSON.parse(r.forbidden_kb_ids) } : {}),
		hitCount: r.hit_count,
		...(r.reason ? { reason: r.reason as RetrievalEventDTO["reason"] } : {}),
		...(r.strategy ? { strategy: r.strategy } : {}),
		cached: !!r.cached,
		latencyMs: r.latency_ms,
	}));
}

/** Retention: delete events older than WORKROOM_KB_EVENT_RETENTION_DAYS (default 30). */
export function pruneRetrievalEvents(db: AppDb): number {
	const days = Number(process.env.WORKROOM_KB_EVENT_RETENTION_DAYS ?? 30);
	if (!Number.isFinite(days) || days <= 0) return 0;
	return db.run("DELETE FROM kb_retrieval_events WHERE at < ?", new Date(Date.now() - days * 86400_000).toISOString()).changes;
}
