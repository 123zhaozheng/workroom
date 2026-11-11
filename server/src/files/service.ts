// File library: files with immutable versions (content-addressed blobs) and provenance.
// ACL: a file belongs to exactly one space; access is evaluated against the space on every call (current membership).
import type { AccessControl, AppContext, Decision, FileProvenance, FileService, FileVersionRef, IdentityService, Principal, Space } from "../core/contracts.ts";
import type { Migration } from "../core/db.ts";
import { HttpError, newId, nowIso } from "../core/http.ts";
import { guessMime, normalizeMime, previewKindOf } from "./mime.ts";
import type { FileDTO, FileVersionDTO, FileProvenanceDTO, FileOrigin } from "../../../shared/files.ts";

export const FILE_MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "files and immutable versions",
		sql: `
CREATE TABLE file_files (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT,
  name TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  latest_version_id TEXT,
  latest_version_no INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE INDEX file_files_space ON file_files(space_id, updated_at);
CREATE TABLE file_versions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES file_files(id),
  version_no INTEGER NOT NULL,
  space_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  origin TEXT NOT NULL,
  change_note TEXT,
  conversation_id INTEGER,
  task_id INTEGER,
  call_id TEXT,
  submission_id INTEGER,
  tool TEXT,
  idempotency_key TEXT,
  provenance TEXT NOT NULL,
  UNIQUE (file_id, version_no),
  UNIQUE (space_id, idempotency_key)
);
CREATE INDEX file_versions_conv ON file_versions(space_id, conversation_id);
CREATE INDEX file_versions_sha ON file_versions(sha256);
CREATE TRIGGER file_versions_no_update BEFORE UPDATE ON file_versions BEGIN SELECT RAISE(ABORT, 'file versions are immutable'); END;
CREATE TRIGGER file_versions_no_delete BEFORE DELETE ON file_versions BEGIN SELECT RAISE(ABORT, 'file versions are immutable'); END;
`,
	},
];

export interface FileRow {
	id: string;
	org_id: string;
	space_id: string;
	project_id: string | null;
	name: string;
	origin: string;
	created_by: string;
	created_at: string;
	updated_at: string;
	latest_version_id: string | null;
	latest_version_no: number;
	deleted_at: string | null;
}
export interface VersionRow {
	id: string;
	file_id: string;
	version_no: number;
	space_id: string;
	name: string;
	mime: string;
	size: number;
	sha256: string;
	created_by: string;
	created_at: string;
	origin: string;
	change_note: string | null;
	conversation_id: number | null;
	task_id: number | null;
	call_id: string | null;
	submission_id: number | null;
	tool: string | null;
	idempotency_key: string | null;
	provenance: string;
}

/** Extended provenance accepted by the files module (adds the producing tool). */
export type FileProvenanceInput = FileProvenance & { readonly tool?: string };

const MAX_NAME = 200;
export function cleanFileName(name: string): string {
	const n = String(name ?? "")
		.replace(/[\\/\u0000-\u001f\u007f]/g, "_")
		.replace(/^\.+/, "")
		.trim()
		.slice(0, MAX_NAME);
	if (!n) throw new HttpError(400, "invalid_name", "文件名无效");
	return n;
}

