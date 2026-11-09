import { ArrowDown, ChevronDown, ClipboardList, Link2, MessageSquare, Route, GitBranch, Loader2, MoreHorizontal, PanelRight, RotateCcw, Sparkles, WifiOff, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { AgentDTO, BranchResponse, ConversationDetailResponse, ConversationSummary, EntryDTO, SendMessageResponse } from "@shared/chat";
import type { ThinkingLevel } from "@shared/ops";
import { ApiError, errorText, get, patch, post, uuid } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { AssistantAvatarMark } from "@/features/assistants/Assistants";
import type { Project } from "@/lib/types";
import { cn } from "@/lib/utils";
import { TopBar } from "@/components/shell/AppShell";
import { usePanel, type WorkTab } from "@/components/shell/panel";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Tip } from "@/components/ui/overlay";
import { Button } from "@/components/ui/button";
import { ErrorState, Spinner, Unavailable } from "@/components/ui/misc";
import { DotMatrix } from "@/components/DotMatrix";
import { modelName, type ModelInfo } from "@/features/composer/models";
import { Composer, type ComposerSubmit } from "@/features/chat/Composer";
import { ApprovalCard, CitationStatusContext, ReconcileCard } from "@/features/chat/Cards";
import type { ConversationCitationStatus } from "@shared/knowledge";
import { AssistantMessage, BranchPointSwitcher, UserMessage } from "@/features/chat/Messages";
import { buildTurns, type Turn } from "@/features/chat/model";
import { RUN_LABEL, RunIcon, SUBMISSION_LABEL, reasonText } from "@/features/chat/status";
import { useConversationDetail, useConversationStream, useEarlierEntries, useSubmissionTracker } from "@/features/chat/useConversation";

const ShareDialog = lazy(() => import("@/features/share/Share").then((m) => ({ default: m.ShareDialog })));
const RoutesDialog = lazy(() => import("@/features/chat/RoutesDialog"));
const HandoffDialog = lazy(() => import("@/features/handoff/Handoff").then((m) => ({ default: m.ConversationHandoffDialog })));

const firstId = (t: Turn): number => (t.kind === "user" ? t.entry.id : t.kind === "marker" ? t.entry.id : (t.firstEntryId ?? Number.POSITIVE_INFINITY));

export function ChatPage() {
	const params = useParams();
	const spaceId = params.spaceId!;
	const id = Number(params.conversationId);
	return <ChatView key={`${spaceId}/${id}`} spaceId={spaceId} id={id} />;
}

