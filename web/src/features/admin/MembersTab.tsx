// 成员 tab: member list with base role, extra roles, status; opens the 成员详情 drawer. Existing actions (disable / enable / remove) stay.
import { Ban, RotateCcw, Trash2, UserCog } from "lucide-react";
import { useState } from "react";
import type { MemberDTO } from "@shared/ops";
import { del, patch, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { relTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Badge, Loadable } from "@/components/ui/misc";
import { Row, Table, useAct } from "@/features/admin/common";
import { MemberDetail } from "@/features/admin/MemberDetail";
import { ROLE_SHORT, scopeText, useViewerPerms } from "@/features/admin/rbac-ui";

type MemberRow = MemberDTO & { roles?: { roleId: string; name: string; scope: { kind: "org" | "department" | "project"; id?: string } }[] };
const BASE = /^builtin:(owner|admin|member|guest)$/;

export function Members({ selfId }: { selfId?: string }) {
	const res = useApi<{ members: MemberRow[] }>("/admin/members");
	const perms = useViewerPerms();
	const { busy, run, note } = useAct(res.reload);
	const [open, setOpen] = useState<string>();
	const orgWide = perms.org.has("member.view");
	return (
		<Loadable state={res} what="成员" need="E 组：GET /api/admin/members">
			{note}
			{!orgWide ? <p className="mb-2 text-xs text-fg-subtle">你只能看到自己所管理部门范围内的成员。</p> : null}
			<Table testId="admin-members">
				{(res.data?.members ?? []).map((m) => {
					const base = m.roles?.find((r) => r.scope.kind === "org" && BASE.test(r.roleId))?.roleId.replace("builtin:", "") ?? m.role;
					const extra = (m.roles ?? []).filter((r) => !(r.scope.kind === "org" && BASE.test(r.roleId)));
					return (
						<div key={m.userId} data-testid="admin-member" data-status={m.status}>
							<Row>
								<span className="min-w-0 flex-1">
									<button type="button" className="block max-w-full truncate text-left font-medium hover:underline" data-testid="member-open" onClick={() => setOpen(m.userId)}>
										{m.name}
									</button>
									<span className="block truncate text-xs text-fg-subtle">
										{m.email} · {m.activeSessions} 个会话{m.lastSeenAt ? ` · 最近活跃 ${relTime(m.lastSeenAt)}` : ""}
										{m.totpEnabled ? " · 两步验证" : ""}
									</span>
									{extra.length ? (
										<span className="mt-1 flex flex-wrap gap-1">
											{extra.map((r, i) => (
												<Badge key={i} tone="info" title={scopeText(r.scope)}>
													{ROLE_SHORT[r.roleId] ?? r.name}
													{r.scope.kind !== "org" ? " · 限定范围" : ""}
												</Badge>
											))}
										</span>
									) : null}
								</span>
								{m.status === "disabled" ? <Badge tone="danger">已停用</Badge> : null}
								{m.userId === selfId ? (
									<Badge>{ROLE_SHORT[`builtin:${base}`] ?? base}（你）</Badge>
								) : (
									<>
										{perms.org.has("role.assign") ? (
											<Select value={base} disabled={busy} aria-label={`${m.name} 的角色`} className="h-8 text-[13px]" onChange={(e) => run(() => patch(`/admin/members/${m.userId}`, { role: e.target.value }), "角色已更新")}>
												<option value="owner">所有者</option>
												<option value="admin">管理员</option>
												<option value="member">成员</option>
												<option value="guest">访客</option>
											</Select>
										) : (
											<Badge>{ROLE_SHORT[`builtin:${base}`] ?? base}</Badge>
										)}
										{perms.anywhere.has("member.disable") ? (
											m.status === "active" ? (
												<Button size="sm" disabled={busy} data-testid="member-disable" onClick={() => run(() => post(`/admin/members/${m.userId}/disable`), `已停用 ${m.name}，其全部会话已撤销`)}>
													<Ban />
													停用
												</Button>
											) : (
												<Button size="sm" disabled={busy} onClick={() => run(() => post(`/admin/members/${m.userId}/enable`), `已恢复 ${m.name}（旧会话仍保持撤销）`)}>
													<RotateCcw />
													恢复
												</Button>
											)
										) : null}
										{perms.org.has("member.remove") ? (
											<Button size="sm" variant="ghost" disabled={busy} onClick={() => confirm(`将 ${m.name} 移出组织？其项目成员关系、部门、会话与分享链接都会被移除。`) && run(() => del(`/admin/members/${m.userId}`), "已移出组织")}>
												<Trash2 />
												移出
											</Button>
										) : null}
									</>
								)}
								<Button size="sm" variant="ghost" data-testid="member-detail-open" onClick={() => setOpen(m.userId)}>
									<UserCog />
									详情
								</Button>
							</Row>
						</div>
					);
				})}
			</Table>
			<MemberDetail userId={open} selfId={selfId} onClose={() => setOpen(undefined)} onChanged={res.reload} />
		</Loadable>
	);
}
