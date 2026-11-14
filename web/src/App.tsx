import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { LazyMotion, MotionConfig, domAnimation } from "motion/react";
import { PrefsProvider, usePrefs } from "@/lib/prefs";
import { SessionProvider, useSession } from "@/lib/session";
import { TooltipProvider } from "@/components/ui/overlay";
import { Spinner } from "@/components/ui/misc";
import { AppShell } from "@/components/shell/AppShell";
import { AuthPage } from "@/pages/AuthPage";
import { HomePage } from "@/pages/HomePage";
import { OnboardingGuard } from "@/features/onboarding/OnboardingGuard";

// Secondary pages are separate chunks so the home / chat path stays light.
const ChatPage = lazy(() => import("@/pages/ChatPage").then((m) => ({ default: m.ChatPage })));
const SharedPage = lazy(() => import("@/features/share/Share").then((m) => ({ default: m.SharedPage })));
const SearchPage = lazy(() => import("@/pages/SearchPage"));
const KnowledgePage = lazy(() => import("@/pages/KnowledgePage"));
const FilesPage = lazy(() => import("@/pages/FilesPage"));
const ExpertsPage = lazy(() => import("@/features/experts/ExpertsPage"));
const ProjectPage = lazy(() => import("@/pages/ProjectPage"));
const SettingsPage = lazy(() => import("@/pages/SettingsPage"));
const AutomationsPage = lazy(() => import("@/pages/AutomationsPage"));
const CapabilitiesPage = lazy(() => import("@/pages/CapabilitiesPage"));
const StatsPage = lazy(() => import("@/pages/StatsPage"));
const AdminPage = lazy(() => import("@/pages/AdminPage"));
const MemoryPage = lazy(() => import("@/pages/MemoryPage"));

function Splash() {
	return (
		<div className="flex h-dvh items-center justify-center gap-2 text-[13px] text-fg-subtle">
			<Spinner /> 正在加载…
		</div>
	);
}

function RequireAuth({ children }: { children: ReactNode }) {
	const { status } = useSession();
	const loc = useLocation();
	if (status === "loading") return <Splash />;
	if (status === "offline")
		return (
			<div className="flex h-dvh flex-col items-center justify-center gap-2 p-6 text-center">
				<div className="text-[15px] font-medium">无法连接服务器</div>
				<div className="text-[13px] text-fg-muted">请检查网络或服务是否已启动，然后刷新页面。</div>
			</div>
		);
	if (status !== "authenticated") return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
	return <>{children}</>;
}

function Lazy({ children }: { children: ReactNode }) {
	return <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Spinner /></div>}>{children}</Suspense>;
}

function Motion({ children }: { children: ReactNode }) {
	const { motionReduced } = usePrefs();
	return (
		<LazyMotion features={domAnimation} strict>
			<MotionConfig reducedMotion={motionReduced ? "always" : "user"}>{children}</MotionConfig>
		</LazyMotion>
	);
}

export function App() {
	return (
		<PrefsProvider>
			<SessionProvider>
				<TooltipProvider>
					<Motion>
						<BrowserRouter>
							<OnboardingGuard />
							<Routes>
								<Route path="/login" element={<AuthPage mode="login" />} />
								<Route path="/register" element={<AuthPage mode="register" />} />
								<Route path="/s/:token" element={<Lazy><SharedPage /></Lazy>} />
								<Route
									element={
										<RequireAuth>
											<AppShell />
										</RequireAuth>
									}
								>
									<Route index element={<HomePage />} />
									<Route path="/c/:spaceId/:conversationId" element={<Lazy><ChatPage /></Lazy>} />
									<Route path="/search" element={<Lazy><SearchPage /></Lazy>} />
									<Route path="/knowledge" element={<Lazy><KnowledgePage /></Lazy>} />
									<Route path="/knowledge/:kbId" element={<Lazy><KnowledgePage /></Lazy>} />
									<Route path="/files" element={<Lazy><FilesPage /></Lazy>} />
									<Route path="/files/:fileId" element={<Lazy><FilesPage /></Lazy>} />
									<Route path="/experts" element={<Lazy><ExpertsPage /></Lazy>} />
									<Route path="/projects/:projectId" element={<Lazy><ProjectPage /></Lazy>} />
									<Route path="/settings" element={<Lazy><SettingsPage /></Lazy>} />
									<Route path="/automations" element={<Lazy><AutomationsPage /></Lazy>} />
									<Route path="/capabilities" element={<Lazy><CapabilitiesPage /></Lazy>} />
									<Route path="/memory" element={<Lazy><MemoryPage /></Lazy>} />
									<Route path="/stats" element={<Lazy><StatsPage /></Lazy>} />
									<Route path="/admin" element={<Lazy><AdminPage /></Lazy>} />
									<Route path="*" element={<Navigate to="/" replace />} />
								</Route>
							</Routes>
						</BrowserRouter>
					</Motion>
				</TooltipProvider>
			</SessionProvider>
		</PrefsProvider>
	);
}
