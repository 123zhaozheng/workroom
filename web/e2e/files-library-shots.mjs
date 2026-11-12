// Visual check of the 文件库 overview: seeds a few conversations with delivered files of every kind through the fixture model,
// spreads their dates over three days (by rewriting GET /api/library in the browser) and saves screenshots to
// artifacts/screenshots/round16/files-library-*.png. Prerequisite: npm run -w web build. Not part of the e2e suite.
import { join } from "node:path";
import { deflateSync as zlibDeflate } from "node:zlib";
import { chromium, check, register, ROOT, sendMessage, sleep, startServer, summary } from "./lib.mjs";

const PORT = Number(process.env.PORT ?? 8811);
const OUT = join(ROOT, "artifacts/screenshots/round16");
const server = await startServer({ port: PORT });
const base = server.base;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const a = await ctx.newPage();
const d = (tool, args) => `[[call ${tool} ${JSON.stringify(args)}]]`;
const idle = (page, t = 90000) => page.waitForSelector('[data-testid="stop"]', { state: "detached", timeout: t });
const { generate } = await import(join(ROOT, "server/src/files/generate.ts"));

// A sky-to-lake gradient PNG, built in node (no sandbox python needed).
const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
const crc32 = (b) => {
	let c = 0xffffffff;
	for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
const chunk = (t, data) => {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(t), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
};
function makePng(w = 240, h = 160) {
	const rows = [];
	for (let y = 0; y < h; y++) {
		const row = Buffer.alloc(1 + w * 3);
		for (let x = 0; x < w; x++) {
			const lake = y > h * 0.62;
			row.set(lake ? [40 + x / 8, 120 + (y - h * 0.62), 150] : [120 + y / 3, 170 + y / 4, 225 - x / 6], 1 + x * 3);
		}
		rows.push(row);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlibDeflate(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

try {
	await register(a, base, { email: `shots-${Date.now()}@example.com`, name: "林夏" });
	const convs = [
		{ title: "Agent Harness 优化", files: ["需求.md", "调研报告.pdf", "架构.docx", "示意.png"] },
		{ title: "在线 Agent 项目调研", files: ["行业研究报告.md", "对比分析.xlsx", "技术概览.pdf"] },
		{ title: "文件库界面设计", files: ["设计说明.md", "方案.docx", "界面稿.png", "评审.pptx", "清单.csv"] },
		{ title: "市场数据分析", files: ["市场报告.md", "数据汇总.xlsx", "趋势图.png"] },
		{ title: "产品发布准备", files: ["发布方案.md", "筹备计划.docx", "发布清单.csv", "宣发素材.pptx"] },
		{ title: "旅行计划", files: ["行程.csv", "目的地攻略.md", "风景.png"] },
	];
	for (const c of convs) {
		await a.goto(base);
		await a.waitForSelector('[data-testid="composer-input"]');
		const text = c.files.filter((f) => /\.(md|csv)$/.test(f));
		const msg = [];
		for (const f of text) msg.push(d("write", { path: `/work/${f}`, content: f.endsWith(".csv") ? "名称,数量,金额\n甲,1,120\n乙,2,150\n" : `# ${f}\n\n- 要点一\n- 要点二\n\n正文内容。\n` }), d("present_file", { source: `/work/${f}` }));
		await sendMessage(a, `${c.title} ${msg.join(" ")}`);
		await a.waitForURL(/\/c\//);
		await a.waitForSelector('[data-testid="file-card"]', { timeout: 60000 });
		await idle(a);
		const [sp, cv] = new URL(a.url()).pathname.split("/").slice(2, 4);
		const bins = c.files.filter((f) => /\.(docx|xlsx|pptx|pdf|png)$/.test(f));
		for (const n of bins) {
			const fmt = n.split(".").pop();
			const spec = { docx: { title: n, content: "# 总体意见\n建议修改。\n\n| 条款 | 建议 |\n|---|---|\n| 第 3 条 | 调整 |" }, xlsx: { sheets: [{ name: "表", columns: ["月份", "收入"], rows: [["1月", 120], ["2月", 150]] }] }, pptx: { title: n, slides: [{ title: n, bullets: ["要点"] }] }, pdf: { title: n, content: "# 标题\n- 一\n- 二" } }[fmt];
			const data = fmt === "png" ? makePng() : Buffer.from((await generate(fmt, spec)).bytes);
			const r = await a.request.put(`${base}/api/sandbox/${sp}/file?path=${encodeURIComponent(n)}&conversationId=${cv}`, { data });
			if (!r.ok()) throw new Error(`put ${n}: ${r.status()}`);
		}
		if (bins.length) {
			await sendMessage(a, "交付 " + bins.map((n) => d("present_file", { source: `/work/${n}` })).join(" "));
			await sleep(1200);
			await idle(a);
		}
	}
	// spread the folders over today / yesterday / two days ago (newest first = convs order)
	const now = new Date();
	const at = (daysAgo, h, m) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, h, m).toISOString();
	const stamps = [at(0, 16, 42), at(0, 14, 18), at(0, 11, 6), at(1, 18, 30), at(1, 10, 25), at(2, 20, 16)];
	await a.route("**/api/library", async (route) => {
		const res = await route.fetch();
		const body = await res.json();
		const order = [];
		for (const i of body.items) {
			const k = `${i.spaceId}/${i.conversationId}`;
			if (!order.includes(k)) order.push(k);
		}
		order.reverse(); // oldest conversation first = convs[0]
		body.items = body.items.map((i, n) => ({ ...i, updatedAt: stamps[order.indexOf(`${i.spaceId}/${i.conversationId}`)] ?? i.updatedAt, __n: n }));
		await route.fulfill({ response: res, json: body });
	});
	const shot = async (name) => a.screenshot({ path: join(OUT, `files-library-${name}.png`) });
	await a.goto(`${base}/files`);
	await a.waitForSelector('[data-testid="files-folder"]');
	await sleep(1200);
	await a.locator('[data-testid="files-folder"]').first().hover();
	await sleep(400);
	await shot("1440-light");
	await a.goto(`${base}/files?view=list`);
	await a.waitForSelector('[data-testid="file-row"]');
	await shot("1440-list");
	await a.goto(`${base}/files`);
	await a.waitForSelector('[data-testid="files-folder"]');
	await a.click('[data-testid="files-filter-image"]');
	await sleep(500);
	await shot("1440-images");
	await a.click('[data-testid="files-filter-all"]');
	await a.locator('[data-testid="files-card"]').first().click();
	await a.waitForSelector('[data-testid="files-folder-title"]');
	await sleep(300);
	await shot("1440-opened");
	await a.evaluate(() => (document.documentElement.dataset.theme = "dark"));
	await a.goto(`${base}/files`);
	await a.evaluate(() => (document.documentElement.dataset.theme = "dark"));
	await a.waitForSelector('[data-testid="files-folder"]');
	await sleep(1200);
	await shot("1440-dark");
	await a.setViewportSize({ width: 390, height: 844 });
	await sleep(500);
	await shot("390-dark");
	await a.evaluate(() => (document.documentElement.dataset.theme = "light"));
	await sleep(300);
	await shot("390-light");
	check("390px: no horizontal scroll", (await a.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0);
	check("six conversation cards", (await a.locator('[data-testid="files-folder"]').count()) === 6);
} finally {
	await browser.close();
	await server.stop();
}
summary();
