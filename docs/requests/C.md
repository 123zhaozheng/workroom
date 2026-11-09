# Requests from group C (knowledge / retrieval / memory)

## To A (runtime)

Status 2026-11-09 (later): the integrator added `actorForToolCall`, `inputForTool`, `spaceIdForTool`, `promptScope` to
`RuntimeService` and A implemented them. C's `extension.ts` prefers them (actor + run input for `knowledgeRefs`, prompt scope
with `principal: null` = revoked → no actor-dependent sections) and keeps the older fallbacks only for robustness.
All three items below are resolved; kept for history.

1. **Space of a running tool call.** `kb_search` / `memory_save` need the `spaceId` to call `runtime.actorForTool(api, spaceId, context)`.
   Please expose one of:
   - `RuntimeService.actorForToolCall(api, context): Promise<ToolActor>` (resolves the space itself), or
   - `RuntimeService.spaceIdForTool(api): string` (each space's Harness knows its space).
   C currently duck-types `runtime.actorForToolCall` → `runtime.spaceIdForTool` → falls back to parsing `api.env.cwd`
   (`…/orgs/<org>/spaces/<spaceId>/…`). See `server/src/knowledge/extension.ts#resolveToolActor`.
2. **Knowledge refs of the run's input.** `kb_search` must honour `InputEntryData.knowledgeRefs` of the user input that started
   the run. Please add `input?: InputEntryData` (the newest `wr.input` of the run) to `ToolActor`, or a
   `runtime.inputForTool(api, context)`. C reads `actor.input?.knowledgeRefs` when present.
3. **Prompt-section scope.** The `memory` and `knowledge_scope` system-prompt sections must know the conversation's space and the
   acting user (newest `wr.input`'s `userId`) to include only what that actor may see in that space. A `PromptInput` only has
   `conversationId`, `env`, `read`. Please expose `RuntimeService.promptScope(input: PromptInput, context): Promise<{ space: Space; principal: Principal | null } | null>`
   (principal re-resolved via `identity.principalFor`, null when revoked). C duck-types it, with the same `env.cwd` fallback
   for the space (actor then = personal-space owner; project space → project/org memories only, never private ones).
4. **Install C's extensions**: `knowledgeModule.extensions(ctx)` returns one extension `wr.knowledge` (tools `kb_search`,
   `memory_save`; sections `knowledge_scope`, `memory`). Both tools are read-only/idempotent and declared `replay: "safe"`.

## To D (files)

1. C calls `ctx.services.get("files").getVersion(principal, versionId)` to read bytes when (a) a user explicitly adds a file
   version to a KB (`POST /api/kb/:id/docs {fileId, versionId}`) — to check read access — and (b) when the ingestion job runs
   (as the adding user, re-resolved). Returning `null` or throwing `HttpError(403/404)` is treated as `source_unavailable`
   (retryable).
2. **File lifecycle notifications** (optional but needed for M06-C "update → re-index" without a manual step): when a new version
   of a file is created, call `(ctx.services.get("knowledgeAdmin") as any).fileVersionAdded(fileId, versionRef, principal)`;
   when a file is deleted, call `.fileDeleted(fileId)`. Both are exported by C now; KB docs that follow the file re-index
   (new doc version; old chunks tombstoned once the new one is ready) or are removed from retrieval immediately.

## To E (ops) — M18-B retrieval events in `/api/admin/trace`

C records one row per retrieval (HTTP search, `kb_search` tool call, eval, scope refusal) in `kb_retrieval_events` and logs a
`kb.search` line through your `logEvent` (fields: `eventId, requestId, spaceId, conversationId, taskId, callId, orgId, userId,
source, queryHash, queryLen, kbIds, forbiddenKbIds, hits, reason, strategy, cached, latencyMs` — never the query text).
Please merge the events into the trace response (one line, no schema work on your side):

```ts
retrieval: ctx.services.has("knowledgeAdmin") ? (ctx.services.get("knowledgeAdmin") as any).retrievalEvents(p.orgId, q) : [],
```

`retrievalEvents(orgId, q)` matches `q` against event id, `requestId`, `"<spaceId>:<conversationId>"`, `callId` or `queryHash`,
org-scoped, ≤200 rows, returns `RetrievalEventDTO[]` (`shared/knowledge.ts`). The stored query is redacted with your
`redactText` per `WORKROOM_REDACT` (strict → not stored, only hash + length). Until you merge it, admins can use
`GET /api/kb/admin/retrieval-events?q=` (org owner/admin only). Retention: `WORKROOM_KB_EVENT_RETENTION_DAYS` (default 30), pruned on start.

## To integrator

- Dependencies added with `--save-exact`: `unpdf@2.1.0`, `mammoth@1.13.0`, `exceljs@4.4.0`, `node-html-parser@9.0.7`,
  OCR: `tesseract.js@7.0.0`, `@tesseract.js-data/eng@1.0.0`, `@tesseract.js-data/chi_sim@1.0.0` (≈35 MB language data, local),
  `@napi-rs/canvas@1.1.0` (PDF page rasterization); dev: `pdf-lib@1.17.1`. Tests also use D's `docx` dependency.
  `package.json`/`package-lock.json` are integrator-owned, so C did not commit them.
- C reads identity tables `id_project_members`, `id_projects`, `id_department_members`, `id_departments`, `id_org_members`
  inside the retrieval SQL (ACL filter is a SQL sub-select evaluated per query). If E changes those tables, please tell C.
