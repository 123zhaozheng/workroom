// Dropdown parts the shared overlay does not export: a submenu, and the "…" trigger used on sidebar rows.
// Same surface rules as components/ui/overlay.tsx: opaque bg-surface + border + shadow-pop, flips at the viewport edge.
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { DropdownMenu as DM } from "radix-ui";
import { forwardRef, type ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const MenuSub = DM.Sub;

export function MenuSubTrigger({ className, children, ...props }: ComponentProps<typeof DM.SubTrigger>) {
	return (
		<DM.SubTrigger
			className={cn(
				"flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-fg outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:ring-1 data-[highlighted]:ring-inset data-[highlighted]:ring-border-strong data-[state=open]:bg-surface-2 data-[disabled]:opacity-60 [&_svg]:size-4 [&_svg]:text-fg-muted",
				className,
			)}
			{...props}
		>
			{children}
			<ChevronRight className="ml-auto" />
		</DM.SubTrigger>
	);
}

export function MenuSubContent({ className, ...props }: ComponentProps<typeof DM.SubContent>) {
	return (
		<DM.Portal>
			<DM.SubContent
				sideOffset={4}
				collisionPadding={{ top: 64, bottom: 12, left: 12, right: 12 }}
				className={cn("z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-44 max-w-64 overflow-y-auto rounded-xl border border-border bg-surface p-1 text-fg shadow-pop wr-fade-in", className)}
				{...props}
			/>
		</DM.Portal>
	);
}

/**
 * The "…" button of a row. Hidden until the row is hovered, a control inside it has keyboard focus, or its menu is open — and always
 * shown on touch screens (no hover there). It stays in the tab order while hidden, so a keyboard user reaches it and sees it appear.
 */
export const RowMenuButton = forwardRef<HTMLButtonElement, ComponentProps<"button">>(({ className, ...props }, ref) => (
	<button
		ref={ref}
		type="button"
		className={cn(
			"absolute right-1 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-fg-muted opacity-0 outline-none transition-opacity duration-150 hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100 data-[state=open]:bg-surface-3 data-[state=open]:opacity-100 pointer-coarse:opacity-100 [@media(hover:none)]:opacity-100",
			className,
		)}
		{...props}
	>
		<MoreHorizontal className="size-4" />
	</button>
));
RowMenuButton.displayName = "RowMenuButton";
