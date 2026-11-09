# Requests from group E (organization / ops)

## To A (runtime)

1. **Audit external writes and approvals (M16-C).** Call `ctx.services.get("audit").record({ orgId, actorUserId, action, target, detail, requestId })` with:
   - `effect.intent` / `effect.dispatching` / `effect.receipt` / `effect.needs_reconciliation` / `effect.reconciled` — `target: spec.target`,
     `detail: { spaceId, conversationId, taskId, callId, effectId, key, idempotencyKey }` → category `external_write`;
   - `approval.requested` / `approval.decided` — `target: approvalId`, `detail: { spaceId, conversationId, callId, approvalId, decision, risk }`,
     `requestId` = the HTTP request id of the decision → category `grant`.
   Never put secrets or payload bodies in `detail` (summaries are fine). Admins query with
   `GET /api/admin/audit?category=grant,external_write&ref=<conversationId|effectId|approvalId>`; CSV via `/api/admin/audit.csv`.
   Test `server/test/identity-audit-effects.test.ts` part 2 activates automatically once `effects.ts` calls the service.
2. **Assistant default model vs. model ACL.** `rt_assistants.model` is a raw `{provider, modelId}` ref. Please validate it
   against `ctx.services.get("models").listFor(principal)` when an assistant is created/updated *and* when a conversation is
   created from it (models can be org-scoped, department-restricted, disabled or `blocked`).
3. **Usage dirty mark on runs that end without a model request** (e.g. aborted during a tool call): optional call
   `(ctx.services.get("usage") as any).markDirty(spaceId, conversationId)` after abort/settle. Without it the ledger
   catches up on the next model request in that conversation or on `POST /api/admin/usage/rebuild`.
4. FYI (no action): E links route attempts to conversations through its own pi extension `wr.ops`
   (`GenerationTask.beforeRequest` reads `pi.provider` + your `wr.space` session doc). Please keep `wr.space`
   (`SpaceDoc` in `server/src/runtime/docs.ts`) and keep installing every module's `extensions()` (as today).
   E's automation recovery runs on its first scheduler tick, never in `start()`, because your start installs extensions.

## To B (web)

- DTOs in `shared/ops.ts` (identity admin, models/channels/routes/attempts, usage/stats, budgets, automations,
  notifications, trace). Fixture model: `PlatformModelDTO.fixture === true` and the label already carries
  “测试模型，非真实 AI”. Saved hours: render `savedHours.confirmed` and `savedHours.estimate` (always labelled
  "estimate"); both are `null` by default — show “无数据”, never a number.
- Notification links are `/c/<spaceId>/<conversationId>`; public share view path is `/s/<token>` (API `GET /api/shared/:token`).
- Login: when `POST /api/auth/login` answers 401 `totp_required`, ask for the 6-digit code and resend with `totp`.
  Enterprise login buttons: `GET /api/auth/oidc/providers` → link to `/api/auth/oidc/:id/start?returnTo=<path>`.

## To integrator

- No dependency added by E (`croner@11.0.0` was already in package.json).
- `docs/operations.md` (deployment, data volume, online backup/verify/restore CLI, migration, upgrade) is written by E as
  requested; `scripts/backup.sh` (source backup) is referenced from it.

## Resolved

- ~~C: `KnowledgePipeline` drained after `db.close()` in fast tests~~ — fixed by C (`#drain` checks `#stopped`).
