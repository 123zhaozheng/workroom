// Webhook egress: SSRF refusals, DNS-rebinding defence (re-resolve + pin per attempt), no redirects, per-org allowlist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { startTestApp } from "./helpers/app.ts";
import { Allowlist, resolveTarget } from "../src/ops/egress.ts";
import type { NotifyService } from "../src/ops/notify.ts";

delete process.env.WORKROOM_WEBHOOK_ALLOWLIST;
const fake = (map: Record<string, string[]>) => async (h: string) => (map[h] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

test("egress policy: private, metadata, mapped and mixed answers refused; allowlists are explicit", async () => {
	const none = new Allowlist([]);
	const r = fake({ "pub.example": ["93.184.216.34"], "mixed.example": ["93.184.216.34", "10.1.2.3"], "meta.example": ["169.254.169.254"], "v6.example": ["::ffff:127.0.0.1"], "local.example": ["127.0.0.1"] });
	assert.equal((await resolveTarget("https://pub.example/x", none, r)).address, "93.184.216.34");
	for (const [url, re] of [
		["http://10.0.0.5/x", /内网/],
		["http://127.0.0.1:9/x", /内网/],
		["http://[::1]/x", /内网/],
		["http://mixed.example/x", /10\.1\.2\.3/],
		["http://v6.example/x", /127\.0\.0\.1/],
		["http://169.254.169.254/latest/meta-data", /元数据/],
		["http://meta.example/", /元数据/],
		["http://metadata.google.internal/", /元数据/],
		["http://user:pw@pub.example/", /用户名/],
		["file:///etc/passwd", /http/],
	] as const)
		await assert.rejects(resolveTarget(url, none, r), re, url);
	// Org allowlist can permit private ranges / hostnames but never cloud metadata.
	const org = new Allowlist(["127.0.0.1/32", "local.example", "169.254.0.0/16"]);
	assert.equal((await resolveTarget("http://127.0.0.1:9/x", org, r)).address, "127.0.0.1");
	assert.equal((await resolveTarget("http://local.example/x", org, r)).address, "127.0.0.1");
	await assert.rejects(resolveTarget("http://169.254.169.254/", org, r), /元数据/);
	assert.throws(() => new Allowlist(["not a host!"]), /无效/);
});

test("webhook delivery is pinned to the validated IP: rebinding refused, redirects not followed, org allowlist tenant-scoped", async () => {
	const hits: IncomingMessage[] = [];
	const server = createServer((req, res) => {
		hits.push(req);
		req.resume();
		if (req.url === "/redirect") {
			res.writeHead(302, { location: "http://169.254.169.254/latest" });
			return res.end();
		}
		res.writeHead(204);
		res.end();
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;
	const t = await startTestApp();
	try {
		const notify = t.app.ctx.services.get("notify") as NotifyService;
		notify.retryDelaysMs = [5, 5];
		const a = await t.user("a@a.example");
		const b = await t.user("b@b.example");
		const inv = await t.json("POST", "/api/admin/invites", { token: a.token, json: {} });
		const m = await t.user("m@a.example", { inviteCode: inv.invite.code });
		await t.json("POST", "/api/notify-channels", { token: a.token, json: { kind: "webhook", name: "local", target: `http://127.0.0.1:${port}/hook` }, expect: 400 });
		await t.json("PUT", "/api/admin/settings/webhook-allowlist", { token: m.token, json: { entries: ["127.0.0.1"] }, expect: 403 });
		await t.json("PUT", "/api/admin/settings/webhook-allowlist", { token: b.token, json: { entries: ["127.0.0.1"] } });
		await t.json("POST", "/api/notify-channels", { token: a.token, json: { kind: "webhook", name: "local", target: `http://127.0.0.1:${port}/hook` }, expect: 400 }); // B's allowlist doesn't apply to A
		await t.json("PUT", "/api/admin/settings/webhook-allowlist", { token: a.token, json: { entries: ["127.0.0.1"] } });
		assert.deepEqual((await t.json("GET", "/api/admin/settings/webhook-allowlist", { token: a.token })).entries, ["127.0.0.1"]);
		const mk = async (name: string, target: string) => (await t.json("POST", "/api/notify-channels", { token: a.token, json: { kind: "webhook", name, target } })).channel.id;
		const send = async (chId: string) => {
			const nid = notify.createInApp({ orgId: a.me.orgId, userId: a.me.userId, kind: "system", title: "t", body: "b" });
			const [d] = notify.deliver(nid, [chId], { event: "test" }, a.me.orgId);
			await notify.idle();
			return t.app.ctx.db.get<any>("SELECT * FROM ops_notify_deliveries WHERE id = ?", d);
		};
		// Plain allowlisted loopback works.
		assert.equal((await send(await mk("local", `http://127.0.0.1:${port}/hook`))).status, "sent");
		// Pinning: a hostname resolving (via our resolver) to the allowlisted IP is connected to exactly that IP.
		let answers: Record<string, string[]> = { "hooks.pinned.test": ["127.0.0.1"], "hooks.rebind.test": ["93.184.216.34"] };
		notify.resolver = async (h) => (answers[h] ?? []).map((address) => ({ address, family: 4 }));
		const pinned = await send(await mk("pinned", `http://hooks.pinned.test:${port}/hook`));
		assert.equal(pinned.status, "sent");
		assert.equal(hits.at(-1)!.headers.host, `hooks.pinned.test:${port}`);
		// DNS rebinding: public at creation, private at delivery time → refused, final, nothing sent.
		const rebindCh = await mk("rebind", `http://hooks.rebind.test:${port}/hook`);
		answers = { ...answers, "hooks.rebind.test": ["127.0.0.2"] };
		const before = hits.length;
		const rb = await send(rebindCh);
		assert.equal(rb.status, "failed");
		assert.equal(rb.attempt, 1, "policy refusal is not retried");
		assert.match(rb.error, /127\.0\.0\.2/);
		assert.equal(hits.length, before, "no request left the server");
		// Redirects are never followed.
		const rd = await send(await mk("redir", `http://127.0.0.1:${port}/redirect`));
		assert.equal(rd.status, "failed");
		assert.equal(rd.http_status, 302);
		assert.match(rd.error, /redirect/);
		assert.equal(hits.filter((h) => h.url === "/redirect").length, 1);
		const aud = await t.json("GET", "/api/admin/audit?action=settings.webhook_allowlist", { token: a.token });
		assert.equal(aud.items[0].category, "security");
	} finally {
		await t.dispose();
		server.close();
	}
});
