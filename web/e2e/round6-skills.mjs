// Round 6 · skills created in conversation. ALL conversations use the fixture model (测试模型), never a real LLM.
//  A. draft card UI against a mocked approval (route intercept of the conversation state): content, buttons, result, keyboard, blocked, narrow, dark
//  B. real flow: the agent writes my-skill/, submit_draft → card → 不保存 → nothing in 我的技能; again → 保存 → in 我的技能; load + run; malicious dirs → error, no card
//  C. submit-review dialog defaults to a target a member may use
// Run: npm run build:web && node web/e2e/round6-skills.mjs        (port 8906)
import { check, chromium, register, ROOT, sendMessage, shot, sleep, startServer, summary, SHOTS, selValue, selOptions } from "./lib.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { zipSync, strToU8 } = await import(join(ROOT, "node_modules/fflate/esm/browser.js")).catch(() => require(join(ROOT, "node_modules/fflate")));
mkdirSync(join(SHOTS, "round6"), { recursive: true });
const PORT = 8906;
const server = await startServer({ port: PORT, env: { WORKROOM_RT_RETRY_MAX: "0" } });
const base = server.base;
const browser = await chromium.launch();
const idle = (page, t = 60000) => page.waitForSelector('[data-testid="stop"]', { state: "detached", timeout: t });
const nth = (page, n, t = 90000) => page.waitForFunction((k) => document.querySelectorAll('[data-testid="assistant-message"]').length >= k && !document.querySelector('[data-testid="stop"]'), n, { timeout: t });
const lastAssistant = (page) => page.locator('[data-testid="assistant-message"]').last();
const convOf = (page) => /\/c\/([^/]+)\/(\d+)/.exec(page.url());
const stateOf = async (page) => {
	const m = convOf(page);
	return (await page.request.get(`${base}/api/conversations/${m[1]}/${m[2]}/state`)).json();
};
const fresh = async (page) => {
	await page.goto(`${base}/`);
	await page.waitForSelector('[data-testid="home-greeting"]');
};
const start = async (page, text) => {
	await fresh(page);
	await sendMessage(page, text);
	await page.waitForURL(/\/c\//);
};
const wf = (path, content) => `[[call write ${JSON.stringify({ path: `/work/${path}`, content })}]]`;
const skillMd = (name, desc) => `---\nname: ${name}\ndescription: ${desc}\nversion: 1.0.0\nentry: scripts/run.py\n---\n# ${name}\n\n运行 scripts/run.py，输出一行问候。\n`;
const SCRIPT = 'import sys\nprint("hello from skill", sys.stdin.read().strip(), " ".join(sys.argv[1:]))\n';
const writeSkill = (dir, name, desc) => `${wf(`${dir}/SKILL.md`, skillMd(name, desc))} ${wf(`${dir}/scripts/run.py`, SCRIPT)}`;

const DETAIL = {
	kind: "skill_draft",
	draftId: "sd_mock1",
	name: "weekly-report",
	title: "周报助手",
	description: "把本周的工作记录整理成一页周报，按项目分组。",
	version: "1.0.0",
	skillKind: "executable",
	files: [
		{ path: "SKILL.md", size: 412, sha256: "a".repeat(64), executable: false },
		{ path: "scripts/run.py", size: 1280, sha256: "b".repeat(64), executable: true },
	],
	totalBytes: 1692,
	packageSha256: "c0ffee".repeat(10) + "abcd",
	requiredPermissions: ["sandbox.exec", "network"],
	requiredTools: [],
	findings: [{ severity: "warn", code: "script.network", message: "脚本 scripts/run.py 里有联网请求，使用时需要你另外授权联网。" }],
	sourceDir: "my-skill",
};
const mkApproval = (over = {}, detail = {}) => ({
	approvalId: "ap_mock1",
	conversationId: 1,
	callId: "call_mock1",
	toolName: "skill_manage",
	title: "保存技能草稿「weekly-report」",
	summary: "把 my-skill 保存为个人技能 weekly-report v1.0.0",
	detail: { ...DETAIL, ...detail },
	risk: "medium",
	status: "pending",
	requestedAt: new Date().toISOString(),
	...over,
});

try {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
	const page = await ctx.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	const EMAIL = `r6-${Date.now()}@example.com`;
	await register(page, base, { email: EMAIL, name: "林夏" });

	// ================================================================= A. mocked approval
	await start(page, "你好，先聊一句");
	await page.waitForSelector('[data-testid="assistant-message"] .wr-prose', { timeout: 30000 });
	await idle(page);
	const m = convOf(page);
	const stateUrl = new RegExp(`/api/conversations/${m[1]}/${m[2]}/events`);
	// The page reads its state from an EventSource: answer it with one snapshot frame (real state + the mocked approval).
	const sse = (pg, getApprovals) => async (route) => {
		const j = await (await pg.request.get(`${base}/api/conversations/${m[1]}/${m[2]}/state`)).json();
		const body = `retry: 400\nevent: snapshot\ndata: ${JSON.stringify({ ...j, approvals: [...(j.approvals ?? []), ...getApprovals()] })}\n\n`;
		await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }, body });
	};
	let mock = mkApproval();
	let posted = null;
	let draftRoute = 404;
	await page.route(stateUrl, sse(page, () => [mock]));
	await page.route(/\/api\/conversations\/[^/]+\/\d+\/approvals\/ap_mock1$/, async (route) => {
		posted = route.request().postDataJSON();
		mock = { ...mock, status: posted.decision, decidedAt: new Date().toISOString() };
		await route.fulfill({ json: { ok: true } });
	});
	await page.route(/\/api\/skill-drafts\/sd_mock1$/, async (route) => {
		if (draftRoute === 404) return route.fulfill({ status: 404, json: { error: { code: "not_found", message: "不存在" } } });
		await route.fulfill({ json: { draft: { id: "sd_mock1", state: "saved", detail: DETAIL, spaceId: "s", conversationId: 1, createdAt: new Date().toISOString(), skillId: "sk_1", versionNo: 1 } } });
	});
	await page.reload();
	await page.waitForSelector('[data-testid="skill-draft"]', { timeout: 20000 });
	await sleep(500);
	const card = page.locator('[data-testid="approval-card"]');
	const txt = await card.innerText();
	check("A card: title 保存为个人技能, name/title and 版本", txt.includes("保存为个人技能") && txt.includes("周报助手") && txt.includes("weekly-report") && txt.includes("版本 1.0.0"));
	check("A card: 用途 shows the description", (await card.locator('[data-testid="skill-draft-desc"]').innerText()).includes("整理成一页周报"));
	const files = await card.locator('[data-testid="skill-draft-files"] li').allInnerTexts();
	check("A card: files listed as path · size, the script marked 可执行脚本", files.length === 2 && files[0].includes("SKILL.md") && /412|0\.4/.test(files[0]) && !files[0].includes("可执行") && files[1].includes("scripts/run.py") && files[1].includes("可执行脚本"), files.join(" | "));
	check("A card: permissions in plain words (运行代码、联网), not codes", (await card.locator('[data-testid="skill-draft-perms"]').innerText()).trim() === "运行代码、联网");
	const risk = await card.locator('[data-testid="skill-draft-risk"]').innerText();
	check("A card: risk line shows the warning in Chinese without the code", risk.includes("请留意") && risk.includes("联网请求") && !risk.includes("script.network"));
	// round 10: files / permissions / findings / the fixed sentence are behind 查看详情 (the face keeps name, 用途, a one-line summary and the buttons)
	check("A card: the face shows the file count, permissions and warning count; the file list and the fixed sentence are folded", txt.includes("2 个文件") && txt.includes("运行代码、联网") && txt.includes("1 条提醒") && !txt.includes("scripts/run.py") && !txt.includes("仅你可用"));
	await card.locator('[data-testid="approval-details-toggle"]').click();
	const txtOpen = await card.innerText();
	await card.locator('[data-testid="approval-details-toggle"]').click();
	check("A card: the fixed sentence is one short line: 仅你可用 / 不会自动运行 (round 11: the 发布 / 商城 paragraph is gone)", txtOpen.includes("保存后仅你可用，不会自动运行。") && !txtOpen.includes("商城"));
	check("A card: package hash and codes only inside the folded 详情 (round 12: one level, 参数)", !txt.includes("c0ffee") && !txt.includes("sha256") && (await card.locator('[data-testid="approval-raw"]').innerHTML()).includes("packageSha256"));
	check("A card: buttons are 不保存 / 保存 (+ 详情 › and 添加说明), nothing focused on open", (await card.locator("button").allInnerTexts()).map((t) => t.trim()).join("|") === "不保存|保存|详情|添加说明" && !["approve", "approve-confirm"].includes(await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "")));
	await shot(page, "round6/draft-card-1440-light");
	await page.locator('[data-testid="approval-card"]').scrollIntoViewIfNeeded();
	// keyboard: Tab → 不保存, Tab → 保存
	await card.focus();
	const order = [];
	for (let k = 0; k < 5; k++) {
		await page.keyboard.press("Tab");
		order.push(await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName));
	}
	check("A keyboard: Tab reaches 不保存 and then 保存 (after 技术详情), all reachable", order.indexOf("reject") >= 0 && order.indexOf("approve") === order.indexOf("reject") + 1, order.join(","));
	// narrow + dark
	const small = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "zh-CN", colorScheme: "dark" });
	const sp = await small.newPage();
	await sp.addInitScript(() => localStorage.setItem("workroom-theme", "dark"));
	await sp.route(stateUrl, sse(sp, () => [mkApproval()]));
	await sp.goto(`${base}/login`);
	await sp.fill("#email", EMAIL);
	await sp.fill("#password", "password123");
	await sp.click('button[type="submit"]');
	await sp.waitForSelector('[data-testid="home-greeting"]');
	await sp.goto(`${base}/c/${m[1]}/${m[2]}`);
	await sp.waitForSelector('[data-testid="skill-draft"]', { timeout: 20000 });
	await sleep(500);
	check("A narrow: no horizontal page scroll at 390px", await sp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
	await shot(sp, "round6/draft-card-390-dark");
	await small.close();

	// decide: 保存 → result (draft route 404 → degrade to approval-based wording)
	await page.locator('[data-testid="approve"]').click();
	await page.waitForSelector('[data-testid="skill-draft-result"]', { timeout: 20000 });
	check("A decide: 保存 posts approved through the existing approval API", posted?.decision === "approved", JSON.stringify(posted));
	const res = page.locator('[data-testid="skill-draft-result"]');
	check("A result: 已保存 with a link to 能力 › 我的技能 even when the draft route is 404", (await res.innerText()).includes("已保存") && (await res.locator("a").count()) === 1 && (await res.locator("a").getAttribute("href")) === "/capabilities");
	await shot(page, "round6/draft-saved-1440-light");
	// rejected wording
	mock = mkApproval({ status: "pending" });
	await page.reload();
	await page.waitForSelector('[data-testid="skill-draft"]', { timeout: 20000 });
	await page.locator('[data-testid="reject"]').click();
	await page.waitForSelector('[data-testid="skill-draft-result"][data-state="rejected"]', { timeout: 20000 });
	const rejText = await page.locator('[data-testid="skill-draft-result"]').innerText();
	check("A result: 不保存 → 未保存 and no link", rejText.includes("未保存") && !rejText.includes("已保存") && (await page.locator('[data-testid="skill-draft-result"] a').count()) === 0);
	// blocking finding
	mock = mkApproval({}, { findings: [{ severity: "error", code: "secret.key", message: "SKILL.md 里像是写了密钥，请删除后重新提交。" }] });
	await page.reload();
	await page.waitForSelector('[data-testid="skill-draft"]', { timeout: 20000 });
	check("A blocked: an error finding disables 保存 and says why; 不保存 still works", (await page.locator('[data-testid="approve"]').isDisabled()) && (await page.locator('[data-testid="skill-draft-risk"]').innerText()).includes("必须修复") && !(await page.locator('[data-testid="reject"]').isDisabled()));
	// high risk second confirm
	mock = mkApproval({ risk: "high" });
	await page.reload();
	await page.waitForSelector('[data-testid="skill-draft"]', { timeout: 20000 });
	await page.locator('[data-testid="approve"]').click();
	check("A high risk: 保存… needs a second confirm (确认保存)", (await page.locator('[data-testid="approve-confirm"]').innerText()).includes("确认保存"));
	await page.locator('[data-testid="approve-back"]').click();
	await page.unroute(stateUrl);

	if (process.env.R6_ONLY_A) throw new Error("R6_ONLY_A: stopped after part A");
	// ================================================================= B. real flow
	const have = await (await page.request.get(`${base}/api/skills`)).json();
	check("B setup: the skills API answers", Array.isArray(have.skills));

	await start(page, `帮我创建一个技能 ${writeSkill("my-skill", "first-skill", "把输入的名字问候一遍")}`);
	await page.waitForSelector('[data-testid="assistant-message"] .wr-prose', { timeout: 60000 });
	await idle(page);
	await sendMessage(page, '提交草稿 [[call skill_manage {"action":"submit_draft","dir":"my-skill"}]]');
	await page.waitForSelector('[data-testid="skill-draft"]', { timeout: 60000 });
	await sleep(400);
	const c1 = page.locator('[data-testid="approval-card"]');
	const t1 = await c1.innerText();
	await c1.locator('[data-testid="approval-details-toggle"]').click();
	const t1o = await c1.innerText();
	await c1.locator('[data-testid="approval-details-toggle"]').click();
	check("B card: shows name, 用途, files and 可执行脚本", t1.includes("first-skill") && (await c1.locator('[data-testid="skill-draft-desc"]').innerText()).includes("问候") && t1o.includes("SKILL.md") && t1o.includes("scripts/run.py") && t1o.includes("可执行脚本") && t1.includes("可执行脚本"));
	check("B card: a risk/检查结果 line is present", (await c1.locator('[data-testid="skill-draft-risk"]').innerText()).trim().length > 0);
	const bubbles = (await page.locator('[data-testid="user-bubble"]').allInnerTexts()).join("\n");
	check("B display: test directives and file contents are not shown as user text", !bubbles.includes("[[") && !bubbles.includes("call write") && !bubbles.includes("hello from skill") && bubbles.includes("帮我创建一个技能"));
	check("B display: the approval mentions no raw tool names", !t1o.includes("skill_manage") && !t1o.includes("submit_draft"));
	await shot(page, "round6/draft-card-real-1440-light");
	await page.locator('[data-testid="reject"]').click();
	await page.waitForSelector('[data-testid="skill-draft-result"][data-state="rejected"]', { timeout: 30000 });
	await idle(page);
	check("B result: 不保存 → 未保存", (await page.locator('[data-testid="skill-draft-result"]').innerText()).includes("未保存"));
	let skills = await (await page.request.get(`${base}/api/skills`)).json();
	check("B reject: no skill was created", !skills.skills.some((s) => s.name === "first-skill"));
	await page.goto(`${base}/capabilities`);
	await page.waitForSelector('[data-testid="my-skills"]');
	await sleep(500);
	check("B reject: 能力 › 我的技能 does not list it", (await page.locator('[data-testid="skill"]').filter({ hasText: "first-skill" }).count()) === 0);

	// second draft → 保存
	await start(page, `再来一个 ${writeSkill("my-skill2", "second-skill", "把输入的名字问候两遍")}`);
	await page.waitForSelector('[data-testid="assistant-message"] .wr-prose', { timeout: 60000 });
	await idle(page);
	await sendMessage(page, '提交 [[call skill_manage {"action":"submit_draft","dir":"my-skill2"}]]');
	await page.waitForSelector('[data-testid="skill-draft"]', { timeout: 60000 });
	await page.locator('[data-testid="approve"]').click();
	await page.waitForSelector('[data-testid="skill-draft-result"][data-state="saved"]', { timeout: 30000 });
	await idle(page);
	check("B result: 保存 → 已保存", (await page.locator('[data-testid="skill-draft-result"]').innerText()).includes("已保存"));
	await shot(page, "round6/draft-saved-real-1440-light");
	await page.setViewportSize({ width: 390, height: 844 });
	await sleep(300);
	await shot(page, "round6/draft-saved-real-390-light");
	check("B narrow: the saved result fits at 390px", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
	await page.setViewportSize({ width: 1440, height: 900 });
	skills = await (await page.request.get(`${base}/api/skills`)).json();
	check("B save: the skill exists in my skills (API)", skills.skills.some((s) => s.name === "second-skill"));
	await page.locator('[data-testid="skill-draft-open"]').click();
	await page.waitForSelector('[data-testid="my-skills"]');
	await page.waitForSelector('[data-testid="skill"]', { timeout: 15000 });
	check("B save: it appears in 能力 › 我的技能", (await page.locator('[data-testid="skill"]').filter({ hasText: "second-skill" }).count()) === 1);
	await shot(page, "round6/my-skills-1440-light");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.emulateMedia({ colorScheme: "dark" });
	await sleep(400);
	await shot(page, "round6/my-skills-390-dark");
	check("B narrow: 我的技能 fits at 390px (dark)", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
	await page.emulateMedia({ colorScheme: "light" });
	await page.setViewportSize({ width: 1440, height: 900 });
	// an executable skill needs the person's grant for that version before it runs (加载技能文本不等于授权)
	const card2 = page.locator('[data-testid="skill"]').filter({ hasText: "second-skill" });
	await card2.locator("button[aria-expanded]").click();
	await card2.getByRole("button", { name: /授予 v1 所需权限/ }).click();
	await card2.getByText("已全部授予").waitFor({ timeout: 15000 });
	check("B use: the person grants the skill's permission in 我的技能 (执行需要授权)", true);

	// use it (round 14: no skill tool — the skill is a directory under /skills; copy_to_work it and run its script with exec)
	await start(page, '用它 [[call read {"path":"/skills/second-skill/SKILL.md"}]]');
	await page.waitForSelector('[data-testid="assistant-message"] .wr-prose', { timeout: 60000 });
	await idle(page);
	await sendMessage(page, '运行 [[call copy_to_work {"source":"/skills/second-skill","destination":"/work/second-skill","recursive":true}]] [[call exec {"command":"echo 林夏 | python3 second-skill/scripts/run.py"}]]');
	await nth(page, 2);
	const answer = await lastAssistant(page).innerText();
	check("B use: the run result (hello from skill) is shown", answer.includes("hello from skill") && answer.includes("林夏"), answer.slice(0, 200));
	await page.locator('[data-testid="step-chain"] > button').last().click();
	await sleep(250);
	const stepTitles = (await page.locator('[data-testid="tool-step"] > button').allInnerTexts()).join(" | ");
	check("B use: steps are in human words (复制「second-skill」到工作区, 运行命令), no tool names", stepTitles.includes("复制「second-skill」到工作区") && stepTitles.includes("运行命令") && !/copy_to_work|\bexec\b|skill_/.test(stepTitles), stepTitles);

	// malicious dirs
	await start(page, '[[call skill_manage {"action":"submit_draft","dir":"../x"}]]');
	await page.waitForSelector('[data-testid="assistant-message"] .wr-prose', { timeout: 60000 });
	await idle(page);
	check("B malicious: ../x gives the agent an error and no card", (await page.locator('[data-testid="approval-card"]').count()) === 0 && (await lastAssistant(page).innerText()).includes("失败"));
	await start(page, `做个坏技能 ${writeSkill("evil", "evil-skill", "x")} [[call exec {"command":"ln -s /etc evil/etc-link"}]]`);
	await page.waitForSelector('[data-testid="assistant-message"] .wr-prose', { timeout: 60000 });
	await idle(page);
	await sendMessage(page, '提交 [[call skill_manage {"action":"submit_draft","dir":"evil"}]]');
	await nth(page, 2, 60000);
	check("B malicious: a directory with a symlink gives the agent an error and no card", (await page.locator('[data-testid="skill-draft"]').count()) === 0 && (await lastAssistant(page).innerText()).includes("失败"));
	const st = await stateOf(page);
	check("B malicious: no skill_draft approval exists on the conversation", !(st.approvals ?? []).some((a) => a.detail?.kind === "skill_draft"));
	skills = await (await page.request.get(`${base}/api/skills`)).json();
	check("B malicious: no evil-skill was saved", !skills.skills.some((s) => s.name === "evil-skill"));

	// ================================================================= C. submit dialog defaults
	const code = (await (await page.request.post(`${base}/api/admin/invites`, { data: { role: "member", ttlHours: 24 } })).json()).invite.code;
	const member = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
	const mp = await member.newPage();
	await mp.goto(`${base}/register?invite=${code}`);
	await mp.fill("#name", "成员甲");
	await mp.fill("#email", `r6m-${Date.now()}@example.com`);
	await mp.fill("#password", "password123");
	await mp.click('button[type="submit"]');
	await mp.waitForSelector('[data-testid="home-greeting"]');
	const meFlags = await (await mp.request.get(`${base}/api/market/me`)).json();
	check("C setup: the invited member cannot publish to the org", meFlags.me?.canPublishOrg === false, String(meFlags.me?.canPublishOrg));
	await mp.goto(`${base}/capabilities`);
	await mp.click('[data-testid="skill-upload"]');
	await mp.waitForSelector('[data-testid="dropzone"]');
	const zip = Buffer.from(zipSync({ "SKILL.md": strToU8("---\nname: member-skill\ndescription: 成员自己的小技能\nversion: 1.0.0\n---\n# 小技能\n") })).toString("base64");
	await mp.evaluate(async (b64) => {
		const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		const dt = new DataTransfer();
		dt.items.add(new File([bytes], "member-skill.zip", { type: "application/zip" }));
		document.querySelector('[data-testid="dropzone"]').dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
	}, zip);
	await mp.click('[data-testid="upload-submit"]');
	await mp.waitForSelector('[data-testid="upload-result"]', { timeout: 15000 });
	await mp.locator('[data-testid="skill"]').first().locator("button[aria-expanded]").click();
	await mp.click('[data-testid="submit-review"]');
	await mp.waitForSelector('[data-testid="submit-scope"]');
	await sleep(300);
	const sel = mp.locator('[data-testid="submit-scope"]');
	check("C member: the target defaults to something other than 整个组织", (await selValue(sel)) !== "org", await selValue(sel));
	check("C member: 整个组织 is disabled and a one-line reason is shown", (await selOptions(sel)).some((o) => o.value === "org" && o.disabled) && (await mp.locator('[data-testid="submit-scope-note"]').innerText()).includes("无权发布到整个组织"));
	await shot(mp, "round6/submit-dialog-member-1440-light");
	await mp.keyboard.press("Escape");
	await member.close();
	await page.goto(`${base}/capabilities`);
	await page.waitForSelector('[data-testid="skill"]', { timeout: 15000 });
	await page.locator('[data-testid="skill"]').first().locator("button[aria-expanded]").click();
	await page.click('[data-testid="submit-review"]');
	await page.waitForSelector('[data-testid="submit-scope"]');
	await sleep(300);
	check("C owner: an org publisher still defaults to 整个组织", (await selValue(page.locator('[data-testid="submit-scope"]'))) === "org");
	await page.keyboard.press("Escape");

	check("page: no uncaught errors", errors.length === 0, errors.join(" | ").slice(0, 200));
} finally {
	const ok = summary(join(SHOTS, "round6/round6-skills-results.json"));
	await browser.close();
	await server.stop();
	process.exitCode = ok ? 0 : 1;
}
