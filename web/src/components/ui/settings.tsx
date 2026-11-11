// Settings layout primitives (ChatGPT-like): content column ≤ 720px, grouped rows with thin dividers, label (+ one-line hint) on
// the left and the control right-aligned. SettingsNav is the left list (a horizontal strip on phones) for tabbed pages.
import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/utils";

export function SettingsGroup({ title, action, children, testId, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; testId?: string; className?: string }) {
	return (
		<section data-testid={testId} className={cn("mb-8", className)}>
			{title || action ? (
				<div className="mb-1 flex min-h-8 items-center gap-2">
					{title ? <h2 className="flex-1 text-sm font-semibold">{title}</h2> : <span className="flex-1" />}
					{action}
				</div>
			) : null}
			<div className="divide-y divide-border border-y border-border">{children}</div>
		</section>
	);
}

/** One setting: label (+ short hint) left, control right. Stacks on phones when `stack` is set or the control is wide. */
export function SettingsRow({ label, hint, children, htmlFor, stack, testId }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; htmlFor?: string; stack?: boolean; testId?: string }) {
	return (
		<div data-testid={testId} className={cn("flex gap-x-4 gap-y-2 py-3.5", stack ? "flex-col sm:flex-row sm:items-center" : "items-center")}>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1 text-sm">
					{htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
				</div>
				{hint ? <div className="mt-0.5 text-xs text-fg-muted">{hint}</div> : null}
			</div>
			{children ? <div className="flex shrink-0 items-center justify-end gap-2 text-sm text-fg-muted">{children}</div> : null}
		</div>
	);
}

export function SettingsContent({ children, className }: { children: ReactNode; className?: string }) {
	return <div data-testid="settings-content" className={cn("w-full max-w-[720px]", className)}>{children}</div>;
}

export interface SettingsNavItem {
	value: string;
	label: string;
	to: string;
	testId?: string;
}
export function SettingsNav({ label, items, current }: { label: string; items: SettingsNavItem[]; current: string }) {
	return (
		<nav aria-label={label} className="-mx-4 overflow-x-auto px-4 md:sticky md:top-0 md:mx-0 md:w-44 md:shrink-0 md:overflow-visible md:px-0">
			<div className="flex w-max gap-1 md:w-auto md:flex-col md:gap-0.5">
				{items.map((t) => (
					<Link
						key={t.value}
						to={t.to}
						data-testid={t.testId ?? `settings-nav-${t.value}`}
						aria-current={t.value === current ? "page" : undefined}
						className={cn("inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-lg px-3 text-sm", t.value === current ? "bg-surface-2 font-medium text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg")}
					>
						{t.label}
					</Link>
				))}
			</div>
		</nav>
	);
}
