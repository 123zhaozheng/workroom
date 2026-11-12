// A document preview as a large dialog (wide screens, where the page already has a list and a detail column and the global right
// panel would squeeze them). It hosts the same PreviewPanel the chat and the files page use, so viewers,
// download and "open in new tab" behave identically.
import { Dialog as D } from "radix-ui";
import { lazy, Suspense } from "react";
import type { PreviewTarget } from "@/components/shell/panel";
import { Spinner } from "@/components/ui/misc";

const PreviewPanel = lazy(() => import("@/features/preview/PreviewPanel"));

export function PreviewDialog({ target, onClose }: { target: PreviewTarget | null; onClose: () => void }) {
	return (
		<D.Root open={!!target} onOpenChange={(o) => !o && onClose()}>
			<D.Portal>
				<D.Overlay className="fixed inset-0 z-50 bg-[var(--overlay)] wr-fade-in" />
				<D.Content
					data-testid="preview-dialog"
					className="fixed left-1/2 top-1/2 z-50 flex h-[min(82dvh,800px)] w-[min(960px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-pop wr-fade-in focus:outline-none"
				>
					<D.Title className="sr-only">文件预览</D.Title>
					<D.Description className="sr-only">预览所选文件，可下载。</D.Description>
					{target ? (
						<Suspense
							fallback={
								<div role="status" className="flex h-full items-center justify-center gap-2 text-sm text-fg-muted">
									<Spinner /> 正在加载预览…
								</div>
							}
						>
							<PreviewPanel target={target} onClose={onClose} />
						</Suspense>
					) : null}
				</D.Content>
			</D.Portal>
		</D.Root>
	);
}
