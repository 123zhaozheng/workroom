// Round 11 (R2b): intent-based background prewarm of the remote sandbox.
//   node --disable-warning=ExperimentalWarning --test server/test/sandbox-prewarm.test.ts
// FAKE = the labelled in-memory test double (server/test/helpers/fake-remote-provider.ts): it proves Workroom's own logic (when a start is requested, that
// the chat never waits for it, dedupe, settings, permissions, the log) and nothing about a real provider. Fixture model only (no real AI).
process.env.WORKROOM_RT_RETRY_BASE_MS ??= "20";
process.env.WORKROOM_RT_RETRY_MAX ??= "1";
process.env.WORKROOM_SSE_THROTTLE_MS ??= "20";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { FakeRemoteProvider } from "./helpers/fake-remote-provider.ts";
import { waitFor } from "../src/runtime/testing.ts";
import type { Sandbox } from "../src/tools/sandbox.ts";
import { prewarmFor, prewarmStats } from "../src/tools/sandbox/prewarm.ts";
import { providerConfigsFor } from "../src/tools/sandbox/provider-config.ts";
import type { ConversationEnvironmentDTO } from "../../shared/sandbox.ts";
import type { ConversationState } from "../../shared/chat.ts";
import type { SandboxPrewarmSettingsDTO, SandboxPrewarmStatsDTO } from "../../shared/prewarm.ts";

const PUBLIC_DNS = async () => [{ address: "93.184.216.34", family: 4 }];
const INTENT = "帮我运行一下这段 Python 代码，看看输出是什么 [[reply 好的]]";
const CHAT = "帮我写一封请假邮件，语气礼貌一点 [[reply 好的]]";

interface LogRow { conversation_id: number; fired: number; reason: string; score: number; threshold: number; signals: string; used_at: string | null }
const logRows = (t: TestApp) => t.app.ctx.db.all<LogRow>("SELECT conversation_id, fired, reason, score, threshold, signals, used_at FROM tool_sandbox_prewarm_log ORDER BY id");

async function setup(opts: { remote?: boolean; pause?: boolean } = {}) {
	const t = await startTestApp({ config: { secretKey: "workroom-test-secret-key-0123456789" } });
	const owner = await t.user("own@prewarm.example");
	const inv = await t.json("POST", "/api/admin/invites", { token: owner.token, json: { role: "member" } });
	const member = await t.user("mem@prewarm.example", { inviteCode: inv.invite.code });
	const ctx = t.app.ctx;
	const identity = ctx.services.get("identity");
	const principal = (await identity.principalFor(owner.me.userId, owner.me.orgId))!;
	const space = identity.personalSpace(owner.me.userId, owner.me.orgId);
	const sb = ctx.services.get("sandbox") as Sandbox;
	const fake = new FakeRemoteProvider(opts.pause ? { pause: true } : {});
	if (opts.remote !== false) {
		const svc = providerConfigsFor(ctx);
		svc.resolver = PUBLIC_DNS;
		svc.factory = async () => fake;
		await t.json("PUT", "/api/sandbox/providers/opensandbox", { token: owner.token, json: { enabled: true, endpoint: "https://os.example.test", apiKey: "sk-fake-prewarm-0123456789", allowPrivateNetwork: false, egressAcknowledged: true } });
		await t.json("PUT", "/api/sandbox/provider-policy", { token: owner.token, json: { orgDefault: "opensandbox", allowProjectOverride: false } });
	}
	// which trigger each prepare carried (the driver sees it as spec.trigger)
	const triggers: (string | undefined)[] = [];
	const orig = sb.prepare.bind(sb);
	sb.prepare = (input) => (triggers.push(input.trigger), orig(input));
	const conv = async (token = owner.token, json: Record<string, unknown> = {}) => (await t.json("POST", "/api/conversations", { token, json })).conversation as { spaceId: string; conversationId: number };
	const send = async (c: { spaceId: string; conversationId: number }, text: string, token = owner.token, attachments?: unknown[]) => {
		const base = `/api/conversations/${c.spaceId}/${c.conversationId}`;
		const r = await t.json<{ submissionId: number }>("POST", `${base}/messages`, { token, json: { text, requestId: randomUUID(), mode: "followUp", ...(attachments ? { attachments } : {}) } });
		return r;
	};
	const answered = (c: { spaceId: string; conversationId: number }, token = owner.token) =>
		waitFor(async () => {
			const s = await t.json<ConversationState>("GET", `/api/conversations/${c.spaceId}/${c.conversationId}/state`, { token });
			return s.live.status !== "running" && s.entries.some((e) => e.kind === "assistant") ? s : undefined;
		}, { timeoutMs: 15_000, what: "chat answered" });
	const env = (c: { spaceId: string; conversationId: number }, token = owner.token) => t.json<ConversationEnvironmentDTO>("GET", `/api/conversations/${c.spaceId}/${c.conversationId}/environment`, { token });
	const idle = () => prewarmFor(ctx).idle();
	return { t, ctx, owner, member, principal, space, sb, fake, triggers, conv, send, answered, env, idle };
}

