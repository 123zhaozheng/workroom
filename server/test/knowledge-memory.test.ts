// Memory (M10): CRUD with source + scope, private/project/org isolation in the model context, correction flow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "./helpers/app.ts";
import { joinOrg } from "../src/knowledge/testing.ts";

test("memory CRUD: scope + source labels, permissions per scope, history", async () => {
	const t = await startTestApp();
	try {
		const alice = await t.user("alice@example.com", { name: "Alice" });
		const bob = await joinOrg(t, alice.me.orgId, "bob@example.com");
		const { project } = await t.json("POST", "/api/projects", { token: alice.token, json: { kind: "space", name: "Apollo" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: alice.token, json: { email: "bob@example.com", role: "viewer" } });

		const priv = (await t.json("POST", "/api/memory", { token: alice.token, json: { content: "我喜欢简洁的要点式回答", scope: "private", kind: "preference" } })).memory;
		assert.equal(priv.scope, "private");
		assert.equal(priv.source, "user");
		assert.equal(priv.kind, "preference");
		assert.deepEqual(priv.permissions, { edit: true, delete: true });
		const proj = (await t.json("POST", "/api/memory", { token: alice.token, json: { content: "Apollo 项目的客户是蓝鲸科技", scope: "project", projectId: project.id, kind: "background" } })).memory;
		assert.equal(proj.projectId, project.id);
		// Viewer can read project memory but not write; org memory needs admin.
		await t.json("POST", "/api/memory", { token: bob.token, json: { content: "x", scope: "project", projectId: project.id }, expect: 403 });
		await t.json("POST", "/api/memory", { token: bob.token, json: { content: "x", scope: "org" }, expect: 403 });
		await t.json("POST", "/api/memory", { token: alice.token, json: { content: "", scope: "private" }, expect: 400 });
		await t.json("POST", "/api/memory", { token: alice.token, json: { content: "x", scope: "galaxy" }, expect: 400 });
		const org = (await t.json("POST", "/api/memory", { token: alice.token, json: { content: "公司财年从四月开始", scope: "org", kind: "fact" } })).memory;

		const bobList = (await t.json("GET", "/api/memory", { token: bob.token })).memories;
		assert.deepEqual(bobList.map((m: any) => m.id).sort(), [proj.id, org.id].sort(), "bob never sees alice's private memory");
		assert.equal(bobList.find((m: any) => m.id === proj.id).permissions.edit, false);
		await t.json("GET", `/api/memory/${priv.id}`, { token: bob.token, expect: 404 });
		await t.json("PATCH", `/api/memory/${proj.id}`, { token: bob.token, json: { content: "hack" }, expect: 403 });
		await t.json("DELETE", `/api/memory/${priv.id}`, { token: bob.token, expect: 404 });
		assert.equal((await t.json("GET", "/api/memory?scope=project", { token: alice.token })).memories.length, 1);

		const edited = (await t.json("PATCH", `/api/memory/${priv.id}`, { token: alice.token, json: { content: "我喜欢简洁的要点式回答，并附上来源" } })).memory;
		assert.equal(edited.version, 2);
		const hist = (await t.json("GET", `/api/memory/${priv.id}/history`, { token: alice.token })).revisions;
		assert.deepEqual(hist.map((r: any) => r.change), ["create", "edit"]);
		await t.json("DELETE", `/api/memory/${priv.id}`, { token: alice.token });
		await t.json("GET", `/api/memory/${priv.id}`, { token: alice.token, expect: 404 });

		// Removed from the project → project memory disappears for bob immediately.
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: alice.token, json: { email: "bob@example.com", role: null } });
		assert.deepEqual((await t.json("GET", "/api/memory", { token: bob.token })).memories.map((m: any) => m.id), [org.id]);
		await t.json("GET", `/api/memory/${proj.id}`, { token: bob.token, expect: 404 });
	} finally {
		await t.dispose();
	}
});

