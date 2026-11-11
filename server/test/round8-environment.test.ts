// Round 8 (Q2): execution environment of a conversation (GET/POST .../environment).
//  FAKE  = the labelled in-memory test double (server/test/helpers/fake-remote-provider.ts); proves Workroom's own logic only.
//  LIVE  = a real OpenSandbox (WORKROOM_TEST_OPENSANDBOX_URL / _KEY); skipped with a reason when not set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { FakeRemoteProvider } from "./helpers/fake-remote-provider.ts";
import { fauxModel } from "../src/ops/testing.ts";
import { isSettled, waitFor } from "../src/runtime/testing.ts";
import type { Sandbox } from "../src/tools/sandbox.ts";
import { providerConfigsFor } from "../src/tools/sandbox/provider-config.ts";
import { createRemoteProvider } from "../src/tools/sandbox/providers/index.ts";
import type { ConversationEnvironmentDTO } from "../../shared/sandbox.ts";

const SECRET_KEY = "workroom-test-secret-key-0123456789";
const PUBLIC_DNS = async () => [{ address: "93.184.216.34", family: 4 }];
const URL_ = process.env.WORKROOM_TEST_OPENSANDBOX_URL;
const KEY = process.env.WORKROOM_TEST_OPENSANDBOX_KEY;
const skipLive = URL_ && KEY ? undefined : "LIVE: WORKROOM_TEST_OPENSANDBOX_URL / WORKROOM_TEST_OPENSANDBOX_KEY not set (scripts/opensandbox-local.sh)";

const envPath = (spaceId: string, conv: number) => `/api/conversations/${spaceId}/${conv}/environment`;
const rows = (t: TestApp) => t.app.ctx.db.all<{ id: string; state: string; space_id: string; workspace_key: string; last_error: string | null }>("SELECT id, state, space_id, workspace_key, last_error FROM tool_sandbox_instances ORDER BY rowid");

async function setup(opts: { remote?: boolean } = {}) {
	const t = await startTestApp({ config: { secretKey: SECRET_KEY } });
	const owner = await t.user("own@env.example");
	const inv = await t.json("POST", "/api/admin/invites", { token: owner.token, json: { role: "member" } });
	const member = await t.user("mem@env.example", { inviteCode: inv.invite.code });
	const outsider = await t.user("out@other.example");
	const ctx = t.app.ctx;
	const identity = ctx.services.get("identity");
	const principal = (await identity.principalFor(owner.me.userId, owner.me.orgId))!;
	const space = identity.personalSpace(owner.me.userId, owner.me.orgId);
	const sb = ctx.services.get("sandbox") as Sandbox;
	const fake = new FakeRemoteProvider();
	const factoryCalls = { n: 0 };
	if (opts.remote !== false) {
		const svc = providerConfigsFor(ctx);
		svc.resolver = PUBLIC_DNS;
		svc.factory = async () => ((factoryCalls.n++, fake));
		await t.json("PUT", "/api/sandbox/providers/opensandbox", { token: owner.token, json: { enabled: true, endpoint: "https://os.example.test", apiKey: "sk-fake-env-0123456789", allowPrivateNetwork: false, egressAcknowledged: true } });
		await t.json("PUT", "/api/sandbox/provider-policy", { token: owner.token, json: { orgDefault: "opensandbox", allowProjectOverride: false } });
	}
	const get = (token: string, spaceId = space.id, conv = 7) => t.json<ConversationEnvironmentDTO>("GET", envPath(spaceId, conv), { token });
	const prepare = (token: string, spaceId = space.id, conv = 7) => t.json<ConversationEnvironmentDTO>("POST", `${envPath(spaceId, conv)}/prepare`, { token });
	return { t, ctx, owner, member, outsider, principal, space, sb, fake, factoryCalls, get, prepare };
}

