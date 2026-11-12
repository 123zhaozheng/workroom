// Harness 检视 routes: the org switch, and read access to captured rounds of a conversation (docs/harness-inspect.md).
import type { Hono } from "hono";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AppContext, AppEnv, Principal } from "../core/contracts.ts";
import { HttpError, jsonBody, principalOf } from "../core/http.ts";
import { audit } from "../identity/module.ts";
import type { HarnessInspectStatus, HarnessRoundResponse, HarnessRoundsResponse } from "../../../shared/harness-inspect.ts";
import type { HarnessInspect } from "./harness-inspect.ts";

type RuntimeAccess = { access(p: Principal, action: "read", spaceId: string, conversationId: number, context: typeof BACKGROUND_CONTEXT): Promise<unknown> };

export function registerHarnessInspectRoutes(api: Hono<AppEnv>, ctx: AppContext, hi: HarnessInspect): void {
	const authz = () => ctx.services.get("authz");

	const status = async (p: Principal): Promise<HarnessInspectStatus> => ({
		enabled: hi.enabled(p.orgId),
		canInspect: await authz().has(p, "harness.inspect"),
		canManage: await authz().has(p, "org.security.manage"),
		retentionDays: hi.limits.retentionDays,
		maxRoundsPerConversation: hi.limits.maxRoundsPerConversation,
	});

	/** Permission first, then the switch, then the viewer's own access to the conversation (which also enforces the org boundary). */
	const gate = async (p: Principal, spaceId: string, rawId: string) => {
		await authz().require(p, "harness.inspect");
		const conversationId = Number(rawId);
		if (!Number.isInteger(conversationId) || conversationId <= 0) throw new HttpError(400, "invalid_id", "会话 id 无效");
		if (!hi.enabled(p.orgId)) return undefined;
		await (ctx.services.get("runtime") as unknown as RuntimeAccess).access(p, "read", spaceId, conversationId, BACKGROUND_CONTEXT);
		return conversationId;
	};

	api.get("/harness-inspect/status", async (c) => c.json(await status(principalOf(c))));

	api.put("/admin/settings/harness-inspect", async (c) => {
		const p = principalOf(c);
		await authz().require(p, "org.security.manage");
		const b = await jsonBody<{ enabled?: unknown }>(c);
		if (typeof b.enabled !== "boolean") throw new HttpError(400, "invalid", "enabled 需为布尔值");
		const before = hi.enabled(p.orgId);
		hi.setEnabled(p.orgId, p.userId, b.enabled);
		if (before !== b.enabled) audit(ctx.db, p.orgId, p.userId, "settings.harness_inspect", p.orgId, { enabled: b.enabled }, { requestId: c.get("requestId"), category: "security" });
		return c.json(await status(p));
	});

	api.get("/conversations/:spaceId/:id/harness/rounds", async (c) => {
		const p = principalOf(c);
		const spaceId = c.req.param("spaceId");
		const conversationId = await gate(p, spaceId, c.req.param("id"));
		if (conversationId === undefined) return c.json({ enabled: false, rounds: [], builds: [] } satisfies HarnessRoundsResponse);
		const num = (k: string) => {
			const n = Number(c.req.query(k));
			return c.req.query(k) !== undefined && Number.isFinite(n) ? n : undefined;
		};
		const rounds = hi.list(p.orgId, spaceId, conversationId, { from: num("from"), to: num("to"), limit: num("limit") });
		const runIds = [...new Set(rounds.map((r) => r.runId))];
		return c.json({ enabled: true, rounds, builds: hi.builds(p.orgId, spaceId, conversationId, runIds) } satisfies HarnessRoundsResponse);
	});

	api.get("/conversations/:spaceId/:id/harness/rounds/:roundId", async (c) => {
		const p = principalOf(c);
		const spaceId = c.req.param("spaceId");
		const conversationId = await gate(p, spaceId, c.req.param("id"));
		if (conversationId === undefined) throw new HttpError(404, "harness_inspect_disabled", "Harness 检视未开启");
		const round = hi.get(p.orgId, spaceId, conversationId, c.req.param("roundId"));
		if (!round) throw new HttpError(404, "not_found", "记录不存在或已被清理");
		return c.json({ round } satisfies HarnessRoundResponse);
	});
}
