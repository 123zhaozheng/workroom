// Identity, orgs, members, departments, sessions, spaces, projects, ACL, share links, audit, TOTP 2FA, OIDC login.
// Owner: group E (baseline by integrator). Public API kept stable: Identity.registerResolver, projectRole, createSession,
// createUser, audit(), hashPassword, identityInviteMigration.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AccessControl, Action, AppContext, Decision, IdentityService, OrgRole, Principal, ProjectRole, ResourceRef, Space, WorkroomModule } from "../core/contracts.ts";
import { HttpError, newId, nowIso } from "../core/http.ts";
import type { AppDb } from "../core/db.ts";
import { SecretBox, sha256Hex } from "./secrets.ts";
import { registerIdentityRoutes } from "./routes.ts";
import { Authz } from "./authz.ts";

const MIGRATIONS: { version: number; name: string; sql: string }[] = [
	{
		version: 1,
		name: "identity baseline",
		sql: `
CREATE TABLE id_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, password_hash TEXT, created_at TEXT NOT NULL, disabled_at TEXT);
CREATE TABLE id_orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE id_org_members (org_id TEXT NOT NULL REFERENCES id_orgs(id), user_id TEXT NOT NULL REFERENCES id_users(id), role TEXT NOT NULL, created_at TEXT NOT NULL, removed_at TEXT, PRIMARY KEY (org_id, user_id));
CREATE TABLE id_sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES id_users(id), org_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, user_agent TEXT);
CREATE TABLE id_projects (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at TEXT NOT NULL, archived_at TEXT);
CREATE TABLE id_project_members (project_id TEXT NOT NULL REFERENCES id_projects(id), user_id TEXT NOT NULL REFERENCES id_users(id), role TEXT NOT NULL, added_by TEXT NOT NULL, created_at TEXT NOT NULL, removed_at TEXT, PRIMARY KEY (project_id, user_id));
CREATE TABLE id_spaces (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, kind TEXT NOT NULL, owner_user_id TEXT, project_id TEXT, created_at TEXT NOT NULL, UNIQUE (org_id, kind, owner_user_id), UNIQUE (project_id));
CREATE TABLE id_departments (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, parent_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE id_department_members (department_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at TEXT NOT NULL, removed_at TEXT, PRIMARY KEY (department_id, user_id));
CREATE TABLE id_audit (id TEXT PRIMARY KEY, org_id TEXT, actor_user_id TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, at TEXT NOT NULL);
`,
	},
	{
		version: 2,
		name: "invites",
		sql: `CREATE TABLE id_invites (code TEXT PRIMARY KEY, org_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);`,
	},
	{
		version: 3,
		name: "org admin, sessions, audit categories, shares, 2fa, oidc",
		sql: `
ALTER TABLE id_org_members ADD COLUMN disabled_at TEXT;
ALTER TABLE id_org_members ADD COLUMN disabled_by TEXT;
ALTER TABLE id_users ADD COLUMN totp_secret TEXT;
ALTER TABLE id_users ADD COLUMN totp_pending TEXT;
ALTER TABLE id_users ADD COLUMN totp_enabled_at TEXT;
ALTER TABLE id_users ADD COLUMN totp_last_step INTEGER;
ALTER TABLE id_users ADD COLUMN last_org_id TEXT;
ALTER TABLE id_sessions ADD COLUMN last_seen_at TEXT;
ALTER TABLE id_sessions ADD COLUMN revoked_reason TEXT;
ALTER TABLE id_sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password';
ALTER TABLE id_audit ADD COLUMN category TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE id_audit ADD COLUMN request_id TEXT;
CREATE INDEX id_audit_org_at ON id_audit(org_id, at);
CREATE INDEX id_sessions_user ON id_sessions(user_id, org_id);
ALTER TABLE id_department_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
ALTER TABLE id_departments ADD COLUMN archived_at TEXT;
ALTER TABLE id_invites ADD COLUMN email TEXT;
ALTER TABLE id_invites ADD COLUMN department_id TEXT;
ALTER TABLE id_invites ADD COLUMN revoked_at TEXT;
CREATE TABLE id_share_links (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, org_id TEXT NOT NULL, resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, space_id TEXT, project_id TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, revoked_by TEXT, revoked_reason TEXT, last_used_at TEXT, use_count INTEGER NOT NULL DEFAULT 0);
CREATE INDEX id_share_links_res ON id_share_links(org_id, resource_kind, resource_id);
CREATE TABLE id_oidc_providers (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, issuer TEXT NOT NULL, client_id TEXT NOT NULL, client_secret_enc TEXT, auto_join_role TEXT NOT NULL DEFAULT 'member', allowed_domains TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE id_oidc_states (state TEXT PRIMARY KEY, provider_id TEXT NOT NULL, nonce TEXT NOT NULL, code_verifier TEXT NOT NULL, redirect_uri TEXT NOT NULL, return_to TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE id_external_identities (provider_id TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT, created_at TEXT NOT NULL, last_login_at TEXT, PRIMARY KEY (provider_id, subject));
`,
	},
	{
		version: 4,
		name: "rbac: roles, assignments, direct grants, user groups; migrate orgRole to built-in role assignments",
		sql: `
CREATE TABLE id_roles (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', permissions TEXT NOT NULL DEFAULT '[]', created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT);
CREATE UNIQUE INDEX id_roles_name ON id_roles(org_id, name) WHERE archived_at IS NULL;
CREATE TABLE id_role_assignments (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, role_id TEXT NOT NULL, scope_kind TEXT NOT NULL DEFAULT 'org', scope_id TEXT NOT NULL DEFAULT '', created_by TEXT, created_at TEXT NOT NULL, UNIQUE (org_id, subject_kind, subject_id, role_id, scope_kind, scope_id));
CREATE INDEX id_ra_subject ON id_role_assignments(org_id, subject_kind, subject_id);
CREATE INDEX id_ra_role ON id_role_assignments(org_id, role_id);
CREATE TABLE id_user_grants (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, permission TEXT NOT NULL, effect TEXT NOT NULL, scope_kind TEXT NOT NULL DEFAULT 'org', scope_id TEXT NOT NULL DEFAULT '', reason TEXT, created_by TEXT, created_at TEXT NOT NULL, UNIQUE (org_id, user_id, permission, effect, scope_kind, scope_id));
CREATE INDEX id_ug_user ON id_user_grants(org_id, user_id);
CREATE TABLE id_groups (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_by TEXT, created_at TEXT NOT NULL, archived_at TEXT);
CREATE TABLE id_group_members (group_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at TEXT NOT NULL, removed_at TEXT, PRIMARY KEY (group_id, user_id));
ALTER TABLE id_invites ADD COLUMN role_id TEXT;
CREATE TABLE id_rbac_flags (k TEXT PRIMARY KEY, v TEXT);

-- Migration of existing orgs: every live member gets exactly one base role assignment derived from the legacy orgRole.
INSERT OR IGNORE INTO id_role_assignments (id, org_id, subject_kind, subject_id, role_id, scope_kind, scope_id, created_by, created_at)
SELECT 'ra_' || lower(hex(randomblob(10))), org_id, 'user', user_id, 'builtin:' || CASE role WHEN 'owner' THEN 'owner' WHEN 'admin' THEN 'admin' ELSE 'member' END, 'org', '', 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM id_org_members WHERE removed_at IS NULL;

-- Keep id_org_members.role (kept for Principal.orgRole compatibility) and the base assignment in step for writers that
-- still use the column (createUser/addOrgMember, tests, other modules). RBAC code sets id_rbac_flags('sync') while it writes.
CREATE TRIGGER id_om_rbac_ins AFTER INSERT ON id_org_members WHEN NEW.removed_at IS NULL BEGIN
  INSERT OR IGNORE INTO id_role_assignments (id, org_id, subject_kind, subject_id, role_id, scope_kind, scope_id, created_by, created_at)
  VALUES ('ra_' || lower(hex(randomblob(10))), NEW.org_id, 'user', NEW.user_id, 'builtin:' || CASE NEW.role WHEN 'owner' THEN 'owner' WHEN 'admin' THEN 'admin' ELSE 'member' END, 'org', '', 'system', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER id_om_rbac_role AFTER UPDATE OF role ON id_org_members WHEN OLD.role IS NOT NEW.role AND NEW.removed_at IS NULL AND (SELECT v FROM id_rbac_flags WHERE k = 'sync') IS NULL BEGIN
  DELETE FROM id_role_assignments WHERE org_id = NEW.org_id AND subject_kind = 'user' AND subject_id = NEW.user_id AND scope_kind = 'org' AND role_id IN ('builtin:owner', 'builtin:admin', 'builtin:member', 'builtin:guest');
  INSERT OR IGNORE INTO id_role_assignments (id, org_id, subject_kind, subject_id, role_id, scope_kind, scope_id, created_by, created_at)
  VALUES ('ra_' || lower(hex(randomblob(10))), NEW.org_id, 'user', NEW.user_id, 'builtin:' || CASE NEW.role WHEN 'owner' THEN 'owner' WHEN 'admin' THEN 'admin' ELSE 'member' END, 'org', '', 'system', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
-- Leaving the org drops every role assignment and direct grant; re-joining starts from the base role again (no stale elevation).
CREATE TRIGGER id_om_rbac_removed AFTER UPDATE OF removed_at ON id_org_members WHEN NEW.removed_at IS NOT NULL AND OLD.removed_at IS NULL BEGIN
  DELETE FROM id_role_assignments WHERE org_id = NEW.org_id AND subject_kind = 'user' AND subject_id = NEW.user_id;
  DELETE FROM id_user_grants WHERE org_id = NEW.org_id AND user_id = NEW.user_id;
  UPDATE id_group_members SET removed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = NEW.user_id AND removed_at IS NULL AND group_id IN (SELECT id FROM id_groups WHERE org_id = NEW.org_id);
END;
CREATE TRIGGER id_om_rbac_readd AFTER UPDATE OF removed_at ON id_org_members WHEN NEW.removed_at IS NULL AND OLD.removed_at IS NOT NULL BEGIN
  DELETE FROM id_role_assignments WHERE org_id = NEW.org_id AND subject_kind = 'user' AND subject_id = NEW.user_id;
  INSERT OR IGNORE INTO id_role_assignments (id, org_id, subject_kind, subject_id, role_id, scope_kind, scope_id, created_by, created_at)
  VALUES ('ra_' || lower(hex(randomblob(10))), NEW.org_id, 'user', NEW.user_id, 'builtin:' || CASE NEW.role WHEN 'owner' THEN 'owner' WHEN 'admin' THEN 'admin' ELSE 'member' END, 'org', '', 'system', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
`,
	},
];

