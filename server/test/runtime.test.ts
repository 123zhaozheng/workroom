// Runtime core tests (group A): conversations, messages, SSE, fork/edit/regenerate, steer feedback, terminal states.
// Real app (startTestApp), real SQLite files, fixture model. Run:
//   node --disable-warning=ExperimentalWarning --test server/test/runtime.test.ts
process.env.WORKROOM_FIXTURE_TOOLS = "1";
process.env.WORKROOM_RT_RETRY_BASE_MS ??= "20";
process.env.WORKROOM_RT_RETRY_MAX ??= "1";
process.env.WORKROOM_SSE_THROTTLE_MS ??= "20";

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { offerAllTools } from "./helpers/ondemand.ts";
import { isSettled, sseReader, waitFor } from "../src/runtime/testing.ts";
import type { ConversationState, EntryDTO, SubmissionDTO } from "../../shared/chat.ts";

const rid = () => randomUUID();

async function newChat(t: TestApp, token: string, body: Record<string, unknown> = {}) {
	const r = await t.json("POST", "/api/conversations", { token, json: body });
	return r.conversation as { spaceId: string; conversationId: number; title: string };
}
const base = (c: { spaceId: string; conversationId: number }) => `/api/conversations/${c.spaceId}/${c.conversationId}`;

async function send(t: TestApp, token: string, c: { spaceId: string; conversationId: number }, text: string, extra: Record<string, unknown> = {}) {
	return (await t.json("POST", `${base(c)}/messages`, { token, json: { text, requestId: rid(), ...extra } })) as { submissionId: number; status: string; submission: SubmissionDTO };
}
async function settle(t: TestApp, token: string, c: { spaceId: string; conversationId: number }, submissionId: number, timeoutMs = 15_000): Promise<SubmissionDTO> {
	return waitFor(async () => {
		const s = (await t.json("GET", `${base(c)}/submissions/${submissionId}`, { token })) as SubmissionDTO;
		return isSettled(s) ? s : undefined;
	}, { timeoutMs, what: `submission ${submissionId} settles` });
}
async function entries(t: TestApp, token: string, c: { spaceId: string; conversationId: number }): Promise<EntryDTO[]> {
	return (await t.json("GET", `${base(c)}/entries?limit=200`, { token })).items;
}
const texts = (es: EntryDTO[]) => es.filter((e) => e.kind === "user" || e.kind === "assistant").map((e) => `${e.kind}:${(e as any).text}`);

test("runtime: create, send, answer; entries paging; per-space durable.sqlite; fixture labelled", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("rt-a@example.com");
		const c = await newChat(t, a.token);
		assert.equal(c.title, "新对话");
		const r = await send(t, a.token, c, "你好 [[reply 世界]]");
		assert.ok(["applied", "queued", "received", "done"].includes(r.status));
		const s = await settle(t, a.token, c, r.submissionId);
		assert.equal(s.status, "done");
		const es = await entries(t, a.token, c);
		assert.equal(es[0]!.kind, "start");
		const asst = es.find((e) => e.kind === "assistant") as any;
		assert.ok(asst.fixture, "assistant entry flagged as fixture");
		assert.match(asst.text, /测试模型·非真实AI.*世界/);
		const user = es.find((e) => e.kind === "user") as any;
		assert.equal(user.userId, a.me.userId);
		assert.equal(user.text, "你好 [[reply 世界]]");
		// auto title from the first message
		const d = await t.json("GET", base(c), { token: a.token });
		assert.equal(d.conversation.title, "你好");
		assert.equal(d.agent.fixture, true);
		assert.match(d.agent.modelLabel, /测试模型/);
		// storage per space under the space dir
		const space = t.app.ctx.services.get("identity").space(c.spaceId)!;
		assert.ok(existsSync(join(space.dir, "durable.sqlite")));
		// paging
		for (let i = 0; i < 3; i++) await settle(t, a.token, c, (await send(t, a.token, c, `q${i}`)).submissionId);
		const p1 = await t.json("GET", `${base(c)}/entries?limit=3`, { token: a.token });
		assert.equal(p1.items.length, 3);
		assert.ok(p1.next);
		const p2 = await t.json("GET", `${base(c)}/entries?limit=3&before=${p1.next}`, { token: a.token });
		assert.ok(p2.items.every((e: EntryDTO) => e.id < p1.next));
		// list
		const list = await t.json("GET", "/api/conversations", { token: a.token });
		assert.equal(list.conversations.length, 1);
		assert.equal(list.conversations[0].conversationId, c.conversationId);
	} finally {
		await t.dispose();
	}
});

