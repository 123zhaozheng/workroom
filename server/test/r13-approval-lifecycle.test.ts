// Round 13 (review items 4 and 6): approval waits vs. the kernel restart limit, and approval/delegation cleanup on stop.
process.env.WORKROOM_FIXTURE_TOOLS = "1";
process.env.WORKROOM_RT_RETRY_BASE_MS ??= "50";
process.env.WORKROOM_RT_RETRY_MAX ??= "3";
process.env.WORKROOM_SSE_THROTTLE_MS ??= "20";

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { isSettled, waitFor } from "../src/runtime/testing.ts";
import { runtimeState } from "../src/runtime/module.ts";
import { ApprovalsDoc } from "../src/runtime/docs.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationState, SubmissionDTO } from "../../shared/chat.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const rid = () => randomUUID();
type Conv = { spaceId: string; conversationId: number };
const base = (c: Conv) => `/api/conversations/${c.spaceId}/${c.conversationId}`;

async function freePort(): Promise<number> {
	return new Promise((res, rej) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const p = (s.address() as any).port;
			s.close(() => res(p));
		});
		s.on("error", rej);
	});
}

/** The real server as a child process on a data dir, so it can be SIGKILLed (app.stop() is a graceful shutdown and proves nothing here). */
class ServerProc {
	child?: ChildProcess;
	readonly port: number;
	readonly dataDir: string;
	readonly log: string;
	constructor(port: number, dataDir: string) {
		this.port = port;
		this.dataDir = dataDir;
		this.log = join(dataDir, "server.log");
	}
	async start(): Promise<void> {
		const out = openSync(this.log, "a");
		this.child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/src/main.ts"], {
			cwd: ROOT,
			env: { ...process.env, WORKROOM_DATA_DIR: this.dataDir, PORT: String(this.port), HOST: "127.0.0.1", WORKROOM_INSTANCE_ID: "r13-node-1", WORKROOM_FIXTURE_TOOLS: "1", WORKROOM_RT_RETRY_BASE_MS: "50", WORKROOM_WEB_DIST: join(this.dataDir, "no-web") },
			stdio: ["ignore", out, out],
		});
		await waitFor(async () => (await fetch(`http://127.0.0.1:${this.port}/api/health`).catch(() => undefined))?.ok, { timeoutMs: 20_000, what: "server up" });
	}
	async kill(): Promise<void> {
		const c = this.child!;
		const exited = new Promise((r) => c.once("exit", r));
		c.kill("SIGKILL");
		await exited;
	}
	async req(method: string, path: string, token?: string, json?: unknown, expect = 200): Promise<any> {
		const res = await fetch(`http://127.0.0.1:${this.port}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json !== undefined ? { "content-type": "application/json" } : {}) }, body: json === undefined ? undefined : JSON.stringify(json) });
		const text = await res.text();
		if (res.status !== expect) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
		return text ? JSON.parse(text) : undefined;
	}
}

test("item 4: repeated SIGKILL while an approval is pending never ends the tool with restart_limit; the approval still works", { timeout: 240_000 }, async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "wr-r13-kill-"));
	const srv = new ServerProc(await freePort(), dataDir);
	await srv.start();
	try {
		const { token } = await srv.req("POST", "/api/auth/register", undefined, { email: "r13kill@example.com", name: "r13", password: "password123" });
		const { conversation: c } = await srv.req("POST", "/api/conversations", token, { title: "审批硬杀" });
		const state = () => srv.req("GET", `${base(c)}/state?limit=100`, token) as Promise<ConversationState>;
		const send = await srv.req("POST", `${base(c)}/messages`, token, { text: `[[call wr_fixture_approval {"title":"删除数据","summary":"硬杀测试"}]]`, requestId: rid() });
		await waitFor(async () => (await state()).approvals.some((a) => a.status === "pending"), { what: "approval pending" });
		for (let i = 0; i < 7; i++) {
			await srv.kill();
			await srv.start();
			await waitFor(async () => (await state()).approvals.some((a) => a.status === "pending"), { what: `approval pending after kill ${i + 1}` });
		}
		const st = await state();
		const results = st.entries.filter((e) => e.kind === "tool_result") as any[];
		assert.ok(!results.some((r) => /restart_limit|interrupted \d+ times|it is not run again/.test(r.text ?? "")), `tool must not be ended by the restart limit: ${JSON.stringify(results.map((r) => r.text))}`);
		const pending = st.approvals.find((a) => a.status === "pending")!;
		assert.ok(pending, "approval is still pending after every crash");
		assert.equal(pending.deferred, true, "the wait was handed to the durable watcher before the kernel limit");
		// the approval still works after all the crashes: the decision is posted back to the conversation as a follow-up input
		await srv.req("POST", `${base(c)}/approvals/${pending.approvalId}`, token, { decision: "approved" });
		await waitFor(async () => (await state()).entries.some((e: any) => e.kind === "user" && /\[审批结果\].*已批准/.test(e.text ?? "")), { timeoutMs: 30_000, what: "approval result follow-up" });
		await waitFor(async () => !(await state()).live.busy, { timeoutMs: 30_000, what: "run after the follow-up finished" });
		// the re-issued call consumes the recorded decision (no second approval) and completes
		const again = await srv.req("POST", `${base(c)}/messages`, token, { text: `[[call wr_fixture_approval {"title":"删除数据","summary":"硬杀测试"}]]`, requestId: rid() });
		void again;
		await waitFor(async () => (await state()).entries.some((e: any) => e.kind === "tool_result" && /decision: approved/.test(e.text ?? "")), { timeoutMs: 30_000, what: "re-issued call completes with the recorded decision" });
		const end = await state();
		assert.equal(end.approvals.filter((a) => a.status === "pending").length, 0, "no second approval was asked");
		void send;
	} catch (err) {
		console.error(readFileSync(srv.log, "utf8").slice(-3000));
		throw err;
	} finally {
		if (srv.child && srv.child.exitCode === null) await srv.kill();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

// ------------------------------------------------------------------ item 6: stop closes children, delegations and approvals

const settle = (t: TestApp, token: string, c: Conv, id: number) =>
	waitFor(async () => {
		const s = (await t.json("GET", `${base(c)}/submissions/${id}`, { token })) as SubmissionDTO;
		return isSettled(s) ? s : undefined;
	}, { timeoutMs: 20_000, what: `submission ${id}` });
const send = (t: TestApp, token: string, c: Conv, text: string) => t.json("POST", `${base(c)}/messages`, { token, json: { text, requestId: rid() } });
const stateOf = (t: TestApp, token: string, c: Conv): Promise<ConversationState> => t.json("GET", `${base(c)}/state?limit=100`, { token });
const delegateCall = (member: string, task: string, mode?: string) => `[[call delegate ${JSON.stringify({ member, task, ...(mode ? { mode } : {}) })}]]`;
const ASK = `[[call wr_fixture_approval {"title":"子任务外发","summary":"子 Agent 请求审批"}]]`;

async function setupTeam(t: TestApp, email: string) {
	const a = await t.user(email);
	const { assistant } = await t.json("POST", "/api/assistants", { token: a.token, json: { name: "审批小队", members: [{ id: "asker", name: "提问员", type: "builtin_subagent", tools: ["wr_fixture_approval"], maxTurns: 4 }] } });
	const { conversation: c } = await t.json("POST", "/api/conversations", { token: a.token, json: { assistantId: assistant.id } });
	return { a, c: c as Conv };
}

test("item 6: stopping the parent of a foreground delegate closes the delegation and the child's pending approval", { timeout: 60_000 }, async () => {
	const t = await startTestApp();
	try {
		const { a, c } = await setupTeam(t, "r13-fg@example.com");
		await send(t, a.token, c, delegateCall("asker", ASK));
		const waiting = await waitFor(async () => {
			const s = await stateOf(t, a.token, c);
			return s.approvals.some((x) => x.status === "pending") ? s : undefined;
		}, { what: "child approval pending" });
		const ap = waiting.approvals.find((x) => x.status === "pending")!;
		assert.notEqual(ap.conversationId, c.conversationId, "the approval belongs to the child conversation");
		assert.equal(typeof ap.taskId, "number", "the approval is bound to the task that waits for it");
		assert.equal(waiting.subagents[0]!.status, "running");

		const stop = await t.json("POST", `${base(c)}/abort`, { token: a.token, json: {} });
		assert.equal(stop.cancelledApprovals, 1, "the child's approval is counted");
		const st = await stateOf(t, a.token, c);
		assert.equal(st.subagents[0]!.status, "aborted", "the delegation is no longer running");
		// the child's approval record is cancelled (not shown as pending anywhere)
		const harness = await runtimeState(t.app.ctx).manager.get(c.spaceId);
		const childDoc = await harness.snapshot(ApprovalsDoc, ap.conversationId as ConversationId, BACKGROUND_CONTEXT);
		assert.equal(childDoc!.items[ap.approvalId]!.status, "cancelled");
		assert.ok(!st.approvals.some((x) => x.status === "pending"));
		// deciding it is refused with a clear message
		const refused = await t.json("POST", `${base(c)}/approvals/${ap.approvalId}`, { token: a.token, json: { decision: "approved" }, expect: 409 });
		assert.match(JSON.stringify(refused), /已取消|已结束/);
	} finally {
		await t.dispose();
	}
});

test("item 6: normal stop keeps a background delegation and its approval; stop-all closes them", { timeout: 60_000 }, async () => {
	const t = await startTestApp();
	try {
		const { a, c } = await setupTeam(t, "r13-bg@example.com");
		await settle(t, a.token, c, (await send(t, a.token, c, delegateCall("asker", ASK, "background"))).submissionId);
		const waiting = await waitFor(async () => {
			const s = await stateOf(t, a.token, c);
			return s.approvals.some((x) => x.status === "pending") ? s : undefined;
		}, { what: "background child approval pending" });
		const ap = waiting.approvals.find((x) => x.status === "pending")!;

		// normal stop: background work is a boundary, nothing of it is cancelled
		const normal = await t.json("POST", `${base(c)}/abort`, { token: a.token, json: {} });
		assert.equal(normal.cancelledApprovals, 0);
		let st = await stateOf(t, a.token, c);
		assert.equal(st.subagents[0]!.status, "running");
		assert.equal(st.approvals.find((x) => x.approvalId === ap.approvalId)!.status, "pending");

		// stop all: the background child is cancelled together with its approval
		const all = await t.json("POST", `${base(c)}/abort`, { token: a.token, json: { background: true } });
		assert.equal(all.cancelledApprovals, 1);
		st = await waitFor(async () => {
			const s = await stateOf(t, a.token, c);
			return s.subagents[0]!.status !== "running" ? s : undefined;
		}, { what: "delegation closed by stop-all" });
		assert.equal(st.subagents[0]!.status, "aborted");
		const harness = await runtimeState(t.app.ctx).manager.get(c.spaceId);
		assert.equal((await harness.snapshot(ApprovalsDoc, ap.conversationId as ConversationId, BACKGROUND_CONTEXT))!.items[ap.approvalId]!.status, "cancelled");
		await t.json("POST", `${base(c)}/approvals/${ap.approvalId}`, { token: a.token, json: { decision: "approved" }, expect: 409 });
	} finally {
		await t.dispose();
	}
});

test("item 6: recovery reconcile closes a pending approval whose task is already terminal; deciding it is refused", { timeout: 60_000 }, async () => {
	const t = await startTestApp();
	try {
		const { a, c } = await setupTeam(t, "r13-rec@example.com");
		// a finished call: its task is terminal
		const r = await send(t, a.token, c, `[[call wr_fixture_echo {"text":"x"}]]`);
		await settle(t, a.token, c, r.submissionId);
		const harness = await runtimeState(t.app.ctx).manager.get(c.spaceId);
		const live = await harness.snapshot((await import("@earendil-works/pi-durable")).LiveDoc, c.conversationId as ConversationId, BACKGROUND_CONTEXT);
		void live;
		const tasks = await harness.commit((tx) => tx.scanTasks({ status: "terminal" }, 50), BACKGROUND_CONTEXT);
		const done = tasks.items.find((x) => x.kind === "pi.tool" && (x.conversationId as number) === c.conversationId)!;
		assert.ok(done, "a terminal tool task exists");
		// the crash window: the approval is still pending although its call already ended
		await harness.commit(async (tx) => {
			const d = await tx.doc(ApprovalsDoc, c.conversationId as ConversationId);
			d.items["ap_stale"] = { approvalId: "ap_stale", conversationId: c.conversationId, callId: "gone", taskId: done.id as number, title: "过期审批", summary: "s", risk: "low", status: "pending", requestedAt: new Date().toISOString() } as any;
		}, BACKGROUND_CONTEXT);
		const refused = await t.json("POST", `${base(c)}/approvals/ap_stale`, { token: a.token, json: { decision: "approved" }, expect: 409 });
		assert.match(JSON.stringify(refused), /已结束|已取消/);
		const st = await stateOf(t, a.token, c);
		assert.equal(st.approvals.find((x) => x.approvalId === "ap_stale")!.status, "cancelled");
	} finally {
		await t.dispose();
	}
});
