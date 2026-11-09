// OIDC relying party: authorization code flow + PKCE (S256) + nonce, ID token verified against the issuer's JWKS
// (RS256/ES256 via node:crypto). Verified in tests against a local IdP; no real IdP credentials are configured here.
import type { Context as HonoContext, Hono } from "hono";
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from "node:crypto";
import type { AppContext, AppEnv, OrgRole } from "../core/contracts.ts";
import { HttpError, jsonBody, newId, nowIso, principalOf } from "../core/http.ts";
import { audit, type Identity } from "./module.ts";
import { setSessionCookie } from "./routes.ts";

interface Discovery {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	jwks_uri: string;
}

const discoveryCache = new Map<string, { at: number; doc: Discovery }>();
type JsonWebKey = Record<string, any>;
const jwksCache = new Map<string, { at: number; keys: (JsonWebKey & { kid?: string; alg?: string })[] }>();
const TTL = 10 * 60_000;

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
	const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
	const text = await res.text();
	if (!res.ok) throw new HttpError(502, "oidc_upstream", `身份提供方返回 ${res.status}`, { url, body: text.slice(0, 300) });
	try {
		return JSON.parse(text);
	} catch {
		throw new HttpError(502, "oidc_upstream", "身份提供方返回了非 JSON 响应");
	}
}

