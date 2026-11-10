// 成员详情 (drawer). Top to bottom: identity (+ base role) → roles → departments → effective permissions (collapsed, with 为什么) →
// sessions → account actions. Everything is read from and written to the RBAC API; the server decides.
// Granting high-risk permissions or roles, ownership changes, disabling and removing all ask first.
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
import { Fold, useAct } from "@/features/admin/common";
import { useConfirm } from "@/features/admin/confirm";
import { EffectiveView, ROLE_SHORT, RiskBadge, ScopePicker, baseRoleConfirm, groupLabel, permDesc, permLabel, roleGrantConfirm, rolePurpose, scopeText, useViewerPerms } from "@/features/admin/rbac-ui";

const BASE_OPTIONS: [string, string][] = [
	["owner", "组织所有者"],
	["admin", "组织管理员"],
	["member", "普通成员"],
	["guest", "访客"],
];
const AUTH_LABEL: Record<string, string> = { password: "密码登录", oidc: "企业登录", invite: "邀请加入" };

export function MemberDetail({ userId, selfId, onClose, onChanged }: { userId: string | undefined; selfId?: string; onClose: () => void; onChanged: () => void }) {
	return (
		<Sheet open={!!userId} onOpenChange={(o) => !o && onClose()} title="成员详情">
			{userId ? <DetailBody key={userId} userId={userId} selfId={selfId} onClose={onClose} onChanged={onChanged} /> : null}
		</Sheet>
	);
}

function H({ children, hint }: { children: string; hint?: string }) {
	return (
		<div className="mb-2 flex items-baseline gap-2">
			<h3 className="text-sm font-medium">{children}</h3>
			{hint ? <span className="text-xs text-fg-muted">{hint}</span> : null}
		</div>
	);
}

