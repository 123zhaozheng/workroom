// M16-C: approvals (grants) and external-effect transitions land in the audit log under their own categories and are
// queryable/exportable by org admins only. Part 1 drives the audit service exactly as the runtime does; part 2 runs a
// real approval + external effect through the runtime fixture tools (active once A's effects call the audit service).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startTestApp } from "./helpers/app.ts";
import { waitFor } from "../src/runtime/testing.ts";

process.env.WORKROOM_FIXTURE_TOOLS = "1";

test("audit categories: approval.* → grant, effect.* → external_write; multi-category query, ref filter, CSV, admin only", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("a@a.example");
		const inv = await t.json("POST", "/api/admin/invites", { token: a.token, json: {} });
		const m = await t.user("m@a.example", { inviteCode: inv.invite.code });
		const audit = t.app.ctx.services.get("audit") as any;
		const conv = { spaceId: "sp_x", conversationId: 7 };
		audit.record({ orgId: a.me.orgId, actorUserId: m.me.userId, action: "approval.requested", target: "apr_1", detail: { ...conv, approvalId: "apr_1", title: "发送邮件" } });
		audit.record({ orgId: a.me.orgId, actorUserId: a.me.userId, action: "approval.decided", target: "apr_1", detail: { ...conv, approvalId: "apr_1", decision: "approved" } });
		for (const st of ["dispatching", "receipt", "needs_reconciliation"]) audit.record({ orgId: a.me.orgId, actorUserId: m.me.userId, action: `effect.${st}`, target: "crm://deals", detail: { ...conv, effectId: "eff_1", idempotencyKey: "k1" } });
		const both = await t.json("GET", "/api/admin/audit?category=grant,external_write", { token: a.token });
		assert.deepEqual(both.items.filter((x: any) => /^(approval|effect)\./.test(x.action)).map((x: any) => `${x.category}:${x.action}`).sort(), ["external_write:effect.dispatching", "external_write:effect.needs_reconciliation", "external_write:effect.receipt", "grant:approval.decided", "grant:approval.requested"]);
		assert.equal((await t.json("GET", "/api/admin/audit?ref=eff_1", { token: a.token })).items.length, 3);
		assert.equal((await t.json("GET", "/api/admin/audit?ref=apr_1&category=grant", { token: a.token })).items.length, 2);
		const csv = await (await t.req("GET", "/api/admin/audit.csv?category=external_write", { token: a.token })).text();
		assert.equal(csv.trim().split("\r\n").length, 4);
		assert.match(csv, /external_write,effect\.receipt/);
		await t.json("GET", "/api/admin/audit?category=external_write", { token: m.token, expect: 403 });
		const b = await t.user("b@b.example");
		assert.equal((await t.json("GET", "/api/admin/audit?ref=eff_1", { token: b.token })).items.length, 0);
	} finally {
		await t.dispose();
	}
});

test("runtime approval decision and external effect transitions are audited (active once A wires effects → audit)", async (tt) => {
	const effectsSrc = (() => {
		try {
			return readFileSync(new URL("../src/runtime/effects.ts", import.meta.url), "utf8");
		} catch {
			return "";
		}
	})();
	if (!/services\.get\(["']audit["']\)|\baudit\b.*record/.test(effectsSrc)) return tt.skip("runtime effects do not call the audit service yet (request in docs/requests/E.md)");
	const t = await startTestApp();
	try {
		if (!t.app.ctx.services.has("runtime")) return tt.skip("runtime module not loaded");
		const a = await t.user("a@a.example");
		const { conversation } = await t.json("POST", "/api/conversations", { token: a.token, json: {} });
		const base = `/api/conversations/${conversation.spaceId}/${conversation.conversationId}`;
		const settle = (sid: number) => waitFor(async () => ((s) => (s.status === "done" || s.status === "unanswered" ? s : false))(await t.json("GET", `${base}/submissions/${sid}`, { token: a.token })));
		const e = await t.json("POST", `${base}/messages`, { token: a.token, json: { text: `[[call wr_fixture_effect {"key":"audit-k1","target":"crm://deals"}]]`, requestId: "eff1" } });
		await settle(e.submissionId);
		const r = await t.json("POST", `${base}/messages`, { token: a.token, json: { text: `[[call wr_fixture_approval {"title":"发送邮件","summary":"给客户发送报价单"}]]`, requestId: "apr1" } });
		const pending = await waitFor(async () => (await t.json("GET", `${base}/state`, { token: a.token })).approvals.find((x: any) => x.status === "pending"));
		await t.req("POST", `${base}/approvals/${pending.approvalId}`, { token: a.token, json: { decision: "approved", note: "ok" }, headers: { "x-request-id": "req_approve_1" } });
		await settle(r.submissionId);
		const items = (await t.json("GET", "/api/admin/audit?category=grant,external_write", { token: a.token })).items;
		const ext = items.filter((x: any) => x.category === "external_write");
		assert.ok(ext.length >= 1, JSON.stringify(items));
		assert.ok(ext.some((x: any) => JSON.stringify(x).includes("crm://deals")));
		const grant = items.filter((x: any) => x.category === "grant" && JSON.stringify(x).includes(pending.approvalId));
		assert.ok(grant.length >= 1, JSON.stringify(items));
	} finally {
		await t.dispose();
	}
});
