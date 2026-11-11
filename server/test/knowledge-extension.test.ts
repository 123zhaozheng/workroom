// pi-durable extension "wr.knowledge" through the REAL runtime (group A) with the fixture model:
// kb_search (numbered citations + details, scope defaults, knowledgeRefs, ACL as the run's author),
// memory/knowledge_scope prompt sections (no private memory in project conversations), memory_save.
process.env.WORKROOM_FIXTURE_TOOLS ??= "1";
process.env.WORKROOM_RT_RETRY_MAX ??= "1";
process.env.WORKROOM_RT_RETRY_BASE_MS ??= "20";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { isSettled, waitFor } from "../src/runtime/testing.ts";
import { joinOrg, kbWithDoc, MIME, uploadVersion, waitDoc } from "../src/knowledge/testing.ts";

type Conv = { spaceId: string; conversationId: number };
const base = (c: Conv) => `/api/conversations/${c.spaceId}/${c.conversationId}`;

async function newChat(t: TestApp, token: string, body: Record<string, unknown> = {}): Promise<Conv> {
	return (await t.json("POST", "/api/conversations", { token, json: body })).conversation;
}
async function run(t: TestApp, token: string, c: Conv, text: string, extra: Record<string, unknown> = {}) {
	const r = await t.json("POST", `${base(c)}/messages`, { token, json: { text, requestId: randomUUID(), ...extra } });
	return waitFor(async () => {
		const s = await t.json("GET", `${base(c)}/submissions/${r.submissionId}`, { token });
		return isSettled(s) ? s : undefined;
	}, { timeoutMs: 20_000, what: "submission settles" });
}
async function rawEntries(t: TestApp, c: Conv): Promise<any[]> {
	const h = await t.app.ctx.services.get("runtime").harness(c.spaceId, BACKGROUND_CONTEXT);
	const conv = (await h.conversation(c.conversationId as any, BACKGROUND_CONTEXT))!;
	return (await conv.entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT)).items as any[];
}
/** Tool results of a tool, in order. */
async function toolResults(t: TestApp, c: Conv, name: string): Promise<{ text: string; details: any; isError: boolean }[]> {
	return (await rawEntries(t, c))
		.filter((e) => e.kind === "pi.tool-result" && e.model?.[0]?.toolName === name)
		.map((e) => ({ text: e.model[0].content.map((x: any) => x.text ?? "").join(""), details: e.model[0].details, isError: !!e.model[0].isError }));
}
/** Effective system-prompt sections (pi re-sends only changed sections: fold all pi.system entries). */
async function sections(t: TestApp, c: Conv): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const e of await rawEntries(t, c)) if (e.kind === "pi.system") Object.assign(out, e.model?.[0]?.sections ?? {});
	return out;
}

