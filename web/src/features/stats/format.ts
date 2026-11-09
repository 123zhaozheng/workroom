// Number / date formatting for the analytics page (zh-CN). Pure functions, no DOM.
const int = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
const dec1 = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });

export const fmtInt = (n: number | null | undefined): string => (n == null ? "—" : int.format(n));
/** 12,345 below 10,000; 1.2万 / 3.4亿 above. */
export const fmtCompact = (n: number | null | undefined): string => (n == null ? "—" : Math.abs(n) < 10_000 ? int.format(n) : compact.format(n));
export const fmtPct = (r: number | null | undefined, digits = 1): string => (r == null ? "—" : `${(r * 100).toLocaleString("zh-CN", { maximumFractionDigits: digits })}%`);
export function fmtMs(ms: number | null | undefined): string {
	if (ms == null) return "—";
	if (ms < 1000) return `${int.format(Math.round(ms))} 毫秒`;
	if (ms < 60_000) return `${dec1.format(ms / 1000)} 秒`;
	return `${dec1.format(ms / 60_000)} 分钟`;
}
export const fmtUsd = (n: number | null | undefined): string => (n == null ? "—" : n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** "2026-10-03" -> "10月3日" */
export function fmtDay(day: string): string {
	const [, m, d] = day.split("-");
	return `${Number(m)}月${Number(d)}日`;
}
const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
export const weekdayName = (i: number) => WEEKDAYS[i] ?? "";
/** Bucket label ("2026-10-03" | "2026-10-03 09:00") -> axis text per granularity. */
export function fmtBucket(b: string, gran: "hour" | "day" | "week", long = false): string {
	if (gran === "hour") {
		const [d, h] = b.split(" ");
		return long ? `${fmtDay(d!)} ${h}` : `${Number(d!.slice(5, 7))}/${Number(d!.slice(8, 10))} ${h!.slice(0, 2)}时`;
	}
	if (gran === "week") return long ? `${fmtDay(b)} 起的一周` : `${Number(b.slice(5, 7))}/${Number(b.slice(8, 10))}`;
	return long ? fmtDay(b) : `${Number(b.slice(5, 7))}/${Number(b.slice(8, 10))}`;
}

/** Local-time range helpers (the server buckets by the `tz` offset we send). */
export const tzOffsetMinutes = () => -new Date().getTimezoneOffset();
export const isoLocalDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export function startOfLocalDay(d = new Date()): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
