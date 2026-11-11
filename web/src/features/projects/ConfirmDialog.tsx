// Confirmation for destructive menu actions. Focus starts on 取消 (never on the destructive button); a failed call shows its reason and stays open.
import { useState, type ReactNode } from "react";
import { errorText } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/overlay";

export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	children,
	confirmLabel,
	onConfirm,
	testId,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	title: string;
	children: ReactNode;
	confirmLabel: string;
	onConfirm: () => Promise<unknown>;
	testId?: string;
}) {
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (busy) return;
				setErr(undefined);
				onOpenChange(o);
			}}
		>
			<DialogContent title={title} description={children} data-testid={testId} onOpenAutoFocus={(e) => {
				e.preventDefault();
				(e.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-cancel]")?.focus();
			}}>
				{err ? (
					<p role="alert" className="mb-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
						{err}
					</p>
				) : null}
				<div className="flex justify-end gap-2">
					<Button data-cancel variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
						取消
					</Button>
					<Button
						variant="danger"
						data-testid="confirm-ok"
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							setErr(undefined);
							try {
								await onConfirm();
								onOpenChange(false);
							} catch (e) {
								setErr(errorText(e));
							} finally {
								setBusy(false);
							}
						}}
					>
						{confirmLabel}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
