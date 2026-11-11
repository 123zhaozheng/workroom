// Round 8 (Q1): the message queue behind the composer — server side, fixture model (no real AI).
// Queued follow-ups live durably in pi-durable's inbox; 立即发送 = POST …/promote (withdraw + steer resubmit `${requestId}::now`).
//   node --disable-warning=ExperimentalWarning --test server/test/round8-queue.test.ts
process.env.WORKROOM_FIXTURE_TOOLS = "1";
process.env.WORKROOM_RT_RETRY_BASE_MS ??= "20";
process.env.WORKROOM_RT_RETRY_MAX ??= "1";
process.env.WORKROOM_SSE_THROTTLE_MS ??= "20";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { waitFor } from "../src/runtime/testing.ts";
import type { ConversationState, PromoteResponse, SubmissionDTO, UserEntryDTO, WithdrawResponse } from "../../shared/chat.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(t: TestApp, email: string) {
	const a = await t.user(email);
	const c = (await t.json("POST", "/api/conversations", { token: a.token, json: {} })).conversation as { spaceId: string; conversationId: number };
	const base = `/api/conversations/${c.spaceId}/${c.conversationId}`;
	const send = (text: string, o: { mode?: string; rid?: string; attachments?: unknown[] } = {}): Promise<{ submissionId: number; status: string; submission: SubmissionDTO }> =>
		t.json("POST", `${base}/messages`, { token: a.token, json: { text, requestId: o.rid ?? randomUUID(), mode: o.mode ?? "followUp", ...(o.attachments ? { attachments: o.attachments } : {}) } });
	const state = (): Promise<ConversationState> => t.json("GET", `${base}/state`, { token: a.token });
	const users = (s: ConversationState) => s.entries.filter((e) => e.kind === "user" && (e as UserEntryDTO).placed !== false).map((e) => (e as UserEntryDTO).text);
	const unplaced = (s: ConversationState) => s.entries.filter((e) => e.kind === "user" && (e as UserEntryDTO).placed === false).map((e) => (e as UserEntryDTO).text);
	const promote = (id: number, o: { token?: string; expect?: number } = {}): Promise<PromoteResponse> => t.json("POST", `${base}/submissions/${id}/promote`, { token: o.token ?? a.token, json: {}, expect: o.expect });
	const withdraw = (id: number, o: { restore?: boolean; token?: string; expect?: number } = {}): Promise<WithdrawResponse> => t.json("POST", `${base}/submissions/${id}/withdraw`, { token: o.token ?? a.token, json: { restore: o.restore }, expect: o.expect });
	const idle = (s: ConversationState) => s.live.status !== "running" && s.live.status !== "waiting_approval";
	const settle = (what: string, pred: (s: ConversationState) => boolean, timeoutMs = 20_000) => waitFor(async () => { const s = await state(); return pred(s) ? s : undefined; }, { timeoutMs, what });
	return { a, c, base, send, state, users, unplaced, promote, withdraw, idle, settle };
}

const ATT = { fileId: "f1", versionId: "v1", name: "报价单.xlsx" };

test("queue: follow-ups sent while running are held durably, shown with requestId/attachments, and run in send order", async () => {
	const t = await startTestApp();
	try {
		const q = await setup(t, "r8q-order@example.com");
		await q.send("[[slow 1500]] 第一条");
		await sleep(150);
		const rids = [randomUUID(), randomUUID(), randomUUID()];
		const subs = [];
		subs.push(await q.send("第二条", { rid: rids[0] }));
		subs.push(await q.send("第三条 [[reply 好]]", { rid: rids[1], attachments: [ATT] }));
		subs.push(await q.send("第四条", { rid: rids[2] }));
		assert.deepEqual(subs.map((s) => s.status), ["queued", "queued", "queued"]);
		const s = await q.state();
		assert.equal(s.live.status, "running");
		assert.deepEqual(s.queue.map((i) => i.text), ["第二条", "第三条 [[reply 好]]", "第四条"], "queue keeps send order");
		assert.deepEqual(s.queue.map((i) => i.mode), ["followUp", "followUp", "followUp"]);
		assert.deepEqual(s.queue.map((i) => i.requestId), rids);
		assert.equal(s.queue[1]!.displayText, "第三条", "test directives are hidden in displayText");
		assert.deepEqual(s.queue[1]!.attachments, [ATT], "attachments travel with the queued item");
		assert.equal(s.queue[0]!.attachments, undefined);
		const done = await q.settle("all run", (x) => q.idle(x) && x.queue.length === 0 && q.users(x).length === 4);
		assert.deepEqual(q.users(done).map((x) => x.replace(/\[\[.*?\]\] ?/g, "").trim()), ["第一条", "第二条", "第三条", "第四条"], "ran in order");
		assert.equal(done.live.status, "done");
		assert.deepEqual((done.entries.find((e) => e.kind === "user" && (e as UserEntryDTO).text.startsWith("第三条")) as UserEntryDTO).attachments, [ATT]);
	} finally {
		await t.dispose();
	}
});

