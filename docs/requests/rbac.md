# Requests from the RBAC group (round 4)

How to call authz: `const authz = ctx.services.get("authz")` (late-bound; it is provided by the identity module, so it is available from `init` of any later module and from request time everywhere).
`await authz.require(principal, "<permission id>", scope?)` / `has` / `explain`. Permission ids and Chinese labels: `shared/permissions.ts`. Scope = `{kind:"org"}` (default) | `{kind:"department", id}` (includes sub-departments) | `{kind:"project", id}`.
Built-in role -> permission sets: `docs/rbac.md`. Deny always beats allow; always evaluated against current state, so do not cache results across requests.
`Principal.orgRole` is kept for compatibility (owner/admin/member; 访客 and the other built-in roles all read as `member`) — new code must not branch on it.
Admin routes of other modules that need a permission other than `org.settings.manage` can register one line in the route policy table (`registerRoutePolicy` in `server/src/identity/policy.ts`) instead of hard-coding roles; routes not in the table are not gated by identity.

## Models group (server/src/ops/gateway.ts, models-*.ts)
1. `gateway.ts` `can(p, permission)` / `visibleTo` (`p.orgRole !== "member"`): replace with `authz.has(p, "model.manage")` (admin view of all models) and `authz.has(p, "model.use")` (use). Guests (访客) have `model.use` but nothing else.
2. Admin model routes: gate platform model CRUD/routing with `model.manage`, channel/provider create + credentials + test with `model.provider.manage`; personal providers stay member-level. `identity/policy.ts` already maps the OLD `/admin/models*` and `/admin/channels*` paths; your new paths need their own guard or one `registerRoutePolicy` line each.
3. `ops/module.ts` "model" resolver (`write`/`admin` branch): `model.manage`.

## Stats group (server/src/ops/usage.ts, stats-*.ts)
1. `usage.ts` ~L394-409 (`id.require(p, "admin", {kind:"org"})` fallbacks): org scope -> `stats.org.view`; `department:<id>` -> `stats.department.view` with `{kind:"department", id}` (dept heads and 部门管理员 hold it for their subtree); `project:<id>` -> `stats.project.view` with `{kind:"project", id}` (project owners hold it implicitly); personal -> `stats.personal.view`; ledger/CSV exports -> `stats.export` (+ `billing.export` for cost exports).
2. `acl.check(p, "admin", {kind:"org"})` now means `org.settings.manage` only; 计费管理员 / 安全审计员 are denied by it, so stats/budget code must use the permissions above.

## Ops routes file (server/src/ops/routes.ts) — owned by the others now, so as one-liners
1. `GET /budgets` `const isAdmin = p.orgRole !== "member"` -> `await authz.has(p, "budget.view")`.
2. `POST/PATCH/DELETE /admin/budgets*`: enforced via identity/policy.ts as `budget.manage` (no change needed); optionally pass `{kind:"department"|"project", id}` scope for scoped budgets.
3. Notifications: `if (b.shared) await requireOrgAdmin(...)` (shared channel create/delete) -> `authz.require(p, "org.notify.manage")`; deliveries list `p.orgRole !== "member"` and `notify.ts` retry check -> `authz.has(p, "org.notify.manage")`.
4. `ops/module.ts` "automation" resolver `p.orgRole !== "member"` -> `authz.has(p, "automation.run_as_others")`; creating automations -> `automation.create`.

## Tools / marketplace / sandbox group (server/src/tools/**)
1. `tools/skills.ts` L150-153, L194: org skill publish -> `skill.publish`; org-scope skill write/admin -> `skill.marketplace.manage` or the skill's owner; reviewing -> `skill.review`; uploading personal -> `skill.upload`; use -> `skill.use`. Department-scoped publish/review: pass `{kind:"department", id}`.
2. `tools/mcp.ts` L223-229, L250: personal connector -> `mcp.connector.add_personal`; org/system connector -> `mcp.connector.add_org`; approve/reject -> `mcp.connector.review`; `admin` resolver -> `mcp.connector.review` or owner.
3. `tools/policy.ts` L50 (tool policy edit) -> `sandbox.policy.manage`. `tools/market.ts` L143 and `tools/sandbox-routes.ts` L48 (`orgRole === owner|admin`) -> `skill.marketplace.manage` / `sandbox.policy.manage`.
4. Sandbox runtime: gate execution with `sandbox.use`, network egress with `sandbox.network`, the browser tool with `sandbox.browser`; file export tools -> `file.export`; public share link tools -> `share.external.create`.

## Runtime group (server/src/runtime/**)
1. `routes.ts` L318 `/runtime/status` and `assistants.ts` L144/L172 (`acl.require(p, "admin", {kind:"org"})` for org-scope assistants) -> `authz.require(p, "assistant.publish.org")` (status page -> `trace.view`).
2. Automation run-as-other: `submitInput` for `via.automation` whose owner != actor -> `automation.run_as_others`.

## Knowledge group (server/src/knowledge/**)
1. `service.ts` L234-238, `acl.ts` L81-83 (`orgRole === owner|admin`): create enterprise KB -> `kb.create.org`; department KB -> `kb.create.department` with department scope; publish -> `kb.publish`; manage/govern others' KBs -> `kb.govern`; personal KB -> `kb.create.personal`.

## Web (chat UI / shell owners)
1. `web/src/lib/session.tsx` L56: `isOrgAdmin` should become `permissionsAnywhere` based, e.g. `isOrgAdmin: (data?.me.permissionsAnywhere ?? []).some((p) => ADMIN_CONSOLE_PERMISSIONS.includes(p))` (import from `@shared/permissions`); `/api/me` now returns `permissions` (org scope), `permissionsAnywhere`, `baseRole`, `roles`. Sidebar already uses `isOrgAdmin` for the 组织管理 link, so no other change.
2. Hide/disable UI that needs a permission the viewer lacks using `me.permissions.includes("<id>")`; the server still enforces.
