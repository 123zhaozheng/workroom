// 模型与渠道 tab. Owned by the MODELS group from round 4 (the admin shell only mounts it).
import { KeyRound, Wifi } from "lucide-react";
import { useState } from "react";
import type { AdminPlatformModelDTO, ChannelDTO } from "@shared/ops";
import { errorText, patch, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Button } from "@/components/ui/button";
import { Badge, Loadable } from "@/components/ui/misc";
import { useAct, Table, Row } from "@/features/admin/common";

export function ModelsAdmin() {
	const models = useApi<{ models: AdminPlatformModelDTO[] }>("/admin/models");
	const channels = useApi<{ channels: ChannelDTO[] }>("/admin/channels");
	const { busy, run, note } = useAct(() => {
		models.reload();
		channels.reload();
	});
	const [tests, setTests] = useState<Record<string, string>>({});
	return (
		<div className="space-y-6">
			{note}
			<section>
				<h3 className="mb-2 text-[13px] font-medium text-fg-muted">平台模型（用户可选）</h3>
				<Loadable state={models} what="模型" need="E 组：GET /api/admin/models">
					<Table testId="admin-models">
						{(models.data?.models ?? []).map((m) => (
							<div key={m.id}>
								<Row>
									<span className="min-w-0 flex-1">
										<span className="block font-medium">{m.fixture ? "测试模型（非真实 AI）" : m.label}</span>
										<span className="block truncate text-xs text-fg-subtle">
											{m.routes.length} 条路由 · {m.capabilities.join("/")}
											{m.statusDetail ? ` · ${m.statusDetail}` : ""}
										</span>
									</span>
									<Badge tone={m.status === "ready" ? "success" : m.status === "fixture" ? "warning" : "danger"}>{m.status === "ready" ? "可用" : m.status === "fixture" ? "测试" : "不可用"}</Badge>
									<label className="flex items-center gap-1.5 text-xs text-fg-muted">
										<input type="checkbox" checked={m.enabled} disabled={busy} onChange={(e) => run(() => patch(`/admin/models/${m.id}`, { enabled: e.target.checked }))} />
										对成员开放
									</label>
								</Row>
							</div>
						))}
					</Table>
				</Loadable>
			</section>
			<section>
				<h3 className="mb-2 text-[13px] font-medium text-fg-muted">上游渠道（凭据只在服务端；密钥从不返回）</h3>
				<Loadable state={channels} what="渠道" need="E 组：GET /api/admin/channels">
					<Table testId="admin-channels">
						{(channels.data?.channels ?? []).map((c) => (
							<div key={c.id}>
								<Row>
									<span className="min-w-0 flex-1">
										<span className="block font-medium">{c.name}</span>
										<span className="block truncate text-xs text-fg-subtle">
											{c.provider}
											{c.baseUrl ? ` · ${c.baseUrl}` : ""} · 凭据：{c.credential.kind === "env" ? `环境变量 ${c.credential.envVar ?? ""}` : c.credential.kind === "stored" ? `已加密保存${c.credential.hint ? `（${c.credential.hint}）` : ""}` : "无"}
											{c.healthDetail ? ` · ${c.healthDetail}` : ""}
										</span>
										{tests[c.id] ? <span className="block text-xs text-fg-muted">测试：{tests[c.id]}</span> : null}
									</span>
									<Badge tone={c.health === "ready" ? "success" : c.health === "circuit_open" ? "warning" : "danger"}>{c.health === "ready" ? "就绪" : c.health === "circuit_open" ? "熔断中" : "不可用"}</Badge>
									<Button
										size="sm"
										disabled={busy}
										onClick={() =>
											run(async () => {
												try {
													const r = await post<Record<string, unknown>>(`/admin/channels/${c.id}/test`);
													setTests((t) => ({ ...t, [c.id]: r.ok === false ? `失败 ${String(r.error ?? r.errorMessage ?? "")}` : `成功${r.latencyMs ? `（${r.latencyMs} ms）` : ""}` }));
												} catch (e) {
													setTests((t) => ({ ...t, [c.id]: `失败：${errorText(e)}` }));
												}
											})
										}
									>
										<Wifi />
										测试连通
									</Button>
									<label className="flex items-center gap-1.5 text-xs text-fg-muted">
										<input type="checkbox" checked={c.status === "enabled"} disabled={busy} onChange={(e) => run(() => patch(`/admin/channels/${c.id}`, { status: e.target.checked ? "enabled" : "disabled" }))} />
										启用
									</label>
								</Row>
							</div>
						))}
					</Table>
				</Loadable>
				<p className="mt-2 flex items-center gap-1 text-xs text-fg-subtle">
					<KeyRound className="size-3.5" />
					新增渠道或保存密钥需要服务端配置 WORKROOM_SECRET_KEY；未配置时服务端会拒绝保存密钥。
				</p>
			</section>
		</div>
	);
}
