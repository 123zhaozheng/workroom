// Round 9 (B1): lightweight "container" projects, read-only project shares, moving conversations in/out of projects, directory.
// Real app, real SQLite + pi-durable storage, fixture model. Run:
//   node --disable-warning=ExperimentalWarning --test server/test/round9-projects.test.ts
process.env.WORKROOM_FIXTURE_TOOLS = "1";
process.env.WORKROOM_SSE_THROTTLE_MS ??= "20";
process.env.WORKROOM_SSE_ACL_RECHECK_MS = "150";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { isSettled, sseReader, waitFor } from "../src/runtime/testing.ts";
import type { Identity } from "../src/identity/module.ts";
import type { Files } from "../src/files/service.ts";

type Conv = { spaceId: string; conversationId: number };
const base = (c: Conv) => `/api/conversations/${c.spaceId}/${c.conversationId}`;
const rid = () => randomUUID();

interface Org {
	t: TestApp;
	owner: { token: string; me: any };
	m1: { token: string; me: any };
	m2: { token: string; me: any };
	outsider: { token: string; me: any };
}

async function setup(t: TestApp): Promise<Org> {
	const owner = await t.user("owner@a.example", { name: "Olivia Owner" });
	const mk = async (email: string, name: string) => {
		const inv = await t.json("POST", "/api/admin/invites", { token: owner.token, json: { role: "member" } });
		return t.user(email, { inviteCode: inv.invite.code, name });
	};
	const m1 = await mk("m1@a.example", "Mia Member");
	const m2 = await mk("m2@a.example", "Max Member");
	const outsider = await t.user("out@b.example", { name: "Otto Outsider" });
	return { t, owner, m1, m2, outsider };
}

async function newProject(t: TestApp, token: string, name: string) {
	return (await t.json("POST", "/api/projects", { token, json: { name } })).project;
}
async function newConv(t: TestApp, token: string, body: Record<string, unknown> = {}): Promise<Conv & { projectId?: string; projectName?: string; access?: string }> {
	return (await t.json("POST", "/api/conversations", { token, json: body })).conversation;
}
async function say(t: TestApp, token: string, c: Conv, text: string) {
	const r = await t.json("POST", `${base(c)}/messages`, { token, json: { text, requestId: rid() } });
	await waitFor(async () => isSettled(await t.json("GET", `${base(c)}/submissions/${r.submissionId}`, { token })), { what: "submission settles" });
	return r;
}
/** A deliverable produced "in" a conversation (provenance names it), straight through the files service. */
async function deliverable(t: TestApp, userId: string, orgId: string, c: Conv, name: string, body: string) {
	const p = (await (t.app.ctx.services.get("identity") as Identity).principalFor(userId, orgId))!;
	const files = t.app.ctx.services.get("files") as unknown as Files;
	return files.putVersion(p, { name, mime: "text/plain", bytes: new TextEncoder().encode(body), provenance: { createdBy: userId, spaceId: c.spaceId, conversationId: c.conversationId, origin: "agent" } });
}
const hasDeletedColumn = (t: TestApp) => t.app.ctx.db.all<{ name: string }>("PRAGMA table_info(rt_conversations)").some((r) => r.name === "deleted_at");

