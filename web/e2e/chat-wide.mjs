// 会话页加宽模式 (chat wide mode), checked in a real browser against the fixture model.
//  - default: centered 760px column, assistant avatar shown;
//  - 加宽: only the message area widens (the composer keeps its fixed default width), avatar and its gutter are gone, status rows and the answer share one left edge;
//  - choice persists (localStorage wr.prefs.v1.chatWide + survives a reload); second click restores the default; font size unchanged.
// Run: npm run -s build:web && node web/e2e/chat-wide.mjs        (port 8861; SHOTS_DIR overrides the screenshot folder)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { check, chromium, register, startServer, summary, SHOTS } from "./lib.mjs";

const DIR = process.env.SHOTS_DIR || join(SHOTS, "chat-wide");
mkdirSync(DIR, { recursive: true });
const server = await startServer({ port: 8861, env: { WORKROOM_FIXTURE_TPS: "200" } });
const browser = await chromium.launch();
const T = (id) => `[data-testid="${id}"]`;
const call = (tool, args) => `[[call ${tool} ${JSON.stringify(args)}]]`;
const shot = (page, name) => page.screenshot({ path: join(DIR, `${name}.png`), fullPage: false });

try {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 1 });
	const page = await ctx.newPage();
	await register(page, server.base, { email: "wide@example.com", name: "加宽" });
	await page.fill(T("composer-input"), `${call("wr_fixture_echo", { text: "你好" })} 帮我整理一下今天的工作，列出三个要点。`);
	await page.click(T("send"));
	await page.waitForURL(/\/c\/[^/]+\/\d+/);
	await page.waitForSelector(T("assistant-message"), { timeout: 20000 });
	await page.waitForSelector(`${T("run-summary")}`, { timeout: 30000 });
	await page.waitForFunction(() => !document.querySelector('[data-testid="stop"]'), null, { timeout: 30000 }).catch(() => {});

	const geo = () =>
		page.evaluate(() => {
			const q = (s) => document.querySelector(`[data-testid="${s}"]`);
			const msg = q("assistant-message");
			const col = q("chat-scroll").firstElementChild;
			const comp = q("composer-input").closest("div.mx-auto");
			const sum = q("run-summary");
			const ans = msg.querySelector(".wr-md, p, [data-testid='markdown']") || msg.querySelector("p");
			return {
				colW: Math.round(col.getBoundingClientRect().width),
				compW: Math.round(comp.getBoundingClientRect().width),
				avatar: !!q("assistant-avatar"),
				msgLeft: Math.round(msg.getBoundingClientRect().left),
				sumLeft: Math.round(sum.getBoundingClientRect().left),
				ansLeft: ans ? Math.round(ans.getBoundingClientRect().left) : null,
				font: ans ? getComputedStyle(ans).fontSize : null,
				sidebar: Math.round(q("sidebar")?.getBoundingClientRect().width ?? 0),
				pref: JSON.parse(localStorage.getItem("wr.prefs.v1") || "{}").chatWide ?? null,
				pressed: q("toggle-wide").getAttribute("aria-pressed"),
			};
		});

	const a = await geo();
	await shot(page, "chat-default");
	check("默认：内容居中的 760px 栏，保留 AI 头像", a.colW <= 760 && a.avatar && a.pressed === "false", JSON.stringify(a));

	await page.hover(T("toggle-wide"));
	const tip = await page.waitForSelector('[role="tooltip"]', { timeout: 3000 }).catch(() => null);
	check("悬停提示「加宽」", !!tip && (await tip.innerText()).includes("加宽"));

	await page.click(T("toggle-wide"));
	await page.waitForTimeout(300);
	const b = await geo();
	await page.mouse.move(700, 400);
	await shot(page, "chat-wide");
	check("加宽：只加宽消息区，底部输入框宽度固定不变", b.colW > a.colW + 200 && b.compW === a.compW, `${a.colW} -> ${b.colW}, composer ${a.compW} -> ${b.compW}`);
	check("加宽：AI 头像和占位消失，状态行与正文左对齐", !b.avatar && Math.abs(b.sumLeft - b.msgLeft) <= 2 && (b.ansLeft === null || Math.abs(b.ansLeft - b.msgLeft) <= 2), JSON.stringify(b));
	check("加宽：字体与左侧导航不变", b.font === a.font && b.sidebar === a.sidebar, `${a.font}/${b.font} sidebar ${a.sidebar}/${b.sidebar}`);
	check("选择持久化到偏好并随刷新保留", b.pref === true && b.pressed === "true");
	await page.reload();
	await page.waitForSelector(T("assistant-message"));
	const c = await geo();
	check("刷新后仍是加宽", c.colW === b.colW && !c.avatar && c.pref === true);

	// narrower window: the column shrinks with it, nothing overflows horizontally
	await page.setViewportSize({ width: 900, height: 800 });
	await page.waitForTimeout(250);
	const n = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
	check("窗口变窄时不出现横向滚动", n.over <= 0, JSON.stringify(n));
	await page.setViewportSize({ width: 1440, height: 860 });

	// work panel (floats over the chat) and preview column
	await page.click(T("open-work-panel"));
	await page.waitForSelector(T("work-float"));
	await page.waitForTimeout(400);
	await shot(page, "chat-wide-work-panel");
	const w = await geo();
	check("工作面板打开时加宽不变形（浮层不挤压消息栏）", w.colW === b.colW);
	await page.click(T("open-work-panel"));

	await page.click(T("toggle-wide"));
	await page.waitForTimeout(300);
	const d = await geo();
	check("再次点击恢复默认宽度和头像", d.colW === a.colW && d.avatar && d.pref === false && d.pressed === "false", JSON.stringify(d));
} finally {
	await browser.close();
	await server.stop();
}
process.exit(summary(join(DIR, "chat-wide.json")) ? 0 : 1);
