// Long-running jobs (M14-C) and live browser sessions with take-over (M11-B). Take-over follows the same
// permission as the preview: the server reports `canControl` (space write); viewers can only watch.
import { ArrowLeft, ArrowRight, Ban, Hand, Loader2, MousePointerClick, RotateCw, Send, Undo2 } from "lucide-react";
import { useRef, useState, type MouseEvent } from "react";
import type { BrowserSessionDTO, JobDTO, JobStatus } from "@shared/files";
import { errorText, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { cn, durationText, formatBytes } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import { FileCard } from "@/features/chat/Cards";

export const JOB_STATUS: Record<JobStatus, { label: string; tone: "info" | "success" | "danger" | "neutral" | "warning" }> = {
	queued: { label: "排队中", tone: "info" },
	running: { label: "进行中", tone: "info" },
	done: { label: "已完成", tone: "success" },
	failed: { label: "失败", tone: "danger" },
	cancelled: { label: "已取消", tone: "neutral" },
	timeout: { label: "超出预算已停止", tone: "warning" },
};
const KIND = { sandbox: "代码执行", browse: "网页采集", generate: "文档生成" } as const;
const ended = (s: JobStatus) => s !== "queued" && s !== "running";

/** Full job card (work panel). */
export function JobCard({ job, onChanged }: { job: JobDTO; onChanged?: () => void }) {
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	const st = JOB_STATUS[job.status];
	const took = job.startedAt ? (job.finishedAt ? Date.parse(job.finishedAt) : Date.now()) - Date.parse(job.startedAt) : undefined;
	return (
		<div data-testid="job" data-status={job.status} className="rounded-xl border border-border p-3 text-[13px]">
			<div className="flex flex-wrap items-center gap-2">
				{!ended(job.status) ? <Loader2 className="size-3.5 wr-spin text-info" /> : null}
				<span className="font-medium">{job.title}</span>
				<Badge>{KIND[job.kind]}</Badge>
				<span className="flex-1" />
				<Badge tone={st.tone}>{st.label}</Badge>
				{job.canCancel && !ended(job.status) ? (
					<Button
						size="sm"
						disabled={busy || !!job.cancelRequestedBy}
						data-testid="job-cancel"
						onClick={async () => {
							setBusy(true);
							setErr(undefined);
							try {
								await post(`/jobs/${job.id}/cancel`);
								onChanged?.();
							} catch (e) {
								setErr(errorText(e));
							} finally {
								setBusy(false);
							}
						}}
					>
						<Ban />
						{job.cancelRequestedBy ? "正在取消…" : "取消"}
					</Button>
				) : null}
			</div>
			{job.progress ? <p className="mt-1 text-fg-muted">{job.progress}</p> : null}
			{job.summary ? <p className="mt-1 whitespace-pre-wrap text-fg-muted">{job.summary}</p> : null}
			{job.error ? <p className="mt-1 text-danger">{job.error}</p> : null}
			<p className="mt-1 text-xs text-fg-subtle">
				最长 {Math.round(job.budget.timeoutMs / 60000)} 分钟
				{job.budget.memoryBytes ? ` · 内存 ${formatBytes(job.budget.memoryBytes)}` : ""}
				{took !== undefined ? ` · 已用 ${durationText(took)}` : ""}
				{job.attempts > 1 ? ` · 第 ${job.attempts} 次尝试` : ""}
			</p>
			{err ? <p className="mt-1 text-xs text-danger">{err}</p> : null}
			{job.outputs.length ? (
				<div className="mt-2 flex flex-col gap-1.5">
					{job.outputs.map((o) => (
						<FileCard key={o.versionId} file={o} />
					))}
				</div>
			) : null}
		</div>
	);
}

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

/** Live browser session: watch, or take over and act (click / type / navigate) when allowed. */
export function BrowserSessionView({ s, onChanged }: { s: BrowserSessionDTO; onChanged: () => void }) {
	const { me } = useSession();
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	const [text, setText] = useState("");
	const [url, setUrl] = useState(s.url);
	const img = useRef<HTMLImageElement>(null);
	const mine = s.controller.kind === "user" && s.controller.userId === me?.userId;
	const act = async (path: string, body?: Record<string, unknown>) => {
		setBusy(true);
		setErr(undefined);
		try {
			await post(`/browser-sessions/${s.id}/${path}`, body);
			onChanged();
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	const click = (e: MouseEvent<HTMLImageElement>) => {
		if (!mine || !img.current) return;
		const r = img.current.getBoundingClientRect();
		const x = Math.round(((e.clientX - r.left) / r.width) * s.viewport.width);
		const y = Math.round(((e.clientY - r.top) / r.height) * s.viewport.height);
		void act("actions", { type: "click", x, y });
	};
	return (
		<div data-testid="browser-session" data-controller={s.controller.kind} className="overflow-hidden rounded-xl border border-border">
			<div className="flex items-center gap-2 bg-surface-2 px-2.5 py-1.5 text-[12px]">
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
							<input value={url} onChange={(e) => setUrl(e.target.value)} className="w-full rounded bg-surface px-1.5 py-0.5 font-mono text-[11.5px] outline-none" aria-label="地址" />
						</form>
					</>
				) : (
					<span className="min-w-0 flex-1 truncate font-mono text-fg-muted" title={s.url}>
						{s.url}
					</span>
				)}
				<Badge tone={s.controller.kind === "user" ? "warning" : "info"} data-testid="browser-controller">
					{s.controller.kind === "agent" ? "助手操作中" : mine ? "你在操作" : `${s.controller.name ?? "成员"} 在操作`}
				</Badge>
			</div>
			<div className="relative bg-white">
				<img
					ref={img}
					data-testid="browser-screenshot"
					alt={`实时截图：${s.title}`}
					src={`${s.screenshotUrl.startsWith("/api") ? "" : "/api"}${s.screenshotUrl}?v=${s.version}`}
					onClick={click}
					className={cn("block w-full", mine && "cursor-crosshair")}
				/>
				{busy ? <Loader2 className="absolute right-2 top-2 size-4 wr-spin text-info" /> : null}
			</div>
			<div className="space-y-2 px-3 py-2 text-[12.5px]">
				<div className="font-medium">{s.title || "（无标题）"}</div>
				{s.lastAction ? <div className="text-xs text-fg-subtle">上一步：{s.lastAction}</div> : null}
				{s.blockedRequests ? <div className="text-xs text-warning">已按安全策略拦截 {s.blockedRequests} 个请求</div> : null}
				{mine ? (
					<form
						className="flex gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							void (async () => {
								await act("actions", { type: "type", text });
								await act("actions", { type: "press", key: "Enter" });
								setText("");
							})();
						}}
					>
						<Input value={text} onChange={(e) => setText(e.target.value)} placeholder="在页面焦点处输入，回车提交" className="h-8 text-[12.5px]" />
						<Button size="sm" type="submit" disabled={busy || !text}>
							<Send />
						</Button>
					</form>
				) : null}
				<div className="flex flex-wrap items-center gap-2">
					{s.canControl ? (
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
						<span className="text-xs text-fg-subtle">你只能观看（需要该空间的编辑权限才能接管，与预览权限一致）</span>
					)}
					{mine ? (
						<span className="inline-flex items-center gap-1 text-xs text-fg-subtle">
							<MousePointerClick className="size-3.5" />
							点击截图即在页面对应位置点击；接管期间助手的浏览操作会被拒绝
						</span>
					) : null}
				</div>
				{err ? <p className="text-xs text-danger">{err}</p> : null}
			</div>
		</div>
	);
}
