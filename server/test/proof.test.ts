// X-PROOF: pi-durable vertical proof on the real app with real SQLite files.
//   node --disable-warning=ExperimentalWarning --test server/test/proof.test.ts
// 1) in-process: start → send → SSE state → fork from a middle entry → original/branch independent → client disconnects
//    mid-run and the run completes → app stopped mid-run and restarted on the same data dir → run finishes → same
//    requestId returns the same submission without a duplicate entry.
// 2) hard kill: the server runs as a child process; SIGKILL mid-run / mid-effect; restart with the same data dir.
//    A run resumes and finishes; an external effect killed while `dispatching` ends `needs_reconciliation` and its
//    perform() is NOT called again (counter file); an effect whose receipt was stored replays (replayed: true).
// 3) X-ISO: another user gets 403 everywhere (SSE included); removing a project member blocks their next tool call
//    and closes their stream.
process.env.WORKROOM_FIXTURE_TOOLS = "1";
process.env.WORKROOM_RT_RETRY_BASE_MS ??= "50";
process.env.WORKROOM_RT_RETRY_MAX ??= "3";
process.env.WORKROOM_SSE_THROTTLE_MS ??= "20";
process.env.WORKROOM_SSE_ACL_RECHECK_MS ??= "200";

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { isSettled, sseReader, waitFor } from "../src/runtime/testing.ts";
import { effectCounterPath } from "../src/runtime/fixture-tools.ts";
import type { ConversationState, EntryDTO, SubmissionDTO } from "../../shared/chat.ts";

const rid = () => randomUUID();
type Conv = { spaceId: string; conversationId: number };
const base = (c: Conv) => `/api/conversations/${c.spaceId}/${c.conversationId}`;
const texts = (es: readonly EntryDTO[]) => es.filter((e) => e.kind === "user" || e.kind === "assistant").map((e) => `${e.kind}:${(e as any).text}`);

async function settle(t: TestApp, token: string, c: Conv, id: number, timeoutMs = 20_000): Promise<SubmissionDTO> {
	return waitFor(async () => {
		const s = (await t.json("GET", `${base(c)}/submissions/${id}`, { token })) as SubmissionDTO;
		return isSettled(s) ? s : undefined;
	}, { timeoutMs, what: `submission ${id}` });
}
const entriesOf = async (t: TestApp, token: string, c: Conv): Promise<EntryDTO[]> => (await t.json("GET", `${base(c)}/entries?limit=200`, { token })).items;

