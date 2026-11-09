// pi-durable extension "wr.knowledge": kb_search + memory_save tools, knowledge_scope + memory prompt sections.
// All pi-durable API use of group C lives here (architecture §1 migration policy).
import { defineExtension, defineTool, section, type Extension, type PromptInput, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { arr, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { Context } from "@earendil-works/chord/context";
import type { AppContext, InputEntryData, Principal, RuntimeService, Space, ToolActor } from "../core/contracts.ts";
import type { CitationDTO, RetrievalDiagnostics } from "../../../shared/knowledge.ts";
import type { KnowledgeStore } from "./service.ts";
import type { MemoryStore } from "./memory.ts";

/** Optional runtime capabilities requested from group A (docs/requests/C.md). Duck-typed so C works before/without them. */
type RuntimeExtras = RuntimeService & {
	actorForToolCall?(api: ToolExecutionApi, context: Context): Promise<ToolActor & { input?: InputEntryData }>;
	inputForTool?(api: ToolExecutionApi, context: Context): Promise<InputEntryData | undefined>;
	promptScope?(input: PromptInput, context: Context): Promise<{ space: Space; principal: Principal | null } | null>;
	/** A's internal helper (runtime/service.ts): the user a run acts for. */
	principalOfRun?(harness: unknown, conversationId: number, context: Context): Promise<{ userId: string; orgId: string } | null>;
};

/** `…/orgs/<org>/spaces/<spaceId>/…` → spaceId (last-resort fallback when the runtime cannot tell). */
export function spaceIdFromPath(path: string | undefined): string | undefined {
	const m = path ? /[\\/]spaces[\\/]([^\\/]+)/.exec(path) : null;
	return m?.[1];
}

/** A's session doc `wr.space` (runtime/docs.ts) — loaded lazily so C does not hard-depend on the runtime module. */
async function spaceDocToken(): Promise<any | undefined> {
	try {
		return (await import("../runtime/docs.ts")).SpaceDoc;
	} catch {
		return undefined;
	}
}

export async function resolveToolActor(ctx: AppContext, api: ToolExecutionApi, context: Context): Promise<ToolActor & { input?: InputEntryData }> {
	const rt = ctx.services.get("runtime") as RuntimeExtras;
	if (typeof rt.actorForToolCall === "function") return rt.actorForToolCall(api, context);
	// A's actorForTool resolves the space from its `wr.space` session doc when spaceId is "" (it receives the full api).
	try {
		return await rt.actorForTool(api, "", context);
	} catch (e) {
		const fallback = spaceIdFromPath((api.env as { cwd?: string } | undefined)?.cwd);
		if (!fallback || (e as { code?: string }).code !== "no_space") throw e;
		return rt.actorForTool(api, fallback, context);
	}
}

/** The run's user input (for knowledgeRefs): runtime helper if present, else the newest `wr.input` entry of the conversation. */
export async function runInput(ctx: AppContext, api: ToolExecutionApi, actor: ToolActor & { input?: InputEntryData }, context: Context): Promise<InputEntryData | undefined> {
	if (actor.input) return actor.input;
	const rt = ctx.services.get("runtime") as RuntimeExtras;
	if (typeof rt.inputForTool === "function") return rt.inputForTool(api, context);
	try {
		const harness = await rt.harness(actor.space.id, context);
		const conv = await harness.conversation(actor.conversationId as any, context);
		if (!conv) return undefined;
		const page = await conv.entries({ order: "descending" }, 50, undefined, context);
		const e = page.items.find((x) => x.kind === "wr.input");
		return e?.data as InputEntryData | undefined;
	} catch {
		return undefined;
	}
}

async function resolvePromptScope(ctx: AppContext, input: PromptInput, context: Context): Promise<{ space: Space; principal: Principal | null; actorKnown: boolean } | null> {
	if (!ctx.services.has("runtime")) return null;
	const rt = ctx.services.get("runtime") as RuntimeExtras;
	if (typeof rt.promptScope === "function") {
		const s = await rt.promptScope(input, context);
		// From the runtime, a null principal means the actor was revoked: show nothing actor-dependent.
		return s ? { ...s, actorKnown: true } : null;
	}
	const identity = ctx.services.get("identity");
	const token = await spaceDocToken();
	const spaceId = (token ? ((await input.read.snapshot(token, context).catch(() => undefined)) as { spaceId?: string } | undefined)?.spaceId : undefined) || spaceIdFromPath(input.agent.cwd) || spaceIdFromPath((input.env as { cwd?: string } | undefined)?.cwd);
	const space = spaceId ? identity.space(spaceId) : null;
	if (!space) return null;
	// The acting user = the run's input author (A's principalOfRun), re-resolved against current identity state.
	if (typeof rt.principalOfRun === "function") {
		const who = await rt.principalOfRun(await rt.harness(space.id, context), input.conversationId as number, context).catch(() => null);
		if (who) return { space, principal: await identity.principalFor(who.userId, who.orgId), actorKnown: true };
	}
	// Unknown actor: a personal space's actor can only be its owner; a project space gets no private memory regardless.
	const principal = space.kind === "personal" && space.ownerUserId ? await identity.principalFor(space.ownerUserId, space.orgId) : null;
	return { space, principal, actorKnown: space.kind === "personal" };
}

/** Text for the model: numbered citations, plus explicit guidance per failure reason (M07-C). */
export function formatSearchOutput(query: string, citations: readonly CitationDTO[], d: RetrievalDiagnostics): string {
	if (!citations.length) {
		const why: Record<string, string> = {
			no_evidence: "知识库中没有找到与问题相关的证据。不要声称答案有知识库依据；如需回答，请明确说明这是一般性知识。",
			index_not_ready: "所选知识库的文档尚未处理完成（索引未就绪），暂时无法检索。请告知用户稍后重试或查看处理状态。",
			forbidden: "当前用户无权访问所选知识库。不要猜测其中的内容。",
			error: "检索服务出错，本次没有获得证据。请告知用户检索失败，不要编造来源。",
		};
		return `知识库检索「${query}」：无结果（${d.reason ?? "no_evidence"}）。${why[d.reason ?? "no_evidence"]}${d.detail ? `\n详情：${d.detail}` : ""}`;
	}
	const lines = [`知识库检索「${query}」：${citations.length} 条证据。回答中引用时使用 [编号]，只依据以下片段陈述知识库内容。`];
	for (const c of citations) {
		lines.push(`\n[${c.n}] ${c.fileName}（v${c.versionNo}，${c.locator}，知识库：${c.kbName}）\n${c.snippet}`);
	}
	if (d.detail) lines.push(`\n注：${d.detail}`);
	return lines.join("\n");
}

export function knowledgeExtension(ctx: AppContext, store: KnowledgeStore, memory: MemoryStore): Extension {
	const kbSearch = defineTool({
		name: "kb_search",
		description:
			"在用户有权访问的知识库中检索资料，返回带编号的引用片段（文件、版本、页码/章节）。回答涉及企业制度、项目资料或用户上传的知识时先调用。用户在输入中引用了知识库时，默认只检索这些知识库。",
		parameters: obj({
			query: str({ description: "检索词或问题（中文/英文均可）", minLength: 1 }),
			kbIds: opt(arr(str(), { description: "限定检索的知识库 id；省略时使用用户引用的知识库或当前空间的默认范围" })),
			limit: opt(int({ description: "返回条数，默认 6，最多 20", minimum: 1, maximum: 20 })),
		}),
		// replay: "safe" — kb_search is read-only: it writes nothing (no app-DB rows, no external calls). Re-running it after
		// a crash simply searches again with the CURRENT ACL and index, which is exactly what a fresh call would do.
		replay: "safe",
		async execute(args, api, context) {
			const actor = await resolveToolActor(ctx, api, context);
			const refs = args.kbIds?.length ? [] : ((await runInput(ctx, api, actor, context))?.knowledgeRefs ?? []);
			const kbIds = args.kbIds?.length ? args.kbIds : refs.length ? [...new Set(refs.map((r) => r.kbId))] : undefined;
			const docIds = !args.kbIds?.length && refs.some((r) => r.docId) ? refs.filter((r) => r.docId).map((r) => r.docId!) : undefined;
			const res = await store.search(actor.principal, args.query, {
				kbIds,
				docIds,
				projectId: kbIds ? undefined : actor.space.projectId,
				limit: args.limit ?? 6,
			});
			const citations = res.citations.map((c, i) => ({ ...c, n: i + 1 }));
			return {
				output: [{ type: "text" as const, text: formatSearchOutput(args.query, citations, res.diagnostics) }],
				details: { kind: "wr.kb_search", query: args.query, citations, diagnostics: res.diagnostics } as any,
			};
		},
	});

	const memorySave = defineTool({
		name: "memory_save",
		description:
			"把用户明确要求记住的信息保存为长期记忆。必须指定作用范围：private（仅该用户自己）、project（当前项目成员共享背景，仅在项目会话中可用）、org（企业级，需管理员）。不要保存敏感信息，除非用户明确要求。",
		parameters: obj({
			content: str({ description: "要记住的内容，一句话陈述", minLength: 1, maxLength: 2000 }),
			scope: oneOf(["private", "project", "org"] as const, { description: "作用范围（必填）" }),
			kind: opt(oneOf(["preference", "fact", "constraint", "background"] as const, { description: "类型，默认 fact" })),
		}),
		// replay: "safe" — idempotent by callId: the memory row stores {spaceId, callId}; a rerun after a crash finds the row
		// written by the first attempt and returns it instead of writing a second one. No external side effects.
		replay: "safe",
		async execute(args, api, context) {
			const actor = await resolveToolActor(ctx, api, context);
			if (args.scope === "project" && !actor.space.projectId) throw new Error("当前不是项目会话，不能保存项目记忆；请使用 private");
			const m = memory.create(actor.principal, {
				content: args.content,
				scope: args.scope,
				projectId: args.scope === "project" ? actor.space.projectId : undefined,
				kind: args.kind,
				source: "extracted",
				sourceRef: { spaceId: actor.space.id, conversationId: actor.conversationId, callId: actor.callId, taskId: actor.taskId },
			});
			const scopeLabel = { private: "个人（仅你可见）", project: "项目共享", org: "企业" }[m.scope];
			return {
				output: [{ type: "text" as const, text: `已保存记忆（${scopeLabel}）：${m.content}\n用户可在“记忆”页面查看、修改或删除（id: ${m.id}）。` }],
				details: { kind: "wr.memory_save", memory: m } as any,
			};
		},
	});

	return defineExtension({
		name: "wr.knowledge",
		tools: [kbSearch, memorySave],
		sections: [
			section("knowledge_scope", async (input, context) => {
				const scope = await resolvePromptScope(ctx, input, context).catch(() => null);
				if (!scope?.principal) return undefined;
				const kbs = store.listKbs(scope.principal).filter((k) => (scope.space.projectId ? (k.scope === "project" && k.projectId === scope.space.projectId) || k.scope === "org" : true));
				if (!kbs.length) return undefined;
				const label = { personal: "个人", project: "项目", department: "部门", org: "企业" } as const;
				return [
					"当前可检索的知识库（用 kb_search 检索；回答引用知识时标注 [编号]）：",
					...kbs.slice(0, 30).map((k) => `- ${k.name}（${label[k.scope]}，id: ${k.id}，可检索文档 ${k.stats.ready}${k.stats.processing ? `，处理中 ${k.stats.processing}` : ""}）`),
				].join("\n");
			}),
			section("memory", async (input, context) => {
				const scope = await resolvePromptScope(ctx, input, context).catch(() => null);
				if (!scope || (scope.actorKnown && !scope.principal)) return undefined;
				return memory.renderSection(memory.contextFor(scope.principal, scope.space));
			}),
		],
	});
}
