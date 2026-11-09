// The dashboard body. Recharts (area / donut / histogram) is a separate lazy chunk, started as soon as this module loads so it
// downloads in parallel with the data request; nothing here is imported by the home or chat bundles.
import { lazy, Suspense } from "react";
import type { StatsOverviewDTO } from "@shared/ops";
import { KpiGrid } from "./Kpis";
import { CalendarHeatmap, OutcomeWaffle, PunchCard } from "./Heat";
import { ActivityCard, DrilldownTables, KnowledgeCard, LargeContextCard, ToolRanking } from "./Panels";
import { Skeleton } from "./parts";

const loadRecharts = () => import("./RechartsPanels");
void loadRecharts();
const SeriesPanel = lazy(() => loadRecharts().then((m) => ({ default: m.SeriesPanel })));
const LatencyHistogram = lazy(() => loadRecharts().then((m) => ({ default: m.LatencyHistogram })));

function ChartFallback({ h = "h-72" }: { h?: string }) {
	return <Skeleton className={`${h} w-full rounded-xl`} />;
}

export default function Dashboard({ data, query }: { data: StatsOverviewDTO; query: string }) {
	const csv = (chart: string, extra = "") => `/api/stats/export.csv?${query}&chart=${chart}${extra}`;
	return (
		<div className="space-y-4" data-testid="stats-dashboard">
			<KpiGrid data={data} />
			<CalendarHeatmap data={data} csv={csv("calendar")} />
			<div className="grid gap-4 lg:grid-cols-5">
				<div className="min-w-0 lg:col-span-3">
					<PunchCard data={data} csv={csv("punchcard")} />
				</div>
				<div className="min-w-0 lg:col-span-2">
					<OutcomeWaffle data={data} csv={csv("outcomes")} />
				</div>
			</div>
			<Suspense fallback={<ChartFallback />}>
				<SeriesPanel data={data} csv={(dim, metric) => csv(`series-${dim}`, `&metric=${metric}`)} />
			</Suspense>
			<div className="grid gap-4 lg:grid-cols-2">
				<ToolRanking data={data} csv={csv("tools")} />
				<Suspense fallback={<ChartFallback h="h-80" />}>
					<LatencyHistogram data={data} csv={csv("latency")} />
				</Suspense>
			</div>
			<div className="grid gap-4 lg:grid-cols-3">
				<KnowledgeCard data={data} csv={csv("knowledge")} />
				<LargeContextCard data={data} />
				<ActivityCard data={data} />
			</div>
			<DrilldownTables data={data} csv={csv} />
		</div>
	);
}

export function DashboardSkeleton() {
	return (
		<div className="space-y-4" data-testid="skeleton-dashboard" aria-busy="true" aria-label="统计加载中">
			<Skeleton className="h-44 w-full rounded-xl" />
			<div className="grid gap-4 lg:grid-cols-5">
				<Skeleton className="h-64 w-full rounded-xl lg:col-span-3" />
				<Skeleton className="h-64 w-full rounded-xl lg:col-span-2" />
			</div>
			<Skeleton className="h-72 w-full rounded-xl" />
		</div>
	);
}
