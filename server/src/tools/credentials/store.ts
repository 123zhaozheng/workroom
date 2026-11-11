// Credential storage, requests, access control and audit (round 7b, C). See docs/credentials.md.
//
// Invariants (each has a test in server/test/credentials.test.ts):
//  - plaintext lives only in memory for the duration of one seal() / one open()+use; the DB holds sealed values only;
//  - no function here returns plaintext to an API caller: `open` is private to useSecret()/envFor(), which hand it to the proxy
//    (outbound request only) or to the sandbox run (explicit env consent only);
//  - every use re-checks: not revoked, not expired, same org, owner/ACL, actor is not an automation;
//  - audit rows carry ids, hosts, methods and status codes - never values, never request paths or bodies.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AppContext, Principal, Space, ToolActor } from "../../core/contracts.ts";
import type { Migration } from "../../core/db.ts";
import { HttpError, newId } from "../../core/http.ts";
import type { CredentialDTO, CredentialFulfillRequest, CredentialRequestDTO, CredentialScope, CredentialUsage } from "../../../../shared/workspace-safety.ts";
import { createSecretStore, type SecretStore } from "./secret-store.ts";

/** Register in the tools module with `version + 1200` (docs/requests/round7b-c.md). */
export const CREDENTIAL_MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "credentials",
		sql: `
CREATE TABLE credentials (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, scope TEXT NOT NULL, scope_ref TEXT NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL,
  target_hosts TEXT NOT NULL, methods TEXT NOT NULL, inject TEXT NOT NULL, usage TEXT NOT NULL, env_name TEXT, env_consent_at TEXT,
  sealed TEXT NOT NULL, store_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, hint TEXT,
  persist TEXT NOT NULL DEFAULT 'save', request_id TEXT, bind_space TEXT, bind_conv INTEGER,
  created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, last_used_at TEXT, wiped_at TEXT
);
CREATE INDEX credentials_org ON credentials(org_id, scope, scope_ref);
CREATE INDEX credentials_owner ON credentials(org_id, owner_id);
CREATE TABLE credential_requests (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, space_id TEXT NOT NULL, conversation_id INTEGER NOT NULL, call_id TEXT NOT NULL, user_id TEXT NOT NULL,
  spec TEXT NOT NULL, status TEXT NOT NULL, nonce_hash TEXT, nonce_used_at TEXT, credential_id TEXT,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT,
  UNIQUE (space_id, conversation_id, call_id)
);
CREATE INDEX credential_requests_user ON credential_requests(user_id, status, created_at);
`,
	},
];

export interface RequestSpec {
	service: string;
	purpose: string;
	targetHosts: string[];
	methods: string[];
	inject: { header: string; template: string };
	usage: CredentialUsage;
	envName?: string;
	ttlSec: number;
}

export interface CredentialRow {
	id: string;
	org_id: string;
	scope: CredentialScope;
	scope_ref: string;
	owner_id: string;
	name: string;
	target_hosts: string;
	methods: string;
	inject: string;
	usage: CredentialUsage;
	env_name: string | null;
	env_consent_at: string | null;
	sealed: string;
	store_id: string;
	version: number;
	hint: string | null;
	persist: "once" | "save";
	request_id: string | null;
	bind_space: string | null;
	bind_conv: number | null;
	created_at: string;
	expires_at: string | null;
	revoked_at: string | null;
	last_used_at: string | null;
	wiped_at: string | null;
}

export interface RequestRow {
	id: string;
	org_id: string;
	space_id: string;
	conversation_id: number;
	call_id: string;
	user_id: string;
	spec: string;
	status: CredentialRequestDTO["status"];
	nonce_hash: string | null;
	nonce_used_at: string | null;
	credential_id: string | null;
	created_at: string;
	expires_at: string;
	decided_at: string | null;
}

export const ENV_CONSENT_TEXT =
	"环境变量方式会把凭据明文交给本次沙箱命令及其所有子进程：它们可以读取、打印、写入文件或通过网络发出去。只在你信任这段代码、且网络策略已限制外发时同意。凭据不会写入工作区、镜像、快照或运行记录。";
export const MAX_SECRET_CHARS = 8192;
export const MIN_SECRET_CHARS = 8;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const aadOf = (orgId: string, id: string, version: number): string => `workroom.credential|${orgId}|${id}|${version}`;
const json = <T>(s: string): T => JSON.parse(s) as T;

