// Round 5 — UI group 4: deliverable previews, work panel (files / terminal / tabs), files pages, shell and stats polish.
// Real server + fixture model ([[call …]] directives). Checks:
//  · every preview type renders without an error state; the 390 sheet opens/closes with Esc and the close button
//  · work panel tabs are keyboard reachable; workspace delete asks for confirmation and cancel keeps the file
//  · no implementation jargon in the visible text of these pages
//  · no horizontal scroll at 390 (home, chat, files, file detail, stats, work panel, preview sheet)
//  · reduced motion, dark mode, WCAG AA contrast of secondary text, opaque popovers
//  · mobile drawer: focus trap + Esc; header never overlaps content
// Run: npm run -w web build && node web/e2e/round5-g4.mjs
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { check, chromium, register, ROOT, SHOTS, sendMessage, sleep, startServer, summary } from "./lib.mjs";

// A pid-derived port keeps concurrent runs (several groups run the whole suite) from sharing a server and data dir.
const PORT = 8890 + (process.pid % 9);
const server = await startServer({ port: PORT });
const base = server.base;
const browser = await chromium.launch();
const d = (tool, args) => `[[call ${tool} ${JSON.stringify(args)}]]`;
const idle = (page, t = 90000) => page.waitForSelector('[data-testid="stop"]', { state: "detached", timeout: t });
const JARGON = /namespace|命名空间|driver|sandbox|沙箱|fixture|\bJSON\b|sha256|taskId|callId|requestId|\bDTO\b|\bSSE\b|pi-ai|pi-durable|provider|\bfv_|\bfile_[0-9a-z]{8}|file_(create|revise)|docs\/|D 组|A 组|GET \/|POST \//i;
const overflowX = (p) => p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1 || document.body.scrollWidth > window.innerWidth + 1);
const luminance = ([r, g, b]) => {
	const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
	return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
/** Worst contrast ratio of the visible text elements matched by `sel` against their effective background. */
const contrastOf = (page, sel) =>
	page.evaluate(
		({ sel }) => {
			const parse = (c) => (c.match(/[\d.]+/g) ?? []).map(Number);
			const lum = ([r, g, b]) => {
				const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
				return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
			};
			const bgOf = (el) => {
				let layers = [];
				for (let e = el; e; e = e.parentElement) {
					const c = parse(getComputedStyle(e).backgroundColor);
					if (c.length >= 3 && (c[3] ?? 1) > 0) layers.push(c);
					if (c.length >= 3 && (c[3] ?? 1) === 1) break;
				}
				let [r, g, b] = [255, 255, 255];
				if (!layers.length || (layers.at(-1)[3] ?? 1) < 1) [r, g, b] = parse(getComputedStyle(document.body).backgroundColor);
				for (const l of layers.reverse()) {
					const a = l[3] ?? 1;
					r = l[0] * a + r * (1 - a);
					g = l[1] * a + g * (1 - a);
					b = l[2] * a + b * (1 - a);
				}
				return [r, g, b];
			};
			let worst = 21;
			let n = 0;
			for (const el of document.querySelectorAll(sel)) {
				if (!el.textContent?.trim() || !el.getClientRects().length) continue;
				const fg = parse(getComputedStyle(el).color);
				const bg = bgOf(el);
				const a = fg[3] ?? 1;
				const mixed = [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
				const [l1, l2] = [lum(mixed), lum(bg)].sort((x, y) => y - x);
				worst = Math.min(worst, (l1 + 0.05) / (l2 + 0.05));
				n++;
			}
			return { worst: Math.round(worst * 100) / 100, n };
		},
		{ sel },
	);

let page0;
try {
	// ------------------------------------------------------------------ setup: deliverables + workspace files
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "zh-CN" });
	const a = await ctx.newPage();
	page0 = a;
	const email = `g4-${Date.now()}@example.com`;
	await register(a, base, { email, name: "林夏" });
	const md = "# 本周进展\n- 完成需求评审\n- 完成原型\n\n| 事项 | 负责人 |\n|---|---|\n| 需求评审 | 王明 |";
	await sendMessage(
		a,
		"生成成果 " +
			[
				d("file_create", { name: "项目周报", format: "md", title: "项目周报", content: md }),
				d("file_create", { name: "合同意见", format: "docx", title: "合同意见", content: "# 总体意见\n建议修改第 3 条付款节点。\n\n| 条款 | 建议 |\n|---|---|\n| 第 3 条 | 调整付款节点 |" }),
				d("file_create", { name: "销售汇总", format: "xlsx", sheets: [{ name: "销售", columns: ["月份", "收入"], rows: [["1月", 120], ["2月", 150]] }] }),
				d("file_create", { name: "发布会", format: "pptx", title: "发布会", slides: [{ title: "发布会", bullets: ["春季新品"] }, { title: "亮点", bullets: ["更快", "更省"] }] }),
				d("file_create", { name: "会议纪要", format: "pdf", title: "会议纪要", content: "# 会议纪要\n- 预算通过\n- 排期下周确认" }),
				d("file_create", { name: "客户名单", format: "csv", table: { columns: ["客户", "城市"], rows: [["甲公司", "上海"], ["乙公司", "北京"]] } }),
			].join(" "),
	);
	await a.waitForURL(/\/c\//);
	await a.waitForSelector('[data-testid="file-card"]', { timeout: 60000 });
	await idle(a);
	const chatUrl = a.url();
	const [spaceId, convId] = new URL(chatUrl).pathname.split("/").slice(2, 4);
	const listFiles = async () => (await (await a.request.get(`${base}/api/files`)).json()).files;
	const mdId = (await listFiles()).find((f) => f.name.startsWith("项目周报")).id;
	await sendMessage(a, `补充风险 ${d("file_revise", { fileId: mdId, changeNote: "补充风险与下周计划", content: md + "\n\n## 下周计划\n- 开始开发" })}`);
	await sleep(1500);
	await idle(a);
	const py = [
		"import struct, zlib, os",
		"os.makedirs('out', exist_ok=True)",
		"open('out/report.csv','w').write('月份,收入\\n1月,120\\n')",
		"open('notes.md','w').write('# 分析笔记\\n- 收入同比增长 25%\\n')",
		"def png(w,h):",
		"    raw=b''.join(b'\\x00'+bytes([40,120,220])*w for _ in range(h))",
		"    def chunk(t,d):",
		"        c=struct.pack('>I',len(d))+t+d",
		"        return c+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)",
		"    return b'\\x89PNG\\r\\n\\x1a\\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')",
		"open('out/chart.png','wb').write(png(320,180))",
		"open('blob.bin','wb').write(bytes(range(256)))",
		"open('temp.txt','w').write('临时')",
		"print('已写入文件')",
	].join("\n");
	await sendMessage(a, `整理数据 ${d("sandbox_exec", { language: "python", code: py })}`);
	await sleep(1500);
	await idle(a);
	const pub = await a.request.post(`${base}/api/sandbox/${spaceId}/publish`, { data: { conversationId: Number(convId), path: "out/chart.png" } });
	check("setup: deliverables (md v2, docx, xlsx, pptx, pdf, csv) and an image published from the workspace", pub.ok() && (await listFiles()).length === 7, `${pub.status()}`);

	// ------------------------------------------------------------------ 1. every preview type renders, header is clean
	const TYPES = [
		["md", "项目周报.md", "preview-text"],
		["docx", "合同意见.docx", "preview-frame"],
		["xlsx", "销售汇总.xlsx", "preview-frame"],
		["pptx", "发布会.pptx", "preview-frame"],
		["pdf", "会议纪要.pdf", "preview-frame"],
		["csv", "客户名单.csv", "preview-frame"],
	];
	for (const [kind, name, viewer] of TYPES) {
		await a.goto(chatUrl);
		await a.waitForSelector('[data-testid="file-card"]');
		await a.locator('[data-testid="file-card"]', { hasText: name }).last().locator("button").first().click();
		await a.waitForSelector(`[data-testid="side-panel"] [data-testid="${viewer}"]`, { timeout: 15000 });
		if (viewer === "preview-frame") {
			await a.waitForSelector('[data-testid="preview-loading"]', { state: "detached", timeout: 40000 }).catch(() => {});
		}
		const panel = a.locator('[data-testid="preview-panel"]');
		const errs = await panel.locator('[role="alert"]').count();
		const ok = errs === 0 && (viewer !== "preview-frame" || (await a.locator('[data-testid="preview-loading"]').count()) === 0) && (await panel.locator('[data-testid="preview-name"]').innerText()) === name;
		check(`preview ${kind}: renders (no error state) with the file name in the header`, ok, `alerts=${errs}`);
		if (kind === "md") {
			const txt = await panel.locator('[data-testid="preview-text"]').innerText();
			check("preview md: shows the latest version (v2) content and a version switcher", txt.includes("下周计划") && (await panel.locator('[data-testid="version-switch"]').innerText()).includes("v2"));
			await a.click('[data-testid="version-switch"]');
			await sleep(400);
			const opaque = await a.evaluate(() => {
				const m = document.querySelector('[role="menu"]');
				const cs = m && getComputedStyle(m);
				const rgba = cs?.backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
				return { alpha: rgba[3] ?? 1, opacity: cs?.opacity };
			});
			check("popover: the version menu is opaque (solid background, opacity 1)", opaque.alpha === 1 && opaque.opacity === "1", JSON.stringify(opaque));
			await a.keyboard.press("Escape");
			await sleep(200);
			check("preview md: Esc in the menu closes only the menu", (await a.locator('[data-testid="preview-panel"]').count()) === 1);
			const dl = await panel.locator('[data-testid="preview-download"]').getAttribute("href");
			const open = panel.locator('[data-testid="preview-open"]');
			check("preview header: download link, open-in-new-tab link (target=_blank) and a close button", /\/download/.test(dl ?? "") && (await open.getAttribute("target")) === "_blank" && (await panel.locator('[data-testid="close-panel"]').count()) === 1);
			const sub = await panel.locator('[data-testid="preview-name"] + div').innerText();
			check("preview header: one quiet line (size · time), no origin or implementation words", /\d/.test(sub) && !JARGON.test(sub), sub);
			await a.screenshot({ path: join(SHOTS, "round5/after/g4-e2e-preview-md.png") }).catch(() => {});
		}
		if (kind === "pptx") check("preview pptx: single-version file has no version switcher", (await panel.locator('[data-testid="version-switch"]').count()) === 0);
		await a.click('[data-testid="close-panel"]');
		await a.waitForSelector('[data-testid="side-panel"]', { state: "detached" });
	}
	// image deliverable (published from the workspace) opened from the files page
	await a.goto(`${base}/files`);
	await a.waitForSelector('[data-testid="file-row"]');
	await a.click('button[aria-label="预览 chart.png"]');
	await a.waitForSelector('[data-testid="preview-image"]');
	await a.waitForFunction(() => { const i = document.querySelector('[data-testid="preview-image"]'); return i && i.complete && i.naturalWidth === 320; }, null, { timeout: 10000 });
	check("preview image: renders at its real size, no error state", (await a.locator('[data-testid="preview-panel"] [role="alert"]').count()) === 0);
	await a.keyboard.press("Escape").catch(() => {});

	// ------------------------------------------------------------------ 2. work panel: keyboard tabs, quiet empty states
	await a.goto(chatUrl);
	await a.waitForSelector('[data-testid="open-work-panel"]');
	await a.click('[data-testid="open-work-panel"]');
	await a.waitForSelector('[data-testid="work-panel"]');
	await a.locator('[data-testid="work-tab-tasks"]').focus();
	const tabs = ["terminal", "files", "browser"];
	let keyboardOk = true;
	for (const t of tabs) {
		await a.keyboard.press("ArrowRight");
		await sleep(250);
		keyboardOk &&= (await a.locator(`[data-testid="work-tab-${t}"]`).getAttribute("data-state")) === "active" && (await a.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === `work-tab-${t}`;
	}
	check("work panel: tabs 子任务 / 终端 / 文件 / 浏览器 are reachable with the arrow keys (focus follows)", keyboardOk);
	await a.waitForSelector('[data-testid="browser-empty"]', { timeout: 10000 });
	check("work panel: the browser tab has a quiet one-line empty state", (await a.locator('[data-testid="browser-empty"]').innerText()).length < 40);
	await a.keyboard.press("Home");
	await a.waitForSelector('[data-testid="tasks-empty"]', { timeout: 10000 });
	check("work panel: Home returns to 子任务, which has a quiet empty state", (await a.locator('[data-testid="work-tab-tasks"]').getAttribute("data-state")) === "active");
	await a.keyboard.press("Tab");
	check("work panel: Tab moves from the tab list into the panel content or the close button", (await a.evaluate(() => !!document.activeElement?.closest('[data-testid="work-panel"]'))));
	await a.keyboard.press("Escape");
	await a.waitForSelector('[data-testid="work-panel"]', { state: "detached", timeout: 5000 });
	check("work panel: Esc closes it when focus is inside", true);

	// terminal
	await a.click('[data-testid="open-work-panel"]');
	await a.click('[data-testid="work-tab-terminal"]');
	await a.waitForSelector('[data-testid="sandbox-run"]');
	const run = await a.locator('[data-testid="sandbox-run"]').first().innerText();
	check("terminal: a run shows the command, output and an exit status line", run.includes("已写入文件") && /退出码 0/.test(run) && !/namespaces|\[exit/.test(run), run.replace(/\s+/g, " ").slice(0, 120));
	const tPage = await a.locator('[data-testid="work-panel"]').innerText();
	check("terminal: no driver / isolation jargon visible", !JARGON.test(tPage), tPage.replace(/\s+/g, " ").slice(0, 120));

	// files tab + delete confirmation
	await a.click('[data-testid="work-tab-files"]');
	await a.waitForSelector('[data-testid="ws-tree"]');
	const entry = (p) => a.locator(`[data-testid="ws-entry"][data-path="${p}"]`);
	await entry("temp.txt").waitFor();
	const usage = await a.locator('[data-testid="ws-usage"]').innerText();
	check("files tab: one-line usage indicator (count, used / quota)", /\d+ 个文件 · 已用/.test(usage) && usage.split("\n").length <= 2, usage.replace(/\s+/g, " "));
	await entry("temp.txt").click();
	await a.click('[data-testid="ws-menu"][data-path="temp.txt"]');
	const menuItems = await a.locator('[role="menuitem"]').allInnerTexts();
	check("files tab: the compact menu offers 下载 / 发布到文件库 / 删除", ["下载", "发布到文件库", "删除"].every((t) => menuItems.some((m) => m.includes(t))), menuItems.join(","));
	await a.click('[data-testid="ws-delete"]');
	await a.waitForSelector('[data-testid="ws-delete-dialog"]');
	const dlgText = await a.locator('[data-testid="ws-delete-dialog"]').innerText();
	check("delete: asks for confirmation naming the file", dlgText.includes("temp.txt") && (await entry("temp.txt").count()) === 1, dlgText.replace(/\s+/g, " ").slice(0, 100));
	await a.click('[data-testid="ws-delete-cancel"]');
	await a.waitForSelector('[data-testid="ws-delete-dialog"]', { state: "detached" });
	const still = await a.request.get(`${base}/api/sandbox/${spaceId}/file?path=temp.txt&conversationId=${convId}`);
	check("delete: cancel keeps the file (row still there, server still serves it)", (await entry("temp.txt").count()) === 1 && still.status() === 200);
	await a.click('[data-testid="ws-menu"][data-path="temp.txt"]');
	await a.click('[data-testid="ws-delete"]');
	await a.click('[data-testid="ws-delete-confirm"]');
	await a.waitForFunction(() => !document.querySelector('[data-testid="ws-entry"][data-path="temp.txt"]'), null, { timeout: 10000 });
	const gone = await a.request.get(`${base}/api/sandbox/${spaceId}/file?path=temp.txt&conversationId=${convId}`);
	check("delete: confirming removes the file", gone.status() === 404);
	await entry("notes.md").click();
	await a.waitForSelector('[data-testid="ws-preview-text"]');
	const filesText = await a.locator('[data-testid="work-panel"]').innerText();
	check("files tab: no jargon (/work, namespaces, sandbox) in visible text", !JARGON.test(filesText) && !/\/work/.test(filesText), filesText.replace(/\s+/g, " ").slice(0, 160));
	await a.keyboard.press("Escape");

	// ------------------------------------------------------------------ 3. files pages: plain provenance, no jargon, header never overlaps
	await a.goto(`${base}/files`);
	await a.waitForSelector('[data-testid="file-row"]');
	const filesPage = await a.locator("main").innerText();
	check("files page: simple list without explanatory subtitle or jargon", !JARGON.test(filesPage) && !filesPage.includes("每次修改都会保留旧版本"), filesPage.replace(/\s+/g, " ").slice(0, 120));
	await a.goto(`${base}/files/${mdId}`);
	await a.waitForSelector('[data-testid="version-item"]');
	await a.waitForFunction(() => document.querySelector('[data-testid="provenance"]')?.textContent?.includes("「"), null, { timeout: 10000 });
	const items = await a.locator('[data-testid="version-item"]').allInnerTexts();
	const prov = await a.locator('[data-testid="provenance"]').allInnerTexts();
	check("file detail: versions timeline lists v2 and v1", items.length === 2 && items[0].includes("v2") && items[1].includes("v1"), items.map((t) => t.replace(/\s+/g, " ")).join(" | "));
	check("file detail: provenance in plain words — 由 对话「…」生成 · 引用 N 个文件", /^由 对话「.+」生成 · 引用 1 个文件$/.test(prov[0].trim()) && /^由 对话「.+」生成$/.test(prov[1].trim()), prov.join(" | "));
	const detail = await a.locator("main").innerText();
	check("file detail: no run / task / tool / version ids", !JARGON.test(detail) && !/run \d|提交 \d|工具 /.test(detail), detail.replace(/\s+/g, " ").slice(0, 160));
	check("file detail: storage and knowledge states stay separate and concise", /存储：已保存/.test(detail) && /知识库：\s*未加入/.test(detail));
	const gap = await a.evaluate(() => ({ header: document.querySelector("main header")?.getBoundingClientRect().bottom ?? 0, title: document.querySelector('[data-testid="file-title"]')?.getBoundingClientRect().top ?? 1e9 }));
	check("shell: the top bar never overlaps the page content", gap.header <= gap.title, JSON.stringify(gap));

	// ------------------------------------------------------------------ 4. shell: sidebar collapsed / expanded
	await a.goto(`${base}/files`);
	await a.waitForSelector('[data-testid="sidebar"]');
	await a.click('button[aria-label="收起侧栏"]');
	await a.locator('[data-testid="sidebar"]').waitFor({ state: "detached", timeout: 3000 }).catch(() => {}); // width transition, then unmount
	check("sidebar: collapses (no rail left) and the top bar offers the opener", (await a.locator('[data-testid="sidebar"]').count()) === 0 && (await a.locator('[data-testid="open-sidebar"]').isVisible()));
	await a.click('[data-testid="open-sidebar"]');
	check("sidebar: expands again", (await a.locator('[data-testid="sidebar"]').count()) === 1);
	const navText = await a.locator('[data-testid="sidebar"]').innerText();
	check("sidebar: no interface / jargon wording", !/接口|未连接|JSON/.test(navText), navText.replace(/\s+/g, " ").slice(0, 100));

	// ------------------------------------------------------------------ 5. 1366 sanity
	const c1366 = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: "zh-CN", storageState: await ctx.storageState() });
	const p1366 = await c1366.newPage();
	await p1366.goto(chatUrl);
	await p1366.waitForSelector('[data-testid="file-card"]');
	await p1366.locator('[data-testid="file-card"]', { hasText: "项目周报.md" }).last().locator("button").first().click();
	await p1366.waitForSelector('[data-testid="preview-text"]');
	const w = await p1366.evaluate(() => ({ panel: document.querySelector('[data-testid="side-panel"]').getBoundingClientRect().width, over: document.documentElement.scrollWidth > window.innerWidth }));
	check("1366: preview column is within 380–680px and the page does not overflow", w.panel >= 380 && w.panel <= 680 && !w.over, JSON.stringify(w));
	await c1366.close();

	// ------------------------------------------------------------------ 6. 390 phone: sheet, drawer, no horizontal scroll
	const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "zh-CN", hasTouch: true, storageState: await ctx.storageState() });
	const p = await phoneCtx.newPage();
	await p.goto(`${base}/`);
	await p.waitForSelector('[data-testid="home-greeting"]');
	check("390: home has no horizontal scroll", !(await overflowX(p)));
	await p.goto(chatUrl);
	await p.waitForSelector('[data-testid="file-card"]');
	check("390: chat has no horizontal scroll", !(await overflowX(p)));
	await p.locator('[data-testid="file-card"]', { hasText: "销售汇总.xlsx" }).first().locator("button").first().click();
	await p.waitForSelector('[data-testid="sheet-right"] [data-testid="preview-panel"]');
	await p.waitForSelector('[data-testid="preview-frame"]');
	const sheet = await p.evaluate(() => {
		const r = document.querySelector('[data-testid="sheet-right"]').getBoundingClientRect();
		const c = document.querySelector('[data-testid="close-panel"]').getBoundingClientRect();
		return { w: r.width, h: r.height, vh: window.innerHeight, vw: window.innerWidth, cw: c.width, ch: c.height };
	});
	check("390: the preview is a full-width, full-height sheet with a close control of at least 36px", sheet.w >= sheet.vw - 1 && sheet.h >= sheet.vh - 1 && sheet.cw >= 36 && sheet.ch >= 36, JSON.stringify(sheet));
	check("390: preview sheet has no horizontal scroll", !(await overflowX(p)));
	await p.keyboard.press("Escape");
	await p.waitForSelector('[data-testid="sheet-right"]', { state: "detached", timeout: 5000 });
	await sleep(300);
	check("390: Esc closes the preview sheet and focus returns to the file card", await p.evaluate(() => !!document.activeElement?.closest('[data-testid="file-card"]')));
	await p.locator('[data-testid="file-card"]', { hasText: "项目周报.md" }).last().locator("button").first().click();
	await p.waitForSelector('[data-testid="sheet-right"] [data-testid="preview-text"]');
	await p.click('[data-testid="close-panel"]');
	await p.waitForSelector('[data-testid="sheet-right"]', { state: "detached", timeout: 5000 });
	check("390: the close button closes the preview sheet", true);
	// work panel on the phone
	await p.click('[data-testid="open-work-panel"]');
	for (const t of ["tasks", "terminal", "files"]) {
		await p.click(`[data-testid="work-tab-${t}"]`);
		if (t === "files") {
			await p.waitForSelector('[data-testid="ws-tree"]');
			await p.locator('[data-testid="ws-entry"][data-path="notes.md"]').click();
			await p.waitForSelector('[data-testid="ws-preview-text"]');
		}
		if (t === "terminal") await p.waitForSelector('[data-testid="sandbox-run"]');
		await sleep(300);
		check(`390: work panel (${t}) has no horizontal scroll`, !(await overflowX(p)) && (await p.evaluate(() => { const el = document.querySelector('[data-testid="work-panel"]'); return el.scrollWidth <= el.clientWidth + 1; })));
	}
	await p.keyboard.press("Escape");
	await p.waitForSelector('[data-testid="sheet-right"]', { state: "detached", timeout: 5000 }).catch(() => {});
	// files pages on the phone
	await p.goto(`${base}/files`);
	await p.waitForSelector('[data-testid="file-row"]');
	check("390: files page has no horizontal scroll", !(await overflowX(p)));
	await p.goto(`${base}/files/${mdId}`);
	await p.waitForSelector('[data-testid="version-item"]');
	check("390: file detail has no horizontal scroll", !(await overflowX(p)));
	// drawer: focus trap + Esc + focus return
	await p.click('[data-testid="open-sidebar"]');
	await p.waitForSelector('[data-testid="sheet-left"]');
	let trapped = true;
	for (let i = 0; i < 14; i++) {
		await p.keyboard.press("Tab");
		trapped &&= await p.evaluate(() => !!document.activeElement?.closest('[data-testid="sheet-left"]'));
	}
	check("390: the navigation drawer traps focus (14 Tab presses stay inside)", trapped);
	check("390: the drawer has an explicit close button", (await p.locator('[data-testid="sheet-left"] [aria-label="关闭导航"]').count()) === 1);
	await p.keyboard.press("Escape");
	await p.waitForSelector('[data-testid="sheet-left"]', { state: "detached", timeout: 5000 });
	await sleep(300);
	check("390: Esc closes the drawer and focus returns to the opener", await p.evaluate(() => document.activeElement?.getAttribute("data-testid") === "open-sidebar"));
	await phoneCtx.close();

	// ------------------------------------------------------------------ 7. stats (demo org): simpler headings, banner and 模拟 labels kept, 390 stacking
	const seed = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/seed-demo.mjs", "--base", base, "--data-dir", `data/dev-B/e2e-${PORT}`, "--days", "120"], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
	check("stats: demo organisation seeded", seed.status === 0, (seed.stdout + seed.stderr).replace(/\s+/g, " ").slice(0, 400));
	const sctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	const s = await sctx.newPage();
	page0 = s;
	await s.goto(`${base}/login`);
	await s.fill("#email", "demo-admin@demo.workroom.example");
	await s.fill("#password", "demo-password-2026");
	await s.click('button[type="submit"]');
	await s.waitForSelector('[data-testid="home-greeting"]');
	await s.goto(`${base}/stats?scope=org&range=30d`);
	await s.waitForSelector('[data-testid="stats-dashboard"]', { timeout: 30000 });
	await s.waitForSelector('[data-testid="chart-area"]', { timeout: 30000 });
	await sleep(800);
	const st = await s.locator('[data-testid="stats-page"]').innerText();
	check("stats: demo banner kept and 模拟 labels kept", (await s.locator('[data-testid="demo-banner"]').innerText()).includes("演示数据") && st.includes("模拟"));
	check("stats: all charts still present (calendar, punch card, waffle, area, donut, tools, latency, knowledge, table)", (await Promise.all(["calendar", "punchcard", "waffle", "area", "donut", "tools", "latency", "knowledge", "table"].map((c) => s.locator(`[data-testid="chart-${c}"]`).count()))).every((n) => n === 1));
	check("stats: second-level explanations are tooltips, not permanent subtitles; no docs paths or jargon", !st.includes("不受上方时间范围限制") && !/docs\//.test(st) && !JARGON.test(st), st.replace(/\s+/g, " ").slice(0, 100));
	await s.click('[data-testid="chart-calendar"] [aria-label$="：说明"]');
	check("stats: the ? popover on a card holds the explanation", (await s.locator("[data-radix-popper-content-wrapper]").innerText()).includes("不受上方时间范围限制"));
	await s.keyboard.press("Escape");
	const hs = await s.locator("h2").evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).fontSize + "/" + getComputedStyle(e).fontWeight))]);
	check("stats: all card headings share one size and weight", hs.length === 1, hs.join(","));
	const small = await s.evaluate(() => [...document.querySelectorAll('[data-testid="stats-page"] *')].filter((e) => e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(e).fontSize) < 12 && !(e instanceof SVGElement)).length);
	check("stats: no HTML text below 12px", small === 0, String(small));
	const sgap = await s.evaluate(() => ({ header: document.querySelector("main header").getBoundingClientRect().bottom, h1: document.querySelector("main h1").getBoundingClientRect().top }));
	check("stats: top bar does not overlap the heading", sgap.header <= sgap.h1, JSON.stringify(sgap));
	await sctx.close();
	const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "zh-CN", hasTouch: true });
	const sp = await pctx.newPage();
	await sp.goto(`${base}/login`);
	await sp.fill("#email", "demo-admin@demo.workroom.example");
	await sp.fill("#password", "demo-password-2026");
	await sp.click('button[type="submit"]');
	await sp.waitForSelector('[data-testid="home-greeting"]');
	await sp.goto(`${base}/stats?scope=org&range=30d`);
	await sp.waitForSelector('[data-testid="chart-area"]', { timeout: 30000 });
	await sleep(800);
	const sm = await sp.evaluate(() => {
		const page = document.querySelector('[data-testid="stats-page"]');
		const cards = [...page.querySelectorAll("section[aria-label]")];
		const inCard = cards.every((c) => c.getBoundingClientRect().right <= window.innerWidth + 1);
		return { doc: document.documentElement.scrollWidth, win: window.innerWidth, page: page.scrollWidth, pc: page.clientWidth, inCard, nCards: cards.length };
	});
	check("390: stats has no horizontal page scroll; every card fits the viewport (wide charts scroll inside their card)", sm.doc <= sm.win && sm.page <= sm.pc + 1 && sm.inCard && sm.nCards >= 8, JSON.stringify(sm));
	await pctx.close();

	// ------------------------------------------------------------------ 8. reduced motion + dark mode (+ contrast)
	for (const scheme of ["light", "dark"]) {
		const rctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", colorScheme: scheme, reducedMotion: "reduce", storageState: await ctx.storageState() });
		const r = await rctx.newPage();
		await r.goto(chatUrl);
		await r.waitForSelector('[data-testid="file-card"]');
		await r.locator('[data-testid="file-card"]', { hasText: "项目周报.md" }).last().locator("button").first().click();
		await r.waitForSelector('[data-testid="preview-text"]');
		const m = await r.evaluate(() => ({
			reduce: matchMedia("(prefers-reduced-motion: reduce)").matches,
			panelAnim: parseFloat(getComputedStyle(document.querySelector('[data-testid="side-panel"]')).animationDuration) * (getComputedStyle(document.querySelector('[data-testid="side-panel"]')).animationDuration.endsWith("ms") ? 1 : 1000),
			bg: getComputedStyle(document.body).backgroundColor,
			panelBg: getComputedStyle(document.querySelector('[data-testid="side-panel"]')).backgroundColor,
		}));
		const lum = luminance(m.bg.match(/\d+/g).slice(0, 3).map(Number));
		check(`${scheme}: reduced motion is honoured (panel animation ≤ 1ms)`, m.reduce && m.panelAnim <= 1, JSON.stringify(m));
		check(`${scheme}: ${scheme === "dark" ? "dark page and panel backgrounds" : "light page background"}`, scheme === "dark" ? lum < 0.1 && luminance(m.panelBg.match(/\d+/g).slice(0, 3).map(Number)) < 0.1 : lum > 0.8);
		const c1 = await contrastOf(r, '[data-testid="preview-panel"] .text-fg-muted, [data-testid="preview-panel"] .text-xs');
		check(`${scheme}: preview header secondary text passes WCAG AA (≥ 4.5:1)`, c1.n > 0 && c1.worst >= 4.5, JSON.stringify(c1));
		await r.click('[data-testid="close-panel"]');
		await r.click('[data-testid="open-work-panel"]');
		await r.click('[data-testid="work-tab-terminal"]');
		await r.waitForSelector('[data-testid="sandbox-run"]');
		const c2 = await contrastOf(r, '[data-testid="work-panel"] [data-testid="sandbox-run"] *');
		check(`${scheme}: terminal blocks (stdout, stderr, exit line) pass AA`, c2.n > 0 && c2.worst >= 4.5, JSON.stringify(c2));
		await r.click('[data-testid="work-tab-files"]');
		await r.waitForSelector('[data-testid="ws-tree"]');
		const c3 = await contrastOf(r, '[data-testid="work-panel"] [data-testid="files-tab"] *');
		check(`${scheme}: workspace files tab passes AA`, c3.n > 0 && c3.worst >= 4.5, JSON.stringify(c3));
		await r.goto(`${base}/files/${mdId}`);
		await r.waitForSelector('[data-testid="provenance"]');
		const c4 = await contrastOf(r, "main .text-fg-muted, main .text-xs, main a");
		check(`${scheme}: file detail secondary text and links pass AA`, c4.n > 0 && c4.worst >= 4.5, JSON.stringify(c4));
		if (scheme === "dark") await r.screenshot({ path: join(SHOTS, "round5/after/g4-file-detail-dark-1440.png") });
		await rctx.close();
	}
} catch (e) {
	check(`unexpected error: ${String(e?.message ?? e).split("\n")[0]}`, false);
	console.error(e);
	await page0?.screenshot({ path: join(SHOTS, "round5-g4-failure-debug.png") }).catch(() => {});
} finally {
	await browser.close();
	await server.stop();
}
process.exitCode = summary(join(SHOTS, "round5-g4.results.json")) ? 0 : 1;
