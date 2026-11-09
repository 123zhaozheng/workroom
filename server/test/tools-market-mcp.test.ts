// MCP marketplace: server.json import (official registry format), catalog review + publish, install as personal / org connector,
// per-user credentials, personal-MCP approval policy, tool-level enable/disable/ask, secrets never exposed, and stdio servers that
// run only inside the sandbox's service mode (real sandbox: skipped when no driver is available).
import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { orgMember, upload } from "./fixtures/util.ts";
import { answer, call, context, fakeApi, fixedActor, toolHarness } from "./fixtures/tool-harness.ts";
import { MemoryEffects } from "./fixtures/effects.ts";
import { startHttpFixture } from "./fixtures/mcp-fixture-server.ts";
import { createToolSearch, piToolName, type McpManager } from "../src/tools/mcp.ts";
import { parseServerJson } from "../src/tools/mcp-market.ts";
import { probeIsolation } from "../src/tools/sandbox.ts";
import type { Sandbox } from "../src/tools/sandbox.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const TOKEN = "tok-market-SECRET-98765";
const secretFree = (v: unknown) => assert.ok(!JSON.stringify(v).includes(TOKEN), "secret value leaked");

const remoteJson = (url: string, o: { name?: string; version?: string; secretHeader?: boolean } = {}) => ({
	$schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
	name: o.name ?? "io.github.acme/notes",
	description: "笔记服务（测试夹具）：回显文本、报告所用令牌。",
	title: "Acme 笔记",
	version: o.version ?? "1.0.0",
	repository: { url: "https://github.com/acme/notes", source: "github" },
	remotes: [{ type: "streamable-http", url, headers: [{ name: "Authorization", description: "Bearer 令牌", isRequired: true, isSecret: o.secretHeader !== false }] }],
});

async function setup(config: Record<string, unknown> = { secretKey: "market-mcp-key" }) {
	const fx = await startHttpFixture(TOKEN);
	let hits = 0;
	fx.server.on("request", () => hits++);
	process.env.WORKROOM_URL_ALLOWLIST = new URL(fx.url).host;
	const t = await startTestApp({ config });
	const admin = await t.user("mm-admin@example.com");
	const member = await orgMember(t, admin, "mm-member@example.com");
	const other = await orgMember(t, admin, "mm-other@example.com");
	const reviewer = await orgMember(t, admin, "mm-reviewer@example.com");
	await t.json("POST", "/api/admin/role-assignments", { token: admin.token, json: { subject: { kind: "user", id: reviewer.me.userId }, roleId: "builtin:skill_reviewer" } });
	const mgr = t.app.ctx.services.get("mcp") as McpManager;
	const actorFor = (u: { me: any }) => fixedActor(t.app.ctx, u.me.userId, u.me.orgId, t.app.ctx.services.get("identity").personalSpace(u.me.userId, u.me.orgId).id);
	return { t, fx, hits: () => hits, admin, member, other, reviewer, mgr, actorFor, close: async () => { await t.dispose(); await fx.close(); delete process.env.WORKROOM_URL_ALLOWLIST; } };
}
const importJson = (t: TestApp, token: string, serverJson: unknown, expect = 200) => t.json("POST", "/api/market/mcp/import", { token, json: { serverJson }, expect });
async function publishOrg(t: TestApp, owner: { token: string }, reviewer: { token: string }, entryId: string, versionNo = 1) {
	const sub = (await t.json("POST", `/api/market/mcp/${entryId}/versions/${versionNo}/submit`, { token: owner.token, json: { targetScope: "org" } })).submission;
	return (await t.json("POST", `/api/market/submissions/${sub.id}/decision`, { token: reviewer.token, json: { decision: "approve", comment: "ok" } })).submission;
}

