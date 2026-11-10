// Skill scopes (round 6): a department-scoped skill / department install applies to members of that department AND its sub-departments
// (the same subtree rule as authz grants), never to ancestors or other branches; cross-organisation isolation of every skill path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { orgMember, upload } from "./fixtures/util.ts";
import { context, fakeApi, fixedActor } from "./fixtures/tool-harness.ts";
import { createSkillsExtension, type Skills } from "../src/tools/skills.ts";
import type { Market } from "../src/tools/market.ts";

const enc = new TextEncoder();
const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\nversion: 1.0.0\n---\n\n# ${name}\n\n正文。\n`;
const pkg = (name: string, description = `${name} 的说明。当用户需要时使用。`) => zipSync({ "SKILL.md": enc.encode(skillMd(name, description)), "references/note.txt": enc.encode(`note of ${name}`) });
async function up(t: TestApp, token: string, bytes: Uint8Array) {
	const r = await upload(t, token, "/market/skills/upload", "pkg.zip", bytes, {}, "application/zip");
	const text = await r.text();
	return { status: r.status, body: text ? JSON.parse(text) : {} };
}
const statusOf = (t: TestApp, method: string, path: string, token: string, json?: unknown) => t.req(method, path, { token, json }).then((r) => r.status);

async function toolsFor(t: TestApp, user: { me: any }) {
	const ctx = t.app.ctx;
	const space = ctx.services.get("identity").personalSpace(user.me.userId, user.me.orgId);
	const ext = createSkillsExtension(ctx, { resolveActor: fixedActor(ctx, user.me.userId, user.me.orgId, space.id) });
	const skill = ext.tools!.find((x) => x.name === "skill")!;
	let n = 0;
	const call = (args: Record<string, unknown>, conv = 3) => skill.execute(args as any, fakeApi({ conversationId: conv, taskId: ++n, callId: `s${conv}-${n}` }), context) as Promise<{ output: { text: string }[] }>;
	const plan = async (conv = 3) => {
		const p = (await ctx.services.get("identity").principalFor(user.me.userId, user.me.orgId))!; // fresh principal: membership changes count
		return (await (ctx.services.get("market") as Market).loadedMountPlan(p, space, conv)).mounts.map((m) => m.mount.target);
	};
	return { call, plan, text: async (args: Record<string, unknown>, conv = 3) => (await call(args, conv)).output[0]!.text, space };
}

test("IdentityService.departmentScopeIds: departments plus ancestors, archived and foreign-org departments excluded", async () => {
	const t = await startTestApp();
	try {
		const admin = await t.user("sc-id-admin@example.com");
		const other = await t.user("sc-id-other@example.com");
		const mk = async (token: string, name: string, parentId?: string) => (await t.json("POST", "/api/admin/departments", { token, json: { name, parentId } })).department.id as string;
		const hq = await mk(admin.token, "HQ");
		const eng = await mk(admin.token, "Eng", hq);
		const be = await mk(admin.token, "Backend", eng);
		const sales = await mk(admin.token, "Sales", hq);
		const foreign = await mk(other.token, "Foreign");
		const id = t.app.ctx.services.get("identity");
		assert.deepEqual(new Set(id.departmentScopeIds(admin.me.orgId, [be])), new Set([be, eng, hq]));
		assert.deepEqual(new Set(id.departmentScopeIds(admin.me.orgId, [sales, be])), new Set([sales, be, eng, hq]));
		assert.deepEqual(id.departmentScopeIds(admin.me.orgId, []), []);
		assert.deepEqual(id.departmentScopeIds(admin.me.orgId, [foreign]), [], "another org's department id never counts");
		assert.deepEqual(id.departmentScopeIds(other.me.orgId, [be]), []);
		t.app.ctx.db.run("UPDATE id_departments SET archived_at = ? WHERE id = ?", new Date().toISOString(), eng);
		assert.deepEqual(new Set(id.departmentScopeIds(admin.me.orgId, [be])), new Set([be]), "an archived department ends the chain (as in authz)");
	} finally {
		await t.dispose();
	}
});

