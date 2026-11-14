// 能力: 技能市场 / 我的技能 / 待审核（仅审核员）/ 我的连接. Skills (and MCP servers, reviewed in the same queue) share one lifecycle:
// upload or import → automated checks → scoped review → publish → install (me / project / department / org).
// The 连接市场 tab is gone from the UI; the MCP market API and the review queue's MCP review stay.
// Design: docs/skills-mcp-marketplace.md. All permissions are decided by the server; the page only reflects them.
import { ClipboardCheck, Plug, Sparkles, Store } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { TopBar } from "@/components/shell/AppShell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Page, PageHeader } from "@/components/ui/misc";
import { Connectors } from "@/features/market/Connectors";
import { MySkills } from "@/features/market/MySkills";
import { ReviewQueue } from "@/features/market/ReviewQueue";
import { SkillMarket } from "@/features/market/SkillMarket";
import { useMarketMe } from "@/features/market/common";
import { useApi } from "@/lib/useApi";

export { KIND } from "@/features/market/MySkills";

type Tab = "market" | "mine" | "review" | "connectors";
// Old links to the removed 连接市场 tab land on 我的连接.
const ALIAS: Record<string, Tab> = { skills: "mine", mcp: "connectors" };

export default function CapabilitiesPage() {
	const [sp, setSp] = useSearchParams();
	const draftId = sp.get("draft");
	const raw = sp.get("tab") ?? "mine";
	const tab = (ALIAS[raw] ?? raw) as Tab;
	const me = useMarketMe();
	const [pending, setPending] = useState<number>();
	const canReview = !!me.data && (me.data.me.canReviewSkills || me.data.me.canReviewMcp);
	const queue = useApi<{ submissions: unknown[] }>(canReview ? "/market/submissions?view=queue" : null, { pollMs: 30000 });
	const count = pending ?? queue.data?.submissions.length;
	const go = (t: string) => setSp(t === "mine" ? {} : { tab: t });
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page wide>
					<PageHeader title="能力" />
					<Tabs value={canReview || tab !== "review" ? tab : "mine"} onValueChange={go}>
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
								{canReview ? (
									<TabsTrigger value="review" data-testid="tab-review">
										<ClipboardCheck />
										待审核
										{count ? <span className="ml-1 rounded-full bg-warning-soft px-1.5 text-xs text-warning" data-testid="review-count">{count}</span> : null}
									</TabsTrigger>
								) : null}
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
							<MySkills draftId={draftId} onDraftDone={() => setSp({})} />
						</TabsContent>
						{canReview && me.data ? (
							<TabsContent value="review">
								<ReviewQueue me={me.data.me} onCount={setPending} />
							</TabsContent>
						) : null}
						<TabsContent value="connectors">
							<Connectors />
						</TabsContent>
					</Tabs>
				</Page>
			</div>
		</div>
	);
}
