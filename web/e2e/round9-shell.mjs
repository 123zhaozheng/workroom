// Round 9 · U1: sidebar projects tree + motion, "…" menus, project sharing dialog, Ctrl/Cmd+K search, chat position rail.
// Run: npm run -w web build && node web/e2e/round9-shell.mjs      (real server on port 8920; nothing is intercepted except the checks labelled "[intercepted]")
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, chromium, register, SHOTS, sleep, startServer, summary } from "./lib.mjs";

const PORT = 8920;
const server = await startServer({ port: PORT });
const base = server.base;
const browser = await chromium.launch();
const shotDir = join(SHOTS, "round9");
const snap = async (page, name) => {
	await sleep(350); // let entrance animations finish
	return page.screenshot({ path: join(shotDir, `u1-${name}.png`) });
};
const MOD = process.platform === "darwin" ? "Meta" : "Control";

let ok = false;
let debugPage;
try {
	// ------------------------------------------------------------------ setup: owner + a second person in the same organisation
	const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", acceptDownloads: true });
	await ctxA.addInitScript(() => {
		// FLIP spy: every Element.animate() on a sidebar row records its id and keyframes.
		window.__flips = [];
		window.__ghosts = 0;
		new MutationObserver((ms) => {
			for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && n.hasAttribute("data-flip-ghost")) window.__ghosts++;
		}).observe(document, { childList: true, subtree: true });
		const orig = Element.prototype.animate;
		Element.prototype.animate = function (...a) {
			try {
				const id = this.getAttribute?.("data-flip-id");
				if (id) window.__flips.push({ id, kf: JSON.stringify(a[0]), dur: a[1]?.duration });
			} catch {}
			return orig.apply(this, a);
		};
	});
	const A = await ctxA.newPage();
	debugPage = A;
	const errors = [];
	A.on("pageerror", (e) => errors.push(e.message));
	await register(A, base, { email: "owner@r9.example", name: "所有者" });
	const api = ctxA.request;
	const inv = (await (await api.post(`${base}/api/admin/invites`, { data: { role: "member", ttlHours: 24 } })).json()).invite.code;
	const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	const rb = await ctxB.request.post(`${base}/api/auth/register`, { data: { email: "lisi@r9.example", name: "李四", password: "password123", inviteCode: inv } });
	check("setup: second organisation member registered", rb.ok());
	const B = await ctxB.newPage();
	B.on("pageerror", (e) => errors.push(`B: ${e.message}`));

	const J = async (r) => r.json();
	const mkConv = async (title, extra = {}) => (await J(await api.post(`${base}/api/conversations`, { data: { title, ...extra } }))).conversation;
	const entriesOf = async (c, a = api) => (await J(await a.get(`${base}/api/conversations/${c.spaceId}/${c.conversationId}/state`))).entries ?? [];
	const send = async (c, text) => {
		const before = (await entriesOf(c)).filter((e) => e.kind === "assistant").length;
		await api.post(`${base}/api/conversations/${c.spaceId}/${c.conversationId}/messages`, { data: { text, requestId: `r-${Math.random().toString(36).slice(2)}`, mode: "auto" } });
		for (let i = 0; i < 80; i++) {
			await sleep(150);
			const es = await entriesOf(c);
			if (es.filter((e) => e.kind === "assistant").length > before) return;
		}
		throw new Error(`no assistant reply for: ${text}`);
	};
	const detailOf = async (c) => (await J(await api.get(`${base}/api/conversations/${c.spaceId}/${c.conversationId}`))).conversation;
	const keyOf = (c) => `${c.spaceId}/${c.conversationId}`;
	const row = (page, c) => page.locator(`[data-testid="conv-row"][data-conv="${keyOf(c)}"]`);
	const projectBlock = (page, id) => page.locator(`[data-testid="project"][data-project="${id}"]`);
	const flips = (page) => page.evaluate(() => window.__flips.slice());
	const projectsApi = async () => (await J(await api.get(`${base}/api/projects`))).projects;

	// ------------------------------------------------------------------ 1. a project is created from the sidebar, then a conversation inside it
	await A.goto(`${base}/`);
	await A.waitForSelector('[data-testid="sidebar"]');
	await A.click('[data-testid="new-project"]');
	await A.fill("#pname", "季度复盘");
	await A.click('[data-testid="new-project-create"]');
	await A.waitForURL(/\/projects\/prj_/);
	const projectId = A.url().split("/projects/")[1];
	check("project: created from the sidebar (+), its page opens", (await A.locator('[data-testid="project-title"]').innerText()) === "季度复盘");
	const created = (await projectsApi()).find((p) => p.id === projectId);
	check("project: real API record is a container project owned by the caller", created?.kind === "container" && created?.access === "owner" && created?.name === "季度复盘", JSON.stringify(created));
	const pb = projectBlock(A, projectId);
	check("sidebar: the new project is in the tree and open", (await pb.count()) === 1 && (await pb.getAttribute("data-open")) === "true");

	await pb.locator('[data-testid="project-new-chat"]').click();
	await A.waitForURL(/\/c\//);
	const inProj = { spaceId: A.url().split("/c/")[1].split("/")[0], conversationId: Number(A.url().split("/c/")[1].split("/")[1]) };
	check("project: ＋ 新对话 creates a conversation with projectId and opens it", (await detailOf(inProj)).projectId === projectId);
	await A.waitForSelector('[data-testid="chat-empty"]');
	await sleep(300);
	await A.fill('[data-testid="composer-input"]', "项目里的第一个问题：请汇总第三季度目标 [[reply 好的，已汇总季度目标。]]");
	await A.click('[data-testid="send"]');
	await A.waitForSelector('[data-testid="assistant-message"] .wr-prose', { timeout: 20000 });
	await A.waitForFunction((id) => document.querySelector(`[data-testid="project"][data-project="${id}"] [data-testid="conv-row"]`)?.textContent?.includes("项目里的第一个问题"), projectId, { timeout: 10000 });
	check("sidebar: the conversation sits under its project with the server-derived title", (await pb.locator('[data-testid="conv-row"]').count()) === 1);
	check("sidebar: a conversation inside a project is not repeated under 最近对话", (await A.locator('[data-testid="group-recent"] [data-testid="conv-row"]').count()) === 0);
	check("chat: a short conversation has no position rail", (await A.locator('[data-testid="position-rail"]').count()) === 0);

	// ------------------------------------------------------------------ 2. moving an existing conversation in and out (FLIP), nothing lost
	const x = await mkConv("周报草稿");
	await send(x, "请润色这份周报，关键词紫罗兰 [[reply 已润色紫罗兰周报。]]");
	await A.goto(`${base}/`);
	await A.waitForSelector(`[data-testid="conv-row"][data-conv="${keyOf(x)}"]`);
	check("sidebar: a conversation without a project is under 最近对话", (await A.locator(`[data-testid="group-recent"] [data-testid="conv-row"][data-conv="${keyOf(x)}"]`).count()) === 1);
	const before = (await entriesOf(x)).length;
	await A.evaluate(() => (window.__flips.length = 0));
	await row(A, x).hover();
	await row(A, x).locator('[data-testid="conv-menu"]').click();
	await A.click('[data-testid="menu-move"]');
	await A.waitForSelector('[data-testid="menu-move-to"]');
	check("menu: 移至项目 lists my container projects", (await A.locator('[data-testid="menu-move-to"]').count()) === 1 && (await A.locator('[data-testid="menu-move-out"]').count()) === 0);
	await A.click(`[data-testid="menu-move-to"][data-project="${projectId}"]`);
	await A.waitForFunction(([id, k]) => !!document.querySelector(`[data-testid="project"][data-project="${id}"] [data-testid="conv-row"][data-conv="${k}"]`), [projectId, keyOf(x)], { timeout: 8000 });
	const fl = await flips(A);
	check("motion: the moved row (and the ones it displaced) were animated with WAAPI FLIP, ~250 ms", fl.some((f) => f.id === `c:${keyOf(x)}` && f.kf.includes("translate") && f.dur === 250), JSON.stringify(fl.slice(0, 3)));
	check("move: real API says the conversation now belongs to the project", (await detailOf(x)).projectId === projectId);
	check("move: nothing lost — same entries, title intact", (await entriesOf(x)).length === before && (await detailOf(x)).title === "周报草稿");
	check("move: it left 最近对话", (await A.locator(`[data-testid="group-recent"] [data-testid="conv-row"][data-conv="${keyOf(x)}"]`).count()) === 0);

	await A.evaluate(() => (window.__flips.length = 0));
	await row(A, x).hover();
	await row(A, x).locator('[data-testid="conv-menu"]').click();
	await A.click('[data-testid="menu-move"]');
	await A.click('[data-testid="menu-move-out"]');
	await A.waitForFunction((k) => !!document.querySelector(`[data-testid="group-recent"] [data-testid="conv-row"][data-conv="${k}"]`), keyOf(x), { timeout: 8000 });
	check("move: 移出项目 puts it back under 最近对话", (await detailOf(x)).projectId === undefined && (await entriesOf(x)).length === before);
	check("motion: moving out animates too", (await flips(A)).some((f) => f.id === `c:${keyOf(x)}`));
	// back in for the sharing part
	await row(A, x).hover();
	await row(A, x).locator('[data-testid="conv-menu"]').click();
	await A.click('[data-testid="menu-move"]');
	await A.click(`[data-testid="menu-move-to"][data-project="${projectId}"]`);
	await A.waitForFunction(([id, k]) => !!document.querySelector(`[data-testid="project"][data-project="${id}"] [data-testid="conv-row"][data-conv="${k}"]`), [projectId, keyOf(x)], { timeout: 8000 });

	// ------------------------------------------------------------------ 3. expand / collapse is remembered per user
	await pb.locator('[data-testid="project-toggle"]').click();
	await sleep(400);
	check("sidebar: collapsing hides the rows (inert) and flips aria-expanded", (await pb.locator('[data-testid="project-toggle"]').getAttribute("aria-expanded")) === "false" && (await pb.locator("[inert]").count()) >= 1 && (await pb.locator("[inert]").first().evaluate((el) => el.getBoundingClientRect().height)) < 2);
	await A.reload();
	await A.waitForSelector(`[data-testid="project"][data-project="${projectId}"]`);
	check("sidebar: the collapsed state survives a reload (localStorage, per user)", (await projectBlock(A, projectId).getAttribute("data-open")) === "false");
	const stored = await A.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith("wr.sidebar.") && k.endsWith(".projects")).map(([k, v]) => `${k}=${v}`));
	check("sidebar: the key carries the user id", stored.length === 1 && /wr\.sidebar\.usr_/.test(stored[0]), stored.join());
	await projectBlock(A, projectId).locator('[data-testid="project-toggle"]').click();
	await sleep(400);
	check("sidebar: opening shows the rows again", (await projectBlock(A, projectId).locator('[data-testid="conv-row"]').first().isVisible()) === true);

	// ------------------------------------------------------------------ 4. rename a project from the menu (inline)
	await projectBlock(A, projectId).locator('[data-testid="project-menu"]').click({ force: true });
	await A.click('[data-testid="project-rename"]');
	await A.fill('[data-testid="project-rename-input"]', "Q3 复盘");
	await A.keyboard.press("Enter");
	await A.waitForFunction((id) => document.querySelector(`[data-testid="project"][data-project="${id}"]`)?.textContent?.includes("Q3 复盘"), projectId, { timeout: 8000 });
	check("project: inline rename reaches the server", (await projectsApi()).find((p) => p.id === projectId)?.name === "Q3 复盘");

	// ------------------------------------------------------------------ 5. share with a second person; they see it read only; revoke
	await projectBlock(A, projectId).locator('[data-testid="project-menu"]').click({ force: true });
	await A.click('[data-testid="project-share-open"]');
	await A.waitForSelector('[data-testid="share-project-dialog"]');
	const note = await A.locator('[data-testid="share-permission-note"]').innerText();
	check("share dialog: the permission is explained in the agreed words", note.includes("只读：可以查看此项目中的对话和成果，不能发送消息或确认操作"), note);
	await A.fill('[data-testid="share-search"]', "李");
	await A.waitForSelector('[data-testid="share-candidate"]');
	check("share dialog: same-organisation directory search finds the colleague (not myself)", (await A.locator('[data-testid="share-candidate"]').count()) === 1 && (await A.locator('[data-testid="share-candidate"]').innerText()).includes("李四"));
	await snap(A, "1440-share-dialog");
	await A.click('[data-testid="share-candidate"] button');
	await A.waitForSelector('[data-testid="share-member"]');
	check("share dialog: the grant is listed as 只读 with a revoke button", (await A.locator('[data-testid="share-member"]').innerText()).includes("只读") && (await A.locator('[data-testid="share-revoke-user"]').count()) === 1);
	const shares = (await J(await api.get(`${base}/api/projects/${projectId}/shares`))).shares;
	check("share: real API lists the share with permission read", shares.length === 1 && shares[0].permission === "read" && shares[0].name === "李四");
	await A.keyboard.press("Escape");

	await B.goto(`${base}/`);
	await B.waitForSelector('[data-testid="group-shared-label"]', { timeout: 10000 });
	const shareBlock = B.locator(`[data-testid="project"][data-project="${projectId}"]`);
	check("sidebar (colleague): the project is under 共享给我, read only, no ⋯ menu and no ＋ 新对话", (await B.locator('[data-testid="group-shared-label"]').innerText()) === "共享给我" && (await shareBlock.getAttribute("data-access")) === "shared_read" && (await shareBlock.locator('[data-testid="project-menu"]').count()) === 0 && (await shareBlock.locator('[data-testid="project-new-chat"]').count()) === 0);
	await shareBlock.locator('[data-testid="project-toggle"]').click();
	await sleep(500);
	check("sidebar (colleague): the owner's conversations of the project are listed", (await shareBlock.locator('[data-testid="conv-row"]').count()) === 2, String(await shareBlock.locator('[data-testid="conv-row"]').count()));
	await shareBlock.locator("a", { hasText: "Q3 复盘" }).first().click();
	await B.waitForSelector('[data-testid="project-readonly-note"]');
	check("project page (colleague): read-only note, no composer, conversations listed", (await B.locator('[data-testid="composer-input"]').count()) === 0 && (await B.locator('[data-testid="project-conversation"]').count()) === 2 && (await B.locator('[data-testid="project-readonly-note"]').innerText()).includes("不能发送消息或确认操作"));
	await B.locator('[data-testid="project-conversation"]', { hasText: "周报草稿" }).click();
	await B.waitForSelector('[data-testid="read-only-note"]');
	await B.waitForSelector('[data-testid="user-message"]');
	check("chat (colleague): can read the conversation, composer is disabled (replaced by the read-only note)", (await B.locator('[data-testid="composer-input"]').count()) === 0 && (await B.locator('[data-testid="read-only-note"]').innerText()).includes("只读"));
	const bRow = B.locator(`[data-testid="conv-row"][data-conv="${keyOf(x)}"]`);
	await bRow.hover();
	await bRow.locator('[data-testid="conv-menu"]').click();
	check("menu (colleague): only what a reader may do — 星标 and 导出, no rename / tags / move / archive / delete", (await B.locator('[data-testid="menu-star"]').count()) === 1 && (await B.locator('[data-testid="menu-export"]').count()) === 1 && (await B.locator('[data-testid="menu-rename"],[data-testid="menu-tags"],[data-testid="menu-move"],[data-testid="menu-archive"],[data-testid="menu-delete"],[data-testid="menu-share"]').count()) === 0);
	await B.keyboard.press("Escape");
	// the server refuses writes from the colleague as well
	const bSend = await ctxB.request.post(`${base}/api/conversations/${x.spaceId}/${x.conversationId}/messages`, { data: { text: "我想插话", requestId: "b-1", mode: "auto" } });
	check("share: the server refuses a message from the colleague", bSend.status() === 403 || bSend.status() === 404, String(bSend.status()));
	await snap(B, "1440-shared-readonly");

	// revoke
	await projectBlock(A, projectId).locator('[data-testid="project-menu"]').click({ force: true });
	await A.click('[data-testid="project-share-open"]');
	await A.waitForSelector('[data-testid="share-member"]');
	await A.click('[data-testid="share-revoke-user"]');
	await A.waitForFunction(() => document.querySelectorAll('[data-testid="share-member"]').length === 0);
	check("share dialog: revoke removes the person from the list", true);
	await A.keyboard.press("Escape");
	const afterRevoke = await ctxB.request.get(`${base}/api/conversations/${x.spaceId}/${x.conversationId}`);
	check("share: access is gone at once (real API 403/404 for the colleague)", afterRevoke.status() === 403 || afterRevoke.status() === 404, String(afterRevoke.status()));
	await B.goto(`${base}/`);
	await B.waitForSelector('[data-testid="sidebar"]');
	await sleep(800);
	check("sidebar (colleague): the project disappears after revoke", (await B.locator(`[data-testid="project"][data-project="${projectId}"]`).count()) === 0 && (await B.locator('[data-testid="group-shared-label"]').count()) === 0);
	await B.goto(`${base}/c/${x.spaceId}/${x.conversationId}`);
	await sleep(1500);
	check("chat (colleague): opening the old link shows no messages", (await B.locator('[data-testid="user-message"]').count()) === 0);

	// ------------------------------------------------------------------ 6. delete a project: conversations stay
	const y = await mkConv("临时项目里的对话");
	const tmp = (await J(await api.post(`${base}/api/projects`, { data: { name: "临时项目" } }))).project;
	await api.put(`${base}/api/conversations/${y.spaceId}/${y.conversationId}/project`, { data: { projectId: tmp.id } });
	await A.reload();
	await A.waitForSelector(`[data-testid="project"][data-project="${tmp.id}"]`);
	await projectBlock(A, tmp.id).locator('[data-testid="project-menu"]').click({ force: true });
	await A.click('[data-testid="project-delete"]');
	const dtxt = await A.locator('[data-testid="confirm-delete-project"]').innerText();
	check("delete project: the dialog says conversations are kept and move back to 最近对话", dtxt.includes("不会被删除") && dtxt.includes("最近对话"), dtxt.replace(/\s+/g, " "));
	await A.click('[data-testid="confirm-ok"]');
	await A.waitForFunction((id) => !document.querySelector(`[data-testid="project"][data-project="${id}"]`), tmp.id, { timeout: 8000 });
	await A.waitForFunction((k) => !!document.querySelector(`[data-testid="group-recent"] [data-testid="conv-row"][data-conv="${k}"]`), keyOf(y), { timeout: 8000 });
	check("delete project: the project is gone, the conversation is in 最近对话 and still exists", (await detailOf(y)).title === "临时项目里的对话" && !(await projectsApi()).some((p) => p.id === tmp.id));

	// ------------------------------------------------------------------ 6b. a legacy project (own space) keeps working, labelled 旧版
	const legacyRes = await api.post(`${base}/api/projects`, { data: { kind: "space", name: "旧版项目甲" } });
	const legacy = (await J(legacyRes)).project;
	check("legacy: a project with its own space can still be created (kind space)", legacyRes.ok() && legacy?.kind === "space" && !!legacy?.spaceId, JSON.stringify(legacy));
	const lc = await mkConv("旧版项目里的对话", { projectId: legacy.id });
	await A.reload();
	await A.waitForSelector(`[data-testid="project"][data-project="${legacy.id}"]`);
	check("sidebar: a legacy project shows the quiet 旧版 label", (await projectBlock(A, legacy.id).locator('[data-testid="project-legacy"]').innerText()) === "旧版");
	await projectBlock(A, legacy.id).locator('[data-testid="project-toggle"]').click();
	await A.waitForSelector(`[data-testid="conv-row"][data-conv="${keyOf(lc)}"]`);
	await sleep(350);
	await projectBlock(A, legacy.id).locator('[data-testid="project-menu"]').click({ force: true });
	check("menu (legacy project): 重命名 and 项目设置 only — no sharing, no delete", (await A.locator('[data-testid="project-rename"]').count()) === 1 && (await A.locator('[data-testid="project-settings"]').count()) === 1 && (await A.locator('[data-testid="project-share-open"],[data-testid="project-delete"]').count()) === 0);
	await A.keyboard.press("Escape");
	await row(A, lc).hover();
	await row(A, lc).locator('[data-testid="conv-menu"]').click();
	const mv = A.locator('[data-testid="menu-move"]');
	check("menu (legacy conversation): 移至项目 is disabled and says why", (await mv.getAttribute("data-disabled")) !== null && (await mv.innerText()).includes("旧版项目中的对话不能移动"));
	await A.keyboard.press("Escape");
	await A.goto(`${base}/projects/${legacy.id}`);
	await A.waitForSelector('[data-testid="project-env"]');
	check("project page: a legacy project keeps its own page (environment, members, 旧版 badge)", (await A.locator('[data-testid="members"]').count()) === 1 && (await A.locator("main").innerText()).includes("旧版"));
	await A.goto(`${base}/`);
	await A.waitForSelector('[data-testid="sidebar"]');

	// ------------------------------------------------------------------ 7. conversation menu: star, rename, tags, export, archive, delete
	const s1 = await mkConv("星标测试");
	await send(s1, "导出内容：蓝莓蛋糕配方 [[reply 好的，蓝莓蛋糕配方如下。]]");
	const z = await mkConv("删除测试");
	await send(z, "这里提到橙子协议 [[reply 收到橙子协议。]]");
	await A.reload();
	await A.waitForSelector(`[data-testid="conv-row"][data-conv="${keyOf(s1)}"]`);
	// star
	await row(A, s1).hover();
	await row(A, s1).locator('[data-testid="conv-menu"]').click();
	await A.evaluate(() => (window.__flips.length = 0));
	await A.click('[data-testid="menu-star"]');
	await A.waitForSelector(`[data-testid="group-starred"] [data-testid="conv-row"][data-conv="${keyOf(s1)}"]`);
	check("star: the conversation floats into the 星标 group and leaves 最近对话", (await A.locator('[data-testid="group-starred"]').getAttribute("aria-label")) === "星标" && (await A.locator(`[data-testid="group-recent"] [data-testid="conv-row"][data-conv="${keyOf(s1)}"]`).count()) === 0);
	const meta1 = (await J(await api.get(`${base}/api/conversation-meta`))).items.find((i) => i.conversationId === s1.conversationId && i.spaceId === s1.spaceId);
	check("star: real API stores it per user", meta1?.starred === true);
	check("motion: star → the row moved with FLIP", (await flips(A)).some((f) => f.id === `c:${keyOf(s1)}`));
	await row(A, s1).hover();
	await row(A, s1).locator('[data-testid="conv-menu"]').click();
	check("menu: a starred conversation offers 取消星标", (await A.locator('[data-testid="menu-star"]').innerText()).includes("取消星标"));
	await A.click('[data-testid="menu-star"]');
	await A.waitForFunction((k) => !!document.querySelector(`[data-testid="group-recent"] [data-testid="conv-row"][data-conv="${k}"]`), keyOf(s1), { timeout: 8000 });
	check("star: unstar returns it to 最近对话 (group disappears)", (await A.locator('[data-testid="group-starred"]').count()) === 0);

	// rename (inline): Enter commits, Esc cancels
	await row(A, s1).hover();
	await row(A, s1).locator('[data-testid="conv-menu"]').click();
	await A.click('[data-testid="menu-rename"]');
	check("rename: the title becomes an input with focus", await A.locator('[data-testid="rename-input"]').evaluate((el) => el === document.activeElement));
	await A.fill('[data-testid="rename-input"]', "不该保存的名字");
	await A.keyboard.press("Escape");
	await sleep(300);
	check("rename: Esc cancels (server title unchanged)", (await detailOf(s1)).title === "星标测试" && (await A.locator('[data-testid="rename-input"]').count()) === 0);
	await row(A, s1).hover();
	await row(A, s1).locator('[data-testid="conv-menu"]').click();
	await A.click('[data-testid="menu-rename"]');
	await A.fill('[data-testid="rename-input"]', "蓝莓蛋糕");
	await A.keyboard.press("Enter");
	await A.waitForFunction((k) => document.querySelector(`[data-testid="conv-row"][data-conv="${k}"]`)?.textContent?.includes("蓝莓蛋糕"), keyOf(s1), { timeout: 8000 });
	check("rename: Enter saves through PATCH", (await detailOf(s1)).title === "蓝莓蛋糕");

	// tags
	await row(A, s1).hover();
	await row(A, s1).locator('[data-testid="conv-menu"]').click();
	await A.click('[data-testid="menu-tags"]');
	await A.waitForSelector('[data-testid="tags-editor"]');
	check("tags: the popover opens with the input focused", await A.locator('[data-testid="tag-input"]').evaluate((el) => el === document.activeElement));
	await A.keyboard.type("甜点");
	await A.keyboard.press("Enter");
	await A.keyboard.type("家庭,");
	await sleep(100);
	check("tags: Enter and comma both add a chip", (await A.locator('[data-testid="tag-chip"]').count()) === 2);
	await snap(A, "1440-tags-popover");
	await A.click('[data-testid="tags-save"]');
	await A.waitForFunction(() => !document.querySelector('[data-testid="tags-editor"]'));
	const meta2 = (await J(await api.get(`${base}/api/conversation-meta`))).items.find((i) => i.conversationId === s1.conversationId && i.spaceId === s1.spaceId);
	check("tags: saved through PUT …/tags", JSON.stringify(meta2?.tags) === JSON.stringify(["甜点", "家庭"]), JSON.stringify(meta2));

	// export
	await row(A, s1).hover();
	await row(A, s1).locator('[data-testid="conv-menu"]').click();
	const [dl] = await Promise.all([A.waitForEvent("download"), A.click('[data-testid="menu-export"]')]);
	const file = await dl.path();
	const md = readFileSync(file, "utf8");
	// (headless Chromium reports a CJK download name as plain "download"; the anchor carries 蓝莓蛋糕.md)
	check("export: a Markdown file is downloaded with the conversation text, directives hidden", md.includes("蓝莓蛋糕配方") && md.includes("蓝莓蛋糕配方如下") && !md.includes("[["), `${dl.suggestedFilename()} · ${md.length} chars`);

	// error is shown (intercepted: the star call fails)
	await A.route(`**/api/conversations/${s1.spaceId}/${s1.conversationId}/star`, (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "boom", message: "服务暂时不可用，请稍后再试" } }) }));
	await row(A, s1).hover();
	await row(A, s1).locator('[data-testid="conv-menu"]').click();
	await A.click('[data-testid="menu-star"]');
	await A.waitForSelector('[data-testid="sidebar-notice"]');
	check("[intercepted] a failing action shows the server's reason in the sidebar and leaves the list unchanged", (await A.locator('[data-testid="sidebar-notice"]').innerText()).includes("服务暂时不可用") && (await A.locator('[data-testid="group-starred"]').count()) === 0);
	await A.unroute(`**/api/conversations/${s1.spaceId}/${s1.conversationId}/star`);
	await A.click('[data-testid="sidebar-notice"] button');

	// archive
	await row(A, s1).hover();
	await row(A, s1).locator('[data-testid="conv-menu"]').click();
	await A.click('[data-testid="menu-archive"]');
	await A.waitForFunction((k) => !document.querySelector(`[data-testid="conv-row"][data-conv="${k}"]`), keyOf(s1), { timeout: 8000 });
	check("archive: the row leaves the list and the server marks it archived", (await detailOf(s1)).archived === true);

	// delete
	await row(A, z).hover();
	await row(A, z).locator('[data-testid="conv-menu"]').click();
	await A.click('[data-testid="menu-delete"]');
	const ztxt = await A.locator('[data-testid="confirm-delete-conversation"]').innerText();
	check("delete: the confirmation says it can no longer be opened or searched in Workroom", ztxt.includes("删除后将无法在 Workroom 中打开和搜索"), ztxt.replace(/\s+/g, " "));
	check("delete: focus starts on 取消, not on the destructive button", await A.locator("[data-cancel]").evaluate((el) => el === document.activeElement));
	await A.evaluate(() => (window.__ghosts = 0));
	await A.click('[data-testid="confirm-ok"]');
	await A.waitForFunction((k) => !document.querySelector(`[data-testid="conv-row"][data-conv="${k}"]`), keyOf(z), { timeout: 8000 });
	check("motion: a removed row leaves as a fading ghost (FLIP remove)", (await A.evaluate(() => window.__ghosts)) >= 1);
	const gone = await api.get(`${base}/api/conversations/${z.spaceId}/${z.conversationId}`);
	const found = (await J(await api.get(`${base}/api/search?q=${encodeURIComponent("橙子协议")}`))).results;
	check("delete: gone from the list, 404 from the server, and no longer found by search", gone.status() === 404 && found.length === 0, `${gone.status()} · ${found.length} hits`);

	// ------------------------------------------------------------------ 8. the ⋯ button is reachable by keyboard
	await A.reload();
	await A.waitForSelector(`[data-testid="conv-row"][data-conv="${keyOf(x)}"]`);
	const link = row(A, x).locator("a");
	await link.focus();
	await A.keyboard.press("Tab");
	await sleep(300);
	const kb = await A.evaluate(() => {
		const el = document.activeElement;
		return { label: el?.getAttribute("aria-label"), opacity: el ? getComputedStyle(el).opacity : "" };
	});
	check("keyboard: Tab from a conversation lands on its ⋯ button, which becomes visible", /的操作$/.test(kb.label ?? "") && kb.opacity === "1", JSON.stringify(kb));
	await A.keyboard.press("Enter");
	await A.waitForSelector('[role="menu"]');
	await A.keyboard.press("ArrowDown");
	await A.keyboard.press("ArrowDown");
	check("keyboard: arrows move through the menu items", (await A.locator('[role="menu"] [data-highlighted]').count()) === 1);
	await A.keyboard.press("Escape");
	await A.waitForFunction(() => !document.querySelector('[role="menu"]'));
	await sleep(250);
	check("keyboard: Esc closes the menu and focus returns to ⋯", (await A.evaluate(() => /的操作$/.test(document.activeElement?.getAttribute("aria-label") ?? ""))) === true);
	check("pointer: at rest (no hover, no focus) the ⋯ button is hidden on a desktop", await (async () => {
		await A.mouse.move(700, 600);
		await A.evaluate(() => document.activeElement?.blur());
		await sleep(250);
		return (await row(A, x).locator('[data-testid="conv-menu"]').evaluate((el) => getComputedStyle(el).opacity)) === "0";
	})());

	// insert: a new conversation slides in
	await A.evaluate(() => (window.__flips.length = 0));
	const ins = await mkConv("新插入的对话");
	await A.evaluate(() => window.dispatchEvent(new Event("wr:conversations-changed")));
	await A.waitForSelector(`[data-testid="conv-row"][data-conv="${keyOf(ins)}"]`);
	check("motion: a new row is animated in (FLIP insert: fade + slide)", (await flips(A)).some((f) => f.id === `c:${keyOf(ins)}` && f.kf.includes("opacity")));
	// reduced motion: rows still move, nothing is animated
	await A.emulateMedia({ reducedMotion: "reduce" });
	await sleep(200);
	await A.evaluate(() => {
		window.__flips.length = 0;
		window.__ghosts = 0;
	});
	await row(A, ins).hover();
	await row(A, ins).locator('[data-testid="conv-menu"]').click();
	await A.click('[data-testid="menu-star"]');
	await A.waitForSelector(`[data-testid="group-starred"] [data-testid="conv-row"][data-conv="${keyOf(ins)}"]`);
	await row(A, ins).hover();
	await row(A, ins).locator('[data-testid="conv-menu"]').click();
	await A.click('[data-testid="menu-star"]');
	await A.waitForFunction((k) => !!document.querySelector(`[data-testid="group-recent"] [data-testid="conv-row"][data-conv="${k}"]`), keyOf(ins), { timeout: 8000 });
	check("motion: with reduced motion (system setting) rows move without any animation", (await flips(A)).length === 0 && (await A.evaluate(() => window.__ghosts)) === 0);
	await A.emulateMedia({ reducedMotion: "no-preference" });
	await sleep(200);

	// ------------------------------------------------------------------ 9. Ctrl/Cmd+K search
	const rail = await mkConv("十二轮的长对话");
	for (let i = 1; i <= 12; i++) await send(rail, `第${i}个问题：请说说主题${i} [[reply 第${i}个回答：这是关于主题${i}的说明。]]`);
	await A.goto(`${base}/`);
	await A.waitForSelector('[data-testid="sidebar"]');
	await A.locator('[data-testid="nav-new-chat"]').focus();
	await A.keyboard.press(`${MOD}+k`);
	await A.waitForSelector('[data-testid="search-modal"]');
	check("search: Ctrl/Cmd+K opens the modal from anywhere with the input focused", await A.locator('[data-testid="search-modal-input"]').evaluate((el) => el === document.activeElement));
	await A.waitForSelector('[data-testid="search-results"] [data-testid="search-result"]');
	check("search: before typing it lists recent conversations", (await A.locator('[data-testid="search-results"] [data-testid="search-result"]').count()) >= 3);
	let trapped = true;
	for (let i = 0; i < 7; i++) {
		await A.keyboard.press("Tab");
		trapped &&= await A.evaluate(() => !!document.activeElement?.closest('[data-testid="search-modal"]'));
	}
	check("search: Tab stays inside the modal (focus trap)", trapped);
	await A.keyboard.press("Escape");
	await A.waitForFunction(() => !document.querySelector('[data-testid="search-modal"]'));
	check("search: Esc closes it and focus returns to where it was", await A.locator('[data-testid="nav-new-chat"]').evaluate((el) => el === document.activeElement));
	await A.click('[data-testid="nav-search"]');
	await A.waitForSelector('[data-testid="search-modal"]');
	check("search: the sidebar 搜索 entry opens the same modal", true);
	const reqs = [];
	A.on("request", (r) => r.url().includes("/api/search?") && reqs.push(r.url()));
	await A.keyboard.type("紫罗兰", { delay: 40 });
	await A.waitForSelector('[data-testid="search-result"] mark');
	await sleep(300);
	check("search: typing is debounced (one request for a quickly typed word)", reqs.length === 1, String(reqs.length));
	const first = A.locator('[data-testid="search-result"]').first();
	check("search: result shows title, message-match badge and the match marked in the snippet", (await first.innerText()).includes("周报草稿") && (await first.locator('[data-testid="match-badge"][data-match="message"]').count()) === 1 && (await first.locator("mark").first().innerText()).includes("紫罗兰"));
	check("search: the preview pane (≥1024) shows the turns around the hit with the hit highlighted", await A.waitForSelector('[data-testid="preview-turn"][data-hit]', { timeout: 8000 }).then(() => true).catch(() => false));
	await snap(A, "1440-search-modal");
	await A.keyboard.press("ArrowDown");
	const a1 = await A.locator('[data-testid="search-modal-input"]').getAttribute("aria-activedescendant");
	check("search: ArrowDown/ArrowUp move (and loop) the active result, aria-activedescendant follows", (await A.locator('[data-testid="search-result"][data-active]').count()) === 1 && !!a1);
	await A.keyboard.press("ArrowUp");
	await A.keyboard.press("Enter");
	await A.waitForURL(/\/c\/.*\?entry=\d+/);
	await A.waitForSelector('[data-hit="true"]', { timeout: 8000 });
	const hitBox = await A.evaluate(() => {
		const h = document.querySelector('[data-hit="true"]').getBoundingClientRect();
		const s = document.querySelector('[data-testid="chat-scroll"]').getBoundingClientRect();
		return { inView: h.top >= s.top - 4 && h.bottom <= s.bottom + 4, text: document.querySelector('[data-hit="true"]').textContent };
	});
	check("search: Enter opens the conversation, scrolls to the matched message and highlights it", hitBox.inView && hitBox.text.includes("紫罗兰"), JSON.stringify(hitBox).slice(0, 100));
	check("search: the modal closed on open", (await A.locator('[data-testid="search-modal"]').count()) === 0);
	await A.waitForFunction(() => !document.querySelector('[data-hit="true"]'), null, { timeout: 6000 });
	check("search: the highlight fades after a moment", true);

	await A.keyboard.press(`${MOD}+k`);
	await A.fill('[data-testid="search-modal-input"]', "不存在的词汇zzzz");
	await A.waitForSelector('[data-testid="search-empty"]');
	check("search: no results → a plain empty state", (await A.locator('[data-testid="search-empty"]').innerText()).includes("没有找到"));
	await A.fill('[data-testid="search-modal-input"]', "甜点");
	await A.waitForSelector('[data-testid="search-result"]');
	const tagHit = await A.locator('[data-testid="search-result"]').first().innerText();
	check("search: a tag match is found and shows its tag", tagHit.includes("#甜点") || tagHit.includes("甜点"), tagHit.replace(/\s+/g, " "));
	await A.route("**/api/search?**", (r) => r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "forbidden", message: "forbidden" } }) }));
	await A.fill('[data-testid="search-modal-input"]', "任意词");
	await A.waitForSelector('[data-testid="search-error"]');
	check("[intercepted] 403 from /search → a plain 无权限 message, no retry button", (await A.locator('[data-testid="search-error"]').getAttribute("data-kind")) === "forbidden" && (await A.locator('[data-testid="search-error"]').innerText()).includes("无权限"));
	await A.unroute("**/api/search?**");
	await A.route("**/api/search?**", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "x", message: "搜索服务出错" } }) }));
	await A.fill('[data-testid="search-modal-input"]', "再试一次");
	await A.waitForSelector('[data-testid="search-error"][data-kind="other"]');
	await A.unroute("**/api/search?**");
	await A.click('[data-testid="search-error"] button');
	await A.waitForSelector('[data-testid="search-empty"], [data-testid="search-result"]');
	check("[intercepted] a failing search shows the reason with 重试, and retry succeeds once the server answers", true);
	await A.keyboard.press("Escape");

	// a hit inside an assistant answer scrolls to (and marks) that answer
	await A.keyboard.press(`${MOD}+k`);
	await A.fill('[data-testid="search-modal-input"]', "第7个回答");
	await A.waitForSelector('[data-testid="search-result"]');
	await A.keyboard.press("Enter");
	await A.waitForSelector('[data-hit="true"][data-turn-kind="assistant"]', { timeout: 8000 });
	check("search: a match inside an assistant answer opens the conversation at that answer", (await A.locator('[data-hit="true"]').innerText()).includes("第7个回答"));

	// the old /search page keeps working
	await A.goto(`${base}/search`);
	await A.fill('[data-testid="search-input"]', "紫罗兰");
	await A.waitForSelector('[data-testid="search-page-result"]', { timeout: 8000 });
	check("/search page: still works and uses the same conversation search", (await A.locator('[data-testid="search-page-result"]').count()) >= 1);

	// ------------------------------------------------------------------ 10. position rail
	await A.goto(`${base}/c/${rail.spaceId}/${rail.conversationId}`);
	await A.waitForSelector('[data-testid="position-rail"]', { timeout: 15000 });
	await sleep(600);
	const railInfo = await A.evaluate(() => {
		const r = document.querySelector('[data-testid="position-rail"]');
		return { ticks: r.querySelectorAll('[data-testid="rail-tick"]').length, turns: r.dataset.turns, current: r.dataset.current };
	});
	check("rail: a 12-turn conversation has 12 ticks", railInfo.ticks === 12 && railInfo.turns === "12", JSON.stringify(railInfo));
	check("rail: at the bottom the last turn is current", railInfo.current === "11" && (await A.locator('[data-testid="rail-tick"][aria-current="step"]').getAttribute("data-turn")) === "11");
	const label = await A.locator('[data-testid="rail-tick"]').nth(2).getAttribute("aria-label");
	check("rail: each tick has an aria-label 第 N 轮：question", /^第 3 轮：第3个问题/.test(label ?? ""), label);
	await A.locator('[data-testid="rail-tick"]').nth(2).hover();
	await A.waitForSelector('[data-testid="rail-preview"]');
	const prev = await A.locator('[data-testid="rail-preview"]').innerText();
	check("rail: hover shows a preview with the question and the start of the answer", prev.includes("第3个问题") && prev.includes("第3个回答"), prev.replace(/\s+/g, " "));
	await sleep(350);
	await snap(A, "1440-rail-preview");
	const top0 = await A.locator('[data-testid="chat-scroll"]').evaluate((el) => el.scrollTop);
	await A.locator('[data-testid="rail-tick"]').nth(2).click();
	await sleep(900);
	const after = await A.evaluate(() => {
		const s = document.querySelector('[data-testid="chat-scroll"]');
		const m = [...document.querySelectorAll('[data-testid="user-message"]')].find((e) => e.textContent.includes("第3个问题"));
		return { top: s.scrollTop, delta: m.getBoundingClientRect().top - s.getBoundingClientRect().top, current: document.querySelector('[data-testid="position-rail"]').dataset.current };
	});
	check("rail: clicking a tick scrolls (smoothly) to that question", after.top < top0 && after.delta >= 0 && after.delta < 80, JSON.stringify({ top0, ...after }));
	check("rail: the current tick follows (IntersectionObserver)", after.current === "2", after.current);
	// keyboard
	await A.locator('[data-testid="rail-tick"]').nth(2).focus();
	await A.keyboard.press("ArrowDown");
	check("rail keyboard: ArrowDown moves focus to the next tick and shows its preview", (await A.evaluate(() => document.activeElement?.getAttribute("data-turn"))) === "3" && (await A.locator('[data-testid="rail-preview"]').count()) === 1);
	await A.keyboard.press("End");
	check("rail keyboard: End goes to the last tick, Home to the first", (await A.evaluate(() => document.activeElement?.getAttribute("data-turn"))) === "11");
	await A.keyboard.press("Home");
	await A.keyboard.press("Enter");
	await sleep(900);
	check("rail keyboard: Enter scrolls to that turn", (await A.locator('[data-testid="position-rail"]').getAttribute("data-current")) === "0" && (await A.locator('[data-testid="chat-scroll"]').evaluate((el) => el.scrollTop)) < 80);
	const tabStops = await A.locator('[data-testid="rail-tick"][tabindex="0"]').count();
	check("rail keyboard: the rail is one tab stop (roving tabindex)", tabStops === 1, String(tabStops));
	// reduced motion: instant
	await A.emulateMedia({ reducedMotion: "reduce" });
	await sleep(200);
	await A.evaluate(() => (document.querySelector('[data-testid="chat-scroll"]').scrollTop = 0));
	await sleep(200);
	await A.locator('[data-testid="rail-tick"]').nth(8).click();
	await sleep(120);
	const rm = await A.evaluate(() => {
		const s = document.querySelector('[data-testid="chat-scroll"]');
		const m = [...document.querySelectorAll('[data-testid="user-message"]')].find((e) => e.textContent.includes("第9个问题"));
		return { delta: m.getBoundingClientRect().top - s.getBoundingClientRect().top };
	});
	check("rail: with reduced motion the jump is instant", rm.delta >= 0 && rm.delta < 80, JSON.stringify(rm));
	await A.emulateMedia({ reducedMotion: "no-preference" });
	// few ticks when the area is short
	await A.setViewportSize({ width: 1440, height: 220 });
	await sleep(500);
	const shortRail = await A.evaluate(() => ({ ticks: document.querySelectorAll('[data-testid="rail-tick"]').length, turns: document.querySelector('[data-testid="position-rail"]').dataset.turns }));
	check("rail: a short window buckets the ticks instead of overflowing (fewer ticks than turns)", shortRail.ticks < Number(shortRail.turns) && shortRail.ticks >= 4, JSON.stringify(shortRail));
	await A.setViewportSize({ width: 1440, height: 900 });
	await sleep(400);

	// bucketing of very long conversations (pure function the rail uses; 500 turns would need minutes of fixture replies)
	const { bucketize } = await import("../src/features/chat/railBuckets.ts");
	const bk = bucketize(500, 120);
	check("rail: 500 turns are bucketed into at most 120 ticks that cover every turn once, in order", bk.length === 120 && bk[0].from === 0 && bk.at(-1).to === 499 && bk.every((b, i) => b.to >= b.from && (i === 0 || b.from === bk[i - 1].to + 1)));
	check("rail: up to the capacity every turn has its own tick", bucketize(12, 120).length === 12 && bucketize(121, 120).length === 120);

	// ------------------------------------------------------------------ 11. sidebar collapse is a width transition (and instant when motion is reduced)
	await A.click('button[aria-label="收起侧栏"]');
	const mid = await A.locator('[data-testid="sidebar"]').evaluate((el) => ({ w: el.getBoundingClientRect().width, state: el.dataset.state }));
	check("motion: collapsing keeps the sidebar mounted while it slides (state=closed)", mid.state === "closed");
	await A.locator('[data-testid="sidebar"]').waitFor({ state: "detached", timeout: 3000 });
	check("sidebar: unmounted once closed; the top bar offers the opener", await A.locator('[data-testid="open-sidebar"]').isVisible());
	await A.click('[data-testid="open-sidebar"]');
	await A.waitForSelector('[data-testid="sidebar"][data-state="open"]');
	await sleep(400);
	check("sidebar: expands back to full width", Math.round((await A.locator('[data-testid="sidebar"]').boundingBox()).width) === 264);

	await A.emulateMedia({ reducedMotion: "reduce" });
	await sleep(200);
	const t0 = Date.now();
	await A.click('button[aria-label="收起侧栏"]');
	await A.locator('[data-testid="sidebar"]').waitFor({ state: "detached", timeout: 3000 });
	const quick = Date.now() - t0;
	check("motion: with reduced motion the sidebar closes at once (no width transition)", quick < 220, `${quick} ms`);
	await A.click('[data-testid="open-sidebar"]');
	await A.waitForSelector('[data-testid="sidebar"][data-state="open"]');
	await A.emulateMedia({ reducedMotion: "no-preference" });

	// ------------------------------------------------------------------ 12. phone: ⋯ always visible, search full width, rail by tap
	const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN", storageState: await ctxA.storageState() });
	const M = await ctxM.newPage();
	await M.goto(`${base}/`);
	await M.waitForSelector('[data-testid="open-sidebar"]');
	await M.tap('[data-testid="open-sidebar"]');
	await M.waitForSelector('[data-testid="sheet-left"] [data-testid="conv-row"]');
	await sleep(400);
	const touchOpacity = await M.locator('[data-testid="sheet-left"] [data-testid="conv-menu"]').first().evaluate((el) => getComputedStyle(el).opacity);
	check("touch: the ⋯ button is visible without hovering", touchOpacity === "1", touchOpacity);
	await snap(M, "390-sidebar-tree");
	await M.locator('[data-testid="sheet-left"] [data-testid="conv-menu"]').first().tap();
	await M.waitForSelector('[role="menu"]');
	check("touch: tapping ⋯ opens the menu", (await M.locator('[role="menu"] [role="menuitem"]').count()) >= 4);
	await sleep(350);
	await snap(M, "390-conv-menu");
	const starKey = await M.locator('[data-testid="sheet-left"] [data-testid="conv-row"]').first().getAttribute("data-conv");
	await M.locator('[data-testid="menu-star"]').tap();
	await M.waitForSelector('[data-testid="sheet-left"] [data-testid="group-starred"]');
	const starMeta = (await J(await api.get(`${base}/api/conversation-meta`))).items.find((i) => `${i.spaceId}/${i.conversationId}` === starKey);
	check("touch: choosing a menu item inside the drawer works (星标 → group, saved on the server)", starMeta?.starred === true, starKey);
	await M.locator('[data-testid="close-drawer"]').tap();
	await M.tap('[data-testid="open-sidebar"]');
	await M.waitForSelector('[data-testid="nav-search"]');
	await M.tap('[data-testid="nav-search"]');
	await M.waitForSelector('[data-testid="search-modal"]');
	await M.fill('[data-testid="search-modal-input"]', "紫罗兰");
	await M.waitForSelector('[data-testid="search-result"] mark');
	const mBox = await M.locator('[data-testid="search-modal"]').boundingBox();
	check("search (phone): list uses the full width, no preview pane, no horizontal scroll", (await M.locator('[data-testid="search-preview"]').count()) === 0 && mBox.width >= 360 && (await M.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)));
	await sleep(350);
	await snap(M, "390-search");
	await M.keyboard.press("Escape");
	await M.goto(`${base}/c/${rail.spaceId}/${rail.conversationId}`);
	await M.waitForSelector('[data-testid="position-rail"]', { timeout: 15000 });
	await sleep(500);
	const tick = M.locator('[data-testid="rail-tick"]').nth(4);
	await tick.tap();
	await M.waitForSelector('[data-testid="rail-preview"]');
	check("rail (phone): first tap shows the preview with a 跳转 button, it does not scroll yet", (await M.locator('[data-testid="rail-go"]').count()) === 1);
	await sleep(350);
	await snap(M, "390-rail-preview");
	await M.locator('[data-testid="rail-go"]').tap();
	await sleep(900);
	check("rail (phone): the button scrolls to that turn", (await M.locator('[data-testid="position-rail"]').getAttribute("data-current")) === "4");
	check("phone: no horizontal overflow in the chat with the rail", await M.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
	await ctxM.close();

	// ------------------------------------------------------------------ 13. dark theme + overview shots
	await A.goto(`${base}/`);
	await A.waitForSelector('[data-testid="sidebar"]');
	await A.evaluate(() => {
		const k = "wr.prefs.v1";
		const p = JSON.parse(localStorage.getItem(k) || "{}");
		localStorage.setItem(k, JSON.stringify({ ...p, theme: "dark" }));
	});
	await A.reload();
	await A.waitForSelector('[data-testid="sidebar"]');
	await sleep(600);
	await snap(A, "1440-sidebar-dark");
	await A.keyboard.press(`${MOD}+k`);
	await A.fill('[data-testid="search-modal-input"]', "紫罗兰");
	await A.waitForSelector('[data-testid="preview-turn"]');
	await sleep(300);
	await snap(A, "1440-search-dark");
	await A.keyboard.press("Escape");
	await A.evaluate(() => {
		const k = "wr.prefs.v1";
		const p = JSON.parse(localStorage.getItem(k) || "{}");
		localStorage.setItem(k, JSON.stringify({ ...p, theme: "light" }));
	});
	await A.reload();
	await A.waitForSelector('[data-testid="sidebar"]');
	await sleep(500);
	await snap(A, "1440-sidebar-tree");
	const w = await A.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
	check("1440: no horizontal overflow", w.sw <= w.cw, JSON.stringify(w));
	check("no uncaught page errors during the run", errors.length === 0, errors.slice(0, 3).join(" | "));
	ok = true;
} catch (e) {
	console.error("E2E ERROR", String(e).slice(0, 600));
	await debugPage?.screenshot({ path: join(shotDir, "u1-failure.png") }).catch(() => {});
} finally {
	await browser.close();
	await server.stop();
}
const pass = summary(join(shotDir, "u1-results.json"));
process.exitCode = ok && pass ? 0 : 1;
