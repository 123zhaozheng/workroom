# Requests from UI group 2 (round 5)

All optional; the UI already degrades without them.

1. **A (`server/src/runtime/handoff.ts`)** — `HandoffRun.text` still carries the raw input with `[[…]]` directives. The UI cleans it with a client-side
   twin of `stripDirectives` (`web/src/features/chat/testText.ts`). When convenient, add `displayText` / `hasTestDirectives` to `HandoffRun`
   (reuse `userDisplay()` from `server/src/runtime/dto.ts`) and the same for `QueuedInputDTO.text`.
2. **A / D / E (callers of `effects.requestApproval`)** — `ApprovalDTO` has no structured “what it touches” field. The card shows the backend
   `summary`, and picks recipient / target / path / url / count out of `detail` when present. A small optional `scope?: { label: string; value: string }[]`
   on `ApprovalRequest` / `ApprovalDTO` (filled by each tool, e.g. MCP: connector + tool + key arguments, files: file name, delegate: member) would make
   the scope line exact instead of heuristic. Also `requestedForName?: string` so the card can say who the assistant acts for.
3. **A (`fixture-model.ts`, tests only)** — the fixture’s tool-summary answer quotes raw tool output (JSON for `wr_fixture_effect`). Harmless for
   real models; if the fixture should look like a real assistant in demos, summarise instead of quoting.
4. **Integrator** — `styles.css` has no `--risk-*` tokens; the approval card uses `danger` / `warning` / `fg-muted` (token based, dark mode verified).
5. **Integrator** — `web/e2e/run.mjs`: add `"round5-g2.mjs"` to the script list (already present in the working tree, shared with G3's entry; not committed by G2 because the file is not G2's). `round5-g2.mjs` uses port 8894.
