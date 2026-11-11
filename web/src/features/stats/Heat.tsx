// Custom SVG charts: GitHub-style calendar heatmap (365 days), weekday x hour punch card (dot matrix) and the waffle
// (10 x 10 dot matrix) for outcome share. Colour is one-hue sequential (blue), size carries volume in the punch card.
import { useEffect, useMemo, useState } from "react";
import type { OutcomeCounts, StatsOverviewDTO } from "@shared/ops";
import { fmtDay, fmtInt, fmtCompact, fmtPct, weekdayName } from "./format";
import { Card, Empty, levelOf, OUTCOME_META, SEQ, Segmented, thresholdsOf, TipRow, useTip } from "./parts";

type Metric = "runs" | "modelRequests" | "toolCalls" | "tokens";
const METRICS = [
	{ value: "runs", label: "运行" },
	{ value: "modelRequests", label: "模型请求" },
	{ value: "toolCalls", label: "工具调用" },
	{ value: "tokens", label: "Token" },
] as const;
const METRIC_LABEL: Record<Metric, string> = { runs: "运行", modelRequests: "模型请求", toolCalls: "工具调用", tokens: "Token" };

function Legend({ thresholds, fmt }: { thresholds: number[]; fmt: (n: number) => string }) {
	return (
		<div className="flex items-center gap-1.5 text-xs text-fg-subtle" aria-label="图例：颜色越深数值越大">
			<span>少</span>
			{SEQ.map((c, i) => (
				<span key={i} className="inline-block size-3 rounded-[3px]" style={{ background: c }} title={i === 0 ? "0" : i === 1 ? `1–${fmt(thresholds[0]!)}` : i === 5 ? `> ${fmt(thresholds[3]!)}` : `> ${fmt(thresholds[i - 2]!)}`} />
			))}
			<span>多</span>
		</div>
	);
}

