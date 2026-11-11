// Round 4 — 技能 / MCP 市场: upload (drag-drop zip) → automated checks → submit → scoped reviewer screen (manifest, permissions,
// file tree, diff, checks) → approve → market → install; version update re-review with diff; MCP import → review → install wizard;
// personal-MCP approval gate. Screenshots at 1366 / 1440 / 390.
// Run: npm run -w web build && node web/e2e/round4-market.mjs   (port 8866, data dir data/dev-market)
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { check, chromium, register, ROOT, shot, startServer, summary, pick } from "./lib.mjs";

const require = createRequire(import.meta.url);
const { zipSync, strToU8 } = await import(join(ROOT, "node_modules/fflate/esm/browser.js")).catch(() => require(join(ROOT, "node_modules/fflate")));
const PORT = 8866;
const MCP_PORT = 8867;
const TOKEN = "tok-e2e-market";
const dataDir = join(ROOT, "data/dev-market");
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
const { startHttpFixture } = await import(join(ROOT, "server/test/fixtures/mcp-fixture-server.ts"));
const fx = await startHttpFixture(TOKEN, "127.0.0.1", MCP_PORT);

const server = await startServer({
	port: PORT,
	env: { WORKROOM_DATA_DIR: dataDir, WORKROOM_SECRET_KEY: "e2e-market-secret-key-not-for-production", WORKROOM_URL_ALLOWLIST: `127.0.0.1:${MCP_PORT}` },
});
const base = server.base;
const browser = await chromium.launch();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const md = (o) => `---\nname: ${o.name}\ndescription: ${o.description}\nversion: ${o.version}\ncategory: 写作\ntags: [周报, 汇总]\n${o.entry ? `entry: ${o.entry}\n` : ""}${o.permissions ? `permissions: [${o.permissions.join(", ")}]\n` : ""}---\n\n${o.body}\n`;
const DESC = "把本周的工作整理成周报。当用户要求写周报、汇总本周进展时使用。";
const v1Files = {
	"SKILL.md": md({ name: "weekly-report", description: DESC, version: "1.0.0", body: "# 周报\n\n按「本周完成 / 下周计划 / 风险」三段写，每节不超过五条。\n\n- 先列事实，再写判断\n- 数据要注明来源" }),
	"references/format.md": "# 格式\n三段式，每节标题加粗。\n",
};
const v2Files = {
	"SKILL.md": md({ name: "weekly-report", description: DESC, version: "1.1.0", entry: "scripts/collect.py", permissions: ["file.write"], body: "# 周报\n\n按「本周完成 / 下周计划 / 风险」三段写，每节不超过五条。\n\n- 先列事实，再写判断\n- 数据要注明来源\n- 运行 scripts/collect.py 汇总本周文件" }),
	"references/format.md": "# 格式\n三段式，每节标题加粗。\n",
	"scripts/collect.py": "import sys\nprint('collected: ' + sys.argv[1])\n",
};
const zipB64 = (files) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))).toString("base64");
const mcpJson = { name: "io.github.acme/notes", title: "Acme 笔记", description: "笔记服务（测试夹具）：回显文本。", version: "1.0.0", repository: { url: "https://github.com/acme/notes" }, remotes: [{ type: "streamable-http", url: fx.url, headers: [{ name: "Authorization", description: "Bearer 令牌", isRequired: true, isSecret: true }] }] };

