// 排查 tab.
import { useState } from "react";
import { useSearchParams } from "react-router";
import type { TraceDTO } from "@shared/ops";
import { api, errorText, qs } from "@/lib/api";
import { fullTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import { Fold } from "@/features/admin/common";

/** 排查 (M18-B): one correlation id (request id, run id, automation id, request key, or spaceId:conversationId) →
 * audit, model route attempts, usage rows, automation runs, notifications and other modules' events, all tenant-scoped
 * and redacted by the server according to its redaction mode. */
export function Trace() {
	const [sp] = useSearchParams();
	const [q, setQ] = useState(sp.get("q") ?? "");
	const [res, setRes] = useState<TraceDTO>();
	const [err, setErr] = useState<string>();
	const [busy, setBusy] = useState(false);
	const run = async (query = q) => {
		if (!query.trim()) return;
		setBusy(true);
		setErr(undefined);
		try {
			setRes(await api<TraceDTO>(`/admin/trace${qs({ q: query.trim() })}`));
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	const sections: [string, number][] = res
		? [
				["审计", res.audit.length],
				["模型路由", res.routeAttempts.length],
				["用量", res.ledger.length],
				["自动化运行", res.automationRuns.length],
				["通知", res.notifications.length],
				["其他模块事件", res.events.length],
			]
		: [];
	return (
		<div data-testid="trace">
			<form
				className="mb-4 flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					void run();
				}}
			>
				<Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="输入请求编号、运行编号或对话编号" aria-label="排查编号" className="font-mono" data-testid="trace-q" />
				<Button type="submit" disabled={busy} data-testid="trace-run">
					查询
				</Button>
			</form>
			<p className="mb-3 text-xs text-fg-muted">只显示本组织的数据；提示词、检索词和工具参数等敏感内容已脱敏。</p>
			{err ? <p className="text-sm text-danger" role="alert">{err}</p> : null}
			{res ? (
				<div className="space-y-4 text-sm">
					<div className="flex flex-wrap gap-2" data-testid="trace-summary">
						{sections.map(([k, n]) => (
							<Badge key={k} tone={n ? "info" : "neutral"}>
								{k} {n}
							</Badge>
						))}
						{res.sources.length ? <span className="text-xs text-fg-muted">来源：{res.sources.join("、")}</span> : null}
					</div>
					{res.eventErrors?.length ? <p className="text-xs text-warning">部分模块未返回：{res.eventErrors.map((x) => `${x.source}（${x.error}）`).join("、")}</p> : null}
					<Fold title="技术详情" defaultOpen testId="trace-tech">
					<div className="space-y-4">
					<TraceTable title="模型路由" rows={res.routeAttempts.map((r) => [fullTime(r.startedAt), `${r.platformModelId} → ${r.channelName ?? r.channelId ?? "—"}/${r.upstreamModelId ?? "—"}`, `${r.status}${r.errorClass ? ` · ${r.errorClass}` : ""}${r.fixture ? " · 测试模型" : ""}`])} />
					<TraceTable title="其他模块事件（工具调用、检索…）" rows={res.events.map((e) => [fullTime(e.at), `${e.source} · ${e.kind}${e.callId ? ` · ${e.callId}` : ""}`, `${e.status ? `${e.status} · ` : ""}${e.summary}${e.detail !== undefined ? ` · ${JSON.stringify(e.detail).slice(0, 400)}` : ""}`])} testId="trace-events" />
					<TraceTable title="用量" rows={res.ledger.map((l) => [fullTime(l.at), `${l.kind} · ${l.platformModelId ?? l.toolName ?? ""}`, `${l.outcome}${l.fixture ? " · 模拟用量，不计费" : ` · ${l.tokens.total} tokens · $${l.cost.toFixed(4)}`}`])} />
					<TraceTable title="审计" rows={res.audit.map((a) => [fullTime(a.at), a.action, `${a.actorName ?? a.actorUserId ?? "系统"}${a.target ? ` → ${a.target}` : ""}`])} />
					<TraceTable title="自动化运行" rows={res.automationRuns.map((r) => [fullTime(r.createdAt), r.automationId, `${r.status}${r.error ? ` · ${r.error}` : ""}`])} />
					<TraceTable title="通知" rows={res.notifications.map((n) => [fullTime(n.createdAt), n.title, n.status ?? ""])} />
					</div>
					</Fold>
				</div>
			) : null}
		</div>
	);
}

function TraceTable({ title, rows, testId }: { title: string; rows: string[][]; testId?: string }) {
	if (!rows.length) return null;
	return (
		<section data-testid={testId}>
			<h3 className="mb-1 text-xs font-medium text-fg-muted">
				{title}（{rows.length}）
			</h3>
			<div className="overflow-hidden rounded-lg border border-border">
				{rows.map((r, i) => (
					<div key={i} className="grid grid-cols-[150px_minmax(0,1fr)_minmax(0,1.2fr)] gap-2 border-t border-border px-3 py-1.5 text-xs first:border-t-0">
						<span className="text-fg-muted">{r[0]}</span>
						<span className="truncate font-mono" title={r[1]}>
							{r[1]}
						</span>
						<span className="break-words text-fg-muted">{r[2]}</span>
					</div>
				))}
			</div>
		</section>
	);
}
