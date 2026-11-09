// Knowledge + memory tables (prefixes kb_, mem_). Owner: group C.
import type { Migration } from "../core/db.ts";

export const KNOWLEDGE_MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		name: "knowledge bases, docs, versions, chunks, fts, jobs, memory",
		sql: `
CREATE TABLE kb_bases (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	scope TEXT NOT NULL CHECK (scope IN ('personal','project','department','org')),
	owner_user_id TEXT NOT NULL,
	project_id TEXT,
	department_id TEXT,
	created_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT
);
CREATE INDEX kb_bases_org ON kb_bases(org_id, scope);
CREATE INDEX kb_bases_project ON kb_bases(project_id);

CREATE TABLE kb_maintainers (
	kb_id TEXT NOT NULL REFERENCES kb_bases(id),
	user_id TEXT NOT NULL,
	added_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (kb_id, user_id)
);

-- Logical document = one file inside one KB. Versions below.
CREATE TABLE kb_docs (
	id TEXT PRIMARY KEY,
	kb_id TEXT NOT NULL REFERENCES kb_bases(id),
	file_id TEXT NOT NULL,
	file_name TEXT NOT NULL,
	serving_version_id TEXT,          -- kb_doc_versions.id currently used by retrieval
	latest_version_id TEXT NOT NULL,  -- newest kb_doc_versions.id added
	follow_latest INTEGER NOT NULL DEFAULT 1,
	added_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT,
	deleted_reason TEXT,
	-- governance (M07-B)
	doc_kind TEXT NOT NULL DEFAULT 'reference' CHECK (doc_kind IN ('reference','policy','template')),
	gov_status TEXT NOT NULL DEFAULT 'effective' CHECK (gov_status IN ('draft','effective','expired','withdrawn')),
	responsible_user_id TEXT,
	version_label TEXT,
	effective_from TEXT,
	expires_at TEXT,
	replaced_by_doc_id TEXT,
	gov_updated_at TEXT NOT NULL,
	gov_updated_by TEXT
);
CREATE INDEX kb_docs_kb ON kb_docs(kb_id, deleted_at);
CREATE INDEX kb_docs_file ON kb_docs(file_id);

CREATE TABLE kb_doc_versions (
	id TEXT PRIMARY KEY,
	doc_id TEXT NOT NULL REFERENCES kb_docs(id),
	kb_id TEXT NOT NULL,
	file_id TEXT NOT NULL,
	version_id TEXT NOT NULL,
	version_no INTEGER NOT NULL,
	file_name TEXT NOT NULL,
	mime TEXT NOT NULL,
	size INTEGER NOT NULL,
	sha256 TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('queued','parsing','indexing','ready','failed')),
	error TEXT,
	error_code TEXT,
	retryable INTEGER,
	attempts INTEGER NOT NULL DEFAULT 0,
	chunk_count INTEGER NOT NULL DEFAULT 0,
	page_count INTEGER,
	added_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	superseded_at TEXT,
	UNIQUE (doc_id, version_id)
);
CREATE INDEX kb_doc_versions_doc ON kb_doc_versions(doc_id, version_no);

-- Chunk rows are never hard-deleted: tombstoned rows keep citation snapshots resolvable (status endpoint).
CREATE TABLE kb_chunks (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	kb_id TEXT NOT NULL,
	doc_id TEXT NOT NULL,
	doc_version_id TEXT NOT NULL,
	file_id TEXT NOT NULL,
	version_id TEXT NOT NULL,
	version_no INTEGER NOT NULL,
	file_name TEXT NOT NULL,
	ordinal INTEGER NOT NULL,
	page INTEGER,
	section TEXT,
	paragraph INTEGER,
	sheet TEXT,
	row_start INTEGER,
	row_end INTEGER,
	text TEXT NOT NULL,
	created_at TEXT NOT NULL,
	tombstoned_at TEXT,
	tombstone_reason TEXT
);
CREATE INDEX kb_chunks_doc_version ON kb_chunks(doc_version_id);
CREATE INDEX kb_chunks_live ON kb_chunks(kb_id, tombstoned_at);

-- Full-text index of LIVE chunks only (rowid = kb_chunks.seq). Trigram tokenizer: substring search incl. CJK.
CREATE VIRTUAL TABLE kb_fts USING fts5(text, tokenize = 'trigram');

-- Durable processing jobs (survive restarts; resumed on start()).
CREATE TABLE kb_jobs (
	id TEXT PRIMARY KEY,
	doc_version_id TEXT NOT NULL REFERENCES kb_doc_versions(id),
	state TEXT NOT NULL CHECK (state IN ('pending','running','done','failed','cancelled')),
	attempt INTEGER NOT NULL DEFAULT 0,
	run_after TEXT NOT NULL,
	last_error TEXT,
	owner_instance TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX kb_jobs_state ON kb_jobs(state, run_after);

-- Monotonic generation counter: bumped by every change that affects retrieval results (cache key component).
CREATE TABLE kb_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO kb_meta (key, value) VALUES ('generation', 0);

-- Memory (M10).
CREATE TABLE mem_items (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL,
	scope TEXT NOT NULL CHECK (scope IN ('private','project','org')),
	owner_user_id TEXT,        -- private: the owner
	project_id TEXT,           -- project: the project
	kind TEXT NOT NULL DEFAULT 'fact' CHECK (kind IN ('preference','fact','constraint','background')),
	content TEXT NOT NULL,
	source TEXT NOT NULL CHECK (source IN ('user','extracted','corrected')),
	source_ref TEXT,           -- JSON {spaceId, conversationId, callId?, taskId?, entryId?}
	corrects_id TEXT,
	status TEXT NOT NULL CHECK (status IN ('active','superseded','deleted')),
	superseded_by_id TEXT,
	version INTEGER NOT NULL DEFAULT 1,
	created_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_by TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX mem_items_scope ON mem_items(org_id, scope, status);
CREATE INDEX mem_items_owner ON mem_items(owner_user_id, status);
CREATE INDEX mem_items_project ON mem_items(project_id, status);

CREATE TABLE mem_revisions (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	memory_id TEXT NOT NULL,
	version INTEGER NOT NULL,
	change TEXT NOT NULL,
	content TEXT NOT NULL,
	note TEXT,
	by_user_id TEXT NOT NULL,
	at TEXT NOT NULL
);
CREATE INDEX mem_revisions_memory ON mem_revisions(memory_id, seq);
`,
	},
	{
		version: 2,
		name: "ocr provenance",
		sql: `
ALTER TABLE kb_chunks ADD COLUMN ocr INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kb_doc_versions ADD COLUMN ocr_pages INTEGER;
`,
	},
];
