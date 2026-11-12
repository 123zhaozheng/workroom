// pi-durable records → shared/chat.ts DTOs. Pure functions.
import type { EntryRecord, LiveState, InboxState, SubmissionRecord, TaskGraphNode, UsageState } from "@earendil-works/pi-durable";
import type { AssistantMessage, Message, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import type { ApprovalDTO, EntryDTO, LiveDTO, QueuedInputDTO, RunStatus, SubmissionDTO, SubmissionStatus, TaskNodeDTO, ToolCallDTO, UsageDTO } from "../../../shared/chat.ts";
import { FIXTURE_PROVIDER, stripDirectives, textOfContent } from "./fixture-model.ts";

const ZERO_USAGE: UsageDTO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };

/** Default simulated-model test: the fixture provider. The runtime passes a richer predicate (gateway labels). */
export type SimulatedModel = (provider: string, modelId: string) => boolean;
export const fixtureOnly: SimulatedModel = (provider) => provider === FIXTURE_PROVIDER;

export function usageDTO(u: Partial<Usage> | undefined, simulated = false): UsageDTO {
	const flag = simulated ? { fixture: true, simulated: true } : {};
	if (!u) return { ...ZERO_USAGE, ...flag };
	return {
		input: u.input ?? 0,
		output: u.output ?? 0,
		cacheRead: u.cacheRead ?? 0,
		cacheWrite: u.cacheWrite ?? 0,
		totalTokens: u.totalTokens ?? 0,
		costTotal: u.cost?.total ?? 0,
		...flag,
	};
}

export function addUsage(a: UsageDTO, b: UsageDTO): UsageDTO {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		costTotal: a.costTotal + b.costTotal,
		...(a.fixture || b.fixture ? { fixture: true } : {}),
		...(a.simulated || b.simulated ? { simulated: true } : {}),
	};
}

/** Sum a conversation's pi.usage document (models + tools), with a per-model breakdown flagged simulated or real. */
export function usageFromState(state: Readonly<UsageState> | undefined, isSimulated: SimulatedModel = fixtureOnly): UsageDTO {
	let out: UsageDTO = { ...ZERO_USAGE };
	if (!state) return out;
	const byModel: UsageDTO["byModel"] & any[] = [];
	for (const [key, u] of Object.entries((state as any).models ?? {})) {
		const slash = key.indexOf("/");
		const sim = isSimulated(key.slice(0, slash), key.slice(slash + 1));
		const d = usageDTO(u as Usage, sim);
		out = addUsage(out, d);
		byModel.push({ key, simulated: sim, input: d.input, output: d.output, totalTokens: d.totalTokens, costTotal: d.costTotal });
	}
	for (const [name, u] of Object.entries((state as any).tools ?? {})) {
		const d = usageDTO(u as Usage);
		out = addUsage(out, d);
		byModel.push({ key: `tool:${name}`, simulated: false, input: d.input, output: d.output, totalTokens: d.totalTokens, costTotal: d.costTotal });
	}
	return byModel.length ? { ...out, byModel } : out;
}

function assistantParts(m: AssistantMessage | undefined): { text: string; thinking?: string; toolCalls: ToolCallDTO[] } {
	let text = "";
	let thinking = "";
	const toolCalls: ToolCallDTO[] = [];
	for (const c of m?.content ?? []) {
		if (c.type === "text") text += c.text;
		else if (c.type === "thinking") thinking += c.thinking;
		else if (c.type === "toolCall") toolCalls.push({ id: c.id, name: c.name, arguments: c.arguments });
	}
	return { text, ...(thinking ? { thinking } : {}), toolCalls };
}

/** Human-facing text of a user input: fixture test directives ([[call …]] / [[slow]] / [[fail]] / [[reply]]) removed (the
 * same stripping that produces conversation titles), plus whether any were present. `text` itself stays the raw input. */
export function userDisplay(text: string): { displayText: string; hasTestDirectives: boolean } {
	const stripped = stripDirectives(text);
	// Without directives the text is returned untouched; with them, the gaps the directives leave are tidied.
	if (stripped === text) return { displayText: text, hasTestDirectives: false };
	return { displayText: stripped.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trim(), hasTestDirectives: true };
}

