// Round 11 · R1 / R2a / R3 — the conversation environment button after the sandbox lifecycle: ONE status dot, two radio rows, no inline "preparing" line.
//  A. [intercepted] every environment state the DTO can carry → the dot (none/lost: none; preparing/resuming: pulsing; ready; paused: grey; failed: red), its aria-label names the
//     state, the popover fits at 390 / 1440 in light and dark (UI rendering only; nothing here claims a real sandbox).
//  B. REAL server, local driver (round 12): 本地环境 is greyed out with 本地应用上线后可用 on hover and cannot be chosen; the button and the server preference are
//     the cloud; choosing 云端沙箱 on the home page is kept in the tab; with the admin switch off it looks the same.
//  C. LIVE (WORKROOM_TEST_OPENSANDBOX_URL / _KEY set; skipped with a message otherwise, never faked): OpenSandbox chosen as the channel through the admin page, idle pause set to the
//     server's minimum (60 s), click 云端沙箱 → the dot goes preparing → ready with no line in the chat; a plain chat creates nothing; the reaper (60 s tick) pauses the idle
//     sandbox → grey dot; a sandbox_exec through the fixture model resumes the SAME sandbox (same remote id, one create, one resume in the lifecycle stats).
// Run: npm run build:web && node web/e2e/round11-lifecycle.mjs        (port 8976; the live part takes about 3 minutes: it waits for the real reaper, bounded)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { check, chromium, register, ROOT, sendMessage, shot, sleep, startServer, summary, SHOTS } from "./lib.mjs";

mkdirSync(join(SHOTS, "round11"), { recursive: true });
const PORT = 8976;
const LIVE_URL = process.env.WORKROOM_TEST_OPENSANDBOX_URL;
const LIVE_KEY = process.env.WORKROOM_TEST_OPENSANDBOX_KEY;
const server = await startServer({ port: PORT, env: { WORKROOM_SECRET_KEY: "round11-lifecycle-e2e-secret-key-0123456789ab", WORKROOM_WEBHOOK_ALLOWLIST: "127.0.0.1" } });
const base = server.base;
const browser = await chromium.launch();
const T = (id) => `[data-testid="${id}"]`;
const shotR = (page, name) => shot(page, `round11/${name}`);
const envUrl = /\/api\/conversations\/[^/]+\/[^/]+\/environment(\/prepare)?$/;
const directive = (tool, args) => `[[call ${tool} ${JSON.stringify(args)}]]`;
const idle = (page, t = 120000) => page.waitForSelector(T("stop"), { state: "detached", timeout: t });
const ctxOf = async (w, scheme = "light", cookies) => {
	const c = await browser.newContext({ viewport: { width: w, height: w < 500 ? 844 : 900 }, deviceScaleFactor: w < 500 ? 2 : 1, colorScheme: scheme, locale: "zh-CN", ...(w < 500 ? { isMobile: true, hasTouch: true } : {}) });
	if (cookies) await c.addCookies(cookies);
	return c;
};
let skipped = 0;
const skip = (name, why) => {
	skipped++;
	console.log(`SKIP  ${name}  — ${why}`);
};

process.on("uncaughtException", async (e) => {
	console.error(e);
	await server.stop().catch(() => {});
	process.exit(1);
});

const aCtx = await ctxOf(1440);
const page = await aCtx.newPage();
await register(page, base, { email: "owner-r11life@example.com", name: "管理员" });
const cookies = await aCtx.cookies();
const api = (path, init) => page.request.fetch(`${base}/api${path}`, init);
const json = async (path, init) => (await api(path, init)).json();
async function newConversation() {
	const c = await json("/conversations", { method: "POST", data: {} });
	return { spaceId: c.conversation.spaceId, id: c.conversation.conversationId, url: `${base}/c/${c.conversation.spaceId}/${c.conversation.conversationId}` };
}
const noHScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1);
const opaque = (loc) =>
	loc.evaluate((el) => {
		let o = 1;
		for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
		return o === 1;
	});
const popText = async (p) => (await p.locator(T("env-popover")).innerText()).replace(/\s+/g, " ").trim();

