// 自动化 (M12): editor with trigger / timezone / next-run preview / condition / destination; run now, cancel,
// rerun, run history with notification deliveries. Every value comes from E's routes; nothing is simulated here.
import { Ban, ChevronRight, Pencil, Play, Plus, RotateCcw, Trash2, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import type { AutomationCondition, AutomationDTO, AutomationRunDTO, AutomationRunStatus, AutomationTrigger, NextRunPreviewDTO, NotifyChannelDTO } from "@shared/ops";
import { del, errorText, patch, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import type { Project } from "@/lib/types";
import { cn, fullTime, relTime } from "@/lib/utils";
import { TopBar } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { Badge, EmptyState, Loadable, Page, PageHeader, Spinner } from "@/components/ui/misc";
import { listOf } from "@/features/chat/pickers";

export const RUN: Record<AutomationRunStatus, { label: string; tone: "neutral" | "info" | "success" | "danger" | "warning" }> = {
	pending: { label: "等待中", tone: "info" },
	running: { label: "运行中", tone: "info" },
	succeeded: { label: "成功", tone: "success" },
	failed: { label: "失败", tone: "danger" },
	cancelled: { label: "已取消", tone: "neutral" },
	timeout: { label: "超时", tone: "warning" },
	skipped: { label: "已跳过", tone: "neutral" },
	refused: { label: "被拒绝", tone: "danger" },
};
const TRIGGER_KIND = { cron: "周期（cron）", once: "一次性", manual: "仅手动", webhook: "Webhook 事件" } as const;
const RUN_TRIGGER: Record<AutomationRunDTO["trigger"], string> = { schedule: "按计划", manual: "手动", webhook: "Webhook", catchup: "补跑", rerun: "再次运行" };
export const trigText = (t: AutomationTrigger) => (t.kind === "cron" ? `周期：${t.expr}` : t.kind === "once" ? `一次性：${fullTime(t.at)}` : t.kind === "manual" ? "仅手动触发" : "Webhook 事件触发");
/** A time shown in the automation's own time zone (not the browser's). */
export function inTz(iso: string, tz: string): string {
	try {
		return `${new Date(iso).toLocaleString("zh-CN", { timeZone: tz, hour12: false })}（${tz}）`;
	} catch {
		return fullTime(iso);
	}
}
const ENDED = new Set<AutomationRunStatus>(["succeeded", "failed", "cancelled", "timeout", "skipped", "refused"]);

function timezones(): string[] {
	try {
		return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
	} catch {
		return ["Asia/Shanghai", "UTC", "America/New_York", "Europe/London"];
	}
}
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";

export default function AutomationsPage() {
	const res = useApi<{ automations: AutomationDTO[] }>("/automations", { pollMs: 10000 });
	const [editing, setEditing] = useState<AutomationDTO | "new" | null>(null);
	const [secret, setSecret] = useState<string>();
	const list = res.data?.automations ?? [];
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page>
					<PageHeader
						title="自动化"
						description="按时间、手动或事件自动发起的任务。每次运行都会记录状态、原因和结果对话；通知失败与任务失败分开记录。"
						actions={
							<Button variant="primary" onClick={() => setEditing("new")} disabled={res.unavailable} data-testid="automation-new">
								<Plus />
								新建自动化
							</Button>
						}
					/>
					{secret ? (
						<div className="mb-4 rounded-lg bg-warning-soft px-3 py-2 text-[13px] text-warning" data-testid="webhook-secret">
							Webhook 地址（只显示这一次，请妥善保存）：<code className="break-all">{secret}</code>
							<button className="ml-2 underline" onClick={() => setSecret(undefined)}>
								我已保存
							</button>
						</div>
					) : null}
					<Loadable state={res} what="自动化" need="E 组：GET /api/automations">
						{list.length === 0 ? (
							<EmptyState icon={<Workflow />} title="还没有自动化" action={<Button onClick={() => setEditing("new")}>新建自动化</Button>}>
								例如：每个工作日 9:00 汇总昨天的项目进展。
							</EmptyState>
						) : (
							<div className="space-y-2">
								{list.map((a) => (
									<AutomationCard key={a.id} a={a} onEdit={() => setEditing(a)} onChanged={res.reload} />
								))}
							</div>
						)}
					</Loadable>
				</Page>
			</div>
			{editing ? (
				<AutomationEditor
					initial={editing === "new" ? undefined : editing}
					onClose={() => setEditing(null)}
					onSaved={(a) => {
						setEditing(null);
						if (a.webhookToken) setSecret(`${location.origin}/api/hooks/automations/${a.webhookToken}`);
						res.reload();
					}}
				/>
			) : null}
		</div>
	);
}

function AutomationCard({ a, onEdit, onChanged }: { a: AutomationDTO; onEdit: () => void; onChanged: () => void }) {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	const runs = useApi<{ runs: AutomationRunDTO[] }>(open ? `/automations/${a.id}/runs?limit=20` : null, { pollMs: open ? 3000 : undefined });
	const act = async (fn: () => Promise<unknown>) => {
		setBusy(true);
		setErr(undefined);
		try {
			await fn();
			onChanged();
			runs.reload();
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div data-testid="automation" className="rounded-xl border border-border bg-surface">
			<div className="flex flex-wrap items-center gap-2 p-3">
				<button onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={open}>
					<ChevronRight className={cn("size-4 shrink-0 text-fg-subtle transition-transform", open && "rotate-90")} />
					<span className="min-w-0">
						<span className="block truncate font-medium">{a.name}</span>
						<span className="block truncate text-xs text-fg-muted">
							{trigText(a.trigger)}
							{a.nextRunAt ? ` · 下次 ${inTz(a.nextRunAt, a.timezone)}` : ""}
						</span>
					</span>
				</button>
				{a.lastRun ? <Badge tone={RUN[a.lastRun.status].tone}>上次：{RUN[a.lastRun.status].label}</Badge> : null}
				<label className="flex items-center gap-1.5 text-xs text-fg-muted">
					<input type="checkbox" checked={a.enabled} disabled={busy} onChange={(e) => act(() => patch(`/automations/${a.id}`, { enabled: e.target.checked }))} className="size-4 accent-[var(--accent)]" />
					启用
				</label>
				<Button size="sm" disabled={busy} onClick={() => act(() => post(`/automations/${a.id}/run`))} data-testid="automation-run-now">
					<Play />
					立即运行
				</Button>
				<Button size="icon" variant="ghost" aria-label="编辑" onClick={onEdit}>
					<Pencil />
				</Button>
				<Button
					size="icon"
					variant="ghost"
					aria-label="删除"
					onClick={() => confirm(`删除自动化「${a.name}」？历史运行记录保留在审计中。`) && act(() => del(`/automations/${a.id}`))}
				>
					<Trash2 />
				</Button>
			</div>
			{err ? <p className="px-3 pb-2 text-[13px] text-danger">{err}</p> : null}
			{open ? (
				<div className="border-t border-border px-3 py-3 text-[13px]">
					<div className="mb-3 grid gap-x-4 gap-y-1 text-xs text-fg-muted sm:grid-cols-2">
						<div>条件：{a.condition.kind === "always" ? "每次都运行" : `上一次状态为 ${a.condition.statuses.map((s) => RUN[s].label).join("/")} 时运行`}</div>
						<div>
							输出：{a.destination.conversation === "new" ? "每次新建对话" : "追加到同一对话"}
							{a.destination.inApp ? " · 站内通知" : ""}
							{a.destination.channelIds.length ? ` · ${a.destination.channelIds.length} 个通知渠道` : ""}
						</div>
						<div>
							并发上限 {a.concurrency.max}（超出则跳过） · 错过的运行：{a.missedPolicy === "skip" ? "跳过" : "补跑一次"}
						</div>
						<div>最长运行 {Math.round(a.maxDurationMs / 60000)} 分钟 · 授权：以负责人身份运行，每次触发重新校验权限</div>
					</div>
					<div className="mb-1 text-xs font-medium text-fg-muted">运行记录</div>
					<Loadable state={runs} what="运行记录">
						{(runs.data?.runs ?? []).length === 0 ? (
							<p className="text-xs text-fg-subtle">还没有运行过。</p>
						) : (
							<ul className="divide-y divide-border rounded-lg border border-border" data-testid="automation-runs">
								{runs.data!.runs.map((r) => (
									<li key={r.id} data-testid="automation-run" data-status={r.status} className="flex flex-wrap items-center gap-2 px-2.5 py-2">
										<Badge tone={RUN[r.status].tone}>{RUN[r.status].label}</Badge>
										<span className="text-xs text-fg-muted">
											{RUN_TRIGGER[r.trigger]} · {fullTime(r.startedAt ?? r.scheduledFor)}
											{r.reason ? ` · ${r.reason}` : ""}
											{r.error ? ` · ${r.error}` : ""}
										</span>
										{r.notifications.flatMap((n) => n.deliveries).map((d) => (
											<Badge key={d.id} tone={d.status === "sent" ? "success" : d.status === "failed" ? "danger" : "neutral"} title={d.error}>
												通知{d.status === "sent" ? "已送达" : d.status === "failed" ? "失败" : d.status === "blocked" ? "被阻止" : "待发送"}
											</Badge>
										))}
										<span className="flex-1" />
										{r.link || (r.spaceId && r.conversationId) ? (
											<Link className="text-xs text-info hover:underline" to={r.link ?? `/c/${r.spaceId}/${r.conversationId}`}>
												查看对话
											</Link>
										) : null}
										{!ENDED.has(r.status) ? (
											<Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => post(`/automation-runs/${r.id}/cancel`))} data-testid="automation-run-cancel">
												<Ban />
												取消
											</Button>
										) : (
											<Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => post(`/automation-runs/${r.id}/rerun`))} data-testid="automation-run-rerun">
												<RotateCcw />
												再次运行
											</Button>
										)}
									</li>
								))}
							</ul>
						)}
					</Loadable>
				</div>
			) : null}
		</div>
	);
}

