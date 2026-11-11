// Round 8 (Q2) · the cloud button (执行环境) and the inline "正在准备工作环境…" status.
//  A. REAL server, local driver:   button on home + conversation (1440 / 390), popover content, keyboard open/close/focus return, no instance by opening it or by a plain chat.
//  B. REAL server, remote provider pointing at an UNREACHABLE endpoint (config is real, the provider is not): GET never connects; 现在准备 really fails; failure line + 重试 + status
//     (this is the real failure path; nothing is mocked).
//  C. INTERCEPTED [intercepted]: GET/POST of the environment are route-mocked to a scripted sequence none → preparing → ready, and failed → 重试 → ready (UI behaviour only).
//  D. LIVE (WORKROOM_TEST_OPENSANDBOX_URL / _KEY set): a real OpenSandbox; plain chat + opening the popover create nothing; a sandbox tool call shows preparing → ready for real.
//     Skipped with a reason otherwise — never faked.
// Run: npm run build:web && node web/e2e/round8-env.mjs        (port 8912; Q2_WEB_DIST=<dir> to serve another build)
import { check, chromium, register, ROOT, sendMessage, sleep, startServer, summary, SHOTS } from "./lib.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

mkdirSync(join(SHOTS, "round8"), { recursive: true });
const PORT = 8912;
const LIVE_URL = process.env.WORKROOM_TEST_OPENSANDBOX_URL;
const LIVE_KEY = process.env.WORKROOM_TEST_OPENSANDBOX_KEY;
const server = await startServer({
	port: PORT,
	env: { WORKROOM_SECRET_KEY: "round8-e2e-secret-key-0123456789abcdef", WORKROOM_WEBHOOK_ALLOWLIST: "127.0.0.1", ...(process.env.Q2_WEB_DIST ? { WORKROOM_WEB_DIST: process.env.Q2_WEB_DIST } : {}) },
});
const base = server.base;
const browser = await chromium.launch();
let skipped = 0;
const skip = (name, why) => {
	skipped++;
	console.log(`SKIP  ${name}  — ${why}`);
};
const shotR = (page, name) => page.screenshot({ path: join(SHOTS, "round8", `q2-${name}.png`), fullPage: false });
const newCtx = (w = 1440, h = 900, scheme = "light") => browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w < 500 ? 2 : 1, colorScheme: scheme, locale: "zh-CN" });
const idle = (page, t = 90000) => page.waitForSelector('[data-testid="stop"]', { state: "detached", timeout: t });
const directive = (tool, args) => `[[call ${tool} ${JSON.stringify(args)}]]`;
const instances = async (page) => (await (await page.request.get(`${base}/api/sandbox/instances`)).json()).instances ?? [];
const envUrl = /\/api\/conversations\/[^/]+\/[^/]+\/environment(\/prepare)?$/;

process.on("uncaughtException", async (e) => {
	console.error(e);
	await server.stop().catch(() => {});
	process.exit(1);
});

const ctx = await newCtx();
const page = await ctx.newPage();
const reqLog = [];
page.on("request", (r) => envUrl.test(new URL(r.url()).pathname + "") && reqLog.push(`${r.method()} ${new URL(r.url()).pathname}`));
await register(page, base, { email: "owner-r8q2@example.com", name: "管理员" });

