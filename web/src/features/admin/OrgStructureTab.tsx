// 组织架构: department tree (create / rename / move by drag or menu / delete), members per department, department heads and
// department admins (who manage only their own subtree). The server decides what each viewer may do; `can` only drives the UI.
import { ChevronDown, ChevronRight, GripVertical, Network, Plus, Trash2, UserCog } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { DepartmentMemberDTO, MemberDTO } from "@shared/ops";
import { del, patch, post, put } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge, EmptyState, Loadable } from "@/components/ui/misc";
import { Help, useAct } from "@/features/admin/common";
import { useConfirm } from "@/features/admin/confirm";
import { useViewerPerms } from "@/features/admin/rbac-ui";

interface DeptNode {
	id: string;
	name: string;
	parentId?: string;
	memberCount: number;
	heads: { userId: string; name: string }[];
	admins: { assignmentId: string; userId: string; name: string }[];
	can: { manage: boolean; members: boolean; assign: boolean; view: boolean };
}
interface Overview {
	departments: DeptNode[];
	canCreateRoot: boolean;
}

export function OrgStructure() {
	const res = useApi<Overview>("/admin/departments/overview");
	const members = useApi<{ members: MemberDTO[] }>("/admin/members");
	const perms = useViewerPerms();
	const { busy, run, note } = useAct(res.reload);
	const [sel, setSel] = useState<string>();
	const [name, setName] = useState("");
	const [parent, setParent] = useState("");
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const [dragId, setDragId] = useState<string>();
	const [over, setOver] = useState<string>();
	const deps = res.data?.departments ?? [];
	const byId = useMemo(() => new Map(deps.map((d) => [d.id, d])), [deps]);
	const kids = useMemo(() => {
		const m = new Map<string, DeptNode[]>();
		for (const d of deps) {
			const k = d.parentId && byId.has(d.parentId) ? d.parentId : "";
			m.set(k, [...(m.get(k) ?? []), d]);
		}
		for (const l of m.values()) l.sort((a, b) => a.name.localeCompare(b.name));
		return m;
	}, [deps, byId]);
	const descendants = (id: string): Set<string> => {
		const out = new Set<string>([id]);
		const walk = (x: string) => {
			for (const k of kids.get(x) ?? []) if (!out.has(k.id)) (out.add(k.id), walk(k.id));
		};
		walk(id);
		return out;
	};
	const move = (id: string, to: string) => {
		const d = byId.get(id);
		if (!d || (d.parentId ?? "") === to || descendants(id).has(to)) return;
		void run(() => patch(`/admin/departments/${id}`, { parentId: to || null }), `已把「${d.name}」移动到${to ? `「${byId.get(to)?.name}」下` : "顶级"}`);
	};
	const selected = sel ? byId.get(sel) : undefined;
	const canCreate = (parent ? byId.get(parent)?.can.manage : res.data?.canCreateRoot) ?? false;
	const renderNode = (d: DeptNode, depth: number): ReactNode => {
		const children = kids.get(d.id) ?? [];
		const closed = collapsed.has(d.id);
		return (
			<li key={d.id}>
				<div
					data-testid="dept-node"
					data-dept={d.id}
					draggable={d.can.manage && !busy}
					onDragStart={(e) => (setDragId(d.id), e.dataTransfer.setData("text/plain", d.id), (e.dataTransfer.effectAllowed = "move"))}
					onDragEnd={() => (setDragId(undefined), setOver(undefined))}
					onDragOver={(e) => {
						if (dragId && dragId !== d.id && !descendants(dragId).has(d.id)) (e.preventDefault(), setOver(d.id));
					}}
					onDragLeave={() => setOver((o) => (o === d.id ? undefined : o))}
					onDrop={(e) => {
						e.preventDefault();
						const id = dragId ?? e.dataTransfer.getData("text/plain");
						setOver(undefined);
						if (id) move(id, d.id);
					}}
					className={cn("flex items-center gap-1 rounded-lg px-1.5 py-2 text-sm", sel === d.id ? "bg-surface-2" : "hover:bg-surface-2/60", over === d.id && "outline outline-2 outline-[var(--accent)]")}
					style={{ marginLeft: depth * 14 }}
				>
					{children.length ? (
						<button type="button" aria-label={closed ? "展开" : "收起"} className="rounded p-0.5 text-fg-muted hover:bg-surface-3" onClick={() => setCollapsed((s) => (s.has(d.id) ? (s.delete(d.id), new Set(s)) : new Set(s).add(d.id)))}>
							{closed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
						</button>
					) : (
						<span className="inline-block w-[18px]" />
					)}
					{d.can.manage ? <GripVertical aria-hidden className="size-3.5 shrink-0 cursor-grab text-fg-subtle" /> : null}
					<button type="button" className="min-w-0 flex-1 truncate text-left font-medium" data-testid="dept-select" onClick={() => setSel(d.id)}>
						{d.name}
					</button>
					{d.heads.length ? <span className="hidden max-w-[90px] truncate text-xs text-fg-muted sm:inline">{d.heads.map((h) => h.name).join("、")}</span> : null}
					<span className="shrink-0 text-xs text-fg-muted">{d.memberCount} 人</span>
				</div>
				{children.length && !closed ? (
					<ul>
						{children.map((c) => renderNode(c, depth + 1))}
					</ul>
				) : null}
			</li>
		);
	};
	return (
		<Loadable state={res} what="组织架构">
			<div data-testid="org-structure">
				{canCreate || perms.anywhere.has("dept.manage") ? (
					<form
						className="mb-4 flex flex-wrap items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							void run(() => post("/admin/departments", { name, ...(parent ? { parentId: parent } : {}) }).then(() => setName("")), "部门已创建");
						}}
					>
						<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="新部门名称" aria-label="新部门名称" className="h-8 max-w-xs text-sm" />
						<Select value={parent} onChange={(e) => setParent(e.target.value)} className="h-8 text-sm" aria-label="上级部门">
							<option value="">顶级部门</option>
							{deps.map((d) => (
								<option key={d.id} value={d.id}>
									上级：{d.name}
								</option>
							))}
						</Select>
						<Button size="sm" type="submit" disabled={busy || !name.trim() || !canCreate} data-testid="dept-create">
							<Plus />
							新建部门
						</Button>
						<span className="flex-1" />
						<Help label="操作提示">拖动部门到另一个部门上即可移动，也可以在右侧选中部门后用「上级部门」调整。部门管理员只管理本部门及其子部门，且不能授予自己没有的权限。</Help>
					</form>
				) : null}
				{note}
				{deps.length === 0 ? (
					<EmptyState icon={<Network />} title="还没有部门" />
				) : (
					<div className="grid gap-4 md:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
						<div>
							<div data-testid="admin-departments" role="group" aria-label="部门树" className="rounded-xl border border-border bg-surface p-2">
								<ul>
									{(kids.get("") ?? []).map((d) => renderNode(d, 0))}
								</ul>
								{dragId && res.data?.canCreateRoot ? (
									<div
										data-testid="dept-root-drop"
										className={cn("mt-1 rounded-lg border border-dashed border-border-strong px-2 py-1.5 text-center text-xs text-fg-muted", over === "" && "bg-surface-2")}
										onDragOver={(e) => (e.preventDefault(), setOver(""))}
										onDragLeave={() => setOver(undefined)}
										onDrop={(e) => (e.preventDefault(), setOver(undefined), dragId && move(dragId, ""))}
									>
										拖到这里 = 移为顶级部门
									</div>
								) : null}
							</div>
						</div>
						<div className="min-w-0">
							{selected ? (
								<DeptDetail key={selected.id} dept={selected} deps={deps} descendants={descendants(selected.id)} members={members.data?.members ?? []} busy={busy} run={run} onChanged={res.reload} onGone={() => setSel(undefined)} onSelect={setSel} kids={kids.get(selected.id) ?? []} />
							) : (
								<div className="rounded-xl border border-dashed border-border-strong px-4 py-10 text-center text-sm text-fg-muted">选择左侧的部门</div>
							)}
						</div>
					</div>
				)}
			</div>
		</Loadable>
	);
}

