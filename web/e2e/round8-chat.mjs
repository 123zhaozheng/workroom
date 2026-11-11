// Round 8 · composer + message queue (Q1). Fixture model only (no real AI): "[[slow N]]" holds a run, "[[fail]]" fails it,
// "[[call wr_fixture_approval {...}]]" asks for approval (WORKROOM_FIXTURE_TOOLS=1).
//  - no running bar above the input, no 插话 / 稍后处理 choice; 停止 stays in the composer; approval card stays in the conversation
//  - messages sent while a run works go to a compact server-side queue (in order, attachments kept), then run in order
//  - each queued item: 立即发送 / 撤销 on hover, keyboard focus and tap; 撤销 restores text + attachment; 立即发送 explains itself
//  - refresh keeps the queue; a second tab shows the same queue; offline send fails visibly and 重试 sends exactly once
//  - failed run: queued items stay, are not run automatically, and offer 重试 / 删除
// Run: npm run -w web build && node web/e2e/round8-chat.mjs        (port 8911)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { check, chromium, register, sendMessage, shot, sleep, startServer, summary, SHOTS } from "./lib.mjs";

mkdirSync(join(SHOTS, "round8"), { recursive: true });
const PORT = 8911;
const server = await startServer({ port: PORT, env: { WORKROOM_RT_RETRY_MAX: "0" } });
const base = server.base;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
await register(page, base, { email: "r8chat@example.com", name: "队列测试" });

