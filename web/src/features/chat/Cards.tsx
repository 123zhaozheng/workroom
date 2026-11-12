import { AlertTriangle, BookMarked, ChevronRight, Download, FileCode2, FileImage, FileSpreadsheet, FileText, FileType2, OctagonAlert, Presentation, ShieldAlert, ShieldCheck, type LucideIcon } from "lucide-react";
import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import { m } from "motion/react";
import type { ApprovalDTO, EffectDTO } from "@shared/chat";
import type { CitationDTO, CitationStatusDTO } from "@shared/knowledge";
import { errorText, post } from "@/lib/api";
import { cn, formatBytes, relTime } from "@/lib/utils";
import { useSession } from "@/lib/session";
import { describeTool } from "./toolDescribe";
import type { CardRef } from "./model";
import { useOutputs } from "./outputs";
import { hasBlockingFinding, SkillDraftDetails, SkillDraftFace, skillDraftHeading, skillDraftOf, skillDraftTech } from "./SkillDraftCard";
import { ClampText, DetailsPanel, DetailsToggle } from "./Disclosure";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/misc";
import { Textarea } from "@/components/ui/input";
import { usePanel } from "@/components/shell/panel";
import { FileThumb, MiddleEllipsis } from "@/components/file/FileTile";
import { fileKind, KIND_META } from "@/components/file/kinds";

export function fileIcon(name: string, mime = "") {
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	if (mime.startsWith("image/")) return FileImage;
	if (["xlsx", "xls", "csv"].includes(ext)) return FileSpreadsheet;
	if (["pptx", "ppt"].includes(ext)) return Presentation;
	if (["html", "js", "ts", "py", "json", "css"].includes(ext)) return FileCode2;
	if (["pdf", "docx", "doc"].includes(ext)) return FileType2;
	return FileText;
}

/**
 * Deliverable card: icon, name, type, size, download. Click → right-side preview (drawer on narrow screens). No version anywhere: the
 * card resolves its fileId through the conversation's current outputs, so an overwrite shows the new size / content and a withdrawn
 * output shows 已删除 with no way to download it.
 */
export function FileCard({ card }: { card: CardRef }) {
	const { openPreview, panel } = usePanel();
	const outputs = useOutputs();
	const cur = outputs.get(card.fileId) ?? card.item;
	const name = cur?.name ?? card.name;
	const mime = cur?.mime ?? card.mime;
	const size = cur?.size ?? card.size;
	const etag = cur?.etag;
	const removed = cur?.status === "removed";
	const kind = fileKind(name, mime);
	const active = panel?.kind === "preview" && panel.target.fileId === card.fileId;
	const bust = etag ? `?v=${encodeURIComponent(etag.slice(0, 16))}` : "";
	const shell = cn("group flex w-full max-w-[440px] items-center gap-3 rounded-xl border bg-surface p-2 pr-2.5 shadow-[0_1px_2px_rgb(0_0_0/0.03)] transition-colors", active ? "border-border-strong bg-surface-2" : "border-border hover:border-border-strong");
	if (removed)
		return (
			<div data-testid="file-card" data-file-id={card.fileId} data-kind={kind} data-removed="true" className={cn(shell, "opacity-70 hover:border-border")}>
				<FileThumb name={name} mime={mime} size={44} />
				<span className="min-w-0 flex-1">
					<MiddleEllipsis name={name} className="text-sm font-medium text-fg-muted" />
					<span data-testid="file-removed" className="mt-0.5 block text-xs text-fg-subtle">
						已删除
					</span>
				</span>
			</div>
		);
	return (
		<div data-testid="file-card" data-file-id={card.fileId} data-kind={kind} data-etag={etag} className={shell}>
			<button
				onClick={() => openPreview({ fileId: card.fileId, name, mime, size, etag })}
				className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left"
				aria-label={`预览 ${name}`}
			>
				<FileThumb name={name} mime={mime} size={44} thumbUrl={kind === "image" ? `/api/files/${card.fileId}/download${bust}` : undefined} />
				<span className="min-w-0 flex-1">
					<MiddleEllipsis name={name} className="text-sm font-medium" />
					<span data-testid="file-meta" className="mt-0.5 block text-xs text-fg-subtle">
						{KIND_META[kind].label}
						{size ? ` · ${formatBytes(size)}` : ""}
					</span>
				</span>
			</button>
			<a href={`/api/files/${card.fileId}/download${bust}`} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-subtle hover:bg-surface-2 hover:text-fg" aria-label={`下载 ${name}`} title="下载">
				<Download className="size-4" />
			</a>
		</div>
	);
}

