// Loading / empty / error states shared by the preview panel, the work panel and the files pages.
// Plain Chinese, no route names or group letters: the reason, then what to do.
import { AlertTriangle, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { errorText } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";

export function PanelLoading({ label = "正在加载…" }: { label?: string }) {
	return (
		<div role="status" className="flex h-full min-h-32 items-center justify-center gap-2 px-4 py-10 text-sm text-fg-muted">
			<Spinner /> {label}
		</div>
	);
}

/** Quiet, compact notice: an optional icon, a title, one line of detail and an optional action. */
export function Notice({ icon, title, children, action, tone = "neutral", testid }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; tone?: "neutral" | "danger"; testid?: string }) {
	return (
		<div data-testid={testid} role={tone === "danger" ? "alert" : undefined} className="flex h-full min-h-40 flex-col items-center justify-center gap-1 px-6 py-10 text-center">
			{icon ? <div className={tone === "danger" ? "mb-2 text-danger [&_svg]:size-5" : "mb-2 text-fg-subtle [&_svg]:size-5"}>{icon}</div> : null}
			<div className="text-sm font-medium text-fg">{title}</div>
			{children ? <div className="max-w-xs text-[13px] text-fg-muted">{children}</div> : null}
			{action ? <div className="mt-3">{action}</div> : null}
		</div>
	);
}

interface Loadish {
	loading: boolean;
	error?: unknown;
	unavailable: boolean;
	reload: () => void;
}

/** Wrapper for an async resource: loading, error (reason + 重试), or the content. */
export function LoadState({ state, what, children }: { state: Loadish; what: string; children: ReactNode }) {
	if (state.unavailable || state.error)
		return (
			<Notice
				tone="danger"
				icon={<AlertTriangle />}
				title={state.unavailable ? `暂时无法使用${what}` : `${what}加载失败`}
				action={
					<Button size="sm" onClick={state.reload}>
						<RotateCcw />
						重试
					</Button>
				}
			>
				{state.unavailable ? "服务暂时不可用，请稍后重试。" : errorText(state.error)}
			</Notice>
		);
	if (state.loading) return <PanelLoading />;
	return <>{children}</>;
}