export function hashPassword(password: string): string {
	const salt = randomBytes(16);
	return `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, 32).toString("hex")}`;
}
export function verifyPassword(password: string, stored: string | null): boolean {
	if (!stored) return false;
	const [, saltHex, hashHex] = stored.split("$");
	if (!saltHex || !hashHex) return false;
	const a = scryptSync(password, Buffer.from(saltHex, "hex"), 32);
	const b = Buffer.from(hashHex, "hex");
	return a.length === b.length && timingSafeEqual(a, b);
}

export type AuditCategory = "auth" | "admin" | "grant" | "share" | "external_write" | "model" | "budget" | "automation" | "security";
function inferCategory(action: string): AuditCategory {
	if (action.startsWith("auth.") || action.startsWith("session.") || action.startsWith("user.")) return "auth";
	if (action.startsWith("share.")) return "share";
	// Approvals are authorizations of agent actions; external effects are writes to systems outside Workroom.
	if (action.startsWith("project.member") || action.startsWith("department.member") || action.startsWith("grant.") || action.startsWith("approval.")) return "grant";
	if (action.startsWith("effect.") || action.startsWith("external.") || action.startsWith("mcp.write")) return "external_write";
	if (action.startsWith("model.") || action.startsWith("channel.") || action.startsWith("route.")) return "model";
	if (action.startsWith("budget.")) return "budget";
	if (action.startsWith("automation.")) return "automation";
	if (action.startsWith("totp.") || action.startsWith("oidc.")) return "security";
	return "admin";
}

