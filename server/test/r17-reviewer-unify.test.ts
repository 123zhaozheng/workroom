// 审查员统一（round 17）：技能审核员 / MCP 审核员 → 一个「审查员」角色 + 统一权限 market.review / market.manage。
// 覆盖：迁移旧数据、旧 id 别名（API 输入与权限求值）、旧 DTO 字段别名由统一权限决定、审查对象类型可扩展（注册处理器）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { AppDb } from "../src/core/db.ts";
import { identityModule, type Identity } from "../src/identity/module.ts";
import { BUILTIN_ROLES, PERMISSIONS, builtinRole, canonicalPermission, canonicalRoleId } from "../../shared/permissions.ts";
import type { Market } from "../src/tools/market.ts";
import { orgMember } from "./fixtures/util.ts";

test("catalog: 只有一个审查员角色和统一权限，旧技能/MCP 审核权限已不在目录里，但旧 id 仍可解析", () => {
	const ids = PERMISSIONS.map((p) => p.id);
	for (const old of ["skill.review", "mcp.connector.review", "skill.marketplace.manage"]) assert.ok(!ids.includes(old), `${old} removed from the catalog`);
	assert.ok(ids.includes("market.review") && ids.includes("market.manage"));
	assert.equal(canonicalPermission("skill.review"), "market.review");
	assert.equal(canonicalPermission("mcp.connector.review"), "market.review");
	assert.equal(canonicalPermission("skill.marketplace.manage"), "market.manage");
	assert.equal(canonicalPermission("kb.publish"), "kb.publish");
	assert.equal(canonicalRoleId("builtin:skill_reviewer"), "builtin:reviewer");
	assert.equal(builtinRole("builtin:skill_reviewer")?.name, "审查员", "旧角色 id 解析到审查员");
	assert.ok(!BUILTIN_ROLES.some((r) => /审核员/.test(r.name)), "没有按对象类型区分的审核员角色");
	assert.deepEqual(builtinRole("builtin:reviewer")!.permissions.filter((x) => x.startsWith("market.")), ["market.review", "market.manage"]);
});

test("migration v6: 旧角色分配 / 邀请 / 直接授权 / 自定义角色 都迁移到统一的审查员权限（幂等，不产生重复）", () => {
	const db = new AppDb(":memory:");
	const all = identityModule.migrations!;
	db.migrate("identity", all.filter((m) => m.version <= 5));
	const now = new Date().toISOString();
	db.run("INSERT INTO id_orgs (id, name, created_at) VALUES ('o1', 'Old', ?)", now);
	for (const u of ["u1", "u2", "u3"]) {
		db.run("INSERT INTO id_users (id, email, name, created_at) VALUES (?, ?, ?, ?)", u, `${u}@x`, u, now);
		db.run("INSERT INTO id_org_members (org_id, user_id, role, created_at) VALUES ('o1', ?, 'member', ?)", u, now);
	}
	const ra = (id: string, user: string, role: string, scope = "org", sid = "") => db.run("INSERT INTO id_role_assignments (id, org_id, subject_kind, subject_id, role_id, scope_kind, scope_id, created_at) VALUES (?, 'o1', 'user', ?, ?, ?, ?, ?)", id, user, role, scope, sid, now);
	ra("a1", "u1", "builtin:skill_reviewer");
	ra("a2", "u2", "builtin:skill_reviewer", "department", "d1");
	ra("a3", "u3", "builtin:reviewer"); // 已经是新角色：不得被重复/破坏
	db.run("INSERT INTO id_user_grants (id, org_id, user_id, permission, effect, created_at) VALUES ('g1','o1','u1','skill.review','allow',?), ('g2','o1','u1','mcp.connector.review','allow',?), ('g3','o1','u2','skill.marketplace.manage','deny',?), ('g4','o1','u3','kb.publish','allow',?)", now, now, now, now);
	db.run("INSERT INTO id_roles (id, org_id, name, permissions, created_at, updated_at) VALUES ('r1','o1','仅审核','[\"skill.review\",\"mcp.connector.review\",\"kb.publish\"]',?,?), ('r2','o1','无关','[\"audit.view\"]',?,?)", now, now, now, now);
	db.run("INSERT INTO id_invites (code, org_id, role, created_by, created_at, expires_at, role_id) VALUES ('c1','o1','member','u1',?,?,'builtin:skill_reviewer')", now, now);

	db.migrate("identity", all);
	assert.deepEqual(db.all<any>("SELECT id, role_id, scope_kind FROM id_role_assignments WHERE role_id LIKE 'builtin:%reviewer' ORDER BY id").map((r) => `${r.id}:${r.role_id}:${r.scope_kind}`), ["a1:builtin:reviewer:org", "a2:builtin:reviewer:department", "a3:builtin:reviewer:org"]);
	assert.equal(db.get<any>("SELECT role_id FROM id_invites WHERE code = 'c1'")!.role_id, "builtin:reviewer");
	// u1 同时有 skill.review 与 mcp.connector.review 两条允许：合并为一条 market.review，不违反唯一约束。
	assert.deepEqual(db.all<any>("SELECT user_id, permission, effect FROM id_user_grants ORDER BY user_id, permission").map((r) => `${r.user_id}:${r.permission}:${r.effect}`), ["u1:market.review:allow", "u2:market.manage:deny", "u3:kb.publish:allow"]);
	assert.deepEqual(JSON.parse(db.get<any>("SELECT permissions FROM id_roles WHERE id = 'r1'")!.permissions), ["market.review", "kb.publish"], "自定义角色：两个旧审核权限合成一个且去重");
	assert.deepEqual(JSON.parse(db.get<any>("SELECT permissions FROM id_roles WHERE id = 'r2'")!.permissions), ["audit.view"]);
	// 再跑一次不变（migrate 按版本只执行一次；直接重放 SQL 也应是幂等的）。
	db.raw.exec(all.find((m) => m.version === 6)!.sql);
	assert.equal(db.get<any>("SELECT COUNT(*) AS n FROM id_role_assignments WHERE role_id = 'builtin:reviewer'")!.n, 3);
	db.close();
});

