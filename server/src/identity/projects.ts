// Round 9: projects (lightweight "container" projects + legacy "space" projects), read-only project shares, org directory.
// Design: docs/research/r9-projects-audit.md (A). A container project has NO space, NO members and NO settings: it is a name,
// an owner and a catalog relation (rt_conversations.project_id) over conversations that stay in their creator's personal space.
// Sharing grants READ on the project's conversations (enforced in Identity.check for kind "conversation"; see module.ts).
// Legacy projects (kind 'space': own space, members, roles) keep their routes and behaviour; they are created only on request
// (POST /projects {kind:"space"}) — the web app no longer does, but tests, scripts and existing data depend on it.
import type { Hono } from "hono";
import type { AppContext, AppEnv, Principal } from "../core/contracts.ts";
import type { AppDb } from "../core/db.ts";
import { HttpError, jsonBody, newId, nowIso, principalOf } from "../core/http.ts";
import type { DirectoryUserDTO, ProjectDTO, ProjectShareDTO } from "../../../shared/round9.ts";
import { audit, type ContainerProject, type Identity } from "./module.ts";

const NAME_MAX = 100;
const SHARES_MAX = 200;
const DIRECTORY_MAX = 20;

const columnCache = new Set<string>();
/** Does `table.column` exist? Positive answers are cached (a column is never dropped); a missing table/column is re-checked. */
export function tableHasColumn(db: AppDb, table: string, column: string): boolean {
	const key = `${table}.${column}`;
	if (columnCache.has(key)) return true;
	try {
		const ok = db.all<{ name: string }>(`PRAGMA table_info(${table})`).some((r) => r.name === column);
		if (ok) columnCache.add(key);
		return ok;
	} catch {
		return false;
	}
}

/** SQL fragment hiding soft-deleted conversations (round 9 B2 adds rt_conversations.deleted_at; before that nothing is hidden). */
export function liveConversations(db: AppDb, alias = ""): string {
	return tableHasColumn(db, "rt_conversations", "deleted_at") ? ` AND ${alias ? `${alias}.` : ""}deleted_at IS NULL` : "";
}

