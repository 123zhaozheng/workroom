// Document parsers: bytes + metadata → anchored text blocks.
// Anchors: PDF page; heading path for md/html/docx; sheet + row for xlsx; row for csv; JSON path; paragraph ordinal otherwise.
import { parse as parseHtml, type HTMLElement, type Node as HtmlNode, NodeType } from "node-html-parser";

export interface Block {
	text: string;
	page?: number;
	section?: string;
	paragraph?: number;
	sheet?: string;
	rowStart?: number;
	rowEnd?: number;
}
export interface ParseResult {
	format: DocFormat;
	blocks: Block[];
	pageCount?: number;
}

export type DocFormat = "txt" | "md" | "html" | "csv" | "json" | "pdf" | "docx" | "xlsx";
export const SUPPORTED_FORMATS: readonly DocFormat[] = ["txt", "md", "html", "csv", "json", "pdf", "docx", "xlsx"];

export class ParseError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	constructor(code: string, message: string, retryable = false) {
		super(message);
		this.code = code;
		this.retryable = retryable;
	}
}

const MIME: Record<string, DocFormat> = {
	"text/plain": "txt",
	"text/markdown": "md",
	"text/x-markdown": "md",
	"text/html": "html",
	"application/xhtml+xml": "html",
	"text/csv": "csv",
	"text/tab-separated-values": "csv",
	"application/json": "json",
	"application/pdf": "pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};
const EXT: Record<string, DocFormat> = {
	txt: "txt", log: "txt", text: "txt",
	md: "md", markdown: "md",
	html: "html", htm: "html", xhtml: "html",
	csv: "csv", tsv: "csv",
	json: "json",
	pdf: "pdf",
	docx: "docx",
	xlsx: "xlsx",
};
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic"]);

export function detectFormat(name: string, mime: string, bytes: Uint8Array): DocFormat | { unsupported: string; code: string } {
	const ext = name.toLowerCase().split(".").pop() ?? "";
	const m = mime.toLowerCase().split(";")[0]!.trim();
	if (EXT[ext]) return EXT[ext];
	if (MIME[m]) return MIME[m];
	if (IMAGE_EXT.has(ext) || m.startsWith("image/")) return { code: "ocr_unavailable", unsupported: "图片需要 OCR 才能提取文字；本部署未启用 OCR（离线 OCR 引擎与语言数据未安装）" };
	if (m.startsWith("text/") || looksLikeText(bytes)) return "txt";
	return { code: "unsupported_type", unsupported: `不支持的文件类型（${m || ext || "unknown"}）；支持 ${SUPPORTED_FORMATS.join(", ")}` };
}

function looksLikeText(bytes: Uint8Array): boolean {
	const n = Math.min(bytes.length, 4096);
	if (n === 0) return false;
	for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, n === bytes.length ? n : Math.max(0, n - 4)));
		return true;
	} catch {
		return false;
	}
}

/** UTF-8 (BOM stripped) with a GB18030 fallback for legacy Chinese text files. */
export function decodeText(bytes: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch {
		try {
			return new TextDecoder("gb18030").decode(bytes);
		} catch {
			return new TextDecoder("utf-8").decode(bytes);
		}
	}
}

