// 个人知识库. Document state is shown exactly as the server reports it: 处理中 (排队/解析/索引) → 可检索 | 失败(+重试).
// "上传成功" is never presented as "知识可用".
import { AlertCircle, ArrowLeft, BookOpen, CheckCircle2, FolderPlus, Loader2, Plus, RotateCcw, Search, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { FileUploadResponse } from "@shared/files";
import type { KbDecisionDTO, KbDocDTO, KbDocKind, KbEvalResult, KbGovStatus, KbProcessingStatus, KbScope, KbSearchResponse, KbSummary, RetrievalFailure, UpdateGovernanceRequest } from "@shared/knowledge";
import type { DepartmentDTO, MemberDTO } from "@shared/ops";
import type { Project } from "@/lib/types";
import { del, errorText, patch, post } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useViewerPerms } from "@/features/admin/rbac-ui";
import { useApi } from "@/lib/useApi";
import { cn, formatBytes, relTime } from "@/lib/utils";
import { TopBar, useShell } from "@/components/shell/AppShell";
import { usePanel, type PreviewTarget } from "@/components/shell/panel";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { Badge, EmptyState, Loadable, Page, PageHeader } from "@/components/ui/misc";
import { FilePickerDialog, listOf } from "@/features/chat/pickers";
import { SplitLayout } from "@/features/files/SplitLayout";
import { PreviewDialog } from "@/features/files/PreviewDialog";
import { KbListColumn, KbStats, SCOPE_LABEL } from "@/features/knowledge/KbRows";
import { Notice } from "@/features/work/states";

export const AVAILABILITY: Record<KbDocDTO["availability"], { label: string; tone: "success" | "info" | "danger" }> = {
	ready: { label: "可检索", tone: "success" },
	processing: { label: "处理中", tone: "info" },
	failed: { label: "失败", tone: "danger" },
};
const PROC: Record<KbProcessingStatus, string> = { queued: "排队中", parsing: "解析中", indexing: "建立索引中", ready: "可检索", failed: "失败" };
const FAILURE: Record<RetrievalFailure, string> = { no_evidence: "没有找到相关证据", index_not_ready: "索引尚未就绪", forbidden: "没有权限", error: "检索出错" };

/**
 * 知识库. Wide screens: app sidebar · knowledge base list · the selected base's documents (`/knowledge/:kbId` is the same screen with
 * that base open). Phones and tablets: a list page, then a page per base.
 */
export default function KnowledgePage() {
	const { kbId } = useParams();
	const { wide } = useShell();
	return wide ? <KnowledgeWorkspace kbId={kbId} /> : kbId ? <KbDetail kbId={kbId} /> : <KbList />;
}

function useKbList(pollMs?: number) {
	const res = useApi<unknown>("/kb", { pollMs });
	return { res, list: listOf<KbSummary>(res.data, "kbs", "knowledgeBases") };
}

function KnowledgeWorkspace({ kbId }: { kbId?: string }) {
	// the counts next to each base follow what happens in the open one (uploads, indexing finishing)
	const { res, list } = useKbList(6000);
	const [create, setCreate] = useState(false);
	const [q, setQ] = useState("");
	const navigate = useNavigate();
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<SplitLayout
				label="知识库列表"
				list={
					<KbListColumn list={list} selectedId={kbId} q={q} onQ={setQ} onCreate={() => setCreate(true)} createDisabled={res.unavailable}>
						{res.unavailable || res.error || res.loading ? (
							<Loadable state={res} what="知识库" need="C 组：GET /api/kb">
								{null}
							</Loadable>
						) : undefined}
					</KbListColumn>
				}
				detail={kbId ? <KbDetail key={kbId} kbId={kbId} embedded /> : list.length ? <Notice icon={<BookOpen />} title="选择一个知识库查看资料" testid="kb-no-selection" /> : null}
			/>
			<CreateKbDialog
				open={create}
				onOpenChange={setCreate}
				onCreated={(k) => {
					res.reload(); // the new base is in the list when its panel opens
					navigate(`/knowledge/${k.id}`);
				}}
			/>
		</div>
	);
}

