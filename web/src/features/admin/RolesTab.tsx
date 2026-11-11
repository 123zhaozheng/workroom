// 角色: the default view is the role list, grouped by how roles combine (base roles → add-on roles → custom roles) with one line
// of purpose each. Opening a role shows its permissions as a grouped, collapsible matrix. Built-ins are read-only (clone to edit).
// Saving a role that gains high-risk permissions, and deleting a role, ask first.
import { ArrowLeft, ChevronRight, Copy, Lock, Plus, Save, ShieldAlert, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { RoleAssignmentDTO, RoleDTO } from "@shared/permissions";
import { del, patch, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Badge, Loadable } from "@/components/ui/misc";
import { Help, useAct } from "@/features/admin/common";
import { useConfirm } from "@/features/admin/confirm";
import { LockedNote, PermissionMatrix, ROLE_ORDER, criticalOf, isBaseRole, permDesc, permLabel, rolePurpose, scopeText, useViewerPerms } from "@/features/admin/rbac-ui";

export function Roles() {
	const res = useApi<{ roles: RoleDTO[] }>("/admin/roles");
	const perms = useViewerPerms();
	const canManage = perms.org.has("role.manage");
	const [sel, setSel] = useState<string>();
	const [creating, setCreating] = useState(false);
	const { busy, run, note } = useAct(res.reload);
	const { ask, dialog } = useConfirm();
	const roles = res.data?.roles ?? [];
	const current = roles.find((r) => r.id === sel);
	const sections = useMemo(() => {
		const byOrder = (a: RoleDTO, b: RoleDTO) => ROLE_ORDER.indexOf(a.id) - ROLE_ORDER.indexOf(b.id);
		return [
			{ title: "基础角色", hint: "每位成员有且仅有一个。", list: roles.filter((r) => isBaseRole(r.id)).sort(byOrder) },
			{ title: "附加角色", hint: "叠加在基础角色之上，可限定到部门或项目。", list: roles.filter((r) => r.builtin && !isBaseRole(r.id)).sort(byOrder) },
			{ title: "自定义角色", hint: "由你的组织定义；内置角色不能修改，克隆后可编辑。", list: roles.filter((r) => !r.builtin) },
		];
	}, [roles]);

	if (creating || current)
		return (
			<Loadable state={res} what="角色">
				<div data-testid="roles-tab">
					<Button size="sm" variant="ghost" className="mb-3 -ml-2" data-testid="role-back" onClick={() => (setCreating(false), setSel(undefined))}>
						<ArrowLeft />
						全部角色
					</Button>
					{note}
					<RoleEditor
						key={creating ? "new" : current!.id}
						role={creating ? undefined : current}
						busy={busy}
						canManage={canManage}
						ask={ask}
						onSave={(v) =>
							creating
								? run(async () => {
										const r = await post<{ role: RoleDTO }>("/admin/roles", v);
										setCreating(false);
										setSel(r.role.id);
									}, "角色已创建")
								: run(() => patch(`/admin/roles/${current!.id}`, v), "角色已保存")
						}
						onClone={() =>
							run(async () => {
								const r = await post<{ role: RoleDTO }>(`/admin/roles/${current!.id}/clone`, {});
								setSel(r.role.id);
							}, "已克隆为自定义角色")
						}
						onDelete={async () => {
							if (await ask({ title: `删除角色「${current!.name}」？`, consequence: current!.assignmentCount ? `已经授予这个角色的 ${current!.assignmentCount} 处授权会一并移除，相关成员会立即失去这些权限。` : "这个角色还没有被授予任何人。", confirmLabel: "删除角色", danger: true })) await run(async () => (await del(`/admin/roles/${current!.id}`), setSel(undefined)), "角色已删除");
						}}
					/>
					{dialog}
				</div>
			</Loadable>
		);

	return (
		<Loadable state={res} what="角色">
			<div data-testid="roles-tab" className="space-y-6">
				{canManage ? (
					<div className="flex justify-end">
						<Button size="sm" variant="primary" data-testid="role-new" onClick={() => setCreating(true)}>
							<Plus />
							新建角色
						</Button>
					</div>
				) : null}
				{sections.map((s) => (
					<section key={s.title}>
						<div className="mb-2 flex items-baseline gap-2">
							<h3 className="text-sm font-medium">{s.title}</h3>
							<Help label={`${s.title}说明`} side="top">{s.hint}</Help>
						</div>
						{s.list.length === 0 ? (
							<p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-fg-muted">还没有自定义角色</p>
						) : (
							<ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface" data-testid={s.title === "基础角色" ? "role-list" : undefined}>
								{s.list.map((r) => {
									const risky = criticalOf(r.permissions).length;
									return (
										<li key={r.id}>
											<button type="button" data-testid="role-item" data-role={r.id} onClick={() => setSel(r.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2/60">
												<span className="min-w-0 flex-1">
													<span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
														{r.builtin ? <Lock aria-label="内置" className="size-3.5 text-fg-subtle" /> : null}
														{r.name}
														{r.id !== "builtin:owner" && r.id !== "builtin:admin" && risky ? (
															<Badge tone="danger">
																<ShieldAlert aria-hidden />含高危
															</Badge>
														) : null}
													</span>
													<span className="block text-xs text-fg-muted">{rolePurpose(r)}</span>
												</span>
												<span className="hidden shrink-0 text-xs text-fg-muted sm:block">
													{r.permissions.length} 项权限 · {r.assignmentCount} 处使用
												</span>
												<ChevronRight aria-hidden className="size-4 shrink-0 text-fg-subtle" />
											</button>
										</li>
									);
								})}
							</ul>
						)}
					</section>
				))}
			</div>
		</Loadable>
	);
}

function RoleEditor({ role, busy, canManage, ask, onSave, onClone, onDelete }: { role?: RoleDTO; busy: boolean; canManage: boolean; ask: ReturnType<typeof useConfirm>["ask"]; onSave: (v: { name: string; description: string; permissions: string[] }) => void; onClone?: () => void; onDelete?: () => void }) {
	const [name, setName] = useState(role?.name ?? "");
	const [desc, setDesc] = useState(role?.description ?? "");
	const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []));
	const mine = useViewerPerms();
	// Only permissions the editor holds themselves may be added (the server enforces the same rule).
	const restrict = useMemo(() => mine.org, [mine.org]);
	const readOnly = !!role?.builtin || !canManage;
	const assigned = useApi<{ assignments: RoleAssignmentDTO[] }>(role ? `/admin/role-assignments?roleId=${encodeURIComponent(role.id)}` : null);
	const save = async () => {
		const before = new Set(role?.permissions ?? []);
		const added = criticalOf(selected).filter((p) => !before.has(p.id));
		if (added.length) {
			const ok = await ask({ title: "保存包含高危权限的角色？", consequence: role?.assignmentCount ? `现在拥有「${name}」的 ${role.assignmentCount} 处授权会立刻获得：` : `之后被授予「${name}」的人会获得：`, items: added.map((p) => `${permLabel(p)}：${permDesc(p)}`), confirmLabel: "确认保存", danger: true });
			if (!ok) return;
		}
		onSave({ name, description: desc, permissions: [...selected] });
	};
	return (
		<div data-testid="role-editor" data-role={role?.id ?? "new"}>
			<div className="mb-3 flex flex-wrap items-center gap-2">
				{readOnly ? <h3 className="min-w-0 flex-1 text-base font-semibold">{role?.name}</h3> : <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="角色名称" className="max-w-xs" data-testid="role-name" aria-label="角色名称" />}
				{role?.builtin ? <Badge tone="info">内置 · 只读</Badge> : null}
				<span className="flex-1" />
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
					<Button size="sm" variant="primary" disabled={busy || !name.trim()} data-testid="role-save" onClick={() => void save()}>
						<Save />
						保存
					</Button>
				) : null}
			</div>
			{role?.builtin ? <LockedNote>内置角色不能修改，可克隆后编辑。{role.scopes.length === 1 && role.scopes[0] === "department" ? "只能授予在部门范围。" : ""}</LockedNote> : null}
			{role ? <p className="mb-4 text-sm text-fg-muted">{rolePurpose(role)}</p> : null}
			{!role?.builtin && !readOnly ? <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="一句话说明这个角色做什么（可选）" rows={2} className="mb-4" aria-label="角色说明" /> : null}
			<PermissionMatrix selected={selected} onChange={setSelected} readOnly={readOnly} restrictTo={role?.builtin ? undefined : restrict} testId="perm-matrix" />
						{role ? (
				<section className="mt-6">
					<h4 className="mb-2 text-sm font-medium">使用者（{assigned.data?.assignments.length ?? 0}）</h4>
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
						<p className="text-xs text-fg-muted">暂无</p>
					)}
				</section>
			) : null}
		</div>
	);
}