test("container projects: create / list / rename / delete — conversations and files survive and go back to 'no project'", async () => {
	const t = await startTestApp();
	try {
		const { owner, m1 } = await setup(t);
		const created = await t.json("POST", "/api/projects", { token: owner.token, json: { name: "  季度复盘  " } });
		const p = created.project;
		assert.equal(p.kind, "container");
		assert.equal(p.name, "季度复盘");
		assert.equal(p.access, "owner");
		assert.equal(p.spaceId, undefined, "a container project has no space");
		assert.equal(p.ownerId, owner.me.userId);
		assert.equal(p.conversationCount, 0);
		assert.equal(p.shared, false);
		// no space, no member rows
		const db = t.app.ctx.db;
		assert.equal(db.get<any>("SELECT COUNT(*) AS n FROM id_spaces WHERE project_id = ?", p.id).n, 0);
		assert.equal(db.get<any>("SELECT COUNT(*) AS n FROM id_project_members WHERE project_id = ?", p.id).n, 0);
		await t.json("POST", "/api/projects", { token: owner.token, json: { name: "   " }, expect: 400 });
		await t.json("POST", "/api/projects", { token: owner.token, json: { name: "x".repeat(101) }, expect: 400 });

		// conversations created straight into the project land in the PERSONAL space
		const c1 = await newConv(t, owner.token, { projectId: p.id, title: "分析一" });
		const c2 = await newConv(t, owner.token, { projectId: p.id, title: "分析二" });
		const loose = await newConv(t, owner.token, { title: "无项目" });
		const personal = (t.app.ctx.services.get("identity") as Identity).personalSpace(owner.me.userId, owner.me.orgId);
		assert.equal(c1.spaceId, personal.id);
		assert.equal(c1.projectId, p.id);
		assert.equal(c1.projectName, "季度复盘");
		assert.equal(c1.access, "own");
		assert.equal(loose.projectId, undefined);
		await say(t, owner.token, c1, "[[reply 第一个结论]]");
		const file = await deliverable(t, owner.me.userId, owner.me.orgId, c1, "结论.txt", "文件内容 A");

		let list = (await t.json("GET", "/api/projects", { token: owner.token })).projects;
		assert.equal(list.length, 1);
		assert.equal(list[0].conversationCount, 2);
		// the conversation list: filter by project, default list keeps everything of mine
		const inProject = (await t.json("GET", `/api/conversations?projectId=${p.id}`, { token: owner.token })).conversations;
		assert.deepEqual(inProject.map((c: any) => c.title).sort(), ["分析一", "分析二"]);
		assert.equal((await t.json("GET", "/api/conversations", { token: owner.token })).conversations.length, 3);

		// rename: owner only
		const ren = await t.json("PATCH", `/api/projects/${p.id}`, { token: owner.token, json: { name: "Q4 复盘" } });
		assert.equal(ren.project.name, "Q4 复盘");
		await t.json("PATCH", `/api/projects/${p.id}`, { token: owner.token, json: { name: "" }, expect: 400 });
		await t.json("PATCH", `/api/projects/${p.id}`, { token: m1.token, json: { name: "hijack" }, expect: 404 });
		assert.equal((await t.json("GET", `/api/conversations/${c1.spaceId}/${c1.conversationId}`, { token: owner.token })).conversation.projectName, "Q4 复盘");

		// others never see it, can never delete it
		assert.equal((await t.json("GET", "/api/projects", { token: m1.token })).projects.length, 0);
		await t.json("DELETE", `/api/projects/${p.id}`, { token: m1.token, expect: 404 });

		// delete: only the relation goes
		const del = await t.json("DELETE", `/api/projects/${p.id}`, { token: owner.token });
		assert.deepEqual({ ok: del.ok, detached: del.detached }, { ok: true, detached: 2 });
		assert.equal((await t.json("GET", "/api/projects", { token: owner.token })).projects.length, 0);
		await t.json("GET", `/api/projects/${p.id}`, { token: owner.token, expect: 404 });
		const after = await t.json("GET", base(c1), { token: owner.token });
		assert.equal(after.conversation.projectId, undefined);
		assert.equal(after.conversation.title, "分析一");
		const es = (await t.json("GET", `${base(c1)}/entries?limit=100`, { token: owner.token })).items;
		assert.ok(es.some((e: any) => e.kind === "assistant" && /第一个结论/.test(e.text)), "durable history intact");
		assert.equal((await t.json("GET", "/api/conversations", { token: owner.token })).conversations.length, 3);
		const dl = await t.req("GET", `/api/files/${file.fileId}/versions/${file.versionId}/download`, { token: owner.token });
		assert.equal(await dl.text(), "文件内容 A");
		const audit = (await t.json("GET", "/api/admin/audit?limit=100", { token: owner.token })).items.map((a: any) => a.action);
		for (const a of ["project.create", "project.update", "project.delete"]) assert.ok(audit.includes(a), `audit ${a}`);
	} finally {
		await t.dispose();
	}
});

test("legacy (space) projects keep working: created on request, listed with spaceId/role, members, 409 when non-empty", async () => {
	const t = await startTestApp();
	try {
		const { owner, m1, m2 } = await setup(t);
		const lp = (await t.json("POST", "/api/projects", { token: owner.token, json: { kind: "space", name: "旧版项目" } })).project;
		assert.equal(lp.kind, "space");
		assert.ok(lp.spaceId);
		assert.equal(lp.role, "owner");
		assert.equal(lp.access, "member");
		await t.json("PUT", `/api/projects/${lp.id}/members`, { token: owner.token, json: { email: "m1@a.example", role: "editor" } });
		const cp = await newProject(t, owner.token, "新容器");

		const l1 = (await t.json("GET", "/api/projects", { token: m1.token })).projects;
		assert.deepEqual(l1.map((p: any) => [p.kind, p.name, p.role]), [["space", "旧版项目", "editor"]]);
		assert.equal(l1[0].shared, true);
		assert.equal((await t.json("GET", "/api/projects", { token: m2.token })).projects.length, 0);
		const lo = (await t.json("GET", "/api/projects", { token: owner.token })).projects;
		assert.deepEqual(lo.map((p: any) => p.kind).sort(), ["container", "space"]);

		// conversations in a legacy project still live in the project space, with the project's members
		const c = await newConv(t, m1.token, { projectId: lp.id, title: "项目里的对话" });
		assert.equal(c.spaceId, lp.spaceId);
		assert.equal(c.projectId, lp.id);
		assert.equal(c.access, "member");
		assert.equal((await t.json("GET", "/api/projects", { token: owner.token })).projects.find((p: any) => p.id === lp.id).conversationCount, 1);
		assert.equal((await t.json("GET", `/api/conversations?projectId=${lp.id}`, { token: owner.token })).conversations.length, 1);
		await t.json("GET", `/api/conversations?projectId=${lp.id}`, { token: m2.token, expect: 403 });
		await t.json("GET", base(c), { token: m2.token, expect: 403 });

		// rename (legacy: project.manage / owner role), description untouched
		await t.json("PATCH", `/api/projects/${lp.id}`, { token: owner.token, json: { name: "旧版项目 2" } });
		await t.json("PATCH", `/api/projects/${lp.id}`, { token: m1.token, json: { name: "x" }, expect: 403 });
		assert.equal((await t.json("GET", `/api/projects/${lp.id}`, { token: m1.token })).project.name, "旧版项目 2");

		// delete: 409 while it holds conversations/files, hidden (archived) when empty
		const refused = await t.req("DELETE", `/api/projects/${lp.id}`, { token: owner.token });
		assert.equal(refused.status, 409);
		const body = await refused.json();
		assert.equal(body.error.code, "project_not_empty");
		assert.deepEqual(body.error.detail, { conversations: 1, files: 0 });
		assert.equal((await t.json("GET", `/api/projects/${lp.id}`, { token: owner.token })).project.id, lp.id, "still there");
		const empty = (await t.json("POST", "/api/projects", { token: owner.token, json: { kind: "space", name: "空项目" } })).project;
		await t.json("DELETE", `/api/projects/${empty.id}`, { token: owner.token });
		assert.ok(!(await t.json("GET", "/api/projects", { token: owner.token })).projects.some((p: any) => p.id === empty.id));
		// a container project id in legacy-only member routes is refused
		await t.json("PUT", `/api/projects/${cp.id}/members`, { token: owner.token, json: { email: "m1@a.example", role: "editor" }, expect: 403 });
	} finally {
		await t.dispose();
	}
});