/** Append an audit record. Never throws on detail serialisation; secrets must not be passed in `detail`. */
export function audit(db: AppDb, orgId: string | null, actor: string | null, action: string, target?: string, detail?: unknown, opts: { category?: AuditCategory; requestId?: string } = {}): string {
	const id = newId("aud");
	let d: string | null = null;
	if (detail !== undefined) {
		try {
			d = JSON.stringify(detail);
		} catch {
			d = JSON.stringify({ unserialisable: true });
		}
	}
	db.run("INSERT INTO id_audit (id, org_id, actor_user_id, action, target, detail, at, category, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", id, orgId, actor, action, target ?? null, d, nowIso(), opts.category ?? inferCategory(action), opts.requestId ?? null);
	return id;
}

type Resolver = (p: Principal, action: Action, resource: ResourceRef) => Promise<Decision | undefined>;
export type ShareRenderer = (resource: { kind: string; id: string; spaceId?: string }, share: { orgId: string; createdBy: string }) => Promise<unknown>;

/** Audit service exposed as `services.get("audit")` for other modules (e.g. external write receipts). */
export interface AuditService {
	record(input: { orgId: string | null; actorUserId: string | null; action: string; target?: string; detail?: unknown; category?: AuditCategory; requestId?: string }): string;
}

export interface ShareRow {
	id: string;
	org_id: string;
	resource_kind: string;
	resource_id: string;
	space_id: string | null;
	project_id: string | null;
	created_by: string;
	created_at: string;
	expires_at: string;
	revoked_at: string | null;
	revoked_reason: string | null;
	last_used_at: string | null;
	use_count: number;
}