/** Make provider.create() wait until `release()`; `entered()` resolves when a create call is pending. */
function hangCreate(fake: FakeRemoteProvider) {
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	let calls = 0;
	let enter!: () => void;
	const entered = new Promise<void>((r) => (enter = r));
	const orig = fake.create.bind(fake);
	fake.create = async (o) => {
		calls++;
		enter();
		await gate;
		return orig(o);
	};
	return { release, entered, calls: () => calls };
}

test("FAKE · pure chat never starts a sandbox: no provider call, no instance row, the decision is logged as below threshold", async () => {
	const h = await setup();
	try {
		const c = await h.conv();
		await h.send(c, CHAT);
		await h.answered(c);
		await h.idle();
		assert.equal(h.fake.created, 0);
		assert.equal(h.ctx.db.all("SELECT 1 FROM tool_sandbox_instances").length, 0);
		assert.equal((await h.env(c)).state, "none");
		assert.deepEqual(h.triggers, []);
		const rows = logRows(h.t);
		assert.equal(rows.length, 1);
		assert.deepEqual([rows[0]!.fired, rows[0]!.reason], [0, "below"]);
		assert.ok(rows[0]!.score < rows[0]!.threshold);
	} finally {
		await h.t.dispose();
	}
});

test("FAKE · an execution-intent message starts the sandbox in the background with trigger 'prewarm'; the first tool call later reuses it", async () => {
	const h = await setup();
	try {
		const c = await h.conv();
		await h.send(c, INTENT);
		await h.answered(c);
		await h.idle();
		assert.equal(h.fake.created, 1);
		assert.deepEqual(h.triggers, ["prewarm"]);
		assert.equal((await h.env(c)).state, "ready");
		const rows = logRows(h.t);
		assert.deepEqual(rows.map((r) => [r.fired, r.reason]), [[1, "fired"]]);
		assert.match(rows[0]!.signals, /run_code/);
		assert.equal(rows[0]!.used_at, null, "no exec yet");
		// tier (c) is untouched: the exec call finds the prewarmed sandbox (no second create) and closes the loop in the log
		const r = await h.sb.run({ principal: h.principal, space: h.space, conversationId: c.conversationId, language: "shell", code: "echo hi" });
		assert.equal(r.exitCode, 0, r.stderr);
		assert.equal(h.fake.created, 1);
	} finally {
		await h.t.dispose();
	}
});

