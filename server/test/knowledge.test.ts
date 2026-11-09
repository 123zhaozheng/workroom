// Knowledge bases: ACL inside retrieval, citations (file version + PDF page), versions/supersede, delete, isolation,
// processing states (failure, retry, restart), governance. Real app, real SQLite, real files module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { addDepartment, joinOrg, kbIdle, kbWithDoc, knowledgeAdmin, MIME, removeFromDepartment, uploadFile, uploadVersion, waitDoc } from "../src/knowledge/testing.ts";

async function makePdf(pages: string[]): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	for (const text of pages) {
		const page = doc.addPage([595, 842]);
		text.split("\n").forEach((line, i) => page.drawText(line, { x: 50, y: 780 - i * 20, size: 12, font }));
	}
	return doc.save();
}

async function orgWithTwo(t: TestApp) {
	const alice = await t.user("alice@example.com", { name: "Alice" });
	const bob = await joinOrg(t, alice.me.orgId, "bob@example.com");
	return { alice, bob, orgId: alice.me.orgId as string };
}

const search = (t: TestApp, token: string, body: Record<string, unknown>) => t.json("POST", "/api/kb/search", { token, json: body });

test("ACL: project/personal/department/org scopes are enforced inside retrieval; removal revokes the next search", async () => {
	const t = await startTestApp();
	try {
		const { alice, bob, orgId } = await orgWithTwo(t);
		const outsider = await t.user("eve@other.com");
		const { project } = await t.json("POST", "/api/projects", { token: alice.token, json: { name: "Apollo" } });

		const proj = await kbWithDoc(t, alice.token, { name: "Apollo 资料", scope: "project", projectId: project.id }, { name: "apollo-plan.md", mime: MIME.md, bytes: "# 计划\n\n阿波罗项目的发射窗口是十一月二十日。" });
		const personal = await kbWithDoc(t, alice.token, { name: "我的笔记", scope: "personal" }, { name: "notes.txt", mime: MIME.txt, bytes: "Alice private note: the vault combination is 4417." });
		const dep = addDepartment(t, orgId, "财务部", [alice.me.userId]);
		const deptKb = await kbWithDoc(t, alice.token, { name: "财务制度", scope: "department", departmentId: dep }, { name: "finance.md", mime: MIME.md, bytes: "# 付款\n\n供应商付款周期为月结六十天。" });
		await t.json("POST", "/api/kb", { token: bob.token, json: { name: "x", scope: "org" }, expect: 403 }); // org KB needs admin
		const orgKb = await kbWithDoc(t, alice.token, { name: "企业公告", scope: "org" }, { name: "holiday.txt", mime: MIME.txt, bytes: "Company holiday calendar: offices close on December 31." });

		// Alice (owner of everything) finds each.
		for (const [q, file] of [["发射窗口", "apollo-plan.md"], ["vault combination", "notes.txt"], ["付款周期", "finance.md"], ["holiday calendar", "holiday.txt"]] as const) {
			const r = await search(t, alice.token, { query: q });
			assert.equal(r.citations[0]?.fileName, file, `alice: ${q}`);
		}
		// Bob (same org, not in project, not in department) sees only the org KB.
		assert.deepEqual((await t.json("GET", "/api/kb", { token: bob.token })).kbs.map((k: any) => k.id), [orgKb.kb.id]);
		for (const q of ["发射窗口", "vault combination", "付款周期"]) {
			const r = await search(t, bob.token, { query: q });
			assert.equal(r.citations.length, 0, `bob must not see: ${q}`);
			assert.equal(r.diagnostics.reason, "no_evidence");
			assert.ok(!r.diagnostics.searchedKbIds.includes(proj.kb.id));
		}
		assert.equal((await search(t, bob.token, { query: "holiday calendar" })).citations[0].fileName, "holiday.txt");
		// Explicitly targeting inaccessible KBs → forbidden (not searched at all).
		const forb = await search(t, bob.token, { query: "发射窗口", kbIds: [proj.kb.id, personal.kb.id] });
		assert.equal(forb.citations.length, 0);
		assert.equal(forb.diagnostics.reason, "forbidden");
		assert.deepEqual(forb.diagnostics.searchedKbIds, []);
		assert.deepEqual(forb.diagnostics.forbiddenKbIds.sort(), [proj.kb.id, personal.kb.id].sort());
		// Other org: nothing, even the org KB.
		const eve = await search(t, outsider.token, { query: "holiday calendar", kbIds: [orgKb.kb.id] });
		assert.equal(eve.diagnostics.reason, "forbidden");
		await t.json("GET", `/api/kb/${orgKb.kb.id}`, { token: outsider.token, expect: 404 });

		// Add Bob to project + department → he sees them; remove → next search returns nothing (no cache leak).
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: alice.token, json: { email: "bob@example.com", role: "viewer" } });
		t.app.ctx.db.run("INSERT INTO id_department_members (department_id, user_id, created_at) VALUES (?, ?, ?)", dep, bob.me.userId, new Date().toISOString());
		assert.equal((await search(t, bob.token, { query: "发射窗口" })).citations[0]?.fileName, "apollo-plan.md");
		assert.equal((await search(t, bob.token, { query: "付款周期" })).citations[0]?.fileName, "finance.md");
		// Viewer may read but not add documents.
		const up = await uploadFile(t, alice.token, { name: "extra.txt", mime: MIME.txt, bytes: "extra", projectId: project.id });
		await t.json("POST", `/api/kb/${proj.kb.id}/docs`, { token: bob.token, json: { fileId: up.fileId, versionId: up.versionId }, expect: 403 });

		await t.json("PUT", `/api/projects/${project.id}/members`, { token: alice.token, json: { email: "bob@example.com", role: null } });
		removeFromDepartment(t, dep, bob.me.userId);
		const after = await search(t, bob.token, { query: "发射窗口" });
		assert.equal(after.citations.length, 0);
		assert.ok(!after.diagnostics.searchedKbIds.includes(proj.kb.id));
		assert.equal((await search(t, bob.token, { query: "付款周期" })).citations.length, 0);
		const explicit = await search(t, bob.token, { query: "发射窗口", kbIds: [proj.kb.id] });
		assert.equal(explicit.diagnostics.reason, "forbidden");

		// ACL resolver for ResourceRef kind "kb" (used by other modules) agrees.
		const acl = t.app.ctx.services.get("acl");
		const bobP = (await t.app.ctx.services.get("identity").principalFor(bob.me.userId, orgId))!;
		assert.equal((await acl.check(bobP, "read", { kind: "kb", id: proj.kb.id })).allow, false);
		assert.equal((await acl.check(bobP, "read", { kind: "kb", id: orgKb.kb.id })).allow, true);
		assert.equal((await acl.check(bobP, "write", { kind: "kb", id: orgKb.kb.id })).allow, false);
		// Project context: personal/department KBs are not searched by default in a project conversation.
		const inProject = await search(t, alice.token, { query: "vault combination", projectId: project.id });
		assert.equal(inProject.citations.length, 0);
		assert.ok(inProject.diagnostics.searchedKbIds.includes(proj.kb.id) && inProject.diagnostics.searchedKbIds.includes(orgKb.kb.id));
		assert.ok(!inProject.diagnostics.searchedKbIds.includes(personal.kb.id) && !inProject.diagnostics.searchedKbIds.includes(deptKb.kb.id));
	} finally {
		await t.dispose();
	}
});

