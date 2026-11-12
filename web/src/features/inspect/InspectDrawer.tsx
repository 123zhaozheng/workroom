// Harness 检视 drawer: for one assistant reply, every model request of the agent loop (system prompt, tools, messages, options, usage)
// plus how the harness was composed. Read-only; the server only answers when the switch is on and the viewer holds the permission.
import { Bug, Check, Copy, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { HarnessBuildDTO, HarnessRoundDetailDTO, HarnessRoundResponse, HarnessRoundSummaryDTO, HarnessRoundsResponse, HarnessToolKind } from "@shared/harness-inspect";
import { useApi } from "@/lib/useApi";
import { qs } from "@/lib/api";
import { cn, copyText, durationText, formatBytes, fullTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState, ErrorState, Spinner } from "@/components/ui/misc";
import { DialogClose, Sheet } from "@/components/ui/overlay";
import { Collapsible, Kv, MessageItem, Pre, ToolItem } from "./parts";

export interface TurnWindow {
	/** When the message this reply answers was sent. */
	from?: number;
	/** Timestamp of the reply's last assistant message. */
	to?: number;
}

/** A round belongs to the reply when it started after the question and (if known) produced a message no later than the reply's last one. */
function inWindow(r: HarnessRoundSummaryDTO, w: TurnWindow): boolean {
	if (w.from !== undefined && r.startedAt < w.from) return false;
	if (w.to === undefined) return true;
	return r.messageTimestamp !== undefined ? r.messageTimestamp <= w.to : r.startedAt <= w.to + 3000;
}

const STOP: Record<string, { label: string; tone: "success" | "info" | "warning" | "danger" | "neutral" }> = {
	stop: { label: "回答", tone: "success" },
	toolUse: { label: "调用工具", tone: "info" },
	length: { label: "长度截断", tone: "warning" },
	error: { label: "出错", tone: "danger" },
	aborted: { label: "已中止", tone: "warning" },
};
const stopBadge = (s?: string) => {
	if (!s) return <Badge>进行中</Badge>;
	const x = STOP[s] ?? { label: s, tone: "neutral" as const };
	return <Badge tone={x.tone}>{x.label}</Badge>;
};
const KIND: Record<HarnessToolKind, string> = { builtin: "内置", mcp: "MCP 连接", skill: "技能", kernel: "内核", fixture: "测试", other: "其他" };

function RoundNavItem({ r, active, onClick }: { r: HarnessRoundSummaryDTO; active: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			data-testid="inspect-round"
			aria-current={active ? "true" : undefined}
			onClick={onClick}
			className={cn("flex w-full min-w-40 flex-col gap-1 rounded-lg px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-w-0", active ? "bg-surface-2" : "hover:bg-surface-2")}
		>
			<span className="flex items-center gap-2">
				<span className="font-medium">第 {r.roundIndex} 轮</span>
				{stopBadge(r.stopReason)}
			</span>
			<span className="truncate font-mono text-xs text-fg-muted">{r.servedBy ?? `${r.model.provider}/${r.model.modelId}`}</span>
			<span className="flex flex-wrap gap-x-2 text-xs text-fg-subtle">
				<span>{fullTime(r.startedAt).slice(-8)}</span>
				{r.usage ? <span>{r.usage.totalTokens.toLocaleString()} tokens</span> : null}
				{r.durationMs !== undefined ? <span>{durationText(r.durationMs)}</span> : null}
			</span>
		</button>
	);
}

function BuildView({ builds }: { builds: readonly HarnessBuildDTO[] }) {
	if (!builds.length) return <EmptyState title="没有 Harness 构建记录">只记录开启开关之后的运行；构建信息在每次运行的第一轮请求时保存。</EmptyState>;
	return (
		<div data-testid="inspect-build" className="space-y-4">
			{builds.map((b, i) => (
				<div key={b.id} className="space-y-3">
					{builds.length > 1 ? <div className="text-sm font-medium">第 {i + 1} 次运行 · {fullTime(b.createdAt)}</div> : null}
					<Collapsible defaultOpen title="模型与运行参数">
						<Kv
							rows={[
								["模型", b.model ? `${b.model.label ?? b.model.modelId}（${b.model.provider}/${b.model.modelId}）` : undefined],
								["思考强度", b.thinkingLevel],
								["最多轮数", b.maxTurns?.toString()],
								["工作目录", b.cwd ? <span className="font-mono">{b.cwd}</span> : undefined],
								["助手", b.assistant?.name ?? b.assistant?.id],
							]}
						/>
					</Collapsible>
					<Collapsible defaultOpen title="系统提示词组成" count={b.promptSections.length} hint="按渲染顺序">
						{b.promptSections.length ? (
							<ol className="m-0 list-none space-y-1 p-0 text-sm">
								{b.promptSections.map((s) => (
									<li key={s.key} className="flex items-center gap-2">
										<span className="font-mono text-[13px]">{s.key}</span>
										<span className="text-xs text-fg-subtle">来自 {s.source}</span>
									</li>
								))}
							</ol>
						) : (
							<span className="text-sm text-fg-subtle">没有扩展片段</span>
						)}
						{b.instructions ? (
							<div className="mt-3">
								<div className="mb-1 text-xs font-medium text-fg-subtle">助手指令</div>
								<Pre text={b.instructions} mono={false} />
							</div>
						) : null}
					</Collapsible>
					<Collapsible defaultOpen title="工具" count={b.tools.length} hint={b.deferredTools.length ? `另有 ${b.deferredTools.length} 个按需加载` : undefined}>
						<div className="space-y-3">
							{b.extensions
								.filter((e) => e.tools.length)
								.map((e) => (
									<div key={e.name}>
										<div className="mb-1 flex items-center gap-2 text-sm">
											<span className="font-medium">{e.name}</span>
											<Badge>{KIND[e.kind]}</Badge>
										</div>
										<div className="flex flex-wrap gap-1.5">
											{e.tools.map((t) => {
												const meta = b.tools.find((x) => x.name === t);
												return (
													<span key={t} title={meta?.offered === false ? "仅供其他工具调用，不直接提供给模型" : undefined} className={cn("rounded-md bg-surface-2 px-2 py-0.5 font-mono text-xs", meta?.offered === false && "text-fg-subtle")}>
														{t}
													</span>
												);
											})}
										</div>
									</div>
								))}
							{b.deferredTools.length ? <div className="text-xs text-fg-subtle">按需加载：{b.deferredTools.join("、")}</div> : null}
						</div>
					</Collapsible>
					<Collapsible defaultOpen title="执行环境">
						{b.environment ? <Kv rows={[["环境", b.environment.label], ["状态", b.environment.usable ? "可用" : "不可用"], ["说明", b.environment.detail]]} /> : <span className="text-sm text-fg-subtle">未记录</span>}
					</Collapsible>
				</div>
			))}
		</div>
	);
}

function RoundView({ r, build }: { r: HarnessRoundDetailDTO; build?: HarnessBuildDTO }) {
	const [copied, setCopied] = useState(false);
	const u = r.usage;
	return (
		<div data-testid="inspect-round-detail" className="space-y-3">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
				<h3 className="m-0 text-base font-semibold">第 {r.roundIndex} 轮</h3>
				{stopBadge(r.stopReason)}
				{r.truncated ? <Badge tone="warning" title="记录过大，部分文本已被截断">已截断</Badge> : null}
				<span className="text-xs text-fg-subtle">{fullTime(r.startedAt)}</span>
				<Button
					size="sm"
					variant="secondary"
					className="ml-auto"
					data-testid="inspect-copy-json"
					aria-label="复制 JSON"
					onClick={async () => {
						setCopied(await copyText(JSON.stringify(r, null, 2)));
						setTimeout(() => setCopied(false), 1400);
					}}
				>
					{copied ? <Check aria-hidden /> : <Copy aria-hidden />}
					{copied ? "已复制" : "复制 JSON"}
				</Button>
			</div>
			{r.error ? (
				<p role="alert" className="m-0 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
					{r.error}
				</p>
			) : null}

			<Collapsible defaultOpen title="系统提示词" hint={`${r.systemChars.toLocaleString()} 字符`} testId="inspect-system">
				{r.systemSections.length ? (
					<div className="mb-3 flex flex-wrap gap-1.5">
						{r.systemSections.map((s) => (
							<span key={s.key} className="rounded-md bg-surface-2 px-2 py-0.5 text-xs text-fg-muted" title={`${s.chars.toLocaleString()} 字符`}>
								{s.key}
							</span>
						))}
					</div>
				) : null}
				<Pre text={r.systemPrompt} />
			</Collapsible>
			<Collapsible title="工具" count={r.tools.length} testId="inspect-tools">
				{r.tools.length ? (
					<div className="space-y-2">
						{r.tools.map((t) => (
							<ToolItem key={t.name} tool={t} />
						))}
					</div>
				) : (
					<span className="text-sm text-fg-subtle">这一轮没有提供工具</span>
				)}
			</Collapsible>
			<Collapsible defaultOpen title="消息" count={r.messages.length} hint="按发送顺序" testId="inspect-messages">
				{r.messages.length ? (
					<ol className="m-0 list-none space-y-2 p-0">
						{r.messages.map((m, i) => (
							<MessageItem key={i} m={m} index={i} />
						))}
					</ol>
				) : (
					<span className="text-sm text-fg-subtle">没有消息</span>
				)}
			</Collapsible>
			<Collapsible title="请求参数与用量" testId="inspect-options">
				<div className="space-y-4">
					<Kv
						rows={[
							["模型", `${r.model.provider}/${r.model.modelId}`],
							["实际应答", r.servedBy],
							["思考强度", r.thinkingLevel ?? build?.thinkingLevel],
							["接口类型", r.modelInfo?.api],
							["上下文窗口", r.modelInfo?.contextWindow?.toLocaleString()],
							["最大输出", r.modelInfo?.maxTokens?.toLocaleString()],
							["耗时", r.durationMs !== undefined ? durationText(r.durationMs) : undefined],
							["记录大小", formatBytes(r.sizeBytes)],
						]}
					/>
					{Object.keys(r.options).length ? (
						<div>
							<div className="mb-1 text-xs font-medium text-fg-subtle">请求选项</div>
							<Pre text={JSON.stringify(r.options, null, 2)} />
						</div>
					) : null}
					{u ? (
						<Kv
							rows={[
								["输入", u.input.toLocaleString()],
								["输出", u.output.toLocaleString()],
								["缓存读 / 写", `${u.cacheRead.toLocaleString()} / ${u.cacheWrite.toLocaleString()}`],
								["推理", u.reasoning?.toLocaleString()],
								["合计", `${u.totalTokens.toLocaleString()} tokens`],
								["费用", u.costTotal ? `$${u.costTotal.toFixed(4)}` : undefined],
							]}
						/>
					) : null}
				</div>
			</Collapsible>
		</div>
	);
}

export function InspectDrawer({ open, onOpenChange, spaceId, conversationId, window: w }: { open: boolean; onOpenChange: (o: boolean) => void; spaceId: string; conversationId: string; window: TurnWindow }) {
	const base = `/conversations/${encodeURIComponent(spaceId)}/${encodeURIComponent(conversationId)}/harness/rounds`;
	const list = useApi<HarnessRoundsResponse>(open ? `${base}${qs({ from: w.from, limit: 500 })}` : null);
	const rounds = useMemo(() => (list.data?.rounds ?? []).filter((r) => inWindow(r, w)), [list.data, w.from, w.to]);
	const builds = useMemo(() => {
		const runs = new Set(rounds.map((r) => r.runId));
		return (list.data?.builds ?? []).filter((b) => runs.has(b.runId));
	}, [list.data, rounds]);
	const [sel, setSel] = useState<string>();
	const selected = sel ?? rounds.at(-1)?.id ?? (builds.length ? "build" : undefined);
	const isRound = !!selected && selected !== "build" && rounds.some((r) => r.id === selected);
	const detail = useApi<HarnessRoundResponse>(open && isRound ? `${base}/${encodeURIComponent(selected!)}` : null);
	const disabled = list.data?.enabled === false;

	let body;
	if (list.loading) body = <div className="flex items-center gap-2 py-10 text-sm text-fg-subtle"><Spinner /> 加载中…</div>;
	else if (list.error) body = <ErrorState error={list.error} onRetry={list.reload} what="请求记录" />;
	else if (disabled) body = <EmptyState icon={<Bug />} title="Harness 检视未开启">请管理员在「组织管理 → Harness 检视」中开启。</EmptyState>;
	else if (!rounds.length) body = <EmptyState icon={<Bug />} title="没有这条回复的请求记录">只记录开启开关之后产生的回复；较早的记录可能已被清理。</EmptyState>;
	else if (selected === "build") body = <BuildView builds={builds} />;
	else if (detail.loading || (!detail.data && !detail.error)) body = <div className="flex items-center gap-2 py-10 text-sm text-fg-subtle"><Spinner /> 加载中…</div>;
	else if (detail.error) body = <ErrorState error={detail.error} onRetry={detail.reload} what="这一轮的请求" />;
	else body = <RoundView r={detail.data!.round} build={builds.find((b) => b.runId === detail.data!.round.runId)} />;

	return (
		<Sheet open={open} onOpenChange={onOpenChange} title="Harness 检视" className="sm:max-w-[min(1120px,96vw)]">
			<div data-testid="harness-inspect-drawer" className="flex min-h-0 flex-1 flex-col">
				<header className="flex items-center gap-3 border-b border-border px-5 py-3">
					<Bug aria-hidden className="size-[18px] text-fg-muted" />
					<h2 className="m-0 text-base font-semibold">Harness 检视</h2>
					{rounds.length ? <span className="text-xs text-fg-subtle">这条回复共 {rounds.length} 轮模型请求</span> : null}
					<DialogClose aria-label="关闭" className="-mr-1 ml-auto flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-subtle hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
						<X aria-hidden className="size-4" />
					</DialogClose>
				</header>
				<div className="flex min-h-0 flex-1 flex-col md:flex-row">
					{rounds.length ? (
						<nav aria-label="请求轮次" data-testid="inspect-rounds" className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-2 md:w-64 md:flex-col md:overflow-y-auto md:overflow-x-hidden md:border-b-0 md:border-r">
							<button
								type="button"
								data-testid="inspect-build-tab"
								aria-current={selected === "build" ? "true" : undefined}
								onClick={() => setSel("build")}
								className={cn("flex min-w-28 shrink-0 items-center rounded-lg px-3 py-2 text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-w-0", selected === "build" ? "bg-surface-2" : "hover:bg-surface-2")}
							>
								Harness 构建
							</button>
							<div className="mx-1 hidden h-px shrink-0 bg-border md:block" aria-hidden />
							{rounds.map((r) => (
								<RoundNavItem key={r.id} r={r} active={selected === r.id} onClick={() => setSel(r.id)} />
							))}
						</nav>
					) : null}
					<div className="wr-scroll min-h-0 min-w-0 flex-1 overflow-y-auto p-5">{body}</div>
				</div>
			</div>
		</Sheet>
	);
}
