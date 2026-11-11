// Round 11 · R6 — sandbox lifecycle statistics on the stats page. REAL browser, REAL server (fixture model, no real AI).
//  A. SEEDED: lifecycle events, instances, prewarm decisions and code_run records are written into the server's database (the real lifecycle that writes
//     them is covered by server/test/sandbox-lifecycle.test.ts and, below, by section F against a live OpenSandbox when WORKROOM_TEST_OPENSANDBOX_URL is set).
//     Checks: the 沙箱 section renders on the organisation scope only; every KPI equals the API; no cost tile while no price is configured.
//  B. price per provider-hour set through the REAL admin UI (admin › 沙箱): the cost tile and the per-provider cost appear and match the API; clearing removes them.
//  C. the prewarm tuning block: precision / recall at the current threshold and the 10% … 90% what-if row equal the API.
//  D. permissions: a plain member gets 403 from the API and never sees the section; the personal scope has no 沙箱 section.
//  E. 390px: no horizontal page scroll; dark mode: the section follows the theme tokens.
//  F. LIVE (only with WORKROOM_TEST_OPENSANDBOX_URL / _KEY; otherwise skipped with a message, never faked): a real explicit prepare on a self-hosted OpenSandbox creates one
//     real sandbox; the page shows that create with its measured cold start, equal to the recorded event.
// Run: npm run build:web && node web/e2e/round11-sandbox-stats.mjs        (port 8984)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { check, chromium, register, ROOT, shot, sleep, startServer, summary, SHOTS } from "./lib.mjs";

mkdirSync(join(SHOTS, "round11"), { recursive: true });
const PORT = 8984;
const LIVE_URL = process.env.WORKROOM_TEST_OPENSANDBOX_URL;
const LIVE_KEY = process.env.WORKROOM_TEST_OPENSANDBOX_KEY ?? "no-key-for-local-0000";
const server = await startServer({ port: PORT, env: { WORKROOM_SECRET_KEY: "round11-stats-e2e-secret-key-0123456789", WORKROOM_WEBHOOK_ALLOWLIST: "127.0.0.1" } });
const base = server.base;
const browser = await chromium.launch();
const T = (id) => `[data-testid="${id}"]`;
const HOUR = 3_600_000;
const MIN = 60_000;
let skipped = 0;
const skip = (name, why) => {
	skipped++;
	console.log(`SKIP  ${name}  — ${why}`);
};

