// 我的技能: upload a skill package (drag-drop .zip or pick a folder) → automated check result → submit for review; my installs with the
// full version lifecycle (pin / upgrade / rollback / grants / runs); drafts made from a finished task; my submissions and their state.
import { CheckCircle2, ChevronRight, CircleX, FileArchive, FolderUp, Plus, RefreshCw, RotateCcw, Send, ShieldCheck, Sparkles, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router";
import type { MarketScope, PackageCheckDTO, SkillDTO, SkillDraftDTO, SkillKind, SkillListResponse, SkillRunDTO, SubmissionDTO } from "@shared/files";
import { ApiError, errorText, patch, post, put } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { cn, fullTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { Badge, EmptyState, Loadable } from "@/components/ui/misc";
import { IconPicker, SkillIcon } from "./SkillIcon";
import { FindingList, SCOPE, StateBadge, permText, useAct, useMarketMe } from "./common";

export const KIND: Record<SkillKind, { label: string; hint: string }> = {
	prompt: { label: "提示词预设", hint: "可复用的指令模板，不执行任何代码" },
	context: { label: "上下文技能", hint: "只向助手提供说明（SKILL.md），不执行代码" },
	executable: { label: "可执行技能", hint: "包含脚本与资源，在云端沙箱中执行，需要逐版本授权" },
};

export function MySkills({ draftId, onDraftDone }: { draftId: string | null; onDraftDone: () => void }) {
	const skills = useApi<SkillListResponse>("/skills");
	const subs = useApi<{ submissions: SubmissionDTO[] }>("/market/submissions?view=mine&kind=skill");
	const [create, setCreate] = useState(false);
	const reloadAll = () => (skills.reload(), subs.reload());
	return (
		<div data-testid="my-skills">
			{draftId ? <DraftPanel id={draftId} onDone={() => (onDraftDone(), skills.reload())} /> : null}
			<UploadPanel onUploaded={reloadAll} />
			<div className="mb-3 mt-6 flex items-center justify-between">
				<h2 className="text-[15px] font-semibold">我的技能</h2>
				<Button onClick={() => setCreate(true)} disabled={skills.unavailable} data-testid="skill-new">
					<Plus />
					新建技能
				</Button>
			</div>
			<Loadable state={skills} what="技能">
				{(skills.data?.skills ?? []).length === 0 ? (
					<EmptyState icon={<Sparkles />} title="还没有技能" />
				) : (
					<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="my-skill-grid">
						{skills.data!.skills.map((s) => (
							<SkillCard key={s.id} s={s} onChanged={reloadAll} />
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

// ---------------------------------------------------------------- upload (drag-drop zip / pick folder)
async function readFolder(files: FileList): Promise<{ path: string; content: string; encoding: "base64" }[]> {
	const out: { path: string; content: string; encoding: "base64" }[] = [];
	for (const f of Array.from(files)) {
		const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
		const bytes = new Uint8Array(await f.arrayBuffer());
		let bin = "";
		for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		out.push({ path: rel, content: btoa(bin), encoding: "base64" });
	}
	return out;
}

function UploadPanel({ onUploaded, skillId }: { onUploaded: () => void; skillId?: string }) {
	const [drag, setDrag] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<{ text: string; findings?: PackageCheckDTO["findings"] }>();
	const [result, setResult] = useState<{ name: string; versionNo: number; skillId: string; checks: PackageCheckDTO; submission?: SubmissionDTO }>();
	const zipRef = useRef<HTMLInputElement>(null);
	const dirRef = useRef<HTMLInputElement>(null);
	const me = useMarketMe();
	const send = async (build: () => Promise<FormData | Record<string, unknown>>) => {
		setBusy(true);
		setErr(undefined);
		setResult(undefined);
		try {
			const body = await build();
			const r = await post<{ skill: { id: string; name: string }; versionNo: number; checks: PackageCheckDTO; submission?: SubmissionDTO }>("/market/skills/upload", body as Record<string, unknown>);
			setResult({ name: r.skill.name, versionNo: r.versionNo, skillId: r.skill.id, checks: r.checks, submission: r.submission });
			onUploaded();
		} catch (e) {
			const detail = e instanceof ApiError ? (e.detail as { findings?: PackageCheckDTO["findings"] } | undefined) : undefined;
			setErr({ text: errorText(e), findings: detail?.findings });
		} finally {
			setBusy(false);
		}
	};
	const sendZip = (f: File) =>
		send(async () => {
			const fd = new FormData();
			fd.set("file", f);
			if (skillId) fd.set("skillId", skillId);
			return fd;
		});
	const onDrop = async (e: React.DragEvent) => {
		e.preventDefault();
		setDrag(false);
		const f = e.dataTransfer.files[0];
		if (f) await sendZip(f);
	};
	const lim = me.data?.me.limits;
	return (
		<section data-testid="upload-panel">
			<div
				onDragOver={(e) => (e.preventDefault(), setDrag(true))}
				onDragLeave={() => setDrag(false)}
				onDrop={onDrop}
				data-testid="dropzone"
				data-drag={drag}
				className={cn("flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-7 text-center transition-colors", drag ? "border-accent bg-surface-2" : "border-border-strong bg-surface")}
			>
				<div className="flex size-10 items-center justify-center rounded-xl bg-surface-2 text-fg-muted">
					<Upload className="size-5" />
				</div>
				<div className="text-[14px] font-medium">把技能包（.zip）拖到这里上传</div>
				{lim ? <p className="text-xs text-fg-muted">上限 {Math.round(lim.uploadBytes / 1048576)} MB · {lim.files} 个文件</p> : null}
				<div className="mt-1 flex flex-wrap justify-center gap-2">
					<Button size="sm" disabled={busy} onClick={() => zipRef.current?.click()} data-testid="upload-zip">
						<FileArchive />
						选择 .zip
					</Button>
					<Button size="sm" disabled={busy} onClick={() => dirRef.current?.click()} data-testid="upload-folder">
						<FolderUp />
						选择文件夹
					</Button>
				</div>
				<input ref={zipRef} type="file" accept=".zip,application/zip" hidden data-testid="upload-zip-input" onChange={(e) => (e.target.files?.[0] && void sendZip(e.target.files[0]), (e.target.value = ""))} />
				<input
					ref={dirRef}
					type="file"
					hidden
					multiple
					// @ts-expect-error non-standard but universally supported directory picker
					webkitdirectory=""
					data-testid="upload-folder-input"
					onChange={(e) => {
						const fl = e.target.files;
						if (fl?.length) void send(async () => ({ files: await readFolder(fl), ...(skillId ? { skillId } : {}) }));
						e.target.value = "";
					}}
				/>
				{busy ? <p className="text-xs text-fg-muted">正在上传并检查…</p> : null}
			</div>
			{err ? (
				<div className="mt-3 rounded-xl border border-danger/40 bg-danger-soft/40 p-3.5 text-sm" data-testid="upload-error">
					<div className="mb-1.5 flex items-center gap-1.5 font-medium text-danger">
						<CircleX className="size-4" />
						上传被拒绝：{err.text}
					</div>
					{err.findings?.length ? <FindingList findings={err.findings} /> : null}
				</div>
			) : null}
			{result ? (
				<div className="mt-3 rounded-xl border border-border bg-surface p-3.5 text-sm" data-testid="upload-result">
					<div className="mb-2 flex flex-wrap items-center gap-2">
						<CheckCircle2 className="size-4 text-success" />
						<span className="font-medium">已上传「{result.name}」v{result.versionNo}</span>
						<span className="text-xs text-fg-subtle">
							{result.checks.stats.fileCount} 个文件 · {(result.checks.stats.packageBytes / 1024).toFixed(1)} KB
						</span>
						{result.submission ? <StateBadge state={result.submission.state} /> : null}
					</div>
					<FindingList findings={result.checks.findings} empty="自动检查没有发现问题。" />
				</div>
			) : null}
		</section>
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
							<Label htmlFor="sn2">给审核员的说明（可选）</Label>
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

function SkillCard({ s, onChanged }: { s: SkillDTO; onChanged: () => void }) {
	const [open, setOpen] = useState(false);
	const detail = useApi<{ skill: SkillDTO }>(open ? `/skills/${s.id}` : null);
	const runs = useApi<{ runs: SkillRunDTO[] }>(open ? `/skills/${s.id}/runs` : null);
	const { busy, err, run } = useAct(() => {
		onChanged();
		detail.reload();
	});
	const full = detail.data?.skill ?? s;
	const inst = full.install;
	const versions = full.versions ?? [];
	const eff = versions.find((v) => v.versionNo === (inst?.effectiveVersionNo ?? full.latestVersionNo));
	const missing = eff ? eff.requiredPermissions.filter((p) => !(inst?.grantedPermissions ?? []).includes(p)) : [];
	return (
		<div data-testid="skill" className={cn("rounded-xl border border-border bg-surface", open && "col-span-full")}>
			<div className="flex flex-col gap-2.5 p-3.5">
				<button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`${s.name}，${open ? "收起" : "展开"}详情`} className="flex min-w-0 items-start gap-3 text-left">
					<SkillIcon skill={{ ...s, description: s.description ?? eff?.description }} />
					<span className="min-w-0 flex-1">
						<span className="block truncate font-medium">{s.name}</span>
						<span className="mt-0.5 block truncate text-sm text-fg-muted" data-testid="skill-desc">{s.description ?? eff?.description ?? KIND[s.kind].hint}</span>
					</span>
					<ChevronRight className={cn("mt-1 size-4 shrink-0 text-fg-subtle transition-transform", open && "rotate-90")} />
				</button>
				<div className="flex flex-wrap items-center gap-1.5">
					<Badge title={KIND[s.kind].hint}>{KIND[s.kind].label}</Badge>
					<Badge>{SCOPE[s.scope]}</Badge>
					{s.viaScope?.length ? <Badge tone="info">由{s.viaScope.map((x) => SCOPE[x]).join("/")}安装</Badge> : null}
					{s.scope !== "personal" && s.listed === false ? <Badge tone="danger">已下架</Badge> : null}
				</div>
				<div className="flex flex-wrap items-center gap-2">
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
			</div>
			{err ? <p className="px-3.5 pb-2 text-sm text-danger">{err}</p> : null}
			{open ? (
				<div className="space-y-3 border-t border-border p-3.5 text-sm">
					{full.canManage ? (
						<div data-testid="icon-edit">
							<div className="mb-1.5 text-xs font-medium text-fg-muted">图标</div>
							<IconPicker value={full.icon} auto={{ name: full.name, slug: full.slug, category: full.category, tags: full.tags, description: full.description ?? eff?.description }} disabled={busy} onChange={(icon) => run(() => put(`/market/skills/${s.id}/icon`, { icon }))} />
						</div>
					) : null}
					{eff ? (
						<div>
							<p className="text-fg-muted">{eff.description}</p>
							<p className="mt-1 text-xs text-fg-subtle">
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
								<Button size="sm" disabled={busy} onClick={() => run(() => post(`/skills/${s.id}/grants`, { versionNo: eff.versionNo, permissions: eff.requiredPermissions.filter((p) => p !== "network") }))}>
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
								disabled={busy}
								onChange={(e) => run(() => patch(`/skills/${s.id}/install`, { pinnedVersionNo: e.target.value === "latest" ? null : Number(e.target.value) }))}
								className="h-8 text-sm"
							>
								<option value="latest">跟随最新（v{full.latestVersionNo}）</option>
								{versions.map((v) => (
									<option key={v.versionNo} value={v.versionNo}>
										固定在 v{v.versionNo}
									</option>
								))}
							</Select>
							<Button size="sm" disabled={busy || inst.effectiveVersionNo === full.latestVersionNo} onClick={() => run(() => post(`/skills/${s.id}/install/upgrade`))}>
								<Upload />
								升级到 v{full.latestVersionNo}
							</Button>
							<Button size="sm" disabled={busy || inst.effectiveVersionNo <= 1} onClick={() => run(() => post(`/skills/${s.id}/install/rollback`))} data-testid="skill-rollback">
								<RotateCcw />
								回滚
							</Button>
						</div>
					) : null}
					{full.canManage ? <VersionSubmit skill={full} onChanged={() => (onChanged(), detail.reload())} /> : null}
					{versions.length ? (
						<div>
							<div className="mb-1 text-xs font-medium text-fg-muted">版本</div>
							<ul className="space-y-0.5 text-xs text-fg-muted">
								{versions.map((v) => (
									<li key={v.versionNo}>
										v{v.versionNo} · {fullTime(v.createdAt)} · {v.semver ? `${v.semver} · ` : ""}{v.source === "from_task" ? "从任务整理" : v.source === "package" ? "技能包" : "手动"}
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
							<ul className="space-y-0.5 text-xs text-fg-muted">
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
			) : null}
		</div>
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

/** Skill draft from a finished task: preview instructions/resources/permissions, edit, validate with the sample, publish. */
function DraftPanel({ id, onDone }: { id: string; onDone: () => void }) {
	const res = useApi<{ draft: SkillDraftDTO }>(`/skills/drafts/${id}`);
	const d = res.data?.draft;
	const [edit, setEdit] = useState<Partial<SkillDraftDTO>>({});
	const { busy, err, run } = useAct(() => res.reload());
	const v = { ...d, ...edit } as SkillDraftDTO;
	const dirty = Object.keys(edit).length > 0;
	return (
		<section data-testid="skill-draft" className="mb-6 rounded-xl border border-info/40 bg-info-soft/30 p-4">
			<Loadable state={res} what="技能草稿">
				{d ? (
					<div className="space-y-3 text-sm">
						<div className="flex flex-wrap items-center gap-2">
							<h2 className="text-[15px] font-semibold">从任务整理的技能草稿</h2>
							<Badge>{KIND[v.kind].label}</Badge>
							{d.source.conversationId && d.source.spaceId ? (
								<Link to={`/c/${d.source.spaceId}/${d.source.conversationId}`} className="text-xs text-info hover:underline">
									来源对话
								</Link>
							) : null}
							{d.publishedSkillId ? <Badge tone="success">已发布</Badge> : null}
						</div>
						<div className="grid gap-3 sm:grid-cols-2">
							<div>
								<Label htmlFor="dn">名称</Label>
								<Input id="dn" value={v.name} onChange={(e) => setEdit((x) => ({ ...x, name: e.target.value }))} />
							</div>
							<div>
								<Label htmlFor="dd">说明</Label>
								<Input id="dd" value={v.description} onChange={(e) => setEdit((x) => ({ ...x, description: e.target.value }))} />
							</div>
						</div>
						<div>
							<Label htmlFor="di">指令（SKILL.md）</Label>
							<Textarea id="di" rows={7} value={v.instructions} onChange={(e) => setEdit((x) => ({ ...x, instructions: e.target.value }))} className="font-mono text-xs" />
						</div>
						<div className="text-xs text-fg-muted">
							资源：{d.resources.length ? d.resources.map((r) => `${r.path}（${r.size} B）`).join("、") : "无"}
							{d.entry ? ` · 入口 ${d.entry}` : ""} · 所需工具：{d.requiredTools.join("、") || "无"} · 所需授权：{d.requiredPermissions.map(permText).join("、") || "无"}
						</div>
						<div className="grid gap-3 sm:grid-cols-2">
							<div>
								<Label htmlFor="dsi">样例输入</Label>
								<Input id="dsi" value={v.sample?.input ?? ""} onChange={(e) => setEdit((x) => ({ ...x, sample: { input: e.target.value, expectContains: v.sample?.expectContains } }))} />
							</div>
							<div>
								<Label htmlFor="dse">期望输出包含</Label>
								<Input id="dse" value={v.sample?.expectContains ?? ""} onChange={(e) => setEdit((x) => ({ ...x, sample: { input: v.sample?.input ?? "", expectContains: e.target.value } }))} />
							</div>
						</div>
						{d.validation && !dirty ? (
							<ul className="space-y-0.5 rounded-lg bg-surface px-3 py-2 text-xs" data-testid="draft-checks" data-ok={d.validation.ok}>
								{d.validation.checks.map((c) => (
									<li key={c.name} className="flex items-center gap-1.5">
										{c.ok ? <CheckCircle2 className="size-3.5 text-success" /> : <CircleX className="size-3.5 text-danger" />}
										{c.name}
										{c.detail ? <span className="text-fg-subtle">· {c.detail}</span> : null}
									</li>
								))}
							</ul>
						) : null}
						{err ? <p className="text-danger">{err}</p> : null}
						{!d.publishedSkillId ? (
							<div className="flex flex-wrap items-center gap-2">
								{dirty ? (
									<Button size="sm" disabled={busy} onClick={() => run(async () => (await patch(`/skills/drafts/${id}`, edit), setEdit({})))}>
										保存修改
									</Button>
								) : null}
								<Button size="sm" disabled={busy || dirty} onClick={() => run(() => post(`/skills/drafts/${id}/validate`))} data-testid="draft-validate">
									<RefreshCw />
									用样例验证
								</Button>
								<Button size="sm" variant="primary" disabled={busy || dirty || !d.validation?.ok} onClick={() => run(async () => (await post(`/skills/drafts/${id}/publish`, { scope: "personal" }), onDone()))} data-testid="draft-publish">
									发布并安装
								</Button>
								<span className="text-xs text-fg-subtle">{dirty ? "修改后需重新验证" : !d.validation ? "发布前需先通过样例验证" : d.validation.ok ? "验证通过，可以发布" : "验证未通过，不能发布"}</span>
							</div>
						) : null}
					</div>
				) : null}
			</Loadable>
		</section>
	);
}

