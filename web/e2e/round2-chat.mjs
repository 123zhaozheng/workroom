// Round 2 chat UI checks:
// 1. make-skill moved inside chat-more menu (disabled when empty / readOnly)
// 2. skill-distill-hint removed from new distill conversations
// 3. in-place regenerate: button only on last assistant turn, label "重新生成", stays on same conversation,
//    replaces old assistant entry in place, 409 error shown in alert, fork still creates branch
// 4. empty conversations hidden from sidebar until first message; immediate refresh when first message sent
// 5. "助手" replaced with "AI" in approval / credential cards
// Run: npm run build:web && node web/e2e/round2-chat.mjs
import { join } from "node:path";
import { check, chromium, register, sendMessage, SHOTS, sleep, startServer, summary } from "./lib.mjs";

const PORT = Number(process.env.E2E_PORT ?? 4391);
const server = await startServer({ port: PORT });
const base = server.base;
const browser = await chromium.launch();

try {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
	const page = await ctx.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));

	await register(page, base, { email: `r2-${Date.now()}@example.com`, name: "林夏" });
	await page.waitForSelector('[data-testid="sidebar"]');

	// ---------------------------------------------------------------- 1 & 4. Create project -> empty chat hidden until first message; make-skill in chat-more disabled when empty
	await page.click('[data-testid="new-project"]');
	await page.fill("#pname", "测试项目");
	await page.click('[data-testid="new-project-create"]');
	await page.waitForURL(/\/projects\/prj_/);
	const projectId = page.url().split("/projects/")[1];
	const pb = page.locator(`[data-testid="project"][data-project="${projectId}"]`);
	await pb.locator('[data-testid="project-new-chat"]').click();
	await page.waitForURL(/\/c\//);
	await page.waitForSelector('[data-testid="chat-empty"]');

	// Empty conversation must NOT be in sidebar list yet
	await sleep(300);
	const listBefore = await (await page.request.get(`${base}/api/conversations?limit=50`)).json();
	check("empty-conv: hidden from GET /conversations before first message", listBefore.conversations.length === 0, `count=${listBefore.conversations.length}`);
	check("empty-conv: hidden from sidebar before first message", (await page.locator('[data-testid="conv-row"]').count()) === 0);

	// make-skill must NOT be a standalone button outside chat-more, and must be disabled inside chat-more when empty
	check("make-skill: not a standalone topbar button", (await page.locator('[data-testid="make-skill"]').count()) === 0);
	await page.click('[data-testid="chat-more"]');
	await page.waitForSelector('[data-testid="make-skill"]');
	const makeSkillDisabled = await page.locator('[data-testid="make-skill"]').getAttribute("data-disabled");
	check("make-skill: inside chat-more menu and disabled on empty chat", makeSkillDisabled !== null);
	await page.keyboard.press("Escape");

	// Send first message -> immediately appears in sidebar
	await sendMessage(page, "第一轮问题 [[reply 第一轮原始回答]]");
	await page.waitForSelector('[data-testid="assistant-message"] .wr-prose', { timeout: 20000 });
	await page.waitForFunction(
		(pid) => document.querySelectorAll(`[data-testid="project"][data-project="${pid}"] [data-testid="conv-row"]`).length === 1,
		projectId,
		{ timeout: 8000 },
	);
	check("empty-conv: appears in sidebar under project immediately after first message", (await pb.locator('[data-testid="conv-row"]').count()) === 1);

	// ---------------------------------------------------------------- 3. In-place regenerate
	await sendMessage(page, "第二轮问题 [[reply 第二轮原始回答]]");
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="assistant-message"]').length === 2, null, { timeout: 20000 });
	await page.waitForSelector('[data-testid="stop"]', { state: "detached", timeout: 20000 });

	const regenBtns = page.locator('[data-testid="action-regenerate"]');
	const forkBtns = page.locator('[data-testid="action-fork-assistant"]');
	check("regenerate: button shown ONLY on the last assistant message", (await regenBtns.count()) === 1 && (await forkBtns.count()) === 2, `regen=${await regenBtns.count()} fork=${await forkBtns.count()}`);
	const regenLabel = await regenBtns.first().getAttribute("aria-label");
	check("regenerate: button label is 重新生成 (not 新分支)", regenLabel === "重新生成", `label=${regenLabel}`);

	const chatUrl = page.url();
	const oldEntryId = await page.locator('[data-testid="assistant-message"]').last().getAttribute("data-entry-id");
	await page.locator('[data-testid="assistant-message"]').last().hover();
	await regenBtns.first().click();

	// Must stay on same conversation, no branch-badge, entry-id changes
	await page.waitForFunction(
		(prevId) => {
			const msgs = document.querySelectorAll('[data-testid="assistant-message"]');
			const last = msgs[msgs.length - 1];
			return msgs.length === 2 && last && last.getAttribute("data-entry-id") && last.getAttribute("data-entry-id") !== prevId && !document.querySelector('[data-testid="stop"]');
		},
		oldEntryId,
		{ timeout: 25000 },
	);
	const newEntryId = await page.locator('[data-testid="assistant-message"]').last().getAttribute("data-entry-id");
	check("regenerate: stayed in same conversation, no branch badge, replaced assistant entry in place", page.url() === chatUrl && (await page.locator('[data-testid="branch-badge"]').count()) === 0 && newEntryId !== oldEntryId, `old=${oldEntryId} new=${newEntryId}`);

	// Verify old assistant entry is gone from GET .../entries
	const m = /\/c\/([^/]+)\/(\d+)/.exec(chatUrl);
	const entriesRes = await (await page.request.get(`${base}/api/conversations/${m[1]}/${m[2]}/entries`)).json();
	check("regenerate: old assistant entry absent from entries API", !entriesRes.items.some((e) => String(e.id) === String(oldEntryId)));

	// Non-last assistant regenerate API returns 409; also verify UI displays 409 error banner
	const firstEntryId = await page.locator('[data-testid="assistant-message"]').first().getAttribute("data-entry-id");
	const nonLastResp = await page.request.post(`${base}/api/conversations/${m[1]}/${m[2]}/regenerate`, { data: { entryId: Number(firstEntryId) } });
	check("regenerate: non-last turn returns 409 regenerate_not_last", nonLastResp.status() === 409 && (await nonLastResp.json())?.error?.code === "regenerate_not_last", `status=${nonLastResp.status()}`);

	await page.route("**/api/conversations/*/*/regenerate", (route) =>
		route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "regenerate_not_last", message: "只能重新生成最后一条回答，更早的回答请使用「从这里分叉」" } }) }),
	);
	await page.locator('[data-testid="assistant-message"]').last().hover();
	await page.locator('[data-testid="action-regenerate"]').first().click();
	await page.waitForSelector('[role="alert"]', { timeout: 5000 });
	const alertText = await page.locator('[role="alert"]').last().innerText();
	check("regenerate: 409 error message shown in UI alert", alertText.includes("只能重新生成最后一条回答"), alertText);
	await page.unroute("**/api/conversations/*/*/regenerate");

	// Fork from first assistant message still creates a branch
	await page.locator('[data-testid="assistant-message"]').first().hover();
	await page.locator('[data-testid="action-fork-assistant"]').first().click();
	await page.waitForURL((u) => u.toString() !== chatUrl, { timeout: 15000 });
	await page.waitForSelector('[data-testid="branch-badge"]', { timeout: 15000 });
	check("fork: 从这里分叉 still creates a new branch", page.url() !== chatUrl);
	await page.goto(chatUrl);
	await page.waitForSelector('[data-testid="assistant-message"]');

	// ---------------------------------------------------------------- 5. Approval card uses "AI" instead of "助手"
	await sendMessage(page, '需要审批 [[call wr_fixture_approval {"title":"对外发信","summary":"发送项目周报","risk":"low"}]]');
	await page.waitForSelector('[data-testid="approval-card"]', { timeout: 20000 });
	const card = page.locator('[data-testid="approval-card"]');
	await card.locator('[data-testid="approval-details-toggle"]').click();
	const cardOpenText = await card.innerText();
	check("cards: approval card requester says AI（代你执行）, no 助手", cardOpenText.includes("AI（代你执行）") && !cardOpenText.includes("助手"), cardOpenText.replace(/\s+/g, " "));
	await card.locator('[data-testid="reject"]').click();
	await page.waitForFunction(() => document.querySelector('[data-testid="approval-card"]')?.textContent?.includes("正在通知 AI"), null, { timeout: 5000 }).catch(() => {});
	await page.waitForSelector('[data-testid="approval-card"]', { state: "detached", timeout: 20000 });

	// ---------------------------------------------------------------- 1 & 2. Distill via chat-more, no skill-distill-hint
	const beforeDistillUrl = page.url();
	await page.click('[data-testid="chat-more"]');
	await page.click('[data-testid="make-skill"]');
	await page.waitForFunction((u) => location.href !== u && /\/c\//.test(location.pathname), beforeDistillUrl, { timeout: 15000 });
	await page.waitForFunction(() => (document.querySelector('[data-testid="composer-input"]')?.value ?? "").includes("session_trace"), null, { timeout: 15000 });
	check("distill: no skill-distill-hint banner and composer prefilled", (await page.locator('[data-testid="skill-distill-hint"]').count()) === 0);

	check("no uncaught page errors", errors.length === 0, errors.join(" | "));
	await ctx.close();
} catch (e) {
	check("script completed", false, String(e?.stack ?? e));
} finally {
	await browser.close();
	await server.stop();
}
process.exitCode = summary(join(SHOTS, "round2-chat.results.json")) ? 0 : 1;
