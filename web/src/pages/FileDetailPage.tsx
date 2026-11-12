import { ArrowLeft, BookPlus, Download, Link2, Trash2, X } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { FileDetailResponse, LibItemDTO } from "@shared/files";
import type { FileKnowledgeStatus, KbSummary } from "@shared/knowledge";
import { del, errorText, get, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { formatBytes, relTime } from "@/lib/utils";
import { TopBar } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { Badge, Page, Spinner } from "@/components/ui/misc";
import { LoadState, Notice } from "@/features/work/states";
import type { ConversationDetailResponse } from "@shared/chat";
import { fileIcon } from "@/features/chat/Cards";
import { listOf } from "@/features/chat/pickers";
import { ConfirmDialog } from "@/features/projects/ConfirmDialog";
import { ShareDialog } from "@/features/share/Share";
import { AVAILABILITY } from "./KnowledgePage";

const PreviewViewer = lazy(() => import("@/features/preview/PreviewPanel").then((m) => ({ default: m.Viewer })));

/** `/files/:fileId` as its own page (phones). Wide screens show FileDetailView inside 文件库 instead. */
export default function FileDetailPage() {
	const { fileId } = useParams();
	return <FileDetailView key={fileId} fileId={fileId!} />;
}

function useConvTitle(spaceId: string, conversationId: number | undefined) {
	const r = useApi<ConversationDetailResponse>(conversationId === undefined ? null : `/conversations/${spaceId}/${conversationId}`);
	return r.data?.conversation.title;
}

/**
 * One delivered output: its CURRENT content (preview), download, share, add to knowledge, delete (= withdraw). No versions anywhere.
 * `embedded` = the detail column of the two-column 文件库 (no top bar of its own, one column, a close button); otherwise a full page with
 * a way back to the list. `onChanged` tells the list that this file was withdrawn.
 */
export function FileDetailView({ fileId, embedded, onClose, onChanged }: { fileId: string; embedded?: boolean; onClose?: () => void; onChanged?: () => void }) {
	const navigate = useNavigate();
	const res = useApi<{ item: LibItemDTO }>(`/library/${encodeURIComponent(fileId)}`);
	const kstatus = useApi<FileKnowledgeStatus>(`/kb/files/${encodeURIComponent(fileId)}/status`, { pollMs: 4000 });
	const [addKb, setAddKb] = useState(false);
	const [share, setShare] = useState(false);
	const [removing, setRemoving] = useState(false);
	const item = res.data?.item;
	const title = useConvTitle(item?.spaceId ?? "", item?.conversationId);
	const Icon = fileIcon(item?.name ?? "", item?.mime);
	const gone = item?.status === "removed";

	const content = (
		<LoadState state={res} what="文件">
			{item ? (
				<>
					<div className="mb-6 flex flex-wrap items-start gap-x-3 gap-y-4">
						<span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-fg-muted">
							<Icon className="size-5" strokeWidth={1.5} />
						</span>
						<div className="min-w-0 flex-1 basis-60">
							<h1 data-testid="file-title" className="break-words text-xl font-semibold tracking-tight">
								{item.name}
							</h1>
							<p data-testid="provenance" className="mt-1 text-sm text-fg-muted">
								{gone ? "已删除" : `${formatBytes(item.size)} · ${relTime(item.updatedAt)}`} ·{" "}
								<Link to={`/c/${item.spaceId}/${item.conversationId}`} className="text-info hover:underline">
									对话「{title?.trim() || "未命名对话"}」
								</Link>
							</p>
							{gone ? null : (
								<div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm" data-testid="knowledge-status">
									<span className="text-fg-muted">知识库：</span>
									{kstatus.unavailable ? (
										<span className="text-fg-muted">暂时无法获取</span>
									) : (kstatus.data?.entries ?? []).length === 0 ? (
										<span className="text-fg-muted">未加入</span>
									) : (
										kstatus.data!.entries.map((e) => (
											<Badge key={e.docId} tone={AVAILABILITY[e.availability].tone}>
												{e.kbName} · {AVAILABILITY[e.availability].label}
											</Badge>
										))
									)}
								</div>
							)}
						</div>
						{gone ? null : (
							<div className="flex w-full flex-wrap gap-2 sm:w-auto">
								<Button asChild>
									<a data-testid="file-download" href={`/api/files/${item.fileId}/download?v=${encodeURIComponent(item.etag.slice(0, 16))}`}>
										<Download />
										下载
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
								<Button data-testid="file-remove" onClick={() => setRemoving(true)}>
									<Trash2 />
									删除
								</Button>
							</div>
						)}
					</div>
					{gone ? (
						<Notice title="已删除" />
					) : (
						<div className="h-[60vh] min-h-[320px] overflow-hidden rounded-xl border border-border bg-surface lg:h-[70vh]" data-testid="file-preview">
							<Suspense
								fallback={
									<div className="flex h-full items-center justify-center">
										<Spinner />
									</div>
								}
							>
								<PreviewViewer file={{ fileId: item.fileId, name: item.name, mime: item.mime, etag: item.etag }} />
							</Suspense>
						</div>
					)}
					<ShareDialog open={share} onOpenChange={setShare} kind="file" id={item.fileId} title={item.name} />
					<AddToKbDialog open={addKb} onOpenChange={setAddKb} fileId={item.fileId} onDone={() => kstatus.reload()} />
					<ConfirmDialog
						open={removing}
						onOpenChange={setRemoving}
						title="删除这个成果？"
						confirmLabel="删除"
						testId="remove-output-dialog"
						onConfirm={async () => {
							await del(`/library/${encodeURIComponent(item.fileId)}`);
							setRemoving(false);
							onChanged?.();
							if (embedded) onClose?.();
							else navigate("/files");
						}}
					>
						「{item.name}」将从文件库移除，对话里的卡片会显示已删除，不能再下载。
					</ConfirmDialog>
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

function AddToKbDialog({ open, onOpenChange, fileId, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; fileId: string; onDone: () => void }) {
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
											// the knowledge base indexes the content as it is now
											const cur = await get<FileDetailResponse>(`/files/${encodeURIComponent(fileId)}`);
											await post(`/kb/${encodeURIComponent(kbId)}/docs`, { fileId, versionId: cur.file.latestVersionId });
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
