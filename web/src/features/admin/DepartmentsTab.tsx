// 部门 tab.
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { DepartmentDTO, DepartmentMemberDTO, MemberDTO } from "@shared/ops";
import { del, post, put } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Loadable } from "@/components/ui/misc";
import { useAct, Table, Row } from "@/features/admin/common";

export function Departments() {
	const res = useApi<{ departments: DepartmentDTO[] }>("/departments");
	const members = useApi<{ members: MemberDTO[] }>("/admin/members");
	const { busy, run, note } = useAct(res.reload);
	const [name, setName] = useState("");
	const [open, setOpen] = useState<string>();
	return (
		<div>
			<form
				className="mb-4 flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					void run(() => post("/admin/departments", { name }).then(() => setName("")), "部门已创建");
				}}
			>
				<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="新部门名称" className="h-8 max-w-xs text-[13px]" />
				<Button size="sm" type="submit" disabled={busy || !name.trim()} data-testid="dept-create">
					<Plus />
					新建部门
				</Button>
			</form>
			{note}
			<Loadable state={res} what="部门" need="E 组：GET /api/departments">
				{(res.data?.departments ?? []).length === 0 ? (
					<p className="text-[13px] text-fg-subtle">还没有部门。</p>
				) : (
					<Table testId="admin-departments">
						{res.data!.departments.map((d) => (
							<div key={d.id}>
								<Row>
									<button className="min-w-0 flex-1 text-left font-medium" onClick={() => setOpen(open === d.id ? undefined : d.id)}>
										{d.name} <span className="text-xs font-normal text-fg-subtle">· {d.memberCount} 人</span>
									</button>
									<Button size="sm" variant="ghost" disabled={busy} onClick={() => confirm(`删除部门「${d.name}」？`) && run(() => del(`/admin/departments/${d.id}`), "部门已删除")}>
										<Trash2 />
									</Button>
								</Row>
								{open === d.id ? <DeptMembers dept={d} all={members.data?.members ?? []} onChanged={res.reload} /> : null}
							</div>
						))}
					</Table>
				)}
			</Loadable>
		</div>
	);
}

function DeptMembers({ dept, all, onChanged }: { dept: DepartmentDTO; all: MemberDTO[]; onChanged: () => void }) {
	const res = useApi<{ members: DepartmentMemberDTO[] }>(`/admin/departments/${dept.id}/members`);
	const { busy, run, note } = useAct(() => {
		res.reload();
		onChanged();
	});
	const [uid, setUid] = useState("");
	const set = (userId: string, role: "member" | "manager" | null) => run(() => put(`/admin/departments/${dept.id}/members`, { userId, role }));
	return (
		<div className="border-t border-border bg-surface-2/50 px-3 py-2">
			{note}
			<ul className="space-y-1">
				{(res.data?.members ?? []).map((m) => (
					<li key={m.userId} className="flex items-center gap-2 text-[13px]">
						<span className="flex-1">{m.name}</span>
						<Select value={m.role} disabled={busy} onChange={(e) => set(m.userId, e.target.value as "member" | "manager")} className="h-7 text-xs">
							<option value="member">成员</option>
							<option value="manager">负责人（可看本部门统计）</option>
						</Select>
						<Button size="sm" variant="ghost" disabled={busy} onClick={() => set(m.userId, null)}>
							移除
						</Button>
					</li>
				))}
			</ul>
			<div className="mt-2 flex gap-2">
				<Select value={uid} onChange={(e) => setUid(e.target.value)} className="h-7 text-xs">
					<option value="">添加成员…</option>
					{all
						.filter((m) => !(res.data?.members ?? []).some((x) => x.userId === m.userId))
						.map((m) => (
							<option key={m.userId} value={m.userId}>
								{m.name}
							</option>
						))}
				</Select>
				<Button size="sm" disabled={!uid || busy} onClick={() => set(uid, "member").then(() => setUid(""))}>
					添加
				</Button>
			</div>
		</div>
	);
}
