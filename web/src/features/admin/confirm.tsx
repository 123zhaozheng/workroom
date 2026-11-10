// In-page confirmation for sensitive / high-risk operations: states the consequence, focus starts on 取消, Esc cancels.
// Usage:  const { ask, dialog } = useConfirm();  …  if (await ask({ title, consequence, confirmLabel })) doIt();  …  {dialog}
import { AlertTriangle } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/overlay";

export interface ConfirmOptions {
	title: string;
	/** What will happen, in plain words (one sentence, or a list via `items`). */
	consequence: ReactNode;
	items?: string[];
	confirmLabel?: string;
	/** red button + warning icon (removal, high-risk grants, ownership) */
	danger?: boolean;
}

export function useConfirm() {
	const [opts, setOpts] = useState<ConfirmOptions>();
	const resolver = useRef<(ok: boolean) => void>(undefined);
	const cancelRef = useRef<HTMLButtonElement>(null);
	const ask = useCallback(
		(o: ConfirmOptions) =>
			new Promise<boolean>((resolve) => {
				resolver.current?.(false);
				resolver.current = resolve;
				setOpts(o);
			}),
		[],
	);
	const settle = (ok: boolean) => {
		resolver.current?.(ok);
		resolver.current = undefined;
		setOpts(undefined);
	};
	const dialog = opts ? (
		<Dialog open onOpenChange={(o) => !o && settle(false)}>
			<DialogContent
				title={opts.title}
				data-testid="confirm-dialog"
				onOpenAutoFocus={(e) => {
					e.preventDefault();
					cancelRef.current?.focus();
				}}
			>
				<div className="flex gap-3 text-sm">
					{opts.danger ? <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" /> : null}
					<div className="min-w-0 space-y-2">
						<p>{opts.consequence}</p>
						{opts.items?.length ? (
							<ul className="list-disc space-y-0.5 pl-5 text-fg-muted">
								{opts.items.map((x) => (
									<li key={x}>{x}</li>
								))}
							</ul>
						) : null}
					</div>
				</div>
				<div className="mt-5 flex justify-end gap-2">
					<Button ref={cancelRef} onClick={() => settle(false)} data-testid="confirm-cancel">
						取消
					</Button>
					<Button variant={opts.danger ? "danger" : "primary"} className={opts.danger ? "dark:text-[#2a0c09]" : undefined} onClick={() => settle(true)} data-testid="confirm-ok">
						{opts.confirmLabel ?? "确认"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	) : null;
	return { ask, dialog };
}
