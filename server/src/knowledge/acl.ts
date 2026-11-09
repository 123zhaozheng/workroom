// Knowledge-base access control. Everything is evaluated against CURRENT identity state on every call:
// project membership, department membership, org membership, user disabled. Nothing is cached.
//
// Read:   personal → owner only; project → any current project member (owner/editor/viewer);
//         department → current department members + KB owner/maintainers; org → every current org member.
// Write:  (add/remove docs, retry, governance) personal → owner; project → project owner/editor, or KB owner/maintainer who is
//         still a project member; department/org → KB owner/maintainers, or a holder of `kb.govern` (RBAC; department KBs:
//         held at that department's scope).
// Admin:  (rename, maintainers, delete) personal → owner; project → project owner or KB owner (still member);
//         department/org → KB owner, or a holder of `kb.govern`.
import type { AppDb } from "../core/db.ts";
import type { AuthzService, Decision, Principal, ProjectRole } from "../core/contracts.ts";
import type { KbPermissions, KbScope } from "../../../shared/knowledge.ts";

export interface KbRow {
	id: string;
	org_id: string;
	name: string;
	description: string;
	scope: KbScope;
	owner_user_id: string;
	project_id: string | null;
	department_id: string | null;
	created_by: string;
	created_at: string;
	updated_at: string;
	deleted_at: string | null;
}

const NONE: KbPermissions = { read: false, write: false, admin: false };

/** SQL sub-select of KB ids the user may READ right now. Params: [orgId, userId x5]. */
export const ACCESSIBLE_KB_SQL = `
SELECT b.id FROM kb_bases b
WHERE b.org_id = ? AND b.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM id_org_members om JOIN id_users u ON u.id = om.user_id
              WHERE om.org_id = b.org_id AND om.user_id = ?1u AND om.removed_at IS NULL AND u.disabled_at IS NULL)
  AND (
    (b.scope = 'personal' AND b.owner_user_id = ?1u)
    OR (b.scope = 'project' AND EXISTS (SELECT 1 FROM id_project_members pm JOIN id_projects pr ON pr.id = pm.project_id
                                        WHERE pm.project_id = b.project_id AND pm.user_id = ?1u AND pm.removed_at IS NULL AND pr.archived_at IS NULL))
    OR (b.scope = 'department' AND (
          b.owner_user_id = ?1u
          OR EXISTS (SELECT 1 FROM kb_maintainers m WHERE m.kb_id = b.id AND m.user_id = ?1u)
          OR EXISTS (SELECT 1 FROM id_department_members dm JOIN id_departments d ON d.id = dm.department_id
                     WHERE dm.department_id = b.department_id AND dm.user_id = ?1u AND dm.removed_at IS NULL AND d.org_id = b.org_id)))
    OR (b.scope = 'org')
  )`;

/** Expand the `?1u` placeholder into positional params: returns [sql, params]. */
export function accessibleKbQuery(orgId: string, userId: string): { sql: string; params: string[] } {
	const parts = ACCESSIBLE_KB_SQL.split("?1u");
	const params: string[] = [orgId];
	for (let i = 1; i < parts.length; i++) params.push(userId);
	return { sql: parts.join("?"), params };
}

export class KbAccess {
	readonly db: AppDb;
	readonly #authz: () => AuthzService | undefined;
	/** `authz` is looked up lazily (the identity module provides it); without it nobody holds RBAC permissions (owner/KB-level rules still apply). */
	constructor(db: AppDb, authz: () => AuthzService | undefined = () => undefined) {
		this.db = db;
		this.#authz = authz;
	}

	/** Current RBAC decision (no caching). `kb.govern` etc.; scope = org unless a department id is given. */
	can(p: Principal, permission: string, departmentId?: string | null): boolean {
		const az = this.#authz();
		if (!az) return false;
		return az.hasSync(p, permission, departmentId ? { kind: "department", id: departmentId } : { kind: "org" });
	}

