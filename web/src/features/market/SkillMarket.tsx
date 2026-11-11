// 技能市场: browse / search / categories, detail drawer (说明、文件、权限、更新日志、评价), install to me / project / department / org,
// manager actions (下架、重新上架、强制发布) and the market policy dialog.
import { Download, Search, Settings2, ShieldCheck, Sparkles, Users } from "lucide-react";
import { useState } from "react";
import type { MarketPolicyDTO, MarketSkillDetailDTO, MarketSkillSummaryDTO } from "@shared/files";
import { del, post, put, qs } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { cn, fullTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, Sheet } from "@/components/ui/overlay";
import { Badge, EmptyState, Loadable } from "@/components/ui/misc";
import { FileTree, FileViewer, FindingList, PermChips, SCOPE, Stars, StarInput, StateBadge, permExplain, useAct, useMarketMe } from "./common";
import { Markdownish } from "./Markdownish";

export function SkillMarket() {
	const [q, setQ] = useState("");
	const [category, setCategory] = useState("");
	const [scope, setScope] = useState("all");
	const [sort, setSort] = useState("popular");
	const [open, setOpen] = useState<string>();
	const [policy, setPolicy] = useState(false);
	const me = useMarketMe();
	const list = useApi<{ skills: MarketSkillSummaryDTO[] }>(`/market/skills${qs({ q, category, scope, sort })}`);
	const cats = useApi<{ categories: { category: string; count: number }[] }>("/market/categories");
	return (
		<div data-testid="skill-market">
			<div className="mb-4 flex flex-wrap items-center gap-2">
				<div className="relative min-w-[200px] flex-1">
					<Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
					<Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索技能：名称、说明、标签、作者" className="pl-9" aria-label="搜索技能" data-testid="market-search" />
				</div>
				<Select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="范围">
					<option value="all">全部范围</option>
					<option value="org">组织</option>
					<option value="department">部门</option>
					<option value="project">项目</option>
				</Select>
				<Select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="排序">
					<option value="popular">最热门</option>
					<option value="recent">最近更新</option>
					<option value="rating">评分最高</option>
					<option value="name">名称</option>
				</Select>
				{me.data?.me.canManageMarket ? (
					<Button onClick={() => setPolicy(true)} data-testid="market-policy">
						<Settings2 />
						市场策略
					</Button>
				) : null}
			</div>
			{(cats.data?.categories ?? []).length ? (
				<div className="mb-4 flex flex-wrap gap-1.5" data-testid="market-categories">
					<Chip active={!category} onClick={() => setCategory("")}>
						全部
					</Chip>
					{cats.data!.categories.map((c) => (
						<Chip key={c.category} active={category === c.category} onClick={() => setCategory(c.category)}>
							{c.category} <span className="text-fg-subtle">{c.count}</span>
						</Chip>
					))}
				</div>
			) : null}
			<Loadable state={list} what="技能市场">
				{(list.data?.skills ?? []).length === 0 ? (
					<EmptyState icon={<Sparkles />} title={q || category ? "没有符合条件的技能" : "市场里还没有已发布的技能"} />
				) : (
					<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
						{list.data!.skills.map((s) => (
							<SkillCard key={s.id} s={s} onOpen={() => setOpen(s.id)} />
						))}
					</div>
				)}
			</Loadable>
			<Sheet open={!!open} onOpenChange={(o) => !o && setOpen(undefined)} title="技能详情" className="sm:max-w-[640px]">
				{open ? <SkillDetail id={open} onChanged={list.reload} onClose={() => setOpen(undefined)} /> : null}
			</Sheet>
			<PolicyDialog open={policy} onOpenChange={setPolicy} />
		</div>
	);
}