test("citations point to the exact file version and PDF page; locators for md/csv", async () => {
	const t = await startTestApp();
	try {
		const alice = await t.user("alice@example.com");
		const pdf = await makePdf(["Introduction to the handbook.\nNothing special here.", "Chapter two describes the zebra crossing clause.\nPedestrians have priority.", "Appendix with contact numbers."]);
		const { kb, file, doc } = await kbWithDoc(t, alice.token, { name: "Handbook", scope: "personal" }, { name: "handbook.pdf", mime: MIME.pdf, bytes: pdf });
		assert.equal(doc.availability, "ready");
		assert.equal(doc.latest.status, "ready");
		assert.equal(doc.latest.pageCount, 3);
		const r = await search(t, alice.token, { query: "zebra crossing clause" });
		const c = r.citations[0];
		assert.equal(c.fileName, "handbook.pdf");
		assert.equal(c.page, 2);
		assert.equal(c.locator, "第 2 页");
		assert.equal(c.fileId, file.fileId);
		assert.equal(c.versionId, file.versionId);
		assert.equal(c.versionNo, 1);
		assert.equal(c.kbId, kb.id);
		assert.equal(c.docId, doc.id);
		assert.match(c.snippet, /zebra crossing clause/);
		assert.ok(c.score > 0);
		// The cited version is downloadable from the files module (citation → exact bytes).
		const dl = await t.req("GET", `/api/files/${c.fileId}/versions/${c.versionId}/download`, { token: alice.token });
		assert.equal(dl.status, 200);
		assert.equal((await dl.arrayBuffer()).byteLength, pdf.byteLength);

		const md = await kbWithDoc(t, alice.token, { name: "Policies", scope: "personal" }, { name: "policy.md", mime: MIME.md, bytes: "# 员工手册\n\n## 考勤\n\n上班时间为九点到六点。\n\n## 请假\n\n病假需要提供医院证明。" });
		const m = (await search(t, alice.token, { query: "医院证明", kbIds: [md.kb.id] })).citations[0];
		assert.equal(m.section, "员工手册 > 请假");
		assert.ok(m.page === undefined);
		assert.match(m.locator, /章节：员工手册 > 请假/);
		const csv = await kbWithDoc(t, alice.token, { name: "Sheets", scope: "personal" }, { name: "people.csv", mime: MIME.csv, bytes: "姓名,部门,工号\n张三,研发,A001\n李四,销售,B002\n" });
		const cc = (await search(t, alice.token, { query: "李四", kbIds: [csv.kb.id] })).citations[0];
		assert.equal(cc.fileName, "people.csv");
		assert.equal(r.diagnostics.vector, "blocked");
		assert.ok(cc.rowStart && cc.rowStart <= 3 && cc.rowEnd! >= 3, `row anchor ${cc.rowStart}-${cc.rowEnd}`);
		assert.equal((await search(t, alice.token, { query: "李四", kbIds: [csv.kb.id] })).diagnostics.strategy, "like");
	} finally {
		await t.dispose();
	}
});

