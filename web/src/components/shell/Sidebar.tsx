import { BarChart3, BookOpen, Clock4, Folders, LogOut, MessageSquarePlus, PanelLeftClose, Search, Settings, Shield, Sparkles, Workflow, X } from "lucide-react";
import { NavLink, useNavigate } from "react-router";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Tip } from "@/components/ui/overlay";
import { BrandMark } from "./BrandMark";
import { NotificationsBell } from "./Notifications";
import { useSearchModal } from "@/features/search/SearchProvider";
import { SidebarTree } from "./SidebarTree";

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const navCls = ({ isActive }: { isActive: boolean }) =>
	cn("flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors [&_svg]:size-[17px] [&_svg]:text-fg-muted", isActive ? "bg-surface-3 text-fg font-medium" : "text-fg hover:bg-surface-3/70");

export function Sidebar({ onCollapse, onNavigate, onClose }: { onCollapse?: () => void; onNavigate?: () => void; onClose?: () => void }) {
	const { brand, me, logout, isOrgAdmin } = useSession();
	const navigate = useNavigate();
	const search = useSearchModal();

	const go = (to: string) => {
		navigate(to);
		onNavigate?.();
	};

	return (
		<nav aria-label="主导航" className="flex h-full w-full flex-col bg-surface-2">
			<div className="flex h-14 shrink-0 items-center gap-2 px-3">
				<button onClick={() => go("/")} className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-1 hover:bg-surface-3/70">
					<BrandMark />
					<span className="truncate text-base font-semibold tracking-tight">{brand.name}</span>
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
				{onClose ? (
					<button onClick={onClose} aria-label="关闭导航" data-testid="close-drawer" className="inline-flex size-9 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-3 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
						<X className="size-[18px]" />
					</button>
				) : null}
			</div>

			<div className="flex flex-col gap-0.5 px-2">
				<button data-testid="nav-new-chat" onClick={() => go("/")} className={navCls({ isActive: false })}>
					<MessageSquarePlus />
					新对话
				</button>
				<button
					data-testid="nav-search"
					onClick={() => {
						onNavigate?.();
						search.open();
					}}
					aria-keyshortcuts="Control+K Meta+K"
					className={navCls({ isActive: false })}
				>
					<Search />
					搜索
					<kbd className="ml-auto hidden rounded border border-border px-1 font-sans text-xs text-fg-subtle lg:inline">{isMac() ? "⌘K" : "Ctrl K"}</kbd>
				</button>
				<NavLink to="/knowledge" onClick={onNavigate} className={navCls}>
					<BookOpen />
					个人知识库
				</NavLink>
				<NavLink to="/files" onClick={onNavigate} className={navCls}>
					<Folders />
					文件库
				</NavLink>
			</div>

			<SidebarTree onNavigate={onNavigate} />

			<div className="shrink-0 border-t border-border p-2">
				<Menu>
					<MenuTrigger asChild>
						<button data-testid="user-menu" className="flex h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left hover:bg-surface-3/70">
							<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-sm font-medium">{(me?.name ?? "?").slice(0, 1).toUpperCase()}</span>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-sm font-medium">{me?.name}</span>
								<span className="block truncate text-xs text-fg-muted">{me?.orgName}</span>
							</span>
						</button>
					</MenuTrigger>
					<MenuContent side="top" align="start" className="w-60">
						<MenuLabel>{me?.email}</MenuLabel>
						<MenuItem onSelect={() => go("/capabilities")}>
							<Sparkles />
							能力
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
		</nav>
	);
}