function DetailBody({ userId, selfId, onClose, onChanged }: { userId: string; selfId?: string; onClose: () => void; onChanged: () => void }) {
	const res = useApi<{ access: MemberAccessDTO }>(`/admin/members/${userId}/access`);
	const roles = useApi<{ roles: RoleDTO[] }>("/admin/roles");
	const viewer = useViewerPerms();
	const sessions = useApi<{ sessions: SessionDTO[] }>(viewer.org.has("member.session.manage") ? `/admin/sessions?userId=${userId}` : null);
	const { busy, run, note } = useAct(() => (res.reload(), onChanged(), sessions.reload()));
	const { ask, dialog } = useConfirm();
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
	const name = a?.name ?? "该成员";

	const changeBase = async (to: string) => {
		const c = baseRoleConfirm(name, baseKey, to);
		if (c && !(await ask(c))) return;
		await run(() => patch(`/admin/members/${userId}`, { role: to }), "基础角色已更新");
	};
	const assign = async () => {
		const role = assignable.find((r) => r.id === pickedRole);
		const c = roleGrantConfirm(name, role, scopeText(scope.kind === "org" ? { kind: "org" } : scope));
		if (c && !(await ask(c))) return;
		await run(() => post("/admin/role-assignments", { subject: { kind: "user", id: userId }, roleId: pickedRole, scope: scope.kind === "org" ? { kind: "org" } : scope }), "已授权");
	};
	const addGrant = async () => {
		if (effect === "allow" && permDef && permDef.risk !== "normal") {
			const ok = await ask({ title: `直接授予「${permLabel(permDef)}」？`, consequence: `${name} 将获得这项${permDef.risk === "critical" ? "高危" : "敏感"}权限，不依赖任何角色：${permDesc(permDef)}`, items: ["这条授权会写入审计日志", "可以随时在下方移除"], confirmLabel: "确认授予", danger: permDef.risk === "critical" });
			if (!ok) return;
		}
		await run(() => put(`/admin/members/${userId}/grants`, { permission: perm, effect, scope: gscope.kind === "org" ? { kind: "org" } : gscope, reason: reason || undefined }).then(() => setReason("")), effect === "deny" ? "已禁止" : "已授予");
	};
	const disable = async () => {
		if (await ask({ title: `停用 ${name}？`, consequence: `${name} 会立即退出所有登录设备，无法再登录；账号和数据保留，随时可以恢复。`, confirmLabel: "停用账号", danger: true })) await run(() => post(`/admin/members/${userId}/disable`), `已停用 ${name}，其全部登录已退出`);
	};
	const remove = async () => {
		if (await ask({ title: `将 ${name} 移出组织？`, consequence: `${name} 将失去对本组织的全部访问。`, items: ["角色、部门和项目成员关系会被清除", "TA 创建的分享链接会失效", "要回来需要重新邀请，之前的角色不会恢复"], confirmLabel: "移出组织", danger: true })) await run(async () => (await del(`/admin/members/${userId}`), onClose()), "已移出组织");
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="member-detail" data-user={userId}>
			<div className="flex items-start gap-3 border-b border-border px-5 py-4">
				<div className="min-w-0 flex-1">
					<h2 className="flex flex-wrap items-center gap-2 text-base font-semibold" data-testid="member-detail-name">
						<span className="truncate">{a?.name ?? "成员详情"}</span> {isSelf ? <Badge>你</Badge> : null}
						{a?.status === "disabled" ? <Badge tone="danger">已停用</Badge> : null}
					</h2>
					<p className="truncate text-sm text-fg-muted">{a?.email}</p>
				</div>
				<button type="button" aria-label="关闭" className="rounded-md p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg" onClick={onClose} data-testid="member-detail-close">
					<X className="size-4" />
				</button>
			</div>
			<div className="wr-scroll min-h-0 flex-1 space-y-7 overflow-y-auto px-5 py-5">
				{note}
				<Loadable state={res} what="成员权限">
					{a ? (
						<>
							<section aria-label="身份">
								<H>基础角色</H>
								<div className="flex flex-wrap items-center gap-2">
									<Select value={baseKey} disabled={busy || !a.can.assign} aria-label="基础角色" data-testid="detail-base-role" onChange={(e) => void changeBase(e.target.value)}>
										{BASE_OPTIONS.map(([v, l]) => (
											<option key={v} value={v}>
												{l}
											</option>
										))}
									</Select>
									{!a.can.assign ? <span className="text-xs text-fg-muted">你没有修改该成员角色的权限（或其权限高于你）。</span> : null}
								</div>
							</section>

							<section aria-label="角色">
								<H hint="在基础角色之上叠加，可限定范围">附加角色</H>
								<ul className="divide-y divide-border rounded-lg border border-border" data-testid="detail-roles">
									{a.assignments.map((x) => {
										const base = /^builtin:(owner|admin|member|guest)$/.test(x.roleId) && x.scope.kind === "org";
										return (
											<li key={x.id} data-testid="detail-role" data-role={x.roleId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
												<Badge tone={base ? "neutral" : "info"}>{ROLE_SHORT[x.roleId] ?? x.roleName ?? x.roleId}</Badge>
												<span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
													{scopeText(x.scope)}
													{x.via === "department" ? ` · 来自部门「${x.viaName}」` : x.via === "group" ? ` · 来自用户组「${x.viaName}」` : base ? " · 基础角色" : ""}
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
									<div className="mt-3 flex flex-wrap items-center gap-2" data-testid="detail-role-add">
										<ScopePicker value={scope} onChange={setScope} />
										<Select aria-label="角色" value={pickedRole} onChange={(e) => setRoleId(e.target.value)} data-testid="detail-role-pick" className="h-8 text-sm">
											{assignable.map((r) => (
												<option key={r.id} value={r.id}>
													{r.name}
												</option>
											))}
										</Select>
										<Button size="sm" disabled={busy || !pickedRole} data-testid="detail-role-assign" onClick={() => void assign()}>
											<Plus />
											授予角色
										</Button>
										{assignable.find((r) => r.id === pickedRole) ? <p className="basis-full text-xs text-fg-muted">{rolePurpose(assignable.find((r) => r.id === pickedRole)!)}</p> : null}
									</div>
								) : null}
								<div className="mt-3">
									<Fold title={`单独授权或禁止（${a.grants.length}）`} testId="detail-grants-fold" defaultOpen={a.grants.length > 0}>
										<p className="mb-2 text-xs text-fg-muted">只对这个人生效；「禁止」优先于任何角色，组织所有者不受影响。</p>
										{a.grants.length ? (
											<ul className="mb-3 divide-y divide-border rounded-lg border border-border" data-testid="detail-grants">
												{a.grants.map((g) => (
													<li key={g.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm" data-effect={g.effect}>
														<Badge tone={g.effect === "deny" ? "danger" : "success"}>{g.effect === "deny" ? "禁止" : "允许"}</Badge>
														<span className="min-w-0 flex-1 truncate" title={g.permission}>
															{PERMISSIONS.find((p) => p.id === g.permission) ? permLabel(PERMISSIONS.find((p) => p.id === g.permission)!) : g.permission}
															<span className="block text-xs text-fg-muted">
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
											<p className="mb-3 text-xs text-fg-muted">还没有单独授权或禁止。</p>
										)}
										{a.can.grant ? (
											<div className="flex flex-wrap items-center gap-2" data-testid="detail-grant-add">
												<Select value={effect} onChange={(e) => setEffect(e.target.value as "allow" | "deny")} className="h-8 text-sm" aria-label="效果" data-testid="grant-effect">
													<option value="deny">禁止</option>
													<option value="allow">允许</option>
												</Select>
												<Select value={perm} onChange={(e) => setPerm(e.target.value)} className="h-8 max-w-[220px] text-sm" aria-label="权限" data-testid="grant-perm">
													{PERMISSION_GROUPS.map((g) => (
														<optgroup key={g.id} label={groupLabel(g)}>
															{PERMISSIONS.filter((p) => p.group === g.id && p.id !== "org.owner.manage").map((p) => (
																<option key={p.id} value={p.id}>
																	{permLabel(p)}
																	{p.risk === "critical" ? "（高危）" : ""}
																</option>
															))}
														</optgroup>
													))}
												</Select>
												<ScopePicker value={gscope} onChange={setGscope} kinds={permDef?.scopes ?? ["org"]} />
												<Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="原因（可选，写入审计）" className="h-8 w-48 text-sm" aria-label="原因" />
												<Button size="sm" disabled={busy} data-testid="grant-add" onClick={() => void addGrant()}>
													<Plus />
													添加
												</Button>
												{permDef && permDef.risk !== "normal" ? (
													<span className="basis-full">
														<RiskBadge risk={permDef.risk} />
													</span>
												) : null}
											</div>
										) : null}
									</Fold>
								</div>
							</section>

							<section aria-label="部门">
								<H>所属部门</H>
								{a.departments.length === 0 ? (
									<p className="text-xs text-fg-muted">不属于任何部门。</p>
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

							<section aria-label="有效权限">
								<H hint="角色、部门和单独授权合在一起的结果">实际拥有的权限</H>
								<EffectiveView effective={a.effective} testId="detail-effective" collapsible />
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
								<section aria-label="登录会话">
									<H>登录设备</H>
									<ul className="divide-y divide-border rounded-lg border border-border" data-testid="detail-sessions">
										{(sessions.data?.sessions ?? []).length === 0 ? <li className="px-3 py-2 text-xs text-fg-muted">没有正在登录的设备。</li> : null}
										{(sessions.data?.sessions ?? []).map((s) => (
											<li key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
												<span className="min-w-0 flex-1 truncate">
													{AUTH_LABEL[s.authMethod] ?? s.authMethod} · {fullTime(s.createdAt)}
													{s.lastSeenAt ? ` · 最近 ${relTime(s.lastSeenAt)}` : ""}
												</span>
												{!s.current ? (
													<Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => del(`/admin/sessions/${s.id}`), "已退出该设备")}>
														退出
													</Button>
												) : (
													<Badge tone="info">当前设备</Badge>
												)}
											</li>
										))}
									</ul>
								</section>
							) : null}

							{!isSelf && (a.can.disable || a.can.remove) ? (
								<section className="flex flex-wrap gap-2 border-t border-border pt-5" aria-label="账号操作">
									{a.can.disable ? (
										a.status === "active" ? (
											<Button size="sm" disabled={busy} data-testid="detail-disable" onClick={() => void disable()}>
												<Ban />
												停用账号
											</Button>
										) : (
											<Button size="sm" disabled={busy} data-testid="detail-enable" onClick={() => run(() => post(`/admin/members/${userId}/enable`), "已恢复（之前的登录不会恢复，需要重新登录）")}>
												<RotateCcw />
												恢复账号
											</Button>
										)
									) : null}
									{a.can.remove ? (
										<Button size="sm" variant="danger" className="dark:text-[#2a0c09]" disabled={busy} data-testid="detail-remove" onClick={() => void remove()}>
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
			{dialog}
		</div>
	);
}
