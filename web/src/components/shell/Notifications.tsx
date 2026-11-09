// In-app notifications (M12-C): each carries the task link, status and the run's deliverables. A small bell in
// the sidebar header — not a panel. Delivery failures of other channels are shown on the automation run, not here.
import { Bell, CheckCheck, FileText, MessageSquare } from "lucide-react";
import { Link } from "react-router";
import type { NotificationDTO } from "@shared/ops";
import { post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { cn, relTime } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlay";
import { Badge } from "@/components/ui/misc";
import { RUN } from "@/pages/automationStatus";

export function NotificationsBell({ onNavigate }: { onNavigate?: () => void }) {
	const res = useApi<{ notifications: NotificationDTO[]; unread: number }>("/notifications", { pollMs: 15000 });
	if (res.unavailable || res.error) return null;
	const list = res.data?.notifications ?? [];
	const unread = res.data?.unread ?? 0;
	const read = async (n: NotificationDTO) => {
		if (!n.readAt) await post(`/notifications/${n.id}/read`).catch(() => {});
		res.reload();
		onNavigate?.();
	};
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button data-testid="notifications" aria-label={unread ? `通知（${unread} 条未读）` : "通知"} className="relative rounded-lg p-1.5 text-fg-muted hover:bg-surface-3 hover:text-fg">
					<Bell className="size-[18px]" />
					{unread ? (
						<span data-testid="notifications-unread" className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
							{unread > 99 ? "99+" : unread}
						</span>
					) : null}
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-[min(360px,calc(100vw-24px))] p-0">
				<div className="flex items-center gap-2 border-b border-border px-3 py-2">
					<span className="text-[13px] font-medium">通知</span>
					<span className="flex-1" />
					{unread ? (
						<button className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg" onClick={() => post("/notifications/read-all").then(res.reload)}>
							<CheckCheck className="size-3.5" />
							全部已读
						</button>
					) : null}
				</div>
				<ul className="wr-scroll max-h-[60vh] overflow-y-auto" data-testid="notification-list">
					{list.length === 0 ? <li className="px-3 py-6 text-center text-[13px] text-fg-subtle">没有通知</li> : null}
					{list.map((n) => {
						const st = n.status && n.status in RUN ? RUN[n.status as keyof typeof RUN] : undefined;
						return (
							<li key={n.id} data-testid="notification" className={cn("border-b border-border px-3 py-2.5 last:border-0", !n.readAt && "bg-info-soft/30")}>
								<div className="flex items-center gap-2">
									<span className="min-w-0 flex-1 truncate text-[13px] font-medium">{n.title}</span>
									{st ? <Badge tone={st.tone}>{st.label}</Badge> : null}
								</div>
								{n.body ? <p className="mt-0.5 line-clamp-2 text-xs text-fg-muted">{n.body}</p> : null}
								<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
									{n.link ? (
										<Link to={n.link} onClick={() => read(n)} className="inline-flex items-center gap-1 text-info hover:underline" data-testid="notification-link">
											<MessageSquare className="size-3" />
											打开任务
										</Link>
									) : null}
									{n.refs
										.filter((r) => r.kind === "file")
										.map((r) => (
											<Link key={r.id} to={`/files/${r.id}`} onClick={() => read(n)} className="inline-flex items-center gap-1 text-info hover:underline">
												<FileText className="size-3" />
												{r.label ?? "成果"}
											</Link>
										))}
									<span className="text-fg-subtle">{relTime(n.createdAt)}</span>
								</div>
							</li>
						);
					})}
				</ul>
			</PopoverContent>
		</Popover>
	);
}