test("move: creator only, personal space only, own container project only; legacy-project conversations refuse (409)", async () => {
	const t = await startTestApp();
	try {
		const { owner, m1, m2, outsider } = await setup(t);
		const p = await newProject(t, owner.token, "归档夹");
		const p2 = await newProject(t, owner.token, "第二个");
		const mine = await newConv(t, owner.token, { title: "待移动" });
		const put = (token: string, c: Conv, projectId: string | null, expect = 200) => t.json("PUT", `${base(c)}/project`, { token, json: { projectId }, expect });

		const r1 = await put(owner.token, mine, p.id);
		assert.equal(r1.conversation.projectId, p.id);
		assert.equal(r1.conversation.projectName, "归档夹");
		assert.equal(r1.conversation.access, "own");
		assert.equal(r1.visibleTo, 0);
		assert.equal((await put(owner.token, mine, p.id)).conversation.projectId, p.id, "idempotent");
		assert.equal((await put(owner.token, mine, p2.id)).conversation.projectId, p2.id, "project → project");
		assert.equal((await t.json("GET", "/api/projects", { token: owner.token })).projects.find((x: any) => x.id === p.id).conversationCount, 0);
		assert.equal((await t.json("GET", "/api/projects", { token: owner.token })).projects.find((x: any) => x.id === p2.id).conversationCount, 1);
		assert.equal((await put(owner.token, mine, null)).conversation.projectId, undefined);
		// moving never touches the conversation itself: still in the same space under the same id
		assert.equal((await t.json("GET", base(mine), { token: owner.token })).conversation.spaceId, mine.spaceId);
		await put(owner.token, mine, null);

		// not the creator / no access
		await put(m1.token, mine, p.id, 403);
		await put(m2.token, mine, null, 403);
		await put(outsider.token, mine, null, 403);
		// not an own project: somebody else's container project, unknown id, other org's project
		const m1Conv = await newConv(t, m1.token, { title: "m1 的对话" });
		await put(m1.token, m1Conv, p.id, 403);
		await put(m1.token, m1Conv, "prj_does_not_exist", 404);
		const outsiderProject = await newProject(t, outsider.token, "别的组织");
		await put(owner.token, mine, outsiderProject.id, 404);
		await put(owner.token, mine, undefined as any, 400);
		await t.json("POST", "/api/conversations", { token: owner.token, json: { projectId: p.id.replace("prj_", "prj_x") }, expect: 404 });
		await t.json("POST", "/api/conversations", { token: m1.token, json: { projectId: p.id }, expect: 403 });
		await t.json("POST", "/api/conversations", { token: owner.token, json: { projectId: outsiderProject.id }, expect: 404 });

		// legacy project conversations cannot move; neither in nor out
		const lp = (await t.json("POST", "/api/projects", { token: owner.token, json: { kind: "space", name: "旧版" } })).project;
		const legacyConv = await newConv(t, owner.token, { projectId: lp.id, title: "旧版里的对话" });
		const res = await t.req("PUT", `${base(legacyConv)}/project`, { token: owner.token, json: { projectId: p.id } });
		assert.equal(res.status, 409);
		assert.match(JSON.stringify(await res.json()), /旧版项目里的对话不能移动/);
		await put(owner.token, legacyConv, null, 409);
		// a legacy project cannot be a target either
		await put(owner.token, mine, lp.id, 404);
		// audit
		assert.ok((await t.json("GET", "/api/admin/audit?limit=100", { token: owner.token })).items.some((a: any) => a.action === "conversation.project.move"));
	} finally {
		await t.dispose();
	}
});

