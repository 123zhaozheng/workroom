// Which viewer renders a file (mirrors the server's previewKindOf, which decides how /preview responds).
import type { PreviewKind } from "@shared/files";

const ext = (name: string) => {
	const i = name.lastIndexOf(".");
	return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

export function previewKindOf(name: string, mime = ""): PreviewKind {
	const e = ext(name);
	if (e === "docx" || mime.includes("wordprocessingml")) return "docx";
	if (e === "xlsx" || mime.includes("spreadsheetml")) return "xlsx";
	if (e === "pptx" || mime.includes("presentationml")) return "pptx";
	if (mime === "application/pdf" || e === "pdf") return "pdf";
	if (mime.startsWith("image/")) return "image";
	if (mime === "text/markdown" || e === "md" || e === "markdown") return "markdown";
	if (mime === "text/html" || e === "html") return "html";
	if (mime === "text/csv" || e === "csv") return "csv";
	if (mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json") || mime.endsWith("+xml") || mime === "application/xml" || ["txt", "json", "log", "yaml", "yml", "xml", "py", "js", "ts", "tsx", "css", "sh", "sql"].includes(e)) return "text";
	return "none";
}
