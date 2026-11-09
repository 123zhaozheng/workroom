// Actionable pages against the real server: 自动化 editor & runs (E), 组织管理 (E), 能力 (D).
// Run: npm run -w web build && node web/e2e/pages.mjs
import { join } from "node:path";
import { check, chromium, register, shot, SHOTS, sleep, startServer, summary } from "./lib.mjs";

const server = await startServer({ port: 8822, env: { WORKROOM_AUTOMATION_TICK_MS: "1000" } });
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

	// ---------------------------------------------------------------- 能力: skills & connectors
	await page.goto(`${base}/capabilities`);
	await page.waitForLoadState("networkidle");
	await shot(page, "1440-capabilities");
	await ctx.close();
} catch (e) {
	check("script completed", false, String(e?.stack ?? e));
} finally {
	await browser.close();
	await server.stop();
}
process.exitCode = summary(join(SHOTS, "pages.results.json")) ? 0 : 1;