test("share: grantee READS the project's conversations (list/detail/entries/state/handoff/files) and can do nothing else; revoke is immediate", async () => {
	const t = await startTestApp();
	try {
		const { owner, m1, m2, outsider } = await setup(t);
		const p = await newProject(t, owner.token, "共享项目");
		const c = await newConv(t, owner.token, { projectId: p.id, title: "共享的对话" });
		const hidden = await newConv(t, owner.token, { title: "未放进项目" });
		await say(t, owner.token, c, "[[reply 共享的答案]]");
		await say(t, owner.token, hidden, "[[reply 不该被看到]]");
		const file = await deliverable(t, owner.me.userId, owner.me.orgId, c, "共享文件.txt", "共享文件内容");
		const hiddenFile = await deliverable(t, owner.me.userId, owner.me.orgId, hidden, "私有文件.txt", "私有内容");
		const dl = (f: any) => `/api/files/${f.fileId}/versions/${f.versionId}/download`;

		// before any share: nothing
		await t.json("GET", base(c), { token: m1.token, expect: 403 });
		await t.json("GET", `/api/conversations?projectId=${p.id}`, { token: m1.token, expect: 404 });
		assert.equal((await t.req("GET", dl(file), { token: m1.token })).status, 403);

		// grant
		const g = await t.json("PUT", `/api/projects/${p.id}/shares/${m1.me.userId}`, { token: owner.token, json: { permission: "read" } });
		assert.deepEqual({ userId: g.share.userId, name: g.share.name, email: g.share.email, permission: g.share.permission, grantedBy: g.share.grantedBy }, { userId: m1.me.userId, name: "Mia Member", email: "m1@a.example", permission: "read", grantedBy: owner.me.userId });
		assert.ok(g.share.grantedAt);
		await t.json("PUT", `/api/projects/${p.id}/shares/${m1.me.userId}`, { token: owner.token, json: { permission: "read" } }); // idempotent
		assert.equal((await t.json("GET", `/api/projects/${p.id}/shares`, { token: owner.token })).shares.length, 1);
		assert.equal((await t.json("GET", "/api/projects", { token: owner.token })).projects[0].shared, true);
		// only the owner manages shares
		await t.json("GET", `/api/projects/${p.id}/shares`, { token: m1.token, expect: 403 });
		await t.json("PUT", `/api/projects/${p.id}/shares/${m2.me.userId}`, { token: m1.token, json: { permission: "read" }, expect: 403 });
		await t.json("DELETE", `/api/projects/${p.id}/shares/${m1.me.userId}`, { token: m1.token, expect: 403 });
		await t.json("GET", `/api/projects/${p.id}/shares`, { token: m2.token, expect: 404 });

		// the grantee sees it as shared_read, with the conversation list, read-only
		const mine = (await t.json("GET", "/api/projects", { token: m1.token })).projects;
		assert.equal(mine.length, 1);
		assert.deepEqual({ kind: mine[0].kind, access: mine[0].access, shared: mine[0].shared, ownerName: mine[0].ownerName, conversationCount: mine[0].conversationCount }, { kind: "container", access: "shared_read", shared: true, ownerName: "Olivia Owner", conversationCount: 1 });
		const shown = (await t.json("GET", `/api/conversations?projectId=${p.id}`, { token: m1.token })).conversations;
		assert.deepEqual(shown.map((x: any) => [x.conversationId, x.access, x.projectName]), [[c.conversationId, "shared", "共享项目"]]);
		assert.equal((await t.json("GET", "/api/conversations", { token: m1.token })).conversations.length, 0, "shared conversations are not mixed into my recents");
		assert.equal((await t.json("GET", `/api/projects/${p.id}`, { token: m1.token })).project.access, "shared_read");
		const detail = await t.json("GET", base(c), { token: m1.token });
		assert.equal(detail.conversation.access, "shared");
		assert.equal(detail.conversation.title, "共享的对话");
		const es = (await t.json("GET", `${base(c)}/entries?limit=100`, { token: m1.token })).items;
		assert.ok(es.some((e: any) => e.kind === "assistant" && /共享的答案/.test(e.text)));
		const st = await t.json("GET", `${base(c)}/state`, { token: m1.token });
		assert.equal(st.conversation.access, "shared");
		assert.ok(st.entries.length > 0);
		await t.json("GET", `${base(c)}/handoff`, { token: m1.token });
		await t.json("GET", `${base(c)}/tasks`, { token: m1.token });
		// deliverables produced in the conversation: readable; the rest of the owner's space is not
		assert.equal(await (await t.req("GET", dl(file), { token: m1.token })).text(), "共享文件内容");
		await t.json("GET", `/api/files/${file.fileId}`, { token: m1.token });
		const fl = await t.json("GET", `/api/files?spaceId=${c.spaceId}&conversationId=${c.conversationId}`, { token: m1.token });
		assert.deepEqual(fl.files.map((f: any) => [f.name, f.canWrite]), [["共享文件.txt", false]]);
		await t.json("GET", `/api/files?spaceId=${c.spaceId}`, { token: m1.token, expect: 403 });
		assert.equal((await t.json("GET", "/api/files", { token: m1.token })).files.length, 0);
		assert.equal((await t.req("GET", dl(hiddenFile), { token: m1.token })).status, 403);
		await t.json("GET", base(hidden), { token: m1.token, expect: 403 });
		// a different org member without a share sees nothing
		await t.json("GET", base(c), { token: m2.token, expect: 403 });
		assert.equal((await t.req("GET", dl(file), { token: m2.token })).status, 403);

		// WRITE operations are all refused
		const sub = await t.json("POST", `${base(c)}/messages`, { token: m1.token, json: { text: "我也说一句", requestId: rid() }, expect: 403 });
		assert.ok(sub);
		await t.json("PATCH", base(c), { token: m1.token, json: { title: "被改名" }, expect: 403 });
		await t.json("PATCH", base(c), { token: m1.token, json: { archived: true }, expect: 403 });
		await t.json("PATCH", base(c), { token: m1.token, json: { modelId: "x" }, expect: 403 });
		const firstUser = es.find((e: any) => e.kind === "user");
		await t.json("POST", `${base(c)}/fork`, { token: m1.token, json: { entryId: firstUser.entryId }, expect: 403 });
		await t.json("POST", `${base(c)}/edit`, { token: m1.token, json: { entryId: firstUser.entryId, text: "改", requestId: rid() }, expect: 403 });
		await t.json("POST", `${base(c)}/regenerate`, { token: m1.token, json: { entryId: firstUser.entryId }, expect: 403 });
		await t.json("POST", `${base(c)}/abort`, { token: m1.token, json: {}, expect: 403 });
		await t.json("POST", `${base(c)}/continue`, { token: m1.token, json: {}, expect: 403 });
		await t.json("POST", `${base(c)}/approvals/ap_1`, { token: m1.token, json: { decision: "approved" }, expect: 403 });
		await t.json("PUT", `${base(c)}/project`, { token: m1.token, json: { projectId: null }, expect: 403 });
		await t.json("PUT", `/api/sandbox/${c.spaceId}/file?path=x.txt&conversationId=${c.conversationId}`, { token: m1.token, expect: 403 });
		await t.json("POST", `/api/sandbox/${c.spaceId}/mkdir`, { token: m1.token, json: { conversationId: c.conversationId, path: "d" }, expect: 403 });
		await t.json("GET", `/api/sandbox/${c.spaceId}/files?conversationId=${c.conversationId}`, { token: m1.token, expect: 403 }); // workspace is not part of a read share
		await t.json("POST", "/api/shares", { token: m1.token, json: { kind: "conversation", id: String(c.conversationId), spaceId: c.spaceId }, expect: 403 });
		const up = new FormData();
		up.set("file", new File(["new"], "共享文件.txt", { type: "text/plain" }));
		assert.equal((await t.req("POST", `/api/files/${file.fileId}/versions`, { token: m1.token, body: up })).status, 403);
		assert.equal((await t.req("DELETE", `/api/files/${file.fileId}`, { token: m1.token })).status, 403);
		await t.json("PATCH", `/api/projects/${p.id}`, { token: m1.token, json: { name: "我改的" }, expect: 403 });
		await t.json("DELETE", `/api/projects/${p.id}`, { token: m1.token, expect: 403 });
		await t.json("POST", "/api/conversations", { token: m1.token, json: { projectId: p.id }, expect: 403 });
		// nothing changed
		const still = await t.json("GET", base(c), { token: owner.token });
		assert.equal(still.conversation.title, "共享的对话");
		assert.equal(still.conversation.archived, false);
		assert.equal((await t.json("GET", `${base(c)}/entries?limit=100`, { token: owner.token })).items.filter((e: any) => e.kind === "user").length, 1);

		// moving the conversation OUT of the project revokes the read at once; moving it back restores it
		await t.json("PUT", `${base(c)}/project`, { token: owner.token, json: { projectId: null } });
		await t.json("GET", base(c), { token: m1.token, expect: 403 });
		assert.equal((await t.req("GET", dl(file), { token: m1.token })).status, 403);
		assert.equal((await t.json("GET", "/api/projects", { token: m1.token })).projects[0].conversationCount, 0);
		const back = await t.json("PUT", `${base(c)}/project`, { token: owner.token, json: { projectId: p.id } });
		assert.equal(back.visibleTo, 1, "the UI warns: visible to N people");
		await t.json("GET", base(c), { token: m1.token });

		// revoke: immediate everywhere
		await t.json("DELETE", `/api/projects/${p.id}/shares/${m1.me.userId}`, { token: owner.token });
		await t.json("GET", base(c), { token: m1.token, expect: 403 });
		await t.json("GET", `${base(c)}/entries`, { token: m1.token, expect: 403 });
		await t.json("GET", `${base(c)}/state`, { token: m1.token, expect: 403 });
		assert.equal((await t.req("GET", dl(file), { token: m1.token })).status, 403);
		await t.json("GET", `/api/conversations?projectId=${p.id}`, { token: m1.token, expect: 404 });
		await t.json("GET", `/api/projects/${p.id}`, { token: m1.token, expect: 404 });
		assert.equal((await t.json("GET", "/api/projects", { token: m1.token })).projects.length, 0);
		assert.equal((await t.json("GET", `/api/projects/${p.id}/shares`, { token: owner.token })).shares.length, 0);

		// validation: self, unsupported permission, unknown / other-org users
		await t.json("PUT", `/api/projects/${p.id}/shares/${owner.me.userId}`, { token: owner.token, json: { permission: "read" }, expect: 400 });
		for (const permission of ["write", "admin", "owner", ""]) {
			const r = await t.req("PUT", `/api/projects/${p.id}/shares/${m2.me.userId}`, { token: owner.token, json: { permission } });
			assert.equal(r.status, 400, `permission ${permission}`);
		}
		assert.match(JSON.stringify(await (await t.req("PUT", `/api/projects/${p.id}/shares/${m2.me.userId}`, { token: owner.token, json: { permission: "write" } })).json()), /暂不支持/);
		await t.json("PUT", `/api/projects/${p.id}/shares/${outsider.me.userId}`, { token: owner.token, json: { permission: "read" }, expect: 404 });
		await t.json("PUT", `/api/projects/${p.id}/shares/usr_nobody`, { token: owner.token, json: { permission: "read" }, expect: 404 });
		assert.equal((await t.json("GET", `/api/projects/${p.id}/shares`, { token: owner.token })).shares.length, 0);
		const audit = (await t.json("GET", "/api/admin/audit?limit=200", { token: owner.token })).items.map((a: any) => a.action);
		assert.ok(audit.includes("project.share.grant") && audit.includes("project.share.revoke"));

		// deleting the project drops its shares and everyone's access
		await t.json("PUT", `/api/projects/${p.id}/shares/${m1.me.userId}`, { token: owner.token, json: { permission: "read" } });
		await t.json("GET", base(c), { token: m1.token });
		await t.json("DELETE", `/api/projects/${p.id}`, { token: owner.token });
		await t.json("GET", base(c), { token: m1.token, expect: 403 });
		assert.equal(t.app.ctx.db.get<any>("SELECT COUNT(*) AS n FROM id_project_shares WHERE project_id = ?", p.id).n, 0);
	} finally {
		await t.dispose();
	}
});

