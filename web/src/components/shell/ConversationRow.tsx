// One conversation in the sidebar: link + "…" menu (星标 / 重命名 / 标签 / 移至项目 / 分享 / 导出 / 归档 / 删除), inline rename, tag popover.
// Each menu item is shown only when the caller may do it (convPerms); the server decides again and any refusal is shown.
import { Archive, Download, FolderClosed, FolderInput, FolderOutput, Link2, Pencil, Star, StarOff, Tag, Trash2 } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { NavLink, useNavigate, useLocation } from "react-router";
import type { ConversationSummary } from "@shared/chat";
import { cn } from "@/lib/utils";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Popover, PopoverAnchor, PopoverContent } from "@/components/ui/overlay";
import { RunDot } from "@/features/chat/status";
import { archiveConversation, deleteConversation, exportConversation, moveConversation, renameConversation, setConversationTags, starConversation } from "@/features/projects/actions";
import { ConfirmDialog } from "@/features/projects/ConfirmDialog";
import { convKey, convPath, convPerms } from "@/features/projects/model";
import { TagsEditor } from "@/features/projects/TagsEditor";
import { MenuSub, MenuSubContent, MenuSubTrigger, RowMenuButton } from "./menuParts";
import type { TreeCtx } from "./treeTypes";

const ShareDialog = lazy(() => import("@/features/share/Share").then((m) => ({ default: m.ShareDialog })));

