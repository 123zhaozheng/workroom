// 文件库 overview: title + toolbar (search, sort, grid / list), kind chips, and a day timeline of conversation cards — one card per
// conversation folder with a tray of its newest files (Tray.tsx). A card (or 查看全部) opens that conversation's files (`?g=`); the list
// view shows the same days as file rows. File detail stays on `/files/:fileId`.
import { ArrowLeft, ArrowRight, Ellipsis, FolderOpen, LayoutGrid, List, MessageSquare, Search } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import type { LibItemDTO } from "@shared/files";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/misc";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/overlay";
import { LoadState, Notice } from "@/features/work/states";
import { GroupRows, type FileLibrary } from "./FileList";
import { KIND_FILTERS, SORTS, folderTitle, timeOf, type FileGroup, type SortKey } from "./fileKinds";
import { FileTray } from "./Tray";

export function LibraryOverview({ lib, onPreview }: { lib: FileLibrary; onPreview: (f: LibItemDTO) => void }) {
	if (lib.openKey) return <OpenedFolder lib={lib} onPreview={onPreview} />;
	return (
		<div className="mx-auto w-full max-w-[1320px] px-4 pb-16 pt-6 sm:px-8 sm:pt-10">
			<div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
				<div className="min-w-0">
					<h1 className="text-3xl font-semibold tracking-tight">文件库</h1>
					<p className="mt-2 text-[15px] text-fg-muted">按会话收纳，按时间回看</p>
				</div>
				<Toolbar lib={lib} />
			</div>
			<div role="group" aria-label="文件类型" className="mt-6 flex flex-wrap gap-2">
				{KIND_FILTERS.map((k) => (
					<button
						key={k.id}
						type="button"
						data-testid={`files-filter-${k.id}`}
						aria-pressed={lib.kind === k.id}
						onClick={() => lib.setKind(k.id)}
						className={cn("h-9 rounded-full border px-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring", lib.kind === k.id ? "border-accent bg-accent font-medium text-accent-fg" : "border-border bg-surface text-fg hover:bg-surface-2")}
					>
						{k.label}
					</button>
				))}
			</div>
			<div className="mt-8">
				<LoadState state={lib.items} what="文件库">
					{lib.days.length === 0 ? (
						<div data-testid="files-empty" className="rounded-xl border border-border bg-surface">
							<EmptyState icon={<FolderOpen />} title={lib.filtered ? "没有匹配的文件" : "还没有交付的成果"} />
						</div>
					) : (
						<ol data-testid="files-timeline" className="relative">
							<span aria-hidden className="absolute bottom-0 left-[4px] top-3 w-px bg-border" />
							{lib.days.map((d) => (
								<li key={d.key} className="relative grid gap-x-4 gap-y-3 pb-8 sm:grid-cols-[100px_minmax(0,1fr)]">
									<div className="relative pl-5">
										<span aria-hidden className="absolute left-0 top-[7px] size-[9px] rounded-full border border-border-strong bg-bg" />
										<h2 className="text-[17px] font-semibold leading-6">{d.label}</h2>
										{d.sub ? <p className="text-sm text-fg-muted">{d.sub}</p> : null}
									</div>
									<div className="min-w-0 pl-5 sm:pl-0">
										{lib.view === "grid" ? (
											<div className="grid gap-x-2 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
												{d.groups.map((g) => (
													<FolderCard key={g.key} g={g} lib={lib} />
												))}
											</div>
										) : (
											<div className="space-y-4">
												<GroupRows lib={lib} groups={d.groups} onPreview={onPreview} />
											</div>
										)}
									</div>
								</li>
							))}
						</ol>
					)}
				</LoadState>
			</div>
		</div>
	);
}

function Toolbar({ lib }: { lib: FileLibrary }) {
	return (
		<div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
			<div className="relative min-w-0 flex-1 basis-48 sm:w-72 sm:flex-none">
				<Search aria-hidden className="absolute left-3 top-2.5 size-4 text-fg-subtle" />
				<Input data-testid="files-search" value={lib.q} onChange={(e) => lib.setQ(e.target.value)} placeholder="搜索文件或会话" aria-label="搜索文件或会话" className="h-10 rounded-xl pl-9" />
			</div>
			<Select data-testid="files-sort" aria-label="排序" value={lib.sort} onChange={(e) => lib.setSort(e.target.value as SortKey)} className="w-36">
				{SORTS.map((s) => (
					<option key={s.id} value={s.id}>
						{s.label}
					</option>
				))}
			</Select>
			<div role="group" aria-label="视图" className="flex rounded-xl border border-border bg-surface p-0.5">
				{(
					[
						["grid", "卡片视图", LayoutGrid],
						["list", "列表视图", List],
					] as const
				).map(([v, label, Icon]) => (
					<button key={v} type="button" data-testid={`files-view-${v}`} aria-pressed={lib.view === v} aria-label={label} title={label} onClick={() => lib.setView(v)} className={cn("flex size-9 items-center justify-center rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-ring", lib.view === v ? "bg-surface-3 text-fg" : "text-fg-muted hover:text-fg")}>
						<Icon className="size-[18px]" strokeWidth={1.6} />
					</button>
				))}
			</div>
		</div>
	);
}

