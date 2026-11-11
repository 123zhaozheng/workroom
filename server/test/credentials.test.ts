// Credentials (round 7b, C): credential_request -> user form -> sealed storage -> credential_http (server-side injection) -> scrub.
//   node --disable-warning=ExperimentalWarning --test server/test/credentials.test.ts
// Only FAKE secrets. The extension/routes/migration are installed by wire() exactly as module.ts will (docs/requests/round7b-c.md).
// The upstream is a real local HTTPS server with a throwaway test CA (openssl); DNS is a test resolver (api.example.test -> 127.0.0.1) and
// the INSTANCE allowlist (WORKROOM_WEBHOOK_ALLOWLIST=127.0.0.1) unlocks loopback, as an operator would.
process.env.WORKROOM_FIXTURE_TOOLS = "1";
process.env.WORKROOM_RT_RETRY_BASE_MS ??= "20";
process.env.WORKROOM_CREDENTIAL_POLL_MS = "40";

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { orgMember } from "./fixtures/util.ts";
import { waitFor } from "../src/runtime/testing.ts";
import type { AppEnv, ToolActor } from "../src/core/contracts.ts";
import { createCredentialExtension } from "../src/tools/credentials/extension.ts";
import { credentialHttp, proxyConfigFor, scrub, secretForms } from "../src/tools/credentials/proxy.ts";
import { hostMatches, normalizeHostPattern, validateInject, validateRequestArgs } from "../src/tools/credentials/requests.ts";
import { registerCredentialRoutes } from "../src/tools/credentials/routes.ts";
import { createSecretStore, LocalAeadSecretStore, VaultTransitSecretStore } from "../src/tools/credentials/secret-store.ts";
import { CREDENTIAL_MIGRATIONS, credentialsFor } from "../src/tools/credentials/store.ts";
import { PERMISSION_IDS } from "../../shared/permissions.ts";

const SECRET = "sk-test-FAKE-9f3a7c1d5b2e8a40";
const SECRET2 = "sk-test-FAKE-ROTATED-77aa11bb22cc";
const MASTER = "test-master-key-0123456789abcdef-NOT-REAL";

// ------------------------------------------------------------------ console capture (logs must never carry a secret)
const logs: string[] = [];
const realConsole = { error: console.error, log: console.log, warn: console.warn, info: console.info };
for (const k of ["error", "log", "warn", "info"] as const) console[k] = (...a: unknown[]) => void (logs.push(a.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join(" ")), realConsole[k](...(a as [])));

// ------------------------------------------------------------------ local HTTPS upstream with a test CA
interface Seen { url: string; auth?: string; method: string; headers: Record<string, string | string[] | undefined>; body: string }
let work: string;
let ca: string;
let srv: Server;
let port = 0;
const seen: Seen[] = [];
let landingHits = 0;
const savedAllow = process.env.WORKROOM_WEBHOOK_ALLOWLIST;

before(async () => {
	work = mkdtempSync(join(tmpdir(), "wr-cred-"));
	const sh = (...a: string[]) => execFileSync("openssl", a, { cwd: work, stdio: "pipe" });
	sh("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-subj", "/CN=wr-test-ca", "-days", "2");
	sh("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "srv.key", "-out", "srv.csr", "-subj", "/CN=api.example.test");
	writeFileSync(join(work, "ext.cnf"), "subjectAltName=DNS:api.example.test,DNS:other.example.test,DNS:evil.example.test,DNS:x.example.test\n");
	sh("x509", "-req", "-in", "srv.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "srv.pem", "-days", "2", "-extfile", "ext.cnf");
	ca = readFileSync(join(work, "ca.pem"), "utf8");
	srv = createServer({ key: readFileSync(join(work, "srv.key")), cert: readFileSync(join(work, "srv.pem")) }, (req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const auth = req.headers.authorization ?? (req.headers["x-api-key"] as string | undefined);
			seen.push({ url: req.url ?? "", method: req.method ?? "", auth, headers: { ...req.headers }, body: Buffer.concat(chunks).toString() });
			const u = req.url ?? "";
			if (u.startsWith("/redirect")) {
				res.writeHead(302, { location: `https://other.example.test:${port}/landing` }).end();
			} else if (u.startsWith("/landing")) {
				landingHits++;
				res.writeHead(200, { "content-type": "text/plain" }).end("landed");
			} else if (u.startsWith("/echo")) {
				// A hostile/sloppy upstream that reflects the credential in several encodings.
				const a = String(auth ?? "");
				res.writeHead(200, { "content-type": "application/json", "x-reflect": a }).end(JSON.stringify({ auth: a, b64: Buffer.from(`pre:${a}:post`).toString("base64"), url: encodeURIComponent(a), hex: Buffer.from(a).toString("hex"), ok: true }));
			} else if (u.startsWith("/big")) {
				res.writeHead(200, { "content-type": "text/plain" }).end("x".repeat(3 * 1024 * 1024));
			} else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
		});
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	port = (srv.address() as { port: number }).port;
	process.env.WORKROOM_WEBHOOK_ALLOWLIST = "127.0.0.1";
});
after(async () => {
	if (savedAllow === undefined) delete process.env.WORKROOM_WEBHOOK_ALLOWLIST;
	else process.env.WORKROOM_WEBHOOK_ALLOWLIST = savedAllow;
	await new Promise<void>((r) => srv.close(() => r()));
	rmSync(work, { recursive: true, force: true });
	Object.assign(console, realConsole);
});

// ------------------------------------------------------------------ app wiring (what module.ts will do)
function wire(t: TestApp): void {
	t.app.ctx.db.migrate("tools", CREDENTIAL_MIGRATIONS.map((m) => ({ ...m, version: m.version + 1200 })));
	const sub = new Hono<AppEnv>();
	registerCredentialRoutes(sub, t.app.ctx);
	t.app.hono.route("/api", sub); // before the first request (Hono freezes its matcher afterwards)
	(t.app.ctx.services.get("runtime") as any).reinstallExtension(createCredentialExtension(t.app.ctx));
	const cfg = proxyConfigFor(t.app.ctx);
	cfg.resolver = async (h) => (h.endsWith(".example.test") ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "10.1.2.3", family: 4 }]);
	cfg.tls = { ca };
	cfg.allowedPorts.add(port);
}
async function setup(config: { secretKey?: string | undefined } = { secretKey: MASTER }) {
	const t = await startTestApp({ config });
	wire(t);
	const alice = await t.user(`alice-${randomUUID().slice(0, 6)}@example.com`);
	return { t, alice };
}

const state = (t: TestApp, token: string, sp: string, id: number) => t.json("GET", `/api/conversations/${sp}/${id}/state`, { token });
const send = (t: TestApp, token: string, sp: string, id: number, text: string) => t.json("POST", `/api/conversations/${sp}/${id}/messages`, { token, json: { text, requestId: randomUUID() } });
const idle = (t: TestApp, token: string, sp: string, id: number, what: string) =>
	waitFor(async () => {
		const s = await state(t, token, sp, id);
		return !s.live.busy && s.queue.length === 0 ? s : undefined;
	}, { timeoutMs: 30_000, what });
const results = (s: any, name: string) => s.entries.filter((e: any) => e.kind === "tool_result" && e.toolName === name);
async function newConv(t: TestApp, token: string, projectId?: string) {
	const { conversation } = await t.json("POST", "/api/conversations", { token, json: projectId ? { projectId } : {} });
	return { sp: conversation.spaceId as string, cid: conversation.conversationId as number };
}
const pendingFor = (t: TestApp, token: string, cid: number) => waitFor(async () => (await t.json("GET", "/api/credential-requests?status=pending", { token })).requests.find((r: any) => r.conversationId === cid), { what: "pending credential request" });
const form = (t: TestApp, token: string, id: string) => t.json("GET", `/api/credential-requests/${id}`, { token });
const fulfil = (t: TestApp, token: string, id: string, body: Record<string, unknown>) => t.req("POST", `/api/credential-requests/${id}/fulfill`, { token, json: body });
const url = (path: string, host = "api.example.test") => `https://${host}:${port}${path}`;
const audits = (t: TestApp, action: string) => t.app.ctx.db.all<any>("SELECT * FROM id_audit WHERE action = ?", action);
const count = (t: TestApp, table: string, where = "1=1") => t.app.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)!.n;