test("dedupe: the same requestId (double submit / offline retry) returns the same submission and queues one item", async () => {
	const t = await startTestApp();
	try {
		const q = await setup(t, "r8q-dedupe@example.com");
		await q.send("[[slow 1200]] 先跑着");
		await sleep(100);
		const rid = randomUUID();
		const [x, y, z] = await Promise.all([q.send("只排一次", { rid }), q.send("只排一次", { rid }), q.send("只排一次", { rid })]);
		assert.equal(x.submissionId, y.submissionId);
		assert.equal(y.submissionId, z.submissionId);
		const s = await q.state();
		assert.equal(s.queue.filter((i) => i.text === "只排一次").length, 1);
		const done = await q.settle("done", (x) => q.idle(x) && x.queue.length === 0);
		assert.equal(q.users(done).filter((x) => x === "只排一次").length, 1);
		// a retry after it was applied still returns that submission (no second run)
		const again = await q.send("只排一次", { rid });
		assert.equal(again.submissionId, x.submissionId);
		assert.equal(q.users(await q.state()).filter((x) => x === "只排一次").length, 1);
	} finally {
		await t.dispose();
	}
});

test("promote: queued follow-up becomes a steer, jumps ahead of the other follow-ups, keeps text + attachments; double click / retry is idempotent", async () => {
	const t = await startTestApp();
	try {
		const q = await setup(t, "r8q-promote@example.com");
		// the first run has a tool step: a steer is placed at the next model step (after the running tool), before follow-ups
		await q.send('[[call wr_fixture_wait {"ms":1800}]] 慢任务');
		await sleep(300);
		await q.send("排队甲");
		const b = await q.send("排队乙", { attachments: [ATT] });
		await q.send("排队丙");
		const [r1, r2, r3] = await Promise.all([q.promote(b.submissionId), q.promote(b.submissionId), q.promote(b.submissionId)]);
		assert.equal(r1.result, "promoted");
		assert.equal(r1.effect, "steered");
		assert.equal(r1.submission.status, "received", "a steer waits for the run's next step");
		assert.notEqual(r1.submission.submissionId, b.submissionId, "a new submission carries the steer");
		assert.equal(r1.submission.requestId, `${b.submission.requestId}::now`, "deterministic requestId");
		for (const r of [r2, r3]) {
			assert.equal(r.result, "promoted");
			assert.equal(r.replayed, true);
			assert.equal(r.submission.submissionId, r1.submission.submissionId, "same steer submission, not a second one");
		}
		// retry later (while still pending): same answer
		const r4 = await q.promote(b.submissionId);
		assert.equal(r4.submission.submissionId, r1.submission.submissionId);
		const s = await q.state();
		assert.deepEqual(s.queue.map((i) => `${i.mode}:${i.text}`).sort(), ["followUp:排队丙", "followUp:排队甲", "steer:排队乙"].sort());
		assert.deepEqual(s.queue.find((i) => i.mode === "steer")!.attachments, [ATT]);
		assert.equal(q.unplaced(s).length, 0, "no ghost 'unsent' marker for a promoted input");
		const done = await q.settle("all done", (x) => q.idle(x) && x.queue.length === 0 && q.users(x).length === 4);
		assert.deepEqual(q.users(done), ['[[call wr_fixture_wait {"ms":1800}]] 慢任务', "排队乙", "排队甲", "排队丙"], "the promoted message is handed over first; the rest keep their order");
		assert.equal(q.users(done).filter((x) => x === "排队乙").length, 1, "sent exactly once");
		assert.deepEqual((done.entries.find((e) => e.kind === "user" && (e as UserEntryDTO).text === "排队乙") as UserEntryDTO).attachments, [ATT]);
		// after it was applied, promote answers the truth from either id
		const late = await q.promote(b.submissionId);
		assert.equal(late.result, "promoted");
		assert.equal(late.replayed, true);
	} finally {
		await t.dispose();
	}
});

