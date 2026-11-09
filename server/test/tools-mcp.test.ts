// MCP connectors against a local fixture MCP server (stdio + streamable HTTP). Real protocol, real processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestApp } from "./helpers/app.ts";
import { orgMember } from "./fixtures/util.ts";
import { answer, call, context, fakeApi, fixedActor, toolHarness } from "./fixtures/tool-harness.ts";
import { MemoryEffects } from "./fixtures/effects.ts";
import { startHttpFixture } from "./fixtures/mcp-fixture-server.ts";
import { createToolSearch, piToolName, type McpManager } from "../src/tools/mcp.ts";
import { summarizeArgs } from "../src/tools/calls.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-fixture-server.ts", import.meta.url));
const CMD = process.execPath;
const ARGS = ["--disable-warning=ExperimentalWarning", FIXTURE];
const SECRET = "sk-fixture-SECRET-0123456789";

function mcpExt(mgr: McpManager) {
	return { name: "wr.mcp", get tools() { return [createToolSearch(mgr, undefined as any), ...mgr.piTools()]; } } as any;
}

test("system stdio connector: encrypted secrets, discovery, status, per-user enablement, call records with redaction, tool_search scoped to the user", async () => {
	process.env.WORKROOM_MCP_STDIO_ALLOW = [CMD, ...ARGS].join(" ");
	const t = await startTestApp({ config: { secretKey: "test-secret-key" } });
	const notes = join(mkdtempSync(join(tmpdir(), "wr-notes-")), "notes.txt");
	try {
		const admin = await t.user("admin@example.com");
		const member = await orgMember(t, admin, "member@example.com");
		const outsider = await t.user("other@example.com");

		// Members cannot add system connectors, nor stdio ones at all; commands outside the allowlist are refused.
		await t.json("POST", "/api/connectors", { token: member.token, json: { name: "x", scope: "system", transport: "http", url: "https://example.com/mcp" }, expect: 403 });
		await t.json("POST", "/api/connectors", { token: member.token, json: { name: "x", scope: "personal", transport: "stdio", command: CMD, args: ARGS }, expect: 403 });
		await t.json("POST", "/api/connectors", { token: admin.token, json: { name: "x", scope: "system", transport: "stdio", command: "/bin/sh", args: ["-c", "id"] }, expect: 403 });

		const { connector } = await t.json("POST", "/api/connectors", { token: admin.token, json: { name: "Fixture Notes", scope: "system", transport: "stdio", command: CMD, args: ARGS, secrets: { FIXTURE_TOKEN: SECRET }, env: { FIXTURE_NOTES: notes } } });
		assert.equal(connector.status, "ready", connector.statusDetail);
		assert.deepEqual(connector.tools.map((x: any) => x.tool).sort(), ["add_note", "echo", "fail", "whoami"]);
		assert.equal(connector.tools.find((x: any) => x.tool === "echo").policy, "read");
		assert.equal(connector.tools.find((x: any) => x.tool === "add_note").policy, "write");
		assert.deepEqual(connector.secretNames, ["FIXTURE_TOKEN"]);
		const echoName = piToolName(connector.handle, "echo");
		assert.equal(connector.tools.find((x: any) => x.tool === "echo").name, echoName);

		// Secret encrypted at rest, never returned.
		const raw = t.app.ctx.db.get<any>("SELECT * FROM mcp_servers WHERE id = ?", connector.id);
		assert.ok(raw.secrets_enc.startsWith("v1:"));
		assert.ok(!JSON.stringify(raw).includes(SECRET));
		const listed = await t.json("GET", "/api/connectors", { token: member.token });
		assert.ok(!JSON.stringify(listed).includes(SECRET));
		assert.equal(listed.secretStorage, "available");
		assert.ok(listed.blocked.length > 0);
		const mine = listed.connectors.find((c: any) => c.id === connector.id);
		assert.equal(mine.access, "allowed");
		assert.equal(mine.enabledForMe, true);
		assert.equal(mine.canManage, false);
		assert.equal(mine.command, undefined);
		await t.json("PATCH", `/api/connectors/${connector.id}`, { token: member.token, json: { enabled: false }, expect: 403 });
		// Other org: invisible and forbidden.
		assert.equal((await t.json("GET", "/api/connectors", { token: outsider.token })).connectors.length, 0);
		await t.json("GET", `/api/connectors/${connector.id}`, { token: outsider.token, expect: 403 });

		// Run through real pi tool tasks as the member: tool_search loads the deferred tool, then echo and whoami run.
		const ctx = t.app.ctx;
		const mgr = ctx.services.get("mcp") as McpManager;
		const memberSpace = ctx.services.get("identity").personalSpace(member.me.userId, member.me.orgId);
		mgr.resolveActor = fixedActor(ctx, member.me.userId, member.me.orgId, memberSpace.id);
		const h = await toolHarness([mcpExt(mgr)], [
			call("tool_search", { query: "echo text back token fails" }, "s1"),
			call(echoName, { text: "你好" }, "e1"),
			call(piToolName(connector.handle, "whoami"), {}, "w1"),
			call(piToolName(connector.handle, "fail"), {}, "f1"),
			answer("ok"),
		]);
		assert.equal((await h.run("use the fixture")).status, "done");
		const results = await h.results();
		assert.equal(results[0]!.name, "tool_search");
		assert.match(results[0]!.text, new RegExp(echoName));
		assert.equal(results[1]!.isError, false);
		assert.match(results[1]!.text, /echo: 你好/);
		assert.match(results[2]!.text, /token=\[REDACTED\]/);
		assert.ok(!results.some((r) => r.text.includes(SECRET)));
		assert.equal(results[3]!.isError, true);
		await h.close();

		const calls = await t.json("GET", `/api/tool-calls?spaceId=${memberSpace.id}`, { token: member.token });
		const echoRec = calls.calls.find((c: any) => c.tool === echoName);
		assert.equal(echoRec.status, "ok");
		assert.equal(echoRec.connectorId, connector.id);
		assert.equal(echoRec.callId, "e1");
		assert.equal(typeof echoRec.taskId, "number");
		assert.equal(typeof echoRec.durationMs, "number");
		assert.match(echoRec.argsSummary, /你好/);
		assert.equal(calls.calls.find((c: any) => c.tool.endsWith("__fail")).status, "error");
		const allRows = JSON.stringify(ctx.db.all("SELECT * FROM tool_calls"));
		assert.ok(!allRows.includes(SECRET), "secret leaked into call records");
		assert.match(summarizeArgs({ apiKey: "abc", nested: { password: "p" }, text: `Bearer ${"x".repeat(20)}` }), /"apiKey":"\[REDACTED\]".*"password":"\[REDACTED\]".*\[REDACTED\]/);
		// Calls listing per connector: the admin sees the member's call.
		const connCalls = await t.json("GET", `/api/connectors/${connector.id}/calls`, { token: admin.token });
		assert.ok(connCalls.calls.some((c: any) => c.callId === "e1"));

		// Per-user enablement is enforced at call time.
		await t.json("PUT", `/api/connectors/${connector.id}/enablement`, { token: member.token, json: { enabled: false } });
		const denied = await mgr.execute(connector.id, "echo", "read", { text: "x" }, fakeApi({ conversationId: 1, taskId: 99, callId: "d1" }), context);
		assert.equal(denied.isError, true);
		assert.match((denied.output as any)[0].text, /关闭/);
		assert.equal(ctx.db.get<any>("SELECT status FROM tool_calls WHERE call_id = 'd1'").status, "denied");
		await t.json("PUT", `/api/connectors/${connector.id}/enablement`, { token: member.token, json: { enabled: true } });

		// Write tool: fails closed without an effects service; with one it asks approval and runs exactly once.
		const noEffects = await mgr.execute(connector.id, "add_note", "write", { text: "n1" }, fakeApi({ conversationId: 1, taskId: 100, callId: "n1" }), context);
		assert.equal(noEffects.isError, true);
		assert.equal(existsSync(notes), false);
		const fx = new MemoryEffects();
		mgr.effectsOverride = fx;
		const w1 = await mgr.execute(connector.id, "add_note", "write", { text: "first" }, fakeApi({ conversationId: 1, taskId: 101, callId: "n2" }), context);
		assert.equal(w1.isError, false, JSON.stringify(w1.output));
		assert.match(fx.approvals[0]!.summary, /add_note/);
		const replay = await mgr.execute(connector.id, "add_note", "write", { text: "first" }, fakeApi({ conversationId: 1, taskId: 101, callId: "n2" }), context);
		assert.match((replay.output as any)[0].text, /saved note #1/);
		assert.equal(readFileSync(notes, "utf8"), "first\n");
		fx.decide = () => "rejected";
		const rej = await mgr.execute(connector.id, "add_note", "write", { text: "nope" }, fakeApi({ conversationId: 1, taskId: 102, callId: "n3" }), context);
		assert.equal(rej.isError, true);
		assert.equal(readFileSync(notes, "utf8"), "first\n");
		fx.decide = () => "approved";
		fx.crashAfterDispatch.add(`mcp:${connector.id}:add_note:n4`);
		await mgr.execute(connector.id, "add_note", "write", { text: "uncertain" }, fakeApi({ conversationId: 1, taskId: 103, callId: "n4" }), context);
		const recon = await mgr.execute(connector.id, "add_note", "write", { text: "uncertain" }, fakeApi({ conversationId: 1, taskId: 103, callId: "n4" }), context);
		assert.equal(recon.isError, true);
		assert.match((recon.output as any)[0].text, /不确定/);
		assert.equal(readFileSync(notes, "utf8"), "first\nuncertain\n"); // not blindly redone
		assert.equal(ctx.db.get<any>("SELECT status FROM tool_calls WHERE call_id = 'n4'").status, "needs_reconciliation");

		// Another org's user: tool_search never offers this org's connector tools; direct calls are denied.
		const outSpace = ctx.services.get("identity").personalSpace(outsider.me.userId, outsider.me.orgId);
		mgr.resolveActor = fixedActor(ctx, outsider.me.userId, outsider.me.orgId, outSpace.id);
		const h2 = await toolHarness([mcpExt(mgr)], [call("tool_search", { query: "echo" }, "s2"), answer("none")]);
		await h2.run("find echo");
		const r2 = await h2.results();
		assert.match(r2[0]!.text, /No matching tools/);
		await h2.close();
		const x = await mgr.execute(connector.id, "echo", "read", { text: "x" }, fakeApi({ conversationId: 1, taskId: 5, callId: "o1" }), context);
		assert.equal(x.isError, true);
		assert.match((x.output as any)[0].text, /other_org/);

		// Admin disables the connector: status disabled, calls denied.
		const dis = await t.json("PATCH", `/api/connectors/${connector.id}`, { token: admin.token, json: { enabled: false } });
		assert.equal(dis.connector.status, "disabled");
		const audit = ctx.db.all<any>("SELECT action FROM id_audit WHERE target = ?", connector.id).map((r) => r.action);
		assert.ok(audit.includes("connector.create") && audit.includes("connector.update"));
	} finally {
		delete process.env.WORKROOM_MCP_STDIO_ALLOW;
		await t.dispose();
	}
});

test("personal HTTP connector: URL policy, unauthorized → reconnect with new secret → ready → needs_reconnect when server goes away", async () => {
	const t = await startTestApp({ config: { secretKey: "k2" } });
	const fx = await startHttpFixture("good-token-123");
	try {
		const u = await t.user("http@example.com");
		const other = await orgMember(t, u, "peer@example.com");
		// Private address blocked for personal connectors unless the operator allowlists it.
		const blocked = await t.json("POST", "/api/connectors", { token: u.token, json: { name: "Local", scope: "personal", transport: "http", url: fx.url, secrets: { Authorization: "Bearer bad-token-1" } } });
		assert.equal(blocked.connector.status, "error");
		assert.match(blocked.connector.statusDetail, /内网/);
		process.env.WORKROOM_URL_ALLOWLIST = new URL(fx.url).host;
		const unauth = await t.json("POST", `/api/connectors/${blocked.connector.id}/check`, { token: u.token });
		assert.equal(unauth.connector.status, "unauthorized");
		assert.ok(!JSON.stringify(unauth).includes("bad-token-1"));
		const fixed = await t.json("PATCH", `/api/connectors/${blocked.connector.id}`, { token: u.token, json: { secrets: { Authorization: "Bearer good-token-123" } } });
		assert.equal(fixed.connector.status, "unchecked");
		const ready = await t.json("POST", `/api/connectors/${blocked.connector.id}/check`, { token: u.token });
		assert.equal(ready.connector.status, "ready");
		assert.equal(ready.connector.tools.length, 4);
		// Personal connector: invisible to a colleague.
		await t.json("GET", `/api/connectors/${blocked.connector.id}`, { token: other.token, expect: 403 });
		assert.equal((await t.json("GET", "/api/connectors", { token: other.token })).connectors.length, 0);
		const mgr = t.app.ctx.services.get("mcp") as McpManager;
		const space = t.app.ctx.services.get("identity").personalSpace(u.me.userId, u.me.orgId);
		mgr.resolveActor = fixedActor(t.app.ctx, u.me.userId, u.me.orgId, space.id);
		const r = await mgr.execute(blocked.connector.id, "whoami", "read", {}, fakeApi({ conversationId: 3, taskId: 1, callId: "h1" }), context);
		assert.equal((r.output as any)[0].text, "token=[REDACTED]");
		assert.ok(!(r.output as any)[0].text.includes("good-token-123"));
		// Server disappears: health check reports needs_reconnect (it was ready before).
		await mgr.disconnect(blocked.connector.id);
		await fx.close();
		const gone = await t.json("POST", `/api/connectors/${blocked.connector.id}/check`, { token: u.token });
		assert.equal(gone.connector.status, "needs_reconnect");
	} finally {
		delete process.env.WORKROOM_URL_ALLOWLIST;
		await fx.close().catch(() => {});
		await t.dispose();
	}
});

test("without WORKROOM_SECRET_KEY secrets are refused (never stored in plaintext)", async () => {
	const t = await startTestApp({ config: { secretKey: undefined } });
	try {
		const u = await t.user("nokey@example.com");
		const r = await t.req("POST", "/api/connectors", { token: u.token, json: { name: "x", scope: "personal", transport: "http", url: "https://example.com/mcp", secrets: { Authorization: "Bearer s" }, check: false } });
		assert.equal(r.status, 400);
		assert.equal((await r.json()).error.code, "secret_storage_unavailable");
		assert.equal(t.app.ctx.db.get<any>("SELECT COUNT(*) AS n FROM mcp_servers").n, 0);
		const ok = await t.json("POST", "/api/connectors", { token: u.token, json: { name: "public", scope: "personal", transport: "http", url: "https://example.com/mcp", check: false } });
		assert.equal(ok.connector.status, "unchecked");
		assert.equal((await t.json("GET", "/api/connectors", { token: u.token })).secretStorage, "unavailable");
	} finally {
		await t.dispose();
	}
});
