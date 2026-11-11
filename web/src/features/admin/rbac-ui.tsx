// Shared pieces for the permission UI: viewer permission helpers, scope picker, grouped permission matrix, "why" explanations.
import { ChevronDown, ChevronRight, Lock, ShieldAlert } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { PERMISSIONS, PERMISSION_GROUPS, permissionDef, type EffectivePermissionDTO, type PermissionDef, type PermissionScopeKind, type ScopeRef } from "@shared/permissions";
import type { DepartmentDTO } from "@shared/ops";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import type { Project } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/misc";
import { Help } from "@/components/ui/help";
import { Switch } from "@/components/ui/switch";
import { Select } from "@/components/ui/select";
import type { ConfirmOptions } from "./confirm";

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

/** Plainer names for a few catalog entries (the catalog lives in shared/ and still uses some internal vocabulary). */
const GROUP_LABEL: Record<string, string> = { model: "模型", mcp: "连接", sandbox: "工作区运行", audit: "审计与排查" };
const PERM_LABEL: Record<string, string> = { "model.provider.manage": "管理模型服务与密钥", "sandbox.use": "使用工作区运行代码", "sandbox.network": "工作区联网", "sandbox.browser": "使用浏览器工具", "sandbox.policy.manage": "管理运行与工具策略", "model.manage": "管理模型" };
const PERM_DESC: Record<string, string> = { "model.provider.manage": "新增模型服务、保存和更换密钥、测试连通" };
export const groupLabel = (g: { id: string; label: string }): string => GROUP_LABEL[g.id] ?? g.label;
export const permLabel = (p: { id: string; label: string }): string => PERM_LABEL[p.id] ?? p.label;
export const permDesc = (p: { id: string; description: string }): string => PERM_DESC[p.id] ?? p.description;
export const isCritical = (id: string): boolean => permissionDef(id)?.risk === "critical";
export const criticalOf = (ids: Iterable<string>): PermissionDef[] => [...ids].map((id) => permissionDef(id)).filter((p): p is PermissionDef => !!p && p.risk === "critical");

/** One line per built-in role: what it is for. Custom roles fall back to their own description. */
const ROLE_PURPOSE: Record<string, string> = {
	"builtin:owner": "组织的最终负责人，拥有全部权限，至少保留一位。",
	"builtin:admin": "日常管理：成员、部门、角色、模型、预算与审计。",
	"builtin:member": "日常使用：对话、文件、技能、自动化与项目。",
	"builtin:guest": "只读体验：能对话，不能导出、分享或建项目。",
	"builtin:dept_admin": "只管理被指定的部门及其子部门。",
	"builtin:skill_reviewer": "审核技能与连接的上架申请。",
	"builtin:auditor": "只读：查看和导出审计日志与统计。",
	"builtin:billing": "管理预算，查看和导出费用与用量。",
};
export const rolePurpose = (r: { id: string; description: string }): string => ROLE_PURPOSE[r.id] ?? (r.description || "自定义角色");
/** Base roles: exactly one per member, organisation-wide. Everything else stacks on top. */
export const BASE_ROLE_IDS = ["builtin:owner", "builtin:admin", "builtin:member", "builtin:guest"] as const;
export const isBaseRole = (id: string): boolean => (BASE_ROLE_IDS as readonly string[]).includes(id);
/** Display order inside the role list (the default hierarchy: owner > admin > scoped / specialist > member > guest). */
export const ROLE_ORDER = ["builtin:owner", "builtin:admin", "builtin:member", "builtin:guest", "builtin:dept_admin", "builtin:skill_reviewer", "builtin:auditor", "builtin:billing"];
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
				className="h-8 text-sm"
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
				<Select aria-label="部门" value={value.id} className="h-8 text-sm" onChange={(e) => onChange({ kind: "department", id: e.target.value })}>
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
				<Select aria-label="项目" value={value.id} className="h-8 text-sm" onChange={(e) => onChange({ kind: "project", id: e.target.value })}>
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

