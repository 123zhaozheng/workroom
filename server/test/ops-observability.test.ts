// Observability (M18-B / M17-C): correlation-id trace across audit/routes/ledger/runs/notifications, redaction modes,
// large-context failure concentration, and online backup → verify → restore of a live data volume.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { startTestApp } from "./helpers/app.ts";
import { directHarness, fauxModel } from "../src/ops/testing.ts";
import { captureLogs, redactText, redactValue } from "../src/ops/log.ts";
import { backupDataDir, restoreBackup, verifyBackup } from "../src/ops/backup.ts";
import type { AutomationService } from "../src/ops/automation.ts";
import type { UsageService } from "../src/ops/usage.ts";
import { waitFor } from "../src/runtime/testing.ts";

process.env.WORKROOM_AUTOMATION_TICK_MS = "0";
const SECRET = "test-secret-key-for-observability-0123456789";

test("redaction: standard masks credentials, strict also drops content and emails, off is verbatim", () => {
	const s = "Authorization: Bearer abcdefghijklmnop api_key=sk-ant-api03-ZZZZZZZZZZZZ mail bob@corp.example https://x.example/cb?code=123";
	const std = redactText(s, "standard");
	assert.ok(!std.includes("abcdefghijklmnop") && !std.includes("ZZZZZZZZ"), std);
	assert.ok(std.includes("bob@corp.example"));
	const strict = redactText(s, "strict");
	assert.ok(!strict.includes("bob@corp.example") && !strict.includes("code=123"), strict);
	assert.equal(redactText(s, "off"), s);
	assert.deepEqual(redactValue({ apiKey: "x", prompt: "秘密内容", n: 1 }, "strict"), { apiKey: "***", prompt: "<4 chars>", n: 1 });
	assert.deepEqual(redactValue({ prompt: "ok", password: "p" }, "standard"), { prompt: "ok", password: "***" });
});

test("large-context failures are located by model, route and stage; logs carry correlation ids without secrets", async () => {
	const t = await startTestApp({ config: { secretKey: SECRET } });
	try {
		const a = await t.user("admin@a.example");
		const spaceId = (await t.json("GET", "/api/me", { token: a.token })).personalSpaceId;
		const good = await fauxModel(t, a.token, [{ name: "good", responses: [fauxAssistantMessage("ok"), fauxAssistantMessage("ok2")] }], { label: "Good" });
		const bad = await fauxModel(t, a.token, [{ name: "bad", responses: [fauxAssistantMessage([], { stopReason: "error", errorMessage: "500 internal error (key sk-ant-api03-SHOULDNOTLEAK)" })] }], { label: "Bad" });
		const logs = captureLogs(true);
		const { harness, close } = await directHarness(t, spaceId);
		try {
			const c1 = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "workroom", modelId: good.pm.id } } }, ctx);
			await (await c1.submit({ type: "input", content: "x".repeat(400), requestId: "g1" }, ctx)).wait(ctx);
			await (await c1.submit({ type: "input", content: "small", requestId: "g2" }, ctx)).wait(ctx);
			const c2 = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "workroom", modelId: bad.pm.id } } }, ctx);
			await (await c2.submit({ type: "input", content: "y".repeat(400), requestId: "b1" }, ctx)).wait(ctx);
			const usage = t.app.ctx.services.get("usage") as UsageService;
			await usage.importConversation(spaceId, c1.id as any, harness);
			await usage.importConversation(spaceId, c2.id as any, harness);
		} finally {
			await close();
			captureLogs(false);
		}
		const st = await t.json("GET", "/api/stats?scope=org&largeContextTokens=60", { token: a.token });
		// "small" still carries the 400-char history → 3 large requests, 1 failed.
		assert.equal(st.largeContext.requests, 3, JSON.stringify(st.largeContext));
		assert.equal(st.largeContext.failed, 1);
		assert.equal(st.largeContext.failureRate, 1 / 3);
		assert.deepEqual(st.largeContext.byErrorClass, { server: 1 });
		assert.deepEqual(st.largeContext.byModel[0], { key: bad.pm.id, requests: 1, failed: 1, failureRate: 1 });
		assert.deepEqual(st.largeContext.byRoute[0], { key: "up-bad/bad-model", requests: 1, failed: 1, failureRate: 1 });
		assert.deepEqual(st.largeContext.byModel[1], { key: good.pm.id, requests: 2, failed: 0, failureRate: 0 });
		assert.equal(st.largeContext.byStage[0].key, "first_turn");
		assert.equal(st.errorClasses.server, 1);
		assert.equal(st.latency.count, 3);
		assert.equal(st.latency.buckets.reduce((s: number, b: any) => s + b.count, 0), 3);
		const warn = logs.map((l) => JSON.parse(l)).find((l) => l.event === "model.route_attempt" && l.status === "error");
		assert.ok(warn?.requestKey && warn.routeAttemptId && warn.conversationId, JSON.stringify(warn));
		assert.ok(!logs.join("\n").includes("SHOULDNOTLEAK"));
		const row = t.app.ctx.db.get<any>("SELECT error_message FROM usage_ledger WHERE outcome = 'failed' AND kind = 'model_request'");
		assert.ok(!row.error_message.includes("SHOULDNOTLEAK"));
	} finally {
		await t.dispose();
	}
});

