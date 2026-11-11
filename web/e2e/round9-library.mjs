// Round 9 · U2: 文件库 / 知识库 layout — app sidebar · resource list · detail / preview panel on desktop, list → detail pages on phones.
// Run: npm run build:web && node web/e2e/round9-library.mjs        (port 8922)
import { join } from "node:path";
import { check, chromium, register, ROOT, SHOTS, sleep, startServer, summary } from "./lib.mjs";

const PORT = 8922;
const server = await startServer({ port: PORT });
const base = server.base;
const browser = await chromium.launch();
const shotDir = join(SHOTS, "round9");
const snap = async (page, name) => page.screenshot({ path: join(shotDir, `u2-${name}.png`) });
const overflowX = (p) => p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
const box = (p, sel) => p.locator(sel).first().boundingBox();

const MD = { name: "季度计划.md", mimeType: "text/markdown", buffer: Buffer.from("# 季度计划\n\n本季度重点：交付周报自动化。\n") };
// a 2x2 PNG
const PNG = { name: "chart.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP4z8Dwn+E/AwMDA8N/BgAV/QX+HOGnKwAAAABJRU5ErkJggg==", "base64") };

let ok = false;
let dbgPage;
try {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	const page = await ctx.newPage();
	dbgPage = page;
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await register(page, base, { email: "lib@r9.example", name: "资料员" });
	const meJson = await (await ctx.request.get(`${base}/api/me`)).json();

	// ================================================================ 文件库: empty state
	await page.goto(`${base}/files`);
	await page.waitForSelector('[data-testid="files-empty"]');
	check("files 1440: three columns — the app sidebar, the file list and the detail panel", (await page.locator('[data-testid="sidebar"]').isVisible()) && (await page.locator('[data-testid="split-list"]').isVisible()) && (await page.locator('[data-testid="split-detail"]').isVisible()));
	const bl = await box(page, '[data-testid="split-list"]');
	const bd = await box(page, '[data-testid="split-detail"]');
	check("files 1440: the list column is 300–380px and the detail panel takes the rest", bl.width >= 299 && bl.width <= 381 && bd.width > 700, `${Math.round(bl.width)} / ${Math.round(bd.width)}`);
	check("files: empty state is one line plus the primary action 上传文件", (await page.locator('[data-testid="files-empty"]').innerText()).replace(/\s+/g, " ").trim() === "文件库还是空的 上传文件");
	check("files: the empty-state action is a primary button", /bg-accent/.test((await page.locator('[data-testid="files-empty"] button').getAttribute("class")) ?? ""));
	await snap(page, "library-files-empty-1440");

	// upload from the empty state (file chooser)
	const chooser = page.waitForEvent("filechooser");
	await page.locator('[data-testid="files-empty"] button').click();
	await (await chooser).setFiles([MD]);
	await page.waitForSelector('[data-testid="file-row"]', { timeout: 10000 });
	check("files: uploading from the empty state works (the file appears in the list)", (await page.locator('[data-testid="file-row"]').count()) === 1 && (await page.locator('[data-testid="file-row"]').innerText()).includes("季度计划.md"));
	// and from the header button / input
	await page.setInputFiles('[data-testid="files-input"]', [PNG]);
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="file-row"]').length === 2, null, { timeout: 10000 });
	check("files: a second upload through the header input adds a row", (await page.locator('[data-testid="file-row"]').count()) === 2);
	check("files: with nothing selected the detail panel says so in one line", (await page.locator('[data-testid="files-no-selection"]').innerText()).replace(/\s+/g, " ").trim() === "选择一个文件查看预览");

	// ================================================================ select → preview panel
	const mdRow = page.locator('[data-testid="file-row"]', { hasText: "季度计划.md" });
	await mdRow.locator("a").click();
	await page.waitForSelector('[data-testid="file-title"]');
	const mdUrl = page.url();
	const mdId = mdUrl.split("/files/")[1].split("?")[0];
	check("files: clicking a row opens it in the detail panel (URL /files/:id) and keeps the list", /\/files\/.+/.test(mdUrl) && (await page.locator('[data-testid="file-row"]').count()) === 2);
	check("files: the selected row is marked (aria-current=page)", (await mdRow.locator("a").getAttribute("aria-current")) === "page" && (await mdRow.getAttribute("data-selected")) === "true");
	await page.waitForSelector('[data-testid="file-preview"] >> text=本季度重点', { timeout: 10000 });
	check("files: the markdown preview renders in the panel", true);
	check("files: versions, storage state and knowledge state sit in the same panel", (await page.locator('[data-testid="version-item"]').count()) === 1 && /存储：已保存/.test(await page.locator('[data-testid="split-detail"]').innerText()) && /知识库：\s*未加入/.test(await page.locator('[data-testid="split-detail"]').innerText()));
	const prev = await box(page, '[data-testid="file-preview"]');
	check("files: the preview sits inside the detail panel, no horizontal scroll", prev.x >= bd.x - 1 && prev.x + prev.width <= bd.x + bd.width + 1 && !(await overflowX(page)));
	await sleep(500);
	await snap(page, "library-files-detail-1440");
	const pngRow = page.locator('[data-testid="file-row"]', { hasText: "chart.png" });
	await pngRow.locator("a").click();
	await page.waitForSelector('[data-testid="preview-image"]', { timeout: 10000 });
	check("files: selecting another file switches the panel (image preview) without reloading the list", (await pngRow.getAttribute("data-selected")) === "true" && (await mdRow.getAttribute("data-selected")) === null);
	await page.hover('[data-testid="file-row"]:has-text("季度计划.md")');
	await page.click('button[aria-label="预览 季度计划.md"]');
	await page.waitForFunction((id) => location.pathname === `/files/${id}`, mdId);
	check("files: the 预览 button of a row opens it in the panel on desktop", true);

	// ---- search / filter keep working in the list column
	await page.fill('input[aria-label="搜索文件名"]', "chart");
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="file-row"]').length === 1);
	check("files: the name search filters the list and the open file stays open", (await page.locator('[data-testid="file-row"]').innerText()).includes("chart.png") && page.url().includes(mdId));
	await page.fill('input[aria-label="搜索文件名"]', "不存在的文件");
	await page.waitForSelector('[data-testid="files-empty"]');
	check("files: no match → one line + 清除筛选", (await page.locator('[data-testid="files-empty"]').innerText()).replace(/\s+/g, " ").trim() === "没有匹配的文件 清除筛选");
	await page.click('[data-testid="files-empty"] button');
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="file-row"]').length === 2);
	check("files: 清除筛选 restores the list", (await page.inputValue('input[aria-label="搜索文件名"]')) === "");
	await page.click('[data-wr-select][aria-label="来源"]');
	await page.locator('[role="option"][data-label="助手生成"]').click();
	await page.waitForSelector('[data-testid="files-empty"]');
	check("files: the 来源 filter works (no agent files yet)", true);
	await page.click('[data-testid="files-empty"] button');
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="file-row"]').length === 2);

	// ---- detail actions still there: share dialog, new version
	await page.locator('[data-testid="file-row"]', { hasText: "季度计划.md" }).locator("a").click();
	await page.waitForSelector('[data-testid="file-title"]');
	await page.getByRole("button", { name: "分享" }).click();
	await page.waitForSelector('[role="dialog"]');
	check("files: 分享 opens the share dialog from the panel", true);
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "上传新版本" }).click();
	await page.setInputFiles('[role="dialog"] input[type="file"]', { name: "季度计划.md", mimeType: "text/markdown", buffer: Buffer.from("# 季度计划 v2\n\n新增：知识库联动。\n") });
	await page.fill("#note", "补充知识库");
	await page.getByRole("button", { name: "保存为新版本" }).click();
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="version-item"]').length === 2, null, { timeout: 10000 });
	check("files: uploading a new version works from the panel (two versions, v2 selected via ?v=)", page.url().includes("v=") && (await page.locator('[data-testid="version-item"]').count()) === 2);
	await page.waitForSelector('[data-testid="file-preview"] >> text=知识库联动', { timeout: 10000 });
	check("files: the panel previews the new version", true);
	check("files: the library's list row shows v2", (await page.locator('[data-testid="file-row"]', { hasText: "季度计划.md" }).innerText()).includes("v2"));
	// add to knowledge dialog is reachable
	await page.getByRole("button", { name: "加入知识库" }).click();
	await page.waitForSelector('[role="dialog"]');
	check("files: 加入知识库 opens from the panel", (await page.locator('[role="dialog"]').innerText()).includes("加入知识库"));
	await page.keyboard.press("Escape");

	// ---- close + deep link
	await page.click('[data-testid="file-detail-close"]');
	await page.waitForSelector('[data-testid="files-no-selection"]');
	check("files: the × on the panel goes back to /files and the placeholder", new URL(page.url()).pathname === "/files");
	await page.goto(`${base}/files/${mdId}`);
	await page.waitForSelector('[data-testid="file-title"]');
	await page.waitForSelector('[data-testid="file-row"]');
	check("files: a deep link /files/:id opens the list and the panel together", (await page.locator('[data-testid="file-row"][data-selected="true"]').count()) === 1 && (await page.locator('[data-testid="file-title"]').innerText()) === "季度计划.md");
	check("files: the top bar never overlaps the panel content", await page.evaluate(() => (document.querySelector("main header")?.getBoundingClientRect().bottom ?? 0) <= (document.querySelector('[data-testid="file-title"]')?.getBoundingClientRect().top ?? 1e9)));

	// ---- permissions: someone else cannot open this file by its link
	const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	const pb = await ctxB.newPage();
	await register(pb, base, { email: "other-lib@r9.example", name: "路人" });
	await pb.goto(`${base}/files/${mdId}`);
	await pb.waitForSelector('[data-testid="split-detail"]');
	await sleep(1200);
	const bTxt = await pb.locator('[data-testid="split-detail"]').innerText();
	check("files: another user opening the deep link gets an error state, never the file", !bTxt.includes("季度计划") && /加载失败|无法使用|没有权限|不存在/.test(bTxt), bTxt.replace(/\s+/g, " ").slice(0, 100));
	check("files: and their own library is empty (no leak into the list)", (await pb.locator('[data-testid="file-row"]').count()) === 0);
	await ctxB.close();

	// ================================================================ 知识库
	await page.goto(`${base}/knowledge`);
	await page.waitForSelector('[data-testid="kb-empty"]');
	check("kb 1440: list column + detail panel (nothing to pick yet, so no placeholder)", (await page.locator('[data-testid="split-list"]').isVisible()) && (await page.locator('[data-testid="split-detail"]').isVisible()) && (await page.locator('[data-testid="kb-no-selection"]').count()) === 0);
	check("kb: empty state is one line plus the primary action 新建知识库", (await page.locator('[data-testid="kb-empty"]').innerText()).replace(/\s+/g, " ").trim() === "还没有知识库 新建知识库" && /bg-accent/.test((await page.locator('[data-testid="kb-empty"] button').getAttribute("class")) ?? ""));
	await snap(page, "library-kb-empty-1440");
	await page.locator('[data-testid="kb-empty"] button').click();
	await page.fill("#kbname", "产品资料");
	await page.getByRole("button", { name: "创建" }).click();
	await page.waitForURL(/\/knowledge\/.+/);
	const kb1 = page.url().split("/knowledge/")[1];
	await page.waitForSelector('[data-testid="kb-docs-empty"]');
	await page.waitForSelector('[data-testid="kb-card"][aria-current="page"]');
	check("kb: creating a base opens it in the panel and lists it on the left (selected)", (await page.locator('[data-testid="kb-card"][aria-current="page"]').count()) === 1 && (await page.locator('[data-testid="kb-card"]').innerText()).includes("产品资料"));
	check("kb: an empty base says so in one line with the primary action 上传资料", (await page.locator('[data-testid="kb-docs-empty"]').innerText()).replace(/\s+/g, " ").trim() === "这个知识库还没有资料 上传资料" && /bg-accent/.test((await page.locator('[data-testid="kb-docs-empty"] button').getAttribute("class")) ?? ""));
	await snap(page, "library-kb-detail-empty-1440");
	await page.setInputFiles('[data-testid="kb-upload-input"]', [{ name: "报销制度.md", mimeType: "text/markdown", buffer: Buffer.from("# 报销制度\n\n差旅报销需在 30 天内提交，附发票原件。\n") }]);
	await page.waitForSelector('[data-testid="kb-doc"]', { timeout: 15000 });
	check("kb: uploading a document works and it shows its processing state", true);
	await page.waitForSelector('[data-testid="kb-doc"][data-availability="ready"], [data-testid="kb-doc"][data-availability="failed"]', { timeout: 30000 });
	check("kb: the document becomes 可检索", (await page.locator('[data-testid="kb-doc"]').first().getAttribute("data-availability")) === "ready");
	await page.waitForFunction(() => document.querySelector('[data-testid="kb-card"]')?.textContent?.includes("1 可检索"), null, { timeout: 15000 });
	check("kb: the count on the left follows (1 可检索)", true);
	await page.locator('[data-testid="kb-doc"] button').first().click();
	await page.waitForSelector('[data-testid="preview-dialog"]');
	await page.waitForSelector('[data-testid="preview-dialog"] >> text=差旅报销', { timeout: 10000 });
	check("kb: a document previews in a dialog over the two columns (same preview panel as everywhere)", (await page.locator('[data-testid="preview-panel"]').count()) === 1 && (await page.locator('[data-testid="split-list"]').isVisible()));
	await snap(page, "library-kb-preview-1440");
	await page.keyboard.press("Escape");
	await page.waitForSelector('[data-testid="preview-dialog"]', { state: "detached" });
	check("kb: Escape closes the preview", true);
	check("kb: 检索测试 and the governance controls are still in the panel", (await page.getByText("检索测试").count()) > 0 && (await page.locator('[data-testid="gov-edit"]').count()) === 1);
	// second base + switching + search
	await page.click('[data-testid="split-list"] >> text=新建知识库');
	await page.fill("#kbname", "人事制度");
	await page.getByRole("button", { name: "创建" }).click();
	await page.waitForFunction((k) => !location.pathname.endsWith(k) && /\/knowledge\/.+/.test(location.pathname), kb1);
	await page.waitForSelector('[data-testid="kb-docs-empty"]');
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="kb-card"]').length === 2);
	check("kb: two bases listed, the new one selected", (await page.locator('[data-testid="kb-card"]').count()) === 2 && (await page.locator('[data-testid="kb-card"][aria-current="page"]').innerText()).includes("人事制度"));
	await page.fill('input[aria-label="搜索知识库"]', "产品");
	check("kb: the list search narrows to matching bases", (await page.locator('[data-testid="kb-card"]').count()) === 1 && (await page.locator('[data-testid="kb-card"]').innerText()).includes("产品资料"));
	await page.locator('[data-testid="kb-card"]').click();
	await page.waitForURL(new RegExp(`/knowledge/${kb1}$`));
	await page.waitForSelector('[data-testid="kb-doc"]');
	check("kb: opening another base replaces the panel (its document is shown)", (await page.locator('[data-testid="kb-doc"]').first().innerText()).includes("报销制度.md"));
	await page.fill('input[aria-label="搜索知识库"]', "");
	await page.goto(`${base}/knowledge/${kb1}`);
	await page.waitForSelector('[data-testid="kb-doc"]');
	check("kb: a deep link /knowledge/:id opens list and panel together", (await page.locator('[data-testid="kb-card"]').count()) === 2 && (await page.locator('[data-testid="kb-card"][aria-current="page"]').count()) === 1);
	check("kb: no horizontal scroll at 1440", !(await overflowX(page)));
	await sleep(300);
	await snap(page, "library-kb-detail-1440");

	await page.goto(`${base}/knowledge`);
	await page.waitForSelector('[data-testid="kb-card"]');
	check("kb: with bases but none open the panel invites a pick in one line", (await page.locator('[data-testid="kb-no-selection"]').innerText()).replace(/\s+/g, " ").trim() === "选择一个知识库查看资料");
	// ---- 1366
	await page.setViewportSize({ width: 1366, height: 768 });
	await page.goto(`${base}/files/${mdId}`);
	await page.waitForSelector('[data-testid="file-title"]');
	check("files 1366: both columns visible, no horizontal scroll", (await page.locator('[data-testid="split-list"]').isVisible()) && !(await overflowX(page)));
	await snap(page, "library-files-detail-1366");
	// ---- dark
	await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
	await sleep(300);
	await snap(page, "library-files-detail-dark-1366");
	await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

	// ================================================================ 390 phone: list → detail
	const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN", isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
	const pm = await ctxM.newPage();
	await pm.goto(`${base}/files`);
	await pm.waitForSelector('[data-testid="file-row"]');
	check("files 390: a list page — no split layout, no horizontal scroll", (await pm.locator('[data-testid="split-layout"]').count()) === 0 && !(await overflowX(pm)));
	await snap(pm, "library-files-list-390");
	await pm.locator('[data-testid="file-row"]', { hasText: "季度计划.md" }).locator("a").tap();
	await pm.waitForSelector('[data-testid="version-item"]');
	check("files 390: tapping a row opens the file as its own page with a way back", /\/files\/.+/.test(pm.url()) && (await pm.locator('main header a[href="/files"]').isVisible()) && (await pm.locator('[data-testid="split-layout"]').count()) === 0 && !(await overflowX(pm)));
	await pm.waitForSelector('[data-testid="file-preview"] >> text=知识库联动', { timeout: 10000 });
	await snap(pm, "library-files-detail-390");
	await pm.locator('main header a[href="/files"]').tap();
	await pm.waitForSelector('[data-testid="file-row"]');
	check("files 390: back returns to the list", new URL(pm.url()).pathname === "/files");
	await pm.locator('button[aria-label="预览 chart.png"]').tap();
	await pm.waitForSelector('[data-testid="preview-panel"]');
	check("files 390: the eye opens the shared preview sheet (as before)", (await pm.locator('[data-testid="sheet-right"]').count()) === 1);
	await pm.keyboard.press("Escape");
	await pm.goto(`${base}/knowledge`);
	await pm.waitForSelector('[data-testid="kb-card"]');
	check("kb 390: a card list page (no split layout), no horizontal scroll", (await pm.locator('[data-testid="split-layout"]').count()) === 0 && (await pm.locator('[data-testid="kb-card"]').count()) === 2 && !(await overflowX(pm)));
	await snap(pm, "library-kb-list-390");
	await pm.locator('[data-testid="kb-card"]', { hasText: "产品资料" }).tap();
	await pm.waitForSelector('[data-testid="kb-doc"]');
	check("kb 390: tapping a card opens the base as its own page", /\/knowledge\/.+/.test(pm.url()) && (await pm.locator('main header a[href="/knowledge"]').isVisible()) && !(await overflowX(pm)));
	await snap(pm, "library-kb-detail-390");
	await pm.locator('[data-testid="kb-doc"] button').first().tap();
	await pm.waitForSelector('[data-testid="preview-panel"]');
	check("kb 390: a document opens in the preview sheet (not the desktop dialog)", (await pm.locator('[data-testid="preview-dialog"]').count()) === 0 && (await pm.locator('[data-testid="sheet-right"]').count()) === 1);
	await ctxM.close();

	// empty library on the phone
	const ctxE = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN", isMobile: true, hasTouch: true });
	const pe = await ctxE.newPage();
	await register(pe, base, { email: "empty-lib@r9.example", name: "新人" });
	await pe.goto(`${base}/files`);
	await pe.waitForSelector('[data-testid="files-empty"]');
	check("files 390: empty state is the same one line + primary upload", (await pe.locator('[data-testid="files-empty"]').innerText()).replace(/\s+/g, " ").trim() === "文件库还是空的 上传文件" && !(await overflowX(pe)));
	await snap(pe, "library-files-empty-390");
	await pe.goto(`${base}/knowledge`);
	await pe.waitForSelector('[data-testid="kb-empty"]');
	check("kb 390: empty state is one line + primary 新建知识库", (await pe.locator('[data-testid="kb-empty"]').innerText()).replace(/\s+/g, " ").trim() === "还没有知识库 新建知识库" && !(await overflowX(pe)));
	await snap(pe, "library-kb-empty-390");
	await ctxE.close();

	check("no page errors", errors.length === 0, errors.join(" | "));
	ok = true;
} catch (e) {
	check("round9-library completed without an exception", false, String(e?.stack ?? e).slice(0, 800));
	await dbgPage?.screenshot({ path: join(shotDir, "u2-library-failure-debug.png") }).catch(() => {});
	console.log((await dbgPage?.locator("main").innerText().catch(() => "")) ?? "");
} finally {
	await browser.close();
	await server.stop();
}
const pass = summary(join(ROOT, "artifacts/round9-library-results.json"));
process.exit(pass && ok ? 0 : 1);
