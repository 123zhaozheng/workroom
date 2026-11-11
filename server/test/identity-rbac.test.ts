// RBAC: catalog integrity, built-in roles, department-subtree scoping, custom roles, deny-beats-allow, privilege escalation,
// last-owner protection, explain output, tenant isolation, "no stale cache" and the orgRole -> role-assignment migration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { AppDb } from "../src/core/db.ts";
import { identityModule, type Identity } from "../src/identity/module.ts";
import { BUILTIN_ROLES, PERMISSIONS, PERMISSION_GROUPS, builtinRole } from "../../shared/permissions.ts";

type U = { token: string; me: any };
const authzOf = (t: TestApp) => (t.app.ctx.services.get("authz") as any) as import("../src/core/contracts.ts").AuthzService;
const identityOf = (t: TestApp) => t.app.ctx.services.get("identity") as Identity;
const principal = (t: TestApp, u: U) => identityOf(t).principalFor(u.me.userId, u.me.orgId) as Promise<import("../src/core/contracts.ts").Principal>;

/** Owner + one member per name (all plain 普通成员 via invite). */
async function org(t: TestApp, names: string[]) {
	const owner = await t.user("owner@a.example", { name: "Owner" });
	const users: Record<string, U> = {};
	for (const n of names) {
		const inv = await t.json("POST", "/api/admin/invites", { token: owner.token, json: { role: "member" } });
		users[n] = await t.user(`${n}@a.example`, { inviteCode: inv.invite.code, name: n });
	}
	return { owner, users };
}
const assign = (t: TestApp, by: U, userId: string, roleId: string, scope: any = { kind: "org" }, expect = 200) => t.json("POST", "/api/admin/role-assignments", { token: by.token, json: { subject: { kind: "user", id: userId }, roleId, scope }, expect });
const dept = async (t: TestApp, by: U, name: string, parentId?: string) => (await t.json("POST", "/api/admin/departments", { token: by.token, json: { name, parentId } })).department.id as string;
const setDeptMember = (t: TestApp, by: U, deptId: string, userId: string, role: "member" | "manager" | null = "member", expect = 200) => t.json("PUT", `/api/admin/departments/${deptId}/members`, { token: by.token, json: { userId, role }, expect });

test("catalog integrity: unique ids, groups, Chinese labels, valid scopes, role sets reference the catalog", () => {
	const ids = PERMISSIONS.map((p) => p.id);
	assert.equal(new Set(ids).size, ids.length, "permission ids are unique");
	const groups = new Set(PERMISSION_GROUPS.map((g) => g.id));
	assert.equal(groups.size, PERMISSION_GROUPS.length);
	for (const p of PERMISSIONS) {
		assert.match(p.id, /^[a-z]+(\.[a-z_]+)+$/, p.id);
		assert.ok(groups.has(p.group), `${p.id} has a known group`);
		assert.match(p.label, /[一-鿿]/, `${p.id} label is Chinese`);
		assert.match(p.description, /[一-鿿]/, `${p.id} description is Chinese`);
		assert.ok(p.scopes.includes("org"), `${p.id} applies at org scope`);
		for (const s of p.scopes) assert.ok(["org", "department", "project"].includes(s));
	}
	for (const g of PERMISSION_GROUPS) assert.ok(PERMISSIONS.some((p) => p.group === g.id), `group ${g.id} is not empty`);
	// Every area the product asks for exists.
	for (const need of ["member.disable", "skill.review", "model.provider.manage", "mcp.connector.review", "sandbox.network", "sandbox.browser", "automation.run_as_others", "share.external.create", "file.export", "kb.create.department", "stats.department.view", "audit.view", "trace.view", "budget.manage", "project.manage", "role.assign", "grant.manage"]) assert.ok(ids.includes(need), need);
	for (const r of BUILTIN_ROLES) for (const p of r.permissions) assert.ok(ids.includes(p), `${r.id} references unknown ${p}`);
	assert.equal(BUILTIN_ROLES.length, 8);
	assert.deepEqual([...builtinRole("builtin:owner")!.permissions].sort(), [...ids].sort(), "owner holds every permission");
	assert.deepEqual(BUILTIN_ROLES.map((r) => r.name), ["组织所有者", "组织管理员", "安全审计员", "计费管理员", "部门管理员", "技能审核员", "普通成员", "访客"]);
});

