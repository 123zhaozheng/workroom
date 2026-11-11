// HTTP API for sandbox environment variables (group V). All under /api/sandbox-env.
//   GET    /sandbox-env/effective?spaceId=&conversationId=   -> { effective: EffectiveEnvDTO }
//   GET    /sandbox-env/:scope/:scopeRef                     -> { vars: EnvVarDTO[], appliesToNewCommandsOnly: true }
//   PUT    /sandbox-env/:scope/:scopeRef/:name  {value, locked?} -> { var, appliesToNewCommandsOnly: true }
//   DELETE /sandbox-env/:scope/:scopeRef/:name               -> { ok: true, appliesToNewCommandsOnly: true }
// scopeRef: org id / project id / user id / "<spaceId>:<conversationId>" (URL-encode the colon).
import type { Hono } from "hono";
import type { AppContext, AppEnv } from "../../core/contracts.ts";
import { HttpError, jsonBody, principalOf } from "../../core/http.ts";
import { sandboxEnvFor } from "./env-vars.ts";

export function registerSandboxEnvRoutes(api: Hono<AppEnv>, ctx: AppContext): void {
	const svc = () => sandboxEnvFor(ctx);

	api.get("/sandbox-env/effective", async (c) => {
		const spaceId = c.req.query("spaceId");
		if (!spaceId) throw new HttpError(400, "invalid", "缺少 spaceId");
		return c.json({ effective: await svc().effectiveFor(principalOf(c), spaceId, c.req.query("conversationId") || undefined) });
	});
	api.get("/sandbox-env/:scope/:scopeRef", async (c) => c.json({ vars: await svc().list(principalOf(c), c.req.param("scope"), c.req.param("scopeRef")), appliesToNewCommandsOnly: true }));
	api.put("/sandbox-env/:scope/:scopeRef/:name", async (c) => {
		const b = await jsonBody<{ value?: unknown; locked?: unknown }>(c);
		const v = await svc().set(principalOf(c), c.req.param("scope"), c.req.param("scopeRef"), c.req.param("name"), b);
		return c.json({ var: v, appliesToNewCommandsOnly: true });
	});
	api.delete("/sandbox-env/:scope/:scopeRef/:name", async (c) => {
		await svc().delete(principalOf(c), c.req.param("scope"), c.req.param("scopeRef"), c.req.param("name"));
		return c.json({ ok: true, appliesToNewCommandsOnly: true });
	});
}