function ChatView({ spaceId, id }: { spaceId: string; id: number }) {
	const navigate = useNavigate();
	const base = `/conversations/${spaceId}/${id}`;
	const { state, status: streamStatus, error: streamError } = useConversationStream(spaceId, id);
	const { detail, parentDetail, error: detailError, reload: reloadDetail } = useConversationDetail(spaceId, id);
	const earlier = useEarlierEntries(spaceId, id);
	const subs = useSubmissionTracker(spaceId, id);
	const { openWork, panel } = usePanel();
	const [actionErr, setActionErr] = useState<string>();
	const [stopping, setStopping] = useState(false);
	const [continuing, setContinuing] = useState(false);
	const [handoff, setHandoff] = useState(false);
	const [routes, setRoutes] = useState(false);
	const [share, setShare] = useState(false);

	const conv = state?.conversation ?? detail?.conversation;
	const [agentOverride, setAgentOverride] = useState<AgentDTO>();
	const [modelNote, setModelNote] = useState<string>();
	const pageRef = useRef<HTMLDivElement>(null);
	const agent = agentOverride ?? state?.agent ?? detail?.agent;
	const live = state?.live;
	const runStatus = live?.status ?? conv?.status ?? "idle";
	const busy = !!live?.busy;
	// Project role decides what this user may do here (the server enforces it as well).
	const projects = useApi<{ projects: Project[] }>(conv?.projectId ? "/projects" : null);
	const projectRole = conv?.projectId ? (projects.data?.projects.find((p) => p.id === conv.projectId)?.role ?? null) : undefined;
	const viewer = projectRole === "viewer";
	const readOnly = conv?.kind === "subagent" || viewer;
	// Current validity of everything this conversation cited (old answers keep their snapshot + a 失效提示).
	const citeStatus = useApi<ConversationCitationStatus>(`/kb/conversations/${spaceId}/${id}/citation-status`);
	const reloadCites = citeStatus.reload;
	useEffect(() => {
		if (runStatus !== "running") reloadCites();
	}, [runStatus, reloadCites]);

	const entries = useMemo(() => {
		const seen = new Set<string>();
		const out: EntryDTO[] = [];
		for (const e of [...earlier.earlier, ...(state?.entries ?? [])]) {
			const k = `${e.conversationId}:${e.id}`;
			if (!seen.has(k)) {
				seen.add(k);
				out.push(e);
			}
		}
		return out.sort((a, b) => a.id - b.id);
	}, [earlier.earlier, state?.entries]);
	const turns = useMemo(() => buildTurns(entries, state), [entries, state]);

	// Branch points: where this conversation diverges from its parent, and where its own branches start.
	const branchPoints = useMemo(() => {
		const pts: { entryId: number; options: ConversationSummary[] }[] = [];
		if (!conv) return pts;
		const own = detail?.branches ?? [];
		const byEntry = new Map<number, ConversationSummary[]>();
		for (const b of own) if (b.parent) byEntry.set(b.parent.entryId, [...(byEntry.get(b.parent.entryId) ?? []), b]);
		for (const [entryId, bs] of byEntry) pts.push({ entryId, options: [conv, ...bs] });
		const parent = detail?.parent ?? conv.parent;
		if (parent && parentDetail) {
			const sibs = parentDetail.branches.filter((b) => b.parent?.entryId === parent.entryId);
			const opts = [parentDetail.conversation, ...sibs];
			if (!opts.some((o) => o.conversationId === conv.conversationId)) opts.push(conv);
			pts.push({ entryId: parent.entryId, options: opts });
		}
		return pts;
	}, [conv, detail, parentDetail]);

	const allBranches = useMemo(() => {
		const m = new Map<number, ConversationSummary>();
		for (const p of branchPoints) for (const o of p.options) m.set(o.conversationId, o);
		for (const b of detail?.branches ?? []) m.set(b.conversationId, b);
		return [...m.values()];
	}, [branchPoints, detail]);

	// ----- scrolling -----
	const scroller = useRef<HTMLDivElement>(null);
	const nearBottom = useRef(true);
	const [showJump, setShowJump] = useState(false);
	const initial = useRef(true);
	const onScroll = () => {
		const el = scroller.current;
		if (!el) return;
		const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
		nearBottom.current = gap < 120;
		setShowJump(gap > 400);
	};
	const toBottom = (smooth = false) => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: smooth ? "smooth" : "auto" });
	useLayoutEffect(() => {
		if (!state) return;
		if (initial.current) {
			initial.current = false;
			toBottom();
		} else if (nearBottom.current) toBottom();
	}, [state, turns.length]);

	// ----- actions -----
	const send = async (v: ComposerSubmit) => {
		const requestId = uuid();
		const wasBusy = busy;
		const r = await post<SendMessageResponse>(`${base}/messages`, {
			text: v.text,
			requestId,
			...(v.attachments.length ? { attachments: v.attachments } : {}),
			...(v.knowledgeRefs.length ? { knowledgeRefs: v.knowledgeRefs } : {}),
			mode: v.mode,
		});
		if (wasBusy) subs.track({ requestId, text: v.text, mode: v.mode, submission: r.submission ?? { submissionId: r.submissionId, conversationId: id, status: r.status }, at: Date.now() });
		nearBottom.current = true;
		return true;
	};
	const act = async (fn: () => Promise<void>) => {
		setActionErr(undefined);
		try {
			await fn();
		} catch (e) {
			setActionErr(errorText(e));
		}
	};
	const goBranch = (c: ConversationSummary) => navigate(`/c/${c.spaceId}/${c.conversationId}`);
	const fork = (entryId: number) => act(async () => goBranch((await post<BranchResponse>(`${base}/fork`, { entryId })).conversation));
	const edit = (entryId: number, text: string) => act(async () => goBranch((await post<BranchResponse>(`${base}/edit`, { entryId, text, requestId: uuid() })).conversation));
	const regenerate = (entryId: number) => act(async () => goBranch((await post<BranchResponse>(`${base}/regenerate`, { entryId })).conversation));
	const stop = () =>
		act(async () => {
			setStopping(true);
			try {
				await post(`${base}/abort`);
			} finally {
				setStopping(false);
			}
		});
	const cont = () =>
		act(async () => {
			setContinuing(true);
			try {
				await post(`${base}/continue`);
			} finally {
				setContinuing(false);
			}
		});
	const work = useCallback((tab: WorkTab) => openWork(tab, spaceId, id), [openWork, spaceId, id]);
	/** Switch the model of this conversation. The server's answer decides what is shown: if it does not apply the change,
	 * the switcher stays on the model that is really in use and says so (the choice still becomes the default for new chats). */
	const changeModel = async (m: ModelInfo, thinking?: ThinkingLevel) => {
		setModelNote(undefined);
		try {
			await patch(base, { modelId: m.id, ...(thinking ? { thinkingLevel: thinking } : {}) });
			const d = await get<ConversationDetailResponse>(base);
			const applied = !!d.agent.model && !!m.ref && d.agent.model.provider === m.ref.provider && d.agent.model.modelId === m.ref.modelId;
			if (applied) setAgentOverride(d.agent);
			else setModelNote(`这个对话仍在使用「${d.agent.modelLabel}」：服务端目前只在创建对话时确定模型。已把「${modelName(m)}」设为新对话的默认模型。`);
		} catch (e) {
			setModelNote(errorText(e));
		}
	};

	useEffect(() => {
		if (conv?.title) document.title = conv.title;
	}, [conv?.title]);
	useEffect(() => {
		window.dispatchEvent(new Event("wr:conversations-changed"));
	}, [runStatus, conv?.title]);

	// ----- error / unavailable states -----
	if (detailError && !state) {
		if (detailError instanceof ApiError && detailError.unavailable)
			return (
				<div className="flex flex-1 flex-col">
					<TopBar />
					<Unavailable what="对话" need="A 组：GET /api/conversations/:spaceId/:id 与 SSE events" />
				</div>
			);
		return (
			<div className="flex flex-1 flex-col">
				<TopBar />
				<ErrorState error={detailError} what="对话" onRetry={reloadDetail} />
			</div>
		);
	}

	const pendingApprovals = (state?.approvals ?? []).filter((a) => a.status === "pending");
	const reconcile = (state?.effects ?? []).filter((e) => e.status === "needs_reconciliation");
	const avatar = runStatus === "running" ? "working" : runStatus === "waiting_approval" ? "waiting" : runStatus === "failed" || runStatus === "interrupted" ? "failed" : "idle";
	const lastAssistantIdx = turns.map((t) => t.kind).lastIndexOf("assistant");
	const parent = detail?.parent ?? conv?.parent;
	const panelOpen = !!panel;

	return (
		<div ref={pageRef} className="relative isolate flex min-h-0 flex-1 flex-col">
			<DotMatrix column={panelOpen ? 720 : 760} />
			<TopBar
				right={
					<>
						{allBranches.length > 1 ? (
							<Menu>
								<MenuTrigger asChild>
									<button data-testid="branch-menu" className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[13px] text-fg-muted hover:bg-surface-2 hover:text-fg">
										<GitBranch className="size-4" />
										<span className="hidden sm:inline">分支</span> {allBranches.length}
										<ChevronDown className="size-3.5" />
									</button>
								</MenuTrigger>
								<MenuContent align="end" className="w-72">
									<MenuLabel>切换分支（原对话不会被修改）</MenuLabel>
									{allBranches.map((b) => (
										<MenuItem key={b.conversationId} onSelect={() => goBranch(b)} className={cn(b.conversationId === id && "font-medium")}>
											<GitBranch />
											<span className="min-w-0 flex-1 truncate">{b.title || `对话 ${b.conversationId}`}</span>
											<span className="text-xs text-fg-subtle">{b.conversationId === id ? "当前" : b.kind === "branch" ? "分支" : "原对话"}</span>
										</MenuItem>
									))}
								</MenuContent>
							</Menu>
						) : null}
						<Menu>
							<MenuTrigger asChild>
								<button data-testid="chat-more" aria-label="更多" className="rounded-lg p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg">
									<MoreHorizontal className="size-[18px]" />
								</button>
							</MenuTrigger>
							<MenuContent align="end" className="w-60">
								<MenuItem data-testid="open-handoff" onSelect={() => setHandoff(true)}>
									<ClipboardList />
									交接摘要（决定 / 进展 / 待处理 / 成果）
								</MenuItem>
								<MenuItem data-testid="open-share" disabled={readOnly} onSelect={() => setShare(true)}>
									<Link2 />
									分享只读链接
								</MenuItem>
								<MenuItem data-testid="open-routes" onSelect={() => setRoutes(true)}>
									<Route />
									模型与路由记录
								</MenuItem>
								<MenuItem
									data-testid="make-skill"
									disabled={readOnly}
									onSelect={() =>
										act(async () => {
											const r = await post<{ draft: { id: string } }>("/skills/drafts", { spaceId, conversationId: id });
											navigate(`/capabilities?draft=${r.draft.id}`);
										})
									}
								>
									<Sparkles />
									整理为技能（预览后验证发布）
								</MenuItem>
							</MenuContent>
						</Menu>
						<Tip label="工作面板（子任务 / 终端 / 浏览器）">
							<button data-testid="open-work-panel" aria-label="工作面板" onClick={() => work("tasks")} className={cn("rounded-lg p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg", panel?.kind === "work" && "bg-surface-2 text-fg")}>
								<PanelRight className="size-[18px]" />
							</button>
						</Tip>
					</>
				}
			>
				<div className="min-w-0">
					<div className="flex min-w-0 items-center gap-2">
						<h1 data-testid="chat-title" className="truncate text-[14.5px] font-medium">
							{conv?.title || "对话"}
						</h1>
						{agent?.assistant && !agent.assistant.builtin ? (
							<span data-testid="chat-assistant" className="inline-flex shrink-0 items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11.5px] text-fg-muted" title={agent.assistant.description}>
								<AssistantAvatarMark a={agent.assistant} size={16} />
								{agent.assistant.name}
							</span>
						) : null}
						{conv?.kind === "branch" ? (
							<span data-testid="branch-badge" className="inline-flex shrink-0 items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11.5px] text-fg-muted">
								<GitBranch className="size-3" />
								分支
							</span>
						) : null}
						{conv && runStatus !== "idle" ? (
							<span data-testid="run-status" data-status={runStatus} className="hidden shrink-0 items-center gap-1 text-xs text-fg-muted sm:inline-flex">
								<RunIcon status={runStatus} />
								{RUN_LABEL[runStatus]}
							</span>
						) : null}
					</div>
					{parent && parentDetail ? (
						<Link to={`/c/${spaceId}/${parent.conversationId}`} className="block truncate text-[11.5px] text-fg-subtle hover:text-fg">
							来自：{parentDetail.conversation.title || `对话 ${parent.conversationId}`}
						</Link>
					) : null}
				</div>
			</TopBar>

			<div ref={scroller} onScroll={onScroll} className="wr-scroll relative min-h-0 flex-1 overflow-y-auto">
				<div className={cn("mx-auto w-full px-4 pb-6 pt-2 sm:px-6", panelOpen ? "max-w-[720px]" : "max-w-[var(--content-w)]")}>
					{!state ? (
						<div className="flex items-center justify-center gap-2 py-20 text-[13px] text-fg-subtle">
							<Spinner /> 正在连接…
						</div>
					) : null}
					{state && (state.hasEarlier || earlier.hasMore) && earlier.hasMore !== false ? (
						<div className="mb-4 flex justify-center">
							<Button size="sm" variant="ghost" disabled={earlier.loading} onClick={() => entries[0] && earlier.load(entries[0].id)}>
								{earlier.loading ? <Loader2 className="wr-spin" /> : null}
								加载更早的消息
							</Button>
						</div>
					) : null}
					{citeStatus.data?.stale ? (
						<div data-testid="citations-stale-banner" className="mb-4 rounded-lg bg-warning-soft px-3 py-2 text-[12.5px] text-warning">
							这个对话里有 {citeStatus.data.stale} 处引用的资料已变化（更新、删除、下架或无权访问）；旧回答保留原引用，并在对应位置标出。
						</div>
					) : null}
					<CitationStatusContext.Provider value={citeStatus.data?.byChunkId}>
					<div className="flex flex-col gap-7">
						{turns.map((t, i) => {
							const prevMax = i > 0 ? firstId(turns[i - 1]!) : Number.NEGATIVE_INFINITY;
							const here = firstId(t);
							const pts = branchPoints.filter((p) => p.entryId >= prevMax && p.entryId < here && Number.isFinite(here));
							return (
								<div key={t.key} className="flex flex-col gap-2">
									{pts.map((p) => (
										<BranchPointSwitcher key={p.entryId} options={p.options} currentId={id} onSelect={goBranch} />
									))}
									{t.kind === "user" ? (
										<UserMessage entry={t.entry} readOnly={readOnly} onFork={() => fork(t.entry.id)} onEdit={(text) => edit(t.entry.id, text)} />
									) : t.kind === "marker" ? (
										<div className="flex items-center gap-3 text-xs text-fg-subtle">
											<span className="h-px flex-1 bg-border" />
											{t.entry.kind === "compaction" ? "较早的上下文已压缩为摘要" : t.entry.kind === "notice" ? (t.entry.text ?? "系统提示") : "上下文已重置"}
											<span className="h-px flex-1 bg-border" />
										</div>
									) : (
										<AssistantMessage
											turn={t}
											readOnly={readOnly}
											avatarState={i === lastAssistantIdx ? avatar : "idle"}
											onOpenWork={work}
											onRegenerate={t.lastAssistantEntryId ? () => regenerate(t.lastAssistantEntryId!) : undefined}
											onFork={t.lastAssistantEntryId ? () => fork(t.lastAssistantEntryId!) : undefined}
										/>
									)}
								</div>
							);
						})}
					</div>
					</CitationStatusContext.Provider>
					{state && turns.length === 0 && !busy ? (
						<div data-testid="chat-empty" className="flex flex-col items-center gap-2 py-24 text-center">
							<span className="flex size-10 items-center justify-center rounded-xl bg-surface-2 text-fg-muted">
								<MessageSquare className="size-5" />
							</span>
							<p className="text-[14px] text-fg-muted">这个对话还没有消息</p>
							<p className="text-[12.5px] text-fg-subtle">在下方输入，或把文件直接拖进来。</p>
						</div>
					) : null}

					{pendingApprovals.length || reconcile.length ? (
						<div className="mt-5 flex flex-col gap-3 sm:pl-[38px]">
							{pendingApprovals.map((a) => (
								<ApprovalCard key={a.approvalId} approval={a} base={base} canDecide={!readOnly} />
							))}
							{reconcile.map((e) => (
								<ReconcileCard key={e.effectId} effect={e} base={base} />
							))}
						</div>
					) : null}
				</div>
				{showJump ? (
					<button onClick={() => toBottom(true)} aria-label="回到底部" className="sticky bottom-3 left-1/2 mx-auto flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-surface shadow-pop">
						<ArrowDown className="size-4" />
					</button>
				) : null}
			</div>

			<div className={cn("mx-auto w-full shrink-0 px-3 pb-3 sm:px-6 sm:pb-5", panelOpen ? "max-w-[720px]" : "max-w-[var(--content-w)]")}>
				<RunBar
					status={runStatus}
					live={live}
					stream={streamStatus}
					streamError={streamError?.message}
					onContinue={cont}
					continuing={continuing}
					queue={state?.queue ?? []}
				/>
				{subs.items.length ? (
					<ul data-testid="steer-feedback" className="mb-2 space-y-1">
						{subs.items.map((s) => (
							<li key={s.requestId} data-status={s.submission.status} className="flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[12.5px]">
								<span className="shrink-0 text-fg-subtle">{s.mode === "followUp" ? "稍后处理" : "插话"}</span>
								<span className="min-w-0 flex-1 truncate">{s.text}</span>
								<span className={cn("shrink-0 font-medium", s.submission.status === "unanswered" || s.submission.status === "withdrawn" ? "text-danger" : s.submission.status === "done" || s.submission.status === "applied" ? "text-success" : "text-info")}>
									{SUBMISSION_LABEL[s.submission.status]}
									{s.submission.reason ? `：${reasonText(s.submission.reason)}` : ""}
								</span>
								<button aria-label="关闭" onClick={() => subs.dismiss(s.requestId)} className="text-fg-subtle hover:text-fg">
									<X className="size-3.5" />
								</button>
							</li>
						))}
					</ul>
				) : null}
				{actionErr ? (
					<p role="alert" className="mb-2 rounded-lg bg-danger-soft px-3 py-1.5 text-[13px] text-danger">
						{actionErr}
					</p>
				) : null}
				{modelNote ? (
					<p data-testid="model-note" role="status" className="mb-2 flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-1.5 text-[12.5px] text-fg-muted">
						<span className="min-w-0 flex-1">{modelNote}</span>
						<button aria-label="关闭" onClick={() => setModelNote(undefined)} className="mt-0.5 text-fg-subtle hover:text-fg">
							<X className="size-3.5" />
						</button>
					</p>
				) : null}
				{readOnly ? (
					<p data-testid="read-only-note" className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-[13px] text-fg-muted">
						{viewer ? "你在这个项目中是查看者：可以查看对话、成果和交接摘要，但不能发消息、确认操作或创建分支。" : "这是子任务的对话记录，只读。"}
					</p>
				) : (
					<Composer
						spaceId={spaceId}
						projectId={conv?.projectId}
						busy={busy}
						onStop={stop}
						stopping={stopping}
						onSubmit={send}
						disabled={!state}
						disabledReason="正在连接…"
						conversationId={id}
						dropScope={pageRef}
						model={{ actual: agent?.model, label: agent?.modelLabel, fixture: agent?.fixture, thinking: agent?.thinkingLevel, onSelect: changeModel }}
					/>
				)}
			</div>
			{share ? (
				<Suspense fallback={null}>
					<ShareDialog open={share} onOpenChange={setShare} kind="conversation" id={String(id)} spaceId={spaceId} title={conv?.title ?? "对话"} />
				</Suspense>
			) : null}
			{routes ? (
				<Suspense fallback={null}>
					<RoutesDialog spaceId={spaceId} conversationId={id} modelLabel={agent?.modelLabel} fixture={agent?.fixture} open={routes} onOpenChange={setRoutes} />
				</Suspense>
			) : null}
			{handoff ? (
				<Suspense fallback={null}>
					<HandoffDialog spaceId={spaceId} conversationId={id} open={handoff} onOpenChange={setHandoff} />
				</Suspense>
			) : null}
		</div>
	);
}

