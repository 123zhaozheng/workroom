// Round 7 · pluggable sandbox providers (admin UI + project override).
//  A. INTERCEPTED (route-mocked admin DTOs, labelled "[intercepted]"): rendering, capability table, key display, states, screenshots (1440 / 390, light + dark)
//  B. REAL server (WORKROOM_SECRET_KEY set): permissions (member hidden + 403), key never in HTML/API responses, clear key, egress ack required,
//     SSRF refusal, unreachable endpoint → failure shown with no silent fallback, project override rules. Skipped with a reason while the routes are absent.
//  C. LIVE roundtrip against a real OpenSandbox (WORKROOM_TEST_OPENSANDBOX_URL / _KEY) — skipped with an explicit reason otherwise, never faked.
// Run: npm run build:web && node web/e2e/round7-sandbox.mjs        (port 8907)
import { check, chromium, register, ROOT, shot, startServer, summary, SHOTS } from "./lib.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

mkdirSync(join(SHOTS, "round7"), { recursive: true });
const PORT = 8907;
const KEY = "sk-e2e-SECRET-KEY-9f3a7c1d-7788";
const server = await startServer({ port: PORT, env: { WORKROOM_SECRET_KEY: "round7-e2e-secret-key-0123456789abcdef", ...(process.env.WORKROOM_SANDBOX_ALLOW_PRIVATE ? { WORKROOM_SANDBOX_ALLOW_PRIVATE: process.env.WORKROOM_SANDBOX_ALLOW_PRIVATE } : {}) } });
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
	await page.route("**/api/sandbox/instances", (r) => r.fulfill({ json: instances }));
	await page.route("**/api/sandbox/provider-policy", (r) => r.fulfill({ json: data.policy }));
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
	check("[intercepted] org default select: only enabled providers selectable", (await page.locator('#org-default option[value="e2b"]').isDisabled()) && !(await page.locator('#org-default option[value="opensandbox"]').isDisabled()) && (await page.locator("#org-default").inputValue()) === "opensandbox");
	const saved = await page.locator('[data-testid="opensandbox-key-saved"]').innerText();
	check("[intercepted] key shown as 已保存 ••••1234, never an input value", saved.includes("已保存") && saved.includes("••••1234") && (await page.locator('[data-testid="opensandbox-apikey"]').count()) === 0);
	await page.locator('[data-testid="opensandbox-key-replace"]').click();
	check("[intercepted] 更换 opens an EMPTY write-only field", (await page.locator('[data-testid="opensandbox-apikey"]').inputValue()) === "" && (await page.locator('[data-testid="opensandbox-apikey"]').getAttribute("type")) === "password");
	check("[intercepted] domain only for E2B", (await page.locator('[data-testid="e2b-domain"]').count()) === 1 && (await page.locator('[data-testid="daytona-domain"]').count()) === 0 && (await page.locator('[data-testid="opensandbox-domain"]').count()) === 0);
	check("[intercepted] egress acknowledgement only on vendor-cloud cards", (await page.locator('[data-testid="e2b-egress"]').count()) === 1 && (await page.locator('[data-testid="opensandbox-egress"]').count()) === 0);
	check("[intercepted] SDK line, lifecycle units (秒/分钟/小时)", (await page.locator('[data-testid="opensandbox-sdk"]').innerText()).includes("1.2.3") && (await page.locator('[data-testid="daytona-sdk"]').innerText()).includes("未安装") && (await page.locator('[data-testid="opensandbox"], [data-testid="provider-opensandbox"]').first().innerText()).includes("空闲回收（分钟）"));
	check("[intercepted] last test: result, steps, time", await page.locator('[data-testid="opensandbox-test-result"]').evaluate((el) => /成功/.test(el.textContent) && /创建沙箱/.test(el.textContent) && /4\.2 秒/.test(el.textContent)));
	await page.locator('[data-testid="provider-e2b"] summary').click();
	const capText = await page.locator('[data-testid="e2b-caps"]').innerText();
	check("[intercepted] capability table: 支持 / 已实现，未联调 / 不支持 + isolation sentence", ["支持", "已实现，未联调", "不支持", "每个工作区一台云端微虚拟机"].every((t) => capText.includes(t)));
	check("[intercepted] no unsaved-change test hint conflict: 完整测试 explains temporary sandbox", (await page.locator('[data-testid="provider-opensandbox"]').innerText()).includes("只使用合成数据"));
	check("[intercepted] instances table lists provider, space, state, error", await page.locator('[data-testid="sandbox-instances"]').evaluate((el) => /OpenSandbox/.test(el.textContent) && /spc_demo1/.test(el.textContent) && /可用/.test(el.textContent) && /创建超时/.test(el.textContent)));
	await shotR(page, "admin-sandbox-1440-caps");
	await page.locator('[data-testid="provider-e2b"] summary').click();
	await page.evaluate(() => document.querySelector(".wr-scroll")?.scrollTo(0, 0));
	await shotR(page, "admin-sandbox-1440-light");
	// default unhealthy + secret storage missing + empty instances
	await page.unroute("**/api/sandbox/providers");
	await page.unroute("**/api/sandbox/instances");
	await page.unroute("**/api/sandbox/provider-policy");
	const bad = mockData({ secretStorage: false });
	bad.providers[0] = { ...bad.providers[0], apiKeySet: false, lastTest: { ok: false, at: new Date().toISOString(), kind: "health", detail: "无法连接到 http://opensandbox.internal:8080（连接被拒绝）", durationMs: 120 } };
	await mockRoutes(page, bad, []);
	await page.reload();
	await page.waitForSelector('[data-testid="sandbox-admin"]');
	check("[intercepted] secretStorage=false → explicit state, key field disabled with reason", (await page.locator('[data-testid="secret-missing"]').innerText()).includes("WORKROOM_SECRET_KEY") && (await page.locator('[data-testid="opensandbox-apikey"]').isDisabled()));
	check("[intercepted] unhealthy default shown, says no silent fallback, selection unchanged", (await page.locator('[data-testid="default-unhealthy"]').innerText()).includes("不会自动改用本机沙箱") && (await page.locator("#org-default").inputValue()) === "opensandbox");
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