async function actorFor(t: TestApp, u: { me: any }, sp: string, cid: number, callId = `call-${randomUUID().slice(0, 8)}`): Promise<ToolActor> {
	const principal = (await t.app.ctx.services.get("identity").principalFor(u.me.userId, u.me.orgId))!;
	return { principal, space: t.app.ctx.services.get("identity").space(sp)!, conversationId: cid, taskId: 1, callId };
}

/** Request (service level) + form + fulfil (HTTP, as the browser does). */
async function mkCred(t: TestApp, u: { token: string; me: any }, sp: string, cid: number, o: { args?: Record<string, unknown>; persist?: "once" | "save"; scope?: string; secret?: string; envConsent?: boolean } = {}) {
	const store = credentialsFor(t.app.ctx);
	const actor = await actorFor(t, u, sp, cid);
	const spec = validateRequestArgs({ service: "GitHub", purpose: "read issues", targetHosts: ["api.example.test"], methods: ["GET", "POST", "PUT"], ttlSec: 3600, ...o.args }, store);
	const row = store.createRequest(actor, spec);
	const f = await form(t, u.token, row.id);
	const res = await fulfil(t, u.token, row.id, { secret: o.secret ?? SECRET, persist: o.persist ?? "save", nonce: f.nonce, ...(o.scope ? { scope: o.scope } : {}), ...(o.envConsent !== undefined ? { envConsent: o.envConsent } : {}) });
	const body = await res.json();
	return { actor, row, status: res.status, body, credentialId: body.credential?.id as string, nonce: f.nonce as string };
}

function walk(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else if (e.isFile()) out.push(p);
	}
	return out;
}
/** Files under `dir` (durable storage, app.sqlite + WAL, blobs, sandbox dirs) that contain the secret in any plain encoding. */
function filesWithSecret(dir: string, secret = SECRET): string[] {
	const needles = [Buffer.from(secret), Buffer.from(Buffer.from(secret).toString("base64")), Buffer.from(Buffer.from(secret).toString("hex"))];
	return walk(dir).filter((f) => {
		const b = readFileSync(f);
		return needles.some((n) => b.includes(n));
	});
}
function dbDump(t: TestApp): string {
	const raw = t.app.ctx.db.raw;
	const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
	return tables.map((x) => JSON.stringify(raw.prepare(`SELECT * FROM "${x.name}"`).all(), (_k, v) => (typeof v === "bigint" ? String(v) : v))).join("\n");
}

// ================================================================== end-to-end through the agent loop
test("e2e: request -> pending -> user fulfils once -> tool returns status only -> credential_http injects, scrubs; the secret is nowhere durable", async () => {
	logs.length = 0;
	seen.length = 0;
	const { t, alice } = await setup();
	try {
		const { sp, cid } = await newConv(t, alice.token);
		await send(t, alice.token, sp, cid, `[[call credential_request ${JSON.stringify({ service: "GitHub", purpose: "read issues", targetHosts: ["api.example.test"], methods: ["GET", "POST"], ttlSec: 600 })}]]`);
		const rq = await pendingFor(t, alice.token, cid);
		assert.equal(rq.status, "pending");
		assert.equal(rq.usage, "proxy");
		assert.deepEqual(rq.inject, { header: "Authorization", template: "Bearer {secret}" });
		assert.equal(JSON.stringify(rq).includes("nonce"), false, "the list never carries a nonce");
		assert.equal((await state(t, alice.token, sp, cid)).live.busy, true, "the tool call is waiting");
		const f = await form(t, alice.token, rq.id);
		assert.ok(f.nonce && f.nonce.length >= 40);
		assert.equal(f.request.status, "pending");
		const res = await fulfil(t, alice.token, rq.id, { secret: SECRET, persist: "once", nonce: f.nonce });
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.equal(body.request.status, "fulfilled");
		assert.equal(JSON.stringify(body).includes(SECRET), false, "the response never echoes the secret");
		const s1 = await idle(t, alice.token, sp, cid, "request answered");
		const r1 = results(s1, "credential_request").at(-1);
		const status = JSON.parse(r1.text);
		assert.equal(status.status, "fulfilled");
		assert.equal(status.requestId, rq.id);
		assert.ok(status.credentialId);
		assert.equal(r1.text.includes(SECRET), false);

		await send(t, alice.token, sp, cid, `[[call credential_http ${JSON.stringify({ credentialId: status.credentialId, method: "GET", url: url("/echo") })}]]`);
		const s2 = await idle(t, alice.token, sp, cid, "http done");
		const h = results(s2, "credential_http").at(-1).text as string;
		assert.match(h, /HTTP 200/);
		assert.equal(seen.at(-1)!.auth, `Bearer ${SECRET}`, "the upstream received the injected secret");
		assert.equal(h.includes(SECRET), false, "model-visible output has no secret");
		assert.match(h, /\[REDACTED\]/);
		assert.match(h, /已替换为 \[REDACTED\]/);
		// A second call by requestId (once-credential bound to this conversation) works the same.
		await send(t, alice.token, sp, cid, `[[call credential_http ${JSON.stringify({ requestId: rq.id, method: "GET", url: url("/ok") })}]]`);
		await idle(t, alice.token, sp, cid, "http by requestId");
		assert.equal(seen.at(-1)!.url, "/ok");

		// ---- the secret is in no durable place
		const final = await state(t, alice.token, sp, cid);
		assert.equal(JSON.stringify(final).includes(SECRET), false, "conversation state / entries");
		for (const form of secretForms(SECRET)) assert.equal(JSON.stringify(final).includes(form), false, `state has no encoded form ${form.slice(0, 12)}`);
		assert.deepEqual(filesWithSecret(t.dataDir), [], "no file under the data dir (pi-durable storage, app.sqlite + WAL, blobs, sandbox) contains the secret");
		assert.equal(dbDump(t).includes(SECRET), false, "app db rows");
		assert.equal(logs.join("\n").includes(SECRET), false, "console/log output");
		const aud = JSON.stringify(t.app.ctx.db.all("SELECT * FROM id_audit"));
		assert.equal(aud.includes(SECRET), false);
		for (const a of ["credential.request", "credential.fulfill", "credential.use"]) assert.ok(audits(t, a).length >= 1, a);
		const use = audits(t, "credential.use").map((r) => JSON.parse(r.detail)).find((d) => d.status === 200)!;
		assert.equal(use.host, "api.example.test");
		assert.equal(use.method, "GET");
		assert.equal(JSON.stringify(use).includes("/echo"), false, "audit has no path");
		assert.equal(count(t, "tool_calls", "args_summary LIKE '%sk-test%'"), 0);
		// "once": sealed, not listed for reuse.
		assert.equal((await t.json("GET", "/api/credentials", { token: alice.token })).credentials.length, 0);
		const row = t.app.ctx.db.get<any>("SELECT * FROM credentials WHERE id = ?", status.credentialId)!;
		assert.match(row.sealed, /^v1:/);
		assert.equal(row.persist, "once");
		assert.ok(row.expires_at);
	} finally {
		await t.dispose();
	}
});

