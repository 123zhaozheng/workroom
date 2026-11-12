// Round-2 UI evidence against the real server (fixture model, fixture tools):
// M01-A (one composer: plain / attachment / knowledge chip), citation 失效提示 (C), per-message outcome (A),
// 待核对 reconcile card (A), terminal + browser + live browser take-over + background job cancel (D),
// knowledge retry (C), project roles: editor handoff vs viewer read-only (A/E).
// Run: npm run -w web build && node web/e2e/round2.mjs
import { createServer } from "node:http";
import { join } from "node:path";
import { check, chromium, register, sendMessage, shot, SHOTS, sleep, startServer, summary } from "./lib.mjs";

// A tiny local page for the browser tools (allow-listed for this test server only).
const PAGE_PORT = 8834;
const pageServer = createServer((req, res) => {
	res.setHeader("content-type", "text/html; charset=utf-8");
	res.end(`<!doctype html><html><head><title>测试页面</title></head><body style="font:16px sans-serif;padding:40px">
<h1>Workroom 浏览测试页</h1><p>这是一个本地测试页面，用于验证浏览与接管。</p>
<button id="b" style="font-size:20px;padding:12px 24px" onclick="document.title='已点击';this.textContent='已点击'">点我</button>
<p><input id="q" placeholder="输入框" style="font-size:18px"></p></body></html>`);
});
await new Promise((r) => pageServer.listen(PAGE_PORT, "127.0.0.1", r));
const PAGE = `http://127.0.0.1:${PAGE_PORT}/`;

const server = await startServer({ port: 8832, env: { WORKROOM_URL_ALLOWLIST: `127.0.0.1:${PAGE_PORT}` } });
const base = server.base;
const browser = await chromium.launch();
const last = (page, sel) => page.locator(sel).last();
async function waitIdle(page) {
	await page.waitForSelector('[data-testid="stop"]', { state: "detached", timeout: 60000 });
}