// ------------------------------------------------------------------------------------------------ calendar
export function CalendarHeatmap({ data, csv }: { data: StatsOverviewDTO; csv: string }) {
	const [metric, setMetric] = useState<Metric>("runs");
	const { box, show, hide, el } = useTip();
	// Narrow screens scroll inside the card: start at the most recent weeks.
	useEffect(() => {
		const sc = box.current;
		if (sc) sc.scrollLeft = sc.scrollWidth;
	}, [box, metric, data]);
	const cal = data.calendar;
	const model = useMemo(() => {
		const byDay = new Map(cal.days.map((d) => [d.day, d]));
		// weeks start on Monday; the first column starts on the Monday on/before calendar.from
		const start = new Date(`${cal.from}T00:00:00Z`);
		const lead = (start.getUTCDay() + 6) % 7;
		const end = new Date(`${cal.to}T00:00:00Z`);
		const cells: { day: string; col: number; row: number; v: number; d?: (typeof cal.days)[number] }[] = [];
		const monthMarks: { col: number; label: string }[] = [];
		let col = 0;
		let lastMonth = -1;
		for (let t = start.getTime(), i = 0; t <= end.getTime(); t += 86_400_000, i++) {
			const row = (lead + i) % 7;
			col = Math.floor((lead + i) / 7);
			const day = new Date(t).toISOString().slice(0, 10);
			const d = byDay.get(day);
			cells.push({ day, col, row, v: d ? d[metric] : 0, d });
			if (row === 0 || i === 0) {
				const m = new Date(t).getUTCMonth();
				if (m !== lastMonth) {
					if (monthMarks.length && col - monthMarks[monthMarks.length - 1]!.col < 3) monthMarks.pop(); // avoid overlapping labels
					monthMarks.push({ col, label: `${m + 1}月` });
					lastMonth = m;
				}
			}
		}
		const values = cells.map((c) => c.v);
		return { cells, cols: col + 1, monthMarks, thresholds: thresholdsOf(values), total: values.reduce((s, v) => s + v, 0), activeDays: values.filter((v) => v > 0).length, max: Math.max(0, ...values) };
	}, [cal, metric]);
	const CELL = 13;
	const GAP = 3;
	const LEFT = 28;
	const TOP = 18;
	const W = LEFT + model.cols * (CELL + GAP);
	const H = TOP + 7 * (CELL + GAP);
	const fmt = metric === "tokens" ? fmtCompact : fmtInt;
	return (
		<Card
			testid="chart-calendar"
			title="每日活跃度 · 近 365 天"
			csv={csv}
			actions={<Segmented label="指标" value={metric} onChange={setMetric} options={METRICS} />}
		>
			{model.total === 0 ? (
				<Empty>过去 365 天内没有记录</Empty>
			) : (
				<>
					<div ref={box} className="relative overflow-x-auto pb-1">
						<svg role="img" aria-label={`过去 365 天${METRIC_LABEL[metric]}日历热力图：${model.activeDays} 天有活动，合计 ${fmt(model.total)}，单日最高 ${fmt(model.max)}`} viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block min-w-[720px]" style={{ width: "100%", height: "auto" }} data-testid="calendar-svg">
							{model.monthMarks.map((m) => (
								<text key={`${m.col}-${m.label}`} x={LEFT + m.col * (CELL + GAP)} y={10} fontSize={12} fill="var(--fg-subtle)">
									{m.label}
								</text>
							))}
							{[0, 2, 4].map((r) => (
								<text key={r} x={0} y={TOP + r * (CELL + GAP) + CELL - 2} fontSize={12} fill="var(--fg-subtle)">
									{weekdayName(r)}
								</text>
							))}
							{model.cells.map((c) => (
								<rect
									key={c.day}
									className="st-cell"
									data-testid="cal-cell"
									data-day={c.day}
									data-level={levelOf(c.v, model.thresholds)}
									x={LEFT + c.col * (CELL + GAP)}
									y={TOP + c.row * (CELL + GAP)}
									width={CELL}
									height={CELL}
									rx={3}
									fill={SEQ[levelOf(c.v, model.thresholds)]}
									onPointerMove={(e) =>
										show(
											e,
											<div>
												<div className="mb-0.5 font-medium">
													{fmtDay(c.day)} {weekdayName(c.row)}
												</div>
												<TipRow label="运行" value={fmtInt(c.d?.runs ?? 0)} />
												<TipRow label="模型请求" value={fmtInt(c.d?.modelRequests ?? 0)} />
												<TipRow label="工具调用" value={fmtInt(c.d?.toolCalls ?? 0)} />
												<TipRow label="Token" value={fmtCompact(c.d?.tokens ?? 0)} />
												{c.d?.failedRuns ? <TipRow label="失败/超时运行" value={fmtInt(c.d.failedRuns)} /> : null}
											</div>,
										)
									}
									onPointerLeave={hide}
								/>
							))}
						</svg>
						{el}
					</div>
					<div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-fg-muted">
						<span>
							{model.activeDays} 个活跃日 · 合计 {METRIC_LABEL[metric]} {fmt(model.total)}
						</span>
						<Legend thresholds={model.thresholds} fmt={fmt} />
					</div>
				</>
			)}
		</Card>
	);
}

