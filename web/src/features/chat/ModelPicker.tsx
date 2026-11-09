import { Check, ChevronDown, FlaskConical } from "lucide-react";
import { useEffect } from "react";
import { FIXTURE_LABEL } from "@shared/chat";
import { useApi } from "@/lib/useApi";
import { cn } from "@/lib/utils";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/overlay";
import { listOf } from "./pickers";

export interface ModelOption {
	id: string;
	label: string;
	status: "ready" | "blocked" | "fixture";
	statusDetail?: string;
	isDefault?: boolean;
}

/** Model choice for a new conversation. Blocked models are shown honestly (disabled, with the reason). */
export function ModelPicker({ value, onChange }: { value?: string; onChange: (id: string | undefined) => void }) {
	const res = useApi<unknown>("/models");
	const models = listOf<ModelOption>(res.data, "models");
	const usable = models.filter((m) => m.status !== "blocked");
	useEffect(() => {
		if (!value && usable.length) onChange((usable.find((m) => m.isDefault) ?? usable.find((m) => m.status === "ready") ?? usable[0])!.id);
	}, [value, usable, onChange]);
	if (res.unavailable || res.error || !models.length) return null;
	const cur = models.find((m) => m.id === value);
	// the platform label may already say it is the test model; never repeat it
	const fxNote = (m?: ModelOption) => m?.status === "fixture" && !m.label.includes("测试模型");
	return (
		<Menu>
			<MenuTrigger asChild>
				<button data-testid="model-picker" className="inline-flex h-6 max-w-full items-center gap-1 rounded-md px-1.5 text-xs text-fg-muted hover:bg-surface-2 hover:text-fg">
					{cur?.status === "fixture" ? <FlaskConical className="size-3 text-warning" /> : null}
					<span className="truncate">{cur ? cur.label : "选择模型"}</span>
					{fxNote(cur) ? <span className="text-warning">· {FIXTURE_LABEL}</span> : null}
					<ChevronDown className="size-3" />
				</button>
			</MenuTrigger>
			<MenuContent side="top" align="start" className="w-72">
				<MenuLabel>模型</MenuLabel>
				{models.map((m) => (
					<MenuItem key={m.id} data-testid="model-option" data-status={m.status} disabled={m.status === "blocked"} onSelect={() => onChange(m.id)} className="items-start">
						<Check className={cn("mt-0.5", m.id === value ? "opacity-100" : "opacity-0")} />
						<span className="min-w-0 flex-1">
							<span className="block truncate">{m.label}</span>
							<span className={cn("block text-xs", m.status === "blocked" ? "text-danger" : m.status === "fixture" ? "text-warning" : "text-fg-subtle")}>
								{m.status === "blocked" ? `不可用：${m.statusDetail ?? "未配置凭据"}` : m.status === "fixture" ? (fxNote(m) ? FIXTURE_LABEL : "仅用于测试，回答是确定性脚本") : "可用"}
							</span>
						</span>
					</MenuItem>
				))}
			</MenuContent>
		</Menu>
	);
}
