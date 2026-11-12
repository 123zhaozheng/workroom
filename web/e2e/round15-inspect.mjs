// Round 15: Harness 检视 (admin switch → bug button on a reply → drawer with every model request) and the floating work card.
// Run: npm run -s build:web && node web/e2e/round15-inspect.mjs
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { check, chromium, register, sleep, startServer, summary, SHOTS } from "./lib.mjs";

const PORT = 8997;
const DIR = join(SHOTS, "round15");
mkdirSync(DIR, { recursive: true });
const server = await startServer({ port: PORT, env: { WORKROOM_FIXTURE_TPS: "200", WORKROOM_RT_RETRY_MAX: "0" } });
const base = server.base;
const browser = await chromium.launch();
const T = (id) => `[data-testid="${id}"]`;
const call = (tool, args) => `[[call ${tool} ${JSON.stringify(args)}]]`;
const shot = (page, name) => page.screenshot({ path: join(DIR, `${name}.png`), fullPage: false });

try {
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
	const page = await ctx.newPage();
	await register(page, base, { email: "r15@example.com", name: "十五" });

	/** Send a message and wait until the reply's action bar is there (the turn has settled). */
	let turns = 0;
	const say = async (text) => {
		await page.fill(T("composer-input"), text);
		await page.click(T("send"));
		turns++;
		await page.waitForURL(/\/c\/[^/]+\/\d+/);
		await page.waitForFunction((n) => document.querySelectorAll('[data-testid="action-copy"]').length >= n, turns, { timeout: 30000 });
		await sleep(500);
	};

	await say(`先写个文件 ${call("write", { path: "/work/a.md", content: "# hi" })}`);
	check("switch off: no bug button on the reply", (await page.locator(T("action-inspect")).count()) === 0);
	const chatUrl = page.url();

	await page.goto(`${base}/admin?tab=harness`);
	await page.waitForSelector(T("admin-harness-inspect-switch"));
	await shot(page, "admin-switch-off");
	await page.click(T("admin-harness-inspect-switch"));
	await page.waitForFunction(() => document.querySelector('[data-testid="admin-harness-inspect-switch"]')?.getAttribute("aria-checked") === "true");
	await sleep(300);
	await shot(page, "admin-switch-on");

	await page.goto(chatUrl);
	await page.waitForSelector(T("action-copy"));
	await say(`再写一个 ${call("write", { path: "/work/b.md", content: "# again" })}`);
	check("switch on: the reply has a bug button", (await page.locator(T("action-inspect")).count()) > 0);
	const bug = page.locator(T("action-inspect")).last();
	await bug.hover();
	await shot(page, "bug-button");
	await bug.click();
	await page.waitForSelector(T("inspect-round"));
	await sleep(600);
	const rounds = await page.locator(T("inspect-round")).count();
	check("drawer: a tool-using reply has at least two rounds", rounds >= 2, String(rounds));
	const text = await page.locator(T("harness-inspect-drawer")).innerText();
	check("drawer: shows 系统提示词 / 工具 / 消息", ["系统提示词", "工具", "消息"].every((s) => text.includes(s)));
	await shot(page, "drawer-round");
	await page.locator(T("inspect-round")).last().click();
	await sleep(400);
	await shot(page, "drawer-last-round");
	await page.click(T("inspect-build-tab"));
	await sleep(400);
	await shot(page, "drawer-build");
	await page.keyboard.press("Escape");

	await sleep(300);
	if ((await page.locator(T("work-float")).count()) === 0) await page.click(T("open-work-panel"));
	await sleep(700);
	const w = await page.evaluate(() => document.querySelector('[data-testid="work-float"] [data-testid="work-panel"]')?.getBoundingClientRect().width ?? 0);
	check("work card floats (≤380px wide)", w > 0 && w <= 380, String(w));
	await shot(page, "work-card");
} catch (e) {
	check("script ran to the end", false, String(e?.stack ?? e));
} finally {
	await browser.close();
	await server.stop();
}
process.exitCode = summary(join(SHOTS, "round15-inspect.json")) ? 0 : 1;
