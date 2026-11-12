// The small cloud button next to the composer's "+": where this conversation's code runs, and its state. Two options only:
//   本地环境  greyed out (round 12): reserved for the coming desktop app, whose commands will reach the person's own computer. Kept in
//             place so the entry does not move when it ships; hovering says when it becomes available.
//   云端沙箱  everything runs in the organisation's sandbox channel. Choosing it explicitly also starts (or resumes) the sandbox now
//             (round 11, R2a) — the only place in the UI that does; a failure adds one short line with 重试 (reason on hover).
// Round 10/11 user feedback: minimal — no headings, backend names, working directory or explanations; the sandbox lifecycle (preparing / ready /
// paused / failed) is ONE small dot on the button, never a banner.
// Opening the popover only READS (GET .../environment); it never creates or connects a sandbox.
// On the home page there is no conversation yet: choosing 云端沙箱 is kept for this tab and applied when the conversation's button first mounts.
import { Check, Cloud, Laptop, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ConversationEnvironmentDTO } from "@shared/sandbox";
import type { LocalExecPreference } from "@shared/localexec";
import { Popover, PopoverContent, PopoverTrigger, Tip } from "@/components/ui/overlay";
import { errorText } from "@/lib/api";
import { cn } from "@/lib/utils";
import { setLocalExecPreference } from "@/features/localexec/api";
import { useEnvironment } from "./useEnvironment";

