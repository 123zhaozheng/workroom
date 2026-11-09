// Agent tools for the cloud sandbox (pi-durable extension "wr.sandbox").
// Replay: sandbox_exec is "unsafe" — a script may have non-idempotent effects on its workspace, so a crash mid-run gives the
// model an `interrupted` error result instead of running it again. The file helpers are "safe" (idempotent overwrite/read),
// and sandbox_publish is "safe" because its library write uses idempotencyKey = tool call key.
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, hook, ToolTask, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { AppContext, ToolActor } from "../core/contracts.ts";
import { runtimeActorResolver, toolCallKey, type ActorResolver } from "../files/actor.ts";
import { effectiveMime } from "../files/mime.ts";
import type { Files } from "../files/service.ts";
import type { ToolCallLog } from "./calls.ts";
import { MAX_TIMEOUT_MS, RETENTION_HOURS, type Sandbox } from "./sandbox.ts";
import { hasPermission, permissionForTool, requirePermission } from "./sandbox/perm.ts";

export function createSandboxTools(ctx: AppContext, opts: { resolveActor?: ActorResolver } = {}) {
	const resolve = opts.resolveActor ?? runtimeActorResolver(ctx);
	const sb = () => ctx.services.get("sandbox") as Sandbox;
	const log = () => ctx.services.get("toolCalls") as ToolCallLog;
	const acl = () => ctx.services.get("acl");

	async function withActor<T>(tool: string, api: ToolExecutionApi<any>, args: unknown, context: Context, write: boolean, fn: (a: ToolActor) => Promise<T>, summarize?: (r: T) => string): Promise<T> {
		const actor = await resolve(api, context);
		return log().around({ tool, actor, args }, async () => {
			await requirePermission(ctx, actor.principal, "sandbox.use");
			if (write) await acl().require(actor.principal, "write", { kind: "space", id: actor.space.id });
			return fn(actor);
		}, summarize);
	}

	const exec = defineTool({
		name: "sandbox_exec",
		description:
			`Run shell, Python 3 or Node.js code on the server in an isolated sandbox. The working directory /work persists for this conversation ` +
			`(files idle for ${RETENTION_HOURS} h are deleted — publish results with sandbox_publish or file_create; bring library files in with sandbox_import). No network access by default. ` +
			`Limits: wall time timeoutMs (default 30 s, max ${MAX_TIMEOUT_MS / 1000} s), 512 MB memory, 64 MB per file. Only /work is writable (/tmp is a small scratch disk). Read-only mounts such as /skills/<name>/ may exist.`,
		parameters: obj({ language: oneOf(["shell", "python", "node"]), code: str({ minLength: 1 }), timeoutMs: opt(int({ minimum: 1000, maximum: MAX_TIMEOUT_MS })) }),
		replay: "unsafe",
		executionMode: "sequential",
		async execute(args, api, context) {
			const run = await withActor("sandbox_exec", api, { language: args.language, code: args.code.length > 400 ? `${args.code.slice(0, 400)}…` : args.code }, context, true, (a) =>
				sb().run({ principal: a.principal, space: a.space, conversationId: a.conversationId, taskId: a.taskId, callId: a.callId, language: args.language, code: args.code, timeoutMs: args.timeoutMs, signal: context.abortSignal }),
				(r) => `${r.status} exit=${r.exitCode}`);
			const text = [`status: ${run.status}${run.exitCode !== undefined ? ` (exit ${run.exitCode})` : ""}, ${run.durationMs} ms`, run.stdout ? `stdout:\n${run.stdout}` : "", run.stderr ? `stderr:\n${run.stderr}` : ""].filter(Boolean).join("\n");
			return { output: [{ type: "text", text }], isError: run.status !== "ok", details: { run: { runId: run.id, spaceId: run.spaceId, status: run.status } } };
		},
	});

	const writeFile = defineTool({
		name: "sandbox_write_file",
		description: "Write a file into the sandbox working directory (/work). Text by default; use encoding \"base64\" for binary content. Subject to the workspace quota.",
		parameters: obj({ path: str(), content: str(), encoding: opt(oneOf(["utf8", "base64"])) }),
		replay: "safe",
		async execute(args, api, context) {
			const bytes = args.encoding === "base64" ? new Uint8Array(Buffer.from(args.content, "base64")) : new TextEncoder().encode(args.content);
			const rel = await withActor("sandbox_write_file", api, { path: args.path, content: `${args.content.length} 字符` }, context, true, async (a) => sb().writeFile(a.space, a.conversationId, args.path, bytes));
			return { output: [{ type: "text", text: `已写入 /work/${rel}（${bytes.length} 字节）` }] };
		},
	});

	const importFile = defineTool({
		name: "sandbox_import",
		description: "Copy a file from the file library into the sandbox working directory (/work) so code can process it. Uses the latest version unless versionId is given. Returns the /work path.",
		parameters: obj({ fileId: str(), versionId: opt(str()), path: opt(str({ description: "Target path under /work (default: the file's name)." })) }),
		replay: "safe",
		async execute(args, api, context) {
			const r = await withActor("sandbox_import", api, args, context, true, async (a) => {
				const files = ctx.services.get("files") as unknown as Files;
				const f = await files.requireFile(a.principal, "read", args.fileId);
				const versionId = args.versionId ?? f.latest_version_id;
				if (!versionId) throw new Error("文件没有版本");
				const v = await files.requireVersion(a.principal, args.fileId, versionId);
				const rel = sb().writeFile(a.space, a.conversationId, args.path ?? v.version.name, v.bytes);
				return { rel, size: v.bytes.length, name: v.version.name };
			}, (x) => x.rel);
			return { output: [{ type: "text", text: `已导入「${r.name}」到 /work/${r.rel}（${r.size} 字节）` }] };
		},
	});

	const readFile = defineTool({
		name: "sandbox_read_file",
		description: "Read a text file from the sandbox working directory.",
		parameters: obj({ path: str(), maxChars: opt(int({ minimum: 100, maximum: 200000 })) }),
		replay: "safe",
		async execute(args, api, context) {
			const f = await withActor("sandbox_read_file", api, args, context, false, async (a) => sb().readFile(a.space, a.conversationId, args.path));
			const text = new TextDecoder().decode(f.bytes);
			const max = args.maxChars ?? 50000;
			return { output: [{ type: "text", text: text.length > max ? `${text.slice(0, max)}\n…（共 ${text.length} 字符）` : text }] };
		},
	});

	const list = defineTool({
		name: "sandbox_list",
		description: "List files in the sandbox working directory with sizes and expiry times.",
		parameters: obj({}),
		replay: "safe",
		async execute(_args, api, context) {
			const entries = await withActor("sandbox_list", api, {}, context, false, async (a) => sb().entries(a.space, a.conversationId));
			return { output: [{ type: "text", text: entries.length ? entries.map((e) => `${e.kind === "directory" ? "d" : "-"} ${e.path}  ${e.size} B  到期 ${e.expiresAt}`).join("\n") : "（空）" }] };
		},
	});

	const publish = defineTool({
		name: "sandbox_publish",
		description: "Publish a file from the sandbox working directory to the file library (new file, or a new version of fileId). Published files are kept; the sandbox copy expires.",
		parameters: obj({ path: str(), name: opt(str()), fileId: opt(str()), changeNote: opt(str()) }),
		replay: "safe",
		async execute(args, api, context) {
			const ref = await withActor("sandbox_publish", api, args, context, true, async (a) => {
				const f = sb().readFile(a.space, a.conversationId, args.path);
				const name = args.name ?? f.name;
				return (ctx.services.get("files") as unknown as Files).putVersion(a.principal, {
					fileId: args.fileId,
					name,
					mime: effectiveMime(undefined, name),
					bytes: f.bytes,
					idempotencyKey: toolCallKey(a),
					provenance: { createdBy: a.principal.userId, spaceId: a.space.id, conversationId: a.conversationId, taskId: a.taskId, callId: a.callId, changeNote: args.changeNote ?? `从沙箱 /work/${args.path} 发布`, origin: "agent", tool: "sandbox_publish" } as any,
				});
			}, (r) => `${r.fileId}/${r.versionId}`);
			return { output: [{ type: "text", text: `已发布「${ref.name}」v${ref.versionNo}。fileId=${ref.fileId} versionId=${ref.versionId}` }], details: { artifact: { ...ref }, action: "published" } };
		},
	});

	return { exec, writeFile, readFile, list, publish, importFile };
}

export function createSandboxExtension(ctx: AppContext, opts: { resolveActor?: ActorResolver } = {}) {
	const t = createSandboxTools(ctx, opts);
	const resolve = opts.resolveActor ?? runtimeActorResolver(ctx);
	// beforeTool gate for every call — including code mode itself (QuickJS orchestration) and nested calls made from it: a role without the
	// permission (e.g. 访客 has no sandbox.use) gets a refusal instead of an execution.
	const gate = hook(ToolTask, {
		beforeTool: async (call: { name: string }, api: any, context: Context) => {
			const perm = permissionForTool(call.name);
			if (!perm || !ctx.services.has("authz")) return undefined;
			let actor;
			try {
				actor = await resolve(api, context);
			} catch {
				return undefined; // the tool's own actor resolution fails the same way
			}
			return (await hasPermission(ctx, actor.principal, perm)) ? undefined : { block: `没有权限：${perm === "sandbox.browser" ? "使用浏览器工具" : "使用沙箱"}（${perm}），本次调用未执行` };
		},
	} as any);
	return defineExtension({ name: "wr.sandbox", tools: [t.exec, t.writeFile, t.readFile, t.list, t.publish, t.importFile], hooks: [gate] });
}
