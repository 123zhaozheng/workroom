// 能力: skills (prompt / context-only / executable with dependencies), lifecycle (install, enable, pin, upgrade,
// rollback, per-version grants, run records), skill drafts from a finished task (preview → validate → publish),
// and connectors (MCP) with honest status, per-user enablement and re-check. All actions use D's routes.
import { CheckCircle2, ChevronRight, CircleX, Plug, Plus, RefreshCw, RotateCcw, ShieldCheck, Sparkles, Upload } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { ConnectorDTO, ConnectorListResponse, ConnectorStatus, SkillDTO, SkillDraftDTO, SkillKind, SkillListResponse, SkillRunDTO } from "@shared/files";
import { errorText, patch, post, put } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { cn, fullTime } from "@/lib/utils";
import { TopBar } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge, Blocked, EmptyState, Loadable, Page, PageHeader } from "@/components/ui/misc";

export const KIND: Record<SkillKind, { label: string; hint: string }> = {
	prompt: { label: "提示词预设", hint: "可复用的指令模板，不执行任何代码" },
	context: { label: "上下文技能", hint: "只向助手提供说明（SKILL.md），不执行代码" },
	executable: { label: "可执行技能", hint: "包含脚本与资源，在云端沙箱中执行，需要逐版本授权" },
};
const PERM: Record<string, string> = { "sandbox.exec": "在沙箱中执行", network: "联网（沙箱无网络，无法满足）", "file.write": "写入文件库" };
const permText = (p: string) => PERM[p] ?? (p.startsWith("tool:") ? `使用工具 ${p.slice(5)}` : p);
const CSTATUS: Record<ConnectorStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
	ready: { label: "可用", tone: "success" },
	needs_reconnect: { label: "需要重新连接", tone: "warning" },
	unauthorized: { label: "凭据被拒绝", tone: "danger" },
	error: { label: "连接出错", tone: "danger" },
	unchecked: { label: "尚未检查", tone: "neutral" },
	disabled: { label: "已停用", tone: "neutral" },
};

