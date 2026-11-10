// Round 5 · UI group 3 (admin console, models, permissions, settings, skill/connection review): simplification + accessibility.
//   - grouped admin navigation, keyboard reachable (Tab / arrows / Enter / Esc)
//   - no internal vocabulary (pi-ai, provider, CredentialStore, namespaces, fixture, JSON, sha256) in visible text outside 技术详情
//   - high-risk / sensitive operations ask first, say what happens, default focus on 取消, and cancel changes nothing (checked against the API)
//   - three-step model service dialog against a local mock (test connection → fetched models → choose which to open)
//   - review screen: checks verdict first, consequence stated, reviewers cannot decide their own submission
//   - dark mode: text contrast >= 4.5:1 on the new pages, popovers/dialogs opaque
//   - no horizontal scroll at 390
// Screenshots go to artifacts/screenshots/round5/after/g3-*.png (1440 / 1366 / 390, deviceScaleFactor 2).
// Run: npm run -w web build && node web/e2e/round5-g3.mjs      (port 8873, data dir data/dev-ui3)
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { check, chromium, ROOT, sleep, startServer, summary } from "./lib.mjs";

const require = createRequire(import.meta.url);
const { zipSync, strToU8 } = await import(join(ROOT, "node_modules/fflate/esm/browser.js")).catch(() => require(join(ROOT, "node_modules/fflate")));
const { startOpenAIMock, startAnthropicMock } = await import(join(ROOT, "server/test/models-mock-servers.ts"));

const OUT = join(ROOT, "artifacts/screenshots/round5/after");
mkdirSync(OUT, { recursive: true });
const PORT = 8873;
const dataDir = join(ROOT, "data/dev-ui3");
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
const openai = await startOpenAIMock();
const openai2 = await startOpenAIMock({ models: ["wizard-chat", "wizard-vision", "text-embedding-wizard"] });
const anth = await startAnthropicMock();
const server = await startServer({
	port: PORT,
	env: { WORKROOM_DATA_DIR: dataDir, WORKROOM_SECRET_KEY: "ui3-dev-secret-key-not-for-production-0123", WORKROOM_URL_ALLOWLIST: [openai, openai2, anth].map((m) => `127.0.0.1:${m.port}`).join(",") },
});
const base = server.base;
const browser = await chromium.launch();

const JARGON = /pi-ai|provider|CredentialStore|namespaces?|fixture|JSON|sha256/i;
const md = (o) => `---\nname: ${o.name}\ndescription: ${o.description}\nversion: ${o.version}\ncategory: 写作\ntags: [周报]\n${o.entry ? `entry: ${o.entry}\n` : ""}${o.permissions ? `permissions: [${o.permissions.join(", ")}]\n` : ""}---\n\n${o.body}\n`;
const DESC = "把本周的工作整理成周报。当用户要求写周报、汇总本周进展时使用。";
const v1 = { "SKILL.md": md({ name: "weekly-report", description: DESC, version: "1.0.0", body: "# 周报\n\n按「本周完成 / 下周计划 / 风险」三段写。" }), "references/format.md": "# 格式\n三段式。\n" };
const v2 = { ...v1, "SKILL.md": md({ name: "weekly-report", description: DESC, version: "1.1.0", entry: "scripts/collect.py", permissions: ["file.write", "sandbox.exec"], body: "# 周报\n\n按三段写。\n\n- 运行 scripts/collect.py 汇总本周文件" }), "scripts/collect.py": "import sys\nprint('collected: ' + sys.argv[1])\n" };
const zipB64 = (files) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))).toString("base64");

