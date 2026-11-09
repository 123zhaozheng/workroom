// HTTP routes for identity: auth, sessions, 2FA, org admin (members, departments, invites, audit), projects, shares.
import type { Context as HonoContext, Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import type { AppContext, AppEnv, OrgRole, Principal, ProjectRole, ResourceRef } from "../core/contracts.ts";
import { SESSION_COOKIE } from "../core/app.ts";
import { HttpError, jsonBody, newId, nowIso, principalOf } from "../core/http.ts";
import { audit, hashPassword, shareResourceRef, verifyPassword, type Identity, type ShareRow } from "./module.ts";
import { newTotpSecret, otpauthUrl, verifyTotp } from "./totp.ts";
import { toCsv } from "./csv.ts";
import { registerOidcRoutes } from "./oidc.ts";
import { registerRbacRoutes, setBaseRole } from "./rbac-routes.ts";
import { policyAuthorized, registerPolicyMiddleware } from "./policy.ts";
import { BASE_ROLE_IDS, builtinRole, permissionDef } from "../../../shared/permissions.ts";

const ORG_ROLES: OrgRole[] = ["owner", "admin", "member"];
/** Base roles accepted by the legacy `role` fields (guest is a base role that maps to orgRole "member"). */
const BASE_ROLE_BY_NAME: Record<string, string> = { owner: "builtin:owner", admin: "builtin:admin", member: "builtin:member", guest: "builtin:guest" };
const PROJECT_ROLES: ProjectRole[] = ["owner", "editor", "viewer"];

export function publicPrincipal(p: Principal, ctx: AppContext) {
	const org = ctx.db.get<{ name: string }>("SELECT name FROM id_orgs WHERE id = ?", p.orgId);
	const u = ctx.db.get<{ totp_enabled_at: string | null }>("SELECT totp_enabled_at FROM id_users WHERE id = ?", p.userId);
	const az = (ctx.services.get("identity") as Identity).authz;
	const a = az.load(p.userId, p.orgId);
	const permissions = a ? [...az.permissionsAt(a)] : [];
	const anywhere = a ? [...az.permissionsAnywhere(a)] : [];
	const baseRoleId = a?.assignments.find((x) => x.via === "direct" && x.scope_kind === "org" && BASE_ROLE_IDS.includes(x.role_id))?.role_id;
	const roles = a ? a.assignments.map((x) => ({ roleId: x.role_id, name: a.roles.get(x.role_id)?.name ?? x.role_id, scope: x.scope_kind === "org" ? { kind: "org" } : { kind: x.scope_kind, id: x.scope_id } })) : [];
	return { userId: p.userId, orgId: p.orgId, orgName: org?.name, orgRole: p.orgRole, name: p.displayName, email: p.email, departmentIds: [...p.departmentIds], totpEnabled: !!u?.totp_enabled_at, baseRole: baseRoleId, roles, permissions, permissionsAnywhere: anywhere };
}

export function setSessionCookie(c: HonoContext<AppEnv>, ctx: AppContext, token: string): void {
	setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: "Lax", secure: ctx.config.secureCookies, path: "/", maxAge: 30 * 86400 });
}

/** Legacy guard kept for other modules: "may change organisation settings" (RBAC: org.settings.manage). */
export async function requireOrgAdmin(id: Identity, p: Principal): Promise<void> {
	if (policyAuthorized()) return; // the route policy (identity/policy.ts) already required the route's specific permission
	await id.authz.require(p, "org.settings.manage");
}

function memberRow(ctx: AppContext, orgId: string, userId: string) {
	return ctx.db.get<any>("SELECT m.*, u.name, u.email FROM id_org_members m JOIN id_users u ON u.id = m.user_id WHERE m.org_id = ? AND m.user_id = ? AND m.removed_at IS NULL", orgId, userId);
}

function ownerCount(id: Identity, orgId: string): number {
	return id.authz.activeOwnerIds(orgId).length;
}

/** RBAC rule set for acting on a member: permission at org or covering department, target must not outrank the actor, owners need org.owner.manage, last owner is protected. */
function assertCanManage(ctx: AppContext, id: Identity, actor: Principal, targetId: string, perm: string, op: "role" | "disable" | "remove"): void {
	const a = id.authz.load(actor.userId, actor.orgId);
	if (!a) throw new HttpError(401, "revoked", "账号已不在组织中");
	const target = ctx.db.get<any>("SELECT * FROM id_org_members WHERE org_id = ? AND user_id = ? AND removed_at IS NULL", actor.orgId, targetId);
	if (!target) throw new HttpError(404, "member_not_found", "组织内没有该成员");
	if (targetId === actor.userId && op !== "role") throw new HttpError(400, "cannot_target_self", "不能对自己执行此操作");
	if (!id.authz.decide(a, perm).allow && !id.authz.permissionsAnywhere(a).has(perm)) throw new HttpError(403, "forbidden", `缺少权限：${permissionDef(perm)?.label ?? perm}（${perm}）`, { reason: "missing_permission", permission: perm });
	const r = id.authz.canActOnMember(a, perm, targetId);
	if (!r.ok) {
		const map: Record<string, [number, string, string]> = { owner_required: [403, "owner_required", "只有所有者可以变更所有者"], target_outranks_actor: [403, "target_outranks", "该成员的权限高于你，无法操作"], outside_scope: [403, "outside_scope", "该成员不在你可管理的部门范围内"], member_not_found: [404, "member_not_found", "组织内没有该成员"] };
		const [st, code, msg] = map[r.reason] ?? [403, "forbidden", r.reason];
		throw new HttpError(st, code, msg, { reason: r.reason });
	}
	const t = id.authz.load(targetId, actor.orgId, { includeDisabled: true });
	if (t?.isOwner && op !== "role" && ownerCount(id, actor.orgId) <= 1) throw new HttpError(409, "last_owner", "组织至少需要一位有效的所有者");
}

function sessionDto(r: any, currentId?: string) {
	return { id: r.id, userId: r.user_id, userName: r.user_name ?? undefined, createdAt: r.created_at, lastSeenAt: r.last_seen_at ?? undefined, expiresAt: r.expires_at, userAgent: r.user_agent ?? undefined, current: r.id === currentId, revokedAt: r.revoked_at ?? undefined, revokedReason: r.revoked_reason ?? undefined, authMethod: r.auth_method ?? "password" };
}

function shareDto(id: Identity, r: ShareRow) {
	return {
		id: r.id,
		resource: { kind: r.resource_kind, id: r.resource_id, spaceId: r.space_id ?? undefined },
		permission: "read" as const,
		createdBy: r.created_by,
		createdAt: r.created_at,
		expiresAt: r.expires_at,
		revokedAt: r.revoked_at ?? undefined,
		revokedReason: r.revoked_reason ?? undefined,
		lastUsedAt: r.last_used_at ?? undefined,
		useCount: r.use_count,
		status: id.shareStatus(r),
	};
}

