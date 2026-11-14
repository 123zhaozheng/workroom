// 我的技能: toolbar with 上传技能 (small dialog: .zip or folder) and 新建技能 → automated check result → submit for review; card grid
// opening a detail dialog (info, SKILL.md preview, icon picker, version lifecycle, grants, download, uninstall, runs); my submissions.
import { ChevronRight, Download, Plus, RotateCcw, Send, ShieldCheck, Sparkles, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { MarketScope, SkillDTO, SkillKind, SkillListResponse, SkillRunDTO, SkillVersionDTO, SubmissionDTO } from "@shared/files";
import { del, errorText, patch, post, put } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { downloadText, formatBytes, fullTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { Badge, EmptyState, ErrorState, Loadable, Spinner } from "@/components/ui/misc";
import { Markdownish } from "./Markdownish";
import { IconPicker, SkillIcon } from "./SkillIcon";
import { UploadDialog, UploadOutcome, type UploadResult } from "./UploadDialog";
import { SCOPE, StateBadge, permText, useAct, useMarketMe } from "./common";

export const KIND: Record<SkillKind, { label: string; hint: string }> = {
	prompt: { label: "提示词预设", hint: "可复用的指令模板，不执行任何代码" },
	context: { label: "上下文技能", hint: "只向 AI 提供说明（SKILL.md），不执行代码" },
	executable: { label: "可执行技能", hint: "包含脚本与资源，在云端沙箱中执行，需要逐版本授权" },
};

export function MySkills() {
	const skills = useApi<SkillListResponse>("/skills");
	const subs = useApi<{ submissions: SubmissionDTO[] }>("/market/submissions?view=mine&kind=skill");
	const [create, setCreate] = useState(false);
	const [upload, setUpload] = useState(false);
	const [uploaded, setUploaded] = useState<UploadResult>();
	const [selectedId, setSelectedId] = useState<string>();
	const reloadAll = () => (skills.reload(), subs.reload());
	const selectedSkill = selectedId ? skills.data?.skills.find((s) => s.id === selectedId) : undefined;
	return (
		<div data-testid="my-skills">
			<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
				<h2 className="text-[15px] font-semibold">我的技能</h2>
				<div className="flex flex-wrap items-center gap-2">
					<Button onClick={() => setUpload(true)} disabled={skills.unavailable} data-testid="skill-upload">
						<Upload />
						上传技能
					</Button>
					<Button onClick={() => setCreate(true)} disabled={skills.unavailable} data-testid="skill-new">
						<Plus />
						新建技能
					</Button>
				</div>
			</div>
			{uploaded ? <UploadOutcome result={uploaded} onDismiss={() => setUploaded(undefined)} /> : null}
			<Loadable state={skills} what="技能">
				{(skills.data?.skills ?? []).length === 0 ? (
					<EmptyState icon={<Sparkles />} title="还没有技能" />
				) : (
					<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="my-skill-grid">
						{skills.data!.skills.map((s) => (
							<SkillCard key={s.id} s={s} onOpen={() => setSelectedId(s.id)} onChanged={reloadAll} />
						))}
					</div>
				)}
			</Loadable>
			{(subs.data?.submissions ?? []).length ? (
				<div className="mt-8" data-testid="my-submissions">
					<h2 className="mb-2 text-[15px] font-semibold">我的提交</h2>
					<ul className="divide-y divide-border rounded-xl border border-border bg-surface">
						{subs.data!.submissions.map((x) => (
							<li key={x.id} className="flex flex-wrap items-center gap-2 px-3.5 py-2.5 text-sm" data-testid="my-submission" data-state={x.state}>
								<span className="font-medium">{x.subjectName}</span>
								<span className="text-fg-muted">v{x.semver ?? x.versionNo}</span>
								<Badge>→ {SCOPE[x.targetScope]}</Badge>
								<StateBadge state={x.state} />
								{x.forced ? <Badge tone="warning">强制</Badge> : null}
								{x.decisionComment ? <span className="min-w-0 flex-1 truncate text-fg-muted">评语：{x.decisionComment}</span> : <span className="flex-1" />}
								<span className="text-xs text-fg-subtle">{fullTime(x.updatedAt)}</span>
								{x.state === "pending_review" || x.state === "changes_requested" ? (
									<WithdrawButton id={x.id} onDone={reloadAll} />
								) : null}
							</li>
						))}
					</ul>
				</div>
			) : null}
			{selectedId ? <SkillDetailDialog skillId={selectedId} initial={selectedSkill} onClose={() => setSelectedId(undefined)} onChanged={reloadAll} /> : null}
			<UploadDialog open={upload} onOpenChange={setUpload} onUploaded={(r) => (setUploaded(r), reloadAll())} />
			<CreateSkillDialog open={create} onOpenChange={setCreate} onCreated={reloadAll} />
		</div>
	);
}

function WithdrawButton({ id, onDone }: { id: string; onDone: () => void }) {
	const { busy, run } = useAct(onDone);
	return (
		<Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => post(`/market/submissions/${id}/withdraw`))}>
			撤回
		</Button>
	);
}

