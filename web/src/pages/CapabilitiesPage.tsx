// 能力: 技能市场 / 我的技能 / 我的连接. Skills (and MCP servers) share one lifecycle:
// upload or import → automated checks → scoped review → publish → install (me / project / department / org).
// The 连接市场 tab is gone from the UI; the MCP market API stays. 待审核 moved to /reviews.
// Design: docs/skills-mcp-marketplace.md. All permissions are decided by the server; the page only reflects them.
import { Plug, Sparkles, Store } from "lucide-react";
import { Navigate, useSearchParams } from "react-router";
import { TopBar } from "@/components/shell/AppShell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Page, PageHeader } from "@/components/ui/misc";
import { Connectors } from "@/features/market/Connectors";
import { MySkills } from "@/features/market/MySkills";
import { SkillMarket } from "@/features/market/SkillMarket";

export { KIND } from "@/features/market/MySkills";

type Tab = "market" | "mine" | "connectors";
// Old links to the removed 连接市场 tab land on 我的连接.
const ALIAS: Record<string, Tab> = { skills: "mine", mcp: "connectors" };

export default function CapabilitiesPage() {
	const [sp, setSp] = useSearchParams();
	const raw = sp.get("tab") ?? "mine";
	if (raw === "review") return <Navigate to="/reviews" replace />;
	const mapped = ALIAS[raw] ?? raw;
	const tab: Tab = mapped === "market" || mapped === "mine" || mapped === "connectors" ? mapped : "mine";
	const go = (t: string) => setSp(t === "mine" ? {} : { tab: t });
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page wide>
					<PageHeader title="能力" />
					<Tabs value={tab} onValueChange={go}>
						<div className="mb-5 overflow-x-auto max-sm:[mask-image:linear-gradient(to_right,black_88%,transparent)]">
							<TabsList className="min-w-max max-sm:[&_svg]:hidden">
								<TabsTrigger value="market" data-testid="tab-market">
									<Store />
									技能市场
								</TabsTrigger>
								<TabsTrigger value="mine" data-testid="tab-mine">
									<Sparkles />
									我的技能
								</TabsTrigger>
								<TabsTrigger value="connectors" data-testid="tab-connectors">
									<Plug />
									我的连接
								</TabsTrigger>
							</TabsList>
						</div>
						<TabsContent value="market">
							<SkillMarket />
						</TabsContent>
						<TabsContent value="mine">
							<MySkills />
						</TabsContent>
						<TabsContent value="connectors">
							<Connectors />
						</TabsContent>
					</Tabs>
				</Page>
			</div>
		</div>
	);
}
