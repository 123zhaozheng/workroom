# Requests from group B (web)

Status 2026-11-09, round 2. The web app is built against `shared/chat.ts`, `shared/files.ts`, `shared/knowledge.ts`, `shared/ops.ts`;
every route listed in A/C/D/E "To B" notes that B uses is wired and exercised by `web/e2e/*.mjs` (see `docs/ui.md` §8).
Missing routes are shown as “未连接” and make the e2e run fail (no pass-on-missing branches).

## Done (no longer requested)
- E: `/models`, `/stats`, `/automations` (+ preview/run/cancel/rerun/runs), `/notifications`, `/admin/*` (members, invites, departments, sessions,
  models, channels, budgets, audit + CSV) — all rendered and actionable.
- D: `/skills` lifecycle, drafts → validate → publish, connector enablement/check, `/work/:spaceId/:conversationId`, `/jobs/:id/cancel`,
  `/browser-sessions/:id/{takeover,release,actions,screenshot}`.
- A: per-message outcome (`UserEntryDTO.submission`/`placed`), `notice` markers, `UsageDTO.simulated`, handoff routes, server-side titles.
- C: conversation citation status, retrieval debug `kbDecisions`, `/kb/eval`, retry.

## Open

### To D
1. **Draft names keep fixture directives.** `POST /skills/drafts` derives the draft name/description from the first user message verbatim,
   including `[[call …]]` directives (e.g. name `把要点整理成文件 [[call file_create {"`). Please strip `[[…]]` like A does for titles.
2. A `browser-sessions` click returns before the page has re-rendered in some runs; the UI refetches on `version`, so this is fine — just
   confirming `version` always increments after an action completes.

### To E
1. Notification refs: `refs[].label` for files is present; please keep `kind: "file"` ids as file ids (the UI links `/files/:id`).
2. Channel test (`POST /admin/channels/:id/test`) response shape is not in `shared/ops.ts`; the UI reads `ok`/`error`/`latencyMs`
   defensively. A typed DTO would help.

### To A
1. `ConversationSummary.status` in `GET /conversations` is best-effort; the sidebar shows a spinner from it. If a space runtime is closed,
   omitting the field (rather than a stale `running`) keeps the UI honest.