function KbList() {
	const { res, list } = useKbList();
	const [create, setCreate] = useState(false);
	const navigate = useNavigate();
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page>
					<PageHeader
						title="个人知识库"
						actions={
							<Button variant="primary" onClick={() => setCreate(true)} disabled={res.unavailable}>
								<Plus />
								新建知识库
							</Button>
						}
					/>
					<Loadable state={res} what="知识库" need="C 组：GET /api/kb">
						{list.length === 0 ? (
							<div data-testid="kb-empty">
								<EmptyState
									icon={<BookOpen />}
									title="还没有知识库"
									action={
										<Button variant="primary" onClick={() => setCreate(true)}>
											<Plus />
											新建知识库
										</Button>
									}
								/>
							</div>
						) : (
							<div className="grid gap-3 sm:grid-cols-2">
								{list.map((k) => (
									<Link key={k.id} to={`/knowledge/${k.id}`} data-testid="kb-card" className="rounded-xl border border-border bg-surface p-4 transition-colors hover:border-border-strong">
										<div className="flex items-center gap-2">
											<BookOpen className="size-4 text-fg-muted" />
											<span className="truncate font-medium">{k.name}</span>
											<span className="flex-1" />
											<Badge>{SCOPE_LABEL[k.scope]}</Badge>
										</div>
										{k.description ? <p className="mt-1 line-clamp-2 text-[13px] text-fg-muted">{k.description}</p> : null}
										<div className="mt-3">
											<KbStats k={k} />
										</div>
									</Link>
								))}
							</div>
						)}
					</Loadable>
				</Page>
			</div>
			<CreateKbDialog open={create} onOpenChange={setCreate} onCreated={(k) => navigate(`/knowledge/${k.id}`)} />
		</div>
	);
}

function CreateKbDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (k: KbSummary) => void }) {
	const [name, setName] = useState("");
	const [desc, setDesc] = useState("");
	const [scope, setScope] = useState<KbScope>("personal");
	const [projectId, setProjectId] = useState("");
	const [departmentId, setDepartmentId] = useState("");
	const [err, setErr] = useState<string>();
	const [busy, setBusy] = useState(false);
	const projects = useApi<{ projects: Project[] }>(open ? "/projects?kind=space" : null);
	const depts = useApi<{ departments: DepartmentDTO[] }>(open ? "/departments" : null);
	// Hide scopes the viewer cannot create (the server enforces anyway): org-scope vs anywhere (department-scoped roles count for 部门).
	const perms = useViewerPerms();
	const canPersonal = perms.org.has("kb.create.personal");
	const canDept = perms.anywhere.has("kb.create.department");
	const canOrg = perms.org.has("kb.create.org");
	// Older servers without RBAC fields: keep everything visible.
	const known = perms.org.size > 0 || perms.anywhere.size > 0;
	const show = { personal: !known || canPersonal, department: !known || canDept, org: !known || canOrg };
	useEffect(() => {
		if (scope === "personal" && !show.personal) setScope("project");
		else if (scope === "department" && !show.department) setScope(show.personal ? "personal" : "project");
		else if (scope === "org" && !show.org) setScope(show.personal ? "personal" : "project");
	}, [scope, show.personal, show.department, show.org]);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title="新建知识库">
				<form
					className="space-y-3"
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						setErr(undefined);
						try {
							const r = await post<Record<string, unknown>>("/kb", { name, description: desc, scope, ...(scope === "project" ? { projectId } : {}), ...(scope === "department" ? { departmentId } : {}) });
							const kb = ((r.kb ?? r.knowledgeBase ?? r) as KbSummary)!;
							onOpenChange(false);
							setName("");
							setDesc("");
							onCreated(kb);
						} catch (e) {
							setErr(errorText(e));
						} finally {
							setBusy(false);
						}
					}}
				>
					<div>
						<Label htmlFor="kbname">名称</Label>
						<Input id="kbname" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
					</div>
					<div>
						<Label htmlFor="kbscope">可见范围</Label>
						<Select id="kbscope" value={scope} onChange={(e) => setScope(e.target.value as KbScope)} className="w-full" data-testid="kb-scope">
							{show.personal ? <option value="personal">个人（只有自己）</option> : null}
							<option value="project">项目成员</option>
							{show.department ? <option value="department">部门成员</option> : null}
							{show.org ? <option value="org">整个企业（需「创建企业知识库」权限）</option> : null}
						</Select>
						{scope === "project" ? (
							<Select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="mt-2 w-full" aria-label="项目" data-testid="kb-scope-project">
								<option value="">选择项目</option>
								{(projects.data?.projects ?? []).filter((x) => x.role !== "viewer").map((x) => (
									<option key={x.id} value={x.id}>
										{x.name}
									</option>
								))}
							</Select>
						) : scope === "department" ? (
							<Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className="mt-2 w-full" aria-label="部门" data-testid="kb-scope-department">
								<option value="">选择部门</option>
								{(depts.data?.departments ?? []).map((d) => (
									<option key={d.id} value={d.id}>
										{d.name}
									</option>
								))}
							</Select>
						) : null}
					</div>
					<div>
						<Label htmlFor="kbdesc">说明（可选）</Label>
						<Textarea id="kbdesc" value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} />
					</div>
					{err ? <p className="text-[13px] text-danger">{err}</p> : null}
					<div className="flex justify-end">
						<Button type="submit" variant="primary" disabled={busy || !name.trim() || (scope === "project" && !projectId) || (scope === "department" && !departmentId)}>
							创建
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function KbDetail({ kbId, embedded }: { kbId: string; embedded?: boolean }) {
	const { personalSpaceId } = useSession();
	const kbs = useApi<unknown>("/kb");
	const kb = listOf<KbSummary>(kbs.data, "kbs", "knowledgeBases").find((k) => k.id === kbId);
	const [poll, setPoll] = useState(true);
	const docs = useApi<unknown>(`/kb/${encodeURIComponent(kbId)}/docs`, { pollMs: poll ? 2000 : undefined });
	const list = listOf<KbDocDTO>(docs.data, "docs");
	const anyProcessing = list.some((d) => d.availability === "processing" || d.latest.status !== "ready" && d.latest.status !== "failed");

	const input = useRef<HTMLInputElement>(null);
	const [picker, setPicker] = useState(false);
	const [msg, setMsg] = useState<{ tone: "danger"; text: string }>();
	const [busy, setBusy] = useState(false);
	const { openPreview } = usePanel();
	// wide screens already have a list and a detail column: documents preview in a dialog instead of squeezing a third column in
	const [dialogTarget, setDialogTarget] = useState<PreviewTarget | null>(null);
	const previewDoc = (t: PreviewTarget) => (embedded ? setDialogTarget(t) : openPreview(t));
	useEffect(() => {
		if (!docs.data) return;
		setPoll(anyProcessing);
	}, [docs.data, anyProcessing]);
	const canWrite = kb?.permissions.write ?? true;

	const addVersion = async (fileId: string, versionId: string) => {
		await post(`/kb/${encodeURIComponent(kbId)}/docs`, { fileId, versionId });
	};
	const upload = async (files: FileList | null) => {
		if (!files?.length) return;
		setBusy(true);
		setMsg(undefined);
		try {
			for (const f of Array.from(files)) {
				const fd = new FormData();
				fd.set("file", f);
				if (kb?.projectId) fd.set("projectId", kb.projectId);
				else if (personalSpaceId) fd.set("spaceId", personalSpaceId);
				const r = await post<FileUploadResponse>("/files", fd);
				await addVersion(r.file.id, r.version.versionId);
			}
			setPoll(true);
			docs.reload();
		} catch (e) {
			setMsg({ tone: "danger", text: errorText(e) });
		} finally {
			setBusy(false);
			if (input.current) input.current.value = "";
		}
	};

	const header = (
		<PageHeader
			title={kb?.name ?? "知识库"}
			description={kb?.description || undefined}
			actions={
				<>
					{canWrite ? (
						<>
							<input ref={input} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} data-testid="kb-upload-input" />
							<Button onClick={() => setPicker(true)}>
								<FolderPlus />
								从文件库加入
							</Button>
							<Button variant="primary" onClick={() => input.current?.click()} disabled={busy}>
								<Upload />
								{busy ? "上传中…" : "上传资料"}
							</Button>
						</>
					) : null}
				</>
			}
		/>
	);
	const content = (
		<>
			{header}
			{msg ? <p className="mb-3 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">{msg.text}</p> : null}
			<Loadable state={docs} what="知识库文档" need="C 组：GET /api/kb/:id/docs">
				{list.length === 0 ? (
					<div data-testid="kb-docs-empty" className="rounded-xl border border-border bg-surface">
						<EmptyState
							icon={<BookOpen />}
							title="这个知识库还没有资料"
							action={
								canWrite ? (
									<Button variant="primary" onClick={() => input.current?.click()} disabled={busy}>
										<Upload />
										上传资料
									</Button>
								) : undefined
							}
						/>
					</div>
				) : (
					<div className="overflow-hidden rounded-xl border border-border bg-surface">
						{list.map((d, i) => (
							<DocRow
								key={d.id}
								d={d}
								first={i === 0}
								siblings={list}
								canWrite={canWrite}
								kbId={kbId}
								onChanged={() => {
									setPoll(true);
									docs.reload();
								}}
								onPreview={() => previewDoc({ fileId: d.fileId, versionId: (d.serving ?? d.latest).versionId, name: d.fileName })}
							/>
						))}
					</div>
				)}
			</Loadable>
			<SearchDebug kbId={kbId} />
		</>
	);
	const dialogs = (
		<>
			<FilePickerDialog
				open={picker}
				onOpenChange={setPicker}
				spaceId={personalSpaceId}
				projectId={kb?.projectId}
				onPick={async (r) => {
					try {
						await addVersion(r.fileId, r.versionId);
						setPoll(true);
						docs.reload();
					} catch (e) {
						setMsg({ tone: "danger", text: errorText(e) });
					}
				}}
			/>
			<PreviewDialog target={dialogTarget} onClose={() => setDialogTarget(null)} />
		</>
	);

	if (embedded)
		return (
			<div data-testid="kb-detail" className="px-5 pb-12 pt-5 lg:px-6">
				{content}
				{dialogs}
			</div>
		);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar>
				<Link to="/knowledge" className="inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-fg">
					<ArrowLeft className="size-4" />
					个人知识库
				</Link>
			</TopBar>
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page>{content}</Page>
			</div>
			{dialogs}
		</div>
	);
}

