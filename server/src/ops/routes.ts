// HTTP routes for ops: /models, /admin/{models,channels,routes,route-attempts,budgets,usage,settings,trace},
// /usage, /stats, /budgets, /automations, /notifications, /notify-channels, /hooks/automations/:token.
import type { Context as HonoContext, Hono } from "hono";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AppContext, AppEnv, Principal } from "../core/contracts.ts";
import { HttpError, jsonBody, newId, nowIso, principalOf } from "../core/http.ts";
import { audit, type Identity } from "../identity/module.ts";
import { toCsv } from "../identity/csv.ts";
import { requireOrgAdmin } from "../identity/routes.ts";
import { localTime, nextRuns, runWhen, validTimezone, type Condition, type Destination, type Trigger } from "./automation.ts";
import type { ChannelKind, ChannelRow, PlatformModelRow, RouteRow } from "./gateway.ts";
import type { OpsState } from "./module.ts";
import { channelDto, deliveryDto, notificationDto, validateWebhookUrl } from "./notify.ts";
import { ledgerDto, newBudgetId, type StatsScope } from "./usage.ts";

const CAPS = ["text", "image", "tools", "reasoning"];
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const KINDS: ChannelKind[] = ["anthropic", "openai", "openai-compatible", "faux"];

function parseScope(q: string | undefined): StatsScope {
	if (!q || q === "personal") return { kind: "personal" };
	if (q === "org") return { kind: "org" };
	if (q.startsWith("project:")) return { kind: "project", projectId: q.slice(8) };
	if (q.startsWith("department:")) return { kind: "department", departmentId: q.slice(11) };
	throw new HttpError(400, "invalid_scope", "scope 取值：personal | org | project:<id> | department:<id>");
}

function attemptDto(r: any) {
	return {
		id: r.id,
		requestKey: r.request_key,
		attemptNo: r.attempt_no,
		platformModelId: r.platform_model_id,
		channelId: r.channel_id ?? undefined,
		channelName: r.channel_name ?? undefined,
		provider: r.channel_provider ?? undefined,
		upstreamModelId: r.upstream_model ?? undefined,
		status: r.status,
		errorClass: r.error_class ?? undefined,
		errorMessage: r.error_message ?? undefined,
		retryable: r.retryable == null ? undefined : !!r.retryable,
		failover: !!r.failover,
		latencyMs: r.latency_ms ?? undefined,
		firstTokenMs: r.first_token_ms ?? undefined,
		usage: r.input_tokens == null ? undefined : { input: r.input_tokens, output: r.output_tokens, cacheRead: r.cache_read, cacheWrite: r.cache_write, costTotal: r.cost_total ?? 0 },
		costSource: r.cost_source ?? undefined,
		fixture: !!r.fixture,
		spaceId: r.space_id ?? undefined,
		conversationId: r.conversation_id ?? undefined,
		taskId: r.task_id ?? undefined,
		startedAt: r.started_at,
		endedAt: r.ended_at ?? undefined,
	};
}