/** Confirmation text for changing a member's base role; null when the change is harmless (no dialog needed). */
export function baseRoleConfirm(name: string, from: string, to: string): ConfirmOptions | null {
	if (from === to) return null;
	if (to === "owner") return { title: `让 ${name} 成为组织所有者？`, consequence: `${name} 将拥有组织的全部权限，包括管理所有者、移出成员、更换模型密钥和查看全部审计。`, items: ["请确认这是你想要的人选", "之后可以再把 TA 降级（组织至少保留一位所有者）"], confirmLabel: "设为所有者", danger: true };
	if (from === "owner") return { title: `取消 ${name} 的所有者身份？`, consequence: `${name} 将不再是组织所有者，失去所有者专属权限。组织至少要保留一位所有者。`, confirmLabel: "取消所有者", danger: true };
	if (to === "admin") return { title: `让 ${name} 成为管理员？`, consequence: `${name} 将拥有除「变更组织所有者」以外的全部权限，包括成员、角色、模型密钥、预算和审计。`, confirmLabel: "设为管理员", danger: true };
	return null;
}
/** Confirmation text for giving someone a role that contains high-risk permissions; null for ordinary roles. */
export function roleGrantConfirm(name: string, role: { name: string; permissions: readonly string[] } | undefined, scope: string): ConfirmOptions | null {
	const risky = criticalOf(role?.permissions ?? []);
	if (!role || !risky.length) return null;
	return { title: `授予「${role.name}」？`, consequence: `${name} 将在${scope}获得 ${risky.length} 项高危权限：`, items: risky.map((p) => `${permLabel(p)}：${permDesc(p)}`), confirmLabel: "确认授予", danger: true };
}

export function RiskBadge({ risk }: { risk: PermissionDef["risk"] }) {
	if (risk === "normal") return null;
	return (
		<Badge tone={risk === "critical" ? "danger" : "warning"}>
			{risk === "critical" ? <ShieldAlert aria-hidden /> : null}
			{RISK_LABEL[risk]}
		</Badge>
	);
}