test("built-in roles: each role's effective permissions match its definition (incl. via /me/permissions and the API)", async () => {
	const t = await startTestApp();
	try {
		const { owner, users } = await org(t, ["admin", "auditor", "billing", "reviewer", "member", "guest"]);
		await assign(t, owner, users.admin!.me.userId, "builtin:admin");
		await assign(t, owner, users.guest!.me.userId, "builtin:guest");
		await assign(t, owner, users.auditor!.me.userId, "builtin:auditor");
		await assign(t, owner, users.billing!.me.userId, "builtin:billing");
		await assign(t, owner, users.reviewer!.me.userId, "builtin:skill_reviewer");
		const az = authzOf(t);
		const held = async (u: U) => {
			const p = await principal(t, u);
			const out = new Set<string>();
			for (const perm of PERMISSIONS) if (await az.has(p, perm.id)) out.add(perm.id);
			return out;
		};
		const expectSet = (...roles: string[]) => new Set(roles.flatMap((r) => builtinRole(r)!.permissions));
		assert.deepEqual(await held(owner), new Set(PERMISSIONS.map((p) => p.id)));
		assert.deepEqual(await held(users.admin!), expectSet("builtin:admin"));
		assert.equal((await held(users.admin!)).has("org.owner.manage"), false, "admin cannot manage owners");
		assert.deepEqual(await held(users.member!), expectSet("builtin:member"));
		assert.deepEqual(await held(users.guest!), expectSet("builtin:guest"));
		assert.deepEqual(await held(users.auditor!), expectSet("builtin:member", "builtin:auditor"));
		assert.deepEqual(await held(users.billing!), expectSet("builtin:member", "builtin:billing"));
		assert.deepEqual(await held(users.reviewer!), expectSet("builtin:member", "builtin:skill_reviewer"));
		// Guest: read-only — no sandbox, no external share, no export, no project/automation creation.
		const g = await held(users.guest!);
		for (const nope of ["sandbox.use", "sandbox.network", "sandbox.browser", "share.external.create", "file.export", "project.create", "automation.create", "skill.upload"]) assert.equal(g.has(nope), false, nope);
		for (const yes of ["model.use", "skill.use"]) assert.equal(g.has(yes), true, yes);
		// Auditor: read-only audit/trace/stats and nothing that mutates configuration.
		const a = await held(users.auditor!);
		for (const yes of ["audit.view", "audit.export", "trace.view", "stats.org.view", "stats.department.view", "stats.project.view"]) assert.equal(a.has(yes), true, yes);
		for (const nope of ["org.settings.manage", "member.disable", "role.manage", "role.assign", "budget.manage", "model.manage", "dept.manage"]) assert.equal(a.has(nope), false, nope);
		// HTTP surfaces agree.
		await t.json("GET", "/api/admin/audit", { token: users.auditor!.token });
		assert.equal((await t.req("GET", "/api/admin/audit.csv", { token: users.auditor!.token })).status, 200);
		await t.json("PATCH", "/api/org", { token: users.auditor!.token, json: { name: "x" }, expect: 403 });
		await t.json("POST", "/api/admin/invites", { token: users.auditor!.token, json: {}, expect: 403 });
		await t.json("GET", "/api/admin/audit", { token: users.billing!.token, expect: 403 });
		await t.json("GET", "/api/admin/audit", { token: users.member!.token, expect: 403 });
		await t.json("GET", "/api/admin/audit", { token: users.reviewer!.token, expect: 403 });
		// Guest cannot create projects or external share links; member can.
		await t.json("POST", "/api/projects", { token: users.guest!.token, json: { kind: "space", name: "g" }, expect: 403 });
		await t.json("POST", "/api/projects", { token: users.member!.token, json: { kind: "space", name: "m" } });
		// Admin keeps every legacy admin power.
		await t.json("PATCH", "/api/org", { token: users.admin!.token, json: { name: "Renamed" } });
		const mine = await t.json("GET", "/api/me/permissions", { token: users.guest!.token });
		assert.deepEqual(new Set(mine.access.effective.filter((e: any) => e.allow).map((e: any) => e.permission)), expectSet("builtin:guest"));
		const me = await t.json("GET", "/api/me", { token: users.billing!.token });
		assert.ok(me.me.permissions.includes("budget.manage"));
		assert.ok(me.me.permissionsAnywhere.includes("billing.view"));
		assert.equal(me.me.orgRole, "member", "compat orgRole stays member for non-owner/admin roles");
	} finally {
		await t.dispose();
	}
});

test("migration: existing orgs' orgRole values become built-in role assignments; legacy column writers stay in sync", async () => {
	const db = new AppDb(":memory:");
	const all = identityModule.migrations!;
	db.migrate("identity", all.filter((m) => m.version <= 3));
	const now = new Date().toISOString();
	db.run("INSERT INTO id_orgs (id, name, created_at) VALUES ('o1', 'Old', ?), ('o2', 'Other', ?)", now, now);
	for (const [u, org, role, removed] of [["u1", "o1", "owner", null], ["u2", "o1", "admin", null], ["u3", "o1", "member", null], ["u4", "o2", "owner", null], ["u5", "o1", "member", now]] as const) {
		db.run("INSERT OR IGNORE INTO id_users (id, email, name, created_at) VALUES (?, ?, ?, ?)", u, `${u}@x`, u, now);
		db.run("INSERT INTO id_org_members (org_id, user_id, role, created_at, removed_at) VALUES (?, ?, ?, ?, ?)", org, u, role, now, removed);
	}
	db.migrate("identity", all);
	const rows = db.all<any>("SELECT org_id, subject_id, role_id, scope_kind, subject_kind FROM id_role_assignments ORDER BY subject_id");
	assert.deepEqual(rows.map((r) => `${r.org_id}/${r.subject_id}/${r.role_id}/${r.scope_kind}/${r.subject_kind}`), ["o1/u1/builtin:owner/org/user", "o1/u2/builtin:admin/org/user", "o1/u3/builtin:member/org/user", "o2/u4/builtin:owner/org/user"], "removed members get nothing; every live member one base role");
	// Column writers (tests, other modules) keep assignments in step through triggers; re-adding after removal starts clean.
	db.run("UPDATE id_org_members SET role = 'admin' WHERE org_id = 'o1' AND user_id = 'u3'");
	assert.equal(db.get<any>("SELECT role_id FROM id_role_assignments WHERE subject_id = 'u3'")!.role_id, "builtin:admin");
	db.run("INSERT INTO id_role_assignments (id, org_id, subject_kind, subject_id, role_id, scope_kind, scope_id, created_at) VALUES ('x', 'o1', 'user', 'u3', 'builtin:auditor', 'org', '', ?)", now);
	db.run("UPDATE id_org_members SET removed_at = ? WHERE org_id = 'o1' AND user_id = 'u3'", now);
	assert.equal(db.get<any>("SELECT COUNT(*) AS n FROM id_role_assignments WHERE subject_id = 'u3'")!.n, 0, "removal drops every assignment");
	db.run("UPDATE id_org_members SET removed_at = NULL, role = 'member' WHERE org_id = 'o1' AND user_id = 'u3'");
	assert.deepEqual(db.all<any>("SELECT role_id FROM id_role_assignments WHERE subject_id = 'u3'").map((r) => r.role_id), ["builtin:member"], "re-join starts from the base role only (no stale elevation)");
	db.close();
});

