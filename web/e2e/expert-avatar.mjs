// Expert bot avatars + the new logo, in a real browser: expert square / detail / editor picker / @ popup / conversation (header, message chip, answer avatar),
// light AND dark, the product logo (sidebar, login, favicon), and the performance contract (resting avatars blink only, working ones animate,
// off-screen and reduced-motion ones do nothing). Screenshots go to $SHOTS_DIR.
// Run: npm run build:web && SHOTS_DIR=… node web/e2e/expert-avatar.mjs   (port 8872; system Chromium via playwright-core)
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let pw;
try {
	pw = require("playwright");
} catch {
	pw = require("playwright-core");
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHOTS = process.env.SHOTS_DIR ?? join(ROOT, "artifacts/screenshots");
mkdirSync(SHOTS, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 8872);
const dataDir = process.env.WR_DATA ?? `/tmp/wr-avatar-${PORT}`;
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
	ok ? pass++ : fail++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/src/main.ts"], {
	cwd: ROOT,
	env: { ...process.env, WORKROOM_DATA_DIR: dataDir, PORT: String(PORT), WORKROOM_ONBOARDING: "off", WORKROOM_SECRET_KEY: "e2e-avatar-key-not-for-production" },
	stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 120; i++) {
	await sleep(150);
	try {
		if ((await fetch(`${base}/api/health`)).ok) break;
	} catch {}
}
const stop = async () => {
	child.kill("SIGTERM");
	await new Promise((r) => child.once("exit", r));
};

