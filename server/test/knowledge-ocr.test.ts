// Offline OCR (tesseract.js WASM + local chi_sim/eng data): images and scanned PDF pages become searchable with page
// anchors and an OCR flag. Network access is pointed at a dead proxy for this process to show nothing is downloaded.
process.env.HTTPS_PROXY = process.env.HTTP_PROXY = process.env.https_proxy = process.env.http_proxy = "http://127.0.0.1:9";

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { startTestApp } from "./helpers/app.ts";
import { kbWithDoc, MIME } from "../src/knowledge/testing.ts";

const FONT = "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc";

function textImage(lines: string[]): Uint8Array {
	GlobalFonts.registerFromPath(FONT, "WQY");
	const c = createCanvas(1100, 120 + lines.length * 90);
	const g = c.getContext("2d");
	g.fillStyle = "#fff";
	g.fillRect(0, 0, c.width, c.height);
	g.fillStyle = "#000";
	g.font = "44px WQY";
	lines.forEach((l, i) => g.fillText(l, 40, 90 + i * 90));
	return new Uint8Array(c.toBuffer("image/png"));
}

test("OCR: image and scanned PDF page are recognized offline, cited with page + OCR flag", { skip: !existsSync(FONT) && "CJK test font missing" }, async () => {
	const t = await startTestApp();
	try {
		const alice = await t.user("alice@example.com");
		const caps = await t.json("GET", "/api/kb/capabilities", { token: alice.token });
		assert.equal(caps.ocr.status, "ready", caps.ocr.detail);

		// 1) A photo/scan of a contract clause (PNG).
		const png = textImage(["合同编号 HT-2027", "违约金为合同总额的百分之五", "Payment due within 45 days"]);
		const img = await kbWithDoc(t, alice.token, { name: "扫描件", scope: "personal" }, { name: "clause.png", mime: "image/png", bytes: png });
		assert.equal(img.doc.latest.status, "ready", String(img.doc.latest.error));
		assert.equal(img.doc.latest.ocrPages, 1);
		const c1 = (await t.json("POST", "/api/kb/search", { token: alice.token, json: { query: "违约金", kbIds: [img.kb.id] } })).citations[0];
		assert.equal(c1?.fileName, "clause.png");
		assert.equal(c1.ocr, true);
		assert.match(c1.locator, /OCR 识别/);
		assert.match(c1.snippet, /违约金为合同总额的百分之五/);
		assert.equal((await t.json("POST", "/api/kb/search", { token: alice.token, json: { query: "payment due within", kbIds: [img.kb.id] } })).citations[0]?.fileName, "clause.png");

		// 2) A PDF whose page 2 is a scanned image (no text layer); page 1 has real text.
		const pdf = await PDFDocument.create();
		const font = await pdf.embedFont(StandardFonts.Helvetica);
		pdf.addPage([595, 842]).drawText("Cover page with a normal text layer.", { x: 50, y: 760, size: 14, font });
		const scan = await pdf.embedPng(textImage(["第二页：保密期限为五年", "Confidentiality term is five years"]));
		pdf.addPage([595, 842]).drawImage(scan, { x: 20, y: 500, width: 555, height: 555 * (scan.height / scan.width) });
		const sp = await kbWithDoc(t, alice.token, { name: "合同", scope: "personal" }, { name: "nda-scan.pdf", mime: MIME.pdf, bytes: await pdf.save() });
		assert.equal(sp.doc.latest.status, "ready", String(sp.doc.latest.error));
		assert.equal(sp.doc.latest.pageCount, 2);
		assert.equal(sp.doc.latest.ocrPages, 1);
		// The scanned page was rasterized in the render worker thread, not on the main event loop.
		assert.equal((t.app.ctx.services.get("knowledgeAdmin") as any).pipeline.ocr.rasterizer.running, true);
		const c2 = (await t.json("POST", "/api/kb/search", { token: alice.token, json: { query: "保密期限", kbIds: [sp.kb.id] } })).citations[0];
		assert.equal(c2?.page, 2);
		assert.equal(c2.ocr, true);
		assert.equal(c2.locator, "第 2 页（OCR 识别）");
		const c3 = (await t.json("POST", "/api/kb/search", { token: alice.token, json: { query: "normal text layer", kbIds: [sp.kb.id] } })).citations[0];
		assert.equal(c3?.page, 1);
		assert.equal(c3.ocr, undefined);
	} finally {
		await t.dispose();
	}
});
