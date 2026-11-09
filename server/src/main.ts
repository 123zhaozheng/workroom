import { serve } from "@hono/node-server";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep, extname } from "node:path";
import { getMimeType } from "hono/utils/mime";
import { createApp } from "./core/app.ts";
import { loadConfig } from "./core/config.ts";
import { loadModules } from "./modules.ts";

const config = loadConfig();
const app = await createApp(config, await loadModules());
if (existsSync(config.webDist)) {
	// Cross-platform static serving: resolve against the absolute dist dir and require containment
	// (works across Windows drives; no string concatenation of paths, no `..` heuristics).
	const root = resolve(config.webDist);
	const indexHtml = resolve(root, "index.html");
	app.hono.get("*", (c) => {
		if (c.req.path.startsWith("/api/")) return c.notFound();
		let rel: string;
		try {
			rel = decodeURIComponent(c.req.path);
		} catch {
			return c.text("bad path", 400);
		}
		const f = resolve(root, "." + rel);
		const inside = f === root || f.startsWith(root + sep);
		if (inside && f !== root && existsSync(f) && statSync(f).isFile()) {
			const type = getMimeType(f) ?? (extname(f) === ".woff2" ? "font/woff2" : "application/octet-stream");
			const immutable = rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
			return c.body(readFileSync(f), 200, { "content-type": type, "cache-control": immutable });
		}
		return c.html(readFileSync(indexHtml, "utf8"));
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
