// Integrator acceptance (X-LOOP, X-ISO): the user-facing loop through the public HTTP API only, with a real restart.
// Goal → upload source → add to project KB explicitly → cite it → approval → deliver a file (present_file) → download → re-deliver in place →
// restart server on the same data dir → history, files, branch still there and conversation continues.
// Plus: second user isolation / viewer / revocation, and same-name file isolation across projects.
process.env.WORKROOM_FIXTURE_TOOLS = "1"; // test-only approval tool (never installed in a normal deployment)
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { waitFor } from "../src/runtime/testing.ts";

const md = (s: string) => new Blob([s], { type: "text/markdown" });

async function upload(t: TestApp, token: string, projectId: string, name: string, content: string) {
	const fd = new FormData();
	fd.set("file", new File([md(content)], name, { type: "text/markdown" }));
	fd.set("projectId", projectId);
	const res = await t.req("POST", "/api/files", { token, body: fd });
	assert.equal(res.status, 200, await res.clone().text());
	return (await res.json()) as any;
}

async function state(t: TestApp, token: string, spaceId: string, id: number) {
	return t.json("GET", `/api/conversations/${spaceId}/${id}/state`, { token });
}

async function send(t: TestApp, token: string, spaceId: string, id: number, text: string, extra: object = {}) {
	return t.json("POST", `/api/conversations/${spaceId}/${id}/messages`, { token, json: { text, requestId: randomUUID(), ...extra } });
}

async function idle(t: TestApp, token: string, spaceId: string, id: number, what: string) {
	return waitFor(async () => {
		const s = await state(t, token, spaceId, id);
		return !s.live.busy && s.queue.length === 0 ? s : undefined;
	}, { timeoutMs: 30_000, what });
}

const toolResults = (s: any, name: string) => s.entries.filter((e: any) => e.kind === "tool_result" && e.toolName === name);

