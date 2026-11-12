// Round 10 · the conversation environment button is two options (round 11: 本地环境 + 云端沙箱, both real) and the org has ONE active sandbox channel.
//  A. admin 沙箱 page (REAL server): 当前使用的沙箱渠道 is a single radio choice; choosing a provider deactivates the others; choosing 平台内置沙箱 deactivates all;
//     a provider that fails server validation shows the server's message and changes nothing; allowProjectOverride=true is refused; the project page has no picker.
//  B. the popover (REAL server): exactly two options (云端沙箱 / 本地环境) and nothing else — round 11 simplification (intentional): no backend name, state line,
//     working directory, admin link, 即将推出 or tooltip text; 本地环境 is enabled while the org switch is on (disabled case: round11-lifecycle.mjs); only a real failure adds one short line 「准备失败 · 重试」 (reason on hover).
//  Screenshots (artifacts/screenshots/round10/): popover at 1440 and 390, light and dark; the admin channel choice at 1440 and 390.
// Run: npm run build:web && node web/e2e/round10-env.mjs        (port 8952)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { check, chromium, register, shot, SHOTS, sleep, startServer, summary } from "./lib.mjs";

mkdirSync(join(SHOTS, "round10"), { recursive: true });
const PORT = 8952;
const KEY = "sk-e2e-round10-env-0123456789abcdef";
const server = await startServer({ port: PORT, env: { WORKROOM_SECRET_KEY: "round10-env-e2e-secret-key-0123456789abcdef", WORKROOM_WEBHOOK_ALLOWLIST: "127.0.0.1" } });
const base = server.base;
const browser = await chromium.launch();
const ctxOf = (w, scheme = "light", cookies) =>
	browser.newContext({ viewport: { width: w, height: w < 500 ? 844 : 900 }, deviceScaleFactor: w < 500 ? 2 : 1, colorScheme: scheme, locale: "zh-CN", ...(w < 500 ? { isMobile: true, hasTouch: true } : {}) }).then(async (c) => {
		if (cookies) await c.addCookies(cookies);
		return c;
	});
const shotR = (page, name) => shot(page, `round10/${name}`);
const envUrl = /\/api\/conversations\/[^/]+\/[^/]+\/environment(\/prepare)?$/;

process.on("uncaughtException", async (e) => {
	console.error(e);
	await server.stop().catch(() => {});
	process.exit(1);
});

