// Round 10 · chat UX: compact approval cards (progressive disclosure) and one place per notice.
// Fixture model only (no real AI): "[[call wr_fixture_approval {...}]]" asks for approval, "[[call credential_request {...}]]" asks for a
// credential, "[[call skill_manage {...}]]" drafts a skill, "[[call sandbox_exec {...}]]" fails against an unreachable remote sandbox, "[[fail]]" fails a run.
//  A. approval cards (real medium / high + mocked MCP-style, skill draft, blocked draft; credential request): height, visible words and
//     whether the decision buttons are on screen without scrolling — 1440 / 390, light / dark. Nothing removed: everything is behind 查看详情.
//  B. notices: one failed sandbox step = one inline explanation (no env banner / run bar repeating it); a failed run = one inline note + a slim
//     重试 bar; the skill-saved result is one slim line; the stale-citation notice is one line.
// Run: npm run -w web build && node web/e2e/round10-chat-ux.mjs        (port 8942)
// R10_LABEL=before records the same numbers on the old build (checks that describe the new behaviour then fail, on purpose, and are ignored).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, chromium, register, sendMessage, sleep, startServer, summary, SHOTS } from "./lib.mjs";
import { visibleUnits } from "./density.mjs";

const LABEL = process.env.R10_LABEL ?? "after";
const DIR = join(SHOTS, "round10");
mkdirSync(DIR, { recursive: true });
const PORT = 8942;
const server = await startServer({ port: PORT, env: { WORKROOM_RT_RETRY_MAX: "0", WORKROOM_SECRET_KEY: "round10-e2e-secret-key-0123456789abcdef", WORKROOM_WEBHOOK_ALLOWLIST: "127.0.0.1" } });
const base = server.base;
const browser = await chromium.launch();
const BEFORE = LABEL === "before";
const T = (id) => `[data-testid="${id}"]`;
const M = {}; // every measurement, written to JSON
const note = (k, v) => {
	M[k] = v;
	console.log(`MEASURE  ${k} = ${JSON.stringify(v)}`);
};
const shot = (page, name) => page.screenshot({ path: join(DIR, `${name}-${LABEL}.png`), fullPage: false });
const idle = (page, t = 90000) => page.waitForSelector(T("stop"), { state: "detached", timeout: t });
const convOf = (page) => /\/c\/([^/]+)\/(\d+)/.exec(page.url());
const directive = (tool, args) => `[[call ${tool} ${JSON.stringify(args)}]]`;
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1);