test("runtime: same requestId returns the same submission and writes no duplicate entry", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("rt-dup@example.com");
		const c = await newChat(t, a.token);
		const requestId = rid();
		const r1 = await t.json("POST", `${base(c)}/messages`, { token: a.token, json: { text: "once [[reply ok]]", requestId } });
		await settle(t, a.token, c, r1.submissionId);
		const r2 = await t.json("POST", `${base(c)}/messages`, { token: a.token, json: { text: "once [[reply ok]]", requestId } });
		assert.equal(r2.submissionId, r1.submissionId);
		assert.equal(r2.status, "done");
		const users = (await entries(t, a.token, c)).filter((e) => e.kind === "user");
		assert.equal(users.length, 1);
	} finally {
		await t.dispose();
	}
});

test("runtime: SSE snapshot then throttled state; disconnect does not stop the run", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("rt-sse@example.com");
		const c = await newChat(t, a.token);
		const res = await t.req("GET", `${base(c)}/events`, { token: a.token });
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
		const sse = sseReader(res);
		const snap = await sse.next((e) => e.event === "snapshot");
		assert.equal(snap.data.conversation.conversationId, c.conversationId);
		assert.equal(snap.data.live.status, "idle");
		const r = await send(t, a.token, c, "[[slow 800]] 慢一点 [[reply 完成]]");
		const running = await sse.state((s) => s.live.busy);
		assert.equal(running.live.status, "running");
		await sse.close(); // browser closes mid-run
		const s = await settle(t, a.token, c, r.submissionId);
		assert.equal(s.status, "done");
		const es = await entries(t, a.token, c);
		assert.ok(texts(es).some((x) => x.includes("完成")));
		// reconnect: snapshot shows the finished state
		const sse2 = sseReader(await t.req("GET", `${base(c)}/events`, { token: a.token }));
		const snap2: ConversationState = (await sse2.next((e) => e.event === "snapshot")).data;
		assert.equal(snap2.live.status, "done");
		assert.ok(snap2.entries.some((e) => e.kind === "assistant" && (e as any).text.includes("完成")));
		await sse2.close();
	} finally {
		await t.dispose();
	}
});

