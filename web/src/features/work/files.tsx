// "文件" tab of the work panel: the conversation's workspace as a tree with preview and a compact per-row menu
// (下载 / 发布到文件库 / 删除, delete is confirmed). Same ACL as the conversation: viewers can browse and download but every
// write control is disabled (the server enforces it too). One quiet usage line replaces the paragraphs; the cleanup rule is behind "?".
import { ChevronDown, ChevronRight, Download, File as FileIcon, FileUp, Folder, FolderPlus, Loader2, MoreHorizontal, RefreshCw, Trash2, UploadCloud } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { FileVersionRefDTO } from "@shared/files";
import type { WorkspaceEntryDTO, WorkspaceFilesResponse, WorkspacePreviewDTO } from "@shared/sandbox";
import { ApiError, del, errorText, post, qs } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { cn, formatBytes, fullTime, relTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import { Dialog, DialogContent, Menu, MenuContent, MenuItem, MenuTrigger, Tip } from "@/components/ui/overlay";
import { InfoPop } from "@/components/shell/InfoPop";
import { FileCard } from "@/features/chat/Cards";
import { LoadState, Notice } from "./states";

const base = (spaceId: string) => `/sandbox/${spaceId}`;

async function uploadFile(spaceId: string, conversationId: number, path: string, file: File): Promise<void> {
	const res = await fetch(`/api${base(spaceId)}/file${qs({ path, conversationId })}`, { method: "PUT", body: file, credentials: "same-origin", headers: { "content-type": "application/octet-stream" } });
	if (!res.ok) {
		const j = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
		throw new ApiError(res.status, j?.error?.code ?? `http_${res.status}`, j?.error?.message ?? res.statusText);
	}
}

interface Node {
	e: WorkspaceEntryDTO;
	children: Node[];
}
function buildTree(entries: WorkspaceEntryDTO[]): Node[] {
	const byPath = new Map<string, Node>();
	const roots: Node[] = [];
	for (const e of entries) byPath.set(e.path, { e, children: [] });
	for (const n of byPath.values()) {
		const i = n.e.path.lastIndexOf("/");
		const parent = i < 0 ? undefined : byPath.get(n.e.path.slice(0, i));
		(parent ? parent.children : roots).push(n);
	}
	return roots;
}
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

export function FilesTab({ spaceId, conversationId }: { spaceId: string; conversationId: number }) {
	const files = useApi<WorkspaceFilesResponse>(`${base(spaceId)}/files${qs({ conversationId })}`, { pollMs: 4000 });
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [sel, setSel] = useState<{ path: string; kind: "file" | "directory" } | null>(null);
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState<{ tone: "ok" | "err"; text: string }>();
	const [newDir, setNewDir] = useState<string | null>(null);
	const [confirmDel, setConfirmDel] = useState<WorkspaceEntryDTO | null>(null);
	const [published, setPublished] = useState<FileVersionRefDTO>();
	const input = useRef<HTMLInputElement>(null);
	const entries = files.data?.entries ?? [];
	const tree = useMemo(() => buildTree(entries), [entries]);
	const canWrite = files.data?.canWrite ?? false;
	const u = files.data?.usage;
	const pct = u ? Math.min(100, Math.round((u.spaceBytes / Math.max(1, u.quotaBytes)) * 100)) : 0;

	const reveal = (dir: string) => setExpanded((s) => new Set([...s, ...dir.split("/").filter(Boolean).map((_, i, a) => a.slice(0, i + 1).join("/"))]));
	const run = async (fn: () => Promise<unknown>, ok: string) => {
		setBusy(true);
		setNote(undefined);
		try {
			await fn();
			setNote({ tone: "ok", text: ok });
			files.reload();
		} catch (e) {
			setNote({ tone: "err", text: errorText(e) });
		} finally {
			setBusy(false);
		}
	};
	const targetDir = sel ? (sel.kind === "directory" ? sel.path : parentOf(sel.path)) : "";
	const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
	const select = (e: WorkspaceEntryDTO) => (setSel({ path: e.path, kind: e.kind }), setPublished(undefined));
	const publish = (e: WorkspaceEntryDTO) =>
		void run(async () => {
			const r = await post<{ version: FileVersionRefDTO }>(`${base(spaceId)}/publish`, { conversationId, path: e.path });
			select(e);
			setPublished(r.version);
		}, "已发布到文件库");

	return (
		<div data-testid="files-tab" className="space-y-3">
			<LoadState state={files} what="工作区文件">
				{u ? (
					<div data-testid="ws-usage" className="flex items-center gap-2 text-xs text-fg-muted">
						<span className="shrink-0">
							{u.fileCount} 个文件 · 已用 {formatBytes(u.spaceBytes)} / {formatBytes(u.quotaBytes)}
						</span>
						<div role="progressbar" aria-label="工作区用量" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-border">
							<div className={cn("h-full rounded-full", pct >= 90 ? "bg-danger" : pct >= 70 ? "bg-warning" : "bg-success")} style={{ width: `${Math.max(2, pct)}%` }} />
						</div>
						<InfoPop label="清理规则" testid="ws-rules">
							<span data-testid="ws-lifecycle">
								文件最后修改后闲置 {u.retentionHours} 小时会被自动清理。需要长期保留的成果请「发布到文件库」。单个文件上限 {formatBytes(u.maxFileBytes)}。
							</span>
						</InfoPop>
					</div>
				) : null}

				<div className="flex flex-wrap items-center gap-1.5">
					<input
						ref={input}
						type="file"
						multiple
						className="hidden"
						data-testid="ws-upload-input"
						onChange={(e) => {
							const list = [...(e.target.files ?? [])];
							e.target.value = "";
							if (!list.length) return;
							void run(async () => {
								for (const f of list) await uploadFile(spaceId, conversationId, join(targetDir, f.name), f);
								reveal(targetDir);
							}, `已上传 ${list.length} 个文件${targetDir ? `到「${targetDir}」` : ""}`);
						}}
					/>
					<Button size="sm" disabled={!canWrite || busy} data-testid="ws-upload" title={canWrite ? undefined : "查看者不能上传"} onClick={() => input.current?.click()}>
						<FileUp />
						上传
					</Button>
					<Tip label="新建文件夹">
						<Button size="sm" aria-label="新建文件夹" disabled={!canWrite || busy} data-testid="ws-mkdir" title={canWrite ? undefined : "查看者不能新建"} onClick={() => setNewDir(newDir === null ? "" : null)}>
							<FolderPlus />
						</Button>
					</Tip>
					<Tip label="刷新">
						<Button size="sm" variant="ghost" aria-label="刷新" data-testid="ws-refresh" onClick={files.reload}>
							<RefreshCw />
						</Button>
					</Tip>
					<span className="flex-1" />
					{!canWrite ? <Badge data-testid="ws-readonly">只读</Badge> : null}
					{files.data?.truncated ? <Badge tone="warning">仅显示前 {entries.length} 项</Badge> : null}
				</div>
				{targetDir ? <p className="text-xs text-fg-muted">新文件会放进「{targetDir}」</p> : null}
				{newDir !== null ? (
					<form
						className="flex items-center gap-1.5"
						onSubmit={(e) => {
							e.preventDefault();
							const name = newDir.trim();
							if (!name) return;
							void run(async () => {
								await post(`${base(spaceId)}/mkdir`, { conversationId, path: join(targetDir, name) });
								setNewDir(null);
								reveal(targetDir);
							}, `已创建文件夹 ${join(targetDir, name)}`);
						}}
					>
						<Input autoFocus data-testid="ws-mkdir-name" aria-label="文件夹名称" value={newDir} onChange={(e) => setNewDir(e.target.value)} placeholder="文件夹名称" className="h-8 text-[13px]" />
						<Button size="sm" variant="primary" type="submit" disabled={busy || !newDir.trim()} data-testid="ws-mkdir-ok">
							创建
						</Button>
					</form>
				) : null}
				{note ? (
					<p role="status" data-testid="ws-note" className={cn("text-[13px]", note.tone === "err" ? "text-danger" : "text-success")}>
						{note.text}
					</p>
				) : null}

				{entries.length === 0 ? (
					<Notice icon={<UploadCloud />} title="工作区还是空的" testid="ws-empty">
						助手生成的文件和你上传的文件会出现在这里。
					</Notice>
				) : (
					<ul data-testid="ws-tree" role="tree" aria-label="工作区文件" className="wr-scroll max-h-72 overflow-auto rounded-xl border border-border py-1 text-sm">
						<TreeRows
							nodes={tree}
							depth={0}
							expanded={expanded}
							sel={sel}
							canWrite={canWrite}
							spaceId={spaceId}
							conversationId={conversationId}
							onToggle={(p) => setExpanded((s) => (s.has(p) ? new Set([...s].filter((x) => x !== p)) : new Set(s).add(p)))}
							onSelect={select}
							onPublish={publish}
							onDelete={setConfirmDel}
						/>
					</ul>
				)}

				{sel?.kind === "file" ? (
					<section data-testid="ws-detail" aria-label={`预览 ${nameOf(sel.path)}`} className="overflow-hidden rounded-xl border border-border">
						<div className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-2">
							<FileIcon className="size-3.5 shrink-0 text-fg-muted" />
							<span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={sel.path}>
								{nameOf(sel.path)}
							</span>
						</div>
						{published ? (
							<div className="border-b border-border p-2" data-testid="ws-published">
								<FileCard file={published} />
							</div>
						) : null}
						<Preview spaceId={spaceId} conversationId={conversationId} path={sel.path} />
					</section>
				) : null}
			</LoadState>

			<Dialog open={!!confirmDel} onOpenChange={(o) => !o && setConfirmDel(null)}>
				{confirmDel ? (
					<DialogContent title={`删除「${nameOf(confirmDel.path)}」？`} description={confirmDel.kind === "directory" ? "文件夹和里面的所有文件都会被删除，无法恢复。" : "删除后无法恢复。已发布到文件库的版本不受影响。"} data-testid="ws-delete-dialog">
						<div className="flex justify-end gap-2">
							<Button data-testid="ws-delete-cancel" onClick={() => setConfirmDel(null)}>
								取消
							</Button>
							<Button
								variant="danger"
								disabled={busy}
								data-testid="ws-delete-confirm"
								onClick={() => {
									const e = confirmDel;
									setConfirmDel(null);
									void run(async () => {
										await del(`${base(spaceId)}/file${qs({ path: e.path, conversationId })}`);
										setSel((s) => (s && (s.path === e.path || s.path.startsWith(`${e.path}/`)) ? null : s));
									}, `已删除「${nameOf(e.path)}」`);
								}}
							>
								删除
							</Button>
						</div>
					</DialogContent>
				) : null}
			</Dialog>
		</div>
	);
}

interface RowCtx {
	expanded: Set<string>;
	sel: { path: string } | null;
	canWrite: boolean;
	spaceId: string;
	conversationId: number;
	onToggle: (p: string) => void;
	onSelect: (e: WorkspaceEntryDTO) => void;
	onPublish: (e: WorkspaceEntryDTO) => void;
	onDelete: (e: WorkspaceEntryDTO) => void;
}

function TreeRows({ nodes, depth, ...ctx }: { nodes: Node[]; depth: number } & RowCtx) {
	return (
		<>
			{nodes.map((n) => {
				const dir = n.e.kind === "directory";
				const open = ctx.expanded.has(n.e.path);
				const selected = ctx.sel?.path === n.e.path;
				return (
					<li key={n.e.path} role="treeitem" aria-expanded={dir ? open : undefined} aria-selected={selected}>
						<div className={cn("flex items-center", selected && "bg-surface-2")} style={{ paddingLeft: 4 + depth * 16 }}>
							<button
								type="button"
								data-testid="ws-entry"
								data-path={n.e.path}
								data-kind={n.e.kind}
								onClick={() => (dir && ctx.onToggle(n.e.path), ctx.onSelect(n.e))}
								className="flex min-h-9 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1.5 py-1 text-left hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
							>
								{dir ? open ? <ChevronDown className="size-3.5 shrink-0 text-fg-muted" /> : <ChevronRight className="size-3.5 shrink-0 text-fg-muted" /> : <span className="size-3.5 shrink-0" />}
								{dir ? <Folder className="size-4 shrink-0 text-fg-muted" /> : <FileIcon className="size-4 shrink-0 text-fg-muted" />}
								<span className="min-w-0 flex-1 truncate" title={n.e.path}>
									{nameOf(n.e.path)}
									{n.e.symlink ? " →" : ""}
								</span>
								{!dir ? <span className="shrink-0 text-xs text-fg-muted">{formatBytes(n.e.size)}</span> : null}
							</button>
							<RowMenu e={n.e} {...ctx} />
						</div>
						{dir && open && n.children.length ? (
							<ul role="group">
								<TreeRows nodes={n.children} depth={depth + 1} {...ctx} />
							</ul>
						) : null}
					</li>
				);
			})}
		</>
	);
}

function RowMenu({ e, canWrite, spaceId, conversationId, onPublish, onDelete }: { e: WorkspaceEntryDTO } & RowCtx) {
	const file = e.kind === "file";
	return (
		<Menu>
			<MenuTrigger asChild>
				<button type="button" data-testid="ws-menu" data-path={e.path} aria-label={`${nameOf(e.path)} 的操作`} className="mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-3 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
					<MoreHorizontal className="size-4" />
				</button>
			</MenuTrigger>
			<MenuContent align="end" className="w-44">
				{file ? (
					<MenuItem asChild data-testid="ws-download">
						<a href={`/api${base(spaceId)}/file${qs({ path: e.path, conversationId })}`} aria-label={`下载 ${e.path}`}>
							<Download />
							下载
						</a>
					</MenuItem>
				) : null}
				{file ? (
					<MenuItem disabled={!canWrite} data-testid="ws-publish" onSelect={() => onPublish(e)}>
						<UploadCloud />
						发布到文件库
					</MenuItem>
				) : null}
				<MenuItem disabled={!canWrite} data-testid="ws-delete" className="text-danger [&_svg]:text-danger" onSelect={() => onDelete(e)}>
					<Trash2 />
					删除
				</MenuItem>
			</MenuContent>
		</Menu>
	);
}

function Preview({ spaceId, conversationId, path }: { spaceId: string; conversationId: number; path: string }) {
	const res = useApi<{ preview: WorkspacePreviewDTO }>(`${base(spaceId)}/preview${qs({ path, conversationId })}`);
	const p = res.data?.preview;
	return (
		<div data-testid="ws-preview">
			{res.loading ? (
				<div role="status" className="flex items-center gap-2 px-3 py-4 text-[13px] text-fg-muted">
					<Loader2 className="size-3.5 wr-spin" /> 正在加载预览…
				</div>
			) : res.error ? (
				<p role="alert" className="px-3 py-3 text-[13px] text-danger">
					预览失败：{errorText(res.error)}
				</p>
			) : p ? (
				<>
					<div className="flex flex-wrap gap-x-3 px-3 pt-2 text-xs text-fg-muted">
						<span>{formatBytes(p.size)}</span>
						<span title={fullTime(p.mtime)}>修改于 {relTime(p.mtime)}</span>
						<span title={fullTime(p.expiresAt)}>{relTime(p.expiresAt)}自动清理</span>
					</div>
					{p.kind === "text" ? (
						<>
							<pre data-testid="ws-preview-text" className="wr-scroll m-2 max-h-72 overflow-auto whitespace-pre rounded-lg bg-surface-2 p-2.5 font-mono text-[12.5px] leading-5 text-fg">
								{p.text}
							</pre>
							{p.truncated ? <p className="px-3 pb-2 text-xs text-fg-muted">只显示前 256 KB，完整内容请下载。</p> : null}
						</>
					) : p.kind === "image" ? (
						<div className="p-2">
							<img data-testid="ws-preview-image" alt={p.name} src={`/api${base(spaceId)}/file${qs({ path, conversationId, inline: 1 })}`} className="max-h-72 max-w-full rounded-lg border border-border object-contain" />
						</div>
					) : (
						<p data-testid="ws-preview-binary" className="px-3 py-3 text-[13px] text-fg-muted">
							这种文件无法在这里预览，可以下载查看。
						</p>
					)}
				</>
			) : null}
		</div>
	);
}
