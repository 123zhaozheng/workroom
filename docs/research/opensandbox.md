# OpenSandbox research (round 7)

Verified on 2026-11-11 against a real local server. "Verified" below means: observed against `opensandbox-server 1.2.0` (Docker runtime) with
the official TypeScript SDK 1.2.0 on this host, by `scripts/opensandbox-local.sh` + `server/test/sandbox-contract.test.ts`.
Everything else is marked "documented" (read in the project's docs, not run) or "not supported".

## What it is

OpenSandbox is an Apache-2.0 "run AI agents in sandboxes on your own infrastructure" platform (an Agentic AI Foundation project).
Two parts: a **lifecycle server** (FastAPI; Docker or Kubernetes runtime, plus a "Fast Sandbox" Firecracker composition on Kubernetes) and
**execd**, a daemon injected into every sandbox that serves commands, files, PTY, code contexts and metrics.

**It is NOT E2B-compatible.** Own lifecycle API (`/v1/sandboxes…`, header `OPEN-SANDBOX-API-KEY`), own execd protocol (SSE command stream,
multipart upload). The Workroom adapter therefore speaks OpenSandbox natively; E2B-compatible services use the separate E2B adapter.

## Packages, versions, licenses (checked, not assumed)

| Item | Value |
|---|---|
| Repository | `github.com/opensandbox-group/OpenSandbox` (the `repository` field of the npm package and the "Repository" URL of the PyPI package) |
| Official TypeScript SDK | **`@alibaba-group/opensandbox` 1.2.0**, license **Apache-2.0**, ESM, Node >= 20; deps `undici`, `openapi-fetch`, `@opentelemetry/api`. Tarball sha1 `21e25e36b39e4cec2a16151f5c5b80714e791b0a` (matches the registry). Published 2026-10-27. |
| Server | PyPI **`opensandbox-server` 1.2.0**, Apache-2.0, Python >= 3.10 |
| Other SDKs | Python (`opensandbox`), Java/Kotlin, C#/.NET, Go; CLI `osb`; MCP server |
| Images (server 1.2.0 example config) | `opensandbox/execd:v1.1.0`, `opensandbox/egress:v1.1.7` |

SDK telemetry: the SDK reports sandbox.create latency to the lifecycle server (`/v1/metrics/events`, i.e. to *your* server, not a third party);
Workroom turns it off (`disableMetrics: true`).

SDK vs raw HTTP: the SDK was chosen. It implements the execd SSE stream, the multipart upload, endpoint resolution (including the
server-side proxy) and wake-retry; re-implementing a moving protocol would be more code and more risk. It is an exact-pinned
`optionalDependencies` entry, imported lazily (`await import()` with a variable specifier), so a deployment without OpenSandbox never loads it and
a missing install yields a clear "not installed" error (HTTP 501), never a fallback.

## Lifecycle API (server)

| Operation | HTTP | SDK | Notes (verified unless marked) |
|---|---|---|---|
| create | `POST /v1/sandboxes` | `Sandbox.create({image, timeoutSeconds, metadata, resource, env, networkPolicy, …})` | Asynchronous (`Pending` → `Running`); SDK waits for readiness. ~5-10 s for a cold container here. `timeoutSeconds` = absolute TTL (not idle). `metadata` keys under `opensandbox.io/` are reserved. |
| get / list | `GET /v1/sandboxes[/{id}]` | `SandboxManager.listSandboxInfos({metadata, states, page, pageSize})` | Metadata filter works (used for orphan reaping). |
| delete | `DELETE /v1/sandboxes/{id}` | `killSandbox(id)` | A second delete answers 404 → treated as success (idempotent). |
| renew | `POST …/renew-expiration` | `sandbox.renew(seconds)` | Sets `expiresAt = now + seconds`; the create-time cap does not apply. |
| pause / resume | `POST …/pause|resume` | `pause()/resume()` | Documented; **not used** (capability `pauseResume: unsupported`). |
| snapshots | `/v1/sandboxes/{id}/snapshots`, `/v1/snapshots` | `SandboxManager.createSnapshot…` | Documented; not used. |
| templates / pools | `/v1/templates`, `/v1/pools` | | Documented (Fast Sandbox golden images, client/server pools); not used. |
| endpoint | `GET …/endpoints/{port}` | `getEndpoint(port)` | Direct host-mapped address or gateway route. |
| server proxy | `ANY …/proxy/{port}/{path}` | `ConnectionConfig({useServerProxy: true})` | Verified: all execd traffic flows through the lifecycle URL. **Workroom uses it by default** so the address a server reports for a sandbox cannot redirect Workroom (SSRF containment); `options.directEndpoints="1"` opts out. |
| diagnostics | `…/diagnostics/*` | | Documented. |

State machine: `Pending`, `Running`, `Pausing`, `Paused`, `Resuming`, `Stopping`, `Terminated`, `Failed`. The server does not store sandboxes
in its DB (the Docker container is the source of truth); expiry is an absolute TTL. `GET` of a deleted sandbox → 404 (verified), which
the adapter maps to `connect() → null` so Workroom recreates and re-syncs.

Authentication: header `OPEN-SANDBOX-API-KEY`. With no key configured the server refuses to start unless `OPENSANDBOX_INSECURE_SERVER=YES`.
The OpenAPI document reports `info.version = 0.1.0` (schema version, not the package version): the Workroom health check shows it as "API schema 0.1.0".

## execd protocol (in-sandbox)

Default port 44772, reached through the server proxy (verified) or a direct endpoint. Documented API surface: `/ping /ready`, `/command`
(foreground = SSE stream; background = poll status/logs; shell string or argv), `/session` (persistent bash), `/code` (Jupyter contexts),
`/pty` (WebSocket terminals), `/files /directories` (upload multipart, download with `Range`, list, search, move, chmod, replace, delete), `/metrics`,
`/proxy/{port}`, isolated (bubblewrap) sessions `/v1/isolated/*`.

Verified behaviour (execd v1.1.0):

* Commands: `commands.run(cmd, {workingDirectory, envs, timeoutSeconds, uid, gid}, handlers, signal)`; the shell is bash. Exit code arrives as
  `execution.exitCode` (also `error.exitCode` for non-zero). Output events are **line-split with the terminator removed** (newer execd documents
  that it preserves line endings); the adapter re-adds `\n` only when a message lacks one. An unterminated final fragment cannot be distinguished.
* Streaming: stdout chunks arrive ~300 ms apart while the command runs (contract case "streaming").
* Timeout: server-side `timeoutSeconds` kills the whole process group (exit -1, "signal: killed"); `-1` is also what an external kill reports,
  so the adapter classifies as `timeout` when the elapsed time reached the deadline, else `killed`.
* Cancel: aborting the client request stops the command inside the container; the adapter additionally calls `interrupt(id)`. The contract suite
  scans `/proc` for the process (the slim Python image has no `ps`/`pgrep`; an earlier exploratory check that relied on them was invalid and was redone).
* `uid`/`gid` on a command: verified (`uid=10001`). Workroom runs user code as uid 10001; root is used only for its own setup commands
  (`ExecOptions.privileged`), which is what makes `chmod a-w` skill directories actually read-only for user code (root ignores mode bits).
* Files: `writeFiles` (20 MB in ~0.45 s, parents created, odd names incl. spaces/unicode OK), `readBytes` (`range: "bytes=0-9"` works; `offset/limit` options are rejected
  with 400), `getFileInfo`, `listDirectory({path, depth})` (recursive by default, symlinks reported as `symlink`, fifos as `other`, **never followed**),
  `createDirectories`, `deleteFiles` (missing file = success), read of a missing file = 404.
* Uploads are staged next to the destination and renamed into place (documented); the filesystem route has an identity prefix
  `/v1/filesystem/{uid}/{gid}` (documented; not used - Workroom writes as root and `chmod a+rwX /work`).

## Network policy

* `networkPolicy: {defaultAction: "deny", egress: [{action: "allow", target: "pypi.org"}]}` at create time (and patchable at runtime through the egress sidecar).
* Requires `docker.network_mode = "bridge"` and an `[egress].image`; the server attaches an **egress sidecar** container. If it cannot, create fails
  with HTTP 500 `DOCKER::SANDBOX_START_FAILED` (observed on a kernel without IPv6 procfs until `[egress] disable_ipv6 = false`; the script handles it).
* Egress modes: `dns` (DNS-name filtering only) and `dns+nft` (adds nftables IP/CIDR enforcement).
* Verified with a default-deny sandbox: name resolution fails in both modes. **In `dns` mode raw-IP connections to 1.1.1.1, 8.8.8.8 and 169.254.169.254
  all succeeded** - deny is not a network cut-off. **In `dns+nft` mode 1.1.1.1, the Docker gateway and 169.254.169.254 were blocked, but 8.8.8.8
  (the sidecar's upstream resolver) stayed reachable on port 80**: the resolver IP is allowed on every port, so a DNS-tunnelling exfiltration path
  remains. Consequence: capability `networkOff` is **unverified** (works, with that caveat), the local script defaults to `dns+nft`, and the isolation text says so.
* Sandboxes created without `networkPolicy` have network access (verified; behind this host's TLS-intercepting proxy).

## Resource limits

`resource: {cpu: "1", memory: "512Mi"}` is forwarded (Docker: container limits; Kubernetes: requests/limits). `pids_limit` (default 4096), dropped
capabilities, `no_new_privileges` and seccomp/AppArmor are server-side Docker settings. The effective cgroup limit inside the sandbox could not be
read back here (`/sys/fs/cgroup/memory.max` absent in the nested daemon), so `resourceLimits` is **unverified**.

## Isolation, honestly

Docker runtime = one container per sandbox on the server host's kernel (shared kernel; escapes are a kernel/runtime bug away). Kubernetes runtime
with gVisor/Kata/Firecracker ("Fast Sandbox") gives stronger isolation - operator's choice, not something Workroom can verify. Multi-tenancy
(namespace per tenant) is Kubernetes-only. The docs state the filesystem identity feature "does not provide a separate mount namespace or a tenant
isolation boundary" - so Workroom never shares one sandbox between tenants (one per org/space/conversation).

## Not supported / not used by Workroom

* Long-lived services / MCP stdio servers (`startService`) - refused with UnsupportedError (501); execd background commands exist but are not wired.
* PTY / terminals, preview ports, snapshots, pause/resume, code contexts (Jupyter), isolated sessions, credential vault, volumes (host/PVC/OSSFS bind
  mounts - Workroom uploads skills instead and never exposes host paths) - exist in OpenSandbox, intentionally unused: capabilities `unsupported`.
* Per-command memory/CPU limits: limits are per sandbox at creation.

## Capability table (OpenSandbox adapter)

| Capability | Status | Evidence |
|---|---|---|
| exec | supported | contract: exit code, stdout, stderr |
| streamOutput | supported | contract: chunks >= 800 ms before the last |
| cancel | supported | contract: process gone from /proc after abort |
| commandTimeout | supported | contract: status `timeout`, process gone |
| files | supported | contract: roundtrip, binary, deletions, limits, symlink/special entries |
| networkOff | unverified | policy works; resolver IP stays reachable (see above) |
| networkOn | supported | create without policy reaches the network |
| resourceLimits | unverified | forwarded, not read back |
| reconnect | supported | contract: new driver, same remote id, `/tmp` state intact |
| services, pty, preview, snapshot, pauseResume | unsupported | not implemented |
| skills | upload_readonly | contract: write blocked for uid 10001, hash verified, tamper repaired |

## Local server (reproducible)

`scripts/opensandbox-local.sh` (idempotent): venv with `opensandbox-server==1.2.0`, config (Docker runtime, loopback only, bridge network,
`[egress] mode = dns+nft`), pulls `opensandbox/execd:v1.1.0`, `opensandbox/egress:v1.1.7` and `python:3.12-slim`, generates an API key
(mode 600, outside the repo; never printed), starts the server on `127.0.0.1:8080` and prints the endpoint and key-file path.
Needs a Docker daemon (this container: `dockerd --storage-driver=vfs &`). Observed blocker and fix on this host: the egress sidecar failed with
`unsafe procfs detected … net.ipv6.conf.all.disable_ipv6: no such file` (no IPv6 procfs); the script sets `[egress] disable_ipv6 = false` only when that
procfs is missing.

```
WORKROOM_TEST_OPENSANDBOX_URL=http://127.0.0.1:8080 \
WORKROOM_TEST_OPENSANDBOX_KEY="$(cat ~/.workroom-opensandbox/api.key)" \
  node --disable-warning=ExperimentalWarning --test server/test/sandbox-contract.test.ts
```

## Known gaps

* A run needs a cold sandbox the first time (5-10 s); later runs reuse it (idle/lifetime reaping, defaults 30 min / 4 h).
* execd 1.1.0 strips line terminators (see above): output without a trailing newline gains one.
* Sync is whole-workspace per run (hash scan of the host workdir + one remote `find|sha256sum`); very large workspaces make every run slower.
* Network "off" is not airtight (resolver IP).
* Only the Docker runtime was run here; Kubernetes / Fast Sandbox runtimes are untested.
