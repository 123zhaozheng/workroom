// 待审核 (reviewers only): queue / history on the left, the review screen on the right. Reading order: what it is → automated check verdict
// → permissions it needs (new ones marked) → what changed (diff / files) → 处理记录 and 技术详情 (collapsed) → decision with the consequence stated.
// Approve / request changes / reject always ask first; reviewers cannot decide their own submissions (the server enforces it too).
import { ArrowLeft, Check, CheckCircle2, CircleX, MessageSquareWarning, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { MarketMeDTO, ReviewFilterKind, SubmissionDTO, SubmissionDetailDTO } from "@shared/files";
import { post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { cn, fullTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge, EmptyState, Loadable } from "@/components/ui/misc";
import { Fold } from "@/features/admin/common";
import { useConfirm } from "@/features/admin/confirm";
import { ExpertAvatar, SkillChip } from "@/features/experts/common";
import { DiffView, FileTree, FileViewer, FindingList, PermChips, Section, SCOPE, StateBadge, checkVerdict, permExplain, permText, useAct } from "./common";

const KIND_LABEL: Record<ReviewFilterKind, string> = { expert: "专家", skill: "技能", mcp: "连接器" };
const KIND_ORDER: readonly ReviewFilterKind[] = ["expert", "skill", "mcp"];

export function ReviewQueue({ me, onCount }: { me: MarketMeDTO; onCount?: (n: number) => void }) {
	const [view, setView] = useState<"queue" | "history">("queue");
	const [kind, setKind] = useState<"" | ReviewFilterKind>("");
	const [sel, setSel] = useState<string>();
	const list = useApi<{ submissions: SubmissionDTO[] }>(`/market/submissions?view=${view}${kind ? `&kind=${kind}` : ""}`, { pollMs: 15000 });
	const items = list.data?.submissions ?? [];
	const filterKinds = KIND_ORDER.filter((k) => me.reviewKinds.includes(k));
	useEffect(() => {
		if (view === "queue" && list.data) onCount?.(list.data.submissions.length);
	}, [view, list.data, onCount]);
	return (
		<div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]" data-testid="review-queue">
			<aside className={cn("min-w-0", sel && "hidden lg:block")} aria-label="审核队列">
				<div className="mb-3 flex flex-wrap items-center gap-2">
					<div className="inline-flex rounded-lg bg-surface-2 p-0.5 text-sm" role="group" aria-label="队列视图">
						{(["queue", "history"] as const).map((v) => (
							<button key={v} type="button" aria-pressed={view === v} onClick={() => (setView(v), setSel(undefined))} className={cn("h-7 rounded-md px-3", view === v ? "bg-surface shadow-sm" : "text-fg-muted")} data-testid={`review-view-${v}`}>
								{v === "queue" ? "待处理" : "已处理"}
							</button>
						))}
					</div>
					<Select value={kind} onChange={(e) => (setKind(e.target.value as typeof kind), setSel(undefined))} aria-label="类型" className="h-8 text-sm" data-testid="review-kind-filter">
						<option value="">全部</option>
						{(filterKinds.length ? filterKinds : KIND_ORDER).map((k) => (
							<option key={k} value={k}>
								{KIND_LABEL[k]}
							</option>
						))}
					</Select>
				</div>
				<Loadable state={list} what="审核队列">
					{items.length === 0 ? (
						<EmptyState icon={<Check />} title={view === "queue" ? "没有待审核的内容" : "还没有处理过的内容"} />
					) : (
						<ul className="space-y-1.5" data-testid="review-list">
							{items.map((s) => (
								<li key={s.id}>
									<button type="button" onClick={() => setSel(s.id)} data-testid="review-item" data-id={s.id} data-kind={s.kind} className={cn("w-full rounded-xl border bg-surface p-3 text-left hover:bg-surface-2", sel === s.id ? "border-accent" : "border-border")} aria-current={sel === s.id ? "true" : undefined}>
										<div className="flex items-center gap-2">
											<span className="min-w-0 flex-1 truncate text-sm font-medium">{s.subjectName}</span>
											<Badge>{s.kind === "skill" ? "技能" : s.kind === "expert" ? "专家" : "连接器"}</Badge>
										</div>
										<div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
											<span>{s.semver ?? s.versionNo ? `v${s.semver ?? s.versionNo}` : "—"}</span>
											<span>→ {s.kind === "mcp_connector" ? "个人连接" : SCOPE[s.targetScope]}</span>
											{view === "history" ? <StateBadge state={s.state} /> : null}
											{s.warnCount ? <span className="text-warning">需关注 {s.warnCount} 项</span> : null}
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
					<div className="hidden rounded-xl border border-dashed border-border-strong p-10 text-center text-sm text-fg-muted lg:block"></div>
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
	const { ask, dialog } = useConfirm();
	const isSelf = !!s && s.submitterId === self?.userId;
	const target = s ? (s.kind === "mcp_connector" ? "个人连接" : SCOPE[s.targetScope]) : "";
	const newPerms = s?.permissionDelta.added ?? [];
	const decide = async (decision: "approve" | "reject" | "request_changes") => {
		if (!s) return;
		const what = `「${s.subjectName}」${s.semver ? ` v${s.semver}` : ""}`;
		const ok =
			decision === "approve"
				? await ask({
						title: force && isSelf ? `强制通过 ${what}？` : `批准并发布 ${what}？`,
						consequence: `${what} 会发布到「${target}」，范围内的成员可以安装使用。`,
						items: [...(newPerms.length ? [`它会要求新的权限：${newPerms.map((p) => permText(p)).join("、")}`] : []), ...(force && isSelf ? ["这是你自己提交的内容，强制通过会跳过职责分离，并记入审计"] : []), "发布后如有问题，可以在市场里下架"],
						confirmLabel: force && isSelf ? "强制通过" : "批准并发布",
						danger: (force && isSelf) || newPerms.includes("network"),
					})
				: decision === "reject"
					? await ask({ title: `驳回 ${what}？`, consequence: "这个版本不会发布，你的评语会发给提交人。提交人需要上传新版本才能再次申请。", items: [`评语：${comment.trim()}`], confirmLabel: "驳回", danger: true })
					: await ask({ title: `要求修改 ${what}？`, consequence: "这个版本会退回给提交人，你的评语会发给 TA。修改后重新提交才会再次进入审核。", items: [`评语：${comment.trim()}`], confirmLabel: "要求修改" });
		if (ok) await run(() => post(`/market/submissions/${id}/decision`, { decision, comment, force: force || undefined }));
	};
	const marks = Object.fromEntries((s?.diff ?? []).filter((x) => x.status !== "unchanged").map((x) => [x.path, x.status as "added" | "removed" | "modified"]));
	const base = s ? (s.kind === "skill" ? `/market/skills/${s.subjectId}/versions/${s.versionNo}/file` : s.kind === "mcp_catalog" ? `/market/mcp/${s.subjectId}/versions/${s.versionNo}/file` : null) : null;
	const verdict = checkVerdict(s?.checks);
	const VerdictIcon = verdict.tone === "danger" ? CircleX : verdict.tone === "warning" ? TriangleAlert : CheckCircle2;
	const needComment = !comment.trim();
	const canApprove = !!s && (s.canDecide || (isSelf && force && !!comment.trim()));
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
								{s.semver ?? s.versionNo ? <Badge tone="info">v{s.semver ?? s.versionNo}</Badge> : null}
								<StateBadge state={s.state} />
								{s.forced ? <Badge tone="warning">强制通过</Badge> : null}
							</div>
							<p className="mt-1 text-sm text-fg-muted">
								{s.submitterName} 申请发布到「{target}」· {fullTime(s.createdAt)}
							</p>
							{s.note ? <p className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-sm">提交说明：{s.note}</p> : null}
						</header>

						<Section title="自动检查" testId="review-checks">
							<p className={cn("mb-2 flex items-center gap-1.5 text-sm font-medium", verdict.tone === "danger" ? "text-danger" : verdict.tone === "warning" ? "text-warning" : verdict.tone === "success" ? "text-success" : "text-fg-muted")} data-testid="check-verdict" data-tone={verdict.tone}>
								<VerdictIcon aria-hidden className="size-4" />
								{verdict.text}
							</p>
							{s.checks?.findings.length ? <FindingList findings={s.checks.findings} /> : null}
						</Section>

						<Section title="它要做什么">
							{s.manifest ? (
								<div className="space-y-2 text-sm" data-testid="manifest">
									<p>
										<b>{s.manifest.name}</b>：{s.manifest.description}
									</p>
									<p className="flex flex-wrap items-center gap-1.5">
										需要的权限：
										<PermChips perms={s.manifest.requiredPermissions} added={s.permissionDelta.added} />
										{s.permissionDelta.removed.length ? <span className="text-xs text-fg-muted">不再需要：{s.permissionDelta.removed.map((p) => permText(p)).join("、")}</span> : null}
									</p>
									{s.manifest.requiredPermissions.length ? (
										<ul className="list-disc space-y-0.5 pl-5 text-xs text-fg-muted">
											{s.manifest.requiredPermissions.map((p) => (
												<li key={p}>
													{permExplain(p)}
													{newPerms.includes(p) ? "（这一版新增）" : ""}
												</li>
											))}
										</ul>
									) : null}
									{s.manifest.requiredTools.length ? <p className="text-fg-muted">会用到的工具：{s.manifest.requiredTools.join("、")}</p> : null}
								</div>
							) : null}
							{s.mcp ? (
								<dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 text-sm" data-testid="mcp-info">
									<dt className="text-fg-muted">名称</dt>
									<dd>{s.mcp.name}</dd>
									<dt className="text-fg-muted">连接方式</dt>
									<dd>{s.mcp.transport === "http" ? "连接远程服务" : "在工作区里运行程序"}</dd>
									{s.mcp.url ? (
										<>
											<dt className="text-fg-muted">服务地址</dt>
											<dd className="break-all">{s.mcp.url}</dd>
										</>
									) : null}
									<dt className="text-fg-muted">需要的密钥</dt>
									<dd>{s.mcp.secretNames.length ? `${s.mcp.secretNames.join("、")}（只显示名称）` : "不需要"}</dd>
								</dl>
							) : null}
							{s.expert ? (
								<div className="space-y-2 text-sm" data-testid="expert-info">
									<p className="flex items-center gap-2">
										<ExpertAvatar e={{ id: s.subjectId, avatarConfig: s.expert.config.avatarConfig, name: s.expert.config.name }} size={28} />
										<b>{s.expert.config.name}</b>
										<span className="text-fg-muted">{s.expert.config.category}</span>
									</p>
									<p className="text-fg-muted">{s.expert.config.tagline}</p>
									<p className="flex flex-wrap items-center gap-1.5">
										挂载的技能：
										{s.expert.skills.length ? s.expert.skills.map((k) => <SkillChip key={k.skillId} s={k} />) : <span className="text-fg-muted">无</span>}
									</p>
									<p className="text-xs text-fg-subtle">技能按引用挂载，运行时总是用技能当前已发布的版本。</p>
									<p className="text-fg-muted">默认模型：{s.expert.config.defaultModel ? `${s.expert.config.defaultModel.provider}/${s.expert.config.defaultModel.modelId}` : "跟随会话"}</p>
								</div>
							) : null}
							{!s.manifest && !s.mcp && !s.expert ? <p className="text-sm text-fg-muted">没有更多信息。</p> : null}
						</Section>

						<Section
							title="内容变化"
							right={
								<div className="inline-flex rounded-lg bg-surface-2 p-0.5 text-xs" role="group" aria-label="查看方式">
									{(["diff", "files"] as const).map((t) => (
										<button key={t} type="button" aria-pressed={tab === t} onClick={() => setTab(t)} className={cn("h-7 rounded-md px-2.5", tab === t ? "bg-surface font-medium shadow-sm" : "text-fg-muted")} data-testid={`review-tab-${t}`}>
											{t === "diff" ? "与上一版的差异" : "全部文件"}
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

						<Fold title="处理记录" hint={`${s.events.length} 条`} testId="review-history">
							<ol className="space-y-1.5 text-sm" data-testid="events">
								{s.events.map((e, i) => (
									<li key={i} className="flex flex-wrap gap-x-2">
										<span className="text-xs text-fg-muted">{fullTime(e.at)}</span>
										<span>
											{e.actorName} · {EVENT[e.action] ?? e.action}
										</span>
										{e.comment ? <span className="text-fg-muted">「{e.comment}」</span> : null}
									</li>
								))}
							</ol>
						</Fold>
						<Fold title="技术详情" testId="review-tech">
							<dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1 text-xs text-fg-muted">
								{s.manifest ? (
									<>
										<dt>标识</dt>
										<dd className="font-mono">{s.manifest.name}</dd>
										<dt>类型</dt>
										<dd>
											{s.manifest.kind === "executable" ? "含可运行脚本" : "只有说明文字"}
											{s.manifest.entry ? ` · 入口 ${s.manifest.entry}` : ""}
										</dd>
									</>
								) : null}
								{s.mcp?.command ? (
									<>
										<dt>启动命令</dt>
										<dd className="break-all font-mono">{s.mcp.command}</dd>
									</>
								) : null}
								<dt>版本号</dt>
								<dd>{s.semver ?? s.versionNo}</dd>
							</dl>
						</Fold>

						{s.state === "pending_review" ? (
							<Section title="审核决定" testId="decision-bar">
								<div className="space-y-4">
									{isSelf ? (
										<p className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning" data-testid="self-review-note">
											<TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
											<span>这是你自己提交的内容，不能自己审核。</span>
										</p>
									) : !s.canDecide ? (
										<p className="text-sm text-warning">这一项不在你的审核范围内。</p>
									) : null}
									<div>
										<Label htmlFor="cm">评语</Label>
										<Textarea id="cm" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} disabled={!s.canDecide && !(isSelf && me.canManageMarket)} data-testid="decision-comment" />
									</div>
									{isSelf && me.canManageMarket ? (
										<label className="flex items-center gap-2 text-sm">
											<input type="checkbox" className="size-4 accent-[var(--accent)]" checked={force} onChange={(e) => setForce(e.target.checked)} />
											强制通过（跳过职责分离，理由必填，记入审计）
										</label>
									) : null}
									{err ? (
										<p className="text-sm text-danger" role="alert">
											{err}
										</p>
									) : null}
									<div className="space-y-2">
										<div className="flex flex-wrap items-center gap-3">
											<Button variant="primary" className="w-32" disabled={busy || !canApprove} onClick={() => void decide("approve")} data-testid="approve">
												<Check />
												批准并发布
											</Button>
										</div>
										<div className="flex flex-wrap items-center gap-3">
											<Button className="w-32" disabled={busy || !s.canDecide || needComment} onClick={() => void decide("request_changes")} data-testid="request-changes">
												<MessageSquareWarning />
												要求修改
											</Button>
										</div>
										<div className="flex flex-wrap items-center gap-3">
											<Button variant="danger" className="w-32" disabled={busy || !s.canDecide || needComment} onClick={() => void decide("reject")} data-testid="reject">
												<X />
												驳回
											</Button>
										</div>
									</div>
								</div>
							</Section>
						) : s.decisionComment ? (
							<p className="text-sm text-fg-muted">评语：{s.decisionComment}</p>
						) : null}
					</>
				) : null}
			</Loadable>
			{dialog}
		</div>
	);
}

const EVENT: Record<string, string> = { submit: "提交审核", approve: "批准", reject: "驳回", request_changes: "要求修改", withdraw: "撤回", superseded: "被新版本取代", unpublish: "下架", republish: "重新上架", force_publish: "强制发布", checks: "自动检查" };
