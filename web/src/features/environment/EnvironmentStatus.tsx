// A slim inline line inside the conversation, only when preparing the sandbox failed while a turn waits for it and nothing else in the
// conversation already says so: ONE compact failure line with 重试 (details one click away). Preparing itself shows nothing here (round 11).
// A failed sandbox step in the latest answer already shows the same reason inline (`explainedBy`): then this line stays out of the way and the
// environment button's red dot (with its 重试) is the only other mark. Renders nothing otherwise (ready, local, not remote, unknown).
// It is NOT an overlay: place it in the message flow so a pending approval card is never covered. Nothing here blocks sending.
import { RotateCcw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useEnvironment } from "./useEnvironment";

export interface EnvironmentStatusProps {
	spaceId: string | undefined;
	conversationId: number | undefined;
	/** True while the conversation is running a turn (or, better, a sandbox tool call). Used only to start light polling; a plain chat never creates anything. */
	active?: boolean;
	className?: string;
	/** Texts of failed sandbox steps shown in the latest answer. If one of them carries this environment's error, the failure is already visible there. */
	explainedBy?: readonly string[];
}

export function EnvironmentStatus({ spaceId, conversationId, active = false, className = "", explainedBy = [] }: EnvironmentStatusProps) {
	const { env, prepare, busy, retryError, unavailable } = useEnvironment(conversationId === undefined ? undefined : spaceId, conversationId, active);
	const [detail, setDetail] = useState(false);
	if (!env || unavailable || env.kind !== "remote") return null;
	// Round 11 (R1): provisioning / resuming never shows a line — the button's dot is the only mark. A failure is shown here only while a turn
	// is running (something is waiting for the sandbox); a failed background prewarm is just the red dot (重试 in the popover).
	if (env.state !== "failed" || busy || !active) return null;
	const tail = (env.error ?? "").slice(-18);
	if (tail && explainedBy.some((t) => t.includes(tail))) return null;
	const long = !!env.error && env.error.length > 60;
	return (
		<div role="status" data-testid="env-status" data-state="failed" className={`rounded-lg bg-danger-soft px-3 py-1.5 text-[13px] text-danger ${className}`}>
			<div className="flex items-center gap-2">
				<TriangleAlert aria-hidden className="size-4 shrink-0" />
				<span className={`min-w-0 flex-1 ${detail ? "break-words" : "truncate"}`}>工作环境没有准备好{env.error ? `：${env.error}` : ""}</span>
				{long ? (
					<button type="button" data-testid="env-detail" aria-expanded={detail} onClick={() => setDetail((v) => !v)} className="shrink-0 rounded text-xs underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
						{detail ? "收起" : "详情"}
					</button>
				) : null}
				{env.canPrepare ? (
					<button type="button" data-testid="env-retry" onClick={() => void prepare()} className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-danger/30 bg-surface px-2 text-xs font-medium text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
						<RotateCcw aria-hidden className="size-3.5" />
						重试
					</button>
				) : (
					<span className="shrink-0 text-xs">请联系管理员</span>
				)}
			</div>
			{retryError ? <p role="alert" className="mt-1 text-xs">{retryError}</p> : null}
		</div>
	);
}
