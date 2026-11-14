// Round 3 — runtime rows: M03-A assistants, M03-B subagent card, M02-C timeout-class (turn limit) + waiting,
// M15-A model ↔ route record, M02-A close browser mid-run → re-login sees final state, M02-B SIGKILL → recovered run
// and needs-reconciliation card. Run: npm run -w web build && node web/e2e/round3-runtime.mjs
import { join } from "node:path";
import { check, chromium, login, register, sendMessage, shot, SHOTS, sleep, startServer, summary } from "./lib.mjs";

const PORT = 8842;
let server = await startServer({ port: PORT });
const base = server.base;
const browser = await chromium.launch();
const idle = (page, t = 60000) => page.waitForSelector('[data-testid="stop"]', { state: "detached", timeout: t });
const email = `rt-${Date.now()}@example.com`;
try {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
	const page = await ctx.newPage();
	await register(page, base, { email, name: "运行测试" });

	// ---------------------------------------------------------------- M03-A: assistant identity apart from conversations
	await page.goto(`${base}/settings?tab=assistants`);
	await page.click('[data-testid="assistant-new"]');
	await page.fill("#aav", "研");
	await page.fill("#anm", "研究助理");
	await page.fill("#ads", "查资料、写摘要");
	await page.fill("#ains", "先检索资料，再给出带引用的结论。");
	await page.getByRole("button", { name: "添加成员" }).click();
	await page.fill('input[aria-label="成员名称"]', "检索员");
	await page.fill('input[aria-label="成员工具"]', "kb_search");
	await page.fill('input[aria-label="最多轮数"]', "1");
	await page.click('[data-testid="assistant-save"]');
	await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="assistant"]')].some((e) => e.textContent?.includes("研究助理")), null, { timeout: 10000 });
	const card = await page.locator('[data-testid="assistant"]', { hasText: "研究助理" }).innerText();
	check("M03-A: assistant stored with avatar, description, tools, knowledge, model and members (Settings)", card.includes("查资料、写摘要") && card.includes("检索员") && card.includes("模型"), card.replace(/\s+/g, " "));
	await shot(page, "1440-assistants");
	await page.goto(`${base}/`);
	// round 17: the old 助手 picker is gone — assistants are experts now; "@" on the home composer binds one to the new conversation
	await page.click('[data-testid="composer-input"]');
	await page.keyboard.type("@研究");
	await page.waitForSelector('[data-testid="mention-item"]', { timeout: 10000 });
	await page.keyboard.press("Enter");
	await sendMessage(page, "你好 [[reply 你好，我是研究助理。]]");
	await page.waitForURL(/\/c\//);
	await page.waitForSelector('[data-testid="chat-expert"]', { timeout: 15000 });
	check("M03-A: the conversation references the assistant (shown in the header as its expert), the assistant itself is managed separately", (await page.locator('[data-testid="chat-expert"]').innerText()).includes("研究助理"));
	await idle(page);

	// ---------------------------------------------------------------- M03-B / M02-C: subagent that hits its turn limit
	await sendMessage(page, '[[call delegate {"member":"m1","task":"检索资料里的报销规定"}]]');
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="assistant-message"]').length >= 2, null, { timeout: 30000 });
	await idle(page);
	await page.click('[data-testid="open-work-panel"]');
	await page.waitForSelector('[data-testid="subagent"]', { timeout: 15000 });
	await page.locator('[data-testid="subagent"] > button').first().click(); // details are behind the row's chevron
	const sub = await page.locator('[data-testid="subagent"]').first().innerText();
	check("M03-B: subagent card shows source, owner, status, result/failure and simulated cost", sub.includes("来源") && sub.includes("负责人") && /模拟用量|tokens/.test(sub) && /已完成|未完成|失败/.test(sub), sub.replace(/\s+/g, " ").slice(0, 200));
	check("M02-C: turn-limit (timeout class) shown as its own state, not as success or a plain failure", sub.includes("达到轮数上限（超时）") && !sub.includes("已完成"), sub.split("\n").slice(0, 3).join(" | "));
	await shot(page, "1440-subagent-turn-limit");
	await page.click('[data-testid="close-panel"]');

	// ---------------------------------------------------------------- M15-A: platform model ↔ actual route record
	await page.click('[data-testid="chat-more"]');
	await page.click('[data-testid="open-routes"]');
	await page.waitForSelector('[data-testid="route-attempt"]', { timeout: 15000 });
	const routes = await page.locator('[data-testid="routes"]').innerText();
	check("M15-A: shown model and the recorded route (channel / upstream model / status) for this conversation", (await page.locator('[data-testid="route-attempt"]').count()) >= 2 && routes.includes("测试模型") && routes.includes("成功"), routes.replace(/\s+/g, " ").slice(0, 160));
	await shot(page, "1440-routes");
	await page.keyboard.press("Escape");

	// ---------------------------------------------------------------- M02-A: close the browser mid-run, log in again elsewhere
	await page.goto(`${base}/`);
	await sendMessage(page, '[[slow 6000]] 写一份会议纪要 [[call write {"path":"/work/会议纪要.md","content":"# 纪要\\n- 结论一"}]] [[call present_file {"source":"/work/会议纪要.md"}]]');
	await page.waitForURL(/\/c\//);
	const runUrl = page.url();
	await page.waitForSelector('[data-testid="stop"]', { timeout: 10000 });
	// network loss first: the page says so, the run keeps going on the server, and it catches up when back online
	await ctx.setOffline(true);
	await page.waitForSelector('[data-testid="stream-notice"][data-stream="offline"]', { timeout: 15000 });
	check("M02-A: losing the network is shown honestly (the task keeps running on the server)", (await page.locator('[data-testid="stream-notice"]').innerText()).includes("网络已断开"));
	await shot(page, "1440-offline-notice");
	await sleep(7000); // the run finishes on the server while this browser is offline
	await ctx.setOffline(false);
	await page.waitForSelector('[data-testid="stream-notice"]', { state: "detached", timeout: 20000 });
	await page.waitForSelector('[data-testid="file-card"]', { timeout: 20000 });
	check("M02-A: back online, the page reconnects and shows the result produced while it was offline", (await page.locator('[data-testid="stop"]').count()) === 0);
	await sendMessage(page, '[[slow 6000]] 再做一份 [[call write {"path":"/work/会议纪要二.md","content":"# 纪要二\\n- 结论二"}]] [[call present_file {"source":"/work/会议纪要二.md"}]]');
	await page.waitForSelector('[data-testid="stop"]', { timeout: 10000 });
	await ctx.close(); // then the browser is gone altogether; the server keeps working
	await sleep(9000);
	const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
	const p2 = await ctx2.newPage();
	await login(p2, base, { email });
	await p2.click('[data-testid="open-sidebar"]');
	await p2.waitForSelector(`a[href="${runUrl.replace(base, "")}"]`, { timeout: 10000 });
	await p2.click(`a[href="${runUrl.replace(base, "")}"]`);
	await p2.waitForSelector('[data-testid="file-card"]', { timeout: 30000 });
	check("M02-A: after closing the browser and logging in again (other device), the finished run and its deliverable are there", (await p2.locator('[data-testid="stop"]').count()) === 0);
	await shot(p2, "390-relogin-final-state");
	await ctx2.close();

	// ---------------------------------------------------------------- M02-B: worker crash (SIGKILL) mid-run and mid-external-write
	const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
	const p3 = await ctx3.newPage();
	await login(p3, base, { email });
	await sendMessage(p3, "[[slow 8000]] 崩溃恢复测试 [[reply 进程重启后已完成。]]");
	await p3.waitForURL(/\/c\//);
	const crashUrl = p3.url();
	await p3.waitForSelector('[data-testid="stop"]', { timeout: 10000 });
	await sleep(2000);
	await server.kill(); // hard crash mid-run, no graceful shutdown
	server = await startServer({ port: PORT, fresh: false });
	await p3.goto(crashUrl);
	await p3.waitForFunction(() => document.body.innerText.includes("进程重启后已完成"), null, { timeout: 60000 });
	check("M02-B: the interrupted run resumed in the new process and finished (no browser involvement)", true);
	await idle(p3);
	await sendMessage(p3, '[[call wr_fixture_effect {"key":"crash-write","target":"fixture://outbox","holdMs":20000}]]');
	await p3.waitForSelector('[data-testid="stop"]', { timeout: 10000 });
	await sleep(4000); // the write is now "dispatching"
	await server.kill();
	server = await startServer({ port: PORT, fresh: false });
	await p3.goto(crashUrl);
	await p3.waitForSelector('[data-testid="reconcile-card"]', { timeout: 60000 });
	check("M02-B: the external write cut mid-dispatch shows 待核对 instead of being re-sent", (await p3.locator('[data-testid="reconcile-card"]').innerText()).includes("不会自动重做"));
	await p3.locator('[data-testid="reconcile-card"]').scrollIntoViewIfNeeded();
	await shot(p3, "1440-crash-recovered");
	await p3.locator('[data-testid="reconcile-card"]').getByRole("button", { name: "未生效" }).click();
	await p3.waitForSelector('[data-testid="reconcile-card"]', { state: "detached", timeout: 15000 });
	check("M02-B: user records the verified outcome", true);
	await ctx3.close();
} catch (e) {
	check("script completed", false, String(e?.stack ?? e));
} finally {
	await browser.close();
	await server.stop();
}
process.exitCode = summary(join(SHOTS, "round3-runtime.results.json")) ? 0 : 1;