// ================================================================== A. local driver, real server
{
	const btn = page.locator('[data-testid="env-button"]');
	await btn.waitFor({ timeout: 15000 });
	const label = (await btn.getAttribute("aria-label")) ?? "";
	check("A home: cloud button next to the composer, aria-label '执行环境：<label>'", /^执行环境：.+/.test(label), label);
	const kind = await btn.getAttribute("data-env-kind");
	check("A home: local environment uses the local icon variant (kind local/none, not remote)", kind === "local" || kind === "none", `kind=${kind}`);
	const box = await btn.boundingBox();
	check("A home: button is compact and a comfortable target (>=36px, <=44px)", box && box.width >= 36 && box.width <= 44, JSON.stringify(box));

	// keyboard: Enter opens, Escape closes, focus returns
	await btn.focus();
	await page.keyboard.press("Enter");
	await page.waitForSelector('[data-testid="env-popover"]');
	const t = await page.locator('[data-testid="env-popover"]').innerText();
	check("A popover: current environment, location badge 本服务器, network, state, options", t.includes("当前执行环境") && (await page.locator('[data-testid="env-location"]').innerText()).includes("本服务器") && /可联网|不联网/.test(await page.locator('[data-testid="env-network"]').innerText()) && (await page.locator('[data-testid="env-state"]').count()) === 1 && (await page.locator('[data-testid="env-options"] li').count()) >= 1, t.replace(/\s+/g, " ").slice(0, 200));
	check("A popover: exactly one option is current; personal space cannot choose and says why", (await page.locator('[data-testid="env-options"] li[data-current="true"]').count()) === 1 && (await page.locator('[data-testid="env-choose-hint"]').innerText()).includes("组织") && (await page.locator('[data-testid^="env-switch-"]').count()) === 0);
	check("A popover: no 现在准备 / 重试 for a local environment (nothing to prepare)", (await page.locator('[data-testid="env-prepare"]').count()) === 0);
	check("A popover: admin sees 管理执行环境 → admin 运行环境 tab", (await page.locator('[data-testid="env-admin-link"]').getAttribute("href")) === "/admin?tab=sandbox");
	await shotR(page, "popover-local-1440");
	await page.keyboard.press("Escape");
	await page.waitForSelector('[data-testid="env-popover"]', { state: "detached" });
	check("A keyboard: Escape closes the popover and focus returns to the button", await btn.evaluate((el) => document.activeElement === el));
	await shotR(page, "home-1440");

	// opening it created nothing and never asked for a prepare
	check("A opening the popover creates no sandbox instance and sends no prepare", (await instances(page)).length === 0 && !reqLog.some((l) => l.startsWith("POST")), reqLog.join(" | "));

	// a plain chat turn
	await sendMessage(page, "你好，介绍一下你自己");
	await page.waitForURL(/\/c\//);
	await page.waitForSelector('[data-testid="assistant-message"]', { timeout: 60000 });
	await idle(page);
	check("A plain chat: still no sandbox instance and no prepare request", (await instances(page)).length === 0 && !reqLog.some((l) => l.startsWith("POST")));
	check("A conversation: the same button sits next to the composer; no status line for a local environment", (await page.locator('[data-testid="env-button"]').count()) === 1 && (await page.locator('[data-testid="env-status"]').count()) === 0);
	await shotR(page, "conversation-1440");
}
const chatUrl = page.url();
const [spaceId, convId] = new URL(chatUrl).pathname.split("/").slice(2, 4);

// phone
{
	const pc = await newCtx(390, 844);
	const pp = await pc.newPage();
	await pp.goto(`${base}/login`);
	await pp.fill("#email", "owner-r8q2@example.com");
	await pp.fill("#password", "password123");
	await pp.click('button[type="submit"]');
	await pp.waitForSelector('[data-testid="home-greeting"]');
	await pp.waitForSelector('[data-testid="env-button"]');
	const noScroll = async () => pp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
	const b = await pp.locator('[data-testid="env-button"]').boundingBox();
	check("A phone 390 home: button visible, >=40px target, inside the viewport, no horizontal scroll", b && b.width >= 40 && b.x >= 0 && b.x + b.width <= 390 && (await noScroll()), JSON.stringify(b));
	await pp.locator('[data-testid="env-button"]').click();
	await pp.waitForSelector('[data-testid="env-popover"]');
	const pb = await pp.locator('[data-testid="env-popover"]').boundingBox();
	check("A phone 390: popover fits the screen (>=8px gutters)", pb && pb.x >= 8 && pb.x + pb.width <= 382 && pb.y >= 0 && pb.y + pb.height <= 844, JSON.stringify(pb));
	await shotR(pp, "popover-local-390");
	await pp.keyboard.press("Escape");
	await pp.goto(chatUrl);
	await pp.waitForSelector('[data-testid="env-button"]');
	check("A phone 390 conversation: button present, no horizontal scroll", (await pp.locator('[data-testid="env-button"]').count()) === 1 && (await noScroll()));
	await shotR(pp, "conversation-390");
	await pc.close();
}

// ================================================================== B. remote provider configured, endpoint unreachable (real failure path)
{
	const ok = async (p, path, data) => (await p.request.put(`${base}${path}`, { data })).status();
	const s1 = await ok(page, "/api/sandbox/driver", { network: "allowed" });
	const s2 = await ok(page, "/api/sandbox/providers/opensandbox", { enabled: true, endpoint: "http://127.0.0.1:9", apiKey: "sk-e2e-unreachable-0123456789", allowPrivateNetwork: true, egressAcknowledged: true });
	const s3 = await ok(page, "/api/sandbox/provider-policy", { orgDefault: "opensandbox", allowProjectOverride: false });
	check("B setup: org default = a remote OpenSandbox whose endpoint is unreachable", s1 === 200 && s2 === 200 && s3 === 200, `${s1}/${s2}/${s3}`);
	reqLog.length = 0;
	await page.goto(chatUrl);
	const btn = page.locator('[data-testid="env-button"]');
	await btn.waitFor();
	await page.waitForFunction(() => document.querySelector('[data-testid="env-button"]')?.getAttribute("data-env-kind") === "remote");
	check("B remote: cloud icon variant, aria-label names the provider", (await btn.getAttribute("data-env-kind")) === "remote" && /^执行环境：OpenSandbox/.test((await btn.getAttribute("aria-label")) ?? ""));
	check("B remote: just opening the conversation did not connect or create anything (state none, no status line, no POST)", (await btn.getAttribute("data-env-state")) === "none" && (await page.locator('[data-testid="env-status"]').count()) === 0 && !reqLog.some((l) => l.startsWith("POST")) && (await instances(page)).length === 0);
	await btn.click();
	await page.waitForSelector('[data-testid="env-popover"]');
	check("B popover: 自托管 badge, network 可联网, state line says it is created on first need, 现在准备 offered", (await page.locator('[data-testid="env-location"]').innerText()).includes("自托管") && (await page.locator('[data-testid="env-network"]').innerText()).includes("可联网") && (await page.locator('[data-testid="env-state"]').innerText()).includes("第一次需要运行代码时") && (await page.locator('[data-testid="env-prepare"]').innerText()).includes("现在准备"));
	await shotR(page, "popover-remote-none-1440");
	await page.locator('[data-testid="env-prepare"]').click();
	await page.waitForFunction(() => document.querySelector('[data-testid="env-state"]')?.getAttribute("data-state") === "failed", null, { timeout: 60000 });
	const failText = await page.locator('[data-testid="env-state"]').innerText();
	check("B real failure: popover shows 准备失败 with the provider error and 重试; no silent fallback to local", failText.includes("准备失败") && /不会回退到本机|无法|失败/.test(failText) && (await page.locator('[data-testid="env-prepare"]').innerText()).includes("重试"), failText.replace(/\s+/g, " ").slice(0, 200));
	check("B failed: a dot marks the button", (await page.locator('[data-testid="env-dot"]').count()) === 1 && (await btn.getAttribute("data-env-state")) === "failed");
	await shotR(page, "popover-remote-failed-1440");
	await page.keyboard.press("Escape");
	const st = page.locator('[data-testid="env-status"]');
	await st.waitFor();
	const stText = await st.innerText();
	check("B conversation shows the failure line with 重试 (not hidden, not blocking the composer)", stText.includes("工作环境没有准备好") && (await page.locator('[data-testid="env-retry"]').count()) === 1 && (await page.locator('[data-testid="composer-input"]').isEnabled()), stText.replace(/\s+/g, " ").slice(0, 160));
	await shotR(page, "status-failed-1440");
	// retry really retries (and fails again: still unreachable)
	reqLog.length = 0;
	await page.locator('[data-testid="env-retry"]').click();
	await page.waitForFunction(() => document.querySelector('[data-testid="env-status"]')?.getAttribute("data-state") === "failed" || !document.querySelector('[data-testid="env-status"]'), null, { timeout: 60000 });
	await sleep(500);
	check("B 重试 sends exactly one explicit prepare request", reqLog.filter((l) => l.startsWith("POST") && l.endsWith("/prepare")).length === 1, reqLog.join(" | "));
	// phone: failure line
	const pc = await newCtx(390, 844);
	const pp = await pc.newPage();
	await pp.goto(`${base}/login`);
	await pp.fill("#email", "owner-r8q2@example.com");
	await pp.fill("#password", "password123");
	await pp.click('button[type="submit"]');
	await pp.waitForSelector('[data-testid="home-greeting"]');
	await pp.goto(chatUrl);
	await pp.waitForSelector('[data-testid="env-status"]');
	check("B phone 390: failure line fits (no horizontal scroll)", await pp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
	await shotR(pp, "status-failed-390");
	await pc.close();
	// a plain chat still works and still creates nothing while the environment is broken
	await sendMessage(page, "再聊一句，不需要运行代码");
	await page.waitForSelector('[data-testid="assistant-message"]:nth-of-type(2), [data-testid="assistant-message"]');
	await idle(page);
	check("B plain chat while the environment is failed: sends fine, creates no sandbox instance", (await instances(page)).filter((i) => i.state === "creating" || i.state === "ready").length === 0);
}

// ================================================================== C. intercepted state sequences
{
	const dto = (over = {}) => ({ kind: "remote", id: "opensandbox", label: "OpenSandbox（自托管）", location: "self_hosted", isolation: "代码在远端沙箱中执行。未隔离/限制：无网络依赖提供方。", network: "allowed", state: "none", options: [{ id: "opensandbox", label: "OpenSandbox（自托管）", current: true, enabled: true }], canChoose: false, chooseHint: "由组织管理员统一设置", canPrepare: true, ...over });
	// the intercepted UI sequence runs a real (local) sandbox call to keep the turn busy: back to the local driver for this part
	await page.request.put(`${base}/api/sandbox/provider-policy`, { data: { orgDefault: "local", allowProjectOverride: false } });
	const ic = await newCtx();
	const p = await ic.newPage();
	await p.goto(`${base}/login`);
	await p.fill("#email", "owner-r8q2@example.com");
	await p.fill("#password", "password123");
	await p.click('button[type="submit"]');
	await p.waitForSelector('[data-testid="home-greeting"]');

	// C1: none → (turn running) → preparing ×N → ready, auto-hiding line
	let phase = "none";
	let gets = 0;
	const posts = [];
	await p.route(envUrl, (r) => {
		if (r.request().method() === "POST") {
			posts.push(r.request().url());
			phase = "ready";
			return r.fulfill({ json: dto({ state: "ready" }) });
		}
		gets++;
		return r.fulfill({ json: dto({ state: phase }) });
	});
	await p.goto(chatUrl);
	await p.waitForSelector('[data-testid="env-button"]');
	check("C1 [intercepted] idle conversation, state none: no status line and (after 6s) no polling", (await p.locator('[data-testid="env-status"]').count()) === 0 && (await (async () => {
		const g0 = gets;
		await sleep(6000);
		return gets === g0;
	})()));
	// a running turn with a sandbox call (sleep keeps the turn busy so the poll can observe state)
	await sendMessage(p, `跑一下 ${directive("sandbox_exec", { language: "shell", code: "sleep 7; echo done" })}`);
	await p.waitForSelector('[data-testid="stop"]', { timeout: 20000 });
	await sleep(3200);
	phase = "preparing";
	await p.waitForSelector('[data-testid="env-status"][data-state="preparing"]', { timeout: 15000 });
	check("C1 [intercepted] while the turn runs and the state turns preparing: '正在准备工作环境…' appears, button marked", (await p.locator('[data-testid="env-status"]').innerText()).includes("正在准备工作环境…") && (await p.locator('[data-testid="env-button"]').getAttribute("data-env-state")) === "preparing");
	await shotR(p, "status-preparing-1440");
	await p.locator('[data-testid="env-button"]').click();
	check("C1 [intercepted] popover during preparing: state line says 正在准备工作环境…, no 重试 button", (await p.locator('[data-testid="env-state"]').innerText()).includes("正在准备工作环境…") && (await p.locator('[data-testid="env-prepare"]').count()) === 0);
	await p.keyboard.press("Escape");
	phase = "ready";
	await p.waitForSelector('[data-testid="env-status"]', { state: "detached", timeout: 15000 });
	check("C1 [intercepted] ready: the line hides by itself", (await p.locator('[data-testid="env-button"]').getAttribute("data-env-state")) === "ready");
	await idle(p, 60000).catch(() => {});
	const g1 = gets;
	await sleep(6000);
	check("C1 [intercepted] polling stopped once ready (no GET for 6s)", gets === g1, `${gets - g1} extra GETs`);
	check("C1 [intercepted] nothing in this sequence sent a prepare", posts.length === 0);

	// C2: failed → 重试 → ready
	phase = "failed";
	await p.unroute(envUrl);
	let failedPhase = true;
	const posts2 = [];
	await p.route(envUrl, (r) => {
		if (r.request().method() === "POST") {
			posts2.push(1);
			failedPhase = false;
			return r.fulfill({ json: dto({ state: "ready" }) });
		}
		return r.fulfill({ json: failedPhase ? dto({ state: "failed", error: "沙箱提供方 OpenSandbox 创建沙箱失败：创建超时（60 秒）（不会回退到本机执行）。这是一段比较长的说明：提供方返回了很多细节，包括请求编号、排队位置和超时阈值，所以需要“详情”按钮才能看到全部内容，用来检查“详情”按钮。" }) : dto({ state: "ready" }) });
	});
	await p.goto(chatUrl);
	const st = p.locator('[data-testid="env-status"]');
	await st.waitFor();
	check("C2 [intercepted] failure line: message, 重试, 详情 for a long error", (await st.innerText()).includes("创建超时") && (await p.locator('[data-testid="env-retry"]').count()) === 1 && (await p.locator('[data-testid="env-detail"]').count()) === 1);
	await p.locator('[data-testid="env-detail"]').click();
	check("C2 [intercepted] 详情 expands the full error", (await st.innerText()).includes("所以需要“详情”按钮才能看到全部内容"));
	check("C2 [intercepted] no automatic prepare before 重试", posts2.length === 0);
	await p.locator('[data-testid="env-retry"]').click();
	await p.waitForSelector('[data-testid="env-status"]', { state: "detached", timeout: 10000 });
	check("C2 [intercepted] 重试 → exactly one prepare → line gone, state ready", posts2.length === 1 && (await p.locator('[data-testid="env-button"]').getAttribute("data-env-state")) === "ready");

	// C3: not retryable (misconfigured for this user): message + 联系管理员, never a retry button
	await p.unroute(envUrl);
	await p.route(envUrl, (r) => r.fulfill({ json: dto({ state: "failed", error: "执行环境未配置：请联系管理员", canPrepare: false }) }));
	await p.goto(chatUrl);
	await p.waitForSelector('[data-testid="env-status"]');
	check("C3 [intercepted] misconfiguration: plain message, 请联系管理员, no 重试", (await p.locator('[data-testid="env-status"]').innerText()).includes("执行环境未配置：请联系管理员") && (await p.locator('[data-testid="env-retry"]').count()) === 0);

	// C4: vendor cloud + switching allowed (project owner): honest badge, 切换 only on enabled non-current options
	await p.unroute(envUrl);
	await p.route(envUrl, (r) => r.fulfill({ json: dto({ location: "vendor_cloud", label: "E2B", id: "e2b", canChoose: true, chooseHint: undefined, options: [{ id: "local", label: "本机沙箱（Docker 容器）", current: false, enabled: true }, { id: "e2b", label: "E2B", current: true, enabled: true }, { id: "daytona", label: "Daytona", current: false, enabled: false }] }) }));
	await p.goto(chatUrl);
	await p.locator('[data-testid="env-button"]').click();
	await p.waitForSelector('[data-testid="env-popover"]');
	check("C4 [intercepted] vendor cloud badge says the data leaves the organisation", (await p.locator('[data-testid="env-location"]').innerText()).includes("数据会离开组织"));
	check("C4 [intercepted] canChoose: 切换 only for the enabled non-current option (local), none for the current or disabled one", (await p.locator('[data-testid="env-switch-local"]').count()) === 1 && (await p.locator('[data-testid="env-switch-e2b"]').count()) === 0 && (await p.locator('[data-testid="env-switch-daytona"]').count()) === 0);
	await shotR(p, "popover-vendor-choose-1440");
	await ic.close();
}

// ================================================================== D. LIVE OpenSandbox
if (!LIVE_URL || !LIVE_KEY) skip("D [live] OpenSandbox: preparing → ready during a real sandbox run", "WORKROOM_TEST_OPENSANDBOX_URL / WORKROOM_TEST_OPENSANDBOX_KEY not set");
else {
	const put = async (path, data) => (await page.request.put(`${base}${path}`, { data })).status();
	const a = await put("/api/sandbox/providers/opensandbox", { enabled: true, endpoint: LIVE_URL, apiKey: LIVE_KEY, allowPrivateNetwork: true, egressAcknowledged: true });
	const pol = await put("/api/sandbox/provider-policy", { orgDefault: "opensandbox", allowProjectOverride: false });
	check("D [live] provider configured against the real OpenSandbox and made the org default", a === 200 && pol === 200, `status ${a}/${pol}`);
	await page.goto(base);
	await page.waitForSelector('[data-testid="home-greeting"]');
	reqLog.length = 0;
	await page.locator('[data-testid="env-button"]').click();
	await page.waitForSelector('[data-testid="env-popover"]');
	check("D [live] opening the popover on home: 自托管, nothing created", (await page.locator('[data-testid="env-location"]').innerText()).includes("自托管") && (await instances(page)).filter((i) => i.state !== "error" && i.state !== "destroyed" && i.state !== "lost").length === 0);
	await page.keyboard.press("Escape");
	// plain chat first
	await sendMessage(page, "只是聊天，请回答：1+1 等于几？");
	await page.waitForURL(/\/c\//);
	await page.waitForSelector('[data-testid="assistant-message"]', { timeout: 60000 });
	await idle(page);
	const live0 = (await instances(page)).filter((i) => i.state === "creating" || i.state === "ready");
	check("D [live] a plain chat creates no remote sandbox (instance table has no live row)", live0.length === 0 && !reqLog.some((l) => l.startsWith("POST")), `${live0.length} live`);
	// a real sandbox tool call: sample the button state while it runs
	const samples = new Set();
	const apiStates = [];
	const t0 = Date.now();
	let sampling = true;
	const sampler = (async () => {
		while (sampling) {
			const s = await page.locator('[data-testid="env-button"]').getAttribute("data-env-state").catch(() => null);
			const line = (await page.locator('[data-testid="env-status"]').count()) ? ((await page.locator('[data-testid="env-status"]').innerText().catch(() => "")) || "") : "";
			if (s) samples.add(s);
			if (line.includes("正在准备工作环境…")) samples.add("line:preparing");
			await sleep(150);
		}
	})();
	// the server's own answer, sampled directly (the truth the UI polls): proves the state really was "preparing" while the real sandbox was created
	const [spaceId2, convId2] = new URL(page.url()).pathname.split("/").slice(2, 4);
	const apiSampler = (async () => {
		while (sampling) {
			const r = await page.request.get(`${base}/api/conversations/${spaceId2}/${convId2}/environment`).then((x) => x.json()).catch(() => null);
			if (r?.state && apiStates.at(-1)?.s !== r.state) apiStates.push({ s: r.state, at: Date.now() - t0 });
			await sleep(120);
		}
	})();
	await sendMessage(page, `在沙箱里跑一下 ${directive("sandbox_exec", { language: "shell", code: "echo live-env-ok; uname -s" })}`);
	await page.waitForSelector('[data-testid="stop"]', { timeout: 20000 });
	await page.waitForFunction(() => document.querySelector('[data-testid="env-button"]')?.getAttribute("data-env-state") === "ready", null, { timeout: 180000 });
	await idle(page, 180000);
	sampling = false;
	await sampler;
	await apiSampler;
	const seen = [...samples].join(",");
	const seq = apiStates.map((x) => x.s);
	check("D [live] the server reported none → preparing → ready while the real sandbox was created for the tool call (sampled directly from the API)", seq.includes("preparing") && seq.at(-1) === "ready" && seq.indexOf("preparing") < seq.lastIndexOf("ready"), JSON.stringify(apiStates));
	check("D [live] the UI followed: button reached ready, and (if the window was long enough for its 1 s poll) showed preparing + the inline line", samples.has("ready") && (samples.has("preparing") ? samples.has("line:preparing") : true), `UI observed: ${seen}`);
	check("D [live] exactly one live instance now, and the run output arrived", (await instances(page)).filter((i) => i.state === "ready").length === 1 && (await page.locator('[data-testid="assistant-message"]').last().isVisible()));
	await shotR(page, "live-ready-1440");
	// clean up the real sandbox
	try {
		const { createRemoteProvider } = await import(join(ROOT, "server/src/tools/sandbox/providers/index.ts"));
		const prov = await createRemoteProvider({ provider: "opensandbox", endpoint: LIVE_URL, apiKey: LIVE_KEY });
		for (const i of await instances(page)) if (i.remoteId && (i.state === "ready" || i.state === "creating")) await prov.destroy(i.remoteId).catch(() => {});
	} catch (e) {
		console.log(`NOTE  live sandbox cleanup skipped (${String(e?.message ?? e).slice(0, 120)}); it expires by lifetime`);
	}
}

console.log(`\n${skipped} step(s) skipped with explicit reasons (not counted as passed).`);
const ok = summary(join(SHOTS, "round8", "q2-results.json"));
await browser.close();
await server.stop();
process.exitCode = ok ? 0 : 1;
