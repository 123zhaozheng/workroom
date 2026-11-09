// Knowledge store: bases, documents/versions, retrieval (ACL inside SQL), citation status, governance.
import type { AppContext, Citation, FileService, FileVersionRef, KnowledgeService, Principal } from "../core/contracts.ts";
import { HttpError, newId, nowIso } from "../core/http.ts";
import type {
	CitationDTO,
	CitationStatusDTO,
	CreateKbRequest,
	FileKnowledgeStatus,
	KbDecisionDTO,
	KbDocDTO,
	KbDocVersionDTO,
	KbGovEffectiveStatus,
	KbGovernanceDTO,
	KbProcessingStatus,
	KbScope,
	KbSearchRequest,
	KbSearchResponse,
	KbSummary,
	RetrievalDiagnostics,
	UpdateGovernanceRequest,
} from "../../../shared/knowledge.ts";
import { accessibleKbQuery, KbAccess, type KbRow } from "./acl.ts";
import { locatorOf } from "./chunker.ts";
import { coverage, escapeLike, makeSnippet, occurrences, planQuery } from "./query.ts";
import { recordRetrieval } from "./events.ts";

export interface DocRow {
	id: string;
	kb_id: string;
	file_id: string;
	file_name: string;
	serving_version_id: string | null;
	latest_version_id: string;
	follow_latest: number;
	added_by: string;
	created_at: string;
	updated_at: string;
	deleted_at: string | null;
	deleted_reason: string | null;
	doc_kind: "reference" | "policy" | "template";
	gov_status: "draft" | "effective" | "expired" | "withdrawn";
	responsible_user_id: string | null;
	version_label: string | null;
	effective_from: string | null;
	expires_at: string | null;
	replaced_by_doc_id: string | null;
	gov_updated_at: string;
	gov_updated_by: string | null;
}
export interface VersionRow {
	id: string;
	doc_id: string;
	kb_id: string;
	file_id: string;
	version_id: string;
	version_no: number;
	file_name: string;
	mime: string;
	size: number;
	sha256: string;
	status: KbProcessingStatus;
	error: string | null;
	error_code: string | null;
	retryable: number | null;
	attempts: number;
	chunk_count: number;
	page_count: number | null;
	ocr_pages: number | null;
	added_by: string;
	created_at: string;
	updated_at: string;
	superseded_at: string | null;
}
interface ChunkHit {
	id: string;
	kb_id: string;
	kb_name: string;
	doc_id: string;
	file_id: string;
	version_id: string;
	version_no: number;
	file_name: string;
	page: number | null;
	section: string | null;
	paragraph: number | null;
	sheet: string | null;
	row_start: number | null;
	row_end: number | null;
	ocr: number;
	text: string;
	rank?: number;
}

/** Correlation for retrieval events (M18-B). */
export interface RetrievalTrace {
	source: "api" | "tool" | "eval";
	requestId?: string;
	spaceId?: string;
	conversationId?: number;
	taskId?: number;
	callId?: string;
}
interface KbSearchDebugInternal {
	ftsQuery: string | null;
	likeTerms: string[];
	candidateCount: number;
	candidates: Map<string, number>;
	hits: Map<string, number>;
}
export type SearchOptions = Omit<KbSearchRequest, "query"> & {
	trace?: RetrievalTrace;
	/** Subagent member knowledge scope: only these KBs may be searched (requests outside it are refused as forbidden). */
	memberScope?: readonly string[];
};
export interface SearchResult extends KbSearchResponse {
	citations: CitationDTO[];
}

const SCOPES: readonly KbScope[] = ["personal", "project", "department", "org"];
const GOV_STATUSES = ["draft", "effective", "expired", "withdrawn"] as const;
const DOC_KINDS = ["reference", "policy", "template"] as const;
const CACHE_MAX = 200;
const CACHE_TTL_MS = 60_000;

/** Default retrieval: only docs whose governance status is effective *now*. `:now` param. */
const GOV_FILTER = `d.gov_status = 'effective' AND (d.effective_from IS NULL OR d.effective_from <= ?) AND (d.expires_at IS NULL OR d.expires_at > ?)`;

export function govEffectiveStatus(d: Pick<DocRow, "gov_status" | "effective_from" | "expires_at">, now = nowIso()): KbGovEffectiveStatus {
	if (d.gov_status !== "effective") return d.gov_status;
	if (d.expires_at && d.expires_at <= now) return "expired";
	if (d.effective_from && d.effective_from > now) return "pending";
	return "effective";
}

export class KnowledgeStore implements KnowledgeService {
	readonly ctx: AppContext;
	readonly access: KbAccess;
	/** Called after any change that creates processing work. */
	onWork: () => void = () => {};
	#cache = new Map<string, { at: number; value: SearchResult }>();

	constructor(ctx: AppContext) {
		this.ctx = ctx;
		this.access = new KbAccess(ctx.db);
	}
	get db() {
		return this.ctx.db;
	}

	// ---------- helpers ----------
	generation(): number {
		return this.db.get<{ value: number }>("SELECT value FROM kb_meta WHERE key = 'generation'")!.value;
	}
	bumpGeneration(): void {
		this.db.run("UPDATE kb_meta SET value = value + 1 WHERE key = 'generation'");
		this.#cache.clear();
	}
	files(): FileService {
		if (!this.ctx.services.has("files")) throw new HttpError(503, "files_unavailable", "文件服务未启用，暂时无法读取文件");
		return this.ctx.services.get("files");
	}
	kbRow(id: string): KbRow | undefined {
		return this.db.get<KbRow>("SELECT * FROM kb_bases WHERE id = ?", id);
	}
	docRow(id: string): DocRow | undefined {
		return this.db.get<DocRow>("SELECT * FROM kb_docs WHERE id = ?", id);
	}
	versionRow(id: string): VersionRow | undefined {
		return this.db.get<VersionRow>("SELECT * FROM kb_doc_versions WHERE id = ?", id);
	}
	/** Load a KB the caller may act on; 404 when unreadable (existence is not revealed), 403 when readable but not enough. */
	requireKb(p: Principal, action: "read" | "write" | "admin", id: string): KbRow {
		const kb = this.kbRow(id);
		const perms = this.access.permissions(p, kb);
		if (!kb || !perms.read) throw new HttpError(404, "kb_not_found", "知识库不存在或无权访问");
		if (!perms[action]) throw new HttpError(403, "forbidden", action === "write" ? "没有向该知识库添加或修改资料的权限" : "没有管理该知识库的权限", { reason: `kb_no_${action}` });
		return kb;
	}
	requireDoc(kb: KbRow, docId: string): DocRow {
		const d = this.docRow(docId);
		if (!d || d.kb_id !== kb.id || d.deleted_at) throw new HttpError(404, "doc_not_found", "文档不存在");
		return d;
	}
	userName(id: string | null | undefined): string | undefined {
		if (!id) return undefined;
		return this.db.get<{ name: string }>("SELECT name FROM id_users WHERE id = ?", id)?.name;
	}