/** Visible words (CJK characters + latin words) inside one element — same counting rules as density.mjs, limited to a subtree. */
const unitsIn = (loc) =>
	loc.evaluate((root) => {
		const re = /[㐀-鿿＀-￯]|[A-Za-z0-9]+(?:[._'-][A-Za-z0-9]+)*/g;
		const skip = new Set(["SCRIPT", "STYLE", "OPTION", "TEXTAREA"]);
		let n = 0;
		const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const hidden = (el) => {
			for (let e = el; e && e !== root.parentElement; e = e.parentElement) {
				if (skip.has(e.tagName) || e.getAttribute("aria-hidden") === "true" || e.classList.contains("sr-only") || e.hidden) return true;
				const cs = getComputedStyle(e);
				if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return true;
				if (e.tagName === "DETAILS" && !e.open && !el.closest("summary")) return true;
			}
			return false;
		};
		while (w.nextNode()) {
			const t = w.currentNode;
			const m = t.textContent?.match(re);
			if (!m || !t.parentElement || hidden(t.parentElement)) continue;
			const r = document.createRange();
			r.selectNodeContents(t);
			const b = r.getBoundingClientRect();
			if (b.width === 0 || b.height === 0) continue;
			n += m.length;
		}
		return n;
	});

/** Height of the card, its visible words, and whether its decision buttons are on screen without any scrolling. */
async function cardMetrics(page, card, buttonSels) {
	await sleep(450); // entry animation
	const box = await card.boundingBox();
	const vh = await page.evaluate(() => window.innerHeight);
	const btns = [];
	for (const s of buttonSels) {
		const b = await card.locator(s).first().boundingBox();
		btns.push(!!b && b.y >= 0 && b.y + b.height <= vh);
	}
	return { h: Math.round(box.height), units: await unitsIn(card), actionsOnScreen: btns.every(Boolean), cardTopOnScreen: box.y >= 0 };
}

/** A group of checks: if the page lacks what they look at (the old build), the group fails as one line instead of aborting the run. */
const sec = async (name, fn) => {
	try {
		await fn();
	} catch (e) {
		check(`${name} (aborted)`, false, String(e.message).split("\n")[0]);
	}
};
const errors = [];
let ok = false;
try {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	const page = await ctx.newPage();
	page.on("pageerror", (e) => errors.push(String(e)));
	if (BEFORE) page.setDefaultTimeout(4000);
	await register(page, base, { email: "r10ux@example.com", name: "林夏" });
	const startConv = async (p, text) => {
		await p.goto(`${base}/`);
		await p.waitForSelector(T("home-greeting"));
		await sendMessage(p, text);
		await p.waitForURL(/\/c\//);
		return convOf(p);
	};

	// ================================================================ conversations that stay pending (real fixture approvals + credential)
	const medium = await startConv(page, `[[call wr_fixture_approval ${JSON.stringify({ title: "对外发送周报", summary: "将《项目周报》v1 发送到 team@example.com", risk: "medium" })}]] 发送前请确认`);
	await page.waitForSelector(T("approval-card"), { timeout: 30000 });
	const high = await startConv(page, `[[call wr_fixture_approval ${JSON.stringify({ title: "删除客户资料", summary: "永久删除 2023 年度的 1,284 条客户联系记录，删除后无法恢复", risk: "high" })}]] 清理旧数据`);
	await page.waitForSelector(T("approval-card"), { timeout: 30000 });
	const cred = await startConv(page, `需要密钥 ${directive("credential_request", { service: "GitHub", purpose: "读取你的项目列表，用来汇总进度", targetHosts: ["api.github.com"], methods: ["GET", "POST"], ttlSec: 3600 })}`);
	await page.waitForSelector(T("credential-card"), { timeout: 30000 });
	// a plain conversation to hang mocked approvals on
	const plain = await startConv(page, "你好，先聊一句");
	await page.waitForSelector(`${T("assistant-message")} .wr-prose`, { timeout: 30000 });
	await idle(page);

	// mocked approvals: the page reads its state from one SSE snapshot; answer it with the real state + the mocked approval
	const SKILL = {
		kind: "skill_draft",
		draftId: "sd_mock1",
		name: "weekly-report",
		title: "周报助手",
		description: "把本周的工作记录整理成一页周报，按项目分组，并在末尾列出下周计划和需要协调的事项。",
		version: "1.0.0",
		skillKind: "executable",
		files: [
			{ path: "SKILL.md", size: 412, sha256: "a".repeat(64), executable: false },
			{ path: "scripts/run.py", size: 1280, sha256: "b".repeat(64), executable: true },
			{ path: "templates/weekly.md", size: 640, sha256: "d".repeat(64), executable: false },
		],
		totalBytes: 2332,
		packageSha256: "c0ffee".repeat(10) + "abcd",
		requiredPermissions: ["sandbox.exec", "network"],
		requiredTools: [],
		findings: [
			{ severity: "warn", code: "script.network", message: "脚本 scripts/run.py 里有联网请求，使用时需要你另外授权联网。" },
			{ severity: "warn", code: "script.write", message: "脚本会在工作区里写入 report.md，已存在的同名文件会被覆盖。" },
		],
		sourceDir: "my-skill",
	};
	const MOCKS = {
		mcp: {
			approvalId: "ap_mock_mcp",
			toolName: "mcp_call",
			title: "确认外部操作：飞书 / 发送消息",
			summary: "将向飞书群「项目组」发送一条消息，内容是本周进展汇总：已完成需求评审、接口联调，下周开始灰度发布。消息发出后所有群成员都能看到，无法撤回。",
			detail: { to: "项目组", subject: "本周进展汇总", message: "本周完成了需求评审、接口联调；下周开始灰度发布。请相关同学关注。", attachments: ["进展.xlsx", "排期.pdf"] },
			risk: "medium",
		},
		skill: { approvalId: "ap_mock_skill", toolName: "skill_manage", title: "保存技能草稿「weekly-report」", summary: "把 my-skill 保存为个人技能 weekly-report v1.0.0", detail: SKILL, risk: "medium" },
		skillBlocked: { approvalId: "ap_mock_blocked", toolName: "skill_manage", title: "保存技能草稿「weekly-report」", summary: "把 my-skill 保存为个人技能 weekly-report v1.0.0", detail: { ...SKILL, findings: [{ severity: "error", code: "script.secret", message: "脚本里写死了一个看起来像密钥的字符串，请改为通过凭据请求获取。" }, ...SKILL.findings] }, risk: "medium" },
	};
	const mkApproval = (kind) => ({ conversationId: Number(plain[2]), callId: `call_${kind}`, status: "pending", requestedAt: new Date().toISOString(), ...MOCKS[kind] });
	const mockPage = async (p, kind) => {
		const c = plain;
		await p.route(new RegExp(`/api/conversations/${c[1]}/${c[2]}/events`), async (route) => {
			const j = await (await p.request.get(`${base}/api/conversations/${c[1]}/${c[2]}/state`)).json();
			const body = `retry: 400\nevent: snapshot\ndata: ${JSON.stringify({ ...j, approvals: [...(j.approvals ?? []), mkApproval(kind)] })}\n\n`;
			await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }, body });
		});
		await p.goto(`${base}/c/${c[1]}/${c[2]}`);
		await p.waitForSelector(T("approval-card"), { timeout: 20000 });
	};

	// ================================================================ A. approval cards: 1440 / 390 × light / dark
	const combos = [
		[1440, 900, "light"],
		[1440, 900, "dark"],
		[390, 844, "light"],
		[390, 844, "dark"],
	];
	const A = {};
	for (const [w, h, scheme] of combos) {
		const tag = `${w}-${scheme}`;
		const cx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w < 500 ? 2 : 1, locale: "zh-CN", colorScheme: scheme, storageState: await ctx.storageState() });
		await cx.addInitScript((s) => localStorage.setItem("workroom-theme", s), scheme);
		const p = await cx.newPage();
		p.on("pageerror", (e) => errors.push(String(e)));
		const open = async (c) => {
			await p.goto(`${base}/c/${c[1]}/${c[2]}`);
			await p.waitForSelector(`${T("approval-card")}, ${T("credential-card")}`, { timeout: 20000 });
		};
		// real medium
		await open(medium);
		A[`medium-${tag}`] = await cardMetrics(p, p.locator(T("approval-card")), [T("approve"), T("reject")]);
		await shot(p, `approval-medium-${tag}`);
		if (w === 390) check(`A medium ${tag}: no horizontal scroll`, await noHScroll(p));
		// real high
		await open(high);
		A[`high-${tag}`] = await cardMetrics(p, p.locator(T("approval-card")), [T("approve"), T("reject")]);
		await shot(p, `approval-high-${tag}`);
		// credential
		await open(cred);
		A[`credential-${tag}`] = await cardMetrics(p, p.locator(T("credential-card")), [T("credential-submit"), T("credential-decline")]);
		await shot(p, `credential-${tag}`);
		if (w === 390) check(`A credential ${tag}: no horizontal scroll`, await noHScroll(p));
		await p.close();
		// mocked kinds
		for (const kind of ["mcp", "skill", "skillBlocked"]) {
			const mp = await cx.newPage();
			mp.on("pageerror", (e) => errors.push(String(e)));
			await mockPage(mp, kind);
			A[`${kind}-${tag}`] = await cardMetrics(mp, mp.locator(T("approval-card")), [T("approve"), T("reject")]);
			if (kind !== "skillBlocked") await shot(mp, `approval-${kind}-${tag}`);
			if (w === 390) check(`A ${kind} ${tag}: no horizontal scroll`, await noHScroll(mp));
			await mp.close();
		}
		await cx.close();
	}
	for (const [k, v] of Object.entries(A)) note(`card.${k}`, v);

	// ---- the new behaviour (checked at 390 light, the tightest layout)
	const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "zh-CN", storageState: await ctx.storageState() });
	if (BEFORE) phone.setDefaultTimeout(2500);
	await sec("A new behaviour", async () => {
		const p = await phone.newPage();
		p.on("pageerror", (e) => errors.push(String(e)));
		await p.goto(`${base}/c/${medium[1]}/${medium[2]}`);
		const card = p.locator(T("approval-card"));
		await card.waitFor({ timeout: 20000 });
		await sleep(450);
		const m = A["medium-390-light"];
		check("A medium 390: decision buttons are on screen without scrolling, and so is the top of the card", m.actionsOnScreen && m.cardTopOnScreen);
		check("A medium 390: the risk is a small badge (名称 + 等级), the title and the one-line summary are visible", (await card.locator(T("approval-risk")).innerText()).includes("中风险") && (await card.innerText()).includes("对外发送周报") && (await card.locator(T("approval-summary")).innerText()).includes("team@example.com"));
		check("A medium 390: compact (card ≤ 170px high)", m.h <= 170, `${m.h}px`);
		const toggle = card.locator(T("approval-details-toggle"));
		check("A medium 390: 查看详情 is collapsed by default and says so (aria-expanded=false)", (await toggle.count()) === 1 && (await toggle.getAttribute("aria-expanded")) === "false" && (await toggle.innerText()).includes("查看详情"));
		const closedText = await card.innerText();
		check("A medium 390: folded — 请求人 / 风险说明 / 技术详情 are not on the face", !closedText.includes("请求人") && !closedText.includes("影响") && !closedText.includes("会对外部系统产生变化"), closedText.replace(/\s+/g, " "));
		check("A medium 390: buttons are 拒绝 / 允许 / 查看详情 / 添加说明, nothing focused on open", (await card.locator("button").allInnerTexts()).map((t) => t.trim()).join("|") === "拒绝|允许|查看详情|添加说明" && !["approve", "approve-confirm"].includes(await p.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "")), (await card.locator("button").allInnerTexts()).map((t) => t.trim()).join("|"));
		await toggle.click();
		await sleep(250);
		const openText = await card.innerText();
		check("A medium 390: 查看详情 opens everything that was folded (请求人 / 代你执行 / 风险说明)", (await toggle.getAttribute("aria-expanded")) === "true" && ["请求人", "代你执行", "风险", "会对外部系统产生变化"].every((s) => openText.includes(s)), openText.replace(/\s+/g, " "));
		await shot(p, "approval-medium-390-details-open");
		check("A medium 390 (details open): no horizontal scroll", await noHScroll(p));
		await toggle.click();
		check("A medium 390: 收起 hides them again", (await card.innerText()).includes("请求人") === false);

		// high risk keeps its one-line warning on the face and its second click
		await p.goto(`${base}/c/${high[1]}/${high[2]}`);
		const hi = p.locator(T("approval-card"));
		await hi.waitFor({ timeout: 20000 });
		await sleep(450);
		check("A high 390: 高风险 badge + the 无法撤销 warning are on the face; 允许 still needs a second explicit click", (await hi.locator(T("approval-risk")).innerText()).includes("高风险") && (await hi.innerText()).includes("无法撤销"));
		await hi.locator(T("approve")).click();
		await hi.locator(T("approval-confirm")).waitFor({ timeout: 5000 });
		check("A high 390: the confirmation keeps 返回 (focused) / 确认允许 and fits the screen", (await p.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "approve-back" && (await noHScroll(p)));
		await hi.locator(T("approve-back")).click();

		// mcp: long summary is clamped on the face, in full + the arguments behind 查看详情
		await p.close();
		const mp = await phone.newPage();
		await mockPage(mp, "mcp");
		const mc = mp.locator(T("approval-card"));
		await sleep(450);
		const mcpM = A["mcp-390-light"];
		check("A mcp 390: long summary stays short on the face (card ≤ 210px) and the buttons are on screen", mcpM.h <= 210 && mcpM.actionsOnScreen, `${mcpM.h}px`);
		const mcFace = await mc.innerText();
		const cutH = (await mc.locator(T("approval-summary")).boundingBox()).height;
		check("A mcp 390: the cut summary is two lines and offers 展开全文", mcFace.includes("展开全文") && cutH <= 44, `${Math.round(cutH)}px`);
		await mc.locator(T("clamp-toggle")).click();
		check("A mcp 390: 展开全文 shows the whole summary", (await mc.locator(T("approval-summary")).boundingBox()).height > cutH + 10);
		await mc.locator(T("approval-details-toggle")).click();
		const mcText = await mc.innerText();
		check("A mcp 390: the scope (收件人 / 标题), who asked and the raw arguments are in 查看详情 (nothing dropped)", mcText.includes("收件人") && mcText.includes("项目组") && mcText.includes("本周进展汇总") && mcText.includes("技术详情") && mcText.includes("请求人"), mcText.replace(/\s+/g, " ").slice(0, 200));
		await mp.close();

		// skill draft
		const sp = await phone.newPage();
		await mockPage(sp, "skill");
		const sc = sp.locator(T("approval-card"));
		await sleep(450);
		const sm = A["skill-390-light"];
		check("A skill 390: the draft card is compact (≤ 230px) with 保存 / 不保存 on screen", sm.h <= 230 && sm.actionsOnScreen, `${sm.h}px`);
		const face = await sc.innerText();
		check("A skill 390: face = title, name, 用途, a files/permissions line and a 检查 count; the long file list / sentence are folded", face.includes("保存为个人技能") && face.includes("周报助手") && face.includes("3 个文件") && face.includes("运行代码、联网") && face.includes("2 条提醒") && !face.includes("templates/weekly.md") && !face.includes("仅你可用"), face.replace(/\s+/g, " "));
		await sc.locator(T("approval-details-toggle")).click();
		await sleep(250);
		const sOpen = await sc.innerText();
		check("A skill 390: 查看详情 shows every file, the 可执行脚本 mark, permissions, each finding and the 仅你可用 sentence", ["SKILL.md", "scripts/run.py", "templates/weekly.md", "可执行脚本", "运行代码、联网", "联网请求", "会被覆盖", "保存后仅你可用", "技术详情"].every((s) => sOpen.includes(s)), sOpen.replace(/\s+/g, " ").slice(0, 120));
		await shot(sp, "approval-skill-390-details-open");
		check("A skill 390 (details open): no horizontal scroll", await noHScroll(sp));
		await sp.close();

		// blocked draft: the reason is on the face, 保存 is disabled, 不保存 works
		const bp = await phone.newPage();
		await mockPage(bp, "skillBlocked");
		const bc = bp.locator(T("approval-card"));
		await sleep(450);
		const bface = await bc.innerText();
		check("A blocked 390: 必须修复 + its message are on the face (not folded), 保存 disabled, 不保存 enabled", bface.includes("必须修复") && bface.includes("看起来像密钥") && (await bc.locator(T("approve")).isDisabled()) && !(await bc.locator(T("reject")).isDisabled()), bface.replace(/\s+/g, " ").slice(0, 160));
		await shot(bp, "approval-skill-blocked-390-light");
		await bp.close();

		// credential: hosts + form on the face; the rest behind 查看详情
		const cp = await phone.newPage();
		await cp.goto(`${base}/c/${cred[1]}/${cred[2]}`);
		const cc = cp.locator(T("credential-card"));
		await cc.waitFor({ timeout: 20000 });
		await sleep(450);
		const cm = A["credential-390-light"];
		check("A credential 390: 提交 / 拒绝 are on screen without scrolling; the service, purpose and target hosts are on the face", cm.actionsOnScreen && (await cc.innerText()).includes("GitHub") && (await cc.locator(T("credential-hosts")).innerText()).includes("api.github.com") && (await cc.locator(T("credential-hosts")).isVisible()));
		const cFace = await cc.innerText();
		check("A credential 390: 允许的操作 / 有效期 are folded", !cFace.includes("允许的操作") && !cFace.includes("请在"), cFace.replace(/\s+/g, " "));
		await cc.locator(T("credential-details-toggle")).click();
		const cOpen = await cc.innerText();
		check("A credential 390: 查看详情 shows 允许的操作 (GET, POST), 使用方式 and 有效期, and the tech details are one more level in", ["允许的操作", "GET", "POST", "使用方式", "有效期", "技术详情"].every((s) => cOpen.includes(s)));
		check("A credential 390: the paste warning stays on the face", await cc.locator(T("credential-paste-warning")).isVisible());
		await cp.close();
	});
	await phone.close();

	// ================================================================ B. notices
	// B1. skill saved: real flow with the local driver (before the remote provider is configured)
	const wf = (path, content) => directive("sandbox_write_file", { path, content });
	const skillMd = "---\nname: r10-skill\ndescription: 把输入的名字问候一遍\nversion: 1.0.0\nentry: scripts/run.py\n---\n# r10-skill\n\n运行 scripts/run.py。\n";
	await startConv(page, `帮我创建一个技能 ${wf("my-skill/SKILL.md", skillMd)} ${wf("my-skill/scripts/run.py", 'print("hello")\n')}`);
	await page.waitForSelector(`${T("assistant-message")} .wr-prose`, { timeout: 60000 });
	await idle(page);
	await sendMessage(page, `提交草稿 ${directive("skill_manage", { action: "submit_draft", dir: "my-skill" })}`);
	await page.waitForSelector(T("skill-draft"), { timeout: 60000 });
	await sleep(400);
	await page.locator(T("approve")).click();
	await page.waitForSelector(`${T("skill-draft-result")}[data-state="saved"]`, { timeout: 30000 });
	await idle(page);
	await sleep(400);
	const savedBox = await page.locator(T("skill-draft-result")).boundingBox();
	const savedText = (await page.locator(T("skill-draft-result")).innerText()).replace(/\s+/g, " ");
	note("saved.1440", { h: Math.round(savedBox.height), text: savedText, units: await unitsIn(page.locator(T("skill-draft-result"))) });
	await shot(page, "skill-saved-1440-light");
	check("B skill saved: one slim line (≤ 40px high at 1440) that still says 已保存, the skill and where to find it", savedBox.height <= 40 && savedText.includes("已保存") && savedText.includes("r10-skill") && savedText.includes("我的技能") && (await page.locator(`${T("skill-draft-result")} a`).getAttribute("href")) === "/capabilities", `${Math.round(savedBox.height)}px · ${savedText}`);
	check("B skill saved: is not a card (no border box) and does not sit above the conversation", await page.locator(T("skill-draft-result")).evaluate((el) => getComputedStyle(el).borderTopWidth === "0px" && el.getBoundingClientRect().top > document.querySelector('[data-testid="user-message"]').getBoundingClientRect().top));
	await page.setViewportSize({ width: 390, height: 844 });
	await sleep(300);
	const saved390 = await page.locator(T("skill-draft-result")).boundingBox();
	note("saved.390", { h: Math.round(saved390.height) });
	check("B skill saved 390: fits, no horizontal scroll", await noHScroll(page));
	await shot(page, "skill-saved-390-light");
	await page.setViewportSize({ width: 1440, height: 900 });

	// B2. a failed sandbox step against an unreachable remote sandbox (the user's own case)
	const put = async (path, data) => (await page.request.put(`${base}${path}`, { data })).status();
	const s1 = await put("/api/sandbox/providers/opensandbox", { enabled: true, endpoint: "http://127.0.0.1:9", apiKey: "sk-e2e-unreachable-0123456789", allowPrivateNetwork: true, egressAcknowledged: true });
	const s2 = await put("/api/sandbox/provider-policy", { orgDefault: "opensandbox", allowProjectOverride: false });
	check("B setup: org default = a remote OpenSandbox whose endpoint is unreachable", s1 === 200 && s2 === 200, `${s1}/${s2}`);
	const sbx = await startConv(page, `跑一下 ${directive("sandbox_exec", { language: "shell", code: "echo hi" })}`);
	await idle(page);
	await page.waitForSelector(T("step-chain"), { timeout: 30000 });
	await sleep(1800); // the environment poll settles
	/** Every place that says "this failed": step summary note, inline step failure, env line, run bar, error note — counted by what is visible. */
	const failureReport = async (p) =>
		p.evaluate(() => {
			const vis = (el) => {
				const r = el.getBoundingClientRect();
				return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
			};
			const q = (s) => [...document.querySelectorAll(s)].filter(vis);
			// leaf-ish visible elements outside the model's own answer text and outside folded 技术详情 whose text carries the provider error
			const copies = [...document.querySelectorAll("main *, [data-testid='chat-scroll'] *, [data-testid='composer'] ~ *")]
				.filter((el) => el.children.length === 0 && vis(el) && /fetch failed|创建沙箱失败/.test(el.textContent ?? "") && !el.closest(".wr-prose") && !el.closest("details:not([open])") && !el.closest("[hidden]"))
				.map((el) => el.textContent.trim().slice(0, 60));
			const scroller = document.querySelector('[data-testid="chat-scroll"]');
			const composer = document.querySelector('[data-testid="composer"]');
			const gap = scroller && composer ? Math.round(composer.getBoundingClientRect().top - scroller.getBoundingClientRect().bottom) : null;
			const boxes = (s) => q(s).map((e) => Math.round(e.getBoundingClientRect().height));
			return {
				errorCopies: copies.length,
				copiesText: copies,
				envStatus: boxes('[data-testid="env-status"]'),
				runBar: boxes('[data-testid="run-bar"]'),
				errorNote: boxes('[data-testid="error-note"]'),
				stepFailure: boxes('[data-testid="step-failure"]'),
				stepNote: q('[data-testid="step-chain"] button span').filter((e) => /步失败/.test(e.textContent)).length,
				aboveComposerPx: gap,
			};
		});
	const f1440 = await failureReport(page);
	note("failure.sandbox.1440", f1440);
	note("failure.sandbox.1440.pageUnits", await visibleUnits(page, { exclude: T("sidebar") }));
	await shot(page, "failure-sandbox-1440-light");
	// phone
	const pc = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "zh-CN", storageState: await ctx.storageState() });
	const pp = await pc.newPage();
	await pp.goto(`${base}/c/${sbx[1]}/${sbx[2]}`);
	await pp.waitForSelector(T("step-chain"));
	await sleep(1800);
	const f390 = await failureReport(pp);
	note("failure.sandbox.390", f390);
	const h390 = await noHScroll(pp);
	await shot(pp, "failure-sandbox-390-light");
	await pc.close();
	check("B sandbox failure 390: same — one inline copy, no horizontal scroll", f390.errorCopies <= 1 && h390, JSON.stringify(f390.copiesText));

	await sec("B sandbox failure", async () => {
		check("B sandbox failure: the reason is shown once, inline where it happened (≤ 1 visible copy outside the model's answer and folded details)", f1440.errorCopies <= 1, JSON.stringify(f1440.copiesText));
		check("B sandbox failure: no 工作环境没有准备好 banner repeating it above the composer (the environment button carries a dot instead)", f1440.envStatus.length === 0 && (await page.locator(T("env-dot")).count()) === 1, JSON.stringify(f1440.envStatus));
		check("B sandbox failure: the failure is still visible without opening anything — one 失败 line under the step summary", f1440.stepFailure.length === 1 && f1440.stepFailure[0] <= 44 && /沙箱提供方|创建沙箱失败/.test(await page.locator(T("step-failure")).innerText()), JSON.stringify(f1440.stepFailure));
		check("B sandbox failure: nothing but the composer sits below the conversation (no notice rows above it)", (f1440.aboveComposerPx ?? 99) <= 16, `${f1440.aboveComposerPx}px`);
		// the inline line opens the step (full text, 技术详情 inside)
		await page.locator(`${T("step-failure")} button`).first().click();
		await sleep(250);
		check("B sandbox failure: 详情 opens the step with 技术详情 (tool / arguments / error) — nothing was dropped", (await page.locator(`${T("step-chain")} ${T("tech-details")}`).count()) >= 1);
		// the environment popover still offers the retry
		await page.locator(T("env-button")).click();
		await page.waitForSelector(T("env-popover"));
		check("B sandbox failure: the environment popover shows 准备失败 and offers 重试", (await page.locator(T("env-state")).innerText()).includes("准备失败") && (await page.locator(T("env-prepare")).innerText()).includes("重试"));
		await page.keyboard.press("Escape");
	});

	// B3. env failure with no failed step to explain it (explicit 现在准备 from the popover): one compact line stays
	const envOnly = await startConv(page, "只聊天一句");
	await idle(page);
	await page.locator(T("env-button")).click();
	await page.waitForSelector(T("env-popover"));
	await page.locator(T("env-prepare")).click();
	await page.waitForFunction(() => document.querySelector('[data-testid="env-state"]')?.getAttribute("data-state") === "failed", null, { timeout: 60000 });
	await page.keyboard.press("Escape");
	await page.waitForSelector(T("env-status"), { timeout: 10000 }).catch(async (e) => {
		await page.screenshot({ path: "/tmp/claude-0/scratch/b3.png" });
		throw e;
	});
	await sleep(300);
	const envBox = await page.locator(T("env-status")).boundingBox();
	note("failure.envOnly.1440", { h: Math.round(envBox.height) });
	await sec("B env failure alone", async () => {
		check("B env failure alone: still shown (nothing else explains it) but as one compact line with 重试", envBox.height <= 40 && (await page.locator(T("env-retry")).count()) === 1 && (await page.locator(T("env-status")).innerText()).includes("工作环境没有准备好"), `${Math.round(envBox.height)}px`);
	});
	await shot(page, "failure-env-only-1440-light");

	// B4. a failed run ([[fail]]): inline note + a slim 重试 bar, no second copy of the reason
	await put("/api/sandbox/provider-policy", { orgDefault: "local", allowProjectOverride: false });
	const run = await startConv(page, "[[fail]] 这一步会失败");
	await page.waitForSelector(`${T("run-bar")}[data-status="failed"], ${T("run-bar")}[data-status="interrupted"]`, { timeout: 60000 });
	await sleep(500);
	const rf = await page.evaluate(() => {
		const h = (s) => [...document.querySelectorAll(s)].map((e) => Math.round(e.getBoundingClientRect().height));
		const scroller = document.querySelector('[data-testid="chat-scroll"]');
		const composer = document.querySelector('[data-testid="composer"]');
		return { runBar: h('[data-testid="run-bar"]'), errorNote: h('[data-testid="error-note"]'), techDetails: document.querySelectorAll('[data-testid="tech-details"]').length, aboveComposerPx: Math.round(composer.getBoundingClientRect().top - scroller.getBoundingClientRect().bottom) };
	});
	note("failure.run.1440", rf);
	note("failure.run.1440.pageUnits", await visibleUnits(page, { exclude: T("sidebar") }));
	await shot(page, "failure-run-1440-light");
	const barText = (await page.locator(T("run-bar")).innerText()).replace(/\s+/g, " ");
	const noteText = (await page.locator(T("error-note")).innerText()).replace(/\s+/g, " ");
	await sec("B run failure", async () => {
		check("B run failure: the message shows the reason once (模型调用出错 + 这一轮没有完成), with 技术详情 folded in the same line", /模型调用出错/.test(noteText) && noteText.includes("这一轮没有完成") && (await page.locator(`${T("error-note")} ${T("tech-details")}`).count()) === 1, noteText);
		check("B run failure: the bar above the composer is only the status + 重试 (one slim line, no repeated reason, no second 技术详情)", /重试/.test(barText) && !/模型出错/.test(barText) && (await page.locator(`${T("run-bar")} ${T("tech-details")}`).count()) === 0 && rf.runBar[0] <= 36, `${rf.runBar[0]}px · ${barText}`);
		check("B run failure: the error note is one compact line (≤ 48px)", rf.errorNote[0] <= 48, `${rf.errorNote[0]}px`);
	});
	const reqCont = page.waitForRequest((r) => r.url().endsWith("/continue") && r.method() === "POST", { timeout: 10000 });
	await page.click(T("continue"));
	await reqCont;
	check("B run failure: 重试 still calls the continue route", true);
	await page.waitForSelector(`${T("run-bar")}[data-status="failed"], ${T("run-bar")}[data-status="interrupted"]`, { timeout: 60000 });
	const rp = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "zh-CN", colorScheme: "dark", storageState: await ctx.storageState() });
	await rp.addInitScript(() => localStorage.setItem("workroom-theme", "dark"));
	const rpp = await rp.newPage();
	await rpp.goto(`${base}/c/${run[1]}/${run[2]}`);
	await rpp.waitForSelector(T("run-bar"));
	await sleep(400);
	check("B run failure 390 dark: no horizontal scroll", await noHScroll(rpp));
	await shot(rpp, "failure-run-390-dark");
	await rp.close();

	// B5. stale citations: one line at the top, the explanation one click away
	const cp = await ctx.newPage();
	await cp.route(/\/api\/kb\/conversations\/[^/]+\/\d+\/citation-status/, (route) => route.fulfill({ json: { spaceId: plain[1], conversationId: Number(plain[2]), calls: [], byChunkId: {}, stale: 2 } }));
	await cp.goto(`${base}/c/${plain[1]}/${plain[2]}`);
	await cp.waitForSelector(T("citations-stale-banner"), { timeout: 20000 });
	await sleep(300);
	const sb = await cp.locator(T("citations-stale-banner")).boundingBox();
	note("stale.1440", { h: Math.round(sb.height), units: await unitsIn(cp.locator(T("citations-stale-banner"))) });
	await sec("B stale citations", async () => {
		check("B stale citations: one short line (≤ 32px) that says how many; the explanation is behind 详情", sb.height <= 32 && /2 处引用/.test(await cp.locator(T("citations-stale-banner")).innerText()) && !(await cp.locator(T("citations-stale-banner")).innerText()).includes("旧回答保留原引用"));
		await cp.locator(`${T("citations-stale-banner")} button`).click();
		check("B stale citations: 详情 shows the full explanation", (await cp.locator(T("citations-stale-banner")).innerText()).includes("旧回答保留原引用"));
	});
	await cp.close();

	check("no uncaught page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
	ok = true;
} finally {
	writeFileSync(join(DIR, `round10-chat-ux-${LABEL}-measure.json`), JSON.stringify(M, null, 2));
	await browser.close();
	await server.stop();
}
const pass = summary(join(DIR, `round10-chat-ux-${LABEL}-results.json`));
process.exitCode = ok && pass ? 0 : 1;
