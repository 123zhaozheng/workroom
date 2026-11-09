// Deliverable generators: structured content → real, openable md / html / csv / docx / xlsx / pptx / pdf bytes.
import { readFileSync, existsSync } from "node:fs";
import * as docx from "docx";
import ExcelJS from "exceljs";
import PptxGenJS from "pptxgenjs";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { escapeHtml, markdownToHtml } from "./extract.ts";
import { page } from "./preview.ts";
import { MIME } from "./mime.ts";

export type Cell = string | number | boolean | null;
export interface DocSpec {
	readonly title?: string;
	/** Markdown-like text: `#` headings, `-`/`1.` lists, `|` tables, blank-line paragraphs. */
	readonly content?: string;
	readonly sections?: readonly { readonly heading?: string; readonly body?: string; readonly bullets?: readonly string[] }[];
	readonly table?: { readonly columns: readonly string[]; readonly rows: readonly (readonly Cell[])[] };
	readonly sheets?: readonly { readonly name: string; readonly columns?: readonly string[]; readonly rows: readonly (readonly Cell[])[] }[];
	readonly slides?: readonly { readonly title: string; readonly bullets?: readonly string[]; readonly notes?: string }[];
}
export const FORMATS = ["md", "html", "csv", "docx", "xlsx", "pptx", "pdf"] as const;
export type Format = (typeof FORMATS)[number];

export const FORMAT_MIME: Record<Format, string> = {
	md: MIME.md,
	html: MIME.html,
	csv: MIME.csv,
	docx: MIME.docx,
	xlsx: MIME.xlsx,
	pptx: MIME.pptx,
	pdf: MIME.pdf,
};

type Block =
	| { t: "h"; level: number; text: string }
	| { t: "p"; text: string }
	| { t: "ul"; items: string[]; ordered: boolean }
	| { t: "table"; columns: string[]; rows: Cell[][] };

const cellStr = (c: Cell | undefined): string => (c === null || c === undefined ? "" : String(c));

/** Inline markdown segments (**bold**, *italic*, `code`, [text](url)) for rich outputs. */
export function inlineRuns(text: string): { text: string; bold?: boolean; italic?: boolean; code?: boolean }[] {
	const out: { text: string; bold?: boolean; italic?: boolean; code?: boolean }[] = [];
	const re = /\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
	let last = 0;
	for (const m of text.matchAll(re)) {
		if (m.index! > last) out.push({ text: text.slice(last, m.index) });
		if (m[1] ?? m[2]) out.push({ text: (m[1] ?? m[2])!, bold: true });
		else if (m[3]) out.push({ text: m[3], code: true });
		else if (m[4]) out.push({ text: m[4], italic: true });
		else out.push({ text: `${m[5]} (${m[6]})` });
		last = m.index! + m[0].length;
	}
	if (last < text.length) out.push({ text: text.slice(last) });
	return out;
}
/** Plain text with inline markdown markers removed. */
export const plain = (text: string): string => inlineRuns(text).map((r) => r.text).join("");

/** Parse the markdown-lite `content` into blocks (no HTML pass-through). */
export function parseContent(text: string): Block[] {
	const blocks: Block[] = [];
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	let para: string[] = [];
	const flush = () => {
		if (para.length) blocks.push({ t: "p", text: para.join(" ").trim() });
		para = [];
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const h = /^(#{1,6})\s+(.*)$/.exec(line);
		const li = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
		if (h) {
			flush();
			blocks.push({ t: "h", level: h[1]!.length, text: h[2]!.trim() });
		} else if (li) {
			flush();
			const ordered = li[1] !== undefined;
			const last = blocks[blocks.length - 1];
			if (last?.t === "ul" && last.ordered === ordered) last.items.push(li[2]!.trim());
			else blocks.push({ t: "ul", items: [li[2]!.trim()], ordered });
		} else if (/^\s*\|.*\|\s*$/.test(line)) {
			flush();
			const rows: string[][] = [];
			while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
				const cells = lines[i]!.trim().slice(1, -1).split("|").map((c) => c.trim());
				if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
				i++;
			}
			i--;
			if (rows.length) blocks.push({ t: "table", columns: rows[0]!, rows: rows.slice(1) });
		} else if (!line.trim()) flush();
		else para.push(line.trim());
	}
	flush();
	return blocks;
}

