# B — research notes (web front end)

Behavior studied only; no code or assets copied. LambChat's name, logo and avatars are not used anywhere.

## PigeonAgent (frontend/src) — MIT
- `components/chat/ThinkingChain.vue`: one collapsible header summarising the run — streaming label is the active step
  (“正在思考 / 正在生成回复 / <tool label>”), finished label “已完成 N 个步骤 · 用时 x”, failure “执行中断 · N 个步骤”.
  Opens automatically while streaming; each step expands to args/result; tool output component is async-loaded.
  → Workroom `features/chat/Steps.tsx` follows the same progressive disclosure (and auto-opens while waiting for approval).
- `PendingBatchCard.vue`: the pending confirmation lives inside the current task, not in a modal.
  → `ApprovalCard` sits right under the active turn; run bar says “等待你确认 · 请在上方卡片中处理”.
- `PreviewPanel.vue`: preview opens on the right on wide screens and as a side drawer on narrow screens.
  → `AppShell` single right panel; `Sheet` below 1024px.
- `useComposerFlight.ts`: a FLIP “flight” of the composer from home to the chat position with a dot trail.
  Deliberately **not** reproduced: the brief asks for motion only to express state; we navigate directly.

## DEEIX-Chat (apps/web) — Apache-2.0
- `features/shell/model/navigation-items.ts`: primary commands (new chat, search) separated from secondary links
  (recent, files, knowledge bases, library). → Sidebar: 新对话 / 搜索 / 个人知识库 / 文件库, then collapsible 项目 / 最近对话.
- `features/chat/components/sections/chat-empty.tsx`: empty state is just a centred greeting + the composer; small fade/translate
  transitions only. → `HomePage`: brand mark, greeting, tagline, one composer, four starter chips.
- `package.json`: React + Radix + streamdown (+ code/math/cjk/mermaid plugins) + motion + lucide + pdfjs/docx-preview as optional heavy
  deps. Confirms Streamdown + plugin split as a practical choice; we lazy-load the plugins per message content.

## LambChat (frontend, DESIGN.md, docs/frontend/ui-components.md)
- DESIGN.md priorities: readability > hierarchy > efficiency > decoration; state never by colour alone; every async view has
  loading/empty/error/disabled; reduced motion respected; avoid gradients/nested cards/decorative motion; one Markdown
  component shared by chat and file preview; prose sizes 15px desktop / 16px mobile, line-height 1.75/1.7.
  → adopted as principles in `docs/ui.md` (wr-prose sizes, `Loadable`, `EmptyState`, status icon + text, single Markdown component).

## Decisions
- Streamdown over react-markdown: stable rendering of incomplete markdown during streaming; same component for history.
- Server renders Office/CSV/HTML previews under a CSP sandbox (group D); the client frames them, so no docx-preview/pdf.js in the bundle.
- `motion` used via `LazyMotion` + `domAnimation` (smaller), only for step expansion height and approval-card entrance;
  `MotionConfig reducedMotion` follows the in-app toggle.
