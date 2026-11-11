import { AlertTriangle, CircleSlash, Loader2, PlugZap, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { errorText } from "@/lib/api";
import { Button } from "./button";

export function Spinner({ className }: { className?: string }) {
	return <Loader2 aria-hidden className={cn("size-4 wr-spin text-fg-subtle", className)} />;
}

type Tone = "neutral" | "info" | "success" | "warning" | "danger";
const TONES: Record<Tone, string> = {
	neutral: "bg-surface-2 text-fg-muted",
	info: "bg-info-soft text-info",
	success: "bg-success-soft text-success",
	warning: "bg-warning-soft text-warning",
	danger: "bg-danger-soft text-danger",
};
export function Badge({ tone = "neutral", className, children, ...rest }: { tone?: Tone; className?: string; children: ReactNode; title?: string; [data: `data-${string}`]: string | undefined }) {
	return (
		<span {...rest} className={cn("inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-xs font-medium [&_svg]:size-3", TONES[tone], className)}>
			{children}
		</span>
	);
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
	return (
		<div className="flex flex-col items-center justify-center px-6 py-14 text-center">
			{icon ? <div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-surface-2 text-fg-muted [&_svg]:size-5">{icon}</div> : null}
			<div className="text-sm font-medium">{title}</div>
			{children ? <div className="mt-1.5 max-w-md text-sm text-fg-muted">{children}</div> : null}
			{action ? <div className="mt-4">{action}</div> : null}
		</div>
	);
}

/** Honest "not available" state for a capability whose server route is absent. `need` (the missing route) stays out of the way: tooltip / folded details. */
export function Unavailable({ what, need, compact }: { what: string; need?: string; compact?: boolean }) {
	if (compact)
		return (
			<div data-testid="unavailable" title={need ? `技术详情：${need}` : undefined} className="flex items-center gap-2 rounded-lg border border-dashed border-border-strong px-3 py-2 text-sm text-fg-muted">
				<PlugZap className="size-4 shrink-0" />
				<span>{what}暂不可用</span>
			</div>
		);
	return (
		<div data-testid="unavailable">
			<EmptyState icon={<PlugZap />} title={`${what}暂不可用`}>
				{need ? (
					<details className="text-xs text-fg-subtle">
						<summary className="cursor-pointer select-none rounded hover:text-fg-muted">技术详情</summary>
						<span className="mt-1 block break-words">缺少：{need}</span>
					</details>
				) : null}
			</EmptyState>
		</div>
	);
}

export function ErrorState({ error, onRetry, what }: { error: unknown; onRetry?: () => void; what?: string }) {
	return (
		<EmptyState icon={<AlertTriangle />} title={what ? `${what}加载失败` : "加载失败"} action={onRetry ? <Button size="sm" onClick={onRetry}><RotateCcw />重试</Button> : undefined}>
			{errorText(error)}
		</EmptyState>
	);
}

export function Blocked({ title, children }: { title: string; children?: ReactNode }) {
	return (
		<div className="flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-fg-muted">
			<CircleSlash className="mt-0.5 size-4 shrink-0" />
			<div>
				<div className="font-medium text-fg">{title}</div>
				{children}
			</div>
		</div>
	);
}

/** Wrapper for an async resource: loading / unavailable / error / content. */
export function Loadable({ state, what, need, children }: { state: { loading: boolean; error?: unknown; unavailable: boolean; reload: () => void }; what: string; need?: string; children: ReactNode }) {
	if (state.unavailable) return <Unavailable what={what} need={need} />;
	if (state.error) return <ErrorState error={state.error} onRetry={state.reload} what={what} />;
	if (state.loading)
		return (
			<div className="flex items-center gap-2 px-2 py-10 text-sm text-fg-subtle">
				<Spinner /> 加载中…
			</div>
		);
	return <>{children}</>;
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
	return (
		<div className="mb-6 flex flex-wrap items-end justify-between gap-3">
			<div className="min-w-0">
				<h1 className="text-xl font-semibold tracking-tight">{title}</h1>
				{description ? <p className="mt-1 text-sm text-fg-muted">{description}</p> : null}
			</div>
			{actions ? <div className="flex items-center gap-2">{actions}</div> : null}
		</div>
	);
}

export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
	return <div className={cn("mx-auto w-full px-4 pb-16 pt-6 sm:px-8 sm:pt-10", wide ? "max-w-6xl" : "max-w-4xl")}>{children}</div>;
}
