// Light-weight attachment metadata for the model-facing message text (round 17).
import JSZip from "jszip";

export function humanSize(b: number): string {
	return b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
}

const MAX_XLSX = 25 * 1024 * 1024;

/** Sheet names of an .xlsx from xl/workbook.xml only (no cell parsing, so cheap). Any failure → no names. */
export async function sheetNames(bytes: Uint8Array | null | undefined): Promise<string[]> {
	if (!bytes || bytes.length > MAX_XLSX) return [];
	try {
		const zip = await JSZip.loadAsync(bytes);
		const xml = await zip.file("xl/workbook.xml")?.async("string");
		if (!xml) return [];
		const out: string[] = [];
		for (const m of xml.matchAll(/<sheet\b[^>]*?\bname="([^"]*)"/g)) out.push(unescapeXml(m[1]!));
		return out;
	} catch {
		return [];
	}
}

const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");
