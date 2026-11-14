// The bot avatar (open-bot-avatar style: a soft object silhouette with two eyes) used for every expert and for the product's own assistant.
// Data: `config` is the expert's avatarConfig JSON; anything missing or broken falls back to a stable default picked from `seed` (the expert id).
// Motion: calm by default (blink only, nothing runs between blinks); `working` plays the full "thinking" animation. See lib/bot-avatar/mount.ts.
import { memo, useEffect, useMemo, useRef } from "react";
import { BRAND_AVATAR, colorsFor, resolveAvatar } from "@shared/bot-avatar/config";
import { usePrefs } from "@/lib/prefs";
import { mountBot, type BotHandle } from "@/lib/bot-avatar/mount";
import { cn } from "@/lib/utils";

export interface BotAvatarProps {
	/** avatarConfig JSON of the expert (or undefined → default look for `seed`). */
	config?: unknown;
	/** Stable seed for the default look and the blink phase: the expert id (or name when there is no id). */
	seed: string;
	/** Accessible name; omit for a decorative avatar. */
	label?: string;
	size?: number;
	/** The expert is working / thinking: plays the full animation (otherwise only blinks). */
	working?: boolean;
	/** One static picture, no canvas (pickers, thumbnails). */
	still?: boolean;
	className?: string;
}

export const BotAvatar = memo(function BotAvatar({ config, seed, label, size = 36, working = false, still = false, className }: BotAvatarProps) {
	const { dark, motionReduced } = usePrefs();
	const ref = useRef<HTMLSpanElement>(null);
	const handle = useRef<BotHandle | null>(null);
	const look = useMemo(() => resolveAvatar(config, seed), [config, seed]);
	const colors = colorsFor(look, dark);
	const opts = { def: look.def, color: colors.color, eyeColor: colors.eyeColor, mood: working ? ("thinking" as const) : ("calm" as const), reducedMotion: motionReduced, size, still };
	const latest = useRef(opts);
	latest.current = opts;
	useEffect(() => {
		handle.current = mountBot(ref.current!, latest.current);
		return () => {
			handle.current?.destroy();
			handle.current = null;
		};
	}, []);
	useEffect(() => {
		handle.current?.update(opts);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [look.key, colors.color, colors.eyeColor, working, motionReduced, size, still]);
	return (
		<span
			ref={ref}
			data-testid="bot-avatar"
			data-shape={look.def.id}
			data-mood={working ? "working" : "calm"}
			{...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
			className={cn("relative inline-block shrink-0", className)}
			style={{ width: size, height: size }}
		/>
	);
});

/** The product's own bot (conversation without an expert): dark body, or a light one on dark pages. */
export function BrandBot(props: Omit<BotAvatarProps, "config" | "seed">) {
	return <BotAvatar config={BRAND_AVATAR} seed="workroom" {...props} />;
}
