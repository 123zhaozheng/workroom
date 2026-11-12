// Round 11 (R6): HTTP API of the sandbox lifecycle statistics. All under /api.
//   GET /stats/sandbox?from&to&provider                           -> SandboxStatsDTO
//       Permission: the same as the organisation scope of the stats page (stats.org.view; without the RBAC service: org admin / owner).
//       Conversation titles only where the viewer may read the conversation. Cost is included (the viewer may see organisation cost anyway).
//   GET /conversations/:spaceId/:conversationId/sandbox-stats     -> SandboxConversationStatsResponse
//       Permission: read on the conversation. Counts and times of THIS conversation only. `costUsd` is null unless the viewer may view organisation
//       statistics (cost depends on the organisation's price setting, which is organisation-level information).
//   GET|PUT /sandbox/prices                                       -> { prices }   USD per provider-hour (sandbox.policy.manage)
import type { Hono } from "hono";
import type { AppContext, AppEnv, Principal } from "../../core/contracts.ts";
import { HttpError, principalOf } from "../../core/http.ts";
import type { SandboxConversationStatsResponse, SandboxPricesDTO, SandboxStatsDTO } from "../../../../shared/sandbox-stats.ts";
import { conversationSandboxStats, parseProvider, parseRange, readPrices, sandboxStats, writePrices } from "./lifecycle-stats.ts";
import { providerConfigsFor } from "./provider-config.ts";

/** The organisation scope of the stats page decides; a harness without the stats service falls back to the sandbox admin permission. */
async function canViewOrgStats(ctx: AppContext, p: Principal): Promise<boolean> {
	if (ctx.services.has("stats")) {
		try {
			const svc = ctx.services.get("stats") as { scopes(p: Principal): Promise<{ scopes: { kind: string }[] }> };
			return (await svc.scopes(p)).scopes.some((s) => s.kind === "org");
		} catch {
			return false;
		}
	}
	return providerConfigsFor(ctx).canManage(p);
}

export function registerSandboxStatsRoutes(api: Hono<AppEnv>, ctx: AppContext): void {
	api.get("/stats/sandbox", async (c) => {
		const p = principalOf(c);
		if (!(await canViewOrgStats(ctx, p))) throw new HttpError(403, "forbidden", "没有权限：查看组织统计（stats.org.view）。请联系组织管理员。");
		const { from, to } = parseRange(c.req.query("from"), c.req.query("to"));
		const provider = parseProvider(c.req.query("provider"));
		const stats: SandboxStatsDTO = await sandboxStats(ctx, p.orgId, {
			from,
			to,
			provider,
			titleOf: async (spaceId, conversationId) => {
				const space = ctx.services.get("identity").space(spaceId);
				if (!space || space.orgId !== p.orgId) return null;
				const d = await ctx.services.get("acl").check(p, "read", { kind: "conversation", id: String(conversationId), spaceId }).catch(() => ({ allow: false }));
				if (!d.allow) return null;
				return ctx.db.get<{ title: string }>("SELECT title FROM rt_conversations WHERE space_id = ? AND conversation_id = ?", spaceId, conversationId)?.title ?? `对话 #${conversationId}`;
			},
		});
		return c.json(stats);
	});

	api.get("/conversations/:spaceId/:conversationId/sandbox-stats", async (c) => {
		const p = principalOf(c);
		const spaceId = c.req.param("spaceId");
		const space = ctx.services.get("identity").space(spaceId);
		if (!space || space.orgId !== p.orgId) throw new HttpError(404, "space_not_found", "空间不存在");
		const conversationId = Number(c.req.param("conversationId"));
		if (!Number.isInteger(conversationId) || conversationId < 1) throw new HttpError(400, "invalid", "会话 id 无效");
		await ctx.services.get("acl").require(p, "read", { kind: "conversation", id: String(conversationId), spaceId });
		if (!ctx.db.get("SELECT 1 AS x FROM rt_conversations WHERE space_id = ? AND conversation_id = ?", spaceId, conversationId)) throw new HttpError(404, "conversation_not_found", "会话不存在");
		const costVisible = await canViewOrgStats(ctx, p);
		const r = conversationSandboxStats(ctx, p.orgId, spaceId, conversationId, costVisible);
		const body: SandboxConversationStatsResponse = { spaceId, conversationId, stats: r.stats, costVisible };
		return c.json(body);
	});

	api.get("/sandbox/prices", async (c) => {
		const p = principalOf(c);
		await providerConfigsFor(ctx).requireManage(p);
		const body: SandboxPricesDTO = { prices: readPrices(ctx, p.orgId) };
		return c.json(body);
	});
	api.put("/sandbox/prices", async (c) => {
		const p = principalOf(c);
		await providerConfigsFor(ctx).requireManage(p);
		const body = await c.req.json().catch(() => null);
		const out: SandboxPricesDTO = { prices: writePrices(ctx, p, body) };
		return c.json(out);
	});
}
