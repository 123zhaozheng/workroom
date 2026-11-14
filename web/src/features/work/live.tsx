// Long-running jobs (M14-C) and live browser sessions with take-over (M11-B). Take-over follows the same
// permission as the preview: the server reports `canControl` (space write); viewers can only watch.
import { ArrowLeft, ArrowRight, Hand, Loader2, RotateCw, Send, Undo2 } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { BrowserSessionDTO, JobDTO, JobStatus } from "@shared/files";
import { errorText, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import { scrollDelta, viewportPoint } from "./browser-geometry";

export const JOB_STATUS: Record<JobStatus, { label: string; tone: "info" | "success" | "danger" | "neutral" | "warning" }> = {
	queued: { label: "排队中", tone: "info" },
	running: { label: "进行中", tone: "info" },
	done: { label: "已完成", tone: "success" },
	failed: { label: "失败", tone: "danger" },
	cancelled: { label: "已取消", tone: "neutral" },
	timeout: { label: "超出预算已停止", tone: "warning" },
};
const ended = (s: JobStatus) => s !== "queued" && s !== "running";

/** Compact job status inside the assistant message: live status + cancel, without opening the panel. */
export function JobChip({ jobId, initial }: { jobId: string; initial: JobDTO }) {
	const res = useApi<{ job: JobDTO }>(`/jobs/${jobId}`, { pollMs: ended(initial.status) ? undefined : 2000 });
	const job = res.data?.job ?? initial;
	const st = JOB_STATUS[job.status];
	const [busy, setBusy] = useState(false);
	return (
		<div data-testid="job-chip" data-status={job.status} className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[12.5px]">
			{!ended(job.status) ? <Loader2 className="size-3.5 shrink-0 wr-spin text-info" /> : null}
			<span className="truncate">后台任务：{job.title}</span>
			<Badge tone={st.tone}>{st.label}</Badge>
			{job.canCancel && !ended(job.status) ? (
				<button
					className="text-fg-muted hover:text-danger"
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						await post(`/jobs/${job.id}/cancel`).catch(() => {});
						res.reload();
						setBusy(false);
					}}
				>
					取消
				</button>
			) : null}
		</div>
	);
}

/**
 * The take-over logic shared by the small preview in the work panel and the enlarged dialog: who controls the page, the API calls
 * (actions / takeover / release) and a fresher DTO from the last action's response, so the screenshot refreshes immediately instead
 * of waiting for the next poll. `fresh` wins only while it is not older than what the poll delivered.
 */
