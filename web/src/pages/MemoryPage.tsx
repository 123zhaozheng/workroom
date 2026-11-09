import { Brain, History, Pencil, Plus, Trash2, Wand2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { MemoryCorrectionResult, MemoryDTO, MemoryKind, MemoryRevisionDTO, MemoryScope } from "@shared/knowledge";
import { del, errorText, patch, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { fullTime, relTime } from "@/lib/utils";
import { TopBar } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Badge, EmptyState, Loadable, Page, PageHeader } from "@/components/ui/misc";
import { listOf } from "@/features/chat/pickers";

const SCOPE: Record<MemoryScope, string> = { private: "仅自己", project: "项目共享", org: "企业" };
const KIND: Record<MemoryKind, string> = { preference: "偏好", fact: "事实", constraint: "约束", background: "背景" };
const SOURCE = { user: "手动添加", extracted: "从对话提取", corrected: "纠正后" } as const;

export default function MemoryPage() {
	const res = useApi<unknown>("/memory");
	const list = listOf<MemoryDTO>(res.data, "memories", "memory").filter((m) => m.status === "active");
	const [draft, setDraft] = useState("");
	const [kind, setKind] = useState<MemoryKind>("preference");
	const [err, setErr] = useState<string>();
	const [lastCorrection, setLastCorrection] = useState<MemoryCorrectionResult>();
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page>
					<PageHeader title="记忆" description="助手会在对话中参考这些信息。每条都标明来源和作用范围，可随时修改或删除。" />
					{!res.unavailable ? (
						<form
							className="mb-6 rounded-xl border border-border bg-surface p-3"
							onSubmit={async (e) => {
								e.preventDefault();
								setErr(undefined);
								try {
									await post("/memory", { content: draft, scope: "private", kind });
									setDraft("");
									res.reload();
								} catch (e) {
									setErr(errorText(e));
								}
							}}
						>
							<Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} placeholder="例如：周报用简体中文，结论放在最前面" className="border-0 px-1 focus:border-0" />
							<div className="mt-2 flex items-center gap-2">
								<Select value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)} className="h-8 text-[13px]">
									{Object.entries(KIND).map(([k, l]) => (
										<option key={k} value={k}>
											{l}
										</option>
									))}
								</Select>
								<span className="text-xs text-fg-subtle">范围：仅自己</span>
								<span className="flex-1" />
								<Button type="submit" size="sm" variant="primary" disabled={!draft.trim()}>
									<Plus />
									添加
								</Button>
							</div>
							{err ? <p className="mt-1 text-[13px] text-danger">{err}</p> : null}
						</form>
					) : null}
					{lastCorrection ? <CorrectionResult r={lastCorrection} /> : null}
					<Loadable state={res} what="记忆" need="C 组：GET /api/memory">
						{list.length === 0 ? (
							<EmptyState icon={<Brain />} title="还没有记忆" />
						) : (
							<ul className="space-y-2">
								{list.map((m) => (
									<MemoryItem key={m.id} m={m} onChanged={res.reload} onCorrected={setLastCorrection} />
								))}
							</ul>
						)}
					</Loadable>
				</Page>
			</div>
		</div>
	);
}

const CHANGE: Record<MemoryRevisionDTO["change"], string> = { create: "创建", edit: "修改", correct: "纠正", supersede: "被替代", delete: "删除" };