try {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
	const page = await ctx.newPage();
	await register(page, base, { email: `own-${Date.now()}@example.com`, name: "负责人" });
	const me = await (await page.request.get(`${base}/api/me`)).json();
	const sp = me.personalSpaceId;

	// knowledge base with one ready doc (C)
	const kb = (await (await page.request.post(`${base}/api/kb`, { data: { name: "报销制度库", scope: "personal" } })).json()).kb;
	const up = await page.request.post(`${base}/api/files`, { multipart: { spaceId: sp, file: { name: "报销制度.md", mimeType: "text/markdown", buffer: Buffer.from("# 报销制度\n\n差旅报销需在 30 天内提交，并附发票原件。\n\n## 审批\n部门负责人审批后由财务复核。\n") } } });
	const f1 = await up.json();
	await page.request.post(`${base}/api/kb/${kb.id}/docs`, { data: { fileId: f1.file.id, versionId: f1.version.versionId } });
	for (let i = 0; i < 60; i++) {
		const d = await (await page.request.get(`${base}/api/kb/${kb.id}/docs`)).json();
		if (d.docs?.[0]?.availability === "ready") break;
		await sleep(500);
	}

	// ---------------------------------------------------------------- M01-A: one composer, three kinds of request
	await page.goto(`${base}/`);
	await sendMessage(page, "你好，先简单聊两句 [[reply 你好！有什么可以帮你？]]");
	await page.waitForURL(/\/c\//);
	await page.waitForSelector('[data-testid="assistant-message"]', { timeout: 20000 });
	await waitIdle(page);
	const chatUrl = page.url();
	await page.setInputFiles('[data-testid="file-input"]', { name: "出差行程.txt", mimeType: "text/plain", buffer: Buffer.from("11 月 20 日 上海出差，往返高铁。") });
	await page.waitForSelector('[data-testid="chip-file"]');
	await page.waitForFunction(() => !document.querySelector('[data-testid="chip-file"] .wr-spin'));
	await sendMessage(page, "请看看附件里的行程 [[reply 已读取行程。]]");
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="assistant-message"]').length >= 2, null, { timeout: 20000 });
	await waitIdle(page);
	const input = page.locator('[data-testid="composer-input"]');
	await input.fill("/");
	await page.waitForSelector('[data-testid="slash-menu"]');
	await input.press("Enter");
	await page.getByRole("button", { name: /报销制度库/ }).click();
	await page.waitForSelector('[data-testid="chip-kb"]');
	await sendMessage(page, '按制度说明报销时限 [[call kb_search {"query":"报销 发票"}]]');
	await page.waitForSelector('[data-testid="citations"]', { timeout: 30000 });
	await waitIdle(page);
	const users = await page.locator('[data-testid="user-message"]').allInnerTexts();
	check("M01-A: plain chat, attachment and knowledge chip sent from the same composer, no workflow choice", users.length === 3 && users[1].includes("出差行程.txt") && users[2].includes("报销制度库"), users.map((u) => u.split("\n")[0]).join(" | "));
	check("M01-A: knowledge answer carries citations (file · version · locator)", (await page.locator('[data-testid="citation"]').count()) > 0);
	await shot(page, "1440-m01a-three-requests");

	// ---------------------------------------------------------------- citation 失效提示 after the source is updated (C)
	const v2 = await (await page.request.post(`${base}/api/files/${f1.file.id}/versions`, { multipart: { changeNote: "延长到 60 天", file: { name: "报销制度.md", mimeType: "text/markdown", buffer: Buffer.from("# 报销制度\n\n差旅报销需在 60 天内提交，并附电子或纸质发票。\n") } } })).json();
	await page.request.post(`${base}/api/kb/${kb.id}/docs`, { data: { fileId: f1.file.id, versionId: v2.version.versionId } });
	for (let i = 0; i < 60; i++) {
		const d = await (await page.request.get(`${base}/api/kb/${kb.id}/docs`)).json();
		if (d.docs?.[0]?.serving?.versionNo === 2) break;
		await sleep(500);
	}
	await page.reload();
	await page.waitForSelector('[data-testid="citation-stale"]', { timeout: 15000 });
	check("citation 失效提示: old answer keeps its v1 snapshot and says the source was updated", (await page.locator('[data-testid="citations-stale-banner"]').count()) === 1 && (await page.locator('[data-testid="citation"][data-status="superseded"]').count()) > 0);
	await page.locator('[data-testid="citations"]').scrollIntoViewIfNeeded();
	await shot(page, "1440-citation-stale");

	// ---------------------------------------------------------------- per-message outcome after cancel (A)
	await sendMessage(page, "[[slow 20000]] 这一条会被我取消");
	await page.waitForSelector('[data-testid="stop"]', { timeout: 10000 });
	await page.click('[data-testid="stop"]');
	await page.waitForSelector('[data-testid="stop"]', { state: "detached", timeout: 15000 });
	await page.reload();
	await page.waitForSelector('[data-testid="user-message"]', { timeout: 15000 });
	await sleep(600);
	const ocText = await last(page, '[data-testid="user-message"]').innerText();
	check("after a stop (and a reload) the message simply stays, with no outcome line, run bar, 继续 or stop note — 停止就停止 (round 11 simplification; the old 已停止 label is gone)", ocText.includes("这一条会被我取消") && !/已停止|未应用|没有得到回复|未送达/.test(ocText) && (await page.locator('[data-testid="message-outcome"], [data-testid="run-bar"], [data-testid="continue"], [data-testid="stop-note"]').count()) === 0, ocText.replace(/\s+/g, " "));
	await shot(page, "1440-message-outcome");

	// ---------------------------------------------------------------- 待核对 reconcile card (A)
	await sendMessage(page, '发送对外通知 [[call wr_fixture_effect {"key":"notice-1","target":"fixture://outbox","unknownOutcome":true}]]');
	await page.waitForSelector('[data-testid="reconcile-card"]', { timeout: 30000 });
	await waitIdle(page);
	await shot(page, "1440-reconcile-card");
	await page.locator('[data-testid="reconcile-card"]').getByRole("button", { name: "已生效" }).click();
	await page.waitForSelector('[data-testid="reconcile-card"]', { state: "detached", timeout: 15000 });
	check("待核对: unknown external write shown for verification, resolved by the user (no blind retry)", true);

	// ---------------------------------------------------------------- terminal + browse (D, fixture demo mode)
	await page.goto(`${base}/`);
	await sendMessage(page, "请运行一段代码，在终端里看看结果");
	await page.waitForURL(/\/c\//);
	await page.waitForSelector('[data-testid="assistant-message"]', { timeout: 30000 });
	await waitIdle(page);
	const workUrl = page.url();
	await page.click('[data-testid="open-work-panel"]');
	// round 14: the right panel is 输出 / 子任务 / 浏览器 only; there is no terminal view any more
	await page.waitForSelector('[data-testid="work-panel"]');
	check("work panel: three blocks, no terminal tab", (await page.locator('[data-testid="work-panel"] section[data-testid^="block-"]').count()) === 3 && (await page.locator('[data-testid="work-tab-terminal"]').count()) === 0);
	await sleep(400);
	await shot(page, "1440-work-panel");
	await page.click('[data-testid="close-panel"]');
	await sendMessage(page, `打开网页 ${PAGE} 看看内容`);
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="assistant-message"]').length >= 2, null, { timeout: 30000 });
	await waitIdle(page);
	// round 14: a fetched page is not a browser session; the 浏览器 block lists live sessions only (below)

	// ---------------------------------------------------------------- live browser session: watch → take over → click → release (D)
	await sendMessage(page, `[[call browser_open {"url":"${PAGE}"}]]`);
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="assistant-message"]').length >= 3, null, { timeout: 30000 });
	await waitIdle(page);
	await page.click('[data-testid="open-work-panel"]');
	await page.waitForSelector('[data-testid="browser-entry"]', { timeout: 20000 });
	await page.locator('[data-testid="browser-entry"] > button').first().click();
	await page.waitForSelector('[data-testid="browser-session"][data-controller="agent"]', { timeout: 20000 });
	await page.click('[data-testid="browser-takeover"]');
	await page.waitForSelector('[data-testid="browser-session"][data-controller="user"]', { timeout: 10000 });
	const imgBox = await page.locator('[data-testid="browser-screenshot"]').first().boundingBox();
	// the button sits near (40 + ~70, 40 + h1 + p ≈ 190) in the 1280×800 page
	await page.mouse.click(imgBox.x + (110 / 1280) * imgBox.width, imgBox.y + (205 / 800) * imgBox.height);
	await page.waitForFunction(() => document.querySelector('[data-testid="browser-session"]')?.textContent?.includes("click"), null, { timeout: 15000 }).catch(() => {});
	await sleep(1500);
	const sessText = await page.locator('[data-testid="browser-session"]').first().innerText();
	check("take-over: user controls the live session and the click reaches the page", sessText.includes("你在操作") && /已点击|click/i.test(sessText), sessText.replace(/\s+/g, " ").slice(0, 160));
	await shot(page, "1440-browser-takeover");
	await page.click('[data-testid="browser-release"]');
	await page.waitForSelector('[data-testid="browser-session"][data-controller="agent"]', { timeout: 10000 });
	check("take-over: released back to the assistant", true);
	await page.click('[data-testid="close-panel"]');

	// ---------------------------------------------------------------- background job with budget, cancel (D, M14-C)
	await sendMessage(page, '[[call job_start {"kind":"sandbox","title":"长时间统计","sandbox":{"language":"shell","code":"sleep 40; echo ok"},"timeoutMs":120000}]]');
	await page.waitForSelector('[data-testid="job-chip"]', { timeout: 30000 });
	await page.waitForSelector('[data-testid="job-chip"][data-status="running"], [data-testid="job-chip"][data-status="queued"]', { timeout: 20000 });
	await waitIdle(page);
	check("job: long task runs in the background; the chat stays usable", (await page.locator('[data-testid="composer-input"]').isEnabled()));
	await page.click('[data-testid="open-work-panel"]');
	await page.waitForSelector('[data-testid="job"]', { timeout: 10000 });
	await shot(page, "1440-job-running");
	await page.locator('[data-testid="job"] > button').first().click(); // round 14: the row's details (and 取消) sit behind its chevron
	await page.click('[data-testid="job-cancel"]');
	await page.waitForSelector('[data-testid="job"][data-status="cancelled"]', { timeout: 30000 });
	check("job: cancel → 已取消 (panel and in-message chip)", true);
	await page.click('[data-testid="close-panel"]');
	await page.waitForSelector('[data-testid="job-chip"][data-status="cancelled"]', { timeout: 15000 });
	await shot(page, "1440-job-cancelled");

	// ---------------------------------------------------------------- knowledge retry (C)
	await page.goto(`${base}/knowledge/${kb.id}`);
	await page.setInputFiles('[data-testid="kb-upload-input"]', { name: "损坏的文件.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 73) % 256)) });
	const bad = page.locator('[data-testid="kb-doc"]', { hasText: "损坏的文件.docx" });
	await bad.and(page.locator('[data-availability="failed"]')).waitFor({ timeout: 30000 });
	await bad.locator('[data-testid="kb-retry"]').click();
	await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="kb-doc"]')].some((e) => e.textContent?.includes("已尝试 2 次")), null, { timeout: 30000 });
	check("knowledge retry: retry re-runs processing (attempt 2) and the honest failure stays visible", (await bad.getAttribute("data-availability")) === "failed");
	await shot(page, "1440-knowledge-retry");
	// retrieval debug + evaluation samples (M07-C)
	await page.fill('input[placeholder^="输入一个问题"]', "报销 发票");
	await page.getByRole("button", { name: "检索", exact: true }).click();
	await page.waitForSelector('[data-testid="kb-decisions"]', { timeout: 15000 });
	check("retrieval debug: shows per-KB decision (searched, access basis, index readiness)", (await page.locator('[data-testid="kb-decisions"]').innerText()).includes("已检索"));
	await page.locator("summary", { hasText: "问答评估样例" }).click();
	await page.fill('[data-testid="kb-eval-input"]', "报销 发票 => 报销制度.md\n火星基地预算 =>");
	await page.click('[data-testid="kb-eval-run"]');
	await page.waitForSelector('[data-testid="kb-eval-result"]', { timeout: 20000 });
	const ev = await page.locator('[data-testid="kb-eval-result"]').innerText();
	check("evaluation: samples run with pass/rank and no-evidence kept distinct", ev.includes("通过 2/2"), ev.replace(/\s+/g, " ").slice(0, 120));
	await shot(page, "1440-knowledge-debug-eval");

	// ---------------------------------------------------------------- project roles: editor handoff vs viewer read-only
	const proj = (await (await page.request.post(`${base}/api/projects`, { data: { kind: "space", name: "发布会筹备" } })).json()).project;
	const invite = async () => (await (await page.request.post(`${base}/api/admin/invites`, { data: { role: "member", ttlHours: 24 } })).json()).invite.code;
	const join = async (name, role) => {
		const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
		const p = await c.newPage();
		const email = `${role}-${Date.now()}@example.com`;
		await p.goto(`${base}/register?invite=${await invite()}`);
		await p.fill("#name", name);
		await p.fill("#email", email);
		await p.fill("#password", "password123");
		await p.click('button[type="submit"]');
		await p.waitForSelector('[data-testid="home-greeting"]');
		await page.request.put(`${base}/api/projects/${proj.id}/members`, { data: { email, role } });
		return { c, p };
	};
	await page.goto(`${base}/projects/${proj.id}`);
	await sendMessage(page, '整理发布会清单 [[call write {"path":"/work/发布会清单.md","content":"# 清单\\n- 场地\\n- 邀请"}]] [[call present_file {"source":"/work/发布会清单.md"}]]');
	await page.waitForURL(/\/c\//);
	await page.waitForSelector('[data-testid="file-card"]', { timeout: 30000 });
	await waitIdle(page);
	await sendMessage(page, '[[call wr_fixture_approval {"title":"预订场地","summary":"向场地方提交 12 月 1 日的预订","risk":"medium"}]]');
	await page.waitForSelector('[data-testid="approval-card"]', { timeout: 30000 });
	await page.click('[data-testid="approve"]');
	await page.waitForSelector('[data-testid="approval-card"]', { state: "detached", timeout: 20000 });
	await waitIdle(page);
	const projChat = page.url();

	const editor = await join("编辑者乙", "editor");
	await editor.p.goto(projChat);
	await editor.p.waitForSelector('[data-testid="composer-input"]');
	await editor.p.click('[data-testid="chat-more"]');
	await editor.p.click('[data-testid="open-handoff"]');
	await editor.p.waitForSelector('[data-testid="handoff-decisions"]', { timeout: 15000 });
	const ho = await editor.p.locator('[data-testid="handoff"]').innerText();
	check("handoff (editor): decisions, progress and deliverables of the task, and may continue", ho.includes("预订场地") && ho.includes("发布会清单") && ho.includes("你可以接手继续"), ho.replace(/\s+/g, " ").slice(0, 120));
	await shot(editor.p, "1440-handoff-editor");
	await editor.c.close();

	const viewer = await join("查看者丙", "viewer");
	await viewer.p.goto(projChat);
	await viewer.p.waitForSelector('[data-testid="read-only-note"]', { timeout: 15000 });
	check("viewer: no composer, no edit/regenerate/fork actions in the conversation", (await viewer.p.locator('[data-testid="composer-input"]').count()) === 0 && (await viewer.p.locator('[data-testid="action-edit"], [data-testid="action-regenerate"]').count()) === 0);
	const sp2 = projChat.split("/c/")[1];
	const refused = await viewer.p.request.post(`${base}/api/conversations/${sp2}/messages`, { data: { text: "试图发消息", requestId: `v-${Date.now()}` } });
	check("viewer: the server refuses writes anyway", refused.status() === 403, `status=${refused.status()}`);
	await shot(viewer.p, "1440-viewer-readonly");
	await viewer.p.click('[data-testid="chat-more"]');
	await viewer.p.click('[data-testid="open-handoff"]');
	await viewer.p.waitForSelector('[data-testid="handoff-access"]', { timeout: 15000 });
	check("handoff (viewer): shows read-only access reason", (await viewer.p.locator('[data-testid="handoff-access"]').innerText()).includes("只读"));
	await viewer.p.keyboard.press("Escape");
	await viewer.p.goto(`${base}/projects/${proj.id}`);
	await viewer.p.waitForSelector('[data-testid="project-handoff"]', { timeout: 15000 });
	check("viewer: project page shows status, not a composer", (await viewer.p.locator('[data-testid="composer-input"]').count()) === 0);
	await shot(viewer.p, "1440-project-viewer");
	await viewer.c.close();
	await ctx.close();
} catch (e) {
	check("script completed", false, String(e?.stack ?? e));
} finally {
	await browser.close();
	await server.stop();
	pageServer.close();
}
process.exitCode = summary(join(SHOTS, "round2.results.json")) ? 0 : 1;
