// Usage ledger projection (idempotent import, reconciliation with pi.usage), outcome definitions, budgets, stats, export.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { directHarness, fauxModel } from "../src/ops/testing.ts";
import type { UsageService } from "../src/ops/usage.ts";
import { waitFor } from "../src/runtime/testing.ts";

const SECRET = "test-secret-key-for-usage-0123456789";

// Billable rows = model_request + tool_call + adjustment (run/task rows carry per-run sums for display, not billing).
const totals = (t: TestApp, spaceId: string) => t.app.ctx.db.get<any>("SELECT COUNT(*) AS n, SUM(CASE WHEN kind IN ('model_request','tool_call','adjustment') THEN total_tokens ELSE 0 END) AS tok, SUM(CASE WHEN kind IN ('model_request','tool_call','adjustment') THEN cost ELSE 0 END) AS cost FROM usage_ledger WHERE space_id = ?", spaceId);
const byKind = (t: TestApp, spaceId: string) => Object.fromEntries(t.app.ctx.db.all<any>("SELECT kind || ':' || outcome AS k, COUNT(*) AS n FROM usage_ledger WHERE space_id = ? GROUP BY kind, outcome", spaceId).map((r) => [r.k, r.n]));

test("ledger import is idempotent, reconciles to pi.usage, and classifies tasks/runs/model requests/tool calls", async () => {
	const t = await startTestApp({ config: { secretKey: SECRET } });
	try {
		const a = await t.user("admin@a.example");
		const spaceId = (await t.json("GET", "/api/me", { token: a.token })).personalSpaceId;
		let release: () => void = () => {};
		const { pm } = await fauxModel(t, a.token, [
			{
				name: "main",
				responses: [
					fauxAssistantMessage("第一个回答"),
					fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 invalid request: schema" }),
					fauxAssistantMessage([fauxToolCall("calc", { x: 2 }, { id: "c1" })], { stopReason: "toolUse" }),
					fauxAssistantMessage("工具后回答"),
					async (_c, opts) => {
						await new Promise<void>((r) => {
							release = r;
							opts?.signal?.addEventListener("abort", () => r());
						});
						return fauxAssistantMessage("too late");
					},
				],
			},
		]);
		const calc = defineTool({ name: "calc", description: "calc", parameters: { type: "object", properties: { x: { type: "number" } } } as any, execute: async (args: any) => ({ output: [{ type: "text", text: String(args.x * 2) }] }) } as any);
		const { harness, close } = await directHarness(t, spaceId, { extensions: [defineExtension({ name: "t.calc", tools: [calc] })] });
		const usage = t.app.ctx.services.get("usage") as UsageService;
		try {
			const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: pm.ref } }, ctx);
			assert.equal((await (await conv.submit({ type: "input", content: "一", requestId: "u1" }, ctx)).wait(ctx)).status, "done");
			assert.equal((await (await conv.submit({ type: "input", content: "二", requestId: "u2" }, ctx)).wait(ctx)).status, "unanswered");
			assert.equal((await (await conv.submit({ type: "input", content: "三", requestId: "u3" }, ctx)).wait(ctx)).status, "done");
			const s4 = await conv.submit({ type: "input", content: "四（会被取消）", requestId: "u4" }, ctx);
			await waitFor(async () => (await harness.inspect(ctx)).tasks.length > 0);
			await new Promise((r) => setTimeout(r, 50));
			await conv.abort(ctx);
			release();
			assert.equal((await s4.wait(ctx)).status, "unanswered");

			const r1 = await usage.importConversation(spaceId, conv.id as any, harness);
			const first = totals(t, spaceId);
			const r2 = await usage.importConversation(spaceId, conv.id as any, harness);
			const second = totals(t, spaceId);
			assert.deepEqual(second, first, "import twice = same rows and totals");
			assert.equal(r1.rows, r2.rows);
			assert.deepEqual(byKind(t, spaceId), {
				"task:success": 2,
				"task:failed": 1,
				"task:cancelled": 1,
				"run:success": 2,
				"run:failed": 1,
				"run:cancelled": 1, // aborted before any output: no assistant entry, run keyed by its input entry
				"model_request:success": 3,
				"model_request:failed": 1,
				"tool_call:success": 1,
			});
			// Authoritative pi.usage == projection (no adjustment needed here).
			const piUsage = await harness.usage(ctx);
			const piCost = Object.values(piUsage.models).reduce((s, u) => s + u.cost.total, 0);
			const piTok = Object.values(piUsage.models).reduce((s, u) => s + u.totalTokens, 0);
			assert.ok(piCost > 0);
			assert.ok(Math.abs(second.cost - piCost) < 1e-12);
			assert.equal(second.tok, piTok);
			assert.equal((r2.reconciliation as any).match, true);
			// Failed request carries its error class; route recorded per model request.
			const failed = t.app.ctx.db.get<any>("SELECT * FROM usage_ledger WHERE kind = 'model_request' AND outcome = 'failed'");
			assert.equal(failed.error_class, "bad_request");
			assert.equal(failed.route, "up-main/main-model");
			assert.equal(failed.platform_model_id, pm.id);
			// Rebuild from scratch (projection is disposable) gives identical totals.
			t.app.ctx.db.run("DELETE FROM usage_ledger WHERE space_id = ?", spaceId);
			await usage.importConversation(spaceId, conv.id as any, harness);
			assert.deepEqual(totals(t, spaceId), first);
			// Route attempts were back-filled with org/space/conversation by session id.
			const att = t.app.ctx.db.get<any>("SELECT COUNT(*) AS n FROM ops_route_attempts WHERE conversation_id = ? AND space_id = ? AND org_id = ?", conv.id, spaceId, a.me.orgId);
			assert.ok(att.n >= 5);
		} finally {
			await close();
		}
	} finally {
		await t.dispose();
	}
});