function DocRow({ d, first, canWrite, kbId, onChanged, onPreview, siblings }: { d: KbDocDTO; first: boolean; canWrite: boolean; kbId: string; onChanged: () => void; onPreview: () => void; siblings: KbDocDTO[] }) {
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	const a = AVAILABILITY[d.availability];
	const latestDiffers = d.serving && d.latest.docVersionId !== d.serving.docVersionId;
	const failedV = d.latest.status === "failed" ? d.latest : null;
	return (
		<div data-testid="kb-doc" data-availability={d.availability} data-status={d.latest.status} className={cn("px-3 py-3", !first && "border-t border-border")}>
			<div className="flex items-center gap-3">
				{d.availability === "ready" ? <CheckCircle2 className="size-4 shrink-0 text-success" /> : d.availability === "failed" ? <AlertCircle className="size-4 shrink-0 text-danger" /> : <Loader2 className="size-4 shrink-0 wr-spin text-info" />}
				<button onClick={onPreview} className="min-w-0 flex-1 text-left">
					<span className="block truncate text-sm font-medium">{d.fileName}</span>
					<span className="block truncate text-xs text-fg-subtle">
						{d.serving ? `检索使用 v${d.serving.versionNo} · ${d.serving.chunkCount} 个片段${d.serving.pageCount ? ` · ${d.serving.pageCount} 页` : ""}` : "尚无可检索版本"} · {formatBytes(d.latest.size)} · {relTime(d.updatedAt)}
					</span>
				</button>
				<Badge tone={a.tone}>{d.availability === "processing" ? PROC[d.latest.status] : a.label}</Badge>
				{d.governance.kind !== "reference" ? <Badge tone={GOV[d.governance.effectiveStatus].tone} data-testid="gov-badge">{KIND_LABEL[d.governance.kind]} · {GOV[d.governance.effectiveStatus].label}</Badge> : null}
				{canWrite ? (
					<button
						aria-label={`移除 ${d.fileName}`}
						disabled={busy}
						onClick={async () => {
							if (!confirm(`从知识库移除「${d.fileName}」？文件本身仍保留在文件库。`)) return;
							setBusy(true);
							try {
								await del(`/kb/${encodeURIComponent(kbId)}/docs/${encodeURIComponent(d.id)}`);
								onChanged();
							} catch (e) {
								setErr(errorText(e));
							} finally {
								setBusy(false);
							}
						}}
						className="rounded-md p-1.5 text-fg-subtle hover:bg-surface-2 hover:text-danger"
					>
						<Trash2 className="size-4" />
					</button>
				) : null}
			</div>
			{latestDiffers ? (
				<p className="ml-7 mt-1 text-xs text-fg-muted">
					新版本 v{d.latest.versionNo}：{PROC[d.latest.status]}
				</p>
			) : null}
			{failedV ? (
				<div className="ml-7 mt-1.5 flex flex-wrap items-center gap-2 text-xs">
					<span className="text-danger">
						失败原因：{failedV.error ?? failedV.errorCode ?? "未知"}（已尝试 {failedV.attempts} 次）
					</span>
					{canWrite ? (
						<>
							{failedV.retryable === false ? <span className="text-fg-subtle">重试多半仍会失败</span> : null}
							<Button
								size="sm"
								data-testid="kb-retry"
								disabled={busy}
								onClick={async () => {
									setBusy(true);
									setErr(undefined);
									try {
										await post(`/kb/${encodeURIComponent(kbId)}/docs/${encodeURIComponent(d.id)}/retry`);
										onChanged();
									} catch (e) {
										setErr(errorText(e));
									} finally {
										setBusy(false);
									}
								}}
							>
								<RotateCcw />
								{failedV.retryable === false ? "仍要重试" : "重试"}
							</Button>
						</>
					) : null}
				</div>
			) : null}
			{err ? <p className="ml-7 mt-1 text-xs text-danger">{err}</p> : null}
			<Governance d={d} kbId={kbId} canWrite={canWrite} siblings={siblings} onChanged={onChanged} />
		</div>
	);
}

