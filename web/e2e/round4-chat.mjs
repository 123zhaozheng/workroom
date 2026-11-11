// Round 4 · chat UI: dot-matrix background (performance / reduced motion / hidden tab / offscreen / pointer), the shared
// composer (+ menu, drag & drop, paste, multi-file upload with progress / failure / retry / remove, Enter / Shift+Enter / IME,
// model switcher incl. persistence), attachment cards in the message bubble, deliverable cards, no external requests,
// screenshots at 1366 / 1440 / 390.
// Run: npm run -w web build && node web/e2e/round4-chat.mjs        (port 8863)
import { deflateSync, crc32 } from "node:zlib";
import { check, chromium, register, sendMessage, shot, sleep, startServer, summary, SHOTS } from "./lib.mjs";
import { join } from "node:path";

const PORT = 8863;
const server = await startServer({ port: PORT, env: { WORKROOM_RT_RETRY_MAX: "0" } });
const base = server.base;
const browser = await chromium.launch();

// ---- tiny real PNG (so the thumbnail genuinely decodes)
function png(w, h, [r, g, b]) {
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(td) >>> 0);
		return Buffer.concat([len, td, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
	const raw = Buffer.concat(Array.from({ length: h }, () => row));
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PNG = png(96, 64, [96, 130, 200]);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

// instrument every page: count rAF callbacks, and make document visibility switchable
const INIT = () => {
	window.__raf = 0;
	const orig = window.requestAnimationFrame.bind(window);
	window.requestAnimationFrame = (cb) => orig((t) => {
		window.__raf++;
		cb(t);
	});
	window.__fakeHidden = false;
	Object.defineProperty(document, "hidden", { configurable: true, get: () => window.__fakeHidden });
	Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (window.__fakeHidden ? "hidden" : "visible") });
	window.__setHidden = (v) => {
		window.__fakeHidden = v;
		document.dispatchEvent(new Event("visibilitychange"));
	};
};

const dots = (page) => page.evaluate(() => (window.__wrDots ? { ...window.__wrDots } : null));
const raf = (page) => page.evaluate(() => window.__raf);
async function dropFiles(page, selector, files, { type = "drop" } = {}) {
	const dt = await page.evaluateHandle((fs) => {
		const d = new DataTransfer();
		for (const f of fs) d.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
		return d;
	}, files.map((f) => ({ name: f.name, type: f.type, b64: f.buffer.toString("base64") })));
	await page.dispatchEvent(selector, "dragenter", { dataTransfer: dt });
	await page.dispatchEvent(selector, "dragover", { dataTransfer: dt });
	if (type === "drop") await page.dispatchEvent(selector, "drop", { dataTransfer: dt });
	return dt;
}
const tiles = (page) => page.locator('[data-testid="chip-file"]');
const allReady = (page, n) => page.waitForFunction((n) => { const t = [...document.querySelectorAll('[data-testid="chip-file"]')]; return t.length === n && t.every((x) => x.getAttribute("data-state") === "ready"); }, n, { timeout: 20000 });

