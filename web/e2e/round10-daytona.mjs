// Round 10: sandbox provider size settings in the admin page (real server). Daytona snapshot/default mode never sends resources;
// image mode takes explicit CPU/memory/disk; invalid combinations are refused with the server's explanation; E2B says the template
// decides. Fake API key only (no network call to Daytona is made: nothing here creates a sandbox).
import { join } from "node:path";
import { check, chromium, pick, register, shot, SHOTS, sleep, startServer, summary } from "./lib.mjs";

const FAKE = `dtn_fake_${Date.now()}_0123456789`;
const server = await startServer({ port: 8930, env: { WORKROOM_SECRET_KEY: "e2e-master-key-round10-0123456789abcdef" } });
const base = server.base;
const browser = await chromium.launch();
try {
	const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
	const bodies = [];
	page.on("response", async (r) => {
		if (/\/api\//.test(r.url())) bodies.push(await r.text().catch(() => ""));
	});
	await register(page, base, { email: `r10-${Date.now()}@example.com`, name: "管理员" });
	await page.goto(`${base}/admin?tab=sandbox`);
	await page.waitForSelector('[data-testid="daytona-mode"]');
	check("Daytona card defaults to 快照 / 默认规格 with no resource fields and no explanatory note (round 11: the notes are gone)", (await page.locator('[data-testid="daytona-mode"]').getAttribute("data-value")) === "snapshot" && (await page.locator('[data-testid="daytona-resources-note"]').count()) === 0 && (await page.locator('[data-testid="daytona-resources"]').count()) === 0);
	check("E2B card has no size fields and no 模板 explanation (round 11)", (await page.locator('[data-testid="e2b-resources-note"]').count()) === 0 && (await page.locator('[data-testid="e2b-resources"]').count()) === 0);

	// image mode reveals the size fields; saving an image + size stores both
	await pick(page.locator('[data-testid="daytona-mode"]'), "image");
	await page.waitForSelector('[data-testid="daytona-resources"]');
	check("image mode shows 镜像 + CPU / 内存 / 磁盘 fields", (await page.locator('[data-testid="daytona-image"]').count()) === 1 && (await page.locator('[data-testid="daytona-disk"]').count()) === 1);
	await page.fill('[data-testid="daytona-image"]', "python:3.12-slim");
	await page.fill('[data-testid="daytona-cpus"]', "2");
	await page.fill('[data-testid="daytona-mem"]', "4");
	await page.fill('[data-testid="daytona-disk"]', "10");
	await page.click('[data-testid="daytona-replace-key"]').catch(() => {});
	const keyInput = page.locator('[data-testid="daytona-apikey"]');
	if (await keyInput.count()) await keyInput.fill(FAKE);
	await page.click('[data-testid="daytona-save"]');
	await sleep(800);
	const dto = (await (await page.request.get(`${base}/api/sandbox/providers`)).json()).providers.find((x) => x.provider === "daytona");
	check("saved: image + explicit resources stored (cpu cores, GiB)", dto.image === "python:3.12-slim" && JSON.stringify(dto.resources) === JSON.stringify({ cpus: 2, memoryGb: 4, diskGb: 10 }), JSON.stringify({ image: dto.image, resources: dto.resources }));
	await shot(page, "round10/daytona-image-mode-1440");

	// back to snapshot mode clears image and size (sent as resources:null)
	await pick(page.locator('[data-testid="daytona-mode"]'), "snapshot");
	await page.click('[data-testid="daytona-save"]');
	await sleep(800);
	const dto2 = (await (await page.request.get(`${base}/api/sandbox/providers`)).json()).providers.find((x) => x.provider === "daytona");
	check("snapshot mode saved: no image, no explicit resources (nothing silently kept)", dto2.image === undefined && dto2.resources === undefined, JSON.stringify(dto2));

	// API-level refusals carry plain explanations
	const r1 = await page.request.put(`${base}/api/sandbox/providers/daytona`, { data: { resources: { cpus: 2 } } });
	const r2 = await page.request.put(`${base}/api/sandbox/providers/e2b`, { data: { resources: { memoryGb: 2 } } });
	check("resources without an image are refused (Daytona), and on E2B — never ignored", r1.status() === 400 && (await r1.text()).includes("镜像") && r2.status() === 400 && (await r2.text()).includes("模板"));
	check("the fake API key never appears in any API response the page received", bodies.every((b) => !b.includes(FAKE)));
	const ph = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
	const mp = await ph.newPage();
	await mp.context().addCookies(await page.context().cookies());
	await mp.goto(`${base}/admin?tab=sandbox`);
	await mp.waitForSelector('[data-testid="daytona-mode"]');
	check("390px: no horizontal scroll on the sandbox page", await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
	await shot(mp, "round10/daytona-card-390");
} finally {
	await browser.close();
	await server.stop();
}
process.exitCode = summary(join(SHOTS, "round10/round10-daytona-results.json")) ? 0 : 1;
