// 统计 (separate page, never the home). Recharts is a lazy chunk loaded only here.
import { lazy, Suspense } from "react";
import { useApi } from "@/lib/useApi";
import { TopBar } from "@/components/shell/AppShell";
import { Loadable, Page, PageHeader, Spinner } from "@/components/ui/misc";

const StatsCharts = lazy(() => import("@/features/stats/StatsCharts"));

export default function StatsPage() {
	const res = useApi<Record<string, unknown>>("/stats");
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page wide>
					<PageHeader title="统计" description="任务、运行、模型请求与工具调用分别统计；测试模型的用量单独标注，不计费用。" />
					<Loadable state={res} what="统计" need="E 组：GET /api/stats">
						{res.data ? (
							<Suspense fallback={<Spinner />}>
								<StatsCharts data={res.data} />
							</Suspense>
						) : null}
					</Loadable>
				</Page>
			</div>
		</div>
	);
}