const externals = [];
try {
	// ================================================================= desktop 1440 × 900
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
	await ctx.addInitScript(INIT);
	ctx.on("request", (r) => {
		const u = r.url();
		if (!u.startsWith(base) && !u.startsWith("data:") && !u.startsWith("blob:")) externals.push(u);
	});
	const page = await ctx.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await register(page, base, { email: `r4-${Date.now()}@example.com`, name: "林夏" });
	await page.waitForLoadState("networkidle");

	// ---- real models for the switcher: a ready one with capabilities + thinking levels, one blocked (no route)
	const prov = await (await page.request.post(`${base}/api/admin/model-providers`, { data: { name: "E2E 兼容", type: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", keyless: true, models: [{ id: "e2e-pro", name: "E2E Pro", description: "多模态与推理", contextWindow: 200000, maxTokens: 8192, input: ["text", "image"], reasoning: true }] } })).json();
	const prov2 = await (await page.request.post(`${base}/api/admin/model-providers`, { data: { name: "E2E 缺密钥", type: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "e2e-nokey", name: "E2E 缺密钥模型" }] } })).json();
	const pro = { model: { id: `${prov.provider?.id}/e2e-pro` } };
	check("setup: a second ready model (provider with capabilities) and a blocked one (no key) created through the models API", !!prov.provider?.id && !!prov2.provider?.id, JSON.stringify({ pro: prov.provider?.id, nokey: prov2.provider?.health }));
	await page.request.post(`${base}/api/skills`, { data: { name: "周报模板", kind: "prompt", description: "周报的固定开头", instructions: "请按“结论—进展—风险—计划”的顺序写周报。" } });
	const modelList = await (await page.request.get(`${base}/api/models`)).json();
	const fixtureId = modelList.models.find((m) => m.fixture || m.status === "fixture")?.id;
	await page.goto(`${base}/`);
	await page.waitForSelector('[data-testid="home-greeting"]');
	await sleep(1500);

	// ================================================================= 1. dot matrix: home
	const d0 = await dots(page);
	check("dots: canvas rendered on home, animated, devicePixelRatio honoured (2x)", !!d0 && d0.mode === "animated" && d0.dpr === 2 && d0.regions === 2, JSON.stringify(d0));
	const cw = await page.evaluate(() => [...document.querySelectorAll('[data-testid="dot-matrix"] canvas')].map((c) => { const r = c.getBoundingClientRect(); return { bw: c.width, bh: c.height, w: r.width, h: r.height, x: r.x }; }));
	check("dots: backing store = css size × dpr (crisp) on both side canvases", cw.length === 2 && cw.every((c) => Math.abs(c.bw - Math.round(c.w * 2)) <= 1 && Math.abs(c.bh - Math.round(c.h * 2)) <= 1), JSON.stringify(cw));

	// frame rate / cost over a 3 s window
	const cdp = await ctx.newCDPSession(page);
	await cdp.send("Performance.enable");
	const metric = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
	const m0 = await metric();
	const s0 = await dots(page);
	await sleep(3000);
	const m1 = await metric();
	const s1 = await dots(page);
	const fps = (s1.draws - s0.draws) / 3;
	const mainThreadPct = ((m1.TaskDuration - m0.TaskDuration) / 3) * 100;
	check("dots perf: throttled to ~30 fps", fps >= 24 && fps <= 34, `${fps.toFixed(1)} draws/s (rAF callbacks ${((s1.rafCalls - s0.rafCalls) / 3).toFixed(0)}/s)`);
	check("dots perf: a frame is cheap (avg < 4 ms, 1950 dots @2x, software canvas)", s1.avgDrawMs < 4, `avg ${s1.avgDrawMs.toFixed(2)} ms, max ${s1.maxDrawMs.toFixed(1)} ms, ${s1.dots} dots`);
	// baseline of the same page with the loop paused (hidden tab): load from other processes inflates both numbers equally
	await page.evaluate(() => window.__setHidden(true));
	await sleep(300);
	const b0 = await metric();
	await sleep(2000);
	const b1 = await metric();
	await page.evaluate(() => window.__setHidden(false));
	const basePct = ((b1.TaskDuration - b0.TaskDuration) / 2) * 100;
	const extra = mainThreadPct - basePct;
	// Budget history: set at 15 in round 4 (measured +13.1 then). On 2026-11-10 the unchanged round-4 commit measured +14.8/+15.0 on the
	// same container (headless software raster drift), so the budget is 20; the per-frame draw cost and the 30 fps cap above are the tight checks.
	check("dots perf: animating adds < 20 points of main-thread time over the paused page (headless, software canvas, 2 side canvases @2x)", extra < 20, `animating ${mainThreadPct.toFixed(1)}% vs paused ${basePct.toFixed(1)}% → +${extra.toFixed(1)}`);
	console.log(`PERF home 1440x900@2x: ${fps.toFixed(1)} fps, avg draw ${s1.avgDrawMs.toFixed(2)} ms, max ${s1.maxDrawMs.toFixed(1)} ms, main-thread ${mainThreadPct.toFixed(1)}% (paused baseline ${basePct.toFixed(1)}%), ${s1.pixels} canvas px`);

	// nothing is drawn behind the message column: the two canvases sit left and right of it
	const alphaAt = (X, Y, w, h) => page.evaluate(({ X, Y, w, h }) => {
		for (const c of document.querySelectorAll('[data-testid="dot-matrix"] canvas')) {
			const r = c.getBoundingClientRect();
			if (X >= r.left && X + w <= r.right + 1) {
				const k = c.width / r.width;
				const d = c.getContext("2d").getImageData(Math.round((X - r.left) * k), Math.round((Y - r.top) * k), Math.round(w * k), Math.round(h * k)).data;
				let s = 0;
				for (let i = 3; i < d.length; i += 4) s += d[i];
				return s / (d.length / 4);
			}
		}
		return -1;
	}, { X, Y, w, h });
	const overlap = await page.evaluate(() => {
		const col = document.querySelector('[data-testid="composer"]').getBoundingClientRect();
		return [...document.querySelectorAll('[data-testid="dot-matrix"] canvas')].filter((c) => c.style.display !== "none").some((c) => { const r = c.getBoundingClientRect(); return r.right > col.left && r.left < col.right; });
	});
	check("dots readability: the dot canvases never overlap the message column (nothing behind the text)", !overlap);
	const inner = await alphaAt(264 + 1176 - 248, 300, 60, 200);
	const outer = await alphaAt(1440 - 130, 300, 100, 200);
	check("dots readability: dots fade in gradually away from the column (inner edge < 40% of outer density)", inner >= 0 && outer > 0 && inner < outer * 0.4, `inner=${inner.toFixed(2)} outer=${outer.toFixed(2)}`);
	await shot(page, "round4-1440-home");

	// pointer reaction: dots near the pointer brighten, then relax again
	const PX = 1330;
	const rest = await alphaAt(PX - 70, 200, 140, 140);
	await page.mouse.move(PX, 270, { steps: 6 });
	await sleep(500);
	const near = await alphaAt(PX - 70, 200, 140, 140);
	await page.mouse.move(700, 800, { steps: 4 });
	await sleep(2600);
	const after = await alphaAt(PX - 70, 200, 140, 140);
	check("dots: soft reaction to the pointer (brighter near it) and relaxes afterwards", near > rest * 1.25 && after < near * 0.85, `rest=${rest.toFixed(2)} near=${near.toFixed(2)} after=${after.toFixed(2)}`);

	// hidden tab: zero rAF callbacks
	await page.evaluate(() => window.__setHidden(true));
	await sleep(400);
	const r0 = await raf(page);
	const dh0 = await dots(page);
	await sleep(1500);
	const r1 = await raf(page);
	const dh1 = await dots(page);
	check("dots: hidden tab → zero rAF callbacks and zero frames drawn", r1 - r0 === 0 && dh1.draws === dh0.draws && dh1.mode === "paused", `rAF Δ=${r1 - r0}, draws Δ=${dh1.draws - dh0.draws}, mode=${dh1.mode}`);
	await page.evaluate(() => window.__setHidden(false));
	await sleep(600);
	const dh2 = await dots(page);
	check("dots: visible again → animation resumes", dh2.mode === "animated" && dh2.draws > dh1.draws, `draws ${dh1.draws} → ${dh2.draws}`);

	// offscreen canvas (IntersectionObserver)
	await page.evaluate(() => { document.querySelector('[data-testid="dot-matrix"]').style.display = "none"; });
	await sleep(500);
	const o0 = await raf(page);
	const do0 = await dots(page);
	await sleep(1200);
	const o1 = await raf(page);
	const do1 = await dots(page);
	check("dots: canvas offscreen (IntersectionObserver) → zero rAF callbacks", o1 - o0 === 0 && do1.draws === do0.draws, `rAF Δ=${o1 - o0}, draws Δ=${do1.draws - do0.draws}, mode=${do1.mode}`);
	await page.evaluate(() => { document.querySelector('[data-testid="dot-matrix"]').style.display = ""; });
	await sleep(500);
	check("dots: back in view → animation resumes", (await dots(page)).mode === "animated");

	// theme aware: dark theme paints light dots, light theme paints dark dots
	const meanRgb = () => page.evaluate(() => {
		const c = document.querySelector('[data-testid="dot-matrix"] canvas');
		const d = c.getContext("2d").getImageData(0, 0, c.width, Math.min(c.height, 300)).data;
		let r = 0, n = 0;
		for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 8) { r += d[i]; n++; }
		return n ? r / n : -1;
	});
	const lightR = await meanRgb();
	await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
	await sleep(400);
	const darkR = await meanRgb();
	await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
	check("dots: theme aware (dark dots on light, light dots on dark)", lightR >= 0 && lightR < 90 && darkR > 170, `light R=${lightR.toFixed(0)} dark R=${darkR.toFixed(0)}`);

	// ================================================================= 2. composer on home
	check("composer: one shared composer on home (auto-growing textarea, model switcher at the right, + at the left)", (await page.locator('[data-testid="composer"]').count()) === 1 && (await page.locator('[data-testid="attach-menu"]').count()) === 1 && (await page.locator('[data-testid="model-picker"]').count()) === 1);
	const ta = page.locator('[data-testid="composer-input"]');
	const h1 = (await ta.boundingBox()).height;
	await ta.fill(Array.from({ length: 9 }, (_, i) => `第 ${i + 1} 行`).join("\n"));
	const h2 = (await ta.boundingBox()).height;
	check("composer: textarea auto-grows with its content", h2 > h1 + 60, `${h1} → ${h2}`);
	await ta.fill("");

	// + menu
	await page.click('[data-testid="attach-menu"]');
	await page.waitForSelector('[data-testid="attach-upload"]');
	const menuText = await page.locator('[role="menu"]').innerText();
	check("composer: + menu offers 上传文件 / 从文件库选择 / 引用知识库 / 使用技能 (a skill is installed)", ["上传文件", "从文件库选择", "引用知识库", "使用技能"].every((t) => menuText.includes(t)), menuText.replace(/\n/g, " | "));
	await shot(page, "round4-1440-plus-menu");
	await page.click('[data-testid="attach-skill"]');
	await page.waitForSelector('[data-testid="skill-option"]');
	await page.click('[data-testid="skill-option"]');
	check("composer: 使用技能 writes the skill into the message", (await ta.inputValue()).startsWith("使用技能「周报模板」"), await ta.inputValue());
	await ta.fill("");

	// ---- drag & drop onto the composer's page: overlay, three files, per-kind cards
	await dropFiles(page, '[data-testid="composer"]', [{ name: "季度汇总.pdf", type: "application/pdf", buffer: PDF }], { type: "enter" });
	await page.waitForSelector('[data-testid="drop-overlay"]', { timeout: 3000 });
	await shot(page, "round4-1440-drop-overlay");
	check("drop: dragging a file anywhere shows a clear drop overlay", (await page.locator('[data-testid="drop-overlay"]').innerText()).includes("松开"));
	await page.dispatchEvent('[data-testid="composer"]', "dragleave", { dataTransfer: await page.evaluateHandle(() => { const d = new DataTransfer(); d.items.add(new File(["x"], "x.txt")); return d; }) });
	await page.waitForFunction(() => !document.querySelector('[data-testid="drop-overlay"]'));
	check("drop: overlay disappears when the drag leaves", true);

	await dropFiles(page, '[data-testid="composer"]', [
		{ name: "季度汇总.pdf", type: "application/pdf", buffer: PDF },
		{ name: "封面.png", type: "image/png", buffer: PNG },
		{ name: "客户名单-2024-第三季度-终稿-请勿外传.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("PK\x03\x04 fake xlsx bytes for the upload check") },
	]);
	await allReady(page, 3);
	const kinds = await tiles(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
	check("drop: three dropped files upload (multi-file) and become ready cards with a colour kind each (pdf / image / xls)", kinds.join(",") === "pdf,image,xls", kinds.join(","));
	const thumb = await page.locator('[data-testid="chip-file"] img[data-testid="file-thumb"]').first().evaluate((i) => ({ src: i.src.slice(0, 5), ok: i.naturalWidth > 0 }));
	check("cards: image attachments show a real thumbnail", thumb.src === "blob:" && thumb.ok, JSON.stringify(thumb));
	const long = tiles(page).nth(2);
	const longGeo = await long.evaluate((e) => ({ w: e.getBoundingClientRect().width, shown: e.querySelector("[data-name]").innerText.replace(/\s+/g, ""), tail: e.querySelector("[data-name]").lastElementChild.textContent, overflow: e.querySelector("[data-name]").scrollWidth > e.querySelector("[data-name]").clientWidth + 1 }));
	check("cards: long names truncate in the middle and keep the extension visible, card width fixed", longGeo.w <= 233 && longGeo.tail.endsWith(".xlsx") && longGeo.shown.length > 6, JSON.stringify(longGeo));
	const meta = await tiles(page).first().innerText();
	check("cards: type label and size are shown", /PDF/.test(meta) && /B/.test(meta), meta.replace(/\n/g, " "));
	await shot(page, "round4-1440-composer-files");

	// remove one
	await tiles(page).nth(0).locator('[data-testid="tile-remove"]').click();
	check("cards: remove button removes the attachment", (await tiles(page).count()) === 2);

	// ---- paste an image from the clipboard
	await page.evaluate((b64) => {
		const dt = new DataTransfer();
		dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "image.png", { type: "image/png" }));
		document.querySelector('[data-testid="composer-input"]').dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
	}, PNG.toString("base64"));
	await allReady(page, 3);
	const pasted = await tiles(page).last().innerText();
	check("paste: an image on the clipboard becomes an attachment card (named, ready)", /粘贴的图片/.test(pasted) && (await tiles(page).last().getAttribute("data-kind")) === "image", pasted.replace(/\n/g, " "));
	// text on the clipboard wins over an image (spreadsheet copy)
	const before = await tiles(page).count();
	await page.evaluate((b64) => {
		const dt = new DataTransfer();
		dt.setData("text/plain", "A1\tB1");
		dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "image.png", { type: "image/png" }));
		document.querySelector('[data-testid="composer-input"]').dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
	}, PNG.toString("base64"));
	await sleep(300);
	check("paste: clipboard text + image → text paste, no stray image attachment", (await tiles(page).count()) === before);

	// ---- failure + retry
	await page.route("**/api/files", (r) => r.abort("failed"));
	await page.setInputFiles('[data-testid="file-input"]', { name: "会失败的文件.txt", mimeType: "text/plain", buffer: Buffer.from("will fail first") });
	await page.waitForSelector('[data-testid="chip-file"][data-state="failed"]');
	const failedTxt = await page.locator('[data-testid="chip-file"][data-state="failed"]').innerText();
	check("upload failure: card shows 上传失败 with the reason and a retry button; sending is blocked", /上传失败/.test(failedTxt) && (await page.locator('[data-testid="tile-retry"]').count()) === 1 && (await page.locator('[data-testid="send"]').isDisabled()), failedTxt.replace(/\n/g, " "));
	await shot(page, "round4-1440-upload-failed");
	await page.unroute("**/api/files");
	await page.click('[data-testid="tile-retry"]');
	await allReady(page, 4);
	check("upload failure: retry succeeds and the card becomes ready", (await page.locator('[data-testid="send"]').isDisabled()) === false);
	// drop it: keep three for sending
	await page.locator('[data-testid="chip-file"]', { hasText: "会失败的文件" }).locator('[data-testid="tile-remove"]').click();

	// ---- per-file progress (upload throttled so intermediate percentages are observable)
	const cdpNet = await ctx.newCDPSession(page);
	await cdpNet.send("Network.enable");
	await cdpNet.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 700 * 1024 });
	await page.evaluate(() => {
		window.__prog = [];
		window.__progTimer = setInterval(() => {
			const t = document.querySelector('[data-testid="chip-file"][data-state="uploading"]');
			if (t) window.__prog.push(Number(t.getAttribute("data-progress")));
		}, 120);
	});
	await page.setInputFiles('[data-testid="file-input"]', { name: "大文件-录音.zip", mimeType: "application/zip", buffer: Buffer.alloc(2_200_000, 7) });
	await page.waitForSelector('[data-testid="chip-file"][data-state="uploading"]');
	const upTxt = await page.locator('[data-testid="chip-file"][data-state="uploading"]').innerText();
	await allReady(page, 4);
	const prog = await page.evaluate(() => { clearInterval(window.__progTimer); return window.__prog; });
	await cdpNet.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
	const distinct = [...new Set(prog)];
	check("progress: card shows 上传中 N% with a growing percentage, then ready", /上传中 \d+%/.test(upTxt) && distinct.length >= 3 && prog.every((v, i) => i === 0 || v >= prog[i - 1]), `${distinct.join(",")} | ${upTxt.replace(/\n/g, " ")}`);
	check("cards: a zip is an 压缩包 card", (await tiles(page).last().getAttribute("data-kind")) === "archive");
	await tiles(page).last().locator('[data-testid="tile-remove"]').click();

	// ---- Enter / Shift+Enter / IME (home)
	await ta.fill("");
	await ta.focus();
	await page.keyboard.type("第一行");
	await page.keyboard.press("Shift+Enter");
	await page.keyboard.type("第二行");
	check("keys: Shift+Enter inserts a newline and does not send", (await ta.inputValue()) === "第一行\n第二行" && page.url().endsWith("/"));
	await ta.fill("");
	await ta.focus();
	await cdp.send("Input.imeSetComposition", { text: "ni hao", selectionStart: 6, selectionEnd: 6 });
	await sleep(100);
	await page.keyboard.press("Enter"); // the key that confirms a candidate in the IME
	await sleep(300);
	check("keys: Enter while an IME composition is active does not send", page.url().endsWith("/") && (await page.locator('[data-testid="user-message"]').count()) === 0);
	await cdp.send("Input.insertText", { text: "你好" });
	await sleep(100);
	check("keys: committed Chinese text is kept in the box", (await ta.inputValue()).includes("你好"), await ta.inputValue());
	await ta.fill("");

	// ================================================================= 3. model switcher
	await ta.fill("");
	await page.click('[data-testid="model-picker"]');
	await page.waitForSelector('[data-testid="model-option"]');
	const opts = await page.locator('[data-testid="model-option"]').evaluateAll((els) => els.map((e) => ({ t: e.innerText.replace(/\n/g, " "), status: e.dataset.status, disabled: e.hasAttribute("data-disabled"), caps: [...e.querySelectorAll("[data-cap]")].map((c) => c.dataset.cap) })));
	const groupsN = await page.locator('[data-testid="model-group"]').count();
	check("models: grouped by provider (≥ 2 groups)", groupsN >= 2, `${groupsN} groups`);
	const proOpt = opts.find((o) => o.t.includes("E2E Pro"));
	check("models: capability badges for images / tools / reasoning", !!proOpt && ["image", "tools", "reasoning"].every((c) => proOpt.caps.includes(c)), JSON.stringify(proOpt));
	const blockedOpt = opts.find((o) => o.t.includes("E2E 缺密钥模型"));
	check("models: blocked model is disabled and shows the reason", !!blockedOpt && blockedOpt.disabled && /不可用：/.test(blockedOpt.t), blockedOpt?.t);
	const fixtureOpts = opts.filter((o) => o.status === "fixture");
	check("models: the test model is labelled 测试模型（非真实 AI） exactly once", fixtureOpts.length === 1 && (fixtureOpts[0].t.match(/测试模型/g) ?? []).length === 1, fixtureOpts[0]?.t);
	await shot(page, "round4-1440-model-menu");
	await page.locator('[data-testid="model-option"]', { hasText: "E2E Pro" }).click();
	await page.waitForFunction(() => document.querySelector('[data-testid="model-picker"]')?.textContent?.includes("E2E Pro"));
	await page.click('[data-testid="model-picker"]');
	await page.waitForSelector('[data-testid="thinking-levels"]');
	const levels = await page.locator('[data-testid="thinking-levels"] [data-level]').evaluateAll((e) => e.map((x) => x.dataset.level));
	check("models: thinking levels offered for a reasoning model", levels[0] === "off" && levels.includes("low") && levels.includes("high"), levels.join(","));
	await page.locator('[data-testid="thinking-levels"] [data-level="high"]').click();
	await page.keyboard.press("Escape");
	const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("wr.model.default.v1") ?? "{}"));
	check("models: the choice is saved as the user default (model + thinking level)", stored.id === pro.model?.id && stored.thinking === "high", JSON.stringify(stored));
	await page.reload();
	await page.waitForSelector('[data-testid="model-picker"]');
	await page.waitForFunction((id) => document.querySelector('[data-testid="model-picker"]')?.getAttribute("data-model-id") === id, pro.model?.id);
	check("models: after reload the home composer still shows the chosen model and level", (await page.locator('[data-testid="model-picker"]').innerText()).includes("E2E Pro") && (await page.locator('[data-testid="model-picker"]').innerText()).includes("高"));

	// the model is sent when the conversation is created → persisted per conversation by the server
	await sendMessage(page, "用这个模型开一个对话");
	await page.waitForURL(/\/c\//);
	const convUrl = page.url();
	const [, , spaceId, convId] = new URL(convUrl).pathname.split("/");
	const detail = await (await page.request.get(`${base}/api/conversations/${spaceId}/${convId}`)).json();
	check("models: new conversation is created with the chosen model (server-side per conversation)", detail.agent?.model?.provider === prov.provider?.id && detail.agent?.model?.modelId === "e2e-pro" && detail.agent?.modelLabel === "E2E Pro", JSON.stringify(detail.agent?.model));
	await page.waitForSelector('[data-testid="chat-title"]');
	await page.reload();
	await page.waitForSelector('[data-testid="model-picker"]');
	await sleep(500);
	check("models: chat page switcher shows the conversation's model, also after reload", (await page.locator('[data-testid="model-picker"]').innerText()).includes("E2E Pro"), await page.locator('[data-testid="model-picker"]').innerText());

	// switching inside an existing conversation: the UI must stay truthful about what the server did
	await page.click('[data-testid="model-picker"]');
	await page.locator('[data-testid="model-option"][data-status="fixture"]').click();
	await sleep(1200);
	const detail2 = await (await page.request.get(`${base}/api/conversations/${spaceId}/${convId}`)).json();
	const serverFixture = !!detail2.agent?.fixture;
	const shownFixture = /测试模型/.test(await page.locator('[data-testid="model-picker"]').innerText());
	const noteShown = (await page.locator('[data-testid="model-note"]').count()) > 0;
	check("models: switching in a conversation — picker matches what the server really uses; if the server cannot switch, a note says so", shownFixture === serverFixture && (serverFixture || noteShown), `server=${detail2.agent?.modelLabel} shownFixture=${shownFixture} note=${noteShown}`);
	const stored2 = await page.evaluate(() => JSON.parse(localStorage.getItem("wr.model.default.v1") ?? "{}"));
	check("models: the switch also becomes the user default for new conversations", stored2.id !== pro.model?.id, JSON.stringify(stored2));
	console.log(`INFO in-conversation model switch is ${serverFixture ? "applied by the server" : "NOT supported by the server (note shown, default updated)"}`);

	// ================================================================= 4. chat: send with attachments, bubble cards, preview
	await page.goto(`${base}/`);
	await page.waitForSelector('[data-testid="home-greeting"]');
	await page.evaluate((id) => localStorage.setItem("wr.model.default.v1", JSON.stringify({ id })), fixtureId);
	await page.reload();
	await page.waitForSelector('[data-testid="composer"]');
	await page.setInputFiles('[data-testid="file-input"]', [
		{ name: "会议纪要.txt", mimeType: "text/plain", buffer: Buffer.from("周一例会：确认上线时间为 12 月 1 日。") },
		{ name: "现场照片.png", mimeType: "image/png", buffer: PNG },
	]);
	await allReady(page, 2);
	await sendMessage(page, "请看附件 [[reply 已收到两个附件。]]");
	await page.waitForURL(/\/c\//);
	await page.waitForSelector('[data-testid="assistant-message"]', { timeout: 20000 });
	const bubble = page.locator('[data-testid="user-message"]').first();
	const cards = bubble.locator('[data-testid="message-attachment"]');
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="message-attachment"] [data-testid="tile-state"]').length === 2 && [...document.querySelectorAll('[data-testid="message-attachment"] [data-testid="tile-state"]')].every((e) => /B/.test(e.textContent)));
	const bubbleText = await bubble.innerText();
	check("bubble: the sent message shows the same cards (name, type, size) for every attachment", (await cards.count()) === 2 && bubbleText.includes("会议纪要.txt") && bubbleText.includes("现场照片.png") && /文本 · \d/.test(bubbleText), bubbleText.replace(/\n/g, " | ").slice(0, 120));
	const bThumb = await bubble.locator('img[data-testid="file-thumb"]').evaluate((i) => ({ src: i.getAttribute("src"), ok: i.naturalWidth > 0 }));
	check("bubble: image attachment renders its thumbnail from the server", /^\/api\/files\/.+\/download$/.test(bThumb.src) && bThumb.ok, JSON.stringify(bThumb));
	check("chat: composer is cleared after sending and the empty state is gone", (await page.locator('[data-testid="chip-file"]').count()) === 0 && (await page.locator('[data-testid="composer-input"]').inputValue()) === "");
	await cards.first().locator("button").first().click();
	await page.waitForSelector('[data-testid="side-panel"]');
	await page.waitForFunction(() => document.querySelector('[data-testid="side-panel"]')?.textContent?.includes("会议纪要"), null, { timeout: 15000 });
	check("bubble: clicking a card opens the right-side preview", true);
	await sleep(500);
	await shot(page, "round4-1440-chat-preview");
	await page.click('[data-testid="side-panel"] button[aria-label*="关闭"]').catch(() => {});

	// ---- whole chat page accepts drops (not only the composer)
	await dropFiles(page, '[data-testid="chat-title"]', [{ name: "补充材料.txt", type: "text/plain", buffer: Buffer.from("补充") }]);
	await allReady(page, 1);
	check("drop: files dropped anywhere on the chat page (title bar) are attached", (await tiles(page).first().innerText()).includes("补充材料.txt"));
	await tiles(page).first().locator('[data-testid="tile-remove"]').click();

	// ---- Enter / Shift+Enter in the chat composer, then a deliverable card
	const cta = page.locator('[data-testid="composer-input"]');
	await cta.fill("");
	await cta.focus();
	await page.keyboard.type("甲");
	await page.keyboard.press("Shift+Enter");
	await page.keyboard.type("乙");
	check("chat keys: Shift+Enter newline, nothing sent", (await cta.inputValue()) === "甲\n乙" && (await page.locator('[data-testid="user-message"]').count()) === 1);
	await cta.fill("");
	await sendMessage(page, '写份周报 [[call file_create {"name":"项目周报","format":"md","title":"项目周报","content":"# 本周进展\\n- 完成需求评审"}]]');
	await page.waitForSelector('[data-testid="file-card"]', { timeout: 20000 });
	const fc = page.locator('[data-testid="file-card"]').first();
	const fcText = await fc.innerText();
	check("deliverable card: type icon, name, version badge, size and a download link in the same visual language", /项目周报/.test(fcText) && (await fc.locator('[data-testid="file-version"]').innerText()) === "v1" && (await fc.locator('a[download], a[href*="/download"]').count()) === 1 && (await fc.locator("[data-kind], span[data-kind]").count()) >= 1, fcText.replace(/\n/g, " | "));
	await page.waitForSelector('[data-testid="assistant-message"] .wr-prose', { timeout: 20000 });
	await sleep(800);
	await shot(page, "round4-1440-chat");

	// ---- the dot matrix sits behind the conversation as well
	const dc = await dots(page);
	check("dots: also behind the chat page, same guards", !!dc && (dc.mode === "animated" || dc.mode === "paused") && (await page.locator('[data-testid="dot-matrix"]').count()) === 1, JSON.stringify(dc));
	// text stays on top of the dots: the canvas is behind (z-index < 0) and ignores the pointer
	const layer = await page.evaluate(() => { const e = document.querySelector('[data-testid="dot-matrix"]'); const s = getComputedStyle(e); return { z: s.zIndex, pe: s.pointerEvents }; });
	check("dots: canvas is behind content and ignores pointer events", Number(layer.z) < 0 && layer.pe === "none", JSON.stringify(layer));

	// ================================================================= 5. settings toggle + reduced motion
	await page.goto(`${base}/settings?tab=models`);
	await page.waitForSelector('[data-testid="settings-tab-models"]');
	await sleep(600);
	const offSection = await page.locator('[data-testid="personal-keys-section"]').count();
	await page.request.put(`${base}/api/admin/model-settings`, { data: { personalProviders: true } });
	await page.reload();
	await page.waitForSelector('[data-testid="personal-keys-section"]', { timeout: 10000 }).catch(() => {});
	check("settings: 我的模型密钥 section appears only when the admin policy enables personal keys", offSection === 0 && (await page.locator('[data-testid="personal-keys-section"]').count()) === 1 && (await page.locator('[data-testid="personal-keys"]').count()) === 1, `off=${offSection}`);
	await page.request.put(`${base}/api/admin/model-settings`, { data: { personalProviders: false } });
	await page.goto(`${base}/`);
	await page.waitForSelector('[data-testid="dot-matrix"]');
	await page.goto(`${base}/settings`);
	await page.click('[data-testid="reduce-motion-toggle"]');
	await page.click('a[href="/"]').catch(async () => page.goto(`${base}/`));
	await page.waitForSelector('[data-testid="home-greeting"]');
	await sleep(800);
	const sr0 = await raf(page);
	const ds0 = await dots(page);
	await sleep(1500);
	const sr1 = await raf(page);
	const ds1 = await dots(page);
	check("reduced motion (in-app toggle): dots are drawn static — no rAF loop at all", ds0?.mode === "static" && sr1 - sr0 === 0 && ds1.draws === ds0.draws && ds1.draws >= 1, JSON.stringify({ mode: ds0?.mode, draws: ds1?.draws, rafΔ: sr1 - sr0 }));
	await page.goto(`${base}/settings`);
	await page.click('[data-testid="reduce-motion-toggle"]');
	await page.click('[data-testid="dot-matrix-toggle"]');
	await page.goto(`${base}/`);
	await page.waitForSelector('[data-testid="home-greeting"]');
	check("settings: turning 动态点阵背景 off removes the canvas entirely", (await page.locator('[data-testid="dot-matrix"]').count()) === 0 && (await dots(page)) === null);
	await page.goto(`${base}/settings`);
	await page.click('[data-testid="dot-matrix-toggle"]');
	await page.goto(`${base}/`);
	await page.waitForSelector('[data-testid="dot-matrix"]');

	// ================================================================= 6. system reduced motion
	const rctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", locale: "zh-CN" });
	await rctx.addInitScript(INIT);
	const rp = await rctx.newPage();
	await register(rp, base, { email: `r4rm-${Date.now()}@example.com`, name: "张宁" });
	await sleep(1200);
	const rr0 = await raf(rp);
	const rd0 = await dots(rp);
	await sleep(1800);
	const rr1 = await raf(rp);
	const rd1 = await dots(rp);
	check("reduced motion (system): canvas renders static dots, zero rAF callbacks, no frames after the first", rd0?.mode === "static" && rr1 - rr0 === 0 && rd1.draws === rd0.draws && rd1.draws >= 1, JSON.stringify({ mode: rd0?.mode, draws: rd1?.draws, rafΔ: rr1 - rr0 }));
	const rm0 = await rctx.newCDPSession(rp);
	await rm0.send("Performance.enable");
	const a0 = Object.fromEntries((await rm0.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
	await sleep(3000);
	const a1 = Object.fromEntries((await rm0.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
	const staticPct = ((a1.TaskDuration - a0.TaskDuration) / 3) * 100;
	console.log(`PERF static (reduced motion): main-thread ${staticPct.toFixed(2)}%`);
	check("reduced motion: static dots cost ~nothing (main thread < 2%)", staticPct < 2, `${staticPct.toFixed(2)}%`);
	await rctx.close();

	// ================================================================= 7. models: new API shape (provider names, capability object)
	const mctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	const mp = await mctx.newPage();
	await register(mp, base, { email: `r4m-${Date.now()}@example.com`, name: "赵宁" });
	await mp.route("**/api/models", (r) =>
		r.fulfill({
			json: {
				defaultModelId: "m-a",
				models: [
					{ id: "m-a", label: "Alpha 4", provider: { id: "acme", name: "Acme AI" }, status: "ready", isDefault: true, capabilities: { text: true, image: true, tools: true, reasoning: false }, thinkingLevels: ["off"], contextWindow: 1000000, ref: { provider: "acme", modelId: "alpha-4" } },
					{ id: "m-b", label: "Beta 2", providerName: "Acme AI", status: "ready", isDefault: false, capabilities: ["text", "tools", "reasoning"], thinkingLevels: ["off", "low", "high"], defaultThinking: "low", ref: { provider: "acme", modelId: "beta-2" } },
					{ id: "m-d", label: "Delta", providerId: "acme", providerName: "Acme AI", status: "ready", personal: true, isDefault: false, capabilities: ["text"], input: ["text", "image"], reasoning: true, thinkingLevels: ["off", "medium"], ref: { provider: "acme", modelId: "delta" } },
					{ id: "m-c", label: "Gamma", providerName: "另一家", status: "blocked", statusDetail: "未配置凭据", capabilities: ["text"], thinkingLevels: [], ref: { provider: "other", modelId: "gamma" } },
				],
			},
		}),
	);
	await mp.reload();
	await mp.waitForSelector('[data-testid="model-picker"]');
	await mp.click('[data-testid="model-picker"]');
	await mp.waitForSelector('[data-testid="model-option"]');
	const groupNames = await mp.locator('[data-testid="model-group"]').evaluateAll((g) => g.map((x) => x.getAttribute("aria-label")));
	const shapeTxt = await mp.locator('[role="menu"]').innerText();
	check("models: richer /api/models shape (provider name, capability object, context window) is grouped and badged", groupNames.join(",") === "Acme AI,另一家" && shapeTxt.includes("1M") && (await mp.locator('[data-cap="image"]').count()) === 2 && shapeTxt.includes("我的密钥"), `${groupNames.join(",")} | ${shapeTxt.replace(/\n/g, " ").slice(0, 160)}`);
	await mctx.close();

	// ================================================================= 8. phone 390 × 844
	const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "zh-CN" });
	await mob.addInitScript(INIT);
	await mob.addInitScript((id) => localStorage.setItem("wr.model.default.v1", JSON.stringify({ id })), fixtureId);
	const mpg = await mob.newPage();
	await register(mpg, base, { email: `r4mob-${Date.now()}@example.com`, name: "陈一" });
	await mpg.waitForSelector('[data-testid="composer"]');
	await sleep(1200);
	const geo = await mpg.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, cb: document.querySelector('[data-testid="composer"]').getBoundingClientRect().bottom, ih: innerHeight }));
	check("390: no horizontal scroll; composer docked at the bottom of the screen", geo.sw <= geo.iw && geo.ih - geo.cb < 40, JSON.stringify(geo));
	await shot(mpg, "round4-390-home");
	await mpg.tap('[data-testid="attach-menu"]');
	await mpg.waitForSelector('[data-testid="bottom-sheet"]');
	const sheetTxt = await mpg.locator('[data-testid="bottom-sheet"]').innerText();
	check("390: the + menu is a bottom sheet with the upload / library / knowledge actions", ["上传文件", "从文件库选择", "引用知识库"].every((t) => sheetTxt.includes(t)), sheetTxt.replace(/\n/g, " | ").slice(0, 100));
	await shot(mpg, "round4-390-attach-sheet");
	await mpg.keyboard.press("Escape");
	await mpg.waitForFunction(() => !document.querySelector('[data-testid="bottom-sheet"]'));
	await mpg.tap('[data-testid="model-picker"]');
	await mpg.waitForSelector('[data-testid="bottom-sheet"] [data-testid="model-option"]');
	await shot(mpg, "round4-390-model-sheet");
	await mpg.keyboard.press("Escape");
	await mpg.waitForFunction(() => !document.querySelector('[data-testid="bottom-sheet"]'));
	await mpg.setInputFiles('[data-testid="file-input"]', [
		{ name: "现场照片.png", mimeType: "image/png", buffer: PNG },
		{ name: "季度汇总报告-最终版.pdf", mimeType: "application/pdf", buffer: PDF },
	]);
	await allReady(mpg, 2);
	await shot(mpg, "round4-390-composer-files");
	await sendMessage(mpg, "手机上发送 [[reply 收到。]]");
	await mpg.waitForURL(/\/c\//);
	await mpg.waitForSelector('[data-testid="assistant-message"]', { timeout: 20000 });
	await sleep(900);
	const geo2 = await mpg.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, cb: document.querySelector('[data-testid="composer"]').getBoundingClientRect().bottom, ih: innerHeight }));
	check("390 chat: no horizontal scroll, composer at the bottom, cards inside the screen", geo2.sw <= geo2.iw && geo2.ih - geo2.cb < 40, JSON.stringify(geo2));
	await shot(mpg, "round4-390-chat");
	await mob.close();

	// ================================================================= 9. 1366 × 768 + dark
	const lap = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 2, locale: "zh-CN" });
	await lap.addInitScript(INIT);
	await lap.addInitScript((id) => localStorage.setItem("wr.model.default.v1", JSON.stringify({ id })), fixtureId);
	const lp = await lap.newPage();
	await register(lp, base, { email: `r4lap-${Date.now()}@example.com`, name: "吴桐" });
	await sleep(1000);
	await shot(lp, "round4-1366-home");
	await lp.setInputFiles('[data-testid="file-input"]', [{ name: "销售数据.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("PK fake") }, { name: "封面.png", mimeType: "image/png", buffer: PNG }]);
	await allReady(lp, 2);
	await sendMessage(lp, '整理一下 [[call file_create {"name":"销售汇总","format":"md","title":"销售汇总","content":"# 汇总\\n- 数据已整理"}]]');
	await lp.waitForURL(/\/c\//);
	await lp.waitForSelector('[data-testid="file-card"]', { timeout: 40000 }).catch(async (e) => {
		console.log("DEBUG lp page:", (await lp.locator("main").innerText()).slice(0, 600));
		throw e;
	});
	await lp.waitForSelector('[data-testid="assistant-message"] .wr-prose', { timeout: 20000 });
	await lp.locator('[data-testid="file-card"] button').first().click();
	await lp.waitForSelector('[data-testid="side-panel"]');
	await sleep(1200);
	const g3 = await lp.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
	check("1366×768: chat with preview open has no horizontal overflow", g3.sw <= g3.iw, JSON.stringify(g3));
	await shot(lp, "round4-1366-chat-preview");
	await lp.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
	await sleep(600);
	await shot(lp, "round4-1366-chat-dark");
	await lp.goto(`${base}/`);
	await lp.waitForSelector('[data-testid="composer"]');
	await lp.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
	await sleep(700);
	await shot(lp, "round4-1366-home-dark");
	await lap.close();

	// ================================================================= 10. hygiene
	check("no external requests during the whole run (fonts / CDN / assets)", externals.length === 0, externals.slice(0, 3).join(", "));
	check("no uncaught page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
	await ctx.close();
} catch (e) {
	check("script ran to completion", false, String(e?.stack ?? e).slice(0, 700));
} finally {
	await browser.close();
	await server.stop();
}
const ok = summary(join(SHOTS, "round4-chat.results.json"));
process.exit(ok ? 0 : 1);