// ------------------------------------------------------------------------------------------------ punch card
export function PunchCard({ data, csv }: { data: StatsOverviewDTO; csv: string }) {
	const [metric, setMetric] = useState<Metric>("runs");
	const { box, show, hide, el } = useTip();
	const m = useMemo(() => {
		const grid = new Map(data.punchCard.cells.map((c) => [`${c.weekday}-${c.hour}`, c]));
		const values = data.punchCard.cells.map((c) => c[metric]);
		return { grid, thresholds: thresholdsOf(values), max: Math.max(0, ...values), total: values.reduce((s, v) => s + v, 0) };
	}, [data, metric]);
	const CW = 28;
	const RH = 28;
	const LEFT = 36;
	const TOP = 6;
	const W = LEFT + 24 * CW;
	const H = TOP + 7 * RH + 20;
	const fmt = metric === "tokens" ? fmtCompact : fmtInt;
	return (
		<Card testid="chart-punchcard" title="活跃时段（星期 × 小时）" csv={csv} actions={<Segmented label="指标" value={metric} onChange={setMetric} options={METRICS} />}>
			{m.total === 0 ? (
				<Empty>此范围内没有记录，无法绘制活跃时段。</Empty>
			) : (
				<div ref={box} className="relative overflow-x-auto">
					<svg role="img" aria-label={`星期 × 小时点阵图（${METRIC_LABEL[metric]}），合计 ${fmt(m.total)}，单格最高 ${fmt(m.max)}`} viewBox={`0 0 ${W} ${H}`} className="block min-w-[640px]" style={{ width: "100%", height: "auto" }} data-testid="punchcard-svg">
						{Array.from({ length: 7 }, (_, r) => (
							<g key={r}>
								<text x={0} y={TOP + r * RH + RH / 2 + 4} fontSize={12} fill="var(--fg-muted)">
									{weekdayName(r)}
								</text>
								<line x1={LEFT} x2={W} y1={TOP + r * RH + RH / 2} y2={TOP + r * RH + RH / 2} stroke="var(--border)" strokeWidth={1} strokeDasharray="1 4" />
							</g>
						))}
						{Array.from({ length: 24 }, (_, h) => (
							<text key={h} x={LEFT + h * CW + CW / 2} y={H - 4} fontSize={12} textAnchor="middle" fill="var(--fg-subtle)">
								{h % 3 === 0 ? `${h}时` : ""}
							</text>
						))}
						{Array.from({ length: 7 }, (_, r) =>
							Array.from({ length: 24 }, (_, h) => {
								const c = m.grid.get(`${r}-${h}`);
								const v = c ? c[metric] : 0;
								const lv = levelOf(v, m.thresholds);
								const cx = LEFT + h * CW + CW / 2;
								const cy = TOP + r * RH + RH / 2;
								const rad = v > 0 ? 2.5 + Math.sqrt(v / m.max) * 10 : 1.5;
								return (
									<g key={`${r}-${h}`}>
										<circle
											className="st-cell"
											data-testid="punch-dot"
											data-weekday={r}
											data-hour={h}
											data-value={v}
											cx={cx}
											cy={cy}
											r={rad}
											fill={v > 0 ? SEQ[Math.max(lv, 1)] : "var(--border-strong)"}
											opacity={v > 0 ? 1 : 0.6}
										/>
										<rect
											x={cx - CW / 2}
											y={cy - RH / 2}
											width={CW}
											height={RH}
											fill="transparent"
											onPointerMove={(e) =>
												show(
													e,
													<div>
														<div className="mb-0.5 font-medium">
															{weekdayName(r)} {String(h).padStart(2, "0")}:00–{String((h + 1) % 24).padStart(2, "0")}:00
														</div>
														<TipRow label="运行" value={fmtInt(c?.runs ?? 0)} />
														<TipRow label="模型请求" value={fmtInt(c?.modelRequests ?? 0)} />
														<TipRow label="工具调用" value={fmtInt(c?.toolCalls ?? 0)} />
														<TipRow label="Token" value={fmtCompact(c?.tokens ?? 0)} />
													</div>,
												)
											}
											onPointerLeave={hide}
										/>
									</g>
								);
							}),
						)}
					</svg>
					{el}
					<div className="mt-1 flex justify-end">
						<Legend thresholds={m.thresholds} fmt={fmt} />
					</div>
				</div>
			)}
		</Card>
	);
}

// ------------------------------------------------------------------------------------------------ waffle
type Unit = "runs" | "tasks" | "modelRequests" | "toolCalls";
const UNITS = [
	{ value: "runs", label: "运行" },
	{ value: "tasks", label: "任务" },
	{ value: "modelRequests", label: "模型请求" },
	{ value: "toolCalls", label: "工具调用" },
] as const;
const ORDER = ["success", "failed", "timeout", "cancelled", "awaiting_approval", "in_progress"] as const;

