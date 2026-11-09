// Model switcher at the right of the composer: grouped by provider, capability badges (图片 / 工具 / 推理 + thinking levels),
// blocked models disabled with their reason, the test model labelled once as 测试模型（非真实 AI）.
// Desktop: dropdown. Phones: bottom sheet.
import { Brain, Check, ChevronDown, FlaskConical, ImageIcon, Wrench } from "lucide-react";
import { useState } from "react";
import type { ModelCapability, ThinkingLevel } from "@shared/ops";
import { useMedia } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { BottomSheet, Menu, MenuContent, MenuLabel, MenuItem, MenuTrigger } from "@/components/ui/overlay";
import { modelName, supportsThinking, THINKING_LABEL, type ModelInfo } from "./models";

const CAP: Record<Exclude<ModelCapability, "text">, { label: string; icon: typeof Brain }> = {
	image: { label: "图片", icon: ImageIcon },
	tools: { label: "工具", icon: Wrench },
	reasoning: { label: "推理", icon: Brain },
};

function Pill({ cap, title }: { cap: Exclude<ModelCapability, "text">; title?: string }) {
	const { label, icon: I } = CAP[cap];
	return (
		<span data-cap={cap} title={title ?? label} className="inline-flex h-[18px] items-center gap-1 rounded bg-surface-2 px-1.5 text-[11px] text-fg-muted">
			<I className="size-3!" />
			{label}
		</span>
	);
}

