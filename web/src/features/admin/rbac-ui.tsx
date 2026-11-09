// Shared pieces for the permission UI: viewer permission helpers, scope picker, grouped permission matrix, "why" explanations.
import { ChevronDown, ChevronRight, Lock } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { PERMISSIONS, PERMISSION_GROUPS, permissionDef, type EffectivePermissionDTO, type PermissionDef, type PermissionScopeKind, type ScopeRef } from "@shared/permissions";
import type { DepartmentDTO } from "@shared/ops";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import type { Project } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/misc";
import { Select } from "@/components/ui/input";

export { PERMISSIONS, PERMISSION_GROUPS, permissionDef };

/** What `/api/me` says about the viewer (server re-checks every call; this only decides what to show). */
export interface ViewerPerms {
	/** Held at org scope. */
	org: ReadonlySet<string>;
	/** Held at org scope or inside any department/project scope. */
	anywhere: ReadonlySet<string>;
	baseRole?: string;
	roles: { roleId: string; name: string; scope: ScopeRef }[];
}
export function useViewerPerms(): ViewerPerms {
	const { me } = useSession();
	const m = me as (typeof me & { permissions?: string[]; permissionsAnywhere?: string[]; baseRole?: string; roles?: ViewerPerms["roles"] }) | undefined;
	return useMemo(() => ({ org: new Set(m?.permissions ?? []), anywhere: new Set(m?.permissionsAnywhere ?? []), baseRole: m?.baseRole, roles: m?.roles ?? [] }), [m]);
}

export const RISK_LABEL: Record<string, string> = { sensitive: "敏感", critical: "高危" };
export const SCOPE_KIND_LABEL: Record<PermissionScopeKind, string> = { org: "整个组织", department: "部门（含子部门）", project: "项目" };
export const ROLE_SHORT: Record<string, string> = { "builtin:owner": "所有者", "builtin:admin": "管理员", "builtin:member": "成员", "builtin:guest": "访客" };

export function scopeText(s: ScopeRef & { name?: string }): string {
	if (s.kind === "org") return "整个组织";
	return `${s.kind === "department" ? "部门" : "项目"}「${s.name ?? s.id}」${s.kind === "department" ? "及子部门" : ""}`;
}

export function useDepartments() {
	return useApi<{ departments: DepartmentDTO[] }>("/departments");
}
export function useMyProjects() {
	return useApi<{ projects: Project[] }>("/projects");
}

/** Departments ordered as a tree (parents before children) with their depth. */
export function deptTreeOptions(deps: DepartmentDTO[]): { id: string; label: string; depth: number }[] {
	const ids = new Set(deps.map((d) => d.id));
	const kids = new Map<string, DepartmentDTO[]>();
	for (const d of deps) {
		const k = d.parentId && ids.has(d.parentId) ? d.parentId : "";
		const list = kids.get(k) ?? [];
		list.push(d);
		kids.set(k, list);
	}
	const out: { id: string; label: string; depth: number }[] = [];
	const walk = (parent: string, depth: number) => {
		for (const d of [...(kids.get(parent) ?? [])].sort((x, y) => x.name.localeCompare(y.name))) {
			out.push({ id: d.id, label: d.name, depth });
			walk(d.id, depth + 1);
		}
	};
	walk("", 0);
	return out;
}

