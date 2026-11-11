// Round 9 (B2): conversation menu state (star / tags / soft delete / export) and global search with an incremental
// FTS5 trigram index. Real app, real SQLite, fixture model directives.
//   node --disable-warning=ExperimentalWarning --test server/test/round9-meta-search.test.ts
process.env.WORKROOM_FIXTURE_TOOLS = "1";
process.env.WORKROOM_RT_RETRY_BASE_MS ??= "20";
process.env.WORKROOM_RT_RETRY_MAX ??= "1";
process.env.WORKROOM_SSE_THROTTLE_MS ??= "20";
process.env.WORKROOM_SEARCH_RECHECK_MS = "0"; // every search re-checks every conversation's tail
process.env.WORKROOM_SEARCH_INDEX_MS = "0"; // no background timer: tests drive tick() themselves

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { isSettled, waitFor } from "../src/runtime/testing.ts";
import { runtimeState } from "../src/runtime/module.ts";
import { normaliseTags } from "../src/runtime/meta.ts";
import { snippetOf } from "../src/runtime/search.ts";
import type { SubmissionDTO } from "../../shared/chat.ts";
import type { ConversationMetaDTO, SearchHitDTO } from "../../shared/round9.ts";

type Conv = { spaceId: string; conversationId: number };
const rid = () => randomUUID();
const base = (c: Conv) => `/api/conversations/${c.spaceId}/${c.conversationId}`;

async function newChat(t: TestApp, token: string, body: Record<string, unknown> = {}): Promise<Conv & { title: string }> {
	return (await t.json("POST", "/api/conversations", { token, json: body })).conversation;
}
async function send(t: TestApp, token: string, c: Conv, text: string, extra: Record<string, unknown> = {}) {
	return (await t.json("POST", `${base(c)}/messages`, { token, json: { text, requestId: rid(), ...extra } })) as { submissionId: number };
}
async function settle(t: TestApp, token: string, c: Conv, submissionId: number, timeoutMs = 20_000): Promise<SubmissionDTO> {
	return waitFor(async () => {
		const s = (await t.json("GET", `${base(c)}/submissions/${submissionId}`, { token })) as SubmissionDTO;
		return isSettled(s) ? s : undefined;
	}, { timeoutMs, what: `submission ${submissionId} settles` });
}
/** Send and wait until the assistant answered. */
async function say(t: TestApp, token: string, c: Conv, text: string) {
	const r = await send(t, token, c, text);
	return settle(t, token, c, r.submissionId);
}
async function member(t: TestApp, owner: { token: string }, email: string) {
	const { invite } = await t.json("POST", "/api/admin/invites", { token: owner.token, json: { role: "member" } });
	return t.user(email, { inviteCode: invite.code });
}
const search = (t: TestApp, token: string, q: string, limit?: number) => t.json("GET", `/api/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ""}`, { token }) as Promise<{ results: SearchHitDTO[]; indexedThrough?: string; partial?: boolean }>;
const metaOf = async (t: TestApp, token: string, c: Conv): Promise<ConversationMetaDTO | undefined> => ((await t.json("GET", "/api/conversation-meta", { token })).items as ConversationMetaDTO[]).find((m) => m.spaceId === c.spaceId && m.conversationId === c.conversationId);
const hit = (r: { results: SearchHitDTO[] }, c: Conv) => r.results.find((h) => h.spaceId === c.spaceId && h.conversationId === c.conversationId);
const listed = async (t: TestApp, token: string, c: Conv) => ((await t.json("GET", "/api/conversations?limit=200", { token })).conversations as Conv[]).some((x) => x.spaceId === c.spaceId && x.conversationId === c.conversationId);
async function shareProject(t: TestApp, owner: { token: string }, conv: Conv, toUserId: string, name = "共享项目") {
	const { project } = await t.json("POST", "/api/projects", { token: owner.token, json: { name } });
	await t.json("PUT", `${base(conv)}/project`, { token: owner.token, json: { projectId: project.id } });
	await t.json("PUT", `/api/projects/${project.id}/shares/${toUserId}`, { token: owner.token, json: { permission: "read" } });
	return project as { id: string; name: string };
}