test("runtime: fork from a middle entry; original and branch continue independently", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("rt-fork@example.com");
		const c = await newChat(t, a.token);
		await settle(t, a.token, c, (await send(t, a.token, c, "第一问 [[reply A1]]")).submissionId);
		await settle(t, a.token, c, (await send(t, a.token, c, "第二问 [[reply A2]]")).submissionId);
		const before = await entries(t, a.token, c);
		const firstAnswer = before.find((e) => e.kind === "assistant")!;
		const { conversation: br } = await t.json("POST", `${base(c)}/fork`, { token: a.token, json: { entryId: firstAnswer.id } });
		assert.equal(br.kind, "branch");
		assert.deepEqual(br.parent, { conversationId: c.conversationId, entryId: firstAnswer.id });
		const brEntries = await entries(t, a.token, br);
		assert.deepEqual(texts(brEntries), texts(before).slice(0, 2));
		await settle(t, a.token, br, (await send(t, a.token, br, "分支问 [[reply B1]]")).submissionId);
		await settle(t, a.token, c, (await send(t, a.token, c, "原会话继续 [[reply A3]]")).submissionId);
		const orig = texts(await entries(t, a.token, c));
		const branch = texts(await entries(t, a.token, br));
		assert.ok(orig.some((x) => x.includes("A3")) && !orig.some((x) => x.includes("B1")));
		assert.ok(branch.some((x) => x.includes("B1")) && !branch.some((x) => x.includes("A2") || x.includes("A3")));
		assert.deepEqual(orig.slice(0, before.filter((e) => e.kind === "user" || e.kind === "assistant").length), texts(before), "original unchanged");
		const d = await t.json("GET", base(c), { token: a.token });
		assert.deepEqual(d.branches.map((b: any) => b.conversationId), [br.conversationId]);
		// refresh: branch is in the list and findable again
		const list = await t.json("GET", "/api/conversations", { token: a.token });
		assert.ok(list.conversations.some((x: any) => x.conversationId === br.conversationId && x.kind === "branch"));
	} finally {
		await t.dispose();
	}
});

test("runtime: edit and regenerate create branches and keep the original", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("rt-edit@example.com");
		const c = await newChat(t, a.token);
		await settle(t, a.token, c, (await send(t, a.token, c, "原问题 [[reply R1]]")).submissionId);
		const orig = await entries(t, a.token, c);
		const user = orig.find((e) => e.kind === "user")!;
		const asst = orig.find((e) => e.kind === "assistant")!;
		const ed = await t.json("POST", `${base(c)}/edit`, { token: a.token, json: { entryId: user.id, text: "改过的问题 [[reply R2]]", requestId: rid() } });
		await settle(t, a.token, ed.conversation, ed.submissionId);
		const edited = texts(await entries(t, a.token, ed.conversation));
		assert.deepEqual(edited, ["user:改过的问题 [[reply R2]]", "assistant:【测试模型·非真实AI】 R2"]);
		const rg = await t.json("POST", `${base(c)}/regenerate`, { token: a.token, json: { entryId: asst.id } });
		const rs = await settle(t, a.token, rg.conversation, rg.submissionId);
		assert.equal(rs.status, "done");
		const regen = texts(await entries(t, a.token, rg.conversation));
		assert.deepEqual(regen, ["user:原问题 [[reply R1]]", "assistant:【测试模型·非真实AI】 R1"]);
		assert.deepEqual(texts(await entries(t, a.token, c)), texts(orig), "original untouched");
	} finally {
		await t.dispose();
	}
});

test("runtime: steer feedback received → applied → done; follow-up queued; withdraw; abort and failure states", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("rt-steer@example.com");
		const c = await newChat(t, a.token);
		const first = await send(t, a.token, c, `[[call wr_fixture_wait {"ms":800}]]`);
		await waitFor(async () => (await t.json("GET", `${base(c)}/submissions/${first.submissionId}`, { token: a.token })).status === "applied");
		const steer = await send(t, a.token, c, "顺便说一句 [[reply 收到插话]]", { mode: "steer" });
		assert.equal(steer.status, "received");
		const follow = await send(t, a.token, c, "之后再做 [[reply 后续]]", { mode: "followUp" });
		assert.equal(follow.status, "queued");
		const extra = await send(t, a.token, c, "算了", { mode: "followUp" });
		const w = await t.json("POST", `${base(c)}/submissions/${extra.submissionId}/withdraw`, { token: a.token });
		assert.equal(w.result, "aborted");
		assert.equal(w.submission.status, "withdrawn");
		assert.equal((await settle(t, a.token, c, steer.submissionId)).status, "done");
		assert.equal((await settle(t, a.token, c, first.submissionId)).status, "done");
		assert.equal((await settle(t, a.token, c, follow.submissionId)).status, "done");

		// abort → independent terminal "aborted"
		const slow = await send(t, a.token, c, "[[slow 5000]] 很慢");
		await waitFor(async () => (await t.json("GET", `${base(c)}/submissions/${slow.submissionId}`, { token: a.token })).status === "applied");
		await t.json("POST", `${base(c)}/abort`, { token: a.token, json: {} });
		const ab = await settle(t, a.token, c, slow.submissionId);
		assert.equal(ab.status, "unanswered");
		assert.equal(ab.reason, "aborted");
		const sse = sseReader(await t.req("GET", `${base(c)}/events`, { token: a.token }));
		assert.equal((await sse.next((e) => e.event === "snapshot")).data.live.status, "aborted");
		await sse.close();

		// model failure → "failed"; continue resumes
		const bad = await send(t, a.token, c, "[[fail]]");
		const bs = await settle(t, a.token, c, bad.submissionId);
		assert.equal(bs.status, "unanswered");
		assert.equal(bs.reason, "model_error");
		const sse2 = sseReader(await t.req("GET", `${base(c)}/events`, { token: a.token }));
		const st: ConversationState = (await sse2.next((e) => e.event === "snapshot")).data;
		assert.equal(st.live.status, "failed");
		assert.equal(st.live.failure?.reason, "model_error");
		await sse2.close();
	} finally {
		await t.dispose();
	}
});

