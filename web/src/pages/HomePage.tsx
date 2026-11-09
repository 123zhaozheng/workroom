import { useState } from "react";
import { useSession } from "@/lib/session";
import { greeting } from "@/lib/utils";
import { TopBar } from "@/components/shell/AppShell";
import { BrandMark } from "@/components/shell/BrandMark";
import { Composer } from "@/features/chat/Composer";
import { ModelPicker } from "@/features/chat/ModelPicker";
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
	const [modelId, setModelId] = useState<string>();
	const [assistantId, setAssistantId] = useState<string>();
	const [seed, setSeed] = useState({ text: "", n: 0 });

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="flex flex-1 flex-col items-center justify-center px-4 pb-[12vh]">
				<div className="w-full max-w-[680px]">
					<div className="mb-7 flex flex-col items-center text-center">
						<BrandMark className="mb-4 size-9 rounded-xl" />
						<h1 data-testid="home-greeting" className="text-[22px] font-medium tracking-tight sm:text-[26px]">
							{greeting(me?.name)}
						</h1>
						<p className="mt-1.5 text-[14px] text-fg-muted">{brand.tagline}</p>
					</div>
					<Composer
						variant="home"
						autoFocus
						spaceId={personalSpaceId}
						seed={seed}
						onSubmit={(v) => start(v, { spaceId: personalSpaceId, modelId: assistantId ? undefined : modelId, assistantId })}
						footer={
							<span className="inline-flex items-center gap-1">
								<AssistantPicker value={assistantId} onChange={setAssistantId} />
								<ModelPicker value={modelId} onChange={setModelId} />
							</span>
						}
					/>
					<div className="mt-4 flex flex-wrap justify-center gap-2" aria-label="起步建议">
						{STARTERS.map((s) => (
							<button
								key={s.label}
								onClick={() => setSeed((x) => ({ text: s.text, n: x.n + 1 }))}
								className="rounded-full border border-border bg-surface px-3 py-1.5 text-[13px] text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
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
