// /uploads/<message>/<name>: the files a person attached to chat messages of THIS conversation (and the history it was forked from), read-only.
// Nothing is copied: the message's AttachmentRef (fileId + versionId) is resolved through the file service, whose ACL applies on every read.
// Uploads never enter the library (round 14 §7.1): they stay attachments of their message.
import type { AppContext } from "../../core/contracts.ts";
import type { Files } from "../../files/service.ts";
import { effectiveMime } from "../../files/mime.ts";
import { VfsError, type Cap, type VfsBackend, type VfsContext, type VNode } from "../types.ts";

const RO: readonly Cap[] = ["read"];

interface UploadRef {
	readonly msg: string;
	readonly name: string;
	readonly fileId: string;
	readonly versionId: string;
	/** The name as attached (separators replaced), without the same-message de-duplication prefix. */
	readonly plain: string;
	readonly at?: number;
}

/**
 * Stable path of an attachment that is known BEFORE the message entry exists (the model-facing text is composed at submit time, when the entry id
 * "m<id>" is not yet assigned): /uploads/<versionId>/<name>. Resolved here next to the per-message layout, so conversations created before this
 * alias existed (whose messages only ever showed fileId/versionId) keep working too.
 */
export function uploadAliasPath(versionId: string, name: string): string {
	return `/uploads/${versionId}/${String(name || versionId).replace(/[\\/]/g, "_")}`;
}

