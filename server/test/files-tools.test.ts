// Agent file tools through real pi-durable tool tasks (faux model emits the calls); generated files parsed back.
import { test } from "node:test";
import assert from "node:assert/strict";
import mammoth from "mammoth";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { startTestApp } from "./helpers/app.ts";
import { createFileTools, createFilesExtension } from "../src/files/extension.ts";
import { pdfText } from "../src/files/extract.ts";
import { answer, call, context, fakeApi, fixedActor, toolHarness } from "./fixtures/tool-harness.ts";
import { orgMember } from "./fixtures/util.ts";

const table = { columns: ["地区", "收入"], rows: [["华东", 120], ["华北", 80]] };

test("file_create generates real docx/xlsx/pptx/pdf/md/html/csv files that parse back; provenance links the tool call", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("gen@example.com");
		const space = t.app.ctx.services.get("identity").personalSpace(a.me.userId, a.me.orgId);
		const ext = createFilesExtension(t.app.ctx, { resolveActor: fixedActor(t.app.ctx, a.me.userId, a.me.orgId, space.id) });
		const h = await toolHarness(
			[ext],
			[
				call("file_create", { name: "季度报告", format: "docx", title: "季度报告", content: "## 概述\n收入增长 **12%**。\n\n- 华东领先\n- 华北追赶", table }, "c1"),
				call("file_create", { name: "数据", format: "xlsx", sheets: [{ name: "收入", columns: ["地区", "收入"], rows: [["华东", 120], ["华北", 80], ["合计", "=B2+B3"]] }, { name: "备注", rows: [["说明"]] }] }, "c2"),
				call("file_create", { name: "汇报", format: "pptx", title: "季度汇报", slides: [{ title: "要点", bullets: ["收入增长", "成本下降"], notes: "讲 2 分钟" }, { title: "下一步", bullets: ["扩张华南"] }] }, "c3"),
				call("file_create", { name: "summary", format: "pdf", title: "季度总结 Summary", content: "第一段内容。\n\n- 要点 A", table }, "c4"),
				call("file_create", { name: "notes", format: "md", title: "Notes", content: "hello" }, "c5"),
				call("file_create", { name: "page", format: "html", title: "Page", content: "<script>alert(1)</script> text" }, "c6"),
				call("file_create", { name: "rows", format: "csv", table: { columns: ["a", "b"], rows: [["x,y", 1]] } }, "c7"),
				answer("done"),
			],
		);
		const settled = await h.run("make the deliverables");
		assert.equal(settled.status, "done");
		const results = await h.results();
		assert.equal(results.length, 7);
		for (const r of results) assert.equal(r.isError, false, r.text);
		const files = t.app.ctx.services.get("files") as any;
		const principal = (await t.app.ctx.services.get("identity").principalFor(a.me.userId, a.me.orgId))!;
		const list = await files.list(principal, {});
		assert.equal(list.length, 7);
		const byName = new Map<string, any>(list.map((f: any) => [f.name, f]));
		const bytesOf = async (name: string) => (await files.getVersion(principal, byName.get(name).latestVersionId)).bytes as Uint8Array;

		// docx → mammoth
		const docText = (await mammoth.extractRawText({ buffer: Buffer.from(await bytesOf("季度报告.docx")) })).value;
		assert.match(docText, /季度报告/);
		assert.match(docText, /收入增长 12%/);
		assert.match(docText, /华东领先/);
		assert.match(docText, /华北/);
		// xlsx → exceljs
		const wb = new ExcelJS.Workbook();
		await wb.xlsx.load(Buffer.from(await bytesOf("数据.xlsx")) as any);
		assert.deepEqual(wb.worksheets.map((w) => w.name), ["收入", "备注"]);
		assert.equal(wb.getWorksheet("收入")!.getCell("B2").value, 120);
		assert.deepEqual((wb.getWorksheet("收入")!.getCell("B4").value as any).formula, "B2+B3");
		// pptx → unzip slide XML
		const zip = await JSZip.loadAsync(await bytesOf("汇报.pptx"));
		const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
		assert.equal(slides.length, 3);
		const s2 = await zip.file("ppt/slides/slide2.xml")!.async("string");
		assert.match(s2, /要点/);
		assert.match(s2, /成本下降/);
		assert.ok(Object.keys(zip.files).some((n) => n.startsWith("ppt/notesSlides/")));
		// pdf → pdf-lib load + text extraction (CJK font embedded)
		const pdfBytes = await bytesOf("summary.pdf");
		const pdf = await PDFDocument.load(pdfBytes);
		assert.ok(pdf.getPageCount() >= 1);
		assert.equal(pdf.getTitle(), "季度总结 Summary");
		const pt = await pdfText(pdfBytes);
		assert.match(pt.text, /第一段内容/);
		assert.match(pt.text, /华东/);
		// md / html / csv
		assert.match(new TextDecoder().decode(await bytesOf("notes.md")), /^# Notes\n\nhello/);
		const html = new TextDecoder().decode(await bytesOf("page.html"));
		assert.doesNotMatch(html, /<script>/);
		assert.match(html, /&lt;script&gt;/);
		assert.match(new TextDecoder().decode(await bytesOf("rows.csv")), /"x,y",1/);

		// File card details + provenance back to the tool call
		const r0 = results[0]!;
		const versionId = byName.get("季度报告.docx").latestVersionId;
		assert.match(r0.text, new RegExp(versionId));
		const detail = await t.json("GET", `/api/files/${byName.get("季度报告.docx").id}`, { token: a.token });
		const prov = detail.versions[0].provenance;
		assert.equal(prov.origin, "agent");
		assert.equal(prov.tool, "file_create");
		assert.equal(prov.callId, "c1");
		assert.equal(typeof prov.taskId, "number");
		assert.equal(prov.conversationId, Number(h.root.id));
		assert.equal(detail.versions[0].previewKind, "docx");

		// Previews of generated office files render
		for (const [name, re] of [["季度报告.docx", /华东领先/], ["数据.xlsx", /<td>120<\/td>/], ["汇报.pptx", /成本下降/]] as const) {
			const f = byName.get(name);
			const pv = await t.req("GET", `/api/files/${f.id}/versions/${f.latestVersionId}/preview`, { token: a.token });
			assert.equal(pv.status, 200);
			assert.match(await pv.text(), re);
		}

		// Tool call records exist for each call, with durations
		const calls = await t.json("GET", `/api/tool-calls?spaceId=${space.id}`, { token: a.token });
		assert.equal(calls.calls.filter((c: any) => c.tool === "file_create" && c.status === "ok").length, 7);
		assert.ok(calls.calls.every((c: any) => typeof c.durationMs === "number"));
		await h.close();
	} finally {
		await t.dispose();
	}
});

