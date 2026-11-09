// Runtime module (group A): pi-durable harness owner per space, conversations/branches/submissions, SSE,
// approvals & external effects, subagents/team, assistants.
import { createRegistry, type HarnessSettings } from "@earendil-works/pi-durable";
import type { AppContext, WorkroomModule } from "../core/contracts.ts";
import { AssistantStore } from "./assistants.ts";
import { Effects } from "./effects.ts";
import { createFixtureTools, fixtureToolsEnabled } from "./fixture-tools.ts";
import { HarnessManager } from "./harness-manager.ts";
import { mountRuntimeRoutes } from "./routes.ts";
import { Runtime } from "./service.ts";
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
		const manager = new HarnessManager(ctx, registry, { leaseTtlMs: ttl, heartbeatMs: Math.max(200, Math.floor(ttl / 3)), settings });
		const rt = new Runtime(ctx, manager);
		const effects = new Effects(rt);
		const assistants = new AssistantStore(ctx);
		rt.assistants = assistants;
		states.set(ctx, { rt, effects, assistants, manager });
		ctx.services.provide("runtime", rt);
		ctx.services.provide("effects", effects);
	},
	routes(api, ctx) {
		const { rt, effects, assistants } = runtimeState(ctx);
		mountRuntimeRoutes(api, rt, effects, assistants, {
			throttleMs: envNum("WORKROOM_SSE_THROTTLE_MS", 100),
			pingMs: envNum("WORKROOM_SSE_PING_MS", 15_000),
			aclRecheckMs: envNum("WORKROOM_SSE_ACL_RECHECK_MS", 5_000),
		});
	},
	extensions(ctx) {
		const { rt, effects } = runtimeState(ctx);
		const exts = [createTeamExtension(rt, effects)];
		if (fixtureToolsEnabled()) exts.push(createFixtureTools(rt, effects));
		return exts;
	},
	async start(ctx) {
		const { manager } = runtimeState(ctx);
		// Install every module's extensions (ours included) before any harness opens, so pending tasks resume with
		// their definitions present. modules.ts loads runtime last; this runs after every init().
		for (const ext of ctx.modules.flatMap((m) => m.extensions?.(ctx) ?? [])) manager.installExtension(ext);
		const r = await manager.resumePending();
		if (r.resumed.length || r.skipped.length) console.log(`[runtime] resumed ${r.resumed.length} space(s) with pending work; armed ${r.armed.length}; skipped ${r.skipped.length}`, r.skipped.length ? r.skipped : "");
	},
	async stop(ctx) {
		await runtimeState(ctx).manager.stop();
	},
};
