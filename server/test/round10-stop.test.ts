// Round 10: 停止 / 继续 — what a stop keeps, what the next model request contains, and that nothing is silently dropped.
//   node --disable-warning=ExperimentalWarning --test server/test/round10-stop.test.ts
// Fixture model only (no real AI). The fixture records every request it serves (fixtureRequests), so "the model sees X" is checked on
// the real request, not inferred from the answer.
process.env.WORKROOM_FIXTURE_TOOLS = "1";
process.env.WORKROOM_RT_RETRY_BASE_MS ??= "20";
process.env.WORKROOM_RT_RETRY_MAX ??= "1";
process.env.WORKROOM_SSE_THROTTLE_MS ??= "20";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { waitFor } from "../src/runtime/testing.ts";
import { clearFixtureRequests, fixtureRequests } from "../src/runtime/fixture-model.ts";
import { effectCounterPath } from "../src/runtime/fixture-tools.ts";
import type { AbortResponse, ConversationState, ToolResultEntryDTO, UserEntryDTO } from "../../shared/chat.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(t: TestApp, email: string) {
	const a = await t.user(email);
	const c = (await t.json("POST", "/api/conversations", { token: a.token, json: {} })).conversation as { spaceId: string; conversationId: number };
	const base = `/api/conversations/${c.spaceId}/${c.conversationId}`;
	const send = (text: string, o: { mode?: string; attachments?: unknown[] } = {}): Promise<{ submissionId: number; status: string }> =>
		t.json("POST", `${base}/messages`, { token: a.token, json: { text, requestId: randomUUID(), mode: o.mode ?? "followUp", ...(o.attachments ? { attachments: o.attachments } : {}) } });
	const state = (): Promise<ConversationState> => t.json("GET", `${base}/state`, { token: a.token });
	const settle = (what: string, pred: (s: ConversationState) => boolean, timeoutMs = 20_000) => waitFor(async () => { const s = await state(); return pred(s) ? s : undefined; }, { timeoutMs, what });
	const stop = (): Promise<AbortResponse> => t.json("POST", `${base}/abort`, { token: a.token, json: {} });
	const cont = () => t.json("POST", `${base}/continue`, { token: a.token, json: {} });
	const users = (s: ConversationState) => s.entries.filter((e) => e.kind === "user" && (e as UserEntryDTO).placed !== false) as UserEntryDTO[];
	const results = (s: ConversationState) => s.entries.filter((e) => e.kind === "tool_result") as ToolResultEntryDTO[];
	return { a, c, base, send, state, settle, stop, cont, users, results };
}

const lastRequest = () => fixtureRequests().at(-1)!;

test("stop during a tool round: the input and every completed step stay; 继续 resumes from the stored context", async () => {
	const t = await startTestApp();
	try {
		const q = await setup(t, "r10-stop-tools@example.com");
		const text = '你帮我随意改一下 [[call wr_fixture_echo {"text":"第一步结果"}]] [[call wr_fixture_wait {"ms":60000}]]';
		const sent = await q.send(text);
		// the echo step is done and the wait step is running
		await q.settle("echo done, wait running", (s) => s.live.status === "running" && q.results(s).some((r) => r.toolName === "wr_fixture_echo"));
		await sleep(200);
		const r = await q.stop();
		assert.deepEqual({ ok: r.ok, unsent: r.unsent.length, cancelledApprovals: r.cancelledApprovals }, { ok: true, unsent: 0, cancelledApprovals: 0 });
		const s = await q.settle("aborted", (x) => x.live.status === "aborted");

		// What a stop keeps: the applied input (placed, in the conversation), the assistant step, the finished result, the cut-off result.
		const u = q.users(s);
		assert.equal(u.length, 1, "the user input is still in the conversation");
		assert.equal(u[0]!.text, text);
		assert.equal(u[0]!.submission?.submissionId, sent.submissionId);
		assert.equal(u[0]!.submission?.status, "unanswered", "pi-durable settles the run's input as unanswered/aborted ...");
		assert.equal(u[0]!.submission?.reason, "aborted");
		assert.equal(u[0]!.placed, undefined, "... but it was placed: it is NOT an unsent message (the UI says 已停止, never 未送达)");
		assert.ok(Number.isInteger((u[0]!.submission as any).entryId) || u[0]!.id > 0);
		assert.equal(s.entries.filter((e) => e.kind === "assistant").length, 1);
		const res = q.results(s);
		assert.equal(res.length, 2);
		const echo = res.find((x) => x.toolName === "wr_fixture_echo")!;
		const wait = res.find((x) => x.toolName === "wr_fixture_wait")!;
		assert.equal(echo.isError, false);
		assert.match(echo.text, /第一步结果/, "the completed step's result is kept");
		assert.equal(wait.isError, true);
		assert.match(wait.text, /Tool wr_fixture_wait was aborted/, "the cut-off step carries pi-durable's aborted result (the web labels it 已停止, not 失败)");
		assert.equal(s.live.failure?.reason, "aborted");
		assert.equal(s.queue.length, 0);

		// 继续: a real continue (no new message) — the next model request is built from the stored context.
		clearFixtureRequests();
		const c = await q.cont();
		assert.equal(c.status, "applied");
		const done = await q.settle("continued", (x) => x.live.status === "done" && x.entries.filter((e) => e.kind === "assistant").length === 2);
		assert.equal(fixtureRequests().length, 1, "exactly one model request for the continue");
		const req = lastRequest();
		assert.deepEqual(req.map((m) => m.role), ["user", "assistant", "toolResult", "toolResult"]);
		assert.equal(req[0]!.text, text, "the original user input is in the request");
		assert.deepEqual(req[1]!.toolCalls, ["wr_fixture_echo", "wr_fixture_wait"]);
		assert.match(req.find((m) => m.toolName === "wr_fixture_echo")!.text, /第一步结果/, "the completed tool result is in the request");
		assert.equal(req.find((m) => m.toolName === "wr_fixture_echo")!.isError, false);
		const cut = req.find((m) => m.toolName === "wr_fixture_wait")!;
		assert.equal(cut.isError, true, "the cut-off call is reported to the model as an error result, not hidden and not re-run");
		assert.match(cut.text, /aborted/);
		// Nothing was re-run: still exactly the one original assistant tool round.
		assert.equal(done.entries.filter((e) => e.kind === "assistant" && (e as any).toolCalls.length > 0).length, 1);
		assert.equal(q.results(done).length, 2);
		assert.equal(q.users(done).length, 1, "continue adds no user message");
		assert.match((done.entries.at(-1) as any).text, /第一步结果/);
	} finally {
		await t.dispose();
	}
});

