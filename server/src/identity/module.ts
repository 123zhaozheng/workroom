// Identity, orgs, sessions, spaces, projects, baseline ACL.
// Owner after hand-off: group E. Baseline written by integrator so every group can test two-user isolation.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setCookie, deleteCookie } from "hono/cookie";
import type { AccessControl, Action, AppContext, Decision, IdentityService, OrgRole, Principal, ProjectRole, ResourceRef, Space, WorkroomModule } from "../core/contracts.ts";
import { HttpError, jsonBody, newId, nowIso, principalOf } from "../core/http.ts";
import { SESSION_COOKIE } from "../core/app.ts";
import type { AppDb } from "../core/db.ts";

const MIGRATIONS = [
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
];

export function hashPassword(password: string): string {
	const salt = randomBytes(16);
	return `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, 32).toString("hex")}`;
}
function verifyPassword(password: string, stored: string | null): boolean {
	if (!stored) return false;
	const [, saltHex, hashHex] = stored.split("$");
	const a = scryptSync(password, Buffer.from(saltHex!, "hex"), 32);
	const b = Buffer.from(hashHex!, "hex");
	return a.length === b.length && timingSafeEqual(a, b);
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function audit(db: AppDb, orgId: string | null, actor: string | null, action: string, target?: string, detail?: unknown): void {
	db.run("INSERT INTO id_audit (id, org_id, actor_user_id, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)", newId("aud"), orgId, actor, action, target ?? null, detail === undefined ? null : JSON.stringify(detail), nowIso());
}

type Resolver = (p: Principal, action: Action, resource: ResourceRef) => Promise<Decision | undefined>;

export class Identity implements IdentityService, AccessControl {
	readonly #ctx: AppContext;
	readonly #resolvers = new Map<string, Resolver>();
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}
	get db(): AppDb {
		return this.#ctx.db;
	}

	/** Modules register ACL resolvers for their resource kinds (file, kb, tool, connector, skill, automation, model). */
	registerResolver(kind: ResourceRef["kind"], resolver: Resolver): void {
		this.#resolvers.set(kind, resolver);
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
		const m = this.db.get<any>("SELECT role FROM id_org_members WHERE org_id = ? AND user_id = ? AND removed_at IS NULL", orgId, userId);
		if (!u || !m) return null;
		const departmentIds = this.db.all<{ department_id: string }>("SELECT dm.department_id FROM id_department_members dm JOIN id_departments d ON d.id = dm.department_id WHERE dm.user_id = ? AND d.org_id = ? AND dm.removed_at IS NULL", userId, orgId).map((r) => r.department_id);
		return { userId, orgId, orgRole: m.role as OrgRole, displayName: u.name, email: u.email, departmentIds, sessionId };
	}
	async resolveSessionToken(token: string): Promise<Principal | null> {
		const s = this.db.get<any>("SELECT * FROM id_sessions WHERE token_hash = ? AND revoked_at IS NULL", sha256(token));
		if (!s || s.expires_at < nowIso()) return null;
		return this.#principal(s.user_id, s.org_id, s.id);
	}
	async principalFor(userId: string, orgId: string): Promise<Principal | null> {
		return this.#principal(userId, orgId);
	}

	projectRole(userId: string, projectId: string): ProjectRole | null {
		const r = this.db.get<{ role: string }>("SELECT pm.role FROM id_project_members pm JOIN id_projects p ON p.id = pm.project_id WHERE pm.project_id = ? AND pm.user_id = ? AND pm.removed_at IS NULL AND p.archived_at IS NULL", projectId, userId);
		return (r?.role as ProjectRole) ?? null;
	}

	#spaceDecision(p: Principal, action: Action, space: Space | null): Decision {
		if (!space) return { allow: false, reason: "not_found" };
		if (space.orgId !== p.orgId) return { allow: false, reason: "other_org" };
		if (space.kind === "personal") return space.ownerUserId === p.userId ? { allow: true, reason: "owner" } : { allow: false, reason: "personal_space" };
		const role = this.projectRole(p.userId, space.projectId!);
		if (!role) return { allow: false, reason: "not_member" };
		if (action === "read" || action === "use") return { allow: true, reason: `role_${role}` };
		if (action === "write") return role === "viewer" ? { allow: false, reason: "role_viewer" } : { allow: true, reason: `role_${role}` };
		return role === "owner" ? { allow: true, reason: "role_owner" } : { allow: false, reason: `role_${role}` };
	}

	async check(p: Principal, action: Action, resource: ResourceRef): Promise<Decision> {
		// Re-validate the principal against current state on every check (revocation, removal, disable).
		const live = this.#principal(p.userId, p.orgId);
		if (!live) return { allow: false, reason: "revoked" };
		if (p.sessionId) {
			const s = this.db.get<any>("SELECT revoked_at FROM id_sessions WHERE id = ?", p.sessionId);
			if (!s || s.revoked_at) return { allow: false, reason: "session_revoked" };
		}
		switch (resource.kind) {
			case "org":
				if (resource.id !== live.orgId) return { allow: false, reason: "other_org" };
				if (action === "read" || action === "use") return { allow: true, reason: "member" };
				return live.orgRole === "member" ? { allow: false, reason: "not_admin" } : { allow: true, reason: live.orgRole };
			case "space":
				return this.#spaceDecision(live, action, this.space(resource.id));
			case "conversation":
				return this.#spaceDecision(live, action, this.space(resource.spaceId));
			case "project": {
				const space = this.projectSpace(resource.id);
				return this.#spaceDecision(live, action, space);
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
		if (!d.allow) throw new HttpError(d.reason === "revoked" || d.reason === "session_revoked" ? 401 : 403, "forbidden", `无权访问（${d.reason}）`, { reason: d.reason, resource });
	}
	async readableSpaces(p: Principal): Promise<Space[]> {
		const out = [this.personalSpace(p.userId, p.orgId)];
		for (const r of this.db.all<any>("SELECT s.* FROM id_spaces s JOIN id_project_members pm ON pm.project_id = s.project_id JOIN id_projects pr ON pr.id = s.project_id WHERE pm.user_id = ? AND pm.removed_at IS NULL AND pr.archived_at IS NULL AND s.org_id = ?", p.userId, p.orgId)) out.push(this.#spaceFromRow(r));
		return out;
	}

	createSession(userId: string, orgId: string, userAgent?: string): { token: string; id: string } {
		const token = randomBytes(32).toString("base64url");
		const id = newId("ses");
		this.db.run("INSERT INTO id_sessions (id, token_hash, user_id, org_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)", id, sha256(token), userId, orgId, nowIso(), new Date(Date.now() + 30 * 86400_000).toISOString(), userAgent ?? null);
		return { token, id };
	}

	/** Create user (+ org when orgId absent). Returns ids. */
	createUser(input: { email: string; name: string; password: string; orgId?: string; orgName?: string; role?: OrgRole }): { userId: string; orgId: string } {
		return this.db.tx(() => {
			if (this.db.get("SELECT 1 FROM id_users WHERE email = ?", input.email)) throw new HttpError(409, "email_taken", "该邮箱已注册");
			const userId = newId("usr");
			this.db.run("INSERT INTO id_users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)", userId, input.email.trim(), input.name.trim() || input.email, hashPassword(input.password), nowIso());
			let orgId = input.orgId;
			let role: OrgRole = input.role ?? "member";
			if (!orgId) {
				orgId = newId("org");
				this.db.run("INSERT INTO id_orgs (id, name, created_at) VALUES (?, ?, ?)", orgId, input.orgName?.trim() || `${input.name} 的工作区`, nowIso());
				role = "owner";
			}
			this.db.run("INSERT INTO id_org_members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)", orgId, userId, role, nowIso());
			audit(this.db, orgId, userId, "user.create", userId);
			return { userId, orgId };
		});
	}
}

function publicPrincipal(p: Principal, db: AppDb) {
	const org = db.get<{ name: string }>("SELECT name FROM id_orgs WHERE id = ?", p.orgId);
	return { userId: p.userId, orgId: p.orgId, orgName: org?.name, orgRole: p.orgRole, name: p.displayName, email: p.email, departmentIds: p.departmentIds };
}

export const identityModule: WorkroomModule = {
	name: "identity",
	migrations: MIGRATIONS,
	init(ctx) {
		const id = new Identity(ctx);
		ctx.services.provide("identity", id);
		ctx.services.provide("acl", id);
	},
	routes(api, ctx) {
		const id = ctx.services.get("identity") as Identity;
		const cookie = (c: any, token: string) => setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: "Lax", secure: ctx.config.secureCookies, path: "/", maxAge: 30 * 86400 });

		api.post("/auth/register", async (c) => {
			const b = await jsonBody<{ email: string; name: string; password: string; orgName?: string; inviteCode?: string }>(c);
			if (!b.email?.includes("@") || (b.password?.length ?? 0) < 8) throw new HttpError(400, "invalid", "邮箱无效或密码少于 8 位");
			let orgId: string | undefined;
			if (b.inviteCode) {
				const inv = ctx.db.get<any>("SELECT * FROM id_invites WHERE code = ? AND used_at IS NULL AND expires_at > ?", b.inviteCode, nowIso());
				if (!inv) throw new HttpError(400, "bad_invite", "邀请码无效或已过期");
				orgId = inv.org_id;
				ctx.db.run("UPDATE id_invites SET used_at = ? WHERE code = ?", nowIso(), b.inviteCode);
			}
			const { userId, orgId: org } = id.createUser({ email: b.email, name: b.name ?? b.email, password: b.password, orgId, orgName: b.orgName });
			const s = id.createSession(userId, org, c.req.header("user-agent"));
			cookie(c, s.token);
			return c.json({ me: publicPrincipal((await id.principalFor(userId, org))!, ctx.db), token: s.token });
		});
		api.post("/auth/login", async (c) => {
			const b = await jsonBody<{ email: string; password: string }>(c);
			const u = ctx.db.get<any>("SELECT * FROM id_users WHERE email = ?", b.email ?? "");
			if (!u || u.disabled_at || !verifyPassword(b.password ?? "", u.password_hash)) throw new HttpError(401, "bad_credentials", "邮箱或密码错误");
			const m = ctx.db.get<any>("SELECT org_id FROM id_org_members WHERE user_id = ? AND removed_at IS NULL ORDER BY created_at LIMIT 1", u.id);
			if (!m) throw new HttpError(403, "no_org", "账号不属于任何组织");
			const s = id.createSession(u.id, m.org_id, c.req.header("user-agent"));
			cookie(c, s.token);
			return c.json({ me: publicPrincipal((await id.principalFor(u.id, m.org_id))!, ctx.db), token: s.token });
		});
		api.post("/auth/logout", async (c) => {
			const p = c.get("principal");
			if (p?.sessionId) ctx.db.run("UPDATE id_sessions SET revoked_at = ? WHERE id = ?", nowIso(), p.sessionId);
			deleteCookie(c, SESSION_COOKIE, { path: "/" });
			return c.json({ ok: true });
		});
		api.get("/me", (c) => {
			const p = principalOf(c);
			return c.json({ me: publicPrincipal(p, ctx.db), personalSpaceId: id.personalSpace(p.userId, p.orgId).id, brand: ctx.config.brand });
		});

		// Projects (each project = its own space = its own pi-durable storage).
		api.get("/projects", async (c) => {
			const p = principalOf(c);
			const rows = ctx.db.all<any>("SELECT pr.*, pm.role, s.id AS space_id FROM id_projects pr JOIN id_project_members pm ON pm.project_id = pr.id AND pm.user_id = ? AND pm.removed_at IS NULL JOIN id_spaces s ON s.project_id = pr.id WHERE pr.org_id = ? AND pr.archived_at IS NULL ORDER BY pr.created_at DESC", p.userId, p.orgId);
			return c.json({ projects: rows.map((r) => ({ id: r.id, name: r.name, description: r.description, role: r.role, spaceId: r.space_id, createdAt: r.created_at })) });
		});
		api.post("/projects", async (c) => {
			const p = principalOf(c);
			const b = await jsonBody<{ name: string; description?: string }>(c);
			if (!b.name?.trim()) throw new HttpError(400, "invalid", "项目名称必填");
			const projectId = newId("prj");
			const spaceId = newId("sp");
			ctx.db.tx(() => {
				ctx.db.run("INSERT INTO id_projects (id, org_id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", projectId, p.orgId, b.name.trim(), b.description ?? "", p.userId, nowIso());
				ctx.db.run("INSERT INTO id_project_members (project_id, user_id, role, added_by, created_at) VALUES (?, ?, 'owner', ?, ?)", projectId, p.userId, p.userId, nowIso());
				ctx.db.run("INSERT INTO id_spaces (id, org_id, kind, project_id, created_at) VALUES (?, ?, 'project', ?, ?)", spaceId, p.orgId, projectId, nowIso());
				audit(ctx.db, p.orgId, p.userId, "project.create", projectId);
			});
			return c.json({ project: { id: projectId, name: b.name.trim(), role: "owner", spaceId } });
		});
		api.get("/projects/:id/members", async (c) => {
			const p = principalOf(c);
			await id.require(p, "read", { kind: "project", id: c.req.param("id") });
			const rows = ctx.db.all<any>("SELECT u.id, u.name, u.email, pm.role FROM id_project_members pm JOIN id_users u ON u.id = pm.user_id WHERE pm.project_id = ? AND pm.removed_at IS NULL", c.req.param("id"));
			return c.json({ members: rows });
		});
		api.put("/projects/:id/members", async (c) => {
			const p = principalOf(c);
			const projectId = c.req.param("id");
			await id.require(p, "admin", { kind: "project", id: projectId });
			const b = await jsonBody<{ email: string; role: ProjectRole | null }>(c);
			const u = ctx.db.get<any>("SELECT u.id FROM id_users u JOIN id_org_members m ON m.user_id = u.id AND m.org_id = ? AND m.removed_at IS NULL WHERE u.email = ?", p.orgId, b.email ?? "");
			if (!u) throw new HttpError(404, "user_not_found", "组织内没有该成员");
			ctx.db.tx(() => {
				if (b.role === null) ctx.db.run("UPDATE id_project_members SET removed_at = ? WHERE project_id = ? AND user_id = ? AND removed_at IS NULL", nowIso(), projectId, u.id);
				else {
					if (!["owner", "editor", "viewer"].includes(b.role)) throw new HttpError(400, "invalid_role", "角色无效");
					ctx.db.run("INSERT INTO id_project_members (project_id, user_id, role, added_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role, removed_at = NULL", projectId, u.id, b.role, p.userId, nowIso());
				}
				audit(ctx.db, p.orgId, p.userId, b.role === null ? "project.member.remove" : "project.member.set", projectId, { userId: u.id, role: b.role });
			});
			return c.json({ ok: true });
		});
	},
};

export const identityInviteMigration = {
	version: 2,
	name: "invites",
	sql: `CREATE TABLE id_invites (code TEXT PRIMARY KEY, org_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);`,
};
(MIGRATIONS as any[]).push(identityInviteMigration);
