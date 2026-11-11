# Round 11 · R4 — local (in-browser) execution, unified with the cloud sandbox

One tool, `code_run`, runs a short JavaScript or Python snippet. The platform decides where: in the person's browser (isolated, no network) or in the
cloud sandbox, and the result says which one ran and why. `sandbox_exec` is unchanged (shell, packages, network, services, long jobs = cloud only).

## Architecture

```
model ── code_run ──▶ LocalExec.run (server/src/tools/localexec/service.ts)
                         │ decideBackend (route.ts, pure)
        ┌────────────────┴─────────────────────────────┐
   browser                                          cloud
   LocalExecBroker.dispatch (broker.ts)             hidden file  .wr-run/<id>.mjs|.py  in the HOST workspace
     └ SSE event `localjob` on the conversation       └ Sandbox.run  (language node/python, 2-line launcher)
       stream (?local=<tabId> = presence)               = the ordinary exec path: configured driver/provider,
   tab: POST …/claim (first wins) → GET …/input         lifecycle, prewarm, workspace sync both ways
        → run in sandboxed iframe + Worker           temp file removed afterwards
        → POST …/result (+ output files, base64)
   server: files written with Sandbox.writeFile (path + quota checks) into the HOST workspace
```

* The host workspace is authoritative (file tools already work on it; a remote sandbox is synced from it on acquire). Output files of a browser run
  therefore reach the cloud sandbox automatically on the next upgrade ("migration" needs no extra step). Inputs are read from the host workspace and
  handed to the tab per job (only the paths the call declared).
* **Same contract on both sides.** JavaScript = the body of an async function with `files.read(path[, "bytes"])`, `files.write(path, text|bytes)`,
  `files.list()`, `console`, `return <json-able value>`; the cloud wrapper (`jsWrapper` in service.ts) implements the same API on `node:fs` and also passes
  `require`. Python = a normal script reading/writing files in the working directory (Pyodide mounts the inputs at `/work` and the files that are new or
  changed afterwards become output files). Note: top-level `await` works in Pyodide but is not valid CPython — do not rely on it.
* Presence: a tab that opens the conversation stream with `?local=<tabId>` (only when the browser can host the runtime) is a runner. Jobs are announced
  as SSE events `localjob` / `localjob-cancel` on that same stream (`runtime/routes.ts`, 4-line hook; `useConversation.ts`, 2 listeners).
* Automatic upgrade: a browser run that fails for a capacity reason — `timeout` (hard timeout), `oom`, `unsupported` (Node-only API, a Python package
  Pyodide does not ship, the runtime could not start), `tab_lost` (claiming tab gone > 6 s), `unclaimed` (nobody claimed within 3 s) — is retried **once**
  in the cloud with a note in the result. The code's own errors (exceptions) are reported as they are, not retried. No output files are kept from a
  failed browser run, so the retry is idempotent. A cloud failure is a visible error; there is never a fallback to the Workroom host.
* Stop button: the tool's abort signal cancels the broker job → `localjob-cancel` → the tab removes the iframe (kills the worker).

## Routing rules (`route.ts`, first match wins)

