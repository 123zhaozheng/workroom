// Round 5 · G1 (home, composer, attachments, model menu, shared overlays): popovers are opaque and never run under the title bar,
// keyboard reachability (Tab / arrows / Esc / focus restore), drag-drop / paste / upload failure states, no horizontal scroll at
// 390, reduced motion = static dots, dark mode, danger button contrast, copy (no subtitles / jargon).
// Run: npm run -w web build && node web/e2e/round5-g1.mjs        (port 8872)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, chromium, register, sendMessage, sleep, startServer, summary, ROOT } from "./lib.mjs";

const PORT = 8872;
const OUT = join(ROOT, "artifacts/screenshots/round5/after");
const server = await startServer({ port: PORT, env: { WORKROOM_RT_RETRY_MAX: "0" } });
const base = server.base;
const browser = await chromium.launch();

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const INIT = () => {
	window.__raf = 0;
	const orig = window.requestAnimationFrame.bind(window);
	window.requestAnimationFrame = (cb) => orig((t) => {
		window.__raf++;
		cb(t);
	});
};
const shot = (page, name) => page.screenshot({ path: join(OUT, `g1-e2e-${name}.png`) });
const active = (page) => page.evaluate(() => { const a = document.activeElement; return a ? (a.getAttribute("data-testid") ?? a.getAttribute("aria-label") ?? a.tagName) : null; });
const tiles = (page) => page.locator('[data-testid="chip-file"]');
const allReady = (page, n) => page.waitForFunction((n) => { const t = [...document.querySelectorAll('[data-testid="chip-file"]')]; return t.length === n && t.every((x) => x.getAttribute("data-state") === "ready"); }, n, { timeout: 20000 });
async function dropFiles(page, selector, files, { type = "drop" } = {}) {
	const dt = await page.evaluateHandle((fs) => {
		const d = new DataTransfer();
		for (const f of fs) d.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
		return d;
	}, files.map((f) => ({ name: f.name, type: f.type, b64: f.buffer.toString("base64") })));
	await page.dispatchEvent(selector, "dragenter", { dataTransfer: dt });
	await page.dispatchEvent(selector, "dragover", { dataTransfer: dt });
	if (type === "drop") await page.dispatchEvent(selector, "drop", { dataTransfer: dt });
}
const rect = (page, sel) => page.locator(sel).first().evaluate((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height }; });
const hOverflow = (page) => page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth, body: document.body.scrollWidth }));
const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const rgbOf = (s) => (s.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);

/** The open model menu: opaque, finished animating, inside the viewport and clear of the top bar. */
async function menuGeometry(page, sel = '[data-testid="model-menu"]') {
	await page.waitForSelector(sel);
	await sleep(400);
	return page.evaluate((sel) => {
		const m = document.querySelector(sel);
		const cs = getComputedStyle(m);
		const r = m.getBoundingClientRect();
		const headers = [...document.querySelectorAll("header")].map((h) => h.getBoundingClientRect()).filter((h) => h.width > 400);
		const header = headers[0];
		const title = document.querySelector('[data-testid="home-greeting"], [data-testid="chat-title"]')?.getBoundingClientRect();
		const bg = cs.backgroundColor.match(/[\d.]+/g).map(Number);
		return {
			opacity: Number(cs.opacity),
			bgAlpha: bg.length === 4 ? bg[3] : 1,
			running: m.getAnimations().filter((a) => a.playState === "running").length,
			rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
			headerBottom: header ? header.bottom : 0,
			titleOverlap: title ? !(r.bottom <= title.top || r.top >= title.bottom || r.right <= title.left || r.left >= title.right) : false,
			inViewport: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
			scrolls: m.scrollHeight > m.clientHeight + 1,
		};
	}, sel);
}

