// Round 4 · RBAC: 组织架构 (department tree, drag/move, members, heads, department admins), 角色与权限 (built-in read-only,
// custom create/clone, grouped matrix), 授权 (assign with scope), 成员详情 (roles, direct deny, effective permissions + 为什么),
// tab gating per viewer, 我的权限 in Settings, audit of every change; screenshots at 1366 / 1440 / 390.
// Run: npm run -w web build && node web/e2e/round4-rbac.mjs        (port 8865, data/dev-rbac; RBAC_WEB_DIST overrides the built web dir)
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { check, chromium, ROOT, shot, sleep, summary, pick } from "./lib.mjs";

const PORT = 8865;
const base = `http://127.0.0.1:${PORT}`;
const dataDir = join(ROOT, "data/dev-rbac");
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/src/main.ts"], {
	cwd: ROOT,
	env: { ...process.env, WORKROOM_ONBOARDING: "off", WORKROOM_DATA_DIR: dataDir, PORT: String(PORT), WORKROOM_WEB_DIST: process.env.RBAC_WEB_DIST ?? join(ROOT, "web/dist"), WORKROOM_FIXTURE_TOOLS: "1" },
	stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", (d) => (serverLog += d));
child.stderr.on("data", (d) => (serverLog += d));
for (let i = 0; i < 120; i++) {
	try {
		if ((await fetch(`${base}/api/health`)).ok) break;
	} catch {
		/* not yet */
	}
	if (child.exitCode !== null) throw new Error(`server exited:\n${serverLog}`);
	await sleep(150);
}
const browser = await chromium.launch();
let ok = false;
try {
	// ------------------------------------------------------------------ seed: owner (UI registration) + members (API)
	const octx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "zh-CN" });
	const owner = await octx.newPage();
	await owner.goto(`${base}/register`);
	await owner.fill("#name", "所有者甲");
	await owner.fill("#email", "owner@rbac.example");
	await owner.fill("#password", "password123");
	await owner.click('button[type="submit"]');
	await owner.waitForSelector('[data-testid="home-greeting"]');
	owner.on("dialog", (d) => d.accept());
	const oapi = octx.request;
	const jget = async (r) => (await r.json());
	const newUser = async (name, { role = "member", viewport = { width: 1440, height: 900 } } = {}) => {
		const inv = (await jget(await oapi.post(`${base}/api/admin/invites`, { data: { role, ttlHours: 24 } }))).invite.code;
		const ctx = await browser.newContext({ viewport, locale: "zh-CN" });
		const r = await ctx.request.post(`${base}/api/auth/register`, { data: { email: `${name}@rbac.example`, name, password: "password123", inviteCode: inv } });
		const j = await jget(r);
		return { ctx, me: j.me, token: j.token, api: ctx.request };
	};
	const zhang = await newUser("张三");
	const li = await newUser("李四");
	const wang = await newUser("王五");
	const zhao = await newUser("赵六");
	const qian = await newUser("钱八");
	const sun = await newUser("孙七", { role: "guest" });
	check("seed: six members joined the owner's organisation", [zhang, li, wang, zhao, qian, sun].every((u) => u.me.orgId === zhang.me.orgId));
	check("seed: guest invite → read-only base role", sun.me.baseRole === "builtin:guest" && sun.me.orgRole === "member");

	// ------------------------------------------------------------------ owner: tabs
	await owner.goto(`${base}/admin`);
	await owner.waitForSelector('[data-testid="admin-tabs"]');
	const ownerTabs = await owner.locator('[data-testid^="admin-tab-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid").replace("admin-tab-", "")));
	check("owner sees every admin tab (14: round 7 added 运行环境 + 环境变量; 网络访问策略 added 网络访问)", ownerTabs.length === 14 && ["departments", "roles", "authz", "network", "members", "audit", "sandbox", "env"].every((t) => ownerTabs.includes(t)), ownerTabs.join(","));

	// ------------------------------------------------------------------ 组织架构
	await owner.goto(`${base}/admin?tab=departments`);
	await owner.waitForSelector('[data-testid="org-structure"]');
	const createDept = async (name, parentLabel) => {
		await owner.fill('input[placeholder="新部门名称"]', name);
		if (parentLabel) await pick(owner.locator('[data-wr-select][aria-label="上级部门"]'), { label: `上级：${parentLabel}` });
		await owner.click('[data-testid="dept-create"]');
		await owner.waitForFunction((n) => [...document.querySelectorAll('[data-testid="dept-node"]')].some((e) => e.textContent.includes(n)), name, { timeout: 10000 });
	};
	await createDept("销售部");
	await createDept("研发部");
	await createDept("华东", "销售部");
	await createDept("华西", "销售部");
	const treeText = await owner.locator('[data-testid="admin-departments"]').innerText();
	check("org structure: tree shows 销售部 / 研发部 and sub-departments", ["销售部", "研发部", "华东", "华西"].every((n) => treeText.includes(n)));
	const deps = (await jget(await oapi.get(`${base}/api/departments`))).departments;
	const D = Object.fromEntries(deps.map((d) => [d.name, d.id]));
	check("org structure: 华东 is a child of 销售部", deps.find((d) => d.name === "华东").parentId === D["销售部"]);
	// drag 华东 onto 研发部
	await owner.locator(`[data-testid="dept-node"][data-dept="${D["华东"]}"]`).dragTo(owner.locator(`[data-testid="dept-node"][data-dept="${D["研发部"]}"]`));
	await owner.waitForFunction(async ([base, id, to]) => (await (await fetch(`${base}/api/departments`)).json()).departments.find((d) => d.id === id)?.parentId === to, [base, D["华东"], D["研发部"]], { timeout: 8000 }).catch(() => {});
	const afterDrag = (await jget(await oapi.get(`${base}/api/departments`))).departments.find((d) => d.name === "华东").parentId;
	check("org structure: drag 华东 onto 研发部 moves it (server state)", afterDrag === D["研发部"], `parent=${afterDrag}`);
	// move back with the menu
	await owner.locator(`[data-testid="dept-node"][data-dept="${D["华东"]}"] [data-testid="dept-select"]`).click();
	await owner.waitForSelector('[data-testid="dept-detail"]');
	await pick(owner.locator('[data-testid="dept-move-to"]'), { label: "销售部" });
	await owner.click('[data-testid="dept-move"]');
	await owner.waitForFunction(async ([base, id, to]) => (await (await fetch(`${base}/api/departments`)).json()).departments.find((d) => d.id === id)?.parentId === to, [base, D["华东"], D["销售部"]], { timeout: 8000 });
	check("org structure: 移动到 menu moves it back under 销售部", true);
	// members + head + department admin
	await pick(owner.locator('[data-testid="dept-member-pick"]'), { label: "李四" });
	await owner.click('[data-testid="dept-member-add"]');
	await owner.waitForFunction(() => document.querySelector('[data-testid="dept-members"]')?.textContent.includes("李四"));
	await pick(owner.locator('[data-testid="dept-members"] [data-wr-select]').first(), "manager");
	await owner.waitForFunction(() => document.querySelector('[data-testid="dept-members"] [data-wr-select]')?.getAttribute("data-value") === "manager");
	check("org structure: member added to 华东 and made its head (负责人)", true);
	await owner.locator(`[data-testid="dept-node"][data-dept="${D["销售部"]}"] [data-testid="dept-select"]`).click();
	await pick(owner.locator('[data-testid="dept-admin-pick"]'), { label: "张三" });
	await owner.click('[data-testid="dept-admin-add"]');
	await owner.click('[data-testid="confirm-ok"]');
	await owner.waitForFunction(() => document.querySelector('[data-testid="dept-admins"]')?.textContent.includes("张三"));
	check("org structure: 张三 is 销售部's department admin", true);
	await pick(owner.locator('[data-testid="dept-member-pick"]'), { label: "张三" });
	await owner.click('[data-testid="dept-member-add"]');
	await owner.waitForFunction(() => document.querySelector('[data-testid="dept-members"]')?.textContent.includes("张三"));
	// 王五 in 研发部 (outside 张三's subtree)
	await oapi.put(`${base}/api/admin/departments/${D["研发部"]}/members`, { data: { userId: wang.me.userId, role: "member" } });
	await oapi.put(`${base}/api/admin/departments/${D["华西"]}/members`, { data: { userId: zhao.me.userId, role: "member" } });
	await owner.waitForTimeout(200);
	await shot(owner, "1440-rbac-org-structure");

	// ------------------------------------------------------------------ 角色与权限
	await owner.goto(`${base}/admin?tab=roles`);
	await owner.waitForSelector('[data-testid="roles-tab"]');
	const roleNames = await owner.locator('[data-testid="role-item"]').allInnerTexts();
	check("roles: eight built-in roles listed", ["组织所有者", "组织管理员", "安全审计员", "计费管理员", "部门管理员", "审查员", "普通成员", "访客"].every((n) => roleNames.some((t) => t.includes(n))), roleNames.length + " items");
	await owner.locator('[data-testid="role-item"][data-role="builtin:auditor"]').click();
	await owner.waitForSelector('[data-testid="role-editor"][data-role="builtin:auditor"]');
	const disabled = await owner.locator('[data-testid="perm-matrix"] input[type="checkbox"]').evaluateAll((els) => els.filter((e) => !e.disabled).length);
	check("roles: built-in role is read-only (every checkbox disabled, no save)", disabled === 0 && (await owner.locator('[data-testid="role-save"]').count()) === 0);
	check("roles: permission matrix has grouped checkboxes with descriptions", (await owner.locator('[data-testid^="perm-group-"]').count()) >= 15 && (await owner.locator('[data-testid="perm-audit.view"]').isChecked()));
	await shot(owner, "1440-rbac-roles-builtin");
	// create custom role via UI
	await owner.click('[data-testid="role-back"]');
	await owner.click('[data-testid="role-new"]');
	await owner.fill('[data-testid="role-name"]', "内部审计");
	await owner.click('[data-testid="matrix-toggle-all"]');
	await owner.click('[data-testid="perm-audit.view"]');
	await owner.click('[data-testid="perm-stats.org.view"]');
	await owner.click('[data-testid="role-save"]');
	await owner.waitForSelector('[data-testid="role-editor"]:not([data-role="new"])');
	await owner.click('[data-testid="role-back"]');
	await owner.waitForSelector('[data-testid="role-item"]:has-text("内部审计")');
	check("roles: custom role created from the matrix", true);
	// clone built-in role
	await owner.locator('[data-testid="role-item"][data-role="builtin:billing"]').click();
	await owner.click('[data-testid="role-clone"]');
	await owner.waitForFunction(() => document.querySelector('[data-testid="role-name"]')?.value === "计费管理员 副本");
	check("roles: clone of a built-in role is an editable custom role", (await owner.locator('[data-testid="role-save"]').count()) === 1);
	await shot(owner, "1440-rbac-roles-custom");
	await owner.click('[data-testid="role-delete"]');
	await owner.click('[data-testid="confirm-ok"]');
	await owner.waitForSelector('[data-testid="role-item"]:has-text("计费管理员 副本")', { state: "detached" });
	check("roles: deleting a custom role removes it", true);
	// ------------------------------------------------------------------ 授权
	await owner.goto(`${base}/admin?tab=authz`);
	await owner.waitForSelector('[data-testid="authz-form"]');
	await pick(owner.locator('[data-testid="authz-subject"]'), { label: "赵六（赵六@rbac.example）" });
	await pick(owner.locator('[data-testid="authz-role"]'), { label: "内部审计（自定义）" });
	await owner.click('[data-testid="authz-assign"]');
	await owner.waitForSelector('[data-testid="authz-row"]:has-text("赵六")');
	check("authz: custom role assigned org-wide to 赵六", true);
	// department-scoped assignment: 审查员 limited to 华西
	await pick(owner.locator('[data-testid="authz-subject"]'), { label: "王五（王五@rbac.example）" });
	await pick(owner.locator('[data-testid="authz-scope"] [data-wr-select][aria-label="范围"]'), "department");
	await pick(owner.locator('[data-testid="authz-scope"] [data-wr-select][aria-label="部门"]'), D["华西"]);
	await pick(owner.locator('[data-testid="authz-role"]'), { label: "审查员" });
	await owner.click('[data-testid="authz-assign"]');
	await owner.waitForSelector('[data-testid="authz-row"]:has-text("王五")');
	const rowText = await owner.locator('[data-testid="authz-row"]:has-text("王五")').innerText();
	check("authz: department-scoped assignment shows its scope", rowText.includes("华西") && rowText.includes("审查员"), rowText.replace(/\s+/g, " "));
	// user group (optional): create, add 李四, grant 计费管理员 to the group
	await owner.click('[data-testid="groups-panel"] summary');
	await owner.fill('input[aria-label="新用户组名称"]', "报表组");
	await owner.click('[data-testid="group-create"]');
	await owner.waitForSelector('[data-testid="group-list"]:has-text("报表组")');
	await owner.locator('[data-testid="group-list"] li button', { hasText: "报表组" }).click();
	await pick(owner.locator('[data-testid="group-list"] [data-wr-select][aria-label="添加成员"]'), { label: "李四" });
	await owner.locator('[data-testid="group-list"] button', { hasText: "添加" }).click();
	await owner.waitForSelector('[data-testid="group-list"] :text("李四")');
	await pick(owner.locator('[data-wr-select][aria-label="主体类型"]'), "group");
	await pick(owner.locator('[data-testid="authz-scope"] [data-wr-select][aria-label="范围"]'), "org");
	await pick(owner.locator('[data-testid="authz-role"]'), { label: "计费管理员" });
	await owner.click('[data-testid="authz-assign"]');
	await owner.waitForSelector('[data-testid="authz-row"]:has-text("报表组")');
	const liBudget = await li.api.post(`${base}/api/admin/budgets`, { data: { scope: { kind: "org", id: "" }, period: "month", limitCost: 50, action: "warn" } });
	check("authz: a role granted to a user group reaches its member (李四 can manage budgets)", liBudget.ok(), `status=${liBudget.status()}`);
	await shot(owner, "1440-rbac-authz");
	// the server really applies it
	const zApi = await zhao.api.get(`${base}/api/admin/audit`);
	check("authz: 赵六 can now read the audit log (server)", zApi.ok());
	const wRev = await wang.api.get(`${base}/api/admin/audit`);
	check("authz: 王五's department-scoped reviewer role gives no org-level audit access", wRev.status() === 403);

	// ------------------------------------------------------------------ 成员详情: effective view, 为什么, direct deny
	await owner.goto(`${base}/admin?tab=members`);
	await owner.waitForSelector('[data-testid="admin-member"]');
	check("members: base role + extra role chips visible", (await owner.locator('[data-testid="admin-member"]', { hasText: "赵六" }).innerText()).includes("内部审计"));
	await owner.locator('[data-testid="admin-member"]', { hasText: "赵六" }).locator('[data-testid="member-detail-open"]').click();
	await owner.waitForSelector('[data-testid="member-detail"] [data-testid="detail-effective"]');
	await owner.click('[data-testid="detail-effective"] [data-testid="effective-toggle"]');
	await owner.waitForSelector('[data-testid="detail-effective"] [data-perm="audit.view"][data-allow="1"]');
	check("member detail: effective permissions list the role's grants", true);
	await owner.locator('[data-testid="detail-effective"] [data-perm="audit.view"] [data-testid="why-btn"]').click();
	const why = await owner.locator('[data-testid="detail-effective"] [data-perm="audit.view"] [data-testid="why-list"]').innerText();
	check("member detail: 为什么 names the role and scope", why.includes("内部审计") && why.includes("整个组织"), why.replace(/\s+/g, " "));
	await shot(owner, "1440-rbac-member-detail");
	// add a direct deny
	await owner.click('[data-testid="detail-grants-fold"] summary');
	await pick(owner.locator('[data-testid="grant-effect"]'), "deny");
	await pick(owner.locator('[data-testid="grant-perm"]'), { label: "查看审计日志" });
	await owner.fill('input[aria-label="原因"]', "离岗审查");
	await owner.click('[data-testid="grant-add"]');
	await owner.waitForSelector('[data-testid="detail-grants"] [data-effect="deny"]');
	await owner.waitForSelector('[data-testid="detail-effective"] [data-perm="audit.view"]', { state: "detached", timeout: 3000 }).catch(() => {});
	await owner.locator('[data-testid="detail-effective"] [role="switch"]').uncheck();
	if ((await owner.locator('[data-testid="detail-effective"] [data-perm="audit.view"] [data-testid="why-list"]').count()) === 0) await owner.locator('[data-testid="detail-effective"] [data-perm="audit.view"] [data-testid="why-btn"]').click();
	const why2 = await owner.locator('[data-testid="detail-effective"] [data-perm="audit.view"]').innerText();
	check("member detail: direct deny wins and the reason is explained", (await owner.locator('[data-testid="detail-effective"] [data-perm="audit.view"]').getAttribute("data-allow")) === "0" && why2.includes("直接禁止") && why2.includes("离岗审查"), why2.replace(/\s+/g, " ").slice(0, 160));
	const z2 = await zhao.api.get(`${base}/api/admin/audit`);
	check("member detail: deny enforced by the server on the very next request", z2.status() === 403);
	await owner.click('[data-testid="member-detail-close"]');

	// ------------------------------------------------------------------ audit shows every change
	await owner.goto(`${base}/admin?tab=audit`);
	await owner.waitForSelector('[data-testid="admin-audit"]');
	await pick(owner.locator('[data-wr-select][aria-label="类别"]'), "grant");
	await owner.waitForFunction(() => ["授予角色", "单独禁止权限", "调整部门成员"].every((a) => document.querySelector('[data-testid="admin-audit"]')?.textContent.includes(a)), null, { timeout: 8000 });
	await owner.check('[data-testid="audit-tech"]');
	check("audit: technical ids appear only after 显示技术详情", (await owner.locator('[data-testid="audit-tech-line"]').first().innerText()).includes("grant."));
	const auditAll = await (await oapi.get(`${base}/api/admin/audit?limit=500`)).json();
	const acts = new Set(auditAll.items.map((a) => a.action));
	check("audit: role/department/grant changes are recorded and visible in the audit tab", ["role.create", "role.clone", "grant.role_assign", "grant.user_deny", "department.create", "department.move", "department.member.set"].every((a) => acts.has(a)), [...acts].filter((a) => /role|grant|department/.test(a)).join(","));

	// ------------------------------------------------------------------ department admin (张三): scoped UI + server limits
	const zp = await zhang.ctx.newPage();
	await zp.goto(`${base}/admin`);
	await zp.waitForSelector('[data-testid="admin-tabs"]');
	const zTabs = await zp.locator('[data-testid^="admin-tab-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid").replace("admin-tab-", "")));
	check("dept admin: only permitted tabs are shown (no audit / trace / models / budgets / sessions)", ["members", "departments"].every((t) => zTabs.includes(t)) && !["audit", "trace", "models", "budgets", "sessions"].some((t) => zTabs.includes(t)), zTabs.join(","));
	await zp.goto(`${base}/admin?tab=members`);
	await zp.waitForSelector('[data-testid="admin-member"]');
	const zMembers = await zp.locator('[data-testid="admin-member"]').allInnerTexts();
	check("dept admin: member list is limited to the subtree (李四 yes, 王五 no)", zMembers.some((t) => t.includes("李四")) && !zMembers.some((t) => t.includes("王五")), zMembers.map((t) => t.split("\n")[0]).join(","));
	await zp.goto(`${base}/admin?tab=departments`);
	await zp.waitForSelector('[data-testid="org-structure"]');
	const zNodeDrag = await zp.locator(`[data-testid="dept-node"][data-dept="${D["研发部"]}"]`).getAttribute("draggable");
	check("dept admin: departments outside the subtree are not draggable / manageable", zNodeDrag === "false");
	await zp.locator(`[data-testid="dept-node"][data-dept="${D["华东"]}"] [data-testid="dept-select"]`).click();
	await zp.waitForSelector('[data-testid="dept-detail"]');
	check("dept admin: can manage members inside the subtree", (await zp.locator('[data-testid="dept-member-pick"]').count()) === 1);
	await shot(zp, "1440-rbac-dept-admin");
	const forb = await zhang.api.post(`${base}/api/admin/departments`, { data: { name: "x", parentId: D["研发部"] } });
	check("dept admin: creating a department under another department → 403", forb.status() === 403, `status=${forb.status()}`);
	const forb2 = await zhang.api.post(`${base}/api/admin/members/${wang.me.userId}/disable`);
	check("dept admin: disabling a member of another department → 403", forb2.status() === 403, `status=${forb2.status()}`);
	const forb3 = await zhang.api.post(`${base}/api/admin/role-assignments`, { data: { subject: { kind: "user", id: li.me.userId }, roleId: "builtin:auditor", scope: { kind: "org" } } });
	check("dept admin: cannot grant roles beyond their own permissions → 403", forb3.status() === 403, `status=${forb3.status()}`);

	// ------------------------------------------------------------------ security auditor (钱八): read-only tabs
	await oapi.post(`${base}/api/admin/role-assignments`, { data: { subject: { kind: "user", id: qian.me.userId }, roleId: "builtin:auditor", scope: { kind: "org" } } });
	const qp = await qian.ctx.newPage();
	await qp.goto(`${base}/admin`);
	await qp.waitForSelector('[data-testid="admin-tabs"]');
	const qTabs = await qp.locator('[data-testid^="admin-tab-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid").replace("admin-tab-", "")));
	check("auditor: sees audit + trace (read-only) but not models / budgets / sessions / invites", ["audit", "trace"].every((t) => qTabs.includes(t)) && !["models", "budgets", "sessions", "invites"].some((t) => qTabs.includes(t)), qTabs.join(","));
	await qp.goto(`${base}/admin?tab=members`);
	await qp.waitForSelector('[data-testid="admin-member"]');
	check("auditor: members list has no disable / remove buttons", (await qp.locator('[data-testid="member-disable"]').count()) === 0);
	await qp.goto(`${base}/admin?tab=audit`);
	await qp.waitForSelector('[data-testid="admin-audit"]');
	check("auditor: audit log readable", (await qp.locator('[data-testid="admin-audit"]').innerText()).includes("授予角色"));
	const qOrg = await qian.api.patch(`${base}/api/org`, { data: { name: "hacked" } });
	check("auditor: changing org settings → 403", qOrg.status() === 403);

	// ------------------------------------------------------------------ guest (孙七): 我的权限 + no admin
	const sp = await sun.ctx.newPage();
	await sp.goto(`${base}/admin`);
	await sp.waitForSelector('[data-testid="home-greeting"]', { timeout: 10000 });
	check("guest: /admin redirects home (no admin permission anywhere)", !sp.url().includes("/admin"));
	await sp.goto(`${base}/settings?tab=permissions`);
	await sp.waitForSelector('[data-testid="my-permissions"] [data-testid="my-roles"]');
	check("我的权限: shows the guest role", (await sp.locator('[data-testid="my-roles"]').innerText()).includes("访客"));
	await sp.locator('[data-testid="my-effective"] [data-testid="effective-toggle"]').click();
	await sp.locator('[data-testid="my-effective"] [role="switch"]').uncheck();
	const sandbox = sp.locator('[data-testid="my-effective"] [data-perm="sandbox.use"]');
	check("我的权限: sandbox is not granted to a guest", (await sandbox.getAttribute("data-allow")) === "0");
	await sandbox.locator('[data-testid="why-btn"]').click();
	check("我的权限: 为什么 explains the denial", (await sandbox.innerText()).includes("默认拒绝"));
	check("我的权限: model use is granted", (await sp.locator('[data-testid="my-effective"] [data-perm="model.use"]').getAttribute("data-allow")) === "1");
	await sp.locator('[data-testid="my-permissions"]').scrollIntoViewIfNeeded();
	await shot(sp, "1440-rbac-my-permissions");
	const shareTry = await sun.api.post(`${base}/api/projects`, { data: { kind: "space", name: "x" } });
	check("guest: creating a project → 403", shareTry.status() === 403);

	// ------------------------------------------------------------------ viewports: 1366 / 1440 / 390
	const viewports = [
		["1366", { width: 1366, height: 768 }],
		["1440", { width: 1440, height: 900 }],
		["390", { width: 390, height: 844 }],
	];
	for (const [label, vp] of viewports) {
		const c = await browser.newContext({ viewport: vp, locale: "zh-CN", deviceScaleFactor: label === "390" ? 2 : 1 });
		await c.addCookies(await octx.cookies());
		const p = await c.newPage();
		const noOverflow = async (what) => check(`${label}: ${what} fits the viewport (no horizontal scroll)`, await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1), await p.evaluate(() => `${document.documentElement.scrollWidth}/${window.innerWidth}`));
		await p.goto(`${base}/admin?tab=departments`);
		await p.waitForSelector('[data-testid="admin-departments"]');
		await p.locator(`[data-testid="dept-node"][data-dept="${D["销售部"]}"] [data-testid="dept-select"]`).click();
		await p.waitForSelector('[data-testid="dept-detail"]');
		await noOverflow("组织架构");
		await shot(p, `${label}-rbac-org-structure`);
		await p.goto(`${base}/admin?tab=roles`);
		await p.waitForSelector('[data-testid="role-item"]');
		await noOverflow("角色与权限");
		await shot(p, `${label}-rbac-roles`);
		await p.goto(`${base}/admin?tab=authz`);
		await p.waitForSelector('[data-testid="authz-form"]');
		await noOverflow("授权");
		await shot(p, `${label}-rbac-authz`);
		await p.goto(`${base}/admin?tab=members`);
		await p.waitForSelector('[data-testid="admin-member"]');
		await p.locator('[data-testid="admin-member"]', { hasText: "赵六" }).locator('[data-testid="member-detail-open"]').click();
		await p.waitForSelector('[data-testid="detail-effective"]');
		await noOverflow("成员详情");
		await shot(p, `${label}-rbac-member-detail`);
		await c.close();
	}
	const sctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "zh-CN" });
	await sctx.addCookies(await sun.ctx.cookies());
	const smobile = await sctx.newPage();
	await smobile.goto(`${base}/settings?tab=permissions`);
	await smobile.waitForSelector('[data-testid="my-permissions"] [data-testid="my-roles"]');
	await smobile.locator('[data-testid="my-permissions"]').scrollIntoViewIfNeeded();
	check("390: 我的权限 fits the viewport", await smobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
	await shot(smobile, "390-rbac-my-permissions");
	ok = true;
} catch (e) {
	console.error(e);
	check("round4-rbac completed without an exception", false, String(e?.message ?? e).split("\n")[0]);
} finally {
	await browser.close();
	child.kill("SIGTERM");
	await new Promise((r) => child.once("exit", r));
}
const pass = summary(join(ROOT, "artifacts/screenshots/round4-rbac-results.json"));
if (!pass || !ok) console.error(serverLog.split("\n").slice(-20).join("\n"));
process.exitCode = pass && ok ? 0 : 1;