test("server.json import validates the official registry format (name namespace, no version ranges, forbidden env, wrapper, versions immutable)", async () => {
	const s = await setup();
	try {
		// Pure parser: registry API wrapper, ranges, namespace rule, forbidden environment variables.
		assert.equal(parseServerJson({ server: remoteJson("https://mcp.example.com/mcp") }).name, "io.github.acme/notes");
		for (const bad of [{ ...remoteJson("https://x.example/mcp"), name: "no-slash" }, { ...remoteJson("https://x.example/mcp"), name: "a/b/c" }, { ...remoteJson("https://x.example/mcp"), version: "^1.2.3" }, { ...remoteJson("https://x.example/mcp"), version: ">=1.0.0" }, { name: "io.github.a/b", description: "d", version: "1.0.0" }, { ...remoteJson("https://x.example/mcp"), description: "" }]) assert.throws(() => parseServerJson(bad), /server\.json|name|version|description|packages/);
		assert.throws(() => parseServerJson({ name: "io.github.a/b", description: "d", version: "1.0.0", packages: [{ registryType: "npm", identifier: "x", transport: { type: "stdio" }, environmentVariables: [{ name: "LD_PRELOAD", value: "/x.so" }] }] }), /不允许设置环境变量/);

		const ok = await importJson(s.t, s.member.token, { server: remoteJson("https://mcp.example.com/mcp") }); // wrapper accepted
		assert.equal(ok.entry.scope, "personal");
		assert.equal(ok.entry.status, "draft");
		assert.equal(ok.entry.options[0].kind, "remote");
		assert.equal(ok.entry.options[0].inputs[0].secret, true);
		assert.ok(ok.checks.findings.some((f: any) => f.code === "secret_header_not_marked") === false);
		// Non-TLS remote is a warning; unmarked secret header is flagged.
		const warn = await importJson(s.t, s.member.token, remoteJson("http://mcp.example.com/mcp", { name: "io.github.acme/plain", secretHeader: false }));
		assert.ok(warn.checks.findings.some((f: any) => f.code === "remote_not_tls"));
		assert.ok(warn.checks.findings.some((f: any) => f.code === "secret_header_not_marked"));
		// Versions are immutable: the same version string cannot be imported twice; same content is a duplicate; a new version is v2.
		const dupVer = await importJson(s.t, s.member.token, { ...remoteJson("https://mcp.example.com/mcp2"), description: "changed" }, 409);
		assert.equal(dupVer.error.code, "version_exists");
		assert.equal((await importJson(s.t, s.member.token, remoteJson("https://mcp.example.com/mcp"), 409)).error.code, "duplicate_content");
		const v2 = await importJson(s.t, s.member.token, remoteJson("https://mcp.example.com/mcp", { version: "1.1.0" }));
		assert.equal(v2.versionNo, 2);
		assert.throws(() => s.t.app.ctx.db.run("UPDATE mcp_catalog_versions SET server_json = '{}'"), /immutable/);
		// Someone else cannot hijack the name.
		assert.equal((await importJson(s.t, s.other.token, remoteJson("https://evil.example/mcp", { version: "9.9.9" }), 409)).error.code, "name_taken");
		// Bad input is a 400 with a clear code.
		assert.equal((await importJson(s.t, s.member.token, { name: "x" }, 400)).error.code, "server_json_invalid");
		// A file in a bundle that contains credentials is rejected at upload.
		const leak = zipSync({ "server.json": enc(JSON.stringify({ name: "io.github.acme/leak", description: "d", version: "1.0.0", packages: [{ registryType: "bundle", identifier: "server.mjs", runtimeHint: "node", transport: { type: "stdio" } }] })), "server.mjs": enc('const k = "AKIAABCDEFGHIJKLMNOP";') });
		const r = await upload(s.t, s.member.token, "/market/mcp/import", "b.zip", leak, {}, "application/zip");
		assert.equal(r.status, 400);
		assert.equal(((await r.json()) as any).error.code, "scan_failed");
	} finally {
		await s.close();
	}
});

