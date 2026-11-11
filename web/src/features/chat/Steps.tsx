// What the assistant did in one turn: a single compact status line ("已完成 3 步 · 生成 1 个文件", while running
// "正在检索知识库…"), expandable into human-worded steps. Raw arguments / results live only in each step's 「技术详情」.
import { AlertCircle, Ban, BookOpen, Brain, Check, ChevronRight, CircleDashed, Clock, FileText, Globe, Hand, Loader2, MessageSquareText, PanelRight, Plug, ShieldCheck, ShieldX, Sparkles, Terminal, Timer, Users, Wrench, Bookmark, type LucideIcon } from "lucide-react";
import { useId, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { cn, durationText } from "@/lib/utils";
import { Markdown } from "@/features/markdown/Markdown";
import { usePanel, type WorkTab } from "@/components/shell/panel";
import { workTabForTool } from "@shared/sandbox";
import { artifactsOf, isCutOffResult, type AssistantTurn, type Step } from "./model";
import { describeTool, resultLine, type ToolKind } from "./toolDescribe";

type ToolStep = Extract<Step, { kind: "tool" }>;
type StepState = "pending" | "running" | "waiting" | "done" | "error" | "rejected" | "stopped";

/** An external write cut off mid-way: not a failure, the outcome is unknown and the 待核对 card asks the person. */
const needsReconcile = (s: ToolStep): boolean => !!s.result?.isError && (s.result.details as { status?: string } | undefined)?.status === "needs_reconciliation";

function stepState(s: ToolStep): StepState {
	if (s.approval?.status === "pending") return "waiting";
	if (s.approval?.status === "rejected") return "rejected";
	if (s.approval?.status === "cancelled") return "stopped";
	if (s.result) return isCutOffResult(s.result) ? "stopped" : s.result.isError ? "error" : "done";
	if (s.live?.status === "running") return "running";
	return "pending";
}

/** Result texts of this turn's failed sandbox steps (the reason the work environment could not run them), for de-duplicating the environment line. */
export function failedSandboxTexts(turn: AssistantTurn | undefined): string[] {
	return (turn?.steps ?? []).filter((s): s is ToolStep => s.kind === "tool" && s.call.name.startsWith("sandbox") && stepState(s) === "error" && !needsReconcile(s)).map((s) => s.result?.text ?? "");
}

export function workTabFor(toolName: string): WorkTab | null {
	return workTabForTool(toolName);
}

const KIND_ICON: Record<ToolKind, LucideIcon> = {
	kb: BookOpen,
	file: FileText,
	code: Terminal,
	web: Globe,
	agent: Users,
	connector: Plug,
	job: Timer,
	skill: Sparkles,
	memory: Bookmark,
	wait: Clock,
	approval: Hand,
	other: Wrench,
};

export interface TurnSummary {
	state: "running" | "waiting" | "error" | "done" | "think" | "stopped";
	text: string;
	/** Trailing remarks that deserve a colour (failures, refusals). */
	notes: { text: string; tone: "danger" | "warning" | "muted" }[];
}

/** The one-line status of a turn's tool work. Exported for tests of the wording. */
export function summarizeTurn(turn: AssistantTurn): TurnSummary {
	const tools = turn.steps.filter((s): s is ToolStep => s.kind === "tool");
	const states = tools.map(stepState);
	const waiting = tools.find((t) => stepState(t) === "waiting");
	const active = tools.find((t) => stepState(t) === "running" || stepState(t) === "pending");
	const done = states.filter((s) => s === "done").length;
	const unknown = tools.filter(needsReconcile).length;
	const failed = states.filter((s) => s === "error").length - unknown;
	const stopped = states.filter((s) => s === "stopped").length;
	const rejected = states.filter((s) => s === "rejected").length;
	const files = turn.artifacts.length;
	const notes: TurnSummary["notes"] = [];
	if (failed) notes.push({ text: `${failed} 步失败`, tone: "danger" });
	if (unknown) notes.push({ text: `${unknown} 步待核对`, tone: "warning" });
	if (rejected) notes.push({ text: `${rejected} 步被拒绝`, tone: "muted" });
	if (waiting) {
		const v = describeTool(waiting.call, { result: waiting.result, subagent: waiting.subagent });
		return { state: "waiting", text: `等待你确认：${waiting.approval?.title || v.title}`, notes: [] };
	}
	if (turn.streaming) {
		const v = active ? describeTool(active.call, { subagent: active.subagent }) : undefined;
		const think = !active && turn.steps.at(-1)?.kind === "thinking";
		const base = v ? `${v.running}…` : think ? "正在思考…" : "正在处理…";
		return { state: "running", text: done ? `${base} · 已完成 ${done} 步` : base, notes };
	}
	if (!tools.length) return { state: "think", text: "思考过程", notes: [] };
	const fileText = files ? ` · 生成 ${files} 个文件` : "";
	// A stop (or a crash) cut steps off: they are not failures, and they are not re-run on their own. The completed ones stay.
	if (stopped) {
		const cut: TurnSummary["notes"] = [{ text: `${stopped} 步被截断`, tone: "muted" }, ...notes];
		// Continued afterwards and answered: the turn is done, the cut-off step is only remarked on.
		const verb = tools.some((t) => stepState(t) === "stopped" && /was aborted/.test(t.result?.text ?? "")) || tools.some((t) => t.approval?.status === "cancelled") ? "已停止" : "已中断";
		return turn.answer ? { state: "done", text: `已完成 ${done} 步${fileText}`, notes: cut } : { state: "stopped", text: `${verb} · 已完成 ${done} 步${fileText}`, notes: cut };
	}
	if (turn.error) return { state: "error", text: `已中断 · 完成 ${done} 步${fileText}`, notes };
	return { state: failed ? "error" : unknown ? "waiting" : "done", text: `已完成 ${tools.length} 步${fileText}`, notes };
}

export function StepChain({ turn, onOpenWork }: { turn: AssistantTurn; onOpenWork?: (tab: WorkTab) => void }) {
	const [open, setOpen] = useState(false);
	/** The failed step whose 详情 was asked for: the chain opens with that step already expanded. */
	const [pinned, setPinned] = useState<string>();
	const listId = useId();
	if (!turn.steps.length) return null;
	const sum = summarizeTurn(turn);
	const failed = turn.steps.filter((s): s is ToolStep => s.kind === "tool" && stepState(s) === "error" && !needsReconcile(s));
	const icon =
		sum.state === "running" ? (
			<Loader2 aria-hidden className="size-3.5 shrink-0 wr-spin text-info" />
		) : sum.state === "waiting" ? (
			<Hand aria-hidden className="size-3.5 shrink-0 wr-pulse text-warning" />
		) : sum.state === "error" ? (
			<AlertCircle aria-hidden className="size-3.5 shrink-0 text-danger" />
		) : sum.state === "stopped" ? (
			<Ban aria-hidden className="size-3.5 shrink-0 text-fg-muted" />
		) : sum.state === "think" ? (
			<Brain aria-hidden className="size-3.5 shrink-0 text-fg-subtle" />
		) : (
			<Check aria-hidden className="size-3.5 shrink-0 wr-fade-in text-success" />
		);
	return (
		<div data-testid="step-chain" data-state={sum.state} className="mb-3">
			<button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={listId} className="group inline-flex max-w-full items-center gap-1.5 rounded-md py-0.5 pr-1 text-[13px] text-fg-muted hover:text-fg focus-visible:ring-2 focus-visible:ring-info">
				{icon}
				<span data-testid="run-summary" aria-live="polite" className="truncate">
					{sum.text}
				</span>
				{sum.notes.map((n) => (
					<span key={n.text} className={cn("shrink-0", n.tone === "danger" ? "text-danger" : n.tone === "warning" ? "text-warning" : "text-fg-subtle")}>
						· {n.text}
					</span>
				))}
				<ChevronRight aria-hidden className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
			</button>
			{!open && failed.length ? (
				<div data-testid="step-failure" className="mt-0.5 space-y-0.5">
					{failed.slice(0, 2).map((s) => (
						<StepFailureLine
							key={s.key}
							step={s}
							onDetails={() => {
								setPinned(s.key);
								setOpen(true);
							}}
						/>
					))}
					{failed.length > 2 ? <p className="pl-5 text-xs text-fg-muted">另有 {failed.length - 2} 步失败，展开查看。</p> : null}
				</div>
			) : null}
			<AnimatePresence initial={false}>
				{open ? (
					<m.div id={listId} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.16 }} className="overflow-hidden">
						<ol className="mt-1.5 space-y-0.5 border-l border-border pl-3">
							{turn.steps.map((s) => (
								<li key={s.key}>
									<StepRow step={s} onOpenWork={onOpenWork} initiallyOpen={s.key === pinned} />
								</li>
							))}
						</ol>
					</m.div>
				) : null}
			</AnimatePresence>
		</div>
	);
}

