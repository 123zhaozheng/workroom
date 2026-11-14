import { BarChart3, BookOpen, ChevronRight, ClipboardCheck, Clock4, Folders, UserRoundCog, LogOut, MessageSquarePlus, PanelLeftClose, Search, Settings, Shield, Sparkles, Workflow, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { usePrefs } from "@/lib/prefs";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import { cn } from "@/lib/utils";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Tip } from "@/components/ui/overlay";
import { useMarketMe } from "@/features/market/common";
import { BrandMark } from "./BrandMark";
import { Collapse } from "./Collapse";
import { NotificationsBell } from "./Notifications";
import { useSearchModal } from "@/features/search/SearchProvider";
import { SidebarTree } from "./SidebarTree";

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const readBool = (key: string, fallback: boolean): boolean => {
	try {
		const raw = localStorage.getItem(key);
		return raw === null ? fallback : raw === "true";
	} catch {
		return fallback;
	}
};
const writeBool = (key: string, v: boolean) => {
	try {
		localStorage.setItem(key, String(v));
	} catch {
		/* storage unavailable */
	}
};

const navCls = ({ isActive }: { isActive: boolean }) =>
	cn("flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors [&_svg]:size-[17px] [&_svg]:text-fg-muted", isActive ? "bg-surface-3 text-fg font-medium" : "text-fg hover:bg-surface-3/70");

export function Sidebar({ onCollapse, onNavigate, onClose }: { onCollapse?: () => void; onNavigate?: () => void; onClose?: () => void }) {
	const { brand, me, logout, isOrgAdmin } = useSession();
	const { motionReduced } = usePrefs();
	const { pathname } = useLocation();
	const navigate = useNavigate();
	const search = useSearchModal();
	const moreId = useId();
	const uid = me?.userId ?? "anon";
	const moreKey = `wr.sidebar.${uid}.more`;
	const onCapabilities = pathname === "/capabilities" || pathname.startsWith("/capabilities/");
	const [moreOpen, setMoreOpen] = useState<boolean>(() => onCapabilities || readBool(moreKey, false));
	useEffect(() => {
		setMoreOpen(onCapabilities || readBool(moreKey, false));
	}, [moreKey]); // eslint-disable-line react-hooks/exhaustive-deps
	useEffect(() => {
		if (onCapabilities) {
			setMoreOpen(true);
			writeBool(moreKey, true);
		}
	}, [onCapabilities, moreKey]);
	const toggleMore = () =>
		setMoreOpen((o) => {
			const next = !o;
			writeBool(moreKey, next);
			return next;
		});

	const marketMe = useMarketMe();
	const canReview = !!marketMe.data?.me.canReview;
	const reviewQueue = useApi<{ submissions: unknown[] }>(canReview ? "/market/submissions?view=queue" : null, { pollMs: 30000 });
	const reviewCount = reviewQueue.data?.submissions.length ?? 0;

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
				<NavLink to="/experts" onClick={onNavigate} className={navCls} data-testid="nav-experts">
					<UserRoundCog />
					专家
				</NavLink>
				<button type="button" onClick={toggleMore} aria-expanded={moreOpen} aria-controls={moreId} data-testid="nav-more" className={cn(navCls({ isActive: false }), "w-full")}>
					<ChevronRight className={cn("transition-transform duration-200", moreOpen && "rotate-90")} />
					更多
				</button>
				<Collapse id={moreId} open={moreOpen} instant={motionReduced}>
					<div className="flex flex-col gap-0.5 pt-0.5">
						<NavLink to="/capabilities" onClick={onNavigate} data-testid="nav-capabilities" className={({ isActive }) => cn(navCls({ isActive }), "pl-7")}>
							<Sparkles />
							能力
						</NavLink>
					</div>
				</Collapse>
			</div>

			<SidebarTree onNavigate={onNavigate} />

			<div className="shrink-0 border-t border-border p-2">
				<Menu onOpenChange={(o) => { if (o && canReview) reviewQueue.reload(); }}>
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
						{canReview ? (
							<MenuItem data-testid="menu-reviews" onSelect={() => go("/reviews")}>
								<ClipboardCheck />
								待审核
								{reviewCount > 0 ? (
									<span className="ml-auto rounded-full bg-warning-soft px-1.5 text-xs text-warning" data-testid="review-count">
										{reviewCount}
									</span>
								) : null}
							</MenuItem>
						) : null}
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