test("catalog review → publish → install (personal / org / per-user credentials); secrets are encrypted and never exposed", async () => {
	const s = await setup();
	try {
		const { t, fx, admin, member, other, reviewer, mgr, actorFor } = s;
		const imp = await importJson(t, admin.token, remoteJson(fx.url));
		const id = imp.entry.id;
		// Unpublished entries are invisible; members cannot publish org entries; a member cannot install an unapproved version.
		assert.equal((await t.json("GET", "/api/market/mcp", { token: member.token })).entries.length, 0);
		await t.json("GET", `/api/market/mcp/${id}`, { token: member.token, expect: 403 });
		await t.json("POST", `/api/market/mcp/${id}/install`, { token: member.token, json: { target: "me", optionIndex: 0, secrets: { Authorization: `Bearer ${TOKEN}` } }, expect: 403 });
		const mine = await importJson(t, member.token, remoteJson(fx.url, { name: "io.github.member/own", version: "0.1.0" }));
		await t.json("POST", `/api/market/mcp/${mine.entry.id}/versions/1/submit`, { token: member.token, json: { targetScope: "org" }, expect: 403 });
		// The admin submits; the admin cannot approve their own; the reviewer can.
		const sub = (await t.json("POST", `/api/market/mcp/${id}/versions/1/submit`, { token: admin.token, json: { targetScope: "org", note: "团队共用" } })).submission;
		assert.equal(sub.kind, "mcp_catalog");
		const detail = (await t.json("GET", `/api/market/submissions/${sub.id}`, { token: reviewer.token })).submission;
		assert.equal(detail.mcp.transport, "http");
		assert.deepEqual(detail.mcp.secretNames, ["Authorization"]);
		assert.equal(detail.diff[0].path, "server.json");
		assert.equal((await t.req("POST", `/api/market/submissions/${sub.id}/decision`, { token: admin.token, json: { decision: "approve" } })).status, 403);
		await t.json("POST", `/api/market/submissions/${sub.id}/decision`, { token: member.token, json: { decision: "approve" }, expect: 403 });
		assert.equal((await t.json("POST", `/api/market/submissions/${sub.id}/decision`, { token: reviewer.token, json: { decision: "approve" } })).submission.state, "published");
		const listed = (await t.json("GET", "/api/market/mcp", { token: member.token })).entries;
		assert.deepEqual(listed.map((e: any) => [e.name, e.status, e.transports]), [["io.github.acme/notes", "published", ["http"]]]);

		// Install as a personal connector (free policy): encrypted secret, ready, tools discovered; the API never returns the value.
		const inst = await t.json("POST", `/api/market/mcp/${id}/install`, { token: member.token, json: { target: "me", optionIndex: 0, secrets: { Authorization: `Bearer ${TOKEN}` } } });
		assert.equal(inst.connector.status, "ready", inst.connector.statusDetail);
		assert.equal(inst.connector.scope, "personal");
		assert.equal(inst.connector.market.approvalState, "approved");
		assert.deepEqual(inst.connector.secretNames, ["Authorization"]);
		assert.deepEqual(inst.connector.tools.map((x: any) => x.tool).sort(), ["add_note", "echo", "fail", "whoami"]);
		const raw = t.app.ctx.db.get<any>("SELECT * FROM mcp_servers WHERE id = ?", inst.connector.id);
		assert.ok(raw.secrets_enc.startsWith("v1:"));
		assert.ok(!JSON.stringify(raw).includes(TOKEN));
		// A required secret must be provided for shared credentials.
		await t.json("POST", `/api/market/mcp/${id}/install`, { token: other.token, json: { target: "me", optionIndex: 0 }, expect: 400 });

		// Org install: only the org-connector permission holder, as a system connector with per-user credentials.
		await t.json("POST", `/api/market/mcp/${id}/install`, { token: member.token, json: { target: "org", optionIndex: 0 }, expect: 403 });
		const org = (await t.json("POST", `/api/market/mcp/${id}/install`, { token: admin.token, json: { target: "org", optionIndex: 0, credentialMode: "per_user", name: "团队笔记" } })).connector;
		assert.equal(org.scope, "system");
		assert.equal(org.market.credentialMode, "per_user");
		assert.deepEqual(org.market.requiredSecretNames, ["Authorization"]);
		assert.equal(t.app.ctx.db.get<any>("SELECT secrets_enc FROM mcp_servers WHERE id = ?", org.id).secrets_enc, null, "no shared secret is stored for a per-user connector");
		// Without their own credentials nobody (not even the installer) can use it; the message says what to do.
		mgr.resolveActor = actorFor(member);
		const noCred = await mgr.execute(org.id, "echo", "read", { text: "x" }, fakeApi({ conversationId: 1, taskId: 1, callId: "pc1" }), context);
		assert.equal(noCred.isError, true);
		assert.match((noCred.output as any)[0].text, /需要你自己的凭据/);
		// Each user stores their own; values are encrypted per (connector, user) and only the NAMES come back.
		const mine1 = (await t.json("PUT", `/api/connectors/${org.id}/my-secrets`, { token: member.token, json: { secrets: { Authorization: `Bearer ${TOKEN}` } } })).connector;
		assert.deepEqual(mine1.market.mySecretNames, ["Authorization"]);
		assert.equal(mine1.status, "ready", mine1.statusDetail);
		await t.json("PUT", `/api/connectors/${org.id}/my-secrets`, { token: member.token, json: { secrets: { NotDeclared: "x" } }, expect: 400 });
		const otherView = (await t.json("GET", `/api/connectors/${org.id}`, { token: other.token })).connector;
		assert.deepEqual(otherView.market.mySecretNames, [], "another user sees none of member's credentials");
		const ok = await mgr.execute(org.id, "echo", "read", { text: "你好" }, fakeApi({ conversationId: 1, taskId: 2, callId: "pc2" }), context);
		assert.equal(ok.isError, false, JSON.stringify(ok.output));
		assert.match((ok.output as any)[0].text, /echo: 你好/);
		mgr.resolveActor = actorFor(other);
		assert.match((await mgr.execute(org.id, "echo", "read", { text: "x" }, fakeApi({ conversationId: 1, taskId: 3, callId: "pc3" }), context).then((r) => (r.output as any)[0].text)), /需要你自己的凭据/);
		const rows = t.app.ctx.db.all<any>("SELECT secrets_enc FROM mcp_user_settings WHERE secrets_enc IS NOT NULL");
		assert.equal(rows.length, 1);
		assert.ok(rows[0].secrets_enc.startsWith("v1:") && !rows[0].secrets_enc.includes(TOKEN));
		// Deleting the connector drops everyone's stored credentials.
		await t.json("DELETE", `/api/connectors/${org.id}`, { token: admin.token });
		assert.equal(t.app.ctx.db.all("SELECT 1 FROM mcp_user_settings WHERE secrets_enc IS NOT NULL").length, 0);

		// The secret never appears in any API response, audit row or call record.
		for (const path of ["/api/connectors", `/api/market/mcp/${id}`, "/api/market/mcp", "/api/market/submissions?view=history", "/api/market/submissions?view=mine", `/api/market/submissions/${sub.id}`]) secretFree(await t.json("GET", path, { token: path.includes("view=mine") ? admin.token : path.includes("submissions") ? reviewer.token : admin.token }));
		secretFree(await t.json("GET", "/api/connectors", { token: member.token }));
		secretFree(t.app.ctx.db.all("SELECT * FROM id_audit"));
		secretFree(t.app.ctx.db.all("SELECT * FROM tool_calls"));
		secretFree(t.app.ctx.db.all("SELECT * FROM market_events"));
		secretFree(t.app.ctx.db.all("SELECT * FROM market_submissions"));
		void other;
	} finally {
		await s.close();
	}
});

