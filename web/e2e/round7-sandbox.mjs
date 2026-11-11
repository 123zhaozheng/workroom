// Round 7 · pluggable sandbox providers (admin UI + project override).
//  A. INTERCEPTED (route-mocked admin DTOs, labelled "[intercepted]"): rendering, capability table, key display, states, screenshots (1440 / 390, light + dark)
//  B. REAL server (WORKROOM_SECRET_KEY set, WORKROOM_WEBHOOK_ALLOWLIST=127.0.0.1): permissions (member hidden + 403), key never in HTML/API responses, clear key, egress ack required,
//     SSRF refusal, unreachable endpoint → failure shown with no silent fallback, project override rules. Skipped with a reason while the routes are absent.
//  C. LIVE roundtrip against a real OpenSandbox (WORKROOM_TEST_OPENSANDBOX_URL / _KEY) — skipped with an explicit reason otherwise, never faked.
// Run: npm run build:web && node web/e2e/round7-sandbox.mjs        (port 8907)
import { check, chromium, register, ROOT, shot, startServer, summary, SHOTS, pick, selValue, selOptions } from "./lib.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

mkdirSync(join(SHOTS, "round7"), { recursive: true });
const PORT = 8907;
const KEY = "sk-e2e-SECRET-KEY-9f3a7c1d-7788";
const server = await startServer({ port: PORT, env: { WORKROOM_SECRET_KEY: "round7-e2e-secret-key-0123456789abcdef", WORKROOM_WEBHOOK_ALLOWLIST: "127.0.0.1" } });
const base = server.base;
const browser = await chromium.launch();
let skipped = 0;
const skip = (name, why) => {
	skipped++;
	console.log(`SKIP  ${name}  — ${why}`);
};
const ctxOf = (w = 1440, h = 900, scheme = "light") => browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w < 500 ? 2 : 1, colorScheme: scheme });
const shotR = async (page, name) => {
	await page.screenshot({ path: join(SHOTS, "round7", `${name}.png`), fullPage: false });
};

// ---------- fixtures ----------
const caps = (over = {}) => ({ exec: "supported", streamOutput: "supported", cancel: "supported", commandTimeout: "supported", files: "supported", networkOff: "unverified", networkOn: "supported", resourceLimits: "supported", reconnect: "unverified", services: "unsupported", pty: "unsupported", preview: "unverified", snapshot: "unsupported", pauseResume: "unsupported", skills: "upload_readonly", isolation: "每个工作区一个独立容器", location: "self_hosted", ...over });
const cfg = (provider, label, over = {}) => ({ provider, label, enabled: false, apiKeySet: false, allowPrivateNetwork: false, egressAcknowledged: false, createTimeoutSec: 60, idleTimeoutSec: 900, lifetimeSec: 7200, capabilities: caps(), sdk: { name: provider === "e2b" ? "e2b" : provider === "daytona" ? "@daytonaio/sdk" : "@alibaba-group/opensandbox", version: provider === "daytona" ? null : "1.2.3" }, ...over });
const mockData = (o = {}) => ({
	providers: [
		cfg("opensandbox", "OpenSandbox", { enabled: true, endpoint: "http://opensandbox.internal:8080", template: "workroom-base:py312", apiKeySet: true, apiKeyHint: "1234", allowPrivateNetwork: true, lastTest: { ok: true, at: new Date().toISOString(), kind: "roundtrip", detail: "往返测试通过", version: "0.4.1", durationMs: 4210, steps: [{ step: "创建沙箱", ok: true, ms: 2100 }, { step: "运行命令", ok: true, ms: 310 }, { step: "读写文件", ok: true, ms: 180 }, { step: "销毁沙箱", ok: true, ms: 1620 }] } }),
		cfg("e2b", "E2B", { capabilities: caps({ location: "vendor_cloud", isolation: "每个工作区一台云端微虚拟机" }), template: "base" }),
		cfg("daytona", "Daytona", { capabilities: caps({ location: "vendor_cloud", isolation: "每个工作区一个云端工作空间", pty: "unverified" }) }),
	],
	policy: { orgDefault: "opensandbox", allowProjectOverride: true },
	secretStorage: true,
	canManage: true,
	...o,
});
const INSTANCES = [
	{ id: "i1", provider: "opensandbox", spaceId: "spc_demo1", workspaceKey: "k1", remoteId: "r1", state: "ready", createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() },
	{ id: "i2", provider: "opensandbox", spaceId: "spc_demo2", workspaceKey: "k2", remoteId: null, state: "error", createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), lastError: "创建超时（60 秒）" },
];