test("share: an open SSE stream of the grantee closes (forbidden) within seconds of the revocation; the owner's stream keeps running", async () => {
	const t = await startTestApp();
	try {
		const { owner, m1 } = await setup(t);
		const p = await newProject(t, owner.token, "流");
		const c = await newConv(t, owner.token, { projectId: p.id, title: "流式" });
		await say(t, owner.token, c, "[[reply hello]]");
		await t.json("PUT", `/api/projects/${p.id}/shares/${m1.me.userId}`, { token: owner.token, json: { permission: "read" } });
		const mine = sseReader(await t.req("GET", `${base(c)}/events`, { token: m1.token }));
		const theirs = sseReader(await t.req("GET", `${base(c)}/events`, { token: owner.token }));
		const snap = await mine.state((s) => s.entries.length > 0);
		assert.equal(snap.conversation.access, "shared");
		await theirs.state((s) => s.entries.length > 0);
		const t0 = Date.now();
		await t.json("DELETE", `/api/projects/${p.id}/shares/${m1.me.userId}`, { token: owner.token });
		const err = await mine.next((e) => e.event === "error", 8000);
		assert.equal(err.data.code, "forbidden");
		assert.ok(Date.now() - t0 < 5000, "closed within a few seconds");
		// the stream really ended: nothing after the error (a later owner write produces no state for the revoked grantee)
		await waitFor(() => mine.ended, { timeoutMs: 3000, what: "grantee stream closed" });
		await say(t, owner.token, c, "[[reply later]]");
		await theirs.state((s) => s.entries.some((e: any) => e.kind === "assistant" && /later/.test(e.text)));
		await mine.close();
		await theirs.close();
		// a fresh stream is refused up front
		const res = await t.req("GET", `${base(c)}/events`, { token: m1.token });
		assert.equal(res.status, 403);
	} finally {
		await t.dispose();
	}
});

