// Plan / execution / tool calls embedded in the assistant message, progressively expandable.
import { AlertCircle, Brain, Check, ChevronRight, CircleDashed, Hand, Loader2, MessageSquareText, PanelRight, ShieldCheck, ShieldX, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { cn, durationText } from "@/lib/utils";
import { Markdown } from "@/features/markdown/Markdown";
import type { WorkTab } from "@/components/shell/panel";
import { workTabForTool } from "@shared/sandbox";
import { toolLabel, type AssistantTurn, type Step } from "./model";

type StepState = "pending" | "running" | "waiting" | "done" | "error" | "rejected";

function stepState(s: Extract<Step, { kind: "tool" }>): StepState {
	if (s.approval?.status === "pending") return "waiting";
	if (s.approval?.status === "rejected") return "rejected";
	if (s.result) return s.result.isError ? "error" : "done";
	if (s.live?.status === "running") return "running";
	return "pending";
}

function argSummary(args: unknown): string {
	if (args == null) return "";
	if (typeof args !== "object") return String(args);
	const o = args as Record<string, unknown>;
	for (const k of ["query", "name", "title", "url", "path", "task", "language", "command"]) if (typeof o[k] === "string") return String(o[k]);
	const s = JSON.stringify(args);
	return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

export function workTabFor(toolName: string): WorkTab | null {
	return workTabForTool(toolName);
}

export function StepChain({ turn, onOpenWork }: { turn: AssistantTurn; onOpenWork?: (tab: WorkTab) => void }) {
	const tools = turn.steps.filter((s): s is Extract<Step, { kind: "tool" }> => s.kind === "tool");
	const waiting = tools.some((t) => stepState(t) === "waiting");
	const failed = tools.filter((t) => stepState(t) === "error").length;
	const active = tools.find((t) => ["running", "pending", "waiting"].includes(stepState(t)));
	const [open, setOpen] = useState(turn.streaming || waiting);
	useEffect(() => {
		if (turn.streaming || waiting) setOpen(true);
	}, [turn.streaming, waiting]);
	if (!turn.steps.length) return null;

	const dur = turn.startedAt && turn.endedAt && turn.endedAt > turn.startedAt ? durationText(turn.endedAt - turn.startedAt) : "";
	let label: string;
	if (waiting) label = "等待你确认";
	else if (turn.streaming) label = active ? `正在${toolLabel(active.call.name)}` : turn.steps.at(-1)?.kind === "thinking" ? "正在思考" : "正在处理";
	else if (turn.error) label = tools.length ? `执行中断 · ${tools.length} 个步骤` : "生成失败";
	else label = tools.length ? `已完成 ${tools.length} 个步骤${dur ? ` · 用时 ${dur}` : ""}` : "思考过程";

	return (
		<div data-testid="step-chain" className="mb-3">
			<button
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				className="group inline-flex max-w-full items-center gap-1.5 rounded-md py-0.5 pr-1 text-[13px] text-fg-muted hover:text-fg"
			>
				{turn.streaming && !waiting ? <Loader2 className="size-3.5 wr-spin text-info" /> : waiting ? <Hand className="size-3.5 text-warning" /> : failed || turn.error ? <AlertCircle className="size-3.5 text-danger" /> : <Check className="size-3.5 text-success" />}
				<span className="truncate">{label}</span>
				{failed && !turn.streaming ? <span className="text-danger">· {failed} 个失败</span> : null}
				<ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
			</button>
			<AnimatePresence initial={false}>
				{open ? (
					<m.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.16 }} className="overflow-hidden">
						<ol className="mt-1.5 space-y-0.5 border-l border-border pl-3">
							{turn.steps.map((s) => (
								<li key={s.key}>
									<StepRow step={s} onOpenWork={onOpenWork} />
								</li>
							))}
						</ol>
					</m.div>
				) : null}
			</AnimatePresence>
		</div>
	);
}

