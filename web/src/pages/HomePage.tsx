import { EnvironmentButton } from "@/features/environment/EnvironmentButton";
import { useRef, useState } from "react";
import { useSession } from "@/lib/session";
import { greeting } from "@/lib/utils";
import { TopBar } from "@/components/shell/AppShell";
import { BrandMark } from "@/components/shell/BrandMark";
import { DotMatrix } from "@/components/DotMatrix";
import { Composer } from "@/features/chat/Composer";
import { useStartConversation } from "@/features/chat/useStartConversation";

// three starters at most: each one only seeds the message box, nothing is sent
const STARTERS = [
	{ label: "整理资料", text: "帮我把附件里的资料整理成一页要点摘要，标出出处。" },
	{ label: "写文档", text: "帮我起草一份项目周报，包含进展、风险和下周计划。" },
	{ label: "分析数据", text: "分析这份表格的主要趋势，并生成一张汇总表。" },
];

export function HomePage() {
	const { me, personalSpaceId } = useSession();
	const start = useStartConversation();
	const [seed, setSeed] = useState({ text: "", n: 0 });
	const page = useRef<HTMLDivElement>(null);

	return (
		<div ref={page} className="relative isolate flex min-h-0 flex-1 flex-col">
			<DotMatrix column={680} />
			<TopBar />
			{/* desktop: greeting + composer centred; phones: greeting centred, composer docked at the bottom */}
			<div className="flex min-h-0 flex-1 flex-col items-center px-4 sm:justify-center sm:pb-[12vh]">
				<div className="flex w-full max-w-[680px] flex-1 flex-col sm:flex-none">
					<div className="order-1 flex flex-1 flex-col items-center justify-center text-center sm:mb-8 sm:flex-none">
						<BrandMark className="mb-5 size-10 rounded-xl" />
						<h1 data-testid="home-greeting" className="text-2xl font-medium tracking-tight sm:text-3xl">
							{greeting(me?.name)}
						</h1>
					</div>
					<div className="order-3 pb-[max(12px,env(safe-area-inset-bottom))] sm:pb-0">
						<Composer
							variant="home"
							autoFocus
							spaceId={personalSpaceId}
							seed={seed}
							dropScope={page}
							tools={
								<>
									{personalSpaceId ? <EnvironmentButton spaceId={personalSpaceId} side="bottom" /> : null}
								</>
							}
							onSubmit={(v) => start(v, { spaceId: personalSpaceId })}
						/>
					</div>
					<div role="group" className="order-2 mb-3 flex flex-wrap justify-center gap-2 sm:order-4 sm:mb-0 sm:mt-5" aria-label="起步建议">
						{STARTERS.map((s) => (
							<button
								key={s.label}
								type="button"
								onClick={() => setSeed((x) => ({ text: s.text, n: x.n + 1 }))}
								className="h-9 rounded-full border border-border bg-surface px-4 text-sm text-fg-muted transition-colors hover:border-border-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								{s.label}
							</button>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
