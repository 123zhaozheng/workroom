# Third-party notice: bot avatar renderer

The files in this directory (except `config.ts`, `gallery.ts` shape list wiring and the `calm` mood noted below) and
`web/src/lib/bot-avatar/{paint,clock}.ts` are vendored from **open-bot-avatar** by Dominik Scholz,
<https://github.com/DominikScholz/open-bot-avatar> (`packages/core`, version 0.2.1, commit 921907e), licensed under the MIT License.
The original license text is in [`LICENSE`](./LICENSE) and must stay with these files.

Changes made for Workroom:

- Added a `calm` mood (body still, blinking only) in `motion.ts` / `types.ts` / `render.ts`, plus `calmBlink` / `nextCalmBlink`, so that resting avatars cost almost nothing.
- Removed the DOM mount, pointer tracking and the silhouette seam checker (`seams.ts`); the DOM side lives in `web/src/lib/bot-avatar/` (own mount with a shared, idle-friendly frame loop).
- `gallery.ts` is `gallery/*.json` of the upstream repository, converted to one TypeScript module (geometry only).

Design reference only (no code taken): <https://github.com/jeremy-prt/bloub> (MIT, Copyright (c) 2026 Jérémy Perret) — the black body with two white eyes
that inspired the Workroom logo colors.
