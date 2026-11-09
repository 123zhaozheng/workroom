// Agent tools for deliverables: file_create / file_revise / file_read / file_list (pi-durable extension "wr.files").
//
// Replay policy (see docs/files-tools.md):
// - file_create, file_revise: replay "safe". The only side effect is FileService.putVersion with
//   idempotencyKey = tool:<conversationId>:<taskId>:<callId>:write, unique per space. A rerun after a crash regenerates the bytes
//   (possibly different, e.g. docx timestamps) but the version write is answered from the stored version, so exactly one
//   version exists per call and the tool returns the same FileVersionRef.
// - file_read, file_list: replay "safe" (read-only; ACL re-checked on the rerun).
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { arr, bool, int, nul, num, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import type { AppContext, FileVersionRef, ToolActor } from "../core/contracts.ts";
import { HttpError } from "../core/http.ts";
import { runtimeActorResolver, toolCallKey, type ActorResolver } from "./actor.ts";
import { extractText } from "./extract.ts";
import { FORMATS, generate, type DocSpec, type Format } from "./generate.ts";
import { extOf } from "./mime.ts";
import type { Files } from "./service.ts";
import type { ToolCallLog } from "../tools/calls.ts";

const cell = union([str(), num(), bool(), nul()]);
const contentFields = {
	title: opt(str({ description: "Document title (first heading / title slide / PDF title)." })),
	content: opt(str({ description: "Body as markdown-lite: '#' headings, '-' or '1.' lists, '|' tables, blank-line paragraphs, **bold**." })),
	sections: opt(arr(obj({ heading: opt(str()), body: opt(str()), bullets: opt(arr(str())) }), { description: "Structured sections (alternative to content)." })),
	table: opt(obj({ columns: arr(str()), rows: arr(arr(cell)) }, { description: "One table; for csv/xlsx the main data." })),
	sheets: opt(arr(obj({ name: str(), columns: opt(arr(str())), rows: arr(arr(cell)) }), { description: "xlsx: one entry per worksheet. Strings starting with '=' are formulas." })),
	slides: opt(arr(obj({ title: str(), bullets: opt(arr(str())), notes: opt(str()) }), { description: "pptx: one entry per slide (otherwise derived from headings)." })),
};

const refSchema = obj({ fileId: str(), versionId: str(), versionNo: int(), name: str(), mime: str(), size: int(), sha256: str() });

export interface FileToolsOptions {
	/** Override how the acting principal is resolved (tests); default: the runtime service. */
	readonly resolveActor?: ActorResolver;
}

function specOf(args: Record<string, any>): DocSpec {
	return { title: args.title, content: args.content, sections: args.sections, table: args.table, sheets: args.sheets, slides: args.slides };
}

function withExt(name: string, format: Format): string {
	const n = name.trim() || "未命名";
	return extOf(n) === format ? n : `${n.replace(/\.(md|html?|csv|docx|xlsx|pptx|pdf|txt)$/i, "")}.${format}`;
}

function artifactText(verb: string, ref: FileVersionRef): string {
	return `${verb}「${ref.name}」v${ref.versionNo}（${ref.mime}，${ref.size} 字节）。fileId=${ref.fileId} versionId=${ref.versionId}`;
}

export function createFileTools(ctx: AppContext, opts: FileToolsOptions = {}) {
	const resolve = opts.resolveActor ?? runtimeActorResolver(ctx);
	const files = () => ctx.services.get("files") as unknown as Files;
	const log = () => (ctx.services.has("toolCalls") ? (ctx.services.get("toolCalls") as ToolCallLog) : null);

	async function recorded<T>(tool: string, api: ToolExecutionApi<any>, args: unknown, context: Context, fn: (actor: ToolActor) => Promise<T>, summarize?: (r: T) => string): Promise<T> {
		const actor = await resolve(api, context);
		const l = log();
		return l ? l.around({ tool, actor, args }, () => fn(actor), summarize) : fn(actor);
	}

	async function checkInputs(actor: ToolActor, ids: readonly string[] | undefined): Promise<string[]> {
		const out: string[] = [];
		for (const id of ids ?? []) {
			const v = await files().getVersion(actor.principal, id);
			if (!v) throw new HttpError(403, "forbidden", `无权读取输入文件版本 ${id}`);
			out.push(id);
		}
		return out;
	}

	const fileCreate = defineTool({
		name: "file_create",
		description:
			"Create a deliverable file (md, html, csv, docx, xlsx, pptx or pdf) from structured content and publish it to the file library as version 1. " +
			"Returns the file and version ids; the user sees a file card with preview and download. Use file_revise to change it later.",
		parameters: obj({
			name: str({ description: "File name; the extension is set from format." }),
			format: oneOf(FORMATS),
			...contentFields,
			inputVersionIds: opt(arr(str(), { description: "File version ids this deliverable was made from (provenance)." })),
			changeNote: opt(str()),
		}),
		structuredOutputSchema: refSchema,
		replay: "safe",
		async execute(args, api, context) {
			const r = await recorded("file_create", api, { ...args, content: args.content ? `${args.content.length} 字符` : undefined }, context, async (actor) => {
				const inputs = await checkInputs(actor, args.inputVersionIds);
				const gen = await generate(args.format, specOf(args));
				const ref = await files().putVersion(actor.principal, {
					name: withExt(args.name, args.format),
					mime: gen.mime,
					bytes: gen.bytes,
					idempotencyKey: toolCallKey(actor),
					provenance: {
						createdBy: actor.principal.userId,
						spaceId: actor.space.id,
						projectId: actor.space.projectId,
						conversationId: actor.conversationId,
						taskId: actor.taskId,
						callId: actor.callId,
						inputVersionIds: inputs.length ? inputs : undefined,
						changeNote: args.changeNote ?? "初版",
						origin: actor.principal.via?.kind === "automation" ? "automation" : "agent",
						tool: "file_create",
					},
				});
				return { ref, warnings: gen.warnings };
			}, (x) => `${x.ref.fileId}/${x.ref.versionId}`);
			return {
				output: [{ type: "text", text: artifactText("已生成", r.ref) + (r.warnings.length ? `\n注意：${r.warnings.join("；")}` : "") }],
				structuredOutput: { ...r.ref },
				details: { artifact: { ...r.ref }, action: "created", warnings: r.warnings },
				diagnostics: r.warnings.map((m) => ({ severity: "warn" as const, message: m })),
			};
		},
	});

	const fileRevise = defineTool({
		name: "file_revise",
		description:
			"Publish a new immutable version of an existing file with a change note. Earlier versions stay unchanged and downloadable. " +
			"Give the complete new content (read the current version with file_read first). Pass baseVersionId to fail instead of overwriting someone else's newer version.",
		parameters: obj({
			fileId: str(),
			changeNote: str({ minLength: 1, description: "What changed in this version (shown in version history)." }),
			format: opt(oneOf(FORMATS)),
			baseVersionId: opt(str()),
			...contentFields,
			inputVersionIds: opt(arr(str())),
		}),
		structuredOutputSchema: refSchema,
		replay: "safe",
		async execute(args, api, context) {
			const r = await recorded("file_revise", api, { ...args, content: args.content ? `${args.content.length} 字符` : undefined }, context, async (actor) => {
				const f = await files().requireFile(actor.principal, "write", args.fileId);
				// A replay finds its own version by idempotency key before the base check (the base moved because of it).
				const key = toolCallKey(actor);
				const existing = ctx.db.get<{ id: string }>("SELECT id FROM file_versions WHERE space_id = ? AND idempotency_key = ?", f.space_id, key);
				if (!existing && args.baseVersionId && f.latest_version_id !== args.baseVersionId) {
					throw new HttpError(409, "version_conflict", `文件已有更新版本 v${f.latest_version_no}（${f.latest_version_id}），请先读取最新版本再修改`);
				}
				const format = (args.format ?? (FORMATS as readonly string[]).find((x) => x === extOf(f.name)) ?? "md") as Format;
				const inputs = await checkInputs(actor, [...(args.inputVersionIds ?? []), ...(f.latest_version_id ? [f.latest_version_id] : [])]);
				const gen = await generate(format, specOf(args));
				const ref = await files().putVersion(actor.principal, {
					fileId: f.id,
					name: withExt(f.name, format),
					mime: gen.mime,
					bytes: gen.bytes,
					idempotencyKey: key,
					provenance: {
						createdBy: actor.principal.userId,
						spaceId: f.space_id,
						conversationId: actor.conversationId,
						taskId: actor.taskId,
						callId: actor.callId,
						inputVersionIds: [...new Set(inputs)],
						changeNote: args.changeNote,
						origin: actor.principal.via?.kind === "automation" ? "automation" : "agent",
						tool: "file_revise",
					},
				});
				return { ref, warnings: gen.warnings };
			}, (x) => `${x.ref.fileId}/${x.ref.versionId}`);
			return {
				output: [{ type: "text", text: artifactText("已发布新版本", r.ref) }],
				structuredOutput: { ...r.ref },
				details: { artifact: { ...r.ref }, action: "revised", warnings: r.warnings },
			};
		},
	});

	const fileRead = defineTool({
		name: "file_read",
		description: "Read the text of a file version you can access (attachments, files in this space). Supports docx, xlsx, pptx, pdf, md, csv, html, text. Omit versionId for the latest version.",
		parameters: obj({
			fileId: opt(str()),
			versionId: opt(str()),
			offset: opt(int({ minimum: 0, description: "Character offset for paging long files." })),
			maxChars: opt(int({ minimum: 100, maximum: 100000 })),
		}),
		replay: "safe",
		async execute(args, api, context) {
			const r = await recorded("file_read", api, args, context, async (actor) => {
				let versionId = args.versionId;
				if (!versionId) {
					if (!args.fileId) throw new HttpError(400, "invalid", "需要 fileId 或 versionId");
					const f = await files().requireFile(actor.principal, "read", args.fileId);
					versionId = f.latest_version_id ?? undefined;
				}
				const v = versionId ? await files().getVersion(actor.principal, versionId) : null;
				if (!v) throw new HttpError(403, "forbidden", "文件版本不存在或无权读取");
				const t = await extractText(v.ref.mime, v.ref.name, v.bytes);
				const offset = args.offset ?? 0;
				const max = args.maxChars ?? 20000;
				const slice = t.text.slice(offset, offset + max);
				const more = offset + max < t.text.length;
				return { ref: v.ref, text: slice, more, total: t.text.length, kind: t.kind };
			}, (x) => `${x.ref.versionId} ${x.text.length} chars`);
			const head = `「${r.ref.name}」v${r.ref.versionNo}（${r.kind}，共 ${r.total} 字符${r.more ? `，本段到 ${(args.offset ?? 0) + r.text.length}，用 offset 继续` : ""}）`;
			return { output: [{ type: "text", text: r.text ? `${head}\n\n${r.text}` : `${head}\n\n（没有可提取的文字）` }], details: { source: { ...r.ref }, more: r.more } };
		},
	});

	const fileList = defineTool({
		name: "file_list",
		description: "List files in the current space's file library (newest first), optionally filtered by name.",
		parameters: obj({ q: opt(str()), limit: opt(int({ minimum: 1, maximum: 100 })) }),
		replay: "safe",
		async execute(args, api, context) {
			const list = await recorded("file_list", api, args, context, (actor) => files().list(actor.principal, { spaceId: actor.space.id, q: args.q, limit: args.limit ?? 30 }), (l) => `${l.length} files`);
			const text = list.length ? list.map((f) => `- ${f.name}  v${f.latestVersionNo}  ${f.mime}  fileId=${f.id} versionId=${f.latestVersionId}  更新于 ${f.updatedAt}`).join("\n") : "（没有文件）";
			return { output: [{ type: "text", text }], details: { files: list.map((f) => ({ id: f.id, name: f.name, latestVersionId: f.latestVersionId })) } };
		},
	});

	return { fileCreate, fileRevise, fileRead, fileList };
}

export function createFilesExtension(ctx: AppContext, opts: FileToolsOptions = {}) {
	const t = createFileTools(ctx, opts);
	return defineExtension({ name: "wr.files", tools: [t.fileCreate, t.fileRevise, t.fileRead, t.fileList] });
}
