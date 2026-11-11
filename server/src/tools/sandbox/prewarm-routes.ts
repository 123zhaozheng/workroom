// Round 11 (R2b): admin API of the intent-based sandbox prewarm. Permission: sandbox.policy.manage (same as the provider configuration).
//   GET /sandbox/prewarm        → { settings }   (organisation-level: enabled, threshold)
//   PUT /sandbox/prewarm        → { settings }   body { enabled?, threshold? }
//   GET /sandbox/prewarm/stats  → { stats }      ?days=30  precision / recall style counts from the prewarm log (R6 tuning)
import type { Hono } from "hono";
import type { AppContext, AppEnv } from "../../core/contracts.ts";
import { jsonBody, principalOf } from "../../core/http.ts";
import { prewarmFor } from "./prewarm.ts";

export function registerPrewarmRoutes(api: Hono<AppEnv>, ctx: AppContext): void {
	api.get("/sandbox/prewarm", async (c) => c.json({ settings: await prewarmFor(ctx).readSettings(principalOf(c)) }));
	api.put("/sandbox/prewarm", async (c) => c.json({ settings: await prewarmFor(ctx).updateSettings(principalOf(c), await jsonBody<{ enabled?: unknown; threshold?: unknown }>(c)) }));
	api.get("/sandbox/prewarm/stats", async (c) => {
		const p = principalOf(c);
		await prewarmFor(ctx).readSettings(p); // permission check
		const days = Math.min(365, Math.max(1, Number(c.req.query("days")) || 30));
		return c.json({ stats: prewarmFor(ctx).stats(p.orgId, new Date(Date.now() - days * 24 * 3600_000).toISOString()) });
	});
}
