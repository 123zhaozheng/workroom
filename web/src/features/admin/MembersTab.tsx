// 成员: searchable list (name, email, departments, roles, status). Row actions live in the 详情 drawer and the 更多 menu.
// Disabling and removing always ask first and say what will happen.
import { Ban, MoreHorizontal, RotateCcw, Search, Trash2, UserCog } from "lucide-react";
import { useMemo, useState } from "react";
import type { MemberDTO } from "@shared/ops";
import { del, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { relTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/overlay";
import { Badge, EmptyState, Loadable } from "@/components/ui/misc";
import { Row, Table, useAct } from "@/features/admin/common";
import { useConfirm } from "@/features/admin/confirm";
import { MemberDetail } from "@/features/admin/MemberDetail";
import { ROLE_SHORT, scopeText, useDepartments, useViewerPerms } from "@/features/admin/rbac-ui";

type MemberRow = MemberDTO & { roles?: { roleId: string; name: string; scope: { kind: "org" | "department" | "project"; id?: string } }[] };
const BASE = /^builtin:(owner|admin|member|guest)$/;

export function Members({ selfId }: { selfId?: string }) {
	const res = useApi<{ members: MemberRow[] }>("/admin/members");
	const deps = useDepartments();
	const perms = useViewerPerms();
	const { busy, run, note } = useAct(res.reload);
	const { ask, dialog } = useConfirm();
	const [open, setOpen] = useState<string>();
	const [q, setQ] = useState("");
	const orgWide = perms.org.has("member.view");
	const depName = useMemo(() => new Map((deps.data?.departments ?? []).map((d) => [d.id, d.name])), [deps.data]);
	const all = res.data?.members ?? [];
	const rows = all.filter((m) => !q.trim() || `${m.name} ${m.email}`.toLowerCase().includes(q.trim().toLowerCase()));
	const disable = async (m: MemberRow) => {
		if (await ask({ title: `停用 ${m.name}？`, consequence: `${m.name} 会立即退出所有登录设备，无法再登录；账号和数据保留，随时可以恢复。`, confirmLabel: "停用", danger: true })) await run(() => post(`/admin/members/${m.userId}/disable`), `已停用 ${m.name}，其全部登录已退出`);
	};
	const remove = async (m: MemberRow) => {
		if (await ask({ title: `将 ${m.name} 移出组织？`, consequence: `${m.name} 将失去对本组织的全部访问。`, items: ["角色、部门和项目成员关系会被清除", "TA 创建的分享链接会失效", "要回来需要重新邀请，之前的角色不会恢复"], confirmLabel: "移出组织", danger: true })) await run(() => del(`/admin/members/${m.userId}`), "已移出组织");
	};
	return (
		<Loadable state={res} what="成员">
			{note}
			{!orgWide ? <p className="mb-3 text-xs text-fg-muted">你只能看到自己所管理部门范围内的成员。</p> : null}
			<div className="mb-3 flex flex-wrap items-center gap-3">
				<div className="relative w-full max-w-xs">
					<Search aria-hidden className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-fg-subtle" />
					<Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索姓名或邮箱" aria-label="搜索成员" className="pl-8" />
				</div>
				<span className="text-xs text-fg-muted">{all.length} 人</span>
			</div>
			{rows.length === 0 ? (
				<EmptyState icon={<Search />} title="没有找到成员" />
			) : (
				<Table testId="admin-members">
					{rows.map((m) => {
						const base = m.roles?.find((r) => r.scope.kind === "org" && BASE.test(r.roleId))?.roleId.replace("builtin:", "") ?? m.role;
						const extra = (m.roles ?? []).filter((r) => !(r.scope.kind === "org" && BASE.test(r.roleId)));
						const depts = m.departmentIds.map((id) => depName.get(id)).filter(Boolean).join("、");
						return (
							<div key={m.userId} data-testid="admin-member" data-status={m.status}>
								<Row>
									<span className="min-w-0 flex-1 basis-56">
										<span className="flex flex-wrap items-center gap-1.5">
											<button type="button" className="max-w-full truncate rounded text-left font-medium hover:underline" data-testid="member-open" onClick={() => setOpen(m.userId)}>
												{m.name}
											</button>
											{m.userId === selfId ? <Badge>你</Badge> : null}
											{m.status === "disabled" ? <Badge tone="danger">已停用</Badge> : null}
										</span>
										<span className="block truncate text-xs text-fg-muted">
											{m.email}
											{depts ? ` · ${depts}` : ""}
											{m.lastSeenAt ? ` · 最近活跃 ${relTime(m.lastSeenAt)}` : ""}
										</span>
									</span>
									<span className="flex flex-wrap items-center gap-1">
										<Badge>{ROLE_SHORT[`builtin:${base}`] ?? base}</Badge>
										{extra.map((r, i) => (
											<Badge key={i} tone="info" title={scopeText(r.scope)}>
												{ROLE_SHORT[r.roleId] ?? r.name}
												{r.scope.kind !== "org" ? " · 限定范围" : ""}
											</Badge>
										))}
									</span>
									<Button size="sm" data-testid="member-detail-open" onClick={() => setOpen(m.userId)}>
										<UserCog />
										详情
									</Button>
									{m.userId !== selfId && (perms.anywhere.has("member.disable") || perms.org.has("member.remove")) ? (
										<Menu>
											<MenuTrigger asChild>
												<Button size="icon" variant="ghost" aria-label={`${m.name} 的更多操作`} data-testid="member-more">
													<MoreHorizontal />
												</Button>
											</MenuTrigger>
											<MenuContent align="end">
												{perms.anywhere.has("member.disable") ? (
													m.status === "active" ? (
														<MenuItem data-testid="member-disable" disabled={busy} onSelect={() => void disable(m)}>
															<Ban />
															停用账号
														</MenuItem>
													) : (
														<MenuItem data-testid="member-enable" disabled={busy} onSelect={() => void run(() => post(`/admin/members/${m.userId}/enable`), `已恢复 ${m.name}（之前的登录不会恢复，需要重新登录）`)}>
															<RotateCcw />
															恢复账号
														</MenuItem>
													)
												) : null}
												{perms.org.has("member.remove") ? (
													<MenuItem data-testid="member-remove" className="text-danger data-[highlighted]:bg-danger-soft [&_svg]:!text-danger" disabled={busy} onSelect={() => void remove(m)}>
														<Trash2 />
														移出组织
													</MenuItem>
												) : null}
											</MenuContent>
										</Menu>
									) : null}
								</Row>
							</div>
						);
					})}
				</Table>
			)}
			<MemberDetail userId={open} selfId={selfId} onClose={() => setOpen(undefined)} onChanged={res.reload} />
			{dialog}
		</Loadable>
	);
}
