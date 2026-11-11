// "?" button that opens a short explanation in an opaque popover. Click/tap, Enter and Space open it (aria-expanded comes from
// Radix); Escape or a click outside closes it and gives focus back. Put secondary explanations here. Danger and irreversible
// consequences stay in the page where they are visible.
import { CircleHelp } from "lucide-react";
import { Popover as P } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Help({ label = "说明", children, side = "bottom", className, testId }: { label?: string; children: ReactNode; side?: "top" | "bottom" | "left" | "right"; className?: string; testId?: string }) {
	return (
		<P.Root>
			<P.Trigger
				type="button"
				aria-label={label}
				data-testid={testId ?? "help"}
				className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-full text-fg-subtle outline-none hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-surface-2 data-[state=open]:text-fg before:absolute before:size-9 before:content-[''] relative", className)}
			>
				<CircleHelp aria-hidden className="size-4" />
			</P.Trigger>
			<P.Portal>
				<P.Content
					side={side}
					align="end"
					sideOffset={6}
					collisionPadding={{ top: 64, bottom: 12, left: 12, right: 12 }}
					data-testid="help-content"
					className="z-[70] max-h-[var(--radix-popover-content-available-height)] w-[min(20rem,calc(100vw-24px))] overflow-y-auto rounded-xl border border-border bg-surface p-3 text-sm leading-relaxed text-fg-muted shadow-pop wr-fade-in focus:outline-none"
				>
					{children}
				</P.Content>
			</P.Portal>
		</P.Root>
	);
}
