// View model: pi entries (+ live partial) → user turns and assistant turns with an embedded step chain.
import type { ApprovalDTO, AssistantEntryDTO, ConversationState, EntryDTO, LiveToolDTO, MarkerEntryDTO, SubagentDTO, ToolCallDTO, ToolResultEntryDTO, UsageDTO, UserEntryDTO, WorkspacePrepItem } from "@shared/chat";
import type { BrowseResultDTO, JobDTO, LibItemDTO } from "@shared/files";
import type { CitationDTO } from "@shared/knowledge";

export type Step =
	/** startedAt = when the model request that produced it started (real, from pi-ai); the thinking time itself is measured by the UI while it streams. */
	| { kind: "thinking"; key: string; text: string; streaming?: boolean; startedAt?: number }
	/** Round 12: the workspace prepared for a new conversation (first step of its first answer); ms is the server's measurement. */
	| { kind: "workspace"; key: string; ms: number; items: readonly WorkspacePrepItem[] }
	| { kind: "narration"; key: string; text: string }
	| { kind: "tool"; key: string; call: ToolCallDTO; result?: ToolResultEntryDTO; live?: LiveToolDTO; approval?: ApprovalDTO; subagent?: SubagentDTO };

export interface AssistantTurn {
	kind: "assistant";
	key: string;
	/** First and last entry ids of this turn (for regenerate / fork). */
	firstEntryId?: number;
	lastAssistantEntryId?: number;
	steps: Step[];
	answer?: string;
	streaming: boolean;
	/** File cards of this turn: delivered outputs only (present_file), de-duplicated by fileId. */
	artifacts: CardRef[];
	citations: CitationDTO[];
	/** Background jobs started in this turn (job_start → details.job). */
	jobs: JobDTO[];
	error?: string;
	stopReason?: string;
	fixture: boolean;
	modelLabel?: string;
	usage?: UsageDTO;
	startedAt?: number;
	endedAt?: number;
	/** Round 12: when the message this turn answers was sent, and when the turn's last model response / tool finished (both real timestamps). */
	requestedAt?: number;
	finishedAt?: number;
}
/** What happened after a user message, for its outcome line: how many steps completed, and whether an answer eventually followed. */
export interface UserRun {
	/** Tool steps that finished successfully after this message (before the next message). */
	doneSteps: number;
	/** Tool steps the stop / a crash cut off (their result is pi-durable's "aborted" / "interrupted" error). */
	cutOffSteps: number;
	/** A final text answer exists after this message (a 继续 after a stop produces it). */
	answered: boolean;
	/** An assistant turn after this message already shows the failure inline (its error note): the outcome line must not repeat the reason. */
	errorShown: boolean;
}
export interface UserTurn {
	kind: "user";
	key: string;
	entry: UserEntryDTO;
	run?: UserRun;
}
export interface MarkerTurn {
	kind: "marker";
	key: string;
	entry: MarkerEntryDTO;
}
export type Turn = UserTurn | AssistantTurn | MarkerTurn;

