// Round 11 (R5): path-prefix routing of workspace FILES to persistent host-side stores (the idea of deepagents' CompositeBackend), while
// EXECUTION keeps a single entry point (one working directory tree inside the sandbox).
//
//   <workdir>/memories/  -> a per-user folder (same org): the agent's own long-term notes/files, visible in every conversation of that user.
//   <workdir>/project/   -> a per-container-project folder, present only when the conversation belongs to a container project.
//   everything else      -> the conversation workspace, as before.
//
// This file is the ONE place that decides where a path goes and whether the caller may read/write it (`WorkspaceStores.route`). Every host
// file operation of `Sandbox` (list / preview / read / write / mkdir / delete / move, the file tools, code_run inputs and outputs, publish)
// goes through it; the drivers only receive the resolved store directories (`StoreMount`).
//
// Stores live on the host under `<dataDir>/orgs/<orgId>/stores/…`, outside every conversation directory and never as symlinks (the workspace
// layer refuses symlink escapes on purpose). They are not part of a conversation's version history (persist.ts skips these two names).
// This is NOT the DB-based 记忆 feature (server/src/knowledge/memory.ts): that one is retrieved text injected into prompts; this is files.
import { chownSync, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AppContext, Principal, Space } from "../../core/contracts.ts";
import { HttpError } from "../../core/http.ts";
import { dirSize } from "./workspace.ts";

export const STORE_NAMES = ["memories", "project"] as const;
export type StoreName = (typeof STORE_NAMES)[number];
export type StoreKind = "conversation" | StoreName;

const MB = 1024 * 1024;
/** Per-store size cap. Reuses the workspace quota setting unless WORKROOM_SANDBOX_STORE_QUOTA_MB is set. Read at call time (tests, no restart). */
export const storeQuotaBytes = (): number => Number(process.env.WORKROOM_SANDBOX_STORE_QUOTA_MB ?? process.env.WORKROOM_SANDBOX_QUOTA_MB ?? 512) * MB;