export function ConversationRow({ c, tree, indent }: { c: ConversationSummary; tree: TreeCtx; indent?: boolean }) {
	const key = convKey(c);
	const navigate = useNavigate();
	const { pathname } = useLocation();
	const meta = tree.metaOf(c);
	const project = c.projectId ? tree.projectById.get(c.projectId) : undefined;
	const perms = convPerms(c, project, tree.meId);
	const title = c.title || "未命名对话";
	const [menuOpen, setMenuOpen] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const [tagsOpen, setTagsOpen] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [shareOpen, setShareOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	/** Set by items that move focus somewhere themselves (inline input, popover): the menu must not pull it back to "…". */
	const keepFocus = useRef(false);
	const exportBusy = useRef(false);

	const afterMenu = (e: Event) => {
		if (keepFocus.current) {
			e.preventDefault();
			keepFocus.current = false;
		}
	};

	const targets = tree.moveTargets.filter((p) => p.id !== c.projectId);
	const inContainer = !!project && project.kind === "container";

	return (
		<Popover open={tagsOpen} onOpenChange={setTagsOpen}>
			<PopoverAnchor asChild>
				<div data-flip-id={`c:${key}`} data-testid="conv-row" data-conv={key} data-starred={meta.starred || undefined} className="group/row relative">
					{renaming ? (
						<InlineRename
							initial={c.title}
							indent={indent}
							onCancel={() => {
								setRenaming(false);
								setTimeout(() => triggerRef.current?.focus(), 0);
							}}
							onCommit={(next) => {
								setRenaming(false);
								if (next && next !== c.title) {
									void tree.run(() => renameConversation(c, next), { optimistic: () => tree.patchConv(key, { title: next }), revert: () => tree.patchConv(key, { title: c.title }) });
								}
							}}
						/>
					) : (
						<NavLink
							to={convPath(c)}
							onClick={tree.onNavigate}
							title={title}
							className={({ isActive }) =>
								cn(
									"flex h-8 items-center gap-2 rounded-lg pr-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-hover/row:pr-8 group-has-[:focus-visible]/row:pr-8 pointer-coarse:pr-8 [@media(hover:none)]:pr-8",
									indent ? "pl-8" : "pl-2.5",
									menuOpen && "pr-8",
									isActive ? "bg-surface-3 font-medium text-fg" : "text-fg-muted hover:bg-surface-3/70 hover:text-fg",
								)
							}
						>
							<span className="min-w-0 flex-1 truncate">{title}</span>
							{c.kind === "branch" ? <span className="text-xs text-fg-muted">分支</span> : null}
							{c.status ? <RunDot status={c.status} /> : null}
						</NavLink>
					)}
					{!renaming ? (
						<Menu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
							<MenuTrigger asChild>
								<RowMenuButton ref={triggerRef} aria-label={`对话「${title}」的操作`} data-testid="conv-menu" />
							</MenuTrigger>
							<MenuContent side="right" align="start" sideOffset={8} className="w-52" onCloseAutoFocus={afterMenu}>
								<MenuItem data-testid="menu-star" onSelect={() => void tree.run(() => starConversation(c, !meta.starred), { optimistic: () => tree.patchMeta(key, { starred: !meta.starred }), revert: () => tree.patchMeta(key, { starred: meta.starred }) })}>
									{meta.starred ? <StarOff /> : <Star />}
									{meta.starred ? "取消星标" : "星标"}
								</MenuItem>
								{perms.write ? (
									<>
										<MenuItem
											data-testid="menu-rename"
											onSelect={() => {
												keepFocus.current = true;
												setRenaming(true);
											}}
										>
											<Pencil />
											重命名
										</MenuItem>
										<MenuItem
											data-testid="menu-tags"
											onSelect={() => {
												keepFocus.current = true;
												// the menu is still closing: open the popover on the next frame so its focus handling does not fight the menu's
												setTimeout(() => setTagsOpen(true), 30);
											}}
										>
											<Tag />
											标签
										</MenuItem>
									</>
								) : null}
								{perms.write ? (
									<MenuSub>
										<MenuSubTrigger data-testid="menu-move" disabled={!!perms.moveBlocked}>
											<FolderInput />
											<span className="min-w-0 flex-1">
												移至项目
												{perms.moveBlocked ? <span className="block text-xs text-fg-subtle">{perms.moveBlocked}</span> : null}
											</span>
										</MenuSubTrigger>
										<MenuSubContent>
											{inContainer ? (
												<MenuItem data-testid="menu-move-out" onSelect={() => move(null)}>
													<FolderOutput />
													移出项目
												</MenuItem>
											) : null}
											{targets.map((p) => (
												<MenuItem key={p.id} data-testid="menu-move-to" data-project={p.id} onSelect={() => move(p.id)}>
													<FolderClosed />
													<span className="truncate">{p.name}</span>
												</MenuItem>
											))}
											{targets.length === 0 && !inContainer ? <div className="px-2.5 py-1.5 text-sm text-fg-muted">还没有可移入的项目</div> : null}
										</MenuSubContent>
									</MenuSub>
								) : null}
								{perms.share ? (
									<MenuItem data-testid="menu-share" onSelect={() => setShareOpen(true)}>
										<Link2 />
										分享只读链接
									</MenuItem>
								) : null}
								<MenuItem
									data-testid="menu-export"
									onSelect={() => {
										if (exportBusy.current) return;
										exportBusy.current = true;
										void tree.run(() => exportConversation(c, title)).finally(() => (exportBusy.current = false));
									}}
								>
									<Download />
									导出 Markdown
								</MenuItem>
								{perms.write || perms.del ? <MenuSeparator /> : null}
								{perms.write ? (
									<MenuItem data-testid="menu-archive" onSelect={() => void tree.run(() => archiveConversation(c, true))}>
										<Archive />
										归档
									</MenuItem>
								) : null}
								{perms.del ? (
									<MenuItem data-testid="menu-delete" className="text-danger [&_svg]:text-danger" onSelect={() => setConfirmDelete(true)}>
										<Trash2 />
										删除…
									</MenuItem>
								) : null}
							</MenuContent>
						</Menu>
					) : null}
					<ConfirmDialog
						open={confirmDelete}
						onOpenChange={setConfirmDelete}
						title="删除这个对话？"
						confirmLabel="删除"
						testId="confirm-delete-conversation"
						onConfirm={async () => {
							await deleteConversation(c);
							tree.reload();
							if (pathname === convPath(c)) navigate("/");
						}}
					>
						「{title}」删除后将无法在 Workroom 中打开和搜索。
					</ConfirmDialog>
					{shareOpen ? (
						<Suspense fallback={null}>
							<ShareDialog open={shareOpen} onOpenChange={setShareOpen} kind="conversation" id={String(c.conversationId)} spaceId={c.spaceId} title={title} />
						</Suspense>
					) : null}
				</div>
			</PopoverAnchor>
			<PopoverContent side="right" align="start" sideOffset={8} className="p-0" onCloseAutoFocus={(e) => {
				e.preventDefault();
				triggerRef.current?.focus();
			}}>
				<TagsEditor
					initial={meta.tags}
					onCancel={() => setTagsOpen(false)}
					onSave={async (tags) => {
						const ok = await tree.run(() => setConversationTags(c, tags), { optimistic: () => tree.patchMeta(key, { tags }), revert: () => tree.patchMeta(key, { tags: meta.tags }) });
						if (ok) setTagsOpen(false);
					}}
				/>
			</PopoverContent>
		</Popover>
	);

	function move(projectId: string | null) {
		const prevProject = c.projectId;
		void tree.run(() => moveConversation(c, projectId), { optimistic: () => tree.patchConv(key, { projectId: projectId ?? undefined }), revert: () => tree.patchConv(key, { projectId: prevProject }) }).then((ok) => {
			if (ok && projectId) tree.openProject(projectId);
		});
	}
}

function InlineRename({ initial, indent, onCommit, onCancel }: { initial: string; indent?: boolean; onCommit: (v: string) => void; onCancel: () => void }) {
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
		<div className={cn("flex h-8 items-center pr-1", indent ? "pl-8" : "pl-1.5")}>
			<input
				ref={ref}
				value={v}
				maxLength={120}
				aria-label="对话标题"
				data-testid="rename-input"
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
