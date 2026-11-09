// Parsers + chunker + query planner (unit level, real libraries, real generated files).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow } from "docx";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { parseDocument, ParseError, detectFormat } from "../src/knowledge/parsers.ts";
import { chunkBlocks, locatorOf, splitLong } from "../src/knowledge/chunker.ts";
import { planQuery, makeSnippet, coverage } from "../src/knowledge/query.ts";
import { MIME } from "../src/knowledge/testing.ts";

const enc = (s: string) => new TextEncoder().encode(s);

test("markdown: heading paths, fenced code is not a heading, paragraph ordinals", async () => {
	const r = await parseDocument(enc("# 手册\n\n前言段落。\n\n## 安全\n\n```\n# not a heading\n```\n\n门禁卡不得外借。\n\n### 访客\n\n访客需登记。\n\n## 福利\n\n年假十五天。"), "h.md", MIME.md);
	assert.deepEqual(r.blocks.map((b) => [b.section, b.text.slice(0, 6)]), [
		["手册", "前言段落。"],
		["手册 > 安全", "```\n# "],
		["手册 > 安全", "门禁卡不得外"],
		["手册 > 安全 > 访客", "访客需登记。"],
		["手册 > 福利", "年假十五天。"],
	]);
	assert.deepEqual(r.blocks.map((b) => b.paragraph), [1, 2, 3, 4, 5]);
});

test("html: headings, paragraphs, lists, tables; scripts/styles dropped; entities decoded", async () => {
	const r = await parseDocument(enc(`<html><head><style>.x{}</style><script>alert(1)</script></head><body>
<h1>指南</h1><p>第一段 &amp; 说明&nbsp;文字</p><div>裸文本 <b>加粗</b> 内容</div>
<h2>表格</h2><table><tr><th>名称</th><th>数量</th></tr><tr><td>螺丝</td><td>12</td></tr></table>
<ul><li>条目一</li><li>条目二</li></ul></body></html>`), "g.html", MIME.html);
	const texts = r.blocks.map((b) => `${b.section}|${b.text}`);
	assert.ok(texts.includes("指南|第一段 & 说明 文字"), texts.join("\n"));
	assert.ok(texts.includes("指南|裸文本 加粗 内容"), texts.join("\n"));
	assert.ok(texts.includes("指南 > 表格|螺丝 | 12"), texts.join("\n"));
	assert.ok(texts.includes("指南 > 表格|条目一"));
	assert.ok(!texts.some((x) => x.includes("alert") || x.includes(".x{}")));
});

test("docx (generated with docx): Word headings become section paths; tables kept", async () => {
	const doc = new Document({
		sections: [
			{
				children: [
					new Paragraph({ text: "采购管理办法", heading: HeadingLevel.HEADING_1 }),
					new Paragraph("本办法规范公司采购行为。"),
					new Paragraph({ text: "审批权限", heading: HeadingLevel.HEADING_2 }),
					new Paragraph("单笔超过五万元的采购需总经理审批。"),
					new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph("金额")] }), new TableCell({ children: [new Paragraph("审批人")] })] })] }),
				],
			},
		],
	});
	const bytes = new Uint8Array(await Packer.toBuffer(doc));
	const r = await parseDocument(bytes, "purchase.docx", MIME.docx);
	assert.equal(r.format, "docx");
	const hit = r.blocks.find((b) => b.text.includes("五万元"));
	assert.equal(hit?.section, "采购管理办法 > 审批权限");
	assert.ok(r.blocks.some((b) => b.text.includes("金额") && b.text.includes("审批人")));
	await assert.rejects(parseDocument(enc("not a zip"), "bad.docx", MIME.docx), (e: any) => e instanceof ParseError && e.code === "parse_error");
});

test("xlsx (generated with exceljs): sheet + row anchors, header-labelled cells, formulas use results", async () => {
	const wb = new ExcelJS.Workbook();
	const ws = wb.addWorksheet("库存");
	ws.addRow(["物料", "数量", "单价", "合计"]);
	ws.addRow(["轴承", 40, 2.5, { formula: "B2*C2", result: 100 }]);
	ws.addRow(["齿轮", 8, 12, { formula: "B3*C3", result: 96 }]);
	wb.addWorksheet("Notes").addRow(["Reorder when below 10 units"]);
	const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
	const r = await parseDocument(bytes, "stock.xlsx", MIME.xlsx);
	const gear = r.blocks.find((b) => b.text.includes("齿轮"))!;
	assert.equal(gear.sheet, "库存");
	assert.equal(gear.rowStart, 3);
	assert.match(gear.text, /合计: 96/);
	assert.equal(r.blocks.find((b) => b.text.includes("Reorder"))?.sheet, "Notes");
	const chunks = chunkBlocks(r.blocks);
	assert.ok(chunks.every((c) => c.sheet), "chunks never mix sheets");
	const c1 = chunks.find((c) => c.sheet === "库存")!;
	assert.equal(locatorOf(c1), "库存 第 1–3 行");
});

