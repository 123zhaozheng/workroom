// 待审核 (reviewers only): queue / history on the left, the review screen on the right — manifest, permissions (new ones highlighted),
// file tree with content, diff against the previous approved version, automated check results, event timeline, decision bar.
import { ArrowLeft, Check, MessageSquareWarning, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { MarketMeDTO, SubmissionDTO, SubmissionDetailDTO } from "@shared/files";
import { post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { cn, fullTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";
import { Badge, EmptyState, Loadable } from "@/components/ui/misc";
import { DiffView, FileTree, FileViewer, FindingList, PermChips, Section, SCOPE, StateBadge, useAct } from "./common";

export function ReviewQueue({ me, onCount }: { me: MarketMeDTO; onCount?: (n: number) => void }) {
	const [view, setView] = useState<"queue" | "history">("queue");
	const [kind, setKind] = useState<"" | "skill" | "mcp">("");
	const [sel, setSel] = useState<string>();
	const list = useApi<{ submissions: SubmissionDTO[] }>(`/market/submissions?view=${view}${kind ? `&kind=${kind}` : ""}`, { pollMs: 15000 });
	const items = list.data?.submissions ?? [];
	useEffect(() => {
		if (view === "queue" && list.data) onCount?.(list.data.submissions.length);
	}, [view, list.data, onCount]);
	return (
		<div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]" data-testid="review-queue">
			<aside className={cn("min-w-0", sel && "hidden lg:block")}>
				<div className="mb-3 flex flex-wrap items-center gap-2">
					<div className="inline-flex rounded-lg bg-surface-2 p-0.5 text-[13px]" role="tablist">
						{(["queue", "history"] as const).map((v) => (
							<button key={v} role="tab" aria-selected={view === v} onClick={() => (setView(v), setSel(undefined))} className={cn("h-7 rounded-md px-3", view === v ? "bg-surface shadow-sm" : "text-fg-muted")} data-testid={`review-view-${v}`}>
								{v === "queue" ? "待处理" : "已处理"}
							</button>
						))}
					</div>
					<select value={kind} onChange={(e) => (setKind(e.target.value as typeof kind), setSel(undefined))} aria-label="类型" className="h-8 rounded-lg border border-border bg-surface px-2 text-[13px]">
						<option value="">全部类型</option>
						<option value="skill" disabled={!me.canReviewSkills}>技能</option>
						<option value="mcp" disabled={!me.canReviewMcp}>MCP</option>
					</select>
				</div>
				<Loadable state={list} what="审核队列">
					{items.length === 0 ? (
						<EmptyState icon={<Check />} title={view === "queue" ? "没有待审核的提交" : "还没有处理过的提交"}>
							{view === "queue" ? "你只会看到自己有审核权限的范围内的提交。" : ""}
						</EmptyState>
					) : (
						<ul className="space-y-1.5" data-testid="review-list">
							{items.map((s) => (
								<li key={s.id}>
									<button type="button" onClick={() => setSel(s.id)} data-testid="review-item" data-id={s.id} className={cn("w-full rounded-xl border bg-surface p-3 text-left hover:bg-surface-2", sel === s.id ? "border-accent" : "border-border")}>
										<div className="flex items-center gap-2">
											<span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{s.subjectName}</span>
											<Badge>{s.kind === "skill" ? "技能" : "MCP"}</Badge>
										</div>
										<div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
											<span>v{s.semver ?? s.versionNo ?? "—"}</span>
											<span>→ {s.kind === "mcp_connector" ? "个人连接" : SCOPE[s.targetScope]}</span>
											{view === "history" ? <StateBadge state={s.state} /> : null}
											{s.warnCount ? <span className="text-warning">⚠ {s.warnCount}</span> : null}
										</div>
										<div className="mt-1 text-xs text-fg-subtle">
											{s.submitterName} · {fullTime(s.createdAt)}
										</div>
									</button>
								</li>
							))}
						</ul>
					)}
				</Loadable>
			</aside>
			<main className={cn("min-w-0", !sel && "hidden lg:block")}>
				{sel ? (
					<ReviewScreen id={sel} me={me} onBack={() => setSel(undefined)} onDecided={() => (list.reload(), setSel(undefined))} />
				) : (
					<div className="hidden rounded-xl border border-dashed border-border-strong p-10 text-center text-[13px] text-fg-muted lg:block">从左侧选择一条提交开始审核。</div>
				)}
			</main>
		</div>
	);
}

function ReviewScreen({ id, me, onBack, onDecided }: { id: string; me: MarketMeDTO; onBack: () => void; onDecided: () => void }) {
	const d = useApi<{ submission: SubmissionDetailDTO }>(`/market/submissions/${id}`);
	const { me: self } = useSession();
	const s = d.data?.submission;
	const [tab, setTab] = useState<"diff" | "files">("diff");
	const [file, setFile] = useState<string>();
	const [comment, setComment] = useState("");
	const [force, setForce] = useState(false);
	const { busy, err, run } = useAct(onDecided);
	const decide = (decision: "approve" | "reject" | "request_changes") => run(() => post(`/market/submissions/${id}/decision`, { decision, comment, force: force || undefined }));
	const isSelf = !!s && s.submitterId === self?.userId;
	const marks = Object.fromEntries((s?.diff ?? []).filter((x) => x.status !== "unchanged").map((x) => [x.path, x.status as "added" | "removed" | "modified"]));
	const base = s ? (s.kind === "skill" ? `/market/skills/${s.subjectId}/versions/${s.versionNo}/file` : s.kind === "mcp_catalog" ? `/market/mcp/${s.subjectId}/versions/${s.versionNo}/file` : null) : null;
	return (
		<div className="space-y-4" data-testid="review-screen">
			<Button size="sm" variant="ghost" className="lg:hidden" onClick={onBack}>
				<ArrowLeft />
				返回列表
			</Button>
			<Loadable state={d} what="审核详情">
				{s ? (
					<>
						<header className="rounded-xl border border-border bg-surface p-4">
							<div className="flex flex-wrap items-center gap-2">
								<h2 className="text-base font-semibold">{s.subjectName}</h2>
								<Badge tone="info">v{s.semver ?? s.versionNo}</Badge>
								<StateBadge state={s.state} />
								{s.forced ? <Badge tone="warning">强制</Badge> : null}
							</div>
							<p className="mt-1 text-[13px] text-fg-muted">
								{s.submitterName} 提交到 <b>{s.kind === "mcp_connector" ? "个人连接" : SCOPE[s.targetScope]}</b> · {fullTime(s.createdAt)}
							</p>
							{s.note ? <p className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-[13px]">提交说明：{s.note}</p> : null}
							{s.manifest ? (
								<dl className="mt-3 grid grid-cols-[84px_1fr] gap-x-3 gap-y-1.5 text-[13px]" data-testid="manifest">
									<dt className="text-fg-muted">name</dt>
									<dd className="font-mono">{s.manifest.name}</dd>
									<dt className="text-fg-muted">说明</dt>
									<dd>{s.manifest.description}</dd>
									<dt className="text-fg-muted">类型</dt>
									<dd>
										{s.manifest.kind}
										{s.manifest.entry ? ` · 入口 ${s.manifest.entry}` : ""}
									</dd>
									<dt className="text-fg-muted">权限</dt>
									<dd>
										<PermChips perms={s.manifest.requiredPermissions} added={s.permissionDelta.added} />
										{s.permissionDelta.removed.length ? <span className="ml-2 text-xs text-fg-subtle">移除：{s.permissionDelta.removed.join("、")}</span> : null}
									</dd>
									{s.manifest.requiredTools.length ? (
										<>
											<dt className="text-fg-muted">依赖工具</dt>
											<dd>{s.manifest.requiredTools.join("、")}</dd>
										</>
									) : null}
								</dl>
							) : null}
							{s.mcp ? (
								<dl className="mt-3 grid grid-cols-[84px_1fr] gap-x-3 gap-y-1.5 text-[13px]" data-testid="mcp-info">
									<dt className="text-fg-muted">名称</dt>
									<dd className="font-mono">{s.mcp.name}</dd>
									<dt className="text-fg-muted">传输</dt>
									<dd>{s.mcp.transport === "http" ? "远程 HTTP" : "stdio（在沙箱内运行）"}</dd>
									{s.mcp.url ? (
										<>
											<dt className="text-fg-muted">地址</dt>
											<dd className="break-all font-mono">{s.mcp.url}</dd>
										</>
									) : null}
									{s.mcp.command ? (
										<>
											<dt className="text-fg-muted">运行</dt>
											<dd className="break-all font-mono">{s.mcp.command}</dd>
										</>
									) : null}
									<dt className="text-fg-muted">凭据</dt>
									<dd>{s.mcp.secretNames.length ? `${s.mcp.secretNames.join("、")}（只显示名称）` : "无"}</dd>
								</dl>
							) : null}
						</header>

						<Section title="自动检查" right={s.checks ? <span className="text-xs text-fg-muted">{s.checks.ok ? "通过" : "未通过"} · {fullTime(s.checks.at)}</span> : null}>
							<FindingList findings={s.checks?.findings ?? []} empty="自动检查没有发现问题。" />
						</Section>

						<Section
							title="内容"
							right={
								<div className="inline-flex rounded-lg bg-surface-2 p-0.5 text-xs" role="tablist">
									{(["diff", "files"] as const).map((t) => (
										<button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn("h-6 rounded-md px-2.5", tab === t ? "bg-surface shadow-sm" : "text-fg-muted")} data-testid={`review-tab-${t}`}>
											{t === "diff" ? "与上一版本的差异" : "文件"}
										</button>
									))}
								</div>
							}
						>
							{tab === "diff" ? (
								<DiffView diff={s.diff} previousVersionNo={s.previousVersionNo} />
							) : (
								<div className="grid gap-3 md:grid-cols-[220px_1fr]">
									<div className="rounded-lg border border-border p-1.5">
										<FileTree files={s.files} selected={file} onSelect={setFile} marks={marks} />
									</div>
									<div className="min-h-[120px] rounded-lg border border-border">
										<FileViewer url={file && base ? `${base}?path=${encodeURIComponent(file)}` : null} />
									</div>
								</div>
							)}
						</Section>

						<Section title="时间线">
							<ol className="space-y-1.5 text-[13px]" data-testid="events">
								{s.events.map((e, i) => (
									<li key={i} className="flex flex-wrap gap-x-2">
										<span className="text-xs text-fg-subtle">{fullTime(e.at)}</span>
										<span>
											{e.actorName} · {e.action}
											{e.toState ? ` → ${e.toState}` : ""}
										</span>
										{e.comment ? <span className="text-fg-muted">「{e.comment}」</span> : null}
									</li>
								))}
							</ol>
						</Section>

						{s.state === "pending_review" ? (
							<Section title="审核决定">
								<div className="space-y-3" data-testid="decision-bar">
									{!s.canDecide && !isSelf ? <p className="text-[13px] text-warning">这条提交不在你的审核范围内。</p> : null}
									{isSelf ? <p className="text-[13px] text-warning">这是你自己提交的内容，不能自己审核；请另一位审核员处理。{me.canManageMarket ? "市场管理员可勾选下方“强制通过”并写明理由（会写入审计）。" : ""}</p> : null}
									<div>
										<Label htmlFor="cm">评语（驳回、要求修改必填）</Label>
										<Textarea id="cm" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} disabled={!s.canDecide && !(isSelf && me.canManageMarket)} data-testid="decision-comment" />
									</div>
									{isSelf && me.canManageMarket ? (
										<label className="flex items-center gap-2 text-[13px]">
											<input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
											强制通过（跳过职责分离，理由必填，记审计）
										</label>
									) : null}
									{err ? <p className="text-[13px] text-danger">{err}</p> : null}
									<div className="flex flex-wrap gap-2">
										<Button variant="primary" disabled={busy || !(s.canDecide || (isSelf && force && !!comment.trim()))} onClick={() => decide("approve")} data-testid="approve">
											<Check />
											批准并发布
										</Button>
										<Button disabled={busy || !s.canDecide || !comment.trim()} onClick={() => decide("request_changes")} data-testid="request-changes">
											<MessageSquareWarning />
											要求修改
										</Button>
										<Button variant="danger" disabled={busy || !s.canDecide || !comment.trim()} onClick={() => decide("reject")} data-testid="reject">
											<X />
											驳回
										</Button>
									</div>
								</div>
							</Section>
						) : s.decisionComment ? (
							<p className="text-[13px] text-fg-muted">评语：{s.decisionComment}</p>
						) : null}
					</>
				) : null}
			</Loadable>
		</div>
	);
}
