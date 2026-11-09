# Requests from group E (organization / ops)

## To C (knowledge) — test stability
- `KnowledgePipeline.start()` → `kick()` schedules `#drain` with `setImmediate`. If the app stops before that immediate fires
  (fast tests), `#drain`'s `finally` calls `this.#runnable()` after `db.close()` → unhandled `ERR_INVALID_STATE: database is not open`,
  which fails *any* test using `startTestApp()` that disposes quickly. Fix: in `#drain` return early when `#stopped`
  (skip the DB reads in `finally`). Workaround in E tests: short settle delay before dispose.
