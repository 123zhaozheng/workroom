// RBAC HTTP routes: permission catalog, roles (built-in read-only + custom), scoped role assignments, direct grants/denies,
// user groups, member access detail ("为什么" explanations) and the personal "我的权限" view.
// Every mutation is audited (category "grant"); every call is authorised against current state via the authz service.
import type { Context as HonoContext, Hono } from "hono";
import type { AppContext, AppEnv, Principal } from "../core/contracts.ts";
import { HttpError, jsonBody, newId, nowIso, principalOf } from "../core/http.ts";
import { ADMIN_CONSOLE_PERMISSIONS, BASE_ROLE_IDS, BUILTIN_ROLES, PERMISSIONS, PERMISSION_GROUPS, builtinRole, canonicalPermission, canonicalRoleId, permissionDef, type MemberAccessDTO, type PermissionScopeKind, type RoleAssignmentDTO, type RoleDTO, type ScopeRef, type UserGrantDTO } from "../../../shared/permissions.ts";
import { audit, type Identity } from "./module.ts";
import type { Access } from "./authz.ts";

const LEGACY_COLUMN: Record<string, string> = { "builtin:owner": "owner", "builtin:admin": "admin", "builtin:member": "member", "builtin:guest": "member" };

export interface ScopeIn {
	kind: PermissionScopeKind;
	id: string;
}

function parseScope(raw: unknown): ScopeIn {
	const s = (raw ?? { kind: "org" }) as { kind?: string; id?: string };
	if (s.kind !== "org" && s.kind !== "department" && s.kind !== "project") throw new HttpError(400, "invalid_scope", "范围无效（org / department / project）");
	if (s.kind !== "org" && !s.id) throw new HttpError(400, "invalid_scope", "部门或项目范围需要 id");
	return { kind: s.kind, id: s.kind === "org" ? "" : String(s.id) };
}

const scopeRef = (s: ScopeIn): ScopeRef => (s.kind === "org" ? { kind: "org" } : { kind: s.kind, id: s.id });

/** Write the member's base role (owner/admin/member/guest) as the single org-scope base assignment and keep the legacy column in step. */
export function setBaseRole(ctx: AppContext, orgId: string, userId: string, baseRoleId: string, by: string): void {
	const db = ctx.db;
	if (!BASE_ROLE_IDS.includes(baseRoleId)) throw new Error(`not a base role: ${baseRoleId}`);
	db.tx(() => {
		db.run("INSERT OR REPLACE INTO id_rbac_flags (k, v) VALUES ('sync', '1')");
		db.run(`DELETE FROM id_role_assignments WHERE org_id = ? AND subject_kind = 'user' AND subject_id = ? AND scope_kind = 'org' AND role_id IN (${BASE_ROLE_IDS.map(() => "?").join(",")})`, orgId, userId, ...BASE_ROLE_IDS);
		db.run("INSERT INTO id_role_assignments (id, org_id, subject_kind, subject_id, role_id, scope_kind, scope_id, created_by, created_at) VALUES (?, ?, 'user', ?, ?, 'org', '', ?, ?)", newId("ra"), orgId, userId, baseRoleId, by, nowIso());
		db.run("UPDATE id_org_members SET role = ? WHERE org_id = ? AND user_id = ?", LEGACY_COLUMN[baseRoleId], orgId, userId);
		db.run("DELETE FROM id_rbac_flags WHERE k = 'sync'");
	});
}