try {
	// ================================================================= desktop 1440 × 900
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
	await ctx.addInitScript(INIT);
	const page = await ctx.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await register(page, base, { email: `g1-${Date.now()}@example.com`, name: "林夏" });
	await page.waitForLoadState("networkidle");
	await page.request.post(`${base}/api/admin/model-providers`, { data: { name: "E2E 兼容", type: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", keyless: true, models: [{ id: "e2e-pro", name: "E2E Pro", description: "多模态与推理", contextWindow: 200000, maxTokens: 8192, input: ["text", "image"], reasoning: true }, { id: "e2e-fast", name: "E2E Fast", description: "速度快", contextWindow: 128000, maxTokens: 4096, input: ["text"] }] } });
	await page.request.post(`${base}/api/admin/model-providers`, { data: { name: "E2E 缺密钥", type: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "e2e-nokey", name: "E2E 缺密钥模型" }] } });
	await page.request.post(`${base}/api/skills`, { data: { name: "周报模板", kind: "prompt", description: "周报的固定开头", instructions: "请按“结论—进展—风险—计划”的顺序写周报。" } });
	const modelList = await (await page.request.get(`${base}/api/models`)).json();
	const fixtureId = modelList.models.find((m) => m.fixture || m.status === "fixture")?.id;
	await page.goto(`${base}/`);
	await page.waitForSelector('[data-testid="home-greeting"]');
	await page.waitForSelector('[data-testid="model-picker"]');
	await sleep(800);

	// ---------------------------------------------------------------- 1. home: simple, no subtitles
	const home = await page.evaluate(() => {
		const main = document.querySelector('[data-testid="home-greeting"]').closest("div.flex-col");
		const chips = [...document.querySelectorAll('[aria-label="起步建议"] button')].map((b) => b.textContent.trim());
		const c = document.querySelector('[data-testid="composer"]').getBoundingClientRect();
		return { paras: main.parentElement.querySelectorAll("p").length, chips, composerW: c.width, text: main.parentElement.innerText };
	});
	check("home: greeting + composer + at most 4 starter chips, no subtitle paragraph (tagline removed)", home.paras === 0 && home.chips.length >= 3 && home.chips.length <= 4 && !home.text.includes("把要完成的事交给我"), JSON.stringify({ chips: home.chips, paras: home.paras }));
	check("home: composer is one box, at most 680 wide (generous whitespace)", home.composerW <= 681 && home.composerW > 400, `${home.composerW}`);
	const ph = await page.locator('[data-testid="composer-input"]').getAttribute("placeholder");
	check("home: placeholder is short (≤ 12 chars)", ph.length <= 12, ph);
	check("home: dot matrix is there and animated", (await page.locator('[data-testid="dot-matrix"]').count()) === 1 && (await page.evaluate(() => window.__wrDots?.mode)) === "animated");
	await shot(page, "home");

	// ---------------------------------------------------------------- 2. model menu: opaque, not under the title, flips / scrolls
	await page.click('[data-testid="model-picker"]');
	let g = await menuGeometry(page);
	check("model menu (home): fully opaque after the animation (computed opacity 1, background alpha 1, no animation running)", g.opacity === 1 && g.bgAlpha === 1 && g.running === 0, JSON.stringify(g));
	check("model menu (home): does not overlap the greeting and stays inside the viewport", !g.titleOverlap && g.inViewport, JSON.stringify(g.rect));
	check("model menu (home): below the top bar", g.rect.top >= g.headerBottom, `${g.rect.top} ≥ ${g.headerBottom}`);
	const menuText = await page.locator('[data-testid="model-menu"]').innerText();
	check("model menu: no jargon (Fixture / provider / JSON), blocked reason is one short line", !/Fixture|provider|JSON|SSE/i.test(menuText) && /不可用：未配置密钥/.test(menuText) && !/可勾选/.test(menuText), menuText.replace(/\n/g, " | ").slice(0, 260));
	const caps = await page.locator('[data-testid="model-option"] [data-cap]').evaluateAll((els) => els.map((e) => ({ cap: e.dataset.cap, label: e.getAttribute("aria-label"), text: e.textContent.trim() })));
	check("model menu: capabilities are icons (no text) with a plain-language tooltip label", caps.length >= 4 && caps.every((c) => c.text === "" && c.label && /^能|^擅/.test(c.label)), JSON.stringify(caps.slice(0, 4)));
	const fx = await page.locator('[data-testid="model-option"][data-status="fixture"]').innerText();
	check("model menu: the test model is labelled 测试模型 exactly once", (fx.match(/测试模型/g) ?? []).length === 1, fx.replace(/\n/g, " "));
	await shot(page, "model-menu");
	await page.keyboard.press("Escape");
	await page.waitForSelector('[data-testid="model-menu"]', { state: "detached" });
	await sleep(150);
	check("model menu: Esc closes it and focus returns to the model chip", (await active(page)) === "model-picker");

	// dark mode: still opaque and readable
	await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
	await sleep(300);
	await page.click('[data-testid="model-picker"]');
	g = await menuGeometry(page);
	check("model menu (dark): opaque, background differs from the page background", g.opacity === 1 && g.bgAlpha === 1, JSON.stringify(g));
	const darkSurface = await page.evaluate(() => [getComputedStyle(document.querySelector('[data-testid="model-menu"]')).backgroundColor, getComputedStyle(document.body).backgroundColor]);
	check("model menu (dark): uses the dark surface token, not white", rgbOf(darkSurface[0])[0] < 60 && darkSurface[0] !== darkSurface[1], darkSurface.join(" vs "));
	await shot(page, "dark-model-menu");
	await page.keyboard.press("Escape");
	await shot(page, "dark-home");
	await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });

	// ---------------------------------------------------------------- 3. keyboard: Tab → + / model / send, arrows, Esc, focus restore
	const ta = page.locator('[data-testid="composer-input"]');
	await ta.fill("键盘测试");
	await ta.focus();
	const ringOf = () => page.locator('[data-testid="send"]').evaluate((e) => { const c = getComputedStyle(e); return { shadow: c.boxShadow, outline: `${c.outlineStyle} ${c.outlineWidth}`, focusVisible: e.matches(":focus-visible") }; });
	const ringBefore = await ringOf(); // same element, not focused yet
	const seen = [];
	for (let i = 0; i < 8; i++) {
		await page.keyboard.press("Tab");
		seen.push(await active(page));
		if (seen.at(-1) === "send") break;
	}
	const iPlus = seen.indexOf("attach-menu");
	const iModel = seen.indexOf("model-picker");
	const iSend = seen.indexOf("send");
	check("keyboard: Tab from the message box reaches + → model → send, in that order", iPlus >= 0 && iModel > iPlus && iSend > iModel, seen.join(" → "));
	const ringAfter = await ringOf(); // reached with the keyboard (Tab), so :focus-visible applies
	check("keyboard: the send button shows a visible focus ring only once focused (box-shadow / outline differ from its unfocused state)", !ringBefore.focusVisible && ringAfter.focusVisible && (ringAfter.shadow !== ringBefore.shadow || ringAfter.outline !== ringBefore.outline) && /rgb\(\d+, \d+, \d+\) 0px 0px 0px 2px/.test(ringAfter.shadow), JSON.stringify({ ringBefore, ringAfter }));
	await ta.fill("");
	// + menu via keyboard
	await page.focus('[data-testid="attach-menu"]');
	await page.keyboard.press("Enter");
	await page.waitForSelector('[role="menu"]');
	await page.keyboard.press("ArrowDown");
	const hi = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
	check("keyboard: + menu opens with Enter and the arrow keys move through the items", /^attach-/.test(hi ?? ""), hi);
	const attachText = await page.locator('[role="menu"]').innerText();
	check("keyboard: + menu lists 上传文件 / 从文件库选择 / 引用知识库 / 使用技能 with a single hint line", ["上传文件", "从文件库选择", "引用知识库", "使用技能"].every((t) => attachText.includes(t)) && !/本条消息的资料|已启用的技能/.test(attachText), attachText.replace(/\n/g, " | "));
	const ag = await menuGeometry(page, '[role="menu"]');
	check("+ menu (home): opaque and below the top bar", ag.opacity === 1 && ag.bgAlpha === 1 && ag.rect.top >= ag.headerBottom && !ag.titleOverlap, JSON.stringify(ag.rect));
	await page.keyboard.press("Escape");
	await page.waitForSelector('[role="menu"]', { state: "detached" });
	await sleep(150);
	check("keyboard: Esc closes the + menu and focus returns to +", (await active(page)) === "attach-menu");
	// controlled dialog (no <Trigger>): focus goes back to the opener
	await page.keyboard.press("Enter");
	await page.waitForSelector('[data-testid="attach-library"]');
	await page.click('[data-testid="attach-library"]');
	await page.waitForSelector('[role="dialog"]');
	const trapped = await (async () => {
		for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
		return page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
	})();
	check("dialog: Tab cycles inside the dialog (focus trap)", trapped);
	await page.keyboard.press("Escape");
	await page.waitForSelector('[role="dialog"]', { state: "detached" });
	await sleep(150);
	const afterDlg = await active(page);
	check("dialog: Esc closes it and focus is restored (to the + button or the message box, never lost on <body>)", afterDlg === "attach-menu" || afterDlg === "composer-input", afterDlg);
	// a dialog opened from the keyboard in the message box (slash menu → 引用知识库) gives focus back to that box
	await ta.focus();
	await page.keyboard.type("/");
	await page.waitForSelector('[data-testid="slash-menu"]');
	check("slash menu: one line per item, no explanatory subtitles", !/本条消息的资料|附加已有文件|上传后作为附件/.test(await page.locator('[data-testid="slash-menu"]').innerText()));
	await page.keyboard.press("Enter");
	await page.waitForSelector('[role="dialog"]');
	await page.keyboard.press("Escape");
	await page.waitForSelector('[role="dialog"]', { state: "detached" });
	await sleep(150);
	check("dialog (opened from the message box): Esc restores focus to the message box", (await active(page)) === "composer-input", await active(page));
	await ta.fill("");
	// model menu: thinking levels reachable with the keyboard
	await page.locator('[data-testid="model-picker"]').focus();
	await page.keyboard.press("Enter");
	await page.waitForSelector('[data-testid="model-option"]');
	await page.locator('[data-testid="model-option"]', { hasText: "E2E Pro" }).click();
	await page.mouse.move(5, 5); // a pointer resting over the reopened menu would steal the highlight from the keyboard
	await page.locator('[data-testid="model-picker"]').focus();
	await page.keyboard.press("Enter");
	await page.waitForSelector('[data-testid="thinking-levels"]');
	await sleep(300);
	await page.keyboard.press("End");
	await sleep(300);
	const lastActive = await page.evaluate(() => ({ level: document.activeElement?.getAttribute("data-level"), role: document.activeElement?.getAttribute("role"), text: document.activeElement?.textContent?.slice(0, 20), open: !!document.querySelector("[data-testid=model-menu]") }));
	check("keyboard: thinking levels are menu radios reachable with the arrow / End keys", !!lastActive.level && lastActive.role === "menuitemradio", JSON.stringify(lastActive));
	await page.keyboard.press("Enter");
	await sleep(150);
	const lvlChecked = await page.locator('[data-testid="thinking-levels"] [aria-checked="true"]').getAttribute("data-level");
	check("keyboard: choosing a level with Enter applies it", lvlChecked === lastActive.level, lvlChecked);
	await page.keyboard.press("Escape");

	// ---------------------------------------------------------------- 4. drag & drop, paste, progress, errors
	await dropFiles(page, '[data-testid="composer"]', [{ name: "季度汇总.pdf", type: "application/pdf", buffer: PDF }], { type: "enter" });
	await page.waitForSelector('[data-testid="drop-overlay"]', { timeout: 3000 });
	const ov = await page.locator('[data-testid="drop-overlay"]').innerText();
	const ovBg = await page.locator('[data-testid="drop-overlay"]').evaluate((e) => getComputedStyle(e).backgroundColor);
	check("drop: overlay says 松开鼠标 and states the real limits (count / size)", /松开/.test(ov) && /最多 10 个/.test(ov) && /100 MB/.test(ov), ov.replace(/\n/g, " "));
	await shot(page, "drop-overlay");
	await page.dispatchEvent('[data-testid="composer"]', "dragleave", { dataTransfer: await page.evaluateHandle(() => { const d = new DataTransfer(); d.items.add(new File(["x"], "x.txt")); return d; }) });
	await page.waitForFunction(() => !document.querySelector('[data-testid="drop-overlay"]'));
	await dropFiles(page, '[data-testid="composer"]', [
		{ name: "季度汇总.pdf", type: "application/pdf", buffer: PDF },
		{ name: "封面.png", type: "image/png", buffer: PNG },
		{ name: "客户名单-2024-第三季度-终稿-请勿外传.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("PK\x03\x04 fake") },
	]);
	await allReady(page, 3);
	check("drop: three files upload and become ready cards (pdf / image / xls)", (await tiles(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")))).join(",") === "pdf,image,xls");
	const nameGeo = await tiles(page).nth(2).evaluate((e) => { const n = e.querySelector("[data-name]"); const x = e.querySelector('[data-testid="tile-remove"]').getBoundingClientRect(); const t = n.lastElementChild.getBoundingClientRect(); return { tail: n.lastElementChild.textContent, tailRight: t.right, removeLeft: x.left }; });
	check("cards: a long name keeps its extension and never runs under the remove button", nameGeo.tail.endsWith(".xlsx") && nameGeo.tailRight <= nameGeo.removeLeft + 1, JSON.stringify(nameGeo));
	// paste
	await page.evaluate((b64) => {
		const dt = new DataTransfer();
		dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "image.png", { type: "image/png" }));
		document.querySelector('[data-testid="composer-input"]').dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
	}, PNG.toString("base64"));
	await allReady(page, 4);
	check("paste: an image on the clipboard becomes a named attachment", /粘贴的图片/.test(await tiles(page).last().innerText()));
	// upload error: network failure → reason, retry, remove, send blocked, alert
	await page.route("**/api/files", (r) => r.abort("failed"));
	await page.setInputFiles('[data-testid="file-input"]', { name: "会失败的文件.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
	await page.waitForSelector('[data-testid="chip-file"][data-state="failed"]');
	const failed = tiles(page).last();
	const failTxt = await failed.innerText();
	check("upload error: the card says 上传失败 with the reason, offers 重试 and 移除", /上传失败：/.test(failTxt) && /重试/.test(failTxt) && (await failed.locator('[data-testid="tile-remove"]').count()) === 1, failTxt.replace(/\n/g, " "));
	check("upload error: an alert explains how to continue and sending is blocked", /请重试或移除/.test(await page.locator('[data-testid="composer-error"]').innerText()) && (await page.locator('[data-testid="send"]').isDisabled()));
	const failVisible = await failed.evaluate((e) => { const r = e.getBoundingClientRect(); const p = e.parentElement.getBoundingClientRect(); return r.top >= p.top - 1 && r.bottom <= p.bottom + 1; });
	check("upload error: the failed card is fully visible in the list (list scrolls to it)", failVisible);
	await shot(page, "upload-error");
	await page.unroute("**/api/files");
	await failed.locator('[data-testid="tile-retry"]').click();
	await allReady(page, 5);
	check("upload error: 重试 succeeds, the error alert disappears", (await page.locator('[data-testid="composer-error"]').count()) === 0);
	await failed.locator('[data-testid="tile-remove"]').click();
	// too big: refused at once with the limit, no retry offered
	// 101 MB built inside the page (a zero-filled buffer), dropped on the composer: refused before any upload starts
	await page.evaluate(() => {
		const d = new DataTransfer();
		d.items.add(new File([new ArrayBuffer(101 * 1024 * 1024)], "超大录像.mp4", { type: "video/mp4" }));
		const t = document.querySelector('[data-testid="composer"]');
		t.dispatchEvent(new DragEvent("dragenter", { dataTransfer: d, bubbles: true, cancelable: true }));
		t.dispatchEvent(new DragEvent("drop", { dataTransfer: d, bubbles: true, cancelable: true }));
	});
	await page.waitForSelector('[data-testid="chip-file"][data-state="failed"]');
	const bigTxt = await page.locator('[data-testid="chip-file"][data-state="failed"]').innerText();
	check("upload error: a file over 100 MB is refused with the limit and cannot be retried", /超过 100 MB/.test(bigTxt) && (await page.locator('[data-testid="tile-retry"]').count()) === 0, bigTxt.replace(/\n/g, " "));
	await page.locator('[data-testid="chip-file"][data-state="failed"] [data-testid="tile-remove"]').click();
	// progress bar (throttled upload)
	const cdpNet = await ctx.newCDPSession(page);
	await cdpNet.send("Network.enable");
	await cdpNet.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 600 * 1024 });
	await page.setInputFiles('[data-testid="file-input"]', { name: "录音.zip", mimeType: "application/zip", buffer: Buffer.alloc(1_800_000, 7) });
	await page.waitForSelector('[data-testid="chip-file"][data-state="uploading"]');
	await sleep(700);
	const pb = await page.locator('[data-testid="chip-file"][data-state="uploading"] [role="progressbar"]').evaluate((e) => ({ now: Number(e.getAttribute("aria-valuenow")), w: e.firstElementChild.getBoundingClientRect().width, h: e.getBoundingClientRect().height }));
	check("progress: a real progress bar (role=progressbar, aria-valuenow, visible fill) while uploading", pb.now > 0 && pb.now < 100 && pb.w > 0 && pb.h >= 4, JSON.stringify(pb));
	await allReady(page, 5);
	await cdpNet.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
	await ta.fill("帮我整理这些资料");
	await shot(page, "attachments");
	await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
	await sleep(300);
	await shot(page, "dark-attachments");
	await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });

	// ---------------------------------------------------------------- 5. chat page: menu never under the title (even in a short window)
	await page.evaluate((id) => localStorage.setItem("wr.model.default.v1", JSON.stringify({ id })), fixtureId);
	await page.goto(`${base}/`);
	await page.waitForSelector('[data-testid="composer"]');
	await sendMessage(page, "你好 [[reply 你好，我在。]]");
	await page.waitForURL(/\/c\//);
	await page.waitForSelector('[data-testid="assistant-message"]', { timeout: 20000 });
	await page.waitForSelector('[data-testid="stop"]', { state: "detached", timeout: 20000 });
	await page.waitForSelector('[data-testid="chat-title"]');
	for (const [w, h] of [[1366, 768], [1366, 460]]) {
		await page.setViewportSize({ width: w, height: h });
		await sleep(300);
		await page.click('[data-testid="model-picker"]');
		const cg = await menuGeometry(page);
		const title = await page.evaluate(() => { const t = document.querySelector('[data-testid="chat-title"]').getBoundingClientRect(); return { top: t.top, bottom: t.bottom }; });
		check(`model menu (chat ${w}×${h}): opaque, below the top bar and the title, inside the viewport${cg.scrolls ? " (list scrolls)" : ""}`, cg.opacity === 1 && cg.bgAlpha === 1 && cg.rect.top >= cg.headerBottom - 0.5 && cg.rect.top >= title.bottom - 0.5 && cg.inViewport, JSON.stringify({ rect: cg.rect, headerBottom: cg.headerBottom, title }));
		if (h === 768) await shot(page, "chat-model-menu");
		await page.keyboard.press("Escape");
		await page.waitForSelector('[data-testid="model-menu"]', { state: "detached" });
	}
	await page.setViewportSize({ width: 1440, height: 900 });
	const chatTa = await page.locator('[data-testid="composer-input"]').evaluate((e) => ({ ph: e.placeholder }));
	check("chat: composer placeholder stays short", chatTa.ph.length <= 12, chatTa.ph);

	// ---------------------------------------------------------------- 6. danger button contrast, both themes
	const btnSrc = readFileSync(join(ROOT, "web/src/components/ui/button.tsx"), "utf8");
	check("button: danger variant is bg-danger + text-accent-fg (no fixed white)", /danger: "bg-danger text-accent-fg/.test(btnSrc) && !/danger: "[^"]*text-white/.test(btnSrc));
	for (const theme of ["light", "dark"]) {
		await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
		const [fg, bg] = await page.evaluate(() => {
			const b = document.createElement("button");
			b.className = "bg-danger text-accent-fg";
			b.textContent = "删除";
			document.body.appendChild(b);
			const cs = getComputedStyle(b);
			const out = [cs.color, cs.backgroundColor];
			b.remove();
			return out;
		});
		const r = ratio(rgbOf(fg), rgbOf(bg));
		check(`button: danger text contrast ≥ 4.5:1 (${theme})`, r >= 4.5, `${r.toFixed(2)}:1 (${fg} on ${bg})`);
	}
	await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });

	// ---------------------------------------------------------------- 7. in-app switch: dot matrix off
	await page.goto(`${base}/settings`);
	await page.waitForSelector('[data-testid="dot-matrix-toggle"]');
	const wasOn = await page.locator('[data-testid="dot-matrix-toggle"]').isChecked();
	await page.click('[data-testid="dot-matrix-toggle"]');
	await page.goto(`${base}/`);
	await page.waitForSelector('[data-testid="home-greeting"]');
	check("dot matrix: the settings switch turns it off (nothing rendered)", wasOn && (await page.locator('[data-testid="dot-matrix"]').count()) === 0);
	await page.goto(`${base}/settings`);
	await page.click('[data-testid="dot-matrix-toggle"]');
	await page.goto(`${base}/`);
	await page.waitForSelector('[data-testid="dot-matrix"]');
	check("dot matrix: switching it back on restores it", true);
	check("no uncaught page errors on desktop", errors.length === 0, errors.join(" | "));
	const stateFile = await ctx.storageState();
	await ctx.close();

	// ================================================================= system reduced motion
	const rctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", locale: "zh-CN", storageState: stateFile });
	await rctx.addInitScript(INIT);
	const rp = await rctx.newPage();
	await rp.goto(`${base}/`);
	await rp.waitForSelector('[data-testid="dot-matrix"]');
	await sleep(800);
	const r0 = await rp.evaluate(() => ({ raf: window.__raf, dots: { ...window.__wrDots } }));
	await sleep(1500);
	const r1 = await rp.evaluate(() => ({ raf: window.__raf, dots: { ...window.__wrDots } }));
	check("reduced motion: the dot matrix is static (one drawn frame, zero rAF callbacks)", r0.dots.mode === "static" && r1.raf - r0.raf === 0 && r1.dots.draws === r0.dots.draws && r1.dots.draws >= 1, JSON.stringify({ mode: r0.dots.mode, draws: r1.dots.draws, raf: r1.raf - r0.raf }));
	await rp.click('[data-testid="model-picker"]');
	await rp.waitForSelector('[data-testid="model-menu"]');
	const rm = await rp.evaluate(() => { const m = document.querySelector('[data-testid="model-menu"]'); return { op: Number(getComputedStyle(m).opacity), running: m.getAnimations().filter((a) => a.playState === "running").length }; });
	check("reduced motion: the model menu appears instantly and fully opaque", rm.op === 1 && rm.running === 0, JSON.stringify(rm));
	await rctx.close();

	// ================================================================= phone 390 × 844
	const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "zh-CN", hasTouch: true, isMobile: true, storageState: stateFile });
	const mp = await pctx.newPage();
	await mp.goto(`${base}/`);
	await mp.waitForSelector('[data-testid="home-greeting"]');
	await sleep(600);
	let ho = await hOverflow(mp);
	check("390: home has no horizontal scroll", ho.doc <= ho.win && ho.body <= ho.win, JSON.stringify(ho));
	const sizes = await mp.evaluate(() => ["attach-menu", "model-picker", "send"].map((id) => { const r = document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect(); return { id, w: Math.round(r.width), h: Math.round(r.height) }; }));
	check("390: + / model / send are touch-sized (≥ 36 px high, + and send ≥ 40)", sizes.every((s) => s.h >= 36) && sizes.filter((s) => s.id !== "model-picker").every((s) => s.w >= 40 && s.h >= 40), JSON.stringify(sizes));
	// bottom sheet: + (focus restore) and model
	await mp.locator('[data-testid="attach-menu"]').focus();
	await mp.click('[data-testid="attach-menu"]');
	await mp.waitForSelector('[data-testid="bottom-sheet"]');
	await sleep(400);
	const sheet = await mp.locator('[data-testid="bottom-sheet"]').evaluate((e) => { const cs = getComputedStyle(e); return { op: Number(cs.opacity), bg: cs.backgroundColor, running: e.getAnimations().filter((a) => a.playState === "running").length }; });
	check("390: the + sheet is opaque after its animation", sheet.op === 1 && !/rgba\(.*, 0(\.\d+)?\)/.test(sheet.bg) && sheet.running === 0, JSON.stringify(sheet));
	await mp.keyboard.press("Escape");
	await mp.waitForSelector('[data-testid="bottom-sheet"]', { state: "detached" });
	await sleep(100);
	check("390: Esc closes the sheet and focus is restored to the + button that opened it", (await active(mp)) === "attach-menu", await active(mp));
	await mp.click('[data-testid="model-picker"]');
	await mp.waitForSelector('[data-testid="bottom-sheet"]');
	await sleep(400);
	ho = await hOverflow(mp);
	const sg = await mp.locator('[data-testid="bottom-sheet"]').evaluate((e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top }; });
	check("390: model sheet fits the screen (no horizontal scroll), its rows are readable", ho.doc <= ho.win && sg.left >= 0 && sg.right <= 390 && (await mp.locator('[data-testid="model-option"]').count()) >= 3, JSON.stringify({ ho, sg }));
	await shot(mp, "390-model-sheet");
	await mp.keyboard.press("Escape");
	// attachments wrap at 390
	await mp.setInputFiles('[data-testid="file-input"]', [
		{ name: "季度汇总.pdf", mimeType: "application/pdf", buffer: PDF },
		{ name: "封面.png", mimeType: "image/png", buffer: PNG },
		{ name: "客户名单-2024-第三季度-终稿-请勿外传.xlsx", mimeType: "application/octet-stream", buffer: Buffer.from("PK fake") },
		{ name: "会议纪要.docx", mimeType: "application/octet-stream", buffer: Buffer.from("PK fake") },
	]);
	await allReady(mp, 4);
	await mp.route("**/api/files", (r) => r.abort("failed"));
	await mp.setInputFiles('[data-testid="file-input"]', { name: "会失败的文件.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
	await mp.waitForSelector('[data-testid="chip-file"][data-state="failed"]');
	await mp.fill('[data-testid="composer-input"]', "把这些资料整理成要点");
	await sleep(300);
	ho = await hOverflow(mp);
	const wrap = await mp.evaluate(() => {
		const row = document.querySelector('[data-testid="attachments"]');
		const c = document.querySelector('[data-testid="composer"]').getBoundingClientRect();
		const ts = [...row.querySelectorAll('[data-testid="chip-file"]')].map((t) => t.getBoundingClientRect());
		return { rowOverflowX: row.scrollWidth > row.clientWidth + 1, composerRight: c.right, tilesInside: ts.every((r) => r.right <= c.right + 0.5 && r.left >= c.left - 0.5), n: ts.length };
	});
	check("390: attachments wrap inside the composer (no horizontal scroll anywhere), incl. a failed card", ho.doc <= ho.win && !wrap.rowOverflowX && wrap.tilesInside && wrap.composerRight <= 390 && wrap.n === 5, JSON.stringify({ ho, wrap }));
	const fl = await mp.locator('[data-testid="chip-file"][data-state="failed"]').evaluate((e) => ({ retry: !!e.querySelector('[data-testid="tile-retry"]'), remove: !!e.querySelector('[data-testid="tile-remove"]'), text: e.innerText.replace(/\n/g, " ") }));
	check("390: the failed card still shows reason + 重试 + 移除", fl.retry && fl.remove && /上传失败：/.test(fl.text), fl.text);
	await shot(mp, "390-attachments");
	await mp.unroute("**/api/files");
	// drawer focus restore (left sheet)
	await mp.reload();
	await mp.waitForSelector('[data-testid="open-sidebar"]');
	await mp.locator('[data-testid="open-sidebar"]').focus();
	await mp.click('[data-testid="open-sidebar"]');
	await mp.waitForSelector('[data-testid="sheet-left"]');
	await sleep(300);
	await mp.keyboard.press("Escape");
	await mp.waitForSelector('[data-testid="sheet-left"]', { state: "detached" });
	await sleep(100);
	check("390: the navigation drawer (Sheet) gives focus back to the button that opened it", (await active(mp)) === "open-sidebar", await active(mp));
	await mp.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
	await sleep(300);
	await shot(mp, "390-dark-home");
	await pctx.close();
} finally {
	await browser.close();
	await server.stop();
}
const ok = summary();
process.exit(ok ? 0 : 1);