test("promote after the follow-up was applied → already_applied (nothing changes); unknown id 404; steer item → promoted/replayed", async () => {
	const t = await startTestApp();
	try {
		const q = await setup(t, "r8q-late@example.com");
		await q.send("[[slow 500]] 一");
		await sleep(100);
		const b = await q.send("二");
		await q.settle("done", (x) => q.idle(x) && q.users(x).length === 2);
		const r = await q.promote(b.submissionId);
		assert.equal(r.result, "already_applied");
		assert.ok(["applied", "done"].includes(r.submission.status));
		const s = await q.state();
		assert.equal(q.users(s).filter((x) => x === "二").length, 1, "no duplicate message");
		assert.equal(s.queue.length, 0);
		await q.promote(987654, { expect: 404 });
		// a steer item is already as immediate as it gets
		await q.send("[[slow 1200]] 三");
		await sleep(100);
		const st = await q.send("四", { mode: "steer" });
		assert.equal(st.status, "received");
		const rs = await q.promote(st.submissionId);
		assert.equal(rs.result, "promoted");
		assert.equal(rs.submission.submissionId, st.submissionId);
	} finally {
		await t.dispose();
	}
});

test("withdraw (撤销): restore returns text + attachments and leaves no ghost; races with apply resolve to one truth", async () => {
	const t = await startTestApp();
	try {
		const q = await setup(t, "r8q-withdraw@example.com");
		await q.send("[[slow 2000]] 慢");
		await sleep(150);
		const a = await q.send("想改一下", { attachments: [ATT] });
		const w = await q.withdraw(a.submissionId, { restore: true });
		assert.equal(w.result, "aborted");
		assert.equal(w.submission.status, "withdrawn");
		assert.deepEqual(w.input, { text: "想改一下", attachments: [ATT] });
		let s = await q.state();
		assert.equal(s.queue.length, 0);
		assert.equal(q.unplaced(s).length, 0, "restored to the composer → no 'unsent' marker in the transcript");
		// a second withdraw (other tab / double click): honest, restores nothing
		const w2 = await q.withdraw(a.submissionId, { restore: true });
		assert.notEqual(w2.result, "aborted");
		assert.equal(w2.input, undefined);
		// without restore the old behaviour holds: a marker records the unsent message
		const b = await q.send("普通撤回");
		const wb = await q.withdraw(b.submissionId);
		assert.equal(wb.result, "aborted");
		assert.equal(wb.input, undefined);
		s = await q.state();
		assert.deepEqual(q.unplaced(s), ["普通撤回"]);
		await q.settle("done", (x) => q.idle(x));
		// withdraw after it was applied → already_placed / settled, nothing restored, message stays in the conversation
		const c1 = await q.send("[[slow 400]] 甲");
		await sleep(50);
		const c2 = await q.send("乙");
		await q.settle("c2 applied", (x) => q.users(x).includes("乙"));
		const late = await q.withdraw(c2.submissionId, { restore: true });
		assert.ok(late.result === "already_placed" || late.result === "settled", `late withdraw → ${late.result}`);
		assert.equal(late.input, undefined);
		assert.equal(q.users(await q.state()).filter((x) => x === "乙").length, 1);
		void c1;
		// parallel withdraw + promote of the same item: exactly one outcome, never both sent and restored
		await q.settle("idle", (x) => q.idle(x));
		await q.send("[[slow 1500]] 丙");
		await sleep(100);
		const d = await q.send("丁");
		const [wr, pr] = await Promise.all([q.withdraw(d.submissionId, { restore: true }), q.promote(d.submissionId)]);
		const sentTo = q.users(await q.settle("丙 done", (x) => q.idle(x) && x.queue.length === 0)).filter((x) => x === "丁").length;
		if (wr.result === "aborted") {
			assert.equal(sentTo, 0, "restored to the composer → it must not also be sent");
			assert.equal(pr.result, "not_found");
		} else {
			assert.equal(pr.result, "promoted");
			assert.equal(sentTo, 1);
			assert.equal(wr.input, undefined);
		}
	} finally {
		await t.dispose();
	}
});