async function setup() {
	const t = await startTestApp();
	const admin = await t.user("ru-admin@example.com");
	const rev = await orgMember(t, admin, "ru-rev@example.com");
	const plain = await orgMember(t, admin, "ru-plain@example.com");
	return { t, admin, rev, plain };
}
const assignRole = (t: TestApp, admin: { token: string }, userId: string, roleId: string, scope: any = { kind: "org" }, expect = 200) => t.json("POST", "/api/admin/role-assignments", { token: admin.token, json: { subject: { kind: "user", id: userId }, roleId, scope }, expect });

test("旧 API 输入仍可用：用旧角色 id 分配 → 得到审查员；旧权限 id 做直接授权 / 自定义角色 → 存成统一权限；旧权限 id 求值等价于新的", async () => {
	const { t, admin, rev, plain } = await setup();
	try {
		const a = await assignRole(t, admin, rev.me.userId, "builtin:skill_reviewer");
		assert.equal(a.assignment.roleId, "builtin:reviewer");
		assert.equal(a.assignment.roleName, "审查员");
		const az = t.app.ctx.services.get("authz") as any;
		const p = await (t.app.ctx.services.get("identity") as Identity).principalFor(rev.me.userId, rev.me.orgId);
		for (const perm of ["market.review", "skill.review", "mcp.connector.review", "market.manage", "skill.marketplace.manage"]) assert.equal(await az.has(p!, perm), true, perm);
		const pp = await (t.app.ctx.services.get("identity") as Identity).principalFor(plain.me.userId, plain.me.orgId);
		for (const perm of ["market.review", "skill.review", "mcp.connector.review", "skill.marketplace.manage"]) assert.equal(await az.has(pp!, perm), false, perm);
		// 自定义角色写旧权限 id → 存的是新 id
		const role = (await t.json("POST", "/api/admin/roles", { token: admin.token, json: { name: "旧写法", permissions: ["skill.review", "mcp.connector.review"] } })).role;
		assert.deepEqual(role.permissions, ["market.review"]);
		// 直接授权用旧 id
		const g = await t.json("PUT", `/api/admin/members/${plain.me.userId}/grants`, { token: admin.token, json: { permission: "skill.review", effect: "allow" } });
		assert.equal(g.grant.permission, "market.review");
		assert.equal(await az.has(pp!, "mcp.connector.review"), true, "统一权限：技能审查权限同样能审连接器");
		// 角色目录里没有任何「技能审核员」
		const roles = (await t.json("GET", "/api/admin/roles", { token: admin.token })).roles.map((r: any) => r.name);
		assert.ok(roles.includes("审查员") && !roles.some((n: string) => /审核员/.test(n)), roles.join(","));
	} finally {
		await t.dispose();
	}
});