function useAct(after: () => void) {
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	const run = async (fn: () => Promise<unknown>) => {
		setBusy(true);
		setErr(undefined);
		try {
			await fn();
			after();
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	return { busy, err, run };
}

export default function CapabilitiesPage() {
	const [sp, setSp] = useSearchParams();
	const draftId = sp.get("draft");
	const tab = sp.get("tab") ?? (draftId ? "skills" : "skills");
	const skills = useApi<SkillListResponse>("/skills");
	const conns = useApi<ConnectorListResponse>("/connectors");
	const [create, setCreate] = useState(false);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page>
					<PageHeader
						title="能力"
						description="助手可以使用的技能与外部连接。加载技能只提供说明，不授予执行或联网权限；可执行技能需按版本单独授权。"
						actions={
							tab === "skills" ? (
								<Button onClick={() => setCreate(true)} disabled={skills.unavailable} data-testid="skill-new">
									<Plus />
									新建技能
								</Button>
							) : null
						}
					/>
					{draftId ? <DraftPanel id={draftId} onDone={() => (setSp({ tab: "skills" }), skills.reload())} /> : null}
					<Tabs value={tab} onValueChange={(v) => setSp({ tab: v })}>
						<TabsList className="mb-5">
							<TabsTrigger value="skills">
								<Sparkles />
								技能
							</TabsTrigger>
							<TabsTrigger value="connectors">
								<Plug />
								连接
							</TabsTrigger>
						</TabsList>
						<TabsContent value="skills">
							<Loadable state={skills} what="技能" need="D 组：GET /api/skills">
								{(skills.data?.skills ?? []).length === 0 ? (
									<EmptyState icon={<Sparkles />} title="还没有技能">
										新建一个提示词或说明型技能，或在一次成功的对话里选择“整理为技能”。
									</EmptyState>
								) : (
									<div className="space-y-2">
										{skills.data!.skills.map((s) => (
											<SkillCard key={s.id} s={s} onChanged={skills.reload} />
										))}
									</div>
								)}
							</Loadable>
						</TabsContent>
						<TabsContent value="connectors">
							<Loadable state={conns} what="连接" need="D 组：GET /api/connectors">
								{conns.data ? (
									<div className="space-y-2">
										{conns.data.secretStorage === "unavailable" ? <Blocked title="凭据存储不可用">服务端未配置加密密钥（WORKROOM_SECRET_KEY），需要密钥的连接无法保存。</Blocked> : null}
										{conns.data.connectors.length === 0 ? <EmptyState icon={<Plug />} title="还没有可用的连接" /> : null}
										{conns.data.connectors.map((c) => (
											<ConnectorCard key={c.id} c={c} onChanged={conns.reload} />
										))}
										{conns.data.blocked.map((b) => (
											<Blocked key={b.kind} title={`${b.kind}：未连接`}>
												{b.reason}
											</Blocked>
										))}
									</div>
								) : null}
							</Loadable>
						</TabsContent>
					</Tabs>
				</Page>
			</div>
			<CreateSkillDialog open={create} onOpenChange={setCreate} onCreated={skills.reload} />
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
		<div data-testid="skill" className="rounded-xl border border-border bg-surface">
			<div className="flex flex-wrap items-center gap-2 p-3">
				<button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
					<ChevronRight className={cn("size-4 text-fg-subtle transition-transform", open && "rotate-90")} />
					<span className="font-medium">{s.name}</span>
					<Badge title={KIND[s.kind].hint}>{KIND[s.kind].label}</Badge>
					<Badge>{s.scope === "org" ? "企业" : "个人"}</Badge>
				</button>
				{inst ? (
					<>
						<Badge tone={inst.enabled ? "success" : "neutral"} data-testid="skill-state">
							{inst.enabled ? "已启用" : "已停用"} · 使用 v{inst.effectiveVersionNo}
							{inst.pinnedVersionNo !== null ? "（固定）" : "（跟随最新）"}
						</Badge>
						<label className="flex items-center gap-1.5 text-xs text-fg-muted">
							<input type="checkbox" data-testid="skill-enable" checked={inst.enabled} disabled={busy} onChange={(e) => run(() => patch(`/skills/${s.id}/install`, { enabled: e.target.checked }))} />
							启用
						</label>
					</>
				) : (
					<Button size="sm" disabled={busy} onClick={() => run(() => post(`/skills/${s.id}/install`))} data-testid="skill-install">
						安装
					</Button>
				)}
			</div>
			{err ? <p className="px-3 pb-2 text-[13px] text-danger">{err}</p> : null}
			{open ? (
				<div className="space-y-3 border-t border-border p-3 text-[13px]">
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
								className="h-8 text-[13px]"
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
					{versions.length ? (
						<div>
							<div className="mb-1 text-xs font-medium text-fg-muted">版本</div>
							<ul className="space-y-0.5 text-xs text-fg-muted">
								{versions.map((v) => (
									<li key={v.versionNo}>
										v{v.versionNo} · {fullTime(v.createdAt)} · {v.source === "from_task" ? "从任务整理" : "手动"}
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
	const { busy, err, run } = useAct(() => {
		onOpenChange(false);
		setName("");
		setInstructions("");
		onCreated();
	});
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title="新建技能" description="可执行技能请从成功的任务整理（会附带脚本与验证）。" className="max-w-lg">
				<div className="space-y-3">
					<div>
						<Label htmlFor="sn">名称</Label>
						<Input id="sn" value={name} onChange={(e) => setName(e.target.value)} />
					</div>
					<div>
						<Label htmlFor="sk">类型</Label>
						<Select id="sk" value={kind} onChange={(e) => setKind(e.target.value as "prompt" | "context")} className="w-full">
							<option value="prompt">{KIND.prompt.label}：{KIND.prompt.hint}</option>
							<option value="context">{KIND.context.label}：{KIND.context.hint}</option>
						</Select>
					</div>
					<div>
						<Label htmlFor="sd">一句话说明</Label>
						<Input id="sd" value={description} onChange={(e) => setDescription(e.target.value)} />
					</div>
					<div>
						<Label htmlFor="si">指令 / SKILL.md</Label>
						<Textarea id="si" rows={6} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
					</div>
					{err ? <p className="text-[13px] text-danger">{err}</p> : null}
					<div className="flex justify-end">
						<Button variant="primary" disabled={busy || !name.trim() || !instructions.trim()} onClick={() => run(() => post("/skills", { name, kind, description, instructions }))} data-testid="skill-create">
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
			<Loadable state={res} what="技能草稿" need="D 组：GET /api/skills/drafts/:id">
				{d ? (
					<div className="space-y-3 text-[13px]">
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
							<Textarea id="di" rows={7} value={v.instructions} onChange={(e) => setEdit((x) => ({ ...x, instructions: e.target.value }))} className="font-mono text-[12.5px]" />
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

function ConnectorCard({ c, onChanged }: { c: ConnectorDTO; onChanged: () => void }) {
	const { busy, err, run } = useAct(onChanged);
	const st = CSTATUS[c.status];
	return (
		<div data-testid="connector" className="rounded-xl border border-border bg-surface p-3">
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-medium">{c.name}</span>
				<Badge>{c.scope === "system" ? "系统" : "个人"}</Badge>
				<span className="flex-1" />
				{c.access === "forbidden" ? <Badge tone="danger">无权限{c.accessReason ? `：${c.accessReason}` : ""}</Badge> : null}
				<Badge tone={st.tone}>{st.label}</Badge>
				{c.access === "allowed" ? (
					<>
						<label className="flex items-center gap-1.5 text-xs text-fg-muted">
							<input type="checkbox" checked={c.enabledForMe} disabled={busy} onChange={(e) => run(() => put(`/connectors/${c.id}/enablement`, { enabled: e.target.checked }))} />
							我的任务可用
						</label>
						<Button size="sm" disabled={busy} onClick={() => run(() => post(`/connectors/${c.id}/check`))}>
							<RefreshCw />
							{c.status === "needs_reconnect" || c.status === "error" ? "重新连接" : "检查"}
						</Button>
					</>
				) : null}
			</div>
			{c.statusDetail ? <p className="mt-1 text-xs text-fg-muted">{c.statusDetail}</p> : null}
			{c.lastCheckedAt ? <p className="mt-0.5 text-xs text-fg-subtle">上次检查 {fullTime(c.lastCheckedAt)}</p> : null}
			{c.tools.length ? <p className="mt-1 text-xs text-fg-subtle">工具：{c.tools.map((t) => `${t.tool}${t.policy === "write" ? "（写操作，需确认）" : ""}`).join("、")}</p> : null}
			{err ? <p className="mt-1 text-xs text-danger">{err}</p> : null}
		</div>
	);
}
