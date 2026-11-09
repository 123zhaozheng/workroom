// Tool call records (M04-B): who/what/where, redacted argument summary, duration, status, error.
// Secrets never reach this table: argument values under secret-looking keys and every known secret value are redacted.
import type { AppContext, ToolActor } from "../core/contracts.ts";
import type { Migration } from "../core/db.ts";
import { newId, nowIso } from "../core/http.ts";
import type { ToolCallRecordDTO } from "../../../shared/files.ts";

export const TOOL_CALL_MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "tool call records",
		sql: `
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  connector_id TEXT,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  space_id TEXT,
  conversation_id INTEGER,
  task_id INTEGER,
  call_id TEXT,
  args_summary TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  result_summary TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  started_ms INTEGER NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  UNIQUE (space_id, task_id, call_id, tool)
);
CREATE INDEX tool_calls_conv ON tool_calls(space_id, conversation_id, started_at);
CREATE INDEX tool_calls_user ON tool_calls(user_id, started_at);
`,
	},
];

const SECRET_KEY = /(pass(word)?|secret|token|api[-_]?key|apikey|auth|credential|cookie|session|private[-_]?key|bearer)/i;
const SECRET_SHAPES = [/\b(sk|pk|rk|ghp|gho|ghs|xox[abpr])[-_][A-Za-z0-9_-]{12,}\b/g, /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g];

/** Replace known secret values and secret-shaped strings in free text. */
export function redactText(text: string, secrets: readonly string[] = []): string {
	let out = text;
	for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[REDACTED]");
	for (const re of SECRET_SHAPES) out = out.replace(re, "[REDACTED]");
	return out;
}

