import { Workflow } from "lucide-react";
import { useApi } from "@/lib/useApi";
import { fullTime } from "@/lib/utils";
import { TopBar } from "@/components/shell/AppShell";
import { Badge, EmptyState, Loadable, Page, PageHeader } from "@/components/ui/misc";
import { listOf } from "@/features/chat/pickers";

/** Minimal shape until shared/ops.ts lands (group E). Only fields actually returned are rendered. */
interface AutomationRow {
	id: string;
	name: string;
	enabled?: boolean;
	schedule?: string;
	cron?: string;
	timezone?: string;
	nextRunAt?: string;
	lastRun?: { status: string; at?: string; error?: string };
}

export default function AutomationsPage() {
	const res = useApi<unknown>("/automations");
	const list = listOf<AutomationRow>(res.data, "automations");
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page>
					<PageHeader title="自动化" description="按时间或条件自动发起的任务。每次触发都会生成一个对话，可查看结果与失败原因。" />
					<Loadable state={res} what="自动化" need="E 组：GET /api/automations">
						{list.length === 0 ? (
							<EmptyState icon={<Workflow />} title="还没有自动化" />
						) : (
							<div className="space-y-2">
								{list.map((a) => (
									<div key={a.id} className="rounded-xl border border-border bg-surface p-3">
										<div className="flex items-center gap-2">
											<span className="font-medium">{a.name}</span>
											<span className="flex-1" />
											<Badge tone={a.enabled === false ? "neutral" : "success"}>{a.enabled === false ? "已停用" : "启用中"}</Badge>
										</div>
										<p className="mt-1 text-xs text-fg-muted">
											{a.schedule ?? a.cron ?? ""}
											{a.timezone ? ` · ${a.timezone}` : ""}
											{a.nextRunAt ? ` · 下次运行 ${fullTime(a.nextRunAt)}` : ""}
										</p>
										{a.lastRun ? (
											<p className="mt-0.5 text-xs text-fg-subtle">
												上次：{a.lastRun.status}
												{a.lastRun.at ? ` · ${fullTime(a.lastRun.at)}` : ""}
												{a.lastRun.error ? ` · ${a.lastRun.error}` : ""}
											</p>
										) : null}
									</div>
								))}
							</div>
						)}
					</Loadable>
				</Page>
			</div>
		</div>
	);
}
