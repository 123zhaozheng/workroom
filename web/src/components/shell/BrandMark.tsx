import { BotAvatar, BrandBot } from "@/components/BotAvatar";
import { cn } from "@/lib/utils";

/**
 * Product mark: the Workroom bot (a speech-bubble body with two eyes, from the open-bot-avatar shapes) on the accent tile. Flat and static, so it is
 * identical in the sidebar, the login page and the favicon (web/public/favicon.svg draws the same shape). Body = tile text color, eyes = tile color.
 */
export function BrandMark({ className }: { className?: string }) {
	return (
		<span aria-hidden data-testid="brand-mark" className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg", className)}>
			<svg viewBox="0 0 100 100" className="size-[78%]">
				<path d="M28 14H72C82 14 90 22 90 32V54C90 64 82 72 72 72H42L25 86C23.5 87.3 21.5 86 22.3 84L27 71.5C17 70 10 63 10 54V32C10 22 18 14 28 14Z" fill="currentColor" />
				<g className="fill-accent">
					<rect x="37.2" y="33.2" width="6.4" height="17.6" rx="3.2" />
					<rect x="56.4" y="33.2" width="6.4" height="17.6" rx="3.2" />
				</g>
			</svg>
		</span>
	);
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
