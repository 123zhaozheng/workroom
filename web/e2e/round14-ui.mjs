// Round 14 · delivery UI (docs/r14-virtual-backend.md §3, requirement §7.4), checked in a real browser against the fixture model:
//  right panel   three blocks 输出 | 子任务 | 浏览器 in one card, counts, empty state 创建输出内容, ☰ toggle, 390px without horizontal scroll
//  V08  an upload shows on its message and is NOT in 输出 / cards / the files page
//  V12+V21  present_file → card (name, type, size, preview, download), preview and download show the same content, no version text
//  V14  the same name delivered again updates the same card and the same 输出 entry (no duplicate)
//  V22  withdraw from the files page → cards show 已删除, 输出 drops it, download is 404
//  V23  write / exec generated files create no card and no 输出 entry; read / ls / copy results and screenshots never create one (view model)
// Run: npm run -s build:web && node web/e2e/round14-ui.mjs        (port 8996)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { check, chromium, register, sleep, startServer, summary, SHOTS } from "./lib.mjs";

const DIR = join(SHOTS, "round14");
mkdirSync(DIR, { recursive: true });
const PORT = 8996;
const server = await startServer({ port: PORT, env: { WORKROOM_FIXTURE_TPS: "200", WORKROOM_RT_RETRY_MAX: "0" } });
const base = server.base;
const browser = await chromium.launch();
const T = (id) => `[data-testid="${id}"]`;
const call = (tool, args) => `[[call ${tool} ${JSON.stringify(args)}]]`;
const shot = (page, name) => page.screenshot({ path: join(DIR, `${name}.png`), fullPage: false });

