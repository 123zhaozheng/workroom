import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes, type LabelHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
	<input
		ref={ref}
		className={cn(
			"h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-fg-subtle outline-none transition-colors focus:border-border-strong focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60",
			className,
		)}
		{...props}
	/>
));
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
	<textarea
		ref={ref}
		className={cn("w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-subtle outline-none focus:border-border-strong", className)}
		{...props}
	/>
));
Textarea.displayName = "Textarea";

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
	return <label className={cn("mb-1.5 block text-[13px] font-medium text-fg-muted", className)} {...props} />;
}

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
	return <select className={cn("h-9 rounded-lg border border-border bg-surface px-2.5 text-sm text-fg outline-none focus:border-border-strong", className)} {...props} />;
}
