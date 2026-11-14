// 专家: 专家广场 (categories · search · cards) / 我的专家 (create · edit · submit for review) / 专家详情 (start a conversation).
// Experts share the skills/MCP lifecycle: upload → automatic checks → 审查员 → publish. Mounted skills are references (always the current
// published version). Permissions are decided by the server; the page only reflects them.
import { Compass, MessageSquarePlus, Pencil, Plus, Search, Send, Sparkles, Trash2, UserRoundCog } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { ExpertDTO } from "@shared/experts";
import type { MarketScope, SubmissionDTO } from "@shared/files";
import { del, errorText, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { cn } from "@/lib/utils";
import { TopBar } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, Sheet } from "@/components/ui/overlay";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge, EmptyState, Loadable, Page, PageHeader } from "@/components/ui/misc";
import { useSession } from "@/lib/session";
import { useViewerPerms } from "@/features/admin/rbac-ui";
import { StateBadge } from "@/features/market/common";
import { modelName, useModels } from "@/features/composer/models";
import { ExpertEditor } from "./ExpertEditor";
import { EXPERT_CATEGORIES, ExpertAvatar, SCOPE_LABEL, SkillChip, StatusBadge } from "./common";

type Tab = "square" | "mine";

export default function ExpertsPage() {
	const [sp, setSp] = useSearchParams();
	const tab: Tab = sp.get("tab") === "mine" ? "mine" : "square";
	const [editing, setEditing] = useState<ExpertDTO | "new" | null>(null);
	const [open, setOpen] = useState<string>();
	const square = useApi<{ experts: ExpertDTO[] }>(tab === "square" ? "/experts" : null);
	const mine = useApi<{ experts: ExpertDTO[] }>("/experts?mine=1");
	const perms = useViewerPerms();
	const canCreate = perms.org.has("expert.create");
	const reload = () => (square.reload(), mine.reload());
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page wide>
					<PageHeader
						title="专家"
						actions={
							<Button variant="primary" onClick={() => setEditing("new")} disabled={!canCreate} data-testid="expert-new">
								<Plus />
								创建专家
							</Button>
						}
					/>
					<Tabs value={tab} onValueChange={(t) => setSp(t === "square" ? {} : { tab: t })}>
						<TabsList className="mb-5">
							<TabsTrigger value="square" data-testid="tab-square">
								<Compass />
								专家广场
							</TabsTrigger>
							<TabsTrigger value="mine" data-testid="tab-my-experts">
								<UserRoundCog />
								我的专家
								{mine.data?.experts.length ? <span className="ml-1 text-xs text-fg-subtle">{mine.data.experts.length}</span> : null}
							</TabsTrigger>
						</TabsList>
						<TabsContent value="square">
							<Square list={square} onOpen={setOpen} />
						</TabsContent>
						<TabsContent value="mine">
							<Mine list={mine} onOpen={setOpen} onEdit={setEditing} onCreate={() => setEditing("new")} canCreate={canCreate} onChanged={reload} />
						</TabsContent>
					</Tabs>
				</Page>
			</div>
			<Sheet open={!!open} onOpenChange={(o) => !o && setOpen(undefined)} title="专家详情" className="sm:max-w-[560px]">
				{open ? <ExpertDetail id={open} onEdit={(e) => (setOpen(undefined), setEditing(e))} onChanged={reload} /> : null}
			</Sheet>
			{editing ? (
				<ExpertEditor
					initial={editing === "new" ? undefined : editing}
					onClose={() => setEditing(null)}
					onSaved={(e) => {
						setEditing(null);
						reload();
						setSp({ tab: "mine" });
						setOpen(e.id);
					}}
				/>
			) : null}
		</div>
	);
}