const KIND_LABEL: Record<KbDocKind, string> = { reference: "参考资料", policy: "制度", template: "模板" };
const GOV: Record<KbDocDTO["governance"]["effectiveStatus"], { label: string; tone: "success" | "neutral" | "warning" | "danger" | "info" }> = {
	draft: { label: "草稿", tone: "neutral" },
	effective: { label: "生效中", tone: "success" },
	expired: { label: "已过期", tone: "warning" },
	withdrawn: { label: "已下架", tone: "danger" },
	pending: { label: "待生效", tone: "info" },
};
const day = (iso?: string) => (iso ? iso.slice(0, 10) : "");

/** 制度与模板治理 (M07-B): 责任人、版本、生效状态、生效/到期时间；下架、替换。Reference docs only show a compact line. */
function Governance({ d, kbId, canWrite, siblings, onChanged }: { d: KbDocDTO; kbId: string; canWrite: boolean; siblings: KbDocDTO[]; onChanged: () => void }) {
	const g = d.governance;
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	const members = useApi<{ members: MemberDTO[] }>(open ? "/admin/members" : null);
	const [form, setForm] = useState<UpdateGovernanceRequest>({});
	const apply = async (req: UpdateGovernanceRequest) => {
		setBusy(true);
		setErr(undefined);
		try {
			await patch(`/kb/${encodeURIComponent(kbId)}/docs/${encodeURIComponent(d.id)}/governance`, req as Record<string, unknown>);
			setOpen(false);
			setForm({});
			onChanged();
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	const replacedBy = g.replacedByDocId ? siblings.find((x) => x.id === g.replacedByDocId) : undefined;
	return (
		<div className="ml-7 mt-1 text-xs text-fg-muted" data-testid="governance">
			<span>
				{KIND_LABEL[g.kind]}
				{g.kind !== "reference" ? ` · ${GOV[g.effectiveStatus].label}` : ""}
				{g.responsibleName || g.responsibleUserId ? ` · 责任人 ${g.responsibleName ?? g.responsibleUserId}` : ""}
				{g.versionLabel ? ` · 版本 ${g.versionLabel}` : ""}
				{g.effectiveFrom ? ` · ${day(g.effectiveFrom)} 起生效` : ""}
				{g.expiresAt ? ` · ${day(g.expiresAt)} 到期` : ""}
				{replacedBy ? ` · 已由「${replacedBy.fileName}」替换` : ""}
				{!g.retrievable ? " · 默认不参与检索" : ""} · 更新于 {relTime(g.updatedAt)}
			</span>
			{canWrite ? (
				<span className="ml-2 inline-flex gap-2">
					<button className="text-info hover:underline" onClick={() => setOpen((o) => !o)} data-testid="gov-edit">
						治理设置
					</button>
					{g.status !== "withdrawn" ? (
						<button className="text-danger hover:underline" disabled={busy} onClick={() => apply({ status: "withdrawn" })} data-testid="gov-withdraw">
							下架
						</button>
					) : (
						<button className="text-info hover:underline" disabled={busy} onClick={() => apply({ status: "effective" })}>
							恢复生效
						</button>
					)}
				</span>
			) : null}
			{open ? (
				<div className="mt-2 grid gap-2 rounded-lg border border-border bg-surface p-3 sm:grid-cols-2" data-testid="gov-form">
					<label className="flex flex-col gap-1">
						类型
						<Select aria-label="类型" value={form.kind ?? g.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as KbDocKind }))} className="h-8 text-xs">
							<option value="reference">参考资料</option>
							<option value="policy">制度</option>
							<option value="template">模板</option>
						</Select>
					</label>
					<label className="flex flex-col gap-1">
						状态
						<Select aria-label="状态" value={form.status ?? g.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as KbGovStatus }))} className="h-8 text-xs">
							<option value="draft">草稿</option>
							<option value="effective">生效</option>
							<option value="expired">过期</option>
							<option value="withdrawn">下架</option>
						</Select>
					</label>
					<label className="flex flex-col gap-1">
						责任人
						<Select aria-label="责任人" value={form.responsibleUserId ?? g.responsibleUserId ?? ""} onChange={(e) => setForm((f) => ({ ...f, responsibleUserId: e.target.value || null }))} className="h-8 text-xs" data-testid="gov-owner">
							<option value="">未指定</option>
							{(members.data?.members ?? []).map((m) => (
								<option key={m.userId} value={m.userId}>
									{m.name}
								</option>
							))}
						</Select>
					</label>
					<label className="flex flex-col gap-1">
						版本标识
						<Input value={form.versionLabel ?? g.versionLabel ?? ""} onChange={(e) => setForm((f) => ({ ...f, versionLabel: e.target.value || null }))} className="h-8 text-xs" placeholder="例如 2026 版" data-testid="gov-version" />
					</label>
					<label className="flex flex-col gap-1">
						生效日期
						<Input type="date" value={day(form.effectiveFrom ?? g.effectiveFrom ?? undefined)} onChange={(e) => setForm((f) => ({ ...f, effectiveFrom: e.target.value ? new Date(`${e.target.value}T00:00:00Z`).toISOString() : null }))} className="h-8 text-xs" />
					</label>
					<label className="flex flex-col gap-1">
						到期日期
						<Input type="date" value={day(form.expiresAt ?? g.expiresAt ?? undefined)} onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value ? new Date(`${e.target.value}T00:00:00Z`).toISOString() : null }))} className="h-8 text-xs" data-testid="gov-expires" />
					</label>
					<label className="flex flex-col gap-1 sm:col-span-2">
						由以下文档替换（替换后本文档下架）
						<Select aria-label="替换文档" value={form.replacedByDocId ?? g.replacedByDocId ?? ""} onChange={(e) => setForm((f) => ({ ...f, replacedByDocId: e.target.value || null, ...(e.target.value ? { status: "withdrawn" as const } : {}) }))} className="h-8 text-xs" data-testid="gov-replace">
							<option value="">不替换</option>
							{siblings.filter((x) => x.id !== d.id).map((x) => (
								<option key={x.id} value={x.id}>
									{x.fileName}
								</option>
							))}
						</Select>
					</label>
					{err ? <p className="text-danger sm:col-span-2">{err}</p> : null}
					<div className="flex justify-end gap-2 sm:col-span-2">
						<Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
							取消
						</Button>
						<Button size="sm" variant="primary" disabled={busy || !Object.keys(form).length} onClick={() => apply(form)} data-testid="gov-save">
							保存
						</Button>
					</div>
				</div>
			) : err ? (
				<p className="mt-1 text-danger">{err}</p>
			) : null}
		</div>
	);
}