export function registerRbacRoutes(api: Hono<AppEnv>, ctx: AppContext, id: Identity): void {
	const db = ctx.db;
	const az = id.authz;
	const rid = (c: HonoContext<AppEnv>) => c.get("requestId");
	const aud = (c: HonoContext<AppEnv>, p: Principal, action: string, target: string | undefined, detail: unknown) => audit(db, p.orgId, p.userId, action, target, detail, { requestId: rid(c), category: "grant" });
	const actor = (c: HonoContext<AppEnv>): { p: Principal; a: Access } => {
		const p = principalOf(c);
		const a = az.load(p.userId, p.orgId);
		if (!a) throw new HttpError(401, "revoked", "账号已不在组织中");
		return { p, a };
	};
	const deny = (a: Access, perm: string, scope?: ScopeIn): never => {
		throw new HttpError(403, "forbidden", `缺少权限：${permissionDef(perm)?.label ?? perm}（${perm}）`, { reason: "missing_permission", permission: perm, because: az.decide(a, perm, scope as any).because });
	};
	const need = (a: Access, perm: string, scope?: ScopeIn): void => {
		if (!az.decide(a, perm, scope as any).allow) deny(a, perm, scope);
	};
	const mapReason = (reason: string): never => {
		const m: Record<string, [number, string, string]> = {
			member_not_found: [404, "member_not_found", "组织内没有该成员"],
			owner_required: [403, "owner_required", "只有所有者可以变更所有者"],
			target_outranks_actor: [403, "target_outranks", "该成员的权限高于你，无法操作"],
			outside_scope: [403, "outside_scope", "该成员不在你可管理的部门范围内"],
		};
		const [s, code, msg] = m[reason] ?? [403, "forbidden", reason];
		throw new HttpError(s, code, msg, { reason });
	};
	const validateScope = (orgId: string, s: ScopeIn): void => {
		if (s.kind === "department" && !db.get("SELECT 1 FROM id_departments WHERE id = ? AND org_id = ? AND archived_at IS NULL", s.id, orgId)) throw new HttpError(404, "department_not_found", "部门不存在");
		if (s.kind === "project" && !db.get("SELECT 1 FROM id_projects WHERE id = ? AND org_id = ? AND archived_at IS NULL", s.id, orgId)) throw new HttpError(404, "project_not_found", "项目不存在");
	};
	const scopeName = (orgId: string, s: ScopeRef): string | undefined => {
		if (s.kind === "department") return db.get<{ name: string }>("SELECT name FROM id_departments WHERE id = ? AND org_id = ?", s.id ?? "", orgId)?.name;
		if (s.kind === "project") return db.get<{ name: string }>("SELECT name FROM id_projects WHERE id = ? AND org_id = ?", s.id ?? "", orgId)?.name;
		return undefined;
	};
	const rolePerms = (orgId: string, roleId: string): string[] => {
		const perms = az.rolePermissions(orgId, roleId);
		if (!perms) throw new HttpError(404, "role_not_found", "角色不存在");
		return perms;
	};
	/** The actor may only hand out / take away permissions they hold themselves at that scope. */
	const assertNoEscalation = (a: Access, perms: readonly string[], scope: ScopeIn): void => {
		const mine = az.permissionsAt(a, scope as any);
		const missing = perms.filter((x) => !mine.has(x));
		if (missing.length) throw new HttpError(403, "privilege_escalation", `不能授予你自己没有的权限：${missing.map((x) => permissionDef(x)?.label ?? x).join("、")}`, { reason: "privilege_escalation", missing });
	};
	const memberOf = (orgId: string, userId: string) => db.get<any>("SELECT m.*, u.name, u.email, u.disabled_at AS user_disabled FROM id_org_members m JOIN id_users u ON u.id = m.user_id WHERE m.org_id = ? AND m.user_id = ? AND m.removed_at IS NULL", orgId, userId);
	const userName = (uid: string) => db.get<{ name: string }>("SELECT name FROM id_users WHERE id = ?", uid)?.name;
	const deptPath = (a: Access, deptId: string) => az.deptChain(a, deptId).reverse().map((d) => a.deptName.get(d) ?? d).join(" / ");

	// ---------------------------------------------------------------- catalog (any signed-in member)
	api.get("/permissions/catalog", (c) => {
		principalOf(c);
		return c.json({ groups: PERMISSION_GROUPS, permissions: PERMISSIONS, builtinRoles: BUILTIN_ROLES.map((r) => ({ id: r.id, key: r.key, name: r.name, description: r.description, permissions: r.permissions, scopes: r.scopes })), adminConsolePermissions: ADMIN_CONSOLE_PERMISSIONS });
	});

	// ---------------------------------------------------------------- roles
	const customRoleDto = (r: any, count: number): RoleDTO => ({ id: r.id, name: r.name, description: r.description, builtin: false, permissions: JSON.parse(r.permissions), scopes: ["org", "department", "project"], assignmentCount: count, createdAt: r.created_at, updatedAt: r.updated_at });
	const listRoles = (orgId: string): RoleDTO[] => {
		const counts = new Map(db.all<{ role_id: string; n: number }>("SELECT role_id, COUNT(*) AS n FROM id_role_assignments WHERE org_id = ? GROUP BY role_id", orgId).map((r) => [r.role_id, r.n]));
		return [
			...BUILTIN_ROLES.map((b): RoleDTO => ({ id: b.id, name: b.name, description: b.description, builtin: true, permissions: b.permissions, scopes: b.scopes, assignmentCount: counts.get(b.id) ?? 0 })),
			...db.all<any>("SELECT * FROM id_roles WHERE org_id = ? AND archived_at IS NULL ORDER BY created_at", orgId).map((r) => customRoleDto(r, counts.get(r.id) ?? 0)),
		];
	};
	const cleanPerms = (raw: unknown): string[] => {
		if (!Array.isArray(raw)) throw new HttpError(400, "invalid", "permissions 必须是权限 id 数组");
		const out = [...new Set(raw.map((x) => canonicalPermission(String(x))))];
		for (const x of out) {
			if (!permissionDef(x)) throw new HttpError(400, "unknown_permission", `未知权限：${x}`);
			if (x === "org.owner.manage") throw new HttpError(400, "reserved_permission", "「变更组织所有者」仅限内置的组织所有者角色，不能放入自定义角色");
		}
		return out;
	};
	const cleanName = (orgId: string, raw: unknown, exceptId?: string): string => {
		const name = String(raw ?? "").trim();
		if (!name || name.length > 40) throw new HttpError(400, "invalid", "角色名称必填，且不超过 40 字");
		if (BUILTIN_ROLES.some((r) => r.name === name)) throw new HttpError(409, "role_name_taken", "与内置角色重名");
		const dup = db.get<{ id: string }>("SELECT id FROM id_roles WHERE org_id = ? AND name = ? AND archived_at IS NULL", orgId, name);
		if (dup && dup.id !== exceptId) throw new HttpError(409, "role_name_taken", "已有同名自定义角色");
		return name;
	};
	api.get("/admin/roles", (c) => {
		const { p, a } = actor(c);
		if (!az.permissionsAnywhere(a).has("role.view")) deny(a, "role.view");
		return c.json({ roles: listRoles(p.orgId) });
	});
	api.post("/admin/roles", async (c) => {
		const { p, a } = actor(c);
		need(a, "role.manage");
		const b = await jsonBody<{ name: string; description?: string; permissions: string[] }>(c);
		const perms = cleanPerms(b.permissions ?? []);
		assertNoEscalation(a, perms, { kind: "org", id: "" });
		const name = cleanName(p.orgId, b.name);
		const roleId = newId("role");
		db.run("INSERT INTO id_roles (id, org_id, name, description, permissions, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", roleId, p.orgId, name, String(b.description ?? "").slice(0, 300), JSON.stringify(perms), p.userId, nowIso(), nowIso());
		aud(c, p, "role.create", roleId, { name, permissions: perms });
		return c.json({ role: listRoles(p.orgId).find((r) => r.id === roleId) });
	});
	const customRole = (orgId: string, roleId: string) => {
		if (builtinRole(roleId)) throw new HttpError(403, "builtin_role", "内置角色不可修改，请克隆后再改");
		const r = db.get<any>("SELECT * FROM id_roles WHERE id = ? AND org_id = ? AND archived_at IS NULL", roleId, orgId);
		if (!r) throw new HttpError(404, "role_not_found", "角色不存在");
		return r;
	};
	api.patch("/admin/roles/:id", async (c) => {
		const { p, a } = actor(c);
		need(a, "role.manage");
		const r = customRole(p.orgId, c.req.param("id"));
		const b = await jsonBody<{ name?: string; description?: string; permissions?: string[] }>(c);
		const before = JSON.parse(r.permissions) as string[];
		const perms = b.permissions ? cleanPerms(b.permissions) : before;
		// Only permissions that are being ADDED must be held by the editor (removing is always fine).
		assertNoEscalation(a, perms.filter((x) => !before.includes(x)), { kind: "org", id: "" });
		// Editing a role also changes everyone who holds it: refuse if it currently contains permissions the editor lacks.
		assertNoEscalation(a, before, { kind: "org", id: "" });
		const name = b.name !== undefined ? cleanName(p.orgId, b.name, r.id) : r.name;
		db.run("UPDATE id_roles SET name = ?, description = ?, permissions = ?, updated_at = ? WHERE id = ?", name, b.description !== undefined ? String(b.description).slice(0, 300) : r.description, JSON.stringify(perms), nowIso(), r.id);
		aud(c, p, "role.update", r.id, { name, added: perms.filter((x) => !before.includes(x)), removed: before.filter((x) => !perms.includes(x)) });
		return c.json({ role: listRoles(p.orgId).find((x) => x.id === r.id) });
	});
	api.post("/admin/roles/:id/clone", async (c) => {
		const { p, a } = actor(c);
		need(a, "role.manage");
		const src = c.req.param("id");
		const perms = rolePerms(p.orgId, src).filter((x) => x !== "org.owner.manage");
		assertNoEscalation(a, perms, { kind: "org", id: "" });
		const b = await jsonBody<{ name?: string }>(c).catch(() => ({}) as { name?: string });
		const baseName = b.name?.trim() || `${az.roleName(p.orgId, src) ?? "角色"} 副本`;
		let name = baseName;
		for (let i = 2; BUILTIN_ROLES.some((r) => r.name === name) || db.get("SELECT 1 FROM id_roles WHERE org_id = ? AND name = ? AND archived_at IS NULL", p.orgId, name); i++) name = `${baseName} ${i}`;
		const roleId = newId("role");
		db.run("INSERT INTO id_roles (id, org_id, name, description, permissions, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", roleId, p.orgId, name, `克隆自「${az.roleName(p.orgId, src)}」`, JSON.stringify(perms), p.userId, nowIso(), nowIso());
		aud(c, p, "role.clone", roleId, { from: src, name, permissions: perms });
		return c.json({ role: listRoles(p.orgId).find((r) => r.id === roleId) });
	});
	api.delete("/admin/roles/:id", async (c) => {
		const { p, a } = actor(c);
		need(a, "role.manage");
		const r = customRole(p.orgId, c.req.param("id"));
		assertNoEscalation(a, JSON.parse(r.permissions), { kind: "org", id: "" });
		const n = db.tx(() => {
			db.run("UPDATE id_roles SET archived_at = ? WHERE id = ?", nowIso(), r.id);
			return db.run("DELETE FROM id_role_assignments WHERE org_id = ? AND role_id = ?", p.orgId, r.id).changes;
		});
		aud(c, p, "role.delete", r.id, { name: r.name, removedAssignments: n });
		return c.json({ ok: true, removedAssignments: n });
	});

	// ---------------------------------------------------------------- assignments
	const assignmentDto = (orgId: string, r: any, a?: Access): RoleAssignmentDTO => {
		const scope: ScopeRef & { name?: string } = r.scope_kind === "org" ? { kind: "org" } : { kind: r.scope_kind, id: r.scope_id, name: scopeName(orgId, { kind: r.scope_kind, id: r.scope_id }) };
		const sname = r.subject_kind === "user" ? userName(r.subject_id) : r.subject_kind === "department" ? db.get<{ name: string }>("SELECT name FROM id_departments WHERE id = ?", r.subject_id)?.name : db.get<{ name: string }>("SELECT name FROM id_groups WHERE id = ?", r.subject_id)?.name;
		void a;
		return { id: r.id, subject: { kind: r.subject_kind, id: r.subject_id, name: sname }, roleId: r.role_id, roleName: az.roleName(orgId, r.role_id), scope, createdAt: r.created_at, createdBy: r.created_by ?? undefined };
	};
	api.get("/admin/role-assignments", (c) => {
		const { p, a } = actor(c);
		const q = c.req.query();
		const rows = db.all<any>("SELECT * FROM id_role_assignments WHERE org_id = ? ORDER BY created_at", p.orgId).filter((r) => (!q.subjectKind || r.subject_kind === q.subjectKind) && (!q.subjectId || r.subject_id === q.subjectId) && (!q.roleId || r.role_id === q.roleId) && (!q.scopeKind || r.scope_kind === q.scopeKind) && (!q.scopeId || r.scope_id === q.scopeId));
		const visible = rows.filter((r) => az.decide(a, "role.view", r.scope_kind === "org" ? undefined : { kind: r.scope_kind, id: r.scope_id }).allow || (r.scope_kind === "org" && az.permissionsAnywhere(a).has("role.view") && r.subject_kind === "user" && r.subject_id === p.userId));
		if (!visible.length && !az.permissionsAnywhere(a).has("role.view")) deny(a, "role.view");
		return c.json({ assignments: visible.map((r) => assignmentDto(p.orgId, r)) });
	});

	/** Validate that `a` may assign/revoke `roleId` to/from `subject` at `scope`; throws HttpError otherwise. */
	const checkAssign = (a: Access, orgId: string, subject: { kind: "user" | "department" | "group"; id: string }, roleId: string, scope: ScopeIn): string[] => {
		const perms = rolePerms(orgId, roleId);
		const b = builtinRole(roleId);
		validateScope(orgId, scope);
		if (b && !b.scopes.includes(scope.kind)) throw new HttpError(400, "role_scope_mismatch", `「${b.name}」不能分配在${scope.kind === "org" ? "整个组织" : scope.kind === "department" ? "部门" : "项目"}范围`);
		if (BASE_ROLE_IDS.includes(roleId) && subject.kind !== "user") throw new HttpError(400, "base_role_user_only", "基础角色只能分配给个人");
		if (roleId === "builtin:owner") need(a, "org.owner.manage");
		need(a, "role.assign", scope);
		assertNoEscalation(a, perms, scope);
		if (subject.kind === "user") {
			if (!memberOf(orgId, subject.id)) throw new HttpError(404, "member_not_found", "组织内没有该成员");
			// Department-scoped authority only reaches members inside that department's subtree.
			if (!az.decide(a, "role.assign").allow && scope.kind === "department") {
				const t = az.load(subject.id, orgId, { includeDisabled: true });
				if (!t || ![...t.userDepts.keys()].some((d) => az.deptWithin(a, d, scope.id))) throw new HttpError(403, "outside_scope", "该成员不在你可管理的部门范围内");
			}
		} else if (subject.kind === "department") {
			if (!db.get("SELECT 1 FROM id_departments WHERE id = ? AND org_id = ? AND archived_at IS NULL", subject.id, orgId)) throw new HttpError(404, "department_not_found", "部门不存在");
			if (!az.decide(a, "role.assign").allow) need(a, "role.assign", { kind: "department", id: subject.id });
		} else {
			if (!db.get("SELECT 1 FROM id_groups WHERE id = ? AND org_id = ? AND archived_at IS NULL", subject.id, orgId)) throw new HttpError(404, "group_not_found", "用户组不存在");
			need(a, "role.assign");
		}
		return perms;
	};
	api.post("/admin/role-assignments", async (c) => {
		const { p, a } = actor(c);
		const b = await jsonBody<{ subject: { kind: "user" | "department" | "group"; id: string }; roleId: string; scope?: ScopeIn }>(c);
		if (typeof b.roleId === "string") b.roleId = canonicalRoleId(b.roleId); // 旧角色 id（builtin:skill_reviewer）→ builtin:reviewer
		if (!b.subject || !["user", "department", "group"].includes(b.subject.kind) || !b.subject.id || !b.roleId) throw new HttpError(400, "invalid", "需要 subject{kind,id} 与 roleId");
		const scope = parseScope(b.scope);
		checkAssign(a, p.orgId, b.subject, b.roleId, scope);
		if (BASE_ROLE_IDS.includes(b.roleId)) {
			// Base roles replace the member's current base role (exactly one is held).
			const t = az.load(b.subject.id, p.orgId, { includeDisabled: true })!;
			const cur = t.assignments.find((x) => x.via === "direct" && x.scope_kind === "org" && BASE_ROLE_IDS.includes(x.role_id));
			const r = az.canActOnMember(a, "role.assign", b.subject.id);
			if (!r.ok) mapReason(r.reason);
			if (cur?.role_id === "builtin:owner" && b.roleId !== "builtin:owner") {
				need(a, "org.owner.manage");
				if (az.activeOwnerIds(p.orgId).filter((u) => u !== b.subject.id).length === 0) throw new HttpError(409, "last_owner", "组织至少需要一位有效的所有者");
			}
			setBaseRole(ctx, p.orgId, b.subject.id, b.roleId, p.userId);
			aud(c, p, "grant.org_role", b.subject.id, { from: cur?.role_id, to: b.roleId });
			return c.json({ ok: true, assignment: assignmentDto(p.orgId, db.get<any>("SELECT * FROM id_role_assignments WHERE org_id = ? AND subject_id = ? AND role_id = ? AND scope_kind = 'org'", p.orgId, b.subject.id, b.roleId)) });
		}
		const dup = db.get<any>("SELECT id FROM id_role_assignments WHERE org_id = ? AND subject_kind = ? AND subject_id = ? AND role_id = ? AND scope_kind = ? AND scope_id = ?", p.orgId, b.subject.kind, b.subject.id, b.roleId, scope.kind, scope.id);
		if (dup) throw new HttpError(409, "already_assigned", "已分配过该角色");
		const aid = newId("ra");
		db.run("INSERT INTO id_role_assignments (id, org_id, subject_kind, subject_id, role_id, scope_kind, scope_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", aid, p.orgId, b.subject.kind, b.subject.id, b.roleId, scope.kind, scope.id, p.userId, nowIso());
		aud(c, p, "grant.role_assign", aid, { subject: b.subject, role: b.roleId, roleName: az.roleName(p.orgId, b.roleId), scope: scopeRef(scope) });
		return c.json({ ok: true, assignment: assignmentDto(p.orgId, db.get<any>("SELECT * FROM id_role_assignments WHERE id = ?", aid)) });
	});
	api.delete("/admin/role-assignments/:id", async (c) => {
		const { p, a } = actor(c);
		const r = db.get<any>("SELECT * FROM id_role_assignments WHERE id = ? AND org_id = ?", c.req.param("id"), p.orgId);
		if (!r) throw new HttpError(404, "not_found", "授权不存在");
		if (BASE_ROLE_IDS.includes(r.role_id) && r.scope_kind === "org") throw new HttpError(400, "base_role_required", "基础角色不能单独移除，请为该成员改选另一个基础角色");
		const scope: ScopeIn = { kind: r.scope_kind, id: r.scope_id };
		need(a, "role.assign", scope);
		assertNoEscalation(a, rolePerms(p.orgId, r.role_id), scope);
		if (r.subject_kind === "user") {
			const t = az.canActOnMember(a, "role.assign", r.subject_id);
			if (!t.ok && !(t.reason === "outside_scope" && scope.kind !== "org")) mapReason(t.reason);
		}
		db.run("DELETE FROM id_role_assignments WHERE id = ?", r.id);
		aud(c, p, "grant.role_revoke", r.id, { subject: { kind: r.subject_kind, id: r.subject_id }, role: r.role_id, roleName: az.roleName(p.orgId, r.role_id), scope: scopeRef(scope) });
		return c.json({ ok: true });
	});

	// ---------------------------------------------------------------- member access view
	const grantDto = (orgId: string, g: any): UserGrantDTO => ({ id: g.id, userId: g.user_id, permission: g.permission, effect: g.effect, scope: g.scope_kind === "org" ? { kind: "org" } : { kind: g.scope_kind, id: g.scope_id, name: scopeName(orgId, { kind: g.scope_kind, id: g.scope_id }) }, reason: g.reason ?? undefined, createdAt: g.created_at, createdBy: g.created_by ?? undefined });
	const buildAccess = (orgId: string, viewer: Access, targetId: string): MemberAccessDTO => {
		const m = memberOf(orgId, targetId);
		if (!m) throw new HttpError(404, "member_not_found", "组织内没有该成员");
		const t = az.load(targetId, orgId, { includeDisabled: true })!;
		const grants = db.all<any>("SELECT * FROM id_user_grants WHERE org_id = ? AND user_id = ? ORDER BY created_at", orgId, targetId);
		const scoped = az.scopesWithGrants(t).map((sc) => {
			const orgPerms = az.permissionsAt(t);
			const here = [...az.permissionsAt(t, sc)].filter((x) => !orgPerms.has(x));
			return { scope: { kind: sc.kind, id: sc.id, name: scopeName(orgId, sc) } as ScopeRef & { name?: string }, permissions: here };
		}).filter((x) => x.permissions.length);
		const createdAt = new Map(db.all<{ id: string; created_at: string }>("SELECT id, created_at FROM id_role_assignments WHERE org_id = ?", orgId).map((r) => [r.id, r.created_at]));
		const can = (perm: string) => az.canActOnMember(viewer, perm, targetId).ok;
		return {
			userId: targetId,
			name: m.name,
			email: m.email,
			legacyRole: m.role,
			status: m.disabled_at || m.user_disabled ? "disabled" : "active",
			departments: [...t.userDepts].map(([d, role]) => ({ id: d, name: t.deptName.get(d) ?? d, role, path: deptPath(t, d) })),
			assignments: t.assignments.map((x) => ({ ...assignmentDto(orgId, { ...x, created_at: createdAt.get(x.id) ?? "", created_by: null }), via: x.via, viaName: x.viaName })),
			grants: grants.map((g) => grantDto(orgId, g)),
			effective: az.effective(t),
			scoped,
			can: {
				assign: can("role.assign") || az.decide(viewer, "role.assign").allow,
				grant: !t.isOwner && can("grant.manage"),
				disable: can("member.disable"),
				remove: can("member.remove"),
			},
		};
	};
	/** Viewing a member's access needs member.view at org level, or in a department the member belongs to; people can always see themselves. */
	const canViewMember = (a: Access, targetId: string): boolean => {
		if (a.userId === targetId) return true;
		if (az.decide(a, "member.view").allow) return true;
		const t = az.load(targetId, a.orgId, { includeDisabled: true });
		return !!t && [...t.userDepts.keys()].some((d) => az.decide(a, "member.view", { kind: "department", id: d }).allow);
	};
	api.get("/admin/members/:userId/access", (c) => {
		const { p, a } = actor(c);
		const uid = c.req.param("userId");
		if (!canViewMember(a, uid)) deny(a, "member.view");
		return c.json({ access: buildAccess(p.orgId, a, uid) });
	});
	/** Explain one decision for a member (any permission, any scope) — the "为什么" button. */
	api.get("/admin/members/:userId/explain", (c) => {
		const { p, a } = actor(c);
		const uid = c.req.param("userId");
		if (!canViewMember(a, uid)) deny(a, "member.view");
		const t = az.load(uid, p.orgId, { includeDisabled: true });
		if (!t) throw new HttpError(404, "member_not_found", "组织内没有该成员");
		const perm = canonicalPermission(c.req.query("permission") ?? "");
		if (!permissionDef(perm)) throw new HttpError(400, "unknown_permission", `未知权限：${perm}`);
		const scope = c.req.query("scopeKind") ? parseScope({ kind: c.req.query("scopeKind"), id: c.req.query("scopeId") }) : undefined;
		if (scope) validateScope(p.orgId, scope);
		return c.json({ permission: perm, scope: scope ? scopeRef(scope) : { kind: "org" }, ...az.decide(t, perm, scope as any) });
	});
	/** "我的权限": the signed-in member's own roles, grants and effective permissions. */
	api.get("/me/permissions", (c) => {
		const { p, a } = actor(c);
		const dto = buildAccess(p.orgId, a, p.userId);
		return c.json({ access: { ...dto, can: { assign: false, grant: false, disable: false, remove: false } } });
	});

	// ---------------------------------------------------------------- direct grants / denies
	api.put("/admin/members/:userId/grants", async (c) => {
		const { p, a } = actor(c);
		const uid = c.req.param("userId");
		need(a, "grant.manage");
		const b = await jsonBody<{ permission: string; effect: "allow" | "deny"; scope?: ScopeIn; reason?: string }>(c);
		if (typeof b.permission === "string") b.permission = canonicalPermission(b.permission);
		const def = permissionDef(b.permission ?? "");
		if (!def) throw new HttpError(400, "unknown_permission", `未知权限：${b.permission}`);
		if (b.effect !== "allow" && b.effect !== "deny") throw new HttpError(400, "invalid", "effect 必须是 allow 或 deny");
		const scope = parseScope(b.scope);
		if (scope.kind !== "org" && !def.scopes.includes(scope.kind)) throw new HttpError(400, "scope_not_supported", `「${def.label}」不能设在${scope.kind === "department" ? "部门" : "项目"}范围`);
		validateScope(p.orgId, scope);
		const t = az.load(uid, p.orgId, { includeDisabled: true });
		if (!t) throw new HttpError(404, "member_not_found", "组织内没有该成员");
		if (t.isOwner) throw new HttpError(400, "owner_immune", "组织所有者不受直接授权/禁止影响");
		const r = az.canActOnMember(a, "grant.manage", uid);
		if (!r.ok) mapReason(r.reason);
		if (b.effect === "allow") {
			if (b.permission === "org.owner.manage") throw new HttpError(400, "reserved_permission", "不能直接授予「变更组织所有者」");
			assertNoEscalation(a, [b.permission], scope);
		}
		const reason = b.reason ? String(b.reason).slice(0, 200) : null;
		const existing = db.get<any>("SELECT id FROM id_user_grants WHERE org_id = ? AND user_id = ? AND permission = ? AND effect = ? AND scope_kind = ? AND scope_id = ?", p.orgId, uid, b.permission, b.effect, scope.kind, scope.id);
		const gid = existing?.id ?? newId("ug");
		if (existing) db.run("UPDATE id_user_grants SET reason = ?, created_by = ?, created_at = ? WHERE id = ?", reason, p.userId, nowIso(), gid);
		else db.run("INSERT INTO id_user_grants (id, org_id, user_id, permission, effect, scope_kind, scope_id, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", gid, p.orgId, uid, b.permission, b.effect, scope.kind, scope.id, reason, p.userId, nowIso());
		aud(c, p, b.effect === "deny" ? "grant.user_deny" : "grant.user_allow", uid, { permission: b.permission, scope: scopeRef(scope), reason });
		return c.json({ ok: true, grant: grantDto(p.orgId, db.get<any>("SELECT * FROM id_user_grants WHERE id = ?", gid)) });
	});
	api.delete("/admin/members/:userId/grants/:grantId", (c) => {
		const { p, a } = actor(c);
		need(a, "grant.manage");
		const g = db.get<any>("SELECT * FROM id_user_grants WHERE id = ? AND org_id = ? AND user_id = ?", c.req.param("grantId"), p.orgId, c.req.param("userId"));
		if (!g) throw new HttpError(404, "not_found", "授权记录不存在");
		const r = az.canActOnMember(a, "grant.manage", g.user_id);
		if (!r.ok) mapReason(r.reason);
		db.run("DELETE FROM id_user_grants WHERE id = ?", g.id);
		aud(c, p, "grant.user_grant_remove", g.user_id, { permission: g.permission, effect: g.effect, scope: { kind: g.scope_kind, id: g.scope_id || undefined } });
		return c.json({ ok: true });
	});

	// ---------------------------------------------------------------- user groups (optional)
	const groupDto = (g: any) => ({ id: g.id, name: g.name, description: g.description, memberCount: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM id_group_members WHERE group_id = ? AND removed_at IS NULL", g.id)!.n, createdAt: g.created_at });
	const getGroup = (orgId: string, gid: string) => {
		const g = db.get<any>("SELECT * FROM id_groups WHERE id = ? AND org_id = ? AND archived_at IS NULL", gid, orgId);
		if (!g) throw new HttpError(404, "group_not_found", "用户组不存在");
		return g;
	};
	api.get("/admin/groups", (c) => {
		const { p, a } = actor(c);
		if (!az.permissionsAnywhere(a).has("role.view")) deny(a, "role.view");
		return c.json({ groups: db.all<any>("SELECT * FROM id_groups WHERE org_id = ? AND archived_at IS NULL ORDER BY name", p.orgId).map(groupDto) });
	});
	api.post("/admin/groups", async (c) => {
		const { p, a } = actor(c);
		need(a, "group.manage");
		const b = await jsonBody<{ name: string; description?: string }>(c);
		const name = String(b.name ?? "").trim();
		if (!name) throw new HttpError(400, "invalid", "用户组名称必填");
		if (db.get("SELECT 1 FROM id_groups WHERE org_id = ? AND name = ? AND archived_at IS NULL", p.orgId, name)) throw new HttpError(409, "group_name_taken", "已有同名用户组");
		const gid = newId("grp");
		db.run("INSERT INTO id_groups (id, org_id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", gid, p.orgId, name, String(b.description ?? "").slice(0, 200), p.userId, nowIso());
		aud(c, p, "group.create", gid, { name });
		return c.json({ group: groupDto(getGroup(p.orgId, gid)) });
	});
	api.patch("/admin/groups/:id", async (c) => {
		const { p, a } = actor(c);
		need(a, "group.manage");
		const g = getGroup(p.orgId, c.req.param("id"));
		const b = await jsonBody<{ name?: string; description?: string }>(c);
		const name = b.name !== undefined ? b.name.trim() : g.name;
		if (!name) throw new HttpError(400, "invalid", "名称必填");
		db.run("UPDATE id_groups SET name = ?, description = ? WHERE id = ?", name, b.description ?? g.description, g.id);
		aud(c, p, "group.update", g.id, { name });
		return c.json({ group: groupDto(getGroup(p.orgId, g.id)) });
	});
	api.delete("/admin/groups/:id", (c) => {
		const { p, a } = actor(c);
		need(a, "group.manage");
		const g = getGroup(p.orgId, c.req.param("id"));
		db.tx(() => {
			db.run("UPDATE id_groups SET archived_at = ? WHERE id = ?", nowIso(), g.id);
			db.run("DELETE FROM id_role_assignments WHERE org_id = ? AND subject_kind = 'group' AND subject_id = ?", p.orgId, g.id);
		});
		aud(c, p, "group.delete", g.id, { name: g.name });
		return c.json({ ok: true });
	});
	api.get("/admin/groups/:id/members", (c) => {
		const { p, a } = actor(c);
		if (!az.permissionsAnywhere(a).has("role.view")) deny(a, "role.view");
		const g = getGroup(p.orgId, c.req.param("id"));
		const rows = db.all<any>("SELECT u.id, u.name, u.email FROM id_group_members gm JOIN id_users u ON u.id = gm.user_id JOIN id_org_members m ON m.user_id = u.id AND m.org_id = ? AND m.removed_at IS NULL WHERE gm.group_id = ? AND gm.removed_at IS NULL ORDER BY u.name", p.orgId, g.id);
		return c.json({ members: rows.map((r) => ({ userId: r.id, name: r.name, email: r.email })) });
	});
	api.put("/admin/groups/:id/members", async (c) => {
		const { p, a } = actor(c);
		need(a, "group.manage");
		const g = getGroup(p.orgId, c.req.param("id"));
		const b = await jsonBody<{ userId: string; member: boolean }>(c);
		if (!memberOf(p.orgId, b.userId ?? "")) throw new HttpError(404, "member_not_found", "组织内没有该成员");
		if (b.member) {
			// Joining a group inherits its roles: the actor must hold everything those roles carry.
			for (const r of db.all<{ role_id: string; scope_kind: PermissionScopeKind; scope_id: string }>("SELECT role_id, scope_kind, scope_id FROM id_role_assignments WHERE org_id = ? AND subject_kind = 'group' AND subject_id = ?", p.orgId, g.id)) assertNoEscalation(a, rolePerms(p.orgId, r.role_id), { kind: r.scope_kind, id: r.scope_id });
			db.run("INSERT INTO id_group_members (group_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT(group_id, user_id) DO UPDATE SET removed_at = NULL", g.id, b.userId, nowIso());
		} else db.run("UPDATE id_group_members SET removed_at = ? WHERE group_id = ? AND user_id = ? AND removed_at IS NULL", nowIso(), g.id, b.userId);
		aud(c, p, "group.member.set", g.id, { userId: b.userId, member: !!b.member });
		return c.json({ ok: true });
	});

	// ---------------------------------------------------------------- department leadership overview (org structure)
	api.get("/admin/departments/overview", (c) => {
		const { p, a } = actor(c);
		const depts = db.all<any>("SELECT * FROM id_departments WHERE org_id = ? AND archived_at IS NULL ORDER BY name", p.orgId);
		const heads = db.all<any>("SELECT dm.department_id, u.id AS user_id, u.name FROM id_department_members dm JOIN id_users u ON u.id = dm.user_id JOIN id_org_members m ON m.user_id = u.id AND m.org_id = ? AND m.removed_at IS NULL WHERE dm.role = 'manager' AND dm.removed_at IS NULL", p.orgId);
		const admins = db.all<any>("SELECT ra.id, ra.scope_id, u.id AS user_id, u.name FROM id_role_assignments ra JOIN id_users u ON u.id = ra.subject_id WHERE ra.org_id = ? AND ra.role_id = 'builtin:dept_admin' AND ra.subject_kind = 'user' AND ra.scope_kind = 'department'", p.orgId);
		const counts = new Map(db.all<{ department_id: string; n: number }>("SELECT dm.department_id, COUNT(*) AS n FROM id_department_members dm JOIN id_org_members m ON m.user_id = dm.user_id AND m.org_id = ? AND m.removed_at IS NULL WHERE dm.removed_at IS NULL GROUP BY dm.department_id", p.orgId).map((r) => [r.department_id, r.n]));
		return c.json({
			departments: depts.map((d) => {
				const s = { kind: "department" as const, id: d.id };
				return {
					id: d.id,
					name: d.name,
					parentId: d.parent_id ?? undefined,
					memberCount: counts.get(d.id) ?? 0,
					heads: heads.filter((h) => h.department_id === d.id).map((h) => ({ userId: h.user_id, name: h.name })),
					admins: admins.filter((x) => x.scope_id === d.id).map((x) => ({ assignmentId: x.id, userId: x.user_id, name: x.name })),
					can: { manage: az.decide(a, "dept.manage", s).allow, members: az.decide(a, "dept.member.manage", s).allow, assign: az.decide(a, "role.assign", s).allow, view: az.decide(a, "member.view", s).allow },
				};
			}),
			canCreateRoot: az.decide(a, "dept.manage").allow,
		});
	});
}
