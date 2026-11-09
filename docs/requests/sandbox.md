# Requests from the SANDBOX group (round 4)

Owner of: `server/src/tools/sandbox*.ts`, `server/src/tools/sandbox/**`, `server/sandbox/**`, `jobs.ts`, `browser*.ts`, `web/src/features/work/**`,
`scripts/backup.mjs`, `docs/windows.md`, sandbox sections of `docs/files-tools.md`.

## To marketplace (skills + MCP) — the sandbox contract

Status: the types are final in `server/src/tools/sandbox/driver.ts`; the `Sandbox` service methods below are the stable surface
(implementation lands in the following commits; signatures will not change without a note here).

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

(filled in as items are found — see sections below)
