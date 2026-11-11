// Round 10: Daytona control-plane WIRE contract. The REAL `@daytonaio/sdk` 0.231.1 (not a double) is pointed at a local fake of the Daytona
// REST API (127.0.0.1, no network, fake key), and the test asserts the exact HTTP requests the Workroom adapter produces:
//   - default mode   → POST /api/sandbox without cpu/memory/disk/snapshot/buildInfo (the same shape a live REST check returned 200/started for)
//   - snapshot mode  → only `snapshot`
//   - image mode     → `buildInfo.dockerfileContent` + explicit cpu/memory(GiB)/disk(GiB)
//   - explicit sizes without an image → refused BEFORE any request (never silently dropped)
//   - no network options ever; lifetime → ttlMinutes/autoStopInterval; delete → DELETE /api/sandbox/:id; errors visible and scrubbed.
// Scope (honest): this is the control plane only. Commands and files go through Daytona's toolbox (WebSocket log stream, multipart files)
// and are covered by the SDK-double tests in sandbox-providers-unit.test.ts — a real end-to-end run still needs a Daytona key.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createProvider } from "../src/tools/sandbox/providers/daytona.ts";
import { UnsupportedError, type CreateOptions } from "../src/tools/sandbox/provider.ts";

const KEY = "dtn_fake_wire_key_0123456789abcdef";
let sdkPresent = true;
try {
	await import("@daytonaio/sdk" as string);
} catch {
	sdkPresent = false;
}
const skip = sdkPresent ? undefined : "optional @daytonaio/sdk not installed";

interface Req { method: string; path: string; auth?: string; body: Record<string, unknown> }
let server: Server;
let base = "";
const reqs: Req[] = [];
/** Per-test override: return [status, json] to answer POST /api/sandbox differently. */
let onCreate: ((body: Record<string, unknown>) => [number, unknown]) | undefined;
const sandboxes = new Map<string, { id: string; state: string; labels: Record<string, string> }>();
let seq = 0;

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b)); });
}

before(async () => {
	server = createServer(async (req, res) => {
		const raw = await readBody(req);
		const path = (req.url ?? "").split("?")[0]!;
		if (path.startsWith("/api/socket.io")) { res.statusCode = 404; res.end(); return; } // SDK event channel: absent → SDK falls back to polling
		let body: Record<string, unknown> = {};
		try { body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}; } catch { /* non-JSON */ }
		reqs.push({ method: req.method ?? "", path, auth: req.headers.authorization, body });
		const json = (status: number, v: unknown): void => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(v)); };
		const dto = (s: { id: string; state: string; labels: Record<string, string> }) => ({ ...s, toolboxProxyUrl: `${base}/toolbox`, target: "us", cpu: 1, memory: 1, disk: 3, gpu: 0, env: {}, public: false, user: "daytona", organizationId: "org" });
		if (req.method === "POST" && path === "/api/sandbox") {
			if (onCreate) { const [st, v] = onCreate(body); json(st, v); return; }
			const s = { id: `sb-${++seq}`, state: "started", labels: (body.labels as Record<string, string>) ?? {} };
			sandboxes.set(s.id, s);
			json(200, dto(s));
			return;
		}
		const m = /^\/api\/sandbox\/([^/]+)$/.exec(path);
		if (m) {
			const s = sandboxes.get(m[1]!);
			if (!s) { json(404, { statusCode: 404, message: `Sandbox with ID or name ${m[1]} not found`, error: "Not Found" }); return; }
			if (req.method === "GET") { json(200, dto(s)); return; }
			if (req.method === "DELETE") { sandboxes.delete(s.id); json(200, dto({ ...s, state: "destroyed" })); return; }
		}
		json(404, { statusCode: 404, message: "not found" });
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
	await Promise.all(made.map((p) => (p as { close?: () => Promise<void> }).close?.()));
	server.closeAllConnections();
	await new Promise<void>((r) => server.close(() => r()));
});

const baseCreate = (extra: Partial<CreateOptions> = {}): CreateOptions => ({
	metadata: { "workroom.instance": "wire-test", "workroom.ws": "w1" },
	lifetimeMs: 10 * 60_000,
	createTimeoutMs: 20_000,
	defaultMemoryMb: 1024, // platform hint — must never reach Daytona
	...extra,
});
const made: ReturnType<typeof createProvider>[] = [];
const provider = (extra: Record<string, unknown> = {}) => {
	const p = createProvider({ provider: "daytona", endpoint: `${base}/api`, apiKey: KEY, ...extra } as never);
	made.push(p); // closed in after(): the SDK keeps an event WebSocket per client (the adapter's close() disposes it)
	return p;
};
const creates = (): Req[] => reqs.filter((r) => r.method === "POST" && r.path === "/api/sandbox");
const NETWORK_FIELDS = ["networkBlockAll", "networkAllowList", "domainAllowList", "outboundProxyUrl"];
const SIZE_FIELDS = ["cpu", "memory", "disk", "gpu", "gpuType"];