test("e2e: decline -> the tool says declined; fulfil afterwards is a 409; cancel and expiry are distinct states", async () => {
	const { t, alice } = await setup();
	try {
		const { sp, cid } = await newConv(t, alice.token);
		await send(t, alice.token, sp, cid, `[[call credential_request ${JSON.stringify({ service: "Stripe", purpose: "p", targetHosts: ["api.example.test"] })}]]`);
		const rq = await pendingFor(t, alice.token, cid);
		const f = await form(t, alice.token, rq.id);
		const d = await t.json("POST", `/api/credential-requests/${rq.id}/decline`, { token: alice.token, json: {} });
		assert.equal(d.request.status, "declined");
		const s = await idle(t, alice.token, sp, cid, "declined");
		const st = JSON.parse(results(s, "credential_request").at(-1).text);
		assert.equal(st.status, "declined");
		assert.equal(st.credentialId, undefined);
		assert.match(st.message, /拒绝/);
		assert.equal((await fulfil(t, alice.token, rq.id, { secret: SECRET, persist: "once", nonce: f.nonce })).status, 409);
		assert.equal(count(t, "credentials"), 0);
		assert.equal(audits(t, "credential.decline").length, 1);

		// cancel (requester withdraws)
		await send(t, alice.token, sp, cid, `[[call credential_request ${JSON.stringify({ service: "Stripe", purpose: "again", targetHosts: ["api.example.test"] })}]]`);
		const rq2 = await waitFor(async () => (await t.json("GET", "/api/credential-requests?status=pending", { token: alice.token })).requests.find((r: any) => r.id !== rq.id), { what: "second request" });
		await t.json("POST", `/api/credential-requests/${rq2.id}/cancel`, { token: alice.token, json: {} });
		const s2 = await idle(t, alice.token, sp, cid, "cancelled");
		assert.equal(JSON.parse(results(s2, "credential_request").at(-1).text).status, "cancelled");

		// expiry (injectable clock; ttl floor is 60 s)
		await send(t, alice.token, sp, cid, `[[call credential_request ${JSON.stringify({ service: "Stripe", purpose: "late", targetHosts: ["api.example.test"], ttlSec: 60 })}]]`);
		const rq3 = await waitFor(async () => (await t.json("GET", "/api/credential-requests?status=pending", { token: alice.token })).requests.find((r: any) => r.id !== rq.id && r.id !== rq2.id), { what: "third request" });
		const f3 = await form(t, alice.token, rq3.id);
		const store = credentialsFor(t.app.ctx);
		store.now = () => Date.now() + 120_000;
		const s3 = await idle(t, alice.token, sp, cid, "expired");
		assert.equal(JSON.parse(results(s3, "credential_request").at(-1).text).status, "expired");
		assert.equal((await fulfil(t, alice.token, rq3.id, { secret: SECRET, persist: "once", nonce: f3.nonce })).status, 409, "no fulfil after expiry");
		assert.equal(audits(t, "credential.expire").length, 1);
		assert.equal(count(t, "credentials"), 0);
	} finally {
		await t.dispose();
	}
});

test("restart while waiting: the request is still pending; the user fulfils once after the restart and the (replayed) tool call completes", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "wr-cred-restart-"));
	let t = await startTestApp({ dataDir, config: { secretKey: MASTER } });
	try {
		wire(t);
		const alice = await t.user("alice-restart-cred@example.com");
		const { sp, cid } = await newConv(t, alice.token);
		await send(t, alice.token, sp, cid, `[[call credential_request ${JSON.stringify({ service: "GitHub", purpose: "x", targetHosts: ["api.example.test"], ttlSec: 3000 })}]]`);
		const rq = await pendingFor(t, alice.token, cid);
		await t.stop();

		t = await startTestApp({ dataDir, config: { secretKey: MASTER } });
		wire(t);
		const login = await t.json("POST", "/api/auth/login", { json: { email: "alice-restart-cred@example.com", password: "password123" } });
		const rq2 = await pendingFor(t, login.token, cid);
		assert.equal(rq2.id, rq.id, "same request row after restart");
		assert.equal(rq2.status, "pending");
		const f = await form(t, login.token, rq.id);
		const ok = await fulfil(t, login.token, rq.id, { secret: SECRET, persist: "once", nonce: f.nonce });
		assert.equal(ok.status, 200);
		assert.equal((await fulfil(t, login.token, rq.id, { secret: SECRET, persist: "once", nonce: f.nonce })).status, 200, "double submit is idempotent");
		const s = await idle(t, login.token, sp, cid, "completed after restart");
		const calls = results(s, "credential_request");
		assert.equal(calls.length, 1, "one tool result");
		assert.equal(JSON.parse(calls[0].text).status, "fulfilled");
		assert.equal(count(t, "credential_requests"), 1);
		assert.equal(count(t, "credentials"), 1, "exactly one credential");
		assert.equal(audits(t, "credential.fulfill").length, 1);
		assert.deepEqual(filesWithSecret(dataDir), []);
	} finally {
		await t.stop();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

// ================================================================== proxy policy (service level, real upstream)
test("proxy: non-allowed host, http, wrong method, header collisions, oversize body are refused BEFORE anything is sent; redirects are not followed", async () => {
	const { t, alice } = await setup();
	try {
		const { sp, cid } = await newConv(t, alice.token);
		const c = await mkCred(t, alice, sp, cid, { args: { methods: ["GET"] } });
		const call = (a: Record<string, unknown>) => credentialHttp(t.app.ctx, c.actor, { credentialId: c.credentialId, method: "GET", url: url("/ok"), ...a } as any);
		seen.length = 0;
		await assert.rejects(call({ url: url("/ok", "evil.example.test") }), /host_not_allowed|只能发往/);
		await assert.rejects(call({ url: url("/ok", "x.api.example.test") }), (e: any) => e.code === "host_not_allowed");
		await assert.rejects(call({ url: `http://api.example.test:${port}/ok` }), (e: any) => e.code === "https_required");
		await assert.rejects(call({ url: `https://user:pw@api.example.test:${port}/ok` }), (e: any) => e.code === "invalid_url");
		await assert.rejects(call({ url: "https://api.example.test:8443/ok" }), (e: any) => e.code === "port_not_allowed");
		await assert.rejects(call({ method: "POST", body: "{}" }), (e: any) => e.code === "method_not_allowed");
		await assert.rejects(call({ headers: { authorization: "Bearer mine" } }), (e: any) => e.code === "header_collision");
		await assert.rejects(call({ headers: { "Transfer-Encoding": "chunked" } }), (e: any) => e.code === "header_not_allowed");
		await assert.rejects(call({ headers: { Connection: "keep-alive" } }), (e: any) => e.code === "header_not_allowed");
		await assert.rejects(call({ headers: { "X-A": "a\r\nInjected: 1" } }), (e: any) => e.code === "invalid_header");
		assert.equal(seen.length, 0, "nothing reached the upstream");
		assert.ok(audits(t, "credential.use_denied").length >= 3, "refusals are audited");

		// redirect: returned, not followed
		landingHits = 0;
		const r = await call({ url: url("/redirect") });
		assert.equal(r.status, 302);
		assert.equal(r.redirect?.host, "other.example.test");
		assert.equal(r.redirect?.sameHost, false);
		assert.equal(landingHits, 0, "the redirect target was never contacted");
		assert.equal(seen.filter((s) => s.url.startsWith("/landing")).length, 0);
		// a follow-up to the redirect target is checked like any other call: other.example.test is not an allowed host
		await assert.rejects(call({ url: url("/landing", "other.example.test") }), (e: any) => e.code === "host_not_allowed");

		// the injected header is the only place the secret goes
		seen.length = 0;
		await call({ url: url("/ok"), headers: { "X-Trace": "t1", "Idempotency-Key": "k-1" } });
		const s = seen.at(-1)!;
		assert.equal(s.auth, `Bearer ${SECRET}`);
		assert.equal(s.headers["idempotency-key"], "k-1", "Idempotency-Key is passed through");
		assert.equal(JSON.stringify({ ...s.headers, authorization: undefined }).includes(SECRET), false);
		assert.equal(s.url.includes(SECRET) || s.body.includes(SECRET), false);
	} finally {
		await t.dispose();
	}
});

test("proxy: private/loopback destinations are refused unless the INSTANCE allowlist names them; metadata is never reachable; org allowlist does not unlock", async () => {
	const { t, alice } = await setup();
	try {
		const { sp, cid } = await newConv(t, alice.token);
		const c = await mkCred(t, alice, sp, cid, { args: { targetHosts: ["api.example.test", "*.example.test", "other.example.test"] } });
		const call = (host: string) => credentialHttp(t.app.ctx, c.actor, { credentialId: c.credentialId, method: "GET", url: url("/ok", host) });
		seen.length = 0;
		assert.equal((await call("api.example.test")).status, 200, "allowlisted loopback works");
		const prev = process.env.WORKROOM_WEBHOOK_ALLOWLIST;
		delete process.env.WORKROOM_WEBHOOK_ALLOWLIST;
		try {
			const n = seen.length;
			await assert.rejects(call("api.example.test"), (e: any) => e.code === "blocked_address");
			assert.equal(seen.length, n, "no connection was made");
		} finally {
			process.env.WORKROOM_WEBHOOK_ALLOWLIST = prev;
		}
		// a hostname that resolves to a private (RFC1918) address is refused even with only loopback allowlisted
		const cfg = proxyConfigFor(t.app.ctx);
		const c2 = await mkCred(t, alice, sp, cid, { args: { targetHosts: ["internal.corp.example"] } });
		await assert.rejects(credentialHttp(t.app.ctx, c2.actor, { credentialId: c2.credentialId, method: "GET", url: "https://internal.corp.example/" }), (e: any) => e.code === "blocked_address");
		// metadata IP literals can't even be requested as a target host (IP hosts need the instance allowlist) ...
		assert.throws(() => normalizeHostPattern("169.254.169.254"), /IP/);
		// ... and DNS answering with the metadata address is refused
		const prevRes = cfg.resolver;
		cfg.resolver = async () => [{ address: "169.254.169.254", family: 4 }];
		await assert.rejects(call("api.example.test"), (e: any) => e.code === "blocked_address");
		cfg.resolver = prevRes;
		// DNS rebinding shape: second answer differs -> the socket is pinned to the first validated address (single resolution per call)
		let n = 0;
		cfg.resolver = async () => (n++ === 0 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "10.9.9.9", family: 4 }]);
		assert.equal((await call("api.example.test")).status, 200);
		assert.equal(n, 1, "resolved exactly once");
		cfg.resolver = prevRes;
	} finally {
		await t.dispose();
	}
});