test("unit: tag normalisation and snippets", () => {
	assert.deepEqual(normaliseTags(["  工作  ", "工作", "Work", "work", "", "a\tb\nc"]), ["工作", "Work", "a b c"]);
	assert.equal(normaliseTags(["x".repeat(40)])[0]!.length, 24);
	assert.equal(normaliseTags(Array.from({ length: 20 }, (_, i) => `t${i}`)).length, 8);
	assert.equal([...normaliseTags(["字".repeat(30)])[0]!].length, 24, "counted in characters, not UTF-16 units");
	assert.throws(() => normaliseTags("nope" as any), /tags/);
	assert.throws(() => normaliseTags([1] as any), /tags/);
	const long = `${"前文".repeat(100)}关键报销流程${"后文".repeat(100)}`;
	const s = snippetOf(long, ["报销"]);
	assert.ok([...s].length <= 160);
	assert.ok(s.includes("报销"));
	assert.ok(s.startsWith("…") && s.endsWith("…"));
	assert.equal(snippetOf("**粗体** `code` # 标题", ["粗体"]), "粗体 code 标题");
});

test("star is per user; tags need write access; both show up in /conversation-meta", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("m-star-a@example.com");
		const b = await member(t, a, "m-star-b@example.com");
		const c = await newChat(t, a.token, { title: "星标测试" });

		// B has no access to A's personal conversation at all
		await t.json("PUT", `${base(c)}/star`, { token: b.token, json: { starred: true }, expect: 403 });
		await t.json("PUT", `${base(c)}/tags`, { token: b.token, json: { tags: ["x"] }, expect: 403 });
		assert.equal(await metaOf(t, b.token, c), undefined, "not visible to B");

		// A stars; B (read-only share) still sees starred=false, then stars it for himself
		const r = await t.json("PUT", `${base(c)}/star`, { token: a.token, json: { starred: true } });
		assert.equal(r.meta.starred, true);
		await t.json("PUT", `${base(c)}/star`, { token: a.token, json: { starred: true } }); // idempotent
		assert.equal((await metaOf(t, a.token, c))?.starred, true);
		const proj = await shareProject(t, a, c, b.me.userId);
		assert.equal((await metaOf(t, b.token, c))?.starred, false, "A's star is invisible to B");
		await t.json("PUT", `${base(c)}/star`, { token: b.token, json: { starred: true } }); // read access is enough
		assert.equal((await metaOf(t, b.token, c))?.starred, true);
		await t.json("PUT", `${base(c)}/star`, { token: a.token, json: { starred: false } });
		assert.equal((await metaOf(t, a.token, c))?.starred, false);
		assert.equal((await metaOf(t, b.token, c))?.starred, true, "B's star is independent of A's");
		await t.json("PUT", `${base(c)}/star`, { token: a.token, json: { starred: "yes" }, expect: 400 });

		// tags: writer only; the reader sees them
		await t.json("PUT", `${base(c)}/tags`, { token: b.token, json: { tags: ["偷改"] }, expect: 403 });
		const tg = await t.json("PUT", `${base(c)}/tags`, { token: a.token, json: { tags: ["  紧急 ", "紧急", "Q4", "x".repeat(40), ...Array.from({ length: 10 }, (_, i) => `t${i}`)] } });
		assert.equal(tg.tags.length, 8);
		assert.equal(tg.tags[0], "紧急");
		assert.equal(tg.tags[2], "x".repeat(24));
		assert.deepEqual((await metaOf(t, b.token, c))?.tags, tg.tags, "tags are per conversation, B reads them");
		await t.json("PUT", `${base(c)}/tags`, { token: a.token, json: { tags: "nope" }, expect: 400 });
		await t.json("PUT", `${base(c)}/tags`, { token: a.token, json: { tags: [] } });
		assert.deepEqual((await metaOf(t, a.token, c))?.tags, []);

		// archived conversations can still be tagged (metadata only)
		await t.json("PATCH", base(c), { token: a.token, json: { archived: true } });
		await t.json("PUT", `${base(c)}/tags`, { token: a.token, json: { tags: ["归档标签"] } });
		assert.deepEqual((await metaOf(t, a.token, c))?.tags, ["归档标签"]);

		// another organisation sees nothing and can change nothing
		const o = await t.user("m-star-other@example.com");
		await t.json("PUT", `${base(c)}/star`, { token: o.token, json: { starred: true }, expect: 403 });
		assert.equal(await metaOf(t, o.token, c), undefined);
		void proj;
	} finally {
		await t.dispose();
	}
});