test("X-PROOF in-process: send → SSE → fork → independent branches → disconnect → stop/restart resumes → requestId dedupe", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "wr-proof-"));
	let t = await startTestApp({ dataDir });
	try {
		const a = await t.user("proof-a@example.com");
		const { conversation: c } = await t.json("POST", "/api/conversations", { token: a.token, json: { title: "纵向证明" } });

		// send + SSE state
		const sse = sseReader(await t.req("GET", `${base(c)}/events`, { token: a.token }));
		assert.equal((await sse.next((e) => e.event === "snapshot")).data.live.status, "idle");
		const s1 = await t.json("POST", `${base(c)}/messages`, { token: a.token, json: { text: "第一问 [[reply 第一答]]", requestId: rid() } });
		const st = await sse.state((s) => s.entries.some((e) => e.kind === "assistant" && (e as any).text.includes("第一答")));
		assert.equal(st.conversation.conversationId, c.conversationId);
		assert.equal((await settle(t, a.token, c, s1.submissionId)).status, "done");
		await settle(t, a.token, c, (await t.json("POST", `${base(c)}/messages`, { token: a.token, json: { text: "第二问 [[reply 第二答]]", requestId: rid() } })).submissionId);
		await sse.close();

		// fork from a middle entry (the first answer); both continue independently
		const before = await entriesOf(t, a.token, c);
		const mid = before.find((e) => e.kind === "assistant")!;
		const { conversation: br } = await t.json("POST", `${base(c)}/fork`, { token: a.token, json: { entryId: mid.id } });
		assert.deepEqual(br.parent, { conversationId: c.conversationId, entryId: mid.id });
		const [sb, so] = await Promise.all([
			t.json("POST", `${base(br)}/messages`, { token: a.token, json: { text: "分支继续 [[reply 分支答]]", requestId: rid() } }),
			t.json("POST", `${base(c)}/messages`, { token: a.token, json: { text: "原会话继续 [[reply 原答]]", requestId: rid() } }),
		]);
		await settle(t, a.token, br, sb.submissionId);
		await settle(t, a.token, c, so.submissionId);
		const orig = texts(await entriesOf(t, a.token, c));
		const branch = texts(await entriesOf(t, a.token, br));
		assert.deepEqual(orig.slice(0, 4), texts(before), "original prefix unchanged");
		assert.ok(orig.at(-1)!.includes("原答") && !orig.some((x) => x.includes("分支")));
		assert.deepEqual(branch, [...texts(before).slice(0, 2), "user:分支继续 [[reply 分支答]]", "assistant:【测试模型·非真实AI】 分支答"]);

		// client disconnects mid-run; the run completes server-side
		const sse2 = sseReader(await t.req("GET", `${base(c)}/events`, { token: a.token }));
		await sse2.next((e) => e.event === "snapshot");
		const s3 = await t.json("POST", `${base(c)}/messages`, { token: a.token, json: { text: "[[slow 800]] 关浏览器 [[reply 后台完成]]", requestId: rid() } });
		await sse2.state((s) => s.live.busy);
		await sse2.close();
		assert.equal((await settle(t, a.token, c, s3.submissionId)).status, "done");

		// stop the app mid-run, restart on the same data dir: the run resumes and finishes from the same storage
		const requestId = rid();
		const s4 = await t.json("POST", `${base(c)}/messages`, { token: a.token, json: { text: "[[slow 1500]] 重启 [[reply 重启后完成]]", requestId } });
		await waitFor(async () => (await t.json("GET", `${base(c)}/submissions/${s4.submissionId}`, { token: a.token })).status === "applied");
		await t.stop();
		t = await startTestApp({ dataDir });
		// start() resumed the space by itself (rt_space_runtime wake state), before any client request touched it
		const { runtimeState } = await import("../src/runtime/module.ts");
		assert.ok(runtimeState(t.app.ctx).manager.isOpen(c.spaceId), "space with pending work reopened at start");
		const done = await settle(t, a.token, c, s4.submissionId);
		assert.equal(done.status, "done");
		const after = texts(await entriesOf(t, a.token, c));
		assert.equal(after.filter((x) => x.includes("重启后完成")).length, 2, "one user + one assistant entry"); // user text contains it too
		assert.equal(after.filter((x) => x.startsWith("assistant:") && x.includes("重启后完成")).length, 1);

		// same requestId after restart: same submission, no duplicate entry
		const again = await t.json("POST", `${base(c)}/messages`, { token: a.token, json: { text: "[[slow 1500]] 重启 [[reply 重启后完成]]", requestId } });
		assert.equal(again.submissionId, s4.submissionId);
		assert.equal(again.status, "done");
		assert.deepEqual(texts(await entriesOf(t, a.token, c)), after);
	} finally {
		await t.dispose();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

// ------------------------------------------------------------------ hard kill (child process)

const ROOT = resolve(import.meta.dirname, "../..");

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
			env: { ...process.env, WORKROOM_DATA_DIR: this.dataDir, PORT: String(this.port), HOST: "127.0.0.1", WORKROOM_INSTANCE_ID: "proof-node-1", WORKROOM_FIXTURE_TOOLS: "1", WORKROOM_RT_RETRY_BASE_MS: "50", WORKROOM_WEB_DIST: join(this.dataDir, "no-web") },
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

const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).length : 0);

