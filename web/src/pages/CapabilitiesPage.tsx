// 能力: 技能市场 / 我的技能 / 待审核（仅审核员）/ 连接市场 / 我的连接. Skills and MCP servers share one lifecycle:
// upload or import → automated checks → scoped review → publish → install (me / project / department / org).
// Design: docs/skills-mcp-marketplace.md. All permissions are decided by the server; the page only reflects them.
import { Boxes, ClipboardCheck, Plug, Sparkles, Store } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { TopBar } from "@/components/shell/AppShell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Page, PageHeader } from "@/components/ui/misc";
import { Help } from "@/features/admin/common";
import { Connectors } from "@/features/market/Connectors";
import { McpMarket } from "@/features/market/McpMarket";
import { MySkills } from "@/features/market/MySkills";
import { ReviewQueue } from "@/features/market/ReviewQueue";
import { SkillMarket } from "@/features/market/SkillMarket";
import { useMarketMe } from "@/features/market/common";
import { useApi } from "@/lib/useApi";

export { KIND } from "@/features/market/MySkills";

type Tab = "market" | "mine" | "review" | "mcp" | "connectors";
const ALIAS: Record<string, Tab> = { skills: "mine" };

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
					<PageHeader title="能力" actions={<Help label="说明">技能让智能体学会做某类事，连接让它能使用外部服务。上架前都要经过审核；技能只提供做法，需要运行代码或联网时会单独授权。</Help>} />
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
								<TabsTrigger value="mcp" data-testid="tab-mcp">
									<Boxes />
									连接市场
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
							<MySkills draftId={draftId} onDraftDone={() => setSp({})} />
						</TabsContent>
						{canReview && me.data ? (
							<TabsContent value="review">
								<ReviewQueue me={me.data.me} onCount={setPending} />
							</TabsContent>
						) : null}
						<TabsContent value="mcp">
							<McpMarket />
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