const SESSION_TTL_MS = 30 * 86400_000;

export class Identity implements IdentityService, AccessControl {
	readonly #ctx: AppContext;
	readonly #resolvers = new Map<string, Resolver>();
	readonly #shareRenderers = new Map<string, ShareRenderer>();
	readonly secrets: SecretBox;
	/** Fine-grained authorization (service "authz"). */
	readonly authz: Authz;
	/** Injectable clock (tests). */
	now: () => number = () => Date.now();
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
		this.secrets = new SecretBox(ctx.config.secretKey);
		this.authz = new Authz(ctx, this);
	}
	get db(): AppDb {
		return this.#ctx.db;
	}
	get ctx(): AppContext {
		return this.#ctx;
	}

	/** Modules register ACL resolvers for their resource kinds (file, kb, tool, connector, skill, automation, model). */
	registerResolver(kind: ResourceRef["kind"], resolver: Resolver): void {
		this.#resolvers.set(kind, resolver);
	}
	/** Modules register read-only renderers for shared resources (public share links). */
	registerShareRenderer(kind: string, renderer: ShareRenderer): void {
		this.#shareRenderers.set(kind, renderer);
	}
	shareRenderer(kind: string): ShareRenderer | undefined {
		return this.#shareRenderers.get(kind);
	}

	audit(input: Parameters<AuditService["record"]>[0]): string {
		return audit(this.db, input.orgId, input.actorUserId, input.action, input.target, input.detail, { category: input.category, requestId: input.requestId });
	}

	#spaceFromRow(r: { id: string; org_id: string; kind: string; owner_user_id: string | null; project_id: string | null }): Space {
		const dir = join(this.#ctx.config.dataDir, "orgs", r.org_id, "spaces", r.id);
		mkdirSync(dir, { recursive: true });
		return { id: r.id, orgId: r.org_id, kind: r.kind as Space["kind"], ownerUserId: r.owner_user_id ?? undefined, projectId: r.project_id ?? undefined, dir };
	}
	space(spaceId: string): Space | null {
		const r = this.db.get<any>("SELECT * FROM id_spaces WHERE id = ?", spaceId);
		return r ? this.#spaceFromRow(r) : null;
	}
	personalSpace(userId: string, orgId: string): Space {
		let r = this.db.get<any>("SELECT * FROM id_spaces WHERE org_id = ? AND kind = 'personal' AND owner_user_id = ?", orgId, userId);
		if (!r) {
			const id = newId("sp");
			this.db.run("INSERT OR IGNORE INTO id_spaces (id, org_id, kind, owner_user_id, created_at) VALUES (?, ?, 'personal', ?, ?)", id, orgId, userId, nowIso());
			r = this.db.get<any>("SELECT * FROM id_spaces WHERE org_id = ? AND kind = 'personal' AND owner_user_id = ?", orgId, userId);
		}
		return this.#spaceFromRow(r);
	}
	projectSpace(projectId: string): Space | null {
		const r = this.db.get<any>("SELECT * FROM id_spaces WHERE project_id = ?", projectId);
		return r ? this.#spaceFromRow(r) : null;
	}

	#principal(userId: string, orgId: string, sessionId?: string): Principal | null {
		const u = this.db.get<any>("SELECT * FROM id_users WHERE id = ? AND disabled_at IS NULL", userId);
		const m = this.db.get<any>("SELECT role FROM id_org_members WHERE org_id = ? AND user_id = ? AND removed_at IS NULL AND disabled_at IS NULL", orgId, userId);
		if (!u || !m) return null;
		const departmentIds = this.db
			.all<{ department_id: string }>("SELECT dm.department_id FROM id_department_members dm JOIN id_departments d ON d.id = dm.department_id WHERE dm.user_id = ? AND d.org_id = ? AND dm.removed_at IS NULL AND d.archived_at IS NULL ORDER BY dm.created_at", userId, orgId)
			.map((r) => r.department_id);
		return { userId, orgId, orgRole: m.role as OrgRole, displayName: u.name, email: u.email, departmentIds, sessionId };
	}
	async resolveSessionToken(token: string): Promise<Principal | null> {
		const s = this.db.get<any>("SELECT * FROM id_sessions WHERE token_hash = ? AND revoked_at IS NULL", sha256Hex(token));
		if (!s || s.expires_at < new Date(this.now()).toISOString()) return null;
		const p = this.#principal(s.user_id, s.org_id, s.id);
		if (p && (!s.last_seen_at || Date.parse(s.last_seen_at) < this.now() - 60_000)) this.db.run("UPDATE id_sessions SET last_seen_at = ? WHERE id = ?", new Date(this.now()).toISOString(), s.id);
		return p;
	}
	async principalFor(userId: string, orgId: string): Promise<Principal | null> {
		return this.#principal(userId, orgId);
	}

	projectRole(userId: string, projectId: string): ProjectRole | null {
		const r = this.db.get<{ role: string }>("SELECT pm.role FROM id_project_members pm JOIN id_projects p ON p.id = pm.project_id WHERE pm.project_id = ? AND pm.user_id = ? AND pm.removed_at IS NULL AND p.archived_at IS NULL", projectId, userId);
		return (r?.role as ProjectRole) ?? null;
	}

	/** Space-level decision for a principal, reusable by modules whose resources live in a space (files, kb, tools). */
	spaceDecision(p: Principal, action: Action, space: Space | null): Decision {
		if (!space) return { allow: false, reason: "not_found" };
		if (space.orgId !== p.orgId) return { allow: false, reason: "other_org" };
		if (space.kind === "personal") return space.ownerUserId === p.userId ? { allow: true, reason: "owner" } : { allow: false, reason: "personal_space" };
		const role = this.projectRole(p.userId, space.projectId!);
		if (!role) return { allow: false, reason: "not_member" };
		if (action === "read" || action === "use") return { allow: true, reason: `role_${role}` };
		if (action === "write" || action === "share") return role === "viewer" ? { allow: false, reason: "role_viewer" } : { allow: true, reason: `role_${role}` };
		return role === "owner" ? { allow: true, reason: "role_owner" } : { allow: false, reason: `role_${role}` };
	}

	/** Live-state check of the principal itself: disabled user, removed/disabled membership, revoked session. */
	livePrincipal(p: Principal): { live: Principal } | { reason: string } {
		const live = this.#principal(p.userId, p.orgId, p.sessionId);
		if (!live) return { reason: "revoked" };
		if (p.sessionId) {
			const s = this.db.get<any>("SELECT revoked_at, expires_at FROM id_sessions WHERE id = ?", p.sessionId);
			if (!s || s.revoked_at || s.expires_at < new Date(this.now()).toISOString()) return { reason: "session_revoked" };
		}
		return { live: p.via ? { ...live, via: p.via } : live };
	}

	async check(p: Principal, action: Action, resource: ResourceRef): Promise<Decision> {
		// Re-validate the principal against current state on every check (revocation, removal, disable).
		const lp = this.livePrincipal(p);
		if ("reason" in lp) return { allow: false, reason: lp.reason };
		const live = lp.live;
		switch (resource.kind) {
			case "org":
				if (resource.id !== live.orgId) return { allow: false, reason: "other_org" };
				if (action === "read" || action === "use") return { allow: true, reason: "member" };
				// Org-level "admin"/"write"/"share"/"delete" = may change organisation settings (RBAC: org.settings.manage).
				return this.authz.hasSync(live, "org.settings.manage") ? { allow: true, reason: live.orgRole === "member" ? "rbac" : live.orgRole } : { allow: false, reason: "not_admin" };
			case "space":
				return this.spaceDecision(live, action, this.space(resource.id));
			case "conversation":
				return this.spaceDecision(live, action, this.space(resource.spaceId));
			case "project": {
				const pr = this.db.get<{ org_id: string }>("SELECT org_id FROM id_projects WHERE id = ?", resource.id);
				if (!pr) return { allow: false, reason: "not_found" };
				if (pr.org_id !== live.orgId) return { allow: false, reason: "other_org" };
				return this.spaceDecision(live, action, this.projectSpace(resource.id));
			}
			default: {
				const r = this.#resolvers.get(resource.kind);
				const d = r ? await r(live, action, resource) : undefined;
				return d ?? { allow: false, reason: "no_resolver" };
			}
		}
	}
	async require(p: Principal, action: Action, resource: ResourceRef): Promise<void> {
		const d = await this.check(p, action, resource);
		if (!d.allow) throw new HttpError(d.reason === "revoked" || d.reason === "session_revoked" ? 401 : d.reason === "not_found" ? 404 : 403, d.reason === "not_found" ? "not_found" : "forbidden", `无权访问（${d.reason}）`, { reason: d.reason, resource });
	}
	async readableSpaces(p: Principal): Promise<Space[]> {
		const lp = this.livePrincipal(p);
		if ("reason" in lp) return [];
		const out = [this.personalSpace(p.userId, p.orgId)];
		for (const r of this.db.all<any>("SELECT s.* FROM id_spaces s JOIN id_project_members pm ON pm.project_id = s.project_id JOIN id_projects pr ON pr.id = s.project_id WHERE pm.user_id = ? AND pm.removed_at IS NULL AND pr.archived_at IS NULL AND s.org_id = ?", p.userId, p.orgId)) out.push(this.#spaceFromRow(r));
		return out;
	}

	createSession(userId: string, orgId: string, userAgent?: string, authMethod: "password" | "oidc" | "invite" = "password"): { token: string; id: string } {
		const token = randomBytes(32).toString("base64url");
		const id = newId("ses");
		const now = this.now();
		this.db.run("INSERT INTO id_sessions (id, token_hash, user_id, org_id, created_at, expires_at, user_agent, last_seen_at, auth_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", id, sha256Hex(token), userId, orgId, new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString(), userAgent ?? null, new Date(now).toISOString(), authMethod);
		this.db.run("UPDATE id_users SET last_org_id = ? WHERE id = ?", orgId, userId);
		return { token, id };
	}

	/** Revoke every live session of a user (optionally only in one org). Returns count. */
	revokeSessions(userId: string, orgId: string | null, reason: string, exceptSessionId?: string): number {
		const at = nowIso();
		const r = orgId
			? this.db.run("UPDATE id_sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND org_id = ? AND revoked_at IS NULL AND id != ?", at, reason, userId, orgId, exceptSessionId ?? "")
			: this.db.run("UPDATE id_sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL AND id != ?", at, reason, userId, exceptSessionId ?? "");
		return r.changes;
	}

	/** Create user (+ org when orgId absent). Returns ids. */
	createUser(input: { email: string; name: string; password: string | null; orgId?: string; orgName?: string; role?: OrgRole }): { userId: string; orgId: string } {
		return this.db.tx(() => {
			if (this.db.get("SELECT 1 FROM id_users WHERE email = ?", input.email.trim())) throw new HttpError(409, "email_taken", "该邮箱已注册");
			const userId = newId("usr");
			this.db.run("INSERT INTO id_users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)", userId, input.email.trim(), input.name.trim() || input.email, input.password === null ? null : hashPassword(input.password), nowIso());
			let orgId = input.orgId;
			let role: OrgRole = input.role ?? "member";
			if (!orgId) {
				orgId = newId("org");
				this.db.run("INSERT INTO id_orgs (id, name, created_at) VALUES (?, ?, ?)", orgId, input.orgName?.trim() || `${input.name} 的工作区`, nowIso());
				role = "owner";
			}
			this.db.run("INSERT INTO id_org_members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)", orgId, userId, role, nowIso());
			audit(this.db, orgId, userId, "user.create", userId, { role });
			return { userId, orgId };
		});
	}

	/** Add (or re-add) an existing user to an org. */
	addOrgMember(orgId: string, userId: string, role: OrgRole): void {
		this.db.run("INSERT INTO id_org_members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(org_id, user_id) DO UPDATE SET role = excluded.role, removed_at = NULL, disabled_at = NULL, disabled_by = NULL", orgId, userId, role, nowIso());
	}

	/** Consume an invite atomically. Returns the invite row or throws. */
	consumeInvite(code: string, email: string | null): { org_id: string; role: OrgRole; department_id: string | null } {
		const inv = this.db.get<any>("SELECT * FROM id_invites WHERE code = ?", code);
		const now = nowIso();
		if (!inv || inv.used_at || inv.revoked_at || inv.expires_at <= now) throw new HttpError(400, "bad_invite", "邀请码无效或已过期");
		if (inv.email && email && inv.email.toLowerCase() !== email.toLowerCase()) throw new HttpError(400, "invite_email_mismatch", "该邀请仅限指定邮箱使用");
		const r = this.db.run("UPDATE id_invites SET used_at = ? WHERE code = ? AND used_at IS NULL AND revoked_at IS NULL", now, code);
		if (r.changes !== 1) throw new HttpError(400, "bad_invite", "邀请码已被使用");
		return inv;
	}

	// ------------------------------------------------------------ share links (external read-only)
	createShare(p: Principal, resource: { kind: string; id: string; spaceId?: string }, expiresInHours: number): { row: ShareRow; token: string } {
		const token = randomBytes(32).toString("base64url");
		const id = newId("shr");
		const space = resource.spaceId ? this.space(resource.spaceId) : resource.kind === "project" ? this.projectSpace(resource.id) : null;
		const now = this.now();
		this.db.run(
			"INSERT INTO id_share_links (id, token_hash, org_id, resource_kind, resource_id, space_id, project_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			id,
			sha256Hex(token),
			p.orgId,
			resource.kind,
			resource.id,
			resource.spaceId ?? space?.id ?? null,
			space?.projectId ?? null,
			p.userId,
			new Date(now).toISOString(),
			new Date(now + expiresInHours * 3600_000).toISOString(),
		);
		return { row: this.db.get<ShareRow>("SELECT * FROM id_share_links WHERE id = ?", id)!, token };
	}

	revokeShare(id: string, by: string | null, reason: string): boolean {
		return this.db.run("UPDATE id_share_links SET revoked_at = ?, revoked_by = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL", nowIso(), by, reason, id).changes === 1;
	}

	shareStatus(row: ShareRow): "active" | "expired" | "revoked" | "creator_lost_access" {
		if (row.revoked_at) return row.revoked_reason === "creator_lost_access" ? "creator_lost_access" : "revoked";
		if (row.expires_at <= new Date(this.now()).toISOString()) return "expired";
		return "active";
	}

	/**
	 * Resolve a public share token. Separate permission model from membership: the token grants READ on exactly one
	 * resource, until expiry/revocation, and only while its creator still has read access (re-checked on every use;
	 * a creator who lost access revokes the link permanently).
	 */
	async resolveShare(token: string): Promise<{ row: ShareRow } | { error: "not_found" | "expired" | "revoked" | "creator_lost_access" }> {
		const row = this.db.get<ShareRow>("SELECT * FROM id_share_links WHERE token_hash = ?", sha256Hex(token));
		if (!row) return { error: "not_found" };
		const st = this.shareStatus(row);
		if (st !== "active") return { error: st };
		const creator = await this.principalFor(row.created_by, row.org_id);
		const ref = shareResourceRef(row);
		const d = creator ? await this.check(creator, "read", ref) : { allow: false, reason: "creator_inactive" };
		if (!d.allow) {
			this.revokeShare(row.id, null, "creator_lost_access");
			audit(this.db, row.org_id, null, "share.auto_revoke", row.id, { reason: d.reason, resource: ref });
			return { error: "creator_lost_access" };
		}
		this.db.run("UPDATE id_share_links SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?", nowIso(), row.id);
		return { row };
	}

	/** For other modules' public endpoints: is `token` a live read grant for `resource`? */
	async shareGrant(token: string, resource: { kind: string; id: string }): Promise<Decision> {
		const r = await this.resolveShare(token);
		if ("error" in r) return { allow: false, reason: `share_${r.error}` };
		if (r.row.resource_kind !== resource.kind || r.row.resource_id !== resource.id) return { allow: false, reason: "share_other_resource" };
		return { allow: true, reason: "share_read" };
	}

	/** Eagerly revoke links a user created in an org (member removal) or inside one project (project member removal). */
	revokeSharesCreatedBy(userId: string, orgId: string, projectId: string | null, reason: string): number {
		const at = nowIso();
		return projectId
			? this.db.run("UPDATE id_share_links SET revoked_at = ?, revoked_reason = ? WHERE created_by = ? AND org_id = ? AND project_id = ? AND revoked_at IS NULL", at, reason, userId, orgId, projectId).changes
			: this.db.run("UPDATE id_share_links SET revoked_at = ?, revoked_reason = ? WHERE created_by = ? AND org_id = ? AND revoked_at IS NULL", at, reason, userId, orgId).changes;
	}
}