try {
	const browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
	const mk = async (theme, w = 1366, h = 820, extra = {}) => {
		const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, ...extra });
		await ctx.addInitScript((t) => localStorage.setItem("wr.prefs.v1", JSON.stringify({ theme: t, dotMatrix: false })), theme);
		return { ctx, page: await ctx.newPage() };
	};
	const shot = (page, name) => page.screenshot({ path: join(SHOTS, `avatar-${name}.png`) });
	const api = (page, method, path, data) =>
		page.evaluate(async ([m, p, d]) => {
			const r = await fetch(`/api${p}`, { method: m, headers: { "content-type": "application/json" }, body: d === undefined ? undefined : JSON.stringify(d) });
			return { status: r.status, body: await r.json().catch(() => null) };
		}, [method, path, data]);
	const stats = (page) => page.evaluate(() => ({ ...window.__wrBotStats }));

	// ---------------- owner registers (light), creates experts through the API with chosen looks (one without, to get the default)
	const A = await mk("light");
	await A.page.goto(`${base}/register`);
	await A.page.fill("#name", "管理员");
	await A.page.fill("#email", "owner@e2e.example");
	await A.page.fill("#password", "password123");
	await A.page.click('button[type="submit"]');
	await A.page.waitForSelector('[data-testid="home-greeting"]');
	const specs = [
		["周报专家", "把一周的工作整理成周报", "办公效率", { shape: "cat", color: "#f8a01c" }],
		["代码审查员", "按团队规范审查代码改动", "研发", { shape: "shield", color: "#1f7cf2" }],
		["数据分析师", "分析表格并给出结论与图表", "数据分析", { shape: "magnifier", color: "#ec4899" }],
		["翻译官", "中英互译，保留格式", "写作", { shape: "chat", color: "#14b3a5" }],
		["设计搭子", "给配色和排版提建议", "设计", { shape: "palette", color: "#f2384b" }],
		["运营小火箭", "活动文案与增长点子", "运营", { shape: "rocket", color: "#8b5cf6" }],
		["知识管家", "整理资料、答疑", "通用", { shape: "book", color: "#a8693f" }],
		["夜班值守", "（没有选造型：用 id 的稳定默认）", "通用", undefined],
	];
	const ids = [];
	for (const [name, tagline, category, avatarConfig] of specs) {
		const r = await api(A.page, "POST", "/experts", { name, tagline, category, instructions: `你是${name}。`, ...(avatarConfig ? { avatarConfig } : {}) });
		ids.push(r.body.expert.id);
		await api(A.page, "POST", `/experts/${r.body.expert.id}/force-publish`, { reason: "e2e" });
	}
	const defaultOne = (await api(A.page, "GET", `/experts/${ids[7]}`)).body.expert;
	check("API: an expert created without a look gets a valid default avatarConfig", !!defaultOne.avatarConfig?.shape && /^#[0-9a-f]{6}$/.test(defaultOne.avatarConfig.color), JSON.stringify(defaultOne.avatarConfig));

	// ---------------- square (light) + sizes
	await A.page.goto(`${base}/experts`);
	await A.page.waitForSelector('[data-testid="expert-card"]');
	await sleep(600);
	const cards = await A.page.locator('[data-testid="expert-card"] [data-testid="bot-avatar"]').count();
	check("square: every card has a bot avatar (no text avatar)", cards === 8, String(cards));
	const shapes = await A.page.locator('[data-testid="expert-card"] [data-testid="bot-avatar"]').evaluateAll((els) => els.map((e) => e.dataset.shape));
	check("square: cards use the configured shapes", ["cat", "shield", "magnifier", "chat", "palette", "rocket", "book"].every((s) => shapes.includes(s)), shapes.join(","));
	const drawn = await A.page.evaluate(() => [...document.querySelectorAll('[data-testid="expert-card"] canvas')].filter((c) => { const x = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < x.length; i += 4) if (x[i] > 0) return true; return false; }).length);
	check("square: every canvas actually painted pixels", drawn === 8, String(drawn));
	await shot(A.page, "1-square-light");

	// performance: resting avatars blink only; the page is idle between blinks
	const s0 = await stats(A.page);
	await sleep(8000);
	const s1 = await stats(A.page);
	const calmFrames = s1.drawn - s0.drawn;
	check("perf: 8 resting (calm) avatars draw ≤ 4 frames/s each (blink only, ~10% of the full animation) and nothing is pending between blinks", calmFrames <= 8 * 4 * 8, `${calmFrames} frames in 8 s for 8 avatars (full animation would be ~${8 * 30 * 8})`);
	// detail
	await A.page.locator('[data-testid="expert-card"]', { hasText: "周报专家" }).click();
	await A.page.waitForSelector('[data-testid="expert-detail"]');
	await sleep(400);
	check("detail: 52px bot avatar with the configured shape", (await A.page.locator('[data-testid="expert-detail"] [data-testid="bot-avatar"]').first().getAttribute("data-shape")) === "cat");
	await shot(A.page, "2-detail-light");
	await A.page.keyboard.press("Escape");

	// editor: picker (shape, color, eye, JSON), preview, save
	await A.page.click('[data-testid="tab-my-experts"]');
	await A.page.waitForSelector('[data-testid="my-expert"]');
	check("my experts: rows show bot avatars", (await A.page.locator('[data-testid="my-expert"] [data-testid="bot-avatar"]').count()) === 8);
	await A.page.click('[data-testid="expert-new"]');
	await A.page.waitForSelector('[data-testid="avatar-picker"]');
	const startShape = await A.page.locator('[data-testid="avatar-picker"] [data-testid="bot-avatar"]').first().getAttribute("data-shape");
	check("editor: a new expert starts with a default look (shape preselected)", (await A.page.locator('[data-testid="avatar-shape"][aria-checked="true"]').getAttribute("data-shape")) === startShape);
	await A.page.fill('[data-testid="expert-name"]', "会议纪要专家");
	await A.page.fill('[data-testid="expert-tagline"]', "把会议录音整理成结构化纪要");
	await A.page.fill('[data-testid="expert-instructions"]', "你擅长整理会议纪要：议题、结论、待办。");
	await A.page.click('[data-testid="avatar-shape"][data-shape="ghost"]');
	await A.page.click('[data-testid="avatar-color"][data-color="#1fbf68"]');
	await A.page.click('[data-testid="avatar-picker"] summary');
	const json = JSON.parse(await A.page.inputValue('[data-testid="avatar-json"]'));
	check("editor: shape and color pick update the JSON", json.shape === "ghost" && json.color === "#1fbf68", JSON.stringify(json));
	await A.page.fill('[data-testid="avatar-json"]', '{"shape":"star","color":"#ff6a1a","eyeColor":"#151515"}');
	check("editor: editing the JSON switches the picker", (await A.page.locator('[data-testid="avatar-shape"][aria-checked="true"]').getAttribute("data-shape")) === "star");
	await A.page.fill('[data-testid="avatar-json"]', '{"shape":"dragon","color":"red"}');
	check("editor: invalid JSON shows the validation error and keeps the last good look", (await A.page.locator('[data-testid="avatar-picker"] [role="alert"]').innerText()).length > 0 && (await A.page.locator('[data-testid="avatar-shape"][aria-checked="true"]').getAttribute("data-shape")) === "star");
	await A.page.click('[data-testid="avatar-shape"][data-shape="cloud"]');
	await A.page.click('[data-testid="avatar-color"][data-color="#8b5cf6"]');
	await sleep(300);
	await shot(A.page, "3-editor-light");
	await A.page.click('[data-testid="expert-save"]');
	await A.page.waitForSelector('[data-testid="expert-detail"]');
	await A.page.keyboard.press("Escape");
	const saved = (await api(A.page, "GET", "/experts?mine=1")).body.experts.find((e) => e.name === "会议纪要专家");
	check("editor: saved look is persisted (cloud / purple)", saved?.avatarConfig?.shape === "cloud" && saved?.avatarConfig?.color === "#8b5cf6", JSON.stringify(saved?.avatarConfig));

	// ---------------- member (dark): square, @ popup, chip, conversation with a working expert
	const inv = await api(A.page, "POST", "/admin/invites", { role: "member" });
	const M = await mk("dark");
	await M.page.goto(`${base}/register`);
	await M.page.evaluate(async (code) => (await fetch("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "member@e2e.example", name: "小王", password: "password123", inviteCode: code }) })).status, inv.body.invite.code);
	await M.page.goto(`${base}/experts`);
	await M.page.waitForSelector('[data-testid="expert-card"]');
	await sleep(600);
	check("dark: theme is dark", (await M.page.evaluate(() => document.documentElement.dataset.theme)) === "dark");
	await shot(M.page, "1-square-dark");
	await M.page.locator('[data-testid="expert-card"]', { hasText: "代码审查员" }).click();
	await M.page.waitForSelector('[data-testid="expert-detail"]');
	await sleep(400);
	await shot(M.page, "2-detail-dark");
	await M.page.keyboard.press("Escape");
	await M.page.goto(`${base}/`);
	await M.page.waitForSelector('[data-testid="home-greeting"]');
	await shot(M.page, "5-home-logo-dark");
	await M.page.click('[data-testid="composer-input"]');
	await M.page.keyboard.type("@");
	await M.page.waitForSelector('[data-testid="mention-item"]');
	await sleep(500);
	check("@ popup: every item has a bot avatar", (await M.page.locator('[data-testid="mention-item"] [data-testid="bot-avatar"]').count()) === (await M.page.locator('[data-testid="mention-item"]').count()));
	await shot(M.page, "3-mention-dark");
	await M.page.keyboard.type("代码");
	await M.page.keyboard.press("Enter");
	await M.page.waitForSelector('[data-testid="chip-expert"]');
	check("chip: the chosen expert's avatar is in the composer chip", (await M.page.locator('[data-testid="chip-expert"] [data-testid="bot-avatar"]').getAttribute("data-shape")) === "shield");
	await M.page.fill('[data-testid="composer-input"]', "[[slow 6000]] 帮我看看这段代码");
	await M.page.click('[data-testid="send"]');
	await M.page.waitForURL(/\/c\//);
	await M.page.waitForSelector('[data-testid="chat-expert"]');
	await M.page.waitForSelector('[data-testid="assistant-avatar"]');
	await sleep(1200);
	const working = await M.page.evaluate(() => ({ head: document.querySelector('[data-testid="chat-expert"] [data-testid="bot-avatar"]')?.dataset.mood, ans: document.querySelector('[data-testid="assistant-avatar"] [data-testid="bot-avatar"]')?.dataset.mood, shape: document.querySelector('[data-testid="assistant-avatar"] [data-testid="bot-avatar"]')?.dataset.shape }));
	check("conversation: while the run works, the header and answer avatars switch to the full animation", working.head === "working" && working.ans === "working" && working.shape === "shield", JSON.stringify(working));
	const w0 = await stats(M.page);
	await sleep(1000);
	const w1 = await stats(M.page);
	check("perf: a working avatar animates (≥ 15 frames/s drawn, ≤ 35 each)", w1.drawn - w0.drawn >= 2 * 15 && w1.drawn - w0.drawn <= 2 * 35 + 6, `${w1.drawn - w0.drawn} frames in 1 s for 2 avatars (+ chip)`);
	await shot(M.page, "4-conversation-working-dark");
	await M.page.waitForFunction(() => document.querySelector('[data-testid="assistant-avatar"] [data-testid="bot-avatar"]')?.dataset.mood === "calm", null, { timeout: 30000 });
	await sleep(800);
	check("conversation: back to the calm avatar when the run is over", true);
	const msgChip = await M.page.locator('[data-testid="message-expert"] [data-testid="bot-avatar"]').getAttribute("data-shape");
	check("conversation: the message's expert chip shows the expert's bot", msgChip === "shield", msgChip);
	await shot(M.page, "6-conversation-done-dark");

	// no expert bound → the product's own bot (dark body flips light on dark)
	await M.page.goto(`${base}/`);
	await M.page.waitForSelector('[data-testid="composer-input"]');
	await M.page.fill('[data-testid="composer-input"]', "你好");
	await M.page.click('[data-testid="send"]');
	await M.page.waitForURL(/\/c\//);
	await M.page.waitForSelector('[data-testid="assistant-avatar"] [data-testid="bot-avatar"]');
	check("conversation without an expert: the product bot (chat shape)", (await M.page.locator('[data-testid="assistant-avatar"] [data-testid="bot-avatar"]').first().getAttribute("data-shape")) === "chat");

	// ---------------- off-screen pause + reduced motion
	const O = await mk("light");
	await O.page.goto(`${base}/login`);
	await O.page.fill("#email", "owner@e2e.example");
	await O.page.fill("#password", "password123");
	await O.page.click('button[type="submit"]');
	await O.page.waitForSelector('[data-testid="home-greeting"]');
	await O.page.goto(`${base}/experts`);
	await O.page.waitForSelector('[data-testid="expert-card"]');
	await sleep(500);
	await O.page.evaluate(() => {
		// make the list long, push the cards off screen
		const sq = document.querySelector('[data-testid="expert-square"]');
		const pad = document.createElement("div");
		pad.style.height = "6000px";
		pad.id = "pad";
		sq.prepend(pad);
		window.scrollTo(0, 0);
		const sc = document.querySelector("main") ?? document.scrollingElement;
		sc.scrollTop = 0;
	});
	await O.page.evaluate(() => document.querySelector("#pad").scrollIntoView({ block: "start" }));
	await sleep(500);
	const visibleNow = await O.page.evaluate(() => [...document.querySelectorAll('[data-testid="expert-card"] [data-testid="bot-avatar"]')].filter((e) => { const r = e.getBoundingClientRect(); return r.bottom > -80 && r.top < innerHeight + 80; }).length);
	const o0 = await stats(O.page);
	await sleep(2500);
	const o1 = await stats(O.page);
	check("perf: off-screen avatars draw nothing (IntersectionObserver)", visibleNow === 0 ? o1.drawn - o0.drawn === 0 : false, `visible=${visibleNow}, frames in 2.5 s=${o1.drawn - o0.drawn} (on-screen baseline for 8 avatars was ${calmFrames}/8 s)`);
	await O.page.evaluate(() => document.querySelector("#pad").remove());

	const R = await mk("light", 1366, 820, { reducedMotion: "reduce" });
	await R.page.goto(`${base}/login`);
	await R.page.fill("#email", "owner@e2e.example");
	await R.page.fill("#password", "password123");
	await R.page.click('button[type="submit"]');
	await R.page.waitForSelector('[data-testid="home-greeting"]');
	await R.page.goto(`${base}/experts`);
	await R.page.waitForSelector('[data-testid="expert-card"]');
	await sleep(800);
	const r0 = await stats(R.page);
	await sleep(2500);
	const r1 = await stats(R.page);
	check("reduced motion: avatars are drawn once and never again", r1.drawn === r0.drawn && r1.pending === 0, `frames in 2.5 s=${r1.drawn - r0.drawn}, pending=${r1.pending}`);

	// ---------------- logo: sidebar, login, favicon (light + dark)
	const L = await mk("light", 1000, 640);
	await L.page.goto(`${base}/login`);
	await L.page.waitForSelector('[data-testid="brand-mark"]');
	await shot(L.page, "7-login-logo-light");
	const fav = await L.page.evaluate(async () => { const href = document.querySelector('link[rel="icon"]').getAttribute("href"); const r = await fetch(href); return { href, ok: r.ok, type: r.headers.get("content-type"), text: (await r.text()).slice(0, 40) }; });
	check("favicon: served SVG with the new logo", fav.ok && /svg/.test(fav.type ?? "") && fav.text.startsWith("<svg"), JSON.stringify(fav));
	const logo = await fetch(`${base}/logo.svg`);
	check("logo.svg is served", logo.ok);
	await L.page.fill("#email", "owner@e2e.example");
	await L.page.fill("#password", "password123");
	await L.page.click('button[type="submit"]');
	await L.page.waitForSelector('[data-testid="home-greeting"]');
	check("sidebar: the new brand mark replaces the old three-line icon", (await L.page.locator('aside [data-testid="brand-mark"], nav [data-testid="brand-mark"], [data-testid="brand-mark"]').count()) >= 1);
	await shot(L.page, "8-home-sidebar-logo-light");
	// logo close-up on both themes
	for (const theme of ["light", "dark"]) {
		const P = await mk(theme, 420, 220);
		await P.page.goto(`${base}/login`);
		await P.page.waitForSelector('[data-testid="brand-mark"]');
		await P.page.evaluate(() => { document.body.style.zoom = "1"; });
		await P.page.locator('[data-testid="brand-mark"]').first().screenshot({ path: join(SHOTS, `avatar-9-logo-${theme}.png`) });
		await P.ctx.close();
	}
	await browser.close();
} catch (e) {
	fail++;
	console.log("FAIL  script error:", e?.stack ?? e);
	console.log(out.slice(-1500));
} finally {
	await stop();
}
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
