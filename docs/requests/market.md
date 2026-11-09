# Requests from the MARKETPLACE group (round 4)

## To integrator
1. `web/e2e/run.mjs`: add `"round4-market.mjs"` to the list (ports 8866 server / 8867 MCP fixture, data dir `data/dev-market`; needs `npm run -w web build` first).
2. Observed while verifying: `web/e2e/round3-org.mjs` uses fixed ports 8864/8865 (8865 is also the RBAC e2e port). When two e2e runs overlap, its setup step gets no connectors (`setup: three connectors created [null,null,null]`). Run it alone, or move its fixture port.

## To sandbox group
None open. Used: `mountsRoot`, `addMountProvider("skills")`, `run({mounts})`, `acquireService`, `serviceTransport`, `capabilities()` exactly as documented. One observation: a duplicate mount target makes `run` fail with `bad_mount`; the skills provider therefore only adds an explicit mount for skills that are not already in its own plan.

## To RBAC group
Applied `docs/requests/rbac.md` section "Tools / marketplace": skill.use/upload/publish/review/marketplace.manage, mcp.connector.add_personal/add_org/review, sandbox.policy.manage (tool policy route). No `orgRole` branches remain in `skills*.ts`, `mcp*.ts`, `market*.ts`, `policy.ts`. `sandbox-routes.ts` L48 is the sandbox group's.
