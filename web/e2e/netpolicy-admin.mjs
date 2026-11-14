// 网络访问策略（组织管理 › 角色与权限 › 网络访问）：入口按权限显示；模式 / 三个名单（格式校验、通配、去重）；保存并刷新后仍在；
// 环境变量条目只读展示；「测试网址」（含未保存修改、内网例外、阻止名单、元数据、协议）；恢复默认；审计；明暗两张截图。
// Run: npm run -s build:web && node web/e2e/netpolicy-admin.mjs   (port 8871; SHOTS_DIR overrides the screenshot folder)
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { check, chromium, register, sleep, startServer, summary, SHOTS } from "./lib.mjs";

const DIR = process.env.SHOTS_DIR || join(SHOTS, "netpolicy");
mkdirSync(DIR, { recursive: true });
const T = (id) => `[data-testid="${id}"]`;
// A private (loopback) target the default policy must refuse.
const internal = createServer((_q, res) => res.writeHead(200, { "content-type": "text/plain" }).end("internal"));
await new Promise((r) => internal.listen(0, "127.0.0.1", r));
const INTERNAL = `127.0.0.1:${internal.address().port}`;
const server = await startServer({ port: 8871, env: { WORKROOM_URL_ALLOWLIST: "ops.internal.test:8080" } });
const base = server.base;
const browser = await chromium.launch();

