// View model: pi entries (+ live partial) → user turns and assistant turns with an embedded step chain.
import type { ApprovalDTO, AssistantEntryDTO, ConversationState, EntryDTO, LiveToolDTO, MarkerEntryDTO, ToolCallDTO, ToolResultEntryDTO, UsageDTO, UserEntryDTO } from "@shared/chat";
import type { BrowseResultDTO, FileVersionRefDTO, JobDTO } from "@shared/files";
import type { CitationDTO } from "@shared/knowledge";

export type Step =
	| { kind: "thinking"; key: string; text: string; streaming?: boolean }
	| { kind: "narration"; key: string; text: string }
	| { kind: "tool"; key: string; call: ToolCallDTO; result?: ToolResultEntryDTO; live?: LiveToolDTO; approval?: ApprovalDTO };

export interface AssistantTurn {
	kind: "assistant";
	key: string;
	/** First and last entry ids of this turn (for regenerate / fork). */
	firstEntryId?: number;
	lastAssistantEntryId?: number;
	steps: Step[];
	answer?: string;
	streaming: boolean;
	artifacts: FileVersionRefDTO[];
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
}
export interface UserTurn {
	kind: "user";
	key: string;
	entry: UserEntryDTO;
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

/** File cards: tool results carry `details.artifact` (FileVersionRefDTO) — also accept `artifacts[]`. */
export function artifactsOf(details: unknown): FileVersionRefDTO[] {
	if (!isRecord(details)) return [];
	const out: FileVersionRefDTO[] = [];
	const push = (a: unknown) => {
		if (isRecord(a) && typeof a.fileId === "string" && typeof a.versionId === "string") out.push(a as unknown as FileVersionRefDTO);
	};
	push(details.artifact);
	if (Array.isArray(details.artifacts)) details.artifacts.forEach(push);
	if (isRecord(details.screenshot)) push(details.screenshot);
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

const modelLabel = (e: AssistantEntryDTO) => `${e.model.provider}/${e.model.modelId}`;

export function buildTurns(entries: readonly EntryDTO[], state?: Pick<ConversationState, "live" | "approvals">): Turn[] {
	const turns: Turn[] = [];
	const results = new Map<string, ToolResultEntryDTO>();
	for (const e of entries) if (e.kind === "tool_result") results.set(e.callId, e);
	const approvalsByCall = new Map<string, ApprovalDTO>();
	for (const a of state?.approvals ?? []) approvalsByCall.set(a.callId, a);
	const liveTools = new Map<string, LiveToolDTO>();
	for (const t of state?.live.tools ?? []) liveTools.set(t.callId, t);

	let cur: AssistantTurn | null = null;
	const open = (key: string): AssistantTurn => {
		if (!cur) {
			cur = { kind: "assistant", key, steps: [], streaming: false, artifacts: [], citations: [], jobs: [], fixture: false };
			turns.push(cur);
		}
		return cur;
	};
	const close = () => {
		if (cur) finalize(cur);
		cur = null;
	};

	for (const e of entries) {
		switch (e.kind) {
			case "user":
				close();
				turns.push({ kind: "user", key: `u${e.id}`, entry: e });
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
				if (e.thinking) t.steps.push({ kind: "thinking", key: `th${e.id}`, text: e.thinking });
				if (e.toolCalls.length) {
					if (e.text.trim()) t.steps.push({ kind: "narration", key: `n${e.id}`, text: e.text });
					for (const c of e.toolCalls) {
						const r = results.get(c.id);
						t.steps.push({ kind: "tool", key: `t${c.id}`, call: c, result: r, live: liveTools.get(c.id), approval: approvalsByCall.get(c.id) });
						if (r) {
							t.artifacts.push(...artifactsOf(r.details));
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
			if (p.thinking) t.steps.push({ kind: "thinking", key: "live-th", text: p.thinking, streaming: true });
			if (p.toolCalls.length) {
				if (p.text.trim()) t.steps.push({ kind: "narration", key: "live-n", text: p.text });
				for (const c of p.toolCalls) t.steps.push({ kind: "tool", key: `lt${c.id}`, call: c, live: liveTools.get(c.id) ?? { callId: c.id, name: c.name, status: "pending" } });
			} else if (p.text) {
				if (t.answer) t.steps.push({ kind: "narration", key: "live-prev", text: t.answer });
				t.answer = p.text;
			}
		}
	}
	close();
	return turns;
}

function finalize(t: AssistantTurn) {
	// de-dup artifacts by versionId (keep last)
	const seen = new Map<string, FileVersionRefDTO>();
	for (const a of t.artifacts) seen.set(a.versionId, a);
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
	if (t.artifacts.length) parts.push(`\n成果文件：\n${t.artifacts.map((a) => `- ${a.name} (v${a.versionNo})`).join("\n")}`);
	return parts.join("\n");
}

export const TOOL_LABEL: Record<string, string> = {
	kb_search: "检索知识库",
	file_create: "生成文件",
	file_update: "更新文件",
	file_read: "读取文件",
	sandbox_exec: "执行代码",
	sandbox_run: "执行代码",
	sandbox_publish: "发布成果",
	browse: "打开网页",
	delegate: "委派子任务",
	ask_user: "询问你",
	memory_save: "保存记忆",
};
export const toolLabel = (name: string) => TOOL_LABEL[name] ?? (name.startsWith("mcp__") ? `外部工具 · ${name.split("__").slice(1).join(" / ")}` : name);