test("soft delete: hidden from list/state/entries/search/export/meta (404), audit row, data retained, only creator or space admin", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("m-del-a@example.com");
		const b = await member(t, a, "m-del-b@example.com");
		const c = await newChat(t, a.token, { title: "待删除的会话" });
		await say(t, a.token, c, "独一无二的删除标记甲乙丙 [[reply 收到]]");
		await t.json("PUT", `${base(c)}/tags`, { token: a.token, json: { tags: ["删前标签"] } });
		assert.ok(await listed(t, a.token, c));
		assert.ok(hit(await search(t, a.token, "删除标记甲乙丙"), c), "searchable before deletion");

		// not the creator, no admin right → 403 and nothing changes
		await t.json("DELETE", base(c), { token: b.token, expect: 403 });
		assert.ok(await listed(t, a.token, c));

		const rt = runtimeState(t.app.ctx).rt;
		const harness = await rt.manager.get(c.spaceId);
		const countEntries = async () => (await (await harness.conversation(c.conversationId as any, BACKGROUND_CONTEXT))!.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT)).items.length;
		const before = await countEntries();

		const r = await t.json("DELETE", base(c), { token: a.token });
		assert.deepEqual(r, { ok: true, wasRunning: false });

		assert.equal(await listed(t, a.token, c), false, "list");
		assert.equal((await t.json("GET", "/api/conversations?archived=1", { token: a.token })).conversations.some((x: Conv) => x.conversationId === c.conversationId), false);
		await t.json("GET", base(c), { token: a.token, expect: 404 });
		await t.json("GET", `${base(c)}/state`, { token: a.token, expect: 404 });
		await t.json("GET", `${base(c)}/entries`, { token: a.token, expect: 404 });
		await t.json("GET", `${base(c)}/export?format=md`, { token: a.token, expect: 404 });
		await t.json("POST", `${base(c)}/messages`, { token: a.token, json: { text: "还活着吗", requestId: rid() }, expect: 404 });
		await t.json("PATCH", base(c), { token: a.token, json: { title: "复活" }, expect: 404 });
		await t.json("PUT", `${base(c)}/star`, { token: a.token, json: { starred: true }, expect: 404 });
		await t.json("PUT", `${base(c)}/tags`, { token: a.token, json: { tags: ["x"] }, expect: 404 });
		await t.json("DELETE", base(c), { token: a.token, expect: 404 });
		await t.json("GET", `/api/search/preview/${c.spaceId}/${c.conversationId}`, { token: a.token, expect: 404 });
		assert.equal(await metaOf(t, a.token, c), undefined, "conversation-meta");
		const gone = await search(t, a.token, "删除标记甲乙丙");
		assert.equal(hit(gone, c), undefined, "message search");
		assert.equal(hit(await search(t, a.token, "待删除的会话"), c), undefined, "title search");
		assert.equal(hit(await search(t, a.token, "删前标签"), c), undefined, "tag search");

		// durable data and catalog row are retained (soft delete), the audit trail records who did it
		const row = t.app.ctx.db.get<{ deleted_at: string; deleted_by: string; title: string }>("SELECT deleted_at, deleted_by, title FROM rt_conversations WHERE space_id = ? AND conversation_id = ?", c.spaceId, c.conversationId)!;
		assert.ok(row.deleted_at && row.deleted_by === a.me.userId && row.title === "待删除的会话");
		assert.equal(await countEntries(), before, "pi-durable entries untouched");
		assert.ok(t.app.ctx.db.get("SELECT 1 FROM rt_search_docs WHERE space_id = ? AND conversation_id = ?", c.spaceId, c.conversationId), "index rows kept (filtered at query time)");
		const audit = (await t.json("GET", "/api/admin/audit?limit=200", { token: a.token })).events ?? (await t.json("GET", "/api/admin/audit?limit=200", { token: a.token })).items ?? [];
		const rec = (audit as any[]).find((e) => e.action === "conversation.delete");
		assert.ok(rec, "audit row conversation.delete exists");
		assert.equal(rec.actorUserId ?? rec.actor_user_id ?? rec.actor, a.me.userId);
		assert.match(String(rec.target), new RegExp(`${c.spaceId}/${c.conversationId}`));
	} finally {
		await t.dispose();
	}
});

test("soft delete in a legacy project space: creator may delete own, the space owner may delete anyone's, a viewer nobody's", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("m-proj-a@example.com"); // org owner and project owner
		const e = await member(t, a, "m-proj-e@example.com");
		const e2 = await member(t, a, "m-proj-e2@example.com");
		const v = await member(t, a, "m-proj-v@example.com");
		const { project } = await t.json("POST", "/api/projects", { token: a.token, json: { kind: "space", name: "旧版项目" } });
		for (const [u, email, role] of [[e, "m-proj-e@example.com", "editor"], [e2, "m-proj-e2@example.com", "editor"], [v, "m-proj-v@example.com", "viewer"]] as const) await t.json("PUT", `/api/projects/${project.id}/members`, { token: a.token, json: { email, role } });
		void v;

		const mine = await newChat(t, e.token, { projectId: project.id, title: "编辑者的会话" });
		const other = await newChat(t, e.token, { projectId: project.id, title: "另一个会话" });
		const third = await newChat(t, e.token, { projectId: project.id, title: "第三个会话" });
		await t.json("DELETE", base(other), { token: e2.token, expect: 403 }); // another editor: not creator, not admin
		await t.json("DELETE", base(other), { token: v.token, expect: 403 }); // viewer
		await t.json("DELETE", base(mine), { token: e.token }); // creator
		await t.json("DELETE", base(other), { token: a.token }); // space owner = admin
		assert.equal(await listed(t, e.token, mine), false);
		assert.equal(await listed(t, v.token, other), false);
		assert.equal(await listed(t, a.token, third), true);
	} finally {
		await t.dispose();
	}
});

