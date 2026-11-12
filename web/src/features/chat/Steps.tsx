// What the assistant did in one turn (round 12, modelled on DeepSeek Harness' ToolRow / ReasoningRow / turn process):
//  - every step is ONE quiet row: icon · name · short outcome …… status / duration ›. The row itself is the only way in: the chevron on
//    its right turns and the row opens in place (arguments and output for a tool, the full text for thinking). No other detail links.
//  - thinking streams in a small self-scrolling window under "思考中 · N 秒" and folds into one line when it is done.
//  - adjacent process steps (thinking + tool calls) form a group with one summary header; while the turn runs the group follows its
//    newest line, once the turn is done and answered the whole process folds into "已完成，用时 N 秒 ›".
// Times shown are real: tool durations and turn spans come from the server's timestamps, thinking time is measured while it streams.
import { AlertCircle, Bookmark, BookOpen, Brain, ChevronRight, Clock, FileText, FolderCheck, Globe, Hand, Layers, Plug, Sparkles, Terminal, Timer, Users, Wrench, type LucideIcon } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, m } from "motion/react";
import { cn, durationText } from "@/lib/utils";
import { Markdown } from "@/features/markdown/Markdown";
import { isCutOffResult, type AssistantTurn, type Step } from "./model";
import { describeTool, resultLine, type ToolKind } from "./toolDescribe";
import { cleanTestText } from "./testText";

type ToolStep = Extract<Step, { kind: "tool" }>;
type ThinkStep = Extract<Step, { kind: "thinking" }>;
type WorkspaceStep = Extract<Step, { kind: "workspace" }>;
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

// ------------------------------------------------------------------ time

/** A clock that ticks once a second while `active` (and only then). */
function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [active]);
	return now;
}

