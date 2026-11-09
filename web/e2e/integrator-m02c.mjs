// Integrator check M02-C (UI): the main run's timeout is its own state — not success, not a plain failure, not cancel.
// Uses its own server with WORKROOM_RT_RETRY_MAX=0 so the first upstream timeout ends the run (production keeps retries).
import { join } from "node:path";
import { check, chromium, register, sendMessage, shot, SHOTS, startServer, summary } from "./lib.mjs";

const server = await startServer({ port: 8852, env: { WORKROOM_RT_RETRY_MAX: "0" } });
const base = server.base;
const browser = await chromium.launch();
try {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
	const page = await ctx.newPage();
	await register(page, base, { email: `m02c-${Date.now()}@example.com`, name: "超时测试" });

	await sendMessage(page, "[[fail timeout]] 请调用上游服务");
	await page.waitForURL(/\/c\//);
	await page.waitForSelector('[data-testid="run-bar"][data-status="timeout"]', { timeout: 30000 });
	const bar = await page.locator('[data-testid="run-bar"]').innerText();
	check("M02-C: main-run timeout shown as its own terminal state (已超时), not 已完成/失败/已取消", bar.includes("超时") && !bar.includes("已完成") && !bar.includes("已取消"), bar.replace(/\s+/g, " "));
	await shot(page, "1440-state-timeout");

	// Contrast in the same UI: a plain model failure stays "failed".
	await page.goto(`${base}/`);
	await sendMessage(page, "[[fail]] 请调用上游服务");
	await page.waitForURL(/\/c\//);
	await page.waitForSelector('[data-testid="run-bar"][data-status="failed"]', { timeout: 30000 });
	check("M02-C: a plain model error is shown as failed, distinct from timeout", (await page.locator('[data-testid="run-bar"][data-status="timeout"]').count()) === 0);
} finally {
	await browser.close();
	await server.stop();
}
process.exitCode = summary(join(SHOTS, "integrator-m02c.results.json")) ? 0 : 1;
