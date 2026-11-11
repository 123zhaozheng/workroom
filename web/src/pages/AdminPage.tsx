// 组织管理 — thin shell with a grouped left navigation (top row on phones). Each page lives in web/src/features/admin/**.
// Only pages the viewer has a permission for are listed (the server re-checks every call, so a hidden entry is a convenience,
// never the security boundary). URLs stay `?tab=<id>`.
import { ExternalLink } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { Link, Navigate, useSearchParams } from "react-router";
import { useSession } from "@/lib/session";
import { useMedia } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { TopBar } from "@/components/shell/AppShell";
import { Page, PageHeader } from "@/components/ui/misc";
import { Members } from "@/features/admin/MembersTab";
import { Invites } from "@/features/admin/InvitesTab";
import { OrgStructure } from "@/features/admin/OrgStructureTab";
import { Roles } from "@/features/admin/RolesTab";
import { Authorizations } from "@/features/admin/AuthzTab";
import { Sessions } from "@/features/admin/SessionsTab";
import { ModelsAdmin } from "@/features/admin/models/ModelsAdmin";
import { SandboxProviders } from "@/features/admin/SandboxProviders";
import { LocalExecAdmin } from "@/features/admin/LocalExecAdmin";
import { SandboxPrices } from "@/features/admin/SandboxPrices";
import { EnvVarsEditor } from "@/features/settings/EnvVars";
import { Budgets } from "@/features/admin/BudgetsTab";
import { Audit } from "@/features/admin/AuditTab";
import { Trace } from "@/features/admin/TraceTab";
import { useViewerPerms } from "@/features/admin/rbac-ui";

interface NavItem {
	value: string;
	label: string;
	/** Visible when the viewer holds ANY of these (at org scope or inside any department/project). */
	any: string[];
	/** Opens another page instead of a tab. */
	href?: string;
}
interface NavGroup {
	label: string;
	items: NavItem[];
}
const GROUPS: NavGroup[] = [
	{
		label: "成员与组织",
		items: [
			{ value: "members", label: "成员", any: ["member.view"] },
			{ value: "invites", label: "邀请", any: ["member.invite"] },
			{ value: "departments", label: "组织架构", any: ["dept.manage", "dept.member.manage", "member.view"] },
			{ value: "sessions", label: "登录会话", any: ["member.session.manage"] },
		],
	},
	{
		label: "角色与权限",
		items: [
			{ value: "roles", label: "角色", any: ["role.view", "role.manage"] },
			{ value: "authz", label: "授权", any: ["role.assign", "role.view"] },
		],
	},
	{ label: "模型", items: [{ value: "models", label: "模型服务", any: ["model.manage", "model.provider.manage"] }] },
	{ label: "工作区运行", items: [{ value: "sandbox", label: "沙箱", any: ["sandbox.policy.manage"] }, { value: "env", label: "环境变量", any: ["sandbox.policy.manage"] }] },
	{ label: "技能与连接", items: [{ value: "market-review", label: "技能与连接审核", any: ["skill.review", "mcp.connector.review"], href: "/capabilities?tab=review" }] },
	{ label: "用量与预算", items: [{ value: "budgets", label: "预算", any: ["budget.view", "budget.manage"] }] },
	{
		label: "审计",
		items: [
			{ value: "audit", label: "审计日志", any: ["audit.view"] },
			{ value: "trace", label: "问题排查", any: ["trace.view"] },
		],
	},
];

