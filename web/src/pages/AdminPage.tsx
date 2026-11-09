// 组织管理 — org owners/admins only (the server re-checks every call). Members, invites, departments, sessions,
// models & channels, budgets, audit (+ CSV export). Actions call E's routes directly; errors are shown verbatim.
import { Ban, Download, KeyRound, Plus, RotateCcw, Shield, Trash2, Wifi } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Navigate, useSearchParams } from "react-router";
import type { TraceDTO, AdminPlatformModelDTO, AuditEntryDTO, BudgetDTO, ChannelDTO, DepartmentDTO, DepartmentMemberDTO, InviteDTO, MemberDTO, OrgRole, SessionDTO } from "@shared/ops";
import { api, del, errorText, patch, post, put, qs } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import type { Project } from "@/lib/types";
import { fullTime, relTime } from "@/lib/utils";
import { TopBar } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge, EmptyState, Loadable, Page, PageHeader } from "@/components/ui/misc";

const ROLE: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员" };

/** Runs an action, reports its error inline, then refreshes. */
function useAct(after: () => void) {
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	const [ok, setOk] = useState<string>();
	const run = async (fn: () => Promise<unknown>, okText?: string) => {
		setBusy(true);
		setErr(undefined);
		setOk(undefined);
		try {
			await fn();
			if (okText) setOk(okText);
			after();
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	const note = err ? <p className="my-2 rounded-lg bg-danger-soft px-3 py-1.5 text-[13px] text-danger" role="alert">{err}</p> : ok ? <p className="my-2 rounded-lg bg-success-soft px-3 py-1.5 text-[13px] text-success">{ok}</p> : null;
	return { busy, run, note };
}

function Table({ children, testId }: { children: ReactNode; testId?: string }) {
	return (
		<div data-testid={testId} className="overflow-hidden rounded-xl border border-border bg-surface [&>div+div]:border-t [&>div+div]:border-border">
			{children}
		</div>
	);
}
function Row({ children }: { children: ReactNode }) {
	return <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-[13px]">{children}</div>;
}

export default function AdminPage() {
	const { isOrgAdmin, me } = useSession();
	const [sp, setSp] = useSearchParams();
	if (!isOrgAdmin) return <Navigate to="/" replace />;
	const tab = sp.get("tab") ?? "members";
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page wide>
					<PageHeader title="组织管理" description={`${me?.orgName ?? ""} · 所有变更都会记入审计。普通成员看不到这个页面，服务端也会拒绝其请求。`} />
					<Tabs value={tab} onValueChange={(v) => setSp({ tab: v })}>
						<div className="mb-5 overflow-x-auto">
							<TabsList>
								<TabsTrigger value="members">成员</TabsTrigger>
								<TabsTrigger value="invites">邀请</TabsTrigger>
								<TabsTrigger value="departments">部门</TabsTrigger>
								<TabsTrigger value="sessions">会话</TabsTrigger>
								<TabsTrigger value="models">模型与渠道</TabsTrigger>
								<TabsTrigger value="budgets">预算</TabsTrigger>
								<TabsTrigger value="audit">审计</TabsTrigger>
								<TabsTrigger value="trace">排查</TabsTrigger>
							</TabsList>
						</div>
						<TabsContent value="members">{tab === "members" ? <Members selfId={me?.userId} /> : null}</TabsContent>
						<TabsContent value="invites">{tab === "invites" ? <Invites /> : null}</TabsContent>
						<TabsContent value="departments">{tab === "departments" ? <Departments /> : null}</TabsContent>
						<TabsContent value="sessions">{tab === "sessions" ? <Sessions /> : null}</TabsContent>
						<TabsContent value="models">{tab === "models" ? <ModelsChannels /> : null}</TabsContent>
						<TabsContent value="budgets">{tab === "budgets" ? <Budgets /> : null}</TabsContent>
						<TabsContent value="audit">{tab === "audit" ? <Audit /> : null}</TabsContent>
						<TabsContent value="trace">{tab === "trace" ? <Trace /> : null}</TabsContent>
					</Tabs>
				</Page>
			</div>
		</div>
	);
}

function Members({ selfId }: { selfId?: string }) {
	const res = useApi<{ members: MemberDTO[] }>("/admin/members");
	const { busy, run, note } = useAct(res.reload);
	return (
		<Loadable state={res} what="成员" need="E 组：GET /api/admin/members">
			{note}
			<Table testId="admin-members">
				{(res.data?.members ?? []).map((m) => (
					<div key={m.userId} data-testid="admin-member" data-status={m.status}>
						<Row>
							<span className="min-w-0 flex-1">
								<span className="block truncate font-medium">{m.name}</span>
								<span className="block truncate text-xs text-fg-subtle">
									{m.email} · {m.activeSessions} 个会话{m.lastSeenAt ? ` · 最近活跃 ${relTime(m.lastSeenAt)}` : ""}
									{m.totpEnabled ? " · 两步验证" : ""}
								</span>
							</span>
							{m.status === "disabled" ? <Badge tone="danger">已停用</Badge> : null}
							{m.userId === selfId ? (
								<Badge>{ROLE[m.role]}（你）</Badge>
							) : (
								<>
									<Select value={m.role} disabled={busy} aria-label={`${m.name} 的角色`} className="h-8 text-[13px]" onChange={(e) => run(() => patch(`/admin/members/${m.userId}`, { role: e.target.value }), "角色已更新")}>
										<option value="owner">所有者</option>
										<option value="admin">管理员</option>
										<option value="member">成员</option>
									</Select>
									{m.status === "active" ? (
										<Button size="sm" disabled={busy} data-testid="member-disable" onClick={() => run(() => post(`/admin/members/${m.userId}/disable`), `已停用 ${m.name}，其全部会话已撤销`)}>
											<Ban />
											停用
										</Button>
									) : (
										<Button size="sm" disabled={busy} onClick={() => run(() => post(`/admin/members/${m.userId}/enable`), `已恢复 ${m.name}（旧会话仍保持撤销）`)}>
											<RotateCcw />
											恢复
										</Button>
									)}
									<Button size="sm" variant="ghost" disabled={busy} onClick={() => confirm(`将 ${m.name} 移出组织？其项目成员关系、部门、会话与分享链接都会被移除。`) && run(() => del(`/admin/members/${m.userId}`), "已移出组织")}>
										<Trash2 />
										移出
									</Button>
								</>
							)}
						</Row>
					</div>
				))}
			</Table>
		</Loadable>
	);
}

function Invites() {
	const res = useApi<{ invites: InviteDTO[] }>("/admin/invites");
	const deps = useApi<{ departments: DepartmentDTO[] }>("/departments");
	const { busy, run, note } = useAct(res.reload);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<OrgRole>("member");
	const [dept, setDept] = useState("");
	const [ttl, setTtl] = useState(72);
	const [created, setCreated] = useState<string>();
	return (
		<div>
			<form
				className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-border bg-surface p-3"
				onSubmit={(e) => {
					e.preventDefault();
					void run(async () => {
						const r = await post<{ invite: InviteDTO }>("/admin/invites", { ...(email ? { email } : {}), role, ...(dept ? { departmentId: dept } : {}), ttlHours: ttl });
						setCreated(r.invite.code);
						setEmail("");
					});
				}}
			>
				<Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="限定邮箱（可选）" type="email" className="h-8 w-56 text-[13px]" />
				<Select value={role} onChange={(e) => setRole(e.target.value as OrgRole)} className="h-8 text-[13px]">
					<option value="member">成员</option>
					<option value="admin">管理员</option>
				</Select>
				<Select value={dept} onChange={(e) => setDept(e.target.value)} className="h-8 text-[13px]">
					<option value="">不加入部门</option>
					{(deps.data?.departments ?? []).map((d) => (
						<option key={d.id} value={d.id}>
							{d.name}
						</option>
					))}
				</Select>
				<label className="flex items-center gap-1 text-xs text-fg-muted">
					有效
					<Input type="number" min={1} value={ttl} onChange={(e) => setTtl(Math.max(1, Number(e.target.value) || 1))} className="h-8 w-20 text-[13px]" />
					小时
				</label>
				<Button size="sm" variant="primary" type="submit" disabled={busy} data-testid="invite-create">
					<Plus />
					生成邀请码
				</Button>
			</form>
			{created ? (
				<p className="mb-3 rounded-lg bg-info-soft px-3 py-2 text-[13px] text-info" data-testid="invite-link">
					邀请链接：<code className="break-all">{`${location.origin}/register?invite=${created}`}</code>
				</p>
			) : null}
			{note}
			<Loadable state={res} what="邀请" need="E 组：GET /api/admin/invites">
				{(res.data?.invites ?? []).length === 0 ? (
					<p className="text-[13px] text-fg-subtle">没有邀请。</p>
				) : (
					<Table testId="admin-invites">
						{res.data!.invites.map((i) => (
							<div key={i.code}>
								<Row>
									<code className="text-xs">{i.code.slice(0, 10)}…</code>
									<span className="min-w-0 flex-1 text-xs text-fg-muted">
										{ROLE[i.role]}
										{i.email ? ` · 限 ${i.email}` : ""} · 到期 {fullTime(i.expiresAt)}
									</span>
									{i.usedAt ? <Badge tone="success">已使用</Badge> : i.revokedAt ? <Badge>已撤销</Badge> : Date.parse(i.expiresAt) < Date.now() ? <Badge>已过期</Badge> : <Badge tone="info">有效</Badge>}
									{!i.usedAt && !i.revokedAt ? (
										<Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => del(`/admin/invites/${i.code}`), "邀请已撤销")}>
											撤销
										</Button>
									) : null}
								</Row>
							</div>
						))}
					</Table>
				)}
			</Loadable>
		</div>
	);
}

