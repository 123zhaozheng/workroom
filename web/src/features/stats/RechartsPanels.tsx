// The only importer of Recharts (a lazy chunk, loaded from the stats page only): stacked area by model / provider / route,
// the share donut and the latency histogram with p50 / p95 markers.
import { useMemo, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { StatsOverviewDTO, StatsSeriesItemDTO } from "@shared/ops";
import { fmtBucket, fmtCompact, fmtInt, fmtMs, fmtPct } from "./format";
import { Card, Empty, Segmented, seriesColor, TipRow } from "./parts";

type Dim = "model" | "provider" | "route";
type Metric = "requests" | "tokens";
const DIMS = [
	{ value: "model", label: "模型" },
	{ value: "provider", label: "供应商" },
	{ value: "route", label: "路由" },
] as const;
const METRICS = [
	{ value: "requests", label: "请求" },
	{ value: "tokens", label: "Token" },
] as const;

const axisTick = { fontSize: 12, fill: "var(--fg-subtle)" };

function Legend({ items, total, metric }: { items: StatsSeriesItemDTO[]; total: number; metric: Metric }) {
	return (
		<ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs" data-testid="series-legend">
			{items.map((it, i) => {
				const v = metric === "requests" ? it.totalRequests : it.totalTokens;
				return (
					<li key={it.key} className="inline-flex items-center gap-1.5 text-fg-muted">
						<span aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: seriesColor(it.key, i) }} />
						<span className="max-w-[140px] truncate text-fg" title={it.label}>
							{it.label}
						</span>
						{it.simulated ? <span className="rounded bg-surface-3 px-1 text-xs">模拟</span> : null}
						<span className="tabular-nums">{fmtCompact(v)}{total ? ` · ${fmtPct(v / total, 0)}` : ""}</span>
					</li>
				);
			})}
		</ul>
	);
}