// ---------- B. real server ----------
const probe = await admin.request.get(`${base}/api/sandbox/providers`);
const real = probe.status() === 200;
if (!real) {
	for (const n of ["member sees nothing / 403", "key never in HTML or API responses", "clear key", "egress ack required", "SSRF refusal", "unreachable endpoint → failure, no fallback", "project override visibility"]) skip(`[real] ${n}`, `server route GET /api/sandbox/providers answered ${probe.status()} (server routes not yet merged)`);
} else {
	const leaks = [];
	const watch = (p) =>
		p.on("response", async (r) => {
			if (!r.url().includes("/api/")) return;
			try {
				if ((await r.text()).includes(KEY)) leaks.push(r.url());
			} catch {
				/* body unavailable (redirect) */
			}
		});
	watch(admin);
	const j = async (resp) => ({ status: resp.status(), body: await resp.json().catch(() => null) });
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
	const mApi = await Promise.all([member.request.get(`${base}/api/sandbox/providers`), member.request.put(`${base}/api/sandbox/providers/opensandbox`, { data: { enabled: true } }), member.request.get(`${base}/api/sandbox/instances`), member.request.put(`${base}/api/sandbox/provider-policy`, { data: { orgDefault: "local", allowProjectOverride: true } }), member.request.post(`${base}/api/sandbox/providers/opensandbox/test`, { data: { kind: "health" } })]);
	check("[real] member API: providers / update / instances / policy write / test all 403", mApi.every((r) => r.status() === 403), mApi.map((r) => r.status()).join(","));

	// save with a key through the UI
	await admin.goto(`${base}/admin?tab=sandbox`);
	await admin.waitForSelector('[data-testid="sandbox-admin"]');
	check("[real] admin: section, 3 cards, secret storage available", (await admin.locator('[data-testid^="provider-"]').count()) === 3 && (await admin.locator('[data-testid="secret-missing"]').count()) === 0);
	const card = admin.locator('[data-testid="provider-opensandbox"]');
	await card.locator('[data-testid="opensandbox-endpoint"]').fill("http://opensandbox.example.com:8080");
	await card.locator('[data-testid="opensandbox-template"]').fill("workroom-base");
	await card.locator('[data-testid="opensandbox-apikey"]').fill(KEY);
	await card.locator('[data-testid="opensandbox-save"]').click();
	await admin.waitForSelector('[data-testid="opensandbox-key-saved"]', { timeout: 15000 }).catch(() => {});
	const savedTxt = await card.locator('[data-testid="opensandbox-key-saved"]').innerText().catch(() => "");
	check("[real] saved key shown only as 已保存 ••••<last4>", savedTxt.includes("已保存") && savedTxt.includes(KEY.slice(-4)), savedTxt);
	await admin.reload();
	await admin.waitForSelector('[data-testid="sandbox-admin"]');
	const html = await admin.content();
	const api1 = await (await admin.request.get(`${base}/api/sandbox/providers`)).text();
	const inputs = await admin.evaluate(() => [...document.querySelectorAll("input")].map((i) => i.value).join("|"));
	check("[real] key string absent from page HTML, input values, API responses seen by the browser", !html.includes(KEY) && !inputs.includes(KEY) && !api1.includes(KEY) && leaks.length === 0, leaks.join(","));
	// clear key
	await card.locator('[data-testid="opensandbox-key-clear"]').click();
	await card.locator('[data-testid="opensandbox-save"]').click();
	await admin.waitForSelector('[data-testid="opensandbox-apikey"]', { timeout: 15000 }).catch(() => {});
	const afterClear = (await j(await admin.request.get(`${base}/api/sandbox/providers`))).body;
	check("[real] cleared key: apiKeySet false, field empty again", afterClear?.providers?.find((p) => p.provider === "opensandbox")?.apiKeySet === false && (await card.locator('[data-testid="opensandbox-apikey"]').count()) === 1);
	// egress
	const e2b = admin.locator('[data-testid="provider-e2b"]');
	await e2b.locator('[data-testid="e2b-enabled"]').check();
	check("[real] E2B: enabling without acknowledgement is blocked in the UI", (await e2b.locator('[data-testid="e2b-save"]').isDisabled()) && (await e2b.locator('[data-testid="e2b-need-egress"]').count()) === 1);
	const noAck = await j(await admin.request.put(`${base}/api/sandbox/providers/e2b`, { data: { enabled: true, egressAcknowledged: false } }));
	const noAckD = await j(await admin.request.put(`${base}/api/sandbox/providers/daytona`, { data: { enabled: true, egressAcknowledged: false } }));
	check("[real] E2B and Daytona: server also refuses enabling without acknowledgement (4xx)", noAck.status >= 400 && noAck.status < 500 && noAckD.status >= 400 && noAckD.status < 500, `${noAck.status}/${noAckD.status}`);
	await shotR(admin, "admin-sandbox-real-egress");
	// SSRF
	await admin.goto(`${base}/admin?tab=sandbox`);
	await admin.waitForSelector('[data-testid="sandbox-admin"]');
	await card.locator('[data-testid="opensandbox-endpoint"]').fill("http://127.0.0.1:9");
	await card.locator('[data-testid="opensandbox-enabled"]').check();
	await card.locator('[data-testid="opensandbox-save"]').click();
	await admin.waitForTimeout(1500);
	const ssrfMsg = (await card.locator('[role="alert"]').allInnerTexts()).join(" ");
	const ssrfApi = await j(await admin.request.put(`${base}/api/sandbox/providers/opensandbox`, { data: { enabled: true, endpoint: "http://127.0.0.1:9" } }));
	check("[real] 127.0.0.1 endpoint without allowance is refused with a plain message (API 4xx + shown in the card)", ssrfApi.status >= 400 && ssrfApi.status < 500 && ssrfMsg.length > 0, `${ssrfApi.status} ${ssrfMsg}`);
	await shotR(admin, "admin-sandbox-real-ssrf");
	// unreachable endpoint (allowed private) → test fails, default unchanged
	const allow = await j(await admin.request.put(`${base}/api/sandbox/providers/opensandbox`, { data: { enabled: true, endpoint: "http://127.0.0.1:9", allowPrivateNetwork: true } }));
	if (allow.status >= 400) {
		skip("[real] unreachable endpoint → failure, no fallback", `server refuses loopback even with the per-provider allowance (${allow.status}: needs the server-side allow switch; set WORKROOM_SANDBOX_ALLOW_PRIVATE)`);
	} else {
		await admin.request.put(`${base}/api/sandbox/provider-policy`, { data: { orgDefault: "opensandbox", allowProjectOverride: false } });
		await admin.goto(`${base}/admin?tab=sandbox`);
		await admin.waitForSelector('[data-testid="sandbox-admin"]');
		await card.locator('[data-testid="opensandbox-test-health"]').click();
		await admin.waitForSelector('[data-testid="opensandbox-test-result"][data-ok="false"], [data-testid="opensandbox-test-error"]', { timeout: 30000 });
		const failTxt = await card.locator('[data-testid="opensandbox-test"]').innerText();
		check("[real] unreachable endpoint → plain failure, default still opensandbox, unhealthy banner (no fallback)", failTxt.includes("失败") && (await admin.locator("#org-default").inputValue()) === "opensandbox" && (await admin.locator('[data-testid="default-unhealthy"]').count()) === 1, failTxt.slice(0, 80));
		await shotR(admin, "admin-sandbox-real-test-failed");
	}
	// project override
	const proj = await (await admin.request.post(`${base}/api/projects`, { data: { name: "运行位置项目" } })).json();
	const pid = proj.project?.id ?? proj.id;
	await admin.request.put(`${base}/api/sandbox/provider-policy`, { data: { orgDefault: "local", allowProjectOverride: false } });
	await admin.goto(`${base}/projects/${pid}`);
	await admin.waitForSelector("h1");
	const hidden = (await admin.locator('[data-testid="project-sandbox"]').count()) === 0;
	await admin.request.put(`${base}/api/sandbox/provider-policy`, { data: { orgDefault: "local", allowProjectOverride: true } });
	await admin.goto(`${base}/projects/${pid}`);
	await admin.waitForSelector('[data-testid="project-sandbox"]');
	await shotR(admin, "project-sandbox-override");
	const memberPut = await member.request.put(`${base}/api/projects/${pid}/sandbox-provider`, { data: { provider: "opensandbox" } });
	check("[real] project override: hidden when not allowed, shown to the project owner when allowed, non-member refused by the API", hidden && memberPut.status() >= 400, `member PUT ${memberPut.status()}`);
	await mCtx.close();
}