function Departments() {
	const res = useApi<{ departments: DepartmentDTO[] }>("/departments");
	const members = useApi<{ members: MemberDTO[] }>("/admin/members");
	const { busy, run, note } = useAct(res.reload);
	const [name, setName] = useState("");
	const [open, setOpen] = useState<string>();
	return (
		<div>
			<form
				className="mb-4 flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					void run(() => post("/admin/departments", { name }).then(() => setName("")), "部门已创建");
				}}
			>
				<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="新部门名称" className="h-8 max-w-xs text-[13px]" />
				<Button size="sm" type="submit" disabled={busy || !name.trim()} data-testid="dept-create">
					<Plus />
					新建部门
				</Button>
			</form>
			{note}
			<Loadable state={res} what="部门" need="E 组：GET /api/departments">
				{(res.data?.departments ?? []).length === 0 ? (
					<p className="text-[13px] text-fg-subtle">还没有部门。</p>
				) : (
					<Table testId="admin-departments">
						{res.data!.departments.map((d) => (
							<div key={d.id}>
								<Row>
									<button className="min-w-0 flex-1 text-left font-medium" onClick={() => setOpen(open === d.id ? undefined : d.id)}>
										{d.name} <span className="text-xs font-normal text-fg-subtle">· {d.memberCount} 人</span>
									</button>
									<Button size="sm" variant="ghost" disabled={busy} onClick={() => confirm(`删除部门「${d.name}」？`) && run(() => del(`/admin/departments/${d.id}`), "部门已删除")}>
										<Trash2 />
									</Button>
								</Row>
								{open === d.id ? <DeptMembers dept={d} all={members.data?.members ?? []} onChanged={res.reload} /> : null}
							</div>
						))}
					</Table>
				)}
			</Loadable>
		</div>
	);
}