const T = (id) => `[data-testid="${id}"]`;
// "shown" = rendered AND not faded out (actions are faded in on hover / focus; they stay laid out so Tab can reach them)
const shown = async (loc) => { await sleep(260); return loc.evaluate((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && Number(getComputedStyle(el.closest('[data-testid="queue-actions"]') ?? el).opacity) > 0.5 && getComputedStyle(el).display !== "none"; }); };
const items = (p = page) => p.locator(T("queue-item"));
const itemTexts = async (p = page) => (await items(p).locator(T("queue-text")).allInnerTexts()).map((t) => t.trim());
const userTexts = async (p = page) => (await p.locator(T("user-message")).allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
const start = async (text) => {
	await page.goto(`${base}/`);
	await page.waitForSelector(T("home-greeting"));
	await sendMessage(page, text);
	await page.waitForURL(/\/c\//);
};
const busy = () => page.waitForSelector(T("stop"), { timeout: 15000 });
const idle = (t = 60000) => page.waitForSelector(T("stop"), { state: "detached", timeout: t });
const queueCount = async (n, p = page, t = 10000) => {
	await p.waitForFunction((n) => document.querySelectorAll('[data-testid="queue-item"]').length === n, n, { timeout: t });
	return true;
};
const sendQueued = async (text) => {
	await page.locator(T("composer-input")).fill(text);
	await page.click(T("send"));
	await page.waitForFunction(() => document.querySelector('[data-testid="composer-input"]')?.value === "", null, { timeout: 10000 });
};

try {
	// ================================================================ 1. no run bar / no steer choice while running
	await start("[[slow 12000]] 先跑一个慢任务");
	await busy();
	await page.waitForSelector(T("composer-input") + ":not([disabled])");
	check("running: no run bar above the input", (await page.locator(T("run-bar")).count()) === 0);
	check("running: no 插话 / 稍后处理 choice anywhere", (await page.getByText("插话").count()) === 0 && (await page.getByText("稍后处理").count()) === 0 && (await page.locator('[role="radiogroup"]').count()) === 0);
	check("running: 停止 is in the composer", await page.locator(`${T("composer")} ${T("stop")}`).isVisible());
	check("running [round 11]: the input only says 继续输入… (no sentence about what a sent message does)", /^继续输入/.test((await page.locator(T("composer-input")).getAttribute("placeholder")) ?? "") && !/自动处理|当前任务结束后/.test((await page.locator(T("composer-input")).getAttribute("placeholder")) ?? ""));
	check("running: nothing queued → no queue box", (await page.locator(T("message-queue")).count()) === 0);

	// ================================================================ 2. three messages while it runs → compact queue, in order
	await sendQueued("第二条：整理一下要点");
	await page.setInputFiles(T("file-input"), { name: "报价单.txt", mimeType: "text/plain", buffer: Buffer.from("quote v1") });
	await page.waitForSelector(`${T("chip-file")}`);
	await page.waitForFunction(() => !document.querySelector('[data-testid="chip-file"][data-state="uploading"]'), null, { timeout: 15000 }).catch(() => {});
	await sleep(600);
	await sendQueued("第三条：附带报价单 [[reply 好]]");
	await sendQueued("第四条：最后说结论");
	await queueCount(3);
	const q0 = await itemTexts();
	check("queue: three items in send order, test directives hidden", q0.length === 3 && q0[0].includes("第二条") && q0[1] === "第三条：附带报价单" && q0[2].includes("第四条"), q0.join(" | "));
	check("queue: the attachment shows on its own item only", (await items().nth(1).locator(T("queue-attachments")).innerText()).includes("报价单.txt") && (await items().nth(0).locator(T("queue-attachments")).count()) === 0);
	check("queue [round 11]: the header is just 「排队 3 条」 — no explanation of when they are sent", (await page.locator(T("queue-title")).innerText()).trim() === "排队 3 条" && (await page.locator(T("queue-detail")).count()) === 0 && !(await page.locator(T("message-queue")).innerText()).includes("自动发送"));
	check("queue: compact (height under 190px)", (await page.locator(T("message-queue")).boundingBox()).height < 190);
	check("queue: still no run bar, composer stays usable", (await page.locator(T("run-bar")).count()) === 0 && (await page.locator(T("composer-input")).isEnabled()));
	check("queue: sending never navigated away or showed an error", !(await page.locator(T("composer-error")).count()));
	await shot(page, "round8/q1-queue-1280");

	// ================================================================ 3. discoverable: hover, keyboard focus, tap
	const it1 = items().nth(0);
	check("actions are hidden until hover / focus / tap (no clutter)", !(await shown(it1.locator(T("queue-send-now")))));
	await it1.hover();
	check("hover reveals 立即发送 and 撤销", (await shown(it1.locator(T("queue-send-now")))) && (await shown(it1.locator(T("queue-undo")))));
	await page.mouse.move(5, 5);
	await page.locator(T("composer-input")).focus();
	const active = () => page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
	await page.keyboard.press("Shift+Tab");
	const it3 = items().nth(2);
	check("keyboard: Shift+Tab from the input reaches the last item's 撤销, and its actions are shown", (await active()) === "queue-undo" && (await shown(it3.locator(T("queue-undo")))));
	await page.keyboard.press("Shift+Tab");
	check("keyboard: Shift+Tab again reaches 立即发送", (await active()) === "queue-send-now");
	await page.keyboard.press("Shift+Tab");
	check("keyboard: and then the row itself", (await active()) === "queue-row");
	await page.keyboard.press("Tab");
	check("keyboard: Tab from the row moves to 立即发送 (actions stay shown while focused)", (await active()) === "queue-send-now" && (await shown(it3.locator(T("queue-send-now")))));
	await page.locator(T("composer-input")).focus();
	await it1.locator(T("queue-row")).click();
	check("tap/click opens the row's actions; round 11: no explanation paragraph is added (the buttons say what they do)", (await it1.getAttribute("data-open")) === "true" && (await it1.locator(T("queue-hint")).count()) === 0 && !/不会打断正在执行的工具/.test(await it1.innerText()));
	await it1.locator(T("queue-row")).click();

	// ================================================================ 4. 撤销 restores text + attachment into the composer
	const it2 = items().nth(1);
	await it2.hover();
	await it2.locator(T("queue-undo")).click();
	await page.waitForFunction(() => document.querySelector('[data-testid="composer-input"]')?.value.includes("第三条"), null, { timeout: 10000 });
	await queueCount(2);
	check("撤销: the text is back in the input for editing", (await page.locator(T("composer-input")).inputValue()).includes("第三条：附带报价单"));
	check("撤销: the attachment is back as a chip", (await page.locator(T("chip-file")).count()) === 1 && (await page.locator(T("chip-file")).innerText()).includes("报价单.txt"));
	check("撤销: the queue shrank — and no banner says so (the text is back in the box)", (await itemTexts()).length === 2 && (await page.locator(T("queue-notice")).count()) === 0);
	check("撤销: no ghost 'unsent' bubble in the conversation", !(await userTexts()).some((t) => t.includes("第三条")));
	// edit and send again → goes to the end of the queue
	await page.locator(T("composer-input")).fill("第三条（改过）：附带报价单");
	await page.click(T("send"));
	await queueCount(3);
	const q1 = await itemTexts();
	check("edited message re-queues at the end, attachment kept", q1[2] === "第三条（改过）：附带报价单" && (await items().nth(2).locator(T("queue-attachments")).innerText()).includes("报价单.txt"), q1.join(" | "));

	// ================================================================ 5. refresh and a second tab show the same server queue
	await page.reload();
	await page.waitForSelector(T("message-queue"));
	await queueCount(3);
	check("refresh: the queue is still there, same order", JSON.stringify(await itemTexts()) === JSON.stringify(q1), (await itemTexts()).join(" | "));
	const tab2 = await ctx.newPage();
	await tab2.goto(page.url());
	await tab2.waitForSelector(T("message-queue"));
	await queueCount(3, tab2);
	check("second tab: shows the same queue (from the server)", JSON.stringify(await itemTexts(tab2)) === JSON.stringify(q1));
	// an action in tab 2 shows up in tab 1
	await items(tab2).nth(0).hover();
	await items(tab2).nth(0).locator(T("queue-undo")).click();
	await queueCount(2, tab2);
	await queueCount(2, page);
	check("second tab: undoing there removes it here too; its text lands in tab 2's input only", (await tab2.locator(T("composer-input")).inputValue()).includes("第二条") && (await page.locator(T("composer-input")).inputValue()) === "");
	await tab2.screenshot({ path: join(SHOTS, "round8/q1-second-tab.png") });
	await tab2.close();
	// put it back so the order test below is complete: send from tab 1
	await sendQueued("第二条：整理一下要点（重发）");
	await queueCount(3);

	// ================================================================ 6. 立即发送 → handed to the running task; honest wording
	const last = items().nth(2);
	await last.hover();
	const sendReq = page.waitForResponse((r) => /\/promote$/.test(r.url()) && r.request().method() === "POST", { timeout: 10000 });
	await last.locator(T("queue-send-now")).click();
	const pr = await (await sendReq).json();
	check("立即发送: server answers promoted/steered", pr.result === "promoted" && pr.effect === "steered", JSON.stringify({ r: pr.result, e: pr.effect }));
	await page.waitForSelector(`${T("queue-item")}[data-mode="steer"]`);
	check("立即发送: no success banner; the item itself says 已交给任务 and offers only 撤销", (await page.locator(T("queue-notice")).count()) === 0 && (await page.locator(`${T("queue-item")}[data-mode="steer"] ${T("queue-steered")}`).innerText()).trim() === "已交给任务" && (await page.locator(`${T("queue-item")}[data-mode="steer"] ${T("queue-send-now")}`).count()) === 0);
	await shot(page, "round8/q1-after-send-now");

	// ================================================================ 7. stop works; queued messages are not silently lost
	await page.click(T("stop"));
	await idle(20000);
	await queueCount(0, page, 15000).catch(() => {});
	await sleep(500);
	check("stop [round 11]: the run just ends — no run bar, no 继续 button, no banner", (await page.locator(`${T("run-bar")}, ${T("continue")}, ${T("stop-note")}`).count()) === 0);
	const unsent = await page.locator(T("message-outcome")).allInnerTexts();
	check("stop: queued messages are shown as 未送达 in the conversation (pi-durable drops them on cancel), none vanish", unsent.filter((t) => t.includes("未送达")).length >= 3 && !unsent.some((t) => t.includes("未送达模型")), `${unsent.length} markers`);

	// ================================================================ 8. queued messages run in order after the current task
	await start("[[slow 3500]] 顺序一");
	await busy();
	await sendQueued("顺序二");
	await sendQueued("顺序三");
	await sendQueued("顺序四");
	await queueCount(3);
	await idle(90000);
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="queue-item"]').length === 0, null, { timeout: 30000 });
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="user-message"]').length === 4, null, { timeout: 60000 });
	await idle(90000);
	const order = (await userTexts()).map((t) => /顺序[一二三四]/.exec(t)?.[0] ?? t);
	check("order: all three ran one after another in the order they were sent", JSON.stringify(order) === JSON.stringify(["顺序一", "顺序二", "顺序三", "顺序四"]), order.join(","));
	check("order: the queue is empty afterwards and there is no run bar", (await page.locator(T("message-queue")).count()) === 0 && (await page.locator(T("run-bar")).count()) === 0);

	// ================================================================ 9. offline: failed send keeps the text, 重试 sends exactly once
	await start("[[slow 14000]] 离线测试的慢任务");
	await busy();
	await ctx.setOffline(true);
	await page.locator(T("composer-input")).fill("离线时发的消息");
	await page.click(T("send"));
	await page.waitForSelector(T("composer-error"), { timeout: 10000 });
	const errText = await page.locator(T("composer-error")).innerText();
	check("offline: the send fails visibly with 重试 and says the text is kept", /没有发出/.test(errText) && errText.includes("内容还在输入框") && errText.includes("重试") && (await page.locator(T("composer-retry")).count()) === 1, errText.replace(/\s+/g, " "));
	check("offline: the text stays in the input", (await page.locator(T("composer-input")).inputValue()) === "离线时发的消息");
	check("offline: the queue shows nothing for it", !(await itemTexts()).some((t) => t.includes("离线时发的消息")));
	await shot(page, "round8/q1-offline-failed");
	await ctx.setOffline(false);
	await page.click(T("composer-retry"));
	await page.waitForFunction(() => document.querySelector('[data-testid="composer-input"]')?.value === "", null, { timeout: 15000 });
	await queueCount(1);
	check("offline: 重试 sends it once; text cleared, error gone", (await itemTexts())[0] === "离线时发的消息" && (await page.locator(T("composer-error")).count()) === 0);
	// the same content retried again (e.g. a lost response) must not duplicate: same requestId → one item
	await page.click(T("stop"));
	await idle(20000);

	// ================================================================ 10. approval pending: card stays, queue waits, 立即发送 never skips it
	await start('[[call wr_fixture_approval {"title":"发布周报","summary":"确认后才会发布","risk":"medium"}]] 请先确认');
	await page.waitForSelector(T("approval-card"), { timeout: 30000 });
	await sleep(300);
	check("approval: the card is in the conversation; no run bar", (await page.locator(T("approval-card")).isVisible()) && (await page.locator(T("run-bar")).count()) === 0);
	await sendQueued("确认之后再处理这条");
	await queueCount(1);
	await items().nth(0).hover();
	await items().nth(0).locator(T("queue-send-now")).click();
	await page.waitForSelector(`${T("queue-item")}[data-mode="steer"]`);
	check("approval: 立即发送 marks the item 已交给任务 (no banner, no explanation text)", (await page.locator(`${T("queue-item")}[data-mode="steer"] ${T("queue-steered")}`).innerText()).trim() === "已交给任务" && (await page.locator(T("queue-notice")).count()) === 0);
	await sleep(800);
	check("approval: the approval is still pending and the message has not reached the model", (await page.locator(T("approval-card")).isVisible()) && !(await userTexts()).some((t) => t.includes("确认之后再处理这条")));
	await shot(page, "round8/q1-approval-pending");
	await page.locator(`${T("approval-card")} ${T("approve")}`).click();
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="user-message"]').length === 2, null, { timeout: 30000 });
	await idle(60000);
	check("approval: after the decision the handed-over message is processed", (await userTexts()).some((t) => t.includes("确认之后再处理这条")));

	// ================================================================ 11. failed run: queue kept, not auto-run, 重试 / 删除
	await start("[[slow 3000]] [[fail]] 这一轮会失败");
	await busy();
	await sendQueued("失败后的第一条");
	await sendQueued("失败后的第二条");
	await page.waitForSelector(`${T("run-bar")}[data-status="failed"], ${T("run-bar")}[data-status="interrupted"]`, { timeout: 60000 });
	await sleep(1500);
	check("failed: both messages are still queued, not sent automatically", (await itemTexts()).length === 2 && (await userTexts()).length === 1, (await itemTexts()).join(" | "));
	const fh = (await page.locator(T("queue-title")).innerText()).trim();
	check("failed [round 11]: the queue just says 「2 条消息未发出」 (no paragraph about the failed task / 重试)", fh === "2 条消息未发出" && (await page.locator(T("queue-detail")).count()) === 0, fh);
	await items().nth(0).hover();
	check("failed: each item offers 立即发送 / 撤销 / 删除", (await shown(items().nth(0).locator(T("queue-delete")))) && (await shown(items().nth(0).locator(T("queue-send-now")))));
	await shot(page, "round8/q1-failed-queue");
	await items().nth(0).locator(T("queue-delete")).click();
	await queueCount(1);
	check("failed: 删除 removes only that item", (await itemTexts())[0].includes("失败后的第二条") && (await page.locator(T("queue-notice")).count()) === 0);
	await page.click(T("continue"));
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="queue-item"]').length === 0, null, { timeout: 30000 });
	await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="user-message"]')].some((e) => e.textContent.includes("失败后的第二条")), null, { timeout: 30000 });
	check("failed: 重试 continues and sends what was still queued", true);
	await idle(60000);

	// ================================================================ 12. 390px (tap) + dark
	const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
	await mob.addCookies(await ctx.cookies());
	const mp = await mob.newPage();
	await mp.goto(`${base}/`);
	await mp.waitForSelector(T("home-greeting"));
	await sendMessage(mp, "[[slow 20000]] 手机上的慢任务");
	await mp.waitForURL(/\/c\//);
	await mp.waitForSelector(T("stop"), { timeout: 15000 });
	for (const t of ["手机排队一：附上一段比较长的说明文字看看是否会撑破布局", "手机排队二"]) {
		await mp.locator(T("composer-input")).fill(t);
		await mp.click(T("send"));
		await mp.waitForFunction(() => document.querySelector('[data-testid="composer-input"]')?.value === "", null, { timeout: 10000 });
	}
	await queueCount(2, mp);
	check("390px: queue fits the screen (no horizontal scroll)", await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
	check("390px: actions are hidden until the row is tapped", !(await shown(mp.locator(T("queue-item")).first().locator(T("queue-send-now")))));
	await mp.locator(T("queue-row")).first().tap();
	check("390px: tapping a row reveals 立即发送 / 撤销 (and no explanation paragraph)", (await shown(mp.locator(T("queue-send-now")).first())) && (await shown(mp.locator(T("queue-undo")).first())) && (await mp.locator(T("queue-hint")).count()) === 0);
	const bb = await mp.locator(T("queue-send-now")).first().boundingBox();
	check("390px: touch targets at least 36px tall", bb.height >= 36, `h=${bb.height}`);
	check("390px: still no run bar", (await mp.locator(T("run-bar")).count()) === 0);
	await mp.screenshot({ path: join(SHOTS, "round8/q1-queue-390.png") });
	await mp.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
	await sleep(300);
	await mp.screenshot({ path: join(SHOTS, "round8/q1-queue-390-dark.png") });
	await mp.locator(T("stop")).click().catch(() => {});
	await mob.close();

	await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
	await start("[[slow 6000]] 深色模式下的任务");
	await busy();
	await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
	await sendQueued("深色排队一");
	await sendQueued("深色排队二");
	await queueCount(2);
	await items().nth(0).locator(T("queue-row")).click();
	await sleep(300);
	await shot(page, "round8/q1-queue-1280-dark");
	await page.click(T("stop"));
	await idle(20000);
} catch (e) {
	check("script ran to the end", false, String(e?.stack ?? e).slice(0, 600));
	await shot(page, "round8/q1-failure").catch(() => {});
} finally {
	const ok = summary(join(SHOTS, "round8/q1-results.json"));
	await browser.close();
	await server.stop();
	process.exitCode = ok ? 0 : 1;
}