test("deleting a running conversation aborts the run first", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("m-run-a@example.com");
		const c = await newChat(t, a.token, { title: "运行中的会话" });
		const r = await send(t, a.token, c, "[[slow 20000]] 很慢的任务 [[reply 不该出现]]");
		await waitFor(async () => (await t.json("GET", `${base(c)}/submissions/${r.submissionId}`, { token: a.token })).status === "applied", { what: "run started" });
		const rt = runtimeState(t.app.ctx).rt;
		const harness = await rt.manager.get(c.spaceId);
		assert.ok((await harness.snapshot(LiveDoc, c.conversationId as any, BACKGROUND_CONTEXT))?.run, "running before delete");

		const t0 = Date.now();
		const del = await t.json("DELETE", base(c), { token: a.token });
		assert.equal(del.wasRunning, true);
		assert.ok(Date.now() - t0 < 10_000, "did not wait for the 20 s model delay");
		assert.equal((await harness.snapshot(LiveDoc, c.conversationId as any, BACKGROUND_CONTEXT))?.run, undefined, "run stopped");
		const sub = await harness.submission(r.submissionId as any, BACKGROUND_CONTEXT);
		assert.ok(["done", "unanswered"].includes((await sub!.status(BACKGROUND_CONTEXT)).status), "the aborted submission is settled, not left running");
		await t.json("GET", `${base(c)}/state`, { token: a.token, expect: 404 });
		const audit = await t.json("GET", "/api/admin/audit?limit=200", { token: a.token });
		const rec = ((audit.events ?? audit.items) as any[]).find((e) => e.action === "conversation.delete");
		assert.equal(JSON.parse(typeof rec.detail === "string" ? rec.detail : JSON.stringify(rec.detail)).wasRunning, true);
	} finally {
		await t.dispose();
	}
});

