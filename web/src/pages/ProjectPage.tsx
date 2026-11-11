import { FolderOpen, Link2, MessageSquare, UserPlus, Users } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { errorText, put } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import type { Project, ProjectMember, ProjectRole } from "@/lib/types";
import { useSession } from "@/lib/session";
import { TopBar } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge, EmptyState, Loadable, Page } from "@/components/ui/misc";
import { Composer } from "@/features/chat/Composer";
import { ProjectHandoffSummary } from "@/features/handoff/Handoff";
import { ShareDialog } from "@/features/share/Share";
import { SandboxPicker } from "@/features/projects/SandboxPicker";
import { EnvVarsEditor } from "@/features/settings/EnvVars";
import { useStartConversation } from "@/features/chat/useStartConversation";

export const ROLE: Record<ProjectRole, string> = { owner: "所有者", editor: "编辑者", viewer: "查看者" };

export default function ProjectPage() {
	const { projectId } = useParams();
	const { me } = useSession();
	const projects = useApi<{ projects: Project[] }>("/projects");
	const project = projects.data?.projects.find((p) => p.id === projectId);
	const members = useApi<{ members: ProjectMember[] }>(`/projects/${projectId}/members`);
	const start = useStartConversation();
	const isOwner = project?.role === "owner";
	const [share, setShare] = useState(false);
	const canWrite = project?.role === "owner" || project?.role === "editor";

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page>
					<Loadable state={projects} what="项目">
						{!project ? (
							<EmptyState icon={<FolderOpen />} title="找不到这个项目">你可能没有访问权限，或已被移出项目。</EmptyState>
						) : (
							<>
								<div className="mb-6">
									<div className="flex items-center gap-2">
										<h1 className="text-xl font-semibold tracking-tight">{project.name}</h1>
										<Badge>{ROLE[project.role]}</Badge>
										<span className="flex-1" />
										{isOwner ? (
											<Button size="sm" onClick={() => setShare(true)} data-testid="project-share">
												<Link2 />
												外部只读分享
											</Button>
										) : null}
									</div>
									<ShareDialog open={share} onOpenChange={setShare} kind="project" id={project.id} title={project.name} />
									{project.description ? <p className="mt-1 text-[13px] text-fg-muted">{project.description}</p> : null}
								</div>
								{canWrite ? (
									<div className="mb-8">
										<Composer variant="home" spaceId={project.spaceId} projectId={project.id} placeholder={`在「${project.name}」中开始新对话`} onSubmit={(v) => start(v, { projectId: project.id, spaceId: project.spaceId })} />
									</div>
								) : (
									<p className="mb-8 rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-fg-muted">你是查看者：可以查看项目内容，但不能发起对话或修改文件。</p>
								)}
								{isOwner ? <SandboxPicker projectId={project.id} /> : null}
								<section data-testid="project-env" className="mb-8">
									<h2 className="mb-2 text-[13px] font-medium text-fg-muted">环境变量</h2>
									<EnvVarsEditor scope="project" scopeRef={project.id} editable={isOwner} testId="env-vars-project" />
								</section>
								<div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_280px]">
									<section>
										<h2 className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-fg-muted">
											<MessageSquare className="size-4" />
											项目对话与待处理
										</h2>
										<ProjectHandoffSummary projectId={project.id} />
										<Link to={`/files?projectId=${project.id}`} className="mt-4 inline-flex items-center gap-1 text-[13px] text-info hover:underline">
											<FolderOpen className="size-4" />
											查看项目文件
										</Link>
									</section>
									<section>
										<h2 className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-fg-muted">
											<Users className="size-4" />
											成员
										</h2>
										<Loadable state={members} what="成员">
											<ul className="space-y-1" data-testid="members">
												{(members.data?.members ?? []).map((m) => (
													<MemberRow key={m.id} m={m} projectId={project.id} editable={isOwner && m.id !== me?.userId} onChanged={members.reload} />
												))}
											</ul>
										</Loadable>
										{isOwner ? <AddMember projectId={project.id} onAdded={members.reload} /> : null}
									</section>
								</div>
							</>
						)}
					</Loadable>
				</Page>
			</div>
		</div>
	);
}

function MemberRow({ m, projectId, editable, onChanged }: { m: ProjectMember; projectId: string; editable: boolean; onChanged: () => void }) {
	const [err, setErr] = useState<string>();
	const set = async (role: ProjectRole | null) => {
		setErr(undefined);
		try {
			await put(`/projects/${projectId}/members`, { email: m.email, role });
			onChanged();
		} catch (e) {
			setErr(errorText(e));
		}
	};
	return (
		<li className="rounded-lg px-2 py-1.5 hover:bg-surface-2">
			<div className="flex items-center gap-2">
				<span className="flex size-6 items-center justify-center rounded-full bg-surface-3 text-xs">{m.name.slice(0, 1)}</span>
				<span className="min-w-0 flex-1">
					<span className="block truncate text-[13px]">{m.name}</span>
					<span className="block truncate text-xs text-fg-subtle">{m.email}</span>
				</span>
				{editable ? (
					<Select value={m.role} onChange={(e) => void set(e.target.value === "remove" ? null : (e.target.value as ProjectRole))} className="h-7 text-xs" aria-label={`${m.name} 的角色`}>
						<option value="owner">所有者</option>
						<option value="editor">编辑者</option>
						<option value="viewer">查看者</option>
						<option value="remove">移出项目</option>
					</Select>
				) : (
					<Badge>{ROLE[m.role]}</Badge>
				)}
			</div>
			{err ? <p className="mt-1 text-xs text-danger">{err}</p> : null}
		</li>
	);
}

function AddMember({ projectId, onAdded }: { projectId: string; onAdded: () => void }) {
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<ProjectRole>("editor");
	const [err, setErr] = useState<string>();
	return (
		<form
			className="mt-3 space-y-2"
			onSubmit={async (e) => {
				e.preventDefault();
				setErr(undefined);
				try {
					await put(`/projects/${projectId}/members`, { email, role });
					setEmail("");
					onAdded();
				} catch (e) {
					setErr(errorText(e));
				}
			}}
		>
			<Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="同组织成员的邮箱" type="email" required className="h-8 text-[13px]" />
			<div className="flex gap-2">
				<Select aria-label="成员角色" value={role} onChange={(e) => setRole(e.target.value as ProjectRole)} className="h-8 flex-1 text-[13px]">
					<option value="editor">编辑者</option>
					<option value="viewer">查看者</option>
					<option value="owner">所有者</option>
				</Select>
				<Button type="submit" size="sm">
					<UserPlus />
					添加
				</Button>
			</div>
			{err ? <p className="text-xs text-danger">{err}</p> : null}
		</form>
	);
}
