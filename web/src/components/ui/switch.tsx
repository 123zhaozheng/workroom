// Two-state setting switch on the Radix Switch primitive (role="switch", aria-checked, Space toggles).
// Use only for a true on/off setting that applies immediately. Lists of choices, permission matrices, row selection,
// tri-state boxes and "I understand" consent stay plain checkboxes.
// On = blue (--info: AA against the surface in both themes); the thumb flips between --accent-fg and --fg-subtle so the state
// never depends on hue alone. `busy` shows a spinner and aria-busy (clicks ignored); `invalid` marks a failed save.
import { Loader2 } from "lucide-react";
import { Switch as SW } from "radix-ui";
import { cn } from "@/lib/utils";

type Named = { "aria-label": string; "aria-labelledby"?: string; id?: string } | { "aria-labelledby": string; "aria-label"?: string; id?: string } | { id: string; "aria-label"?: string; "aria-labelledby"?: string };
export type SwitchProps = Named & {
	checked: boolean;
	onCheckedChange: (v: boolean) => void;
	disabled?: boolean;
	busy?: boolean;
	invalid?: boolean;
	className?: string;
	"data-testid"?: string;
};

export function Switch({ checked, onCheckedChange, disabled, busy, invalid, className, ...rest }: SwitchProps) {
	return (
		<SW.Root
			{...rest}
			checked={checked}
			onCheckedChange={onCheckedChange}
			disabled={disabled || busy}
			aria-busy={busy || undefined}
			aria-invalid={invalid || undefined}
			className={cn(
				"group relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border border-fg-subtle bg-surface-3 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-50 disabled:aria-[busy=true]:opacity-80 data-[state=checked]:border-info data-[state=checked]:bg-info aria-[invalid=true]:border-danger aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-danger/40 aria-[busy=true]:cursor-progress",
				"before:absolute before:-inset-2 before:content-['']", // 44px touch target
				className,
			)}
		>
			<SW.Thumb className="pointer-events-none flex size-4 translate-x-[3px] items-center justify-center rounded-full bg-fg-subtle shadow-sm transition-transform data-[state=checked]:translate-x-[19px] data-[state=checked]:bg-accent-fg">
				{busy ? <Loader2 aria-hidden className="size-3 wr-spin text-fg" /> : null}
			</SW.Thumb>
		</SW.Root>
	);
}