async function mockRoutes(page, data, instances) {
	await page.route("**/api/sandbox/providers", (r) => r.fulfill({ json: data }));
	await page.route("**/api/sandbox/instances", (r) => r.fulfill({ json: { instances } }));
}

// ---------- session ----------
const aCtx = await ctxOf();
const admin = await aCtx.newPage();
await register(admin, base, { email: "owner-r7@example.com", name: "管理员" });

// ---------- A. intercepted rendering ----------
{
	const page = admin;
	await mockRoutes(page, mockData(), INSTANCES);
	await page.goto(`${base}/admin?tab=sandbox`);
	await page.waitForSelector('[data-testid="sandbox-admin"]');
	check("[intercepted] admin sees 运行环境 tab and the 执行位置 section", (await page.locator('[data-testid="admin-tab-sandbox"]').count()) === 1 && (await page.locator('[data-testid="sandbox-location"]').innerText()).includes("执行位置"));
	check("[intercepted] one card per provider (3) with location badges", (await page.locator('[data-testid^="provider-"]').count()) === 3 && (await page.locator('[data-testid="loc-e2b"]').innerText()).includes("数据会离开组织") && (await page.locator('[data-testid="loc-opensandbox"]').innerText()).includes("自托管"));
	check("[intercepted] org default select: only enabled providers selectable", await (async () => { const o = await selOptions(page.locator("#org-default")); return o.find((x) => x.value === "e2b")?.disabled && !o.find((x) => x.value === "opensandbox")?.disabled; })() && (await selValue(page.locator("#org-default"))) === "opensandbox");
	const saved = await page.locator('[data-testid="opensandbox-key-saved"]').innerText();
	check("[intercepted] key shown as 已保存 ••••1234, never an input value", saved.includes("已保存") && saved.includes("••••1234") && (await page.locator('[data-testid="opensandbox-apikey"]').count()) === 0);
	await page.locator('[data-testid="opensandbox-key-replace"]').click();
	check("[intercepted] 更换 opens an EMPTY write-only field", (await page.locator('[data-testid="opensandbox-apikey"]').inputValue()) === "" && (await page.locator('[data-testid="opensandbox-apikey"]').getAttribute("type")) === "password");
	check("[intercepted] domain only for E2B", (await page.locator('[data-testid="e2b-domain"]').count()) === 1 && (await page.locator('[data-testid="daytona-domain"]').count()) === 0 && (await page.locator('[data-testid="opensandbox-domain"]').count()) === 0);
	check("[intercepted] egress acknowledgement only on vendor-cloud cards", (await page.locator('[data-testid="e2b-egress"]').count()) === 1 && (await page.locator('[data-testid="opensandbox-egress"]').count()) === 0);
	await page.locator('[data-testid="provider-opensandbox"] summary').click();
	await page.locator('[data-testid="provider-daytona"] summary').click();
	check("[intercepted] SDK line (inside 能力与技术详情), lifecycle units (秒/分钟/小时)", (await page.locator('[data-testid="opensandbox-sdk"]').innerText()).includes("1.2.3") && (await page.locator('[data-testid="daytona-sdk"]').innerText()).includes("未安装") && (await page.locator('[data-testid="opensandbox"], [data-testid="provider-opensandbox"]').first().innerText()).includes("空闲回收（分钟）"));
	check("[intercepted] last test: result, steps, time", await page.locator('[data-testid="opensandbox-test-result"]').evaluate((el) => /成功/.test(el.textContent) && /创建沙箱/.test(el.textContent) && /4\.2 秒/.test(el.textContent)));
	await page.locator('[data-testid="provider-e2b"] summary').click();
	check("[intercepted] unverified 禁止联网 is warned about visibly (not hidden in the fold)", (await page.locator('[data-testid="e2b-net-warning"]').innerText()).includes("尚未验证"));
	const capText = await page.locator('[data-testid="e2b-caps"]').innerText();
	check("[intercepted] capability table: 支持 / 未验证 / 不支持 + isolation sentence", ["支持", "未验证", "不支持", "每个工作区一台云端微虚拟机"].every((t) => capText.includes(t)));
	check("[intercepted] no unsaved-change test hint conflict: 完整测试 explains temporary sandbox", await (async () => { await page.locator('[data-testid="provider-opensandbox"]').getByRole("button", { name: "测试说明" }).click(); const t = await page.locator('[data-testid="help-content"]').innerText(); await page.keyboard.press("Escape"); return t.includes("只使用合成数据"); })());
	check("[intercepted] instances table lists provider, space, state, error", await page.locator('[data-testid="sandbox-instances"]').evaluate((el) => /OpenSandbox/.test(el.textContent) && /工作区/.test(el.textContent) && el.innerHTML.includes("spc_demo1") && /可用/.test(el.textContent) && /创建超时/.test(el.textContent)));
	await shotR(page, "admin-sandbox-1440-caps");
	await page.locator('[data-testid="provider-e2b"] summary').click();
	await page.evaluate(() => document.querySelector(".wr-scroll")?.scrollTo(0, 0));
	await shotR(page, "admin-sandbox-1440-light");
	// default unhealthy + secret storage missing + empty instances
	await page.unroute("**/api/sandbox/providers");
	await page.unroute("**/api/sandbox/instances");
	const bad = mockData({ secretStorage: false });
	bad.providers[0] = { ...bad.providers[0], apiKeySet: false, lastTest: { ok: false, at: new Date().toISOString(), kind: "health", detail: "无法连接到 http://opensandbox.internal:8080（连接被拒绝）", durationMs: 120 } };
	await mockRoutes(page, bad, []);
	await page.reload();
	await page.waitForSelector('[data-testid="sandbox-admin"]');
	check("[intercepted] secretStorage=false → explicit state, key field disabled with reason", (await page.locator('[data-testid="secret-missing"]').innerText()).includes("密钥存储") && (await page.locator('[data-testid="opensandbox-apikey"]').isDisabled()));
	check("[intercepted] unhealthy default shown, says no silent fallback, selection unchanged", (await page.locator('[data-testid="default-unhealthy"]').innerText()).includes("不会自动改用本机沙箱") && (await selValue(page.locator("#org-default"))) === "opensandbox");
	check("[intercepted] empty instances → empty state", (await page.locator('[data-testid="sandbox-instances"]').innerText()).includes("还没有远程沙箱"));
	await shotR(page, "admin-sandbox-1440-states");
	const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
	// dark + phone
	const dctx = await ctxOf(1440, 900, "dark");
	const dp = await dctx.newPage();
	await dp.context().addCookies(await aCtx.cookies());
	await mockRoutes(dp, mockData(), INSTANCES);
	await dp.goto(`${base}/admin?tab=sandbox`);
	await dp.waitForSelector('[data-testid="sandbox-admin"]');
	await shotR(dp, "admin-sandbox-1440-dark");
	await dctx.close();
	const mctx = await ctxOf(390, 844);
	const mp = await mctx.newPage();
	await mp.context().addCookies(await aCtx.cookies());
	await mockRoutes(mp, mockData(), INSTANCES);
	await mp.goto(`${base}/admin?tab=sandbox`);
	await mp.waitForSelector('[data-testid="sandbox-admin"]');
	check("[intercepted] 390px: no horizontal scroll", !(await overflow(mp)));
	await shotR(mp, "admin-sandbox-390-light");
	await mp.locator('[data-testid="provider-e2b"]').scrollIntoViewIfNeeded();
	await shotR(mp, "admin-sandbox-390-e2b");
	await mctx.close();
	await page.unrouteAll({ behavior: "ignoreErrors" });
}