const Chip = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) => (
	<button type="button" onClick={onClick} aria-pressed={active} className={cn("h-7 rounded-full border px-3 text-sm transition-colors", active ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface text-fg-muted hover:bg-surface-2")}>
		{children}
	</button>
);

function SkillCard({ s, onOpen }: { s: MarketSkillSummaryDTO; onOpen: () => void }) {
	return (
		<button type="button" onClick={onOpen} data-testid="market-skill" data-slug={s.slug} className="flex flex-col rounded-xl border border-border bg-surface p-4 text-left transition-shadow hover:shadow-pop focus-visible:outline-2 focus-visible:outline-ring">
			<div className="flex items-start gap-2">
				<div className="min-w-0 flex-1">
					<div className="truncate font-medium">{s.name}</div>
									</div>
				<Badge>{SCOPE[s.scope]}</Badge>
			</div>
			<p className="mt-2 line-clamp-2 min-h-[2.6em] text-sm text-fg-muted">{s.description}</p>
			<div className="mt-3 flex flex-wrap items-center gap-1.5">
				{s.version ? <Badge tone="info">v{s.version}</Badge> : null}
				<PermChips perms={s.requiredPermissions} />
			</div>
			<div className="mt-3 flex items-center gap-3 text-xs text-fg-muted">
				<Stars value={s.ratingAvg} count={s.ratingCount} />
				<span className="inline-flex items-center gap-1">
					<Download className="size-3.5" />
					{s.installCount}
				</span>
				<span className="inline-flex min-w-0 items-center gap-1 truncate">
					<Users className="size-3.5 shrink-0" />
					<span className="truncate">{s.ownerName}</span>
				</span>
				{s.installedFor.length ? (
					<Badge tone="success" className="ml-auto">
						已安装
					</Badge>
				) : null}
			</div>
		</button>
	);
}

function SkillDetail({ id, onChanged, onClose }: { id: string; onChanged: () => void; onClose: () => void }) {
	const d = useApi<{ skill: MarketSkillDetailDTO }>(`/market/skills/${id}`);
	const s = d.data?.skill;
	const [tab, setTab] = useState<"readme" | "files" | "perms" | "log" | "rate">("readme");
	const [file, setFile] = useState<string>();
	const [install, setInstall] = useState(false);
	const [stars, setStars] = useState(0);
	const [comment, setComment] = useState("");
	const [reason, setReason] = useState("");
	const { busy, err, run } = useAct(() => (d.reload(), onChanged()));
	const TABS = [["readme", "说明"], ["files", "文件"], ["perms", "权限"], ["log", "更新日志"], ["rate", "评价"]] as const;
	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="skill-detail">
			<Loadable state={d} what="技能详情">
				{s ? (
					<>
						<header className="border-b border-border px-5 pb-3 pt-5">
							<div className="flex items-start gap-2">
								<div className="min-w-0 flex-1">
									<h2 className="truncate text-lg font-semibold">{s.name}</h2>
									<p className="font-mono text-xs text-fg-subtle">/skills/{s.slug}</p>
								</div>
								<Button size="sm" onClick={onClose} variant="ghost" aria-label="关闭">
									关闭
								</Button>
							</div>
							<p className="mt-2 text-sm text-fg-muted">{s.description}</p>
							<div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
								<Badge>{SCOPE[s.scope]}</Badge>
								{s.version ? <Badge tone="info">v{s.version}</Badge> : null}
								{!s.listed ? <Badge tone="danger">已下架{s.unpublishedReason ? `：${s.unpublishedReason}` : ""}</Badge> : null}
								<Stars value={s.ratingAvg} count={s.ratingCount} />
								<span>安装 {s.installCount}</span>
								<span>作者 {s.ownerName}</span>
							</div>
							<div className="mt-3 flex flex-wrap items-center gap-2">
								<Button variant="primary" size="sm" onClick={() => setInstall(true)} disabled={!s.listed || !s.versionNo} data-testid="market-install">
									安装…
								</Button>
								{s.installedFor.length ? (
									<span className="text-xs text-success" data-testid="installed-for">
										已安装：{s.installedFor.map((x) => (x.target === "me" ? "我" : x.target === "org" ? "整个组织" : x.target === "department" ? "部门" : "项目")).join("、")}
									</span>
								) : null}
								{s.installedFor.some((x) => x.target === "me") ? (
									<Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => del(`/market/skills/${id}/install?target=me`))}>
										卸载（我）
									</Button>
								) : null}
							</div>
							{err ? <p className="mt-2 text-sm text-danger">{err}</p> : null}
						</header>
						<nav className="flex gap-1 overflow-x-auto border-b border-border px-4" role="tablist">
							{TABS.map(([k, label]) => (
								<button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cn("h-9 whitespace-nowrap border-b-2 px-2.5 text-sm", tab === k ? "border-accent font-medium" : "border-transparent text-fg-muted hover:text-fg")}>
									{label}
								</button>
							))}
						</nav>
						<div className="wr-scroll min-h-0 flex-1 overflow-y-auto p-5">
							{tab === "readme" ? <Markdownish text={s.readme} /> : null}
							{tab === "files" ? (
								<div className="grid gap-3 md:grid-cols-[200px_1fr]">
									<div className="rounded-lg border border-border p-1.5">
										<FileTree files={s.files} selected={file} onSelect={setFile} />
									</div>
									<div className="min-h-[120px] rounded-lg border border-border">
										<FileViewer url={file && s.versions[0] ? `/market/skills/${id}/versions/${s.versions.find((v) => v.approved)?.versionNo ?? s.versions[0].versionNo}/file?path=${encodeURIComponent(file)}` : null} />
									</div>
								</div>
							) : null}
							{tab === "perms" ? (
								<div className="space-y-3 text-sm">
									<p className="text-fg-muted">加载技能只提供说明，不授予任何权限；运行脚本时，使用者需要为这个版本单独授权下列项目。</p>
									{s.manifest?.requiredPermissions.length ? (
										<ul className="space-y-1.5">
											{s.manifest.requiredPermissions.map((p) => (
												<li key={p} className="flex items-center gap-2">
													<ShieldCheck className="size-4 text-fg-muted" />
													{permExplain(p)}
												</li>
											))}
										</ul>
									) : (
										<p>无需额外权限。</p>
									)}
									{s.manifest?.requiredTools.length ? <p className="text-fg-muted">依赖工具：{s.manifest.requiredTools.join("、")}</p> : null}
									{s.manifest?.license ? <p className="text-fg-muted">许可：{s.manifest.license}</p> : null}
									{(s.versions.find((v) => v.approved)?.checks?.findings ?? []).length ? <FindingList findings={s.versions.find((v) => v.approved)!.checks!.findings} /> : null}
								</div>
							) : null}
							{tab === "log" ? (
								<ol className="space-y-3 text-sm" data-testid="changelog">
									{s.versions.map((v) => (
										<li key={v.versionNo} className="border-l-2 border-border pl-3">
											<div className="flex flex-wrap items-center gap-2">
												<span className="font-medium">v{v.semver ?? v.versionNo}</span>
												{v.approved ? <Badge tone="success">已发布</Badge> : v.submissionState ? <StateBadge state={v.submissionState} /> : <Badge>草稿</Badge>}
												<span className="text-xs text-fg-subtle">{fullTime(v.createdAt)}</span>
											</div>
											<p className="mt-0.5 text-fg-muted">{v.changeNote ?? "（无说明）"}</p>
										</li>
									))}
								</ol>
							) : null}
							{tab === "rate" ? (
								<div className="space-y-4 text-sm">
									<div className="space-y-2">
										<Label>我的评分</Label>
										<StarInput value={stars || s.myRating?.stars || 0} onChange={setStars} disabled={busy} />
										<Textarea rows={2} placeholder="一句话评价（可选）" value={comment} onChange={(e) => setComment(e.target.value)} />
										<Button size="sm" disabled={busy || !(stars || s.myRating)} onClick={() => run(() => post(`/market/skills/${id}/rate`, { stars: stars || s.myRating!.stars, comment }))} data-testid="rate-submit">
											提交评价
										</Button>
									</div>
									<ul className="space-y-2">
										{s.ratings.map((r, i) => (
											<li key={i} className="rounded-lg bg-surface-2 px-3 py-2">
												<div className="flex items-center gap-2">
													<Stars value={r.stars} count={1} />
													<span className="text-xs text-fg-subtle">{r.userName} · {fullTime(r.at)}</span>
												</div>
												{r.comment ? <p className="mt-1">{r.comment}</p> : null}
											</li>
										))}
									</ul>
								</div>
							) : null}
							{s.canManage ? (
								<div className="mt-6 space-y-2 rounded-xl border border-dashed border-border-strong p-3 text-sm" data-testid="manager-actions">
									<div className="font-medium">管理</div>
									<Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="理由（下架 / 强制发布必填，会写入审计）" aria-label="理由" />
									<div className="flex flex-wrap gap-2">
										{s.listed ? (
											<Button size="sm" disabled={busy || !reason.trim()} onClick={() => run(() => post(`/market/skills/${id}/unpublish`, { reason }))} data-testid="unpublish">
												下架
											</Button>
										) : s.versionNo ? (
											<Button size="sm" disabled={busy} onClick={() => run(() => post(`/market/skills/${id}/republish`))}>
												重新上架
											</Button>
										) : null}
										<Button size="sm" disabled={busy || !reason.trim()} onClick={() => run(() => post(`/market/skills/${id}/force-publish`, { versionNo: s.latestVersionNo, reason }))}>
											强制发布最新版本 v{s.latestVersionNo}
										</Button>
									</div>
								</div>
							) : null}
						</div>
						<InstallDialog open={install} onOpenChange={setInstall} s={s} onDone={() => (d.reload(), onChanged())} />
					</>
				) : null}
			</Loadable>
		</div>
	);
}

