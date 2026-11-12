// Round 14: Markdown long-term memory. The files ARE the memory (single source of truth): there is no database copy and no cache.
// One service is used by the agent's tools (through the /memory VFS backend) and by the front-end routes, so both touch the same bytes.
//
//   personal  <dataDir>/orgs/<org>/stores/memories/<userId>/   (the round-11 `memories/` store directory, now served only as /memory)
//   project   <dataDir>/orgs/<org>/memory/project/<projectId>/ (members read, owners/editors write)
//   org       <dataDir>/orgs/<org>/memory/org/                 (members read, org admins write)
//
// Writes are atomic (temp + rename, hostdir.hostWriteAtomic) and conditional (etag = sha256 of the bytes, If-Match). All operations are
// synchronous file operations, so a check-then-write cannot interleave with another writer of this process; across processes the rename is atomic.
import { join } from "node:path";
import type { AppContext, Principal, Space } from "../core/contracts.ts";
import { HttpError } from "../core/http.ts";
import { hostNode, hostRead, hostRemove, hostWalk, hostWriteAtomic, resolveHost, sha256 } from "../vfs/hostdir.ts";
import { VfsError } from "../vfs/types.ts";
import { dirSize } from "../tools/sandbox/workspace.ts";
import { safeSeg, storeQuotaBytes, fmtSize } from "../tools/sandbox/stores.ts";
import type { KbAccess } from "./acl.ts";

export type MemScope = { readonly kind: "personal" } | { readonly kind: "project"; readonly projectId: string } | { readonly kind: "org" };

export const INDEX_FILE = "MEMORY.md";
export const MEMORY_FILE_MAX = 512 * 1024;
const MAX_DEPTH = 4;
const MAX_SEGMENT = 120;
export const memBudgetChars = (): number => Math.max(500, Number(process.env.WORKROOM_MEMORY_PROMPT_CHARS ?? 6000) || 6000);

export const scopeId = (s: MemScope): string => (s.kind === "project" ? `project:${s.projectId}` : s.kind);
export function parseScopeId(id: string): MemScope {
	if (id === "personal" || id === "org") return { kind: id };
	const m = /^project:([A-Za-z0-9_-]{1,80})$/.exec(id);
	if (m) return { kind: "project", projectId: m[1]! };
	throw new HttpError(400, "invalid_scope", "scope 必须是 personal、project:<id> 或 org");
}

export interface MemFile {
	/** Path below the scope root, e.g. "preferences.md", "projects/apollo.md". */
	readonly path: string;
	readonly name: string;
	readonly size: number;
	readonly mtime: string;
	readonly etag: string;
	/** true for Markdown, false for other files that already lived in the personal directory (kept, never deleted by migration). */
	readonly markdown: boolean;
}

export interface ScopeInfo {
	readonly id: string;
	readonly kind: MemScope["kind"];
	readonly label: string;
	readonly writable: boolean;
	readonly projectId?: string;
}

/** What a conversation may use: personal memory only where nobody else can read the conversation, plus the shared scopes of the space. */
export interface ConversationScopes {
	readonly personal: boolean;
	readonly projectId?: string;
	readonly org: boolean;
}

type RuntimeLike = { projectOfConversation?: (spaceId: string, conversationId: number) => Promise<string | null> };

const lc = (s: string) => s.toLowerCase();
export const isMarkdownName = (n: string): boolean => lc(n).endsWith(".md");

export class MarkdownMemory {
	readonly ctx: AppContext;
	readonly access: KbAccess;
	constructor(ctx: AppContext, access: KbAccess) {
		this.ctx = ctx;
		this.access = access;
	}