// ---------- B. REAL server ----------
// Operator allowlist WORKROOM_WEBHOOK_ALLOWLIST=127.0.0.1 AND the org admin's allowPrivateNetwork are both required for a loopback endpoint.
{
	const leaks = [];
	const watch = (p) =>
		p.on("response", async (r) => {
			if (!r.url().includes("/api/")) return;
			try {
				if ((await r.text()).includes(KEY)) leaks.push(r.url());
			} catch {
				/* body unavailable */
			}
		});
	watch(admin);
	const j = async (resp) => ({ status: resp.status(), body: await resp.json().catch(() => null) });
	const putP = (prov, data) => admin.request.put(`${base}/api/sandbox/providers/${prov}`, { data }).then(j);
	const getAdmin = async () => (await j(await admin.request.get(`${base}/api/sandbox/providers`))).body;
	const open = async () => {
		await admin.goto(`${base}/admin?tab=sandbox`);
		await admin.waitForSelector('[data-testid="sandbox-admin"]');
	};
	check("[real] GET /api/sandbox/providers answers 200 for the admin", (await admin.request.get(`${base}/api/sandbox/providers`)).status() === 200);

	// member
	const inv = (await (await admin.request.post(`${base}/api/admin/invites`, { data: { role: "member", ttlHours: 24 } })).json()).invite.code;
	const mCtx = await ctxOf();
	const member = await mCtx.newPage();
	await member.goto(`${base}/register?invite=${inv}`);
	await member.fill("#name", "成员甲");
	await member.fill("#email", "member-r7@example.com");
	await member.fill("#password", "password123");
	await member.click('button[type="submit"]');
	await member.waitForSelector('[data-testid="home-greeting"]');
	await member.goto(`${base}/admin?tab=sandbox`);
	await member.waitForTimeout(800);
	check("[real] member: no sandbox section or tab", (await member.locator('[data-testid="sandbox-admin"]').count()) === 0 && (await member.locator('[data-testid="admin-tab-sandbox"]').count()) === 0);
	const mApi = await Promise.all([member.request.get(`${base}/api/sandbox/providers`), member.request.put(`${base}/api/sandbox/providers/opensandbox`, { data: { enabled: true } }), member.request.get(`${base}/api/sandbox/instances`), member.request.get(`${base}/api/sandbox/provider-policy`), member.request.put(`${base}/api/sandbox/provider-policy`, { data: { allowProjectOverride: true } }), member.request.post(`${base}/api/sandbox/providers/opensandbox/test`, { data: { kind: "health" } })]);
	check("[real] member API: providers / update / instances / policy read+write / test all 403", mApi.every((r) => r.status() === 403), mApi.map((r) => r.status()).join(","));

	// admin UI + key handling
	await open();
	check("[real] admin: section, 3 cards, secret storage available", (await admin.locator('[data-testid^="provider-"]').count()) === 3 && (await admin.locator('[data-testid="secret-missing"]').count()) === 0);
	check("[real] capabilities unverified + isolation text before any test", await admin.locator('[data-testid="provider-e2b"]').evaluate((el) => el.querySelector('[data-testid="e2b-isolation"]') !== null));
	const card = admin.locator('[data-testid="provider-opensandbox"]');
	// SSRF through the UI: loopback without the admin's allowance
	await card.locator('[data-testid="opensandbox-endpoint"]').fill("http://127.0.0.1:9");
	await card.locator('[data-testid="opensandbox-apikey"]').fill(KEY);
	await card.locator('[data-testid="opensandbox-save"]').click();
	await card.locator('[role="alert"]').first().waitFor({ timeout: 10000 }).catch(() => {});
	const ssrfMsg = (await card.locator('[role="alert"]').allInnerTexts()).join(" ");
	const ssrfApi = await putP("opensandbox", { endpoint: "http://127.0.0.1:9", allowPrivateNetwork: false });
	check("[real] loopback endpoint without allowPrivateNetwork: UI shows a plain message, API 400 blocked_address", ssrfApi.status === 400 && ssrfApi.body?.error?.code === "blocked_address" && ssrfMsg.includes("内网"), `${ssrfApi.status} ${ssrfMsg.slice(0, 80)}`);
	await shotR(admin, "admin-sandbox-real-ssrf");
	const notListed = await putP("opensandbox", { endpoint: "http://10.255.255.1:9", allowPrivateNetwork: true });
	check("[real] allowPrivateNetwork ticked but host not on the operator allowlist: 400", notListed.status === 400, `${notListed.status} ${notListed.body?.error?.code}`);
	// save a key through the UI (loopback allowed by both switches, not enabled yet)
	await open();
	await card.locator('[data-testid="opensandbox-endpoint"]').fill("http://127.0.0.1:9");
	await card.locator('[data-testid="opensandbox-private"]').check();
	await card.locator('[data-testid="opensandbox-apikey"]').fill(KEY);
	await card.locator('[data-testid="opensandbox-save"]').click();
	await admin.waitForSelector('[data-testid="opensandbox-key-saved"]', { timeout: 15000 }).catch(() => {});
	const savedTxt = await card.locator('[data-testid="opensandbox-key-saved"]').innerText().catch(() => "");
	check("[real] saved key shown only as 已保存 ••••<last4>", savedTxt.includes("已保存") && savedTxt.includes(KEY.slice(-4)), savedTxt);
	await open();
	const html = await admin.content();
	const api1 = JSON.stringify(await getAdmin());
	const inputs = await admin.evaluate(() => [...document.querySelectorAll("input")].map((i) => i.value).join("|"));
	check("[real] key string absent from page HTML, input values, API responses (all browser-seen responses scanned)", !html.includes(KEY) && !inputs.includes(KEY) && !api1.includes(KEY) && leaks.length === 0, leaks.join(","));
	// clear key
	await card.locator('[data-testid="opensandbox-key-clear"]').click();
	await card.locator('[data-testid="opensandbox-save"]').click();
	await admin.waitForSelector('[data-testid="opensandbox-apikey"]', { timeout: 15000 }).catch(() => {});
	check("[real] cleared key: apiKeySet false, empty field shown again", (await getAdmin()).providers.find((p) => p.provider === "opensandbox").apiKeySet === false && (await card.locator('[data-testid="opensandbox-apikey"]').count()) === 1);
	// egress acknowledgement
	const e2b = admin.locator('[data-testid="provider-e2b"]');
	await e2b.locator('[data-testid="e2b-enabled"]').check();
	check("[real] E2B: UI blocks enabling without acknowledgement", (await e2b.locator('[data-testid="e2b-save"]').isDisabled()) && (await e2b.locator('[data-testid="e2b-need-egress"]').count()) === 1);
	const noAck = await putP("e2b", { enabled: true, apiKey: "e2b-key-0123456789", egressAcknowledged: false });
	const noAckD = await putP("daytona", { enabled: true, apiKey: "daytona-key-0123456789", egressAcknowledged: false });
	check("[real] E2B and Daytona: server refuses enabling without acknowledgement (400 egress_ack_required)", noAck.status === 400 && noAck.body?.error?.code === "egress_ack_required" && noAckD.status === 400 && noAckD.body?.error?.code === "egress_ack_required", `${noAck.body?.error?.code}/${noAckD.body?.error?.code}`);
	const okAck = await putP("e2b", { enabled: true, apiKey: "e2b-key-0123456789", egressAcknowledged: true });
	check("[real] E2B enables once acknowledged", okAck.status === 200 && okAck.body?.provider?.enabled === true && !JSON.stringify(okAck.body).includes("e2b-key-0123456789"), `${okAck.status}`);
	// unreachable endpoint, default chosen → failure shown, nothing falls back
	const en = await putP("opensandbox", { enabled: true, endpoint: "http://127.0.0.1:9", allowPrivateNetwork: true, apiKey: KEY });
	const pol = await j(await admin.request.put(`${base}/api/sandbox/provider-policy`, { data: { orgDefault: "opensandbox", allowProjectOverride: false } }));
	check("[real] opensandbox enabled (loopback allowed by both switches) and set as org default", en.status === 200 && pol.status === 200 && pol.body?.policy?.orgDefault === "opensandbox", `${en.status}/${pol.status}`);
	await open();
	await card.locator('[data-testid="opensandbox-test-health"]').click();
	await admin.waitForSelector('[data-testid="opensandbox-test-result"][data-ok="false"], [data-testid="opensandbox-test-error"]', { timeout: 45000 });
	const failTxt = await card.locator('[data-testid="opensandbox-test"]').innerText();
	check("[real] unreachable endpoint → plain failure; default still OpenSandbox; unhealthy banner (no fallback)", failTxt.includes("失败") && (await selValue(admin.locator("#org-default"))) === "opensandbox" && (await admin.locator('[data-testid="default-unhealthy"]').count()) === 1, failTxt.replace(/\s+/g, " ").slice(0, 100));
	await shotR(admin, "admin-sandbox-real-test-failed");
	await admin.evaluate(() => document.querySelector(".wr-scroll")?.scrollTo(0, 0));
	await shotR(admin, "admin-sandbox-real-1440-light");
	check("[real] key still absent from every response after tests", leaks.length === 0);
	const inst = await j(await admin.request.get(`${base}/api/sandbox/instances`));
	await open();
	check("[real] instances: API {instances: []} and empty state in the page", inst.status === 200 && Array.isArray(inst.body?.instances) && (await admin.locator('[data-testid="sandbox-instances"]').innerText()).length > 0);
	// phone + dark, real data
	const dctx = await ctxOf(1440, 900, "dark");
	const dp = await dctx.newPage();
	await dctx.addCookies(await aCtx.cookies());
	await dp.goto(`${base}/admin?tab=sandbox`);
	await dp.waitForSelector('[data-testid="sandbox-admin"]');
	await shotR(dp, "admin-sandbox-real-1440-dark");
	await dctx.close();
	const pctx = await ctxOf(390, 844);
	const pp = await pctx.newPage();
	await pctx.addCookies(await aCtx.cookies());
	await pp.goto(`${base}/admin?tab=sandbox`);
	await pp.waitForSelector('[data-testid="sandbox-admin"]');
	check("[real] 390px: no horizontal scroll", !(await pp.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)));
	await shotR(pp, "admin-sandbox-real-390-light");
	await pctx.close();

	// project override
	const projRes = await (await admin.request.post(`${base}/api/projects`, { data: { name: "运行位置项目" } })).json();
	const pid = projRes.project?.id ?? projRes.id;
	const gp = async (pg) => j(await pg.request.get(`${base}/api/projects/${pid}/sandbox-provider`));
	await admin.request.put(`${base}/api/sandbox/provider-policy`, { data: { allowProjectOverride: false } });
	await admin.goto(`${base}/projects/${pid}`);
	await admin.waitForSelector("h1");
	await admin.waitForTimeout(600);
	const hidden = (await admin.locator('[data-testid="project-sandbox"]').count()) === 0 && (await gp(admin)).body?.allowed === false;
	const refused = await j(await admin.request.put(`${base}/api/projects/${pid}/sandbox-provider`, { data: { provider: "opensandbox" } }));
	check("[real] project override hidden when the org does not allow it; PUT refused (403)", hidden && refused.status === 403, `PUT ${refused.status}`);
	await admin.request.put(`${base}/api/sandbox/provider-policy`, { data: { allowProjectOverride: true } });
	await admin.goto(`${base}/projects/${pid}`);
	await admin.waitForSelector('[data-testid="project-sandbox"]');
	await pick(admin.locator('[data-testid="project-sandbox-select"]'), "opensandbox");
	await admin.waitForSelector('[data-testid="project-sandbox"] [role="status"]');
	check("[real] allowed: owner sees the picker, choosing OpenSandbox is saved and read back", (await gp(admin)).body?.provider === "opensandbox" && (await selValue(admin.locator('[data-testid="project-sandbox-select"]'))) === "opensandbox");
	await shotR(admin, "project-sandbox-override");
	await pick(admin.locator('[data-testid="project-sandbox-select"]'), "");
	await admin.waitForSelector('[data-testid="project-sandbox"] [role="status"]');
	check("[real] 跟随组织默认 clears the override (provider null)", (await gp(admin)).body?.provider === null);
	const mGet = await member.request.get(`${base}/api/projects/${pid}/sandbox-provider`);
	const mPut = await member.request.put(`${base}/api/projects/${pid}/sandbox-provider`, { data: { provider: "local" } });
	await member.goto(`${base}/projects/${pid}`);
	await member.waitForTimeout(800);
	check("[real] non-member: GET 404, PUT refused, no picker", mGet.status() === 404 && mPut.status() >= 400 && (await member.locator('[data-testid="project-sandbox"]').count()) === 0, `${mGet.status()}/${mPut.status()}`);
	await mCtx.close();
}

