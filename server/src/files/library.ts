// Round 14: the library of DELIVERED outputs. Generating a file and delivering it are two acts: only `present_file` (or a person's explicit
// action) puts a file here. One row per (space, conversation folder, normalized name) is the CURRENT file: delivering the same name again in
// the same conversation overwrites its content and keeps the fileId, the card and the download link stable. No versions are offered: the bytes
// live in the content-addressed blob store through the file service (which keeps internal revisions as an implementation detail only).
//
// Consistency: the item, the call receipt and the change event are written in ONE app-database transaction. A replayed tool call finds its
// receipt and returns the same result (no second save, no second card); a call that crashed after saving but before its receipt is made
// idempotent by the file service's idempotency key; an OLDER call replayed after a newer delivery never moves the item back (monotonic
// internal revision number). The pi-durable side only needs the tool result, which a replay reconstructs from the receipt.
import type { AppContext, Principal, Space } from "../core/contracts.ts";
import type { Migration } from "../core/db.ts";
import { HttpError, nowIso } from "../core/http.ts";
import type { LibItemDTO } from "../../../shared/files.ts";
import { effectiveMime } from "./mime.ts";
import type { Files } from "./service.ts";

export const LIBRARY_MIGRATIONS: Migration[] = [
	{
		version: 3,
		name: "library: delivered outputs (current file per conversation folder), receipts, events",
		sql: `
CREATE TABLE lib_folders (
  org_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  folder TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (space_id, conversation_id)
);
CREATE UNIQUE INDEX lib_folders_name ON lib_folders(org_id, folder);
CREATE TABLE lib_items (
  file_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT,
  conversation_id INTEGER NOT NULL,
  folder TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  version_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  description TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  presented_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  removed_at TEXT,
  removed_by TEXT
);
CREATE UNIQUE INDEX lib_items_active ON lib_items(space_id, conversation_id, name_key) WHERE status = 'active';
CREATE INDEX lib_items_conv ON lib_items(space_id, conversation_id, updated_at);
CREATE TABLE lib_receipts (
  call_key TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE lib_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  file_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX lib_events_conv ON lib_events(space_id, conversation_id, id);
`,
	},
];

export interface LibRow {
	file_id: string;
	org_id: string;
	space_id: string;
	project_id: string | null;
	conversation_id: number;
	folder: string;
	name: string;
	name_key: string;
	mime: string;
	size: number;
	sha256: string;
	version_id: string;
	rev: number;
	description: string | null;
	source: string | null;
	status: "active" | "removed";
	presented_by: string;
	created_at: string;
	updated_at: string;
	removed_at: string | null;
	removed_by: string | null;
}

export type PresentStatus = "created" | "updated" | "unchanged";
export interface PresentResult {
	readonly status: PresentStatus;
	readonly item: LibItemDTO;
	/** An older call replayed after a newer delivery: nothing changed, the current item is returned. */
	readonly superseded?: boolean;
}

/** Normalized comparison key of a delivered name (case and Unicode form insensitive). */
export const nameKey = (name: string): string => name.normalize("NFC").trim().toLowerCase();

/** Folder name of a conversation's outputs: "<title>--c<id>", fixed at the first delivery (later renames do not move it). */
export function folderName(title: string, conversationId: number): string {
	const t = (title || "对话")
		.normalize("NFC")
		.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 40)
		.replace(/^\.+/, "");
	return `${t || "对话"}--c${conversationId}`;
}