function RunBar({
	status,
	live,
	stream,
	streamError,
	onContinue,
	continuing,
	queue,
}: {
	status: keyof typeof RUN_LABEL;
	live?: { turns?: number; retry?: { at: number; error: string }; failure?: { reason: string; detail?: string } };
	stream: string;
	streamError?: string;
	onContinue: () => void;
	continuing: boolean;
	queue: readonly { submissionId: number; mode: string; text?: string }[];
}) {
	const canContinue = status === "failed" || status === "interrupted" || status === "aborted" || status === "timeout";
	const show = status !== "idle" && status !== "done";
	return (
		<div className="mb-2 flex flex-col gap-1.5">
			{stream === "reconnecting" || stream === "offline" || streamError ? (
				<div data-testid="stream-notice" data-stream={stream} className="flex items-center gap-2 text-[12.5px] text-warning">
					<WifiOff className="size-3.5" />
					{streamError
						? `实时连接已断开：${streamError}（任务仍在服务端运行，刷新页面可重新查看）`
						: stream === "offline"
							? "网络已断开：任务仍在服务端运行，网络恢复后会自动重新连接并显示最新状态"
							: "实时连接中断，正在重连…任务不受影响"}
				</div>
			) : null}
			{show ? (
				<div data-testid="run-bar" data-status={status} className={cn("flex flex-wrap items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px]", status === "failed" || status === "interrupted" ? "bg-danger-soft text-danger" : status === "waiting_approval" || status === "timeout" ? "bg-warning-soft text-warning" : "bg-surface-2 text-fg-muted")}>
					<RunIcon status={status} />
					<span className="font-medium">{RUN_LABEL[status]}</span>
					{status === "running" && live?.turns ? <span>· 第 {live.turns} 轮</span> : null}
					{status === "running" && live?.retry ? <span>· 模型请求出错，稍后自动重试：{live.retry.error}</span> : null}
					{live?.failure && status !== "running" ? (
						<span className="min-w-0 flex-1 truncate" title={live.failure.detail}>
							· {reasonText(live.failure.reason)}
							{live.failure.detail ? `：${live.failure.detail}` : ""}
						</span>
					) : null}
					{status === "waiting_approval" ? <span>· 请在上方卡片中处理</span> : null}
					{canContinue ? (
						<button data-testid="continue" onClick={onContinue} disabled={continuing} className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-fg hover:bg-surface">
							<RotateCcw className="size-3.5" />
							继续
						</button>
					) : null}
				</div>
			) : null}
			{queue.length ? (
				<div className="text-[12.5px] text-fg-muted">
					{queue.map((q) => (
						<div key={q.submissionId} className="truncate">
							{q.mode === "steer" ? "插话" : "排队"}（已接收，等待处理）：{q.text}
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}
