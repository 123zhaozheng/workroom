// 统计 — analytics dashboard (separate page, never the home). Chart approach and bundle notes: docs/ui.md §统计页.
// Everything (including Recharts, a lazy chunk of its own) is only loaded on /stats.
import { Info } from "lucide-react";
import { useMemo } from "react";
import { useSearchParams } from "react-router";
import type { StatsOverviewDTO, StatsScopesDTO } from "@shared/ops";
import { useApi } from "@/lib/useApi";
import { TopBar } from "@/components/shell/AppShell";
import { ErrorState } from "@/components/ui/misc";
import { InfoPop } from "@/components/shell/InfoPop";
import Dashboard, { DashboardSkeleton } from "@/features/stats/Dashboard";
import { buildQuery, defaultGran, FilterBar, resolveRange, type Filters, type Preset } from "@/features/stats/FilterBar";
import { KpiSkeleton } from "@/features/stats/Kpis";
import "@/features/stats/stats.css";

const PRESET_VALUES: Preset[] = ["7d", "30d", "90d", "mtd", "365d", "custom"];

export default function StatsPage() {
	const [sp, setSp] = useSearchParams();
	const filters: Filters = useMemo(() => {
		const p = sp.get("range") as Preset | null;
		const g = sp.get("gran");
		return { scope: sp.get("scope") ?? "personal", preset: p && PRESET_VALUES.includes(p) ? p : "30d", from: sp.get("from") ?? "", to: sp.get("to") ?? "", gran: g === "hour" || g === "day" || g === "week" ? g : null };
	}, [sp]);
	const setFilters = (f: Filters) => {
		const n = new URLSearchParams();
		n.set("scope", f.scope);
		n.set("range", f.preset);
		if (f.preset === "custom") (n.set("from", f.from), n.set("to", f.to));
		if (f.gran) n.set("gran", f.gran);
		setSp(n, { replace: true });
	};
	const scopes = useApi<StatsScopesDTO>("/stats/scopes");
	const query = useMemo(() => buildQuery(filters), [filters]);
	const res = useApi<StatsOverviewDTO>(`/stats/overview?${query}`);
	const data = res.data;
	const range = resolveRange(filters);
	const asked = filters.gran ?? defaultGran(filters.preset, range.days);
	const adjusted = data && data.requestedGranularity !== data.granularity ? `“${asked === "hour" ? "小时" : "天"}”粒度在这个时间范围内会产生过多的点，已自动改为“${data.granularity === "day" ? "天" : "周"}”。` : null;
	const demo = data?.demo ?? scopes.data?.demo;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<div className="stats-root mx-auto w-full max-w-[1320px] px-4 pb-16 pt-6 sm:px-8 sm:pt-8" data-testid="stats-page">
					<div className="mb-4 flex items-center gap-1.5 sm:mb-6">
						<h1 className="text-xl font-semibold tracking-tight">统计</h1>
						<InfoPop label="数据说明" testid="stats-about">
							数字来自已记录的运行、模型请求、工具调用、文件、检索和自动化。测试模型的用量标为“模拟”，不计费用。
						</InfoPop>
					</div>
					{demo ? (
						<div role="note" data-testid="demo-banner" className="mb-4 flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
							<Info className="mt-0.5 size-4 shrink-0" aria-hidden />
							<div>
								<span className="font-semibold">演示数据</span>
								：这是演示组织，图表里的记录都是模拟的，不代表真实使用，也没有真实费用。
							</div>
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
							<p className="mt-6 text-xs text-fg-muted">
								数据生成于 {new Date(data.generatedAt).toLocaleString("zh-CN", { hour12: false })} · 按本地时区（UTC{data.tzOffsetMinutes >= 0 ? "+" : "−"}
								{Math.abs(data.tzOffsetMinutes / 60)}）统计
							</p>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