export function registerIdentityRoutes(api: Hono<AppEnv>, ctx: AppContext, id: Identity): void {
	const db = ctx.db;
	const rid = (c: HonoContext<AppEnv>) => c.get("requestId");
	registerPolicyMiddleware(api, ctx, id);

	/** Roles carried by an invite: guest replaces the base role; any other role is granted at org (or the invite's department) scope. */
	const applyInviteRole = (inv: any, userId: string): void => {
		if (!inv.role_id) return;
		if (inv.role_id === "builtin:guest") return setBaseRole(ctx, inv.org_id, userId, "builtin:guest", "invite");
		if (!id.authz.rolePermissions(inv.org_id, inv.role_id)) return; // role deleted since the invite was created
		const def = builtinRole(inv.role_id);
		const kind = inv.department_id && (!def || def.scopes.includes("department")) ? "department" : "org";
		if (def && !def.scopes.includes(kind)) return;
		db.run("INSERT OR IGNORE INTO id_role_assignments (id, org_id, subject_kind, subject_id, role_id, scope_kind, scope_id, created_by, created_at) VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?)", newId("ra"), inv.org_id, userId, inv.role_id, kind, kind === "department" ? inv.department_id : "", inv.created_by ?? "invite", nowIso());
	};

	// ---------------------------------------------------------------- auth
	api.post("/auth/register", async (c) => {
		const b = await jsonBody<{ email: string; name: string; password: string; orgName?: string; inviteCode?: string }>(c);
		if (!b.email?.includes("@") || (b.password?.length ?? 0) < 8) throw new HttpError(400, "invalid", "邮箱无效或密码少于 8 位");
		let created: { userId: string; orgId: string };
		if (b.inviteCode) {
			created = db.tx(() => {
				const inv = id.consumeInvite(b.inviteCode!, b.email);
				const r = id.createUser({ email: b.email, name: b.name ?? b.email, password: b.password, orgId: inv.org_id, role: inv.role });
				if (inv.department_id) db.run("INSERT OR IGNORE INTO id_department_members (department_id, user_id, created_at) VALUES (?, ?, ?)", inv.department_id, r.userId, nowIso());
				audit(db, inv.org_id, r.userId, "auth.invite_accepted", b.inviteCode, { role: inv.role }, { requestId: rid(c) });
				return r;
			});
		} else created = id.createUser({ email: b.email, name: b.name ?? b.email, password: b.password, orgName: b.orgName });
		const s = id.createSession(created.userId, created.orgId, c.req.header("user-agent"), b.inviteCode ? "invite" : "password");
		setSessionCookie(c, ctx, s.token);
		return c.json({ me: publicPrincipal((await id.principalFor(created.userId, created.orgId))!, ctx), token: s.token });
	});

	api.post("/auth/login", async (c) => {
		const b = await jsonBody<{ email: string; password: string; totp?: string; orgId?: string }>(c);
		const u = db.get<any>("SELECT * FROM id_users WHERE email = ?", b.email ?? "");
		if (!u || u.disabled_at || !verifyPassword(b.password ?? "", u.password_hash)) {
			if (u) audit(db, null, u.id, "auth.login_failed", u.id, { reason: "bad_credentials" }, { requestId: rid(c) });
			throw new HttpError(401, "bad_credentials", "邮箱或密码错误");
		}
		if (u.totp_enabled_at) {
			if (!b.totp) throw new HttpError(401, "totp_required", "请输入两步验证码");
			const secret = u.totp_secret.startsWith("v1:") ? id.secrets.open(u.totp_secret) : u.totp_secret;
			const step = verifyTotp(secret, b.totp, id.now(), u.totp_last_step);
			if (step === null) {
				audit(db, null, u.id, "auth.login_failed", u.id, { reason: "totp_invalid" }, { requestId: rid(c) });
				throw new HttpError(401, "totp_invalid", "两步验证码错误或已使用");
			}
			db.run("UPDATE id_users SET totp_last_step = ? WHERE id = ?", step, u.id);
		}
		const orgs = db.all<any>("SELECT org_id FROM id_org_members WHERE user_id = ? AND removed_at IS NULL AND disabled_at IS NULL ORDER BY created_at", u.id).map((r) => r.org_id as string);
		if (orgs.length === 0) throw new HttpError(403, "no_org", "账号不属于任何有效组织（可能已被停用或移除）");
		const orgId = b.orgId && orgs.includes(b.orgId) ? b.orgId : u.last_org_id && orgs.includes(u.last_org_id) ? u.last_org_id : orgs[0]!;
		const s = id.createSession(u.id, orgId, c.req.header("user-agent"));
		audit(db, orgId, u.id, "auth.login", s.id, { method: u.totp_enabled_at ? "password+totp" : "password" }, { requestId: rid(c) });
		setSessionCookie(c, ctx, s.token);
		return c.json({ me: publicPrincipal((await id.principalFor(u.id, orgId))!, ctx), token: s.token });
	});

	api.post("/auth/logout", async (c) => {
		const p = c.get("principal");
		if (p?.sessionId) db.run("UPDATE id_sessions SET revoked_at = ?, revoked_reason = 'logout' WHERE id = ? AND revoked_at IS NULL", nowIso(), p.sessionId);
		deleteCookie(c, SESSION_COOKIE, { path: "/" });
		return c.json({ ok: true });
	});

	api.post("/auth/switch-org", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ orgId: string }>(c);
		const target = await id.principalFor(p.userId, b.orgId ?? "");
		if (!target) throw new HttpError(403, "not_member", "你不是该组织的有效成员");
		if (p.sessionId) db.run("UPDATE id_sessions SET revoked_at = ?, revoked_reason = 'switch_org' WHERE id = ?", nowIso(), p.sessionId);
		const s = id.createSession(p.userId, target.orgId, c.req.header("user-agent"));
		setSessionCookie(c, ctx, s.token);
		return c.json({ me: publicPrincipal(target, ctx), token: s.token });
	});

	api.post("/auth/accept-invite", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ inviteCode: string }>(c);
		const inv = db.tx(() => {
			const inv = id.consumeInvite(b.inviteCode ?? "", p.email);
			id.addOrgMember(inv.org_id, p.userId, inv.role);
			if (inv.department_id) db.run("INSERT INTO id_department_members (department_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET removed_at = NULL", inv.department_id, p.userId, nowIso());
			audit(db, inv.org_id, p.userId, "auth.invite_accepted", b.inviteCode, { role: inv.role }, { requestId: rid(c) });
			return inv;
		});
		return c.json({ orgId: inv.org_id, role: inv.role });
	});

	api.get("/me", (c) => {
		const p = principalOf(c);
		return c.json({ me: publicPrincipal(p, ctx), personalSpaceId: id.personalSpace(p.userId, p.orgId).id, brand: ctx.config.brand });
	});
	api.get("/me/orgs", (c) => {
		const p = principalOf(c);
		const rows = db.all<any>("SELECT m.org_id, m.role, o.name FROM id_org_members m JOIN id_orgs o ON o.id = m.org_id WHERE m.user_id = ? AND m.removed_at IS NULL AND m.disabled_at IS NULL ORDER BY m.created_at", p.userId);
		return c.json({ orgs: rows.map((r) => ({ orgId: r.org_id, orgName: r.name, role: r.role, current: r.org_id === p.orgId })) });
	});
	api.post("/me/password", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ current: string; next: string }>(c);
		const u = db.get<any>("SELECT password_hash FROM id_users WHERE id = ?", p.userId);
		if (u.password_hash && !verifyPassword(b.current ?? "", u.password_hash)) throw new HttpError(401, "bad_credentials", "当前密码错误");
		if ((b.next?.length ?? 0) < 8) throw new HttpError(400, "invalid", "新密码至少 8 位");
		db.run("UPDATE id_users SET password_hash = ? WHERE id = ?", hashPassword(b.next), p.userId);
		const n = id.revokeSessions(p.userId, null, "password_changed", p.sessionId);
		audit(db, p.orgId, p.userId, "auth.password_changed", p.userId, { revokedSessions: n }, { requestId: rid(c) });
		return c.json({ ok: true, revokedSessions: n });
	});

	// ---------------------------------------------------------------- sessions
	api.get("/me/sessions", (c) => {
		const p = principalOf(c);
		const rows = db.all<any>("SELECT * FROM id_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC", p.userId, nowIso());
		return c.json({ sessions: rows.map((r) => sessionDto(r, p.sessionId)) });
	});
	api.delete("/me/sessions/:sid", (c) => {
		const p = principalOf(c);
		const r = db.run("UPDATE id_sessions SET revoked_at = ?, revoked_reason = 'user_revoked' WHERE id = ? AND user_id = ? AND revoked_at IS NULL", nowIso(), c.req.param("sid"), p.userId);
		if (r.changes === 0) throw new HttpError(404, "not_found", "会话不存在");
		audit(db, p.orgId, p.userId, "session.revoke", c.req.param("sid"), undefined, { requestId: rid(c) });
		return c.json({ ok: true });
	});
	api.post("/me/sessions/revoke-others", (c) => {
		const p = principalOf(c);
		const n = id.revokeSessions(p.userId, null, "user_revoked_others", p.sessionId);
		audit(db, p.orgId, p.userId, "session.revoke_others", p.userId, { count: n }, { requestId: rid(c) });
		return c.json({ revoked: n });
	});

	// ---------------------------------------------------------------- TOTP 2FA
	api.post("/me/2fa/setup", (c) => {
		const p = principalOf(c);
		const u = db.get<any>("SELECT totp_enabled_at FROM id_users WHERE id = ?", p.userId);
		if (u.totp_enabled_at) throw new HttpError(409, "totp_already_enabled", "已启用两步验证");
		const secret = newTotpSecret();
		db.run("UPDATE id_users SET totp_pending = ? WHERE id = ?", id.secrets.available ? id.secrets.seal(secret) : secret, p.userId);
		return c.json({ secret, otpauthUrl: otpauthUrl(secret, p.email, ctx.config.brand.name) });
	});
	api.post("/me/2fa/enable", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ code: string }>(c);
		const u = db.get<any>("SELECT totp_pending FROM id_users WHERE id = ?", p.userId);
		if (!u.totp_pending) throw new HttpError(400, "totp_not_setup", "请先生成两步验证密钥");
		const secret = u.totp_pending.startsWith("v1:") ? id.secrets.open(u.totp_pending) : u.totp_pending;
		const step = verifyTotp(secret, b.code ?? "", id.now());
		if (step === null) throw new HttpError(400, "totp_invalid", "验证码错误");
		db.run("UPDATE id_users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled_at = ?, totp_last_step = ? WHERE id = ?", nowIso(), step, p.userId);
		const n = id.revokeSessions(p.userId, null, "totp_enabled", p.sessionId);
		audit(db, p.orgId, p.userId, "totp.enable", p.userId, { revokedSessions: n }, { requestId: rid(c) });
		return c.json({ ok: true });
	});
	api.post("/me/2fa/disable", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ code: string }>(c);
		const u = db.get<any>("SELECT totp_secret, totp_enabled_at, totp_last_step FROM id_users WHERE id = ?", p.userId);
		if (!u.totp_enabled_at) throw new HttpError(400, "totp_not_enabled", "未启用两步验证");
		const secret = u.totp_secret.startsWith("v1:") ? id.secrets.open(u.totp_secret) : u.totp_secret;
		if (verifyTotp(secret, b.code ?? "", id.now(), u.totp_last_step) === null) throw new HttpError(400, "totp_invalid", "验证码错误");
		db.run("UPDATE id_users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = ?", p.userId);
		audit(db, p.orgId, p.userId, "totp.disable", p.userId, undefined, { requestId: rid(c) });
		return c.json({ ok: true });
	});

	// ---------------------------------------------------------------- org + members
	api.get("/org", (c) => {
		const p = principalOf(c);
		const org = db.get<any>("SELECT * FROM id_orgs WHERE id = ?", p.orgId);
		const n = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM id_org_members WHERE org_id = ? AND removed_at IS NULL", p.orgId)!.n;
		return c.json({ org: { id: org.id, name: org.name, createdAt: org.created_at, memberCount: n }, myRole: p.orgRole });
	});
	api.patch("/org", async (c) => {
		const p = principalOf(c);
		await id.authz.require(p, "org.settings.manage");
		const b = await jsonBody<{ name?: string }>(c);
		if (!b.name?.trim()) throw new HttpError(400, "invalid", "名称必填");
		db.run("UPDATE id_orgs SET name = ? WHERE id = ?", b.name.trim(), p.orgId);
		audit(db, p.orgId, p.userId, "org.rename", p.orgId, { name: b.name.trim() }, { requestId: rid(c) });
		return c.json({ ok: true });
	});
	/** Member directory (any member): for project member pickers. No status/sessions. */
	api.get("/org/members", (c) => {
		const p = principalOf(c);
		const rows = db.all<any>("SELECT u.id, u.name, u.email, m.role FROM id_org_members m JOIN id_users u ON u.id = m.user_id WHERE m.org_id = ? AND m.removed_at IS NULL AND m.disabled_at IS NULL AND u.disabled_at IS NULL ORDER BY u.name", p.orgId);
		return c.json({ members: rows.map((r) => ({ userId: r.id, name: r.name, email: r.email, role: r.role })) });
	});

	/** Authorization helpers: load the actor's access once per request. */
	const axOf = (p: Principal) => {
		const a = id.authz.load(p.userId, p.orgId);
		if (!a) throw new HttpError(401, "revoked", "账号已不在组织中");
		return a;
	};
	const needPerm = (a: ReturnType<typeof axOf>, perm: string, scope?: { kind: "department" | "project"; id: string }): void => {
		const d = id.authz.decide(a, perm, scope);
		if (!d.allow) throw new HttpError(403, "forbidden", `缺少权限：${permissionDef(perm)?.label ?? perm}（${perm}）`, { reason: "missing_permission", permission: perm, because: d.because });
	};
	/** Departments (ids) where the actor holds `perm`; "all" when org-wide. */
	const deptScopesFor = (a: ReturnType<typeof axOf>, perm: string): "all" | Set<string> => {
		if (id.authz.decide(a, perm).allow) return "all";
		const set = new Set<string>();
		for (const d of a.deptParent.keys()) if (id.authz.decide(a, perm, { kind: "department", id: d }).allow) set.add(d);
		if (set.size === 0) needPerm(a, perm);
		return set;
	};
	const rolePermsOf = (orgId: string, roleId: string): string[] => {
		const perms = id.authz.rolePermissions(orgId, roleId);
		if (!perms) throw new HttpError(404, "role_not_found", "角色不存在");
		return perms;
	};
	const noEscalation = (a: ReturnType<typeof axOf>, perms: readonly string[], scope?: { kind: "department" | "project"; id: string }): void => {
		const mine = id.authz.permissionsAt(a, scope);
		const missing = perms.filter((x) => !mine.has(x));
		if (missing.length) throw new HttpError(403, "privilege_escalation", `不能授予你自己没有的权限：${missing.map((x) => permissionDef(x)?.label ?? x).join("、")}`, { reason: "privilege_escalation", missing });
	};

	api.get("/admin/members", async (c) => {
		const p = principalOf(c);
		const a = axOf(p);
		const scopes = deptScopesFor(a, "member.view");
		const rows = db.all<any>(
			`SELECT u.id, u.name, u.email, u.totp_enabled_at, u.disabled_at AS user_disabled, m.role, m.created_at, m.disabled_at,
			 (SELECT MAX(last_seen_at) FROM id_sessions s WHERE s.user_id = u.id AND s.org_id = m.org_id) AS last_seen,
			 (SELECT COUNT(*) FROM id_sessions s WHERE s.user_id = u.id AND s.org_id = m.org_id AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_sessions
			 FROM id_org_members m JOIN id_users u ON u.id = m.user_id WHERE m.org_id = ? AND m.removed_at IS NULL ORDER BY m.created_at`,
			nowIso(),
			p.orgId,
		);
		const deps = db.all<any>("SELECT dm.user_id, dm.department_id FROM id_department_members dm JOIN id_departments d ON d.id = dm.department_id WHERE d.org_id = ? AND dm.removed_at IS NULL AND d.archived_at IS NULL", p.orgId);
		const assigns = db.all<any>("SELECT subject_id, role_id, scope_kind, scope_id FROM id_role_assignments WHERE org_id = ? AND subject_kind = 'user'", p.orgId);
		const members = rows.map((r) => {
			const myDeps = deps.filter((d) => d.user_id === r.id).map((d) => d.department_id as string);
			return {
				userId: r.id,
				name: r.name,
				email: r.email,
				role: r.role,
				status: r.disabled_at || r.user_disabled ? "disabled" : "active",
				departmentIds: myDeps,
				joinedAt: r.created_at,
				lastSeenAt: r.last_seen ?? undefined,
				activeSessions: r.active_sessions,
				totpEnabled: !!r.totp_enabled_at,
				roles: assigns.filter((x) => x.subject_id === r.id).map((x) => ({ roleId: x.role_id, name: id.authz.roleName(p.orgId, x.role_id) ?? x.role_id, scope: x.scope_kind === "org" ? { kind: "org" } : { kind: x.scope_kind, id: x.scope_id } })),
			};
		});
		// Department-scoped viewers only see members of their department subtree (and themselves).
		return c.json({ members: scopes === "all" ? members : members.filter((m) => m.userId === p.userId || m.departmentIds.some((d: string) => scopes.has(d))) });
	});
	api.patch("/admin/members/:userId", async (c) => {
		const p = principalOf(c);
		const a = axOf(p);
		needPerm(a, "role.assign");
		const b = await jsonBody<{ role: string }>(c);
		const newBase = BASE_ROLE_BY_NAME[b.role ?? ""];
		if (!newBase) throw new HttpError(400, "invalid_role", "角色无效");
		const targetId = c.req.param("userId");
		const target = memberRow(ctx, p.orgId, targetId);
		if (!target) throw new HttpError(404, "member_not_found", "组织内没有该成员");
		const t = id.authz.load(targetId, p.orgId, { includeDisabled: true })!;
		const touchesOwner = t.isOwner || newBase === "builtin:owner";
		if (touchesOwner) {
			if (!id.authz.decide(a, "org.owner.manage").allow) throw new HttpError(403, "owner_required", "只有所有者可以变更所有者");
		}
		assertCanManage(ctx, id, p, targetId, "role.assign", "role");
		noEscalation(a, rolePermsOf(p.orgId, newBase));
		if (t.isOwner && newBase !== "builtin:owner" && ownerCount(id, p.orgId) <= 1) throw new HttpError(409, "last_owner", "组织至少需要一位有效的所有者");
		const from = t.assignments.find((x) => x.via === "direct" && x.scope_kind === "org" && BASE_ROLE_IDS.includes(x.role_id))?.role_id;
		setBaseRole(ctx, p.orgId, targetId, newBase, p.userId);
		audit(db, p.orgId, p.userId, "grant.org_role", targetId, { from: target.role, to: b.role, fromRoleId: from, toRoleId: newBase }, { requestId: rid(c), category: "grant" });
		return c.json({ ok: true });
	});
	api.post("/admin/members/:userId/disable", async (c) => {
		const p = principalOf(c);
		const targetId = c.req.param("userId");
		assertCanManage(ctx, id, p, targetId, "member.disable", "disable");
		const target = memberRow(ctx, p.orgId, targetId);
		const n = db.tx(() => {
			db.run("UPDATE id_org_members SET disabled_at = ?, disabled_by = ? WHERE org_id = ? AND user_id = ?", nowIso(), p.userId, p.orgId, target.user_id);
			return id.revokeSessions(target.user_id, p.orgId, "member_disabled");
		});
		audit(db, p.orgId, p.userId, "member.disable", target.user_id, { revokedSessions: n }, { requestId: rid(c) });
		return c.json({ ok: true, revokedSessions: n });
	});
	api.post("/admin/members/:userId/enable", async (c) => {
		const p = principalOf(c);
		assertCanManage(ctx, id, p, c.req.param("userId"), "member.disable", "role");
		const target = memberRow(ctx, p.orgId, c.req.param("userId"));
		db.run("UPDATE id_org_members SET disabled_at = NULL, disabled_by = NULL WHERE org_id = ? AND user_id = ?", p.orgId, target.user_id);
		audit(db, p.orgId, p.userId, "member.enable", target.user_id, undefined, { requestId: rid(c) });
		return c.json({ ok: true });
	});
	api.delete("/admin/members/:userId", async (c) => {
		const p = principalOf(c);
		assertCanManage(ctx, id, p, c.req.param("userId"), "member.remove", "remove");
		const target = memberRow(ctx, p.orgId, c.req.param("userId"));
		const out = db.tx(() => {
			const at = nowIso();
			// The id_om_rbac_removed trigger also drops this member's role assignments, direct grants and group memberships.
			db.run("UPDATE id_org_members SET removed_at = ? WHERE org_id = ? AND user_id = ?", at, p.orgId, target.user_id);
			const projects = db.run("UPDATE id_project_members SET removed_at = ? WHERE user_id = ? AND removed_at IS NULL AND project_id IN (SELECT id FROM id_projects WHERE org_id = ?)", at, target.user_id, p.orgId).changes;
			db.run("UPDATE id_department_members SET removed_at = ? WHERE user_id = ? AND removed_at IS NULL AND department_id IN (SELECT id FROM id_departments WHERE org_id = ?)", at, target.user_id, p.orgId);
			const sessions = id.revokeSessions(target.user_id, p.orgId, "member_removed");
			const shares = id.revokeSharesCreatedBy(target.user_id, p.orgId, null, "creator_removed");
			return { projects, sessions, shares };
		});
		audit(db, p.orgId, p.userId, "member.remove", target.user_id, out, { requestId: rid(c) });
		return c.json({ ok: true, ...out });
	});

	api.get("/admin/sessions", async (c) => {
		const p = principalOf(c);
		await id.authz.require(p, "member.session.manage");
		const userId = c.req.query("userId");
		const rows = db.all<any>(
			`SELECT s.*, u.name AS user_name FROM id_sessions s JOIN id_users u ON u.id = s.user_id WHERE s.org_id = ? AND s.revoked_at IS NULL AND s.expires_at > ? ${userId ? "AND s.user_id = ?" : ""} ORDER BY s.created_at DESC LIMIT 500`,
			...(userId ? [p.orgId, nowIso(), userId] : [p.orgId, nowIso()]),
		);
		return c.json({ sessions: rows.map((r) => sessionDto(r, p.sessionId)) });
	});
	api.delete("/admin/sessions/:sid", async (c) => {
		const p = principalOf(c);
		await id.authz.require(p, "member.session.manage");
		const r = db.run("UPDATE id_sessions SET revoked_at = ?, revoked_reason = 'admin_revoked' WHERE id = ? AND org_id = ? AND revoked_at IS NULL", nowIso(), c.req.param("sid"), p.orgId);
		if (r.changes === 0) throw new HttpError(404, "not_found", "会话不存在");
		audit(db, p.orgId, p.userId, "session.admin_revoke", c.req.param("sid"), undefined, { requestId: rid(c) });
		return c.json({ ok: true });
	});

	// ---------------------------------------------------------------- invites
	const inviteDto = (r: any) => ({ code: r.code, email: r.email ?? undefined, role: r.role, roleId: r.role_id ?? undefined, roleName: r.role_id ? id.authz.roleName(r.org_id, r.role_id) : undefined, departmentId: r.department_id ?? undefined, createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at, usedAt: r.used_at ?? undefined, revokedAt: r.revoked_at ?? undefined });
	api.get("/admin/invites", async (c) => {
		const p = principalOf(c);
		const a = axOf(p);
		const scopes = deptScopesFor(a, "member.invite");
		const rows = db.all<any>("SELECT * FROM id_invites WHERE org_id = ? ORDER BY created_at DESC LIMIT 200", p.orgId).filter((r) => scopes === "all" || (r.department_id && scopes.has(r.department_id)));
		return c.json({ invites: rows.map(inviteDto) });
	});
	api.post("/admin/invites", async (c) => {
		const p = principalOf(c);
		const a = axOf(p);
		const b = await jsonBody<{ email?: string; role?: string; roleId?: string; departmentId?: string; ttlHours?: number }>(c);
		const baseName = b.role ?? "member";
		if (!BASE_ROLE_BY_NAME[baseName]) throw new HttpError(400, "invalid_role", "角色无效");
		if (b.departmentId && !db.get("SELECT 1 FROM id_departments WHERE id = ? AND org_id = ? AND archived_at IS NULL", b.departmentId, p.orgId)) throw new HttpError(404, "department_not_found", "部门不存在");
		const scope = b.departmentId ? ({ kind: "department", id: b.departmentId } as const) : undefined;
		needPerm(a, "member.invite", scope);
		if (baseName === "owner" && !id.authz.decide(a, "org.owner.manage").allow) throw new HttpError(403, "owner_required", "只有所有者可以邀请所有者");
		noEscalation(a, rolePermsOf(p.orgId, BASE_ROLE_BY_NAME[baseName]!), scope);
		// `guest` is a base role stored as orgRole "member" + role_id builtin:guest; any other roleId is an extra role granted on accept.
		let roleId = b.roleId ?? (baseName === "guest" ? "builtin:guest" : undefined);
		const legacy = baseName === "guest" ? "member" : baseName;
		if (roleId && roleId !== "builtin:guest") {
			if (BASE_ROLE_IDS.includes(roleId)) throw new HttpError(400, "invalid_role", "基础角色请用 role 字段指定");
			const def = builtinRole(roleId);
			const kind = b.departmentId ? "department" : "org";
			if (def && !def.scopes.includes(kind)) throw new HttpError(400, "role_scope_mismatch", `「${def.name}」不能分配在该范围`);
			needPerm(a, "role.assign", scope);
			noEscalation(a, rolePermsOf(p.orgId, roleId), scope);
		}
		if (b.role === "guest" && b.roleId && b.roleId !== "builtin:guest") roleId = b.roleId;
		const ttl = Math.min(Math.max(b.ttlHours ?? 72, 1), 24 * 30);
		const code = randomBytes(12).toString("base64url");
		const expiresAt = new Date(Date.now() + ttl * 3600_000).toISOString();
		db.run("INSERT INTO id_invites (code, org_id, role, created_by, created_at, expires_at, email, department_id, role_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", code, p.orgId, legacy, p.userId, nowIso(), expiresAt, b.email ?? null, b.departmentId ?? null, roleId ?? null);
		audit(db, p.orgId, p.userId, "grant.invite_create", code.slice(0, 4) + "…", { role: baseName, roleId, email: b.email, departmentId: b.departmentId }, { requestId: rid(c), category: "grant" });
		return c.json({ invite: inviteDto(db.get<any>("SELECT * FROM id_invites WHERE code = ?", code)) });
	});
	api.delete("/admin/invites/:code", async (c) => {
		const p = principalOf(c);
		const a = axOf(p);
		const inv = db.get<any>("SELECT * FROM id_invites WHERE code = ? AND org_id = ?", c.req.param("code"), p.orgId);
		if (!inv) throw new HttpError(404, "not_found", "邀请不存在或已失效");
		needPerm(a, "member.invite", inv.department_id ? { kind: "department", id: inv.department_id } : undefined);
		const r = db.run("UPDATE id_invites SET revoked_at = ? WHERE code = ? AND org_id = ? AND used_at IS NULL AND revoked_at IS NULL", nowIso(), c.req.param("code"), p.orgId);
		if (r.changes === 0) throw new HttpError(404, "not_found", "邀请不存在或已失效");
		audit(db, p.orgId, p.userId, "grant.invite_revoke", c.req.param("code").slice(0, 4) + "…", undefined, { requestId: rid(c), category: "grant" });
		return c.json({ ok: true });
	});

	// ---------------------------------------------------------------- departments
	const deptDto = (r: any) => ({ id: r.id, name: r.name, parentId: r.parent_id ?? undefined, memberCount: r.member_count ?? 0, createdAt: r.created_at });
	const deptQuery = "SELECT d.*, (SELECT COUNT(*) FROM id_department_members dm JOIN id_org_members m ON m.user_id = dm.user_id AND m.org_id = d.org_id AND m.removed_at IS NULL WHERE dm.department_id = d.id AND dm.removed_at IS NULL) AS member_count FROM id_departments d";
	api.get("/departments", (c) => {
		const p = principalOf(c);
		return c.json({ departments: db.all<any>(`${deptQuery} WHERE d.org_id = ? AND d.archived_at IS NULL ORDER BY d.name`, p.orgId).map(deptDto) });
	});
	const getDept = (orgId: string, deptId: string) => {
		const d = db.get<any>(`${deptQuery} WHERE d.id = ? AND d.org_id = ? AND d.archived_at IS NULL`, deptId, orgId);
		if (!d) throw new HttpError(404, "department_not_found", "部门不存在");
		return d;
	};
	const deptScope = (deptId: string | null | undefined) => (deptId ? ({ kind: "department", id: deptId } as const) : undefined);
	api.post("/admin/departments", async (c) => {
		const p = principalOf(c);
		const a = axOf(p);
		const b = await jsonBody<{ name: string; parentId?: string }>(c);
		if (!b.name?.trim()) throw new HttpError(400, "invalid", "部门名称必填");
		if (b.parentId) getDept(p.orgId, b.parentId);
		needPerm(a, "dept.manage", deptScope(b.parentId));
		const deptId = newId("dep");
		db.run("INSERT INTO id_departments (id, org_id, name, parent_id, created_at) VALUES (?, ?, ?, ?, ?)", deptId, p.orgId, b.name.trim(), b.parentId ?? null, nowIso());
		audit(db, p.orgId, p.userId, "department.create", deptId, { name: b.name.trim(), parentId: b.parentId }, { requestId: rid(c) });
		return c.json({ department: deptDto(getDept(p.orgId, deptId)) });
	});
	api.patch("/admin/departments/:id", async (c) => {
		const p = principalOf(c);
		const a = axOf(p);
		const d = getDept(p.orgId, c.req.param("id"));
		const b = await jsonBody<{ name?: string; parentId?: string | null }>(c);
		const moving = b.parentId !== undefined && (b.parentId ?? null) !== (d.parent_id ?? null);
		if (b.parentId) {
			// Reject cycles (moving a department under itself or its own descendants).
			let cur: string | null = b.parentId;
			while (cur) {
				if (cur === d.id) throw new HttpError(400, "cycle", "部门层级不能成环");
				cur = getDept(p.orgId, cur).parent_id;
			}
		}
		if (moving) {
			// Moving needs authority over BOTH the old and the new parent (a department admin cannot pull a department out of, or into, someone else's subtree).
			needPerm(a, "dept.manage", deptScope(d.parent_id));
			needPerm(a, "dept.manage", deptScope(b.parentId));
		} else needPerm(a, "dept.manage", deptScope(d.id));
		db.run("UPDATE id_departments SET name = COALESCE(?, name), parent_id = CASE WHEN ? THEN ? ELSE parent_id END WHERE id = ?", b.name?.trim() || null, b.parentId !== undefined ? 1 : 0, b.parentId ?? null, d.id);
		audit(db, p.orgId, p.userId, moving ? "department.move" : "department.update", d.id, { ...b, from: moving ? { parentId: d.parent_id ?? null, name: d.name } : { name: d.name } }, { requestId: rid(c) });
		return c.json({ department: deptDto(getDept(p.orgId, d.id)) });
	});
	api.delete("/admin/departments/:id", async (c) => {
		const p = principalOf(c);
		const a = axOf(p);
		const d = getDept(p.orgId, c.req.param("id"));
		// Deleting a department needs authority over its parent (a department admin cannot delete the department they administer).
		needPerm(a, "dept.manage", deptScope(d.parent_id));
		const removedAssignments = db.tx(() => {
			db.run("UPDATE id_departments SET archived_at = ? WHERE id = ?", nowIso(), d.id);
			db.run("UPDATE id_departments SET parent_id = ? WHERE parent_id = ?", d.parent_id, d.id);
			return db.run("DELETE FROM id_role_assignments WHERE org_id = ? AND ((scope_kind = 'department' AND scope_id = ?) OR (subject_kind = 'department' AND subject_id = ?))", p.orgId, d.id, d.id).changes;
		});
		audit(db, p.orgId, p.userId, "department.archive", d.id, { name: d.name, removedAssignments }, { requestId: rid(c) });
		return c.json({ ok: true });
	});
	api.get("/admin/departments/:id/members", async (c) => {
		const p = principalOf(c);
		const a = axOf(p);
		const d = getDept(p.orgId, c.req.param("id"));
		needPerm(a, "member.view", deptScope(d.id));
		const rows = db.all<any>("SELECT u.id, u.name, u.email, dm.role FROM id_department_members dm JOIN id_users u ON u.id = dm.user_id JOIN id_org_members m ON m.user_id = u.id AND m.org_id = ? AND m.removed_at IS NULL WHERE dm.department_id = ? AND dm.removed_at IS NULL ORDER BY u.name", p.orgId, d.id);
		return c.json({ members: rows.map((r) => ({ userId: r.id, name: r.name, email: r.email, role: r.role })) });
	});
	api.put("/admin/departments/:id/members", async (c) => {
		const p = principalOf(c);
		const a = axOf(p);
		const d = getDept(p.orgId, c.req.param("id"));
		const b = await jsonBody<{ userId: string; role: "member" | "manager" | null }>(c);
		needPerm(a, "dept.member.manage", deptScope(d.id));
		if (!memberRow(ctx, p.orgId, b.userId ?? "")) throw new HttpError(404, "member_not_found", "组织内没有该成员");
		if (b.role === null) db.run("UPDATE id_department_members SET removed_at = ? WHERE department_id = ? AND user_id = ? AND removed_at IS NULL", nowIso(), d.id, b.userId);
		else {
			if (!["member", "manager"].includes(b.role)) throw new HttpError(400, "invalid_role", "角色无效");
			// Joining a department inherits the roles granted to it (and to its ancestors): the actor must hold all of them.
			const chain = id.authz.deptChain(a, d.id);
			for (const r of db.all<{ role_id: string; scope_kind: "org" | "department" | "project"; scope_id: string }>(`SELECT role_id, scope_kind, scope_id FROM id_role_assignments WHERE org_id = ? AND subject_kind = 'department' AND subject_id IN (${chain.map(() => "?").join(",") || "''"})`, p.orgId, ...chain))
				noEscalation(a, rolePermsOf(p.orgId, r.role_id), r.scope_kind === "org" ? undefined : { kind: r.scope_kind, id: r.scope_id });
			db.run("INSERT INTO id_department_members (department_id, user_id, created_at, role) VALUES (?, ?, ?, ?) ON CONFLICT(department_id, user_id) DO UPDATE SET role = excluded.role, removed_at = NULL", d.id, b.userId, nowIso(), b.role);
		}
		audit(db, p.orgId, p.userId, b.role === null ? "department.member.remove" : "department.member.set", d.id, { userId: b.userId, role: b.role }, { requestId: rid(c), category: "grant" });
		return c.json({ ok: true });
	});

	// ---------------------------------------------------------------- audit query
	const auditQuery = (orgId: string, q: Record<string, string | undefined>) => {
		const where = ["a.org_id = ?"];
		const params: string[] = [orgId];
		// category accepts a comma list (e.g. "grant,external_write" = all authorizations and external writes).
		if (q.category) {
			const cats = q.category.split(",").map((x) => x.trim()).filter(Boolean);
			where.push(`a.category IN (${cats.map(() => "?").join(",")})`);
			params.push(...cats);
		}
		// Correlation: any audit row whose detail mentions this conversation / effect / approval id.
		if (q.ref) (where.push("a.detail LIKE ? ESCAPE '\\'"), params.push(`%${q.ref.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`));
		for (const [k, col] of [["action", "a.action"], ["actorUserId", "a.actor_user_id"], ["target", "a.target"], ["requestId", "a.request_id"]] as const)
			if (q[k]) {
				where.push(k === "action" && q[k]!.endsWith("*") ? `${col} LIKE ?` : `${col} = ?`);
				params.push(k === "action" && q[k]!.endsWith("*") ? q[k]!.slice(0, -1) + "%" : q[k]!);
			}
		if (q.since) (where.push("a.at >= ?"), params.push(q.since));
		if (q.until) (where.push("a.at < ?"), params.push(q.until));
		if (q.before) (where.push("a.id < ?"), params.push(q.before));
		const limit = Math.min(Math.max(Number(q.limit ?? 100) || 100, 1), 1000);
		const rows = db.all<any>(`SELECT a.*, u.name AS actor_name FROM id_audit a LEFT JOIN id_users u ON u.id = a.actor_user_id WHERE ${where.join(" AND ")} ORDER BY a.id DESC LIMIT ${limit}`, ...params);
		return rows.map((r) => ({ id: r.id, at: r.at, orgId: r.org_id ?? undefined, actorUserId: r.actor_user_id ?? undefined, actorName: r.actor_name ?? undefined, action: r.action, category: r.category, target: r.target ?? undefined, detail: r.detail ? JSON.parse(r.detail) : undefined, requestId: r.request_id ?? undefined }));
	};
	api.get("/admin/audit", async (c) => {
		const p = principalOf(c);
		await id.authz.require(p, "audit.view");
		const items = auditQuery(p.orgId, c.req.query());
		return c.json({ items, next: items.length ? items[items.length - 1]!.id : undefined });
	});
	api.get("/admin/audit.csv", async (c) => {
		const p = principalOf(c);
		await id.authz.require(p, "audit.export");
		const items = auditQuery(p.orgId, { ...c.req.query(), limit: "1000" });
		audit(db, p.orgId, p.userId, "audit.export", undefined, { rows: items.length }, { requestId: rid(c) });
		c.header("content-type", "text/csv; charset=utf-8");
		c.header("content-disposition", `attachment; filename="audit-${p.orgId}.csv"`);
		return c.body(toCsv(["at", "category", "action", "actorUserId", "actorName", "target", "detail", "requestId"], items as any));
	});

	// ---------------------------------------------------------------- projects (each project = its own space)
	api.get("/projects", async (c) => {
		const p = principalOf(c);
		const rows = db.all<any>("SELECT pr.*, pm.role, s.id AS space_id FROM id_projects pr JOIN id_project_members pm ON pm.project_id = pr.id AND pm.user_id = ? AND pm.removed_at IS NULL JOIN id_spaces s ON s.project_id = pr.id WHERE pr.org_id = ? AND pr.archived_at IS NULL ORDER BY pr.created_at DESC", p.userId, p.orgId);
		return c.json({ projects: rows.map((r) => ({ id: r.id, name: r.name, description: r.description, role: r.role, spaceId: r.space_id, createdAt: r.created_at })) });
	});
	api.post("/projects", async (c) => {
		const p = principalOf(c);
		await id.authz.require(p, "project.create");
		const b = await jsonBody<{ name: string; description?: string }>(c);
		if (!b.name?.trim()) throw new HttpError(400, "invalid", "项目名称必填");
		const projectId = newId("prj");
		const spaceId = newId("sp");
		db.tx(() => {
			db.run("INSERT INTO id_projects (id, org_id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", projectId, p.orgId, b.name.trim(), b.description ?? "", p.userId, nowIso());
			db.run("INSERT INTO id_project_members (project_id, user_id, role, added_by, created_at) VALUES (?, ?, 'owner', ?, ?)", projectId, p.userId, p.userId, nowIso());
			db.run("INSERT INTO id_spaces (id, org_id, kind, project_id, created_at) VALUES (?, ?, 'project', ?, ?)", spaceId, p.orgId, projectId, nowIso());
			audit(db, p.orgId, p.userId, "project.create", projectId, undefined, { requestId: rid(c) });
		});
		return c.json({ project: { id: projectId, name: b.name.trim(), description: b.description ?? "", role: "owner", spaceId } });
	});
	api.get("/projects/:id", async (c) => {
		const p = principalOf(c);
		await id.require(p, "read", { kind: "project", id: c.req.param("id") });
		const r = db.get<any>("SELECT pr.*, s.id AS space_id FROM id_projects pr JOIN id_spaces s ON s.project_id = pr.id WHERE pr.id = ?", c.req.param("id"));
		return c.json({ project: { id: r.id, name: r.name, description: r.description, role: id.projectRole(p.userId, r.id), spaceId: r.space_id, createdAt: r.created_at } });
	});
	api.patch("/projects/:id", async (c) => {
		const p = principalOf(c);
		await id.require(p, "admin", { kind: "project", id: c.req.param("id") });
		const b = await jsonBody<{ name?: string; description?: string }>(c);
		db.run("UPDATE id_projects SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?", b.name?.trim() || null, b.description ?? null, c.req.param("id"));
		audit(db, p.orgId, p.userId, "project.update", c.req.param("id"), b, { requestId: rid(c) });
		return c.json({ ok: true });
	});
	api.delete("/projects/:id", async (c) => {
		const p = principalOf(c);
		await id.require(p, "admin", { kind: "project", id: c.req.param("id") });
		db.run("UPDATE id_projects SET archived_at = ? WHERE id = ?", nowIso(), c.req.param("id"));
		audit(db, p.orgId, p.userId, "project.archive", c.req.param("id"), undefined, { requestId: rid(c) });
		return c.json({ ok: true });
	});
	api.get("/projects/:id/members", async (c) => {
		const p = principalOf(c);
		await id.require(p, "read", { kind: "project", id: c.req.param("id") });
		const rows = db.all<any>("SELECT u.id, u.name, u.email, pm.role FROM id_project_members pm JOIN id_users u ON u.id = pm.user_id WHERE pm.project_id = ? AND pm.removed_at IS NULL", c.req.param("id"));
		return c.json({ members: rows });
	});
	api.put("/projects/:id/members", async (c) => {
		const p = principalOf(c);
		const projectId = c.req.param("id");
		await id.require(p, "admin", { kind: "project", id: projectId });
		const b = await jsonBody<{ email?: string; userId?: string; role: ProjectRole | null }>(c);
		const u = db.get<any>("SELECT u.id FROM id_users u JOIN id_org_members m ON m.user_id = u.id AND m.org_id = ? AND m.removed_at IS NULL AND m.disabled_at IS NULL WHERE (u.email = ? OR u.id = ?)", p.orgId, b.email ?? "", b.userId ?? "");
		if (!u) throw new HttpError(404, "user_not_found", "组织内没有该成员");
		if (b.role !== null && !PROJECT_ROLES.includes(b.role)) throw new HttpError(400, "invalid_role", "角色无效");
		const prev = id.projectRole(u.id, projectId);
		if (prev === "owner" && b.role !== "owner") {
			const owners = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM id_project_members WHERE project_id = ? AND role = 'owner' AND removed_at IS NULL", projectId)!.n;
			if (owners <= 1) throw new HttpError(409, "last_owner", "项目至少需要一位所有者");
		}
		let revokedShares = 0;
		db.tx(() => {
			if (b.role === null) {
				db.run("UPDATE id_project_members SET removed_at = ? WHERE project_id = ? AND user_id = ? AND removed_at IS NULL", nowIso(), projectId, u.id);
				revokedShares = id.revokeSharesCreatedBy(u.id, p.orgId, projectId, "creator_removed_from_project");
			} else db.run("INSERT INTO id_project_members (project_id, user_id, role, added_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role, removed_at = NULL", projectId, u.id, b.role, p.userId, nowIso());
			audit(db, p.orgId, p.userId, b.role === null ? "project.member.remove" : "project.member.set", projectId, { userId: u.id, from: prev, role: b.role, revokedShares }, { requestId: rid(c), category: "grant" });
		});
		return c.json({ ok: true, revokedShares });
	});

	// ---------------------------------------------------------------- share links
	api.post("/shares", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ kind: string; id: string; spaceId?: string; expiresInHours?: number }>(c);
		if (!["conversation", "file", "project", "kb", "automation"].includes(b.kind) || !b.id) throw new HttpError(400, "invalid", "资源无效");
		if (b.kind === "conversation" && !b.spaceId) throw new HttpError(400, "invalid", "会话分享需要 spaceId");
		const ref = shareResourceRef({ resource_kind: b.kind, resource_id: b.id, space_id: b.spaceId ?? null });
		await id.authz.require(p, "share.external.create");
		await id.require(p, "share", ref);
		const hours = Math.min(Math.max(b.expiresInHours ?? 168, 1), 24 * 30);
		const { row, token } = id.createShare(p, { kind: b.kind, id: b.id, spaceId: b.spaceId }, hours);
		audit(db, p.orgId, p.userId, "share.create", row.id, { resource: ref, expiresAt: row.expires_at }, { requestId: rid(c) });
		return c.json({ share: { ...shareDto(id, row), token, url: `/s/${token}` } });
	});
	api.get("/shares", async (c) => {
		const p = principalOf(c);
		const kind = c.req.query("kind");
		const rid_ = c.req.query("id");
		let rows: ShareRow[];
		if (kind && rid_) {
			const ref = shareResourceRef({ resource_kind: kind, resource_id: rid_, space_id: c.req.query("spaceId") ?? null });
			await id.require(p, "share", ref);
			rows = db.all<ShareRow>("SELECT * FROM id_share_links WHERE org_id = ? AND resource_kind = ? AND resource_id = ? ORDER BY created_at DESC", p.orgId, kind, rid_);
		} else rows = db.all<ShareRow>("SELECT * FROM id_share_links WHERE org_id = ? AND created_by = ? ORDER BY created_at DESC LIMIT 200", p.orgId, p.userId);
		return c.json({ shares: rows.map((r) => shareDto(id, r)) });
	});
	api.delete("/shares/:id", async (c) => {
		const p = principalOf(c);
		const row = db.get<ShareRow>("SELECT * FROM id_share_links WHERE id = ? AND org_id = ?", c.req.param("id"), p.orgId);
		if (!row) throw new HttpError(404, "not_found", "分享不存在");
		// Creator, anyone who may share the resource now, or an org admin may revoke.
		if (row.created_by !== p.userId && !(await id.check(p, "share", shareResourceRef(row))).allow) await id.authz.require(p, "share.external.manage");
		id.revokeShare(row.id, p.userId, "revoked");
		audit(db, p.orgId, p.userId, "share.revoke", row.id, undefined, { requestId: rid(c) });
		return c.json({ ok: true });
	});
	/** Public, unauthenticated, read-only. There is deliberately no non-GET route under /shared. */
	api.get("/shared/:token", async (c) => {
		const r = await id.resolveShare(c.req.param("token"));
		if ("error" in r) throw new HttpError(r.error === "not_found" ? 404 : 410, `share_${r.error}`, "分享链接无效、已过期或已撤销");
		const row = r.row;
		const creator = db.get<{ name: string }>("SELECT name FROM id_users WHERE id = ?", row.created_by);
		const renderer = id.shareRenderer(row.resource_kind);
		const resource = { kind: row.resource_kind, id: row.resource_id, spaceId: row.space_id ?? undefined };
		const content = renderer ? await renderer(resource, { orgId: row.org_id, createdBy: row.created_by }) : undefined;
		c.header("cache-control", "no-store");
		return c.json({ resource, permission: "read", expiresAt: row.expires_at, sharedBy: creator?.name ?? "", content });
	});

	registerOidcRoutes(api, ctx, id);
	registerRbacRoutes(api, ctx, id);
}

export type { ResourceRef };