test("department subtree scoping: a department admin manages only their subtree; no cross-department access", async () => {
	const t = await startTestApp();
	try {
		const { owner, users } = await org(t, ["da", "east", "west", "eng", "outsider"]);
		const sales = await dept(t, owner, "销售部");
		const east = await dept(t, owner, "华东", sales);
		const west = await dept(t, owner, "华西", sales);
		const eng = await dept(t, owner, "研发部");
		await setDeptMember(t, owner, east, users.east!.me.userId);
		await setDeptMember(t, owner, west, users.west!.me.userId);
		await setDeptMember(t, owner, eng, users.eng!.me.userId);
		await setDeptMember(t, owner, sales, users.da!.me.userId);
		await assign(t, owner, users.da!.me.userId, "builtin:dept_admin", { kind: "department", id: sales });
		const da = users.da!;
		const az = authzOf(t);
		const pda = await principal(t, da);
		// Scope arithmetic (sub-departments included, siblings and others excluded, org-level not granted).
		assert.equal(await az.has(pda, "dept.manage", { kind: "department", id: sales }), true);
		assert.equal(await az.has(pda, "dept.manage", { kind: "department", id: east }), true, "sub-department inherits");
		assert.equal(await az.has(pda, "dept.manage", { kind: "department", id: eng }), false);
		assert.equal(await az.has(pda, "dept.manage"), false, "no org-level department management");
		assert.equal(await az.has(pda, "member.disable"), false);
		// Member list is limited to the subtree.
		const names = (await t.json("GET", "/api/admin/members", { token: da.token })).members.map((m: any) => m.name).sort();
		assert.deepEqual(names, ["da", "east", "west"], "outsider/eng/owner are invisible");
		await t.json("GET", `/api/admin/departments/${eng}/members`, { token: da.token, expect: 403 });
		await t.json("GET", `/api/admin/departments/${east}/members`, { token: da.token });
		// Members: add/remove inside the subtree OK, other departments refused.
		await setDeptMember(t, da, east, users.outsider!.me.userId, "member");
		await setDeptMember(t, da, east, users.outsider!.me.userId, null);
		await setDeptMember(t, da, eng, users.outsider!.me.userId, "member", 403);
		await setDeptMember(t, da, eng, users.eng!.me.userId, null, 403);
		await setDeptMember(t, da, west, users.west!.me.userId, "manager");
		// Disable only people inside the subtree (and only when ALL their departments are inside it).
		await t.json("POST", `/api/admin/members/${users.eng!.me.userId}/disable`, { token: da.token, expect: 403 });
		await t.json("POST", `/api/admin/members/${users.outsider!.me.userId}/disable`, { token: da.token, expect: 403 });
		await setDeptMember(t, owner, eng, users.west!.me.userId, "member"); // west now also in 研发部 (outside da's subtree)
		await t.json("POST", `/api/admin/members/${users.west!.me.userId}/disable`, { token: da.token, expect: 403 });
		await setDeptMember(t, owner, eng, users.west!.me.userId, null);
		await t.json("POST", `/api/admin/members/${users.west!.me.userId}/disable`, { token: da.token });
		await t.json("POST", `/api/admin/members/${users.west!.me.userId}/enable`, { token: da.token });
		await t.json("DELETE", `/api/admin/members/${users.east!.me.userId}`, { token: da.token, expect: 403 }); // member.remove is org-level
		await t.json("POST", `/api/admin/members/${owner.me.userId}/disable`, { token: da.token, expect: 403 });
		// Department structure: create/rename inside, nothing outside, moves need both ends, delete needs the parent.
		const child = (await t.json("POST", "/api/admin/departments", { token: da.token, json: { name: "华南", parentId: sales } })).department.id;
		await t.json("POST", "/api/admin/departments", { token: da.token, json: { name: "x", parentId: eng }, expect: 403 });
		await t.json("POST", "/api/admin/departments", { token: da.token, json: { name: "顶级" }, expect: 403 });
		await t.json("PATCH", `/api/admin/departments/${east}`, { token: da.token, json: { name: "华东区" } });
		await t.json("PATCH", `/api/admin/departments/${eng}`, { token: da.token, json: { name: "hack" }, expect: 403 });
		await t.json("PATCH", `/api/admin/departments/${east}`, { token: da.token, json: { parentId: eng }, expect: 403 });
		await t.json("PATCH", `/api/admin/departments/${child}`, { token: da.token, json: { parentId: west } });
		await t.json("DELETE", `/api/admin/departments/${sales}`, { token: da.token, expect: 403 });
		await t.json("DELETE", `/api/admin/departments/${child}`, { token: da.token });
		// Invites only into the subtree.
		await t.json("POST", "/api/admin/invites", { token: da.token, json: { departmentId: east } });
		await t.json("POST", "/api/admin/invites", { token: da.token, json: { departmentId: eng }, expect: 403 });
		await t.json("POST", "/api/admin/invites", { token: da.token, json: {}, expect: 403 });
		assert.equal((await t.json("GET", "/api/admin/invites", { token: da.token })).invites.length, 1);
		// Org-wide surfaces stay closed.
		for (const p of ["/api/admin/sessions", "/api/admin/audit"]) await t.json("GET", p, { token: da.token, expect: 403 });
		await t.json("PATCH", "/api/org", { token: da.token, json: { name: "z" }, expect: 403 });
		// Every change above is in the audit log with the department admin as actor.
		const audit = await t.json("GET", `/api/admin/audit?actorUserId=${da.me.userId}&limit=500`, { token: owner.token });
		const acts = new Set(audit.items.map((a: any) => a.action));
		for (const a of ["department.create", "department.update", "department.move", "department.archive", "department.member.set", "member.disable", "member.enable", "grant.invite_create"]) assert.ok(acts.has(a), `audited: ${a}`);
		// Department heads (负责人) get view-only defaults for their department.
		await setDeptMember(t, owner, eng, users.eng!.me.userId, "manager");
		const peng = await principal(t, users.eng!);
		assert.equal(await az.has(peng, "stats.department.view", { kind: "department", id: eng }), true);
		assert.equal(await az.has(peng, "dept.manage", { kind: "department", id: eng }), false);
		assert.equal(await az.has(peng, "stats.department.view", { kind: "department", id: sales }), false);
	} finally {
		await t.dispose();
	}
});

