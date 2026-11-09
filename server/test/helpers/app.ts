// Shared test harness (owner: integrator). Real app, real SQLite + pi-durable storage in a temp data dir.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../../src/core/app.ts";
import { loadConfig, type AppConfig } from "../../src/core/config.ts";
import { loadModules } from "../../src/modules.ts";

export interface TestApp {
	app: App;
	dataDir: string;
	/** Fetch against the in-process Hono app with an optional session token. */
	req(method: string, path: string, opts?: { token?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string> }): Promise<Response>;
	json<T = any>(method: string, path: string, opts?: { token?: string; json?: unknown; expect?: number }): Promise<T>;
	/** Register a user; returns token + me. Pass inviteCode to join an existing org. */
	user(email: string, opts?: { inviteCode?: string; name?: string }): Promise<{ token: string; me: any }>;
	/** Stop the app (closing harnesses) without deleting data — for restart tests. */
	stop(): Promise<void>;
	/** Stop and delete the data dir. */
	dispose(): Promise<void>;
}

export async function startTestApp(opts: { dataDir?: string; config?: Partial<AppConfig> } = {}): Promise<TestApp> {
	const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "wr-test-"));
	const config = loadConfig({ dataDir, port: 0, webDist: join(dataDir, "no-web"), instanceId: `test-${Math.random().toString(36).slice(2, 8)}`, ...opts.config });
	const app = await createApp(config, await loadModules());
	await app.start();
	let stopped = false;
	const t: TestApp = {
		app,
		dataDir,
		async req(method, path, o = {}) {
			const headers: Record<string, string> = { ...(o.headers ?? {}) };
			if (o.token) headers.authorization = `Bearer ${o.token}`;
			let body = o.body;
			if (o.json !== undefined) {
				headers["content-type"] = "application/json";
				body = JSON.stringify(o.json);
			}
			return app.hono.fetch(new Request(`http://test${path}`, { method, headers, body }));
		},
		async json(method, path, o = {}) {
			const res = await t.req(method, path, o);
			const text = await res.text();
			const expect = o.expect ?? 200;
			if (res.status !== expect) throw new Error(`${method} ${path} → ${res.status} (expected ${expect}): ${text}`);
			return text ? JSON.parse(text) : undefined;
		},
		async user(email, o = {}) {
			return t.json("POST", "/api/auth/register", { json: { email, name: o.name ?? email.split("@")[0], password: "password123", inviteCode: o.inviteCode } });
		},
		async stop() {
			if (stopped) return;
			stopped = true;
			await app.stop();
		},
		async dispose() {
			await t.stop();
			if (!opts.dataDir) rmSync(dataDir, { recursive: true, force: true });
		},
	};
	return t;
}