test("kb_search tool: numbered citations + details, project-scope default, knowledgeRefs honoured, ACL of the run's author", async () => {
	const t = await startTestApp();
	try {
		const alice = await t.user("alice@example.com", { name: "Alice" });
		const bob = await joinOrg(t, alice.me.orgId, "bob@example.com");
		const { project } = await t.json("POST", "/api/projects", { token: alice.token, json: { kind: "space", name: "Apollo" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: alice.token, json: { email: "bob@example.com", role: "editor" } });
		const proj = await kbWithDoc(t, alice.token, { name: "Apollo 资料", scope: "project", projectId: project.id }, { name: "apollo-plan.md", mime: MIME.md, bytes: "# 计划\n\n## 发射\n\nThe launch window opens on November 20." });
		const mine = await kbWithDoc(t, alice.token, { name: "我的笔记", scope: "personal" }, { name: "vault.txt", mime: MIME.txt, bytes: "Personal: the vault combination is 4417." });

		const c = await newChat(t, alice.token, { spaceId: project.spaceId });
		await run(t, alice.token, c, '[[call kb_search {"query":"launch window"}]]');
		let [r] = await toolResults(t, c, "kb_search");
		assert.equal(r!.isError, false);
		assert.equal(r!.details.kind, "wr.kb_search");
		const cit = r!.details.citations[0];
		assert.equal(cit.n, 1);
		assert.equal(cit.fileName, "apollo-plan.md");
		assert.equal(cit.section, "计划 > 发射");
		assert.equal(cit.versionId, proj.file.versionId);
		assert.match(r!.text, /\[1\] apollo-plan\.md（v1，章节：计划 > 发射/);
		assert.deepEqual(r!.details.diagnostics.searchedKbIds, [proj.kb.id]);

		// Personal KB is NOT searched by default in a project conversation (visible to other members)…
		await run(t, alice.token, c, '[[call kb_search {"query":"vault combination"}]]');
		r = (await toolResults(t, c, "kb_search"))[1];
		assert.equal(r!.details.citations.length, 0);
		assert.equal(r!.details.diagnostics.reason, "no_evidence");
		assert.match(r!.text, /不要声称答案有知识库依据/);
		// …unless the user explicitly references it with a knowledge chip on the input.
		await run(t, alice.token, c, '[[call kb_search {"query":"vault combination"}]]', { knowledgeRefs: [{ kbId: mine.kb.id, name: "我的笔记" }] });
		r = (await toolResults(t, c, "kb_search"))[2];
		assert.equal(r!.details.citations[0]?.fileName, "vault.txt");
		// The same reference sent by Bob runs as Bob: he cannot read Alice's personal KB → forbidden, nothing leaked.
		await run(t, bob.token, c, '[[call kb_search {"query":"vault combination"}]]', { knowledgeRefs: [{ kbId: mine.kb.id, name: "我的笔记" }] });
		r = (await toolResults(t, c, "kb_search"))[3];
		assert.equal(r!.details.diagnostics.reason, "forbidden");
		assert.equal(r!.details.citations.length, 0);
		assert.doesNotMatch(r!.text, /4417/);

		// knowledge_scope section lists the project KB (and not Alice's personal KB) in the project conversation.
		const s = await sections(t, c);
		assert.match(s.knowledge_scope ?? "", /Apollo 资料/);
		assert.doesNotMatch(s.knowledge_scope ?? "", /我的笔记/);

		// Revocation applies to the next tool call: Bob removed → his kb_search is refused by the runtime ACL.
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: alice.token, json: { email: "bob@example.com", role: null } });
		await t.json("POST", `${base(c)}/messages`, { token: bob.token, json: { text: "x", requestId: randomUUID() }, expect: 403 });
	} finally {
		await t.dispose();
	}
});

