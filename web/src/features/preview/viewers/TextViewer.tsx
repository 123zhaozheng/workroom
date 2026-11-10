// Markdown and plain-text/code previews rendered by the same Markdown component as chat messages.
// Source code is wrapped in a fence so the (lazy) highlighter chunk loads only for code files.
import type { FileTextResponse, FileVersionDTO } from "@shared/files";
import { useApi } from "@/lib/useApi";
import { Markdown } from "@/features/markdown/Markdown";
import { PanelLoading } from "@/features/work/states";
import FrameViewer from "./FrameViewer";

const CODE_EXT: Record<string, string> = { ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", py: "python", json: "json", css: "css", html: "html", sh: "bash", sql: "sql", yaml: "yaml", yml: "yaml", go: "go", rs: "rust", java: "java" };

export default function TextViewer({ fileId, version, fallbackSrc }: { fileId: string; version: FileVersionDTO; fallbackSrc: string }) {
	const res = useApi<FileTextResponse>(`/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(version.versionId)}/text`);
	if (res.loading) return <PanelLoading />;
	if (res.error || !res.data) return <FrameViewer src={fallbackSrc} kind={version.previewKind} name={version.name} />;
	const ext = version.name.split(".").pop()?.toLowerCase() ?? "";
	const lang = CODE_EXT[ext];
	const body = version.previewKind === "markdown" ? res.data.text : lang ? `\`\`\`${lang}\n${res.data.text}\n\`\`\`` : null;
	return (
		<div data-testid="preview-text" className="wr-scroll h-full overflow-auto px-4 py-4 sm:px-6 sm:py-5">
			{body !== null ? <Markdown text={body} /> : <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-6 text-fg">{res.data.text}</pre>}
			{res.data.truncated ? <p className="mt-4 text-xs text-fg-subtle">内容过长，仅显示前一部分；完整内容请下载。</p> : null}
		</div>
	);
}
