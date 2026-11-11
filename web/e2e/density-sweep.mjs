// Visible-text density of every page (round 11 simplification sweep): counts the words a person can read on each screen
// (density.mjs `visibleUnits`, app sidebar excluded) and writes them as JSON. Run before and after a copy cleanup with
// DENSITY_LABEL=before|after (default "after") and DENSITY_OUT=<file>; the script only measures and asserts nothing about wording.
// Run: npm run -w web build && node web/e2e/density-sweep.mjs        (port 8960)
import { writeFileSync } from "node:fs";
import { chromium, register, sendMessage, sleep, startServer } from "./lib.mjs";
import { visibleUnits } from "./density.mjs";

const PORT = 8960;
const LABEL = process.env.DENSITY_LABEL ?? "after";
const OUT = process.env.DENSITY_OUT;
const server = await startServer({ port: PORT, env: { WORKROOM_SECRET_KEY: "density-sweep-secret-key-0123456789abcdef" } });
const base = server.base;
const browser = await chromium.launch();
const M = {};
try {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	const page = await ctx.newPage();
	await register(page, base, { email: "owner@sweep.example", name: "所有者" });
	const api = ctx.request;
	const me = await (await api.get(`${base}/api/me`)).json();
	const sp = me.personalSpaceId;
	// seed: members, a department, a project, a file in a knowledge base, an automation, a memory, a conversation
	for (const n of ["张三", "李四"]) {
		const inv = (await (await api.post(`${base}/api/admin/invites`, { data: { role: "member", ttlHours: 24 } })).json()).invite.code;
		const c2 = await browser.newContext();
		await c2.request.post(`${base}/api/auth/register`, { data: { email: `${n}@sweep.example`, name: n, password: "password123", inviteCode: inv } });
		await c2.close();
	}
	await api.post(`${base}/api/admin/departments`, { data: { name: "销售部" } });
	const proj = (await (await api.post(`${base}/api/projects`, { data: { kind: "container", name: "发布会筹备" } })).json()).project;
	const kb = (await (await api.post(`${base}/api/kb`, { data: { name: "报销制度库", scope: "personal" } })).json()).kb;
	const up = await (await api.post(`${base}/api/files`, { multipart: { spaceId: sp, file: { name: "报销制度.md", mimeType: "text/markdown", buffer: Buffer.from("# 报销制度\n\n差旅报销需在 30 天内提交。\n") } } })).json();
	await api.post(`${base}/api/kb/${kb.id}/docs`, { data: { fileId: up.file.id, versionId: up.version.versionId } });
	await api.post(`${base}/api/memory`, { data: { content: "周报使用简体中文", kind: "preference", scope: "private" } }).catch(() => {});
	await api.post(`${base}/api/automations`, { data: { name: "工作日早报", prompt: "整理昨日进展", trigger: { kind: "manual" }, timezone: "Asia/Shanghai" } }).catch(() => {});

	await page.goto(base + "/");
	await page.waitForSelector('[data-testid="home-greeting"]');
	await sendMessage(page, "你好，帮我整理一下要点");
	await page.waitForURL(/\/c\//);
	await page.waitForSelector('[data-testid="stop"]', { state: "detached", timeout: 60000 }).catch(() => {});
	await sleep(800);
	const chatUrl = page.url();

	const pages = {
		home: "/",
		chat: chatUrl.replace(base, ""),
		search: "/search",
		files: "/files",
		knowledge: "/knowledge",
		"knowledge-detail": `/knowledge/${kb.id}`,
		project: `/projects/${proj.id}`,
		memory: "/memory",
		automations: "/automations",
		stats: "/stats",
		"cap-mine": "/capabilities?tab=mine",
		"cap-market": "/capabilities?tab=market",
		"cap-mcp": "/capabilities?tab=mcp",
		"cap-connectors": "/capabilities?tab=connectors",
		"settings-general": "/settings?tab=general",
		"settings-assistants": "/settings?tab=assistants",
		"settings-models": "/settings?tab=models",
		"settings-credentials": "/settings?tab=credentials",
		"settings-permissions": "/settings?tab=permissions",
		"settings-security": "/settings?tab=security",
		"settings-devices": "/settings?tab=devices",
		"admin-members": "/admin?tab=members",
		"admin-invites": "/admin?tab=invites",
		"admin-departments": "/admin?tab=departments",
		"admin-sessions": "/admin?tab=sessions",
		"admin-roles": "/admin?tab=roles",
		"admin-authz": "/admin?tab=authz",
		"admin-models": "/admin?tab=models",
		"admin-sandbox": "/admin?tab=sandbox",
		"admin-env": "/admin?tab=env",
		"admin-budgets": "/admin?tab=budgets",
		"admin-audit": "/admin?tab=audit",
		"admin-trace": "/admin?tab=trace",
	};
	for (const [k, u] of Object.entries(pages)) {
		await page.goto(base + u);
		await sleep(1400);
		M[k] = await visibleUnits(page, { exclude: '[data-testid="sidebar"]' });
	}
	console.log(`DENSITY ${LABEL} ${JSON.stringify(M)}`);
	if (OUT) writeFileSync(OUT, JSON.stringify(M, null, 2));
} finally {
	await browser.close();
	await server.stop();
}
