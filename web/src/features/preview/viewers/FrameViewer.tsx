// PDF / Office (docx, xlsx, pptx) / CSV / HTML previews. The server renders them (Office → sanitized HTML
// under a CSP sandbox; PDF via the browser's own viewer), so the client only frames the result.
import { useEffect, useState } from "react";
import type { PreviewKind } from "@shared/files";
import { PanelLoading } from "@/features/work/states";

export default function FrameViewer({ src, kind, name }: { src: string; kind: PreviewKind; name: string }) {
	const [loaded, setLoaded] = useState(false);
	const [slow, setSlow] = useState(false);
	useEffect(() => {
		setLoaded(false);
		setSlow(false);
		const t = setTimeout(() => setSlow(true), 15000);
		return () => clearTimeout(t);
	}, [src]);
	return (
		<div className="relative h-full w-full bg-surface-2">
			<iframe
				data-testid="preview-frame"
				data-kind={kind}
				title={`预览：${name}`}
				src={src}
				onLoad={() => setLoaded(true)}
				// Scripts never run in previews; PDFs need the browser viewer so they are not sandboxed by the frame
				// (the viewer shows its own progress, and some browsers never fire load for it, so no overlay for PDFs).
				sandbox={kind === "pdf" ? undefined : ""}
				className="h-full w-full border-0 bg-white"
			/>
			{loaded || kind === "pdf" ? null : (
				<div data-testid="preview-loading" className="absolute inset-0 bg-surface">
					<PanelLoading label={slow ? "预览生成较慢，请稍候，或直接下载查看…" : kind === "pptx" ? "正在生成幻灯片预览…" : "正在加载预览…"} />
				</div>
			)}
		</div>
	);
}