export function registerOpsRoutes(api: Hono<AppEnv>, ctx: AppContext, s: OpsState): void {
	const db = ctx.db;
	const { gateway, usage, notify, automation } = s;
	const id = () => ctx.services.get("identity") as Identity;
	const rid = (c: HonoContext<AppEnv>) => c.get("requestId");
	const admin = async (c: HonoContext<AppEnv>) => {
		const p = principalOf(c);
		await requireOrgAdmin(id(), p);
		return p;
	};

	// ================================================================ models (user-facing)
	api.get("/models", async (c) => {
		const p = principalOf(c);
		const models = await gateway.listFor(p);
		let def: string | undefined;
		try {
			const ref = await gateway.defaultModel(p);
			def = models.find((m) => m.ref.provider === ref.provider && m.ref.modelId === ref.modelId)?.id;
		} catch {
			/* none */
		}
		return c.json({ models, defaultModelId: def });
	});

	// ================================================================ admin: platform models
	const pmRow = (p: Principal, pmId: string, forWrite: boolean): PlatformModelRow => {
		const r = db.get<PlatformModelRow>("SELECT * FROM ops_platform_models WHERE id = ?", pmId);
		if (!r || (r.org_id && r.org_id !== p.orgId)) throw new HttpError(404, "not_found", "模型不存在");
		if (forWrite && (r.builtin || !r.org_id)) throw new HttpError(403, "builtin", "内置模型由部署配置（环境变量）管理");
		return r;
	};
	const adminModelDto = (r: PlatformModelRow) => ({
		...gateway.toPlatformModel(r),
		orgId: r.org_id ?? undefined,
		enabled: !!r.enabled,
		visibility: r.visibility ? JSON.parse(r.visibility) : null,
		kind: r.kind,
		builtin: !!r.builtin,
		routes: db.all<RouteRow>("SELECT * FROM ops_model_routes WHERE platform_model_id = ? ORDER BY priority, id", r.id).map((x) => gateway.routeDto(x)),
	});
	api.get("/admin/models", async (c) => {
		const p = await admin(c);
		return c.json({ models: db.all<PlatformModelRow>("SELECT * FROM ops_platform_models WHERE org_id IS NULL OR org_id = ? ORDER BY sort, label", p.orgId).map(adminModelDto) });
	});
	const validateModelBody = (b: any) => {
		if (b.capabilities && (!Array.isArray(b.capabilities) || b.capabilities.some((x: string) => !CAPS.includes(x)))) throw new HttpError(400, "invalid_capabilities", "能力取值无效");
		if (b.thinkingLevels && (!Array.isArray(b.thinkingLevels) || b.thinkingLevels.some((x: string) => !LEVELS.includes(x)))) throw new HttpError(400, "invalid_thinking", "思考档位取值无效");
		if (b.defaultThinking && !LEVELS.includes(b.defaultThinking)) throw new HttpError(400, "invalid_thinking", "默认思考档位无效");
	};
	api.post("/admin/models", async (c) => {
		const p = await admin(c);
		const b = await jsonBody<any>(c);
		if (!b.label?.trim()) throw new HttpError(400, "invalid", "名称必填");
		validateModelBody(b);
		const pmId = b.id && /^[a-z0-9][a-z0-9._-]{1,62}$/.test(b.id) ? `${p.orgId.slice(-6)}-${b.id}` : newId("pm");
		if (db.get("SELECT 1 FROM ops_platform_models WHERE id = ?", pmId)) throw new HttpError(409, "exists", "模型 ID 已存在");
		db.run(
			"INSERT INTO ops_platform_models (id, org_id, label, description, kind, pi_provider, capabilities, thinking_levels, default_thinking, context_window, max_tokens, visibility, is_default, enabled, sort, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'real', 'workroom', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
			pmId,
			p.orgId,
			b.label.trim(),
			b.description ?? null,
			JSON.stringify(b.capabilities ?? ["text", "tools"]),
			JSON.stringify(b.thinkingLevels ?? ["off"]),
			b.defaultThinking ?? null,
			b.contextWindow ?? null,
			b.maxTokens ?? null,
			b.visibility ? JSON.stringify(b.visibility) : null,
			b.isDefault ? 1 : 0,
			b.sort ?? 0,
			p.userId,
			nowIso(),
			nowIso(),
		);
		if (b.isDefault) db.run("UPDATE ops_platform_models SET is_default = 0 WHERE org_id = ? AND id != ?", p.orgId, pmId);
		gateway.invalidate();
		audit(db, p.orgId, p.userId, "model.create", pmId, { label: b.label, capabilities: b.capabilities }, { requestId: rid(c) });
		return c.json({ model: adminModelDto(pmRow(p, pmId, false)) });
	});
	api.patch("/admin/models/:id", async (c) => {
		const p = await admin(c);
		const r = pmRow(p, c.req.param("id"), true);
		const b = await jsonBody<any>(c);
		validateModelBody(b);
		db.run(
			"UPDATE ops_platform_models SET label = COALESCE(?, label), description = COALESCE(?, description), capabilities = COALESCE(?, capabilities), thinking_levels = COALESCE(?, thinking_levels), default_thinking = COALESCE(?, default_thinking), context_window = COALESCE(?, context_window), max_tokens = COALESCE(?, max_tokens), visibility = CASE WHEN ? THEN ? ELSE visibility END, enabled = COALESCE(?, enabled), is_default = COALESCE(?, is_default), updated_at = ? WHERE id = ?",
			b.label ?? null,
			b.description ?? null,
			b.capabilities ? JSON.stringify(b.capabilities) : null,
			b.thinkingLevels ? JSON.stringify(b.thinkingLevels) : null,
			b.defaultThinking ?? null,
			b.contextWindow ?? null,
			b.maxTokens ?? null,
			b.visibility !== undefined ? 1 : 0,
			b.visibility ? JSON.stringify(b.visibility) : null,
			b.enabled === undefined ? null : b.enabled ? 1 : 0,
			b.isDefault === undefined ? null : b.isDefault ? 1 : 0,
			nowIso(),
			r.id,
		);
		if (b.isDefault) db.run("UPDATE ops_platform_models SET is_default = 0 WHERE org_id = ? AND id != ?", p.orgId, r.id);
		gateway.invalidate();
		audit(db, p.orgId, p.userId, "model.update", r.id, b, { requestId: rid(c) });
		return c.json({ model: adminModelDto(pmRow(p, r.id, false)) });
	});

	// ================================================================ admin: channels
	const chRow = (p: Principal, chId: string, forWrite: boolean): ChannelRow => {
		const r = db.get<ChannelRow>("SELECT * FROM ops_channels WHERE id = ?", chId);
		if (!r || (r.org_id && r.org_id !== p.orgId)) throw new HttpError(404, "not_found", "渠道不存在");
		if (forWrite && (r.builtin || !r.org_id)) throw new HttpError(403, "builtin", "内置渠道由部署配置（环境变量）管理");
		return r;
	};
	const checkEnvName = (n: string | undefined) => {
		// Only WORKROOM_-prefixed variables may be referenced, so no admin can read unrelated process secrets.
		if (n !== undefined && n !== null && !/^WORKROOM_[A-Z0-9_]{3,64}$/.test(n)) throw new HttpError(400, "invalid_env", "环境变量名必须以 WORKROOM_ 开头");
	};
	const checkPrice = (pr: any) => {
		if (pr == null) return;
		for (const k of ["input", "output", "cacheRead", "cacheWrite"]) if (typeof pr[k] !== "number" || pr[k] < 0) throw new HttpError(400, "invalid_price", "价格需为每百万 Token 的非负数（input/output/cacheRead/cacheWrite）");
	};
	api.get("/admin/channels", async (c) => {
		const p = await admin(c);
		return c.json({ channels: db.all<ChannelRow>("SELECT * FROM ops_channels WHERE org_id IS NULL OR org_id = ? ORDER BY builtin DESC, created_at", p.orgId).map((r) => gateway.channelDto(r)) });
	});
	api.post("/admin/channels", async (c) => {
		const p = await admin(c);
		const b = await jsonBody<any>(c);
		if (!b.name?.trim() || !KINDS.includes(b.provider)) throw new HttpError(400, "invalid", `名称必填；provider 取值 ${KINDS.join("/")}`);
		if (b.provider === "openai-compatible" && !/^https?:\/\//.test(b.baseUrl ?? "")) throw new HttpError(400, "invalid", "兼容端点需要 baseUrl");
		if (b.baseUrl && !/^https?:\/\//.test(b.baseUrl)) throw new HttpError(400, "invalid", "baseUrl 无效");
		checkEnvName(b.apiKeyEnv);
		checkPrice(b.price);
		const sealed = b.apiKey ? gateway.sealKey(String(b.apiKey)) : null; // 409 without WORKROOM_SECRET_KEY
		const chId = newId("ch");
		db.run(
			"INSERT INTO ops_channels (id, org_id, name, provider, base_url, api_key_enc, api_key_env, key_hint, status, rpm_limit, concurrency_limit, timeout_ms, price, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'enabled', ?, ?, ?, ?, ?, ?, ?)",
			chId,
			p.orgId,
			b.name.trim(),
			b.provider,
			b.baseUrl ?? null,
			sealed?.enc ?? null,
			b.apiKeyEnv ?? null,
			sealed?.hint ?? null,
			b.rpmLimit ?? null,
			b.concurrencyLimit ?? null,
			b.timeoutMs ?? null,
			b.price ? JSON.stringify(b.price) : null,
			p.userId,
			nowIso(),
			nowIso(),
		);
		gateway.invalidate();
		audit(db, p.orgId, p.userId, "channel.create", chId, { name: b.name, provider: b.provider, baseUrl: b.baseUrl, credential: sealed ? "stored" : b.apiKeyEnv ? `env:${b.apiKeyEnv}` : "none" }, { requestId: rid(c) });
		return c.json({ channel: gateway.channelDto(chRow(p, chId, false)) });
	});
	api.patch("/admin/channels/:id", async (c) => {
		const p = await admin(c);
		const r = chRow(p, c.req.param("id"), true);
		const b = await jsonBody<any>(c);
		checkEnvName(b.apiKeyEnv ?? undefined);
		checkPrice(b.price);
		if (b.status && !["enabled", "disabled"].includes(b.status)) throw new HttpError(400, "invalid", "status 无效");
		const sealed = b.apiKey ? gateway.sealKey(String(b.apiKey)) : null;
		db.run(
			`UPDATE ops_channels SET name = COALESCE(?, name), base_url = COALESCE(?, base_url), status = COALESCE(?, status), rpm_limit = CASE WHEN ? THEN ? ELSE rpm_limit END, concurrency_limit = CASE WHEN ? THEN ? ELSE concurrency_limit END,
			 timeout_ms = CASE WHEN ? THEN ? ELSE timeout_ms END, price = CASE WHEN ? THEN ? ELSE price END,
			 api_key_enc = CASE WHEN ? THEN ? WHEN ? THEN NULL ELSE api_key_enc END, key_hint = CASE WHEN ? THEN ? WHEN ? THEN NULL ELSE key_hint END,
			 api_key_env = CASE WHEN ? THEN ? ELSE api_key_env END, updated_at = ? WHERE id = ?`,
			b.name ?? null,
			b.baseUrl ?? null,
			b.status ?? null,
			"rpmLimit" in b ? 1 : 0,
			b.rpmLimit ?? null,
			"concurrencyLimit" in b ? 1 : 0,
			b.concurrencyLimit ?? null,
			"timeoutMs" in b ? 1 : 0,
			b.timeoutMs ?? null,
			"price" in b ? 1 : 0,
			b.price ? JSON.stringify(b.price) : null,
			sealed ? 1 : 0,
			sealed?.enc ?? null,
			b.apiKey === null ? 1 : 0,
			sealed ? 1 : 0,
			sealed?.hint ?? null,
			b.apiKey === null ? 1 : 0,
			"apiKeyEnv" in b ? 1 : 0,
			b.apiKeyEnv ?? null,
			nowIso(),
			r.id,
		);
		gateway.invalidate();
		const { apiKey: _k, ...safe } = b;
		audit(db, p.orgId, p.userId, "channel.update", r.id, { ...safe, credentialRotated: !!sealed, credentialCleared: b.apiKey === null }, { requestId: rid(c) });
		return c.json({ channel: gateway.channelDto(chRow(p, r.id, false)) });
	});
	/** Connectivity test: one tiny real request through the channel (not recorded as usage). */
	api.post("/admin/channels/:id/test", async (c) => {
		const p = await admin(c);
		const r = chRow(p, c.req.param("id"), false);
		const b = await jsonBody<{ upstreamModelId?: string }>(c).catch(() => ({}) as { upstreamModelId?: string });
		const routeRow = db.get<RouteRow>("SELECT * FROM ops_model_routes WHERE channel_id = ? ORDER BY priority LIMIT 1", r.id);
		const h = gateway.channelHealth(r);
		if (h.health === "blocked") return c.json({ ok: false, status: "blocked", detail: h.detail });
		const t0 = Date.now();
		const pm = routeRow ? db.get<PlatformModelRow>("SELECT * FROM ops_platform_models WHERE id = ?", routeRow.platform_model_id) : null;
		if (!routeRow || !pm) return c.json({ ok: false, status: "no_route", detail: "该渠道尚未被任何模型路由引用" });
		const modelRef = gateway.piModels().getModel(pm.pi_provider, pm.id);
		if (!modelRef) return c.json({ ok: false, status: "no_route" });
		const msg = await gateway.piModels().completeSimple(modelRef, { messages: [{ role: "user", content: "Reply with: OK", timestamp: Date.now() }] }, { maxTokens: 16 });
		void createAssistantMessageEventStream; // (type import anchor)
		audit(db, p.orgId, p.userId, "channel.test", r.id, { ok: msg.stopReason !== "error", upstream: b.upstreamModelId ?? routeRow.upstream_model_id }, { requestId: rid(c) });
		return c.json({ ok: msg.stopReason !== "error", status: msg.stopReason, latencyMs: Date.now() - t0, error: msg.errorMessage, route: msg.responseModel });
	});

	// ================================================================ admin: routes
	api.post("/admin/models/:id/routes", async (c) => {
		const p = await admin(c);
		const pm = pmRow(p, c.req.param("id"), true);
		const b = await jsonBody<any>(c);
		const ch = chRow(p, b.channelId ?? "", false);
		if (!ch.org_id) throw new HttpError(403, "builtin_channel", "组织模型只能路由到本组织渠道");
		if (!b.upstreamModelId) throw new HttpError(400, "invalid", "upstreamModelId 必填");
		if (b.capabilities && b.capabilities.some((x: string) => !CAPS.includes(x))) throw new HttpError(400, "invalid_capabilities", "能力取值无效");
		const rId = newId("rt");
		db.run("INSERT INTO ops_model_routes (id, platform_model_id, channel_id, upstream_model_id, priority, weight, enabled, capabilities, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)", rId, pm.id, ch.id, String(b.upstreamModelId), b.priority ?? 0, Math.max(0, b.weight ?? 1), b.capabilities ? JSON.stringify(b.capabilities) : null, nowIso());
		gateway.invalidate();
		audit(db, p.orgId, p.userId, "route.create", rId, { model: pm.id, channel: ch.id, upstream: b.upstreamModelId, priority: b.priority ?? 0, weight: b.weight ?? 1 }, { requestId: rid(c) });
		return c.json({ route: gateway.routeDto(db.get<RouteRow>("SELECT * FROM ops_model_routes WHERE id = ?", rId)!) });
	});
	const routeRow = (p: Principal, routeId: string) => {
		const r = db.get<RouteRow>("SELECT * FROM ops_model_routes WHERE id = ?", routeId);
		if (!r) throw new HttpError(404, "not_found", "路由不存在");
		pmRow(p, r.platform_model_id, true);
		return r;
	};
	api.patch("/admin/routes/:id", async (c) => {
		const p = await admin(c);
		const r = routeRow(p, c.req.param("id"));
		const b = await jsonBody<any>(c);
		db.run("UPDATE ops_model_routes SET priority = COALESCE(?, priority), weight = COALESCE(?, weight), enabled = COALESCE(?, enabled), upstream_model_id = COALESCE(?, upstream_model_id), capabilities = CASE WHEN ? THEN ? ELSE capabilities END WHERE id = ?", b.priority ?? null, b.weight ?? null, b.enabled === undefined ? null : b.enabled ? 1 : 0, b.upstreamModelId ?? null, "capabilities" in b ? 1 : 0, b.capabilities ? JSON.stringify(b.capabilities) : null, r.id);
		gateway.invalidate();
		audit(db, p.orgId, p.userId, "route.update", r.id, b, { requestId: rid(c) });
		return c.json({ route: gateway.routeDto(db.get<RouteRow>("SELECT * FROM ops_model_routes WHERE id = ?", r.id)!) });
	});
	api.delete("/admin/routes/:id", async (c) => {
		const p = await admin(c);
		const r = routeRow(p, c.req.param("id"));
		db.run("DELETE FROM ops_model_routes WHERE id = ?", r.id);
		gateway.invalidate();
		audit(db, p.orgId, p.userId, "route.delete", r.id, { model: r.platform_model_id, channel: r.channel_id }, { requestId: rid(c) });
		return c.json({ ok: true });
	});
	api.get("/admin/route-attempts", async (c) => {
		const p = await admin(c);
		const q = c.req.query();
		const where = ["(a.org_id = ? OR (a.org_id IS NULL AND a.platform_model_id IN (SELECT id FROM ops_platform_models WHERE org_id = ?)))"];
		const params: (string | number)[] = [p.orgId, p.orgId];
		if (q.spaceId) where.push("a.space_id = ?"), params.push(q.spaceId);
		if (q.conversationId) where.push("a.conversation_id = ?"), params.push(Number(q.conversationId));
		if (q.requestKey) where.push("a.request_key = ?"), params.push(q.requestKey);
		if (q.status) where.push("a.status = ?"), params.push(q.status);
		if (q.channelId) where.push("a.channel_id = ?"), params.push(q.channelId);
		const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 2000);
		const rows = db.all<any>(`SELECT a.*, ch.name AS channel_name FROM ops_route_attempts a LEFT JOIN ops_channels ch ON ch.id = a.channel_id WHERE ${where.join(" AND ")} ORDER BY a.started_at DESC, a.attempt_no DESC LIMIT ${limit}`, ...params);
		return c.json({ attempts: rows.map(attemptDto) });
	});
	/** Route attempts of one conversation, for its participants (model shown ↔ actual provider/route, M15-A). */
	api.get("/conversations/:spaceId/:conversationId/routes", async (c) => {
		const p = principalOf(c);
		const spaceId = c.req.param("spaceId");
		const cid = Number(c.req.param("conversationId"));
		await id().require(p, "read", { kind: "conversation", id: String(cid), spaceId });
		const rows = db.all<any>("SELECT a.*, ch.name AS channel_name FROM ops_route_attempts a LEFT JOIN ops_channels ch ON ch.id = a.channel_id WHERE a.space_id = ? AND a.conversation_id = ? ORDER BY a.started_at, a.attempt_no LIMIT 2000", spaceId, cid);
		return c.json({ attempts: rows.map(attemptDto) });
	});

	// ================================================================ usage / stats
	const range = (c: HonoContext<AppEnv>) => ({ from: c.req.query("from"), to: c.req.query("to") });
	api.get("/usage", async (c) => {
		const p = principalOf(c);
		await usage.importDirty({ orgId: p.orgId });
		const { _where, ...out } = await usage.summary(p, parseScope(c.req.query("scope")), range(c));
		return c.json(out);
	});
	api.get("/stats", async (c) => {
		const p = principalOf(c);
		await usage.importDirty({ orgId: p.orgId });
		const lc = Number(c.req.query("largeContextTokens"));
		return c.json(await usage.stats(p, parseScope(c.req.query("scope")), { ...range(c), ...(lc > 0 ? { largeContextTokens: lc } : {}) }));
	});
	api.get("/usage/ledger", async (c) => {
		const p = principalOf(c);
		return c.json({ items: await usage.ledger(p, parseScope(c.req.query("scope")), { ...range(c), kind: c.req.query("kind"), limit: Number(c.req.query("limit")) || undefined }) });
	});
	api.get("/usage/export.csv", async (c) => {
		const p = principalOf(c);
		const scope = parseScope(c.req.query("scope"));
		await usage.importDirty({ orgId: p.orgId });
		const items = await usage.ledger(p, scope, { ...range(c), kind: c.req.query("kind"), limit: 10_000 });
		audit(db, p.orgId, p.userId, "usage.export", JSON.stringify(scope), { rows: items.length }, { requestId: rid(c), category: "admin" });
		c.header("content-type", "text/csv; charset=utf-8");
		c.header("content-disposition", `attachment; filename="usage-${scope.kind}.csv"`);
		const flat = items.map((r) => ({ ...r, inputTokens: r.tokens.input, outputTokens: r.tokens.output, cacheRead: r.tokens.cacheRead, cacheWrite: r.tokens.cacheWrite, totalTokens: r.tokens.total }));
		return c.body(toCsv(["at", "kind", "outcome", "orgId", "spaceId", "projectId", "userId", "conversationId", "entryId", "taskId", "platformModelId", "provider", "route", "toolName", "inputTokens", "outputTokens", "cacheRead", "cacheWrite", "totalTokens", "cost", "fixture", "durationMs", "errorClass", "automationId"], flat as any));
	});
	api.post("/usage/time-savings", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ minutes: number; note?: string; spaceId?: string; conversationId?: number }>(c);
		if (!(typeof b.minutes === "number" && b.minutes > 0 && b.minutes <= 24 * 60)) throw new HttpError(400, "invalid", "分钟数需在 (0, 1440]");
		let projectId: string | null = null;
		if (b.spaceId) {
			await id().require(p, "read", { kind: "space", id: b.spaceId });
			projectId = id().space(b.spaceId)?.projectId ?? null;
		}
		const tsId = newId("sav");
		db.run("INSERT INTO usage_time_savings (id, org_id, user_id, project_id, space_id, conversation_id, minutes, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", tsId, p.orgId, p.userId, projectId, b.spaceId ?? null, b.conversationId ?? null, b.minutes, b.note ?? null, nowIso());
		return c.json({ id: tsId });
	});
	api.put("/admin/settings/savings", async (c) => {
		const p = await admin(c);
		const b = await jsonBody<{ minutesPerSuccessfulTask: number | null }>(c);
		if (b.minutesPerSuccessfulTask === null) db.run("DELETE FROM ops_settings WHERE org_id = ? AND key = 'saved_minutes_per_successful_task'", p.orgId);
		else {
			if (!(b.minutesPerSuccessfulTask > 0 && b.minutesPerSuccessfulTask <= 600)) throw new HttpError(400, "invalid", "取值需在 (0, 600]");
			db.run("INSERT INTO ops_settings (org_id, key, value, updated_by, updated_at) VALUES (?, 'saved_minutes_per_successful_task', ?, ?, ?) ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at", p.orgId, String(b.minutesPerSuccessfulTask), p.userId, nowIso());
		}
		audit(db, p.orgId, p.userId, "settings.savings_basis", p.orgId, b, { requestId: rid(c) });
		return c.json({ ok: true });
	});
	const spaceInOrg = async (p: Principal, spaceId: string) => {
		const sp = id().space(spaceId);
		if (!sp || sp.orgId !== p.orgId) throw new HttpError(404, "space_not_found", "空间不存在");
		return sp;
	};
	api.post("/admin/usage/import", async (c) => {
		const p = await admin(c);
		return c.json({ imported: await usage.importDirty({ orgId: p.orgId }) });
	});
	api.post("/admin/usage/rebuild", async (c) => {
		const p = await admin(c);
		const b = await jsonBody<{ spaceId: string; conversationIds?: number[] }>(c);
		await spaceInOrg(p, b.spaceId);
		const r = await usage.rebuildSpace(b.spaceId, b.conversationIds ?? []);
		audit(db, p.orgId, p.userId, "usage.rebuild", b.spaceId, r, { requestId: rid(c) });
		return c.json(r);
	});
	api.get("/admin/usage/reconcile", async (c) => {
		const p = await admin(c);
		const spaceId = c.req.query("spaceId") ?? "";
		await spaceInOrg(p, spaceId);
		const conversations = db.all<any>("SELECT conversation_id, imported_at, usage_check FROM usage_import_state WHERE space_id = ?", spaceId).map((r) => ({ conversationId: r.conversation_id, importedAt: r.imported_at, check: r.usage_check ? JSON.parse(r.usage_check) : null }));
		return c.json({ space: await usage.reconcileSpace(spaceId), conversations });
	});

	// ================================================================ budgets
	const budgetDto = (b: any) => {
		const st = usage.budgetState(b);
		let name: string | undefined;
		if (b.scope_kind === "project") name = db.get<any>("SELECT name FROM id_projects WHERE id = ?", b.scope_id)?.name;
		else if (b.scope_kind === "department") name = db.get<any>("SELECT name FROM id_departments WHERE id = ?", b.scope_id)?.name;
		else if (b.scope_kind === "user") name = db.get<any>("SELECT name FROM id_users WHERE id = ?", b.scope_id)?.name;
		else name = db.get<any>("SELECT name FROM id_orgs WHERE id = ?", b.scope_id)?.name;
		return { id: b.id, scope: { kind: b.scope_kind, id: b.scope_id, name }, period: b.period, limitCost: b.limit_cost ?? undefined, limitTokens: b.limit_tokens ?? undefined, action: b.action, enabled: !!b.enabled, createdAt: b.created_at, spent: st.spent, state: st.state };
	};
	api.get("/budgets", async (c) => {
		const p = principalOf(c);
		await usage.importDirty({ orgId: p.orgId });
		const isAdmin = p.orgRole !== "member";
		const rows = db.all<any>("SELECT * FROM usage_budgets WHERE org_id = ? ORDER BY created_at", p.orgId).filter((b) => isAdmin || b.scope_kind === "org" || (b.scope_kind === "user" && b.scope_id === p.userId) || (b.scope_kind === "department" && p.departmentIds.includes(b.scope_id)) || (b.scope_kind === "project" && id().projectRole(p.userId, b.scope_id) !== null));
		return c.json({ budgets: rows.map(budgetDto) });
	});
	api.get("/budgets/check", async (c) => {
		const p = principalOf(c);
		const spaceId = c.req.query("spaceId") ?? id().personalSpace(p.userId, p.orgId).id;
		await id().require(p, "read", { kind: "space", id: spaceId });
		return c.json(await usage.checkSubmit(p, spaceId));
	});
	const validateBudget = (p: Principal, b: any) => {
		if (!["org", "department", "project", "user"].includes(b.scope?.kind)) throw new HttpError(400, "invalid", "预算范围无效");
		if (!["day", "month", "total"].includes(b.period)) throw new HttpError(400, "invalid", "周期取值 day/month/total");
		if (b.limitCost == null && b.limitTokens == null) throw new HttpError(400, "invalid", "需要费用或 Token 上限");
		if ((b.limitCost != null && !(b.limitCost >= 0)) || (b.limitTokens != null && !(b.limitTokens >= 0))) throw new HttpError(400, "invalid", "上限需为非负数");
		const sid = b.scope.kind === "org" ? p.orgId : b.scope.id;
		const ok =
			b.scope.kind === "org" ||
			(b.scope.kind === "department" && db.get("SELECT 1 FROM id_departments WHERE id = ? AND org_id = ?", sid, p.orgId)) ||
			(b.scope.kind === "project" && db.get("SELECT 1 FROM id_projects WHERE id = ? AND org_id = ?", sid, p.orgId)) ||
			(b.scope.kind === "user" && db.get("SELECT 1 FROM id_org_members WHERE user_id = ? AND org_id = ? AND removed_at IS NULL", sid, p.orgId));
		if (!ok) throw new HttpError(404, "scope_not_found", "预算范围对象不存在");
		return sid as string;
	};
	api.post("/admin/budgets", async (c) => {
		const p = await admin(c);
		const b = await jsonBody<any>(c);
		const sid = validateBudget(p, b);
		const bid = newBudgetId();
		db.run("INSERT INTO usage_budgets (id, org_id, scope_kind, scope_id, period, limit_cost, limit_tokens, action, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)", bid, p.orgId, b.scope.kind, sid, b.period, b.limitCost ?? null, b.limitTokens ?? null, b.action === "warn" ? "warn" : "block", p.userId, nowIso(), nowIso());
		audit(db, p.orgId, p.userId, "budget.create", bid, { scope: b.scope, period: b.period, limitCost: b.limitCost, limitTokens: b.limitTokens, action: b.action ?? "block" }, { requestId: rid(c) });
		return c.json({ budget: budgetDto(db.get("SELECT * FROM usage_budgets WHERE id = ?", bid)) });
	});
	api.patch("/admin/budgets/:id", async (c) => {
		const p = await admin(c);
		const row = db.get<any>("SELECT * FROM usage_budgets WHERE id = ? AND org_id = ?", c.req.param("id"), p.orgId);
		if (!row) throw new HttpError(404, "not_found", "预算不存在");
		const b = await jsonBody<any>(c);
		db.run("UPDATE usage_budgets SET limit_cost = CASE WHEN ? THEN ? ELSE limit_cost END, limit_tokens = CASE WHEN ? THEN ? ELSE limit_tokens END, enabled = COALESCE(?, enabled), action = COALESCE(?, action), period = COALESCE(?, period), updated_at = ? WHERE id = ?", "limitCost" in b ? 1 : 0, b.limitCost ?? null, "limitTokens" in b ? 1 : 0, b.limitTokens ?? null, b.enabled === undefined ? null : b.enabled ? 1 : 0, b.action ?? null, b.period ?? null, nowIso(), row.id);
		audit(db, p.orgId, p.userId, "budget.update", row.id, b, { requestId: rid(c) });
		return c.json({ budget: budgetDto(db.get("SELECT * FROM usage_budgets WHERE id = ?", row.id)) });
	});
	api.delete("/admin/budgets/:id", async (c) => {
		const p = await admin(c);
		const r = db.run("DELETE FROM usage_budgets WHERE id = ? AND org_id = ?", c.req.param("id"), p.orgId);
		if (!r.changes) throw new HttpError(404, "not_found", "预算不存在");
		audit(db, p.orgId, p.userId, "budget.delete", c.req.param("id"), undefined, { requestId: rid(c) });
		return c.json({ ok: true });
	});

	// ================================================================ automations
	const runDto = (r: any) => {
		const tz = db.get<any>("SELECT timezone FROM auto_automations WHERE id = ?", r.automation_id)?.timezone ?? "UTC";
		const notes = db.all<any>("SELECT * FROM ops_notifications WHERE run_id = ?", r.id).map((n) => ({ id: n.id, status: n.status, deliveries: db.all<any>("SELECT * FROM ops_notify_deliveries WHERE notification_id = ? ORDER BY created_at", n.id).map(deliveryDto) }));
		return {
			id: r.id,
			automationId: r.automation_id,
			scheduledFor: runWhen(r),
			scheduledForLocal: localTime(runWhen(r), tz),
			trigger: r.trigger,
			status: r.status,
			reason: r.reason ?? undefined,
			error: r.error ?? undefined,
			spaceId: r.space_id ?? undefined,
			conversationId: r.conversation_id ?? undefined,
			submissionId: r.submission_id ?? undefined,
			requestId: r.request_id,
			startedAt: r.started_at ?? undefined,
			endedAt: r.ended_at ?? undefined,
			createdAt: r.created_at,
			rerunOf: r.rerun_of ?? undefined,
			link: r.conversation_id != null ? `/c/${r.space_id}/${r.conversation_id}` : undefined,
			notifications: notes,
		};
	};
	const autoDto = (a: any, webhookToken?: string) => {
		const last = db.get<any>("SELECT * FROM auto_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT 1", a.id);
		const dest = JSON.parse(a.destination);
		return {
			id: a.id,
			name: a.name,
			prompt: a.prompt,
			ownerUserId: a.owner_user_id,
			spaceId: a.space_id,
			projectId: a.project_id ?? undefined,
			assistantId: a.assistant_id ?? undefined,
			modelId: a.model_id ?? undefined,
			trigger: JSON.parse(a.trigger),
			timezone: a.timezone,
			condition: JSON.parse(a.condition),
			destination: dest,
			concurrency: { max: a.max_concurrent, policy: "skip" },
			missedPolicy: a.missed_policy,
			maxDurationMs: a.max_duration_ms,
			enabled: !!a.enabled,
			nextRunAt: a.next_run_at ?? undefined,
			nextRunLocal: a.next_run_at ? localTime(a.next_run_at, a.timezone) : undefined,
			lastRun: last ? runDto(last) : undefined,
			...(webhookToken ? { webhookToken, webhookUrl: `/api/hooks/automations/${webhookToken}` } : {}),
			createdAt: a.created_at,
			updatedAt: a.updated_at,
		};
	};
	const validateAutomation = (b: any, partial: boolean) => {
		if (!partial || b.trigger) {
			const t = b.trigger as Trigger;
			if (!t || !["once", "cron", "manual", "webhook"].includes(t.kind)) throw new HttpError(400, "invalid_trigger", "触发方式取值 once/cron/manual/webhook");
		}
		if ((!partial || b.timezone) && !validTimezone(b.timezone ?? "")) throw new HttpError(400, "invalid_timezone", `无效时区：${b.timezone}`);
		if (b.trigger && b.timezone) nextRuns(b.trigger, b.timezone, new Date(), 1); // validates cron syntax
		if (b.condition && !["always", "previous_status"].includes((b.condition as Condition).kind)) throw new HttpError(400, "invalid_condition", "触发条件无效");
		if (!partial && (!b.name?.trim() || !b.prompt?.trim())) throw new HttpError(400, "invalid", "名称与任务内容必填");
	};
	const loadAuto = async (p: Principal, autoId: string, action: "read" | "write") => {
		await id().require(p, action, { kind: "automation", id: autoId });
		return automation.get(autoId)!;
	};
	api.post("/automations/preview", async (c) => {
		principalOf(c);
		const b = await jsonBody<{ trigger: Trigger; timezone: string; count?: number; from?: string }>(c);
		try {
			const runs = nextRuns(b.trigger, b.timezone, b.from ? new Date(b.from) : new Date(automation.now()), Math.min(Math.max(b.count ?? 5, 1), 50));
			return c.json({ timezone: b.timezone, runs: runs.map((at) => ({ at, local: localTime(at, b.timezone) })) });
		} catch (e) {
			return c.json({ timezone: b.timezone, runs: [], error: (e as Error).message });
		}
	});
	api.get("/automations", async (c) => {
		const p = principalOf(c);
		const spaces = (await id().readableSpaces(p)).map((s) => s.id);
		const ph = spaces.map(() => "?").join(",") || "''";
		const rows = db.all<any>(`SELECT * FROM auto_automations WHERE org_id = ? AND deleted_at IS NULL AND (owner_user_id = ? OR space_id IN (${ph})) ORDER BY created_at DESC`, p.orgId, p.userId, ...spaces);
		return c.json({ automations: rows.map((a) => autoDto(a)) });
	});
	api.post("/automations", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<any>(c);
		validateAutomation(b, false);
		const spaceId = b.spaceId ?? (b.projectId ? id().projectSpace(b.projectId)?.id : id().personalSpace(p.userId, p.orgId).id);
		if (!spaceId) throw new HttpError(404, "space_not_found", "空间不存在");
		await id().require(p, "write", { kind: "space", id: spaceId });
		if (b.modelId && !(await gateway.listFor(p)).some((m) => m.id === b.modelId)) throw new HttpError(400, "unknown_model", "模型不可用");
		const { row, webhookToken } = automation.create(p, { ...b, spaceId });
		audit(db, p.orgId, p.userId, "automation.create", row.id, { trigger: b.trigger, timezone: b.timezone, spaceId, destination: b.destination }, { requestId: rid(c) });
		return c.json({ automation: autoDto(row, webhookToken) });
	});
	api.get("/automations/:id", async (c) => c.json({ automation: autoDto(await loadAuto(principalOf(c), c.req.param("id"), "read")) }));
	api.get("/automations/:id/preview", async (c) => {
		const a = await loadAuto(principalOf(c), c.req.param("id"), "read");
		const runs = nextRuns(JSON.parse(a.trigger), a.timezone, new Date(automation.now()), Math.min(Math.max(Number(c.req.query("count")) || 5, 1), 50));
		return c.json({ timezone: a.timezone, runs: runs.map((at) => ({ at, local: localTime(at, a.timezone) })) });
	});
	api.patch("/automations/:id", async (c) => {
		const p = principalOf(c);
		const a = await loadAuto(p, c.req.param("id"), "write");
		const b = await jsonBody<any>(c);
		validateAutomation({ ...b, timezone: b.timezone ?? a.timezone, trigger: b.trigger ?? JSON.parse(a.trigger) }, true);
		const row = automation.update(p, a, b);
		audit(db, p.orgId, p.userId, "automation.update", a.id, b, { requestId: rid(c) });
		return c.json({ automation: autoDto(row) });
	});
	api.delete("/automations/:id", async (c) => {
		const p = principalOf(c);
		const a = await loadAuto(p, c.req.param("id"), "write");
		db.run("UPDATE auto_automations SET deleted_at = ?, enabled = 0, next_run_at = NULL WHERE id = ?", nowIso(), a.id);
		audit(db, p.orgId, p.userId, "automation.delete", a.id, undefined, { requestId: rid(c) });
		return c.json({ ok: true });
	});
	api.post("/automations/:id/webhook-token", async (c) => {
		const p = principalOf(c);
		const a = await loadAuto(p, c.req.param("id"), "write");
		if (JSON.parse(a.trigger).kind !== "webhook") throw new HttpError(409, "not_webhook", "该自动化不是 Webhook 触发");
		const token = automation.rotateWebhookToken(a);
		audit(db, p.orgId, p.userId, "automation.webhook_rotate", a.id, undefined, { requestId: rid(c) });
		return c.json({ webhookToken: token, webhookUrl: `/api/hooks/automations/${token}` });
	});
	api.post("/automations/:id/run", async (c) => {
		const p = principalOf(c);
		const a = await loadAuto(p, c.req.param("id"), "write");
		const r = automation.runNow(a, "manual");
		audit(db, p.orgId, p.userId, "automation.run_manual", a.id, { runId: r.runId }, { requestId: rid(c) });
		return c.json({ runId: r.runId, run: runDto(db.get("SELECT * FROM auto_runs WHERE id = ?", r.runId)) });
	});
	api.get("/automations/:id/runs", async (c) => {
		const a = await loadAuto(principalOf(c), c.req.param("id"), "read");
		const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 500);
		return c.json({ runs: db.all<any>(`SELECT * FROM auto_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT ${limit}`, a.id).map(runDto) });
	});
	const runRow = async (p: Principal, runId: string, action: "read" | "write") => {
		const r = db.get<any>("SELECT * FROM auto_runs WHERE id = ? AND org_id = ?", runId, p.orgId);
		if (!r) throw new HttpError(404, "not_found", "运行记录不存在");
		await loadAuto(p, r.automation_id, action);
		return r;
	};
	api.get("/automation-runs/:runId", async (c) => c.json({ run: runDto(await runRow(principalOf(c), c.req.param("runId"), "read")) }));
	api.post("/automation-runs/:runId/rerun", async (c) => {
		const p = principalOf(c);
		const r = await runRow(p, c.req.param("runId"), "write");
		const a = automation.get(r.automation_id)!;
		const out = automation.runNow(a, "rerun", { rerunOf: r.id });
		audit(db, p.orgId, p.userId, "automation.rerun", a.id, { runId: out.runId, rerunOf: r.id }, { requestId: rid(c) });
		return c.json({ runId: out.runId });
	});
	api.post("/automation-runs/:runId/cancel", async (c) => {
		const p = principalOf(c);
		const r = await runRow(p, c.req.param("runId"), "write");
		await automation.cancel(p, r.id);
		return c.json({ run: runDto(db.get("SELECT * FROM auto_runs WHERE id = ?", r.id)) });
	});
	/** Public inbound trigger (event-driven automations). `Idempotency-Key` dedupes repeated deliveries. */
	api.post("/hooks/automations/:token", async (c) => {
		const a = automation.byWebhookToken(c.req.param("token"));
		if (!a || !a.enabled) throw new HttpError(404, "not_found", "触发地址无效");
		const key = c.req.header("idempotency-key");
		if (key && !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new HttpError(400, "invalid_key", "Idempotency-Key 格式无效");
		const r = automation.runNow(a, "webhook", { dedupeKey: key });
		return c.json({ runId: r.runId, duplicate: r.duplicate }, r.duplicate ? 200 : 202);
	});

	// ================================================================ notifications
	api.get("/notifications", async (c) => {
		const p = principalOf(c);
		const unread = c.req.query("unread") === "1";
		const rows = db.all<any>(`SELECT * FROM ops_notifications WHERE org_id = ? AND user_id = ? ${unread ? "AND read_at IS NULL" : ""} ORDER BY created_at DESC LIMIT 200`, p.orgId, p.userId);
		const n = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ops_notifications WHERE org_id = ? AND user_id = ? AND read_at IS NULL", p.orgId, p.userId)!.n;
		return c.json({ notifications: rows.map(notificationDto), unread: n });
	});
	api.post("/notifications/:id/read", async (c) => {
		const p = principalOf(c);
		const r = db.run("UPDATE ops_notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND org_id = ? AND user_id = ?", nowIso(), c.req.param("id"), p.orgId, p.userId);
		if (!r.changes) throw new HttpError(404, "not_found", "通知不存在");
		return c.json({ ok: true });
	});
	api.post("/notifications/read-all", async (c) => {
		const p = principalOf(c);
		db.run("UPDATE ops_notifications SET read_at = ? WHERE org_id = ? AND user_id = ? AND read_at IS NULL", nowIso(), p.orgId, p.userId);
		return c.json({ ok: true });
	});
	api.get("/notifications/deliveries", async (c) => {
		const p = principalOf(c);
		const runId = c.req.query("runId");
		const rows = db.all<any>(`SELECT d.* FROM ops_notify_deliveries d JOIN ops_notifications n ON n.id = d.notification_id WHERE d.org_id = ? AND (n.user_id = ? OR ?) ${runId ? "AND d.run_id = ?" : ""} ORDER BY d.created_at DESC LIMIT 200`, p.orgId, p.userId, p.orgRole !== "member" ? 1 : 0, ...(runId ? [runId] : []));
		return c.json({ deliveries: rows.map(deliveryDto) });
	});
	api.post("/notifications/deliveries/:id/retry", async (c) => {
		const p = principalOf(c);
		notify.retry(p, c.req.param("id"));
		return c.json({ ok: true });
	});
	api.get("/notify-channels", async (c) => {
		const p = principalOf(c);
		const rows = db.all<any>("SELECT * FROM ops_notify_channels WHERE org_id = ? AND deleted_at IS NULL AND (owner_user_id = ? OR shared = 1) ORDER BY created_at", p.orgId, p.userId);
		return c.json({ channels: rows.map((r) => channelDto(notify, r)) });
	});
	api.post("/notify-channels", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ kind: "webhook" | "email"; name: string; target: string; secret?: string; shared?: boolean }>(c);
		if (!["webhook", "email"].includes(b.kind) || !b.name?.trim() || !b.target) throw new HttpError(400, "invalid", "渠道类型、名称、目标必填");
		if (b.kind === "webhook") validateWebhookUrl(b.target);
		if (b.kind === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.target)) throw new HttpError(400, "invalid", "邮箱地址无效");
		if (b.shared) await requireOrgAdmin(id(), p);
		const secretEnc = b.secret ? notify.secrets.seal(b.secret) : null;
		const chId = newId("nch");
		db.run("INSERT INTO ops_notify_channels (id, org_id, owner_user_id, kind, name, target, secret_enc, shared, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)", chId, p.orgId, p.userId, b.kind, b.name.trim(), b.target, secretEnc, b.shared ? 1 : 0, nowIso(), nowIso());
		audit(db, p.orgId, p.userId, "notify.channel_create", chId, { kind: b.kind, shared: !!b.shared }, { requestId: rid(c) });
		return c.json({ channel: channelDto(notify, db.get("SELECT * FROM ops_notify_channels WHERE id = ?", chId)) });
	});
	api.delete("/notify-channels/:id", async (c) => {
		const p = principalOf(c);
		const r = db.get<any>("SELECT * FROM ops_notify_channels WHERE id = ? AND org_id = ? AND deleted_at IS NULL", c.req.param("id"), p.orgId);
		if (!r) throw new HttpError(404, "not_found", "通知渠道不存在");
		if (r.owner_user_id !== p.userId) await requireOrgAdmin(id(), p);
		db.run("UPDATE ops_notify_channels SET deleted_at = ?, enabled = 0 WHERE id = ?", nowIso(), r.id);
		return c.json({ ok: true });
	});

	// ================================================================ trace by correlation id (M18-B)
	api.get("/admin/trace", async (c) => {
		const p = await admin(c);
		const q = c.req.query("q")?.trim() ?? "";
		if (!q) throw new HttpError(400, "invalid", "q 必填：requestId / runId / requestKey / <spaceId>:<conversationId> / automationId");
		await usage.importDirty({ orgId: p.orgId });
		const [spaceId, convStr] = q.includes(":") && !q.startsWith("auto:") ? q.split(":") : [undefined, undefined];
		const conv = convStr ? Number(convStr) : undefined;
		const auditRows = db.all<any>("SELECT a.*, u.name AS actor_name FROM id_audit a LEFT JOIN id_users u ON u.id = a.actor_user_id WHERE a.org_id = ? AND (a.request_id = ? OR a.target = ? OR a.detail LIKE ? ESCAPE '\\') ORDER BY a.at LIMIT 200", p.orgId, q, q, `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
		const runs = db.all<any>("SELECT * FROM auto_runs WHERE org_id = ? AND (id = ? OR automation_id = ? OR request_id = ? OR (space_id = ? AND conversation_id = ?)) ORDER BY created_at LIMIT 200", p.orgId, q, q, q, spaceId ?? "", conv ?? -1);
		const convs = new Set<string>(runs.filter((r) => r.conversation_id != null).map((r) => `${r.space_id}:${r.conversation_id}`));
		if (spaceId && conv !== undefined) convs.add(`${spaceId}:${conv}`);
		const attempts: any[] = db.all<any>("SELECT a.*, ch.name AS channel_name FROM ops_route_attempts a LEFT JOIN ops_channels ch ON ch.id = a.channel_id WHERE a.org_id = ? AND (a.request_key = ? OR a.id = ?)", p.orgId, q, q);
		const ledger: any[] = [];
		for (const k of convs) {
			const [sp, cid] = k.split(":");
			if (id().space(sp!)?.orgId !== p.orgId) continue;
			attempts.push(...db.all<any>("SELECT a.*, ch.name AS channel_name FROM ops_route_attempts a LEFT JOIN ops_channels ch ON ch.id = a.channel_id WHERE a.space_id = ? AND a.conversation_id = ? ORDER BY a.started_at", sp, Number(cid)));
			ledger.push(...db.all<any>("SELECT * FROM usage_ledger WHERE space_id = ? AND conversation_id = ? ORDER BY entry_id", sp, Number(cid)));
		}
		const notes = runs.length ? db.all<any>(`SELECT * FROM ops_notifications WHERE run_id IN (${runs.map(() => "?").join(",")})`, ...runs.map((r) => r.id)) : [];
		return c.json({
			query: q,
			audit: auditRows.map((r) => ({ id: r.id, at: r.at, action: r.action, category: r.category, actorUserId: r.actor_user_id ?? undefined, actorName: r.actor_name ?? undefined, target: r.target ?? undefined, detail: r.detail ? JSON.parse(r.detail) : undefined, requestId: r.request_id ?? undefined })),
			routeAttempts: attempts.map(attemptDto),
			ledger: ledger.map(ledgerDto),
			automationRuns: runs.map(runDto),
			notifications: notes.map(notificationDto),
		});
	});
}

export type { Destination };