export function toBlocks(spec: DocSpec): Block[] {
	const blocks: Block[] = [];
	if (spec.title) blocks.push({ t: "h", level: 1, text: spec.title });
	if (spec.content) blocks.push(...parseContent(spec.content));
	for (const s of spec.sections ?? []) {
		if (s.heading) blocks.push({ t: "h", level: 2, text: s.heading });
		if (s.body) blocks.push(...parseContent(s.body));
		if (s.bullets?.length) blocks.push({ t: "ul", items: [...s.bullets], ordered: false });
	}
	if (spec.table) blocks.push({ t: "table", columns: [...spec.table.columns], rows: spec.table.rows.map((r) => [...r]) });
	if (!spec.table && spec.sheets) for (const sh of spec.sheets) {
		blocks.push({ t: "h", level: 2, text: sh.name });
		blocks.push({ t: "table", columns: [...(sh.columns ?? [])], rows: sh.rows.map((r) => [...r]) });
	}
	if (spec.slides) for (const s of spec.slides) {
		blocks.push({ t: "h", level: 2, text: s.title });
		if (s.bullets?.length) blocks.push({ t: "ul", items: [...s.bullets], ordered: false });
	}
	return blocks;
}

// ---------- md / html / csv ----------
export function toMarkdown(spec: DocSpec): string {
	const out: string[] = [];
	for (const b of toBlocks(spec)) {
		if (b.t === "h") out.push(`${"#".repeat(b.level)} ${b.text}`);
		else if (b.t === "p") out.push(b.text);
		else if (b.t === "ul") out.push(b.items.map((it, i) => (b.ordered ? `${i + 1}. ${it}` : `- ${it}`)).join("\n"));
		else {
			const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
			const cols = b.columns.length ? b.columns : (b.rows[0] ?? []).map((_, i) => `列${i + 1}`);
			out.push([`| ${cols.map(esc).join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`, ...b.rows.map((r) => `| ${cols.map((_, i) => esc(cellStr(r[i]))).join(" | ")} |`)].join("\n"));
		}
	}
	return `${out.join("\n\n")}\n`;
}

export function toHtml(spec: DocSpec): string {
	return page(spec.title ?? "文档", markdownToHtml(toMarkdown(spec)));
}

function tableSource(spec: DocSpec): { columns: string[]; rows: Cell[][] } | null {
	if (spec.table) return { columns: [...spec.table.columns], rows: spec.table.rows.map((r) => [...r]) };
	if (spec.sheets?.[0]) return { columns: [...(spec.sheets[0].columns ?? [])], rows: spec.sheets[0].rows.map((r) => [...r]) };
	const t = toBlocks(spec).find((b) => b.t === "table");
	return t && t.t === "table" ? { columns: t.columns, rows: t.rows } : null;
}

export function toCsv(spec: DocSpec): string {
	const t = tableSource(spec);
	if (!t) throw new Error("csv 需要 table、sheets 或 content 中的表格");
	const q = (c: Cell) => {
		const s = cellStr(c);
		return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};
	const rows = t.columns.length ? [t.columns, ...t.rows] : t.rows;
	return `﻿${rows.map((r) => r.map(q).join(",")).join("\r\n")}\r\n`;
}

// ---------- docx ----------
export async function toDocx(spec: DocSpec): Promise<Uint8Array> {
	const runs = (t: string) => inlineRuns(t).map((r) => new docx.TextRun({ text: r.text, bold: r.bold, italics: r.italic, font: r.code ? "Consolas" : undefined }));
	const children: (docx.Paragraph | docx.Table)[] = [];
	const H = [docx.HeadingLevel.HEADING_1, docx.HeadingLevel.HEADING_2, docx.HeadingLevel.HEADING_3, docx.HeadingLevel.HEADING_4, docx.HeadingLevel.HEADING_5, docx.HeadingLevel.HEADING_6];
	const blocks = toBlocks(spec);
	for (const b of blocks) {
		if (b.t === "h") children.push(new docx.Paragraph({ heading: b.level === 1 && b === blocks[0] && spec.title ? docx.HeadingLevel.TITLE : H[b.level - 1], children: [new docx.TextRun(b.text)] }));
		else if (b.t === "p") children.push(new docx.Paragraph({ children: runs(b.text) }));
		else if (b.t === "ul") for (const it of b.items) children.push(new docx.Paragraph(b.ordered ? { numbering: { reference: "wr-num", level: 0 }, children: runs(it) } : { bullet: { level: 0 }, children: runs(it) }));
		else {
			const cols = b.columns.length ? b.columns : (b.rows[0] ?? []).map(() => "");
			const mk = (cells: readonly Cell[], header: boolean) =>
				new docx.TableRow({
					tableHeader: header,
					children: cols.map((_, i) => new docx.TableCell({ children: [new docx.Paragraph({ children: [new docx.TextRun({ text: cellStr(cells[i]), bold: header })] })] })),
				});
			children.push(new docx.Table({ width: { size: 100, type: docx.WidthType.PERCENTAGE }, rows: [...(b.columns.length ? [mk(b.columns, true)] : []), ...b.rows.map((r) => mk(r, false))] }));
			children.push(new docx.Paragraph({ children: [] }));
		}
	}
	const doc = new docx.Document({
		creator: "Workroom",
		title: spec.title ?? "文档",
		numbering: { config: [{ reference: "wr-num", levels: [{ level: 0, format: docx.LevelFormat.DECIMAL, text: "%1.", alignment: docx.AlignmentType.START }] }] },
		sections: [{ children: children.length ? children : [new docx.Paragraph("")] }],
	});
	return new Uint8Array(await docx.Packer.toBuffer(doc));
}

