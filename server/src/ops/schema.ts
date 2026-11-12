// Ops tables (prefixes ops_, usage_, auto_). usage_* are projections of pi-durable facts (rebuildable).
export const OPS_MIGRATIONS = [
	{
		version: 1,
		name: "gateway, route attempts, usage ledger, budgets, automation, notifications",
		sql: `
CREATE TABLE ops_channels (
  id TEXT PRIMARY KEY, org_id TEXT, name TEXT NOT NULL, provider TEXT NOT NULL, base_url TEXT,
  api_key_enc TEXT, api_key_env TEXT, key_hint TEXT, status TEXT NOT NULL DEFAULT 'enabled',
  rpm_limit INTEGER, concurrency_limit INTEGER, timeout_ms INTEGER, price TEXT, builtin INTEGER NOT NULL DEFAULT 0,
  created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE ops_platform_models (
  id TEXT PRIMARY KEY, org_id TEXT, label TEXT NOT NULL, description TEXT, kind TEXT NOT NULL DEFAULT 'real',
  pi_provider TEXT NOT NULL DEFAULT 'workroom', capabilities TEXT NOT NULL, thinking_levels TEXT NOT NULL,
  default_thinking TEXT, context_window INTEGER, max_tokens INTEGER, visibility TEXT,
  is_default INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
  builtin INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE ops_model_routes (
  id TEXT PRIMARY KEY, platform_model_id TEXT NOT NULL REFERENCES ops_platform_models(id), channel_id TEXT NOT NULL REFERENCES ops_channels(id),
  upstream_model_id TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, weight INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1, capabilities TEXT, created_at TEXT NOT NULL
);
CREATE INDEX ops_model_routes_pm ON ops_model_routes(platform_model_id);
CREATE TABLE ops_route_attempts (
  id TEXT PRIMARY KEY, request_key TEXT NOT NULL, attempt_no INTEGER NOT NULL, platform_model_id TEXT NOT NULL, pi_provider TEXT NOT NULL,
  channel_id TEXT, channel_provider TEXT, upstream_model TEXT, status TEXT NOT NULL, error_class TEXT, error_message TEXT,
  retryable INTEGER, failover INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER, first_token_ms INTEGER,
  input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER, cache_write INTEGER, cost_total REAL, cost_source TEXT,
  stop_reason TEXT, fixture INTEGER NOT NULL DEFAULT 0, session_id TEXT, space_id TEXT, org_id TEXT, conversation_id INTEGER, task_id INTEGER,
  started_at TEXT NOT NULL, ended_at TEXT
);
CREATE INDEX ops_route_attempts_req ON ops_route_attempts(request_key);
CREATE INDEX ops_route_attempts_conv ON ops_route_attempts(space_id, conversation_id);
CREATE INDEX ops_route_attempts_session ON ops_route_attempts(session_id);
CREATE INDEX ops_route_attempts_org ON ops_route_attempts(org_id, started_at);

CREATE TABLE usage_ledger (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, space_id TEXT NOT NULL, org_id TEXT NOT NULL, project_id TEXT, user_id TEXT, department_ids TEXT,
  conversation_id INTEGER NOT NULL, entry_id INTEGER NOT NULL, sub_key TEXT NOT NULL DEFAULT '', task_id INTEGER,
  outcome TEXT NOT NULL, platform_model_id TEXT, pi_provider TEXT, route TEXT, tool_name TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, cost_from_provider INTEGER NOT NULL DEFAULT 0,
  fixture INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER, error_class TEXT, error_message TEXT, automation_id TEXT,
  at TEXT NOT NULL, imported_at TEXT NOT NULL,
  UNIQUE (space_id, kind, entry_id, sub_key)
);
CREATE INDEX usage_ledger_org_at ON usage_ledger(org_id, at);
CREATE INDEX usage_ledger_user ON usage_ledger(org_id, user_id, at);
CREATE INDEX usage_ledger_project ON usage_ledger(project_id, at);
CREATE INDEX usage_ledger_conv ON usage_ledger(space_id, conversation_id);
CREATE TABLE usage_import_state (space_id TEXT NOT NULL, conversation_id INTEGER NOT NULL, dirty INTEGER NOT NULL DEFAULT 0, imported_at TEXT, usage_check TEXT, PRIMARY KEY (space_id, conversation_id));
CREATE TABLE usage_budgets (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, period TEXT NOT NULL,
  limit_cost REAL, limit_tokens INTEGER, action TEXT NOT NULL DEFAULT 'block', enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX usage_budgets_org ON usage_budgets(org_id);
CREATE TABLE usage_time_savings (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, project_id TEXT, space_id TEXT, conversation_id INTEGER,
  minutes REAL NOT NULL, note TEXT, created_at TEXT NOT NULL
);
CREATE TABLE ops_settings (org_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (org_id, key));

CREATE TABLE auto_automations (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, space_id TEXT NOT NULL, project_id TEXT,
  name TEXT NOT NULL, prompt TEXT NOT NULL, assistant_id TEXT, model_id TEXT, trigger TEXT NOT NULL, timezone TEXT NOT NULL,
  condition TEXT NOT NULL, destination TEXT NOT NULL, max_concurrent INTEGER NOT NULL DEFAULT 1, missed_policy TEXT NOT NULL DEFAULT 'skip',
  max_duration_ms INTEGER NOT NULL DEFAULT 1800000, enabled INTEGER NOT NULL DEFAULT 1, webhook_token_hash TEXT, reuse_conversation_id INTEGER,
  next_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX auto_automations_due ON auto_automations(enabled, next_run_at);
CREATE UNIQUE INDEX auto_automations_webhook ON auto_automations(webhook_token_hash) WHERE webhook_token_hash IS NOT NULL;
CREATE TABLE auto_runs (
  id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, org_id TEXT NOT NULL, scheduled_for TEXT NOT NULL, trigger TEXT NOT NULL,
  status TEXT NOT NULL, reason TEXT, error TEXT, space_id TEXT, conversation_id INTEGER, submission_id INTEGER, request_id TEXT NOT NULL,
  rerun_of TEXT, started_at TEXT, ended_at TEXT, created_at TEXT NOT NULL,
  UNIQUE (automation_id, scheduled_for)
);
CREATE INDEX auto_runs_status ON auto_runs(status);

CREATE TABLE ops_notifications (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  link TEXT, status TEXT, refs TEXT NOT NULL DEFAULT '[]', run_id TEXT, created_at TEXT NOT NULL, read_at TEXT
);
CREATE INDEX ops_notifications_user ON ops_notifications(org_id, user_id, created_at);
CREATE TABLE ops_notify_channels (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, target TEXT NOT NULL,
  secret_enc TEXT, shared INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE ops_notify_deliveries (
  id TEXT PRIMARY KEY, notification_id TEXT NOT NULL, channel_id TEXT NOT NULL, run_id TEXT, org_id TEXT NOT NULL, status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0, http_status INTEGER, error TEXT, created_at TEXT NOT NULL, delivered_at TEXT
);
CREATE INDEX ops_notify_deliveries_run ON ops_notify_deliveries(run_id);
`,
	},
	{
		version: 2,
		name: "model providers (pi-ai native): providers, per-model entries, dynamic catalogs, legacy aliases",
		sql: `
CREATE TABLE model_providers (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, org_id TEXT, owner_user_id TEXT, name TEXT NOT NULL, type TEXT NOT NULL, builtin_id TEXT, preset TEXT,
  base_url TEXT, api_key_enc TEXT, api_key_env TEXT, key_hint TEXT, headers_enc TEXT, env_enc TEXT, keyless INTEGER NOT NULL DEFAULT 0,
  auth_style TEXT NOT NULL DEFAULT 'default', timeout_ms INTEGER, status TEXT NOT NULL DEFAULT 'enabled', source TEXT NOT NULL DEFAULT 'admin',
  last_check TEXT, last_fetch_at TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX model_providers_org ON model_providers(org_id, scope);
CREATE INDEX model_providers_owner ON model_providers(owner_user_id);
CREATE TABLE model_entries (
  provider_id TEXT NOT NULL REFERENCES model_providers(id) ON DELETE CASCADE, model_id TEXT NOT NULL, manual INTEGER NOT NULL DEFAULT 0, spec TEXT,
  enabled INTEGER NOT NULL DEFAULT 0, visibility TEXT, fallbacks TEXT, default_thinking TEXT, sort INTEGER NOT NULL DEFAULT 0, description TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (provider_id, model_id)
);
CREATE TABLE model_catalog (provider_id TEXT PRIMARY KEY, entry TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE model_aliases (alias_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model_id TEXT NOT NULL, label TEXT, org_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE model_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
`,
	},
	{
		version: 3,
		name: "model providers: local rpm / concurrency limits (provider + model) and circuit breaker settings",
		sql: `
ALTER TABLE model_providers ADD COLUMN rpm_limit INTEGER;
ALTER TABLE model_providers ADD COLUMN concurrency_limit INTEGER;
ALTER TABLE model_providers ADD COLUMN breaker_threshold INTEGER;
ALTER TABLE model_providers ADD COLUMN breaker_window_ms INTEGER;
ALTER TABLE model_entries ADD COLUMN rpm_limit INTEGER;
ALTER TABLE model_entries ADD COLUMN concurrency_limit INTEGER;
`,
	},
	{
		version: 4,
		name: "harness inspector: captured model requests (per round) and per-run harness build summaries",
		sql: `
CREATE TABLE ops_harness_rounds (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, space_id TEXT NOT NULL, conversation_id INTEGER NOT NULL, task_id INTEGER, run_key TEXT NOT NULL,
  round_index INTEGER NOT NULL, request_key TEXT, user_id TEXT, started_at INTEGER NOT NULL, duration_ms INTEGER,
  provider TEXT NOT NULL, model_id TEXT NOT NULL, served_by TEXT, thinking_level TEXT, stop_reason TEXT, error TEXT, usage TEXT, message_ts INTEGER,
  message_count INTEGER NOT NULL, tool_count INTEGER NOT NULL, system_chars INTEGER NOT NULL, size_bytes INTEGER NOT NULL, truncated INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX ops_harness_rounds_conv ON ops_harness_rounds(space_id, conversation_id, started_at);
CREATE INDEX ops_harness_rounds_run ON ops_harness_rounds(space_id, conversation_id, run_key, round_index);
CREATE INDEX ops_harness_rounds_org ON ops_harness_rounds(org_id, created_at);
CREATE TABLE ops_harness_builds (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, space_id TEXT NOT NULL, conversation_id INTEGER NOT NULL, task_id INTEGER, run_key TEXT NOT NULL,
  build TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (space_id, conversation_id, run_key)
);
CREATE INDEX ops_harness_builds_org ON ops_harness_builds(org_id, created_at);
`,
	},
];
