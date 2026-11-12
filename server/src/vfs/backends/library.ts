// /library/<folder>/<name>: the delivered outputs (present_file) the current identity may read, one folder per conversation. A view of the
// same rows the chat cards and the library page use (lib_items): no second state. Writing goes through present_file; removing withdraws.
import type { AppContext } from "../../core/contracts.ts";
import type { Library, LibRow } from "../../files/library.ts";
import type { Files } from "../../files/service.ts";
import { VfsError, type Cap, type VfsBackend, type VfsContext, type VNode } from "../types.ts";

const FILE_CAPS_RW: readonly Cap[] = ["read", "remove"];
const FILE_CAPS_RO: readonly Cap[] = ["read"];

export class LibraryBackend implements VfsBackend {
	readonly root = "/library";
	readonly label = "已交付的成果（按会话分目录；交付请用 present_file）";
	readonly #ctx: AppContext;
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}
	get #lib(): Library {
		return (this.#ctx.services as any).get("library") as Library;
	}
	get #files(): Files {
		return this.#ctx.services.get("files") as unknown as Files;
	}
	available(): boolean {
		return (this.#ctx.services as any).has("library");
	}
	rootCaps(): readonly Cap[] {
		return ["read"];
	}

	async #canWrite(ctx: VfsContext, r: LibRow): Promise<boolean> {
		return (await this.#ctx.services.get("acl").check(ctx.principal, "write", { kind: "space", id: r.space_id })).allow;
	}
	async #node(ctx: VfsContext, r: LibRow): Promise<VNode> {
		return { path: `/library/${r.folder}/${r.name}`, name: r.name, type: "file", size: r.size, mtime: r.updated_at, mime: r.mime, etag: r.sha256, caps: (await this.#canWrite(ctx, r)) ? FILE_CAPS_RW : FILE_CAPS_RO };
	}
	/** Active rows of one folder, if the caller may read that conversation. */
	async #folderRows(ctx: VfsContext, folder: string): Promise<LibRow[] | null> {
		const f = this.#lib.byFolder(ctx.space.orgId, folder);
		if (!f) return null;
		const d = await this.#ctx.services.get("acl").check(ctx.principal, "read", { kind: "conversation", id: String(f.conversation_id), spaceId: f.space_id });
		if (!d.allow) return null; // another person's outputs look exactly like nothing (no existence leak)
		return this.#ctx.db.all<LibRow>("SELECT * FROM lib_items WHERE space_id = ? AND conversation_id = ? AND status = 'active' ORDER BY name", f.space_id, f.conversation_id);
	}
	async #find(ctx: VfsContext, rel: string): Promise<{ folder: string; rows: LibRow[] | null; row?: LibRow }> {
		const [folder, ...rest] = rel.split("/");
		const rows = await this.#folderRows(ctx, folder!);
		if (!rest.length) return { folder: folder!, rows };
		return { folder: folder!, rows, row: rows?.find((r) => r.name === rest.join("/")) };
	}

	async stat(ctx: VfsContext, rel: string): Promise<VNode | null> {
		if (!rel) return { path: "/library", name: "library", type: "dir", caps: ["read"] };
		const f = await this.#find(ctx, rel);
		if (!f.rows) return null;
		if (!rel.includes("/")) return { path: `/library/${f.folder}`, name: f.folder, type: "dir", caps: ["read"] };
		return f.row ? this.#node(ctx, f.row) : null;
	}

	async list(ctx: VfsContext, rel: string, opts: { cursor?: string; limit: number }) {
		let entries: VNode[];
		if (!rel) {
			const items = await this.#lib.listFor(ctx.principal, { limit: 2000 });
			const folders = new Map<string, { n: number; updated: string }>();
			for (const it of items) {
				const cur = folders.get(it.folder);
				folders.set(it.folder, { n: (cur?.n ?? 0) + 1, updated: !cur || it.updatedAt > cur.updated ? it.updatedAt : cur.updated });
			}
			entries = [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, v]) => ({ path: `/library/${name}`, name, type: "dir" as const, mtime: v.updated, caps: ["read"] as const, note: `${v.n} 个成果` }));
		} else {
			if (rel.includes("/")) throw new VfsError("not_a_directory", `/library/${rel} 不是目录`);
			const rows = await this.#folderRows(ctx, rel);
			if (!rows) throw new VfsError("not_found", `/library/${rel} 不存在`, 404);
			entries = await Promise.all(rows.map((r) => this.#node(ctx, r)));
		}
		const start = opts.cursor ? entries.findIndex((e) => e.name > opts.cursor!) : 0;
		const page = start < 0 ? [] : entries.slice(start, start + opts.limit);
		return { entries: page, truncated: start >= 0 && start + opts.limit < entries.length };
	}

	async read(ctx: VfsContext, rel: string) {
		const f = await this.#find(ctx, rel);
		if (!f.row) throw new VfsError(rel.includes("/") ? "not_found" : "not_a_file", rel.includes("/") ? `/library/${rel} 不存在` : `/library/${rel} 是目录，请用 ls`, rel.includes("/") ? 404 : 400);
		const { bytes } = await this.#files.requireVersion(ctx.principal, f.row.file_id, f.row.version_id);
		return { node: await this.#node(ctx, f.row), bytes };
	}

	async write(): Promise<never> {
		throw new VfsError("use_present_file", "文件库只接收交付：请先把文件写到 /work，再用 present_file 交付（同名会覆盖当前文件）", 403);
	}

	async remove(ctx: VfsContext, rel: string) {
		const f = await this.#find(ctx, rel);
		if (!f.row) throw new VfsError("not_found", `/library/${rel} 不存在`, 404);
		if (!(await this.#canWrite(ctx, f.row))) throw new VfsError("forbidden", "你没有权限撤回这个成果", 403);
		await this.#lib.remove(ctx.principal, f.row.file_id);
		return { removed: `/library/${rel}` };
	}
}
