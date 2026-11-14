import { BrandBot } from "@/components/BotAvatar";
import { usePrefs } from "@/lib/prefs";
import { cn } from "@/lib/utils";

export type LogoSize = "sm" | "md" | "lg";

const SIZE_MAP: Record<LogoSize, { box: string; bot: number }> = {
	sm: { box: "size-7 rounded-lg", bot: 21 },
	md: { box: "size-9 rounded-xl", bot: 27 },
	lg: { box: "size-10 rounded-xl", bot: 30 },
};

export interface LogoProps {
	size?: LogoSize;
	animated?: boolean;
	className?: string;
	label?: string;
	testId?: string;
}

/**
 * Product logo built on the same BotAvatar visual system as experts (BrandBot in a neutral tile).
 * When `animated` is true (and reduced-motion is off), plays a gentle float + calm blink.
 */
export function Logo({ size = "md", animated = true, className, label, testId = "brand-logo" }: LogoProps) {
	const { motionReduced } = usePrefs();
	const live = animated && !motionReduced;
	const { box, bot } = SIZE_MAP[size];

	return (
		<span
			data-testid={testId}
			{...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
			className={cn(
				"inline-flex shrink-0 items-center justify-center border border-border bg-surface shadow-[0_1px_2px_rgb(20_20_22/0.04)]",
				box,
				className,
			)}
		>
			<span className={cn("inline-flex items-center justify-center", live && "wr-logo-float")}>
				<BrandBot size={bot} still={!live} />
			</span>
		</span>
	);
}