test("adjustment rows keep the projection equal to pi.usage when spend has no transcript entry", async () => {
	const t = await startTestApp({ config: { secretKey: SECRET } });
	try {
		const a = await t.user("admin@a.example");
		const spaceId = (await t.json("GET", "/api/me", { token: a.token })).personalSpaceId;
		const { pm } = await fauxModel(t, a.token, [{ name: "m", responses: [fauxAssistantMessage("ok")] }]);
		const { harness, close } = await directHarness(t, spaceId);
		const usage = t.app.ctx.services.get("usage") as UsageService;
		try {
			const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: pm.ref } }, ctx);
			await (await conv.submit({ type: "input", content: "x", requestId: "x1" }, ctx)).wait(ctx);
			// Simulate spend pi recorded without an entry (what compaction does): add to pi.usage directly.
			const { UsageDoc } = await import("@earendil-works/pi-durable");
			await harness.commit(async (tx) => {
				const d = await tx.doc(UsageDoc, conv.id);
				const k = pm.id;
				d.models[k]!.input += 100;
				d.models[k]!.totalTokens += 100;
				d.models[k]!.cost.total += 0.0003;
			}, ctx);
			const r = await usage.importConversation(spaceId, conv.id as any, harness);
			assert.equal((r.reconciliation as any).adjustments, 1);
			const adj = t.app.ctx.db.get<any>("SELECT * FROM usage_ledger WHERE kind = 'adjustment'");
			assert.equal(adj.total_tokens, 100);
			assert.ok(Math.abs(adj.cost - 0.0003) < 1e-12);
			const sum = t.app.ctx.db.get<any>("SELECT SUM(total_tokens) AS t FROM usage_ledger WHERE space_id = ? AND kind IN ('model_request','adjustment')", spaceId);
			const pi = await harness.usage(ctx);
			assert.equal(sum.t, pi.models[pm.id]!.totalTokens);
			await usage.importConversation(spaceId, conv.id as any, harness);
			assert.equal(t.app.ctx.db.get<any>("SELECT COUNT(*) AS n FROM usage_ledger WHERE kind = 'adjustment'").n, 1, "still one adjustment after re-import");
		} finally {
			await close();
		}
	} finally {
		await t.dispose();
	}
});

