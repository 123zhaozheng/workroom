import { BotAvatar, BrandBot } from "@/components/BotAvatar";
import { Logo, type LogoSize } from "@/components/Logo";
import { cn } from "@/lib/utils";

/**
 * Product mark: thin wrapper around Logo so Sidebar and Share stay aligned with the BotAvatar visual system.
 */
export function BrandMark({ className, size = "sm", animated = true }: { className?: string; size?: LogoSize; animated?: boolean }) {
	return <Logo size={size} animated={animated} testId="brand-mark" className={className} />;
}

/**
 * The assistant's avatar next to its answers: the conversation's expert when there is one, else the product's own bot. It is calm
 * (blink only) at rest and plays the full animation while the run is working; a ring marks "waiting for you" and "failed".
 */
export function AssistantAvatar({ state = "idle", size = 28, label, expert }: { state?: "idle" | "working" | "waiting" | "failed"; size?: number; label?: string; expert?: { id?: string; avatarConfig?: unknown; name?: string } }) {
	return (
		<span data-testid="assistant-avatar" data-state={state} title={label} className="relative inline-flex shrink-0 items-center justify-center rounded-full" style={{ width: size, height: size }}>
			{expert ? <BotAvatar config={expert.avatarConfig} seed={expert.id ?? expert.name ?? "expert"} size={size} working={state === "working"} /> : <BrandBot size={size} working={state === "working"} />}
			{state === "waiting" || state === "failed" ? <span aria-hidden className={cn("absolute -inset-[3px] rounded-full border-2", state === "waiting" ? "border-warning" : "border-danger")} /> : null}
		</span>
	);
}
