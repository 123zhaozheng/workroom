// 待审核 (reviewers only): unified review management for 专家、技能、连接器.
import { Shield } from "lucide-react";
import { TopBar } from "@/components/shell/AppShell";
import { EmptyState, Loadable, Page, PageHeader } from "@/components/ui/misc";
import { ReviewQueue } from "@/features/market/ReviewQueue";
import { useMarketMe } from "@/features/market/common";

export default function ReviewsPage() {
	const me = useMarketMe();
	const canReview = !!me.data?.me.canReview;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page wide>
					<PageHeader title="待审核" />
					<Loadable state={me} what="待审核">
						{me.data ? (
							canReview ? (
								<ReviewQueue me={me.data.me} />
							) : (
								<div data-testid="reviews-forbidden">
									<EmptyState icon={<Shield />} title="没有审核权限">
										仅管理员或拥有审查员权限的成员可以查看并处理待审核内容。
									</EmptyState>
								</div>
							)
						) : null}
					</Loadable>
				</Page>
			</div>
		</div>
	);
}