	// ---------- bases ----------
	kbSummary(p: Principal, kb: KbRow): KbSummary {
		const s = this.db.get<{ docs: number; ready: number; processing: number; failed: number }>(
			`SELECT count(*) AS docs,
			        sum(CASE WHEN d.serving_version_id IS NOT NULL THEN 1 ELSE 0 END) AS ready,
			        sum(CASE WHEN d.serving_version_id IS NULL AND v.status IN ('queued','parsing','indexing') THEN 1 ELSE 0 END) AS processing,
			        sum(CASE WHEN d.serving_version_id IS NULL AND v.status = 'failed' THEN 1 ELSE 0 END) AS failed
			 FROM kb_docs d JOIN kb_doc_versions v ON v.id = d.latest_version_id WHERE d.kb_id = ? AND d.deleted_at IS NULL`,
			kb.id,
		)!;
		const maintainers = this.db.all<{ userId: string; name: string }>("SELECT m.user_id AS userId, u.name FROM kb_maintainers m JOIN id_users u ON u.id = m.user_id WHERE m.kb_id = ? ORDER BY m.created_at", kb.id);
		return {
			id: kb.id,
			name: kb.name,
			description: kb.description,
			scope: kb.scope,
			ownerUserId: kb.owner_user_id,
			projectId: kb.project_id ?? undefined,
			departmentId: kb.department_id ?? undefined,
			createdAt: kb.created_at,
			updatedAt: kb.updated_at,
			stats: { docs: s.docs, ready: s.ready ?? 0, processing: s.processing ?? 0, failed: s.failed ?? 0 },
			permissions: this.access.permissions(p, kb),
			maintainers,
		};
	}

	createKb(p: Principal, req: CreateKbRequest): KbSummary {
		const name = req.name?.trim();
		if (!name) throw new HttpError(400, "invalid", "知识库名称必填");
		if (!SCOPES.includes(req.scope)) throw new HttpError(400, "invalid_scope", "范围必须是 personal / project / department / org");
		const orgRole = this.access.liveOrgRole(p.userId, p.orgId);
		if (!orgRole) throw new HttpError(401, "revoked", "账号已不在组织中");
		let projectId: string | null = null;
		let departmentId: string | null = null;
		if (req.scope === "project") {
			if (!req.projectId) throw new HttpError(400, "invalid", "项目知识库需要 projectId");
			const role = this.access.projectRole(p.userId, req.projectId);
			if (!role) throw new HttpError(403, "forbidden", "不是该项目成员", { reason: "not_member" });
			if (role === "viewer") throw new HttpError(403, "forbidden", "查看者不能创建项目知识库", { reason: "role_viewer" });
			projectId = req.projectId;
		} else if (req.scope === "department") {
			if (!req.departmentId) throw new HttpError(400, "invalid", "部门知识库需要 departmentId");
			const dept = this.db.get<{ org_id: string }>("SELECT org_id FROM id_departments WHERE id = ?", req.departmentId);
			if (!dept || dept.org_id !== p.orgId) throw new HttpError(404, "department_not_found", "部门不存在");
			const admin = orgRole === "owner" || orgRole === "admin";
			if (!admin && !this.access.inDepartment(p.userId, req.departmentId, p.orgId)) throw new HttpError(403, "forbidden", "不是该部门成员", { reason: "not_in_department" });
			departmentId = req.departmentId;
		} else if (req.scope === "org") {
			if (orgRole !== "owner" && orgRole !== "admin") throw new HttpError(403, "forbidden", "只有组织管理员可以创建企业知识库", { reason: "not_admin" });
		}
		const id = newId("kb");
		const now = nowIso();
		this.db.run(
			"INSERT INTO kb_bases (id, org_id, name, description, scope, owner_user_id, project_id, department_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			id, p.orgId, name, req.description?.trim() ?? "", req.scope, p.userId, projectId, departmentId, p.userId, now, now,
		);
		this.audit(p, "kb.create", id, { scope: req.scope, projectId, departmentId });
		return this.kbSummary(p, this.kbRow(id)!);
	}

	listKbs(p: Principal, filter: { projectId?: string; scope?: KbScope } = {}): KbSummary[] {
		const q = accessibleKbQuery(p.orgId, p.userId);
		const rows = this.db.all<KbRow>(`SELECT * FROM kb_bases WHERE id IN (${q.sql}) ORDER BY created_at DESC`, ...q.params);
		return rows.filter((r) => (!filter.projectId || r.project_id === filter.projectId) && (!filter.scope || r.scope === filter.scope)).map((r) => this.kbSummary(p, r));
	}

	updateKb(p: Principal, id: string, patch: { name?: string; description?: string }): KbSummary {
		const kb = this.requireKb(p, "admin", id);
		const name = patch.name?.trim() || kb.name;
		this.db.run("UPDATE kb_bases SET name = ?, description = ?, updated_at = ? WHERE id = ?", name, patch.description ?? kb.description, nowIso(), id);
		return this.kbSummary(p, this.kbRow(id)!);
	}

