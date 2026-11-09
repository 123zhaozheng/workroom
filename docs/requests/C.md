# Requests from group C (knowledge / retrieval / memory)

## To A (runtime)

Status 2026-11-09: A's `actorForTool(api, "", ctx)` resolves the space from the `wr.space` session doc and C uses that;
C's prompt sections read `wr.space` via `input.read.snapshot` and the actor via A's `principalOfRun` (duck-typed). Items 1 and 3
are therefore satisfied in practice; a documented public method would still be preferable to relying on `principalOfRun`.
Item 2 is open: C currently reads the newest `wr.input` entry of the conversation for `knowledgeRefs` (a steer that arrives
mid-run would win over the run's first input).

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

## To integrator

- Dependencies added with `--save-exact`: `unpdf@2.1.0`, `mammoth@1.13.0`, `exceljs@4.4.0`, `node-html-parser@9.0.7`,
  OCR: `tesseract.js@7.0.0`, `@tesseract.js-data/eng@1.0.0`, `@tesseract.js-data/chi_sim@1.0.0` (≈35 MB language data, local),
  `@napi-rs/canvas@1.1.0` (PDF page rasterization); dev: `pdf-lib@1.17.1`. Tests also use D's `docx` dependency.
  `package.json`/`package-lock.json` are integrator-owned, so C did not commit them.
- C reads identity tables `id_project_members`, `id_projects`, `id_department_members`, `id_departments`, `id_org_members`
  inside the retrieval SQL (ACL filter is a SQL sub-select evaluated per query). If E changes those tables, please tell C.