/** "512 MB", "3 KB": small caps (tests, tiny deployments) stay readable. */
export const fmtSize = (bytes: number): string => (bytes >= MB ? `${Math.round(bytes / MB)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

const LABEL: Record<StoreName, string> = { memories: "记忆目录（memories/）", project: "项目目录（project/）" };
export const storeLabel = (n: StoreName): string => LABEL[n];

const lc = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
/** The store a (clean, workspace-relative) path starts with, or null. */
export function storeNameOf(rel: string): { name: StoreName; rest: string } | null {
	const i = rel.indexOf("/");
	const first = i < 0 ? rel : rel.slice(0, i);
	const name = STORE_NAMES.find((n) => lc(n) === lc(first));
	return name ? { name, rest: i < 0 ? "" : rel.slice(i + 1) } : null;
}
export const isStoreTop = (name: string): boolean => STORE_NAMES.some((n) => lc(n) === lc(name));

/** A store a driver must make visible at <workdir>/<name>. */
export interface StoreMount {
	readonly name: StoreName;
	/** Absolute host directory (exists). */
	readonly hostPath: string;
	/** Kernel-enforced read-only for local drivers; chmod + never synced back for remote drivers. */
	readonly readOnly: boolean;
	/** Identity of what the directory holds ("memories:<userId>", "project:<id>:rw"). A remote sandbox shared by several people re-seeds the folder when it changes. */
	readonly ownerKey: string;
	/** Size cap in bytes; a remote sync-back never grows the store beyond it. */
	readonly quotaBytes: number;
	/** Bytes the store holds right now. */
	readonly usedBytes: number;
}

export interface Routed {
	readonly store: StoreKind;
	/** Host directory the path lives in (the conversation workdir or a store directory). */
	readonly root: string;
	/** Path inside `root` ("" = the root itself). */
	readonly rel: string;
	readonly writable: boolean;
	/** Prefix to put in front of `rel` to get the path as the model/UI sees it ("" for the conversation, "memories", "project"). */
	readonly prefix: string;
}

export interface StoreAccess {
	readonly dir: string;
	readonly writable: boolean;
	readonly ownerKey: string;
}

const safeSeg = (id: string): string => (/^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : createHash("sha256").update(id).digest("hex").slice(0, 32));

export class WorkspaceStores {
	readonly #ctx: AppContext;
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}

	/** `<dataDir>/orgs/<orgId>/stores` (inside `orgs/`, so a data-dir backup includes it; backups only skip the per-conversation `sandbox` directories). */
	root(orgId: string): string {
		return join(this.#ctx.config.dataDir, "orgs", safeSeg(orgId), "stores");
	}
	memoriesDir(orgId: string, userId: string): string {
		return join(this.root(orgId), "memories", safeSeg(userId));
	}
	projectDir(orgId: string, projectId: string): string {
		return join(this.root(orgId), "project", safeSeg(projectId));
	}

	// ---------------------------------------------------------------- who may use what (sync: called from sync file operations)
	/** May the principal write in this space (owner of the personal space / non-viewer member)? Re-evaluated against current state. */
	#canWriteSpace(who: Principal, space: Space): boolean {
		if (who.orgId !== space.orgId) return false;
		const id = this.#ctx.services.has("identity") ? (this.#ctx.services.get("identity") as unknown as { spaceDecision?: (p: Principal, a: string, s: Space | null) => { allow: boolean }; livePrincipal?: (p: Principal) => { live: Principal } | { reason: string } }) : undefined;
		if (id?.livePrincipal) {
			const lp = id.livePrincipal(who);
			if ("reason" in lp) return false;
			who = lp.live;
		}
		if (id?.spaceDecision) return id.spaceDecision(who, "write", space).allow;
		return space.kind === "personal" && space.ownerUserId === who.userId;
	}

	/** Catalog project of a conversation (null: none, deleted, or a subagent child without a catalog row). */
	#projectOf(space: Space, conversationId: number | undefined): string | null {
		if (conversationId === undefined || !Number.isInteger(conversationId) || conversationId <= 0) return null;
		try {
			const r = this.#ctx.db.get<{ project_id: string | null; deleted_at?: string | null }>("SELECT project_id, deleted_at FROM rt_conversations WHERE space_id = ? AND conversation_id = ?", space.id, conversationId);
			return r && !r.deleted_at ? r.project_id : null;
		} catch {
			return null; // no catalog table (unit harness)
		}
	}

	/**
	 * The stores this principal may use from this conversation.
	 *   memories: the principal's own folder, only where they can write the space (a read-only viewer of someone else's conversation never gets it).
	 *   project:  only for a CONTAINER project the conversation belongs to, whose owner's personal space holds the conversation; the owner reads and
	 *             writes, a holder of a read share reads only; everyone else gets nothing.
	 */
	access(who: Principal | undefined, space: Space, conversationId: number | undefined): { memories?: StoreAccess; project?: StoreAccess } {
		const out: { memories?: StoreAccess; project?: StoreAccess } = {};
		if (!who || who.orgId !== space.orgId) return out;
		if (conversationId !== undefined && (!Number.isInteger(conversationId) || conversationId < 0)) return out; // internal throwaway workspaces
		const writer = this.#canWriteSpace(who, space);
		if (writer) out.memories = { dir: this.memoriesDir(space.orgId, who.userId), writable: true, ownerKey: `memories:${who.userId}` };
		const projectId = this.#projectOf(space, conversationId);
		if (projectId && this.#ctx.services.has("identity")) {
			const identity = this.#ctx.services.get("identity");
			const pr = identity.containerProject(projectId);
			if (pr && pr.orgId === who.orgId && space.kind === "personal" && space.ownerUserId === pr.ownerId) {
				if (pr.ownerId === who.userId && writer) out.project = { dir: this.projectDir(pr.orgId, pr.id), writable: true, ownerKey: `project:${pr.id}:rw` };
				else if (identity.hasProjectShare(who.userId, who.orgId, projectId)) out.project = { dir: this.projectDir(pr.orgId, pr.id), writable: false, ownerKey: `project:${pr.id}:ro` };
			}
		}
		return out;
	}

	#ensure(dir: string, owner?: { uid: number; gid: number }): string {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
			if (owner) {
				try {
					chownSync(dir, owner.uid, owner.gid);
				} catch {
					/* best effort */
				}
			}
		}
		return realpathSync.native(dir);
	}

	/**
	 * THE routing function. `rel` is a clean workspace-relative path. A path that starts with `memories/` or `project/` goes to that store when the
	 * principal may use it (otherwise a plain Chinese 403/404 — never a silent fall-through into the conversation directory); every other path is the
	 * conversation's. `forWrite` additionally requires the store to be writable for this principal.
	 */
	route(who: Principal | undefined, space: Space, conversationId: number | undefined, rel: string, workdir: () => string, opts: { forWrite?: boolean; owner?: { uid: number; gid: number } } = {}): Routed {
		const hit = storeNameOf(rel);
		if (!hit) return { store: "conversation", root: workdir(), rel, writable: true, prefix: "" };
		const acc = this.access(who, space, conversationId)[hit.name];
		if (!acc) {
			if (hit.name === "memories") throw new HttpError(403, "store_forbidden", "memories/ 是当前用户自己的长期目录：只有在能写入这个会话的情况下才可使用，其他人（包括分享的查看者）不能访问");
			throw new HttpError(404, "no_project_store", "这个会话不属于任何项目（或你没有该项目的访问权限），没有 project/ 目录");
		}
		if (opts.forWrite && !acc.writable) throw new HttpError(403, "project_readonly", "项目目录（project/）对你是只读的：只有项目所有者可以修改，其他成员只能读取");
		return { store: hit.name, root: this.#ensure(acc.dir, opts.owner), rel: hit.rest, writable: acc.writable, prefix: hit.name };
	}

	/** Resolved stores for a run (directories created; a store over its cap is mounted read-only and reported in `notes`). */
	mounts(who: Principal | undefined, space: Space, conversationId: number | undefined, notes: string[] = [], owner?: { uid: number; gid: number }): StoreMount[] {
		const acc = this.access(who, space, conversationId);
		const out: StoreMount[] = [];
		for (const name of STORE_NAMES) {
			const a = acc[name];
			if (!a) continue;
			const hostPath = this.#ensure(a.dir, owner);
			const used = dirSize(hostPath).bytes;
			const cap = storeQuotaBytes();
			let readOnly = !a.writable;
			if (!readOnly && used > cap) {
				readOnly = true;
				notes.push(`${storeLabel(name)}已用 ${fmtSize(used)}，超过上限 ${fmtSize(cap)}：本次以只读方式提供，请先清理再写入`);
			}
			out.push({ name, hostPath, readOnly, ownerKey: a.ownerKey, quotaBytes: cap, usedBytes: used });
		}
		return out;
	}

	/** Names of the stores this principal can see in this conversation (for the prompt and the listing). */
	available(who: Principal | undefined, space: Space, conversationId: number | undefined): StoreName[] {
		const a = this.access(who, space, conversationId);
		return STORE_NAMES.filter((n) => !!a[n]);
	}

	/** Quota check before a host-side write: `incoming` bytes replace `replacing` bytes. */
	checkQuota(name: StoreName, root: string, incoming: number, replacing = 0): void {
		const cap = storeQuotaBytes();
		const used = dirSize(root).bytes;
		if (used - replacing + incoming > cap) throw new HttpError(507, "store_quota", `${storeLabel(name)}已满：已用 ${fmtSize(used)}，上限 ${fmtSize(cap)}；请先删除不需要的文件`);
	}

	/** Top-level names of the conversation directory that a store shadows (files a conversation kept there before this feature stay on disk but are hidden). */
	shadowed(workdir: string): StoreName[] {
		const out: StoreName[] = [];
		for (const n of STORE_NAMES) {
			try {
				if (readdirSync(join(workdir, n)).length) out.push(n);
			} catch {
				/* absent */
			}
		}
		return out;
	}
}