test("custom roles: create, assign with scope, edit takes effect immediately, clone, delete removes assignments; built-ins are read-only", async () => {
	const t = await startTestApp();
	try {
		const { owner, users } = await org(t, ["u1", "u2", "viewer"]);
		const { role } = await t.json("POST", "/api/admin/roles", { token: owner.token, json: { name: "内部审计", description: "只看审计", permissions: ["audit.view"] } });
		assert.equal(role.builtin, false);
		await t.json("POST", "/api/admin/roles", { token: owner.token, json: { name: "内部审计", permissions: [] }, expect: 409 });
		await t.json("POST", "/api/admin/roles", { token: owner.token, json: { name: "坏角色", permissions: ["no.such"] }, expect: 400 });
		await t.json("POST", "/api/admin/roles", { token: owner.token, json: { name: "组织所有者", permissions: [] }, expect: 409 });
		await t.json("POST", "/api/admin/roles", { token: owner.token, json: { name: "偷权", permissions: ["org.owner.manage"] }, expect: 400 });
		const u1 = users.u1!;
		await t.json("GET", "/api/admin/audit", { token: u1.token, expect: 403 });
		const a = await assign(t, owner, u1.me.userId, role.id);
		await assign(t, owner, u1.me.userId, role.id, { kind: "org" }, 409);
		await t.json("GET", "/api/admin/audit", { token: u1.token });
		assert.equal((await t.req("GET", "/api/admin/audit.csv", { token: u1.token })).status, 403);
		// Edit: add export, remove view — immediate effect on the next request (no cache).
		await t.json("PATCH", `/api/admin/roles/${role.id}`, { token: owner.token, json: { permissions: ["audit.export"] } });
		await t.json("GET", "/api/admin/audit", { token: u1.token, expect: 403 });
		assert.equal((await t.req("GET", "/api/admin/audit.csv", { token: u1.token })).status, 200);
		// Built-ins cannot be edited or deleted; clone produces an editable copy.
		await t.json("PATCH", "/api/admin/roles/builtin:auditor", { token: owner.token, json: { permissions: [] }, expect: 403 });
		await t.json("DELETE", "/api/admin/roles/builtin:admin", { token: owner.token, expect: 403 });
		const { role: clone } = await t.json("POST", "/api/admin/roles/builtin:auditor/clone", { token: owner.token, json: {} });
		assert.equal(clone.builtin, false);
		assert.deepEqual([...clone.permissions].sort(), [...builtinRole("builtin:auditor")!.permissions].sort());
		assert.match(clone.name, /安全审计员/);
		// Scoped assignment: only inside one department.
		const d = await dept(t, owner, "法务部");
		const d2 = await dept(t, owner, "财务部");
		await setDeptMember(t, owner, d, users.u2!.me.userId);
		const { role: scoped } = await t.json("POST", "/api/admin/roles", { token: owner.token, json: { name: "部门看板", permissions: ["stats.department.view", "kb.create.department"] } });
		await assign(t, owner, users.u2!.me.userId, scoped.id, { kind: "department", id: d });
		const az = authzOf(t);
		const p2 = await principal(t, users.u2!);
		assert.equal(await az.has(p2, "stats.department.view", { kind: "department", id: d }), true);
		assert.equal(await az.has(p2, "stats.department.view", { kind: "department", id: d2 }), false);
		assert.equal(await az.has(p2, "stats.department.view"), false);
		await assign(t, owner, users.u2!.me.userId, scoped.id, { kind: "department", id: "dep_nope" }, 404);
		await assign(t, owner, users.u2!.me.userId, "builtin:dept_admin", { kind: "org" }, 400);
		// Delete a role: assignments disappear with it.
		const del = await t.json("DELETE", `/api/admin/roles/${role.id}`, { token: owner.token });
		assert.equal(del.removedAssignments, 1);
		assert.equal((await t.req("GET", "/api/admin/audit.csv", { token: u1.token })).status, 403);
		assert.equal((await t.json("GET", "/api/admin/roles", { token: owner.token })).roles.some((r: any) => r.id === role.id), false);
		await t.json("DELETE", `/api/admin/role-assignments/${a.assignment.id}`, { token: owner.token, expect: 404 });
		// All of it was audited.
		const audit = await t.json("GET", "/api/admin/audit?category=grant&limit=200", { token: owner.token });
		const acts = new Set(audit.items.map((x: any) => x.action));
		for (const x of ["role.create", "role.update", "role.clone", "role.delete", "grant.role_assign"]) assert.ok(acts.has(x), x);
	} finally {
		await t.dispose();
	}
});