test("trace by correlation id joins audit, automation run, route attempts, ledger and notifications; tenant-scoped", async (tt) => {
	const t = await startTestApp({ config: { secretKey: SECRET } });
	try {
		if (!t.app.ctx.services.has("runtime")) return tt.skip("runtime module not loaded");
		const a = await t.user("admin@a.example");
		const { automation } = await t.json("POST", "/api/automations", { token: a.token, json: { name: "追踪", prompt: "[[reply traced]]", trigger: { kind: "manual" }, timezone: "UTC" } });
		const res = await t.req("POST", `/api/automations/${automation.id}/run`, { token: a.token, headers: { "x-request-id": "req_trace_1" } });
		const { runId } = await res.json();
		await (t.app.ctx.services.get("automation") as AutomationService).idle();
		const tr = await t.json("GET", `/api/admin/trace?q=${runId}`, { token: a.token });
		assert.equal(tr.automationRuns.length, 1);
		assert.equal(tr.automationRuns[0].status, "succeeded");
		assert.ok(tr.audit.some((x: any) => x.action === "automation.run_manual" && x.requestId === "req_trace_1"));
		assert.ok(tr.routeAttempts.length >= 1 && tr.routeAttempts.every((x: any) => x.conversationId === tr.automationRuns[0].conversationId));
		assert.equal(tr.routeAttempts[0].platformModelId, "workroom-fixture");
		assert.ok(tr.ledger.some((x: any) => x.kind === "model_request" && x.fixture === true && x.cost === 0));
		assert.equal(tr.notifications.length, 1);
		const byConv = await t.json("GET", `/api/admin/trace?q=${tr.automationRuns[0].spaceId}:${tr.automationRuns[0].conversationId}`, { token: a.token });
		assert.equal(byConv.automationRuns[0].id, runId);
		const byReq = await t.json("GET", "/api/admin/trace?q=req_trace_1", { token: a.token });
		assert.equal(byReq.audit.length, 1);
		const b = await t.user("b@b.example");
		const other = await t.json("GET", `/api/admin/trace?q=${runId}`, { token: b.token });
		assert.deepEqual([other.automationRuns.length, other.routeAttempts.length, other.ledger.length, other.audit.length, other.notifications.length], [0, 0, 0, 0, 0]);
		await t.json("GET", `/api/admin/trace?q=${runId}`, { token: (await t.user("m@b.example")).token, expect: 200 }); // own (empty) org: fine
	} finally {
		await t.dispose();
	}
});

