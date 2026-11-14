// Fine-grained authorization service ("authz"): permission catalog + built-in/custom roles + scoped role assignments +
// per-user direct grants/denies. Always evaluated against current database state (no cache); deny beats allow; the org
// owner rule (a live member holding 组织所有者 at org scope) cannot be locked out by denies.
//
// Evaluation of (user, permission, scope T):
//   1. the user must be a live member of the org (not removed/disabled, user not disabled);
//   2. owner rule: user-level 组织所有者 assignment at org scope => allow (denies are ignored);
//   3. any direct deny whose scope contains T => deny;
//   4. allow when some role assignment (user / user group / department-and-sub-departments subject) whose scope contains T
//      has a role containing the permission, or a direct allow whose scope contains T, or an implicit default (project
//      owner on that project; department head for department stats/members);
//   5. otherwise deny.
// Scope containment: org contains everything in the org; department D contains D and its sub-departments; project P = P.
import type { AppContext, AuthzExplanation, AuthzScope, AuthzService, Principal } from "../core/contracts.ts";
import { HttpError } from "../core/http.ts";
import { BASE_ROLE_IDS, BUILTIN_ROLES, PERMISSIONS, builtinRole, canonicalPermission, permissionDef, type EffectivePermissionDTO, type PermissionScopeKind } from "../../../shared/permissions.ts";
import type { Identity } from "./module.ts";

type Effect = "allow" | "deny";
type Because = AuthzExplanation["because"][number];

interface AssignmentRow {
	id: string;
	subject_kind: "user" | "department" | "group";
	subject_id: string;
	role_id: string;
	scope_kind: PermissionScopeKind;
	scope_id: string;
}
interface GrantRow {
	id: string;
	permission: string;
	effect: Effect;
	scope_kind: PermissionScopeKind;
	scope_id: string;
	reason: string | null;
}

/** Everything needed to evaluate one user in one org, loaded fresh for each evaluation batch. */
export interface Access {
	readonly userId: string;
	readonly orgId: string;
	readonly legacyRole: string;
	readonly deptParent: ReadonlyMap<string, string | null>;
	readonly deptName: ReadonlyMap<string, string>;
	readonly userDepts: ReadonlyMap<string, "member" | "manager">;
	readonly groupNames: ReadonlyMap<string, string>;
	readonly assignments: readonly (AssignmentRow & { via: "direct" | "department" | "group"; viaName?: string })[];
	readonly grants: readonly GrantRow[];
	readonly projectRoles: ReadonlyMap<string, string>;
	readonly projectNames: ReadonlyMap<string, string>;
	readonly roles: ReadonlyMap<string, { name: string; permissions: ReadonlySet<string>; builtin: boolean }>;
	readonly isOwner: boolean;
}

export type ScopeKey = string;
export const scopeKey = (s: { kind: PermissionScopeKind; id?: string }): ScopeKey => (s.kind === "org" ? "org:" : `${s.kind}:${s.id ?? ""}`);
export const normScope = (s?: AuthzScope): { kind: PermissionScopeKind; id: string } => (!s || s.kind === "org" ? { kind: "org", id: "" } : { kind: s.kind, id: s.id });

const PROJECT_OWNER_DEFAULTS = new Set(["project.manage", "stats.project.view", "role.view", "budget.view"]);
const DEPT_HEAD_DEFAULTS = new Set(["stats.department.view", "member.view", "dept.view"]);

