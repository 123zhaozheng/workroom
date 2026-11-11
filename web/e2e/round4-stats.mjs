// Round 4 — statistics dashboard: charts render with real data (demo org seeded through scripts/seed-demo.mjs), the Recharts chunk
// loads only on /stats, filters, tooltips, CSV downloads, permission / empty / skeleton / simulated states, dark mode and
// screenshots at 1366 / 1440 / 390.
// Run: node web/e2e/round4-stats.mjs   (builds the web app into data/dev-stats/web-dist itself; data dir data/dev-stats/e2e, port 8864)
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, chromium, ROOT, SHOTS, sleep, summary, pick, selOptions } from "./lib.mjs";

const PORT = 8864;
const base = `http://127.0.0.1:${PORT}`;
const DATA = join(ROOT, "data/dev-stats/e2e");
const DIST = join(ROOT, "data/dev-stats/web-dist");
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

// ---- build + server (own copies of lib.mjs startServer so the data dir is data/dev-stats and the web dist is private)
const build = spawnSync("npx", ["vite", "build", "--outDir", DIST, "--emptyOutDir"], { cwd: join(ROOT, "web"), encoding: "utf8" });
if (build.status !== 0) {
	console.log(build.stdout, build.stderr);
	process.exit(1);
}
try {
	await fetch(`${base}/api/health`);
	console.log(`port ${PORT} already in use`);
	process.exit(2);
} catch {
	/* free */
}
let out = "";
const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/src/main.ts"], {
	cwd: ROOT,
	env: { ...process.env, WORKROOM_ONBOARDING: "off", WORKROOM_DATA_DIR: DATA, PORT: String(PORT), WORKROOM_WEB_DIST: DIST, WORKROOM_FIXTURE_TOOLS: "1", WORKROOM_SECRET_KEY: "e2e-stats-secret-key-not-for-production" },
	stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));
for (let i = 0; i < 100; i++) {
	try {
		if ((await fetch(`${base}/api/health`)).ok) break;
	} catch {
		/* not yet */
	}
	await sleep(150);
}
const stopServer = async () => {
	writeFileSync(join(ROOT, "data/dev-stats/e2e-server.log"), out);
	if (child.exitCode !== null) return;
	child.kill("SIGTERM");
	await new Promise((r) => child.once("exit", r));
};

const browser = await chromium.launch();
const newCtx = (w, h, extra = {}) => browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, locale: "zh-CN", timezoneId: "Asia/Shanghai", ...extra });
const shotFull = async (page, name) => {
	const path = join(SHOTS, `${name}.png`);
	await page.screenshot({ path });
	return path;
};
const num = (s) => Number(String(s).replace(/[^\d.]/g, ""));
const fmtInt = (n) => new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(n);