test("FAKE · local driver: GET reports this server, nothing to prepare, never touches the instance table; a disabled sandbox is a plain failure", async () => {
	const h = await setup({ remote: false });
	try {
		const e = await h.get(h.owner.token);
		assert.equal(e.location, "this_server");
		assert.ok(e.kind === "local" || e.kind === "none");
		assert.equal(e.canPrepare, false);
		assert.match(e.label, /^平台内置沙箱/, "round 10: the local driver is called 平台内置沙箱");
		assert.ok(!("options" in e) && !("canChoose" in e) && !("chooseHint" in e), "round 10: no per-conversation chooser in the DTO");
		if (e.kind === "local") assert.equal(e.state, "ready");
		if (e.kind === "local") assert.match(e.networkText ?? "", /^(可联网|无网络（)/, "round 9: the driver's actual capability, e.g. 无网络（本机命名空间驱动的技术限制）");
		// admin turns the sandbox off → plain, actionable failure (no raw driver text)
		await h.t.json("PUT", "/api/sandbox/driver", { token: h.owner.token, json: { driver: "none" } });
		const off = await h.get(h.owner.token);
		assert.equal(off.state, "failed");
		assert.equal(off.error, "执行环境未配置：请联系管理员");
		assert.equal(off.kind, "none");
		// prepare on a local environment is a no-op that changes nothing
		const p = await h.prepare(h.owner.token);
		assert.equal(p.state, "failed");
		assert.equal(rows(h.t).length, 0);
	} finally {
		await h.t.dispose();
	}
});

test("FAKE · remote GET: honest labels, no sandbox is created or connected by reading (repeated), prepare available", async () => {
	const h = await setup();
	try {
		for (let i = 0; i < 3; i++) {
			const e = await h.get(h.owner.token);
			assert.equal(e.kind, "remote");
			assert.equal(e.id, "opensandbox");
			assert.equal(e.label, "OpenSandbox（自托管）");
			assert.equal(e.location, "self_hosted");
			assert.equal(e.network, "allowed");
			assert.match(e.networkText ?? "", /^由提供方决定/, "round 9: the provider decides; Workroom states no policy");
			assert.equal(e.state, "none", "an unverified network-off no longer turns the environment into 'failed'");
			assert.equal(e.error, undefined);
			assert.equal(e.canPrepare, true);
			assert.match(e.isolation, /远端沙箱/);
			assert.ok(!JSON.stringify(e).includes("sk-fake-env"), "no secrets");
		}
		assert.equal(h.fake.created, 0, "GET never creates");
		assert.equal(h.fake.boxes.size, 0);
		assert.equal(rows(h.t).length, 0);
		assert.equal(h.factoryCalls.n, 0, "GET never even builds a provider client");
	} finally {
		await h.t.dispose();
	}
});

test("FAKE · one organisation-wide channel: project spaces report the same environment, the per-project chooser endpoints are gone", async () => {
	const h = await setup();
	try {
		const { project } = await h.t.json("POST", "/api/projects", { token: h.owner.token, json: { kind: "space", name: "P" } });
		await h.t.json("PUT", `/api/projects/${project.id}/members`, { token: h.owner.token, json: { email: "mem@env.example", role: "editor" } });
		for (const [tok, sp] of [[h.owner.token, project.spaceId], [h.member.token, project.spaceId], [h.owner.token, h.space.id]] as const) {
			const e = await h.get(tok, sp);
			assert.equal(e.id, "opensandbox");
			assert.equal(e.kind, "remote");
			assert.ok(!("options" in e) && !("canChoose" in e) && !("chooseHint" in e));
		}
		// the project override API no longer exists (GET / PUT)
		assert.equal((await h.t.req("GET", `/api/projects/${project.id}/sandbox-provider`, { token: h.owner.token })).status, 404);
		assert.equal((await h.t.req("PUT", `/api/projects/${project.id}/sandbox-provider`, { token: h.owner.token, json: { provider: "local" } })).status, 404);
		// allowing overrides is refused, and nothing changes for the project
		assert.equal((await h.t.req("PUT", "/api/sandbox/provider-policy", { token: h.owner.token, json: { orgDefault: "opensandbox", allowProjectOverride: true } })).status, 400);
		assert.equal((await h.get(h.owner.token, project.spaceId)).id, "opensandbox");
		// the admin chooses 平台内置沙箱: every space follows at once
		await h.t.json("PUT", "/api/sandbox/provider-policy", { token: h.owner.token, json: { orgDefault: "local" } });
		for (const sp of [project.spaceId, h.space.id]) {
			const e = await h.get(h.owner.token, sp);
			assert.equal(e.location, "this_server");
			assert.equal(e.canPrepare, false);
		}
	} finally {
		await h.t.dispose();
	}
});

