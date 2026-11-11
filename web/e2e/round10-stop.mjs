// Round 10 · 停止 / 继续. Fixture model only (no real AI): "[[call wr_fixture_echo {...}]]" is a quick step, "[[call wr_fixture_wait {...}]]" a long one.
//  - after 停止 the message the person sent stays, with every completed step; its label is honest: 「已停止（已完成 N 步）」, never 未应用 / 没有得到回复
//  - the way on is a real 继续 button (server continue): the model answers from the stored context (the answer quotes the completed step)
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
const stopped = () => page.waitForSelector(`${T("run-bar")}[data-status="aborted"]`, { timeout: 20000 });
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
	const stoppedOutcome = outcomes.find((o) => o.kind === "stopped");
	check("stop: its label is 「已停止（已完成 1 步）」", !!stoppedOutcome && stoppedOutcome.text.includes("已停止（已完成 1 步）"), JSON.stringify(outcomes));
	check("stop: the applied message is never called 未应用 / 没有得到回复 / 未送达", !outcomes.some((o) => o.kind === "stopped" && /未应用|没有得到回复|未送达/.test(o.text)) && !(await page.content()).includes("未应用"));
	check("stop: it says the message and completed steps are kept", /保留在对话里/.test(stoppedOutcome?.text ?? ""), stoppedOutcome?.text);
	const sum = await text(T("run-summary"));
	check("stop: the step chain keeps the completed step and says 已停止 (not 失败)", sum.includes("已停止 · 已完成 1 步") && !sum.includes("失败"), sum);
	await page.locator(`${T("step-chain")} button`).first().click();
	const stepStates = await page.locator(T("tool-step")).evaluateAll((els) => els.map((e) => `${e.getAttribute("data-tool")}:${e.getAttribute("data-state")}`));
	check("stop: completed step = done, the cut-off step = stopped", stepStates.join() === "wr_fixture_echo:done,wr_fixture_wait:stopped", stepStates.join());
	const bar = await text(T("run-bar"));
	check("stop: the run bar says 已停止 · 已完成 1 步 and offers a real 继续", bar.includes("已停止") && bar.includes("已完成 1 步") && (await page.locator(T("continue")).innerText()).includes("继续"), bar);
	// the explanation may sit behind a 说明 toggle (round 10 layout): open it if so, then read it
	if (await page.locator(T("run-bar-hint-toggle")).count()) await page.locator(T("run-bar-hint-toggle")).click();
	const hint = (await page.locator(T("run-bar-hint")).textContent()).replace(/\s+/g, " ").trim();
	check("stop: the bar explains honestly: nothing lost, completed steps not redone, the cut-off step is not re-run automatically", /没有丢失/.test(hint) && /不会重做已完成的步骤/.test(hint) && /不会自动重做/.test(hint), hint);
	check("stop: the message that was still queued is back in the composer (not discarded)", (await composerValue()).includes("排队的一条消息"), await composerValue());
	check("stop: and a note says so", /内容已放回输入框/.test(await text(T("stop-note"))), await text(T("stop-note")));
	const unsent = outcomes.find((o) => o.kind === "unsent");
	check("stop: the queued message is also marked 未送达 in the conversation, saying the model never saw it", !!unsent && /未送达模型/.test(unsent.text) && /没有看到/.test(unsent.text), unsent?.text);
	check("stop: that marker has a working 放回输入框", (await page.locator(T("unsent-restore")).count()) === 1);
	await shot(page, "round10/stop-1280-light");

	// survives a reload (all of it is re-read from the server)
	await page.reload();
	await page.waitForSelector(`${T("run-bar")}[data-status="aborted"]`, { timeout: 20000 });
	await page.waitForSelector(T("message-outcome"));
	const again = await page.locator(T("message-outcome")).evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
	check("reload: the same honest labels after a reload", again.includes("stopped") && again.includes("unsent"), again.join());

	// 放回输入框 on the marker puts the text back (and nothing is sent)
	await page.locator(T("composer-input")).fill("");
	await page.locator(T("unsent-restore")).click();
	await page.waitForFunction(() => document.querySelector('[data-testid="composer-input"]')?.value.includes("排队的一条消息"), null, { timeout: 5000 }).catch(() => {});
	check("放回输入框: the unsent text returns to the composer", (await composerValue()).includes("排队的一条消息"), await composerValue());
	await page.locator(T("composer-input")).fill("");

	// ================================================================ 2. 继续 = server continue from the stored context
	const before = (await page.locator(T("user-message")).count());
	await page.click(T("continue"));
	await page.waitForSelector(`${T("run-bar")}`, { state: "detached", timeout: 30000 });
	await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="assistant-message"]')].some((e) => e.textContent.includes("第一步已完成")), null, { timeout: 30000 });
	const answer = await text(T("assistant-message"));
	check("继续: the model answered from the stored context (its answer quotes the step completed before the stop)", answer.includes("第一步已完成"), answer.slice(0, 200));
	check("继续: no new user message was created (it is a continue, not a typed 「继续」)", (await page.locator(T("user-message")).count()) === before);
	const after = await page.locator(T("message-outcome")).evaluateAll((els) => els.map((e) => ({ kind: e.getAttribute("data-kind"), text: e.textContent.replace(/\s+/g, " ").trim() })));
	check("继续: the original message now reads as 已继续完成 (not stuck on 已停止)", after.some((o) => o.kind === "resumed" && /停止过，之后已继续完成/.test(o.text)) && !after.some((o) => o.kind === "stopped"), JSON.stringify(after));
	const sum2 = await text(T("run-summary"));
	check("继续: the turn now reads 已完成 (it has its answer), the cut-off step is still remarked on and was not re-run", sum2.includes("已完成 1 步") && !sum2.includes("已停止") && /1 步被中途截断，没有重做/.test(await page.locator(T("step-chain")).first().innerText()), sum2);
	check("继续: the answer sits in the same turn as the steps (one assistant message)", (await page.locator(T("assistant-message")).count()) === 1);
	await shot(page, "round10/continued-1280-light");

	// ================================================================ 3. stop while an approval is waiting: the card is cancelled
	await start('需要确认 [[call wr_fixture_approval {"title":"发布到外部","summary":"确认后才会发布"}]]');
	await page.waitForSelector(T("approval-card"), { timeout: 20000 });
	await page.click(T("stop"));
	await stopped();
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
	await mp.waitForSelector(`${T("run-bar")}[data-status="aborted"]`, { timeout: 20000 });
	const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
	check("390px: the stopped state fits (no horizontal scroll) and 继续 is a touch-sized target", !overflow && (await mp.locator(T("continue")).boundingBox()).height >= 24, `overflow=${overflow}`);
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
