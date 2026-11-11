// HTTP API for remote sandbox providers (group S). All under /api. Permission: `sandbox.policy.manage` (org) for provider configuration,
// the selection policy write, tests and the instance list; `project.manage` (on that project) for a project override. The policy READ is
// admin-only too (members learn what they need from GET /projects/:id/sandbox-provider).
import type { Hono } from "hono";
import type { AppContext, AppEnv } from "../../core/contracts.ts";
import { HttpError, jsonBody, principalOf } from "../../core/http.ts";
import type { SandboxInstanceDTO, SandboxProviderUpdate, SandboxSelectionPolicyDTO } from "../../../../shared/sandbox.ts";
import { providerConfigsFor, SandboxProviderConfigs } from "./provider-config.ts";

const STATES = new Set(["creating", "ready", "stopping", "destroyed", "lost", "error"]);

export function registerSandboxProviderRoutes(api: Hono<AppEnv>, ctx: AppContext): void {
	const svc = () => providerConfigsFor(ctx);

	api.get("/sandbox/providers", async (c) => c.json(await svc().list(principalOf(c))));
	api.put("/sandbox/providers/:provider", async (c) => {
		const p = principalOf(c);
		const dto = await svc().update(p, c.req.param("provider"), await jsonBody<SandboxProviderUpdate>(c));
		return c.json({ provider: dto });
	});
	api.post("/sandbox/providers/:provider/test", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ kind?: string }>(c).catch(() => ({}) as { kind?: string });
		return c.json({ test: await svc().test(p, c.req.param("provider"), (b.kind ?? "health") as "health" | "roundtrip") });
	});
	api.get("/sandbox/provider-policy", async (c) => c.json({ policy: await svc().policyFor(principalOf(c)) }));
	api.put("/sandbox/provider-policy", async (c) => c.json({ policy: await svc().setPolicy(principalOf(c), await jsonBody<Partial<SandboxSelectionPolicyDTO>>(c)) }));
	api.get("/projects/:projectId/sandbox-provider", async (c) => {
		const p = principalOf(c);
		await ctx.services.get("acl").require(p, "read", { kind: "project", id: c.req.param("projectId") }).catch((e) => {
			throw e instanceof HttpError && e.status === 403 ? new HttpError(404, "project_not_found", "项目不存在") : e;
		});
		return c.json(svc().projectChoice(p, c.req.param("projectId")));
	});
	api.put("/projects/:projectId/sandbox-provider", async (c) => {
		const b = await jsonBody<{ provider?: string | null }>(c);
		if (b.provider !== null && typeof b.provider !== "string") throw new HttpError(400, "invalid", "provider 必须是字符串或 null");
		return c.json(await svc().setProjectProvider(principalOf(c), c.req.param("projectId"), b.provider));
	});

	// Remote sandbox instances Workroom tracks (A1's table, queried defensively: absent table or columns never break the admin page).
	api.get("/sandbox/instances", async (c) => {
		const p = principalOf(c);
		await svc().requireManage(p);
		const identity = ctx.services.get("identity");
		const out: SandboxInstanceDTO[] = [];
		try {
			const rows = ctx.db.all<Record<string, unknown>>("SELECT * FROM tool_sandbox_instances ORDER BY rowid DESC LIMIT 500");
			for (const r of rows) {
				const spaceId = String(r.space_id ?? "");
				if (r.org_id !== undefined ? r.org_id !== p.orgId : identity.space(spaceId)?.orgId !== p.orgId) continue;
				const provider = String(r.provider ?? "");
				const state = String(r.state ?? "");
				if (!STATES.has(state)) continue;
				SandboxProviderConfigs.provider(provider);
				const s = (k: string) => (r[k] == null ? undefined : String(r[k]));
				out.push({ id: String(r.id), provider: provider as SandboxInstanceDTO["provider"], spaceId, workspaceKey: String(r.workspace_key ?? ""), remoteId: s("remote_id") ?? null, state: state as SandboxInstanceDTO["state"], createdAt: s("created_at") ?? "", lastUsedAt: s("last_used_at") ?? "", ...(s("expires_at") ? { expiresAt: s("expires_at")! } : {}), ...(s("last_error") ? { lastError: s("last_error")!.slice(0, 300) } : {}) });
			}
		} catch {
			/* table not present (adapters not installed): empty list */
		}
		return c.json({ instances: out.slice(0, 200) });
	});
}