/** Retrieval debugging: hits with locators + diagnostics; no-evidence / not-ready / forbidden / error are distinct. */
function SearchDebug({ kbId }: { kbId: string }) {
	const [q, setQ] = useState("");
	const [res, setRes] = useState<KbSearchResponse>();
	const [err, setErr] = useState<string>();
	const [busy, setBusy] = useState(false);
	return (
		<section className="mt-10">
			<h2 className="mb-2 text-[13px] font-medium text-fg-muted">检索测试</h2>
			<form
				className="flex gap-2"
				onSubmit={async (e) => {
					e.preventDefault();
					if (!q.trim()) return;
					setBusy(true);
					setErr(undefined);
					try {
						setRes(await post<KbSearchResponse>("/kb/search", { query: q, kbIds: [kbId], limit: 8, debug: true }));
					} catch (e) {
						setErr(errorText(e));
					} finally {
						setBusy(false);
					}
				}}
			>
				<Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="输入一个问题，看看会命中哪些资料" />
				<Button type="submit" disabled={busy}>
					<Search />
					检索
				</Button>
			</form>
			{err ? <p className="mt-2 text-[13px] text-danger">{err}</p> : null}
			{res ? (
				<div className="mt-3 space-y-2" data-testid="kb-search-result">
					<p className="text-xs text-fg-subtle">
						{res.diagnostics.reason ? <span className="text-warning">{FAILURE[res.diagnostics.reason]}</span> : `命中 ${res.citations.length} 条`}
						{res.diagnostics.detail ? ` · ${res.diagnostics.detail}` : ""}
						{res.diagnostics.pendingDocs ? ` · ${res.diagnostics.pendingDocs} 份资料尚未就绪` : ""}
						{res.diagnostics.tookMs !== undefined ? ` · ${res.diagnostics.tookMs} ms` : ""}
					</p>
					{res.debug?.kbDecisions?.length ? <Decisions items={res.debug.kbDecisions} /> : null}
					{res.citations.map((c) => (
						<div key={c.chunkId} className="rounded-lg border border-border px-3 py-2 text-[13px]">
							<div className="text-fg">
								{c.fileName} <span className="text-fg-subtle">· v{c.versionNo} · {c.locator}</span>
							</div>
							<p className="mt-0.5 text-fg-muted">{c.snippet}</p>
						</div>
					))}
				</div>
			) : null}
			<EvalBox kbId={kbId} />
		</section>
	);
}

