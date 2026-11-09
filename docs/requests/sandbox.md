# Requests from the SANDBOX group (round 4)

Owner of: `server/src/tools/sandbox*.ts`, `server/src/tools/sandbox/**`, `server/sandbox/**`, `jobs.ts`, `browser*.ts`, `web/src/features/work/**`,
`scripts/backup.mjs`, `docs/windows.md`, sandbox sections of `docs/files-tools.md`.

## To marketplace (skills + MCP) — the sandbox contract

Status: **implemented and tested** (`server/test/tools-sandbox-services.test.ts` on the namespace driver, `tools-sandbox-docker.test.ts` on real Docker). Types: `server/src/tools/sandbox/driver.ts`; service: `server/src/tools/sandbox.ts`; transport: `server/src/tools/sandbox/mcp-transport.ts`. Signatures will not change without a note here.
Extra info on `listServices()` rows: also `spaceId`, `conversationId`. `capabilities()` also returns `label`.

The sandbox now runs on one of three **drivers** (`namespaces` = Linux user namespaces, `docker` = Docker CLI on Windows/macOS/Linux, `none`).
Your code does not care which one is active: you ask the `sandbox` service (`ctx.services.get("sandbox") as Sandbox`, from `server/src/tools/sandbox.ts`).

### 1. Mounts (skills at `/skills/<slug>/`)

```ts
interface SandboxMount { hostPath: string; target: string; readOnly: boolean }   // server/src/tools/sandbox/driver.ts
```

