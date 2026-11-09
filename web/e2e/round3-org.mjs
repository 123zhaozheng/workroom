// Round 3 — tools & org rows: M04-A connector states (needs reconnect / credentials rejected / no permission),
// M05-A three skill kinds with dependencies, M11-B viewer watches a live browser without take-over,
// M09-C external read-only share links vs membership, M16-A login / disabled / removed / revoked session in the UI,
// M18-B admin trace by conversation id with redaction.
// Run: npm run -w web build && node web/e2e/round3-org.mjs
import { createServer } from "node:http";
import { join } from "node:path";
import { check, chromium, login, register, ROOT, sendMessage, shot, SHOTS, sleep, startServer, summary } from "./lib.mjs";

const PAGE_PORT = 8874;
const MCP_PORT = 8875;
const pageServer = createServer((_req, res) => {
	res.setHeader("content-type", "text/html; charset=utf-8");
	res.end(`<!doctype html><html><head><title>观看测试页</title></head><body style="font:16px sans-serif;padding:40px"><h1>只读观看测试</h1><button>按钮</button></body></html>`);
});
await new Promise((r) => pageServer.listen(PAGE_PORT, "127.0.0.1", r));
const { startHttpFixture } = await import(join(ROOT, "server/test/fixtures/mcp-fixture-server.ts"));
let mcp = await startHttpFixture("tok-good", "127.0.0.1", MCP_PORT);
const MCP_ARGS = ["--disable-warning=ExperimentalWarning", join(ROOT, "server/test/fixtures/mcp-fixture-server.ts")];

