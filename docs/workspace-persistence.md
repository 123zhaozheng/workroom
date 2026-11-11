# Persistent workspace (round 7b, group P)

Layers that must never be conflated: pi-durable conversation checkpoints ≠ **workspace file versions (this document)** ≠ sandbox memory/process
snapshots (provider feature, not used). pi-durable never restores sandbox files or processes. Deliverables and uploads live in the file library
(FileService, immutable versions) and are not duplicated here.

Code: `server/src/tools/sandbox/persist.ts` (service `workspacePersistenceFor(ctx)`), `persist-routes.ts` (HTTP), contract in `shared/workspace-safety.ts` §1.

## Model
* The **host working copy** `<space.dir>/sandbox/<workspaceKey>` (`c<conversationId>` or `shared`) stays authoritative; local drivers bind-mount it, remote
  providers sync it per run. A **version** is an immutable, verified copy: a manifest `[{path,size,sha256,mode}]` in `workspace_versions` plus content-addressed
  blobs in `ctx.blobs` (identical content is stored once across versions, conversations and spaces).
* `workspace_state` holds, per (space, workspace): `state`, `head_version` (the version the working copy is based on), `last_saved_at`, `last_attempt_at`, `failure`, `restore`.
* States: `saved` (copy == head) · `dirty` (derived: copy differs from head, including a missing copy) · `saving` · `failed` (sticky until a commit succeeds; copy kept, never reaped)
  · `conflict` (sticky; nothing overwritten) · `restoring` · `restored` (copy rebuilt from a version and hash-verified; becomes `dirty` as soon as it changes).
  A `saving`/`restoring` row with no operation running (crash) is reported as `failed` ("interrupted").
* Modes are normalised to 0644 / 0755. Empty directories are not preserved (only files are). Timestamps and ownership are not preserved.

## Policy (per org; `GET/PUT /api/workspace-policy`, permission `sandbox.policy.manage`)
| field | default |
|---|---|
| exclude | `node_modules/ .venv/ __pycache__/ .cache/ .npm/ .pip/ tmp/ .skill-run/ *.pyc *.tmp` |
| maxFileBytes / maxFiles / maxTotalBytes | 50 MB / 5000 / 500 MB |
| keepVersions | 20 (head and the last restore source are never pruned; blobs are never deleted by pruning) |
| workingCopyRetentionHours | 72 |
| periodicSyncSec | 0 (off; a supplement for long jobs, never a substitute for the sync points) |

Pattern syntax: `name/` = a directory of that name at any depth (whole subtree skipped); `*.ext` / `name` = basename glob at any depth; a pattern containing `/`
(or a leading `/`) is anchored at the workspace root; `*` = within a segment, `**` = across segments. **Saved**: every regular file not excluded. **Excluded**:
policy patterns (stay in the working copy, are not versioned, are lost if the copy is rebuilt – they are regenerable caches). **Never saved, reported as notes**:
symlinks, special files (sockets, fifos, devices), unsafe file names, directories deeper than 64 levels. Symlinks are never followed.
Limits fail the whole commit explicitly (state `failed`, text names the file / limit and the policy field); nothing is truncated silently.

## Sync points (who calls `commit`)
Always `commit(principal, space, workspaceKey, reason)`; reasons `run_end`, `file_write`, `before_publish`, `periodic`, `manual`, `restore` (`turn_end` exists in the API but is NOT wired in this round — the save points actually in use are run end, workspace file writes and before publish).
Commit is idempotent (same manifest as head → no new version, still `saved`), serialised per workspace, and checks the base version in the same DB
transaction that inserts the version. Hooks must treat a non-`ok` result as "report, don't fail the run".

## Maximum loss window (changes that can be lost, per driver)
| driver | what can be lost | until |
|---|---|---|
| namespaces / docker (local) | nothing while the host dir exists; if the host disk/dir is destroyed: everything after the last commit | next sync point (run end / turn end / before publish / manual) |
| remote (OpenSandbox/E2B/Daytona) | changes made by a *running* command in the remote sandbox are lost if the sandbox dies before sync-back; the host copy and committed versions are unaffected | run end sync-back (then the `run_end` commit) |
| any, working copy reaped | nothing: reaping only removes copies equal to a committed head | – |