test("runtime: approvals are durable docs; decision via API resumes the tool", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("rt-ap@example.com");
		const c = await newChat(t, a.token);
		const sse = sseReader(await t.req("GET", `${base(c)}/events`, { token: a.token }));
		await sse.next((e) => e.event === "snapshot");
		const r = await send(t, a.token, c, `[[call wr_fixture_approval {"title":"发送邮件","summary":"给客户发送报价单"}]]`);
		const waiting = await sse.state((s) => s.approvals.some((x) => x.status === "pending"));
		assert.equal(waiting.live.status, "waiting_approval");
		const ap = waiting.approvals[0]!;
		assert.equal(ap.summary, "给客户发送报价单");
		assert.equal(ap.requestedFor, a.me.userId);
		const b = await t.user("rt-ap-b@example.com");
		await t.json("POST", `${base(c)}/approvals/${ap.approvalId}`, { token: b.token, json: { decision: "approved" }, expect: 403 });
		await t.json("POST", `${base(c)}/approvals/${ap.approvalId}`, { token: a.token, json: { decision: "approved", note: "可以" } });
		await t.json("POST", `${base(c)}/approvals/${ap.approvalId}`, { token: a.token, json: { decision: "rejected" }, expect: 409 });
		const s = await settle(t, a.token, c, r.submissionId);
		assert.equal(s.status, "done");
		const es = await entries(t, a.token, c);
		assert.ok(es.some((e) => e.kind === "tool_result" && (e as any).text.includes("decision: approved (可以)")));
		await sse.close();
	} finally {
		await t.dispose();
	}
});

