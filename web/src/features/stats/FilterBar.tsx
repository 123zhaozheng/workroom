// Filter bar: scope, range presets, custom range, granularity. State lives in the URL (shareable, survives reload).
import { useMemo } from "react";
import type { StatsGranularity, StatsScopesDTO } from "@shared/ops";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { addDays, isoLocalDate, startOfLocalDay, tzOffsetMinutes } from "./format";

export type Preset = "7d" | "30d" | "90d" | "mtd" | "365d" | "custom";
export const PRESETS: { value: Preset; label: string }[] = [
	{ value: "7d", label: "近 7 天" },
	{ value: "30d", label: "近 30 天" },
	{ value: "90d", label: "近 90 天" },
	{ value: "mtd", label: "本月" },
	{ value: "365d", label: "近 12 个月" },
	{ value: "custom", label: "自定义" },
];
export const GRANS: { value: StatsGranularity; label: string }[] = [
	{ value: "hour", label: "小时" },
	{ value: "day", label: "天" },
	{ value: "week", label: "周" },
];

export interface Filters {
	scope: string;
	preset: Preset;
	/** yyyy-mm-dd, inclusive (custom only). */
	from: string;
	to: string;
	/** explicit choice; otherwise a default per preset */
	gran: StatsGranularity | null;
}

export const defaultGran = (p: Preset, days: number): StatsGranularity => (p === "7d" ? "day" : days > 120 ? "week" : "day");

export function resolveRange(f: Filters): { from: Date; to: Date; days: number } {
	const today = startOfLocalDay();
	const tomorrow = addDays(today, 1);
	let from: Date;
	let to = tomorrow;
	switch (f.preset) {
		case "7d":
			from = addDays(today, -6);
			break;
		case "30d":
			from = addDays(today, -29);
			break;
		case "90d":
			from = addDays(today, -89);
			break;
		case "365d":
			from = addDays(today, -364);
			break;
		case "mtd":
			from = new Date(today.getFullYear(), today.getMonth(), 1);
			break;
		default: {
			const p = (s: string) => {
				const [y, m, d] = s.split("-").map(Number);
				return new Date(y!, m! - 1, d!);
			};
			from = f.from ? p(f.from) : addDays(today, -29);
			to = addDays(f.to ? p(f.to) : today, 1);
			if (to <= from) to = addDays(from, 1);
		}
	}
	return { from, to, days: Math.round((to.getTime() - from.getTime()) / 86_400_000) };
}

/** Query string shared by /stats/overview and every CSV link. */
export function buildQuery(f: Filters): string {
	const r = resolveRange(f);
	const g = f.gran ?? defaultGran(f.preset, r.days);
	return new URLSearchParams({ scope: f.scope, from: r.from.toISOString(), to: r.to.toISOString(), granularity: g, tz: String(tzOffsetMinutes()) }).toString();
}

export function FilterBar({ value, onChange, scopes, adjusted }: { value: Filters; /** Receives only the changed fields: the page merges them into the latest URL state, so quick successive edits are not lost. */ onChange: (patch: Partial<Filters>) => void; scopes: StatsScopesDTO | undefined; adjusted?: string | null }) {
	const range = useMemo(() => resolveRange(value), [value]);
	const gran = value.gran ?? defaultGran(value.preset, range.days);
	const set = (p: Partial<Filters>) => onChange(p);
	const today = isoLocalDate(new Date());
	return (
		<div data-testid="filter-bar" className="sticky top-0 z-10 -mx-4 mb-4 border-b border-border bg-bg/90 px-4 py-2.5 backdrop-blur sm:-mx-8 sm:px-8">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
				<label className="flex items-center gap-2 text-xs text-fg-muted">
					范围
					<Select data-testid="scope-select" aria-label="统计范围" className="h-8 w-auto min-w-[9rem] max-w-[16rem] text-sm" value={value.scope} onChange={(e) => set({ scope: e.target.value })}>
						{(scopes?.scopes ?? [{ key: "personal", kind: "personal" as const, label: "个人" }]).map((s) => (
							<option key={s.key} value={s.key}>
								{s.label}
							</option>
						))}
					</Select>
				</label>
				<div role="radiogroup" aria-label="时间范围" className="flex flex-wrap gap-1" data-testid="range-presets">
					{PRESETS.map((p) => (
						<button key={p.value} type="button" role="radio" aria-checked={value.preset === p.value} onClick={() => set({ preset: p.value, ...(p.value === "custom" && !value.from ? { from: isoLocalDate(range.from), to: isoLocalDate(addDays(range.to, -1)) } : {}) })} className={cn("h-8 rounded-md border px-2.5 text-sm transition-colors", value.preset === p.value ? "border-fg bg-fg text-bg" : "border-border text-fg-muted hover:border-border-strong hover:text-fg")}>
							{p.label}
						</button>
					))}
				</div>
				{value.preset === "custom" ? (
					<div className="flex items-center gap-1.5 text-sm" data-testid="custom-range">
						<input type="date" aria-label="开始日期" max={value.to || today} value={value.from} onChange={(e) => set({ from: e.target.value })} className="h-8 rounded-md border border-border bg-surface px-2 text-sm" />
						<span className="text-fg-subtle">至</span>
						<input type="date" aria-label="结束日期（含）" min={value.from} max={today} value={value.to} onChange={(e) => set({ to: e.target.value })} className="h-8 rounded-md border border-border bg-surface px-2 text-sm" />
					</div>
				) : null}
				<div role="radiogroup" aria-label="粒度" className="ml-auto inline-flex items-center gap-1 text-xs text-fg-muted" data-testid="granularity">
					粒度
					<div className="inline-flex rounded-md border border-border bg-surface-2 p-0.5">
						{GRANS.map((g) => (
							<button key={g.value} type="button" role="radio" aria-checked={gran === g.value} onClick={() => set({ gran: g.value })} className={cn("h-7 rounded px-2.5 text-sm", gran === g.value ? "bg-surface font-medium text-fg shadow-sm" : "text-fg-muted hover:text-fg")}>
								{g.label}
							</button>
						))}
					</div>
				</div>
			</div>
			{adjusted ? (
				<p className="mt-1.5 text-xs text-warning" role="status">
					{adjusted}
				</p>
			) : null}
		</div>
	);
}