// ================================================================== A. intercepted: one dot per state
{
	const conv = await newConversation();
	const dto = (over = {}) => ({
		kind: "remote", id: "opensandbox", label: "OpenSandbox（自托管）", location: "self_hosted", isolation: "代码在远端沙箱中执行。", network: "allowed", state: "none", canPrepare: true,
		local: { enabled: true, connected: false, preference: "local" }, ...over,
	});
	const LONG = "沙箱提供方 OpenSandbox 创建沙箱失败：创建超时（60 秒）（不会回退到本机执行）。这是一段比较长的说明，提供方返回了很多细节，包括请求编号、排队位置和超时阈值。";
	// state → [dot expected?, label in aria-label, class fragment]
	const table = [
		["none", null, null, null],
		["lost", null, null, null],
		["preparing", "preparing", "准备中", "wr-pulse"],
		["resuming", "resuming", "恢复中", "wr-pulse"],
		["ready", "ready", "就绪", "bg-success"],
		["paused", "paused", "已暂停", "bg-fg-subtle"],
		["failed", "failed", "准备失败", "bg-danger"],
	];
	const ic = await ctxOf(1440, "light", cookies);
	const p = await ic.newPage();
	let current = dto();
	const posts = [];
	await p.route(envUrl, (r) => {
		if (r.request().method() === "POST") {
			posts.push(r.request().postData());
			return r.fulfill({ json: dto({ state: "ready" }) });
		}
		return r.fulfill({ json: current });
	});
	for (const [state, dot, label, cls] of table) {
		current = dto({ state, ...(state === "paused" || state === "resuming" ? { resumeMode: "fast" } : {}), ...(state === "failed" ? { error: LONG } : {}) });
		await p.goto(conv.url);
		await p.waitForFunction((s) => document.querySelector('[data-testid="env-button"]')?.getAttribute("data-env-state") === s, state, { timeout: 15000 });
		const btn = p.locator(T("env-button"));
		const dots = await p.locator(T("env-dot")).count();
		const aria = (await btn.getAttribute("aria-label")) ?? "";
		if (!dot) {
			check(`A [intercepted] state ${state}: no dot, aria-label just names the channel`, dots === 0 && /^执行环境：本地环境（OpenSandbox）$/.test(aria), `dots=${dots} aria=${aria}`);
		} else {
			const d = p.locator(T("env-dot"));
			check(`A [intercepted] state ${state}: exactly one dot, data-dot=${dot}, ${cls === "wr-pulse" ? "pulsing" : "class " + cls}; aria-label mentions 「${label}」`, dots === 1 && (await d.getAttribute("data-dot")) === dot && ((await d.getAttribute("class")) ?? "").includes(cls) && aria.includes(`，${label}）`), aria);
		}
		check(`A [intercepted] state ${state}: no inline line in the conversation (round 11 R1: the dot is the only mark; nothing is running)`, (await p.locator(T("env-status")).count()) === 0 && !(await p.locator("body").innerText()).includes("正在准备工作环境"));
		await btn.click();
		await p.waitForSelector(T("env-popover"));
		await sleep(450);
		const text = await popText(p);
		const expectText = state === "failed" ? /^本地环境 云端沙箱 准备失败 重试$/ : /^本地环境 云端沙箱$/;
		check(`A [intercepted] state ${state}: popover is just 本地环境 / 云端沙箱${state === "failed" ? " + 准备失败 + 重试 (reason only in the title)" : ""}`, expectText.test(text.replace(/\s?（[^）]*）/, "")), text);
		if (state === "failed") check("A [intercepted] failed: the reason is only the hover title of 准备失败", ((await p.locator('[data-testid="env-state"] span[title]').getAttribute("title")) ?? "").includes("创建超时"));
		if (state === "preparing" || state === "resuming") check(`A [intercepted] state ${state}: 云端沙箱 carries the spinner (aria-label 准备中), no 重试`, (await p.locator('[data-testid="env-cloud"] [aria-label="准备中"]').count()) === 1 && (await p.locator(T("env-prepare")).count()) === 0);
		await p.keyboard.press("Escape");
		await p.waitForSelector(T("env-popover"), { state: "detached" });
		await btn.screenshot({ path: join(SHOTS, "round11", `dot-${state}.png`) });
	}
	// a local driver (kind local) has no lifecycle: no dot unless it failed
	for (const [state, want] of [["ready", 0], ["failed", 1]]) {
		current = dto({ kind: "local", id: "namespaces", label: "平台内置沙箱", location: "this_server", state, ...(state === "failed" ? { error: "没有可用的沙箱驱动" } : {}) });
		await p.goto(conv.url);
		await p.waitForFunction((s) => document.querySelector('[data-testid="env-button"]')?.getAttribute("data-env-state") === s, state, { timeout: 15000 });
		check(`A [intercepted] the server's own driver, state ${state}: ${want ? "a red dot (it failed)" : "no dot"}`, (await p.locator(T("env-dot")).count()) === want, `kind=local`);
	}
	check("A [intercepted] nothing above sent a prepare (reading and opening the popover never start a sandbox)", posts.length === 0, JSON.stringify(posts));

	// 云端沙箱 starts a sandbox only when the state is none / lost / paused; with a sandbox that is ready it changes nothing but the preference
	for (const [state, expectPrepare] of [["none", 1], ["lost", 1], ["paused", 1], ["ready", 0], ["preparing", 0], ["failed", 0]]) {
		posts.length = 0;
		current = dto({ state, ...(state === "failed" ? { error: LONG } : {}) });
		await p.unroute(envUrl);
		const puts = [];
		await p.route(envUrl, (r) => {
			if (r.request().method() === "POST") {
				posts.push(r.request().postData());
				return r.fulfill({ json: dto({ state: "ready" }) });
			}
			return r.fulfill({ json: current });
		});
		await p.goto(conv.url);
		await p.waitForFunction((s) => document.querySelector('[data-testid="env-button"]')?.getAttribute("data-env-state") === s, state, { timeout: 15000 });
		await p.locator(T("env-button")).click();
		await p.waitForSelector(T("env-popover"));
		await p.locator(T("env-cloud")).click();
		await sleep(700);
		check(`A [intercepted] clicking 云端沙箱 while ${state}: ${expectPrepare ? "exactly one POST …/prepare with { trigger: \"explicit\" }" : "no prepare"}; no local-exec request (round 14: removed)`, posts.length === expectPrepare && (!expectPrepare || JSON.parse(posts[0] ?? "{}").trigger === "explicit") && puts.length === 0, `posts=${JSON.stringify(posts)} puts=${JSON.stringify(puts)}`);
		await p.keyboard.press("Escape").catch(() => {});
	}
	await p.unroute(envUrl);
	await ic.close();

	// popover geometry: 390 / 1440, light / dark, the longest variant (failed) and a calm one (ready)
	for (const [w, scheme] of [[1440, "light"], [1440, "dark"], [390, "light"], [390, "dark"]]) {
		for (const state of ["failed", "paused"]) {
			const c = await ctxOf(w, scheme, cookies);
			const pg = await c.newPage();
			await pg.route(envUrl, (r) => r.fulfill({ json: dto({ state, ...(state === "failed" ? { error: LONG } : { resumeMode: "fast" }) }) }));
			await pg.goto(conv.url);
			await pg.waitForFunction((s) => document.querySelector('[data-testid="env-button"]')?.getAttribute("data-env-state") === s, state, { timeout: 15000 });
			const bb = await pg.locator(T("env-button")).boundingBox();
			await pg.locator(T("env-button")).click();
			await pg.waitForSelector(T("env-popover"));
			await sleep(500);
			const b = await pg.locator(T("env-popover")).boundingBox();
			check(`A ${w}px ${scheme} ${state}: button >=36px inside the viewport; popover fully opaque, inside with >=8px gutters, no horizontal scroll`, bb && bb.width >= 36 && bb.x >= 0 && bb.x + bb.width <= w && b && b.x >= 8 && b.x + b.width <= w - 8 && b.y >= 0 && b.y + b.height <= (w < 500 ? 844 : 900) && (await opaque(pg.locator(T("env-popover")))) && (await noHScroll(pg)), JSON.stringify(b));
			if (state === "failed" || (state === "paused" && w === 1440)) await shotR(pg, `lifecycle-popover-${state}-${w}-${scheme}`);
			await c.close();
		}
	}
	// the home page: the popover opens downwards; the same two rows, no dot (no conversation, nothing exists)
	{
		const c = await ctxOf(390, "light", cookies);
		const pg = await c.newPage();
		await pg.goto(base);
		await pg.waitForSelector(T("env-button"));
		await pg.waitForFunction(() => document.querySelector('[data-testid="env-button"]')?.hasAttribute("data-env-pref"));
		await pg.locator(T("env-button")).click();
		await pg.waitForSelector(T("env-popover"));
		await sleep(500);
		const b = await pg.locator(T("env-popover")).boundingBox();
		check("A 390 home: popover fits, two rows, no dot", b && b.x >= 8 && b.x + b.width <= 382 && b.y >= 0 && b.y + b.height <= 844 && (await pg.locator(T("env-dot")).count()) === 0 && /^本地环境 云端沙箱$/.test((await popText(pg)).replace(/\s?（[^）]*）/, "")) && (await noHScroll(pg)), JSON.stringify(b));
		await shotR(pg, "lifecycle-popover-home-390-light");
		await c.close();
	}
}

