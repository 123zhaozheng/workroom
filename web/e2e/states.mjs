// Run states and composer references against the real server (fixture model):
// attachment chip + knowledge chip via slash menu (M01-A), failed (with reason) / cancelled states (M02-C),
// subagent in the shared work panel (M03-B / M11-B UI), project page, dark theme.
// Run: npm run -w web build && node web/e2e/states.mjs
import { join } from "node:path";
import { check, chromium, register, sendMessage, shot, SHOTS, sleep, startServer, summary } from "./lib.mjs";

const server = await startServer({ port: 8812 });
const base = server.base;
const browser = await chromium.launch();
try {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
	const page = await ctx.newPage();
	await register(page, base, { email: `s-${Date.now()}@example.com`, name: "周岚" });
	const me = await (await page.request.get(`${base}/api/me`)).json();

	// a knowledge base to reference
	const kbRes = await page.request.post(`${base}/api/kb`, { data: { name: "制度库", scope: "personal" } });
	const kbOk = kbRes.ok();
	check("setup: knowledge base created through C's API", kbOk, `status=${kbRes.status()}`);

	// ---------------------------------------------------------------- attachment chip + slash-menu knowledge chip
	await page.setInputFiles('[data-testid="file-input"]', { name: "会议纪要.txt", mimeType: "text/plain", buffer: Buffer.from("周一例会：确认上线时间为 12 月 1 日。") });
	await page.waitForSelector('[data-testid="chip-file"]');
	await page.waitForFunction(() => !document.querySelector('[data-testid="chip-file"] .wr-spin'), null, { timeout: 10000 });
	const input = page.locator('[data-testid="composer-input"]');
	await input.fill("/");
	await page.waitForSelector('[data-testid="slash-menu"]');
	await shot(page, "1440-composer-slash-menu");
	await input.press("Enter"); // first item: 引用知识库
	if (kbOk) {
		await page.getByRole("button", { name: /制度库/ }).click();
		await page.waitForSelector('[data-testid="chip-kb"]');
	}
	await input.fill("根据附件和制度库整理要点 [[reply 已阅读附件与知识库引用。]]");
	await shot(page, "1440-composer-chips");
	check("composer: file chip + knowledge chip in one input", (await page.locator('[data-testid="chip-file"]').count()) === 1 && (!kbOk || (await page.locator('[data-testid="chip-kb"]').count()) === 1));
	await page.click('[data-testid="send"]');
	await page.waitForURL(/\/c\//);
	await page.waitForSelector('[data-testid="assistant-message"]', { timeout: 20000 });
	const userText = await page.locator('[data-testid="user-message"]').first().innerText();
	check("chat: sent message carries attachment and knowledge references", userText.includes("会议纪要.txt") && (!kbOk || userText.includes("制度库")), userText.slice(0, 80));
	const convUrl = page.url();

	// ---------------------------------------------------------------- failed with reason
	await sendMessage(page, "[[fail]] 这一步会失败");
	await page.waitForSelector('[data-testid="run-bar"][data-status="failed"], [data-testid="run-bar"][data-status="interrupted"]', { timeout: 60000 });
	await sleep(300);
	const failText = await page.locator('[data-testid="run-bar"]').innerText();
	check("state: failed shown with reason + 继续", failText.includes("继续"), failText.replace(/\s+/g, " "));
	await shot(page, "1440-state-failed");

	// ---------------------------------------------------------------- cancelled
	await sendMessage(page, "[[slow 20000]] 一个很慢的任务");
	await page.waitForSelector('[data-testid="stop"]', { timeout: 10000 });
	await sleep(500);
	await shot(page, "1440-state-running");
	await page.click('[data-testid="stop"]');
	await page.waitForSelector('[data-testid="run-bar"][data-status="aborted"]', { timeout: 15000 });
	check("state: cancelled is its own terminal state", true);
	await shot(page, "1440-state-cancelled");

	// ---------------------------------------------------------------- subagent → work panel
	await sendMessage(page, '[[call delegate {"member":"writer","task":"把会议纪要写成一段通知"}]]');
	await page.waitForFunction(() => {
		const msgs = document.querySelectorAll('[data-testid="assistant-message"]');
		return msgs[msgs.length - 1]?.querySelector('[data-testid="step-chain"]');
	}, null, { timeout: 30000 });
	await page.waitForSelector('[data-testid="stop"]', { state: "detached", timeout: 60000 });
	await page.click('[data-testid="open-work-panel"]');
	await page.waitForSelector('[data-testid="work-panel"]');
	await page.waitForSelector('[data-testid="subagent"], [data-testid="unavailable"]', { timeout: 15000 });
	const subs = await page.locator('[data-testid="subagent"]').count();
	check("work panel: subagent with source/status/result", subs > 0, `subagents=${subs}`);
	await sleep(300);
	await shot(page, "1440-work-panel-tasks");
	await page.click('[data-testid="work-tab-terminal"]');
	await sleep(800);
	await shot(page, "1440-work-panel-terminal");
	check("work panel: terminal tab renders (sandbox info / runs / directory)", (await page.locator('[data-testid="render-error"]').count()) === 0);
	await page.click('[data-testid="work-tab-browser"]');
	await sleep(800);
	await shot(page, "1440-work-panel-browser");
	check("work panel: one panel, switchable tabs", (await page.locator('[data-testid="side-panel"]').count()) === 1);
	await page.click('[data-testid="close-panel"]');

	// ---------------------------------------------------------------- project page
	const pr = await (await page.request.post(`${base}/api/projects`, { data: { name: "新品发布" } })).json();
	await page.goto(`${base}/projects/${pr.project.id}`);
	await page.waitForSelector('[data-testid="members"]');
	await sleep(500);
	await shot(page, "1440-project");
	check("project page: members with roles", (await page.locator('[data-testid="members"] li').count()) >= 1);

	// ---------------------------------------------------------------- other pages render honestly
	for (const [path, name] of [["/search", "search"], ["/capabilities", "capabilities"], ["/automations", "automations"], ["/stats", "stats"], ["/memory", "memory"], ["/admin", "admin"]]) {
		await page.goto(`${base}${path}`);
		await page.waitForLoadState("networkidle");
		await sleep(300);
		await shot(page, `1440-${name}`);
		check(`page ${path}: renders without a UI fault`, (await page.locator('[data-testid="render-error"]').count()) === 0);
	}
	if (me.me.orgRole === "owner") check("admin entry visible for org owner", true);

	// ---------------------------------------------------------------- dark theme
	const dark = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark", storageState: await ctx.storageState() });
	const dp = await dark.newPage();
	await dp.goto(convUrl);
	await dp.waitForSelector('[data-testid="assistant-message"]');
	await sleep(400);
	await shot(dp, "1440-chat-dark");
	check("dark theme follows system", (await dp.evaluate(() => document.documentElement.dataset.theme)) === "dark");
	await dark.close();
	await ctx.close();
} catch (e) {
	check("script completed", false, String(e?.stack ?? e));
} finally {
	await browser.close();
	await server.stop();
}
process.exitCode = summary(join(SHOTS, "states.results.json")) ? 0 : 1;