test("runtime M09-B / M13-C: a project member takes over — sees the same state (two devices), decides the pending approval; a viewer cannot", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("rt-hand-a@example.com");
		const { invite } = await t.json("POST", "/api/admin/invites", { token: a.token, json: { role: "member" } });
		const b = await t.user("rt-hand-b@example.com", { inviteCode: invite.code });
		const v = await t.user("rt-hand-v@example.com", { inviteCode: (await t.json("POST", "/api/admin/invites", { token: a.token, json: { role: "member" } })).invite.code });
		const { project } = await t.json("POST", "/api/projects", { token: a.token, json: { kind: "space", name: "交接" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: a.token, json: { email: "rt-hand-b@example.com", role: "editor" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: a.token, json: { email: "rt-hand-v@example.com", role: "viewer" } });
		const c = await newChat(t, a.token, { projectId: project.id });
		const r = await send(t, a.token, c, `[[call wr_fixture_approval {"title":"发布","summary":"发布季度报告到官网"}]]`);
		const sa = sseReader(await t.req("GET", `${base(c)}/events`, { token: a.token }));
		const sb = sseReader(await t.req("GET", `${base(c)}/events`, { token: b.token }));
		const stA = await sa.state((s) => s.approvals.some((x) => x.status === "pending"));
		const stB = await sb.state((s) => s.approvals.some((x) => x.status === "pending"));
		assert.deepEqual(stB.approvals, stA.approvals);
		assert.deepEqual(stB.entries.map((e) => e.id), stA.entries.map((e) => e.id));
		assert.equal(stB.live.status, "waiting_approval");
		// the viewer can read but not decide or send
		await t.json("GET", `${base(c)}/state`, { token: v.token });
		await t.json("POST", `${base(c)}/approvals/${stA.approvals[0]!.approvalId}`, { token: v.token, json: { decision: "approved" }, expect: 403 });
		await t.json("POST", `${base(c)}/messages`, { token: v.token, json: { text: "x", requestId: rid() }, expect: 403 });
		// B (editor) takes over: decides and continues the work
		await t.json("POST", `${base(c)}/approvals/${stA.approvals[0]!.approvalId}`, { token: b.token, json: { decision: "approved", note: "B 接手批准" } });
		await settle(t, a.token, c, r.submissionId);
		const doneA = await sa.state((s) => s.live.status === "done");
		const doneB = await sb.state((s) => s.live.status === "done");
		assert.equal(doneA.approvals[0]!.decidedBy, b.me.userId);
		assert.deepEqual(doneB.entries.map((e) => e.id), doneA.entries.map((e) => e.id));
		const r2 = await send(t, b.token, c, "我来继续 [[reply 交接完成]]");
		await settle(t, b.token, c, r2.submissionId);
		const es = await entries(t, a.token, c);
		assert.equal((es.filter((e) => e.kind === "user").at(-1) as any).userId, b.me.userId);
		await sa.close();
		await sb.close();
	} finally {
		await t.dispose();
	}
});

test("fixture model: directive parsing, schema-driven demo args, labelled answers", async () => {
	const { parseDirectives, demoArgs, fixtureAnswer } = await import("../src/runtime/fixture-model.ts");
	const d = parseDirectives(`a [[call t1 {"x":"]]","n":{"k":[1,2]}}]] b [[call t2]] [[slow 250]] [[fail]] [[reply hi there]]`);
	assert.deepEqual(d.calls, [{ name: "t1", args: { x: "]]", n: { k: [1, 2] } } }, { name: "t2", args: {} }]);
	assert.equal(d.slowMs, 250);
	assert.equal(d.fail, true);
	assert.equal(d.reply, "hi there");
	const args = demoArgs({ type: "object", properties: { name: { type: "string" }, format: { enum: ["docx", "md"] }, content: { type: "string" }, extra: { type: "string" } }, required: ["name", "format"] }, { title: "周报", content: "正文", query: "q" });
	assert.deepEqual(args, { name: "周报", format: "md", content: "正文" });
	const sys = { role: "system", content: "", toolsAdded: [{ name: "kb_search", description: "", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }], timestamp: 0 } as any;
	const a1 = fixtureAnswer([sys, { role: "user", content: "查一下知识库里的资料", timestamp: 0 } as any]);
	assert.equal(a1.message.stopReason, "toolUse");
	assert.equal((a1.message.content[0] as any).name, "kb_search");
	const a2 = fixtureAnswer([{ role: "user", content: "你好", timestamp: 0 } as any]);
	assert.match((a2.message.content[0] as any).text, /^【测试模型·非真实AI】/);
});

