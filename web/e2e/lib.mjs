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
	if (process.env.E2E_BASE) {
		// An external server cannot be crashed or restarted from here: crash/recovery checks must fail, never pass vacuously.
		if (!fresh) throw new Error("restart after a crash needs a child server; unset E2E_BASE");
		return {
			base: process.env.E2E_BASE,
			stop: async () => {},
			kill: async () => {
				throw new Error("crash tests need a child server; unset E2E_BASE");
			},
		};
	}
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
	// Refuse to test someone else's server: a leftover process on this port would answer /api/health while ours died with EADDRINUSE.
	let exited = false;
	child.once("exit", () => (exited = true));
	for (let i = 0; i < 100; i++) {
		await sleep(150);
		if (exited || child.exitCode !== null) throw new Error(`e2e server on port ${port} exited during start (port taken by a leftover server?):\n${out.slice(-2000)}`);
		try {
			const r = await fetch(`${base}/api/health`);
			if (r.ok && /listening|Workroom|http:\/\//i.test(out)) break;
		} catch {
			/* not yet */
		}
	}
	if (exited || child.exitCode !== null) throw new Error(`e2e server on port ${port} exited during start:\n${out.slice(-2000)}`);
	return {
		base,
		/** Hard kill (no graceful shutdown) — for crash/recovery checks. Restart with startServer({ port, fresh: false }). */
		kill: async () => {
			writeFileSync(log, out);
			child.kill("SIGKILL");
			await new Promise((r) => child.once("exit", r));
		},
		stop: async () => {
			writeFileSync(log, out);
			if (child.exitCode !== null || exited) return;
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

/**
 * Choose an option in a popover <Select> (Radix; a combobox button, not a native <select>) — the stand-in for
 * `selectOption`. `want`: a value string (falls back to a label match), { label }, or { index }.
 */
export async function pick(trigger, want) {
	const page = trigger.page();
	await trigger.click();
	const list = page.locator('[role="listbox"]');
	await list.waitFor({ state: "visible", timeout: 5000 });
	const opts = list.locator('[role="option"]');
	let opt;
	if (typeof want === "string") {
		opt = list.locator(`[role="option"][data-value="${want.replace(/"/g, '\\"')}"]`);
		if ((await opt.count()) === 0) opt = list.locator(`[role="option"][data-label="${want.replace(/"/g, '\\"')}"]`);
	} else if (want && "label" in want) opt = list.locator(`[role="option"][data-label="${want.label.replace(/"/g, '\\"')}"]`);
	else opt = opts.nth(want.index);
	await opt.first().click();
	await list.waitFor({ state: "hidden", timeout: 5000 });
}

/** Current value of a popover <Select> (what `inputValue()` was on a native select). */
export const selValue = (trigger) => trigger.getAttribute("data-value");
/** Options of a popover <Select> as [{ value, label, disabled }] (opens the list, reads it, closes with Escape). */
export async function selOptions(trigger) {
	const page = trigger.page();
	await trigger.click();
	const list = page.locator('[role="listbox"]');
	await list.waitFor({ state: "visible", timeout: 5000 });
	const out = await list.locator('[role="option"]').evaluateAll((els) => els.map((e) => ({ value: e.getAttribute("data-value"), label: e.getAttribute("data-label"), disabled: e.getAttribute("aria-disabled") === "true" || e.hasAttribute("data-disabled") })));
	await page.keyboard.press("Escape");
	await list.waitFor({ state: "hidden", timeout: 5000 });
	return out;
}