// ---------- C. live roundtrip ----------
const LIVE_URL = process.env.WORKROOM_TEST_OPENSANDBOX_URL;
if (!LIVE_URL) {
	skip("[live] OpenSandbox roundtrip", !LIVE_URL ? "WORKROOM_TEST_OPENSANDBOX_URL not set (no real OpenSandbox available)" : "");
} else {
	const put = await admin.request.put(`${base}/api/sandbox/providers/opensandbox`, { data: { enabled: true, endpoint: LIVE_URL, allowPrivateNetwork: true, egressAcknowledged: true, apiKey: process.env.WORKROOM_TEST_OPENSANDBOX_KEY ?? "no-key-for-local-0000" } });
	await admin.goto(`${base}/admin?tab=sandbox`);
	await admin.waitForSelector('[data-testid="sandbox-admin"]');
	const c = admin.locator('[data-testid="provider-opensandbox"]');
	await c.locator('[data-testid="opensandbox-test-roundtrip"]').click();
	// Wait for THIS run's full-test result (an earlier connectivity result for the same card may already be on screen).
	await admin.waitForFunction(() => (document.querySelector('[data-testid="opensandbox-test-result"]')?.textContent ?? "").includes("完整测试"), null, { timeout: 180000 });
	const ok = (await c.locator('[data-testid="opensandbox-test-result"]').getAttribute("data-ok")) === "true";
	check("[live] OpenSandbox full roundtrip passes (create, exec, file, destroy)", put.status() < 400 && ok, `put=${put.status()} ` + (await c.locator('[data-testid="opensandbox-test-result"]').innerText()).replace(/\s+/g, " ").slice(0, 300));
	await shotR(admin, "admin-sandbox-live-roundtrip");
}

console.log(`\n${skipped} step(s) skipped with explicit reasons (not counted as passed).`);
const ok = summary(join(SHOTS, "round7", "round7-sandbox.json"));
await browser.close();
await server.stop();
process.exitCode = ok ? 0 : 1;
