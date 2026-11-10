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

export const SKILL_DRAFT_NOTE = "保存后仅你可用；不会自动运行，也不会发布到商城。发布需在「能力 › 我的技能」另行提交审核。";

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

export function SkillDraftBody({ d }: { d: SkillDraftApprovalDetail }) {
	const risky = d.findings.filter((f) => f.severity !== "info");
	const exec = d.files.filter((f) => f.executable).length;
	return (
		<div data-testid="skill-draft" className="mt-1">
			<h3 className="text-[15px] font-medium">保存为个人技能</h3>
			<p className="mt-1 text-sm">
				<span data-testid="skill-draft-title" className="font-medium">
					{d.title || d.name}
				</span>
				{d.title && d.title !== d.name ? <span className="ml-1.5 font-mono text-xs text-fg-subtle">{d.name}</span> : null}
				<span className="ml-1.5 text-xs text-fg-muted">版本 {d.version}</span>
			</p>
			<dl className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
				<dt className="text-fg-muted">用途</dt>
				<dd data-testid="skill-draft-desc" className="min-w-0 break-words">
					{d.description || "（没有填写）"}
				</dd>
				{d.updatesSkill ? (
					<>
						<dt className="text-fg-muted">保存方式</dt>
						<dd>为你的技能「{d.updatesSkill.name}」添加新版本{d.updatesSkill.fromVersion ? `（当前 ${d.updatesSkill.fromVersion}）` : ""}</dd>
					</>
				) : null}
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
					{exec ? <p className="mt-1 text-xs text-fg-muted">包含 {exec} 个可执行脚本，保存后只在你使用该技能时、在沙箱里运行。</p> : null}
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
			<p data-testid="skill-draft-note" className="mt-3 flex items-start gap-1.5 text-xs text-fg-muted">
				<Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
				{SKILL_DRAFT_NOTE}
			</p>
		</div>
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
		<div data-testid="skill-draft-result" data-state={failed ? "failed" : saved ? "saved" : "rejected"} role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-border bg-surface px-4 py-3 text-sm">
			{saved ? <CheckCircle2 aria-hidden className="size-4 text-success" /> : <CircleX aria-hidden className={failed ? "size-4 text-danger" : "size-4 text-fg-subtle"} />}
			<span className="font-medium">{failed ? "保存失败" : saved ? "已保存" : "未保存"}</span>
			<span className="min-w-0 break-words text-fg-muted">
				「{d.title || d.name}」{failed ? draft?.error ?? "" : saved ? `已保存为你的个人技能${draft?.versionNo ? `（v${draft.versionNo}）` : ""}。` : "没有保存。"}
			</span>
			{saved ? (
				<Link to="/capabilities" className="text-info underline-offset-2 hover:underline" data-testid="skill-draft-open">
					在「能力 › 我的技能」查看
				</Link>
			) : null}
		</div>
	);
}
