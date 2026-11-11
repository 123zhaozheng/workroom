import { ArrowLeft, BookPlus, Download, Link2, Upload, X } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { FileDetailResponse, FileUploadResponse, FileVersionDTO } from "@shared/files";
import type { FileKnowledgeStatus, KbSummary } from "@shared/knowledge";
import { errorText, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { cn, formatBytes, fullTime, relTime } from "@/lib/utils";
import { TopBar } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { Badge, Page, Spinner } from "@/components/ui/misc";
import { LoadState } from "@/features/work/states";
import type { ConversationDetailResponse } from "@shared/chat";
import { fileIcon } from "@/features/chat/Cards";
import { listOf } from "@/features/chat/pickers";
import { ORIGIN } from "@/features/files/origin";
import { ShareDialog } from "@/features/share/Share";
import { AVAILABILITY } from "./KnowledgePage";

const PreviewViewer = lazy(() => import("@/features/preview/PreviewPanel").then((m) => ({ default: m.Viewer })));

/** `/files/:fileId` as its own page (phones). Wide screens show FileDetailView inside 文件库 instead. */
export default function FileDetailPage() {
	const { fileId } = useParams();
	return <FileDetailView key={fileId} fileId={fileId!} />;
}

/**
 * One file: preview, versions, provenance, knowledge status, share / download / new version. `embedded` = the detail column of the
 * two-column 文件库 (no top bar of its own, one column, a close button); otherwise a full page with a way back to the list.
 * `onChanged` tells the list that this file changed (a new version).
 */
export function FileDetailView({ fileId, embedded, onClose, onChanged }: { fileId: string; embedded?: boolean; onClose?: () => void; onChanged?: () => void }) {
	const [sp, setSp] = useSearchParams();
	const res = useApi<FileDetailResponse>(`/files/${encodeURIComponent(fileId)}`);
	const kstatus = useApi<FileKnowledgeStatus>(`/kb/files/${encodeURIComponent(fileId)}/status`, { pollMs: 4000 });
	const [newVersion, setNewVersion] = useState(false);
	const [addKb, setAddKb] = useState(false);
	const [share, setShare] = useState(false);
	const file = res.data?.file;
	const versions = res.data?.versions ?? [];
	const sel = versions.find((v) => v.versionId === sp.get("v")) ?? versions[0];
	const Icon = fileIcon(file?.name ?? "", file?.mime);
	// keep the other query parameters (the library's space filter) when switching versions
	const pickVersion = (versionId: string) =>
		setSp((p) => {
			const n = new URLSearchParams(p);
			n.set("v", versionId);
			return n;
		});

	const content = (
					<LoadState state={res} what="文件">
						{file && sel ? (
							<>
								<div className="mb-6 flex flex-wrap items-start gap-x-3 gap-y-4">
									<span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-fg-muted">
										<Icon className="size-5" />
									</span>
									<div className="min-w-0 flex-1 basis-60">
										<h1 data-testid="file-title" className="break-words text-xl font-semibold tracking-tight">
											{file.name}
										</h1>
										<p className="mt-1 text-sm text-fg-muted">
											存储：已保存 · {versions.length} 个版本 · {ORIGIN[file.origin].label}
										</p>
										<div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm" data-testid="knowledge-status">
											<span className="text-fg-muted">知识库：</span>
											{kstatus.unavailable ? (
												<span className="text-fg-muted">暂时无法获取</span>
											) : (kstatus.data?.entries ?? []).length === 0 ? (
												<span className="text-fg-muted">未加入</span>
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
									<div className="flex w-full flex-wrap gap-2 sm:w-auto">
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

								<div className={cn("grid gap-5", !embedded && "lg:grid-cols-[minmax(0,1fr)_320px]")}>
									<div className={cn("h-[60vh] min-h-[320px] overflow-hidden rounded-xl border border-border bg-surface", embedded ? "lg:h-[56vh]" : "lg:h-[70vh]")} data-testid="file-preview">
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
									<aside className="min-w-0">
										<h2 className="mb-3 text-sm font-medium">版本</h2>
										<ol className="space-y-3" data-testid="version-list">
											{versions.map((v) => (
												<VersionItem key={v.versionId} v={v} selected={v.versionId === sel.versionId} latest={v.versionNo === file.latestVersionNo} onSelect={() => pickVersion(v.versionId)} />
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
										onChanged?.(); // the library list shows the latest version number and time
										pickVersion(v.versionId);
									}}
								/>
								<ShareDialog open={share} onOpenChange={setShare} kind="file" id={file.id} title={file.name} />
								<AddToKbDialog open={addKb} onOpenChange={setAddKb} fileId={file.id} version={sel} onDone={() => kstatus.reload()} />
							</>
						) : null}
					</LoadState>
	);

	if (embedded)
		return (
			<div data-testid="file-detail" data-embedded="true" className="px-5 pb-12 pt-4 lg:px-6">
				{onClose ? (
					<div className="mb-2 flex justify-end">
						<button type="button" onClick={onClose} aria-label="关闭详情" data-testid="file-detail-close" className="inline-flex size-8 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
							<X className="size-4" />
						</button>
					</div>
				) : null}
				{content}
			</div>
		);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar>
				<Link to="/files" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg">
					<ArrowLeft className="size-4" />
					文件库
				</Link>
			</TopBar>
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page wide>{content}</Page>
			</div>
		</div>
	);
}

function useConvTitle(spaceId: string, conversationId: number | undefined) {
	const r = useApi<ConversationDetailResponse>(conversationId === undefined ? null : `/conversations/${spaceId}/${conversationId}`);
	return r.data?.conversation.title;
}

/** "由 对话「…」生成 · 引用 2 个文件" — plain words, no run / task / version ids. */
function Provenance({ v }: { v: FileVersionDTO }) {
	const p = v.provenance;
	const title = useConvTitle(p.spaceId, p.conversationId);
	const inputs = p.inputVersionIds?.length ?? 0;
	const refs = inputs ? ` · 引用 ${inputs} 个文件` : "";
	const convLink =
		p.conversationId !== undefined ? (
			<Link to={`/c/${p.spaceId}/${p.conversationId}`} className="text-info hover:underline">
				对话「{title?.trim() || "未命名对话"}」
			</Link>
		) : null;
	return (
		<p data-testid="provenance" className="mt-1 text-sm text-fg-muted">
			{p.origin === "upload" ? (
				<>由 {p.createdByName ?? "成员"} 上传</>
			) : (
				<>
					由 {convLink ?? (p.origin === "automation" ? "自动化" : "助手")}
					{convLink && p.origin === "automation" ? "（自动化）" : ""}生成
				</>
			)}
			{refs}
		</p>
	);
}

function VersionItem({ v, selected, latest, onSelect }: { v: FileVersionDTO; selected: boolean; latest: boolean; onSelect: () => void }) {
	return (
		<li data-testid="version-item" aria-current={selected ? "true" : undefined} className="relative pl-6 before:absolute before:bottom-[-12px] before:left-[7px] before:top-3 before:w-px before:bg-border last:before:hidden">
			<span aria-hidden className={cn("absolute left-0 top-3 size-[15px] rounded-full border-2", selected ? "border-fg bg-fg" : "border-border-strong bg-bg")} />
			<div className={cn("rounded-xl border p-3 text-sm", selected ? "border-border-strong bg-surface" : "border-border")}>
				<div className="flex items-center gap-1">
					<button onClick={onSelect} className="-m-1 flex min-w-0 flex-1 items-center gap-2 rounded-lg p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
						<span className="font-medium">v{v.versionNo}</span>
						{latest ? <Badge tone="info">最新</Badge> : null}
						<span className="min-w-0 flex-1 truncate text-xs text-fg-muted" title={fullTime(v.createdAt)}>
							{relTime(v.createdAt)} · {formatBytes(v.size)}
						</span>
					</button>
					<a href={`/api${v.downloadUrl.replace(/^\/api/, "")}`} aria-label={`下载 v${v.versionNo}`} title="下载此版本" className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
						<Download className="size-4" />
					</a>
				</div>
				{v.changeNote ? <p className="mt-1.5 break-words text-fg">{v.changeNote}</p> : null}
				<Provenance v={v} />
			</div>
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
			<DialogContent title="上传新版本">
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
					<input ref={input} type="file" required className="block w-full text-sm" />
					<div>
						<Label htmlFor="note">变更说明</Label>
						<Input id="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="这一版改了什么" required />
					</div>
					{err ? <p className="text-sm text-danger">{err}</p> : null}
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
					<p className="text-sm text-fg-muted">知识库暂时无法使用，请稍后重试。</p>
				</DialogContent>
			</Dialog>
		);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title="加入知识库">
				<LoadState state={kbs} what="知识库">
					{list.length === 0 ? (
						<p className="text-sm text-fg-muted">
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
							{msg ? <p className="text-sm text-fg-muted">{msg}</p> : null}
							<div className="flex justify-end">
								<Button
									variant="primary"
									disabled={!kbId || busy}
									onClick={async () => {
										setBusy(true);
										setMsg(undefined);
										try {
											await post(`/kb/${encodeURIComponent(kbId)}/docs`, { fileId, versionId: version.versionId });
											setMsg("已加入，正在索引");
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
				</LoadState>
			</DialogContent>
		</Dialog>
	);
}
