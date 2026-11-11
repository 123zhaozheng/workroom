// Tool ranking (bars + error share), knowledge hit rates, large-context failures, automation / files summary and the
// drilldown tables. HTML/CSS marks: crisp text, keyboard focus and real links.
import { ExternalLink, Lock } from "lucide-react";
import { Link } from "react-router";
import type { StatsOverviewDTO } from "@shared/ops";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { fmtCompact, fmtInt, fmtMs, fmtPct } from "./format";
import { Card, Empty, TipRow, useTip } from "./parts";

// ------------------------------------------------------------------------------------------------ tools
export function ToolRanking({ data, csv }: { data: StatsOverviewDTO; csv: string }) {
	const { box, show, hide, el } = useTip();
	const max = Math.max(1, ...data.tools.map((t) => t.calls));
	return (
		<Card testid="chart-tools" title="工具使用排行" csv={csv}>
			{data.tools.length === 0 ? (
				<Empty>此范围内没有工具调用记录。</Empty>
			) : (
				<div ref={box} className="relative">
					<ol className="space-y-2" data-testid="tool-list">
						{data.tools.map((t, i) => (
							<li key={t.tool} data-testid="tool-row" className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm sm:grid-cols-[minmax(0,11rem)_1fr_auto]">
								<span className="truncate" title={t.tool}>
									<span className="mr-1.5 inline-block w-4 text-right text-xs tabular-nums text-fg-subtle">{i + 1}</span>
									{t.tool}
								</span>
								<div
									role="img"
									aria-label={`${t.tool}：${t.calls} 次调用，${t.errors} 次出错，错误率 ${fmtPct(t.errorRate)}`}
									className="flex h-4 items-center"
									onPointerMove={(e) =>
										show(
											e,
											<div>
												<div className="mb-0.5 font-medium">{t.tool}</div>
												<TipRow color="var(--c1)" label="调用" value={fmtInt(t.calls)} />
												<TipRow color="var(--st-failed)" label="出错" value={fmtInt(t.errors)} />
												<TipRow label="错误率" value={fmtPct(t.errorRate)} />
												<TipRow label="平均耗时" value={fmtMs(t.avgDurationMs)} />
											</div>,
										)
									}
									onPointerLeave={hide}
								>
									<div className="flex h-3 gap-[2px]" style={{ width: `${Math.max(2, (t.calls / max) * 100)}%` }}>
										<span className="h-full rounded-l-[4px] bg-[var(--c1)]" style={{ flex: t.calls - t.errors, minWidth: t.calls - t.errors > 0 ? 3 : 0, borderRadius: t.errors === 0 ? 4 : undefined }} />
										{t.errors > 0 ? <span className="h-full rounded-r-[4px] bg-[var(--st-failed)]" style={{ flex: t.errors, minWidth: 3, borderRadius: t.calls === t.errors ? 4 : undefined }} /> : null}
									</div>
								</div>
								<span className="flex items-center justify-end gap-2 tabular-nums">
									<span className="font-medium">{fmtInt(t.calls)}</span>
									<span className={cn("w-12 rounded px-1 text-right text-xs", t.errors ? "bg-danger-soft text-danger" : "text-fg-subtle")}>{fmtPct(t.errorRate, 0)}</span>
								</span>
							</li>
						))}
					</ol>
					{el}
				</div>
			)}
		</Card>
	);
}