test("new file version re-indexes as a new doc version; v1 citation reports superseded; delete removes from search and cache", async () => {
	const t = await startTestApp();
	try {
		const alice = await t.user("alice@example.com");
		const { kb, file, doc } = await kbWithDoc(t, alice.token, { name: "Prices", scope: "personal" }, { name: "pricing.md", mime: MIME.md, bytes: "# 价格\n\n标准版年费为九千八百元。旧政策条款甲。" });
		const v1 = (await search(t, alice.token, { query: "标准版年费" })).citations[0];
		assert.equal(v1.versionNo, 1);
		// Second identical search is served from the cache (and says so).
		assert.equal((await search(t, alice.token, { query: "标准版年费" })).diagnostics.cached, true);

		// New file version (via files module) → KB follows the file automatically (D notifies C).
		const up2 = await uploadVersion(t, alice.token, file.fileId, { name: "pricing.md", mime: MIME.md, bytes: "# 价格\n\n标准版年费调整为一万二千元。新政策条款乙。", changeNote: "2027 调价" });
		assert.equal(up2.versionNo, 2);
		const d2 = await waitDoc(t, alice.token, kb.id, doc.id, (d) => d.serving?.versionNo === 2);
		assert.equal(d2.latest.versionNo, 2);
		const detail = await t.json("GET", `/api/kb/${kb.id}/docs/${doc.id}`, { token: alice.token });
		assert.equal(detail.versions.length, 2);
		assert.ok(detail.versions.find((v: any) => v.versionNo === 1).supersededAt);

		const now2 = await search(t, alice.token, { query: "标准版年费" });
		assert.equal(now2.diagnostics.cached, undefined, "cache must not serve the pre-update result");
		assert.equal(now2.citations.length, 1);
		assert.equal(now2.citations[0].versionNo, 2);
		assert.equal(now2.citations[0].versionId, up2.versionId);
		assert.equal((await search(t, alice.token, { query: "九千八百元" })).citations.length, 0, "old version chunks are tombstoned");
		assert.ok((await search(t, alice.token, { query: "旧政策条款甲" })).citations.every((c: any) => c.versionNo === 2));

		const s1 = await t.json("GET", `/api/kb/citations/${v1.chunkId}/status`, { token: alice.token });
		assert.equal(s1.status, "superseded");
		assert.equal(s1.cited.versionNo, 1);
		assert.equal(s1.current.versionNo, 2);
		assert.match(s1.message, /v1.*v2/);
		const s2 = await t.json("GET", `/api/kb/citations/${now2.citations[0].chunkId}/status`, { token: alice.token });
		assert.equal(s2.status, "valid");

		// Delete from KB → gone from search immediately; citation status "deleted"; batch status endpoint.
		await search(t, alice.token, { query: "新政策条款乙" }); // warm cache
		await t.json("DELETE", `/api/kb/${kb.id}/docs/${doc.id}`, { token: alice.token });
		const gone = await search(t, alice.token, { query: "新政策条款乙" });
		assert.equal(gone.citations.length, 0);
		assert.equal(gone.diagnostics.cached, undefined);
		const batch = await t.json("POST", "/api/kb/citations/status", { token: alice.token, json: { chunkIds: [v1.chunkId, now2.citations[0].chunkId, "kbc_missing"] } });
		assert.deepEqual(batch.statuses.map((s: any) => s.status), ["deleted", "deleted", "not_found"]);

		// Deleting the file in the files module removes its docs from every KB.
		const other = await kbWithDoc(t, alice.token, { name: "Other", scope: "personal" }, { name: "temp.txt", mime: MIME.txt, bytes: "ephemeral quokka content" });
		assert.equal((await search(t, alice.token, { query: "quokka" })).citations.length, 1);
		await t.json("DELETE", `/api/files/${other.file.fileId}`, { token: alice.token });
		for (let i = 0; i < 20 && (await search(t, alice.token, { query: "quokka" })).citations.length; i++) await new Promise((r) => setTimeout(r, 10));
		assert.equal((await search(t, alice.token, { query: "quokka" })).citations.length, 0);
		assert.equal((await t.json("GET", `/api/kb/${other.kb.id}/docs`, { token: alice.token })).docs.length, 0);
	} finally {
		await t.dispose();
	}
});

