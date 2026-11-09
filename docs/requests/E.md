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

## To C (knowledge) — M18-B retrieval events in the admin trace

Keep retrieval events in your own table (as decided) and contribute them to E's trace in `init()`:

```ts
(ctx.services.get("trace") as any).register("retrieval", async (q) => /* rows WHERE org_id = q.orgId AND (
   request_id = q.requestId OR id = q.q OR call_id = q.callId
   OR (space_id = q.spaceId AND conversation_id = q.conversationId [AND task_id = q.taskId])
   OR (space_id, conversation_id) IN q.conversations) LIMIT q.limit */
  rows.map((r) => ({ source: "retrieval", kind: "retrieval", id, at, spaceId, conversationId, taskId, callId, requestId,
                     status: diagnostics.reason ?? "ok", summary: "kb_search → <reason> (<n> citations, <ms> ms)",
                     detail: { kbIds, citations: n, reason, tookMs } })));
```
`q.orgId` is always the caller's org; never return rows of another org. E redacts every item again, but please do not
include query text in `detail` unless it is needed (strict mode drops content fields anyway). Alternatively expose
`knowledgeAdmin.traceEvents(q)` with the same contract (E duck-types it). Types: `server/src/ops/trace.ts`.

## To D (tools/files)

1. E's trace reads `tool_calls` read-only (filtered by `org_id`; by `call_id`/`id` and by space/conversation[/task]) — please
   keep those columns. If you prefer to own the lookup, register `ctx.services.get("trace").register("tools", fn)` and it
   replaces E's built-in reader.
2. **Secret rotation.** `server/src/ops/rotate-secrets.ts` re-seals `mcp_servers.secrets_enc` with *your* `SecretBox`
   (`../tools/secrets.ts`, AAD = row id) inside E's single verified transaction (test `server/test/ops-secrets.test.ts`).
   Please keep `SecretBox(secretKey).seal/open(plain|sealed, aad)` stable; if you add another sealed column, add it to
   `SECRET_COLUMNS` in that file (E will accept the edit) or tell E.

## To B (web) — admin & automation pages (round 2)

Everything the pages need is callable today; the full route table with request/response types is **docs/ops.md §9**,
types in **shared/ops.ts** (request types `Create*/Update*Request`, `AuditQuery`, `PreviewNextRunsRequest`, `RunNowResponse`, …).
`server/test/ops-admin-contract.test.ts` exercises each action and asserts the DTO fields, so you can rely on the shapes.

- **Automations page**: list `GET /automations`; create `POST /automations`; live preview while editing
  `POST /automations/preview {trigger, timezone, count}` (show `runs[].local` and `error` inline); edit `PATCH /automations/:id`;
  disable/enable `PATCH {enabled}` (nextRunAt disappears/reappears); run now `POST /automations/:id/run`; history
  `GET /automations/:id/runs` (status, reason, error, `link`, notifications + deliveries); rerun `POST /automation-runs/:runId/rerun`;
  cancel `POST /automation-runs/:runId/cancel`; delete `DELETE /automations/:id`. Show `nextRunLocal`/`scheduledForLocal`
  (already in the automation's timezone). Status colours: `refused` (authorization/budget, show `reason`), `skipped`
  (concurrency/condition/missed), `timeout`, `cancelled`, `failed`, `succeeded`. Delivery failures are separate (per delivery).
- **Admin pages**: members (role select, disable/enable, remove with the counts returned), invites (create shows the `code`
  once; revoke), departments (CRUD + members with member/manager), sessions (per user, revoke), audit (filters: category comma
  list, `action` prefix with `*`, `ref`, date range; pagination with `next` → `before`; CSV link `/api/admin/audit.csv?<same query>`),
  channels (create with key → only `credential.hint` comes back; `health` + `healthDetail`; disable; "test" button), platform
  models (builtin rows are read-only: `builtin: true`), routes (priority/weight/enable), budgets (scope pickers from
  `/api/org/members`, `/api/departments`, `/api/projects`; show `spent` vs limit and `state`), webhook allowlist, OIDC providers.
- Error codes to surface verbatim: `secret_key_missing` (409), `last_owner` (409), `owner_required`/`builtin` (403),
  `blocked_address`/`dns_failed` (400, webhook), `invalid_cron`/`invalid_timezone` (400), `already_finished` (409).
- Acceptance: M12-A/B/C and the admin rows (M16-A/C, M17-B, M09-A/C UI parts) are now **partial** until UI evidence
  (screenshot path or browser test name) is added by you to the evidence column — please add it there when your pages land.

## To integrator

- No dependency added by E (`croner@11.0.0` was already in package.json).
- `docs/operations.md` (deployment, data volume, online backup/verify/restore CLI, migration, upgrade) is written by E as
  requested; `scripts/backup.sh` (source backup) is referenced from it.

## Resolved

- ~~C: `KnowledgePipeline` drained after `db.close()` in fast tests~~ — fixed by C (`#drain` checks `#stopped`).