// ------------------------------------------------------------------------------------------------ knowledge
export function KnowledgeCard({ data, csv }: { data: StatsOverviewDTO; csv: string }) {
	const k = data.knowledge;
	const parts = [
		{ key: "hit", label: "有命中", n: k.withHits, color: "var(--c3)" },
		{ key: "noev", label: "无证据", n: k.noEvidence, color: "var(--c4)" },
		{ key: "other", label: "其他空结果", n: k.otherEmpty, color: "var(--c-other)" },
	];
	return (
		<Card testid="chart-knowledge" title="知识检索命中" csv={csv}>
			{k.searches === 0 ? (
				<Empty height={120}>此范围内没有知识检索记录。</Empty>
			) : (
				<>
					<div className="flex items-end justify-between gap-3">
						<div>
							<div className="text-[26px] font-semibold leading-8 tabular-nums" data-testid="kb-hit-rate">
								{fmtPct(k.hitRate)}
							</div>
							<div className="text-xs text-fg-subtle">命中率 · 共 {fmtInt(k.searches)} 次检索</div>
						</div>
						<div className="text-right text-xs text-fg-muted">
							<div>
								无证据率 <span className="font-medium text-fg tabular-nums">{fmtPct(k.noEvidenceRate)}</span>
							</div>
							<div>平均耗时 {fmtMs(k.avgLatencyMs)}</div>
						</div>
					</div>
					<div role="img" aria-label={parts.map((p) => `${p.label} ${p.n}`).join("，")} className="mt-3 flex h-3 gap-[2px] overflow-hidden rounded">
						{parts.map((p) => (p.n ? <span key={p.key} title={`${p.label} ${p.n}`} style={{ flex: p.n, background: p.color }} className="min-w-[3px] first:rounded-l last:rounded-r" /> : null))}
					</div>
					<ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
						{parts.map((p) => (
							<li key={p.key} className="inline-flex items-center gap-1.5">
								<span aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: p.color }} />
								{p.label} <span className="tabular-nums text-fg">{fmtInt(p.n)}</span>
							</li>
						))}
					</ul>
				</>
			)}
		</Card>
	);
}

export function LargeContextCard({ data }: { data: StatsOverviewDTO }) {
	const lc = data.largeContext;
	return (
		<Card testid="chart-large-context" title="大上下文失败集中度">
			{lc.requests === 0 ? (
				<Empty height={120}>此范围内没有达到 {fmtCompact(lc.thresholdTokens)} Token 的请求。</Empty>
			) : (
				<>
					<div className="flex items-baseline gap-2">
						<span className="text-[26px] font-semibold leading-8 tabular-nums">{fmtPct(lc.failureRate)}</span>
						<span className="text-xs text-fg-subtle">
							失败率 · {fmtInt(lc.failed)} / {fmtInt(lc.requests)} 次
						</span>
					</div>
					<ul className="mt-3 space-y-1.5 text-xs" data-testid="lc-rows">
						{[...lc.byModel.slice(0, 4).map((r) => ({ ...r, g: "模型" })), ...lc.byStage.map((r) => ({ ...r, g: "阶段" }))].map((r) => (
							<li key={`${r.g}-${r.key}`} className="grid grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-2">
								<span className="text-fg-subtle">{r.g}</span>
								<span className="truncate" title={r.key}>
									{r.key === "first_turn" ? "首轮" : r.key === "after_tools" ? "工具之后" : r.key === "automation" ? "自动化" : r.key}
								</span>
								<span className="tabular-nums text-fg-muted">
									{fmtInt(r.failed)}/{fmtInt(r.requests)} · <span className={r.failed ? "text-danger" : ""}>{fmtPct(r.failureRate, 0)}</span>
								</span>
							</li>
						))}
					</ul>
				</>
			)}
		</Card>
	);
}

export function ActivityCard({ data }: { data: StatsOverviewDTO }) {
	const AUTO: Record<string, string> = { succeeded: "成功", failed: "失败", cancelled: "已取消", timeout: "超时", skipped: "已跳过", refused: "被拒绝", running: "运行中", pending: "排队中" };
	const ORIGIN: Record<string, string> = { agent: "智能体产出", automation: "自动化产出" };
	return (
		<Card testid="chart-activity" title="自动化与产出文件">
			{data.automation.total === 0 && data.files.versions === 0 ? (
				<Empty height={120}>此范围内没有自动化运行，也没有产出文件。</Empty>
			) : (
				<div className="grid gap-4 text-sm">
					<div>
						<div className="mb-1 flex justify-between text-fg-muted">
							<span>自动化运行</span>
							<span className="font-medium tabular-nums text-fg">{fmtInt(data.automation.total)}</span>
						</div>
						{Object.entries(data.automation.byStatus).map(([k, n]) => (
							<div key={k} className="flex justify-between text-xs text-fg-muted">
								<span>{AUTO[k] ?? k}</span>
								<span className="tabular-nums">{fmtInt(n)}</span>
							</div>
						))}
					</div>
					<div>
						<div className="mb-1 flex justify-between text-fg-muted">
							<span>产出文件（版本）</span>
							<span className="font-medium tabular-nums text-fg">{fmtInt(data.files.versions)}</span>
						</div>
						{Object.entries(data.files.byOrigin).map(([k, n]) => (
							<div key={k} className="flex justify-between text-xs text-fg-muted">
								<span>{ORIGIN[k] ?? k}</span>
								<span className="tabular-nums">{fmtInt(n)}</span>
							</div>
						))}
					</div>
				</div>
			)}
		</Card>
	);
}

