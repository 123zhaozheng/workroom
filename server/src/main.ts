import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { createApp } from "./core/app.ts";
import { loadConfig } from "./core/config.ts";
import { loadModules } from "./modules.ts";

const config = loadConfig();
const app = await createApp(config, await loadModules());
if (existsSync(config.webDist)) {
	const root = relative(process.cwd(), config.webDist);
	app.hono.use("/assets/*", serveStatic({ root }));
	app.hono.use("/fonts/*", serveStatic({ root }));
	app.hono.get("*", (c) => {
		if (c.req.path.startsWith("/api/")) return c.notFound();
		const f = `${config.webDist}${c.req.path}`;
		if (c.req.path !== "/" && existsSync(f) && !c.req.path.includes("..")) return c.body(readFileSync(f));
		return c.html(readFileSync(`${config.webDist}/index.html`, "utf8"));
	});
}
await app.start();
const server = serve({ fetch: app.hono.fetch, port: config.port, hostname: config.host });
console.log(`[workroom] ${config.brand.name} listening on http://${config.host}:${config.port} data=${config.dataDir} instance=${config.instanceId}`);
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const)
	process.on(sig, async () => {
		if (stopping) return;
		stopping = true;
		console.log(`[workroom] ${sig}: closing harnesses (work stays pending in storage)`);
		server.close();
		await app.stop();
		process.exit(0);
	});
