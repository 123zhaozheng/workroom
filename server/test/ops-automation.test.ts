// Automations: DST-correct next runs, scheduled firing on a fake clock, no double fire across restart, concurrency
// skip, cancel, timeout, owner re-resolution, webhook trigger idempotency, notifications (failures recorded separately).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { nextRuns, type AutomationService } from "../src/ops/automation.ts";
import type { NotifyService } from "../src/ops/notify.ts";

process.env.WORKROOM_WEBHOOK_ALLOW_PRIVATE = "1";
process.env.WORKROOM_AUTOMATION_TICK_MS = "0"; // tests drive the scheduler with a fake clock
const SECRET = "test-secret-key-for-automation-0123456789";

const svc = (t: TestApp) => t.app.ctx.services.get("automation") as AutomationService;
const runs = (t: TestApp, autoId: string) => t.app.ctx.db.all<any>("SELECT * FROM auto_runs WHERE automation_id = ? ORDER BY created_at", autoId);

test("next-run preview is correct across DST (America/New_York) and without DST (Asia/Shanghai)", async () => {
	assert.deepEqual(nextRuns({ kind: "cron", expr: "0 9 * * *" }, "America/New_York", new Date("2026-03-07T12:00:00Z"), 3), ["2026-03-07T14:00:00.000Z", "2026-03-08T13:00:00.000Z", "2026-03-09T13:00:00.000Z"]);
	assert.deepEqual(nextRuns({ kind: "cron", expr: "0 9 * * *" }, "America/New_York", new Date("2026-10-31T12:00:00Z"), 3), ["2026-10-31T13:00:00.000Z", "2026-11-01T14:00:00.000Z", "2026-11-02T14:00:00.000Z"]);
	assert.deepEqual(nextRuns({ kind: "cron", expr: "0 9 * * *" }, "Asia/Shanghai", new Date("2026-03-07T00:00:00Z"), 2), ["2026-03-07T01:00:00.000Z", "2026-03-08T01:00:00.000Z"]);
	// Non-existent local time (spring gap) runs once at the next valid instant; repeated local time (fall overlap) runs once.
	assert.deepEqual(nextRuns({ kind: "cron", expr: "30 2 * * *" }, "America/New_York", new Date("2026-03-07T12:00:00Z"), 2), ["2026-03-08T07:00:00.000Z", "2026-03-09T06:30:00.000Z"]);
	assert.deepEqual(nextRuns({ kind: "cron", expr: "30 1 * * *" }, "America/New_York", new Date("2026-10-31T12:00:00Z"), 2), ["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
	const t = await startTestApp();
	try {
		const a = await t.user("a@a.example");
		const p = await t.json("POST", "/api/automations/preview", { token: a.token, json: { trigger: { kind: "cron", expr: "0 9 * * 1-5" }, timezone: "America/New_York", from: "2026-03-06T15:00:00Z", count: 2 } });
		assert.deepEqual(p.runs.map((r: any) => r.at), ["2026-03-09T13:00:00.000Z", "2026-03-10T13:00:00.000Z"]);
		assert.match(p.runs[0].local, /2026-03-09 09:00:00 (EDT|GMT-4)/);
		const bad = await t.json("POST", "/api/automations/preview", { token: a.token, json: { trigger: { kind: "cron", expr: "not a cron" }, timezone: "UTC" } });
		assert.match(bad.error, /cron/);
		await t.json("POST", "/api/automations", { token: a.token, json: { name: "x", prompt: "y", trigger: { kind: "cron", expr: "0 9 * * *" }, timezone: "Mars/Olympus" }, expect: 400 });
		// Editing timezone recomputes next run.
		const { automation } = await t.json("POST", "/api/automations", { token: a.token, json: { name: "早报", prompt: "[[reply 早报]]", trigger: { kind: "cron", expr: "0 9 * * *" }, timezone: "Asia/Shanghai" } });
		assert.match(automation.nextRunAt, /T01:00:00.000Z$/);
		const upd = await t.json("PATCH", `/api/automations/${automation.id}`, { token: a.token, json: { timezone: "Europe/London" } });
		assert.match(upd.automation.nextRunAt, /T(08|09):00:00.000Z$/);
		const pv = await t.json("GET", `/api/automations/${automation.id}/preview?count=3`, { token: a.token });
		assert.equal(pv.runs.length, 3);
		await new Promise((r) => setTimeout(r, 20));
	} finally {
		await t.dispose();
	}
});

test("scheduled run on a fake clock: fires once, creates conversation + notification; restart never double-fires; crashed claim re-submits idempotently", async (tt) => {
	const t = await startTestApp({ config: { secretKey: SECRET } });
	let dataDir = t.dataDir;
	try {
		if (!t.app.ctx.services.has("runtime")) return tt.skip("runtime module not loaded");
		const a = await t.user("a@a.example");
		const T0 = Date.parse("2026-11-09T08:58:00Z");
		svc(t).now = () => T0;
		const { automation } = await t.json("POST", "/api/automations", { token: a.token, json: { name: "日报", prompt: "[[reply 日报已生成]]", trigger: { kind: "cron", expr: "0 9 * * *" }, timezone: "UTC", modelId: "workroom-fixture" } });
		assert.equal(automation.nextRunAt, "2026-11-09T09:00:00.000Z");
		await svc(t).tick(T0 + 60_000); // 08:59 — not due
		assert.equal(runs(t, automation.id).length, 0);
		await Promise.all([svc(t).tick(T0 + 3 * 60_000), svc(t).tick(T0 + 3 * 60_000)]); // 09:01, concurrent ticks
		await svc(t).idle();
		let rs = runs(t, automation.id);
		assert.equal(rs.length, 1);
		assert.equal(rs[0].status, "succeeded", JSON.stringify(rs[0]));
		assert.equal(rs[0].scheduled_for, "2026-11-09T09:00:00.000Z");
		assert.equal(rs[0].request_id, `auto:${automation.id}:2026-11-09T09:00:00.000Z`);
		assert.ok(rs[0].conversation_id != null);
		const detail = await t.json("GET", `/api/automations/${automation.id}`, { token: a.token });
		assert.equal(detail.automation.nextRunAt, "2026-11-10T09:00:00.000Z");
		assert.equal(detail.automation.lastRun.status, "succeeded");
		const entries = await t.json("GET", `/api/conversations/${rs[0].space_id}/${rs[0].conversation_id}/entries`, { token: a.token });
		assert.ok(JSON.stringify(entries).includes("日报已生成"));
		const notes = await t.json("GET", "/api/notifications", { token: a.token });
		assert.equal(notes.unread, 1);
		assert.equal(notes.notifications[0].status, "succeeded");
		assert.equal(notes.notifications[0].link, `/c/${rs[0].space_id}/${rs[0].conversation_id}`);
		assert.ok(notes.notifications[0].refs.some((r: any) => r.kind === "conversation"));
		// Restart (same data dir): ticking the same instant again must not fire.
		await t.stop();
		const t2 = await startTestApp({ dataDir, config: { secretKey: SECRET } });
		try {
			svc(t2).now = () => T0 + 3 * 60_000;
			await svc(t2).tick(T0 + 3 * 60_000);
			await svc(t2).idle();
			assert.equal(runs(t2, automation.id).length, 1, "no double fire after restart");
			// Crash simulation: the run was claimed and its input admitted, but the process died before recording it.
			const before = runs(t2, automation.id)[0];
			t2.app.ctx.db.run("UPDATE auto_runs SET status = 'pending', submission_id = NULL, ended_at = NULL WHERE id = ?", before.id);
			t2.app.ctx.db.run("DELETE FROM ops_notifications WHERE run_id = ?", before.id);
			await t2.stop();
			const t3 = await startTestApp({ dataDir, config: { secretKey: SECRET } });
			try {
				await svc(t3).tick(T0 + 3 * 60_000); // first tick recovers pending runs
				await svc(t3).idle();
				const after = runs(t3, automation.id);
				assert.equal(after.length, 1);
				assert.equal(after[0].status, "succeeded");
				assert.equal(after[0].submission_id, before.submission_id, "pi deduped the re-submission by requestId");
				const harness = await t3.app.ctx.services.get("runtime").harness(after[0].space_id, ctx);
				const conv = await harness.conversation(after[0].conversation_id, ctx);
				const page = await conv!.entries({ order: "ascending" }, 100, undefined, ctx);
				assert.equal(page.items.filter((e) => e.kind === "wr.input").length, 1, "exactly one input in the conversation");
				// Usage of automation runs is attributed (ledger carries automation id).
				const usage = t3.app.ctx.services.get("usage") as any;
				await usage.importConversation(after[0].space_id, after[0].conversation_id);
				assert.ok(t3.app.ctx.db.get<any>("SELECT 1 FROM usage_ledger WHERE automation_id = ?", automation.id));
			} finally {
				await t3.dispose();
			}
		} finally {
			await t2.stop();
		}
	} finally {
		await t.stop();
		const { rmSync } = await import("node:fs");
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("missed runs after downtime are coalesced: policy skip records one skipped run; run_once runs once", async (tt) => {
	const t = await startTestApp();
	try {
		if (!t.app.ctx.services.has("runtime")) return tt.skip("runtime module not loaded");
		const a = await t.user("a@a.example");
		const T0 = Date.parse("2026-11-09T00:30:00Z");
		svc(t).now = () => T0;
		const mk = async (missedPolicy: string) => (await t.json("POST", "/api/automations", { token: a.token, json: { name: missedPolicy, prompt: "[[reply ok]]", trigger: { kind: "cron", expr: "0 * * * *" }, timezone: "UTC", missedPolicy } })).automation;
		const skip = await mk("skip");
		const once = await mk("run_once");
		await svc(t).tick(T0 + 5 * 3600_000 + 10 * 60_000); // 05:40 — 01:00..05:00 were missed
		await svc(t).idle();
		const rs = runs(t, skip.id);
		assert.equal(rs.length, 1);
		assert.equal(rs[0].status, "skipped");
		assert.equal(rs[0].scheduled_for, "2026-11-09T05:00:00.000Z");
		assert.match(rs[0].reason, /missed: 5 occurrence/);
		const ro = runs(t, once.id);
		assert.equal(ro.length, 1);
		assert.equal(ro[0].trigger, "catchup");
		assert.equal(ro[0].status, "succeeded");
		assert.equal((await t.json("GET", `/api/automations/${skip.id}`, { token: a.token })).automation.nextRunAt, "2026-11-09T06:00:00.000Z");
	} finally {
		await t.dispose();
	}
});

test("concurrency limit skips, cancel stops the run, timeout recorded, re-run entry, owner disabled ⇒ refused", async (tt) => {
	const t = await startTestApp();
	try {
		if (!t.app.ctx.services.has("runtime")) return tt.skip("runtime module not loaded");
		const admin = await t.user("admin@a.example");
		const inv = await t.json("POST", "/api/admin/invites", { token: admin.token, json: {} });
		const m = await t.user("m@a.example", { inviteCode: inv.invite.code });
		const { automation: slow } = await t.json("POST", "/api/automations", { token: m.token, json: { name: "慢任务", prompt: "[[slow 4000]] [[reply done]]", trigger: { kind: "manual" }, timezone: "UTC" } });
		const r1 = await t.json("POST", `/api/automations/${slow.id}/run`, { token: m.token });
		await waitRun(t, r1.runId, (r) => r.status === "running" && r.submission_id != null);
		const r2 = await t.json("POST", `/api/automations/${slow.id}/run`, { token: m.token });
		const s2 = await waitRun(t, r2.runId, (r) => r.status !== "pending");
		assert.equal(s2.status, "skipped");
		assert.match(s2.reason, /concurrency/);
		const cancelled = await t.json("POST", `/api/automation-runs/${r1.runId}/cancel`, { token: m.token });
		assert.equal(cancelled.run.status, "cancelled");
		await svc(t).idle();
		assert.equal(runRow(t, r1.runId).status, "cancelled");
		// Timeout
		const { automation: tmo } = await t.json("POST", "/api/automations", { token: m.token, json: { name: "超时", prompt: "[[slow 5000]] [[reply late]]", trigger: { kind: "manual" }, timezone: "UTC", maxDurationMs: 1000 } });
		const r3 = await t.json("POST", `/api/automations/${tmo.id}/run`, { token: m.token });
		await svc(t).idle();
		const s3 = runRow(t, r3.runId);
		assert.equal(s3.status, "timeout");
		assert.match(s3.reason, /max duration/);
		// Re-run entry creates a new linked run
		const rr = await t.json("POST", `/api/automation-runs/${r3.runId}/rerun`, { token: m.token });
		assert.equal(runRow(t, rr.runId).rerun_of, r3.runId);
		await t.json("POST", `/api/automation-runs/${rr.runId}/cancel`, { token: m.token });
		await svc(t).idle();
		// Owner disabled → refused at fire time (authorized scope re-resolved), recorded and audited.
		const { automation: daily } = await t.json("POST", "/api/automations", { token: m.token, json: { name: "日报", prompt: "[[reply x]]", trigger: { kind: "manual" }, timezone: "UTC" } });
		await t.json("POST", `/api/admin/members/${m.me.userId}/disable`, { token: admin.token });
		const r4 = await t.json("POST", `/api/automations/${daily.id}/run`, { token: admin.token }); // org admin may trigger
		await svc(t).idle();
		const s4 = runRow(t, r4.runId);
		assert.equal(s4.status, "refused");
		assert.match(s4.reason, /owner_inactive/);
		assert.equal(s4.conversation_id, null);
		const audit = await t.json("GET", "/api/admin/audit?action=automation.run_refused", { token: admin.token });
		assert.equal(audit.items.length, 1);
		// Removed from the project space ⇒ refused too (no_access), even though the user is active.
		await t.json("POST", `/api/admin/members/${m.me.userId}/enable`, { token: admin.token });
		const m2 = await t.json("POST", "/api/auth/login", { json: { email: "m@a.example", password: "password123" } });
		const { project } = await t.json("POST", "/api/projects", { token: admin.token, json: { name: "P" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: admin.token, json: { email: "m@a.example", role: "editor" } });
		const { automation: inProj } = await t.json("POST", "/api/automations", { token: m2.token, json: { name: "项目任务", prompt: "[[reply x]]", trigger: { kind: "manual" }, timezone: "UTC", projectId: project.id } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: admin.token, json: { email: "m@a.example", role: "viewer" } });
		const r5 = await t.json("POST", `/api/automations/${inProj.id}/run`, { token: admin.token });
		await svc(t).idle();
		assert.match(runRow(t, r5.runId).reason, /no_access: role_viewer/);
	} finally {
		await t.dispose();
	}
});

function runRow(t: TestApp, id: string) {
	return t.app.ctx.db.get<any>("SELECT * FROM auto_runs WHERE id = ?", id);
}
async function waitRun(t: TestApp, id: string, pred: (r: any) => boolean, ms = 10_000) {
	const end = Date.now() + ms;
	for (;;) {
		const r = runRow(t, id);
		if (r && pred(r)) return r;
		if (Date.now() > end) throw new Error(`run ${id} stuck: ${JSON.stringify(r)}`);
		await new Promise((res) => setTimeout(res, 25));
	}
}

test("notifications: webhook delivered with HMAC signature; webhook failure recorded separately from a successful run; email blocked", async (tt) => {
	const received: { headers: IncomingMessage["headers"]; body: string }[] = [];
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const c of req) body += c;
		received.push({ headers: req.headers, body });
		res.writeHead(req.url === "/fail" ? 500 : 204);
		res.end();
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const t = await startTestApp({ config: { secretKey: SECRET } });
	try {
		if (!t.app.ctx.services.has("runtime")) return tt.skip("runtime module not loaded");
		(t.app.ctx.services.get("notify") as NotifyService).retryDelaysMs = [10, 10];
		const a = await t.user("a@a.example");
		const ok = (await t.json("POST", "/api/notify-channels", { token: a.token, json: { kind: "webhook", name: "ok", target: `${base}/ok`, secret: "whsec" } })).channel;
		const bad = (await t.json("POST", "/api/notify-channels", { token: a.token, json: { kind: "webhook", name: "bad", target: `${base}/fail` } })).channel;
		const mail = (await t.json("POST", "/api/notify-channels", { token: a.token, json: { kind: "email", name: "mail", target: "ops@a.example" } })).channel;
		assert.equal(mail.status, "blocked");
		const { automation } = await t.json("POST", "/api/automations", { token: a.token, json: { name: "推送", prompt: "[[reply 推送内容]]", trigger: { kind: "manual" }, timezone: "UTC", destination: { channelIds: [ok.id, bad.id, mail.id] } } });
		const r = await t.json("POST", `/api/automations/${automation.id}/run`, { token: a.token });
		await svc(t).idle();
		const run = (await t.json("GET", `/api/automation-runs/${r.runId}`, { token: a.token })).run;
		assert.equal(run.status, "succeeded", "delivery failures never change the run outcome");
		const ds = Object.fromEntries(run.notifications[0].deliveries.map((d: any) => [d.channelId, d]));
		assert.equal(ds[ok.id].status, "sent");
		assert.equal(ds[ok.id].httpStatus, 204);
		assert.equal(ds[bad.id].status, "failed");
		assert.equal(ds[bad.id].httpStatus, 500);
		assert.equal(ds[bad.id].attempt, 3);
		assert.equal(ds[mail.id].status, "blocked");
		assert.match(ds[mail.id].error, /SMTP/);
		const okReq = received.find((x) => x.headers["x-workroom-delivery"] === ds[ok.id].id)!;
		const sig = createHmac("sha256", "whsec").update(`${okReq.headers["x-workroom-timestamp"]}.${okReq.body}`).digest("hex");
		assert.equal(okReq.headers["x-workroom-signature"], `sha256=${sig}`);
		const payload = JSON.parse(okReq.body);
		assert.equal(payload.run.status, "succeeded");
		assert.equal(payload.link, run.link);
		assert.equal(received.filter((x) => x.body.includes(ds[bad.id].id)).length, 3);
		// Manual retry of the failed delivery is its own record update; still the run is untouched.
		await t.json("POST", `/api/notifications/deliveries/${ds[bad.id].id}/retry`, { token: a.token });
		await (t.app.ctx.services.get("notify") as NotifyService).idle();
		assert.equal((await t.json("GET", `/api/automation-runs/${r.runId}`, { token: a.token })).run.status, "succeeded");
		// Private-address guard (when not explicitly allowed)
		delete process.env.WORKROOM_WEBHOOK_ALLOW_PRIVATE;
		await t.json("POST", "/api/notify-channels", { token: a.token, json: { kind: "webhook", name: "x", target: "http://169.254.169.254/latest" }, expect: 400 });
		process.env.WORKROOM_WEBHOOK_ALLOW_PRIVATE = "1";
	} finally {
		await t.dispose();
		server.close();
	}
});

test("webhook trigger is idempotent per Idempotency-Key; cross-tenant isolation of automations, runs, notifications", async (tt) => {
	const t = await startTestApp();
	try {
		if (!t.app.ctx.services.has("runtime")) return tt.skip("runtime module not loaded");
		const a = await t.user("a@a.example");
		const b = await t.user("b@b.example");
		const { automation } = await t.json("POST", "/api/automations", { token: a.token, json: { name: "事件", prompt: "[[reply 收到事件]]", trigger: { kind: "webhook" }, timezone: "UTC" } });
		assert.ok(automation.webhookToken);
		const url = `/api/hooks/automations/${automation.webhookToken}`;
		const first = await t.req("POST", url, { headers: { "idempotency-key": "evt-1" } });
		assert.equal(first.status, 202);
		const again = await t.req("POST", url, { headers: { "idempotency-key": "evt-1" } });
		assert.equal(again.status, 200);
		assert.equal((await again.json()).duplicate, true);
		assert.equal((await t.req("POST", "/api/hooks/automations/wrong-token")).status, 404);
		await svc(t).idle();
		assert.equal(runs(t, automation.id).length, 1);
		const runId = runs(t, automation.id)[0].id;
		for (const [m, p] of [
			["GET", `/api/automations/${automation.id}`],
			["PATCH", `/api/automations/${automation.id}`],
			["DELETE", `/api/automations/${automation.id}`],
			["POST", `/api/automations/${automation.id}/run`],
			["GET", `/api/automations/${automation.id}/runs`],
			["GET", `/api/automation-runs/${runId}`],
			["POST", `/api/automation-runs/${runId}/rerun`],
			["POST", `/api/automation-runs/${runId}/cancel`],
			["POST", `/api/automations/${automation.id}/webhook-token`],
		] as const) {
			const res = await t.req(m, p, { token: b.token, json: m === "PATCH" ? { name: "x" } : undefined });
			assert.ok([403, 404].includes(res.status), `${m} ${p} → ${res.status}`);
		}
		const bl = JSON.stringify([await t.json("GET", "/api/automations", { token: b.token }), await t.json("GET", "/api/notifications", { token: b.token }), await t.json("GET", "/api/notifications/deliveries", { token: b.token })]);
		assert.ok(!bl.includes(automation.id) && !bl.includes(runId));
		// B cannot create an automation in A's personal space
		const aSpace = (await t.json("GET", "/api/me", { token: a.token })).personalSpaceId;
		await t.json("POST", "/api/automations", { token: b.token, json: { name: "x", prompt: "y", spaceId: aSpace, trigger: { kind: "manual" }, timezone: "UTC" }, expect: 403 });
		// Notification read marks are per user
		const notes = await t.json("GET", "/api/notifications", { token: a.token });
		await t.json("POST", `/api/notifications/${notes.notifications[0].id}/read`, { token: b.token, expect: 404 });
		await t.json("POST", `/api/notifications/${notes.notifications[0].id}/read`, { token: a.token });
		assert.equal((await t.json("GET", "/api/notifications?unread=1", { token: a.token })).unread, 0);
	} finally {
		await t.dispose();
	}
});