`WorkspaceSaveStatusDTO.lossWindow` carries this honestly (`persist.lossWindowFor` is a hook; default = local text, remote text `REMOTE_LOSS_WINDOW`).

## Conflict handling
`commit` with an explicit `baseVersion` that is no longer the head → `conflict`, failure text names both versions, nothing written, working copy untouched.
Default base = head read inside the per-workspace mutex, so two parallel default commits produce one version. Resolution: save again (builds on the current head) or
restore. `restore` onto a working copy that differs from the head is refused with 409 `workspace_dirty` (state `conflict`, `restore.conflicts` lists paths).

## Restore flow
`POST /api/workspaces/:spaceId/:workspaceKey/restore {version?, force?}` (version defaults to head, else newest):
1. dirty copy and no force → 409; `force:"keep-both"` first saves the current copy as a new version (`reason: "restore"`), then continues – no data loss;
2. rebuild in `<sandbox>/.restore-tmp/<key>-<rand>`: manifest hash checked, every path validated (no `..`, absolute, backslash, NUL), every blob must exist and match sha256 + size;
3. swap atomically (`rename`): the old copy is moved to `<sandbox>/.restore-backup/<key>-<ts>` and deleted only if it was clean and had nothing unsaved-by-design; otherwise it is kept;
4. state `restored`, `head_version` = restored version, `restore = {fromVersion, at, verified:true, conflicts:[]}`. The next save gets a fresh version number.
Any verification failure (tampered/missing blob, tampered manifest) → 500 `restore_verify_failed`, state `failed`, nothing placed, temp dir removed.
`ensureReady()` before a run restores automatically when the copy is **absent** (fresh host, reaped, lost) and versions exist.

## Reaping
`reapWorkingCopies(now)` replaces the unconditional file sweep of `Sandbox.reap()`: a whole workspace is removed only if idle (newest mtime) longer than the org
`workingCopyRetentionHours`, stored state is `saved`/`restored`, the copy equals the head and holds no symlinks/special entries. Never-saved, dirty, failed, conflict copies are kept (`kept[]` lists why).

## Failure handling
Every commit/restore error ends in a persisted state + plain failure text; the working copy is never modified by a failed operation; a failed or conflicting copy is not eligible for cleanup.
At startup `reconcileInterruptedRuns()` marks `tool_sandbox_runs` rows still `running` as `unknown` with stderr note “服务重启时仍在运行，结果未知；不会自动重新执行”, records them in
`workspace_run_reconciliations` (`interruptedRuns(spaceId)`) and never re-runs anything. (`SandboxRunDTO.status` should gain `"unknown"` in shared/files.ts.)

## HTTP API
`GET /api/workspaces/:spaceId/:workspaceKey/status` (space read) → `{status}` · `POST …/save` (write) → `{saved:{created,version,notes},status}` / 409 `workspace_conflict` / 422 `workspace_save_failed` (+`status`) ·
`GET …/versions` → `{versions}` · `GET …/versions/:n` → `{version,manifest}` · `POST …/restore {version?, force?}` (write) → `{restored:{fromVersion,verified,keptAsVersion?},status}` ·
`GET/PUT /api/workspace-policy` (`sandbox.policy.manage`) → `{policy, defaults}` / `{policy}`. Other org → 404, no access → 403, version ids are only resolved inside the matching space.

## Migration and rollback
Migration `PERSIST_MIGRATIONS` v1 (wired at offset +1000) only adds tables: `workspace_versions`, `workspace_state`, `workspace_persist_policy`, `workspace_run_reconciliations`.
No existing table or file is changed. Existing workspaces start with no head: status `dirty` (all files unsynced) until the first commit; nothing is auto-deleted by this feature.
Rollback: remove the hooks and route registration; the tables are inert and may stay (or be dropped). Blobs written by commits remain in the blob store (content-addressed; no GC exists yet).
Operational notes: pruned versions leave their blobs; `.restore-backup` is never auto-removed; hashing is done on the host, so very large workspaces are bounded by the policy limits.
