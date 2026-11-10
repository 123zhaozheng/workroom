// 我的权限 (Settings): my roles with where they apply, direct grants / denies, and every effective permission with its reason
// (collapsed until asked for).
import type { MemberAccessDTO } from "@shared/permissions";
import { useApi } from "@/lib/useApi";
import { Badge, Loadable } from "@/components/ui/misc";
import { Section } from "@/features/admin/common";
import { EffectiveView, PERMISSIONS, ROLE_SHORT, permLabel, scopeText } from "@/features/admin/rbac-ui";

export function MyPermissionsSection() {
	const res = useApi<{ access: MemberAccessDTO }>("/me/permissions");
	const a = res.data?.access;
	return (
		<Section title="我的权限" testId="my-permissions">
			<div className="rounded-xl border border-border bg-surface p-4">
				<Loadable state={res} what="我的权限">
					{a ? (
						<div className="space-y-5">
							<div>
								<h3 className="mb-2 text-sm font-medium">我的角色</h3>
								<ul className="flex flex-wrap gap-1.5" data-testid="my-roles">
									{a.assignments.map((x) => (
										<li key={x.id}>
											<Badge tone={/^builtin:(owner|admin|member|guest)$/.test(x.roleId) && x.scope.kind === "org" ? "neutral" : "info"} title={x.via === "direct" ? undefined : `来自${x.via === "department" ? "部门" : "用户组"}「${x.viaName}」`}>
												{ROLE_SHORT[x.roleId] ?? x.roleName ?? x.roleId} · {scopeText(x.scope)}
												{x.via !== "direct" ? ` · 来自${x.via === "department" ? "部门" : "用户组"}` : ""}
											</Badge>
										</li>
									))}
								</ul>
								{a.departments.length ? <p className="mt-2 text-xs text-fg-muted">所属部门：{a.departments.map((d) => `${d.path}（${d.role === "manager" ? "负责人" : "成员"}）`).join("、")}</p> : null}
							</div>
							{a.grants.length ? (
								<div>
									<h3 className="mb-2 text-sm font-medium">管理员对我的单独设置</h3>
									<ul className="space-y-1.5 text-sm" data-testid="my-grants">
										{a.grants.map((g) => (
											<li key={g.id} className="flex flex-wrap items-center gap-2">
												<Badge tone={g.effect === "deny" ? "danger" : "success"}>{g.effect === "deny" ? "禁止" : "允许"}</Badge>
												<span>{PERMISSIONS.find((p) => p.id === g.permission) ? permLabel(PERMISSIONS.find((p) => p.id === g.permission)!) : g.permission}</span>
												<span className="text-xs text-fg-muted">
													{scopeText(g.scope)}
													{g.reason ? ` · ${g.reason}` : ""}
												</span>
											</li>
										))}
									</ul>
								</div>
							) : null}
							<div>
								<EffectiveView effective={a.effective} testId="my-effective" collapsible />
								{a.scoped.length ? (
									<ul className="mt-3 space-y-1 text-xs" data-testid="my-scoped">
										{a.scoped.map((s, i) => (
											<li key={i} className="rounded-lg bg-surface-2 px-2.5 py-1.5">
												<span className="font-medium">{scopeText(s.scope)}</span> 内另有：{s.permissions.map((p) => (PERMISSIONS.find((x) => x.id === p) ? permLabel(PERMISSIONS.find((x) => x.id === p)!) : p)).join("、")}
											</li>
										))}
									</ul>
								) : null}
							</div>
						</div>
					) : null}
				</Loadable>
			</div>
		</Section>
	);
}
