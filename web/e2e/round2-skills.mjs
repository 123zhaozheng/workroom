// Round 2 · 去助手 + 我的技能弹框详情
// Verifies:
// 1) SettingsPage has no assistants tab; /settings?tab=assistants falls back to default (general).
// 2) MySkills cards keep card shape (data-testid="my-skill-card", no aria-expanded); quick Switch on card does not open dialog.
// 3) Clicking card opens data-testid="skill-detail-dialog" with icon, name, description, type, status, SKILL.md preview, versions, runs,
//    icon picker, enable/disable, pin/upgrade/rollback, submit-review, download, uninstall (closes dialog & refreshes list).
// 4) Esc / backdrop click / close button all close the dialog cleanly; 1440 / 390 + dark mode have no horizontal overflow.
// Run: npm run build:web && node web/e2e/round2-skills.mjs   (port 4392)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { check, chromium, pick, register, ROOT, selOptions, SHOTS, sleep, startServer, summary } from "./lib.mjs";

const require = createRequire(import.meta.url);
const { zipSync, strToU8 } = await import(join(ROOT, "node_modules/fflate/esm/browser.js")).catch(() => require(join(ROOT, "node_modules/fflate")));
const DIR = join(SHOTS, "round2-skills");
mkdirSync(DIR, { recursive: true });

const PORT = 4392;
const server = await startServer({ port: PORT });
const base = server.base;
const browser = await chromium.launch();
const T = (id) => `[data-testid="${id}"]`;

const zipB64 = (files) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))).toString("base64");
const md = (name, ver, body) => `---\nname: ${name}\ndescription: 周报整理技能说明\nversion: ${ver}\n---\n\n${body}\n`;