function DeptMembers({ dept, all, onChanged }: { dept: DepartmentDTO; all: MemberDTO[]; onChanged: () => void }) {
	const res = useApi<{ members: DepartmentMemberDTO[] }>(`/admin/departments/${dept.id}/members`);
	const { busy, run, note } = useAct(() => {
		res.reload();
		onChanged();
	});
	const [uid, setUid] = useState("");
	const set = (userId: string, role: "member" | "manager" | null) => run(() => put(`/admin/departments/${dept.id}/members`, { userId, role }));
	return (
		<div className="border-t border-border bg-surface-2/50 px-3 py-2">
			{note}
			<ul className="space-y-1">
				{(res.data?.members ?? []).map((m) => (
					<li key={m.userId} className="flex items-center gap-2 text-[13px]">
						<span className="flex-1">{m.name}</span>
						<Select value={m.role} disabled={busy} onChange={(e) => set(m.userId, e.target.value as "member" | "manager")} className="h-7 text-xs">
							<option value="member">成员</option>
							<option value="manager">负责人（可看本部门统计）</option>
						</Select>
						<Button size="sm" variant="ghost" disabled={busy} onClick={() => set(m.userId, null)}>
							移除
						</Button>
					</li>
				))}
			</ul>
			<div className="mt-2 flex gap-2">
				<Select value={uid} onChange={(e) => setUid(e.target.value)} className="h-7 text-xs">
					<option value="">添加成员…</option>
					{all
						.filter((m) => !(res.data?.members ?? []).some((x) => x.userId === m.userId))
						.map((m) => (
							<option key={m.userId} value={m.userId}>
								{m.name}
							</option>
						))}
				</Select>
				<Button size="sm" disabled={!uid || busy} onClick={() => set(uid, "member").then(() => setUid(""))}>
					添加
				</Button>
			</div>
		</div>
	);
}