export function useBrowserControl(polled: BrowserSessionDTO, onChanged: () => void) {
	const { me } = useSession();
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	const [fresh, setFresh] = useState<BrowserSessionDTO>();
	const s: BrowserSessionDTO = fresh && Date.parse(fresh.updatedAt) >= Date.parse(polled.updatedAt) ? { ...fresh, canControl: polled.canControl ?? fresh.canControl } : polled;
	const mine = s.controller.kind === "user" && s.controller.userId === me?.userId;
	const act = async (path: string, body?: Record<string, unknown>) => {
		setBusy(true);
		setErr(undefined);
		try {
			const r = await post<{ session?: BrowserSessionDTO }>(`/browser-sessions/${polled.id}/${path}`, body);
			if (r?.session) setFresh(r.session);
			onChanged();
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	return { s, mine, busy, err, act };
}

/**
 * Live browser session: watch, or take over and act (click / type / navigate; scroll in the enlarged dialog) when allowed.
 * `variant="modal"` fills its parent (the screenshot is fitted into the free space, the title lives in the dialog header).
 */
export function BrowserSessionView({ s: polled, onChanged, variant = "inline" }: { s: BrowserSessionDTO; onChanged: () => void; variant?: "inline" | "modal" }) {
	const modal = variant === "modal";
	const { s, mine, busy, err, act } = useBrowserControl(polled, onChanged);
	const [text, setText] = useState("");
	const [url, setUrl] = useState(s.url);
	const img = useRef<HTMLImageElement>(null);
	// The address field follows the page unless the user is typing in it.
	const urlFocused = useRef(false);
	useEffect(() => {
		if (!urlFocused.current) setUrl(s.url);
	}, [s.url]);
	const click = (e: MouseEvent<HTMLImageElement>) => {
		if (!mine || !img.current) return;
		const pt = viewportPoint(img.current.getBoundingClientRect(), s.viewport, e.clientX, e.clientY);
		if (pt) void act("actions", { type: "click", ...pt });
	};
	// Scroll (enlarged dialog only; the small preview must keep scrolling the panel): wheel deltas are batched into one action.
	const wheel = useRef({ dy: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined });
	const actRef = useRef(act);
	actRef.current = act;
	useEffect(() => {
		const el = img.current;
		if (!modal || !mine || !el) return;
		const w = wheel.current;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			w.dy += scrollDelta(e, el.getBoundingClientRect().width, s.viewport.width);
			clearTimeout(w.timer);
			w.timer = setTimeout(() => {
				const dy = Math.round(w.dy);
				w.dy = 0;
				if (dy) void actRef.current("actions", { type: "scroll", deltaY: dy });
			}, 120);
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => {
			el.removeEventListener("wheel", onWheel);
			clearTimeout(w.timer);
		};
	}, [modal, mine, s.viewport.width]);
	const typeForm = mine ? (
		<form
			data-testid="browser-type-form"
			className="flex min-w-0 flex-1 gap-2"
			onSubmit={(e) => {
				e.preventDefault();
				void (async () => {
					await act("actions", { type: "type", text });
					await act("actions", { type: "press", key: "Enter" });
					setText("");
				})();
			}}
		>
			<Input value={text} onChange={(e) => setText(e.target.value)} placeholder="在页面焦点处输入，回车提交" aria-label="在页面中输入" className="h-8 text-[12.5px]" />
			<Button size="sm" type="submit" disabled={busy || !text} aria-label="发送输入">
				<Send />
			</Button>
		</form>
	) : null;
	const control = s.canControl ? (
		mine ? (
			<Button size="sm" onClick={() => act("release")} disabled={busy} data-testid="browser-release">
				<Undo2 />
				交还给助手
			</Button>
		) : s.controller.kind === "agent" ? (
			<Button size="sm" variant="primary" onClick={() => act("takeover")} disabled={busy} data-testid="browser-takeover">
				<Hand />
				接管
			</Button>
		) : null
	) : (
		<span className="text-xs text-fg-subtle">只能观看</span>
	);
	return (
		<div data-testid="browser-session" data-controller={s.controller.kind} data-variant={variant} className={cn("overflow-hidden", modal ? "flex h-full min-h-0 flex-col" : "rounded-xl border border-border")}>
			<div className="flex shrink-0 items-center gap-2 bg-surface-2 px-2.5 py-1.5 text-[12px]">
				{mine ? (
					<>
						<button aria-label="后退" disabled={busy} onClick={() => act("actions", { type: "back" })} className="text-fg-muted hover:text-fg">
							<ArrowLeft className="size-3.5" />
						</button>
						<button aria-label="前进" disabled={busy} onClick={() => act("actions", { type: "forward" })} className="text-fg-muted hover:text-fg">
							<ArrowRight className="size-3.5" />
						</button>
						<button aria-label="刷新" disabled={busy} onClick={() => act("actions", { type: "reload" })} className="text-fg-muted hover:text-fg">
							<RotateCw className="size-3.5" />
						</button>
						<form
							className="min-w-0 flex-1"
							onSubmit={(e) => {
								e.preventDefault();
								void act("actions", { type: "navigate", url });
							}}
						>
							<input
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								onFocus={() => (urlFocused.current = true)}
								onBlur={() => (urlFocused.current = false)}
								className="w-full rounded bg-surface px-1.5 py-0.5 font-mono text-[11.5px] outline-none"
								aria-label="地址"
							/>
						</form>
					</>
				) : (
					<span data-testid="browser-url" className="min-w-0 flex-1 truncate font-mono text-fg-muted" title={s.url}>
						{s.url}
					</span>
				)}
				<Badge tone={s.controller.kind === "user" ? "warning" : "info"} data-testid="browser-controller">
					{s.controller.kind === "agent" ? "助手操作中" : mine ? "你在操作" : `${s.controller.name ?? "成员"} 在操作`}
				</Badge>
			</div>
			<div className={cn("relative bg-white", modal && "min-h-0 flex-1")}>
				<img
					ref={img}
					data-testid="browser-screenshot"
					alt={`实时截图：${s.title}`}
					src={`${s.screenshotUrl.startsWith("/api") ? "" : "/api"}${s.screenshotUrl}?v=${s.version}`}
					onClick={click}
					className={cn("block", modal ? "size-full object-contain" : "w-full", mine && "cursor-crosshair")}
				/>
				{busy ? <Loader2 className="absolute right-2 top-2 size-4 wr-spin text-info" /> : null}
			</div>
			{modal ? (
				<div className="shrink-0 space-y-1.5 border-t border-border px-4 py-2.5 text-[12.5px]">
					<div className="flex flex-wrap items-center gap-2">
						{control}
						{typeForm}
						{!typeForm ? <span className="min-w-0 flex-1 truncate text-xs text-fg-subtle">{s.lastAction ? `上一步：${s.lastAction}` : ""}</span> : null}
					</div>
					{typeForm && s.lastAction ? <div className="truncate text-xs text-fg-subtle">上一步：{s.lastAction}</div> : null}
					{mine ? <div className="text-xs text-fg-subtle">在截图上点击、滚动滚轮即可操作页面</div> : null}
					{s.blockedRequests ? <div className="text-xs text-warning">已按安全策略拦截 {s.blockedRequests} 个请求</div> : null}
					{err ? <p className="text-xs text-danger">{err}</p> : null}
				</div>
			) : (
				<div className="space-y-2 px-3 py-2 text-[12.5px]">
					<div className="font-medium">{s.title || "（无标题）"}</div>
					{s.lastAction ? <div className="text-xs text-fg-subtle">上一步：{s.lastAction}</div> : null}
					{s.blockedRequests ? <div className="text-xs text-warning">已按安全策略拦截 {s.blockedRequests} 个请求</div> : null}
					{typeForm}
					<div className="flex flex-wrap items-center gap-2">{control}</div>
					{err ? <p className="text-xs text-danger">{err}</p> : null}
				</div>
			)}
		</div>
	);
}
