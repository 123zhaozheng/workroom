// The compact queue above the composer: messages sent while the assistant works. They are held durably on the server
// (pi-durable follow-ups) and sent in order after the current task — this component only shows server state.
// Each item: 立即发送 (hand it to the running task at its next step) and 撤销 (take it back into the input box); both are
// revealed on hover, keyboard focus, and by tapping the row (touch). Wording never claims more than the server confirmed.
import { Ban, ChevronDown, ListEnd, Loader2, Paperclip, Send, Trash2, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { QueuedInputDTO, RunStatus } from "@shared/chat";
import { cn } from "@/lib/utils";
import { cleanTestText } from "@/features/chat/testText";

export interface QueueNotice {
	tone: "info" | "warn" | "error";
	text: string;
}

interface Props {
	items: readonly QueuedInputDTO[];
	runStatus: RunStatus;
	/** Each action answers with what the server really did; the notice is shown as-is. */
	onSendNow: (item: QueuedInputDTO) => Promise<QueueNotice | void>;
	onUndo: (item: QueuedInputDTO) => Promise<QueueNotice | void>;
	onDelete: (item: QueuedInputDTO) => Promise<QueueNotice | void>;
	/** Can this person change the queue (viewers cannot). */
	readOnly?: boolean;
}

const STALLED: RunStatus[] = ["failed", "interrupted", "timeout", "aborted"];

export function queueTitle(status: RunStatus, n: number): { title: string; stalled: boolean } {
	return STALLED.includes(status) ? { title: `${n} 条消息未发出`, stalled: true } : { title: `排队 ${n} 条`, stalled: false };
}

export function MessageQueue({ items, runStatus, onSendNow, onUndo, onDelete, readOnly }: Props) {
	const [open, setOpen] = useState<number>();
	const [pending, setPending] = useState<Set<number>>(new Set());
	const [notice, setNotice] = useState<QueueNotice>();
	const [expanded, setExpanded] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	// an open row whose item left the queue (sent, withdrawn in another tab) closes
	useEffect(() => {
		if (open !== undefined && !items.some((i) => i.submissionId === open)) setOpen(undefined);
	}, [items, open]);

	if (!items.length && !notice) return null;
	const { title, stalled } = queueTitle(runStatus, items.length);

	const run = async (item: QueuedInputDTO, fn: (i: QueuedInputDTO) => Promise<QueueNotice | void>) => {
		if (pending.has(item.submissionId)) return;
		setPending((s) => new Set(s).add(item.submissionId));
		let n: QueueNotice | void;
		try {
			n = await fn(item);
		} catch (e) {
			n = { tone: "error", text: (e as Error)?.message || "操作失败" };
		} finally {
			setPending((s) => {
				const next = new Set(s);
				next.delete(item.submissionId);
				return next;
			});
		}
		setOpen(undefined);
		clearTimeout(timer.current);
		if (n) {
			setNotice(n);
			timer.current = setTimeout(() => setNotice(undefined), n.tone === "error" ? 12000 : 7000);
		}
	};

	const LIMIT = 3;
	const shown = expanded ? items : items.slice(0, LIMIT);

	return (
		<section data-testid="message-queue" data-status={runStatus} data-count={items.length} aria-label="排队中的消息" className="mb-2 overflow-hidden rounded-xl border border-border bg-surface-2/70 text-[13px]">
			{items.length ? (
				<header className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1.5 text-[12.5px] text-fg-muted">
					<ListEnd aria-hidden className="size-3.5 shrink-0" />
					<span data-testid="queue-title" className={cn("font-medium", stalled ? "text-warning" : "text-fg")}>
						{title}
					</span>
				</header>
			) : null}
			{items.length ? (
				<ol className="wr-scroll max-h-[188px] divide-y divide-border overflow-y-auto border-t border-border">
					{shown.map((q, idx) => {
						const isOpen = open === q.submissionId;
						const busy = pending.has(q.submissionId);
						const steer = q.mode === "steer";
						const text = q.displayText ?? cleanTestText(q.text);
						return (
							<li key={q.submissionId} data-testid="queue-item" data-submission-id={q.submissionId} data-mode={q.mode} data-open={isOpen ? "true" : undefined} className="group relative flex flex-wrap items-center gap-x-2 px-3 py-1 focus-within:bg-surface hover:bg-surface">
								<button
									type="button"
									data-testid="queue-row"
									aria-expanded={isOpen}
									aria-label={`第 ${idx + 1} 条：${text || "（测试指令）"}，展开操作`}
									onClick={() => setOpen(isOpen ? undefined : q.submissionId)}
									className="flex min-h-8 min-w-0 flex-1 basis-40 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									<span aria-hidden className="w-4 shrink-0 text-right text-[12px] tabular-nums text-fg-subtle">
										{idx + 1}
									</span>
									<span data-testid="queue-text" className="min-w-0 flex-1 truncate text-fg">
										{text || "（测试指令）"}
									</span>
									{q.attachments?.length ? (
										<span data-testid="queue-attachments" className="inline-flex max-w-[40%] shrink-0 items-center gap-1 rounded-md bg-surface-3 px-1.5 py-0.5 text-[12px] text-fg-muted" title={q.attachments.map((a) => a.name).join("、")}>
											<Paperclip aria-hidden className="size-3 shrink-0" />
											<span className="truncate">{q.attachments.length === 1 ? q.attachments[0]!.name : `${q.attachments.length} 个文件`}</span>
										</span>
									) : null}
									{steer ? (
										<span data-testid="queue-steered" className="shrink-0 rounded-md bg-info-soft px-1.5 py-0.5 text-[12px] text-info">
											已交给任务
										</span>
									) : null}
									<ChevronDown aria-hidden className={cn("size-3.5 shrink-0 text-fg-subtle transition-transform sm:hidden", isOpen && "rotate-180")} />
								</button>
								{!readOnly ? (
									<div
										data-testid="queue-actions"
										className={cn(
											"items-center gap-1",
											// phones: in the row's flow, only after a tap. Larger screens: always laid out (so Tab can reach them and nothing shifts), faded in on hover / focus / open.
											isOpen ? "flex max-sm:w-full max-sm:basis-full max-sm:pb-1" : "max-sm:hidden",
											"sm:absolute sm:right-2 sm:top-1/2 sm:flex sm:-translate-y-1/2 sm:rounded-md sm:bg-surface sm:pl-1 sm:transition-opacity",
											isOpen ? "sm:opacity-100" : "sm:pointer-events-none sm:opacity-0 sm:group-focus-within:pointer-events-auto sm:group-focus-within:opacity-100 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100",
										)}
									>
										{!steer ? (
											<button
												type="button"
												data-testid="queue-send-now"
												disabled={busy}
												onClick={() => void run(q, onSendNow)}
												className="inline-flex h-7 items-center gap-1 rounded-md border border-border-strong bg-surface px-2 text-[12.5px] font-medium text-fg hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 max-sm:h-9 max-sm:flex-1 max-sm:justify-center"
											>
												{busy ? <Loader2 aria-hidden className="size-3.5 wr-spin" /> : <Send aria-hidden className="size-3.5" />}
												立即发送
											</button>
										) : null}
										<button
											type="button"
											data-testid="queue-undo"
											disabled={busy}
											onClick={() => void run(q, onUndo)}
											className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] font-medium text-fg-muted hover:bg-surface-3 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 max-sm:h-9 max-sm:flex-1 max-sm:justify-center max-sm:border max-sm:border-border"
										>
											<Undo2 aria-hidden className="size-3.5" />
											撤销
										</button>
										{stalled ? (
											<button
												type="button"
												data-testid="queue-delete"
												disabled={busy}
												onClick={() => void run(q, onDelete)}
												className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] font-medium text-danger hover:bg-danger-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 max-sm:h-9 max-sm:flex-1 max-sm:justify-center max-sm:border max-sm:border-border"
											>
												<Trash2 aria-hidden className="size-3.5" />
												删除
											</button>
										) : null}
									</div>
								) : null}
							</li>
						);
					})}
				</ol>
			) : null}
			{items.length > LIMIT ? (
				<button type="button" data-testid="queue-more" onClick={() => setExpanded((x) => !x)} className="w-full border-t border-border px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
					{expanded ? "收起" : `还有 ${items.length - LIMIT} 条`}
				</button>
			) : null}
			{notice ? (
				<p data-testid="queue-notice" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"} className={cn("flex items-start gap-1.5 px-3 py-1.5 text-[12.5px]", items.length && "border-t border-border", notice.tone === "error" ? "text-danger" : notice.tone === "warn" ? "text-warning" : "text-fg-muted")}>
					{notice.tone === "error" ? <Ban aria-hidden className="mt-0.5 size-3.5 shrink-0" /> : null}
					<span className="min-w-0 flex-1">{notice.text}</span>
				</p>
			) : null}
		</section>
	);
}
