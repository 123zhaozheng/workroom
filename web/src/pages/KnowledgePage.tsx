// 个人知识库. Document state is shown exactly as the server reports it: 处理中 (排队/解析/索引) → 可检索 | 失败(+重试).
// "上传成功" is never presented as "知识可用".
import { AlertCircle, ArrowLeft, BookOpen, CheckCircle2, FolderPlus, Loader2, Plus, RotateCcw, Search, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { FileUploadResponse } from "@shared/files";
import type { KbDecisionDTO, KbDocDTO, KbEvalResult, KbProcessingStatus, KbSearchResponse, KbSummary, RetrievalFailure } from "@shared/knowledge";
import { del, errorText, post } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import { cn, formatBytes, relTime } from "@/lib/utils";
import { TopBar } from "@/components/shell/AppShell";
import { usePanel } from "@/components/shell/panel";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { Badge, EmptyState, Loadable, Page, PageHeader } from "@/components/ui/misc";
import { FilePickerDialog, listOf } from "@/features/chat/pickers";

export const AVAILABILITY: Record<KbDocDTO["availability"], { label: string; tone: "success" | "info" | "danger" }> = {
	ready: { label: "可检索", tone: "success" },
	processing: { label: "处理中", tone: "info" },
	failed: { label: "失败", tone: "danger" },
};
const PROC: Record<KbProcessingStatus, string> = { queued: "排队中", parsing: "解析中", indexing: "建立索引中", ready: "可检索", failed: "失败" };
const FAILURE: Record<RetrievalFailure, string> = { no_evidence: "没有找到相关证据", index_not_ready: "索引尚未就绪", forbidden: "没有权限", error: "检索出错" };

export default function KnowledgePage() {
	const { kbId } = useParams();
	return kbId ? <KbDetail kbId={kbId} /> : <KbList />;
}

function KbList() {
	const res = useApi<unknown>("/kb");
	const list = listOf<KbSummary>(res.data, "kbs", "knowledgeBases");
	const [create, setCreate] = useState(false);
	const navigate = useNavigate();
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page>
					<PageHeader
						title="个人知识库"
						description="把资料加入知识库后，系统会解析并建立索引；只有“可检索”的资料会被助手引用。"
						actions={
							<Button variant="primary" onClick={() => setCreate(true)} disabled={res.unavailable}>
								<Plus />
								新建知识库
							</Button>
						}
					/>
					<Loadable state={res} what="知识库" need="C 组：GET /api/kb">
						{list.length === 0 ? (
							<EmptyState icon={<BookOpen />} title="还没有知识库" action={<Button onClick={() => setCreate(true)}>新建知识库</Button>}>
								建一个知识库，把常用资料放进去，对话时用 / 引用。
							</EmptyState>
						) : (
							<div className="grid gap-3 sm:grid-cols-2">
								{list.map((k) => (
									<Link key={k.id} to={`/knowledge/${k.id}`} data-testid="kb-card" className="rounded-xl border border-border bg-surface p-4 transition-colors hover:border-border-strong">
										<div className="flex items-center gap-2">
											<BookOpen className="size-4 text-fg-muted" />
											<span className="truncate font-medium">{k.name}</span>
											<span className="flex-1" />
											<Badge>{k.scope === "personal" ? "个人" : k.scope === "project" ? "项目" : k.scope === "department" ? "部门" : "企业"}</Badge>
										</div>
										{k.description ? <p className="mt-1 line-clamp-2 text-[13px] text-fg-muted">{k.description}</p> : null}
										<div className="mt-3 flex flex-wrap gap-1.5">
											<Badge tone="success">{k.stats.ready} 可检索</Badge>
											{k.stats.processing ? <Badge tone="info">{k.stats.processing} 处理中</Badge> : null}
											{k.stats.failed ? <Badge tone="danger">{k.stats.failed} 失败</Badge> : null}
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
	const [err, setErr] = useState<string>();
	const [busy, setBusy] = useState(false);
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
							const r = await post<Record<string, unknown>>("/kb", { name, description: desc, scope: "personal" });
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
						<Label htmlFor="kbdesc">说明（可选）</Label>
						<Textarea id="kbdesc" value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} />
					</div>
					{err ? <p className="text-[13px] text-danger">{err}</p> : null}
					<div className="flex justify-end">
						<Button type="submit" variant="primary" disabled={busy || !name.trim()}>
							创建
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function KbDetail({ kbId }: { kbId: string }) {
	const { personalSpaceId } = useSession();
	const kbs = useApi<unknown>("/kb");
	const kb = listOf<KbSummary>(kbs.data, "kbs", "knowledgeBases").find((k) => k.id === kbId);
	const [poll, setPoll] = useState(true);
	const docs = useApi<unknown>(`/kb/${encodeURIComponent(kbId)}/docs`, { pollMs: poll ? 2000 : undefined });
	const list = listOf<KbDocDTO>(docs.data, "docs");
	const anyProcessing = list.some((d) => d.availability === "processing" || d.latest.status !== "ready" && d.latest.status !== "failed");

	const input = useRef<HTMLInputElement>(null);
	const [picker, setPicker] = useState(false);
	const [msg, setMsg] = useState<{ tone: "info" | "danger"; text: string }>();
	const [busy, setBusy] = useState(false);
	const { openPreview } = usePanel();
	useEffect(() => {
		if (!docs.data) return;
		setPoll(anyProcessing);
		// the "processing" notice must not outlive the processing it describes
		if (!anyProcessing) setMsg((m) => (m?.tone === "info" ? undefined : m));
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
			setMsg({ tone: "info", text: "文件已上传并加入，正在解析与索引——完成前不会被检索。" });
			setPoll(true);
			docs.reload();
		} catch (e) {
			setMsg({ tone: "danger", text: errorText(e) });
		} finally {
			setBusy(false);
			if (input.current) input.current.value = "";
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar>
				<Link to="/knowledge" className="inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-fg">
					<ArrowLeft className="size-4" />
					个人知识库
				</Link>
			</TopBar>
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page>
					<PageHeader
						title={kb?.name ?? "知识库"}
						description={kb?.description || "状态说明：处理中＝尚不可检索；可检索＝已建立索引，可被引用；失败＝可查看原因并重试。"}
						actions={
							canWrite ? (
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
							) : null
						}
					/>
					{msg ? <p className={cn("mb-3 rounded-lg px-3 py-2 text-[13px]", msg.tone === "danger" ? "bg-danger-soft text-danger" : "bg-info-soft text-info")}>{msg.text}</p> : null}
					<Loadable state={docs} what="知识库文档" need="C 组：GET /api/kb/:id/docs">
						{list.length === 0 ? (
							<EmptyState icon={<BookOpen />} title="这个知识库还没有资料">
								上传文件或从文件库加入。加入后会自动解析和建立索引。
							</EmptyState>
						) : (
							<div className="overflow-hidden rounded-xl border border-border bg-surface">
								{list.map((d, i) => (
									<DocRow
										key={d.id}
										d={d}
										first={i === 0}
										canWrite={canWrite}
										kbId={kbId}
										onChanged={() => {
											setPoll(true);
											docs.reload();
										}}
										onPreview={() => openPreview({ fileId: d.fileId, versionId: (d.serving ?? d.latest).versionId, name: d.fileName })}
									/>
								))}
							</div>
						)}
					</Loadable>
					<SearchDebug kbId={kbId} />
				</Page>
			</div>
			<FilePickerDialog
				open={picker}
				onOpenChange={setPicker}
				spaceId={personalSpaceId}
				projectId={kb?.projectId}
				onPick={async (r) => {
					try {
						await addVersion(r.fileId, r.versionId);
						setMsg({ tone: "info", text: `已加入「${r.name}」，正在解析与索引——完成前不会被检索。` });
						setPoll(true);
						docs.reload();
					} catch (e) {
						setMsg({ tone: "danger", text: errorText(e) });
					}
				}}
			/>
		</div>
	);
}

function DocRow({ d, first, canWrite, kbId, onChanged, onPreview }: { d: KbDocDTO; first: boolean; canWrite: boolean; kbId: string; onChanged: () => void; onPreview: () => void }) {
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
				{d.governance.kind !== "reference" ? <Badge>{d.governance.kind === "policy" ? "制度" : "模板"} · {d.governance.effectiveStatus}</Badge> : null}
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
					{d.latest.status !== "failed" ? "（完成前仍使用旧版本回答）" : ""}
				</p>
			) : null}
			{failedV ? (
				<div className="ml-7 mt-1.5 flex flex-wrap items-center gap-2 text-xs">
					<span className="text-danger">
						失败原因：{failedV.error ?? failedV.errorCode ?? "未知"}（已尝试 {failedV.attempts} 次）
					</span>
					{canWrite ? (
						<>
							{failedV.retryable === false ? <span className="text-fg-subtle">该错误重试多半仍会失败（例如文件本身损坏或格式不支持）</span> : null}
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
				<span className="text-xs text-fg-subtle">每行一个问题；“=&gt;”后写期望命中的文件名，留空表示期望“没有证据”。</span>
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
