// Lazy chunk: the only importer of Recharts. Tasks / runs / model requests / tool calls are counted separately
// with explicit outcome columns (M17-A); saved hours are only shown as confirmed or labelled estimate.
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { OutcomeCounts, StatsDTO } from "@shared/ops";

const OUTCOMES: [keyof OutcomeCounts, string][] = [
	["success", "成功"],
	["failed", "失败"],
	["cancelled", "取消"],
	["timeout", "超时"],
	["awaiting_approval", "待审批"],
	["in_progress", "进行中"],
	["total", "合计"],
];

export default function StatsCharts({ data }: { data: StatsDTO }) {
	const rows: [string, OutcomeCounts | undefined][] = [
		["任务", data.tasks],
		["运行（run）", data.runs],
		["模型请求", data.modelRequests],
		["工具调用", data.toolCalls],
	];
	return (
		<div className="space-y-6" data-testid="stats-charts">
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				{data.fixtureRequests > 0 && data.fixtureRequests >= (data.modelRequests?.total ?? 0) ? (
					<Tile label="Token 合计" value="—" hint="仅有测试模型请求：模拟用量，不显示数字" />
				) : (
					<Tile label="Token 合计" value={(data.tokens?.total ?? 0).toLocaleString()} hint={data.fixtureRequests ? "不含测试模型的模拟用量" : undefined} />
				)}
				<Tile label="费用（USD）" value={`$${(data.cost ?? 0).toFixed(4)}`} hint="测试模型用量不计费" />
				<Tile label="测试模型请求" value={String(data.fixtureRequests ?? 0)} />
				<Tile
					label="节省工时"
					value={data.savedHours?.confirmed != null ? `${data.savedHours.confirmed} 小时` : data.savedHours?.estimate ? `≈${data.savedHours.estimate.value} 小时` : "—"}
					hint={data.savedHours?.confirmed != null ? "经确认" : data.savedHours?.estimate ? `估算：${data.savedHours.estimate.basis}` : "无确认数据，不做推算"}
				/>
			</div>
			<div className="overflow-x-auto rounded-xl border border-border bg-surface">
				<table className="w-full text-[13px]">
					<thead>
						<tr className="text-fg-subtle">
							<th className="px-3 py-2 text-left font-medium">口径</th>
							{OUTCOMES.map(([k, l]) => (
								<th key={k} className="px-3 py-2 text-right font-medium">
									{l}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map(([label, c]) => (
							<tr key={label} className="border-t border-border">
								<td className="px-3 py-2">{label}</td>
								{OUTCOMES.map(([k]) => (
									<td key={k} className="px-3 py-2 text-right tabular-nums">
										{c ? c[k] : "—"}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{data.daily?.length ? (
				<div className="h-72 rounded-xl border border-border bg-surface p-3">
					<ResponsiveContainer width="100%" height="100%">
						<BarChart data={data.daily} maxBarSize={48}>
							<CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
							<XAxis dataKey="day" tick={{ fontSize: 12, fill: "var(--fg-subtle)" }} />
							<YAxis tick={{ fontSize: 12, fill: "var(--fg-subtle)" }} />
							<Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
							<Bar dataKey="tasks" name="任务" fill="#4a6fd1" radius={[3, 3, 0, 0]} />
							<Bar dataKey="modelRequests" name="模型请求" fill="#8a96a8" radius={[3, 3, 0, 0]} />
						</BarChart>
					</ResponsiveContainer>
				</div>
			) : null}
			{data.latency ? (
				<p className="text-[13px] text-fg-muted">
					模型请求耗时：p50 {data.latency.p50 ?? "—"} ms · p90 {data.latency.p90 ?? "—"} ms · p99 {data.latency.p99 ?? "—"} ms（{data.latency.count} 次）
					{data.largeContext ? ` · 大上下文请求 ${data.largeContext.requests} 次，失败率 ${data.largeContext.failureRate == null ? "—" : `${(data.largeContext.failureRate * 100).toFixed(1)}%`}` : ""}
				</p>
			) : null}
		</div>
	);
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
	return (
		<div className="rounded-xl border border-border bg-surface p-3">
			<div className="text-xs text-fg-subtle">{label}</div>
			<div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
			{hint ? <div className="mt-0.5 text-[11px] text-fg-subtle">{hint}</div> : null}
		</div>
	);
}