// ---------- xlsx ----------
export async function toXlsx(spec: DocSpec): Promise<Uint8Array> {
	const wb = new ExcelJS.Workbook();
	wb.creator = "Workroom";
	let sheets = spec.sheets?.map((s) => ({ name: s.name, columns: [...(s.columns ?? [])], rows: s.rows.map((r) => [...r]) }));
	if (!sheets?.length) {
		const t = tableSource(spec);
		if (t) sheets = [{ name: spec.title?.slice(0, 31) || "Sheet1", ...t }];
		else sheets = [{ name: "Sheet1", columns: [], rows: toBlocks(spec).map((b) => [b.t === "table" ? "" : b.t === "ul" ? b.items.join("\n") : b.text]) }];
	}
	const used = new Set<string>();
	for (const s of sheets) {
		let name = (s.name || "Sheet").replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet";
		for (let n = 2; used.has(name); n++) name = `${name.slice(0, 28)} ${n}`;
		used.add(name);
		const ws = wb.addWorksheet(name);
		if (s.columns.length) {
			const r = ws.addRow(s.columns);
			r.font = { bold: true };
			ws.views = [{ state: "frozen", ySplit: 1 }];
		}
		for (const row of s.rows) {
			ws.addRow(row.map((c) => (typeof c === "string" && c.startsWith("=") && c.length > 1 ? { formula: c.slice(1) } : c)));
		}
		const width = Math.max(s.columns.length, ...s.rows.map((r) => r.length), 1);
		for (let i = 1; i <= width; i++) {
			const lens = [s.columns[i - 1], ...s.rows.map((r) => r[i - 1])].map((c) => [...cellStr(c ?? null)].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0));
			ws.getColumn(i).width = Math.min(Math.max(10, ...lens) + 2, 60);
		}
	}
	return new Uint8Array(await wb.xlsx.writeBuffer());
}

// ---------- pptx ----------
export async function toPptx(spec: DocSpec): Promise<Uint8Array> {
	const pres = new (PptxGenJS as unknown as { new (): any })();
	pres.layout = "LAYOUT_WIDE";
	pres.title = spec.title ?? "演示稿";
	const font = "Microsoft YaHei";
	let slides = spec.slides?.map((s) => ({ title: s.title, bullets: [...(s.bullets ?? [])], notes: s.notes, table: undefined as undefined | { columns: string[]; rows: Cell[][] } }));
	if (!slides?.length) {
		slides = [];
		let cur: (typeof slides)[number] | undefined;
		for (const b of toBlocks({ ...spec, title: undefined })) {
			if (b.t === "h" && b.level <= 2) {
				cur = { title: b.text, bullets: [], notes: undefined, table: undefined };
				slides.push(cur);
				continue;
			}
			if (!cur) {
				cur = { title: spec.title ?? "", bullets: [], notes: undefined, table: undefined };
				slides.push(cur);
			}
			if (b.t === "h" || b.t === "p") cur.bullets.push(plain(b.text));
			else if (b.t === "ul") cur.bullets.push(...b.items.map(plain));
			else cur.table = { columns: b.columns, rows: b.rows };
		}
	}
	if (spec.title) {
		const s = pres.addSlide();
		s.addText(spec.title, { x: 0.6, y: 2.6, w: 12.1, h: 1.2, fontSize: 36, bold: true, align: "center", fontFace: font });
	}
	for (const sd of slides) {
		const s = pres.addSlide();
		s.addText(sd.title, { x: 0.5, y: 0.3, w: 12.3, h: 0.9, fontSize: 28, bold: true, fontFace: font });
		if (sd.bullets.length) s.addText(sd.bullets.map((t) => ({ text: t, options: { bullet: true, breakLine: true } })), { x: 0.7, y: 1.4, w: 11.9, h: sd.table ? 1.8 : 5.6, fontSize: 18, valign: "top", fontFace: font });
		if (sd.table) {
			const rows = [sd.table.columns, ...sd.table.rows].filter((r) => r.length).map((r) => r.map((c) => ({ text: cellStr(c) })));
			if (rows.length) s.addTable(rows, { x: 0.7, y: sd.bullets.length ? 3.3 : 1.4, w: 11.9, fontSize: 12, border: { type: "solid", pt: 0.5, color: "999999" }, fontFace: font });
		}
		if (sd.notes) s.addNotes(sd.notes);
	}
	const out = (await pres.write({ outputType: "nodebuffer" })) as Buffer;
	return new Uint8Array(out);
}

