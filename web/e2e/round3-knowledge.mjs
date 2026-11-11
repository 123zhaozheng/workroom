// Round 3 — knowledge rows: M07-A scope selection, M07-B governance (owner/version/effective/expiry, withdraw, replace),
// M07-C distinct failure messages, M06-B page/section/version on citations, M06-C deleted/withdrawn/forbidden notices,
// M08-C storage vs knowledge state on the file page, M10-A/C memory with source/scope and a visible correction.
// Run: npm run -w web build && node web/e2e/round3-knowledge.mjs
import { createRequire } from "node:module";
import { join } from "node:path";
import { check, chromium, register, sendMessage, shot, SHOTS, sleep, startServer, summary, pick, selOptions } from "./lib.mjs";

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts } = require("pdf-lib");

async function twoPagePdf() {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	doc.addPage([595, 842]).drawText("Travel policy overview. General rules for business trips.", { x: 50, y: 780, size: 14, font });
	doc.addPage([595, 842]).drawText("Reimbursement deadline: claims must be filed within 30 days with original invoices.", { x: 50, y: 780, size: 12, font });
	return Buffer.from(await doc.save());
}

const server = await startServer({ port: 8852 });
const base = server.base;
const browser = await chromium.launch();
const idle = (page, t = 60000) => page.waitForSelector('[data-testid="stop"]', { state: "detached", timeout: t });
const waitDocs = async (req, kbId, pred) => {
	for (let i = 0; i < 80; i++) {
		const d = await (await req.get(`${base}/api/kb/${kbId}/docs`)).json();
		if (pred(d.docs ?? [])) return d.docs;
		await sleep(400);
	}
	throw new Error("docs did not settle");
};
try {
	const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
	const a = await ctxA.newPage();
	await register(a, base, { email: `ka-${Date.now()}@example.com`, name: "知识管理员" });
	const me = await (await a.request.get(`${base}/api/me`)).json();
	const sp = me.personalSpaceId;
	const proj = (await (await a.request.post(`${base}/api/projects`, { data: { kind: "space", name: "华东项目" } })).json()).project;
	const dept = (await (await a.request.post(`${base}/api/admin/departments`, { data: { name: "市场部" } })).json()).department;
	await a.request.put(`${base}/api/admin/departments/${dept.id}/members`, { data: { userId: me.me.userId, role: "manager" } });
	const code = (await (await a.request.post(`${base}/api/admin/invites`, { data: { role: "member", ttlHours: 24 } })).json()).invite.code;
	const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
	const b = await ctxB.newPage();
	const bEmail = `kb-${Date.now()}@example.com`;
	await b.goto(`${base}/register?invite=${code}`);
	await b.fill("#name", "项目成员乙");
	await b.fill("#email", bEmail);
	await b.fill("#password", "password123");
	await b.click('button[type="submit"]');
	await b.waitForSelector('[data-testid="home-greeting"]');
	await a.request.put(`${base}/api/projects/${proj.id}/members`, { data: { email: bEmail, role: "editor" } });

	// ---------------------------------------------------------------- M07-A: choose the scope when creating
	const created = {};
	for (const [name, scope, extra] of [["个人笔记", "personal"], ["项目资料", "project", proj.id], ["市场部资料", "department", dept.id], ["企业制度", "org"]]) {
		await a.goto(`${base}/knowledge`);
		await a.getByRole("button", { name: "新建知识库" }).first().click();
		await a.fill("#kbname", name);
		await pick(a.locator('[data-testid="kb-scope"]'), scope);
		if (scope === "project") await pick(a.locator('[data-testid="kb-scope-project"]'), extra);
		if (scope === "department") await pick(a.locator('[data-testid="kb-scope-department"]'), extra);
		await a.getByRole("button", { name: "创建" }).click();
		await a.waitForURL(/\/knowledge\/.+/);
		created[name] = a.url().split("/knowledge/")[1];
	}
	await a.goto(`${base}/knowledge`);
	await a.waitForFunction(() => document.querySelectorAll('[data-testid="kb-card"]').length === 4);
	const aList = await a.locator('[data-testid="kb-card"]').allInnerTexts();
	check("M07-A: personal / project / department / org scopes chosen in the UI", ["个人", "项目", "部门", "企业"].every((t) => aList.some((x) => x.includes(t))), aList.map((x) => x.split("\n")[0]).join(" | "));
	await shot(a, "1440-kb-scopes-admin");
	await b.goto(`${base}/knowledge`);
	await b.waitForSelector('[data-testid="kb-card"]');
	await sleep(500);
	const bList = (await b.locator('[data-testid="kb-card"]').allInnerTexts()).map((x) => x.split("\n")[0]).join(" | ");
	check("M07-A: a project member (not in the department) sees only project + org knowledge", bList.includes("项目资料") && bList.includes("企业制度") && !bList.includes("个人笔记") && !bList.includes("市场部资料"), bList);
	await shot(b, "1440-kb-scopes-member");

	// ---------------------------------------------------------------- M07-B: governance on 企业制度
	const orgKb = created["企业制度"];
	const up = async (name, text, space = sp) => (await (await a.request.post(`${base}/api/files`, { multipart: { spaceId: space, file: { name, mimeType: "text/markdown", buffer: Buffer.from(text) } } })).json());
	const old = await up("差旅制度-旧.md", "# 差旅制度\n\n住宿标准每晚 400 元。\n");
	const neu = await up("差旅制度-新.md", "# 差旅制度\n\n住宿标准每晚 500 元。\n");
	for (const f of [old, neu]) await a.request.post(`${base}/api/kb/${orgKb}/docs`, { data: { fileId: f.file.id, versionId: f.version.versionId } });
	await waitDocs(a.request, orgKb, (d) => d.length === 2 && d.every((x) => x.availability === "ready"));
	await a.goto(`${base}/knowledge/${orgKb}`);
	const oldRow = a.locator('[data-testid="kb-doc"]', { hasText: "差旅制度-旧.md" });
	await oldRow.locator('[data-testid="gov-edit"]').click();
	const form = oldRow.locator('[data-testid="gov-form"]');
	await pick(form.locator("[data-wr-select]").first(), "policy");
	await pick(form.locator("[data-wr-select]").nth(1), "effective");
	for (let i = 0; i < 60 && !(await selOptions(form.locator('[data-testid="gov-owner"]'))).some((o) => o.label === "知识管理员"); i++) await sleep(250);
	await pick(form.locator('[data-testid="gov-owner"]'), { label: "知识管理员" });
	await form.locator('[data-testid="gov-version"]').fill("2025 版");
	await form.locator('[data-testid="gov-expires"]').fill("2027-12-31");
	await form.locator('[data-testid="gov-save"]').click();
	await a.waitForFunction(() => [...document.querySelectorAll('[data-testid="kb-doc"]')].some((e) => e.textContent?.includes("2025 版") && e.textContent?.includes("责任人")), null, { timeout: 10000 });
	const g1 = await oldRow.locator('[data-testid="governance"]').innerText();
	check("M07-B: owner, version label, effective status and expiry shown after editing", g1.includes("制度") && g1.includes("生效中") && g1.includes("责任人 知识管理员") && g1.includes("2025 版") && g1.includes("2027-12-31"), g1);
	await oldRow.locator('[data-testid="gov-edit"]').click();
	await pick(oldRow.locator('[data-testid="gov-replace"]'), { label: "差旅制度-新.md" });
	await oldRow.locator('[data-testid="gov-save"]').click();
	await a.waitForFunction(() => [...document.querySelectorAll('[data-testid="kb-doc"]')].some((e) => e.textContent?.includes("已由「差旅制度-新.md」替换")), null, { timeout: 10000 });
	check("M07-B: replace → old version withdrawn and pointing at its replacement, excluded from default retrieval", (await oldRow.innerText()).includes("已下架") && (await oldRow.innerText()).includes("默认不参与检索"));
	await shot(a, "1440-kb-governance");

	// ---------------------------------------------------------------- M07-C: distinct failure messages
	await a.fill('input[placeholder^="输入一个问题"]', "火星基地补给");
	await a.getByRole("button", { name: "检索", exact: true }).click();
	await a.waitForSelector('[data-testid="kb-search-result"]');
	const noEv = await a.locator('[data-testid="kb-search-result"]').innerText();
	const badKb = (await (await a.request.post(`${base}/api/kb`, { data: { name: "只有坏文件", scope: "personal" } })).json()).kb.id;
	const badFile = (await (await a.request.post(`${base}/api/files`, { multipart: { spaceId: sp, file: { name: "损坏.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 73) % 256)) } } })).json());
	await a.request.post(`${base}/api/kb/${badKb}/docs`, { data: { fileId: badFile.file.id, versionId: badFile.version.versionId } });
	await waitDocs(a.request, badKb, (d) => d[0]?.availability === "failed");
	await a.goto(`${base}/knowledge/${badKb}`);
	await a.fill('input[placeholder^="输入一个问题"]', "任何问题");
	await a.getByRole("button", { name: "检索", exact: true }).click();
	await a.waitForSelector('[data-testid="kb-search-result"]');
	const notReady = await a.locator('[data-testid="kb-search-result"]').innerText();
	await b.goto(`${base}/knowledge/${created["个人笔记"]}`);
	await b.fill('input[placeholder^="输入一个问题"]', "任何问题");
	await b.getByRole("button", { name: "检索", exact: true }).click();
	await b.waitForSelector('[data-testid="kb-search-result"], p.text-danger', { timeout: 10000 });
	const forb = await b.locator("main").innerText();
	check("M07-C: no_evidence / index_not_ready / forbidden have different messages", noEv.includes("没有找到相关证据") && notReady.includes("索引尚未就绪") && /没有权限|无权/.test(forb), [noEv.split("\n")[0], notReady.split("\n")[0], (forb.match(/没有权限|无权[^\n]*/) ?? [""])[0]].join(" | "));
	await shot(b, "1440-kb-search-forbidden");
	await a.goto(`${base}/`);
	await sendMessage(a, "[[fail]] 模型这次会出错");
	await a.waitForSelector('[data-testid="run-bar"][data-status="failed"]', { timeout: 60000 });
	check("M07-C: model errors are reported as model errors (not as missing evidence)", (await a.locator('[data-testid="error-note"]').last().innerText()).includes("模型调用出错") && !/没有找到相关证据/.test(await a.locator('[data-testid="run-bar"]').innerText())); // round 10: the reason is shown once, inline in the message; the bar above the input is only 失败 + 重试

	// ---------------------------------------------------------------- M06-B: PDF page + version on citation chips
	const notes = created["个人笔记"];
	const pdf = (await (await a.request.post(`${base}/api/files`, { multipart: { spaceId: sp, file: { name: "travel-policy.pdf", mimeType: "application/pdf", buffer: await twoPagePdf() } } })).json());
	const del = await up("删除测试.md", "# 条款\n\n斑马条款：外勤补贴每天 80 元。\n");
	const wd = await up("下架测试.md", "# 条款\n\n袋鼠条款：远程办公每周两天。\n");
	for (const f of [pdf, del, wd]) await a.request.post(`${base}/api/kb/${notes}/docs`, { data: { fileId: f.file.id, versionId: f.version.versionId } });
	const docs = await waitDocs(a.request, notes, (d) => d.length === 3 && d.every((x) => x.availability === "ready"));
	await a.goto(`${base}/`);
	await a.locator('[data-testid="composer-input"]').fill("/");
	await a.locator('[data-testid="composer-input"]').press("Enter");
	await a.getByRole("button", { name: /个人笔记/ }).click();
	await sendMessage(a, '报销时限是多少 [[call kb_search {"query":"Reimbursement deadline"}]]');
	await a.waitForURL(/\/c\//);
	const citeUrl = a.url();
	await a.waitForSelector('[data-testid="citation"]', { timeout: 30000 });
	await idle(a);
	const c1 = await a.locator('[data-testid="citation"]').first().innerText();
	check("M06-B: citation shows file, version and page (PDF page 2)", c1.includes("travel-policy.pdf") && c1.includes("v1") && c1.includes("第 2 页"), c1.replace(/\s+/g, " "));
	await sendMessage(a, '[[call kb_search {"query":"斑马条款"}]]');
	await a.waitForFunction(() => document.querySelectorAll('[data-testid="citations"]').length >= 2, null, { timeout: 30000 });
	await idle(a);
	const c2 = await a.locator('[data-testid="citations"]').nth(1).innerText();
	check("M06-B: non-paged sources show section / paragraph", /章节|段/.test(c2), c2.replace(/\s+/g, " ").slice(0, 120));
	await sendMessage(a, '[[call kb_search {"query":"袋鼠条款"}]]');
	await a.waitForFunction(() => document.querySelectorAll('[data-testid="citations"]').length >= 3, null, { timeout: 30000 });
	await idle(a);
	await a.locator('[data-testid="citations"]').first().scrollIntoViewIfNeeded();
	await shot(a, "1440-citation-page-version");

	// ---------------------------------------------------------------- M06-C: deleted / withdrawn / forbidden notices on old answers
	const dDel = docs.find((x) => x.fileName === "删除测试.md");
	const dWd = docs.find((x) => x.fileName === "下架测试.md");
	await a.request.delete(`${base}/api/kb/${notes}/docs/${dDel.id}`);
	await a.request.patch(`${base}/api/kb/${notes}/docs/${dWd.id}/governance`, { data: { status: "withdrawn" } });
	await a.goto(citeUrl);
	await a.waitForSelector('[data-testid="citation"][data-status="deleted"]', { timeout: 15000 });
	await a.waitForSelector('[data-testid="citation"][data-status="withdrawn"]', { timeout: 15000 });
	check("M06-C: deleted and withdrawn sources are flagged on the old answer (snapshot kept)", (await a.locator('[data-testid="citations-stale-banner"]').count()) === 1 && (await a.locator('[data-testid="citation"][data-status="valid"]').count()) >= 1);
	await a.locator('[data-testid="citation"][data-status="deleted"]').scrollIntoViewIfNeeded();
	await shot(a, "1440-citation-deleted-withdrawn");
	// forbidden: A cites a personal KB in a project conversation; editor B can read the conversation, not the KB
	await a.goto(`${base}/projects/${proj.id}`);
	await a.locator('[data-testid="composer-input"]').fill("/");
	await a.locator('[data-testid="composer-input"]').press("Enter");
	await a.getByRole("button", { name: /个人笔记/ }).click();
	await sendMessage(a, '[[call kb_search {"query":"Reimbursement deadline"}]]');
	await a.waitForURL(/\/c\//);
	await a.waitForSelector('[data-testid="citation"]', { timeout: 30000 });
	await idle(a);
	await b.goto(a.url());
	await b.waitForSelector('[data-testid="citation"][data-status="forbidden"]', { timeout: 15000 });
	const fb = await b.locator('[data-testid="citation"]').first().innerText();
	check("M06-C: a member without access sees the notice, not the cited snippet", !fb.includes("Reimbursement") && !fb.includes("travel-policy"), fb);
	await shot(b, "1440-citation-forbidden");

	// ---------------------------------------------------------------- M08-C: storage state vs knowledge state, explicit add
	await a.goto(`${base}/files`);
	await a.setInputFiles('input[type="file"]', { name: "季度计划.md", mimeType: "text/markdown", buffer: Buffer.from("# 季度计划\n\n第四季度重点：渠道拓展。\n") });
	await a.waitForSelector('[data-testid="file-row"]:has-text("季度计划.md")', { timeout: 10000 });
	await a.locator('[data-testid="file-row"]', { hasText: "季度计划.md" }).locator("a").click();
	await a.waitForSelector('[data-testid="knowledge-status"]');
	await sleep(800);
	const k0 = await a.locator('[data-testid="knowledge-status"]').innerText();
	check("M08-C: after upload the file is stored but NOT in any knowledge base (explicit step)", k0.includes("未加入") && (await a.locator("main").innerText()).includes("存储：已保存"), k0);
	await shot(a, "1440-file-storage-vs-knowledge");
	await a.getByRole("button", { name: "加入知识库" }).click();
	await pick(a.locator('[data-wr-select][aria-label="知识库"]'), { label: "个人笔记" });
	await a.getByRole("button", { name: "加入", exact: true }).click();
	await a.waitForSelector("text=已加入，正在索引", { timeout: 10000 });
	await a.keyboard.press("Escape");
	await a.waitForFunction(() => document.querySelector('[data-testid="knowledge-status"]')?.textContent?.includes("个人笔记"), null, { timeout: 15000 });
	await a.waitForFunction(() => document.querySelector('[data-testid="knowledge-status"]')?.textContent?.includes("可检索"), null, { timeout: 30000 });
	check("M08-C: after the explicit add, knowledge state moves to 可检索 separately from storage", true);
	await shot(a, "1440-file-knowledge-ready");

	// ---------------------------------------------------------------- M10-A / M10-C: memory with source & scope, edit, correct, delete
	await a.goto(`${base}/`);
	await sendMessage(a, '记住我的偏好 [[call memory_save {"content":"周报使用英文","scope":"private","kind":"preference"}]]');
	await a.waitForURL(/\/c\//);
	await idle(a);
	await a.goto(`${base}/memory`);
	await a.fill('textarea[placeholder^="例如"]', "汇报对象是销售总监");
	await a.getByRole("button", { name: "添加" }).click();
	await a.waitForFunction(() => document.querySelectorAll('[data-testid="memory-item"]').length === 2, null, { timeout: 10000 });
	const items = await a.locator('[data-testid="memory-item"]').allInnerTexts();
	check("M10-A: memories show source (manual / extracted from a conversation, with link) and scope", items.some((t) => t.includes("从对话提取") && t.includes("来源对话")) && items.some((t) => t.includes("手动添加")) && items.every((t) => t.includes("仅自己")), items.map((t) => t.replace(/\s+/g, " ").slice(0, 60)).join(" | "));
	const extracted = a.locator('[data-testid="memory-item"]', { hasText: "周报使用英文" });
	await extracted.locator('[data-testid="memory-correct"]').click();
	await extracted.locator('textarea[aria-label="纠正后的内容"]').fill("周报使用中文");
	await extracted.locator('input[placeholder^="为什么纠正"]').fill("团队统一用中文");
	await extracted.locator('[data-testid="memory-correct-save"]').click();
	await a.waitForSelector('[data-testid="memory-correction-result"]', { timeout: 10000 });
	const res = await a.locator('[data-testid="memory-correction-result"]').innerText();
	check("M10-C: correction shows 已纠正 with before / after (round 11: no explanatory 被替代 / 按新内容理解 sentences)", res.includes("已纠正") && res.includes("周报使用英文") && res.includes("周报使用中文") && !res.includes("被替代") && !res.includes("按新内容理解"), res.replace(/\s+/g, " "));
	await shot(a, "1440-memory-correction");
	const manual = a.locator('[data-testid="memory-item"]', { hasText: "汇报对象是销售总监" });
	await manual.getByRole("button", { name: "编辑" }).click();
	const editingItem = a.locator('[data-testid="memory-item"]:has(textarea)');
	await editingItem.locator("textarea").fill("汇报对象是销售副总裁");
	await editingItem.getByRole("button", { name: "保存" }).click();
	await a.waitForFunction(() => document.body.innerText.includes("汇报对象是销售副总裁"), null, { timeout: 10000 });
	a.once("dialog", (d) => d.accept());
	await a.locator('[data-testid="memory-item"]', { hasText: "汇报对象是销售副总裁" }).getByRole("button", { name: "删除" }).click();
	await a.waitForFunction(() => !document.body.innerText.includes("汇报对象是销售副总裁"), null, { timeout: 10000 });
	check("M10-A: edit and delete work from the memory page", true);
	const corrected = a.locator('[data-testid="memory-item"]', { hasText: "周报使用中文" });
	await corrected.locator('[data-testid="memory-history"]').click();
	await a.waitForSelector('[data-testid="memory-revisions"] li', { timeout: 10000 });
	check("M10-C: history of the memory is visible", (await a.locator('[data-testid="memory-revisions"]').innerText()).length > 0);
	await ctxA.close();
	await ctxB.close();
} catch (e) {
	check("script completed", false, String(e?.stack ?? e));
} finally {
	await browser.close();
	await server.stop();
}
process.exitCode = summary(join(SHOTS, "round3-knowledge.results.json")) ? 0 : 1;