export function SeriesPanel({ data, csv }: { data: StatsOverviewDTO; csv: (dim: Dim, metric: Metric) => string }) {
	const [dim, setDim] = useState<Dim>("model");
	const [metric, setMetric] = useState<Metric>("requests");
	const items = data.series[dim];
	const gran = data.granularity;
	const rows = useMemo(
		() =>
			data.series.buckets.map((b, i) => {
				const r: Record<string, number | string> = { bucket: b };
				for (const it of items) r[it.key] = metric === "requests" ? it.requests[i]! : it.tokens[i]!;
				return r;
			}),
		[data, items, metric],
	);
	const totals = items.map((it) => (metric === "requests" ? it.totalRequests : it.totalTokens));
	const total = totals.reduce((s, v) => s + v, 0);
	const empty = total === 0;
	const pie = items.map((it, i) => ({ key: it.key, name: it.label, value: totals[i]!, sim: it.simulated, i })).filter((x) => x.value > 0);
	const controls = (
		<div className="flex flex-wrap items-center gap-2">
			<Segmented label="分组" value={dim} onChange={setDim} options={DIMS} />
			<Segmented label="指标" value={metric} onChange={setMetric} options={METRICS} />
		</div>
	);
	const metricLabel = metric === "requests" ? "模型请求" : "Token（含模拟）";
	return (
		<div className="grid gap-4 sm:gap-6 lg:grid-cols-3" data-testid="series-panel">
			<Card testid="chart-area" className="lg:col-span-2" title={`${metricLabel}趋势`} subtitle={`按${DIMS.find((d) => d.value === dim)!.label}堆叠，${gran === "hour" ? "每小时" : gran === "week" ? "每周" : "每天"}${metric === "tokens" ? "；标“模拟”的是测试模型用量" : ""}`} csv={csv(dim, metric)} actions={controls}>
				{empty ? (
					<Empty>此范围内没有模型请求记录。{data.notes[0] ?? ""}</Empty>
				) : (
					<>
						<div className="h-64" role="img" aria-label={`${metricLabel}堆叠面积图，共 ${items.length} 个${DIMS.find((d) => d.value === dim)!.label}，合计 ${fmtCompact(total)}`} data-testid="area-chart">
							<ResponsiveContainer width="100%" height="100%">
								<AreaChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
									<CartesianGrid stroke="var(--border)" vertical={false} />
									<XAxis dataKey="bucket" tickFormatter={(b) => fmtBucket(b, gran)} tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--border-strong)" }} minTickGap={24} />
									<YAxis tick={axisTick} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => fmtCompact(v)} allowDecimals={false} />
									<Tooltip
										cursor={{ stroke: "var(--fg-subtle)", strokeDasharray: "3 3" }}
										content={({ active, payload, label }) => {
											if (!active || !payload?.length) return null;
											const sum = payload.reduce((s, p) => s + (Number(p.value) || 0), 0);
											return (
												<div className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs shadow-[var(--shadow-pop)]" data-testid="chart-tip">
													<div className="mb-0.5 font-medium">{fmtBucket(String(label), gran, true)}</div>
													{[...payload].reverse().map((p) => {
														const idx = items.findIndex((x) => x.key === p.dataKey);
														return <TipRow key={String(p.dataKey)} color={seriesColor(String(p.dataKey), idx)} label={items[idx]?.label ?? String(p.dataKey)} tag={items[idx]?.simulated ? "模拟" : undefined} value={fmtInt(Number(p.value) || 0)} />;
													})}
													<div className="mt-0.5 border-t border-border pt-0.5">
														<TipRow label="合计" value={fmtInt(sum)} />
													</div>
												</div>
											);
										}}
									/>
									{items.map((it, i) => (
										<Area key={it.key} type="monotone" stackId="s" dataKey={it.key} name={it.label} stroke={seriesColor(it.key, i)} fill={seriesColor(it.key, i)} fillOpacity={it.simulated ? 0.45 : 0.72} strokeWidth={1.5} strokeDasharray={it.simulated ? "4 3" : undefined} isAnimationActive={false} />
									))}
								</AreaChart>
							</ResponsiveContainer>
						</div>
						<div className="mt-2">
							<Legend items={items} total={total} metric={metric} />
						</div>
					</>
				)}
			</Card>
			<Card testid="chart-donut" title={`${DIMS.find((d) => d.value === dim)!.label}占比`} subtitle={`${metricLabel}份额`} csv={csv(dim, metric)}>
				{empty ? (
					<Empty>此范围内没有模型请求记录。</Empty>
				) : (
					<div className="flex flex-col items-center gap-3">
						<div className="relative h-48 w-48" role="img" aria-label={`${DIMS.find((d) => d.value === dim)!.label}占比环形图：${pie.map((p) => `${p.name} ${fmtPct(p.value / total, 0)}`).join("，")}`} data-testid="donut-chart">
							<ResponsiveContainer width="100%" height="100%">
								<PieChart>
									<Pie data={pie} dataKey="value" nameKey="name" innerRadius={58} outerRadius={86} paddingAngle={pie.length > 1 ? 2 : 0} stroke="var(--surface)" strokeWidth={2} isAnimationActive={false}>
										{pie.map((p) => (
											<Cell key={p.key} fill={seriesColor(p.key, p.i)} fillOpacity={p.sim ? 0.45 : 1} />
										))}
									</Pie>
									<Tooltip
										content={({ active, payload }) => {
											if (!active || !payload?.length) return null;
											const p = payload[0]!;
											const v = Number(p.value) || 0;
											return (
												<div className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs shadow-[var(--shadow-pop)]" data-testid="chart-tip">
													<TipRow label={String(p.name)} value={`${fmtInt(v)}（${fmtPct(v / total)}）`} tag={(p.payload as { sim?: boolean }).sim ? "模拟" : undefined} />
												</div>
											);
										}}
									/>
								</PieChart>
							</ResponsiveContainer>
							<div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
								<div className="text-[20px] font-semibold tabular-nums leading-6">{fmtCompact(total)}</div>
								<div className="text-xs text-fg-subtle">{metric === "requests" ? "请求" : "Token"}</div>
							</div>
						</div>
						<Legend items={items.filter((_, i) => totals[i]! > 0)} total={total} metric={metric} />
					</div>
				)}
			</Card>
		</div>
	);
}