test("personal MCP approval gate: pending connectors are never contacted; reviewer sees URL and secret names only; approve → connects; reject → unusable", async () => {
	const s = await setup();
	try {
		const { t, fx, hits, admin, member, reviewer, mgr } = s;
		await t.json("PUT", "/api/market/policy", { token: member.token, json: { personalMcp: "approval" }, expect: 403 });
		assert.equal((await t.json("PUT", "/api/market/policy", { token: admin.token, json: { personalMcp: "approval" } })).policy.personalMcp, "approval");
		const before = hits();
		const created = await t.json("POST", "/api/connectors", { token: member.token, json: { name: "我的外部笔记", scope: "personal", transport: "http", url: fx.url, secrets: { Authorization: `Bearer ${TOKEN}` } } });
		const c = created.connector;
		assert.equal(c.market.approvalState, "pending");
		assert.equal(c.status, "unchecked");
		assert.ok(created.submissionId);
		assert.equal(hits(), before, "no request was sent to the unapproved URL");
		// Not usable, not even by its owner; re-checking does not connect either.
		const row = mgr.row(c.id)!;
		const memberP = (await t.app.ctx.services.get("identity").principalFor(member.me.userId, member.me.orgId))!;
		const u = await mgr.usable(memberP, row);
		assert.equal(u.ok, false);
		assert.equal((u as any).reason, "pending_approval");
		await t.json("POST", `/api/connectors/${c.id}/check`, { token: member.token });
		assert.equal(hits(), before);
		// The reviewer sees where it points and which secrets it carries — never the values.
		const queue = (await t.json("GET", "/api/market/submissions?view=queue&kind=mcp", { token: reviewer.token })).submissions;
		assert.deepEqual(queue.map((x: any) => x.kind), ["mcp_connector"]);
		const detail = (await t.json("GET", `/api/market/submissions/${created.submissionId}`, { token: reviewer.token })).submission;
		assert.equal(detail.mcp.url, fx.url);
		assert.deepEqual(detail.mcp.secretNames, ["Authorization"]);
		secretFree(detail);
		await t.json("POST", `/api/market/submissions/${created.submissionId}/decision`, { token: member.token, json: { decision: "approve" }, expect: 403 });
		await t.json("POST", `/api/market/submissions/${created.submissionId}/decision`, { token: reviewer.token, json: { decision: "approve", comment: "内部服务" } });
		for (let i = 0; i < 60 && mgr.row(c.id)!.status !== "ready"; i++) await new Promise((r) => setTimeout(r, 100));
		assert.equal(mgr.row(c.id)!.approval_state, "approved");
		assert.equal(mgr.row(c.id)!.status, "ready", mgr.row(c.id)!.status_detail ?? "");
		assert.ok(hits() > before, "connected after approval");
		// A second connector is rejected: unusable, never contacted.
		const rejected = await t.json("POST", "/api/connectors", { token: member.token, json: { name: "可疑服务", scope: "personal", transport: "http", url: fx.url } });
		const h2 = hits();
		await t.json("POST", `/api/market/submissions/${rejected.submissionId}/decision`, { token: reviewer.token, json: { decision: "reject", comment: "未知来源" } });
		assert.equal(mgr.row(rejected.connector.id)!.approval_state, "rejected");
		assert.equal((await mgr.usable(memberP, mgr.row(rejected.connector.id)!) as any).reason, "rejected");
		assert.equal(hits(), h2);
		// Personal stdio on the host is still forbidden; "disabled" refuses every personal connector.
		await t.json("POST", "/api/connectors", { token: member.token, json: { name: "x", scope: "personal", transport: "stdio", command: "/bin/sh", args: ["-c", "id"] }, expect: 403 });
		await t.json("PUT", "/api/market/policy", { token: admin.token, json: { personalMcp: "disabled" } });
		await t.json("POST", "/api/connectors", { token: member.token, json: { name: "nope", scope: "personal", transport: "http", url: fx.url }, expect: 403 });
		await t.json("PUT", "/api/market/policy", { token: admin.token, json: { personalMcp: "free" } });
		const free = await t.json("POST", "/api/connectors", { token: member.token, json: { name: "free one", scope: "personal", transport: "http", url: fx.url, secrets: { Authorization: `Bearer ${TOKEN}` } } });
		assert.equal(free.connector.status, "ready");
		assert.equal(free.connector.market.approvalState, "approved");
		secretFree([await t.json("GET", "/api/market/submissions?view=mine", { token: member.token }), t.app.ctx.db.all("SELECT * FROM market_events")]);
	} finally {
		await s.close();
	}
});