try {
	const aCtx = await ctxOf(1440);
	const admin = await aCtx.newPage();
	const posts = [];
	admin.on("request", (r) => envUrl.test(new URL(r.url()).pathname) && r.method() === "POST" && posts.push(new URL(r.url()).pathname));
	await register(admin, base, { email: "owner-r10env@example.com", name: "管理员" });
	const apiPut = (path, data) => admin.request.put(`${base}${path}`, { data });
	const getAdmin = async () => (await admin.request.get(`${base}/api/sandbox/providers`)).json();
	const enabledIds = async () => (await getAdmin()).providers.filter((p) => p.enabled).map((p) => p.provider).join(",");
	const openAdmin = async (p = admin) => {
		await p.goto(`${base}/admin?tab=sandbox`);
		await p.waitForSelector('[data-testid="sandbox-channel"]');
	};

	// ================================================================ A. one active channel (admin)
	await openAdmin();
	check("A tab is called 沙箱 and the section 当前使用的沙箱渠道 is one radio group: 平台内置沙箱 + OpenSandbox + E2B + Daytona", (await admin.locator('[data-testid="admin-tab-sandbox"]').innerText()).includes("沙箱") && (await admin.locator('[data-testid="sandbox-channel"]').innerText()).includes("当前使用的沙箱渠道") && (await admin.locator('[data-testid="sandbox-channel"] input[type="radio"]').count()) === 4);
	check("A fresh org: 平台内置沙箱 is chosen, no provider is active, nothing else to switch on or off", (await admin.locator('[data-testid="channel-local"] input').isChecked()) && (await enabledIds()) === "" && (await admin.locator('[data-testid="allow-override"], [data-testid^="provider-"] [data-testid$="-enabled"]').count()) === 0);
	check("A providers without a saved key cannot be chosen (disabled radio, with the reason)", (await admin.locator('[data-testid="channel-e2b"] input').isDisabled()) && (await admin.locator('[data-testid="channel-e2b"]').innerText()).includes("未配置密钥"));
	await shotR(admin, "admin-channel-1440-light");

	// keys saved WITHOUT enabled never change the channel
	const k1 = await apiPut("/api/sandbox/providers/e2b", { apiKey: KEY, egressAcknowledged: true, template: "base" });
	const k2 = await apiPut("/api/sandbox/providers/daytona", { apiKey: KEY, egressAcknowledged: true });
	const k3 = await apiPut("/api/sandbox/providers/opensandbox", { apiKey: KEY, endpoint: "http://127.0.0.1:9", allowPrivateNetwork: true });
	check("A saving a provider's settings (key, template, address) does not activate it", k1.ok() && k2.ok() && k3.ok() && (await enabledIds()) === "" && (await getAdmin()).policy.orgDefault === "local");

	await openAdmin();
	await admin.locator('[data-testid="channel-e2b"] input').click();
	await admin.waitForSelector('[data-testid="e2b-active"]', { timeout: 15000 });
	let st = await getAdmin();
	check("A choosing E2B: it is the only enabled provider and the org default; the card says 当前使用", (await enabledIds()) === "e2b" && st.policy.orgDefault === "e2b" && (await admin.locator('[data-testid="e2b-active"]').innerText()).includes("当前使用"));
	await admin.locator('[data-testid="channel-daytona"] input').click();
	await admin.waitForSelector('[data-testid="daytona-active"]', { timeout: 15000 });
	st = await getAdmin();
	check("A choosing Daytona deactivates E2B (which keeps its saved key and template)", (await enabledIds()) === "daytona" && st.policy.orgDefault === "daytona" && st.providers.find((p) => p.provider === "e2b").apiKeySet === true && st.providers.find((p) => p.provider === "e2b").template === "base" && (await admin.locator('[data-testid="e2b-inactive"]').count()) === 1);
	check("A the unhealthy-channel notice says there is no silent fallback (Daytona was never tested)", (await admin.locator('[data-testid="default-unhealthy"]').innerText()).includes("不会自动改用平台内置沙箱"));
	await shotR(admin, "admin-channel-daytona-1440-light");

	// a choice the server refuses: the message is shown and nothing changes
	await admin.locator('[data-testid="provider-opensandbox"] [data-testid="opensandbox-endpoint"]').fill("");
	await admin.locator('[data-testid="opensandbox-save"]').click();
	await sleep(600);
	await admin.locator('[data-testid="channel-opensandbox"] input').click();
	await admin.locator('[data-testid="sandbox-channel"] [role="alert"]', { hasText: "服务地址" }).waitFor({ timeout: 10000 });
	const refusedMsg = await admin.locator('[data-testid="sandbox-channel"] [role="alert"]').allInnerTexts();
	check("A OpenSandbox without an address is refused by the server; its message is shown and the active channel stays Daytona", refusedMsg.join(" ").includes("服务地址") && (await enabledIds()) === "daytona" && (await getAdmin()).policy.orgDefault === "daytona", refusedMsg.join(" ").slice(0, 100));
	// the active provider cannot be switched off from under the org
	const off = await apiPut("/api/sandbox/providers/daytona", { enabled: false });
	check("A the active provider cannot be disabled (409): choose another channel first", off.status() === 409 && (await off.text()).includes("active_provider") && (await enabledIds()) === "daytona");

	// OpenSandbox: give it an address, choose it (it points at an unreachable port: used below for the real failure path)
	const fix = await apiPut("/api/sandbox/providers/opensandbox", { endpoint: "http://127.0.0.1:9", allowPrivateNetwork: true });
	await openAdmin();
	await admin.locator('[data-testid="channel-opensandbox"] input').click();
	await admin.waitForSelector('[data-testid="opensandbox-active"]', { timeout: 15000 });
	check("A choosing OpenSandbox (address set): only it is enabled", fix.ok() && (await enabledIds()) === "opensandbox");
	await admin.locator('[data-testid="channel-local"] input').click();
	await admin.waitForSelector('[data-testid="channel-local"][data-active="true"]', { timeout: 15000 });
	check("A choosing 平台内置沙箱 deactivates every provider", (await enabledIds()) === "" && (await getAdmin()).policy.orgDefault === "local");
	const ov = await apiPut("/api/sandbox/provider-policy", { allowProjectOverride: true });
	check("A allowProjectOverride=true is refused; the policy always reports false", ov.status() === 400 && (await (await admin.request.get(`${base}/api/sandbox/provider-policy`)).json()).policy.allowProjectOverride === false);
	const proj = await (await admin.request.post(`${base}/api/projects`, { data: { kind: "space", name: "环境项目" } })).json();
	const pid = proj.project?.id;
	const pg = await admin.request.get(`${base}/api/projects/${pid}/sandbox-provider`);
	await admin.goto(`${base}/projects/${pid}`);
	await admin.waitForSelector("h1");
	await sleep(500);
	check("A the project page has no sandbox picker and the per-project endpoint is gone (404)", pg.status() === 404 && (await admin.locator('[data-testid="project-sandbox"]').count()) === 0);
	await openAdmin();
	await shotR(admin, "admin-channel-local-1440-light");
	const am = await ctxOf(390, "light", await aCtx.cookies());
	const amp = await am.newPage();
	await openAdmin(amp);
	check("A 390px admin: no horizontal scroll with the channel choice and cards", await amp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
	await shotR(amp, "admin-channel-390-light");
	await am.close();

	// ================================================================ B. the popover
	await admin.goto(base);
	await admin.waitForSelector('[data-testid="env-button"]');
	await admin.locator('[data-testid="env-button"]').click();
	await admin.waitForSelector('[data-testid="env-popover"]');
	await sleep(500);
	const pop = admin.locator('[data-testid="env-popover"]');
	const text = await pop.innerText();
	const kind = await admin.locator('[data-testid="env-button"]').getAttribute("data-env-kind");
	const popText = text.replace(/\s+/g, " ").trim();
	check("B local channel: popover says nothing but 本地环境 / 云端沙箱 (+ 准备失败 when the host has no driver); the backend name is only in the screen-reader text", (await pop.locator('[data-testid="env-cloud"]').count()) === 1 && (kind === "local" || kind === "none") && /^本地环境\s?云端沙箱\s?(准备失败)?$/.test(popText.replace(/\s?（[^）]*）/, "")), popText);
	check("B no state line unless something failed; never a 现在准备 button, no backend label", (await pop.locator('[data-testid="env-label"]').count()) === 0 && (await pop.locator('[data-testid="env-prepare"]').count()) === 0 && ((await pop.locator('[data-testid="env-state"]').count()) === 0 || /^准备失败/.test((await pop.locator('[data-testid="env-state"]').innerText()).trim())));
	const local = pop.locator('[data-testid="env-local"]');
	check("B [round 12] 本地环境 stays in place, greyed out (aria-disabled, not checked) — just those four characters, no 即将推出", (await local.getAttribute("aria-disabled")) === "true" && (await local.getAttribute("aria-checked")) === "false" && (await local.innerText()).trim() === "本地环境");
	await pop.locator('[data-testid="env-cloud"]').click();
	await admin.waitForFunction(() => document.querySelector('[data-testid="env-button"]')?.getAttribute("data-env-pref") === "cloud");
	// round 12/14: the greyed 本地环境 row is a placeholder — clicking it changes nothing (still 云端沙箱) and sends nothing
	await local.click({ force: true });
	await sleep(300);
	check("B on the home page (no conversation yet) choosing a row only switches the icon/pref in this tab; the greyed 本地环境 row changes nothing: popover stays open, no environment request sent", (await pop.locator('[data-testid="env-cloud"]').count()) === 1 && (await admin.locator('[data-testid="env-button"]').getAttribute("data-env-pref")) === "cloud" && posts.length === 0);
	await admin.mouse.move(5, 5); // the click above left the pointer on the element: move away, then hover for real
	await local.hover();
	await sleep(900); // tooltip delay is 400ms
	const tipTexts = await admin.evaluate(() => [...document.querySelectorAll('[role="tooltip"], [data-radix-popper-content-wrapper]')].map((e) => e.textContent ?? ""));
	check("B 本地环境 has no explaining tooltip (指你自己的电脑 / 还没有实现 are gone)", !tipTexts.join(" ").includes("指你自己的电脑") && !tipTexts.join(" ").includes("还没有实现"), JSON.stringify(tipTexts));
	check("B the clutter is gone: no isolation text, location/network badges, option list, 切换, project/conversation chooser hints, 详细说明", (await pop.locator('[data-testid="env-isolation"], [data-testid="env-isolation-full"], [data-testid="env-location"], [data-testid="env-network"], [data-testid="env-options"], [data-testid^="env-switch-"], [data-testid="env-choose-hint"], details').count()) === 0 && !/切换|数据会离开|详细说明|可用的执行环境/.test(text));
	check("B no working directory and no admin link in the popover (not even for an admin)", (await pop.locator('[data-testid="env-workdir"]').count()) === 0 && (await pop.locator('[data-testid="env-admin-link"]').count()) === 0 && !/工作目录|管理后台/.test(text));
	await shotR(admin, "popover-local-1440-light");
	await admin.keyboard.press("Escape");

	// a member sees the same popover without the admin link
	const inv = (await (await admin.request.post(`${base}/api/admin/invites`, { data: { role: "member", ttlHours: 24 } })).json()).invite.code;
	const mCtx = await ctxOf(1440);
	const member = await mCtx.newPage();
	await member.goto(`${base}/register?invite=${inv}`);
	await member.fill("#name", "成员乙");
	await member.fill("#email", "member-r10env@example.com");
	await member.fill("#password", "password123");
	await member.click('button[type="submit"]');
	await member.waitForSelector('[data-testid="home-greeting"]');
	await member.locator('[data-testid="env-button"]').click();
	await member.waitForSelector('[data-testid="env-popover"]');
	check("B a member sees the same two options: 云端沙箱 and 本地环境", (await member.locator('[data-testid="env-cloud"]').count()) === 1 && (await member.locator('[data-testid="env-local"]').count()) === 1 && (await member.locator('[data-testid="env-admin-link"]').count()) === 0);
	await mCtx.close();

	// real remote channel: OpenSandbox at an unreachable address
	const en = await apiPut("/api/sandbox/providers/opensandbox", { enabled: true });
	check("B OpenSandbox chosen as the channel (unreachable address: real failure path)", en.ok() && (await enabledIds()) === "opensandbox");
	await admin.goto(base);
	await admin.waitForSelector('[data-testid="env-button"]');
	const btn = admin.locator('[data-testid="env-button"]');
	check("B button: remote, nothing created just by showing it", (await btn.getAttribute("data-env-kind")) === "remote" && posts.length === 0);
	await btn.click();
	await admin.waitForSelector('[data-testid="env-popover"]');
	await sleep(500);
	check("B OpenSandbox: still just the two options — no backend label, no state line, no 现在准备 (nothing to retry yet), no working directory", (await pop.locator('[data-testid="env-label"]').count()) === 0 && (await pop.locator('[data-testid="env-state"]').count()) === 0 && (await pop.locator('[data-testid="env-prepare"]').count()) === 0 && (await pop.locator('[data-testid="env-workdir"]').count()) === 0);
	// the only way to a failure is a real attempt: ask the server to prepare the (unreachable) sandbox, as the first sandbox tool call would
	const spaceId = (await (await admin.request.get(`${base}/api/me`)).json()).personalSpaceId;
	await admin.request.post(`${base}/api/conversations/${spaceId}/new/environment/prepare`).catch(() => {});
	await admin.keyboard.press("Escape");
	await admin.goto(base);
	await admin.waitForSelector('[data-testid="env-button"]');
	await admin.locator('[data-testid="env-button"]').click();
	await admin.waitForSelector('[data-testid="env-popover"]');
	await admin.waitForFunction(() => document.querySelector('[data-testid="env-state"]')?.getAttribute("data-state") === "failed", null, { timeout: 60000 });
	const failText = (await pop.locator('[data-testid="env-state"]').innerText()).replace(/\s+/g, " ").trim();
	check("B a real failure: one short line 「准备失败」 + 重试 (the reason is on hover, not printed), a red dot on the button, never a fallback to the host", failText.replace(/\s?重试$/, "") === "准备失败" && (await pop.locator('[data-testid="env-prepare"]').innerText()).includes("重试") && (await pop.locator('[data-testid="env-state"] span[title]').getAttribute("title"))?.length > 4 && (await admin.locator('[data-testid="env-dot"]').count()) === 1, failText);
	await shotR(admin, "popover-failed-1440-light");
	await admin.keyboard.press("Escape");

	// [intercepted] a workDir in the environment data is NOT shown any more (round 11: the popover lists two options only)
	{
		const ic = await ctxOf(1440, "light", await aCtx.cookies());
		const p = await ic.newPage();
		await p.route(envUrl, async (r) => {
			const res = await r.fetch();
			const body = await res.json();
			await r.fulfill({ json: { ...body, kind: "remote", id: "e2b", label: "E2B", state: "ready", error: undefined, canPrepare: true, workDir: "/home/user/work" } });
		});
		await p.goto(base);
		await p.waitForSelector('[data-testid="env-button"]');
		await p.locator('[data-testid="env-button"]').click();
		await p.waitForSelector('[data-testid="env-popover"]');
		const ipText = (await p.locator('[data-testid="env-popover"]').innerText()).replace(/\s+/g, " ").trim();
		check("B [intercepted] a ready E2B channel with a workDir in the data: the popover still shows only 云端沙箱 / 本地环境 (no 工作目录, no E2B label, no 已就绪, no 重试 / 现在准备)", !/工作目录|\/home\/user\/work|已就绪|重试|现在准备/.test(ipText) && (await p.locator('[data-testid="env-workdir"], [data-testid="env-label"], [data-testid="env-state"], [data-testid="env-prepare"]').count()) === 0, ipText);
		await ic.close();
	}

	// ================================================================ screenshots: local channel again, 1440 / 390, light / dark
	await apiPut("/api/sandbox/provider-policy", { orgDefault: "local" });
	for (const [w, scheme] of [[1440, "light"], [1440, "dark"], [390, "light"], [390, "dark"]]) {
		const c = await ctxOf(w, scheme, await aCtx.cookies());
		const p = await c.newPage();
		await p.goto(base);
		await p.waitForSelector('[data-testid="env-button"]');
		await p.locator('[data-testid="env-button"]').click();
		await p.waitForSelector('[data-testid="env-popover"]');
		await sleep(600);
		const b = await p.locator('[data-testid="env-popover"]').boundingBox();
		const opaque = await p.locator('[data-testid="env-popover"]').evaluate((el) => {
			let o = 1;
			for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
			return o === 1;
		});
		check(`B ${w}px ${scheme}: popover fully opaque, inside the viewport with gutters, no horizontal scroll`, opaque && b && b.x >= 8 && b.x + b.width <= w - 8 && b.y >= 0 && (await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)), JSON.stringify(b));
		await shotR(p, `popover-${w}-${scheme}`);
		await c.close();
	}
	// the admin page in dark, for the single-choice section
	{
		const c = await ctxOf(1440, "dark", await aCtx.cookies());
		const p = await c.newPage();
		await openAdmin(p);
		await shotR(p, "admin-channel-1440-dark");
		await c.close();
	}
} finally {
	const ok = summary(join(SHOTS, "round10", "round10-env.json"));
	await browser.close();
	await server.stop();
	process.exitCode = ok ? 0 : 1;
}