	deleteKb(p: Principal, id: string): void {
		const kb = this.requireKb(p, "admin", id);
		this.db.tx(() => {
			for (const d of this.db.all<{ id: string }>("SELECT id FROM kb_docs WHERE kb_id = ? AND deleted_at IS NULL", kb.id)) this.#deleteDocTx(d.id, "kb_deleted");
			this.db.run("UPDATE kb_bases SET deleted_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), kb.id);
			this.bumpGeneration();
		});
		this.audit(p, "kb.delete", id);
	}

	setMaintainer(p: Principal, kbId: string, target: { userId?: string; email?: string }, on: boolean): KbSummary {
		const kb = this.requireKb(p, "admin", kbId);
		const u = this.db.get<{ id: string }>(
			"SELECT u.id FROM id_users u JOIN id_org_members m ON m.user_id = u.id AND m.org_id = ? AND m.removed_at IS NULL WHERE u.id = ? OR u.email = ?",
			p.orgId, target.userId ?? "", target.email ?? "",
		);
		if (!u) throw new HttpError(404, "user_not_found", "组织内没有该成员");
		if (on) this.db.run("INSERT OR IGNORE INTO kb_maintainers (kb_id, user_id, added_by, created_at) VALUES (?, ?, ?, ?)", kb.id, u.id, p.userId, nowIso());
		else this.db.run("DELETE FROM kb_maintainers WHERE kb_id = ? AND user_id = ?", kb.id, u.id);
		this.bumpGeneration();
		this.audit(p, on ? "kb.maintainer.add" : "kb.maintainer.remove", kb.id, { userId: u.id });
		return this.kbSummary(p, this.kbRow(kb.id)!);
	}

	// ---------- documents ----------
	versionDTO(v: VersionRow): KbDocVersionDTO {
		return {
			docVersionId: v.id,
			fileId: v.file_id,
			versionId: v.version_id,
			versionNo: v.version_no,
			fileName: v.file_name,
			mime: v.mime,
			size: v.size,
			status: v.status,
			error: v.error ?? undefined,
			errorCode: v.error_code ?? undefined,
			retryable: v.retryable === null ? undefined : !!v.retryable,
			attempts: v.attempts,
			chunkCount: v.chunk_count,
			pageCount: v.page_count ?? undefined,
			...(v.ocr_pages ? { ocrPages: v.ocr_pages } : {}),
			createdAt: v.created_at,
			updatedAt: v.updated_at,
			supersededAt: v.superseded_at ?? undefined,
		};
	}
	governanceDTO(d: DocRow): KbGovernanceDTO {
		const eff = govEffectiveStatus(d);
		return {
			kind: d.doc_kind,
			responsibleUserId: d.responsible_user_id ?? undefined,
			responsibleName: this.userName(d.responsible_user_id),
			versionLabel: d.version_label ?? undefined,
			status: d.gov_status,
			effectiveStatus: eff,
			effectiveFrom: d.effective_from ?? undefined,
			expiresAt: d.expires_at ?? undefined,
			replacedByDocId: d.replaced_by_doc_id ?? undefined,
			updatedAt: d.gov_updated_at,
			updatedBy: d.gov_updated_by ?? undefined,
			retrievable: eff === "effective",
		};
	}
	docDTO(d: DocRow): KbDocDTO {
		const latest = this.versionRow(d.latest_version_id)!;
		const serving = d.serving_version_id ? this.versionRow(d.serving_version_id)! : null;
		const availability = serving ? "ready" : latest.status === "failed" ? "failed" : "processing";
		return {
			id: d.id,
			kbId: d.kb_id,
			fileId: d.file_id,
			fileName: (serving ?? latest).file_name,
			availability,
			serving: serving ? this.versionDTO(serving) : null,
			latest: this.versionDTO(latest),
			governance: this.governanceDTO(d),
			addedBy: d.added_by,
			createdAt: d.created_at,
			updatedAt: d.updated_at,
		};
	}

	listDocs(p: Principal, kbId: string): KbDocDTO[] {
		const kb = this.requireKb(p, "read", kbId);
		return this.db.all<DocRow>("SELECT * FROM kb_docs WHERE kb_id = ? AND deleted_at IS NULL ORDER BY created_at DESC", kb.id).map((d) => this.docDTO(d));
	}
	getDoc(p: Principal, kbId: string, docId: string): { doc: KbDocDTO; versions: KbDocVersionDTO[] } {
		const kb = this.requireKb(p, "read", kbId);
		const d = this.requireDoc(kb, docId);
		return { doc: this.docDTO(d), versions: this.db.all<VersionRow>("SELECT * FROM kb_doc_versions WHERE doc_id = ? ORDER BY version_no DESC", d.id).map((v) => this.versionDTO(v)) };
	}

	/** Explicit "add this file version to this KB" (M08-C). Reads the version as the caller (file ACL), then queues ingestion. */
	async addDoc(p: Principal, kbId: string, req: { fileId: string; versionId: string; governance?: UpdateGovernanceRequest }): Promise<KbDocDTO> {
		const kb = this.requireKb(p, "write", kbId);
		if (!req.fileId || !req.versionId) throw new HttpError(400, "invalid", "需要 fileId 与 versionId");
		let got: Awaited<ReturnType<FileService["getVersion"]>>;
		try {
			got = await this.files().getVersion(p, req.versionId);
		} catch (e) {
			if (e instanceof HttpError && e.status === 503) throw e;
			got = null;
		}
		if (!got || got.ref.fileId !== req.fileId) throw new HttpError(404, "file_version_not_found", "文件版本不存在或无权读取");
		const ref = got.ref;
		const docId = this.db.tx(() => {
			const existing = this.db.get<DocRow>("SELECT * FROM kb_docs WHERE kb_id = ? AND file_id = ? AND deleted_at IS NULL", kb.id, ref.fileId);
			if (existing) {
				const same = this.db.get<VersionRow>("SELECT * FROM kb_doc_versions WHERE doc_id = ? AND version_id = ?", existing.id, ref.versionId);
				if (same) return existing.id; // idempotent
				const latest = this.versionRow(existing.latest_version_id)!;
				if (ref.versionNo <= latest.version_no) throw new HttpError(409, "older_version", `知识库中已有该文件的 v${latest.version_no}，不能加入更旧的 v${ref.versionNo}`);
				this.#insertVersion(existing.id, kb.id, ref, p.userId);
				return existing.id;
			}
			const id = newId("kbd");
			const now = nowIso();
			const vId = newId("kbv");
			this.db.run(
				"INSERT INTO kb_docs (id, kb_id, file_id, file_name, latest_version_id, added_by, created_at, updated_at, gov_updated_at, gov_updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				id, kb.id, ref.fileId, ref.name, vId, p.userId, now, now, now, p.userId,
			);
			this.#insertVersion(id, kb.id, ref, p.userId, vId);
			return id;
		});
		if (req.governance) this.#applyGovernance(p, kb, this.docRow(docId)!, req.governance);
		this.audit(p, "kb.doc.add", kb.id, { docId, fileId: ref.fileId, versionId: ref.versionId });
		this.onWork();
		return this.docDTO(this.docRow(docId)!);
	}

	#insertVersion(docId: string, kbId: string, ref: FileVersionRef, addedBy: string, id = newId("kbv")): string {
		const now = nowIso();
		this.db.run(
			"INSERT INTO kb_doc_versions (id, doc_id, kb_id, file_id, version_id, version_no, file_name, mime, size, sha256, status, added_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)",
			id, docId, kbId, ref.fileId, ref.versionId, ref.versionNo, ref.name, ref.mime, ref.size, ref.sha256, addedBy, now, now,
		);
		this.db.run("UPDATE kb_docs SET latest_version_id = ?, updated_at = ? WHERE id = ?", id, now, docId);
		this.db.run("INSERT INTO kb_jobs (id, doc_version_id, state, attempt, run_after, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?, ?)", newId("kbj"), id, now, now, now);
		this.bumpGeneration(); // pending counts feed diagnostics (index_not_ready): never serve a cached answer from before
		return id;
	}