	// ---------------------------------------------------------------- locations
	orgBase(orgId: string): string {
		return join(this.ctx.config.dataDir, "orgs", safeSeg(orgId));
	}
	/** The round-11 `memories/<user>` store directory: personal memory lives here. */
	personalDir(orgId: string, userId: string): string {
		return join(this.orgBase(orgId), "stores", "memories", safeSeg(userId));
	}
	dirOf(orgId: string, scope: MemScope, userId: string): string {
		if (scope.kind === "personal") return this.personalDir(orgId, userId);
		if (scope.kind === "project") return join(this.orgBase(orgId), "memory", "project", safeSeg(scope.projectId));
		return join(this.orgBase(orgId), "memory", "org");
	}

	// ---------------------------------------------------------------- permissions (live state on every call)
	#live(p: Principal): boolean {
		return !!this.access.liveOrgRole(p.userId, p.orgId);
	}
	#orgAdmin(p: Principal): boolean {
		const r = this.access.liveOrgRole(p.userId, p.orgId);
		return r === "owner" || r === "admin";
	}
	#projectInOrg(projectId: string, orgId: string): boolean {
		const r = this.ctx.db.get<{ org_id: string; kind: string }>("SELECT org_id, kind FROM id_projects WHERE id = ? AND archived_at IS NULL", projectId);
		return !!r && r.org_id === orgId && r.kind !== "container";
	}
	/** Per-scope permission of this person right now (the front-end's own view; conversation gating is `scopesFor`). */
	can(p: Principal, scope: MemScope): { read: boolean; write: boolean } {
		if (!this.#live(p)) return { read: false, write: false };
		if (scope.kind === "personal") return { read: true, write: true };
		if (scope.kind === "org") return { read: true, write: this.#orgAdmin(p) };
		if (!this.#projectInOrg(scope.projectId, p.orgId)) return { read: false, write: false };
		const role = this.access.projectRole(p.userId, scope.projectId);
		return { read: !!role, write: role === "owner" || role === "editor" };
	}
	#require(p: Principal, scope: MemScope, write: boolean): void {
		const c = this.can(p, scope);
		if (!c.read) throw new VfsError("forbidden", scope.kind === "personal" ? "没有权限访问这份记忆" : "没有权限访问这份共享记忆（不是该项目成员，或项目已不存在）", 403);
		if (write && !c.write) throw new VfsError("forbidden", scope.kind === "org" ? "只有组织管理员可以修改企业记忆" : "修改项目记忆需要项目所有者或编辑者角色", 403);
	}

	/** Shared scopes the person may read: every live space-project they belong to, and the org. */
	sharedScopes(p: Principal): ScopeInfo[] {
		if (!this.#live(p)) return [];
		const out: ScopeInfo[] = [];
		const rows = this.ctx.db.all<{ id: string; name: string }>(
			`SELECT pr.id, pr.name FROM id_project_members pm JOIN id_projects pr ON pr.id = pm.project_id
			 WHERE pm.user_id = ? AND pm.removed_at IS NULL AND pr.archived_at IS NULL AND pr.org_id = ? AND pr.kind != 'container' ORDER BY pr.name`,
			p.userId,
			p.orgId,
		);
		for (const r of rows) {
			const c = this.can(p, { kind: "project", projectId: r.id });
			if (c.read) out.push({ id: `project:${r.id}`, kind: "project", label: `项目：${r.name}`, writable: c.write, projectId: r.id });
		}
		out.push({ id: "org", kind: "org", label: "企业", writable: this.can(p, { kind: "org" }).write });
		return out;
	}
	/** All scopes of the person for the memory page (personal first). */
	scopesOf(p: Principal): ScopeInfo[] {
		if (!this.#live(p)) return [];
		return [{ id: "personal", kind: "personal", label: "个人", writable: true }, ...this.sharedScopes(p)];
	}

	/**
	 * May personal memory be used in this conversation? Only when the actor is the owner acting in their own personal space AND nobody else can
	 * read the conversation. A conversation inside a container project that has read shares is readable by others, so it counts as shared:
	 * no personal memory there (nothing is injected, nothing is exposed through tools).
	 */
	async personalAllowed(p: Principal | null | undefined, space: Space, conversationId: number | undefined): Promise<boolean> {
		if (!p || p.orgId !== space.orgId || space.kind !== "personal" || space.ownerUserId !== p.userId || !this.#live(p)) return false;
		if (conversationId === undefined || !Number.isInteger(conversationId) || conversationId <= 0) return true;
		let projectId: string | null = null;
		try {
			const rt = this.ctx.services.has("runtime") ? (this.ctx.services.get("runtime") as unknown as RuntimeLike) : undefined;
			if (rt?.projectOfConversation) projectId = await rt.projectOfConversation(space.id, conversationId);
			else projectId = this.ctx.db.get<{ project_id: string | null }>("SELECT project_id FROM rt_conversations WHERE space_id = ? AND conversation_id = ? AND deleted_at IS NULL", space.id, conversationId)?.project_id ?? null;
		} catch {
			return false; // cannot tell who can read this conversation: stay on the safe side
		}
		if (projectId) {
			const shared = this.ctx.db.get(
				"SELECT 1 FROM id_project_shares s JOIN id_projects pr ON pr.id = s.project_id WHERE s.project_id = ? AND pr.kind = 'container' AND pr.archived_at IS NULL LIMIT 1",
				projectId,
			);
			if (shared) return false;
		}
		// an active external share link on this very conversation also makes it readable by others
		try {
			const link = this.ctx.db.get(
				"SELECT 1 FROM id_share_links WHERE resource_kind = 'conversation' AND resource_id = ? AND space_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1",
				String(conversationId),
				space.id,
				new Date().toISOString(),
			);
			if (link) return false;
		} catch {
			/* no share-links table */
		}
		return true;
	}

	async scopesFor(p: Principal | null | undefined, space: Space, conversationId: number | undefined): Promise<ConversationScopes> {
		if (!p || p.orgId !== space.orgId || !this.#live(p)) return { personal: false, org: false };
		const personal = await this.personalAllowed(p, space, conversationId);
		const projectId = space.kind === "project" && space.projectId && this.can(p, { kind: "project", projectId: space.projectId }).read ? space.projectId : undefined;
		return { personal, ...(projectId ? { projectId } : {}), org: true };
	}

	// ---------------------------------------------------------------- paths
	/** A clean memory-relative path: no empty / dot segments, bounded depth and length. Existing files of any name are readable; writes need Markdown. */
	cleanRel(rel: string, forWrite: boolean): string {
		const segs = rel.split("/").filter((s) => s !== "");
		if (!segs.length) throw new VfsError("bad_path", "需要文件路径");
		if (segs.length > MAX_DEPTH) throw new VfsError("bad_path", `目录层级过深（最多 ${MAX_DEPTH} 层）`);
		for (const s of segs) {
			if (s === "." || s === ".." || s.includes("\0") || s.includes("\\")) throw new VfsError("bad_path", "路径无效");
			if (s.length > MAX_SEGMENT) throw new VfsError("bad_path", "文件名过长");
			if (forWrite && (s.startsWith(".") || /[\u0000-\u001f\u007f:*?"<>|]/.test(s))) throw new VfsError("bad_path", `名称 ${s} 无效：不能以 . 开头，也不能包含特殊字符`);
		}
		if (forWrite && !isMarkdownName(segs[segs.length - 1]!)) throw new VfsError("bad_path", "记忆文件必须是 Markdown（.md）");
		return segs.join("/");
	}

	// ---------------------------------------------------------------- reads
	list(p: Principal, scope: MemScope): MemFile[] {
		this.#require(p, scope, false);
		const root = this.dirOf(p.orgId, scope, p.userId);
		const out: MemFile[] = [];
		for (const f of hostWalk(root, "")) {
			let node;
			try {
				node = hostNode(root, f.rel, "/m", { file: [], dir: [] }, true);
			} catch {
				continue;
			}
			if (!node || node.type !== "file") continue;
			out.push({ path: f.rel, name: node.name, size: node.size ?? 0, mtime: node.mtime ?? "", etag: node.etag ?? "", markdown: isMarkdownName(node.name) });
		}
		// MEMORY.md first, then the rest by path
		return out.sort((a, b) => (a.path === INDEX_FILE ? -1 : b.path === INDEX_FILE ? 1 : a.path.localeCompare(b.path)));
	}

	read(p: Principal, scope: MemScope, rel: string): { file: MemFile; content: string; bytes: Uint8Array } {
		this.#require(p, scope, false);
		const clean = this.cleanRel(rel, false);
		const root = this.dirOf(p.orgId, scope, p.userId);
		const bytes = hostRead(root, clean, "/memory", MEMORY_FILE_MAX * 4);
		const node = hostNode(root, clean, "/memory", { file: [], dir: [] })!;
		return {
			bytes,
			content: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
			file: { path: clean, name: node.name, size: bytes.length, mtime: node.mtime ?? "", etag: sha256(bytes), markdown: isMarkdownName(node.name) },
		};
	}

	/** The index text for the prompt (no permission check: callers decide which scopes apply). Fresh read, never cached. */
	readIndexRaw(orgId: string, scope: MemScope, userId: string): { text: string; topics: string[] } | null {
		const root = this.dirOf(orgId, scope, userId);
		let bytes: Uint8Array;
		try {
			bytes = hostRead(root, INDEX_FILE, "/memory", MEMORY_FILE_MAX * 4);
		} catch {
			return null;
		}
		const topics: string[] = [];
		try {
			for (const f of hostWalk(root, "")) if (f.rel !== INDEX_FILE && isMarkdownName(f.rel) && topics.length < 30) topics.push(f.rel);
		} catch {
			/* listing is best-effort */
		}
		return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), topics };
	}

	// ---------------------------------------------------------------- writes
	/**
	 * Write a Markdown file. `ifMatch`: the etag the writer last saw ("" = the file must not exist yet). A mismatch throws etag_mismatch (409) and
	 * changes nothing. Without `ifMatch` an existing file is refused (callers that really mean "overwrite" must say what they overwrite).
	 */
	write(p: Principal, scope: MemScope, rel: string, content: string | Uint8Array, opts: { ifMatch?: string; requireIfMatch?: boolean } = {}): { file: MemFile; status: "created" | "updated" | "unchanged" } {
		this.#require(p, scope, true);
		const clean = this.cleanRel(rel, true);
		if (scope.kind === "personal" && clean.split("/")[0] === "shared") throw new VfsError("bad_path", "shared 是保留名称（共享记忆目录），请换一个名称");
		const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
		if (bytes.length > MEMORY_FILE_MAX) throw new VfsError("too_large", `记忆文件过大（${Math.round(bytes.length / 1024)} KB），上限 ${MEMORY_FILE_MAX / 1024} KB；请拆分为多个主题文件`, 413);
		if (bytes.includes(0)) throw new VfsError("binary", "记忆文件必须是文本");
		const root = this.dirOf(p.orgId, scope, p.userId);
		const existing = hostNode(root, clean, "/memory", { file: [], dir: [] }, true);
		if (existing?.type === "dir") throw new VfsError("not_a_file", `${clean} 是目录`);
		if (existing && opts.ifMatch === undefined && opts.requireIfMatch) throw new HttpError(428, "if_match_required", "覆盖已有记忆文件需要 If-Match（最近一次读取到的 etag）");
		if (opts.ifMatch !== undefined && opts.ifMatch !== (existing?.etag ?? "")) throw this.#conflict(clean);
		const used = dirSize(root).bytes;
		if (used - (existing?.size ?? 0) + bytes.length > storeQuotaBytes()) throw new VfsError("quota", `记忆目录已满（上限 ${fmtSize(storeQuotaBytes())}），请先删除不需要的文件`, 507);
		let r;
		try {
			r = hostWriteAtomic(root, clean, "/memory", bytes, opts.ifMatch);
		} catch (e) {
			if (e instanceof VfsError && e.code === "etag_mismatch") throw this.#conflict(clean);
			throw e;
		}
		const node = hostNode(root, clean, "/memory", { file: [], dir: [] }, true)!;
		return { file: { path: clean, name: node.name, size: node.size ?? 0, mtime: node.mtime ?? "", etag: node.etag ?? "", markdown: true }, status: r.before === null ? "created" : r.before === r.after ? "unchanged" : "updated" };
	}

	#conflict(rel: string): VfsError {
		return new VfsError("etag_mismatch", `记忆文件 ${rel} 已被修改（可能是 Agent 或另一个窗口刚更新了它）：你的修改没有保存，也没有覆盖对方的内容。请重新读取最新内容后再修改。`, 409);
	}

	/** Delete a file; for topic files the link line in MEMORY.md goes with it. */
	remove(p: Principal, scope: MemScope, rel: string, opts: { ifMatch?: string } = {}): { removed: string; indexUpdated: boolean } {
		this.#require(p, scope, true);
		const clean = this.cleanRel(rel, false);
		const root = this.dirOf(p.orgId, scope, p.userId);
		const node = hostNode(root, clean, "/memory", { file: [], dir: [] }, true);
		if (!node) throw new VfsError("not_found", `${clean} 不存在`, 404);
		if (node.type === "dir") throw new VfsError("not_a_file", `${clean} 是目录：请逐个删除其中的文件`);
		if (opts.ifMatch !== undefined && opts.ifMatch !== node.etag) throw this.#conflict(clean);
		hostRemove(root, clean, "/memory", false);
		let indexUpdated = false;
		if (clean !== INDEX_FILE) indexUpdated = this.#dropIndexLine(root, clean);
		return { removed: clean, indexUpdated };
	}

	/** Remove list-item lines of MEMORY.md that link to / name the deleted file. Never touches anything else. */
	#dropIndexLine(root: string, rel: string): boolean {
		let text: string;
		try {
			text = new TextDecoder().decode(hostRead(root, INDEX_FILE, "/memory", MEMORY_FILE_MAX * 4));
		} catch {
			return false;
		}
		const lines = text.split("\n");
		const kept = lines.filter((l) => !indexLineRefers(l, rel));
		if (kept.length === lines.length) return false;
		hostWriteAtomic(root, INDEX_FILE, "/memory", new TextEncoder().encode(kept.join("\n")));
		return true;
	}

	/** New topic file: personal → projects/<slug>.md, shared → <slug>.md; a link line is added to MEMORY.md. */
	createTopic(p: Principal, scope: MemScope, title: string, content?: string): { file: MemFile } {
		this.#require(p, scope, true);
		const name = title.trim();
		if (!name || name.length > 80) throw new VfsError("bad_path", "主题名称需要 1–80 个字符");
		const slug = name.normalize("NFC").replace(/[\\/:*?"<>|\u0000-\u001f\u007f\s]+/g, "-").replace(/^[.-]+|-+$/g, "").slice(0, 60);
		if (!slug) throw new VfsError("bad_path", "主题名称无效");
		const rel = scope.kind === "personal" ? `projects/${slug}.md` : `${slug}.md`;
		const root = this.dirOf(p.orgId, scope, p.userId);
		if (hostNode(root, rel, "/memory", { file: [], dir: [] })) throw new VfsError("exists", `主题 ${rel} 已存在`, 409);
		const r = this.write(p, scope, rel, content ?? `# ${name}\n\n`, { ifMatch: "" });
		// index line (created when MEMORY.md does not exist yet)
		const idx = hostNode(root, INDEX_FILE, "/memory", { file: [], dir: [] }, true);
		const line = `- [${name}](${rel})`;
		const base = idx ? new TextDecoder().decode(hostRead(root, INDEX_FILE, "/memory", MEMORY_FILE_MAX * 4)) : "# 长期记忆\n\n## 主题\n";
		this.write(p, scope, INDEX_FILE, `${base.replace(/\n*$/, "\n")}${line}\n`, { ifMatch: idx?.etag ?? "" });
		return r;
	}

	/** Virtual path of a scope-relative file as the agent sees it. */
	vpath(scope: MemScope, rel: string): string {
		return scope.kind === "personal" ? `/memory/${rel}` : scope.kind === "org" ? `/memory/shared/org/${rel}` : `/memory/shared/project/${scope.projectId}/${rel}`;
	}

	/** Legacy memory_save: append one line to the category file of its kind (exact duplicates are not added twice) and make sure the index names the file. */
	appendNote(p: Principal, scope: MemScope, kind: "preference" | "fact" | "constraint" | "background", content: string): { vpath: string; status: "created" | "updated" | "unchanged" } {
		const file = kind === "preference" ? "preferences.md" : kind === "background" ? "profile.md" : "facts.md";
		const title = kind === "preference" ? "偏好" : kind === "background" ? "背景" : "事实与约束";
		const line = `- ${content.replace(/\s*\n+\s*/g, " ").trim()}`;
		if (line.length < 3) throw new VfsError("bad_path", "记忆内容不能为空");
		const root = this.dirOf(p.orgId, scope, p.userId);
		const cur = hostNode(root, file, "/memory", { file: [], dir: [] }, true);
		const old = cur ? new TextDecoder().decode(hostRead(root, file, "/memory", MEMORY_FILE_MAX * 4)) : `# ${title}\n\n`;
		if (old.split("\n").some((l) => l.trim() === line)) return { vpath: this.vpath(scope, file), status: "unchanged" };
		const r = this.write(p, scope, file, `${old.replace(/\n*$/, "\n")}${line}\n`, { ifMatch: cur?.etag ?? "" });
		const idx = hostNode(root, INDEX_FILE, "/memory", { file: [], dir: [] }, true);
		const text = idx ? new TextDecoder().decode(hostRead(root, INDEX_FILE, "/memory", MEMORY_FILE_MAX * 4)) : "# 长期记忆\n\n## 主题\n";
		if (!text.split("\n").some((l) => indexLineRefers(l, file))) this.write(p, scope, INDEX_FILE, `${text.replace(/\n*$/, "\n")}- [${title}](${file})\n`, { ifMatch: idx?.etag ?? "" });
		return { vpath: this.vpath(scope, file), status: r.status };
	}

	/** Non-Markdown files in a personal directory (reported by the migration; they stay where they are). */
	nonMarkdownFiles(orgId: string, userId: string): string[] {
		const root = this.personalDir(orgId, userId);
		const out: string[] = [];
		try {
			resolveHost(root, "");
			for (const f of hostWalk(root, "")) if (!isMarkdownName(f.rel)) out.push(f.rel);
		} catch {
			/* directory absent */
		}
		return out;
	}
}

/** Does this MEMORY.md line reference the file? Only list items count; links may be relative or written as /memory/… paths. */
export function indexLineRefers(line: string, rel: string): boolean {
	if (!/^\s*(?:[-*+]|\d+[.)])\s/.test(line)) return false;
	const norm = (t: string): string => {
		let x = t.trim();
		try {
			x = decodeURIComponent(x);
		} catch {
			/* keep */
		}
		x = x.replace(/#.*$/, "").replace(/^\.\//, "").replace(/^\/memory\/shared\/project\/[^/]+\//, "").replace(/^\/memory\/shared\/org\//, "").replace(/^\/memory\//, "");
		return x;
	};
	for (const m of line.matchAll(/\]\(([^)\s]+)[^)]*\)/g)) if (norm(m[1]!) === rel) return true;
	// bare mention in backticks or plain: delimited by characters that cannot be part of a path
	const esc = rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|[^\\w./\\u4e00-\\u9fff-])(?:/memory/)?${esc}(?:$|[^\\w./-])`).test(line);
}

