import { Menu as MenuIcon, PanelLeftOpen } from "lucide-react";
import { createContext, lazy, Suspense, useContext, useEffect, useState, type ReactNode } from "react";
import { Outlet, useLocation } from "react-router";
import { useMedia, usePrefs } from "@/lib/prefs";
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

export function AppShell() {
	return (
		<PanelProvider>
			<ShellLayout />
		</PanelProvider>
	);
}

function ShellLayout() {
	const wide = useMedia(WIDE_QUERY);
	const { sidebarCollapsed, set } = usePrefs();
	const [drawerOpen, setDrawerOpen] = useState(false);
	const { panel, close } = usePanel();
	const loc = useLocation();

	// Navigating away closes the panel and the mobile drawer.
	useEffect(() => {
		close();
		setDrawerOpen(false);
	}, [loc.pathname, close]);

	const sidebarInline = wide && !sidebarCollapsed;
	const ctx: ShellCtx = { sidebarHidden: !sidebarInline, openSidebar: () => (wide ? set("sidebarCollapsed", false) : setDrawerOpen(true)), wide };

	const panelBody = panel ? (
		<Suspense
			fallback={
				<div className="flex h-full items-center justify-center gap-2 text-[13px] text-fg-subtle">
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
				{sidebarInline ? (
					<aside data-testid="sidebar" className="w-[var(--sidebar-w)] shrink-0 border-r border-border">
						<Sidebar onCollapse={() => set("sidebarCollapsed", true)} />
					</aside>
				) : null}
				{!wide ? (
					<Sheet open={drawerOpen} onOpenChange={setDrawerOpen} side="left" title="导航">
						<Sidebar onNavigate={() => setDrawerOpen(false)} />
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
					<button data-testid="open-sidebar" aria-label={wide ? "展开侧栏" : "打开导航"} onClick={openSidebar} className="rounded-lg p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg">
						{wide ? <PanelLeftOpen className="size-[18px]" /> : <MenuIcon className="size-5" />}
					</button>
				</Tip>
			) : null}
			<div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
			{right ? <div className="flex shrink-0 items-center gap-1">{right}</div> : null}
		</header>
	);
}
