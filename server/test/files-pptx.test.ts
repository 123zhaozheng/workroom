// PPTX preview renders real slide images (LibreOffice + pdftoppm inside the namespace sandbox), cached per content hash;
// falls back to the text outline with the reason when rendering is unavailable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "./helpers/app.ts";
import { upload } from "./fixtures/util.ts";
import { generate } from "../src/files/generate.ts";
import { slideRendererAvailable } from "../src/files/slides.ts";
import { probeIsolation } from "../src/tools/sandbox.ts";

const skip = !slideRendererAvailable().ok ? slideRendererAvailable().reason : !probeIsolation().ok ? probeIsolation().detail : false;

test("pptx preview: slide images rendered in the sandbox, cached, outline fallback when unavailable", { skip }, async () => {
	const t = await startTestApp();
	try {
		const u = await t.user("pptx@example.com");
		const deck = await generate("pptx", { title: "季度汇报", slides: [{ title: "要点", bullets: ["收入增长", "成本下降"], notes: "讲两分钟" }, { title: "下一步", bullets: ["扩张华南"] }] });
		const up = await (await upload(t, u.token, "/files", "汇报.pptx", deck.bytes)).json();
		const url = `/api/files/${up.file.id}/versions/${up.version.versionId}/preview`;
		const t0 = Date.now();
		const r = await t.req("GET", url, { token: u.token });
		assert.equal(r.status, 200);
		assert.equal(r.headers.get("x-preview-render"), "slides");
		assert.match(r.headers.get("content-security-policy")!, /^sandbox;.*img-src data:/);
		const html = await r.text();
		const imgs = [...html.matchAll(/<img alt="([^"]*)" src="data:image\/png;base64,([^"]+)">/g)];
		assert.equal(imgs.length, 3); // title slide + 2 content slides
		for (const m of imgs) assert.deepEqual([...Buffer.from(m[2]!, "base64").subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
		assert.match(imgs[1]![1]!, /要点 \/ 收入增长 \/ 成本下降/);
		assert.match(html, /备注：讲两分钟/);
		const first = Date.now() - t0;
		const t1 = Date.now();
		const again = await t.req("GET", url, { token: u.token });
		assert.equal(again.headers.get("x-preview-render"), "slides");
		assert.ok(Date.now() - t1 < first, "second preview is served from the render cache");
		assert.equal(t.app.ctx.db.get<any>("SELECT COUNT(*) AS n FROM file_preview_cache").n, 1);

		// Renderer unavailable (simulated: no sandbox service) → outline with the reason.
		const { renderPreview } = await import("../src/files/preview.ts");
		const outline = await renderPreview(up.version.mime, "汇报.pptx", deck.bytes, { slidesUnavailable: "服务器未安装 LibreOffice（soffice）" });
		assert.equal(outline.renderMode, "outline");
		assert.match(String(outline.body), /版式渲染不可用：服务器未安装 LibreOffice/);
		assert.match(String(outline.body), /成本下降/);
	} finally {
		await t.dispose();
	}
});
