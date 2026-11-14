// 浏览器放大弹框（工作面板 → 浏览器 → 放大）, checked in a real browser against the real server and a real live browser session:
//  - the 放大 button is on the browser entry, the dialog opens centered with title / URL / controller state / live screenshot
//  - Esc closes it and focus returns to the 放大 button
//  - agent controls → 接管 in the dialog → click on the screenshot reaches the page, scroll with the wheel scrolls the page,
//    typing works, 交还给助手 hands control back
//  - a project viewer sees the dialog read-only (只能观看, no 接管, no input)
// Run: npm run -s build:web && node web/e2e/browser-expand.mjs        (port 8841; SHOTS_DIR overrides where screenshots go)
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { check, chromium, register, sendMessage, sleep, startServer, summary, SHOTS } from "./lib.mjs";

const DIR = process.env.SHOTS_DIR || join(SHOTS, "browser-expand");
mkdirSync(DIR, { recursive: true });
const PAGE_PORT = 8842;
const pageServer = createServer((req, res) => {
	res.setHeader("content-type", "text/html; charset=utf-8");
	res.end(`<!doctype html><html><head><title>测试页面</title></head><body style="margin:0;font:16px sans-serif;padding:40px;background:#f6f8fb">
<h1>Workroom 浏览测试页</h1><p>这是一个本地测试页面，用于验证放大弹框里的接管、点击、滚动和输入。</p>
<button id="b" style="font-size:20px;padding:12px 24px" onclick="document.title='已点击';this.textContent='已点击'">点我</button>
<input id="q" placeholder="输入框" style="position:absolute;left:40px;top:260px;width:300px;height:40px;font-size:18px" oninput="document.title='输入:'+this.value">
<div style="height:2400px;background:linear-gradient(#fff,#dbe6f5)"></div><h2 id="end">页面底部</h2></body></html>`);
});
await new Promise((r) => pageServer.listen(PAGE_PORT, "127.0.0.1", r));
const PAGE = `http://127.0.0.1:${PAGE_PORT}/`;

const server = await startServer({ port: 8841, env: { WORKROOM_URL_ALLOWLIST: `127.0.0.1:${PAGE_PORT}` } });
const base = server.base;
const browser = await chromium.launch();
const T = (id) => `[data-testid="${id}"]`;
const shot = (page, name) => page.screenshot({ path: join(DIR, `${name}.png`), fullPage: false });
const waitIdle = (page) => page.waitForSelector(T("stop"), { state: "detached", timeout: 60000 });

/** browser_open is an on-demand tool (round 16): load it with tool_search first, then open the page; waits until both turns settled. */
async function openBrowser(page) {
	await sendMessage(page, `[[call tool_search {"query":"实时浏览器 打开页面"}]]`);
	await page.waitForURL(/\/c\//);
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="assistant-message"]').length >= 1, null, { timeout: 30000 });
	await waitIdle(page);
	await sendMessage(page, `[[call browser_open {"url":"${PAGE}"}]]`);
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="assistant-message"]').length >= 2, null, { timeout: 30000 });
	await waitIdle(page);
}

