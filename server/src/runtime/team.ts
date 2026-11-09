// Subagents / team (M03). One `delegate` tool hands a self-contained task to a declared team member.
//
// - builtin_subagent: a task-owned child conversation (pi ownership kind "task"), configured from the member
//   declaration with `configure`: model, thinkingLevel, an explicit tools allowlist (never the parent's tools),
//   instructions, maxTurns; budget is enforced by watching the child's pi.usage.
//   foreground: the tool call owns the child, waits, and returns the answer or what failed / was left unfinished.
//   background: a background anchor task owns the child; a background reporter task delivers the task and posts the
//   result back to the parent as a follow-up input (request ids make every step restart-safe). Survives the parent's
//   abort and the browser closing.
// - external_tool: a tool service, invoked as a tool through its connector — never a chat role; delegate refuses.
// - third_party_agent: an external agent behind a connector; requires connector `use` permission and an explicit
//   approval before any data leaves; no third-party connector exists in this build, so the call ends `blocked`.
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, configure, defineExtension, defineTask, defineTool, UsageDoc, type ConversationHandle, type ConversationId, type Extension, type TaskId, type ToolExecutionApi, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { MemberDeclaration, SubagentDTO, UsageDTO } from "../../../shared/chat.ts";
import { nowIso } from "../core/http.ts";
import { BUILTIN_MEMBERS } from "./assistants.ts";
import { AssistantDoc, InputEntry, TeamDoc } from "./docs.ts";
import { usageFromState } from "./dto.ts";
import { stableId, type Effects } from "./effects.ts";
import { textOfContent } from "./fixture-model.ts";
import type { Runtime } from "./service.ts";

