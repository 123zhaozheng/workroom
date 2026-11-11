// Height transition for expand / collapse: grid-template-rows 0fr ↔ 1fr (no measuring, no library). The content stays mounted so rows can
// glide in and out of a group; while closed it is `inert` (not focusable, not announced) and visually clipped. Motion is switched off by
// the global reduced-motion rules (transition-duration ~0) and by `instant`.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Collapse({ open, children, className, id, instant }: { open: boolean; children: ReactNode; className?: string; id?: string; instant?: boolean }) {
	return (
		<div
			id={id}
			data-open={open}
			inert={!open}
			className={cn("grid", instant ? "" : "transition-[grid-template-rows,opacity] duration-[250ms] ease-[cubic-bezier(0.22,1,0.36,1)]", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0", className)}
		>
			<div className="min-h-0 overflow-hidden">{children}</div>
		</div>
	);
}