// ---- the same number formats as the page (web/src/features/stats/format.ts, SandboxStats.tsx)
const dec1 = (n) => n.toLocaleString("zh-CN", { maximumFractionDigits: 1 });
const fmtMs = (ms) => (ms == null ? "—" : ms < 1000 ? `${Math.round(ms).toLocaleString("zh-CN")} 毫秒` : ms < 60_000 ? `${dec1(ms / 1000)} 秒` : `${dec1(ms / 60_000)} 分钟`);
const fmtRunning = (ms) => (ms < HOUR ? fmtMs(ms) : `${dec1(ms / HOUR)} 小时`);
const fmtPct = (r) => (r == null ? "—" : `${(r * 100).toLocaleString("zh-CN", { maximumFractionDigits: 0 })}%`);
const fmtUsd = (n) => (n == null ? "—" : n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

const ctxOf = (w, scheme = "light") => browser.newContext({ viewport: { width: w, height: w < 500 ? 844 : 1000 }, colorScheme: scheme, locale: "zh-CN", ...(w < 500 ? { isMobile: true, hasTouch: true } : {}) });
const owner = await ctxOf(1280);
const page = await owner.newPage();
await register(page, base, { email: "r11stats@example.com", name: "沙箱统计" });
const api = (path, init) => page.request.fetch(`${base}/api${path}`, init);
const json = async (path, init) => (await api(path, init)).json();
const me = await json("/me");
const orgId = me.me.orgId;
const conv = async () => (await json("/conversations", { method: "POST", data: {} })).conversation;
const A = await conv();
const B = await conv();
check("setup: organisation id and two conversations", !!orgId && !!A?.spaceId && !!B?.spaceId, `${orgId}`);

// ------------------------------------------------------------------ seed (A)
const db = new DatabaseSync(join(ROOT, "data/dev-B", `e2e-${PORT}`, "app.sqlite"));
db.exec("PRAGMA busy_timeout = 8000;");
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const ev = (c, provider, kind, trigger, o = {}) =>
	db.prepare('INSERT INTO tool_sandbox_events (org_id, space_id, workspace_key, conversation_id, provider, kind, "trigger", duration_ms, running_ms, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(orgId, c.spaceId, `c${c.conversationId}`, c.conversationId, provider, kind, trigger, o.d ?? null, o.r ?? null, iso(o.at ?? now - 3 * 24 * HOUR));
for (const d of [100, 200, 300]) ev(A, "opensandbox", "create", "exec", { d });
ev(A, "opensandbox", "create", "prewarm", { d: 400 });
ev(A, "opensandbox", "create", "explicit", { d: 1000 });
ev(A, "opensandbox", "create_failed", "exec", { d: 9000 });
for (const d of [50, 150]) ev(A, "opensandbox", "resume", "exec", { d });
ev(A, "opensandbox", "resume_failed", "exec", { d: 70 });
ev(A, "opensandbox", "pause", "idle", { r: 10 * MIN });
ev(A, "opensandbox", "pause", "idle", { r: 10 * MIN });
ev(A, "opensandbox", "archive", "retention");
ev(A, "opensandbox", "destroy", "expiry", { r: 0 });
ev(B, "e2b", "create", "exec", { d: 5000 });
ev(B, "e2b", "pause", "idle", { r: HOUR });
ev(B, "e2b", "destroy", "admin", { r: 30 * MIN });
// a sandbox that is running right now (open interval): conversation A, started one hour ago
db.prepare("INSERT INTO tool_sandbox_instances (id, provider, space_id, workspace_key, remote_id, state, created_at, last_used_at, org_id, state_at, running_since) VALUES ('seed-open', 'opensandbox', ?, ?, 'seed-remote', 'ready', ?, ?, ?, ?, ?)").run(A.spaceId, `c${A.conversationId}`, iso(now - 2 * HOUR), iso(now - MIN), orgId, iso(now - HOUR), iso(now - HOUR));
// prewarm decisions: score, fired, reason, used  (precision 3/4, recall 3/4 at 0.3)
[[0.95, 1, "fired", 1], [0.65, 1, "fired", 1], [0.45, 1, "fired", 0], [0.35, 1, "fired", 1], [0.25, 0, "below", 1], [0.15, 0, "below", 0], [0.05, 0, "below", 0], [0.5, 0, "ready", 1]].forEach(([score, fired, reason, used], i) =>
	db.prepare("INSERT INTO tool_sandbox_prewarm_log (org_id, space_id, conversation_id, at, score, threshold, fired, reason, signals, used_at) VALUES (?, ?, ?, ?, ?, 0.3, ?, ?, '', ?)").run(orgId, A.spaceId, 100 + i, iso(now - 2 * HOUR), score, fired, reason, used ? iso(now - HOUR) : null));
// code_run records: browser 3, cloud 2 (one of them an upgrade)
["browser ok ok", "browser ok ok", "browser error ok", "cloud ok no_tab", "cloud ok browser_failed upgraded"].forEach((summary, i) =>
	db.prepare("INSERT INTO tool_calls (id, tool, org_id, user_id, space_id, conversation_id, task_id, call_id, args_summary, status, result_summary, started_at, started_ms) VALUES (?, 'code_run', ?, 'u', ?, ?, 1, ?, '{}', 'ok', ?, ?, 0)").run(`tc_seed_${i}`, orgId, A.spaceId, A.conversationId, `s${i}`, summary, iso(now - 4 * HOUR)));
check("seeded: 16 events, 1 running sandbox, 8 prewarm decisions, 5 code_run records", db.prepare("SELECT COUNT(*) AS n FROM tool_sandbox_events").get().n === 16 && db.prepare("SELECT COUNT(*) AS n FROM tool_sandbox_prewarm_log").get().n === 8);

const statsUrl = `${base}/stats?scope=org&range=30d`;
/** Open the organisation stats page and return the sandbox API response the section itself fetched. */
async function openStats(p, url = statsUrl) {
	const resp = p.waitForResponse((r) => r.url().includes("/api/stats/sandbox") && r.request().method() === "GET", { timeout: 30000 });
	await p.goto(url);
	const body = await (await resp).json();
	await p.waitForSelector(`${T("sandbox-stats")} ${T("sbx-kpis")}`, { timeout: 30000 });
	return body;
}
const kpi = async (p, id) => ((await p.locator(`${T("sandbox-stats")} [data-kpi="${id}"] ${T("sbx-kpi-value")}`).first().innerText()) || "").trim();
const hasKpi = (p, id) => p.locator(`${T("sandbox-stats")} [data-kpi="${id}"]`).count();

// ------------------------------------------------------------------ A. numbers on the page = the API = the seed
let d = await openStats(page);
check("[A] the 沙箱 section renders on the organisation scope", (await page.locator(T("sandbox-stats")).count()) === 1);
check("[A] API totals equal the seed: 6 creates (4 exec / 1 prewarm / 1 explicit), 1 failure, cold start n=6 P50 300 P95 5000", d.total.creates === 6 && JSON.stringify(d.total.createsByTrigger) === '{"exec":4,"prewarm":1,"explicit":1}' && d.total.createFailures === 1 && d.total.coldStart.n === 6 && d.total.coldStart.p50 === 300 && d.total.coldStart.p95 === 5000, JSON.stringify(d.total.coldStart));
check("[A] resume n=2 P50 50 P95 150, 3 idle pauses, 1 archive, 2 destroys", d.total.resume.p50 === 50 && d.total.resume.p95 === 150 && d.total.idlePauses === 3 && d.total.archives === 1 && d.total.destroys === 2);
check("[A] running time = closed intervals (110 min) + the sandbox running now (about 1 h)", d.total.runningMs - d.total.openRunningMs === 110 * MIN && d.total.openRunningMs >= HOUR && d.total.openRunningMs < HOUR + 5 * MIN, `${d.total.runningMs} / open ${d.total.openRunningMs}`);
check("[A] creates tile", (await kpi(page, "creates")) === "6");
check("[A] cold start P50 / P95 tiles equal the API", (await kpi(page, "coldP50")) === fmtMs(d.total.coldStart.p50) && (await kpi(page, "coldP95")) === fmtMs(d.total.coldStart.p95), `${await kpi(page, "coldP50")} / ${await kpi(page, "coldP95")}`);
check("[A] resume P50 / P95 tiles equal the API", (await kpi(page, "resumeP50")) === fmtMs(d.total.resume.p50) && (await kpi(page, "resumeP95")) === fmtMs(d.total.resume.p95));
check("[A] idle pauses and running-time tiles equal the API", (await kpi(page, "idlePauses")) === "3" && (await kpi(page, "running")) === fmtRunning(d.total.runningMs), await kpi(page, "running"));
check("[A] code_run tile shows browser / cloud and the upgrade", (await kpi(page, "codeRun")) === "3 / 2" && /升级 1/.test(await page.locator(`${T("sandbox-stats")} [data-kpi="codeRun"]`).innerText()));
check("[A] no price configured: NO cost tile and '—' per provider (nothing invented)", (await hasKpi(page, "cost")) === 0 && (await page.locator(T("sbx-provider-row")).count()) === 2 && (await page.locator(T("sbx-provider-row")).allInnerTexts()).every((t) => t.split("\t").slice(-2).every((c) => c.trim() === "—")));
const rows = await page.locator(T("sbx-provider-row")).evaluateAll((els) => els.map((e) => [e.dataset.provider, [...e.querySelectorAll("td")].map((c) => c.textContent.trim())]));
const os = rows.find((r) => r[0] === "opensandbox")[1];
check("[A] provider table row (OpenSandbox): creates, cold P50 / P95, resume P50, pauses", os[1] === "5" && os[2] === fmtMs(300) && os[3] === fmtMs(1000) && os[4] === fmtMs(50) && os[5] === "2", os.join(" | "));
await page.locator(T("sandbox-stats")).scrollIntoViewIfNeeded();
await shot(page, "round11/r6-sandbox-stats-1280");

// ------------------------------------------------------------------ C. prewarm tuning
check("[C] threshold 30%, precision 75%, recall 75%, fired 4", (await kpi(page, "pwThreshold")) === "30%" && (await kpi(page, "pwPrecision")) === "75%" && (await kpi(page, "pwRecall")) === "75%" && (await kpi(page, "pwFired")) === "4", `${await kpi(page, "pwPrecision")} ${await kpi(page, "pwRecall")}`);
const th = await page.locator(T("sbx-whatif-th")).allInnerTexts();
check("[C] what-if header 10% … 90%", th.join(",") === "10%,20%,30%,40%,50%,60%,70%,80%,90%", th.join(","));
for (const key of ["precision", "recall"]) {
	const cells = await page.locator(`${T("sbx-whatif-row")}[data-row="${key}"] td`).allInnerTexts();
	const want = d.prewarm.whatIf.map((r) => fmtPct(r[key]));
	check(`[C] what-if ${key} row equals the API`, cells.slice(1).join(",") === want.join(","), `${cells.slice(1).join(",")}`);
}
check("[C] the 30% column is highlighted (current threshold)", (await page.locator(`${T("sbx-whatif-th")}[data-threshold="0.3"]`).getAttribute("class")).includes("bg-surface-3"));
check("[C] API what-if at 0.3 equals the actual precision / recall", d.prewarm.whatIf.find((r) => r.threshold === 0.3).precision === d.prewarm.precision && d.prewarm.whatIf.find((r) => r.threshold === 0.3).recall === d.prewarm.recall);
await page.locator(T("sbx-prewarm")).scrollIntoViewIfNeeded();
await shot(page, "round11/r6-sandbox-stats-prewarm");

// ------------------------------------------------------------------ B. price through the real admin UI
await page.goto(`${base}/admin?tab=sandbox`);
await page.waitForSelector(T("sandbox-prices"));
const price = (id) => page.locator(T(`price-${id}`));
await price("opensandbox").fill("0.5");
await price("opensandbox").press("Enter");
await page.waitForFunction(async () => (await (await fetch("/api/sandbox/prices")).json()).prices.opensandbox === 0.5, null, { timeout: 15000 });
check("[B] price saved through the admin UI (opensandbox 0.5 USD/hour)", (await json("/sandbox/prices")).prices.opensandbox === 0.5);
d = await openStats(page);
const osRow = d.byProvider.find((p) => p.provider === "opensandbox");
check("[B] partially priced: cost tile appears flagged '部分', e2b stays '—'", (await hasKpi(page, "cost")) === 1 && /部分/.test(await page.locator(`${T("sandbox-stats")} [data-kpi="cost"]`).innerText()) && d.costComplete === false && d.byProvider.find((p) => p.provider === "e2b").costUsd === null);
check("[B] cost = running hours x price, equal to the API and to the page", Math.abs(osRow.costUsd - (osRow.runningMs / HOUR) * 0.5) < 1e-5 && (await kpi(page, "cost")) === fmtUsd(d.total.costUsd), `${osRow.costUsd} / ${await kpi(page, "cost")}`);
await page.goto(`${base}/admin?tab=sandbox`);
await page.waitForSelector(T("sandbox-prices"));
await price("e2b").fill("1.25");
await price("e2b").blur();
await page.waitForFunction(async () => (await (await fetch("/api/sandbox/prices")).json()).prices.e2b === 1.25, null, { timeout: 15000 });
d = await openStats(page);
check("[B] both priced: complete cost = sum of both providers, label without '部分'", d.costComplete === true && !/部分/.test(await page.locator(`${T("sandbox-stats")} [data-kpi="cost"]`).innerText()) && (await kpi(page, "cost")) === fmtUsd(d.total.costUsd), `${d.total.costUsd}`);
const cells = await page.locator(`${T("sbx-provider-row")}[data-provider="e2b"] td`).allInnerTexts();
check("[B] per-provider row shows price and cost (E2B 1.25 USD/h x 1.5 h = $1.88)", cells.at(-2) === fmtUsd(1.25) && cells.at(-1) === fmtUsd(1.875), cells.join(" | "));
await page.goto(`${base}/admin?tab=sandbox`);
await page.waitForSelector(T("sandbox-prices"));
await price("e2b").fill("");
await price("e2b").blur();
await price("opensandbox").fill("");
await price("opensandbox").blur();
await page.waitForFunction(async () => Object.keys((await (await fetch("/api/sandbox/prices")).json()).prices).length === 0, null, { timeout: 15000 });
await openStats(page);
check("[B] prices cleared: the cost tile is gone again", (await hasKpi(page, "cost")) === 0);
// restore a price so the later screenshots show the cost tile
await api("/sandbox/prices", { method: "PUT", data: { prices: { opensandbox: 0.5, e2b: 1.25 } } });

// ------------------------------------------------------------------ D. permissions
{
	const inv = (await (await api("/admin/invites", { method: "POST", data: { role: "member", ttlHours: 24 } })).json()).invite.code;
	const mctx = await ctxOf(1280);
	const mp = await mctx.newPage();
	await mp.goto(`${base}/register?invite=${inv}`);
	await mp.fill("#name", "普通成员");
	await mp.fill("#email", "r11stats-member@example.com");
	await mp.fill("#password", "password123");
	await mp.click('button[type="submit"]');
	await mp.waitForSelector(T("home-greeting"));
	const r = await mp.request.get(`${base}/api/stats/sandbox`);
	check("[D] a plain member gets 403 from /api/stats/sandbox", r.status() === 403, String(r.status()));
	const pr = await mp.request.get(`${base}/api/sandbox/prices`);
	check("[D] a plain member cannot read the prices (403)", pr.status() === 403, String(pr.status()));
	await mp.goto(`${base}/stats?scope=org&range=30d`);
	await mp.waitForSelector(T("stats-page"));
	await sleep(1200);
	check("[D] the member's stats page has no 沙箱 section", (await mp.locator(T("sandbox-stats")).count()) === 0);
	await mctx.close();
	await page.goto(`${base}/stats?scope=personal&range=30d`);
	await page.waitForSelector(T("stats-dashboard"));
	await sleep(800);
	check("[D] the personal scope of the owner has no 沙箱 section either", (await page.locator(T("sandbox-stats")).count()) === 0);
}

// ------------------------------------------------------------------ E. 390px and dark mode
{
	const m = await ctxOf(390);
	await m.addCookies(await owner.cookies());
	const mp = await m.newPage();
	d = await openStats(mp);
	const ov = await mp.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth, sec: document.querySelector('[data-testid="sandbox-stats"]').getBoundingClientRect().right }));
	check("[E] 390px: no horizontal page scroll with the 沙箱 section", ov.doc <= ov.win && ov.sec <= ov.win, JSON.stringify(ov));
	check("[E] 390px: the cost tile and the what-if row are present", (await hasKpi(mp, "cost")) === 1 && (await mp.locator(T("sbx-whatif-th")).count()) === 9);
	await mp.locator(T("sandbox-stats")).scrollIntoViewIfNeeded();
	await shot(mp, "round11/r6-sandbox-stats-390");
	await mp.locator(T("sbx-prewarm")).scrollIntoViewIfNeeded();
	await shot(mp, "round11/r6-sandbox-stats-390-prewarm");
	await m.close();

	const dk = await ctxOf(1280, "dark");
	await dk.addCookies(await owner.cookies());
	const dp = await dk.newPage();
	await openStats(dp);
	await dp.evaluate(() => (document.documentElement.dataset.theme = "dark"));
	const tone = await dp.evaluate(() => {
		const s = getComputedStyle(document.querySelector('[data-testid="sandbox-stats"]'));
		const k = getComputedStyle(document.querySelector('[data-testid="sbx-kpi"]'));
		const lum = (c) => c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).reduce((a, b) => a + b, 0) / 3;
		return { card: lum(s.backgroundColor), kpi: lum(k.backgroundColor), text: lum(getComputedStyle(document.querySelector('[data-testid="sbx-kpi-value"]')).color), body: lum(getComputedStyle(document.body).backgroundColor) };
	});
	check("[E] dark mode: card and KPI backgrounds are dark and the value text is light", tone.card < 80 && tone.kpi < 80 && tone.text > 150 && tone.body < 80, JSON.stringify(tone));
	await dp.locator(T("sandbox-stats")).scrollIntoViewIfNeeded();
	await shot(dp, "round11/r6-sandbox-stats-dark");
	await dk.close();
}