export interface EnvironmentButtonProps {
	/** Space the conversation (or the home composer's target) belongs to. Nothing is rendered until it is known. */
	spaceId: string | undefined;
	/** Omit on the home page (no conversation yet): the same environment, state "none". */
	conversationId?: number;
	/** True while a turn is running: the button then follows preparing / resuming with light polling. */
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

/** The one status dot of the button (remote channels only; the server's own driver has no lifecycle). */
const DOT: Partial<Record<ConversationEnvironmentDTO["state"], { cls: string; label: string }>> = {
	preparing: { cls: "bg-info wr-pulse", label: "准备中" },
	resuming: { cls: "bg-info wr-pulse", label: "恢复中" },
	ready: { cls: "bg-success", label: "就绪" },
	paused: { cls: "bg-fg-subtle", label: "已暂停" },
	failed: { cls: "bg-danger", label: "准备失败" },
};

const pendingKey = (spaceId: string) => `wr-env-pref:${spaceId}`;
function readPending(spaceId: string): LocalExecPreference | undefined {
	try {
		const v = sessionStorage.getItem(pendingKey(spaceId));
		return v === "local" || v === "cloud" ? v : undefined;
	} catch {
		return undefined;
	}
}
function writePending(spaceId: string, v: LocalExecPreference | null): void {
	try {
		if (v) sessionStorage.setItem(pendingKey(spaceId), v);
		else sessionStorage.removeItem(pendingKey(spaceId));
	} catch {
		/* storage unavailable: the choice simply is not carried over */
	}
}

export function EnvironmentButton({ spaceId, conversationId, active, side = "top", disabled, className }: EnvironmentButtonProps) {
	const { env, unavailable, error, prepare, busy, retryError, reload } = useEnvironment(spaceId, conversationId, active);
	const [open, setOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	const [choiceError, setChoiceError] = useState<string>();
	const bodyRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);

	const localOn = env?.local?.enabled === true;
	const remote = env?.kind === "remote";
	const canStart = remote && !!env?.canPrepare && (env.state === "none" || env.state === "lost" || env.state === "paused");
	// Only a conversation that explicitly chose local in round 11 still reports "local"; everything else runs in the cloud.
	const pref: LocalExecPreference = localOn && conversationId !== undefined && env?.local?.preference === "local" ? "local" : "cloud";

	const choose = async (next: LocalExecPreference) => {
		if (!spaceId || !env) return;
		if (next === "local") return; // greyed out until the desktop app ships
		setChoiceError(undefined);
		if (conversationId === undefined) {
			writePending(spaceId, next);
			return;
		}
		try {
			setSaving(true);
			if (localOn && env.local?.preference !== next) await setLocalExecPreference(spaceId, conversationId, next);
		} catch (e) {
			setChoiceError(errorText(e));
			return;
		} finally {
			setSaving(false);
		}
		if (next === "cloud" && canStart) await prepare();
		else reload();
	};

	// a choice made on the home page is applied once the conversation exists (its button mounts with a conversationId)
	const applied = useRef(false);
	useEffect(() => {
		if (applied.current || !spaceId || conversationId === undefined || !env) return;
		applied.current = true;
		const p = readPending(spaceId);
		if (!p) return;
		writePending(spaceId, null);
		void choose(p);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [spaceId, conversationId, env]);

	if (!spaceId || unavailable || (error && !env)) return null;

	const failed = env?.state === "failed";
	const working = env?.state === "preparing" || env?.state === "resuming";
	const name = env ? backendName(env) : "";
	// An explicit start / retry blocks until the sandbox is up and the server's state only turns "preparing" in between: while the request is in flight the dot says so.
	const dotState = remote && busy ? "preparing" : env?.state;
	const dot = remote && env ? DOT[dotState ?? "none"] : failed ? DOT.failed : undefined;
	const row = (on: boolean) => cn("flex w-full items-center gap-2 rounded-xl border px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60", on ? "border-accent bg-surface" : "border-border hover:bg-surface-2");

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tip label={pref === "local" ? "本地环境" : "云端沙箱"}>
				<PopoverTrigger asChild>
					<button
						type="button"
						ref={triggerRef}
						aria-label={env ? `执行环境：${pref === "local" ? "本地环境" : "云端沙箱"}（${name}${dot ? `，${dot.label}` : ""}）` : "执行环境"}
						data-testid="env-button"
						data-env-kind={env?.kind ?? "loading"}
						data-env-state={env?.state ?? "loading"}
						data-env-pref={env ? pref : undefined}
						disabled={disabled}
						className={cn("relative flex size-10 shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:size-9", className)}
					>
						{pref === "local" ? <Laptop aria-hidden className="size-5" /> : <Cloud aria-hidden className="size-5" />}
						{dot ? <span aria-hidden data-testid="env-dot" data-dot={dotState} className={cn("absolute right-1.5 top-1.5 size-2 rounded-full ring-2 ring-bg", dot.cls)} /> : null}
					</button>
				</PopoverTrigger>
			</Tip>
			<PopoverContent side={side} align="start" data-testid="env-popover" className="w-[min(15rem,calc(100vw-1.5rem))] p-2" onOpenAutoFocus={(e) => { e.preventDefault(); bodyRef.current?.focus({ preventScroll: true }); }} onCloseAutoFocus={(e) => { e.preventDefault(); triggerRef.current?.focus(); }}>
				<div ref={bodyRef} tabIndex={-1} className="outline-none">
					{!env ? (
						<p className="flex items-center gap-2 text-sm text-fg-muted"><Loader2 aria-hidden className="size-4 wr-spin" />读取中…</p>
					) : (
						<div role="radiogroup" aria-label="执行环境" className="space-y-1.5 text-sm">
							<Tip label="本地应用上线后可用">
								<button type="button" role="radio" aria-checked="false" aria-disabled="true" data-testid="env-local" onClick={(e) => e.preventDefault()} className="flex w-full cursor-not-allowed items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2.5 text-left text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
									<Laptop aria-hidden className="size-4 shrink-0" />
									<span className="flex-1">本地环境</span>
								</button>
							</Tip>
							<div>
								<button type="button" role="radio" aria-checked={pref === "cloud"} data-testid="env-cloud" disabled={saving || busy} onClick={() => void choose("cloud")} className={row(pref === "cloud")}>
									<Cloud aria-hidden className="size-4 shrink-0 text-fg-muted" />
									<span className="flex-1 font-medium">云端沙箱</span>
									<span className="sr-only">（{name}{dot ? `，${dot.label}` : ""}）</span>
									{working || busy ? <Loader2 aria-label="准备中" className="size-4 text-info wr-spin" /> : failed ? <TriangleAlert aria-label="准备失败" className="size-4 text-danger" /> : pref === "cloud" ? <Check aria-hidden className="size-4 text-success" /> : null}
								</button>
								{failed ? (
									<div data-testid="env-state" data-state={env.state} role="status" className="flex items-center gap-2 px-3 pt-1 text-xs text-danger">
										<span className="min-w-0 flex-1 truncate" title={env.error ?? undefined}>准备失败</span>
										{remote && env.canPrepare ? (
											<button type="button" data-testid="env-prepare" disabled={busy} onClick={() => void prepare()} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
												{busy ? <Loader2 aria-hidden className="size-3.5 wr-spin" /> : <RotateCcw aria-hidden className="size-3.5" />}
												重试
											</button>
										) : null}
									</div>
								) : null}
							</div>
							{retryError || choiceError ? <p role="alert" className="text-xs text-danger">{retryError || choiceError}</p> : null}
						</div>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}
