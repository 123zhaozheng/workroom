// PDF / Office (docx, xlsx, pptx) / CSV / HTML previews. The server renders them (Office → sanitized HTML
// under a CSP sandbox; PDF via the browser's own viewer), so the client only frames the result.
import type { PreviewKind } from "@shared/files";

export default function FrameViewer({ src, kind, name }: { src: string; kind: PreviewKind; name: string }) {
	return (
		<iframe
			data-testid="preview-frame"
			data-kind={kind}
			title={`预览：${name}`}
			src={src}
			// Scripts never run in previews; PDFs need the browser viewer so they are not sandboxed by the frame.
			sandbox={kind === "pdf" ? undefined : ""}
			className="h-full w-full border-0 bg-white"
		/>
	);
}