const sizes = [[1366, 768, "1366"], [1440, 900, "1440"], [390, 844, "390"]];
async function shots(page, name) {
	const cur = page.viewportSize();
	for (const [w, h, label] of sizes) {
		await page.setViewportSize({ width: w, height: h });
		await sleep(250);
		await shot(page, `${label}-${name}`);
	}
	await page.setViewportSize(cur);
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

const newUser = async (admin, name, role = "member") => {
	const code = (await (await admin.request.post(`${base}/api/admin/invites`, { data: { role, ttlHours: 24 } })).json()).invite.code;
	const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
	const p = await c.newPage();
	const email = `${name}-${Date.now()}@example.com`.replace(/[^\x00-\x7f]/g, "u");
	await p.goto(`${base}/register?invite=${code}`);
	await p.fill("#name", name);
	await p.fill("#email", email);
	await p.fill("#password", "password123");
	await p.click('button[type="submit"]');
	await p.waitForSelector('[data-testid="home-greeting"]');
	const userId = (await (await p.request.get(`${base}/api/me`)).json()).me.userId;
	return { c, p, userId };
};

try {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
	const a = await ctx.newPage();
	await register(a, base, { email: `mk-${Date.now()}@example.com`, name: "组织管理员" });
	const reviewer = await newUser(a, "审核员乙");
	const member = await newUser(a, "成员丙");
	const assign = await a.request.post(`${base}/api/admin/role-assignments`, { data: { subject: { kind: "user", id: reviewer.userId }, roleId: "builtin:skill_reviewer" } });
	check("setup: reviewer holds the 技能审核员 role (skill.review / mcp.connector.review)", assign.ok(), String(assign.status()));

	// ---------------------------------------------------------------- tabs: members do not see 待审核
	await member.p.goto(`${base}/capabilities`);
	await member.p.waitForSelector('[data-testid="tab-mine"]');
	check("tabs: an ordinary member has 技能市场 / 我的技能 / 连接市场 / 我的连接 but no 待审核", (await member.p.locator('[data-testid="tab-market"]').count()) === 1 && (await member.p.locator('[data-testid="tab-mcp"]').count()) === 1 && (await member.p.locator('[data-testid="tab-connectors"]').count()) === 1 && (await member.p.locator('[data-testid="tab-review"]').count()) === 0);

	// ---------------------------------------------------------------- upload by drag-drop (zip) + automated checks
	await a.goto(`${base}/capabilities`);
	await a.waitForSelector('[data-testid="dropzone"]');
	// A real drop event with a File built in the page: the same path a user's drag-drop takes.
	await a.evaluate(async (b64) => {
		const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		const dt = new DataTransfer();
		dt.items.add(new File([bytes], "weekly-report.zip", { type: "application/zip" }));
		document.querySelector('[data-testid="dropzone"]').dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
	}, zipB64(v1Files));
	await a.waitForSelector('[data-testid="upload-result"]', { timeout: 15000 });
	check("upload: dropping a .zip uploads it and shows the automated check result", (await a.locator('[data-testid="upload-result"]').innerText()).includes("已上传「weekly-report」v1"));
	// A malicious zip (zip-slip) is rejected in the UI with the reason, and nothing is added.
	await a.evaluate(async (b64) => {
		const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		const dt = new DataTransfer();
		dt.items.add(new File([bytes], "evil.zip", { type: "application/zip" }));
		document.querySelector('[data-testid="dropzone"]').dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
	}, zipB64({ "SKILL.md": md({ name: "evil", description: DESC, version: "1.0.0", body: "x" }), "../escape.sh": "echo pwned" }));
	await a.waitForSelector('[data-testid="upload-error"]', { timeout: 15000 });
	check("upload: a zip-slip archive is rejected with a visible reason", (await a.locator('[data-testid="upload-error"]').innerText()).includes("zip-slip"));
	check("upload: only the valid skill exists", (await (await a.request.get(`${base}/api/skills`)).json()).skills.length === 1);
	await shots(a, "market-my-skills-upload");

	// ---------------------------------------------------------------- submit for review (UI)
	await a.locator('[data-testid="skill"]').first().locator("button[aria-expanded]").click();
	await a.click('[data-testid="submit-review"]');
	await pick(a.locator('[data-testid="submit-scope"]'), "org");
	await a.click('[data-testid="submit-confirm"]');
	await a.waitForSelector('[data-testid="my-submission"][data-state="pending_review"]', { timeout: 15000 });
	check("submit: the submission is pending review in 我的提交", true);

	// ---------------------------------------------------------------- reviewer: queue, review screen, approve
	const r = reviewer.p;
	await r.goto(`${base}/capabilities`);
	await r.waitForSelector('[data-testid="tab-review"]');
	await r.waitForFunction(() => document.querySelector('[data-testid="review-count"]')?.textContent === "1", null, { timeout: 15000 });
	check("review: the reviewer sees the 待审核 tab with a count of 1", true);
	await r.click('[data-testid="tab-review"]');
	await r.click('[data-testid="review-item"]');
	await r.waitForSelector('[data-testid="review-screen"] [data-testid="manifest"]');
	const mtext = await r.locator('[data-testid="manifest"]').innerText();
	check("review: shows what it is, and the automated-check verdict first", mtext.includes("weekly-report") && (await r.getByText("自动检查").count()) >= 1 && (await r.locator('[data-testid="check-verdict"]').count()) === 1);
	check("review: diff tab lists the new files (first version → all added)", (await r.locator('[data-testid="diff"] [data-status="added"]').count()) === 2);
	await r.click('[data-testid="review-tab-files"]');
	await r.click('[data-path="SKILL.md"]');
	await r.waitForSelector('[data-testid="file-viewer"]');
	check("review: file tree + viewer show SKILL.md content", (await r.locator('[data-testid="file-viewer"]').innerText()).includes("name: weekly-report"));
	await r.click('[data-testid="review-tab-diff"]');
	await shots(r, "market-review-v1");
	check("review: approve is disabled until… the reviewer is not the submitter, so it is enabled", await r.locator('[data-testid="approve"]').isEnabled());
	check("review: reject needs a comment (disabled while empty)", !(await r.locator('[data-testid="reject"]').isEnabled()));
	await r.fill('[data-testid="decision-comment"]', "格式清晰，可以发布");
	await r.click('[data-testid="approve"]');
	await r.click('[data-testid="confirm-ok"]');
	await r.waitForSelector('[data-testid="review-screen"]', { state: "detached", timeout: 15000 });
	check("review: approved item leaves the queue", true);

	// The submitter sees the "self-review" explanation instead of working buttons.
	await a.goto(`${base}/capabilities?tab=review`);
	check("self-review: the submitter cannot decide their own (no queue entry for a published item)", (await a.locator('[data-testid="review-item"]').count()) === 0);

	// ---------------------------------------------------------------- market: browse, detail, install
	const m = member.p;
	await m.goto(`${base}/capabilities?tab=market`);
	await m.waitForSelector('[data-testid="market-skill"]');
	check("market: the published skill is listed for a member, with version and author", (await m.locator('[data-testid="market-skill"]').first().innerText()).includes("v1.0.0"));
	await m.fill('[data-testid="market-search"]', "不存在的关键词");
	await m.waitForSelector("text=没有符合条件的技能");
	await m.fill('[data-testid="market-search"]', "周报");
	await m.waitForSelector('[data-testid="market-skill"]');
	check("market: search by keyword", true);
	await m.click('[data-testid="market-skill"]');
	await m.waitForSelector('[data-testid="skill-detail"] [data-testid="readme"]');
	await shots(m, "market-skill-detail");
	await m.click('role=tab[name="权限"]');
	check("detail: permissions tab explains no extra permission is needed", (await m.locator('[data-testid="skill-detail"]').innerText()).includes("无需额外权限"));
	await m.click('role=tab[name="更新日志"]');
	check("detail: changelog lists the published version", (await m.locator('[data-testid="changelog"]').innerText()).includes("已发布"));
	await m.click('[data-testid="market-install"]');
	check("install: org-wide target is disabled for an ordinary member", !(await m.locator('[data-testid="install-target-org"]').isEnabled()));
	await m.click('[data-testid="install-confirm"]');
	await m.waitForSelector('[data-testid="installed-for"]', { timeout: 15000 });
	check("install: installed for me", (await m.locator('[data-testid="installed-for"]').innerText()).includes("我"));

	// ---------------------------------------------------------------- version update → re-review with diff and new permission
	const up2 = await a.request.post(`${base}/api/market/skills/upload`, { data: { zipBase64: zipB64(v2Files), skillId: (await (await a.request.get(`${base}/api/skills`)).json()).skills[0].id } });
	check("update: v2 (adds a script and file.write) uploaded", up2.ok(), `${up2.status()}`);
	const sk = (await (await a.request.get(`${base}/api/skills`)).json()).skills[0];
	const sub2 = await a.request.post(`${base}/api/market/skills/${sk.id}/versions/${(await up2.json()).versionNo}/submit`, { data: { targetScope: "org", note: "加入汇总脚本" } });
	check("update: v2 submitted", sub2.ok());
	await r.goto(`${base}/capabilities?tab=review`);
	await r.click('[data-testid="review-item"]');
	await r.waitForSelector('[data-testid="manifest"]');
	await r.waitForSelector('[data-testid="diff"] [data-path="scripts/collect.py"]');
	const diffText = await r.locator('[data-testid="diff"]').innerText();
	check("re-review: diff vs the approved v1 shows the added script and the changed SKILL.md", diffText.includes("scripts/collect.py") && diffText.includes("SKILL.md") && (await r.locator('[data-testid="diff"] [data-status="modified"]').count()) === 1);
	check("re-review: newly requested permissions are highlighted (新增)", (await r.locator('[data-testid="manifest"]').innerText()).includes("新增"));
	await shots(r, "market-review-v2-diff");
	await r.fill('[data-testid="decision-comment"]', "新增脚本已检查，可以发布");
	await r.click('[data-testid="approve"]');
	await r.click('[data-testid="confirm-ok"]');
	await r.waitForSelector('[data-testid="review-screen"]', { state: "detached", timeout: 15000 });
	await m.goto(`${base}/capabilities?tab=market`);
	await m.waitForSelector('[data-testid="market-skill"]');
	check("re-review: after approval the market shows v1.1.0", (await m.locator('[data-testid="market-skill"]').first().innerText()).includes("v1.1.0"));

	// ---------------------------------------------------------------- MCP market: import → submit → review → install
	await a.goto(`${base}/capabilities?tab=mcp`);
	await a.click('[data-testid="mcp-import"]');
	await a.fill('[data-testid="mcp-json"]', JSON.stringify(mcpJson));
	await a.click('[data-testid="mcp-import-go"]');
	await a.waitForSelector('[data-testid="mcp-detail"] [data-testid="mcp-options"]', { timeout: 15000 });
	check("mcp: a pasted server.json is imported as a draft with its install option", (await a.locator('[data-testid="mcp-options"]').innerText()).includes("远程"));
	await a.click('[data-testid="mcp-submit"]');
	await a.click('[data-testid="mcp-submit-confirm"]');
	await a.waitForFunction(() => !document.querySelector('[data-testid="mcp-submit-confirm"]'), null, { timeout: 15000 });
	await r.goto(`${base}/capabilities?tab=review`);
	await r.click('[data-testid="review-item"]');
	await r.waitForSelector('[data-testid="mcp-info"]');
	const info = await r.locator('[data-testid="mcp-info"]').innerText();
	check("mcp review: reviewer sees the URL and secret NAMES only", info.includes(`127.0.0.1:${MCP_PORT}`) && info.includes("Authorization") && !info.includes(TOKEN));
	await shots(r, "market-review-mcp");
	await r.fill('[data-testid="decision-comment"]', "内部笔记服务");
	await r.click('[data-testid="approve"]');
	await r.click('[data-testid="confirm-ok"]');
	await r.waitForSelector('[data-testid="review-screen"]', { state: "detached", timeout: 15000 });
	await m.goto(`${base}/capabilities?tab=mcp`);
	await m.waitForSelector('[data-testid="mcp-entry"]');
	await shots(m, "market-mcp");
	await m.click('[data-testid="mcp-entry"]');
	await m.waitForSelector('[data-testid="mcp-install"]');
	await m.click('[data-testid="mcp-install"]');
	check("mcp install: the secret input is a password field", (await m.locator('[data-testid="input-Authorization"]').getAttribute("type")) === "password");
	await m.fill('[data-testid="input-Authorization"]', `Bearer ${TOKEN}`);
	await m.click('[data-testid="mcp-install-confirm"]');
	await m.waitForSelector('[data-testid="install-result"]', { timeout: 20000 });
	check("mcp install: connected", (await m.locator('[data-testid="install-result"]').innerText()).includes("已连接"));
	await m.goto(`${base}/capabilities?tab=connectors`);
	await m.waitForSelector('[data-testid="connector"]');
	const cardText = await m.locator('[data-testid="connector"]').first().innerText();
	check("connectors: installed connector is 可用, tools listed, secret value not shown", cardText.includes("可用") && cardText.includes("echo") && !cardText.includes(TOKEN));
	// Per-tool control: switch whoami off for me.
	await pick(m.locator('[data-tool="whoami"] [data-wr-select]').first(), "disabled");
	await m.waitForSelector('[data-tool="whoami"][data-disabled="true"]', { timeout: 10000 });
	check("connectors: a user can switch a tool off for themselves", true);
	await shots(m, "market-connectors");

	// ---------------------------------------------------------------- personal MCP approval policy
	await a.goto(`${base}/capabilities?tab=market`);
	await a.click('[data-testid="market-policy"]');
	await pick(a.locator('[data-testid="policy-mcp"]'), "approval");
	await a.waitForFunction(() => document.querySelector('[data-testid="policy-mcp"]')?.getAttribute("data-value") === "approval");
	await sleep(400);
	await a.keyboard.press("Escape");
	const created = await m.request.post(`${base}/api/connectors`, { data: { name: "我的外部服务", scope: "personal", transport: "http", url: fx.url, secrets: { Authorization: `Bearer ${TOKEN}` } } });
	const cj = await created.json();
	check("approval policy: a new personal connector is pending and not connected", cj.connector?.market?.approvalState === "pending" && cj.connector.status === "unchecked");
	await m.goto(`${base}/capabilities?tab=connectors`);
	await m.waitForSelector('[data-approval="pending"]');
	check("approval policy: the card says it is waiting for review", (await m.locator('[data-approval="pending"]').innerText()).includes("等待审核"));
	await r.goto(`${base}/capabilities?tab=review`);
	await r.click('[data-testid="review-item"]');
	await r.waitForSelector('[data-testid="mcp-info"]');
	await r.fill('[data-testid="decision-comment"]', "内部服务，同意");
	await r.click('[data-testid="approve"]');
	await r.click('[data-testid="confirm-ok"]');
	await r.waitForSelector('[data-testid="review-screen"]', { state: "detached", timeout: 15000 });
	await m.reload();
	await m.waitForFunction(() => [...document.querySelectorAll('[data-testid="connector"]')].some((e) => e.textContent.includes("我的外部服务") && e.textContent.includes("可用")), null, { timeout: 20000 });
	check("approval policy: after approval the connector connects", true);
	await shots(m, "market-connectors-approved");

	// ---------------------------------------------------------------- layout sanity at narrow width
	await a.setViewportSize({ width: 390, height: 844 });
	for (const tab of ["market", "mine", "review", "mcp", "connectors"]) {
		await a.goto(`${base}/capabilities?tab=${tab === "mine" ? "" : tab}`.replace("tab=&", "").replace(/\?$/, ""));
		await a.waitForSelector('[data-testid="tab-mine"]');
		await sleep(400);
		check(`mobile 390: ${tab} tab has no horizontal page scroll`, await noOverflow(a));
	}
	await a.setViewportSize({ width: 1440, height: 900 });
	await shots(a, "market-final");
} catch (e) {
	check("script completed", false, String(e?.message ?? e).slice(0, 300));
} finally {
	await browser.close();
	await server.stop();
	await fx.close();
}
const ok = summary(join(ROOT, "artifacts/screenshots/round4-market.json"));
process.exit(ok ? 0 : 1);