/** One failed step, once, in plain words under the summary: what failed and why in one line; 详情 opens the step (with 技术详情). */
function StepFailureLine({ step, onDetails }: { step: ToolStep; onDetails: () => void }) {
	const view = describeTool(step.call, { result: step.result, subagent: step.subagent });
	const why = resultLine(step.call, step.result, step.subagent);
	return (
		<p className="flex min-w-0 items-center gap-1.5 text-[12.5px] leading-5 text-danger">
			<AlertCircle aria-hidden className="size-3.5 shrink-0" />
			<span className="min-w-0 flex-1 truncate" title={why}>
				{view.title}失败{why ? `：${why}` : ""}
			</span>
			<button type="button" onClick={onDetails} className="shrink-0 rounded px-1 text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info">
				详情
			</button>
		</p>
	);
}

function StepRow({ step, onOpenWork, initiallyOpen = false }: { step: Step; onOpenWork?: (tab: WorkTab) => void; initiallyOpen?: boolean }) {
	const [open, setOpen] = useState(initiallyOpen);
	const { openPreview } = usePanel();
	if (step.kind === "thinking")
		return (
			<details className="group py-1 text-[13px]" open={step.streaming}>
				<summary className="flex cursor-pointer list-none items-center gap-1.5 text-fg-muted hover:text-fg">
					<Brain aria-hidden className="size-3.5" />
					{step.streaming ? "思考中…" : "思考"}
				</summary>
				<div className="wr-scroll mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-fg-muted">{step.text}</div>
			</details>
		);
	if (step.kind === "narration")
		return (
			<div className="flex gap-1.5 py-1 text-[13px] text-fg-muted">
				<MessageSquareText aria-hidden className="mt-1 size-3.5 shrink-0" />
				<div className="min-w-0 flex-1">
					<Markdown text={step.text} className="text-[13px] leading-6 text-fg-muted" />
				</div>
			</div>
		);

	const st = stepState(step);
	const view = describeTool(step.call, { result: step.result, subagent: step.subagent });
	const tab = workTabFor(step.call.name);
	const ms = (step.result?.details as { durationMs?: number } | undefined)?.durationMs;
	const outcome = resultLine(step.call, step.result, step.subagent);
	const files = step.result ? artifactsOf(step.result.details).filter((f) => !/browse|browser/.test(step.call.name)) : [];
	const Kind = KIND_ICON[view.kind];
	return (
		<div data-testid="tool-step" data-state={st} data-tool={step.call.name} className="py-0.5">
			<button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 text-left text-[13px] hover:text-fg focus-visible:ring-2 focus-visible:ring-info">
				<StateIcon state={st} Kind={Kind} />
				<span className={cn("min-w-0 flex-1 truncate", st === "pending" || st === "rejected" || st === "stopped" ? "text-fg-muted" : "text-fg")}>{view.title}</span>
				{ms ? <span className="shrink-0 text-xs text-fg-subtle">{durationText(ms)}</span> : null}
				{st === "running" ? <span className="shrink-0 text-xs text-info">进行中</span> : null}
				{st === "waiting" ? <span className="shrink-0 text-xs text-warning">待确认</span> : null}
				{st === "rejected" ? <span className="shrink-0 text-xs text-fg-muted">已拒绝</span> : null}
				{st === "stopped" ? <span className="shrink-0 text-xs text-fg-muted">已停止</span> : null}
				{st === "error" ? <span className="shrink-0 text-xs text-danger">失败</span> : null}
				<ChevronRight aria-hidden className={cn("size-3.5 shrink-0 text-fg-subtle transition-transform", open && "rotate-90")} />
			</button>
			{open ? (
				<div className="wr-fade-in mb-2 ml-5 space-y-2 text-[12.5px]">
					{step.approval ? (
						<div className="flex items-center gap-1.5 text-fg-muted">
							{step.approval.status === "approved" ? <ShieldCheck aria-hidden className="size-3.5 text-success" /> : step.approval.status === "rejected" ? <ShieldX aria-hidden className="size-3.5 text-danger" /> : step.approval.status === "cancelled" ? <Ban aria-hidden className="size-3.5 text-fg-muted" /> : <Hand aria-hidden className="size-3.5 text-warning" />}
							{step.approval.title} · {step.approval.status === "pending" ? "等待你确认" : step.approval.status === "approved" ? "已允许" : step.approval.status === "cancelled" ? "已取消" : "已拒绝"}
							{step.approval.note ? `（${step.approval.note}）` : ""}
						</div>
					) : null}
					{st === "stopped" ? <p className="text-fg-muted">这一步被截断，未执行完。</p> : outcome ? <p className={cn(st === "error" ? "text-danger" : "text-fg-muted")}>{outcome}</p> : st === "running" ? <p className="text-fg-muted">{view.running}…</p> : null}
					{step.call.name === "delegate" && step.subagent?.task ? <p className="text-fg-muted">任务：{step.subagent.task}</p> : null}
					{step.result?.diagnostics?.length ? (
						<ul className="space-y-0.5 text-fg-muted">
							{step.result.diagnostics.map((d, i) => (
								<li key={i}>{d.message}</li>
							))}
						</ul>
					) : null}
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
						{files.slice(0, 2).map((f) => (
							<button key={f.versionId} onClick={() => openPreview({ fileId: f.fileId, versionId: f.versionId, name: f.name, mime: f.mime })} className="inline-flex items-center gap-1 text-info hover:underline">
								<FileText aria-hidden className="size-3.5" />
								预览 {f.name}
							</button>
						))}
						{tab && onOpenWork ? (
							<button onClick={() => onOpenWork(tab)} className="inline-flex items-center gap-1 text-info hover:underline">
								<PanelRight aria-hidden className="size-3.5" />
								{tab === "files" ? "在工作区中打开" : "在工作面板中查看"}
							</button>
						) : null}
					</div>
					<TechDetails name={step.call.name} args={step.call.arguments} result={step.result?.text} live={step.live?.output} isError={step.result?.isError} />
				</div>
			) : null}
		</div>
	);
}