try {
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
	const page = await ctx.newPage();
	await register(page, base, { email: "r14ui@example.com", name: "十四" });

	/** Send a message from the composer and wait until its turn has settled (the n-th assistant message is not running any more). */
	let turns = 0;
	const say = async (text, files) => {
		if (files) await page.setInputFiles(T("file-input"), files);
		if (files) await page.waitForFunction(() => !document.querySelector('[data-testid="tile-state"]')?.textContent?.includes("上传中"), null, { timeout: 15000 });
		await page.fill(T("composer-input"), text);
		await page.click(T("send"));
		turns++;
		if (turns === 1) await page.waitForURL(/\/c\/[^/]+\/\d+/);
		await page.waitForFunction((n) => {
			const chains = document.querySelectorAll('[data-testid="assistant-message"]');
			const last = chains[n - 1];
			if (!last) return false;
			const c = last.querySelector('[data-testid="step-chain"]');
			return !!c && ["done", "error", "stopped"].includes(c.getAttribute("data-state") ?? "") && !!last.querySelector('[data-testid="run-summary"]');
		}, turns, { timeout: 90000 });
		await sleep(250);
	};
	const chatUrl = () => page.url();
	const cards = () => page.locator(T("file-card"));
	const panelOpen = async () => {
		if ((await page.locator(T("work-panel")).count()) === 0) await page.click(T("open-work-panel"));
		await page.waitForSelector(T("work-panel"));
	};
	const countOf = async (id) => Number((await page.locator(T(`block-${id}-count`)).innerText()).replace(/\D/g, ""));
	const unfold = async (turnIndex) => {
		const msg = page.locator(T("assistant-message")).nth(turnIndex);
		const sum = msg.locator(`${T("run-summary")}`);
		if ((await sum.evaluate((el) => el.tagName)) === "BUTTON" && (await sum.getAttribute("aria-expanded")) === "false") await sum.click();
		return msg;
	};

	// ---------------- right panel: structure, empty state, toggle
	await say(`先看看目录 ${call("ls", { path: "/" })}`);
	check("panel: the ☰ button keeps its test id and the panel is closed at first", (await page.locator(T("open-work-panel")).count()) === 1 && (await page.locator(T("work-panel")).count()) === 0);
	await page.click(T("open-work-panel"));
	await page.waitForSelector(T("work-panel"));
	const blocks = await page.locator(`${T("work-panel")} section[data-testid^="block-"]`).evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
	check("panel: exactly three blocks 输出 | 子任务 | 浏览器, in that order", JSON.stringify(blocks) === JSON.stringify(["block-outputs", "block-tasks", "block-browser"]), blocks.join(","));
	const heads = await page.locator(`${T("work-panel")} section[data-testid^="block-"] > button`).allInnerTexts();
	check("panel: each header is title · count with a chevron", heads.length === 3 && /^输出\s*· 0/.test(heads[0]) && /^子任务\s*· 0/.test(heads[1]) && /^浏览器\s*· 0/.test(heads[2]), heads.join(" | "));
	check("panel: no old tabs (子任务 / 终端 / 文件 / 浏览器)", (await page.locator('[data-testid^="work-tab-"]').count()) === 0 && !(await page.locator(T("work-panel")).innerText()).includes("终端"));
	check("panel: 输出 is empty → the grey placeholder 创建输出内容", (await page.locator(T("outputs-empty")).innerText()).trim() === "创建输出内容");
	const oneCard = await page.locator(`${T("work-panel")} > div`).last().evaluate((el) => ({ rounded: getComputedStyle(el).borderRadius, n: el.children.length }));
	check("panel: the three blocks live in ONE rounded card", oneCard.n === 3 && parseFloat(oneCard.rounded) >= 12, JSON.stringify(oneCard));
	await shot(page, "panel-empty");
	await page.click(T("block-outputs-toggle"));
	check("panel: a block collapses and expands through its header", (await page.locator(T("outputs-empty")).count()) === 0);
	await page.click(T("block-outputs-toggle"));
	await page.click(T("open-work-panel"));
	check("panel: the ☰ toggle collapses the whole panel", (await page.locator(T("work-panel")).count()) === 0);

	// ---------------- V08: an upload stays on its message
	await say("看看这个附件", { name: "销售.csv", mimeType: "text/csv", buffer: Buffer.from("品类,金额\n拿铁,30\n美式,20\n") });
	check("V08 the upload shows on its message", (await page.locator(T("message-attachment")).filter({ hasText: "销售.csv" }).count()) === 1);
	check("V08 no file card for it", (await cards().count()) === 0);
	await panelOpen();
	check("V08 it is not in 输出 (count 0, placeholder shown)", (await countOf("outputs")) === 0 && (await page.locator(T("output-item")).count()) === 0 && (await page.locator(T("outputs-empty")).count()) === 1);
	await page.click(T("open-work-panel"));

	// ---------------- V23: write / exec files are not deliveries
	await say(`${call("write", { path: "/work/a.md", content: "# 报告\n第一版内容" })} ${call("exec", { command: "echo hello-exec > /work/b.txt && echo done-exec" })}`);
	check("V23 write + exec-generated files create no card", (await cards().count()) === 0);
	await panelOpen();
	check("V23 …and no 输出 entry", (await countOf("outputs")) === 0);
	await page.click(T("open-work-panel"));
	let msg = await unfold(turns - 1);
	const titles = await msg.locator(T("tool-step")).evaluateAll((els) => els.map((e) => e.innerText));
	check("steps: wording 写入「a.md」 / 运行命令", titles.some((t) => t.includes("写入「a.md」")) && titles.some((t) => t.includes("运行命令")), titles.join(" || ").slice(0, 300));
	const ex = msg.locator(`${T("tool-step")}[data-tool="exec"]`);
	await ex.locator("button").first().click();
	const body = await ex.innerText();
	check("steps: exec shows the command as input and stdout as output", /命令/.test(body) && body.includes("echo hello-exec") && /输出/.test(body) && body.includes("done-exec"), body.slice(0, 300));

	// ---------------- V12 / V21: deliver → card
	await say(call("present_file", { source: "/work/a.md" }));
	await page.waitForSelector(T("file-card"), { timeout: 15000 });
	const card = cards().first();
	const cardText = await card.innerText();
	check("V12 the card has the name, type and size", cardText.includes("a.md") && /文本|文档/.test(cardText) && /\d+(\.\d+)?\s?(B|KB)/.test(cardText), cardText.replace(/\n/g, " | "));
	check("V21 no version text on the card (no v1 / 版本)", !/\bv\d+\b/i.test(cardText) && !cardText.includes("版本") && (await page.locator(T("file-version")).count()) === 0);
	const fileId = await card.getAttribute("data-file-id");
	const href = await card.locator('a[aria-label^="下载"]').getAttribute("href");
	const dl = await page.request.get(`${base}${href}`);
	check("V12 the download link serves the delivered content", dl.status() === 200 && (await dl.text()) === "# 报告\n第一版内容");
	msg = await unfold(turns - 1);
	check("steps: present_file reads 交付文件「a.md」 · 已交付「a.md」", /交付文件「a\.md」/.test(await msg.locator(T("tool-step")).first().innerText()) && /已交付「a\.md」/.test(await msg.locator(T("tool-step")).first().innerText()));
	await card.locator('button[aria-label^="预览"]').click();
	await page.waitForSelector(T("preview-panel"));
	await page.waitForSelector(T("preview-text"), { timeout: 15000 });
	const pv = await page.locator(T("preview-panel")).innerText();
	check("V12 the preview shows the delivered content", pv.includes("第一版内容") && (await page.locator(T("preview-name")).innerText()) === "a.md");
	check("V21 the preview has no version picker / version text", (await page.locator(T("version-switch")).count()) === 0 && !/\bv\d+\b/.test(pv));
	check("V12 the preview has a download button for the same file", (await page.locator(T("preview-download")).getAttribute("href"))?.startsWith(`/api/files/${fileId}/download`) === true);
	await shot(page, "card-preview");
	await page.click(T("open-work-panel")); // preview → work panel
	await page.waitForSelector(T("work-panel"));
	const row = page.locator(T("output-item"));
	check("panel: 输出 shows the delivered file (icon, name, size) and nothing else", (await countOf("outputs")) === 1 && (await row.count()) === 1 && /a\.md/.test(await row.innerText()) && /\d+(\.\d+)?\s?(B|KB)/.test(await row.innerText()) && !/\bv\d+\b/.test(await row.innerText()));
	check("panel: the uploaded csv and the exec-generated b.txt are not listed", !(await page.locator(T("block-outputs")).innerText()).match(/销售\.csv|b\.txt/));
	await shot(page, "panel-outputs");
	const size1 = await row.innerText();

	// ---------------- V14: same name delivered again
	await page.click(T("open-work-panel"));
	await say(`${call("write", { path: "/work/a.md", content: "# 报告\n第二版：内容更长一些，用来确认大小和内容都更新了。" })} ${call("present_file", { source: "/work/a.md" })} ${call("present_file", { source: "/work/a.md" })}`);
	const all = cards();
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="file-card"]').length >= 2);
	const ids = await all.evaluateAll((els) => els.map((e) => e.getAttribute("data-file-id")));
	const lastMsgCards = await page.locator(T("assistant-message")).nth(turns - 1).locator(T("file-card")).count();
	check("V14 the same name keeps the same fileId (old and new card), one card per file inside a turn", ids.length === 2 && ids[0] === ids[1] && ids[0] === fileId && lastMsgCards === 1, ids.join(","));
	const sizes = await all.evaluateAll((els) => els.map((e) => e.querySelector('[data-testid="file-meta"]')?.textContent));
	check("V14 the old card shows the CURRENT size (it resolves through the outputs)", sizes[0] === sizes[1] && sizes[0] !== null, sizes.join(" / "));
	await panelOpen();
	check("V14 输出 still has one entry, with the new size", (await countOf("outputs")) === 1 && (await row.count()) === 1 && (await row.innerText()) !== size1, await row.innerText());
	const dl2 = await page.request.get(`${base}${href}`);
	check("V14 the download link serves the new content (no v2, no stale bytes)", (await dl2.text()).includes("第二版"));
	await page.click(T("open-work-panel"));
	await all.first().locator('button[aria-label^="预览"]').click();
	await page.waitForSelector(T("preview-text"), { timeout: 15000 });
	check("V14 previewing from the OLD card shows the current content", (await page.locator(T("preview-panel")).innerText()).includes("第二版"));
	// an overwrite while the preview is open swaps its content live
	await page.fill(T("composer-input"), `${call("write", { path: "/work/a.md", content: "# 报告\n第三版：预览打开时被覆盖" })} ${call("present_file", { source: "/work/a.md" })}`);
	await page.click(T("send"));
	turns++;
	await page.waitForFunction(() => document.querySelector('[data-testid="preview-text"]')?.textContent?.includes("第三版"), null, { timeout: 60000 });
	check("V14 an overwrite refreshes an open preview (cache keyed by the content hash)", true);
	await page.waitForFunction((n) => document.querySelectorAll('[data-testid="assistant-message"]').length >= n && document.querySelectorAll('[data-testid="run-summary"]').length >= n, turns, { timeout: 60000 });
	await sleep(400);

	// ---------------- files page: only outputs, grouped by conversation, no versions
	const convUrl = chatUrl();
	await page.goto(`${base}/files`);
	await page.waitForSelector(T("file-row"), { timeout: 15000 });
	const rows = await page.locator(T("file-row")).allInnerTexts();
	check("V12 the files page lists the delivered output once, under its conversation folder", rows.length === 1 && rows[0].includes("a.md") && (await page.locator(T("files-folder")).count()) === 1 && /--c\d+/.test((await page.locator(T("files-folder")).getAttribute("data-folder")) ?? ""), rows.join("|"));
	const pageText = await page.locator("body").innerText();
	check("V08 the upload is not on the files page", !pageText.includes("销售.csv") && !pageText.includes("b.txt"));
	check("V21 the files page has no version text, no upload / origin controls", !/\bv\d+\b/.test(pageText) && !pageText.includes("上传") && !pageText.includes("来源") && (await page.locator(T("files-upload")).count()) === 0);
	await page.locator(T("file-row")).first().locator("a").click();
	await page.waitForSelector(T("file-preview"), { timeout: 15000 });
	await page.waitForSelector(T("preview-text"), { timeout: 15000 });
	const detail = await page.locator(T("file-detail")).innerText();
	check("V12 the file page shows the current content, no versions, no 上传新版本", detail.includes("第三版") && (await page.locator(T("version-item")).count()) === 0 && !detail.includes("上传新版本") && !/版本/.test(detail), detail.slice(0, 200));
	await shot(page, "files-page");

	// ---------------- 390px: no horizontal scroll
	await page.goto(convUrl);
	await page.waitForSelector(T("file-card"), { timeout: 20000 });
	await page.setViewportSize({ width: 390, height: 844 });
	await sleep(400);
	const ov1 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
	await page.click(T("open-work-panel"));
	await page.waitForSelector(T("work-panel"));
	await sleep(500);
	const ov2 = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - window.innerWidth, panel: (() => { const p = document.querySelector('[data-testid="work-panel"]'); return p.scrollWidth - p.clientWidth; })() }));
	check("390px: the chat and the open panel have no horizontal scroll", ov1 <= 0 && ov2.doc <= 0 && ov2.panel <= 0, JSON.stringify({ ov1, ...ov2 }));
	check("390px: the three blocks are all there", (await page.locator(`${T("work-panel")} section[data-testid^="block-"]`).count()) === 3);
	await shot(page, "panel-390");
	await page.keyboard.press("Escape");
	await page.goto(`${base}/files`);
	await page.waitForSelector(T("file-row"), { timeout: 15000 });
	check("390px: the files page has no horizontal scroll", (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0);
	await page.setViewportSize({ width: 1280, height: 860 });
	await sleep(300);

	// ---------------- V22: withdraw from the files page
	await page.goto(`${base}/files`);
	await page.waitForSelector(T("file-row"));
	await page.locator(T("file-delete")).first().click();
	await page.waitForSelector(T("remove-output-dialog"));
	check("V22 deleting asks first and says what happens", /已删除/.test(await page.locator(T("remove-output-dialog")).innerText()));
	await page.getByRole("button", { name: "删除", exact: true }).last().click();
	await page.waitForSelector(T("files-empty"), { timeout: 15000 });
	check("V22 the files page no longer lists it", (await page.locator(T("file-row")).count()) === 0);
	await page.goto(convUrl);
	await page.waitForFunction(() => document.querySelectorAll('[data-testid="file-card"][data-removed="true"]').length >= 2, null, { timeout: 20000 });
	const gone = await cards().allInnerTexts();
	check("V22 the old cards show 已删除 with no download and no preview", gone.length === 2 && gone.every((t) => t.includes("已删除")) && (await cards().locator("a").count()) === 0 && (await cards().locator("button").count()) === 0, gone.join("|"));
	await panelOpen();
	check("V22 输出 drops it (count 0, placeholder back)", (await countOf("outputs")) === 0 && (await page.locator(T("outputs-empty")).count()) === 1);
	const dl3 = await page.request.get(`${base}${href}`);
	check("V22 the download is gone (404)", dl3.status() === 404, String(dl3.status()));
	await shot(page, "withdrawn");

	// ---------------- V23 (view model): what must never become a card
	const { buildTurns } = await import("../src/features/chat/model.ts");
	const mk = (id, name, details, args = {}) => [
		{ kind: "assistant", id: id * 2, timestamp: 1, text: "", thinking: "", model: { provider: "p", modelId: "m" }, toolCalls: [{ id: `c${id}`, name, arguments: args }], stopReason: "toolUse", fixture: true, usage: undefined },
		{ kind: "tool_result", id: id * 2 + 1, callId: `c${id}`, toolName: name, text: "ok", isError: false, timestamp: 2, details },
	];
	const file = { fileId: "f1", versionId: "v1", versionNo: 3, name: "x.png", mime: "image/png", size: 5, sha256: "h" };
	const item = { fileId: "f9", path: "/library/x/a.md", name: "a.md", mime: "text/markdown", size: 9, etag: "e", status: "active", spaceId: "s", conversationId: 1, folder: "x", updatedAt: "t", previewUrl: "", downloadUrl: "" };
	const cardsFor = (entries) => buildTurns(entries, { live: { busy: false, tools: [] }, approvals: [] }).flatMap((t) => (t.kind === "assistant" ? t.artifacts : []));
	check("V23 a browser screenshot (details.screenshot / artifact on browse) never creates a card", cardsFor([...mk(1, "browse", { screenshot: file, artifact: file }), ...mk(2, "browser_open", { artifact: file })]).length === 0);
	check("V23 read / ls / copy_to_work / exec / job results never create a card", cardsFor([...mk(1, "read", { kind: "wr.vfs.read", path: "/work/a", etag: "e" }), ...mk(2, "ls", { kind: "wr.vfs.ls" }), ...mk(3, "copy_to_work", { kind: "wr.vfs.copy", artifact: file }), ...mk(4, "exec", { artifact: file }), ...mk(5, "job_start", { job: { id: "j", outputs: [file] } })]).length === 0);
	check("V23 present_file (wr.presented) creates one card; two deliveries of one fileId dedupe", cardsFor([...mk(1, "present_file", { kind: "wr.presented", status: "created", item }), ...mk(2, "present_file", { kind: "wr.presented", status: "updated", item: { ...item, size: 20 } })]).length === 1);
	const legacy = cardsFor(mk(1, "file_create", { artifact: { ...file, name: "旧.docx" } }));
	check("history: a legacy file_create result still renders one card by fileId, with no version in it", legacy.length === 1 && legacy[0].fileId === "f1" && !("versionNo" in legacy[0]) && !("versionId" in legacy[0]));
	check("history: a legacy browse screenshot is still never a card", cardsFor(mk(1, "sandbox_exec", { artifacts: [file] })).length === 0);
} catch (e) {
	console.error(e);
	check("round14-ui ran to the end", false, String(e).slice(0, 400));
} finally {
	await browser.close();
	await server.stop();
}
const ok = summary(join(SHOTS, "round14-ui.json"));
process.exitCode = ok ? 0 : 1;