test("FAKE · the chat run never waits for the provider: create() hangs, the answer still completes; releasing it finishes the prewarm", async () => {
	const h = await setup();
	try {
		const hang = hangCreate(h.fake);
		const c = await h.conv();
		const t0 = Date.now();
		await h.send(c, INTENT);
		const state = await h.answered(c);
		const took = Date.now() - t0;
		await hang.entered; // the background start is really pending at the provider
		assert.equal(hang.calls(), 1);
		assert.ok(state.entries.some((e) => e.kind === "assistant"), "answer arrived while the sandbox is still being created");
		assert.equal((await h.env(c)).state, "preparing", "the status dot would show 准备中, nothing blocks");
		assert.ok(took < 10_000, `answered in ${took} ms with a hanging provider`);
		hang.release();
		await h.idle();
		assert.equal((await h.env(c)).state, "ready");
		assert.equal(h.fake.created, 1);
	} finally {
		await h.t.dispose();
	}
});

test("FAKE · a failing provider does not fail the chat; the failure is visible in the environment, and the next message does not hammer it", async () => {
	const h = await setup();
	try {
		h.fake.failCreate = new Error("quota exceeded at provider");
		const c = await h.conv();
		await h.send(c, INTENT);
		const s = await h.answered(c);
		assert.notEqual(s.live.status, "failed");
		await h.idle();
		const e = await h.env(c);
		assert.equal(e.state, "failed");
		assert.match(e.error ?? "", /quota exceeded/);
		await h.send(c, INTENT);
		await h.answered(c);
		await h.idle();
		assert.deepEqual(logRows(h.t).map((r) => r.reason), ["fired", "failed_recently"], "cool-down after a failed start");
		assert.equal(h.triggers.length, 1);
	} finally {
		await h.t.dispose();
	}
});

test("FAKE · dedupe: concurrent hints for one workspace start ONE prewarm; a ready or preparing sandbox is left alone; another conversation gets its own", async () => {
	const h = await setup();
	try {
		const hang = hangCreate(h.fake);
		const hook = prewarmFor(h.ctx);
		const msg = { text: "run this script and show the output" };
		hook.onUserMessage(h.principal, h.space, 31, msg);
		hook.onUserMessage(h.principal, h.space, 31, msg);
		hook.onUserMessage(h.principal, h.space, 31, msg);
		await hang.entered;
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(hang.calls(), 1, "one create for three hints");
		hook.onUserMessage(h.principal, h.space, 32, msg);
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(hang.calls(), 2, "a different conversation is a different workspace");
		hang.release();
		await h.idle();
		assert.equal(h.fake.created, 2);
		// now both are ready: more hints change nothing
		hook.onUserMessage(h.principal, h.space, 31, msg);
		await h.idle();
		assert.equal(h.fake.created, 2);
		const byConv = (n: number) => logRows(h.t).filter((r) => r.conversation_id === n).map((r) => r.reason);
		assert.deepEqual(byConv(31).filter((x) => x === "fired"), ["fired"], "exactly one fired row for 31");
		assert.ok(byConv(31).includes("inflight") && byConv(31).includes("ready"));
		assert.equal(h.triggers.length, 2);
	} finally {
		await h.t.dispose();
	}
});

test("FAKE · per-organisation cap: a burst of conversations opens at most 4 prewarms at a time", async () => {
	const h = await setup();
	try {
		const hang = hangCreate(h.fake);
		const hook = prewarmFor(h.ctx);
		for (let n = 40; n < 47; n++) hook.onUserMessage(h.principal, h.space, n, { text: "run this script" });
		await hang.entered;
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(hang.calls(), 4);
		assert.equal(logRows(h.t).filter((r) => r.reason === "capped").length, 3);
		hang.release();
		await h.idle();
	} finally {
		await h.t.dispose();
	}
});

