// Round 11 (R6 foundation): one row per remote-sandbox lifecycle event, written by RemoteDriver at the moment it happens.
// Aggregation (per-conversation counts, cold-start P50/P95, idle pauses, cost) is built on top of this table later; here only the facts are recorded.
//
//   create / create_failed   a sandbox was (not) created         duration_ms = cold start (create() + readiness); running_ms = NULL
//   resume / resume_failed   a paused/archived one was (not) resumed   duration_ms = resume time
//   pause                    paused by Workroom                   running_ms = time since the last create/resume (what was billed running)
//   archive                  moved to cold storage (provider)
//   destroy                  destroyed                            running_ms = time since the last create/resume (0 when it was paused)
// trigger: exec = a sandbox tool call needed it | prewarm = intent-based background start | explicit = the user pressed prepare |
//          idle = idle pause | retention = fast-resume window over | expiry = destroyAfter / stuck / legacy lifetime | admin = destroyed by an admin
// Never stores secrets, commands, file names or message text; `detail` is a short machine-readable note (<= 200 chars).
import type { AppDb } from "../../core/db.ts";
import type { Migration } from "../../core/db.ts";
import { nowIso } from "../../core/http.ts";

export type SandboxEventKind = "create" | "create_failed" | "resume" | "resume_failed" | "pause" | "archive" | "destroy";
export type SandboxEventTrigger = "exec" | "prewarm" | "explicit" | "idle" | "retention" | "expiry" | "admin";

export const SANDBOX_EVENT_KINDS: readonly SandboxEventKind[] = ["create", "create_failed", "resume", "resume_failed", "pause", "archive", "destroy"];
export const SANDBOX_EVENT_TRIGGERS: readonly SandboxEventTrigger[] = ["exec", "prewarm", "explicit", "idle", "retention", "expiry", "admin"];

export const SANDBOX_EVENTS_MIGRATION: Migration = {
	// Version numbers of the sandbox module are monotonic but not necessarily dense (10+ = round 11).
	version: 12,
	name: "sandbox lifecycle events",
	sql: `
CREATE TABLE tool_sandbox_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  conversation_id INTEGER,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('create','create_failed','resume','resume_failed','pause','archive','destroy')),
  "trigger" TEXT NOT NULL CHECK ("trigger" IN ('exec','prewarm','explicit','idle','retention','expiry','admin')),
  duration_ms INTEGER,
  running_ms INTEGER,
  at TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX tool_sandbox_events_conv ON tool_sandbox_events(org_id, space_id, conversation_id, at);
CREATE INDEX tool_sandbox_events_org ON tool_sandbox_events(org_id, kind, at);
`,
};

export interface SandboxEventInput {
	readonly orgId: string;
	readonly spaceId: string;
	/** "c<conversationId>" or "shared"; the conversation id is derived from it. */
	readonly workspaceKey: string;
	readonly provider: string;
	readonly kind: SandboxEventKind;
	readonly trigger: SandboxEventTrigger;
	readonly durationMs?: number | null;
	readonly runningMs?: number | null;
	/** ISO timestamp; default now. */
	readonly at?: string;
	readonly detail?: string;
}

export interface SandboxEventRow {
	readonly id: number;
	readonly org_id: string;
	readonly space_id: string;
	readonly workspace_key: string;
	readonly conversation_id: number | null;
	readonly provider: string;
	readonly kind: SandboxEventKind;
	readonly trigger: SandboxEventTrigger;
	readonly duration_ms: number | null;
	readonly running_ms: number | null;
	readonly at: string;
	readonly detail: string | null;
}

/** "c42" → 42; anything else (shared, internal throwaway workspaces) → null. */
export function conversationIdOf(workspaceKey: string): number | null {
	const m = /^c(\d+)$/.exec(workspaceKey);
	return m ? Number(m[1]) : null;
}

const whole = (n: number | null | undefined): number | null => (n === undefined || n === null || !Number.isFinite(n) ? null : Math.max(0, Math.round(n)));

/** Record one lifecycle event. Never throws: a bookkeeping failure must not break (or hide) the lifecycle action it describes. */
export function recordSandboxEvent(db: AppDb, e: SandboxEventInput): void {
	try {
		db.run(
			"INSERT INTO tool_sandbox_events (org_id, space_id, workspace_key, conversation_id, provider, kind, \"trigger\", duration_ms, running_ms, at, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			e.orgId, e.spaceId, e.workspaceKey, conversationIdOf(e.workspaceKey), e.provider, e.kind, e.trigger, whole(e.durationMs), whole(e.runningMs), e.at ?? nowIso(), e.detail ? e.detail.slice(0, 200) : null,
		);
	} catch (err) {
		console.error("[sandbox] could not record lifecycle event:", String((err as Error)?.message ?? err).slice(0, 200));
	}
}

/** Events of one conversation, oldest first (tests; the R6 aggregation will use its own queries). */
export function sandboxEventsOf(db: AppDb, orgId: string, spaceId: string, conversationId: number): SandboxEventRow[] {
	return db.all<SandboxEventRow>("SELECT * FROM tool_sandbox_events WHERE org_id = ? AND space_id = ? AND conversation_id = ? ORDER BY id", orgId, spaceId, conversationId);
}