test("same-named file in two projects stays isolated", async () => {
	const t = await startTestApp();
	try {
		const { alice, bob } = await orgWithTwo(t);
		const { project: pa } = await t.json("POST", "/api/projects", { token: alice.token, json: { name: "A" } });
		const { project: pb } = await t.json("POST", "/api/projects", { token: bob.token, json: { name: "B" } });
		const a = await kbWithDoc(t, alice.token, { name: "资料", scope: "project", projectId: pa.id }, { name: "plan.md", mime: MIME.md, bytes: "# plan\n\nBudget for project A is 100 units of saffron." });
		const b = await kbWithDoc(t, bob.token, { name: "资料", scope: "project", projectId: pb.id }, { name: "plan.md", mime: MIME.md, bytes: "# plan\n\nBudget for project B is 900 units of cardamom." });
		assert.notEqual(a.file.fileId, b.file.fileId);
		const ra = await search(t, alice.token, { query: "budget for project" });
		assert.deepEqual(ra.citations.map((c: any) => c.kbId), [a.kb.id]);
		assert.match(ra.citations[0].snippet, /saffron/);
		const rb = await search(t, bob.token, { query: "budget for project" });
		assert.deepEqual(rb.citations.map((c: any) => c.kbId), [b.kb.id]);
		assert.match(rb.citations[0].snippet, /cardamom/);
		// Bob cannot add Alice's project file to his KB (file ACL checked on explicit add).
		await t.json("POST", `/api/kb/${b.kb.id}/docs`, { token: bob.token, json: { fileId: a.file.fileId, versionId: a.file.versionId }, expect: 404 });
		// Bob cannot read status of Alice's citation.
		assert.equal((await t.json("GET", `/api/kb/citations/${ra.citations[0].chunkId}/status`, { token: bob.token })).status, "forbidden");
	} finally {
		await t.dispose();
	}
});