test("proxy: the upstream reflecting the secret (raw, base64 in any alignment, url-encoded, hex, header) is scrubbed; oversized responses are truncated", async () => {
	const { t, alice } = await setup();
	try {
		const { sp, cid } = await newConv(t, alice.token);
		const c = await mkCred(t, alice, sp, cid);
		const r = await credentialHttp(t.app.ctx, c.actor, { credentialId: c.credentialId, method: "GET", url: url("/echo") });
		const all = JSON.stringify(r);
		assert.equal(r.scrubbed, true);
		for (const f of secretForms(SECRET)) assert.equal(all.includes(f), false, `leaked form ${f.slice(0, 14)}`);
		assert.equal(all.includes(SECRET), false);
		assert.equal(r.headers["x-reflect"], undefined, "unlisted header not shown");
		const parsed = JSON.parse(r.body);
		assert.equal(parsed.ok, true);
		assert.match(parsed.auth, /\[REDACTED\]/);
		const big = await credentialHttp(t.app.ctx, c.actor, { credentialId: c.credentialId, method: "GET", url: url("/big") });
		assert.equal(big.truncated, true);
		assert.ok(big.bodyBytes <= 2 * 1024 * 1024);
		// unit: base64 of the secret embedded at every alignment is found
		for (const pad of ["", "a", "ab"]) {
			const enc = Buffer.from(`${pad}${SECRET}zz`).toString("base64");
			assert.equal(scrub(enc, secretForms(SECRET)).hits > 0, true, `alignment ${pad.length}`);
		}
	} finally {
		await t.dispose();
	}
});

test("proxy refuses a request body over 1 MB and a GET with a body", async () => {
	const { t, alice } = await setup();
	try {
		const { sp, cid } = await newConv(t, alice.token);
		const c = await mkCred(t, alice, sp, cid, { args: { methods: ["GET", "POST"] } });
		await assert.rejects(credentialHttp(t.app.ctx, c.actor, { credentialId: c.credentialId, method: "POST", url: url("/ok"), body: "x".repeat(1024 * 1024 + 1) }), (e: any) => e.code === "body_too_large");
		await assert.rejects(credentialHttp(t.app.ctx, c.actor, { credentialId: c.credentialId, method: "GET", url: url("/ok"), body: "x" }), (e: any) => e.code === "invalid_body");
		const ok = await credentialHttp(t.app.ctx, c.actor, { credentialId: c.credentialId, method: "POST", url: url("/ok"), body: '{"a":1}' });
		assert.equal(ok.status, 200);
	} finally {
		await t.dispose();
	}
});

// ================================================================== form / nonce / fulfil
test("nonce: single use, replaced by a newer form, wrong/missing rejected, only the requester; double submit is idempotent; body size and error bodies", async () => {
	const { t, alice } = await setup();
	try {
		const bob = await orgMember(t, alice, `bob-${randomUUID().slice(0, 5)}@example.com`);
		const { sp, cid } = await newConv(t, alice.token);
		const store = credentialsFor(t.app.ctx);
		const mk = async () => store.createRequest(await actorFor(t, alice, sp, cid), validateRequestArgs({ service: "S", purpose: "p", targetHosts: ["api.example.test"] }, store));
		const rq = await mk();
		const f1 = await form(t, alice.token, rq.id);
		const stored = t.app.ctx.db.get<any>("SELECT nonce_hash FROM credential_requests WHERE id = ?", rq.id)!;
		assert.notEqual(stored.nonce_hash, f1.nonce, "only the hash is stored");
		assert.equal(JSON.stringify(t.app.ctx.db.all("SELECT * FROM credential_requests")).includes(f1.nonce), false);
		// other users: 404 everywhere, nothing learned
		assert.equal((await t.req("GET", `/api/credential-requests/${rq.id}`, { token: bob.token })).status, 404);
		assert.equal((await fulfil(t, bob.token, rq.id, { secret: SECRET, persist: "once", nonce: f1.nonce })).status, 404);
		assert.equal((await t.req("POST", `/api/credential-requests/${rq.id}/decline`, { token: bob.token, json: {} })).status, 404);
		assert.equal((await t.req("GET", `/api/credential-requests/${rq.id}`)).status, 401);
		// wrong / missing nonce
		for (const nonce of ["nope", "", undefined]) assert.equal((await fulfil(t, alice.token, rq.id, { secret: SECRET, persist: "once", nonce })).status, 403);
		// a newer form invalidates the older nonce
		const f2 = await form(t, alice.token, rq.id);
		assert.notEqual(f2.nonce, f1.nonce);
		assert.equal((await fulfil(t, alice.token, rq.id, { secret: SECRET, persist: "once", nonce: f1.nonce })).status, 403);
		// validation errors never echo the value
		const short = await fulfil(t, alice.token, rq.id, { secret: "short", persist: "once", nonce: f2.nonce });
		assert.equal(short.status, 400);
		assert.equal((await short.text()).includes("short\""), false);
		const nl = await fulfil(t, alice.token, rq.id, { secret: `${SECRET}\nX-Evil: 1`, persist: "once", nonce: f2.nonce });
		assert.equal(nl.status, 400);
		assert.equal((await nl.text()).includes(SECRET), false);
		assert.equal((await fulfil(t, alice.token, rq.id, { secret: SECRET, persist: "maybe", nonce: f2.nonce })).status, 400);
		assert.equal(count(t, "credentials"), 0, "failed attempts consumed nothing");
		// oversize body
		const big = await t.req("POST", `/api/credential-requests/${rq.id}/fulfill`, { token: alice.token, body: JSON.stringify({ secret: "x".repeat(20_000), persist: "once", nonce: f2.nonce }), headers: { "content-type": "application/json" } });
		assert.equal(big.status, 413);
		// cross-origin browser post is refused
		const xo = await t.req("POST", `/api/credential-requests/${rq.id}/fulfill`, { token: alice.token, json: { secret: SECRET, persist: "once", nonce: f2.nonce }, headers: { origin: "https://evil.example" } });
		assert.equal(xo.status, 403);
		// success, then the same submit again: same credential, no second row
		const ok = await fulfil(t, alice.token, rq.id, { secret: SECRET, persist: "once", nonce: f2.nonce });
		assert.equal(ok.status, 200);
		const first = await ok.json();
		const again = await fulfil(t, alice.token, rq.id, { secret: SECRET, persist: "once", nonce: f2.nonce });
		assert.equal(again.status, 200);
		const second = await again.json();
		assert.equal(second.idempotent, true);
		assert.equal(second.credential.id, first.credential.id);
		assert.equal(count(t, "credentials"), 1);
		assert.equal(audits(t, "credential.fulfill").length, 1);
		// a consumed nonce with a different request state never re-opens: new GET issues nothing
		assert.equal((await form(t, alice.token, rq.id)).nonce, undefined);
		// concurrent double submit -> exactly one credential
		const rq2 = await mk().then(async () => store.createRequest(await actorFor(t, alice, sp, cid), validateRequestArgs({ service: "S2", purpose: "p", targetHosts: ["api.example.test"] }, store)));
		const f3 = await form(t, alice.token, rq2.id);
		const rs = await Promise.all([1, 2, 3].map(() => fulfil(t, alice.token, rq2.id, { secret: SECRET, persist: "save", nonce: f3.nonce })));
		assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
		assert.equal(count(t, "credentials", `request_id = '${rq2.id}'`), 1);
	} finally {
		await t.dispose();
	}
});