test("FAKE · prepare: creates once, idempotent, restores through the same path a run uses (run afterwards reuses the sandbox)", async () => {
	const h = await setup();
	try {
		const a = await h.prepare(h.owner.token);
		assert.equal(a.state, "ready");
		assert.equal(h.fake.created, 1);
		assert.deepEqual(rows(h.t).map((r) => [r.workspace_key, r.state]), [["c7", "ready"]]);
		const b = await h.prepare(h.owner.token);
		assert.equal(b.state, "ready");
		assert.equal(h.fake.created, 1, "idempotent: reconnected, not recreated");
		assert.equal(rows(h.t).length, 1);
		// concurrent prepares do not duplicate either
		await Promise.all([h.prepare(h.owner.token), h.prepare(h.owner.token)]);
		assert.equal(h.fake.created, 1);
		// a real tool-call run takes the same sandbox
		const r = await h.sb.run({ principal: h.principal, space: h.space, conversationId: 7, language: "shell", code: "echo hi" });
		assert.equal(r.exitCode, 0, r.stderr);
		assert.equal(h.fake.created, 1);
		assert.equal((await h.get(h.owner.token)).state, "ready");
		// another conversation of the same space is a different workspace: still "none"
		assert.equal((await h.get(h.owner.token, h.space.id, 8)).state, "none");
	} finally {
		await h.t.dispose();
	}
});

test("FAKE · 'preparing' is true while a run creates the sandbox, then ready", async () => {
	const h = await setup();
	try {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let entered!: () => void;
		const inCreate = new Promise<void>((r) => (entered = r));
		const orig = h.fake.create.bind(h.fake);
		h.fake.create = async (o) => {
			entered();
			await gate;
			return orig(o);
		};
		const run = h.sb.run({ principal: h.principal, space: h.space, conversationId: 7, language: "shell", code: "echo hi" });
		await inCreate;
		const during = await h.get(h.owner.token);
		assert.equal(during.state, "preparing");
		assert.ok(during.updatedAt);
		assert.equal((await h.get(h.owner.token, h.space.id, 8)).state, "none", "only this conversation's workspace is preparing");
		release();
		assert.equal((await run).exitCode, 0);
		assert.equal((await h.get(h.owner.token)).state, "ready");
	} finally {
		await h.t.dispose();
	}
});

test("FAKE · failure is shown plainly, survives GET, retry (prepare) recovers and clears it; a failed run shows too", async () => {
	const h = await setup();
	try {
		h.fake.failCreate = new Error("quota exceeded at provider");
		const f = await h.prepare(h.owner.token);
		assert.equal(f.state, "failed");
		assert.match(f.error ?? "", /quota exceeded/);
		assert.equal(f.canPrepare, true);
		const again = await h.get(h.owner.token);
		assert.equal(again.state, "failed");
		assert.match(again.error ?? "", /quota exceeded/);
		// retry after the cause is fixed
		h.fake.failCreate = undefined;
		const ok = await h.prepare(h.owner.token);
		assert.equal(ok.state, "ready");
		assert.equal(ok.error, undefined);
		assert.equal((await h.get(h.owner.token)).state, "ready");
		// a failing RUN (conversation 9) also surfaces as failed, and a later successful run clears it
		h.fake.failCreate = new Error("boom-9");
		await assert.rejects(h.sb.run({ principal: h.principal, space: h.space, conversationId: 9, language: "shell", code: "echo hi" }));
		assert.equal((await h.get(h.owner.token, h.space.id, 9)).state, "failed");
		h.fake.failCreate = undefined;
		await h.sb.run({ principal: h.principal, space: h.space, conversationId: 9, language: "shell", code: "echo hi" });
		assert.equal((await h.get(h.owner.token, h.space.id, 9)).state, "ready");
	} finally {
		await h.t.dispose();
	}
});

