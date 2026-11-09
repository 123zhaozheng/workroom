// 成员详情 (drawer): departments, roles (with scope and where they come from), direct grants / denies, effective permissions with
// "为什么" explanations, sessions, disable / remove. Everything is read from and written to the RBAC API; the server decides.
import { Ban, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { useState } from "react";
import { PERMISSION_GROUPS, PERMISSIONS, type MemberAccessDTO, type PermissionScopeKind, type RoleDTO } from "@shared/permissions";
import type { SessionDTO } from "@shared/ops";
import { del, patch, post, put } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { fullTime, relTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Sheet } from "@/components/ui/overlay";
import { Badge, Loadable } from "@/components/ui/misc";
import { useAct } from "@/features/admin/common";
import { EffectiveView, ROLE_SHORT, ScopePicker, scopeText, useViewerPerms } from "@/features/admin/rbac-ui";

const BASE_OPTIONS: [string, string][] = [
	["owner", "组织所有者"],
	["admin", "组织管理员"],
	["member", "普通成员"],
	["guest", "访客"],
];

export function MemberDetail({ userId, selfId, onClose, onChanged }: { userId: string | undefined; selfId?: string; onClose: () => void; onChanged: () => void }) {
	return (
		<Sheet open={!!userId} onOpenChange={(o) => !o && onClose()} title="成员详情">
			{userId ? <DetailBody key={userId} userId={userId} selfId={selfId} onClose={onClose} onChanged={onChanged} /> : null}
		</Sheet>
	);
}

function DetailBody({ userId, selfId, onClose, onChanged }: { userId: string; selfId?: string; onClose: () => void; onChanged: () => void }) {
	const res = useApi<{ access: MemberAccessDTO }>(`/admin/members/${userId}/access`);
	const roles = useApi<{ roles: RoleDTO[] }>("/admin/roles");
	const viewer = useViewerPerms();
	const sessions = useApi<{ sessions: SessionDTO[] }>(viewer.org.has("member.session.manage") ? `/admin/sessions?userId=${userId}` : null);
	const { busy, run, note } = useAct(() => (res.reload(), onChanged(), sessions.reload()));
	const a = res.data?.access;
	const baseId = a?.assignments.find((x) => x.via === "direct" && x.scope.kind === "org" && /^builtin:(owner|admin|member|guest)$/.test(x.roleId))?.roleId;
	const baseKey = baseId?.replace("builtin:", "") ?? "member";
	// add role
	const [roleId, setRoleId] = useState("");
	const [scope, setScope] = useState<{ kind: PermissionScopeKind; id: string }>({ kind: "org", id: "" });
	const assignable = (roles.data?.roles ?? []).filter((r) => !/^builtin:(owner|admin|member|guest)$/.test(r.id) && r.scopes.includes(scope.kind));
	const pickedRole = assignable.some((r) => r.id === roleId) ? roleId : (assignable[0]?.id ?? "");
	// add grant
	const [perm, setPerm] = useState("audit.view");
	const [effect, setEffect] = useState<"allow" | "deny">("deny");
	const [gscope, setGscope] = useState<{ kind: PermissionScopeKind; id: string }>({ kind: "org", id: "" });
	const [reason, setReason] = useState("");
	const permDef = PERMISSIONS.find((p) => p.id === perm);
	const isSelf = userId === selfId;
	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="member-detail" data-user={userId}>
			<div className="flex items-start gap-3 border-b border-border px-5 py-4">
				<div className="min-w-0 flex-1">
					<h2 className="truncate text-base font-semibold" data-testid="member-detail-name">
						{a?.name ?? "成员详情"} {isSelf ? <Badge>你</Badge> : null}
					</h2>
					<p className="truncate text-xs text-fg-subtle">
						{a?.email} {a?.status === "disabled" ? <Badge tone="danger">已停用</Badge> : null}
					</p>
				</div>
				<button type="button" aria-label="关闭" className="rounded-md p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg" onClick={onClose} data-testid="member-detail-close">
					<X className="size-4" />
				</button>
			</div>
			<div className="wr-scroll min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
				{note}
				<Loadable state={res} what="成员权限" need="RBAC：GET /api/admin/members/:id/access">
					{a ? (
						<>
							<section>
								<h3 className="mb-1.5 text-[13px] font-medium text-fg-muted">基础角色</h3>
								<div className="flex flex-wrap items-center gap-2">
									<Select value={baseKey} disabled={busy || !a.can.assign} aria-label="基础角色" data-testid="detail-base-role" className="h-8 text-[13px]" onChange={(e) => run(() => patch(`/admin/members/${userId}`, { role: e.target.value }), "基础角色已更新")}>
										{BASE_OPTIONS.map(([v, l]) => (
											<option key={v} value={v}>
												{l}
											</option>
										))}
									</Select>
									{!a.can.assign ? <span className="text-xs text-fg-subtle">你没有修改该成员角色的权限（或其权限高于你）。</span> : null}
								</div>
							</section>
							<section>
								<h3 className="mb-1.5 text-[13px] font-medium text-fg-muted">所属部门</h3>
								{a.departments.length === 0 ? (
									<p className="text-xs text-fg-subtle">不属于任何部门。</p>
								) : (
									<ul className="flex flex-wrap gap-1.5" data-testid="detail-depts">
										{a.departments.map((d) => (
											<li key={d.id}>
												<Badge title={d.path}>
													{d.path} · {d.role === "manager" ? "负责人" : "成员"}
												</Badge>
											</li>
										))}
									</ul>
								)}
							</section>
							<section>
								<h3 className="mb-1.5 text-[13px] font-medium text-fg-muted">角色与范围</h3>
								<ul className="divide-y divide-border rounded-lg border border-border" data-testid="detail-roles">
									{a.assignments.map((x) => {
										const base = /^builtin:(owner|admin|member|guest)$/.test(x.roleId) && x.scope.kind === "org";
										return (
											<li key={x.id} data-testid="detail-role" data-role={x.roleId} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-[13px]">
												<Badge tone={base ? "neutral" : "info"}>{ROLE_SHORT[x.roleId] ?? x.roleName ?? x.roleId}</Badge>
												<span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
													{scopeText(x.scope)}
													{x.via === "department" ? ` · 经部门「${x.viaName}」` : x.via === "group" ? ` · 经用户组「${x.viaName}」` : base ? " · 基础角色" : ""}
												</span>
												{x.via === "direct" && !base ? (
													<Button size="sm" variant="ghost" disabled={busy} data-testid="detail-role-revoke" onClick={() => run(() => del(`/admin/role-assignments/${x.id}`), "已撤销")}>
														<Trash2 />
														撤销
													</Button>
												) : null}
											</li>
										);
									})}
								</ul>
								{a.can.assign ? (
									<div className="mt-2 flex flex-wrap items-center gap-2" data-testid="detail-role-add">
										<ScopePicker value={scope} onChange={setScope} />
										<Select aria-label="角色" value={pickedRole} className="h-8 text-[13px]" onChange={(e) => setRoleId(e.target.value)} data-testid="detail-role-pick">
											{assignable.map((r) => (
												<option key={r.id} value={r.id}>
													{r.name}
												</option>
											))}
										</Select>
										<Button size="sm" disabled={busy || !pickedRole} data-testid="detail-role-assign" onClick={() => run(() => post("/admin/role-assignments", { subject: { kind: "user", id: userId }, roleId: pickedRole, scope: scope.kind === "org" ? { kind: "org" } : scope }), "已授权")}>
											<Plus />
											授予角色
										</Button>
									</div>
								) : null}
							</section>
							<section>
								<h3 className="mb-1 text-[13px] font-medium text-fg-muted">直接授权 / 禁止</h3>
								<p className="mb-1.5 text-xs text-fg-subtle">对个人单独允许或禁止某项权限；禁止优先于任何角色。组织所有者不受影响。</p>
								{a.grants.length ? (
									<ul className="mb-2 divide-y divide-border rounded-lg border border-border" data-testid="detail-grants">
										{a.grants.map((g) => (
											<li key={g.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-[13px]" data-effect={g.effect}>
												<Badge tone={g.effect === "deny" ? "danger" : "success"}>{g.effect === "deny" ? "禁止" : "允许"}</Badge>
												<span className="min-w-0 flex-1 truncate">
													{PERMISSIONS.find((p) => p.id === g.permission)?.label ?? g.permission} <code className="text-[11px] text-fg-subtle">{g.permission}</code>
													<span className="block text-xs text-fg-subtle">
														{scopeText(g.scope)}
														{g.reason ? ` · ${g.reason}` : ""}
													</span>
												</span>
												{a.can.grant ? (
													<Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => del(`/admin/members/${userId}/grants/${g.id}`), "已移除")}>
														<Trash2 />
														移除
													</Button>
												) : null}
											</li>
										))}
									</ul>
								) : (
									<p className="mb-2 text-xs text-fg-subtle">没有直接授权或禁止。</p>
								)}
								{a.can.grant ? (
									<div className="flex flex-wrap items-center gap-2" data-testid="detail-grant-add">
										<Select value={effect} onChange={(e) => setEffect(e.target.value as "allow" | "deny")} className="h-8 text-[13px]" aria-label="效果" data-testid="grant-effect">
											<option value="deny">禁止</option>
											<option value="allow">允许</option>
										</Select>
										<Select
											value={perm}
											onChange={(e) => setPerm(e.target.value)}
											className="h-8 max-w-[220px] text-[13px]"
											aria-label="权限"
											data-testid="grant-perm"
										>
											{PERMISSION_GROUPS.map((g) => (
												<optgroup key={g.id} label={g.label}>
													{PERMISSIONS.filter((p) => p.group === g.id && p.id !== "org.owner.manage").map((p) => (
														<option key={p.id} value={p.id}>
															{p.label}
														</option>
													))}
												</optgroup>
											))}
										</Select>
										<ScopePicker value={gscope} onChange={setGscope} kinds={permDef?.scopes ?? ["org"]} />
										<Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="原因（可选，写入审计）" className="h-8 w-48 text-[13px]" aria-label="原因" />
										<Button size="sm" disabled={busy} data-testid="grant-add" onClick={() => run(() => put(`/admin/members/${userId}/grants`, { permission: perm, effect, scope: gscope.kind === "org" ? { kind: "org" } : gscope, reason: reason || undefined }).then(() => setReason("")), effect === "deny" ? "已禁止" : "已授予")}>
											<Plus />
											添加
										</Button>
									</div>
								) : null}
							</section>
							<section>
								<h3 className="mb-1.5 text-[13px] font-medium text-fg-muted">有效权限（组织范围）</h3>
								<EffectiveView effective={a.effective} testId="detail-effective" />
								{a.scoped.length ? (
									<div className="mt-3 text-xs" data-testid="detail-scoped">
										<h4 className="mb-1 font-medium text-fg-muted">仅在特定范围内拥有</h4>
										<ul className="space-y-1">
											{a.scoped.map((s, i) => (
												<li key={i} className="rounded-lg bg-surface-2 px-2.5 py-1.5">
													<span className="font-medium">{scopeText(s.scope)}</span>：{s.permissions.map((p) => PERMISSIONS.find((x) => x.id === p)?.label ?? p).join("、")}
												</li>
											))}
										</ul>
									</div>
								) : null}
							</section>
							{viewer.org.has("member.session.manage") ? (
								<section>
									<h3 className="mb-1.5 text-[13px] font-medium text-fg-muted">登录会话</h3>
									<ul className="divide-y divide-border rounded-lg border border-border" data-testid="detail-sessions">
										{(sessions.data?.sessions ?? []).length === 0 ? <li className="px-3 py-2 text-xs text-fg-subtle">没有有效会话。</li> : null}
										{(sessions.data?.sessions ?? []).map((s) => (
											<li key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
												<span className="min-w-0 flex-1 truncate">
													{s.authMethod} · {fullTime(s.createdAt)}
													{s.lastSeenAt ? ` · 最近 ${relTime(s.lastSeenAt)}` : ""}
												</span>
												{!s.current ? (
													<Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => del(`/admin/sessions/${s.id}`), "会话已撤销")}>
														撤销
													</Button>
												) : (
													<Badge tone="info">当前会话</Badge>
												)}
											</li>
										))}
									</ul>
								</section>
							) : null}
							{!isSelf && (a.can.disable || a.can.remove) ? (
								<section className="flex flex-wrap gap-2 border-t border-border pt-4">
									{a.can.disable ? (
										a.status === "active" ? (
											<Button size="sm" disabled={busy} data-testid="detail-disable" onClick={() => run(() => post(`/admin/members/${userId}/disable`), `已停用 ${a.name}，其全部会话已撤销`)}>
												<Ban />
												停用账号
											</Button>
										) : (
											<Button size="sm" disabled={busy} onClick={() => run(() => post(`/admin/members/${userId}/enable`), "已恢复（旧会话仍保持撤销）")}>
												<RotateCcw />
												恢复账号
											</Button>
										)
									) : null}
									{a.can.remove ? (
										<Button size="sm" variant="danger" disabled={busy} data-testid="detail-remove" onClick={() => confirm(`将 ${a.name} 移出组织？其角色、项目成员关系、部门、会话与分享链接都会被移除。`) && run(async () => (await del(`/admin/members/${userId}`), onClose()), "已移出组织")}>
											<Trash2 />
											移出组织
										</Button>
									) : null}
								</section>
							) : null}
						</>
					) : null}
				</Loadable>
			</div>
		</div>
	);
}