const RISK: Record<ApprovalDTO["risk"], { label: string; tone: "neutral" | "warning" | "danger"; note: string; Icon: LucideIcon }> = {
	low: { label: "低风险", tone: "neutral", note: "影响较小。", Icon: ShieldCheck },
	medium: { label: "中风险", tone: "warning", note: "会对外部系统产生变化，请核对内容。", Icon: ShieldAlert },
	high: { label: "高风险", tone: "danger", note: "可能无法撤销，请逐项核对后再允许。", Icon: OctagonAlert },
};

/** Fields of an approval's detail that are worth a labelled line (everything else stays in the raw 参数 block). */
const SCOPE_KEYS: [RegExp, string][] = [
	[/^(to|recipients?|receiver|email)$/i, "收件人"],
	[/^(cc|bcc)$/i, "抄送"],
	[/^(target|destination|dest)$/i, "目标"],
	[/^(path|file|filename|name)$/i, "对象"],
	[/^(url|link|host)$/i, "地址"],
	[/^(subject|title)$/i, "标题"],
	[/^(member|assignee)$/i, "成员"],
	[/^(count|total)$/i, "数量"],
];
function scopeRows(detail: unknown): { label: string; value: string }[] {
	if (!detail || typeof detail !== "object" || Array.isArray(detail)) return [];
	const rows: { label: string; value: string }[] = [];
	for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
		const hit = SCOPE_KEYS.find(([re]) => re.test(k));
		if (!hit || (typeof v !== "string" && typeof v !== "number")) continue;
		rows.push({ label: hit[1], value: String(v).slice(0, 80) });
		if (rows.length >= 4) break;
	}
	return rows;
}

/**
 * Pending approval, compact: the face is the title, a risk badge, the backend's own one-line summary of what will happen, and the decision
 * (允许 / 拒绝 — the only two the backend accepts — plus an optional note it passes on to the assistant). Who asked, what it touches, the
 * risk explained, the arguments and a skill draft's files / findings are behind 详情 ›; nothing is dropped. Nothing is focused on open;
 * a high-risk 允许 needs a second, explicit click and keeps its one-line warning on the face.
 */
