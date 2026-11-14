// Longest-prefix router over the virtual roots. Every agent file operation enters here; the router normalizes the path, picks the backend,
// enforces "unknown root = structured error" (never a host fallback) and implements the generic parts (root listing, search by walking).
import { effectiveMime, isTextMime } from "../files/mime.ts";
import { joinVirtual, normalizeVirtual, splitRoot } from "./path.ts";
import { ROOT_ORDER, VfsError, type ListResult, type SearchHit, type VfsBackend, type VfsContext, type VNode, type WriteResult } from "./types.ts";

export const DEFAULT_LIST_LIMIT = 200;
export const MAX_LIST_LIMIT = 1000;
export const SEARCH_LIMIT = 100;
const SEARCH_FILE_MAX = 2 * 1024 * 1024;

export class VfsRouter {
	readonly #backends = new Map<string, VfsBackend>();

	register(b: VfsBackend): void {
		this.#backends.set(b.root, b);
	}
	backend(root: string): VfsBackend | undefined {
		return this.#backends.get(root);
	}

	/** Resolve a (possibly relative) path to its backend. "/" has no backend (the root listing is the router's own). */
	resolve(path: unknown): { path: string; root: string; rel: string; backend: VfsBackend | null } {
		const p = normalizeVirtual(path);
		const { root, rel } = splitRoot(p);
		if (root === "/") return { path: p, root, rel, backend: null };
		const b = this.#backends.get(root);
		if (!b) throw new VfsError("unknown_root", `未知目录 ${root}：可用的根目录是 ${[...this.#backends.keys()].join("、")}`, 404);
		return { path: p, root, rel, backend: b };
	}

	async roots(ctx: VfsContext): Promise<VNode[]> {
		const out: VNode[] = [];
		for (const r of ROOT_ORDER) {
			const b = this.#backends.get(r);
			if (!b || !(await b.available(ctx))) continue;
			out.push({ path: r, name: r.slice(1), type: "dir", caps: await b.rootCaps(ctx), note: b.label });
		}
		return out;
	}