/** Whole seconds for a running clock ("12 秒", "1 分 05 秒"). */
export function secondsText(ms: number): string {
	const s = Math.max(1, Math.round(ms / 1000));
	if (s < 60) return `${s} 秒`;
	return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, "0")} 秒`;
}

/** Thinking time measured in this tab while it streamed, by the start of the model request (the same value on the live partial and the stored entry). */
const thinkTimes = new Map<number, number>();
const thinkListeners = new Set<() => void>();
function rememberThinkTime(key: number, ms: number) {
	if (thinkTimes.has(key)) return;
	thinkTimes.set(key, ms);
	for (const l of thinkListeners) l();
}
/** The measured thinking time for a model request, re-rendering when it becomes known. */
function useThinkTime(key: number | undefined): number | undefined {
	const [, bump] = useState(0);
	useEffect(() => {
		const l = () => bump((n) => n + 1);
		thinkListeners.add(l);
		return () => void thinkListeners.delete(l);
	}, []);
	return key === undefined ? undefined : thinkTimes.get(key);
}

// ------------------------------------------------------------------ the row

interface RowProps {
	icon: ReactNode;
	title: string;
	/** Short trailing words after the title ("找到 3 处相关资料"); the error line for a failure. */
	summary?: string;
	/** Right side before the chevron: a status word or a duration. */
	trailing?: ReactNode;
	tone?: "danger" | "muted";
	running?: boolean;
	open: boolean;
	expandable: boolean;
	onToggle: () => void;
	children?: ReactNode;
	testId?: string;
	data?: Record<string, string | undefined>;
}

/** One 28px process row. The whole row toggles; the chevron on the right is the only detail affordance. */
export function FlowRow({ icon, title, summary, trailing, tone, running, open, expandable, onToggle, children, testId, data }: RowProps) {
	const bodyId = useId();
	const head = (
		<>
			<span aria-hidden className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5">
				{icon}
			</span>
			<span className={cn("shrink-0 truncate", running && "wr-shimmer", tone === "danger" && "text-danger")}>{title}</span>
			{summary ? (
				<span className={cn("min-w-0 truncate", tone === "danger" ? "text-danger/90" : "text-fg-subtle")}>
					<span aria-hidden className="mx-1.5">·</span>
					{summary}
				</span>
			) : null}
			<span className="min-w-2 flex-1" />
			{trailing ? <span className="shrink-0 text-xs tabular-nums text-fg-subtle">{trailing}</span> : null}
			{expandable ? <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 text-fg-subtle transition-transform duration-150", open && "rotate-90")} /> : <span className="w-3.5 shrink-0" />}
		</>
	);
	const rowCls = "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md text-left text-[13px] text-fg-muted";
	return (
		<div data-testid={testId} {...data}>
			{expandable ? (
				<button type="button" onClick={onToggle} aria-expanded={open} aria-controls={bodyId} className={cn(rowCls, "transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info")}>
					{head}
				</button>
			) : (
				<div className={rowCls}>{head}</div>
			)}
			{open && expandable ? (
				<div id={bodyId} className="wr-fade-in mb-1.5 ml-[22px] mt-0.5">
					{children}
				</div>
			) : null}
		</div>
	);
}

// ------------------------------------------------------------------ tool

const CODE_TOOLS = new Set(["sandbox_exec"]);
const MAX_SHOWN = 20_000;

function Io({ label, body, tone }: { label: string; body: string; tone?: "danger" }) {
	const cut = body.length > MAX_SHOWN;
	return (
		<div>
			<div className="mb-0.5 text-[11.5px] text-fg-subtle">{label}</div>
			<pre className={cn("wr-scroll max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 px-2.5 py-2 font-mono text-[12px] leading-5", tone === "danger" ? "text-danger" : "text-fg-muted")}>
				{cut ? `${body.slice(0, MAX_SHOWN)}\n…（其余 ${(body.length - MAX_SHOWN).toLocaleString()} 个字符未显示）` : body}
			</pre>
		</div>
	);
}

function inputText(step: ToolStep): { label: string; body: string } | null {
	const a = step.call.arguments as Record<string, unknown> | undefined;
	if (CODE_TOOLS.has(step.call.name) && typeof a?.code === "string") return { label: "代码", body: a.code };
	// exec: the command itself is the input (its stdout / stderr are the output below)
	if (step.call.name === "exec" && typeof a?.command === "string") return { label: "命令", body: a.command };
	if (a === undefined || a === null || (typeof a === "object" && !Object.keys(a).length)) return null;
	return { label: "参数", body: JSON.stringify(a, null, 2) ?? "" };
}

function exitCodeOf(step: ToolStep): number | undefined {
	const d = step.result?.details as { exitCode?: unknown } | undefined;
	return typeof d?.exitCode === "number" ? d.exitCode : undefined;
}

const STATE_WORD: Partial<Record<StepState, { text: string; cls: string }>> = {
	waiting: { text: "待确认", cls: "text-warning" },
	error: { text: "失败", cls: "text-danger" },
	rejected: { text: "已拒绝", cls: "text-fg-subtle" },
	stopped: { text: "已停止", cls: "text-fg-subtle" },
};

export function ToolRow({ step }: { step: ToolStep }) {
	const [open, setOpen] = useState(false);
	const st = stepState(step);
	const view = describeTool(step.call, { result: step.result, subagent: step.subagent });
	const Kind = KIND_ICON[view.kind];
	const ms = step.result?.durationMs ?? (step.result?.details as { durationMs?: number } | undefined)?.durationMs;
	const outcome = st === "stopped" ? "" : resultLine(step.call, step.result, step.subagent);
	const exit = exitCodeOf(step);
	const word = STATE_WORD[st];
	const input = inputText(step);
	const output = step.result ? cleanTestText(step.result.text) : step.live?.output;
	const running = st === "running" || st === "pending";
	const trailing = word ? (
		<span className={word.cls}>{word.text}</span>
	) : exit !== undefined && exit !== 0 ? (
		<span className="rounded bg-danger-soft px-1 text-danger">退出码 {exit}</span>
	) : st === "done" && ms !== undefined ? (
		durationText(ms)
	) : null;
	return (
		<FlowRow
			testId="tool-step"
			data={{ "data-state": st, "data-tool": step.call.name }}
			icon={st === "error" ? <AlertCircle className="text-danger" /> : <Kind />}
			title={running ? `${view.running}…` : view.title}
			summary={outcome}
			tone={st === "error" ? "danger" : undefined}
			running={running}
			trailing={trailing}
			open={open}
			expandable={!!(input || output || step.approval || step.subagent?.task || step.result?.diagnostics?.length)}
			onToggle={() => setOpen((o) => !o)}
		>
			<div className="space-y-2 text-[12.5px]">
				{step.approval ? (
					<p className="text-fg-muted">
						{step.approval.title} · {step.approval.status === "pending" ? "等待你确认" : step.approval.status === "approved" ? "已允许" : step.approval.status === "cancelled" ? "已取消" : "已拒绝"}
						{step.approval.note ? `（${step.approval.note}）` : ""}
					</p>
				) : null}
				{step.call.name === "delegate" && step.subagent?.task ? <p className="text-fg-muted">任务：{step.subagent.task}</p> : null}
				{input ? <Io label={input.label} body={input.body} /> : null}
				{output ? <Io label={running ? "输出（进行中）" : st === "error" ? "错误" : "输出"} body={output} tone={st === "error" ? "danger" : undefined} /> : null}
				{step.result?.diagnostics?.length ? (
					<ul className="space-y-0.5 text-fg-muted">
						{step.result.diagnostics.map((d, i) => (
							<li key={i}>{d.message}</li>
						))}
					</ul>
				) : null}
			</div>
		</FlowRow>
	);
}

// ------------------------------------------------------------------ thinking

const firstLine = (text: string): string =>
	text
		.split("\n")
		.map((l) => l.replaceAll("**", "").replace(/^#+\s*/, "").trim())
		.find(Boolean) ?? "";

/** The live window: the newest lines of the thought, following the text as it grows, older lines fading out at the top. */
function ThinkWindow({ text }: { text: string }) {
	const ref = useRef<HTMLDivElement>(null);
	const [over, setOver] = useState(false);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		setOver(el.scrollHeight > el.clientHeight + 2);
		el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
	}, [text]);
	return (
		<div ref={ref} data-testid="think-window" data-overflow={over || undefined} className={cn("ml-[22px] max-h-[7.5rem] overflow-hidden whitespace-pre-wrap break-words text-[12.5px] leading-5 text-fg-subtle", over && "wr-fade-top")}>
			{text}
		</div>
	);
}

export function ThinkRow({ step }: { step: ThinkStep }) {
	const [open, setOpen] = useState(false);
	const streaming = !!step.streaming;
	// measured from the start of the model request while it streams; frozen (and remembered for the stored entry) when it moves on
	const since = useRef(step.startedAt ?? Date.now());
	const now = useNow(streaming);
	useEffect(() => {
		const key = step.startedAt;
		if (key === undefined) return;
		if (!streaming && step.key === "live-th") rememberThinkTime(key, Date.now() - since.current);
		return () => {
			if (streaming) rememberThinkTime(key, Date.now() - since.current);
		};
	}, [streaming, step.startedAt, step.key]);
	const measured = useThinkTime(step.startedAt);
	const title = streaming ? "思考中" : measured !== undefined ? `已思考 ${secondsText(measured)}` : "思考";
	return (
		<div data-testid="think-step" data-state={streaming ? "running" : "done"}>
			<FlowRow
				icon={<Brain />}
				title={title}
				summary={streaming || open ? undefined : firstLine(step.text)}
				running={streaming}
				trailing={streaming ? secondsText(now - since.current) : undefined}
				open={open}
				expandable
				onToggle={() => setOpen((o) => !o)}
			>
				<div className="wr-scroll max-h-96 overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] leading-5 text-fg-muted">{step.text}</div>
			</FlowRow>
			<AnimatePresence initial={false}>
				{streaming && !open ? (
					<m.div key="w" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
						<ThinkWindow text={step.text} />
					</m.div>
				) : null}
			</AnimatePresence>
		</div>
	);
}

// ------------------------------------------------------------------ workspace

/** Round 12: the first step of a new conversation's first answer — what was prepared, measured by the server. */
export function WorkspaceRow({ step }: { step: WorkspaceStep }) {
	const [open, setOpen] = useState(false);
	const bad = step.items.filter((i) => !i.ok);
	return (
		<FlowRow
			testId="workspace-step"
			data={{ "data-state": bad.length ? "error" : "done" }}
			icon={bad.length ? <AlertCircle className="text-warning" /> : <FolderCheck className="text-success" />}
			title="准备工作空间"
			summary={bad.length ? `${bad.map((i) => i.label).join("、")}未就绪` : undefined}
			trailing={durationText(step.ms)}
			open={open}
			expandable={step.items.length > 0}
			onToggle={() => setOpen((o) => !o)}
		>
			<ul className="space-y-0.5 text-[12.5px] text-fg-muted">
				{step.items.map((i) => (
					<li key={i.key} className="flex min-w-0 items-center gap-1.5">
						<span aria-hidden className={i.ok ? "text-success" : "text-warning"}>
							{i.ok ? "✓" : "!"}
						</span>
						<span className="shrink-0">{i.label}</span>
						{i.detail ? <span className="min-w-0 truncate text-fg-subtle">· {i.detail}</span> : null}
					</li>
				))}
			</ul>
		</FlowRow>
	);
}

// ------------------------------------------------------------------ groups

type Segment = { kind: "group"; key: string; steps: (ToolStep | ThinkStep)[] } | { kind: "single"; step: Step };

/** Adjacent process steps (thinking + tool calls) form one group; narration and the workspace step stand on their own. */
export function segmentsOf(steps: readonly Step[]): Segment[] {
	const out: Segment[] = [];
	let run: (ToolStep | ThinkStep)[] = [];
	const flush = () => {
		if (run.length >= 2) out.push({ kind: "group", key: `g-${run[0]!.key}`, steps: run });
		else for (const s of run) out.push({ kind: "single", step: s });
		run = [];
	};
	for (const s of steps) {
		if (s.kind === "tool" || s.kind === "thinking") run.push(s);
		else {
			flush();
			out.push({ kind: "single", step: s });
		}
	}
	flush();
	return out;
}

const KIND_COUNT: Partial<Record<ToolKind, (n: number) => string>> = {
	kb: (n) => `检索知识库 ${n} 次`,
	file: (n) => `处理文件 ${n} 次`,
	code: (n) => `运行代码 ${n} 次`,
	web: (n) => `访问网页 ${n} 次`,
	agent: (n) => `委派 ${n} 项任务`,
	connector: (n) => `调用连接 ${n} 次`,
	skill: (n) => `使用技能 ${n} 次`,
	memory: (n) => `保存记忆 ${n} 次`,
	job: (n) => `后台任务 ${n} 次`,
};

/** "思考，运行代码 2 次，检索知识库 1 次" — what a settled group did. */
export function groupSummary(steps: readonly (ToolStep | ThinkStep)[]): string {
	const parts: string[] = [];
	if (steps.some((s) => s.kind === "thinking")) parts.push("思考");
	const counts = new Map<ToolKind, number>();
	for (const s of steps) {
		if (s.kind !== "tool") continue;
		const k = describeTool(s.call).kind;
		counts.set(k, (counts.get(k) ?? 0) + 1);
	}
	let other = 0;
	for (const [k, n] of counts) {
		const f = KIND_COUNT[k];
		if (f) parts.push(f(n));
		else other += n;
	}
	if (other) parts.push(parts.length > (parts[0] === "思考" ? 1 : 0) ? `其他 ${other} 个步骤` : `执行 ${other} 个步骤`);
	return parts.join("，");
}

/** While running: follow the newest line of a capped body unless the reader scrolled up; edges fade when there is more above / below. */
function useFollow(active: boolean) {
	const ref = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	const [edges, setEdges] = useState({ up: false, down: false });
	const measure = () => {
		const el = ref.current;
		if (!el) return;
		const up = el.scrollTop > 1;
		const down = el.scrollTop < el.scrollHeight - el.clientHeight - 1;
		setEdges((e) => (e.up === up && e.down === down ? e : { up, down }));
	};
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || !active) return;
		const ro = new ResizeObserver(() => {
			if (follow.current) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
			measure();
		});
		ro.observe(el);
		for (const c of Array.from(el.children)) ro.observe(c);
		const mo = new MutationObserver(() => {
			for (const c of Array.from(el.children)) ro.observe(c);
		});
		mo.observe(el, { childList: true });
		return () => {
			ro.disconnect();
			mo.disconnect();
		};
	}, [active]);
	const onScroll = () => {
		const el = ref.current;
		if (!el) return;
		follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
		measure();
	};
	return { ref, edges, onScroll };
}

function GroupView({ steps, live }: { steps: (ToolStep | ThinkStep)[]; live: boolean }) {
	const [open, setOpen] = useState(true);
	const { ref, edges, onScroll } = useFollow(live && open);
	const active = live ? [...steps].reverse().find((s) => (s.kind === "thinking" ? s.streaming : ["running", "pending", "waiting"].includes(stepState(s)))) : undefined;
	const title = !live ? groupSummary(steps) : active?.kind === "thinking" ? "思考中…" : active ? `${describeTool(active.call, { subagent: active.subagent }).running}…` : "处理中…";
	const failed = steps.filter((s) => s.kind === "tool" && stepState(s) === "error" && !needsReconcile(s)).length;
	const fade = !live ? "" : edges.up && edges.down ? "wr-fade-y" : edges.up ? "wr-fade-top" : edges.down ? "wr-fade-bottom" : "";
	return (
		<div data-testid="step-group" data-open={open || undefined}>
			<FlowRow icon={<Layers />} title={title} summary={failed ? `${failed} 步失败` : undefined} tone={failed ? "danger" : undefined} running={live && !!active} trailing={live ? undefined : `${steps.length} 步`} open={open} expandable onToggle={() => setOpen((o) => !o)}>
				<div ref={ref} onScroll={onScroll} className={cn("-ml-[15px] flex flex-col border-l border-border pl-2", live && "wr-scroll max-h-[min(320px,45vh)] overflow-y-auto", fade)}>
					{steps.map((s) => (s.kind === "thinking" ? <ThinkRow key={s.key} step={s} /> : <ToolRow key={s.key} step={s} />))}
				</div>
			</FlowRow>
		</div>
	);
}

function StepView({ step }: { step: Step }) {
	if (step.kind === "thinking") return <ThinkRow step={step} />;
	if (step.kind === "workspace") return <WorkspaceRow step={step} />;
	if (step.kind === "narration") return <Markdown text={step.text} className="py-1 text-[13.5px] leading-6 text-fg-muted" />;
	return <ToolRow step={step} />;
}

// ------------------------------------------------------------------ the turn

export interface TurnSummary {
	state: "running" | "waiting" | "error" | "done" | "stopped";
	text: string;
	/** Trailing remarks that deserve a colour (failures, refusals). */
	notes: { text: string; tone: "danger" | "warning" | "muted" }[];
}

/** The one-line status of a turn. Exported for tests of the wording. */
export function summarizeTurn(turn: AssistantTurn, now = Date.now()): TurnSummary {
	const tools = turn.steps.filter((s): s is ToolStep => s.kind === "tool");
	const states = tools.map(stepState);
	const unknown = tools.filter(needsReconcile).length;
	const failed = states.filter((s) => s === "error").length - unknown;
	const stopped = states.filter((s) => s === "stopped").length;
	const rejected = states.filter((s) => s === "rejected").length;
	const notes: TurnSummary["notes"] = [];
	if (failed) notes.push({ text: `${failed} 步失败`, tone: "danger" });
	if (unknown) notes.push({ text: `${unknown} 步待核对`, tone: "warning" });
	if (rejected) notes.push({ text: `${rejected} 步被拒绝`, tone: "muted" });
	const waiting = tools.find((t) => stepState(t) === "waiting");
	if (waiting) return { state: "waiting", text: `等待你确认：${waiting.approval?.title || describeTool(waiting.call).title}`, notes: [] };
	const since = turn.requestedAt;
	if (turn.streaming) return { state: "running", text: since !== undefined ? `思考中 · ${secondsText(now - since)}` : "思考中", notes };
	const took = since !== undefined && turn.finishedAt !== undefined && turn.finishedAt >= since ? `，用时 ${secondsText(turn.finishedAt - since)}` : "";
	if (stopped && !turn.answer) {
		const verb = tools.some((t) => stepState(t) === "stopped" && /was aborted/.test(t.result?.text ?? "")) || tools.some((t) => t.approval?.status === "cancelled") ? "已停止" : "已中断";
		return { state: "stopped", text: verb, notes: [{ text: `${stopped} 步被截断`, tone: "muted" }, ...notes] };
	}
	if (stopped) notes.unshift({ text: `${stopped} 步被截断`, tone: "muted" });
	if (turn.error) return { state: "error", text: "未完成", notes };
	return { state: failed ? "error" : unknown ? "waiting" : "done", text: `已完成${took}`, notes };
}

/** Running clock under the newest content while the turn works and no row shows its own activity. */
function RunningStatus({ turn }: { turn: AssistantTurn }) {
	const now = useNow(true);
	const since = useRef(turn.requestedAt ?? Date.now());
	return (
		<div data-testid="running-status" role="status" className="flex h-7 items-center gap-1.5 text-[13px] text-fg-muted">
			<span aria-hidden className="flex size-4 items-center justify-center">
				<span className="size-1.5 rounded-full bg-info wr-pulse" />
			</span>
			<span className="wr-shimmer">思考中</span>
			<span className="text-xs tabular-nums text-fg-subtle">· {secondsText(now - since.current)}</span>
		</div>
	);
}

const NOTE_TONE = { danger: "text-danger", warning: "text-warning", muted: "text-fg-subtle" } as const;

export function StepChain({ turn }: { turn: AssistantTurn }) {
	const steps = turn.steps;
	const answered = !!(turn.answer || turn.artifacts.length);
	const sum = summarizeTurn(turn);
	// A settled, answered turn folds its whole process into one line; a turn that ended without an answer keeps it open.
	const foldable = !turn.streaming && answered && steps.length > 0 && sum.state !== "waiting";
	const [open, setOpen] = useState(!foldable);
	const was = useRef(turn.streaming);
	useEffect(() => {
		if (was.current && !turn.streaming && foldable) setOpen(false); // the turn just finished: fold it
		was.current = turn.streaming;
	}, [turn.streaming, foldable]);
	const listId = useId();
	const live = turn.streaming;
	const last = live ? steps.at(-1) : undefined;
	const rowBusy = !!last && ((last.kind === "thinking" && !!last.streaming) || (last.kind === "tool" && ["running", "pending", "waiting"].includes(stepState(last))));
	const showClock = live && !turn.answer && !rowBusy;
	if (!steps.length && !showClock) return null;
	const segs = segmentsOf(steps);
	const notes = sum.notes.map((n) => (
		<span key={n.text} className={cn("shrink-0", NOTE_TONE[n.tone])}>
			· {n.text}
		</span>
	));
	return (
		<div data-testid="step-chain" data-state={sum.state} className={cn((turn.answer || !live) && "mb-3")}>
			{foldable ? (
				<button type="button" data-testid="run-summary" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={listId} className="flex h-7 max-w-full items-center gap-1.5 text-[13px] text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info">
					<span className="truncate">{sum.text}</span>
					{notes}
					<ChevronRight aria-hidden className={cn("size-3.5 shrink-0 text-fg-subtle transition-transform duration-150", open && "rotate-90")} />
				</button>
			) : !live && steps.length ? (
				<div data-testid="run-summary" className="flex h-7 items-center gap-1.5 text-[13px] text-fg-muted">
					<span className={cn(sum.state === "error" && "text-danger")}>{sum.text}</span>
					{notes}
				</div>
			) : null}
			<AnimatePresence initial={false}>
				{open || !foldable ? (
					<m.div key="body" id={listId} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} className={cn("flex flex-col overflow-hidden", foldable && "border-l border-border pl-3")}>
						{segs.map((sg, i) => (sg.kind === "group" ? <GroupView key={sg.key} steps={sg.steps} live={live && i === segs.length - 1} /> : <StepView key={sg.step.key} step={sg.step} />))}
						{showClock ? <RunningStatus turn={turn} /> : null}
					</m.div>
				) : null}
			</AnimatePresence>
		</div>
	);
}