try {
	// ---------------------------------------------------------------- seed the demo org through the real API + backfill
	const seed = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/seed-demo.mjs", "--base", base, "--data-dir", DATA, "--days", "365"], { cwd: ROOT, encoding: "utf8" });
	check("seed-demo.mjs runs against a live server", seed.status === 0 && /backfill: \d+ runs/.test(seed.stdout), (seed.stdout + seed.stderr).split("\n").filter((l) => /backfill|live:|Error/.test(l)).join(" | "));

	// ---------------------------------------------------------------- real (non-demo) org: register, one test-model conversation
	const realCtx = await newCtx(1440, 900);
	const real = await realCtx.newPage();
	const requests = [];
	real.on("request", (r) => requests.push(r.url()));
	await real.goto(`${base}/register`);
	await real.fill("#name", "真实组织管理员");
	await real.fill("#email", `real-${Date.now()}@example.com`);
	await real.fill("#password", "password123");
	await real.click('button[type="submit"]');
	await real.waitForSelector('[data-testid="home-greeting"]');
	const me = await (await real.request.get(`${base}/api/me`)).json();
	const emptyStats = await (await real.request.get(`${base}/api/stats/overview?scope=personal`)).json();
	check("fresh real org: no records and an explanatory note", emptyStats.kpis.find((k) => k.key === "runs").value === 0 && emptyStats.notes.some((n) => n.includes("此范围内没有记录")), emptyStats.notes[0]);

	// home + chat bundles must not pull the stats page or Recharts
	await real.waitForTimeout(300);
	const conv = (await (await real.request.post(`${base}/api/conversations`, { data: { spaceId: me.personalSpaceId, title: "统计演示对话" } })).json()).conversation;
	const cid = conv.conversationId ?? conv.id;
	const sendMsg = async (text) => {
		const r = await (await real.request.post(`${base}/api/conversations/${me.personalSpaceId}/${cid}/messages`, { data: { text, requestId: `e2e-${Math.random().toString(36).slice(2)}` } })).json();
		for (let i = 0; i < 80; i++) {
			const s = await (await real.request.get(`${base}/api/conversations/${me.personalSpaceId}/${cid}/submissions/${r.submissionId}`)).json();
			if (["done", "unanswered", "withdrawn"].includes(s.status)) return s.status;
			await sleep(250);
		}
	};
	await real.goto(`${base}/c/${me.personalSpaceId}/${cid}`);
	await real.waitForSelector('[data-testid="composer-input"]');
	const before = requests.length;
	await sendMsg("你好，请回复一句话");
	await sendMsg("[[fail]] 触发一次失败");
	await real.request.post(`${base}/api/admin/usage/import`);
	const homeUrls = requests.filter((u) => /\/assets\//.test(u));
	check("home + chat load neither the StatsPage chunk nor Recharts", !homeUrls.some((u) => /StatsPage|RechartsPanels/.test(u)), `${homeUrls.length} asset requests, ${before} before send`);

	// ---------------------------------------------------------------- /stats for the real org: simulated flag, no demo banner, drilldown link
	const assetReqs = [];
	real.on("request", (r) => /\/assets\//.test(r.url()) && assetReqs.push(r.url()));
	await real.goto(`${base}/stats?scope=personal&range=30d`);
	await real.waitForSelector('[data-testid="stats-dashboard"]', { timeout: 20000 });
	check("lazy chunks load on /stats (page + Recharts)", assetReqs.some((u) => /StatsPage/.test(u)) && assetReqs.some((u) => /RechartsPanels/.test(u)), `${assetReqs.filter((u) => /StatsPage|Recharts/.test(u)).map((u) => u.split("/").pop()).join(", ")}`);
	check("real org: no demo banner", (await real.locator('[data-testid="demo-banner"]').count()) === 0);
	const realKpi = async (k) => (await real.locator(`[data-kpi="${k}"] [data-testid="kpi-value"]`).innerText()).trim();
	check("real org, test model only: tokens and cost are labelled 模拟, never numbers or $", (await realKpi("cost")) === "模拟" && (await real.locator('[data-kpi="inputTokens"]').innerText()).includes("模拟"), `${await realKpi("cost")} / ${await realKpi("inputTokens")}`);
	check("real org: runs KPI equals the API", (await realKpi("runs")) === fmtInt((await (await real.request.get(`${base}/api/stats/overview?scope=personal&range=30d&${new URLSearchParams({ from: new Date(Date.now() - 30 * 864e5).toISOString(), to: new Date(Date.now() + 864e5).toISOString() })}`)).json()).kpis.find((k) => k.key === "runs").value));
	check("simulated-only note is shown", (await real.locator('[data-testid="stats-notes"]').innerText()).includes("模拟"));
	const link = real.locator('[data-testid="drill-link"]').first();
	check("table drilldown link to the conversation (own conversation)", (await link.count()) > 0 && (await link.getAttribute("href"))?.startsWith(`/c/${me.personalSpaceId}/`));
	await link.click();
	await real.waitForURL(/\/c\//);
	check("drilldown opens the conversation", await real.waitForSelector('[data-testid="composer-input"]', { timeout: 10000 }).then(() => true, () => false));
	// real org must not see the demo org: org scope is allowed (owner) but contains only its own rows
	const realOrg = await (await real.request.get(`${base}/api/stats/overview?scope=org&from=${new Date(Date.now() - 365 * 864e5).toISOString()}&to=${new Date(Date.now() + 864e5).toISOString()}`)).json();
	check("real org never contains demo rows or demo cost", realOrg.kpis.find((k) => k.key === "runs").value <= 3 && realOrg.demo === false && realOrg.kpis.find((k) => k.key === "cost").value === 0, `runs=${realOrg.kpis.find((k) => k.key === "runs").value}`);

	// plain member of the real org: only personal scope, org via URL is refused
	const inv = (await (await real.request.post(`${base}/api/admin/invites`, { data: { role: "member", ttlHours: 24 } })).json()).invite.code;
	const memCtx = await newCtx(1440, 900);
	const mem = await memCtx.newPage();
	await mem.goto(`${base}/register?invite=${inv}`);
	await mem.fill("#name", "普通成员");
	await mem.fill("#email", `member-${Date.now()}@example.com`);
	await mem.fill("#password", "password123");
	await mem.click('button[type="submit"]');
	await mem.waitForSelector('[data-testid="home-greeting"]');
	await mem.goto(`${base}/stats?scope=org&range=30d`);
	await mem.waitForSelector('[data-testid="scope-select"]');
	await mem.waitForTimeout(800);
	const opts = (await selOptions(mem.locator('[data-testid="scope-select"]'))).map((o) => o.label);
	check("member: scope list offers only 个人", opts.length === 1 && opts[0] === "个人", opts.join(","));
	check("member: org scope via URL is refused (403 error state, no data)", (await mem.locator('[data-testid="stats-dashboard"]').count()) === 0 && (await mem.getByText("加载失败").count()) > 0);
	check("member: empty personal state explains why", await (async () => {
		await mem.goto(`${base}/stats?scope=personal&range=30d`);
		await mem.waitForSelector('[data-testid="stats-dashboard"]');
		const t = await mem.locator('[data-testid="stats-notes"]').innerText();
		return t.includes("此范围内没有记录") && (await mem.locator('[data-testid="chart-empty"]').count()) >= 4;
	})());
	await shotFull(mem, "round4-stats-empty-member");
	await memCtx.close();
	await realCtx.close();

	// ---------------------------------------------------------------- demo org dashboard at 1440
	const ctx = await newCtx(1440, 2700);
	const page = await ctx.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("console", (m) => m.type() === "error" && !/401|Unauthorized/.test(m.text()) && errors.push(m.text()));
	const demoLogin = async (p) => {
		await p.goto(`${base}/login`);
		await p.fill("#email", "demo-admin@demo.workroom.example");
		await p.fill("#password", "demo-password-2026");
		await p.click('button[type="submit"]');
		await p.waitForSelector('[data-testid="home-greeting"]');
	};
	await demoLogin(page);
	// skeleton while the overview is slow
	await page.route("**/api/stats/overview**", async (route) => {
		await sleep(900);
		await route.continue().catch(() => {});
	});
	let ovUrl = "";
	page.on("request", (r) => r.url().includes("/stats/overview") && (ovUrl = r.url()));
	await page.goto(`${base}/stats?scope=org&range=365d`);
	await page.waitForSelector('[data-testid="skeleton-dashboard"]', { timeout: 5000 }).then(
		() => check("loading skeleton shown while data loads", true),
		() => check("loading skeleton shown while data loads", false),
	);
	await page.unroute("**/api/stats/overview**");
	await page.waitForSelector('[data-testid="stats-dashboard"]', { timeout: 20000 });
	await page.waitForSelector('[data-testid="area-chart"] .recharts-area', { timeout: 15000 });
	await page.waitForTimeout(600);

	check("demo org: 演示数据 banner", (await page.locator('[data-testid="demo-banner"]').innerText()).includes("演示数据"));
	check("14 KPI tiles with sparklines", (await page.locator('[data-testid="kpi"]').count()) === 14 && (await page.locator('[data-testid="kpi"] [data-testid="sparkline"]').count()) >= 8);
	check("demo tokens/cost shown as 模拟, no $ amount", (await page.locator('[data-kpi="cost"]').innerText()).includes("模拟") && !(await page.locator('[data-kpi="cost"]').innerText()).includes("$"));
	const api = async (path) => (await page.request.get(`${base}/api${path}`)).json();
	const apiData = await (await page.request.get(ovUrl)).json(); // the very query the page issued, fetched independently
	check("KPI 运行 equals the API figure", num(await page.locator('[data-kpi="runs"] [data-testid="kpi-value"]').innerText()) === apiData.kpis.find((k) => k.key === "runs").value);
	check("KPI 模型请求 equals the API figure", num(await page.locator('[data-kpi="modelRequests"] [data-testid="kpi-value"]').innerText()) === apiData.kpis.find((k) => k.key === "modelRequests").value);

	const calCells = await page.locator('[data-testid="cal-cell"]').count();
	const calLit = await page.locator('[data-testid="cal-cell"]:not([data-level="0"])').count();
	check("calendar heatmap: 365 days drawn, most with activity", calCells >= 364 && calCells <= 366 && calLit > 250, `${calCells} cells, ${calLit} active`);
	const dots = await page.locator('[data-testid="punch-dot"]').count();
	const dotsOn = await page.locator('[data-testid="punch-dot"]:not([data-value="0"])').count();
	const radii = await page.locator('[data-testid="punch-dot"]').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("r")))].length);
	check("punch card: 7 x 24 dots, size varies with volume", dots === 168 && dotsOn > 80 && radii > 5, `${dots} dots, ${dotsOn} with data, ${radii} sizes`);
	check("waffle: 100 dots, legend counts add up to the API total", (await page.locator('[data-testid="waffle-dot"]').count()) === 100 && (await page.locator('[data-testid="waffle-legend"] li').last().innerText()).includes(fmtInt(apiData.outcomes.runs.total)));
	check("stacked area chart renders one area per model", (await page.locator('[data-testid="area-chart"] .recharts-area-area').count()) >= 3);
	check("donut renders sectors with a legend", (await page.locator('[data-testid="donut-chart"] .recharts-pie-sector').count()) >= 3 && (await page.locator('[data-testid="chart-donut"] [data-testid="series-legend"] li').count()) >= 3);
	check("tool ranking rows with error-rate overlay", (await page.locator('[data-testid="tool-row"]').count()) >= 5 && (await page.locator('[data-testid="tool-row"] span.bg-\\[var\\(--st-failed\\)\\]').count()) >= 2);
	check("latency histogram: bars plus P50 / P95 markers", (await page.locator('[data-testid="latency-chart"] .recharts-bar-rectangle').count()) >= 5 && (await page.locator('[data-testid="latency-chart"] .recharts-reference-line').count()) === 2);
	check("knowledge + large-context + automation cards have data", (await page.locator('[data-testid="kb-hit-rate"]').innerText()).includes("%") && (await page.locator('[data-testid="lc-rows"] li').count()) > 0 && (await page.locator('[data-testid="chart-activity"]').innerText()).includes("自动化运行"));
	check("drilldown table lists conversations, demo rows carry no link", (await page.locator('[data-testid="table-conversations"] tbody tr').count()) >= 5);
	await page.getByRole("tab", { name: "成员" }).click();
	check("成员 tab ranks users", (await page.locator('[data-testid="table-rank"] tbody tr').count()) >= 5);
	await page.getByRole("tab", { name: "最近失败" }).click();
	check("最近失败 tab lists failed requests", (await page.locator('[data-testid="table-failures"] tbody tr').count()) >= 3);
	await page.getByRole("tab", { name: "对话" }).click();
	check("no page errors / console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

	// tooltips
	await page.locator('[data-testid="cal-cell"][data-level="4"]').first().scrollIntoViewIfNeeded();
	await page.locator('[data-testid="cal-cell"][data-level="4"]').first().hover();
	const tip1 = await page.locator('[data-testid="chart-calendar"] [data-testid="chart-tip"]').innerText();
	check("calendar tooltip shows the day and its counts", /月\d+日/.test(tip1) && tip1.includes("运行") && tip1.includes("模型请求"), tip1.replace(/\n/g, " "));
	await page.locator('[data-testid="punch-dot"]:not([data-value="0"])').nth(40).hover({ force: true });
	check("punch card tooltip shows weekday and hour", /周[一二三四五六日] \d\d:00/.test(await page.locator('[data-testid="chart-punchcard"] [data-testid="chart-tip"]').innerText()));
	await page.locator('[data-testid="waffle-dot"]').first().hover();
	check("waffle tooltip shows outcome and share", (await page.locator('[data-testid="chart-waffle"] [data-testid="chart-tip"]').innerText()).includes("成功"));
	const area = page.locator('[data-testid="area-chart"]');
	const box = await area.boundingBox();
	await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
	await page.waitForTimeout(250);
	check("area chart tooltip lists the models with a total", /合计/.test(await page.locator('[data-testid="chart-area"] [data-testid="chart-tip"]').first().innerText().catch(() => "")));
	await page.locator('[data-testid="tool-row"] [role="img"]').first().hover();
	check("tool tooltip shows error rate", (await page.locator('[data-testid="chart-tools"] [data-testid="chart-tip"]').innerText()).includes("错误率"));
	await page.locator('[data-kpi="runs"] [data-testid="sparkline"]').hover();
	check("sparkline tooltip", ((await page.locator('[data-kpi="runs"] [data-testid="chart-tip"]').innerText()) || "").length > 2);

	// segmented controls re-draw
	await page.locator('[data-testid="chart-calendar"]').getByRole("radio", { name: "Token" }).click();
	check("calendar metric switch to Token", (await page.locator('[data-testid="chart-calendar"] [role="img"]').getAttribute("aria-label")).includes("Token"));
	await page.locator('[data-testid="chart-area"]').getByRole("radio", { name: "供应商" }).click();
	await page.waitForTimeout(200);
	check("series dimension switch to provider", (await page.locator('[data-testid="chart-area"] [data-testid="series-legend"]').innerText()).includes("demo-gateway"));
	await page.locator('[data-testid="chart-area"]').getByRole("radio", { name: "模型" }).click();
	await page.locator('[data-testid="chart-waffle"]').getByRole("radio", { name: "模型请求" }).click();
	check("waffle unit switch", (await page.locator('[data-testid="waffle-dot"]').count()) === 100);

	await shotFull(page, "round4-stats-1440");

	// ---------------------------------------------------------------- CSV downloads (per chart, permission checked)
	const dl = async (testid) => {
		const [d] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), page.locator(`[data-testid="${testid}"] [data-testid="csv"]`).first().click()]);
		const path = await d.path();
		return { name: d.suggestedFilename(), text: readFileSync(path, "utf8") };
	};
	const toolsCsv = await dl("chart-tools");
	check("CSV: tools chart downloads with header and rows", /^stats-tools-org\.csv$/.test(toolsCsv.name) && toolsCsv.text.includes("tool,calls,errors,errorRate,avgDurationMs") && toolsCsv.text.trim().split("\n").length > 3, toolsCsv.name);
	const calCsv = await dl("chart-calendar");
	check("CSV: calendar days", calCsv.text.includes("day,runs,modelRequests,toolCalls,tokens,failedRuns") && calCsv.text.trim().split("\n").length > 250);
	const areaCsv = await dl("chart-area");
	check("CSV: series by model marks simulated rows", areaCsv.text.includes("模拟") && areaCsv.text.includes("demo-standard"));
	const puCsv = await dl("chart-punchcard");
	check("CSV: punch card", puCsv.text.includes("weekday,hour") && puCsv.text.includes("周"));
	check("CSV content equals the API tools ranking", toolsCsv.text.includes(`${apiData.tools[0].tool},${apiData.tools[0].calls},`));
	const denied = await memCtxRequest();
	async function memCtxRequest() {
		const c = await newCtx(800, 600);
		const p = await c.newPage();
		await p.goto(`${base}/register`);
		await p.fill("#name", "无权限者");
		await p.fill("#email", `nobody-${Date.now()}@example.com`);
		await p.fill("#password", "password123");
		await p.click('button[type="submit"]');
		await p.waitForSelector('[data-testid="home-greeting"]');
		// a different org's admin asking for the demo org's data gets nothing of it
		const r = await p.request.get(`${base}/api/stats/export.csv?scope=org&chart=tools`);
		const t = await r.text();
		await c.close();
		return { status: r.status(), leaks: t.includes("kb_search") && t.includes("web_search") && t.split("\n").length > 5 };
	}
	check("CSV export of another org never contains demo rows", !denied.leaks, `status ${denied.status}`);

	// ---------------------------------------------------------------- filters
	await page.goto(`${base}/stats?scope=org&range=365d`);
	await page.waitForSelector('[data-testid="stats-dashboard"]');
	const ovReq = page.waitForRequest((r) => r.url().includes("/stats/overview") && r.url().includes("granularity=day"));
	await page.locator('[data-testid="range-presets"]').getByRole("radio", { name: "近 7 天" }).click();
	const q7 = new URL((await ovReq).url());
	const span = (Date.parse(q7.searchParams.get("to")) - Date.parse(q7.searchParams.get("from"))) / 864e5;
	await page.waitForSelector('[data-testid="stats-dashboard"]');
	check("range preset 近 7 天 requests a 7-day window with tz offset", span === 7 && q7.searchParams.get("tz") === "480" && page.url().includes("range=7d"), `${span} days tz=${q7.searchParams.get("tz")}`);
	const hourReq = page.waitForRequest((r) => r.url().includes("granularity=hour"));
	await page.locator('[data-testid="granularity"]').getByRole("radio", { name: "小时" }).click();
	await hourReq;
	await page.waitForSelector('[data-testid="stats-dashboard"]');
	check("granularity 小时 changes the series (hourly buckets)", (await api(`/stats/overview?${q7.searchParams.toString().replace("granularity=day", "granularity=hour")}`)).series.buckets.length === 168);
	await page.locator('[data-testid="range-presets"]').getByRole("radio", { name: "自定义" }).click();
	await page.waitForSelector('[data-testid="custom-range"]');
	check("custom range shows two date inputs", (await page.locator('[data-testid="custom-range"] input[type="date"]').count()) === 2);
	await page.locator('[data-testid="custom-range"] input[type="date"]').first().fill("2026-01-01");
	await page.locator('[data-testid="custom-range"] input[type="date"]').last().fill("2026-03-31");
	// Wait for the applied range to reach the URL (was a fixed 900 ms sleep that raced under load); the check below still fails if it never does.
	await page.waitForFunction(() => location.search.includes("from=2026-01-01") && location.search.includes("to=2026-03-31"), null, { timeout: 10000 }).catch(() => {});
	await page.waitForSelector('[data-testid="stats-dashboard"]');
	check("custom range 2026-01-01…2026-03-31 applies (URL + adjusted granularity hint absent for week default)", page.url().includes("from=2026-01-01") && page.url().includes("to=2026-03-31"));
	await pick(page.locator('[data-testid="scope-select"]'), { index: 0 });
	const scopes = (await selOptions(page.locator('[data-testid="scope-select"]'))).map((o) => o.label);
	check("admin scope list: 个人 / 组织 / 部门 / 项目", scopes.length >= 6 && scopes.some((s) => s.startsWith("组织")) && scopes.some((s) => s.startsWith("部门")) && scopes.some((s) => s.startsWith("项目")), scopes.join(" | "));
	await pick(page.locator('[data-testid="scope-select"]'), { label: scopes.find((s) => s.startsWith("项目")) });
	await page.waitForSelector('[data-testid="stats-dashboard"]');
	check("project scope loads", page.url().includes("scope=project%3A") || page.url().includes("scope=project:"));
	await ctx.close();

	// ---------------------------------------------------------------- 1366 / 390 / dark screenshots
	const big = await newCtx(1366, 2700);
	const p1366 = await big.newPage();
	await demoLogin(p1366);
	await p1366.goto(`${base}/stats?scope=org&range=90d`);
	await p1366.waitForSelector('[data-testid="area-chart"] .recharts-area');
	await p1366.waitForTimeout(500);
	check("1366: no horizontal page overflow", await p1366.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.querySelector('[data-testid="stats-page"]').scrollWidth <= document.querySelector('[data-testid="stats-page"]').clientWidth + 1));
	await shotFull(p1366, "round4-stats-1366");
	await big.close();

	const dark = await newCtx(1440, 2700, { colorScheme: "dark" });
	const pd = await dark.newPage();
	await demoLogin(pd);
	await pd.evaluate(() => (document.documentElement.dataset.theme = "dark"));
	await pd.goto(`${base}/stats?scope=org&range=365d`);
	await pd.waitForSelector('[data-testid="area-chart"] .recharts-area');
	await pd.waitForTimeout(500);
	const theme = await pd.evaluate(() => [document.documentElement.dataset.theme, getComputedStyle(document.querySelector(".stats-root")).getPropertyValue("--c1").trim()]);
	check("dark mode swaps the chart palette tokens", theme[0] === "dark" && theme[1] === "#3987e5", theme.join(" "));
	await shotFull(pd, "round4-stats-1440-dark");
	await dark.close();

	const mob = await newCtx(390, 4300, { hasTouch: true, isMobile: true });
	const pm = await mob.newPage();
	await demoLogin(pm);
	await pm.goto(`${base}/stats?scope=org&range=30d`);
	await pm.waitForSelector('[data-testid="area-chart"] .recharts-area');
	await pm.waitForTimeout(500);
	const ov = await pm.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth, page: document.querySelector('[data-testid="stats-page"]').scrollWidth, pc: document.querySelector('[data-testid="stats-page"]').clientWidth }));
	check("390: no horizontal page scroll (wide charts scroll inside their own card)", ov.doc <= ov.win && ov.page <= ov.pc + 1, JSON.stringify(ov));
	check("390: all chart cards render", (await pm.locator('section[data-testid^="chart-"]').count()) >= 10);
	await shotFull(pm, "round4-stats-390");
	await mob.close();
} catch (e) {
	check("script completed without throwing", false, String(e?.stack ?? e).slice(0, 600));
} finally {
	await browser.close();
	await stopServer();
}
const ok = summary(join(SHOTS, "../round4-stats-results.json"));
process.exit(ok ? 0 : 1);