export function entryDTO(e: EntryRecord, authorName?: (userId: string) => string | undefined, isSimulated: SimulatedModel = fixtureOnly): EntryDTO {
	const base = { id: e.id as number, conversationId: e.conversationId as number };
	const msg = e.model?.[0] as Message | undefined;
	switch (e.kind) {
		case "wr.input":
		case "wr.input-unplaced": {
			const d = (e.data ?? {}) as any;
			const text: string = typeof d.text === "string" ? d.text : textOfContent((msg as any)?.content ?? "");
			return {
				...base,
				kind: "user",
				text,
				...userDisplay(text),
				userId: d.userId,
				authorName: d.userId && authorName ? authorName(d.userId) : undefined,
				...(d.attachments?.length ? { attachments: d.attachments } : {}),
				...(d.knowledgeRefs?.length ? { knowledgeRefs: d.knowledgeRefs } : {}),
				...(d.via ? { via: { kind: d.via.kind, id: d.via.automationId ?? d.via.id } } : {}),
				...(e.kind === "wr.input-unplaced" ? { placed: false } : {}),
				...(typeof (msg as any)?.timestamp === "number" ? { timestamp: (msg as any).timestamp } : typeof d.at === "number" ? { timestamp: d.at } : {}),
			};
		}
		case "pi.user": {
			const text = textOfContent((msg as any)?.content ?? "");
			return { ...base, kind: "user", text, ...userDisplay(text) };
		}
		case "pi.assistant": {
			const m = msg as AssistantMessage | undefined;
			const parts = assistantParts(m);
			return {
				...base,
				kind: "assistant",
				...parts,
				stopReason: m?.stopReason ?? "stop",
				...(m?.errorMessage ? { errorMessage: m.errorMessage } : {}),
				model: { provider: m?.provider ?? "", modelId: m?.model ?? "" },
				fixture: !!m && isSimulated(m.provider, m.model),
				usage: usageDTO(m?.usage, !!m && isSimulated(m.provider, m.model)),
				timestamp: m?.timestamp,
				...(typeof m?.durationMs === "number" ? { durationMs: m.durationMs } : {}),
			};
		}
		case "pi.tool-result": {
			const m = msg as ToolResultMessage | undefined;
			return {
				...base,
				kind: "tool_result",
				callId: m?.toolCallId ?? "",
				toolName: m?.toolName ?? "",
				text: textOfContent((m?.content ?? []) as any),
				isError: !!m?.isError,
				...(m?.details !== undefined ? { details: m.details } : {}),
				...((e.data as any)?.diagnostics?.length ? { diagnostics: (e.data as any).diagnostics } : {}),
				...(typeof m?.timestamp === "number" ? { timestamp: m.timestamp } : {}),
				...(typeof m?.durationMs === "number" ? { durationMs: m.durationMs } : {}),
			};
		}
		case "wr.start":
			return { ...base, kind: "start" };
		case "wr.workspace": {
			const d = (e.data ?? {}) as any;
			return { ...base, kind: "workspace", ms: Number(d.ms) || 0, items: Array.isArray(d.items) ? d.items : [] };
		}
		case "wr.notice":
			return { ...base, kind: "notice", text: String((e.data as any)?.text ?? ""), code: String((e.data as any)?.code ?? "") };
		case "pi.reset":
			return { ...base, kind: "reset", text: msg ? textOfContent((msg as any).content ?? "") : undefined };
		case "pi.compaction":
			return { ...base, kind: "compaction", text: msg ? textOfContent((msg as any).content ?? "") : undefined };
		case "pi.system":
			return { ...base, kind: "system" };
		default:
			return { ...base, kind: "other", rawKind: e.kind, data: e.data };
	}
}

/** Map pi's live doc + pending approvals to an independent run status (M02-C). */
export function runStatus(live: Readonly<LiveState> | undefined, pendingApprovals: number, hasAnswer: boolean): RunStatus {
	if (live?.run) return pendingApprovals > 0 ? "waiting_approval" : "running";
	const f = live?.runFailure;
	if (f) {
		switch (f.reason) {
			case "aborted":
			case "reset":
				return "aborted";
			case "turn_limit":
				return "timeout";
			case "interrupted":
			case "restart_limit":
				return "interrupted";
			case "model_error":
				return /timeout|timed out/i.test(f.detail ?? "") ? "timeout" : "failed";
			case "nothing_to_answer":
				return hasAnswer ? "done" : "idle";
			default:
				return "failed";
		}
	}
	return hasAnswer ? "done" : "idle";
}