test("fixture demo mode drives the real delivery chain: 生成 → write /work/report.md → present_file → library", async (tc) => {
	const t = await startTestApp();
	try {
		if (!t.app.ctx.services.has("files")) return tc.skip("files module not loaded");
		const a = await t.user("rt-demo@example.com");
		const c = await newChat(t, a.token);
		const r = await send(t, a.token, c, "请帮我生成一份周报");
		await settle(t, a.token, c, r.submissionId);
		const es = await entries(t, a.token, c);
		const wr = es.find((e) => e.kind === "tool_result" && (e as any).toolName === "write") as any;
		assert.ok(wr && !wr.isError, `write: ${JSON.stringify(wr)}`);
		const pr = es.find((e) => e.kind === "tool_result" && (e as any).toolName === "present_file") as any;
		assert.ok(pr && !pr.isError, `present_file: ${JSON.stringify(pr)}`);
		assert.equal(pr.details.kind, "wr.presented");
		const lib = await t.json("GET", `/api/library?spaceId=${c.spaceId}&conversationId=${c.conversationId}`, { token: a.token });
		assert.equal(lib.items.length, 1);
		assert.match((es.at(-1) as any).text, /测试模型·非真实AI/);
	} finally {
		await t.dispose();
	}
});

test("runtime: input validation — unknown/unlisted model refused, chip shapes checked, title search escapes wildcards", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("rt-val@example.com");
		await t.json("POST", "/api/conversations", { token: a.token, json: { modelId: "someprovider/some-model" }, expect: 400 });
		const c = await newChat(t, a.token, { title: "100% 完成" });
		await newChat(t, a.token, { title: "别的" });
		const r = await t.json("POST", `${base(c)}/messages`, { token: a.token, json: { text: "x", requestId: rid(), attachments: [{ fileId: 1 }] }, expect: 400 });
		assert.equal(r.error.code, "invalid_attachments");
		await t.json("POST", `${base(c)}/messages`, { token: a.token, json: { text: "", requestId: rid() }, expect: 400 });
		await t.json("POST", `${base(c)}/messages`, { token: a.token, json: { text: "x" }, expect: 400 });
		const hits = await t.json("GET", `/api/conversations?q=${encodeURIComponent("%")}`, { token: a.token });
		assert.deepEqual(hits.conversations.map((x: any) => x.title), ["100% 完成"]);
	} finally {
		await t.dispose();
	}
});

test("runtime: per-message outcome (B) — done, aborted, model_error, withdrawn are on the exact message after reload", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("rt-outcome@example.com");
		const c = await newChat(t, a.token);
		const ok = await send(t, a.token, c, "好的 [[reply ok]]");
		await settle(t, a.token, c, ok.submissionId);
		const bad = await send(t, a.token, c, "[[fail]]");
		await settle(t, a.token, c, bad.submissionId);
		const slow = await send(t, a.token, c, "[[slow 5000]] 会被停止");
		await waitFor(async () => (await t.json("GET", `${base(c)}/submissions/${slow.submissionId}`, { token: a.token })).status === "applied");
		const queued = await send(t, a.token, c, "排队中被停止", { mode: "followUp" });
		const withdrawn = await send(t, a.token, c, "撤回这条", { mode: "followUp" });
		await t.json("POST", `${base(c)}/submissions/${withdrawn.submissionId}/withdraw`, { token: a.token });
		await t.json("POST", `${base(c)}/abort`, { token: a.token, json: {} });
		await settle(t, a.token, c, queued.submissionId);
		// reload: entries and SSE snapshot both carry the outcome on each message
		const users = (await entries(t, a.token, c)).filter((e) => e.kind === "user") as any[];
		const by = (text: string) => users.find((u) => u.text.includes(text));
		assert.equal(by("好的").submission.submissionId, ok.submissionId);
		assert.equal(by("好的").submission.status, "done");
		assert.ok(users.length && Number.isInteger(by("好的").submission.answerEntryId));
		assert.equal(by("[[fail]]").submission.status, "unanswered");
		assert.equal(by("[[fail]]").submission.reason, "model_error");
		assert.equal(by("会被停止").submission.status, "unanswered");
		assert.equal(by("会被停止").submission.reason, "aborted");
		assert.equal(by("撤回这条").submission.status, "withdrawn");
		assert.equal(by("撤回这条").placed, false);
		assert.equal(by("排队中被停止").submission.status, "withdrawn");
		assert.equal(by("排队中被停止").placed, false);
		assert.equal(by("好的").placed, undefined);
		const sse = sseReader(await t.req("GET", `${base(c)}/events`, { token: a.token }));
		const snap: ConversationState = (await sse.next((e) => e.event === "snapshot")).data;
		assert.equal((snap.entries.find((e) => e.kind === "user" && (e as any).text.includes("撤回这条")) as any).submission.status, "withdrawn");
		await sse.close();
		// the unplaced trace is display-only: the model never saw it
		const next = await send(t, a.token, c, "继续 [[reply 仍正常]]");
		assert.equal((await settle(t, a.token, c, next.submissionId)).status, "done");
	} finally {
		await t.dispose();
	}
});

