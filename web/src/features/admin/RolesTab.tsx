// 角色与权限: role list (built-ins read-only) + grouped permission matrix with checkboxes; custom role create / edit / clone / delete.
import { Copy, Lock, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { RoleAssignmentDTO, RoleDTO } from "@shared/permissions";
import { del, patch, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Badge, Loadable } from "@/components/ui/misc";
import { useAct } from "@/features/admin/common";
import { LockedNote, PermissionMatrix, scopeText, useViewerPerms } from "@/features/admin/rbac-ui";

export function Roles() {
	const res = useApi<{ roles: RoleDTO[] }>("/admin/roles");
	const perms = useViewerPerms();
	const canManage = perms.org.has("role.manage");
	const [sel, setSel] = useState<string>();
	const roles = res.data?.roles ?? [];
	const current = roles.find((r) => r.id === sel) ?? roles[0];
	useEffect(() => {
		if (!sel && roles[0]) setSel(roles[0].id);
	}, [roles, sel]);
	const { busy, run, note } = useAct(res.reload);
	const [creating, setCreating] = useState(false);
	return (
		<Loadable state={res} what="角色" need="RBAC：GET /api/admin/roles">
			<div className="grid gap-4 md:grid-cols-[260px_minmax(0,1fr)]" data-testid="roles-tab">
				<div>
					<div className="mb-2 flex items-center">
						<h3 className="flex-1 text-[13px] font-medium text-fg-muted">角色</h3>
						{canManage ? (
							<Button size="sm" variant="primary" data-testid="role-new" onClick={() => (setCreating(true), setSel(undefined))}>
								<Plus />
								新建角色
							</Button>
						) : null}
					</div>
					<ul className="overflow-hidden rounded-xl border border-border bg-surface" data-testid="role-list">
						{(["内置角色", "自定义角色"] as const).map((title) => {
							const list = roles.filter((r) => (title === "内置角色" ? r.builtin : !r.builtin));
							return (
								<li key={title}>
									<div className="border-b border-border bg-surface-2/60 px-3 py-1 text-[11px] font-medium text-fg-subtle">{title}</div>
									{list.length === 0 ? <div className="px-3 py-2 text-xs text-fg-subtle">还没有自定义角色。</div> : null}
									<ul>
										{list.map((r) => (
											<li key={r.id}>
												<button type="button" data-testid="role-item" data-role={r.id} onClick={() => (setCreating(false), setSel(r.id))} className={cn("flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-[13px] hover:bg-surface-2/60", !creating && current?.id === r.id && "bg-surface-2")}>
													{r.builtin ? <Lock className="size-3.5 shrink-0 text-fg-subtle" /> : null}
													<span className="min-w-0 flex-1 truncate">{r.name}</span>
													<span className="text-xs text-fg-subtle">{r.assignmentCount} 处</span>
												</button>
											</li>
										))}
									</ul>
								</li>
							);
						})}
					</ul>
				</div>
				<div className="min-w-0">
					{note}
					{creating ? (
						<RoleEditor
							key="new"
							role={undefined}
							busy={busy}
							canManage={canManage}
							onSave={(v) =>
								run(async () => {
									const r = await post<{ role: RoleDTO }>("/admin/roles", v);
									setCreating(false);
									setSel(r.role.id);
								}, "角色已创建")
							}
						/>
					) : current ? (
						<RoleEditor
							key={current.id}
							role={current}
							busy={busy}
							canManage={canManage}
							onSave={(v) => run(() => patch(`/admin/roles/${current.id}`, v), "角色已保存")}
							onClone={() =>
								run(async () => {
									const r = await post<{ role: RoleDTO }>(`/admin/roles/${current.id}/clone`, {});
									setSel(r.role.id);
								}, "已克隆为自定义角色")
							}
							onDelete={() => confirm(`删除角色「${current.name}」？已分配的 ${current.assignmentCount} 处授权会一并移除。`) && run(async () => (await del(`/admin/roles/${current.id}`), setSel(undefined)), "角色已删除")}
						/>
					) : null}
				</div>
			</div>
		</Loadable>
	);
}

function RoleEditor({ role, busy, canManage, onSave, onClone, onDelete }: { role?: RoleDTO; busy: boolean; canManage: boolean; onSave: (v: { name: string; description: string; permissions: string[] }) => void; onClone?: () => void; onDelete?: () => void }) {
	const [name, setName] = useState(role?.name ?? "");
	const [desc, setDesc] = useState(role?.description ?? "");
	const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []));
	const mine = useViewerPerms();
	// Only permissions the editor holds themselves may be added (the server enforces the same rule).
	const restrict = useMemo(() => mine.org, [mine.org]);
	const readOnly = !!role?.builtin || !canManage;
	const assigned = useApi<{ assignments: RoleAssignmentDTO[] }>(role ? `/admin/role-assignments?roleId=${encodeURIComponent(role.id)}` : null);
	return (
		<div data-testid="role-editor" data-role={role?.id ?? "new"}>
			<div className="mb-3 flex flex-wrap items-center gap-2">
				{readOnly ? (
					<h3 className="flex-1 text-base font-semibold">{role?.name}</h3>
				) : (
					<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="角色名称" className="h-9 max-w-xs" data-testid="role-name" aria-label="角色名称" />
				)}
				{role?.builtin ? <Badge tone="info">内置 · 只读</Badge> : null}
				{role && canManage ? (
					<Button size="sm" disabled={busy} onClick={onClone} data-testid="role-clone">
						<Copy />
						克隆
					</Button>
				) : null}
				{role && !role.builtin && canManage ? (
					<Button size="sm" variant="ghost" disabled={busy} onClick={onDelete} data-testid="role-delete">
						<Trash2 />
						删除
					</Button>
				) : null}
				{!readOnly ? (
					<Button size="sm" variant="primary" disabled={busy || !name.trim()} data-testid="role-save" onClick={() => onSave({ name, description: desc, permissions: [...selected] })}>
						<Save />
						保存
					</Button>
				) : null}
			</div>
			{role?.builtin ? <LockedNote>内置角色随产品版本维护，不能修改。需要不同的权限组合时点「克隆」得到可编辑的自定义角色。{role.scopes.length === 1 && role.scopes[0] === "department" ? "此角色只能分配在部门范围。" : ""}</LockedNote> : null}
			{!role?.builtin ? (
				readOnly ? (
					<p className="mb-3 text-[13px] text-fg-muted">{role?.description}</p>
				) : (
					<Textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="角色说明（可选）" rows={2} className="mb-3" aria-label="角色说明" />
				)
			) : (
				<p className="mb-3 text-[13px] text-fg-muted">{role.description}</p>
			)}
			<PermissionMatrix selected={selected} onChange={setSelected} readOnly={readOnly} restrictTo={role?.builtin ? undefined : restrict} testId="perm-matrix" />
			{!readOnly ? <p className="mt-2 text-xs text-fg-subtle">只能勾选你自己拥有的权限（不得越权）；「变更组织所有者」不能放入自定义角色。</p> : null}
			{role ? (
				<section className="mt-5">
					<h4 className="mb-1.5 text-[13px] font-medium text-fg-muted">使用者（{assigned.data?.assignments.length ?? 0}）</h4>
					{assigned.data?.assignments.length ? (
						<ul className="flex flex-wrap gap-1.5" data-testid="role-users">
							{assigned.data.assignments.map((a) => (
								<li key={a.id}>
									<Badge title={scopeText(a.scope)}>
										{a.subject.kind === "department" ? "部门 · " : a.subject.kind === "group" ? "用户组 · " : ""}
										{a.subject.name ?? a.subject.id} @ {a.scope.kind === "org" ? "组织" : (a.scope.name ?? a.scope.id)}
									</Badge>
								</li>
							))}
						</ul>
					) : (
						<p className="text-xs text-fg-subtle">暂无（或你无权查看这些分配）。</p>
					)}
				</section>
			) : null}
		</div>
	);
}
