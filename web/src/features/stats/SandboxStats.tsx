// 沙箱 section of the stats page (organisation scope only): sandbox lifecycle KPIs, a per-provider table and the prewarm tuning block.
// Definitions: docs/r11-observability.md. Missing data is "—", never 0 and never an invented price.
import type { SandboxPercentilesDTO, SandboxProviderStatsDTO, SandboxStatsDTO } from "@shared/sandbox-stats";
import { useApi } from "@/lib/useApi";
import { cn } from "@/lib/utils";
import { ErrorState } from "@/components/ui/misc";
import { fmtInt, fmtMs, fmtPct, fmtUsd } from "./format";
import { Card, Skeleton } from "./parts";

const HOUR = 3_600_000;
const PROVIDER_NAME: Record<string, string> = { opensandbox: "OpenSandbox", e2b: "E2B", daytona: "Daytona" };

/** Running time: milliseconds below an hour (fmtMs: 秒 / 分钟), hours above. */
export const fmtRunning = (ms: number): string => (ms < HOUR ? fmtMs(ms) : `${(ms / HOUR).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 小时`);
const pctile = (p: SandboxPercentilesDTO, k: "p50" | "p95"): string => fmtMs(p[k]);

function Tile({ id, label, value, sub }: { id: string; label: string; value: string; sub?: string }) {
	return (
		<div data-testid="sbx-kpi" data-kpi={id} className="flex min-w-0 flex-col rounded-xl border border-border bg-surface p-3">
			<div className="truncate text-xs text-fg-muted">{label}</div>
			<div className="mt-1 truncate text-[22px] font-semibold leading-7 tracking-tight tabular-nums" data-testid="sbx-kpi-value">
				{value}
			</div>
			<div className="mt-0.5 min-h-4 truncate text-xs text-fg-subtle">{sub ?? ""}</div>
		</div>
	);
}

export function SandboxSection({ from, to }: { from: string; to: string }) {
	const res = useApi<SandboxStatsDTO>(`/stats/sandbox?${new URLSearchParams({ from, to }).toString()}`);
	return (
		<Card title="沙箱" testid="sandbox-stats">
			{res.error ? (
				<ErrorState error={res.error} onRetry={res.reload} what="沙箱统计" />
			) : !res.data ? (
				<Skeleton className="h-40 w-full rounded-xl" />
			) : (
				<Body d={res.data} dim={res.loading} />
			)}
		</Card>
	);
}

function Body({ d, dim }: { d: SandboxStatsDTO; dim: boolean }) {
	const t = d.total;
	const trig = t.createsByTrigger;
	const costLabel = d.costComplete ? "估算成本（USD）" : "估算成本（USD，部分）";
	return (
		<div className={cn("space-y-4", dim && "opacity-60 transition-opacity")}>
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="sbx-kpis">
				<Tile id="creates" label="创建次数" value={fmtInt(t.creates)} sub={t.creates || t.createFailures ? `按需 ${trig.exec} · 预热 ${trig.prewarm} · 显式 ${trig.explicit}${t.createFailures ? ` · 失败 ${t.createFailures}` : ""}` : undefined} />
				<Tile id="coldP50" label="冷启动 P50" value={pctile(t.coldStart, "p50")} sub={t.coldStart.n ? `n=${t.coldStart.n}` : undefined} />
				<Tile id="coldP95" label="冷启动 P95" value={pctile(t.coldStart, "p95")} sub={t.coldStart.n ? `n=${t.coldStart.n}` : undefined} />
				<Tile id="resumeP50" label="恢复 P50" value={pctile(t.resume, "p50")} sub={t.resume.n ? `n=${t.resume.n}` : t.resumeFailures ? `失败 ${t.resumeFailures}` : undefined} />
				<Tile id="resumeP95" label="恢复 P95" value={pctile(t.resume, "p95")} sub={t.resume.n && t.resumeFailures ? `失败 ${t.resumeFailures}` : undefined} />
				<Tile id="idlePauses" label="空闲暂停" value={fmtInt(t.idlePauses)} sub={t.archives || t.destroys ? `归档 ${t.archives} · 销毁 ${t.destroys}` : undefined} />
				<Tile id="running" label="运行时长" value={t.runningMs > 0 ? fmtRunning(t.runningMs) : "—"} sub={t.openRunningMs > 0 ? `其中运行中 ${fmtRunning(t.openRunningMs)}` : undefined} />
				{t.costUsd !== null ? <Tile id="cost" label={costLabel} value={fmtUsd(t.costUsd)} /> : null}
				<Tile id="codeRun" label="代码运行 本地 / 云端" value={d.codeRun.browser + d.codeRun.cloud > 0 ? `${fmtInt(d.codeRun.browser)} / ${fmtInt(d.codeRun.cloud)}` : "—"} sub={d.codeRun.upgraded ? `升级 ${d.codeRun.upgraded}` : undefined} />
			</div>
			<ProviderTable rows={d.byProvider} />
			<Prewarm d={d} />
		</div>
	);
}

