// Right-side deliverable preview (lazy chunk). Each viewer kind is its own chunk as well, so opening a
// Markdown file never downloads the Office/PDF viewers or the code highlighter.
import { Check, ChevronDown, Download, ExternalLink, History, X } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Link } from "react-router";
import type { FileDetailResponse, FileVersionDTO } from "@shared/files";
import { useApi } from "@/lib/useApi";
import { cn, formatBytes, fullTime, relTime } from "@/lib/utils";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Tip } from "@/components/ui/overlay";
import { Loadable, Spinner } from "@/components/ui/misc";
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
				<div className="flex h-full items-center justify-center gap-2 text-[13px] text-fg-subtle">
					<Spinner /> 正在加载预览…
				</div>
			}
		>
			{k === "image" ? (
				<ImageViewer src={src} name={version.name} />
			) : k === "markdown" || k === "text" ? (
				<TextViewer fileId={fileId} version={version} fallbackSrc={src} />
			) : k === "none" ? (
				<div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-[13px] text-fg-muted">
					<div>该格式暂不支持在线预览。</div>
					<a className="text-info hover:underline" href={`/api${version.downloadUrl.replace(/^\/api/, "")}`}>
						下载文件
					</a>
				</div>
			) : (
				<FrameViewer src={src} kind={k} name={version.name} />
			)}
		</Suspense>
	);
}

export default function PreviewPanel({ target, onClose }: { target: PreviewTarget; onClose: () => void }) {
	const res = useApi<FileDetailResponse>(`/files/${encodeURIComponent(target.fileId)}`);
	const [versionId, setVersionId] = useState(target.versionId);
	useEffect(() => setVersionId(target.versionId), [target.fileId, target.versionId]);
	const versions = res.data?.versions ?? [];
	const v = versions.find((x) => x.versionId === versionId) ?? versions[0];
	const Icon = fileIcon(target.name ?? v?.name ?? "", target.mime ?? v?.mime);

	return (
		<div data-testid="preview-panel" className="flex h-full min-h-0 flex-col">
			<div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
				<Icon className="size-4 shrink-0 text-fg-muted" />
				<div className="min-w-0 flex-1">
					<div className="truncate text-[13.5px] font-medium">{v?.name ?? target.name ?? "文件"}</div>
					{v ? (
						<div className="truncate text-[11.5px] text-fg-subtle">
							{formatBytes(v.size)} · {relTime(v.createdAt)}
							{v.provenance.origin === "agent" ? " · 助手生成" : v.provenance.origin === "automation" ? " · 自动化生成" : " · 上传"}
						</div>
					) : null}
				</div>
				{versions.length ? (
					<Menu>
						<MenuTrigger asChild>
							<button data-testid="version-switch" className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[12.5px] hover:bg-surface-2">
								<History className="size-3.5" />v{v?.versionNo}
								<ChevronDown className="size-3" />
							</button>
						</MenuTrigger>
						<MenuContent align="end" className="w-72">
							<MenuLabel>版本（旧版本始终保留）</MenuLabel>
							{versions.map((x) => (
								<MenuItem key={x.versionId} onSelect={() => setVersionId(x.versionId)} className="items-start">
									<Check className={cn("mt-0.5", x.versionId === v?.versionId ? "opacity-100" : "opacity-0")} />
									<span className="min-w-0 flex-1">
										<span className="block">
											v{x.versionNo}
											{x.versionNo === res.data?.file.latestVersionNo ? <span className="ml-1 text-xs text-fg-subtle">最新</span> : null}
										</span>
										<span className="block truncate text-xs text-fg-subtle">{x.changeNote || fullTime(x.createdAt)}</span>
									</span>
								</MenuItem>
							))}
						</MenuContent>
					</Menu>
				) : null}
				{v ? (
					<Tip label="下载此版本">
						<a href={`/api${v.downloadUrl.replace(/^\/api/, "")}`} className="rounded-md p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg" aria-label="下载">
							<Download className="size-4" />
						</a>
					</Tip>
				) : null}
				<Tip label="在文件库中查看">
					<Link to={`/files/${target.fileId}${v ? `?v=${v.versionId}` : ""}`} className="rounded-md p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg" aria-label="在文件库中查看">
						<ExternalLink className="size-4" />
					</Link>
				</Tip>
				<Tip label="关闭预览">
					<button data-testid="close-panel" onClick={onClose} className="rounded-md p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg" aria-label="关闭预览">
						<X className="size-4" />
					</button>
				</Tip>
			</div>
			<div className="min-h-0 flex-1 overflow-hidden">
				<Loadable state={res} what="文件预览" need="GET /api/files/:id（D 组）">
					{v ? <Viewer fileId={target.fileId} version={v} /> : <div className="p-6 text-[13px] text-fg-muted">没有可用的版本。</div>}
				</Loadable>
			</div>
			{v?.changeNote ? <div className="shrink-0 border-t border-border px-3 py-2 text-[12px] text-fg-muted">本版本说明：{v.changeNote}</div> : null}
		</div>
	);
}