test("FAKE · lost: expiry and idle reaping show 'lost'; the next prepare recreates; an out-of-band delete is only noticed on use (GET never probes)", async () => {
	const h = await setup();
	try {
		await h.prepare(h.owner.token);
		// (a) lifetime reached
		h.ctx.db.run("UPDATE tool_sandbox_instances SET expires_at = ? WHERE workspace_key = 'c7'", new Date(Date.now() - 1000).toISOString());
		assert.equal((await h.get(h.owner.token)).state, "lost");
		assert.equal((await h.prepare(h.owner.token)).state, "ready");
		assert.equal(h.fake.created, 2);
		// (b) idle reaping destroys it
		const driver = h.sb.remote.drivers()[0]!;
		assert.equal(await driver.reapIdle(Date.now() + 24 * 3600_000), 1);
		assert.equal((await h.get(h.owner.token)).state, "lost");
		assert.equal((await h.prepare(h.owner.token)).state, "ready");
		assert.equal(h.fake.created, 3);
		// (c) deleted behind our back: GET must not probe (stays "ready"), the next use detects it, recreates and says so
		const gone = [...h.fake.boxes.values()].at(-1)!;
		h.fake.kill(gone.id);
		assert.equal((await h.get(h.owner.token)).state, "ready", "honest limit: not verified until used");
		const r = await h.sb.run({ principal: h.principal, space: h.space, conversationId: 7, language: "shell", code: "echo hi" });
		assert.match(r.stderr, /已重新创建/);
		assert.equal(h.fake.created, 4);
		assert.equal((await h.get(h.owner.token)).state, "ready");
	} finally {
		await h.t.dispose();
	}
});

test("FAKE · permissions: other org 404, same-org non-member 403, GET needs read, prepare needs write", async () => {
	const h = await setup();
	try {
		const other = await h.t.req("GET", envPath(h.space.id, 7), { token: h.outsider.token });
		assert.equal(other.status, 404);
		assert.equal((await h.t.req("POST", `${envPath(h.space.id, 7)}/prepare`, { token: h.outsider.token })).status, 404);
		const peer = await h.t.req("GET", envPath(h.space.id, 7), { token: h.member.token });
		assert.equal(peer.status, 403, "someone else's personal space");
		assert.equal((await h.t.req("POST", `${envPath(h.space.id, 7)}/prepare`, { token: h.member.token })).status, 403);
		assert.equal((await h.t.req("GET", envPath(h.space.id, 7))).status, 401);
		assert.equal((await h.t.req("GET", envPath(h.space.id, -1), { token: h.owner.token })).status, 400);
		// a project viewer can read but not prepare
		const { project } = await h.t.json("POST", "/api/projects", { token: h.owner.token, json: { kind: "space", name: "V" } });
		await h.t.json("PUT", `/api/projects/${project.id}/members`, { token: h.owner.token, json: { email: "mem@env.example", role: "viewer" } });
		const v = await h.t.json<ConversationEnvironmentDTO>("GET", envPath(project.spaceId, 1), { token: h.member.token });
		assert.equal(v.canPrepare, false);
		assert.equal((await h.t.req("POST", `${envPath(project.spaceId, 1)}/prepare`, { token: h.member.token })).status, 403);
		assert.equal(h.fake.created, 0);
	} finally {
		await h.t.dispose();
	}
});

test("FAKE · misconfiguration: disabled provider / no key / no driver → state failed with the plain message, never the local driver", async () => {
	const h = await setup();
	try {
		// round 10: the active channel cannot be disabled through the API; a legacy / hand-edited row is still reported plainly (no fallback)
		assert.equal((await h.t.req("PUT", "/api/sandbox/providers/opensandbox", { token: h.owner.token, json: { enabled: false } })).status, 409);
		h.ctx.db.run("UPDATE tool_sandbox_providers SET enabled = 0 WHERE provider = 'opensandbox'");
		let e = await h.get(h.owner.token);
		assert.equal(e.kind, "remote");
		assert.equal(e.state, "failed");
		assert.match(e.error ?? "", /^执行环境未配置：请联系管理员/);
		assert.equal(e.canPrepare, false);
		assert.equal((await h.t.req("POST", `${envPath(h.space.id, 7)}/prepare`, { token: h.owner.token })).status, 403);
		h.ctx.db.run("UPDATE tool_sandbox_providers SET enabled = 1, api_key_sealed = NULL, api_key_hint = NULL WHERE provider = 'opensandbox'");
		e = await h.get(h.owner.token);
		assert.equal(e.state, "failed");
		assert.match(e.error ?? "", /缺少密钥/);
		assert.equal(h.fake.created, 0);
	} finally {
		await h.t.dispose();
	}
});

