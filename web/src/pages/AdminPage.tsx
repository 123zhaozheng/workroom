import { Shield } from "lucide-react";
import { Navigate } from "react-router";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import { TopBar } from "@/components/shell/AppShell";
import { Badge, EmptyState, Loadable, Page, PageHeader } from "@/components/ui/misc";
import { listOf } from "@/features/chat/pickers";

interface MemberRow {
	userId?: string;
	id?: string;
	name: string;
	email: string;
	role: string;
	disabled?: boolean;
	disabledAt?: string;
}

/** Organisation administration — only reachable for org owners/admins (the server re-checks every call). */
export default function AdminPage() {
	const { isOrgAdmin, me } = useSession();
	const members = useApi<unknown>(isOrgAdmin ? "/admin/members" : null);
	if (!isOrgAdmin) return <Navigate to="/" replace />;
	const list = listOf<MemberRow>(members.data, "members", "users");
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page wide>
					<PageHeader title="组织管理" description={`${me?.orgName ?? ""} · 成员、模型渠道、预算与审计。普通成员看不到这个页面。`} />
					<h2 className="mb-2 text-[13px] font-medium text-fg-muted">成员</h2>
					<Loadable state={members} what="成员管理" need="E 组：GET /api/admin/members">
						{list.length === 0 ? (
							<EmptyState icon={<Shield />} title="没有成员数据" />
						) : (
							<div className="overflow-hidden rounded-xl border border-border bg-surface">
								{list.map((m, i) => (
									<div key={m.userId ?? m.id ?? m.email} className={`flex items-center gap-3 px-3 py-2.5 ${i ? "border-t border-border" : ""}`}>
										<span className="min-w-0 flex-1">
											<span className="block truncate text-sm">{m.name}</span>
											<span className="block truncate text-xs text-fg-subtle">{m.email}</span>
										</span>
										{m.disabled || m.disabledAt ? <Badge tone="danger">已停用</Badge> : null}
										<Badge>{m.role}</Badge>
									</div>
								))}
							</div>
						)}
					</Loadable>
				</Page>
			</div>
		</div>
	);
}
