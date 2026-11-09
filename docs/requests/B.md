# Requests from group B (web)

Status 2026-11-09. The web app is built against `shared/chat.ts`, `shared/files.ts`, `shared/knowledge.ts`, `shared/ops.ts`.
Missing routes are shown in the UI as “未连接” (never faked). Checked against the integrated working tree on port 8802.

## To E (org / ops)

1. **`GET /api/models` → `{ models: PlatformModelDTO[] }`** — 404 today. The home composer's model picker (`web/src/features/chat/ModelPicker.tsx`)
   and Settings → 模型 hide / show “未连接” until it exists. New conversations are created without `modelId` meanwhile (A picks the fixture model).
2. **`GET /api/stats` → `StatsDTO`** (optional `?scope=`), **`GET /api/automations` → `{ automations: AutomationDTO[] }`** — 404 today; pages show 未连接.
   Please also document the write routes (create/update/preview next runs/run now/rerun) in `docs/ops.md`; the automations page will add the editor
   (trigger, timezone, next-run preview, condition, destination) once they exist.
3. `GET /api/admin/members` works (`{ members: MemberDTO[] }`) and is rendered on 组织管理. Please list the other admin routes (invites, departments,
   sessions, audit, channels/routes, budgets) in `docs/ops.md` so the admin page can link them.

## To D (files / tools)

1. **`GET /api/skills` → `SkillListResponse`** — 404 today (能力 → 技能 shows 未连接). Connectors (`GET /api/connectors`) work and are rendered with
   status / access / blocked list. Please document the enable/disable/pin/rollback routes for skills and per-user connector enable so the page can act,
   not just display.
2. Preview works for md/text (via `/text`), images, and server-rendered Office/CSV/HTML/PDF in a sandboxed iframe. Nothing else needed.

## To A (runtime)

1. **Per-message outcome for user entries.** A user message whose run was cancelled / failed / merged has no reply entry; the transcript can only say
   “没有得到单独回复”. Please add optional `submission?: { status: SubmissionStatus; reason?: string }` to `UserEntryDTO` (or a map in
   `ConversationState`) so the UI can show “已取消 / 未应用：原因” on that exact message after reload and on other devices (M02-C, M13-C).
2. **Conversation title.** New conversations are titled with the first 40 chars of the first message (client side). A server-side title
   (e.g. summarised, or with `[[…]]` fixture directives stripped) would read better in the sidebar; not blocking.
3. SSE `error` `runtime_closed` is retried with backoff by the client; `forbidden` / `not_found` / `unauthenticated` codes are treated as final —
   please keep those code names stable.

## To C (knowledge)

1. `POST /api/kb` returns `{ kb }` — the client accepts `kb`, `knowledgeBase` or the bare object. Please confirm `{ kb: KbSummary }` in `docs/knowledge.md`.
2. Answer citations are rendered from `tool_result.details.citations: CitationDTO[]`. Please keep that path (and `n`) stable.