/** Largest-remainder allocation of `cells` dots across counts (every non-zero outcome keeps at least one dot). */
export function allocateDots(counts: number[], cells = 100): number[] {
	const total = counts.reduce((s, c) => s + c, 0);
	if (!total) return counts.map(() => 0);
	const raw = counts.map((c) => (c / total) * cells);
	const out = raw.map((r, i) => (counts[i]! > 0 ? Math.max(1, Math.floor(r)) : 0));
	let diff = cells - out.reduce((s, c) => s + c, 0);
	const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f);
	for (let k = 0; diff > 0 && order.length; k++, diff--) out[order[k % order.length]!.i]!++;
	for (let k = 0; diff < 0; k++) {
		const j = out.indexOf(Math.max(...out));
		out[j]!--;
		diff++;
	}
	return out;
}

export function OutcomeWaffle({ data, csv }: { data: StatsOverviewDTO; csv: string }) {
	const [unit, setUnit] = useState<Unit>("runs");
	const { box, show, hide, el } = useTip();
	const c: OutcomeCounts = data.outcomes[unit === "runs" ? "runs" : unit === "tasks" ? "tasks" : unit === "modelRequests" ? "modelRequests" : "toolCalls"];
	const counts = ORDER.map((k) => c[k]);
	const dots = allocateDots(counts);
	const seq: (typeof ORDER)[number][] = [];
	ORDER.forEach((k, i) => {
		for (let n = 0; n < dots[i]!; n++) seq.push(k);
	});
	return (
		<Card testid="chart-waffle" title="结果占比" csv={csv} actions={<Segmented label="统计口径" value={unit} onChange={setUnit} options={UNITS} />}>
			{c.total === 0 ? (
				<Empty>此范围内没有{UNITS.find((u) => u.value === unit)?.label}记录。</Empty>
			) : (
				<div className="flex flex-wrap items-center gap-x-6 gap-y-3">
					<div ref={box} className="relative shrink-0">
						<svg role="img" aria-label={`结果占比点阵图：${ORDER.map((k, i) => `${OUTCOME_META[k].label} ${counts[i]}`).join("，")}，合计 ${c.total}`} viewBox="0 0 160 160" width={160} height={160} data-testid="waffle-svg">
							{seq.map((k, i) => {
								const col = i % 10;
								const row = 9 - Math.floor(i / 10); // fill from the bottom, left to right
								return (
									<circle
										key={i}
										className="st-cell"
										data-testid="waffle-dot"
										data-outcome={k}
										cx={8 + col * 16}
										cy={8 + row * 16}
										r={6}
										fill={OUTCOME_META[k].color}
										onPointerMove={(e) => show(e, <TipRow color={OUTCOME_META[k].color} label={OUTCOME_META[k].label} value={`${fmtInt(c[k])}（${fmtPct(c[k] / c.total)}）`} />)}
										onPointerLeave={hide}
									/>
								);
							})}
						</svg>
						{el}
					</div>
					<ul className="min-w-[160px] flex-1 space-y-1.5 text-sm" data-testid="waffle-legend">
						{ORDER.map((k, i) => (
							<li key={k} className="flex items-center justify-between gap-3" style={counts[i] === 0 ? { opacity: 0.5 } : undefined}>
								<span className="inline-flex items-center gap-2">
									<span aria-hidden className="inline-block size-2.5 rounded-full" style={{ background: OUTCOME_META[k].color }} />
									{OUTCOME_META[k].label}
								</span>
								<span className="tabular-nums text-fg-muted">
									<span className="font-medium text-fg">{fmtInt(counts[i])}</span> · {fmtPct(counts[i]! / c.total)}
								</span>
							</li>
						))}
						<li className="flex justify-between gap-3 border-t border-border pt-1.5 text-fg-muted">
							<span>合计</span>
							<span className="tabular-nums font-medium text-fg">{fmtInt(c.total)}</span>
						</li>
					</ul>
				</div>
			)}
		</Card>
	);
}
