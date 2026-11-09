// DNS rebinding: a hostname validated as an allowed address and then re-resolved to 127.0.0.1 must never reach 127.0.0.1.
// Browse (Chromium via server-side pinned requests), pinnedRequest, and MCP over HTTP all connect to the validated IP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { startTestApp } from "./helpers/app.ts";
import { context, fakeApi, fixedActor } from "./fixtures/tool-harness.ts";
import { startHttpFixture } from "./fixtures/mcp-fixture-server.ts";
import { createBrowserExtension } from "../src/tools/browser.ts";
import { checkUrl, pinnedRequest, setResolverForTests } from "../src/tools/netpolicy.ts";
import type { McpManager } from "../src/tools/mcp.ts";

function listen(s: Server, host: string, port = 0): Promise<number> {
	return new Promise((r, j) => s.once("error", j).listen(port, host, () => r((s.address() as any).port)));
}

/** "rebind.test": the first lookup answers 127.0.0.2 (operator-allowlisted IP), every later lookup answers 127.0.0.1. */
function rebindingResolver() {
	const calls: string[] = [];
	setResolverForTests(async (host) => {
		if (host !== "rebind.test") throw new Error("NXDOMAIN");
		calls.push(host);
		return calls.length === 1 ? ["127.0.0.2"] : ["127.0.0.1"];
	});
	return calls;
}

test("DNS rebinding: pinned connections go to the validated address in pinnedRequest and browse", async () => {
	let attackerHits = 0;
	let legitHits = 0;
	const legit = createServer((req, res) => {
		legitHits++;
		if (req.url === "/data") return void res.writeHead(200, { "content-type": "application/json" }).end(`{"from":"legit"}`);
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>合法站点</title><body><p id="m">legit page</p><script>fetch('/data').then(r=>r.json()).then(j=>{document.getElementById('m').textContent='legit page + '+j.from})</script></body>`);
	});
	const attacker = createServer((_req, res) => {
		attackerHits++;
		res.writeHead(200, { "content-type": "text/html" }).end("<title>INTERNAL</title><body>internal secrets</body>");
	});
	const port = await listen(legit, "127.0.0.2");
	await listen(attacker, "127.0.0.1", port);
	process.env.WORKROOM_URL_ALLOWLIST = "127.0.0.2";
	const t = await startTestApp();
	try {
		// Without pinning, a second lookup would hand out 127.0.0.1 — and that address is refused by policy.
		let calls = rebindingResolver();
		await checkUrl(`http://rebind.test:${port}/`);
		await assert.rejects(checkUrl(`http://rebind.test:${port}/`), /内网/);
		assert.equal(calls.length, 2);

		// pinnedRequest: one lookup, the socket goes to the validated 127.0.0.2.
		calls = rebindingResolver();
		const r = await pinnedRequest(`http://rebind.test:${port}/data`);
		let body = "";
		for await (const c of r.body) body += c;
		assert.equal(r.address, "127.0.0.2");
		assert.equal(body, `{"from":"legit"}`);
		assert.equal(calls.length, 1);

		// browse: Chromium never resolves the name; navigation + fetch() both reach the pinned address.
		calls = rebindingResolver();
		const u = await t.user("rebind@example.com");
		const space = t.app.ctx.services.get("identity").personalSpace(u.me.userId, u.me.orgId);
		const browse = createBrowserExtension(t.app.ctx, { resolveActor: fixedActor(t.app.ctx, u.me.userId, u.me.orgId, space.id) }).tools![0]!;
		const res = await browse.execute({ url: `http://rebind.test:${port}/` } as any, fakeApi({ conversationId: 1, taskId: 1, callId: "r1" }), context);
		const text = (res.output as any)[0].text as string;
		assert.match(text, /# 合法站点/);
		assert.match(text, /legit page \+ legit/);
		assert.equal(calls.length, 1, "the page's later requests must reuse the pinned address, not re-resolve");
		assert.equal(attackerHits, 0);
		assert.ok(legitHits >= 3);
	} finally {
		setResolverForTests(null);
		delete process.env.WORKROOM_URL_ALLOWLIST;
		await t.dispose();
		legit.close();
		attacker.close();
	}
});

test("DNS rebinding: MCP over HTTP stays on the validated address for the whole connection", async () => {
	const fx = await startHttpFixture("tok-123456", "127.0.0.2");
	const port = Number(new URL(fx.url).port);
	let attackerHits = 0;
	const attacker = createServer((_req, res) => {
		attackerHits++;
		res.writeHead(500).end();
	});
	await listen(attacker, "127.0.0.1", port);
	process.env.WORKROOM_URL_ALLOWLIST = "127.0.0.2";
	const t = await startTestApp({ config: { secretKey: "k" } });
	try {
		const calls = rebindingResolver();
		const u = await t.user("mcp-rebind@example.com");
		const { connector } = await t.json("POST", "/api/connectors", { token: u.token, json: { name: "Rebind", scope: "personal", transport: "http", url: `http://rebind.test:${port}/mcp`, secrets: { Authorization: "Bearer tok-123456" } } });
		assert.equal(connector.status, "ready", connector.statusDetail);
		const mgr = t.app.ctx.services.get("mcp") as McpManager;
		const space = t.app.ctx.services.get("identity").personalSpace(u.me.userId, u.me.orgId);
		mgr.resolveActor = fixedActor(t.app.ctx, u.me.userId, u.me.orgId, space.id);
		const r = await mgr.execute(connector.id, "echo", "read", { text: "pinned" }, fakeApi({ conversationId: 1, taskId: 1, callId: "m1" }), context);
		assert.equal((r.output as any)[0].text, "echo: pinned");
		assert.equal(calls.length, 1, "initialize, listTools and callTool all reuse the pinned address");
		assert.equal(attackerHits, 0);
	} finally {
		setResolverForTests(null);
		delete process.env.WORKROOM_URL_ALLOWLIST;
		await t.dispose();
		await fx.close();
		attacker.close();
	}
});
