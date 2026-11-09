# Requests from group D (files, tools, MCP, skills, sandbox, browser)

## To integrator

- Dependencies added with `--save-exact` (package.json / package-lock.json are integrator-owned, D did not commit them):
  `docx@9.15.3`, `pptxgenjs@4.0.1`, `pdf-lib@1.17.1` (moved from devDependencies to dependencies — D needs it at runtime),
  `@pdf-lib/fontkit@1.1.1`, `jszip@3.10.2`, `marked@18.1.3`, `@modelcontextprotocol/sdk@1.32.2`.
  D also uses C's `mammoth`, `exceljs`, `unpdf`.
- Playwright is used from the host's preinstalled copy (`/opt/node-tools/node_modules/playwright`, 1.63.0, browsers in
  `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`); it is resolved at runtime (`WORKROOM_PLAYWRIGHT_PATH` overrides). No npm dependency
  and no `playwright install` was run.
- `filesModule` (server/src/files/module.ts) and `toolsModule` (server/src/tools/module.ts) are picked up by `loadModules()`.
  `filesModule` must init before `knowledgeModule` reads the `files` service (it does today: ./files before ./knowledge).

## To A (runtime)

Status (2026-11-09): items 1 and 3 are done on A's side (`actorForToolCall`, `reinstallExtension`, every module's extensions installed);
D's e2e test `server/test/tools-e2e.test.ts` passes through the real runtime (file tools + MCP write via durable approval/effects).

1. **Install D's extensions** from `filesModule.extensions(ctx)` (`wr.files`: file_create, file_revise, file_read, file_list) and
   `toolsModule.extensions(ctx)` (`wr.mcp`, `wr.skills`, `wr.sandbox`, `wr.browser`). All tools resolve their actor through
   `runtime.actorForTool(api, spaceId, context)`; D passes `""` for spaceId when it cannot tell (A's implementation then reads its
   per-storage SpaceDoc) — please keep that behaviour, or add `actorForToolCall(api, context)` which D tries first.
2. **Do not install pi's generic `tool_search`** (`createToolSearchExtension()`): it searches *all* deferred tools in the registry,
   which includes every org's MCP tools (names/descriptions would leak across tenants). `wr.mcp` ships its own `tool_search` that
   resolves the actor and only offers tools of connectors the acting user may use and has enabled. If you need to install the
   generic one anyway, install it *before* `wr.mcp` so D's same-named tool wins.
3. `wr.mcp`'s tool list is dynamic (a getter over discovered MCP tools, read by the registry at each snapshot). When a connector's
   tools change, D calls `runtime.reinstallExtension?.(ext)` if present (please add: `harnessManager.installExtension(ext)` already
   exists) so the scheduler notices; without it the lazy getter still serves the new list on the next request preparation.
4. **Effects** (`ctx.services.get("effects")`): MCP tools whose policy is `write` call `requestApproval` then `externalEffect` with
   key `mcp:<connector>:<tool>:<callId>`. If `effects` is not provided, those calls fail closed (no external write happens).
5. **Fixture e2e**: D's e2e test drives `[[call file_create {...}]]` through `POST /conversations/:spaceId/:id/messages` (passing).
6. **Sandbox cancellation**: `sandbox_exec` kills its namespace when the tool's `context.abortSignal` fires; please keep aborting
   running tool tasks on conversation abort so a user's "stop" reaches long sandbox runs.
7. **Per-org tool visibility (future)**: the registry is process-wide, so D marks MCP tools `callers: ["model"]` (code mode scripts
   cannot call them) and filters `tool_search` by org/user. A per-org registry or per-conversation extension selection would let
   code mode call connector tools safely.

8. **Round 2 — jobs and work items in ConversationState.** Background jobs (`job_start`, M14-C) are pi tasks created with
   `{ ownership: { kind: "conversation" }, background: true }` in the conversation (pi task kind `wr.job`, installed via
   `wr.jobs` extension `tasks`). Their status is mirrored in the conversation doc `wr.jobs` (`{ jobs: { [jobId]: { status, title, kind,
   updatedAt } } }`) on every transition, so a conversation watch sees the change. Please add to `ConversationState`:
   `work?: ConversationWorkDTO` (from `shared/files.ts`) =
   `(ctx.services.get("work") as { forConversation(spaceId, conversationId): ConversationWorkDTO }).forConversation(spaceId, conversationId)`
   (jobs + interactive browser sessions), and re-emit state when `wr.jobs` changes. Until then B reads `GET /api/jobs?spaceId=&conversationId=`
   and `GET /api/work/:spaceId/:conversationId`.
9. **Abort semantics.** Background jobs are excluded from an ordinary conversation abort by design (the chat stays usable and a "stop"
   of the current answer must not kill a 30-minute job). Jobs are cancelled with `POST /api/jobs/:id/cancel` (→ `harness.abortTask`) or by
   `conversation.abort(ctx, { background: true })` if you add a "stop everything" action.

10. **Default toolset (round 2).** No change needed in the runtime: with no `settings.extensions`, every installed extension is selected,
    so a default conversation is offered `sandbox_*`, `codemode`, `browse`, `browser_open/act/close`, `job_*`, `skill_*`, `file_*` and
    `tool_search` (MCP tools stay deferred) — verified by `server/test/tools-defaults.test.ts` through your chat API. Organisation admins can
    switch groups off (`PUT /api/tools/policy`); D enforces it in a `beforeTool` hook (extension `wr.tool-policy`) that resolves the space via
    `runtime.spaceIdForTool(api)` — please keep that method working for `HookApi` (it only needs `snapshot`).
    Request: B's demo e2e runs without `[[call]]` directives, so the work panel's terminal/browser tabs stay empty. Please extend the fixture
    demo heuristic: text with 运行/计算/代码/脚本 → `sandbox_exec {language:"python", code:"print(...)"}`, text with a URL or 打开网页 →
    `browse {url}` (and `browser_open` for 浏览器), only when those tools are offered.

## To C (knowledge)

- `files.getVersion(principal, versionId)` returns `null` when the version does not exist or the principal may not read it.
- On every new version (upload, new version upload, and agent writes via the routes) D calls
  `knowledgeAdmin.fileVersionAdded(fileId, ref, principal)`; on `DELETE /files/:id` it calls `knowledgeAdmin.fileDeleted(fileId)`.
  Agent writes through `file_create`/`file_revise` also notify (via the service hook).
- `extractText(mime, name, bytes)` in `server/src/files/extract.ts` is available if useful (docx/xlsx/pptx/pdf/md/html/csv).

## To B (web)

- DTOs: `shared/files.ts`. Tool results of `file_create`/`file_revise` carry `details.artifact: FileVersionRefDTO` (file card);
  `browse` carries `details.screenshot`; `sandbox_exec` carries `details.run: { runId, spaceId }`.
- Preview: `GET /api/files/:id/versions/:vid/preview` is meant for an `<iframe src>` (HTML previews are served with a CSP
  `sandbox` header — no scripts, opaque origin). Images/PDF are passed through (use `<img>`/`<iframe>`/pdf.js). `previewKind` on each
  version tells which viewer to use; `none` → offer download only.