test("X-LOOP: goal → knowledge citation → approval → deliver → re-deliver in place → restart → continue; X-ISO isolation", { timeout: 180_000 }, async () => {
	let t = await startTestApp();
	const dataDir = t.dataDir;
	try {
		const alice = await t.user("alice@acme.test");
		const { project } = await t.json("POST", "/api/projects", { token: alice.token, json: { kind: "space", name: "季度复盘" } });
		const { project: other } = await t.json("POST", "/api/projects", { token: alice.token, json: { kind: "space", name: "另一个项目" } });

		// 1. Source material, explicitly added to a project knowledge base.
		const src = await upload(t, alice.token, project.id, "销售数据说明.md", "# 销售数据说明\n\n华东区第三季度回款率为 87.5%，主要风险是账期延长。\n");
		const kbRes = await t.json("POST", "/api/kb", { token: alice.token, json: { name: "复盘资料", scope: "project", projectId: project.id } });
		const kb = kbRes.kb ?? kbRes;
		// Upload alone must not make knowledge available (M08-C): the KB has no docs yet.
		const before = await t.json("POST", "/api/kb/search", { token: alice.token, json: { query: "回款率", kbIds: [kb.id] } });
		assert.equal(before.citations.length, 0, "uploaded file must not be searchable before explicit KB add");
		await t.json("POST", `/api/kb/${kb.id}/docs`, { token: alice.token, json: { fileId: src.file.id, versionId: src.version.versionId } });
		await waitFor(async () => {
			const docs = await t.json("GET", `/api/kb/${kb.id}/docs`, { token: alice.token });
			const d = docs.docs[0];
			if (d?.availability === "failed") throw new Error(`ingest failed: ${JSON.stringify(d)}`);
			return d?.availability === "ready" ? d : undefined;
		}, { timeoutMs: 30_000, what: "kb doc ready" });

		// 2. Conversation in the project space; knowledge reference chip + kb_search.
		const { conversation } = await t.json("POST", "/api/conversations", { token: alice.token, json: { projectId: project.id, title: "Q3 复盘" } });
		const sp = conversation.spaceId as string;
		const cid = conversation.conversationId as number;
		// M01-A: same conversation, no workflow choice — plain chat, then an attachment, then a knowledge reference.
		await send(t, alice.token, sp, cid, "你好，先简单聊两句");
		let plain = await idle(t, alice.token, sp, cid, "plain chat");
		assert.ok(plain.entries.some((e: any) => e.kind === "assistant" && e.text && e.toolCalls.length === 0), "plain chat answered without tools");
		await send(t, alice.token, sp, cid, `看看附件 [[call ls {"path":"/uploads"}]]`, { attachments: [{ fileId: src.file.id, versionId: src.version.versionId, name: "销售数据说明.md" }] });
		plain = await idle(t, alice.token, sp, cid, "attachment run");
		const att = plain.entries.filter((e: any) => e.kind === "user").at(-1);
		assert.equal(att.attachments?.[0]?.versionId, src.version.versionId, "attachment recorded on the user message");
		// Round 14: attachments are read under /uploads/<message>/<name> (ls finds the message directory, read returns the content).
		const msgDir = /\[目录\] (m\d+)\//.exec(toolResults(plain, "ls")[0].text)?.[1];
		assert.ok(msgDir, toolResults(plain, "ls")[0].text);
		await send(t, alice.token, sp, cid, `[[call read {"path":"/uploads/${msgDir}/销售数据说明.md"}]]`);
		plain = await idle(t, alice.token, sp, cid, "read attachment run");
		assert.match(toolResults(plain, "read")[0].text, /87\.5%/, "agent read the attached file");
		await send(t, alice.token, sp, cid, `帮我做一份华东区复盘 [[call kb_search {"query":"回款率"}]]`, { knowledgeRefs: [{ kbId: kb.id, name: "复盘资料" }] });
		let s = await idle(t, alice.token, sp, cid, "kb_search run");
		const kr = toolResults(s, "kb_search")[0];
		assert.ok(kr && !kr.isError, `kb_search result: ${JSON.stringify(kr)}`);
		const cit = (kr.details as any).citations[0];
		assert.equal(cit.fileId, src.file.id);
		assert.equal(cit.versionId, src.version.versionId, "citation pinned to exact file version");
		assert.match(cit.snippet, /87\.5%/);

		// 3. Approval: run waits for the user, decision is durable.
		await send(t, alice.token, sp, cid, `[[call wr_fixture_approval {"title":"发送复盘","summary":"把复盘发给区域经理"}]]`);
		const pending = await waitFor(async () => (await state(t, alice.token, sp, cid)).approvals.find((a: any) => a.status === "pending"), { what: "pending approval" });
		assert.equal((await state(t, alice.token, sp, cid)).live.status, "waiting_approval");
		await t.json("POST", `/api/conversations/${sp}/${cid}/approvals/${encodeURIComponent(pending.approvalId)}`, { token: alice.token, json: { decision: "approved" } });
		s = await idle(t, alice.token, sp, cid, "approval run");
		assert.match(toolResults(s, "wr_fixture_approval")[0].text, /decision: approved/);

		// 4. Deliverable (round 14: write to /work + present_file; no versions), downloadable through the library item.
		await send(t, alice.token, sp, cid, `[[call write {"path":"/work/华东区复盘.md","content":"# 结论\\n\\n回款率 87.5%。"}]] [[call present_file {"source":"/work/华东区复盘.md"}]]`);
		s = await idle(t, alice.token, sp, cid, "present run");
		const out1 = (toolResults(s, "present_file")[0].details as any);
		assert.equal(out1.kind, "wr.presented");
		assert.equal(out1.status, "created");
		const item = out1.item;
		const d1 = await t.req("GET", item.downloadUrl, { token: alice.token });
		assert.equal(d1.status, 200);
		const v1Text = await d1.text();
		assert.equal(v1Text, "# 结论\n\n回款率 87.5%。");

		// 5. Same-name re-delivery updates the same file in place (no second row, no version list).
		await send(t, alice.token, sp, cid, `[[call write {"path":"/work/华东区复盘.md","content":"# 结论\\n\\n回款率 87.5%。\\n\\n# 风险\\n\\n账期延长。"}]] [[call present_file {"source":"/work/华东区复盘.md"}]]`);
		s = await idle(t, alice.token, sp, cid, "present again run");
		const out2 = (toolResults(s, "present_file")[1].details as any);
		assert.equal(out2.status, "updated");
		assert.equal(out2.item.fileId, item.fileId);
		const lib = await t.json("GET", `/api/library?spaceId=${sp}&conversationId=${cid}`, { token: alice.token });
		assert.equal(lib.items.length, 1, "one output, updated in place");
		assert.match(await (await t.req("GET", item.downloadUrl, { token: alice.token })).text(), /# 风险/);

		// 6. Branch from the first assistant answer; original untouched.
		const firstAnswer = s.entries.find((e: any) => e.kind === "assistant");
		const originalCount = s.entries.length;
		const { conversation: branch } = await t.json("POST", `/api/conversations/${sp}/${cid}/fork`, { token: alice.token, json: { entryId: firstAnswer.id } });
		await send(t, alice.token, sp, branch.conversationId, "分支里换个角度");
		await idle(t, alice.token, sp, branch.conversationId, "branch run");
		assert.equal((await state(t, alice.token, sp, cid)).entries.length, originalCount, "fork must not modify the original");

		// 7. Same-name file in another project is a distinct file, invisible from the first project's listing.
		const dup = await upload(t, alice.token, other.id, "销售数据说明.md", "另一个项目的同名文件");
		assert.notEqual(dup.file.id, src.file.id);
		const listP = await t.json("GET", `/api/files?projectId=${project.id}`, { token: alice.token });
		assert.ok(!(listP.files ?? listP.items).some((f: any) => f.id === dup.file.id), "cross-project listing leak");

		// 8. Second user (same org via invite): isolated → viewer → revoked.
		const invite = await t.json("POST", "/api/org/invites", { token: alice.token, json: { role: "member" } }).catch(async () => t.json("POST", "/api/admin/invites", { token: alice.token, json: { role: "member" } }));
		const code = invite.code ?? invite.invite?.code;
		const bob = await t.user("bob@acme.test", { inviteCode: code });
		assert.equal(bob.me.orgId, alice.me.orgId);
		await t.json("GET", `/api/conversations/${sp}/${cid}/state`, { token: bob.token, expect: 403 });
		assert.equal((await t.req("GET", item.downloadUrl, { token: bob.token })).status, 403);
		assert.equal((await t.json("POST", "/api/kb/search", { token: bob.token, json: { query: "回款率" } })).citations.length, 0, "non-member retrieval leak");

		await t.json("PUT", `/api/projects/${project.id}/members`, { token: alice.token, json: { email: "bob@acme.test", role: "viewer" } });
		await t.json("GET", `/api/conversations/${sp}/${cid}/state`, { token: bob.token });
		assert.equal((await t.req("GET", item.downloadUrl, { token: bob.token })).status, 200);
		const bobSend = await t.req("POST", `/api/conversations/${sp}/${cid}/messages`, { token: bob.token, json: { text: "viewer 不应能发消息", requestId: randomUUID() } });
		assert.equal(bobSend.status, 403, "viewer must not write");
		assert.ok((await t.json("POST", "/api/kb/search", { token: bob.token, json: { query: "回款率" } })).citations.length > 0, "viewer can retrieve project knowledge");

		await t.json("PUT", `/api/projects/${project.id}/members`, { token: alice.token, json: { email: "bob@acme.test", role: null } });
		await t.json("GET", `/api/conversations/${sp}/${branch.conversationId}/state`, { token: bob.token, expect: 403 });
		assert.equal((await t.req("GET", item.downloadUrl, { token: bob.token })).status, 403);
		assert.equal((await t.json("POST", "/api/kb/search", { token: bob.token, json: { query: "回款率" } })).citations.length, 0, "revoked retrieval leak");

		// 9. Restart on the same data dir: everything is still there and the conversation continues.
		await t.stop();
		t = await startTestApp({ dataDir });
		const login = await t.json("POST", "/api/auth/login", { json: { email: "alice@acme.test", password: "password123" } });
		const after = await state(t, login.token, sp, cid);
		assert.equal(after.entries.length, originalCount, "history survives restart");
		assert.match(await (await t.req("GET", item.downloadUrl, { token: login.token })).text(), /# 风险/, "the delivered file is identical after restart");
		const { conversation: br } = await t.json("GET", `/api/conversations/${sp}/${branch.conversationId}`, { token: login.token });
		assert.ok(br, "branch survives restart");
		await send(t, login.token, sp, cid, "继续：总结三条行动项");
		const cont = await idle(t, login.token, sp, cid, "post-restart run");
		assert.ok(cont.entries.length > originalCount, "conversation continues after restart");
	} finally {
		await t.dispose();
		const { rmSync } = await import("node:fs");
		rmSync(dataDir, { recursive: true, force: true });
	}
});