test("failed run: queued follow-ups are kept (not dropped, not auto-run) until the user retries, sends again, or deletes them", async () => {
	const t = await startTestApp();
	try {
		const q = await setup(t, "r8q-failed@example.com");
		await q.send("[[slow 300]] [[fail]] 会失败");
		await sleep(100);
		const m = await q.send("失败后的第一条");
		const n = await q.send("失败后的第二条", { attachments: [ATT] });
		const s = await q.settle("failed", (x) => x.live.status === "failed");
		await sleep(600);
		const s2 = await q.state();
		assert.equal(s2.live.status, "failed");
		assert.deepEqual(s2.queue.map((i) => i.text), ["失败后的第一条", "失败后的第二条"], "queue survives the failure and is not auto-run");
		assert.equal(q.users(s2).length, 1);
		assert.deepEqual(s.queue.map((i) => i.attachments).filter(Boolean), [[ATT]]);
		// 删除 one of them (withdraw): its text comes back, nothing else changes
		const w = await q.withdraw(m.submissionId, { restore: true });
		assert.equal(w.result, "aborted");
		// 立即发送 with nothing running: it is simply sent now (effect "started") and the other queued item follows
		const p = await q.promote(n.submissionId);
		assert.equal(p.result, "promoted");
		assert.equal(p.effect, "started");
		const done = await q.settle("restarted", (x) => q.idle(x) && x.queue.length === 0 && q.users(x).length === 2);
		assert.deepEqual(q.users(done), ["[[slow 300]] [[fail]] 会失败", "失败后的第二条"]);
		// 重试 (continue) after a failure runs what is still queued
		const q2 = await setup(t, "r8q-failed2@example.com");
		await q2.send("[[slow 200]] [[fail]] 失败二");
		await sleep(100);
		await q2.send("排着的一条");
		await q2.settle("failed", (x) => x.live.status === "failed");
		await t.json("POST", `${q2.base}/continue`, { token: q2.a.token, json: {} });
		const d2 = await q2.settle("continued", (x) => q2.idle(x) && x.queue.length === 0 && q2.users(x).includes("排着的一条"));
		assert.equal(d2.live.status, "done");
	} finally {
		await t.dispose();
	}
});

test("aborted run (停止): pi-durable withdraws every queued input; each stays visible as an unsent message and the run can continue", async () => {
	const t = await startTestApp();
	try {
		const q = await setup(t, "r8q-abort@example.com");
		await q.send("[[slow 5000]] 长任务");
		await sleep(150);
		await q.send("排队一");
		await q.send("排队二", { attachments: [ATT] });
		await t.json("POST", `${q.base}/abort`, { token: q.a.token, json: {} });
		const s = await q.settle("aborted", (x) => x.live.status === "aborted");
		assert.equal(s.queue.length, 0, "nothing stays queued behind a cancelled run");
		assert.deepEqual(q.unplaced(s), ["排队一", "排队二"], "dropped inputs are shown as unsent, in order");
		const un = s.entries.filter((e) => e.kind === "user" && (e as UserEntryDTO).placed === false) as UserEntryDTO[];
		assert.deepEqual(un[1]!.attachments, [ATT], "attachments are kept on the unsent marker");
		assert.ok(un.every((e) => e.submission && (e.submission.status === "withdrawn" || e.submission.status === "unanswered")));
	} finally {
		await t.dispose();
	}
});

