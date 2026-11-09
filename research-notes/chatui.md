# Chat UI (round 4) — research notes

Behaviour studied only; no code or assets copied. LambChat's name and logo are not used.

- **PigeonAgent `components/brand/SignalField.vue`** (MIT): canvas dot grid with scan rings, pointer brightening, rAF loop with IntersectionObserver, `prefers-reduced-motion` → one static frame, DPR capped at 2.
  → Workroom `DotMatrix`: same guard set (offscreen/reduced-motion/DPR), but a much calmer field (two slow waves, no rings), 30 fps throttle,
  hidden-tab pause via `visibilitychange`, theme tokens instead of colour probes, and canvases placed beside the message column instead of masking per dot
  (measured: a full-page canvas cost 23.5% main thread at 1440×900@2x in headless software rendering; two side canvases 11.6%; static 0.1%).
- **PigeonAgent `useComposerFlight.ts`**: composer "flight" from home to chat — deliberately not reproduced (motion only for state).
- **DEEIX-Chat composer/attachments**: attachment chips above the textarea, "+" menu for sources, drag overlay over the whole chat area, pasted images become attachments.
  → One `Composer` for home/project/chat; cards instead of chips (type colour, thumbnail, size, state); page-wide drop zone with overlay.
- **LambChat DESIGN.md**: readability > decoration; state not by colour alone; reduced motion honoured.
  → file state is text + icon (上传中 N% / 上传失败), colour is only an icon tint per file kind.

Decisions: XHR for upload progress (fetch has none); per-file Idempotency-Key so a retry cannot create a duplicate; text on the clipboard wins over an image
(spreadsheet copy); model switch reports what the server did instead of pretending.