function toLocalInput(iso?: string): string {
	const d = iso ? new Date(iso) : new Date(Date.now() + 3600_000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function AutomationEditor({ initial, onClose, onSaved }: { initial?: AutomationDTO; onClose: () => void; onSaved: (a: AutomationDTO) => void }) {
	const projects = useApi<{ projects: Project[] }>("/projects");
	const channels = useApi<unknown>("/notify-channels");
	const channelList = listOf<NotifyChannelDTO>(channels.data, "channels");
	const [name, setName] = useState(initial?.name ?? "");
	const [prompt, setPrompt] = useState(initial?.prompt ?? "");
	const [projectId, setProjectId] = useState(initial?.projectId ?? "");
	const [kind, setKind] = useState<AutomationTrigger["kind"]>(initial?.trigger.kind ?? "cron");
	const [expr, setExpr] = useState(initial?.trigger.kind === "cron" ? initial.trigger.expr : "0 9 * * 1-5");
	const [at, setAt] = useState(toLocalInput(initial?.trigger.kind === "once" ? initial.trigger.at : undefined));
	const [tz, setTz] = useState(initial?.timezone ?? LOCAL_TZ);
	const [cond, setCond] = useState<AutomationCondition>(initial?.condition ?? { kind: "always" });
	const [conversation, setConversation] = useState(initial?.destination.conversation ?? "new");
	const [inApp, setInApp] = useState(initial?.destination.inApp ?? true);
	const [chIds, setChIds] = useState<string[]>(initial?.destination.channelIds ?? []);
	const [missed, setMissed] = useState(initial?.missedPolicy ?? "skip");
	const [maxMin, setMaxMin] = useState(Math.round((initial?.maxDurationMs ?? 30 * 60000) / 60000));
	const [preview, setPreview] = useState<NextRunPreviewDTO & { loading?: boolean }>();
	const [err, setErr] = useState<string>();
	const [busy, setBusy] = useState(false);
	const tzs = useMemo(timezones, []);

	const trigger: AutomationTrigger = kind === "cron" ? { kind, expr } : kind === "once" ? { kind, at: new Date(at).toISOString() } : { kind };

	// Live next-run preview (server-computed, DST-aware, in the chosen time zone).
	const tKey = JSON.stringify([trigger, tz]);
	useEffect(() => {
		if (kind === "manual" || kind === "webhook") return setPreview(undefined);
		let alive = true;
		setPreview((p) => ({ ...(p ?? { timezone: tz, runs: [] }), loading: true }));
		const t = setTimeout(() => {
			post<NextRunPreviewDTO>("/automations/preview", { trigger, timezone: tz, count: 5 })
				.then((r) => alive && setPreview(r))
				.catch((e) => alive && setPreview({ timezone: tz, runs: [], error: errorText(e) }));
		}, 300);
		return () => {
			alive = false;
			clearTimeout(t);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [tKey]);

	const save = async () => {
		setBusy(true);
		setErr(undefined);
		const body = {
			name,
			prompt,
			...(initial ? {} : projectId ? { projectId } : {}),
			trigger,
			timezone: tz,
			condition: cond,
			destination: { conversation, inApp, channelIds: chIds },
			missedPolicy: missed,
			maxDurationMs: maxMin * 60000,
		};
		try {
			const r = initial ? await patch<{ automation: AutomationDTO }>(`/automations/${initial.id}`, body) : await post<{ automation: AutomationDTO }>("/automations", body);
			onSaved(r.automation);
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	const prevStatuses: AutomationRunStatus[] = ["succeeded", "failed", "timeout", "cancelled"];

	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent title={initial ? "编辑自动化" : "新建自动化"} className="max-w-xl" aria-describedby={undefined}>
				<div className="wr-scroll -mx-1 max-h-[70vh] space-y-3 overflow-y-auto px-1" data-testid="automation-editor">
					<div>
						<Label htmlFor="an">名称</Label>
						<Input id="an" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：工作日早报" />
					</div>
					<div>
						<Label htmlFor="ap">要做的事</Label>
						<Textarea id="ap" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="每次运行时发给助手的指令" />
					</div>
					{!initial ? (
						<div>
							<Label htmlFor="as">运行空间</Label>
							<Select id="as" value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-full">
								<option value="">个人空间</option>
								{(projects.data?.projects ?? [])
									.filter((p) => p.role !== "viewer")
									.map((p) => (
										<option key={p.id} value={p.id}>
											项目：{p.name}
										</option>
									))}
							</Select>
						</div>
					) : null}
					<div className="grid gap-3 sm:grid-cols-2">
						<div>
							<Label htmlFor="ak">触发方式</Label>
							<Select id="ak" value={kind} onChange={(e) => setKind(e.target.value as AutomationTrigger["kind"])} className="w-full">
								{Object.entries(TRIGGER_KIND).map(([k, l]) => (
									<option key={k} value={k}>
										{l}
									</option>
								))}
							</Select>
						</div>
						<div>
							<Label htmlFor="atz">时区</Label>
							<Select id="atz" value={tz} onChange={(e) => setTz(e.target.value)} className="w-full">
								{tzs.map((z) => (
									<option key={z} value={z}>
										{z}
									</option>
								))}
							</Select>
						</div>
					</div>
					{kind === "cron" ? (
						<div>
							<Label htmlFor="ae">Cron 表达式（分 时 日 月 周）</Label>
							<Input id="ae" value={expr} onChange={(e) => setExpr(e.target.value)} className="font-mono" data-testid="automation-cron" />
						</div>
					) : kind === "once" ? (
						<div>
							<Label htmlFor="aat">运行时间（本机时间输入，按所选时区计算）</Label>
							<Input id="aat" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
						</div>
					) : kind === "webhook" ? (
						<p className="text-xs text-fg-muted">保存后会生成一次性显示的 Webhook 地址；相同 Idempotency-Key 的重复投递只触发一次。</p>
					) : null}
					{preview ? (
						<div className="rounded-lg bg-surface-2 px-3 py-2 text-xs" data-testid="automation-preview">
							<div className="mb-1 font-medium text-fg-muted">接下来的运行（{preview.timezone}）{preview.loading ? <Spinner className="ml-1 inline size-3" /> : null}</div>
							{preview.error ? (
								<div className="text-danger">{preview.error}</div>
							) : preview.runs.length ? (
								<ol className="space-y-0.5 text-fg">
									{preview.runs.map((r) => (
										<li key={r.at}>
											{r.local} <span className="text-fg-subtle">（{relTime(r.at)}）</span>
										</li>
									))}
								</ol>
							) : (
								<div className="text-fg-subtle">没有即将到来的运行</div>
							)}
						</div>
					) : null}
					<div>
						<Label>运行条件</Label>
						<div className="flex flex-wrap items-center gap-3 text-[13px]">
							<label className="flex items-center gap-1.5">
								<input type="radio" checked={cond.kind === "always"} onChange={() => setCond({ kind: "always" })} />
								每次都运行
							</label>
							<label className="flex items-center gap-1.5">
								<input type="radio" checked={cond.kind === "previous_status"} onChange={() => setCond({ kind: "previous_status", statuses: ["succeeded"] })} />
								仅当上一次状态为
							</label>
							{cond.kind === "previous_status"
								? prevStatuses.map((s) => (
										<label key={s} className="flex items-center gap-1 text-xs">
											<input
												type="checkbox"
												checked={cond.statuses.includes(s)}
												onChange={(e) => setCond({ kind: "previous_status", statuses: e.target.checked ? [...cond.statuses, s] : cond.statuses.filter((x) => x !== s) })}
											/>
											{RUN[s].label}
										</label>
									))
								: null}
						</div>
					</div>
					<div>
						<Label>输出到</Label>
						<div className="flex flex-wrap items-center gap-3 text-[13px]">
							<Select value={conversation} onChange={(e) => setConversation(e.target.value as "new" | "reuse")} className="h-8 text-[13px]">
								<option value="new">每次新建对话</option>
								<option value="reuse">追加到同一个对话</option>
							</Select>
							<label className="flex items-center gap-1.5">
								<input type="checkbox" checked={inApp} onChange={(e) => setInApp(e.target.checked)} />
								站内通知
							</label>
							{channelList.map((c) => (
								<label key={c.id} className={cn("flex items-center gap-1.5", c.status === "blocked" && "text-fg-subtle")} title={c.statusDetail}>
									<input type="checkbox" disabled={c.status === "blocked"} checked={chIds.includes(c.id)} onChange={(e) => setChIds((x) => (e.target.checked ? [...x, c.id] : x.filter((y) => y !== c.id)))} />
									{c.name}
									{c.status === "blocked" ? "（不可用）" : ""}
								</label>
							))}
						</div>
					</div>
					<div className="grid gap-3 sm:grid-cols-2">
						<div>
							<Label htmlFor="am">停机期间错过的运行</Label>
							<Select id="am" value={missed} onChange={(e) => setMissed(e.target.value as "skip" | "run_once")} className="w-full">
								<option value="skip">跳过（记录一条“已跳过”）</option>
								<option value="run_once">恢复后补跑一次</option>
							</Select>
						</div>
						<div>
							<Label htmlFor="amx">最长运行（分钟）</Label>
							<Input id="amx" type="number" min={1} value={maxMin} onChange={(e) => setMaxMin(Math.max(1, Number(e.target.value) || 1))} />
						</div>
					</div>
					{err ? <p className="text-[13px] text-danger">{err}</p> : null}
				</div>
				<div className="mt-4 flex justify-end gap-2">
					<Button variant="ghost" onClick={onClose}>
						取消
					</Button>
					<Button variant="primary" onClick={save} disabled={busy || !name.trim() || !prompt.trim()} data-testid="automation-save">
						{busy ? "保存中…" : "保存"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
