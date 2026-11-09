import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}

export function formatBytes(n: number | undefined): string {
	if (n === undefined || n === null || Number.isNaN(n)) return "";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const rtf = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" }) : null;
export function relTime(iso: string | number | undefined): string {
	if (!iso) return "";
	const t = typeof iso === "number" ? iso : Date.parse(iso);
	if (Number.isNaN(t)) return "";
	const d = (t - Date.now()) / 1000;
	const a = Math.abs(d);
	if (!rtf) return new Date(t).toLocaleString("zh-CN");
	if (a < 45) return "刚刚";
	if (a < 3600) return rtf.format(Math.round(d / 60), "minute");
	if (a < 86400) return rtf.format(Math.round(d / 3600), "hour");
	if (a < 86400 * 7) return rtf.format(Math.round(d / 86400), "day");
	return new Date(t).toLocaleDateString("zh-CN");
}

export function fullTime(iso: string | number | undefined): string {
	if (!iso) return "";
	const t = typeof iso === "number" ? iso : Date.parse(iso);
	return Number.isNaN(t) ? "" : new Date(t).toLocaleString("zh-CN", { hour12: false });
}

export function durationText(ms: number | undefined): string {
	if (ms === undefined || ms < 0) return "";
	if (ms < 1000) return `${ms} ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} 秒`;
	const m = Math.floor(s / 60);
	return `${m} 分 ${Math.round(s % 60)} 秒`;
}

export function greeting(name?: string): string {
	const h = new Date().getHours();
	const part = h < 6 ? "夜深了" : h < 11 ? "早上好" : h < 13 ? "中午好" : h < 18 ? "下午好" : "晚上好";
	return name ? `${part}，${name}` : part;
}

export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand("copy");
		ta.remove();
		return ok;
	}
}

export function downloadText(name: string, text: string, mime = "text/markdown"): void {
	const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Usage that is simulated (fixture model / faux provider) must never be shown as a token count. */
export function isSimulatedUsage(u: { fixture?: boolean; simulated?: boolean } | undefined, fixtureTurn = false): boolean {
	return !!(u?.simulated || u?.fixture || fixtureTurn);
}
export const SIMULATED_USAGE = "测试模型 · 模拟用量，不计费";