/** Secret value constraints shared by fulfil and rotate. Never echo the value in an error. */
export function validateSecret(secret: unknown, usage: CredentialUsage): string {
	if (typeof secret !== "string" || secret.length === 0) throw new HttpError(400, "invalid_secret", "密钥不能为空");
	if (secret.length < MIN_SECRET_CHARS) throw new HttpError(400, "invalid_secret", `密钥太短（至少 ${MIN_SECRET_CHARS} 个字符，过短的值无法被可靠地从响应中擦除）`);
	if (secret.length > MAX_SECRET_CHARS) throw new HttpError(400, "invalid_secret", `密钥过长（最多 ${MAX_SECRET_CHARS} 个字符）`);
	if (secret.includes("\0")) throw new HttpError(400, "invalid_secret", "密钥含非法字符");
	// Header injection: a value that goes into an HTTP header may not carry line breaks.
	if (usage === "proxy" && /[\r\n]/.test(secret)) throw new HttpError(400, "invalid_secret", "密钥含换行符，不能放入请求头");
	return secret;
}

export type EnvNameValidator = (name: string) => boolean | string | undefined | null;

const RESERVED_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|IFS|ENV|BASH_ENV|TMPDIR|TERM|LANG|LC_[A-Z_]+|LD_[A-Z_]+|DYLD_[A-Z_]+|NODE_[A-Z_]+|NPM_[A-Z_]+|PYTHON[A-Z_]*|PERL5?[A-Z_]*|RUBY[A-Z_]*|GIT_[A-Z_]+|SSL_CERT_[A-Z_]+|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|WORKROOM_[A-Z_]*|SANDBOX_[A-Z_]*)$/i;
/** Local rules for the variable name a credential is exposed as (usage "env"). The integrator may add V's stricter rule via `store.envNameValidator`. */
export function envNameProblem(name: unknown): string | null {
	if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) return "envName 必须是合法的环境变量名（字母、数字、下划线，不以数字开头，最长 64）";
	if (RESERVED_ENV.test(name)) return `环境变量名 ${name} 是系统/平台保留名，不能用于凭据`;
	return null;
}

export class CredentialStore {
	readonly ctx: AppContext;
	secretStore: SecretStore;
	/** Injectable clock (ms) for expiry tests. */
	now: () => number = () => Date.now();
	/** Longest time a request waits for the user. Effective wait = min(ttlSec, this). */
	maxWaitSec = Number(process.env.WORKROOM_CREDENTIAL_MAX_WAIT_SEC) || 3600;
	/** Optional extra rule for env names (V's isCredentialEnvName): return true / undefined = accepted, false or a string = refused. */
	envNameValidator?: EnvNameValidator;

	constructor(ctx: AppContext, secretStore?: SecretStore) {
		this.ctx = ctx;
		this.secretStore = secretStore ?? createSecretStore({ inlineKey: ctx.config.secretKey });
	}

	get db() {
		return this.ctx.db;
	}
	get iso(): string {
		return new Date(this.now()).toISOString();
	}

	// ------------------------------------------------------------------ audit
	audit(who: { orgId: string; userId: string }, action: string, target: string, detail: Record<string, unknown>): void {
		try {
			if (this.ctx.services.has("audit")) (this.ctx.services.get("audit") as { record(i: unknown): string }).record({ orgId: who.orgId, actorUserId: who.userId, action, target, detail });
			else this.db.run("INSERT INTO id_audit (id, org_id, actor_user_id, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)", newId("aud"), who.orgId, who.userId, action, target, JSON.stringify(detail), this.iso);
		} catch (err) {
			console.error("[credentials] audit failed", (err as Error)?.message ?? "error");
		}
	}

	requireStore(): SecretStore {
		if (!this.secretStore.available) throw new HttpError(503, "secret_storage_unavailable", this.secretStore.reason || "未配置：凭据保险箱不可用");
		return this.secretStore;
	}

	// ------------------------------------------------------------------ requests
	request(id: string): RequestRow | undefined {
		return this.db.get<RequestRow>("SELECT * FROM credential_requests WHERE id = ?", id);
	}
	requestByCall(spaceId: string, conversationId: number, callId: string): RequestRow | undefined {
		return this.db.get<RequestRow>("SELECT * FROM credential_requests WHERE space_id = ? AND conversation_id = ? AND call_id = ?", spaceId, conversationId, callId);
	}