test("X-PROOF hard kill: SIGKILL mid-run and mid-effect, restart on the same data dir", { timeout: 120_000 }, async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "wr-proof-kill-"));
	const srv = new ServerProc(await freePort(), dataDir);
	await srv.start();
	try {
		const { token } = await srv.req("POST", "/api/auth/register", undefined, { email: "kill@example.com", name: "kill", password: "password123" });
		const { conversation: c } = await srv.req("POST", "/api/conversations", token, { title: "硬杀" });
		const sub = (id: number) => srv.req("GET", `${base(c)}/submissions/${id}`, token) as Promise<SubmissionDTO>;
		const settled = (id: number) => waitFor(async () => { const s = await sub(id); return isSettled(s) ? s : undefined; }, { timeoutMs: 30_000, what: `submission ${id}` });
		const state = () => srv.req("GET", `${base(c)}/state?limit=100`, token) as Promise<ConversationState>;

		// (a) SIGKILL while the model is answering → restart → the run resumes and finishes; requestId dedupes
		const requestId = rid();
		const a1 = await srv.req("POST", `${base(c)}/messages`, token, { text: "[[slow 4000]] 硬杀 [[reply 硬重启后完成]]", requestId });
		await waitFor(async () => (await sub(a1.submissionId)).status === "applied", { what: "applied" });
		await srv.kill();
		await srv.start();
		// the restarted process resumes the pending space on its own (no client request needed)
		await waitFor(() => /resumed 1 space\(s\) with pending work/.test(readFileSync(srv.log, "utf8")), { what: "resume log" });
		assert.equal((await settled(a1.submissionId)).status, "done");
		const again = await srv.req("POST", `${base(c)}/messages`, token, { text: "[[slow 4000]] 硬杀 [[reply 硬重启后完成]]", requestId });
		assert.equal(again.submissionId, a1.submissionId);
		const st1 = await state();
		assert.equal(st1.entries.filter((e) => e.kind === "user").length, 1);
		assert.equal(st1.entries.filter((e) => e.kind === "assistant" && (e as any).text.includes("硬重启后完成")).length, 1);

		// (b) SIGKILL while an external effect is dispatching → needs_reconciliation, perform NOT called again
		const kd = effectCounterPath(dataDir, "k-dispatch");
		const b1 = await srv.req("POST", `${base(c)}/messages`, token, { text: `[[call wr_fixture_effect {"key":"k-dispatch","holdMs":8000}]]`, requestId: rid() });
		await waitFor(() => lines(kd) === 1, { what: "perform started" });
		const dispatching = await state();
		assert.equal(dispatching.effects.find((e) => e.key === "k-dispatch")?.status, "dispatching");
		await srv.kill();
		await srv.start();
		assert.equal((await settled(b1.submissionId)).status, "done");
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(lines(kd), 1, "perform() was not called again after the crash");
		const st2 = await state();
		const eff = st2.effects.find((e) => e.key === "k-dispatch")!;
		assert.equal(eff.status, "needs_reconciliation");
		const tr = st2.entries.find((e) => e.kind === "tool_result" && (e as any).text.includes("needs_reconciliation")) as any;
		assert.ok(tr, "tool result reports needs_reconciliation");
		assert.equal(tr.isError, true);
		// a human reconciles it (verified at the target): the record is closed, still without re-performing
		const rec = await srv.req("POST", `${base(c)}/effects/${eff.effectId}/reconcile`, token, { outcome: "failed", note: "核对：对方未收到" });
		assert.equal(rec.effect.status, "failed");
		assert.equal(lines(kd), 1);

		// (c) SIGKILL after the receipt was stored → the replay-safe tool reruns and gets replayed: true
		const kr = effectCounterPath(dataDir, "k-receipt");
		const c1 = await srv.req("POST", `${base(c)}/messages`, token, { text: `[[call wr_fixture_effect {"key":"k-receipt","holdAfterMs":8000}]]`, requestId: rid() });
		await waitFor(async () => lines(kr) === 1 && (await state()).effects.find((e) => e.key === "k-receipt")?.status === "done", { what: "receipt stored" });
		await srv.kill();
		await srv.start();
		assert.equal((await settled(c1.submissionId)).status, "done");
		assert.equal(lines(kr), 1, "perform() ran exactly once");
		const st3 = await state();
		const tr3 = st3.entries.filter((e) => e.kind === "tool_result").at(-1) as any;
		assert.match(tr3.text, /"replayed":true/);
		assert.equal(tr3.isError, false);

		// M02-A: a fresh login (new session, e.g. another browser) sees the task states and final results
		const relog = await srv.req("POST", "/api/auth/login", undefined, { email: "kill@example.com", password: "password123" });
		assert.notEqual(relog.token, token);
		const list = await srv.req("GET", "/api/conversations", relog.token);
		assert.ok(list.conversations.some((x: any) => x.conversationId === c.conversationId));
		const fresh = (await srv.req("GET", `${base(c)}/state?limit=100`, relog.token)) as ConversationState;
		assert.equal(fresh.live.status, "done");
		assert.ok(fresh.entries.some((e) => e.kind === "assistant" && (e as any).text.includes("硬重启后完成")));
		assert.deepEqual(fresh.effects.map((e) => [e.key, e.status]).sort(), [["k-dispatch", "failed"], ["k-receipt", "done"]]);
		const users = fresh.entries.filter((e) => e.kind === "user") as any[];
		assert.ok(users.every((u) => u.submission?.status === "done"), "each message shows its outcome after re-login");
	} catch (err) {
		console.error(readFileSync(srv.log, "utf8").slice(-4000));
		throw err;
	} finally {
		if (srv.child && srv.child.exitCode === null) await srv.kill();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

// ------------------------------------------------------------------ X-ISO

test("X-ISO: another user gets 403 (SSE included); removed project member is blocked mid-run and their stream closes", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("iso-a@example.com");
		const outsider = await t.user("iso-x@example.com");
		const { conversation: c } = await t.json("POST", "/api/conversations", { token: a.token, json: {} });
		await settle(t, a.token, c, (await t.json("POST", `${base(c)}/messages`, { token: a.token, json: { text: "私密 [[reply 机密]]", requestId: rid() } })).submissionId);
		for (const [m, path, body] of [
			["GET", base(c), undefined],
			["GET", `${base(c)}/entries`, undefined],
			["GET", `${base(c)}/state`, undefined],
			["GET", `${base(c)}/events`, undefined],
			["GET", `${base(c)}/tasks`, undefined],
			["POST", `${base(c)}/messages`, { text: "x", requestId: rid() }],
			["POST", `${base(c)}/fork`, { entryId: 1 }],
			["POST", `${base(c)}/abort`, {}],
			["PATCH", base(c), { title: "偷改" }],
		] as const) {
			const res = await t.req(m, path, { token: outsider.token, json: body });
			assert.equal(res.status, 403, `${m} ${path}`);
			assert.doesNotMatch(await res.text(), /机密/);
		}
		assert.equal((await t.json("GET", "/api/conversations", { token: outsider.token })).conversations.length, 0);
		await t.json("GET", `/api/conversations?spaceId=${c.spaceId}`, { token: outsider.token, expect: 403 });

		// same org, project space: B is an editor, then removed while B's run waits before a tool call
		const { invite } = await t.json("POST", "/api/admin/invites", { token: a.token, json: { role: "member" } });
		const b = await t.user("iso-b@example.com", { inviteCode: invite.code });
		assert.equal(b.me.orgId, a.me.orgId);
		const { project } = await t.json("POST", "/api/projects", { token: a.token, json: { kind: "space", name: "协作项目" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: a.token, json: { email: "iso-b@example.com", role: "editor" } });
		const { conversation: pc } = await t.json("POST", "/api/conversations", { token: b.token, json: { projectId: project.id } });
		assert.equal(pc.spaceId, project.spaceId);
		const bsse = sseReader(await t.req("GET", `${base(pc)}/events`, { token: b.token }));
		await bsse.next((e) => e.event === "snapshot");
		const r = await t.json("POST", `${base(pc)}/messages`, { token: b.token, json: { text: `[[slow 1200]] [[call wr_fixture_echo {"text":"项目数据"}]]`, requestId: rid() } });
		await waitFor(async () => (await t.json("GET", `${base(pc)}/submissions/${r.submissionId}`, { token: b.token })).status === "applied");
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: a.token, json: { email: "iso-b@example.com", role: null } });
		// B's stream is closed with a forbidden error at the next ACL re-check
		const err = await bsse.next((e) => e.event === "error", 5_000);
		assert.equal(err.data.code, "forbidden");
		await bsse.close();
		// the run continues server-side but its tool call acts for B → re-checked against current ACL → refused
		const done = await settle(t, a.token, pc, r.submissionId);
		assert.equal(done.status, "done");
		const es = await entriesOf(t, a.token, pc);
		const tr = es.find((e) => e.kind === "tool_result") as any;
		assert.equal(tr.isError, true);
		assert.match(tr.text, /无权|not_member|forbidden/);
		assert.doesNotMatch(tr.text, /echo\(/);
		// B can no longer read, stream or write
		await t.json("GET", base(pc), { token: b.token, expect: 403 });
		assert.equal((await t.req("GET", `${base(pc)}/events`, { token: b.token })).status, 403);
		await t.json("POST", `${base(pc)}/messages`, { token: b.token, json: { text: "还能发吗", requestId: rid() }, expect: 403 });
		// a branch never resurrects access: fork by the owner, B still refused there
		const { conversation: fb } = await t.json("POST", `${base(pc)}/fork`, { token: a.token, json: { entryId: es.at(-1)!.id } });
		await t.json("GET", base(fb), { token: b.token, expect: 403 });
	} finally {
		await t.dispose();
	}
});
