// 模型与路由记录 (M15-A): the platform model the user chose, and every actual route attempt recorded by the gateway
// (channel, upstream model, status, failover, error class, latency). Simulated (fixture) attempts are labelled.
import type { RouteAttemptDTO } from "@shared/ops";
import { useApi } from "@/lib/useApi";
import { fullTime } from "@/lib/utils";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { Badge, Loadable } from "@/components/ui/misc";

export default function RoutesDialog({ spaceId, conversationId, modelLabel, fixture, open, onOpenChange }: { spaceId: string; conversationId: number; modelLabel?: string; fixture?: boolean; open: boolean; onOpenChange: (o: boolean) => void }) {
	const res = useApi<{ attempts: RouteAttemptDTO[] }>(open ? `/conversations/${spaceId}/${conversationId}/routes` : null);
	const rows = res.data?.attempts ?? [];
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title="模型与路由记录" description="你选择的平台模型，以及这次对话中每一次实际请求走的渠道与上游模型。" className="max-w-2xl">
				<div data-testid="routes" className="wr-scroll -mx-1 max-h-[70vh] overflow-y-auto px-1 text-[13px]">
					<p className="mb-3">
						当前模型：<span className="font-medium">{fixture ? "测试模型（非真实 AI）" : modelLabel}</span>
					</p>
					<Loadable state={res} what="路由记录" need="E 组：GET /conversations/:spaceId/:id/routes">
						{rows.length === 0 ? (
							<p className="text-fg-subtle">还没有模型请求记录。</p>
						) : (
							<table className="w-full text-xs">
								<thead className="text-fg-subtle">
									<tr>
										<th className="py-1 text-left font-medium">时间</th>
										<th className="py-1 text-left font-medium">平台模型</th>
										<th className="py-1 text-left font-medium">实际渠道 / 上游模型</th>
										<th className="py-1 text-left font-medium">结果</th>
									</tr>
								</thead>
								<tbody>
									{rows.map((r) => (
										<tr key={r.id} data-testid="route-attempt" className="border-t border-border align-top">
											<td className="py-1.5 pr-2 text-fg-subtle">{fullTime(r.startedAt)}</td>
											<td className="py-1.5 pr-2">{r.platformModelId}</td>
											<td className="py-1.5 pr-2">
												{r.channelName ?? r.channelId ?? "—"} / <span className="font-mono">{r.upstreamModelId ?? "—"}</span>
												{r.attemptNo > 1 ? <span className="text-fg-subtle"> · 第 {r.attemptNo} 次尝试</span> : null}
												{r.failover ? <Badge tone="warning" className="ml-1">故障切换</Badge> : null}
												{r.fixture ? <Badge className="ml-1">测试模型</Badge> : null}
											</td>
											<td className="py-1.5">
												<Badge tone={r.status === "ok" ? "success" : r.status === "skipped" ? "neutral" : "danger"}>
													{r.status === "ok" ? "成功" : r.status === "aborted" ? "已中止" : r.status === "skipped" ? "跳过" : "失败"}
												</Badge>
												{r.errorClass ? <span className="ml-1 text-fg-subtle">{r.errorClass}</span> : null}
												{r.latencyMs !== undefined ? <span className="ml-1 text-fg-subtle">{r.latencyMs} ms</span> : null}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
					</Loadable>
				</div>
			</DialogContent>
		</Dialog>
	);
}