test("share: a pending approval cannot be decided by a grantee (read-only), and removing the grantee from the org ends the share", async () => {
	const t = await startTestApp();
	try {
		const { owner, m1 } = await setup(t);
		const p = await newProject(t, owner.token, "审批");
		const c = await newConv(t, owner.token, { projectId: p.id });
		const sse = sseReader(await t.req("GET", `${base(c)}/events`, { token: owner.token }));
		await t.json("POST", `${base(c)}/messages`, { token: owner.token, json: { text: `[[call wr_fixture_approval {"title":"发送","summary":"发送报价"}]]`, requestId: rid() } });
		const waiting = await sse.state((s) => s.approvals.some((x) => x.status === "pending"));
		const ap = waiting.approvals[0]!;
		await t.json("PUT", `/api/projects/${p.id}/shares/${m1.me.userId}`, { token: owner.token, json: { permission: "read" } });
		// the grantee SEES the pending approval but cannot decide it
		const st = await t.json("GET", `${base(c)}/state`, { token: m1.token });
		assert.equal(st.approvals[0].status, "pending");
		await t.json("POST", `${base(c)}/approvals/${ap.approvalId}`, { token: m1.token, json: { decision: "approved" }, expect: 403 });
		await t.json("POST", `${base(c)}/approvals/${ap.approvalId}`, { token: owner.token, json: { decision: "rejected" } });
		await sse.close();
		// removing the member from the org: the share row goes, nothing readable
		const out = await t.json("DELETE", `/api/admin/members/${m1.me.userId}`, { token: owner.token });
		assert.equal(out.projectShares, 1);
		assert.equal(t.app.ctx.db.get<any>("SELECT COUNT(*) AS n FROM id_project_shares").n, 0);
		await t.json("GET", base(c), { token: m1.token, expect: 401 });
	} finally {
		await t.dispose();
	}
});

test("share: a disabled / removed OWNER takes the grantee's access with them; a disabled grantee is refused", async () => {
	const t = await startTestApp();
	try {
		const { owner, m1, m2 } = await setup(t);
		// m2 owns a project shared with m1
		const p = await newProject(t, m2.token, "m2 的项目");
		const c = await newConv(t, m2.token, { projectId: p.id });
		await t.json("PUT", `/api/projects/${p.id}/shares/${m1.me.userId}`, { token: m2.token, json: { permission: "read" } });
		await t.json("GET", base(c), { token: m1.token });
		await t.json("POST", `/api/admin/members/${m2.me.userId}/disable`, { token: owner.token });
		await t.json("GET", base(c), { token: m1.token, expect: 403 });
		assert.equal((await t.json("GET", "/api/projects", { token: m1.token })).projects.length, 0);
		await t.json("POST", `/api/admin/members/${m2.me.userId}/enable`, { token: owner.token });
		await t.json("GET", base(c), { token: m1.token });
		await t.json("POST", `/api/admin/members/${m1.me.userId}/disable`, { token: owner.token });
		await t.json("GET", base(c), { token: m1.token, expect: 401 });
	} finally {
		await t.dispose();
	}
});