test("online backup of a live data volume → verify → restore into an empty dir → server starts with the same data", async (tt) => {
	const t = await startTestApp({ config: { secretKey: SECRET } });
	const out = mkdtempSync(join(tmpdir(), "wr-backup-"));
	const restored = mkdtempSync(join(tmpdir(), "wr-restore-"));
	try {
		if (!t.app.ctx.services.has("runtime")) return tt.skip("runtime module not loaded");
		const a = await t.user("a@a.example");
		const { project } = await t.json("POST", "/api/projects", { token: a.token, json: { name: "备份项目" } });
		const { conversation } = await t.json("POST", "/api/conversations", { token: a.token, json: { projectId: project.id, title: "备份会话" } });
		const sent = await t.json("POST", `/api/conversations/${conversation.spaceId}/${conversation.conversationId}/messages`, { token: a.token, json: { text: "[[reply 备份前的回答]]", requestId: "bk1" } });
		await waitFor(async () => (await t.json("GET", `/api/conversations/${conversation.spaceId}/${conversation.conversationId}/submissions/${sent.submissionId}`, { token: a.token })).status === "done");
		const blob = t.app.ctx.blobs.put(new TextEncoder().encode("blob-content"));
		const dest = join(out, "b1");
		const manifest = await backupDataDir(t.dataDir, dest); // server still running
		assert.ok(manifest.files.some((f) => f.kind === "app"));
		assert.ok(manifest.files.some((f) => f.kind === "durable"));
		assert.ok(manifest.files.some((f) => f.kind === "blob" && f.sha256 === blob.sha256));
		assert.ok(manifest.migrations.some((m) => m.module === "ops"));
		assert.deepEqual(verifyBackup(dest), { ok: true, problems: [], checked: manifest.files.length });
		// Tampering is detected.
		const tampered = join(out, "b2");
		await backupDataDir(t.dataDir, tampered);
		writeFileSync(join(tampered, manifest.files.find((f) => f.kind === "blob")!.path), "evil");
		assert.equal(verifyBackup(tampered).ok, false);
		assert.throws(() => restoreBackup(tampered, join(restored, "x")), /verification/);
		// Writes after the backup are not in it.
		await t.json("POST", "/api/projects", { token: a.token, json: { name: "备份之后" } });
		await t.stop();
		const target = join(restored, "data");
		restoreBackup(dest, target);
		assert.throws(() => restoreBackup(dest, target), /not empty/);
		const t2 = await startTestApp({ dataDir: target, config: { secretKey: SECRET } });
		try {
			const login = await t2.json("POST", "/api/auth/login", { json: { email: "a@a.example", password: "password123" } });
			const projects = await t2.json("GET", "/api/projects", { token: login.token });
			assert.deepEqual(projects.projects.map((p: any) => p.name), ["备份项目"]);
			const entries = await t2.json("GET", `/api/conversations/${conversation.spaceId}/${conversation.conversationId}/entries`, { token: login.token });
			assert.ok(JSON.stringify(entries).includes("备份前的回答"));
			assert.equal(new TextDecoder().decode(t2.app.ctx.blobs.get(blob.sha256)!), "blob-content");
		} finally {
			await t2.stop();
		}
	} finally {
		await t.dispose();
		rmSync(out, { recursive: true, force: true });
		rmSync(restored, { recursive: true, force: true });
	}
});

