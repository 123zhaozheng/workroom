// Ops module (group E): model gateway & routing, usage ledger & budgets, automation & notifications, stats/admin APIs.
import { defineExtension, CompactionTask, GenerationTask, hook, ProviderDoc } from "@earendil-works/pi-durable";
import type { Action, AppContext, Decision, Principal, ResourceRef, WorkroomModule } from "../core/contracts.ts";
import type { Identity } from "../identity/module.ts";
import { AutomationService } from "./automation.ts";
import { Gateway } from "./gateway.ts";
import { bootstrapModels } from "./models-bootstrap.ts";
import { NotifyService } from "./notify.ts";
import { registerOpsRoutes } from "./routes.ts";
import { TraceService } from "./trace.ts";
import { OPS_MIGRATIONS } from "./schema.ts";
import { STATS_MIGRATIONS } from "./stats-schema.ts";
import { UsageService, type RuntimeDocs } from "./usage.ts";

export interface OpsState {
	gateway: Gateway;
	usage: UsageService;
	notify: NotifyService;
	automation: AutomationService;
	docs: RuntimeDocs;
	trace: TraceService;
}
const states = new WeakMap<AppContext, OpsState>();
export function opsState(ctx: AppContext): OpsState {
	const s = states.get(ctx);
	if (!s) throw new Error("ops module not initialised");
	return s;
}

const envInt = (name: string, fallback: number): number => {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v >= 0 ? v : fallback;
};

function json<T>(s: string | null | undefined, d: T): T {
	try {
		return s ? (JSON.parse(s) as T) : d;
	} catch {
		return d;
	}
}