test("export: Markdown attachment with title/date header, directives and tool arguments hidden, read access only", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("m-exp-a@example.com");
		const b = await member(t, a, "m-exp-b@example.com");
		const c = await newChat(t, a.token, { title: "周报：导出/测试" });
		await say(t, a.token, c, '整理要点 [[call wr_fixture_echo {"text":"回声文本"}]]');
		await say(t, a.token, c, "再补充一句 [[slow 10]] [[reply 已记录]]");

		const res = await t.req("GET", `${base(c)}/export?format=md`, { token: a.token });
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") ?? "", /^text\/markdown/);
		const cd = res.headers.get("content-disposition") ?? "";
		assert.match(cd, /^attachment;/);
		assert.match(cd, new RegExp(`filename="conversation-${c.conversationId}\\.md"`));
		assert.ok(decodeURIComponent(cd.split("filename*=UTF-8''")[1] ?? "").startsWith("周报：导出_测试"), "unicode filename, path characters replaced");
		const md = await res.text();
		assert.ok(md.startsWith("# 周报：导出/测试\n"), "title header");
		assert.match(md, /创建时间：\d{4}-\d\d-\d\dT/);
		assert.match(md, /## 用户（m-exp-a）\n\n整理要点\n/);
		assert.match(md, /## 用户[^\n]*\n\n再补充一句\n/);
		assert.match(md, /## 助手[\s\S]*回声文本/, "the assistant's own answer is exported");
		assert.match(md, /已记录/);
		assert.ok(!md.includes("[["), "test directives hidden");
		assert.ok(!md.includes("[[call") && !md.includes("[[slow") && !md.includes("[[reply"));
		assert.match(md, /> 工具调用：`wr_fixture_echo`（参数：text） — 完成/, "tool call summarised in one line");
		assert.ok(!md.split("\n").find((l) => l.startsWith("> 工具调用"))!.includes("回声文本"), "argument VALUES are not part of the tool-call line");

		await t.json("GET", `${base(c)}/export?format=pdf`, { token: a.token, expect: 400 });
		await t.json("GET", `${base(c)}/export?format=md`, { token: b.token, expect: 403 });
		await shareProject(t, a, c, b.me.userId, "导出共享");
		assert.equal((await t.req("GET", `${base(c)}/export?format=md`, { token: b.token })).status, 200, "a shared reader may export");
	} finally {
		await t.dispose();
	}
});

test("search: title, message, tag and project matches; Chinese substrings; short queries; snippet; directives and tool data are not indexed", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("m-s-a@example.com");
		const c1 = await newChat(t, a.token, { title: "差旅规定" });
		await say(t, a.token, c1, "请说明员工出差的报销流程以及发票要求 [[reply 报销需要在三十天内提交电子发票]]");
		const c2 = await newChat(t, a.token, { title: "无关闲聊" });
		await say(t, a.token, c2, '今天天气不错 [[call wr_fixture_echo {"text":"凭证口令-TOKEN-9981"}]]');
		const c3 = await newChat(t, a.token, { title: "季度计划" });
		await t.json("PUT", `${base(c3)}/tags`, { token: a.token, json: { tags: ["紧急", "Roadmap"] } });
		const c4 = await newChat(t, a.token, { title: "纯项目归属" });
		const { project } = await t.json("POST", "/api/projects", { token: a.token, json: { name: "年度复盘项目" } });
		await t.json("PUT", `${base(c4)}/project`, { token: a.token, json: { projectId: project.id } });

		// message text: CJK substring through the trigram index
		let r = await search(t, a.token, "报销流程");
		const h1 = hit(r, c1)!;
		assert.ok(h1, "4-char Chinese substring hits the message");
		assert.deepEqual(h1.matchedIn, ["message"]);
		assert.ok(h1.snippet.includes("报销流程") && h1.snippet.length <= 160);
		assert.ok(h1.entryId && h1.entryId > 0);
		assert.equal(h1.access, "own");
		assert.equal(h1.title, "差旅规定");
		// assistant text is searchable too, with its own entry
		r = await search(t, a.token, "电子发票");
		assert.ok(hit(r, c1));
		// 2-character query: LIKE path
		r = await search(t, a.token, "报销");
		assert.ok(hit(r, c1) && hit(r, c1)!.snippet.includes("报销"));
		// Several terms must all match within one turn
		assert.ok(hit(await search(t, a.token, "出差 发票"), c1));
		assert.equal(hit(await search(t, a.token, "出差 天气"), c1), undefined);
		// 1 character: title/tag prefix only, never message text
		r = await search(t, a.token, "报");
		assert.equal(hit(r, c1), undefined, "1-char query does not scan messages");
		r = await search(t, a.token, "差");
		assert.deepEqual(hit(r, c1)?.matchedIn, ["title"]);
		r = await search(t, a.token, "紧");
		assert.deepEqual(hit(r, c3)?.matchedIn, ["tag"]);
		assert.equal(hit(await search(t, a.token, "急"), c3), undefined, "prefix, not substring");
		// title, tag, project
		r = await search(t, a.token, "差旅");
		assert.deepEqual(hit(r, c1)?.matchedIn, ["title"]);
		r = await search(t, a.token, "roadmap");
		assert.deepEqual(hit(r, c3)?.matchedIn, ["tag"], "tags are case-insensitive");
		assert.deepEqual(hit(r, c3)?.tags, ["紧急", "Roadmap"]);
		r = await search(t, a.token, "复盘");
		const h4 = hit(r, c4)!;
		assert.deepEqual(h4.matchedIn, ["project"]);
		assert.equal(h4.projectName, "年度复盘项目");
		assert.equal(h4.projectId, project.id);
		// a title hit outranks a message-only hit; a conversation matching in several places lists them all
		await say(t, a.token, c2, "顺便问一下差旅政策 [[reply 好]]");
		r = await search(t, a.token, "差旅");
		assert.equal(r.results[0]!.conversationId, c1.conversationId);
		assert.ok(hit(r, c2)?.matchedIn.includes("message"));
		// starred is reflected per hit
		await t.json("PUT", `${base(c1)}/star`, { token: a.token, json: { starred: true } });
		assert.equal(hit(await search(t, a.token, "差旅"), c1)?.starred, true);

		// test directives and tool arguments/results never enter the index
		for (const q of ["[[reply", "[[call", "[[slow", "arguments"]) assert.equal((await search(t, a.token, q)).results.length, 0, `"${q}" must not match`);
		// the tool-call turn (assistant entry without text) and the tool result are not documents: only turns with text are
		const asstEntries = ((await t.json("GET", `${base(c2)}/entries?limit=100`, { token: a.token })).items as any[]).filter((e) => e.kind === "assistant");
		assert.ok(asstEntries.some((e) => e.text === "" && e.toolCalls.length), "fixture produced a text-less tool-call turn");
		const c2docs = t.app.ctx.db.all<{ entry_id: number; role: string; text: string }>("SELECT entry_id, role, text FROM rt_search_docs WHERE space_id = ? AND conversation_id = ?", c2.spaceId, c2.conversationId);
		assert.deepEqual(c2docs.filter((d) => d.role === "assistant").map((d) => d.entry_id), asstEntries.filter((e) => e.text.trim()).map((e) => e.id), "assistant docs = assistant turns with text only");
		assert.ok(!c2docs.some((d) => d.text.includes("wr_fixture_echo(") || d.text.includes('"text"')), "no tool call JSON");
		const docs = t.app.ctx.db.all<{ text: string; role: string }>("SELECT text, role FROM rt_search_docs");
		assert.ok(docs.every((d) => d.role === "user" || d.role === "assistant"));
		assert.ok(docs.every((d) => !d.text.includes("[[")));
		// the old "test model" label is part of assistant text and harmless; user text is stored without directives
		assert.ok(docs.some((d) => d.role === "user" && d.text === "今天天气不错"));

		// empty query → most recent conversations; limit respected; no match → empty
		r = await search(t, a.token, "");
		assert.ok(r.results.length >= 4 && r.results.every((h) => h.snippet === "" && h.matchedIn.length === 0));
		assert.equal((await search(t, a.token, "", 2)).results.length, 2);
		assert.deepEqual((await search(t, a.token, "完全不存在的内容zzqq")).results, []);
		// FTS metacharacters are plain text
		assert.deepEqual((await search(t, a.token, 'a" OR "b* NEAR(')).results, []);
	} finally {
		await t.dispose();
	}
});

