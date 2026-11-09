// 成员 tab.
import { Ban, RotateCcw, Trash2 } from "lucide-react";
import type { MemberDTO } from "@shared/ops";
import { del, patch, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { relTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Badge, Loadable } from "@/components/ui/misc";
import { ROLE, useAct, Table, Row } from "@/features/admin/common";

export function Members({ selfId }: { selfId?: string }) {
	const res = useApi<{ members: MemberDTO[] }>("/admin/members");
	const { busy, run, note } = useAct(res.reload);
	return (
		<Loadable state={res} what="成员" need="E 组：GET /api/admin/members">
			{note}
			<Table testId="admin-members">
				{(res.data?.members ?? []).map((m) => (
					<div key={m.userId} data-testid="admin-member" data-status={m.status}>
						<Row>
							<span className="min-w-0 flex-1">
								<span className="block truncate font-medium">{m.name}</span>
								<span className="block truncate text-xs text-fg-subtle">
									{m.email} · {m.activeSessions} 个会话{m.lastSeenAt ? ` · 最近活跃 ${relTime(m.lastSeenAt)}` : ""}
									{m.totpEnabled ? " · 两步验证" : ""}
								</span>
							</span>
							{m.status === "disabled" ? <Badge tone="danger">已停用</Badge> : null}
							{m.userId === selfId ? (
								<Badge>{ROLE[m.role]}（你）</Badge>
							) : (
								<>
									<Select value={m.role} disabled={busy} aria-label={`${m.name} 的角色`} className="h-8 text-[13px]" onChange={(e) => run(() => patch(`/admin/members/${m.userId}`, { role: e.target.value }), "角色已更新")}>
										<option value="owner">所有者</option>
										<option value="admin">管理员</option>
										<option value="member">成员</option>
									</Select>
									{m.status === "active" ? (
										<Button size="sm" disabled={busy} data-testid="member-disable" onClick={() => run(() => post(`/admin/members/${m.userId}/disable`), `已停用 ${m.name}，其全部会话已撤销`)}>
											<Ban />
											停用
										</Button>
									) : (
										<Button size="sm" disabled={busy} onClick={() => run(() => post(`/admin/members/${m.userId}/enable`), `已恢复 ${m.name}（旧会话仍保持撤销）`)}>
											<RotateCcw />
											恢复
										</Button>
									)}
									<Button size="sm" variant="ghost" disabled={busy} onClick={() => confirm(`将 ${m.name} 移出组织？其项目成员关系、部门、会话与分享链接都会被移除。`) && run(() => del(`/admin/members/${m.userId}`), "已移出组织")}>
										<Trash2 />
										移出
									</Button>
								</>
							)}
						</Row>
					</div>
				))}
			</Table>
		</Loadable>
	);
}
