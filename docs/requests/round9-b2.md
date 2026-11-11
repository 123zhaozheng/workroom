# Round 9 B2 — requests to the integrator (conversation menu state + global search)

Files owned: `server/src/runtime/module.ts` (migration v3, wiring), `meta.ts`, `search.ts`, `meta-routes.ts`, `server/test/round9-meta-search.test.ts`.
Everything below is already wired; the items are only what B2 could not do inside its own files.

## 1. Tests that assert the exact catalog schema (must be updated, additive migration)

`server/test/runtime-handoff.test.ts` (the last `assert.equal` of the first test; that file also carries B1's uncommitted edit, so B2 did not touch it):

```ts
assert.equal(t.app.ctx.db.all<any>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'rt_%' AND name NOT LIKE 'rt_search_fts_%' ORDER BY name").map((r) => r.name).join(","), "rt_assistants,rt_conversation_stars,rt_conversation_tags,rt_conversations,rt_promote_intents,rt_search_docs,rt_search_fts,rt_search_progress,rt_space_leases,rt_space_runtime");
```
(the FTS5 shadow tables `rt_search_fts_data/_idx/_docsize/_config` are excluded by the extra `NOT LIKE`). The comment can say: "round 9: stars/tags/search index are menu state and a derived index, not handoff facts".

`server/test/runtime-lease.test.ts` (columns of `rt_conversations`): already updated by B2 (adds `deleted_at`, `deleted_by`).

## 2. SSE streams of a conversation that gets deleted (B1: `routes.ts`)

`Runtime.access()` already answers 404 for a soft-deleted conversation, but an SSE stream that is already open only re-checks `acl.check` every `aclRecheckMs`, which does not know about deletion. In the `recheck` interval of `GET /conversations/:spaceId/:id/events`, before the ACL check:

```ts
if (rt.row(spaceId, id)?.deleted_at) {
	await stream.writeSSE({ event: "error", data: JSON.stringify({ code: "not_found", message: "会话已被删除" }) }).catch(() => {});
	close();
	return;
}
```

## 3. Visible-conversation listing cap

Search and `/conversation-meta` take "what the caller may see" from `Runtime.list()` (the sidebar path, so B1's shared projects are included): `ConversationMeta.lister` calls it for active + archived (`limit: 200` each) and, per `identity.sharedProjectIds()`, once more with `projectId`. `Runtime.list` caps `limit` at 200 (`Math.min(Math.max(Number(q.limit) || 50, 1), 200)`), so a user with more than 200 active (or 200 archived) conversations in their own space only searches/gets meta for the newest 200 of each.
If that matters: let `Runtime.list` accept a larger cap for internal callers (e.g. an optional `q.maxLimit`, default 200, hard cap 2000) and change the default lister in `meta.ts` (`constructor`) to pass it — or assign your own function to `runtimeState(ctx).meta.lister` from `modules.ts`.

## 4. Migration order

Runtime migration **v3** is B2's (`rt_conversations.deleted_at/deleted_by`, stars, tags, search index; it also creates `rt_conversations_project` and `rt_conversations_deleted` `IF NOT EXISTS`, so B1's constructor `CREATE INDEX IF NOT EXISTS rt_conversations_project` is harmless in either order). Any further runtime migration must be **v4+**.

## 5. Data-at-rest note (search index)

`rt_search_docs` / `rt_search_fts` hold a *copy* of user and assistant turn text (user `displayText`, assistant answer text; never tool args/results, thinking, notices, credential flows) in `app.sqlite`. It is derived and fully rebuildable: `DELETE FROM rt_search_docs; DELETE FROM rt_search_progress;` (the delete trigger keeps the FTS table in sync; the next searches/ticks re-index). Backups/retention/erasure policies that cover `app.sqlite` therefore also cover message text. Soft-deleted conversations keep their index rows (filtered out at query time); a future hard-delete must delete their `rt_search_docs` rows.

## 6. Notes for U1 (web)

- `PUT …/star` → `{ ok, meta: ConversationMetaDTO, starred }`; `PUT …/tags` → `{ ok, meta, tags }` (tags come back normalised: trimmed, whitespace collapsed, de-duplicated case-insensitively, ≤ 24 chars, first 8 kept; non-array/non-string → 400 `invalid_tags`). Read-only viewers get 403 on tags and on delete; deleted/unknown conversations 404.
- `DELETE …/:id` → `{ ok: true, wasRunning }` (a running conversation is aborted first, background work included). Allowed for the creator (still with write access) or a space admin; otherwise 403.
- `GET …/export?format=md` → `text/markdown; charset=utf-8`, `Content-Disposition: attachment; filename="conversation-<id>.md"; filename*=UTF-8''<title>.md`; `x-export-truncated: 1` when cut (≤ 20 000 entries / ≈ 2 MB). Other formats → 400 `unsupported_format`.
- `GET /search` extras (additive): `partial: true` when some visible conversations were not fully indexed within the time budget (title/tag/project matching is always complete; re-run to catch up). Empty `q` returns the most recently updated visible conversations with `matchedIn: []`; a 1-character `q` matches title/tag *prefixes* only; ≥ 2 characters search title, tag, project name and message text (all terms must match; messages: within one turn). `limit` default 20, max 50. Results: title hits first, then tag, project, message; then newest.
- `GET /search/preview/:spaceId/:conversationId?entryId=` → `{ title, turns[≤6] }` around the hit (the hit turn plus up to 2 before); without `entryId` the latest 6 turns. 403 without read access, 404 when deleted.

## 7. Knobs (env)

`WORKROOM_SEARCH_BUDGET_MS` (600: time a search spends indexing before querying), `WORKROOM_SEARCH_BUDGET_ENTRIES` (4000), `WORKROOM_SEARCH_RECHECK_MS` (1500: a conversation verified up to date is not re-checked for this long), `WORKROOM_SEARCH_INDEX_MS` (30000: background indexer period, 0 = off).
