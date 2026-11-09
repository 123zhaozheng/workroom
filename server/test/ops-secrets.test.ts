// Secret key rotation: every stored secret (E channels/webhooks/OIDC/TOTP + D connector secrets) is re-encrypted
// from the old to the new WORKROOM_SECRET_KEY in one verified transaction; dry run / wrong key / live server change nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { startTestApp } from "./helpers/app.ts";
import { rotateSecrets } from "../src/ops/rotate-secrets.ts";
import { totpAt } from "../src/identity/totp.ts";
import type { Gateway } from "../src/ops/gateway.ts";

const OLD = "old-secret-key-0123456789-abcdefghij";
const NEW = "new-secret-key-9876543210-zyxwvutsrq";

test("rotate WORKROOM_SECRET_KEY: transactional, verified, idempotent; refuses wrong key and a live server", async () => {
	const t = await startTestApp({ config: { secretKey: OLD } });
	const dataDir = t.dataDir;
	let totpSecret = "";
	let ids: Record<string, string> = {};
	try {
		const a = await t.user("a@a.example");
		ids.channel = (await t.json("POST", "/api/admin/channels", { token: a.token, json: { name: "anthropic", provider: "anthropic", apiKey: "sk-ant-api03-ROTATEME-ROTATEME" } })).channel.id;
		ids.webhook = (await t.json("POST", "/api/notify-channels", { token: a.token, json: { kind: "webhook", name: "hook", target: "https://hooks.example.com/x", secret: "whsec-rotate" } })).channel.id;
		ids.oidc = (await t.json("POST", "/api/admin/oidc", { token: a.token, json: { name: "Corp", issuer: "https://idp.example.com", clientId: "c1", clientSecret: "oidc-secret-rotate" } })).provider.id;
		const setup = await t.json("POST", "/api/me/2fa/setup", { token: a.token });
		totpSecret = setup.secret;
		await t.json("POST", "/api/me/2fa/enable", { token: a.token, json: { code: totpAt(totpSecret, Date.now()) } });
		const conn = await t.req("POST", "/api/connectors", { token: a.token, json: { name: "crm", scope: "system", transport: "http", url: "http://127.0.0.1:9/mcp", secrets: { Authorization: "Bearer mcp-token-rotate" }, check: false } });
		assert.equal(conn.status, 200, await conn.clone().text());
		ids.connector = (await conn.json()).connector?.id;
		assert.ok(ids.connector);
		assert.equal((t.app.ctx.services.get("models") as unknown as Gateway).channelHealth(t.app.ctx.db.get("SELECT * FROM ops_channels WHERE id = ?", ids.channel)!).health, "ready");
		// Live server holds leases → refused (only when some space is open; force a lease row to be sure).
		t.app.ctx.db.run("CREATE TABLE IF NOT EXISTS rt_space_leases (space_id TEXT PRIMARY KEY, owner TEXT NOT NULL, acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)");
		t.app.ctx.db.run("INSERT OR REPLACE INTO rt_space_leases VALUES ('sp_live', 'x', 0, 0, ?)", Date.now() + 60_000);
		await assert.rejects(rotateSecrets(dataDir, OLD, NEW), /stop the server/);
		t.app.ctx.db.run("DELETE FROM rt_space_leases WHERE space_id = 'sp_live'");
	} finally {
		await t.stop();
	}
	try {
		const snapshot = () => {
			const db = new DatabaseSync(join(dataDir, "app.sqlite"), { readOnly: true });
			const v = [db.prepare("SELECT api_key_enc AS v FROM ops_channels WHERE id = ?").get(ids.channel), db.prepare("SELECT secret_enc AS v FROM ops_notify_channels WHERE id = ?").get(ids.webhook), db.prepare("SELECT client_secret_enc AS v FROM id_oidc_providers WHERE id = ?").get(ids.oidc), db.prepare("SELECT totp_secret AS v FROM id_users").get()];
			db.close();
			return JSON.stringify(v);
		};
		const before = snapshot();
		// Wrong old key → error, nothing written.
		await assert.rejects(rotateSecrets(dataDir, "wrong-old-key-0000000000000000", NEW), /neither the old nor the new key/);
		assert.equal(snapshot(), before);
		// Dry run → report, nothing written.
		const dry = await rotateSecrets(dataDir, OLD, NEW, { dryRun: true });
		assert.equal(dry.dryRun, true);
		assert.equal(snapshot(), before);
		const r = await rotateSecrets(dataDir, OLD, NEW);
		const by = Object.fromEntries(r.columns.map((c) => [`${c.table}.${c.col}`, c]));
		assert.equal(by["ops_channels.api_key_enc"]!.rotated, 1);
		assert.equal(by["ops_notify_channels.secret_enc"]!.rotated, 1);
		assert.equal(by["id_oidc_providers.client_secret_enc"]!.rotated, 1);
		assert.equal(by["id_users.totp_secret"]!.rotated, 1);
		if (ids.connector) assert.equal(by["mcp_servers.secrets_enc"]!.rotated, 1);
		assert.equal(dry.total, r.total);
		assert.notEqual(snapshot(), before);
		// Idempotent re-run.
		const again = await rotateSecrets(dataDir, OLD, NEW);
		assert.equal(again.total, 0);
		assert.ok(again.columns.find((c) => c.table === "ops_channels")!.alreadyNew === 1);
		// Server with the NEW key reads everything.
		const t2 = await startTestApp({ dataDir, config: { secretKey: NEW } });
		try {
			const gw = t2.app.ctx.services.get("models") as unknown as Gateway;
			const ch = t2.app.ctx.db.get<any>("SELECT * FROM ops_channels WHERE id = ?", ids.channel);
			assert.equal(gw.channelCredential(ch).key, "sk-ant-api03-ROTATEME-ROTATEME");
			const notify = t2.app.ctx.services.get("notify") as any;
			assert.equal(notify.secrets.open(t2.app.ctx.db.get<any>("SELECT secret_enc FROM ops_notify_channels WHERE id = ?", ids.webhook).secret_enc), "whsec-rotate");
			const login = await t2.json("POST", "/api/auth/login", { json: { email: "a@a.example", password: "password123", totp: totpAt(totpSecret, Date.now() + 30_000) } });
			assert.ok(login.token);
			if (ids.connector) {
				const { SecretBox } = await import("../src/tools/secrets.ts");
				const row = t2.app.ctx.db.get<any>("SELECT id, secrets_enc FROM mcp_servers WHERE id = ?", ids.connector);
				assert.deepEqual(JSON.parse(new SecretBox(NEW).open(row.secrets_enc, row.id)), { Authorization: "Bearer mcp-token-rotate" });
			}
		} finally {
			await t2.stop();
		}
		// A server still on the OLD key can no longer read them (channel shows blocked, not a crash).
		const t3 = await startTestApp({ dataDir, config: { secretKey: OLD } });
		try {
			const gw = t3.app.ctx.services.get("models") as unknown as Gateway;
			assert.equal(gw.channelHealth(t3.app.ctx.db.get<any>("SELECT * FROM ops_channels WHERE id = ?", ids.channel)).health, "blocked");
		} finally {
			await t3.stop();
		}
		await assert.rejects(rotateSecrets(dataDir, OLD, OLD), /must differ/);
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
});