test("FAKE · setting off: nothing is started and nothing is logged; the default is on at 0.3; validation and permission", async () => {
	const h = await setup();
	try {
		const get = () => h.t.json<{ settings: SandboxPrewarmSettingsDTO }>("GET", "/api/sandbox/prewarm", { token: h.owner.token });
		assert.deepEqual((await get()).settings, { enabled: true, threshold: 0.3 });
		assert.deepEqual((await h.t.json("PUT", "/api/sandbox/prewarm", { token: h.owner.token, json: { enabled: false } })).settings, { enabled: false, threshold: 0.3 });
		const c = await h.conv();
		await h.send(c, INTENT);
		await h.answered(c);
		await h.idle();
		assert.equal(h.fake.created, 0);
		assert.equal(logRows(h.t).length, 0);
		// threshold: 100 % never fires an ordinary intent message; 0 would fire everything (allowed, it is the admin's call)
		await h.t.json("PUT", "/api/sandbox/prewarm", { token: h.owner.token, json: { enabled: true, threshold: 1 } });
		await h.send(c, INTENT);
		await h.answered(c);
		await h.idle();
		assert.equal(h.fake.created, 0);
		assert.equal(logRows(h.t).at(-1)!.threshold, 1);
		await h.t.json("PUT", "/api/sandbox/prewarm", { token: h.owner.token, json: { threshold: 0.3 } });
		// validation + RBAC
		for (const bad of [{ threshold: 1.5 }, { threshold: -0.1 }, { threshold: "0.3" }, { enabled: "yes" }]) assert.equal((await h.t.req("PUT", "/api/sandbox/prewarm", { token: h.owner.token, json: bad })).status, 400, JSON.stringify(bad));
		assert.equal((await h.t.req("GET", "/api/sandbox/prewarm", { token: h.member.token })).status, 403);
		assert.equal((await h.t.req("PUT", "/api/sandbox/prewarm", { token: h.member.token, json: { enabled: false } })).status, 403);
		assert.equal((await h.t.req("GET", "/api/sandbox/prewarm/stats", { token: h.member.token })).status, 403);
		assert.equal((await get()).settings.enabled, true);
		assert.ok(h.ctx.db.get("SELECT 1 AS x FROM id_audit WHERE action = 'sandbox.prewarm.update'"), "changes are audited");
		// stored per organisation in tool_sandbox_settings
		assert.ok(h.ctx.db.get("SELECT 1 FROM tool_sandbox_settings WHERE key = ?", `prewarm:${h.owner.me.orgId}`));
	} finally {
		await h.t.dispose();
	}
});

test("FAKE · a local channel never prewarms (nothing to start), and an org without a remote provider logs nothing", async () => {
	const h = await setup({ remote: false });
	try {
		const c = await h.conv();
		await h.send(c, INTENT);
		await h.answered(c);
		await h.idle();
		assert.equal(h.fake.created, 0);
		assert.equal(logRows(h.t).length, 0);
	} finally {
		await h.t.dispose();
	}
});

test("FAKE · permissions: without sandbox.use (访客) or without write access nothing starts; runtime-written inputs (automation) never prewarm", async () => {
	const h = await setup();
	try {
		const hook = prewarmFor(h.ctx);
		const identity = h.ctx.services.get("identity");
		// 访客: project editor (space ACL allows writes) but the role lacks sandbox.use
		const guest = await h.t.user("guest@prewarm.example", { inviteCode: (await h.t.json("POST", "/api/admin/invites", { token: h.owner.token, json: { role: "member" } })).invite.code });
		await h.t.json("POST", "/api/admin/role-assignments", { token: h.owner.token, json: { subject: { kind: "user", id: guest.me.userId }, roleId: "builtin:guest", scope: { kind: "org" } } });
		const { project } = await h.t.json("POST", "/api/projects", { token: h.owner.token, json: { kind: "space", name: "Prewarm" } });
		await h.t.json("PUT", `/api/projects/${project.id}/members`, { token: h.owner.token, json: { email: "guest@prewarm.example", role: "editor" } });
		await h.t.json("PUT", `/api/projects/${project.id}/members`, { token: h.owner.token, json: { email: "mem@prewarm.example", role: "viewer" } });
		const pspace = identity.space(project.spaceId)!;
		const gp = (await identity.principalFor(guest.me.userId, guest.me.orgId))!;
		assert.equal(await h.ctx.services.get("authz").has(gp, "sandbox.use"), false, "precondition");
		const msg = { text: "run this script and show the output" };
		hook.onUserMessage(gp, pspace, 51, msg);
		// viewer: has sandbox.use but no write on the space
		const mp = (await identity.principalFor(h.member.me.userId, h.member.me.orgId))!;
		assert.equal(await h.ctx.services.get("authz").has(mp, "sandbox.use"), true, "precondition");
		hook.onUserMessage(mp, pspace, 52, msg);
		// automation / subagent inputs
		hook.onUserMessage(h.principal, h.space, 53, { ...msg, via: { kind: "automation" } });
		await h.idle();
		assert.equal(h.fake.created, 0);
		assert.equal(logRows(h.t).length, 0);
		// control: the owner with the same message does fire
		hook.onUserMessage(h.principal, h.space, 54, msg);
		await h.idle();
		assert.equal(h.fake.created, 1);
	} finally {
		await h.t.dispose();
	}
});