const REASON: Record<KbDecisionDTO["reason"], string> = {
	searched: "已检索",
	not_requested: "未被引用（本次只查指定知识库）",
	outside_project_context: "不在当前项目范围",
	outside_member_scope: "超出该成员的知识范围",
	forbidden: "无权访问",
};

/** Why each knowledge base was searched or excluded (scope, access basis, index readiness, governance). */
function Decisions({ items }: { items: KbDecisionDTO[] }) {
	return (
		<details className="rounded-lg border border-border bg-surface px-3 py-2 text-xs" data-testid="kb-decisions" open>
			<summary className="cursor-pointer text-fg-muted">检索范围说明（{items.length} 个知识库）</summary>
			<ul className="mt-2 space-y-1.5">
				{items.map((d) => (
					<li key={d.kbId}>
						<span className={d.included ? "text-success" : "text-fg-subtle"}>{d.included ? "✓" : "—"}</span> <span className="font-medium">{d.kbName ?? d.kbId}</span> · {REASON[d.reason]}
						{d.access ? ` · 依据 ${d.access}` : ""}
						{d.index ? ` · 可检索 ${d.index.ready} / 处理中 ${d.index.processing} / 失败 ${d.index.failed}` : ""}
						{d.hits !== undefined ? ` · 命中 ${d.hits}` : ""}
						{d.notes.length ? <span className="block text-fg-subtle">{d.notes.join("；")}</span> : null}
					</li>
				))}
			</ul>
		</details>
	);
}

