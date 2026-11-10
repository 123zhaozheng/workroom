// Right-side deliverable preview (lazy chunk). Each viewer kind is its own chunk as well, so opening a
// Markdown file never downloads the Office/PDF viewers or the code highlighter.
import { Check, ChevronDown, Download, ExternalLink, FileX, X } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import type { FileDetailResponse, FileVersionDTO } from "@shared/files";
import { useApi } from "@/lib/useApi";
import { cn, formatBytes, fullTime, relTime } from "@/lib/utils";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Tip } from "@/components/ui/overlay";
import { Spinner } from "@/components/ui/misc";
import { LoadState, Notice } from "@/features/work/states";
import type { PreviewTarget } from "@/components/shell/panel";
import { fileIcon } from "@/features/chat/Cards";

const FrameViewer = lazy(() => import("./viewers/FrameViewer"));
const TextViewer = lazy(() => import("./viewers/TextViewer"));
const ImageViewer = lazy(() => import("./viewers/ImageViewer"));

export function Viewer({ fileId, version }: { fileId: string; version: FileVersionDTO }) {
	const k = version.previewKind;
	const src = `/api${version.previewUrl.startsWith("/") ? "" : "/"}${version.previewUrl.replace(/^\/api/, "")}`;
	return (
		<Suspense
			fallback={
				<div role="status" className="flex h-full items-center justify-center gap-2 text-sm text-fg-muted">
					<Spinner /> 正在加载预览…
				</div>
			}
		>
			{k === "image" ? (
				<ImageViewer src={src} name={version.name} />
			) : k === "markdown" || k === "text" ? (
				<TextViewer fileId={fileId} version={version} fallbackSrc={src} />
			) : k === "none" ? (
				<Notice
					icon={<FileX />}
					title="这种文件暂不支持预览"
					action={
						<a className="text-sm text-info hover:underline" href={`/api${version.downloadUrl.replace(/^\/api/, "")}`}>
							下载文件
						</a>
					}
				/>
			) : (
				<FrameViewer src={src} kind={k} name={version.name} />
			)}
		</Suspense>
	);
}

const ICON_BTN = "inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-8";

export default function PreviewPanel({ target, onClose }: { target: PreviewTarget; onClose: () => void }) {
	const res = useApi<FileDetailResponse>(`/files/${encodeURIComponent(target.fileId)}`);
	const [versionId, setVersionId] = useState(target.versionId);
	useEffect(() => setVersionId(target.versionId), [target.fileId, target.versionId]);
	const versions = res.data?.versions ?? [];
	const v = versions.find((x) => x.versionId === versionId) ?? versions[0];
	const Icon = fileIcon(target.name ?? v?.name ?? "", target.mime ?? v?.mime);
	const many = versions.length > 1;

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
						{v?.name ?? target.name ?? "文件"}
					</div>
					{v ? (
						<div className="truncate text-xs text-fg-muted">
							{many ? "" : `v${v.versionNo} · `}
							{formatBytes(v.size)} · {relTime(v.createdAt)}
						</div>
					) : null}
				</div>
				{many ? (
					<Menu>
						<MenuTrigger asChild>
							<button data-testid="version-switch" aria-label={`切换版本，当前 v${v?.versionNo}`} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-border px-2 text-[13px] hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
								v{v?.versionNo}
								<ChevronDown className="size-3.5" />
							</button>
						</MenuTrigger>
						<MenuContent align="end" className="w-72 max-w-[calc(100vw-24px)]">
							<MenuLabel>版本</MenuLabel>
							{versions.map((x) => (
								<MenuItem key={x.versionId} onSelect={() => setVersionId(x.versionId)} className="items-start">
									<Check className={cn("mt-0.5", x.versionId === v?.versionId ? "opacity-100" : "opacity-0")} />
									<span className="min-w-0 flex-1">
										<span className="block">
											v{x.versionNo}
											{x.versionNo === res.data?.file.latestVersionNo ? <span className="ml-1 text-xs text-fg-muted">最新</span> : null}
										</span>
										<span className="block truncate text-xs text-fg-muted">{x.changeNote || fullTime(x.createdAt)}</span>
									</span>
								</MenuItem>
							))}
						</MenuContent>
					</Menu>
				) : null}
				{v ? (
					<Tip label="下载">
						<a data-testid="preview-download" href={`/api${v.downloadUrl.replace(/^\/api/, "")}`} className={ICON_BTN} aria-label="下载">
							<Download className="size-4" />
						</a>
					</Tip>
				) : null}
				<Tip label="在新标签页打开">
					<a data-testid="preview-open" href={`/files/${target.fileId}${v ? `?v=${v.versionId}` : ""}`} target="_blank" rel="noopener" className={ICON_BTN} aria-label="在新标签页打开">
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
				<LoadState state={res} what="文件预览">
					{v ? <Viewer fileId={target.fileId} version={v} /> : <Notice icon={<FileX />} title="没有可预览的版本" />}
				</LoadState>
			</div>
			{many && v?.changeNote ? <div className="shrink-0 truncate border-t border-border px-3 py-2 text-xs text-fg-muted">v{v.versionNo} 说明：{v.changeNote}</div> : null}
		</div>
	);
}
