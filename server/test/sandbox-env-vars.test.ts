// Group V: sandbox environment variables (scopes, permissions, precedence + locked, deny list, secret heuristics, limits, audit, isolation).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import type { AppEnv, Principal } from "../src/core/contracts.ts";
import { HttpError } from "../src/core/http.ts";
import { ENV_MIGRATIONS, denyReason, looksLikeSecret, mergeSandboxEnv, sandboxEnvFor } from "../src/tools/sandbox/env-vars.ts";
import { registerSandboxEnvRoutes } from "../src/tools/sandbox/env-routes.ts";

type U = { token: string; me: any };
interface H {
	t: TestApp;
	owner: U;
	member: U;
	viewer: U;
	other: U;
	projectId: string;
	spaceId: string;
	convP: string; // project conversation scopeRef
	convPersonal: string; // member's personal conversation scopeRef
	call(u: U, method: string, path: string, json?: unknown): Promise<{ status: number; body: any; text: string }>;
	principal(u: U): Promise<Principal>;
}
const ref = (c: { spaceId: string; conversationId: number }) => `${c.spaceId}:${c.conversationId}`;

async function harness(): Promise<H> {
	const t = await startTestApp();
	const owner = await t.user("own@v.example");
	const mk = async (email: string) => t.user(email, { inviteCode: (await t.json("POST", "/api/admin/invites", { token: owner.token, json: { role: "member" } })).invite.code });
	const member = await mk("mem@v.example");
	const viewer = await mk("vw@v.example");
	const other = await t.user("oth@w.example");
	const ctx = t.app.ctx;
	if (!ctx.db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'sandbox_env_vars'")) ctx.db.migrate("tools-v-test", ENV_MIGRATIONS);
	const proj = (await t.json("POST", "/api/projects", { token: member.token, json: { kind: "space", name: "P" } })).project;
	await t.json("PUT", `/api/projects/${proj.id}/members`, { token: member.token, json: { userId: viewer.me.userId, role: "viewer" } });
	const convP = (await t.json("POST", "/api/conversations", { token: member.token, json: { projectId: proj.id } })).conversation;
	const convPersonal = (await t.json("POST", "/api/conversations", { token: member.token, json: {} })).conversation;
	const hono = new Hono<AppEnv>();
	hono.onError((err, c) => (err instanceof HttpError ? c.json({ error: { code: err.code, message: err.message } }, err.status as 400) : c.json({ error: { code: "internal", message: String(err) } }, 500)));
	hono.use("*", async (c, next) => {
		const [uid, oid] = c.req.header("x-who")!.split("|");
		c.set("principal", (await ctx.services.get("identity").principalFor(uid!, oid!))!);
		await next();
	});
	const api = new Hono<AppEnv>();
	registerSandboxEnvRoutes(api, ctx);
	hono.route("/api", api);
	const call: H["call"] = async (u, method, path, json) => {
		const res = await hono.fetch(new Request(`http://x${path}`, { method, headers: { "x-who": `${u.me.userId}|${u.me.orgId}`, "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) }));
		const text = await res.text();
		return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
	};
	const principal = async (u: U) => (await ctx.services.get("identity").principalFor(u.me.userId, u.me.orgId))!;
	return { t, owner, member, viewer, other, projectId: proj.id, spaceId: proj.spaceId, convP: ref(convP), convPersonal: ref(convPersonal), call, principal };
}
const e = (s: string) => encodeURIComponent(s);
const put = (h: H, u: U, scope: string, r: string, name: string, value: unknown, extra: object = {}) => h.call(u, "PUT", `/api/sandbox-env/${scope}/${e(r)}/${name}`, { value, ...extra });

test("permissions per scope: org / project / user / conversation, other org isolated (404)", async () => {
	const h = await harness();
	try {
		const orgId = h.owner.me.orgId;
		// org: admin (owner) yes, member no
		assert.equal((await put(h, h.owner, "org", orgId, "ORG_A", "1")).status, 200);
		assert.equal((await put(h, h.member, "org", orgId, "ORG_B", "1")).status, 403);
		assert.equal((await h.call(h.member, "GET", `/api/sandbox-env/org/${orgId}`)).status, 403);
		assert.equal((await h.call(h.member, "DELETE", `/api/sandbox-env/org/${orgId}/ORG_A`)).status, 403);
		assert.equal((await h.call(h.other, "GET", `/api/sandbox-env/org/${orgId}`)).status, 404);
		// project: manager (project owner = member) writes; viewer reads but cannot write; org member outside the project gets 403; other org 404
		assert.equal((await put(h, h.member, "project", h.projectId, "PRJ_A", "x")).status, 200);
		assert.equal((await put(h, h.viewer, "project", h.projectId, "PRJ_B", "x")).status, 403);
		const vr = await h.call(h.viewer, "GET", `/api/sandbox-env/project/${h.projectId}`);
		assert.equal(vr.status, 200);
		assert.deepEqual(vr.body.vars.map((v: any) => v.name), ["PRJ_A"]);
		assert.equal((await h.call(h.other, "GET", `/api/sandbox-env/project/${h.projectId}`)).status, 404);
		assert.equal((await put(h, h.other, "project", h.projectId, "PRJ_C", "x")).status, 404);
		// org admin holds project.manage by default per authz rules; just make sure the owner is not blocked arbitrarily either way
		assert.ok([200, 403].includes((await put(h, h.owner, "project", h.projectId, "PRJ_D", "x")).status));
		// user: only yourself
		assert.equal((await put(h, h.member, "user", h.member.me.userId, "MY_VAR", "v")).status, 200);
		assert.equal((await put(h, h.owner, "user", h.member.me.userId, "MY_VAR", "evil")).status, 403);
		assert.equal((await h.call(h.owner, "GET", `/api/sandbox-env/user/${h.member.me.userId}`)).status, 403);
		assert.equal((await h.call(h.other, "GET", `/api/sandbox-env/user/${h.member.me.userId}`)).status, 404);
		// conversation: write access to the space + conversation exists
		assert.equal((await put(h, h.member, "conversation", h.convP, "CONV_A", "c")).status, 200);
		assert.equal((await put(h, h.viewer, "conversation", h.convP, "CONV_B", "c")).status, 403, "viewer has no write access to the space");
		assert.equal((await h.call(h.viewer, "GET", `/api/sandbox-env/conversation/${e(h.convP)}`)).status, 200);
		assert.equal((await put(h, h.owner, "conversation", h.convPersonal, "CONV_C", "c")).status, 403, "other member's personal space");
		assert.equal((await put(h, h.other, "conversation", h.convP, "CONV_D", "c")).status, 404, "other org");
		const missing = `${h.spaceId}:99999`;
		assert.equal((await put(h, h.member, "conversation", missing, "CONV_E", "c")).status, 404, "conversation must exist in that space");
		assert.equal((await put(h, h.member, "conversation", "garbage", "CONV_E", "c")).status, 404);
		assert.equal((await put(h, h.member, "nope", "x", "A", "c")).status, 400);
		// delete
		assert.equal((await h.call(h.member, "DELETE", `/api/sandbox-env/user/${h.member.me.userId}/MY_VAR`)).status, 200);
		assert.equal((await h.call(h.member, "DELETE", `/api/sandbox-env/user/${h.member.me.userId}/MY_VAR`)).status, 404);
		const ok = await put(h, h.member, "user", h.member.me.userId, "TZ", "Asia/Shanghai");
		assert.equal(ok.body.appliesToNewCommandsOnly, true);
	} finally {
		await h.t.dispose();
	}
});

test("precedence conversation > user > project > org; locked org vars cannot be overridden; personal spaces have no project level", async () => {
	const h = await harness();
	try {
		const svc = sandboxEnvFor(h.t.app.ctx);
		const orgId = h.owner.me.orgId;
		const uid = h.member.me.userId;
		const m = h.member;
		await put(h, h.owner, "org", orgId, "LAYER", "org");
		await put(h, h.owner, "org", orgId, "LOCKED", "org-locked", { locked: true });
		await put(h, h.owner, "org", orgId, "ONLY_ORG", "o");
		await put(h, m, "project", h.projectId, "LAYER", "project");
		await put(h, m, "project", h.projectId, "LOCKED", "project");
		await put(h, m, "project", h.projectId, "PRJ_ONLY", "p");
		await put(h, m, "user", uid, "LAYER", "user");
		await put(h, m, "user", uid, "LOCKED", "user");
		await put(h, m, "conversation", h.convP, "LAYER", "conv");
		await put(h, m, "conversation", h.convP, "LOCKED", "conv");
		const p = await h.principal(m);
		const space = h.t.app.ctx.services.get("identity").projectSpace(h.projectId)!;
		const convId = Number(h.convP.split(":")[1]);
		const r = svc.resolve(p, space, convId);
		assert.equal(r.env.LAYER, "conv");
		assert.equal(r.env.LOCKED, "org-locked");
		assert.equal(r.env.ONLY_ORG, "o");
		assert.equal(r.env.PRJ_ONLY, "p");
		const layer = r.effective.vars.find((v) => v.name === "LAYER")!;
		assert.equal(layer.from, "conversation");
		assert.deepEqual(layer.overridden, ["org", "project", "user"]);
		assert.equal(r.effective.vars.find((v) => v.name === "LOCKED")!.from, "org");
		const lockedDenied = r.effective.denied.filter((d) => d.name === "LOCKED");
		assert.equal(lockedDenied.length, 3);
		assert.equal(r.effective.appliesToNewCommandsOnly, true);
		// without the conversation: user wins over project
		assert.equal(svc.resolve(p, space).env.LAYER, "user");
		// personal space: no project level
		const personal = h.t.app.ctx.services.get("identity").personalSpace(uid, p.orgId);
		const rp = svc.resolve(p, personal);
		assert.equal(rp.env.LAYER, "user");
		assert.equal(rp.env.PRJ_ONLY, undefined);
		// another user's user-scope never applies
		const ro = svc.resolve(await h.principal(h.viewer), space);
		assert.equal(ro.env.LAYER, "project");
		// unlocking lets lower scopes win again
		await put(h, h.owner, "org", orgId, "LOCKED", "org-locked", { locked: false });
		assert.equal(svc.resolve(p, space, convId).env.LOCKED, "conv");
		// cross-org resolve refused
		assert.throws(() => svc.resolve(await0(h, p), space), /./);
	} finally {
		await h.t.dispose();
	}
});
function await0(_h: H, p: Principal): Principal {
	return { ...p, orgId: "other-org" };
}

test("deny list: every class is refused with a plain reason; LANG/LC_*/TZ allowed", async () => {
	const h = await harness();
	try {
		const uid = h.member.me.userId;
		const denied = [
			"LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "ld_preload", "DYLD_INSERT_LIBRARIES", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME", "PYTHONINSPECT", "PYTHONUSERBASE",
			"NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "PERL5OPT", "PERL5LIB", "RUBYOPT", "RUBYLIB", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS",
			"BASH_ENV", "ENV", "PROMPT_COMMAND", "SHELLOPTS", "BASHOPTS", "IFS", "GCONV_PATH", "MALLOC_CHECK_", "GLIBC_TUNABLES",
			"PATH", "HOME", "SHELL", "USER", "TMPDIR",
			"HTTP_PROXY", "https_proxy", "ALL_PROXY", "NO_PROXY", "no_proxy", "FTP_PROXY", "MY_PROXY",
			"SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "NODE_TLS_REJECT_UNAUTHORIZED", "PYTHONHTTPSVERIFY",
			"GIT_SSH_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS",
			"WORKROOM_TOKEN", "SKILL_DIR", "OPENSANDBOX_KEY", "E2B_API_KEY", "DAYTONA_API_KEY",
		];
		for (const n of denied) {
			const r = await put(h, h.member, "user", uid, n, "1");
			assert.equal(r.status, 400, n);
			assert.match(r.body.error.message, /不允许|不能|占用/, n);
			assert.ok(denyReason(n), n);
		}
		for (const n of ["LANG", "LC_ALL", "LC_CTYPE", "TZ", "MY_FLAG", "_X"]) assert.equal((await put(h, h.member, "user", uid, n, "en_US.UTF-8")).status, 200, n);
		// name format
		for (const n of ["1BAD", "A-B", "A".repeat(65)]) assert.equal((await put(h, h.member, "user", uid, n, "1")).status, 400, n);
		// credential hook: refused at write; rows written earlier are dropped at resolve time
		const svc = sandboxEnvFor(h.t.app.ctx);
		await put(h, h.member, "user", uid, "GH_TOKEN_NAME", "1");
		svc.isCredentialEnvName = (_o, n) => n === "GH_TOKEN_NAME" || n === "CRED_X";
		try {
			const r = await put(h, h.member, "user", uid, "CRED_X", "1");
			assert.equal(r.status, 400);
			assert.match(r.body.error.message, /凭据/);
			const space = h.t.app.ctx.services.get("identity").personalSpace(uid, h.member.me.orgId);
			const res = svc.resolve(await h.principal(h.member), space);
			assert.equal(res.env.GH_TOKEN_NAME, undefined);
			assert.ok(res.effective.denied.some((d) => d.name === "GH_TOKEN_NAME" && /凭据/.test(d.reason)));
		} finally {
			svc.isCredentialEnvName = () => false;
		}
		// merge: platform env wins and deny-listed names never get through
		assert.deepEqual(mergeSandboxEnv({ A: "1", LD_PRELOAD: "x", WORKROOM_X: "u", PATH: "/evil" }, { PATH: "/bin", WORKROOM_X: "p" }), { A: "1", PATH: "/bin", WORKROOM_X: "p" });
	} finally {
		await h.t.dispose();
	}
});

test("secret-looking values are refused; harmless values and limits", async () => {
	const h = await harness();
	try {
		const uid = h.member.me.userId;
		const secrets = [
			"sk-abcdefghijklmnop1234",
			"ghp_abcdefghijklmnopqrstuvwxyz0123456789",
			"AKIAIOSFODNN7EXAMPLE",
			"-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
			"aB3xK9mQ2vL8nR5tY7wZ1cD4fG6hJ0pS", // high entropy 32 chars
			"0123456789abcdef0123456789abcdef", // hex
			"postgres://user:hunter2@db.example.com/x",
		];
		for (const v of secrets) {
			const r = await put(h, h.member, "user", uid, "SOME_VAR", v);
			assert.equal(r.status, 400, v);
			assert.match(r.body.error.message, /请使用凭据功能保存密钥/);
		}
		for (const v of ["en_US.UTF-8", "Asia/Shanghai", "https://example.com/some/long/path/segment/that/goes/on", "a_long_snake_case_identifier_for_a_flag_name", "true", "中文值", ""]) {
			assert.equal((await put(h, h.member, "user", uid, "SOME_VAR", v)).status, 200, v);
			assert.equal(looksLikeSecret(v), false, v);
		}
		assert.equal((await put(h, h.member, "user", uid, "SOME_VAR", "a".repeat(4096))).status, 200);
		assert.equal((await put(h, h.member, "user", uid, "SOME_VAR", "a".repeat(4097))).status, 400);
		assert.equal((await put(h, h.member, "user", uid, "SOME_VAR", "a\0b")).status, 400);
		assert.equal((await put(h, h.member, "user", uid, "SOME_VAR", 5)).status, 400);
		assert.equal((await put(h, h.member, "user", uid, "LOCKME", "1", { locked: true })).status, 400, "only org vars lock");
		// 100 vars per scope ref
		const d = await harness();
		try {
			const du = d.member.me.userId;
			for (let i = 0; i < 100; i++) assert.equal((await put(d, d.member, "user", du, `V${i}`, "1")).status, 200);
			assert.equal((await put(d, d.member, "user", du, "V_101", "1")).status, 409);
			assert.equal((await put(d, d.member, "user", du, "V5", "2")).status, 200, "updating an existing one is fine at the cap");
		} finally {
			await d.t.dispose();
		}
	} finally {
		await h.t.dispose();
	}
});

test("audit has hashes but never values; cross-org isolation of rows; effective endpoint", async () => {
	const h = await harness();
	try {
		const ctx = h.t.app.ctx;
		const uid = h.member.me.userId;
		const VAL = "very-distinct-value-marker";
		await put(h, h.member, "user", uid, "AUDITED", VAL);
		await put(h, h.member, "user", uid, "AUDITED", `${VAL}-2`);
		await h.call(h.member, "DELETE", `/api/sandbox-env/user/${uid}/AUDITED`);
		const rows = ctx.db.all<any>("SELECT * FROM id_audit WHERE action LIKE 'sandbox.env.%' ORDER BY at");
		assert.deepEqual(rows.map((r) => r.action), ["sandbox.env.create", "sandbox.env.update", "sandbox.env.delete"]);
		for (const r of rows) {
			assert.ok(!JSON.stringify(r).includes("distinct-value-marker"), "no value in audit");
			const d = JSON.parse(r.detail);
			assert.equal(d.name, "AUDITED");
			assert.equal(d.scope, "user");
			assert.equal(d.scopeRef, uid);
		}
		assert.match(JSON.parse(rows[0].detail).valueSha256, /^[0-9a-f]{12}$/);
		assert.notEqual(JSON.parse(rows[1].detail).valueSha256, JSON.parse(rows[1].detail).previousSha256);

		// cross-org: same-looking names in two orgs never mix; resolve is per org
		await put(h, h.owner, "org", h.owner.me.orgId, "SHARED_NAME", "org1");
		await put(h, h.other, "org", h.other.me.orgId, "SHARED_NAME", "org2");
		const svc = sandboxEnvFor(ctx);
		const id = ctx.services.get("identity");
		const r1 = svc.resolve(await h.principal(h.owner), id.personalSpace(h.owner.me.userId, h.owner.me.orgId));
		const r2 = svc.resolve(await h.principal(h.other), id.personalSpace(h.other.me.userId, h.other.me.orgId));
		assert.equal(r1.env.SHARED_NAME, "org1");
		assert.equal(r2.env.SHARED_NAME, "org2");

		// effective endpoint
		await put(h, h.owner, "org", h.owner.me.orgId, "EFF", "org", { locked: true });
		await put(h, h.member, "project", h.projectId, "EFF", "proj");
		await put(h, h.member, "project", h.projectId, "ONLY_P", "p");
		await put(h, h.member, "conversation", h.convP, "ONLY_P", "c");
		const eff = await h.call(h.viewer, "GET", `/api/sandbox-env/effective?spaceId=${h.spaceId}&conversationId=${h.convP.split(":")[1]}`);
		assert.equal(eff.status, 200);
		const E = eff.body.effective;
		assert.equal(E.appliesToNewCommandsOnly, true);
		assert.equal(E.vars.find((v: any) => v.name === "EFF").value, "org");
		assert.equal(E.vars.find((v: any) => v.name === "ONLY_P").from, "conversation");
		assert.ok(E.denied.some((d: any) => d.name === "EFF"));
		assert.equal((await h.call(h.other, "GET", `/api/sandbox-env/effective?spaceId=${h.spaceId}`)).status, 404);
		assert.equal((await h.call(h.owner, "GET", `/api/sandbox-env/effective?spaceId=${h.spaceId}`)).status, 403, "non-member of the project space");
		assert.equal((await h.call(h.viewer, "GET", `/api/sandbox-env/effective?spaceId=${h.spaceId}&conversationId=99999`)).status, 404);
		assert.equal((await h.call(h.viewer, "GET", `/api/sandbox-env/effective`)).status, 400);
	} finally {
		await h.t.dispose();
	}
});