	/** Idempotent per (space, conversation, callId): a replay finds the same row. Fails before creating anything when no secret store is configured. */
	createRequest(actor: ToolActor, spec: RequestSpec): RequestRow {
		this.requireStore();
		this.sweep();
		const existing = this.requestByCall(actor.space.id, actor.conversationId, actor.callId);
		if (existing) return existing;
		const now = this.now();
		const waitSec = Math.min(spec.ttlSec, this.maxWaitSec);
		const row: RequestRow = {
			id: newId("crq"),
			org_id: actor.principal.orgId,
			space_id: actor.space.id,
			conversation_id: actor.conversationId,
			call_id: actor.callId,
			user_id: actor.principal.userId,
			spec: JSON.stringify(spec),
			status: "pending",
			nonce_hash: null,
			nonce_used_at: null,
			credential_id: null,
			created_at: new Date(now).toISOString(),
			expires_at: new Date(now + waitSec * 1000).toISOString(),
			decided_at: null,
		};
		const res = this.db.run(
			"INSERT OR IGNORE INTO credential_requests (id, org_id, space_id, conversation_id, call_id, user_id, spec, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
			row.id, row.org_id, row.space_id, row.conversation_id, row.call_id, row.user_id, row.spec, row.created_at, row.expires_at,
		);
		if (res.changes) this.audit(actor.principal, "credential.request", row.id, { requestId: row.id, service: spec.service, hosts: spec.targetHosts, methods: spec.methods, usage: spec.usage, spaceId: row.space_id, conversationId: row.conversation_id, callId: row.call_id, ttlSec: spec.ttlSec });
		return this.request(row.id)!;
	}

	/** Pending and past expiry → expired (and audited once). Returns the fresh row. */
	expireIfDue(r: RequestRow): RequestRow {
		if (r.status === "pending" && Date.parse(r.expires_at) <= this.now()) {
			const res = this.db.run("UPDATE credential_requests SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'", this.iso, r.id);
			if (res.changes) this.audit({ orgId: r.org_id, userId: r.user_id }, "credential.expire", r.id, { requestId: r.id, kind: "request" });
			return this.request(r.id)!;
		}
		return r;
	}

	requestDto(r: RequestRow): CredentialRequestDTO {
		const spec = json<RequestSpec>(r.spec);
		return {
			id: r.id,
			service: spec.service,
			purpose: spec.purpose,
			targetHosts: spec.targetHosts,
			methods: spec.methods,
			inject: spec.inject,
			usage: spec.usage,
			...(spec.envName ? { envName: spec.envName } : {}),
			ttlSec: spec.ttlSec,
			status: r.status,
			conversationId: r.conversation_id,
			spaceId: r.space_id,
			requestedFor: r.user_id,
			createdAt: r.created_at,
			expiresAt: r.expires_at,
			...(r.credential_id ? { credentialId: r.credential_id } : {}),
			...(spec.usage === "env" ? { envConsentText: ENV_CONSENT_TEXT } : {}),
		};
	}

	/** The requesting user only (anyone else gets 404: a request id must not confirm that a request exists). */
	requestFor(p: Principal, id: string): RequestRow {
		const r = this.request(id);
		if (!r || r.user_id !== p.userId || r.org_id !== p.orgId) throw new HttpError(404, "request_not_found", "凭据请求不存在");
		return this.expireIfDue(r);
	}