export function ApprovalCard({ approval, base, canDecide = true }: { approval: ApprovalDTO; base: string; canDecide?: boolean }) {
	const { me } = useSession();
	const uid = useId();
	const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
	const [sent, setSent] = useState<"approved" | "rejected" | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [note, setNote] = useState("");
	const [showNote, setShowNote] = useState(false);
	const [open, setOpen] = useState(false);
	const [err, setErr] = useState<string>();
	const backRef = useRef<HTMLButtonElement>(null);
	const allowRef = useRef<HTMLButtonElement>(null);
	const risk = RISK[approval.risk] ?? RISK.medium;
	const high = approval.risk === "high";
	useEffect(() => {
		if (confirming) backRef.current?.focus();
	}, [confirming]);
	const decide = async (decision: "approved" | "rejected") => {
		setBusy(decision);
		setErr(undefined);
		try {
			await post(`${base}/approvals/${encodeURIComponent(approval.approvalId)}`, { decision, ...(note.trim() ? { note: note.trim() } : {}) });
			setSent(decision);
		} catch (e) {
			setErr(errorText(e));
			setBusy(null);
		}
	};
	const scope = scopeRows(approval.detail);
	const view = approval.toolName ? describeTool({ name: approval.toolName, arguments: approval.detail }) : undefined;
	const showAction = view && view.kind !== "approval" && view.kind !== "other";
	const forMe = !approval.requestedFor || approval.requestedFor === me?.userId;
	const RiskIcon = risk.Icon;
	const draft = skillDraftOf(approval.detail);
	const blocked = draft ? hasBlockingFinding(draft) : false;
	const yes = draft ? "保存" : "允许";
	const no = draft ? "不保存" : "拒绝";
	const title = draft ? skillDraftHeading(draft) : approval.title;
	const panelId = `${uid}-d`;
	const toggle = <DetailsToggle open={open} onToggle={() => setOpen((o) => !o)} controls={panelId} />;
	return (
		<m.div
			initial={{ opacity: 0, y: 6 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.18 }}
			data-testid="approval-card"
			data-risk={approval.risk}
			role="group"
			tabIndex={-1}
			aria-labelledby={`${uid}-t`}
			aria-describedby={`${uid}-s`}
			className={cn("rounded-xl border p-3 outline-none focus-visible:ring-2 focus-visible:ring-info sm:px-3.5", high ? "border-danger/50 bg-danger-soft/40" : "border-warning/40 bg-warning-soft/40")}
		>
			<div className="flex items-start gap-2">
				<h3 id={`${uid}-t`} className="min-w-0 flex-1 break-words text-sm font-medium leading-5">
					<span className="sr-only">需要你确认：</span>
					{title}
				</h3>
				<Badge tone={risk.tone} data-testid="approval-risk">
					<RiskIcon aria-hidden />
					{risk.label}
				</Badge>
			</div>
			{draft ? (
				<>
					<span id={`${uid}-s`} className="sr-only">
						{draft.title || draft.name}
					</span>
					<SkillDraftFace d={draft} />
				</>
			) : (
				<>
					<ClampText id={`${uid}-s`} testId="approval-summary" className="mt-1 whitespace-pre-line text-[13px] leading-5">
						{approval.summary}
					</ClampText>
					{high ? (
						<p data-testid="approval-risk-note" className="mt-1 text-xs font-medium text-danger">
							{risk.note}
						</p>
					) : null}
				</>
			)}
			{err ? (
				<p role="alert" className="mt-2 text-[13px] text-danger">
					{err}
				</p>
			) : null}
			{!canDecide ? (
				<div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1">
					<p className="text-xs text-fg-muted">需要有权限的成员确认。</p>
					{toggle}
				</div>
			) : sent ? (
				<p role="status" className="mt-2.5 text-[13px] text-fg-muted">
					{sent === "approved" ? (draft ? "已提交保存，正在继续…" : "已允许，正在继续…") : draft ? "已选择不保存，正在通知助手…" : "已拒绝，正在通知助手…"}
				</p>
			) : confirming ? (
				<div data-testid="approval-confirm" role="alertdialog" aria-label="再次确认" className="mt-2.5 rounded-lg border border-danger/40 bg-surface p-2.5">
					<p className="text-[13px] font-medium text-danger">这是高风险操作，确认{yes}吗？</p>
					<p className="mt-0.5 text-xs text-fg-muted">{draft ? skillDraftHeading(draft) : approval.title}</p>
					<div className="mt-2 flex flex-wrap gap-2">
						<Button ref={backRef} size="sm" disabled={!!busy} onClick={() => (setConfirming(false), setTimeout(() => allowRef.current?.focus(), 0))} data-testid="approve-back" onKeyDown={(e) => e.key === "Escape" && setConfirming(false)}>
							返回
						</Button>
						<Button size="sm" variant="danger" disabled={!!busy} onClick={() => decide("approved")} data-testid="approve-confirm">
							{busy === "approved" ? "正在提交…" : `确认${yes}`}
						</Button>
					</div>
				</div>
			) : (
				<>
					{showNote ? (
						<div className="mt-2.5">
							<label htmlFor={`${uid}-n`} className="mb-1 block text-xs text-fg-muted">
								补充说明（可选）
							</label>
							<Textarea id={`${uid}-n`} value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="text-[13px]" />
						</div>
					) : null}
					<div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1">
						<Button size="sm" disabled={!!busy} onClick={() => decide("rejected")} data-testid="reject">
							{busy === "rejected" ? "正在提交…" : no}
						</Button>
						<Button ref={allowRef} size="sm" variant={high ? "secondary" : "primary"} disabled={!!busy || blocked} title={blocked ? "检查有必须修复的问题，暂时不能保存" : undefined} onClick={() => (high ? setConfirming(true) : decide("approved"))} data-testid="approve" className={cn(high && "border-danger/50 text-danger")}>
							{busy === "approved" ? "正在提交…" : high ? `${yes}…` : yes}
						</Button>
						{toggle}
						{!showNote ? (
							<button type="button" className="inline-flex h-8 items-center rounded-md px-2 text-xs text-fg-muted underline-offset-2 hover:bg-surface-2 hover:text-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info" onClick={() => setShowNote(true)}>
								添加说明
							</button>
						) : null}
					</div>
				</>
			)}
			<DetailsPanel id={panelId} open={open}>
				{draft ? <SkillDraftDetails d={draft} /> : null}
				<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
					{showAction && !draft ? (
						<>
							<dt className="text-fg-muted">操作</dt>
							<dd>{view.title}</dd>
						</>
					) : null}
					{(draft ? [] : scope).map((r) => (
						<Row key={r.label} label={r.label} value={r.value} />
					))}
					{draft || high ? null : (
						<>
							<dt className="text-fg-muted">风险</dt>
							<dd data-testid="approval-risk-note">{risk.note}</dd>
						</>
					)}
					<dt className="text-fg-muted">请求人</dt>
					<dd>
						助手{forMe ? "（代你执行）" : "（代另一位成员执行）"}
						<span className="text-fg-subtle"> · {relTime(approval.requestedAt)}</span>
					</dd>
					{approval.approverUserIds?.length ? (
						<>
							<dt className="text-fg-muted">审批人</dt>
							<dd>仅指定的审批人可以处理</dd>
						</>
					) : null}
				</dl>
				{approval.detail !== undefined ? (
					<div data-testid="approval-raw" className="text-[12.5px]">
						<div className="mb-0.5 text-xs text-fg-subtle">参数</div>
						<pre className="wr-scroll max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface px-2.5 py-2 font-mono text-[12px] text-fg-muted">{draft ? skillDraftTech(draft) : JSON.stringify(approval.detail, null, 2)}</pre>
					</div>
				) : null}
			</DetailsPanel>
		</m.div>
	);
}

