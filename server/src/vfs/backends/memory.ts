// /memory: Markdown long-term memory. The same MarkdownMemory service the front-end routes use serves this backend, so agent edits and user
// edits operate on the very same files (etag conditional writes decide conflicts).
//   /memory/<file>                 personal memory (MEMORY.md index, preferences.md, …) — ONLY in a conversation of the owner's personal
//                                  space that nobody else can read; elsewhere the personal part does not exist for this conversation
//   /memory/shared/project/<id>/…  project memory (members read; owners/editors write)
//   /memory/shared/org/…           organisation memory (members read; org admins write)
import type { AppContext } from "../../core/contracts.ts";
import { effectiveMime, isTextMime } from "../../files/mime.ts";
import { INDEX_FILE, isMarkdownName, MEMORY_FILE_MAX, type MarkdownMemory, type MemFile, type MemScope } from "../../knowledge/memory-md.ts";
import { joinVirtual } from "../path.ts";
import { grep } from "../router.ts";
import { VfsError, type Cap, type ListResult, type SearchHit, type VfsBackend, type VfsContext, type VNode, type WriteResult } from "../types.ts";

const RW_FILE: readonly Cap[] = ["read", "write", "edit", "remove"];
const RO: readonly Cap[] = ["read"];
const DIR_RW: readonly Cap[] = ["read", "write", "remove"];
/** A non-Markdown file that already lives in the personal directory: readable and removable, but not writable through the memory tools. */
const OTHER_FILE: readonly Cap[] = ["read", "remove"];

type Target = { kind: "root" } | { kind: "shared" } | { kind: "shared-project-list" } | { kind: "scope-root"; scope: MemScope; vpath: string } | { kind: "file"; scope: MemScope; inner: string; vroot: string };

export class MemoryBackend implements VfsBackend {
	readonly root = "/memory";
	readonly label = "Markdown 长期记忆（MEMORY.md 是索引；shared/ 下是项目与企业共享记忆）";
	readonly #ctx: AppContext;
	readonly #mem: MarkdownMemory;
	constructor(ctx: AppContext, mem: MarkdownMemory) {
		this.#ctx = ctx;
		this.#mem = mem;
	}

	available(): boolean {
		return true;
	}
	async rootCaps(ctx: VfsContext): Promise<readonly Cap[]> {
		return (await this.#mem.personalAllowed(ctx.principal, ctx.space, ctx.conversationId)) ? DIR_RW : RO;
	}

	async #personal(ctx: VfsContext): Promise<boolean> {
		return this.#mem.personalAllowed(ctx.principal, ctx.space, ctx.conversationId);
	}

	/** Route a path below /memory to a scope; refuses a personal path where personal memory is not available. */
	async #target(ctx: VfsContext, rel: string): Promise<Target> {
		if (!rel) return { kind: "root" };
		const segs = rel.split("/");
		if (segs[0] === "shared") {
			if (segs.length === 1) return { kind: "shared" };
			if (segs[1] === "org") return segs.length === 2 ? { kind: "scope-root", scope: { kind: "org" }, vpath: "/memory/shared/org" } : { kind: "file", scope: { kind: "org" }, inner: segs.slice(2).join("/"), vroot: "/memory/shared/org" };
			if (segs[1] === "project") {
				if (segs.length === 2) return { kind: "shared-project-list" };
				const pid = segs[2]!;
				if (!/^[A-Za-z0-9_-]{1,80}$/.test(pid)) throw new VfsError("bad_path", "项目 id 无效");
				const scope: MemScope = { kind: "project", projectId: pid };
				return segs.length === 3 ? { kind: "scope-root", scope, vpath: `/memory/shared/project/${pid}` } : { kind: "file", scope, inner: segs.slice(3).join("/"), vroot: `/memory/shared/project/${pid}` };
			}
			throw new VfsError("not_found", `/memory/${rel} 不存在（共享记忆在 shared/project/<项目id>/ 与 shared/org/）`, 404);
		}
		if (!(await this.#personal(ctx))) throw new VfsError("forbidden", "个人记忆在当前会话中不可用：只有在你自己的、没有被他人读取的个人会话里才提供个人记忆（共享项目会话不会提供任何人的个人记忆）", 403);
		return { kind: "file", scope: { kind: "personal" }, inner: rel, vroot: "/memory" };
	}

	#fileNode(f: MemFile, vroot: string, write: boolean): VNode {
		const caps = !write ? RO : f.markdown ? RW_FILE : OTHER_FILE;
		return { path: joinVirtual(vroot, f.path), name: f.name, type: "file", size: f.size, mtime: f.mtime, mime: effectiveMime(undefined, f.name), etag: f.etag, caps };
	}