function isRecord(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

/** What a file card needs to render before it is resolved against the conversation's current outputs. */
export interface CardRef {
	fileId: string;
	name: string;
	mime: string;
	size: number;
	/** Delivered item as returned by present_file (absent for legacy cards). */
	item?: LibItemDTO;
}

/** The ONLY thing that makes a file card appear: a successful present_file result (`details.kind === "wr.presented"`). */
export function presentedOf(details: unknown): LibItemDTO | null {
	if (!isRecord(details) || details.kind !== "wr.presented" || !isRecord(details.item)) return null;
	const it = details.item;
	return typeof it.fileId === "string" && typeof it.name === "string" ? (it as unknown as LibItemDTO) : null;
}

/** Legacy tools of conversations created before round 14: their result `details.artifact` still renders a card (by fileId, current file). */
const LEGACY_CARD_TOOLS = new Set(["file_create", "file_revise", "sandbox_publish"]);

/**
 * File cards of one tool result. Browser screenshots, job outputs, read / ls / copy_to_work results and uploads never create one:
 * only present_file (or, for old history, the three legacy publishing tools) does.
 */
export function cardsOf(toolName: string, details: unknown): CardRef[] {
	const item = toolName === "present_file" ? presentedOf(details) : null;
	if (item) return [{ fileId: item.fileId, name: item.name, mime: item.mime, size: item.size, item }];
	if (!LEGACY_CARD_TOOLS.has(toolName) || !isRecord(details)) return [];
	const out: CardRef[] = [];
	const push = (a: unknown) => {
		if (isRecord(a) && typeof a.fileId === "string" && typeof a.name === "string") out.push({ fileId: a.fileId, name: a.name, mime: typeof a.mime === "string" ? a.mime : "", size: typeof a.size === "number" ? a.size : 0 });
	};
	push(details.artifact);
	if (Array.isArray(details.artifacts)) details.artifacts.forEach(push);
	return out;
}
export function citationsOf(details: unknown): CitationDTO[] {
	if (!isRecord(details) || !Array.isArray(details.citations)) return [];
	return (details.citations as unknown[]).filter((c): c is CitationDTO => isRecord(c) && typeof c.chunkId === "string");
}
export function browseOf(details: unknown): BrowseResultDTO | null {
	if (!isRecord(details)) return null;
	const b = isRecord(details.browse) ? details.browse : details;
	return typeof b.finalUrl === "string" && typeof b.title === "string" ? (b as unknown as BrowseResultDTO) : null;
}

/**
 * A tool result pi-durable wrote for a call it did not run to the end: the run was stopped ("Tool x was aborted") or the process
 * died ("Tool x was interrupted …"). Not a failure of the tool; the model is told exactly this and decides what to do next.
 */
export function isCutOffResult(r: Pick<ToolResultEntryDTO, "isError" | "text" | "details"> | undefined): boolean {
	if ((r?.details as { status?: string } | undefined)?.status === "needs_reconciliation") return false; // an external write of unknown outcome has its own 待核对 card
	return !!r?.isError && /Tool .+ was (aborted|interrupted)\b/.test(r.text.slice(0, 300));
}

const modelLabel = (e: AssistantEntryDTO) => `${e.model.provider}/${e.model.modelId}`;

export function buildTurns(entries: readonly EntryDTO[], state?: Pick<ConversationState, "live" | "approvals"> & Partial<Pick<ConversationState, "subagents">>): Turn[] {
	const turns: Turn[] = [];
	const results = new Map<string, ToolResultEntryDTO>();
	for (const e of entries) if (e.kind === "tool_result") results.set(e.callId, e);
	const approvalsByCall = new Map<string, ApprovalDTO>();
	for (const a of state?.approvals ?? []) approvalsByCall.set(a.callId, a);
	const subagentsByCall = new Map<string, SubagentDTO>();
	for (const d of state?.subagents ?? []) subagentsByCall.set(d.source.callId, d);
	const liveTools = new Map<string, LiveToolDTO>();
	for (const t of state?.live.tools ?? []) liveTools.set(t.callId, t);

	let cur: AssistantTurn | null = null;
	/** Round 12: the workspace record written when the conversation was created waits for the first answer it belongs to. */
	let workspace: Extract<Step, { kind: "workspace" }> | null = null;
	let requestedAt: number | undefined;
	let answeredUser = false;
	const open = (key: string): AssistantTurn => {
		if (!cur) {
			cur = { kind: "assistant", key, steps: [], streaming: false, artifacts: [], citations: [], jobs: [], fixture: false, requestedAt };
			if (workspace && answeredUser) {
				cur.steps.push(workspace);
				workspace = null;
			}
			turns.push(cur);
		}
		return cur;
	};
	const finished = (t: AssistantTurn, at: number | undefined) => {
		if (at !== undefined && Number.isFinite(at)) t.finishedAt = Math.max(t.finishedAt ?? 0, at);
	};
	const close = () => {
		if (cur) finalize(cur);
		cur = null;
	};

	for (const e of entries) {
		switch (e.kind) {
			case "user":
				// A 未送达 marker (never placed, e.g. withdrawn by 停止) is display-only: it must not cut the assistant's turn in two,
				// or the answer a later 继续 produces would be separated from the steps before it.
				if (e.placed !== false) {
					close();
					requestedAt = e.timestamp;
					answeredUser = true;
				}
				turns.push({ kind: "user", key: `u${e.id}`, entry: e });
				break;
			case "workspace":
				workspace = { kind: "workspace", key: `ws${e.id}`, ms: e.ms, items: e.items };
				break;
			case "assistant": {
				const t = open(`a${e.id}`);
				t.firstEntryId ??= e.id;
				t.lastAssistantEntryId = e.id;
				t.fixture ||= e.fixture;
				t.modelLabel = modelLabel(e);
				t.usage = addUsage(t.usage, e.usage);
				if (e.timestamp) {
					t.startedAt ??= e.timestamp;
					t.endedAt = e.timestamp;
				}
				if (e.timestamp !== undefined && e.durationMs !== undefined) finished(t, e.timestamp + e.durationMs);
				if (e.thinking) t.steps.push({ kind: "thinking", key: `th${e.id}`, text: e.thinking, startedAt: e.timestamp });
				if (e.toolCalls.length) {
					if (e.text.trim()) t.steps.push({ kind: "narration", key: `n${e.id}`, text: e.text });
					for (const c of e.toolCalls) {
						const r = results.get(c.id);
						t.steps.push({ kind: "tool", key: `t${c.id}`, call: c, result: r, live: liveTools.get(c.id), approval: approvalsByCall.get(c.id), subagent: subagentsByCall.get(c.id) });
						if (r) {
							finished(t, r.timestamp);
							if (!r.isError) t.artifacts.push(...cardsOf(c.name, r.details));
							t.citations.push(...citationsOf(r.details));
							const job = isRecord(r.details) && isRecord(r.details.job) && typeof r.details.job.id === "string" ? (r.details.job as unknown as JobDTO) : null;
							if (job) t.jobs.push(job);
						}
					}
				} else if (e.text.trim()) {
					if (t.answer) t.steps.push({ kind: "narration", key: `n-prev${e.id}`, text: t.answer });
					t.answer = e.text;
				}
				t.stopReason = e.stopReason;
				if (e.stopReason === "error" && e.errorMessage) t.error = e.errorMessage;
				else if (e.stopReason !== "error") t.error = undefined;
				break;
			}
			case "tool_result":
				break; // attached to its call above
			case "reset":
			case "compaction":
			case "notice":
				close();
				turns.push({ kind: "marker", key: `m${e.id}`, entry: e });
				break;
			default:
				break; // start / system / other: hidden
		}
	}

	// Live partial of the current model response.
	const live = state?.live;
	if (live?.busy) {
		const t = cur ?? open("live");
		t.streaming = true;
		const p = live.partial;
		if (p) {
			// thinking streams until the response moves on to its text or tool calls
			if (p.thinking) t.steps.push({ kind: "thinking", key: "live-th", text: p.thinking, streaming: !p.text && !p.toolCalls.length, startedAt: p.startedAt });
			if (p.toolCalls.length) {
				if (p.text.trim()) t.steps.push({ kind: "narration", key: "live-n", text: p.text });
				for (const c of p.toolCalls) t.steps.push({ kind: "tool", key: `lt${c.id}`, call: c, live: liveTools.get(c.id) ?? { callId: c.id, name: c.name, status: "pending" }, approval: approvalsByCall.get(c.id), subagent: subagentsByCall.get(c.id) });
			} else if (p.text) {
				if (t.answer) t.steps.push({ kind: "narration", key: "live-prev", text: t.answer });
				t.answer = p.text;
			}
		}
	}
	close();
	// Per message: what its run did (for 「已停止（已完成 N 步）」 and the like).
	for (let i = 0; i < turns.length; i++) {
		const u = turns[i]!;
		if (u.kind !== "user") continue;
		const run: UserRun = { doneSteps: 0, cutOffSteps: 0, answered: false, errorShown: false };
		if (u.entry.placed === false) continue;
		for (let j = i + 1; j < turns.length; j++) {
			const t = turns[j]!;
			if (t.kind === "user" && t.entry.placed !== false) break;
			if (t.kind !== "assistant") continue;
			for (const st of t.steps) {
				if (st.kind !== "tool" || !st.result) continue;
				if (isCutOffResult(st.result)) run.cutOffSteps++;
				else if (!st.result.isError) run.doneSteps++;
			}
			if (t.answer && !t.error && !t.streaming) run.answered = true;
			if (t.error) run.errorShown = true;
		}
		u.run = run;
	}
	return turns;
}

function finalize(t: AssistantTurn) {
	// one card per file: an overwrite delivers the same fileId again (keep the last data, first position)
	const seen = new Map<string, CardRef>();
	for (const a of t.artifacts) seen.set(a.fileId, a);
	t.artifacts = [...seen.values()];
	const cs = new Map<string, CitationDTO>();
	for (const c of t.citations) cs.set(c.chunkId, c);
	t.citations = [...cs.values()];
}

function addUsage(a: UsageDTO | undefined, b: UsageDTO | undefined): UsageDTO | undefined {
	if (!b) return a;
	if (!a) return b;
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		costTotal: a.costTotal + b.costTotal,
		fixture: a.fixture || b.fixture,
	};
}

/** Turn text for copy / export. */
export function turnMarkdown(t: AssistantTurn): string {
	const parts: string[] = [];
	if (t.answer) parts.push(t.answer);
	if (t.citations.length) parts.push(`\n引用：\n${t.citations.map((c, i) => `[${c.n ?? i + 1}] ${c.fileName} v${c.versionNo} ${c.locator}`).join("\n")}`);
	if (t.artifacts.length) parts.push(`\n成果文件：\n${t.artifacts.map((a) => `- ${a.name}`).join("\n")}`);
	return parts.join("\n");
}
