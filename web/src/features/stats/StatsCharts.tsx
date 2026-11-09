// Lazy chunk: the only importer of Recharts. Renders whatever numeric series /api/stats provides;
// shapes are finalised against shared/ops.ts when group E publishes it.
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Row = Record<string, unknown>;

function counters(data: Row): [string, number][] {
	const totals = (data.totals ?? data.counts ?? data) as Row;
	return Object.entries(totals).filter((e): e is [string, number] => typeof e[1] === "number");
}
function series(data: Row): { key: string; rows: Row[] } | null {
	for (const k of ["daily", "series", "byDay"]) if (Array.isArray(data[k]) && (data[k] as Row[]).length) return { key: k, rows: data[k] as Row[] };
	return null;
}

export default function StatsCharts({ data }: { data: Row }) {
	const c = counters(data);
	const s = series(data);
	const xKey = s ? (Object.keys(s.rows[0]!).find((k) => typeof s.rows[0]![k] === "string") ?? "day") : "day";
	const yKeys = s ? Object.keys(s.rows[0]!).filter((k) => typeof s.rows[0]![k] === "number") : [];
	return (
		<div className="space-y-6" data-testid="stats-charts">
			{c.length ? (
				<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
					{c.map(([k, v]) => (
						<div key={k} className="rounded-xl border border-border bg-surface p-3">
							<div className="text-xs text-fg-subtle">{k}</div>
							<div className="mt-1 text-xl font-semibold tabular-nums">{v.toLocaleString()}</div>
						</div>
					))}
				</div>
			) : null}
			{s && yKeys.length ? (
				<div className="h-72 rounded-xl border border-border bg-surface p-3">
					<ResponsiveContainer width="100%" height="100%">
						<BarChart data={s.rows}>
							<CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
							<XAxis dataKey={xKey} tick={{ fontSize: 12, fill: "var(--fg-subtle)" }} />
							<YAxis tick={{ fontSize: 12, fill: "var(--fg-subtle)" }} />
							<Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
							{yKeys.slice(0, 3).map((k, i) => (
								<Bar key={k} dataKey={k} fill={["#4a6fd1", "#7f8fa6", "#c48a3a"][i]} radius={[3, 3, 0, 0]} />
							))}
						</BarChart>
					</ResponsiveContainer>
				</div>
			) : null}
			{!c.length && !s ? <p className="text-[13px] text-fg-subtle">暂无统计数据。</p> : null}
		</div>
	);
}