	/** Files of a scope grouped into the directory level below `inner` (virtual dirs for nested paths). */
	#level(ctx: VfsContext, scope: MemScope, vroot: string, inner: string): VNode[] {
		const can = this.#mem.can(ctx.principal, scope);
		if (!can.read) throw new VfsError("forbidden", "没有权限访问这份记忆", 403);
		const files = this.#mem.list(ctx.principal, scope);
		const prefix = inner ? `${inner}/` : "";
		const dirs = new Map<string, string>();
		const out: VNode[] = [];
		for (const f of files) {
			if (!f.path.startsWith(prefix)) continue;
			const rest = f.path.slice(prefix.length);
			if (scope.kind === "personal" && !inner && rest.split("/")[0] === "shared") continue; // reserved name (the shared view)
			const slash = rest.indexOf("/");
			if (slash < 0) out.push(this.#fileNode({ ...f, name: rest }, vroot, can.write));
			else {
				const d = rest.slice(0, slash);
				if (!dirs.has(d)) dirs.set(d, f.mtime);
				else if (f.mtime > dirs.get(d)!) dirs.set(d, f.mtime);
			}
		}
		for (const [d, mtime] of dirs) out.push({ path: joinVirtual(vroot, prefix + d), name: d, type: "dir", mtime, caps: can.write ? DIR_RW : RO });
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	async stat(ctx: VfsContext, rel: string): Promise<VNode | null> {
		const t = await this.#target(ctx, rel);
		if (t.kind === "root") return { path: "/memory", name: "memory", type: "dir", caps: await this.rootCaps(ctx) };
		if (t.kind === "shared") return { path: "/memory/shared", name: "shared", type: "dir", caps: RO };
		if (t.kind === "shared-project-list") return { path: "/memory/shared/project", name: "project", type: "dir", caps: RO };
		if (t.kind === "scope-root") {
			const c = this.#mem.can(ctx.principal, t.scope);
			return c.read ? { path: t.vpath, name: t.vpath.slice(t.vpath.lastIndexOf("/") + 1), type: "dir", caps: c.write ? DIR_RW : RO } : null;
		}
		const c = this.#mem.can(ctx.principal, t.scope);
		if (!c.read) return null;
		const inner = this.#mem.cleanRel(t.inner, false);
		const files = this.#mem.list(ctx.principal, t.scope);
		const f = files.find((x) => x.path === inner);
		if (f) return this.#fileNode({ ...f, name: f.path.slice(f.path.lastIndexOf("/") + 1) }, t.vroot, c.write);
		if (files.some((x) => x.path.startsWith(`${inner}/`))) return { path: joinVirtual(t.vroot, inner), name: inner.slice(inner.lastIndexOf("/") + 1), type: "dir", caps: c.write ? DIR_RW : RO };
		return null;
	}

	async list(ctx: VfsContext, rel: string, opts: { cursor?: string; limit: number }): Promise<ListResult> {
		const t = await this.#target(ctx, rel);
		let entries: VNode[];
		if (t.kind === "root") {
			entries = (await this.#personal(ctx)) ? this.#level(ctx, { kind: "personal" }, "/memory", "") : [];
			entries.push({ path: "/memory/shared", name: "shared", type: "dir", caps: RO, note: "项目与企业共享记忆" });
			entries.sort((a, b) => a.name.localeCompare(b.name));
		} else if (t.kind === "shared") {
			entries = [
				{ path: "/memory/shared/org", name: "org", type: "dir", caps: this.#mem.can(ctx.principal, { kind: "org" }).write ? DIR_RW : RO, note: "企业记忆" },
				{ path: "/memory/shared/project", name: "project", type: "dir", caps: RO, note: "你所在项目的共享记忆" },
			];
		} else if (t.kind === "shared-project-list") {
			entries = this.#mem
				.sharedScopes(ctx.principal)
				.filter((s) => s.kind === "project")
				.map((s) => ({ path: `/memory/shared/project/${s.projectId}`, name: s.projectId!, type: "dir" as const, caps: s.writable ? DIR_RW : RO, note: s.label }));
		} else if (t.kind === "scope-root") entries = this.#level(ctx, t.scope, t.vpath, "");
		else {
			const inner = this.#mem.cleanRel(t.inner, false);
			entries = this.#level(ctx, t.scope, t.vroot, inner);
			if (!entries.length && !(await this.stat(ctx, rel))) throw new VfsError("not_found", `${joinVirtual("/memory", rel)} 不存在`, 404);
			if (!entries.length && (await this.stat(ctx, rel))?.type === "file") throw new VfsError("not_a_directory", `${joinVirtual("/memory", rel)} 不是目录`);
		}
		const start = opts.cursor ? entries.findIndex((n) => n.name > opts.cursor!) : 0;
		const page = start < 0 ? [] : entries.slice(start, start + opts.limit);
		return { entries: page, truncated: start >= 0 && start + opts.limit < entries.length };
	}

	async read(ctx: VfsContext, rel: string): Promise<{ node: VNode; bytes: Uint8Array }> {
		const t = await this.#target(ctx, rel);
		if (t.kind !== "file") throw new VfsError("not_a_file", `${joinVirtual("/memory", rel)} 是目录，请用 ls`);
		const r = this.#mem.read(ctx.principal, t.scope, t.inner);
		const can = this.#mem.can(ctx.principal, t.scope);
		return { node: this.#fileNode({ ...r.file, name: r.file.path.slice(r.file.path.lastIndexOf("/") + 1) }, t.vroot, can.write), bytes: r.bytes };
	}

	async write(ctx: VfsContext, rel: string, bytes: Uint8Array, opts: { expectedEtag?: string }): Promise<WriteResult> {
		const t = await this.#target(ctx, rel);
		if (t.kind !== "file") throw new VfsError("read_only", `${joinVirtual("/memory", rel)} 是目录，只能写其中的 .md 文件`, 403);
		const r = this.#mem.write(ctx.principal, t.scope, t.inner, bytes, { ifMatch: opts.expectedEtag });
		return { node: this.#fileNode({ ...r.file, name: r.file.path.slice(r.file.path.lastIndexOf("/") + 1) }, t.vroot, true), status: r.status };
	}

	async remove(ctx: VfsContext, rel: string): Promise<{ removed: string }> {
		const t = await this.#target(ctx, rel);
		if (t.kind !== "file") throw new VfsError("forbidden", `不能删除 ${joinVirtual("/memory", rel)}`, 403);
		const r = this.#mem.remove(ctx.principal, t.scope, t.inner);
		return { removed: joinVirtual(t.vroot, r.removed) };
	}

	/** Content / name search over exactly the files this identity can read in this conversation. */
	async search(ctx: VfsContext, rel: string, query: string, mode: "name" | "content", limit: number): Promise<{ hits: SearchHit[]; truncated: boolean }> {
		const hits: SearchHit[] = [];
		const lower = query.toLowerCase();
		const scan = (scope: MemScope, vroot: string, prefix: string): boolean => {
			const can = this.#mem.can(ctx.principal, scope);
			if (!can.read) return false;
			for (const f of this.#mem.list(ctx.principal, scope)) {
				if (prefix && !f.path.startsWith(`${prefix}/`) && f.path !== prefix) continue;
				if (scope.kind === "personal" && f.path.split("/")[0] === "shared") continue;
				const vpath = joinVirtual(vroot, f.path);
				if (mode === "name") {
					if (f.name.toLowerCase().includes(lower)) hits.push({ path: vpath });
				} else if (f.size <= MEMORY_FILE_MAX && isTextMime(effectiveMime(undefined, f.name))) {
					grep(vpath, this.#mem.read(ctx.principal, scope, f.path).bytes, lower, hits, limit);
				}
				if (hits.length >= limit) return true;
			}
			return false;
		};
		const t = await this.#target(ctx, rel);
		let full = false;
		if (t.kind === "root") {
			if (await this.#personal(ctx)) full = scan({ kind: "personal" }, "/memory", "");
			for (const s of this.#mem.sharedScopes(ctx.principal)) {
				if (full) break;
				full = scan(s.kind === "org" ? { kind: "org" } : { kind: "project", projectId: s.projectId! }, s.kind === "org" ? "/memory/shared/org" : `/memory/shared/project/${s.projectId}`, "");
			}
		} else if (t.kind === "shared" || t.kind === "shared-project-list") {
			for (const s of this.#mem.sharedScopes(ctx.principal)) {
				if (t.kind === "shared-project-list" && s.kind !== "project") continue;
				if (full) break;
				full = scan(s.kind === "org" ? { kind: "org" } : { kind: "project", projectId: s.projectId! }, s.kind === "org" ? "/memory/shared/org" : `/memory/shared/project/${s.projectId}`, "");
			}
		} else if (t.kind === "scope-root") full = scan(t.scope, t.vpath, "");
		else full = scan(t.scope, t.vroot, this.#mem.cleanRel(t.inner, false));
		return { hits: hits.slice(0, limit), truncated: full };
	}
}

export { INDEX_FILE, isMarkdownName };