// ---------- C. live roundtrip ----------
const LIVE_URL = process.env.WORKROOM_TEST_OPENSANDBOX_URL;
if (!LIVE_URL || !real) {
	skip("[live] OpenSandbox roundtrip", !LIVE_URL ? "WORKROOM_TEST_OPENSANDBOX_URL not set (no real OpenSandbox available)" : "server routes absent");
} else {
	const put = await admin.request.put(`${base}/api/sandbox/providers/opensandbox`, { data: { enabled: true, endpoint: LIVE_URL, allowPrivateNetwork: true, ...(process.env.WORKROOM_TEST_OPENSANDBOX_KEY ? { apiKey: process.env.WORKROOM_TEST_OPENSANDBOX_KEY } : {}) } });
	await admin.goto(`${base}/admin?tab=sandbox`);
	await admin.waitForSelector('[data-testid="sandbox-admin"]');
	const c = admin.locator('[data-testid="provider-opensandbox"]');
	await c.locator('[data-testid="opensandbox-test-roundtrip"]').click();
	await admin.waitForSelector('[data-testid="opensandbox-test-result"]', { timeout: 120000 });
	const ok = (await c.locator('[data-testid="opensandbox-test-result"]').getAttribute("data-ok")) === "true";
	check("[live] OpenSandbox full roundtrip passes (create, exec, file, destroy)", put.status() < 400 && ok, (await c.locator('[data-testid="opensandbox-test"]').innerText()).slice(0, 200));
	await shotR(admin, "admin-sandbox-live-roundtrip");
}

console.log(`\n${skipped} step(s) skipped with explicit reasons (not counted as passed).`);
const ok = summary(join(SHOTS, "round7", "round7-sandbox.json"));
await browser.close();
await server.stop();
process.exitCode = ok ? 0 : 1;
