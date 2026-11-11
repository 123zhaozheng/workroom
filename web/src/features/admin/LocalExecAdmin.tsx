// 本地执行 (admin, sandbox.policy.manage): one switch. On = light code runs in the user's browser (isolated, no network); off = always the cloud sandbox.
import { useState } from "react";
import { errorText, put } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Switch } from "@/components/ui/switch";

interface LocalExecSetting {
	enabled: boolean;
	canManage: boolean;
}

export function LocalExecAdmin() {
	const res = useApi<LocalExecSetting>("/sandbox/local-exec");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	if (!res.data) return null;
	const toggle = async (enabled: boolean) => {
		setBusy(true);
		setErr(undefined);
		try {
			await put("/sandbox/local-exec", { enabled });
			res.reload();
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div data-testid="local-exec-admin" className="rounded-xl border border-border bg-surface px-4 py-3 text-sm">
			<div className="flex items-center gap-3">
				<span id="local-exec-label" className="flex-1 font-medium">
					本地执行
				</span>
				<Switch aria-labelledby="local-exec-label" data-testid="local-exec-switch" checked={res.data.enabled} onCheckedChange={toggle} busy={busy} disabled={!res.data.canManage} />
			</div>
			{err ? (
				<p role="alert" className="mt-2 text-danger">
					{err}
				</p>
			) : null}
		</div>
	);
}