export function liveDTO(live: Readonly<LiveState> | undefined, approvals: readonly ApprovalDTO[], hasAnswer: boolean): LiveDTO {
	const pending = approvals.filter((a) => a.status === "pending").length;
	const partialMsg = live?.generation?.message as unknown as AssistantMessage | undefined;
	const tools = (live?.tools ?? []).map((t) => {
		const child = (t.details as any)?.childConversationId ?? (t.details as any)?.conversationId;
		return {
			callId: t.callId,
			name: t.name,
			status: t.status,
			...(t.output ? { output: t.output } : {}),
			...(t.details !== undefined ? { details: t.details } : {}),
			...(t.taskId !== undefined ? { taskId: t.taskId as number } : {}),
			...(typeof child === "number" ? { childConversationId: child } : {}),
		};
	});
	return {
		status: runStatus(live, pending, hasAnswer),
		busy: !!live?.run,
		...(partialMsg ? { partial: { ...assistantParts(partialMsg), ...(typeof partialMsg.timestamp === "number" ? { startedAt: partialMsg.timestamp } : {}) } } : {}),
		tools,
		...(live?.run ? { turns: live.run.turns } : {}),
		...(live?.generation?.retry ? { retry: { at: live.generation.retry.at, error: live.generation.retry.error } } : {}),
		...(live?.runFailure ? { failure: { reason: live.runFailure.reason, ...(live.runFailure.detail ? { detail: live.runFailure.detail } : {}) } } : {}),
	};
}

export function queueDTO(inbox: Readonly<InboxState> | undefined): QueuedInputDTO[] {
	return (inbox?.items ?? []).map((it: any) => {
		if (it.mode === "write") return { submissionId: it.id as number, mode: it.mode } as QueuedInputDTO;
		const d = (it.entry?.data ?? {}) as any;
		const text: string = typeof d.text === "string" ? d.text : textOfContent(it.content ?? "");
		return {
			submissionId: it.id as number,
			mode: it.mode,
			text,
			displayText: userDisplay(text).displayText,
			...(typeof d.requestId === "string" ? { requestId: d.requestId } : {}),
			...(d.attachments?.length ? { attachments: d.attachments } : {}),
			...(d.knowledgeRefs?.length ? { knowledgeRefs: d.knowledgeRefs } : {}),
			...(typeof d.userId === "string" ? { userId: d.userId } : {}),
		} as QueuedInputDTO;
	});
}

/** pi SubmissionRecord (+ inbox mode while queued) → M02-C feedback status. */
export function submissionDTO(rec: SubmissionRecord, inboxMode?: "steer" | "followUp" | "write"): SubmissionDTO {
	let status: SubmissionStatus;
	let reason: string | undefined;
	switch (rec.status) {
		case "queued":
			status = inboxMode === "steer" ? "received" : "queued";
			break;
		case "placed":
			status = "applied";
			break;
		case "done":
			status = "done";
			break;
		default:
			reason = rec.reason;
			status = rec.reason === "aborted" && rec.entry === undefined ? "withdrawn" : "unanswered";
	}
	return {
		submissionId: rec.id as number,
		conversationId: rec.conversationId as number,
		...(rec.requestId ? { requestId: rec.requestId } : {}),
		status,
		...(reason ? { reason } : {}),
		...((rec as any).detail !== undefined ? { detail: (rec as any).detail } : {}),
		...((rec as any).entry !== undefined ? { entryId: (rec as any).entry as number } : {}),
		...((rec as any).answer !== undefined ? { answerEntryId: (rec as any).answer as number } : {}),
	};
}

export function taskNodeDTO(n: TaskGraphNode): TaskNodeDTO {
	const st = n.state as any;
	return {
		taskId: n.id as number,
		kind: n.kind,
		conversationId: n.conversationId as number,
		...(n.owner !== undefined ? { ownerTaskId: n.owner as number } : {}),
		background: n.background,
		abortRequested: n.abortRequested,
		status: st.status,
		...(st.phase ? { phase: st.phase } : {}),
		...(n.blocked ? { blocked: String(n.blocked) } : {}),
		conversations: n.conversations.map((c) => c as number),
	};
}
