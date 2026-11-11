// A slim inline line inside the conversation: "正在准备工作环境…" while the remote sandbox is being created / reconnected / restored, and a
// failure line with 重试. Renders nothing otherwise (ready, local, not remote, unknown). It is NOT an overlay: place it in the message flow
// (e.g. just above the composer or under the running tool call) so a pending approval card is never covered. Nothing here blocks sending.
import { Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useEnvironment } from "./useEnvironment";

export interface EnvironmentStatusProps {
	spaceId: string | undefined;
	conversationId: number | undefined;
	/** True while the conversation is running a turn (or, better, a sandbox tool call). Used only to start light polling; a plain chat never creates anything. */
	active?: boolean;
	className?: string;
}

export function EnvironmentStatus({ spaceId, conversationId, active = false, className = "" }: EnvironmentStatusProps) {
	const { env, prepare, busy, retryError, unavailable } = useEnvironment(conversationId === undefined ? undefined : spaceId, conversationId, active);
	const [detail, setDetail] = useState(false);
	if (!env || unavailable || env.kind !== "remote") return null;
	if (env.state === "preparing" || busy)
		return (
			<p role="status" data-testid="env-status" data-state="preparing" className={`flex items-center gap-2 px-1 text-sm text-fg-muted ${className}`}>
				<Loader2 aria-hidden className="size-4 shrink-0 wr-spin" />
				正在准备工作环境…
			</p>
		);
	if (env.state !== "failed") return null;
	return (
		<div role="status" data-testid="env-status" data-state="failed" className={`rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger ${className}`}>
			<p className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<TriangleAlert aria-hidden className="size-4 shrink-0" />
				<span className="min-w-0 break-words">工作环境没有准备好{env.error ? `：${env.error.length > 90 && !detail ? `${env.error.slice(0, 90)}…` : env.error}` : ""}</span>
				{env.canPrepare ? (
					<button type="button" data-testid="env-retry" onClick={() => void prepare()} className="inline-flex h-7 items-center gap-1 rounded-md border border-danger/30 bg-surface px-2 text-xs font-medium text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
						<RotateCcw aria-hidden className="size-3.5" />
						重试
					</button>
				) : (
					<span className="text-xs">请联系管理员</span>
				)}
				{env.error && env.error.length > 90 ? (
					<button type="button" data-testid="env-detail" aria-expanded={detail} onClick={() => setDetail((v) => !v)} className="rounded text-xs underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
						{detail ? "收起" : "详情"}
					</button>
				) : null}
			</p>
			{retryError ? <p role="alert" className="mt-1 text-xs">{retryError}</p> : null}
		</div>
	);
}
