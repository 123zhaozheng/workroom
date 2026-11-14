// Conversation header: who is answering (the conversation's expert) and which model it runs on — a click opens the model list to switch
// (the same switch as the composer's; choosing one makes it the user's explicit choice, which an expert's default model never overrides).
import { Check, ChevronDown } from "lucide-react";
import type { AgentDTO } from "@shared/chat";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/overlay";
import { modelName, useModels, type ModelInfo } from "@/features/composer/models";
import type { ThinkingLevel } from "@shared/ops";
import { ExpertAvatar } from "./common";

export function ExpertHeader({ agent, onModel, working }: { agent: AgentDTO; working?: boolean; onModel: (m: ModelInfo, thinking?: ThinkingLevel) => void | Promise<void> }) {
	const { groups } = useModels();
	const e = agent.expert!;
	const cur = agent.model;
	return (
		<Menu>
			<MenuTrigger asChild>
				<button data-testid="chat-expert" title={e.modelExplicit ? "模型由你选择" : "使用专家指定的模型"} className="inline-flex max-w-[260px] shrink-0 items-center gap-1.5 rounded-md bg-surface-2 py-0.5 pl-1 pr-1.5 text-[11.5px] text-fg-muted hover:bg-surface-3 hover:text-fg">
					<ExpertAvatar e={{ id: e.boundId, avatarConfig: e.boundAvatarConfig, name: e.boundName }} size={20} working={working} />
					<span className="truncate font-medium text-fg">{e.boundName}</span>
					<span aria-hidden>·</span>
					<span className="truncate" data-testid="chat-expert-model">
						{agent.modelLabel}
					</span>
					<ChevronDown className="size-3 shrink-0" />
				</button>
			</MenuTrigger>
			<MenuContent side="bottom" align="start" className="w-64">
				<MenuLabel>切换模型</MenuLabel>
				{groups.flatMap((g) => g.items).map((m) => {
					const on = !!cur && m.ref?.provider === cur.provider && m.ref.modelId === cur.modelId;
					return (
						<MenuItem key={m.id} disabled={m.status === "blocked"} onSelect={() => void onModel(m)}>
							<Check className={on ? "opacity-100" : "opacity-0"} />
							<span className="min-w-0 flex-1 truncate">{modelName(m)}</span>
						</MenuItem>
					);
				})}
			</MenuContent>
		</Menu>
	);
}
