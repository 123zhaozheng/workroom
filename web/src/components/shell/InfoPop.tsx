// A small "?" button that opens an opaque popover with a short explanation. Works with mouse, keyboard and touch
// (unlike a hover tooltip), so second-level explanations can live here instead of in permanent subtitles.
import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlay";

export function InfoPop({ label = "说明", children, className, testid }: { label?: string; children: ReactNode; className?: string; testid?: string }) {
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					data-testid={testid}
					aria-label={label}
					className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
				>
					<Info className="size-3.5" aria-hidden />
				</button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-72 max-w-[calc(100vw-24px)] p-3 text-[13px] leading-5 text-fg-muted">
				{children}
			</PopoverContent>
		</Popover>
	);
}