test("persist: 'save' is listed (metadata only, no value anywhere), 'once' is not; env usage needs explicit consent; scope rights", async () => {
	const { t, alice } = await setup();
	try {
		const bob = await orgMember(t, alice, `bob-${randomUUID().slice(0, 5)}@example.com`);
		const { sp, cid } = await newConv(t, alice.token);
		const saved = await mkCred(t, alice, sp, cid, { persist: "save" });
		const list = await t.json("GET", "/api/credentials", { token: alice.token });
		assert.equal(list.credentials.length, 1);
		const d = list.credentials[0];
		assert.deepEqual(Object.keys(d).sort(), ["createdAt", "id", "methods", "name", "ownerId", "scope", "scopeRef", "targetHosts", "usage", "version"]);
		assert.equal(d.scope, "user");
		assert.equal(d.expiresAt, undefined);
		assert.equal(JSON.stringify(await t.json("GET", `/api/credentials/${saved.credentialId}`, { token: alice.token })).includes(SECRET), false);
		// env: no consent -> 400, nothing stored; with consent -> ok
		const store = credentialsFor(t.app.ctx);
		const mkEnv = async () => {
			const row = store.createRequest(await actorFor(t, alice, sp, cid), validateRequestArgs({ service: "Env", purpose: "p", usage: "env", envName: "MY_API_TOKEN" }, store));
			return { row, f: await form(t, alice.token, row.id) };
		};
		const e1 = await mkEnv();
		const noConsent = await fulfil(t, alice.token, e1.row.id, { secret: SECRET, persist: "once", nonce: e1.f.nonce });
		assert.equal(noConsent.status, 400);
		assert.match((await noConsent.json()).error.code, /env_consent_required/);
		assert.equal((await fulfil(t, alice.token, e1.row.id, { secret: SECRET, persist: "once", nonce: e1.f.nonce, envConsent: "yes" })).status, 400, "truthy is not consent");
		assert.equal(e1.f.request.envConsentText.includes("子进程"), true);
		assert.equal((await fulfil(t, alice.token, e1.row.id, { secret: SECRET, persist: "once", nonce: e1.f.nonce, envConsent: true })).status, 200);
		// scope: a plain member may not save org-wide; the org owner may
		const { sp: spB, cid: cidB } = await newConv(t, bob.token);
		const denied = await mkCred(t, bob, spB, cidB, { persist: "save", scope: "org" });
		assert.equal(denied.status, 403);
		const orgCred = await mkCred(t, alice, sp, cid, { persist: "save", scope: "org" });
		assert.equal(orgCred.status, 200);
		assert.equal(orgCred.body.credential.scope, "org");
		assert.equal((await mkCred(t, alice, sp, cid, { persist: "save", scope: "project" })).status, 400, "personal space is not a project");
	} finally {
		await t.dispose();
	}
});