test("directory: same-org active people only (name/email contains, max 20), never other orgs, no disabled users", async () => {
	const t = await startTestApp();
	try {
		const { owner, m1, m2, outsider } = await setup(t);
		const ids = t.app.ctx.services.get("identity") as Identity;
		for (let i = 0; i < 24; i++) ids.createUser({ email: `bulk${String(i).padStart(2, "0")}@a.example`, name: `Bulk ${i}`, password: null, orgId: owner.me.orgId });
		const all = (await t.json("GET", "/api/directory", { token: m1.token })).users;
		assert.equal(all.length, 20, "capped at 20");
		assert.ok(all.every((u: any) => typeof u.userId === "string" && u.name && u.email));
		assert.ok(!all.some((u: any) => u.userId === m1.me.userId), "the caller is not offered");
		assert.ok(!JSON.stringify(all).includes("b.example"), "other orgs never");
		const byName = (await t.json("GET", "/api/directory?q=max", { token: m1.token })).users;
		assert.deepEqual(byName.map((u: any) => u.email), ["m2@a.example"]);
		const byEmail = (await t.json("GET", "/api/directory?q=" + encodeURIComponent("OWNER@a"), { token: m1.token })).users;
		assert.deepEqual(byEmail.map((u: any) => u.name), ["Olivia Owner"]);
		assert.equal((await t.json("GET", "/api/directory?q=bulk1", { token: m1.token })).users.length, 10);
		assert.deepEqual((await t.json("GET", "/api/directory?q=%25", { token: m1.token })).users, [], "LIKE wildcards are literal");
		assert.deepEqual((await t.json("GET", "/api/directory?q=otto", { token: m1.token })).users, []);
		assert.deepEqual((await t.json("GET", "/api/directory?q=a.example", { token: outsider.token })).users, []);
		assert.equal((await t.json("GET", "/api/directory", { token: outsider.token })).users.length, 0);
		// disabled users (member-level or user-level) and removed ones vanish, emails included
		await t.json("POST", `/api/admin/members/${m2.me.userId}/disable`, { token: owner.token });
		assert.ok(!JSON.stringify((await t.json("GET", "/api/directory?q=m2", { token: m1.token })).users).includes("m2@a.example"));
		ids.db.run("UPDATE id_users SET disabled_at = ? WHERE email = 'bulk00@a.example'", new Date().toISOString());
		assert.deepEqual((await t.json("GET", "/api/directory?q=bulk00", { token: m1.token })).users, []);
		await t.json("GET", "/api/directory", { expect: 401 });
	} finally {
		await t.dispose();
	}
});

test("cross-org: another organisation gets 404 on every container project route and can neither share to nor move into it", async () => {
	const t = await startTestApp();
	try {
		const { owner, m1, outsider } = await setup(t);
		const p = await newProject(t, owner.token, "A 的项目");
		const c = await newConv(t, owner.token, { projectId: p.id, title: "A 的对话" });
		await say(t, owner.token, c, "[[reply 机密答案]]");
		const file = await deliverable(t, owner.me.userId, owner.me.orgId, c, "机密.txt", "机密");
		await t.json("PUT", `/api/projects/${p.id}/shares/${m1.me.userId}`, { token: owner.token, json: { permission: "read" } });
		const O = outsider.token;
		for (const [method, path, json] of [
			["GET", `/api/projects/${p.id}`],
			["PATCH", `/api/projects/${p.id}`, { name: "x" }],
			["DELETE", `/api/projects/${p.id}`],
			["GET", `/api/projects/${p.id}/shares`],
			["PUT", `/api/projects/${p.id}/shares/${outsider.me.userId}`, { permission: "read" }],
			["PUT", `/api/projects/${p.id}/shares/${m1.me.userId}`, { permission: "read" }],
			["DELETE", `/api/projects/${p.id}/shares/${m1.me.userId}`],
			["GET", `/api/conversations?projectId=${p.id}`],
		] as const) {
			const r = await t.req(method, path, { token: O, json });
			assert.equal(r.status, 404, `${method} ${path} → ${r.status}`);
		}
		await t.json("POST", "/api/conversations", { token: O, json: { projectId: p.id }, expect: 404 });
		const theirs = await newConv(t, O, { title: "B 的对话" });
		await t.json("PUT", `${base(theirs)}/project`, { token: O, json: { projectId: p.id }, expect: 404 });
		await t.json("PUT", `${base(c)}/project`, { token: O, json: { projectId: null }, expect: 403 });
		await t.json("GET", base(c), { token: O, expect: 403 });
		assert.equal((await t.req("GET", `/api/files/${file.fileId}/versions/${file.versionId}/download`, { token: O })).status, 403);
		assert.equal((await t.json("GET", "/api/projects", { token: O })).projects.length, 0);
		// even a forged share row (a bug, a bad import) never works across organisations
		t.app.ctx.db.run("INSERT INTO id_project_shares (project_id, org_id, user_id, permission, granted_by, granted_at) VALUES (?, ?, ?, 'read', ?, ?)", p.id, owner.me.orgId, outsider.me.userId, owner.me.userId, new Date().toISOString());
		await t.json("GET", base(c), { token: O, expect: 403 });
		assert.equal((await t.json("GET", "/api/projects", { token: O })).projects.length, 0);
		t.app.ctx.db.run("DELETE FROM id_project_shares WHERE user_id = ?", outsider.me.userId);
		// A's data intact
		assert.equal((await t.json("GET", `/api/projects/${p.id}`, { token: owner.token })).project.name, "A 的项目");
		assert.equal((await t.json("GET", `/api/projects/${p.id}/shares`, { token: owner.token })).shares.length, 1);
	} finally {
		await t.dispose();
	}
});

