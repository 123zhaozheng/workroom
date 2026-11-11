import { ArrowDown, ChevronDown, ClipboardList, Link2, MessageSquare, Route, GitBranch, Loader2, MoreHorizontal, PanelRight, RotateCcw, Sparkles, TriangleAlert, WifiOff, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import type { AbortResponse, AgentDTO, AttachmentRef, BranchResponse, ConversationDetailResponse, ConversationSummary, EntryDTO, KnowledgeRef, PromoteResponse, QueuedInputDTO, SendMessageResponse, UserEntryDTO, WithdrawResponse } from "@shared/chat";
import type { ThinkingLevel } from "@shared/ops";
import { ApiError, errorText, get, patch, post, uuid } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { AssistantAvatarMark } from "@/features/assistants/Assistants";
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
import { PendingCredentialRequests } from "@/features/chat/CredentialRequestCard";
import { SkillDraftResult, skillDraftOf } from "@/features/chat/SkillDraftCard";
import type { ConversationCitationStatus } from "@shared/knowledge";
import { AssistantMessage, BranchPointSwitcher, UserMessage } from "@/features/chat/Messages";
import { buildTurns, type AssistantTurn, type Turn, type UserRun } from "@/features/chat/model";
import { RUN_LABEL, RunIcon, reasonText } from "@/features/chat/status";
import { cleanErrorText, userTextOf } from "@/features/chat/testText";
import { PositionRail, railItemOf, type RailItem } from "@/features/chat/PositionRail";
import { normalizeProject } from "@/features/projects/model";
import { usePrefs } from "@/lib/prefs";
import { MessageQueue, type QueueNotice } from "@/features/composer/MessageQueue";
import { EnvironmentButton } from "@/features/environment/EnvironmentButton";
import { EnvironmentStatus } from "@/features/environment/EnvironmentStatus";
import { failedSandboxTexts } from "@/features/chat/Steps";
import { useConversationDetail, useConversationStream, useEarlierEntries } from "@/features/chat/useConversation";

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
	const { openWork, panel } = usePanel();
	const [actionErr, setActionErr] = useState<string>();
	const [staleOpen, setStaleOpen] = useState(false);
	const [stopping, setStopping] = useState(false);
	const [continuing, setContinuing] = useState(false);
	const [restore, setRestore] = useState<{ n: number; text: string; attachments?: readonly AttachmentRef[]; knowledgeRefs?: readonly KnowledgeRef[] }>();
	/** What 停止 did with messages still waiting in the queue (they go back to the composer, never vanish). */
	const [stopNote, setStopNote] = useState<string>();
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
	const projects = useApi<{ projects: unknown[] }>(conv?.projectId ? "/projects" : null);
	const project = conv?.projectId ? projects.data?.projects.map(normalizeProject).find((p) => p.id === conv.projectId) : undefined;
	// Legacy project viewers and people who see a container project through a share can read, not write.
	const sharedRead = project?.access === "shared_read";
	const viewer = project?.role === "viewer" || sharedRead;
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
	const { motionReduced } = usePrefs();
	// One rail tick per question. Short strings only, so the rail re-renders when a question or an answer's first words change — not per streamed token.
	const railItems = useMemo<RailItem[]>(() => {
		const out: RailItem[] = [];
		for (let i = 0; i < turns.length; i++) {
			const t = turns[i]!;
			if (t.kind !== "user") continue;
			const next = turns[i + 1];
			out.push({ id: t.entry.id, ...railItemOf(userTextOf(t.entry).text || "（测试指令）", next?.kind === "assistant" ? next.answer : undefined) });
		}
		return out;
	}, [turns]);

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

	// ----- deep link: ?entry=<entry id> (from search) scrolls to that message and highlights it for a moment -----
	const [sp] = useSearchParams();
	const entryParam = Number(sp.get("entry")) || undefined;
	const [hitKey, setHitKey] = useState<string>();
	const handledEntry = useRef<number | undefined>(undefined);
	const hitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const firstLoaded = entries[0]?.id;
	const loadEarlier = earlier.load;
	useEffect(() => {
		if (!entryParam || !state || handledEntry.current === entryParam || turns.length === 0) return;
		// the message may sit before the loaded window: load earlier pages until it is in (or there is nothing earlier)
		if (firstLoaded !== undefined && entryParam < firstLoaded && (state.hasEarlier || earlier.hasMore) && earlier.hasMore !== false) {
			if (!earlier.loading) void loadEarlier(firstLoaded);
			return;
		}
		let idx = 0;
		for (let i = 0; i < turns.length; i++) if (firstId(turns[i]!) <= entryParam) idx = i;
		const t = turns[idx]!;
		const el = scroller.current?.querySelector<HTMLElement>(`[data-turn-key="${t.key}"]`);
		if (!el) return;
		handledEntry.current = entryParam;
		nearBottom.current = false;
		el.scrollIntoView({ block: "center", behavior: "auto" });
		setHitKey(t.key);
		clearTimeout(hitTimer.current);
		hitTimer.current = setTimeout(() => setHitKey(undefined), 2600);
	}, [entryParam, state, turns, firstLoaded, earlier.hasMore, earlier.loading, loadEarlier]);
	useEffect(() => () => clearTimeout(hitTimer.current), []);

	// ----- actions -----
	// The composer sends with a requestId that stays the same for a retry of the same content (the server dedupes on it).
	// While a run works the message is queued on the server (follow-up) — what the queue shows is the server's state.
	const send = async (v: ComposerSubmit) => {
		await post<SendMessageResponse>(`${base}/messages`, {
			text: v.text,
			requestId: v.requestId,
			...(v.attachments.length ? { attachments: v.attachments } : {}),
			...(v.knowledgeRefs.length ? { knowledgeRefs: v.knowledgeRefs } : {}),
			mode: v.mode,
		});
		nearBottom.current = true;
		return true;
	};
	const queueItems = useMemo(() => (state?.queue ?? []).filter((q) => q.mode !== "write"), [state?.queue]);
	/** 立即发送: the server answers what really happened; the notice says exactly that. */
	const queueSendNow = async (item: QueuedInputDTO): Promise<QueueNotice> => {
		const r = await post<PromoteResponse>(`${base}/submissions/${item.submissionId}/promote`);
		if (r.result === "promoted") {
			if (r.effect === "started") return { tone: "info", text: "已发送，开始新一轮处理。" };
			return { tone: "info", text: runStatus === "waiting_approval" ? "已交给当前任务：它正在等你确认，确认之后才会处理这条消息。" : "已交给正在运行的任务，会在它的下一步处理（不会打断正在执行的工具）。" };
		}
		if (r.result === "already_applied") return { tone: "warn", text: "这条消息刚刚已经被处理了，不需要再发送。" };
		return { tone: "warn", text: "这条消息已不在队列里（可能已在另一个窗口撤销或处理）。" };
	};
	/** 撤销: only when the server confirms the withdraw does the content come back to the box; if it was applied first, nothing is restored. */
	const queueUndo = async (item: QueuedInputDTO): Promise<QueueNotice> => {
		const r = await post<WithdrawResponse>(`${base}/submissions/${item.submissionId}/withdraw`, { restore: true });
		if (r.result === "aborted" && r.input) {
			setRestore((x) => ({ n: (x?.n ?? 0) + 1, text: r.input!.text, attachments: r.input!.attachments, knowledgeRefs: r.input!.knowledgeRefs }));
			return { tone: "info", text: "已撤销，内容和附件已放回输入框。" };
		}
		return { tone: "warn", text: "这条消息已经被处理，无法撤销，也没有放回输入框。" };
	};
	const queueDelete = async (item: QueuedInputDTO): Promise<QueueNotice> => {
		const r = await post<WithdrawResponse>(`${base}/submissions/${item.submissionId}/withdraw`, { restore: true });
		return r.result === "aborted" ? { tone: "info", text: "已删除这条排队的消息。" } : { tone: "warn", text: "这条消息已经被处理，无法删除。" };
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
			setStopNote(undefined);
			try {
				const r = await post<AbortResponse>(`${base}/abort`);
				// pi-durable withdraws what was still queued when a run is stopped: those messages come back into the box (and stay marked 未送达 in the conversation).
				if (r?.unsent?.length) {
					setRestore((x) => ({ n: (x?.n ?? 0) + 1, text: r.unsent.map((u) => u.text).join("\n\n"), attachments: r.unsent.flatMap((u) => u.attachments ?? []), knowledgeRefs: r.unsent.flatMap((u) => u.knowledgeRefs ?? []) }));
					setStopNote(`已停止。停止时还有 ${r.unsent.length} 条排队的消息没有发出，内容已放回输入框；你已经发出的那条消息和已完成的步骤都保留着。`);
				}
			} finally {
				setStopping(false);
			}
		});
	/** 放回输入框 on a 未送达 message: its text and attachments go back into the composer; nothing is sent. */
	const restoreUnsent = (e: UserEntryDTO) => setRestore((x) => ({ n: (x?.n ?? 0) + 1, text: e.text, attachments: e.attachments, knowledgeRefs: e.knowledgeRefs }));
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
	// A decided skill draft stays visible as a one-line result (已保存 / 未保存).
	const decidedDrafts = (state?.approvals ?? []).filter((a) => a.status !== "pending" && skillDraftOf(a.detail));
	const reconcile = (state?.effects ?? []).filter((e) => e.status === "needs_reconciliation");
	const avatar = runStatus === "running" ? "working" : runStatus === "waiting_approval" ? "waiting" : runStatus === "failed" || runStatus === "interrupted" ? "failed" : "idle";
	const assistantTurns = turns.filter((t): t is AssistantTurn => t.kind === "assistant");
	const lastAssistantIdx = turns.map((t) => t.kind).lastIndexOf("assistant");
	/** The latest message that was actually placed (not a 未送达 marker) and what its run did: feeds 「已停止（已完成 N 步）」. */
	const lastUserRun = [...turns].reverse().find((t): t is Extract<Turn, { kind: "user" }> => t.kind === "user" && t.entry.placed !== false && !!t.run)?.run;
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

			<div className="relative flex min-h-0 flex-1 flex-col">
			<div ref={scroller} onScroll={onScroll} data-testid="chat-scroll" className="wr-scroll relative min-h-0 flex-1 overflow-y-auto">
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
						<div data-testid="citations-stale-banner" className="mb-3 text-[12.5px] text-warning">
							<div className="flex items-center gap-1.5">
								<TriangleAlert aria-hidden className="size-3.5 shrink-0" />
								<span className="min-w-0">有 {citeStatus.data.stale} 处引用的资料已变化</span>
								<button type="button" aria-expanded={staleOpen} onClick={() => setStaleOpen((v) => !v)} className="rounded px-1 text-xs text-fg-muted underline underline-offset-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info">
									{staleOpen ? "收起" : "详情"}
								</button>
							</div>
							{staleOpen ? <p className="mt-0.5 pl-5 text-fg-muted">更新、删除、下架或无权访问的资料都算；旧回答保留原引用，并在对应位置标出。</p> : null}
						</div>
					) : null}
					<CitationStatusContext.Provider value={citeStatus.data?.byChunkId}>
					<div className="flex flex-col gap-7">
						{turns.map((t, i) => {
							const prevMax = i > 0 ? firstId(turns[i - 1]!) : Number.NEGATIVE_INFINITY;
							const here = firstId(t);
							const pts = branchPoints.filter((p) => p.entryId >= prevMax && p.entryId < here && Number.isFinite(here));
							return (
								<div key={t.key} data-turn-key={t.key} data-turn-kind={t.kind} data-hit={hitKey === t.key || undefined} className={cn("flex flex-col gap-2 rounded-xl transition-[background-color,box-shadow] duration-700", hitKey === t.key && "bg-info-soft shadow-[0_0_0_8px_var(--info-soft)]")}>
									{pts.map((p) => (
										<BranchPointSwitcher key={p.entryId} options={p.options} currentId={id} onSelect={goBranch} />
									))}
									{t.kind === "user" ? (
										<UserMessage entry={t.entry} run={t.run} readOnly={readOnly} onFork={() => fork(t.entry.id)} onEdit={(text) => edit(t.entry.id, text)} onRestore={() => restoreUnsent(t.entry)} />
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

					<div className="mt-5 flex flex-col gap-3 empty:hidden sm:pl-[38px]">
						<PendingCredentialRequests spaceId={spaceId} conversationId={id} turns={assistantTurns} readOnly={readOnly} />
					</div>
					{pendingApprovals.length || reconcile.length || decidedDrafts.length ? (
						<div className="mt-5 flex flex-col gap-3 sm:pl-[38px]">
							{decidedDrafts.map((a) => (
								<SkillDraftResult key={a.approvalId} approval={a} d={skillDraftOf(a.detail)!} />
							))}
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
			<PositionRail items={railItems} scroller={scroller} reduced={motionReduced} />
			</div>

			<div className={cn("mx-auto w-full shrink-0 px-3 pb-3 sm:px-6 sm:pb-5", panelOpen ? "max-w-[720px]" : "max-w-[var(--content-w)]")}>
				<RunBar status={runStatus} live={live} stream={streamStatus} streamError={streamError?.message} onContinue={cont} continuing={continuing} inlineError={!!assistantTurns.at(-1)?.error} run={lastUserRun} stopNote={stopNote} onDismissNote={() => setStopNote(undefined)} />
				{spaceId && id !== undefined ? <EnvironmentStatus spaceId={spaceId} conversationId={id} active={runStatus === "running"} className="mb-2" explainedBy={failedSandboxTexts(assistantTurns.at(-1))} /> : null}
				<MessageQueue items={queueItems} runStatus={runStatus} onSendNow={queueSendNow} onUndo={queueUndo} onDelete={queueDelete} readOnly={readOnly} />
				{actionErr ? (
					<p role="alert" className="mb-2 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-1.5 text-[13px] text-danger">
						<span className="min-w-0 flex-1 break-words">{actionErr}</span>
						<button aria-label="关闭" onClick={() => setActionErr(undefined)} className="mt-0.5 shrink-0 text-danger/70 hover:text-danger">
							<X className="size-3.5" />
						</button>
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
						{sharedRead ? `这是${project?.ownerName ?? "同事"}分享给你的项目，只读：可以查看对话和成果，不能发送消息或确认操作。` : viewer ? "你在这个项目中是查看者：可以查看对话、成果和交接摘要，但不能发消息、确认操作或创建分支。" : "这是子任务的对话记录，只读。"}
					</p>
				) : (
					<Composer
						spaceId={spaceId}
						projectId={conv?.projectId}
						busy={busy}
						onStop={stop}
						stopping={stopping}
						onSubmit={send}
						restore={restore}
						tools={spaceId ? <EnvironmentButton spaceId={spaceId} conversationId={id} active={runStatus === "running"} /> : undefined}
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

/**
 * Connection notice + the way out of a run that did not finish (失败 / 已取消 / 超时 / 已中断: 重试 or 继续, technical details).
 * Nothing is shown while the assistant is running or waiting for you: approvals are cards in the conversation, work is in the work panel,
 * and 停止 lives in the composer.
 */
function RunBar({
	status,
	live,
	stream,
	streamError,
	onContinue,
	continuing,
	inlineError,
	run,
	stopNote,
	onDismissNote,
}: {
	status: keyof typeof RUN_LABEL;
	live?: { turns?: number; retry?: { at: number; error: string }; failure?: { reason: string; detail?: string } };
	stream: string;
	streamError?: string;
	onContinue: () => void;
	continuing: boolean;
	/** The latest answer already shows this failure inline (with its 技术详情): the bar then carries only the status and the way out. */
	inlineError?: boolean;
	run?: UserRun;
	stopNote?: string;
	onDismissNote: () => void;
}) {
	const canContinue = status === "failed" || status === "interrupted" || status === "aborted" || status === "timeout";
	const show = canContinue;
	const bad = status === "failed" || status === "interrupted";
	const detail = cleanErrorText(live?.failure?.detail);
	const steps = run ? (run.doneSteps ? `已完成 ${run.doneSteps} 步` : "还没有完成的步骤") : "";
	const [hint, setHint] = useState(false);
	const reason = inlineError && bad ? "" : live?.failure ? reasonText(live.failure.reason) : "";
	return (
		<div className="mb-2 flex flex-col gap-1.5 empty:hidden">
			{stopNote ? (
				<p data-testid="stop-note" role="status" className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-1.5 text-[12.5px] text-fg-muted">
					<span className="min-w-0 flex-1">{stopNote}</span>
					<button aria-label="关闭" onClick={onDismissNote} className="mt-0.5 text-fg-subtle hover:text-fg">
						<X className="size-3.5" />
					</button>
				</p>
			) : null}
			{stream === "reconnecting" || stream === "offline" || streamError ? (
				<div data-testid="stream-notice" data-stream={stream} role="status" className="flex items-center gap-2 text-[12.5px] text-warning">
					<WifiOff aria-hidden className="size-3.5" />
					{streamError
						? `实时连接已断开：${streamError}（任务仍在服务端运行，刷新页面可重新查看）`
						: stream === "offline"
							? "网络已断开：任务仍在服务端运行，网络恢复后会自动重新连接并显示最新状态"
							: "实时连接中断，正在重连…任务不受影响"}
				</div>
			) : null}
			{show ? (
				<div data-testid="run-bar" data-status={status} role="status" className={cn("rounded-lg px-2.5 py-1.5 text-[12.5px]", bad ? "bg-danger-soft text-danger" : status === "timeout" ? "bg-warning-soft text-warning" : "bg-surface-2 text-fg-muted")}>
					<div className="flex flex-wrap items-center gap-2">
						<RunIcon status={status} />
						<span className="font-medium">{RUN_LABEL[status]}</span>
						{status === "aborted" ? <span data-testid="run-bar-steps" className="min-w-0 flex-1">{steps ? `· ${steps}` : ""}</span> : reason ? <span className="min-w-0 flex-1">· {reason}{steps ? `（${steps}）` : ""}</span> : <span className="min-w-0 flex-1">{steps ? `· ${steps}` : ""}</span>}
						<button type="button" data-testid="run-bar-hint-toggle" aria-expanded={hint} onClick={() => setHint((v) => !v)} className="rounded px-1 text-xs text-fg-muted underline underline-offset-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info">
							{hint ? "收起说明" : "说明"}
						</button>
						<button data-testid="continue" onClick={onContinue} disabled={continuing} title={status === "aborted" ? "接着已有的内容继续：你的消息和已完成的步骤都在上下文里" : "重新请求模型，接着已有的内容继续"} className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-fg hover:bg-surface focus-visible:ring-2 focus-visible:ring-info disabled:opacity-60">
							{continuing ? <Loader2 aria-hidden className="size-3.5 wr-spin" /> : <RotateCcw aria-hidden className="size-3.5" />}
							{status === "aborted" ? "继续" : "重试"}
						</button>
					</div>
					<p data-testid="run-bar-hint" hidden={!hint} className="mt-1 text-[12px] text-fg-subtle">
						你的消息和已完成的步骤都保留在对话里，没有丢失。{status === "aborted" ? "继续" : "重试"}会让模型接着这些内容往下做，不会重做已完成的步骤；被截断的那一步不会自动重做，是否再做一次由模型根据对话判断。
					</p>
					{live?.failure && detail && !(inlineError && bad) ? (
						<details data-testid="tech-details" className="mt-1 text-[12px]">
							<summary className="cursor-pointer text-fg-muted hover:text-fg">技术详情</summary>
							<p className="mt-0.5 break-all font-mono text-fg-muted">{detail}</p>
						</details>
					) : null}
				</div>
			) : null}
		</div>
	);
}