let ok = false;
try {
	// ------------------------------------------------------------------ seed through the real API
	const octx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
	const op = await octx.newPage();
	await op.goto(`${base}/register`);
	await op.fill("#name", "陈所有者");
	await op.fill("#email", "owner@ui3.example");
	await op.fill("#password", "password123");
	await op.click('button[type="submit"]');
	await op.waitForSelector('[data-testid="home-greeting"]');
	const api = octx.request;
	const J = async (r) => {
		if (!r.ok()) throw new Error(`${r.url()} ${r.status()} ${await r.text()}`);
		return r.json();
	};
	const newUser = async (name, role = "member") => {
		const code = (await J(await api.post(`${base}/api/admin/invites`, { data: { role, ttlHours: 24 } }))).invite.code;
		const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
		const j = await J(await ctx.request.post(`${base}/api/auth/register`, { data: { email: `${name}@ui3.example`, name, password: "password123", inviteCode: code } }));
		return { ctx, me: j.me, api: ctx.request };
	};
	const zhang = await newUser("张三");
	const li = await newUser("李四");
	const wang = await newUser("王五");
	const zhao = await newUser("赵六");
	const qian = await newUser("钱八");
	const sun = await newUser("孙七", "guest");
	const reviewer = await newUser("审核员乙");
	const member = await newUser("成员丙");
	const dept = async (name, parentId) => (await J(await api.post(`${base}/api/admin/departments`, { data: { name, ...(parentId ? { parentId } : {}) } }))).department;
	const sales = await dept("销售部");
	const rd = await dept("研发部");
	const east = await dept("华东", sales.id);
	const west = await dept("华西", sales.id);
	const platform = await dept("平台组", rd.id);
	await dept("市场部");
	const setMem = (d, u, role = "member") => api.put(`${base}/api/admin/departments/${d.id}/members`, { data: { userId: u.me.userId, role } });
	await setMem(east, li, "manager");
	await setMem(sales, zhang);
	await setMem(platform, wang);
	await setMem(west, zhao);
	const assignRole = (u, roleId, scope) => api.post(`${base}/api/admin/role-assignments`, { data: { subject: { kind: "user", id: u.me.userId }, roleId, ...(scope ? { scope } : {}) } });
	await assignRole(zhang, "builtin:dept_admin", { kind: "department", id: sales.id });
	await assignRole(reviewer, "builtin:skill_reviewer");
	await assignRole(qian, "builtin:auditor");
	const audit = (await J(await api.post(`${base}/api/admin/roles`, { data: { name: "内部审计", description: "查看审计日志与组织统计", permissions: ["audit.view", "stats.org.view", "trace.view"] } }))).role;
	const risky = (await J(await api.post(`${base}/api/admin/roles`, { data: { name: "人员清理", description: "可以把成员移出组织", permissions: ["member.view", "member.remove"] } }))).role;
	await assignRole(zhao, audit.id, { kind: "org" });
	await api.post(`${base}/api/admin/members/${sun.me.userId}/disable`);
	const p1 = (await J(await api.post(`${base}/api/admin/model-providers`, { data: { name: "公司模型网关", type: "openai-completions", baseUrl: `${openai.url}/v1`, apiKey: "sk-mock-openai-KEY-0123456789abcdef", preset: "openai-compatible" } }))).provider;
	const p2 = (await J(await api.post(`${base}/api/admin/model-providers`, { data: { name: "Claude 中转", type: "anthropic-messages", baseUrl: anth.url, apiKey: "sk-ant-mock-KEY-0123456789abcdef", preset: "claude-relay" } }))).provider;
	await api.post(`${base}/api/admin/model-providers/${p1.id}/fetch-models`, { data: {} });
	await api.patch(`${base}/api/admin/model-providers/${p1.id}/models`, { data: { modelIds: ["mock-chat", "mock-vision"], enabled: true } });
	await api.post(`${base}/api/admin/model-providers/${p2.id}/fetch-models`, { data: { enable: "all" } });
	await api.post(`${base}/api/admin/model-providers/${p1.id}/test`, { data: {} });
	const up1 = await J(await api.post(`${base}/api/market/skills/upload`, { data: { zipBase64: zipB64(v1) } }));
	const sk = (await J(await api.get(`${base}/api/skills`))).skills[0];
	await J(await api.post(`${base}/api/market/skills/${sk.id}/versions/${up1.versionNo}/submit`, { data: { targetScope: "org", note: "第一版，三段式周报" } }));
	const q1 = (await J(await reviewer.api.get(`${base}/api/market/submissions?view=queue`))).submissions[0];
	await J(await reviewer.api.post(`${base}/api/market/submissions/${q1.id}/decision`, { data: { decision: "approve", comment: "可以发布" } }));
	const up2 = await J(await api.post(`${base}/api/market/skills/upload`, { data: { zipBase64: zipB64(v2), skillId: sk.id } }));
	await J(await api.post(`${base}/api/market/skills/${sk.id}/versions/${up2.versionNo}/submit`, { data: { targetScope: "org", note: "加入汇总脚本" } }));
	check("seed: owner, departments, members, roles, two model services and a pending skill submission exist", true);

	const access = async (u) => (await J(await api.get(`${base}/api/admin/members/${u.me.userId}/access`))).access;
	const confirmVisible = (p) => p.locator('[data-testid="confirm-dialog"]').isVisible();
	const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1);
	const bodyText = (p) => p.evaluate(() => document.body.innerText);
	const jargonFree = async (p, label) => {
		const t = await bodyText(p);
		const m = t.match(JARGON);
		check(`wording: no internal vocabulary on ${label}`, !m, m ? `"${m[0]}" in …${t.slice(Math.max(0, m.index - 30), m.index + 30).replace(/\s+/g, " ")}…` : "");
	};
	const p = op;

	// ------------------------------------------------------------------ admin shell: grouped navigation, keyboard
	await p.goto(`${base}/admin?tab=members`);
	await p.waitForSelector('[data-testid="admin-member"]');
	const groups = await p.locator('[data-testid="admin-tabs"] [role="group"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
	check("admin: navigation is grouped 成员与组织 / 角色与权限 / 模型 / 技能与连接 / 用量与预算 / 审计", ["成员与组织", "角色与权限", "模型", "技能与连接", "用量与预算", "审计"].every((g, i) => groups[i] === g), groups.join(","));
	check("admin: the page title is short and has no paragraph subtitle", (await p.locator("h1").innerText()) === "组织管理" && (await p.locator("h1 ~ p").count()) === 0);
	await p.focus('[data-testid="admin-tab-members"]');
	await p.keyboard.press("ArrowDown");
	check("keyboard: ArrowDown moves focus to the next navigation entry", (await p.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "admin-tab-invites");
	await p.keyboard.press("Enter");
	await p.waitForURL(/tab=invites/);
	await p.waitForSelector('[data-testid="invite-create"]');
	check("keyboard: Enter opens the focused page", (await p.locator('[data-testid="admin-tab-invites"]').getAttribute("aria-current")) === "page");
	await p.focus('[data-testid="admin-tab-invites"]');
	await p.keyboard.press("End");
	check("keyboard: End jumps to the last entry", (await p.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "admin-tab-trace");
	await p.keyboard.press("Home");
	check("keyboard: Home jumps back to the first entry", (await p.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "admin-tab-members");
	await p.keyboard.press("Tab");
	check("keyboard: Tab leaves the navigation into the page content", (await p.evaluate(() => !document.activeElement?.closest('[data-testid="admin-tabs"]'))));
	// member drawer by keyboard
	await p.goto(`${base}/admin?tab=members`);
	await p.waitForSelector('[data-testid="admin-member"]');
	await p.locator('[data-testid="admin-member"]', { hasText: "王五" }).locator('[data-testid="member-detail-open"]').focus();
	await p.keyboard.press("Enter");
	await p.waitForSelector('[data-testid="member-detail"] [data-testid="detail-effective"]');
	check("keyboard: Enter on 详情 opens the member drawer", true);
	await jargonFree(p, "the member drawer");
	const order = await p.locator('[data-testid="member-detail"] section[aria-label]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
	check("member drawer: identity → roles → departments → effective permissions → sessions → account actions", ["身份", "角色", "部门", "有效权限", "登录会话", "账号操作"].join() === order.join(), order.join(" > "));
	await p.keyboard.press("Escape");
	await p.waitForSelector('[data-testid="member-detail"]', { state: "detached" });
	check("keyboard: Esc closes the member drawer", true);

	// ------------------------------------------------------------------ wording on the admin pages
	for (const [tab, wait, label] of [
		["members", '[data-testid="admin-member"]', "成员"],
		["invites", '[data-testid="invite-create"]', "邀请"],
		["departments", '[data-testid="admin-departments"]', "组织架构"],
		["sessions", '[data-testid="admin-sessions"]', "登录会话"],
		["roles", '[data-testid="role-item"]', "角色"],
		["authz", '[data-testid="authz-form"]', "授权"],
		["models", '[data-testid="model-provider-row"]', "模型服务"],
		["budgets", '[data-testid="budget-create"]', "预算"],
		["audit", '[data-testid="admin-audit"]', "审计日志"],
		["trace", '[data-testid="trace-q"]', "问题排查"],
	]) {
		await p.goto(`${base}/admin?tab=${tab}`);
		await p.waitForSelector(wait);
		await jargonFree(p, `the ${label} page`);
	}
	// models: expanded service row (technical details stay collapsed)
	await p.goto(`${base}/admin?tab=models`);
	await p.waitForSelector('[data-testid="model-provider-row"]');
	await p.locator('[data-testid="provider-expand"]').first().click();
	await p.waitForSelector('[data-testid="provider-models"] [data-testid="model-row"]');
	await jargonFree(p, "an opened model service");
	const rowText = await p.locator('[data-testid="model-provider-row"]').first().innerText();
	check("models: a service row says its kind in plain words, a status and the model count", /OpenAI 兼容|Claude 兼容|内置/.test(rowText) && /就绪|不可用|已停用|测试失败/.test(rowText) && /\d+ 个模型/.test(rowText), rowText.replace(/\s+/g, " ").slice(0, 120));
	check("models: the technical-details block is collapsed by default", !(await p.locator('[data-testid="provider-tech"]').first().evaluate((e) => e.open)));
	check("models: keys are never shown", !(await bodyText(p)).match(/sk-[A-Za-z0-9-]{8}/));
	await p.locator('[data-testid="provider-tech"] summary').first().click();
	check("models: 技术详情 holds the address and key source for admins", (await p.locator('[data-testid="provider-tech"]').first().innerText()).includes("127.0.0.1"));
	await p.locator('[data-testid="provider-tech"] summary').first().click();

	// ------------------------------------------------------------------ add-service wizard against a local mock (real calls)
	await p.goto(`${base}/admin?tab=models`);
	await p.waitForSelector('[data-testid="add-provider"]');
	await p.click('[data-testid="add-provider"]');
	await p.waitForSelector('[data-testid="provider-step-type"]');
	await jargonFree(p, "step 1 of the service dialog");
	check("wizard: step 1 offers OpenAI 兼容 / Claude 兼容 / 内置服务 with common presets", (await p.locator('[data-testid="provider-step-type"]').innerText()).includes("Claude 兼容") && (await p.locator('[data-testid="provider-preset"] button').count()) >= 5);
	await p.click('[data-testid="provider-next"]');
	await p.waitForSelector('[data-testid="provider-step-conn"]');
	check("wizard: 高级设置 and 技术详情 are collapsed in step 2", !(await p.locator('[data-testid="provider-advanced"]').evaluate((e) => e.open)) && !(await p.locator('[data-testid="provider-tech"]').evaluate((e) => e.open)));
	await jargonFree(p, "step 2 of the service dialog");
	await p.fill('[data-testid="provider-name"]', "向导测试服务");
	await p.fill('[data-testid="provider-baseurl"]', `${openai2.url}/v1`);
	await p.fill('[data-testid="provider-key"]', "sk-mock-openai-KEY-0123456789abcdef");
	await p.click('[data-testid="provider-save"]');
	await p.waitForSelector('[data-testid="provider-step-models"]');
	await p.waitForSelector('[data-testid="provider-test-result"]', { timeout: 20000 });
	check("wizard: step 3 shows the connection test result in plain words", (await p.locator('[data-testid="provider-check"]').innerText()).includes("能正常对话"));
	await p.waitForSelector('[data-testid="provider-model-pick"] input[type="checkbox"]');
	check("wizard: fetched models are listed, none opened by default", (await p.locator('[data-testid="provider-model-pick"] input:checked').count()) === 0 && (await p.locator('[data-testid="provider-model-pick"] li').count()) === 3);
	await jargonFree(p, "step 3 of the service dialog");
	await p.locator('[data-testid="provider-model-pick"] li', { hasText: "wizard-chat" }).locator("input").check();
	await p.click('[data-testid="provider-done"]');
	await p.waitForSelector('[data-testid="provider-dialog"]', { state: "detached" });
	const provs = (await J(await api.get(`${base}/api/admin/model-providers`))).providers;
	const wiz = provs.find((x) => x.name === "向导测试服务");
	const wizModels = (await J(await api.get(`${base}/api/admin/model-providers/${wiz.id}/models`))).models;
	check("wizard: only the chosen model is opened to members (server state)", wizModels.filter((m) => m.enabled).map((m) => m.modelId).join() === "wizard-chat", wizModels.map((m) => `${m.modelId}:${m.enabled}`).join(","));
	// deleting a service asks first; cancelling leaves it
	await p.waitForSelector('[data-testid="model-provider-row"]:has-text("向导测试服务")');
	await p.locator('[data-testid="model-provider-row"]', { hasText: "向导测试服务" }).locator('[data-testid="provider-expand"]').click();
	await p.locator('[data-testid="model-provider-row"]', { hasText: "向导测试服务" }).locator('[data-testid="provider-delete"]').click();
	check("confirm: deleting a model service names the consequence", (await p.locator('[data-testid="confirm-dialog"]').innerText()).includes("无法继续发送"));
	await p.click('[data-testid="confirm-cancel"]');
	check("confirm: cancel keeps the service", (await J(await api.get(`${base}/api/admin/model-providers`))).providers.some((x) => x.name === "向导测试服务"));
	// personal keys policy asks first
	// The switch is controlled: a click only opens the confirmation, so use click() (check() would demand an immediate state change).
	await p.locator('[data-testid="personal-providers-toggle"]').click({ force: true });
	await p.locator('[data-testid="confirm-dialog"]').waitFor({ timeout: 5000 }).catch(() => {}); // the check below fails if it never appears
	check("confirm: allowing members' own keys asks first, cancel leaves the policy off", (await confirmVisible(p)) && ((await p.click('[data-testid="confirm-cancel"]')), !(await J(await api.get(`${base}/api/model-settings`))).personalProviders) && !(await p.locator('[data-testid="personal-providers-toggle"]').isChecked()));

	// ------------------------------------------------------------------ high-risk and sensitive operations
	await p.goto(`${base}/admin?tab=members`);
	await p.waitForSelector('[data-testid="admin-member"]');
	const memberRow = (n) => p.locator('[data-testid="admin-member"]', { hasText: n });
	// disable
	await memberRow("李四").locator('[data-testid="member-more"]').click();
	await p.click('[data-testid="member-disable"]');
	await p.waitForSelector('[data-testid="confirm-dialog"]');
	const dText = await p.locator('[data-testid="confirm-dialog"]').innerText();
	check("confirm: disabling a member states the consequence and defaults the focus to 取消", dText.includes("退出所有登录设备") && (await p.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "confirm-cancel", dText.replace(/\s+/g, " ").slice(0, 120));
	await p.keyboard.press("Escape");
	await p.waitForSelector('[data-testid="confirm-dialog"]', { state: "detached" });
	check("confirm: Esc cancels and the member stays active", (await access(li)).status === "active");
	// remove
	await memberRow("李四").locator('[data-testid="member-more"]').click();
	await p.click('[data-testid="member-remove"]');
	await p.waitForSelector('[data-testid="confirm-dialog"]');
	check("confirm: removing a member lists what is lost and cancel changes nothing", (await p.locator('[data-testid="confirm-dialog"]').innerText()).includes("分享链接") && ((await p.click('[data-testid="confirm-cancel"]')), (await access(li)).status === "active" && !!(await access(li)).name));
	// ownership / admin base role change
	await memberRow("王五").locator('[data-testid="member-detail-open"]').click();
	await p.waitForSelector('[data-testid="detail-base-role"]');
	await p.selectOption('[data-testid="detail-base-role"]', "owner");
	await p.waitForSelector('[data-testid="confirm-dialog"]');
	check("confirm: making someone an owner warns about full permissions", (await p.locator('[data-testid="confirm-dialog"]').innerText()).includes("全部权限"));
	await p.click('[data-testid="confirm-cancel"]');
	await sleep(200);
	check("confirm: cancelling the ownership change keeps the base role (select and server)", (await p.locator('[data-testid="detail-base-role"]').inputValue()) === "member" && (await access(wang)).assignments.some((x) => x.roleId === "builtin:member") && !(await access(wang)).assignments.some((x) => x.roleId === "builtin:owner"));
	await p.selectOption('[data-testid="detail-base-role"]', "admin");
	await p.waitForSelector('[data-testid="confirm-dialog"]');
	await p.click('[data-testid="confirm-cancel"]');
	// direct high-risk grant
	await p.click('[data-testid="detail-grants-fold"] summary');
	await p.selectOption('[data-testid="grant-effect"]', "allow");
	await p.selectOption('[data-testid="grant-perm"]', { label: "管理模型服务与密钥（高危）" });
	await p.click('[data-testid="grant-add"]');
	await p.waitForSelector('[data-testid="confirm-dialog"]');
	const gText = await p.locator('[data-testid="confirm-dialog"]').innerText();
	check("confirm: a direct high-risk grant says it is high-risk and what it allows", gText.includes("高危") && gText.includes("新增模型服务"), gText.replace(/\s+/g, " ").slice(0, 140));
	await p.click('[data-testid="confirm-cancel"]');
	await sleep(200);
	check("confirm: cancel leaves the member without the grant (server)", (await access(wang)).grants.length === 0);
	await p.click('[data-testid="grant-add"]');
	await p.waitForSelector('[data-testid="confirm-dialog"]');
	await p.click('[data-testid="confirm-ok"]');
	await p.waitForSelector('[data-testid="detail-grants"] [data-effect="allow"]');
	check("confirm: confirming applies the grant", (await access(wang)).grants.some((g) => g.permission === "model.provider.manage" && g.effect === "allow"));
	await p.locator('[data-testid="detail-grants"] li', { hasText: "管理模型服务与密钥" }).getByRole("button", { name: "移除" }).click();
	await p.waitForSelector('[data-testid="detail-grants"]', { state: "detached" });
	// high-risk role on the member
	await p.selectOption('[data-testid="detail-role-pick"]', { label: "人员清理" });
	await p.click('[data-testid="detail-role-assign"]');
	await p.waitForSelector('[data-testid="confirm-dialog"]');
	check("confirm: a role containing a high-risk permission lists it before granting", (await p.locator('[data-testid="confirm-dialog"]').innerText()).includes("移出组织"));
	await p.click('[data-testid="confirm-cancel"]');
	await sleep(200);
	check("confirm: cancel does not assign the role (server)", !(await access(wang)).assignments.some((x) => x.roleId === risky.id));
	// effective permissions are collapsed, 为什么 works
	check("member drawer: effective permissions are collapsed until asked for", (await p.locator('[data-testid="detail-effective"] [data-testid="eff-row"]').count()) === 0);
	await p.click('[data-testid="detail-effective"] [data-testid="effective-toggle"]');
	await p.locator('[data-testid="detail-effective"] [data-perm="model.use"] [data-testid="why-btn"]').click();
	check("member drawer: 为什么 explains the source", (await p.locator('[data-testid="detail-effective"] [data-testid="why-list"]').innerText()).includes("角色"));
	await p.keyboard.press("Escape");

	// roles: list first, matrix grouped + collapsible with counts, high-risk marked, saving a high-risk role asks
	await p.goto(`${base}/admin?tab=roles`);
	await p.waitForSelector('[data-testid="role-item"]');
	const items = await p.locator('[data-testid="role-item"]').allInnerTexts();
	check("roles: the default view is the role list with a one-line purpose per role", items.length >= 10 && items.every((t) => t.split("\n").filter(Boolean).length >= 2), `${items.length} roles`);
	check("roles: the list is grouped into 基础角色 / 附加角色 / 自定义角色", ["基础角色", "附加角色", "自定义角色"].every((g) => items.length && p.locator(`h3:has-text("${g}")`).count()));
	await p.locator('[data-testid="role-item"][data-role="builtin:admin"]').click();
	await p.waitForSelector('[data-testid="perm-matrix"]');
	const grp = await p.locator('[data-testid="perm-group-member"]').innerText();
	check("roles: each permission group shows its n/m count and a 高危 marker where it applies", /\d+\/\d+/.test(grp) && (await p.locator('[data-testid="perm-matrix"]').innerText()).includes("高危"));
	const toggle = p.locator('[data-testid="perm-group-member"] button[aria-expanded]').first();
	const was = await toggle.getAttribute("aria-expanded");
	await toggle.click();
	check("roles: a group can be collapsed and expanded", (await toggle.getAttribute("aria-expanded")) !== was);
	await jargonFree(p, "a role's permission matrix");
	await p.click('[data-testid="role-back"]');
	await p.locator('[data-testid="role-item"]', { hasText: "内部审计" }).click();
	await p.waitForSelector('[data-testid="role-name"]');
	await p.click('[data-testid="matrix-toggle-all"]');
	await p.click('[data-testid="perm-member.remove"]');
	await p.click('[data-testid="role-save"]');
	await p.waitForSelector('[data-testid="confirm-dialog"]');
	check("confirm: saving a role that gains a high-risk permission asks and names it", (await p.locator('[data-testid="confirm-dialog"]').innerText()).includes("移出组织"));
	await p.click('[data-testid="confirm-cancel"]');
	await sleep(200);
	check("confirm: cancel keeps the saved role unchanged (server)", !(await J(await api.get(`${base}/api/admin/roles`))).roles.find((r) => r.id === audit.id).permissions.includes("member.remove"));

	// authz: assigning a high-risk role asks
	await p.goto(`${base}/admin?tab=authz`);
	await p.waitForSelector('[data-testid="authz-form"]');
	await p.selectOption('[data-testid="authz-subject"]', { label: "钱八（钱八@ui3.example）" });
	await p.selectOption('[data-testid="authz-role"]', { label: "人员清理（自定义）" });
	await p.click('[data-testid="authz-assign"]');
	await p.waitForSelector('[data-testid="confirm-dialog"]');
	await p.click('[data-testid="confirm-cancel"]');
	await sleep(200);
	check("confirm: 授权 with a high-risk role asks first; cancel assigns nothing", !(await access(qian)).assignments.some((x) => x.roleId === risky.id));

	// org structure
	await p.goto(`${base}/admin?tab=departments`);
	await p.waitForSelector('[data-testid="admin-departments"]');
	await p.locator(`[data-testid="dept-node"][data-dept="${sales.id}"] [data-testid="dept-select"]`).click();
	await p.waitForSelector('[data-testid="dept-detail"]');
	await p.selectOption('[data-testid="dept-admin-pick"]', { label: "李四" });
	await p.click('[data-testid="dept-admin-add"]');
	await p.waitForSelector('[data-testid="confirm-dialog"]');
	await p.click('[data-testid="confirm-cancel"]');
	await sleep(200);
	check("confirm: naming a department admin asks first; cancel changes nothing", !(await access(li)).assignments.some((x) => x.roleId === "builtin:dept_admin"));
	await p.locator('[data-testid="dept-delete"]').click();
	await p.waitForSelector('[data-testid="confirm-dialog"]');
	check("confirm: deleting a department says sub-departments move up and grants go away", (await p.locator('[data-testid="confirm-dialog"]').innerText()).includes("上移一级"));
	await p.click('[data-testid="confirm-cancel"]');
	check("confirm: cancel keeps the department", (await J(await api.get(`${base}/api/departments`))).departments.some((d) => d.id === sales.id));

	// ------------------------------------------------------------------ review: verdict first, consequence stated, no self-review
	const rp = await reviewer.ctx.newPage();
	await rp.goto(`${base}/capabilities?tab=review`);
	await rp.waitForSelector('[data-testid="review-item"]');
	await rp.click('[data-testid="review-item"]');
	await rp.waitForSelector('[data-testid="review-screen"] [data-testid="manifest"]');
	await jargonFree(rp, "the review screen");
	const sectionOrder = await rp.locator('[data-testid="review-screen"] h3').allInnerTexts();
	check("review: the automated-check verdict comes before the content diff", sectionOrder.indexOf("自动检查") >= 0 && sectionOrder.indexOf("自动检查") < sectionOrder.indexOf("内容变化"), sectionOrder.join(" > "));
	const man = await rp.locator('[data-testid="manifest"]').innerText();
	check("review: permissions are in plain words (需要的权限：运行代码、写入文件)", man.includes("需要的权限") && man.includes("运行代码") && man.includes("写入文件") && man.includes("新增"), man.replace(/\s+/g, " ").slice(0, 120));
	check("review: each decision states its consequence next to the button", (await rp.locator('[data-testid="decision-bar"]').innerText()).includes("不发布；提交人需要上传新版本"));
	check("review: reject / request changes stay disabled without a comment", !(await rp.locator('[data-testid="reject"]').isEnabled()) && !(await rp.locator('[data-testid="request-changes"]').isEnabled()));
	await rp.fill('[data-testid="decision-comment"]', "脚本需要先说明用途");
	await rp.click('[data-testid="reject"]');
	await rp.waitForSelector('[data-testid="confirm-dialog"]');
	check("confirm: rejecting states that it will not be published", (await rp.locator('[data-testid="confirm-dialog"]').innerText()).includes("不会发布"));
	await rp.click('[data-testid="confirm-cancel"]');
	await sleep(200);
	const pending = (await J(await reviewer.api.get(`${base}/api/market/submissions?view=queue`))).submissions;
	check("confirm: cancel leaves the submission pending (server)", pending.length === 1 && pending[0].state === "pending_review");
	await rp.click('[data-testid="approve"]');
	await rp.waitForSelector('[data-testid="confirm-dialog"]');
	const aText = await rp.locator('[data-testid="confirm-dialog"]').innerText();
	check("confirm: approving names the target scope and the new permissions", aText.includes("组织") && aText.includes("运行代码"), aText.replace(/\s+/g, " ").slice(0, 140));
	await rp.click('[data-testid="confirm-cancel"]');
	// the submitter cannot decide their own
	await p.goto(`${base}/capabilities?tab=review`);
	await p.waitForSelector('[data-testid="review-item"]');
	await p.click('[data-testid="review-item"]');
	await p.waitForSelector('[data-testid="self-review-note"]');
	check("review: the submitter sees why they cannot review their own work, and approve stays disabled", (await p.locator('[data-testid="self-review-note"]').innerText()).includes("不能自己审核") && !(await p.locator('[data-testid="approve"]').isEnabled()));
	// market + 能力 wording
	const mp = await member.ctx.newPage();
	await mp.goto(`${base}/capabilities?tab=market`);
	await mp.waitForSelector('[data-testid="market-skill"]');
	await jargonFree(mp, "the skill market");
	check("market: no paragraph subtitle under the title", (await mp.locator("h1 ~ p").count()) === 0);
	await mp.goto(`${base}/capabilities?tab=mcp`);
	await mp.waitForSelector('[data-testid="mcp-market"]');
	check("market: the connection tab is called 连接市场, not MCP", (await mp.locator('[data-testid="tab-mcp"]').innerText()).includes("连接市场"));
	await jargonFree(mp, "the connection market");

	// settings + my permissions
	await p.goto(`${base}/settings`);
	await p.waitForSelector('[data-testid="my-permissions"]');
	await jargonFree(p, "settings");
	check("settings: 我的权限 keeps the full list collapsed", (await p.locator('[data-testid="my-effective"] [data-testid="eff-row"]').count()) === 0);

	// ------------------------------------------------------------------ dark mode: contrast + opaque overlays
	const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN", colorScheme: "dark", storageState: await octx.storageState() });
	const dp = await dctx.newPage();
	const contrast = () =>
		dp.evaluate(() => {
			const cv = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
			const rgba = (c) => {
				cv.clearRect(0, 0, 1, 1);
				cv.fillStyle = "#000";
				cv.fillStyle = c;
				cv.fillRect(0, 0, 1, 1);
				const d = cv.getImageData(0, 0, 1, 1).data;
				return [d[0], d[1], d[2]];
			};
			const alphaOf = (c) => {
				const m = c.match(/\/\s*([\d.]+)\s*\)|rgba?\([^)]*,\s*([\d.]+)\)/);
				return m ? Number(m[1] ?? m[2]) : c === "transparent" ? 0 : 1;
			};
			const lin = (v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
			const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
			const bgOf = (el) => {
				let n = el;
				while (n) {
					const c = getComputedStyle(n).backgroundColor;
					if (alphaOf(c) >= 0.99) return rgba(c);
					n = n.parentElement;
				}
				return rgba(getComputedStyle(document.body).backgroundColor);
			};
			const out = [];
			const els = [...document.querySelectorAll("main *, nav *, h1, h2, [role=dialog] *")].filter((e) => e.children.length === 0 && (e.textContent ?? "").trim().length > 1 && e.offsetParent !== null && !e.closest("[disabled]") && !e.closest("button:disabled"));
			for (const e of els.slice(0, 400)) {
				const fg = rgba(getComputedStyle(e).color);
				const bg = bgOf(e);
				const a = lum(fg), b = lum(bg);
				const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
				out.push({ ratio, text: e.textContent.trim().slice(0, 24) });
			}
			return { dark: lum(bgOf(document.body)) < 0.2, min: out.length ? Math.min(...out.map((x) => x.ratio)) : 0, low: out.filter((x) => x.ratio < 4.5).slice(0, 5), n: out.length };
		});
	for (const [tab, wait] of [["members", '[data-testid="admin-member"]'], ["roles", '[data-testid="role-item"]'], ["models", '[data-testid="model-provider-row"]'], ["authz", '[data-testid="authz-form"]']]) {
		await dp.goto(`${base}/admin?tab=${tab}`);
		await dp.waitForSelector(wait);
		const c = await contrast();
		check(`dark mode: ${tab} page is dark and its text keeps >= 4.5:1 contrast`, c.dark && c.low.length === 0, `${c.n} texts, min ${c.min.toFixed(2)} ${c.low.map((x) => `「${x.text}」${x.ratio.toFixed(2)}`).join(" ")}`);
	}
	await dp.goto(`${base}/admin?tab=members`);
	await dp.waitForSelector('[data-testid="admin-member"]');
	await dp.locator('[data-testid="admin-member"]', { hasText: "成员丙" }).locator('[data-testid="member-more"]').click();
	await dp.click('[data-testid="member-disable"]');
	await dp.waitForSelector('[data-testid="confirm-dialog"]');
	await sleep(250);
	const alpha = await dp.evaluate(() => {
		const el = document.querySelector('[data-testid="confirm-dialog"]');
		const cs = getComputedStyle(el);
		const m = cs.backgroundColor.match(/\/\s*([\d.]+)\s*\)|rgba\([^)]*,\s*([\d.]+)\)/);
		return { bg: cs.backgroundColor, a: m ? Number(m[1] ?? m[2]) : 1, o: Number(cs.opacity) };
	});
	check("dark mode: the confirmation dialog is fully opaque", alpha.a === 1 && alpha.o === 1, JSON.stringify(alpha));
	const dc = await contrast();
	check("dark mode: the dialog text keeps >= 4.5:1 contrast", dc.low.length === 0, `min ${dc.min.toFixed(2)} ${dc.low.map((x) => `「${x.text}」${x.ratio.toFixed(2)}`).join(" ")}`);
	await dp.screenshot({ path: join(OUT, "g3-confirm-dark-1440.png") });
	await dp.keyboard.press("Escape");
	await dp.goto(`${base}/admin?tab=roles`);
	await dp.waitForSelector('[data-testid="role-item"]');
	await dp.screenshot({ path: join(OUT, "g3-admin-roles-dark-1440.png") });
	await dp.goto(`${base}/admin?tab=models`);
	await dp.waitForSelector('[data-testid="add-provider"]');
	await dp.click('[data-testid="add-provider"]');
	await dp.waitForSelector('[data-testid="provider-dialog"]');
	await sleep(250);
	const dlg = await dp.evaluate(() => getComputedStyle(document.querySelector('[data-testid="provider-dialog"]')).backgroundColor);
	check("dark mode: the service dialog is opaque", !/\/\s*0?\.\d+\s*\)|rgba\([^)]*,\s*0?\.\d+\)/.test(dlg), dlg);
	await dp.screenshot({ path: join(OUT, "g3-provider-dialog-dark-1440.png") });

	// ------------------------------------------------------------------ 390: no horizontal scroll anywhere
	const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "zh-CN", storageState: await octx.storageState() });
	const m390 = await mctx.newPage();
	for (const [tab, wait] of [["members", '[data-testid="admin-member"]'], ["invites", '[data-testid="invite-create"]'], ["departments", '[data-testid="admin-departments"]'], ["sessions", '[data-testid="admin-sessions"]'], ["roles", '[data-testid="role-item"]'], ["authz", '[data-testid="authz-form"]'], ["models", '[data-testid="model-provider-row"]'], ["budgets", '[data-testid="budget-create"]'], ["audit", '[data-testid="admin-audit"]'], ["trace", '[data-testid="trace-q"]']]) {
		await m390.goto(`${base}/admin?tab=${tab}`);
		await m390.waitForSelector(wait);
		check(`390: ${tab} has no horizontal scroll`, await noOverflow(m390), await m390.evaluate(() => `${document.documentElement.scrollWidth}/${innerWidth}`));
	}
	await m390.goto(`${base}/admin?tab=roles`);
	await m390.click('[data-testid="role-item"][data-role="builtin:admin"]');
	await m390.waitForSelector('[data-testid="perm-matrix"]');
	await m390.click('[data-testid="matrix-toggle-all"]');
	check("390: an opened role with every permission group expanded fits", await noOverflow(m390));
	await m390.goto(`${base}/admin?tab=members`);
	await m390.locator('[data-testid="admin-member"]', { hasText: "赵六" }).locator('[data-testid="member-detail-open"]').click();
	await m390.waitForSelector('[data-testid="detail-effective"]');
	await m390.click('[data-testid="detail-effective"] [data-testid="effective-toggle"]');
	check("390: the member drawer with the permission list open fits", await noOverflow(m390));
	await m390.keyboard.press("Escape");
	await m390.goto(`${base}/admin?tab=models`);
	await m390.click('[data-testid="provider-expand"]');
	await m390.waitForSelector('[data-testid="model-row"]');
	check("390: an opened model service fits", await noOverflow(m390));
	await m390.click('[data-testid="add-provider"]');
	await m390.waitForSelector('[data-testid="provider-step-type"]');
	check("390: the service dialog (step 1) fits", await noOverflow(m390));
	await m390.click('[data-testid="provider-next"]');
	await m390.locator('[data-testid="provider-advanced"] summary').click();
	check("390: the service dialog (step 2, advanced open) fits", await noOverflow(m390));
	await m390.keyboard.press("Escape");
	for (const url of ["/settings", "/capabilities?tab=market", "/capabilities?tab=mine", "/capabilities?tab=connectors"]) {
		await m390.goto(`${base}${url}`);
		await sleep(500);
		check(`390: ${url} has no horizontal scroll`, await noOverflow(m390));
	}
	const r390 = await reviewer.ctx.newPage();
	await r390.setViewportSize({ width: 390, height: 844 });
	await r390.goto(`${base}/capabilities?tab=review`);
	await r390.waitForSelector('[data-testid="review-item"]');
	await r390.click('[data-testid="review-item"]');
	await r390.waitForSelector('[data-testid="review-screen"] [data-testid="manifest"]');
	check("390: the review screen fits", await noOverflow(r390));

	// ------------------------------------------------------------------ screenshots (1440 / 1366 / 390)
	const sizes = [[1440, 900], [1366, 768], [390, 844]];
	const shots = async (page, name, prep) => {
		for (const [w, h] of sizes) {
			await page.setViewportSize({ width: w, height: h });
			await sleep(250);
			if (prep) await prep();
			await sleep(150);
			await page.screenshot({ path: join(OUT, `g3-${name}-${w}.png`) });
		}
	};
	await p.setViewportSize({ width: 1440, height: 900 });
	await p.goto(`${base}/admin?tab=members`);
	await p.waitForSelector('[data-testid="admin-member"]');
	await shots(p, "admin-members");
	await p.goto(`${base}/admin?tab=departments`);
	await p.waitForSelector('[data-testid="admin-departments"]');
	await p.locator(`[data-testid="dept-node"][data-dept="${sales.id}"] [data-testid="dept-select"]`).click();
	await p.waitForSelector('[data-testid="dept-detail"]');
	await shots(p, "admin-org-structure");
	await p.goto(`${base}/admin?tab=roles`);
	await p.waitForSelector('[data-testid="role-item"]');
	await shots(p, "admin-roles");
	await p.locator('[data-testid="role-item"][data-role="builtin:auditor"]').click();
	await p.waitForSelector('[data-testid="perm-matrix"]');
	await shots(p, "admin-role-matrix");
	await p.goto(`${base}/admin?tab=authz`);
	await p.waitForSelector('[data-testid="authz-form"]');
	await shots(p, "admin-authz");
	await p.goto(`${base}/admin?tab=members`);
	await p.waitForSelector('[data-testid="admin-member"]');
	await p.locator('[data-testid="admin-member"]', { hasText: "赵六" }).locator('[data-testid="member-detail-open"]').click();
	await p.waitForSelector('[data-testid="detail-effective"]');
	await shots(p, "member-detail");
	await p.click('[data-testid="detail-effective"] [data-testid="effective-toggle"]');
	await shots(p, "member-detail-effective");
	await p.keyboard.press("Escape");
	await p.goto(`${base}/admin?tab=models`);
	await p.waitForSelector('[data-testid="model-provider-row"]');
	await shots(p, "models-providers");
	await p.locator('[data-testid="provider-expand"]').first().click();
	await p.waitForSelector('[data-testid="provider-models"]');
	await shots(p, "models-table", async () => p.locator('[data-testid="provider-models"]').first().scrollIntoViewIfNeeded());
	await p.goto(`${base}/admin?tab=models`);
	await p.waitForSelector('[data-testid="add-provider"]');
	await p.click('[data-testid="add-provider"]');
	await sleep(300);
	await shots(p, "provider-dialog");
	await p.click('[data-testid="provider-next"]');
	await p.waitForSelector('[data-testid="provider-step-conn"]');
	await shots(p, "provider-dialog-step2");
	await p.keyboard.press("Escape");
	await p.goto(`${base}/settings`);
	await p.waitForSelector('[data-testid="my-permissions"]');
	await shots(p, "settings");
	await shots(p, "my-permissions", async () => p.locator('[data-testid="my-permissions"]').scrollIntoViewIfNeeded());
	await mp.goto(`${base}/capabilities?tab=market`);
	await mp.waitForSelector('[data-testid="market-skill"]');
	await shots(mp, "capabilities-market");
	await rp.goto(`${base}/capabilities?tab=review`);
	await rp.waitForSelector('[data-testid="review-item"]');
	await rp.click('[data-testid="review-item"]');
	await rp.waitForSelector('[data-testid="review-screen"] [data-testid="manifest"]');
	await shots(rp, "review");
	ok = true;
} catch (e) {
	console.error(e);
	check("round5-g3 completed without an exception", false, String(e?.message ?? e).split("\n")[0]);
} finally {
	await browser.close();
	await server.stop();
	await openai.close();
	await openai2.close();
	await anth.close();
}
const pass = summary(join(ROOT, "artifacts/screenshots/round5-g3-results.json"));
process.exitCode = pass && ok ? 0 : 1;