test("deny beats allow; direct grants/denies are scoped, audited, explained and never lock out an owner", async () => {
	const t = await startTestApp();
	try {
		const { owner, users } = await org(t, ["admin2", "plain"]);
		await assign(t, owner, users.admin2!.me.userId, "builtin:admin");
		const az = authzOf(t);
		const adm = users.admin2!;
		await t.json("GET", "/api/admin/audit", { token: adm.token });
		// Deny audit.view to an admin that holds it through 组织管理员.
		const g = await t.json("PUT", `/api/admin/members/${adm.me.userId}/grants`, { token: owner.token, json: { permission: "audit.view", effect: "deny", reason: "离岗审查" } });
		await t.json("GET", "/api/admin/audit", { token: adm.token, expect: 403 });
		const ex = await az.explain(await principal(t, adm), "audit.view");
		assert.equal(ex.allow, false);
		assert.deepEqual(new Set(ex.because.map((b) => `${b.source}:${b.effect}`)), new Set(["user_deny:deny", "role:allow"]));
		assert.match(ex.because.find((b) => b.source === "user_deny")!.detail, /离岗审查/);
		assert.match(ex.because.find((b) => b.source === "role")!.detail, /组织管理员/);
		// HTTP explain for managers + access view lists the deny.
		const viaHttp = await t.json("GET", `/api/admin/members/${adm.me.userId}/explain?permission=audit.view`, { token: owner.token });
		assert.equal(viaHttp.allow, false);
		const access = await t.json("GET", `/api/admin/members/${adm.me.userId}/access`, { token: owner.token });
		assert.equal(access.access.grants[0].effect, "deny");
		assert.equal(access.access.effective.find((e: any) => e.permission === "audit.view").allow, false);
		// Remove the deny: allowed again immediately.
		await t.json("DELETE", `/api/admin/members/${adm.me.userId}/grants/${g.grant.id}`, { token: owner.token });
		await t.json("GET", "/api/admin/audit", { token: adm.token });
		// A direct allow gives a plain member a permission; a scoped deny only bites in its scope.
		const plain = users.plain!;
		await t.json("GET", "/api/admin/audit", { token: plain.token, expect: 403 });
		await t.json("PUT", `/api/admin/members/${plain.me.userId}/grants`, { token: owner.token, json: { permission: "audit.view", effect: "allow" } });
		await t.json("GET", "/api/admin/audit", { token: plain.token });
		const d1 = await dept(t, owner, "A部");
		const d2 = await dept(t, owner, "B部");
		await t.json("PUT", `/api/admin/members/${plain.me.userId}/grants`, { token: owner.token, json: { permission: "stats.department.view", effect: "allow" } });
		await t.json("PUT", `/api/admin/members/${plain.me.userId}/grants`, { token: owner.token, json: { permission: "stats.department.view", effect: "deny", scope: { kind: "department", id: d2 } } });
		const pp = await principal(t, plain);
		assert.equal(await az.has(pp, "stats.department.view", { kind: "department", id: d1 }), true);
		assert.equal(await az.has(pp, "stats.department.view", { kind: "department", id: d2 }), false, "scoped deny beats the org-wide allow inside its scope");
		assert.equal(await az.has(pp, "stats.department.view"), true);
		// Invalid grants.
		await t.json("PUT", `/api/admin/members/${plain.me.userId}/grants`, { token: owner.token, json: { permission: "nope.x", effect: "allow" }, expect: 400 });
		await t.json("PUT", `/api/admin/members/${plain.me.userId}/grants`, { token: owner.token, json: { permission: "model.provider.manage", effect: "allow", scope: { kind: "department", id: d1 } }, expect: 400 });
		// The owner rule: denies/grants on an owner are refused and an owner's access is unaffected.
		await t.json("PUT", `/api/admin/members/${owner.me.userId}/grants`, { token: owner.token, json: { permission: "audit.view", effect: "deny" }, expect: 400 });
		const second = await org2Owner(t, owner);
		await t.json("PUT", `/api/admin/members/${owner.me.userId}/grants`, { token: second.token, json: { permission: "audit.view", effect: "deny" }, expect: 400 });
		// Even a deny written straight into the table cannot lock an owner out.
		t.app.ctx.db.run("INSERT INTO id_user_grants (id, org_id, user_id, permission, effect, scope_kind, scope_id, created_at) VALUES ('ug_raw', ?, ?, 'audit.view', 'deny', 'org', '', ?)", owner.me.orgId, owner.me.userId, new Date().toISOString());
		assert.equal(await az.has(await principal(t, owner), "audit.view"), true);
		await t.json("GET", "/api/admin/audit", { token: owner.token });
		const log = await t.json("GET", "/api/admin/audit?action=grant.user_*", { token: owner.token });
		assert.ok(log.items.length >= 5);
		assert.ok(log.items.every((i: any) => i.category === "grant"));
	} finally {
		await t.dispose();
	}
});

async function org2Owner(t: TestApp, owner: U): Promise<U> {
	const inv = await t.json("POST", "/api/admin/invites", { token: owner.token, json: { role: "owner" } });
	return t.user("second-owner@a.example", { inviteCode: inv.invite.code, name: "Second" });
}

test("no privilege escalation: nobody grants, assigns, invites or edits roles beyond what they hold", async () => {
	const t = await startTestApp();
	try {
		const { owner, users } = await org(t, ["admin", "da", "mgr", "victim", "peer"]);
		await assign(t, owner, users.admin!.me.userId, "builtin:admin");
		const d = await dept(t, owner, "运营部");
		for (const n of ["da", "victim"]) await setDeptMember(t, owner, d, users[n]!.me.userId);
		await assign(t, owner, users.da!.me.userId, "builtin:dept_admin", { kind: "department", id: d });
		// 组织管理员: cannot make owners, cannot touch the owner, cannot write org.owner.manage into a role.
		await t.json("PATCH", `/api/admin/members/${users.peer!.me.userId}`, { token: users.admin!.token, json: { role: "owner" }, expect: 403 });
		await assign(t, users.admin!, users.peer!.me.userId, "builtin:owner", { kind: "org" }, 403);
		await t.json("PATCH", `/api/admin/members/${owner.me.userId}`, { token: users.admin!.token, json: { role: "member" }, expect: 403 });
		await t.json("POST", `/api/admin/members/${owner.me.userId}/disable`, { token: users.admin!.token, expect: 403 });
		await t.json("DELETE", `/api/admin/members/${owner.me.userId}`, { token: users.admin!.token, expect: 403 });
		await t.json("POST", "/api/admin/invites", { token: users.admin!.token, json: { role: "owner" }, expect: 403 });
		await t.json("POST", "/api/admin/roles", { token: users.admin!.token, json: { name: "x", permissions: ["org.owner.manage"] }, expect: 400 });
		// 部门管理员 cannot hand out permissions they lack (auditor / admin / billing roles; direct grants need grant.manage).
		const da = users.da!;
		await assign(t, da, users.victim!.me.userId, "builtin:auditor", { kind: "department", id: d }, 400); // auditor is org-scope only
		await assign(t, da, users.victim!.me.userId, "builtin:skill_reviewer", { kind: "department", id: d }, 403); // holds skill.review but NOT skill.marketplace.manage
		const { role: ok } = await t.json("POST", "/api/admin/roles", { token: owner.token, json: { name: "部门技能审核", permissions: ["skill.review", "kb.publish"] } });
		await assign(t, da, users.victim!.me.userId, ok.id, { kind: "department", id: d });
		const { role: big } = await t.json("POST", "/api/admin/roles", { token: owner.token, json: { name: "大权限", permissions: ["skill.review", "audit.view"] } });
		const r = await assign(t, da, users.victim!.me.userId, big.id, { kind: "department", id: d }, 403);
		assert.equal(r.error?.code ?? r.code, "privilege_escalation");
		await assign(t, da, users.victim!.me.userId, ok.id, { kind: "org" }, 403); // no org-level authority
		await assign(t, da, users.peer!.me.userId, ok.id, { kind: "department", id: d }, 403); // peer is outside the subtree
		await t.json("PUT", `/api/admin/members/${users.victim!.me.userId}/grants`, { token: da.token, json: { permission: "model.use", effect: "deny" }, expect: 403 });
		await t.json("POST", "/api/admin/roles", { token: da.token, json: { name: "da-role", permissions: ["model.use"] }, expect: 403 });
		await t.json("POST", "/api/admin/invites", { token: da.token, json: { departmentId: d, role: "admin" }, expect: 403 });
		await t.json("POST", "/api/admin/invites", { token: da.token, json: { departmentId: d, role: "member" } });
		// A department admin cannot revoke a superior role from someone, nor demote / disable an admin who happens to be in the department.
		await setDeptMember(t, owner, d, users.admin!.me.userId);
		await t.json("PATCH", `/api/admin/members/${users.admin!.me.userId}`, { token: da.token, json: { role: "member" }, expect: 403 });
		await t.json("POST", `/api/admin/members/${users.admin!.me.userId}/disable`, { token: da.token, expect: 403 });
		// Custom role with role.manage but lacking trace.view cannot mint a role containing trace.view.
		const { role: mgrRole } = await t.json("POST", "/api/admin/roles", { token: owner.token, json: { name: "角色管理员", permissions: ["role.manage", "role.view", "role.assign"] } });
		await assign(t, owner, users.mgr!.me.userId, mgrRole.id);
		const e = await t.json("POST", "/api/admin/roles", { token: users.mgr!.token, json: { name: "越权", permissions: ["trace.view"] }, expect: 403 });
		assert.equal(e.error?.code ?? e.code, "privilege_escalation");
		await t.json("POST", "/api/admin/roles", { token: users.mgr!.token, json: { name: "合规", permissions: ["role.view"] } });
		await assign(t, users.mgr!, users.peer!.me.userId, "builtin:admin", { kind: "org" }, 403);
		// Editing a role you do not fully hold is refused too.
		await t.json("PATCH", `/api/admin/roles/${big.id}`, { token: users.mgr!.token, json: { description: "x" }, expect: 403 });
		// Department roles inherited via department membership: a dept admin cannot add people to a department whose roles exceed theirs.
		const d3 = await dept(t, owner, "特殊部");
		await t.json("POST", "/api/admin/role-assignments", { token: owner.token, json: { subject: { kind: "department", id: d3 }, roleId: "builtin:auditor", scope: { kind: "org" } } });
		await assign(t, owner, users.da!.me.userId, "builtin:dept_admin", { kind: "department", id: d3 });
		await setDeptMember(t, da, d3, users.victim!.me.userId, "member", 403);
		// Unauthenticated / member callers get nothing from admin APIs.
		await t.json("GET", "/api/admin/role-assignments", { token: users.peer!.token, expect: 403 });
		await t.json("POST", "/api/admin/role-assignments", { token: users.peer!.token, json: { subject: { kind: "user", id: users.peer!.me.userId }, roleId: "builtin:admin" }, expect: 403 });
	} finally {
		await t.dispose();
	}
});

