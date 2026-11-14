// 能力页改版: no 连接市场 tab; every skill card has an icon (author's choice → keyword guess → stable default) in a card grid;
// the author can pick an icon (persisted on the skill). Run: npm run -s build:web && node web/e2e/capability-icons.mjs   (port 8862; SHOTS_DIR overrides)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { check, chromium, register, sleep, startServer, summary, SHOTS } from "./lib.mjs";

const DIR = process.env.SHOTS_DIR || join(SHOTS, "capability-icons");
mkdirSync(DIR, { recursive: true });
const server = await startServer({ port: 8862 });
const base = server.base;
const browser = await chromium.launch();
const T = (id) => `[data-testid="${id}"]`;

const SKILLS = [
	["weekly-report", "周报整理", "把本周工作整理成周报：本周完成、下周计划、风险。", {}],
	["contract-review", "合同审查助手", "逐条审查合同条款，标出风险与修改建议。", {}],
	["excel-summary", "Excel 报表汇总", "汇总多个 Excel 表格并生成透视结果。", {}],
	["meeting-notes", "会议纪要", "把会议录音转写后整理成结构化纪要与待办。", {}],
	["translate-doc", "文档翻译", "中英互译，保留格式与术语表。", { icon: "translate" }],
	["finance-close", "月末结账", "按清单核对科目余额并生成结账报告。", {}],
	["risk-scan", "供应商风控扫描", "扫描供应商风险信号并输出预警。", {}],
	["sql-helper", "SQL 查询助手", "把业务问题改写成 SQL 并解释结果。", { icon: "database" }],
	["zzqx-helper", "Zzqx 小帮手", "一个没有任何分类关键字的技能。", {}],
	["qwvk-x", "Qwvk 小玩意", "另一个落到默认图标的技能。", {}],
];
const md = ([slug, title, desc, o]) => `---\nname: ${slug}\ntitle: ${title}\ndescription: ${desc}\nversion: 1.0.0\n${o.icon ? `icon: ${o.icon}\n` : ""}---\n\n# ${slug}\n`;

