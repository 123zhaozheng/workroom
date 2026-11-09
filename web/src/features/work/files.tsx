// "文件" tab of the work panel: the conversation's persistent workspace (/work) as a tree with preview, download, upload,
// new folder, delete and publish-to-library. Same ACL as the conversation: viewers can browse and download but every write
// control is disabled (the server enforces it too). Lifecycle (idle expiry) and quota are always visible.
import { ChevronDown, ChevronRight, Download, File as FileIcon, FileUp, Folder, FolderOpen, FolderPlus, Loader2, RefreshCw, Trash2, UploadCloud } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { FileVersionRefDTO } from "@shared/files";
import type { WorkspaceEntryDTO, WorkspaceFilesResponse, WorkspacePreviewDTO } from "@shared/sandbox";
import { ApiError, del, errorText, post, qs } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { cn, formatBytes, fullTime, relTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, EmptyState, Loadable } from "@/components/ui/misc";
import { FileCard } from "@/features/chat/Cards";

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
	const [confirmDel, setConfirmDel] = useState(false);
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

	return (
		<div data-testid="files-tab" className="space-y-3">
			<Loadable state={files} what="工作区文件" need="GET /sandbox/:spaceId/files">
				{u ? (
					<div data-testid="ws-usage" className="rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-fg-muted">
						<div className="flex flex-wrap items-center justify-between gap-x-3">
							<span>
								本会话 {formatBytes(u.conversationBytes)} · {u.fileCount} 个文件
							</span>
							<span>
								空间已用 {formatBytes(u.spaceBytes)} / 配额 {formatBytes(u.quotaBytes)}
							</span>
						</div>
						<div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-border">
							<div className={cn("h-full rounded-full", pct >= 90 ? "bg-danger" : pct >= 70 ? "bg-warning" : "bg-success")} style={{ width: `${Math.max(2, pct)}%` }} />
						</div>
						<p className="mt-1.5" data-testid="ws-lifecycle">
							文件在最后修改后闲置 {u.retentionHours} 小时会被自动清理；需要长期保留的成果请「发布到文件库」。单个文件上限 {formatBytes(u.maxFileBytes)}。
						</p>
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
							}, `已上传 ${list.length} 个文件到 /work${targetDir ? `/${targetDir}` : ""}`);
						}}
					/>
					<Button size="sm" disabled={!canWrite || busy} data-testid="ws-upload" title={canWrite ? undefined : "只读：查看者不能上传"} onClick={() => input.current?.click()}>
						<FileUp />
						上传
					</Button>
					<Button size="sm" disabled={!canWrite || busy} data-testid="ws-mkdir" title={canWrite ? undefined : "只读：查看者不能新建"} onClick={() => setNewDir(newDir === null ? "" : null)}>
						<FolderPlus />
						新建文件夹
					</Button>
					<Button size="sm" variant="ghost" data-testid="ws-refresh" onClick={files.reload}>
						<RefreshCw />
						刷新
					</Button>
					<span className="flex-1" />
					{!canWrite ? <Badge data-testid="ws-readonly">只读</Badge> : null}
					{files.data?.truncated ? <Badge tone="warning">仅显示前 {entries.length} 项</Badge> : null}
				</div>
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
						<Input autoFocus data-testid="ws-mkdir-name" value={newDir} onChange={(e) => setNewDir(e.target.value)} placeholder={`文件夹名称（位于 /work${targetDir ? `/${targetDir}` : ""}）`} className="h-8 text-[13px]" />
						<Button size="sm" variant="primary" type="submit" disabled={busy || !newDir.trim()} data-testid="ws-mkdir-ok">
							创建
						</Button>
					</form>
				) : null}
				{note ? (
					<p data-testid="ws-note" className={cn("text-[12.5px]", note.tone === "err" ? "text-danger" : "text-success")}>
						{note.text}
					</p>
				) : null}

				{entries.length === 0 ? (
					<EmptyState icon={<UploadCloud />} title="工作区还是空的">
						助手在沙箱里写出的文件、你上传的数据都会出现在这里。
						{canWrite ? "点击「上传」把文件交给助手处理。" : ""}
					</EmptyState>
				) : (
					<ul data-testid="ws-tree" className="max-h-72 overflow-auto rounded-lg border border-border py-1 text-[12.5px]">
						<TreeRows nodes={tree} depth={0} expanded={expanded} sel={sel} onToggle={(p) => setExpanded((s) => (s.has(p) ? new Set([...s].filter((x) => x !== p)) : new Set(s).add(p)))} onSelect={(e) => (setSel({ path: e.path, kind: e.kind }), setConfirmDel(false), setPublished(undefined))} />
					</ul>
				)}

				{sel ? (
					<section data-testid="ws-detail" className="rounded-lg border border-border">
						<div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface-2 px-2.5 py-1.5">
							{sel.kind === "directory" ? <FolderOpen className="size-3.5 text-fg-muted" /> : <FileIcon className="size-3.5 text-fg-muted" />}
							<span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={`/work/${sel.path}`}>
								/work/{sel.path}
							</span>
							{sel.kind === "file" ? (
								<>
									<a data-testid="ws-download" aria-label={`下载 ${sel.path}`} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] text-fg-muted hover:bg-surface hover:text-fg" href={`/api${base(spaceId)}/file${qs({ path: sel.path, conversationId })}`}>
										<Download className="size-3.5" />
										下载
									</a>
									<Button
										size="sm"
										variant="ghost"
										disabled={!canWrite || busy}
										data-testid="ws-publish"
										title={canWrite ? "复制为文件库中的不可变版本，不随工作区清理" : "只读：查看者不能发布"}
										onClick={() =>
											void run(async () => {
												const r = await post<{ version: FileVersionRefDTO }>(`${base(spaceId)}/publish`, { conversationId, path: sel.path });
												setPublished(r.version);
											}, "已发布到文件库")
										}
									>
										<UploadCloud />
										发布到文件库
									</Button>
								</>
							) : null}
							{confirmDel ? (
								<>
									<Button size="sm" variant="danger" disabled={busy} data-testid="ws-delete-confirm" onClick={() => void run(async () => (await del(`${base(spaceId)}/file${qs({ path: sel.path, conversationId })}`), setSel(null), setConfirmDel(false)), `已删除 /work/${sel.path}`)}>
										确认删除
									</Button>
									<Button size="sm" variant="ghost" onClick={() => setConfirmDel(false)}>
										取消
									</Button>
								</>
							) : (
								<Button size="sm" variant="ghost" disabled={!canWrite || busy} data-testid="ws-delete" title={canWrite ? undefined : "只读：查看者不能删除"} onClick={() => setConfirmDel(true)}>
									<Trash2 />
									删除
								</Button>
							)}
						</div>
						{published ? (
							<div className="border-b border-border p-2" data-testid="ws-published">
								<FileCard file={published} />
							</div>
						) : null}
						{sel.kind === "file" ? <Preview spaceId={spaceId} conversationId={conversationId} path={sel.path} /> : <p className="px-3 py-2 text-[12.5px] text-fg-muted">目录。上传与新建会放进这个文件夹。</p>}
					</section>
				) : null}
			</Loadable>
		</div>
	);
}