test("last owner cannot be removed, disabled or demoted; ownership transfer through a second owner", async () => {
	const t = await startTestApp();
	try {
		const { owner, users } = await org(t, ["m"]);
		const az = authzOf(t);
		await t.json("PATCH", `/api/admin/members/${owner.me.userId}`, { token: owner.token, json: { role: "admin" }, expect: 409 });
		await t.json("PATCH", `/api/admin/members/${owner.me.userId}`, { token: owner.token, json: { role: "guest" }, expect: 409 });
		await t.json("POST", `/api/admin/members/${owner.me.userId}/disable`, { token: owner.token, expect: 400 });
		await t.json("DELETE", `/api/admin/members/${owner.me.userId}`, { token: owner.token, expect: 400 });
		const baseId = t.app.ctx.db.get<any>("SELECT id FROM id_role_assignments WHERE subject_id = ? AND role_id = 'builtin:owner'", owner.me.userId).id;
		await t.json("DELETE", `/api/admin/role-assignments/${baseId}`, { token: owner.token, expect: 400 });
		await assign(t, owner, owner.me.userId, "builtin:member", { kind: "org" }, 409);
		assert.equal(await az.has(await principal(t, owner), "org.owner.manage"), true);
		// Promote m to owner, then the first owner can step down, and the new sole owner is protected in turn.
		await assign(t, owner, users.m!.me.userId, "builtin:owner");
		assert.equal((await t.json("GET", "/api/me", { token: users.m!.token })).me.orgRole, "owner");
		await t.json("PATCH", `/api/admin/members/${owner.me.userId}`, { token: owner.token, json: { role: "admin" } });
		assert.equal((await t.json("GET", "/api/me", { token: owner.token })).me.orgRole, "admin");
		await t.json("PATCH", `/api/admin/members/${users.m!.me.userId}`, { token: users.m!.token, json: { role: "member" }, expect: 409 });
		await t.json("POST", `/api/admin/members/${users.m!.me.userId}/disable`, { token: owner.token, expect: 403 }); // former owner (now admin) cannot touch the owner
		// A disabled owner does not count as active: with two owners, one disabled, the other is the last.
		await t.json("PATCH", `/api/admin/members/${owner.me.userId}`, { token: users.m!.token, json: { role: "owner" } });
		await t.json("POST", `/api/admin/members/${owner.me.userId}/disable`, { token: users.m!.token });
		await t.json("PATCH", `/api/admin/members/${users.m!.me.userId}`, { token: users.m!.token, json: { role: "admin" }, expect: 409 });
	} finally {
		await t.dispose();
	}
});