1. `backend: "cloud"` argument → cloud (`forced_cloud`)  2. admin switch off → cloud (`disabled`)  3. conversation preference "cloud" → cloud (`pref_cloud`)
4. language not supported by the browser build → cloud (`language`)  5. static scan hits network (`fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
`sendBeacon`, `importScripts`, dynamic `import(`, `requests`, `urllib`, `socket`, `http`…), subprocess (`child_process`, `spawn`, `subprocess`, `os.system`…),
package install (`npm i`, `pip install`, `micropip`…) or Node-only API (`require(`, `process.env`, `Buffer.`, `__dirname`) → cloud  6. inputs > 20 MB → cloud
7. timeout > 30 s → cloud  8. no tab of the SAME user connected to this conversation → cloud (`no_tab`)  9. otherwise browser.

The scan is a routing hint, conservative (a false positive only costs a cloud run) and NOT the security boundary: the browser runtime blocks the network
whatever the code does (below). Defaults: org switch on, preference "local". Timeout default 20 s, max 300 s (cloud).

## Security model of the browser runtime (`web/src/features/localexec/runtime/`)

* User code runs ONLY in a Worker created by a hidden `<iframe sandbox="allow-scripts">` — **no `allow-same-origin`** → opaque origin ("null"): no
  cookies, storage, or DOM/API access to the Workroom page.
* The iframe document carries `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:` (Python frame
  adds `blob:` to `script-src` so the worker can import the Pyodide modules it was handed). `default-src 'none'` ⇒ `connect-src 'none'`: fetch, XHR,
  WebSocket, EventSource, beacons, importScripts of URLs, images, frames all blocked. The worker inherits the policy.
* WebRTC (not governed by `connect-src`) is deleted from the worker global before user code runs. `postMessage` of the worker is captured and removed
  from the global; its messages carry a token user code cannot read.
* Parent ⇄ iframe: `postMessage` only; the parent accepts messages only from `iframe.contentWindow` with origin `"null"` and the per-run nonce; the
  iframe accepts only the parent. Hard timeout: the parent removes the iframe (kills the worker) when `timeoutSec` has passed since the code started
  (Python: after the runtime booted, boot limit 45 s). Output caps: 1 M characters of stdout/stderr, 50 files, 20 MB.
* Server: claims/inputs/results require the run's own user (other users get 404, indistinguishable from "no such job"), space write access and
  `sandbox.use`, a tab that holds an open stream with that conversation, and (for inputs/result) the claiming tab; the job exposes only its declared
  inputs. Output files go through `Sandbox.writeFile` (clean path, no `..`, symlink-escape checks, per-file 64 MB limit and the workspace quota); a
  refused file is reported per file and makes the run an error. The session cookie stays httpOnly SameSite=Lax; nothing the iframe does can use it.
* Python (Pyodide 314.0.7 from the npm package `pyodide`, copied into the build as hashed assets of OUR origin, fetched lazily; **no CDN**). The parent
  fetches the five files and transfers them into the iframe → worker; a private fetch shim answers the loader's three URLs from memory and is removed
  again before user code runs. Only the Python standard library is available (the npm package ships no numpy/pandas): other imports raise
  `ModuleNotFoundError` → `unsupported` → cloud.
* Not enforced: a memory cap. A worker has no memory limit API; runaway allocation ends as `RangeError` / `MemoryError` (→ `oom` → cloud) or, in the
  worst case, a crashed renderer for that hidden frame. Pyodide is ~12 MB per run (fresh instance per run, ~2–3 s start).

## Settings and API

* Org switch (default on): `GET/PUT /api/sandbox/local-exec` `{ enabled }` (PUT needs `sandbox.policy.manage`), stored in `tool_sandbox_settings`
  (`local_exec:<orgId>`). Admin UI: one switch row 「本地执行」 at the top of 管理后台 › 沙箱 (`web/src/features/admin/LocalExecAdmin.tsx`).
* Conversation preference (default "local"): `GET/PUT /api/conversations/:spaceId/:conversationId/local-exec` `{ preference: "local" | "cloud" }`
  → `LocalExecStatusDTO { enabled, connected, preference }` (stored as `local_pref:<spaceId>:<conversationId>`; no new table/migration).
* `ConversationEnvironmentDTO.local?: LocalExecStatusDTO` is added to `GET …/environment` and `POST …/environment/prepare` (new types in
  `shared/localexec.ts`, one optional field in `shared/sandbox.ts`, `withLocal()` in `server/src/tools/localexec/env.ts`).
* Web client for the environment button: `web/src/features/localexec/api.ts` (`useLocalExec(spaceId, conversationId)` → `{ status, setPreference }`).
* Job API (used by the tab only): `POST …/local-exec/jobs/:jobId/claim`, `GET …/jobs/:jobId/input?tabId=&path=`, `POST …/jobs/:jobId/result`.
* Tool description: code_run says when to use it; sandbox_exec says it is always the cloud sandbox and to prefer code_run for quick pure computation.
  `code_run` belongs to the 代码执行 tool group (org policy) and needs `sandbox.use`.

## What is verified (and how)

* `server/test/round11-localexec.test.ts` (17 tests): routing table and scan, broker (announce, claim race, wrong user / conversation / unknown job /
  not-connected tab, unclaimed → cloud, run timeout, tab_lost vs. quick reconnect, abort, late-connecting tab, output files incl. refusals), code_run
  through the real tool machinery (browser run with files in the host workspace, upgrade on timeout, no retry for code errors, scan → cloud, forced cloud,
  temp file lifecycle), preference/admin switch/environment DTO, HTTP authorization, quota/bad-path output files, input limits, SSE presence + `localjob`
  event over the real conversation stream, and the real cloud wrapper on this machine's namespaces driver (async body, `files`, return value, errors,
  path escape refused, Python in the cloud).
* `web/e2e/round11-local-exec.mjs` (51 checks, real Chromium + real server + fixture model): JS run in the browser with input/output files; the iframe
  has `sandbox="allow-scripts"` only and is removed afterwards; fetch / XHR / WebSocket / sendBeacon / importScripts to the Workroom API and to a
  listener outside all fail and the listener counts zero requests (positive control: the page itself reaches it); static scan → cloud; two tabs → one
  claim wins (200/409); preference 云端 and the admin switch (real UI) → cloud; no tab → cloud; timeout and "needs Node" → automatic upgrade with the
  note; stop kills the running job; Python in the browser (Pyodide from our origin, no CDN request) with files, the same probe battery (all blocked, zero
  hits), static scan → cloud, missing package and timeout → upgrade. Cloud checks use this machine's namespaces driver.
* Not verified: Firefox / Safari (only Chromium was run; if the runtime cannot start there the tab reports `unsupported` and the run is retried in the
  cloud, after the 5 s / 45 s start allowance); remote providers (OpenSandbox/E2B/Daytona) for the cloud path of code_run — it uses the same `Sandbox.run`
  as `sandbox_exec`, but this feature's tests ran it on the local namespaces driver only; mobile browsers; behaviour with a background (hidden) tab beyond
  what Chromium does by default.