function Sessions() {
	const res = useApi<{ sessions: SessionDTO[] }>("/admin/sessions");
	const { busy, run, note } = useAct(res.reload);
	return (
		<Loadable state={res} what="会话" need="E 组：GET /api/admin/sessions">
			{note}
			<Table testId="admin-sessions">
				{(res.data?.sessions ?? []).map((s) => (
					<div key={s.id}>
						<Row>
							<span className="min-w-0 flex-1">
								<span className="block font-medium">
									{s.userName ?? s.userId} {s.current ? <Badge tone="info">当前会话</Badge> : null}
								</span>
								<span className="block truncate text-xs text-fg-subtle">
									{s.authMethod} · 创建 {fullTime(s.createdAt)}
									{s.lastSeenAt ? ` · 最近 ${relTime(s.lastSeenAt)}` : ""} · {s.userAgent ?? ""}
								</span>
							</span>
							{s.revokedAt ? (
								<Badge>已撤销{s.revokedReason ? `：${s.revokedReason}` : ""}</Badge>
							) : !s.current ? (
								<Button size="sm" disabled={busy} onClick={() => run(() => del(`/admin/sessions/${s.id}`), "会话已撤销，持有该令牌的请求将被拒绝")}>
									撤销
								</Button>
							) : null}
						</Row>
					</div>
				))}
			</Table>
		</Loadable>
	);
}

