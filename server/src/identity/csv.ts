// Minimal RFC 4180 CSV writer (with formula-injection guard for spreadsheet apps).
export function toCsv(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
	const cell = (v: unknown): string => {
		if (v === null || v === undefined) return "";
		let s = typeof v === "object" ? JSON.stringify(v) : String(v);
		if (/^[=+\-@\t\r]/.test(s) && typeof v === "string") s = `'${s}`;
		return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};
	return [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}
