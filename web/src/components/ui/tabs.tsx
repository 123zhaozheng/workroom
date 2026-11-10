import { Tabs as TB } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const Tabs = TB.Root;
export const TabsContent = TB.Content;
export function TabsList({ className, ...props }: ComponentProps<typeof TB.List>) {
	return <TB.List className={cn("inline-flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5", className)} {...props} />;
}
export function TabsTrigger({ className, ...props }: ComponentProps<typeof TB.Trigger>) {
	return (
		<TB.Trigger
			className={cn(
				"inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm text-fg-muted transition-colors data-[state=active]:bg-surface data-[state=active]:text-fg data-[state=active]:shadow-sm [&_svg]:size-3.5",
				className,
			)}
			{...props}
		/>
	);
}
