// Contract test for the admin + automation pages (docs/ops.md §9): every action B needs is callable and returns the
// documented envelope / DTO fields.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "./helpers/app.ts";
import type { AutomationService } from "../src/ops/automation.ts";

process.env.WORKROOM_AUTOMATION_TICK_MS = "0";
const has = (o: any, keys: string[], what: string) => {
	for (const k of keys) assert.ok(o && k in o, `${what}: missing ${k} in ${JSON.stringify(o)?.slice(0, 300)}`);
};

test("admin pages: members, invites, departments, sessions, audit + CSV, channels, models, routes, budgets", async () => {
	const t = await startTestApp({ config: { secretKey: "test-secret-key-for-contract-0123456789" } });
	try {
		const a = await t.user("owner@a.example");
		const inv = await t.json("POST", "/api/admin/invites", { token: a.token, json: { role: "member", ttlHours: 24 } });
		has(inv.invite, ["code", "role", "createdBy", "createdAt", "expiresAt"], "InviteDTO");
		const m = await t.user("m@a.example", { inviteCode: inv.invite.code });
		has((await t.json("GET", "/api/admin/invites", { token: a.token })).invites[0], ["code", "role", "usedAt"], "invites");
		const extra = await t.json("POST", "/api/admin/invites", { token: a.token, json: {} });
		await t.json("DELETE", `/api/admin/invites/${extra.invite.code}`, { token: a.token });
		const members = await t.json("GET", "/api/admin/members", { token: a.token });
		has(members.members[0], ["userId", "name", "email", "role", "status", "departmentIds", "joinedAt", "activeSessions", "totpEnabled"], "MemberDTO");
		await t.json("PATCH", `/api/admin/members/${m.me.userId}`, { token: a.token, json: { role: "admin" } });
		has(await t.json("POST", `/api/admin/members/${m.me.userId}/disable`, { token: a.token }), ["ok", "revokedSessions"], "disable");
		await t.json("POST", `/api/admin/members/${m.me.userId}/enable`, { token: a.token });
		const dep = await t.json("POST", "/api/admin/departments", { token: a.token, json: { name: "研发" } });
		has(dep.department, ["id", "name", "memberCount", "createdAt"], "DepartmentDTO");
		await t.json("PATCH", `/api/admin/departments/${dep.department.id}`, { token: a.token, json: { name: "研发中心" } });
		await t.json("PUT", `/api/admin/departments/${dep.department.id}/members`, { token: a.token, json: { userId: m.me.userId, role: "manager" } });
		has((await t.json("GET", `/api/admin/departments/${dep.department.id}/members`, { token: a.token })).members[0], ["userId", "name", "email", "role"], "DepartmentMemberDTO");
		const sessions = await t.json("GET", "/api/admin/sessions", { token: a.token });
		has(sessions.sessions[0], ["id", "userId", "createdAt", "expiresAt", "current", "authMethod"], "SessionDTO");
		const audit = await t.json("GET", "/api/admin/audit?limit=2", { token: a.token });
		has(audit, ["items", "next"], "audit page");
		has(audit.items[0], ["id", "at", "action", "category"], "AuditEntryDTO");
		const page2 = await t.json("GET", `/api/admin/audit?limit=2&before=${audit.next}`, { token: a.token });
		assert.ok(page2.items.every((x: any) => x.id < audit.next), "cursor pagination");
		assert.match(await (await t.req("GET", "/api/admin/audit.csv?category=grant", { token: a.token })).text(), /^at,category,action/);
		// Channels / models / routes
		const ch = await t.json("POST", "/api/admin/channels", { token: a.token, json: { name: "OpenAI compat", provider: "openai-compatible", baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-compat-123456789", rpmLimit: 60, concurrencyLimit: 2, price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } });
		has(ch.channel, ["id", "name", "provider", "credential", "status", "health", "builtin", "createdAt"], "ChannelDTO");
		await t.json("PATCH", `/api/admin/channels/${ch.channel.id}`, { token: a.token, json: { status: "disabled", apiKey: null } });
		await t.json("PATCH", `/api/admin/channels/${ch.channel.id}`, { token: a.token, json: { status: "enabled" } });
		has(await t.json("POST", `/api/admin/channels/${ch.channel.id}/test`, { token: a.token }), ["ok", "status"], "ChannelTestResponse");
		const pm = await t.json("POST", "/api/admin/models", { token: a.token, json: { id: "team-chat", label: "团队模型", capabilities: ["text", "tools"], thinkingLevels: ["off"], isDefault: true } });
		has(pm.model, ["id", "label", "ref", "status", "capabilities", "thinkingLevels", "isDefault", "fixture", "enabled", "visibility", "routes", "kind", "builtin"], "AdminPlatformModelDTO");
		const route = await t.json("POST", `/api/admin/models/${pm.model.id}/routes`, { token: a.token, json: { channelId: ch.channel.id, upstreamModelId: "qwen", priority: 0, weight: 3 } });
		has(route.route, ["id", "platformModelId", "channelId", "upstreamModelId", "priority", "weight", "enabled", "capabilities"], "ModelRouteDTO");
		await t.json("PATCH", `/api/admin/routes/${route.route.id}`, { token: a.token, json: { weight: 1, enabled: false } });
		await t.json("PATCH", `/api/admin/models/${pm.model.id}`, { token: a.token, json: { enabled: false } });
		await t.json("DELETE", `/api/admin/routes/${route.route.id}`, { token: a.token });
		await t.json("PATCH", "/api/admin/models/claude", { token: a.token, json: { label: "x" }, expect: 403 }); // builtin
		has(await t.json("GET", "/api/admin/route-attempts", { token: a.token }), ["attempts"], "attempts");
		// Budgets
		const b = await t.json("POST", "/api/admin/budgets", { token: a.token, json: { scope: { kind: "department", id: dep.department.id }, period: "month", limitCost: 10, action: "warn" } });
		has(b.budget, ["id", "scope", "period", "limitCost", "action", "enabled", "spent", "state"], "BudgetDTO");
		await t.json("PATCH", `/api/admin/budgets/${b.budget.id}`, { token: a.token, json: { enabled: false } });
		await t.json("DELETE", `/api/admin/budgets/${b.budget.id}`, { token: a.token });
		has(await t.json("GET", "/api/budgets/check", { token: a.token }), ["allow"], "BudgetCheckResponse");
		has(await t.json("GET", "/api/admin/settings/webhook-allowlist", { token: a.token }), ["entries", "instance"], "WebhookAllowlistDTO");
		await t.json("DELETE", `/api/admin/departments/${dep.department.id}`, { token: a.token });
		has(await t.json("DELETE", `/api/admin/members/${m.me.userId}`, { token: a.token }), ["ok", "projects", "sessions", "shares"], "remove member");
	} finally {
		await t.dispose();
	}
});

test("automation page: create, preview, edit, disable/enable, run now, runs, rerun, cancel, delete, notifications", async (tt) => {
	const t = await startTestApp();
	try {
		if (!t.app.ctx.services.has("runtime")) return tt.skip("runtime module not loaded");
		const a = await t.user("a@a.example");
		const pv = await t.json("POST", "/api/automations/preview", { token: a.token, json: { trigger: { kind: "cron", expr: "0 9 * * 1-5" }, timezone: "Asia/Shanghai", count: 3 } });
		has(pv, ["timezone", "runs"], "NextRunPreviewDTO");
		has(pv.runs[0], ["at", "local"], "preview run");
		const { automation } = await t.json("POST", "/api/automations", { token: a.token, json: { name: "工作日早报", prompt: "[[reply 早报]]", trigger: { kind: "cron", expr: "0 9 * * 1-5" }, timezone: "Asia/Shanghai" } });
		has(automation, ["id", "name", "prompt", "ownerUserId", "spaceId", "trigger", "timezone", "condition", "destination", "concurrency", "missedPolicy", "maxDurationMs", "enabled", "nextRunAt", "nextRunLocal", "createdAt", "updatedAt"], "AutomationDTO");
		const off = await t.json("PATCH", `/api/automations/${automation.id}`, { token: a.token, json: { enabled: false } });
		assert.equal(off.automation.enabled, false);
		assert.equal(off.automation.nextRunAt, undefined);
		const on = await t.json("PATCH", `/api/automations/${automation.id}`, { token: a.token, json: { enabled: true, name: "早报" } });
		assert.ok(on.automation.nextRunAt);
		has(await t.json("GET", `/api/automations/${automation.id}/preview?count=2`, { token: a.token }), ["runs"], "preview by id");
		const run = await t.json("POST", `/api/automations/${automation.id}/run`, { token: a.token });
		has(run, ["runId", "run"], "RunNowResponse");
		await (t.app.ctx.services.get("automation") as AutomationService).idle();
		const runs = await t.json("GET", `/api/automations/${automation.id}/runs`, { token: a.token });
		has(runs.runs[0], ["id", "automationId", "scheduledFor", "scheduledForLocal", "trigger", "status", "requestId", "createdAt", "link", "notifications"], "AutomationRunDTO");
		assert.equal(runs.runs[0].status, "succeeded");
		const rr = await t.json("POST", `/api/automation-runs/${run.runId}/rerun`, { token: a.token });
		await t.json("POST", `/api/automation-runs/${rr.runId}/cancel`, { token: a.token }).catch(() => undefined); // may have finished already
		await (t.app.ctx.services.get("automation") as AutomationService).idle();
		await t.json("POST", `/api/automation-runs/${run.runId}/cancel`, { token: a.token, expect: 409 });
		has((await t.json("GET", `/api/automation-runs/${rr.runId}`, { token: a.token })).run, ["rerunOf", "status"], "rerun");
		const notes = await t.json("GET", "/api/notifications", { token: a.token });
		has(notes, ["notifications", "unread"], "notifications");
		has(notes.notifications[0], ["id", "kind", "title", "body", "link", "status", "refs", "runId", "createdAt"], "NotificationDTO");
		await t.json("POST", "/api/notifications/read-all", { token: a.token });
		const nch = await t.json("POST", "/api/notify-channels", { token: a.token, json: { kind: "email", name: "邮件", target: "ops@a.example" } });
		has(nch.channel, ["id", "kind", "name", "target", "enabled", "status", "hasSecret", "createdAt"], "NotifyChannelDTO");
		has(await t.json("GET", "/api/notifications/deliveries", { token: a.token }), ["deliveries"], "deliveries");
		await t.json("DELETE", `/api/notify-channels/${nch.channel.id}`, { token: a.token });
		await t.json("DELETE", `/api/automations/${automation.id}`, { token: a.token });
		await t.json("GET", `/api/automations/${automation.id}`, { token: a.token, expect: 404 });
	} finally {
		await t.dispose();
	}
});