try {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "zh-CN" });
	const page = await ctx.newPage();
	await register(page, base, { email: "bexp@example.com", name: "放大" });
	await openBrowser(page);
	await page.click(T("open-work-panel"));
	await page.waitForSelector(T("browser-entry"), { timeout: 20000 });
	const expand = page.locator(`${T("browser-entry")} ${T("browser-expand")}`);
	check("放大 button on the browser entry with aria-label / title 放大", (await expand.count()) === 1 && (await expand.getAttribute("aria-label")) === "放大" && (await expand.getAttribute("title")) === "放大");
	check("放大 is not inside the row's toggle button (no nested buttons)", (await page.locator(`${T("browser-entry")} button button`).count()) === 0);
	await shot(page, "browser-expand-1-panel-button");

	// clicking 放大 must not toggle the row
	await expand.click();
	const modal = page.locator(T("browser-modal"));
	await modal.waitFor({ timeout: 10000 });
	check("clicking 放大 opens the dialog and leaves the row collapsed", (await page.locator(`${T("browser-entry")} > button`).getAttribute("aria-expanded")) === "false");
	await page.waitForSelector(`${T("browser-modal")} ${T("browser-screenshot")}`);
	await page.waitForFunction(() => { const i = document.querySelector('[data-testid="browser-modal"] [data-testid="browser-screenshot"]'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 15000 });
	const box = await modal.boundingBox();
	const vp = page.viewportSize();
	check("dialog is large and centered", box.width > 900 && box.height > 600 && Math.abs(box.x + box.width / 2 - vp.width / 2) < 4 && Math.abs(box.y + box.height / 2 - vp.height / 2) < 4, JSON.stringify(box));
	const text = await modal.innerText();
	check("dialog shows title, URL and controller state", text.includes("测试页面") && text.includes(PAGE) && text.includes("助手操作中"), text.replace(/\s+/g, " ").slice(0, 120));
	check("dialog has 接管 for an editor", (await modal.locator(T("browser-takeover")).count()) === 1);
	await sleep(500); // let the fade-in finish
	await shot(page, "browser-expand-2-modal-agent");

	// Esc closes, focus returns to the button
	await page.keyboard.press("Escape");
	await modal.waitFor({ state: "detached", timeout: 5000 });
	check("Esc closes the dialog and focus returns to 放大", await expand.evaluate((el) => el === document.activeElement));
	check("the work panel stays open behind it", (await page.locator(T("work-panel")).count()) === 1);

	// take over in the dialog
	await expand.click();
	await modal.waitFor();
	await modal.locator(T("browser-takeover")).click();
	await page.waitForSelector(`${T("browser-modal")} ${T("browser-session")}[data-controller="user"]`, { timeout: 10000 });
	check("takeover inside the dialog: shows 你在操作 and 交还给助手", (await modal.innerText()).includes("你在操作") && (await modal.locator(T("browser-release")).count()) === 1);
	const img = modal.locator(T("browser-screenshot"));
	const ib = await img.boundingBox();
	// the page is letterboxed (object-contain): locate the 点我 button (page ≈ (86, 176)) the way a user would, from the shown image
	const scale = Math.min(ib.width / 1280, ib.height / 800);
	const ox = ib.x + (ib.width - 1280 * scale) / 2, oy = ib.y + (ib.height - 800 * scale) / 2;
	await page.mouse.click(ox + 86 * scale, oy + 176 * scale);
	await page.waitForFunction(() => document.querySelector('[data-testid="browser-modal"]')?.textContent?.includes("点击"), null, { timeout: 15000 }).catch(() => {});
	await page.waitForFunction(() => document.querySelector('[data-testid="browser-modal"] [data-testid="browser-modal-title"]')?.textContent === "已点击", null, { timeout: 15000 }).catch(() => {});
	check("a click on the enlarged screenshot reaches the page (title 已点击, 上一步 mentions the click)", (await modal.locator(T("browser-modal-title")).innerText()) === "已点击" && (await modal.innerText()).includes("点击"), (await modal.locator(T("browser-modal-title")).innerText()));

	// scroll with the wheel
	await page.mouse.move(ox + 640 * scale, oy + 400 * scale);
	await page.mouse.wheel(0, 600);
	await page.waitForFunction(() => document.querySelector('[data-testid="browser-modal"]')?.textContent?.includes("用户：滚动"), null, { timeout: 15000 }).catch(() => {});
	const afterScroll = await modal.innerText();
	check("wheel over the screenshot scrolls the page (上一步 滚动)", /滚动 \d+/.test(afterScroll), afterScroll.replace(/\s+/g, " ").slice(-120));
	check("the dialog itself did not scroll the page behind it", (await page.evaluate(() => document.scrollingElement.scrollTop)) === 0);

	// scroll back to the top (also exercises the negative direction), then type into the page: click the input (page ≈ (190, 280)), then type via the form
	await page.mouse.wheel(0, -2000);
	await page.waitForFunction(() => /滚动 -\d+/.test(document.querySelector('[data-testid="browser-modal"]')?.textContent ?? ""), null, { timeout: 15000 });
	await page.mouse.click(ox + 190 * scale, oy + 280 * scale);
	await page.waitForFunction(() => /点击 \(\d+, 2[6-9]\d\)/.test(document.querySelector('[data-testid="browser-modal"]')?.textContent ?? ""), null, { timeout: 10000 });
	await modal.locator(`${T("browser-type-form")} input`).fill("你好");
	await modal.locator(`${T("browser-type-form")} button[type=submit]`).click();
	await page.waitForFunction(() => document.querySelector('[data-testid="browser-modal"] [data-testid="browser-modal-title"]')?.textContent?.startsWith("输入:"), null, { timeout: 15000 }).catch(() => {});
	check("typing in the dialog reaches the focused page input", (await modal.locator(T("browser-modal-title")).innerText()) === "输入:你好", await modal.locator(T("browser-modal-title")).innerText());
	await shot(page, "browser-expand-3-modal-takeover");

	await modal.locator(T("browser-release")).click();
	await page.waitForSelector(`${T("browser-modal")} ${T("browser-session")}[data-controller="agent"]`, { timeout: 10000 });
	check("交还给助手 inside the dialog returns control", (await modal.innerText()).includes("助手操作中"));
	await modal.locator(T("browser-modal-close")).click();
	await modal.waitFor({ state: "detached" });

	// viewer: read-only
	const code = (await (await page.request.post(`${base}/api/admin/invites`, { data: { role: "member", ttlHours: 24 } })).json()).invite.code;
	const viewerCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "zh-CN" });
	const vpage = await viewerCtx.newPage();
	await vpage.goto(`${base}/register?invite=${code}`);
	await vpage.fill("#name", "只读");
	await vpage.fill("#email", "bexp-viewer@example.com");
	await vpage.fill("#password", "password123");
	await vpage.click('button[type="submit"]');
	await vpage.waitForSelector(T("home-greeting"));
	const proj = (await (await page.request.post(`${base}/api/projects`, { data: { kind: "space", name: "放大" } })).json()).project;
	await page.request.put(`${base}/api/projects/${proj.id}/members`, { data: { email: "bexp-viewer@example.com", role: "viewer" } });
	await page.goto(`${base}/projects/${proj.id}`);
	await openBrowser(page);
	await vpage.goto(page.url());
	await vpage.click(T("open-work-panel"));
	await vpage.waitForSelector(T("browser-expand"), { timeout: 20000 });
	await vpage.click(T("browser-expand"));
	const vmodal = vpage.locator(T("browser-modal"));
	await vmodal.waitFor();
	await vpage.waitForSelector(`${T("browser-modal")} ${T("browser-screenshot")}`);
	await sleep(600);
	const vt = await vmodal.innerText();
	check("viewer: dialog is read-only (只能观看, no 接管, no input)", vt.includes("只能观看") && (await vmodal.locator(T("browser-takeover")).count()) === 0 && (await vmodal.locator("input").count()) === 0, vt.replace(/\s+/g, " ").slice(0, 100));
	await sleep(300);
	await shot(vpage, "browser-expand-4-modal-viewer");
} finally {
	await browser.close();
	await server.stop();
	pageServer.close();
}
process.exit(summary(join(DIR, "browser-expand.json")) ? 0 : 1);
