import { BookOpen, Check, ChevronLeft, ChevronRight, Copy, Download, FileText, FlaskConical, GitBranch, Pencil, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { FIXTURE_LABEL, type ConversationSummary, type UserEntryDTO } from "@shared/chat";
import { copyText, cn, downloadText, isSimulatedUsage, SIMULATED_USAGE } from "@/lib/utils";
import { reasonText, SUBMISSION_LABEL } from "./status";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Tip } from "@/components/ui/overlay";
import { AssistantAvatar } from "@/components/shell/BrandMark";
import type { WorkTab } from "@/components/shell/panel";
import { Markdown } from "@/features/markdown/Markdown";
import { Citations, ErrorNote, FileCard } from "./Cards";
import { turnMarkdown, type AssistantTurn } from "./model";
import { StepChain } from "./Steps";
import { JobChip } from "@/features/work/live";

function ActionButton({ label, onClick, children, testId }: { label: string; onClick: () => void; children: ReactNode; testId?: string }) {
	return (
		<Tip label={label}>
			<button data-testid={testId} aria-label={label} onClick={onClick} className="rounded-md p-1.5 text-fg-subtle hover:bg-surface-2 hover:text-fg [&_svg]:size-[15px]">
				{children}
			</button>
		</Tip>
	);
}

function CopyAction({ text }: { text: string }) {
	const [ok, setOk] = useState(false);
	return (
		<ActionButton
			label={ok ? "已复制" : "复制"}
			testId="action-copy"
			onClick={async () => {
				setOk(await copyText(text));
				setTimeout(() => setOk(false), 1400);
			}}
		>
			{ok ? <Check /> : <Copy />}
		</ActionButton>
	);
}

export function UserMessage({ entry, onEdit, onFork, readOnly }: { entry: UserEntryDTO; onEdit: (text: string) => Promise<void>; onFork: () => void; readOnly?: boolean }) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(entry.text);
	const [busy, setBusy] = useState(false);
	const via = entry.via?.kind === "subagent_report" ? "子任务回报" : entry.via?.kind === "automation" ? "自动化触发" : entry.via?.kind === "delegate" ? "委派" : null;
	return (
		<div data-testid="user-message" data-entry-id={entry.id} className="group flex flex-col items-end">
			{editing ? (
				<div className="w-full max-w-[85%]">
					<Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(8, Math.max(2, draft.split("\n").length))} autoFocus className="text-[15px]" />
					<div className="mt-1.5 flex items-center justify-end gap-2">
						<span className="mr-auto text-xs text-fg-subtle">保存后在新分支中重新回答，原对话保留不变。</span>
						<Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
							取消
						</Button>
						<Button
							size="sm"
							variant="primary"
							disabled={busy || !draft.trim()}
							data-testid="edit-save"
							onClick={async () => {
								setBusy(true);
								try {
									await onEdit(draft.trim());
									setEditing(false);
								} finally {
									setBusy(false);
								}
							}}
						>
							保存为新分支
						</Button>
					</div>
				</div>
			) : (
				<>
					{entry.attachments?.length || entry.knowledgeRefs?.length ? (
						<div className="mb-1.5 flex max-w-[85%] flex-wrap justify-end gap-1.5">
							{entry.attachments?.map((a) => (
								<span key={a.versionId} className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-surface px-1.5 text-xs text-fg-muted">
									<FileText className="size-3" />
									{a.name}
								</span>
							))}
							{entry.knowledgeRefs?.map((k) => (
								<span key={k.kbId + (k.docId ?? "")} className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-surface px-1.5 text-xs text-fg-muted">
									<BookOpen className="size-3" />
									{k.name}
								</span>
							))}
						</div>
					) : null}
					<div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-surface-3 px-4 py-2.5 text-[15px] leading-relaxed">{entry.text}</div>
					<MessageOutcome entry={entry} />
					<div className="mt-1 flex h-7 items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
						{via ? <span className="mr-1 text-xs text-fg-subtle">{via}</span> : null}
						{entry.authorName ? <span className="mr-1 text-xs text-fg-subtle">{entry.authorName}</span> : null}
						<CopyAction text={entry.text} />
						{!readOnly ? (
							<>
								<ActionButton label="编辑（新分支）" testId="action-edit" onClick={() => setEditing(true)}>
									<Pencil />
								</ActionButton>
								<ActionButton label="从这里分叉" testId="action-fork" onClick={onFork}>
									<GitBranch />
								</ActionButton>
							</>
						) : null}
					</div>
				</>
			)}
		</div>
	);
}

/** Outcome of this exact message (M02-C), re-read from the server on every load; only shown when it is not simply answered. */
function MessageOutcome({ entry }: { entry: UserEntryDTO }) {
	const sub = entry.submission;
	if (entry.placed === false)
		return (
			<p data-testid="message-outcome" data-status={sub?.status ?? "withdrawn"} className="mt-1 text-xs text-danger">
				未送达模型：{sub ? `${SUBMISSION_LABEL[sub.status]}${sub.reason ? `（${reasonText(sub.reason)}）` : ""}` : "已撤回"}
			</p>
		);
	if (!sub || sub.status === "done" || sub.status === "applied") return null;
	const bad = sub.status === "unanswered" || sub.status === "withdrawn";
	return (
		<p data-testid="message-outcome" data-status={sub.status} className={cn("mt-1 text-xs", bad ? "text-danger" : "text-info")}>
			{bad ? "这条消息没有得到回复：" : ""}
			{SUBMISSION_LABEL[sub.status]}
			{sub.reason ? `（${reasonText(sub.reason)}）` : ""}
		</p>
	);
}

