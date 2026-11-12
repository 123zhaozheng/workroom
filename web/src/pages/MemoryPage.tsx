// Memory page (round 14): the long-term memory IS a set of Markdown files. This page reads and writes the same files the agent maintains
// (GET/PUT/DELETE /api/memory/file, If-Match = the etag we last read, so an agent edit made meanwhile is never overwritten silently).
import { Brain, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { MemoryFileContentDTO, MemoryFileDTO, MemoryScopeDTO } from "@shared/knowledge";
import { api, del, errorText, get, post, qs } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { fullTime, relTime } from "@/lib/utils";
import { TopBar } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { EmptyState, Loadable, Page, PageHeader } from "@/components/ui/misc";
import { Markdown } from "@/features/markdown/Markdown";

const INDEX = "MEMORY.md";
const fileName = (f: MemoryFileDTO) => (f.path === INDEX ? "索引 MEMORY.md" : f.path);

export default function MemoryPage() {
	const scopes = useApi<{ scopes: MemoryScopeDTO[] }>("/memory/scopes");
	const [scope, setScope] = useState("personal");
	const list = useApi<{ files: MemoryFileDTO[] }>(`/memory/files${qs({ scope })}`);
	const [path, setPath] = useState<string>();
	const files = list.data?.files ?? [];
	const cur = scopes.data?.scopes.find((s) => s.id === scope);
	// default selection: the index (when it exists), else the first file
	useEffect(() => {
		if (!list.data) return;
		if (path && files.some((f) => f.path === path)) return;
		setPath((files.find((f) => f.path === INDEX) ?? files[0])?.path);
	}, [list.data, scope]); // eslint-disable-line react-hooks/exhaustive-deps
	const [creating, setCreating] = useState(false);
	const [title, setTitle] = useState("");
	const [err, setErr] = useState<string>();
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page wide>
					<PageHeader title="记忆" />
					<Loadable state={scopes} what="记忆" need="GET /api/memory/scopes">
						<div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="记忆范围">
							{(scopes.data?.scopes ?? []).map((s) => (
								<button
									key={s.id}
									role="tab"
									aria-selected={s.id === scope}
									data-testid="memory-scope"
									onClick={() => {
										setScope(s.id);
										setPath(undefined);
										setCreating(false);
										setErr(undefined);
									}}
									className={`rounded-full border px-3 py-1 text-[13px] ${s.id === scope ? "border-fg bg-surface-2 text-fg" : "border-border text-fg-muted hover:bg-surface-2"}`}
								>
									{s.label}
								</button>
							))}
						</div>
						<div className="grid gap-4 md:grid-cols-[240px_1fr]">
							<aside>
								<Loadable state={list} what="记忆文件">
									{files.length === 0 ? <EmptyState icon={<Brain />} title="还没有记忆文件" /> : null}
									<ul className="space-y-0.5" data-testid="memory-files">
										{files.map((f) => (
											<li key={f.path}>
												<button
													onClick={() => setPath(f.path)}
													data-testid="memory-file"
													className={`w-full rounded-lg px-2.5 py-1.5 text-left text-[13px] ${f.path === path ? "bg-surface-2 text-fg" : "text-fg-muted hover:bg-surface-2"}`}
												>
													<div className="truncate">{fileName(f)}</div>
													<div className="text-xs text-fg-subtle" title={fullTime(f.mtime)}>
														{relTime(f.mtime)}
													</div>
												</button>
											</li>
										))}
									</ul>
								</Loadable>
								{cur?.writable ? (
									creating ? (
										<form
											className="mt-2 flex gap-1.5"
											onSubmit={async (e) => {
												e.preventDefault();
												setErr(undefined);
												try {
													const r = await post<{ file: MemoryFileDTO }>("/memory/topics", { scope, title });
													setCreating(false);
													setTitle("");
													setPath(r.file.path);
													list.reload();
												} catch (x) {
													setErr(errorText(x));
												}
											}}
										>
											<Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="主题名称" aria-label="主题名称" className="h-8 text-[13px]" autoFocus />
											<Button type="submit" size="sm" variant="primary" disabled={!title.trim()}>
												创建
											</Button>
										</form>
									) : (
										<Button size="sm" variant="ghost" className="mt-2" onClick={() => setCreating(true)} data-testid="memory-new">
											<Plus />
											新建主题
										</Button>
									)
								) : null}
								{err ? <p className="mt-1 text-[13px] text-danger">{err}</p> : null}
							</aside>
							<section className="min-w-0">
								{path ? (
									<FileView
										key={`${scope}:${path}`}
										scope={scope}
										path={path}
										onChanged={list.reload}
										onDeleted={() => {
											setPath(undefined);
											list.reload();
										}}
									/>
								) : null}
							</section>
						</div>
					</Loadable>
				</Page>
			</div>
		</div>
	);
}