test("memory isolation: private memory never enters project context; switching space switches context", async () => {
	const t = await startTestApp();
	try {
		const alice = await t.user("alice@example.com", { name: "Alice" });
		const bob = await joinOrg(t, alice.me.orgId, "bob@example.com");
		const me = await t.json("GET", "/api/me", { token: alice.token });
		const bobMe = await t.json("GET", "/api/me", { token: bob.token });
		const { project } = await t.json("POST", "/api/projects", { token: alice.token, json: { kind: "space", name: "Apollo" } });
		const { project: other } = await t.json("POST", "/api/projects", { token: alice.token, json: { kind: "space", name: "Zeus" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: alice.token, json: { email: "bob@example.com", role: "editor" } });

		await t.json("POST", "/api/memory", { token: alice.token, json: { content: "ALICE-PRIVATE: 我的体检报告在周五", scope: "private" } });
		await t.json("POST", "/api/memory", { token: bob.token, json: { content: "BOB-PRIVATE: 我在准备跳槽", scope: "private" } });
		await t.json("POST", "/api/memory", { token: alice.token, json: { content: "APOLLO-SHARED: 交付物统一用中文", scope: "project", projectId: project.id, kind: "constraint" } });
		await t.json("POST", "/api/memory", { token: alice.token, json: { content: "ZEUS-SHARED: 预算上限五十万", scope: "project", projectId: other.id } });
		await t.json("POST", "/api/memory", { token: alice.token, json: { content: "ORG: 对外文件须经法务审核", scope: "org", kind: "constraint" } });

		const ctxOf = async (token: string, spaceId: string) => (await t.json("GET", `/api/memory/context?spaceId=${spaceId}`, { token })).section ?? "";
		// Alice's personal space: her private + org. Never bob's, never project memories.
		const alicePersonal = await ctxOf(alice.token, me.personalSpaceId);
		assert.match(alicePersonal, /ALICE-PRIVATE/);
		assert.match(alicePersonal, /ORG:/);
		assert.doesNotMatch(alicePersonal, /BOB-PRIVATE|APOLLO-SHARED|ZEUS-SHARED/);
		// Apollo project space (seen by alice OR bob): project + org only. No private memory of anyone.
		for (const tok of [alice.token, bob.token]) {
			const s = await ctxOf(tok, project.spaceId);
			assert.match(s, /APOLLO-SHARED/);
			assert.match(s, /ORG:/);
			assert.doesNotMatch(s, /ALICE-PRIVATE|BOB-PRIVATE|ZEUS-SHARED/);
			// Constraints come first in the section.
			assert.ok(s.indexOf("约束") < s.indexOf("APOLLO-SHARED") || s.indexOf("APOLLO-SHARED") < s.indexOf("ORG:"));
		}
		// Switching to the other project switches the shared background.
		const zeus = await ctxOf(alice.token, other.spaceId);
		assert.match(zeus, /ZEUS-SHARED/);
		assert.doesNotMatch(zeus, /APOLLO-SHARED|ALICE-PRIVATE/);
		// Bob cannot inspect a space he cannot read.
		await t.json("GET", `/api/memory/context?spaceId=${other.spaceId}`, { token: bob.token, expect: 403 });
		await t.json("GET", `/api/memory/context?spaceId=${me.personalSpaceId}`, { token: bob.token, expect: 403 });
		const bobPersonal = await ctxOf(bob.token, bobMe.personalSpaceId);
		assert.match(bobPersonal, /BOB-PRIVATE/);
		assert.doesNotMatch(bobPersonal, /ALICE-PRIVATE|APOLLO-SHARED/);

		// The same rule at the service level for the prompt section (actor-aware): another user acting in alice's personal
		// space (impossible through the API, but the section must not trust that) gets no private memory.
		const k = t.app.ctx.services.get("knowledgeAdmin") as any;
		const identity = t.app.ctx.services.get("identity");
		const bobP = await identity.principalFor(bob.me.userId, bob.me.orgId);
		const aliceSpace = identity.space(me.personalSpaceId)!;
		assert.doesNotMatch(k.memory.renderSection(k.memory.contextFor(bobP, aliceSpace)) ?? "", /ALICE-PRIVATE/);
		assert.doesNotMatch(k.memory.renderSection(k.memory.contextFor(null, aliceSpace)) ?? "", /ALICE-PRIVATE/);
		// Removing bob from the project removes the project background from his context there.
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: alice.token, json: { email: "bob@example.com", role: null } });
		assert.doesNotMatch(k.memory.renderSection(k.memory.contextFor(bobP, identity.space(project.spaceId)!)) ?? "", /APOLLO-SHARED/);
	} finally {
		await t.dispose();
	}
});

test("memory correction: visible update result, old version superseded, context shows only the corrected fact", async () => {
	const t = await startTestApp();
	try {
		const alice = await t.user("alice@example.com", { name: "Alice" });
		const me = await t.json("GET", "/api/me", { token: alice.token });
		const m = (await t.json("POST", "/api/memory", { token: alice.token, json: { content: "我的汇报对象是张经理", scope: "private", kind: "fact" } })).memory;
		const r = await t.json("POST", `/api/memory/${m.id}/correct`, { token: alice.token, json: { content: "我的汇报对象是李总监（自 11 月起）", note: "组织调整" } });
		assert.equal(r.previous.id, m.id);
		assert.equal(r.previous.status, "superseded");
		assert.equal(r.previous.supersededById, r.current.id);
		assert.equal(r.current.source, "corrected");
		assert.equal(r.current.correctsId, m.id);
		assert.equal(r.change.before, "我的汇报对象是张经理");
		assert.equal(r.change.after, "我的汇报对象是李总监（自 11 月起）");
		assert.equal(r.change.note, "组织调整");
		// Correcting a superseded item is refused (must correct the latest).
		await t.json("POST", `/api/memory/${m.id}/correct`, { token: alice.token, json: { content: "x" }, expect: 409 });
		const ctx = (await t.json("GET", `/api/memory/context?spaceId=${me.personalSpaceId}`, { token: alice.token })).section;
		assert.match(ctx, /李总监/);
		assert.match(ctx, /已更正/);
		assert.doesNotMatch(ctx, /张经理/);
		// Default list = active only; includeSuperseded shows the lineage.
		assert.deepEqual((await t.json("GET", "/api/memory", { token: alice.token })).memories.map((x: any) => x.id), [r.current.id]);
		assert.equal((await t.json("GET", "/api/memory?includeSuperseded=1", { token: alice.token })).memories.length, 2);
		const hist = (await t.json("GET", `/api/memory/${r.current.id}/history`, { token: alice.token })).revisions;
		assert.deepEqual(hist.map((h: any) => h.change), ["create", "correct", "supersede"]);
		assert.equal(hist.find((h: any) => h.change === "correct").note, "组织调整");
	} finally {
		await t.dispose();
	}
});