// ================================================================== B. real server: the choice persists; the admin switch
{
	const puts = [];
	const prepares = [];
	page.on("request", (r) => {
		const path = new URL(r.url()).pathname;
		if (/local-exec/.test(path)) puts.push(path); // round 14: any local-exec request is a failure
		if (r.method() === "POST" && /\/environment\/prepare$/.test(path)) prepares.push(path);
	});
	// B1. round 12: 本地环境 is greyed out until the desktop app ships — the home page shows the cloud, choosing 云端沙箱 is kept in the tab
	await page.goto(base);
	await page.waitForSelector(T("env-button"));
	await page.waitForFunction(() => document.querySelector('[data-testid="env-button"]')?.hasAttribute("data-env-pref"));
	check("B1 [round 12] home: the button shows 云端沙箱 (data-env-pref=cloud)", (await page.locator(T("env-button")).getAttribute("data-env-pref")) === "cloud");
	await page.locator(T("env-button")).click();
	await page.waitForSelector(T("env-popover"));
	check("B1 [round 12] home: a radiogroup with two radios — 本地环境 greyed out (aria-disabled, dashed, not checked), 云端沙箱 checked", (await page.locator(`${T("env-popover")} [role="radiogroup"] [role="radio"]`).count()) === 2 && (await page.locator(T("env-local")).getAttribute("aria-checked")) === "false" && (await page.locator(T("env-local")).getAttribute("aria-disabled")) === "true" && ((await page.locator(T("env-local")).getAttribute("class")) ?? "").includes("border-dashed") && (await page.locator(T("env-cloud")).getAttribute("aria-checked")) === "true");
	await page.locator(T("env-local")).hover();
	const tipB = await page.waitForSelector('[role="tooltip"]', { timeout: 3000 }).catch(() => null);
	check("B1 [round 12] hovering 本地环境 says 本地应用上线后可用", !!tipB && (await tipB.innerText()).includes("本地应用上线后可用"));
	await page.locator(T("env-local")).click({ force: true });
	await page.locator(T("env-cloud")).click();
	await sleep(300);
	const kept = await page.evaluate(() => Object.entries(sessionStorage).filter(([k]) => k.startsWith("wr-env-pref:")).map(([, v]) => v));
	check("B1 home: clicking 本地环境 does nothing; choosing 云端沙箱 is kept in this tab only (no request sent, nothing created)", kept.join() === "cloud" && puts.length === 0 && prepares.length === 0 && (await page.locator(T("env-dot")).count()) === 0 && (await page.locator(T("env-button")).getAttribute("data-env-pref")) === "cloud");
	await page.keyboard.press("Escape");
	await sendMessage(page, "你好，只是聊天");
	await page.waitForURL(/\/c\//);
	await page.waitForSelector(T("assistant-message"), { timeout: 60000 });
	await idle(page);
	const [, spaceId, convNo] = /\/c\/([^/]+)\/(\d+)/.exec(page.url());
	await page.waitForFunction(() => document.querySelector('[data-testid="env-button"]')?.getAttribute("data-env-pref") === "cloud");
	check("B1 the new conversation runs in the cloud (nothing to save); the tab's pending value is consumed", puts.length === 0 && (await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("wr-env-pref:")).length)) === 0, JSON.stringify({ puts }));
	// B2. a reload keeps it; 本地环境 cannot be chosen in a conversation either
	await page.reload();
	await page.waitForFunction(() => document.querySelector('[data-testid="env-button"]')?.getAttribute("data-env-pref") === "cloud");
	check("B2 reload: still 云端沙箱 (data-env-pref=cloud; aria-label says 云端沙箱)", /^执行环境：云端沙箱/.test((await page.locator(T("env-button")).getAttribute("aria-label")) ?? ""));
	await page.locator(T("env-button")).click();
	await page.waitForSelector(T("env-popover"));
	await page.locator(T("env-local")).click({ force: true });
	await sleep(500);
	check("B2 clicking the greyed 本地环境 in a conversation saves nothing and starts nothing", puts.length === 0 && prepares.length === 0 && (await page.locator(T("env-button")).getAttribute("data-env-pref")) === "cloud");
	await shotR(page, "lifecycle-local-greyed-1440");
	await page.keyboard.press("Escape");
	// B3. the disabled row
	await page.reload();
	await page.waitForFunction(() => document.querySelector('[data-testid="env-button"]')?.getAttribute("data-env-pref") === "cloud");
	await page.locator(T("env-button")).click();
	await page.waitForSelector(T("env-popover"));
	const local = page.locator(T("env-local"));
	const cls = (await local.getAttribute("class")) ?? "";
	check("B3 本地环境 is disabled (aria-disabled, dashed, not checked), just those four characters; 云端沙箱 is the checked one", (await local.getAttribute("aria-disabled")) === "true" && cls.includes("border-dashed") && (await local.getAttribute("aria-checked")) === "false" && (await local.innerText()).trim() === "本地环境" && (await page.locator(T("env-cloud")).getAttribute("aria-checked")) === "true");
	const putsBefore = puts.length;
	await local.click({ force: true });
	await sleep(500);
	check("B3 clicking the disabled 本地环境 does nothing (popover open, still cloud, no request)", puts.length === putsBefore && (await page.locator(T("env-popover")).count()) === 1 && (await page.locator(T("env-button")).getAttribute("data-env-pref")) === "cloud");
	await shotR(page, "lifecycle-local-disabled-1440");
	await page.keyboard.press("Escape");
	await page.goto(base);
	await page.waitForSelector(T("env-button"));
	await page.waitForFunction(() => document.querySelector('[data-testid="env-button"]')?.hasAttribute("data-env-pref"));
	check("B3 home: the button is 云端沙箱 too, 本地环境 disabled", (await page.locator(T("env-button")).getAttribute("data-env-pref")) === "cloud" && (await (async () => {
		await page.locator(T("env-button")).click();
		await page.waitForSelector(T("env-popover"));
		return (await page.locator(T("env-local")).getAttribute("aria-disabled")) === "true";
	})()));
	await page.keyboard.press("Escape");
	// 390 phone: the disabled row fits as well
	{
		const c = await ctxOf(390, "dark", cookies);
		const pg = await c.newPage();
		await pg.goto(base);
		await pg.waitForSelector(T("env-button"));
		await pg.waitForFunction(() => document.querySelector('[data-testid="env-button"]')?.hasAttribute("data-env-pref"));
		await pg.locator(T("env-button")).click();
		await pg.waitForSelector(T("env-popover"));
		await sleep(450);
		const b = await pg.locator(T("env-popover")).boundingBox();
		check("B3 390 dark: popover with the disabled row fits, no horizontal scroll", b && b.x >= 8 && b.x + b.width <= 382 && (await noHScroll(pg)), JSON.stringify(b));
		await shotR(pg, "lifecycle-local-disabled-390-dark");
		await c.close();
	}
	await page.reload();
	await page.waitForSelector(T("env-button"));
	await page.waitForFunction(() => document.querySelector('[data-testid="env-button"]')?.hasAttribute("data-env-pref"));
	await page.locator(T("env-button")).click();
	await page.waitForSelector(T("env-popover"));
	check("B3 本地环境 stays greyed out (reserved for the desktop app)", (await page.locator(T("env-local")).getAttribute("aria-disabled")) === "true");
	await page.keyboard.press("Escape");
}

