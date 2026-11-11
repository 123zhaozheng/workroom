// Round 11 (R2b): organisation-level setting of the intent-based sandbox prewarm (admin › 沙箱). One row: on/off + threshold in percent.
import { useEffect, useState } from "react";
import type { SandboxPrewarmSettingsDTO } from "@shared/prewarm";
import { put } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAct } from "./common";

export function PrewarmSettings() {
	const res = useApi<{ settings: SandboxPrewarmSettingsDTO }>("/sandbox/prewarm");
	const { busy, run, note } = useAct(() => res.reload());
	const s = res.data?.settings;
	const [pct, setPct] = useState("30");
	useEffect(() => {
		if (s) setPct(String(Math.round(s.threshold * 100)));
	}, [s?.threshold]);
	if (!s) return null;
	const commit = () => {
		const n = Number(pct);
		if (!Number.isFinite(n) || n < 0 || n > 100) return setPct(String(Math.round(s.threshold * 100)));
		if (Math.round(n) !== Math.round(s.threshold * 100)) void run(() => put("/sandbox/prewarm", { threshold: Math.round(n) / 100 }));
	};
	return (
		<section data-testid="prewarm-settings" className="rounded-xl border border-border bg-surface px-4 py-3">
			<div className="flex flex-wrap items-center gap-3 text-sm">
				<Switch data-testid="prewarm-enabled" aria-label="后台预热沙箱" checked={s.enabled} busy={busy} onCheckedChange={(v) => void run(() => put("/sandbox/prewarm", { enabled: v }))} />
				<span>后台预热沙箱</span>
				<label className="ml-auto flex items-center gap-2">
					<span className="text-fg-muted">触发阈值 %</span>
					<Input
						data-testid="prewarm-threshold"
						type="number"
						min={0}
						max={100}
						step={5}
						value={pct}
						disabled={!s.enabled || busy}
						onChange={(e) => setPct(e.target.value)}
						onBlur={commit}
						onKeyDown={(e) => e.key === "Enter" && commit()}
						className="h-8 w-20 text-sm"
					/>
				</label>
			</div>
			{note}
		</section>
	);
}
