// Round 10 · 停止. Fixture model only (no real AI): "[[call wr_fixture_echo {...}]]" is a quick step, "[[call wr_fixture_wait {...}]]" a long one.
// Round 11 (simplification, intentional): 停止就停止 — NO bar, banner, note or outcome line appears after a stop (no run bar, no 继续 button, no
// stop-note, no 「已停止（已完成 N 步）」 label). What stays is the conversation itself: the message, the completed steps (the step chain says 已停止),
// and typing a new message simply continues.
//  - a message still queued when the run is stopped is 未送达 (pi-durable withdraws it) and comes back into the composer, plus 放回输入框 on its marker
//  - a stop while an approval is waiting cancels the card (no dead 允许 button)
// Run: npm run -w web build && node web/e2e/round10-stop.mjs        (port 8943)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { check, chromium, register, sendMessage, shot, sleep, startServer, summary, SHOTS } from "./lib.mjs";

mkdirSync(join(SHOTS, "round10"), { recursive: true });
const PORT = 8943;
const server = await startServer({ port: PORT, env: { WORKROOM_RT_RETRY_MAX: "0" } });
const base = server.base;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
await register(page, base, { email: "r10stop@example.com", name: "停止测试" });

const T = (id) => `[data-testid="${id}"]`;
const text = async (sel, p = page) => ((await p.locator(sel).allInnerTexts()).join(" | ") || "").replace(/\s+/g, " ").trim();
const start = async (msg) => {
	await page.goto(`${base}/`);
	await page.waitForSelector(T("home-greeting"));
	await sendMessage(page, msg);
	await page.waitForURL(/\/c\//);
};
const stepsDone = (n) => page.waitForFunction((n) => [...document.querySelectorAll('[data-testid="run-summary"]')].some((e) => e.textContent.includes(`已完成 ${n} 步`)), n, { timeout: 20000 });
// nothing is announced after a stop: wait for the step chain to say 已停止 (and the stop button to be gone) instead of a bar
const stopped = () => page.waitForFunction(() => !document.querySelector('[data-testid="stop"]') && [...document.querySelectorAll('[data-testid="run-summary"]')].some((e) => e.textContent.includes("已停止")), null, { timeout: 20000 });
const noStopChrome = async (p = page) => (await p.locator(`${T("run-bar")}, ${T("run-bar-hint")}, ${T("stop-note")}, ${T("continue")}`).count()) === 0;
const composerValue = () => page.locator(T("composer-input")).inputValue();

try {
	// ================================================================ 1. the reported case: stop after some steps, with one more message queued
	await start('你帮我随意改一下我在做测试 [[call wr_fixture_echo {"text":"第一步已完成"}]] [[call wr_fixture_wait {"ms":120000}]]');
	await page.waitForSelector(T("stop"), { timeout: 15000 });
	await stepsDone(1);
	await page.locator(T("composer-input")).fill("排队的一条消息");
	await page.click(T("send"));
	await page.waitForSelector(T("queue-item"), { timeout: 10000 });
	await page.click(T("stop"));
	await stopped();
	await sleep(400);

	const userTexts = await text(T("user-bubble"));
	check("stop: the message the person sent is still in the conversation", userTexts.includes("你帮我随意改一下我在做测试"), userTexts);
	const outcomes = await page.locator(T("message-outcome")).evaluateAll((els) => els.map((e) => ({ kind: e.getAttribute("data-kind"), text: e.textContent.replace(/\s+/g, " ").trim() })));
	check("stop: no 已停止 label, no 保留在对话里 sentence and no 未应用 / 没有得到回复 on the message (only the unsent one has a marker)", !outcomes.some((o) => o.kind === "stopped" || o.kind === "resumed") && !(await page.content()).includes("未应用") && !(await page.locator("body").innerText()).includes("保留在对话里"), JSON.stringify(outcomes));
	check("stop: no bar of any kind — no run bar, hint, 继续 button or stop note", await noStopChrome());
	const sum = await text(T("run-summary"));
	check("stop: the step chain keeps the completed step and says 已停止 (not 失败)", sum.includes("已停止 · 已完成 1 步") && !sum.includes("失败"), sum);
	await page.locator(`${T("step-chain")} button`).first().click();
	const stepStates = await page.locator(T("tool-step")).evaluateAll((els) => els.map((e) => `${e.getAttribute("data-tool")}:${e.getAttribute("data-state")}`));
	check("stop: completed step = done, the cut-off step = stopped", stepStates.join() === "wr_fixture_echo:done,wr_fixture_wait:stopped", stepStates.join());
	check("stop: the message that was still queued is back in the composer (not discarded)", (await composerValue()).includes("排队的一条消息"), await composerValue());
	check("stop: no note about it either (the text simply is in the box)", (await page.locator(T("stop-note")).count()) === 0 && !(await page.locator("body").innerText()).includes("内容已放回输入框"));
	const unsent = outcomes.find((o) => o.kind === "unsent");
	check("stop: the queued message is also marked 未送达 in the conversation, nothing more than 未送达 · 放回输入框", !!unsent && unsent.text.replace(/\s+/g, "") === "未送达放回输入框", unsent?.text);
	check("stop: that marker has a working 放回输入框", (await page.locator(T("unsent-restore")).count()) === 1);
	await shot(page, "round10/stop-1280-light");

	// survives a reload (all of it is re-read from the server)
	await page.reload();
	await stopped();
	await page.waitForSelector(T("message-outcome"));
	const again = await page.locator(T("message-outcome")).evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
	check("reload: the same after a reload — the step chain still says 已停止, the unsent marker is back, still no bar", again.join() === "unsent" && (await noStopChrome()), again.join());

	// 放回输入框 on the marker puts the text back (and nothing is sent)
	await page.locator(T("composer-input")).fill("");
	await page.locator(T("unsent-restore")).click();
	await page.waitForFunction(() => document.querySelector('[data-testid="composer-input"]')?.value.includes("排队的一条消息"), null, { timeout: 5000 }).catch(() => {});
	check("放回输入框: the unsent text returns to the composer", (await composerValue()).includes("排队的一条消息"), await composerValue());
	await page.locator(T("composer-input")).fill("");

	// ================================================================ 2. typing a new message simply continues (no 继续 button exists)
	const before = await page.locator(T("user-message")).count();
	await sendMessage(page, "接着做");
	await page.waitForFunction((n) => document.querySelectorAll('[data-testid="user-message"]').length === n + 1, before, { timeout: 20000 });
	await page.waitForSelector(T("stop"), { state: "detached", timeout: 60000 });
	await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="assistant-message"]')].some((e, i, all) => i === all.length - 1 && e.textContent.trim().length > 0), null, { timeout: 30000 });
	const userTexts2 = await text(T("user-bubble"));
	check("continue by typing: the new message is added, the first message and its steps are still there", userTexts2.includes("你帮我随意改一下我在做测试") && userTexts2.includes("接着做") && (await page.locator(T("step-chain")).count()) >= 1, userTexts2);
	check("continue by typing: the run is answered and nothing announces the earlier stop", (await page.locator(T("assistant-message")).count()) >= 2 && (await noStopChrome()) && !(await page.locator(T("message-outcome")).evaluateAll((els) => els.some((e) => ["stopped", "resumed"].includes(e.getAttribute("data-kind"))))));
	await shot(page, "round10/continued-1280-light");

	// ================================================================ 3. stop while an approval is waiting: the card is cancelled
	await start('需要确认 [[call wr_fixture_approval {"title":"发布到外部","summary":"确认后才会发布"}]]');
	await page.waitForSelector(T("approval-card"), { timeout: 20000 });
	await page.click(T("stop"));
	await page.waitForSelector(T("stop"), { state: "detached", timeout: 20000 });
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="approval-card"]').length === 0, null, { timeout: 10000 });
	check("stop while waiting for approval: the card is gone (cancelled), no dead 允许 button", (await page.locator(T("approval-card")).count()) === 0 && (await page.locator(T("approve")).count()) === 0);
	await page.locator(`${T("step-chain")} button`).first().click();
	const appr = await text(T("tool-step"));
	check("stop while waiting for approval: the step says 已停止", /已停止/.test(appr), appr);
	await shot(page, "round10/stop-approval-1280-light");

	// ================================================================ 4. dark + phone width
	await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
	await sleep(300);
	await shot(page, "round10/stop-approval-1280-dark");
	const mob = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
	const mp = await mob.newPage();
	await mp.goto(`${base}/login`);
	await mp.fill("#email", "r10stop@example.com");
	await mp.fill("#password", "password123");
	await mp.click('button[type="submit"]');
	await mp.waitForSelector(T("home-greeting"));
	await mp.goto(page.url());
	await mp.waitForSelector(T("run-summary"), { timeout: 20000 });
	const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
	check("390px: the stopped state fits (no horizontal scroll) and shows no bar", !overflow && (await noStopChrome(mp)), `overflow=${overflow}`);
	await mp.screenshot({ path: join(SHOTS, "round10/stop-390-light.png") });
	await mp.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
	await sleep(300);
	await mp.screenshot({ path: join(SHOTS, "round10/stop-390-dark.png") });
	await mob.close();
} catch (e) {
	check("script ran to the end", false, String(e?.stack ?? e).slice(0, 600));
	await shot(page, "round10/stop-failure").catch(() => {});
} finally {
	const ok = summary(join(SHOTS, "round10/round10-stop-results.json"));
	await browser.close();
	await server.stop();
	process.exitCode = ok ? 0 : 1;
}
