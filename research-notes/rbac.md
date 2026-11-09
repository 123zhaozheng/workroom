# RBAC research notes (round 4)

Goal: replace "owner / admin / member" with fine-grained, comprehensible management permissions for administrators, departments and individuals.

## What the references do (behaviour only, no code reused)
- **LambChat** (`src/kernel/schemas/permission.py`): a flat permission enum with a metadata table `{value,label,description}` grouped into named groups for the admin UI; roles are named sets of permission values. Adopted: grouped catalog with Chinese label + description, role = permission set, matrix editor.
- **DEEIX-Chat** (`application/admin/service_permission_group.go`): "permission groups" are user sets bound to model access rules (users <-> groups <-> models). Adopted: optional **user groups** (`id_groups`) as role subjects; models group can reuse `id_group_members` for model visibility (request in docs/requests/rbac.md).
- **Feishu / DingTalk admin consoles**: preset admin roles (super admin, sub-admin, auditor, billing/finance) and **sub-administrators scoped to a department subtree**; a sub-admin cannot grant what they do not hold and cannot manage people more privileged than themselves. Adopted: built-in 部门管理员 scoped to a department (+ sub-departments), 安全审计员, 计费管理员, 技能审核员; "target must not outrank actor" and "no privilege escalation" rules.
- **Keycloak**: realm roles vs client roles, **groups as a tree with role mappings that the members inherit**, composite roles. Adopted: department tree as a group hierarchy: a role granted to a department reaches its members and members of sub-departments; department-scoped assignments are inherited downward.
- **Casbin RBAC with domains** (`g(user, role, domain)`, `p(role, dom, obj, act)`): the domain is the tenant. Adopted: the domain is the org (every table is org-scoped, `Authz.load(userId, orgId)` only reads that org's rows, cross-tenant ids are 404/deny) and the *scope* (org / department / project) acts as a second, nested domain. Deny-override (`some(allow) && !some(deny)`) is Casbin's standard "priority/deny-override" effect.

## Decisions
1. **Permissions are verbs on areas** (`member.disable`, `skill.review`, `model.provider.manage`), not roles. Code checks permissions; roles are only data. `Principal.orgRole` stays for compatibility but nothing new should read it.
2. **Evaluate from the database on every call.** No cache, so revocation, disable, removal, department moves and role edits apply on the very next request (tested with the same Principal object).
3. **Deny beats allow**, except the owner rule: a live member holding 组织所有者 at org scope is allowed everything and cannot be locked out by denies; the last active owner cannot be removed/disabled/demoted.
4. **Scopes**: org ⊇ department (+ sub-departments) ; project = itself. A permission lists the scope kinds where it makes sense; an assignment at a scope kind the permission does not support contributes nothing.
5. **One base role per member** (owner/admin/member/guest, org scope) + any number of additional scoped roles. The legacy `id_org_members.role` column is kept in step by triggers, so old writers keep working and the migration is exactly "orgRole -> base assignment".
6. **No privilege escalation** everywhere a permission can be handed out (role assignment/revocation, custom role create/edit/delete, direct grants, invites, joining a department or group that carries roles): the actor must hold the permissions at that scope. Acting on a person additionally requires that the person does not outrank the actor; owners need `org.owner.manage`.
7. **Department admin = role assignment, department head = department membership flag.** Heads get view-only defaults (department stats/members); admins get management in the subtree. Moving a department needs authority over old and new parent; deleting one needs authority over its parent (an admin cannot delete the department that defines their own authority).
8. **Enforcement for other modules' admin routes** is a central policy table (`identity/policy.ts`) applied by one middleware, so ops/models/stats handlers do not hard-code roles; unlisted routes are left to their own handlers.

## Not done / honest gaps
- Project-scope assignments can only be picked from the viewer's own projects in the UI; org admins deliberately do not enter project spaces (existing privacy rule), so `project.manage` at org scope has no ACL effect, only a project-scoped assignment lets a non-member administer a project.
- 访客 is "read-only" by permission (no sandbox, export, external share, project/automation creation, uploads); writes into the guest's own personal space are still decided by the old ACL.
- Other groups' call sites still branch on `orgRole` until they apply `docs/requests/rbac.md`.
