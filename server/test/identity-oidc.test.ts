// OIDC relying-party flow verified against a local IdP built in this test (RS256 JWKS, PKCE S256, nonce).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { startTestApp } from "./helpers/app.ts";

interface IdpUser {
	sub: string;
	email: string;
	name: string;
}

function startIdp(clientId: string, clientSecret: string) {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const kid = "k1";
	const jwk = { ...(publicKey.export({ format: "jwk" }) as object), kid, alg: "RS256", use: "sig" };
	const codes = new Map<string, { nonce: string; challenge: string; redirect: string; user: IdpUser }>();
	const state = { user: { sub: "idp-user-1", email: "alice@corp.example", name: "Alice" } as IdpUser, tamperNonce: false, issuer: "" };
	const server: Server = createServer(async (req, res) => {
		const url = new URL(req.url!, state.issuer);
		const json = (code: number, body: unknown) => {
			res.writeHead(code, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (url.pathname === "/.well-known/openid-configuration") return json(200, { issuer: state.issuer, authorization_endpoint: `${state.issuer}/authorize`, token_endpoint: `${state.issuer}/token`, jwks_uri: `${state.issuer}/jwks` });
		if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
		if (url.pathname === "/authorize") {
			const q = url.searchParams;
			if (q.get("client_id") !== clientId || q.get("code_challenge_method") !== "S256" || !q.get("nonce")) return json(400, { error: "invalid_request" });
			const code = randomBytes(8).toString("hex");
			codes.set(code, { nonce: q.get("nonce")!, challenge: q.get("code_challenge")!, redirect: q.get("redirect_uri")!, user: state.user });
			res.writeHead(302, { location: `${q.get("redirect_uri")}?code=${code}&state=${q.get("state")}` });
			return res.end();
		}
		if (url.pathname === "/token" && req.method === "POST") {
			let body = "";
			for await (const chunk of req) body += chunk;
			const f = new URLSearchParams(body);
			const c = codes.get(f.get("code") ?? "");
			codes.delete(f.get("code") ?? "");
			if (!c) return json(400, { error: "invalid_grant" });
			if (f.get("client_secret") !== clientSecret || f.get("client_id") !== clientId) return json(401, { error: "invalid_client" });
			if (createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") !== c.challenge) return json(400, { error: "invalid_grant", detail: "pkce" });
			if (f.get("redirect_uri") !== c.redirect) return json(400, { error: "invalid_grant", detail: "redirect" });
			const now = Math.floor(Date.now() / 1000);
			const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
			const payload = Buffer.from(JSON.stringify({ iss: state.issuer, aud: clientId, sub: c.user.sub, email: c.user.email, email_verified: true, name: c.user.name, nonce: state.tamperNonce ? "evil" : c.nonce, iat: now, exp: now + 300 })).toString("base64url");
			const sig = sign("sha256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
			return json(200, { access_token: "at", token_type: "Bearer", id_token: `${header}.${payload}.${sig}` });
		}
		json(404, {});
	});
	return new Promise<{ issuer: string; state: typeof state; close: () => void }>((resolve) =>
		server.listen(0, "127.0.0.1", () => {
			state.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			resolve({ issuer: state.issuer, state, close: () => server.close() });
		}),
	);
}

test("OIDC login: code+PKCE+nonce against local IdP; replay, nonce tamper, domain and disabled member refused", async () => {
	const idp = await startIdp("wr-client", "s3cret");
	const noKey = await startTestApp({ config: { secretKey: undefined } });
	try {
		const a = await noKey.user("admin@corp.example");
		// Never store a client secret without WORKROOM_SECRET_KEY.
		await noKey.json("POST", "/api/admin/oidc", { token: a.token, json: { name: "Corp", issuer: idp.issuer, clientId: "wr-client", clientSecret: "s3cret" }, expect: 409 });
		await new Promise((r) => setTimeout(r, 20)); // let other modules' startup work settle before stop (see docs/requests/E.md)
	} finally {
		await noKey.dispose();
	}
	const t = await startTestApp({ config: { secretKey: "test-secret-key-for-oidc-0123456789" } });
	try {
		const admin = await t.user("admin@corp.example");
		const { provider } = await t.json("POST", "/api/admin/oidc", { token: admin.token, json: { name: "Corp SSO", issuer: idp.issuer, clientId: "wr-client", clientSecret: "s3cret", allowedDomains: ["corp.example"] } });
		assert.equal(provider.hasClientSecret, true);
		assert.ok(!JSON.stringify(provider).includes("s3cret"));
		const raw = t.app.ctx.db.get<any>("SELECT client_secret_enc FROM id_oidc_providers WHERE id = ?", provider.id);
		assert.ok(raw.client_secret_enc.startsWith("v1:") && !raw.client_secret_enc.includes("s3cret"));

		const login = async (): Promise<{ status: number; token?: string; location?: string; body?: string; callbackPath: string }> => {
			const start = await t.req("GET", `/api/auth/oidc/${provider.id}/start?returnTo=/projects`);
			assert.equal(start.status, 302);
			const authUrl = start.headers.get("location")!;
			assert.ok(authUrl.startsWith(`${idp.issuer}/authorize?`));
			const authRes = await fetch(authUrl, { redirect: "manual" });
			assert.equal(authRes.status, 302);
			const cb = new URL(authRes.headers.get("location")!);
			const callbackPath = cb.pathname + cb.search;
			const res = await t.req("GET", callbackPath);
			const cookie = res.headers.get("set-cookie") ?? "";
			const token = /wr_session=([^;]+)/.exec(cookie)?.[1];
			return { status: res.status, token, location: res.headers.get("location") ?? undefined, body: res.status >= 400 ? await res.text() : undefined, callbackPath };
		};

		const ok = await login();
		assert.equal(ok.status, 302, ok.body ?? "");
		assert.equal(ok.location, "/projects");
		const me = await t.json("GET", "/api/me", { token: ok.token });
		assert.equal(me.me.email, "alice@corp.example");
		assert.equal(me.me.orgId, admin.me.orgId);
		assert.equal(me.me.orgRole, "member");
		const sessions = await t.json("GET", "/api/me/sessions", { token: ok.token });
		assert.equal(sessions.sessions[0].authMethod, "oidc");
		// state is single-use
		const replay = await t.req("GET", ok.callbackPath);
		assert.equal(replay.status, 400);
		// second login maps to the same user via (provider, sub)
		const again = await login();
		assert.equal((await t.json("GET", "/api/me", { token: again.token })).me.userId, me.me.userId);
		// tampered nonce → rejected
		idp.state.tamperNonce = true;
		const bad = await login();
		assert.equal(bad.status, 401);
		assert.match(bad.body!, /oidc_bad_nonce/);
		idp.state.tamperNonce = false;
		// disallowed domain → refused
		idp.state.user = { sub: "idp-user-2", email: "mallory@evil.example", name: "M" };
		assert.equal((await login()).status, 403);
		// disabled member → refused
		idp.state.user = { sub: "idp-user-1", email: "alice@corp.example", name: "Alice" };
		await t.json("POST", `/api/admin/members/${me.me.userId}/disable`, { token: admin.token });
		await t.json("GET", "/api/me", { token: again.token, expect: 401 });
		const disabled = await login();
		assert.equal(disabled.status, 403);
		const audit = await t.json("GET", "/api/admin/audit?action=auth.oidc_rejected", { token: admin.token });
		assert.equal(audit.items.length, 1);
	} finally {
		await t.dispose();
		idp.close();
	}
});