function answerText(m: AssistantMessage | undefined): string {
	return (m?.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
}

async function membersOf(api: { snapshot: ToolExecutionApi["snapshot"]; conversationId: ConversationId }, context: Context): Promise<readonly MemberDeclaration[]> {
	const ad = await api.snapshot(AssistantDoc, api.conversationId, context);
	return ad?.members?.length ? ad.members : BUILTIN_MEMBERS;
}

function overBudget(m: MemberDeclaration, u: UsageDTO): string | undefined {
	if (m.budget?.maxTokens && u.totalTokens > m.budget.maxTokens) return `token 预算耗尽（${u.totalTokens} > ${m.budget.maxTokens}）`;
	if (m.budget?.maxCostUsd && u.costTotal > m.budget.maxCostUsd) return `费用预算耗尽（$${u.costTotal.toFixed(4)} > $${m.budget.maxCostUsd}）`;
	return undefined;
}

/** Configure a fresh child from its member declaration. Tools: exactly the allowlist (minus delegate). */
async function configureChild(tx: Tx, childId: ConversationId, m: MemberDeclaration, allTools: readonly { tool: ToolRegistration }[], parentModel: { provider: string; modelId: string } | undefined, name: string, assistantId: string | null): Promise<void> {
	const byName = new Map(allTools.map((t) => [t.tool.name, t.tool]));
	const tools = m.tools.filter((n) => n !== "delegate").flatMap((n) => (byName.has(n) ? [byName.get(n)!] : []));
	await configure(tx, childId, {
		model: m.model ?? parentModel ?? null,
		thinkingLevel: m.thinkingLevel ?? null,
		tools,
		modelTools: null,
		maxTurns: m.maxTurns,
		instructions: [`你是团队成员「${m.name}」（${m.id}）。只完成交给你的子任务，并给出结论。`, m.instructions, m.knowledgeScope ? `知识范围：仅限知识库 ${m.knowledgeScope.kbIds.join(", ")}。` : undefined].filter(Boolean).join("\n"),
	});
	const ad = await tx.doc(AssistantDoc, childId);
	ad.assistantId = assistantId;
	ad.name = name;
	ad.members = [];
	(ad as any).member = structuredClone(m);
}

/** Wait for a child submission, aborting the child when its budget runs out. */
async function waitWithBudget(handle: ConversationHandle, submissionWait: Promise<any>, readUsage: () => Promise<UsageDTO>, m: MemberDeclaration): Promise<{ settled: any; budgetStop?: string }> {
	if (!m.budget) return { settled: await submissionWait };
	let budgetStop: string | undefined;
	let done = false;
	const poll = (async () => {
		while (!done) {
			await new Promise((r) => setTimeout(r, 300));
			if (done) break;
			const over = overBudget(m, await readUsage().catch(() => ({ totalTokens: 0, costTotal: 0 }) as UsageDTO));
			if (over) {
				budgetStop = over;
				await handle.abort(BACKGROUND_CONTEXT).catch(() => {});
				break;
			}
		}
	})();
	try {
		const settled = await submissionWait;
		return { settled, budgetStop };
	} finally {
		done = true;
		void poll;
	}
}

/** The last assistant text and tool outputs a child produced (what was finished before a failure). */
async function partialWork(api: { commit: ToolExecutionApi["commit"] }, rt: Runtime, harnessConv: { entries: (q: any, l: number, c: any, ctx: Context) => Promise<{ items: readonly any[] }> } | undefined, context: Context): Promise<string> {
	if (!harnessConv) return "";
	const page = await harnessConv.entries({ order: "descending" }, 30, undefined, context);
	const parts: string[] = [];
	for (const e of [...page.items].reverse()) {
		const m = e.model?.[0];
		if (e.kind === "pi.assistant" && m?.role === "assistant") {
			const t = answerText(m as AssistantMessage);
			if (t) parts.push(`助手：${t.slice(0, 500)}`);
		} else if (e.kind === "pi.tool-result" && m?.role === "toolResult") parts.push(`${m.toolName}：${textOfContent(m.content).slice(0, 300)}`);
	}
	void api;
	void rt;
	return parts.join("\n");
}

export function createTeamExtension(rt: Runtime, effects: Effects): Extension {
	const Anchor = defineTask<null, { phase: "done" }, null>({
		name: "wr.delegate-anchor",
		version: 1,
		initial: () => ({ phase: "done" }),
		phases: {
			done: (_t, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx),
		},
		abort: (_t, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
	});

	type ReporterInput = { delegationId: string; childId: number; task: string; userId: string; orgId: string; member: MemberDeclaration };
	type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };
	const Reporter = defineTask<ReporterInput, ReporterState, null>({
		name: "wr.delegate-reporter",
		version: 1,
		initial: () => ({ phase: "deliver" }),
		phases: {
			deliver: async (task, runtime, ctx) => {
				const { delegationId, childId, userId, orgId, member } = task.input;
				const child = (await runtime.conversation(childId as ConversationId, ctx))!;
				const submission = await child.submit({ type: "input", content: task.input.task, requestId: `delegate:${task.id}`, entry: { kind: InputEntry.kind, data: { text: task.input.task, userId, orgId, requestId: `delegate:${task.id}`, via: { kind: "delegate", id: delegationId } } as any } }, ctx);
				const readUsage = async () => usageFromState(await runtime.snapshot(UsageDoc, childId as ConversationId, ctx), rt.isSimulated);
				const { settled, budgetStop } = await waitWithBudget(child, submission.wait(ctx), readUsage, member);
				const usage = await readUsage();
				await runtime.commit(async (tx) => {
					const team = await tx.doc(TeamDoc, runtime.conversationId);
					const d = team.delegations[delegationId];
					let report: string;
					if (settled.status === "done" && settled.type === "input") {
						const answer = answerText((await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage);
						if (d) Object.assign(d, { status: "done", resultSummary: answer.slice(0, 4000), usage, endedAt: nowIso() });
						report = `[子任务回报] 成员「${member.name}」已完成：${answer}`;
					} else {
						const reason = budgetStop ?? settled.reason ?? "unanswered";
						if (d) Object.assign(d, { status: reason === "aborted" && !budgetStop ? "aborted" : "failed", failure: reason, usage, endedAt: nowIso() });
						report = `[子任务回报] 成员「${member.name}」未完成（${reason}）。`;
					}
					return { status: "running", checkpoint: { phase: "report", report } };
				}, ctx);
			},
			report: async (task, runtime, ctx) => {
				const report = task.state.checkpoint.report;
				const principal = await rt.ctx.services.get("identity").principalFor(task.input.userId, task.input.orgId);
				if (report && principal) {
					const parent = (await runtime.conversation(runtime.conversationId, ctx))!;
					await parent.submit({ type: "input", content: report, whenBusy: "followUp", requestId: `delegate-report:${task.id}`, entry: { kind: InputEntry.kind, data: { text: report, userId: task.input.userId, orgId: task.input.orgId, requestId: `delegate-report:${task.id}`, via: { kind: "subagent_report", id: task.input.delegationId } } as any } }, ctx);
				}
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
			},
		},
		abort: async (task, runtime, ctx) => {
			await runtime.commit(async (tx) => {
				const team = await tx.doc(TeamDoc, runtime.conversationId);
				const d = team.delegations[task.input.delegationId];
				if (d && d.status === "running") Object.assign(d, { status: "aborted", failure: "aborted", endedAt: nowIso() });
				return { status: "terminal", outcome: { status: "aborted" } };
			}, ctx);
		},
	});

	const delegate = defineTool({
		name: "delegate",
		description:
			"把一个自包含的子任务交给团队成员（子 Agent）。member：成员 id；task：完整任务描述；mode：foreground 等待结果（默认）或 background 后台执行、完成后自动回报。成员只能使用其声明的工具。",
		parameters: obj({ member: str(), task: str(), mode: opt(oneOf(["foreground", "background"])) }),
		replay: "safe", // a rerun after a crash finds the same delegation record / child conversation / submission by id
		execute: async (args, api, context) => {
			const actor = await rt.actorForTool(api, "", context);
			const members = await membersOf(api, context);
			const m = members.find((x) => x.id === args.member);
			const reply = (t: string, isError = false, details?: unknown) => ({ output: [{ type: "text" as const, text: t }], isError, ...(details !== undefined ? { details: details as any } : {}) });
			if (!m) return reply(`没有名为 ${args.member} 的团队成员。可用成员：${members.map((x) => `${x.id}（${x.name}）`).join("、")}`, true);
			if (m.type === "external_tool") return reply(`成员 ${m.name} 是外部工具服务（external_tool，connector=${m.connectorId}），应作为工具调用，而不是委派对话任务。`, true, { memberType: m.type });
			if (m.type === "third_party_agent") {
				const acl = rt.ctx.services.get("acl");
				const d = await acl.check(actor.principal, "use", { kind: "connector", id: m.connectorId ?? "" });
				if (!d.allow) return reply(`第三方 Agent ${m.name} 不可用：无权使用连接器 ${m.connectorId}（${d.reason}）。`, true, { memberType: m.type, blocked: d.reason });
				const decision = await effects.requestApproval(api, { title: `发送任务给第三方 Agent「${m.name}」`, summary: `将把以下任务内容发送到外部服务 ${m.connectorId}：${args.task.slice(0, 500)}`, risk: "high" }, context);
				if (decision.decision !== "approved") return reply(`用户拒绝了把任务发送给第三方 Agent ${m.name}。`, true, { memberType: m.type });
				return reply(`第三方 Agent ${m.name} 的连接器 ${m.connectorId} 在本部署中未接入（blocked），任务未发送。`, true, { memberType: m.type, blocked: "not_connected" });
			}
			if (rt.ctx.services.has("budget")) {
				const b = await rt.ctx.services.get("budget").checkSubmit(actor.principal, actor.space.id, actor.space.projectId);
				if (!b.allow) return reply(`预算不足，未启动子任务：${b.reason}`, true);
			}
			const delegationId = stableId("dg", api.conversationId as number, api.callId);
			const mode = args.mode === "background" ? "background" : "foreground";
			const parentAgent = await api.agent(context);
			const allTools = api.registry.tools();
			const ad = await api.snapshot(AssistantDoc, api.conversationId, context);
			const record = (childId: number | undefined): SubagentDTO => ({
				delegationId,
				memberId: m.id,
				memberName: m.name,
				memberType: m.type,
				mode,
				source: { conversationId: api.conversationId as number, callId: api.callId, taskId: api.taskId as number },
				ownerUserId: actor.principal.userId,
				...(childId !== undefined ? { childConversationId: childId } : {}),
				status: "running",
				task: args.task.slice(0, 4000),
				startedAt: nowIso(),
			});

			if (mode === "background") {
				const childId = await api.commit(async (tx) => {
					const team = await tx.doc(TeamDoc, api.conversationId);
					const existing = team.delegations[delegationId];
					if (existing?.childConversationId !== undefined) return existing.childConversationId;
					const background = { ownership: { kind: "conversation" }, background: true } as const;
					const anchor = await tx.createTask(Anchor, null, background);
					const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
					const reporter = await tx.createTask(Reporter, { delegationId, childId: child.id as number, task: args.task, userId: actor.principal.userId, orgId: actor.principal.orgId, member: structuredClone(m) as any }, background);
					await configureChild(tx, child.id, m, allTools, parentAgent.model, m.name, ad?.assistantId ?? null);
					team.delegations[delegationId] = { ...record(child.id as number), anchorTaskId: anchor as number, reporterTaskId: reporter as number } as any;
					return child.id as number;
				}, context);
				await api.details({ delegationId, childConversationId: childId, member: m.id, mode } as any, context);
				return reply(`已在后台把子任务交给成员「${m.name}」（${delegationId}），完成后会自动回报。`, false, { delegationId, childConversationId: childId, member: m.id, mode });
			}

			// foreground: the call's task owns the child; a rerun finds it through the ownership index.
			const childId = await api.commit(async (tx) => {
				const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
				if (existing !== undefined) return existing.id as number;
				const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
				await configureChild(tx, created.id, m, allTools, parentAgent.model, m.name, ad?.assistantId ?? null);
				const team = await tx.doc(TeamDoc, api.conversationId);
				team.delegations[delegationId] = record(created.id as number) as any;
				return created.id as number;
			}, context);
			await api.details({ delegationId, childConversationId: childId, member: m.id, mode } as any, context);
			const handle = (await api.conversation(childId as ConversationId, context))!;
			const request = { type: "input" as const, content: args.task, requestId: `delegate:${api.taskId}`, entry: { kind: InputEntry.kind, data: { text: args.task, userId: actor.principal.userId, orgId: actor.principal.orgId, requestId: `delegate:${api.taskId}`, via: { kind: "delegate", id: delegationId } } as any } };
			const readUsage = async () => usageFromState(await api.snapshot(UsageDoc, childId as ConversationId, context), rt.isSimulated);
			const { settled, budgetStop } = await waitWithBudget(handle, (await handle.submit(request, context)).wait(context), readUsage, m);
			const usage = await readUsage();
			let text: string;
			let status: SubagentDTO["status"];
			let failure: string | undefined;
			let summary = "";
			if (settled.status === "done" && settled.type === "input" && !budgetStop) {
				const entry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
				summary = answerText(entry?.model?.[0] as AssistantMessage);
				status = "done";
				text = `成员「${m.name}」已完成：\n${summary}`;
			} else {
				failure = budgetStop ?? settled.reason ?? "unanswered";
				status = failure === "aborted" ? "aborted" : "failed";
				const h = await rt.manager.get(actor.space.id);
				const childConv = await h.conversation(childId as ConversationId, context);
				const partial = await partialWork(api, rt, childConv, context);
				text = `成员「${m.name}」未完成（${failure}）。${partial ? `\n已完成部分：\n${partial}` : "\n没有已完成的部分。"}`;
			}
			await api.commit(async (tx) => {
				const team = await tx.doc(TeamDoc, api.conversationId);
				const d = team.delegations[delegationId];
				if (d) Object.assign(d, { status, usage, endedAt: nowIso(), ...(summary ? { resultSummary: summary.slice(0, 4000) } : {}), ...(failure ? { failure } : {}) });
			}, context);
			return reply(text, status !== "done", { delegationId, childConversationId: childId, member: m.id, mode, status, usage, ...(failure ? { failure } : {}) });
		},
	});

	return defineExtension({ name: "wr-team", tools: [delegate], tasks: [Anchor, Reporter] });
}

export type { TaskId };