test("runtime: server-side title — directives stripped, first meaningful line, PATCH wins", async () => {
	const { titleFrom } = await import("../src/runtime/service.ts");
	assert.equal(titleFrom(`[[call wr_fixture_echo {"text":"a]]b"}]] [[slow 10]]`), "");
	assert.equal(titleFrom("\n  \n  季度   报告 [[reply x]] 草稿\n第二行"), "季度 报告 草稿");
	assert.equal(titleFrom("— — —\n真正的标题"), "真正的标题");
	assert.equal(titleFrom("字".repeat(60)).length, 40);
	const t = await startTestApp();
	try {
		const a = await t.user("rt-title@example.com");
		const c = await newChat(t, a.token);
		await settle(t, a.token, c, (await send(t, a.token, c, `[[call wr_fixture_echo {"text":"x"}]]`)).submissionId);
		assert.equal((await t.json("GET", base(c), { token: a.token })).conversation.title, "新对话");
		await settle(t, a.token, c, (await send(t, a.token, c, "整理客户反馈 [[reply ok]]")).submissionId);
		assert.equal((await t.json("GET", base(c), { token: a.token })).conversation.title, "整理客户反馈");
		await t.json("PATCH", base(c), { token: a.token, json: { title: "我的标题" } });
		await settle(t, a.token, c, (await send(t, a.token, c, "别改标题 [[reply ok]]")).submissionId);
		assert.equal((await t.json("GET", base(c), { token: a.token })).conversation.title, "我的标题");
	} finally {
		await t.dispose();
	}
});

test("runtime: usage from the fixture is flagged simulated (totals, per model, per entry); real models are not", async () => {
	const { usageFromState } = await import("../src/runtime/dto.ts");
	const u = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } };
	const mixed = usageFromState({ models: { "fixture/workroom-fixture": u, "workroom/claude": u }, tools: {} } as any);
	assert.equal(mixed.simulated, true);
	assert.deepEqual(mixed.byModel!.map((m) => [m.key, m.simulated]), [["fixture/workroom-fixture", true], ["workroom/claude", false]]);
	const real = usageFromState({ models: { "workroom/claude": u }, tools: {} } as any);
	assert.equal(real.simulated, undefined);
	const t = await startTestApp();
	try {
		const a = await t.user("rt-usage@example.com");
		const c = await newChat(t, a.token);
		await settle(t, a.token, c, (await send(t, a.token, c, "用量 [[reply ok]]")).submissionId);
		const st: ConversationState = await t.json("GET", `${base(c)}/state`, { token: a.token });
		assert.equal(st.usage.simulated, true);
		assert.equal(st.usage.costTotal, 0);
		assert.deepEqual(st.usage.byModel!.map((m) => [m.key, m.simulated]), [["fixture/workroom-fixture", true]]);
		const asst = st.entries.find((e) => e.kind === "assistant") as any;
		assert.equal(asst.usage.simulated, true);
		assert.equal(st.agent.fixture, true);
	} finally {
		await t.dispose();
	}
});