/** Scope selector: 整个组织 / 部门 / 项目. `kinds` restricts what may be chosen. */
export function ScopePicker({ value, onChange, kinds = ["org", "department", "project"], testId }: { value: { kind: PermissionScopeKind; id: string }; onChange: (v: { kind: PermissionScopeKind; id: string }) => void; kinds?: readonly PermissionScopeKind[]; testId?: string }) {
	const deps = useDepartments();
	const projects = useMyProjects();
	const opts = deptTreeOptions(deps.data?.departments ?? []);
	return (
		<span className="inline-flex flex-wrap items-center gap-1.5" data-testid={testId}>
			<Select
				aria-label="范围"
				value={value.kind}
				className="h-8 text-[13px]"
				onChange={(e) => {
					const kind = e.target.value as PermissionScopeKind;
					onChange({ kind, id: kind === "department" ? (opts[0]?.id ?? "") : kind === "project" ? (projects.data?.projects[0]?.id ?? "") : "" });
				}}
			>
				{kinds.map((k) => (
					<option key={k} value={k}>
						{SCOPE_KIND_LABEL[k]}
					</option>
				))}
			</Select>
			{value.kind === "department" ? (
				<Select aria-label="部门" value={value.id} className="h-8 text-[13px]" onChange={(e) => onChange({ kind: "department", id: e.target.value })}>
					{opts.length === 0 ? <option value="">（还没有部门）</option> : null}
					{opts.map((o) => (
						<option key={o.id} value={o.id}>
							{"　".repeat(o.depth)}
							{o.label}
						</option>
					))}
				</Select>
			) : null}
			{value.kind === "project" ? (
				<Select aria-label="项目" value={value.id} className="h-8 text-[13px]" onChange={(e) => onChange({ kind: "project", id: e.target.value })}>
					{(projects.data?.projects ?? []).length === 0 ? <option value="">（你不在任何项目中）</option> : null}
					{(projects.data?.projects ?? []).map((p) => (
						<option key={p.id} value={p.id}>
							{p.name}
						</option>
					))}
				</Select>
			) : null}
		</span>
	);
}

function RiskBadge({ risk }: { risk: PermissionDef["risk"] }) {
	if (risk === "normal") return null;
	return <Badge tone={risk === "critical" ? "danger" : "warning"}>{RISK_LABEL[risk]}</Badge>;
}

/** Grouped permission checkboxes with descriptions. `readOnly` for built-in roles. */
export function PermissionMatrix({ selected, onChange, readOnly, restrictTo, testId }: { selected: ReadonlySet<string>; onChange?: (next: Set<string>) => void; readOnly?: boolean; /** Only these ids may be toggled (everything else is shown disabled). */ restrictTo?: ReadonlySet<string>; testId?: string }) {
	const [open, setOpen] = useState<Record<string, boolean>>({});
	const toggle = (ids: string[], on: boolean) => {
		if (readOnly || !onChange) return;
		const next = new Set(selected);
		for (const id of ids) if (!restrictTo || restrictTo.has(id) || !on) on ? next.add(id) : next.delete(id);
		onChange(next);
	};
	return (
		<div data-testid={testId} className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
			{PERMISSION_GROUPS.map((g) => {
				const perms = PERMISSIONS.filter((p) => p.group === g.id);
				const ids = perms.map((p) => p.id);
				const n = ids.filter((id) => selected.has(id)).length;
				const isOpen = open[g.id] ?? (readOnly ? n > 0 : true);
				return (
					<section key={g.id} data-testid={`perm-group-${g.id}`}>
						<div className="flex items-center gap-2 bg-surface-2/60 px-3 py-2">
							<button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setOpen((o) => ({ ...o, [g.id]: !isOpen }))} aria-expanded={isOpen}>
								{isOpen ? <ChevronDown className="size-3.5 shrink-0 text-fg-subtle" /> : <ChevronRight className="size-3.5 shrink-0 text-fg-subtle" />}
								<span className="text-[13px] font-medium">{g.label}</span>
								<span className="truncate text-xs text-fg-subtle">{g.description}</span>
							</button>
							<span className="shrink-0 text-xs text-fg-muted">
								{n}/{ids.length}
							</span>
							{!readOnly ? (
								<input
									type="checkbox"
									aria-label={`全选 ${g.label}`}
									className="size-4 accent-[var(--accent)]"
									checked={n === ids.length}
									ref={(el) => {
										if (el) el.indeterminate = n > 0 && n < ids.length;
									}}
									onChange={(e) => toggle(ids, e.target.checked)}
								/>
							) : null}
						</div>
						{isOpen ? (
							<ul>
								{perms.map((p) => {
									const disabled = readOnly || (restrictTo ? !restrictTo.has(p.id) && !selected.has(p.id) : false);
									return (
										<li key={p.id} className="border-t border-border first:border-t-0">
											<label className={cn("flex items-start gap-2.5 px-3 py-2", disabled ? "cursor-default" : "cursor-pointer hover:bg-surface-2/50")}>
												<input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]" data-testid={`perm-${p.id}`} checked={selected.has(p.id)} disabled={disabled} onChange={(e) => toggle([p.id], e.target.checked)} />
												<span className="min-w-0 flex-1">
													<span className="flex flex-wrap items-center gap-1.5">
														<span className="text-[13px] font-medium">{p.label}</span>
														<RiskBadge risk={p.risk} />
														<code className="text-[11px] text-fg-subtle">{p.id}</code>
													</span>
													<span className="block text-xs text-fg-muted">{p.description}</span>
													<span className="block text-[11px] text-fg-subtle">可设范围：{p.scopes.map((s) => (s === "org" ? "组织" : s === "department" ? "部门" : "项目")).join(" / ")}</span>
												</span>
											</label>
										</li>
									);
								})}
							</ul>
						) : null}
					</section>
				);
			})}
		</div>
	);
}