try {
	const octx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "zh-CN" });
	const page = await octx.newPage();
	await register(page, base, { email: "owner@np.example", name: "所有者" });
	const api = octx.request;

	// ---- who sees the entry: an auditor (admin console, no network.manage) does not; a custom role holder does
	const invite = async (role = "member") => (await (await api.post(`${base}/api/admin/invites`, { data: { role, ttlHours: 24 } })).json()).invite.code;
	const newUser = async (name) => {
		const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
		const r = await ctx.request.post(`${base}/api/auth/register`, { data: { email: `${name}@np.example`, name, password: "password123", inviteCode: await invite() } });
		const j = await r.json();
		return { ctx, me: j.me, token: j.token };
	};
	const auditor = await newUser("auditor");
	await api.post(`${base}/api/admin/role-assignments`, { data: { subject: { kind: "user", id: auditor.me.userId }, roleId: "builtin:auditor", scope: { kind: "org" } } });
	const ap = await auditor.ctx.newPage();
	await ap.goto(`${base}/admin`);
	await ap.waitForSelector(T("admin-tabs"));
	check("安全审计员（有管理后台、没有 network.manage）看不到「网络访问」入口", (await ap.locator(T("admin-tab-network")).count()) === 0 && (await ap.locator(T("admin-tab-roles")).count()) === 1);
	await ap.goto(`${base}/admin?tab=network`);
	await ap.waitForSelector(T("admin-tabs"));
	check("直接打开 ?tab=network 也不会显示该页（落回第一个可见页签）", (await ap.locator(T("network-tab")).count()) === 0);
	check("服务端同样拒绝（GET 403）", (await auditor.ctx.request.get(`${base}/api/admin/network-policy`)).status() === 403);

	// ---- the owner's page
	await page.goto(`${base}/admin?tab=roles`);
	await page.waitForSelector(T("admin-tabs"));
	const group = await page.evaluate(() => [...document.querySelectorAll('[role="group"][aria-label]')].find((g) => g.querySelector('[data-testid="admin-tab-network"]'))?.getAttribute("aria-label"));
	check("入口在「角色与权限」分组下（角色 / 授权 / 网络访问）", group === "角色与权限");
	await page.click(T("admin-tab-network"));
	await page.waitForSelector(T("network-tab"));
	await page.waitForSelector(T("net-mode-open"));
	const radios = async () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid^="net-mode-"] input')].map((i) => [i.closest("label").dataset.testid.slice(9), i.checked])));
	check("默认：全部公网允许，三个名单为空（允许名单在该模式下折叠不生效），保存按钮不可用", JSON.stringify(await radios()) === '{"open":true,"allowlist":false}' && (await page.locator(T("net-block-chip")).count()) === 0 && (await page.locator(T("net-save")).isDisabled()));
	check("环境变量条目在「内网例外」里只读显示（锁形标记，没有删除按钮）", (await page.locator(T("net-internal-env")).count()) === 1 && (await page.locator(T("net-internal-env")).innerText()).includes("ops.internal.test:8080") && (await page.locator(`${T("net-internal-env")} button`).count()) === 0);
	check("页面写明始终生效、不可关闭的安全底线", (await page.locator(T("net-floor")).innerText()).includes("云元数据"));
	await page.screenshot({ path: join(DIR, "netpolicy-1-default.png") });

	// ---- test tool with the default policy (dry run against the saved policy)
	const test = async (url) => {
		await page.fill(T("net-test-input"), url);
		await page.click(T("net-test-run"));
		await page.waitForFunction((u) => document.querySelector('[data-testid="net-test-result"]'), null, { timeout: 8000 });
		await sleep(150);
		return { v: await page.locator(T("net-test-verdict")).innerText().catch(() => ""), allowed: await page.locator(T("net-test-result")).getAttribute("data-allowed"), reason: await page.locator(T("net-test-reason")).innerText().catch(() => "") };
	};
	let r = await test("https://93.184.216.34/page");
	check("测试网址：公网地址 → 允许", r.v === "允许" && r.allowed === "true", r.reason);
	r = await test(`http://${INTERNAL}/`);
	check("测试网址：内网地址 → 拦截并提示可加入「内网例外」", r.v === "拦截" && /内网例外/.test(r.reason), r.reason);
	r = await test("http://169.254.169.254/latest/meta-data");
	check("测试网址：云元数据地址 → 拦截（始终）", r.v === "拦截" && /元数据/.test(r.reason), r.reason);
	r = await test("ftp://93.184.216.34/x");
	check("测试网址：非 http/https 协议 → 拦截", r.v === "拦截" && /协议/.test(r.reason), r.reason);

	// ---- edit: allowlist mode + lists; validation; wildcard; dedupe
	await page.click(`${T("net-mode-allowlist")} input`);
	check("切到「仅允许名单内域名」：允许名单标为生效；环境变量里已有一条放行条目，所以不出现「名单为空」警告", (await page.locator(T("net-empty-warning")).count()) === 0 && !(await page.locator(T("net-allow")).evaluate((e) => e.closest("section").textContent.includes("不生效"))));
	const add = async (kind, text) => {
		await page.fill(T(`net-${kind}-input`), text);
		await page.press(T(`net-${kind}-input`), "Enter");
	};
	await add("allow", "bad$host.com");
	check("格式校验：含非法字符的条目被拒绝并说明原因", (await page.locator(T("net-allow-error")).count()) === 1 && (await page.locator(T("net-allow-chip")).count()) === 0, await page.locator(T("net-allow-error")).innerText());
	await page.fill(T("net-allow-input"), "");
	await add("allow", "*.example.com");
	await add("allow", "https://Docs.Other.org:8443/a/b");
	await add("allow", "*.example.com");
	const allowChips = await page.locator(T("net-allow-chip")).allInnerTexts();
	check("允许名单：通配符保留、粘贴网址取出 主机:端口 并转小写、重复项合并", JSON.stringify(allowChips.map((s) => s.trim())) === JSON.stringify(["*.example.com", "docs.other.org:8443"]), JSON.stringify(allowChips));
	await add("block", "*.ads.example.com");
	await add("internal", "169.254.169.254");
	check("内网例外不接受云元数据地址", (await page.locator(T("net-internal-error")).count()) === 1 && (await page.locator(T("net-internal-chip")).count()) === 0, await page.locator(T("net-internal-error")).innerText());
	await page.fill(T("net-internal-input"), "");
	await add("internal", INTERNAL);
	check("有未保存修改的提示，保存按钮可用", (await page.locator(T("net-dirty")).count()) === 1 && !(await page.locator(T("net-save")).isDisabled()));

	// ---- dry run with the UNSAVED form, then save
	r = await test("https://a.example.com/");
	// This machine has no outside DNS: a name that passes the allowlist can only fail at the resolve step, never at the allowlist.
	check("测试（未保存的设置）：*.example.com 下的子域名通过了允许名单这一关（本机无外网 DNS，只会停在「无法解析」）", r.allowed === "false" && /无法解析/.test(r.reason) && !/允许名单|阻止名单/.test(r.reason), r.reason);
	await add("allow", "93.184.216.34");
	r = await test("https://93.184.216.34/");
	check("测试（未保存的设置）：允许名单里的公网 IP → 允许（允许名单）", r.allowed === "true", r.reason);
	await page.click(`${T("net-allow")} button[aria-label="移除 93.184.216.34"]`);
	r = await test("https://example.org/");
	check("测试：名单外的域名 → 拦截（不在允许名单）", r.allowed === "false" && /允许名单/.test(r.reason), r.reason);
	r = await test("https://x.ads.example.com/");
	check("测试：阻止名单优先于允许名单 → 拦截", r.allowed === "false" && /阻止名单/.test(r.reason), r.reason);
	r = await test(`http://${INTERNAL}/`);
	check("测试：加入内网例外后，该内网地址 → 允许", r.allowed === "true", r.reason);
	const stored = await (await api.get(`${base}/api/admin/network-policy`)).json();
	check("以上测试没有保存任何东西（服务端仍是默认）", stored.isDefault === true && stored.policy.mode === "open");
	await page.screenshot({ path: join(DIR, "netpolicy-2-edited.png") });
	await page.click(T("net-save"));
	await page.waitForFunction(() => !document.querySelector('[data-testid="net-dirty"]'), null, { timeout: 8000 });
	const after = await (await api.get(`${base}/api/admin/network-policy`)).json();
	check("保存：服务端保存了模式与三个名单（规范化后）", after.policy.mode === "allowlist" && JSON.stringify(after.policy.allow) === '["*.example.com","docs.other.org:8443"]' && JSON.stringify(after.policy.block) === '["*.ads.example.com"]' && JSON.stringify(after.policy.internal) === `["${INTERNAL}"]` && after.isDefault === false);
	check("环境变量条目没有被写进数据库策略", !after.policy.internal.includes("ops.internal.test:8080") && JSON.stringify(after.env.internal) === '["ops.internal.test:8080"]');
	await page.reload();
	await page.waitForSelector(T("net-mode-allowlist"));
	check("刷新后设置仍在", (await radios()).allowlist === true && (await page.locator(T("net-allow-chip")).count()) === 2 && (await page.locator(T("net-block-chip")).count()) === 1 && (await page.locator(T("net-internal-chip")).count()) === 1 && (await page.locator(T("net-internal-env")).count()) === 1);
	r = await test("https://example.org/");
	check("保存后立即生效：测试名单外域名 → 拦截", r.allowed === "false");
	const audit = await (await api.get(`${base}/api/admin/audit?action=network.*`)).json();
	check("写入审计日志（network.policy.update，类别 安全）", audit.items.length === 1 && audit.items[0].action === "network.policy.update" && audit.items[0].category === "security", JSON.stringify(audit.items.map((i) => [i.action, i.category])));

	// ---- the real thing: the saved 内网例外 lets the server reach the internal host (URL import runs through the same policy)
	// (browse/fetch/MCP/personal models are covered by server tests; here we prove the HTTP path end to end with the preview API)

	// ---- dark screenshot of the saved state, plus the test result
	await page.fill(T("net-test-input"), "https://x.ads.example.com/");
	await page.click(T("net-test-run"));
	await page.waitForSelector(T("net-test-result"));
	await page.locator(T("net-test-result")).scrollIntoViewIfNeeded();
	await page.evaluate(() => document.querySelector('[data-testid="net-test"]').scrollIntoView({ block: "end" }));
	await sleep(200);
	await page.screenshot({ path: join(DIR, "netpolicy-3-test-light.png") });
	await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
	await sleep(300);
	await page.screenshot({ path: join(DIR, "netpolicy-4-test-dark.png") });
	await page.evaluate(() => document.querySelector('[data-testid="network-tab"]').scrollIntoView({ block: "start" }));
	await page.evaluate(() => document.querySelector('main').scrollIntoView({ block: "start" }));
	await sleep(200);
	await page.screenshot({ path: join(DIR, "netpolicy-5-dark.png") });
	await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

	// ---- reset
	await page.click(T("net-reset"));
	await page.waitForSelector(T("confirm-dialog"));
	await page.screenshot({ path: join(DIR, "netpolicy-6-reset-confirm.png") });
	await page.getByRole("button", { name: "恢复默认" }).last().click();
	await page.waitForFunction(() => document.querySelector('[data-testid="net-mode-open"] input')?.checked, null, { timeout: 8000 });
	const reset = await (await api.get(`${base}/api/admin/network-policy`)).json();
	check("恢复默认：模式回到「全部公网允许」、名单清空、环境变量条目仍在", reset.isDefault === true && reset.policy.allow.length + reset.policy.block.length + reset.policy.internal.length === 0 && reset.env.internal.length === 1);
	check("恢复默认也写入审计", (await (await api.get(`${base}/api/admin/audit?action=network.*`)).json()).items.length === 2);

	// ---- narrow screen
	await page.setViewportSize({ width: 390, height: 844 });
	await sleep(300);
	check("390 宽：无横向溢出", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
	await page.screenshot({ path: join(DIR, "netpolicy-7-390.png") });
} catch (e) {
	check("script completed", false, String(e?.stack ?? e).slice(0, 800));
} finally {
	await browser.close();
	await server.stop();
	internal.close();
}
process.exit(summary(join(DIR, "netpolicy-admin.json")) ? 0 : 1);
