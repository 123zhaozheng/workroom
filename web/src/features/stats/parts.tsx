// Shared pieces for the analytics page: card frame with CSV link, hover tooltip layer for SVG charts, segmented control,
// empty state and skeletons. No chart library here (the Recharts panels live in RechartsPanels.tsx).
import { Download } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { InfoPop } from "@/components/shell/InfoPop";

export const SERIES_COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c6)", "var(--c7)", "var(--c8)"];
export const seriesColor = (key: string, index: number) => (key === "__other" ? "var(--c-other)" : SERIES_COLORS[index % SERIES_COLORS.length]!);

export const OUTCOME_META = {
	success: { label: "成功", color: "var(--st-success)" },
	failed: { label: "失败", color: "var(--st-failed)" },
	cancelled: { label: "已取消", color: "var(--st-cancelled)" },
	timeout: { label: "超时", color: "var(--st-timeout)" },
	awaiting_approval: { label: "待审批", color: "var(--st-approval)" },
	in_progress: { label: "进行中", color: "var(--st-progress)" },
} as const;

export function Card({ title, subtitle, actions, csv, children, className, testid }: { title: string; subtitle?: ReactNode; actions?: ReactNode; csv?: string | null; children: ReactNode; className?: string; testid?: string }) {
	return (
		<section data-testid={testid} aria-label={title} className={cn("min-w-0 rounded-xl border border-border bg-surface p-4", className)}>
			<header className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
				<div className="flex min-w-0 items-center gap-1">
					<h2 className="text-sm font-medium">{title}</h2>
					{subtitle ? <InfoPop label={`${title}：说明`}>{subtitle}</InfoPop> : null}
				</div>
				<div className="flex max-w-full flex-wrap items-center gap-2">
					{actions}
					{csv ? (
						<a href={csv} download data-testid="csv" aria-label={`导出 CSV：${title}`} title="导出 CSV" className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-fg-muted hover:border-border-strong hover:text-fg">
							<Download className="size-3.5" />
							CSV
						</a>
					) : null}
				</div>
			</header>
			{children}
		</section>
	);
}

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: readonly { value: T; label: string }[]; label: string }) {
	return (
		<div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-border bg-surface-2 p-0.5">
			{options.map((o) => (
				<button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)} className={cn("h-6 rounded px-2 text-xs transition-colors", value === o.value ? "bg-surface font-medium text-fg shadow-sm" : "text-fg-muted hover:text-fg")}>
					{o.label}
				</button>
			))}
		</div>
	);
}

export function Empty({ children, height = 160 }: { children: ReactNode; height?: number }) {
	return (
		<div data-testid="chart-empty" style={{ minHeight: height }} className="flex items-center justify-center rounded-lg border border-dashed border-border px-4 text-center text-sm text-fg-muted">
			{children}
		</div>
	);
}

export function Skeleton({ className }: { className?: string }) {
	return <div aria-hidden className={cn("animate-pulse rounded-md bg-surface-3", className)} />;
}

// ---- hover tooltip for SVG / HTML marks -----------------------------------------------------------------------
export interface TipState {
	x: number;
	y: number;
	content: ReactNode;
}
/** Returns handlers for marks inside a `relative` container, plus the tooltip element to render in that container. */
export function useTip() {
	const box = useRef<HTMLDivElement>(null);
	const [tip, setTip] = useState<TipState | null>(null);
	const show = useCallback((e: { clientX: number; clientY: number }, content: ReactNode) => {
		const r = box.current?.getBoundingClientRect();
		if (!r) return;
		setTip({ x: e.clientX - r.left, y: e.clientY - r.top, content });
	}, []);
	const showAt = useCallback((el: Element, content: ReactNode) => {
		const r = box.current?.getBoundingClientRect();
		const b = el.getBoundingClientRect();
		if (!r) return;
		setTip({ x: b.left - r.left + b.width / 2, y: b.top - r.top, content });
	}, []);
	const hide = useCallback(() => setTip(null), []);
	const el = (
		<div
			role="tooltip"
			data-testid="chart-tip"
			style={tip ? { left: tip.x, top: tip.y, transform: `translate(${tip.x > (box.current?.clientWidth ?? 0) - 180 ? "calc(-100% - 10px)" : "10px"}, ${tip.y < 70 ? "10px" : "calc(-100% - 8px)"})` } : undefined}
			className={cn("pointer-events-none absolute z-20 w-max max-w-[240px] rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs leading-5 text-fg shadow-[var(--shadow-pop)]", tip ? "block" : "hidden")}
		>
			{tip?.content}
		</div>
	);
	return { box, show, showAt, hide, el };
}

export function TipRow({ color, label, value, tag }: { color?: string; label: ReactNode; value: ReactNode; tag?: string }) {
	return (
		<div className="flex items-center justify-between gap-4">
			<span className="inline-flex items-center gap-1.5 text-fg-muted">
				{color ? <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: color }} /> : null}
				{label}
				{tag ? <span className="rounded bg-surface-3 px-1 text-xs text-fg-muted">{tag}</span> : null}
			</span>
			<span className="font-medium tabular-nums">{value}</span>
		</div>
	);
}

/** Sequential level (0..5) of a value against positive thresholds (quantile based, computed from the data shown). */
export function levelOf(v: number, thresholds: number[]): number {
	if (v <= 0) return 0;
	let l = 1;
	for (const t of thresholds) if (v > t) l++;
	return Math.min(l, 5);
}
export function thresholdsOf(values: number[]): number[] {
	const xs = values.filter((v) => v > 0).sort((a, b) => a - b);
	if (xs.length === 0) return [0, 0, 0, 0];
	const q = (p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
	return [q(0.25), q(0.5), q(0.75), q(0.92)].map((x, i, a) => (i > 0 && x <= a[i - 1]! ? a[i - 1]! : x));
}
export const SEQ = ["var(--seq-0)", "var(--seq-1)", "var(--seq-2)", "var(--seq-3)", "var(--seq-4)", "var(--seq-5)"];