test("file_revise creates v2 with change note (v1 untouched); file_read reads text; replay is idempotent; viewer cannot write", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("rev@example.com");
		const v = await orgMember(t, a, "view@example.com");
		const { project } = await t.json("POST", "/api/projects", { token: a.token, json: { name: "Docs" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: a.token, json: { email: "view@example.com", role: "viewer" } });
		const ctx = t.app.ctx;
		const tools = createFileTools(ctx, { resolveActor: fixedActor(ctx, a.me.userId, a.me.orgId, project.spaceId) });

		// Direct execute twice with the same (conversation, task, call): the replay returns the same version.
		const api1 = fakeApi({ conversationId: 7, taskId: 42, callId: "call-1" });
		const first = await tools.fileCreate.execute({ name: "方案", format: "docx", content: "第一版" } as any, api1, context);
		const again = await tools.fileCreate.execute({ name: "方案", format: "docx", content: "第一版" } as any, api1, context);
		const ref1 = first.structuredOutput as any;
		assert.equal((again.structuredOutput as any).versionId, ref1.versionId);
		assert.equal(ctx.db.get<any>("SELECT COUNT(*) AS n FROM file_versions WHERE file_id = ?", ref1.fileId).n, 1);
		assert.deepEqual((first.details as any).artifact, ref1);

		const rev = await tools.fileRevise.execute({ fileId: ref1.fileId, changeNote: "改成第二版", content: "第二版内容", baseVersionId: ref1.versionId } as any, fakeApi({ conversationId: 7, taskId: 43, callId: "call-2" }), context);
		const ref2 = rev.structuredOutput as any;
		assert.equal(ref2.versionNo, 2);
		// Replay of the revise after its own version moved the base still returns the same version (no conflict).
		const revAgain = await tools.fileRevise.execute({ fileId: ref1.fileId, changeNote: "改成第二版", content: "第二版内容", baseVersionId: ref1.versionId } as any, fakeApi({ conversationId: 7, taskId: 43, callId: "call-2" }), context);
		assert.equal((revAgain.structuredOutput as any).versionId, ref2.versionId);
		// A different call with a stale base conflicts.
		await assert.rejects(tools.fileRevise.execute({ fileId: ref1.fileId, changeNote: "x", content: "y", baseVersionId: ref1.versionId } as any, fakeApi({ conversationId: 7, taskId: 44, callId: "call-3" }), context), /更新版本/);

		const detail = await t.json("GET", `/api/files/${ref1.fileId}`, { token: a.token });
		assert.equal(detail.versions.length, 2);
		assert.equal(detail.versions[0].changeNote, "改成第二版");
		assert.deepEqual(detail.versions[0].provenance.inputVersionIds, [ref1.versionId]);
		const v1Text = (await mammoth.extractRawText({ buffer: Buffer.from(await (await t.req("GET", `/api/files/${ref1.fileId}/versions/${ref1.versionId}/download`, { token: a.token })).arrayBuffer()) })).value;
		assert.match(v1Text, /第一版/);
		assert.doesNotMatch(v1Text, /第二版/);

		const read = await tools.fileRead.execute({ fileId: ref1.fileId } as any, fakeApi({ conversationId: 7, taskId: 45, callId: "call-4" }), context);
		assert.match((read.output as any)[0].text, /第二版内容/);
		const read1 = await tools.fileRead.execute({ versionId: ref1.versionId } as any, fakeApi({ conversationId: 7, taskId: 46, callId: "call-5" }), context);
		assert.match((read1.output as any)[0].text, /第一版/);

		// The viewer's tool calls are denied for writes but may read.
		const vt = createFileTools(ctx, { resolveActor: fixedActor(ctx, v.me.userId, v.me.orgId, project.spaceId) });
		await assert.rejects(vt.fileCreate.execute({ name: "x", format: "md", content: "x" } as any, fakeApi({ conversationId: 8, taskId: 1, callId: "v1" }), context), /role_viewer|无权/);
		await assert.rejects(vt.fileRevise.execute({ fileId: ref1.fileId, changeNote: "x", content: "x" } as any, fakeApi({ conversationId: 8, taskId: 2, callId: "v2" }), context), /role_viewer|无权/);
		const vr = await vt.fileRead.execute({ fileId: ref1.fileId } as any, fakeApi({ conversationId: 8, taskId: 3, callId: "v3" }), context);
		assert.match((vr.output as any)[0].text, /第二版内容/);
		// Removing the viewer revokes even reads mid-conversation.
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: a.token, json: { email: "view@example.com", role: null } });
		await assert.rejects(vt.fileRead.execute({ fileId: ref1.fileId } as any, fakeApi({ conversationId: 8, taskId: 4, callId: "v4" }), context), /not_member|拒绝/);
		const denied = ctx.db.all<any>("SELECT status FROM tool_calls WHERE user_id = ? ORDER BY started_ms", v.me.userId).map((r) => r.status);
		assert.deepEqual(denied, ["denied", "denied", "ok"]); // the revoked call is refused before a record can be attributed
	} finally {
		await t.dispose();
	}
});
