// HTTP routes for model providers (pi-ai native), /api:
//   GET  /models                              user-facing picker list (PlatformModel + provider name, capabilities, thinking levels)
//   GET  /model-settings                      { personalProviders }
//   admin   /admin/model-providers[/:id[/test|/fetch-models|/models[/:modelId]]], /admin/model-provider-presets, /admin/model-settings
//   personal /me/model-providers[...]         same shape, scope "user": visible only to the owner, only if the org policy allows it
//   GET  /admin/route-attempts, GET /conversations/:spaceId/:conversationId/routes    per-request records
// Permissions (RBAC catalog): model.provider.manage = providers & keys; model.manage = which models are on, visibility, defaults;
// without the authz service: org owner/admin.
import type { Context as HonoContext, Hono } from "hono";
import type { AppContext, AppEnv, Principal } from "../core/contracts.ts";
import { HttpError, jsonBody, principalOf } from "../core/http.ts";
import { audit, type Identity } from "../identity/module.ts";
import type { Gateway } from "./gateway.ts";
import { configReport } from "./models-bootstrap.ts";
import { PRESETS } from "./models-presets.ts";
import { adminModelDto, createProviderRow, deleteProviderRow, providerDto, removeEntry, saveEntry, updateProviderRow, validateSpec, type EntryPatch, type ProviderInput } from "./models-service.ts";
import type { ProviderRow } from "./models-types.ts";