	async #usable(ctx: VfsContext, b: VfsBackend): Promise<void> {
		if (!(await b.available(ctx))) throw new VfsError("unavailable", `${b.root} 在当前会话中不可用`, 403);
	}

	/** " 提示" text for a path that does not exist (empty when the backend has no suggestion). Never throws. */
	async hint(ctx: VfsContext, path: unknown): Promise<string> {
		try {
			const r = this.resolve(path);
			if (!r.backend?.suggest || !r.rel) return "";
			const h = await r.backend.suggest(ctx, r.rel);
			return h ? ` ${h}` : "";
		} catch {
			return "";
		}
	}

	/** Run a backend operation; a not_found from it gets the backend's suggestion appended. */
	async #withHint<T>(ctx: VfsContext, r: { path: string; backend: VfsBackend | null }, fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (e) {
			if (e instanceof VfsError && e.code === "not_found" && r.backend?.suggest) {
				const h = await this.hint(ctx, r.path);
				if (h) throw new VfsError("not_found", `${e.message}${h}`, e.status);
			}
			throw e;
		}
	}

	async stat(ctx: VfsContext, path: unknown): Promise<VNode | null> {
		const r = this.resolve(path);
		if (!r.backend) return { path: "/", name: "", type: "dir", caps: ["read"] };
		await this.#usable(ctx, r.backend);
		return r.backend.stat(ctx, r.rel);
	}

	async list(ctx: VfsContext, path: unknown, opts: { cursor?: string; limit?: number } = {}): Promise<ListResult & { path: string }> {
		const r = this.resolve(path);
		const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT);
		if (!r.backend) return { path: "/", entries: await this.roots(ctx), truncated: false };
		await this.#usable(ctx, r.backend);
		const backend = r.backend;
		return { path: r.path, ...(await this.#withHint(ctx, r, () => backend.list(ctx, r.rel, { cursor: opts.cursor, limit }))) };
	}

	async read(ctx: VfsContext, path: unknown): Promise<{ node: VNode; bytes: Uint8Array }> {
		const r = this.resolve(path);
		if (!r.backend) throw new VfsError("not_a_file", "/ 是目录，请用 ls");
		await this.#usable(ctx, r.backend);
		const backend = r.backend;
		return this.#withHint(ctx, r, () => backend.read(ctx, r.rel));
	}

	async write(ctx: VfsContext, path: unknown, bytes: Uint8Array, opts: { expectedEtag?: string } = {}): Promise<WriteResult> {
		const r = this.resolve(path);
		if (!r.backend) throw new VfsError("read_only", "不能在 / 下直接写文件");
		await this.#usable(ctx, r.backend);
		if (!r.backend.write) throw new VfsError("read_only", `${r.root} 是只读目录`, 403);
		return r.backend.write(ctx, r.rel, bytes, opts);
	}

	async remove(ctx: VfsContext, path: unknown, opts: { recursive?: boolean } = {}): Promise<{ removed: string }> {
		const r = this.resolve(path);
		if (!r.backend || !r.rel) throw new VfsError("forbidden", `不能删除 ${r.path}`, 403);
		await this.#usable(ctx, r.backend);
		if (!r.backend.remove) throw new VfsError("read_only", `${r.root} 中的内容不能删除`, 403);
		return r.backend.remove(ctx, r.rel, opts);
	}

	async search(ctx: VfsContext, path: unknown, query: string, mode: "name" | "content", limit = SEARCH_LIMIT): Promise<{ hits: SearchHit[]; truncated: boolean }> {
		const q = query.trim();
		if (!q) throw new VfsError("bad_path", "query 不能为空");
		const r = this.resolve(path);
		const cap = Math.min(Math.max(1, limit), SEARCH_LIMIT);
		if (!r.backend) {
			const hits: SearchHit[] = [];
			let truncated = false;
			for (const root of await this.roots(ctx)) {
				const sub = await this.search(ctx, root.path, q, mode, cap - hits.length);
				hits.push(...sub.hits);
				truncated ||= sub.truncated;
				if (hits.length >= cap) return { hits: hits.slice(0, cap), truncated: true };
			}
			return { hits, truncated };
		}
		await this.#usable(ctx, r.backend);
		if (r.backend.search) {
			const out = await r.backend.search(ctx, r.rel, q, mode, cap);
			return { hits: [...out.hits], truncated: out.truncated };
		}
		return this.#walkSearch(ctx, r.backend, r.rel, q, mode, cap);
	}

	/** Generic search by walking `list` (backends whose content is not a host directory). */
	async #walkSearch(ctx: VfsContext, b: VfsBackend, rel: string, q: string, mode: "name" | "content", cap: number): Promise<{ hits: SearchHit[]; truncated: boolean }> {
		const hits: SearchHit[] = [];
		const lower = q.toLowerCase();
		const stack = [rel];
		let visited = 0;
		while (stack.length) {
			const dir = stack.pop()!;
			let page: ListResult;
			try {
				page = await b.list(ctx, dir, { limit: MAX_LIST_LIMIT });
			} catch (e) {
				if (e instanceof VfsError && e.code === "not_a_directory") {
					// searching a single file
					page = { entries: [(await b.stat(ctx, dir))!].filter(Boolean), truncated: false };
				} else throw e;
			}
			for (const n of page.entries) {
				if (++visited > 5000) return { hits, truncated: true };
				const childRel = n.path.slice(b.root.length + 1);
				if (n.type === "dir") {
					if (mode === "name" && n.name.toLowerCase().includes(lower)) hits.push({ path: n.path });
					stack.push(childRel);
					continue;
				}
				if (mode === "name") {
					if (n.name.toLowerCase().includes(lower)) hits.push({ path: n.path });
				} else if ((n.size ?? 0) <= SEARCH_FILE_MAX && isTextMime(n.mime ?? effectiveMime(undefined, n.name))) {
					const { bytes } = await b.read(ctx, childRel);
					grep(n.path, bytes, lower, hits, cap);
				}
				if (hits.length >= cap) return { hits: hits.slice(0, cap), truncated: true };
			}
		}
		return { hits, truncated: false };
	}
}

/** Case-insensitive line match into `hits` (line text clipped). */
export function grep(path: string, bytes: Uint8Array, lowerQuery: string, hits: SearchHit[], cap: number): void {
	if (bytes.includes(0)) return;
	const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	const lines = text.split("\n");
	for (let i = 0; i < lines.length && hits.length < cap; i++) {
		if (lines[i]!.toLowerCase().includes(lowerQuery)) hits.push({ path, line: i + 1, text: lines[i]!.trim().slice(0, 200) });
	}
}

export { joinVirtual };