// ---------- pdf ----------
const FONT_CANDIDATES = [
	process.env.WORKROOM_PDF_FONT,
	"/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
	"/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
	"/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
	"/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
].filter(Boolean) as string[];

/** Extract one font of a TrueType Collection as a standalone TTF (pdf-lib embeds single fonts only). */
export function ttcToTtf(buf: Buffer, index = 0): Buffer {
	if (buf.toString("ascii", 0, 4) !== "ttcf") return buf;
	const off = buf.readUInt32BE(12 + 4 * index);
	const numTables = buf.readUInt16BE(off + 4);
	const headerLen = 12 + 16 * numTables;
	const tables = Array.from({ length: numTables }, (_, i) => {
		const rec = off + 12 + 16 * i;
		return { rec, offset: buf.readUInt32BE(rec + 8), length: buf.readUInt32BE(rec + 12) };
	});
	const align = (n: number) => (n + 3) & ~3;
	const out = Buffer.alloc(headerLen + tables.reduce((n, t) => n + align(t.length), 0));
	buf.copy(out, 0, off, off + 12);
	let pos = headerLen;
	tables.forEach((t, i) => {
		buf.copy(out, 12 + 16 * i, t.rec, t.rec + 8); // tag + checksum
		out.writeUInt32BE(pos, 12 + 16 * i + 8);
		out.writeUInt32BE(t.length, 12 + 16 * i + 12);
		buf.copy(out, pos, t.offset, t.offset + t.length);
		pos += align(t.length);
	});
	return out;
}

let cachedFont: { path: string; bytes: Buffer } | null | undefined;
function unicodeFont(): { path: string; bytes: Buffer } | null {
	if (cachedFont !== undefined) return cachedFont;
	cachedFont = null;
	for (const p of FONT_CANDIDATES) {
		if (p && existsSync(p)) {
			try {
				cachedFont = { path: p, bytes: ttcToTtf(readFileSync(p)) };
				break;
			} catch {
				/* try next */
			}
		}
	}
	return cachedFont;
}

/** Whether PDFs can render CJK text (a Unicode font was found). */
export function pdfFontStatus(): string {
	const f = unicodeFont();
	return f ? `available: ${f.path}` : "fallback: 未找到 CJK 字体（设置 WORKROOM_PDF_FONT），PDF 中非拉丁字符会显示为 ?";
}

export interface PdfResult {
	bytes: Uint8Array;
	warnings: string[];
}