test("FAKE · a plain chat turn (no sandbox tool) creates no sandbox row, builds no provider and never calls a driver", async () => {
	const h = await setup();
	try {
		const model = await fauxModel(h.t, h.owner.token, [{ name: "plain", responses: [fauxAssistantMessage("你好，这是普通回答")] }], { label: "Plain" });
		const { conversation } = await h.t.json("POST", "/api/conversations", { token: h.owner.token, json: { modelId: model.pm.id } });
		const base = `/api/conversations/${conversation.spaceId}/${conversation.conversationId}`;
		const before = await h.t.json<ConversationEnvironmentDTO>("GET", `${base}/environment`, { token: h.owner.token });
		assert.equal(before.state, "none");
		const r = await h.t.json("POST", `${base}/messages`, { token: h.owner.token, json: { text: "你好", requestId: randomUUID() } });
		const s = await waitFor(async () => {
			const x = await h.t.json("GET", `${base}/submissions/${r.submissionId}`, { token: h.owner.token });
			return isSettled(x) ? x : undefined;
		}, { timeoutMs: 20_000, what: "turn settles" });
		assert.equal(s.status, "done");
		assert.equal(rows(h.t).length, 0, "no tool_sandbox_instances row");
		assert.equal(h.factoryCalls.n, 0, "no provider client built");
		assert.equal(h.fake.created, 0);
		assert.equal(h.fake.boxes.size, 0);
		const after = await h.t.json<ConversationEnvironmentDTO>("GET", `${base}/environment`, { token: h.owner.token });
		assert.equal(after.state, "none");
		assert.equal(h.factoryCalls.n, 0);
	} finally {
		await h.t.dispose();
	}
});

test("LIVE OpenSandbox · GET creates nothing; prepare creates and verifies a real sandbox; idempotent; a run reuses it", { skip: skipLive, timeout: 600_000 }, async () => {
	const prevAllow = process.env.WORKROOM_WEBHOOK_ALLOWLIST;
	process.env.WORKROOM_WEBHOOK_ALLOWLIST = new URL(URL_!).hostname;
	const h = await setup({ remote: false });
	const provider = await createRemoteProvider({ provider: "opensandbox", endpoint: URL_, apiKey: KEY });
	try {
		await h.t.json("PUT", "/api/sandbox/providers/opensandbox", { token: h.owner.token, json: { enabled: true, endpoint: URL_, apiKey: KEY, allowPrivateNetwork: true, egressAcknowledged: true } });
		await h.t.json("PUT", "/api/sandbox/provider-policy", { token: h.owner.token, json: { orgDefault: "opensandbox", allowProjectOverride: false } });
		const conv = 4242;
		const none = await h.get(h.owner.token, h.space.id, conv);
		assert.equal(none.kind, "remote");
		assert.equal(none.state, "none");
		assert.equal(rows(h.t).length, 0, "GET created nothing");
		const ready = await h.prepare(h.owner.token, h.space.id, conv);
		assert.equal(ready.state, "ready", JSON.stringify(ready));
		const row = rows(h.t)[0]!;
		const remoteId = h.ctx.db.get<{ remote_id: string }>("SELECT remote_id FROM tool_sandbox_instances WHERE id = ?", row.id)!.remote_id;
		assert.ok(remoteId);
		const again = await h.prepare(h.owner.token, h.space.id, conv);
		assert.equal(again.state, "ready");
		assert.equal(rows(h.t).length, 1, "idempotent: one live sandbox");
		const r = await h.sb.run({ principal: h.principal, space: h.space, conversationId: conv, language: "shell", code: "echo live-ok" });
		assert.equal(r.exitCode, 0, r.stderr);
		assert.match(r.stdout, /live-ok/);
		assert.equal(rows(h.t).filter((x) => x.state === "ready").length, 1, "the run reused the prepared sandbox");
		await provider.destroy(remoteId);
	} finally {
		for (const r of h.ctx.db.all<{ remote_id: string | null }>("SELECT remote_id FROM tool_sandbox_instances WHERE remote_id IS NOT NULL")) await provider.destroy(r.remote_id!).catch(() => {});
		await h.t.dispose();
		if (prevAllow === undefined) delete process.env.WORKROOM_WEBHOOK_ALLOWLIST;
		else process.env.WORKROOM_WEBHOOK_ALLOWLIST = prevAllow;
	}
});