test("trace merges other modules' events (D tool calls, contributed retrieval events) by conversation/task, redacted and tenant-scoped", async (tt) => {
	const t = await startTestApp({ config: { secretKey: SECRET } });
	try {
		if (!t.app.ctx.services.has("runtime")) return tt.skip("runtime module not loaded");
		const a = await t.user("admin@a.example");
		const { conversation } = await t.json("POST", "/api/conversations", { token: a.token, json: {} });
		const base = `/api/conversations/${conversation.spaceId}/${conversation.conversationId}`;
		const sent = await t.json("POST", `${base}/messages`, { token: a.token, json: { text: `[[call file_create {"name":"report","format":"md","content":"# 报告 api_key=sk-ant-api03-SECRETSECRET1234"}]]`, requestId: "tr1" } });
		await waitFor(async () => ["done", "unanswered"].includes((await t.json("GET", `${base}/submissions/${sent.submissionId}`, { token: a.token })).status));
		// A real kb_search through C (C records the retrieval event; E merges it by conversation).
		const ks = await t.json("POST", `${base}/messages`, { token: a.token, json: { text: `[[call kb_search {"query":"季度报告 password=hunter2hunter2"}]]`, requestId: "tr2" } });
		await waitFor(async () => ["done", "unanswered"].includes((await t.json("GET", `${base}/submissions/${ks.submissionId}`, { token: a.token })).status));
		// A contributed source (shape C's retrieval lookup will use): receives the tenant + correlation keys.
		const seen: any[] = [];
		(t.app.ctx.services.get("trace") as any).register("retrieval-test", (q: any) => {
			seen.push(q);
			if (q.orgId !== a.me.orgId) return [];
			return [{ source: "retrieval", kind: "retrieval", id: "ret_1", at: new Date().toISOString(), spaceId: conversation.spaceId, conversationId: conversation.conversationId, summary: "kb_search → no_evidence", detail: { query: "token=ghp_ABCDEFGHIJKLMNOPQRSTUVWX" } }];
		});
		(t.app.ctx.services.get("trace") as any).register("broken", () => {
			throw new Error("boom");
		});
		const tr = await t.json("GET", `/api/admin/trace?q=${conversation.spaceId}:${conversation.conversationId}`, { token: a.token });
		const tool = tr.events.find((e: any) => e.kind === "tool_call" && e.detail.tool === "file_create");
		assert.ok(tool, JSON.stringify(tr.events));
		assert.equal(tool.conversationId, conversation.conversationId);
		assert.ok(tool.taskId > 0 && tool.callId);
		const ret = tr.events.find((e: any) => e.kind === "retrieval" && e.id === "ret_1");
		assert.equal(ret.summary, "kb_search → no_evidence");
		const real = tr.events.find((e: any) => e.kind === "retrieval" && e.source === "retrieval" && e.id !== "ret_1");
		if (t.app.ctx.services.has("knowledgeAdmin") && typeof (t.app.ctx.services.get("knowledgeAdmin") as any).retrievalEvents === "function") {
			assert.ok(real, JSON.stringify(tr.events.map((e: any) => [e.source, e.kind, e.summary])));
			assert.equal(real.conversationId, conversation.conversationId);
			assert.ok(real.callId && real.taskId > 0);
			assert.match(real.summary, /^kb_search\(tool\)/);
			assert.ok(!JSON.stringify(real).includes("hunter2hunter2"), "query redacted");
		}
		assert.ok(!JSON.stringify(tr.events).includes("SECRETSECRET") && !JSON.stringify(tr.events).includes("ghp_ABCDEFGHIJ"), "redacted");
		assert.equal(seen.at(-1).conversationId, conversation.conversationId);
		assert.deepEqual(tr.eventErrors, [{ source: "broken", error: "boom" }]);
		assert.ok(tr.sources.includes("tools") && tr.sources.includes("retrieval"));
		// Narrow by task id; look up by call id.
		const byTask = await t.json("GET", `/api/admin/trace?q=${conversation.spaceId}:${conversation.conversationId}:${tool.taskId}`, { token: a.token });
		assert.ok(byTask.events.some((e: any) => e.id === tool.id));
		const byCall = await t.json("GET", `/api/admin/trace?q=${encodeURIComponent(tool.callId)}`, { token: a.token });
		assert.ok(byCall.events.some((e: any) => e.id === tool.id));
		// Another org's admin gets nothing from D's records and the contributor is called with *their* org.
		const b = await t.user("b@b.example");
		const other = await t.json("GET", `/api/admin/trace?q=${conversation.spaceId}:${conversation.conversationId}`, { token: b.token });
		assert.deepEqual(other.events.filter((e: any) => e.source !== "broken"), []);
		assert.equal(seen.at(-1).orgId, b.me.orgId);
		assert.equal(seen.at(-1).conversationId, undefined, "another org's space ids are never passed to contributors");
	} finally {
		await t.dispose();
	}
});
