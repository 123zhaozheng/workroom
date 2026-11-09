// 授权: who holds which role where. Assign roles to users / departments / user groups with a scope (org, department + sub-departments, project).
import { Plus, Trash2, Users } from "lucide-react";
import { useMemo, useState } from "react";
import type { PermissionScopeKind, RoleAssignmentDTO, RoleDTO } from "@shared/permissions";
import type { MemberDTO } from "@shared/ops";
import { del, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Badge, EmptyState, Loadable } from "@/components/ui/misc";
import { Row, Table, useAct } from "@/features/admin/common";
import { GroupsPanel } from "@/features/admin/GroupsPanel";
import { ROLE_SHORT, ScopePicker, deptTreeOptions, scopeText, useDepartments, useViewerPerms } from "@/features/admin/rbac-ui";

type SubjectKind = "user" | "department" | "group";
const SUBJECT_LABEL: Record<SubjectKind, string> = { user: "成员", department: "部门（含子部门成员）", group: "用户组" };

export function Authorizations() {
	const roles = useApi<{ roles: RoleDTO[] }>("/admin/roles");
	const list = useApi<{ assignments: RoleAssignmentDTO[] }>("/admin/role-assignments");
	const members = useApi<{ members: MemberDTO[] }>("/admin/members");
	const groups = useApi<{ groups: { id: string; name: string }[] }>("/admin/groups");
	const deps = useDepartments();
	const perms = useViewerPerms();
	const { busy, run, note } = useAct(() => {
		list.reload();
		roles.reload();
	});
	const [kind, setKind] = useState<SubjectKind>("user");
	const [subject, setSubject] = useState("");
	const [roleId, setRoleId] = useState("builtin:skill_reviewer");
	const [scope, setScope] = useState<{ kind: PermissionScopeKind; id: string }>({ kind: "org", id: "" });
	const [filter, setFilter] = useState("");
	const allRoles = roles.data?.roles ?? [];
	// Roles that make sense at the chosen scope kind; base roles are changed on the member detail page.
	const usable = allRoles.filter((r) => !r.id.match(/^builtin:(owner|admin|member|guest)$/) && r.scopes.includes(scope.kind));
	const role = usable.find((r) => r.id === roleId) ?? usable[0];
	const subjects: { id: string; name: string }[] =
		kind === "user" ? (members.data?.members ?? []).map((m) => ({ id: m.userId, name: `${m.name}（${m.email}）` })) : kind === "department" ? deptTreeOptions(deps.data?.departments ?? []).map((d) => ({ id: d.id, name: `${"　".repeat(d.depth)}${d.label}` })) : (groups.data?.groups ?? []).map((g) => ({ id: g.id, name: g.name }));
	const rows = useMemo(() => (list.data?.assignments ?? []).filter((a) => !(a.roleId.match(/^builtin:(owner|admin|member|guest)$/) && a.scope.kind === "org")).filter((a) => !filter || `${a.subject.name} ${a.roleName} ${scopeText(a.scope)}`.toLowerCase().includes(filter.toLowerCase())), [list.data, filter]);
	return (
		<div data-testid="authz-tab">
			{perms.anywhere.has("role.assign") ? (
				<form
					className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-border bg-surface p-3"
					data-testid="authz-form"
					onSubmit={(e) => {
						e.preventDefault();
						const sid = subject || subjects[0]?.id;
						if (!sid || !role) return;
						void run(() => post("/admin/role-assignments", { subject: { kind, id: sid }, roleId: role.id, scope: scope.kind === "org" ? { kind: "org" } : scope }), "已授权");
					}}
				>
					<label className="text-xs text-fg-muted">
						授予谁
						<span className="mt-1 flex gap-1.5">
							<Select aria-label="主体类型" value={kind} className="h-8 text-[13px]" onChange={(e) => (setKind(e.target.value as SubjectKind), setSubject(""))}>
								{(Object.keys(SUBJECT_LABEL) as SubjectKind[]).map((k) => (
									<option key={k} value={k}>
										{SUBJECT_LABEL[k]}
									</option>
								))}
							</Select>
							<Select aria-label="主体" data-testid="authz-subject" value={subject || subjects[0]?.id || ""} className="h-8 max-w-[220px] text-[13px]" onChange={(e) => setSubject(e.target.value)}>
								{subjects.length === 0 ? <option value="">（没有可选项）</option> : null}
								{subjects.map((s) => (
									<option key={s.id} value={s.id}>
										{s.name}
									</option>
								))}
							</Select>
						</span>
					</label>
					<label className="text-xs text-fg-muted">
						范围
						<span className="mt-1 block">
							<ScopePicker value={scope} onChange={setScope} testId="authz-scope" />
						</span>
					</label>
					<label className="text-xs text-fg-muted">
						角色
						<span className="mt-1 block">
							<Select aria-label="角色" data-testid="authz-role" value={role?.id ?? ""} className="h-8 text-[13px]" onChange={(e) => setRoleId(e.target.value)}>
								{usable.map((r) => (
									<option key={r.id} value={r.id}>
										{r.name}
										{r.builtin ? "" : "（自定义）"}
									</option>
								))}
							</Select>
						</span>
					</label>
					<Button size="sm" variant="primary" type="submit" disabled={busy || !role || subjects.length === 0} data-testid="authz-assign">
						<Plus />
						授权
					</Button>
				</form>
			) : null}
			{note}
			<p className="mb-3 text-xs text-fg-subtle">
				角色可以授予个人、整个部门（含子部门成员）或用户组，范围可以是整个组织、某个部门（含子部门）或某个项目。成员的「基础角色」（所有者 / 管理员 / 普通成员 / 访客）在成员详情里修改。你只能授予你自己拥有的权限。
				{scope.kind === "project" ? "项目范围目前只能从你所在的项目里选择。" : ""}
			</p>
			<div className="mb-2 flex items-center gap-2">
				<Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="筛选：姓名 / 角色 / 范围" className="h-8 max-w-xs text-[13px]" aria-label="筛选授权" />
				<span className="text-xs text-fg-subtle">{rows.length} 条</span>
			</div>
			<Loadable state={list} what="授权" need="RBAC：GET /api/admin/role-assignments">
				{rows.length === 0 ? (
					<EmptyState icon={<Users />} title="还没有额外授权">
						除基础角色外，被授予其他角色（如部门管理员、技能审核员、自定义角色）的人会出现在这里。
					</EmptyState>
				) : (
					<Table testId="authz-list">
						{rows.map((a) => (
							<div key={a.id} data-testid="authz-row">
								<Row>
									<span className="min-w-0 flex-1">
										<span className="block truncate font-medium">
											{a.subject.kind === "department" ? <Badge className="mr-1">部门</Badge> : a.subject.kind === "group" ? <Badge className="mr-1">用户组</Badge> : null}
											{a.subject.name ?? a.subject.id}
										</span>
										<span className="block truncate text-xs text-fg-subtle">{scopeText(a.scope)}</span>
									</span>
									<Badge tone="info">{ROLE_SHORT[a.roleId] ?? a.roleName ?? a.roleId}</Badge>
									{perms.anywhere.has("role.assign") ? (
										<Button size="sm" variant="ghost" disabled={busy} data-testid="authz-revoke" onClick={() => run(() => del(`/admin/role-assignments/${a.id}`), "已撤销")}>
											<Trash2 />
											撤销
										</Button>
									) : null}
								</Row>
							</div>
						))}
					</Table>
				)}
			</Loadable>
			<GroupsPanel onChanged={groups.reload} />
		</div>
	);
}