// ================================================================== lifecycle: revoke / rotate / expire / ACL
test("rotate: owner only, new version replaces the sealed value, the old value is never sent again; admin cannot rotate or read", async () => {
	const { t, alice } = await setup(); // alice = org owner
	try {
		const bob = await orgMember(t, alice, `bob-${randomUUID().slice(0, 5)}@example.com`);
		const { sp, cid } = await newConv(t, bob.token);
		const c = await mkCred(t, bob, sp, cid, { persist: "save" });
		const use = () => credentialHttp(t.app.ctx, c.actor, { credentialId: c.credentialId, method: "GET", url: url("/echo") });
		seen.length = 0;
		assert.equal((await use()).status, 200);
		assert.equal(seen.at(-1)!.auth, `Bearer ${SECRET}`);
		const before = t.app.ctx.db.get<any>("SELECT sealed, version FROM credentials WHERE id = ?", c.credentialId)!;
		assert.equal((await t.req("POST", `/api/credentials/${c.credentialId}/rotate`, { token: alice.token, json: { secret: SECRET2 } })).status, 404, "an admin cannot rotate (it would let them choose the value)");
		assert.equal((await t.req("POST", `/api/credentials/${c.credentialId}/rotate`, { token: bob.token, json: { secret: "tiny" } })).status, 400);
		const rot = await t.json("POST", `/api/credentials/${c.credentialId}/rotate`, { token: bob.token, json: { secret: SECRET2 } });
		assert.equal(rot.credential.version, 2);
		assert.equal(JSON.stringify(rot).includes(SECRET2), false);
		const after = t.app.ctx.db.get<any>("SELECT sealed, version FROM credentials WHERE id = ?", c.credentialId)!;
		assert.notEqual(after.sealed, before.sealed);
		assert.equal(after.version, 2);
		assert.equal(t.app.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM credentials WHERE sealed = ?", before.sealed)!.n, 0, "old ciphertext is gone");
		await use();
		assert.equal(seen.at(-1)!.auth, `Bearer ${SECRET2}`);
		assert.equal(audits(t, "credential.rotate").length, 1);
		assert.equal(JSON.stringify(t.app.ctx.db.all("SELECT * FROM id_audit")).includes(SECRET2), false);
		assert.deepEqual(filesWithSecret(t.dataDir, SECRET2), []);
		assert.deepEqual(filesWithSecret(t.dataDir, SECRET), []);
		// a sealed value moved to another row does not open (AAD binds id + version)
		const other = await mkCred(t, bob, sp, cid, { persist: "save", secret: "another-FAKE-secret-0001" });
		t.app.ctx.db.run("UPDATE credentials SET sealed = ? WHERE id = ?", after.sealed, other.credentialId);
		await assert.rejects(credentialHttp(t.app.ctx, other.actor, { credentialId: other.credentialId, method: "GET", url: url("/ok") }), (e: any) => e.code === "needs_reenter");
	} finally {
		await t.dispose();
	}
});

test("revoke: use refused immediately, ciphertext wiped, request revoked; admin may revoke (cannot read); delete removes the row; expired credentials refuse and are wiped", async () => {
	const { t, alice } = await setup();
	try {
		const bob = await orgMember(t, alice, `bob-${randomUUID().slice(0, 5)}@example.com`);
		const carol = await orgMember(t, alice, `carol-${randomUUID().slice(0, 5)}@example.com`);
		const { sp, cid } = await newConv(t, bob.token);
		const c = await mkCred(t, bob, sp, cid, { persist: "save" });
		const use = () => credentialHttp(t.app.ctx, c.actor, { credentialId: c.credentialId, method: "GET", url: url("/ok") });
		await use();
		assert.equal((await t.req("POST", `/api/credentials/${c.credentialId}/revoke`, { token: carol.token, json: {} })).status, 404, "unrelated member");
		const rv = await t.json("POST", `/api/credentials/${c.credentialId}/revoke`, { token: alice.token, json: {} });
		assert.ok(rv.credential.revokedAt);
		seen.length = 0;
		await assert.rejects(use(), (e: any) => e.code === "credential_revoked");
		assert.equal(seen.length, 0);
		assert.equal(t.app.ctx.db.get<any>("SELECT sealed FROM credentials WHERE id = ?", c.credentialId)!.sealed, "", "ciphertext wiped");
		assert.equal(t.app.ctx.db.get<any>("SELECT status FROM credential_requests WHERE id = ?", c.row.id)!.status, "revoked");
		assert.equal(audits(t, "credential.revoke").length, 1);
		assert.equal((await t.req("POST", `/api/credentials/${c.credentialId}/rotate`, { token: bob.token, json: { secret: SECRET2 } })).status, 409, "no rotation of a revoked credential");
		assert.ok(audits(t, "credential.use_denied").some((a) => JSON.parse(a.detail).reason === "credential_revoked"));
		// the admin's view has metadata only
		assert.equal(JSON.stringify(await t.json("GET", `/api/credentials/${c.credentialId}`, { token: alice.token })).includes(SECRET), false);
		// delete
		const c2 = await mkCred(t, bob, sp, cid, { persist: "save", secret: "second-FAKE-secret-0002" });
		await t.json("DELETE", `/api/credentials/${c2.credentialId}`, { token: bob.token });
		assert.equal(count(t, "credentials", `id = '${c2.credentialId}'`), 0);
		// expiry at use: a "once" credential past its TTL is refused and its ciphertext wiped
		const c3 = await mkCred(t, bob, sp, cid, { persist: "once", args: { ttlSec: 60 } });
		const store = credentialsFor(t.app.ctx);
		await credentialHttp(t.app.ctx, c3.actor, { credentialId: c3.credentialId, method: "GET", url: url("/ok") });
		store.now = () => Date.now() + 61_000;
		await assert.rejects(credentialHttp(t.app.ctx, c3.actor, { credentialId: c3.credentialId, method: "GET", url: url("/ok") }), (e: any) => ["credential_expired", "credential_unavailable"].includes(e.code));
		assert.equal(t.app.ctx.db.get<any>("SELECT sealed FROM credentials WHERE id = ?", c3.credentialId)!.sealed, "");
		assert.ok(audits(t, "credential.expire").some((a) => JSON.parse(a.detail).kind === "credential"));
	} finally {
		await t.dispose();
	}
});

test("ACL: other users and other orgs cannot use, list or read someone's credential; org scope needs credential.use.org; project scope = project members; automations never", async () => {
	const { t, alice } = await setup(); // org owner
	try {
		const bob = await orgMember(t, alice, `bob-${randomUUID().slice(0, 5)}@example.com`);
		const dave = await orgMember(t, alice, `dave-${randomUUID().slice(0, 5)}@example.com`);
		const eve = await t.user(`eve-${randomUUID().slice(0, 5)}@example.com`); // different org
		assert.notEqual(eve.me.orgId, alice.me.orgId);
		const { sp: spA, cid: cidA } = await newConv(t, alice.token);
		const mine = await mkCred(t, alice, spA, cidA, { persist: "save" });
		const { sp: spB, cid: cidB } = await newConv(t, bob.token);
		const bobActor = await actorFor(t, bob, spB, cidB);
		const eveConv = await newConv(t, eve.token);
		const eveActor = await actorFor(t, eve, eveConv.sp, eveConv.cid);
		for (const a of [bobActor, eveActor]) await assert.rejects(credentialHttp(t.app.ctx, a, { credentialId: mine.credentialId, method: "GET", url: url("/ok") }), (e: any) => e.code === "credential_not_found");
		// the request id of another user is no key either
		await assert.rejects(credentialHttp(t.app.ctx, bobActor, { requestId: mine.row.id, method: "GET", url: url("/ok") }), (e: any) => e.code === "credential_not_found");
		for (const u of [bob, eve]) {
			assert.equal((await t.json("GET", "/api/credentials", { token: u.token })).credentials.length >= 0, true);
			assert.equal((await t.req("GET", `/api/credentials/${mine.credentialId}`, { token: u.token })).status, 404);
			assert.equal((await t.req("POST", `/api/credentials/${mine.credentialId}/revoke`, { token: u.token, json: {} })).status, 404);
			assert.equal((await t.req("DELETE", `/api/credentials/${mine.credentialId}`, { token: u.token })).status, 404);
		}
		assert.equal((await t.json("GET", "/api/credentials", { token: bob.token })).credentials.length, 0);
		assert.equal((await t.json("GET", "/api/credentials", { token: eve.token })).credentials.length, 0);
		// a "once" credential is also bound to its conversation: the same user in another conversation cannot use it
		const once = await mkCred(t, alice, spA, cidA, { persist: "once" });
		const { cid: cidA2 } = await newConv(t, alice.token);
		await assert.rejects(credentialHttp(t.app.ctx, await actorFor(t, alice, spA, cidA2), { credentialId: once.credentialId, method: "GET", url: url("/ok") }), (e: any) => e.code === "credential_not_found");
		// automation principals never get one
		const viaAuto: ToolActor = { ...mine.actor, principal: { ...mine.actor.principal, via: { kind: "automation", automationId: "au1" } } };
		await assert.rejects(credentialHttp(t.app.ctx, viaAuto, { credentialId: mine.credentialId, method: "GET", url: url("/ok") }), (e: any) => e.code === "credential_not_found");

		// org scope: alice (owner) saves; bob lacks credential.use.org; alice has it
		const org = await mkCred(t, alice, spA, cidA, { persist: "save", scope: "org" });
		assert.equal(org.status, 200);
		await assert.rejects(credentialHttp(t.app.ctx, bobActor, { credentialId: org.credentialId, method: "GET", url: url("/ok") }), (e: any) => e.code === "credential_not_found");
		assert.equal((await credentialHttp(t.app.ctx, await actorFor(t, alice, spA, cidA), { credentialId: org.credentialId, method: "GET", url: url("/ok") })).status, 200);
		assert.equal((await t.json("GET", "/api/credentials", { token: bob.token })).credentials.length, 0);
		// eve (other org) can't see it either
		assert.equal((await t.req("GET", `/api/credentials/${org.credentialId}`, { token: eve.token })).status, 404);

		// project scope: members of the project use it; non-members don't; plain members can't save it
		const { project } = await t.json("POST", "/api/projects", { token: alice.token, json: { name: "Alpha" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: alice.token, json: { userId: bob.me.userId, role: "editor" } });
		const pc = await newConv(t, alice.token, project.id);
		const proj = await mkCred(t, alice, pc.sp, pc.cid, { persist: "save", scope: "project" });
		assert.equal(proj.status, 200, JSON.stringify(proj.body));
		assert.equal(proj.body.credential.scope, "project");
		assert.equal(proj.body.credential.scopeRef, project.id);
		const bobInProject = await actorFor(t, bob, pc.sp, 1);
		assert.equal((await credentialHttp(t.app.ctx, bobInProject, { credentialId: proj.credentialId, method: "GET", url: url("/ok") })).status, 200, "project member");
		assert.equal((await t.json("GET", "/api/credentials", { token: bob.token })).credentials.map((c: any) => c.id).includes(proj.credentialId), true);
		await assert.rejects(credentialHttp(t.app.ctx, await actorFor(t, dave, spA, cidA), { credentialId: proj.credentialId, method: "GET", url: url("/ok") }), (e: any) => e.code === "credential_not_found");
		assert.equal((await t.req("POST", `/api/credentials/${proj.credentialId}/revoke`, { token: bob.token, json: {} })).status, 404, "a plain project member cannot revoke");
		assert.equal((await t.json("GET", "/api/credentials", { token: dave.token })).credentials.length, 0);
	} finally {
		await t.dispose();
	}
});

// ================================================================== env usage (integrator hook)
test("env usage: plaintext only for consented, valid, bound credentials; cleanup clears; revoked/other conversation/other user refused; audit has names only", async () => {
	const { t, alice } = await setup();
	try {
		const bob = await orgMember(t, alice, `bob-${randomUUID().slice(0, 5)}@example.com`);
		const { sp, cid } = await newConv(t, alice.token);
		const store = credentialsFor(t.app.ctx);
		const c = await mkCred(t, alice, sp, cid, { persist: "save", envConsent: true, args: { usage: "env", envName: "GH_TOKEN", targetHosts: undefined } });
		assert.equal(c.status, 200, JSON.stringify(c.body));
		const space = t.app.ctx.services.get("identity").space(sp)!;
		const p = c.actor.principal;
		assert.deepEqual(await store.envCredentialIds(p, space, cid), [c.credentialId]);
		const { env, names, cleanup } = await store.envFor(p, space, cid);
		assert.deepEqual(env, { GH_TOKEN: SECRET });
		assert.deepEqual(names, ["GH_TOKEN"]);
		cleanup();
		assert.deepEqual(env, {});
		// not through the proxy
		await assert.rejects(credentialHttp(t.app.ctx, c.actor, { credentialId: c.credentialId, method: "GET", url: url("/ok") }), (e: any) => e.code === "wrong_usage");
		// other conversation / other user
		const { cid: cid2 } = await newConv(t, alice.token);
		assert.deepEqual(await store.envCredentialIds(p, space, cid2), []);
		await assert.rejects(store.envFor(p, space, cid2, [c.credentialId]), (e: any) => e.code === "credential_not_found");
		const bobP = (await t.app.ctx.services.get("identity").principalFor(bob.me.userId, bob.me.orgId))!;
		await assert.rejects(store.envFor(bobP, space, cid, [c.credentialId]), (e: any) => e.code === "credential_not_found");
		// a proxy credential is never injected as env
		const px = await mkCred(t, alice, sp, cid, { persist: "save" });
		await assert.rejects(store.envFor(p, space, cid, [px.credentialId]), (e: any) => e.code === "env_not_consented");
		// audit: names, no values
		const a = audits(t, "credential.use").map((r) => JSON.parse(r.detail)).filter((d) => d.via === "env");
		assert.equal(a.length, 1);
		assert.equal(a[0].envName, "GH_TOKEN");
		assert.equal(JSON.stringify(t.app.ctx.db.all("SELECT * FROM id_audit")).includes(SECRET), false);
		// revoked
		await t.json("POST", `/api/credentials/${c.credentialId}/revoke`, { token: alice.token, json: {} });
		await assert.rejects(store.envFor(p, space, cid, [c.credentialId]), (e: any) => e.code === "credential_revoked");
		assert.deepEqual(await store.envCredentialIds(p, space, cid), []);
		// automation
		await assert.rejects(store.envFor({ ...p, via: { kind: "automation", automationId: "x" } } as any, space, cid, [px.credentialId]), (e: any) => e.code === "credential_not_found");
	} finally {
		await t.dispose();
	}
});

// ================================================================== validation (the model's arguments are hostile)
test("request validation: hosts, methods, header, template, ttl, env name", () => {
	const store = { validateEnvName: (n: string) => (n === "OK_NAME" ? null : "bad env name") } as any;
	const ok = (a: Record<string, unknown>) => validateRequestArgs({ service: "GitHub", purpose: "p", targetHosts: ["api.github.com"], ...a }, store);
	const bad = (a: Record<string, unknown>, re?: RegExp) => assert.throws(() => ok(a), (e: any) => e.code === "invalid_credential_request" && (!re || re.test(e.message)), JSON.stringify(a));
	const base = ok({});
	assert.deepEqual(base.methods, ["GET"]);
	assert.deepEqual(base.inject, { header: "Authorization", template: "Bearer {secret}" });
	assert.equal(base.usage, "proxy");
	assert.equal(base.ttlSec, 3600);
	// hosts
	assert.equal(normalizeHostPattern("API.GitHub.com"), "api.github.com");
	assert.equal(normalizeHostPattern("*.github.com"), "*.github.com");
	for (const h of ["*", "*.com", "a.*.com", "**.github.com", "github", "https://api.github.com", "api.github.com:443", "api.github.com/x", "user@api.github.com", "api github.com", "-a.com", "", "*.*.github.com", "10.0.0.1", "169.254.169.254", "[::1]", "*.127.0.0.1", "1.2.3.4.5"]) assert.throws(() => normalizeHostPattern(h), /./, h);
	bad({ targetHosts: [] });
	bad({ targetHosts: Array.from({ length: 11 }, (_, i) => `h${i}.example.com`) });
	bad({ targetHosts: "api.github.com" });
	// match semantics: wildcard = exactly one label
	assert.equal(hostMatches("*.github.com", "api.github.com"), true);
	assert.equal(hostMatches("*.github.com", "a.b.github.com"), false);
	assert.equal(hostMatches("*.github.com", "github.com"), false);
	assert.equal(hostMatches("*.github.com", "evilgithub.com"), false);
	assert.equal(hostMatches("*.github.com", "api.github.com.evil.com"), false);
	assert.equal(hostMatches("api.github.com", "API.GITHUB.COM."), true);
	// methods
	assert.deepEqual(ok({ methods: ["get", "post"] }).methods, ["GET", "POST"]);
	bad({ methods: ["TRACE"] });
	bad({ methods: ["CONNECT"] });
	bad({ methods: [] });
	// inject
	assert.deepEqual(validateInject({ header: "X-Api-Key", template: "{secret}" }), { header: "X-Api-Key", template: "{secret}" });
	for (const inj of [{ header: "Authorization", template: "Bearer" }, { header: "Authorization", template: "{secret}{secret}" }, { header: "Bad Header", template: "{secret}" }, { header: "X:y", template: "{secret}" }, { header: "Host", template: "{secret}" }, { header: "Content-Length", template: "{secret}" }, { header: "X-A", template: "a\r\nB: {secret}" }, { header: "X-A", template: "é{secret}" }, { header: "", template: "{secret}" }, { header: "X-A", template: "x".repeat(300) + "{secret}" }]) bad({ inject: inj });
	// ttl
	for (const ttl of [59, 30 * 86400 + 1, 1.5, "60", -1, 0]) bad({ ttlSec: ttl });
	assert.equal(ok({ ttlSec: 60 }).ttlSec, 60);
	assert.equal(ok({ ttlSec: 30 * 86400 }).ttlSec, 30 * 86400);
	// env
	assert.equal(ok({ usage: "env", envName: "OK_NAME", targetHosts: [] }).envName, "OK_NAME");
	bad({ usage: "env", envName: "other" });
	bad({ usage: "env" });
	bad({ envName: "OK_NAME" }, /envName/);
	bad({ usage: "sideways" });
	// service / purpose
	bad({ service: "" });
	bad({ purpose: "x".repeat(301) });
	bad({ purpose: "" });
});

test("env names: reserved/dangerous names are refused by the local rules; V's validator can only add restrictions", async () => {
	const { t } = await setup();
	try {
		const store = credentialsFor(t.app.ctx);
		for (const n of ["PATH", "LD_PRELOAD", "NODE_OPTIONS", "HTTPS_PROXY", "WORKROOM_SECRET_KEY", "HOME", "1BAD", "has space", "", "A".repeat(65), "PYTHONPATH", "GIT_ASKPASS"]) assert.ok(store.validateEnvName(n), n);
		assert.equal(store.validateEnvName("GITHUB_TOKEN"), null);
		store.envNameValidator = (n) => n.startsWith("GITHUB_");
		assert.equal(store.validateEnvName("GITHUB_TOKEN"), null);
		assert.ok(store.validateEnvName("STRIPE_KEY"));
		store.envNameValidator = () => true;
		assert.ok(store.validateEnvName("PATH"), "a permissive hook cannot lift the local denylist");
	} finally {
		await t.dispose();
	}
});

// ================================================================== secret stores
test("without a master key nothing is created or stored: request refused (未配置), routes report it, tool says so", async () => {
	const savedKey = process.env.WORKROOM_SECRET_KEY;
	const savedFile = process.env.WORKROOM_SECRET_KEY_FILE;
	delete process.env.WORKROOM_SECRET_KEY;
	delete process.env.WORKROOM_SECRET_KEY_FILE;
	const { t, alice } = await setup({ secretKey: undefined });
	try {
		const store = credentialsFor(t.app.ctx);
		assert.equal(store.secretStore.available, false);
		assert.match(store.secretStore.reason, /未配置/);
		const { sp, cid } = await newConv(t, alice.token);
		const actor = await actorFor(t, alice, sp, cid);
		assert.throws(() => store.createRequest(actor, validateRequestArgs({ service: "S", purpose: "p", targetHosts: ["api.example.test"] }, store)), (e: any) => e.code === "secret_storage_unavailable");
		assert.equal(count(t, "credential_requests"), 0);
		const st = await t.json("GET", "/api/credentials/status", { token: alice.token });
		assert.equal(st.store.available, false);
		assert.match(st.store.reason, /未配置/);
		await assert.rejects(store.secretStore.seal("x".repeat(20), "aad"), (e: any) => e.code === "secret_storage_unavailable");
		// through the agent loop the model is told, and no request exists
		await send(t, alice.token, sp, cid, `[[call credential_request ${JSON.stringify({ service: "S", purpose: "p", targetHosts: ["api.example.test"] })}]]`);
		const s = await idle(t, alice.token, sp, cid, "refused");
		const r = results(s, "credential_request").at(-1);
		assert.match(r.text, /未配置/);
		assert.equal(count(t, "credential_requests"), 0);
	} finally {
		if (savedKey !== undefined) process.env.WORKROOM_SECRET_KEY = savedKey;
		if (savedFile !== undefined) process.env.WORKROOM_SECRET_KEY_FILE = savedFile;
		await t.dispose();
	}
});

test("local store: key from file needs 600 perms and a regular file; short keys, unknown store kinds and half-configured Vault are unavailable, never replaced by another store", async () => {
	const d = mkdtempSync(join(tmpdir(), "wr-key-"));
	try {
		const kf = join(d, "master.key");
		writeFileSync(kf, `${MASTER}\n`, { mode: 0o644 });
		chmodSync(kf, 0o644);
		const wide = new LocalAeadSecretStore({ keyFile: kf });
		assert.equal(wide.available, false);
		assert.match(wide.reason, /权限过宽/);
		chmodSync(kf, 0o600);
		const good = new LocalAeadSecretStore({ keyFile: kf });
		assert.equal(good.available, true);
		const sealed = await good.seal(SECRET, "aad1");
		assert.equal(sealed.includes(SECRET), false);
		assert.equal(await good.open(sealed, "aad1"), SECRET);
		await assert.rejects(good.open(sealed, "aad2"), /./, "wrong AAD");
		assert.equal(await new LocalAeadSecretStore({ inlineKey: MASTER }).open(sealed, "aad1"), SECRET, "file and env give the same key (trailing newline stripped)");
		await assert.rejects(new LocalAeadSecretStore({ inlineKey: `${MASTER}-other` }).open(sealed, "aad1"), /./, "different key");
		const ln = join(d, "link.key");
		symlinkSync(kf, ln);
		assert.match(new LocalAeadSecretStore({ keyFile: ln }).reason, /符号链接/);
		assert.match(new LocalAeadSecretStore({ keyFile: join(d, "missing") }).reason, /无法读取/);
		assert.equal(new LocalAeadSecretStore({ inlineKey: "short" }).available, false);
		assert.equal(new LocalAeadSecretStore({}).available, false);
		assert.match(new LocalAeadSecretStore({}).reason, /未配置/);
		// a key file wins over an inline key (and a bad file does not fall back to the inline one)
		assert.equal(new LocalAeadSecretStore({ keyFile: join(d, "missing"), inlineKey: MASTER }).available, false);
		// selection
		assert.equal(createSecretStore({ env: { WORKROOM_SECRET_STORE: "bogus", WORKROOM_SECRET_KEY: MASTER } }).available, false);
		assert.equal(createSecretStore({ env: { WORKROOM_SECRET_STORE: "vault-transit", WORKROOM_SECRET_KEY: MASTER } }).available, false, "vault selected but unconfigured: no fallback to local");
		assert.equal(createSecretStore({ env: { WORKROOM_SECRET_KEY: MASTER } }).id, "local");
		assert.equal(createSecretStore({ env: {} }).available, false);
		assert.match(createSecretStore({ env: { WORKROOM_SECRET_STORE: "vault-transit", WORKROOM_VAULT_ADDR: "http://vault.example:8200", WORKROOM_VAULT_TRANSIT_KEY: "wr", WORKROOM_VAULT_TOKEN: "t" } }).reason, /https/);
		assert.equal(createSecretStore({ env: { WORKROOM_SECRET_STORE: "vault-transit", WORKROOM_VAULT_ADDR: "https://vault.example:8200", WORKROOM_VAULT_TRANSIT_KEY: "wr", WORKROOM_VAULT_TOKEN: "t" } }).id, "vault-transit");
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
});

test("vault-transit store (against a mock of the documented HTTP API - NOT a real Vault): shapes, AAD binding, errors, no secret in requests' URL", async () => {
	const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
	const vault: typeof fetch = async (input, init) => {
		const body = JSON.parse(String(init?.body));
		calls.push({ url: String(input), headers: init?.headers as Record<string, string>, body });
		const u = String(input);
		if (u.endsWith("/encrypt/wr-key")) return new Response(JSON.stringify({ data: { ciphertext: `vault:v1:${body.plaintext}` } }), { status: 200 });
		if (u.endsWith("/decrypt/wr-key")) return new Response(JSON.stringify({ data: { plaintext: String(body.ciphertext).replace(/^vault:v1:/, "") } }), { status: 200 });
		return new Response("{}", { status: 404 });
	};
	const v = new VaultTransitSecretStore({ addr: "https://vault.example:8200/", token: "hvs.FAKE-TOKEN", key: "wr-key", namespace: "team", fetch: vault });
	const sealed = await v.seal(SECRET, "cred|1");
	assert.match(sealed, /^vt1:vault:v1:/);
	assert.equal(sealed.includes(SECRET), false, "Vault gets base64 of JSON, the sealed form never shows the value");
	assert.equal(await v.open(sealed, "cred|1"), SECRET);
	await assert.rejects(v.open(sealed, "cred|2"), /binding/);
	assert.equal(calls[0]!.url, "https://vault.example:8200/v1/transit/encrypt/wr-key");
	assert.equal(calls[0]!.headers["x-vault-token"], "hvs.FAKE-TOKEN");
	assert.equal(calls[0]!.headers["x-vault-namespace"], "team");
	assert.equal(calls.some((c) => c.url.includes(SECRET)), false);
	const down = new VaultTransitSecretStore({ addr: "https://vault.example", token: "t", key: "wr-key", fetch: async () => new Response("{}", { status: 503 }) });
	await assert.rejects(down.seal(SECRET, "a"), (e: any) => e.code === "vault_error");
	const dead = new VaultTransitSecretStore({ addr: "https://vault.example", token: "t", key: "wr-key", fetch: async () => { throw new Error("ECONNREFUSED"); } });
	await assert.rejects(dead.seal(SECRET, "a"), (e: any) => e.code === "vault_unreachable");
	// a credential sealed by one store is not opened by another
	const { t, alice } = await setup();
	try {
		const { sp, cid } = await newConv(t, alice.token);
		const c = await mkCred(t, alice, sp, cid, { persist: "save" });
		const store = credentialsFor(t.app.ctx);
		store.secretStore = v;
		await assert.rejects(credentialHttp(t.app.ctx, c.actor, { credentialId: c.credentialId, method: "GET", url: url("/ok") }), (e: any) => e.code === "secret_storage_mismatch");
	} finally {
		await t.dispose();
	}
});

test("permissions catalog: the new credential permissions exist; nothing grants plaintext access", () => {
	for (const id of ["credential.manage.project", "credential.manage.org", "credential.use.org"]) assert.ok(PERMISSION_IDS.includes(id), id);
	assert.equal(PERMISSION_IDS.some((p) => /credential\.(read|view|reveal|export)/.test(p)), false);
});
