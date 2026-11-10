// One switchable, on-demand work panel: 子任务 / 终端 / 文件 / 浏览器. Never several panels at once.
// Everything shown here comes from the same server ACL as the conversation itself.
import { Bot, ExternalLink, FolderOpen, Globe, Plug, SquareTerminal, Users, X } from "lucide-react";
import { Link } from "react-router";
import type { EntriesPage, MemberType, SubagentDTO, TasksResponse } from "@shared/chat";
import type { ConversationWorkDTO } from "@shared/files";
import { BrowserSessionView, JobCard } from "./live";
import { FilesTab } from "./files";
import { TerminalTab } from "./terminal";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { durationText, isSimulatedUsage, relTime, SIMULATED_USAGE } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge, EmptyState, Loadable } from "@/components/ui/misc";
import { usePanel, type PanelState, type WorkTab } from "@/components/shell/panel";
import { browseOf } from "@/features/chat/model";

const MEMBER: Record<MemberType, { label: string; icon: typeof Bot }> = {
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
	const { openWork } = usePanel();
	const tab: WorkTab = state.tab;
	const setTab = (t: string) => openWork(t as WorkTab, state.spaceId, state.conversationId);
	return (
		<div data-testid="work-panel" className="flex h-full min-h-0 flex-col">
			<Tabs value={tab} onValueChange={setTab} className="flex h-full min-h-0 flex-col">
				<div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
					<TabsList>
						<TabsTrigger value="tasks" data-testid="work-tab-tasks">
							<Users />
							子任务
						</TabsTrigger>
						<TabsTrigger value="terminal" data-testid="work-tab-terminal">
							<SquareTerminal />
							终端
						</TabsTrigger>
						<TabsTrigger value="files" data-testid="work-tab-files">
							<FolderOpen />
							文件
						</TabsTrigger>
						<TabsTrigger value="browser" data-testid="work-tab-browser">
							<Globe />
							浏览器
						</TabsTrigger>
					</TabsList>
					<div className="flex-1" />
					<button data-testid="close-panel" onClick={onClose} className="rounded-md p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg" aria-label="关闭工作面板">
						<X className="size-4" />
					</button>
				</div>
				<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
					<TabsContent value="tasks" className="p-3">
						{tab === "tasks" ? <TasksTab spaceId={state.spaceId} conversationId={state.conversationId} /> : null}
					</TabsContent>
					<TabsContent value="terminal" className="p-3">
						{tab === "terminal" ? <TerminalTab spaceId={state.spaceId} conversationId={state.conversationId} /> : null}
					</TabsContent>
					<TabsContent value="files" className="p-3">
						{tab === "files" ? <FilesTab spaceId={state.spaceId} conversationId={state.conversationId} /> : null}
					</TabsContent>
					<TabsContent value="browser" className="p-3">
						{tab === "browser" ? <BrowserTab spaceId={state.spaceId} conversationId={state.conversationId} /> : null}
					</TabsContent>
				</div>
			</Tabs>
		</div>
	);
}

function useWork(spaceId: string, conversationId: number) {
	return useApi<{ work: ConversationWorkDTO }>(`/work/${spaceId}/${conversationId}`, { pollMs: 2000 });
}

function TasksTab({ spaceId, conversationId }: { spaceId: string; conversationId: number }) {
	const work = useWork(spaceId, conversationId);
	const jobs = work.data?.work.jobs ?? [];
	return (
		<div className="space-y-5">
			{jobs.length ? (
				<section>
					<h3 className="mb-2 text-[12.5px] font-medium text-fg-muted">后台任务（有时间/算力预算，可取消）</h3>
					<div className="space-y-2">
						{jobs.map((j) => (
							<JobCard key={j.id} job={j} onChanged={work.reload} />
						))}
					</div>
				</section>
			) : null}
			<SubagentsSection spaceId={spaceId} conversationId={conversationId} />
		</div>
	);
}