test("processing: explicit add, queued → parsing → indexing → ready, failures (unsupported, corrupt, source unavailable) and retry", async () => {
	const t = await startTestApp();
	try {
		const alice = await t.user("alice@example.com");
		const { kb } = await t.json("POST", "/api/kb", { token: alice.token, json: { name: "Inbox", scope: "personal" } });
		// Uploading a file does NOT make it knowledge: nothing is searchable until it is explicitly added.
		const up = await uploadFile(t, alice.token, { name: "memo.txt", mime: MIME.txt, bytes: "The aardvark protocol requires two signatures." });
		assert.equal((await search(t, alice.token, { query: "aardvark protocol" })).diagnostics.reason, "no_evidence");
		assert.deepEqual((await t.json("GET", `/api/kb/files/${up.fileId}/status`, { token: alice.token })).entries, []);

		// Observe every state transition: pause the worker, add, then step.
		const k = knowledgeAdmin(t);
		k.pipeline.pause();
		const { doc } = await t.json("POST", `/api/kb/${kb.id}/docs`, { token: alice.token, json: { fileId: up.fileId, versionId: up.versionId } });
		assert.equal(doc.latest.status, "queued");
		assert.equal(doc.availability, "processing");
		const nr = await search(t, alice.token, { query: "aardvark protocol" });
		assert.equal(nr.diagnostics.reason, "index_not_ready");
		assert.equal(nr.diagnostics.pendingDocs, 1);
		const seen = new Set<string>();
		const origUpdate = t.app.ctx.db.run.bind(t.app.ctx.db);
		(t.app.ctx.db as any).run = (sql: string, ...params: any[]) => {
			if (sql.startsWith("UPDATE kb_doc_versions SET status = ?")) seen.add(params[0]);
			return origUpdate(sql, ...params);
		};
		k.pipeline.resume();
		const ready = await waitDoc(t, alice.token, kb.id, doc.id);
		(t.app.ctx.db as any).run = origUpdate;
		assert.equal(ready.latest.status, "ready");
		assert.ok(seen.has("parsing") && seen.has("indexing"), `saw ${[...seen]}`);
		assert.equal((await search(t, alice.token, { query: "aardvark protocol" })).citations.length, 1);
		const fs = await t.json("GET", `/api/kb/files/${up.fileId}/status`, { token: alice.token });
		assert.equal(fs.entries[0].availability, "ready");

		// Unsupported type → failed, not retryable, clear message.
		const bin = await uploadFile(t, alice.token, { name: "blob.bin", mime: "application/octet-stream", bytes: new Uint8Array([0, 1, 2, 3, 0xff, 0]) });
		const di = (await t.json("POST", `/api/kb/${kb.id}/docs`, { token: alice.token, json: { fileId: bin.fileId, versionId: bin.versionId } })).doc;
		const fi = await waitDoc(t, alice.token, kb.id, di.id);
		assert.equal(fi.latest.status, "failed");
		assert.equal(fi.latest.errorCode, "unsupported_type");
		assert.equal(fi.latest.retryable, false);
		assert.equal(fi.availability, "failed");
		// A broken image goes to OCR and fails there (OCR itself is covered by knowledge-ocr.test.ts).
		const img = await uploadFile(t, alice.token, { name: "scan.png", mime: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) });
		const dimg = (await t.json("POST", `/api/kb/${kb.id}/docs`, { token: alice.token, json: { fileId: img.fileId, versionId: img.versionId } })).doc;
		const fimg = await waitDoc(t, alice.token, kb.id, dimg.id);
		assert.equal(fimg.latest.status, "failed");
		assert.ok(["ocr_failed", "no_text"].includes(String(fimg.latest.errorCode)), String(fimg.latest.errorCode));
		// Corrupt PDF → parse_error.
		const bad = await uploadFile(t, alice.token, { name: "broken.pdf", mime: MIME.pdf, bytes: "%PDF-1.4 this is not really a pdf" });
		const db = (await t.json("POST", `/api/kb/${kb.id}/docs`, { token: alice.token, json: { fileId: bad.fileId, versionId: bad.versionId } })).doc;
		const fb = await waitDoc(t, alice.token, kb.id, db.id);
		assert.equal(fb.latest.status, "failed");
		assert.equal(fb.latest.errorCode, "parse_error");

		// Transient failure (source unreadable in the background) → auto-retries, then failed+retryable; manual retry succeeds.
		k.pipeline.maxAttempts = 2;
		k.pipeline.retryBaseMs = 20;
		const files = t.app.ctx.services.get("files") as any;
		const realGet = files.getVersion.bind(files);
		const up3 = await uploadFile(t, alice.token, { name: "flaky.txt", mime: MIME.txt, bytes: "The pangolin ledger closes quarterly." });
		let sourceDown = false;
		files.getVersion = async (p: any, vid: string) => (sourceDown && vid === up3.versionId ? null : realGet(p, vid));
		k.pipeline.pause();
		const d3 = (await t.json("POST", `/api/kb/${kb.id}/docs`, { token: alice.token, json: { fileId: up3.fileId, versionId: up3.versionId } })).doc; // caller read OK
		sourceDown = true;
		k.pipeline.resume();
		const f3 = await waitDoc(t, alice.token, kb.id, d3.id, (d) => d.latest.status === "failed");
		assert.equal(f3.latest.errorCode, "source_unavailable");
		assert.equal(f3.latest.retryable, true);
		assert.equal(f3.latest.attempts, 2);
		assert.equal((await search(t, alice.token, { query: "pangolin ledger", kbIds: [kb.id], docIds: [d3.id] })).diagnostics.reason, "index_not_ready");
		sourceDown = false;
		const retried = (await t.json("POST", `/api/kb/${kb.id}/docs/${d3.id}/retry`, { token: alice.token })).doc;
		assert.equal(retried.latest.status, "queued");
		const ok = await waitDoc(t, alice.token, kb.id, d3.id);
		assert.equal(ok.latest.status, "ready");
		assert.equal((await search(t, alice.token, { query: "pangolin ledger" })).citations.length, 1);
		files.getVersion = realGet;
		await t.json("POST", `/api/kb/${kb.id}/docs/${d3.id}/retry`, { token: alice.token, expect: 409 });
	} finally {
		await t.dispose();
	}
});