function ModelsChannels() {
	const models = useApi<{ models: AdminPlatformModelDTO[] }>("/admin/models");
	const channels = useApi<{ channels: ChannelDTO[] }>("/admin/channels");
	const { busy, run, note } = useAct(() => {
		models.reload();
		channels.reload();
	});
	const [tests, setTests] = useState<Record<string, string>>({});
	return (
		<div className="space-y-6">
			{note}
			<section>
				<h3 className="mb-2 text-[13px] font-medium text-fg-muted">平台模型（用户可选）</h3>
				<Loadable state={models} what="模型" need="E 组：GET /api/admin/models">
					<Table testId="admin-models">
						{(models.data?.models ?? []).map((m) => (
							<div key={m.id}>
								<Row>
									<span className="min-w-0 flex-1">
										<span className="block font-medium">{m.fixture ? "测试模型（非真实 AI）" : m.label}</span>
										<span className="block truncate text-xs text-fg-subtle">
											{m.routes.length} 条路由 · {m.capabilities.join("/")}
											{m.statusDetail ? ` · ${m.statusDetail}` : ""}
										</span>
									</span>
									<Badge tone={m.status === "ready" ? "success" : m.status === "fixture" ? "warning" : "danger"}>{m.status === "ready" ? "可用" : m.status === "fixture" ? "测试" : "不可用"}</Badge>
									<label className="flex items-center gap-1.5 text-xs text-fg-muted">
										<input type="checkbox" checked={m.enabled} disabled={busy} onChange={(e) => run(() => patch(`/admin/models/${m.id}`, { enabled: e.target.checked }))} />
										对成员开放
									</label>
								</Row>
							</div>
						))}
					</Table>
				</Loadable>
			</section>
			<section>
				<h3 className="mb-2 text-[13px] font-medium text-fg-muted">上游渠道（凭据只在服务端；密钥从不返回）</h3>
				<Loadable state={channels} what="渠道" need="E 组：GET /api/admin/channels">
					<Table testId="admin-channels">
						{(channels.data?.channels ?? []).map((c) => (
							<div key={c.id}>
								<Row>
									<span className="min-w-0 flex-1">
										<span className="block font-medium">{c.name}</span>
										<span className="block truncate text-xs text-fg-subtle">
											{c.provider}
											{c.baseUrl ? ` · ${c.baseUrl}` : ""} · 凭据：{c.credential.kind === "env" ? `环境变量 ${c.credential.envVar ?? ""}` : c.credential.kind === "stored" ? `已加密保存${c.credential.hint ? `（${c.credential.hint}）` : ""}` : "无"}
											{c.healthDetail ? ` · ${c.healthDetail}` : ""}
										</span>
										{tests[c.id] ? <span className="block text-xs text-fg-muted">测试：{tests[c.id]}</span> : null}
									</span>
									<Badge tone={c.health === "ready" ? "success" : c.health === "circuit_open" ? "warning" : "danger"}>{c.health === "ready" ? "就绪" : c.health === "circuit_open" ? "熔断中" : "不可用"}</Badge>
									<Button
										size="sm"
										disabled={busy}
										onClick={() =>
											run(async () => {
												try {
													const r = await post<Record<string, unknown>>(`/admin/channels/${c.id}/test`);
													setTests((t) => ({ ...t, [c.id]: r.ok === false ? `失败 ${String(r.error ?? r.errorMessage ?? "")}` : `成功${r.latencyMs ? `（${r.latencyMs} ms）` : ""}` }));
												} catch (e) {
													setTests((t) => ({ ...t, [c.id]: `失败：${errorText(e)}` }));
												}
											})
										}
									>
										<Wifi />
										测试连通
									</Button>
									<label className="flex items-center gap-1.5 text-xs text-fg-muted">
										<input type="checkbox" checked={c.status === "enabled"} disabled={busy} onChange={(e) => run(() => patch(`/admin/channels/${c.id}`, { status: e.target.checked ? "enabled" : "disabled" }))} />
										启用
									</label>
								</Row>
							</div>
						))}
					</Table>
				</Loadable>
				<p className="mt-2 flex items-center gap-1 text-xs text-fg-subtle">
					<KeyRound className="size-3.5" />
					新增渠道或保存密钥需要服务端配置 WORKROOM_SECRET_KEY；未配置时服务端会拒绝保存密钥。
				</p>
			</section>
		</div>
	);
}