- `hostPath`: absolute native path on the server machine (Windows `C:\...` is fine, the docker driver translates it).
  **It must live under an allowed mount root.** Materialize skill files below `sb.mountsRoot()` (= `<dataDir>/sandbox-mounts/`, created for you),
  e.g. `<mountsRoot>/skills/<slug>-<sha256-prefix>/`. If you need another root, call `sb.registerMountRoot(absDir)` once at init.
  Anything outside a registered root (or the conversation's own workspace) is refused with `HttpError(400, "bad_mount")`. The data dir itself,
  `app.sqlite`, `blobs/` and `durable.sqlite` can never be mounted.
- `target`: absolute POSIX path inside the sandbox, e.g. `/skills/pdf-report`. Reserved (refused): `/`, `/work`, `/tmp`, `/code`, `/proc`, `/dev`,
  `/sys`, `/etc`, `/usr`, `/bin`, `/sbin`, `/lib*`, `/runtime`, `/run`, `/var` and anything below them. `normalizeTarget()` in `driver.ts` is the validator.
- `readOnly: true` is enforced by the kernel (namespaces: bind remount `ro`; docker: `--mount ...,readonly`). Writable mounts are only accepted for the
  conversation's own workspace tree; skills must be `readOnly: true`.
- Per call: `sb.run({ ..., mounts: [...] })` and `sb.startService({ ..., mounts: [...] })`.
- **Automatic**: register a provider once and every `sandbox_exec` / `skill_run` / service of a conversation gets your mounts without further code:

```ts
const off = sb.addMountProvider("skills", async ({ principal, space, conversationId }) => [
  { hostPath: join(sb.mountsRoot(), "skills", "pdf-report-3fa9c1"), target: "/skills/pdf-report", readOnly: true },
]);   // returns an unregister function; the provider runs on every run/service start (keep it cheap; materialize lazily + cache by content hash)
```

Materialize files with plain `writeFileSync` (the directory is write-once content-addressed in your design; mode 0755 for scripts you want executable).
The sandbox sees them as read-only; `python3 /skills/pdf-report/main.py` works. Skills cannot write there (they write to `/work`).

### 2. Long-running service mode (MCP stdio servers)

```ts
const svc = await sb.acquireService(`mcp:${connectorId}:${conversationId}`, {   // same key → the running service is reused
  principal, space, conversationId,
  runtime: "node",                       // "node" | "python" | "shell": selects the docker image; namespaces uses host runtimes
  argv: ["node", "/skills/github-mcp/server.mjs"],   // resolved inside the sandbox (PATH is /runtime/bin:/usr/local/bin:/usr/bin:/bin)
  cwd: "/work",                          // optional
  env: { GITHUB_TOKEN: token },          // optional; visible only to that process
  mounts: [...],                         // optional, same rules as above
  network: false,                        // true only if the admin enabled sandbox network AND the driver can (see capabilities())
  idleTimeoutMs: 15 * 60_000,            // default 15 min without stdin/stdout traffic → stopped
  maxLifetimeMs: 60 * 60_000,            // default 1 h hard cap
  limits: { memoryBytes: 512 * 1024 ** 2 },   // optional overrides of the default limits
});
svc.stdin   // Writable   (write JSON-RPC lines)
svc.stdout  // Readable   (raw bytes; backpressure applies if you do not read)
svc.stderrTail()      // last 64 KB of stderr as text (stderr is always drained, never blocks the process)
svc.exited            // Promise<{ exitCode, signal, reason: "exit" | "stopped" | "idle" | "lifetime" | "shutdown" }>
svc.running           // boolean
await svc.stop()      // idempotent; kills the whole sandbox (all descendants), removes the container/scratch before resolving
```

- Services are stopped on server shutdown (`Sandbox.stop()`), after `idleTimeoutMs`, after `maxLifetimeMs`, and by `sb.stopServices((s) => s.key.startsWith("mcp:x:"))`.
  After a server crash the docker driver removes orphaned containers on the next start (label `workroom.sandbox=1`, per data dir); namespaces die with their parent.
- `sb.listServices()` → `{ key, id, runtime, startedAt, lastActivityAt, driver, running }[]` for your admin UI.
- **Do not use the MCP SDK's `StdioClientTransport`** for sandboxed servers (it spawns on the host). Use the transport we provide:

```ts
import { serviceTransport } from "./sandbox/mcp-transport.ts";
const transport = serviceTransport(svc);          // implements @modelcontextprotocol/sdk's Transport over svc.stdin/stdout (newline-delimited JSON-RPC)
await client.connect(transport);                  // closing the client stops the service (pass { keepAlive: true } to detach)
```

- Services get a writable `/work` (the conversation workspace) like normal runs. They are **not** idempotent: never start one from a pi `safe` tool without keying it.

### 3. Capabilities and failure modes

`await sb.capabilities()` → `{ driver: "namespaces" | "docker" | "none", state: "ready" | "needs_setup" | "unavailable", network: { supported, allowed }, services, mounts, runtimes, detail }`.
Check it before offering sandboxed MCP/skills in the UI. When `state !== "ready"` every run/service call throws `HttpError(503, "sandbox_unavailable", <message that says how to enable a driver>)`.
Network is **off by default** for every driver. Docker can provide it (`network: true` on a run/service) only when an org admin switches `network: "allowed"` in the sandbox settings
(`PUT /api/sandbox/driver`); namespaces cannot provide network at all. Do not assume network: skills must declare it, and you must handle the 403 `network_disabled`.

### 4. What stays yours

Skill/MCP catalog, review, materialization (what bytes go where), secrets for connector env, tool schemas. We do not read your tables, you do not touch `server/src/tools/sandbox/**`.
If you need a driver feature that is missing, add a request below (to us) rather than spawning processes yourself.

## To integrator

1. **Dependencies**: `playwright-core` (exact version, `optionalDependencies`) so the browser tool works on Windows/macOS with the system Edge/Chrome without a browser download; `browser.ts` already resolves `playwright` → global installs → `playwright-core`. Not installed by us (package.json is yours).
2. **Root `package.json` scripts**: `"test"` uses single-quoted globs (`'server/test/**/*.test.ts'`) which cmd.exe/PowerShell do not unquote → on Windows use `\"server/test/**/*.test.ts\"`. Also add `"sandbox:image": "node server/sandbox/build-image.mjs"` and `"backup": "node scripts/backup.mjs"`.
3. **`web/e2e/run.mjs`**: add `round4-sandbox.mjs` to the list (it uses port 8862 and `data/dev-sandbox`, like the other scripts it starts its own server; 27 checks).
4. **`server/src/main.ts`** (Windows): `relative(process.cwd(), config.webDist)` is absolute across drives and `${config.webDist}${c.req.path}` concatenates with `/`; use `path.join`/`resolve` + a `startsWith(webDist + sep)` containment check instead of `includes("..")`.
5. **Shared types**: new DTOs live in `shared/sandbox.ts` (new file). `shared/files.ts` `SandboxInfoDTO`/`SandboxFilesResponse` are now superseded by the same-named, compatible supersets there; `SandboxRunDTO` gained an untyped `driver` field. Please re-export or delete the old ones.
6. **Panel state**: `web/src/components/shell/panel.tsx` `WorkTab` is `"tasks" | "terminal" | "browser"`. The work panel's new 文件 tab is handled with local state; add `"files"` to `WorkTab` (then `openWork("files", …)` from the chat UI works, e.g. "open in workspace" on a file artifact). `WorkPanel` already honours `state.tab === "files"`.
7. **Permissions** (RBAC): used as defined in `shared/permissions.ts`: `sandbox.policy.manage` (driver settings), `sandbox.use` (workspace writes). `sandbox.network` is not enforced yet: network is host-wide off by default and only switchable by admins; when per-run network is wired to a skill/MCP declaration, check `authz.has(p, "sandbox.network")` in `Sandbox.#networkAllowed` (it has the principal in `run`/`startService`).
8. **`module.ts`**: the sandbox routes moved to `server/src/tools/sandbox-routes.ts` (one call to `registerSandboxRoutes`), `capabilities` sandbox section now comes from `Sandbox.capabilities()`, and `Sandbox.stop()` is async. No other changes.

## To files group (`server/src/files/**`) — Windows/macOS

1. `slides.ts` `slideRendererAvailable()` hard-codes `/usr/bin/soffice`, `/usr/lib/libreoffice/program/soffice`, `/usr/bin/pdftoppm`, and `renderSlides()` runs `soffice … -env:UserInstallation=file:///tmp/lo …; pdftoppm` through `sb.execIsolated(...)`. Patch: `import { findSoffice } from "../tools/sandbox/paths.ts"` (handles `WORKROOM_SOFFICE`, `C:\Program Files\LibreOffice\program\soffice.exe`, macOS app bundle, Linux paths, PATH); pass `{ hostTools: true }` as the 5th argument of `execIsolated` (documents that the command needs host programs; only the namespace driver provides them and it refuses otherwise instead of failing obscurely). For Windows/macOS: either keep the outline fallback (current behaviour, honest) or, opt-in only (`WORKROOM_PPTX_HOST_RENDER=1`), run `findSoffice()` through `runHost()` from `server/src/tools/sandbox/hostexec.ts` (no shell, clean env, timeout kills the process tree; NOT isolation — the pptx is untrusted input, so default off) and render PDF → PNG with `unpdf` + `@napi-rs/canvas` (already dependencies) instead of `pdftoppm`.
2. `generate.ts` ~line 269: CJK PDF font candidates are Linux-only. Add `C:\Windows\Fonts\msyh.ttc` / `simhei.ttf` / `simsun.ttc` and `/System/Library/Fonts/PingFang.ttc`, `/Library/Fonts/Arial Unicode.ttf` (check fontkit handles `.ttc`; more robust: ship an OFL Noto Sans SC subset in the repo).
3. `actor.ts` `spaceIdFromPath` uses `/\/spaces\/…/`; on Windows storage paths contain `\spaces\`. Use `/[\\/]spaces[\\/]([A-Za-z0-9_-]+)(?:[\\/]|$)/` (as `knowledge/extension.ts` already does).

## To ops (`server/src/ops/backup.ts`)

Line ~74 `rel.split("/").includes("sandbox")` and the manifest `path: relative(destDir, abs)` use the OS separator: on Windows the sandbox directories are not excluded and the manifest is not portable. Normalise with `.split(sep).join("/")`. Also the data volume now contains `sandbox-mounts/` (materialised skills, rebuildable) next to `orgs/…/sandbox/`: exclude it unless `includeSandbox`.

## To chat UI group

The user message bubble renders `[[call …]]` fixture directives raw in the chat (visible in `artifacts/screenshots/1440-sandbox-terminal.png`); strip them in display (fixture mode only). Work panel entry points that should open the new tab: file artifacts produced by `sandbox_*` tools (`workTabFor()` in `chat/Steps.tsx` maps tool names to tabs: `sandbox_list|sandbox_write_file|sandbox_read_file|sandbox_import|sandbox_publish` → `"files"` once `WorkTab` has it).

## To marketplace

- `Sandbox.mountsRoot()` is `<dataDir>/sandbox-mounts`; materialise skills/MCP packages below it (the contract above). `skills.ts` `execute()` currently writes skill resources into `/work/.skills/…` via `writeFile` (counts against the workspace quota and shows in the file tree); the intended design is the read-only `/skills/<slug>/` mount via `addMountProvider`.
- `chmod 0o555/0o444` on Windows only toggles the read-only attribute; executable bits are irrelevant there (scripts are started as `python3 /skills/x/main.py`, never executed directly). Deleting read-only trees on Windows may need `rmSync(..., { force: true })` after clearing the attribute.
- The MCP SDK's `StdioClientTransport` already uses `cross-spawn`, so host-side stdio servers work on Windows; sandboxed ones use `serviceTransport()`.