// ------------------------------------------------------------------ F. live OpenSandbox: a real create is measured and shown
if (!LIVE_URL) {
	skip("[F live] real OpenSandbox lifecycle on the stats page", "WORKROOM_TEST_OPENSANDBOX_URL not set (no real OpenSandbox available); the sections above run on seeded events only");
} else {
	await api("/sandbox/prices", { method: "PUT", data: { prices: { opensandbox: 0.5 } } });
	const put = await api("/sandbox/providers/opensandbox", { method: "PUT", data: { enabled: true, endpoint: LIVE_URL, allowPrivateNetwork: true, egressAcknowledged: true, apiKey: LIVE_KEY } });
	const pol = await api("/sandbox/provider-policy", { method: "PUT", data: { orgDefault: "opensandbox", allowProjectOverride: false } });
	check("[F live] OpenSandbox configured through the API", put.status() < 400 && pol.status() < 400, `${put.status()}/${pol.status()}`);
	const before = await json("/stats/sandbox");
	const L = await conv();
	const prep = await api(`/conversations/${L.spaceId}/${L.conversationId}/environment/prepare`, { method: "POST", data: { trigger: "explicit" } });
	let state = "";
	for (let i = 0; i < 120 && state !== "ready"; i++) {
		await sleep(1000);
		state = (await json(`/conversations/${L.spaceId}/${L.conversationId}/environment`)).state;
	}
	check("[F live] a real sandbox became ready (explicit prepare)", prep.status() < 400 && state === "ready", `${prep.status()} ${state}`);
	const row = db.prepare("SELECT duration_ms, \"trigger\", provider FROM tool_sandbox_events WHERE org_id = ? AND conversation_id = ? AND kind = 'create' AND space_id = ?").get(orgId, L.conversationId, L.spaceId);
	d = await openStats(page);
	check("[F live] one more create, trigger explicit, cold start recorded", !!row && row.trigger === "explicit" && row.provider === "opensandbox" && row.duration_ms > 0 && d.total.creates === before.total.creates + 1 && d.total.createsByTrigger.explicit === before.total.createsByTrigger.explicit + 1, JSON.stringify(row));
	const mine = d.conversations.find((c) => c.spaceId === L.spaceId && c.conversationId === L.conversationId);
	check("[F live] the new conversation is listed with its cold start and a running sandbox", !!mine && mine.coldStart.p50 === row.duration_ms && mine.openRunningMs > 0, JSON.stringify(mine?.coldStart));
	check("[F live] the page shows the same creates number as the API", (await kpi(page, "creates")) === String(d.total.creates));
	await page.locator(T("sandbox-stats")).scrollIntoViewIfNeeded();
	await shot(page, "round11/r6-sandbox-stats-live");
	// clean up the real sandbox at the vendor (the server is stopped right after)
	const inst = db.prepare("SELECT remote_id FROM tool_sandbox_instances WHERE org_id = ? AND space_id = ? AND workspace_key = ? ORDER BY created_at DESC").get(orgId, L.spaceId, `c${L.conversationId}`);
	if (inst?.remote_id) await fetch(`${LIVE_URL.replace(/\/$/, "")}/v1/sandboxes/${inst.remote_id}`, { method: "DELETE", headers: { "OPEN-SANDBOX-API-KEY": LIVE_KEY } }).catch(() => {});
}

console.log(`\n${skipped} step(s) skipped with explicit reasons (not counted as passed).`);
const ok = summary(join(SHOTS, "round11", "round11-sandbox-stats.json"));
db.close();
await browser.close();
await server.stop();
process.exitCode = ok ? 0 : 1;
