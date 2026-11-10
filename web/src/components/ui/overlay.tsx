// Dialog, Sheet (drawer), DropdownMenu, Popover, Tooltip — Radix primitives with local styling.
//
// Shared rules (docs/design-guidelines.md): every surface is opaque (bg-surface + border + shadow-pop); the entrance animation only
// touches opacity/transform and ends fully opaque; dialogs / sheets trap focus (Radix modal), close with Esc and give focus back to
// the element that opened them; dropdown menus flip at the viewport edge and are capped to the room that is really available, so they
// never run under the top bar.
import { Dialog as D, DropdownMenu as DM, Popover as P, Tooltip as T } from "radix-ui";
import { X } from "lucide-react";
import { useRef, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type FocusEv = Event;
/**
 * Remember what had focus when a modal surface opened and give it back when the surface closes. Radix only does this when a
 * <Trigger> is rendered inside the same Root; most dialogs here are controlled (opened from a menu item or a keyboard shortcut).
 * If the opener is gone (a menu item that unmounted), Radix' own behaviour applies.
 */
function useFocusRestore(handlers: { onOpenAutoFocus?: (e: FocusEv) => void; onCloseAutoFocus?: (e: FocusEv) => void }) {
	const opener = useRef<HTMLElement | null>(null);
	return {
		onOpenAutoFocus: (e: FocusEv) => {
			const a = document.activeElement;
			opener.current = a instanceof HTMLElement && a !== document.body ? a : null;
			handlers.onOpenAutoFocus?.(e);
		},
		onCloseAutoFocus: (e: FocusEv) => {
			handlers.onCloseAutoFocus?.(e);
			const el = opener.current;
			opener.current = null;
			if (e.defaultPrevented) return;
			if (el && el.isConnected) {
				e.preventDefault();
				el.focus({ preventScroll: true });
			}
		},
	};
}

// ---------- Dialog ----------
export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;
export function DialogContent({ className, children, title, description, onOpenAutoFocus, onCloseAutoFocus, ...props }: ComponentProps<typeof D.Content> & { title: ReactNode; description?: ReactNode }) {
	const focus = useFocusRestore({ onOpenAutoFocus, onCloseAutoFocus });
	return (
		<D.Portal>
			<D.Overlay className="fixed inset-0 z-50 bg-[var(--overlay)] wr-fade-in" />
			<D.Content
				className={cn(
					"fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-surface p-5 shadow-pop wr-fade-in focus:outline-none",
					className,
				)}
				{...props}
				{...focus}
			>
				<div className="mb-3 flex items-start justify-between gap-4">
					<div className="min-w-0">
						<D.Title className="text-base font-semibold">{title}</D.Title>
						{description ? <D.Description className="mt-1 text-sm text-fg-muted">{description}</D.Description> : <D.Description className="sr-only">{String(title)}</D.Description>}
					</div>
					<D.Close className="-mr-1 -mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-subtle hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="关闭">
						<X className="size-4" />
					</D.Close>
				</div>
				{children}
			</D.Content>
		</D.Portal>
	);
}

// ---------- Sheet (drawer for narrow screens) ----------
export function Sheet({
	open,
	onOpenChange,
	side = "right",
	title,
	children,
	className,
	hideTitle,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	side?: "left" | "right";
	title: string;
	children: ReactNode;
	className?: string;
	hideTitle?: boolean;
}) {
	const focus = useFocusRestore({});
	return (
		<D.Root open={open} onOpenChange={onOpenChange}>
			<D.Portal>
				<D.Overlay className="fixed inset-0 z-40 bg-[var(--overlay)] wr-fade-in" />
				<D.Content
					data-testid={`sheet-${side}`}
					{...focus}
					className={cn(
						"fixed inset-y-0 z-50 flex flex-col bg-surface shadow-pop focus:outline-none",
						side === "right" ? "right-0 w-full max-w-[100vw] wr-drawer-right sm:max-w-[560px]" : "left-0 w-[86vw] max-w-[320px] wr-drawer-left",
						className,
					)}
				>
					<D.Title className={hideTitle ? "sr-only" : "sr-only"}>{title}</D.Title>
					<D.Description className="sr-only">{title}</D.Description>
					{children}
				</D.Content>
			</D.Portal>
		</D.Root>
	);
}

// ---------- Dropdown ----------
export const Menu = DM.Root;
export const MenuTrigger = DM.Trigger;
/** Room kept free above (top bar) and at the other edges; menus flip or shrink instead of covering the title bar. */
const MENU_PADDING = { top: 64, bottom: 12, left: 12, right: 12 };
export function MenuContent({ className, align = "start", sideOffset = 6, collisionPadding = MENU_PADDING, ...props }: ComponentProps<typeof DM.Content>) {
	return (
		<DM.Portal>
			<DM.Content
				align={align}
				sideOffset={sideOffset}
				collisionPadding={collisionPadding}
				className={cn("z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-48 overflow-y-auto rounded-xl border border-border bg-surface p-1 text-fg shadow-pop wr-fade-in", className)}
				{...props}
			/>
		</DM.Portal>
	);
}
export function MenuItem({ className, ...props }: ComponentProps<typeof DM.Item>) {
	return (
		<DM.Item
			className={cn(
				"flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-fg outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:ring-1 data-[highlighted]:ring-inset data-[highlighted]:ring-border-strong data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-fg-muted",
				className,
			)}
			{...props}
		/>
	);
}
export const MenuRadioGroup = DM.RadioGroup;
/** A choice inside a menu that stays reachable with the arrow keys (unlike plain buttons, which Radix menus skip). */
export function MenuRadioItem({ className, ...props }: ComponentProps<typeof DM.RadioItem>) {
	return (
		<DM.RadioItem
			className={cn(
				"flex cursor-default items-center justify-center rounded-md px-1.5 text-sm text-fg-muted outline-none data-[highlighted]:ring-2 data-[highlighted]:ring-ring data-[state=checked]:bg-surface data-[state=checked]:text-fg data-[state=checked]:shadow-sm",
				className,
			)}
			{...props}
		/>
	);
}
export function MenuLabel({ className, ...props }: ComponentProps<typeof DM.Label>) {
	return <DM.Label className={cn("px-2.5 pb-1 pt-1.5 text-xs text-fg-subtle", className)} {...props} />;
}
export const MenuSeparator = () => <DM.Separator className="my-1 h-px bg-border" />;

// ---------- Popover ----------
export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;
export function PopoverContent({ className, sideOffset = 6, collisionPadding = MENU_PADDING, ...props }: ComponentProps<typeof P.Content>) {
	return (
		<P.Portal>
			<P.Content
				sideOffset={sideOffset}
				collisionPadding={collisionPadding}
				className={cn("z-50 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-xl border border-border bg-surface p-1 text-fg shadow-pop wr-fade-in focus:outline-none", className)}
				{...props}
			/>
		</P.Portal>
	);
}

// ---------- Tooltip ----------
export const TooltipProvider = T.Provider;
export function Tip({ label, children, side = "top" }: { label: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
	return (
		<T.Root delayDuration={400}>
			<T.Trigger asChild>{children}</T.Trigger>
			<T.Portal>
				<T.Content side={side} sideOffset={6} collisionPadding={8} className="z-[60] max-w-[260px] rounded-md bg-accent px-2 py-1 text-xs text-accent-fg">
					{label}
				</T.Content>
			</T.Portal>
		</T.Root>
	);
}

// ---------- Bottom sheet (phones: replaces dropdown menus that would be cramped) ----------
export function BottomSheet({ open, onOpenChange, title, children, className }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; children: ReactNode; className?: string }) {
	const focus = useFocusRestore({});
	return (
		<D.Root open={open} onOpenChange={onOpenChange}>
			<D.Portal>
				<D.Overlay className="fixed inset-0 z-50 bg-[var(--overlay)] wr-fade-in" />
				<D.Content
					data-testid="bottom-sheet"
					{...focus}
					className={cn("fixed inset-x-0 bottom-0 z-50 flex max-h-[82dvh] flex-col rounded-t-2xl border-t border-border bg-surface pb-[max(12px,env(safe-area-inset-bottom))] shadow-pop wr-sheet-up focus:outline-none", className)}
				>
					<div className="mx-auto mb-1 mt-2 h-1 w-9 shrink-0 rounded-full bg-border-strong" aria-hidden />
					<D.Title className="px-5 pb-2 pt-1 text-sm font-medium text-fg-muted">{title}</D.Title>
					<D.Description className="sr-only">{title}</D.Description>
					<div className="wr-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-1">{children}</div>
				</D.Content>
			</D.Portal>
		</D.Root>
	);
}
