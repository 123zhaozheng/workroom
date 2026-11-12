// Round 12 · message flow rework (DeepSeek Harness style), checked in a real browser against the fixture model (no real AI).
//  A. environment popover: 本地环境 stays in place but is greyed out, hover says 本地应用上线后可用; the button shows the cloud.
//  B. new conversation: the first answer starts with one 准备工作空间 row (measured by the server), then the agent's work.
//  C. while running: thinking streams in a small self-scrolling window under 思考中 · N 秒; adjacent steps form one group that follows
//     its newest row; tool rows are single lines with a running shimmer.
//  D. after the turn: the whole process folds into 已完成，用时 N 秒 ›; rows open only through their chevron row (参数 / 输出); a failure
//     is a red row; no 技术详情 / 查看详情 / 工作区打开 entry anywhere in the conversation.
// Run: npm run -s build:web && node web/e2e/round12-flow.mjs        (port 8992)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { check, chromium, register, sleep, startServer, summary, SHOTS } from "./lib.mjs";

const DIR = join(SHOTS, "round12");
mkdirSync(DIR, { recursive: true });
const PORT = 8992;
const server = await startServer({ port: PORT, env: { WORKROOM_FIXTURE_TPS: "60", WORKROOM_RT_RETRY_MAX: "0" } });
const base = server.base;
const browser = await chromium.launch();
const T = (id) => `[data-testid="${id}"]`;
const shot = (page, name) => page.screenshot({ path: join(DIR, `${name}.png`), fullPage: false });
const call = (tool, args) => `[[call ${tool} ${JSON.stringify(args)}]]`;
const THINK = Array.from({ length: 14 }, (_, i) => `第 ${i + 1} 步：先弄清楚用户要的结果，再决定用哪个工具，最后核对输出是否完整。`).join("\n");