test("processing survives restart: queued and interrupted (running) jobs resume on start()", async () => {
	const t1 = await startTestApp();
	const dataDir = t1.dataDir;
	let t2: TestApp | undefined;
	try {
		const alice = await t1.user("alice@example.com");
		const { kb } = await t1.json("POST", "/api/kb", { token: alice.token, json: { name: "Durable", scope: "personal" } });
		knowledgeAdmin(t1).pipeline.pause();
		const a = await uploadFile(t1, alice.token, { name: "a.txt", mime: MIME.txt, bytes: "The ocelot memo was queued before shutdown." });
		const b = await uploadFile(t1, alice.token, { name: "b.txt", mime: MIME.txt, bytes: "The narwhal memo was mid-parse when the process died." });
		const da = (await t1.json("POST", `/api/kb/${kb.id}/docs`, { token: alice.token, json: { fileId: a.fileId, versionId: a.versionId } })).doc;
		const dbb = (await t1.json("POST", `/api/kb/${kb.id}/docs`, { token: alice.token, json: { fileId: b.fileId, versionId: b.versionId } })).doc;
		// Simulate a crash in the middle of b's job: job 'running', version 'parsing'.
		t1.app.ctx.db.run("UPDATE kb_jobs SET state = 'running', attempt = 1, owner_instance = 'dead' WHERE doc_version_id = ?", dbb.latest.docVersionId);
		t1.app.ctx.db.run("UPDATE kb_doc_versions SET status = 'parsing', attempts = 1 WHERE id = ?", dbb.latest.docVersionId);
		await t1.stop();

		t2 = await startTestApp({ dataDir });
		const token = (await t2.json("POST", "/api/auth/login", { json: { email: "alice@example.com", password: "password123" } })).token;
		const ra = await waitDoc(t2, token, kb.id, da.id);
		const rb = await waitDoc(t2, token, kb.id, dbb.id);
		assert.equal(ra.latest.status, "ready");
		assert.equal(rb.latest.status, "ready");
		assert.equal(rb.latest.attempts, 2, "interrupted attempt counted, then resumed");
		assert.equal((await search(t2, token, { query: "narwhal memo" })).citations[0].fileName, "b.txt");
		assert.equal((await search(t2, token, { query: "ocelot memo" })).citations[0].fileName, "a.txt");
	} finally {
		await t2?.stop();
		await t1.dispose();
	}
});