// ================================================================== C. LIVE OpenSandbox: prepare → idle pause → resume
if (!LIVE_URL || !LIVE_KEY) skip("C [live] OpenSandbox: explicit start, idle pause by the reaper, resume by a sandbox_exec", "WORKROOM_TEST_OPENSANDBOX_URL / WORKROOM_TEST_OPENSANDBOX_KEY not set (no real OpenSandbox available)");
else {
	const liveCtx = await ctxOf(1440, "light", cookies);
	// Records, inside the page, every distinct value of the button's dot and whether an inline environment line (or the removed wording) ever existed.
	await liveCtx.addInitScript(() => {
		window.__dots = [];
		window.__line = false;
		let queued = false;
		const scan = () => {
			queued = false;
			const d = document.querySelector('[data-testid="env-dot"]');
			const v = d ? d.getAttribute("data-dot") : "-";
			if (window.__dots[window.__dots.length - 1] !== v) window.__dots.push(v);
			if (document.querySelector('[data-testid="env-status"]') || /正在准备工作环境/.test(document.body?.textContent ?? "")) window.__line = true;
		};
		const mo = new MutationObserver(() => {
			if (!queued) {
				queued = true;
				requestAnimationFrame(scan);
			}
		});
		document.addEventListener("DOMContentLoaded", () => {
			mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-dot"] });
			scan();
		});
	});
	const lp = await liveCtx.newPage();
	const instRows = async () => ((await json("/sandbox/instances")).instances ?? []).filter((i) => i.provider === "opensandbox");
	let remoteIdToClean;
	try {
		// ---- setup through the admin page: key saved by API (a radio is disabled without one), channel chosen by the radio, idle pause 1 minute in the card
		const key = await api("/sandbox/providers/opensandbox", { method: "PUT", data: { endpoint: LIVE_URL, apiKey: LIVE_KEY, allowPrivateNetwork: true, egressAcknowledged: true } });
		await lp.goto(`${base}/admin?tab=sandbox`);
		await lp.waitForSelector(T("sandbox-channel"));
		await lp.locator(`${T("channel-opensandbox")} input`).click();
		await lp.waitForSelector(T("opensandbox-active"), { timeout: 15000 });
		await lp.locator(T("opensandbox-idle-pause")).fill("1");
		await lp.locator(T("opensandbox-save")).click();
		await lp.waitForFunction(() => document.querySelector('[data-testid="opensandbox-save"]')?.hasAttribute("disabled"), null, { timeout: 15000 });
		await sleep(800);
		const cfg = (await json("/sandbox/providers")).providers.find((x) => x.provider === "opensandbox");
		check("C setup [live]: OpenSandbox is the channel (admin radio) and the idle pause is the minimum the server accepts, 60 s", key.ok() && cfg?.enabled === true && cfg.idlePauseSec === 60, `enabled=${cfg?.enabled} idlePauseSec=${cfg?.idlePauseSec}`);
		const tooLow = await api("/sandbox/providers/opensandbox", { method: "PUT", data: { idlePauseSec: 59 } });
		check("C setup [live]: the server refuses less than 60 s (400) — so 60 s really is the minimum", tooLow.status() === 400 && (await json("/sandbox/providers")).providers.find((x) => x.provider === "opensandbox").idlePauseSec === 60);

		const conv = await newConversation();
		await lp.goto(conv.url);
		await lp.waitForSelector(T("env-button"));
		await lp.waitForFunction(() => document.querySelector('[data-testid="env-button"]')?.getAttribute("data-env-kind") === "remote");
		const stats = async () => (await json(`/conversations/${conv.spaceId}/${conv.id}/sandbox-stats`)).stats;
		const prepares = [];
		lp.on("request", (r) => r.method() === "POST" && /\/environment\/prepare$/.test(new URL(r.url()).pathname) && prepares.push(r.postData()));

		// ---- a plain chat first: nothing is created
		await sendMessage(lp, "只是聊天，请回答：1+1 等于几？");
		await lp.waitForSelector(T("assistant-message"), { timeout: 60000 });
		await idle(lp);
		await sleep(1500);
		check("C [live] a plain chat with the remote channel chosen creates nothing: no instance row for this conversation, no dot, no prepare, no create event", (await instRows()).filter((i) => i.workspaceKey === `c${conv.id}`).length === 0 && (await lp.locator(T("env-dot")).count()) === 0 && prepares.length === 0 && (await stats()).creates === 0);

		// ---- explicit start: the popover's 云端沙箱
		const apiStates = [];
		let sampling = true;
		const t0 = Date.now();
		const apiSampler = (async () => {
			while (sampling) {
				const r = await api(`/conversations/${conv.spaceId}/${conv.id}/environment`).then((x) => x.json()).catch(() => null);
				if (r?.state && apiStates.at(-1)?.s !== r.state) apiStates.push({ s: r.state, at: Date.now() - t0 });
				await sleep(100);
			}
		})();
		await lp.locator(T("env-button")).click();
		await lp.waitForSelector(T("env-popover"));
		await lp.locator(T("env-cloud")).click();
		await lp.waitForFunction(() => document.querySelector('[data-testid="env-button"]')?.getAttribute("data-env-state") === "ready", null, { timeout: 180000 });
		sampling = false;
		await apiSampler;
		{
			// one last read: the loop above may have stopped between two samples, right before the final state
			const r = await api(`/conversations/${conv.spaceId}/${conv.id}/environment`).then((x) => x.json()).catch(() => null);
			if (r?.state && apiStates.at(-1)?.s !== r.state) apiStates.push({ s: r.state, at: Date.now() - t0 });
		}
		await lp.keyboard.press("Escape").catch(() => {});
		const seq = apiStates.map((x) => x.s);
		const dotsUi = await lp.evaluate(() => window.__dots.slice());
		check("C [live] 云端沙箱 on a conversation with no sandbox: the server reported none → preparing → ready (sampled from the API), the button ends with the green dot", seq[0] === "none" && seq.includes("preparing") && seq.at(-1) === "ready" && (await lp.locator(T("env-dot")).getAttribute("data-dot")) === "ready", JSON.stringify(apiStates));
		check("C [live] the button showed the pulsing dot while it was being prepared: dot sequence ends … preparing → ready", dotsUi.includes("preparing") && dotsUi.at(-1) === "ready" && dotsUi.indexOf("preparing") < dotsUi.lastIndexOf("ready"), JSON.stringify(dotsUi));
		check("C [live] no inline line in the chat at any moment (R1: dot only)", (await lp.evaluate(() => window.__line)) === false && (await lp.locator(T("env-status")).count()) === 0);
		check("C [live] exactly one explicit prepare request, body { trigger: explicit }", prepares.length === 1 && JSON.parse(prepares[0] ?? "{}").trigger === "explicit", JSON.stringify(prepares));
		const first = (await instRows()).filter((i) => i.workspaceKey === `c${conv.id}` && i.state === "ready");
		check("C [live] one ready instance for this conversation, with a remote id", first.length === 1 && !!first[0].remoteId, JSON.stringify(first.map((i) => i.state)));
		remoteIdToClean = first[0]?.remoteId;
		const s1 = await stats();
		check("C [live] lifecycle stats: one create, triggered explicit (not exec, not prewarm)", s1.creates === 1 && s1.createsByTrigger.explicit === 1 && s1.createsByTrigger.exec === 0 && s1.createsByTrigger.prewarm === 0 && s1.resumes === 0, JSON.stringify(s1.createsByTrigger));
		await shotR(lp, "lifecycle-live-ready-1440");

		// ---- a plain chat on the ready sandbox neither creates a second one nor counts as use
		const usedBefore = first[0].lastUsedAt;
		await sendMessage(lp, "再聊一句，别的不用做");
		await idle(lp);
		const afterChat = (await instRows()).filter((i) => i.workspaceKey === `c${conv.id}` && i.state === "ready");
		check("C [live] a plain chat on a ready sandbox: still the same single instance (same remote id), not counted as use (lastUsedAt unchanged), still one create", afterChat.length === 1 && afterChat[0].remoteId === first[0].remoteId && afterChat[0].lastUsedAt === usedBefore && (await stats()).creates === 1);

		// ---- the real reaper: idle ≥ 60 s and not busy → paused (it ticks every 60 s: wait at most 4 minutes)
		const tPause = Date.now();
		let pausedRow;
		while (Date.now() - tPause < 240000) {
			pausedRow = (await instRows()).find((i) => i.workspaceKey === `c${conv.id}` && i.remoteId === first[0].remoteId);
			if (pausedRow?.state === "paused") break;
			await sleep(3000);
		}
		const waited = Math.round((Date.now() - tPause) / 1000);
		check(`C [live] the reaper paused the idle sandbox by itself (state paused, resume mode provider = the vendor kept it) after ${waited} s of waiting`, pausedRow?.state === "paused" && pausedRow.resumeMode === "provider", JSON.stringify(pausedRow));
		const envPaused = await json(`/conversations/${conv.spaceId}/${conv.id}/environment`);
		check("C [live] the environment DTO says paused with resumeMode fast", envPaused.state === "paused" && envPaused.resumeMode === "fast", JSON.stringify({ s: envPaused.state, m: envPaused.resumeMode }));
		await lp.reload();
		await lp.waitForFunction(() => document.querySelector('[data-testid="env-button"]')?.getAttribute("data-env-state") === "paused", null, { timeout: 15000 });
		const pd = lp.locator(T("env-dot"));
		check("C [live] after a reload the button shows the grey dot (data-dot=paused, aria-label 已暂停), still no line", (await pd.getAttribute("data-dot")) === "paused" && ((await pd.getAttribute("class")) ?? "").includes("bg-fg-subtle") && ((await lp.locator(T("env-button")).getAttribute("aria-label")) ?? "").includes("已暂停") && (await lp.locator(T("env-status")).count()) === 0);
		await shotR(lp, "lifecycle-live-paused-1440");
		const s2 = await stats();
		check("C [live] lifecycle stats: one idle pause recorded, still one create", s2.idlePauses === 1 && s2.creates === 1, JSON.stringify({ p: s2.idlePauses, c: s2.creates }));

		// ---- resume by a sandbox_exec (the fixture model calls the tool); sampled both from the API and in the page
		const apiStates2 = [];
		sampling = true;
		const t1 = Date.now();
		const apiSampler2 = (async () => {
			while (sampling) {
				const r = await api(`/conversations/${conv.spaceId}/${conv.id}/environment`).then((x) => x.json()).catch(() => null);
				if (r?.state && apiStates2.at(-1)?.s !== r.state) apiStates2.push({ s: r.state, at: Date.now() - t1 });
				await sleep(80);
			}
		})();
		await sendMessage(lp, `在沙箱里跑一下 ${directive("sandbox_exec", { language: "shell", code: "echo resumed-ok; uname -s" })}`);
		await lp.waitForSelector(T("stop"), { timeout: 20000 });
		await idle(lp, 180000);
		await sleep(1500);
		sampling = false;
		await apiSampler2;
		{
			const r = await api(`/conversations/${conv.spaceId}/${conv.id}/environment`).then((x) => x.json()).catch(() => null);
			if (r?.state && apiStates2.at(-1)?.s !== r.state) apiStates2.push({ s: r.state, at: Date.now() - t1 });
		}
		const seq2 = apiStates2.map((x) => x.s);
		const dots2 = await lp.evaluate(() => window.__dots.slice());
		check("C [live] the sandbox_exec resumed it: the server's state went paused → (resuming) → ready, ending ready", seq2[0] === "paused" && seq2.at(-1) === "ready", JSON.stringify(apiStates2));
		console.log(`INFO  resume window: API states ${JSON.stringify(apiStates2)}; page dot sequence after reload ${JSON.stringify(dots2)} (resuming is only caught when its ~1 s window meets a poll; not asserted)`);
		check("C [live] the button ends with the green dot again; no inline line at any moment of the resume", (await lp.locator(T("env-dot")).getAttribute("data-dot")) === "ready" && (await lp.evaluate(() => window.__line)) === false);
		check("C [live] the answer carries the real output of the resumed sandbox", (await lp.locator(T("assistant-message")).last().innerText()).includes("resumed-ok"));
		const after = (await instRows()).filter((i) => i.workspaceKey === `c${conv.id}`);
		check("C [live] admin instance data: still ONE instance for the conversation, the same row and remote id (resumed, not re-created), state ready", after.length === 1 && after[0].id === first[0].id && after[0].remoteId === first[0].remoteId && after[0].state === "ready", JSON.stringify(after.map((i) => ({ s: i.state, same: i.remoteId === first[0].remoteId }))));
		const s3 = await stats();
		check("C [live] lifecycle stats: creates 1 (unchanged), resumes 1, resume failures 0, idle pauses 1", s3.creates === 1 && s3.resumes === 1 && s3.resumeFailures === 0 && s3.idlePauses === 1, JSON.stringify({ c: s3.creates, r: s3.resumes, rf: s3.resumeFailures, p: s3.idlePauses }));
		await shotR(lp, "lifecycle-live-resumed-1440");
	} finally {
		// clean up the real sandbox (best effort; it also expires by its own safety timeout)
		try {
			const { createRemoteProvider } = await import(join(ROOT, "server/src/tools/sandbox/providers/index.ts"));
			const prov = await createRemoteProvider({ provider: "opensandbox", endpoint: LIVE_URL, apiKey: LIVE_KEY });
			const ids = new Set([remoteIdToClean, ...(await instRows()).map((i) => i.remoteId)].filter(Boolean));
			for (const id of ids) await prov.destroy(id).catch(() => {});
		} catch (e) {
			console.log(`NOTE  live sandbox cleanup skipped (${String(e?.message ?? e).slice(0, 120)})`);
		}
		await liveCtx.close();
	}
}

console.log(`\n${skipped} step(s) skipped with explicit reasons (not counted as passed).`);
const ok = summary(join(SHOTS, "round11", "lifecycle-results.json"));
await browser.close();
await server.stop();
process.exitCode = ok ? 0 : 1;
