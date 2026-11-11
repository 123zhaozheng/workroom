# Round 7b P: wiring for the integrator

Service: `workspacePersistenceFor(ctx)` from `server/src/tools/sandbox/persist.ts` (lazy, per AppContext). Optional: `ctx.services.provide("workspacePersist", ...)`.
Helpers: `workspaceKeyOf(conversationId)` -> `"c<id>"` | `"shared"`. Failures of `commit` are returned (`result.ok === false`), never thrown (except 403/404 auth).

## server/src/tools/module.ts
```ts
import { PERSIST_MIGRATIONS, workspacePersistenceFor } from "./sandbox/persist.ts";
import { registerPersistRoutes } from "./sandbox/persist-routes.ts";
// migrations:
...PERSIST_MIGRATIONS.map((m) => ({ ...m, version: m.version + 1000 })),
// routes (any position; paths are /workspaces/... and /workspace-policy, no clash with /sandbox/*):
registerPersistRoutes(api, ctx);
// startup (after migrations, BEFORE the sandbox accepts runs / job recovery):
workspacePersistenceFor(ctx).reconcileInterruptedRuns();
// optional: honest loss window per driver
workspacePersistenceFor(ctx).lossWindowFor = async (space) => ((await sandbox.remote.forSpace(space)) ? REMOTE_LOSS_WINDOW : LOCAL_LOSS_WINDOW);
```

## server/src/tools/sandbox.ts (Sandbox.run, per run, `key = workspaceKeyOf(input.conversationId)`, `persist = workspacePersistenceFor(this.#ctx)`)
```ts
// 1. BEFORE the first this.workdir(...) of the run (workdir() mkdirs; an absent copy is the restore signal):
await persist.ensureReady(input.principal, input.space, key);      // restores a missing copy from the head; never overwrites
// 2. AFTER the run's remote sync-back / local exit, in a finally (also when the run failed or timed out):
await persist.commit(input.principal, input.space, key, "run_end").catch(() => {});
// 3. docker driver: after ensureReady restored files, run the existing ownership fix (this.#owner()) on the workdir.
```
Also `commit(..., "before_publish")` at the start of the publish path (sandbox-tools.ts `sandbox_publish` / routes publish), and `"turn_end"` from the runtime turn end:
```ts
// sandbox-tools.ts, publish tool, before reading the files:
await workspacePersistenceFor(ctx).commit(actor.principal, actor.space, workspaceKeyOf(actor.conversationId), "before_publish").catch(() => {});
// runtime turn-end hook (where a turn finishes and the actor/space/conversation are known):
await workspacePersistenceFor(ctx).commit(principal, space, workspaceKeyOf(conversationId), "turn_end").catch(() => {});
```
Periodic (optional): when `policyFor(orgId).periodicSyncSec > 0`, a running long job calls `commit(..., "periodic")` on that interval (it must hold the same principal).
If `status.state` is `failed`/`conflict` and the copy is absent after `ensureReady`, refuse the run with the status failure text (do not run on an empty /work).

## Replacement for Sandbox.reap() (sandbox.ts ~496)
The unconditional per-file sweep must go (it can delete the only copy). Replace the body; keep a thin sync wrapper if tests call `reap()` synchronously:
```ts
// start(): the hourly timer
this.#timer = setInterval(() => void workspacePersistenceFor(this.#ctx).reapWorkingCopies().catch((e) => console.error("[sandbox] reap failed", e)), 3600_000);
// reap(now) -> make it async: `async reap(now = Date.now()) { return (await workspacePersistenceFor(this.#ctx).reapWorkingCopies(now)).removed.length; }`
```
Semantics change: whole workspaces, not single files; retention comes from the org policy `workingCopyRetentionHours` (WORKROOM_SANDBOX_RETENTION_HOURS no longer drives deletion; keep it only for the "expires in" display, or read the policy there).
Existing test `server/test/tools-sandbox.test.ts:105` (`assert.equal(sb.reap(), 1)`) expects the old file-level behaviour for an unsaved file: it must be updated by the owner (an unsaved copy is now KEPT by design) or call `commit` first.

## shared/files.ts
`SandboxRunDTO.status` gains `"unknown"` (rows reconciled at startup). Web: show it as "结果未知（服务重启时仍在运行；未自动重跑）".

## Typecheck/test status of this group
`server/test/workspace-persist.test.ts`: 14 tests. The tests create the tables themselves when `PERSIST_MIGRATIONS` is not wired yet.