test("tool-level controls: manager disables a tool (model never sees it); a user can switch a tool off or force confirmation for themselves", async () => {
	const s = await setup();
	try {
		const { t, fx, admin, member, mgr, actorFor } = s;
		const created = (await t.json("POST", "/api/connectors", { token: admin.token, json: { name: "团队笔记", scope: "system", transport: "http", url: fx.url, secrets: { Authorization: `Bearer ${TOKEN}` } } })).connector;
		assert.equal(created.status, "ready");
		const tools = (n: string) => mgr.piTools().some((x) => x.name === piToolName(created.handle, n));
		assert.ok(tools("whoami") && tools("echo"));
		// Manager: policy "disabled" removes the tool from the registry and refuses calls; invalid values are rejected.
		await t.json("PATCH", `/api/connectors/${created.id}`, { token: admin.token, json: { toolPolicies: { whoami: "nonsense" } }, expect: 400 });
		const patched = (await t.json("PATCH", `/api/connectors/${created.id}`, { token: admin.token, json: { toolPolicies: { whoami: "disabled", echo: "write" } } })).connector;
		assert.equal(tools("whoami"), false);
		assert.equal(patched.tools.find((x: any) => x.tool === "whoami").disabled, true);
		assert.equal(patched.tools.find((x: any) => x.tool === "echo").policy, "write");
		mgr.resolveActor = actorFor(member);
		const denied = await mgr.execute(created.id, "whoami", "read", {}, fakeApi({ conversationId: 1, taskId: 1, callId: "t1" }), context);
		assert.equal(denied.isError, true);
		assert.match((denied.output as any)[0].text, /管理员已关闭/);
		// tool_search (through a real tool task) neither lists nor loads the disabled tool.
		await t.json("PATCH", `/api/connectors/${created.id}`, { token: admin.token, json: { toolPolicies: { whoami: "disabled", echo: "read" } } });
		const ext = { name: "wr.mcp", get tools() { return [createToolSearch(mgr, t.app.ctx), ...mgr.piTools()]; } } as any;
		const h = await toolHarness([ext], [call("tool_search", { query: "whoami token echo text" }, "s1"), answer("ok")]);
		await h.run("find");
		const [search] = await h.results();
		assert.match(search!.text, /__echo/);
		assert.doesNotMatch(search!.text, /__whoami/);
		await h.close();

		// A user can only tighten: "disabled" (off for me) and "ask" (always confirm, even for a read tool).
		await t.json("PUT", `/api/connectors/${created.id}/my-tools`, { token: member.token, json: { overrides: { nope: "ask" } }, expect: 400 });
		await t.json("PUT", `/api/connectors/${created.id}/my-tools`, { token: member.token, json: { overrides: { echo: "disabled" } } });
		const offForMe = await mgr.execute(created.id, "echo", "read", { text: "x" }, fakeApi({ conversationId: 1, taskId: 2, callId: "t2" }), context);
		assert.match((offForMe.output as any)[0].text, /你已关闭/);
		const view = (await t.json("GET", `/api/connectors/${created.id}`, { token: member.token })).connector;
		assert.equal(view.tools.find((x: any) => x.tool === "echo").userOverride, "disabled");
		assert.equal((await t.json("GET", `/api/connectors/${created.id}`, { token: admin.token })).connector.tools.find((x: any) => x.tool === "echo").userOverride, undefined, "overrides are per user");
		const fxe = new MemoryEffects();
		mgr.effectsOverride = fxe;
		await t.json("PUT", `/api/connectors/${created.id}/my-tools`, { token: member.token, json: { overrides: { echo: "ask" } } });
		const asked = await mgr.execute(created.id, "echo", "read", { text: "确认我" }, fakeApi({ conversationId: 1, taskId: 3, callId: "t3" }), context);
		assert.equal(asked.isError, false, JSON.stringify(asked.output));
		assert.equal(fxe.approvals.length, 1, "a confirmation was requested although the tool is read-only");
		assert.match(fxe.approvals[0]!.summary, /echo/);
		fxe.decide = () => "rejected";
		const rejected = await mgr.execute(created.id, "echo", "read", { text: "不要" }, fakeApi({ conversationId: 1, taskId: 4, callId: "t4" }), context);
		assert.equal(rejected.isError, true);
		await t.json("PUT", `/api/connectors/${created.id}/my-tools`, { token: member.token, json: { overrides: { echo: null } } });
		fxe.decide = () => "approved";
		fxe.approvals.length = 0;
		assert.equal((await mgr.execute(created.id, "echo", "read", { text: "直接" }, fakeApi({ conversationId: 1, taskId: 5, callId: "t5" }), context)).isError, false);
		assert.equal(fxe.approvals.length, 0, "back to no confirmation");
	} finally {
		await s.close();
	}
});

