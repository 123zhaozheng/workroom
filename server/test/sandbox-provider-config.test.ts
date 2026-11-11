// Group S: per-org sandbox provider configuration, selection policy, project overrides, SSRF rules and the connection test.
// The provider factory used for connection tests is a TEST DOUBLE (no vendor is contacted); DNS is a test double too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import type { AppEnv, Principal, Space } from "../src/core/contracts.ts";
import { HttpError } from "../src/core/http.ts";
import { PROVIDER_CONFIG_MIGRATIONS, providerConfigsFor, scrubSecrets, SandboxProviderConfigs } from "../src/tools/sandbox/provider-config.ts";
import { registerSandboxProviderRoutes } from "../src/tools/sandbox/provider-routes.ts";
import type { ProviderConnection, RemoteProvider, RemoteSession } from "../src/tools/sandbox/provider.ts";

const KEY = "sk-live-SUPERSECRETKEY-1234567890abcd";
const SECRET_KEY = "workroom-test-secret-key-0123456789";

const PUBLIC_DNS = async (h: string) => (h === "rebind.example.com" ? [{ address: "10.1.2.3", family: 4 }] : h === "intranet.example.com" ? [{ address: "10.9.9.9", family: 4 }] : [{ address: "93.184.216.34", family: 4 }]);

interface Harness {
	t: TestApp;
	svc: SandboxProviderConfigs;
	owner: { token: string; me: any };
	member: { token: string; me: any };
	other: { token: string; me: any };
	p: (u: { me: any }) => Promise<Principal>;
	call(u: { me: any }, method: string, path: string, json?: unknown): Promise<{ status: number; body: any; text: string }>;
}