test("search: incremental indexing — a new message becomes searchable; the background tick indexes without a search", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("m-inc-a@example.com");
		const c = await newChat(t, a.token, { title: "增量索引" });
		await say(t, a.token, c, "第一条消息关于阿尔法项目 [[reply 收到阿尔法]]");
		let r = await search(t, a.token, "阿尔法项目");
		assert.ok(hit(r, c));
		assert.equal(r.partial, undefined);
		assert.ok(r.indexedThrough);
		const prog = () => t.app.ctx.db.get<{ last_entry_id: number }>("SELECT last_entry_id FROM rt_search_progress WHERE space_id = ? AND conversation_id = ?", c.spaceId, c.conversationId)!.last_entry_id;
		const p1 = prog();
		assert.equal(hit(await search(t, a.token, "贝塔计划"), c), undefined, "not there yet");
		await say(t, a.token, c, "第二条消息提到贝塔计划 [[reply 记下贝塔]]");
		assert.ok(hit(await search(t, a.token, "贝塔计划"), c), "new message searchable on the next search");
		assert.ok(hit(await search(t, a.token, "记下贝塔"), c), "and the new assistant answer");
		assert.ok(prog() > p1, "progress advanced");
		// documents are not duplicated by repeated searches
		const n = () => t.app.ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM rt_search_docs WHERE space_id = ? AND conversation_id = ?", c.spaceId, c.conversationId)!.n;
		const n1 = n();
		await search(t, a.token, "阿尔法");
		await search(t, a.token, "贝塔");
		assert.equal(n(), n1);
		assert.equal(n1, 4);

		// background tick: the third message is indexed without anybody searching
		await say(t, a.token, c, "第三条消息写着伽马方案 [[reply 伽马已记]]");
		assert.equal(t.app.ctx.db.get("SELECT 1 FROM rt_search_docs WHERE text LIKE '%伽马方案%'"), undefined);
		const indexed = await runtimeState(t.app.ctx).search.tick();
		assert.ok(indexed > 0);
		assert.ok(t.app.ctx.db.get("SELECT 1 FROM rt_search_docs WHERE text LIKE '%伽马方案%'"), "tick indexed the new turn");
		assert.equal(await runtimeState(t.app.ctx).search.tick(), 0, "nothing left to do");
		r = await search(t, a.token, "伽马方案");
		assert.ok(hit(r, c));
		assert.equal(n(), 6);

		// a branch only indexes what it adds (parent history belongs to the parent)
		const es = (await t.json("GET", `${base(c)}/entries?limit=100`, { token: a.token })).items as { id: number; kind: string }[];
		const firstUser = es.find((e) => e.kind === "user")!;
		const asst = es.find((e) => e.kind === "assistant")!;
		const fork = (await t.json("POST", `${base(c)}/fork`, { token: a.token, json: { entryId: asst.id, title: "分支" } })).conversation as Conv;
		await say(t, a.token, fork, "分支里的新内容德尔塔 [[reply 德尔塔确认]]");
		r = await search(t, a.token, "阿尔法项目");
		assert.ok(hit(r, c) && !hit(r, fork), "parent text is found in the parent only");
		assert.ok(hit(await search(t, a.token, "德尔塔"), fork));
		void firstUser;
	} finally {
		await t.dispose();
	}
});