	retry(p: Principal, kbId: string, docId: string): KbDocDTO {
		const kb = this.requireKb(p, "write", kbId);
		const d = this.requireDoc(kb, docId);
		const v = this.versionRow(d.latest_version_id)!;
		if (v.status !== "failed") throw new HttpError(409, "not_failed", v.status === "ready" ? "该文档已可检索，无需重试" : "该文档正在处理中");
		const now = nowIso();
		this.db.tx(() => {
			this.db.run("UPDATE kb_doc_versions SET status = 'queued', updated_at = ? WHERE id = ?", now, v.id);
			this.db.run("UPDATE kb_jobs SET state = 'cancelled', updated_at = ? WHERE doc_version_id = ? AND state IN ('pending','failed')", now, v.id);
			this.db.run("INSERT INTO kb_jobs (id, doc_version_id, state, attempt, run_after, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?, ?)", newId("kbj"), v.id, now, now, now);
			this.bumpGeneration();
		});
		this.audit(p, "kb.doc.retry", kb.id, { docId, docVersionId: v.id });
		this.onWork();
		return this.docDTO(this.docRow(d.id)!);
	}

	deleteDoc(p: Principal, kbId: string, docId: string): void {
		const kb = this.requireKb(p, "write", kbId);
		const d = this.requireDoc(kb, docId);
		this.db.tx(() => {
			this.#deleteDocTx(d.id, "removed");
			this.bumpGeneration();
		});
		this.audit(p, "kb.doc.delete", kb.id, { docId });
	}