	async #requireSpaceWrite(p: Principal, r: RequestRow): Promise<void> {
		await this.ctx.services.get("acl").require(p, "write", { kind: "space", id: r.space_id });
	}

	listRequests(p: Principal, status?: string): RequestRow[] {
		this.sweep();
		const rows = this.db.all<RequestRow>("SELECT * FROM credential_requests WHERE user_id = ? AND org_id = ? ORDER BY created_at DESC LIMIT 200", p.userId, p.orgId);
		return rows.map((r) => this.expireIfDue(r)).filter((r) => !status || r.status === status);
	}

	/**
	 * Hand the browser a single-use nonce for its form. Each call replaces the previous nonce (the latest form wins); only the SHA-256 is stored.
	 * Only the requester, only while pending.
	 */
	async issueNonce(p: Principal, id: string): Promise<string | null> {
		const r = this.requestFor(p, id);
		if (r.status !== "pending") return null;
		await this.#requireSpaceWrite(p, r);
		const nonce = randomBytes(32).toString("base64url");
		const res = this.db.run("UPDATE credential_requests SET nonce_hash = ? WHERE id = ? AND status = 'pending' AND nonce_used_at IS NULL", sha256(nonce), id);
		return res.changes ? nonce : null;
	}

	async #resolveScope(p: Principal, r: RequestRow, persist: "once" | "save", scope: CredentialScope | undefined): Promise<{ scope: CredentialScope; scopeRef: string }> {
		if (persist === "once" || !scope || scope === "user") return { scope: "user", scopeRef: p.userId };
		const authz = this.ctx.services.has("authz") ? this.ctx.services.get("authz") : null;
		if (scope === "org") {
			const ok = authz ? await authz.has(p, "credential.manage.org") : p.orgRole === "owner" || p.orgRole === "admin";
			if (!ok) throw new HttpError(403, "forbidden", "没有把凭据保存为组织级的权限（credential.manage.org）");
			return { scope: "org", scopeRef: p.orgId };
		}
		if (scope === "project") {
			const space = this.ctx.services.get("identity").space(r.space_id);
			if (!space?.projectId) throw new HttpError(400, "not_a_project", "这个会话不在项目中，不能保存为项目级凭据");
			const ok = authz ? await authz.has(p, "credential.manage.project", { kind: "project", id: space.projectId }) : p.orgRole === "owner" || p.orgRole === "admin";
			if (!ok) throw new HttpError(403, "forbidden", "没有把凭据保存为项目级的权限（credential.manage.project）");
			return { scope: "project", scopeRef: space.projectId };
		}
		throw new HttpError(400, "invalid_scope", "scope 必须是 user、project 或 org");
	}

	/**
	 * Submit the secret for a request. The sealed value is created BEFORE the transaction; the transaction atomically consumes the nonce, marks the
	 * request fulfilled and inserts the credential. A second submit with the same (consumed) nonce returns the first result (idempotent).
	 */
	async fulfil(p: Principal, id: string, body: Partial<CredentialFulfillRequest>): Promise<{ request: CredentialRequestDTO; credential: CredentialDTO; idempotent: boolean }> {
		let r = this.requestFor(p, id);
		await this.#requireSpaceWrite(p, r);
		const spec = json<RequestSpec>(r.spec);
		const nonceOk = typeof body.nonce === "string" && body.nonce.length > 0 && body.nonce.length <= 200 && !!r.nonce_hash && equalHex(sha256(body.nonce), r.nonce_hash);
		if (r.status !== "pending") {
			// A repeat of the submit that fulfilled the request (same consumed nonce) is answered with the same result; anything else is a conflict.
			if (r.status === "fulfilled" && r.nonce_used_at && r.credential_id && nonceOk) return { request: this.requestDto(r), credential: this.dto(this.row(r.credential_id)!), idempotent: true };
			throw new HttpError(409, "request_not_pending", `该请求已${r.status === "expired" ? "过期" : "结束"}`, { status: r.status });
		}
		if (!nonceOk) throw new HttpError(403, "invalid_nonce", "表单已失效，请刷新后重试");
		const store = this.requireStore();
		if (body.persist !== "once" && body.persist !== "save") throw new HttpError(400, "invalid_persist", "persist 必须是 once 或 save");
		const persist: "once" | "save" = body.persist;
		const secret = validateSecret(body.secret, spec.usage);
		if (spec.usage === "env" && body.envConsent !== true) throw new HttpError(400, "env_consent_required", "环境变量方式需要明确同意（envConsent: true）");
		const { scope, scopeRef } = await this.#resolveScope(p, r, persist, body.scope);
		const credId = newId("cred");
		const sealed = await store.seal(secret, aadOf(r.org_id, credId, 1));
		const now = this.now();
		const outcome = this.db.tx(() => {
			const cur = this.request(id)!;
			const stillOpen = cur.status === "pending" && cur.nonce_used_at === null && cur.nonce_hash === r.nonce_hash && Date.parse(cur.expires_at) > now;
			if (!stillOpen) return { ok: false as const, cur };
			this.db.run("UPDATE credential_requests SET status = 'fulfilled', nonce_used_at = ?, credential_id = ?, decided_at = ? WHERE id = ?", new Date(now).toISOString(), credId, new Date(now).toISOString(), id);
			this.db.run(
				`INSERT INTO credentials (id, org_id, scope, scope_ref, owner_id, name, target_hosts, methods, inject, usage, env_name, env_consent_at, sealed, store_id, version, persist, request_id, bind_space, bind_conv, created_at, expires_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
				credId, r.org_id, scope, scopeRef, p.userId, spec.service, JSON.stringify(spec.targetHosts), JSON.stringify(spec.methods), JSON.stringify(spec.inject), spec.usage, spec.envName ?? null,
				spec.usage === "env" ? new Date(now).toISOString() : null, sealed, store.id, persist, r.id, r.space_id, r.conversation_id, new Date(now).toISOString(),
				// "once": usable for the request's TTL from now. "save": no expiry (revoke/rotate/delete are the controls).
				persist === "once" ? new Date(now + spec.ttlSec * 1000).toISOString() : null,
			);
			return { ok: true as const, cur };
		});
		if (!outcome.ok) {
			r = this.expireIfDue(this.request(id)!);
			if (r.status === "fulfilled" && r.nonce_used_at && r.credential_id) return { request: this.requestDto(r), credential: this.dto(this.row(r.credential_id)!), idempotent: true };
			throw new HttpError(409, "request_not_pending", `该请求已${r.status === "expired" ? "过期" : "结束"}`, { status: r.status });
		}
		this.audit(p, "credential.fulfill", credId, { requestId: id, credentialId: credId, scope, persist: persist, usage: spec.usage, hosts: spec.targetHosts, methods: spec.methods, storeId: store.id, spaceId: r.space_id, conversationId: r.conversation_id });
		return { request: this.requestDto(this.request(id)!), credential: this.dto(this.row(credId)!), idempotent: false };
	}

	/** decline = the user says no; cancel = the requester withdraws. Both: requester only, pending only, no nonce needed (nothing is stored). */
	async close(p: Principal, id: string, to: "declined" | "cancelled"): Promise<CredentialRequestDTO> {
		const r = this.requestFor(p, id);
		if (r.status !== "pending") throw new HttpError(409, "request_not_pending", "该请求已结束", { status: r.status });
		const res = this.db.run("UPDATE credential_requests SET status = ?, decided_at = ?, nonce_hash = NULL WHERE id = ? AND status = 'pending'", to, this.iso, id);
		if (res.changes) this.audit(p, to === "declined" ? "credential.decline" : "credential.cancel", id, { requestId: id });
		return this.requestDto(this.request(id)!);
	}

	/** Run aborted while waiting: nothing will read the answer any more. */
	cancelBySystem(id: string): void {
		const r = this.request(id);
		if (!r || r.status !== "pending") return;
		if (this.db.run("UPDATE credential_requests SET status = 'cancelled', decided_at = ?, nonce_hash = NULL WHERE id = ? AND status = 'pending'", this.iso, id).changes) this.audit({ orgId: r.org_id, userId: r.user_id }, "credential.cancel", id, { requestId: id, by: "run_aborted" });
	}

	// ------------------------------------------------------------------ credentials
	row(id: string): CredentialRow | undefined {
		return this.db.get<CredentialRow>("SELECT * FROM credentials WHERE id = ?", id);
	}

	dto(r: CredentialRow): CredentialDTO {
		return {
			id: r.id,
			name: r.name,
			scope: r.scope,
			scopeRef: r.scope_ref,
			ownerId: r.owner_id,
			targetHosts: json<string[]>(r.target_hosts),
			methods: json<string[]>(r.methods),
			usage: r.usage,
			createdAt: r.created_at,
			...(r.expires_at ? { expiresAt: r.expires_at } : {}),
			...(r.revoked_at ? { revokedAt: r.revoked_at } : {}),
			version: r.version,
			...(r.last_used_at ? { lastUsedAt: r.last_used_at } : {}),
			...(r.hint ? { hint: r.hint } : {}),
		};
	}

	/** Wipe the ciphertext of expired "once" credentials and of revoked ones; mark pending requests that ran out. Idempotent, cheap, called lazily. */
	sweep(): void {
		const now = this.iso;
		for (const r of this.db.all<{ id: string; org_id: string; owner_id: string }>("SELECT id, org_id, owner_id FROM credentials WHERE wiped_at IS NULL AND (revoked_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= ?))", now)) {
			const c = this.row(r.id)!;
			if (this.db.run("UPDATE credentials SET sealed = '', wiped_at = ? WHERE id = ? AND wiped_at IS NULL", now, r.id).changes && !c.revoked_at) this.audit({ orgId: r.org_id, userId: r.owner_id }, "credential.expire", r.id, { credentialId: r.id, kind: "credential" });
		}
		for (const r of this.db.all<RequestRow>("SELECT * FROM credential_requests WHERE status = 'pending' AND expires_at <= ?", now)) this.expireIfDue(r);
	}

	async #has(p: Principal, perm: string, scope?: { kind: "project"; id: string }): Promise<boolean> {
		if (this.ctx.services.has("authz")) return this.ctx.services.get("authz").has(p, perm, scope);
		return p.orgRole === "owner" || p.orgRole === "admin";
	}

	/** Who may use (through the proxy / env) a credential, here, now. Pure ACL: lifecycle (revoked/expired) is checked in `usable`. */
	async canUse(p: Principal, c: CredentialRow, where: { spaceId: string; conversationId: number }): Promise<boolean> {
		if (p.orgId !== c.org_id || p.via) return false; // automations never get a credential: nobody consented to unattended use
		if (c.persist === "once" && (c.bind_space !== where.spaceId || c.bind_conv !== where.conversationId)) return false;
		if (c.usage === "env" && (c.bind_space !== where.spaceId || c.bind_conv !== where.conversationId)) return false; // consent was given in one conversation only
		if (c.scope === "user") return c.owner_id === p.userId;
		if (c.scope === "project") {
			const sp = this.ctx.services.get("identity").projectSpace(c.scope_ref);
			if (!sp || sp.orgId !== c.org_id) return false;
			return (await this.ctx.services.get("acl").check(p, "write", { kind: "space", id: sp.id })).allow;
		}
		return this.#has(p, "credential.use.org");
	}

	/** Revoke/rotate/delete: the owner; for project/org scope also the managers; org admins (credential.manage.org) may revoke anything in their org. */
	async canManage(p: Principal, c: CredentialRow, forRevoke = false): Promise<boolean> {
		if (p.orgId !== c.org_id) return false;
		if (c.owner_id === p.userId) return true;
		if (c.scope === "project" && (await this.#has(p, "credential.manage.project", { kind: "project", id: c.scope_ref }))) return true;
		if (c.scope === "org" && (await this.#has(p, "credential.manage.org"))) return true;
		return forRevoke && (await this.#has(p, "credential.manage.org"));
	}

	async list(p: Principal): Promise<CredentialDTO[]> {
		this.sweep();
		const rows = this.db.all<CredentialRow>("SELECT * FROM credentials WHERE org_id = ? AND persist = 'save' ORDER BY created_at DESC LIMIT 500", p.orgId);
		const admin = await this.#has(p, "credential.manage.org");
		const out: CredentialRow[] = [];
		for (const r of rows) {
			if (admin || r.owner_id === p.userId || (await this.#visible(p, r))) out.push(r);
		}
		return out.map((r) => this.dto(r));
	}

	async #visible(p: Principal, r: CredentialRow): Promise<boolean> {
		if (r.scope === "user") return false;
		if (r.scope === "org") return this.#has(p, "credential.use.org");
		const sp = this.ctx.services.get("identity").projectSpace(r.scope_ref);
		return !!sp && (await this.ctx.services.get("acl").check(p, "write", { kind: "space", id: sp.id })).allow;
	}

	async metadata(p: Principal, id: string): Promise<CredentialDTO> {
		const c = this.row(id);
		// Same answer for "missing" and "not yours": ids must not confirm existence.
		if (!c || !(c.owner_id === p.userId || (c.org_id === p.orgId && (await this.#visible(p, c))) || (await this.canManage(p, c, true)))) throw new HttpError(404, "credential_not_found", "凭据不存在");
		this.sweep();
		return this.dto(this.row(id)!);
	}

	async revoke(p: Principal, id: string): Promise<CredentialDTO> {
		const c = this.row(id);
		if (!c || !(await this.canManage(p, c, true))) throw new HttpError(404, "credential_not_found", "凭据不存在");
		if (!c.revoked_at) {
			this.db.tx(() => {
				this.db.run("UPDATE credentials SET revoked_at = ?, sealed = '', wiped_at = ? WHERE id = ? AND revoked_at IS NULL", this.iso, this.iso, id);
				this.db.run("UPDATE credential_requests SET status = 'revoked' WHERE credential_id = ?", id);
			});
			this.audit(p, "credential.revoke", id, { credentialId: id, scope: c.scope, ownerId: c.owner_id, byOwner: c.owner_id === p.userId });
		}
		return this.dto(this.row(id)!);
	}

	/** New version replacing the sealed value. The old ciphertext is overwritten, not kept. Refused for revoked/expired credentials. */
	async rotate(p: Principal, id: string, secret: unknown): Promise<CredentialDTO> {
		const c = this.row(id);
		if (!c || !(await this.canManage(p, c))) throw new HttpError(404, "credential_not_found", "凭据不存在");
		if (c.revoked_at) throw new HttpError(409, "credential_revoked", "凭据已撤销，不能轮换；请重新发起请求");
		if (c.persist === "once") throw new HttpError(400, "not_rotatable", "一次性凭据不能轮换");
		if (c.expires_at && Date.parse(c.expires_at) <= this.now()) throw new HttpError(409, "credential_expired", "凭据已过期");
		const plain = validateSecret(secret, c.usage);
		const store = this.requireStore();
		const version = c.version + 1;
		const sealed = await store.seal(plain, aadOf(c.org_id, c.id, version));
		const res = this.db.run("UPDATE credentials SET sealed = ?, store_id = ?, version = ? WHERE id = ? AND version = ? AND revoked_at IS NULL", sealed, store.id, version, id, c.version);
		if (!res.changes) throw new HttpError(409, "conflict", "凭据刚刚被修改，请重试");
		this.audit(p, "credential.rotate", id, { credentialId: id, version, scope: c.scope, storeId: store.id });
		return this.dto(this.row(id)!);
	}

	async remove(p: Principal, id: string): Promise<void> {
		const c = this.row(id);
		if (!c || !(await this.canManage(p, c, true))) throw new HttpError(404, "credential_not_found", "凭据不存在");
		this.db.tx(() => {
			this.db.run("UPDATE credential_requests SET status = 'revoked' WHERE credential_id = ? AND status = 'fulfilled'", id);
			this.db.run("DELETE FROM credentials WHERE id = ?", id);
		});
		this.audit(p, "credential.revoke", id, { credentialId: id, scope: c.scope, ownerId: c.owner_id, deleted: true });
	}

	// ------------------------------------------------------------------ use (the only paths that open a sealed value)
	/** Lifecycle + ACL. Throws a precise HttpError; audits a refusal (host/method only). */
	async #usable(actor: { principal: Principal; space: Space; conversationId: number }, c: CredentialRow | undefined, via: "proxy" | "env"): Promise<CredentialRow> {
		this.sweep();
		if (!c) throw new HttpError(404, "credential_not_found", "凭据不存在或无权使用");
		const fresh = this.row(c.id)!;
		const deny = (code: string, msg: string, status = 403): never => {
			this.audit(actor.principal, "credential.use_denied", c.id, { credentialId: c.id, reason: code, via });
			throw new HttpError(status, code, msg);
		};
		if (!(await this.canUse(actor.principal, fresh, { spaceId: actor.space.id, conversationId: actor.conversationId }))) throw new HttpError(404, "credential_not_found", "凭据不存在或无权使用");
		if (fresh.revoked_at) return deny("credential_revoked", "凭据已被撤销", 403);
		if (fresh.expires_at && Date.parse(fresh.expires_at) <= this.now()) return deny("credential_expired", "凭据已过期", 403);
		if (!fresh.sealed) return deny("credential_unavailable", "凭据已不可用", 403);
		if (via === "env" && (fresh.usage !== "env" || !fresh.env_consent_at)) return deny("env_not_consented", "该凭据没有环境变量注入的明确同意", 403);
		if (via === "proxy" && fresh.usage !== "proxy") return deny("wrong_usage", "该凭据只允许以环境变量方式使用，不能经代理发送", 403);
		return fresh;
	}

	/** Resolve a credential reference given by the model: credentialId, or requestId (of this user and conversation). */
	async resolveRef(actor: ToolActor, ref: { credentialId?: string; requestId?: string }): Promise<CredentialRow | undefined> {
		if (ref.credentialId) return this.row(ref.credentialId);
		if (ref.requestId) {
			const rq = this.request(ref.requestId);
			if (!rq || rq.user_id !== actor.principal.userId || rq.space_id !== actor.space.id || rq.conversation_id !== actor.conversationId || !rq.credential_id) return undefined;
			return this.row(rq.credential_id);
		}
		return undefined;
	}

	/** Lifecycle + ACL check WITHOUT opening the secret (the proxy validates the request against the row first, then calls `openSealed`). */
	async authorizeProxy(actor: ToolActor, ref: { credentialId?: string; requestId?: string }): Promise<CredentialRow> {
		return this.#usable(actor, await this.resolveRef(actor, ref), "proxy");
	}

	/** Open the sealed value. Only the proxy (outbound request) and `envFor` may call this; no route does. */
	async openSealed(row: CredentialRow): Promise<string> {
		const store = this.requireStore();
		if (store.id !== row.store_id) throw new HttpError(503, "secret_storage_mismatch", `凭据由 ${row.store_id} 保存，但当前配置的是 ${store.id}`);
		try {
			return await store.open(row.sealed, aadOf(row.org_id, row.id, row.version));
		} catch (e) {
			if (e instanceof HttpError) throw e;
			throw new HttpError(409, "needs_reenter", "无法解密该凭据（主密钥已变更或数据损坏），请重新输入");
		}
	}

	markUsed(row: CredentialRow): void {
		this.db.run("UPDATE credentials SET last_used_at = ? WHERE id = ?", this.iso, row.id);
	}

	/** Env-eligible credential ids for one conversation (consented there, valid now). Metadata only. */
	async envCredentialIds(p: Principal, space: Space, conversationId: number): Promise<string[]> {
		this.sweep();
		const rows = this.db.all<CredentialRow>("SELECT * FROM credentials WHERE org_id = ? AND usage = 'env' AND bind_space = ? AND bind_conv = ? AND revoked_at IS NULL", p.orgId, space.id, conversationId);
		const out: string[] = [];
		for (const r of rows) if (r.env_consent_at && (!r.expires_at || Date.parse(r.expires_at) > this.now()) && (await this.canUse(p, r, { spaceId: space.id, conversationId }))) out.push(r.id);
		return out;
	}

	/**
	 * Plaintext for ONE sandbox run (usage "env" only, explicit consent recorded, valid, ACL ok, bound to this conversation). Returns env + cleanup().
	 * The integrator passes `env` to the process environment of that single run and calls cleanup() in `finally`. It must never be written to the
	 * workspace, image, snapshot or run record (only the NAMES may be recorded: `names`). Missing/ineligible ids are refused, never skipped silently.
	 */
	async envFor(p: Principal, space: Space, conversationId: number, credentialIds?: readonly string[]): Promise<{ env: Record<string, string>; names: string[]; cleanup: () => void }> {
		const ids = credentialIds ?? (await this.envCredentialIds(p, space, conversationId));
		const env: Record<string, string> = {};
		const names: string[] = [];
		const actor = { principal: p, space, conversationId };
		for (const id of ids) {
			const row = await this.#usable(actor, this.row(id), "env");
			if (!row.env_name) throw new HttpError(409, "env_name_missing", "凭据没有环境变量名");
			if (env[row.env_name] !== undefined) throw new HttpError(409, "env_name_conflict", `两个凭据使用同一个环境变量名 ${row.env_name}`);
			env[row.env_name] = await this.openSealed(row);
			names.push(row.env_name);
			this.markUsed(row);
			this.audit(p, "credential.use", row.id, { credentialId: row.id, via: "env", envName: row.env_name, spaceId: space.id, conversationId });
		}
		return {
			env,
			names,
			cleanup: () => {
				for (const k of Object.keys(env)) delete env[k];
			},
		};
	}

	validateEnvName(name: string): string | null {
		const local = envNameProblem(name);
		if (local) return local;
		if (this.envNameValidator) {
			const v = this.envNameValidator(name);
			if (v === false) return `环境变量名 ${name} 不符合平台的凭据变量规则`;
			if (typeof v === "string") return v;
		}
		return null;
	}
}

function equalHex(a: string, b: string): boolean {
	const x = Buffer.from(a, "hex");
	const y = Buffer.from(b, "hex");
	return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

const instances = new WeakMap<AppContext, CredentialStore>();
/** The per-app service (created lazily; no `services.provide` needed). */
export function credentialsFor(ctx: AppContext): CredentialStore {
	let s = instances.get(ctx);
	if (!s) instances.set(ctx, (s = new CredentialStore(ctx)));
	return s;
}
