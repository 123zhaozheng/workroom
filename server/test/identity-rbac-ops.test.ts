// RBAC route policy over ops admin routes: the right built-in role reaches exactly the routes its permissions cover, nothing more.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "./helpers/app.ts";

test("ops admin routes are gated by permission, not by owner/admin role: 计费管理员 budgets, 安全审计员 trace, member nothing", async () => {
	const t = await startTestApp();
	try {
		const owner = await t.user("owner@ops.example", { name: "Owner" });
		const mk = async (name: string, roleId?: string) => {
			const inv = await t.json("POST", "/api/admin/invites", { token: owner.token, json: { role: "member" } });
			const u = await t.user(`${name}@ops.example`, { inviteCode: inv.invite.code, name });
			if (roleId) await t.json("POST", "/api/admin/role-assignments", { token: owner.token, json: { subject: { kind: "user", id: u.me.userId }, roleId, scope: { kind: "org" } } });
			return u;
		};
		const billing = await mk("billing", "builtin:billing");
		const auditor = await mk("auditor", "builtin:auditor");
		const reviewer = await mk("reviewer", "builtin:reviewer");
		const admin = await mk("admin", "builtin:admin");
		const member = await mk("member");
		const budget = { scope: { kind: "org", id: "" }, period: "month", limitCost: 10, action: "warn" };
		// budgets: budget.manage
		const b = await t.json("POST", "/api/admin/budgets", { token: billing.token, json: budget });
		await t.json("PATCH", `/api/admin/budgets/${b.budget.id}`, { token: billing.token, json: { enabled: false } });
		for (const u of [auditor, reviewer, member]) await t.json("POST", "/api/admin/budgets", { token: u.token, json: budget, expect: 403 });
		await t.json("POST", "/api/admin/budgets", { token: admin.token, json: budget });
		await t.json("DELETE", `/api/admin/budgets/${b.budget.id}`, { token: billing.token });
		// trace: trace.view (auditor yes, billing no)
		assert.equal((await t.req("GET", "/api/admin/trace?q=nothing", { token: auditor.token })).status, 200);
		assert.equal((await t.req("GET", "/api/admin/trace?q=nothing", { token: admin.token })).status, 200);
		for (const u of [billing, reviewer, member]) assert.equal((await t.req("GET", "/api/admin/trace?q=nothing", { token: u.token })).status, 403);
		// usage maintenance: reconcile = billing.view; rebuild = org.settings.manage
		assert.notEqual((await t.req("GET", "/api/admin/usage/reconcile?spaceId=x", { token: billing.token })).status, 403);
		assert.equal((await t.req("GET", "/api/admin/usage/reconcile?spaceId=x", { token: auditor.token })).status, 403);
		assert.equal((await t.req("POST", "/api/admin/usage/rebuild", { token: billing.token, json: { spaceId: "x" } })).status, 403);
		// webhook allowlist: org.security.manage (admin yes, billing no)
		assert.equal((await t.req("GET", "/api/admin/settings/webhook-allowlist", { token: billing.token })).status, 403);
		assert.notEqual((await t.req("GET", "/api/admin/settings/webhook-allowlist", { token: admin.token })).status, 403);
		// unauthenticated stays 401 on every gated route
		assert.equal((await t.req("GET", "/api/admin/trace?q=x")).status, 401);
		// a custom role with just budget.manage works the same way (policy is permission based)
		const { role } = await t.json("POST", "/api/admin/roles", { token: owner.token, json: { name: "预算助理", permissions: ["budget.manage"] } });
		const asst = await mk("asst", role.id);
		await t.json("POST", "/api/admin/budgets", { token: asst.token, json: budget });
		assert.equal((await t.req("GET", "/api/admin/trace?q=x", { token: asst.token })).status, 403);
		// and removing the grant closes it again immediately
		const list = await t.json("GET", `/api/admin/role-assignments?roleId=${role.id}`, { token: owner.token });
		await t.json("DELETE", `/api/admin/role-assignments/${list.assignments[0].id}`, { token: owner.token });
		await t.json("POST", "/api/admin/budgets", { token: asst.token, json: budget, expect: 403 });
		// the acl "org admin" check used by other modules maps to org.settings.manage
		const acl = t.app.ctx.services.get("acl");
		const id = t.app.ctx.services.get("identity");
		const dec = async (u: any) => (await acl.check((await id.principalFor(u.me.userId, u.me.orgId))!, "admin", { kind: "org", id: u.me.orgId })).allow;
		assert.equal(await dec(owner), true);
		assert.equal(await dec(admin), true);
		assert.equal(await dec(billing), false);
		assert.equal(await dec(auditor), false);
		assert.equal(await dec(member), false);
	} finally {
		await t.dispose();
	}
});