function TreeRows({ nodes, depth, expanded, sel, onToggle, onSelect }: { nodes: Node[]; depth: number; expanded: Set<string>; sel: { path: string } | null; onToggle: (p: string) => void; onSelect: (e: WorkspaceEntryDTO) => void }) {
	return (
		<>
			{nodes.map((n) => {
				const dir = n.e.kind === "directory";
				const open = expanded.has(n.e.path);
				return (
					<li key={n.e.path}>
						<div
							role="button"
							tabIndex={0}
							data-testid="ws-entry"
							data-path={n.e.path}
							data-kind={n.e.kind}
							aria-selected={sel?.path === n.e.path}
							onClick={() => (dir && onToggle(n.e.path), onSelect(n.e))}
							onKeyDown={(ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), dir && onToggle(n.e.path), onSelect(n.e))}
							className={cn("flex cursor-pointer items-center gap-1.5 px-2 py-1 hover:bg-surface-2", sel?.path === n.e.path && "bg-surface-2")}
							style={{ paddingLeft: 8 + depth * 14 }}
						>
							{dir ? open ? <ChevronDown className="size-3.5 shrink-0 text-fg-subtle" /> : <ChevronRight className="size-3.5 shrink-0 text-fg-subtle" /> : <span className="size-3.5 shrink-0" />}
							{dir ? <Folder className="size-3.5 shrink-0 text-fg-muted" /> : <FileIcon className="size-3.5 shrink-0 text-fg-muted" />}
							<span className={cn("min-w-0 flex-1 truncate font-mono", dir && "text-fg-muted")} title={n.e.path}>
								{nameOf(n.e.path)}
								{n.e.symlink ? " →" : ""}
							</span>
							{!dir ? <span className="shrink-0 text-fg-subtle">{formatBytes(n.e.size)}</span> : null}
						</div>
						{dir && open && n.children.length ? (
							<ul>
								<TreeRows nodes={n.children} depth={depth + 1} expanded={expanded} sel={sel} onToggle={onToggle} onSelect={onSelect} />
							</ul>
						) : null}
					</li>
				);
			})}
		</>
	);
}

function Preview({ spaceId, conversationId, path }: { spaceId: string; conversationId: number; path: string }) {
	const res = useApi<{ preview: WorkspacePreviewDTO }>(`${base(spaceId)}/preview${qs({ path, conversationId })}`);
	const p = res.data?.preview;
	return (
		<div data-testid="ws-preview">
			{res.loading ? (
				<div className="flex items-center gap-2 px-3 py-4 text-[12.5px] text-fg-subtle">
					<Loader2 className="size-3.5 wr-spin" /> 加载预览…
				</div>
			) : res.error ? (
				<p className="px-3 py-3 text-[12.5px] text-danger">{errorText(res.error)}</p>
			) : p ? (
				<>
					<div className="flex flex-wrap gap-x-3 px-3 pt-2 text-[11.5px] text-fg-subtle">
						<span>{formatBytes(p.size)}</span>
						<span>修改于 {fullTime(p.mtime)}</span>
						<span title={fullTime(p.expiresAt)}>闲置到期 {relTime(p.expiresAt)}</span>
					</div>
					{p.kind === "text" ? (
						<>
							<pre data-testid="ws-preview-text" className="m-2 max-h-72 overflow-auto whitespace-pre rounded-md bg-surface-2 p-2.5 font-mono text-[12px] leading-5 text-fg">
								{p.text}
							</pre>
							{p.truncated ? <p className="px-3 pb-2 text-[11.5px] text-fg-subtle">只显示前 256 KB，完整内容请下载。</p> : null}
						</>
					) : p.kind === "image" ? (
						<div className="p-2">
							<img data-testid="ws-preview-image" alt={p.name} src={`/api${base(spaceId)}/file${qs({ path, conversationId, inline: 1 })}`} className="max-h-72 max-w-full rounded-md border border-border object-contain" />
						</div>
					) : (
						<p data-testid="ws-preview-binary" className="px-3 py-3 text-[12.5px] text-fg-muted">
							二进制文件（{p.mime}），无法在这里预览。请下载，或让助手处理后发布。
						</p>
					)}
				</>
			) : null}
		</div>
	);
}
