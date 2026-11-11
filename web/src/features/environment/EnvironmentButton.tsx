// The small cloud button next to the composer's "+": where this conversation's code runs, and its state. Two options only:
//   云端沙箱  the active one (a failure adds one short line with 重试; the reason is on hover)
//   本地环境  the user's own computer — not built yet: shown disabled (no fake button)
// Round 10 user feedback: minimal — no headings, backend names, working directory or explanations in the list.
// The channel is chosen once for the whole organisation by an admin (管理后台 › 沙箱); nothing here switches it.
// Opening the popover only READS (GET .../environment); it never creates or connects a sandbox. The only action that does is the explicit
// 重试 / 现在准备 button.
import { Check, Cloud, Laptop, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import type { ConversationEnvironmentDTO } from "@shared/sandbox";
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

export function EnvironmentButton({ spaceId, conversationId, active, side = "top", disabled, className }: EnvironmentButtonProps) {
	const { env, unavailable, error, prepare, busy, retryError } = useEnvironment(spaceId, conversationId, active);
	const [open, setOpen] = useState(false);
	// Opening focuses the popover itself, not its first control (that is 本地环境, whose tooltip would pop up over the card).
	const bodyRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	if (!spaceId || unavailable || (error && !env)) return null;

	const remote = env?.kind === "remote";
	const failed = env?.state === "failed";
	const preparing = env?.state === "preparing";
	const name = env ? backendName(env) : "";


	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tip label="云端沙箱">
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
			<PopoverContent side={side} align="start" data-testid="env-popover" className="w-[min(15rem,calc(100vw-1.5rem))] p-2" onOpenAutoFocus={(e) => { e.preventDefault(); bodyRef.current?.focus({ preventScroll: true }); }} onCloseAutoFocus={(e) => { e.preventDefault(); triggerRef.current?.focus(); }}>
				<div ref={bodyRef} tabIndex={-1} className="outline-none">
				{!env ? (
					<p className="flex items-center gap-2 text-sm text-fg-muted"><Loader2 aria-hidden className="size-4 wr-spin" />读取中…</p>
				) : (
					<div className="space-y-1.5 text-sm">
						{/* 极简：two options, no explanations. Only a failure adds one short line (reason on hover) with 重试. */}
						<div data-testid="env-cloud" aria-current="true" className="rounded-xl border border-accent bg-surface px-3 py-2.5">
							<div className="flex items-center gap-2">
								<Cloud aria-hidden className="size-4 shrink-0 text-fg-muted" />
								<span className="flex-1 font-medium">云端沙箱</span>
								{preparing ? <Loader2 aria-label="准备中" className="size-4 text-info wr-spin" /> : failed ? <TriangleAlert aria-label="准备失败" className="size-4 text-danger" /> : <Check aria-hidden className="size-4 text-success" />}
								<span className="sr-only">（当前：{name}）</span>
							</div>
							{failed ? (
								<div data-testid="env-state" data-state={env.state} role="status" className="mt-1.5 flex items-center gap-2 text-xs text-danger">
									<span className="min-w-0 flex-1 truncate" title={env.error ?? undefined}>准备失败</span>
									{remote && env.canPrepare ? (
										<button type="button" data-testid="env-prepare" disabled={busy} onClick={() => void prepare()} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
											{busy ? <Loader2 aria-hidden className="size-3.5 wr-spin" /> : <RotateCcw aria-hidden className="size-3.5" />}
											重试
										</button>
									) : null}
								</div>
							) : null}
							{retryError ? <p role="alert" className="mt-1.5 text-xs text-danger">{retryError}</p> : null}
						</div>
						<button type="button" data-testid="env-local" aria-disabled="true" onClick={(e) => e.preventDefault()} className="flex w-full cursor-not-allowed items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2.5 text-left text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
							<Laptop aria-hidden className="size-4 shrink-0" />
							<span className="flex-1">本地环境</span>
						</button>
					</div>
				)}
				</div>
			</PopoverContent>
		</Popover>
	);
}