export function AssistantMessage({
	turn,
	children,
	onRegenerate,
	onFork,
	onOpenWork,
	readOnly,
	avatarState,
}: {
	turn: AssistantTurn;
	children?: ReactNode;
	onRegenerate?: () => void;
	onFork?: () => void;
	onOpenWork?: (tab: WorkTab) => void;
	readOnly?: boolean;
	avatarState: "idle" | "working" | "waiting" | "failed";
}) {
	const md = turnMarkdown(turn);
	return (
		<div data-testid="assistant-message" data-entry-id={turn.lastAssistantEntryId} className="group flex gap-3">
			<div className="hidden pt-0.5 sm:block">
				<AssistantAvatar state={avatarState} label={turn.modelLabel} />
			</div>
			<div className="min-w-0 flex-1">
				{turn.fixture ? (
					<div className="mb-1.5 inline-flex items-center gap-1 rounded-md bg-warning-soft px-1.5 py-0.5 text-[11.5px] text-warning" data-testid="fixture-badge">
						<FlaskConical className="size-3" />
						{FIXTURE_LABEL}
					</div>
				) : null}
				<StepChain turn={turn} onOpenWork={onOpenWork} />
				{turn.answer ? <Markdown text={turn.answer} streaming={turn.streaming} /> : turn.streaming && !turn.steps.length ? <TypingDots /> : null}
				{turn.artifacts.length ? (
					<div className="mt-3 flex flex-col gap-2">
						{turn.artifacts.map((a) => (
							<FileCard key={a.versionId} file={a} />
						))}
					</div>
				) : null}
				{turn.jobs.length ? (
					<div className="mt-3 flex flex-col items-start gap-1.5">
						{turn.jobs.map((j) => (
							<JobChip key={j.id} jobId={j.id} initial={j} />
						))}
					</div>
				) : null}
				<Citations citations={turn.citations} />
				{turn.error ? <ErrorNote text={`模型出错：${turn.error}`} /> : null}
				{children}
				{!turn.streaming && (turn.answer || turn.artifacts.length) ? (
					<div className="mt-1.5 flex h-7 items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
						<CopyAction text={md} />
						<ActionButton label="导出 Markdown" testId="action-export" onClick={() => downloadText(`回答-${turn.lastAssistantEntryId ?? "x"}.md`, md)}>
							<Download />
						</ActionButton>
						{!readOnly && onRegenerate ? (
							<ActionButton label="重新生成（新分支）" testId="action-regenerate" onClick={onRegenerate}>
								<RefreshCw />
							</ActionButton>
						) : null}
						{!readOnly && onFork ? (
							<ActionButton label="从这里分叉" testId="action-fork-assistant" onClick={onFork}>
								<GitBranch />
							</ActionButton>
						) : null}
						{turn.usage ? (
							<span data-testid="turn-usage" className="ml-1 text-[11.5px] text-fg-subtle" title="本轮用量">
								{isSimulatedUsage(turn.usage, turn.fixture) ? SIMULATED_USAGE : `${turn.usage.totalTokens.toLocaleString()} tokens`}
							</span>
						) : null}
					</div>
				) : null}
			</div>
		</div>
	);
}

function TypingDots() {
	return (
		<div className="flex h-6 items-center gap-1" aria-label="正在生成">
			{[0, 1, 2].map((i) => (
				<span key={i} className="size-1.5 rounded-full bg-fg-subtle wr-pulse" style={{ animationDelay: `${i * 0.18}s` }} />
			))}
		</div>
	);
}

/** "‹ 2 / 3 ›" switcher shown where conversations diverge (edit / regenerate / fork). */
export function BranchPointSwitcher({ options, currentId, onSelect }: { options: ConversationSummary[]; currentId: number; onSelect: (c: ConversationSummary) => void }) {
	const idx = options.findIndex((o) => o.conversationId === currentId);
	if (options.length < 2 || idx < 0) return null;
	const go = (d: number) => onSelect(options[(idx + d + options.length) % options.length]!);
	return (
		<div data-testid="branch-switcher" className="flex items-center justify-center gap-1 py-1 text-xs text-fg-subtle">
			<GitBranch className="size-3.5" />
			<button aria-label="上一个分支" onClick={() => go(-1)} className="rounded p-0.5 hover:bg-surface-2 hover:text-fg">
				<ChevronLeft className="size-3.5" />
			</button>
			<span className={cn("tabular-nums")}>
				{idx + 1} / {options.length}
			</span>
			<button aria-label="下一个分支" onClick={() => go(1)} className="rounded p-0.5 hover:bg-surface-2 hover:text-fg">
				<ChevronRight className="size-3.5" />
			</button>
			<span className="max-w-[200px] truncate">{options[idx]!.title}</span>
		</div>
	);
}
