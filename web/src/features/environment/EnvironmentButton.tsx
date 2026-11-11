// The small cloud button next to the composer's "+": where this conversation's code runs, and its state. Two options only:
//   云端沙箱  the active one — which backend (OpenSandbox / E2B / Daytona / 平台内置沙箱), its state, 重试, the working directory (shown when the API gives one)
//   本机环境  the user's own computer — not built yet: shown disabled with 「即将推出」 (no fake button)
// The channel is chosen once for the whole organisation by an admin (管理后台 › 沙箱); nothing here switches it.
// Opening the popover only READS (GET .../environment); it never creates or connects a sandbox. The only action that does is the explicit
// 重试 / 现在准备 button.
import { Check, Cloud, Laptop, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router";
import type { ConversationEnvironmentDTO } from "@shared/sandbox";
import { useSession } from "@/lib/session";
import { Badge } from "@/components/ui/misc";
import { Popover, PopoverContent, PopoverTrigger, Tip } from "@/components/ui/overlay";
import { cn } from "@/lib/utils";
import { useEnvironment } from "./useEnvironment";

export interface EnvironmentButtonProps {
	/** Space the conversation (or the home composer's target) belongs to. Nothing is rendered until it is known. */
	spaceId: string | undefined;
	/** Omit on the home page (no conversation yet): the same environment, state "none". */
	conversationId?: number;
	/** True while a sandbox tool call (or just the turn) is running: the button then follows "preparing" with light polling. */
	active?: boolean;
	/** Popover side; the composer sits at the bottom, so "top" by default. */
	side?: "top" | "bottom";
	disabled?: boolean;
	className?: string;
}

/** The backend's plain name: a third-party channel by its product name, the server's own driver as 平台内置沙箱. */
export function backendName(env: Pick<ConversationEnvironmentDTO, "id">): string {
	switch (env.id) {
		case "opensandbox":
			return "OpenSandbox";
		case "e2b":
			return "E2B";
		case "daytona":
			return "Daytona";
		default:
			return "平台内置沙箱";
	}
}

const LOCAL_TIP = "指你自己的电脑，还没有实现。";

export function EnvironmentButton({ spaceId, conversationId, active, side = "top", disabled, className }: EnvironmentButtonProps) {
	const { env, unavailable, error, prepare, busy, retryError } = useEnvironment(spaceId, conversationId, active);
	const [open, setOpen] = useState(false);
	// Opening focuses the popover itself, not its first control (that is 本地环境, whose tooltip would pop up over the card).
	const bodyRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const { me, isOrgAdmin } = useSession();
	if (!spaceId || unavailable || (error && !env)) return null;

	const remote = env?.kind === "remote";
	const failed = env?.state === "failed";
	const preparing = env?.state === "preparing";
	const canManage = !!me?.permissionsAnywhere?.includes("sandbox.policy.manage") || isOrgAdmin;
	const workDir = env?.workDir;
	const name = env ? backendName(env) : "";

	// One short status word; the failure reason (from the server) follows on its own line.
	const statusText = !env
		? ""
		: failed
			? "准备失败"
			: preparing
				? "准备中…"
				: env.state === "ready"
					? "已就绪"
					: env.state === "lost"
						? "已过期，下次运行自动重建"
						: "未创建，用到时自动创建";

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tip label={env ? `云端沙箱：${name}` : "云端沙箱"}>
				<PopoverTrigger asChild>
					<button
						type="button"
						ref={triggerRef}
						aria-label={env ? `执行环境：云端沙箱（${name}）` : "执行环境"}
						data-testid="env-button"
						data-env-kind={env?.kind ?? "loading"}
						data-env-state={env?.state ?? "loading"}
						disabled={disabled}
						className={cn("relative flex size-10 shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:size-9", className)}
					>
						<Cloud aria-hidden className="size-5" />
						{failed ? <span aria-hidden data-testid="env-dot" className="absolute right-1.5 top-1.5 size-2 rounded-full bg-danger ring-2 ring-bg" /> : preparing ? <span aria-hidden data-testid="env-dot" className="absolute right-1.5 top-1.5 size-2 rounded-full bg-info ring-2 ring-bg wr-pulse" /> : null}
					</button>
				</PopoverTrigger>
			</Tip>
			<PopoverContent side={side} align="start" data-testid="env-popover" className="w-[min(21rem,calc(100vw-1.5rem))] p-3" onOpenAutoFocus={(e) => { e.preventDefault(); bodyRef.current?.focus({ preventScroll: true }); }} onCloseAutoFocus={(e) => { e.preventDefault(); triggerRef.current?.focus(); }}>
				<div ref={bodyRef} tabIndex={-1} className="outline-none">
				{!env ? (
					<p className="flex items-center gap-2 text-sm text-fg-muted"><Loader2 aria-hidden className="size-4 wr-spin" />读取中…</p>
				) : (
					<div className="space-y-2 text-sm">
						<p className="text-xs font-medium text-fg-subtle">代码在哪里运行</p>

						<div data-testid="env-cloud" aria-current="true" className="rounded-xl border border-accent bg-surface p-3">
							<div className="flex items-center gap-2">
								<Cloud aria-hidden className="size-4 shrink-0 text-fg-muted" />
								<span className="font-medium">云端沙箱</span>
								<Check aria-hidden className="size-4 text-success" />
								<span className="sr-only">（当前）</span>
							</div>
							<p data-testid="env-label" className="mt-1.5 break-words text-fg">{name}</p>
							<div data-testid="env-state" data-state={env.state} role="status" className={cn("mt-1.5 flex items-start gap-1.5 text-xs", failed ? "text-danger" : preparing ? "text-info" : "text-fg-muted")}>
								{failed ? <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" /> : preparing ? <Loader2 aria-hidden className="mt-0.5 size-3.5 shrink-0 wr-spin" /> : null}
								<span className="min-w-0 break-words">
									{statusText}
									{failed ? `：${env.error ?? "原因未知"}` : ""}
								</span>
							</div>
							{workDir ? (
								<p data-testid="env-workdir" className="mt-1.5 break-all text-xs text-fg-muted">
									工作目录 <code className="rounded bg-surface-2 px-1 py-0.5 font-mono">{workDir}</code>
								</p>
							) : null}
							{remote && env.canPrepare && (failed || env.state === "none" || env.state === "lost") ? (
								<button
									type="button"
									data-testid="env-prepare"
									disabled={busy}
									onClick={() => void prepare()}
									className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-xs font-medium text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
								>
									{busy ? <Loader2 aria-hidden className="size-3.5 wr-spin" /> : <RotateCcw aria-hidden className="size-3.5" />}
									{failed ? "重试" : "现在准备"}
								</button>
							) : null}
							{retryError ? <p role="alert" className="mt-1.5 text-xs text-danger">{retryError}</p> : null}
						</div>

						<Tip label={LOCAL_TIP}>
							<button
								type="button"
								data-testid="env-local"
								aria-disabled="true"
								onClick={(e) => e.preventDefault()}
								className="flex w-full cursor-not-allowed items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2.5 text-left text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<Laptop aria-hidden className="size-4 shrink-0" />
								<span className="min-w-0 flex-1">
									<span className="block">本地环境</span>
									<span className="block text-xs">指你自己的电脑</span>
								</span>
								<Badge>即将推出</Badge>
							</button>
						</Tip>

						{canManage ? (
							<Link to="/admin?tab=sandbox" data-testid="env-admin-link" onClick={() => setOpen(false)} className="inline-block rounded text-xs font-medium text-info underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
								管理后台 › 沙箱
							</Link>
						) : null}
					</div>
				)}
				</div>
			</PopoverContent>
		</Popover>
	);
}