// ---- stdio MCP servers run inside the sandbox service mode (never on the host) ----
const BUNDLE_SERVER = `// dependency-free MCP stdio server (newline-delimited JSON-RPC) shipped as an offline bundle
import { createInterface } from "node:readline";
import { writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const tools = [
  { name: "echo", description: "Echo text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } },
  { name: "probe", description: "Report the sandbox view of the process.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
];
createInterface({ input: process.stdin }).on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "bundle-echo", version: "1.0.0" } } });
  if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  if (msg.method === "tools/call") {
    const a = msg.params.arguments || {};
    let text;
    if (msg.params.name === "echo") text = "echo: " + a.text;
    else {
      let write = "ok";
      try { writeFileSync(here + "/tamper.txt", "x"); } catch (e) { write = e.code; }
      text = JSON.stringify({ repoVisible: existsSync("/home/user/workroom"), dataDirVisible: existsSync(process.env.WORKROOM_DATA_DIR || "/nonexistent-x"), hostSecretKey: process.env.WORKROOM_SECRET_KEY ?? null, token: process.env.BUNDLE_TOKEN ?? null, write, dir: here });
    }
    return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
  }
});
`;
const bundleZip = () =>
	zipSync({
		"server.json": enc(JSON.stringify({ name: "io.github.acme/bundle-echo", description: "离线打包的 echo MCP 服务器（沙箱内运行）。", version: "1.0.0", repository: { url: "https://github.com/acme/bundle-echo" }, packages: [{ registryType: "bundle", identifier: "server.mjs", runtimeHint: "node", transport: { type: "stdio" }, environmentVariables: [{ name: "BUNDLE_TOKEN", description: "令牌", isRequired: true, isSecret: true }] }] })),
		"server.mjs": enc(BUNDLE_SERVER),
	});

