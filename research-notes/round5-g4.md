# Round 5 · UI group 4 — research and review notes

Scope: deliverable previews, workspace files, work panel, app shell/sidebar, mobile, stats polish.
Method: shallow read-only clones in `/home/user/research/{ai-elements,prompt-kit}` and one page fetch; nothing executed from them.

## 1. Research

| Source | What it is | License | Dependencies it would add | Verdict |
|---|---|---|---|---|
| vercel/ai-elements (`packages/elements/src/{artifact,web-preview,code-block,terminal,file-tree}.tsx`) | shadcn-registry components for AI apps (Next.js/React, Tailwind, `@repo/shadcn-ui`) | Apache-2.0 | shadcn-ui primitives, `lucide-react`, `shiki`, `use-stick-to-bottom`, `ai` SDK types | **Patterns adopted, no code or dependency copied.** `Artifact` = bordered card with a header (title, description, actions, close) — matches our preview header: title + one quiet line + icon actions + close, no body chrome. `FileTree` uses `role="tree"` / `role="treeitem"` + expanded state — adopted for the workspace tree (we use a button per row, a tree role on the list and `aria-expanded` on folders). `Terminal` = header + scrolling content + status — adopted as "运行记录" header with a limits popover and per-run status/exit line. `WebPreview` iframe uses a permissive sandbox (`allow-scripts allow-same-origin`) — **rejected**: our previews are rendered server-side under an opaque-origin CSP and framed with `sandbox=""`. Their components target a different stack (registry copy + `@repo/shadcn-ui`), so reuse would be a rewrite anyway. |
| ibelick/prompt-kit (`components/prompt-kit/{chat-container,message,steps,tool,...}.tsx`) | shadcn-style building blocks for chat UIs | MIT | `use-stick-to-bottom`, shiki, motion | **Pattern only.** `ChatContainer` (stick-to-bottom log with `role="log"`) confirms what the terminal log already does by hand (stick to the bottom unless the user scrolled up, 40px tolerance). Responsive message layout (single column, avatar collapses on narrow) is already the app's rule; chat is group 2's area, nothing changed here. No dependency added. |
| aidesign.guide / Agentic UX Patterns (39 patterns, updated Oct 2026; page text only) | editorial pattern catalogue with screenshots, no code | n/a (reference reading, nothing copied) | none | **Adopted as guidance.** "Canvas / artifact side-by-side with versions" → preview header carries the version switcher only when there is more than one version; "Collapsible action-log rows" → terminal run rows collapse to one line (command, status, time) and expand to code/output; "Take control of the agent's browser" already exists in the browser tab; "Context chip builds trust" → provenance is stated in one sentence on the file page ("由 对话「…」生成 · 引用 2 个文件"). |

No new dependencies. No remote scripts were run.

## 2. Issues found in the BEFORE state (screenshots: `artifacts/screenshots/round5/before/g4-*.png`)

Preview panel
- Header showed origin ("助手生成") and a version button even for single-version files; the "open in file library" link did not open a new tab; icon buttons were 28px (hard to hit on a phone); the 390 sheet's close control was a bare 16px icon.
- Error/unavailable states printed route names and group letters ("GET /api/files/:id（D 组）", "服务端尚未提供该功能的接口").
- Office/pptx previews appear blank until the iframe has loaded (no loading state); an image that fails to load showed a broken image.
- Unsupported formats: one grey line plus a link, no title.

Work panel
- Files tab: three-line paragraph of quota/retention/limits above the tree; "/work/…" paths, "空间已用 / 配额", "闲置到期"; actions as three always-visible text buttons in a cramped row (truncated path at 390); delete confirm squeezed inline into that row; the empty state said "沙箱里写出的文件".
- Terminal: "Linux 命名空间 · … · 只有 /work 可写", "隔离范围与限制" fold, exit line `[exit 0 · 122 ms · namespaces]`; the unavailable state led with "沙箱不可用" and printed Docker/namespace instructions to every user; hard-coded dark hex colours (not token based, no contrast guarantee in light mode).
- Tasks tab: "后台任务（有时间/算力预算，可取消）", "来源：对话 3 · 调用 call_…", raw user ids; "重启后重新执行/标记失败" in job cards; empty states mentioned "A 组：GET .../tasks".
- Tabs and close button small (28px), tab strip not scrollable at 390.

