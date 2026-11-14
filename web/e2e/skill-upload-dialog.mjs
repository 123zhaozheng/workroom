// 我的技能: the big upload area is gone; 上传技能 is a toolbar button that opens a small dialog (pick / drop .zip or pick a folder →
// file name + size + validation → 上传 → closes and reloads the list; errors stay in the dialog; Esc / 取消 close it). 390 px has no overflow.
// Run: npm run -s -w web build && node web/e2e/skill-upload-dialog.mjs   (port 8908; SHOTS_DIR overrides the screenshot folder)
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { check, chromium, register, ROOT, sleep, startServer, summary, SHOTS } from "./lib.mjs";

const require = createRequire(import.meta.url);
const { zipSync, strToU8 } = await import(join(ROOT, "node_modules/fflate/esm/browser.js")).catch(() => require(join(ROOT, "node_modules/fflate")));
const DIR = process.env.SHOTS_DIR || join(SHOTS, "skill-upload");
mkdirSync(DIR, { recursive: true });
const server = await startServer({ port: 8908 });
const base = server.base;
const browser = await chromium.launch();
const T = (id) => `[data-testid="${id}"]`;
const md = (name) => `---\nname: ${name}\ndescription: 把本周的工作整理成周报。当用户要求写周报时使用。\nversion: 1.0.0\n---\n\n# ${name}\n\n按三段写。\n`;
const zip = (files) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));

