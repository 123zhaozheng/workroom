// 交接摘要 (M09-B): what a member taking over sees — decisions already taken, progress of each request,
// pending items (approvals, 待核对, queued input, resumable runs, running subtasks), deliverables, participants.
// Everything comes from GET …/handoff (derived from pi-durable state + files); this is a dialog, not a panel.
import { CheckCircle2, CircleAlert, FileText, Hand, ListChecks, MessageSquare, Package, Users, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { ConversationHandoff, ProjectHandoff } from "@shared/chat";
import { useApi } from "@/lib/useApi";
import { fullTime, relTime } from "@/lib/utils";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { Badge, Loadable } from "@/components/ui/misc";
import { usePanel } from "@/components/shell/panel";
import { RUN_LABEL, RunIcon, SUBMISSION_LABEL, reasonText } from "@/features/chat/status";

const ROLE = { owner: "所有者", editor: "编辑者", viewer: "查看者" } as const;

function Section({ icon, title, count, children }: { icon: ReactNode; title: string; count?: number; children: ReactNode }) {
	return (
		<section className="mb-5">
			<h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-fg-muted [&_svg]:size-4">
				{icon}
				{title}
				{count !== undefined ? <span className="text-fg-subtle">· {count}</span> : null}
			</h3>
			{children}
		</section>
	);
}
const None = ({ children = "无" }: { children?: ReactNode }) => <p className="text-[13px] text-fg-subtle">{children}</p>;

export function ConversationHandoffDialog({ spaceId, conversationId, open, onOpenChange }: { spaceId: string; conversationId: number; open: boolean; onOpenChange: (o: boolean) => void }) {
	const res = useApi<ConversationHandoff>(open ? `/conversations/${spaceId}/${conversationId}/handoff` : null);
	const { openPreview } = usePanel();
	const h = res.data;
	const pendingCount = h ? h.pending.approvals.length + h.pending.effects.length + h.pending.queued.length + h.pending.runningSubagents.length + (h.pending.continuable ? 1 : 0) : 0;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title="交接摘要" description="接手这个任务前需要知道的：已做的决定、当前进展、待处理事项和成果位置。" className="max-w-2xl">
				<div data-testid="handoff" className="wr-scroll -mx-1 max-h-[72vh] overflow-y-auto px-1 text-[13px]">
					<Loadable state={res} what="交接摘要" need="A 组：GET /conversations/:spaceId/:id/handoff">
						{h ? (
							<>
								<div className="mb-5 flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
									<RunIcon status={h.status} />
									<span className="font-medium">{RUN_LABEL[h.status]}</span>
									<span className="text-fg-muted">· {h.conversation.title}</span>
									<span className="flex-1" />
									<Badge tone={h.access.canWrite ? "success" : "neutral"} data-testid="handoff-access">
										{h.access.canWrite ? "你可以接手继续" : `只读：${h.access.reason}`}
									</Badge>
								</div>
								<Section icon={<Hand />} title="待处理" count={pendingCount}>
									{pendingCount === 0 ? (
										<None>没有待处理事项</None>
									) : (
										<ul className="space-y-1" data-testid="handoff-pending">
											{h.pending.approvals.map((a) => (
												<li key={a.approvalId}>
													<Badge tone="warning">待确认</Badge> {a.title}：{a.summary}
												</li>
											))}
											{h.pending.effects.map((e) => (
												<li key={e.effectId}>
													<Badge tone="danger">待核对</Badge> {e.summary}（{e.target}）
												</li>
											))}
											{h.pending.queued.map((q) => (
												<li key={q.submissionId}>
													<Badge tone="info">{q.mode === "steer" ? "插话" : "排队"}</Badge> {q.text}
												</li>
											))}
											{h.pending.continuable ? (
												<li>
													<Badge tone="danger">可继续</Badge> 上次运行未完成：{reasonText(h.pending.continuable.reason)}
													{h.pending.continuable.detail ? `（${h.pending.continuable.detail}）` : ""}
												</li>
											) : null}
											{h.pending.runningSubagents.map((s) => (
												<li key={s.delegationId}>
													<Badge tone="info">子任务进行中</Badge> {s.memberName}：{s.task}
												</li>
											))}
										</ul>
									)}
								</Section>
								<Section icon={<ListChecks />} title="已做的决定" count={h.decisions.length}>
									{h.decisions.length === 0 ? (
										<None />
									) : (
										<ul className="space-y-1" data-testid="handoff-decisions">
											{h.decisions.map((d) => (
												<li key={d.approvalId} className="flex items-start gap-1.5">
													{d.decision === "approved" ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" /> : <XCircle className="mt-0.5 size-3.5 shrink-0 text-danger" />}
													<span>
														{d.decision === "approved" ? "批准" : "拒绝"}「{d.title}」：{d.summary}
														<span className="text-fg-subtle">
															{" "}
															· {d.decidedByName ?? d.decidedBy} · {fullTime(d.decidedAt)}
															{d.note ? ` · ${d.note}` : ""}
														</span>
													</span>
												</li>
											))}
										</ul>
									)}
								</Section>
								<Section icon={<MessageSquare />} title="进展" count={h.runs.length}>
									{h.runs.length === 0 ? (
										<None />
									) : (
										<ol className="space-y-1.5" data-testid="handoff-runs">
											{h.runs.map((r) => (
												<li key={r.entryId}>
													<span className="text-fg-subtle">{r.requestedByName ?? r.requestedBy ?? ""}：</span>
													{r.text.slice(0, 120)}
													{r.status ? (
														<Badge className="ml-1.5" tone={r.status === "done" ? "success" : r.status === "unanswered" || r.status === "withdrawn" ? "danger" : "info"}>
															{SUBMISSION_LABEL[r.status]}
															{r.reason ? `：${reasonText(r.reason)}` : ""}
														</Badge>
													) : null}
													{r.answerExcerpt ? <span className="mt-0.5 block truncate text-xs text-fg-muted">→ {r.answerExcerpt}</span> : null}
												</li>
											))}
										</ol>
									)}
								</Section>
								<Section icon={<Package />} title="成果" count={h.deliverables.length}>
									{h.deliverablesUnavailable ? (
										<None>文件服务不可用：{h.deliverablesUnavailable}</None>
									) : h.deliverables.length === 0 ? (
										<None />
									) : (
										<ul className="space-y-1" data-testid="handoff-deliverables">
											{h.deliverables.map((d) => (
												<li key={d.versionId}>
													<button
														className="inline-flex items-center gap-1.5 text-info hover:underline"
														onClick={() => {
															onOpenChange(false);
															openPreview({ fileId: d.fileId, versionId: d.versionId, name: d.name, mime: d.mime });
														}}
													>
														<FileText className="size-3.5" />
														{d.name} v{d.versionNo}
													</button>
													<span className="text-xs text-fg-subtle">
														{" "}
														· {d.createdByName ?? d.createdBy} · {relTime(d.createdAt)}
													</span>
												</li>
											))}
										</ul>
									)}
								</Section>
								<Section icon={<Users />} title="参与者" count={h.participants.length}>
									<ul className="flex flex-wrap gap-2">
										{h.participants.map((p) => (
											<li key={p.userId} className="rounded-lg border border-border px-2 py-1 text-xs">
												{p.name ?? p.userId} · {p.role ? ROLE[p.role] : <span className="text-danger">已不是成员</span>} · {p.messages} 条消息 · {p.decisions} 个决定
											</li>
										))}
									</ul>
								</Section>
								<p className="text-xs text-fg-subtle">生成于 {fullTime(h.generatedAt)}，数据来自任务记录本身，而不是手写摘要。</p>
							</>
						) : null}
					</Loadable>
				</div>
			</DialogContent>
		</Dialog>
	);
}

/** Project-level handoff summary: one line per conversation with what still needs attention. */
export function ProjectHandoffSummary({ projectId }: { projectId: string }) {
	const res = useApi<ProjectHandoff>(`/projects/${projectId}/handoff`, { pollMs: 15000 });
	const h = res.data;
	return (
		<Loadable state={res} what="项目交接摘要" need="A 组：GET /projects/:projectId/handoff">
			{h ? (
				<div data-testid="project-handoff" className="space-y-1.5">
					{h.conversations.length === 0 ? (
						<None>还没有对话。</None>
					) : (
						h.conversations.map((c) => {
							const attention = c.pendingApprovals + c.needsReconciliation + c.queued + (c.continuable ? 1 : 0);
							return (
								<Link key={c.conversation.conversationId} to={`/c/${c.conversation.spaceId}/${c.conversation.conversationId}`} className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-2 hover:bg-surface-2">
									<RunIcon status={c.status} />
									<span className="min-w-0 flex-1 truncate text-sm">{c.conversation.title}</span>
									{c.pendingApprovals ? <Badge tone="warning">{c.pendingApprovals} 待确认</Badge> : null}
									{c.needsReconciliation ? <Badge tone="danger">{c.needsReconciliation} 待核对</Badge> : null}
									{c.continuable ? <Badge tone="danger">可继续</Badge> : null}
									{c.deliverables ? <Badge>{c.deliverables} 个成果</Badge> : null}
									{!attention ? <span className="text-xs text-fg-subtle">{RUN_LABEL[c.status]}</span> : <CircleAlert className="size-3.5 text-warning" />}
								</Link>
							);
						})
					)}
				</div>
			) : null}
		</Loadable>
	);
}
