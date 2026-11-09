# Requests from the stats group (round 4)

## To the integrator / E-ops owners (files outside the stats group's owned paths)

Two minimal, additive edits were made outside owned paths because the new routes and migration need a hook. Please keep them:

1. `server/src/ops/module.ts`: `migrations: [...OPS_MIGRATIONS, ...STATS_MIGRATIONS]` (import from `./stats-schema.ts`, versions start at 100 so they never collide with `OPS_MIGRATIONS`).
2. `server/src/ops/routes.ts`: `registerStatsRoutes(api, ctx, s)` as the last statement of `registerOpsRoutes` (import from `./stats-routes.ts`).

Also in `usage.ts` (owned): `rebuildSpace` / `reconcileSpace` now ignore `demo = 1` rows.

## To the integrator: e2e runner

`web/e2e/run.mjs` does not list `round4-stats.mjs`. It is self-contained (builds the web app into `data/dev-stats/web-dist`, own server on port 8864, data dir `data/dev-stats/e2e`), so add it to the list when convenient:
`["core-loop.mjs", ..., "round4-stats.mjs"]`.

## To RBAC (informational)

Stats permissions used, all from `shared/permissions.ts`: `stats.personal.view`, `stats.project.view` (project scope), `stats.department.view` (department scope), `stats.org.view`, `stats.export` (org scope, required to export non-personal data). Exporting one's own personal data does not require `stats.export`. If `stats.export` should also be grantable at department/project scope, widen its scope kinds in the catalog and I will pass the real scope.

## To the runtime / chat owners (informational)

Drilldown links point to `/c/:spaceId/:conversationId` and are only emitted when `identity.check(read, conversation)` allows and the conversation exists in `rt_conversations`.
