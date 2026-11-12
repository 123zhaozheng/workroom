// Runtime module (group A): pi-durable harness owner per space, conversations/branches/submissions, SSE,
// approvals & external effects, subagents/team, assistants.
import { createRegistry, type HarnessSettings } from "@earendil-works/pi-durable";
import type { AppContext, WorkroomModule } from "../core/contracts.ts";
import { AssistantStore } from "./assistants.ts";
import { Effects } from "./effects.ts";
import { createFixtureTools, fixtureToolsEnabled } from "./fixture-tools.ts";
import { HarnessManager } from "./harness-manager.ts";
import { ConversationMeta } from "./meta.ts";
import { mountMetaRoutes } from "./meta-routes.ts";
import { mountRuntimeRoutes } from "./routes.ts";
import { SearchIndex } from "./search.ts";
import { Runtime } from "./service.ts";
import { createApprovalExtension } from "./effects.ts";
import { createTeamExtension } from "./team.ts";

const MIGRATIONS = [
	{
		version: 1,
		name: "runtime catalog, leases, wake state, assistants",
		sql: `
CREATE TABLE rt_conversations (
  space_id TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  title TEXT NOT NULL,
  project_id TEXT,
  kind TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (space_id, conversation_id)
);
CREATE INDEX rt_conversations_updated ON rt_conversations (space_id, archived, updated_at);
CREATE TABLE rt_space_leases (
  space_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE rt_space_runtime (
  space_id TEXT PRIMARY KEY,
  wake_active INTEGER NOT NULL DEFAULT 0,
  wake_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE rt_assistants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar TEXT,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT,
  model TEXT,
  tools TEXT,
  knowledge TEXT,
  members TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX rt_assistants_org ON rt_assistants (org_id, scope);
`,
	},
	{
		version: 2,
		name: "promote intents: 'send now' withdraw+resubmit survives a crash between the two steps",
		sql: `
CREATE TABLE rt_promote_intents (
  space_id TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  submission_id INTEGER NOT NULL,
  now_request_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (space_id, conversation_id, submission_id)
);
`,
	},
	{
		version: 3,
		name: "round 9: conversation soft delete, per-user stars, tags, full-text search index",
		sql: `
ALTER TABLE rt_conversations ADD COLUMN deleted_at TEXT;
ALTER TABLE rt_conversations ADD COLUMN deleted_by TEXT;
CREATE INDEX IF NOT EXISTS rt_conversations_deleted ON rt_conversations (deleted_at);
CREATE INDEX IF NOT EXISTS rt_conversations_project ON rt_conversations (project_id);
CREATE TABLE rt_conversation_stars (
  user_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, space_id, conversation_id)
);
CREATE TABLE rt_conversation_tags (
  space_id TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  pos INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (space_id, conversation_id, tag)
);
CREATE TABLE rt_search_docs (
  id INTEGER PRIMARY KEY,
  space_id TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  entry_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  UNIQUE (space_id, conversation_id, entry_id)
);
CREATE VIRTUAL TABLE rt_search_fts USING fts5(text, content = 'rt_search_docs', content_rowid = 'id', tokenize = 'trigram');
CREATE TRIGGER rt_search_docs_ai AFTER INSERT ON rt_search_docs BEGIN
  INSERT INTO rt_search_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER rt_search_docs_ad AFTER DELETE ON rt_search_docs BEGIN
  INSERT INTO rt_search_fts (rt_search_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TABLE rt_search_progress (
  space_id TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  last_entry_id INTEGER NOT NULL,
  indexed_at TEXT NOT NULL,
  PRIMARY KEY (space_id, conversation_id)
);
`,
	},
];

const envNum = (name: string, fallback: number): number => {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v >= 0 ? v : fallback;
};

function settings(): HarnessSettings {
	return {
		retry: { maxRetries: envNum("WORKROOM_RT_RETRY_MAX", 3), baseDelayMs: envNum("WORKROOM_RT_RETRY_BASE_MS", 2000) },
		toolExecution: "parallel",
	};
}