/** Evaluation samples: one per line, "问题 => 期望命中的文件名" (empty expectation = expect no evidence). */
function EvalBox({ kbId }: { kbId: string }) {
	const [text, setText] = useState("");
	const [res, setRes] = useState<KbEvalResult>();
	const [err, setErr] = useState<string>();
	const [busy, setBusy] = useState(false);
	const run = async () => {
		const samples = text
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.map((l, i) => {
				const [query, file] = l.split("=>").map((x) => x.trim());
				return { id: `s${i + 1}`, query: query!, expect: file ? { fileName: file } : { reason: "no_evidence" as const } };
			});
		if (!samples.length) return;
		setBusy(true);
		setErr(undefined);
		try {
			setRes(await post<KbEvalResult>("/kb/eval", { samples, kbIds: [kbId] }));
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<details className="mt-4 text-[13px]">
			<summary className="cursor-pointer text-fg-muted">问答评估样例</summary>
			<Textarea data-testid="kb-eval-input" value={text} onChange={(e) => setText(e.target.value)} rows={3} className="mt-2 font-mono text-[12.5px]" placeholder={"报销时限 => 报销制度.md\n火星基地预算 =>"} />
			<div className="mt-2 flex items-center gap-2">
				<Button size="sm" onClick={run} disabled={busy} data-testid="kb-eval-run">
					运行评估
				</Button>
			</div>
			{err ? <p className="mt-1 text-danger">{err}</p> : null}
			{res ? (
				<div className="mt-2 rounded-lg border border-border px-3 py-2 text-xs" data-testid="kb-eval-result">
					<div className="mb-1 font-medium">
						通过 {res.passed}/{res.total} · Recall@5 {res.recallAt5.toFixed(2)} · MRR {res.mrr.toFixed(2)}
					</div>
					<ul className="space-y-0.5">
						{res.samples.map((x) => (
							<li key={x.id} className={x.pass ? "text-success" : "text-danger"}>
								{x.pass ? "通过" : "未通过"} · {x.id}
								{x.rank ? ` · 排名 ${x.rank}` : ""}
								{x.reason ? ` · ${FAILURE[x.reason]}` : ""}
								{x.top ? <span className="text-fg-muted"> · 首条：{x.top}</span> : null}
							</li>
						))}
					</ul>
				</div>
			) : null}
		</details>
	);
}
