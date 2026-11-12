// Right-side deliverable preview (lazy chunk). Each viewer kind is its own chunk as well, so opening a
// Markdown file never downloads the Office/PDF viewers or the code highlighter.
// A delivered output is previewed by fileId and always shows its CURRENT content: every URL carries the content hash (etag) as a cache
// key, and while the conversation's outputs are live (chat page) an overwrite swaps the etag and the viewer reloads.
import { Download, ExternalLink, FileX, X } from "lucide-react";
import { lazy, Suspense } from "react";
import type { FileDetailResponse, PreviewKind } from "@shared/files";
import { useApi } from "@/lib/useApi";
import { formatBytes, relTime } from "@/lib/utils";
import { Tip } from "@/components/ui/overlay";
import { Spinner } from "@/components/ui/misc";
import { LoadState, Notice } from "@/features/work/states";
import { usePanel, type PreviewTarget } from "@/components/shell/panel";
import { fileIcon } from "@/features/chat/Cards";
import { previewKindOf } from "./kind";

const FrameViewer = lazy(() => import("./viewers/FrameViewer"));
const TextViewer = lazy(() => import("./viewers/TextViewer"));
const ImageViewer = lazy(() => import("./viewers/ImageViewer"));

export interface ViewerFile {
	fileId: string;
	name: string;
	mime: string;
	/** Content hash (cache key); absent when unknown. */
	etag?: string;
	/** Chat uploads / knowledge citations are pinned to a revision; delivered outputs are not. */
	versionId?: string;
}

/** API paths (no /api prefix) of a file's preview / download / text. */
export function fileUrls(f: Pick<ViewerFile, "fileId" | "etag" | "versionId">) {
	const root = `/files/${encodeURIComponent(f.fileId)}${f.versionId ? `/versions/${encodeURIComponent(f.versionId)}` : ""}`;
	const q = f.etag ? `?v=${encodeURIComponent(f.etag.slice(0, 16))}` : "";
	return { preview: `${root}/preview${q}`, download: `${root}/download${q}`, text: `${root}/text${q}` };
}

export function Viewer({ file }: { file: ViewerFile }) {
	const k: PreviewKind = previewKindOf(file.name, file.mime);
	const u = fileUrls(file);
	return (
		<Suspense
			fallback={
				<div role="status" className="flex h-full items-center justify-center gap-2 text-sm text-fg-muted">
					<Spinner /> 正在加载预览…
				</div>
			}
		>
			{k === "image" ? (
				<ImageViewer key={u.preview} src={`/api${u.preview}`} name={file.name} />
			) : k === "markdown" || k === "text" ? (
				<TextViewer key={u.text} textPath={u.text} kind={k} name={file.name} fallbackSrc={`/api${u.preview}`} />
			) : k === "none" ? (
				<Notice
					icon={<FileX />}
					title="这种文件暂不支持预览"
					action={
						<a className="text-sm text-info hover:underline" href={`/api${u.download}`}>
							下载文件
						</a>
					}
				/>
			) : (
				<FrameViewer key={u.preview} src={`/api${u.preview}`} kind={k} name={file.name} />
			)}
		</Suspense>
	);
}

const ICON_BTN = "inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-8";

export default function PreviewPanel({ target, onClose }: { target: PreviewTarget; onClose: () => void }) {
	const { work } = usePanel();
	// the live item of this output (conversation SSE state): name / size / etag follow an overwrite, a withdrawal shows 已删除
	const live = target.versionId ? undefined : work?.outputs?.find((o) => o.fileId === target.fileId);
	// name / type are known for outputs; chat uploads and knowledge citations ask the file service (one request, no version list)
	const needMeta = !live && (!target.name || !target.mime);
	const meta = useApi<FileDetailResponse>(needMeta ? `/files/${encodeURIComponent(target.fileId)}` : null);
	const name = live?.name ?? target.name ?? meta.data?.file.name ?? "文件";
	const mime = live?.mime ?? target.mime ?? meta.data?.file.mime ?? "";
	const size = live?.size ?? target.size ?? meta.data?.file.size;
	const etag = live?.etag ?? target.etag;
	const removed = live?.status === "removed";
	const Icon = fileIcon(name, mime);
	const file: ViewerFile = { fileId: target.fileId, name, mime, etag, versionId: target.versionId };
	const u = fileUrls(file);

	return (
		<div
			data-testid="preview-panel"
			role="region"
			aria-label="成果预览"
			className="flex h-full min-h-0 flex-col"
			onKeyDown={(e) => {
				// Esc closes the panel only when focus is inside it (menus and dialogs handle their own Esc).
				if (e.key === "Escape" && !e.defaultPrevented && e.currentTarget.contains(e.target as Node)) onClose();
			}}
		>
			<div className="flex h-14 shrink-0 items-center gap-1 border-b border-border pl-3 pr-2">
				<Icon className="mr-1 size-4 shrink-0 text-fg-muted" />
				<div className="min-w-0 flex-1">
					<div data-testid="preview-name" className="truncate text-sm font-medium">
						{name}
					</div>
					{removed ? (
						<div className="truncate text-xs text-fg-muted">已删除</div>
					) : size !== undefined ? (
						<div className="truncate text-xs text-fg-muted">
							{formatBytes(size)}
							{live?.updatedAt ? ` · ${relTime(live.updatedAt)}` : ""}
						</div>
					) : null}
				</div>
				{removed ? null : (
					<Tip label="下载">
						<a data-testid="preview-download" href={`/api${u.download}`} className={ICON_BTN} aria-label="下载">
							<Download className="size-4" />
						</a>
					</Tip>
				)}
				<Tip label="在新标签页打开">
					<a data-testid="preview-open" href={`/files/${target.fileId}`} target="_blank" rel="noopener" className={ICON_BTN} aria-label="在新标签页打开">
						<ExternalLink className="size-4" />
					</a>
				</Tip>
				<Tip label="关闭">
					<button data-testid="close-panel" onClick={onClose} className={ICON_BTN} aria-label="关闭预览">
						<X className="size-[18px]" />
					</button>
				</Tip>
			</div>
			<div className="min-h-0 flex-1 overflow-hidden">
				{removed ? (
					<Notice icon={<FileX />} title="已删除" />
				) : needMeta ? (
					<LoadState state={meta} what="文件预览">
						<Viewer file={file} />
					</LoadState>
				) : (
					<Viewer file={file} />
				)}
			</div>
		</div>
	);
}