export function shareResourceRef(row: { resource_kind: string; resource_id: string; space_id: string | null }): ResourceRef {
	if (row.resource_kind === "conversation") return { kind: "conversation", id: row.resource_id, spaceId: row.space_id ?? "" };
	return { kind: row.resource_kind as any, id: row.resource_id } as ResourceRef;
}

export const identityModule: WorkroomModule = {
	name: "identity",
	migrations: MIGRATIONS,
	init(ctx) {
		const id = new Identity(ctx);
		ctx.services.provide("identity", id);
		ctx.services.provide("acl", id);
		ctx.services.provide("authz", id.authz);
		ctx.services.provide("audit", { record: (input: Parameters<AuditService["record"]>[0]) => id.audit(input) } satisfies AuditService);
		// Built-in share renderer for projects (name + description only; no member data leaves the org).
		id.registerShareRenderer("project", async (res) => {
			const pr = ctx.db.get<any>("SELECT name, description, created_at FROM id_projects WHERE id = ? AND archived_at IS NULL", res.id);
			return pr ? { name: pr.name, description: pr.description, createdAt: pr.created_at } : null;
		});
	},
	routes(api, ctx) {
		registerIdentityRoutes(api, ctx, ctx.services.get("identity") as Identity);
	},
};

/** Kept for compatibility with the integrator baseline (already part of MIGRATIONS). */
export const identityInviteMigration = MIGRATIONS[1]!;