function conversationCount(db: AppDb, projectId: string, spaceId?: string): number {
	try {
		const where = spaceId ? "space_id = ?" : "project_id = ?";
		return db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM rt_conversations WHERE ${where} AND archived = 0${liveConversations(db)}`, spaceId ?? projectId)?.n ?? 0;
	} catch {
		return 0; // runtime module not loaded
	}
}

function userName(db: AppDb, userId: string): string | undefined {
	return db.get<{ name: string }>("SELECT name FROM id_users WHERE id = ?", userId)?.name;
}

function containerDto(db: AppDb, pr: ContainerProject, viewer: string): ProjectDTO {
	const isOwner = pr.ownerId === viewer;
	const shared = isOwner ? (db.get<{ n: number }>("SELECT COUNT(*) AS n FROM id_project_shares WHERE project_id = ?", pr.id)?.n ?? 0) > 0 : true;
	return {
		id: pr.id,
		name: pr.name,
		kind: "container",
		ownerId: pr.ownerId,
		ownerName: userName(db, pr.ownerId),
		access: isOwner ? "owner" : "shared_read",
		shared,
		conversationCount: conversationCount(db, pr.id),
		createdAt: pr.createdAt,
		updatedAt: pr.updatedAt,
	};
}

/** Legacy project DTO: the contract fields plus the legacy ones web/tests already read (description, role). */
type LegacyProjectDTO = ProjectDTO & { readonly description: string; readonly role: string };
function legacyDto(db: AppDb, r: { id: string; name: string; description: string; created_by: string; created_at: string; updated_at: string | null; space_id: string }, viewer: string, role: string | null): LegacyProjectDTO {
	const others = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM id_project_members WHERE project_id = ? AND user_id != ? AND removed_at IS NULL", r.id, viewer)?.n ?? 0;
	return {
		id: r.id,
		name: r.name,
		kind: "space",
		spaceId: r.space_id,
		ownerId: r.created_by,
		ownerName: userName(db, r.created_by),
		access: "member",
		shared: others > 0,
		conversationCount: conversationCount(db, r.id, r.space_id),
		createdAt: r.created_at,
		updatedAt: r.updated_at ?? r.created_at,
		description: r.description,
		role: role ?? "viewer",
	};
}

function cleanName(raw: unknown, required: boolean): string | undefined {
	if (raw === undefined && !required) return undefined;
	const n = typeof raw === "string" ? raw.trim() : "";
	if (!n) throw new HttpError(400, "invalid", "项目名称必填");
	if (n.length > NAME_MAX) throw new HttpError(400, "invalid", `项目名称不能超过 ${NAME_MAX} 个字`);
	return n;
}

export function registerProjectRoutes(api: Hono<AppEnv>, ctx: AppContext, id: Identity): void {
	const db = ctx.db;
	const rid = (c: { get(k: "requestId"): string }) => c.get("requestId");

	/** Container project visible to the caller: owner or live share grantee. Anything else (unknown, other org, no share) is a plain 404. */
	const visibleContainer = (p: Principal, projectId: string): { pr: ContainerProject; isOwner: boolean } => {
		const pr = id.containerProject(projectId);
		if (!pr || pr.orgId !== p.orgId) throw new HttpError(404, "project_not_found", "项目不存在");
		const isOwner = pr.ownerId === p.userId;
		if (!isOwner && !id.hasProjectShare(p.userId, p.orgId, pr.id)) throw new HttpError(404, "project_not_found", "项目不存在");
		return { pr, isOwner };
	};
	/** Owner-only operations: a grantee learns it is read-only (403), everybody else gets 404. */
	const ownedContainer = (p: Principal, projectId: string): ContainerProject => {
		const { pr, isOwner } = visibleContainer(p, projectId);
		if (!isOwner) throw new HttpError(403, "forbidden", "只有项目所有者可以执行此操作", { reason: "not_project_owner" });
		return pr;
	};
	const kindOf = (projectId: string): { kind: string; org_id: string } | undefined => db.get<{ kind: string; org_id: string }>("SELECT kind, org_id FROM id_projects WHERE id = ?", projectId);
	const legacyRow = (projectId: string) => db.get<any>("SELECT pr.*, s.id AS space_id FROM id_projects pr JOIN id_spaces s ON s.project_id = pr.id WHERE pr.id = ?", projectId);

	// ---------------------------------------------------------------- projects
	api.get("/projects", async (c) => {
		const p = principalOf(c);
		const out: ProjectDTO[] = [];
		for (const r of db.all<any>("SELECT id FROM id_projects WHERE org_id = ? AND kind = 'container' AND created_by = ? AND archived_at IS NULL ORDER BY created_at DESC", p.orgId, p.userId)) {
			const pr = id.containerProject(r.id);
			if (pr) out.push(containerDto(db, pr, p.userId));
		}
		for (const pid of id.sharedProjectIds(p.userId, p.orgId)) {
			const pr = id.containerProject(pid);
			if (pr) out.push(containerDto(db, pr, p.userId));
		}
		const legacy = db.all<any>(
			"SELECT pr.*, pm.role, s.id AS space_id FROM id_projects pr JOIN id_project_members pm ON pm.project_id = pr.id AND pm.user_id = ? AND pm.removed_at IS NULL JOIN id_spaces s ON s.project_id = pr.id WHERE pr.org_id = ? AND pr.kind = 'space' AND pr.archived_at IS NULL ORDER BY pr.created_at DESC",
			p.userId,
			p.orgId,
		);
		for (const r of legacy) out.push(legacyDto(db, r, p.userId, r.role));
		return c.json({ projects: out });
	});

	api.post("/projects", async (c) => {
		const p = principalOf(c);
		await id.authz.require(p, "project.create");
		const b = await jsonBody<{ name: string; description?: string; kind?: string }>(c);
		const kind = b.kind ?? "container";
		if (kind !== "container" && kind !== "space") throw new HttpError(400, "invalid", "项目类型无效");
		const name = cleanName(b.name, true)!;
		const projectId = newId("prj");
		const at = nowIso();
		if (kind === "container") {
			db.tx(() => {
				db.run("INSERT INTO id_projects (id, org_id, name, description, created_by, created_at, kind, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'container', ?)", projectId, p.orgId, name, typeof b.description === "string" ? b.description : "", p.userId, at, at);
				audit(db, p.orgId, p.userId, "project.create", projectId, { kind: "container" }, { requestId: rid(c) });
			});
			return c.json({ project: containerDto(db, id.containerProject(projectId)!, p.userId) });
		}
		const spaceId = newId("sp");
		db.tx(() => {
			db.run("INSERT INTO id_projects (id, org_id, name, description, created_by, created_at, kind, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'space', ?)", projectId, p.orgId, name, b.description ?? "", p.userId, at, at);
			db.run("INSERT INTO id_project_members (project_id, user_id, role, added_by, created_at) VALUES (?, ?, 'owner', ?, ?)", projectId, p.userId, p.userId, at);
			db.run("INSERT INTO id_spaces (id, org_id, kind, project_id, created_at) VALUES (?, ?, 'project', ?, ?)", spaceId, p.orgId, projectId, at);
			audit(db, p.orgId, p.userId, "project.create", projectId, { kind: "space" }, { requestId: rid(c) });
		});
		return c.json({ project: legacyDto(db, legacyRow(projectId), p.userId, "owner") });
	});

	api.get("/projects/:id", async (c) => {
		const p = principalOf(c);
		const projectId = c.req.param("id");
		const k = kindOf(projectId);
		if (k?.kind === "container") return c.json({ project: containerDto(db, visibleContainer(p, projectId).pr, p.userId) });
		await id.require(p, "read", { kind: "project", id: projectId });
		return c.json({ project: legacyDto(db, legacyRow(projectId), p.userId, id.projectRole(p.userId, projectId)) });
	});

	api.patch("/projects/:id", async (c) => {
		const p = principalOf(c);
		const projectId = c.req.param("id");
		if (kindOf(projectId)?.kind === "container") {
			const pr = ownedContainer(p, projectId);
			const b = await jsonBody<{ name?: string }>(c);
			const name = cleanName(b.name, true)!;
			db.run("UPDATE id_projects SET name = ?, updated_at = ? WHERE id = ?", name, nowIso(), pr.id);
			audit(db, p.orgId, p.userId, "project.update", pr.id, { name, from: pr.name }, { requestId: rid(c) });
			return c.json({ ok: true, project: containerDto(db, id.containerProject(pr.id)!, p.userId) });
		}
		await id.require(p, "admin", { kind: "project", id: projectId });
		const b = await jsonBody<{ name?: string; description?: string }>(c);
		db.run("UPDATE id_projects SET name = COALESCE(?, name), description = COALESCE(?, description), updated_at = ? WHERE id = ?", b.name?.trim() || null, b.description ?? null, nowIso(), projectId);
		audit(db, p.orgId, p.userId, "project.update", projectId, b, { requestId: rid(c) });
		return c.json({ ok: true, project: legacyDto(db, legacyRow(projectId), p.userId, id.projectRole(p.userId, projectId)) });
	});

	api.delete("/projects/:id", async (c) => {
		const p = principalOf(c);
		const projectId = c.req.param("id");
		if (kindOf(projectId)?.kind === "container") {
			const pr = ownedContainer(p, projectId);
			// Only the relation goes: conversations (and their files, workspaces, run state) stay untouched and return to "no project".
			const out = db.tx(() => {
				let detached = 0;
				try {
					detached = db.run("UPDATE rt_conversations SET project_id = NULL WHERE project_id = ?", pr.id).changes;
				} catch {
					/* runtime module not loaded: nothing to detach */
				}
				const shares = db.run("DELETE FROM id_project_shares WHERE project_id = ?", pr.id).changes;
				db.run("DELETE FROM id_projects WHERE id = ?", pr.id);
				audit(db, p.orgId, p.userId, "project.delete", pr.id, { kind: "container", name: pr.name, detached, revokedShares: shares }, { requestId: rid(c) });
				return { detached, revokedShares: shares };
			});
			return c.json({ ok: true, detached: out.detached });
		}
		await id.require(p, "admin", { kind: "project", id: projectId });
		// A legacy project owns a whole space: hiding it would hide every conversation and file in it, so it must be empty.
		const space = id.projectSpace(projectId);
		if (space) {
			const conversations = conversationCount(db, projectId, space.id);
			let files = 0;
			try {
				files = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM file_files WHERE space_id = ? AND deleted_at IS NULL", space.id)?.n ?? 0;
			} catch {
				/* files module not loaded */
			}
			if (conversations > 0 || files > 0) throw new HttpError(409, "project_not_empty", `项目里还有 ${conversations} 个对话、${files} 个文件，不能删除；请先移走或清理`, { conversations, files });
		}
		db.run("UPDATE id_projects SET archived_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), projectId);
		audit(db, p.orgId, p.userId, "project.archive", projectId, undefined, { requestId: rid(c) });
		return c.json({ ok: true, detached: 0 });
	});

	// ---------------------------------------------------------------- read shares (container projects, same organisation only)
	const shareDto = (r: { user_id: string; name: string; email: string; permission: string; granted_by: string; granted_at: string }): ProjectShareDTO => ({ userId: r.user_id, name: r.name, email: r.email, permission: "read", grantedBy: r.granted_by, grantedAt: r.granted_at });
	const shareRow = (projectId: string, userId: string) =>
		db.get<any>("SELECT s.user_id, s.permission, s.granted_by, s.granted_at, u.name, u.email FROM id_project_shares s JOIN id_users u ON u.id = s.user_id WHERE s.project_id = ? AND s.user_id = ?", projectId, userId);

	api.get("/projects/:id/shares", async (c) => {
		const p = principalOf(c);
		const pr = ownedContainer(p, c.req.param("id"));
		const rows = db.all<any>("SELECT s.user_id, s.permission, s.granted_by, s.granted_at, u.name, u.email FROM id_project_shares s JOIN id_users u ON u.id = s.user_id WHERE s.project_id = ? AND s.org_id = ? ORDER BY s.granted_at, u.name", pr.id, p.orgId);
		return c.json({ shares: rows.map(shareDto) });
	});

	api.put("/projects/:id/shares/:userId", async (c) => {
		const p = principalOf(c);
		const pr = ownedContainer(p, c.req.param("id"));
		const b = (await c.req.json().catch(() => ({}))) as { permission?: unknown };
		if (b.permission !== undefined && b.permission !== "read") throw new HttpError(400, "unsupported_permission", "暂不支持：目前只能分享为「只读」");
		const userId = c.req.param("userId");
		if (userId === p.userId) throw new HttpError(400, "cannot_share_self", "不能分享给自己");
		// Same organisation, still an active member: another organisation's users are indistinguishable from unknown ones.
		const target = db.get<{ id: string }>(
			"SELECT u.id FROM id_users u JOIN id_org_members m ON m.user_id = u.id AND m.org_id = ? AND m.removed_at IS NULL AND m.disabled_at IS NULL WHERE u.id = ? AND u.disabled_at IS NULL",
			p.orgId,
			userId,
		);
		if (!target) throw new HttpError(404, "user_not_found", "组织内没有该成员");
		const existing = shareRow(pr.id, userId);
		if (!existing && (db.get<{ n: number }>("SELECT COUNT(*) AS n FROM id_project_shares WHERE project_id = ?", pr.id)?.n ?? 0) >= SHARES_MAX) throw new HttpError(409, "too_many_shares", `一个项目最多分享给 ${SHARES_MAX} 人`);
		const at = nowIso();
		db.tx(() => {
			if (!existing) {
				db.run("INSERT INTO id_project_shares (project_id, org_id, user_id, permission, granted_by, granted_at) VALUES (?, ?, ?, 'read', ?, ?)", pr.id, p.orgId, userId, p.userId, at);
				db.run("UPDATE id_projects SET updated_at = ? WHERE id = ?", at, pr.id);
				audit(db, p.orgId, p.userId, "project.share.grant", pr.id, { userId, permission: "read" }, { requestId: rid(c), category: "share" });
			}
		});
		return c.json({ share: shareDto(shareRow(pr.id, userId)) });
	});

	api.delete("/projects/:id/shares/:userId", async (c) => {
		const p = principalOf(c);
		const pr = ownedContainer(p, c.req.param("id"));
		const userId = c.req.param("userId");
		db.tx(() => {
			const n = db.run("DELETE FROM id_project_shares WHERE project_id = ? AND user_id = ? AND org_id = ?", pr.id, userId, p.orgId).changes;
			if (n) {
				db.run("UPDATE id_projects SET updated_at = ? WHERE id = ?", nowIso(), pr.id);
				audit(db, p.orgId, p.userId, "project.share.revoke", pr.id, { userId }, { requestId: rid(c), category: "share" });
			}
		});
		return c.json({ ok: true });
	});

	// ---------------------------------------------------------------- directory (share-target picker)
	api.get("/directory", (c) => {
		const p = principalOf(c);
		const q = (c.req.query("q") ?? "").trim().slice(0, 60);
		const like = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
		const rows = db.all<{ id: string; name: string; email: string }>(
			`SELECT u.id, u.name, u.email FROM id_org_members m JOIN id_users u ON u.id = m.user_id
			 WHERE m.org_id = ? AND m.removed_at IS NULL AND m.disabled_at IS NULL AND u.disabled_at IS NULL AND u.id != ?
			   ${q ? "AND (u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')" : ""}
			 ORDER BY ${q ? "CASE WHEN u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END," : ""} u.name COLLATE NOCASE, u.email
			 LIMIT ?`,
			p.orgId,
			p.userId,
			...(q ? [`%${like(q)}%`, `%${like(q)}%`, `${like(q)}%`, `${like(q)}%`] : []),
			DIRECTORY_MAX,
		);
		const users: DirectoryUserDTO[] = rows.map((r) => ({ userId: r.id, name: r.name, email: r.email }));
		return c.json({ users });
	});
}