function Budgets() {
	const res = useApi<{ budgets: BudgetDTO[] }>("/budgets");
	const projects = useApi<{ projects: Project[] }>("/projects");
	const { busy, run, note } = useAct(res.reload);
	const [scope, setScope] = useState("org");
	const [period, setPeriod] = useState<"day" | "month" | "total">("month");
	const [cost, setCost] = useState("");
	const [tokens, setTokens] = useState("");
	const [action, setAction] = useState<"block" | "warn">("block");
	return (
		<div>
			<form
				className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-border bg-surface p-3"
				onSubmit={(e) => {
					e.preventDefault();
					const sc = scope === "org" ? { kind: "org", id: "" } : { kind: "project", id: scope.slice(8) };
					void run(
						() => post("/admin/budgets", { scope: sc, period, ...(cost ? { limitCost: Number(cost) } : {}), ...(tokens ? { limitTokens: Number(tokens) } : {}), action }),
						"预算已创建",
					);
				}}
			>
				<Select value={scope} onChange={(e) => setScope(e.target.value)} className="h-8 text-[13px]" aria-label="范围">
					<option value="org">整个组织</option>
					{(projects.data?.projects ?? []).map((p) => (
						<option key={p.id} value={`project:${p.id}`}>
							项目：{p.name}
						</option>
					))}
				</Select>
				<Select value={period} onChange={(e) => setPeriod(e.target.value as "day" | "month" | "total")} className="h-8 text-[13px]">
					<option value="day">每日（UTC）</option>
					<option value="month">每月（UTC）</option>
					<option value="total">累计</option>
				</Select>
				<Input value={cost} onChange={(e) => setCost(e.target.value)} placeholder="费用上限 USD" type="number" min={0} step="0.01" className="h-8 w-32 text-[13px]" />
				<Input value={tokens} onChange={(e) => setTokens(e.target.value)} placeholder="Token 上限" type="number" min={0} className="h-8 w-32 text-[13px]" />
				<Select value={action} onChange={(e) => setAction(e.target.value as "block" | "warn")} className="h-8 text-[13px]">
					<option value="block">超限阻止</option>
					<option value="warn">仅提醒</option>
				</Select>
				<Button size="sm" variant="primary" type="submit" disabled={busy || (!cost && !tokens)} data-testid="budget-create">
					<Plus />
					新建预算
				</Button>
			</form>
			{note}
			<Loadable state={res} what="预算" need="E 组：GET /api/budgets">
				{(res.data?.budgets ?? []).length === 0 ? (
					<p className="text-[13px] text-fg-subtle">没有预算。测试模型用量不计入预算。</p>
				) : (
					<Table testId="admin-budgets">
						{res.data!.budgets.map((b) => (
							<div key={b.id}>
								<Row>
									<span className="min-w-0 flex-1">
										<span className="block font-medium">
											{b.scope.kind === "org" ? "整个组织" : `${b.scope.kind === "project" ? "项目" : b.scope.kind === "department" ? "部门" : "成员"}：${b.scope.name ?? b.scope.id}`} · {b.period === "day" ? "每日" : b.period === "month" ? "每月" : "累计"}
										</span>
										<span className="block text-xs text-fg-subtle">
											已用 ${b.spent.cost.toFixed(4)}
											{b.limitCost != null ? ` / $${b.limitCost}` : ""} · {b.spent.tokens.toLocaleString()}
											{b.limitTokens != null ? ` / ${b.limitTokens.toLocaleString()}` : ""} tokens · {b.action === "block" ? "超限阻止" : "仅提醒"}
										</span>
									</span>
									<Badge tone={b.state === "ok" ? "success" : b.state === "warn" ? "warning" : "danger"}>{b.state === "ok" ? "正常" : b.state === "warn" ? "接近上限" : "已超限"}</Badge>
									<label className="flex items-center gap-1.5 text-xs text-fg-muted">
										<input type="checkbox" checked={b.enabled} disabled={busy} onChange={(e) => run(() => patch(`/admin/budgets/${b.id}`, { enabled: e.target.checked }))} />
										启用
									</label>
									<Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => del(`/admin/budgets/${b.id}`), "预算已删除")}>
										<Trash2 />
									</Button>
								</Row>
							</div>
						))}
					</Table>
				)}
			</Loadable>
		</div>
	);
}

const CATS = ["", "auth", "admin", "grant", "share", "external_write", "model", "budget", "automation", "security"] as const;
const CAT_LABEL: Record<string, string> = { "": "全部", auth: "登录", admin: "管理", grant: "授权", share: "分享", external_write: "外部写", model: "模型", budget: "预算", automation: "自动化", security: "安全" };

