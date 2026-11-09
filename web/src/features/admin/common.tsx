// Shared building blocks for the admin tabs.
import { useState, type ReactNode } from "react";
import { errorText } from "@/lib/api";

export const ROLE: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员", guest: "访客" };

/** Runs an action, reports its error inline, then refreshes. */
export function useAct(after: () => void) {
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	const [ok, setOk] = useState<string>();
	const run = async (fn: () => Promise<unknown>, okText?: string) => {
		setBusy(true);
		setErr(undefined);
		setOk(undefined);
		try {
			await fn();
			if (okText) setOk(okText);
			after();
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	const note = err ? <p className="my-2 rounded-lg bg-danger-soft px-3 py-1.5 text-[13px] text-danger" role="alert">{err}</p> : ok ? <p className="my-2 rounded-lg bg-success-soft px-3 py-1.5 text-[13px] text-success">{ok}</p> : null;
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
	return <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-[13px]">{children}</div>;
}