function MemoryItem({ m, onChanged, onCorrected }: { m: MemoryDTO; onChanged: () => void; onCorrected: (r: MemoryCorrectionResult) => void }) {
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState(m.content);
	const [err, setErr] = useState<string>();
	const [correcting, setCorrecting] = useState(false);
	const [fix, setFix] = useState(m.content);
	const [note, setNote] = useState("");
	const [showHistory, setShowHistory] = useState(false);
	const history = useApi<{ revisions?: MemoryRevisionDTO[]; history?: MemoryRevisionDTO[] } | MemoryRevisionDTO[]>(showHistory ? `/memory/${m.id}/history` : null);
	const revs = listOf<MemoryRevisionDTO>(history.data, "revisions", "history");
	return (
		<li data-testid="memory-item" className="rounded-xl border border-border bg-surface p-3">
			{editing ? (
				<>
					<Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} />
					<div className="mt-2 flex justify-end gap-2">
						<Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
							取消
						</Button>
						<Button
							size="sm"
							variant="primary"
							onClick={async () => {
								try {
									await patch(`/memory/${m.id}`, { content: text });
									setEditing(false);
									onChanged();
								} catch (e) {
									setErr(errorText(e));
								}
							}}
						>
							保存
						</Button>
					</div>
				</>
			) : (
				<p className="whitespace-pre-wrap text-sm">{m.content}</p>
			)}
			<div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-fg-subtle">
				<Badge>{KIND[m.kind]}</Badge>
				<Badge>{SCOPE[m.scope]}</Badge>
				<span>
					{SOURCE[m.source]}
					{m.sourceRef ? (
						<>
							{" · "}
							<Link className="text-info hover:underline" to={`/c/${m.sourceRef.spaceId}/${m.sourceRef.conversationId}`}>
								来源对话
							</Link>
						</>
					) : null}
					{" · "}v{m.version} · {relTime(m.updatedAt)}
				</span>
				<span className="flex-1" />
				{m.permissions.edit && !editing ? (
					<button aria-label="编辑" onClick={() => setEditing(true)} className="rounded p-1 hover:bg-surface-2 hover:text-fg">
						<Pencil className="size-3.5" />
					</button>
				) : null}
				{m.permissions.edit && !correcting ? (
					<button aria-label="纠正" data-testid="memory-correct" onClick={() => setCorrecting(true)} className="rounded p-1 hover:bg-surface-2 hover:text-fg" title="纠正（保留历史并说明改了什么）">
						<Wand2 className="size-3.5" />
					</button>
				) : null}
				<button aria-label="历史" onClick={() => setShowHistory((x) => !x)} className="rounded p-1 hover:bg-surface-2 hover:text-fg" title="变更历史" data-testid="memory-history">
					<History className="size-3.5" />
				</button>
				{m.permissions.delete ? (
					<button
						aria-label="删除"
						onClick={async () => {
							if (!confirm("删除这条记忆？")) return;
							try {
								await del(`/memory/${m.id}`);
								onChanged();
							} catch (e) {
								setErr(errorText(e));
							}
						}}
						className="rounded p-1 hover:bg-surface-2 hover:text-danger"
					>
						<Trash2 className="size-3.5" />
					</button>
				) : null}
			</div>
			{correcting ? (
				<div className="mt-2 space-y-2 rounded-lg bg-surface-2 p-2" data-testid="memory-correct-form">
					<Textarea value={fix} onChange={(e) => setFix(e.target.value)} rows={2} aria-label="纠正后的内容" />
					<Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="为什么纠正（可选）" className="h-8 text-[13px]" />
					<div className="flex justify-end gap-2">
						<Button size="sm" variant="ghost" onClick={() => setCorrecting(false)}>
							取消
						</Button>
						<Button
							size="sm"
							variant="primary"
							data-testid="memory-correct-save"
							disabled={!fix.trim() || fix === m.content}
							onClick={async () => {
								try {
									onCorrected(await post<MemoryCorrectionResult>(`/memory/${m.id}/correct`, { content: fix, ...(note ? { note } : {}) }));
									setCorrecting(false);
									onChanged();
								} catch (e) {
									setErr(errorText(e));
								}
							}}
						>
							确认纠正
						</Button>
					</div>
				</div>
			) : null}
			{showHistory ? (
				<ol className="mt-2 space-y-1 border-l border-border pl-3 text-xs text-fg-muted" data-testid="memory-revisions">
					{revs.map((r) => (
						<li key={`${r.version}-${r.at}`}>
							v{r.version} · {CHANGE[r.change]} · {fullTime(r.at)}：{r.content}
							{r.note ? `（${r.note}）` : ""}
						</li>
					))}
				</ol>
			) : null}
			{err ? <p className="mt-1 text-xs text-danger">{err}</p> : null}
		</li>
	);
}

/** Visible result of a correction: what was believed before, what is used from now on. */
function CorrectionResult({ r }: { r: MemoryCorrectionResult }) {
	return (
		<div className="mb-4 rounded-lg border border-success/40 bg-success-soft/40 p-3 text-xs" data-testid="memory-correction-result">
			<div className="mb-1 font-medium text-success">已纠正，从现在起助手按新内容理解</div>
			<div>
				<span className="text-fg-subtle">之前：</span>
				<s>{r.change.before}</s>
			</div>
			<div>
				<span className="text-fg-subtle">现在：</span>
				{r.change.after}
			</div>
			<div className="mt-0.5 text-fg-subtle">
				{fullTime(r.change.at)}
				{r.change.note ? ` · ${r.change.note}` : ""} · 旧版本 v{r.previous.version} 已标记为被替代
			</div>
		</div>
	);
}
