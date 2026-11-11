// Shared building blocks for the admin tabs.
import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import { errorText } from "@/lib/api";
import { cn } from "@/lib/utils";

export const ROLE: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员", guest: "访客" };

/** Runs an action, reports its error inline (success needs no banner), then refreshes. */
export function useAct(after: () => void) {
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	const run = async (fn: () => Promise<unknown>) => {
		setBusy(true);
		setErr(undefined);
		try {
			await fn();
			after();
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	const note = err ? <p className="my-2 rounded-lg bg-danger-soft px-3 py-1.5 text-sm text-danger" role="alert">{err}</p> : null;
	return { busy, run, note };
}

export function Table({ children, testId }: { children: ReactNode; testId?: string }) {
	return (
		<div data-testid={testId} className="overflow-hidden rounded-xl border border-border bg-surface [&>div+div]:border-t [&>div+div]:border-border">
			{children}
		</div>
	);
}
export function Row({ children }: { children: ReactNode }) {
	return <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">{children}</div>;
}

/** Collapsed-by-default block for technical detail or rarely used settings. */
export function Fold({ title, hint, children, testId, defaultOpen }: { title: string; hint?: string; children: ReactNode; testId?: string; defaultOpen?: boolean }) {
	return (
		<details data-testid={testId} open={defaultOpen} className="group rounded-lg border border-border">
			<summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium text-fg-muted hover:text-fg [&::-webkit-details-marker]:hidden">
				<ChevronDown aria-hidden className="size-4 shrink-0 -rotate-90 transition-transform group-open:rotate-0" />
				{title}
				{hint ? <span className="truncate text-xs font-normal text-fg-subtle">{hint}</span> : null}
			</summary>
			<div className="border-t border-border px-3 py-3">{children}</div>
		</details>
	);
}

/** Title row of a page section: left title, right actions. */
export function SectionHead({ title, children, className }: { title: ReactNode; children?: ReactNode; className?: string }) {
	return (
		<div className={cn("mb-3 flex flex-wrap items-center gap-2", className)}>
			<h3 className="min-w-0 flex-1 text-sm font-medium">{title}</h3>
			{children}
		</div>
	);
}

/** Page section with a title and optional right-side action (Settings and 我的权限 share it so every section looks the same). */
export function Section({ title, action, children, testId, className }: { title: string; action?: ReactNode; children: ReactNode; testId?: string; className?: string }) {
	return (
		<section className={cn("mb-8", className)} data-testid={testId}>
			<div className="mb-2 flex min-h-8 items-center gap-2">
				<h2 className="flex-1 text-sm font-semibold">{title}</h2>
				{action}
			</div>
			{children}
		</section>
	);
}
