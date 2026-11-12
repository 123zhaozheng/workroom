// 组织管理 → Harness 检视: the org-level switch. Off by default; the server enforces who may flip it and who may read the records.
import { useEffect, useId, useState } from "react";
import { Bug } from "lucide-react";
import type { HarnessInspectStatus } from "@shared/harness-inspect";
import { errorText, put } from "@/lib/api";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/misc";
import { refreshHarnessInspectStatus, setHarnessInspectStatus, useHarnessInspectStatus } from "./status";

export function HarnessInspectAdmin() {
	const status = useHarnessInspectStatus();
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	const labelId = useId();
	useEffect(() => {
		void refreshHarnessInspectStatus();
	}, []);
	if (!status) {
		return (
			<div className="flex items-center gap-2 px-2 py-10 text-sm text-fg-subtle">
				<Spinner /> 加载中…
			</div>
		);
	}
	const toggle = async (enabled: boolean) => {
		setBusy(true);
		setErr(undefined);
		try {
			setHarnessInspectStatus(await put<HarnessInspectStatus>("/admin/settings/harness-inspect", { enabled }));
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div data-testid="admin-harness-inspect" className="space-y-4">
			<div className="flex items-start gap-4 rounded-xl border border-border p-4">
				<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-fg-muted">
					<Bug aria-hidden className="size-[18px]" />
				</div>
				<div className="min-w-0 flex-1">
					<div id={labelId} className="text-sm font-medium">
						Harness 检视
					</div>
					<p className="mt-1 text-sm text-fg-muted">记录每一轮发给模型的完整请求（系统提示词、工具、全部消息），在回复操作栏的 Bug 图标中查看，用于排查问题。</p>
					<ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-fg-subtle">
						<li>记录可能包含对话原文，只有拥有「Harness 检视」权限、且能访问该对话的成员可以查看。</li>
						<li>
							每个对话最多保留最近 {status.maxRoundsPerConversation} 轮，超过 {status.retentionDays} 天自动清除；关闭开关会立即清除已保存的记录。
						</li>
					</ul>
					{!status.canManage ? <p className="mt-2 text-xs text-fg-subtle">修改此开关需要「管理安全设置」权限。</p> : null}
					{err ? (
						<p role="alert" className="mt-2 text-sm text-danger">
							{err}
						</p>
					) : null}
				</div>
				<Switch aria-labelledby={labelId} data-testid="admin-harness-inspect-switch" checked={status.enabled} disabled={!status.canManage} busy={busy} invalid={!!err} onCheckedChange={(v) => void toggle(v)} />
			</div>
		</div>
	);
}
