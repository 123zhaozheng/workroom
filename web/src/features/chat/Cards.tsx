import { AlertTriangle, BookMarked, Download, FileCode2, FileImage, FileSpreadsheet, FileText, FileType2, Hand, Presentation, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { m } from "motion/react";
import type { ApprovalDTO, EffectDTO } from "@shared/chat";
import type { FileVersionRefDTO } from "@shared/files";
import type { CitationDTO } from "@shared/knowledge";
import { errorText, post } from "@/lib/api";
import { cn, formatBytes } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/misc";
import { Textarea } from "@/components/ui/input";
import { usePanel } from "@/components/shell/panel";

export function fileIcon(name: string, mime = "") {
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	if (mime.startsWith("image/")) return FileImage;
	if (["xlsx", "xls", "csv"].includes(ext)) return FileSpreadsheet;
	if (["pptx", "ppt"].includes(ext)) return Presentation;
	if (["html", "js", "ts", "py", "json", "css"].includes(ext)) return FileCode2;
	if (["pdf", "docx", "doc"].includes(ext)) return FileType2;
	return FileText;
}

/** Deliverable card. Click → right-side preview panel (drawer on narrow screens). */
export function FileCard({ file }: { file: FileVersionRefDTO }) {
	const { openPreview, panel } = usePanel();
	const Icon = fileIcon(file.name, file.mime);
	const active = panel?.kind === "preview" && panel.target.versionId === file.versionId;
	return (
		<div
			data-testid="file-card"
			className={cn("group flex w-full max-w-[420px] items-center gap-3 rounded-xl border bg-surface px-3 py-2.5 transition-colors", active ? "border-border-strong bg-surface-2" : "border-border hover:border-border-strong")}
		>
			<button
				onClick={() => openPreview({ fileId: file.fileId, versionId: file.versionId, name: file.name, mime: file.mime })}
				className="flex min-w-0 flex-1 items-center gap-3 text-left"
				aria-label={`预览 ${file.name}`}
			>
				<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-fg-muted">
					<Icon className="size-[18px]" />
				</span>
				<span className="min-w-0">
					<span className="block truncate text-sm font-medium">{file.name}</span>
					<span className="block text-xs text-fg-subtle">
						v{file.versionNo} · {formatBytes(file.size)} · 点击预览
					</span>
				</span>
			</button>
			<a href={`/api/files/${file.fileId}/versions/${file.versionId}/download`} className="rounded-md p-1.5 text-fg-subtle hover:bg-surface-2 hover:text-fg" aria-label={`下载 ${file.name}`} title="下载">
				<Download className="size-4" />
			</a>
		</div>
	);
}

const RISK: Record<ApprovalDTO["risk"], { label: string; tone: "neutral" | "warning" | "danger" }> = {
	low: { label: "低风险", tone: "neutral" },
	medium: { label: "中风险", tone: "warning" },
	high: { label: "高风险", tone: "danger" },
};

/** Pending approval / question card, embedded in the current task. Shows exactly what will happen. */
export function ApprovalCard({ approval, base, canDecide = true }: { approval: ApprovalDTO; base: string; canDecide?: boolean }) {
	const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
	const [note, setNote] = useState("");
	const [showNote, setShowNote] = useState(false);
	const [err, setErr] = useState<string>();
	const decide = async (decision: "approved" | "rejected") => {
		setBusy(decision);
		setErr(undefined);
		try {
			await post(`${base}/approvals/${encodeURIComponent(approval.approvalId)}`, { decision, ...(note.trim() ? { note: note.trim() } : {}) });
		} catch (e) {
			setErr(errorText(e));
			setBusy(null);
		}
	};
	const risk = RISK[approval.risk] ?? RISK.medium;
	return (
		<m.div
			initial={{ opacity: 0, y: 6 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.18 }}
			data-testid="approval-card"
			role="group"
			aria-label="待确认"
			className="rounded-xl border border-warning/40 bg-warning-soft/40 p-3.5"
		>
			<div className="flex items-start gap-2.5">
				<Hand className="mt-0.5 size-4 shrink-0 text-warning" />
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-sm font-medium">{approval.title}</span>
						<Badge tone={risk.tone}>{risk.label}</Badge>
						{approval.toolName ? <span className="text-xs text-fg-subtle">{approval.toolName}</span> : null}
					</div>
					<p className="mt-1 whitespace-pre-wrap text-[13.5px] text-fg">{approval.summary}</p>
					{approval.detail !== undefined ? (
						<details className="mt-1.5 text-[12.5px]">
							<summary className="cursor-pointer text-fg-muted">查看详细内容</summary>
							<pre className="wr-scroll mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface px-2.5 py-2 font-mono text-[12px] text-fg-muted">{JSON.stringify(approval.detail, null, 2)}</pre>
						</details>
					) : null}
					{showNote ? <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="补充说明（可选），会一并告诉助手" className="mt-2 text-[13px]" /> : null}
					{err ? <p className="mt-1.5 text-[13px] text-danger">{err}</p> : null}
					{canDecide ? (
						<div className="mt-2.5 flex flex-wrap items-center gap-2">
							<Button size="sm" variant="primary" disabled={!!busy} onClick={() => decide("approved")} data-testid="approve">
								{busy === "approved" ? "正在提交…" : "批准并继续"}
							</Button>
							<Button size="sm" disabled={!!busy} onClick={() => decide("rejected")} data-testid="reject">
								{busy === "rejected" ? "正在提交…" : "拒绝"}
							</Button>
							{!showNote ? (
								<button className="text-[12.5px] text-fg-muted hover:text-fg" onClick={() => setShowNote(true)}>
									添加说明
								</button>
							) : null}
						</div>
					) : (
						<p className="mt-2 text-[12.5px] text-fg-muted">需要有权限的成员确认。</p>
					)}
				</div>
			</div>
		</m.div>
	);
}

/** External write whose outcome is unknown: ask the user to verify at the target instead of re-running blindly. */
export function ReconcileCard({ effect, base }: { effect: EffectDTO; base: string }) {
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
		<div data-testid="reconcile-card" className="rounded-xl border border-danger/30 bg-danger-soft/40 p-3.5">
			<div className="flex items-start gap-2.5">
				<ShieldAlert className="mt-0.5 size-4 shrink-0 text-danger" />
				<div className="min-w-0 flex-1">
					<div className="text-sm font-medium">外部操作结果不确定，需要核对</div>
					<p className="mt-1 text-[13px] text-fg-muted">
						{effect.summary}（目标：{effect.target}）。执行过程中被中断，系统不会自动重做。请到目标系统确认是否已经生效。
					</p>
					<p className="mt-0.5 text-xs text-fg-subtle">幂等键：{effect.idempotencyKey}</p>
					{err ? <p className="mt-1 text-[13px] text-danger">{err}</p> : null}
					<div className="mt-2 flex gap-2">
						<Button size="sm" disabled={busy} onClick={() => resolve("done")}>
							已生效
						</Button>
						<Button size="sm" disabled={busy} onClick={() => resolve("failed")}>
							未生效
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}

/** Answer citations: file + version + locator (page / section / paragraph / snippet). Click opens that version. */
export function Citations({ citations }: { citations: CitationDTO[] }) {
	const { openPreview } = usePanel();
	if (!citations.length) return null;
	return (
		<div data-testid="citations" className="mt-3">
			<div className="mb-1 flex items-center gap-1 text-xs text-fg-subtle">
				<BookMarked className="size-3.5" />
				引用来源
			</div>
			<ol className="space-y-1">
				{citations.map((c, i) => (
					<li key={c.chunkId}>
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
				))}
			</ol>
		</div>
	);
}

export function ErrorNote({ text }: { text: string }) {
	return (
		<div className="mt-2 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
			<AlertTriangle className="mt-0.5 size-4 shrink-0" />
			<span className="min-w-0 break-words">{text}</span>
		</div>
	);
}