function Audit() {
	const [cat, setCat] = useState("");
	const [action, setAction] = useState("");
	const q = qs({ category: cat, action: action || undefined, limit: 100 });
	const res = useApi<{ items: AuditEntryDTO[]; next?: string }>(`/admin/audit${q}`);
	const [more, setMore] = useState<AuditEntryDTO[]>([]);
	const items = [...(res.data?.items ?? []), ...more];
	return (
		<div>
			<div className="mb-3 flex flex-wrap items-center gap-2">
				<Select value={cat} onChange={(e) => (setCat(e.target.value), setMore([]))} className="h-8 text-[13px]" aria-label="类别">
					{CATS.map((c) => (
						<option key={c} value={c}>
							{CAT_LABEL[c]}
						</option>
					))}
				</Select>
				<Input value={action} onChange={(e) => (setAction(e.target.value), setMore([]))} placeholder="动作（支持前缀*，如 member.*）" className="h-8 w-60 text-[13px]" />
				<span className="flex-1" />
				<Button size="sm" asChild>
					<a href={`/api/admin/audit.csv${qs({ category: cat, action: action || undefined })}`} data-testid="audit-export">
						<Download />
						导出审计 CSV
					</a>
				</Button>
				<Button size="sm" asChild>
					<a href="/api/usage/export.csv?scope=org">
						<Download />
						导出用量 CSV
					</a>
				</Button>
			</div>
			<Loadable state={res} what="审计" need="E 组：GET /api/admin/audit">
				{items.length === 0 ? (
					<EmptyState icon={<Shield />} title="没有符合条件的审计记录" />
				) : (
					<Table testId="admin-audit">
						{items.map((a) => (
							<div key={a.id}>
								<Row>
									<span className="w-36 shrink-0 text-xs text-fg-subtle">{fullTime(a.at)}</span>
									<Badge>{CAT_LABEL[a.category] ?? a.category}</Badge>
									<span className="font-mono text-xs">{a.action}</span>
									<span className="min-w-0 flex-1 truncate text-xs text-fg-muted" title={a.detail ? JSON.stringify(a.detail) : undefined}>
										{a.actorName ?? a.actorUserId ?? "系统"}
										{a.target ? ` → ${a.target}` : ""}
										{a.requestId ? ` · ${a.requestId}` : ""}
									</span>
								</Row>
							</div>
						))}
					</Table>
				)}
				{res.data?.next && !more.length ? (
					<Button
						size="sm"
						variant="ghost"
						className="mt-2"
						onClick={async () => {
							const r = await api<{ items: AuditEntryDTO[] }>(`/admin/audit${qs({ category: cat, action: action || undefined, before: res.data!.next, limit: 100 })}`);
							setMore(r.items);
						}}
					>
						加载更早的记录
					</Button>
				) : null}
			</Loadable>
		</div>
	);
}

/** 排查 (M18-B): one correlation id (request id, run id, automation id, request key, or spaceId:conversationId) →
 * audit, model route attempts, usage rows, automation runs, notifications and other modules' events, all tenant-scoped
 * and redacted by the server according to its redaction mode. */
