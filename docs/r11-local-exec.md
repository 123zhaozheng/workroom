# Round 11 · R4 — browser (local) execution: REMOVED in round 14

History: round 11 added a `code_run` tool that ran short JavaScript / Python snippets in the person's browser (iframe + Worker, Pyodide for Python) and
upgraded to the cloud sandbox when the code needed network, packages or a long runtime. Round 12 made the cloud the default and greyed out 本地环境.

Round 14 (requirement §8.2, §11.1 item 6) removed the automatic browser execution path completely: `server/src/tools/localexec/*`, `shared/localexec.ts`,
the `?local=` event-stream parameter and `localjob` events, the `local` field of the environment DTO, `web/src/features/localexec/*`, the admin switch,
the Pyodide dependency, and the code_run part of the sandbox stats. Code now runs only through `exec` in the configured sandbox.

Kept for compatibility:
- `server/src/vfs/legacy-code-run.ts` registers a legacy-only `code_run` (listed in `LEGACY_EXTENSIONS`, never offered to new conversations). A task persisted by
  an older conversation that still calls it ends with the error result "浏览器执行已移除，这一步没有执行" and executes nothing, so it reaches a terminal state.
- Settings rows `local_exec:*` / `local_pref:*` in `tool_sandbox_settings` stay in the database unread (no destructive migration).
- The greyed-out 本地环境 row in the environment popover is static: it is reserved for a future desktop app, not for browser execution.

Tests: `server/test/r14-legacy.test.ts`.
