# Sandbox research notes (round 4)

Decisions and what was actually measured. Dates 2026-11-09.

## Why drivers
The only isolation was Linux user namespaces (`/usr/bin/unshare`), so Windows/macOS showed "沙箱不可用" for every code/terminal feature. Options considered:
- **Docker CLI** (chosen for Windows/macOS): every Docker Desktop/Engine install ships the CLI; the CLI already handles `npipe:////./pipe/docker_engine`, contexts, `DOCKER_HOST`. Engine API directly (node `http` over the pipe) would avoid exec overhead but needs multiplexed-stream demux and was not worth the unverifiable code. Not implemented; documented.
- WSL2 + namespaces driver on Windows: requires running the whole server inside WSL; users can do that (then `namespaces` works) but it is not a Windows-native answer.
- Hyper-V/Firecracker/gVisor: not available on a typical desktop; out of scope.
- QuickJS (already used for code mode) is JS only; no Python.

## Verified on this machine (Linux, real dockerd)
`dockerd --storage-driver=vfs --iptables=false --bridge=none` starts in this cloud sandbox (no overlay on overlay). Images pulled through the agent proxy. Real runs verified: non-root uid, read-only rootfs, `--network none` (connect → ENETUNREACH 101), tmpfs /tmp, pids limit (fork fails with EAGAIN), memory limit (OOM → 137, `State.OOMKilled`), timeout/cancel cleanup, read-only mounts, host paths with spaces/commas/unicode, services (stdin/stdout, idle, stop), MCP client over the service transport, orphan reaper.
Not verified: Docker Desktop (WSL2/Hyper-V/VirtioFS), bind-mount permissions for uid 10001 there, rootless Docker, macOS.

## Findings worth remembering
- **vfs storage copies the whole image per container**: 17 s to start a container from the 686 MB data-science image vs 2 s for python:3.12-slim. overlay2 hosts do not have this. Docker tests therefore use the slim images except one test for the full image.
- **Race: timeout/cancel before the container exists.** `docker kill` fails, and `docker rm -f NAME` on a not-yet-existing name *succeeds silently*; killing the CLI at that point leaves the daemon to finish creating a `Created` orphan (reproduced). Fix: poll `container inspect` until the container exists, `rm -f` it, then let the CLI exit by itself.
- `--pull never` + explicit image presence check (`image inspect`) keeps runs from stalling on pulls; autoPull is a deliberate, visible first-use step.
- Secrets for services go through `--env-file` in a 0600 scratch file so they do not show in `ps`/`docker inspect` command lines (they are still in the container's environment).
- Linux with a root server: container uid 10001 cannot write root-owned bind mounts; the driver `chown`s the workdir (and host-side writes into it) to 10001. Non-root server → container runs as the server's uid. Rootless Docker → container root (= host user).
- Python in the image: `MPLCONFIGDIR`, `HOME=/tmp/home`, `XDG_CACHE_HOME` point at the tmpfs because the root fs is read-only.
- `unshare --map-root-user` mount-ro remount works for extra bind mounts as for the existing ones (tested with /skills mounts).
- Workspace symlinks are the main new host-side attack surface: sandboxed code can create `ln -s /host/secret x`; every host-side read/write/publish resolves each existing path component and refuses links leaving the workdir; delete/rename act on the link (`lstat`).
- Windows names: `:` (NTFS streams, drive letters), trailing dot/space, `<>"|?*` are rejected in workspace paths on every OS so a workspace is portable.

## Open questions
- Per-run network: needs a policy that skills/MCP *declare* network and admins approve; today it is a host-wide admin switch plus capability check. A restricted egress (allowlist proxy) would be the real answer; Docker `bridge` alone exposes the LAN.
- Disk quota per workspace for Docker (`--storage-opt size` needs xfs+pquota); only soft quota exists.
- Pre-built image distribution (registry) — currently build locally or fall back to public slim images.