/** Raw arguments and results, collapsed by default. Nothing in here is shown until the person asks for it. */
export function TechDetails({ name, args, result, live, isError }: { name: string; args: unknown; result?: string; live?: string; isError?: boolean }) {
	return (
		<details data-testid="tech-details" className="group/tech">
			<summary className="inline-flex cursor-pointer list-none items-center gap-1 text-fg-subtle hover:text-fg focus-visible:ring-2 focus-visible:ring-info">
				<ChevronRight aria-hidden className="size-3 transition-transform group-open/tech:rotate-90" />
				技术详情
			</summary>
			<div className="mt-1 space-y-2">
				<Block title="工具" body={name} />
				<Block title="参数" body={JSON.stringify(args, null, 2) ?? ""} />
				{result !== undefined ? <Block title={isError ? "错误" : "结果"} body={result} tone={isError ? "danger" : undefined} /> : live ? <Block title="输出（进行中）" body={live} /> : null}
			</div>
		</details>
	);
}

function Block({ title, body, tone }: { title: string; body: string; tone?: "danger" }) {
	const [all, setAll] = useState(false);
	const long = body.length > 1200;
	return (
		<div>
			<div className="mb-0.5 text-xs text-fg-subtle">{title}</div>
			<pre className={cn("wr-scroll max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-2 px-2.5 py-2 font-mono text-[12px] leading-5", tone === "danger" ? "text-danger" : "text-fg-muted")}>{long && !all ? `${body.slice(0, 1200)}…` : body}</pre>
			{long ? (
				<button onClick={() => setAll((a) => !a)} className="mt-0.5 text-xs text-info hover:underline">
					{all ? "收起" : "展开全部"}
				</button>
			) : null}
		</div>
	);
}

function StateIcon({ state, Kind }: { state: StepState; Kind: LucideIcon }) {
	const cls = "size-3.5 shrink-0";
	switch (state) {
		case "running":
			return <Loader2 aria-hidden className={cn(cls, "wr-spin text-info")} />;
		case "pending":
			return <CircleDashed aria-hidden className={cn(cls, "text-fg-subtle")} />;
		case "waiting":
			return <Hand aria-hidden className={cn(cls, "text-warning")} />;
		case "error":
			return <AlertCircle aria-hidden className={cn(cls, "text-danger")} />;
		case "rejected":
			return <ShieldX aria-hidden className={cn(cls, "text-fg-muted")} />;
		case "stopped":
			return <Ban aria-hidden className={cn(cls, "text-fg-muted")} />;
		default:
			return <Kind aria-hidden className={cn(cls, "text-fg-subtle")} />;
	}
}