async function harness(config: Record<string, unknown> = { secretKey: SECRET_KEY }): Promise<Harness> {
	const t = await startTestApp({ config });
	const owner = await t.user("own@s.example");
	const inv = await t.json("POST", "/api/admin/invites", { token: owner.token, json: { role: "member" } });
	const member = await t.user("mem@s.example", { inviteCode: inv.invite.code });
	const other = await t.user("oth@o.example");
	const ctx = t.app.ctx;
	// Until the integrator wires PROVIDER_CONFIG_MIGRATIONS into toolsModule (offset 900) the tables are created here.
	if (!ctx.db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'tool_sandbox_providers'")) ctx.db.migrate("tools-s-test", PROVIDER_CONFIG_MIGRATIONS);
	const svc = providerConfigsFor(ctx);
	svc.resolver = PUBLIC_DNS;
	const p = async (u: { me: any }) => (await ctx.services.get("identity").principalFor(u.me.userId, u.me.orgId))!;
	// Mini app mirroring the real error mapping; principal chosen by header (the group's routes are wired by the integrator).
	const hono = new Hono<AppEnv>();
	hono.onError((err, c) => (err instanceof HttpError ? c.json({ error: { code: err.code, message: err.message } }, err.status as 400) : c.json({ error: { code: "internal", message: String(err) } }, 500)));
	hono.use("*", async (c, next) => {
		const [uid, oid] = c.req.header("x-who")!.split("|");
		c.set("principal", (await ctx.services.get("identity").principalFor(uid!, oid!))!);
		await next();
	});
	const api = new Hono<AppEnv>();
	registerSandboxProviderRoutes(api, ctx);
	hono.route("/api", api);
	const call: Harness["call"] = async (u, method, path, json) => {
		const res = await hono.fetch(new Request(`http://x${path}`, { method, headers: { "x-who": `${u.me.userId}|${u.me.orgId}`, "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) }));
		const text = await res.text();
		return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
	};
	return { t, svc, owner, member, other, p, call };
}

const withAllowlist = async (value: string, fn: () => Promise<void>) => {
	const prev = process.env.WORKROOM_WEBHOOK_ALLOWLIST;
	process.env.WORKROOM_WEBHOOK_ALLOWLIST = value;
	try {
		await fn();
	} finally {
		if (prev === undefined) delete process.env.WORKROOM_WEBHOOK_ALLOWLIST;
		else process.env.WORKROOM_WEBHOOK_ALLOWLIST = prev;
	}
};

test("permissions: member 403, admin ok, other org isolated; key never returned, audited or stored in plaintext", async () => {
	const h = await harness();
	try {
		assert.equal((await h.call(h.member, "GET", "/api/sandbox/providers")).status, 403);
		assert.equal((await h.call(h.member, "PUT", "/api/sandbox/providers/e2b", { template: "x" })).status, 403);
		assert.equal((await h.call(h.member, "POST", "/api/sandbox/providers/e2b/test", { kind: "health" })).status, 403);
		assert.equal((await h.call(h.member, "PUT", "/api/sandbox/provider-policy", { orgDefault: "local" })).status, 403);
		assert.equal((await h.call(h.member, "GET", "/api/sandbox/instances")).status, 403);
		assert.equal((await h.call(h.member, "GET", "/api/sandbox/provider-policy")).status, 403);
		assert.equal((await h.call(h.owner, "GET", "/api/sandbox/provider-policy")).status, 200);
		const put = await h.call(h.owner, "PUT", "/api/sandbox/providers/e2b", { apiKey: KEY, egressAcknowledged: true, enabled: true, template: "base" });
		assert.equal(put.status, 200, put.text);
		assert.equal(put.body.provider.apiKeySet, true);
		assert.equal(put.body.provider.apiKeyHint, KEY.slice(-4));
		const list = await h.call(h.owner, "GET", "/api/sandbox/providers");
		assert.equal(list.status, 200);
		assert.equal(list.body.canManage, true);
		assert.equal(list.body.secretStorage, true);
		assert.equal(list.body.providers.length, 3);
		for (const out of [put.text, list.text]) assert.ok(!out.includes(KEY) && !out.includes("SUPERSECRET"), "key never in API JSON");
		const db = h.t.app.ctx.db;
		const audits = JSON.stringify(db.all("SELECT * FROM id_audit"));
		assert.ok(!audits.includes("SUPERSECRET"), "key never in audit rows");
		assert.match(audits, /sandbox\.provider\.update/);
		assert.match(audits, /\\"apiKey\\":\\"set\\"/);
		const raw = JSON.stringify(db.all("SELECT * FROM tool_sandbox_providers"));
		assert.ok(!raw.includes("SUPERSECRET") && /v1:/.test(raw), "stored sealed, not plaintext");
		// Decryption is bound to org+provider (AAD): the connection round-trips for the right org only.
		const c = await h.svc.connection(h.owner.me.orgId, "e2b");
		assert.equal(c?.apiKey, KEY);
		assert.equal(await h.svc.connection(h.other.me.orgId, "e2b"), null);
		// Other org cannot see or modify this org's config.
		assert.equal((await h.call(h.other, "GET", "/api/sandbox/providers")).body.providers.find((x: any) => x.provider === "e2b").apiKeySet, false);
		// key cleared
		const clr = await h.call(h.owner, "PUT", "/api/sandbox/providers/e2b", { apiKey: null, enabled: false });
		assert.equal(clr.body.provider.apiKeySet, false);
		assert.equal(clr.body.provider.apiKeyHint, undefined);
		assert.match(JSON.stringify(db.all("SELECT detail FROM id_audit")), /cleared/);
		assert.equal((await h.call(h.owner, "PUT", "/api/sandbox/providers/nope", {})).status, 404);
	} finally {
		await h.t.dispose();
	}
});

test("sealing requires WORKROOM_SECRET_KEY: a key is refused, nothing stored", async () => {
	const h = await harness({});
	try {
		assert.equal((await h.call(h.owner, "GET", "/api/sandbox/providers")).body.secretStorage, false);
		const r = await h.call(h.owner, "PUT", "/api/sandbox/providers/daytona", { apiKey: KEY });
		assert.equal(r.status, 400);
		assert.equal(r.body.error.code, "secret_storage_unavailable");
		assert.ok(!r.text.includes("SUPERSECRET"));
		assert.equal(h.t.app.ctx.db.all("SELECT * FROM tool_sandbox_providers").length, 0);
		// Non-secret settings still work.
		assert.equal((await h.call(h.owner, "PUT", "/api/sandbox/providers/daytona", { template: "py311" })).status, 200);
	} finally {
		await h.t.dispose();
	}
});

test("SSRF: loopback, private, link-local/metadata, IPv6, mapped, rebinding names and plain http are refused; private needs flag AND instance allowlist", async () => {
	const h = await harness();
	try {
		const refuse = async (url: string, allowPrivate = false) => assert.rejects(h.svc.checkEndpoint(h.owner.me.orgId, url, allowPrivate), (e: any) => e instanceof HttpError && e.status === 400, url);
		for (const u of ["https://127.0.0.1", "https://10.0.0.5:8080", "https://192.168.1.2", "https://172.16.4.4", "https://169.254.169.254/latest", "https://[::1]", "https://[::ffff:127.0.0.1]", "https://[::ffff:7f00:1]", "https://[fe80::1]", "https://[fd00::1]", "https://localhost", "https://rebind.example.com", "https://metadata.google.internal"]) await refuse(u);
		await refuse("http://api.example.com"); // http on a public host
		await refuse("ftp://api.example.com");
		await refuse("https://user:pw@api.example.com");
		await refuse("not a url");
		// Flag alone is not enough (operator did not allowlist) ...
		await withAllowlist("", async () => {
			await refuse("https://10.0.0.5", true);
			await refuse("http://intranet.example.com", true);
			await refuse("https://169.254.169.254", true);
		});
		// ... instance allowlist alone is not enough (org admin did not set the flag) ...
		await withAllowlist("10.0.0.5,intranet.example.com", async () => {
			await refuse("https://10.0.0.5", false);
			await refuse("https://intranet.example.com", false);
			// ... both together: allowed (https and http, since the target is private + allowlisted). Metadata stays blocked.
			assert.equal(await h.svc.checkEndpoint(h.owner.me.orgId, "https://10.0.0.5:8443/", true), "https://10.0.0.5:8443");
			assert.equal(await h.svc.checkEndpoint(h.owner.me.orgId, "http://intranet.example.com:8080", true), "http://intranet.example.com:8080");
			await refuse("https://10.0.0.6", true); // other private address not allowlisted
			await refuse("https://169.254.169.254", true);
		});
		// Public https is fine without any flag.
		assert.equal(await h.svc.checkEndpoint(h.owner.me.orgId, "https://api.example.com/v1/", false), "https://api.example.com/v1");
		// Through the API: save refuses and stores nothing.
		const r = await h.call(h.owner, "PUT", "/api/sandbox/providers/opensandbox", { endpoint: "http://127.0.0.1:8080", apiKey: KEY });
		assert.equal(r.status, 400);
		// An allowlisted private OpenSandbox can be saved and enabled without the vendor egress acknowledgement.
		await withAllowlist("10.0.0.5", async () => {
			const ok = await h.call(h.owner, "PUT", "/api/sandbox/providers/opensandbox", { endpoint: "https://10.0.0.5:8080", allowPrivateNetwork: true, apiKey: KEY, enabled: true });
			assert.equal(ok.status, 200, ok.text);
			assert.equal(ok.body.provider.allowPrivateNetwork, true);
			// Allowlist removed later → construction is refused (re-validated at every use).
		});
		await withAllowlist("", async () => {
			await assert.rejects(h.svc.connection(h.owner.me.orgId, "opensandbox"), /内网|允许列表|blocked/);
		});
	} finally {
		await h.t.dispose();
	}
});

test("validation: ranges, template charset, required fields, egress acknowledgement", async () => {
	const h = await harness();
	try {
		const put = (prov: string, body: unknown) => h.call(h.owner, "PUT", `/api/sandbox/providers/${prov}`, body);
		for (const bad of [{ createTimeoutSec: 9 }, { createTimeoutSec: 601 }, { idleTimeoutSec: 59 }, { idleTimeoutSec: 86401 }, { lifetimeSec: 299 }, { lifetimeSec: 604801 }, { createTimeoutSec: 30.5 }, { createTimeoutSec: "30" }, { idleTimeoutSec: 7200, lifetimeSec: 3600 }, { template: "bad template!" }, { template: "x".repeat(200) }, { domain: "https://x.com/y" }, { apiKey: "short" }, { apiKey: "has space inside key" }, { enabled: "yes" }]) assert.equal((await put("e2b", bad)).status, 400, JSON.stringify(bad));
		assert.equal((await put("e2b", { createTimeoutSec: 10, idleTimeoutSec: 60, lifetimeSec: 300 })).status, 200);
		assert.equal((await put("e2b", { createTimeoutSec: 600, idleTimeoutSec: 86400, lifetimeSec: 604800 })).status, 200);
		assert.deepEqual(h.svc.lifecycle(h.owner.me.orgId, "e2b"), { createTimeoutSec: 600, idleTimeoutSec: 86400, lifetimeSec: 604800 });
		// Enabling: key required, egress ack required for vendor cloud, endpoint required for opensandbox.
		assert.equal((await put("daytona", { enabled: true })).body.error.code, "missing_field");
		assert.equal((await put("daytona", { apiKey: KEY, enabled: true })).body.error.code, "egress_ack_required");
		assert.equal((await put("daytona", { apiKey: KEY, egressAcknowledged: true, enabled: true })).status, 200);
		assert.equal((await put("opensandbox", { apiKey: KEY, enabled: true, egressAcknowledged: true })).body.error.code, "missing_field");
		assert.equal((await put("opensandbox", { endpoint: "https://os.example.com", apiKey: KEY, enabled: true, egressAcknowledged: true })).status, 200);
		// Failed update changed nothing.
		assert.equal(h.svc.dto(h.owner.me, "e2b").enabled, false);
	} finally {
		await h.t.dispose();
	}
});

test("selection policy, project override and effectiveFor matrix", async () => {
	const h = await harness();
	try {
		const orgId = h.owner.me.orgId;
		const proj = await h.t.json("POST", "/api/projects", { token: h.member.token, json: { kind: "space", name: "mgr-proj" } }); // member creates → project owner
		const projectId = proj.project.id as string;
		const personal = h.t.app.ctx.services.get("identity").personalSpace(h.member.me.userId, orgId) as Space;
		const pspace = h.t.app.ctx.services.get("identity").projectSpace(projectId) as Space;
		const put = (prov: string, body: unknown) => h.call(h.owner, "PUT", `/api/sandbox/providers/${prov}`, body);
		await put("e2b", { apiKey: KEY, egressAcknowledged: true, enabled: true });
		await put("daytona", { apiKey: KEY, egressAcknowledged: true, enabled: true });
		// Defaults: local everywhere.
		assert.deepEqual(h.svc.effectiveFor(personal), { kind: "local" });
		assert.deepEqual(h.svc.effectiveFor(pspace), { kind: "local" });
		// GET: project members read their choice; options never include secrets; non-members cannot.
		const g0 = await h.call(h.member, "GET", `/api/projects/${projectId}/sandbox-provider`);
		assert.equal(g0.status, 200, g0.text);
		assert.equal(g0.body.provider, null);
		assert.equal(g0.body.allowed, false);
		assert.deepEqual(g0.body.options.map((o: any) => [o.id, o.enabled]), [["opensandbox", false], ["e2b", true], ["daytona", true]]);
		assert.ok(!g0.text.includes("SUPERSECRET"));
		assert.equal((await h.call(h.other, "GET", `/api/projects/${projectId}/sandbox-provider`)).status, 404);
		// Project manager cannot override while the org forbids it.
		assert.equal((await h.call(h.member, "PUT", `/api/projects/${projectId}/sandbox-provider`, { provider: "e2b" })).status, 403);
		// Non-manager of the project (other user in another org / member without the project) cannot.
		assert.equal((await h.call(h.other, "PUT", `/api/projects/${projectId}/sandbox-provider`, { provider: "e2b" })).status, 404);
		// Org default must be enabled.
		assert.equal((await h.call(h.owner, "PUT", "/api/sandbox/provider-policy", { orgDefault: "opensandbox" })).status, 409);
		assert.equal((await h.call(h.owner, "PUT", "/api/sandbox/provider-policy", { orgDefault: "bogus" })).status, 400);
		const pol = await h.call(h.owner, "PUT", "/api/sandbox/provider-policy", { orgDefault: "e2b", allowProjectOverride: true });
		assert.deepEqual(pol.body.policy, { orgDefault: "e2b", allowProjectOverride: true });
		assert.deepEqual(h.svc.effectiveFor(personal), { kind: "provider", provider: "e2b", orgId });
		assert.deepEqual(h.svc.effectiveFor(pspace), { kind: "provider", provider: "e2b", orgId });
		// Org member who is not a project manager cannot; the manager can, only for an enabled provider.
		const inv = await h.t.json("POST", "/api/admin/invites", { token: h.owner.token, json: { role: "member" } });
		const rando = await h.t.user("rando@s.example", { inviteCode: inv.invite.code });
		assert.equal((await h.call(rando, "PUT", `/api/projects/${projectId}/sandbox-provider`, { provider: "daytona" })).status, 403);
		assert.equal((await h.call(h.member, "PUT", `/api/projects/${projectId}/sandbox-provider`, { provider: "opensandbox" })).status, 409);
		assert.equal((await h.call(h.member, "PUT", `/api/projects/${projectId}/sandbox-provider`, { provider: "nonsense" })).status, 400);
		assert.equal((await h.call(h.member, "PUT", `/api/projects/${projectId}/sandbox-provider`, { provider: "daytona" })).status, 200);
		assert.deepEqual(h.svc.effectiveFor(pspace), { kind: "provider", provider: "daytona", orgId });
		assert.deepEqual(h.svc.effectiveFor(personal), { kind: "provider", provider: "e2b", orgId }, "personal spaces always use the org default");
		assert.equal((await h.call(h.member, "PUT", `/api/projects/${projectId}/sandbox-provider`, { provider: "local" })).status, 200);
		assert.deepEqual(h.svc.effectiveFor(pspace), { kind: "local" });
		// Org turns overrides off: stored override is ignored → org default.
		await h.call(h.owner, "PUT", "/api/sandbox/provider-policy", { allowProjectOverride: false });
		assert.deepEqual(h.svc.effectiveFor(pspace), { kind: "provider", provider: "e2b", orgId });
		// No silent fallback: disabling the chosen provider keeps it chosen, and explain() says why.
		assert.equal(h.svc.explain(personal), "");
		await put("e2b", { enabled: false });
		assert.deepEqual(h.svc.effectiveFor(personal), { kind: "provider", provider: "e2b", orgId });
		assert.match(h.svc.explain(personal), /停用.*不会回退到本机/);
		// Clearing an override (null) by the manager works.
		assert.equal((await h.call(h.member, "PUT", `/api/projects/${projectId}/sandbox-provider`, { provider: null })).status, 200);
	} finally {
		await h.t.dispose();
	}
});

/** TEST DOUBLE of RemoteProvider: records calls; behaviour switchable. */
function fakeProvider(opts: { failExec?: boolean; failHealth?: boolean; leakKeyInError?: string; badFile?: boolean } = {}) {
	const log: string[] = [];
	const files = new Map<string, Uint8Array>();
	const session: RemoteSession = {
		id: "sbx-test-1",
		async exec(o) {
			log.push(`exec:${o.command}`);
			if (opts.leakKeyInError) throw new Error(`401 Unauthorized, Authorization: Bearer ${opts.leakKeyInError} rejected`);
			return opts.failExec ? { status: "error", exitCode: 1, stdout: "", stderr: "boom" } : { status: "ok", exitCode: 0, stdout: "workroom-ok\n", stderr: "" };
		},
		async writeFile(path, bytes) {
			log.push(`write:${path}`);
			files.set(path, opts.badFile ? new Uint8Array([1]) : bytes);
		},
		async readFile(path) {
			log.push(`read:${path}`);
			return files.get(path)!;
		},
		async list() {
			return [];
		},
		async remove() {},
		async mkdir() {},
		async keepAlive() {},
	};
	const caps = { exec: "supported", streamOutput: "unverified", cancel: "unverified", commandTimeout: "supported", files: "supported", networkOff: "supported", networkOn: "unverified", resourceLimits: "unsupported", reconnect: "unverified", services: "unsupported", pty: "unsupported", preview: "unsupported", snapshot: "unsupported", pauseResume: "unsupported", skills: "upload_readonly", isolation: "test double", location: "configurable" } as const;
	const provider: RemoteProvider = {
		id: "e2b",
		label: "fake",
		capabilities: caps,
		async health() {
			log.push("health");
			return opts.failHealth ? { ok: false, detail: "unreachable" } : { ok: true, detail: "ok", version: "9.9.9" };
		},
		async create(o) {
			log.push(`create:net=${"network" in o ? "present" : "absent"}:meta=${JSON.stringify(o.metadata)}:life=${o.lifetimeMs}`);
			return session;
		},
		async connect() {
			return null;
		},
		async list() {
			return [];
		},
		async destroy(id) {
			log.push(`destroy:${id}`);
		},
	};
	return { provider, log };
}

test("connection test: health + roundtrip steps, throwaway sandbox always destroyed, errors scrubbed, rate limits", async () => {
	const h = await harness();
	try {
		await h.call(h.owner, "PUT", "/api/sandbox/providers/e2b", { apiKey: KEY, egressAcknowledged: true });
		let seen: ProviderConnection | undefined;
		let fake = fakeProvider();
		h.svc.factory = async (conn) => ((seen = conn), fake.provider);
		const health = await h.call(h.owner, "POST", "/api/sandbox/providers/e2b/test", { kind: "health" });
		assert.equal(health.status, 200, health.text);
		assert.equal(health.body.test.ok, true);
		assert.equal(health.body.test.version, "9.9.9");
		assert.equal(seen?.apiKey, KEY, "factory got the decrypted key");
		assert.deepEqual(fake.log, ["health"]);
		// Roundtrip.
		fake = fakeProvider();
		const rt = (await h.call(h.owner, "POST", "/api/sandbox/providers/e2b/test", { kind: "roundtrip" })).body.test;
		assert.equal(rt.ok, true, JSON.stringify(rt));
		assert.deepEqual(rt.steps.map((s: any) => s.step), ["create", "exec", "file", "destroy"]);
		assert.ok(rt.steps.every((s: any) => s.ok && typeof s.ms === "number"));
		assert.match(fake.log.find((l) => l.startsWith("create"))!, /net=absent.*"workroom":"1".*"purpose":"connection-test"/);
		assert.equal(fake.log.at(-1), "destroy:sbx-test-1");
		// Stored lastTest + capabilities from the provider; key not in them.
		const dto = h.svc.dto(h.owner.me, "e2b");
		assert.equal(dto.lastTest?.ok, true);
		assert.equal(dto.capabilities.exec, "supported");
		assert.ok(!JSON.stringify(dto).includes("SUPERSECRET"));
		// Exec failure → destroy still called, step recorded as failed.
		fake = fakeProvider({ failExec: true });
		const bad = (await h.call(h.owner, "POST", "/api/sandbox/providers/e2b/test", { kind: "roundtrip" })).body.test;
		assert.equal(bad.ok, false);
		assert.ok(fake.log.includes("destroy:sbx-test-1"), "destroy always called");
		assert.equal(bad.steps.find((s: any) => s.step === "exec").ok, false);
		assert.equal(bad.steps.at(-1).step, "destroy");
		// File mismatch.
		fake = fakeProvider({ badFile: true });
		assert.equal((await h.call(h.owner, "POST", "/api/sandbox/providers/e2b/test", { kind: "roundtrip" })).body.test.ok, false);
		assert.ok(fake.log.includes("destroy:sbx-test-1"));
		// Credentials in provider errors are scrubbed from detail and steps, audit and DB.
		fake = fakeProvider({ leakKeyInError: KEY });
		const leak = await h.call(h.owner, "POST", "/api/sandbox/providers/e2b/test", { kind: "roundtrip" });
		assert.ok(!leak.text.includes("SUPERSECRET") && !/Bearer sk-/.test(leak.text), leak.text);
		assert.ok(fake.log.includes("destroy:sbx-test-1"));
		const stored = JSON.stringify(h.t.app.ctx.db.all("SELECT last_test FROM tool_sandbox_providers")) + JSON.stringify(h.t.app.ctx.db.all("SELECT detail FROM id_audit"));
		assert.ok(!stored.includes("SUPERSECRET"));
		// Health failure.
		fake = fakeProvider({ failHealth: true });
		assert.equal((await h.call(h.owner, "POST", "/api/sandbox/providers/e2b/test", { kind: "health" })).body.test.detail, "unreachable");
		// Missing adapter.
		h.svc.factory = async () => {
			throw new HttpError(501, "adapter_missing", "适配器未安装");
		};
		assert.equal((await h.call(h.owner, "POST", "/api/sandbox/providers/e2b/test", { kind: "health" })).body.test.detail, "适配器未安装");
		// Unsaved provider; invalid kind.
		assert.equal((await h.call(h.owner, "POST", "/api/sandbox/providers/daytona/test", { kind: "health" })).body.test.ok, false);
		assert.equal((await h.call(h.owner, "POST", "/api/sandbox/providers/e2b/test", { kind: "weird" })).status, 400);
		// Concurrency: a second test while one runs → 429; per-minute cap.
		let release!: () => void;
		h.svc.factory = async () => {
			await new Promise<void>((r) => (release = r));
			return fakeProvider().provider;
		};
		const first = h.call(h.owner, "POST", "/api/sandbox/providers/e2b/test", { kind: "health" });
		await new Promise((r) => setTimeout(r, 30));
		assert.equal((await h.call(h.owner, "POST", "/api/sandbox/providers/e2b/test", { kind: "health" })).status, 429);
		release();
		assert.equal((await first).status, 200);
		h.svc.factory = async () => fakeProvider().provider;
		let limited = 0;
		for (let i = 0; i < 12; i++) if ((await h.call(h.owner, "POST", "/api/sandbox/providers/e2b/test", { kind: "health" })).status === 429) limited++;
		assert.ok(limited >= 1, "per-minute cap");
	} finally {
		await h.t.dispose();
	}
});

test("scrubSecrets removes the key, bearer tokens and key=value credentials", () => {
	const s = scrubSecrets(`fail Authorization: Bearer abcDEF123456 x-api-key=sk_live_abcdefghijkl1234 and ${KEY} token: "zzzzzzzz"`, KEY);
	assert.ok(!/abcDEF123456|sk_live_abcdef|SUPERSECRET|zzzzzzzz/.test(s), s);
});

test("instances list: empty without the adapter table; org-filtered when present", async () => {
	const h = await harness();
	try {
		assert.deepEqual((await h.call(h.owner, "GET", "/api/sandbox/instances")).body, { instances: [] });
		const db = h.t.app.ctx.db;
		db.run("CREATE TABLE IF NOT EXISTS tool_sandbox_instances (id TEXT PRIMARY KEY, provider TEXT, space_id TEXT, workspace_key TEXT, remote_id TEXT, state TEXT, created_at TEXT, last_used_at TEXT, expires_at TEXT, last_error TEXT)");
		const mine = h.t.app.ctx.services.get("identity").personalSpace(h.owner.me.userId, h.owner.me.orgId) as Space;
		const theirs = h.t.app.ctx.services.get("identity").personalSpace(h.other.me.userId, h.other.me.orgId) as Space;
		// Named columns: the real table (sandbox.ts migration v3) has more columns than this test's fallback CREATE.
		const hasOrg = db.all<{ name: string }>("PRAGMA table_info(tool_sandbox_instances)").some((c) => c.name === "org_id");
		const ins = (id: string, space: Space, key: string, remote: string) =>
			hasOrg
				? db.run("INSERT INTO tool_sandbox_instances (id, provider, space_id, workspace_key, remote_id, state, created_at, last_used_at, org_id) VALUES (?, 'e2b', ?, ?, ?, 'ready', 't', 't', ?)", id, space.id, key, remote, space.orgId)
				: db.run("INSERT INTO tool_sandbox_instances (id, provider, space_id, workspace_key, remote_id, state, created_at, last_used_at) VALUES (?, 'e2b', ?, ?, ?, 'ready', 't', 't')", id, space.id, key, remote);
		ins("i1", mine, "c1", "r1");
		ins("i2", theirs, "c2", "r2");
		const r = (await h.call(h.owner, "GET", "/api/sandbox/instances")).body.instances;
		assert.deepEqual(r.map((x: any) => x.id), ["i1"]);
	} finally {
		await h.t.dispose();
	}
});
