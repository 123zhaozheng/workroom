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
	{
		await page.getByRole("button", { name: /制度库/ }).click();
		await page.waitForSelector('[data-testid="chip-kb"]');
	}
	await input.fill("根据附件和制度库整理要点 [[reply 已阅读附件与知识库引用。]]");
	await shot(page, "1440-composer-chips");
	check("composer: file chip + knowledge chip in one input", (await page.locator('[data-testid="chip-file"]').count()) === 1 && (await page.locator('[data-testid="chip-kb"]').count()) === 1);
	await page.click('[data-testid="send"]');
	await page.waitForURL(/\/c\//);
	await page.waitForSelector('[data-testid="assistant-message"]', { timeout: 20000 });
	const userText = await page.locator('[data-testid="user-message"]').first().innerText();
	check("chat: sent message carries attachment and knowledge references", userText.includes("会议纪要.txt") && userText.includes("制度库"), userText.slice(0, 80));
	const convUrl = page.url();

	// ---------------------------------------------------------------- M01-C: code / table / formula; streaming == history
	const reqs = [];
	page.on("request", (r) => reqs.push(r.url()));
	await sendMessage(page, "[[reply 结果如下：\n\n```js\nconst total = items.reduce((a, b) => a + b, 0);\n```\n\n| 指标 | 数值 |\n|---|---|\n| 收入 | 120 |\n| 成本 | 80 |\n\n利润率 $p = \\frac{40}{120}$。]]");
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="assistant-message"]').length >= 2, null, { timeout: 20000 });
	const last = page.locator('[data-testid="assistant-message"]').last();
	await last.locator("table").waitFor({ timeout: 15000 });
	await last.locator(".katex").first().waitFor({ timeout: 15000 });
	await sleep(800);
	check("markdown: code block, table and formula rendered", (await last.locator("pre").count()) > 0 && (await last.locator("table").count()) > 0 && (await last.locator(".katex").count()) > 0);
	check("markdown: highlighter / katex chunks loaded only when needed", reqs.some((u) => /katex/i.test(u)) && reqs.some((u) => /shiki|javascript-|wasm-|index-.*code|code-/i.test(u) || /streamdown.*code/i.test(u)), reqs.filter((u) => /katex|shiki|javascript|wasm/.test(u)).slice(0, 3).join(", "));
	check("markdown: copy and export actions present", (await last.locator('[data-testid="action-copy"]').count()) > 0 && (await last.locator('[data-testid="action-export"]').count()) > 0);
	const liveHtml = (await last.locator(".wr-prose").first().innerText()).trim();
	await shot(page, "1440-markdown-rich");
	await page.reload();
	await page.locator('[data-testid="assistant-message"]').last().locator(".katex").first().waitFor({ timeout: 15000 });
	await sleep(800);
	const histHtml = (await page.locator('[data-testid="assistant-message"]').last().locator(".wr-prose").first().innerText()).trim();
	check("markdown: streamed and reloaded (history) rendering identical", liveHtml === histHtml, liveHtml === histHtml ? `${liveHtml.length} chars` : `live=${liveHtml.slice(0, 60)} | hist=${histHtml.slice(0, 60)}`);

	// ---------------------------------------------------------------- failed with reason
	await sendMessage(page, "[[fail]] 这一步会失败");
	await page.waitForSelector('[data-testid="run-bar"][data-status="failed"], [data-testid="run-bar"][data-status="interrupted"]', { timeout: 60000 });
	await sleep(300);
	const failText = await page.locator('[data-testid="run-bar"]').innerText();
	check("state: failed shown with reason + 重试/继续", /重试|继续/.test(failText), failText.replace(/\s+/g, " "));
	await shot(page, "1440-state-failed");

	// ---------------------------------------------------------------- cancelled
	await sendMessage(page, "[[slow 20000]] 一个很慢的任务");
	await page.waitForSelector('[data-testid="stop"]', { timeout: 10000 });
	await sleep(500);
	await shot(page, "1440-state-running");
	// second device (phone) on the same conversation sees the same live state
	const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
	const pp = await phone.newPage();
	await pp.goto(page.url());
	await pp.waitForSelector('[data-testid="stop"]', { timeout: 15000 });
	check("cross-device: phone shows the same running state", true);
	await shot(pp, "390-same-task-running");
	await page.click('[data-testid="stop"]');
	await page.waitForSelector('[data-testid="stop"]', { state: "detached", timeout: 15000 });
	await sleep(500);
	check("state: cancelled is its own terminal state — the run simply ends (round 11: no run bar, no 已停止 chip, no 继续 button)", (await page.locator('[data-testid="run-bar"], [data-testid="run-status"], [data-testid="continue"]').count()) === 0);
	await shot(page, "1440-state-cancelled");
	await pp.waitForSelector('[data-testid="stop"]', { state: "detached", timeout: 15000 });
	check("cross-device: cancel on desktop is reflected on phone (its stop button is gone, no bar)", (await pp.locator('[data-testid="run-bar"]').count()) === 0);
	await phone.close();

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

	// ---------------------------------------------------------------- knowledge failure is shown honestly (M06-A)
	{
		const kb = await kbRes.json();
		const kbId = (kb.kb ?? kb).id;
		await page.goto(`${base}/knowledge/${kbId}`);
		await page.setInputFiles('[data-testid="kb-upload-input"]', { name: "设备数据.bin", mimeType: "application/octet-stream", buffer: Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37) % 256)) });
		await page.waitForSelector('[data-testid="kb-doc"]', { timeout: 15000 });
		await page.waitForSelector('[data-testid="kb-doc"][data-availability="failed"], [data-testid="kb-doc"][data-availability="ready"]', { timeout: 30000 });
		const av = await page.locator('[data-testid="kb-doc"]').first().getAttribute("data-availability");
		const txt = await page.locator('[data-testid="kb-doc"]').first().innerText();
		check("knowledge: unparseable upload shows 失败 + reason (never 可检索)", av === "failed" && txt.includes("失败原因"), `${av}: ${txt.replace(/\s+/g, " ").slice(0, 120)}`);
		await shot(page, "1440-knowledge-failed");
	}

	// ---------------------------------------------------------------- project page
	const pr = await (await page.request.post(`${base}/api/projects`, { data: { kind: "space", name: "新品发布" } })).json();
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
	await page.click('[data-testid="user-menu"]');
	check("admin entry visible for org owner", me.me.orgRole === "owner" && (await page.locator('[data-testid="menu-admin"]').count()) === 1);
	await page.keyboard.press("Escape");

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
