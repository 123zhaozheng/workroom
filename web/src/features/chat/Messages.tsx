import { BookOpen, Check, ChevronLeft, ChevronRight, Copy, Download, FlaskConical, GitBranch, Pencil, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { FIXTURE_LABEL, type ConversationSummary, type UserEntryDTO } from "@shared/chat";
import { cn, copyText, downloadText, isSimulatedUsage, SIMULATED_USAGE } from "@/lib/utils";
import { reasonText, SUBMISSION_LABEL } from "./status";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Tip } from "@/components/ui/overlay";
import { AssistantAvatar } from "@/components/shell/BrandMark";
import { Markdown } from "@/features/markdown/Markdown";
import { Citations, ErrorNote, FileCard } from "./Cards";
import { CredentialOutcome, credentialSteps } from "./CredentialRequestCard";
import { RefTile } from "@/components/file/FileTile";
import { MessageAttachment } from "./Attachments";
import { turnMarkdown, type AssistantTurn, type UserRun } from "./model";
import { cleanErrorText, userTextOf } from "./testText";
import { StepChain } from "./Steps";
import { JobChip } from "@/features/work/live";
import { InspectButton } from "@/features/inspect";

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

export function UserMessage({ entry, run, onEdit, onFork, onRestore, readOnly }: { entry: UserEntryDTO; run?: UserRun; onEdit: (text: string) => Promise<void>; onFork: () => void; onRestore?: () => void; readOnly?: boolean }) {
	const [editing, setEditing] = useState(false);
	// Show what the person wrote; test-model directives are not message content (a small 测试 badge says they were there).
	const shown = userTextOf(entry);
	const [draft, setDraft] = useState(entry.text);
	const [busy, setBusy] = useState(false);
	const via = entry.via?.kind === "subagent_report" ? "子任务回报" : entry.via?.kind === "automation" ? "自动化触发" : entry.via?.kind === "delegate" ? "委派" : entry.via?.kind === "approval_resume" ? "审批结果" : null;
	return (
		<div data-testid="user-message" data-entry-id={entry.id} className="group flex flex-col items-end">
			{editing ? (
				<div className="w-full max-w-[85%]">
					<Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(8, Math.max(2, draft.split("\n").length))} autoFocus className="text-[15px]" />
					<div className="mt-1.5 flex items-center justify-end gap-2">
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
						<div data-testid="message-attachments" className="mb-2 flex max-w-[92%] flex-wrap justify-end gap-2">
							{entry.attachments?.map((a) => (
								<MessageAttachment key={a.versionId} a={a} />
							))}
							{entry.knowledgeRefs?.map((k) => (
								<RefTile key={k.kbId + (k.docId ?? "")} testId="message-kb" icon={<BookOpen />} label="知识库" name={k.name} />
							))}
						</div>
					) : null}
					<div data-testid="user-bubble" className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-surface-3 px-4 py-2.5 text-[15px] leading-relaxed">
						{shown.text ? shown.text : <span className="text-fg-muted">（测试指令）</span>}
					</div>
					{shown.test ? (
						<span data-testid="test-badge" title="这条消息带有测试指令，已从正文中隐藏" className="mt-1 inline-flex h-[18px] items-center gap-1 rounded bg-surface-2 px-1.5 text-xs font-medium text-fg-muted">
							<FlaskConical aria-hidden className="size-3" />
							测试
						</span>
					) : null}
					<MessageOutcome entry={entry} run={run} onRestore={readOnly ? undefined : onRestore} />
					<div className="mt-1 flex h-7 items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
						{via ? <span className="mr-1 text-xs text-fg-subtle">{via}</span> : null}
						{entry.authorName ? <span className="mr-1 text-xs text-fg-subtle">{entry.authorName}</span> : null}
						<CopyAction text={shown.text} />
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

/**
 * Outcome of this exact message (M02-C), re-read from the server on every load; only shown when it is not simply answered.
 * Three honest cases, never mixed up:
 *  - never placed (placed === false): 「未送达」 — the model has not seen it; it can go back into the composer.
 *  - placed, then the run was stopped / ended early: the message IS in the conversation and the model sees it on 继续. Not an error.
 *  - placed and failed: the message arrived, the run did not finish.
 */
function MessageOutcome({ entry, run, onRestore }: { entry: UserEntryDTO; run?: UserRun; onRestore?: () => void }) {
	const sub = entry.submission;
	// Only what the person must act on: a message that never reached the model, or a failure not already shown in the answer.
	// A stop (or a stop later continued) needs no note: the message and completed steps simply stay in the conversation.
	if (entry.placed === false)
		return (
			<p data-testid="message-outcome" data-kind="unsent" data-status={sub?.status ?? "withdrawn"} className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-danger">
				<span>未送达</span>
				{onRestore ? (
					<button data-testid="unsent-restore" onClick={onRestore} className="rounded px-1 font-medium text-info hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-info">
						放回输入框
					</button>
				) : null}
			</p>
		);
	if (!sub || sub.status !== "unanswered" || sub.reason === "aborted" || run?.answered || run?.errorShown) return null;
	return (
		<p data-testid="message-outcome" data-kind="incomplete" data-status={sub.status} className="mt-1 text-xs text-danger">
			未完成：{reasonText(sub.reason) || SUBMISSION_LABEL[sub.status]}
		</p>
	);
}

export function AssistantMessage({
	turn,
	children,
	onRegenerate,
	onFork,
	readOnly,
	avatarState,
	wide,
}: {
	turn: AssistantTurn;
	children?: ReactNode;
	onRegenerate?: () => void;
	onFork?: () => void;
	readOnly?: boolean;
	avatarState: "idle" | "working" | "waiting" | "failed";
	/** 加宽模式: no avatar and no avatar-sized gutter; status rows and text share one left edge. */
	wide?: boolean;
}) {
	const md = turnMarkdown(turn);
	return (
		<div data-testid="assistant-message" data-entry-id={turn.lastAssistantEntryId} className={cn("group flex", !wide && "gap-3")}>
			{wide ? null : (
				<div data-testid="assistant-avatar" className="hidden pt-0.5 sm:block">
					<AssistantAvatar state={avatarState} label={turn.modelLabel} />
				</div>
			)}
			<div className="min-w-0 flex-1">
				{turn.fixture ? (
					<div className="mb-1.5 inline-flex items-center gap-1 rounded-md bg-warning-soft px-1.5 py-0.5 text-xs text-warning" data-testid="fixture-badge">
						<FlaskConical className="size-3" />
						{FIXTURE_LABEL}
					</div>
				) : null}
				<StepChain turn={turn} />
				{credentialSteps(turn).map((s) => (
					<CredentialOutcome key={s.key} step={s} />
				))}
				{turn.answer ? <Markdown text={turn.answer} streaming={turn.streaming} /> : null}
				{turn.artifacts.length ? (
					<div className="mt-3 flex flex-col gap-2">
						{turn.artifacts.map((a) => (
							<FileCard key={a.fileId} card={a} />
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
				{turn.error ? <ErrorNote text="模型调用出错，这一轮没有完成。" detail={cleanErrorText(turn.error) || turn.error} /> : null}
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
						<InspectButton turn={turn} />
						{turn.usage ? (
							<span data-testid="turn-usage" className="ml-1 text-xs text-fg-subtle" title="本轮用量">
								{isSimulatedUsage(turn.usage, turn.fixture) ? SIMULATED_USAGE : `${turn.usage.totalTokens.toLocaleString()} tokens`}
							</span>
						) : null}
					</div>
				) : !turn.streaming && turn.error ? (
					<InspectButton turn={turn} standalone />
				) : null}
			</div>
		</div>
	);
}


/** "‹ 2 / 3 ›" switcher shown where conversations diverge (edit / regenerate / fork). */
export function BranchPointSwitcher({ options, currentId, onSelect }: { options: ConversationSummary[]; currentId: number; onSelect: (c: ConversationSummary) => void }) {
	const idx = options.findIndex((o) => o.conversationId === currentId);
	if (options.length < 2 || idx < 0) return null;
	const go = (d: number) => onSelect(options[(idx + d + options.length) % options.length]!);
	return (
		<div data-testid="branch-switcher" role="group" aria-label="切换回答分支" className="flex items-center justify-center gap-1 py-1 text-xs text-fg-muted">
			<GitBranch aria-hidden className="size-3.5" />
			<button aria-label="上一个分支" onClick={() => go(-1)} className="rounded p-1 hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-info">
				<ChevronLeft aria-hidden className="size-3.5" />
			</button>
			<span className="tabular-nums" aria-live="polite" aria-label={`第 ${idx + 1} 个，共 ${options.length} 个分支`}>
				{idx + 1} / {options.length}
			</span>
			<button aria-label="下一个分支" onClick={() => go(1)} className="rounded p-1 hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-info">
				<ChevronRight aria-hidden className="size-3.5" />
			</button>
			<span className="max-w-[200px] truncate text-fg-subtle">{options[idx]!.title}</span>
		</div>
	);
}
