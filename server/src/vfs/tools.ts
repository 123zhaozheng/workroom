// Round 14: the agent's file and execution tools over the virtual filesystem (pi-durable extension "wr.vfs").
//   ls / read / write / edit / search / remove — any virtual root, each backend enforcing its own rules
//   exec          — the ONLY code execution: a shell command in the conversation's full sandbox, cwd under /work
//   present_file  — deliver a /work file or a URL into the conversation's library folder (the only way a file card appears)
//   copy_to_work  — copy a readable virtual file / skill folder / URL into /work (the original stays; no card)
// Replay (pi-durable): reads are "safe". write / edit / copy_to_work record their plan in a first-writer-wins memo BEFORE touching anything,
// so a replay recognizes its own completed effect instead of failing or applying it twice; present_file is made idempotent by its receipt.
// exec is "unsafe": a command cut off by a crash is reported as interrupted (outcome unknown), never silently run again.
import { existsSync, writeFileSync } from "node:fs";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, section, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { bool, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { AppContext, ToolActor } from "../core/contracts.ts";
import { runtimeActorResolver, toolCallKey, type ActorResolver } from "../files/actor.ts";
import { extractText } from "../files/extract.ts";
import type { Library } from "../files/library.ts";
import { effectiveMime, isTextMime } from "../files/mime.ts";
import type { PresentedDetailsDTO } from "../../../shared/files.ts";
import type { ToolCallLog } from "../tools/calls.ts";
import { MAX_TIMEOUT_MS, type Sandbox } from "../tools/sandbox.ts";
import { requirePermission } from "../tools/sandbox/perm.ts";
import type { SandboxPrewarm } from "../tools/sandbox/prewarm.ts";
import { sha256 } from "./hostdir.ts";
import { fetchBytes } from "./fetch.ts";
import { baseName, normalizeVirtual, safeFileName } from "./path.ts";
import type { VfsRouter } from "./router.ts";
import { VfsError, type VfsContext, type VNode } from "./types.ts";

export const VFS_TOOL_NAMES = ["ls", "read", "write", "edit", "search", "remove", "exec", "present_file", "copy_to_work"] as const;
const READ_LINES = 2000;
const READ_CHARS = 100_000;
const IMAGE_MAX = 5 * 1024 * 1024;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const DOC_EXT = /\.(pdf|docx|xlsx|xls|pptx|html?|csv|md)$/i;
const enc = new TextEncoder();

/** Valid UTF-8 text without NUL bytes (anything else is binary and is never shown as text). */
export function decodeUtf8(bytes: Uint8Array): string | null {
	if (bytes.includes(0)) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

const capsText = (n: VNode) => n.caps.join(",") || "无";
const sizeText = (b?: number) => (b === undefined ? "" : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);

export function createVfsExtension(ctx: AppContext, opts: { resolveActor?: ActorResolver } = {}) {
	const resolve = opts.resolveActor ?? runtimeActorResolver(ctx);
	const vfs = () => (ctx.services as any).get("vfs") as VfsRouter;
	const sb = () => ctx.services.get("sandbox") as Sandbox;
	const log = () => ctx.services.get("toolCalls") as ToolCallLog;
	const toCtx = (a: ToolActor, context: Context): VfsContext => ({ principal: a.principal, space: a.space, conversationId: a.conversationId, taskId: a.taskId, callId: a.callId, signal: context.abortSignal });

	/** Run one tool body: resolve the identity, log the call, turn VfsErrors into model-readable errors with a stable code. */
	async function run(tool: string, api: ToolExecutionApi<any>, args: Record<string, unknown>, context: Context, body: (v: VfsContext, a: ToolActor) => Promise<{ text: string; details?: unknown; images?: { data: string; mimeType: string }[]; isError?: boolean }>): Promise<any> {
		let actor: ToolActor;
		try {
			actor = await resolve(api, context);
		} catch (e) {
			return { output: [{ type: "text" as const, text: `错误（forbidden）：${(e as Error).message}` }], isError: true, details: { kind: "wr.vfs", tool, error: { code: "forbidden", message: (e as Error).message } } };
		}
		try {
			const out = await log().around({ tool, actor, args: redactArgs(args) }, () => body(toCtx(actor, context), actor), (r) => (r.isError ? "error" : "ok"));
			return { output: [{ type: "text" as const, text: out.text }, ...(out.images ?? []).map((i) => ({ type: "image" as const, ...i }))], ...(out.isError ? { isError: true } : {}), details: out.details ?? { kind: "wr.vfs", tool } };
		} catch (e) {
			if (e instanceof VfsError) return { output: [{ type: "text" as const, text: `错误（${e.code}）：${e.message}` }], isError: true, details: { kind: "wr.vfs", tool, error: { code: e.code, message: e.message } } };
			const status = (e as { status?: number }).status;
			if (status && status < 500) {
				const code = (e as { code?: string }).code ?? "error";
				return { output: [{ type: "text" as const, text: `错误（${code}）：${(e as Error).message}` }], isError: true, details: { kind: "wr.vfs", tool, error: { code, message: (e as Error).message } } };
			}
			throw e;
		}
	}

	const ls = defineTool({
		name: "ls",
		description: "列出虚拟目录（默认 /），每项带类型、大小和你可做的操作。结果被截断时用 cursor（上一页最后一个名称）继续。",
		parameters: obj({ path: opt(str()), cursor: opt(str()), limit: opt(int({ minimum: 1, maximum: 1000 })) }),
		replay: "safe",
		async execute(args, api, context) {
			return run("ls", api, args, context, async (v) => {
				const r = await vfs().list(v, args.path ?? "/", { cursor: args.cursor, limit: args.limit });
				const lines = r.entries.map((n) => (n.type === "dir" ? `[目录] ${n.name}/  (${capsText(n)})${n.note ? `  ${n.note}` : ""}` : `[文件] ${n.name}  ${sizeText(n.size)}  ${n.mtime ?? ""}  (${capsText(n)})${n.note ? `  ${n.note}` : ""}`));
				return {
					text: `${r.path}${r.entries.length ? "" : "（空）"}\n${lines.join("\n")}${r.truncated ? `\n…还有更多，cursor="${r.entries.at(-1)?.name ?? ""}"` : ""}`,
					details: { kind: "wr.vfs.ls", path: r.path, entries: r.entries.slice(0, 200).map((n) => ({ path: n.path, type: n.type, size: n.size, caps: n.caps })), truncated: r.truncated },
				};
			});
		},
	});

	const read = defineTool({
		name: "read",
		description: "读取文件：文本按行分段（offset 从 1 起，limit 默认 2000）；图片直接返回；PDF/Office 返回抽取文本；其他二进制只返回类型与大小（需处理时 copy_to_work 后 exec）。结果带 etag，供 write/edit 的 expected_etag 使用。",
		parameters: obj({ path: str({ minLength: 1 }), offset: opt(int({ minimum: 1 })), limit: opt(int({ minimum: 1, maximum: 10000 })) }),
		replay: "safe",
		async execute(args, api, context) {
			return run("read", api, args, context, async (v) => {
				const { node, bytes } = await vfs().read(v, args.path);
				const mime = node.mime ?? effectiveMime(undefined, node.name);
				const etag = sha256(bytes);
				const head = `${node.path} · ${sizeText(bytes.length)} · etag ${etag.slice(0, 16)}`;
				if (IMAGE_MIMES.has(mime) && bytes.length <= IMAGE_MAX) return { text: `${head}\n（图片 ${mime}）`, images: [{ data: Buffer.from(bytes).toString("base64"), mimeType: mime }], details: { kind: "wr.vfs.read", path: node.path, etag, mime, size: bytes.length } };
				let text = isTextMime(mime) || !DOC_EXT.test(node.name) ? decodeUtf8(bytes) : null;
				let extracted = false;
				if (text === null && DOC_EXT.test(node.name)) {
					try {
						text = (await extractText(mime, node.name, bytes)).text;
						extracted = true;
					} catch {
						text = null;
					}
				}
				if (text === null) return { text: `${head}\n二进制文件（${mime}），不以文本显示。需要处理时用 copy_to_work 复制到 /work，再用 exec 处理。`, details: { kind: "wr.vfs.read", path: node.path, etag, mime, size: bytes.length, binary: true } };
				const lines = text.split("\n");
				const from = Math.min(args.offset ?? 1, Math.max(lines.length, 1));
				const want = args.limit ?? READ_LINES;
				let slice = lines.slice(from - 1, from - 1 + want).join("\n");
				let cut = from - 1 + want < lines.length;
				if (slice.length > READ_CHARS) {
					slice = slice.slice(0, READ_CHARS);
					cut = true;
				}
				const to = from - 1 + slice.split("\n").length;
				return {
					text: `${head} · 第 ${from}–${to} 行，共 ${lines.length} 行${extracted ? "（从文档抽取的文本）" : ""}${cut ? `；继续请用 offset=${to + 1}` : ""}\n${slice}`,
					details: { kind: "wr.vfs.read", path: node.path, etag, mime, size: bytes.length, from, to, lines: lines.length, truncated: cut },
				};
			});
		},
	});

	/** First-writer-wins plan of a mutating call, so a replay recognizes its own finished effect. */
	async function plan<T extends Record<string, string | null>>(api: ToolExecutionApi<any>, name: string, candidate: T, context: Context): Promise<T> {
		return (await api.memo<T>(name, candidate as never, context)) as T;
	}

	const write = defineTool({
		name: "write",
		description: "创建或覆盖文本文件（自动建上级目录）。可写：/work、你的 /memory、你自己的个人技能；/library、/uploads 不可写。覆盖已有记忆文件必须带 read 得到的 expected_etag，不一致会失败而不是覆盖。",
		parameters: obj({ path: str({ minLength: 1 }), content: str(), expected_etag: opt(str()) }),
		replay: "safe",
		executionMode: "sequential", // a round that writes then presents/reads the same file must run in order
		async execute(args, api, context) {
			return run("write", api, { path: args.path, bytes: args.content.length }, context, async (v) => {
				const path = normalizeVirtual(args.path);
				const bytes = enc.encode(args.content);
				const cur = await vfs().stat(v, path).catch(() => null);
				const p = await plan(api, "write", { path, before: cur?.etag ?? null, after: sha256(bytes) }, context);
				if (cur?.etag === p.after && p.before !== p.after) return { text: `已写入 ${path}（${sizeText(bytes.length)}）`, details: { kind: "wr.vfs.write", path, etag: p.after, status: "updated" } };
				const r = await vfs().write(v, path, bytes, { expectedEtag: args.expected_etag });
				return { text: `${r.status === "unchanged" ? "内容未变化" : r.status === "created" ? "已创建" : "已写入"} ${r.node.path}（${sizeText(bytes.length)}）· etag ${r.node.etag?.slice(0, 16) ?? ""}`, details: { kind: "wr.vfs.write", path: r.node.path, etag: r.node.etag, status: r.status } };
			});
		},
	});

	const edit = defineTool({
		name: "edit",
		description: "把文本文件中恰好出现一次的 old_text 精确替换为 new_text（找不到或出现多次都会失败，请给更长的唯一片段）。expected_etag 不一致时失败，不覆盖并发修改。",
		parameters: obj({ path: str({ minLength: 1 }), old_text: str({ minLength: 1 }), new_text: str(), expected_etag: opt(str()) }),
		replay: "safe",
		executionMode: "sequential", // a round that writes then presents/reads the same file must run in order
		async execute(args, api, context) {
			return run("edit", api, { path: args.path }, context, async (v) => {
				const path = normalizeVirtual(args.path);
				const { node, bytes } = await vfs().read(v, path);
				const cur = sha256(bytes);
				const prior = await api.memo<{ path: string; before: string; after: string }>("edit", context);
				if (prior && prior.after === cur && prior.before !== cur) return { text: `已修改 ${path}`, details: { kind: "wr.vfs.edit", path, etag: cur, status: "updated" } };
				if (args.expected_etag !== undefined && args.expected_etag !== cur) throw new VfsError("etag_mismatch", `${path} 已被修改（etag 不一致），请重新读取后再编辑`, 409);
				const text = decodeUtf8(bytes);
				if (text === null) throw new VfsError("binary", `${path} 不是文本文件，不能编辑`);
				const first = text.indexOf(args.old_text);
				if (first < 0) throw new VfsError("no_match", `在 ${path} 中没有找到 old_text（内容需逐字一致，包括空白和换行）`);
				if (text.indexOf(args.old_text, first + 1) >= 0) throw new VfsError("ambiguous_match", `old_text 在 ${path} 中出现了多次，请给出更长的、唯一的片段`);
				const next = enc.encode(text.slice(0, first) + args.new_text + text.slice(first + args.old_text.length));
				await plan(api, "edit", { path, before: cur, after: sha256(next) }, context);
				const r = await vfs().write(v, path, next, { expectedEtag: cur });
				return { text: `已修改 ${node.path} · etag ${r.node.etag?.slice(0, 16) ?? ""}`, details: { kind: "wr.vfs.edit", path: node.path, etag: r.node.etag, status: r.status } };
			});
		},
	});

	const search = defineTool({
		name: "search",
		description: "查找：mode=name 按文件名，mode=content 按文本内容（不区分大小写）。默认从 / 搜索所有可访问目录，结果限量。",
		parameters: obj({ query: str({ minLength: 1 }), path: opt(str()), mode: opt(oneOf(["name", "content"] as const)), limit: opt(int({ minimum: 1, maximum: 100 })) }),
		replay: "safe",
		async execute(args, api, context) {
			return run("search", api, args, context, async (v) => {
				const mode = args.mode ?? "name";
				const r = await vfs().search(v, args.path ?? "/", args.query, mode, args.limit ?? 50);
				const lines = r.hits.map((h) => (h.line ? `${h.path}:${h.line}  ${h.text ?? ""}` : h.path));
				return { text: `${lines.length ? lines.join("\n") : "没有找到"}${r.truncated ? "\n（结果已截断，请缩小范围）" : ""}`, details: { kind: "wr.vfs.search", hits: r.hits.slice(0, 100), truncated: r.truncated } };
			});
		},
	});

	const remove = defineTool({
		name: "remove",
		description: "删除文件（目录需 recursive: true）：/work、你的 /memory、个人技能。在 /library 中表示撤回已交付成果（卡片显示已删除）。/uploads 与他人技能不可删。",
		parameters: obj({ path: str({ minLength: 1 }), recursive: opt(bool()) }),
		replay: "safe",
		executionMode: "sequential", // a round that writes then presents/reads the same file must run in order
		async execute(args, api, context) {
			return run("remove", api, args, context, async (v) => {
				const path = normalizeVirtual(args.path);
				const st = await vfs().stat(v, path);
				if (!st) {
					if (await api.memo<{ path: string }>("remove", context)) return { text: `已删除 ${path}`, details: { kind: "wr.vfs.remove", path } };
					throw new VfsError("not_found", `${path} 不存在`, 404);
				}
				await plan(api, "remove", { path }, context);
				const r = await vfs().remove(v, path, { recursive: args.recursive });
				return { text: `${path.startsWith("/library/") ? "已撤回" : "已删除"} ${r.removed}`, details: { kind: "wr.vfs.remove", path: r.removed } };
			});
		},
	});

	const exec = defineTool({
		name: "exec",
		description:
			`在会话沙盒中执行 Shell 命令（唯一的代码执行入口：python3、node、装依赖、处理文件），cwd 默认 /work。` +
			`timeout_ms 默认 30000，最大 ${MAX_TIMEOUT_MS}；输出过长会截断。进程重启打断的命令不会自动重跑，结果标为结果未知：重试前先检查 /work 与外部状态。`,
		parameters: obj({ command: str({ minLength: 1 }), cwd: opt(str()), timeout_ms: opt(int({ minimum: 1000, maximum: MAX_TIMEOUT_MS })) }),
		replay: "unsafe",
		executionMode: "sequential", // a command reads/writes /work: it must see the writes before it and finish before reads after it
		async execute(args, api, context) {
			return run("exec", api, { command: args.command.length > 400 ? `${args.command.slice(0, 400)}…` : args.command, cwd: args.cwd }, context, async (v, a) => {
				await requirePermission(ctx, a.principal, "sandbox.use");
				await ctx.services.get("acl").require(a.principal, "write", { kind: "space", id: a.space.id });
				const cwd = normalizeVirtual(args.cwd ?? "/work");
				if (cwd !== "/work" && !cwd.startsWith("/work/")) throw new VfsError("bad_path", "exec 的 cwd 必须在 /work 之下；其他目录的文件请先 copy_to_work");
				const rel = cwd.slice("/work".length).replace(/^\//, "");
				if (rel) {
					const st = await vfs().stat(v, cwd);
					if (st?.type !== "dir") throw new VfsError("not_found", `${cwd} 不是已存在的目录`, 404);
				}
				const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
				// /work must be a real path inside the command: local drivers mount it there; a remote provider whose workdir is elsewhere gets an alias
				// when the sandbox allows it, otherwise the result says so (no command-string rewriting).
				const prelude = `if [ ! -e /work ]; then ln -s "$PWD" /work 2>/dev/null || sudo -n ln -s "$PWD" /work 2>/dev/null || echo "[workroom] 此沙盒中无法提供 /work 路径，请使用相对路径" >&2; fi\n`;
				const code = `${prelude}${rel ? `cd ${q(rel)} && ` : ""}${args.command}`;
				const r = await sb().run({ principal: a.principal, space: a.space, conversationId: a.conversationId, taskId: a.taskId, callId: a.callId, language: "shell", code, timeoutMs: args.timeout_ms, signal: context.abortSignal });
				if (ctx.services.has("sandboxPrewarm")) (ctx.services.get("sandboxPrewarm") as SandboxPrewarm).markExec(a.space.orgId, a.space.id, a.conversationId);
				const text = [`退出码 ${r.exitCode ?? "无"} · ${r.status} · ${r.durationMs} ms`, r.stdout ? `stdout:\n${r.stdout}` : "", r.stderr ? `stderr:\n${r.stderr}` : ""].filter(Boolean).join("\n");
				return { text, isError: r.status !== "ok", details: { kind: "wr.vfs.exec", exitCode: r.exitCode, status: r.status, durationMs: r.durationMs, run: { runId: r.id, spaceId: r.spaceId, status: r.status } } };
			});
		},
	});

	const present = defineTool({
		name: "present_file",
		description:
			"把结果交付给用户：source 为 /work 下的文件或 HTTP(S) URL。成功后文件进入本会话的文件库并显示文件卡片；只有它算交付，写文件、exec、后台任务输出都不会自动交付。" +
			"同会话同名交付会覆盖当前文件（不留版本）。不要交付上传附件、中间文件或日志。",
		parameters: obj({ source: str({ minLength: 1 }), name: opt(str({ minLength: 1, maxLength: 180 })), description: opt(str({ maxLength: 500 })) }),
		replay: "safe",
		executionMode: "sequential", // a round that writes then presents/reads the same file must run in order
		async execute(args, api, context) {
			return run("present_file", api, args, context, async (v, a) => {
				await ctx.services.get("acl").require(a.principal, "write", { kind: "space", id: a.space.id });
				let bytes: Uint8Array;
				let name: string;
				let mime: string | undefined;
				let source: string;
				if (/^https?:\/\//i.test(args.source)) {
					const f = await fetchBytes(args.source, { signal: context.abortSignal, orgId: a.principal.orgId });
					bytes = f.bytes;
					name = safeFileName(args.name ?? f.fileName ?? "download");
					mime = f.contentType;
					source = `url:${f.finalUrl}`;
				} else {
					const path = normalizeVirtual(args.source);
					if (!path.startsWith("/work/")) throw new VfsError("bad_path", path.startsWith("/library/") ? `${path} 已经在文件库里` : "只能交付 /work 下的文件或 HTTP(S) URL；其他目录的文件请先 copy_to_work 到 /work");
					const r = await vfs().read(v, path);
					if (r.node.type !== "file") throw new VfsError("not_a_file", `${path} 不是文件`);
					bytes = r.bytes;
					name = safeFileName(args.name ?? baseName(path));
					source = `work:${path}`;
				}
				if (!bytes.length) throw new VfsError("bad_path", "文件是空的，没有交付");
				const lib = (ctx.services as any).get("library") as Library;
				const out = await lib.present(a.principal, { space: a.space, conversationId: a.conversationId, name, bytes, ...(mime ? { mime } : {}), ...(args.description ? { description: args.description } : {}), source, callKey: toolCallKey(a, "present") });
				// Test seam (inert unless the env var names a marker file): die right after the library commit and before pi-durable stores the
				// tool result — the crash window of V15. Used by server/test/r14-replay.test.ts only.
				const killMarker = process.env.WORKROOM_TEST_KILL_AFTER_PRESENT;
				if (killMarker && !existsSync(killMarker)) {
					writeFileSync(killMarker, "1");
					process.kill(process.pid, "SIGKILL");
				}
				const details: PresentedDetailsDTO = { kind: "wr.presented", status: out.status, item: out.item };
				const verb = out.superseded ? "已有更新的同名交付，未覆盖" : out.status === "created" ? "已交付" : out.status === "updated" ? "已更新（同名覆盖）" : "内容未变化";
				return { text: `${verb}：${out.item.path}（${sizeText(out.item.size)}，${out.item.mime}）`, details };
			});
		},
	});

	const copy = defineTool({
		name: "copy_to_work",
		description:
			"把 /uploads（路径见消息里的 [附件] 行）、/library、/skills、/memory 中的文件或 HTTP(S) URL 复制到 /work 供 exec 处理；原件保留，不产生卡片。技能目录需 recursive: true；目标已存在且内容不同需 overwrite: true。",
		parameters: obj({ source: str({ minLength: 1 }), destination: opt(str()), overwrite: opt(bool()), recursive: opt(bool()) }),
		replay: "safe",
		executionMode: "sequential", // a round that writes then presents/reads the same file must run in order
		async execute(args, api, context) {
			return run("copy_to_work", api, args, context, async (v, a) => {
				await ctx.services.get("acl").require(a.principal, "write", { kind: "space", id: a.space.id });
				const files: { from: string; bytes: Uint8Array; rel: string }[] = [];
				let defaultName: string;
				if (/^https?:\/\//i.test(args.source)) {
					const f = await fetchBytes(args.source, { signal: context.abortSignal, orgId: a.principal.orgId });
					defaultName = safeFileName(f.fileName ?? "download");
					files.push({ from: f.finalUrl, bytes: f.bytes, rel: "" });
				} else {
					const src = normalizeVirtual(args.source);
					if (src === "/work" || src.startsWith("/work/")) throw new VfsError("bad_path", "源文件已在 /work 中，无需复制");
					defaultName = baseName(src);
					const st = await vfs().stat(v, src);
					if (!st) throw new VfsError("not_found", `${src} 不存在${await vfs().hint(v, src)}`, 404);
					if (st.type === "dir") {
						if (!args.recursive) throw new VfsError("bad_path", `${src} 是目录：确实要复制整个目录请传 recursive: true`);
						const stack = [src];
						while (stack.length) {
							const dir = stack.pop()!;
							const page = await vfs().list(v, dir, { limit: 1000 });
							for (const n of page.entries) {
								if (n.type === "dir") stack.push(n.path);
								else files.push({ from: n.path, bytes: (await vfs().read(v, n.path)).bytes, rel: n.path.slice(src.length + 1) });
								if (files.length > 500) throw new VfsError("too_large", "目录中的文件太多（上限 500 个），请只复制需要的部分");
							}
						}
					} else files.push({ from: src, bytes: (await vfs().read(v, src)).bytes, rel: "" });
				}
				const dest = normalizeVirtual(args.destination ?? `/work/${defaultName}`);
				if (dest !== "/work" && !dest.startsWith("/work/")) throw new VfsError("bad_path", "copy_to_work 的目标必须在 /work 之下");
				const results: { path: string; size: number; sha256: string; status: string }[] = [];
				for (const f of files) {
					const target = f.rel ? `${dest}/${f.rel}` : dest === "/work" ? `/work/${defaultName}` : dest;
					const sha = sha256(f.bytes);
					const p = await plan(api, `copy:${target}`, { target, sha }, context);
					const cur = await vfs().stat(v, target).catch(() => null);
					if (cur?.type === "dir") throw new VfsError("exists", `${target} 是已存在的目录`, 409);
					if (cur && cur.etag !== sha && cur.etag !== p.sha && !args.overwrite) throw new VfsError("exists", `${target} 已存在且内容不同；确实要覆盖请传 overwrite: true，或换一个 destination`, 409);
					const w = cur?.etag === sha ? { status: "unchanged" as const } : await vfs().write(v, target, f.bytes, {});
					results.push({ path: target, size: f.bytes.length, sha256: sha, status: w.status });
				}
				const lines = results.map((r) => `${r.path}（${sizeText(r.size)}，${r.status === "unchanged" ? "已是相同内容" : "已复制"}）`);
				return { text: `已复制到工作区（原件保留）：\n${lines.join("\n")}`, details: { kind: "wr.vfs.copy", files: results.slice(0, 200) } };
			});
		},
	});

	const filesSection = section("files", async (input, context) => {
		const rt = ctx.services.get("runtime") as unknown as { promptScope?: (i: unknown, c: Context) => Promise<{ space: { id: string; kind: string; projectId?: string }; principal: unknown } | null> };
		const scope = typeof rt.promptScope === "function" ? await rt.promptScope(input, context).catch(() => null) : null;
		let backend = "沙盒";
		try {
			if (scope) backend = (await sb().promptInfo(scope.space as never)).label;
		} catch {
			/* configuration unreadable: the exec result will say so */
		}
		return renderFilesSection({ backend, sharedSpace: !!scope && scope.space.kind !== "personal" });
	});

	return defineExtension({ name: "wr.vfs", tools: [ls, read, write, edit, search, remove, exec, present, copy], sections: [filesSection] });
}

/** The stable directory contract the model reads (no host paths). */
export function renderFilesSection(o: { backend: string; sharedSpace: boolean }): string {
	return [
		"## 文件与执行",
		"文件工具（ls、read、write、edit、search、remove）作用于虚拟路径，权限由路径决定，被拒时错误会说明原因：",
		"- /skills：技能，用到时先读 SKILL.md。个人技能可直接写，保存即生成新版本；已安装、组织、市场技能只读，要修改用 skill_manage（checkout → 改 → submit_draft，用户确认后生效）。",
		`- /memory：长期记忆，MEMORY.md 是索引。只记有对话依据的稳定偏好与背景（合并重复、替换过时内容）；不记临时参数、推测、密码或密钥，任务进度也不写在这里。改已有文件先 read 并带 expected_etag（用户可能刚改过）。${o.sharedSpace ? "共享空间的对话没有任何人的个人记忆。" : ""}`,
		"- /uploads：用户附件，只读。消息里的 [附件] 行给出每个附件的完整路径，直接使用，不要猜；路径不明时 ls /uploads（附件在 /uploads/<目录>/ 下，不在 /uploads/ 根）。/library：已交付成果，只能由 present_file 写入。",
		`- /work：会话沙盒工作区（${o.backend}），可读写，exec 在此运行。`,
		"用命令处理 /uploads、/library、/skills、/memory 的文件前，先 copy_to_work。生成文件不等于交付：present_file 成功才进入文件库并显示卡片（同名覆盖），后台任务的输出也要经它交付。",
	].join("\n");
}

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(args)) out[k] = typeof v === "string" && v.length > 400 ? `${v.slice(0, 400)}…` : v;
	return out;
}
