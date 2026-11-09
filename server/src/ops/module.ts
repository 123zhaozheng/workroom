// Ops module (group E): model gateway & routing, usage ledger & budgets, automation & notifications, stats/admin APIs.
import { defineExtension, GenerationTask, hook, ProviderDoc } from "@earendil-works/pi-durable";
import type { Action, AppContext, Decision, Principal, ResourceRef, WorkroomModule } from "../core/contracts.ts";
import { nowIso } from "../core/http.ts";
import type { Identity } from "../identity/module.ts";
import { AutomationService } from "./automation.ts";
import { FIXTURE_MODEL_ID, FIXTURE_PI_PROVIDER, Gateway } from "./gateway.ts";
import { NotifyService } from "./notify.ts";
import { registerOpsRoutes } from "./routes.ts";
import { OPS_MIGRATIONS } from "./schema.ts";
import { UsageService, type RuntimeDocs } from "./usage.ts";

export interface OpsState {
	gateway: Gateway;
	usage: UsageService;
	notify: NotifyService;
	automation: AutomationService;
	docs: RuntimeDocs;
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

/** Built-in (instance-level, org_id NULL) channels/models. Real providers read WORKROOM_* env credentials only. */
function seed(ctx: AppContext): void {
	const db = ctx.db;
	const now = nowIso();
	const channel = (id: string, name: string, provider: string, env: string | null, baseUrl: string | null) => {
		db.run("INSERT INTO ops_channels (id, org_id, name, provider, base_url, api_key_env, builtin, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(id) DO UPDATE SET base_url = excluded.base_url, api_key_env = excluded.api_key_env, name = excluded.name", id, name, provider, baseUrl, env, now, now);
	};
	const model = (id: string, piProvider: string, kind: string, label: string, caps: string[], thinking: string[], ctxWin: number, maxTok: number, sort: number, enabled: boolean, description: string) => {
		db.run(
			"INSERT INTO ops_platform_models (id, org_id, label, description, kind, pi_provider, capabilities, thinking_levels, context_window, max_tokens, sort, builtin, enabled, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, description = excluded.description",
			id,
			label,
			description,
			kind,
			piProvider,
			JSON.stringify(caps),
			JSON.stringify(thinking),
			ctxWin,
			maxTok,
			sort,
			enabled ? 1 : 0,
			now,
			now,
		);
	};
	const route = (id: string, pm: string, ch: string, upstream: string) => db.run("INSERT INTO ops_model_routes (id, platform_model_id, channel_id, upstream_model_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET upstream_model_id = excluded.upstream_model_id", id, pm, ch, upstream, now);

	channel("ch_fixture", "Fixture（确定性测试模型）", "fixture", null, null);
	model(FIXTURE_MODEL_ID, FIXTURE_PI_PROVIDER, "fixture", "测试模型", ["text", "image", "tools"], ["off"], 200_000, 16_384, 1000, ctx.config.fixtureModel, "确定性脚本回复，用于测试与演示；不是真实 AI，费用记 0。");
	route("rt_fixture", FIXTURE_MODEL_ID, "ch_fixture", FIXTURE_MODEL_ID);

	channel("ch_env_anthropic", "Anthropic（环境变量）", "anthropic", "WORKROOM_ANTHROPIC_API_KEY", process.env.WORKROOM_ANTHROPIC_BASE_URL ?? null);
	model("claude", "workroom", "real", "Claude", ["text", "image", "tools", "reasoning"], ["off", "low", "medium", "high"], 200_000, 32_000, 10, true, "Anthropic Claude（服务器端凭据）");
	route("rt_env_anthropic", "claude", "ch_env_anthropic", process.env.WORKROOM_ANTHROPIC_MODEL ?? "claude-sonnet-5-5");

	channel("ch_env_openai", "OpenAI（环境变量）", "openai", "WORKROOM_OPENAI_API_KEY", process.env.WORKROOM_OPENAI_BASE_URL ?? null);
	model("gpt", "workroom", "real", "GPT", ["text", "image", "tools", "reasoning"], ["off", "low", "medium", "high"], 200_000, 32_000, 20, true, "OpenAI GPT（服务器端凭据）");
	route("rt_env_openai", "gpt", "ch_env_openai", process.env.WORKROOM_OPENAI_MODEL ?? "gpt-6-sol");

	if (process.env.WORKROOM_OPENAI_COMPAT_BASE_URL) {
		channel("ch_env_compat", "OpenAI 兼容端点（环境变量）", "openai-compatible", "WORKROOM_OPENAI_COMPAT_API_KEY", process.env.WORKROOM_OPENAI_COMPAT_BASE_URL);
		model("compat", "workroom", "real", process.env.WORKROOM_OPENAI_COMPAT_LABEL ?? "兼容模型", ["text", "tools"], ["off"], 128_000, 8192, 30, true, "OpenAI 兼容端点（服务器端凭据）");
		route("rt_env_compat", "compat", "ch_env_compat", process.env.WORKROOM_OPENAI_COMPAT_MODEL ?? "default");
	}
}

function json<T>(s: string | null | undefined, d: T): T {
	try {
		return s ? (JSON.parse(s) as T) : d;
	} catch {
		return d;
	}
}

export const opsModule: WorkroomModule = {
	name: "ops",
	migrations: OPS_MIGRATIONS,
	async init(ctx) {
		const gateway = new Gateway(ctx);
		await gateway.loadUpstreams();
		seed(ctx);
		gateway.invalidate();
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
		states.set(ctx, { gateway, usage, notify, automation, docs });
		ctx.services.provide("models", gateway);
		ctx.services.provide("budget", usage);
		ctx.services.provide("usage", usage);
		ctx.services.provide("automation", automation);
		ctx.services.provide("notify", notify);

		const id = ctx.services.get("identity") as Identity;
		// Model ACL: visible platform models may be used/read; org admins administer their org's models.
		id.registerResolver("model", async (p: Principal, action: Action, res: ResourceRef): Promise<Decision> => {
			const pm = ctx.db.get<any>("SELECT * FROM ops_platform_models WHERE id = ?", res.id);
			if (!pm) return { allow: false, reason: "not_found" };
			if (pm.org_id && pm.org_id !== p.orgId) return { allow: false, reason: "other_org" };
			if (action === "read" || action === "use") return gateway.visibleTo(pm, p) ? { allow: true, reason: "visible" } : { allow: false, reason: "not_visible" };
			if (pm.builtin) return { allow: false, reason: "builtin" };
			return p.orgRole === "member" ? { allow: false, reason: "not_admin" } : { allow: true, reason: p.orgRole };
		});
		// Automation ACL: read = owner or anyone who can read its space; write/delete/admin = owner (still able to write
		// the space) or an org admin of the same org.
		id.registerResolver("automation", async (p: Principal, action: Action, res: ResourceRef): Promise<Decision> => {
			const a = ctx.db.get<any>("SELECT * FROM auto_automations WHERE id = ? AND deleted_at IS NULL", res.id);
			if (!a) return { allow: false, reason: "not_found" };
			if (a.org_id !== p.orgId) return { allow: false, reason: "other_org" };
			const space = id.spaceDecision(p, action === "read" ? "read" : "write", id.space(a.space_id));
			if (action === "read") return a.owner_user_id === p.userId || space.allow ? { allow: true, reason: "read" } : space;
			if (a.owner_user_id === p.userId) return space.allow ? { allow: true, reason: "owner" } : space;
			return p.orgRole !== "member" ? { allow: true, reason: p.orgRole } : { allow: false, reason: "not_owner" };
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
		// Links each model request (by pi.provider sessionId) to its space / conversation / task for route records.
		return [
			defineExtension({
				name: "wr.ops",
				hooks: [
					hook(GenerationTask, {
						beforeRequest: async (_req, api, context) => {
							try {
								const prov = await api.snapshot(ProviderDoc, api.conversationId, context);
								const sd = docs.SpaceDoc ? ((await api.snapshot(docs.SpaceDoc, context)) as { spaceId?: string; orgId?: string } | undefined) : undefined;
								if (prov?.sessionId) gateway.link(prov.sessionId, { spaceId: sd?.spaceId || undefined, orgId: sd?.orgId || undefined, conversationId: api.conversationId as unknown as number, taskId: api.taskId as unknown as number });
							} catch {
								/* linkage is best-effort; import backfills by session id */
							}
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
