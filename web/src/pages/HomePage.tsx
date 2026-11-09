import { useRef, useState } from "react";
import { useSession } from "@/lib/session";
import { greeting } from "@/lib/utils";
import { TopBar } from "@/components/shell/AppShell";
import { BrandMark } from "@/components/shell/BrandMark";
import { DotMatrix } from "@/components/DotMatrix";
import { Composer } from "@/features/chat/Composer";
import { AssistantPicker } from "@/features/assistants/Assistants";
import { useStartConversation } from "@/features/chat/useStartConversation";

const STARTERS = [
	{ label: "整理资料", text: "帮我把附件里的资料整理成一页要点摘要，标出出处。" },
	{ label: "写一份文档", text: "帮我起草一份项目周报，包含进展、风险和下周计划。" },
	{ label: "分析数据", text: "分析这份表格的主要趋势，并生成一张汇总表。" },
	{ label: "研究一个问题", text: "调研一下这个问题的主要观点和依据，最后给出结论。" },
];

export function HomePage() {
	const { me, brand, personalSpaceId } = useSession();
	const start = useStartConversation();
	const [assistantId, setAssistantId] = useState<string>();
	const [seed, setSeed] = useState({ text: "", n: 0 });
	const page = useRef<HTMLDivElement>(null);

	return (
		<div ref={page} className="relative isolate flex min-h-0 flex-1 flex-col">
			<DotMatrix column={680} />
			<TopBar />
			{/* desktop: greeting + composer centred; phones: greeting centred, composer docked at the bottom */}
			<div className="flex min-h-0 flex-1 flex-col items-center px-4 sm:justify-center sm:pb-[12vh]">
				<div className="flex w-full max-w-[680px] flex-1 flex-col sm:flex-none">
					<div className="order-1 flex flex-1 flex-col items-center justify-center text-center sm:mb-7 sm:flex-none">
						<BrandMark className="mb-4 size-10 rounded-xl" />
						<h1 data-testid="home-greeting" className="text-[23px] font-medium tracking-tight sm:text-[27px]">
							{greeting(me?.name)}
						</h1>
						<p className="mt-2 text-[14px] text-fg-muted">{brand.tagline}</p>
					</div>
					<div className="order-3 pb-[max(12px,env(safe-area-inset-bottom))] sm:pb-0">
						<Composer
							variant="home"
							autoFocus
							spaceId={personalSpaceId}
							seed={seed}
							dropScope={page}
							tools={<AssistantPicker value={assistantId} onChange={setAssistantId} />}
							modelLocked={assistantId ? "使用助手的默认模型" : undefined}
							onSubmit={(v) => start(v, { spaceId: personalSpaceId, assistantId })}
						/>
					</div>
					<div className="order-2 mb-3 flex flex-wrap justify-center gap-2 sm:order-4 sm:mb-0 sm:mt-4" aria-label="起步建议">
						{STARTERS.map((s) => (
							<button
								key={s.label}
								onClick={() => setSeed((x) => ({ text: s.text, n: x.n + 1 }))}
								className="rounded-full border border-border bg-surface/80 px-3 py-1.5 text-[13px] text-fg-muted backdrop-blur-[2px] transition-colors hover:border-border-strong hover:text-fg"
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
