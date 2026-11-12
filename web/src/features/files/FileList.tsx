// The output library state + rows shared by the 文件库 overview, the opened conversation, the wide split layout (file detail) and the
// phone list. It lists ONLY delivered outputs (GET /library: present_file results), grouped by the conversation folder they were
// delivered into. Deleting an output withdraws it (with a confirm). Uploads are not outputs: they stay on their messages.
import { Eye, FolderOpen, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { LibItemDTO } from "@shared/files";
import { del } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { cn, formatBytes, relTime } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { LoadState } from "@/features/work/states";
import { fileIcon } from "@/features/chat/Cards";
import { ConfirmDialog } from "@/features/projects/ConfirmDialog";
import { bucketByDay, buildGroups, folderTitle, groupKey, kindOf, type FileGroup, type KindFilter, type SortKey } from "./fileKinds";

/**
 * List state for the library. Lives in the page so the list (and its search) survives selecting another file. The view mode
 * (`?view=list`) and the opened conversation (`?g=<space>/<conversation>`) live in the URL: back, reload and links keep them.
 */
export function useFileLibrary() {
	const items = useApi<{ items: LibItemDTO[] }>("/library");
	const [params, setParams] = useSearchParams();
	const [q, setQ] = useState("");
	const [kind, setKind] = useState<KindFilter>("all");
	const [sort, setSort] = useState<SortKey>("recent");
	const [removing, setRemoving] = useState<LibItemDTO | null>(null);
	const view: "grid" | "list" = params.get("view") === "list" ? "list" : "grid";
	const openKey = params.get("g");
	const patch = (fn: (n: URLSearchParams) => void, replace: boolean) =>
		setParams(
			(p) => {
				const n = new URLSearchParams(p);
				fn(n);
				return n;
			},
			{ replace },
		);
	const setView = (v: "grid" | "list") => patch((n) => (v === "list" ? n.set("view", "list") : n.delete("view")), true);
	const openGroup = (key: string | null) => patch((n) => (key ? n.set("g", key) : n.delete("g")), false);

	const all = items.data?.items;
	const list = useMemo(() => {
		const needle = q.trim().toLowerCase();
		return (all ?? []).filter((i) => (kind === "all" || kindOf(i.name, i.mime) === kind) && (!needle || i.name.toLowerCase().includes(needle) || i.folder.toLowerCase().includes(needle)));
	}, [all, q, kind]);
	/** Conversation folders in the order of `sort`, and the same folders bucketed by day for the timeline. */
	const groups = useMemo(() => buildGroups(list, sort), [list, sort]);
	const days = useMemo(() => bucketByDay(groups, sort), [groups, sort]);
	/** The opened conversation with ALL its files: search and kind never hide files inside an opened folder. */
	const opened = useMemo(() => (openKey ? (buildGroups((all ?? []).filter((i) => groupKey(i.spaceId, i.conversationId) === openKey), sort)[0] ?? null) : null), [all, openKey, sort]);
	return { items, q, setQ, kind, setKind, sort, setSort, view, setView, openKey, openGroup, opened, groups, days, count: list.length, filtered: !!q.trim() || kind !== "all", removing, setRemoving, clear: () => (setQ(""), setKind("all")) };
}
export type FileLibrary = ReturnType<typeof useFileLibrary>;

export function FileSearch({ lib, split }: { lib: FileLibrary; split?: boolean }) {
	return (
		<div className={cn("relative", split ? "px-3 pb-3" : "mb-4")}>
			<Search aria-hidden className={cn("absolute top-2.5 size-4 text-fg-subtle", split ? "left-[22px]" : "left-2.5")} />
			<Input value={lib.q} onChange={(e) => lib.setQ(e.target.value)} placeholder="搜索文件或会话" aria-label="搜索文件或会话" className="pl-8" />
		</div>
	);
}

/** The withdraw confirmation: the output disappears from the library and its cards show 已删除. */
export function RemoveOutputDialog({ lib, onRemoved }: { lib: FileLibrary; onRemoved?: (i: LibItemDTO) => void }) {
	const item = lib.removing;
	return (
		<ConfirmDialog
			open={!!item}
			onOpenChange={(o) => !o && lib.setRemoving(null)}
			title="删除这个成果？"
			confirmLabel="删除"
			testId="remove-output-dialog"
			onConfirm={async () => {
				if (!item) return;
				await del(`/library/${encodeURIComponent(item.fileId)}`);
				lib.items.reload();
				lib.setRemoving(null);
				onRemoved?.(item);
			}}
		>
			「{item?.name}」将从文件库移除，对话里的卡片会显示已删除，不能再下载。
		</ConfirmDialog>
	);
}

export interface FileRowsProps {
	lib: FileLibrary;
	selectedId?: string;
	split?: boolean;
	/** Phones: the eye opens the shared preview sheet. Wide: it opens the file in the detail column. */
	onPreview: (f: LibItemDTO) => void;
}

export function FileRows({ lib, selectedId, split, onPreview }: FileRowsProps) {
	return (
		<LoadState state={lib.items} what="文件库">
			{lib.groups.length === 0 ? (
				<div data-testid="files-empty" className={split ? "px-2" : "rounded-xl border border-border bg-surface"}>
					<EmptyState icon={<FolderOpen />} title={lib.filtered ? "没有匹配的文件" : "还没有交付的成果"} />
				</div>
			) : (
				<div className={cn("space-y-4", split && "px-2 pb-3")}>
					<GroupRows lib={lib} groups={lib.groups} selectedId={selectedId} split={split} onPreview={onPreview} />
				</div>
			)}
		</LoadState>
	);
}

/** Conversation folders as sections of file rows: open (link), preview, delete. */
export function GroupRows({ lib, groups, selectedId, split, onPreview, hideTitle }: FileRowsProps & { groups: FileGroup[]; hideTitle?: boolean }) {
	return (
		<>
			{groups.map((g) => (
				<section key={g.key} data-testid="files-folder" data-folder={g.folder}>
					{hideTitle ? null : (
						<h3 className="mb-1 flex items-center gap-1.5 px-3 text-[13px] text-fg-muted">
							<FolderOpen aria-hidden className="size-4 shrink-0" strokeWidth={1.5} />
							<Link to={`/c/${g.spaceId}/${g.conversationId}`} className="min-w-0 truncate hover:text-fg hover:underline" title="打开对话">
								{folderTitle(g.folder)}
							</Link>
							<span className="tabular-nums text-fg-subtle">· {g.items.length}</span>
						</h3>
					)}
					<ul className={cn(!split && "overflow-hidden rounded-xl border border-border bg-surface")}>
						{g.items.map((f, i) => {
							const Icon = fileIcon(f.name, f.mime);
							const selected = f.fileId === selectedId;
							return (
								<li
									key={f.fileId}
									data-testid="file-row"
									data-file-id={f.fileId}
									data-selected={selected ? "true" : undefined}
									className={cn("group flex items-center gap-3 px-3 py-2.5", split ? "rounded-lg" : i > 0 && "border-t border-border", selected ? "bg-surface-3" : "hover:bg-surface-2/70")}
								>
									<Icon className="size-[18px] shrink-0 text-fg-muted" strokeWidth={1.5} />
									<Link to={`/files/${f.fileId}`} aria-current={selected ? "page" : undefined} className="min-w-0 flex-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
										<span className="block truncate text-sm font-medium">{f.name}</span>
										<span className="block truncate text-xs text-fg-muted">
											{formatBytes(f.size)} · {relTime(f.updatedAt)}
										</span>
									</Link>
									<button type="button" onClick={() => onPreview(f)} className={cn("inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", split && "opacity-0 group-hover:opacity-100")} aria-label={`预览 ${f.name}`}>
										<Eye className="size-4" />
									</button>
									<button type="button" data-testid="file-delete" onClick={() => lib.setRemoving(f)} className={cn("inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-3 hover:text-danger focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", split && "opacity-0 group-hover:opacity-100")} aria-label={`删除 ${f.name}`}>
										<Trash2 className="size-4" />
									</button>
								</li>
							);
						})}
					</ul>
				</section>
			))}
		</>
	);
}