test("budgets block submit (runtime API 402 + automation gate), fixture usage costed 0, stats/export permission-controlled", async (tt) => {
	const t = await startTestApp({ config: { secretKey: SECRET } });
	try {
		if (!t.app.ctx.services.has("runtime")) return tt.skip("runtime module not loaded");
		const a = await t.user("admin@a.example");
		const inv = await t.json("POST", "/api/admin/invites", { token: a.token, json: {} });
		const m = await t.user("member@a.example", { inviteCode: inv.invite.code });
		const { pm } = await fauxModel(t, a.token, [{ name: "paid", responses: [fauxAssistantMessage("付费回答 1"), fauxAssistantMessage("付费回答 2"), fauxAssistantMessage("付费回答 3")] }]);
		const send = async (token: string, spaceId: string, cid: number, text: string, rid: string, expect = 200) => {
			const res = await t.json("POST", `/api/conversations/${spaceId}/${cid}/messages`, { token, json: { text, requestId: rid }, expect });
			if (expect !== 200) return res;
			return waitFor(async () => {
				const s = await t.json("GET", `/api/conversations/${spaceId}/${cid}/submissions/${res.submissionId}`, { token });
				return s.status === "done" || s.status === "unanswered" ? s : false;
			});
		};
		const { conversation: c1 } = await t.json("POST", "/api/conversations", { token: m.token, json: { modelId: pm.id } });
		assert.equal((await send(m.token, c1.spaceId, c1.conversationId, "hi", "b1")).status, "done");
		// Fixture conversation: flagged and costed 0.
		const { conversation: cf } = await t.json("POST", "/api/conversations", { token: m.token, json: { modelId: "workroom-fixture" } });
		assert.equal((await send(m.token, cf.spaceId, cf.conversationId, "[[reply 你好]]", "f1")).status, "done");
		const personal = await t.json("GET", "/api/usage?scope=personal", { token: m.token });
		assert.equal(personal.modelRequests.success, 2);
		assert.equal(personal.tasks.success, 2);
		assert.equal(personal.fixtureRequests, 1);
		assert.ok(personal.cost > 0);
		const fx = t.app.ctx.db.get<any>("SELECT * FROM usage_ledger WHERE fixture = 1 AND kind = 'model_request'");
		assert.equal(fx.cost, 0);
		assert.equal(fx.platform_model_id, "workroom-fixture");
		const paid = t.app.ctx.db.get<any>("SELECT * FROM usage_ledger WHERE fixture = 0 AND kind = 'model_request'");
		assert.ok(Math.abs(personal.cost - paid.cost) < 1e-12, "fixture contributes 0");
		// Reconcile: ledger == pi.usage for the member's space.
		const rec = await t.json("GET", `/api/admin/usage/reconcile?spaceId=${c1.spaceId}`, { token: a.token });
		assert.equal(rec.space.match, true, JSON.stringify(rec));
		// Rebuild through the API is idempotent.
		const before = totals(t, c1.spaceId);
		await t.json("POST", "/api/admin/usage/rebuild", { token: a.token, json: { spaceId: c1.spaceId } });
		assert.deepEqual(totals(t, c1.spaceId), before);

		// Budget for this user, already exceeded → next submit refused with 402; others unaffected.
		const { budget } = await t.json("POST", "/api/admin/budgets", { token: a.token, json: { scope: { kind: "user", id: m.me.userId }, period: "month", limitCost: paid.cost / 2 } });
		assert.equal(budget.state, "exceeded");
		const refused = await send(m.token, c1.spaceId, c1.conversationId, "again", "b2", 402);
		assert.equal(refused.error.code, "budget_exceeded");
		const { conversation: ca } = await t.json("POST", "/api/conversations", { token: a.token, json: { modelId: pm.id } });
		assert.equal((await send(a.token, ca.spaceId, ca.conversationId, "admin ok", "b3")).status, "done");
		// Warn-only budgets never block; raising the limit unblocks.
		await t.json("PATCH", `/api/admin/budgets/${budget.id}`, { token: a.token, json: { limitCost: 1000 } });
		await t.json("POST", "/api/admin/budgets", { token: a.token, json: { scope: { kind: "org", id: a.me.orgId }, period: "day", limitTokens: 1, action: "warn" } });
		assert.equal((await send(m.token, c1.spaceId, c1.conversationId, "again", "b4")).status, "done");
		const mine = await t.json("GET", "/api/budgets", { token: m.token });
		assert.ok(mine.budgets.some((b: any) => b.scope.kind === "user" && b.state === "ok"));
		// Project budget blocks inside that project only.
		const { project } = await t.json("POST", "/api/projects", { token: a.token, json: { kind: "space", name: "P" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: a.token, json: { email: "member@a.example", role: "editor" } });
		await t.json("POST", "/api/admin/budgets", { token: a.token, json: { scope: { kind: "project", id: project.id }, period: "total", limitTokens: 0 } });
		const { conversation: cp } = await t.json("POST", "/api/conversations", { token: m.token, json: { modelId: pm.id, projectId: project.id } });
		assert.equal((await send(m.token, cp.spaceId, cp.conversationId, "in project", "p1", 402)).error.code, "budget_exceeded");
		const gate = await t.json("GET", `/api/budgets/check?spaceId=${cp.spaceId}`, { token: m.token });
		assert.equal(gate.allow, false);

		// Permissions: member → personal only; admin → org; project stats need project owner/org admin.
		await t.json("GET", "/api/stats?scope=org", { token: m.token, expect: 403 });
		await t.json("GET", `/api/stats?scope=project:${project.id}`, { token: m.token, expect: 403 });
		await t.json("GET", "/api/usage/export.csv?scope=org", { token: m.token, expect: 403 });
		await t.json("POST", "/api/admin/budgets", { token: m.token, json: { scope: { kind: "org" }, period: "day", limitCost: 1 }, expect: 403 });
		const org = await t.json("GET", "/api/stats?scope=org&largeContextTokens=1", { token: a.token });
		assert.equal(org.modelRequests.success, 4);
		assert.equal(org.latency.count, 4);
		assert.ok(org.latency.p50 >= 0);
		assert.equal(org.largeContext.requests, 4);
		assert.equal(org.largeContext.failureRate, 0);
		assert.deepEqual(org.savedHours, { confirmed: null, estimate: null }, "no fabricated savings");
		await t.json("PUT", "/api/admin/settings/savings", { token: a.token, json: { minutesPerSuccessfulTask: 30 } });
		await t.json("POST", "/api/usage/time-savings", { token: m.token, json: { minutes: 90, note: "确认节省" } });
		const org2 = await t.json("GET", "/api/stats?scope=org", { token: a.token });
		assert.equal(org2.savedHours.confirmed, 1.5);
		assert.equal(org2.savedHours.estimate.label, "estimate");
		assert.equal(org2.savedHours.estimate.value, (org2.tasks.success * 30) / 60);
		const csv = await t.req("GET", "/api/usage/export.csv?scope=personal", { token: m.token });
		assert.equal(csv.status, 200);
		const text = await csv.text();
		assert.match(text.split("\r\n")[0]!, /^at,kind,outcome,orgId/);
		assert.ok(text.includes("workroom-fixture"));
		const audit = await t.json("GET", "/api/admin/audit?action=usage.export", { token: a.token });
		assert.equal(audit.items.length, 1);
		// Cross-tenant: org B admin cannot read A's project/department stats or reconcile A's spaces.
		const b = await t.user("b@b.example");
		await t.json("GET", `/api/stats?scope=project:${project.id}`, { token: b.token, expect: 403 });
		await t.json("GET", `/api/admin/usage/reconcile?spaceId=${c1.spaceId}`, { token: b.token, expect: 404 });
		await t.json("POST", "/api/admin/usage/rebuild", { token: b.token, json: { spaceId: c1.spaceId }, expect: 404 });
		const bOrg = await t.json("GET", "/api/stats?scope=org", { token: b.token });
		assert.equal(bOrg.modelRequests.total, 0);
		assert.equal((await t.json("GET", "/api/budgets", { token: b.token })).budgets.length, 0);
	} finally {
		await t.dispose();
	}
});