/** JSON summary of arguments: secret-looking keys redacted, long strings truncated, depth/size bounded. */
export function summarizeArgs(args: unknown, secrets: readonly string[] = [], maxLen = 2000): string {
	const walk = (v: unknown, depth: number): unknown => {
		if (depth > 5) return "…";
		if (typeof v === "string") return redactText(v.length > 300 ? `${v.slice(0, 300)}…(${v.length} 字符)` : v, secrets);
		if (Array.isArray(v)) return v.length > 20 ? [...v.slice(0, 20).map((x) => walk(x, depth + 1)), `…(${v.length} 项)`] : v.map((x) => walk(x, depth + 1));
		if (v && typeof v === "object") {
			const o: Record<string, unknown> = {};
			for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = SECRET_KEY.test(k) ? "[REDACTED]" : walk(x, depth + 1);
			return o;
		}
		return v;
	};
	const s = JSON.stringify(walk(args, 0)) ?? "null";
	return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

interface Row {
	id: string;
	tool: string;
	connector_id: string | null;
	org_id: string;
	user_id: string;
	space_id: string | null;
	conversation_id: number | null;
	task_id: number | null;
	call_id: string | null;
	args_summary: string;
	status: string;
	error: string | null;
	result_summary: string | null;
	started_at: string;
	started_ms: number;
	finished_at: string | null;
	duration_ms: number | null;
}

export class ToolCallLog {
	readonly #ctx: AppContext;
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}

	/** Record the start of a call. A replay of the same (space, task, call, tool) reuses the record. */
	start(input: { tool: string; connectorId?: string; actor?: ToolActor; userId?: string; orgId?: string; spaceId?: string; args: unknown; secrets?: readonly string[] }): string {
		const a = input.actor;
		const spaceId = a?.space.id ?? input.spaceId ?? null;
		const taskId = a?.taskId ?? null;
		const callId = a?.callId ?? null;
		if (a) {
			const existing = this.#ctx.db.get<{ id: string }>("SELECT id FROM tool_calls WHERE space_id = ? AND task_id = ? AND call_id = ? AND tool = ?", spaceId, taskId, callId, input.tool);
			if (existing) {
				this.#ctx.db.run("UPDATE tool_calls SET attempts = attempts + 1, status = 'running', started_ms = ?, error = NULL WHERE id = ?", Date.now(), existing.id);
				return existing.id;
			}
		}
		const id = newId("tc");
		this.#ctx.db.run(
			`INSERT INTO tool_calls (id, tool, connector_id, org_id, user_id, space_id, conversation_id, task_id, call_id, args_summary, status, started_at, started_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
			id, input.tool, input.connectorId ?? null, a?.principal.orgId ?? input.orgId ?? "", a?.principal.userId ?? input.userId ?? "", spaceId, a?.conversationId ?? null, taskId, callId,
			summarizeArgs(input.args, input.secrets), nowIso(), Date.now(),
		);
		return id;
	}

	finish(id: string, out: { status: "ok" | "error" | "denied" | "needs_reconciliation"; error?: string; result?: string; secrets?: readonly string[] }): void {
		const r = this.#ctx.db.get<{ started_ms: number }>("SELECT started_ms FROM tool_calls WHERE id = ?", id);
		if (!r) return;
		this.#ctx.db.run(
			"UPDATE tool_calls SET status = ?, error = ?, result_summary = ?, finished_at = ?, duration_ms = ? WHERE id = ?",
			out.status, out.error ? redactText(out.error, out.secrets).slice(0, 2000) : null, out.result ? redactText(out.result, out.secrets).slice(0, 1000) : null, nowIso(), Date.now() - r.started_ms, id,
		);
	}

	/** Wrap an execution: start → fn → finish (error message recorded, rethrown). */
	async around<T>(input: Parameters<ToolCallLog["start"]>[0], fn: (id: string) => Promise<T>, summarize?: (r: T) => string): Promise<T> {
		const id = this.start(input);
		try {
			const r = await fn(id);
			this.finish(id, { status: "ok", result: summarize?.(r), secrets: input.secrets });
			return r;
		} catch (e: any) {
			const denied = e?.status === 403 || e?.status === 401 || e?.code === "forbidden";
			this.finish(id, { status: denied ? "denied" : "error", error: String(e?.message ?? e), secrets: input.secrets });
			throw e;
		}
	}

	dto(r: Row): ToolCallRecordDTO {
		return {
			id: r.id,
			tool: r.tool,
			connectorId: r.connector_id ?? undefined,
			userId: r.user_id,
			spaceId: r.space_id ?? undefined,
			conversationId: r.conversation_id ?? undefined,
			taskId: r.task_id ?? undefined,
			callId: r.call_id ?? undefined,
			argsSummary: r.args_summary,
			status: r.status as ToolCallRecordDTO["status"],
			error: r.error ?? undefined,
			durationMs: r.duration_ms ?? undefined,
			resultSummary: r.result_summary ?? undefined,
			startedAt: r.started_at,
			finishedAt: r.finished_at ?? undefined,
		};
	}

	list(filter: { userId?: string; spaceIds?: readonly string[]; spaceId?: string; conversationId?: number; tool?: string; limit?: number }): ToolCallRecordDTO[] {
		const where: string[] = [];
		const params: (string | number)[] = [];
		if (filter.userId) {
			where.push("user_id = ?");
			params.push(filter.userId);
		}
		if (filter.spaceId) {
			where.push("space_id = ?");
			params.push(filter.spaceId);
		}
		if (filter.spaceIds) {
			if (!filter.spaceIds.length) return [];
			where.push(`space_id IN (${filter.spaceIds.map(() => "?").join(",")})`);
			params.push(...filter.spaceIds);
		}
		if (filter.conversationId !== undefined) {
			where.push("conversation_id = ?");
			params.push(filter.conversationId);
		}
		if (filter.tool) {
			where.push("tool = ?");
			params.push(filter.tool);
		}
		params.push(Math.min(filter.limit ?? 100, 500));
		return this.#ctx.db.all<Row>(`SELECT * FROM tool_calls ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_ms DESC LIMIT ?`, ...params).map((r) => this.dto(r));
	}
}