test("explain: reports role + scope, department inheritance, group/department subjects, defaults and the owner rule", async () => {
	const t = await startTestApp();
	try {
		const { owner, users } = await org(t, ["a", "b", "c"]);
		const az = authzOf(t);
		const top = await dept(t, owner, "总部");
		const sub = await dept(t, owner, "分部", top);
		await setDeptMember(t, owner, sub, users.a!.me.userId);
		await assign(t, owner, users.a!.me.userId, "builtin:dept_admin", { kind: "department", id: top });
		const pa = await principal(t, users.a!);
		const ex = await az.explain(pa, "dept.manage", { kind: "department", id: sub });
		assert.equal(ex.allow, true);
		assert.equal(ex.because[0]!.source, "role");
		assert.match(ex.because[0]!.detail, /部门管理员/);
		assert.match(ex.because[0]!.detail, /总部/);
		assert.match(ex.because[0]!.detail, /继承自上级部门/);
		const none = await az.explain(pa, "model.provider.manage");
		assert.equal(none.allow, false);
		assert.equal(none.because[0]!.source, "default");
		assert.equal((await az.explain(await principal(t, owner), "model.provider.manage")).because[0]!.source, "owner");
		assert.equal((await az.explain(pa, "does.not.exist")).allow, false);
		// Role granted to a department subject / a user group reaches members (and sub-department members) and says why.
		await t.json("POST", "/api/admin/role-assignments", { token: owner.token, json: { subject: { kind: "department", id: top }, roleId: "builtin:skill_reviewer", scope: { kind: "org" } } });
		const pa2 = await az.explain(pa, "skill.review");
		assert.equal(pa2.allow, true);
		assert.match(pa2.because.map((b) => b.detail).join("|"), /经部门「分部」获得|经部门「总部」获得/);
		const { group } = await t.json("POST", "/api/admin/groups", { token: owner.token, json: { name: "报表组" } });
		await t.json("PUT", `/api/admin/groups/${group.id}/members`, { token: owner.token, json: { userId: users.b!.me.userId, member: true } });
		await t.json("POST", "/api/admin/role-assignments", { token: owner.token, json: { subject: { kind: "group", id: group.id }, roleId: "builtin:billing", scope: { kind: "org" } } });
		const exb = await az.explain(await principal(t, users.b!), "budget.manage");
		assert.equal(exb.allow, true);
		assert.match(exb.because[0]!.detail, /经用户组「报表组」获得/);
		assert.equal(await az.has(await principal(t, users.c!), "budget.manage"), false);
		await t.json("PUT", `/api/admin/groups/${group.id}/members`, { token: owner.token, json: { userId: users.b!.me.userId, member: false } });
		assert.equal(await az.has(await principal(t, users.b!), "budget.manage"), false, "leaving the group revokes immediately");
		// Per-permission explanation through the HTTP API for the member detail page.
		const http = await t.json("GET", `/api/admin/members/${users.a!.me.userId}/explain?permission=member.invite&scopeKind=department&scopeId=${sub}`, { token: owner.token });
		assert.equal(http.allow, true);
		const access = await t.json("GET", `/api/admin/members/${users.a!.me.userId}/access`, { token: owner.token });
		assert.ok(access.access.assignments.some((x: any) => x.roleId === "builtin:dept_admin" && x.via === "direct"));
		assert.ok(access.access.assignments.some((x: any) => x.roleId === "builtin:skill_reviewer" && x.via === "department"));
		assert.equal(access.access.scoped.length >= 1, true);
		assert.equal(access.access.departments[0].path, "总部 / 分部");
	} finally {
		await t.dispose();
	}
});

test("always current: revocation, disable, removal and department moves apply on the very next call (no cache)", async () => {
	const t = await startTestApp();
	try {
		const { owner, users } = await org(t, ["r", "x"]);
		const az = authzOf(t);
		const a = await assign(t, owner, users.r!.me.userId, "builtin:auditor");
		const pr = await principal(t, users.r!);
		assert.equal(await az.has(pr, "audit.view"), true);
		await t.json("DELETE", `/api/admin/role-assignments/${a.assignment.id}`, { token: owner.token });
		assert.equal(await az.has(pr, "audit.view"), false, "same Principal object, state re-read");
		await assign(t, owner, users.r!.me.userId, "builtin:auditor");
		assert.equal(await az.has(pr, "audit.view"), true);
		await t.json("POST", `/api/admin/members/${users.r!.me.userId}/disable`, { token: owner.token });
		assert.equal(await az.has(pr, "audit.view"), false);
		await assert.rejects(() => az.require(pr, "audit.view"), (e: any) => e.status === 401);
		await t.json("POST", `/api/admin/members/${users.r!.me.userId}/enable`, { token: owner.token });
		// Dept admin loses powers the moment the department scope moves out of their subtree / the department is deleted.
		const p1 = await dept(t, owner, "P1");
		const p2 = await dept(t, owner, "P2");
		const kid = await dept(t, owner, "Kid", p1);
		await assign(t, owner, users.x!.me.userId, "builtin:dept_admin", { kind: "department", id: p1 });
		const px = await principal(t, users.x!);
		assert.equal(await az.has(px, "dept.manage", { kind: "department", id: kid }), true);
		await t.json("PATCH", `/api/admin/departments/${kid}`, { token: owner.token, json: { parentId: p2 } });
		assert.equal(await az.has(px, "dept.manage", { kind: "department", id: kid }), false);
		await t.json("DELETE", `/api/admin/departments/${p1}`, { token: owner.token });
		assert.equal(await az.has(px, "dept.manage", { kind: "department", id: p1 }), false, "archived department scope is gone");
		assert.equal(t.app.ctx.db.get<any>("SELECT COUNT(*) AS n FROM id_role_assignments WHERE scope_id = ?", p1).n, 0, "its assignments were removed");
		// Removing a member drops their roles; re-inviting starts from the base role only.
		await assign(t, owner, users.x!.me.userId, "builtin:auditor");
		await t.json("DELETE", `/api/admin/members/${users.x!.me.userId}`, { token: owner.token });
		assert.equal(await az.has(px, "audit.view"), false);
		assert.equal(t.app.ctx.db.get<any>("SELECT COUNT(*) AS n FROM id_role_assignments WHERE subject_id = ?", users.x!.me.userId).n, 0);
		// A raw write of the legacy column (what older code / tests do) is mirrored into assignments.
		t.app.ctx.db.run("UPDATE id_org_members SET role = 'admin' WHERE org_id = ? AND user_id = ?", owner.me.orgId, users.r!.me.userId);
		assert.equal(await az.has(await principal(t, users.r!), "member.disable"), true);
	} finally {
		await t.dispose();
	}
});