function StepRow({ step, onOpenWork }: { step: Step; onOpenWork?: (tab: WorkTab) => void }) {
	const [open, setOpen] = useState(false);
	if (step.kind === "thinking")
		return (
			<details className="group py-1 text-[13px]" open={step.streaming}>
				<summary className="flex cursor-pointer list-none items-center gap-1.5 text-fg-muted hover:text-fg">
					<Brain className="size-3.5" />
					{step.streaming ? "思考中…" : "思考"}
				</summary>
				<div className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-fg-muted wr-scroll">{step.text}</div>
			</details>
		);
	if (step.kind === "narration")
		return (
			<div className="flex gap-1.5 py-1 text-[13px] text-fg-muted">
				<MessageSquareText className="mt-1 size-3.5 shrink-0" />
				<div className="min-w-0 flex-1">
					<Markdown text={step.text} className="text-[13px] leading-6 text-fg-muted" />
				</div>
			</div>
		);

	const st = stepState(step);
	const tab = workTabFor(step.call.name);
	const ms = (step.result?.details as { durationMs?: number } | undefined)?.durationMs;
	return (
		<div data-testid="tool-step" data-state={st} className="py-0.5">
			<button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 text-left text-[13px] hover:text-fg">
				<StateIcon state={st} />
				<span className="shrink-0 font-medium text-fg">{toolLabel(step.call.name)}</span>
				<span className="min-w-0 flex-1 truncate text-fg-subtle">{argSummary(step.call.arguments)}</span>
				{ms ? <span className="shrink-0 text-xs text-fg-subtle">{durationText(ms)}</span> : null}
				{st === "waiting" ? <span className="shrink-0 text-xs text-warning">待确认</span> : null}
				{st === "rejected" ? <span className="shrink-0 text-xs text-fg-muted">已拒绝</span> : null}
				<ChevronRight className={cn("size-3.5 shrink-0 text-fg-subtle transition-transform", open && "rotate-90")} />
			</button>
			{open ? (
				<div className="mb-2 ml-5 space-y-2 text-[12.5px] wr-fade-in">
					{step.approval ? (
						<div className="flex items-center gap-1.5 text-fg-muted">
							{step.approval.status === "approved" ? <ShieldCheck className="size-3.5 text-success" /> : step.approval.status === "rejected" ? <ShieldX className="size-3.5 text-danger" /> : <Hand className="size-3.5 text-warning" />}
							确认：{step.approval.title} · {step.approval.status === "pending" ? "等待中" : step.approval.status === "approved" ? "已批准" : "已拒绝"}
							{step.approval.note ? `（${step.approval.note}）` : ""}
						</div>
					) : null}
					<Block title="参数" body={JSON.stringify(step.call.arguments, null, 2)} />
					{step.result ? (
						<Block title={step.result.isError ? "错误" : "结果"} body={step.result.text} tone={step.result.isError ? "danger" : undefined} />
					) : step.live?.output ? (
						<Block title="输出（进行中）" body={step.live.output} />
					) : null}
					{step.result?.diagnostics?.length ? (
						<ul className="space-y-0.5 text-fg-muted">
							{step.result.diagnostics.map((d, i) => (
								<li key={i}>
									[{d.severity}] {d.message}
									{d.code ? ` (${d.code})` : ""}
								</li>
							))}
						</ul>
					) : null}
					{tab && onOpenWork ? (
						<button onClick={() => onOpenWork(tab)} className="inline-flex items-center gap-1 text-info hover:underline">
							<PanelRight className="size-3.5" />
							{tab === "files" ? "在工作区中打开" : "在工作面板中查看"}
						</button>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function Block({ title, body, tone }: { title: string; body: string; tone?: "danger" }) {
	const [all, setAll] = useState(false);
	const long = body.length > 1200;
	return (
		<div>
			<div className="mb-0.5 text-[11.5px] text-fg-subtle">{title}</div>
			<pre className={cn("wr-scroll max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-2 px-2.5 py-2 font-mono text-[12px] leading-5", tone === "danger" ? "text-danger" : "text-fg-muted")}>
				{long && !all ? `${body.slice(0, 1200)}…` : body}
			</pre>
			{long ? (
				<button onClick={() => setAll((a) => !a)} className="mt-0.5 text-[11.5px] text-info hover:underline">
					{all ? "收起" : "展开全部"}
				</button>
			) : null}
		</div>
	);
}

function StateIcon({ state }: { state: StepState }) {
	switch (state) {
		case "running":
			return <Loader2 className="size-3.5 shrink-0 wr-spin text-info" />;
		case "pending":
			return <CircleDashed className="size-3.5 shrink-0 text-fg-subtle" />;
		case "waiting":
			return <Hand className="size-3.5 shrink-0 text-warning" />;
		case "error":
			return <AlertCircle className="size-3.5 shrink-0 text-danger" />;
		case "rejected":
			return <ShieldX className="size-3.5 shrink-0 text-fg-muted" />;
		default:
			return <Wrench className="size-3.5 shrink-0 text-success" />;
	}
}
