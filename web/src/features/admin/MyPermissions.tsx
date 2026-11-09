// 我的权限 (Settings): my base role and extra roles with scope, direct grants / denies and every effective permission with its reason.
import type { MemberAccessDTO } from "@shared/permissions";
import { useApi } from "@/lib/useApi";
import { Badge, Loadable } from "@/components/ui/misc";
import { EffectiveView, ROLE_SHORT, scopeText } from "@/features/admin/rbac-ui";

export function MyPermissionsSection() {
	const res = useApi<{ access: MemberAccessDTO }>("/me/permissions");
	const a = res.data?.access;
	return (
		<section className="mb-8" data-testid="my-permissions">
			<h2 className="mb-2 text-[13px] font-medium text-fg-muted">我的权限</h2>
			<div className="rounded-xl border border-border bg-surface p-4">
				<Loadable state={res} what="我的权限" need="RBAC：GET /api/me/permissions">
					{a ? (
						<div className="space-y-4">
							<div>
								<h3 className="mb-1.5 text-xs font-medium text-fg-muted">我的角色</h3>
								<ul className="flex flex-wrap gap-1.5" data-testid="my-roles">
									{a.assignments.map((x) => (
										<li key={x.id}>
											<Badge tone={/^builtin:(owner|admin|member|guest)$/.test(x.roleId) && x.scope.kind === "org" ? "neutral" : "info"} title={x.via === "direct" ? undefined : `经${x.via === "department" ? "部门" : "用户组"}「${x.viaName}」`}>
												{ROLE_SHORT[x.roleId] ?? x.roleName ?? x.roleId} · {scopeText(x.scope)}
												{x.via !== "direct" ? ` · 经${x.via === "department" ? "部门" : "用户组"}` : ""}
											</Badge>
										</li>
									))}
								</ul>
							</div>
							{a.departments.length ? (
								<p className="text-xs text-fg-muted">
									所属部门：{a.departments.map((d) => `${d.path}（${d.role === "manager" ? "负责人" : "成员"}）`).join("、")}
								</p>
							) : null}
							{a.grants.length ? (
								<div>
									<h3 className="mb-1.5 text-xs font-medium text-fg-muted">管理员对我的单独授权 / 禁止</h3>
									<ul className="space-y-1 text-[13px]" data-testid="my-grants">
										{a.grants.map((g) => (
											<li key={g.id} className="flex flex-wrap items-center gap-2">
												<Badge tone={g.effect === "deny" ? "danger" : "success"}>{g.effect === "deny" ? "禁止" : "允许"}</Badge>
												<span>{g.permission}</span>
												<span className="text-xs text-fg-subtle">
													{scopeText(g.scope)}
													{g.reason ? ` · ${g.reason}` : ""}
												</span>
											</li>
										))}
									</ul>
								</div>
							) : null}
							<div>
								<h3 className="mb-1.5 text-xs font-medium text-fg-muted">有效权限</h3>
								<EffectiveView effective={a.effective} testId="my-effective" />
								{a.scoped.length ? (
									<ul className="mt-2 space-y-1 text-xs" data-testid="my-scoped">
										{a.scoped.map((s, i) => (
											<li key={i} className="rounded-lg bg-surface-2 px-2.5 py-1.5">
												<span className="font-medium">{scopeText(s.scope)}</span> 内另有：{s.permissions.join("、")}
											</li>
										))}
									</ul>
								) : null}
							</div>
						</div>
					) : null}
				</Loadable>
			</div>
		</section>
	);
}