function InstallDialog({ open, onOpenChange, s, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; s: MarketSkillDetailDTO; onDone: () => void }) {
	const [target, setTarget] = useState<"me" | "project" | "department" | "org">("me");
	const [ref, setRef] = useState("");
	const projects = useApi<{ projects: { id: string; name: string }[] }>(open ? "/projects?kind=space" : null);
	const depts = useApi<{ departments: { id: string; name: string }[] }>(open ? "/departments" : null);
	const { busy, err, run } = useAct(() => (onOpenChange(false), onDone()));
	const needRef = target === "project" || target === "department";
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={`安装「${s.name}」`} description="只有通过审核并发布的技能可以安装。安装不授予执行权限，运行脚本仍需逐版本授权。">
				<div className="space-y-3 text-sm">
					<div className="grid gap-2" role="radiogroup" aria-label="安装范围">
						{([["me", "安装给我", "我的所有对话"], ["project", "安装到项目", "该项目里的所有对话（需项目写权限）"], ["department", "安装到部门", "部门成员（需部门发布权限）"], ["org", "安装给整个组织", s.canInstallOrg ? "全员默认启用，成员可自行停用" : "仅市场管理员可用"]] as const).map(([k, label, hint]) => (
							<label key={k} className={cn("flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2", target === k ? "border-accent bg-surface-2" : "border-border", k === "org" && !s.canInstallOrg && "opacity-50")}>
								<input type="radio" name="target" className="mt-1" checked={target === k} disabled={k === "org" && !s.canInstallOrg} onChange={() => (setTarget(k), setRef(""))} data-testid={`install-target-${k}`} />
								<span>
									<span className="font-medium">{label}</span>
									<span className="block text-xs text-fg-muted">{hint}</span>
								</span>
							</label>
						))}
					</div>
					{needRef ? (
						<div>
							<Label htmlFor="iref">{target === "project" ? "选择项目" : "选择部门"}</Label>
							<Select id="iref" value={ref} onChange={(e) => setRef(e.target.value)} className="w-full" data-testid="install-ref">
								<option value="">请选择…</option>
								{(target === "project" ? projects.data?.projects : depts.data?.departments)?.map((x) => (
									<option key={x.id} value={x.id}>
										{x.name}
									</option>
								))}
							</Select>
						</div>
					) : null}
					{err ? <p className="text-danger">{err}</p> : null}
					<div className="flex justify-end">
						<Button variant="primary" disabled={busy || (needRef && !ref)} onClick={() => run(() => post(`/market/skills/${s.id}/install`, { target, scopeRef: ref || undefined }))} data-testid="install-confirm">
							确认安装
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

export function PolicyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
	const p = useApi<{ policy: MarketPolicyDTO }>(open ? "/market/policy" : null);
	const { busy, err, run } = useAct(() => p.reload());
	const pol = p.data?.policy;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title="市场策略" description="控制成员能否自行使用个人技能与个人连接器，以及是否需要审核。">
				<div className="space-y-3 text-sm">
					<div>
						<Label htmlFor="ps">个人技能</Label>
						<Select id="ps" className="w-full" value={pol?.personalSkill ?? "free"} disabled={busy} onChange={(e) => run(() => put("/market/policy", { personalSkill: e.target.value }))} data-testid="policy-skill">
							<option value="free">免审核，上传后可自用</option>
							<option value="review">需要审核后才能使用</option>
							<option value="disabled">禁止个人技能</option>
						</Select>
					</div>
					<div>
						<Label htmlFor="pm">个人连接</Label>
						<Select id="pm" className="w-full" value={pol?.personalMcp ?? "free"} disabled={busy} onChange={(e) => run(() => put("/market/policy", { personalMcp: e.target.value }))} data-testid="policy-mcp">
							<option value="free">添加后即可连接</option>
							<option value="approval">审核通过前不连接</option>
							<option value="disabled">禁止个人连接器</option>
						</Select>
					</div>
					{err ? <p className="text-danger">{err}</p> : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}
