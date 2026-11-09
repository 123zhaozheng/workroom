// Text extraction and safe HTML rendering for previews. Parsers run in-process on bounded input.
import mammoth from "mammoth";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { Marked } from "marked";
import type { PreviewKind } from "../../../shared/files.ts";
import { previewKindOf } from "./mime.ts";

export const MAX_TEXT = 200_000;

export function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const decoder = new TextDecoder("utf-8", { fatal: false });
export function decodeText(bytes: Uint8Array): string {
	let s = decoder.decode(bytes);
	if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
	return s;
}

/** Markdown renderer that never passes raw HTML through (it is escaped). */
const md = new Marked({ gfm: true, breaks: false });
md.use({
	renderer: {
		html(token: { text: string }) {
			return escapeHtml(token.text);
		},
	},
	walkTokens(token: any) {
		// Drop javascript:/data: links (images may keep data: for inline previews of generated files).
		if (token.type === "link" && /^\s*(javascript|vbscript|data):/i.test(token.href ?? "")) token.href = "#";
		if (token.type === "image" && /^\s*(javascript|vbscript):/i.test(token.href ?? "")) token.href = "";
	},
});
export function markdownToHtml(text: string): string {
	return md.parse(text, { async: false }) as string;
}

export function parseCsv(text: string, delimiter = ","): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (quoted) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else quoted = false;
			} else field += c;
		} else if (c === '"' && field === "") quoted = true;
		else if (c === delimiter) {
			row.push(field);
			field = "";
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && text[i + 1] === "\n") i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else field += c;
	}
	if (field !== "" || row.length) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

export function tableHtml(rows: readonly (readonly unknown[])[], opts: { header?: boolean; maxRows?: number; maxCols?: number } = {}): string {
	const maxRows = opts.maxRows ?? 500;
	const maxCols = opts.maxCols ?? 60;
	const cut = rows.slice(0, maxRows);
	const body = cut
		.map((r, i) => {
			const tag = opts.header !== false && i === 0 ? "th" : "td";
			return `<tr>${r.slice(0, maxCols).map((c) => `<${tag}>${escapeHtml(cellText(c))}</${tag}>`).join("")}</tr>`;
		})
		.join("\n");
	const more = rows.length > maxRows ? `<p class="note">仅显示前 ${maxRows} 行（共 ${rows.length} 行）</p>` : "";
	return `<table>${body}</table>${more}`;
}

function cellText(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (v instanceof Date) return v.toISOString().slice(0, 10);
	if (typeof v === "object") {
		const o = v as any;
		if ("result" in o) return cellText(o.result);
		if ("text" in o) return String(o.text);
		if (Array.isArray(o.richText)) return o.richText.map((r: any) => r.text).join("");
		if ("hyperlink" in o) return String(o.text ?? o.hyperlink);
		if ("error" in o) return String(o.error);
		return JSON.stringify(o);
	}
	return String(v);
}

export interface SheetData {
	name: string;
	rows: unknown[][];
}
export async function readXlsx(bytes: Uint8Array): Promise<SheetData[]> {
	const wb = new ExcelJS.Workbook();
	await wb.xlsx.load(Buffer.from(bytes) as any);
	const out: SheetData[] = [];
	wb.eachSheet((ws) => {
		const rows: unknown[][] = [];
		ws.eachRow({ includeEmpty: false }, (row) => {
			const vals = (row.values as unknown[]).slice(1); // exceljs rows are 1-based
			rows.push(vals.map((v) => cellText(v)));
		});
		out.push({ name: ws.name, rows });
	});
	return out;
}

export interface SlideData {
	index: number;
	paragraphs: string[];
	notes: string[];
}
function xmlParagraphs(xml: string): string[] {
	const paras: string[] = [];
	for (const p of xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? []) {
		const t = [...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]!)).join("");
		if (t.trim()) paras.push(t);
	}
	return paras;
}
function decodeXml(s: string): string {
	return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
		const map: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
		if (map[e]) return map[e]!;
		if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
		if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
		return m;
	});
}
export async function readPptx(bytes: Uint8Array): Promise<SlideData[]> {
	const zip = await JSZip.loadAsync(bytes);
	const slides: SlideData[] = [];
	const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
	names.sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
	for (const n of names) {
		const index = Number(/(\d+)\.xml$/.exec(n)![1]);
		const xml = await zip.file(n)!.async("string");
		const notesFile = zip.file(`ppt/notesSlides/notesSlide${index}.xml`);
		const notes = notesFile ? xmlParagraphs(await notesFile.async("string")).filter((t) => !/^\d+$/.test(t.trim())) : [];
		slides.push({ index, paragraphs: xmlParagraphs(xml), notes });
	}
	return slides;
}

export async function pdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
	const { extractText, getDocumentProxy } = await import("unpdf");
	const doc = await getDocumentProxy(new Uint8Array(bytes));
	const r = await extractText(doc, { mergePages: false });
	const pages = (r.text as unknown as string[]) ?? [];
	return { text: pages.map((t, i) => `[第 ${i + 1} 页]\n${t}`).join("\n\n"), pages: r.totalPages };
}

export function htmlToText(html: string): string {
	return html
		.replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|h\d|li|tr|section|article)>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&(lt|gt|amp|quot|#39);/g, (_m, e: string) => ({ lt: "<", gt: ">", amp: "&", quot: '"', "#39": "'" })[e]!)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Plain text of a file version for agents and indexing (bounded to MAX_TEXT). */
export async function extractText(mime: string, name: string, bytes: Uint8Array): Promise<{ text: string; truncated: boolean; kind: PreviewKind }> {
	const kind = previewKindOf(mime, name);
	let text = "";
	switch (kind) {
		case "text":
		case "markdown":
		case "csv":
			text = decodeText(bytes);
			break;
		case "html":
			text = htmlToText(decodeText(bytes));
			break;
		case "docx":
			text = (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
			break;
		case "xlsx":
			text = (await readXlsx(bytes)).map((s) => `## ${s.name}\n${s.rows.map((r) => r.map((c) => String(c ?? "")).join("\t")).join("\n")}`).join("\n\n");
			break;
		case "pptx":
			text = (await readPptx(bytes)).map((s) => `## 幻灯片 ${s.index}\n${s.paragraphs.join("\n")}${s.notes.length ? `\n备注：${s.notes.join(" ")}` : ""}`).join("\n\n");
			break;
		case "pdf":
			text = (await pdfText(bytes)).text;
			break;
		default:
			text = "";
	}
	const truncated = text.length > MAX_TEXT;
	return { text: truncated ? text.slice(0, MAX_TEXT) : text, truncated, kind };
}
