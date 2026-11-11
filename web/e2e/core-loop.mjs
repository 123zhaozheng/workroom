// Core loop against the real integrated server with the deterministic fixture model:
// register → home → chat (streaming + tool steps + file card) → preview open/close → approval card →
// queued message while running → v2 via file_revise → edit → branch switch → files page v1/v2 → knowledge page.
// Screenshots: artifacts/screenshots/*.png  ·  Results: artifacts/screenshots/core-loop.results.json
// Run: npm run -w web build && node web/e2e/core-loop.mjs
import { join } from "node:path";
import { check, chromium, recordRequests, register, sendMessage, shot, SHOTS, sleep, startServer, summary } from "./lib.mjs";

const HEAVY = [/shiki|wasm-|\/(cpp|python|typescript|javascript)-/i, /katex/i, /StatsCharts|recharts/i, /PreviewPanel|FrameViewer|TextViewer|ImageViewer/i, /WorkPanel/i, /chunk-7TTQLYRW|streamdown/i];

const server = await startServer({ port: 8802 });
const base = server.base;
const browser = await chromium.launch();
try {
	// ---------------------------------------------------------------- 1440×900 desktop
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
	const page = await ctx.newPage();
	const reqs = recordRequests(page);
	const consoleErrors = [];
	page.on("pageerror", (e) => consoleErrors.push(String(e)));
	page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

	await page.goto(`${base}/login`);
	await sleep(300);
	await shot(page, "1440-login");
	const email = `b-${Date.now()}@example.com`;
	await register(page, base, { email, name: "林夏" });
	await page.waitForLoadState("networkidle");
	await shot(page, "1440-home");

	// Home must not have loaded heavy chunks; no external hosts; fonts only from same origin.
	const homeReqs = [...reqs];
	const heavyOnHome = homeReqs.filter((u) => HEAVY.some((re) => re.test(u)));
	check("home: heavy chunks not loaded (markdown/shiki/katex/recharts/preview/work panel)", heavyOnHome.length === 0, heavyOnHome.join(", "));
	const external = homeReqs.filter((u) => !u.startsWith(base) && !u.startsWith("data:"));
	check("home: no external requests (fonts/CDN)", external.length === 0, external.join(", "));
	check("home: one composer, no dashboard", (await page.locator('[data-testid="composer"]').count()) === 1);
	const models = await (await page.request.get(`${base}/api/models`)).json().catch(() => null);
	if (models?.models?.length) {
		await page.click('[data-testid="model-picker"]');
		await page.waitForSelector('[data-testid="model-option"]');
		const blocked = models.models.filter((m) => m.status === "blocked").length;
		const disabled = await page.locator('[data-testid="model-option"][data-disabled]').count();
		check("home: blocked models shown with reason and not selectable", disabled === blocked, `blocked=${blocked} disabled=${disabled}`);
		const pick = await page.locator('[data-testid="model-picker"]').innerText();
		check("home: model picker label not duplicated", (pick.match(/测试模型/g) ?? []).length <= 1, pick);
		await shot(page, "1440-home-model-picker");
		await page.keyboard.press("Escape");
	} else check("home: model list available from E (GET /api/models)", false, "no models returned");

	// ---------------------------------------------------------------- chat: tool step + file card
	await sendMessage(page, '帮我写一份项目周报 [[call file_create {"name":"项目周报","format":"md","title":"项目周报","content":"# 本周进展\\n- 完成需求评审\\n- 完成原型\\n\\n# 风险\\n- 暂无"}]]');
	await page.waitForURL(/\/c\//);
	await page.waitForSelector('[data-testid="file-card"]', { timeout: 20000 });
	await page.waitForSelector('[data-testid="assistant-message"] .wr-prose', { timeout: 20000 });
	check("chat: tool step rendered in message", (await page.locator('[data-testid="step-chain"]').count()) > 0);
	check("chat: fixture model labelled", (await page.locator('[data-testid="fixture-badge"]').count()) > 0);
	await page.waitForSelector('[data-testid="turn-usage"]', { timeout: 10000 });
	const usageTxt = await page.locator('[data-testid="turn-usage"]').first().innerText();
	const anyTokens = await page.evaluate(() => /\d[\d,]*\s*tokens/i.test(document.querySelector("main")?.innerText ?? ""));
	check("honesty: fixture usage shown as simulated, no token number", usageTxt.includes("模拟用量") && !anyTokens, usageTxt);
	await page.waitForFunction(() => !(document.querySelector('[data-testid="chat-title"]')?.textContent ?? "[[").includes("[["), null, { timeout: 10000 }).catch(() => {});
	const title = await page.locator('[data-testid="chat-title"]').innerText();
	const sideTitles = await page.locator('nav[aria-label="主导航"] a[href^="/c/"]').allInnerTexts();
	check("title: server-side title without [[directives]] in header and sidebar", !title.includes("[[") && sideTitles.length > 0 && sideTitles.every((t) => !t.includes("[[")), `${title} | ${sideTitles[0] ?? ""}`);
	await sleep(400);
	await shot(page, "1440-chat-file-card");
	const chatUrl = page.url();

	// expand steps
	await page.locator('[data-testid="step-chain"] > button').first().click();
	await page.locator('[data-testid="tool-step"] > button').first().click();
	await sleep(250);
	await shot(page, "1440-chat-steps-expanded");

	// preview panel opens / closes
	await page.click('[data-testid="file-card"] button');
	await page.waitForSelector('[data-testid="side-panel"] [data-testid="preview-panel"]');
	await page.waitForSelector('[data-testid="preview-text"], [data-testid="preview-frame"]', { timeout: 15000 });
	await sleep(500);
	check("preview: right-side panel opened", (await page.locator('[data-testid="side-panel"]').count()) === 1);
	await shot(page, "1440-chat-preview-open");
	await page.click('[data-testid="close-panel"]');
	await sleep(250);
	check("preview: closing returns to single column", (await page.locator('[data-testid="side-panel"]').count()) === 0);

	// ---------------------------------------------------------------- approval card
	await sendMessage(page, '发送前请确认 [[call wr_fixture_approval {"title":"对外发送周报","summary":"将《项目周报》v1 发送到 team@example.com","risk":"medium"}]]');
	await page.waitForSelector('[data-testid="approval-card"]', { timeout: 20000 });
	await sleep(300);
	check("approval: pending card shown in the conversation (no run bar above the input)", (await page.locator('[data-testid="approval-card"]').count()) === 1 && (await page.locator('[data-testid="run-bar"]').count()) === 0);
	await shot(page, "1440-chat-approval");
	await page.click('[data-testid="approve"]');
	await page.waitForSelector('[data-testid="approval-card"]', { state: "detached", timeout: 20000 });
	check("approval: card resolves after approve", true);

	// ---------------------------------------------------------------- steer while running
	await sendMessage(page, "[[slow 5000]] 慢慢整理一下要点");
	await page.waitForSelector('[data-testid="stop"]', { timeout: 10000 });
	await sendMessage(page, "另外请把结论放在最前面");
	await page.waitForSelector('[data-testid="message-queue"] [data-testid="queue-item"]', { timeout: 10000 });
	const s1 = await page.locator('[data-testid="queue-item"]').first().getAttribute("data-mode");
	check("queue: a message sent while running waits in the queue (follow-up, runs after the current task)", s1 === "followUp" && (await page.locator('[data-testid="queue-text"]').first().innerText()).includes("另外请把结论放在最前面"), `mode=${s1}`);
	await shot(page, "1440-chat-steer");
	await page.waitForFunction(() => !document.querySelector('[data-testid="queue-item"]') && [...document.querySelectorAll('[data-testid="user-message"]')].some((e) => e.textContent.includes("另外请把结论放在最前面")), null, { timeout: 40000 });
	check("queue: it was sent automatically once the current task finished", true);
	await page.waitForSelector('[data-testid="stop"]', { state: "detached", timeout: 30000 });

	// ---------------------------------------------------------------- v2 via file_revise
	const files = await (await page.request.get(`${base}/api/files`)).json();
	const fileId = files.files?.[0]?.id;
	check("files api: deliverable is in the file library", !!fileId);
	await sendMessage(page, `补充风险后更新 [[call file_revise {"fileId":"${fileId}","changeNote":"补充风险与下周计划","content":"# 本周进展\\n- 完成需求评审\\n- 完成原型\\n\\n# 风险\\n- 接口联调可能延期\\n\\n# 下周计划\\n- 开始开发"}]]`);
	await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="file-card"]')].some((e) => e.textContent?.includes("v2")), null, { timeout: 20000 });
	check("chat: v2 file card", true);
	await page.waitForSelector('[data-testid="stop"]', { state: "detached", timeout: 30000 });

	// ---------------------------------------------------------------- edit → new branch, switcher
	const firstUser = page.locator('[data-testid="user-message"]').first();
	await firstUser.hover();
	await firstUser.locator('[data-testid="action-edit"]').click();
	await firstUser.locator("textarea").fill("帮我写一份更简短的周报 [[reply 好的，这是简短版本。]]");
	await firstUser.locator('[data-testid="edit-save"]').click();
	await page.waitForURL((u) => u.toString() !== chatUrl, { timeout: 15000 });
	await page.waitForSelector('[data-testid="branch-badge"]', { timeout: 15000 });
	await page.waitForSelector('[data-testid="assistant-message"]', { timeout: 20000 });
	await page.waitForSelector('[data-testid="branch-switcher"]', { timeout: 15000 });
	check("branch: edit created a branch (original untouched)", true, page.url());
	await page.reload();
	await page.waitForSelector('[data-testid="branch-badge"]', { timeout: 15000 });
	await page.waitForSelector('[data-testid="branch-switcher"]', { timeout: 15000 });
	check("branch: after a refresh the branch, its answer and the switcher are still there", (await page.locator('[data-testid="assistant-message"]').count()) > 0);
	await sleep(400);
	await shot(page, "1440-chat-branch");
	const branchUrl = page.url();
	await page.locator('[data-testid="branch-switcher"] button[aria-label="上一个分支"]').first().click();
	await page.waitForURL((u) => u.toString() !== branchUrl, { timeout: 10000 });
	await page.waitForSelector('[data-testid="file-card"]', { timeout: 15000 });
	check("branch: switcher returns to the original conversation with its results", page.url() === chatUrl, page.url());

	// ---------------------------------------------------------------- files page: v1 / v2, provenance
	await page.goto(`${base}/files`);
	await page.waitForSelector('[data-testid="file-row"]');
	await shot(page, "1440-files");
	await page.goto(`${base}/files/${fileId}`);
	await page.waitForSelector('[data-testid="version-item"]');
	await sleep(800);
	check("files: two versions listed", (await page.locator('[data-testid="version-item"]').count()) === 2);
	await shot(page, "1440-file-detail-v2");
	await page.locator('[data-testid="version-item"] button').nth(1).click();
	await sleep(800);
	await shot(page, "1440-file-detail-v1");
	check("files: switched preview to v1", page.url().includes("?v="));

	// ---------------------------------------------------------------- knowledge: processing → searchable
	await page.goto(`${base}/knowledge`);
	await page.waitForLoadState("networkidle");
	check("knowledge: page is connected (C routes present)", (await page.locator('[data-testid="unavailable"]').count()) === 0);
	{
		await page.getByRole("button", { name: "新建知识库" }).first().click();
		await page.fill("#kbname", "产品资料");
		await page.getByRole("button", { name: "创建" }).click();
		await page.waitForURL(/\/knowledge\/.+/);
		await page.setInputFiles('[data-testid="kb-upload-input"]', { name: "报销制度.md", mimeType: "text/markdown", buffer: Buffer.from("# 报销制度\n\n差旅报销需在 30 天内提交，附发票原件。\n\n## 审批\n部门负责人审批后由财务复核。\n") });
		await page.waitForSelector('[data-testid="kb-doc"]', { timeout: 15000 });
		const first = await page.locator('[data-testid="kb-doc"]').first().getAttribute("data-availability");
		check("knowledge: new doc never shown as ready before the server says so", ["processing", "ready", "failed"].includes(first ?? ""), `initial=${first}`);
		await page.waitForSelector('[data-testid="kb-doc"][data-availability="ready"], [data-testid="kb-doc"][data-availability="failed"]', { timeout: 30000 });
		const fin = await page.locator('[data-testid="kb-doc"]').first().getAttribute("data-availability");
		check("knowledge: doc reaches 可检索 (or explicit 失败 with retry)", fin === "ready" || fin === "failed", `final=${fin}`);
		await page.fill('input[placeholder^="输入一个问题"]', "报销");
		await page.getByRole("button", { name: "检索", exact: true }).click();
		await page.waitForSelector('[data-testid="kb-search-result"]', { timeout: 10000 });
		await shot(page, "1440-knowledge");
	}

	// ---------------------------------------------------------------- 1366×768: home + chat with preview
	const ctx2 = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 2, storageState: await ctx.storageState() });
	const p2 = await ctx2.newPage();
	await p2.goto(`${base}/`);
	await p2.waitForSelector('[data-testid="home-greeting"]');
	await shot(p2, "1366-home");
	await p2.goto(chatUrl);
	await p2.waitForSelector('[data-testid="file-card"]', { timeout: 15000 });
	await p2.locator('[data-testid="file-card"] button').last().click();
	await p2.waitForSelector('[data-testid="side-panel"]');
	await sleep(800);
	await shot(p2, "1366-chat-preview");
	const w = await p2.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
	check("1366: no horizontal overflow with preview open", w.sw <= w.cw, JSON.stringify(w));
	// collapse sidebar
	await p2.click('[data-testid="close-panel"]');
	await p2.click('button[aria-label="收起侧栏"]');
	await sleep(200);
	check("1366: sidebar collapsible", (await p2.locator('[data-testid="sidebar"]').count()) === 0);
	await shot(p2, "1366-chat-sidebar-collapsed");
	await p2.click('[data-testid="open-sidebar"]');
	await ctx2.close();

	// ---------------------------------------------------------------- 390×844 mobile: drawer, not columns
	const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
	const p3 = await ctx3.newPage();
	await p3.goto(`${base}/`);
	await p3.waitForSelector('[data-testid="home-greeting"]');
	await shot(p3, "390-home");
	check("390: sidebar not inline", (await p3.locator('[data-testid="sidebar"]').count()) === 0);
	await p3.click('[data-testid="open-sidebar"]');
	await p3.waitForSelector('[data-testid="sheet-left"]');
	await sleep(300);
	await shot(p3, "390-nav-drawer");
	await p3.keyboard.press("Escape");
	await p3.goto(chatUrl);
	await p3.waitForSelector('[data-testid="file-card"]', { timeout: 15000 });
	await sleep(300);
	await shot(p3, "390-chat");
	await p3.locator('[data-testid="file-card"] button').last().click();
	await p3.waitForSelector('[data-testid="side-drawer"] [data-testid="preview-panel"]');
	await sleep(800);
	check("390: preview opens as a drawer (no side column)", (await p3.locator('[data-testid="side-panel"]').count()) === 0);
	await shot(p3, "390-preview-drawer");
	const w3 = await p3.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
	check("390: no horizontal page scroll", w3.sw <= w3.cw, JSON.stringify(w3));
	await ctx3.close();

	// ---------------------------------------------------------------- reduced motion
	const ctx4 = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", storageState: await ctx.storageState() });
	const p4 = await ctx4.newPage();
	await p4.goto(chatUrl);
	await p4.waitForSelector('[data-testid="assistant-avatar"]');
	const dur = await p4.evaluate(() => {
		const el = document.createElement("div");
		el.className = "wr-pulse wr-spin";
		document.body.appendChild(el);
		const d = getComputedStyle(el).animationDuration;
		el.remove();
		return d;
	});
	check("reduced-motion (system): state animations disabled", parseFloat(dur) < 0.01, `animation-duration=${dur}`);
	await ctx4.close();
	const ctx5 = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: await ctx.storageState() });
	const p5 = await ctx5.newPage();
	await p5.goto(`${base}/settings`);
	await p5.click('[data-testid="reduce-motion-toggle"]');
	const dur2 = await p5.evaluate(() => {
		const el = document.createElement("div");
		el.className = "wr-pulse";
		document.body.appendChild(el);
		const d = getComputedStyle(el).animationDuration;
		el.remove();
		return { d, attr: document.documentElement.dataset.reduceMotion };
	});
	check("reduced-motion (in-app toggle): animations disabled", parseFloat(dur2.d) < 0.01 && dur2.attr === "true", JSON.stringify(dur2));
	await shot(p5, "1440-settings");
	const ambient = await p5.evaluate(() => [...document.querySelectorAll("*")].filter((e) => getComputedStyle(e).animationIterationCount === "infinite" && getComputedStyle(e).animationName !== "none").length);
	check("no ambient animation on idle pages", ambient === 0, `infinite animations=${ambient}`);
	await ctx5.close();

	// ---------------------------------------------------------------- fonts & external hosts over the whole session
	const ext = reqs.filter((u) => !u.startsWith(base) && !u.startsWith("data:") && !u.startsWith("blob:"));
	check("session: no external requests at all (fonts work offline)", ext.length === 0, ext.slice(0, 5).join(", "));
	const fonts = reqs.filter((u) => /\.(woff2?|ttf|otf)(\?|$)/.test(u));
	check("session: fonts served from same origin /assets", fonts.every((u) => u.startsWith(`${base}/assets/`)), fonts.map((u) => u.replace(base, "")).join(", "));
	check("no uncaught page errors", consoleErrors.filter((e) => !/Failed to load resource/.test(e)).length === 0, consoleErrors.slice(0, 3).join(" | "));
	await ctx.close();
} catch (e) {
	check("script completed", false, String(e?.stack ?? e));
} finally {
	await browser.close();
	await server.stop();
}
process.exitCode = summary(join(SHOTS, "core-loop.results.json")) ? 0 : 1;
