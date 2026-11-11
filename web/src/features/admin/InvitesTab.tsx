// 邀请 tab.
import { Plus } from "lucide-react";
import { useState } from "react";
import type { DepartmentDTO, InviteDTO, OrgRole } from "@shared/ops";
import { del, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { fullTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge, Loadable } from "@/components/ui/misc";
import { ROLE, useAct, Table, Row } from "@/features/admin/common";
import { useConfirm } from "@/features/admin/confirm";
import { useViewerPerms } from "@/features/admin/rbac-ui";
import type { RoleDTO } from "@shared/permissions";

export function Invites() {
	const res = useApi<{ invites: InviteDTO[] }>("/admin/invites");
	const deps = useApi<{ departments: DepartmentDTO[] }>("/departments");
	const { busy, run, note } = useAct(res.reload);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<OrgRole | "guest">("member");
	const perms = useViewerPerms();
	const orgWide = perms.org.has("member.invite");
	const roleList = useApi<{ roles: RoleDTO[] }>(perms.anywhere.has("role.assign") ? "/admin/roles" : null);
	const [extraRole, setExtraRole] = useState("");
	const [dept, setDept] = useState("");
	const [ttl, setTtl] = useState(72);
	const [created, setCreated] = useState<string>();
	const { ask, dialog } = useConfirm();
	return (
		<div>
			<form
				className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-border bg-surface p-4"
				onSubmit={(e) => {
					e.preventDefault();
					void (async () => {
						if (role === "admin" && !(await ask({ title: "生成管理员邀请？", consequence: "拿到这个邀请码的人加入后会直接成为组织管理员，拥有除「变更组织所有者」以外的全部权限。", items: ["请只发给你信任的人，并设置较短的有效期", "邀请码可随时撤销"], confirmLabel: "生成邀请码", danger: true }))) return;
						await run(async () => {
						const r = await post<{ invite: InviteDTO }>("/admin/invites", { ...(email ? { email } : {}), role, ...(extraRole ? { roleId: extraRole } : {}), ...(dept ? { departmentId: dept } : {}), ttlHours: ttl });
						setCreated(r.invite.code);
						setEmail("");
						});
					})();
				}}
			>
				<Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="限定邮箱（可选）" type="email" className="h-8 w-56 text-sm" />
				<Select value={role} onChange={(e) => setRole(e.target.value as OrgRole | "guest")} className="h-8 text-sm" aria-label="基础角色">
					<option value="member">成员</option>
					<option value="guest">访客</option>
					{perms.org.has("role.assign") ? <option value="admin">管理员</option> : null}
				</Select>
				{roleList.data ? (
					<Select value={extraRole} onChange={(e) => setExtraRole(e.target.value)} className="h-8 max-w-[180px] text-sm" aria-label="附加角色">
						<option value="">无附加角色</option>
						{roleList.data.roles
							.filter((r) => !/^builtin:(owner|admin|member|guest)$/.test(r.id) && r.scopes.includes(dept ? "department" : "org"))
							.map((r) => (
								<option key={r.id} value={r.id}>
									附加：{r.name}
								</option>
							))}
					</Select>
				) : null}
				<Select value={dept} onChange={(e) => setDept(e.target.value)} className="h-8 text-sm" aria-label="部门">
					{orgWide ? <option value="">不加入部门</option> : <option value="">请选择部门</option>}
					{(deps.data?.departments ?? []).map((d) => (
						<option key={d.id} value={d.id}>
							{d.name}
						</option>
					))}
				</Select>
				<label className="flex items-center gap-1 text-xs text-fg-muted">
					有效
					<Input type="number" min={1} value={ttl} onChange={(e) => setTtl(Math.max(1, Number(e.target.value) || 1))} className="h-8 w-20 text-sm" />
					小时
				</label>
				<Button size="sm" variant="primary" type="submit" disabled={busy || (!orgWide && !dept)} data-testid="invite-create">
					<Plus />
					生成邀请码
				</Button>
			</form>
			{dialog}
			{created ? (
				<p className="mb-3 rounded-lg bg-info-soft px-3 py-2 text-sm text-info" data-testid="invite-link">
					邀请链接：<code className="break-all">{`${location.origin}/register?invite=${created}`}</code>
				</p>
			) : null}
			{note}
			<Loadable state={res} what="邀请">
				{(res.data?.invites ?? []).length === 0 ? (
					<p className="text-sm text-fg-muted">还没有邀请。</p>
				) : (
					<Table testId="admin-invites">
						{res.data!.invites.map((i) => (
							<div key={i.code}>
								<Row>
									<code className="text-xs">{i.code.slice(0, 10)}…</code>
									<span className="min-w-0 flex-1 text-xs text-fg-muted">
										{(i as InviteDTO & { roleName?: string }).roleName ?? ROLE[i.role]}
										{i.email ? ` · 限 ${i.email}` : ""} · 到期 {fullTime(i.expiresAt)}
									</span>
									{i.usedAt ? <Badge tone="success">已使用</Badge> : i.revokedAt ? <Badge>已撤销</Badge> : Date.parse(i.expiresAt) < Date.now() ? <Badge>已过期</Badge> : <Badge tone="info">有效</Badge>}
									{!i.usedAt && !i.revokedAt ? (
										<Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => del(`/admin/invites/${i.code}`), "邀请已撤销")}>
											撤销
										</Button>
									) : null}
								</Row>
							</div>
						))}
					</Table>
				)}
			</Loadable>
		</div>
	);
}
