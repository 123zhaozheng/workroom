// MCP 市场: catalog of server.json entries — import (paste JSON or upload an offline bundle .zip), submit for review, install wizard
// (remote or sandboxed stdio package; shared or per-user credentials). Blocked options say why.
import { Boxes, Cloud, FileJson, Search, Server } from "lucide-react";
import { useRef, useState } from "react";
import type { McpCatalogDetailDTO, McpCatalogSummaryDTO, McpInstallOptionDTO, MarketScope } from "@shared/files";
import { ApiError, errorText, post, qs } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { cn, fullTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent, Sheet } from "@/components/ui/overlay";
import { Badge, Blocked, EmptyState, Loadable } from "@/components/ui/misc";
import { FindingList, Section, useAct, useMarketMe } from "./common";

const STATUS = { published: { l: "已发布", t: "success" }, pending_review: { l: "待审核", t: "warning" }, draft: { l: "草稿", t: "neutral" }, unpublished: { l: "已下架", t: "danger" } } as const;

export function McpMarket() {
	const [q, setQ] = useState("");
	const [mine, setMine] = useState(false);
	const [open, setOpen] = useState<string>();
	const [imp, setImp] = useState(false);
	const me = useMarketMe();
	const list = useApi<{ entries: McpCatalogSummaryDTO[] }>(`/market/mcp${qs({ q, mine: mine ? "1" : undefined })}`);
	return (
		<div data-testid="mcp-market">
			<div className="mb-4 flex flex-wrap items-center gap-2">
				<div className="relative min-w-[200px] flex-1">
					<Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
					<Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索 MCP 服务器" className="pl-9" aria-label="搜索 MCP" />
				</div>
				<div className="inline-flex rounded-lg bg-surface-2 p-0.5 text-[13px]">
					<button className={cn("h-8 rounded-md px-3", !mine ? "bg-surface shadow-sm" : "text-fg-muted")} onClick={() => setMine(false)}>
						市场
					</button>
					<button className={cn("h-8 rounded-md px-3", mine ? "bg-surface shadow-sm" : "text-fg-muted")} onClick={() => setMine(true)} data-testid="mcp-mine">
						我的条目
					</button>
				</div>
				<Button variant="primary" onClick={() => setImp(true)} data-testid="mcp-import">
					<FileJson />
					导入 server.json
				</Button>
			</div>
			{me.data && me.data.me.sandbox.state !== "ready" ? (
				<div className="mb-4">
					<Blocked title="沙箱不可用：stdio 类服务器暂时无法安装">{me.data.me.sandbox.detail ?? "stdio MCP 服务器只能在沙箱里运行；远程（HTTP）服务器不受影响。"}</Blocked>
				</div>
			) : null}
			<Loadable state={list} what="MCP 市场" need="GET /api/market/mcp">
				{(list.data?.entries ?? []).length === 0 ? (
					<EmptyState icon={<Boxes />} title={mine ? "你还没有导入过条目" : "MCP 市场里还没有已发布的服务器"} action={<Button onClick={() => setImp(true)}>导入 server.json</Button>}>
						条目使用官方 MCP Registry 的 server.json 格式。导入后是你的个人草稿，提交审核并发布后全组织可安装。
					</EmptyState>
				) : (
					<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
						{list.data!.entries.map((e) => (
							<button key={e.id} type="button" onClick={() => setOpen(e.id)} data-testid="mcp-entry" data-name={e.name} className="flex flex-col rounded-xl border border-border bg-surface p-4 text-left transition-shadow hover:shadow-pop">
								<div className="flex items-start gap-2">
									<div className="min-w-0 flex-1">
										<div className="truncate font-medium">{e.title}</div>
										<div className="truncate font-mono text-[11.5px] text-fg-subtle">{e.name}</div>
									</div>
									<Badge tone={STATUS[e.status].t}>{STATUS[e.status].l}</Badge>
								</div>
								<p className="mt-2 line-clamp-2 min-h-[2.6em] text-[13px] text-fg-muted">{e.description}</p>
								<div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
									{e.version ? <Badge tone="info">v{e.version}</Badge> : null}
									{e.transports.includes("http") ? (
										<Badge>
											<Cloud /> 远程
										</Badge>
									) : null}
									{e.transports.includes("stdio") ? (
										<Badge>
											<Server /> 沙箱 stdio
										</Badge>
									) : null}
									<span className="ml-auto">安装 {e.installCount}</span>
									{e.installed ? <Badge tone="success">已安装</Badge> : null}
								</div>
							</button>
						))}
					</div>
				)}
			</Loadable>
			<Sheet open={!!open} onOpenChange={(o) => !o && setOpen(undefined)} title="MCP 条目" className="sm:max-w-[640px]">
				{open ? <EntryDetail id={open} onChanged={list.reload} onClose={() => setOpen(undefined)} /> : null}
			</Sheet>
			<ImportDialog open={imp} onOpenChange={setImp} onDone={(id) => (list.reload(), setMine(true), setOpen(id))} />
		</div>
	);
}

function ImportDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: (id: string) => void }) {
	const [text, setText] = useState("");
	const [err, setErr] = useState<{ text: string; findings?: never[] | any[] }>();
	const [busy, setBusy] = useState(false);
	const [checks, setChecks] = useState<any[]>();
	const fileRef = useRef<HTMLInputElement>(null);
	const go = async (body: FormData | Record<string, unknown>) => {
		setBusy(true);
		setErr(undefined);
		try {
			const r = await post<{ entry: { id: string }; checks: { findings: any[] } }>("/market/mcp/import", body as Record<string, unknown>);
			setChecks(r.checks.findings);
			onDone(r.entry.id);
			if (!r.checks.findings.length) onOpenChange(false);
		} catch (e) {
			setErr({ text: errorText(e), findings: e instanceof ApiError ? (e.detail as any)?.findings : undefined });
		} finally {
			setBusy(false);
		}
	};
	const submitText = () => {
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			setErr({ text: "不是有效的 JSON" });
			return;
		}
		void go({ serverJson: json });
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title="导入 MCP 服务器" description="粘贴官方 MCP Registry 格式的 server.json，或上传离线包（.zip：server.json + 代码，registryType 为 bundle）。导入后是个人草稿。" className="max-w-xl">
				<div className="space-y-3 text-[13px]">
					<Textarea rows={9} value={text} onChange={(e) => setText(e.target.value)} placeholder={'{\n  "name": "io.github.you/notes",\n  "description": "…",\n  "version": "1.0.0",\n  "remotes": [{ "type": "streamable-http", "url": "https://…" }]\n}'} className="font-mono text-[12px]" aria-label="server.json" data-testid="mcp-json" />
					{err ? (
						<div className="rounded-lg border border-danger/40 bg-danger-soft/40 p-3 text-danger" data-testid="import-error">
							{err.text}
							{err.findings?.length ? <div className="mt-2 text-fg"><FindingList findings={err.findings} /></div> : null}
						</div>
					) : null}
					{checks?.length ? (
						<div className="rounded-lg border border-border p-3" data-testid="import-findings">
							<div className="mb-1.5 font-medium">已导入，自动检查提示：</div>
							<FindingList findings={checks} />
						</div>
					) : null}
					<div className="flex flex-wrap items-center justify-between gap-2">
						<Button onClick={() => fileRef.current?.click()} disabled={busy}>
							选择 .json / .zip 文件
						</Button>
						<input
							ref={fileRef}
							type="file"
							hidden
							accept=".json,.zip,application/json,application/zip"
							onChange={async (e) => {
								const f = e.target.files?.[0];
								e.target.value = "";
								if (!f) return;
								if (f.name.endsWith(".zip")) {
									const fd = new FormData();
									fd.set("file", f);
									await go(fd);
								} else setText(await f.text());
							}}
						/>
						<Button variant="primary" disabled={busy || !text.trim()} onClick={submitText} data-testid="mcp-import-go">
							导入
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function EntryDetail({ id, onChanged, onClose }: { id: string; onChanged: () => void; onClose: () => void }) {
	const d = useApi<{ entry: McpCatalogDetailDTO }>(`/market/mcp/${id}`);
	const e = d.data?.entry;
	const [install, setInstall] = useState<McpInstallOptionDTO>();
	const [submit, setSubmit] = useState(false);
	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="mcp-detail">
			<Loadable state={d} what="MCP 条目">
				{e ? (
					<>
						<header className="border-b border-border px-5 pb-3 pt-5">
							<div className="flex items-start gap-2">
								<div className="min-w-0 flex-1">
									<h2 className="truncate text-lg font-semibold">{e.title}</h2>
									<p className="truncate font-mono text-xs text-fg-subtle">{e.name}</p>
								</div>
								<Button size="sm" variant="ghost" onClick={onClose}>
									关闭
								</Button>
							</div>
							<p className="mt-2 text-[13px] text-fg-muted">{e.description}</p>
							<div className="mt-2 flex flex-wrap gap-2">
								<Badge tone={STATUS[e.status].t}>{STATUS[e.status].l}</Badge>
								{e.version ? <Badge tone="info">v{e.version}</Badge> : null}
							</div>
						</header>
						<div className="wr-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
							<Section title="安装方式">
								<ul className="space-y-2" data-testid="mcp-options">
									{e.options.map((o) => (
										<li key={o.index} className="rounded-lg border border-border p-3 text-[13px]" data-blocked={!!o.blocked}>
											<div className="flex flex-wrap items-center gap-2">
												<span className="font-medium">{o.label}</span>
												<Badge>{o.transport === "http" ? "远程 HTTP" : "沙箱 stdio"}</Badge>
												<span className="flex-1" />
												<Button size="sm" variant="primary" disabled={!!o.blocked} onClick={() => setInstall(o)} data-testid="mcp-install">
													安装…
												</Button>
											</div>
											{o.url ? <p className="mt-1 break-all font-mono text-xs text-fg-subtle">{o.url}</p> : null}
											{o.inputs.length ? <p className="mt-1 text-xs text-fg-muted">需要：{o.inputs.map((i) => `${i.name}${i.secret ? "（密钥）" : ""}`).join("、")}</p> : null}
											{o.blocked ? <p className="mt-1.5 text-xs text-warning" data-testid="option-blocked">不可用：{o.blocked}</p> : null}
										</li>
									))}
								</ul>
							</Section>
							<Section title="server.json" right={<span className="text-xs text-fg-subtle">v{e.versions[0]?.semver}</span>}>
								<pre className="max-h-72 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-[12px]">{JSON.stringify(e.serverJson, null, 2)}</pre>
							</Section>
							<Section title="版本">
								<ul className="space-y-1 text-[13px]">
									{e.versions.map((v) => (
										<li key={v.versionNo}>
											v{v.semver} · {fullTime(v.createdAt)} · {v.approved ? <span className="text-success">已发布</span> : <span className="text-fg-muted">未发布</span>}
											{v.changeNote ? ` · ${v.changeNote}` : ""}
										</li>
									))}
								</ul>
							</Section>
							{e.canSubmit ? (
								<Button onClick={() => setSubmit(true)} data-testid="mcp-submit">
									提交审核…
								</Button>
							) : null}
						</div>
						<InstallWizard entry={e} option={install} onClose={() => setInstall(undefined)} onDone={() => (d.reload(), onChanged())} />
						<SubmitDialog open={submit} onOpenChange={setSubmit} entry={e} onDone={() => (d.reload(), onChanged())} />
					</>
				) : null}
			</Loadable>
		</div>
	);
}

