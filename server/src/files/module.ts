// Files module (group D): file library, immutable versions, provenance, previews, downloads, deliverable tools.
import type { Context as HonoContext } from "hono";
import type { AppContext, AppEnv, Principal, WorkroomModule } from "../core/contracts.ts";
import { HttpError, principalOf } from "../core/http.ts";
import { Files, FILE_MIGRATIONS, type FileProvenanceInput } from "./service.ts";
import { renderPreview } from "./preview.ts";
import { extractText } from "./extract.ts";
import { effectiveMime } from "./mime.ts";
import { createFilesExtension } from "./extension.ts";
import type { FileDetailResponse, FileListResponse, FileTextResponse, FileUploadResponse } from "../../../shared/files.ts";

const MAX_UPLOAD = Number(process.env.WORKROOM_MAX_UPLOAD_MB ?? 100) * 1024 * 1024;

/** RFC 6266 / 5987 Content-Disposition with an ASCII fallback and a UTF-8 filename*. */
export function contentDisposition(type: "attachment" | "inline", name: string): string {
	const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\%;]/g, "_") || "file";
	const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return `${type}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

async function readUpload(c: HonoContext<AppEnv>): Promise<{ file: File; fields: Record<string, string> }> {
	const len = Number(c.req.header("content-length") ?? 0);
	if (len > MAX_UPLOAD + 64 * 1024) throw new HttpError(413, "too_large", `文件超过 ${Math.round(MAX_UPLOAD / 1048576)} MB 上限`);
	let body: Record<string, unknown>;
	try {
		body = await c.req.parseBody();
	} catch {
		throw new HttpError(400, "bad_multipart", "需要 multipart/form-data 上传");
	}
	const file = body.file;
	if (!(file instanceof File)) throw new HttpError(400, "no_file", "缺少 file 字段");
	if (file.size > MAX_UPLOAD) throw new HttpError(413, "too_large", `文件超过 ${Math.round(MAX_UPLOAD / 1048576)} MB 上限`);
	const fields: Record<string, string> = {};
	for (const [k, v] of Object.entries(body)) if (typeof v === "string") fields[k] = v;
	return { file, fields };
}

function notifyKnowledge(ctx: AppContext, fileId: string, ref: unknown, principal: Principal): void {
	if (!ctx.services.has("knowledgeAdmin")) return;
	const k = ctx.services.get("knowledgeAdmin") as any;
	Promise.resolve()
		.then(() => k.fileVersionAdded?.(fileId, ref, principal))
		.catch((e: unknown) => console.error("[files] knowledge notification failed", e));
}

export const filesModule: WorkroomModule = {
	name: "files",
	migrations: FILE_MIGRATIONS,
	init(ctx) {
		ctx.services.provide("files", new Files(ctx));
	},
	extensions(ctx) {
		return [createFilesExtension(ctx)];
	},
	routes(api, ctx) {
		const files = ctx.services.get("files") as unknown as Files;
		// ACL for ResourceRef kind "file": decided by the file's space against current membership.
		(ctx.services.get("identity") as any).registerResolver?.("file", (p: Principal, action: string, res: { id: string }) => files.decide(p, action, res.id));

		api.get("/files", async (c) => {
			const p = principalOf(c);
			const q = c.req.query();
			const out: FileListResponse = {
				files: await files.list(p, { spaceId: q.spaceId, projectId: q.projectId, q: q.q, origin: q.origin, conversationId: q.conversationId ? Number(q.conversationId) : undefined, limit: q.limit ? Number(q.limit) : undefined }),
			};
			return c.json(out);
		});

		api.post("/files", async (c) => {
			const p = principalOf(c);
			const { file, fields } = await readUpload(c);
			const space = files.resolveSpace(p, { spaceId: fields.spaceId, projectId: fields.projectId });
			const provenance: FileProvenanceInput = { createdBy: p.userId, spaceId: space.id, changeNote: fields.changeNote || undefined, origin: "upload", conversationId: fields.conversationId ? Number(fields.conversationId) : undefined };
			const ref = await files.putVersion(p, {
				name: file.name || fields.name || "upload",
				mime: effectiveMime(file.type, file.name),
				bytes: new Uint8Array(await file.arrayBuffer()),
				provenance,
				idempotencyKey: c.req.header("idempotency-key") ? `upload:${p.userId}:${c.req.header("idempotency-key")}` : undefined,
			});
			notifyKnowledge(ctx, ref.fileId, ref, p);
			const detail = await files.detail(p, ref.fileId);
			const out: FileUploadResponse = { file: detail.file, version: detail.versions.find((v) => v.versionId === ref.versionId)! };
			return c.json(out);
		});

		api.get("/files/:id", async (c) => {
			const out: FileDetailResponse = await files.detail(principalOf(c), c.req.param("id"));
			return c.json(out);
		});

		api.post("/files/:id/versions", async (c) => {
			const p = principalOf(c);
			const f = await files.requireFile(p, "write", c.req.param("id"));
			const { file, fields } = await readUpload(c);
			const ref = await files.putVersion(p, {
				fileId: f.id,
				name: fields.name || file.name || f.name,
				mime: effectiveMime(file.type, file.name || f.name),
				bytes: new Uint8Array(await file.arrayBuffer()),
				provenance: { createdBy: p.userId, spaceId: f.space_id, changeNote: fields.changeNote || undefined, origin: "upload", inputVersionIds: f.latest_version_id ? [f.latest_version_id] : undefined },
				idempotencyKey: c.req.header("idempotency-key") ? `upload:${p.userId}:${c.req.header("idempotency-key")}` : undefined,
			});
			notifyKnowledge(ctx, ref.fileId, ref, p);
			const detail = await files.detail(p, ref.fileId);
			const out: FileUploadResponse = { file: detail.file, version: detail.versions.find((v) => v.versionId === ref.versionId)! };
			return c.json(out);
		});

		api.delete("/files/:id", async (c) => {
			const p = principalOf(c);
			const f = await files.requireFile(p, "write", c.req.param("id"));
			ctx.db.run("UPDATE file_files SET deleted_at = ? WHERE id = ?", new Date().toISOString(), f.id);
			if (ctx.services.has("knowledgeAdmin")) Promise.resolve((ctx.services.get("knowledgeAdmin") as any).fileDeleted?.(f.id)).catch((e) => console.error("[files] knowledge notification failed", e));
			return c.json({ ok: true });
		});

		api.get("/files/:id/versions/:vid/download", async (c) => {
			const p = principalOf(c);
			const { version, bytes } = await files.requireVersion(p, c.req.param("id"), c.req.param("vid"));
			return new Response(bytes as Uint8Array<ArrayBuffer>, {
				headers: {
					"content-type": version.mime,
					"content-length": String(bytes.byteLength),
					"content-disposition": contentDisposition("attachment", version.name),
					"x-content-type-options": "nosniff",
					"content-security-policy": "sandbox; default-src 'none'",
					"cache-control": "private, no-store",
					etag: `"${version.sha256}"`,
				},
			});
		});

		api.get("/files/:id/versions/:vid/preview", async (c) => {
			const p = principalOf(c);
			const { version, bytes } = await files.requireVersion(p, c.req.param("id"), c.req.param("vid"));
			let pv;
			try {
				pv = await renderPreview(version.mime, version.name, bytes);
			} catch (e: any) {
				throw new HttpError(422, "preview_failed", `无法生成预览：${String(e?.message ?? e).slice(0, 200)}`);
			}
			const headers: Record<string, string> = {
				"content-type": pv.contentType,
				"content-disposition": contentDisposition("inline", version.name),
				"x-content-type-options": "nosniff",
				"cache-control": "private, no-store",
				"x-preview-kind": pv.kind,
				"referrer-policy": "no-referrer",
			};
			if (pv.csp) headers["content-security-policy"] = pv.csp;
			return new Response(pv.body as string | Uint8Array<ArrayBuffer>, { headers });
		});

		api.get("/files/:id/versions/:vid/text", async (c) => {
			const p = principalOf(c);
			const { version, bytes } = await files.requireVersion(p, c.req.param("id"), c.req.param("vid"));
			const out: FileTextResponse = await extractText(version.mime, version.name, bytes);
			return c.json(out);
		});
	},
};
