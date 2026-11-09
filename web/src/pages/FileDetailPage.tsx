import { ArrowLeft, BookPlus, Download, GitCommitVertical, Link2, MessageSquare, Upload } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { FileDetailResponse, FileUploadResponse, FileVersionDTO } from "@shared/files";
import type { FileKnowledgeStatus, KbSummary } from "@shared/knowledge";
import { errorText, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { cn, formatBytes, fullTime } from "@/lib/utils";
import { TopBar } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { Badge, Loadable, Page, Spinner, Unavailable } from "@/components/ui/misc";
import { fileIcon } from "@/features/chat/Cards";
import { listOf } from "@/features/chat/pickers";
import { ORIGIN } from "./FilesPage";
import { ShareDialog } from "@/features/share/Share";
import { AVAILABILITY } from "./KnowledgePage";

const PreviewViewer = lazy(() => import("@/features/preview/PreviewPanel").then((m) => ({ default: m.Viewer })));

export default function FileDetailPage() {
	const { fileId } = useParams();
	const [sp, setSp] = useSearchParams();
	const res = useApi<FileDetailResponse>(`/files/${encodeURIComponent(fileId!)}`);
	const kstatus = useApi<FileKnowledgeStatus>(`/kb/files/${encodeURIComponent(fileId!)}/status`, { pollMs: 4000 });
	const [newVersion, setNewVersion] = useState(false);
	const [addKb, setAddKb] = useState(false);
	const [share, setShare] = useState(false);
	const file = res.data?.file;
	const versions = res.data?.versions ?? [];
	const sel = versions.find((v) => v.versionId === sp.get("v")) ?? versions[0];
	const Icon = fileIcon(file?.name ?? "", file?.mime);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar>
				<Link to="/files" className="inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-fg">
					<ArrowLeft className="size-4" />
					文件库
				</Link>
			</TopBar>
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page wide>
					<Loadable state={res} what="文件" need="D 组：GET /api/files/:id">
						{file && sel ? (
							<>
								<div className="mb-6 flex flex-wrap items-start gap-3">
									<span className="flex size-10 items-center justify-center rounded-xl bg-surface-2 text-fg-muted">
										<Icon className="size-5" />
									</span>
									<div className="min-w-0 flex-1">
										<h1 data-testid="file-title" className="truncate text-xl font-semibold tracking-tight">
											{file.name}
										</h1>
										<div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-fg-muted">
											<Badge>{ORIGIN[file.origin].label}</Badge>
											<span>存储：已保存 {versions.length} 个版本，最新 v{file.latestVersionNo}</span>
										</div>
										<div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[13px]" data-testid="knowledge-status">
											<span className="text-fg-muted">知识：</span>
											{kstatus.unavailable ? (
												<span className="text-fg-subtle">知识状态接口未连接</span>
											) : (kstatus.data?.entries ?? []).length === 0 ? (
												<span className="text-fg-subtle">未加入任何知识库（加入是显式操作）</span>
											) : (
												kstatus.data!.entries.map((e) => (
													<Badge key={e.docId} tone={AVAILABILITY[e.availability].tone} title={`最新 v${e.latestVersionNo}：${e.latestStatus}`}>
														{e.kbName} · {AVAILABILITY[e.availability].label}
														{e.servingVersionNo ? ` · 检索使用 v${e.servingVersionNo}` : ""}
													</Badge>
												))
											)}
										</div>
									</div>
									<div className="flex flex-wrap gap-2">
										<Button asChild>
											<a href={`/api${sel.downloadUrl.replace(/^\/api/, "")}`}>
												<Download />
												下载 v{sel.versionNo}
											</a>
										</Button>
										<Button onClick={() => setShare(true)}>
											<Link2 />
											分享
										</Button>
										<Button onClick={() => setAddKb(true)}>
											<BookPlus />
											加入知识库
										</Button>
										{file.canWrite ? (
											<Button variant="primary" onClick={() => setNewVersion(true)}>
												<Upload />
												上传新版本
											</Button>
										) : null}
									</div>
								</div>

								<div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
									<div className="h-[70vh] min-h-[360px] overflow-hidden rounded-xl border border-border bg-surface" data-testid="file-preview">
										<Suspense
											fallback={
												<div className="flex h-full items-center justify-center">
													<Spinner />
												</div>
											}
										>
											<PreviewViewer fileId={file.id} version={sel} />
										</Suspense>
									</div>
									<aside>
										<h2 className="mb-2 text-[13px] font-medium text-fg-muted">版本与来源</h2>
										<ol className="space-y-2" data-testid="version-list">
											{versions.map((v) => (
												<VersionItem key={v.versionId} v={v} selected={v.versionId === sel.versionId} latest={v.versionNo === file.latestVersionNo} onSelect={() => setSp({ v: v.versionId })} />
											))}
										</ol>
									</aside>
								</div>
								<NewVersionDialog
									open={newVersion}
									onOpenChange={setNewVersion}
									fileId={file.id}
									onDone={(v) => {
										res.reload();
										setSp({ v: v.versionId });
									}}
								/>
								<ShareDialog open={share} onOpenChange={setShare} kind="file" id={file.id} title={file.name} />
								<AddToKbDialog open={addKb} onOpenChange={setAddKb} fileId={file.id} version={sel} onDone={() => kstatus.reload()} />
							</>
						) : null}
					</Loadable>
				</Page>
			</div>
		</div>
	);
}

