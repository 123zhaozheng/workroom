import type { PreviewKind } from "../../../shared/files.ts";

const BY_EXT: Record<string, string> = {
	txt: "text/plain",
	log: "text/plain",
	md: "text/markdown",
	markdown: "text/markdown",
	csv: "text/csv",
	tsv: "text/tab-separated-values",
	json: "application/json",
	html: "text/html",
	htm: "text/html",
	xml: "application/xml",
	yaml: "text/yaml",
	yml: "text/yaml",
	js: "text/javascript",
	ts: "text/plain",
	py: "text/x-python",
	sh: "text/x-shellscript",
	css: "text/css",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	zip: "application/zip",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	mp4: "video/mp4",
};

export const MIME = {
	docx: BY_EXT.docx!,
	xlsx: BY_EXT.xlsx!,
	pptx: BY_EXT.pptx!,
	pdf: BY_EXT.pdf!,
	md: BY_EXT.md!,
	html: BY_EXT.html!,
	csv: BY_EXT.csv!,
	png: BY_EXT.png!,
};

export function extOf(name: string): string {
	const m = /\.([a-z0-9]+)$/i.exec(name);
	return m ? m[1]!.toLowerCase() : "";
}

export function guessMime(name: string): string {
	return BY_EXT[extOf(name)] ?? "application/octet-stream";
}

export function normalizeMime(mime: string | undefined | null): string {
	const m = String(mime ?? "").split(";")[0]!.trim().toLowerCase();
	if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(m)) return "";
	return m;
}

/** Prefer the extension's mime for generic uploads (browsers often send application/octet-stream). */
export function effectiveMime(declared: string | undefined | null, name: string): string {
	const d = normalizeMime(declared);
	if (!d || d === "application/octet-stream") return guessMime(name);
	return d;
}

const TEXTISH = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|toml|x-sh))/;

export function isTextMime(mime: string): boolean {
	return TEXTISH.test(mime);
}

export function previewKindOf(mime: string, name: string): PreviewKind {
	const ext = extOf(name);
	if (mime === MIME.docx || ext === "docx") return "docx";
	if (mime === MIME.xlsx || ext === "xlsx") return "xlsx";
	if (mime === MIME.pptx || ext === "pptx") return "pptx";
	if (mime === "application/pdf") return "pdf";
	if (mime.startsWith("image/")) return "image";
	if (mime === "text/markdown" || ext === "md" || ext === "markdown") return "markdown";
	if (mime === "text/html") return "html";
	if (mime === "text/csv" || ext === "csv") return "csv";
	if (isTextMime(mime)) return "text";
	return "none";
}