	/** Remove from retrieval immediately: live chunks leave the FTS index and are tombstoned (rows kept for citation status). */
	#deleteDocTx(docId: string, reason: string): void {
		const now = nowIso();
		this.db.run("DELETE FROM kb_fts WHERE rowid IN (SELECT seq FROM kb_chunks WHERE doc_id = ? AND tombstoned_at IS NULL)", docId);
		this.db.run("UPDATE kb_chunks SET tombstoned_at = ?, tombstone_reason = 'deleted' WHERE doc_id = ? AND tombstoned_at IS NULL", now, docId);
		this.db.run("UPDATE kb_jobs SET state = 'cancelled', updated_at = ? WHERE state IN ('pending','running') AND doc_version_id IN (SELECT id FROM kb_doc_versions WHERE doc_id = ?)", now, docId);
		this.db.run("UPDATE kb_docs SET deleted_at = ?, deleted_reason = ?, updated_at = ? WHERE id = ?", now, reason, now, docId);
	}

	/** Hook for the files module: a new version of a file exists → every KB doc following that file gets a new doc version. */
	fileVersionAdded(fileId: string, ref: FileVersionRef, by?: Principal): string[] {
		const out: string[] = [];
		this.db.tx(() => {
			for (const d of this.db.all<DocRow>("SELECT d.* FROM kb_docs d JOIN kb_bases b ON b.id = d.kb_id WHERE d.file_id = ? AND d.deleted_at IS NULL AND b.deleted_at IS NULL AND d.follow_latest = 1", fileId)) {
				const latest = this.versionRow(d.latest_version_id)!;
				if (ref.versionNo <= latest.version_no) continue;
				out.push(this.#insertVersion(d.id, d.kb_id, ref, by?.userId ?? latest.added_by));
			}
		});
		if (out.length) this.onWork();
		return out;
	}
	/** Hook for the files module: the file was deleted → its docs disappear from retrieval now. */
	fileDeleted(fileId: string): number {
		let n = 0;
		this.db.tx(() => {
			for (const d of this.db.all<{ id: string }>("SELECT id FROM kb_docs WHERE file_id = ? AND deleted_at IS NULL", fileId)) {
				this.#deleteDocTx(d.id, "source_deleted");
				n++;
			}
			if (n) this.bumpGeneration();
		});
		return n;
	}

	fileStatus(p: Principal, fileId: string): FileKnowledgeStatus {
		const q = accessibleKbQuery(p.orgId, p.userId);
		const rows = this.db.all<DocRow & { kb_name: string }>(`SELECT d.*, b.name AS kb_name FROM kb_docs d JOIN kb_bases b ON b.id = d.kb_id WHERE d.file_id = ? AND d.deleted_at IS NULL AND d.kb_id IN (${q.sql})`, fileId, ...q.params);
		return {
			fileId,
			entries: rows.map((d) => {
				const dto = this.docDTO(d);
				return { kbId: d.kb_id, kbName: d.kb_name, docId: d.id, availability: dto.availability, servingVersionNo: dto.serving?.versionNo, latestVersionNo: dto.latest.versionNo, latestStatus: dto.latest.status };
			}),
		};
	}

	// ---------- governance (M07-B) ----------
	updateGovernance(p: Principal, kbId: string, docId: string, req: UpdateGovernanceRequest): KbDocDTO {
		const kb = this.requireKb(p, "write", kbId);
		const d = this.requireDoc(kb, docId);
		this.#applyGovernance(p, kb, d, req);
		return this.docDTO(this.docRow(d.id)!);
	}

	#applyGovernance(p: Principal, kb: KbRow, d: DocRow, req: UpdateGovernanceRequest): void {
		const next = { ...d };
		if (req.kind !== undefined) {
			if (!DOC_KINDS.includes(req.kind)) throw new HttpError(400, "invalid", "kind 必须是 reference / policy / template");
			next.doc_kind = req.kind;
		}
		if (req.status !== undefined) {
			if (!GOV_STATUSES.includes(req.status)) throw new HttpError(400, "invalid", "status 必须是 draft / effective / expired / withdrawn");
			next.gov_status = req.status;
		}
		const date = (v: string | null | undefined, field: string) => {
			if (v === null) return null;
			if (Number.isNaN(Date.parse(v!))) throw new HttpError(400, "invalid", `${field} 不是有效日期`);
			return new Date(v!).toISOString();
		};
		if (req.effectiveFrom !== undefined) next.effective_from = date(req.effectiveFrom, "effectiveFrom");
		if (req.expiresAt !== undefined) next.expires_at = date(req.expiresAt, "expiresAt");
		if (next.effective_from && next.expires_at && next.expires_at <= next.effective_from) throw new HttpError(400, "invalid", "失效日期必须晚于生效日期");
		if (req.versionLabel !== undefined) next.version_label = req.versionLabel?.trim() || null;
		if (req.responsibleUserId !== undefined) {
			if (req.responsibleUserId && !this.access.liveOrgRole(req.responsibleUserId, kb.org_id)) throw new HttpError(400, "invalid", "责任人必须是组织成员");
			next.responsible_user_id = req.responsibleUserId;
		}
		if (req.replacedByDocId !== undefined) {
			if (req.replacedByDocId) {
				const r = this.docRow(req.replacedByDocId);
				if (!r || r.kb_id !== kb.id || r.deleted_at || r.id === d.id) throw new HttpError(400, "invalid", "替换文档必须是同一知识库中的其他文档");
				// Replacement: the old doc is withdrawn as soon as the replacement is servable (now, or when it becomes ready).
				if (r.serving_version_id) next.gov_status = "withdrawn";
			}
			next.replaced_by_doc_id = req.replacedByDocId;
		}
		const now = nowIso();
		this.db.tx(() => {
			this.db.run(
				"UPDATE kb_docs SET doc_kind = ?, gov_status = ?, responsible_user_id = ?, version_label = ?, effective_from = ?, expires_at = ?, replaced_by_doc_id = ?, gov_updated_at = ?, gov_updated_by = ?, updated_at = ? WHERE id = ?",
				next.doc_kind, next.gov_status, next.responsible_user_id, next.version_label, next.effective_from, next.expires_at, next.replaced_by_doc_id, now, p.userId, now, d.id,
			);
			this.bumpGeneration();
		});
		this.audit(p, "kb.doc.governance", kb.id, { docId: d.id, ...req });
	}

	// ---------- retrieval ----------
	/** A retrieval refused before searching (e.g. outside a subagent's knowledge scope); recorded like any search. */
	refused(p: Principal, query: string, diagnostics: RetrievalDiagnostics, trace?: RetrievalTrace): SearchResult {
		const result: SearchResult = { citations: [], diagnostics: { ...diagnostics, vector: "blocked", tookMs: 0 } };
		this.recordRetrieval(p, query, result, trace);
		return result;
	}

	recordRetrieval(p: Principal, query: string, result: SearchResult, trace?: RetrievalTrace): void {
		recordRetrieval(this.db, p, query, result, trace);
	}

	/** KnowledgeService contract. Every call is recorded as a retrieval event (M18-B). */
	async search(p: Principal, query: string, options: SearchOptions = {}): Promise<SearchResult> {
		const result = await this.#search(p, query, options);
		this.recordRetrieval(p, query ?? "", result, options.trace);
		return result;
	}

	async #search(p: Principal, query: string, options: SearchOptions): Promise<SearchResult> {
		const t0 = performance.now();
		const out = (citations: CitationDTO[], diagnostics: RetrievalDiagnostics, debug?: SearchResult["debug"]): SearchResult => ({
			citations,
			diagnostics: { ...diagnostics, vector: "blocked", tookMs: Math.round((performance.now() - t0) * 10) / 10 },
			...(debug ? { debug } : {}),
		});
		try {
			// Current membership, evaluated now (SQL), never cached.
			const accessible = this.access.accessibleKbIds(p.orgId, p.userId);
			const accSet = new Set(accessible);
			const scope = options.memberScope ? [...options.memberScope] : undefined;
			const requested = options.kbIds?.length ? [...new Set(options.kbIds)] : undefined;
			let searched: string[];
			let forbidden: string[] = [];
			let outOfScope: string[] = [];
			const want = requested ?? scope;
			if (want) {
				outOfScope = scope ? want.filter((id) => !scope.includes(id)) : [];
				const inScope = want.filter((id) => !outOfScope.includes(id));
				searched = inScope.filter((id) => accSet.has(id));
				forbidden = [...inScope.filter((id) => !accSet.has(id)), ...outOfScope];
			} else if (options.projectId) {
				// Project conversation: only that project's KBs + org-wide KBs. Personal/department KBs need an explicit reference.
				searched = this.db.all<{ id: string }>(`SELECT id FROM kb_bases WHERE id IN (SELECT value FROM json_each(?)) AND ((scope = 'project' AND project_id = ?) OR scope = 'org')`, JSON.stringify(accessible), options.projectId).map((r) => r.id);
			} else searched = accessible;
			const debugOf = (extra: Partial<KbSearchDebugInternal> = {}): SearchResult["debug"] | undefined =>
				options.debug
					? {
							kbDecisions: this.#kbDecisions(p, { accessible, searched, requested, scope, outOfScope, forbidden, projectId: options.projectId, includeInactive: !!options.includeInactive, docIds: options.docIds, candidates: extra.candidates, hits: extra.hits }),
							ftsQuery: extra.ftsQuery ?? null,
							likeTerms: extra.likeTerms ?? [],
							accessibleKbIds: accessible,
							candidates: extra.candidateCount ?? 0,
							embedding: "blocked",
						}
					: undefined;
			const base: RetrievalDiagnostics = { searchedKbIds: searched, ...(forbidden.length ? { forbiddenKbIds: forbidden } : {}), ...(scope ? { memberScope: scope } : {}) };
			if (!searched.length) {
				const detail = scope && !scope.length ? "该成员没有被授予任何知识库" : outOfScope.length && outOfScope.length === forbidden.length ? "所选知识库超出该成员声明的知识范围" : "无权访问所选知识库（或知识库不存在）";
				return out([], forbidden.length || scope ? { ...base, reason: "forbidden", detail } : { ...base, reason: "no_evidence", detail: "当前范围内没有可访问的知识库" }, debugOf());
			}
			const plan = planQuery(query ?? "");
			if (!plan.match && !plan.like.length) return out([], { ...base, reason: "no_evidence", detail: "查询为空或没有可检索的词" }, debugOf());

			const counts = this.#docCounts(searched, options.docIds);
			const limit = Math.max(1, Math.min(50, options.limit ?? 8));
			const now = nowIso();
			const timeEpoch = this.db.get<{ n: number }>("SELECT count(*) AS n FROM kb_docs WHERE (expires_at IS NOT NULL AND expires_at <= ?) OR (effective_from IS NOT NULL AND effective_from <= ?)", now, now)!.n;
			const cacheKey = JSON.stringify([p.orgId, p.userId, searched, forbidden, scope ?? null, query, options.docIds ?? null, limit, !!options.includeInactive, this.generation(), timeEpoch]);
			const hit = this.#cache.get(cacheKey);
			if (hit && Date.now() - hit.at < CACHE_TTL_MS && !options.debug) {
				return out(hit.value.citations, { ...hit.value.diagnostics, cached: true });
			}

			const acc = accessibleKbQuery(p.orgId, p.userId);
			const filters: string[] = ["c.tombstoned_at IS NULL", "c.kb_id IN (SELECT value FROM json_each(?))", `c.kb_id IN (${acc.sql})`];
			const params: (string | number)[] = [JSON.stringify(searched), ...acc.params];
			if (options.docIds?.length) {
				filters.push("c.doc_id IN (SELECT value FROM json_each(?))");
				params.push(JSON.stringify(options.docIds));
			}
			if (!options.includeInactive) {
				filters.push(GOV_FILTER);
				params.push(now, now);
			}
			const select = `SELECT c.id, c.kb_id, b.name AS kb_name, c.doc_id, c.file_id, c.version_id, c.version_no, c.file_name, c.page, c.section, c.paragraph, c.sheet, c.row_start, c.row_end, c.ocr, c.text`;
			const joins = `JOIN kb_docs d ON d.id = c.doc_id AND d.serving_version_id = c.doc_version_id AND d.deleted_at IS NULL
			               JOIN kb_bases b ON b.id = c.kb_id AND b.deleted_at IS NULL`;
			let scored: { h: ChunkHit; score: number }[] = [];
			let strategy: RetrievalDiagnostics["strategy"];
			if (plan.match) {
				strategy = "fts";
				const rows = this.db.all<ChunkHit>(
					`${select}, bm25(kb_fts) AS rank FROM kb_fts JOIN kb_chunks c ON c.seq = kb_fts.rowid ${joins}
					 WHERE kb_fts MATCH ? AND ${filters.join(" AND ")} ORDER BY rank LIMIT ?`,
					plan.match, ...params, Math.max(40, limit * 5),
				);
				const maxBm = Math.max(1e-12, ...rows.map((r) => -(r.rank ?? 0)));
				scored = rows.map((h) => {
					const cov = coverage(`${h.section ?? ""}\n${h.text}`, plan.terms);
					return { h, score: 0.7 * cov + 0.3 * (-(h.rank ?? 0) / maxBm) };
				});
				if (!scored.length && plan.bigrams.length) {
					// Natural Chinese questions often share no 3-char substring with the source ("保修期多久" vs "两年有限保修"):
					// fall back to CJK bigram substring matching, scored below any trigram hit.
					strategy = "fts+like";
					const conds = plan.bigrams.map(() => "(c.text LIKE ? OR c.section LIKE ?)").join(" OR ");
					const bp = plan.bigrams.flatMap((t) => [`%${t}%`, `%${t}%`]);
					const rows2 = this.db.all<ChunkHit>(`${select} FROM kb_chunks c ${joins} WHERE (${conds}) AND ${filters.join(" AND ")} LIMIT 400`, ...bp, ...params);
					scored = rows2.map((h) => {
						const text = `${h.section ?? ""}\n${h.text}`;
						const distinct = plan.bigrams.filter((g) => text.includes(g)).length;
						return { h, score: 0.5 * (distinct / plan.bigrams.length) + 0.1 * Math.min(1, occurrences(text, plan.bigrams) / 5) };
					});
				}
			} else {
				strategy = "like";
				const likeConds = plan.like.map(() => "(c.text LIKE ? ESCAPE '\\' OR c.section LIKE ? ESCAPE '\\')").join(" OR ");
				const likeParams = plan.like.flatMap((t) => [`%${escapeLike(t)}%`, `%${escapeLike(t)}%`]);
				const rows = this.db.all<ChunkHit>(`${select} FROM kb_chunks c ${joins} WHERE (${likeConds}) AND ${filters.join(" AND ")} LIMIT 400`, ...likeParams, ...params);
				scored = rows.map((h) => {
					const text = `${h.section ?? ""}\n${h.text}`;
					return { h, score: 0.7 * Math.min(1, occurrences(text, plan.like) / 3) + 0.3 * coverage(text, plan.terms) };
				});
			}
			scored.sort((a, b) => b.score - a.score || a.h.file_name.localeCompare(b.h.file_name));
			const citations = scored.slice(0, limit).map(({ h, score }) => this.#citation(h, makeSnippet(h.text, plan.terms), score));
			let diagnostics: RetrievalDiagnostics = { ...base, strategy, readyDocs: counts.ready, pendingDocs: counts.pending, failedDocs: counts.failed };
			if (!citations.length) {
				if (counts.pending > 0) diagnostics = { ...diagnostics, reason: "index_not_ready", detail: `${counts.pending} 个文档仍在处理中${counts.ready ? `；已就绪的 ${counts.ready} 个文档中没有找到相关内容` : ""}` };
				else if (counts.ready === 0 && counts.failed > 0) diagnostics = { ...diagnostics, reason: "index_not_ready", detail: `${counts.failed} 个文档处理失败，没有可检索的内容` };
				else if (forbidden.length) diagnostics = { ...diagnostics, reason: "forbidden", detail: `无权访问 ${forbidden.length} 个所选知识库；其余知识库中没有找到相关内容` };
				else diagnostics = { ...diagnostics, reason: "no_evidence", detail: counts.ready ? "知识库中没有与问题相关的内容" : "所选范围内还没有可检索的文档" };
			} else if (forbidden.length) diagnostics = { ...diagnostics, detail: `已跳过 ${forbidden.length} 个无权访问${outOfScope.length ? "或超出成员知识范围" : ""}的知识库` };
			const result: SearchResult = { citations, diagnostics };
			this.#cache.set(cacheKey, { at: Date.now(), value: result });
			if (this.#cache.size > CACHE_MAX) this.#cache.delete(this.#cache.keys().next().value!);
			const count = (xs: { kb_id?: string; kbId?: string }[]) => xs.reduce((m, x) => m.set(x.kb_id ?? x.kbId!, (m.get(x.kb_id ?? x.kbId!) ?? 0) + 1), new Map<string, number>());
			return out(citations, diagnostics, debugOf({ ftsQuery: plan.match, likeTerms: plan.like, candidateCount: scored.length, candidates: options.debug ? count(scored.map((x) => x.h)) : undefined, hits: options.debug ? count(citations) : undefined }));
		} catch (e) {
			console.error("[knowledge] search failed", e);
			return out([], { searchedKbIds: [], reason: "error", detail: `检索出错：${(e as Error).message}` });
		}
	}

	/** Per-KB explanation for retrieval debug (M07-C): scope/membership, member scope, project context, index, governance. */
	#kbDecisions(
		p: Principal,
		x: { accessible: string[]; searched: string[]; requested?: string[]; scope?: string[]; outOfScope: string[]; forbidden: string[]; projectId?: string; includeInactive: boolean; docIds?: string[]; candidates?: Map<string, number>; hits?: Map<string, number> },
	): KbDecisionDTO[] {
		const out: KbDecisionDTO[] = [];
		const now = nowIso();
		const label: Record<string, string> = { draft: "草案", expired: "已过期", withdrawn: "已下架", pending: "未到生效日" };
		for (const id of x.accessible) {
			const kb = this.kbRow(id)!;
			const included = x.searched.includes(id);
			const reason: KbDecisionDTO["reason"] = included ? "searched" : x.scope && !x.scope.includes(id) ? "outside_member_scope" : x.requested && !x.requested.includes(id) ? "not_requested" : "outside_project_context";
			const notes: string[] = [];
			const access = this.access.basis(p, kb);
			notes.push(`可访问：${access}`);
			if (reason === "outside_member_scope") notes.push("不在子 Agent 成员声明的知识范围内");
			if (reason === "not_requested") notes.push("本次请求指定了其他知识库（kbIds）");
			if (reason === "outside_project_context") notes.push("项目会话默认只检索本项目与企业知识库；个人/部门/其他项目知识库需要显式引用");
			const docs = this.db.all<DocRow & { latest_status: string }>(
				`SELECT d.*, v.status AS latest_status FROM kb_docs d JOIN kb_doc_versions v ON v.id = d.latest_version_id WHERE d.kb_id = ? AND d.deleted_at IS NULL ${x.docIds?.length ? "AND d.id IN (SELECT value FROM json_each(?))" : ""}`,
				id, ...(x.docIds?.length ? [JSON.stringify(x.docIds)] : []),
			);
			const index = {
				ready: docs.filter((d) => d.serving_version_id).length,
				processing: docs.filter((d) => ["queued", "parsing", "indexing"].includes(d.latest_status)).length,
				failed: docs.filter((d) => !d.serving_version_id && d.latest_status === "failed").length,
			};
			const excluded: Partial<Record<"draft" | "expired" | "withdrawn" | "pending", number>> = {};
			let retrievable = 0;
			for (const d of docs.filter((d) => d.serving_version_id)) {
				const eff = govEffectiveStatus(d, now);
				if (eff === "effective" || x.includeInactive) retrievable++;
				else excluded[eff] = (excluded[eff] ?? 0) + 1;
			}
			if (included) {
				if (!docs.length) notes.push("知识库中没有文档");
				if (index.processing) notes.push(`${index.processing} 个文档处理中（索引未就绪）`);
				if (index.failed) notes.push(`${index.failed} 个文档处理失败`);
				for (const [k, n] of Object.entries(excluded)) notes.push(`${n} 个文档因${label[k]}被排除（includeInactive 可包含）`);
				if (docs.length && !retrievable) notes.push("没有当前可检索的文档");
				if (x.candidates && !(x.candidates.get(id) ?? 0) && retrievable) notes.push("没有与查询匹配的片段");
			}
			out.push({
				kbId: id,
				kbName: kb.name,
				scope: kb.scope,
				included,
				reason,
				...(access ? { access } : {}),
				index,
				governance: { retrievable, excluded, includeInactive: x.includeInactive },
				...(included && x.candidates ? { candidates: x.candidates.get(id) ?? 0, hits: x.hits?.get(id) ?? 0 } : {}),
				notes,
			});
		}
		// Explicitly requested but not accessible (or not existing): no name, no details — existence is not revealed.
		for (const id of x.forbidden) {
			if (x.accessible.includes(id)) continue;
			out.push({ kbId: id, included: false, reason: x.outOfScope.includes(id) ? "outside_member_scope" : "forbidden", notes: [x.outOfScope.includes(id) ? "不在子 Agent 成员声明的知识范围内" : "无权访问或不存在"] });
		}
		return out;
	}

	#docCounts(kbIds: string[], docIds?: string[]): { ready: number; pending: number; failed: number } {
		const r = this.db.get<{ ready: number; pending: number; failed: number }>(
			`SELECT sum(CASE WHEN d.serving_version_id IS NOT NULL THEN 1 ELSE 0 END) AS ready,
			        sum(CASE WHEN v.status IN ('queued','parsing','indexing') THEN 1 ELSE 0 END) AS pending,
			        sum(CASE WHEN d.serving_version_id IS NULL AND v.status = 'failed' THEN 1 ELSE 0 END) AS failed
			 FROM kb_docs d JOIN kb_doc_versions v ON v.id = d.latest_version_id
			 WHERE d.deleted_at IS NULL AND d.kb_id IN (SELECT value FROM json_each(?)) ${docIds?.length ? "AND d.id IN (SELECT value FROM json_each(?))" : ""}`,
			JSON.stringify(kbIds), ...(docIds?.length ? [JSON.stringify(docIds)] : []),
		)!;
		return { ready: r.ready ?? 0, pending: r.pending ?? 0, failed: r.failed ?? 0 };
	}

	#citation(h: ChunkHit, snippet: string, score: number): CitationDTO {
		return {
			kbId: h.kb_id,
			kbName: h.kb_name,
			docId: h.doc_id,
			fileId: h.file_id,
			versionId: h.version_id,
			versionNo: h.version_no,
			fileName: h.file_name,
			chunkId: h.id,
			...(h.page ? { page: h.page } : {}),
			...(h.section ? { section: h.section } : {}),
			...(h.paragraph ? { paragraph: h.paragraph } : {}),
			...(h.sheet ? { sheet: h.sheet } : {}),
			...(h.row_start ? { rowStart: h.row_start, rowEnd: h.row_end ?? h.row_start } : {}),
			...(h.ocr ? { ocr: true } : {}),
			snippet,
			score: Math.round(score * 10000) / 10000,
			locator: locatorOf({ page: h.page, section: h.section, paragraph: h.paragraph, sheet: h.sheet, rowStart: h.row_start, rowEnd: h.row_end, ocr: h.ocr }),
		};
	}

	/** Current validity of a cited chunk. Existing answers keep their snapshot; this tells the UI whether it is stale. */
	citationStatus(p: Principal, chunkId: string): CitationStatusDTO {
		const c = this.db.get<{ id: string; kb_id: string; doc_id: string; version_id: string; version_no: number; file_name: string; tombstoned_at: string | null; tombstone_reason: string | null }>(
			"SELECT id, kb_id, doc_id, version_id, version_no, file_name, tombstoned_at, tombstone_reason FROM kb_chunks WHERE id = ?",
			chunkId,
		);
		if (!c) return { chunkId, status: "not_found", message: "引用的片段不存在" };
		const kb = this.kbRow(c.kb_id)!;
		// Readability is judged as if the KB were not deleted, so a deleted source still reads "deleted" to its audience only.
		if (!this.access.permissions(p, { ...kb, deleted_at: null }).read) return { chunkId, status: "forbidden", message: "你已无权查看该引用来源" };
		const cited = { versionId: c.version_id, versionNo: c.version_no, fileName: c.file_name };
		const d = this.docRow(c.doc_id)!;
		if (kb.deleted_at) return { chunkId, status: "deleted", cited, message: "来源知识库已删除" };
		if (d.deleted_at) return { chunkId, status: "deleted", cited, message: d.deleted_reason === "source_deleted" ? "来源文件已删除" : "来源文档已从知识库移除" };
		if (c.tombstone_reason === "superseded" || (d.serving_version_id && this.versionRow(d.serving_version_id)!.version_no > c.version_no)) {
			const sv = d.serving_version_id ? this.versionRow(d.serving_version_id) : undefined;
			return { chunkId, status: "superseded", cited, ...(sv ? { current: { versionId: sv.version_id, versionNo: sv.version_no } } : {}), message: sv ? `来源已更新：引用的是 v${c.version_no}，当前为 v${sv.version_no}` : "来源已更新" };
		}
		if (c.tombstoned_at) return { chunkId, status: "deleted", cited, message: "该片段已失效" };
		const eff = govEffectiveStatus(d);
		if (eff === "withdrawn") return { chunkId, status: "withdrawn", cited, message: d.replaced_by_doc_id ? "该制度已下架并被替换" : "该制度已下架" };
		if (eff === "expired") return { chunkId, status: "expired", cited, message: "该制度已过期" };
		return { chunkId, status: "valid", cited, message: "引用有效" };
	}

	audit(p: Principal, action: string, target: string, detail?: unknown): void {
		this.db.run("INSERT INTO id_audit (id, org_id, actor_user_id, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)", newId("aud"), p.orgId, p.userId, action, target, detail === undefined ? null : JSON.stringify(detail), nowIso());
	}

	/** Contract-shaped view (core Citation) for other modules. */
	toCoreCitation(c: CitationDTO): Citation {
		return c;
	}
}