function ProviderTable({ rows }: { rows: readonly SandboxProviderStatsDTO[] }) {
	if (rows.length === 0) return null;
	const th = "whitespace-nowrap px-2 py-1.5 text-right font-medium first:pl-0 first:text-left last:pr-0";
	const td = "whitespace-nowrap px-2 py-1.5 text-right tabular-nums first:pl-0 first:text-left last:pr-0";
	return (
		<div className="overflow-x-auto" data-testid="sbx-providers">
			<table className="w-full min-w-[560px] border-collapse text-xs">
				<thead>
					<tr className="border-b border-border text-fg-muted">
						<th className={th}>提供方</th>
						<th className={th}>创建</th>
						<th className={th}>冷启动 P50</th>
						<th className={th}>冷启动 P95</th>
						<th className={th}>恢复 P50</th>
						<th className={th}>暂停</th>
						<th className={th}>运行时长</th>
						<th className={th}>单价（USD/小时）</th>
						<th className={th}>成本（USD）</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((r) => (
						<tr key={r.provider} data-testid="sbx-provider-row" data-provider={r.provider} className="border-b border-border last:border-0">
							<td className={td}>{PROVIDER_NAME[r.provider] ?? r.provider}</td>
							<td className={td}>{fmtInt(r.creates)}</td>
							<td className={td}>{pctile(r.coldStart, "p50")}</td>
							<td className={td}>{pctile(r.coldStart, "p95")}</td>
							<td className={td}>{pctile(r.resume, "p50")}</td>
							<td className={td}>{fmtInt(r.idlePauses)}</td>
							<td className={td}>{r.runningMs > 0 ? fmtRunning(r.runningMs) : "—"}</td>
							<td className={td}>{r.priceUsdPerHour === null ? "—" : fmtUsd(r.priceUsdPerHour)}</td>
							<td className={td}>{r.costUsd === null ? "—" : fmtUsd(r.costUsd)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function Prewarm({ d }: { d: SandboxStatsDTO }) {
	const p = d.prewarm;
	// the what-if column closest to the current threshold is highlighted
	const near = p.whatIf.reduce<number | null>((best, r) => (best === null || Math.abs(r.threshold - p.threshold) < Math.abs(best - p.threshold) ? r.threshold : best), null);
	const cell = "px-1.5 py-1 text-right tabular-nums";
	return (
		<div className="space-y-3 border-t border-border pt-4" data-testid="sbx-prewarm">
			<h3 className="text-sm font-medium">预热调优</h3>
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
				<Tile id="pwThreshold" label="当前阈值" value={fmtPct(p.threshold, 0)} sub={p.enabled ? undefined : "已关闭"} />
				<Tile id="pwPrecision" label="精度" value={fmtPct(p.precision, 0)} />
				<Tile id="pwRecall" label="召回" value={fmtPct(p.recall, 0)} />
				<Tile id="pwFired" label="已发起" value={fmtInt(p.fired)} sub={p.decisions ? `决策 ${fmtInt(p.decisions)}` : undefined} />
				<Tile id="pwUsed" label="发起后被用到" value={p.fired ? fmtInt(p.firedUsed) : "—"} />
				<Tile id="pwWasted" label="浪费的预热" value={p.fired ? fmtInt(p.wasted) : "—"} sub={p.wasted ? `运行 ${fmtRunning(p.wastedRunningMs)}` : p.pending ? `待定 ${p.pending}` : undefined} />
			</div>
			<div className="overflow-x-auto" data-testid="sbx-whatif">
				<table className="w-full border-collapse text-xs">
					<thead>
						<tr className="text-fg-muted">
							<th className="py-1 pr-2 text-left font-medium">阈值</th>
							{p.whatIf.map((r) => (
								<th key={r.threshold} data-testid="sbx-whatif-th" data-threshold={r.threshold} className={cn(cell, "font-medium", r.threshold === near && "rounded-t bg-surface-3 text-fg")}>
									{fmtPct(r.threshold, 0)}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{(
							[
								["精度", "precision"],
								["召回", "recall"],
							] as const
						).map(([label, key]) => (
							<tr key={key} data-testid="sbx-whatif-row" data-row={key}>
								<td className="whitespace-nowrap py-1 pr-2 text-left text-fg-muted">{label}</td>
								{p.whatIf.map((r) => (
									<td key={r.threshold} className={cn(cell, r.threshold === near && "bg-surface-3 font-medium")}>
										{fmtPct(r[key], 0)}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
