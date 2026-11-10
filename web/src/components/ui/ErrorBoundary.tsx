import { AlertTriangle } from "lucide-react";
import { Component, type ReactNode } from "react";

/** Contains a rendering fault to its region (page / panel) instead of blanking the whole app. */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string; resetKey?: unknown }, { error: Error | null; key: unknown }> {
	state = { error: null as Error | null, key: undefined as unknown };
	static getDerivedStateFromError(error: Error) {
		return { error };
	}
	static getDerivedStateFromProps(props: { resetKey?: unknown }, state: { error: Error | null; key: unknown }) {
		return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
	}
	componentDidCatch(error: Error) {
		console.error("[ui]", error);
	}
	render() {
		if (!this.state.error) return this.props.children;
		return (
			<div role="alert" data-testid="render-error" className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
				<AlertTriangle className="size-5 text-danger" />
				<div className="text-sm font-medium">{this.props.label ?? "这部分界面"}出错了</div>
				<div className="max-w-md break-words text-sm text-fg-muted">{this.state.error.message}</div>
				<button className="mt-2 text-sm text-info hover:underline" onClick={() => this.setState({ error: null })}>
					重试
				</button>
			</div>
		);
	}
}
