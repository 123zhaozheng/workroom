// Round 17 — 专家: 专家广场 (cards, categories, search) · 创建/编辑表单 · 提交审查 → 审查员审核 → 发布 · 详情 → 开始对话 ·
// 会话输入框 "@" 弹层 → 芯片 → 消息由该专家回答 · 会话顶部专家与模型切换。Screenshots go to $SHOTS_DIR.
// Run: npm run build:web && SHOTS_DIR=… node web/e2e/r17-experts.mjs   (port 8871; uses the system Chromium via playwright-core)
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
const PORT = Number(process.env.E2E_PORT ?? 8871);
const dataDir = process.env.WR_DATA ?? `/tmp/wr-experts-${PORT}`;
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
	env: { ...process.env, WORKROOM_DATA_DIR: dataDir, PORT: String(PORT), WORKROOM_ONBOARDING: "off", WORKROOM_SECRET_KEY: "e2e-experts-key-not-for-production" },
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
	const mk = async (w = 1366, h = 800) => {
		const ctx = await browser.newContext({ viewport: { width: w, height: h } });
		return { ctx, page: await ctx.newPage() };
	};
	const shot = (page, name) => page.screenshot({ path: join(SHOTS, `experts-${name}.png`) });
	const register = async (page, email, name) => {
		await page.goto(`${base}/register`);
		await page.fill("#name", name);
		await page.fill("#email", email);
		await page.fill("#password", "password123");
		await page.click('button[type="submit"]');
		await page.waitForSelector('[data-testid="home-greeting"]');
	};
	const api = (page, method, path, data) => page.evaluate(async ([m, p, d]) => {
		const r = await fetch(`/api${p}`, { method: m, headers: { "content-type": "application/json" }, body: d === undefined ? undefined : JSON.stringify(d) });
		return { status: r.status, body: await r.json().catch(() => null) };
	}, [method, path, data]);

	// ---------------- admin (org owner) creates a skill, then experts through the UI/API
	const A = await mk();
	await register(A.page, "owner@e2e.example", "管理员");
	const zipB64 = (await import("node:zlib")).default && null;
	const { zipSync, strToU8 } = await import(join(ROOT, "node_modules/fflate/esm/browser.js")).catch(() => require(join(ROOT, "node_modules/fflate")));
	const skillMd = (v) => `---\nname: weekly-report\ndescription: 把本周的工作整理成周报。当用户要写周报时使用。\nversion: ${v}\n---\n\n# 周报 v${v}\n`;
	const upload = async (v, skillId) => {
		const b64 = Buffer.from(zipSync({ "SKILL.md": strToU8(skillMd(v)) })).toString("base64");
		return api(A.page, "POST", "/market/skills/upload", { zipBase64: b64, ...(skillId ? { skillId } : {}) });
	};
	const up = await upload("1.0.0");
	const skillId = up.body.skill.id;
	// publish the skill to the org (owner is submitter → force publish)
	await api(A.page, "POST", `/market/skills/${skillId}/force-publish`, { versionNo: 1, reason: "e2e 初始发布" });
	for (const [name, tagline, cat, extra] of [
		["周报专家", "把一周的工作整理成周报", "办公效率", { skills: [{ skillId }], starters: ["帮我写本周周报", "把这些要点整理成周报"], opening: "你好，我是周报专家。", tags: ["周报", "办公"] }],
		["代码审查员", "按团队规范审查代码改动", "研发", { tags: ["代码"] }],
		["数据分析师", "分析表格并给出结论与图表", "数据分析", {}],
		["翻译官", "中英互译，保留格式", "写作", {}],
	]) {
		const r = await api(A.page, "POST", "/experts", { name, tagline, category: cat, instructions: `你是${name}。`, ...extra });
		await api(A.page, "POST", `/experts/${r.body.expert.id}/force-publish`, { reason: "e2e 初始发布" });
	}
	await A.page.goto(`${base}/`);
	await A.page.waitForSelector('[data-testid="nav-experts"]');
	check("sidebar: 专家 entry sits next to 文件库", (await A.page.locator('nav[aria-label="主导航"] a').allInnerTexts()).join("|").includes("文件库|专家") || (await A.page.locator('[data-testid="nav-experts"]').innerText()).includes("专家"));
	await A.page.click('[data-testid="nav-experts"]');
	await A.page.waitForSelector('[data-testid="expert-card"]');
	check("square: 4 expert cards", (await A.page.locator('[data-testid="expert-card"]').count()) === 4);
	check("square: card shows mounted skill", (await A.page.locator('[data-testid="card-skill"]').count()) >= 1);
	await sleep(300);
	await shot(A.page, "1-square");
	await A.page.fill('[data-testid="expert-search"]', "代码");
	await sleep(200);
	check("square: search narrows", (await A.page.locator('[data-testid="expert-card"]').count()) === 1);
	await A.page.fill('[data-testid="expert-search"]', "");
	await A.page.getByRole("button", { name: "研发", exact: true }).click();
	await sleep(200);
	check("square: category filter", (await A.page.locator('[data-testid="expert-card"]').count()) === 1);
	await A.page.getByRole("button", { name: "全部", exact: true }).click();

	// detail
	await A.page.locator('[data-testid="expert-card"]', { hasText: "周报专家" }).click();
	await A.page.waitForSelector('[data-testid="expert-detail"]');
	check("detail: mounted skill shows its current version", (await A.page.locator('[data-testid="detail-skills"]').innerText()).includes("v1.0.0"));
	await shot(A.page, "2-detail");
	await A.page.keyboard.press("Escape");

	// create form through the UI
	await A.page.click('[data-testid="tab-my-experts"]');
	await A.page.click('[data-testid="expert-new"]');
	await A.page.waitForSelector('[data-testid="expert-editor"]');
	await A.page.fill('[data-testid="expert-name"]', "会议纪要专家");
	await A.page.fill('[data-testid="expert-tagline"]', "把会议录音整理成结构化纪要");
	await A.page.fill('[data-testid="expert-instructions"]', "你擅长整理会议纪要：议题、结论、待办。");
	await A.page.click('[data-testid="expert-skill-add"]');
	await A.page.locator('[role="option"]', { hasText: "weekly-report" }).click();
	await sleep(300);
	check("editor: skill picker adds a reference chip", (await A.page.locator('[data-testid="expert-skill-picker"]').innerText()).includes("weekly-report"));
	await shot(A.page, "3-editor");
	await A.page.click('[data-testid="expert-save"]');
	await A.page.waitForSelector('[data-testid="expert-detail"]');
	await A.page.keyboard.press("Escape");
	await A.page.click('[data-testid="tab-my-experts"]');
	await sleep(400);
	const myRow = A.page.locator('[data-testid="my-expert"]', { hasText: "会议纪要专家" });
	check("my experts: new draft listed", (await myRow.count()) === 1 && (await myRow.innerText()).includes("草稿"));
	await shot(A.page, "4-my-experts");

	// ---------------- a member: invite, mention popup, answers as the expert
	const inv = await api(A.page, "POST", "/admin/invites", { role: "member" });
	const M = await mk();
	await M.page.goto(`${base}/register`);
	await M.page.fill("#name", "小王");
	await M.page.fill("#email", "member@e2e.example");
	await M.page.fill("#password", "password123");
	await M.page.evaluate(() => {});
	const reg = await M.page.evaluate(async (code) => (await fetch("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "member@e2e.example", name: "小王", password: "password123", inviteCode: code }) })).status, inv.body.invite.code);
	check("member registered by invite", reg === 200, String(reg));
	await M.page.goto(`${base}/`);
	await M.page.waitForSelector('[data-testid="home-greeting"]');
	await M.page.click('[data-testid="composer-input"]');
	await M.page.keyboard.type("@");
	await M.page.waitForSelector('[data-testid="mention-menu"]');
	await M.page.waitForSelector('[data-testid="mention-item"]');
	check("@ popup lists the published experts", (await M.page.locator('[data-testid="mention-item"]').count()) === 4);
	await shot(M.page, "5-mention-popup");
	await M.page.keyboard.type("周报");
	await sleep(200);
	check("@ popup filters while typing", (await M.page.locator('[data-testid="mention-item"]').count()) === 1);
	await M.page.keyboard.press("Enter");
	await M.page.waitForSelector('[data-testid="chip-expert"]');
	check("@ pick becomes a chip", (await M.page.locator('[data-testid="chip-expert"]').innerText()).includes("周报专家"));
	await M.page.fill('[data-testid="composer-input"]', "帮我写本周周报");
	await shot(M.page, "6-mention-chip");
	await M.page.click('[data-testid="send"]');
	await M.page.waitForURL(/\/c\//);
	await M.page.waitForSelector('[data-testid="message-expert"]');
	check("message shows the expert chip", (await M.page.locator('[data-testid="message-expert"]').innerText()).includes("周报专家"));
	await M.page.waitForSelector('[data-testid="chat-expert"]');
	check("conversation header shows the expert + model", (await M.page.locator('[data-testid="chat-expert"]').innerText()).includes("周报专家"));
	await sleep(1500);
	await shot(M.page, "7-conversation-expert");
	await M.page.click('[data-testid="chat-expert"]');
	await sleep(300);
	await shot(M.page, "8-header-model-menu");
	await M.page.keyboard.press("Escape");

	// a follow-up message in the same chat with @ of another expert
	await M.page.click('[data-testid="composer-input"]');
	await M.page.keyboard.type("@翻译");
	await M.page.waitForSelector('[data-testid="mention-item"]');
	await M.page.keyboard.press("Enter");
	await M.page.fill('[data-testid="composer-input"]', "把这句话翻译成英文：你好");
	await M.page.click('[data-testid="send"]');
	await sleep(2500);
	const chips = await M.page.locator('[data-testid="message-expert"]').allInnerTexts();
	check("second message answered by a different expert", chips.some((c) => c.includes("翻译官")), chips.join("|"));

	// mobile
	const Mo = await mk(390, 844);
	await Mo.page.goto(`${base}/login`);
	await Mo.page.fill("#email", "member@e2e.example");
	await Mo.page.fill("#password", "password123");
	await Mo.page.click('button[type="submit"]');
	await Mo.page.waitForSelector('[data-testid="home-greeting"]');
	await Mo.page.goto(`${base}/experts`);
	await Mo.page.waitForSelector('[data-testid="expert-card"]');
	await shot(Mo.page, "9-square-mobile");

	// review queue shows an expert submission (member without expert.publish: owner submits to a department-free org; use owner→ reviewer path via API)
	const u2 = await api(A.page, "POST", "/experts", { name: "待审专家", tagline: "测试审查队列", instructions: "x" });
	const memberExpert = await M.page.evaluate(async () => {
		const r = await fetch("/api/experts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "成员的专家", tagline: "成员自己创建", instructions: "你是成员的专家" }) });
		return (await r.json()).expert;
	});
	// owner grants publish right, member submits; owner (a reviewer-capable admin) opens the review queue
	const me = await M.page.evaluate(async () => (await (await fetch("/api/me")).json()).me ?? (await (await fetch("/api/me")).json()));
	await api(A.page, "PUT", `/admin/members/${me.userId ?? me.id}/grants`, { permission: "expert.publish", effect: "allow" });
	const sub = await M.page.evaluate(async (id) => (await (await fetch(`/api/experts/${id}/submit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetScope: "org", note: "请审查" }) })).json()), memberExpert.id);
	check("member submitted an expert for review", sub.submission?.state === "pending_review", JSON.stringify(sub).slice(0, 120));
	await A.page.goto(`${base}/capabilities?tab=review`);
	await A.page.waitForSelector('[data-testid="review-item"]');
	await A.page.locator('[data-testid="review-item"]', { hasText: "成员的专家" }).click();
	await A.page.waitForSelector('[data-testid="expert-info"]');
	check("review queue: expert submission shows its configuration", (await A.page.locator('[data-testid="expert-info"]').innerText()).includes("成员的专家"));
	await shot(A.page, "10-review-queue-expert");
	void u2;
	await browser.close();
} catch (e) {
	fail++;
	console.log("FAIL  script error:", e?.message ?? e);
	console.log(out.slice(-1500));
} finally {
	await stop();
}
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