test("department subtree: a skill / install scoped to a department reaches its sub-departments, not ancestors or other branches; removal revokes", async () => {
	const t = await startTestApp();
	try {
		const admin = await t.user("sc-admin@example.com");
		const member = (email: string) => orgMember(t, admin, email);
		const author = await member("sc-author@example.com");
		const reviewer = await member("sc-reviewer@example.com");
		const mEng = await member("sc-eng@example.com");
		const mBe = await member("sc-backend@example.com");
		const mHq = await member("sc-hq@example.com");
		const mSales = await member("sc-sales@example.com");
		const mNone = await member("sc-none@example.com");
		const dept = async (name: string, parentId?: string) => (await t.json("POST", "/api/admin/departments", { token: admin.token, json: { name, parentId } })).department.id as string;
		const join = (d: string, u: { me: any }, role: string | null = "member") => t.json("PUT", `/api/admin/departments/${d}/members`, { token: admin.token, json: { userId: u.me.userId, role } });
		const assign = (u: { me: any }, roleId: string, scope: { kind: string; id?: string }) => t.json("POST", "/api/admin/role-assignments", { token: admin.token, json: { subject: { kind: "user", id: u.me.userId }, roleId, scope } });
		const hq = await dept("总部");
		const eng = await dept("研发部", hq);
		const be = await dept("后端组", eng);
		const sales = await dept("销售部", hq);
		await join(eng, author);
		await join(eng, mEng);
		await join(be, mBe);
		await join(hq, mHq);
		await join(sales, mSales);
		await assign(author, "builtin:dept_admin", { kind: "department", id: eng });
		await assign(reviewer, "builtin:skill_reviewer", { kind: "department", id: eng });

		const a = await up(t, author.token, pkg("eng-kit", "研发部通用的评审清单。当用户做代码评审时使用。"));
		assert.equal(a.status, 200, JSON.stringify(a.body));
		const id = a.body.skill.id as string;
		const sub = (await t.json("POST", `/api/market/skills/${id}/versions/1/submit`, { token: author.token, json: { targetScope: "department", targetRef: eng } })).submission;
		await t.json("POST", `/api/market/submissions/${sub.id}/decision`, { token: reviewer.token, json: { decision: "approve" } });

		// visibility (market list + detail + file + package)
		const sees = async (u: { token: string }) => (await t.json("GET", "/api/market/skills", { token: u.token })).skills.some((s: any) => s.id === id);
		assert.deepEqual(await Promise.all([mEng, mBe, mHq, mSales, mNone].map(sees)), [true, true, false, false, false]);
		assert.equal(await statusOf(t, "GET", `/api/market/skills/${id}`, mBe.token), 200, "sub-department member sees the detail");
		assert.equal(await statusOf(t, "GET", `/api/market/skills/${id}/versions/1/file?path=SKILL.md`, mBe.token), 200);
		assert.equal(await statusOf(t, "GET", `/api/market/skills/${id}/versions/1/package`, mBe.token), 200);
		for (const u of [mHq, mSales, mNone]) {
			assert.equal(await statusOf(t, "GET", `/api/market/skills/${id}`, u.token), 403);
			assert.equal(await statusOf(t, "GET", `/api/market/skills/${id}/versions/1/file?path=SKILL.md`, u.token), 403);
			assert.equal(await statusOf(t, "GET", `/api/market/skills/${id}/versions/1/package`, u.token), 403);
			assert.equal(await statusOf(t, "POST", `/api/market/skills/${id}/install`, u.token, { target: "me" }), 403);
			assert.equal(await statusOf(t, "POST", `/api/market/skills/${id}/rate`, u.token, { stars: 5 }), 403);
			assert.equal((await t.json("GET", "/api/skills", { token: u.token })).skills.some((s: any) => s.id === id), false);
		}

		// installing for oneself, and using it through the agent tool
		await t.json("POST", `/api/market/skills/${id}/install`, { token: mBe.token, json: { target: "me" } });
		await t.json("POST", `/api/market/skills/${id}/rate`, { token: mBe.token, json: { stars: 4 } });
		const be1 = await toolsFor(t, mBe);
		assert.match(await be1.text({ action: "load", name: "eng-kit" }), /<skill name="eng-kit"/);
		assert.deepEqual(await be1.plan(), ["/skills/eng-kit"]);

		// department install by the dept admin: applies to Eng members and the Backend sub-department, not HQ / Sales
		await t.json("POST", `/api/market/skills/${id}/install`, { token: author.token, json: { target: "department", scopeRef: eng } });
		const viaScope = async (u: { me: any }) => {
			const p = (await t.app.ctx.services.get("identity").principalFor(u.me.userId, u.me.orgId))!;
			return (await (t.app.ctx.services.get("skills") as Skills).active(p, t.app.ctx.services.get("identity").personalSpace(u.me.userId, u.me.orgId))).filter((x) => x.skill.id === id).map((x) => x.via);
		};
		assert.deepEqual(await viaScope(mEng), ["department"]);
		assert.deepEqual(await viaScope(mBe), ["me"], "personal install wins for the sub-department member who also installed it");
		await t.json("DELETE", `/api/market/skills/${id}/install?target=me`, { token: mBe.token });
		assert.deepEqual(await viaScope(mBe), ["department"], "a sub-department member gets the Eng-wide install");
		assert.deepEqual(await viaScope(mHq), []);
		assert.deepEqual(await viaScope(mSales), []);
		assert.deepEqual(await viaScope(mNone), []);
		const eng1 = await toolsFor(t, mEng);
		assert.match(await eng1.text({ action: "search", query: "评审" }), /eng-kit/);
		await assert.rejects((await toolsFor(t, mHq)).call({ action: "load", name: "eng-kit" }), /没有可用的技能|无权/);
		assert.match(await (await toolsFor(t, mHq)).text({ action: "list" }), /没有启用的技能/);

		// a skill scoped to the CHILD does not reach the parent's members
		const b = await up(t, author.token, pkg("be-only", "后端组专用。当用户处理后端服务时使用。"));
		await assign(author, "builtin:dept_admin", { kind: "department", id: be });
		const sub2 = (await t.json("POST", `/api/market/skills/${b.body.skill.id}/versions/1/submit`, { token: author.token, json: { targetScope: "department", targetRef: be } })).submission;
		await t.json("POST", `/api/market/submissions/${sub2.id}/decision`, { token: reviewer.token, json: { decision: "approve" } });
		assert.deepEqual(await Promise.all([mBe, mEng, mHq].map((u) => t.json("GET", "/api/market/skills", { token: u.token }).then((r) => r.skills.some((s: any) => s.id === b.body.skill.id)))), [true, false, false]);

		// revocation: leave the sub-department → the department install stops applying and the mount disappears on the next run
		await be1.text({ action: "load", name: "eng-kit" }, 9);
		assert.deepEqual(await be1.plan(9), ["/skills/eng-kit"]);
		await join(be, mBe, null);
		assert.deepEqual(await be1.plan(9), []);
		assert.deepEqual(await viaScope(mBe), []);
		await assert.rejects(be1.call({ action: "load", name: "eng-kit" }, 9), /没有可用的技能|无权/);
		await join(sales, mBe); // an unrelated branch does not bring it back
		assert.deepEqual(await viaScope(mBe), []);
		await join(eng, mBe); // direct member of Eng again
		assert.deepEqual(await viaScope(mBe), ["department"]);
	} finally {
		await t.dispose();
	}
});

