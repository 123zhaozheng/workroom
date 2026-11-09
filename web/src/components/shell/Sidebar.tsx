import { BarChart3, BookOpen, ChevronRight, Clock4, FolderClosed, Folders, LogOut, MessageSquarePlus, PanelLeftClose, Plus, Search, Settings, Shield, Sparkles, Workflow } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { Collapsible } from "radix-ui";
import type { ConversationSummary } from "@shared/chat";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import { cn } from "@/lib/utils";
import type { Project } from "@/lib/types";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Tip } from "@/components/ui/overlay";
import { RunDot } from "@/features/chat/status";
import { BrandMark } from "./BrandMark";
import { NotificationsBell } from "./Notifications";
import { NewProjectDialog } from "@/features/projects/NewProjectDialog";

const navCls = ({ isActive }: { isActive: boolean }) =>
	cn("flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors [&_svg]:size-[17px] [&_svg]:text-fg-muted", isActive ? "bg-surface-3 text-fg font-medium" : "text-fg hover:bg-surface-3/70");

export function Sidebar({ onCollapse, onNavigate }: { onCollapse?: () => void; onNavigate?: () => void }) {
	const { brand, me, logout, isOrgAdmin } = useSession();
	const navigate = useNavigate();
	const projects = useApi<{ projects: Project[] }>("/projects", { pollMs: 30000 });
	const recent = useApi<{ conversations: ConversationSummary[] }>("/conversations?limit=40", { pollMs: 8000 });
	const [newProject, setNewProject] = useState(false);
	const { pathname } = useLocation();
	const reloadRecent = recent.reload;
	// Refresh titles / run states whenever the user moves between conversations, and when a conversation reports a change.
	useEffect(() => reloadRecent(), [pathname, reloadRecent]);
	useEffect(() => {
		const on = () => reloadRecent();
		window.addEventListener("wr:conversations-changed", on);
		return () => window.removeEventListener("wr:conversations-changed", on);
	}, [reloadRecent]);

	const go = (to: string) => {
		navigate(to);
		onNavigate?.();
	};
	const convs = (recent.data?.conversations ?? []).filter((c) => c.kind !== "subagent" && !c.archived);

	return (
		<nav aria-label="主导航" className="flex h-full w-full flex-col bg-surface-2">
			<div className="flex h-14 shrink-0 items-center gap-2 px-3">
				<button onClick={() => go("/")} className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-1 hover:bg-surface-3/70">
					<BrandMark />
					<span className="truncate text-[15px] font-semibold tracking-tight">{brand.name}</span>
				</button>
				<div className="flex-1" />
				<NotificationsBell onNavigate={onNavigate} />
				{onCollapse ? (
					<Tip label="收起侧栏" side="right">
						<button onClick={onCollapse} aria-label="收起侧栏" className="rounded-lg p-1.5 text-fg-muted hover:bg-surface-3 hover:text-fg">
							<PanelLeftClose className="size-[18px]" />
						</button>
					</Tip>
				) : null}
			</div>

			<div className="flex flex-col gap-0.5 px-2">
				<button data-testid="nav-new-chat" onClick={() => go("/")} className={navCls({ isActive: false })}>
					<MessageSquarePlus />
					新对话
				</button>
				<NavLink to="/search" onClick={onNavigate} className={navCls}>
					<Search />
					搜索
				</NavLink>
				<NavLink to="/knowledge" onClick={onNavigate} className={navCls}>
					<BookOpen />
					个人知识库
				</NavLink>
				<NavLink to="/files" onClick={onNavigate} className={navCls}>
					<Folders />
					文件库
				</NavLink>
			</div>

			<div className="wr-scroll mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
				<Section
					title="项目"
					storageKey="projects"
					action={
						<Tip label="新建项目">
							<button aria-label="新建项目" onClick={() => setNewProject(true)} className="rounded-md p-1 text-fg-subtle hover:bg-surface-3 hover:text-fg">
								<Plus className="size-3.5" />
							</button>
						</Tip>
					}
				>
					{projects.unavailable ? (
						<p className="px-2.5 py-1 text-xs text-fg-subtle">项目接口未连接</p>
					) : (projects.data?.projects ?? []).length === 0 ? (
						<p className="px-2.5 py-1 text-xs text-fg-subtle">还没有项目</p>
					) : (
						projects.data!.projects.map((p) => (
							<NavLink key={p.id} to={`/projects/${p.id}`} onClick={onNavigate} className={({ isActive }) => cn(navCls({ isActive }), "h-8")}>
								<FolderClosed />
								<span className="truncate">{p.name}</span>
							</NavLink>
						))
					)}
				</Section>
				<Section title="最近对话" storageKey="recent" defaultOpen>
					{recent.unavailable ? (
						<p className="px-2.5 py-1 text-xs text-fg-subtle">会话接口未连接</p>
					) : recent.error ? (
						<p className="px-2.5 py-1 text-xs text-danger">加载失败</p>
					) : convs.length === 0 && !recent.loading ? (
						<p className="px-2.5 py-1 text-xs text-fg-subtle">还没有对话</p>
					) : (
						convs.map((c) => (
							<NavLink
								key={`${c.spaceId}/${c.conversationId}`}
								to={`/c/${c.spaceId}/${c.conversationId}`}
								onClick={onNavigate}
								title={c.title}
								className={({ isActive }) => cn("group flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px]", isActive ? "bg-surface-3 font-medium text-fg" : "text-fg-muted hover:bg-surface-3/70 hover:text-fg")}
							>
								<span className="min-w-0 flex-1 truncate">{c.title || "未命名对话"}</span>
								{c.kind === "branch" ? <span className="text-[11px] text-fg-subtle">分支</span> : null}
								{c.status ? <RunDot status={c.status} /> : null}
							</NavLink>
						))
					)}
				</Section>
			</div>

			<div className="shrink-0 border-t border-border p-2">
				<Menu>
					<MenuTrigger asChild>
						<button data-testid="user-menu" className="flex h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left hover:bg-surface-3/70">
							<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[13px] font-medium">{(me?.name ?? "?").slice(0, 1).toUpperCase()}</span>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-[13px] font-medium">{me?.name}</span>
								<span className="block truncate text-[11px] text-fg-subtle">{me?.orgName}</span>
							</span>
						</button>
					</MenuTrigger>
					<MenuContent side="top" align="start" className="w-60">
						<MenuLabel>{me?.email}</MenuLabel>
						<MenuItem onSelect={() => go("/capabilities")}>
							<Sparkles />
							能力（技能与连接）
						</MenuItem>
						<MenuItem onSelect={() => go("/automations")}>
							<Workflow />
							自动化
						</MenuItem>
						<MenuItem onSelect={() => go("/memory")}>
							<Clock4 />
							记忆
						</MenuItem>
						<MenuItem onSelect={() => go("/stats")}>
							<BarChart3 />
							统计
						</MenuItem>
						{isOrgAdmin ? (
							<MenuItem data-testid="menu-admin" onSelect={() => go("/admin")}>
								<Shield />
								组织管理
							</MenuItem>
						) : null}
						<MenuSeparator />
						<MenuItem onSelect={() => go("/settings")}>
							<Settings />
							设置
						</MenuItem>
						<MenuItem
							onSelect={async () => {
								await logout();
								navigate("/login");
							}}
						>
							<LogOut />
							退出登录
						</MenuItem>
					</MenuContent>
				</Menu>
			</div>
			<NewProjectDialog
				open={newProject}
				onOpenChange={setNewProject}
				onCreated={(p) => {
					projects.reload();
					go(`/projects/${p.id}`);
				}}
			/>
		</nav>
	);
}

function Section({ title, children, action, defaultOpen, storageKey }: { title: string; children: ReactNode; action?: ReactNode; defaultOpen?: boolean; storageKey: string }) {
	const key = `wr.sidebar.${storageKey}`;
	const [open, setOpen] = useState(() => {
		try {
			const v = localStorage.getItem(key);
			return v === null ? !!defaultOpen : v === "1";
		} catch {
			return !!defaultOpen;
		}
	});
	return (
		<Collapsible.Root
			open={open}
			onOpenChange={(o) => {
				setOpen(o);
				try {
					localStorage.setItem(key, o ? "1" : "0");
				} catch {
					/* ignore */
				}
			}}
			className="mb-2"
		>
			<div className="flex items-center pr-1">
				<Collapsible.Trigger className="flex h-7 flex-1 items-center gap-1 rounded-md px-2.5 text-xs font-medium text-fg-subtle hover:text-fg">
					<ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
					{title}
				</Collapsible.Trigger>
				{action}
			</div>
			<Collapsible.Content className="flex flex-col gap-px">{children}</Collapsible.Content>
		</Collapsible.Root>
	);
}