describe("Daytona wire contract (real SDK 0.231.1 → local fake REST API)", { skip }, () => {
	it("default mode: POST /api/sandbox carries no size, no snapshot, no image, no network options; the hint is not sent", async () => {
		reqs.length = 0;
		const s = await provider().create(baseCreate());
		assert.match(s.id, /^sb-\d+$/);
		const [c, ...more] = creates();
		assert.ok(c && more.length === 0, "exactly one create request");
		assert.equal(c.auth, `Bearer ${KEY}`, "key goes only to the configured endpoint, as a bearer token");
		for (const k of [...SIZE_FIELDS, "snapshot", "buildInfo", ...NETWORK_FIELDS]) assert.equal(k in c.body, false, `${k} must be absent: ${JSON.stringify(c.body)}`);
		assert.equal(JSON.stringify(c.body).includes("1024"), false, "defaultMemoryMb hint never sent");
		assert.equal(c.body.ttlMinutes, 10);
		assert.equal(c.body.autoStopInterval, 10);
		assert.equal((c.body.labels as Record<string, string>)["workroom.instance"], "wire-test");
	});

	it("snapshot mode: only `snapshot` is added", async () => {
		reqs.length = 0;
		await provider({ template: "team-snap" }).create(baseCreate());
		const c = creates()[0]!;
		assert.equal(c.body.snapshot, "team-snap");
		for (const k of [...SIZE_FIELDS, "buildInfo", ...NETWORK_FIELDS]) assert.equal(k in c.body, false, k);
	});

	it("image mode with explicit size: buildInfo from the image + cpu cores / memory GiB / disk GiB", async () => {
		reqs.length = 0;
		await provider({ image: "python:3.12-slim", resources: { cpus: 2, memoryGb: 4, diskGb: 10 } }).create(baseCreate());
		const c = creates()[0]!;
		assert.deepEqual(c.body.buildInfo, { dockerfileContent: "FROM python:3.12-slim\n" });
		assert.equal(c.body.cpu, 2);
		assert.equal(c.body.memory, 4);
		assert.equal(c.body.disk, 10);
		assert.equal("snapshot" in c.body, false);
		for (const k of NETWORK_FIELDS) assert.equal(k in c.body, false, k);
	});

	it("image mode without size: image only, Daytona's default size", async () => {
		reqs.length = 0;
		await provider({ image: "node:22-slim" }).create(baseCreate());
		const c = creates()[0]!;
		assert.deepEqual(c.body.buildInfo, { dockerfileContent: "FROM node:22-slim\n" });
		for (const k of SIZE_FIELDS) assert.equal(k in c.body, false, k);
	});

	it("explicit size without an image is refused before any request is made (visible, never silently ignored)", async () => {
		reqs.length = 0;
		await assert.rejects(provider({ resources: { cpus: 2 } }).create(baseCreate()), (e: unknown) => e instanceof UnsupportedError && /镜像/.test((e as Error).message));
		await assert.rejects(provider({ template: "team-snap" }).create(baseCreate({ resources: { memoryGb: 8 } })), (e: unknown) => e instanceof UnsupportedError);
		assert.equal(creates().length, 0);
	});

	it("vendor errors stay visible with their status, and the key is scrubbed from the message", async () => {
		onCreate = () => [400, { statusCode: 400, message: `Requested memory exceeds tier limit (key ${KEY})`, error: "Bad Request" }];
		try {
			await assert.rejects(provider({ image: "python:3.12-slim", resources: { memoryGb: 512 } }).create(baseCreate()), (e: unknown) => {
				const msg = (e as Error).message;
				assert.match(msg, /exceeds tier limit/);
				assert.equal(msg.includes(KEY), false, "key scrubbed");
				assert.equal((e as { statusCode?: number }).statusCode, 400);
				return true;
			});
		} finally {
			onCreate = undefined;
		}
	});

	it("connect + destroy: GET then DELETE /api/sandbox/:id; a missing sandbox is gone (null / no-op), not an error", async () => {
		const p = provider();
		const s = await p.create(baseCreate());
		assert.ok(await p.connect(s.id));
		reqs.length = 0;
		await p.destroy(s.id);
		assert.deepEqual(reqs.map((r) => `${r.method} ${r.path}`), [`GET /api/sandbox/${s.id}`, `DELETE /api/sandbox/${s.id}`]);
		assert.equal(await p.connect(s.id), null);
		await p.destroy(s.id); // already gone → no throw
	});

	it("close() disposes the SDK client (its event WebSocket would otherwise keep reconnecting); a later call builds a new client", async () => {
		const p = provider();
		await p.create(baseCreate());
		await (p as { close?: () => Promise<void> }).close?.();
		reqs.length = 0;
		await p.create(baseCreate());
		assert.equal(creates().length, 1);
	});
});