// ------------------------------------------------------------------------------------------------ latency histogram
const bucketLabel = (le: number | null, prev: number | null) => (le === null ? `> ${fmtMs(prev)}` : `≤ ${fmtMs(le)}`);

export function LatencyHistogram({ data, csv }: { data: StatsOverviewDTO; csv: string }) {
	const L = data.latency;
	const rows = L.buckets.map((b, i) => ({ label: bucketLabel(b.le, i > 0 ? L.buckets[i - 1]!.le : null), count: b.count, le: b.le }));
	const labelFor = (v: number | null) => {
		if (v == null) return undefined;
		const i = L.buckets.findIndex((b) => b.le === null || v <= b.le);
		return rows[i]?.label;
	};
	const p50 = labelFor(L.p50);
	const p95 = labelFor(L.p95);
	return (
		<Card testid="chart-latency" title="模型请求延迟分布" subtitle={L.source === "simulated" ? "只有测试模型请求：耗时为模拟值" : "真实模型请求耗时；虚线为 P50 / P95"} csv={csv}>
			{L.count === 0 ? (
				<Empty>此范围内没有带耗时的模型请求。</Empty>
			) : (
				<>
					<div className="h-56" role="img" aria-label={`延迟直方图：${L.count} 次请求，P50 ${fmtMs(L.p50)}，P95 ${fmtMs(L.p95)}`} data-testid="latency-chart">
						<ResponsiveContainer width="100%" height="100%">
							<BarChart data={rows} margin={{ top: 18, right: 8, bottom: 0, left: 0 }}>
								<CartesianGrid stroke="var(--border)" vertical={false} />
								<XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--border-strong)" }} interval={0} angle={-30} textAnchor="end" height={52} />
								<YAxis tick={axisTick} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
								<Tooltip
									cursor={{ fill: "var(--surface-2)" }}
									content={({ active, payload }) => {
										if (!active || !payload?.length) return null;
										const p = payload[0]!.payload as { label: string; count: number };
										return (
											<div className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs shadow-[var(--shadow-pop)]" data-testid="chart-tip">
												<TipRow label={p.label} value={`${fmtInt(p.count)} 次（${fmtPct(p.count / L.count)}）`} />
											</div>
										);
									}}
								/>
								<Bar dataKey="count" fill={L.source === "simulated" ? "var(--c-other)" : "var(--c1)"} radius={[4, 4, 0, 0]} maxBarSize={44} isAnimationActive={false}>
									{rows.map((r, i) => (
										<Cell key={i} fill={L.source === "simulated" ? "var(--c-other)" : "var(--c1)"} />
									))}
								</Bar>
								{p50 ? <ReferenceLine x={p50} stroke="var(--fg)" strokeDasharray="4 3" label={{ value: "P50", position: "top", fill: "var(--fg-muted)", fontSize: 12 }} /> : null}
								{p95 ? <ReferenceLine x={p95} stroke="var(--st-failed)" strokeDasharray="4 3" label={{ value: "P95", position: p95 === p50 ? "insideTopRight" : "top", fill: "var(--fg-muted)", fontSize: 12 }} /> : null}
							</BarChart>
						</ResponsiveContainer>
					</div>
					<dl className="mt-2 grid grid-cols-3 gap-2 text-xs" data-testid="latency-stats">
						{[
							["P50", fmtMs(L.p50)],
							["P95", fmtMs(L.p95)],
							["最大", fmtMs(L.max)],
						].map(([k, v]) => (
							<div key={k} className="rounded-lg bg-surface-2 px-2.5 py-1.5">
								<dt className="text-fg-subtle">{k}</dt>
								<dd className="font-medium tabular-nums">{v}</dd>
							</div>
						))}
					</dl>
				</>
			)}
		</Card>
	);
}
