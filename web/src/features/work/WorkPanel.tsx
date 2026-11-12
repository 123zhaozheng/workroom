// The right panel: exactly three blocks in one white rounded card — 输出 | 子任务 | 浏览器. Low density, thin dividers, every block
// header is "title · count ›" (the chevron is the only expand / collapse affordance).
//  - 输出: delivered outputs only (state.work.outputs with status active). Uploads, intermediate files and screenshots never appear.
//  - 子任务: subagents and background jobs with their running state.
//  - 浏览器: the agent's browser sessions as preview entries.
// Everything comes from the same server ACL as the conversation itself; the outputs / jobs / browser snapshot is the conversation's
// SSE state (published by the chat page), subagents come from the conversation's tasks endpoint.
import { Bot, ChevronRight, Download, ExternalLink, Globe, Loader2, Plug, Users, X, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { MemberType, SubagentDTO, TasksResponse } from "@shared/chat";
import type { ConversationWorkDTO, JobDTO, LibItemDTO } from "@shared/files";
import { BrowserSessionView, JOB_STATUS } from "./live";
import { useApi } from "@/lib/useApi";
import { errorText, post } from "@/lib/api";
import { useSession } from "@/lib/session";
import { cn, durationText, formatBytes, isSimulatedUsage, relTime, SIMULATED_USAGE } from "@/lib/utils";
import { Badge } from "@/components/ui/misc";
import { usePanel, type PanelState } from "@/components/shell/panel";
import { fileKind, KIND_META } from "@/components/file/kinds";

const MEMBER: Record<MemberType, { label: string; icon: LucideIcon }> = {
	builtin_subagent: { label: "内置子 Agent", icon: Bot },
	external_tool: { label: "外部工具服务", icon: Plug },
	third_party_agent: { label: "第三方 Agent", icon: Users },
};
const SUB_STATUS: Record<SubagentDTO["status"], { label: string; tone: "info" | "success" | "danger" | "neutral" | "warning" }> = {
	running: { label: "运行中", tone: "info" },
	done: { label: "已完成", tone: "success" },
	failed: { label: "失败", tone: "danger" },
	aborted: { label: "已取消", tone: "neutral" },
	unanswered: { label: "未完成", tone: "warning" },
};

export default function WorkPanel({ state, onClose }: { state: Extract<PanelState, { kind: "work" }>; onClose: () => void }) {
	const { work: published } = usePanel();
	// The chat page publishes its SSE snapshot; without it (a deep link opened the panel first) poll the work endpoint.
	const polled = useApi<{ work: ConversationWorkDTO }>(published ? null : `/work/${state.spaceId}/${state.conversationId}`, { pollMs: 2000 });
	const work = published ?? polled.data?.work;
	const outputs = (work?.outputs ?? []).filter((o) => o.status === "active");
	const jobs = work?.jobs ?? [];
	const sessions = work?.browserSessions ?? [];
	const tasks = useApi<TasksResponse>(`/conversations/${state.spaceId}/${state.conversationId}/tasks`, { pollMs: 2500 });
	const subs = tasks.data?.subagents ?? [];
	return (
		<div
			data-testid="work-panel"
			role="region"
			aria-label="工作面板"
			className="wr-scroll flex h-full min-h-0 flex-col overflow-y-auto bg-surface-2/60 p-3"
			onKeyDown={(e) => {
				if (e.key === "Escape" && !e.defaultPrevented && e.currentTarget.contains(e.target as Node)) onClose();
			}}
		>
			<div className="mb-1 flex justify-end">
				<button data-testid="close-panel" onClick={onClose} className="inline-flex size-9 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="关闭工作面板">
					<X className="size-[18px]" />
				</button>
			</div>
			<div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
				<Block id="outputs" title="输出" count={outputs.length} empty="创建输出内容">
					{outputs.length ? (
						<ul className="space-y-0.5">
							{outputs.map((o) => (
								<OutputRow key={o.fileId} item={o} />
							))}
						</ul>
					) : null}
				</Block>
				<Block id="tasks" title="子任务" count={subs.length + jobs.length} empty="暂无子任务">
					{subs.length + jobs.length ? (
						<ul className="space-y-0.5">
							{jobs.map((j) => (
								<JobRow key={j.id} job={j} />
							))}
							{subs.map((s) => (
								<SubagentRow key={s.delegationId} s={s} spaceId={state.spaceId} />
							))}
						</ul>
					) : null}
				</Block>
				<Block id="browser" title="浏览器" count={sessions.length} empty="暂无网页">
					{sessions.length ? (
						<ul className="space-y-0.5">
							{sessions.map((s) => (
								<BrowserRow key={s.id} s={s} />
							))}
						</ul>
					) : null}
				</Block>
			</div>
		</div>
	);
}

/** One block: "title · count ›". Collapsible; the placeholder shows while there is nothing in it. */
function Block({ id, title, count, empty, children }: { id: string; title: string; count: number; empty: string; children: ReactNode }) {
	const [open, setOpen] = useState(true);
	return (
		<section data-testid={`block-${id}`} data-count={count} className="px-4 py-3.5">
			<button type="button" data-testid={`block-${id}-toggle`} aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex h-7 w-full items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
				<span className="text-[14px] font-medium">{title}</span>
				<span data-testid={`block-${id}-count`} className="text-[13px] tabular-nums text-fg-subtle">
					· {count}
				</span>
				<span className="flex-1" />
				<ChevronRight aria-hidden className={cn("size-4 text-fg-subtle transition-transform duration-150", open && "rotate-90")} />
			</button>
			{open ? (
				<div className="mt-1.5">
					{count === 0 ? (
						<p data-testid={`${id === "outputs" ? "outputs" : id}-empty`} className="py-2 text-[13px] text-fg-subtle">
							{empty}
						</p>
					) : (
						children
					)}
				</div>
			) : null}
		</section>
	);
}

function OutputRow({ item }: { item: LibItemDTO }) {
	const { openPreview, panel } = usePanel();
	const kind = fileKind(item.name, item.mime);
	const Icon = KIND_META[kind].icon;
	const active = panel?.kind === "preview" && panel.target.fileId === item.fileId;
	return (
		<li data-testid="output-item" data-file-id={item.fileId} className={cn("group flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-surface-2", active && "bg-surface-2")}>
			<button type="button" onClick={() => openPreview({ fileId: item.fileId, name: item.name, mime: item.mime, size: item.size, etag: item.etag })} aria-label={`预览 ${item.name}`} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
				<Icon aria-hidden className="size-[18px] shrink-0 text-fg-muted" strokeWidth={1.5} />
				<span className="min-w-0 flex-1 truncate text-[13.5px]">{item.name}</span>
				<span className="shrink-0 text-xs tabular-nums text-fg-subtle">{formatBytes(item.size)}</span>
			</button>
			<a data-testid="output-download" href={`/api/files/${item.fileId}/download?v=${encodeURIComponent(item.etag.slice(0, 16))}`} aria-label={`下载 ${item.name}`} title="下载" className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-3 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
				<Download className="size-4" strokeWidth={1.5} />
			</a>
		</li>
	);
}

/** A collapsible row: icon · title · status, the details behind its chevron. */
function Row({ icon, title, status, children, testId, data }: { icon: ReactNode; title: string; status?: ReactNode; children?: ReactNode; testId: string; data?: Record<string, string | undefined> }) {
	const [open, setOpen] = useState(false);
	return (
		<li data-testid={testId} {...data} className="rounded-lg">
			<button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-h-8 w-full items-center gap-2.5 rounded-lg px-1.5 py-1 text-left hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
				<span aria-hidden className="flex size-[18px] shrink-0 items-center justify-center text-fg-muted [&_svg]:size-[18px]">
					{icon}
				</span>
				<span className="min-w-0 flex-1 truncate text-[13.5px]">{title}</span>
				{status}
				<ChevronRight aria-hidden className={cn("size-4 shrink-0 text-fg-subtle transition-transform duration-150", open && "rotate-90")} />
			</button>
			{open ? <div className="wr-fade-in mb-1.5 ml-[30px] mr-1 mt-0.5">{children}</div> : null}
		</li>
	);
}

const ENDED = (s: JobDTO["status"]) => s !== "queued" && s !== "running";

function JobRow({ job }: { job: JobDTO }) {
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	const st = JOB_STATUS[job.status];
	const took = job.startedAt ? (job.finishedAt ? Date.parse(job.finishedAt) : Date.now()) - Date.parse(job.startedAt) : undefined;
	return (
		<Row
			testId="job"
			data={{ "data-status": job.status }}
			icon={!ENDED(job.status) ? <Loader2 className="wr-spin text-info" strokeWidth={1.5} /> : <Bot strokeWidth={1.5} />}
			title={`后台任务：${job.title}`}
			status={<Badge tone={st.tone}>{st.label}</Badge>}
		>
			<div className="space-y-1 text-[12.5px] text-fg-muted">
				{job.progress ? <p>{job.progress}</p> : null}
				{job.summary ? <p className="whitespace-pre-wrap">{job.summary}</p> : null}
				{job.error ? <p className="text-danger">{job.error}</p> : null}
				{took !== undefined ? <p className="text-fg-subtle">已用 {durationText(took)}</p> : null}
				{err ? <p className="text-danger">{err}</p> : null}
				{job.canCancel && !ENDED(job.status) ? (
					<button
						type="button"
						data-testid="job-cancel"
						disabled={busy || !!job.cancelRequestedBy}
						className="text-info hover:underline disabled:opacity-60"
						onClick={async () => {
							setBusy(true);
							setErr(undefined);
							try {
								await post(`/jobs/${job.id}/cancel`);
							} catch (e) {
								setErr(errorText(e));
							} finally {
								setBusy(false);
							}
						}}
					>
						{job.cancelRequestedBy ? "正在取消…" : "取消"}
					</button>
				) : null}
			</div>
		</Row>
	);
}

function SubagentRow({ s, spaceId }: { s: SubagentDTO; spaceId: string }) {
	const { me } = useSession();
	const M = MEMBER[s.memberType] ?? MEMBER.builtin_subagent;
	// A turn-limit stop is the timeout class (M02-C): its own label, never shown as success or a plain failure.
	const turnLimit = /turn_limit|轮数上限|max ?turns/i.test(s.failure ?? "");
	const st = turnLimit ? { label: "达到轮数上限（超时）", tone: "warning" as const } : SUB_STATUS[s.status];
	return (
		<Row testId="subagent" data={{ "data-status": s.status }} icon={s.status === "running" ? <Loader2 className="wr-spin text-info" strokeWidth={1.5} /> : <M.icon strokeWidth={1.5} />} title={s.memberName} status={<Badge tone={st.tone}>{st.label}</Badge>}>
			<div className="space-y-1 text-[12.5px] text-fg-muted">
				<p className="text-fg">{s.task}</p>
				{s.resultSummary ? <p className="whitespace-pre-wrap">结果：{s.resultSummary}</p> : null}
				{s.failure ? <p className="text-danger">{turnLimit ? `未完成：在允许的轮数内没有完成，已停止（${s.failure}）` : `失败原因：${s.failure}`}</p> : null}
				<p className="text-fg-subtle">
					来源：对话 {s.source.conversationId} · {M.label}
					{s.mode === "background" ? " · 后台" : ""}
					{s.ownerUserId ? ` · 负责人：${s.ownerUserId === me?.userId ? `你（${me.name}）` : "其他成员"}` : ""} · {relTime(s.startedAt)}开始
					{s.endedAt ? ` · 用时 ${durationText(Date.parse(s.endedAt) - Date.parse(s.startedAt))}` : ""}
					{s.usage ? ` · ${isSimulatedUsage(s.usage) ? SIMULATED_USAGE : `${s.usage.totalTokens.toLocaleString()} tokens`}` : ""}
				</p>
				{s.childConversationId ? (
					<Link to={`/c/${spaceId}/${s.childConversationId}`} className="inline-flex items-center gap-1 text-info hover:underline">
						<ExternalLink className="size-3.5" />
						查看子任务对话
					</Link>
				) : null}
			</div>
		</Row>
	);
}

function BrowserRow({ s }: { s: ConversationWorkDTO["browserSessions"][number] }) {
	const host = (() => {
		try {
			return new URL(s.url).host || s.url;
		} catch {
			return s.url;
		}
	})();
	return (
		<Row testId="browser-entry" icon={<Globe strokeWidth={1.5} />} title={s.title || host} status={<span className="max-w-[40%] truncate text-xs text-fg-subtle">{host}</span>}>
			<BrowserSessionView s={s} onChanged={() => {}} />
		</Row>
	);
}