function SubagentsSection({ spaceId, conversationId }: { spaceId: string; conversationId: number }) {
	const res = useApi<TasksResponse>(`/conversations/${spaceId}/${conversationId}/tasks`, { pollMs: 2500 });
	const { me } = useSession();
	const subs = res.data?.subagents ?? [];
	const failed = subs.filter((s) => s.status === "failed" || s.status === "unanswered" || s.status === "aborted").length;
	return (
		<Loadable state={res} what="子任务" need="A 组：GET .../tasks">
			{subs.length === 0 ? (
				<EmptyState icon={<Users />} title="这个对话还没有子任务">
					当助手把工作委派给子 Agent 或外部工具时，会在这里显示来源、负责人、状态、结果和费用。
				</EmptyState>
			) : (
				<div className="space-y-2">
					<div className="text-[12.5px] text-fg-muted">
						共 {subs.length} 个子任务 · {subs.filter((s) => s.status === "done").length} 个完成
						{failed ? <span className="text-danger"> · {failed} 个失败或未完成</span> : null}
						{subs.some((s) => s.status === "running") ? ` · ${subs.filter((s) => s.status === "running").length} 个进行中` : ""}
					</div>
					{subs.map((s) => {
						const M = MEMBER[s.memberType] ?? MEMBER.builtin_subagent;
						// A turn-limit stop is the timeout class (M02-C): its own label, never shown as success or a plain failure.
						const turnLimit = /turn_limit|轮数上限|max ?turns/i.test(s.failure ?? "");
						const st = turnLimit ? { label: "达到轮数上限（超时）", tone: "warning" as const } : SUB_STATUS[s.status];
						return (
							<div key={s.delegationId} data-testid="subagent" className="rounded-xl border border-border p-3">
								<div className="flex items-center gap-2">
									<M.icon className="size-4 text-fg-muted" />
									<span className="text-sm font-medium">{s.memberName}</span>
									<Badge>{M.label}</Badge>
									{s.mode === "background" ? <Badge>后台</Badge> : null}
									<span className="flex-1" />
									<Badge tone={st.tone}>{st.label}</Badge>
								</div>
								<p className="mt-1.5 text-[13px]">{s.task}</p>
								{s.resultSummary ? <p className="mt-1 whitespace-pre-wrap text-[12.5px] text-fg-muted">结果：{s.resultSummary}</p> : null}
								{s.failure ? <p className="mt-1 text-[12.5px] text-danger">{turnLimit ? `未完成：在允许的轮数内没有完成，已停止（${s.failure}）` : `失败原因：${s.failure}`}</p> : null}
								<div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-fg-subtle">
									<span>来源：对话 {s.source.conversationId} · 调用 {s.source.callId.slice(0, 10)}</span>
									{s.ownerUserId ? <span>负责人：{s.ownerUserId === me?.userId ? `你（${me.name}）` : s.ownerUserId}</span> : null}
									<span>开始 {relTime(s.startedAt)}</span>
									{s.endedAt ? <span>用时 {durationText(Date.parse(s.endedAt) - Date.parse(s.startedAt))}</span> : null}
									{s.usage ? (
										<span>
											{isSimulatedUsage(s.usage) ? SIMULATED_USAGE : `${s.usage.totalTokens.toLocaleString()} tokens · $${s.usage.costTotal.toFixed(4)}`}
										</span>
									) : null}
								</div>
								{s.childConversationId ? (
									<Link to={`/c/${spaceId}/${s.childConversationId}`} className="mt-1.5 inline-flex items-center gap-1 text-[12.5px] text-info hover:underline">
										<ExternalLink className="size-3.5" />
										查看子任务对话
									</Link>
								) : null}
							</div>
						);
					})}
				</div>
			)}
		</Loadable>
	);
}

function BrowserTab({ spaceId, conversationId }: { spaceId: string; conversationId: number }) {
	const work = useWork(spaceId, conversationId);
	const res = useApi<EntriesPage>(`/conversations/${spaceId}/${conversationId}/entries?limit=200`, { pollMs: 4000 });
	const pages = (res.data?.items ?? []).flatMap((e) => (e.kind === "tool_result" ? [{ e, b: browseOf(e.details) }] : [])).filter((x) => x.b);
	const sessions = work.data?.work.browserSessions ?? [];
	return (
		<Loadable state={res} what="浏览记录" need="A 组：GET .../entries">
			{sessions.length ? (
				<div className="mb-4 space-y-3">
					{sessions.map((s) => (
						<BrowserSessionView key={s.id} s={s} onChanged={work.reload} />
					))}
				</div>
			) : null}
			{pages.length === 0 && sessions.length === 0 ? (
				<EmptyState icon={<Globe />} title="还没有打开过网页">
					助手使用浏览工具打开网页时，页面标题、地址、截图和提取的正文会显示在这里。
				</EmptyState>
			) : (
				<div className="space-y-3">
					{pages.map(({ e, b }) => (
						<div key={e.id} data-testid="browse-result" className="overflow-hidden rounded-xl border border-border">
							<div className="flex items-center gap-2 bg-surface-2 px-3 py-2 text-[12.5px]">
								<Globe className="size-3.5 shrink-0 text-fg-muted" />
								<span className="min-w-0 flex-1 truncate font-mono text-fg-muted" title={b!.finalUrl}>
									{b!.finalUrl}
								</span>
								{b!.status ? <Badge tone={b!.status < 400 ? "success" : "danger"}>{b!.status}</Badge> : null}
							</div>
							{b!.screenshot ? <img alt={`截图：${b!.title}`} src={`/api/files/${b!.screenshot.fileId}/versions/${b!.screenshot.versionId}/preview`} className="w-full border-b border-border" /> : null}
							<div className="px-3 py-2">
								<div className="text-sm font-medium">{b!.title || "（无标题）"}</div>
								<p className="mt-1 line-clamp-6 whitespace-pre-wrap text-[12.5px] text-fg-muted">{b!.text}</p>
							</div>
						</div>
					))}
				</div>
			)}
		</Loadable>
	);
}
