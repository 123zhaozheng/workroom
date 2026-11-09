import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
	"inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-sm font-medium transition-colors disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 select-none",
	{
		variants: {
			variant: {
				primary: "bg-accent text-accent-fg hover:opacity-90",
				secondary: "bg-surface border border-border text-fg hover:bg-surface-2",
				ghost: "text-fg-muted hover:bg-surface-2 hover:text-fg",
				danger: "bg-danger text-white hover:opacity-90",
				link: "text-info underline-offset-2 hover:underline px-0 h-auto",
			},
			size: {
				sm: "h-8 px-2.5 text-[13px]",
				md: "h-9 px-3.5",
				lg: "h-10 px-4",
				icon: "size-8 p-0",
				"icon-sm": "size-7 p-0 [&_svg]:size-[15px]",
			},
		},
		defaultVariants: { variant: "secondary", size: "md" },
	},
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
	asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, type, ...props }, ref) => {
	const Comp = asChild ? Slot.Root : "button";
	return <Comp ref={ref} type={asChild ? undefined : (type ?? "button")} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
Button.displayName = "Button";