function SubmitDialog({ open, onOpenChange, entry, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; entry: McpCatalogDetailDTO; onDone: () => void }) {
	const [scope, setScope] = useState<MarketScope>("org");
	const [ref, setRef] = useState("");
	const [note, setNote] = useState("");
	const depts = useApi<{ departments: { id: string; name: string }[] }>(open && scope === "department" ? "/departments" : null);
	const projects = useApi<{ projects: { id: string; name: string }[] }>(open && scope === "project" ? "/projects" : null);
	const { busy, err, run } = useAct(() => (onOpenChange(false), onDone()));
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title="提交审核" description={`提交最新版本 v${entry.latestVersionNo}。审核员会看到地址/命令、密钥名称与（离线包的）代码。`}>
				<div className="space-y-3 text-[13px]">
					<div>
						<Label htmlFor="ms">发布到</Label>
						<Select id="ms" className="w-full" value={scope} onChange={(e) => (setScope(e.target.value as MarketScope), setRef(""))}>
							<option value="org">整个组织</option>
							<option value="department">某个部门</option>
							<option value="project">某个项目</option>
						</Select>
					</div>
					{scope !== "org" ? (
						<Select className="w-full" value={ref} onChange={(e) => setRef(e.target.value)} aria-label="范围对象">
							<option value="">请选择…</option>
							{(scope === "department" ? depts.data?.departments : projects.data?.projects)?.map((x) => (
								<option key={x.id} value={x.id}>
									{x.name}
								</option>
							))}
						</Select>
					) : null}
					<Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="给审核员的说明（可选）" />
					{err ? <p className="text-danger">{err}</p> : null}
					<div className="flex justify-end">
						<Button variant="primary" disabled={busy || (scope !== "org" && !ref)} onClick={() => run(() => post(`/market/mcp/${entry.id}/versions/${entry.latestVersionNo}/submit`, { targetScope: scope, targetRef: ref || undefined, note }))} data-testid="mcp-submit-confirm">
							提交
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function InstallWizard({ entry, option, onClose, onDone }: { entry: McpCatalogDetailDTO; option?: McpInstallOptionDTO; onClose: () => void; onDone: () => void }) {
	const me = useMarketMe();
	const [target, setTarget] = useState<"me" | "org">("me");
	const [name, setName] = useState("");
	const [values, setValues] = useState<Record<string, string>>({});
	const [cred, setCred] = useState<"shared" | "per_user">("shared");
	const [result, setResult] = useState<{ status: string; approval: string }>();
	const { busy, err, run } = useAct();
	const canOrg = me.data?.me.canAddOrgConnector && entry.scope === "org" && entry.listed;
	if (!option) return null;
	const perUser = target === "org" && cred === "per_user";
	const secretsMissing = option.inputs.some((i) => i.required && !values[i.name] && !(perUser && i.secret));
	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent title={`安装「${entry.title}」`} description={option.label} className="max-w-lg">
				{result ? (
					<div className="space-y-3 text-[13px]" data-testid="install-result">
						<p>
							已创建连接：<b>{result.approval === "pending" ? "等待审核（批准前不会连接）" : result.status === "ready" ? "已连接，可用" : `状态 ${result.status}`}</b>
						</p>
						<p className="text-fg-muted">可在「我的连接」里管理工具开关与凭据。</p>
						<div className="flex justify-end">
							<Button onClick={onClose}>完成</Button>
						</div>
					</div>
				) : (
					<div className="space-y-3 text-[13px]">
						<div className="grid grid-cols-2 gap-2">
							<label className={cn("cursor-pointer rounded-lg border px-3 py-2", target === "me" ? "border-accent bg-surface-2" : "border-border")}>
								<input type="radio" className="mr-2" checked={target === "me"} onChange={() => setTarget("me")} />
								仅我自己
							</label>
							<label className={cn("rounded-lg border px-3 py-2", target === "org" ? "border-accent bg-surface-2" : "border-border", canOrg ? "cursor-pointer" : "opacity-50")}>
								<input type="radio" className="mr-2" disabled={!canOrg} checked={target === "org"} onChange={() => setTarget("org")} />
								整个组织
							</label>
						</div>
						{target === "me" && me.data?.me.policy.personalMcp === "approval" ? <p className="rounded-lg bg-warning-soft px-3 py-2 text-warning">组织策略要求个人连接器先经审核：提交后不会连接，直到审核员批准。</p> : null}
						{target === "org" ? (
							<div>
								<Label htmlFor="cred">凭据</Label>
								<Select id="cred" className="w-full" value={cred} onChange={(e) => setCred(e.target.value as typeof cred)}>
									<option value="shared">共享凭据（由我填写，所有人共用）</option>
									<option value="per_user">每人使用自己的凭据（安装后各自填写）</option>
								</Select>
							</div>
						) : null}
						<div>
							<Label htmlFor="cn">连接名称</Label>
							<Input id="cn" value={name} onChange={(e) => setName(e.target.value)} placeholder={entry.title} />
						</div>
						{option.inputs.map((i) => (
							<div key={`${i.where}-${i.name}`} className={cn(perUser && i.secret && "opacity-50")}>
								<Label htmlFor={`in-${i.name}`}>
									{i.name}
									{i.required ? " *" : ""}
									{i.secret ? "（密钥，加密保存）" : ""}
								</Label>
								<Input id={`in-${i.name}`} type={i.secret ? "password" : "text"} disabled={perUser && i.secret} autoComplete="off" value={values[i.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))} placeholder={i.description} data-testid={`input-${i.name}`} />
							</div>
						))}
						{err ? <p className="text-danger">{err}</p> : null}
						<div className="flex justify-end">
							<Button
								variant="primary"
								disabled={busy || secretsMissing}
								data-testid="mcp-install-confirm"
								onClick={() =>
									run(async () => {
										const secrets: Record<string, string> = {};
										const variables: Record<string, string> = {};
										for (const i of option.inputs) if (values[i.name]) (i.secret || i.where === "header" ? secrets : variables)[i.name] = values[i.name]!;
										const r = await post<{ connector: { status: string; market?: { approvalState: string } } }>(`/market/mcp/${entry.id}/install`, { target, optionIndex: option.index, name: name || undefined, secrets, variables, credentialMode: target === "org" ? cred : undefined });
										setResult({ status: r.connector.status, approval: r.connector.market?.approvalState ?? "approved" });
										onDone();
									})
								}
							>
								安装
							</Button>
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