export function attemptDto(r: any) {
	return {
		id: r.id,
		requestKey: r.request_key,
		attemptNo: r.attempt_no,
		platformModelId: r.platform_model_id,
		// "channel" = the provider that served the attempt (kept for the existing UI contract); providerId / providerName are the new names.
		channelId: r.channel_id ?? undefined,
		channelName: r.provider_name ?? r.channel_name ?? undefined,
		providerId: r.channel_id ?? undefined,
		providerName: r.provider_name ?? undefined,
		provider: r.channel_provider ?? undefined,
		piProvider: r.pi_provider ?? undefined,
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

/** SELECT list for attempt rows joined with the provider's display name. */
export const ATTEMPT_SELECT = "SELECT a.*, COALESCE(mp.name, oc.name) AS provider_name FROM ops_route_attempts a LEFT JOIN model_providers mp ON mp.id = a.channel_id LEFT JOIN ops_channels oc ON oc.id = a.channel_id";

type Mode = "admin" | "personal";

export function registerModelRoutes(api: Hono<AppEnv>, ctx: AppContext, gw: Gateway): void {
	const db = ctx.db;
	const id = () => ctx.services.get("identity") as Identity;
	const rid = (c: HonoContext<AppEnv>) => c.get("requestId");
	const forbid = (what: string) => new HttpError(403, "forbidden", `需要「${what}」权限`);

	// ================================================================ user-facing
	api.get("/models", async (c) => {
		const p = principalOf(c);
		const all = (await gw.listFor(p)) as any[];
		const models = c.req.query("include") === "legacy" ? all : all.filter((m) => !m.legacy);
		let def: string | undefined;
		try {
			const ref = await gw.defaultModel(p);
			def = models.find((m) => m.ref.provider === ref.provider && m.ref.modelId === ref.modelId)?.id;
		} catch {
			/* none */
		}
		return c.json({ models, defaultModelId: def, personalProviders: gw.personalProvidersAllowed(p.orgId) });
	});
	api.get("/model-settings", (c) => {
		const p = principalOf(c);
		return c.json({ personalProviders: gw.personalProvidersAllowed(p.orgId) });
	});

	// ================================================================ shared provider handlers
	const ownerOf = (p: Principal, mode: Mode) => (mode === "admin" ? { scope: "org" as const, orgId: p.orgId, userId: null, source: "admin" as const } : { scope: "user" as const, orgId: p.orgId, userId: p.userId, source: "personal" as const });

	/** Authorisation per mode. `models` = changing which models are on / visible (model.manage) rather than provider credentials. */
	async function actor(c: HonoContext<AppEnv>, mode: Mode, need: "providers" | "models" | "read"): Promise<Principal> {
		const p = principalOf(c);
		if (mode === "personal") {
			if (!gw.personalProvidersAllowed(p.orgId)) throw new HttpError(403, "personal_providers_disabled", "管理员未开放“个人自带密钥”");
			if (!(await gw.can(p, "model.use"))) throw forbid("使用模型");
			return p;
		}
		const prov = await gw.can(p, "model.provider.manage");
		const mod = await gw.can(p, "model.manage");
		if (need === "providers" && !prov) throw forbid("管理渠道与凭据");
		if (need === "models" && !mod) throw forbid("管理平台模型");
		if (need === "read" && !prov && !mod) throw forbid("管理平台模型");
		return p;
	}

	function rowFor(p: Principal, mode: Mode, pid: string, write: boolean): ProviderRow {
		const row = gw.rowOf(pid);
		if (!row) throw new HttpError(404, "not_found", "服务商不存在");
		if (mode === "personal") {
			if (row.scope !== "user" || row.owner_user_id !== p.userId || row.org_id !== p.orgId) throw new HttpError(404, "not_found", "服务商不存在");
			return row;
		}
		if (row.scope === "user") throw new HttpError(404, "not_found", "服务商不存在");
		if (row.scope === "org" && row.org_id !== p.orgId) throw new HttpError(404, "not_found", "服务商不存在");
		if (write && row.scope === "instance") throw new HttpError(403, "instance_provider", "实例级服务商由部署配置（workroom.models.json / 环境变量）管理");
		return row;
	}

	const modelsOf = (row: ProviderRow, p: Principal) => {
		const def = gw.orgDefault(p.orgId);
		return gw.effectiveModels(row.id).map((m) => adminModelDto(gw, row, m, def));
	};
	const detail = (row: ProviderRow, p: Principal) => ({ provider: providerDto(gw, row, p.orgId), models: modelsOf(row, p) });

	const auditSafe = (c: HonoContext<AppEnv>, p: Principal, action: string, target: string, d: Record<string, unknown>) => audit(db, p.orgId, p.userId, action, target, d, { requestId: rid(c) });
	/** Audit detail never carries secrets: only which credential fields were touched. */
	const touched = (b: ProviderInput) => ({ name: b.name, baseUrl: b.baseUrl, authStyle: b.authStyle, keyless: b.keyless, status: b.status, keyRotated: typeof b.apiKey === "string", keyCleared: b.apiKey === null, keyEnv: b.apiKeyEnv ?? undefined, headers: b.headers ? Object.keys(b.headers) : b.headers, env: b.env ? Object.keys(b.env) : b.env });

	function mount(prefix: string, mode: Mode): void {
		api.get(prefix, async (c) => {
			const p = await actor(c, mode, "read");
			const rows = gw.providerRows().filter((r) => (mode === "admin" ? r.scope === "instance" || (r.scope === "org" && r.org_id === p.orgId) : r.scope === "user" && r.owner_user_id === p.userId && r.org_id === p.orgId));
			const out: Record<string, unknown> = { providers: rows.map((r) => providerDto(gw, r, p.orgId)) };
			if (mode === "admin") {
				out.fixture = gw.fixtureListed() ? { id: "fixture", name: "测试模型（Fixture）", detail: "确定性脚本回复；不是真实 AI，费用恒为 0。由 WORKROOM_FIXTURE_MODEL=0 关闭。" } : null;
				out.settings = { personalProviders: gw.personalProvidersAllowed(p.orgId), defaultModel: gw.orgDefault(p.orgId) ?? null, secretKeyConfigured: gw.secrets.available, config: { path: configReport.path ?? null, providers: configReport.providers, errors: configReport.errors } };
			}
			out.presets = PRESETS.filter((x) => mode === "admin" || x.type !== "builtin");
			if (mode === "admin") out.builtins = [...gw.builtinProviders().values()].map((b) => ({ id: b.id, name: b.name, baseUrl: b.baseUrl, models: b.getModels().length, auth: Object.keys(b.auth), configured: !!gw.rowOf(b.id) })).sort((a, b) => a.name.localeCompare(b.name));
			return c.json(out);
		});

		api.post(prefix, async (c) => {
			const p = await actor(c, mode, "providers");
			const b = await jsonBody<ProviderInput & { models?: unknown[]; fetchModels?: boolean; enableFetched?: boolean }>(c);
			const row = await createProviderRow(gw, ownerOf(p, mode), b, p.userId);
			await gw.reload(row.id);
			auditSafe(c, p, "model.provider.create", row.id, { ...touched(b), type: row.type, scope: row.scope, preset: row.preset });
			if (Array.isArray(b.models)) {
				for (const m of b.models as Record<string, any>[]) {
					const { id: mid, enabled, visibility, fallbacks, defaultThinking, description, ...spec } = m;
					saveEntry(gw, row, String(mid), { manual: true, spec, enabled: enabled ?? true, visibility, fallbacks, defaultThinking, description });
				}
				await gw.reload(row.id);
			}
			let fetched: { ok: boolean; error?: string; count?: number } | undefined;
			if (b.fetchModels) {
				try {
					await gw.fetchCatalog(row.id);
					const list = gw.effectiveModels(row.id);
					if (b.enableFetched) for (const m of list) if (!/(^|[-_/])(embed|whisper|tts|dall-e|moderation|rerank)/i.test(m.id)) saveEntry(gw, row, m.id, { enabled: true });
					fetched = { ok: true, count: list.length };
				} catch (e) {
					fetched = { ok: false, error: (e as Error).message };
				}
			}
			return c.json({ ...detail(gw.rowOf(row.id)!, p), fetched });
		});

		api.get(`${prefix}/:id`, async (c) => {
			const p = await actor(c, mode, "read");
			return c.json(detail(rowFor(p, mode, c.req.param("id"), false), p));
		});

		api.patch(`${prefix}/:id`, async (c) => {
			const p = await actor(c, mode, "providers");
			const row = rowFor(p, mode, c.req.param("id"), true);
			const b = await jsonBody<ProviderInput>(c);
			const next = await updateProviderRow(gw, row, b, ownerOf(p, mode));
			auditSafe(c, p, "model.provider.update", row.id, touched(b));
			return c.json(detail(next, p));
		});

		api.delete(`${prefix}/:id`, async (c) => {
			const p = await actor(c, mode, "providers");
			const row = rowFor(p, mode, c.req.param("id"), true);
			await deleteProviderRow(gw, row);
			auditSafe(c, p, "model.provider.delete", row.id, { name: row.name });
			return c.json({ ok: true });
		});

		/** Real request: list models + a tiny completion. Never recorded as usage. */
		api.post(`${prefix}/:id/test`, async (c) => {
			const p = await actor(c, mode, "providers");
			const row = rowFor(p, mode, c.req.param("id"), false);
			const b = await jsonBody<{ modelId?: string }>(c).catch(() => ({}) as { modelId?: string });
			const r = await gw.testProvider(row.id, { modelId: b.modelId });
			auditSafe(c, p, "model.provider.test", row.id, { ok: r.ok, list: r.list.ok, completion: r.completion.ok, model: r.completion.modelId });
			return c.json(r);
		});

		/** "获取模型列表": the provider's native fetchModels() via Models.refresh(); persisted by the DB ModelsStore. */
		api.post(`${prefix}/:id/fetch-models`, async (c) => {
			const p = await actor(c, mode, "providers");
			const row = rowFor(p, mode, c.req.param("id"), mode === "personal" ? false : true);
			const b = await jsonBody<{ enable?: "all" | "chat" | "none" }>(c).catch(() => ({}) as { enable?: "all" | "chat" | "none" });
			try {
				await gw.fetchCatalog(row.id, AbortSignal.timeout(60_000));
			} catch (e) {
				if (e instanceof HttpError) throw e;
				auditSafe(c, p, "model.provider.fetch", row.id, { ok: false });
				return c.json({ ok: false, error: (e as Error).message, ...detail(row, p) });
			}
			if (b.enable === "all" || b.enable === "chat") for (const m of gw.effectiveModels(row.id)) if (b.enable === "all" || !/(^|[-_/])(embed|embedding|whisper|tts|dall-e|moderation|rerank|davinci|babbage|transcribe)/i.test(m.id)) if (!gw.entryOf(row.id, m.id)) saveEntry(gw, row, m.id, { enabled: true });
			const fresh = gw.rowOf(row.id)!;
			auditSafe(c, p, "model.provider.fetch", row.id, { ok: true, count: gw.effectiveModels(row.id).length });
			return c.json({ ok: true, count: gw.effectiveModels(row.id).length, ...detail(fresh, p) });
		});

		api.get(`${prefix}/:id/models`, async (c) => {
			const p = await actor(c, mode, "read");
			return c.json({ models: modelsOf(rowFor(p, mode, c.req.param("id"), false), p) });
		});

		/** Add a model by hand: id, display name, context window, max tokens, modalities, reasoning/thinking, price, compat. */
		api.post(`${prefix}/:id/models`, async (c) => {
			const p = await actor(c, mode, mode === "personal" ? "providers" : "models");
			const row = rowFor(p, mode, c.req.param("id"), true);
			const { id: mid, enabled, visibility, fallbacks, defaultThinking, description, sort, ...spec } = await jsonBody<Record<string, any>>(c);
			if (typeof mid !== "string" || !mid.trim()) throw new HttpError(400, "invalid_model", "模型 ID 必填");
			if (gw.effectiveModels(row.id).some((m) => m.id === mid.trim())) throw new HttpError(409, "exists", "模型 ID 已存在于该服务商（可直接编辑）");
			saveEntry(gw, row, mid.trim(), { manual: true, spec, enabled: enabled ?? true, visibility: mode === "personal" ? null : visibility, fallbacks, defaultThinking, description, sort });
			await gw.reload(row.id);
			auditSafe(c, p, "model.entry.create", `${row.id}/${mid}`, { name: spec.name });
			const m = gw.effectiveModels(row.id).find((x) => x.id === mid.trim())!;
			return c.json({ model: adminModelDto(gw, row, m, gw.orgDefault(p.orgId)) });
		});

		/** Bulk enable/disable: { modelIds: string[], enabled: boolean } */
		api.patch(`${prefix}/:id/models`, async (c) => {
			const p = await actor(c, mode, mode === "personal" ? "providers" : "models");
			const row = rowFor(p, mode, c.req.param("id"), true);
			const b = await jsonBody<{ modelIds?: string[]; enabled?: boolean }>(c);
			if (!Array.isArray(b.modelIds) || typeof b.enabled !== "boolean") throw new HttpError(400, "invalid", "需要 modelIds[] 与 enabled");
			for (const mid of b.modelIds) saveEntry(gw, row, mid, { enabled: b.enabled });
			auditSafe(c, p, "model.entry.bulk", row.id, { count: b.modelIds.length, enabled: b.enabled });
			return c.json({ models: modelsOf(row, p) });
		});

		api.patch(`${prefix}/:id/models/:modelId{.+}`, async (c) => {
			const p = await actor(c, mode, mode === "personal" ? "providers" : "models");
			const row = rowFor(p, mode, c.req.param("id"), true);
			const mid = c.req.param("modelId");
			const b = await jsonBody<EntryPatch & Record<string, any>>(c);
			const patch: EntryPatch = {};
			for (const k of ["enabled", "visibility", "fallbacks", "defaultThinking", "sort", "description", "resetSpec"] as const) if (k in b) (patch as any)[k] = b[k];
			if (mode === "personal") delete patch.visibility;
			// spec fields may be sent flat (contextWindow, compat, ...) or under `spec`
			const flat = Object.fromEntries(Object.entries(b).filter(([k]) => ["name", "contextWindow", "maxTokens", "input", "reasoning", "thinkingLevelMap", "cost", "compat", "tools"].includes(k)));
			if (b.spec !== undefined || Object.keys(flat).length) patch.spec = { ...(b.spec ?? {}), ...flat };
			saveEntry(gw, row, mid, patch);
			await gw.reload(row.id);
			auditSafe(c, p, "model.entry.update", `${row.id}/${mid}`, { fields: Object.keys(b) });
			const m = gw.effectiveModels(row.id).find((x) => x.id === mid);
			if (!m) throw new HttpError(404, "model_not_found", "模型不存在");
			return c.json({ model: adminModelDto(gw, row, m, gw.orgDefault(p.orgId)) });
		});

		api.delete(`${prefix}/:id/models/:modelId{.+}`, async (c) => {
			const p = await actor(c, mode, mode === "personal" ? "providers" : "models");
			const row = rowFor(p, mode, c.req.param("id"), true);
			const mid = c.req.param("modelId");
			await removeEntry(gw, row, mid);
			await gw.reload(row.id);
			auditSafe(c, p, "model.entry.delete", `${row.id}/${mid}`, {});
			return c.json({ ok: true });
		});
	}
	mount("/admin/model-providers", "admin");
	mount("/me/model-providers", "personal");

	api.get("/admin/model-provider-presets", async (c) => {
		await actor(c, "admin", "read");
		return c.json({ presets: PRESETS });
	});

	/** Validate a model definition without saving it (the "add model" form uses it for inline feedback). */
	api.post("/admin/model-providers/:id/models/validate", async (c) => {
		const p = await actor(c, "admin", "read");
		const row = rowFor(p, "admin", c.req.param("id"), false);
		const b = await jsonBody<Record<string, unknown>>(c);
		const { id: _id, enabled: _e, visibility: _v, fallbacks: _f, defaultThinking: _d, description: _ds, sort: _s, ...spec } = b;
		return c.json({ ok: true, spec: validateSpec(row.type === "builtin" ? (gw.effectiveModels(row.id)[0]?.api ?? "openai-completions") : row.type, spec) });
	});

	api.put("/admin/model-settings", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ personalProviders?: boolean; defaultModel?: { provider: string; modelId: string } | null }>(c);
		const now = new Date().toISOString();
		if (b.personalProviders !== undefined) {
			if (!(await gw.can(p, "model.provider.manage"))) throw forbid("管理渠道与凭据");
			db.run("INSERT INTO ops_settings (org_id, key, value, updated_by, updated_at) VALUES (?, 'personal_providers', ?, ?, ?) ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at", p.orgId, b.personalProviders ? "on" : "off", p.userId, now);
			audit(db, p.orgId, p.userId, "model.settings.personal_providers", p.orgId, { enabled: b.personalProviders }, { requestId: rid(c) });
		}
		if (b.defaultModel !== undefined) {
			if (!(await gw.can(p, "model.manage"))) throw forbid("管理平台模型");
			if (b.defaultModel === null) db.run("DELETE FROM ops_settings WHERE org_id = ? AND key = 'default_model'", p.orgId);
			else {
				const m = (await gw.listFor(p)).find((x) => x.ref.provider === b.defaultModel!.provider && x.ref.modelId === b.defaultModel!.modelId && x.status !== "fixture");
				if (!m || (m as any).personal) throw new HttpError(400, "unknown_model", "默认模型必须是本组织可用的、已启用的非个人模型");
				db.run("INSERT INTO ops_settings (org_id, key, value, updated_by, updated_at) VALUES (?, 'default_model', ?, ?, ?) ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at", p.orgId, JSON.stringify({ provider: b.defaultModel.provider, modelId: b.defaultModel.modelId }), p.userId, now);
			}
			audit(db, p.orgId, p.userId, "model.settings.default", p.orgId, { defaultModel: b.defaultModel }, { requestId: rid(c) });
		}
		return c.json({ personalProviders: gw.personalProvidersAllowed(p.orgId), defaultModel: gw.orgDefault(p.orgId) ?? null });
	});

	// ================================================================ per-request records
	api.get("/admin/route-attempts", async (c) => {
		const p = principalOf(c);
		if (!(await gw.can(p, "model.provider.manage")) && !(await gw.can(p, "model.manage"))) throw forbid("管理平台模型");
		const q = c.req.query();
		const where = ["(a.org_id = ? OR (a.org_id IS NULL AND a.channel_id IN (SELECT id FROM model_providers WHERE org_id = ?)))"];
		const params: (string | number)[] = [p.orgId, p.orgId];
		if (q.spaceId) where.push("a.space_id = ?"), params.push(q.spaceId);
		if (q.conversationId) where.push("a.conversation_id = ?"), params.push(Number(q.conversationId));
		if (q.requestKey) where.push("a.request_key = ?"), params.push(q.requestKey);
		if (q.status) where.push("a.status = ?"), params.push(q.status);
		if (q.channelId || q.providerId) where.push("a.channel_id = ?"), params.push((q.providerId ?? q.channelId)!);
		const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 2000);
		const rows = db.all<any>(`${ATTEMPT_SELECT} WHERE ${where.join(" AND ")} ORDER BY a.started_at DESC, a.attempt_no DESC LIMIT ${limit}`, ...params);
		return c.json({ attempts: rows.map(attemptDto) });
	});
	/** Route attempts of one conversation, for its participants (model shown ↔ actual provider, M15-A). */
	api.get("/conversations/:spaceId/:conversationId/routes", async (c) => {
		const p = principalOf(c);
		const spaceId = c.req.param("spaceId");
		const cid = Number(c.req.param("conversationId"));
		await id().require(p, "read", { kind: "conversation", id: String(cid), spaceId });
		const rows = db.all<any>(`${ATTEMPT_SELECT} WHERE a.space_id = ? AND a.conversation_id = ? ORDER BY a.started_at, a.attempt_no LIMIT 2000`, spaceId, cid);
		return c.json({ attempts: rows.map(attemptDto) });
	});
}