const norm = (s: string) => s.replace(/\r\n?/g, "\n").replace(/[ \t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

export async function parseDocument(bytes: Uint8Array, name: string, mime: string): Promise<ParseResult> {
	const f = detectFormat(name, mime, bytes);
	if (typeof f !== "string") throw new ParseError(f.code, f.unsupported);
	let res: ParseResult;
	switch (f) {
		case "txt":
			res = { format: f, blocks: paragraphs(decodeText(bytes)) };
			break;
		case "md":
			res = { format: f, blocks: parseMarkdown(decodeText(bytes)) };
			break;
		case "html":
			res = { format: f, blocks: parseHtmlBlocks(decodeText(bytes)) };
			break;
		case "csv":
			res = { format: f, blocks: parseCsv(decodeText(bytes), name.toLowerCase().endsWith(".tsv") || mime.includes("tab-separated")) };
			break;
		case "json":
			res = { format: f, blocks: parseJson(decodeText(bytes)) };
			break;
		case "pdf":
			res = await parsePdf(bytes);
			break;
		case "docx":
			res = { format: f, blocks: await parseDocx(bytes) };
			break;
		case "xlsx":
			res = { format: f, blocks: await parseXlsx(bytes) };
			break;
	}
	res.blocks = res.blocks.filter((b) => b.text.trim().length > 0);
	if (res.blocks.length === 0) {
		if (f === "pdf") throw new ParseError("no_text", "PDF 没有可提取的文本层（可能是扫描件，需要 OCR；本部署未启用 OCR）");
		throw new ParseError("no_text", "文件中没有可索引的文字内容");
	}
	return res;
}

// ---------- plain text ----------
function paragraphs(text: string, base: Partial<Block> = {}, start = 1): Block[] {
	const out: Block[] = [];
	let n = start;
	for (const p of text.replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
		const t = norm(p);
		if (t) out.push({ ...base, text: t, paragraph: n++ });
	}
	return out;
}

// ---------- markdown ----------
export function parseMarkdown(src: string): Block[] {
	const lines = src.replace(/\r\n?/g, "\n").split("\n");
	const stack: string[] = [];
	const out: Block[] = [];
	let buf: string[] = [];
	let n = 1;
	let fence: string | null = null;
	const flush = () => {
		const t = norm(buf.join("\n"));
		buf = [];
		if (t) out.push({ text: t, section: stack.filter(Boolean).join(" > ") || undefined, paragraph: n++ });
	};
	for (const line of lines) {
		const fm = /^\s*(```|~~~)/.exec(line);
		if (fm) {
			if (fence === null) {
				flush();
				fence = fm[1]!;
			} else if (line.trim().startsWith(fence)) {
				fence = null;
				flush();
				continue;
			}
			buf.push(line);
			continue;
		}
		if (fence !== null) {
			buf.push(line);
			continue;
		}
		const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (h) {
			flush();
			const level = h[1]!.length;
			stack.length = level - 1;
			stack[level - 1] = h[2]!.trim();
			continue;
		}
		if (!line.trim()) flush();
		else buf.push(line);
	}
	flush();
	return out;
}

// ---------- html / docx ----------
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const LEAF_BLOCKS = new Set(["p", "li", "pre", "blockquote", "dt", "dd", "figcaption", "caption", "address", "summary"]);
const SKIP = new Set(["script", "style", "noscript", "template", "head", "svg", "iframe"]);

export function parseHtmlBlocks(html: string): Block[] {
	const root = parseHtml(html, { comment: false, blockTextElements: { script: false, style: false, noscript: false, pre: true } });
	const stack: string[] = [];
	const out: Block[] = [];
	let n = 1;
	let inline: string[] = [];
	const section = () => stack.filter(Boolean).join(" > ") || undefined;
	const emit = (text: string) => {
		const t = norm(text);
		if (t) out.push({ text: t, section: section(), paragraph: n++ });
	};
	const flushInline = () => {
		if (inline.length) emit(inline.join(" "));
		inline = [];
	};
	const walk = (node: HtmlNode) => {
		if (node.nodeType === NodeType.TEXT_NODE) {
			const t = node.text.trim();
			if (t) inline.push(decodeEntities(t));
			return;
		}
		if (node.nodeType !== NodeType.ELEMENT_NODE) return;
		const el = node as HTMLElement;
		const tag = (el.rawTagName ?? "").toLowerCase();
		if (SKIP.has(tag)) return;
		if (HEADINGS.has(tag)) {
			flushInline();
			const level = Number(tag[1]);
			stack.length = level - 1;
			stack[level - 1] = norm(decodeEntities(el.text));
			return;
		}
		if (tag === "tr") {
			flushInline();
			const cells = el.childNodes.filter((c) => c.nodeType === NodeType.ELEMENT_NODE && ["td", "th"].includes(((c as HTMLElement).rawTagName ?? "").toLowerCase()));
			emit(cells.map((c) => norm(decodeEntities(c.text))).join(" | "));
			return;
		}
		if (LEAF_BLOCKS.has(tag)) {
			flushInline();
			emit(decodeEntities(tag === "pre" ? el.text : el.structuredText ?? el.text));
			return;
		}
		if (tag === "br") {
			inline.push("\n");
			return;
		}
		const isInline = ["a", "span", "strong", "b", "em", "i", "u", "code", "small", "sup", "sub", "mark", "abbr", "time", "label", "s", "del", "ins", "q", "cite"].includes(tag);
		if (!isInline) flushInline();
		for (const c of el.childNodes) walk(c);
		if (!isInline) flushInline();
	};
	walk(root);
	flushInline();
	return out;
}

function decodeEntities(s: string): string {
	return s
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&amp;/g, "&");
}

async function parseDocx(bytes: Uint8Array): Promise<Block[]> {
	const mammoth = (await import("mammoth")).default;
	let html: string;
	try {
		html = (await mammoth.convertToHtml({ buffer: Buffer.from(bytes) })).value;
	} catch (e) {
		throw new ParseError("parse_error", `无法解析 DOCX：${(e as Error).message}`);
	}
	return parseHtmlBlocks(html);
}

// ---------- csv ----------
export function parseCsvRows(text: string, tab: boolean): string[][] {
	const firstLine = text.slice(0, text.indexOf("\n") >>> 0);
	const delim = tab || (firstLine.split("\t").length > firstLine.split(",").length && firstLine.includes("\t")) ? "\t" : firstLine.split(";").length > firstLine.split(",").length ? ";" : ",";
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let q = false;
	const s = text.replace(/^﻿/, "");
	for (let i = 0; i < s.length; i++) {
		const ch = s[i]!;
		if (q) {
			if (ch === '"') {
				if (s[i + 1] === '"') {
					field += '"';
					i++;
				} else q = false;
			} else field += ch;
			continue;
		}
		if (ch === '"' && field === "") q = true;
		else if (ch === delim) {
			row.push(field);
			field = "";
		} else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && s[i + 1] === "\n") i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else field += ch;
	}
	if (field !== "" || row.length) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

function rowsToBlocks(rows: { n: number; cells: string[] }[], sheet?: string): Block[] {
	const nonEmpty = rows.filter((r) => r.cells.some((c) => c.trim()));
	if (!nonEmpty.length) return [];
	const header = nonEmpty[0]!.cells.map((h, i) => h.trim() || `列${i + 1}`);
	const out: Block[] = [{ text: header.join(" | "), sheet, section: sheet, rowStart: nonEmpty[0]!.n, rowEnd: nonEmpty[0]!.n }];
	for (const r of nonEmpty.slice(1)) {
		const parts = r.cells.map((c, i) => (c.trim() ? `${header[i] ?? `列${i + 1}`}: ${c.trim()}` : "")).filter(Boolean);
		if (parts.length) out.push({ text: parts.join("; "), sheet, section: sheet, rowStart: r.n, rowEnd: r.n });
	}
	return out;
}

function parseCsv(text: string, tab: boolean): Block[] {
	return rowsToBlocks(parseCsvRows(text, tab).map((cells, i) => ({ n: i + 1, cells })));
}

// ---------- xlsx ----------
async function parseXlsx(bytes: Uint8Array): Promise<Block[]> {
	const ExcelJS = (await import("exceljs")).default;
	const wb = new ExcelJS.Workbook();
	try {
		await wb.xlsx.load(Buffer.from(bytes) as any);
	} catch (e) {
		throw new ParseError("parse_error", `无法解析 XLSX：${(e as Error).message}`);
	}
	const out: Block[] = [];
	wb.eachSheet((ws) => {
		const rows: { n: number; cells: string[] }[] = [];
		ws.eachRow({ includeEmpty: false }, (row, n) => {
			const cells: string[] = [];
			row.eachCell({ includeEmpty: true }, (cell, col) => {
				cells[col - 1] = cellText(cell.value);
			});
			for (let i = 0; i < cells.length; i++) cells[i] ??= "";
			rows.push({ n, cells });
		});
		out.push(...rowsToBlocks(rows, ws.name));
	});
	return out;
}

function cellText(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (v instanceof Date) return v.toISOString().slice(0, 10);
	if (typeof v === "object") {
		const o = v as any;
		if (Array.isArray(o.richText)) return o.richText.map((r: any) => r.text).join("");
		if ("result" in o) return cellText(o.result);
		if ("text" in o) return String(o.text);
		if ("error" in o) return String(o.error);
		return JSON.stringify(o);
	}
	return String(v);
}

// ---------- json ----------
function parseJson(text: string): Block[] {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (e) {
		throw new ParseError("parse_error", `JSON 格式错误：${(e as Error).message}`);
	}
	const groups = new Map<string, string[]>();
	const add = (group: string, line: string) => {
		if (!groups.has(group)) groups.set(group, []);
		groups.get(group)!.push(line);
	};
	const walk = (v: unknown, path: string, group: string) => {
		if (v !== null && typeof v === "object") {
			const entries = Array.isArray(v) ? v.map((x, i) => [`[${i}]`, x] as const) : Object.entries(v).map(([k, x]) => [/^[\w$]+$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`, x] as const);
			if (!entries.length) add(group || "$", `${path || "$"}: ${Array.isArray(v) ? "[]" : "{}"}`);
			for (const [k, x] of entries) {
				const p = `${path}${k}`;
				walk(x, p, group || p);
			}
		} else add(group || "$", `${path || "$"}: ${String(v)}`);
	};
	walk(data, "", "");
	const out: Block[] = [];
	let n = 1;
	for (const [g, lines] of groups) out.push({ text: lines.join("\n"), section: g.replace(/^\./, ""), paragraph: n++ });
	return out;
}

// ---------- pdf ----------
async function parsePdf(bytes: Uint8Array): Promise<ParseResult> {
	const { extractText, getDocumentProxy } = await import("unpdf");
	let pages: string[];
	let total: number;
	try {
		const pdf = await getDocumentProxy(new Uint8Array(bytes));
		const r = await extractText(pdf, { mergePages: false });
		pages = r.text as string[];
		total = r.totalPages;
	} catch (e) {
		const msg = (e as Error).message ?? String(e);
		if (/password/i.test(msg)) throw new ParseError("encrypted", "PDF 已加密，无法提取文字");
		throw new ParseError("parse_error", `无法解析 PDF：${msg}`);
	}
	const blocks: Block[] = [];
	pages.forEach((text, i) => {
		let n = 1;
		for (const p of text.replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
			const t = norm(p);
			if (t) blocks.push({ text: t, page: i + 1, paragraph: n++ });
		}
	});
	return { format: "pdf", blocks, pageCount: total };
}