test("governance: owner, version label, effective/expired/withdrawn; inactive docs excluded by default; replacement", async () => {
	const t = await startTestApp();
	try {
		const { alice, bob } = await orgWithTwo(t);
		const { kb: orgKb, doc: oldDoc } = await kbWithDoc(t, alice.token, { name: "制度库", scope: "org" }, { name: "报销制度-2025.md", mime: MIME.md, bytes: "# 报销\n\n报销需在十五日内提交（2025 版）。" });
		const gov = (await t.json("PATCH", `/api/kb/${orgKb.id}/docs/${oldDoc.id}/governance`, {
			token: alice.token,
			json: { kind: "policy", responsibleUserId: bob.me.userId, versionLabel: "2025 版", status: "effective", effectiveFrom: "2025-01-01T00:00:00Z" },
		})).doc.governance;
		assert.equal(gov.kind, "policy");
		assert.equal(gov.responsibleName, "bob");
		assert.equal(gov.versionLabel, "2025 版");
		assert.equal(gov.effectiveStatus, "effective");
		assert.ok(gov.updatedAt);
		const c2025 = (await search(t, bob.token, { query: "十五日内提交" })).citations[0];
		assert.equal(c2025.fileName, "报销制度-2025.md");
		// Bob (plain member) cannot change governance of an org KB.
		await t.json("PATCH", `/api/kb/${orgKb.id}/docs/${oldDoc.id}/governance`, { token: bob.token, json: { status: "withdrawn" }, expect: 403 });

		// Expiry in the past → excluded from default retrieval; visible with includeInactive; citation status "expired".
		await t.json("PATCH", `/api/kb/${orgKb.id}/docs/${oldDoc.id}/governance`, { token: alice.token, json: { expiresAt: new Date(Date.now() - 1000).toISOString() } });
		assert.equal((await search(t, bob.token, { query: "十五日内提交" })).citations.length, 0);
		assert.equal((await search(t, bob.token, { query: "十五日内提交", includeInactive: true })).citations.length, 1);
		assert.equal((await t.json("GET", `/api/kb/citations/${c2025.chunkId}/status`, { token: bob.token })).status, "expired");
		const listed = (await t.json("GET", `/api/kb/${orgKb.id}/docs`, { token: bob.token })).docs[0];
		assert.equal(listed.governance.effectiveStatus, "expired");
		assert.equal(listed.governance.retrievable, false);

		// Replacement: new policy doc; old one is withdrawn (with link) once the replacement is ready.
		await t.json("PATCH", `/api/kb/${orgKb.id}/docs/${oldDoc.id}/governance`, { token: alice.token, json: { expiresAt: null } });
		assert.equal((await search(t, bob.token, { query: "十五日内提交" })).citations.length, 1);
		const up = await uploadFile(t, alice.token, { name: "报销制度-2026.md", mime: MIME.md, bytes: "# 报销\n\n报销需在三十日内提交（2026 版）。" });
		const newDoc = (await t.json("POST", `/api/kb/${orgKb.id}/docs`, { token: alice.token, json: { fileId: up.fileId, versionId: up.versionId, governance: { kind: "policy", versionLabel: "2026 版", status: "effective" } } })).doc;
		await waitDoc(t, alice.token, orgKb.id, newDoc.id);
		const repl = (await t.json("PATCH", `/api/kb/${orgKb.id}/docs/${oldDoc.id}/governance`, { token: alice.token, json: { replacedByDocId: newDoc.id } })).doc.governance;
		assert.equal(repl.status, "withdrawn");
		assert.equal(repl.replacedByDocId, newDoc.id);
		const r = await search(t, bob.token, { query: "报销需在提交" });
		assert.deepEqual(r.citations.map((c: any) => c.fileName), ["报销制度-2026.md"]);
		const st = await t.json("GET", `/api/kb/citations/${c2025.chunkId}/status`, { token: bob.token });
		assert.equal(st.status, "withdrawn");
		assert.match(st.message, /替换/);
		// Drafts are not retrievable by default either.
		await t.json("PATCH", `/api/kb/${orgKb.id}/docs/${newDoc.id}/governance`, { token: alice.token, json: { status: "draft" } });
		assert.equal((await search(t, bob.token, { query: "三十日内提交" })).citations.length, 0);
		await t.json("PATCH", `/api/kb/${orgKb.id}/docs/${newDoc.id}/governance`, { token: alice.token, json: { status: "bogus" }, expect: 400 });
	} finally {
		await t.dispose();
	}
});

