// 用户组 (optional): named sets of members that can be given roles like a department can. Managed with group.manage.
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { MemberDTO } from "@shared/ops";
import { del, post, put } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Badge, Loadable } from "@/components/ui/misc";
import { Fold, useAct } from "@/features/admin/common";
import { useConfirm } from "@/features/admin/confirm";
import { useViewerPerms } from "@/features/admin/rbac-ui";

interface Group {
	id: string;
	name: string;
	description: string;
	memberCount: number;
}

export function GroupsPanel({ onChanged }: { onChanged?: () => void }) {
	const res = useApi<{ groups: Group[] }>("/admin/groups");
	const members = useApi<{ members: MemberDTO[] }>("/admin/members");
	const perms = useViewerPerms();
	const { busy, run, note } = useAct(() => (res.reload(), onChanged?.()));
	const { ask, dialog } = useConfirm();
	const [name, setName] = useState("");
	const [open, setOpen] = useState<string>();
	const can = perms.org.has("group.manage");
	return (
		<section className="mt-8" data-testid="groups-panel">
			<Fold title="用户组（可选）" hint="把不在同一部门的人编成一组，再把角色授予整个组">
			{dialog}
			{can ? (
				<form
					className="mb-2 flex gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						void run(() => post("/admin/groups", { name }).then(() => setName("")), "用户组已创建");
					}}
				>
					<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="新用户组名称" className="h-8 max-w-xs text-sm" aria-label="新用户组名称" />
					<Button size="sm" type="submit" disabled={busy || !name.trim()} data-testid="group-create">
						<Plus />
						新建
					</Button>
				</form>
			) : null}
			{note}
			<Loadable state={res} what="用户组">
				{(res.data?.groups ?? []).length === 0 ? (
					<p className="text-xs text-fg-muted">还没有用户组。</p>
				) : (
					<ul className="divide-y divide-border rounded-xl border border-border bg-surface" data-testid="group-list">
						{res.data!.groups.map((g) => (
							<li key={g.id}>
								<div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
									<button type="button" className="min-w-0 flex-1 truncate text-left font-medium" onClick={() => setOpen(open === g.id ? undefined : g.id)}>
										{g.name} <span className="text-xs font-normal text-fg-subtle">· {g.memberCount} 人</span>
									</button>
									{can ? (
										<Button size="icon-sm" variant="ghost" aria-label={`删除用户组 ${g.name}`} disabled={busy} onClick={async () => (await ask({ title: `删除用户组「${g.name}」？`, consequence: "授予这个组的角色会一并移除，组里的成员会立即失去这些权限（成员本人不受影响）。", confirmLabel: "删除用户组", danger: true })) && run(() => del(`/admin/groups/${g.id}`), "用户组已删除")}>
											<Trash2 />
										</Button>
									) : null}
								</div>
								{open === g.id ? <GroupMembers group={g} all={members.data?.members ?? []} can={can} onChanged={res.reload} /> : null}
							</li>
						))}
					</ul>
				)}
			</Loadable>
			</Fold>
		</section>
	);
}

function GroupMembers({ group, all, can, onChanged }: { group: Group; all: MemberDTO[]; can: boolean; onChanged: () => void }) {
	const res = useApi<{ members: { userId: string; name: string; email: string }[] }>(`/admin/groups/${group.id}/members`);
	const { busy, run, note } = useAct(() => (res.reload(), onChanged()));
	const [pick, setPick] = useState("");
	const list = res.data?.members ?? [];
	return (
		<div className="border-t border-border bg-surface-2/50 px-3 py-2 text-sm">
			{note}
			<div className="mb-2 flex flex-wrap gap-1.5">
				{list.length === 0 ? <span className="text-xs text-fg-subtle">还没有成员。</span> : null}
				{list.map((m) => (
					<Badge key={m.userId} className="h-6 gap-1 pr-1">
						{m.name}
						{can ? (
							<button type="button" aria-label={`移出 ${m.name}`} className="rounded px-1 hover:bg-surface-3" onClick={() => run(() => put(`/admin/groups/${group.id}/members`, { userId: m.userId, member: false }))}>
								×
							</button>
						) : null}
					</Badge>
				))}
			</div>
			{can ? (
				<div className="flex gap-2">
					<Select value={pick} onChange={(e) => setPick(e.target.value)} className="h-7 text-xs" aria-label="添加成员">
						<option value="">添加成员…</option>
						{all
							.filter((m) => m.status === "active" && !list.some((x) => x.userId === m.userId))
							.map((m) => (
								<option key={m.userId} value={m.userId}>
									{m.name}
								</option>
							))}
					</Select>
					<Button size="sm" disabled={!pick || busy} onClick={() => run(() => put(`/admin/groups/${group.id}/members`, { userId: pick, member: true }).then(() => setPick("")))}>
						添加
					</Button>
				</div>
			) : null}
		</div>
	);
}