export class Library {
	readonly #ctx: AppContext;
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}
	get #files(): Files {
		return this.#ctx.services.get("files") as unknown as Files;
	}
	get #db() {
		return this.#ctx.db;
	}

	row(fileId: string): LibRow | undefined {
		return this.#db.get<LibRow>("SELECT * FROM lib_items WHERE file_id = ?", fileId);
	}

	/** The conversation's folder (created on first use, then fixed). Unique within the organisation, so /library never shows two equal names. */
	folder(space: Space, conversationId: number): string {
		const got = this.#db.get<{ folder: string }>("SELECT folder FROM lib_folders WHERE space_id = ? AND conversation_id = ?", space.id, conversationId);
		if (got) return got.folder;
		const title = this.#db.get<{ title: string }>("SELECT title FROM rt_conversations WHERE space_id = ? AND conversation_id = ?", space.id, conversationId)?.title ?? "";
		let folder = folderName(title, conversationId);
		// conversation ids are per space: the same "--c12" can exist in another space of the org → disambiguate with the space
		if (this.#db.get("SELECT 1 FROM lib_folders WHERE org_id = ? AND folder = ?", space.orgId, folder)) folder = `${folder}-${space.id.slice(-6)}`;
		this.#db.run("INSERT OR IGNORE INTO lib_folders (org_id, space_id, conversation_id, folder, created_at) VALUES (?, ?, ?, ?, ?)", space.orgId, space.id, conversationId, folder, nowIso());
		return this.#db.get<{ folder: string }>("SELECT folder FROM lib_folders WHERE space_id = ? AND conversation_id = ?", space.id, conversationId)!.folder;
	}
	/** The conversation a folder belongs to (org-wide unique names). */
	byFolder(orgId: string, folder: string): { space_id: string; conversation_id: number } | undefined {
		return this.#db.get<{ space_id: string; conversation_id: number }>("SELECT space_id, conversation_id FROM lib_folders WHERE org_id = ? AND folder = ?", orgId, folder);
	}

	dto(r: LibRow): LibItemDTO {
		return {
			fileId: r.file_id,
			path: `/library/${r.folder}/${r.name}`,
			name: r.name,
			mime: r.mime,
			size: r.size,
			etag: r.sha256,
			status: r.status,
			conversationId: r.conversation_id,
			spaceId: r.space_id,
			folder: r.folder,
			...(r.description ? { description: r.description } : {}),
			updatedAt: r.updated_at,
			previewUrl: `/api/files/${r.file_id}/preview`,
			downloadUrl: `/api/files/${r.file_id}/download`,
		};
	}

	/**
	 * Deliver `bytes` as `name` into the conversation's folder. `callKey` identifies the delivering call (tool call key, or a request id for a
	 * person's action): a replay returns the recorded result.
	 */
	async present(p: Principal, input: { space: Space; conversationId: number; name: string; bytes: Uint8Array; mime?: string; description?: string; source: string; callKey: string }): Promise<PresentResult> {
		const receipt = this.#db.get<{ result: string }>("SELECT result FROM lib_receipts WHERE call_key = ?", input.callKey);
		if (receipt) return JSON.parse(receipt.result) as PresentResult;
		const key = nameKey(input.name);
		const folder = this.folder(input.space, input.conversationId);
		const existing = this.#db.get<LibRow>("SELECT * FROM lib_items WHERE space_id = ? AND conversation_id = ? AND name_key = ? AND status = 'active'", input.space.id, input.conversationId, key);
		const mime = effectiveMime(input.mime, input.name);
		// The bytes: a new internal revision of the same file (or a new file). Idempotent per call: a crash after this line replays to the same revision.
		const ref = await this.#files.putVersion(p, {
			...(existing ? { fileId: existing.file_id } : {}),
			name: input.name,
			mime,
			bytes: input.bytes,
			provenance: { origin: "agent", createdBy: p.userId, spaceId: input.space.id, conversationId: input.conversationId, tool: "present_file", changeNote: input.source.slice(0, 300) },
			idempotencyKey: `present:${input.callKey}`,
		});
		const v = this.#files.versionRow(ref.versionId)!;
		const now = nowIso();
		const result = this.#db.tx(() => {
			// re-read inside the transaction: another delivery of the same name may have committed meanwhile
			const cur = this.#db.get<LibRow>("SELECT * FROM lib_items WHERE space_id = ? AND conversation_id = ? AND name_key = ? AND status = 'active'", input.space.id, input.conversationId, key);
			let status: PresentStatus;
			let superseded = false;
			if (!cur) {
				this.#db.run(
					"INSERT INTO lib_items (file_id, org_id, space_id, project_id, conversation_id, folder, name, name_key, mime, size, sha256, version_id, rev, description, source, status, presented_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)",
					ref.fileId, input.space.orgId, input.space.id, input.space.projectId ?? null, input.conversationId, folder, input.name, key, mime, v.size, v.sha256, v.id, v.version_no, input.description ?? null, input.source, p.userId, now, now,
				);
				status = "created";
			} else if (cur.file_id !== ref.fileId || v.version_no < cur.rev) {
				// an older call replayed after a newer delivery (or a stray revision): never move the current file backwards
				status = "unchanged";
				superseded = true;
			} else if (cur.sha256 === v.sha256 && cur.name === input.name) {
				status = "unchanged";
				if (v.version_no > cur.rev) this.#db.run("UPDATE lib_items SET version_id = ?, rev = ? WHERE file_id = ?", v.id, v.version_no, cur.file_id);
			} else {
				this.#db.run("UPDATE lib_items SET name = ?, mime = ?, size = ?, sha256 = ?, version_id = ?, rev = ?, description = COALESCE(?, description), source = ?, presented_by = ?, updated_at = ? WHERE file_id = ?", input.name, mime, v.size, v.sha256, v.id, v.version_no, input.description ?? null, input.source, p.userId, now, cur.file_id);
				status = "updated";
			}
			const row = this.#db.get<LibRow>("SELECT * FROM lib_items WHERE file_id = ?", cur && superseded ? cur.file_id : ref.fileId)!;
			const out: PresentResult = { status, item: this.dto(row), ...(superseded ? { superseded } : {}) };
			this.#db.run("INSERT INTO lib_receipts (call_key, file_id, result, created_at) VALUES (?, ?, ?, ?)", input.callKey, row.file_id, JSON.stringify(out), now);
			if (status !== "unchanged") this.#db.run("INSERT INTO lib_events (space_id, conversation_id, file_id, kind, at) VALUES (?, ?, ?, ?, ?)", input.space.id, input.conversationId, row.file_id, `file.${status === "created" ? "presented" : "updated"}`, now);
			// the library file mirrors the current name (the file service's own row)
			this.#db.run("UPDATE file_files SET name = ?, updated_at = ? WHERE id = ?", row.name, now, row.file_id);
			return out;
		});
		this.#notify(input.space.id, input.conversationId);
		return result;
	}

	/** Withdraw a delivered output: the library entry and its card turn "removed", downloads stop (the file service row is soft-deleted). */
	async remove(p: Principal, fileId: string): Promise<LibItemDTO> {
		const r = this.row(fileId);
		if (!r || r.status !== "active") throw new HttpError(404, "not_found", "成果不存在或已删除");
		await this.#files.requireFile(p, "write", fileId);
		const now = nowIso();
		this.#db.tx(() => {
			this.#db.run("UPDATE lib_items SET status = 'removed', removed_at = ?, removed_by = ? WHERE file_id = ?", now, p.userId, fileId);
			this.#db.run("UPDATE file_files SET deleted_at = ? WHERE id = ?", now, fileId);
			this.#db.run("INSERT INTO lib_events (space_id, conversation_id, file_id, kind, at) VALUES (?, ?, ?, 'file.removed', ?)", r.space_id, r.conversation_id, fileId, now);
		});
		if (this.#ctx.services.has("knowledgeAdmin")) Promise.resolve((this.#ctx.services.get("knowledgeAdmin") as any).fileDeleted?.(fileId)).catch(() => {});
		this.#notify(r.space_id, r.conversation_id);
		return this.dto(this.row(fileId)!);
	}

	/** Outputs of one conversation (active and removed: removed ones let old cards show 已删除). Caller has already checked access. */
	ofConversation(spaceId: string, conversationId: number): LibItemDTO[] {
		return this.#db.all<LibRow>("SELECT * FROM lib_items WHERE space_id = ? AND conversation_id = ? ORDER BY created_at, file_id", spaceId, conversationId).map((r) => this.dto(r));
	}

	/** Active outputs the principal may read, grouped by conversation folder (newest first). ACL: the file service's own decision per file. */
	async listFor(p: Principal, opts: { spaceId?: string; conversationId?: number; limit?: number } = {}): Promise<LibItemDTO[]> {
		const where = ["status = 'active'", "org_id = ?"];
		const args: (string | number)[] = [p.orgId];
		if (opts.spaceId) (where.push("space_id = ?"), args.push(opts.spaceId));
		if (opts.conversationId !== undefined) (where.push("conversation_id = ?"), args.push(opts.conversationId));
		const rows = this.#db.all<LibRow>(`SELECT * FROM lib_items WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`, ...args, Math.min(opts.limit ?? 500, 2000));
		const out: LibItemDTO[] = [];
		for (const r of rows) if ((await this.#files.decide(p, "read", r.file_id)).allow) out.push(this.dto(r));
		return out;
	}

	#notify(spaceId: string, conversationId: number): void {
		const rt = this.#ctx.services.has("runtime") ? (this.#ctx.services.get("runtime") as { notifyConversation?: (s: string, c: number) => void }) : undefined;
		rt?.notifyConversation?.(spaceId, conversationId);
	}
}