export class Files implements FileService {
	readonly #ctx: AppContext;
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}
	get #identity(): IdentityService {
		return this.#ctx.services.get("identity");
	}
	get #acl(): AccessControl {
		return this.#ctx.services.get("acl");
	}

	fileRow(fileId: string): FileRow | undefined {
		return this.#ctx.db.get<FileRow>("SELECT * FROM file_files WHERE id = ? AND deleted_at IS NULL", fileId);
	}
	versionRow(versionId: string): VersionRow | undefined {
		return this.#ctx.db.get<VersionRow>("SELECT * FROM file_versions WHERE id = ?", versionId);
	}
	versionRows(fileId: string): VersionRow[] {
		return this.#ctx.db.all<VersionRow>("SELECT * FROM file_versions WHERE file_id = ? ORDER BY version_no DESC", fileId);
	}

	/** ACL resolver for ResourceRef kind "file" (registered with identity). */
	async decide(p: Principal, action: string, fileId: string): Promise<Decision> {
		const f = this.fileRow(fileId);
		if (!f) return { allow: false, reason: "not_found" };
		const spaceAction = action === "delete" ? "write" : action === "share" ? "admin" : (action as "read" | "write" | "admin" | "use");
		const d = await this.#acl.check(p, spaceAction, { kind: "space", id: f.space_id });
		if (d.allow || action !== "read") return d;
		// Round 9: READ (only) of a deliverable produced in a conversation the caller may read through a project share. Everything else stays space-level.
		const convs = this.#ctx.db.all<{ conversation_id: number }>("SELECT DISTINCT conversation_id FROM file_versions WHERE file_id = ? AND space_id = ? AND conversation_id IS NOT NULL LIMIT 50", fileId, f.space_id);
		for (const c of convs) {
			const cd = await this.#acl.check(p, "read", { kind: "conversation", id: String(c.conversation_id), spaceId: f.space_id });
			if (cd.allow) return { allow: true, reason: cd.reason === "project_share" ? "project_share" : cd.reason };
		}
		return d;
	}

	async requireFile(p: Principal, action: "read" | "write", fileId: string): Promise<FileRow> {
		const f = this.fileRow(fileId);
		if (!f) throw new HttpError(404, "file_not_found", "文件不存在");
		await this.#acl.require(p, action, { kind: "file", id: fileId });
		return f;
	}

	/** Resolve the target space for an upload/agent write: explicit space, project, or the caller's personal space. */
	resolveSpace(p: Principal, opts: { spaceId?: string | null; projectId?: string | null }): Space {
		let space: Space | null;
		if (opts.spaceId) space = this.#identity.space(opts.spaceId);
		else if (opts.projectId) space = this.#identity.projectSpace(opts.projectId);
		else space = this.#identity.personalSpace(p.userId, p.orgId);
		if (!space) throw new HttpError(404, "space_not_found", "空间不存在");
		return space;
	}

	refOf(v: VersionRow): FileVersionRef {
		return { fileId: v.file_id, versionId: v.id, versionNo: v.version_no, name: v.name, mime: v.mime, size: v.size, sha256: v.sha256 };
	}
	provenanceOf(v: VersionRow): FileProvenanceInput {
		return JSON.parse(v.provenance) as FileProvenanceInput;
	}

	async putVersion(principal: Principal, input: { fileId?: string; name: string; mime: string; bytes: Uint8Array; provenance: FileProvenanceInput; idempotencyKey?: string }): Promise<FileVersionRef> {
		const name = cleanFileName(input.name);
		const mime = normalizeMime(input.mime) || guessMime(name);
		let file: FileRow | undefined;
		let space: Space;
		if (input.fileId) {
			file = await this.requireFile(principal, "write", input.fileId);
			const s = this.#identity.space(file.space_id);
			if (!s) throw new HttpError(404, "space_not_found", "空间不存在");
			space = s;
		} else {
			space = this.resolveSpace(principal, { spaceId: input.provenance.spaceId });
			await this.#acl.require(principal, "write", { kind: "space", id: space.id });
		}
		if (input.provenance.spaceId && input.provenance.spaceId !== space.id) throw new HttpError(400, "space_mismatch", "来源空间与文件所在空间不一致");
		const key = input.idempotencyKey?.trim() || null;
		if (key) {
			const existing = this.#ctx.db.get<VersionRow>("SELECT * FROM file_versions WHERE space_id = ? AND idempotency_key = ?", space.id, key);
			if (existing) {
				if (input.fileId && existing.file_id !== input.fileId) throw new HttpError(409, "idempotency_conflict", "幂等键已用于其他文件");
				return this.refOf(existing);
			}
		}
		const { sha256, size } = this.#ctx.blobs.put(input.bytes);
		const provenance: FileProvenanceInput = {
			...input.provenance,
			createdBy: principal.userId,
			spaceId: space.id,
			projectId: space.projectId,
			changeNote: input.provenance.changeNote?.slice(0, 2000) || undefined,
		};
		const now = nowIso();
		const versionId = newId("fv");
		try {
			this.#ctx.db.tx(() => {
				let fileId = file?.id;
				let versionNo = 1;
				if (!fileId) {
					fileId = newId("file");
					this.#ctx.db.run(
						"INSERT INTO file_files (id, org_id, space_id, project_id, name, origin, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
						fileId, space.orgId, space.id, space.projectId ?? null, name, provenance.origin, principal.userId, now, now,
					);
				} else {
					const cur = this.#ctx.db.get<{ latest_version_no: number }>("SELECT latest_version_no FROM file_files WHERE id = ?", fileId)!;
					versionNo = cur.latest_version_no + 1;
				}
				this.#ctx.db.run(
					`INSERT INTO file_versions (id, file_id, version_no, space_id, name, mime, size, sha256, created_by, created_at, origin, change_note,
					 conversation_id, task_id, call_id, submission_id, tool, idempotency_key, provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					versionId, fileId, versionNo, space.id, name, mime, size, sha256, principal.userId, now, provenance.origin, provenance.changeNote ?? null,
					provenance.conversationId ?? null, provenance.taskId ?? null, provenance.callId ?? null, provenance.submissionId ?? null, provenance.tool ?? null, key,
					JSON.stringify(provenance),
				);
				this.#ctx.db.run("UPDATE file_files SET latest_version_id = ?, latest_version_no = ?, name = ?, updated_at = ? WHERE id = ?", versionId, versionNo, name, now, fileId);
			});
		} catch (e: any) {
			// Lost a race on the idempotency key: return the winner.
			if (key && /UNIQUE/.test(String(e?.message))) {
				const existing = this.#ctx.db.get<VersionRow>("SELECT * FROM file_versions WHERE space_id = ? AND idempotency_key = ?", space.id, key);
				if (existing) return this.refOf(existing);
			}
			throw e;
		}
		const ref = this.refOf(this.versionRow(versionId)!);
		this.#notifyKnowledge(ref, principal);
		return ref;
	}

	/** C re-indexes KB docs that follow this file (M06-C); failures never fail the write. */
	#notifyKnowledge(ref: FileVersionRef, principal: Principal): void {
		if (!this.#ctx.services.has("knowledgeAdmin")) return;
		const k = this.#ctx.services.get("knowledgeAdmin") as { fileVersionAdded?: (fileId: string, ref: FileVersionRef, p: Principal) => unknown };
		Promise.resolve()
			.then(() => k.fileVersionAdded?.(ref.fileId, ref, principal))
			.catch((e: unknown) => console.error("[files] knowledge notification failed", e));
	}

	async getVersion(principal: Principal, versionId: string): Promise<{ ref: FileVersionRef; bytes: Uint8Array; provenance: FileProvenance } | null> {
		const v = this.versionRow(versionId);
		if (!v) return null;
		const d = await this.decide(principal, "read", v.file_id);
		if (!d.allow) return null;
		const bytes = this.#ctx.blobs.get(v.sha256);
		if (!bytes) throw new HttpError(500, "blob_missing", "文件内容缺失");
		return { ref: this.refOf(v), bytes, provenance: this.provenanceOf(v) };
	}

	/** Like getVersion but throws 404/403 with reasons (routes). */
	async requireVersion(principal: Principal, fileId: string, versionId: string): Promise<{ file: FileRow; version: VersionRow; bytes: Uint8Array }> {
		const file = await this.requireFile(principal, "read", fileId);
		const version = this.versionRow(versionId);
		if (!version || version.file_id !== file.id) throw new HttpError(404, "version_not_found", "版本不存在");
		const bytes = this.#ctx.blobs.get(version.sha256);
		if (!bytes) throw new HttpError(500, "blob_missing", "文件内容缺失");
		return { file, version, bytes };
	}

	userNames(ids: Iterable<string>): Map<string, string> {
		const m = new Map<string, string>();
		for (const id of new Set(ids)) {
			const r = this.#ctx.db.get<{ name: string }>("SELECT name FROM id_users WHERE id = ?", id);
			if (r) m.set(id, r.name);
		}
		return m;
	}

	versionDTO(v: VersionRow, names?: Map<string, string>): FileVersionDTO {
		const p = this.provenanceOf(v);
		const provenance: FileProvenanceDTO = { ...p, createdByName: names?.get(v.created_by) };
		return {
			versionId: v.id,
			versionNo: v.version_no,
			name: v.name,
			size: v.size,
			mime: v.mime,
			sha256: v.sha256,
			createdAt: v.created_at,
			createdBy: v.created_by,
			changeNote: v.change_note ?? undefined,
			provenance,
			previewKind: previewKindOf(v.mime, v.name),
			downloadUrl: `/files/${v.file_id}/versions/${v.id}/download`,
			previewUrl: `/files/${v.file_id}/versions/${v.id}/preview`,
		};
	}

	fileDTO(f: FileRow, canWrite: boolean): FileDTO {
		const latest = f.latest_version_id ? this.versionRow(f.latest_version_id) : undefined;
		const space = this.#identity.space(f.space_id);
		return {
			id: f.id,
			name: f.name,
			spaceId: f.space_id,
			spaceKind: space?.kind ?? "personal",
			projectId: f.project_id ?? undefined,
			createdBy: f.created_by,
			createdAt: f.created_at,
			updatedAt: f.updated_at,
			latestVersionId: f.latest_version_id ?? "",
			latestVersionNo: f.latest_version_no,
			mime: latest?.mime ?? "application/octet-stream",
			size: latest?.size ?? 0,
			origin: f.origin as FileOrigin,
			canWrite,
		};
	}

	async list(p: Principal, opts: { spaceId?: string; projectId?: string; q?: string; origin?: string; conversationId?: number; limit?: number }): Promise<FileDTO[]> {
		let spaces = await this.#acl.readableSpaces(p);
		if (opts.spaceId) spaces = spaces.filter((s) => s.id === opts.spaceId);
		if (opts.projectId) spaces = spaces.filter((s) => s.projectId === opts.projectId);
		if (opts.spaceId && spaces.length === 0) {
			// Round 9: a project-share grantee lists the deliverables of ONE readable conversation (read-only), never the owner's whole space.
			if (opts.conversationId !== undefined && (await this.#acl.check(p, "read", { kind: "conversation", id: String(opts.conversationId), spaceId: opts.spaceId })).allow) {
				const rows = this.#ctx.db.all<FileRow>("SELECT * FROM file_files WHERE deleted_at IS NULL AND space_id = ? AND id IN (SELECT file_id FROM file_versions WHERE space_id = ? AND conversation_id = ?) ORDER BY updated_at DESC LIMIT ?", opts.spaceId, opts.spaceId, opts.conversationId, Math.min(Math.max(opts.limit ?? 100, 1), 500));
				return rows.map((r) => this.fileDTO(r, false));
			}
			await this.#acl.require(p, "read", { kind: "space", id: opts.spaceId });
			return [];
		}
		if (spaces.length === 0) return [];
		const params: (string | number)[] = spaces.map((s) => s.id);
		let sql = `SELECT * FROM file_files WHERE deleted_at IS NULL AND space_id IN (${spaces.map(() => "?").join(",")})`;
		if (opts.q?.trim()) {
			sql += " AND name LIKE ? ESCAPE '\\'";
			params.push(`%${opts.q.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
		}
		if (opts.origin) {
			sql += " AND origin = ?";
			params.push(opts.origin);
		}
		if (opts.conversationId !== undefined) {
			sql += " AND id IN (SELECT file_id FROM file_versions WHERE conversation_id = ?)";
			params.push(opts.conversationId);
		}
		sql += " ORDER BY updated_at DESC LIMIT ?";
		params.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));
		const rows = this.#ctx.db.all<FileRow>(sql, ...params);
		const writable = new Map<string, boolean>();
		for (const s of spaces) writable.set(s.id, (await this.#acl.check(p, "write", { kind: "space", id: s.id })).allow);
		return rows.map((r) => this.fileDTO(r, writable.get(r.space_id) ?? false));
	}

	async detail(p: Principal, fileId: string): Promise<{ file: FileDTO; versions: FileVersionDTO[] }> {
		const f = await this.requireFile(p, "read", fileId);
		const canWrite = (await this.decide(p, "write", fileId)).allow;
		const versions = this.versionRows(fileId);
		const names = this.userNames(versions.map((v) => v.created_by));
		return { file: this.fileDTO(f, canWrite), versions: versions.map((v) => this.versionDTO(v, names)) };
	}
}
