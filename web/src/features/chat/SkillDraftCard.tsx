// A skill the assistant drafted in this conversation, shown for approval ("保存为个人技能") and, after the decision, as a result line.
// The approval mechanics (保存 / 不保存, high-risk second confirm, note, keyboard) live in ApprovalCard; this file is the content.
import { CheckCircle2, CircleX, Info, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { ApprovalDTO } from "@shared/chat";
import type { SkillDraftApprovalDetail, SkillDraftDTO } from "@shared/skill-drafts";
import { ApiError, get } from "@/lib/api";
import { formatBytes } from "@/lib/utils";
import { Badge } from "@/components/ui/misc";
import { permShort } from "@/features/market/common";
import { ClampText } from "./Disclosure";

export const SKILL_DRAFT_NOTE = "保存后仅你可用，不会自动运行。";
const SKILL_DRAFT_NOTE_MARKET = "新版本会提交审核，通过前仍用旧版本。";

/** The approval's detail when it is a skill draft; undefined for every other approval. */
export function skillDraftOf(detail: unknown): SkillDraftApprovalDetail | undefined {
	const d = detail as Partial<SkillDraftApprovalDetail> | null | undefined;
	return d && typeof d === "object" && d.kind === "skill_draft" && typeof d.name === "string" && Array.isArray(d.files) ? (d as SkillDraftApprovalDetail) : undefined;
}

/** Plain-words permission list; "无需额外权限" when there is none. */
export function permissionWords(d: SkillDraftApprovalDetail): string {
	const perms = [...new Set(d.requiredPermissions ?? [])].map(permShort);
	return perms.length ? perms.join("、") : "无需额外权限";
}

export const hasBlockingFinding = (d: SkillDraftApprovalDetail): boolean => d.findings.some((f) => f.severity === "error");

/** Heading of the card: a new skill or a new version of one the person already has (the 目标 comes from the server). */
export const skillDraftHeading = (d: SkillDraftApprovalDetail): string => (d.target?.mode === "update" ? "更新技能" : "保存为个人技能");

/** What changes the decision, on the face of the card: which skill, what it is for, how big, what it may do, how the check went. */
export function SkillDraftFace({ d }: { d: SkillDraftApprovalDetail }) {
	const warns = d.findings.filter((f) => f.severity === "warn");
	const errors = d.findings.filter((f) => f.severity === "error");
	const exec = d.files.filter((f) => f.executable).length;
	const target = d.target?.text ?? (d.updatesSkill ? `为你的技能「${d.updatesSkill.name}」添加新版本${d.updatesSkill.fromVersion ? `（当前 ${d.updatesSkill.fromVersion}）` : ""}` : undefined);
	return (
		<div data-testid="skill-draft" className="mt-1 text-[13px] leading-5">
			<p>
				<span data-testid="skill-draft-title" className="font-medium">
					{d.title || d.name}
				</span>
				{d.title && d.title !== d.name ? <span className="ml-1.5 font-mono text-xs text-fg-subtle">{d.name}</span> : null}
				<span className="ml-1.5 text-xs text-fg-muted">版本 {d.version}</span>
			</p>
			{target ? (
				<p data-testid="skill-draft-target" className="text-fg-muted">
					{target}
				</p>
			) : null}
			<ClampText testId="skill-draft-desc" className="mt-0.5">
				{d.description || "（没有填写）"}
			</ClampText>
			<p data-testid="skill-draft-glance" className="mt-1 text-xs text-fg-muted">
				{d.files.length} 个文件{exec ? `（含 ${exec} 个可执行脚本）` : ""} · 权限：{permissionWords(d)} · {warns.length ? `${warns.length} 条提醒` : errors.length ? "检查未通过" : "自动检查通过"}
			</p>
			{errors.length ? (
				<ul data-testid="skill-draft-blocking" className="mt-1.5 space-y-0.5">
					{errors.map((f, i) => (
						<li key={i} data-severity="error" className="flex items-start gap-1.5 text-danger">
							<CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
							<span className="break-words">
								<span className="font-medium">必须修复，暂时不能保存：</span>
								{f.message}
							</span>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

/** Everything else about the draft, behind 查看详情: the file list, permissions, every finding and the fixed sentence about what saving means. */
export function SkillDraftDetails({ d }: { d: SkillDraftApprovalDetail }) {
	const risky = d.findings.filter((f) => f.severity !== "info");
	return (
		<>
			<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
				<dt className="text-fg-muted">文件</dt>
				<dd className="min-w-0">
					<ul data-testid="skill-draft-files" className="space-y-0.5">
						{d.files.map((f) => (
							<li key={f.path} className="flex flex-wrap items-center gap-x-1.5">
								<span className="break-all font-mono text-xs">{f.path}</span>
								<span className="text-xs text-fg-subtle">· {formatBytes(f.size)}</span>
								{f.executable ? <Badge tone="warning">可执行脚本</Badge> : null}
							</li>
						))}
					</ul>
				</dd>
				<dt className="text-fg-muted">需要的权限</dt>
				<dd data-testid="skill-draft-perms">{permissionWords(d)}</dd>
				<dt className="text-fg-muted">检查结果</dt>
				<dd data-testid="skill-draft-risk" className="min-w-0">
					{risky.length ? (
						<ul className="space-y-0.5">
							{risky.map((f, i) => (
								<li key={i} data-severity={f.severity} className="flex items-start gap-1.5">
									{f.severity === "error" ? <CircleX aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" /> : <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />}
									<span className="break-words">
										<span className="font-medium">{f.severity === "error" ? "必须修复，暂时不能保存：" : "请留意："}</span>
										{f.message}
									</span>
								</li>
							))}
						</ul>
					) : (
						<span className="inline-flex items-center gap-1.5">
							<CheckCircle2 aria-hidden className="size-4 text-success" />
							自动检查没有发现问题。
						</span>
					)}
				</dd>
			</dl>
			<p data-testid="skill-draft-note" className="mt-2 flex items-start gap-1.5 text-xs text-fg-muted">
				<Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
				{d.target?.scope === "market" ? SKILL_DRAFT_NOTE_MARKET : SKILL_DRAFT_NOTE}
			</p>
		</>
	);
}

/** The raw part, for 技术详情 only. */
export function skillDraftTech(d: SkillDraftApprovalDetail): string {
	return JSON.stringify(
		{
			draftId: d.draftId,
			name: d.name,
			version: d.version,
			kind: d.skillKind,
			packageSha256: d.packageSha256,
			totalBytes: d.totalBytes,
			sourceDir: d.sourceDir,
			requiredPermissions: d.requiredPermissions,
			requiredTools: d.requiredTools,
			findings: d.findings,
			files: d.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256, executable: f.executable })),
		},
		null,
		2,
	);
}

/** Result wording that matches what really happened (a market skill's new version is submitted for review, not usable yet). */
function savedText(d: SkillDraftApprovalDetail, draft: SkillDraftDTO | null): string {
	const v = draft?.versionNo ? `（v${draft.versionNo}）` : "";
	if (d.target?.scope === "market") return draft ? `新版本${v}已提交审核${draft.error ? `：${draft.error}` : ""}` : "新版本已提交审核";
	if (d.target?.mode === "update") return `新版本${v}`;
	return v;
}

/** After the decision: 已保存 (link to 我的技能) / 未保存. The draft route may be absent; the approval status alone is then enough. */
export function SkillDraftResult({ approval, d }: { approval: ApprovalDTO; d: SkillDraftApprovalDetail }) {
	const approved = approval.status === "approved";
	const [draft, setDraft] = useState<SkillDraftDTO | null>(null);
	useEffect(() => {
		if (!approved) return;
		let live = true;
		get<{ draft: SkillDraftDTO }>(`/skill-drafts/${encodeURIComponent(d.draftId)}`)
			.then((r) => live && setDraft(r.draft))
			.catch((e) => {
				if (!(e instanceof ApiError)) return; // offline etc.: keep the approval-based wording
			});
		return () => {
			live = false;
		};
	}, [approved, d.draftId]);
	const failed = approved && draft?.state === "failed";
	const saved = approved && !failed;
	return (
		<div data-testid="skill-draft-result" data-state={failed ? "failed" : saved ? "saved" : "rejected"} role="status" className={`flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px] ${failed ? "rounded-lg bg-danger-soft px-3 py-1.5" : "px-1 py-0.5"}`}>
			{saved ? <CheckCircle2 aria-hidden className="size-4 text-success" /> : <CircleX aria-hidden className={failed ? "size-4 text-danger" : "size-4 text-fg-subtle"} />}
			<span className="font-medium">{failed ? "保存失败" : saved ? "已保存" : "未保存"}</span>
			<span className="min-w-0 break-words text-fg-muted">
				「{d.title || d.name}」{failed ? draft?.error ?? "" : saved ? savedText(d, draft) : ""}
			</span>
			{saved ? (
				<>
					<Link to="/capabilities" className="text-info underline-offset-2 hover:underline" data-testid="skill-draft-open">
						在「能力 › 我的技能」查看
					</Link>
					{d.target?.scope !== "market" ? <span className="text-fg-subtle">（可在那里提交审核）</span> : null}
				</>
			) : null}
		</div>
	);
}