// ------------------------------------------------------------------------------------------------ tables
const th = "px-3 py-2 text-left font-medium text-fg-subtle whitespace-nowrap";
const thR = "px-3 py-2 text-right font-medium text-fg-subtle whitespace-nowrap";
const td = "px-3 py-2";
const tdR = "px-3 py-2 text-right tabular-nums";

function Sim({ show }: { show: boolean }) {
	return show ? <span className="ml-1 rounded bg-surface-3 px-1 text-xs text-fg-muted">模拟</span> : null;
}
const when = (iso: string) => new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

export function DrilldownTables({ data, csv }: { data: StatsOverviewDTO; csv: (chart: string) => string }) {
	const orgLike = data.scope !== "personal";
	const title = (t: string | null, link: string | null, demo = data.demo) =>
		link ? (
			<Link to={link} className="inline-flex items-center gap-1 text-info hover:underline" data-testid="drill-link">
				{t}
				<ExternalLink className="size-3" aria-hidden />
			</Link>
		) : t ? (
			<span className="text-fg-muted" title={demo ? "演示数据：没有可打开的对话" : undefined}>
				{t}
			</span>
		) : (
			<span className="inline-flex items-center gap-1 text-fg-subtle" title="你没有这条对话的阅读权限，标题不对外显示">
				<Lock className="size-3" aria-hidden />
				无权查看
			</span>
		);
	return (
		<Card testid="chart-table" title="明细与下钻">
			<Tabs defaultValue="conv">
				<div className="mb-2 flex flex-wrap items-center justify-between gap-2">
					<TabsList>
						<TabsTrigger value="conv">对话</TabsTrigger>
						{orgLike && data.topUsers.length > 0 ? <TabsTrigger value="users">成员</TabsTrigger> : null}
						{data.topProjects.length > 0 ? <TabsTrigger value="projects">项目</TabsTrigger> : null}
						<TabsTrigger value="fail">最近失败</TabsTrigger>
					</TabsList>
				</div>
				<TabsContent value="conv">
					{data.conversations.length === 0 ? (
						<Empty height={100}>此范围内没有对话记录。</Empty>
					) : (
						<div className="overflow-x-auto">
							<table className="w-full text-sm" data-testid="table-conversations">
								<thead>
									<tr>
										<th className={th}>对话</th>
										{orgLike ? <th className={th}>成员</th> : null}
										<th className={th}>项目</th>
										<th className={thR}>运行</th>
										<th className={thR}>失败</th>
										<th className={thR}>模型请求</th>
										<th className={thR}>Token</th>
										<th className={th}>最近</th>
									</tr>
								</thead>
								<tbody>
									{data.conversations.map((c) => (
										<tr key={`${c.spaceId}:${c.conversationId}`} className="border-t border-border">
											<td className={cn(td, "max-w-[260px] truncate")}>{title(c.title, c.link)}</td>
											{orgLike ? <td className={td}>{c.userName ?? "—"}</td> : null}
											<td className={cn(td, "max-w-[140px] truncate text-fg-muted")}>{c.projectName ?? (c.projectId ? "—" : "个人空间")}</td>
											<td className={tdR}>{fmtInt(c.runs)}</td>
											<td className={cn(tdR, c.failedRuns ? "text-danger" : "text-fg-subtle")}>{fmtInt(c.failedRuns)}</td>
											<td className={tdR}>{fmtInt(c.modelRequests)}</td>
											<td className={tdR}>
												{fmtCompact(c.tokens)}
												<Sim show={c.simulated} />
											</td>
											<td className={cn(td, "whitespace-nowrap text-fg-muted")}>{when(c.lastAt)}</td>
										</tr>
									))}
								</tbody>
							</table>
							<CsvLink href={csv("conversations")} />
						</div>
					)}
				</TabsContent>
				<TabsContent value="users">
					<RankTable rows={data.topUsers} nameHead="成员" csv={csv("top-users")} />
				</TabsContent>
				<TabsContent value="projects">
					<RankTable rows={data.topProjects} nameHead="项目" csv={csv("top-projects")} />
				</TabsContent>
				<TabsContent value="fail">
					{data.recentFailures.length === 0 ? (
						<Empty height={100}>此范围内没有失败或超时的模型请求。</Empty>
					) : (
						<div className="overflow-x-auto">
							<table className="w-full text-sm" data-testid="table-failures">
								<thead>
									<tr>
										<th className={th}>时间</th>
										<th className={th}>对话</th>
										<th className={th}>模型</th>
										<th className={th}>结果</th>
										<th className={th}>错误类别</th>
									</tr>
								</thead>
								<tbody>
									{data.recentFailures.map((f, i) => (
										<tr key={i} className="border-t border-border">
											<td className={cn(td, "whitespace-nowrap text-fg-muted")}>{when(f.at)}</td>
											<td className={cn(td, "max-w-[260px] truncate")}>{title(f.title, f.link)}</td>
											<td className={td}>
												{f.model ?? "—"}
												<Sim show={f.simulated} />
											</td>
											<td className={td}>{f.outcome === "timeout" ? "超时" : "失败"}</td>
											<td className={cn(td, "font-mono text-xs text-fg-muted")}>{f.errorClass ?? "—"}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</TabsContent>
			</Tabs>
		</Card>
	);
}

function CsvLink({ href }: { href: string }) {
	return (
		<div className="mt-2 text-right">
			<a href={href} download className="text-xs text-fg-muted underline-offset-2 hover:underline">
				导出本表 CSV
			</a>
		</div>
	);
}

function RankTable({ rows, nameHead, csv }: { rows: StatsOverviewDTO["topUsers"]; nameHead: string; csv: string }) {
	const max = Math.max(1, ...rows.map((r) => r.runs));
	return (
		<div className="overflow-x-auto">
			<table className="w-full text-sm" data-testid="table-rank">
				<thead>
					<tr>
						<th className={th}>{nameHead}</th>
						<th className={th} style={{ width: "28%" }}>
							运行
						</th>
						<th className={thR}>失败</th>
						<th className={thR}>模型请求</th>
						<th className={thR}>工具调用</th>
						<th className={thR}>Token</th>
						<th className={thR}>费用</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((r) => (
						<tr key={r.id || r.name} className="border-t border-border">
							<td className={cn(td, "max-w-[200px] truncate")}>{r.name}</td>
							<td className={td}>
								<div className="flex items-center gap-2">
									<span className="h-2 rounded-sm bg-[var(--c1)]" style={{ width: `${Math.max(3, (r.runs / max) * 100)}%`, maxWidth: "70%" }} />
									<span className="tabular-nums">{fmtInt(r.runs)}</span>
								</div>
							</td>
							<td className={cn(tdR, r.failedRuns ? "text-danger" : "text-fg-subtle")}>{fmtInt(r.failedRuns)}</td>
							<td className={tdR}>{fmtInt(r.modelRequests)}</td>
							<td className={tdR}>{fmtInt(r.toolCalls)}</td>
							<td className={tdR}>
								{fmtCompact(r.tokens)}
								{r.simulatedTokens ? <span className="ml-1 text-xs text-fg-subtle">+{fmtCompact(r.simulatedTokens)} 模拟</span> : null}
							</td>
							<td className={tdR}>{r.tokens === 0 && r.simulatedTokens > 0 ? <span className="text-fg-subtle">模拟</span> : `$${r.cost.toFixed(r.cost < 0.01 ? 4 : 2)}`}</td>
						</tr>
					))}
				</tbody>
			</table>
			<CsvLink href={csv} />
		</div>
	);
}
