import { cn } from "@/lib/utils";

/** Neutral product mark (no third-party logos). */
export function BrandMark({ className }: { className?: string }) {
	return (
		<span aria-hidden className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg", className)}>
			<svg viewBox="0 0 32 32" className="size-[18px]" fill="none">
				<path d="M8 11h16M8 16h16M8 21h10" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
			</svg>
		</span>
	);
}

/**
 * Small assistant avatar. The only motion it has expresses state: a soft pulse ring while the run is
 * working, a static ring colour while it waits for the user. Idle = still. Reduced-motion disables the pulse.
 */
export function AssistantAvatar({ state = "idle", size = 26, label }: { state?: "idle" | "working" | "waiting" | "failed"; size?: number; label?: string }) {
	return (
		<span
			data-testid="assistant-avatar"
			data-state={state}
			title={label}
			className="relative inline-flex shrink-0 items-center justify-center rounded-full bg-surface-3 text-fg"
			style={{ width: size, height: size }}
		>
			<svg viewBox="0 0 32 32" className="size-[60%]" fill="none" aria-hidden>
				<path d="M8 11h16M8 16h16M8 21h10" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
			</svg>
			{state !== "idle" ? (
				<span
					aria-hidden
					className={cn(
						"absolute -inset-[3px] rounded-full border-2",
						state === "working" && "border-info wr-pulse",
						state === "waiting" && "border-warning",
						state === "failed" && "border-danger",
					)}
				/>
			) : null}
		</span>
	);
}
