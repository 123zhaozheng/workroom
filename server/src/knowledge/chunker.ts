// Chunking with anchors. Chunks never cross an anchor boundary (page / section / sheet), so every citation points at
// exactly one page, one heading path or one sheet; within that unit consecutive blocks are packed up to MAX_CHARS.
import type { Block } from "./parsers.ts";

export const MAX_CHARS = 900;
const OVERLAP = 80;

export interface Chunk {
	ordinal: number;
	text: string;
	page?: number;
	section?: string;
	paragraph?: number;
	sheet?: string;
	rowStart?: number;
	rowEnd?: number;
	ocr?: boolean;
}

const unitKey = (b: Block) => `${b.page ?? ""}\u0001${b.section ?? ""}\u0001${b.sheet ?? ""}\u0001${b.ocr ? 1 : 0}`;

export function chunkBlocks(blocks: readonly Block[], maxChars = MAX_CHARS): Chunk[] {
	const out: Chunk[] = [];
	let cur: Chunk | null = null;
	let curKey = "";
	const flush = () => {
		if (cur && cur.text.trim()) out.push({ ...cur, ordinal: out.length + 1 });
		cur = null;
	};
	for (const b of blocks) {
		const key = unitKey(b);
		const pieces = b.text.length > maxChars ? splitLong(b.text, maxChars) : [b.text];
		for (const piece of pieces) {
			if (cur && (key !== curKey || (cur as Chunk).text.length + piece.length + 1 > maxChars)) flush();
			if (!cur) {
				cur = { ordinal: 0, text: piece, page: b.page, section: b.section, paragraph: b.paragraph, sheet: b.sheet, rowStart: b.rowStart, rowEnd: b.rowEnd, ...(b.ocr ? { ocr: true } : {}) };
				curKey = key;
			} else {
				const c: Chunk = cur;
				c.text += `\n${piece}`;
				if (b.rowStart !== undefined) c.rowStart = Math.min(c.rowStart ?? b.rowStart, b.rowStart);
				if (b.rowEnd !== undefined) c.rowEnd = Math.max(c.rowEnd ?? b.rowEnd, b.rowEnd);
			}
		}
	}
	flush();
	return out;
}

/** Split an over-long block at sentence ends (CJK + Latin), then hard-wrap, with a small overlap between pieces. */
export function splitLong(text: string, maxChars: number): string[] {
	const sentences = text.split(/(?<=[。！？!?；;\n])|(?<=\.\s)/).filter((s) => s.length > 0);
	const out: string[] = [];
	let cur = "";
	for (let s of sentences) {
		while (s.length > maxChars) {
			if (cur) {
				out.push(cur);
				cur = "";
			}
			out.push(s.slice(0, maxChars));
			s = s.slice(maxChars - OVERLAP);
		}
		if (cur.length + s.length > maxChars) {
			out.push(cur);
			cur = cur.slice(-OVERLAP);
		}
		cur += s;
	}
	if (cur.trim()) out.push(cur);
	return out.map((x) => x.trim()).filter(Boolean);
}

/** Human-readable locator for a chunk/citation. */
export function locatorOf(c: { page?: number | null; section?: string | null; paragraph?: number | null; sheet?: string | null; rowStart?: number | null; rowEnd?: number | null; ocr?: boolean | number | null }): string {
	if (c.page) return `第 ${c.page} 页${c.ocr ? "（OCR 识别）" : ""}`;
	if (c.ocr) return `OCR 识别${c.paragraph ? ` · 第 ${c.paragraph} 段` : ""}`;
	const rows = c.rowStart ? (c.rowEnd && c.rowEnd !== c.rowStart ? `第 ${c.rowStart}–${c.rowEnd} 行` : `第 ${c.rowStart} 行`) : "";
	if (c.sheet) return `${c.sheet} ${rows}`.trim();
	if (rows) return rows;
	if (c.section && c.paragraph) return `章节：${c.section} · 第 ${c.paragraph} 段`;
	if (c.section) return `章节：${c.section}`;
	if (c.paragraph) return `第 ${c.paragraph} 段`;
	return "原文片段";
}