test("stop while the model is still thinking: the input is in the context and the continue answers it", async () => {
	const t = await startTestApp();
	try {
		const q = await setup(t, "r10-stop-model@example.com");
		await q.send("[[slow 60000]] 先想想 [[reply 想好了]]");
		await q.settle("running", (s) => s.live.status === "running");
		await sleep(300);
		await q.stop();
		const s = await q.settle("aborted", (x) => x.live.status === "aborted");
		assert.equal(q.users(s).length, 1, "the input is not removed from the conversation");
		assert.equal(s.entries.filter((e) => e.kind === "assistant").length, 0);
		clearFixtureRequests();
		await q.cont();
		// the original directive says [[slow 60000]]: shorten the wait by checking the request as soon as it is made
		await waitFor(async () => fixtureRequests().length > 0 || undefined, { timeoutMs: 10_000, what: "model request after continue" });
		assert.deepEqual(lastRequest().map((m) => [m.role, m.text]), [["user", "[[slow 60000]] 先想想 [[reply 想好了]]"]]);
		await q.stop();
	} finally {
		await t.dispose();
	}
});

test("typing 「继续」 after a stop also keeps everything: the next request holds input, completed results and the new message", async () => {
	const t = await startTestApp();
	try {
		const q = await setup(t, "r10-stop-typed@example.com");
		const text = '随意改一下 [[call wr_fixture_echo {"text":"已完成的一步"}]] [[call wr_fixture_wait {"ms":60000}]]';
		await q.send(text);
		await q.settle("echo done", (s) => s.live.status === "running" && q.results(s).some((r) => r.toolName === "wr_fixture_echo"));
		await sleep(200);
		await q.stop();
		await q.settle("aborted", (x) => x.live.status === "aborted");
		clearFixtureRequests();
		await q.send("继续 [[reply 好的，接着做]]");
		const done = await q.settle("answered", (x) => x.live.status === "done" && q.users(x).length === 2);
		const req = lastRequest();
		assert.deepEqual(req.map((m) => m.role), ["user", "assistant", "toolResult", "toolResult", "user"]);
		assert.equal(req[0]!.text, text);
		assert.match(req[2]!.text, /已完成的一步/);
		assert.match(req[4]!.text, /^继续/);
		// the first message keeps its honest outcome; the new one is answered
		const [first, second] = q.users(done);
		assert.equal(first!.submission?.reason, "aborted");
		assert.equal(first!.placed, undefined);
		assert.equal(second!.submission?.status, "done");
	} finally {
		await t.dispose();
	}
});

test("stop with messages still queued: they come back in the response (text + attachments), stay as 未送达 markers, and the applied input stays", async () => {
	const t = await startTestApp();
	try {
		const q = await setup(t, "r10-stop-queue@example.com");
		const att = { fileId: "f1", versionId: "v1", name: "报价单.xlsx" };
		await q.send("[[slow 60000]] 长任务");
		await q.settle("running", (s) => s.live.status === "running");
		await q.send("排队一");
		await q.send("排队二", { attachments: [att] });
		const r = await q.stop();
		assert.deepEqual(r.unsent.map((u) => u.text), ["排队一", "排队二"], "in send order");
		assert.deepEqual(r.unsent[1]!.attachments, [att], "attachments come back too");
		assert.ok(r.unsent.every((u) => Number.isInteger(u.submissionId)));
		const s = await q.settle("aborted", (x) => x.live.status === "aborted");
		assert.equal(s.queue.length, 0);
		assert.deepEqual(q.users(s).map((e) => e.text), ["[[slow 60000]] 长任务"], "the applied input stays placed");
		const unsent = s.entries.filter((e) => e.kind === "user" && (e as UserEntryDTO).placed === false) as UserEntryDTO[];
		assert.deepEqual(unsent.map((e) => e.text), ["排队一", "排队二"], "and the unsent ones stay visible, marked placed:false");
		// they never reached the model: a continue does not include them
		clearFixtureRequests();
		await q.cont();
		await waitFor(async () => fixtureRequests().length > 0 || undefined, { timeoutMs: 10_000, what: "request" });
		assert.deepEqual(lastRequest().map((m) => m.text), ["[[slow 60000]] 长任务"]);
		await q.stop();
	} finally {
		await t.dispose();
	}
});