try {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "zh-CN" });
	const page = await ctx.newPage();
	await register(page, base, { email: "ci@example.com", name: "图标" });
	const ids = [];
	for (const s of SKILLS) {
		const r = await page.request.post(`${base}/api/market/skills/upload`, { data: { files: [{ path: "SKILL.md", content: md(s) }] } });
		const j = await r.json();
		if (!r.ok()) throw new Error(`upload ${s[0]}: ${JSON.stringify(j)}`);
				ids.push(j.skill.id);
		await page.request.post(`${base}/api/market/skills/${j.skill.id}/force-publish`, { data: { versionNo: j.versionNo, reason: "演示数据", targetScope: "org" } });
	}

	// ---- tabs
	await page.goto(`${base}/capabilities`);
	await page.waitForSelector(T("tab-mine"));
	check("tabs: 技能市场 / 我的技能 / 我的连接, no 连接市场", (await page.locator(T("tab-market")).count()) === 1 && (await page.locator(T("tab-mine")).count()) === 1 && (await page.locator(T("tab-connectors")).count()) === 1 && (await page.locator(T("tab-mcp")).count()) === 0 && !(await page.locator("body").innerText()).includes("连接市场"));

	// ---- skill market
	await page.goto(`${base}/capabilities?tab=market`);
	await page.waitForSelector(T("market-skill"));
	const cards = page.locator(T("market-skill"));
	check("market: one card per skill, each with an icon", (await cards.count()) === SKILLS.length && (await page.locator(`${T("market-skill")} ${T("skill-icon")}`).count()) === SKILLS.length);
	const icon = (slug) => page.locator(`${T("market-skill")}[data-slug="${slug}"] ${T("skill-icon")}`).first();
	const attr = async (slug, a) => icon(slug).getAttribute(a);
	check("market: explicit icon from SKILL.md wins", (await attr("translate-doc", "data-icon")) === "translate" && (await attr("translate-doc", "data-source")) === "explicit" && (await attr("sql-helper", "data-icon")) === "database");
	check("market: keyword match by name (周报→写作, 合同→法务, Excel→表格, 风控→风控, 月末结账→财务)", (await attr("weekly-report", "data-icon")) === "writing" && (await attr("contract-review", "data-icon")) === "legal" && (await attr("excel-summary", "data-icon")) === "spreadsheet" && (await attr("risk-scan", "data-icon")) === "risk" && (await attr("finance-close", "data-icon")) === "finance");
	const icons = Object.fromEntries(await Promise.all(SKILLS.map(async (s) => [s[0], await attr(s[0], "data-icon")])));
	console.log(JSON.stringify(icons));
	check("market: fallback skills get the generic icon with a stable tone", (await attr("zzqx-helper", "data-icon")) === "general" && (await attr("zzqx-helper", "data-source")) === "default" && !!(await attr("zzqx-helper", "data-tone")));
	const m1 = await page.evaluate(() => ({ cols: getComputedStyle(document.querySelector('[data-testid="market-skill"]').parentElement).gridTemplateColumns.split(" ").length, descLines: getComputedStyle(document.querySelector('[data-testid="skill-desc"]')).webkitLineClamp, over: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
	check("market: grid layout, one-line description, no horizontal overflow", m1.cols >= 2 && m1.descLines === "1" && m1.over <= 0, JSON.stringify(m1));
	await page.screenshot({ path: join(DIR, "capability-market.png") });

	// tone is stable across reloads
	const tone1 = await attr("zzqx-helper", "data-tone");
	await page.reload();
	await page.waitForSelector(T("market-skill"));
	check("market: the fallback tone is stable across reloads", tone1 === (await attr("zzqx-helper", "data-tone")));

	// ---- my skills
	await page.goto(`${base}/capabilities?tab=mine`);
	await page.waitForSelector(T("skill"));
	check("mine: skills are a card grid with icons", (await page.locator(T("skill")).count()) === SKILLS.length && (await page.locator(`${T("skill")} ${T("skill-icon")}`).count()) === SKILLS.length && (await page.locator(T("my-skill-grid")).count()) === 1);
	await page.screenshot({ path: join(DIR, "capability-mine.png") });

	// ---- author picks an icon in my skills; it persists and shows in the market
	const card = page.locator(T("skill")).filter({ hasText: "Zzqx 小帮手" });
	await card.locator("button[aria-expanded]").click();
	await card.locator(T("icon-picker")).waitFor();
	check("picker: library has ≥ 24 icons plus 自动", (await card.locator('[data-testid^="icon-opt-"]').count()) >= 24 && (await card.locator(T("icon-auto")).count()) === 1);
	await card.locator(T("icon-opt-finance")).click();
	await page.waitForFunction(() => document.querySelector('[data-testid="skill"] [data-testid="icon-opt-finance"][aria-checked="true"]'), null, { timeout: 8000 });
	await page.screenshot({ path: join(DIR, "capability-mine-picker.png") });
	const api = await (await page.request.get(`${base}/api/market/skills/${ids[8]}`)).json();
	check("picker: the choice is stored on the skill (API)", api.skill.icon === "finance");
	await page.goto(`${base}/capabilities?tab=market`);
	await page.waitForSelector(T("market-skill"));
	check("picker: the market card now shows the chosen icon", (await attr("zzqx-helper", "data-icon")) === "finance" && (await attr("zzqx-helper", "data-source")) === "explicit");
	// 自动 clears it again
	await page.goto(`${base}/capabilities?tab=mine`);
	const card2 = page.locator(T("skill")).filter({ hasText: "Zzqx 小帮手" });
	await card2.locator("button[aria-expanded]").click();
	await card2.locator(T("icon-auto")).click();
	await page.waitForFunction(() => document.querySelector('[data-testid="skill"] [data-testid="icon-auto"][aria-checked="true"]'), null, { timeout: 8000 });
	check("picker: 自动 clears the choice", !(await (await page.request.get(`${base}/api/market/skills/${ids[8]}`)).json()).skill.icon);

	// ---- dark theme + narrow screen
	await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
	await page.goto(`${base}/capabilities?tab=market`);
	await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
	await page.waitForSelector(T("market-skill"));
	await sleep(300);
	await page.screenshot({ path: join(DIR, "capability-market-dark.png") });
	await page.setViewportSize({ width: 390, height: 844 });
	await sleep(300);
	check("narrow 390: no horizontal overflow", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
	await page.screenshot({ path: join(DIR, "capability-market-390.png") });
} catch (e) {
	check("script completed", false, String(e?.stack ?? e).slice(0, 600));
} finally {
	await browser.close();
	await server.stop();
}
process.exit(summary(join(DIR, "capability-icons.json")) ? 0 : 1);