test("search: permission isolation — other users and other organisations never get hits, snippets or previews", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("m-iso-a@example.com");
		const b = await member(t, a, "m-iso-b@example.com");
		const o = await t.user("m-iso-o@example.com"); // another organisation
		const secret = "密级天蓝色一一三八";
		const c = await newChat(t, a.token, { title: "机密项目讨论" });
		await say(t, a.token, c, `内部消息：${secret} [[reply 已收到${secret}]]`);
		const own = await newChat(t, b.token, { title: "B 自己的会话" });
		await say(t, b.token, own, "B 的普通内容 [[reply 好]]");
		const preview = (token: string, conv: Conv, q = "") => t.req("GET", `/api/search/preview/${conv.spaceId}/${conv.conversationId}${q}`, { token });

		assert.ok(hit(await search(t, a.token, secret), c));
		for (const [who, tok] of [["same-org member", b.token], ["other org", o.token]] as const) {
			for (const q of [secret, "机密项目", "天蓝色", "密级"]) {
				const r = await search(t, tok, q);
				assert.equal(hit(r, c), undefined, `${who}: "${q}" must not hit`);
				assert.ok(!JSON.stringify(r).includes(secret), `${who}: no snippet text leaks`);
			}
			assert.equal((await preview(tok, c)).status, 403, `${who}: preview refused`);
		}
		// the index does contain the text: isolation is by filtering, not by absence
		assert.ok(t.app.ctx.db.get("SELECT 1 FROM rt_search_docs WHERE text LIKE ?", `%${secret}%`));
		// B only finds B's own conversation
		assert.ok(hit(await search(t, b.token, "普通内容"), own));
		assert.equal(hit(await search(t, a.token, "普通内容"), own), undefined);

		// a read-only project share opens exactly that conversation, access "shared"; revoking closes it again
		const proj = await shareProject(t, a, c, b.me.userId, "机密共享");
		const sh = hit(await search(t, b.token, secret), c)!;
		assert.ok(sh, "grantee finds it");
		assert.equal(sh.access, "shared");
		assert.equal(sh.projectName, "机密共享");
		assert.ok(sh.snippet.includes(secret));
		assert.equal((await preview(b.token, c)).status, 200);
		assert.equal(hit(await search(t, o.token, secret), c), undefined, "other org still sees nothing");
		await t.json("DELETE", `/api/projects/${proj.id}/shares/${b.me.userId}`, { token: a.token });
		assert.equal(hit(await search(t, b.token, secret), c), undefined, "revoked share: gone at once");
		assert.equal((await preview(b.token, c)).status, 403);

		// deleted conversations are excluded for their owner as well
		await t.json("DELETE", base(c), { token: a.token });
		assert.equal(hit(await search(t, a.token, secret), c), undefined);
	} finally {
		await t.dispose();
	}
});

test("search preview: at most 6 turns around the hit, directives hidden", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("m-prev-a@example.com");
		const c = await newChat(t, a.token, { title: "预览测试" });
		for (let i = 1; i <= 8; i++) await say(t, a.token, c, `第${i}轮问题标记Q${i}${i === 5 ? "命中词" : ""} [[reply 第${i}轮回答A${i}]]`);
		const r = await search(t, a.token, "命中词");
		const h = hit(r, c)!;
		assert.ok(h?.entryId);
		const p = await t.json("GET", `/api/search/preview/${c.spaceId}/${c.conversationId}?entryId=${h.entryId}`, { token: a.token });
		assert.equal(p.title, "预览测试");
		assert.ok(p.turns.length <= 6 && p.turns.length >= 4);
		assert.ok(p.turns.some((x: any) => x.entryId === h.entryId && x.role === "user" && x.text.includes("命中词")), "contains the hit");
		assert.ok(p.turns.every((x: any) => (x.role === "user" || x.role === "assistant") && x.text && Number.isInteger(x.entryId)));
		assert.ok(p.turns.every((x: any) => !x.text.includes("[[")), "directives hidden");
		const ids = p.turns.map((x: any) => x.entryId);
		assert.deepEqual(ids, [...ids].sort((x: number, y: number) => x - y), "chronological");
		// without entryId: the latest turns
		const last = await t.json("GET", `/api/search/preview/${c.spaceId}/${c.conversationId}`, { token: a.token });
		assert.equal(last.turns.length, 6);
		assert.match(last.turns.at(-1).text, /第8轮回答A8/);
		await t.json("GET", `/api/search/preview/${c.spaceId}/${c.conversationId}?entryId=abc`, { token: a.token, expect: 400 });
		await t.json("GET", `/api/search/preview/${c.spaceId}/999999`, { token: a.token, expect: 404 });
	} finally {
		await t.dispose();
	}
});

