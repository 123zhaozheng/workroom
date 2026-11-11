// HTTP API of the persistent workspace (round 7b, group P). All under /api. Space ACL: read for status/versions, write for save/restore;
// the org policy needs `sandbox.policy.manage`. A space of another org answers 404; a space the caller cannot access answers 403.
import type { Hono } from "hono";
import type { AppContext, AppEnv, Principal, Space } from "../../core/contracts.ts";
import { HttpError, jsonBody, principalOf } from "../../core/http.ts";
import type { WorkspacePersistPolicyDTO } from "../../../../shared/workspace-safety.ts";
import { DEFAULT_PERSIST_POLICY, workspacePersistenceFor } from "./persist.ts";

export function registerPersistRoutes(api: Hono<AppEnv>, ctx: AppContext): void {
	const svc = () => workspacePersistenceFor(ctx);
	const spaceOf = (p: Principal, spaceId: string): Space => {
		const s = ctx.services.get("identity").space(spaceId);
		if (!s || s.orgId !== p.orgId) throw new HttpError(404, "space_not_found", "空间不存在");
		return s;
	};
	const base = "/workspaces/:spaceId/:workspaceKey";

	api.get(`${base}/status`, async (c) => {
		const p = principalOf(c);
		return c.json({ status: await svc().status(p, spaceOf(p, c.req.param("spaceId")), c.req.param("workspaceKey")) });
	});

	api.post(`${base}/save`, async (c) => {
		const p = principalOf(c);
		const space = spaceOf(p, c.req.param("spaceId"));
		const r = await svc().commit(p, space, c.req.param("workspaceKey"), "manual");
		if (r.ok) return c.json({ saved: { created: r.created, version: r.version, notes: r.notes }, status: r.status });
		const conflict = r.status.state === "conflict";
		return c.json({ error: { code: conflict ? "workspace_conflict" : "workspace_save_failed", message: r.status.failure ?? "保存失败" }, status: r.status }, conflict ? 409 : 422);
	});

	api.get(`${base}/versions`, async (c) => {
		const p = principalOf(c);
		return c.json({ versions: await svc().versions(p, spaceOf(p, c.req.param("spaceId")), c.req.param("workspaceKey")) });
	});

	api.get(`${base}/versions/:version`, async (c) => {
		const p = principalOf(c);
		const v = Number(c.req.param("version"));
		if (!Number.isInteger(v)) throw new HttpError(400, "invalid", "version 必须是整数");
		return c.json({ version: v, manifest: await svc().manifest(p, spaceOf(p, c.req.param("spaceId")), c.req.param("workspaceKey"), v) });
	});

	api.post(`${base}/restore`, async (c) => {
		const p = principalOf(c);
		const space = spaceOf(p, c.req.param("spaceId"));
		const b = await jsonBody<{ version?: unknown; force?: unknown }>(c).catch(() => ({}) as { version?: unknown; force?: unknown });
		if (b.version !== undefined && (typeof b.version !== "number" || !Number.isInteger(b.version))) throw new HttpError(400, "invalid", "version 必须是整数");
		if (b.force !== undefined && b.force !== "keep-both") throw new HttpError(400, "invalid", 'force 只能是 "keep-both"');
		const r = await svc().restore(p, space, c.req.param("workspaceKey"), { ...(b.version !== undefined ? { version: b.version as number } : {}), ...(b.force ? { force: "keep-both" as const } : {}) });
		return c.json({ restored: { fromVersion: r.fromVersion, verified: r.verified, ...(r.keptAsVersion !== undefined ? { keptAsVersion: r.keptAsVersion } : {}) }, status: r.status });
	});

	api.get("/workspace-policy", async (c) => {
		const policy = await svc().getPolicy(principalOf(c));
		return c.json({ policy, defaults: DEFAULT_PERSIST_POLICY });
	});
	api.put("/workspace-policy", async (c) => c.json({ policy: await svc().setPolicy(principalOf(c), await jsonBody<Partial<WorkspacePersistPolicyDTO>>(c)) }));
}
