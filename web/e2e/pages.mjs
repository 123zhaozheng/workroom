// Actionable pages against the real server: 自动化 editor & runs (E), 组织管理 (E), 能力 (D).
// Run: npm run -w web build && node web/e2e/pages.mjs
import { join } from "node:path";
import { check, chromium, register, ROOT, sendMessage, shot, SHOTS, sleep, startServer, summary } from "./lib.mjs";

const MCP_ARGS = ["--disable-warning=ExperimentalWarning", join(ROOT, "server/test/fixtures/mcp-fixture-server.ts")];
const server = await startServer({ port: 8822, env: { WORKROOM_AUTOMATION_TICK_MS: "1000", WORKROOM_MCP_STDIO_ALLOW: [process.execPath, ...MCP_ARGS].join(" ") } });
const base = server.base;
const browser = await chromium.launch();
try {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
	const page = await ctx.newPage();
	await register(page, base, { email: `admin-${Date.now()}@example.com`, name: "管理员甲" });

	// ---------------------------------------------------------------- automations editor
	await page.goto(`${base}/automations`);
	await page.click('[data-testid="automation-new"]');
	await page.waitForSelector('[data-testid="automation-editor"]');
	await page.fill("#an", "工作日早报");
	await page.fill("#ap", "汇总昨天的进展 [[reply 已汇总。]]");
	await page.fill('[data-testid="automation-cron"]', "0 9 * * 1-5");
	await page.selectOption("#atz", "Asia/Shanghai");
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="automation-preview"] li').length === 5, null, { timeout: 10000 });
	check("automation: next-run preview (5 runs, server-computed, chosen time zone)", true);
	await shot(page, "1440-automation-editor");
	await page.fill('[data-testid="automation-cron"]', "99 99 * * *");
	await page.waitForFunction(() => document.querySelector('[data-testid="automation-preview"] .text-danger'), null, { timeout: 10000 });
	check("automation: invalid cron reported by the server preview", true);
	await page.fill('[data-testid="automation-cron"]', "0 9 * * 1-5");
	await page.click('[data-testid="automation-save"]');
	await page.waitForSelector('[data-testid="automation"]');
	await page.click('[data-testid="automation"] button[aria-expanded]');
	await page.click('[data-testid="automation-run-now"]');
	await page.waitForSelector('[data-testid="automation-run"][data-status="succeeded"]', { timeout: 30000 });
	check("automation: run now → succeeded, with conversation link", (await page.locator('[data-testid="automation-run"] a', { hasText: "查看对话" }).count()) > 0);
	await page.click('[data-testid="automation-run-rerun"]');
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="automation-run"]').length >= 2, null, { timeout: 30000 });
	check("automation: rerun creates a new run in history", true);
	// in-app notification carries the task link, status and opens the run's conversation (M12-C)
	await page.waitForSelector('[data-testid="notifications-unread"]', { timeout: 30000 });
	await page.click('[data-testid="notifications"]');
	await page.waitForSelector('[data-testid="notification"]');
	const nText = await page.locator('[data-testid="notification"]').first().innerText();
	check("notification: in-app notice with status and task link", /成功|失败|已取消|超时/.test(nText) && (await page.locator('[data-testid="notification-link"]').count()) > 0, nText.replace(/\s+/g, " ").slice(0, 80));
	await sleep(400);
	await shot(page, "1440-notifications");
	await page.locator('[data-testid="notification-link"]').first().click();
	await page.waitForURL(/\/c\//, { timeout: 10000 });
	await page.waitForSelector('[data-testid="assistant-message"]', { timeout: 15000 });
	check("notification: link opens the automation's conversation with its result", true);
	await page.goto(`${base}/automations`);
	await page.waitForSelector('[data-testid="automation"]');
	await sleep(800);
	await shot(page, "1440-automation-runs");

	// cancel a slow run
	await page.click('[data-testid="automation-new"]');
	await page.fill("#an", "慢任务");
	await page.fill("#ap", "[[slow 30000]] 慢慢做");
	await page.selectOption("#ak", "manual");
	await page.click('[data-testid="automation-save"]');
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="automation"]').length === 2, null, { timeout: 10000 });
	const slow = page.locator('[data-testid="automation"]', { hasText: "慢任务" });
	await slow.locator("button[aria-expanded]").click();
	await slow.locator('[data-testid="automation-run-now"]').click();
	await slow.locator('[data-testid="automation-run-cancel"]').first().waitFor({ timeout: 15000 });
	await slow.locator('[data-testid="automation-run-cancel"]').first().click();
	await slow.locator('[data-testid="automation-run"][data-status="cancelled"]').waitFor({ timeout: 20000 });
	check("automation: cancel a running run → 已取消", true);
	await shot(page, "1440-automation-cancelled");

	// ---------------------------------------------------------------- admin: invites → second user joins → disable
	await page.goto(`${base}/admin?tab=invites`);
	await page.click('[data-testid="invite-create"]');
	await page.waitForSelector('[data-testid="invite-link"]');
	const link = (await page.locator('[data-testid="invite-link"] code').innerText()).trim();
	check("admin: invite created with a join link", link.includes("invite="), link.replace(base, ""));
	const ctx2 = await browser.newContext({ viewport: { width: 1366, height: 768 } });
	const p2 = await ctx2.newPage();
	await p2.goto(link);
	await p2.fill("#name", "成员乙");
	await p2.fill("#email", `member-${Date.now()}@example.com`);
	await p2.fill("#password", "password123");
	await p2.click('button[type="submit"]');
	await p2.waitForSelector('[data-testid="home-greeting"]');
	check("invitee joins the same organisation", (await p2.locator('[data-testid="user-menu"]').innerText()).includes("管理员甲"));
	await p2.click('[data-testid="user-menu"]');
	check("member does not see 组织管理 in the menu", (await p2.locator('[data-testid="menu-admin"]').count()) === 0);
	await shot(p2, "1366-member-simple-menu");
	await p2.keyboard.press("Escape");
	const forbidden = await p2.request.get(`${base}/api/admin/members`);
	check("server refuses admin API to a member", forbidden.status() === 403, `status=${forbidden.status()}`);

	await page.goto(`${base}/admin?tab=members`);
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="admin-member"]').length === 2);
	await shot(page, "1440-admin-members");
	await page.locator('[data-testid="admin-member"]', { hasText: "成员乙" }).locator('[data-testid="member-disable"]').click();
	await page.waitForSelector('[data-testid="admin-member"][data-status="disabled"]', { timeout: 10000 });
	await p2.reload();
	await p2.waitForURL(/\/login/, { timeout: 10000 });
	check("admin: disabling a member revokes their session at once", true);
	await ctx2.close();

	// departments, sessions, models/channels, budgets, audit
	await page.goto(`${base}/admin?tab=departments`);
	await page.fill('input[placeholder="新部门名称"]', "市场部");
	await page.click('[data-testid="dept-create"]');
	await page.waitForSelector('[data-testid="admin-departments"]', { timeout: 10000 });
	check("admin: department created", (await page.locator('[data-testid="admin-departments"]').innerText()).includes("市场部"));
	await page.goto(`${base}/admin?tab=sessions`);
	await page.waitForSelector('[data-testid="admin-sessions"]');
	await shot(page, "1440-admin-sessions");
	await page.goto(`${base}/admin?tab=models`);
	await page.waitForSelector('[data-testid="admin-channels"]');
	await sleep(500);
	await shot(page, "1440-admin-models");
	check("admin: channels show credential source and health (keys never shown)", !(await page.locator('[data-testid="admin-channels"]').innerText()).match(/sk-[A-Za-z0-9]{8}/));
	await page.goto(`${base}/admin?tab=budgets`);
	await page.fill('input[placeholder="费用上限 USD"]', "5");
	await page.click('[data-testid="budget-create"]');
	await page.waitForSelector('[data-testid="admin-budgets"]', { timeout: 10000 });
	check("admin: budget created and shows spent / limit / state", (await page.locator('[data-testid="admin-budgets"]').innerText()).includes("$5"));
	await page.goto(`${base}/admin?tab=audit`);
	await page.waitForSelector('[data-testid="admin-audit"]');
	const auditText = await page.locator('[data-testid="admin-audit"]').innerText();
	check("admin: audit lists the changes made above", /member|invite|budget|department/.test(auditText));
	await shot(page, "1440-admin-audit");
	const csv = await page.request.get(`${base}/api/admin/audit.csv`);
	check("admin: audit CSV export downloads", csv.ok() && (await csv.text()).split("\n").length > 2, `status=${csv.status()}`);

	// ---------------------------------------------------------------- 能力: skill lifecycle
	await page.goto(`${base}/capabilities`);
	await page.click('[data-testid="skill-new"]');
	await page.fill("#sn", "周报格式");
	await page.fill("#sd", "按公司格式写周报");
	await page.fill("#si", "周报包含：本周进展、风险、下周计划。每节不超过五条，结论放最前。");
	await page.click('[data-testid="skill-create"]');
	await page.waitForSelector('[data-testid="skill"]');
	const skillId = (await (await page.request.get(`${base}/api/skills`)).json()).skills[0].id;
	await page.request.post(`${base}/api/skills/${skillId}/versions`, { data: { description: "加入数据来源要求", instructions: "周报包含：本周进展、风险、下周计划，并注明数据来源。每节不超过五条。", changeNote: "加数据来源" } });
	await page.reload();
	const card = page.locator('[data-testid="skill"]').first();
	await card.locator("button[aria-expanded]").click();
	await card.locator('[data-testid="skill-pin"] option[value="1"]').waitFor({ state: "attached", timeout: 10000 });
	await sleep(300);
	await card.locator('[data-testid="skill-pin"]').selectOption("1");
	await page.waitForFunction(() => document.querySelector('[data-testid="skill-state"]')?.textContent?.includes("v1（固定）"), null, { timeout: 10000 }).catch(async (e) => {
		console.log("DEBUG card:", (await card.innerText()).replace(/\s+/g, " "));
		throw e;
	});
	check("skill: pin to v1", true);
	await card.getByRole("button", { name: /升级到 v2/ }).click();
	await page.waitForFunction(() => document.querySelector('[data-testid="skill-state"]')?.textContent?.includes("使用 v2"), null, { timeout: 10000 });
	check("skill: upgrade to v2", true);
	await card.locator('[data-testid="skill-rollback"]').click();
	await page.waitForFunction(() => document.querySelector('[data-testid="skill-state"]')?.textContent?.includes("使用 v1"), null, { timeout: 10000 });
	check("skill: rollback to the version used before", true);
	await card.locator('[data-testid="skill-enable"]').click();
	await page.waitForFunction(() => document.querySelector('[data-testid="skill-state"]')?.textContent?.includes("已停用"), null, { timeout: 10000 });
	check("skill: disable", true);
	await shot(page, "1440-capabilities-skill");

	// ---------------------------------------------------------------- 能力: draft from a finished task → validate → publish
	await page.goto(`${base}/`);
	await sendMessage(page, '把要点整理成文件 [[call file_create {"name":"要点","format":"md","content":"# 要点\\n- 一\\n- 二"}]]');
	await page.waitForURL(/\/c\//);
	await page.waitForSelector('[data-testid="file-card"]', { timeout: 20000 });
	await page.click('[data-testid="chat-more"]');
	await page.click('[data-testid="make-skill"]');
	await page.waitForURL(/\/capabilities\?draft=/, { timeout: 15000 });
	await page.waitForSelector('[data-testid="skill-draft"] #di');
	check("draft: preview of instructions / resources / permissions from the task", (await page.locator("#di").inputValue()).length > 20);
	await page.click('[data-testid="draft-validate"]');
	await page.waitForSelector('[data-testid="draft-checks"]', { timeout: 60000 });
	const ok = await page.locator('[data-testid="draft-checks"]').getAttribute("data-ok");
	await shot(page, "1440-skill-draft-validated");
	check("draft: sample validation passes", ok === "true", `ok=${ok}`);
	check("draft: publish enabled only after a passing validation", !(await page.locator('[data-testid="draft-publish"]').isDisabled()));
	await page.click('[data-testid="draft-publish"]');
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="skill"]').length >= 2, null, { timeout: 15000 });
	check("draft: published and installed", true);

	// ---------------------------------------------------------------- 能力: connectors
	const cr = await page.request.post(`${base}/api/connectors`, { data: { name: "测试笔记服务", scope: "system", transport: "stdio", command: process.execPath, args: MCP_ARGS } });
	check("setup: fixture MCP connector created (operator-allowlisted command)", cr.ok(), `status=${cr.status()} ${cr.ok() ? "" : (await cr.text()).slice(0, 200)}`);
	await page.goto(`${base}/capabilities?tab=connectors`);
	await page.waitForSelector('[data-testid="connector"]');
	const conn = page.locator('[data-testid="connector"]').first();
	await conn.getByRole("button", { name: /检查|重新连接/ }).click();
	await page.waitForFunction(() => document.querySelector('[data-testid="connector"]')?.textContent?.includes("可用"), null, { timeout: 20000 });
	check("connector: re-check shows 可用 and its tools (write tools marked)", (await conn.innerText()).includes("写操作"));
	const en = conn.locator('input[type="checkbox"]');
	const before = await en.isChecked();
	await en.click();
	await page.waitForFunction((b) => (document.querySelector('[data-testid="connector"] input[type="checkbox"]'))?.checked === !b, before, { timeout: 10000 });
	check("connector: per-user enablement toggles", true);
	await shot(page, "1440-capabilities-connectors");
	await ctx.close();
} catch (e) {
	check("script completed", false, String(e?.stack ?? e));
} finally {
	await browser.close();
	await server.stop();
}
process.exitCode = summary(join(SHOTS, "pages.results.json")) ? 0 : 1;
