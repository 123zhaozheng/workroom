// 组织管理 — thin tab shell. Each tab lives in web/src/features/admin/**; the server re-checks every call.
import { Navigate, useSearchParams } from "react-router";
import { useSession } from "@/lib/session";
import { TopBar } from "@/components/shell/AppShell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Page, PageHeader } from "@/components/ui/misc";
import { Members } from "@/features/admin/MembersTab";
import { Invites } from "@/features/admin/InvitesTab";
import { Departments } from "@/features/admin/DepartmentsTab";
import { Sessions } from "@/features/admin/SessionsTab";
import { ModelsAdmin } from "@/features/admin/models/ModelsAdmin";
import { Budgets } from "@/features/admin/BudgetsTab";
import { Audit } from "@/features/admin/AuditTab";
import { Trace } from "@/features/admin/TraceTab";

export default function AdminPage() {
	const { isOrgAdmin, me } = useSession();
	const [sp, setSp] = useSearchParams();
	if (!isOrgAdmin) return <Navigate to="/" replace />;
	const tab = sp.get("tab") ?? "members";
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page wide>
					<PageHeader title="组织管理" description={`${me?.orgName ?? ""} · 所有变更都会记入审计。普通成员看不到这个页面，服务端也会拒绝其请求。`} />
					<Tabs value={tab} onValueChange={(v) => setSp({ tab: v })}>
						<div className="mb-5 overflow-x-auto">
							<TabsList>
								<TabsTrigger value="members">成员</TabsTrigger>
								<TabsTrigger value="invites">邀请</TabsTrigger>
								<TabsTrigger value="departments">部门</TabsTrigger>
								<TabsTrigger value="sessions">会话</TabsTrigger>
								<TabsTrigger value="models">模型与渠道</TabsTrigger>
								<TabsTrigger value="budgets">预算</TabsTrigger>
								<TabsTrigger value="audit">审计</TabsTrigger>
								<TabsTrigger value="trace">排查</TabsTrigger>
							</TabsList>
						</div>
						<TabsContent value="members">{tab === "members" ? <Members selfId={me?.userId} /> : null}</TabsContent>
						<TabsContent value="invites">{tab === "invites" ? <Invites /> : null}</TabsContent>
						<TabsContent value="departments">{tab === "departments" ? <Departments /> : null}</TabsContent>
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
