// Round-4 integration: RBAC call-site conversions in runtime (trace status, org assistants, automation run-as-other)
// and knowledge (KB creation per scope, govern), plus the admin-console derivation shared with the web (isOrgAdmin).
process.env.WORKROOM_AUTOMATION_TICK_MS = "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { hasAdminConsoleAccess } from "../../shared/permissions.ts";

type U = { token: string; me: any };

async function setup() {
	const t = await startTestApp();
	const owner = await t.user("owner@int.example", { name: "Owner" });
	const mk = async (name: string, roleId?: string, scope: any = { kind: "org" }) => {
		const inv = await t.json("POST", "/api/admin/invites", { token: owner.token, json: { role: "member" } });
		const u = await t.user(`${name}@int.example`, { inviteCode: inv.invite.code, name });
		if (roleId) await t.json("POST", "/api/admin/role-assignments", { token: owner.token, json: { subject: { kind: "user", id: u.me.userId }, roleId, scope } });
		return u;
	};
	const dept = async (name: string, parentId?: string) => (await t.json("POST", "/api/admin/departments", { token: owner.token, json: { name, parentId } })).department.id as string;
	return { t, owner, mk, dept };
}
const principalOf = async (t: TestApp, u: U) => (await t.app.ctx.services.get("identity").principalFor(u.me.userId, u.me.orgId))!;

test("/runtime/status needs trace.view: 安全审计员 yes, ordinary member no, 计费管理员 no", async () => {
	const { t, owner, mk } = await setup();
	try {
		const auditor = await mk("auditor", "builtin:auditor");
		const billing = await mk("billing", "builtin:billing");
		const member = await mk("member");
		assert.equal((await t.req("GET", "/api/runtime/status", { token: auditor.token })).status, 200);
		assert.equal((await t.req("GET", "/api/runtime/status", { token: owner.token })).status, 200);
		assert.equal((await t.req("GET", "/api/runtime/status", { token: member.token })).status, 403);
		assert.equal((await t.req("GET", "/api/runtime/status", { token: billing.token })).status, 403);
		// a direct deny closes it again at once (deny beats allow)
		await t.json("PUT", `/api/admin/members/${auditor.me.userId}/grants`, { token: owner.token, json: { permission: "trace.view", effect: "deny", scope: { kind: "org" } } });
		assert.equal((await t.req("GET", "/api/runtime/status", { token: auditor.token })).status, 403);
	} finally {
		await t.dispose();
	}
});

test("org assistants need assistant.publish.org (a custom role, not orgRole); personal assistants stay open to members", async () => {
	const { t, owner, mk } = await setup();
	try {
		const { role } = await t.json("POST", "/api/admin/roles", { token: owner.token, json: { name: "助手发布员", permissions: ["assistant.publish.org"] } });
		const publisher = await mk("publisher", role.id);
		const member = await mk("member");
		const body = { name: "企业客服", description: "d", scope: "org" };
		await t.json("POST", "/api/assistants", { token: member.token, json: body, expect: 403 });
		await t.json("POST", "/api/assistants", { token: member.token, json: { ...body, scope: "personal", name: "我的" } });
		const a = await t.json("POST", "/api/assistants", { token: publisher.token, json: body });
		const id = (a.assistant ?? a).id as string;
		await t.json("PATCH", `/api/assistants/${id}`, { token: member.token, json: { description: "x" }, expect: 403 });
		await t.json("PATCH", `/api/assistants/${id}`, { token: publisher.token, json: { description: "y" } });
		await t.json("DELETE", `/api/assistants/${id}`, { token: member.token, expect: 403 });
		await t.json("DELETE", `/api/assistants/${id}`, { token: publisher.token });
	} finally {
		await t.dispose();
	}
});

test("automation run-as-other: an input claiming another owner's automation needs automation.run_as_others", async () => {
	const { t, owner, mk } = await setup();
	try {
		const alice = await mk("alice");
		const bob = await mk("bob");
		const runner = await mk("runner", (await t.json("POST", "/api/admin/roles", { token: owner.token, json: { name: "代运行", permissions: ["automation.run_as_others"] } })).role.id);
		const { automation } = await t.json("POST", "/api/automations", { token: alice.token, json: { name: "日报", prompt: "[[reply ok]]", trigger: { kind: "cron", expr: "0 9 * * *" }, timezone: "UTC", enabled: false } });
		const rt = t.app.ctx.services.get("runtime");
		const chat = async (u: U) => (await t.json("POST", "/api/conversations", { token: u.token, json: {} })).conversation as { spaceId: string; conversationId: number };
		const submit = async (u: U, c: { spaceId: string; conversationId: number }, automationId: string, rid: string) =>
			rt.submitInput(await principalOf(t, u), c.spaceId, c.conversationId, { text: "run", userId: u.me.userId, orgId: u.me.orgId, via: { kind: "automation", automationId, runId: "r1" }, requestId: rid }, BACKGROUND_CONTEXT);
		// the owner acts as herself: fine
		await submit(alice, await chat(alice), automation.id, "own-1");
		// bob claims alice's automation: refused, and a made-up automation id is refused too
		await assert.rejects(submit(bob, await chat(bob), automation.id, "bob-1"), (e: any) => e.status === 403);
		await assert.rejects(submit(bob, await chat(bob), "auto_nope", "bob-2"), (e: any) => e.status === 403);
		// a holder of the permission may run it as someone else; so may the org owner
		await submit(runner, await chat(runner), automation.id, "run-1");
		await submit(owner, await chat(owner), automation.id, "own-2");
	} finally {
		await t.dispose();
	}
});