test("invites carry roles; guests; accepted roles apply with the invite's scope; legacy role PATCH still works", async () => {
	const t = await startTestApp();
	try {
		const { owner } = await org(t, []);
		const az = authzOf(t);
		const d = await dept(t, owner, "客服部");
		const inv = await t.json("POST", "/api/admin/invites", { token: owner.token, json: { role: "guest" } });
		const guest = await t.user("g@a.example", { inviteCode: inv.invite.code });
		assert.equal(guest.me.orgRole, "member");
		assert.equal(await az.has(await principal(t, guest), "sandbox.use"), false);
		assert.equal(guest.me.baseRole, "builtin:guest");
		const { role } = await t.json("POST", "/api/admin/roles", { token: owner.token, json: { name: "客服审阅", permissions: ["stats.department.view"] } });
		const inv2 = await t.json("POST", "/api/admin/invites", { token: owner.token, json: { role: "member", roleId: role.id, departmentId: d } });
		const m = await t.user("cs@a.example", { inviteCode: inv2.invite.code });
		const pm = await principal(t, m);
		assert.equal(await az.has(pm, "stats.department.view", { kind: "department", id: d }), true);
		assert.equal(await az.has(pm, "stats.department.view"), false, "invite role applies only inside the invite's department");
		// Legacy PATCH {role} switches base role and keeps orgRole/permissions in step.
		await t.json("PATCH", `/api/admin/members/${m.me.userId}`, { token: owner.token, json: { role: "admin" } });
		assert.equal((await t.json("GET", "/api/me", { token: m.token })).me.orgRole, "admin");
		await t.json("PATCH", `/api/admin/members/${m.me.userId}`, { token: owner.token, json: { role: "guest" } });
		const me = (await t.json("GET", "/api/me", { token: m.token })).me;
		assert.equal(me.orgRole, "member");
		assert.equal(me.baseRole, "builtin:guest");
		await t.json("PATCH", `/api/admin/members/${m.me.userId}`, { token: owner.token, json: { role: "boss" }, expect: 400 });
	} finally {
		await t.dispose();
	}
});

test("cross-tenant: roles, assignments, grants, groups and scopes never cross organisations", async () => {
	const t = await startTestApp();
	try {
		const a = await org(t, ["am"]);
		const bOwner = await t.user("owner@b.example", { name: "B Owner" });
		const bInv = await t.json("POST", "/api/admin/invites", { token: bOwner.token, json: {} });
		const bm = await t.user("bm@b.example", { inviteCode: bInv.invite.code, name: "BM" });
		const az = authzOf(t);
		const aDept = await dept(t, a.owner, "A部");
		const aProject = (await t.json("POST", "/api/projects", { token: a.owner.token, json: { kind: "space", name: "A项目" } })).project.id as string;
		const { role: aRole } = await t.json("POST", "/api/admin/roles", { token: a.owner.token, json: { name: "A角色", permissions: ["audit.view"] } });
		const { group: aGroup } = await t.json("POST", "/api/admin/groups", { token: a.owner.token, json: { name: "A组" } });
		// B's owner cannot see or use A's role / department / project / group / users.
		assert.equal((await t.json("GET", "/api/admin/roles", { token: bOwner.token })).roles.some((r: any) => r.id === aRole.id), false);
		await assign(t, bOwner, bm.me.userId, aRole.id, { kind: "org" }, 404);
		await assign(t, bOwner, bm.me.userId, "builtin:billing", { kind: "department", id: aDept }, 404);
		await assign(t, bOwner, bm.me.userId, "builtin:skill_reviewer", { kind: "department", id: aDept }, 404);
		await assign(t, bOwner, bm.me.userId, aRole.id, { kind: "project", id: aProject }, 404);
		await assign(t, bOwner, a.users.am!.me.userId, "builtin:admin", { kind: "org" }, 404);
		await t.json("POST", "/api/admin/role-assignments", { token: bOwner.token, json: { subject: { kind: "group", id: aGroup.id }, roleId: "builtin:billing", scope: { kind: "org" } }, expect: 404 });
		await t.json("PUT", `/api/admin/members/${a.users.am!.me.userId}/grants`, { token: bOwner.token, json: { permission: "model.use", effect: "deny" }, expect: 404 });
		await t.json("GET", `/api/admin/members/${a.users.am!.me.userId}/access`, { token: bOwner.token, expect: 404 });
		await t.json("PUT", `/api/admin/groups/${aGroup.id}/members`, { token: bOwner.token, json: { userId: bm.me.userId, member: true }, expect: 404 });
		await t.json("PATCH", `/api/admin/roles/${aRole.id}`, { token: bOwner.token, json: { permissions: [] }, expect: 404 });
		await t.json("DELETE", `/api/admin/roles/${aRole.id}`, { token: bOwner.token, expect: 404 });
		await t.json("PATCH", `/api/admin/departments/${aDept}`, { token: bOwner.token, json: { name: "x" }, expect: 404 });
		await t.json("PUT", `/api/admin/departments/${aDept}/members`, { token: bOwner.token, json: { userId: bm.me.userId, role: "member" }, expect: 404 });
		// Service level: a scope belonging to another org is invalid, whatever the caller's roles.
		const pbo = await principal(t, bOwner);
		assert.equal((await az.explain(pbo, "dept.manage", { kind: "department", id: aDept })).allow, false);
		assert.equal((await az.explain(pbo, "project.manage", { kind: "project", id: aProject })).allow, false);
		// Roles assigned in A do not leak into B for a user who belongs to both orgs.
		const inv = await t.json("POST", "/api/admin/invites", { token: bOwner.token, json: {} });
		await t.json("POST", "/api/auth/accept-invite", { token: a.users.am!.token, json: { inviteCode: inv.invite.code } });
		await assign(t, a.owner, a.users.am!.me.userId, "builtin:admin");
		const amInB = await t.json("POST", "/api/auth/switch-org", { token: a.users.am!.token, json: { orgId: bOwner.me.orgId } });
		await t.json("GET", "/api/admin/audit", { token: amInB.token, expect: 403 });
		const pAmB = await identityOf(t).principalFor(a.users.am!.me.userId, bOwner.me.orgId);
		assert.equal(await az.has(pAmB!, "member.disable"), false);
		assert.equal(await az.has((await identityOf(t).principalFor(a.users.am!.me.userId, a.owner.me.orgId))!, "member.disable"), true);
	} finally {
		await t.dispose();
	}
});