export const opsModule: WorkroomModule = {
	name: "ops",
	migrations: [...OPS_MIGRATIONS, ...STATS_MIGRATIONS],
	async init(ctx) {
		const gateway = new Gateway(ctx);
		// pi-ai native providers: env vars -> legacy tables (once) -> workroom.models.json, then register them all in the one Models instance.
		await bootstrapModels(ctx, gateway);
		await gateway.load();
		const usage = new UsageService(ctx);
		const notify = new NotifyService(ctx);
		const automation = new AutomationService(ctx, notify, usage);
		const docs: RuntimeDocs = {};
		try {
			const m = await import("../runtime/docs.ts");
			docs.SpaceDoc = m.SpaceDoc;
			docs.ApprovalsDoc = m.ApprovalsDoc;
		} catch {
			/* runtime not present: linkage falls back to stream metadata / import backfill */
		}
		usage.docs = docs;
		gateway.onRequestFinished = (l) => usage.markDirty(l.spaceId, l.conversationId);
		const trace = new TraceService(ctx);
		states.set(ctx, { gateway, usage, notify, automation, docs, trace });
		ctx.services.provide("models", gateway);
		ctx.services.provide("budget", usage);
		ctx.services.provide("usage", usage);
		ctx.services.provide("automation", automation);
		ctx.services.provide("notify", notify);
		ctx.services.provide("trace", trace);

		const id = ctx.services.get("identity") as Identity;
		// Model ACL: a model (resource id = platform id "<provider>/<modelId>") may be read/used when it is in the principal's list;
		// changing models needs model.manage (RBAC) / org admin.
		id.registerResolver("model", async (p: Principal, action: Action, res: ResourceRef): Promise<Decision> => {
			if (action === "read" || action === "use") return (await gateway.listFor(p)).some((m) => m.id === res.id) ? { allow: true, reason: "visible" } : { allow: false, reason: "not_visible" };
			return (await gateway.can(p, "model.manage")) ? { allow: true, reason: p.orgRole } : { allow: false, reason: "not_admin" };
		});
		// Automation ACL: read = owner or anyone who can read its space; write/delete/admin = owner (still able to write
		// the space) or someone holding automation.run_as_others (RBAC).
		id.registerResolver("automation", async (p: Principal, action: Action, res: ResourceRef): Promise<Decision> => {
			const a = ctx.db.get<any>("SELECT * FROM auto_automations WHERE id = ? AND deleted_at IS NULL", res.id);
			if (!a) return { allow: false, reason: "not_found" };
			if (a.org_id !== p.orgId) return { allow: false, reason: "other_org" };
			const space = id.spaceDecision(p, action === "read" ? "read" : "write", id.space(a.space_id));
			if (action === "read") return a.owner_user_id === p.userId || space.allow ? { allow: true, reason: "read" } : space;
			if (a.owner_user_id === p.userId) return space.allow ? { allow: true, reason: "owner" } : space;
			return (await ctx.services.get("authz").has(p, "automation.run_as_others")) ? { allow: true, reason: "run_as_others" } : { allow: false, reason: "not_owner" };
		});
		// Public read-only share renderer for automations (definition summary only; never the prompt's secrets).
		id.registerShareRenderer("automation", async (r) => {
			const a = ctx.db.get<any>("SELECT name, trigger, timezone, next_run_at FROM auto_automations WHERE id = ? AND deleted_at IS NULL", r.id);
			return a ? { name: a.name, trigger: json(a.trigger, null), timezone: a.timezone, nextRunAt: a.next_run_at } : null;
		});
	},
	routes(api, ctx) {
		registerOpsRoutes(api, ctx, opsState(ctx));
	},
	extensions(ctx) {
		const { gateway, docs } = opsState(ctx);
		/**
		 * Links a model request (by pi.provider sessionId) to its space / conversation / task and to the run's execution identity, so the
		 * gateway can re-check model access per request. Round 13: when the identity cannot be established the link says so
		 * (`unresolved`) and the gateway refuses the request — a missing identity is never treated as permission.
		 */
		const linkRequest = async (api: any, context: any): Promise<void> => {
			let prov: { sessionId?: string } | undefined;
			try {
				prov = await api.snapshot(ProviderDoc, api.conversationId, context);
			} catch {
				prov = undefined;
			}
			if (!prov?.sessionId) return;
			let sd: { spaceId?: string; orgId?: string } | undefined;
			let who: { userId: string; orgId: string } | null = null;
			let failed = false;
			try {
				sd = docs.SpaceDoc ? ((await api.snapshot(docs.SpaceDoc, context)) as { spaceId?: string; orgId?: string } | undefined) : undefined;
				if (sd?.spaceId && ctx.services.has("runtime")) who = await (ctx.services.get("runtime") as unknown as { principalForRequest(a: unknown, c: unknown): Promise<{ userId: string; orgId: string } | null> }).principalForRequest(api, context);
			} catch {
				failed = true;
			}
			// A storage the runtime manages carries its `wr.space` doc: every run there acts for a person, so no identity = refused.
			// A harness without it is not a user conversation (internal / test harness on its own storage): there is no person to check.
			const unresolved = !who && (failed || !!sd?.spaceId);
			gateway.link(prov.sessionId, { spaceId: sd?.spaceId || undefined, orgId: who?.orgId ?? (sd?.orgId || undefined), userId: who?.userId, ...(unresolved ? { unresolved: true } : {}), conversationId: api.conversationId as number, taskId: api.taskId as number });
		};
		// Links each model request (by pi.provider sessionId) to its space / conversation / task for route records.
		return [
			defineExtension({
				name: "wr.ops",
				hooks: [
					hook(GenerationTask, {
						beforeRequest: async (_req, api, context) => {
							await linkRequest(api, context);
							return undefined;
						},
					}),
					// Compaction summaries are model requests of the same conversation: the same identity, the same per-user checks.
					hook(CompactionTask, {
						beforeCompact: async (_c, api, context) => {
							await linkRequest(api, context);
							return undefined;
						},
					}),
				],
			}),
		];
	},
	async start(ctx) {
		const s = opsState(ctx);
		s.usage.start(envInt("WORKROOM_USAGE_IMPORT_MS", 30_000));
		await s.automation.start(envInt("WORKROOM_AUTOMATION_TICK_MS", 15_000));
	},
	async stop(ctx) {
		const s = opsState(ctx);
		await s.automation.stop();
		s.usage.stop();
		await s.notify.idle();
	},
};