test("csv/tsv with quotes and json paths", async () => {
	const csv = await parseDocument(enc('名称,备注\n"甲,乙","含""引号"""\n丙,普通\n'), "a.csv", MIME.csv);
	assert.equal(csv.blocks[1]!.text, '名称: 甲,乙; 备注: 含"引号"');
	assert.equal(csv.blocks[1]!.rowStart, 2);
	const tsv = await parseDocument(enc("a\tb\n1\t2\n"), "a.tsv", "text/tab-separated-values");
	assert.equal(tsv.blocks[1]!.text, "a: 1; b: 2");
	const json = await parseDocument(enc(JSON.stringify({ db: { host: "pg.internal", port: 5432 }, features: ["sso", "audit"] })), "c.json", MIME.json);
	assert.deepEqual(json.blocks.map((b) => [b.section, b.text]), [
		["db", "db.host: pg.internal\ndb.port: 5432"],
		["features", "features[0]: sso\nfeatures[1]: audit"],
	]);
	await assert.rejects(parseDocument(enc("{oops"), "x.json", MIME.json), (e: any) => e.code === "parse_error");
});

test("pdf: per-page text with page numbers; scanned (no text layer) fails with no_text", async () => {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	for (const t of ["alpha page", "beta page", "gamma page"]) doc.addPage().drawText(t, { x: 40, y: 700, font, size: 14 });
	const r = await parseDocument(await doc.save(), "x.pdf", MIME.pdf);
	assert.equal(r.pageCount, 3);
	assert.deepEqual(r.blocks.map((b) => [b.page, b.text]), [[1, "alpha page"], [2, "beta page"], [3, "gamma page"]]);
	const blank = await PDFDocument.create();
	blank.addPage();
	await assert.rejects(parseDocument(await blank.save(), "scan.pdf", MIME.pdf), (e: any) => e.code === "no_text" && !e.retryable);
});

test("text decoding (UTF-8 BOM, GB18030), type detection, unsupported types", async () => {
	const gb = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]); // "中文" in GB18030
	assert.equal((await parseDocument(gb, "legacy.txt", MIME.txt)).blocks[0]!.text, "中文");
	assert.equal((await parseDocument(new Uint8Array([0xef, 0xbb, 0xbf, ...enc("hi")]), "b.txt", MIME.txt)).blocks[0]!.text, "hi");
	assert.equal(detectFormat("main.ts", "application/octet-stream", enc("const x = 1;")), "txt");
	assert.deepEqual(detectFormat("a.png", "image/png", new Uint8Array([0x89, 0x50])), { code: "ocr_unavailable", unsupported: (detectFormat("a.png", "image/png", new Uint8Array()) as any).unsupported });
	assert.equal((detectFormat("a.bin", "application/octet-stream", new Uint8Array([0, 1, 2])) as any).code, "unsupported_type");
	await assert.rejects(parseDocument(enc("   \n\n  "), "empty.txt", MIME.txt), (e: any) => e.code === "no_text");
});

test("chunker: packs within a unit, never crosses pages/sections, splits long text at sentence ends", () => {
	const long = "这是一个很长的句子。".repeat(200);
	const chunks = chunkBlocks([
		{ text: "a1", page: 1 },
		{ text: "a2", page: 1 },
		{ text: "b1", page: 2 },
		{ text: long, section: "S" },
	]);
	assert.equal(chunks[0]!.text, "a1\na2");
	assert.equal(chunks[1]!.page, 2);
	const longChunks = chunks.filter((c) => c.section === "S");
	assert.ok(longChunks.length >= 2);
	assert.ok(longChunks.every((c) => c.text.length <= 900));
	assert.ok(longChunks.every((c) => c.text.endsWith("。")), "split at sentence end");
	assert.deepEqual(chunks.map((c) => c.ordinal), chunks.map((_, i) => i + 1));
	assert.ok(splitLong("x".repeat(2000), 900).every((p) => p.length <= 900));
	assert.equal(locatorOf({ paragraph: 4 }), "第 4 段");
	assert.equal(locatorOf({ section: "A > B", paragraph: 2 }), "章节：A > B · 第 2 段");
	assert.equal(locatorOf({ rowStart: 2, rowEnd: 9 }), "第 2–9 行");
});

test("query planner: trigram terms, CJK n-grams, short-term LIKE fallback, bigrams, snippets", () => {
	const p = planQuery("差旅报销期限");
	assert.ok(p.match!.includes('"差旅报销期限"') && p.match!.includes('"报销期"'));
	assert.deepEqual(planQuery("HR").like, ["hr"]);
	assert.equal(planQuery("HR").match, null);
	assert.deepEqual(planQuery("保修期多久").bigrams, ["保修", "修期", "期多"]);
	assert.equal(planQuery('say "hi" AND drop').match, '"say" OR "drop"'); // operators/quotes can never reach FTS syntax
	assert.equal(planQuery("   ").match, null);
	const snip = makeSnippet(`${"无关内容。".repeat(80)}关键条款：付款期限六十天。${"其他内容。".repeat(80)}`, ["付款期限"], 60);
	assert.match(snip, /付款期限六十天/);
	assert.ok(snip.startsWith("…") && snip.endsWith("…"));
	assert.ok(coverage("差旅报销期限为三十日", ["差旅报销期限"]) === 1);
});
