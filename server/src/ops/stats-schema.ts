// Stats group migrations. Versions start at 100 so they never collide with E's / the models group's sequence in OPS_MIGRATIONS.
export const STATS_MIGRATIONS = [
	{
		version: 100,
		name: "stats: demo org flag and demo-marked ledger rows",
		sql: `
CREATE TABLE ops_demo_orgs (org_id TEXT PRIMARY KEY, label TEXT NOT NULL, created_at TEXT NOT NULL);
ALTER TABLE usage_ledger ADD COLUMN demo INTEGER NOT NULL DEFAULT 0;
CREATE INDEX usage_ledger_org_kind_at ON usage_ledger(org_id, kind, at);
`,
	},
];
