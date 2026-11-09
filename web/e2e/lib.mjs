// Shared helpers for the browser checks. Playwright is preinstalled globally (CommonJS), so it is
// loaded through createRequire. Nothing here downloads browsers.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export const { chromium } = require("playwright");

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SHOTS = join(ROOT, "artifacts/screenshots");
mkdirSync(SHOTS, { recursive: true });

/**
 * Start the integrated server (built web/dist + all server modules) on `port` with a fresh data dir.
 * Set E2E_BASE to reuse an already running server instead.
 */
export async function startServer({ port = 8802, fresh = true, env = {} } = {}) {
	if (process.env.E2E_BASE) return { base: process.env.E2E_BASE, stop: async () => {} };
	const dataDir = join(ROOT, "data/dev-B", `e2e-${port}`);
	if (fresh) rmSync(dataDir, { recursive: true, force: true });
	mkdirSync(dataDir, { recursive: true });
	const log = join(ROOT, "data/dev-B", `server-${port}.log`);
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/src/main.ts"], {
		cwd: ROOT,
		env: { ...process.env, WORKROOM_DATA_DIR: dataDir, PORT: String(port), WORKROOM_FIXTURE_TOOLS: "1", ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	child.stdout.on("data", (d) => (out += d));
	child.stderr.on("data", (d) => (out += d));
	const base = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 100; i++) {
		try {
			const r = await fetch(`${base}/api/health`);
			if (r.ok) break;
		} catch {
			/* not yet */
		}
		if (child.exitCode !== null) throw new Error(`server exited:\n${out}`);
		await sleep(150);
	}
	return {
		base,
		stop: async () => {
			writeFileSync(log, out);
			child.kill("SIGTERM");
			await new Promise((r) => child.once("exit", r));
		},
	};
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
export function check(name, ok, detail = "") {
	results.push({ name, ok: !!ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
	return !!ok;
}
export function summary(file) {
	const failed = results.filter((r) => !r.ok);
	console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
	if (file) writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
	return failed.length === 0;
}

/** Record every request a page makes (for lazy-chunk and offline-font checks). */
export function recordRequests(page) {
	const urls = [];
	page.on("request", (r) => urls.push(r.url()));
	return urls;
}

export async function shot(page, name) {
	const path = join(SHOTS, `${name}.png`);
	await page.screenshot({ path, fullPage: false });
	return path;
}

export async function register(page, base, { email, name, password = "password123" }) {
	await page.goto(`${base}/register`);
	await page.fill("#name", name);
	await page.fill("#email", email);
	await page.fill("#password", password);
	await page.click('button[type="submit"]');
	await page.waitForSelector('[data-testid="home-greeting"]');
}

export async function login(page, base, { email, password = "password123" }) {
	await page.goto(`${base}/login`);
	await page.fill("#email", email);
	await page.fill("#password", password);
	await page.click('button[type="submit"]');
	await page.waitForSelector('[data-testid="home-greeting"]');
}

/** Type into the composer and send. */
export async function sendMessage(page, text) {
	const input = page.locator('[data-testid="composer-input"]');
	await input.fill(text);
	await page.click('[data-testid="send"]');
}