test("FAKE · a lost sandbox counts as not ready: a hint recreates it in the background", async () => {
	const h = await setup();
	try {
		const hook = prewarmFor(h.ctx);
		const msg = { text: "run this script and show the output" };
		hook.onUserMessage(h.principal, h.space, 61, msg);
		await h.idle();
		assert.equal(h.fake.created, 1);
		// the sandbox disappears at the provider and the instance expires → state "lost": the next hint recreates it in the background
		h.fake.kill([...h.fake.boxes.keys()][0]!);
		h.ctx.db.run("UPDATE tool_sandbox_instances SET expires_at = ? WHERE workspace_key = 'c61'", new Date(Date.now() - 1000).toISOString());
		assert.equal((await h.env({ spaceId: h.space.id, conversationId: 61 })).state, "lost");
		hook.onUserMessage(h.principal, h.space, 61, msg);
		await h.idle();
		assert.equal(h.fake.created, 2);
		assert.equal((await h.env({ spaceId: h.space.id, conversationId: 61 })).state, "ready");
		// (the paused → resume path has its own test below)
		assert.deepEqual(logRows(h.t).map((r) => r.reason), ["fired", "fired"]);
	} finally {
		await h.t.dispose();
	}
});

test("FAKE · paused sandbox (R1): the idle pause is not 'ready', so the next intent message resumes it in the background (resume, not create); a ready one is left alone", async () => {
	const h = await setup({ pause: true });
	try {
		const hook = prewarmFor(h.ctx);
		const msg = { text: "run this script and show the output" };
		const where = { spaceId: h.space.id, conversationId: 81 };
		hook.onUserMessage(h.principal, h.space, 81, msg);
		await h.idle();
		assert.equal(h.fake.created, 1);
		assert.equal((await h.env(where)).state, "ready");
		// idle for longer than the pause window (default 5 min) → the reaper pauses it
		assert.ok((await h.sb.remote.drivers()[0]!.reapIdle(Date.now() + 10 * 60_000)) >= 1);
		assert.equal((await h.env(where)).state, "paused");
		hook.onUserMessage(h.principal, h.space, 81, msg);
		await h.idle();
		assert.equal(h.fake.created, 1, "resumed, not recreated");
		assert.equal(h.fake.resumeCalls.length, 1);
		assert.equal((await h.env(where)).state, "ready");
		// ready again: another hint does nothing
		hook.onUserMessage(h.principal, h.space, 81, msg);
		await h.idle();
		assert.equal(h.fake.resumeCalls.length, 1);
		assert.deepEqual(logRows(h.t).map((r) => r.reason), ["fired", "fired", "ready"]);
		assert.deepEqual(h.triggers, ["prewarm", "prewarm"]);
	} finally {
		await h.t.dispose();
	}
});