function Row({ label, value }: { label: string; value: string }) {
	return (
		<>
			<dt className="text-fg-muted">{label}</dt>
			<dd className="min-w-0 break-words">{value}</dd>
		</>
	);
}

/** External write whose outcome is unknown: ask the user to verify at the target instead of re-running blindly. */
export function ReconcileCard({ effect, base }: { effect: EffectDTO; base: string }) {
	const uid = useId();
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	const resolve = async (outcome: "done" | "failed") => {
		setBusy(true);
		setErr(undefined);
		try {
			await post(`${base}/effects/${encodeURIComponent(effect.effectId)}/reconcile`, { outcome });
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div data-testid="reconcile-card" role="group" tabIndex={-1} aria-labelledby={`${uid}-t`} className="rounded-xl border border-danger/30 bg-danger-soft/40 p-3 outline-none focus-visible:ring-2 focus-visible:ring-info sm:px-3.5">
			<div className="flex items-start gap-2">
				<ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
				<h3 id={`${uid}-t`} className="min-w-0 flex-1 text-sm font-medium leading-5">
					待核对：外部操作结果不确定
				</h3>
			</div>
			<p className="mt-1 break-words text-[13px] leading-5">{effect.summary}</p>
			<dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[13px]">
				<dt className="text-fg-muted">目标</dt>
				<dd className="min-w-0 break-words">{effect.target}</dd>
				<dt className="text-fg-muted">情况</dt>
				<dd>执行被中断，不会自动重做。请到目标系统确认后选择：</dd>
			</dl>
			{err ? (
				<p role="alert" className="mt-2 text-[13px] text-danger">
					{err}
				</p>
			) : null}
			<div className="mt-2.5 flex flex-wrap items-center gap-2">
				<Button size="sm" disabled={busy} onClick={() => resolve("done")} data-testid="reconcile-done">
					已生效
				</Button>
				<Button size="sm" disabled={busy} onClick={() => resolve("failed")} data-testid="reconcile-failed">
					未生效
				</Button>
			</div>
			<p className="mt-2 break-all text-[11.5px] text-fg-subtle" title="幂等键">
				标识 <span className="font-mono">{effect.idempotencyKey}</span>
			</p>
		</div>
	);
}

/** Current validity of cited chunks for the open conversation (C: …/citation-status). Absent → snapshot only. */
export const CitationStatusContext = createContext<Record<string, CitationStatusDTO> | undefined>(undefined);

/** Answer citations: file + version + locator (page / section / paragraph / snippet). Click opens that version.
 * Old answers keep their snapshot; when the source changed since, a 失效提示 says how (updated / deleted / withdrawn /
 * expired / no access). Without access the snippet and link are hidden. */
export function Citations({ citations }: { citations: CitationDTO[] }) {
	const { openPreview } = usePanel();
	const statuses = useContext(CitationStatusContext);
	if (!citations.length) return null;
	return (
		<div data-testid="citations" className="mt-3">
			<div className="mb-1 flex items-center gap-1 text-xs text-fg-subtle">
				<BookMarked className="size-3.5" />
				引用来源
			</div>
			<ol className="space-y-1">
				{citations.map((c, i) => {
					const st = statuses?.[c.chunkId];
					if (st && st.status === "forbidden")
						return (
							<li key={c.chunkId} data-testid="citation" data-status={st.status} className="flex items-start gap-2 px-2 py-1 text-[12.5px] text-fg-muted">
								<span className="font-mono text-fg-subtle">[{c.n ?? i + 1}]</span>
								<span className="text-warning">{st.message}</span>
							</li>
						);
					return (
					<li key={c.chunkId} data-testid="citation" data-status={st?.status ?? "snapshot"}>
						{st && st.status !== "valid" ? (
							<div className="ml-8 mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-warning" data-testid="citation-stale">
								<AlertTriangle className="size-3" />
								{st.message}
								{st.status === "superseded" && st.current ? (
									<button className="text-info hover:underline" onClick={() => openPreview({ fileId: c.fileId, versionId: st.current!.versionId, name: c.fileName })}>
										查看当前 v{st.current.versionNo}
									</button>
								) : null}
							</div>
						) : null}
						<button
							onClick={() => openPreview({ fileId: c.fileId, versionId: c.versionId, name: c.fileName })}
							className="group flex w-full items-start gap-2 rounded-lg px-2 py-1 text-left text-[12.5px] hover:bg-surface-2"
							title={c.snippet}
						>
							<span className="mt-px shrink-0 font-mono text-fg-subtle">[{c.n ?? i + 1}]</span>
							<span className="min-w-0 flex-1">
								<span className="text-fg">{c.fileName}</span>
								<span className="text-fg-subtle">
									{" "}
									· v{c.versionNo} · {c.locator || (c.page ? `第 ${c.page} 页` : c.section ?? "")}
								</span>
								<span className="block truncate text-fg-muted">{c.snippet}</span>
							</span>
						</button>
					</li>
					);
				})}
			</ol>
		</div>
	);
}

/** A failure of the message, once, where it happened: one line (icon + plain words); when there is raw text, the chevron on its right opens it. */
export function ErrorNote({ text, detail }: { text: string; detail?: string }) {
	const [open, setOpen] = useState(false);
	const id = useId();
	if (!detail)
		return (
			<div data-testid="error-note" className="mt-2 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-1.5 text-[13px] text-danger">
				<AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
				<span className="min-w-0 break-words">{text}</span>
			</div>
		);
	return (
		<div data-testid="error-note" className="mt-2 rounded-lg bg-danger-soft text-[13px] text-danger">
			<button type="button" data-testid="error-details-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} className="flex w-full items-start gap-2 rounded-lg px-3 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info">
				<AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
				<span className="min-w-0 flex-1 break-words">{text}</span>
				<ChevronRight aria-hidden className={cn("mt-0.5 size-4 shrink-0 text-danger/70 transition-transform duration-150", open && "rotate-90")} />
			</button>
			{open ? (
				<pre id={id} data-testid="error-detail" className="wr-scroll wr-fade-in mx-3 mb-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[12px] text-fg-muted">
					{detail}
				</pre>
			) : null}
		</div>
	);
}
