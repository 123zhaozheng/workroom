// Page of a container project (round 9): its conversations, the way to start a new one, and — for the owner — sharing. A project shared with the
// caller is read only: conversations and results can be opened, nothing can be sent.
import { FolderOpen, MessageSquare, Pencil, Share2, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { ConversationSummary } from "@shared/chat";
import { errorText } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import { relTime } from "@/lib/utils";
import { TopBar } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState, Loadable, Page } from "@/components/ui/misc";
import { Composer } from "@/features/chat/Composer";
import { RunDot } from "@/features/chat/status";
import { useStartConversation } from "@/features/chat/useStartConversation";
import { renameProject } from "./actions";
import { convKey, convPath, CONV_EVENT, isOwnContainer, isSharedToMe, type UiProject } from "./model";
import { ShareProjectDialog, SHARE_PERMISSION_TEXT } from "./ShareProjectDialog";

export function ContainerProjectPage({ project, reload }: { project: UiProject; reload: () => void }) {
	const { personalSpaceId } = useSession();
	const owner = isOwnContainer(project);
	const sharedToMe = isSharedToMe(project);
	const convs = useApi<{ conversations: ConversationSummary[] }>(`/conversations?projectId=${encodeURIComponent(project.id)}&limit=200`, { pollMs: 8000 });
	const start = useStartConversation();
	const [shareOpen, setShareOpen] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const [err, setErr] = useState<string>();
	const reloadConvs = convs.reload;
	useEffect(() => {
		window.addEventListener(CONV_EVENT, reloadConvs);
		return () => window.removeEventListener(CONV_EVENT, reloadConvs);
	}, [reloadConvs]);
	const list = (convs.data?.conversations ?? []).filter((c) => c.kind !== "subagent" && !c.archived);

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="container-project" data-project={project.id}>
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page>
					<div className="mb-6">
						<div className="flex flex-wrap items-center gap-2">
							{renaming ? (
								<RenameField
									initial={project.name}
									onDone={async (name) => {
										setRenaming(false);
										if (!name || name === project.name) return;
										try {
											await renameProject(project.id, name);
											reload();
										} catch (e) {
											setErr(errorText(e));
										}
									}}
								/>
							) : (
								<h1 data-testid="project-title" className="min-w-0 truncate text-xl font-semibold tracking-tight">
									{project.name}
								</h1>
							)}
							{owner && !renaming ? (
								<Button size="icon-sm" variant="ghost" aria-label="重命名项目" data-testid="project-page-rename" onClick={() => setRenaming(true)}>
									<Pencil />
								</Button>
							) : null}
							{sharedToMe ? <Badge tone="info">共享给我{project.ownerName ? ` · ${project.ownerName}` : ""}</Badge> : null}
							{owner && project.shared ? (
								<Badge>
									<Users /> 已分享
								</Badge>
							) : null}
							<span className="flex-1" />
							{owner ? (
								<Button size="sm" data-testid="project-share" onClick={() => setShareOpen(true)}>
									<Share2 />
									分享
								</Button>
							) : null}
						</div>
						{err ? (
							<p role="alert" className="mt-2 rounded-lg bg-danger-soft px-3 py-1.5 text-sm text-danger">
								{err}
							</p>
						) : null}
					</div>

					{sharedToMe ? (
						<p data-testid="project-readonly-note" className="mb-8 rounded-lg bg-surface-2 px-3 py-2 text-sm text-fg-muted">
							{SHARE_PERMISSION_TEXT}。
						</p>
					) : owner ? (
						<div className="mb-8">
							<Composer variant="home" spaceId={personalSpaceId} placeholder={`在「${project.name}」中开始新对话`} onSubmit={(v) => start(v, { projectId: project.id })} />
						</div>
					) : null}

					<section>
						<h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-fg-muted">
							<MessageSquare className="size-4" />
							对话
						</h2>
						<Loadable state={convs} what="项目对话">
							{list.length === 0 ? (
								<EmptyState icon={<FolderOpen />} title="还没有对话">
									{owner ? "在上面输入开始，或在侧栏里把已有对话移进来。" : "这个项目里还没有可查看的对话。"}
								</EmptyState>
							) : (
								<ul data-testid="project-conversations" className="divide-y divide-border rounded-xl border border-border bg-surface">
									{list.map((c) => (
										<li key={convKey(c)}>
											<Link to={convPath(c)} data-testid="project-conversation" className="flex items-center gap-2 px-3 py-2.5 text-sm outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
												<span className="min-w-0 flex-1 truncate">{c.title || "未命名对话"}</span>
												{c.status ? <RunDot status={c.status} /> : null}
												<span className="shrink-0 text-xs text-fg-subtle">{relTime(c.updatedAt)}</span>
											</Link>
										</li>
									))}
								</ul>
							)}
						</Loadable>
					</section>
				</Page>
			</div>
			{owner ? <ShareProjectDialog open={shareOpen} onOpenChange={setShareOpen} projectId={project.id} projectName={project.name} onChanged={reload} /> : null}
		</div>
	);
}

function RenameField({ initial, onDone }: { initial: string; onDone: (v: string) => void }) {
	const [v, setV] = useState(initial);
	const ref = useRef<HTMLInputElement>(null);
	const done = useRef(false);
	useEffect(() => {
		ref.current?.focus();
		ref.current?.select();
	}, []);
	const finish = (commit: boolean) => {
		if (done.current) return;
		done.current = true;
		onDone(commit ? v.trim() : "");
	};
	return (
		<input
			ref={ref}
			value={v}
			maxLength={80}
			aria-label="项目名称"
			data-testid="project-page-rename-input"
			onChange={(e) => setV(e.target.value)}
			onBlur={() => finish(true)}
			onKeyDown={(e) => {
				if (e.key === "Enter") finish(true);
				else if (e.key === "Escape") finish(false);
			}}
			className="h-9 min-w-0 max-w-sm flex-1 rounded-lg border border-border-strong bg-surface px-3 text-xl font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
		/>
	);
}