const Chip = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) => (
	<button type="button" onClick={onClick} aria-pressed={active} className={cn("h-7 rounded-full border px-3 text-sm transition-colors", active ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface text-fg-muted hover:bg-surface-2")}>
		{children}
	</button>
);

function Square({ list, onOpen }: { list: ReturnType<typeof useApi<{ experts: ExpertDTO[] }>>; onOpen: (id: string) => void }) {
	const [q, setQ] = useState("");
	const [cat, setCat] = useState("");
	const all = list.data?.experts ?? [];
	const cats = EXPERT_CATEGORIES.filter((c) => all.some((e) => e.category === c)).concat([...new Set(all.map((e) => e.category))].filter((c) => !(EXPERT_CATEGORIES as readonly string[]).includes(c)) as never[]);
	const needle = q.trim().toLowerCase();
	const shown = all.filter((e) => (!cat || e.category === cat) && (!needle || `${e.name} ${e.tagline} ${e.tags.join(" ")}`.toLowerCase().includes(needle)));
	return (
		<div data-testid="expert-square">
			<div className="mb-3 flex flex-wrap items-center gap-2">
				<div className="relative min-w-[200px] flex-1 sm:max-w-xs">
					<Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
					<input data-testid="expert-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索专家" aria-label="搜索专家" className="h-9 w-full rounded-lg border border-border bg-surface pl-8 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
				</div>
				<div className="flex flex-wrap gap-1.5" role="group" aria-label="分类">
					<Chip active={!cat} onClick={() => setCat("")}>
						全部
					</Chip>
					{cats.map((c) => (
						<Chip key={c} active={cat === c} onClick={() => setCat(cat === c ? "" : c)}>
							{c}
						</Chip>
					))}
				</div>
			</div>
			<Loadable state={list} what="专家广场">
				{shown.length === 0 ? <EmptyState icon={<Sparkles />} title={q || cat ? "没有符合条件的专家" : "还没有已发布的专家"} /> : <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{shown.map((e) => <ExpertCard key={e.id} e={e} onOpen={() => onOpen(e.id)} />)}</div>}
			</Loadable>
		</div>
	);
}

export function ExpertCard({
	e,
	onOpen,
	badge,
	footer,
	testId = "expert-card",
}: {
	e: ExpertDTO;
	onOpen: () => void;
	badge?: ReactNode;
	footer?: ReactNode;
	testId?: string;
}) {
	return (
		<div data-testid={testId} data-id={e.id} className="flex flex-col rounded-xl border border-border bg-surface p-4 text-left transition-shadow hover:shadow-pop">
			<button type="button" onClick={onOpen} className="flex flex-1 flex-col rounded-lg text-left focus-visible:outline-2 focus-visible:outline-ring">
				<div className="flex w-full items-start gap-3">
					<ExpertAvatar e={e} size={40} />
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center justify-between gap-1.5">
							<span className="min-w-0 truncate font-medium">{e.name}</span>
							{badge}
						</div>
						<div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
							<span>{e.category}</span>
							<span aria-hidden>·</span>
							<span>{SCOPE_LABEL[e.scope]}</span>
							{e.ownerName ? (
								<>
									<span aria-hidden>·</span>
									<span className="truncate">{e.ownerName}</span>
								</>
							) : null}
						</div>
					</div>
				</div>
				<p className="mt-2.5 line-clamp-2 min-h-[2.6em] w-full text-sm text-fg-muted">{e.tagline || "（没有简介）"}</p>
				<div className="mt-3 flex min-h-6 w-full flex-wrap items-center gap-1.5">
					{e.skills.slice(0, 3).map((s) => (
						<span key={s.skillId} className="inline-flex h-6 max-w-[9rem] items-center gap-1 rounded-md bg-surface-2 px-2 text-xs text-fg-muted" data-testid="card-skill">
							<Sparkles aria-hidden className="size-3 shrink-0" />
							<span className="truncate">{s.name}</span>
						</span>
					))}
					{e.skills.length > 3 ? <span className="text-xs text-fg-subtle">+{e.skills.length - 3}</span> : null}
					{!badge && e.installed ? (
						<Badge tone="success" className="ml-auto">
							已添加
						</Badge>
					) : null}
				</div>
			</button>
			{footer ? <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-border pt-2.5">{footer}</div> : null}
		</div>
	);
}

function Mine({ list, onOpen, onEdit, onCreate, canCreate, onChanged }: { list: ReturnType<typeof useApi<{ experts: ExpertDTO[] }>>; onOpen: (id: string) => void; onEdit: (e: ExpertDTO) => void; onCreate: () => void; canCreate: boolean; onChanged: () => void }) {
	const [submit, setSubmit] = useState<ExpertDTO>();
	const [err, setErr] = useState<string>();
	const items = list.data?.experts ?? [];
	return (
		<div data-testid="my-experts">
			{err ? <p className="mb-2 text-sm text-danger">{err}</p> : null}
			<Loadable state={list} what="我的专家">
				{items.length === 0 ? (
					<EmptyState icon={<UserRoundCog />} title="还没有专家" action={canCreate ? <Button onClick={onCreate}>创建专家</Button> : undefined}>
						专家 = 角色设定 + 挂载的技能 + 默认模型，创建后可在对话里 @ 它。
					</EmptyState>
				) : (
					<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
						{items.map((e) => (
							<ExpertCard
								key={e.id}
								e={e}
								testId="my-expert"
								onOpen={() => onOpen(e.id)}
								badge={<StatusBadge e={e} />}
								footer={
									<>
										{e.source !== "assistant" ? (
											<Button size="sm" variant="ghost" onClick={() => onEdit(e)} aria-label="编辑">
												<Pencil />
												编辑
											</Button>
										) : null}
										{e.source !== "assistant" ? (
											<Button size="sm" variant="ghost" onClick={() => setSubmit(e)} data-testid="expert-submit-open">
												<Send />
												提交审核…
											</Button>
										) : null}
										<Button
											size="icon"
											variant="ghost"
											className="ml-auto"
											aria-label="删除"
											onClick={async () => {
												if (!confirm(`删除专家「${e.name}」？已有对话不受影响。`)) return;
												try {
													await del(`/experts/${e.id}`);
													onChanged();
												} catch (x) {
													setErr(errorText(x));
												}
											}}
										>
											<Trash2 />
										</Button>
									</>
								}
							/>
						))}
					</div>
				)}
			</Loadable>
			{submit ? <SubmitDialog expert={submit} onClose={() => setSubmit(undefined)} onDone={() => (setSubmit(undefined), onChanged())} /> : null}
		</div>
	);
}

function SubmitDialog({ expert, onClose, onDone }: { expert: ExpertDTO; onClose: () => void; onDone: () => void }) {
	const perms = useViewerPerms();
	const depts = useApi<{ departments: { id: string; name: string }[] }>("/departments");
	const [scope, setScope] = useState<MarketScope>(perms.org.has("expert.publish") ? "org" : "department");
	const [ref, setRef] = useState("");
	const [note, setNote] = useState("");
	const [err, setErr] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<SubmissionDTO>();
	const run = async () => {
		setBusy(true);
		setErr(undefined);
		try {
			setResult((await post<{ submission: SubmissionDTO }>(`/experts/${expert.id}/submit`, { targetScope: scope, targetRef: ref || undefined, note })).submission);
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent title="提交审核" description={`「${expert.name}」`}>
				{result ? (
					<div className="space-y-3 text-sm" data-testid="expert-submit-result">
						<p className="flex items-center gap-2">
							结果：<StateBadge state={result.state} />
						</p>
						{result.errorCount || result.warnCount ? <p className="text-fg-muted">自动检查：{result.errorCount ? `${result.errorCount} 项错误` : ""}{result.warnCount ? ` ${result.warnCount} 项需关注` : ""}（详情在「待审核」里）</p> : null}
						<div className="flex justify-end">
							<Button variant="primary" onClick={onDone}>
								完成
							</Button>
						</div>
					</div>
				) : (
					<div className="space-y-3 text-sm">
						<div>
							<Label htmlFor="exsc">发布到</Label>
							<Select id="exsc" className="w-full" value={scope} onChange={(e) => (setScope(e.target.value as MarketScope), setRef(""))} data-testid="expert-submit-scope">
								<option value="org">整个组织</option>
								<option value="department">某个部门</option>
							</Select>
						</div>
						{scope === "department" ? (
							<div>
								<Label htmlFor="exdp">部门</Label>
								<Select id="exdp" className="w-full" value={ref} onChange={(e) => setRef(e.target.value)}>
									<option value="">请选择…</option>
									{depts.data?.departments.map((d) => (
										<option key={d.id} value={d.id}>
											{d.name}
										</option>
									))}
								</Select>
							</div>
						) : null}
						<div>
							<Label htmlFor="exnt">给审查员的说明（可选）</Label>
							<Textarea id="exnt" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
						</div>
						{err ? <p className="text-danger">{err}</p> : null}
						<div className="flex justify-end">
							<Button variant="primary" disabled={busy || (scope === "department" && !ref)} onClick={run} data-testid="expert-submit-confirm">
								提交
							</Button>
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

export function ExpertDetail({ id, onEdit, onChanged }: { id: string; onEdit: (e: ExpertDTO) => void; onChanged: () => void }) {
	const d = useApi<{ expert: ExpertDTO }>(`/experts/${id}`);
	const navigate = useNavigate();
	const { personalSpaceId } = useSession();
	const { models } = useModels();
	const [err, setErr] = useState<string>();
	const [busy, setBusy] = useState(false);
	const e = d.data?.expert;
	const model = e?.defaultModel ? models.find((m) => m.ref?.provider === e.defaultModel!.provider && m.ref.modelId === e.defaultModel!.modelId) : undefined;
	const start = async (seed?: string) => {
		if (!e) return;
		setBusy(true);
		setErr(undefined);
		try {
			const r = await post<{ conversation: { spaceId: string; conversationId: number } }>("/conversations", { ...(personalSpaceId ? { spaceId: personalSpaceId } : {}), expertId: e.id });
			if (seed) sessionStorage.setItem(`wr.seed.${r.conversation.spaceId}.${r.conversation.conversationId}`, seed);
			navigate(`/c/${r.conversation.spaceId}/${r.conversation.conversationId}`);
		} catch (x) {
			setErr(errorText(x));
		} finally {
			setBusy(false);
		}
	};
	const toggle = async () => {
		if (!e) return;
		try {
			e.installed ? await del(`/experts/${e.id}/install`) : await post(`/experts/${e.id}/install`);
			d.reload();
			onChanged();
		} catch (x) {
			setErr(errorText(x));
		}
	};
	return (
		<Loadable state={d} what="专家">
			{e ? (
				<div className="wr-scroll min-h-0 flex-1 space-y-5 overflow-y-auto p-5 text-sm" data-testid="expert-detail">
					<div className="flex items-start gap-3">
						<ExpertAvatar e={e} size={52} />
						<div className="min-w-0 flex-1">
							<h2 className="text-lg font-semibold tracking-tight">{e.name}</h2>
							<p className="mt-0.5 text-fg-muted">{e.tagline}</p>
							<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
								<Badge>{e.category}</Badge>
								<Badge>{SCOPE_LABEL[e.scope]}</Badge>
								{e.mine ? <StatusBadge e={e} /> : null}
								{e.tags.map((t) => (
									<span key={t} className="text-xs text-fg-subtle">
										#{t}
									</span>
								))}
							</div>
						</div>
					</div>
					<div className="flex flex-wrap gap-2">
						<Button variant="primary" onClick={() => void start()} disabled={busy} data-testid="expert-start">
							<MessageSquarePlus />
							开始对话
						</Button>
						{!e.mine ? (
							<Button onClick={toggle} data-testid="expert-install">
								{e.installed ? "移出我的专家" : "添加到我的专家"}
							</Button>
						) : e.source !== "assistant" ? (
							<Button onClick={() => onEdit(e)}>
								<Pencil />
								编辑
							</Button>
						) : null}
					</div>
					{err ? <p className="text-danger">{err}</p> : null}
					{e.description ? <p className="whitespace-pre-wrap text-fg-muted">{e.description}</p> : null}
					{e.opening ? (
						<section>
							<h3 className="mb-1 text-xs font-medium text-fg-subtle">开场白</h3>
							<p className="rounded-xl bg-surface-2 px-3 py-2">{e.opening}</p>
						</section>
					) : null}
					{e.starters.length ? (
						<section>
							<h3 className="mb-1.5 text-xs font-medium text-fg-subtle">试试这样问</h3>
							<div className="flex flex-col items-start gap-1.5">
								{e.starters.map((s) => (
									<button key={s} type="button" onClick={() => void start(s)} className="rounded-full border border-border bg-surface px-3 py-1 text-left text-[13px] hover:bg-surface-2">
										{s}
									</button>
								))}
							</div>
						</section>
					) : null}
					<section>
						<h3 className="mb-1.5 text-xs font-medium text-fg-subtle">挂载的技能</h3>
						{e.skills.length ? (
							<div className="flex flex-wrap gap-1.5" data-testid="detail-skills">
								{e.skills.map((s) => (
									<SkillChip key={s.skillId} s={s} />
								))}
							</div>
						) : (
							<p className="text-fg-subtle">没有挂载技能</p>
						)}
						<p className="mt-1.5 text-xs text-fg-subtle">显示的是技能当前已发布的版本；技能更新后，专家下一次对话自动使用，无需重新发布。</p>
					</section>
					<section>
						<h3 className="mb-1 text-xs font-medium text-fg-subtle">模型</h3>
						<p>
							{e.defaultModel ? (model ? modelName(model) : e.defaultModel.modelId) : "跟随会话"}
							{e.modelAvailability && e.modelAvailability.status !== "ok" ? <span className="ml-2 text-warning">当前不可用，将改用你的模型</span> : null}
						</p>
					</section>
					{e.mine && e.instructions ? (
						<section>
							<h3 className="mb-1 text-xs font-medium text-fg-subtle">系统指令（仅作者可见）</h3>
							<pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-xl bg-surface-2 px-3 py-2 text-[13px]">{e.instructions}</pre>
						</section>
					) : null}
				</div>
			) : null}
		</Loadable>
	);
}