export class Authz implements AuthzService {
	readonly #ctx: AppContext;
	readonly #id: Identity;
	constructor(ctx: AppContext, identity: Identity) {
		this.#ctx = ctx;
		this.#id = identity;
	}
	get #db() {
		return this.#ctx.db;
	}

	// ------------------------------------------------------------------ loading
	/** Load the user's access snapshot; null when the user is not a live member of the org (or not a member at all with includeDisabled). */
	load(userId: string, orgId: string, opts: { includeDisabled?: boolean } = {}): Access | null {
		const m = opts.includeDisabled
			? this.#db.get<{ role: string }>("SELECT role FROM id_org_members WHERE org_id = ? AND user_id = ? AND removed_at IS NULL", orgId, userId)
			: this.#db.get<{ role: string }>("SELECT m.role FROM id_org_members m JOIN id_users u ON u.id = m.user_id WHERE m.org_id = ? AND m.user_id = ? AND m.removed_at IS NULL AND m.disabled_at IS NULL AND u.disabled_at IS NULL", orgId, userId);
		return m ? this.#build(userId, orgId, m.role) : null;
	}

	/** Ancestors-or-self of a department (self first). */
	deptChain(a: Pick<Access, "deptParent">, id: string): string[] {
		const out: string[] = [];
		let cur: string | null | undefined = id;
		while (cur && !out.includes(cur) && a.deptParent.has(cur)) {
			out.push(cur);
			cur = a.deptParent.get(cur);
		}
		return out;
	}

	/** Is `inner` a department inside `outer`'s subtree (or equal)? */
	deptWithin(a: Pick<Access, "deptParent">, inner: string, outer: string): boolean {
		return this.deptChain(a, inner).includes(outer);
	}

	/** Scope keys whose assignments/grants apply to a check at scope T. Null when the scope itself is invalid for this org. */
	#covering(a: Access, scope: { kind: PermissionScopeKind; id: string }): Set<ScopeKey> | null {
		const keys = new Set<ScopeKey>(["org:"]);
		if (scope.kind === "department") {
			if (!a.deptParent.has(scope.id)) return null;
			for (const d of this.deptChain(a, scope.id)) keys.add(`department:${d}`);
		} else if (scope.kind === "project") {
			if (!this.#db.get("SELECT 1 FROM id_projects WHERE id = ? AND org_id = ?", scope.id, a.orgId)) return null;
			keys.add(`project:${scope.id}`);
		}
		return keys;
	}

	scopeLabel(a: Pick<Access, "deptName" | "projectNames"> & Partial<Access>, s: { kind: PermissionScopeKind; id?: string }): string {
		if (s.kind === "org") return "整个组织";
		if (s.kind === "department") return `部门「${a.deptName.get(s.id ?? "") ?? s.id}」（含子部门）`;
		return `项目「${a.projectNames.get(s.id ?? "") ?? this.#db.get<{ name: string }>("SELECT name FROM id_projects WHERE id = ?", s.id ?? "")?.name ?? s.id}」`;
	}

	// ------------------------------------------------------------------ pure decision
	decide(a: Access, permissionIn: string, scopeIn?: AuthzScope): AuthzExplanation {
		const permission = canonicalPermission(permissionIn); // 旧权限 id（skill.review / mcp.connector.review / skill.marketplace.manage）按统一权限求值
		const def = permissionDef(permission);
		if (!def) return { allow: false, because: [{ source: "default", detail: `未知权限 ${permission}`, effect: "deny" }] };
		const scope = normScope(scopeIn);
		const covering = this.#covering(a, scope);
		if (!covering) return { allow: false, because: [{ source: "default", detail: "范围不存在或不属于本组织", effect: "deny" }] };
		if (a.isOwner) return { allow: true, because: [{ source: "owner", detail: "组织所有者：内置规则，拥有全部权限且不受「禁止」影响", effect: "allow" }] };
		const because: Because[] = [];
		let denied = false;
		for (const g of a.grants) {
			if (g.permission !== permission || g.effect !== "deny") continue;
			if (!covering.has(scopeKey({ kind: g.scope_kind, id: g.scope_id }))) continue;
			denied = true;
			because.push({ source: "user_deny", detail: `对该用户直接禁止（${this.scopeLabel(a, { kind: g.scope_kind, id: g.scope_id })}）${g.reason ? `：${g.reason}` : ""}`, effect: "deny" });
		}
		let allowed = false;
		for (const as of a.assignments) {
			const role = a.roles.get(as.role_id);
			if (!role || !role.permissions.has(permission)) continue;
			if (as.scope_kind !== "org" && !def.scopes.includes(as.scope_kind)) continue; // permission not meaningful at that scope kind
			if (!covering.has(scopeKey({ kind: as.scope_kind, id: as.scope_id }))) continue;
			allowed = true;
			const via = as.via === "department" ? `，经部门「${as.viaName}」获得` : as.via === "group" ? `，经用户组「${as.viaName}」获得` : "";
			const inherited = as.scope_kind === "department" && scope.kind === "department" && as.scope_id !== scope.id ? `（继承自上级部门「${a.deptName.get(as.scope_id) ?? as.scope_id}」）` : "";
			because.push({ source: "role", detail: `角色「${role.name}」@ ${this.scopeLabel(a, { kind: as.scope_kind, id: as.scope_id })}${via}${inherited}`, effect: "allow" });
		}
		for (const g of a.grants) {
			if (g.permission !== permission || g.effect !== "allow") continue;
			if (g.scope_kind !== "org" && !def.scopes.includes(g.scope_kind)) continue;
			if (!covering.has(scopeKey({ kind: g.scope_kind, id: g.scope_id }))) continue;
			allowed = true;
			because.push({ source: "user_grant", detail: `对该用户直接授予（${this.scopeLabel(a, { kind: g.scope_kind, id: g.scope_id })}）${g.reason ? `：${g.reason}` : ""}`, effect: "allow" });
		}
		if (scope.kind === "project" && a.projectRoles.get(scope.id) === "owner" && PROJECT_OWNER_DEFAULTS.has(permission)) {
			allowed = true;
			because.push({ source: "default", detail: "项目所有者默认拥有本项目的此项权限", effect: "allow" });
		}
		if (scope.kind === "department" && DEPT_HEAD_DEFAULTS.has(permission)) {
			for (const [d, r] of a.userDepts) {
				if (r === "manager" && this.deptWithin(a, scope.id, d)) {
					allowed = true;
					because.push({ source: "default", detail: `部门负责人（「${a.deptName.get(d)}」）默认拥有本部门的此项权限`, effect: "allow" });
					break;
				}
			}
		}
		if (denied) return { allow: false, because: because.sort((x, y) => (x.effect === y.effect ? 0 : x.effect === "deny" ? -1 : 1)) };
		if (!allowed) because.push({ source: "default", detail: "没有任何角色或直接授权包含该权限（默认拒绝）", effect: "deny" });
		return { allow: allowed, because };
	}

	/** Decision using only department/project-scoped assignments and grants (org-wide holdings and the owner rule are ignored). */
	decideScopedOnly(a: Access, permission: string, scope: AuthzScope): boolean {
		const narrowed: Access = { ...a, isOwner: false, assignments: a.assignments.filter((x) => x.scope_kind !== "org"), grants: a.grants.filter((x) => x.scope_kind !== "org") };
		return this.decide(narrowed, permission, scope).allow;
	}

	/** Every catalog permission evaluated at `scope`, with reasons. */
	effective(a: Access, scope?: AuthzScope): EffectivePermissionDTO[] {
		return PERMISSIONS.map((p) => {
			const d = this.decide(a, p.id, scope);
			return { permission: p.id, allow: d.allow, because: d.because };
		});
	}

	/** Permission ids held at `scope`. */
	permissionsAt(a: Access, scope?: AuthzScope): Set<string> {
		const out = new Set<string>();
		for (const p of PERMISSIONS) if (this.decide(a, p.id, scope).allow) out.add(p.id);
		return out;
	}

	/** Scopes (other than org) in which the user holds something: used to compute "permissions anywhere" for UI gating. */
	scopesWithGrants(a: Access): { kind: PermissionScopeKind; id: string }[] {
		const set = new Map<string, { kind: PermissionScopeKind; id: string }>();
		for (const as of a.assignments) if (as.scope_kind !== "org") set.set(`${as.scope_kind}:${as.scope_id}`, { kind: as.scope_kind, id: as.scope_id });
		for (const g of a.grants) if (g.scope_kind !== "org" && g.effect === "allow") set.set(`${g.scope_kind}:${g.scope_id}`, { kind: g.scope_kind, id: g.scope_id });
		for (const [d, r] of a.userDepts) if (r === "manager") set.set(`department:${d}`, { kind: "department", id: d });
		for (const [p, r] of a.projectRoles) if (r === "owner") set.set(`project:${p}`, { kind: "project", id: p });
		return [...set.values()];
	}

	/** Permissions the user holds at org scope or in any single department/project scope. */
	permissionsAnywhere(a: Access): Set<string> {
		const out = this.permissionsAt(a);
		for (const sc of this.scopesWithGrants(a)) for (const x of this.permissionsAt(a, sc)) out.add(x);
		return out;
	}

	// ------------------------------------------------------------------ AuthzService
	#accessFor(p: Principal): Access | null {
		const lp = this.#id.livePrincipal(p);
		if ("reason" in lp) return null;
		return this.load(p.userId, p.orgId);
	}
	async has(p: Principal, permission: string, scope?: AuthzScope): Promise<boolean> {
		const a = this.#accessFor(p);
		return !!a && this.decide(a, permission, scope).allow;
	}
	/** has() restricted to explicit department/project-scoped holdings (used where org-wide admins deliberately get no access). */
	hasScopedOnly(p: Principal, permission: string, scope: AuthzScope): boolean {
		const a = this.#accessFor(p);
		return !!a && this.decideScopedOnly(a, permission, scope);
	}
	hasSync(p: Principal, permission: string, scope?: AuthzScope): boolean {
		const a = this.#accessFor(p);
		return !!a && this.decide(a, permission, scope).allow;
	}
	async require(p: Principal, permission: string, scope?: AuthzScope): Promise<void> {
		const lp = this.#id.livePrincipal(p);
		if ("reason" in lp) throw new HttpError(401, "revoked", "登录已失效或账号已被停用");
		const a = this.load(p.userId, p.orgId);
		if (!a) throw new HttpError(401, "revoked", "账号已不在组织中");
		const d = this.decide(a, permission, scope);
		if (!d.allow) {
			const def = permissionDef(permission);
			throw new HttpError(403, "forbidden", `缺少权限：${def?.label ?? permission}（${permission}）`, { reason: "missing_permission", permission, scope: normScope(scope), because: d.because });
		}
	}
	async explain(p: Principal, permission: string, scope?: AuthzScope): Promise<AuthzExplanation> {
		const a = this.#accessFor(p);
		if (!a) return { allow: false, because: [{ source: "default", detail: "账号或会话已失效，或已不在组织中", effect: "deny" }] };
		return this.decide(a, permission, scope);
	}

	// ------------------------------------------------------------------ helpers shared with the routes
	/** Highest-privilege legacy role derived from base assignments: owner > admin > member. */
	legacyRoleOf(a: Access): "owner" | "admin" | "member" {
		const base = a.assignments.filter((x) => x.via === "direct" && x.scope_kind === "org" && BASE_ROLE_IDS.includes(x.role_id)).map((x) => x.role_id);
		return base.includes("builtin:owner") ? "owner" : base.includes("builtin:admin") ? "admin" : "member";
	}

	roleName(orgId: string, roleId: string): string | undefined {
		const b = builtinRole(roleId);
		if (b) return b.name;
		return this.#db.get<{ name: string }>("SELECT name FROM id_roles WHERE id = ? AND org_id = ? AND archived_at IS NULL", roleId, orgId)?.name;
	}

	/** Permissions of a role (built-in or custom of this org); undefined if unknown. */
	rolePermissions(orgId: string, roleId: string): string[] | undefined {
		const b = builtinRole(roleId);
		if (b) return [...b.permissions];
		const r = this.#db.get<{ permissions: string }>("SELECT permissions FROM id_roles WHERE id = ? AND org_id = ? AND archived_at IS NULL", roleId, orgId);
		if (!r) return undefined;
		try {
			return (JSON.parse(r.permissions) as unknown[]).filter((x): x is string => typeof x === "string");
		} catch {
			return [];
		}
	}

	/** Active owners of an org (live members holding 组织所有者 at org scope). */
	activeOwnerIds(orgId: string): string[] {
		return this.#db
			.all<{ subject_id: string }>(
				`SELECT ra.subject_id FROM id_role_assignments ra JOIN id_org_members m ON m.org_id = ra.org_id AND m.user_id = ra.subject_id AND m.removed_at IS NULL AND m.disabled_at IS NULL
				 JOIN id_users u ON u.id = ra.subject_id AND u.disabled_at IS NULL
				 WHERE ra.org_id = ? AND ra.role_id = 'builtin:owner' AND ra.subject_kind = 'user' AND ra.scope_kind = 'org'`,
				orgId,
			)
			.map((r) => r.subject_id);
	}

	/**
	 * May `actor` exercise `permission` over the member `targetUserId`?
	 * - holds the permission org-wide: allowed, unless the target outranks the actor (target holds permissions the actor lacks;
	 *   touching an owner additionally needs `org.owner.manage`);
	 * - otherwise (department-scoped authority): every department the target belongs to must be inside a department where the
	 *   actor holds the permission, and the target must not outrank the actor at that scope.
	 */
	canActOnMember(actor: Access, permission: string, targetUserId: string): { ok: true } | { ok: false; reason: string } {
		const target = this.load(targetUserId, actor.orgId, { includeDisabled: true });
		if (!target) return { ok: false, reason: "member_not_found" };
		const orgWide = this.decide(actor, permission).allow;
		if (target.isOwner && !this.decide(actor, "org.owner.manage").allow) return { ok: false, reason: "owner_required" };
		if (orgWide) {
			const mine = this.permissionsAt(actor);
			for (const p of this.permissionsAt(target)) if (!mine.has(p)) return { ok: false, reason: "target_outranks_actor" };
			return { ok: true };
		}
		const tDepts = [...target.userDepts.keys()];
		if (tDepts.length === 0) return { ok: false, reason: "outside_scope" };
		for (const d of tDepts) {
			if (!this.decide(actor, permission, { kind: "department", id: d }).allow) return { ok: false, reason: "outside_scope" };
			const mine = this.permissionsAt(actor, { kind: "department", id: d });
			for (const p of this.permissionsAt(target, { kind: "department", id: d })) if (!mine.has(p)) return { ok: false, reason: "target_outranks_actor" };
		}
		return { ok: true };
	}

	#build(userId: string, orgId: string, legacyRole: string): Access {
		const db = this.#db;
		const deptParent = new Map<string, string | null>();
		const deptName = new Map<string, string>();
		for (const d of db.all<{ id: string; parent_id: string | null; name: string }>("SELECT id, parent_id, name FROM id_departments WHERE org_id = ? AND archived_at IS NULL", orgId)) {
			deptParent.set(d.id, d.parent_id);
			deptName.set(d.id, d.name);
		}
		const userDepts = new Map<string, "member" | "manager">();
		for (const r of db.all<{ department_id: string; role: string }>("SELECT department_id, role FROM id_department_members WHERE user_id = ? AND removed_at IS NULL", userId)) if (deptParent.has(r.department_id)) userDepts.set(r.department_id, r.role === "manager" ? "manager" : "member");
		const groupNames = new Map<string, string>();
		for (const g of db.all<{ id: string; name: string }>("SELECT g.id, g.name FROM id_group_members gm JOIN id_groups g ON g.id = gm.group_id WHERE gm.user_id = ? AND gm.removed_at IS NULL AND g.org_id = ? AND g.archived_at IS NULL", userId, orgId)) groupNames.set(g.id, g.name);
		const deptSubjects = new Map<string, string>();
		for (const d of userDepts.keys()) for (const x of this.deptChain({ deptParent }, d)) if (!deptSubjects.has(x)) deptSubjects.set(x, d);
		const assignments: Access["assignments"][number][] = [];
		for (const a of db.all<AssignmentRow>("SELECT id, subject_kind, subject_id, role_id, scope_kind, scope_id FROM id_role_assignments WHERE org_id = ?", orgId)) {
			if (a.scope_kind === "department" && !deptParent.has(a.scope_id)) continue;
			if (a.subject_kind === "user" && a.subject_id === userId) assignments.push({ ...a, via: "direct" });
			else if (a.subject_kind === "group" && groupNames.has(a.subject_id)) assignments.push({ ...a, via: "group", viaName: groupNames.get(a.subject_id) });
			else if (a.subject_kind === "department" && deptSubjects.has(a.subject_id)) assignments.push({ ...a, via: "department", viaName: deptName.get(a.subject_id) });
		}
		const grants = db.all<GrantRow>("SELECT id, permission, effect, scope_kind, scope_id, reason FROM id_user_grants WHERE org_id = ? AND user_id = ?", orgId, userId);
		const projectRoles = new Map<string, string>();
		const projectNames = new Map<string, string>();
		for (const r of db.all<{ project_id: string; role: string; name: string }>("SELECT pm.project_id, pm.role, p.name FROM id_project_members pm JOIN id_projects p ON p.id = pm.project_id WHERE pm.user_id = ? AND pm.removed_at IS NULL AND p.org_id = ? AND p.archived_at IS NULL", userId, orgId)) {
			projectRoles.set(r.project_id, r.role);
			projectNames.set(r.project_id, r.name);
		}
		const roles = new Map<string, { name: string; permissions: ReadonlySet<string>; builtin: boolean }>();
		for (const b of BUILTIN_ROLES) roles.set(b.id, { name: b.name, permissions: new Set(b.permissions), builtin: true });
		for (const r of db.all<{ id: string; name: string; permissions: string }>("SELECT id, name, permissions FROM id_roles WHERE org_id = ? AND archived_at IS NULL", orgId)) {
			let perms: string[] = [];
			try {
				perms = JSON.parse(r.permissions);
			} catch {
				/* grants nothing */
			}
			roles.set(r.id, { name: r.name, permissions: new Set(perms.filter((x) => typeof x === "string")), builtin: false });
		}
		const isOwner = assignments.some((x) => x.role_id === "builtin:owner" && x.subject_kind === "user" && x.scope_kind === "org");
		return { userId, orgId, legacyRole, deptParent, deptName, userDepts, groupNames, assignments, grants, projectRoles, projectNames, roles, isOwner };
	}
}