test("memory section + memory_save: private memory only in the owner's personal conversations; project memory shared; corrections reach every branch", async () => {
	const t = await startTestApp();
	try {
		const alice = await t.user("alice@example.com", { name: "Alice" });
		const bob = await joinOrg(t, alice.me.orgId, "bob@example.com");
		const { project } = await t.json("POST", "/api/projects", { token: alice.token, json: { kind: "space", name: "Apollo" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: alice.token, json: { email: "bob@example.com", role: "editor" } });
		await t.json("POST", "/api/memory", { token: alice.token, json: { content: "PRIVATE-MEM 我的体检在周五", scope: "private" } });
		const pm = (await t.json("POST", "/api/memory", { token: alice.token, json: { content: "PROJECT-MEM 交付物统一用中文", scope: "project", projectId: project.id, kind: "constraint" } })).memory;
		await t.json("POST", "/api/memory", { token: alice.token, json: { content: "ORG-MEM 对外文件须法务审核", scope: "org" } });

		const personal = await newChat(t, alice.token);
		await run(t, alice.token, personal, "[[reply ok]]");
		const sp = (await sections(t, personal)).memory ?? "";
		assert.match(sp, /PRIVATE-MEM/);
		assert.match(sp, /ORG-MEM/);
		assert.doesNotMatch(sp, /PROJECT-MEM/);

		const pc = await newChat(t, alice.token, { spaceId: project.spaceId });
		await run(t, alice.token, pc, "[[reply ok]]");
		const sproj = (await sections(t, pc)).memory ?? "";
		assert.match(sproj, /PROJECT-MEM/);
		assert.match(sproj, /ORG-MEM/);
		assert.doesNotMatch(sproj, /PRIVATE-MEM/, "private memory must never enter a project conversation");

		// memory_save from the project conversation, scope project → shared, source "extracted" with conversation ref.
		await run(t, alice.token, pc, '[[call memory_save {"content":"SAVED-MEM 客户偏好每周五收到周报","scope":"project","kind":"preference"}]]');
		const [saved] = await toolResults(t, pc, "memory_save");
		assert.equal(saved!.isError, false, saved!.text);
		const m = saved!.details.memory;
		assert.equal(m.source, "extracted");
		assert.equal(m.scope, "project");
		assert.equal(m.sourceRef.conversationId, pc.conversationId);
		assert.equal(m.sourceRef.spaceId, project.spaceId);
		assert.ok(m.sourceRef.callId);
		assert.ok((await t.json("GET", "/api/memory", { token: bob.token })).memories.some((x: any) => x.id === m.id && x.source === "extracted"));
		// Scope is required, and "project" is refused outside a project conversation.
		await run(t, alice.token, personal, '[[call memory_save {"content":"no scope given"}]]');
		assert.equal((await toolResults(t, personal, "memory_save"))[0]!.isError, true);
		await run(t, alice.token, personal, '[[call memory_save {"content":"wrong place","scope":"project"}]]');
		const wrong = (await toolResults(t, personal, "memory_save"))[1]!;
		assert.equal(wrong.isError, true);
		assert.match(wrong.text, /不是项目会话/);

		// Correction is global: a fork made from an early entry sees the corrected memory at its next request.
		const firstEntry = (await t.json("GET", `${base(pc)}/entries?limit=200`, { token: alice.token })).items.find((e: any) => e.kind === "user");
		await t.json("POST", `/api/memory/${pm.id}/correct`, { token: alice.token, json: { content: "PROJECT-MEM-V2 交付物中英双语", note: "客户要求" } });
		const fork = (await t.json("POST", `${base(pc)}/fork`, { token: alice.token, json: { entryId: firstEntry.entryId ?? firstEntry.id } })).conversation as Conv;
		await run(t, alice.token, fork, "[[reply ok]]");
		const sf = (await sections(t, fork)).memory ?? "";
		assert.match(sf, /PROJECT-MEM-V2/);
		assert.doesNotMatch(sf, /PROJECT-MEM 交付物统一用中文/);
		await run(t, alice.token, pc, "[[reply again]]");
		assert.match((await sections(t, pc)).memory ?? "", /PROJECT-MEM-V2.*|[\s\S]*PROJECT-MEM-V2/);

		// Bob in the same project conversation: same shared memory, still no private memory of anyone.
		await run(t, bob.token, pc, "[[reply hi]]");
		const sb = (await sections(t, pc)).memory ?? "";
		assert.doesNotMatch(sb, /PRIVATE-MEM/);
	} finally {
		await t.dispose();
	}
});

test("compaction: key constraints from memory are still in the prompt after the transcript is summarized (M10-C)", async () => {
	const t = await startTestApp();
	try {
		const alice = await t.user("alice@example.com", { name: "Alice" });
		await t.json("POST", "/api/memory", { token: alice.token, json: { content: "CONSTRAINT-MEM 所有金额以人民币万元为单位", scope: "private", kind: "constraint" } });
		const c = await newChat(t, alice.token);
		// Enough transcript that compaction has something to summarize (keepRecentTokens keeps only the tail verbatim).
		const filler = "历史讨论内容，与约束无关。".repeat(2500);
		for (const msg of [`第一轮 ${filler} [[reply a]]`, `第二轮 ${filler} [[reply b]]`, `第三轮 ${filler} [[reply c]]`]) await run(t, alice.token, c, msg);
		const h = await t.app.ctx.services.get("runtime").harness(c.spaceId, BACKGROUND_CONTEXT);
		const conv = (await h.conversation(c.conversationId as any, BACKGROUND_CONTEXT))!;
		const taskId = await conv.compact("保留关键约束", BACKGROUND_CONTEXT);
		const done = await h.waitForTask(taskId, BACKGROUND_CONTEXT);
		assert.equal((done.state as any).outcome.status, "completed", JSON.stringify(done.state));
		const placed = (done.state as any).outcome.result?.submissionId;
		if (placed !== undefined) await (await h.submission(placed, BACKGROUND_CONTEXT))!.wait(BACKGROUND_CONTEXT);
		await run(t, alice.token, c, "压缩后 [[reply d]]");
		const es = await rawEntries(t, c);
		const compIdx = es.findIndex((e) => e.kind === "pi.compaction");
		assert.ok(compIdx > 0, "a compaction entry exists");
		// After the compaction the prompt sections are re-established for the new context, memory included.
		const after = es.slice(compIdx).filter((e) => e.kind === "pi.system").map((e) => e.model?.[0]?.sections?.memory ?? "").join("\n");
		assert.match(after, /CONSTRAINT-MEM/);
	} finally {
		await t.dispose();
	}
});

test("subagent knowledge scope: a member only searches its declared KBs, even when the parent's user could see more", async () => {
	const t = await startTestApp();
	try {
		const alice = await t.user("alice@example.com", { name: "Alice" });
		const allowed = await kbWithDoc(t, alice.token, { name: "公开资料", scope: "personal" }, { name: "public.md", mime: MIME.md, bytes: "# 资料\n\nThe marmot report is public." });
		const secret = await kbWithDoc(t, alice.token, { name: "机密资料", scope: "personal" }, { name: "secret.md", mime: MIME.md, bytes: "# 机密\n\nThe marmot budget is 7731 units." });
		const { assistant } = await t.json("POST", "/api/assistants", {
			token: alice.token,
			json: { name: "研究助手", members: [{ id: "researcher", name: "研究员", type: "builtin_subagent", tools: ["kb_search"], maxTurns: 3, knowledgeScope: { kbIds: [allowed.kb.id] } }, { id: "noscope", name: "无范围", type: "builtin_subagent", tools: ["kb_search"], maxTurns: 3, knowledgeScope: { kbIds: [] } }] },
		});
		const c = (await t.json("POST", "/api/conversations", { token: alice.token, json: { assistantId: assistant.id } })).conversation as Conv;
		// The parent (Alice, no member scope) sees both KBs.
		await run(t, alice.token, c, '[[call kb_search {"query":"marmot"}]]');
		const parent = (await toolResults(t, c, "kb_search"))[0]!;
		assert.deepEqual(parent.details.citations.map((x: any) => x.fileName).sort(), ["public.md", "secret.md"]);
		assert.equal(parent.details.diagnostics.memberScope, undefined);

		const delegate = (member: string, task: string) => `[[call delegate ${JSON.stringify({ member, task })}]]`;
		// 1) default search inside the child: only the scoped KB.
		await run(t, alice.token, c, delegate("researcher", '[[call kb_search {"query":"marmot"}]]'));
		// 2) explicitly asking for the secret KB: refused, nothing leaked.
		await run(t, alice.token, c, delegate("researcher", `[[call kb_search {"query":"marmot budget","kbIds":["${secret.kb.id}"]}]]`));
		// 3) asking for both: only the in-scope one is searched.
		await run(t, alice.token, c, delegate("researcher", `[[call kb_search {"query":"marmot","kbIds":["${secret.kb.id}","${allowed.kb.id}"]}]]`));
		// 4) a member with an empty scope can search nothing.
		await run(t, alice.token, c, delegate("noscope", '[[call kb_search {"query":"marmot"}]]'));
		const sas = (await t.json("GET", `${base(c)}/tasks`, { token: alice.token })).subagents as any[];
		assert.equal(sas.length, 4);
		const childResult = async (i: number) => (await toolResults(t, { spaceId: c.spaceId, conversationId: sas[i].childConversationId }, "kb_search"))[0]!;
		const r1 = await childResult(0);
		assert.deepEqual(r1.details.citations.map((x: any) => x.fileName), ["public.md"]);
		assert.deepEqual(r1.details.diagnostics.memberScope, [allowed.kb.id]);
		assert.deepEqual(r1.details.diagnostics.searchedKbIds, [allowed.kb.id]);
		const r2 = await childResult(1);
		assert.equal(r2.details.citations.length, 0);
		assert.equal(r2.details.diagnostics.reason, "forbidden");
		assert.deepEqual(r2.details.diagnostics.forbiddenKbIds, [secret.kb.id]);
		assert.doesNotMatch(r2.text, /7731/);
		const r3 = await childResult(2);
		assert.deepEqual(r3.details.citations.map((x: any) => x.fileName), ["public.md"]);
		assert.deepEqual(r3.details.diagnostics.forbiddenKbIds, [secret.kb.id]);
		const r4 = await childResult(3);
		assert.equal(r4.details.diagnostics.reason, "forbidden");
		assert.equal(r4.details.citations.length, 0);
		// The child's knowledge_scope prompt section lists only its scope.
		const childSections = await sections(t, { spaceId: c.spaceId, conversationId: sas[0].childConversationId });
		assert.match(childSections.knowledge_scope ?? "", /公开资料/);
		assert.doesNotMatch(childSections.knowledge_scope ?? "", /机密资料/);
	} finally {
		await t.dispose();
	}
});

test("conversation citation status (M06-C 失效提示): every kb_search citation of a conversation with its current validity", async () => {
	const t = await startTestApp();
	try {
		const alice = await t.user("alice@example.com", { name: "Alice" });
		const bob = await joinOrg(t, alice.me.orgId, "bob@example.com");
		const { project } = await t.json("POST", "/api/projects", { token: alice.token, json: { kind: "space", name: "Apollo" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: alice.token, json: { email: "bob@example.com", role: "editor" } });
		const a = await kbWithDoc(t, alice.token, { name: "Apollo 资料", scope: "project", projectId: project.id }, { name: "plan.md", mime: MIME.md, bytes: "# 计划\n\nThe launch window opens November 20." });
		const b = await kbWithDoc(t, alice.token, { name: "Apollo 风险", scope: "project", projectId: project.id }, { name: "risk.md", mime: MIME.md, bytes: "# 风险\n\nThe weather risk is moderate." });
		const c = await newChat(t, bob.token, { spaceId: project.spaceId });
		await run(t, bob.token, c, '[[call kb_search {"query":"launch window"}]]');
		await run(t, bob.token, c, '[[call kb_search {"query":"weather risk"}]]');
		const url = `/api/kb/conversations/${c.spaceId}/${c.conversationId}/citation-status`;
		let st = await t.json("GET", url, { token: bob.token });
		assert.equal(st.calls.length, 2);
		const [planChunk] = st.calls[0].chunkIds;
		const [riskChunk] = st.calls[1].chunkIds;
		assert.ok(st.calls[0].entryId > 0 && st.calls[0].callId);
		assert.equal(st.byChunkId[planChunk].status, "valid");
		assert.equal(st.stale, 0);

		// The plan gets v2 (superseded) and the risk doc is removed (deleted): the old answer keeps its snapshot, status changes.
		await uploadVersion(t, alice.token, a.file.fileId, { name: "plan.md", mime: MIME.md, bytes: "# 计划\n\nThe launch window moved to December 2." });
		await waitDoc(t, alice.token, a.kb.id, a.doc.id, (d) => d.serving?.versionNo === 2);
		await t.json("DELETE", `/api/kb/${b.kb.id}/docs/${b.doc.id}`, { token: alice.token });
		st = await t.json("GET", url, { token: bob.token });
		assert.equal(st.byChunkId[planChunk].status, "superseded");
		assert.equal(st.byChunkId[planChunk].current.versionNo, 2);
		assert.equal(st.byChunkId[riskChunk].status, "deleted");
		assert.equal(st.stale, 2);
		// The snapshot in the transcript is unchanged (still v1 text).
		const snap = (await toolResults(t, c, "kb_search"))[0]!.details.citations[0];
		assert.equal(snap.versionNo, 1);
		assert.match(snap.snippet, /November 20/);
		// POST batch accepts the same ids (deduplicated) and keys them.
		const batch = await t.json("POST", "/api/kb/citations/status", { token: bob.token, json: { chunkIds: [planChunk, planChunk, riskChunk] } });
		assert.equal(batch.statuses.length, 2);
		assert.equal(batch.byChunkId[riskChunk].status, "deleted");
		// Outsiders cannot read the conversation's citations; a removed member loses access entirely.
		const eve = await t.user("eve@other.com");
		await t.json("GET", url, { token: eve.token, expect: 403 });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: alice.token, json: { email: "bob@example.com", role: null } });
		await t.json("GET", url, { token: bob.token, expect: 403 });
		assert.equal((await t.json("POST", "/api/kb/citations/status", { token: bob.token, json: { chunkIds: [planChunk] } })).statuses[0].status, "forbidden");
	} finally {
		await t.dispose();
	}
});
