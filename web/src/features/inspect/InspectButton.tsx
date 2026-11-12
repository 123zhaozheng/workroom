// The bug icon in an assistant reply's action bar. Renders nothing unless the org switch is on and the viewer holds the permission,
// so a disabled feature leaves no trace in the UI. The conversation comes from the route (/c/:spaceId/:conversationId).
import { Bug } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router";
import { Tip } from "@/components/ui/overlay";
import { InspectDrawer } from "./InspectDrawer";
import { useHarnessInspectStatus } from "./status";

export function InspectButton({ turn, standalone }: { turn: { requestedAt?: number; startedAt?: number; endedAt?: number; finishedAt?: number }; standalone?: boolean }) {
	const status = useHarnessInspectStatus();
	const { spaceId, conversationId } = useParams();
	const [open, setOpen] = useState(false);
	if (!status?.enabled || !status.canInspect || !spaceId || !conversationId) return null;
	const button = (
		<>
			<Tip label="Harness 检视">
				<button
					type="button"
					data-testid="action-inspect"
					aria-label="Harness 检视"
					onClick={() => setOpen(true)}
					className="rounded-md p-1.5 text-fg-subtle hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-[15px]"
				>
					<Bug />
				</button>
			</Tip>
			{open ? <InspectDrawer open onOpenChange={setOpen} spaceId={spaceId} conversationId={conversationId} window={{ from: turn.requestedAt ?? turn.startedAt, to: turn.endedAt ?? turn.finishedAt }} /> : null}
		</>
	);
	return standalone ? <div className="mt-1.5 flex h-7 items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">{button}</div> : button;
}