test("stop while an approval is pending: the card is cancelled (not left to approve a call that no longer exists); continue still works", async () => {
	const t = await startTestApp();
	try {
		const q = await setup(t, "r10-stop-approval@example.com");
		await q.send('发布 [[call wr_fixture_echo {"text":"准备好了"}]] [[call wr_fixture_approval {"title":"发布","summary":"确认发布"}]]');
		const waiting = await q.settle("waiting", (s) => s.live.status === "waiting_approval" && s.approvals.length === 1);
		assert.equal(waiting.approvals[0]!.status, "pending");
		const r = await q.stop();
		assert.equal(r.cancelledApprovals, 1);
		const s = await q.settle("aborted", (x) => x.live.status === "aborted");
		assert.equal(s.approvals[0]!.status, "cancelled");
		assert.equal(s.approvals[0]!.decidedBy, undefined, "nobody decided it");
		assert.match(s.approvals[0]!.note ?? "", /停止/);
		assert.equal(s.approvals.filter((x) => x.status === "pending").length, 0);
		// a late click on the old card is refused, it cannot "approve" anything
		await t.json("POST", `${q.base}/approvals/${s.approvals[0]!.approvalId}`, { token: q.a.token, json: { decision: "approved" }, expect: 409 });
		// handoff lists no pending approval and does not count the cancelled one as a decision
		const h = await t.json("GET", `${q.base}/handoff`, { token: q.a.token });
		assert.equal(h.pending.approvals.length, 0);
		assert.equal(h.decisions.length, 0);
		clearFixtureRequests();
		await q.cont();
		await q.settle("done", (x) => x.live.status === "done");
		assert.match(lastRequest().find((m) => m.toolName === "wr_fixture_approval")!.text, /aborted/);
	} finally {
		await t.dispose();
	}
});

test("stop during an external write: it is never re-run by continue, and it is surfaced as 待核对 (outcome unknown), not forgotten", async () => {
	const t = await startTestApp();
	try {
		const q = await setup(t, "r10-stop-effect@example.com");
		await q.send('写外部系统 [[call wr_fixture_effect {"key":"r10-k1","holdMs":60000}]]');
		await waitFor(async () => { try { return readFileSync(effectCounterPath(t.dataDir, "r10-k1"), "utf8").trim().split("\n").length === 1 || undefined; } catch { return undefined; } }, { timeoutMs: 15_000, what: "the write started" });
		await q.stop();
		const s = await q.settle("aborted", (x) => x.live.status === "aborted");
		assert.equal(s.effects.length, 1);
		assert.equal(s.effects[0]!.status, "needs_reconciliation", "the person is asked to verify; the stop never decides for them");
		assert.match(s.effects[0]!.error ?? "", /停止/);
		await q.cont();
		await q.settle("done", (x) => x.live.status === "done" && x.entries.filter((e) => e.kind === "assistant").length === 2);
		assert.equal(readFileSync(effectCounterPath(t.dataDir, "r10-k1"), "utf8").trim().split("\n").length, 1, "continue did not perform the external write a second time");
	} finally {
		await t.dispose();
	}
});

test("a failed run keeps the input and completed steps too: 重试 (continue) sends the stored context again", async () => {
	const t = await startTestApp();
	try {
		const q = await setup(t, "r10-failed@example.com");
		const text = '先做一步 [[call wr_fixture_echo {"text":"失败前完成"}]]';
		await q.send(text);
		await q.settle("answered", (s) => s.live.status === "done");
		const bad = "再来 [[fail]]";
		await q.send(bad);
		const s = await q.settle("failed", (x) => x.live.status === "failed");
		assert.equal(q.users(s).length, 2, "both inputs are in the conversation");
		assert.equal(q.users(s)[1]!.placed, undefined);
		clearFixtureRequests();
		await q.cont();
		await q.settle("failed again", (x) => x.live.status === "failed");
		const req = lastRequest();
		assert.equal(req[0]!.text, text);
		assert.match(req.find((m) => m.toolName === "wr_fixture_echo")!.text, /失败前完成/);
		assert.equal(req.at(-1)!.text, bad, "the input that failed is the last message of the retry request");
	} finally {
		await t.dispose();
	}
});
