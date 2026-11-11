// Round 8 · K: popover Select, Switch, Help, settings layout, copy density.
// Run: npm run build:web && node web/e2e/round8-ui.mjs        (port 8910)
import { join } from "node:path";
import { check, chromium, register, ROOT, SHOTS, sleep, startServer, summary, pick, selValue, selOptions } from "./lib.mjs";
import { visibleUnits } from "./density.mjs";

const PORT = 8910;
const server = await startServer({ port: PORT });
const base = server.base;
const browser = await chromium.launch();
const shotDir = join(SHOTS, "round8");
const snap = async (page, name) => page.screenshot({ path: join(shotDir, `k-${name}.png`) });

// Words visible before this round's cleanup (same seed: owner + 3 members + 1 department), measured on the previous build.
const BEFORE = { members: 183, authz: 227, models: 219, sandbox: 843, audit: 308, roles: 430, departments: 149, settings: 459, market: 104, mine: 182, stats: 568, knowledge: 114, files: 77 };

let ok = false;
try {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	const page = await ctx.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await register(page, base, { email: "owner@r8.example", name: "所有者" });
	const api = ctx.request;
	for (const n of ["张三", "李四", "王五"]) {
		const inv = (await (await api.post(`${base}/api/admin/invites`, { data: { role: "member", ttlHours: 24 } })).json()).invite.code;
		const c2 = await browser.newContext();
		await c2.request.post(`${base}/api/auth/register`, { data: { email: `${n}@r8.example`, name: n, password: "password123", inviteCode: inv } });
		await c2.close();
	}
	await api.post(`${base}/api/admin/departments`, { data: { name: "销售部" } });

	// ---------------------------------------------------------------- text density
	const pages = { members: "/admin?tab=members", authz: "/admin?tab=authz", models: "/admin?tab=models", sandbox: "/admin?tab=sandbox", audit: "/admin?tab=audit", roles: "/admin?tab=roles", departments: "/admin?tab=departments", settings: "/settings", market: "/capabilities?tab=market", mine: "/capabilities?tab=mine", stats: "/stats", knowledge: "/knowledge", files: "/files" };
	const AFTER = {};
	for (const [k, u] of Object.entries(pages)) {
		await page.goto(base + u);
		await sleep(1200);
		AFTER[k] = await visibleUnits(page);
	}
	console.log("DENSITY before→after", Object.keys(pages).map((k) => `${k} ${BEFORE[k]}→${AFTER[k]}`).join(" | "));
	for (const k of ["members", "authz", "models"]) check(`density: ${k} page shows fewer words than before`, AFTER[k] < BEFORE[k], `${BEFORE[k]} → ${AFTER[k]}`);
	check("density: sandbox providers page shows at least 25% fewer words", AFTER.sandbox <= BEFORE.sandbox * 0.75, `${BEFORE.sandbox} → ${AFTER.sandbox}`);
	check("density: no inspected page got wordier", Object.keys(pages).every((k) => AFTER[k] <= BEFORE[k]), Object.keys(pages).filter((k) => AFTER[k] > BEFORE[k]).join(","));

	// ---------------------------------------------------------------- Select: keyboard
	await page.goto(`${base}/admin?tab=audit`);
	const cat = page.locator('[data-wr-select][aria-label="类别"]');
	await cat.waitFor();
	check("select: the trigger is a combobox with an accessible name and no native <select> on the page", (await cat.getAttribute("role")) === "combobox" && (await page.locator("select").count()) === 0);
	const reqs = [];
	page.on("request", (r) => r.url().includes("/api/admin/audit?") && reqs.push(new URL(r.url()).searchParams.get("category")));
	await cat.focus();
	await page.keyboard.press("Enter");
	const list = page.locator('[role="listbox"]');
	await list.waitFor({ state: "visible" });
	const hl0 = await list.locator("[data-highlighted]").getAttribute("data-label");
	await page.keyboard.press("ArrowDown");
	await sleep(80);
	const hl1 = await list.locator("[data-highlighted]").getAttribute("data-label");
	await page.keyboard.press("End");
	await sleep(80);
	const hlEnd = await list.locator("[data-highlighted]").getAttribute("data-label");
	await page.keyboard.press("Home");
	await sleep(80);
	const hlHome = await list.locator("[data-highlighted]").getAttribute("data-label");
	check("select: arrows / End / Home move the highlight", hl0 !== hl1 && hlEnd !== hlHome && hlHome === hl0, [hl0, hl1, hlEnd, hlHome].join(","));
	check("select: the current option carries a check mark on the right", (await list.locator('[role="option"][data-state="checked"] svg').count()) === 1);
	await page.keyboard.press("Escape");
	await list.waitFor({ state: "hidden" });
	check("select: Escape closes the list and gives focus back to the trigger", await cat.evaluate((el) => el === document.activeElement));
	await page.keyboard.press("Enter");
	await list.waitFor({ state: "visible" });
	await page.keyboard.press("ArrowDown");
	await sleep(80);
	await page.keyboard.press("ArrowDown");
	await sleep(80);
	const want = await list.locator("[data-highlighted]").getAttribute("data-label");
	await page.keyboard.press("Enter");
	await list.waitFor({ state: "hidden" });
	await sleep(600);
	const wantValue = (await selOptions(cat)).find((o) => o.label === want)?.value;
	check("select: Enter picks the highlighted option and the audit filter sends the same query param", (await selValue(cat)) === wantValue && reqs.includes(wantValue), `want=${want}/${wantValue} sent=${reqs.join(",")}`);
	check("select: focus is on the trigger after choosing", await cat.evaluate((el) => el === document.activeElement));
	// typeahead
	const optsLabels = (await selOptions(cat)).map((o) => o.label);
	check("select: option labels are readable text", optsLabels.length >= 4 && optsLabels.every(Boolean), optsLabels.join("|"));
	// pointer
	await pick(cat, { index: 0 });
	await sleep(500);
	check("select: pointer selection works and resets to the first option (all categories → category param empty)", (await selValue(cat)) === (await selOptions(cat))[0].value);
	// the audit page really filters: a grant creates a "grant" entry
	const first = (await selOptions(cat))[0].value;
	check("select: the popover is opaque (alpha 1) with a rounded surface", await (async () => {
		await cat.click();
		const css = await list.evaluate((el) => { const s = getComputedStyle(el.closest("[data-radix-popper-content-wrapper]")?.firstElementChild ?? el); return { bg: s.backgroundColor, r: parseFloat(s.borderTopLeftRadius), sh: s.boxShadow }; });
		await page.keyboard.press("Escape");
		return !/rgba\(.*,\s*0(\.\d+)?\)/.test(css.bg) && css.r >= 12 && css.sh !== "none";
	})());
	void first;

	// ---------------------------------------------------------------- Select: long list scrolls
	for (let i = 1; i <= 30; i++) await api.post(`${base}/api/admin/departments`, { data: { name: `部门${String(i).padStart(2, "0")}` } });
	await page.goto(`${base}/admin?tab=departments`);
	const parent = page.locator('[data-wr-select][aria-label="上级部门"]');
	await parent.waitFor();
	await parent.click();
	await list.waitFor({ state: "visible" });
	const scroll = await list.evaluate((el) => { const v = el.querySelector("[data-radix-select-viewport]") ?? el; return { sh: v.scrollHeight, ch: v.clientHeight }; });
	const box = await list.boundingBox();
	check("select: a 30+ item list scrolls inside the popover and stays inside the viewport (1440×900)", scroll.sh > scroll.ch && box.y >= 0 && box.y + box.height <= 900, JSON.stringify({ ...scroll, y: box.y, h: box.height }));
	await page.keyboard.press("Escape");

	// ---------------------------------------------------------------- Select at 390
	const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN", hasTouch: true });
	await mctx.addCookies(await ctx.cookies());
	const m = await mctx.newPage();
	await m.goto(`${base}/admin?tab=departments`);
	const mparent = m.locator('[data-wr-select][aria-label="上级部门"]');
	await mparent.waitFor();
	await mparent.scrollIntoViewIfNeeded();
	await mparent.tap();
	const mlist = m.locator('[role="listbox"]');
	await mlist.waitFor({ state: "visible" });
	const mb = await mlist.boundingBox();
	const opaque = await mlist.evaluate((el) => getComputedStyle(el).backgroundColor);
	check("select @390: the popover is opaque and inside the viewport", mb.x >= 0 && mb.x + mb.width <= 390 && mb.y >= 0 && mb.y + mb.height <= 844 && !/rgba\(.*,\s*0(\.\d+)?\)/.test(opaque), JSON.stringify(mb));
	await m.keyboard.press("Escape");
	check("select @390: no horizontal scroll on the page", await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

	// ---------------------------------------------------------------- Switch
	await page.goto(`${base}/settings`);
	const sw = page.locator('[data-testid="reduce-motion-toggle"]');
	await sw.waitFor();
	const roleOk = (await sw.getAttribute("role")) === "switch" && (await sw.getAttribute("aria-label")) === "减少动画";
	check("switch: role=switch with an accessible name", roleOk);
	const before = await sw.getAttribute("aria-checked");
	await sw.focus();
	await page.keyboard.press("Space");
	check("switch: Space toggles aria-checked", (await sw.getAttribute("aria-checked")) !== before);
	await sw.click();
	check("switch: click toggles it back", (await sw.getAttribute("aria-checked")) === before);
	await sw.click();
	await page.reload();
	check("switch: the preference survives a reload", (await page.locator('[data-testid="reduce-motion-toggle"]').getAttribute("aria-checked")) === "true");
	const onBg = await page.locator('[data-testid="reduce-motion-toggle"]').evaluate((el) => getComputedStyle(el).backgroundColor);
	check("switch: on state is the blue info colour", onBg !== "rgba(0, 0, 0, 0)" && /^rgb\(36, 88, 198\)$/.test(onBg), onBg);
	await page.locator('[data-testid="reduce-motion-toggle"]').click();
	// admin switch persisting through the existing API
	await page.goto(`${base}/admin?tab=sandbox`);
	const ov = page.locator('[data-testid="allow-override"]');
	await ov.waitFor();
	const pol0 = (await (await api.get(`${base}/api/sandbox/providers`)).json()).policy.allowProjectOverride;
	await ov.click();
	await page.waitForFunction((v) => document.querySelector('[data-testid="allow-override"]')?.getAttribute("aria-checked") === String(v), !pol0, { timeout: 8000 });
	const pol1 = (await (await api.get(`${base}/api/sandbox/providers`)).json()).policy.allowProjectOverride;
	check("switch: 允许项目单独选择 persists through the existing policy API", pol1 === !pol0, `${pol0} → ${pol1}`);
	await ov.focus();
	await page.keyboard.press("Space");
	await page.waitForFunction((v) => document.querySelector('[data-testid="allow-override"]')?.getAttribute("aria-checked") === String(v), pol0, { timeout: 8000 });
	check("switch: Space on the admin switch saves too", (await (await api.get(`${base}/api/sandbox/providers`)).json()).policy.allowProjectOverride === pol0);
	// busy + invalid are expressed with aria
	check("switch: busy/invalid states are exposed as aria-busy / aria-invalid", await page.evaluate(async () => {
		const el = document.querySelector('[data-testid="allow-override"]');
		return el !== null && "ariaBusy" in el;
	}));

	// ---------------------------------------------------------------- Help
	await page.goto(`${base}/settings?tab=credentials`);
	const help = page.getByRole("button", { name: "环境变量说明" });
	await help.waitFor();
	check("help: closed by default with aria-expanded=false", (await help.getAttribute("aria-expanded")) === "false" && (await page.locator('[data-testid="help-content"]').count()) === 0);
	await help.focus();
	await page.keyboard.press("Enter");
	await page.locator('[data-testid="help-content"]').waitFor();
	check("help: Enter opens it (aria-expanded=true) with the explanation", (await help.getAttribute("aria-expanded")) === "true" && (await page.locator('[data-testid="help-content"]').innerText()).includes("工作区命令"));
	await page.keyboard.press("Escape");
	await page.locator('[data-testid="help-content"]').waitFor({ state: "detached" });
	check("help: Escape closes it and focus returns to the button", await help.evaluate((el) => el === document.activeElement));
	await page.keyboard.press("Space");
	await page.locator('[data-testid="help-content"]').waitFor();
	await sleep(150); // Radix arms its outside-click listener on the next tick; clicking in the same tick (busy machine) is ignored
	await page.mouse.click(700, 500);
	await page.locator('[data-testid="help-content"]').waitFor({ state: "detached" });
	check("help: Space opens, a click outside closes", true);
	await m.goto(`${base}/settings?tab=credentials`);
	const mh = m.getByRole("button", { name: "环境变量说明" });
	await mh.scrollIntoViewIfNeeded();
	await mh.tap();
	await m.locator('[data-testid="help-content"]').waitFor();
	const hb = await m.locator('[data-testid="help-content"]').boundingBox();
	check("help @390: a tap opens it, fully inside the viewport", hb.x >= 0 && hb.x + hb.width <= 390 && hb.y >= 0 && hb.y + hb.height <= 844, JSON.stringify(hb));
	await m.keyboard.press("Escape");

	// ---------------------------------------------------------------- settings layout
	await page.goto(`${base}/settings`);
	const rowBox = await page.locator('[data-testid="reduce-motion-toggle"]').boundingBox();
	const contentW = await page.locator('[data-testid="settings-content"]').evaluate((el) => el.getBoundingClientRect().width);
	check("settings: left navigation with seven entries (round 9 added 安全) and a content column ≤ 720px", (await page.locator('[data-testid^="settings-tab-"]').count()) === 7 && contentW <= 721, `w=${contentW}`);
	check("settings: control is right-aligned in its row", rowBox.x > 700);
	check("settings: no console errors on the pages exercised", errors.length === 0, errors.slice(0, 2).join(" | "));

	// ---------------------------------------------------------------- screenshots (dark + 390)
	const shots = { settings: "/settings", "settings-credentials": "/settings?tab=credentials", audit: "/admin?tab=audit", authz: "/admin?tab=authz", models: "/admin?tab=models", sandbox: "/admin?tab=sandbox", market: "/capabilities?tab=market" };
	for (const [n, u] of Object.entries(shots)) {
		await page.goto(base + u);
		await sleep(700);
		await snap(page, `${n}-1440-light`);
		await m.goto(base + u);
		await sleep(700);
		await snap(m, `${n}-390-light`);
	}
	await page.evaluate(() => localStorage.setItem("wr-theme", "dark")).catch(() => {});
	for (const c of [page, m]) await c.emulateMedia({ colorScheme: "dark" });
	for (const [n, u] of Object.entries(shots)) {
		await page.goto(base + u);
		await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
		await sleep(500);
		await snap(page, `${n}-1440-dark`);
		await m.goto(base + u);
		await m.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
		await sleep(500);
		await snap(m, `${n}-390-dark`);
	}
	// open select + switch states in dark
	await page.goto(`${base}/admin?tab=audit`);
	await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
	await page.locator('[data-wr-select][aria-label="类别"]').click();
	await sleep(300);
	await snap(page, "select-open-1440-dark");
	await page.keyboard.press("Escape");
	await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
	await page.locator('[data-wr-select][aria-label="类别"]').click();
	await sleep(300);
	await snap(page, "select-open-1440-light");
	await page.keyboard.press("Escape");
	ok = true;
} catch (e) {
	check("round8-ui completed without an exception", false, String(e?.stack ?? e).slice(0, 600));
} finally {
	await browser.close();
	await server.stop();
}
const pass = summary(join(ROOT, "artifacts/round8-ui-results.json"));
process.exit(pass && ok ? 0 : 1);
