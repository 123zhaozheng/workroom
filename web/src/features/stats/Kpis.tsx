// KPI tiles: value, period-over-period delta and a sparkline per tile. Simulated (test-model) tokens / latency are labelled 模拟
// and never mixed into the real value; cost is never shown for simulated usage.
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type { StatsGranularity, StatsKpiDTO, StatsKpiKey, StatsOverviewDTO } from "@shared/ops";
import { cn } from "@/lib/utils";
import { fmtBucket, fmtCompact, fmtInt, fmtMs, fmtPct, fmtUsd } from "./format";
import { Skeleton, useTip, TipRow } from "./parts";

interface Def {
	key: StatsKpiKey;
	label: string;
	hint: string;
	better: "up" | "down" | "neutral";
	fmt: (v: number) => string;
}
const DEFS: Def[] = [
	{ key: "conversations", label: "对话", hint: "范围内有过用户输入的不同对话数", better: "neutral", fmt: fmtInt },
	{ key: "runs", label: "运行", hint: "运行（run）：从用户输入到回答结束的一次运行", better: "neutral", fmt: fmtInt },
	{ key: "modelRequests", label: "模型请求", hint: "每次被记录的模型请求（含失败与中止）", better: "neutral", fmt: fmtInt },
	{ key: "toolCalls", label: "工具调用", hint: "每次工具结果记录", better: "neutral", fmt: fmtInt },
	{ key: "filesProduced", label: "产出文件", hint: "智能体或自动化产出的文件版本（不含上传）", better: "neutral", fmt: fmtInt },
	{ key: "knowledgeSearches", label: "知识检索", hint: "知识库检索次数（不含评测）", better: "neutral", fmt: fmtInt },
	{ key: "automationRuns", label: "自动化运行", hint: "自动化任务的运行记录", better: "neutral", fmt: fmtInt },
	{ key: "successRate", label: "成功率", hint: "成功 ÷（成功 + 失败 + 超时）的运行；已取消、待审批、进行中不计入分母", better: "up", fmt: (v) => fmtPct(v) },
	{ key: "latencyP50", label: "延迟 P50", hint: "真实模型请求耗时的中位数", better: "down", fmt: fmtMs },
	{ key: "latencyP95", label: "延迟 P95", hint: "真实模型请求耗时的 95 分位", better: "down", fmt: fmtMs },
	{ key: "inputTokens", label: "输入 Token", hint: "真实模型用量；测试模型的模拟用量单独标注", better: "neutral", fmt: fmtCompact },
	{ key: "outputTokens", label: "输出 Token", hint: "真实模型用量；测试模型的模拟用量单独标注", better: "neutral", fmt: fmtCompact },
	{ key: "cacheTokens", label: "缓存 Token", hint: "缓存读 + 缓存写", better: "neutral", fmt: fmtCompact },
	{ key: "cost", label: "费用（USD）", hint: "来自上游上报或目录价 × 实际用量；测试模型不计费", better: "neutral", fmt: fmtUsd },
];
const SIM_KEYS = new Set<StatsKpiKey>(["inputTokens", "outputTokens", "cacheTokens", "cost", "latencyP50", "latencyP95"]);

