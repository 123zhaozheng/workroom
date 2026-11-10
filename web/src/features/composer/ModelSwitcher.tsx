// Model switcher at the right of the composer: models grouped by service provider, capabilities as small icons (with tooltips),
// blocked models disabled with a one-line reason, the test model labelled once as 测试模型（非真实 AI）.
// Desktop: dropdown that flips at the viewport edge, never covers the top bar and scrolls instead of overflowing.
// Phones: bottom sheet.
import { Brain, Check, ChevronDown, FlaskConical, ImageIcon, Wrench } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { ModelCapability, ThinkingLevel } from "@shared/ops";
import { useMedia } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { BottomSheet, Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger, Tip } from "@/components/ui/overlay";
import { modelName, supportsThinking, THINKING_LABEL, type ModelInfo } from "./models";

type Cap = Exclude<ModelCapability, "text">;
const CAP: Record<Cap, { label: string; icon: typeof Brain }> = {
	image: { label: "能看图片", icon: ImageIcon },
	tools: { label: "能使用工具", icon: Wrench },
	reasoning: { label: "擅长复杂推理", icon: Brain },
};

function CapIcon({ cap, detail }: { cap: Cap; detail?: string }) {
	const { label, icon: I } = CAP[cap];
	const tip = detail ? `${label}（${detail}）` : label;
	return (
		<Tip label={tip}>
			<span data-cap={cap} aria-label={tip} role="img" className="inline-flex size-6 items-center justify-center rounded-md bg-surface-2 text-fg-muted">
				<I className="size-3.5" />
			</span>
		</Tip>
	);
}