test("KB creation per scope: department-scoped kb.create.department creates there only; org KB needs kb.create.org; personal needs kb.create.personal", async () => {
	const { t, owner, mk, dept } = await setup();
	try {
		const sales = await dept("销售");
		const east = await dept("华东", sales);
		const eng = await dept("研发");
		const { role } = await t.json("POST", "/api/admin/roles", { token: owner.token, json: { name: "部门知识库创建者", permissions: ["kb.create.department"], scopes: ["department"] } });
		const dk = await mk("dk", role.id, { kind: "department", id: sales });
		await t.json("PUT", `/api/admin/departments/${sales}/members`, { token: owner.token, json: { userId: dk.me.userId, role: "member" } });
		const post = (u: U, json: any, expect = 200) => t.json("POST", "/api/kb", { token: u.token, json, expect });
		// in their department (and its sub-department): allowed; the creator can read and administer what they made
		const k1 = await post(dk, { name: "销售库", scope: "department", departmentId: sales });
		assert.equal(k1.kb.permissions.admin, true);
		await post(dk, { name: "华东库", scope: "department", departmentId: east });
		// other department and org-wide are refused
		await post(dk, { name: "研发库", scope: "department", departmentId: eng }, 403);
		await post(dk, { name: "企业库", scope: "org" }, 403);
		// a plain member holds neither
		const member = await mk("member");
		await t.json("PUT", `/api/admin/departments/${sales}/members`, { token: owner.token, json: { userId: member.me.userId, role: "member" } });
		await post(member, { name: "x", scope: "department", departmentId: sales }, 403);
		await post(member, { name: "x", scope: "org" }, 403);
		await post(member, { name: "我的", scope: "personal" });
		// the 访客 base role has no kb.create.personal
		const guest = await mk("guest");
		await t.json("POST", "/api/admin/role-assignments", { token: owner.token, json: { subject: { kind: "user", id: guest.me.userId }, roleId: "builtin:guest", scope: { kind: "org" } } });
		await post(guest, { name: "g", scope: "personal" }, 403);
		// an org-wide kb.create.org holder can create enterprise KBs; owner can do everything
		const orgRole = (await t.json("POST", "/api/admin/roles", { token: owner.token, json: { name: "企业库创建者", permissions: ["kb.create.org"] } })).role.id;
		const kbo = await mk("kbo", orgRole);
		const ek = await post(kbo, { name: "企业库", scope: "org" });
		await post(owner, { name: "研发库", scope: "department", departmentId: eng });
		// kb.govern decides who may administer someone else's KB: not the plain member, yes the org-wide governor
		await t.json("PATCH", `/api/kb/${ek.kb.id}`, { token: member.token, json: { name: "hack" }, expect: 403 });
		const gov = await mk("gov", (await t.json("POST", "/api/admin/roles", { token: owner.token, json: { name: "知识治理员", permissions: ["kb.govern"] } })).role.id);
		await t.json("PATCH", `/api/kb/${ek.kb.id}`, { token: gov.token, json: { name: "改名" } });
		// a department-scoped governor governs that department's KBs, not other departments'
		const dGov = await mk("dgov", "builtin:dept_admin", { kind: "department", id: sales });
		await t.json("PUT", `/api/admin/departments/${sales}/members`, { token: owner.token, json: { userId: dGov.me.userId, role: "member" } });
		await t.json("PATCH", `/api/kb/${k1.kb.id}`, { token: dGov.token, json: { name: "销售库2" } });
		await t.json("PATCH", `/api/kb/${ek.kb.id}`, { token: dGov.token, json: { name: "hack" }, expect: 403 });
	} finally {
		await t.dispose();
	}
});

test("admin console derivation (web isOrgAdmin): auditor and billing admin get 组织管理, ordinary member and guest do not", async () => {
	const { t, owner, mk } = await setup();
	try {
		const perms = async (u: U) => (await t.json("GET", "/api/me", { token: u.token })).me.permissionsAnywhere as string[];
		const auditor = await mk("auditor", "builtin:auditor");
		const billing = await mk("billing", "builtin:billing");
		const member = await mk("member");
		const guest = await mk("guest", "builtin:guest");
		assert.equal(hasAdminConsoleAccess(await perms(auditor)), true);
		assert.equal(hasAdminConsoleAccess(await perms(billing)), true);
		assert.equal(hasAdminConsoleAccess(await perms(owner)), true);
		assert.equal(hasAdminConsoleAccess(await perms(member)), false);
		assert.equal(hasAdminConsoleAccess(await perms(guest)), false);
		assert.equal(hasAdminConsoleAccess(undefined), false);
		assert.equal(hasAdminConsoleAccess([]), false);
	} finally {
		await t.dispose();
	}
});
