// Progressive disclosure for the cards that ask the person to decide: the face shows what is needed to decide (what, how risky, the buttons),
// everything else is one 查看详情 away. Nothing is dropped, only folded.
import { ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The small text button that opens / closes a card's folded part. `controls` is the id of the panel it opens. */
export function DetailsToggle({ open, onToggle, controls, testId = "approval-details-toggle", label = "查看详情", openLabel = "收起详情", className }: { open: boolean; onToggle: () => void; controls: string; testId?: string; label?: string; openLabel?: string; className?: string }) {
	return (
		<button
			type="button"
			data-testid={testId}
			aria-expanded={open}
			aria-controls={controls}
			onClick={onToggle}
			className={cn("inline-flex h-8 items-center gap-0.5 rounded-md px-2 text-xs text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info", className)}
		>
			{open ? openLabel : label}
			<ChevronDown aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-180")} />
		</button>
	);
}

/** The folded part itself. Always in the DOM (so 技术详情 and friends can be found), hidden until opened. */
export function DetailsPanel({ id, open, testId = "approval-details", children, className }: { id: string; open: boolean; testId?: string; children: ReactNode; className?: string }) {
	const ref = useRef<HTMLDivElement>(null);
	// opened at the bottom of the conversation it would grow under the composer: bring it into view
	useEffect(() => {
		if (open) ref.current?.scrollIntoView({ block: "nearest" });
	}, [open]);
	return (
		<div ref={ref} id={id} data-testid={testId} hidden={!open} className={cn("mt-2.5 space-y-2 border-t border-border pt-2.5", className)}>
			{children}
		</div>
	);
}

const CLAMP: Record<number, string> = { 2: "line-clamp-2", 3: "line-clamp-3" };

/** A paragraph cut to `lines` lines; only when it really is cut does a 展开全文 button appear (text-level disclosure, no duplicate in the details). */
export function ClampText({ children, lines = 2, className, testId, id }: { children: ReactNode; lines?: 2 | 3; className?: string; testId?: string; id?: string }) {
	const ref = useRef<HTMLParagraphElement>(null);
	const [open, setOpen] = useState(false);
	const [over, setOver] = useState(false);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || open) return;
		const measure = () => setOver(el.scrollHeight > el.clientHeight + 1);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [open, children]);
	return (
		<>
			<p ref={ref} id={id} data-testid={testId} className={cn("break-words", !open && CLAMP[lines], className)}>
				{children}
			</p>
			{over || open ? (
				<button type="button" data-testid="clamp-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="text-xs text-info hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info">
					{open ? "收起" : "展开全文"}
				</button>
			) : null}
		</>
	);
}