test("cross-organisation isolation: an org-B user cannot list/detail/read/download/install/rate/submit/decide/use an org-A published org skill", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("sc-org-a@example.com");
		const aMember = await orgMember(t, a, "sc-org-a-member@example.com");
		const b = await t.user("sc-org-b@example.com"); // owner of a different organisation
		assert.notEqual(a.me.orgId, b.me.orgId);

		// Org A: an org skill published by the admin (with a file), installed org-wide, plus a pending submission and a personal skill.
		const org = await t.json("POST", "/api/skills", { token: a.token, json: { name: "secret-kit", kind: "context", scope: "org", description: "A 组织的内部技能", instructions: "# 内部步骤\n机密说明", resources: [{ path: "refs/a.txt", content: "A-ONLY" }] } });
		const id = org.skill.id as string;
		await t.json("POST", `/api/market/skills/${id}/install`, { token: a.token, json: { target: "org" } });
		const pend = await up(t, a.token, pkg("pending-kit"));
		const sub = (await t.json("POST", `/api/market/skills/${pend.body.skill.id}/versions/1/submit`, { token: a.token, json: { targetScope: "org" } })).submission;
		assert.equal(sub.state, "pending_review");
		const personal = await up(t, aMember.token, pkg("a-private"));

		// control: org-A member can use it
		const aTools = await toolsFor(t, aMember);
		assert.match(await aTools.text({ action: "load", name: "secret-kit" }), /机密说明/);
		assert.equal(await statusOf(t, "GET", `/api/market/skills/${id}`, aMember.token), 200);

		// HTTP /api/market/*
		const no = [403, 404];
		const check = async (method: string, path: string, json?: unknown) => {
			const s = await statusOf(t, method, path, b.token, json);
			assert.ok(no.includes(s), `${method} ${path} → ${s}`);
		};
		assert.equal((await t.json("GET", "/api/market/skills", { token: b.token })).skills.length, 0);
		assert.deepEqual((await t.json("GET", "/api/market/categories", { token: b.token })).categories, []);
		await check("GET", `/api/market/skills/${id}`);
		await check("GET", `/api/market/skills/${id}?version=1`);
		await check("GET", `/api/market/skills/${id}/versions/1/file?path=refs/a.txt`);
		await check("GET", `/api/market/skills/${id}/versions/1/file?path=SKILL.md`);
		await check("GET", `/api/market/skills/${id}/versions/1/package`);
		await check("POST", `/api/market/skills/${id}/install`, { target: "me" });
		await check("POST", `/api/market/skills/${id}/install`, { target: "org" });
		await check("DELETE", `/api/market/skills/${id}/install?target=org`);
		await check("POST", `/api/market/skills/${id}/rate`, { stars: 1, comment: "x" });
		await check("POST", `/api/market/skills/${id}/versions/1/submit`, { targetScope: "org" });
		await check("POST", `/api/market/skills/${id}/unpublish`, { reason: "attack" });
		await check("POST", `/api/market/skills/${id}/republish`);
		await check("POST", `/api/market/skills/${id}/force-publish`, { versionNo: 1, reason: "attack" });
		await check("GET", `/api/market/skills/${personal.body.skill.id}`);
		await check("GET", `/api/market/submissions/${sub.id}`);
		await check("POST", `/api/market/submissions/${sub.id}/decision`, { decision: "approve" });
		await check("POST", `/api/market/submissions/${sub.id}/publish`);
		await check("POST", `/api/market/submissions/${sub.id}/withdraw`);
		assert.equal((await t.json("GET", "/api/market/submissions?view=queue", { token: b.token })).submissions.length, 0);
		// uploading a new version onto A's skill from org B is refused too
		const r = await upload(t, b.token, "/market/skills/upload", "pkg.zip", pkg("secret-kit"), { skillId: id }, "application/zip");
		assert.ok(no.includes(r.status), `upload new version → ${r.status}`);
		// nothing changed
		assert.equal(t.app.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM skill_ratings WHERE skill_id = ?", id)!.n, 0);
		assert.equal(t.app.ctx.db.get<{ s: string }>("SELECT state AS s FROM market_submissions WHERE id = ?", sub.id)!.s, "pending_review");
		assert.equal((t.app.ctx.services.get("skills") as Skills).skill(id)!.listed, 1);

		// HTTP /api/skills/*
		assert.equal((await t.json("GET", "/api/skills", { token: b.token })).skills.length, 0);
		await check("GET", `/api/skills/${id}`);
		await check("POST", `/api/skills/${id}/install`, {});
		await check("PATCH", `/api/skills/${id}/install`, { enabled: false });
		await check("DELETE", `/api/skills/${id}/install`);
		await check("POST", `/api/skills/${id}/versions`, { instructions: "# hacked" });
		await check("POST", `/api/skills/${id}/grants`, { versionNo: 1, permissions: [] });

		// service level
		const pb = (await t.app.ctx.services.get("identity").principalFor(b.me.userId, b.me.orgId))!;
		const skills = (t.app.ctx.services.get("skills") as Skills);
		for (const action of ["read", "use", "write"]) assert.deepEqual(await skills.decide(pb, action, id), { allow: false, reason: "other_org" });
		assert.equal((await skills.visible(pb)).length, 0);
		assert.deepEqual((t.app.ctx.services.get("market") as Market).scopeInstallsFor(pb), [], "org A's org-wide install does not apply to org B");
		assert.equal((await skills.active(pb)).length, 0);

		// the agent tool (skill) for the org-B user: list/search find nothing; load/read/run are refused by name, slug and id
		const bTools = await toolsFor(t, b);
		assert.match(await bTools.text({ action: "list" }), /没有启用的技能/);
		assert.match(await bTools.text({ action: "search", query: "secret" }), /没有找到/);
		for (const ref of ["secret-kit", id, org.skill.slug ?? "secret-kit"]) {
			await assert.rejects(bTools.call({ action: "load", name: ref }), /没有可用的技能/);
			await assert.rejects(bTools.call({ action: "read", name: ref, path: "refs/a.txt" }), /没有可用的技能/);
			await assert.rejects(bTools.call({ action: "run", name: ref }), /没有可用的技能/);
		}
		assert.deepEqual(await bTools.plan(), []);
		// an org-A skill id recorded as "loaded" in an org-B conversation is never mounted (active() is org-scoped)
		t.app.ctx.db.run("INSERT INTO skill_conv_loaded (space_id, conversation_id, skill_id, version_id, loaded_at) VALUES (?, 3, ?, 'x', ?)", bTools.space.id, id, new Date().toISOString());
		assert.deepEqual(await bTools.plan(), []);
	} finally {
		await t.dispose();
	}
});