export default function AdminPage() {
	const { me } = useSession();
	const perms = useViewerPerms();
	const wide = useMedia("(min-width: 768px)");
	const [sp] = useSearchParams();
	const [rov, setRov] = useState<string>();
	const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((t) => t.any.some((p) => perms.anywhere.has(p))) })).filter((g) => g.items.length);
	const tabs = groups.flatMap((g) => g.items).filter((t) => !t.href);
	if (!me) return null;
	if (groups.length === 0) return <Navigate to="/" replace />;
	const requested = sp.get("tab");
	const tab = tabs.some((t) => t.value === requested) ? requested! : tabs[0]?.value;
	const current = tabs.find((t) => t.value === tab);
	// Roving tab stop: the navigation is one Tab stop (the focused / current entry); arrows move inside it.
	const stop = rov ?? tab;

	// Up/Down (wide) or Left/Right (phones) move between entries; Tab / Enter work natively because every entry is a link.
	const onKeys = (e: KeyboardEvent<HTMLElement>) => {
		const keys = wide ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
		if (!keys.includes(e.key) && e.key !== "Home" && e.key !== "End") return;
		const links = [...e.currentTarget.querySelectorAll<HTMLAnchorElement>("a[data-nav]")];
		const i = links.indexOf(document.activeElement as HTMLAnchorElement);
		if (i < 0) return;
		e.preventDefault();
		const next = e.key === "Home" ? 0 : e.key === "End" ? links.length - 1 : (i + (e.key === keys[1] ? 1 : -1) + links.length) % links.length;
		links[next]?.focus();
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page wide>
					<PageHeader title="组织管理" />
					<div className="flex flex-col gap-5 md:flex-row md:items-start md:gap-8">
						<nav aria-label="组织管理" data-testid="admin-tabs" onKeyDown={onKeys} className="-mx-4 overflow-x-auto px-4 md:sticky md:top-0 md:mx-0 md:w-48 md:shrink-0 md:overflow-visible md:px-0">
							<div className="flex w-max items-center gap-1 md:w-auto md:flex-col md:items-stretch md:gap-5">
								{groups.map((g) => (
									<div key={g.label} className="flex items-center gap-1 md:flex-col md:items-stretch md:gap-0.5" role="group" aria-label={g.label}>
										<div className="hidden px-2.5 pb-1 text-xs font-medium text-fg-subtle md:block">{g.label}</div>
										{g.items.map((t) => {
											const active = !t.href && t.value === tab;
											const cls = cn("inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-sm", active ? "bg-surface-2 font-medium text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg");
											return t.href ? (
												<Link key={t.value} to={t.href} data-nav data-testid={`admin-nav-${t.value}`} tabIndex={stop === t.value ? 0 : -1} onFocus={() => setRov(t.value)} className={cls}>
													{t.label}
													<ExternalLink aria-hidden className="size-3.5" />
												</Link>
											) : (
												<Link key={t.value} to={{ search: `?tab=${t.value}` }} data-nav data-testid={`admin-tab-${t.value}`} aria-current={active ? "page" : undefined} tabIndex={stop === t.value ? 0 : -1} onFocus={() => setRov(t.value)} className={cls}>
													{t.label}
												</Link>
											);
										})}
										<span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border md:hidden" />
									</div>
								))}
							</div>
						</nav>
						<main className="min-w-0 flex-1" aria-label={current?.label}>
							{current ? <h2 className="mb-4 text-base font-semibold tracking-tight">{current.label}</h2> : null}
							{tab === "members" ? <Members selfId={me.userId} /> : null}
							{tab === "invites" ? <Invites /> : null}
							{tab === "departments" ? <OrgStructure /> : null}
							{tab === "sessions" ? <Sessions /> : null}
							{tab === "roles" ? <Roles /> : null}
							{tab === "authz" ? <Authorizations /> : null}
							{tab === "models" ? <ModelsAdmin /> : null}
							{tab === "sandbox" ? <><LocalExecAdmin /><SandboxProviders /><SandboxPrices /></> : null}
							{tab === "env" ? (
								<div data-testid="admin-env" className="space-y-3">
									<EnvVarsEditor scope="org" scopeRef={me.orgId} editable testId="env-vars-org" />
								</div>
							) : null}
							{tab === "budgets" ? <Budgets /> : null}
							{tab === "audit" ? <Audit /> : null}
							{tab === "trace" ? <Trace /> : null}
						</main>
					</div>
				</Page>
			</div>
		</div>
	);
}
