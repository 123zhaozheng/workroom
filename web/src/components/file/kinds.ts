// File kinds shared by the composer attachments, message bubbles and deliverable cards.
import { Archive, FileCode2, FileImage, FileSpreadsheet, FileText, FileType2, Presentation, type LucideIcon } from "lucide-react";

export type FileKind = "pdf" | "doc" | "xls" | "ppt" | "image" | "code" | "archive" | "text";

export const KIND_META: Record<FileKind, { label: string; icon: LucideIcon; color: string }> = {
	pdf: { label: "PDF", icon: FileType2, color: "var(--kind-pdf)" },
	doc: { label: "文档", icon: FileText, color: "var(--kind-doc)" },
	xls: { label: "表格", icon: FileSpreadsheet, color: "var(--kind-xls)" },
	ppt: { label: "演示", icon: Presentation, color: "var(--kind-ppt)" },
	image: { label: "图片", icon: FileImage, color: "var(--kind-image)" },
	code: { label: "代码", icon: FileCode2, color: "var(--kind-code)" },
	archive: { label: "压缩包", icon: Archive, color: "var(--kind-archive)" },
	text: { label: "文本", icon: FileText, color: "var(--kind-text)" },
};

const EXT: Record<string, FileKind> = {
	pdf: "pdf",
	doc: "doc",
	docx: "doc",
	dotx: "doc",
	odt: "doc",
	rtf: "doc",
	xls: "xls",
	xlsx: "xls",
	xlsm: "xls",
	csv: "xls",
	tsv: "xls",
	ods: "xls",
	ppt: "ppt",
	pptx: "ppt",
	odp: "ppt",
	key: "ppt",
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	svg: "image",
	bmp: "image",
	heic: "image",
	avif: "image",
	js: "code",
	mjs: "code",
	cjs: "code",
	ts: "code",
	tsx: "code",
	jsx: "code",
	py: "code",
	java: "code",
	go: "code",
	rs: "code",
	c: "code",
	h: "code",
	cpp: "code",
	cs: "code",
	rb: "code",
	php: "code",
	sh: "code",
	sql: "code",
	json: "code",
	yaml: "code",
	yml: "code",
	xml: "code",
	html: "code",
	css: "code",
	zip: "archive",
	rar: "archive",
	"7z": "archive",
	tar: "archive",
	gz: "archive",
	tgz: "archive",
};

export const extOf = (name: string): string => {
	const i = name.lastIndexOf(".");
	return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : "";
};

export function fileKind(name: string, mime = ""): FileKind {
	if (mime.startsWith("image/")) return "image";
	const e = EXT[extOf(name)];
	if (e) return e;
	if (mime === "application/pdf") return "pdf";
	if (mime.includes("zip") || mime.includes("compressed")) return "archive";
	if (mime.includes("spreadsheet") || mime.includes("excel")) return "xls";
	if (mime.includes("presentation") || mime.includes("powerpoint")) return "ppt";
	if (mime.includes("wordprocessing") || mime.includes("msword")) return "doc";
	return "text";
}

/** "report-final-2024.pdf" → head "report-final-20", tail "24.pdf": the tail always keeps the extension visible. */
export function splitName(name: string): { head: string; tail: string } {
	const ext = extOf(name);
	const keep = (ext ? ext.length + 1 : 0) + 4;
	if (name.length <= keep + 8) return { head: name, tail: "" };
	return { head: name.slice(0, name.length - keep), tail: name.slice(name.length - keep) };
}