function Sparkline({ points, buckets, gran, fmt, color = "var(--c1)" }: { points: (number | null)[]; buckets: string[]; gran: StatsGranularity; fmt: (v: number) => string; color?: string }) {
	const { box, show, hide, el } = useTip();
	const vals = points.filter((p): p is number => p != null);
	if (vals.length < 2 || (Math.max(...vals) === 0 && Math.min(...vals) === 0)) return <div aria-hidden className="h-7 border-b border-dashed border-border" />;
	const W = 120;
	const H = 28;
	const max = Math.max(...vals);
	const min = Math.min(0, ...vals);
	const x = (i: number) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * W);
	const y = (v: number) => H - 2 - ((v - min) / (max - min || 1)) * (H - 5);
	let d = "";
	let pen = false;
	points.forEach((p, i) => {
		if (p == null) return void (pen = false);
		d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(p).toFixed(1)}`;
		pen = true;
	});
	const first = points.findIndex((p) => p != null);
	const last = points.length - 1 - [...points].reverse().findIndex((p) => p != null);
	const area = `${d} L${x(last).toFixed(1)} ${H} L${x(first).toFixed(1)} ${H} Z`;
	return (
		<div ref={box} className="relative">
			<svg
				viewBox={`0 0 ${W} ${H}`}
				preserveAspectRatio="none"
				className="block h-7 w-full overflow-visible"
				role="img"
				aria-label={`趋势：${points.length} 个${gran === "hour" ? "小时" : gran === "week" ? "周" : "天"}，最高 ${fmt(max)}`}
				data-testid="sparkline"
				onPointerMove={(e) => {
					const r = e.currentTarget.getBoundingClientRect();
					const i = Math.max(0, Math.min(points.length - 1, Math.round(((e.clientX - r.left) / r.width) * (points.length - 1))));
					show(e, <TipRow label={fmtBucket(buckets[i]!, gran, true)} value={points[i] == null ? "无数据" : fmt(points[i]!)} />);
				}}
				onPointerLeave={hide}
			>
				{vals.length ? <path d={area} fill={color} opacity={0.12} stroke="none" /> : null}
				<path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
			</svg>
			{el}
		</div>
	);
}

function Delta({ k, def }: { k: StatsKpiDTO; def: Def }) {
	if (k.value == null || k.previous == null || k.delta == null) return <span className="text-[11px] text-fg-subtle">上一周期无数据</span>;
	if (k.delta === 0) return <span className="inline-flex items-center gap-0.5 text-[11px] text-fg-subtle"><Minus className="size-3" />与上期持平</span>;
	const up = k.delta > 0;
	const good = def.better === "neutral" ? null : (def.better === "up") === up;
	const tone = good === null ? "text-fg-muted" : good ? "text-[var(--good-text)]" : "text-[var(--bad-text)]";
	const text = k.key === "successRate" ? `${Math.abs(k.delta * 100).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} pt` : k.deltaPct != null ? (Math.abs(k.deltaPct) > 9.99 ? "> 999%" : fmtPct(Math.abs(k.deltaPct), 0)) : "新增";
	return (
		<span className={cn("inline-flex items-center gap-0.5 text-[11px] font-medium", tone)} data-testid="delta">
			{up ? <ArrowUpRight className="size-3" aria-hidden /> : <ArrowDownRight className="size-3" aria-hidden />}
			<span className="sr-only">{up ? "上升" : "下降"}</span>
			{text}
			<span className="font-normal text-fg-subtle"> 较上期</span>
		</span>
	);
}

export function KpiGrid({ data }: { data: StatsOverviewDTO }) {
	const only = data.simulation.onlySimulated;
	return (
		<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7" data-testid="kpis">
			{DEFS.map((def) => {
				const k = data.kpis.find((x) => x.key === def.key)!;
				const sim = SIM_KEYS.has(def.key);
				let main: string;
				let badge: string | null = null;
				let note: string | null = null;
				if (sim && def.key === "cost") {
					main = only ? "模拟" : fmtUsd(k.value);
					note = only ? "测试模型不计费" : data.simulation.simulatedRequests ? "不含测试模型（模拟）" : null;
				} else if (sim && (only || (k.value == null && k.simulatedValue != null))) {
					// only test-model (simulated) usage in the period: never show it as a real figure
					main = k.simulatedValue != null ? def.fmt(k.simulatedValue) : "—";
					badge = "模拟";
				} else {
					main = k.value == null ? "—" : def.fmt(k.value);
					if (sim && k.simulatedValue != null && def.key !== "latencyP50" && def.key !== "latencyP95") note = `另有模拟 ${fmtCompact(k.simulatedValue)}`;
				}
				return (
					<div key={def.key} data-testid="kpi" data-kpi={def.key} title={`${def.hint}${note ? `。${note}` : ""}`} className="flex min-w-0 flex-col rounded-xl border border-border bg-surface p-3">
						<div className="flex items-center justify-between gap-1 text-[12px] text-fg-muted">
							<span className="truncate">{def.label}</span>
							{badge ? <span className="shrink-0 rounded bg-surface-3 px-1 text-[10px] font-medium text-fg-muted">{badge}</span> : null}
						</div>
						<div className="mt-1 truncate text-[22px] font-semibold leading-7 tracking-tight tabular-nums" data-testid="kpi-value">
							{main}
						</div>
						<div className="mt-0.5 min-h-4 truncate text-[11px] text-fg-subtle">{note ?? <Delta k={k} def={def} />}</div>
						<div className="mt-2">
							<Sparkline points={k.spark} buckets={data.series.buckets} gran={data.granularity} fmt={def.fmt} />
						</div>
					</div>
				);
			})}
		</div>
	);
}

export function KpiSkeleton() {
	return (
		<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7" data-testid="skeleton">
			{Array.from({ length: 14 }, (_, i) => (
				<div key={i} className="rounded-xl border border-border bg-surface p-3">
					<Skeleton className="h-3 w-12" />
					<Skeleton className="mt-2 h-6 w-20" />
					<Skeleton className="mt-2 h-3 w-24" />
					<Skeleton className="mt-3 h-7 w-full" />
				</div>
			))}
		</div>
	);
}
