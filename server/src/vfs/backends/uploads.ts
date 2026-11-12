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
	readonly at?: number;
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
					out.push({ msg: `m${e.id}`, name, fileId: a.fileId, versionId: a.versionId });
				}
			}
			if (!p.next) break;
			cursor = p.next;
		}
		return out;
	}

	#find(refs: UploadRef[], rel: string): { msg?: string; ref?: UploadRef } {
		const [msg, ...rest] = rel.split("/");
		if (!rest.length) return { msg };
		return { msg, ref: refs.find((r) => r.msg === msg && r.name === rest.join("/")) };
	}

	#node(r: UploadRef, size?: number): VNode {
		return { path: `/uploads/${r.msg}/${r.name}`, name: r.name, type: "file", mime: effectiveMime(undefined, r.name), caps: RO, ...(size !== undefined ? { size } : {}) };
	}

	async stat(ctx: VfsContext, rel: string): Promise<VNode | null> {
		if (!rel) return { path: "/uploads", name: "uploads", type: "dir", caps: RO };
		const refs = await this.refs(ctx);
		const { msg, ref } = this.#find(refs, rel);
		if (!rel.includes("/")) return refs.some((r) => r.msg === msg) ? { path: `/uploads/${msg}`, name: msg!, type: "dir", caps: RO } : null;
		if (!ref) return null;
		const v = this.#files.versionRow(ref.versionId);
		return this.#node(ref, v?.size);
	}

	async list(ctx: VfsContext, rel: string, opts: { cursor?: string; limit: number }) {
		const refs = await this.refs(ctx);
		let entries: VNode[];
		if (!rel) {
			const msgs = [...new Set(refs.map((r) => r.msg))];
			entries = msgs.map((m) => ({ path: `/uploads/${m}`, name: m, type: "dir" as const, caps: RO, note: `${refs.filter((r) => r.msg === m).length} 个附件` }));
		} else {
			if (rel.includes("/")) throw new VfsError("not_a_directory", `/uploads/${rel} 不是目录`);
			const mine = refs.filter((r) => r.msg === rel);
			if (!mine.length) throw new VfsError("not_found", `/uploads/${rel} 不存在`, 404);
			entries = mine.map((r) => this.#node(r, this.#files.versionRow(r.versionId)?.size));
		}
		const start = opts.cursor ? entries.findIndex((e) => e.name > opts.cursor!) : 0;
		const page = start < 0 ? [] : entries.slice(start, start + opts.limit);
		return { entries: page, truncated: start >= 0 && start + opts.limit < entries.length };
	}

	async read(ctx: VfsContext, rel: string) {
		const refs = await this.refs(ctx);
		const { ref } = this.#find(refs, rel);
		if (!ref) throw new VfsError("not_found", `/uploads/${rel} 不存在`, 404);
		try {
			const r = await this.#files.requireVersion(ctx.principal, ref.fileId, ref.versionId);
			return { node: this.#node(ref, r.bytes.length), bytes: r.bytes };
		} catch (e) {
			const status = (e as { status?: number }).status;
			if (status === 403) throw new VfsError("forbidden", "你没有权限读取这个附件", 403);
			if (status === 404) throw new VfsError("not_found", "附件已不存在（原文件被删除）", 404);
			throw e;
		}
	}
}