interface State {
	rt: Runtime;
	effects: Effects;
	assistants: AssistantStore;
	manager: HarnessManager;
	meta: ConversationMeta;
	search: SearchIndex;
}
const states = new WeakMap<AppContext, State>();

export function runtimeState(ctx: AppContext): State {
	const s = states.get(ctx);
	if (!s) throw new Error("runtime module not initialised");
	return s;
}

export const runtimeModule: WorkroomModule = {
	name: "runtime",
	migrations: MIGRATIONS,
	init(ctx) {
		const registry = createRegistry();
		const ttl = envNum("WORKROOM_LEASE_TTL_MS", 30_000);
		const manager = new HarnessManager(ctx, registry, { leaseTtlMs: ttl, heartbeatMs: Math.max(200, Math.floor(ttl / 3)), settings, idleMs: envNum("WORKROOM_RT_IDLE_MS", 10 * 60_000), idleSweepMs: envNum("WORKROOM_RT_IDLE_SWEEP_MS", 60_000), resumeSweepMs: envNum("WORKROOM_RT_RESUME_SWEEP_MS", 30_000), resumeRetryBaseMs: envNum("WORKROOM_RT_RESUME_RETRY_BASE_MS", 1000), resumeRetryMax: envNum("WORKROOM_RT_RESUME_RETRY_MAX", 6) });
		const rt = new Runtime(ctx, manager);
		const effects = new Effects(rt);
		const assistants = new AssistantStore(ctx);
		rt.assistants = assistants;
		assistants.checkModel = (p, ref) => rt.checkModel(p, ref);
		const meta = new ConversationMeta(rt);
		const search = new SearchIndex(rt, meta, { budgetMs: envNum("WORKROOM_SEARCH_BUDGET_MS", 600), budgetEntries: envNum("WORKROOM_SEARCH_BUDGET_ENTRIES", 4000), recheckMs: envNum("WORKROOM_SEARCH_RECHECK_MS", 1500), backgroundMs: envNum("WORKROOM_SEARCH_INDEX_MS", 30_000) });
		states.set(ctx, { rt, effects, assistants, manager, meta, search });
		ctx.services.provide("runtime", rt);
		ctx.services.provide("effects", effects);
	},
	routes(api, ctx) {
		const { rt, effects, assistants, meta, search } = runtimeState(ctx);
		mountMetaRoutes(api, meta, search);
		mountRuntimeRoutes(api, rt, effects, assistants, {
			throttleMs: envNum("WORKROOM_SSE_THROTTLE_MS", 100),
			pingMs: envNum("WORKROOM_SSE_PING_MS", 15_000),
			aclRecheckMs: envNum("WORKROOM_SSE_ACL_RECHECK_MS", 5_000),
		});
	},
	extensions(ctx) {
		const { rt, effects } = runtimeState(ctx);
		const exts = [createTeamExtension(rt, effects), createApprovalExtension(rt, effects)];
		if (fixtureToolsEnabled()) exts.push(createFixtureTools(rt, effects));
		return exts;
	},
	async start(ctx) {
		const { manager, search } = runtimeState(ctx);
		search.start();
		// Install every module's extensions (ours included) before any harness opens, so pending tasks resume with
		// their definitions present. modules.ts loads runtime last; this runs after every init().
		for (const ext of ctx.modules.flatMap((m) => m.extensions?.(ctx) ?? [])) manager.installExtension(ext);
		const r = await manager.resumePending();
		// A "send now" interrupted between withdrawing the queued input and submitting it as steer: finish it (idempotent by requestId).
		await (ctx.services.get("runtime") as Runtime).reconcilePromoteIntents().catch((e) => console.error("[runtime] promote reconcile failed", e));
		if (r.resumed.length || r.skipped.length) console.log(`[runtime] resumed ${r.resumed.length} space(s) with pending work; armed ${r.armed.length}; skipped ${r.skipped.length}`, r.skipped.length ? r.skipped : "");
	},
	async stop(ctx) {
		runtimeState(ctx).search.stop();
		await runtimeState(ctx).manager.stop();
	},
};
