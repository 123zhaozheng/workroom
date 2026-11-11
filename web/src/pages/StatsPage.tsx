// 统计 — analytics dashboard (separate page, never the home). Chart approach and bundle notes: docs/ui.md §统计页.
// Everything (including Recharts, a lazy chunk of its own) is only loaded on /stats.
import { Info } from "lucide-react";
import { useMemo, useRef } from "react";
import { useSearchParams } from "react-router";
import type { StatsOverviewDTO, StatsScopesDTO } from "@shared/ops";
import { useApi } from "@/lib/useApi";
import { TopBar } from "@/components/shell/AppShell";
import { ErrorState } from "@/components/ui/misc";
import Dashboard, { DashboardSkeleton } from "@/features/stats/Dashboard";
import { buildQuery, FilterBar, type Filters, type Preset } from "@/features/stats/FilterBar";
import { KpiSkeleton } from "@/features/stats/Kpis";
import "@/features/stats/stats.css";

const PRESET_VALUES: Preset[] = ["7d", "30d", "90d", "mtd", "365d", "custom"];

function filtersOf(sp: URLSearchParams): Filters {
	const p = sp.get("range") as Preset | null;
	const g = sp.get("gran");
	return { scope: sp.get("scope") ?? "personal", preset: p && PRESET_VALUES.includes(p) ? p : "30d", from: sp.get("from") ?? "", to: sp.get("to") ?? "", gran: g === "hour" || g === "day" || g === "week" ? g : null };
}

export default function StatsPage() {
	const [sp, setSp] = useSearchParams();
	const filters: Filters = useMemo(() => filtersOf(sp), [sp]);
	// Merge each patch into the *latest* params, not the ones captured at render: two quick edits (e.g. both dates) must not overwrite
	// each other. React Router's functional setter also reads the render-time params, so keep our own ref, synced when the URL changes.
	const latest = useRef(sp);
	const seen = useRef(sp.toString());
	if (sp.toString() !== seen.current) {
		seen.current = sp.toString();
		latest.current = sp;
	}
	const setFilters = (patch: Partial<Filters>) => {
		const f = { ...filtersOf(latest.current), ...patch };
		const n = new URLSearchParams();
		n.set("scope", f.scope);
		n.set("range", f.preset);
		if (f.preset === "custom") (n.set("from", f.from), n.set("to", f.to));
		if (f.gran) n.set("gran", f.gran);
		latest.current = n;
		setSp(n, { replace: true });
	};
	const scopes = useApi<StatsScopesDTO>("/stats/scopes");
	const query = useMemo(() => buildQuery(filters), [filters]);
	const res = useApi<StatsOverviewDTO>(`/stats/overview?${query}`);
	const data = res.data;
	const adjusted = data && data.requestedGranularity !== data.granularity ? `粒度已自动改为“${data.granularity === "day" ? "天" : "周"}”` : null;
	const demo = data?.demo ?? scopes.data?.demo;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<div className="stats-root mx-auto w-full max-w-[1320px] px-4 pb-16 pt-6 sm:px-8 sm:pt-8" data-testid="stats-page">
					<h1 className="mb-4 text-xl font-semibold tracking-tight sm:mb-6">统计</h1>
					{demo ? (
						<div role="note" data-testid="demo-banner" className="mb-4 flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
							<Info className="mt-0.5 size-4 shrink-0" aria-hidden />
							<span className="font-semibold">演示数据</span>
						</div>
					) : null}
					<FilterBar value={filters} onChange={setFilters} scopes={scopes.data} adjusted={adjusted} />
					{res.unavailable ? (
						<ErrorState error={new Error("统计服务暂时不可用，请稍后重试。")} onRetry={res.reload} what="统计" />
					) : res.error ? (
						<ErrorState error={res.error} onRetry={res.reload} what="统计" />
					) : !data ? (
						<div className="space-y-4">
							<KpiSkeleton />
							<DashboardSkeleton />
						</div>
					) : (
						<div className={res.loading ? "opacity-60 transition-opacity" : undefined}>
							{data.notes.length ? (
								<div role="status" data-testid="stats-notes" className="mb-4 rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm text-fg-muted">
									{data.notes.map((n) => (
										<p key={n}>{n}</p>
									))}
								</div>
							) : null}
							<Dashboard data={data} query={query} />
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
