// The small cloud button next to the composer's "+": which execution environment runs this conversation's code, and its state.
// Opening it only READS (GET .../environment); it never creates or connects a sandbox. The only action that does is the explicit
// 重试 / 现在准备 button. Switching goes through the project override API (the server enforces policy); without that right the reason is shown.
import { Check, Cloud, HardDrive, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { ConversationEnvironmentDTO } from "@shared/sandbox";
import { errorText, put } from "@/lib/api";
import { useApi } from "@/lib/useApi";
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

export const LOCATION_TEXT: Record<ConversationEnvironmentDTO["location"], { label: string; tone: "neutral" | "info" | "warning" }> = {
	this_server: { label: "本服务器", tone: "neutral" },
	self_hosted: { label: "自托管", tone: "info" },
	vendor_cloud: { label: "厂商云（数据会离开组织）", tone: "warning" },
};

export const STATE_TEXT: Record<ConversationEnvironmentDTO["state"], string> = {
	none: "尚未创建：第一次需要运行代码时才会创建，聊天不受影响",
	preparing: "正在准备工作环境…",
	ready: "已就绪",
	failed: "准备失败",
	lost: "已过期或被移除：下次运行时会自动重建，并恢复已保存的文件",
};

/** First sentence of the (long) isolation note: what is isolated. The full text stays one click away. */
function firstLine(text: string): string {
	const cut = text.indexOf("未隔离/限制");
	return (cut > 0 ? text.slice(0, cut) : text).replace(/[；。]\s*$/, "").slice(0, 160);
}

export function EnvironmentButton({ spaceId, conversationId, active, side = "top", disabled, className }: EnvironmentButtonProps) {
	const { env, unavailable, error, prepare, busy, retryError, reload } = useEnvironment(spaceId, conversationId, active);
	const [open, setOpen] = useState(false);
	const { me, isOrgAdmin } = useSession();
	const [switchError, setSwitchError] = useState<string>();
	const [switching, setSwitching] = useState(false);
	// project id only when it is needed (to switch): the project list maps space → project
	const projects = useApi<{ projects: { id: string; spaceId: string }[] }>(open && env?.canChoose ? "/projects" : null);
	if (!spaceId || unavailable || (error && !env)) return null;

	const remote = env?.kind === "remote";
	const Icon = remote ? Cloud : HardDrive;
	const failed = env?.state === "failed";
	const preparing = env?.state === "preparing";
	const canManage = !!me?.permissionsAnywhere?.includes("sandbox.policy.manage") || isOrgAdmin;
	const projectId = projects.data?.projects.find((p) => p.spaceId === spaceId)?.id;

	const choose = async (id: string) => {
		if (!projectId) return;
		setSwitching(true);
		setSwitchError(undefined);
		try {
			await put(`/projects/${projectId}/sandbox-provider`, { provider: id });
			reload();
		} catch (e) {
			setSwitchError(errorText(e));
		} finally {
			setSwitching(false);
		}
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tip label={env ? `执行环境：${env.label}` : "执行环境"}>
				<PopoverTrigger asChild>
					<button
						type="button"
						aria-label={env ? `执行环境：${env.label}` : "执行环境"}
						data-testid="env-button"
						data-env-kind={env?.kind ?? "loading"}
						data-env-state={env?.state ?? "loading"}
						disabled={disabled}
						className={cn("relative flex size-10 shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:size-9", className)}
					>
						<Icon aria-hidden className="size-5" />
						{failed ? <span aria-hidden data-testid="env-dot" className="absolute right-1.5 top-1.5 size-2 rounded-full bg-danger ring-2 ring-bg" /> : preparing ? <span aria-hidden data-testid="env-dot" className="absolute right-1.5 top-1.5 size-2 rounded-full bg-info ring-2 ring-bg wr-pulse" /> : null}
					</button>
				</PopoverTrigger>
			</Tip>
			<PopoverContent side={side} align="start" data-testid="env-popover" className="w-[min(23rem,calc(100vw-1.5rem))] p-3">
				{!env ? (
					<p className="flex items-center gap-2 text-sm text-fg-muted"><Loader2 aria-hidden className="size-4 wr-spin" />读取中…</p>
				) : (
					<div className="space-y-3 text-sm">
						<div>
							<p className="text-xs font-medium text-fg-subtle">当前执行环境</p>
							<p data-testid="env-label" className="mt-0.5 flex items-center gap-1.5 font-medium">
								<Icon aria-hidden className="size-4 shrink-0 text-fg-muted" />
								<span className="min-w-0 break-words">{env.label}</span>
							</p>
							<div className="mt-1.5 flex flex-wrap gap-1.5">
								<Badge data-testid="env-location" tone={LOCATION_TEXT[env.location].tone}>{LOCATION_TEXT[env.location].label}</Badge>
								<Badge data-testid="env-network">{env.network === "allowed" ? "可联网" : "不联网"}</Badge>
							</div>
							<p data-testid="env-isolation" className="mt-1.5 text-xs leading-relaxed text-fg-muted">{firstLine(env.isolation)}</p>
							{env.isolation.includes("未隔离/限制") ? (
								<details className="mt-1 text-xs text-fg-muted">
									<summary className="cursor-pointer rounded text-fg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">详细说明</summary>
									<p data-testid="env-isolation-full" className="mt-1 leading-relaxed">{env.isolation}</p>
								</details>
							) : null}
						</div>

						<div data-testid="env-state" data-state={env.state} role="status" className={cn("rounded-lg px-2.5 py-2", failed ? "bg-danger-soft text-danger" : preparing ? "bg-info-soft text-info" : "bg-surface-2 text-fg-muted")}>
							<p className="flex items-start gap-1.5">
								{failed ? <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" /> : preparing ? <Loader2 aria-hidden className="mt-0.5 size-4 shrink-0 wr-spin" /> : null}
								<span className="min-w-0 break-words">
									{env.kind === "local" && env.state === "ready" ? "已就绪：在本服务器上运行，无需准备" : failed ? `${STATE_TEXT.failed}：${env.error ?? "原因未知"}` : STATE_TEXT[env.state]}
								</span>
							</p>
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
							{retryError ? <p role="alert" className="mt-1.5 text-xs">{retryError}</p> : null}
						</div>

						<div>
							<p className="text-xs font-medium text-fg-subtle">可用的执行环境</p>
							<ul data-testid="env-options" className="mt-1 space-y-0.5">
								{env.options.map((o) => (
									<li key={o.id} data-testid={`env-option-${o.id}`} data-current={o.current ? "true" : "false"} className="flex min-h-9 items-center gap-2 rounded-lg px-1.5">
										<span aria-hidden className="flex size-4 shrink-0 items-center justify-center">{o.current ? <Check className="size-4 text-success" /> : null}</span>
										<span className="min-w-0 flex-1 break-words">{o.label}{o.current ? <span className="sr-only">（当前）</span> : null}{!o.enabled ? <span className="text-fg-subtle">（不可用）</span> : null}</span>
										{env.canChoose && !o.current && o.enabled ? (
											<button
												type="button"
												data-testid={`env-switch-${o.id}`}
												disabled={switching || !projectId}
												onClick={() => void choose(o.id)}
												className="h-8 rounded-lg px-2 text-xs font-medium text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
											>
												切换
											</button>
										) : null}
									</li>
								))}
							</ul>
							{!env.canChoose && env.chooseHint ? <p data-testid="env-choose-hint" className="mt-1 px-1.5 text-xs text-fg-muted">{env.chooseHint}</p> : null}
							{env.canChoose ? <p className="mt-1 px-1.5 text-xs text-fg-muted">切换会作用于整个项目的新运行；已有的远端沙箱不会被迁移。</p> : null}
							{switchError ? <p role="alert" className="mt-1 px-1.5 text-xs text-danger">{switchError}</p> : null}
						</div>

						{canManage ? (
							<Link to="/admin?tab=sandbox" data-testid="env-admin-link" onClick={() => setOpen(false)} className="inline-block rounded text-xs font-medium text-info underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
								管理执行环境
							</Link>
						) : null}
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}