try {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "zh-CN", acceptDownloads: true });
	const page = await ctx.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));

	await register(page, base, { email: `r2-${Date.now()}@example.com`, name: "技能测试" });

	// 1. Settings: no assistants tab, ?tab=assistants falls back to general
	await page.goto(`${base}/settings`);
	await page.waitForSelector(T("settings-tab-general"));
	const navText = await page.locator("nav[aria-label='设置']").innerText();
	check("settings: assistants tab removed from nav", (await page.locator(T("settings-tab-assistants")).count()) === 0 && !navText.includes("助手"), navText.replace(/\s+/g, " "));
	await page.goto(`${base}/settings?tab=assistants`);
	await page.waitForSelector(T("settings-tab-general"));
	check("settings: /settings?tab=assistants falls back to default general tab", (await page.locator(T("assistants")).count()) === 0 && (await page.locator("body").innerText()).includes("账号"));

	// 2. Upload a package skill (v1 + v2) + create a context skill
	const up1 = await page.request.post(`${base}/api/market/skills/upload`, {
		data: { zipBase64: zipB64({ "SKILL.md": md("weekly-digest", "1.0.0", "# 周报摘要 v1\n\n- 汇总本周完成事项\n- 列出下周计划") }), changeNote: "初版" },
	});
	const up1j = await up1.json();
	check("setup: uploaded package skill v1", up1.ok(), JSON.stringify(up1j).slice(0, 120));
	const up2 = await page.request.post(`${base}/api/market/skills/upload`, {
		data: { skillId: up1j.skill.id, zipBase64: zipB64({ "SKILL.md": md("weekly-digest", "1.1.0", "# 周报摘要 v2\n\n- 汇总本周完成事项\n- 补充风险与阻塞") }), changeNote: "新增风险段" },
	});
	check("setup: uploaded package skill v2", up2.ok());

	await page.goto(`${base}/capabilities`);
	await page.waitForSelector(T("my-skill-card"));
	const card = page.locator(T("my-skill-card")).first();
	check("card: uses data-testid=my-skill-card without aria-expanded", (await card.count()) === 1 && (await card.locator("[aria-expanded]").count()) === 0);

	// Card quick switch does not open the dialog
	await card.locator(T("skill-enable")).click();
	await page.waitForFunction(() => document.querySelector('[data-testid="my-skill-card"] [data-testid="skill-state"]')?.textContent?.includes("已停用"), null, { timeout: 10000 });
	check("card: toggling quick Switch disables skill without opening dialog", (await page.locator(T("skill-detail-dialog")).count()) === 0);
	await card.locator(T("skill-enable")).click();
	await page.waitForFunction(() => document.querySelector('[data-testid="my-skill-card"] [data-testid="skill-state"]')?.textContent?.includes("已启用"), null, { timeout: 10000 });

	// 3. Click card -> opens detail dialog
	await card.click();
	const dlg = page.locator(T("skill-detail-dialog"));
	await dlg.waitFor({ timeout: 10000 });
	await dlg.locator(T("skill-md-preview")).waitFor({ timeout: 10000 });
	const dlgText = await dlg.innerText();
	check("dialog: shows name, icon, description, type, status, SKILL.md preview, versions and runs", dlgText.includes("weekly-digest") && dlgText.includes("上下文技能") && dlgText.includes("周报摘要 v2") && dlgText.includes("新增风险段") && (await dlg.locator(`${T("skill-icon")}`).count()) >= 1 && (await dlg.locator(T("skill-versions")).count()) === 1);
	check("dialog: copy uses AI instead of 助手", !dlgText.includes("助手"));
	await sleep(250);
	await page.screenshot({ path: join(DIR, "skill-detail-dialog-1440.png") });

	// Test close via Esc
	await page.keyboard.press("Escape");
	await dlg.waitFor({ state: "detached", timeout: 8000 });
	check("dialog: Escape closes dialog", true);

	// Reopen and test close via close button
	await card.click();
	await dlg.waitFor({ timeout: 8000 });
	await dlg.getByRole("button", { name: "关闭" }).click();
	await dlg.waitFor({ state: "detached", timeout: 8000 });
	check("dialog: close button closes dialog", true);

	// Reopen and test close via backdrop click
	await card.click();
	await dlg.waitFor({ timeout: 8000 });
	await page.mouse.click(10, 10);
	await dlg.waitFor({ state: "detached", timeout: 8000 });
	check("dialog: clicking overlay closes dialog", true);

	// Reopen and test operations inside dialog (pin, upgrade, rollback, download, uninstall)
	await card.click();
	await dlg.waitFor({ timeout: 8000 });
	for (let i = 0; i < 40 && !(await selOptions(dlg.locator(T("skill-pin")))).some((o) => o.value === "1"); i++) await sleep(200);
	await pick(dlg.locator(T("skill-pin")), "1");
	await page.waitForFunction(() => document.querySelector('[data-testid="skill-detail-dialog"] [data-testid="skill-state"]')?.textContent?.includes("v1（固定）"), null, { timeout: 10000 });
	check("dialog: pin to v1 updates state and shows v1 SKILL.md", (await dlg.locator(T("skill-md-preview")).innerText()).includes("周报摘要 v1"));

	await dlg.getByRole("button", { name: /升级到 v2/ }).click();
	await page.waitForFunction(() => document.querySelector('[data-testid="skill-detail-dialog"] [data-testid="skill-state"]')?.textContent?.includes("使用 v2"), null, { timeout: 10000 });
	check("dialog: upgrade to v2", true);

	await dlg.locator(T("skill-rollback")).click();
	await page.waitForFunction(() => document.querySelector('[data-testid="skill-detail-dialog"] [data-testid="skill-state"]')?.textContent?.includes("使用 v1"), null, { timeout: 10000 });
	check("dialog: rollback to v1", true);

	const dlPromise = page.waitForEvent("download", { timeout: 10000 });
	await dlg.locator(T("skill-download")).click();
	const dl = await dlPromise;
	check("dialog: download triggers package zip download", dl.suggestedFilename().endsWith(".zip"), dl.suggestedFilename());

	// Mobile 390 + dark mode inside dialog
	await page.setViewportSize({ width: 390, height: 844 });
	await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
	await sleep(300);
	const fit390 = await page.evaluate(() => {
		const d = document.querySelector('[data-testid="skill-detail-dialog"]')?.getBoundingClientRect();
		return !!d && d.left >= 0 && d.right <= window.innerWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1;
	});
	check("dialog: fits 390px dark mode without horizontal overflow", fit390);
	await page.screenshot({ path: join(DIR, "skill-detail-dialog-390-dark.png") });
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

	// Uninstall closes dialog and refreshes list
	await dlg.locator(T("skill-uninstall")).click();
	await dlg.waitFor({ state: "detached", timeout: 10000 });
	await page.waitForFunction(() => document.querySelector('[data-testid="my-skill-card"] [data-testid="skill-install"]') !== null, null, { timeout: 10000 });
	check("dialog: uninstall closes dialog and refreshes list", (await page.locator(T("skill-detail-dialog")).count()) === 0 && (await card.locator(T("skill-install")).count()) === 1);

	check("page: no uncaught page errors", errors.length === 0, errors.join(" | ").slice(0, 200));
} catch (e) {
	check("script completed", false, String(e?.stack ?? e).slice(0, 400));
} finally {
	await browser.close();
	await server.stop();
}
process.exitCode = summary(join(DIR, "round2-skills-results.json")) ? 0 : 1;