function Trace() {
	const [sp] = useSearchParams();
	const [q, setQ] = useState(sp.get("q") ?? "");
	const [res, setRes] = useState<TraceDTO>();
	const [err, setErr] = useState<string>();
	const [busy, setBusy] = useState(false);
	const run = async (query = q) => {
		if (!query.trim()) return;
		setBusy(true);
		setErr(undefined);
		try {
			setRes(await api<TraceDTO>(`/admin/trace${qs({ q: query.trim() })}`));
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	const sections: [string, number][] = res
		? [
				["审计", res.audit.length],
				["模型路由", res.routeAttempts.length],
				["用量", res.ledger.length],
				["自动化运行", res.automationRuns.length],
				["通知", res.notifications.length],
				["其他模块事件", res.events.length],
			]
		: [];
	return (
		<div data-testid="trace">
			<form
				className="mb-4 flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					void run();
				}}
			>
				<Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="请求 ID / 运行 ID / 自动化 ID / spaceId:对话ID" className="h-9 font-mono text-[13px]" data-testid="trace-q" />
				<Button type="submit" disabled={busy} data-testid="trace-run">
					查询
				</Button>
			</form>
			<p className="mb-3 text-xs text-fg-subtle">结果只包含本组织的数据；提示词、检索词、工具参数等敏感内容由服务端按脱敏配置处理后返回。</p>
			{err ? <p className="text-[13px] text-danger">{err}</p> : null}
			{res ? (
				<div className="space-y-4 text-[13px]">
					<div className="flex flex-wrap gap-2" data-testid="trace-summary">
						{sections.map(([k, n]) => (
							<Badge key={k} tone={n ? "info" : "neutral"}>
								{k} {n}
							</Badge>
						))}
						{res.sources.length ? <span className="text-xs text-fg-subtle">来源：{res.sources.join("、")}</span> : null}
					</div>
					{res.eventErrors?.length ? <p className="text-xs text-warning">部分模块未返回：{res.eventErrors.map((x) => `${x.source}（${x.error}）`).join("、")}</p> : null}
					<TraceTable title="模型路由" rows={res.routeAttempts.map((r) => [fullTime(r.startedAt), `${r.platformModelId} → ${r.channelName ?? r.channelId ?? "—"}/${r.upstreamModelId ?? "—"}`, `${r.status}${r.errorClass ? ` · ${r.errorClass}` : ""}${r.fixture ? " · 测试模型" : ""}`])} />
					<TraceTable title="其他模块事件（工具调用、检索…）" rows={res.events.map((e) => [fullTime(e.at), `${e.source} · ${e.kind}${e.callId ? ` · ${e.callId}` : ""}`, `${e.status ? `${e.status} · ` : ""}${e.summary}${e.detail !== undefined ? ` · ${JSON.stringify(e.detail).slice(0, 400)}` : ""}`])} testId="trace-events" />
					<TraceTable title="用量" rows={res.ledger.map((l) => [fullTime(l.at), `${l.kind} · ${l.platformModelId ?? l.toolName ?? ""}`, `${l.outcome}${l.fixture ? " · 模拟用量，不计费" : ` · ${l.tokens.total} tokens · $${l.cost.toFixed(4)}`}`])} />
					<TraceTable title="审计" rows={res.audit.map((a) => [fullTime(a.at), a.action, `${a.actorName ?? a.actorUserId ?? "系统"}${a.target ? ` → ${a.target}` : ""}`])} />
					<TraceTable title="自动化运行" rows={res.automationRuns.map((r) => [fullTime(r.createdAt), r.automationId, `${r.status}${r.error ? ` · ${r.error}` : ""}`])} />
					<TraceTable title="通知" rows={res.notifications.map((n) => [fullTime(n.createdAt), n.title, n.status ?? ""])} />
				</div>
			) : null}
		</div>
	);
}

function TraceTable({ title, rows, testId }: { title: string; rows: string[][]; testId?: string }) {
	if (!rows.length) return null;
	return (
		<section data-testid={testId}>
			<h3 className="mb-1 text-xs font-medium text-fg-muted">
				{title}（{rows.length}）
			</h3>
			<div className="overflow-hidden rounded-lg border border-border">
				{rows.map((r, i) => (
					<div key={i} className="grid grid-cols-[150px_minmax(0,1fr)_minmax(0,1.2fr)] gap-2 border-t border-border px-3 py-1.5 text-xs first:border-t-0">
						<span className="text-fg-subtle">{r[0]}</span>
						<span className="truncate font-mono" title={r[1]}>
							{r[1]}
						</span>
						<span className="break-words text-fg-muted">{r[2]}</span>
					</div>
				))}
			</div>
		</section>
	);
}
