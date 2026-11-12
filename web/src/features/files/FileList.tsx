// The output library list shared by the wide two-column 文件库 and the phone list page. It lists ONLY delivered outputs (GET /library:
// present_file results), grouped by the conversation folder they were delivered into. Deleting an output withdraws it (with a confirm).
// Uploads are not outputs: they stay on their messages.
import { Eye, FolderOpen, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import type { LibItemDTO } from "@shared/files";
import { del } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { cn, formatBytes, relTime } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { LoadState } from "@/features/work/states";
import { fileIcon } from "@/features/chat/Cards";
import { ConfirmDialog } from "@/features/projects/ConfirmDialog";

/** List state for the library. Lives in the page so the list (and its search) survives selecting another file. */
export function useFileLibrary() {
	const items = useApi<{ items: LibItemDTO[] }>("/library");
	const [q, setQ] = useState("");
	const [removing, setRemoving] = useState<LibItemDTO | null>(null);
	const list = useMemo(() => {
		const all = items.data?.items ?? [];
		const needle = q.trim().toLowerCase();
		return needle ? all.filter((i) => i.name.toLowerCase().includes(needle)) : all;
	}, [items.data, q]);
	/** Groups in the order of their newest item (the server returns newest first). */
	const groups = useMemo(() => {
		const m = new Map<string, { folder: string; spaceId: string; conversationId: number; items: LibItemDTO[] }>();
		for (const i of list) {
			const key = `${i.spaceId}/${i.conversationId}`;
			const g = m.get(key) ?? { folder: i.folder, spaceId: i.spaceId, conversationId: i.conversationId, items: [] };
			g.items.push(i);
			m.set(key, g);
		}
		return [...m.values()];
	}, [list]);
	return { items, q, setQ, groups, count: list.length, filtered: !!q.trim(), removing, setRemoving, clear: () => setQ("") };
}
export type FileLibrary = ReturnType<typeof useFileLibrary>;

export function FileSearch({ lib, split }: { lib: FileLibrary; split?: boolean }) {
	return (
		<div className={cn("relative", split ? "px-3 pb-3" : "mb-4")}>
			<Search aria-hidden className={cn("absolute top-2.5 size-4 text-fg-subtle", split ? "left-[22px]" : "left-2.5")} />
			<Input value={lib.q} onChange={(e) => lib.setQ(e.target.value)} placeholder="搜索文件名" aria-label="搜索文件名" className="pl-8" />
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
					{lib.groups.map((g) => (
						<section key={`${g.spaceId}/${g.conversationId}`} data-testid="files-folder" data-folder={g.folder}>
							<h3 className="mb-1 flex items-center gap-1.5 px-3 text-[13px] text-fg-muted">
								<FolderOpen aria-hidden className="size-4 shrink-0" strokeWidth={1.5} />
								<Link to={`/c/${g.spaceId}/${g.conversationId}`} className="min-w-0 truncate hover:text-fg hover:underline" title="打开对话">
									{g.folder}
								</Link>
								<span className="tabular-nums text-fg-subtle">· {g.items.length}</span>
							</h3>
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
				</div>
			)}
		</LoadState>
	);
}
