// Dialog, Sheet (drawer), DropdownMenu, Popover, Tooltip — Radix primitives with local styling.
import { Dialog as D, DropdownMenu as DM, Popover as P, Tooltip as T } from "radix-ui";
import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

// ---------- Dialog ----------
export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;
export function DialogContent({ className, children, title, description, ...props }: ComponentProps<typeof D.Content> & { title: ReactNode; description?: ReactNode }) {
	return (
		<D.Portal>
			<D.Overlay className="fixed inset-0 z-50 bg-[var(--overlay)] wr-fade-in" />
			<D.Content
				className={cn(
					"fixed left-1/2 top-1/2 z-50 w-[calc(100vw-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-pop wr-fade-in focus:outline-none",
					className,
				)}
				{...props}
			>
				<div className="mb-3 flex items-start justify-between gap-4">
					<div>
						<D.Title className="text-base font-semibold">{title}</D.Title>
						{description ? <D.Description className="mt-1 text-[13px] text-fg-muted">{description}</D.Description> : <D.Description className="sr-only">{String(title)}</D.Description>}
					</div>
					<D.Close className="rounded-md p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg" aria-label="关闭">
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
	return (
		<D.Root open={open} onOpenChange={onOpenChange}>
			<D.Portal>
				<D.Overlay className="fixed inset-0 z-40 bg-[var(--overlay)] wr-fade-in" />
				<D.Content
					data-testid={`sheet-${side}`}
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
export function MenuContent({ className, align = "start", sideOffset = 6, ...props }: ComponentProps<typeof DM.Content>) {
	return (
		<DM.Portal>
			<DM.Content
				align={align}
				sideOffset={sideOffset}
				className={cn("z-50 min-w-48 rounded-xl border border-border bg-surface p-1 shadow-pop wr-fade-in", className)}
				{...props}
			/>
		</DM.Portal>
	);
}
export function MenuItem({ className, ...props }: ComponentProps<typeof DM.Item>) {
	return (
		<DM.Item
			className={cn(
				"flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-fg outline-none data-[highlighted]:bg-surface-2 data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-fg-muted",
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
export function PopoverContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof P.Content>) {
	return (
		<P.Portal>
			<P.Content sideOffset={sideOffset} className={cn("z-50 rounded-xl border border-border bg-surface p-1 shadow-pop wr-fade-in focus:outline-none", className)} {...props} />
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
				<T.Content side={side} sideOffset={6} className="z-50 rounded-md bg-accent px-2 py-1 text-xs text-accent-fg">
					{label}
				</T.Content>
			</T.Portal>
		</T.Root>
	);
}