function DeptDetail({ dept, deps, descendants, members: all, busy, run, onChanged, onGone, onSelect, kids }: { dept: DeptNode; deps: DeptNode[]; descendants: Set<string>; members: MemberDTO[]; busy: boolean; run: (fn: () => Promise<unknown>, ok?: string) => Promise<void>; onChanged: () => void; onGone: () => void; onSelect: (id: string) => void; kids: DeptNode[] }) {
	const mem = useApi<{ members: DepartmentMemberDTO[] }>(dept.can.view ? `/admin/departments/${dept.id}/members` : null);
	const inner = useAct(() => (mem.reload(), onChanged()));
	const { ask, dialog } = useConfirm();
	const [rename, setRename] = useState(dept.name);
	const [adminPick, setAdminPick] = useState("");
	const [memPick, setMemPick] = useState("");
	const [to, setTo] = useState(dept.parentId ?? "");
	const list = mem.data?.members ?? [];
	const setRole = (userId: string, role: "member" | "manager" | null) => inner.run(() => put(`/admin/departments/${dept.id}/members`, { userId, role }));
	const addAdmin = async () => {
		const who = all.find((m) => m.userId === adminPick)?.name ?? "对方";
		const ok = await ask({ title: `让 ${who} 成为「${dept.name}」的部门管理员？`, consequence: `${who} 将能管理「${dept.name}」及其子部门：查看和停用成员、邀请新成员、维护子部门与部门知识库。`, items: ["只在这个部门范围内生效", "不能授予自己没有的权限"], confirmLabel: "设为部门管理员" });
		if (ok) await run(() => post("/admin/role-assignments", { subject: { kind: "user", id: adminPick }, roleId: "builtin:dept_admin", scope: { kind: "department", id: dept.id } }).then(() => setAdminPick("")), "已指定部门管理员");
	};
	return (
		<div className="space-y-6 rounded-xl border border-border bg-surface p-4" data-testid="dept-detail" data-dept={dept.id}>
			<div className="flex flex-wrap items-center gap-2">
				{dept.can.manage ? <Input value={rename} onChange={(e) => setRename(e.target.value)} className="h-8 max-w-[240px] text-base font-semibold" aria-label="部门名称" /> : <h3 className="text-base font-semibold">{dept.name}</h3>}
				{dept.can.manage && rename.trim() && rename !== dept.name ? (
					<Button size="sm" variant="primary" disabled={busy} data-testid="dept-rename" onClick={() => run(() => patch(`/admin/departments/${dept.id}`, { name: rename }), "已重命名")}>
						重命名
					</Button>
				) : null}
				<span className="flex-1" />
				<Badge>{dept.memberCount} 人</Badge>
				{dept.can.manage ? (
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						data-testid="dept-delete"
						onClick={async () => (await ask({ title: `删除部门「${dept.name}」？`, consequence: "子部门会上移一级；这个部门范围内的角色授权会被移除，相关成员会立即失去这些权限。成员本人仍留在组织中。", confirmLabel: "删除部门", danger: true })) && run(async () => (await del(`/admin/departments/${dept.id}`), onGone()), "部门已删除")}
					>
						<Trash2 />
						删除
					</Button>
				) : null}
			</div>
			{inner.note}

			<section aria-label="成员">
				<h4 className="mb-2 text-sm font-medium">成员与负责人</h4>
				{!dept.can.view ? (
					<p className="text-xs text-fg-muted">你没有查看该部门成员的权限。</p>
				) : (
					<Loadable state={mem} what="部门成员">
						<ul className="divide-y divide-border rounded-lg border border-border" data-testid="dept-members">
							{list.length === 0 ? <li className="px-3 py-2.5 text-xs text-fg-muted">还没有成员</li> : null}
							{list.map((m) => (
								<li key={m.userId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
									<span className="min-w-0 flex-1 truncate">
										{m.name} <span className="text-xs text-fg-muted">{m.email}</span>
									</span>
									{dept.can.members ? (
										<>
											<Select value={m.role} disabled={inner.busy} onChange={(e) => setRole(m.userId, e.target.value as "member" | "manager")} className="h-8 text-sm" aria-label={`${m.name} 的部门角色`}>
												<option value="member">成员</option>
												<option value="manager">负责人</option>
											</Select>
											<Button size="sm" variant="ghost" disabled={inner.busy} onClick={() => setRole(m.userId, null)}>
												移出部门
											</Button>
										</>
									) : (
										<Badge>{m.role === "manager" ? "负责人" : "成员"}</Badge>
									)}
								</li>
							))}
						</ul>
					</Loadable>
				)}
				{dept.can.members ? (
					<div className="mt-2 flex flex-wrap gap-2">
						<Select value={memPick} onChange={(e) => setMemPick(e.target.value)} className="h-8 text-sm" aria-label="添加成员" data-testid="dept-member-pick">
							<option value="">添加成员…</option>
							{all
								.filter((m) => m.status === "active" && !list.some((x) => x.userId === m.userId))
								.map((m) => (
									<option key={m.userId} value={m.userId}>
										{m.name}
									</option>
								))}
						</Select>
						<Button size="sm" disabled={!memPick || inner.busy} data-testid="dept-member-add" onClick={() => setRole(memPick, "member").then(() => setMemPick(""))}>
							添加
						</Button>
					</div>
				) : null}
			</section>

			<section aria-label="部门管理员">
				<h4 className="mb-2 text-sm font-medium">部门管理员</h4>
				<ul className="mb-2 flex flex-wrap gap-1.5" data-testid="dept-admins">
					{dept.admins.length === 0 ? <li className="text-xs text-fg-muted">暂无</li> : null}
					{dept.admins.map((a) => (
						<li key={a.assignmentId}>
							<Badge tone="info" className="h-6 gap-1.5 pr-1">
								{a.name}
								{dept.can.assign ? (
									<button type="button" aria-label={`撤销 ${a.name} 的部门管理员`} className="rounded px-1 hover:bg-info/20" data-testid="dept-admin-remove" onClick={() => run(() => del(`/admin/role-assignments/${a.assignmentId}`), "已撤销部门管理员")}>
										×
									</button>
								) : null}
							</Badge>
						</li>
					))}
				</ul>
				{dept.can.assign ? (
					<div className="flex flex-wrap gap-2">
						<Select value={adminPick} onChange={(e) => setAdminPick(e.target.value)} className="h-8 text-sm" aria-label="选择成员" data-testid="dept-admin-pick">
							<option value="">指定部门管理员…</option>
							{all
								.filter((m) => m.status === "active" && !dept.admins.some((a) => a.userId === m.userId))
								.map((m) => (
									<option key={m.userId} value={m.userId}>
										{m.name}
									</option>
								))}
						</Select>
						<Button size="sm" disabled={!adminPick || busy} data-testid="dept-admin-add" onClick={() => void addAdmin()}>
							<UserCog />
							设为部门管理员
						</Button>
					</div>
				) : null}
			</section>

			{dept.can.manage || kids.length ? (
				<section aria-label="层级" className="space-y-3 border-t border-border pt-4">
					{dept.can.manage ? (
						<div className="flex flex-wrap items-center gap-2 text-sm">
							<span className="text-fg-muted">上级部门</span>
							<Select value={to} onChange={(e) => setTo(e.target.value)} className="h-8 text-sm" aria-label="移动到" data-testid="dept-move-to">
								<option value="">顶级部门</option>
								{deps
									.filter((d) => !descendants.has(d.id))
									.map((d) => (
										<option key={d.id} value={d.id}>
											{d.name}
										</option>
									))}
							</Select>
							<Button size="sm" disabled={busy || to === (dept.parentId ?? "")} data-testid="dept-move" onClick={() => run(() => patch(`/admin/departments/${dept.id}`, { parentId: to || null }), "已移动")}>
								移动
							</Button>
						</div>
					) : null}
					{kids.length ? (
						<div className="flex flex-wrap items-center gap-1.5 text-xs">
							<span className="text-fg-muted">子部门：</span>
							{kids.map((k) => (
								<button key={k.id} type="button" className="rounded-md bg-surface-2 px-2 py-1 hover:bg-surface-3" onClick={() => onSelect(k.id)}>
									{k.name}
								</button>
							))}
						</div>
					) : null}
				</section>
			) : null}
			{dialog}
		</div>
	);
}