Files pages
- File list: subtitle paragraph, three badges per row (origin, version count, space) that wrapped badly at 390.
- File detail: "存储：已保存 2 个版本，最新 v2" + "知识：未加入任何知识库（加入是显式操作）" (verbose); provenance card with six rows including "run 36", "工具 file_revise", "输入资料 1 份（fv_0mwa3ew）" — internal ids; version list was a stack of heavy cards.

Shell
- Sidebar copy leaked implementation words ("项目接口未连接", "会话接口未连接"); "能力（技能与连接）" in the menu; 10–11px text in the notification badge and sidebar meta; icon buttons < 36px; no explicit close button in the mobile drawer; after Esc the drawer/sheet lost focus (Radix only restores focus to a `Trigger`, ours are opened by outside buttons).

Stats
- Page header paragraph and a subtitle under nearly every card (some with `docs/ops.md`, "口径见 docs/stats.md"); card headings 14px semibold vs section titles elsewhere; many 10–11px labels; block spacing `space-y-4` throughout.
- Full-page look at 390 was fine (cards stack, calendar/punch-card scroll inside their own card) — kept.

## 3. What changed (see the commit for the file list)

- New shared pieces: `features/work/states.tsx` (loading / quiet notice / error with 重试 — plain Chinese, no route names), `components/shell/InfoPop.tsx` (a "?" button opening an opaque popover; works with touch and keyboard, used for second-level explanations).
- Preview panel: clean header (name, one quiet line, version switcher only when ≥ 2 versions, download, open in new tab, close), 36px touch targets, Esc closes, per-viewer loading/error states, 390 sheet with an obvious close control, Esc / close both restore focus to the file card.
- Work panel: one panel with four tabs (all stay visible and arrow-key navigable; empty tabs show a one-line quiet state), tab strip scrolls inside itself at 390.
- Files tab: one usage line (count · used / quota) with a "?" for the cleanup rule, compact per-row menu (下载 / 发布到文件库 / 删除), delete confirmed in a dialog (cancel keeps the file), tree with `role=tree`, no "/work" or driver words.
- Terminal: token-based monospace blocks, exit status line with icon + colour ("退出码 0 · 用时 122 ms"), limits in a "?" popover in plain words; unavailable = one sentence + "请联系管理员开启" (admins get the technical detail behind 技术详情).
- Files page / detail: simple rows (type · version · size · time), timeline of versions with plain provenance "由 对话「…」生成 · 引用 N 个文件".
- Shell: sidebar wording and spacing, 36px icon buttons, no < 12px text, explicit close button in the mobile drawer, focus restore after drawer/sheet/panel close.
- Stats: heading + "?" instead of the page paragraph, card subtitles moved into "?" popovers, one heading style (`text-sm font-medium`), no text under 12px (SVG labels 12px), spacing `space-y-4 sm:space-y-6`, trimmed demo banner copy (still there), no doc paths, 模拟 labels untouched.

## 4. Left over / not done
- The Markdown table toolbar (copy / download / fullscreen) from Streamdown still shows inside md previews; it lives in `features/markdown` (group 2) — a prop to hide it in the preview would be the clean fix.
- `components/ui/overlay.tsx` `Sheet`/`Dialog` do not restore focus to an outside opener (Radix only does it for a `Trigger`); handled in the shell for drawers and panels, other callers could use the same helper.
- LibreOffice is not installed in this environment, so pptx previews are the text-outline fallback; the real slide-image render was not visually verified here.
- PDF previews rely on the browser's PDF viewer; headless Chromium does not fire `load` for it, so no loading overlay is drawn for PDFs.
