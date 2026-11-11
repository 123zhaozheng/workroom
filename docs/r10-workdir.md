# Round 10: configurable sandbox working directory

## Problem

With Daytona as the sandbox provider every run failed before the program started:

```
远端命令失败（error 1）：mkdir: cannot create directory '/work': Permission denied
```

`RemoteDriver` had a hardcoded `REMOTE_WORK = "/work"` for the workspace sync (host → remote and back), `chmod`, the `find`/`sha256sum` listing and the
command's cwd, and uploaded read-only mounts (skills) to absolute targets such as `/skills/<slug>`. Daytona's default user (`daytona`, home
`/home/daytona`) is not root, so neither directory can be created at the filesystem root. The model was also told `/work` in tool descriptions and
outputs, whatever the sandbox looked like.

## Defaults per provider

The working directory is a per-provider setting. When it is empty the provider's deterministic default applies
(`server/src/tools/sandbox/workdir.ts`, `DEFAULT_WORKDIR`):

| Provider | Default working directory | Skills (read-only) |
| --- | --- | --- |
| OpenSandbox | `/work` (unchanged: existing deployments and the live tests rely on it) | `/skills/<slug>` |
| E2B | `/home/user/work` | `/home/user/skills/<slug>` |
| Daytona | `/home/daytona/work` | `/home/daytona/skills/<slug>` |
| Local drivers (namespaces / docker) | `/work` (fixed, kernel mounts) | `/skills/<slug>` |

Mount targets are re-rooted next to the working directory: for `/work` they stay unchanged, otherwise
`<dirname(workDir)>/<target without leading slash>` (`/home/daytona/work` + `/skills/pdf` → `/home/daytona/skills/pdf`,
`/tmp/wr-work` + `/skills/pdf` → `/tmp/skills/pdf`, `/data` + `/skills/pdf` → `/skills/pdf`). A mount that would overlap the working directory
(e.g. a working directory literally named `…/skills`) is refused with a visible `bad_mount` error.

## How to configure

管理后台 › 沙箱 › the provider's card › 「工作目录」 (test id `<provider>-workdir`, placeholder = the provider default). API:
`PUT /api/sandbox/providers/:provider` with `{ "workDir": "/home/daytona/work" }`; `null` or `""` clears it (back to the default).
`GET /api/sandbox/providers` returns `workDir` (only when set) and `defaultWorkDir` (always).

Validation (400 `invalid_workdir`, plain Chinese message):

- absolute POSIX path; `//`, trailing `/` and `.` segments are normalised away; no `..`; no backslash or control characters;
- segments only `[A-Za-z0-9._@+-]` (the path is also used in shell commands and environment variables);
- at most 200 characters;
- not `/`; not a system directory or anything below it: `/etc /proc /sys /dev /usr /bin /sbin /lib /lib32 /lib64 /libx32 /boot /run /var/run`;
- not a shared root itself (the whole directory is `chmod`-ed and synced): `/home /root /tmp /var /opt /mnt /srv /media /snap` and `/home/<user>`
  (a subdirectory such as `/home/daytona/work` or `/tmp/wr-work` is fine).

The directory must be creatable and writable by the sandbox user. `RemoteDriver` runs `mkdir -p` (privileged where the provider has such a mode) and then
checks as the unprivileged workload user that the directory is writable. If that fails the run stops before anything is uploaded or executed with:

> 工作目录 /work 在沙箱内不可写（当前用户 daytona）：请管理员在“沙箱提供方”中把工作目录改为该用户可写的路径

(HTTP 503, code `sandbox_workdir_unwritable`; it also appears as the environment's failure message). There is never a fallback to the host.

### Changing it

The resolved working directory is part of the driver fingerprint, so a change rebuilds the `RemoteDriver`. The instance table remembers which directory
the sync manifest refers to (`tool_sandbox_instances.work_dir`, migration `sandbox 204`; `NULL` = created by an older version = `/work`). On the next run
the manifest is dropped, the **same remote sandbox** is reused, the whole workspace is uploaded into the new directory and the run notes say so
(`沙箱工作目录已从 … 改为 …`). The old directory in the sandbox is not deleted (it may hold anything). Switching the provider or the channel needs
nothing special: a different provider has its own sandboxes.

Other facts: `HOME` and `TMPDIR` stay `/tmp` (writable for every user); every run gets `WORKROOM_WORKDIR=<working directory>` (remote drivers set it from
their resolved directory and a user variable of that name cannot override it; local drivers set `/work`).

## What the model sees

1. **System prompt section `sandbox`** (extension `wr.sandbox`, `sandbox/prompt.ts`): kind (`云端沙箱 Daytona（远端…）` or
   `平台内置沙箱（Docker）`), the absolute working directory (cwd of every command, also `$WORKROOM_WORKDIR`; prefer relative paths), the accepted
   path forms of the file tools, and the real skills directory. When a remote channel is configured but unusable the section says so instead
   ("当前不可用：…，不要声称已经执行过命令"). It is omitted for actors without `sandbox.use`.
   pi-durable renders sections before every model request and only stores/sends a changed text, so the section follows the **current** channel and working
   directory: an admin change reaches existing conversations on their next request (it is not frozen at conversation start). The text is a pure
   function of the configuration, so prompt caches stay warm between changes. The prompt skill index also names the real `/work`-equivalent and skills paths.
2. **Tool descriptions** no longer hardcode `/work`: they say "the sandbox working directory (see the system prompt)".
3. **File tools** (`sandbox_write_file`, `sandbox_read_file`, `sandbox_import`, `sandbox_publish`, the workspace HTTP API, `skill_manage` `dir`, job `publish`
   paths) accept a path relative, as `/work/…` (backward compatible), or prefixed with the real working directory; all map to the same host-workspace
   relative path (`stripWorkPrefix` before `workspace.cleanPath`; `Sandbox.relPath`).
4. **Tool outputs** print the real path: `sandbox_write_file` / `sandbox_import` results, `skill` list/search/load (`dir="…"`, mount location),
   skill_manage messages, job output notes. Skill scripts run with `SKILL_DIR`, `SKILL_INPUT_FILE` pointing at the real paths of the active driver.
5. **Environment API** (`GET /api/conversations/:spaceId/:conversationId/environment`) returns `workDir` and `skillsDir`
   (`/work`, `/skills` for local drivers); `GET /api/sandbox/:spaceId` returns `workDir` as well.

## Tests

- `server/test/sandbox-workdir.test.ts`: validation, defaults, mount mapping, path stripping, prompt text, `RemoteDriver` with a non-root fake
  (the bug, configured directory, mounts, overlap, change → resync), fingerprint rebuild, provider-config validation, file-tool spellings, tool outputs,
  prompt section re-rendering, environment DTO, skill tool output.
- `server/test/sandbox-remote-e2e.test.ts` (live OpenSandbox): a non-default directory `/tmp/wr-work` is honoured by a real provider (sync both ways,
  cwd, `WORKROOM_WORKDIR`, skills mount at `/tmp/skills`, change → full resync into `/tmp/wr-work2` in the same sandbox, clearing → `/work`).
- Not verified against a real Daytona or E2B account (none available): their behaviour rests on the provider-independent logic above and the Daytona wire test.