try {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "zh-CN" });
	const page = await ctx.newPage();
	await register(page, base, { email: "up@example.com", name: "上传" });
	await page.goto(`${base}/capabilities`);
	await page.waitForSelector(T("skill-upload"));
	const shot = async (name) => (await sleep(400), page.screenshot({ path: join(DIR, `skill-upload-${name}.png`) }));
	const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

	// ---- the page: no big upload area, a toolbar button next to 新建技能
	check("page: no big drop area or upload panel on the page", (await page.locator(T("upload-panel")).count()) === 0 && (await page.locator(T("dropzone")).count()) === 0 && !(await page.locator("body").innerText()).includes("拖到这里"));
	const bt = await page.evaluate(() => { const u = document.querySelector('[data-testid="skill-upload"]').getBoundingClientRect(); const n = document.querySelector('[data-testid="skill-new"]').getBoundingClientRect(); return { sameRow: Math.abs(u.top - n.top) < 4, left: u.right <= n.left }; });
	check("toolbar: 上传技能 sits on the same row, before 新建技能", bt.sameRow && bt.left, JSON.stringify(bt));
	await shot("1-toolbar-light");

	// ---- open: small dialog, Esc closes, 取消 closes
	await page.click(T("skill-upload"));
	await page.waitForSelector(T("upload-dialog"));
	const box = await page.locator(T("upload-dialog")).boundingBox();
	check("dialog: small (≤ 448px wide, ≤ 420px tall), centred", box.width <= 449 && box.height <= 420 && Math.abs(box.x + box.width / 2 - 720) < 2, JSON.stringify(box));
	check("dialog: submit is disabled until a file is chosen", await page.locator(T("upload-submit")).isDisabled());
	await shot("2-dialog-empty-light");
	await page.keyboard.press("Escape");
	await page.waitForSelector(T("upload-dialog"), { state: "detached" });
	await sleep(200);
	const act = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName);
	check("dialog: Esc closes it and focus returns to the button", act === "skill-upload", String(act));
	await page.click(T("skill-upload"));
	await page.waitForSelector(T("upload-dialog"));
	await page.click(T("upload-cancel"));
	await page.waitForSelector(T("upload-dialog"), { state: "detached" });
	check("dialog: 取消 closes it", true);

	// ---- validation: wrong type
	await page.click(T("skill-upload"));
	await page.setInputFiles(T("upload-zip-input"), { name: "readme.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
	check("validate: a non-.zip file is refused with a reason, nothing is picked", (await page.locator(T("upload-problem")).innerText()).includes("只支持 .zip") && (await page.locator(T("upload-picked")).count()) === 0 && (await page.locator(T("upload-submit")).isDisabled()));

	// ---- pick a zip: name + size shown, then upload with a slow response to see the busy state
	const good = zip({ "SKILL.md": md("weekly-report") });
	await page.setInputFiles(T("upload-zip-input"), { name: "weekly-report.zip", mimeType: "application/zip", buffer: good });
	const pk = await page.locator(T("upload-picked")).innerText();
	check("pick: file name and size are shown, the earlier problem is cleared", pk.includes("weekly-report.zip") && /\d/.test(pk) && (await page.locator(T("upload-problem")).count()) === 0 && (await page.locator(T("upload-submit")).isEnabled()), pk.replace(/\n/g, " "));
	await shot("3-dialog-picked-light");
	let release;
	const gate = new Promise((r) => (release = r));
	await page.route("**/api/market/skills/upload", async (route) => (await gate, route.continue()));
	await page.click(T("upload-submit"));
	await page.waitForSelector(T("upload-busy"));
	check("busy: shows 正在上传并检查…, buttons are disabled, Esc does not dismiss it", (await page.locator(T("upload-submit")).isDisabled()) && (await page.locator(T("upload-cancel")).isDisabled()) && (await (async () => { await page.keyboard.press("Escape"); await sleep(250); return page.locator(T("upload-dialog")).count(); })()) === 1);
	await shot("4-dialog-busy-light");
	release();
	await page.waitForSelector(T("upload-dialog"), { state: "detached" });
	await page.unroute("**/api/market/skills/upload");
	await page.waitForSelector(T("upload-result"));
	check("success: the dialog closes, the list shows the new skill and the outcome line", (await page.locator(T("skill")).count()) === 1 && (await page.locator(T("upload-result")).innerText()).includes("已上传「weekly-report」v1"));
	await shot("5-after-upload-light");

	// ---- server rejection stays in the dialog (zip-slip), a retry with a good file works
	await page.click(T("skill-upload"));
	await page.setInputFiles(T("upload-zip-input"), { name: "evil.zip", mimeType: "application/zip", buffer: zip({ "SKILL.md": md("evil"), "../escape.sh": "echo pwned" }) });
	await page.click(T("upload-submit"));
	await page.waitForSelector(T("upload-error"));
	check("error: a rejected package keeps the dialog open and shows the reason", (await page.locator(T("upload-error")).innerText()).includes("zip-slip") && (await page.locator(T("upload-dialog")).count()) === 1 && (await page.locator(T("upload-submit")).isEnabled()));
	await shot("6-dialog-error-light");
	check("error: no horizontal overflow of the dialog", await page.evaluate(() => { const d = document.querySelector('[data-testid="upload-dialog"]'); return d.scrollWidth <= d.clientWidth; }));

	// ---- folder pick (JSON path)
	const dir = mkdtempSync(join(tmpdir(), "skill-"));
	mkdirSync(join(dir, "folder-skill"));
	writeFileSync(join(dir, "folder-skill", "SKILL.md"), md("folder-skill"));
	await page.setInputFiles(T("upload-folder-input"), join(dir, "folder-skill"));
	check("folder: picking a folder replaces the error and shows it", (await page.locator(T("upload-error")).count()) === 0 && (await page.locator(T("upload-picked")).innerText()).includes("1 个文件"));
	await page.click(T("upload-submit"));
	await page.waitForSelector(T("upload-dialog"), { state: "detached", timeout: 8000 }).catch(async () => console.log("FOLDER DIALOG:", await page.locator(T("upload-dialog")).innerText()));
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="skill"]').length === 2);
	check("folder: uploaded, now two skills", (await page.locator(T("skill")).count()) === 2);

	// ---- drag and drop inside the dialog
	await page.click(T("skill-upload"));
	await page.evaluate(async (b64) => {
		const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		const dt = new DataTransfer();
		dt.items.add(new File([bytes], "dropped.zip", { type: "application/zip" }));
		document.querySelector('[data-testid="dropzone"]').dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
	}, zip({ "SKILL.md": md("dropped-skill") }).toString("base64"));
	check("drop: a dropped .zip is picked (not uploaded until 上传)", (await page.locator(T("upload-picked")).innerText()).includes("dropped.zip") && (await page.locator(T("skill")).count()) === 2);
	await page.click(T("upload-clear"));
	check("pick: the × clears the choice", (await page.locator(T("upload-picked")).count()) === 0 && (await page.locator(T("upload-submit")).isDisabled()));
	await page.keyboard.press("Escape");

	// ---- the market no longer has an upload area either
	await page.goto(`${base}/capabilities?tab=market`);
	await page.waitForSelector(T("tab-market"));
	check("market tab: no upload area", (await page.locator(T("dropzone")).count()) === 0);

	// ---- dark theme
	await page.goto(`${base}/capabilities`);
	await page.waitForSelector(T("skill-upload"));
	await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
	await page.click(T("skill-upload"));
	await page.setInputFiles(T("upload-zip-input"), { name: "weekly-report-v2.zip", mimeType: "application/zip", buffer: good });
	await sleep(250);
	await shot("7-dialog-picked-dark");
	await page.setInputFiles(T("upload-zip-input"), { name: "readme.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
	await sleep(150);
	await shot("8-dialog-problem-dark");
	await page.keyboard.press("Escape");
	await shot("9-toolbar-dark");

	// ---- mobile 390
	await page.setViewportSize({ width: 390, height: 844 });
	await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
	await sleep(250);
	check("390: toolbar has no horizontal overflow", (await overflow()) <= 0, String(await overflow()));
	await shot("10-toolbar-390");
	await page.click(T("skill-upload"));
	await page.setInputFiles(T("upload-zip-input"), { name: "一个名字特别特别长的技能包文件名称用来检查省略号是否生效-weekly-report-final-v2.zip", mimeType: "application/zip", buffer: good });
	await sleep(250);
	const m = await page.evaluate(() => { const d = document.querySelector('[data-testid="upload-dialog"]').getBoundingClientRect(); return { l: d.left, r: d.right, w: innerWidth, over: document.documentElement.scrollWidth - document.documentElement.clientWidth }; });
	check("390: dialog fits the screen with a long file name, no overflow", m.l >= 0 && m.r <= m.w && m.over <= 0, JSON.stringify(m));
	await shot("11-dialog-390");
} catch (e) {
	console.error(e);
	process.exitCode = 1;
} finally {
	await browser.close();
	await server.stop();
}
const ok = summary();
process.exit(ok && !process.exitCode ? 0 : 1);
