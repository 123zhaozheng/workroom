import { Brain, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { MemoryDTO, MemoryKind, MemoryScope } from "@shared/knowledge";
import { del, errorText, patch, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { relTime } from "@/lib/utils";
import { TopBar } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/input";
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
					<Loadable state={res} what="记忆" need="C 组：GET /api/memory">
						{list.length === 0 ? (
							<EmptyState icon={<Brain />} title="还没有记忆" />
						) : (
							<ul className="space-y-2">
								{list.map((m) => (
									<MemoryItem key={m.id} m={m} onChanged={res.reload} />
								))}
							</ul>
						)}
					</Loadable>
				</Page>
			</div>
		</div>
	);
}

function MemoryItem({ m, onChanged }: { m: MemoryDTO; onChanged: () => void }) {
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState(m.content);
	const [err, setErr] = useState<string>();
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
			{err ? <p className="mt-1 text-xs text-danger">{err}</p> : null}
		</li>
	);
}