export class UploadsBackend implements VfsBackend {
	readonly root = "/uploads";
	readonly label = "用户在本会话上传的原始附件（只读）";
	readonly #ctx: AppContext;
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}
	get #files(): Files {
		return this.#ctx.services.get("files") as unknown as Files;
	}
	available(): boolean {
		return this.#ctx.services.has("runtime") && this.#ctx.services.has("files");
	}
	rootCaps(): readonly Cap[] {
		return RO;
	}

	/** Every attachment of the conversation's user messages, grouped per message ("m<entryId>"), names made unique within a message. */
	async refs(ctx: VfsContext): Promise<UploadRef[]> {
		const rt = this.#ctx.services.get("runtime") as unknown as { harness(spaceId: string, c: unknown): Promise<any> };
		const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
		const harness = await rt.harness(ctx.space.id, BACKGROUND_CONTEXT);
		const conv = await harness.conversation(ctx.conversationId, BACKGROUND_CONTEXT);
		if (!conv) return [];
		const out: UploadRef[] = [];
		let cursor: unknown;
		for (let page = 0; page < 50; page++) {
			const p = await conv.entries({ order: "ascending" }, 200, cursor, BACKGROUND_CONTEXT);
			for (const e of p.items) {
				if (e.kind !== "wr.input" && e.kind !== "wr.input-unplaced") continue;
				const atts = ((e.data as { attachments?: { fileId: string; versionId: string; name: string }[] } | undefined)?.attachments ?? []).filter((a) => a && typeof a.fileId === "string" && typeof a.versionId === "string");
				const used = new Set<string>();
				for (const a of atts) {
					let name = String(a.name || a.fileId).replace(/[\\/]/g, "_");
					if (used.has(name)) name = `${a.fileId}-${name}`;
					used.add(name);
					out.push({ msg: `m${e.id}`, name, plain: String(a.name || a.fileId).replace(/[\\/]/g, "_"), fileId: a.fileId, versionId: a.versionId });
				}
			}
			if (!p.next) break;
			cursor = p.next;
		}
		return out;
	}

	/** "m<entryId>/<name>" (per message) or "<versionId>/<name>" (stable alias, usable before the message exists). */
	#find(refs: UploadRef[], rel: string): { msg?: string; ref?: UploadRef; alias?: boolean } {
		const [msg, ...rest] = rel.split("/");
		if (!rest.length) return { msg };
		const name = rest.join("/");
		const exact = refs.find((r) => r.msg === msg && r.name === name);
		if (exact) return { msg, ref: exact };
		// the alias addresses a file version; the plain attached name is accepted even when the per-message name got a de-duplication prefix
		const byVersion = refs.filter((r) => r.versionId === msg);
		const hit = byVersion.find((r) => r.name === name) ?? byVersion.find((r) => r.plain === name);
		return { msg, ref: hit, alias: byVersion.length > 0 };
	}

	/** Where a file the model asked for under a wrong path really is: same name under a /uploads/m<id> directory (and the stable alias). */
	async suggest(ctx: VfsContext, rel: string): Promise<string | null> {
		const wanted = rel.split("/").filter(Boolean).at(-1);
		if (!wanted) return null;
		const refs = await this.refs(ctx);
		const hits = refs.filter((r) => r.name === wanted || r.plain === wanted);
		if (!hits.length) {
			if (!refs.length) return "本会话还没有任何附件。";
			const names = [...new Set(refs.map((r) => r.plain))].slice(0, 8);
			return `本会话的附件：${names.join("、")}；用 ls /uploads 查看路径。`;
		}
		const paths = [...new Set(hits.slice(-3).flatMap((r) => [`/uploads/${r.msg}/${r.name}`]))];
		return `可能的正确路径：${paths.join("、")}（附件在 /uploads/m<消息编号>/ 下，不是 /uploads/ 根目录）`;
	}

	#node(r: UploadRef, size?: number, viaAlias?: string): VNode {
		return { path: viaAlias ? `/uploads/${viaAlias}/${r.plain}` : `/uploads/${r.msg}/${r.name}`, name: r.name, type: "file", mime: effectiveMime(undefined, r.name), caps: RO, ...(size !== undefined ? { size } : {}) };
	}

	async stat(ctx: VfsContext, rel: string): Promise<VNode | null> {
		if (!rel) return { path: "/uploads", name: "uploads", type: "dir", caps: RO };
		const refs = await this.refs(ctx);
		const { msg, ref, alias } = this.#find(refs, rel);
		if (!rel.includes("/")) return refs.some((r) => r.msg === msg || r.versionId === msg) ? { path: `/uploads/${msg}`, name: msg!, type: "dir", caps: RO } : null;
		if (!ref) return null;
		const v = this.#files.versionRow(ref.versionId);
		return this.#node(ref, v?.size, alias ? msg : undefined);
	}

	async list(ctx: VfsContext, rel: string, opts: { cursor?: string; limit: number }) {
		const refs = await this.refs(ctx);
		let entries: VNode[];
		if (!rel) {
			const msgs = [...new Set(refs.map((r) => r.msg))];
			entries = msgs.map((m) => ({ path: `/uploads/${m}`, name: m, type: "dir" as const, caps: RO, note: `${refs.filter((r) => r.msg === m).length} 个附件：${refs.filter((r) => r.msg === m).map((r) => r.name).slice(0, 5).join("、")}` }));
		} else {
			if (rel.includes("/")) throw new VfsError("not_a_directory", `/uploads/${rel} 不是目录`);
			const byMsg = refs.filter((r) => r.msg === rel);
			const byVersion = byMsg.length ? [] : refs.filter((r) => r.versionId === rel).slice(0, 1);
			const mine = byMsg.length ? byMsg : byVersion;
			if (!mine.length) throw new VfsError("not_found", `/uploads/${rel} 不存在`, 404);
			entries = mine.map((r) => this.#node(r, this.#files.versionRow(r.versionId)?.size, byVersion.length ? rel : undefined));
		}
		const start = opts.cursor ? entries.findIndex((e) => e.name > opts.cursor!) : 0;
		const page = start < 0 ? [] : entries.slice(start, start + opts.limit);
		return { entries: page, truncated: start >= 0 && start + opts.limit < entries.length };
	}

	async read(ctx: VfsContext, rel: string) {
		const refs = await this.refs(ctx);
		const { ref, msg, alias } = this.#find(refs, rel);
		if (!ref) throw new VfsError("not_found", `/uploads/${rel} 不存在`, 404);
		try {
			const r = await this.#files.requireVersion(ctx.principal, ref.fileId, ref.versionId);
			return { node: this.#node(ref, r.bytes.length, alias ? msg : undefined), bytes: r.bytes };
		} catch (e) {
			const status = (e as { status?: number }).status;
			if (status === 403) throw new VfsError("forbidden", "你没有权限读取这个附件", 403);
			if (status === 404) throw new VfsError("not_found", "附件已不存在（原文件被删除）", 404);
			throw e;
		}
	}
}
