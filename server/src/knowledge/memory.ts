// Memory (M10): private / project / org memories with source, correction flow and revision history.
// Memory lives in the app DB, not in pi-durable: it is a global fact, not branch-local. A fork or an edited/regenerated
// branch sees the CURRENT memory at its next request (the memory section is re-rendered before every model request).
import type { AppContext, Principal, Space } from "../core/contracts.ts";
import { HttpError, newId, nowIso } from "../core/http.ts";
import type { CreateMemoryRequest, MemoryContextDTO, MemoryCorrectionResult, MemoryDTO, MemoryKind, MemoryRevisionDTO, MemoryScope, MemorySource } from "../../../shared/knowledge.ts";
import { KbAccess } from "./acl.ts";

interface MemRow {
	id: string;
	org_id: string;
	scope: MemoryScope;
	owner_user_id: string | null;
	project_id: string | null;
	kind: MemoryKind;
	content: string;
	source: MemorySource;
	source_ref: string | null;
	corrects_id: string | null;
	status: "active" | "superseded" | "deleted";
	superseded_by_id: string | null;
	version: number;
	created_by: string;
	created_at: string;
	updated_by: string;
	updated_at: string;
}

const SCOPES: readonly MemoryScope[] = ["private", "project", "org"];
const KINDS: readonly MemoryKind[] = ["preference", "fact", "constraint", "background"];
const MAX_CONTENT = 2000;
const SECTION_MAX_ITEMS = 60;
const SECTION_MAX_CHARS = 6000;
const KIND_LABEL: Record<MemoryKind, string> = { constraint: "约束", preference: "偏好", fact: "事实", background: "背景" };
const SCOPE_LABEL: Record<MemoryScope, string> = { private: "个人", project: "项目", org: "企业" };

export const MEMORY_RULES =
	"以下是当前用户与当前空间可见的长期记忆（用户可在“记忆”页面查看、修改、删除）。只在相关时使用；与用户本轮明确指示冲突时以本轮指示为准；" +
	"不要向他人透露个人记忆；项目对话中不会出现任何人的个人记忆。";

export interface SourceRef {
	spaceId: string;
	conversationId: number;
	callId?: string;
	taskId?: number;
	entryId?: number;
}

export class MemoryStore {
	readonly ctx: AppContext;
	readonly access: KbAccess;
	constructor(ctx: AppContext, access: KbAccess) {
		this.ctx = ctx;
		this.access = access;
	}
	get db() {
		return this.ctx.db;
	}