test("default toolset policy: a default conversation gets every product tool (ACL-checked per call); demo mode fills the terminal panel", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("rt-tools@example.com");
		const created = await t.json("POST", "/api/conversations", { token: a.token, json: {} });
		const tools: string[] = created.agent.tools;
		const s = t.app.ctx.services;
		const expect = [
			// round 14: the unified file/exec tools replace file_* / sandbox_* / code_run in new conversations
			...(s.has("vfs") ? ["ls", "read", "write", "edit", "search", "remove", "present_file", "copy_to_work"] : []),
			...(s.has("knowledge") ? ["kb_search"] : []),
			...(s.has("sandbox") ? ["exec"] : []), // round 16: codemode, job_*, browser_*, credential_*, skill_manage are on demand (tool_search)
			...(s.has("browser") ? ["browse"] : []),
			...(s.has("mcp") ? ["tool_search"] : []),
			"delegate",
		];
		for (const name of expect) assert.ok(tools.includes(name), `default conversation offers ${name}`);
		for (const name of ["file_create", "file_revise", "file_read", "file_list", "sandbox_exec", "sandbox_write_file", "sandbox_publish", "code_run", "memory_save", "skill"]) assert.ok(!tools.includes(name), `a new conversation no longer offers ${name}`);
		// MCP connector tools are deferred (offered only via tool_search, per user); no raw mcp__ tool is offered by default
		assert.ok(!tools.some((n) => n.startsWith("mcp__")));
		if (!s.has("sandbox")) return;
		const c = created.conversation;
		const r = await t.json("POST", `${base(c)}/messages`, { token: a.token, json: { text: "帮我在终端运行一下", requestId: rid() } });
		await settle(t, a.token, c, r.submissionId, 30_000);
		const es = await entries(t, a.token, c);
		const tr = es.find((e) => e.kind === "tool_result") as any;
		assert.equal(tr.toolName, "exec");
		assert.equal(tr.isError, false, tr.text);
		assert.match(tr.text, /sandbox ok/);
	} finally {
		await t.dispose();
	}
});

test("work (D): SSE state carries jobs from the work service and re-emits on wr.jobs changes (running → done) without polling", async (tc) => {
	const t = await startTestApp();
	try {
		if (!t.app.ctx.services.has("work") || !t.app.ctx.services.has("sandbox")) return tc.skip("tools module (work/sandbox) not loaded");
		const a = await t.user("rt-work@example.com");
		const c = await newChat(t, a.token);
		await offerAllTools(t, c);
		const sse = sseReader(await t.req("GET", `${base(c)}/events`, { token: a.token }));
		const snap: ConversationState = (await sse.next((e) => e.event === "snapshot")).data;
		assert.deepEqual(snap.work?.jobs ?? [], []);
		const job = { kind: "sandbox", title: "慢任务", sandbox: { language: "shell", code: "sleep 1.5; echo job-finished" } };
		const r = await send(t, a.token, c, `[[call job_start ${JSON.stringify(job)}]]`);
		const running = await sse.state((s) => s.work?.jobs.some((j) => j.title === "慢任务" && (j.status === "running" || j.status === "queued")) ?? false, 15_000);
		assert.ok(running.work!.browserSessions);
		await settle(t, a.token, c, r.submissionId);
		// the chat answered already; the job finishes later and the stream re-emits by itself
		const done = await sse.state((s) => s.work?.jobs.some((j) => j.title === "慢任务" && j.status === "done") ?? false, 20_000);
		assert.equal(done.work!.jobs.find((j) => j.title === "慢任务")!.status, "done");
		await sse.close();
		const st: ConversationState = await t.json("GET", `${base(c)}/state`, { token: a.token });
		assert.equal(st.work!.jobs[0]!.status, "done");
	} finally {
		await t.dispose();
	}
});