const SOURCE_LABEL: Record<string, string> = { role: "角色", user_grant: "直接授予", user_deny: "直接禁止", owner: "所有者规则", default: "默认" };

/** One permission's decision with the rules behind it. */
export function WhyList({ e }: { e: Pick<EffectivePermissionDTO, "allow" | "because"> }) {
	return (
		<ul className="mt-1 space-y-0.5 text-xs" data-testid="why-list">
			{e.because.map((b, i) => (
				<li key={i} className="flex items-start gap-1.5">
					<Badge tone={b.effect === "deny" ? "danger" : "success"}>{SOURCE_LABEL[b.source] ?? b.source}</Badge>
					<span className="text-fg-muted">{b.detail}</span>
				</li>
			))}
			<li className="text-fg-subtle">结论：{e.allow ? "允许" : "拒绝"}（禁止优先于允许）</li>
		</ul>
	);
}

/** Effective permissions by group with a "为什么" toggle per row. */
export function EffectiveView({ effective, onlyGranted: initialOnly = true, testId }: { effective: readonly EffectivePermissionDTO[]; onlyGranted?: boolean; testId?: string }) {
	const [only, setOnly] = useState(initialOnly);
	const [why, setWhy] = useState<string>();
	const by = new Map(effective.map((e) => [e.permission, e]));
	const granted = effective.filter((e) => e.allow).length;
	return (
		<div data-testid={testId}>
			<div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-fg-muted">
				<span>
					已拥有 {granted} / {effective.length} 项权限
				</span>
				<label className="inline-flex cursor-pointer items-center gap-1.5">
					<input type="checkbox" className="size-3.5 accent-[var(--accent)]" checked={only} onChange={(e) => setOnly(e.target.checked)} />
					只显示已拥有
				</label>
			</div>
			<div className="space-y-3">
				{PERMISSION_GROUPS.map((g) => {
					const rows = PERMISSIONS.filter((p) => p.group === g.id && (!only || by.get(p.id)?.allow));
					if (!rows.length) return null;
					return (
						<section key={g.id}>
							<h4 className="mb-1 text-xs font-medium text-fg-muted">{g.label}</h4>
							<ul className="divide-y divide-border rounded-lg border border-border bg-surface">
								{rows.map((p) => {
									const e = by.get(p.id);
									return (
										<li key={p.id} data-testid="eff-row" data-allow={e?.allow ? "1" : "0"} data-perm={p.id} className="px-3 py-1.5 text-[13px]">
											<div className="flex flex-wrap items-center gap-2">
												<span className={cn("inline-flex size-4 items-center justify-center rounded-full text-[10px] font-bold", e?.allow ? "bg-success-soft text-success" : "bg-surface-2 text-fg-subtle")}>{e?.allow ? "✓" : "–"}</span>
												<span className="min-w-0 flex-1">
													{p.label} <code className="text-[11px] text-fg-subtle">{p.id}</code>
												</span>
												<button type="button" className="text-xs text-info hover:underline" data-testid="why-btn" onClick={() => setWhy(why === p.id ? undefined : p.id)}>
													为什么
												</button>
											</div>
											{why === p.id && e ? <WhyList e={e} /> : null}
										</li>
									);
								})}
							</ul>
						</section>
					);
				})}
			</div>
		</div>
	);
}

export function LockedNote({ children }: { children: ReactNode }) {
	return (
		<p className="mb-3 flex items-start gap-1.5 rounded-lg bg-surface-2 px-3 py-2 text-xs text-fg-muted">
			<Lock className="mt-0.5 size-3.5 shrink-0" />
			<span>{children}</span>
		</p>
	);
}