const server = await startServer({
	port: 8872,
	env: {
		WORKROOM_SECRET_KEY: "e2e-only-secret-key-not-for-production",
		WORKROOM_URL_ALLOWLIST: `127.0.0.1:${PAGE_PORT},127.0.0.1:${MCP_PORT}`,
		WORKROOM_MCP_STDIO_ALLOW: [process.execPath, ...MCP_ARGS].join(" "),
	},
});
const base = server.base;
const browser = await chromium.launch();
const idle = (page, t = 60000) => page.waitForSelector('[data-testid="stop"]', { state: "detached", timeout: t });
const newUser = async (admin, name, role = "member") => {
	const code = (await (await admin.request.post(`${base}/api/admin/invites`, { data: { role, ttlHours: 24 } })).json()).invite.code;
	const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
	const p = await c.newPage();
	const email = `${name}-${Date.now()}@example.com`.replace(/[^\x00-\x7f]/g, "u");
	await p.goto(`${base}/register?invite=${code}`);
	await p.fill("#name", name);
	await p.fill("#email", email);
	await p.fill("#password", "password123");
	await p.click('button[type="submit"]');
	await p.waitForSelector('[data-testid="home-greeting"]');
	const meId = (await (await p.request.get(`${base}/api/me`)).json()).me.userId;
	return { c, p, email, userId: meId };
};
try {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
	const a = await ctx.newPage();
	const adminEmail = `org-${Date.now()}@example.com`;
	await register(a, base, { email: adminEmail, name: "组织管理员" });
	const member = await newUser(a, "成员丙");

	// ---------------------------------------------------------------- M04-A: connector states
	const good = await (await a.request.post(`${base}/api/connectors`, { data: { name: "外部笔记（HTTP）", scope: "personal", transport: "http", url: `http://127.0.0.1:${MCP_PORT}/mcp`, secrets: { Authorization: "Bearer tok-good" } } })).json();
	const bad = await (await a.request.post(`${base}/api/connectors`, { data: { name: "外部笔记（错误凭据）", scope: "personal", transport: "http", url: `http://127.0.0.1:${MCP_PORT}/mcp`, secrets: { Authorization: "Bearer wrong" } } })).json();
	const adminOnly = await (await a.request.post(`${base}/api/connectors`, { data: { name: "财务系统（仅管理员）", scope: "system", transport: "stdio", command: process.execPath, args: MCP_ARGS, access: "admins" } })).json();
	check("setup: three connectors created", !!good.connector && !!bad.connector && !!adminOnly.connector, JSON.stringify([good.connector?.status, bad.connector?.status, adminOnly.connector?.status]));
	await mcp.close(); // the working connector loses its server → needs reconnect on the next check
	await a.goto(`${base}/capabilities?tab=connectors`);
	const goodCard = a.locator('[data-testid="connector"]', { hasText: "外部笔记（HTTP）" });
	await goodCard.locator('[data-testid="connector-reconnect"]').click();
	await a.waitForFunction(() => [...document.querySelectorAll('[data-testid="connector"]')].some((e) => e.textContent?.includes("外部笔记（HTTP）") && e.textContent?.includes("需要重新连接")), null, { timeout: 20000 });
	const badText = await a.locator('[data-testid="connector"]', { hasText: "错误凭据" }).innerText();
	check("M04-A: needs-reconnect and credentials-rejected are shown as different states", badText.includes("凭据被拒绝") && (await a.locator('[data-testid="connector-secrets"]').count()) >= 1, badText.replace(/\s+/g, " ").slice(0, 100));
	await shot(a, "1440-connectors-states");
	mcp = await startHttpFixture("tok-good", "127.0.0.1", MCP_PORT);
	await goodCard.locator('[data-testid="connector-reconnect"]').click();
	await a.waitForFunction(() => [...document.querySelectorAll('[data-testid="connector"]')].some((e) => e.textContent?.includes("外部笔记（HTTP）") && e.textContent?.includes("可用")), null, { timeout: 20000 });
	const badCard = a.locator('[data-testid="connector"]', { hasText: "错误凭据" });
	await badCard.locator('input[aria-label="Authorization"]').fill("Bearer tok-good");
	await badCard.getByRole("button", { name: "更新凭据并重连" }).click();
	await a.waitForFunction(() => [...document.querySelectorAll('[data-testid="connector"]')].some((e) => e.textContent?.includes("错误凭据") && e.textContent?.includes("可用")), null, { timeout: 20000 });
	check("M04-A: reconnect (and credential update by the owner) restores 可用", true);
	await member.p.goto(`${base}/capabilities?tab=connectors`);
	await member.p.waitForSelector('[data-testid="connector"]', { timeout: 10000 });
	const mText = await member.p.locator('[data-testid="connector"]', { hasText: "财务系统" }).innerText();
	check("M04-A: a member sees the admin-only connector as 无权限 (and cannot enable it)", mText.includes("无权限") && !(await member.p.locator('[data-testid="connector"]', { hasText: "财务系统" }).locator('input[type="checkbox"]').count()), mText.replace(/\s+/g, " ").slice(0, 100));
	await shot(member.p, "1440-connectors-no-permission");

	// ---------------------------------------------------------------- M05-A: prompt / context / executable side by side
	await a.request.post(`${base}/api/skills`, { data: { name: "周报模板", kind: "prompt", description: "周报的固定开头", instructions: "请按“结论—进展—风险—计划”的顺序写周报，每节最多五条。" } });
	await a.request.post(`${base}/api/skills`, { data: { name: "报销须知", kind: "context", description: "报销相关的公司规定说明", instructions: "报销须在 30 天内提交，附发票原件；超过标准需部门负责人审批。" } });
	const ex = await a.request.post(`${base}/api/skills`, { data: { name: "表格汇总脚本", kind: "executable", description: "把 CSV 汇总成统计表", instructions: "运行 summarize.sh 读取 /work 下的 CSV 并输出汇总，然后发布结果文件。", resources: [{ path: "summarize.sh", content: "#!/bin/sh\nwc -l /work/*.csv > /work/summary.txt\n" }], entry: "summarize.sh", requiredPermissions: ["file.write"] } });
	check("setup: executable skill created", ex.ok(), `status=${ex.status()} ${ex.ok() ? "" : (await ex.text()).slice(0, 200)}`);
	await a.goto(`${base}/capabilities`);
	await a.waitForFunction(() => document.querySelectorAll('[data-testid="skill"]').length === 3);
	for (const n of ["周报模板", "报销须知", "表格汇总脚本"]) await a.locator('[data-testid="skill"]', { hasText: n }).locator("button[aria-expanded]").click();
	await a.waitForSelector('[data-testid="skill-grants"]', { timeout: 10000 });
	const txt = (n) => a.locator('[data-testid="skill"]', { hasText: n }).innerText();
	const [tp, tc, te] = [await txt("周报模板"), await txt("报销须知"), await txt("表格汇总脚本")];
	check("M05-A: prompt preset, context-only and executable skills are labelled distinctly", tp.includes("提示词预设") && tc.includes("上下文技能") && te.includes("可执行技能"));
	check("M05-A: the executable skill lists its entry, sandbox/file permissions and a grant prompt; text skills need none", te.includes("入口 summarize.sh") && te.includes("在沙箱中执行") && te.includes("写入文件库") && te.includes("缺少") && tp.includes("无需额外权限") && tc.includes("无需额外权限"), te.replace(/\s+/g, " ").slice(0, 200));
	await a.locator('[data-testid="skill"]', { hasText: "表格汇总脚本" }).getByRole("button", { name: /授予 v1 所需权限/ }).click();
	await a.waitForFunction(() => document.querySelector('[data-testid="skill-grants"]')?.textContent?.includes("已全部授予"), null, { timeout: 10000 });
	check("M05-A: per-version grant recorded for the executable skill", true);
	await shot(a, "1440-skill-kinds");

	// ---------------------------------------------------------------- M11-B: viewer watches, cannot take over
	const proj = (await (await a.request.post(`${base}/api/projects`, { data: { name: "竞品调研" } })).json()).project;
	await a.request.put(`${base}/api/projects/${proj.id}/members`, { data: { email: member.email, role: "viewer" } });
	await a.goto(`${base}/projects/${proj.id}`);
	await sendMessage(a, `[[call browser_open {"url":"http://127.0.0.1:${PAGE_PORT}/"}]]`);
	await a.waitForURL(/\/c\//);
	await a.waitForSelector('[data-testid="assistant-message"]', { timeout: 30000 });
	await idle(a);
	const projChat = a.url();
	await member.p.goto(projChat);
	await member.p.click('[data-testid="open-work-panel"]');
	await member.p.click('[data-testid="work-tab-browser"]');
	await member.p.waitForSelector('[data-testid="browser-session"]', { timeout: 20000 });
	await member.p.waitForSelector('[data-testid="browser-screenshot"]');
	const vText = await member.p.locator('[data-testid="browser-session"]').innerText();
	check("M11-B: a viewer can watch the live page but gets no take-over button (same rule as preview)", (await member.p.locator('[data-testid="browser-takeover"]').count()) === 0 && vText.includes("你只能观看"));
	const sess = (await (await member.p.request.get(`${base}/api/work/${projChat.split("/c/")[1]}`)).json()).work.browserSessions[0];
	const tk = await member.p.request.post(`${base}/api/browser-sessions/${sess.id}/takeover`);
	check("M11-B: the server refuses a viewer's take-over anyway", tk.status() === 403, `status=${tk.status()}`);
	await shot(member.p, "1440-browser-viewer-watch-only");

	// ---------------------------------------------------------------- M09-C: external read-only share vs membership
	await a.goto(`${base}/projects/${proj.id}`);
	await a.click('[data-testid="project-share"]');
	await a.click('[data-testid="share-create"]');
	await a.waitForSelector('[data-testid="share-url"] code');
	const shareUrl = (await a.locator('[data-testid="share-url"] code').innerText()).trim();
	await shot(a, "1440-share-dialog");
	const anon = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
	const ap = await anon.newPage();
	await ap.goto(shareUrl);
	await ap.waitForSelector('[data-testid="shared-view"] h1', { timeout: 10000 });
	const shared = await ap.locator('[data-testid="shared-view"]').innerText();
	check("M09-C: logged-out visitor opens the share read-only (no composer, no membership)", shared.includes("竞品调研") && shared.includes("只能查看") && (await ap.locator('[data-testid="composer"]').count()) === 0);
	await shot(ap, "390-shared-readonly");
	const projApi = await ap.request.get(`${base}/api/projects/${proj.id}/members`);
	check("M09-C: the share token is not a session — project API stays closed to the visitor", projApi.status() === 401, `status=${projApi.status()}`);
	await a.click('[data-testid="share-revoke"]');
	await a.waitForSelector('[data-testid="share"][data-status="revoked"]', { timeout: 10000 });
	await ap.reload();
	await ap.waitForSelector('[data-testid="shared-invalid"]', { timeout: 10000 });
	check("M09-C: after revoke the link stops working", true);
	await shot(ap, "390-shared-revoked");
	await anon.close();

	// ---------------------------------------------------------------- M18-B: admin trace by conversation id, redacted
	// a tool call whose arguments carry a (fake) secret, to prove the trace masks it
	await a.goto(projChat);
	await sendMessage(a, `[[call browse {"url":"http://127.0.0.1:${PAGE_PORT}/?token=supersecret123456"}]]`);
	await a.waitForFunction(() => document.querySelectorAll('[data-testid="assistant-message"]').length >= 2, null, { timeout: 30000 });
	await idle(a);
	const convKey = projChat.split("/c/")[1].replace("/", ":");
	await a.goto(`${base}/admin?tab=trace`);
	await a.fill('[data-testid="trace-q"]', convKey);
	await a.click('[data-testid="trace-run"]');
	await a.waitForSelector('[data-testid="trace-summary"]', { timeout: 15000 });
	const tr = await a.locator('[data-testid="trace"]').innerText();
	check("M18-B: one conversation id joins route attempts, usage and tool events", /模型路由 [1-9]/.test(tr) && /其他模块事件 [1-9]/.test(tr), tr.split("\n").slice(0, 8).join(" | "));
	const evText = await a.locator('[data-testid="trace-events"]').innerText();
	check("M18-B: secrets in tool arguments are masked in the trace", evText.includes("browse") && !tr.includes("supersecret123456") && /token=\*\*\*/.test(tr), (evText.match(/[^\n]*token[^\n]*/) ?? ["(no token line)"])[0].slice(0, 160));
	await shot(a, "1440-admin-trace");

	// ---------------------------------------------------------------- M16-A: revoked session / disabled / removed, reflected in the UI
	const other = await browser.newContext({ viewport: { width: 1366, height: 768 } });
	const op = await other.newPage();
	await login(op, base, { email: adminEmail });
	await a.goto(`${base}/settings`);
	await a.waitForFunction(() => document.querySelectorAll('[data-testid="my-session"]').length >= 2, null, { timeout: 10000 });
	await shot(a, "1440-my-sessions");
	await a.click('[data-testid="revoke-others"]');
	await a.waitForFunction(() => document.querySelectorAll('[data-testid="my-session"]').length === 1, null, { timeout: 10000 });
	await op.reload();
	await op.waitForURL(/\/login/, { timeout: 10000 });
	check("M16-A: a revoked session is sent back to login on the other device", true);
	await other.close();
	await a.goto(`${base}/admin?tab=members`);
	await a.locator('[data-testid="admin-member"]', { hasText: "成员丙" }).locator('[data-testid="member-disable"]').click();
	await a.waitForSelector('[data-testid="admin-member"][data-status="disabled"]');
	await member.p.reload();
	await member.p.waitForURL(/\/login/, { timeout: 10000 });
	await member.p.fill("#email", member.email);
	await member.p.fill("#password", "password123");
	await member.p.click('button[type="submit"]');
	await member.p.waitForSelector('[role="alert"]', { timeout: 10000 });
	const disabledMsg = await member.p.locator('[role="alert"]').innerText();
	check("M16-A: a disabled member is logged out and the login form says why", disabledMsg.length > 0, disabledMsg);
	await shot(member.p, "1440-login-disabled");
	const removed = await newUser(a, "成员丁");
	await a.goto(`${base}/admin?tab=members`);
	a.once("dialog", (d) => d.accept());
	await a.locator('[data-testid="admin-member"]', { hasText: "成员丁" }).getByRole("button", { name: "移出" }).click();
	await a.waitForFunction(() => ![...document.querySelectorAll('[data-testid="admin-member"]')].some((e) => e.textContent?.includes("成员丁")), null, { timeout: 10000 });
	await removed.p.reload();
	await removed.p.waitForURL(/\/login/, { timeout: 10000 });
	check("M16-A: a removed member loses access immediately (back to login)", true);
	await removed.c.close();
	await member.c.close();
	await ctx.close();
} catch (e) {
	check("script completed", false, String(e?.stack ?? e));
} finally {
	await browser.close();
	await server.stop();
	await mcp.close().catch(() => {});
	pageServer.close();
}
process.exitCode = summary(join(SHOTS, "round3-org.results.json")) ? 0 : 1;