test("stdio MCP: packages need sandbox network (blocked with a reason); an offline bundle runs inside the sandbox service, read-only, isolated from the host", async (tc) => {
	const s = await setup();
	try {
		const { t, admin, member, reviewer, mgr, actorFor } = s;
		const sb = t.app.ctx.services.get("sandbox") as Sandbox;
		const caps = await sb.capabilities();
		const sandboxReady = probeIsolation().ok && caps.state === "ready" && caps.services && caps.mounts;

		// npm / pypi / oci options are described honestly: blocked unless the sandbox may use the network (or unsupported type).
		const pkgs = await importJson(t, admin.token, { name: "io.github.acme/npm-server", description: "npm 包形式的服务器", version: "2.0.0", repository: { url: "https://github.com/acme/x" }, packages: [{ registryType: "npm", identifier: "@acme/mcp-server", version: "2.0.0", transport: { type: "stdio" }, environmentVariables: [{ name: "ACME_TOKEN", isRequired: true, isSecret: true }] }, { registryType: "oci", identifier: "ghcr.io/acme/mcp:2.0.0", transport: { type: "stdio" } }] });
		const opts = pkgs.entry.options;
		assert.match(opts[0].blocked, /联网|沙箱/);
		assert.match(opts[1].blocked, /暂不支持 oci|沙箱/);
		assert.ok(pkgs.checks.findings.some((f: any) => f.code === "needs_network"));
		await publishOrg(t, admin, reviewer, pkgs.entry.id);
		const blocked = await t.json("POST", `/api/market/mcp/${pkgs.entry.id}/install`, { token: member.token, json: { target: "me", optionIndex: 0, secrets: { ACME_TOKEN: "x" } }, expect: 409 });
		assert.equal(blocked.error.code, "option_blocked");
		// Raw stdio from a member is refused (never on the host).
		await t.json("POST", "/api/connectors", { token: member.token, json: { name: "raw", scope: "personal", transport: "stdio", command: process.execPath, args: ["-e", "1"] }, expect: 403 });
		if (!sandboxReady) return tc.diagnostic(`PENDING: sandbox service mode unavailable (${caps.detail}) — the in-sandbox stdio part did not run`);
		tc.diagnostic(`sandbox driver ${caps.driver} (${caps.state}): in-sandbox stdio part runs`);

		// Offline bundle: import (zip) → review the code (files are readable by the reviewer) → publish → install.
		const r = await upload(t, admin.token, "/market/mcp/import", "bundle.zip", bundleZip(), {}, "application/zip");
		assert.equal(r.status, 200, await r.clone().text());
		const entry = ((await r.json()) as any).entry;
		assert.equal(entry.options[0].kind, "package");
		assert.equal(entry.options[0].blocked, undefined, entry.options[0].blocked);
		const sub = (await t.json("POST", `/api/market/mcp/${entry.id}/versions/1/submit`, { token: admin.token, json: { targetScope: "org" } })).submission;
		const sd = (await t.json("GET", `/api/market/submissions/${sub.id}`, { token: reviewer.token })).submission;
		assert.ok(sd.files.some((f: any) => f.path === "server.mjs"));
		assert.match((await t.json("GET", `/api/market/mcp/${entry.id}/versions/1/file?path=server.mjs`, { token: reviewer.token })).file.text, /dependency-free MCP stdio server/);
		await t.json("GET", `/api/market/mcp/${entry.id}/versions/1/file?path=server.mjs`, { token: member.token, expect: 403 });
		await t.json("POST", `/api/market/submissions/${sub.id}/decision`, { token: reviewer.token, json: { decision: "approve" } });
		const inst = await t.json("POST", `/api/market/mcp/${entry.id}/install`, { token: member.token, json: { target: "me", optionIndex: 0, secrets: { BUNDLE_TOKEN: TOKEN } } });
		assert.equal(inst.connector.market.execMode, "sandbox");
		assert.equal(inst.connector.status, "ready", inst.connector.statusDetail);
		assert.deepEqual(inst.connector.tools.map((x: any) => x.tool).sort(), ["echo", "probe"]);
		assert.equal(sb.listServices().filter((x) => x.key.startsWith(`mcp:${inst.connector.id}:`)).length, 1, "the server runs as a sandbox service");
		secretFree(inst);

		mgr.resolveActor = actorFor(member);
		const echo = await mgr.execute(inst.connector.id, "echo", "read", { text: "沙箱里的你好" }, fakeApi({ conversationId: 1, taskId: 1, callId: "b1" }), context);
		assert.equal(echo.isError, false, JSON.stringify(echo.output));
		assert.match((echo.output as any)[0].text, /echo: 沙箱里的你好/);
		const probe = await mgr.execute(inst.connector.id, "probe", "read", {}, fakeApi({ conversationId: 1, taskId: 2, callId: "b2" }), context);
		// The tool output redacts the secret value; read the raw fields from the record instead of the (redacted) text.
		const text = (probe.output as any)[0].text as string;
		assert.ok(!text.includes(TOKEN), "secret value redacted from tool output");
		const info = JSON.parse(text.replace(/\[REDACTED\]/g, "REDACTED"));
		assert.equal(info.repoVisible, false, "the process cannot see the repository: it is not running on the host");
		assert.equal(info.dataDirVisible, false);
		assert.equal(info.hostSecretKey, null, "host environment (WORKROOM_SECRET_KEY) is not inherited");
		assert.equal(info.token, "REDACTED", "the connector's secret is visible to the process only");
		assert.match(info.write, /EROFS|EACCES|EPERM/, "the bundle directory is a read-only mount");
		assert.match(info.dir, /^\/mcp\/io-github-acme-bundle-echo$/);
		// Another user cannot use the member's personal connector.
		mgr.resolveActor = actorFor(s.other);
		assert.equal((await mgr.execute(inst.connector.id, "echo", "read", { text: "x" }, fakeApi({ conversationId: 1, taskId: 3, callId: "b3" }), context)).isError, true);
		// Removing the connector stops its service.
		await t.json("DELETE", `/api/connectors/${inst.connector.id}`, { token: member.token });
		for (let i = 0; i < 40 && sb.listServices().some((x) => x.key.startsWith(`mcp:${inst.connector.id}:`) && x.running); i++) await new Promise((r2) => setTimeout(r2, 100));
		assert.equal(sb.listServices().some((x) => x.key.startsWith(`mcp:${inst.connector.id}:`) && x.running), false);
	} finally {
		await s.close();
	}
});