test("approval pending: queued follow-up and promoted steer both wait; the approval is never bypassed; after the decision the steer goes first", async () => {
	const t = await startTestApp();
	try {
		const q = await setup(t, "r8q-approval@example.com");
		await q.send('[[call wr_fixture_approval {"title":"发布","summary":"确认发布"}]] 需要确认');
		const waiting = await q.settle("waiting", (x) => x.live.status === "waiting_approval" && x.approvals.length === 1);
		const a1 = await q.send("甲");
		const a2 = await q.send("乙");
		const p = await q.promote(a2.submissionId);
		assert.equal(p.result, "promoted");
		assert.equal(p.effect, "steered");
		assert.equal(p.submission.status, "received");
		await sleep(700);
		const s = await q.state();
		assert.equal(s.live.status, "waiting_approval", "still waiting: the steer did not skip the approval");
		assert.equal(s.approvals.filter((x) => x.status === "pending").length, 1);
		assert.equal(q.users(s).length, 1, "neither message reached the model yet");
		assert.ok(!s.entries.some((e) => e.kind === "tool_result"), "the tool has not run");
		assert.deepEqual(s.queue.map((i) => `${i.mode}:${i.text}`).sort(), ["followUp:甲", "steer:乙"]);
		// withdraw works while waiting
		const w = await q.withdraw(a1.submissionId, { restore: true });
		assert.equal(w.result, "aborted");
		await t.json("POST", `${q.base}/approvals/${waiting.approvals[0]!.approvalId}`, { token: q.a.token, json: { decision: "approved" } });
		const done = await q.settle("done", (x) => q.idle(x) && x.queue.length === 0 && q.users(x).includes("乙"));
		const order = done.entries.map((e) => (e.kind === "tool_result" ? "tool" : e.kind === "user" ? (e as UserEntryDTO).text.slice(0, 4) : ""));
		assert.ok(order.indexOf("tool") !== -1 && order.indexOf("tool") < order.indexOf("乙"), "the approved tool result comes before the steered message");
		assert.ok(!q.users(done).includes("甲"), "the withdrawn follow-up never ran");
	} finally {
		await t.dispose();
	}
});

test("restart: the queue survives a server restart (state comes from pi-durable, not from the browser)", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "wr-r8q-"));
	let t = await startTestApp({ dataDir });
	try {
		const q = await setup(t, "r8q-restart@example.com");
		await q.send("[[slow 200]] [[fail]] 失败");
		await sleep(100);
		const a = await q.send("重启前排队的", { attachments: [ATT] });
		await q.settle("failed", (x) => x.live.status === "failed");
		const token = q.a.token;
		const base = q.base;
		await t.stop();
		t = await startTestApp({ dataDir });
		const s = (await t.json("GET", `${base}/state`, { token })) as ConversationState;
		assert.equal(s.live.status, "failed");
		assert.deepEqual(s.queue.map((i) => [i.submissionId, i.text, i.attachments]), [[a.submissionId, "重启前排队的", [ATT]]]);
		const w = await t.json("POST", `${base}/submissions/${a.submissionId}/promote`, { token, json: {} });
		assert.equal(w.result, "promoted");
		await waitFor(async () => {
			const x = (await t.json("GET", `${base}/state`, { token })) as ConversationState;
			return x.live.status === "done" && x.queue.length === 0 ? x : undefined;
		}, { what: "ran after restart" });
	} finally {
		await t.dispose();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("access: another user gets 403/404 on state, withdraw and promote; a stranger's id cannot be promoted through my conversation", async () => {
	const t = await startTestApp();
	try {
		const q = await setup(t, "r8q-own@example.com");
		const other = await t.user("r8q-other@example.com");
		await q.send("[[slow 1500]] 占着");
		await sleep(100);
		const a = await q.send("我的排队消息");
		const mine = await setup(t, "r8q-own2@example.com");
		for (const [path, body] of [[`${q.base}/submissions/${a.submissionId}/promote`, {}], [`${q.base}/submissions/${a.submissionId}/withdraw`, { restore: true }]] as const) {
			const res = await t.req("POST", path, { token: other.token, json: body });
			assert.ok(res.status === 403 || res.status === 404, `${path} → ${res.status}`);
		}
		const res = await t.req("GET", `${q.base}/state`, { token: other.token });
		assert.ok(res.status === 403 || res.status === 404);
		// my own conversation cannot touch a submission of someone else's conversation
		const x = await t.req("POST", `${mine.base}/submissions/${a.submissionId}/promote`, { token: mine.a.token, json: {} });
		assert.equal(x.status, 404);
		const y = await t.req("POST", `${mine.base}/submissions/${a.submissionId}/withdraw`, { token: mine.a.token, json: {} });
		assert.equal(y.status, 404);
		// and nothing happened to the owner's queue
		assert.equal((await q.state()).queue.length, 1);
		// unauthenticated
		assert.equal((await t.req("POST", `${q.base}/submissions/${a.submissionId}/promote`, { json: {} })).status, 401);
	} finally {
		await t.dispose();
	}
});