	// ---------- permissions (current state, every call) ----------
	#orgAdmin(p: Principal): boolean {
		const r = this.access.liveOrgRole(p.userId, p.orgId);
		return r === "owner" || r === "admin";
	}
	canRead(p: Principal, m: MemRow): boolean {
		if (m.org_id !== p.orgId || m.status === "deleted" || !this.access.liveOrgRole(p.userId, p.orgId)) return false;
		if (m.scope === "private") return m.owner_user_id === p.userId;
		if (m.scope === "project") return !!m.project_id && !!this.access.projectRole(p.userId, m.project_id);
		return true;
	}
	canWrite(p: Principal, m: Pick<MemRow, "org_id" | "scope" | "owner_user_id" | "project_id" | "created_by">): boolean {
		if (m.org_id !== p.orgId || !this.access.liveOrgRole(p.userId, p.orgId)) return false;
		if (m.scope === "private") return m.owner_user_id === p.userId;
		if (m.scope === "project") {
			const role = m.project_id ? this.access.projectRole(p.userId, m.project_id) : null;
			return role === "owner" || role === "editor";
		}
		return this.#orgAdmin(p) || m.created_by === p.userId;
	}

	dto(p: Principal, m: MemRow): MemoryDTO {
		const can = this.canWrite(p, m);
		return {
			id: m.id,
			scope: m.scope,
			projectId: m.project_id ?? undefined,
			kind: m.kind,
			content: m.content,
			source: m.source,
			sourceRef: m.source_ref ? JSON.parse(m.source_ref) : undefined,
			correctsId: m.corrects_id ?? undefined,
			status: m.status === "deleted" ? "superseded" : m.status,
			supersededById: m.superseded_by_id ?? undefined,
			version: m.version,
			createdBy: m.created_by,
			createdByName: this.db.get<{ name: string }>("SELECT name FROM id_users WHERE id = ?", m.created_by)?.name,
			createdAt: m.created_at,
			updatedAt: m.updated_at,
			permissions: { edit: can && m.status === "active", delete: can },
		};
	}

	row(id: string): MemRow | undefined {
		return this.db.get<MemRow>("SELECT * FROM mem_items WHERE id = ?", id);
	}
	#require(p: Principal, id: string, write: boolean): MemRow {
		const m = this.row(id);
		if (!m || !this.canRead(p, m)) throw new HttpError(404, "memory_not_found", "记忆不存在或无权访问");
		if (write && !this.canWrite(p, m)) throw new HttpError(403, "forbidden", "没有修改该记忆的权限");
		return m;
	}
	#revision(memoryId: string, version: number, change: MemoryRevisionDTO["change"], content: string, by: string, note?: string): void {
		this.db.run("INSERT INTO mem_revisions (memory_id, version, change, content, note, by_user_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)", memoryId, version, change, content, note ?? null, by, nowIso());
	}
	#clean(content: string | undefined): string {
		const c = (content ?? "").replace(/\s+\n/g, "\n").trim();
		if (!c) throw new HttpError(400, "invalid", "记忆内容不能为空");
		if (c.length > MAX_CONTENT) throw new HttpError(400, "too_long", `记忆内容不能超过 ${MAX_CONTENT} 字`);
		return c;
	}

	// ---------- CRUD ----------
	create(p: Principal, req: CreateMemoryRequest & { source?: MemorySource; sourceRef?: SourceRef }): MemoryDTO {
		const content = this.#clean(req.content);
		if (!SCOPES.includes(req.scope)) throw new HttpError(400, "invalid_scope", "scope 必须是 private / project / org");
		const kind = req.kind ?? "fact";
		if (!KINDS.includes(kind)) throw new HttpError(400, "invalid", "kind 无效");
		const shape = {
			org_id: p.orgId,
			scope: req.scope,
			owner_user_id: req.scope === "private" ? p.userId : null,
			project_id: req.scope === "project" ? (req.projectId ?? null) : null,
			created_by: p.userId,
		};
		if (req.scope === "project" && !shape.project_id) throw new HttpError(400, "invalid", "项目记忆需要 projectId");
		if (req.scope === "org" && !this.#orgAdmin(p)) throw new HttpError(403, "forbidden", "只有组织管理员可以写入企业记忆", { reason: "not_admin" });
		if (!this.canWrite(p, shape)) throw new HttpError(403, "forbidden", req.scope === "project" ? "需要项目所有者或编辑者角色" : "无权写入", { reason: "no_write" });
		// Idempotent per tool call (memory_save is replay-safe).
		if (req.sourceRef?.callId) {
			const dup = this.db.get<MemRow>("SELECT * FROM mem_items WHERE org_id = ? AND json_extract(source_ref, '$.callId') = ? AND json_extract(source_ref, '$.spaceId') = ?", p.orgId, req.sourceRef.callId, req.sourceRef.spaceId);
			if (dup) return this.dto(p, dup);
		}
		const id = newId("mem");
		const now = nowIso();
		this.db.tx(() => {
			this.db.run(
				"INSERT INTO mem_items (id, org_id, scope, owner_user_id, project_id, kind, content, source, source_ref, status, version, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)",
				id, p.orgId, req.scope, shape.owner_user_id, shape.project_id, kind, content, req.source ?? "user", req.sourceRef ? JSON.stringify(req.sourceRef) : null, p.userId, now, p.userId, now,
			);
			this.#revision(id, 1, "create", content, p.userId);
		});
		return this.dto(p, this.row(id)!);
	}

	list(p: Principal, filter: { scope?: MemoryScope; projectId?: string; includeSuperseded?: boolean } = {}): MemoryDTO[] {
		if (!this.access.liveOrgRole(p.userId, p.orgId)) return [];
		const rows = this.db.all<MemRow>(
			`SELECT m.* FROM mem_items m WHERE m.org_id = ? AND m.status ${filter.includeSuperseded ? "IN ('active','superseded')" : "= 'active'"} AND (
			   (m.scope = 'private' AND m.owner_user_id = ?)
			   OR (m.scope = 'project' AND EXISTS (SELECT 1 FROM id_project_members pm JOIN id_projects pr ON pr.id = pm.project_id WHERE pm.project_id = m.project_id AND pm.user_id = ? AND pm.removed_at IS NULL AND pr.archived_at IS NULL))
			   OR m.scope = 'org')
			 ORDER BY m.updated_at DESC`,
			p.orgId, p.userId, p.userId,
		);
		return rows.filter((m) => (!filter.scope || m.scope === filter.scope) && (!filter.projectId || m.project_id === filter.projectId)).map((m) => this.dto(p, m));
	}

	get(p: Principal, id: string): MemoryDTO {
		return this.dto(p, this.#require(p, id, false));
	}

	update(p: Principal, id: string, req: { content?: string; kind?: MemoryKind }): MemoryDTO {
		const m = this.#require(p, id, true);
		if (m.status !== "active") throw new HttpError(409, "superseded", "该记忆已被更正，请修改最新版本");
		const content = req.content !== undefined ? this.#clean(req.content) : m.content;
		const kind = req.kind ?? m.kind;
		if (!KINDS.includes(kind)) throw new HttpError(400, "invalid", "kind 无效");
		if (content === m.content && kind === m.kind) return this.dto(p, m);
		this.db.tx(() => {
			this.db.run("UPDATE mem_items SET content = ?, kind = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?", content, kind, p.userId, nowIso(), id);
			this.#revision(id, m.version + 1, "edit", content, p.userId);
		});
		return this.dto(p, this.row(id)!);
	}

	/** Correction flow: the corrected fact replaces the old one (old kept as superseded, linked both ways). */
	correct(p: Principal, id: string, req: { content: string; note?: string }): MemoryCorrectionResult {
		const m = this.#require(p, id, true);
		if (m.status !== "active") throw new HttpError(409, "superseded", "该记忆已被更正，请更正最新版本");
		const content = this.#clean(req.content);
		const newIdV = newId("mem");
		const now = nowIso();
		this.db.tx(() => {
			this.db.run(
				"INSERT INTO mem_items (id, org_id, scope, owner_user_id, project_id, kind, content, source, source_ref, corrects_id, status, version, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'corrected', ?, ?, 'active', 1, ?, ?, ?, ?)",
				newIdV, m.org_id, m.scope, m.owner_user_id, m.project_id, m.kind, content, m.source_ref, m.id, p.userId, now, p.userId, now,
			);
			this.#revision(newIdV, 1, "correct", content, p.userId, req.note);
			this.db.run("UPDATE mem_items SET status = 'superseded', superseded_by_id = ?, updated_by = ?, updated_at = ? WHERE id = ?", newIdV, p.userId, now, m.id);
			this.#revision(m.id, m.version, "supersede", m.content, p.userId, req.note);
		});
		return {
			previous: this.dto(p, this.row(m.id)!),
			current: this.dto(p, this.row(newIdV)!),
			change: { before: m.content, after: content, note: req.note, at: now, by: p.userId },
		};
	}

	delete(p: Principal, id: string): void {
		const m = this.#require(p, id, true);
		this.db.tx(() => {
			this.db.run("UPDATE mem_items SET status = 'deleted', updated_by = ?, updated_at = ? WHERE id = ?", p.userId, nowIso(), id);
			this.#revision(id, m.version, "delete", m.content, p.userId);
		});
	}

	history(p: Principal, id: string): MemoryRevisionDTO[] {
		const m = this.#require(p, id, false);
		// Follow the correction chain backwards so the whole lineage is visible.
		const ids: string[] = [m.id];
		let cur: MemRow | undefined = m;
		while (cur?.corrects_id && ids.length < 50) {
			ids.push(cur.corrects_id);
			cur = this.row(cur.corrects_id);
		}
		return this.db
			.all<{ memory_id: string; version: number; change: MemoryRevisionDTO["change"]; content: string; note: string | null; by_user_id: string; at: string }>(
				`SELECT * FROM mem_revisions WHERE memory_id IN (SELECT value FROM json_each(?)) ORDER BY seq`,
				JSON.stringify(ids),
			)
			.map((r) => ({ memoryId: r.memory_id, version: r.version, change: r.change, content: r.content, note: r.note ?? undefined, by: r.by_user_id, at: r.at }));
	}

	// ---------- context for the model (M10-B) ----------
	/**
	 * Memories that belong in a conversation of `space` acted on by `actor`:
	 * - personal space: the owner's private memories (only when the actor IS the owner) + org memories;
	 * - project space: that project's memories (actor must currently be a member) + org memories. Never private ones —
	 *   project conversations are visible to other members.
	 * `actor` null (unknown) → no private memories at all; project + org memories of the space only.
	 */
	contextFor(actor: Principal | null, space: Space): MemoryDTO[] {
		const orgId = space.orgId;
		if (actor && (actor.orgId !== orgId || !this.access.liveOrgRole(actor.userId, orgId))) return [];
		const rows: MemRow[] = [];
		const q = (sql: string, ...params: string[]) => rows.push(...this.db.all<MemRow>(sql, ...params));
		if (space.kind === "personal") {
			if (actor && actor.userId === space.ownerUserId) q("SELECT * FROM mem_items WHERE org_id = ? AND scope = 'private' AND owner_user_id = ? AND status = 'active'", orgId, actor.userId);
		} else if (space.projectId) {
			// Unknown actor: project memories are shared background for exactly this space, so they may be included.
			const member = actor ? !!this.access.projectRole(actor.userId, space.projectId) : true;
			if (member) q("SELECT * FROM mem_items WHERE org_id = ? AND scope = 'project' AND project_id = ? AND status = 'active'", orgId, space.projectId);
		}
		if (!actor || this.access.liveOrgRole(actor.userId, orgId)) q("SELECT * FROM mem_items WHERE org_id = ? AND scope = 'org' AND status = 'active'", orgId);
		const order: Record<MemoryKind, number> = { constraint: 0, preference: 1, fact: 2, background: 3 };
		rows.sort((a, b) => order[a.kind] - order[b.kind] || b.updated_at.localeCompare(a.updated_at));
		const viewer = actor ?? ({ userId: "", orgId, orgRole: "member", displayName: "", email: "", departmentIds: [] } as Principal);
		return rows.slice(0, SECTION_MAX_ITEMS).map((m) => this.dto(viewer, m));
	}

	renderSection(items: readonly MemoryDTO[]): string | undefined {
		if (!items.length) return undefined;
		const lines: string[] = [MEMORY_RULES];
		let len = lines[0]!.length;
		for (const m of items) {
			const line = `- [${SCOPE_LABEL[m.scope]}·${KIND_LABEL[m.kind]}${m.source === "corrected" ? "·已更正" : ""}] ${m.content.replace(/\n+/g, " ")}`;
			if (len + line.length > SECTION_MAX_CHARS) {
				lines.push(`- （另有 ${items.length - lines.length + 1} 条记忆因篇幅省略）`);
				break;
			}
			lines.push(line);
			len += line.length;
		}
		return lines.join("\n");
	}

	contextDTO(actor: Principal, space: Space): MemoryContextDTO {
		const included = this.contextFor(actor, space);
		return { spaceId: space.id, spaceKind: space.kind, included, section: this.renderSection(included), rules: MEMORY_RULES };
	}
}