	/** Current org membership + role (null when removed/disabled). */
	liveOrgRole(userId: string, orgId: string): string | null {
		const r = this.db.get<{ role: string }>("SELECT om.role FROM id_org_members om JOIN id_users u ON u.id = om.user_id WHERE om.org_id = ? AND om.user_id = ? AND om.removed_at IS NULL AND u.disabled_at IS NULL", orgId, userId);
		return r?.role ?? null;
	}
	projectRole(userId: string, projectId: string): ProjectRole | null {
		const r = this.db.get<{ role: string }>("SELECT pm.role FROM id_project_members pm JOIN id_projects p ON p.id = pm.project_id WHERE pm.project_id = ? AND pm.user_id = ? AND pm.removed_at IS NULL AND p.archived_at IS NULL", projectId, userId);
		return (r?.role as ProjectRole) ?? null;
	}
	inDepartment(userId: string, departmentId: string, orgId: string): boolean {
		return !!this.db.get("SELECT 1 FROM id_department_members dm JOIN id_departments d ON d.id = dm.department_id WHERE dm.department_id = ? AND dm.user_id = ? AND dm.removed_at IS NULL AND d.org_id = ?", departmentId, userId, orgId);
	}
	isMaintainer(kbId: string, userId: string): boolean {
		return !!this.db.get("SELECT 1 FROM kb_maintainers WHERE kb_id = ? AND user_id = ?", kbId, userId);
	}

	permissions(p: Principal, kb: KbRow | undefined): KbPermissions {
		if (!kb || kb.deleted_at || kb.org_id !== p.orgId) return NONE;
		if (!this.liveOrgRole(p.userId, p.orgId)) return NONE;
		const isOwner = kb.owner_user_id === p.userId;
		const isMaint = isOwner || this.isMaintainer(kb.id, p.userId);
		switch (kb.scope) {
			case "personal":
				return isOwner ? { read: true, write: true, admin: true } : NONE;
			case "project": {
				const role = kb.project_id ? this.projectRole(p.userId, kb.project_id) : null;
				if (!role) return NONE;
				return { read: true, write: role !== "viewer" || isMaint, admin: role === "owner" || isOwner };
			}
			case "department": {
				const member = kb.department_id ? this.inDepartment(p.userId, kb.department_id, p.orgId) : false;
				if (!member && !isMaint) return NONE;
				const governs = this.can(p, "kb.govern", kb.department_id);
				return { read: true, write: isMaint || governs, admin: isOwner || governs };
			}
			case "org": {
				const governs = this.can(p, "kb.govern");
				return { read: true, write: isMaint || governs, admin: isOwner || governs };
			}
		}
		return NONE;
	}

	decision(p: Principal, action: string, kb: KbRow | undefined): Decision {
		if (!kb || kb.deleted_at) return { allow: false, reason: "not_found" };
		if (kb.org_id !== p.orgId) return { allow: false, reason: "other_org" };
		const perms = this.permissions(p, kb);
		const need: keyof KbPermissions = action === "read" || action === "use" ? "read" : action === "write" ? "write" : "admin";
		if (perms[need]) return { allow: true, reason: `kb_${kb.scope}_${need}` };
		return { allow: false, reason: perms.read ? `kb_no_${need}` : kb.scope === "project" ? "not_member" : kb.scope === "department" ? "not_in_department" : "kb_forbidden" };
	}

	/** Why the principal can read this KB right now (for retrieval debug); undefined when it cannot. */
	basis(p: Principal, kb: KbRow): string | undefined {
		if (!this.permissions(p, kb).read) return undefined;
		switch (kb.scope) {
			case "personal":
				return "personal_owner";
			case "project":
				return `project_${this.projectRole(p.userId, kb.project_id!)}`;
			case "department":
				return kb.department_id && this.inDepartment(p.userId, kb.department_id, p.orgId) ? "department_member" : kb.owner_user_id === p.userId ? "kb_owner" : "kb_maintainer";
			case "org":
				return "org_member";
		}
	}

	accessibleKbIds(orgId: string, userId: string): string[] {
		const q = accessibleKbQuery(orgId, userId);
		return this.db.all<{ id: string }>(q.sql, ...q.params).map((r) => r.id);
	}
}
