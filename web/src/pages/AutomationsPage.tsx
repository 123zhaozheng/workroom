import { Workflow } from "lucide-react";
import { useApi } from "@/lib/useApi";
import { fullTime } from "@/lib/utils";
import { TopBar } from "@/components/shell/AppShell";
import { Badge, EmptyState, Loadable, Page, PageHeader } from "@/components/ui/misc";
import { listOf } from "@/features/chat/pickers";

import type { AutomationDTO, AutomationRunStatus, AutomationTrigger } from "@shared/ops";
type AutomationRow = AutomationDTO;
const RUN: Record<AutomationRunStatus, string> = { pending: "等待中", running: "运行中", succeeded: "成功", failed: "失败", cancelled: "已取消", timeout: "超时", skipped: "已跳过（防重入）", refused: "被拒绝" };
const trig = (t: AutomationTrigger) => (t.kind === "cron" ? `周期：${t.expr}` : t.kind === "once" ? `一次性：${fullTime(t.at)}` : t.kind === "manual" ? "手动触发" : "Webhook 触发");

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
											{trig(a.trigger)} · 时区 {a.timezone}
											{a.nextRunAt ? ` · 下次运行 ${fullTime(a.nextRunAt)}` : ""}
										</p>
										{a.lastRun ? (
											<p className="mt-0.5 text-xs text-fg-subtle">
												上次：{RUN[a.lastRun.status] ?? a.lastRun.status}
												{a.lastRun.startedAt ? ` · ${fullTime(a.lastRun.startedAt)}` : ""}
												{a.lastRun.error ? ` · ${a.lastRun.error}` : ""}
												{a.lastRun.link ? (
													<a className="ml-1 text-info hover:underline" href={a.lastRun.link}>
														查看结果
													</a>
												) : null}
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
