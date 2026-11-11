// Round 8 (Q2): HTTP API of a conversation's execution environment. All under /api.
//   GET  /conversations/:spaceId/:conversationId/environment          → ConversationEnvironmentDTO  (space read; never creates/connects anything)
//   POST /conversations/:spaceId/:conversationId/environment/prepare  → ConversationEnvironmentDTO  (space write + sandbox.use; remote only; explicit retry; optional body { trigger: "explicit" })
// A space of another organisation answers 404; a space the caller cannot access answers 403.
import type { Hono } from "hono";
import type { AppContext, AppEnv, Principal, Space } from "../../core/contracts.ts";
import { HttpError, principalOf } from "../../core/http.ts";
import { environmentsFor } from "./environment.ts";
import { withLocal } from "../localexec/env.ts"; // round 11 (R4): adds `local` to the environment DTO

export function registerEnvironmentRoutes(api: Hono<AppEnv>, ctx: AppContext): void {
	const base = "/conversations/:spaceId/:conversationId/environment";
	const spaceOf = (p: Principal, spaceId: string): Space => {
		const s = ctx.services.get("identity").space(spaceId);
		if (!s || s.orgId !== p.orgId) throw new HttpError(404, "space_not_found", "空间不存在");
		return s;
	};
	// "new" = the home composer before a conversation exists: same environment, state "none" (conversation ids start at 1, so key c0 never has a sandbox).
	const convOf = (raw: string): number => {
		if (raw === "new") return 0;
		const n = Number(raw);
		if (!Number.isInteger(n) || n < 0) throw new HttpError(400, "invalid", "会话 id 无效");
		return n;
	};

	api.get(base, async (c) => {
		const p = principalOf(c);
		const space = spaceOf(p, c.req.param("spaceId"));
		await ctx.services.get("acl").require(p, "read", { kind: "space", id: space.id });
		return c.json(withLocal(ctx, p, space.id, convOf(c.req.param("conversationId")), await environmentsFor(ctx).get(p, space, convOf(c.req.param("conversationId")))));
	});

	api.post(`${base}/prepare`, async (c) => {
		const p = principalOf(c);
		const space = spaceOf(p, c.req.param("spaceId"));
		await ctx.services.get("acl").require(p, "write", { kind: "space", id: space.id });
		// Optional body { trigger: "explicit" } (the UI button). "prewarm" is server-internal only: a client cannot claim it.
		const body = (await c.req.json().catch(() => ({}))) as { trigger?: unknown } | null;
		if (body?.trigger !== undefined && body.trigger !== "explicit") throw new HttpError(400, "invalid", "trigger 只能是 explicit");
		return c.json(withLocal(ctx, p, space.id, convOf(c.req.param("conversationId")), await environmentsFor(ctx).prepare(p, space, convOf(c.req.param("conversationId")), undefined, { trigger: "explicit" })));
	});
}
