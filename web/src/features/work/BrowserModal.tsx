// Enlarged live browser: a big centered dialog (same overlay / card / Esc / focus handling as the Ctrl+K search dialog) showing
// the session's screenshot (refreshed with `version`), URL, title and who controls it. Take-over, release and in-page
// click / type / scroll reuse BrowserSessionView (the same component and API as the small preview); viewers only watch.
import { Globe, X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { useRef } from "react";
import type { BrowserSessionDTO } from "@shared/files";
import { BrowserSessionView } from "./live";

export function BrowserModal({ s, open, onOpenChange, onChanged }: { s: BrowserSessionDTO; open: boolean; onOpenChange: (o: boolean) => void; onChanged?: () => void }) {
	const opener = useRef<HTMLElement | null>(null);
	return (
		<D.Root open={open} onOpenChange={onOpenChange}>
			<D.Portal>
				<D.Overlay className="fixed inset-0 z-50 bg-[var(--overlay)] wr-fade-in" />
				<D.Content
					data-testid="browser-modal"
					aria-describedby={undefined}
					onOpenAutoFocus={(e) => {
						const a = document.activeElement;
						opener.current = a instanceof HTMLElement && a !== document.body ? a : null;
					}}
					onCloseAutoFocus={(e) => {
						e.preventDefault();
						const el = opener.current;
						opener.current = null;
						if (el?.isConnected) el.focus({ preventScroll: true });
					}}
					className="fixed left-1/2 top-1/2 z-50 flex h-[min(860px,92dvh)] w-[calc(100vw-24px)] max-w-[1240px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-pop wr-fade-in focus:outline-none"
				>
					<div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
						<Globe aria-hidden className="size-[18px] shrink-0 text-fg-muted" strokeWidth={1.5} />
						<D.Title data-testid="browser-modal-title" className="min-w-0 flex-1 truncate text-[14px] font-medium">
							{s.title || "（无标题）"}
						</D.Title>
						<D.Close data-testid="browser-modal-close" aria-label="关闭" title="关闭" className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-subtle hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
							<X className="size-4" />
						</D.Close>
					</div>
					<div className="min-h-0 flex-1">
						<BrowserSessionView s={s} variant="modal" onChanged={onChanged ?? (() => {})} />
					</div>
				</D.Content>
			</D.Portal>
		</D.Root>
	);
}