test("KB management: maintainers, rename, delete KB; capabilities (vector blocked, OCR ready)", async () => {
	const t = await startTestApp();
	try {
		const { alice, bob, orgId } = await orgWithTwo(t);
		const dep = addDepartment(t, orgId, "HR", [alice.me.userId]);
		const { kb } = await kbWithDoc(t, alice.token, { name: "HR 制度", scope: "department", departmentId: dep }, { name: "hr.txt", mime: MIME.txt, bytes: "Probation lasts three months for the capybara team." });
		await t.json("GET", `/api/kb/${kb.id}`, { token: bob.token, expect: 404 });
		// Maintainer outside the department may read and write.
		await t.json("PUT", `/api/kb/${kb.id}/maintainers`, { token: alice.token, json: { email: "bob@example.com", maintainer: true } });
		const asBob = (await t.json("GET", `/api/kb/${kb.id}`, { token: bob.token })).kb;
		assert.deepEqual(asBob.permissions, { read: true, write: true, admin: false });
		assert.equal((await search(t, bob.token, { query: "probation lasts" })).citations.length, 1);
		await t.json("PATCH", `/api/kb/${kb.id}`, { token: bob.token, json: { name: "x" }, expect: 403 });
		await t.json("PATCH", `/api/kb/${kb.id}`, { token: alice.token, json: { name: "人事制度" } });
		await t.json("PUT", `/api/kb/${kb.id}/maintainers`, { token: alice.token, json: { email: "bob@example.com", maintainer: false } });
		assert.equal((await search(t, bob.token, { query: "probation lasts" })).citations.length, 0);
		const r = await search(t, alice.token, { query: "probation lasts" });
		assert.equal(r.citations[0].kbName, "人事制度");
		await t.json("DELETE", `/api/kb/${kb.id}`, { token: alice.token });
		assert.equal((await search(t, alice.token, { query: "probation lasts" })).citations.length, 0);
		assert.equal((await t.json("GET", `/api/kb/citations/${r.citations[0].chunkId}/status`, { token: alice.token })).status, "deleted");
		const caps = await t.json("GET", "/api/kb/capabilities", { token: alice.token });
		assert.equal(caps.fulltext.status, "ready");
		assert.equal(caps.vector.status, "blocked");
		assert.equal(caps.ocr.status, "ready");
		assert.ok(caps.formats.includes("image"));
		await kbIdle(t);
	} finally {
		await t.dispose();
	}
});
