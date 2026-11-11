import { Menu as MenuIcon, PanelLeftOpen } from "lucide-react";
import { createContext, lazy, Suspense, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Outlet, useLocation } from "react-router";
import { useMedia, usePrefs } from "@/lib/prefs";
import { SearchProvider } from "@/features/search/SearchProvider";
import { cn } from "@/lib/utils";
import { Sheet, Tip } from "@/components/ui/overlay";
import { Spinner } from "@/components/ui/misc";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { Sidebar } from "./Sidebar";
import { PanelProvider, usePanel } from "./panel";

// The right panel bodies are separate chunks: nothing of preview/work panel code loads until opened.
const PreviewPanel = lazy(() => import("@/features/preview/PreviewPanel"));
const WorkPanel = lazy(() => import("@/features/work/WorkPanel"));

interface ShellCtx {
	/** Sidebar is not visible on screen (collapsed on desktop, or narrow screen). */
	sidebarHidden: boolean;
	openSidebar: () => void;
	wide: boolean;
}
const Ctx = createContext<ShellCtx>({ sidebarHidden: false, openSidebar: () => {}, wide: true });
export const useShell = () => useContext(Ctx);

export const WIDE_QUERY = "(min-width: 1024px)";

/** Radix returns focus only to a Dialog.Trigger; our drawers and panels are opened by outside buttons, so put focus back ourselves. */
function useRestoreFocus(open: boolean) {
	const opener = useRef<HTMLElement | null>(null);
	const was = useRef(false);
	useLayoutEffect(() => {
		if (open && !was.current) opener.current = document.activeElement as HTMLElement | null;
		if (!open && was.current) {
			const el = opener.current;
			opener.current = null;
			if (el && el !== document.body && el.isConnected) setTimeout(() => el.focus(), 0);
		}
		was.current = open;
	}, [open]);
}

/**
 * Keeps the sidebar mounted while it slides shut (width transition), and mounts it at width 0 before it opens.
 * `show` follows the layout state immediately; `mounted` lags on the way out. No motion when reduced.
 */
function useSidebarPresence(inline: boolean, reduced: boolean) {
	const [mounted, setMounted] = useState(inline);
	const [expanded, setExpanded] = useState(inline);
	useEffect(() => {
		if (inline) {
			setMounted(true);
			if (reduced) setExpanded(true);
			else {
				const id = requestAnimationFrame(() => requestAnimationFrame(() => setExpanded(true)));
				return () => cancelAnimationFrame(id);
			}
		} else {
			setExpanded(false);
			if (reduced) setMounted(false);
			else {
				const t = setTimeout(() => setMounted(false), 260);
				return () => clearTimeout(t);
			}
		}
	}, [inline, reduced]);
	return { render: inline || mounted, expanded: reduced ? inline : expanded && inline };
}

export function AppShell() {
	return (
		<PanelProvider>
			<SearchProvider>
				<ShellLayout />
			</SearchProvider>
		</PanelProvider>
	);
}

function ShellLayout() {
	const wide = useMedia(WIDE_QUERY);
	const { sidebarCollapsed, set, motionReduced } = usePrefs();
	const [drawerOpen, setDrawerOpen] = useState(false);
	const { panel, close } = usePanel();
	const loc = useLocation();
	useRestoreFocus(drawerOpen);
	useRestoreFocus(!!panel);

	// Navigating away closes the panel and the mobile drawer.
	useEffect(() => {
		close();
		setDrawerOpen(false);
	}, [loc.pathname, close]);

	const sidebarInline = wide && !sidebarCollapsed;
	const presence = useSidebarPresence(sidebarInline, motionReduced);
	const ctx: ShellCtx = { sidebarHidden: !sidebarInline, openSidebar: () => (wide ? set("sidebarCollapsed", false) : setDrawerOpen(true)), wide };

	const panelBody = panel ? (
		<Suspense
			fallback={
				<div role="status" className="flex h-full items-center justify-center gap-2 text-sm text-fg-muted">
					<Spinner /> 正在加载…
				</div>
			}
		>
			<ErrorBoundary label="面板" resetKey={panel}>
				{panel.kind === "preview" ? <PreviewPanel target={panel.target} onClose={close} /> : <WorkPanel state={panel} onClose={close} />}
			</ErrorBoundary>
		</Suspense>
	) : null;

	return (
		<Ctx.Provider value={ctx}>
			<div className="flex h-dvh w-full overflow-hidden bg-bg">
				{wide && presence.render ? (
					<aside
						data-testid="sidebar"
						data-state={presence.expanded ? "open" : "closed"}
						inert={!sidebarInline}
						aria-hidden={!sidebarInline || undefined}
						style={{ width: presence.expanded ? "var(--sidebar-w)" : 0 }}
						className={cn("shrink-0 overflow-hidden border-border", presence.expanded ? "border-r" : "border-r-0", motionReduced ? "" : "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)]")}
					>
						<div className="h-full w-[var(--sidebar-w)]">
							<Sidebar onCollapse={() => set("sidebarCollapsed", true)} />
						</div>
					</aside>
				) : null}
				{!wide ? (
					<Sheet open={drawerOpen} onOpenChange={setDrawerOpen} side="left" title="导航">
						<Sidebar onNavigate={() => setDrawerOpen(false)} onClose={() => setDrawerOpen(false)} />
					</Sheet>
				) : null}
				<main className="flex min-w-0 flex-1 flex-col">
					<ErrorBoundary label="页面" resetKey={loc.pathname}>
						<Outlet />
					</ErrorBoundary>
				</main>
				{panel && wide ? (
					<aside data-testid="side-panel" className="flex w-[clamp(380px,40vw,680px)] shrink-0 flex-col border-l border-border bg-surface wr-drawer-right">
						{panelBody}
					</aside>
				) : null}
				{!wide ? (
					<Sheet open={!!panel} onOpenChange={(o) => !o && close()} side="right" title={panel?.kind === "preview" ? "预览" : "工作面板"}>
						<div data-testid="side-drawer" className="flex h-full flex-col">
							{panelBody}
						</div>
					</Sheet>
				) : null}
			</div>
		</Ctx.Provider>
	);
}

/** Page top bar: shows the sidebar opener when the sidebar is hidden. */
export function TopBar({ children, right, className }: { children?: ReactNode; right?: ReactNode; className?: string }) {
	const { sidebarHidden, openSidebar, wide } = useShell();
	return (
		<header className={cn("flex h-14 shrink-0 items-center gap-2 px-3 sm:px-4", className)}>
			{sidebarHidden ? (
				<Tip label={wide ? "展开侧栏" : "打开导航"}>
					<button data-testid="open-sidebar" aria-label={wide ? "展开侧栏" : "打开导航"} onClick={openSidebar} className="inline-flex size-9 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
						{wide ? <PanelLeftOpen className="size-[18px]" /> : <MenuIcon className="size-5" />}
					</button>
				</Tip>
			) : null}
			<div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
			{right ? <div className="flex shrink-0 items-center gap-1">{right}</div> : null}
		</header>
	);
}
