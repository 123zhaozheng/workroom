// /work: the conversation's working directory. The host copy is authoritative (round 7b/11): file tools read and write it directly — no
// sandbox is started for that — and `exec` runs in the configured sandbox, which syncs the same directory in and out around every command
// (remote providers) or mounts it (local drivers). So write → exec → read always observe the same files.
// A container project's shared folder (round 11 `project/`) stays visible as /work/project with its own ACL (read-only for share holders).
import { readdirSync } from "node:fs";
import type { AppContext } from "../../core/contracts.ts";
import { HttpError } from "../../core/http.ts";
import type { Sandbox } from "../../tools/sandbox.ts";
import { hostList, hostNode, hostRead, hostWalk, resolveHost, sha256 } from "../hostdir.ts";
import { grep } from "../router.ts";
import { VfsError, type Cap, type SearchHit, type VfsBackend, type VfsContext, type VNode, type WriteResult } from "../types.ts";

export const WORK_READ_MAX = 64 * 1024 * 1024;
const RW: { file: readonly Cap[]; dir: readonly Cap[] } = { file: ["read", "write", "edit", "remove", "exec"], dir: ["read", "write", "remove", "exec"] };
const RO: { file: readonly Cap[]; dir: readonly Cap[] } = { file: ["read"], dir: ["read"] };

/** Map an HttpError of the sandbox layer to a VfsError (messages are already user-facing and contain no host paths). */
export function asVfs(e: unknown): never {
	if (e instanceof VfsError) throw e;
	if (e instanceof HttpError) {
		const code = e.status === 404 ? "not_found" : e.status === 403 ? "forbidden" : e.status === 413 ? "too_large" : e.status === 507 ? "quota" : e.status === 409 ? "exists" : "bad_path";
		throw new VfsError(code, e.message, e.status);
	}
	throw e;
}

export class WorkBackend implements VfsBackend {
	readonly root = "/work";
	readonly label = "当前会话的工作区（完整沙盒，可执行命令）";
	readonly #ctx: AppContext;
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}
	get #sb(): Sandbox {
		return this.#ctx.services.get("sandbox") as Sandbox;
	}
	available(): boolean {
		return this.#ctx.services.has("sandbox");
	}
	rootCaps(): readonly Cap[] {
		return RW.dir;
	}

	/** Where a /work path lives on the host: the conversation folder or the shared project folder. */
	#loc(ctx: VfsContext, rel: string, forWrite = false): { root: string; inner: string; vroot: string; caps: typeof RW } {
		try {
			const r = this.#sb.route(ctx.space, ctx.conversationId, rel, ctx.principal, forWrite);
			if (r.store === "conversation") return { root: r.root, inner: r.rel, vroot: "/work", caps: RW };
			return { root: r.root, inner: r.rel, vroot: `/work/${r.prefix}`, caps: r.writable ? RW : RO };
		} catch (e) {
			return asVfs(e);
		}
	}
	/** Host directory of the conversation workspace (for exec cwd checks and present_file). */
	workdir(ctx: VfsContext): string {
		return this.#sb.workdir(ctx.space, ctx.conversationId);
	}

	async stat(ctx: VfsContext, rel: string): Promise<VNode | null> {
		if (!rel) return { path: "/work", name: "work", type: "dir", caps: RW.dir };
		const l = this.#loc(ctx, rel);
		return hostNode(l.root, l.inner, l.vroot, l.caps, true);
	}

	async list(ctx: VfsContext, rel: string, opts: { cursor?: string; limit: number }) {
		const l = this.#loc(ctx, rel);
		const page = hostList(l.root, l.inner, l.vroot, l.caps, { ...opts, hide: rel ? undefined : (n) => n === "project" || n === "memories" });
		if (rel) return page;
		// the root also shows the shared project folder (when this conversation belongs to a container project)
		const extra: VNode[] = [];
		for (const name of this.#sb.stores.available(ctx.principal, ctx.space, ctx.conversationId)) {
			if (name !== "project") continue;
			const p = this.#loc(ctx, name);
			if (!opts.cursor || name > opts.cursor) extra.push({ path: `/work/${name}`, name, type: "dir", caps: p.caps.dir, note: p.caps === RO ? "项目共享文件夹（只读）" : "项目共享文件夹" });
		}
		return { entries: [...extra, ...page.entries], truncated: page.truncated };
	}

	async read(ctx: VfsContext, rel: string) {
		const l = this.#loc(ctx, rel);
		const bytes = hostRead(l.root, l.inner, l.vroot, WORK_READ_MAX);
		return { node: (hostNode(l.root, l.inner, l.vroot, l.caps) ?? { path: `/work/${rel}`, name: rel, type: "file", caps: l.caps.file }) as VNode, bytes };
	}

	async write(ctx: VfsContext, rel: string, bytes: Uint8Array, opts: { expectedEtag?: string }): Promise<WriteResult> {
		const l = this.#loc(ctx, rel, true);
		if (l.caps === RO) throw new VfsError("read_only", "项目共享文件夹对你是只读的", 403);
		const before = hostNode(l.root, l.inner, l.vroot, l.caps, true);
		if (before?.type === "dir") throw new VfsError("not_a_file", `/work/${rel} 是目录`);
		if (opts.expectedEtag !== undefined && opts.expectedEtag !== (before?.etag ?? "")) throw new VfsError("etag_mismatch", `/work/${rel} 已被修改（etag 不一致），请重新读取后再写`, 409);
		if (before?.etag === sha256(bytes)) return { node: before, status: "unchanged" };
		try {
			this.#sb.writeFile(ctx.space, ctx.conversationId, rel, bytes, ctx.principal);
		} catch (e) {
			asVfs(e);
		}
		return { node: hostNode(l.root, l.inner, l.vroot, l.caps, true)!, status: before ? "updated" : "created" };
	}

	async remove(ctx: VfsContext, rel: string, opts: { recursive?: boolean }) {
		const l = this.#loc(ctx, rel, true);
		if (l.caps === RO) throw new VfsError("read_only", "项目共享文件夹对你是只读的", 403);
		const node = hostNode(l.root, l.inner, l.vroot, l.caps);
		if (!node) throw new VfsError("not_found", `/work/${rel} 不存在`, 404);
		if (node.type === "dir" && !opts.recursive && readdirSync(resolveHost(l.root, l.inner)).length) throw new VfsError("bad_path", `/work/${rel} 是非空目录：确实要删除整个目录请传 recursive: true`);
		try {
			this.#sb.remove(ctx.space, ctx.conversationId, rel, ctx.principal);
		} catch (e) {
			asVfs(e);
		}
		return { removed: node.path };
	}

	async search(ctx: VfsContext, rel: string, query: string, mode: "name" | "content", limit: number): Promise<{ hits: SearchHit[]; truncated: boolean }> {
		const l = this.#loc(ctx, rel);
		const hits: SearchHit[] = [];
		const lower = query.toLowerCase();
		for (const f of hostWalk(l.root, l.inner)) {
			const vpath = `${l.vroot}/${f.rel}`;
			if (mode === "name") {
				if (f.rel.slice(f.rel.lastIndexOf("/") + 1).toLowerCase().includes(lower)) hits.push({ path: vpath });
			} else if (f.size <= 2 * 1024 * 1024) grep(vpath, hostRead(l.root, f.rel, l.vroot, 2 * 1024 * 1024), lower, hits, limit);
			if (hits.length >= limit) return { hits: hits.slice(0, limit), truncated: true };
		}
		return { hits, truncated: false };
	}
}