function VersionItem({ v, selected, latest, onSelect }: { v: FileVersionDTO; selected: boolean; latest: boolean; onSelect: () => void }) {
	const p = v.provenance;
	return (
		<li data-testid="version-item" className={cn("rounded-xl border p-3 text-[12.5px]", selected ? "border-border-strong bg-surface" : "border-border")}>
			<button onClick={onSelect} className="flex w-full items-center gap-2 text-left">
				<GitCommitVertical className="size-4 text-fg-muted" />
				<span className="text-sm font-medium">v{v.versionNo}</span>
				{latest ? <Badge tone="info">最新</Badge> : null}
				<span className="flex-1" />
				<span className="text-fg-subtle">{formatBytes(v.size)}</span>
			</button>
			{v.changeNote ? <p className="mt-1.5 text-fg">变更说明：{v.changeNote}</p> : null}
			<dl className="mt-1.5 grid grid-cols-[64px_1fr] gap-x-2 gap-y-0.5 text-fg-muted">
				<dt className="text-fg-subtle">创建者</dt>
				<dd className="truncate">{p.createdByName ?? p.createdBy}</dd>
				<dt className="text-fg-subtle">生成时间</dt>
				<dd>{fullTime(v.createdAt)}</dd>
				<dt className="text-fg-subtle">来源</dt>
				<dd>
					{ORIGIN[p.origin].label}
					{p.tool ? ` · 工具 ${p.tool}` : ""}
				</dd>
				{p.conversationId !== undefined ? (
					<>
						<dt className="text-fg-subtle">来源任务</dt>
						<dd>
							<Link to={`/c/${p.spaceId}/${p.conversationId}`} className="inline-flex items-center gap-1 text-info hover:underline">
								<MessageSquare className="size-3" />
								对话 {p.conversationId}
							</Link>
							{p.taskId !== undefined ? ` · run ${p.taskId}` : ""}
							{p.submissionId !== undefined ? ` · 提交 ${p.submissionId}` : ""}
						</dd>
					</>
				) : null}
				{p.inputVersionIds?.length ? (
					<>
						<dt className="text-fg-subtle">输入资料</dt>
						<dd className="break-all">{p.inputVersionIds.length} 份（{p.inputVersionIds.map((x) => x.slice(0, 10)).join("、")}）</dd>
					</>
				) : null}
			</dl>
			<a href={`/api${v.downloadUrl.replace(/^\/api/, "")}`} className="mt-2 inline-flex items-center gap-1 text-info hover:underline">
				<Download className="size-3.5" />
				下载此版本
			</a>
		</li>
	);
}

function NewVersionDialog({ open, onOpenChange, fileId, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; fileId: string; onDone: (v: FileVersionDTO) => void }) {
	const input = useRef<HTMLInputElement>(null);
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title="上传新版本" description="旧版本会完整保留，可随时预览、下载或切换回去。">
				<form
					className="space-y-3"
					onSubmit={async (e) => {
						e.preventDefault();
						const f = input.current?.files?.[0];
						if (!f) return;
						setBusy(true);
						setErr(undefined);
						try {
							const fd = new FormData();
							fd.set("file", f);
							fd.set("changeNote", note);
							const r = await post<FileUploadResponse>(`/files/${encodeURIComponent(fileId)}/versions`, fd);
							onOpenChange(false);
							setNote("");
							onDone(r.version);
						} catch (e) {
							setErr(errorText(e));
						} finally {
							setBusy(false);
						}
					}}
				>
					<input ref={input} type="file" required className="block w-full text-[13px]" />
					<div>
						<Label htmlFor="note">变更说明</Label>
						<Input id="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="这一版改了什么" required />
					</div>
					{err ? <p className="text-[13px] text-danger">{err}</p> : null}
					<div className="flex justify-end">
						<Button type="submit" variant="primary" disabled={busy}>
							{busy ? "上传中…" : "保存为新版本"}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function AddToKbDialog({ open, onOpenChange, fileId, version, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; fileId: string; version: FileVersionDTO; onDone: () => void }) {
	const kbs = useApi<unknown>(open ? "/kb" : null);
	const list = listOf<KbSummary>(kbs.data, "kbs", "knowledgeBases").filter((k) => k.permissions.write);
	const [kbId, setKbId] = useState("");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string>();
	if (kbs.unavailable && open)
		return (
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent title="加入知识库">
					<Unavailable what="知识库" need="C 组：GET/POST /api/kb" compact />
				</DialogContent>
			</Dialog>
		);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title="加入知识库" description={`将 v${version.versionNo} 加入知识库。加入后需要解析和索引，完成前不会参与回答。`}>
				<Loadable state={kbs} what="知识库">
					{list.length === 0 ? (
						<p className="text-[13px] text-fg-muted">
							没有可写入的知识库。<Link to="/knowledge" className="text-info hover:underline">去创建</Link>
						</p>
					) : (
						<div className="space-y-3">
							<Select value={kbId} onChange={(e) => setKbId(e.target.value)} className="w-full" aria-label="知识库">
								<option value="">选择知识库</option>
								{list.map((k) => (
									<option key={k.id} value={k.id}>
										{k.name}
									</option>
								))}
							</Select>
							{msg ? <p className="text-[13px] text-fg-muted">{msg}</p> : null}
							<div className="flex justify-end">
								<Button
									variant="primary"
									disabled={!kbId || busy}
									onClick={async () => {
										setBusy(true);
										setMsg(undefined);
										try {
											await post(`/kb/${encodeURIComponent(kbId)}/docs`, { fileId, versionId: version.versionId });
											setMsg("已加入，正在解析与索引（尚不可检索）。");
											onDone();
										} catch (e) {
											setMsg(errorText(e));
										} finally {
											setBusy(false);
										}
									}}
								>
									加入
								</Button>
							</div>
						</div>
					)}
				</Loadable>
			</DialogContent>
		</Dialog>
	);
}