/** One conversation folder: the tray of its files, the folder name, "N 个文件 · HH:mm". The whole card is one link; the menu sits above it. */
function FolderCard({ g, lib }: { g: FileGroup; lib: FileLibrary }) {
	const navigate = useNavigate();
	return (
		<article data-testid="files-folder" data-folder={g.folder} data-count={g.items.length} className="group relative rounded-2xl p-3 pt-4 outline-none transition-colors focus-within:bg-surface-2/70 hover:bg-surface-2/70">
			<FileTray items={g.items} />
			<h3 className="mt-3 truncate text-[17px] font-semibold leading-6">
				<button type="button" data-testid="files-card" onClick={() => lib.openGroup(g.key)} className="max-w-full truncate rounded-md text-left outline-none after:absolute after:inset-0 after:rounded-2xl focus-visible:after:ring-2 focus-visible:after:ring-ring" title={folderTitle(g.folder)}>
					{folderTitle(g.folder)}
				</button>
			</h3>
			<p className="mt-0.5 text-sm tabular-nums text-fg-muted">
				{g.items.length} 个文件 · {timeOf(g.newest)}
			</p>
			<span aria-hidden className="mt-1 inline-flex h-5 items-center gap-1 text-sm text-fg-muted opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 max-sm:opacity-100">
				查看全部 <ArrowRight className="size-3.5" />
			</span>
			<div className="absolute right-3 top-3 z-30 opacity-0 transition-opacity focus-within:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 max-sm:opacity-100">
				<Menu>
					<MenuTrigger asChild>
						<button type="button" data-testid="files-card-menu" aria-label={`更多操作：${folderTitle(g.folder)}`} className="flex size-8 items-center justify-center rounded-lg text-fg-muted outline-none hover:bg-surface-3 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-surface-3">
							<Ellipsis className="size-[18px]" />
						</button>
					</MenuTrigger>
					<MenuContent align="end" className="min-w-40">
						<MenuItem onSelect={() => navigate(`/c/${g.spaceId}/${g.conversationId}`)}>
							<MessageSquare /> 打开对话
						</MenuItem>
						<MenuItem onSelect={() => lib.openGroup(g.key)}>
							<ArrowRight /> 查看全部
						</MenuItem>
					</MenuContent>
				</Menu>
			</div>
		</article>
	);
}

/** One conversation's files: the same rows (open / preview / delete) under a back link and the folder name. */
function OpenedFolder({ lib, onPreview }: { lib: FileLibrary; onPreview: (f: LibItemDTO) => void }): ReactNode {
	const g = lib.opened;
	return (
		<div className="mx-auto w-full max-w-4xl px-4 pb-16 pt-6 sm:px-8 sm:pt-10">
			<button type="button" data-testid="files-back" onClick={() => lib.openGroup(null)} className="mb-4 inline-flex h-9 items-center gap-1.5 rounded-lg pr-2 text-sm text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring">
				<ArrowLeft className="size-4" /> 文件库
			</button>
			<LoadState state={lib.items} what="文件库">
				{g ? (
					<>
						<div className="mb-5 flex flex-wrap items-end justify-between gap-3">
							<div className="min-w-0">
								<h1 data-testid="files-folder-title" className="break-words text-2xl font-semibold tracking-tight">
									{folderTitle(g.folder)}
								</h1>
								<p className="mt-1 text-sm tabular-nums text-fg-muted">
									{g.items.length} 个文件 · {timeOf(g.newest)}
								</p>
							</div>
							<Link to={`/c/${g.spaceId}/${g.conversationId}`} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-sm outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring">
								<MessageSquare className="size-4" /> 打开对话
							</Link>
						</div>
						<div className="space-y-4">
							<GroupRows lib={lib} groups={[g]} hideTitle onPreview={onPreview} />
						</div>
					</>
				) : (
					<Notice icon={<FolderOpen />} title="这个会话里没有文件" testid="files-empty" />
				)}
			</LoadState>
		</div>
	);
}