test("FAKE · log loop: an exec marks the fired prewarm (and the message that led to it) as used; stats give precision / recall counts and a sweep", async () => {
	const h = await setup();
	try {
		const hook = prewarmFor(h.ctx);
		const org = h.space.orgId;
		// conv 71: intent → fired → exec  (true positive)
		hook.onUserMessage(h.principal, h.space, 71, { text: "run this script and show the output" });
		await h.idle();
		h.ctx.services.has("sandboxPrewarm") && hook.markExec(org, h.space.id, 71);
		// conv 72: intent → fired → never used (false positive)
		hook.onUserMessage(h.principal, h.space, 72, { text: "运行这个脚本" });
		await h.idle();
		// conv 73: a message below the threshold, then an exec happens anyway (miss)
		hook.onUserMessage(h.principal, h.space, 73, { text: "整理一下这个" });
		await h.idle();
		hook.markExec(org, h.space.id, 73);
		// conv 74: below threshold, no exec (true negative)
		hook.onUserMessage(h.principal, h.space, 74, { text: "你好" });
		await h.idle();
		const by = (n: number) => logRows(h.t).filter((r) => r.conversation_id === n);
		assert.ok(by(71)[0]!.used_at && !by(72)[0]!.used_at && by(73)[0]!.used_at && !by(74)[0]!.used_at);
		const st = prewarmFor(h.ctx).stats(org, new Date(0).toISOString());
		assert.deepEqual({ decisions: st.decisions, fired: st.fired, firedUsed: st.firedUsed, missed: st.missed, precision: st.precision, recall: st.recall }, { decisions: 4, fired: 2, firedUsed: 1, missed: 1, precision: 0.5, recall: 0.5 });
		assert.deepEqual(st.sweep.map((r) => r.threshold), [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
		// the sweep reads the logged scores: at a very low threshold the miss is caught (recall 1), at a high one nothing fires
		const at = (t: number) => st.sweep.find((r) => r.threshold === t)!;
		assert.ok(at(0.7).truePositive <= at(0.1).truePositive);
		// admin API returns the same shape
		const api = await h.t.json<{ stats: SandboxPrewarmStatsDTO }>("GET", "/api/sandbox/prewarm/stats?days=7", { token: h.owner.token });
		assert.equal(api.stats.fired, 2);
		assert.equal(prewarmStats(h.ctx, "another-org", new Date(0).toISOString()).decisions, 0, "scoped to the organisation");
	} finally {
		await h.t.dispose();
	}
});

test("FAKE · a real exec tool call marks the log (end to end through the chat), and the first call still creates the sandbox on demand (tier c)", async () => {
	process.env.WORKROOM_FIXTURE_TOOLS = "1";
	const h = await setup();
	try {
		// off: only the exec creates the sandbox
		await h.t.json("PUT", "/api/sandbox/prewarm", { token: h.owner.token, json: { enabled: false } });
		const c1 = await h.conv();
		await h.send(c1, '[[call exec {"command":"echo hi"}]]');
		await waitFor(async () => (h.fake.created === 1 ? true : undefined), { timeoutMs: 20_000, what: "exec created the sandbox" });
		await h.answered(c1);
		assert.deepEqual(h.triggers, [], "no prepare call: the driver created it on the first tool call");
		// on: intent message prewarms, the exec in the same conversation then marks the log row used
		await h.t.json("PUT", "/api/sandbox/prewarm", { token: h.owner.token, json: { enabled: true } });
		const c2 = await h.conv();
		await h.send(c2, '帮我运行一下这个命令 [[call exec {"command":"echo ok"}]]');
		await waitFor(async () => (logRows(h.t).some((r) => r.conversation_id === c2.conversationId && r.used_at) ? true : undefined), { timeoutMs: 20_000, what: "exec marked the prewarm row" });
		await h.idle();
		assert.equal(h.fake.created, 2, "one sandbox per conversation: prewarm and exec shared it");
		const row = logRows(h.t).find((r) => r.conversation_id === c2.conversationId)!;
		assert.equal(row.fired, 1);
	} finally {
		await h.t.dispose();
	}
});
