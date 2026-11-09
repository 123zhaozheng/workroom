// 邀请 tab.
import { Plus } from "lucide-react";
import { useState } from "react";
import type { DepartmentDTO, InviteDTO, OrgRole } from "@shared/ops";
import { del, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { fullTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Badge, Loadable } from "@/components/ui/misc";
import { ROLE, useAct, Table, Row } from "@/features/admin/common";

export function Invites() {
	const res = useApi<{ invites: InviteDTO[] }>("/admin/invites");
	const deps = useApi<{ departments: DepartmentDTO[] }>("/departments");
	const { busy, run, note } = useAct(res.reload);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<OrgRole>("member");
	const [dept, setDept] = useState("");
	const [ttl, setTtl] = useState(72);
	const [created, setCreated] = useState<string>();
	return (
		<div>
			<form
				className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-border bg-surface p-3"
				onSubmit={(e) => {
					e.preventDefault();
					void run(async () => {
						const r = await post<{ invite: InviteDTO }>("/admin/invites", { ...(email ? { email } : {}), role, ...(dept ? { departmentId: dept } : {}), ttlHours: ttl });
						setCreated(r.invite.code);
						setEmail("");
					});
				}}
			>
				<Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="限定邮箱（可选）" type="email" className="h-8 w-56 text-[13px]" />
				<Select value={role} onChange={(e) => setRole(e.target.value as OrgRole)} className="h-8 text-[13px]">
					<option value="member">成员</option>
					<option value="admin">管理员</option>
				</Select>
				<Select value={dept} onChange={(e) => setDept(e.target.value)} className="h-8 text-[13px]">
					<option value="">不加入部门</option>
					{(deps.data?.departments ?? []).map((d) => (
						<option key={d.id} value={d.id}>
							{d.name}
						</option>
					))}
				</Select>
				<label className="flex items-center gap-1 text-xs text-fg-muted">
					有效
					<Input type="number" min={1} value={ttl} onChange={(e) => setTtl(Math.max(1, Number(e.target.value) || 1))} className="h-8 w-20 text-[13px]" />
					小时
				</label>
				<Button size="sm" variant="primary" type="submit" disabled={busy} data-testid="invite-create">
					<Plus />
					生成邀请码
				</Button>
			</form>
			{created ? (
				<p className="mb-3 rounded-lg bg-info-soft px-3 py-2 text-[13px] text-info" data-testid="invite-link">
					邀请链接：<code className="break-all">{`${location.origin}/register?invite=${created}`}</code>
				</p>
			) : null}
			{note}
			<Loadable state={res} what="邀请" need="E 组：GET /api/admin/invites">
				{(res.data?.invites ?? []).length === 0 ? (
					<p className="text-[13px] text-fg-subtle">没有邀请。</p>
				) : (
					<Table testId="admin-invites">
						{res.data!.invites.map((i) => (
							<div key={i.code}>
								<Row>
									<code className="text-xs">{i.code.slice(0, 10)}…</code>
									<span className="min-w-0 flex-1 text-xs text-fg-muted">
										{ROLE[i.role]}
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