function FileView({ scope, path, onChanged, onDeleted }: { scope: string; path: string; onChanged: () => void; onDeleted: () => void }) {
	const [data, setData] = useState<MemoryFileContentDTO>();
	const [text, setText] = useState("");
	const [editing, setEditing] = useState(false);
	const [err, setErr] = useState<string>();
	const [conflict, setConflict] = useState(false);
	const q = qs({ scope, path });
	const load = async () => {
		try {
			const d = await get<MemoryFileContentDTO>(`/memory/file${q}`);
			setData(d);
			setText(d.content);
			setErr(undefined);
			setConflict(false);
		} catch (e) {
			setErr(errorText(e));
		}
	};
	useEffect(() => {
		void load();
	}, [scope, path]); // eslint-disable-line react-hooks/exhaustive-deps
	if (!data) return err ? <p className="text-[13px] text-danger">{err}</p> : null;
	return (
		<div data-testid="memory-view">
			<div className="mb-2 flex items-center gap-2 text-xs text-fg-subtle">
				<span className="font-medium text-fg">{path}</span>
				<span data-testid="memory-mtime">最后修改 {fullTime(data.file.mtime)}</span>
				<span className="flex-1" />
				{data.writable && !editing ? (
					<button aria-label="编辑" data-testid="memory-edit" onClick={() => setEditing(true)} className="rounded p-1 hover:bg-surface-2 hover:text-fg">
						<Pencil className="size-3.5" />
					</button>
				) : null}
				{data.writable ? (
					<button
						aria-label="删除"
						data-testid="memory-delete"
						onClick={async () => {
							if (!confirm(`删除 ${path}？${path === INDEX ? "" : "索引中对应的链接也会一并移除。"}`)) return;
							try {
								await del(`/memory/file${q}`);
								onDeleted();
							} catch (e) {
								setErr(errorText(e));
							}
						}}
						className="rounded p-1 hover:bg-surface-2 hover:text-danger"
					>
						<Trash2 className="size-3.5" />
					</button>
				) : null}
			</div>
			{editing ? (
				<>
					<Textarea value={text} onChange={(e) => setText(e.target.value)} rows={18} className="font-mono text-[13px]" aria-label="记忆内容" data-testid="memory-text" />
					<div className="mt-2 flex items-center justify-end gap-2">
						{conflict ? (
							<Button size="sm" variant="ghost" data-testid="memory-reload" onClick={() => void load()}>
								重新载入最新内容
							</Button>
						) : null}
						<Button
							size="sm"
							variant="ghost"
							onClick={() => {
								setText(data.content);
								setEditing(false);
								setErr(undefined);
								setConflict(false);
							}}
						>
							取消
						</Button>
						<Button
							size="sm"
							variant="primary"
							data-testid="memory-save"
							disabled={text === data.content}
							onClick={async () => {
								try {
									const r = await api<{ file: MemoryFileDTO }>(`/memory/file${q}`, { method: "PUT", headers: { "If-Match": data.file.etag }, body: { content: text } });
									setData({ ...data, file: r.file, content: text });
									setEditing(false);
									setErr(undefined);
									setConflict(false);
									onChanged();
								} catch (e) {
									setErr(errorText(e));
									setConflict((e as { code?: string }).code === "memory_conflict");
								}
							}}
						>
							保存
						</Button>
					</div>
				</>
			) : data.file.markdown ? (
				<Markdown text={data.content} document />
			) : (
				<pre className="whitespace-pre-wrap text-[13px]">{data.content}</pre>
			)}
			{err ? (
				<p className="mt-2 text-[13px] text-danger" data-testid="memory-error">
					{err}
				</p>
			) : null}
		</div>
	);
}
