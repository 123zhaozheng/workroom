// Round 5 · UI group 2: agent progress in the chat.
//  - test directives never appear as message content (displayText + 测试 badge), also in the handoff list
//  - one run-summary line per turn, steps in human words, raw JSON only behind 「技术详情」
//  - approval card: operation, scope, risk, requester; nothing focused on open, 高风险 needs a second click, 拒绝 works, keyboard
//  - 待核对 card offers exactly 已生效 / 未生效
//  - queued message (+ 撤销), failure → 重试, branch switcher still work
// Run: npm run -w web build && node web/e2e/round5-g2.mjs        (port 8894)
import { check, chromium, register, sendMessage, shot, sleep, startServer, summary, SHOTS } from "./lib.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

mkdirSync(join(SHOTS, "round5/after"), { recursive: true });
const PORT = 8894;
const server = await startServer({ port: PORT, env: { WORKROOM_RT_RETRY_MAX: "0" } });
const base = server.base;
const browser = await chromium.launch();
const idle = (page, t = 60000) => page.waitForSelector('[data-testid="stop"]', { state: "detached", timeout: t });
const busy = (page) => page.waitForSelector('[data-testid="stop"]', { timeout: 15000 });
const fresh = async (page) => {
	await page.goto(`${base}/`);
	await page.waitForSelector('[data-testid="home-greeting"]');
};
const start = async (page, text) => {
	await fresh(page);
	await sendMessage(page, text);
	await page.waitForURL(/\/c\//);
};
const lastAssistant = (page) => page.locator('[data-testid="assistant-message"]').last();
const stateOf = async (page) => {
	const m = /\/c\/([^/]+)\/(\d+)/.exec(page.url());
	return (await page.request.get(`${base}/api/conversations/${m[1]}/${m[2]}/state`)).json();
};

try {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
	const page = await ctx.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	await register(page, base, { email: `g2-${Date.now()}@example.com`, name: "林夏" });

	// ------------------------------------------------------------------ 1. directives are not content; run summary; 技术详情
	await start(page, '帮我写周报 [[call file_create {"name":"项目周报","format":"md","title":"项目周报","content":"# 本周进展\\n- 完成需求评审"}]] [[call file_list {}]]');
	await page.waitForSelector('[data-testid="file-card"]', { timeout: 30000 });
	await page.waitForSelector('[data-testid="assistant-message"] .wr-prose', { timeout: 30000 });
	await idle(page);
	await sleep(400);
	const bubble = await page.locator('[data-testid="user-bubble"]').first().innerText();
	check("display text: the message bubble shows only what the person wrote", bubble.trim() === "帮我写周报", JSON.stringify(bubble));
	check("display text: a small 测试 badge says directives were present", (await page.locator('[data-testid="test-badge"]').first().innerText()).includes("测试"));
	const mainText = await page.locator("main").first().innerText();
	check("display text: no [[call text visible anywhere on the page", !mainText.includes("[[call") && !mainText.includes("[[") && !(await page.locator("nav").first().innerText()).includes("[["));
	const msgsText = (await page.locator('[data-testid="user-bubble"], [data-testid="assistant-message"]').allInnerTexts()).join("\n");
	check("display text: no raw tool JSON in any message while collapsed", !/"format"\s*:|"name"\s*:|\{"/.test(msgsText), msgsText.slice(0, 120));
	const sum1 = (await page.locator('[data-testid="run-summary"]').last().innerText()).trim();
	check("run summary: one line with step count and files", sum1 === "已完成 2 步 · 生成 1 个文件", sum1);
	check("run summary: steps hidden until expanded", (await page.locator('[data-testid="tool-step"]').count()) === 0);
	await page.locator('[data-testid="step-chain"] > button').last().click();
	await sleep(250);
	const titles = await page.locator('[data-testid="tool-step"] > button').allInnerTexts();
	check("steps: human wording per tool (生成文件「项目周报」 / 查看文件列表)", titles.length === 2 && titles[0].includes("生成文件「项目周报」") && titles[1].includes("查看文件列表"), titles.join(" | "));
	check("steps: tool names and JSON are not in the step rows", !titles.join(" ").includes("file_create") && !titles.join(" ").includes("{"));
	await page.locator('[data-testid="tool-step"] > button').first().click();
	await sleep(200);
	const pre = page.locator('[data-testid="tool-step"] [data-testid="tech-details"] pre').first();
	check("技术详情: raw arguments hidden until the disclosure is opened", !(await pre.isVisible()));
	check("steps: one human outcome line and a preview link", (await page.locator('[data-testid="tool-step"]').first().innerText()).includes("已生成「项目周报.md」") && (await page.locator('[data-testid="tool-step"]').first().getByRole("button", { name: /预览/ }).count()) === 1);
	await page.locator('[data-testid="tool-step"] [data-testid="tech-details"] summary').first().click();
	await sleep(150);
	check("技术详情: opening it shows the raw arguments", (await pre.isVisible()) && (await page.locator('[data-testid="tool-step"] [data-testid="tech-details"]').first().innerText()).includes("file_create"));
	await shot(page, "round5/after/g2-e2e-steps-expanded");
	await page.locator('[data-testid="tool-step"]').first().getByRole("button", { name: /预览/ }).click();
	await page.waitForSelector('[data-testid="side-panel"] [data-testid="preview-panel"]', { timeout: 15000 });
	check("results: the step's preview link opens the preview panel", true);
	await page.click('[data-testid="close-panel"]');

	// ------------------------------------------------------------------ 2. running summary
	await sendMessage(page, '稍等 [[call wr_fixture_wait {"ms":5000}]]');
	await busy(page);
	await page.waitForFunction(() => /正在等待…/.test([...document.querySelectorAll('[data-testid="run-summary"]')].at(-1)?.textContent ?? ""), null, { timeout: 15000 });
	const runSum = (await page.locator('[data-testid="run-summary"]').last().innerText()).trim();
	check("run summary (running): names the current step, e.g. 正在等待…", /^正在等待…/.test(runSum), runSum);
	await idle(page);
	await sleep(300);
	check("run summary (finished): 已完成 1 步", (await page.locator('[data-testid="run-summary"]').last().innerText()).trim() === "已完成 1 步");

	// ------------------------------------------------------------------ 3. approval (medium): operation, scope, risk, default focus, deny
	await sendMessage(page, '发送前请确认 [[call wr_fixture_approval {"title":"对外发送周报","summary":"将《项目周报》v1 发送到 team@example.com","risk":"medium"}]]');
	await page.waitForSelector('[data-testid="approval-card"]', { timeout: 30000 });
	await sleep(400);
	const card = page.locator('[data-testid="approval-card"]');
	const cardText = await card.innerText();
	check("approval: shows the operation (title + the backend's summary)", cardText.includes("对外发送周报") && cardText.includes("将《项目周报》v1 发送到 team@example.com"));
	// round 10: the face is title + risk badge + summary + buttons; who asked / the risk explained are behind 查看详情 (nothing removed)
	check("approval: the risk level is a labelled badge on the face; requester and risk note are folded", (await card.locator('[data-testid="approval-risk"]').innerText()).includes("中风险") && !cardText.includes("请求人") && !cardText.includes("代你执行"));
	await card.locator('[data-testid="approval-details-toggle"]').click();
	const openText = await card.innerText();
	check("approval: 查看详情 shows the risk note and the requester", openText.includes("风险") && openText.includes("请求人") && openText.includes("代你执行"));
	await card.locator('[data-testid="approval-details-toggle"]').click();
	check("approval: only 允许 / 拒绝 (+ 查看详情 and an optional note) are offered", (await card.locator("button").allInnerTexts()).map((t) => t.trim()).join("|") === "拒绝|允许|查看详情|添加说明");
	const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName);
	check("approval: default focus is not on 允许", focused !== "approve" && focused !== "approve-confirm", String(focused));
	check("approval: no run bar above the input; the card itself is the place to act", (await page.locator('[data-testid="run-bar"]').count()) === 0 && (await card.isVisible()));
	check("approval: raw tool name / JSON not shown", !cardText.includes("wr_fixture") && !cardText.includes("{"));
	await card.focus();
	check("approval: the card is focusable as a whole, not 允许", (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "approval-card");
	await shot(page, "round5/after/g2-e2e-approval-medium");
	// keyboard: Tab reaches 拒绝 first, then 允许; Enter on 拒绝 denies
	await page.keyboard.press("Tab");
	check("approval: keyboard order starts at 拒绝", (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "reject");
	await page.keyboard.press("Tab");
	check("approval: Tab then reaches 允许", (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "approve");
	await page.locator('[data-testid="reject"]').focus();
	await page.keyboard.press("Enter");
	await page.waitForSelector('[data-testid="approval-card"]', { state: "detached", timeout: 20000 });
	await idle(page);
	await sleep(500);
	let st = await stateOf(page);
	const ap = st.approvals.at(-1);
	check("approval: 拒绝 (by keyboard) is recorded as rejected and the run ends", ap?.status === "rejected", ap?.status);
	const sumRej = (await page.locator('[data-testid="step-chain"] > button').last().innerText()).replace(/\s+/g, " ").trim();
	check("approval: the run summary says the step was refused", sumRej.includes("被拒绝"), sumRej);

	// ------------------------------------------------------------------ 4. approval (high): second explicit confirmation
	await sendMessage(page, '清理旧数据 [[call wr_fixture_approval {"title":"删除客户资料","summary":"永久删除 2023 年度的 1,284 条客户联系记录，删除后无法恢复","risk":"high"}]]');
	await page.waitForSelector('[data-testid="approval-card"][data-risk="high"]', { timeout: 30000 });
	await sleep(400);
	const hi = page.locator('[data-testid="approval-card"]');
	check("high risk: labelled 高风险 and says it may be irreversible", (await hi.locator('[data-testid="approval-risk"]').innerText()).includes("高风险") && (await hi.innerText()).includes("无法撤销"));
	await shot(page, "round5/after/g2-e2e-approval-high");
	await hi.locator('[data-testid="approve"]').click();
	await hi.locator('[data-testid="approval-confirm"]').waitFor({ timeout: 5000 });
	await sleep(300);
	st = await stateOf(page);
	check("high risk: one click on 允许 does not approve (still pending, asks again)", st.approvals.at(-1)?.status === "pending");
	check("high risk: focus lands on the safe choice (返回), not on 确认允许", (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "approve-back");
	await hi.locator('[data-testid="approve-back"]').click();
	await hi.locator('[data-testid="approval-confirm"]').waitFor({ state: "detached", timeout: 5000 });
	st = await stateOf(page);
	check("high risk: 返回 leaves it pending", st.approvals.at(-1)?.status === "pending" && (await hi.locator('[data-testid="approve"]').count()) === 1);
	await hi.locator('[data-testid="approve"]').click();
	await hi.locator('[data-testid="approve-confirm"]').click();
	await page.waitForSelector('[data-testid="approval-card"]', { state: "detached", timeout: 20000 });
	await idle(page);
	st = await stateOf(page);
	check("high risk: the second explicit click approves", st.approvals.at(-1)?.status === "approved");

	// ------------------------------------------------------------------ 5. approval: optional note travels to the backend
	await sendMessage(page, '[[call wr_fixture_approval {"title":"预订场地","summary":"向场地方提交 12 月 1 日的预订","risk":"low"}]]');
	await page.waitForSelector('[data-testid="approval-card"][data-risk="low"]', { timeout: 30000 });
	await page.getByRole("button", { name: "添加说明" }).click();
	await page.getByLabel(/补充说明/).fill("只订上午场");
	await page.click('[data-testid="approve"]');
	await page.waitForSelector('[data-testid="approval-card"]', { state: "detached", timeout: 20000 });
	await idle(page);
	st = await stateOf(page);
	check("approval: the optional note is sent with the decision", st.approvals.at(-1)?.note === "只订上午场" && st.approvals.at(-1)?.status === "approved");

	// ------------------------------------------------------------------ 6. queue while running, 撤销
	await sendMessage(page, "[[slow 9000]] 慢慢整理一下要点");
	await busy(page);
	await sendMessage(page, "另外请把结论放在最前面 [[reply 好的]]");
	await page.waitForSelector('[data-testid="queue-item"]', { timeout: 10000 });
	const chip = page.locator('[data-testid="queue-item"]').first();
	const chipText = await chip.innerText();
	check("queue: the item shows the message without directives", chipText.includes("另外请把结论放在最前面") && !chipText.includes("[["), chipText.replace(/\s+/g, " "));
	await chip.hover();
	check("queue: a message not yet applied can be undone (撤销)", (await chip.locator('[data-testid="queue-undo"]').count()) === 1);
	await shot(page, "round5/after/g2-e2e-steer");
	await chip.locator('[data-testid="queue-undo"]').click();
	await page.waitForFunction(() => !document.querySelector('[data-testid="queue-item"]'), null, { timeout: 10000 });
	check("queue: 撤销 is confirmed by the server and the text is back in the input", (await page.locator('[data-testid="composer-input"]').inputValue()).includes("另外请把结论放在最前面"));
	await page.locator('[data-testid="composer-input"]').fill("再补充：用三句话 [[reply 收到补充]]");
	await page.click('[data-testid="send"]');
	await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="user-message"]')].some((e) => e.textContent.includes("再补充：用三句话")), null, { timeout: 40000 });
	check("queue: a kept message is sent after the current task", true);
	await idle(page, 40000);

	// ------------------------------------------------------------------ 7. failure with reason + 重试
	await sendMessage(page, "[[fail]] 这一步会失败");
	await page.waitForSelector('[data-testid="run-bar"][data-status="failed"], [data-testid="run-bar"][data-status="interrupted"]', { timeout: 60000 });
	await sleep(400);
	const rb = page.locator('[data-testid="run-bar"]');
	const rbText = await rb.innerText();
	// round 10: the reason and 技术详情 are shown once, inline in the message (error-note); the bar above the input is only the status + 重试
	check("failure: the bar is just the status + 重试 (no raw [[fail]], no second copy of the reason)", rbText.includes("重试") && !rbText.includes("[[") && !rbText.includes("模型出错"), rbText.replace(/\s+/g, " "));
	check("failure: no second 技术详情 in the bar", (await rb.locator('[data-testid="tech-details"]').count()) === 0);
	const note = await lastAssistant(page).locator('[data-testid="error-note"]').innerText();
	check("failure: the message shows one plain line, not the provider text", note.includes("这一轮没有完成") && !note.includes("simulated"), note.replace(/\s+/g, " "));
	const det = lastAssistant(page).locator('[data-testid="error-note"] pre');
	check("failure: technical detail stays collapsed", !(await det.isVisible()));
	await lastAssistant(page).locator('[data-testid="error-note"] summary').click();
	check("failure: 技术详情 opens to the raw reason, still without directives", (await det.isVisible()) && !(await det.innerText()).includes("[["));
	await shot(page, "round5/after/g2-e2e-failure");
	const req = page.waitForRequest((r) => r.url().endsWith("/continue") && r.method() === "POST", { timeout: 10000 });
	await page.click('[data-testid="continue"]');
	await req;
	check("failure: 重试 calls the backend continue route", true);
	await page.waitForSelector('[data-testid="run-bar"][data-status="failed"], [data-testid="run-bar"][data-status="interrupted"]', { timeout: 60000 });

	// ------------------------------------------------------------------ 8. 待核对: exactly 已生效 / 未生效
	await start(page, '同步到 CRM [[call wr_fixture_effect {"key":"crm-sync","target":"crm://customers","unknownOutcome":true}]]');
	await page.waitForSelector('[data-testid="reconcile-card"]', { timeout: 60000 });
	const rc = page.locator('[data-testid="reconcile-card"]');
	const rcText = await rc.innerText();
	check("reconcile: says what, where and that nothing is redone automatically", rcText.includes("待核对") && rcText.includes("crm://customers") && rcText.includes("不会自动重做"), rcText.replace(/\s+/g, " ").slice(0, 160));
	check("reconcile: only 已生效 / 未生效 are offered; the idempotency key is behind 技术详情", (await rc.locator("button").allInnerTexts()).map((t) => t.trim()).join("|") === "已生效|未生效" && !rcText.includes("幂等键"));
	await shot(page, "round5/after/g2-e2e-reconcile");
	await rc.getByRole("button", { name: "未生效" }).click();
	await page.waitForSelector('[data-testid="reconcile-card"]', { state: "detached", timeout: 15000 });
	check("reconcile: 未生效 resolves the card", true);

	// ------------------------------------------------------------------ 9. branch switcher (edit → ‹ 2/2 ›)
	await start(page, "[[reply 方案一：保守推进。]]");
	await page.waitForSelector('[data-testid="assistant-message"]', { timeout: 30000 });
	await idle(page);
	const convUrl = page.url();
	const u = page.locator('[data-testid="user-message"]').first();
	await u.hover();
	await u.locator('[data-testid="action-edit"]').click();
	await u.locator("textarea").fill("[[reply 方案二：加快推进。]]");
	await u.locator('[data-testid="edit-save"]').click();
	await page.waitForSelector('[data-testid="branch-badge"]', { timeout: 20000 });
	await page.waitForSelector('[data-testid="branch-switcher"]', { timeout: 20000 });
	const sw = (await page.locator('[data-testid="branch-switcher"]').first().innerText()).replace(/\s+/g, "");
	check("branch: switcher shows the position (2 / 2)", sw.startsWith("2/2"), sw);
	check("branch: edited message shows its own text, directives hidden", !(await page.locator("main").first().innerText()).includes("[[reply"));
	await shot(page, "round5/after/g2-e2e-branch");
	await page.locator('[data-testid="branch-switcher"] button[aria-label="上一个分支"]').first().click();
	await page.waitForURL((u2) => u2.toString() === convUrl, { timeout: 15000 });
	await page.waitForFunction(() => (document.querySelector('[data-testid="branch-switcher"]')?.textContent ?? "").replace(/\s+/g, "").startsWith("1/2") && (document.querySelector('[data-testid="assistant-message"]')?.textContent ?? "").includes("方案一"), null, { timeout: 15000 }).catch(() => {});
	check("branch: switching back reaches the original answer (1 / 2)", (await page.locator('[data-testid="branch-switcher"]').first().innerText()).replace(/\s+/g, "").startsWith("1/2") && (await lastAssistant(page).innerText()).includes("方案一"), (await page.locator('[data-testid="branch-switcher"]').first().innerText()).replace(/\s+/g, ""));

	// ------------------------------------------------------------------ 10. handoff progress list
	await page.click('[data-testid="chat-more"]');
	await page.click('[data-testid="open-handoff"]');
	await page.waitForSelector('[data-testid="handoff-runs"]', { timeout: 15000 });
	const runsText = await page.locator('[data-testid="handoff-runs"]').innerText();
	check("handoff: progress list shows cleaned text with a 测试 badge, no [[ directives", !runsText.includes("[[") && runsText.includes("测试") && runsText.includes("（测试指令）"), runsText.replace(/\s+/g, " ").slice(0, 120));
	await page.keyboard.press("Escape");

	// ------------------------------------------------------------------ 11. dark mode + 390 layout of the approval card
	const dctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "zh-CN", colorScheme: "dark", storageState: await ctx.storageState() });
	const mp = await dctx.newPage();
	await mp.goto(`${base}/`);
	await mp.waitForSelector('[data-testid="home-greeting"]');
	await sendMessage(mp, '清理 [[call wr_fixture_approval {"title":"删除客户资料","summary":"永久删除 2023 年度的 1,284 条客户联系记录，删除后无法恢复","risk":"high"}]]');
	await mp.waitForSelector('[data-testid="approval-card"]', { timeout: 30000 });
	await sleep(500);
	const noScroll = await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1);
	check("390 dark: approval card fits without horizontal scroll", noScroll);
	const bg = await mp.locator('[data-testid="approval-card"]').evaluate((e) => getComputedStyle(e).backgroundColor);
	check("390 dark: card colours come from tokens (not a light colour)", !/rgb\(2[0-9][0-9], 2[0-9][0-9], 2[0-9][0-9]\)/.test(bg), bg);
	await shot(mp, "round5/after/g2-e2e-approval-390-dark");
	await dctx.close();

	check("no uncaught page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
} finally {
	await browser.close();
	await server.stop();
}
const ok = summary(join(SHOTS, "round5-g2.results.json"));
process.exitCode = ok ? 0 : 1;
