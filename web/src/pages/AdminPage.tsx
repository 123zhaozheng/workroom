// 组织管理 — thin tab shell. Each tab lives in web/src/features/admin/**. Only tabs the viewer has a permission for are shown
// (the server re-checks every call, so a hidden tab is a convenience, never the security boundary).
import { Navigate, useSearchParams } from "react-router";
import { useSession } from "@/lib/session";
import { TopBar } from "@/components/shell/AppShell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Page, PageHeader } from "@/components/ui/misc";
import { Members } from "@/features/admin/MembersTab";
import { Invites } from "@/features/admin/InvitesTab";
import { OrgStructure } from "@/features/admin/OrgStructureTab";
import { Roles } from "@/features/admin/RolesTab";
import { Authorizations } from "@/features/admin/AuthzTab";
import { Sessions } from "@/features/admin/SessionsTab";
import { ModelsAdmin } from "@/features/admin/models/ModelsAdmin";
import { Budgets } from "@/features/admin/BudgetsTab";
import { Audit } from "@/features/admin/AuditTab";
import { Trace } from "@/features/admin/TraceTab";
import { useViewerPerms } from "@/features/admin/rbac-ui";

interface TabDef {
	value: string;
	label: string;
	/** Visible when the viewer holds ANY of these (at org scope or inside any department/project). */
	any: string[];
}
const TABS: TabDef[] = [
	{ value: "members", label: "成员", any: ["member.view"] },
	{ value: "invites", label: "邀请", any: ["member.invite"] },
	{ value: "departments", label: "组织架构", any: ["dept.manage", "dept.member.manage", "member.view"] },
	{ value: "roles", label: "角色与权限", any: ["role.view", "role.manage"] },
	{ value: "authz", label: "授权", any: ["role.assign", "role.view"] },
	{ value: "sessions", label: "会话", any: ["member.session.manage"] },
	{ value: "models", label: "模型与渠道", any: ["model.manage", "model.provider.manage"] },
	{ value: "budgets", label: "预算", any: ["budget.view", "budget.manage"] },
	{ value: "audit", label: "审计", any: ["audit.view"] },
	{ value: "trace", label: "排查", any: ["trace.view"] },
];

export default function AdminPage() {
	const { me } = useSession();
	const perms = useViewerPerms();
	const [sp, setSp] = useSearchParams();
	const visible = TABS.filter((t) => t.any.some((p) => perms.anywhere.has(p)));
	if (!me) return null;
	if (visible.length === 0) return <Navigate to="/" replace />;
	const requested = sp.get("tab");
	const tab = visible.some((t) => t.value === requested) ? requested! : visible[0]!.value;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page wide>
					<PageHeader title="组织管理" description={`${me.orgName ?? ""} · 你只会看到自己有权限的页面；所有变更都会记入审计，服务端会逐项再次校验。`} />
					<Tabs value={tab} onValueChange={(v) => setSp({ tab: v })}>
						<div className="mb-5 overflow-x-auto">
							<TabsList data-testid="admin-tabs" className="w-max">
								{visible.map((t) => (
									<TabsTrigger key={t.value} value={t.value} data-testid={`admin-tab-${t.value}`} className="shrink-0 whitespace-nowrap">
										{t.label}
									</TabsTrigger>
								))}
							</TabsList>
						</div>
						<TabsContent value="members">{tab === "members" ? <Members selfId={me.userId} /> : null}</TabsContent>
						<TabsContent value="invites">{tab === "invites" ? <Invites /> : null}</TabsContent>
						<TabsContent value="departments">{tab === "departments" ? <OrgStructure /> : null}</TabsContent>
						<TabsContent value="roles">{tab === "roles" ? <Roles /> : null}</TabsContent>
						<TabsContent value="authz">{tab === "authz" ? <Authorizations /> : null}</TabsContent>
						<TabsContent value="sessions">{tab === "sessions" ? <Sessions /> : null}</TabsContent>
						<TabsContent value="models">{tab === "models" ? <ModelsAdmin /> : null}</TabsContent>
						<TabsContent value="budgets">{tab === "budgets" ? <Budgets /> : null}</TabsContent>
						<TabsContent value="audit">{tab === "audit" ? <Audit /> : null}</TabsContent>
						<TabsContent value="trace">{tab === "trace" ? <Trace /> : null}</TabsContent>
					</Tabs>
				</Page>
			</div>
		</div>
	);
}