// ---------------------------------------------------------------- submit a version for review
function VersionSubmit({ skill, onChanged }: { skill: SkillDTO; onChanged: () => void }) {
	const [open, setOpen] = useState(false);
	const [versionNo, setVersionNo] = useState(skill.latestVersionNo);
	const [picked, setScope] = useState<MarketScope | null>(null);
	const [ref, setRef] = useState("");
	const [note, setNote] = useState("");
	const me = useMarketMe();
	// Default to the first target this person may actually choose; org needs skill.publish (the server enforces it too).
	const canOrg = !!me.data?.me.canPublishOrg;
	const scope: MarketScope = picked && (picked !== "org" || canOrg) ? picked : canOrg ? "org" : "project";
	const projects = useApi<{ projects: { id: string; name: string }[] }>(open && scope === "project" ? "/projects?kind=space" : null);
	const depts = useApi<{ departments: { id: string; name: string }[] }>(open && scope === "department" ? "/departments" : null);
	const { busy, err, run } = useAct(() => (setOpen(false), onChanged()));
	const eligible = (skill.versions ?? []).filter((v) => v.source === "package" || true);
	return (
		<div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-3 py-2" data-testid="version-submit">
			<Send className="size-4 text-fg-muted" />
			<span className="text-sm">分享给项目、部门或组织</span>
			<Button size="sm" onClick={() => (setVersionNo(skill.latestVersionNo), setOpen(true))} data-testid="submit-review">
				提交审核…
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent title="提交审核">
					<div className="space-y-3 text-sm">
						<div className="grid grid-cols-2 gap-3">
							<div>
								<Label htmlFor="sv">版本</Label>
								<Select id="sv" className="w-full" value={versionNo} onChange={(e) => setVersionNo(Number(e.target.value))} data-testid="submit-version">
									{eligible.map((v) => (
										<option key={v.versionNo} value={v.versionNo}>
											v{v.versionNo}
											{v.semver ? `（${v.semver}）` : ""}
										</option>
									))}
								</Select>
							</div>
							<div>
								<Label htmlFor="ss">发布到</Label>
								<Select id="ss" className="w-full" value={scope} onChange={(e) => (setScope(e.target.value as MarketScope), setRef(""))} data-testid="submit-scope">
									<option value="org" disabled={me.data ? !canOrg : false}>
										整个组织{me.data && !canOrg ? "（无权限）" : ""}
									</option>
									<option value="department">某个部门</option>
									<option value="project">某个项目</option>
									{me.data?.me.policy.personalSkill === "review" ? <option value="personal">仅自己（策略要求审核）</option> : null}
								</Select>
							</div>
						</div>
						{me.data && !canOrg ? (
							<p className="text-xs text-fg-muted" data-testid="submit-scope-note">
								无权发布到整个组织
							</p>
						) : null}
						{scope === "department" || scope === "project" ? (
							<div>
								<Label htmlFor="sr">{scope === "department" ? "部门" : "项目"}</Label>
								<Select id="sr" className="w-full" value={ref} onChange={(e) => setRef(e.target.value)} data-testid="submit-ref">
									<option value="">请选择…</option>
									{(scope === "department" ? depts.data?.departments : projects.data?.projects)?.map((x) => (
										<option key={x.id} value={x.id}>
											{x.name}
										</option>
									))}
								</Select>
							</div>
						) : null}
						<div>
							<Label htmlFor="sn2">给审查员的说明（可选）</Label>
							<Textarea id="sn2" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
						</div>
						{err ? <p className="text-danger">{err}</p> : null}
						<div className="flex justify-end">
							<Button variant="primary" disabled={busy || ((scope === "department" || scope === "project") && !ref)} onClick={() => run(() => post(`/market/skills/${skill.id}/versions/${versionNo}/submit`, { targetScope: scope, targetRef: ref || undefined, note }))} data-testid="submit-confirm">
								提交
							</Button>
						</div>
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function SkillCard({ s, onOpen, onChanged }: { s: SkillDTO; onOpen: () => void; onChanged: () => void }) {
	const { busy, err, run } = useAct(onChanged);
	const inst = s.install;
	return (
		<div
			data-testid="my-skill-card"
			data-skill-id={s.id}
			onClick={(e) => {
				if (!(e.target as HTMLElement).closest("button, a, input, select, [role='switch']")) onOpen();
			}}
			className="flex cursor-pointer flex-col gap-2.5 rounded-xl border border-border bg-surface p-3.5 transition-shadow hover:shadow-pop"
		>
			<button
				type="button"
				onClick={onOpen}
				aria-haspopup="dialog"
				aria-label={`${s.name}，查看详情`}
				className="flex min-w-0 items-start gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<SkillIcon skill={s} />
				<span className="min-w-0 flex-1">
					<span className="block truncate font-medium">{s.name}</span>
					<span className="mt-0.5 block truncate text-sm text-fg-muted" data-testid="skill-desc">
						{s.description ?? KIND[s.kind].hint}
					</span>
				</span>
				<ChevronRight className="mt-1 size-4 shrink-0 text-fg-subtle" />
			</button>
			<div className="flex flex-wrap items-center gap-1.5">
				<Badge title={KIND[s.kind].hint}>{KIND[s.kind].label}</Badge>
				<Badge>{SCOPE[s.scope]}</Badge>
				{s.viaScope?.length ? <Badge tone="info">由{s.viaScope.map((x) => SCOPE[x]).join("/")}安装</Badge> : null}
				{s.scope !== "personal" && s.listed === false ? <Badge tone="danger">已下架</Badge> : null}
			</div>
			<div className="mt-auto flex flex-wrap items-center gap-2">
				{inst ? (
					<>
						<Badge tone={inst.enabled ? "success" : "neutral"} data-testid="skill-state">
							{inst.enabled ? "已启用" : "已停用"} · 使用 v{inst.effectiveVersionNo}
							{inst.pinnedVersionNo !== null ? "（固定）" : "（跟随最新）"}
						</Badge>
						<span className="ml-auto flex items-center gap-2 text-xs text-fg-muted">
							<Switch aria-label={`启用 ${s.name}`} data-testid="skill-enable" checked={inst.enabled} busy={busy} onCheckedChange={(v) => run(() => patch(`/skills/${s.id}/install`, { enabled: v }))} />
							启用
						</span>
					</>
				) : (
					<Button size="sm" disabled={busy} onClick={() => run(() => post(`/skills/${s.id}/install`))} data-testid="skill-install">
						安装
					</Button>
				)}
			</div>
			{err ? <p className="text-sm text-danger">{err}</p> : null}
		</div>
	);
}

function buildSkillMarkdown(skill: SkillDTO, v: SkillVersionDTO): string {
	const name = skill.slug || skill.name;
	const lines = ["---", `name: ${name}`, `description: ${v.description || skill.description || ""}`, `version: ${v.semver ?? `${v.versionNo}.0.0`}`];
	if (v.entry) lines.push(`entry: ${v.entry}`);
	if (v.requiredPermissions.length) lines.push(`permissions: [${v.requiredPermissions.join(", ")}]`);
	lines.push("---", "", v.instructions, "");
	return lines.join("\n");
}

function SkillDetailDialog({ skillId, initial, onClose, onChanged }: { skillId: string; initial?: SkillDTO; onClose: () => void; onChanged: () => void }) {
	const detail = useApi<{ skill: SkillDTO }>(`/skills/${skillId}`);
	const runs = useApi<{ runs: SkillRunDTO[] }>(`/skills/${skillId}/runs`);
	const [downloading, setDownloading] = useState(false);
	const [dlErr, setDlErr] = useState<string>();
	const { busy, err, run } = useAct(() => {
		onChanged();
		detail.reload();
	});
	const { busy: uninstalling, err: uninstallErr, run: runUninstall } = useAct(() => {
		onChanged();
		onClose();
	});

	const full = detail.data?.skill ?? initial;
	const inst = full?.install;
	const versions = full?.versions ?? [];
	const eff = versions.find((v) => v.versionNo === (inst?.effectiveVersionNo ?? full?.latestVersionNo)) ?? versions[0];
	const missing = eff ? eff.requiredPermissions.filter((p) => !(inst?.grantedPermissions ?? []).includes(p)) : [];
	const allErr = err ?? uninstallErr ?? dlErr;

	const downloadSkill = async () => {
		if (!full || !eff) return;
		setDownloading(true);
		setDlErr(undefined);
		try {
			if (eff.source === "package") {
				const r = await fetch(`/api/market/skills/${encodeURIComponent(full.id)}/versions/${eff.versionNo}/package`, { credentials: "include" });
				if (r.ok) {
					const blob = await r.blob();
					const cd = r.headers.get("content-disposition") ?? "";
					const m = /filename="([^"]+)"/.exec(cd);
					const filename = m?.[1] ?? `${full.slug || full.name}-v${eff.versionNo}.zip`;
					const url = URL.createObjectURL(blob);
					const a = document.createElement("a");
					a.href = url;
					a.download = filename;
					a.click();
					setTimeout(() => URL.revokeObjectURL(url), 1000);
					return;
				}
				if (r.status !== 404) {
					const j = await r.json().catch(() => null);
					throw new Error(j?.error?.message ?? `下载失败 (${r.status})`);
				}
			}
			downloadText(`${full.slug || full.name}-v${eff.versionNo}-SKILL.md`, buildSkillMarkdown(full, eff));
		} catch (e) {
			setDlErr(errorText(e));
		} finally {
			setDownloading(false);
		}
	};

	const busyAny = busy || uninstalling;
	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent
				title={full?.name ?? "技能详情"}
				description={full ? full.description ?? eff?.description ?? KIND[full.kind].hint : "加载技能详情"}
				data-testid="skill-detail-dialog"
				className="top-[6dvh] flex h-[min(680px,86dvh)] max-h-[86dvh] w-[calc(100vw-24px)] max-w-[840px] translate-y-0 flex-col overflow-hidden p-5"
			>
				{!full ? (
					<div className="flex items-center gap-2 py-10 text-sm text-fg-subtle">
						<Spinner /> 加载中…
					</div>
				) : (
					<>
						<div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-border pb-3">
							<SkillIcon skill={{ ...full, description: full.description ?? eff?.description }} size={36} />
							{full.slug ? <span className="font-mono text-xs text-fg-subtle">/skills/{full.slug}</span> : null}
							<Badge title={KIND[full.kind].hint}>{KIND[full.kind].label}</Badge>
							<Badge>{SCOPE[full.scope]}</Badge>
							{full.viaScope?.length ? <Badge tone="info">由{full.viaScope.map((x) => SCOPE[x]).join("/")}安装</Badge> : null}
							{full.scope !== "personal" && full.listed === false ? <Badge tone="danger">已下架</Badge> : null}
							{inst ? (
								<Badge tone={inst.enabled ? "success" : "neutral"} data-testid="skill-state">
									{inst.enabled ? "已启用" : "已停用"} · 使用 v{inst.effectiveVersionNo}
									{inst.pinnedVersionNo !== null ? "（固定）" : "（跟随最新）"}
								</Badge>
							) : null}
							<div className="ml-auto flex flex-wrap items-center gap-2">
								{inst ? (
									<span className="flex items-center gap-2 text-xs text-fg-muted">
										<Switch aria-label={`启用 ${full.name}`} data-testid="skill-enable" checked={inst.enabled} busy={busyAny} onCheckedChange={(v) => run(() => patch(`/skills/${full.id}/install`, { enabled: v }))} />
										启用
									</span>
								) : (
									<Button size="sm" variant="primary" disabled={busyAny} onClick={() => run(() => post(`/skills/${full.id}/install`))} data-testid="skill-install">
										安装
									</Button>
								)}
								{eff ? (
									<Button size="sm" disabled={downloading || busyAny} onClick={() => void downloadSkill()} data-testid="skill-download">
										<Download />
										下载
									</Button>
								) : null}
								{inst ? (
									<Button size="sm" variant="ghost" disabled={busyAny} onClick={() => runUninstall(() => del(`/skills/${full.id}/install`))} data-testid="skill-uninstall">
										<Trash2 />
										卸载
									</Button>
								) : null}
							</div>
						</div>

						<div className="wr-scroll -mx-1 min-h-0 flex-1 space-y-4 overflow-y-auto px-1 pt-4 text-sm">
							{allErr ? (
								<p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
									{allErr}
								</p>
							) : null}
							{detail.loading && !detail.data ? (
								<div className="flex items-center gap-2 py-6 text-fg-subtle">
									<Spinner /> 加载详情中…
								</div>
							) : null}
							{detail.error ? <ErrorState error={detail.error} onRetry={detail.reload} what="技能详情" /> : null}

							{full.canManage ? (
								<div data-testid="icon-edit">
									<div className="mb-1.5 text-xs font-medium text-fg-muted">图标</div>
									<IconPicker value={full.icon} auto={{ name: full.name, slug: full.slug, category: full.category, tags: full.tags, description: full.description ?? eff?.description }} disabled={busyAny} onChange={(icon) => run(() => put(`/market/skills/${full.id}/icon`, { icon }))} />
								</div>
							) : null}

							{eff ? (
								<div>
									{eff.description && eff.description !== full.description ? <p className="mb-1 text-fg-muted">{eff.description}</p> : null}
									<p className="text-xs text-fg-subtle">
										依赖：{eff.requiredTools.length ? eff.requiredTools.map((t) => `工具 ${t}`).join("、") : "无工具"}
										{eff.requiredPermissions.length ? ` · 权限：${eff.requiredPermissions.map(permText).join("、")}` : " · 无需额外权限"}
										{eff.entry ? ` · 入口 ${eff.entry}` : ""}
									</p>
								</div>
							) : null}

							{inst && eff && eff.requiredPermissions.length ? (
								<div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-3 py-2" data-testid="skill-grants">
									<ShieldCheck className="size-4 text-fg-muted" />
									<span>
										v{eff.versionNo} 授权：{missing.length ? <span className="text-warning">缺少 {missing.map(permText).join("、")}</span> : <span className="text-success">已全部授予</span>}
									</span>
									{missing.length ? (
										<Button size="sm" disabled={busyAny} onClick={() => run(() => post(`/skills/${full.id}/grants`, { versionNo: eff.versionNo, permissions: eff.requiredPermissions.filter((p) => p !== "network") }))}>
											授予 v{eff.versionNo} 所需权限
										</Button>
									) : null}
								</div>
							) : null}

							{inst ? (
								<div className="flex flex-wrap items-center gap-2">
									<Select
										aria-label="版本"
										data-testid="skill-pin"
										value={inst.pinnedVersionNo === null ? "latest" : String(inst.pinnedVersionNo)}
										disabled={busyAny}
										onChange={(e) => run(() => patch(`/skills/${full.id}/install`, { pinnedVersionNo: e.target.value === "latest" ? null : Number(e.target.value) }))}
										className="h-8 text-sm"
									>
										<option value="latest">跟随最新（v{full.latestVersionNo}）</option>
										{versions.map((v) => (
											<option key={v.versionNo} value={v.versionNo}>
												固定在 v{v.versionNo}
											</option>
										))}
									</Select>
									<Button size="sm" disabled={busyAny || inst.effectiveVersionNo === full.latestVersionNo} onClick={() => run(() => post(`/skills/${full.id}/install/upgrade`))}>
										<Upload />
										升级到 v{full.latestVersionNo}
									</Button>
									<Button size="sm" disabled={busyAny || inst.effectiveVersionNo <= 1} onClick={() => run(() => post(`/skills/${full.id}/install/rollback`))} data-testid="skill-rollback">
										<RotateCcw />
										回滚
									</Button>
								</div>
							) : null}

							{full.canManage ? <VersionSubmit skill={full} onChanged={() => (onChanged(), detail.reload())} /> : null}

							{eff ? (
								<div className="rounded-xl border border-border bg-surface-2/40 p-3.5" data-testid="skill-md-preview">
									<div className="mb-2 flex flex-wrap items-center justify-between gap-2">
										<span className="text-xs font-medium text-fg-muted">
											SKILL.md 预览（v{eff.versionNo}
											{eff.semver ? ` · ${eff.semver}` : ""}）
										</span>
										{eff.resources.length ? <span className="text-xs text-fg-subtle">{eff.resources.length} 个文件</span> : null}
									</div>
									<Markdownish text={eff.instructions} />
									{eff.resources.length ? (
										<div className="mt-3 border-t border-border pt-2.5">
											<div className="mb-1.5 text-xs font-medium text-fg-muted">包含文件</div>
											<ul className="flex flex-wrap gap-1.5">
												{eff.resources.map((r) => (
													<li key={r.path} className="rounded-md border border-border bg-surface px-2 py-0.5 font-mono text-xs text-fg-muted">
														{r.path} · {formatBytes(r.size)}
													</li>
												))}
											</ul>
										</div>
									) : null}
								</div>
							) : null}

							{versions.length ? (
								<div>
									<div className="mb-1 text-xs font-medium text-fg-muted">版本</div>
									<ul className="space-y-0.5 text-xs text-fg-muted" data-testid="skill-versions">
										{versions.map((v) => (
											<li key={v.versionNo}>
												v{v.versionNo} · {fullTime(v.createdAt)} · {v.semver ? `${v.semver} · ` : ""}
												{v.source === "from_task" ? "从任务整理" : v.source === "package" ? "技能包" : "手动"}
												{v.changeNote ? ` · ${v.changeNote}` : ""}
												{v.validation ? (v.validation.ok ? " · 验证通过" : " · 验证未通过") : ""}
											</li>
										))}
									</ul>
								</div>
							) : null}

							<div>
								<div className="mb-1 text-xs font-medium text-fg-muted">运行记录（任务实际使用的版本）</div>
								{(runs.data?.runs ?? []).length === 0 ? (
									<p className="text-xs text-fg-subtle">没有记录。</p>
								) : (
									<ul className="space-y-0.5 text-xs text-fg-muted" data-testid="skill-runs">
										{runs.data!.runs.slice(0, 10).map((r) => (
											<li key={r.id}>
												{fullTime(r.at)} · {r.mode === "load" ? "加载" : r.mode === "run" ? "执行" : "验证"} v{r.versionNo} · {r.status === "ok" ? "成功" : r.status === "denied" ? "被拒绝" : "出错"}
												{r.detail ? ` · ${r.detail}` : ""}
												{r.conversationId && r.spaceId ? (
													<>
														{" · "}
														<Link className="text-info hover:underline" to={`/c/${r.spaceId}/${r.conversationId}`}>
															对话
														</Link>
													</>
												) : null}
											</li>
										))}
									</ul>
								)}
							</div>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

function CreateSkillDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
	const [name, setName] = useState("");
	const [kind, setKind] = useState<"prompt" | "context">("prompt");
	const [description, setDescription] = useState("");
	const [instructions, setInstructions] = useState("");
	const [icon, setIcon] = useState<string | null>(null);
	const { busy, err, run } = useAct(() => {
		onOpenChange(false);
		setName("");
		setInstructions("");
		setIcon(null);
		onCreated();
	});
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title="新建技能" className="max-w-lg">
				<div className="space-y-3">
					<div>
						<Label htmlFor="sn">名称</Label>
						<Input id="sn" value={name} onChange={(e) => setName(e.target.value)} />
					</div>
					<div>
						<Label htmlFor="sk">类型</Label>
						<Select id="sk" value={kind} onChange={(e) => setKind(e.target.value as "prompt" | "context")} className="w-full">
							<option value="prompt">{KIND.prompt.label}</option>
							<option value="context">{KIND.context.label}</option>
						</Select>
					</div>
					<div>
						<Label htmlFor="sd">一句话说明</Label>
						<Input id="sd" value={description} onChange={(e) => setDescription(e.target.value)} />
					</div>
					<div>
						<Label>图标</Label>
						<IconPicker value={icon ?? undefined} auto={{ name, description }} onChange={setIcon} />
					</div>
					<div>
						<Label htmlFor="si">指令 / SKILL.md</Label>
						<Textarea id="si" rows={6} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
					</div>
					{err ? <p className="text-sm text-danger">{err}</p> : null}
					<div className="flex justify-end">
						<Button variant="primary" disabled={busy || !name.trim() || !instructions.trim()} onClick={() => run(() => post("/skills", { name, kind, description, instructions, ...(icon ? { icon } : {}) }))} data-testid="skill-create">
							创建并安装
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