export async function toPdf(spec: DocSpec): Promise<PdfResult> {
	const warnings: string[] = [];
	const pdf = await PDFDocument.create();
	pdf.setTitle(spec.title ?? "文档");
	pdf.setCreator("Workroom");
	pdf.setProducer("Workroom (pdf-lib)");
	let font: PDFFont;
	let bold: PDFFont;
	const uf = unicodeFont();
	const needsUnicode = /[^\u0000-ÿ]/.test(JSON.stringify(spec));
	if (uf && needsUnicode) {
		pdf.registerFontkit(fontkit);
		font = await pdf.embedFont(uf.bytes, { subset: true });
		bold = font;
	} else {
		font = await pdf.embedFont(StandardFonts.Helvetica);
		bold = await pdf.embedFont(StandardFonts.HelveticaBold);
		if (needsUnicode) warnings.push("未找到 CJK 字体（设置 WORKROOM_PDF_FONT），非拉丁字符以 ? 代替");
	}
	const safe = (s: string) => {
		if (font !== bold || !needsUnicode || uf) return s.replace(/[\u0000-\u0008\u000b-\u001f]/g, "");
		return s.replace(/[^ -ÿ]/g, "?");
	};
	const W = 595.28;
	const Hh = 841.89;
	const M = 56;
	let pageRef: PDFPage = pdf.addPage([W, Hh]);
	let y = Hh - M;
	const newPage = () => {
		pageRef = pdf.addPage([W, Hh]);
		y = Hh - M;
	};
	const wrap = (text: string, f: PDFFont, size: number, width: number): string[] => {
		const out: string[] = [];
		for (const para of safe(text).split("\n")) {
			let line = "";
			for (const ch of [...para]) {
				const next = line + ch;
				if (f.widthOfTextAtSize(next, size) <= width) {
					line = next;
					continue;
				}
				const sp = line.lastIndexOf(" ");
				if (/[\u0000-ɏ]/.test(ch) && ch !== " " && sp > 0 && sp > line.length - 30) {
					out.push(line.slice(0, sp));
					line = line.slice(sp + 1) + ch;
				} else {
					out.push(line);
					line = ch === " " ? "" : ch;
				}
			}
			out.push(line);
		}
		return out;
	};
	const draw = (text: string, opts: { size: number; f?: PDFFont; indent?: number; gap?: number; color?: [number, number, number] }) => {
		const f = opts.f ?? font;
		const lh = opts.size * 1.45;
		for (const ln of wrap(text, f, opts.size, W - 2 * M - (opts.indent ?? 0))) {
			if (y - lh < M) newPage();
			y -= lh;
			pageRef.drawText(ln, { x: M + (opts.indent ?? 0), y, size: opts.size, font: f, color: rgb(...(opts.color ?? [0.12, 0.14, 0.16])) });
		}
		y -= opts.gap ?? 6;
	};
	for (const b of toBlocks(spec)) {
		if (b.t === "h") draw(b.text, { size: [22, 17, 14, 13, 12, 12][b.level - 1]!, f: bold, gap: 8 });
		else if (b.t === "p") draw(plain(b.text), { size: 11 });
		else if (b.t === "ul") b.items.forEach((it, i) => draw(`${b.ordered ? `${i + 1}.` : "·"} ${plain(it)}`, { size: 11, indent: 12, gap: 2 }));
		else {
			const rows = [...(b.columns.length ? [b.columns] : []), ...b.rows];
			const n = Math.max(...rows.map((r) => r.length), 1);
			const colW = (W - 2 * M) / n;
			for (const [ri, r] of rows.entries()) {
				const cellLines = Array.from({ length: n }, (_, i) => wrap(cellStr(r[i] ?? null), ri === 0 && b.columns.length ? bold : font, 9.5, colW - 6));
				const h = Math.max(...cellLines.map((l) => l.length)) * 13 + 6;
				if (y - h < M) newPage();
				for (let i = 0; i < n; i++) {
					pageRef.drawRectangle({ x: M + i * colW, y: y - h, width: colW, height: h, borderColor: rgb(0.75, 0.78, 0.8), borderWidth: 0.5, color: ri === 0 && b.columns.length ? rgb(0.95, 0.96, 0.97) : undefined });
					cellLines[i]!.forEach((ln, li) => pageRef.drawText(ln, { x: M + i * colW + 3, y: y - 13 - li * 13, size: 9.5, font: ri === 0 && b.columns.length ? bold : font }));
				}
				y -= h;
			}
			y -= 10;
		}
	}
	return { bytes: await pdf.save(), warnings };
}

export interface Generated {
	bytes: Uint8Array;
	mime: string;
	warnings: string[];
}
export async function generate(format: Format, spec: DocSpec): Promise<Generated> {
	const enc = (s: string) => new TextEncoder().encode(s);
	switch (format) {
		case "md":
			return { bytes: enc(toMarkdown(spec)), mime: FORMAT_MIME.md, warnings: [] };
		case "html":
			return { bytes: enc(toHtml(spec)), mime: FORMAT_MIME.html, warnings: [] };
		case "csv":
			return { bytes: enc(toCsv(spec)), mime: FORMAT_MIME.csv, warnings: [] };
		case "docx":
			return { bytes: await toDocx(spec), mime: FORMAT_MIME.docx, warnings: [] };
		case "xlsx":
			return { bytes: await toXlsx(spec), mime: FORMAT_MIME.xlsx, warnings: [] };
		case "pptx":
			return { bytes: await toPptx(spec), mime: FORMAT_MIME.pptx, warnings: [] };
		case "pdf": {
			const r = await toPdf(spec);
			return { bytes: r.bytes, mime: FORMAT_MIME.pdf, warnings: r.warnings };
		}
	}
}

export { escapeHtml };
