// HTTP routes of experts (/api/experts…). Authorisation lives in Experts / Market (expert.create, expert.publish, unified market.review / market.manage).
import type { Hono } from "hono";
import type { AppContext, AppEnv } from "../core/contracts.ts";
import { jsonBody, principalOf } from "../core/http.ts";
import type { Experts } from "./experts.ts";

export function registerExpertRoutes(api: Hono<AppEnv>, ctx: AppContext): void {
	const ex = () => ctx.services.get("experts") as Experts;
	api.get("/experts", async (c) => c.json({ experts: await ex().list(principalOf(c), c.req.query()) }));
	api.get("/experts/mentionable", async (c) => c.json({ experts: await ex().mentionable(principalOf(c)) }));
	api.get("/experts/categories", (c) => c.json({ categories: ex().categories(principalOf(c)) }));
	api.post("/experts", async (c) => c.json({ expert: await ex().create(principalOf(c), await jsonBody(c)) }));
	api.get("/experts/:id", async (c) => c.json({ expert: await ex().get(principalOf(c), c.req.param("id")) }));
	api.patch("/experts/:id", async (c) => c.json({ expert: await ex().update(principalOf(c), c.req.param("id"), await jsonBody(c)) }));
	api.delete("/experts/:id", async (c) => {
		await ex().archive(principalOf(c), c.req.param("id"));
		return c.json({ ok: true });
	});
	api.post("/experts/:id/submit", async (c) => c.json({ submission: await ex().submit(principalOf(c), c.req.param("id"), await jsonBody(c)) }));
	api.post("/experts/:id/install", async (c) => {
		ex().install(principalOf(c), c.req.param("id"), true);
		return c.json({ expert: await ex().get(principalOf(c), c.req.param("id")) });
	});
	api.delete("/experts/:id/install", async (c) => {
		ex().install(principalOf(c), c.req.param("id"), false);
		return c.json({ expert: await ex().get(principalOf(c), c.req.param("id")) });
	});
	api.post("/experts/:id/unpublish", async (c) => c.json({ expert: await ex().unpublish(principalOf(c), c.req.param("id"), String((await jsonBody<{ reason?: string }>(c)).reason ?? "")) }));
	api.post("/experts/:id/republish", async (c) => c.json({ expert: await ex().republish(principalOf(c), c.req.param("id")) }));
	api.post("/experts/:id/force-publish", async (c) => {
		const b = await jsonBody<{ reason?: string; scope?: "department" | "org"; ref?: string }>(c);
		return c.json({ submission: await ex().forcePublish(principalOf(c), c.req.param("id"), String(b.reason ?? ""), { scope: b.scope, ref: b.ref }) });
	});
}
