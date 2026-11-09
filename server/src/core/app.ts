// Composition root (owner: main/integrator). Groups register modules in server/src/modules.ts.
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { join } from "node:path";
import { AppDb } from "./db.ts";
import { LocalBlobStore } from "./blobs.ts";
import { HttpError, newId } from "./http.ts";
import type { AppConfig } from "./config.ts";
import type { AppContext, AppEnv, ServiceRegistry, Services, WorkroomModule } from "./contracts.ts";

export const SESSION_COOKIE = "wr_session";

class Registry implements ServiceRegistry {
	#m = new Map<string, unknown>();
	provide<K extends keyof Services & string>(name: K, service: Services[K]): void {
		if (this.#m.has(name)) throw new Error(`service ${name} provided twice`);
		this.#m.set(name, service);
	}
	get<K extends keyof Services & string>(name: K): Services[K] {
		if (!this.#m.has(name)) throw new Error(`service ${name} not provided`);
		return this.#m.get(name) as Services[K];
	}
	has(name: string): boolean {
		return this.#m.has(name);
	}
}

export interface App {
	readonly ctx: AppContext;
	readonly hono: Hono<AppEnv>;
	readonly modules: readonly WorkroomModule[];
	start(): Promise<void>;
	stop(): Promise<void>;
}

export async function createApp(config: AppConfig, modules: readonly WorkroomModule[]): Promise<App> {
	const db = new AppDb(join(config.dataDir, "app.sqlite"));
	const blobs = new LocalBlobStore(join(config.dataDir, "blobs"));
	const ctx: AppContext = { config, db, blobs, services: new Registry() };
	for (const m of modules) db.migrate(m.name, m.migrations ?? []);
	for (const m of modules) await m.init?.(ctx);

	const hono = new Hono<AppEnv>();
	hono.use("*", async (c, next) => {
		c.set("requestId", c.req.header("x-request-id") ?? newId("req"));
		let principal = null;
		const token = getCookie(c, SESSION_COOKIE) ?? c.req.header("authorization")?.replace(/^Bearer /, "");
		if (token && ctx.services.has("identity")) principal = await ctx.services.get("identity").resolveSessionToken(token);
		c.set("principal", principal);
		c.header("x-request-id", c.get("requestId"));
		await next();
	});
	hono.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message, detail: err.detail } }, err.status as 400);
		console.error(`[${c.get("requestId")}]`, err);
		return c.json({ error: { code: "internal", message: "服务器内部错误", requestId: c.get("requestId") } }, 500);
	});
	const api = new Hono<AppEnv>();
	api.get("/health", (c) => c.json({ ok: true, instance: config.instanceId, brand: config.brand }));
	for (const m of modules) m.routes?.(api, ctx);
	hono.route("/api", api);

	return {
		ctx,
		hono,
		modules,
		async start() {
			for (const m of modules) await m.start?.(ctx);
		},
		async stop() {
			for (const m of [...modules].reverse()) await m.stop?.(ctx).catch((e) => console.error(`stop ${m.name}`, e));
			db.close();
		},
	};
}