test("long conversation (200 turns): indexing and search stay fast", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("m-long-a@example.com");
		const c = await newChat(t, a.token, { title: "超长对话" });
		const t0 = Date.now();
		let lastSub = 0;
		for (let i = 1; i <= 200; i++) lastSub = (await t.json("POST", `${base(c)}/messages`, { token: a.token, json: { text: `第${i}个问题：关于主题${i % 17}的讨论，独特标记X${String(i).padStart(4, "0")} [[reply 回答${i}：这是一段比较长的固定回复内容用于填充索引 编号Z${String(i).padStart(4, "0")}]]`, requestId: rid(), mode: "followUp" } })).submissionId;
		await settle(t, a.token, c, lastSub, 180_000);
		const build = Date.now() - t0;

		const t1 = Date.now();
		let r = await search(t, a.token, "独特标记X0150");
		const first = Date.now() - t1;
		let rounds = 0;
		while (r.partial && rounds++ < 10) r = await search(t, a.token, "独特标记X0150");
		const h = hit(r, c)!;
		assert.ok(h, "found after indexing");
		assert.ok(h.snippet.includes("X0150"));
		assert.equal(r.partial, undefined, "fully indexed");
		const docs = t.app.ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM rt_search_docs WHERE space_id = ? AND conversation_id = ?", c.spaceId, c.conversationId)!.n;
		assert.equal(docs, 400, "200 user + 200 assistant turns");

		const lat: number[] = [];
		for (const q of ["编号Z0199", "主题7的讨论", "回答77", "独特标记X0001", "固定回复内容"]) {
			const s = Date.now();
			const x = await search(t, a.token, q);
			lat.push(Date.now() - s);
			assert.ok(hit(x, c), q);
		}
		const worst = Math.max(...lat);
		console.log(`[long-conv] 200 turns built in ${build} ms; first search (indexes 400+ entries) ${first} ms; warm search latencies ${lat.join("/")} ms`);
		assert.ok(worst < 1500, `warm search latency ${worst} ms`);
		assert.ok(first < 10_000);
		// the second index pass found nothing new
		assert.equal(await runtimeState(t.app.ctx).search.tick(), 0);
	} finally {
		await t.dispose();
	}
});

test("many conversations: cold and warm search, concurrent searches do not duplicate the index", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("m-many-a@example.com");
		const convs: Conv[] = [];
		for (let i = 1; i <= 60; i++) {
			const c = await newChat(t, a.token, { title: `批量会话${i}` });
			await send(t, a.token, c, `批量内容 编号N${String(i).padStart(3, "0")} 讨论预算 [[reply 好的${i}]]`);
			convs.push(c);
		}
		await waitFor(async () => {
			const st = await Promise.all(convs.slice(-5).map((c) => t.json("GET", `${base(c)}/state`, { token: a.token })));
			return st.every((s: any) => s.live.status === "done") ? true : undefined;
		}, { timeoutMs: 30_000, what: "conversations answered" });
		const t0 = Date.now();
		const [r1, r2, r3] = await Promise.all([search(t, a.token, "编号N042"), search(t, a.token, "编号N042"), search(t, a.token, "讨论预算")]);
		const cold = Date.now() - t0;
		assert.ok(hit(r1, convs[41]!) && hit(r2, convs[41]!));
		assert.equal(r3.results.length, 20, "default limit 20");
		const dup = t.app.ctx.db.get<{ n: number }>("SELECT count(*) - count(DISTINCT space_id || ':' || conversation_id || ':' || entry_id) AS n FROM rt_search_docs")!.n;
		assert.equal(dup, 0);
		const w0 = Date.now();
		const r4 = await search(t, a.token, "编号N007", 50);
		const warm = Date.now() - w0;
		const m0 = Date.now();
		const items = (await t.json("GET", "/api/conversation-meta", { token: a.token })).items as unknown[];
		const metaMs = Date.now() - m0;
		assert.ok(hit(r4, convs[6]!));
		assert.equal((await search(t, a.token, "讨论预算", 50)).results.length, 50);
		assert.equal(items.length, 60);
		console.log(`[many-convs] 60 conversations: cold concurrent searches ${cold} ms, warm search ${warm} ms, conversation-meta ${metaMs} ms`);
		assert.ok(warm < 1500 && metaMs < 1500);
	} finally {
		await t.dispose();
	}
});