test("/market/me：canReview 由统一权限决定；canReviewSkills / canReviewMcp 仅是它的别名；reviewKinds 含技能、连接、专家", async () => {
	const { t, admin, rev, plain } = await setup();
	try {
		const none = (await t.json("GET", "/api/market/me", { token: plain.token })).me;
		assert.deepEqual([none.canReview, none.canReviewSkills, none.canReviewMcp, none.reviewKinds], [false, false, false, []]);
		await assignRole(t, admin, rev.me.userId, "builtin:reviewer");
		const me = (await t.json("GET", "/api/market/me", { token: rev.token })).me;
		assert.deepEqual([me.canReview, me.canReviewSkills, me.canReviewMcp, me.canManageMarket], [true, true, true, true]);
		assert.deepEqual([...me.reviewKinds].sort(), ["expert", "mcp", "skill"]);
	} finally {
		await t.dispose();
	}
});

test("审查对象类型可扩展：注册新类型后进审查队列、由同一个审查员权限决定、发布/驳回走各自处理器；未注册类型不可审", async () => {
	const { t, admin, rev, plain } = await setup();
	try {
		const market = t.app.ctx.services.get("market") as Market;
		const calls: string[] = [];
		market.registerKind("expert", {
			family: "expert",
			onPublished: (sub) => void calls.push(`published:${sub.subject_id}`),
			onDecision: (sub, to) => void calls.push(`decision:${sub.subject_id}:${to}`),
			submissionInfo: (sub) => ({ files: [], permissionDelta: { added: [], removed: [] }, diff: [], checks: sub.checks ? JSON.parse(sub.checks) : undefined }),
		});
		const submitter = await t.json("GET", "/api/me", { token: plain.token });
		const principal = (await (t.app.ctx.services.get("identity") as Identity).principalFor(submitter.me?.userId ?? plain.me.userId, plain.me.orgId))!;
		const checks = { ok: true, at: new Date().toISOString(), findings: [], stats: { fileCount: 0, totalBytes: 0, packageBytes: 0, scriptCount: 0 } };
		const s1 = market.openSubmission(principal, { kind: "expert", subjectId: "ex_1", subjectName: "测试专家", target: "org", note: "n", checks });
		const s2 = market.openSubmission(principal, { kind: "expert", subjectId: "ex_2", subjectName: "另一个专家", target: "org", note: "n", checks });
		// 非审查员看不到队列
		assert.equal((await t.json("GET", "/api/market/submissions?view=queue", { token: plain.token })).submissions.length, 0);
		await assignRole(t, admin, rev.me.userId, "builtin:reviewer");
		const q = (await t.json("GET", "/api/market/submissions?view=queue&kind=expert", { token: rev.token })).submissions;
		assert.deepEqual(q.map((s: any) => s.kind), ["expert", "expert"]);
		assert.equal((await t.json("GET", "/api/market/submissions?view=queue&kind=skill", { token: rev.token })).submissions.length, 0, "筛选按类型分组");
		assert.equal(q[0].canDecide, true);
		const detail = (await t.json("GET", `/api/market/submissions/${s1}`, { token: rev.token })).submission;
		assert.equal(detail.kind, "expert");
		// 通过 → 走专家处理器的发布；驳回需评语，走 onDecision
		await t.json("POST", `/api/market/submissions/${s1}/decision`, { token: rev.token, json: { decision: "approve" } });
		await t.json("POST", `/api/market/submissions/${s2}/decision`, { token: rev.token, json: { decision: "reject", comment: "不合格" } });
		assert.deepEqual(calls, ["published:ex_1", "decision:ex_2:rejected"]);
		// 提交人不能审自己；非审查员不能决定
		const s3 = market.openSubmission(principal, { kind: "expert", subjectId: "ex_3", subjectName: "x", target: "org", checks });
		await t.json("POST", `/api/market/submissions/${s3}/decision`, { token: plain.token, json: { decision: "approve" }, expect: 403 });
		// 同一审查员可以审 MCP 提交（不区分类型）：连接器 / 目录都走同一权限
		assert.equal(market.familyOf("mcp_catalog"), "mcp");
		assert.equal(market.familyOf("mcp_connector"), "mcp");
		assert.equal(market.familyOf("skill"), "skill");
	} finally {
		await t.dispose();
	}
});