async function discover(issuer: string): Promise<Discovery> {
	const c = discoveryCache.get(issuer);
	if (c && Date.now() - c.at < TTL) return c.doc;
	const doc = (await fetchJson(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`)) as Discovery;
	if (doc.issuer !== issuer) throw new HttpError(502, "oidc_issuer_mismatch", "发现文档的 issuer 与配置不一致");
	discoveryCache.set(issuer, { at: Date.now(), doc });
	return doc;
}

async function jwks(uri: string, force = false): Promise<(JsonWebKey & { kid?: string; alg?: string })[]> {
	const c = jwksCache.get(uri);
	if (!force && c && Date.now() - c.at < TTL) return c.keys;
	const doc = await fetchJson(uri);
	jwksCache.set(uri, { at: Date.now(), keys: doc.keys ?? [] });
	return doc.keys ?? [];
}

const b64url = (b: Buffer) => b.toString("base64url");

export async function verifyIdToken(idToken: string, opts: { issuer: string; clientId: string; nonce: string; jwksUri: string; now?: number }): Promise<Record<string, any>> {
	const parts = idToken.split(".");
	if (parts.length !== 3) throw new HttpError(401, "oidc_bad_token", "ID Token 格式错误");
	const [h, p, s] = parts as [string, string, string];
	const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
	const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
	if (header.alg !== "RS256" && header.alg !== "ES256") throw new HttpError(401, "oidc_bad_alg", `不支持的签名算法 ${header.alg}`);
	let keys = await jwks(opts.jwksUri);
	let jwk = keys.find((k) => (header.kid ? k.kid === header.kid : true) && (!k.alg || k.alg === header.alg));
	if (!jwk) {
		keys = await jwks(opts.jwksUri, true); // key rotation
		jwk = keys.find((k) => (header.kid ? k.kid === header.kid : true));
	}
	if (!jwk) throw new HttpError(401, "oidc_unknown_key", "找不到签名公钥");
	const key = createPublicKey({ key: jwk as any, format: "jwk" });
	const ok = cryptoVerify("sha256", Buffer.from(`${h}.${p}`), header.alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key, Buffer.from(s, "base64url"));
	if (!ok) throw new HttpError(401, "oidc_bad_signature", "ID Token 签名无效");
	const now = Math.floor((opts.now ?? Date.now()) / 1000);
	if (claims.iss !== opts.issuer) throw new HttpError(401, "oidc_bad_iss", "ID Token issuer 不匹配");
	const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!aud.includes(opts.clientId)) throw new HttpError(401, "oidc_bad_aud", "ID Token audience 不匹配");
	if (aud.length > 1 && claims.azp !== opts.clientId) throw new HttpError(401, "oidc_bad_azp", "ID Token azp 不匹配");
	if (typeof claims.exp !== "number" || claims.exp < now - 60) throw new HttpError(401, "oidc_expired", "ID Token 已过期");
	if (typeof claims.iat === "number" && claims.iat > now + 300) throw new HttpError(401, "oidc_bad_iat", "ID Token 签发时间异常");
	if (claims.nonce !== opts.nonce) throw new HttpError(401, "oidc_bad_nonce", "ID Token nonce 不匹配（可能是重放）");
	if (!claims.sub) throw new HttpError(401, "oidc_no_sub", "ID Token 缺少 sub");
	return claims;
}

function providerDto(r: any) {
	return { id: r.id, name: r.name, issuer: r.issuer, clientId: r.client_id, hasClientSecret: !!r.client_secret_enc, enabled: !!r.enabled, autoJoinRole: r.auto_join_role, allowedDomains: JSON.parse(r.allowed_domains), createdAt: r.created_at };
}

function publicBase(c: HonoContext<AppEnv>): string {
	return (process.env.WORKROOM_PUBLIC_URL ?? new URL(c.req.url).origin).replace(/\/$/, "");
}

export function registerOidcRoutes(api: Hono<AppEnv>, ctx: AppContext, id: Identity): void {
	const db = ctx.db;

	api.get("/admin/oidc", async (c) => {
		const p = principalOf(c);
		await id.authz.require(p, "org.security.manage");
		return c.json({ providers: db.all<any>("SELECT * FROM id_oidc_providers WHERE org_id = ? ORDER BY created_at", p.orgId).map(providerDto) });
	});
	api.post("/admin/oidc", async (c) => {
		const p = principalOf(c);
		await id.authz.require(p, "org.security.manage");
		const b = await jsonBody<{ name: string; issuer: string; clientId: string; clientSecret?: string; autoJoinRole?: OrgRole; allowedDomains?: string[] }>(c);
		if (!b.name?.trim() || !/^https?:\/\//.test(b.issuer ?? "") || !b.clientId) throw new HttpError(400, "invalid", "名称、issuer、clientId 必填");
		if (b.autoJoinRole === "owner") throw new HttpError(400, "invalid_role", "不能自动授予所有者");
		const pid = newId("oidc");
		db.run(
			"INSERT INTO id_oidc_providers (id, org_id, name, issuer, client_id, client_secret_enc, auto_join_role, allowed_domains, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			pid,
			p.orgId,
			b.name.trim(),
			b.issuer.replace(/\/$/, ""),
			b.clientId,
			b.clientSecret ? id.secrets.seal(b.clientSecret) : null,
			b.autoJoinRole ?? "member",
			JSON.stringify((b.allowedDomains ?? []).map((d) => d.toLowerCase())),
			p.userId,
			nowIso(),
		);
		audit(db, p.orgId, p.userId, "oidc.provider_create", pid, { issuer: b.issuer, clientId: b.clientId }, { requestId: c.get("requestId") });
		return c.json({ provider: providerDto(db.get("SELECT * FROM id_oidc_providers WHERE id = ?", pid)) });
	});
	api.patch("/admin/oidc/:id", async (c) => {
		const p = principalOf(c);
		await id.authz.require(p, "org.security.manage");
		const row = db.get<any>("SELECT * FROM id_oidc_providers WHERE id = ? AND org_id = ?", c.req.param("id"), p.orgId);
		if (!row) throw new HttpError(404, "not_found", "身份源不存在");
		const b = await jsonBody<{ enabled?: boolean; clientSecret?: string; allowedDomains?: string[]; autoJoinRole?: OrgRole; name?: string }>(c);
		if (b.autoJoinRole === "owner") throw new HttpError(400, "invalid_role", "不能自动授予所有者");
		db.run(
			"UPDATE id_oidc_providers SET enabled = COALESCE(?, enabled), client_secret_enc = COALESCE(?, client_secret_enc), allowed_domains = COALESCE(?, allowed_domains), auto_join_role = COALESCE(?, auto_join_role), name = COALESCE(?, name) WHERE id = ?",
			b.enabled === undefined ? null : b.enabled ? 1 : 0,
			b.clientSecret ? id.secrets.seal(b.clientSecret) : null,
			b.allowedDomains ? JSON.stringify(b.allowedDomains.map((d) => d.toLowerCase())) : null,
			b.autoJoinRole ?? null,
			b.name ?? null,
			row.id,
		);
		audit(db, p.orgId, p.userId, "oidc.provider_update", row.id, { enabled: b.enabled, rotatedSecret: !!b.clientSecret }, { requestId: c.get("requestId") });
		return c.json({ provider: providerDto(db.get("SELECT * FROM id_oidc_providers WHERE id = ?", row.id)) });
	});

	/** Login page: enabled providers (name + id only). */
	api.get("/auth/oidc/providers", (c) => c.json({ providers: db.all<any>("SELECT id, name FROM id_oidc_providers WHERE enabled = 1 ORDER BY name").map((r) => ({ id: r.id, name: r.name })) }));

	api.get("/auth/oidc/:providerId/start", async (c) => {
		const prov = db.get<any>("SELECT * FROM id_oidc_providers WHERE id = ? AND enabled = 1", c.req.param("providerId"));
		if (!prov) throw new HttpError(404, "not_found", "身份源不存在或未启用");
		const d = await discover(prov.issuer);
		const state = b64url(randomBytes(24));
		const nonce = b64url(randomBytes(24));
		const verifier = b64url(randomBytes(48));
		const challenge = b64url(createHash("sha256").update(verifier).digest());
		const redirectUri = `${publicBase(c)}/api/auth/oidc/callback`;
		const returnTo = c.req.query("returnTo");
		db.run("INSERT INTO id_oidc_states (state, provider_id, nonce, code_verifier, redirect_uri, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", state, prov.id, nonce, verifier, redirectUri, returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : null, nowIso(), new Date(Date.now() + 10 * 60_000).toISOString());
		const u = new URL(d.authorization_endpoint);
		for (const [k, v] of Object.entries({ response_type: "code", client_id: prov.client_id, redirect_uri: redirectUri, scope: "openid email profile", state, nonce, code_challenge: challenge, code_challenge_method: "S256" })) u.searchParams.set(k, v);
		return c.redirect(u.toString(), 302);
	});

	api.get("/auth/oidc/callback", async (c) => {
		const state = c.req.query("state") ?? "";
		if (c.req.query("error")) throw new HttpError(401, "oidc_denied", `身份提供方拒绝：${c.req.query("error")}`);
		const st = db.get<any>("SELECT * FROM id_oidc_states WHERE state = ?", state);
		if (!st || st.used_at || st.expires_at < nowIso()) throw new HttpError(400, "oidc_bad_state", "登录状态无效或已过期，请重新登录");
		if (db.run("UPDATE id_oidc_states SET used_at = ? WHERE state = ? AND used_at IS NULL", nowIso(), state).changes !== 1) throw new HttpError(400, "oidc_bad_state", "登录状态已使用");
		const prov = db.get<any>("SELECT * FROM id_oidc_providers WHERE id = ? AND enabled = 1", st.provider_id);
		if (!prov) throw new HttpError(404, "not_found", "身份源不存在或未启用");
		const d = await discover(prov.issuer);
		const form = new URLSearchParams({ grant_type: "authorization_code", code: c.req.query("code") ?? "", redirect_uri: st.redirect_uri, client_id: prov.client_id, code_verifier: st.code_verifier });
		if (prov.client_secret_enc) form.set("client_secret", id.secrets.open(prov.client_secret_enc));
		const tok = await fetchJson(d.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form });
		if (!tok.id_token) throw new HttpError(401, "oidc_no_id_token", "身份提供方未返回 ID Token");
		let claims: Record<string, any>;
		try {
			claims = await verifyIdToken(tok.id_token, { issuer: prov.issuer, clientId: prov.client_id, nonce: st.nonce, jwksUri: d.jwks_uri });
		} catch (e) {
			audit(db, prov.org_id, null, "auth.oidc_rejected", prov.id, { code: (e as HttpError).code }, { requestId: c.get("requestId") });
			throw e;
		}
		const email = typeof claims.email === "string" ? claims.email.toLowerCase() : null;
		const domains: string[] = JSON.parse(prov.allowed_domains);
		const domainOk = !!email && (domains.length === 0 || domains.includes(email.split("@")[1]!));
		if (email && claims.email_verified === false) throw new HttpError(401, "oidc_email_unverified", "邮箱未经身份提供方验证");
		const linked = db.get<any>("SELECT user_id FROM id_external_identities WHERE provider_id = ? AND subject = ?", prov.id, String(claims.sub));
		let userId: string | undefined = linked?.user_id;
		if (!userId) {
			if (!email || !domainOk) throw new HttpError(403, "oidc_domain_not_allowed", "该账号的邮箱域不允许加入此组织");
			const existing = db.get<any>("SELECT id FROM id_users WHERE email = ?", email);
			if (existing) {
				// Security: never link an external identity to an existing account by email alone — an org admin controls
				// its own IdP and could otherwise assert any user's email (cross-org account takeover, see
				// docs/security-review.md). Linking requires that this browser is already signed in as that same account.
				const current = c.get("principal");
				if (!current || current.userId !== existing.id) {
					audit(db, prov.org_id, null, "auth.oidc_link_required", prov.id, { reason: "existing_account" }, { requestId: c.get("requestId") });
					throw new HttpError(409, "oidc_link_required", "该邮箱已有账号：请先用原方式登录，再在设置中关联此身份源");
				}
				userId = existing.id;
			} else {
				// Auto-provisioning only for domain-scoped providers (the org declares which email domains it vouches for).
				if (domains.length === 0) throw new HttpError(403, "oidc_provisioning_disabled", "此身份源未限定邮箱域，不能自动创建账号");
				userId = id.createUser({ email, name: String(claims.name ?? email.split("@")[0]), password: null, orgId: prov.org_id, role: prov.auto_join_role }).userId;
			}
			db.run("INSERT INTO id_external_identities (provider_id, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)", prov.id, String(claims.sub), userId!, email, nowIso());
		}
		const membership = db.get<any>("SELECT * FROM id_org_members WHERE org_id = ? AND user_id = ?", prov.org_id, userId!);
		if (!membership || membership.removed_at) {
			if (!domainOk) throw new HttpError(403, "oidc_not_member", "你不是该组织成员");
			id.addOrgMember(prov.org_id, userId!, prov.auto_join_role);
		} else if (membership.disabled_at) throw new HttpError(403, "member_disabled", "你的组织账号已被停用");
		const p = await id.principalFor(userId!, prov.org_id);
		if (!p) throw new HttpError(403, "account_disabled", "账号已停用");
		db.run("UPDATE id_external_identities SET last_login_at = ? WHERE provider_id = ? AND subject = ?", nowIso(), prov.id, String(claims.sub));
		const s = id.createSession(userId!, prov.org_id, c.req.header("user-agent"), "oidc");
		audit(db, prov.org_id, userId!, "auth.login", s.id, { method: "oidc", provider: prov.id }, { requestId: c.get("requestId") });
		setSessionCookie(c, ctx, s.token);
		return c.redirect(st.return_to ?? "/", 302);
	});
}