try {
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
	const page = await ctx.newPage();
	await register(page, base, { email: "r12@example.com", name: "十二" });

	// ---------------- A. environment popover
	await page.click(T("env-button"));
	await page.waitForSelector(T("env-popover"));
	const local = page.locator(T("env-local"));
	check("A 本地环境 is still there, greyed out (aria-disabled, not selected)", (await local.getAttribute("aria-disabled")) === "true" && (await local.getAttribute("aria-checked")) === "false" && (await local.innerText()).includes("本地环境"));
	check("A the button shows the cloud", (await page.locator(T("env-button")).getAttribute("data-env-pref")) === "cloud");
	await local.hover();
	const tip = await page.waitForSelector('[role="tooltip"]', { timeout: 3000 }).catch(() => null);
	check("A hovering 本地环境 says 本地应用上线后可用", !!tip && (await tip.innerText()).includes("本地应用上线后可用"));
	await local.click({ force: true });
	check("A clicking it changes nothing", (await page.locator(T("env-button")).getAttribute("data-env-pref")) === "cloud" && (await local.getAttribute("aria-checked")) === "false");
	await shot(page, "A-env-popover");
	await page.keyboard.press("Escape");

	// ---------------- B/C. first message of a new conversation, watched while it runs
	const text = `[[think ${THINK}]] ${call("wr_fixture_echo", { text: "第一次" })} ${call("wr_fixture_wait", { ms: 2500 })} 帮我整理一下`;
	await page.fill(T("composer-input"), text);
	await page.click(T("send"));
	await page.waitForURL(/\/c\/[^/]+\/\d+/);
	await page.waitForSelector(T("workspace-step"), { timeout: 20000 });
	const ws = page.locator(T("workspace-step"));
	check("B the first answer starts with 准备工作空间 (done, with a measured time)", (await ws.getAttribute("data-state")) === "done" && /准备工作空间/.test(await ws.innerText()) && /(ms|秒)/.test(await ws.innerText()), await ws.innerText());
	const first = await page.locator(`${T("step-chain")} >> nth=0`).evaluate((el) => el.querySelector("[data-testid]")?.getAttribute("data-testid"));
	check("B it is the first row of the turn", first === "workspace-step", String(first));

	// thinking streams
	const thinking = await page.waitForSelector(`${T("think-step")}[data-state="running"]`, { timeout: 15000 }).catch(() => null);
	check("C thinking shows as 思考中 while it streams", !!thinking && /思考中/.test(await thinking.innerText()));
	await sleep(700);
	await shot(page, "C-thinking");
	const win = page.locator(T("think-window"));
	const w1 = await win.count() ? await win.evaluate((el) => ({ h: el.clientHeight, sh: el.scrollHeight, top: el.scrollTop, cls: el.className })) : null;
	check("C the thinking window is capped and follows the newest line", !!w1 && w1.h <= 125 && (w1.sh <= w1.h + 2 || w1.top > 0), JSON.stringify(w1));
	const clock = await page.locator(`${T("think-step")} >> text=/\\d+ 秒/`).count();
	check("C the thinking row shows elapsed seconds", clock > 0);
	const shimmer = await page.locator(".wr-shimmer").count();
	check("C running text shimmers", shimmer > 0);

	// tools run inside one group
	await page.waitForSelector(`${T("tool-step")}[data-tool="wr_fixture_wait"]`, { timeout: 20000 });
	await sleep(300);
	await shot(page, "C-running-group");
	const group = page.locator(T("step-group"));
	check("C thinking + tools form one group while running", (await group.count()) === 1 && (await group.locator(T("tool-step")).count()) === 2);
	const runningRow = await page.locator(`${T("tool-step")}[data-state="running"], ${T("tool-step")}[data-state="pending"]`).count();
	check("C the running tool row is visible as running", runningRow >= 1);

	// ---------------- D. after the turn
	await page.waitForSelector(T("stop"), { state: "detached", timeout: 60000 });
	await page.waitForSelector(`${T("run-summary")}[aria-expanded="false"]`, { timeout: 10000 });
	const sumText = await page.locator(T("run-summary")).innerText();
	check("D the finished turn folds into one line 已完成，用时 N 秒", /^已完成，用时 \d+ 秒/.test(sumText.trim()), sumText);
	await page.waitForFunction(() => !document.querySelector('[data-testid="tool-step"]'), null, { timeout: 3000 }).catch(() => {});
	check("D folded: no step rows visible", (await page.locator(`${T("tool-step")}:visible`).count()) === 0);
	await shot(page, "D-folded");
	await page.click(T("run-summary"));
	await page.waitForSelector(`${T("tool-step")}`, { timeout: 3000 });
	const think = page.locator(T("think-step"));
	check("D thinking folded to one line with its measured time", /已思考 \d+ 秒/.test(await think.innerText()), await think.innerText());
	const echo = page.locator(`${T("tool-step")}[data-tool="wr_fixture_echo"]`);
	check("D a tool row: one line, name + duration, chevron, closed", (await echo.locator("button[aria-expanded]").getAttribute("aria-expanded")) === "false" && (await echo.innerText()).split("\n").length <= 2, await echo.innerText());
	await echo.locator("button[aria-expanded]").click();
	const io = await echo.innerText();
	check("D opening the row shows 参数 and 输出", /参数/.test(io) && /输出/.test(io), io.slice(0, 200));
	await shot(page, "D-open-row");
	const body = await page.locator(T("chat-scroll")).innerText();
	check("D no misc detail entries (技术详情 / 查看详情 / 工作区中打开 / 工作面板中查看)", !/技术详情|查看详情|在工作区中打开|在工作面板中查看/.test(body));
	await page.click(T("run-summary"));

	// ---------------- D2. a failing step
	await page.fill(T("composer-input"), `${call("sandbox_read_file", { path: "nope/missing.txt" })} 读一下`);
	await page.click(T("send"));
	await page.waitForSelector(T("stop"), { state: "detached", timeout: 60000 }).catch(() => {});
	await sleep(500);
	const chains = page.locator(T("step-chain"));
	const lastChain = chains.nth((await chains.count()) - 1);
	const lastSum = await lastChain.locator(T("run-summary")).innerText().catch(() => "");
	check("D2 a failed step is counted in red on the folded line", /1 步失败/.test(lastSum), lastSum);
	if ((await lastChain.locator(T("run-summary")).getAttribute("aria-expanded")) === "false") await lastChain.locator(T("run-summary")).click();
	const bad = lastChain.locator(`${T("tool-step")}[data-state="error"]`);
	check("D2 the failed row is red with 失败", (await bad.count()) === 1 && /失败/.test(await bad.innerText()));
	await shot(page, "D2-failed");

	// ---------------- E. mobile width
	await page.setViewportSize({ width: 390, height: 800 });
	await sleep(300);
	const noH = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
	check("E 390px: no horizontal scroll", noH);
	await shot(page, "E-mobile");
	await ctx.close();
} catch (err) {
	check("no exception", false, String(err?.stack ?? err));
} finally {
	await browser.close();
	await server.stop();
}
process.exit(summary(join(DIR, "result.json")) ? 0 : 1);