const fmtCtx = (n?: number) => (n ? (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}K`) + " 上下文" : "");

function RowBody({ m, selected }: { m: ModelInfo; selected: boolean }) {
	const caps = (["image", "tools", "reasoning"] as const).filter((c) => m.capabilities.includes(c));
	return (
		<>
			<Check className={cn("mt-0.5 size-4! shrink-0", selected ? "opacity-100" : "opacity-0")} />
			<span className="min-w-0 flex-1 text-left">
				<span className="flex items-center gap-1.5">
					{m.fixture ? <FlaskConical className="size-3.5! shrink-0 text-warning!" /> : null}
					<span className={cn("truncate text-sm", m.fixture && "text-warning")}>{modelName(m)}</span>
				</span>
				{m.status === "blocked" ? (
					<span className="mt-0.5 block text-xs text-danger">不可用：{m.statusDetail ?? "未配置凭据"}</span>
				) : m.fixture ? (
					<span className="mt-0.5 block text-xs text-warning">仅用于测试：回答是确定性脚本，用量为模拟值</span>
				) : (
					<>
						{m.description ? <span className="mt-0.5 block truncate text-xs text-fg-subtle">{m.description}</span> : null}
						{caps.length || m.contextWindow ? (
							<span className="mt-1 flex flex-wrap items-center gap-1">
								{caps.map((c) => (
									<Pill key={c} cap={c} title={c === "reasoning" && supportsThinking(m) ? `可选思考强度：${m.thinkingLevels.filter((l) => l !== "off").map((l) => THINKING_LABEL[l]).join(" / ")}` : undefined} />
								))}
								{m.contextWindow ? <span className="text-[11px] text-fg-subtle">{fmtCtx(m.contextWindow)}</span> : null}
							</span>
						) : null}
					</>
				)}
			</span>
		</>
	);
}

function ThinkingRow({ model, value, onChange }: { model: ModelInfo; value?: ThinkingLevel; onChange: (l: ThinkingLevel) => void }) {
	return (
		<div data-testid="thinking-levels" className="mx-1 mt-1 border-t border-border px-1.5 pb-1 pt-2">
			<div className="mb-1.5 flex items-center gap-1 text-xs text-fg-subtle">
				<Brain className="size-3.5" />
				思考强度
			</div>
			<div role="radiogroup" aria-label="思考强度" className="flex rounded-lg bg-surface-2 p-0.5 text-[12px]">
				{model.thinkingLevels.map((l) => (
					<button key={l} type="button" role="radio" aria-checked={value === l} data-level={l} onClick={() => onChange(l)} className={cn("h-7 flex-1 rounded-md px-1.5", value === l ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg")}>
						{THINKING_LABEL[l]}
					</button>
				))}
			</div>
		</div>
	);
}

export interface SwitcherProps {
	groups: { name: string; items: ModelInfo[] }[];
	value?: ModelInfo;
	/** The conversation's actual model when it is not in the list (renamed / withdrawn). */
	fallback?: { label: string; fixture: boolean };
	thinking?: ThinkingLevel;
	onSelect: (m: ModelInfo) => void;
	onThinking: (l: ThinkingLevel) => void;
	disabled?: boolean;
}

export function ModelSwitcher({ groups, value, fallback, thinking, onSelect, onThinking, disabled }: SwitcherProps) {
	const phone = useMedia("(max-width: 639px)");
	const [open, setOpen] = useState(false);
	const fixture = value ? value.fixture : !!fallback?.fixture;
	const label = value ? modelName(value) : fallback ? (fallback.fixture ? "测试模型（非真实 AI）" : fallback.label) : "选择模型";
	const think = value && supportsThinking(value) && thinking && thinking !== "off" ? THINKING_LABEL[thinking] : "";
	const trigger = (
		<button
			type="button"
			data-testid="model-picker"
			data-model-id={value?.id}
			disabled={disabled}
			aria-label={`模型：${label}`}
			onClick={phone ? () => setOpen(true) : undefined}
			className="inline-flex h-8 min-w-0 max-w-[200px] items-center gap-1.5 rounded-lg px-2 text-[13px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-60 sm:max-w-[280px]"
		>
			{fixture ? <FlaskConical className="size-3.5 shrink-0 text-warning" /> : null}
			<span className={cn("truncate", fixture && "text-warning")}>{label}</span>
			{think ? <span className="shrink-0 rounded bg-surface-2 px-1 text-[11px] text-fg-subtle">{think}</span> : null}
			<ChevronDown className="size-3.5 shrink-0" />
		</button>
	);
	if (!groups.length)
		return (
			<span data-testid="model-picker" className="inline-flex h-8 min-w-0 max-w-[240px] items-center gap-1.5 px-2 text-[13px] text-fg-muted" title="当前对话使用的模型">
				{fixture ? <FlaskConical className="size-3.5 shrink-0 text-warning" /> : null}
				<span className={cn("truncate", fixture && "text-warning")}>{label}</span>
			</span>
		);
	const pick = (m: ModelInfo) => {
		onSelect(m);
		setOpen(false);
	};
	if (phone)
		return (
			<>
				{trigger}
				<BottomSheet open={open} onOpenChange={setOpen} title="选择模型">
					{groups.map((g) => (
						<div key={g.name} className="mb-1">
							<div className="px-3 pb-1 pt-2 text-xs text-fg-subtle">{g.name}</div>
							{g.items.map((m) => (
								<button
									key={m.id}
									type="button"
									data-testid="model-option"
									data-status={m.status}
									data-disabled={m.status === "blocked" ? "" : undefined}
									disabled={m.status === "blocked"}
									onClick={() => pick(m)}
									className="flex w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left active:bg-surface-2 disabled:opacity-60"
								>
									<RowBody m={m} selected={m.id === value?.id} />
								</button>
							))}
						</div>
					))}
					{value && supportsThinking(value) ? <ThinkingRow model={value} value={thinking} onChange={onThinking} /> : null}
				</BottomSheet>
			</>
		);
	return (
		<Menu open={open} onOpenChange={setOpen}>
			<MenuTrigger asChild>{trigger}</MenuTrigger>
			<MenuContent side="top" align="end" className="max-h-[min(70vh,520px)] w-[340px] overflow-y-auto p-1.5">
				{groups.map((g, gi) => (
					<div key={g.name} role="group" aria-label={g.name} data-testid="model-group">
						<MenuLabel className={cn(gi > 0 && "mt-1")}>{g.name}</MenuLabel>
						{g.items.map((m) => (
							<MenuItem key={m.id} data-testid="model-option" data-status={m.status} disabled={m.status === "blocked"} onSelect={() => pick(m)} className="items-start py-2">
								<RowBody m={m} selected={m.id === value?.id} />
							</MenuItem>
						))}
					</div>
				))}
				{value && supportsThinking(value) ? <ThinkingRow model={value} value={thinking} onChange={onThinking} /> : null}
			</MenuContent>
		</Menu>
	);
}
