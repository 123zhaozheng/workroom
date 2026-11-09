// Retrieval evaluation samples (M07-C): fixed corpus in 6 formats + expected hits, run through POST /api/kb/eval.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { startTestApp } from "./helpers/app.ts";
import { EVAL_CORPUS, EVAL_SAMPLES } from "../src/knowledge/eval-samples.ts";
import { MIME, uploadFile, waitDoc } from "../src/knowledge/testing.ts";

test("evaluation samples: every expected hit is in the top 5 (recall@5 = 1), negatives report no_evidence", async () => {
	const t = await startTestApp();
	try {
		const alice = await t.user("alice@example.com");
		const { kb } = await t.json("POST", "/api/kb", { token: alice.token, json: { name: "评估语料", scope: "personal" } });
		const pdf = await PDFDocument.create();
		const font = await pdf.embedFont(StandardFonts.Helvetica);
		for (const text of ["Quarterly report cover page", "Revenue grew 18 percent in the third quarter", "Risk factors include currency exposure"]) pdf.addPage().drawText(text, { x: 40, y: 700, size: 12, font });
		const docs = [...EVAL_CORPUS.map((d) => ({ name: d.name, mime: d.mime, bytes: d.text as string | Uint8Array })), { name: "q3-report.pdf", mime: MIME.pdf, bytes: await pdf.save() }];
		for (const d of docs) {
			const up = await uploadFile(t, alice.token, d);
			const { doc } = await t.json("POST", `/api/kb/${kb.id}/docs`, { token: alice.token, json: { fileId: up.fileId, versionId: up.versionId } });
			const ready = await waitDoc(t, alice.token, kb.id, doc.id);
			assert.equal(ready.latest.status, "ready", `${d.name}: ${ready.latest.error}`);
		}
		const samples = [
			...EVAL_SAMPLES,
			{ id: "pdf-page", query: "revenue grew third quarter", expect: { fileName: "q3-report.pdf", page: 2 } },
			{ id: "pdf-page-3", query: "currency exposure", expect: { fileName: "q3-report.pdf", page: 3 } },
		];
		const r = await t.json("POST", "/api/kb/eval", { token: alice.token, json: { samples, kbIds: [kb.id] } });
		const failed = r.samples.filter((s: any) => !s.pass);
		assert.deepEqual(failed, [], JSON.stringify(failed, null, 2));
		assert.equal(r.total, samples.length);
		assert.equal(r.recallAt5, 1);
		assert.ok(r.mrr >= 0.9, `mrr ${r.mrr}`);
		console.log(`# eval: ${r.passed}/${r.total} passed, recall@5=${r.recallAt5}, MRR=${r.mrr}`);

		// The same samples, run by a user without access, all fail with forbidden — evaluation goes through the ACL too.
		const eve = await t.user("eve@other.com");
		const forbidden = await t.json("POST", "/api/kb/eval", { token: eve.token, json: { samples: EVAL_SAMPLES.slice(0, 3), kbIds: [kb.id] } });
		assert.equal(forbidden.passed, 0);
		assert.ok(forbidden.samples.every((s: any) => s.reason === "forbidden"));

		// Retrieval debug: query plan + candidates are exposed for diagnosis.
		const dbg = await t.json("POST", "/api/kb/search", { token: alice.token, json: { query: "保修期多久", kbIds: [kb.id], debug: true } });
		assert.equal(dbg.diagnostics.strategy, "fts+like");
		assert.ok(dbg.debug.ftsQuery.includes('"保修期"'));
		assert.equal(dbg.debug.embedding, "blocked");
		assert.ok(dbg.debug.candidates >= 1);
	} finally {
		await t.dispose();
	}
});
