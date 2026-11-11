// A project in the sidebar tree: chevron (expand / collapse, remembered per user) + link to the project page + "…" menu + its conversations.
// Owners of a container project: 重命名 / 分享 / 删除. Legacy (own space) projects carry a quiet 旧版 label and a settings link. Shared-with-me
// projects are read only: no menu, no new conversation.
import { ChevronRight, FolderClosed, FolderOpen, Pencil, Plus, Settings2, Share2, Trash2, Users } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { cn } from "@/lib/utils";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlay";
import { Spinner } from "@/components/ui/misc";
import { deleteProject, renameProject, startConversationIn } from "@/features/projects/actions";
import { ConfirmDialog } from "@/features/projects/ConfirmDialog";
import { canStartIn, convPath, isOwnContainer, isSharedToMe, type UiProject } from "@/features/projects/model";
import { ShareProjectDialog } from "@/features/projects/ShareProjectDialog";
import { Collapse } from "./Collapse";
import { RowMenuButton } from "./menuParts";
import type { TreeCtx } from "./treeTypes";

export function ProjectRow({ p, open, onToggle, tree, count, children, instant }: { p: UiProject; open: boolean; onToggle: () => void; tree: TreeCtx; count: number; children: ReactNode; instant?: boolean }) {
	const navigate = useNavigate();
	const { pathname } = useLocation();
	const bodyId = useId();
	const [menuOpen, setMenuOpen] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const [shareOpen, setShareOpen] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [creating, setCreating] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const keepFocus = useRef(false);
	const owner = isOwnContainer(p);
	const legacy = p.kind === "space";
	const shared = isSharedToMe(p);
	const canRename = owner || (legacy && p.role === "owner");
	const hasMenu = owner || legacy;

	const newChat = async () => {
		setCreating(true);
		await tree.run(async () => {
			const conv = await startConversationIn(p.id);
			navigate(convPath(conv));
			tree.onNavigate?.();
		});
		setCreating(false);
	};

	return (
		<div data-testid="project" data-project={p.id} data-kind={p.kind} data-access={p.access} data-open={open}>
			<div data-flip-id={`p:${p.id}`} className="group/row relative flex h-8 items-center">
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={open}
					aria-controls={bodyId}
					aria-label={`${open ? "收起" : "展开"}项目「${p.name}」`}
					data-testid="project-toggle"
					className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
				>
					<ChevronRight className={cn("size-3.5 transition-transform duration-200", open && "rotate-90")} />
				</button>
				{renaming ? (
					<ProjectRename
						initial={p.name}
						onCancel={() => {
							setRenaming(false);
							setTimeout(() => triggerRef.current?.focus(), 0);
						}}
						onCommit={(name) => {
							setRenaming(false);
							if (name && name !== p.name) void tree.run(() => renameProject(p.id, name));
						}}
					/>
				) : (
					<NavLink
						to={`/projects/${p.id}`}
						onClick={tree.onNavigate}
						title={p.name}
						className={({ isActive }) =>
							cn(
								"flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg pr-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&_svg]:size-[15px] [&_svg]:shrink-0 [&_svg]:text-fg-muted",
								hasMenu && "group-hover/row:pr-8 group-has-[:focus-visible]/row:pr-8 pointer-coarse:pr-8 [@media(hover:none)]:pr-8",
								menuOpen && "pr-8",
								isActive ? "bg-surface-3 font-medium text-fg" : "text-fg hover:bg-surface-3/70",
							)
						}
					>
						{open ? <FolderOpen /> : <FolderClosed />}
						<span className="min-w-0 truncate">{p.name}</span>
						{legacy ? (
							<span data-testid="project-legacy" className="shrink-0 rounded bg-surface-3 px-1 text-xs font-normal text-fg-muted">
								旧版
							</span>
						) : null}
						{!legacy && !shared && p.shared ? <Users aria-label="已分享" className="!text-fg-subtle" /> : null}
						<span className="ml-auto shrink-0 text-xs font-normal tabular-nums text-fg-subtle">{count > 0 ? count : ""}</span>
					</NavLink>
				)}
				{hasMenu && !renaming ? (
					<Menu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
						<MenuTrigger asChild>
							<RowMenuButton ref={triggerRef} aria-label={`项目「${p.name}」的操作`} data-testid="project-menu" />
						</MenuTrigger>
						<MenuContent side="right" align="start" sideOffset={8} className="w-48" onCloseAutoFocus={(e) => {
							if (keepFocus.current) {
								e.preventDefault();
								keepFocus.current = false;
							}
						}}>
							{canRename ? (
								<MenuItem
									data-testid="project-rename"
									onSelect={() => {
										keepFocus.current = true;
										setRenaming(true);
									}}
								>
									<Pencil />
									重命名
								</MenuItem>
							) : null}
							{owner ? (
								<MenuItem data-testid="project-share-open" onSelect={() => setShareOpen(true)}>
									<Share2 />
									分享…
								</MenuItem>
							) : null}
							{legacy ? (
								<MenuItem data-testid="project-settings" onSelect={() => { navigate(`/projects/${p.id}`); tree.onNavigate?.(); }}>
									<Settings2 />
									项目设置
								</MenuItem>
							) : null}
							{owner ? (
								<>
									<MenuSeparator />
									<MenuItem data-testid="project-delete" className="text-danger [&_svg]:text-danger" onSelect={() => setConfirmDelete(true)}>
										<Trash2 />
										删除…
									</MenuItem>
								</>
							) : null}
						</MenuContent>
					</Menu>
				) : null}
			</div>
			<Collapse open={open} id={bodyId} instant={instant}>
				<div className="flex flex-col gap-px pb-1">
					{children}
					{canStartIn(p) ? (
						<button
							type="button"
							data-testid="project-new-chat"
							disabled={creating}
							onClick={newChat}
							className="flex h-8 items-center gap-2 rounded-lg pl-8 pr-2 text-left text-sm text-fg-muted outline-none hover:bg-surface-3/70 hover:text-fg focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-60 [&_svg]:size-3.5"
						>
							{creating ? <Spinner className="size-3.5" /> : <Plus />}
							新对话
						</button>
					) : null}
					{shared ? <p className="pl-8 pr-2 pt-0.5 text-xs text-fg-subtle">{p.ownerName ? `${p.ownerName} 分享 · ` : ""}只读</p> : null}
				</div>
			</Collapse>
			{owner ? (
				<>
					<ShareProjectDialog open={shareOpen} onOpenChange={setShareOpen} projectId={p.id} projectName={p.name} onChanged={tree.reload} />
					<ConfirmDialog
						open={confirmDelete}
						onOpenChange={setConfirmDelete}
						title="删除这个项目？"
						confirmLabel="删除项目"
						testId="confirm-delete-project"
						onConfirm={async () => {
							await deleteProject(p.id);
							tree.reload();
							if (pathname === `/projects/${p.id}`) navigate("/");
						}}
					>
						「{p.name}」里的对话不会被删除，会移回“最近对话”。{p.shared ? "已分享的同事将无法再查看这个项目。" : ""}
					</ConfirmDialog>
				</>
			) : null}
		</div>
	);
}

function ProjectRename({ initial, onCommit, onCancel }: { initial: string; onCommit: (v: string) => void; onCancel: () => void }) {
	const [v, setV] = useState(initial);
	const done = useRef(false);
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		ref.current?.focus();
		ref.current?.select();
	}, []);
	const finish = (commit: boolean) => {
		if (done.current) return;
		done.current = true;
		if (commit) onCommit(v.trim());
		else onCancel();
	};
	return (
		<div className="flex h-8 min-w-0 flex-1 items-center pr-1">
			<input
				ref={ref}
				value={v}
				maxLength={80}
				aria-label="项目名称"
				data-testid="project-rename-input"
				onChange={(e) => setV(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						finish(true);
					} else if (e.key === "Escape") {
						e.preventDefault();
						e.stopPropagation();
						finish(false);
					}
				}}
				onBlur={() => finish(true)}
				className="h-7 w-full rounded-md border border-border-strong bg-surface px-2 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring"
			/>
		</div>
	);
}