test("soft-deleted conversations (deleted_at) vanish from lists, counts, access and shares", async (tt) => {
	const t = await startTestApp();
	try {
		if (!hasDeletedColumn(t)) return tt.skip("rt_conversations.deleted_at not present (meta migration not loaded)");
		const { owner, m1 } = await setup(t);
		const p = await newProject(t, owner.token, "删除测试");
		const keep = await newConv(t, owner.token, { projectId: p.id, title: "保留" });
		const gone = await newConv(t, owner.token, { projectId: p.id, title: "将被删除" });
		await t.json("PUT", `/api/projects/${p.id}/shares/${m1.me.userId}`, { token: owner.token, json: { permission: "read" } });
		await t.json("GET", base(gone), { token: m1.token });
		assert.equal((await t.json("GET", "/api/projects", { token: owner.token })).projects[0].conversationCount, 2);
		t.app.ctx.db.run("UPDATE rt_conversations SET deleted_at = ? WHERE space_id = ? AND conversation_id = ?", new Date().toISOString(), gone.spaceId, gone.conversationId);
		for (const token of [owner.token, m1.token]) {
			const list = (await t.json("GET", `/api/conversations?projectId=${p.id}`, { token })).conversations;
			assert.deepEqual(list.map((x: any) => x.title), ["保留"]);
		}
		assert.deepEqual((await t.json("GET", "/api/conversations", { token: owner.token })).conversations.map((x: any) => x.title), ["保留"]);
		assert.equal((await t.json("GET", "/api/projects", { token: owner.token })).projects[0].conversationCount, 1);
		assert.equal((await t.json("GET", "/api/projects", { token: m1.token })).projects[0].conversationCount, 1);
		for (const path of ["", "/entries", "/state"]) {
			assert.equal((await t.req("GET", `${base(gone)}${path}`, { token: owner.token })).status, 404, `owner ${path}`);
			assert.ok((await t.req("GET", `${base(gone)}${path}`, { token: m1.token })).status >= 400, `grantee ${path}`);
		}
		assert.equal((await t.req("PATCH", base(gone), { token: owner.token, json: { title: "x" } })).status, 404);
		assert.equal((await t.req("PUT", `${base(gone)}/project`, { token: owner.token, json: { projectId: null } })).status, 404);
		await t.json("GET", base(keep), { token: m1.token });
		// the project can still be deleted: detaching includes the deleted row's relation, nothing is destroyed
		const del = await t.json("DELETE", `/api/projects/${p.id}`, { token: owner.token });
		assert.equal(del.detached, 2);
		assert.equal(t.app.ctx.db.get<any>("SELECT COUNT(*) AS n FROM rt_conversations WHERE space_id = ?", gone.spaceId).n, 2);
	} finally {
		await t.dispose();
	}
});

test("migration on an existing DB: legacy projects get kind 'space', stay listed and usable; container projects can then be added", async () => {
	const t = await startTestApp();
	const dataDir = t.dataDir;
	let t2: TestApp | undefined;
	try {
		const { owner, m1 } = await setup(t);
		const lp = (await t.json("POST", "/api/projects", { token: owner.token, json: { kind: "space", name: "存量项目" } })).project;
		await t.json("PUT", `/api/projects/${lp.id}/members`, { token: owner.token, json: { email: "m1@a.example", role: "viewer" } });
		const c = await newConv(t, owner.token, { projectId: lp.id, title: "存量对话" });
		await say(t, owner.token, c, "[[reply 存量]]");
		await t.stop();
		// Turn the database back into its round-8 shape: no kind / updated_at columns, no shares table, migration v5 not recorded.
		const raw = new DatabaseSync(join(dataDir, "app.sqlite"));
		raw.exec("DROP INDEX id_projects_owner; DROP TABLE id_project_shares; ALTER TABLE id_projects DROP COLUMN kind; ALTER TABLE id_projects DROP COLUMN updated_at; DELETE FROM _migrations WHERE module = 'identity' AND version = 5;");
		assert.ok(!raw.prepare("PRAGMA table_info(id_projects)").all().some((r: any) => r.name === "kind"));
		raw.close();

		t2 = await startTestApp({ dataDir });
		const kinds = t2.app.ctx.db.all<{ id: string; kind: string; updated_at: string | null }>("SELECT id, kind, updated_at FROM id_projects");
		assert.deepEqual(kinds.map((k) => [k.id, k.kind]), [[lp.id, "space"]]);
		assert.equal(kinds[0]!.updated_at, null, "existing rows are not rewritten");
		// sessions survive a restart (same DB): the old tokens still work
		const list = (await t2.json("GET", "/api/projects", { token: m1.token })).projects;
		assert.deepEqual(list.map((p: any) => [p.id, p.kind, p.role, p.spaceId, p.conversationCount, p.updatedAt === p.createdAt]), [[lp.id, "space", "viewer", lp.spaceId, 1, true]]);
		const es = (await t2.json("GET", `${base(c)}/entries?limit=50`, { token: m1.token })).items;
		assert.ok(es.some((e: any) => e.kind === "assistant" && /存量/.test(e.text)));
		const cp = await newProject(t2, owner.token, "迁移后的容器");
		assert.equal(cp.kind, "container");
		assert.equal((await t2.json("GET", "/api/projects", { token: owner.token })).projects.length, 2);
		await t2.json("PUT", `/api/projects/${cp.id}/shares/${m1.me.userId}`, { token: owner.token, json: { permission: "read" } });
	} finally {
		await t2?.dispose();
		await t.dispose();
	}
});