/** Permissions grouped into collapsible sections with n/m counts; high-risk ones are marked. `readOnly` for built-in roles. */
export function PermissionMatrix({ selected, onChange, readOnly, restrictTo, testId }: { selected: ReadonlySet<string>; onChange?: (next: Set<string>) => void; readOnly?: boolean; /** Only these ids may be toggled (everything else is shown disabled). */ restrictTo?: ReadonlySet<string>; testId?: string }) {
	const [open, setOpen] = useState<Record<string, boolean>>({});
	const groupOpen = (gid: string, n: number) => open[gid] ?? n > 0;
	const allIds = PERMISSIONS.map((p) => p.id);
	const toggle = (ids: string[], on: boolean) => {
		if (readOnly || !onChange) return;
		const next = new Set(selected);
		for (const id of ids) if (!restrictTo || restrictTo.has(id) || !on) on ? next.add(id) : next.delete(id);
		onChange(next);
	};
	const anyClosed = PERMISSION_GROUPS.some((g) => !groupOpen(g.id, PERMISSIONS.filter((p) => p.group === g.id && selected.has(p.id)).length));
	return (
		<div data-testid={testId}>
			<div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-fg-muted">
				<span>
					已选 {allIds.filter((id) => selected.has(id)).length} / {allIds.length} 项
				</span>
				<Help label="权限说明" side="top">
					带「高危」标记的权限可能影响整个组织的数据或安全。你只能勾选自己拥有的权限；「变更组织所有者」不能放进自定义角色。
				</Help>
				<span className="flex-1" />
				<button type="button" className="rounded px-1.5 py-0.5 text-fg-muted underline-offset-2 hover:text-fg hover:underline" data-testid="matrix-toggle-all" onClick={() => setOpen(Object.fromEntries(PERMISSION_GROUPS.map((g) => [g.id, anyClosed])))}>
					{anyClosed ? "展开全部" : "收起全部"}
				</button>
			</div>
			<div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
				{PERMISSION_GROUPS.map((g) => {
					const perms = PERMISSIONS.filter((p) => p.group === g.id);
					const ids = perms.map((p) => p.id);
					const n = ids.filter((id) => selected.has(id)).length;
					const risky = perms.filter((p) => p.risk === "critical" && selected.has(p.id)).length;
					const isOpen = groupOpen(g.id, n);
					return (
						<section key={g.id} data-testid={`perm-group-${g.id}`}>
							<div className="flex items-center gap-2 bg-surface-2/60 px-3 py-2">
								<button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left" onClick={() => setOpen((o) => ({ ...o, [g.id]: !isOpen }))} aria-expanded={isOpen}>
									{isOpen ? <ChevronDown aria-hidden className="size-4 shrink-0 text-fg-subtle" /> : <ChevronRight aria-hidden className="size-4 shrink-0 text-fg-subtle" />}
									<span className="text-sm font-medium">{groupLabel(g)}</span>
									{risky ? <Badge tone="danger">含 {risky} 项高危</Badge> : null}
								</button>
								<span className="shrink-0 text-xs text-fg-muted">
									{n}/{ids.length}
								</span>
								{!readOnly ? (
									<input
										type="checkbox"
										aria-label={`全选 ${groupLabel(g)}`}
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
												<label className={cn("flex items-start gap-2.5 px-3 py-2", disabled ? "cursor-default" : "cursor-pointer hover:bg-surface-2/50")} title={`可设范围：${p.scopes.map((s) => (s === "org" ? "组织" : s === "department" ? "部门" : "项目")).join(" / ")}`}>
													<input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]" data-testid={`perm-${p.id}`} checked={selected.has(p.id)} disabled={disabled} onChange={(e) => toggle([p.id], e.target.checked)} />
													<span className="min-w-0 flex-1">
														<span className="flex flex-wrap items-center gap-1.5">
															<span className="text-sm font-medium">{permLabel(p)}</span>
															<RiskBadge risk={p.risk} />
														</span>
														<span className="block text-xs text-fg-muted">{permDesc(p)}</span>
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
		</div>
	);
}

const SOURCE_LABEL: Record<string, string> = { role: "角色", user_grant: "直接授予", user_deny: "直接禁止", owner: "所有者规则", default: "默认" };

/** One permission's decision with the rules behind it. */
export function WhyList({ e }: { e: Pick<EffectivePermissionDTO, "allow" | "because"> }) {
	return (
		<ul className="mt-1.5 space-y-1 text-xs" data-testid="why-list">
			{e.because.map((b, i) => (
				<li key={i} className="flex items-start gap-1.5">
					<Badge tone={b.effect === "deny" ? "danger" : "success"}>{SOURCE_LABEL[b.source] ?? b.source}</Badge>
					<span className="text-fg-muted">{b.detail}</span>
				</li>
			))}
			<li className="text-fg-muted">结论：{e.allow ? "允许" : "拒绝"}（禁止优先于允许）</li>
		</ul>
	);
}

/** Effective permissions by group with a "为什么" toggle per row. `collapsible`: hidden behind a toggle until asked for. */
export function EffectiveView({ effective, onlyGranted: initialOnly = true, testId, collapsible, defaultOpen }: { effective: readonly EffectivePermissionDTO[]; onlyGranted?: boolean; testId?: string; collapsible?: boolean; defaultOpen?: boolean }) {
	const [only, setOnly] = useState(initialOnly);
	const [why, setWhy] = useState<string>();
	const [shown, setShown] = useState(!collapsible || !!defaultOpen);
	const by = new Map(effective.map((e) => [e.permission, e]));
	const granted = effective.filter((e) => e.allow).length;
	return (
		<div data-testid={testId}>
			{collapsible ? (
				<button type="button" className="mb-2 flex w-full items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-surface-2" aria-expanded={shown} data-testid="effective-toggle" onClick={() => setShown((v) => !v)}>
					{shown ? <ChevronDown aria-hidden className="size-4 text-fg-subtle" /> : <ChevronRight aria-hidden className="size-4 text-fg-subtle" />}
					<span className="flex-1">{shown ? "收起" : "查看"}全部权限与原因</span>
					<span className="text-xs text-fg-muted">
						已拥有 {granted} / {effective.length} 项
					</span>
				</button>
			) : null}
			{shown ? (
				<>
					<div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-fg-muted">
						{!collapsible ? (
							<span>
								已拥有 {granted} / {effective.length} 项权限
							</span>
						) : null}
						<span className="inline-flex items-center gap-2">
							<Switch aria-label="只显示已拥有" checked={only} onCheckedChange={setOnly} />
							只显示已拥有
						</span>
					</div>
					<div className="space-y-3">
						{PERMISSION_GROUPS.map((g) => {
							const rows = PERMISSIONS.filter((p) => p.group === g.id && (!only || by.get(p.id)?.allow));
							if (!rows.length) return null;
							return (
								<section key={g.id}>
									<h4 className="mb-1 text-xs font-medium text-fg-muted">{groupLabel(g)}</h4>
									<ul className="divide-y divide-border rounded-lg border border-border bg-surface">
										{rows.map((p) => {
											const e = by.get(p.id);
											return (
												<li key={p.id} data-testid="eff-row" data-allow={e?.allow ? "1" : "0"} data-perm={p.id} className="px-3 py-2 text-sm">
													<div className="flex flex-wrap items-center gap-2">
														<span className={cn("inline-flex size-4 items-center justify-center rounded-full text-[12px] font-bold", e?.allow ? "bg-success-soft text-success" : "bg-surface-2 text-fg-muted")} role="img" aria-label={e?.allow ? "已拥有" : "未拥有"}>
															{e?.allow ? "✓" : "–"}
														</span>
														<span className="min-w-0 flex-1" title={p.id}>
															{permLabel(p)}
														</span>
														<RiskBadge risk={p.risk} />
														<button type="button" className="rounded px-1 text-xs text-info hover:underline" data-testid="why-btn" aria-expanded={why === p.id} onClick={() => setWhy(why === p.id ? undefined : p.id)}>
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
				</>
			) : null}
		</div>
	);
}

export function LockedNote({ children }: { children: ReactNode }) {
	return (
		<p className="mb-3 flex items-start gap-1.5 rounded-lg bg-surface-2 px-3 py-2 text-xs text-fg-muted">
			<Lock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
			<span>{children}</span>
		</p>
	);
}
