// Security review regression test (fails while the isolation gap exists).
// Property under test: an OIDC provider configured by the owner of org A must never be able to mint a session for a
// user whose account lives in a DIFFERENT org B, and must never be a path into org B's data.
//
// Today org A's owner may register a provider whose `issuer` is a server they run, so the ID token it returns is
// trusted for whatever claims they put in it. The callback (server/src/identity/oidc.ts:187) resolves the ID token's
// email against ALL users globally and links the external identity to the matching account, adds that account to org A,
// and issues a session for it. /api/me/orgs then lists the linked user's other orgs and /api/auth/switch-org hands the
// session a principal inside org B.
//
//   node --disable-warning=ExperimentalWarning --test server/test/review/oidc-cross-org-linking.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { startTestApp } from "../helpers/app.ts";

/** A local IdP whose signed ID token reports whatever email the caller asked for. */
function localIdp(reportEmail: string) {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const jwk = { ...(publicKey.export({ format: "jwk" }) as object), kid: "k", alg: "RS256", use: "sig" };
	const codes = new Map<string, string>();
	let issuer = "";
	const server = createServer(async (req, res) => {
		const url = new URL(req.url!, issuer);
		const json = (code: number, body: unknown) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
		if (url.pathname === "/.well-known/openid-configuration") return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
		if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
		if (url.pathname === "/authorize") {
			const code = randomBytes(8).toString("hex");
			codes.set(code, url.searchParams.get("nonce")!);
			res.writeHead(302, { location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${url.searchParams.get("state")}` });
			return res.end();
		}
		if (url.pathname === "/token" && req.method === "POST") {
			let body = "";
			for await (const c of req) body += c;
			const nonce = codes.get(new URLSearchParams(body).get("code") ?? "") ?? "";
			const now = Math.floor(Date.now() / 1000);
			const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k" })).toString("base64url");
			const p = Buffer.from(JSON.stringify({ iss: issuer, aud: "client-a", sub: "external-1", email: reportEmail, email_verified: true, name: "N", nonce, iat: now, exp: now + 300 })).toString("base64url");
			const sig = sign("sha256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url");
			return json(200, { token_type: "Bearer", id_token: `${h}.${p}.${sig}` });
		}
		json(404, {});
	});
	return new Promise<{ issuer: string; close: () => void }>((resolve) => server.listen(0, "127.0.0.1", () => ((issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`), resolve({ issuer, close: () => server.close() }))));
}

test("review: an org-A OIDC provider cannot mint a session for a user who belongs to org B", async () => {
	const t = await startTestApp({ config: { secretKey: "review-secret-key-0123456789abcdef" } });
	// User B lives in their own org (org B), created independently.
	const victim = await t.user("b-user@corp-b.example");
	const victimOrg = victim.me.orgId;
	const idp = await localIdp("b-user@corp-b.example");
	try {
		// User A owns org A and configures a provider pointing at an issuer A controls (allowedDomains left open).
		const a = await t.user("a-owner@corp-a.example");
		const { provider } = await t.json("POST", "/api/admin/oidc", { token: a.token, json: { name: "A SSO", issuer: idp.issuer, clientId: "client-a" } });

		const start = await t.req("GET", `/api/auth/oidc/${provider.id}/start`);
		const authUrl = start.headers.get("location")!;
		const authRes = await fetch(authUrl, { redirect: "manual" });
		const cb = new URL(authRes.headers.get("location")!);
		const res = await t.req("GET", cb.pathname + cb.search);
		const token = /wr_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];

		// SECURE EXPECTATION: this flow must not yield a usable session acting AS user B. It currently does.
		if (token) {
			const me = await t.req("GET", "/api/me", { token });
			if (me.status === 200) {
				const body = await me.json();
				assert.notEqual(body.me.userId, victim.me.userId, "org-A provider minted a session for org-B's user (account linking by global email)");
			}
			// And it must not be a path into org B.
			const sw = await t.req("POST", "/api/auth/switch-org", { token, json: { orgId: victimOrg } });
			assert.notEqual(sw.status, 200, "session from org-A provider could switch into org B — full cross-tenant takeover");
		}
	} finally {
		await t.dispose();
		idp.close();
	}
});