const fmtCtx = (n?: number) => (n ? (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}K`) : "");

/** One short line: the first clause of the server's reason, without parenthetical how-to text. */
export function shortReason(detail?: string): string {
	const d = (detail ?? "").replace(/[（(][^）)]*[）)]/g, "").trim();
	return d.split(/[；;。]/)[0]?.trim() || "未配置密钥";
}

function RowBody({ m, selected }: { m: ModelInfo; selected: boolean }) {
	const caps = (["image", "tools", "reasoning"] as const).filter((c) => m.capabilities.includes(c));
	const blocked = m.status === "blocked";
	return (
		<>
			<Check aria-hidden className={cn("mt-0.5 size-4! shrink-0", selected ? "opacity-100" : "opacity-0")} />
			<span className="min-w-0 flex-1 text-left">
				<span className="flex items-center gap-1.5">
					{m.fixture ? <FlaskConical aria-hidden className="size-3.5! shrink-0 text-warning!" /> : null}
					<span className={cn("min-w-0 truncate text-sm", m.fixture && "text-warning", blocked && "text-fg-muted")}>{modelName(m)}</span>
					{m.personal ? <span className="shrink-0 rounded bg-surface-2 px-1 text-xs text-fg-muted">我的密钥</span> : null}
					{!blocked && !m.fixture && (caps.length > 0 || m.contextWindow) ? (
						<span className="ml-auto flex shrink-0 items-center gap-1 pl-2">
							{caps.map((c) => (
								<CapIcon key={c} cap={c} detail={c === "reasoning" && supportsThinking(m) ? `可调思考强度：${m.thinkingLevels.filter((l) => l !== "off").map((l) => THINKING_LABEL[l]).join(" / ")}` : undefined} />
							))}
							{m.contextWindow ? (
								<Tip label="一次可处理的内容长度">
									<span className="min-w-[2.25rem] text-right text-xs text-fg-subtle">{fmtCtx(m.contextWindow)}</span>
								</Tip>
							) : null}
						</span>
					) : null}
				</span>
				{blocked ? (
					<span className="mt-0.5 block text-xs text-danger">不可用：{shortReason(m.statusDetail)}</span>
				) : m.fixture ? (
					<span className="mt-0.5 block text-xs text-warning">回答为预设脚本，用量为模拟值</span>
				) : m.description ? (
					<span className="mt-0.5 block truncate text-xs text-fg-muted">{m.description}</span>
				) : null}
			</span>
		</>
	);
}

const levelButton = (on: boolean) => cn("h-8 flex-1 rounded-md px-1.5 text-sm", on ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg");

function ThinkingHeader() {
	return (
		<div className="mb-1.5 flex items-center gap-1 text-xs text-fg-muted">
			<Brain aria-hidden className="size-3.5" />
			思考强度
		</div>
	);
}

/** Phone variant: plain radio buttons inside the sheet (a sheet is a normal tab order, unlike a dropdown). */
function ThinkingRow({ model, value, onChange }: { model: ModelInfo; value?: ThinkingLevel; onChange: (l: ThinkingLevel) => void }) {
	return (
		<div data-testid="thinking-levels" className="mx-1 mt-1 border-t border-border px-1.5 pb-1 pt-2">
			<ThinkingHeader />
			<div role="radiogroup" aria-label="思考强度" className="flex rounded-lg bg-surface-2 p-0.5">
				{model.thinkingLevels.map((l) => (
					<button key={l} type="button" role="radio" aria-checked={value === l} data-level={l} onClick={() => onChange(l)} className={levelButton(value === l)}>
						{THINKING_LABEL[l]}
					</button>
				))}
			</div>
		</div>
	);
}

/** Desktop variant: menu radio items, so the levels are reachable with the arrow keys and announced as a radio group. */
function ThinkingMenuRow({ model, value, onChange }: { model: ModelInfo; value?: ThinkingLevel; onChange: (l: ThinkingLevel) => void }) {
	return (
		<div data-testid="thinking-levels" className="mx-1 mt-1 border-t border-border px-1.5 pb-1 pt-2">
			<ThinkingHeader />
			<MenuRadioGroup value={value} onValueChange={(v) => onChange(v as ThinkingLevel)} aria-label="思考强度" className="flex rounded-lg bg-surface-2 p-0.5">
				{model.thinkingLevels.map((l) => (
					<MenuRadioItem
						key={l}
						value={l}
						data-level={l}
						// picking a level keeps the menu open so the choice can be confirmed at a glance
						onSelect={(e) => e.preventDefault()}
						className={cn("h-8 flex-1", value === l && "font-medium")}
					>
						{THINKING_LABEL[l]}
					</MenuRadioItem>
				))}
			</MenuRadioGroup>
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
	/** Which side of the chip the menu prefers: the home composer sits mid-page, so it opens downward and never covers the greeting. */
	side?: "top" | "bottom";
}

const groupTitle = (g: { name: string; items: ModelInfo[] }) => (g.items.every((m) => m.fixture) ? "测试" : g.name);

export function ModelSwitcher({ groups, value, fallback, thinking, onSelect, onThinking, disabled, side = "top" }: SwitcherProps) {
	const phone = useMedia("(max-width: 639px)");
	const [open, setOpen] = useState(false);
	const fixture = value ? value.fixture : !!fallback?.fixture;
	const label = value ? modelName(value) : fallback ? (fallback.fixture ? "测试模型（非真实 AI）" : fallback.label) : "选择模型";
	const think = value && supportsThinking(value) && thinking && thinking !== "off" ? THINKING_LABEL[thinking] : "";
	const chipBase = "inline-flex h-9 min-w-0 items-center gap-1.5 rounded-lg px-2.5 text-sm text-fg-muted sm:h-8";
	const trigger = (
		<button
			type="button"
			data-testid="model-picker"
			data-model-id={value?.id}
			disabled={disabled}
			aria-label={`模型：${label}`}
			aria-haspopup={phone ? "dialog" : "menu"}
			onClick={phone ? () => setOpen(true) : undefined}
			className={cn(chipBase, "max-w-[160px] transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:max-w-[280px]")}
		>
			{fixture ? <FlaskConical aria-hidden className="size-3.5 shrink-0 text-warning" /> : null}
			<span className={cn("truncate", fixture && "text-warning")}>{label}</span>
			{think ? <span className="shrink-0 rounded bg-surface-2 px-1 text-xs text-fg-muted">{think}</span> : null}
			<ChevronDown aria-hidden className="size-3.5 shrink-0" />
		</button>
	);
	if (!groups.length)
		return (
			<span data-testid="model-picker" className={cn(chipBase, "max-w-[240px]")} title="当前对话使用的模型">
				{fixture ? <FlaskConical aria-hidden className="size-3.5 shrink-0 text-warning" /> : null}
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
						<div key={g.name} role="group" aria-label={groupTitle(g)} className="mb-1">
							<div className="px-3 pb-1 pt-2 text-xs text-fg-subtle">{groupTitle(g)}</div>
							{g.items.map((m) => (
								<button
									key={m.id}
									type="button"
									data-testid="model-option"
									data-status={m.status}
									data-disabled={m.status === "blocked" ? "" : undefined}
									disabled={m.status === "blocked"}
									onClick={() => pick(m)}
									className="flex min-h-12 w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left active:bg-surface-2 disabled:opacity-100"
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
			<MenuContent side={side} align="end" data-testid="model-menu" className="w-[min(360px,calc(100vw-24px))] p-1.5">
				{groups.map((g, gi) => (
					<div key={g.name} role="group" aria-label={groupTitle(g)} data-testid="model-group">
						<MenuLabel className={cn(gi > 0 && "mt-1")}>{groupTitle(g)}</MenuLabel>
						{g.items.map((m) => (
							<MenuItem key={m.id} data-testid="model-option" data-status={m.status} data-disabled={m.status === "blocked" ? "" : undefined} disabled={m.status === "blocked"} onSelect={() => pick(m)} className="items-start py-2 data-[disabled]:opacity-100">
								<RowBody m={m} selected={m.id === value?.id} />
							</MenuItem>
						))}
					</div>
				))}
				{value && supportsThinking(value) ? <ThinkingMenuRow model={value} value={thinking} onChange={onThinking} /> : null}
			</MenuContent>
		</Menu>
	);
}

/** Chip shown while the model list is loading, or a plain note when there is nothing to choose. */
export function ModelChipNote({ children }: { children: ReactNode }) {
	return <span className="inline-flex h-9 items-center px-2.5 text-sm text-fg-muted sm:h-8">{children}</span>;
}
