// 运行环境 (admin, sandbox.policy.manage): where workspace code runs — org default, per-provider cards, connection tests, instances.
// The API key is write-only: it is never read back, only "已保存 ••••1234" is shown. Nothing falls back silently.
import { CheckCircle2, KeyRound, Server, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { CapabilitySupport, SandboxInstanceDTO, SandboxProviderConfigDTO, SandboxProviderId, SandboxProviderTestDTO, SandboxProviderUpdate, SandboxProvidersAdminDTO, SandboxSelectionPolicyDTO } from "@shared/sandbox";
import { errorText, post, put } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge, EmptyState, Loadable, Spinner } from "@/components/ui/misc";
import { Fold, Row, SectionHead, Table, useAct } from "./common";

export const PROVIDER_NAME: Record<"local" | SandboxProviderId, string> = { local: "本机沙箱", opensandbox: "OpenSandbox", e2b: "E2B", daytona: "Daytona" };

const CAPS: { key: keyof SandboxProviderConfigDTO["capabilities"]; label: string }[] = [
	{ key: "exec", label: "运行命令" },
	{ key: "streamOutput", label: "实时输出" },
	{ key: "cancel", label: "中途停止" },
	{ key: "commandTimeout", label: "命令超时" },
	{ key: "files", label: "文件读写" },
	{ key: "networkOff", label: "禁止联网" },
	{ key: "networkOn", label: "允许联网" },
	{ key: "resourceLimits", label: "资源限制" },
	{ key: "reconnect", label: "断线重连" },
	{ key: "services", label: "后台服务" },
	{ key: "pty", label: "交互终端" },
	{ key: "preview", label: "网页预览" },
	{ key: "snapshot", label: "快照" },
	{ key: "pauseResume", label: "暂停与恢复" },
];
const SUPPORT: Record<CapabilitySupport, { text: string; tone: "success" | "warning" | "neutral" }> = {
	supported: { text: "支持", tone: "success" },
	unverified: { text: "已实现，未联调", tone: "warning" },
	unsupported: { text: "不支持", tone: "neutral" },
};
const LOCATION: Record<SandboxProviderConfigDTO["capabilities"]["location"], { text: string; tone: "success" | "warning" | "info" }> = {
	self_hosted: { text: "自托管", tone: "success" },
	vendor_cloud: { text: "厂商云：数据会离开组织", tone: "warning" },
	configurable: { text: "自托管或厂商云，取决于地址", tone: "info" },
};
const STATE: Record<SandboxInstanceDTO["state"], string> = { creating: "创建中", ready: "可用", stopping: "停止中", destroyed: "已销毁", lost: "已丢失", error: "出错" };

const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`);

export function SandboxProviders() {
	const res = useApi<SandboxProvidersAdminDTO>("/sandbox/providers");
	const inst = useApi<{ instances: SandboxInstanceDTO[] }>("/sandbox/instances");
	return (
		<Loadable state={res} what="运行环境">
			{res.data ? (
				<div className="space-y-6" data-testid="sandbox-admin">
					{!res.data.secretStorage ? (
						<p data-testid="secret-missing" role="status" className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
							服务器未配置密钥存储（WORKROOM_SECRET_KEY）：现在无法保存访问密钥。请服务器管理员配置后重启。
						</p>
					) : null}
					<Location data={res.data} reload={res.reload} />
					<section aria-label="执行位置服务" className="space-y-3">
						{res.data.providers.map((p) => (
							<ProviderCard key={p.provider} p={p} secretStorage={res.data!.secretStorage} isDefault={res.data!.policy.orgDefault === p.provider} reload={res.reload} />
						))}
					</section>
					<Instances inst={inst} />
				</div>
			) : null}
		</Loadable>
	);
}

function Location({ data, reload }: { data: SandboxProvidersAdminDTO; reload: () => void }) {
	const { busy, run, note } = useAct(reload);
	const { policy, providers } = data;
	const def = providers.find((p) => p.provider === policy.orgDefault);
	const save = (patch: Partial<SandboxSelectionPolicyDTO>) => run(() => put("/sandbox/provider-policy", { ...policy, ...patch }), "已保存");
	return (
		<section data-testid="sandbox-location" className="rounded-xl border border-border bg-surface p-4">
			<SectionHead title="执行位置" />
			<p className="mb-3 text-xs text-fg-muted">工作区里的代码在哪里运行。个人空间始终使用这里的默认位置。</p>
			<div className="flex flex-wrap items-end gap-4">
				<div>
					<Label htmlFor="org-default">组织默认</Label>
					<Select id="org-default" data-testid="org-default" value={policy.orgDefault} disabled={busy} onChange={(e) => void save({ orgDefault: e.target.value as SandboxSelectionPolicyDTO["orgDefault"] })} className="w-56">
						<option value="local">本机沙箱</option>
						{providers.map((p) => (
							<option key={p.provider} value={p.provider} disabled={!p.enabled}>
								{PROVIDER_NAME[p.provider]}
								{p.enabled ? "" : "（未启用）"}
							</option>
						))}
					</Select>
				</div>
				<label className="flex h-9 items-center gap-2 text-sm">
					<input type="checkbox" role="switch" data-testid="allow-override" checked={policy.allowProjectOverride} disabled={busy} onChange={(e) => void save({ allowProjectOverride: e.target.checked })} className="size-4 accent-[var(--accent)]" />
					允许项目单独选择
				</label>
			</div>
			{note}
			{def && (!def.lastTest || !def.lastTest.ok) ? (
				<p data-testid="default-unhealthy" role="alert" className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
					{def.lastTest ? `默认位置「${PROVIDER_NAME[def.provider]}」最近一次测试失败：${def.lastTest.detail}。` : `默认位置「${PROVIDER_NAME[def.provider]}」还没有测试过连接。`}
					失败时不会自动改用本机沙箱，工作区运行会直接报错。
				</p>
			) : null}
		</section>
	);
}

interface Draft {
	enabled: boolean;
	endpoint: string;
	domain: string;
	template: string;
	allowPrivateNetwork: boolean;
	egressAcknowledged: boolean;
	createTimeoutSec: string;
	idleMin: string;
	lifetimeHours: string;
	apiKey: string;
	clearKey: boolean;
}
const toDraft = (p: SandboxProviderConfigDTO): Draft => ({
	enabled: p.enabled,
	endpoint: p.endpoint ?? "",
	domain: p.domain ?? "",
	template: p.template ?? "",
	allowPrivateNetwork: p.allowPrivateNetwork,
	egressAcknowledged: p.egressAcknowledged,
	createTimeoutSec: String(p.createTimeoutSec),
	idleMin: String(+(p.idleTimeoutSec / 60).toFixed(2)),
	lifetimeHours: String(+(p.lifetimeSec / 3600).toFixed(2)),
	apiKey: "",
	clearKey: false,
});

function ProviderCard({ p, secretStorage, isDefault, reload }: { p: SandboxProviderConfigDTO; secretStorage: boolean; isDefault: boolean; reload: () => void }) {
	const [d, setD] = useState<Draft>(() => toDraft(p));
	const [replacing, setReplacing] = useState(false);
	const [test, setTest] = useState<SandboxProviderTestDTO | undefined>(p.lastTest);
	const [testing, setTesting] = useState<"health" | "roundtrip">();
	const [testErr, setTestErr] = useState<string>();
	const { busy, run, note } = useAct(reload);
	useEffect(() => {
		setD(toDraft(p));
		setReplacing(false);
		setTest(p.lastTest);
	}, [p]);
	const base = toDraft(p);
	const dirty = JSON.stringify(d) !== JSON.stringify(base);
	const loc = p.capabilities.location;
	// Vendor clouds always; a self-hosted service only counts as inside the organisation when it is an allowed private address.
	const needsEgress = loc !== "self_hosted" || !d.allowPrivateNetwork;
	const id = (s: string) => `${p.provider}-${s}`;
	const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
	const missingAck = d.enabled && needsEgress && !d.egressAcknowledged;

	const save = () => {
		const body: SandboxProviderUpdate = {
			enabled: d.enabled,
			endpoint: d.endpoint.trim(),
			...(p.provider === "e2b" ? { domain: d.domain.trim() } : {}),
			template: d.template.trim(),
			allowPrivateNetwork: d.allowPrivateNetwork,
			egressAcknowledged: d.egressAcknowledged,
			createTimeoutSec: Math.round(Number(d.createTimeoutSec)),
			idleTimeoutSec: Math.round(Number(d.idleMin) * 60),
			lifetimeSec: Math.round(Number(d.lifetimeHours) * 3600),
			...(d.clearKey ? { apiKey: null } : d.apiKey ? { apiKey: d.apiKey } : {}),
		};
		void run(() => put(`/sandbox/providers/${p.provider}`, body as unknown as Record<string, unknown>), "已保存");
	};
	const runTest = async (kind: "health" | "roundtrip") => {
		setTesting(kind);
		setTestErr(undefined);
		try {
			setTest((await post<{ test: SandboxProviderTestDTO }>(`/sandbox/providers/${p.provider}/test`, { kind })).test);
			reload();
		} catch (e) {
			setTestErr(errorText(e));
		} finally {
			setTesting(undefined);
		}
	};
	const keyDisabled = !secretStorage;

	return (
		<article data-testid={`provider-${p.provider}`} className="rounded-xl border border-border bg-surface p-4">
			<header className="flex flex-wrap items-center gap-2">
				<Server aria-hidden className="size-4 text-fg-muted" />
				<h3 className="text-sm font-medium">{PROVIDER_NAME[p.provider]}</h3>
				<Badge tone={LOCATION[loc].tone} data-testid={`loc-${p.provider}`}>{LOCATION[loc].text}</Badge>
				{isDefault ? <Badge tone="info">组织默认</Badge> : null}
				<span className="flex-1" />
				<label className="flex items-center gap-2 text-sm">
					<input type="checkbox" role="switch" data-testid={id("enabled")} checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} className="size-4 accent-[var(--accent)]" />
					启用
				</label>
			</header>
			<div className="mt-3 grid gap-3 sm:grid-cols-2">
				<div>
					<Label htmlFor={id("endpoint")}>地址</Label>
					<Input id={id("endpoint")} data-testid={id("endpoint")} value={d.endpoint} onChange={(e) => set({ endpoint: e.target.value })} placeholder="https://" autoComplete="off" />
				</div>
				{p.provider === "e2b" ? (
					<div>
						<Label htmlFor={id("domain")}>域名（E2B 兼容服务）</Label>
						<Input id={id("domain")} data-testid={id("domain")} value={d.domain} onChange={(e) => set({ domain: e.target.value })} autoComplete="off" />
					</div>
				) : null}
				<div>
					<Label htmlFor={id("template")}>模板 / 镜像</Label>
					<Input id={id("template")} data-testid={id("template")} value={d.template} onChange={(e) => set({ template: e.target.value })} autoComplete="off" />
				</div>
				<div>
					<Label htmlFor={id("apikey")}>访问密钥</Label>
					{p.apiKeySet && !replacing && !d.clearKey ? (
						<div className="flex items-center gap-2">
							<span data-testid={id("key-saved")} className="inline-flex h-9 flex-1 items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 text-sm text-fg-muted">
								<KeyRound aria-hidden className="size-4" />
								已保存 ••••{p.apiKeyHint ?? ""}
							</span>
							<Button size="sm" disabled={keyDisabled} onClick={() => setReplacing(true)} data-testid={id("key-replace")}>更换</Button>
							<Button size="sm" disabled={keyDisabled} onClick={() => set({ clearKey: true })} data-testid={id("key-clear")}>清除</Button>
						</div>
					) : d.clearKey ? (
						<div className="flex items-center gap-2 text-sm text-fg-muted">
							<span className="flex-1">保存后将清除已存的密钥</span>
							<Button size="sm" onClick={() => set({ clearKey: false })}>撤销</Button>
						</div>
					) : (
						<div className="flex items-center gap-2">
							<Input id={id("apikey")} data-testid={id("apikey")} type="password" value={d.apiKey} onChange={(e) => set({ apiKey: e.target.value })} disabled={keyDisabled} placeholder={keyDisabled ? "服务器未配置密钥存储" : "粘贴新密钥，保存后不再显示"} autoComplete="off" />
							{replacing ? <Button size="sm" onClick={() => { setReplacing(false); set({ apiKey: "" }); }}>取消</Button> : null}
						</div>
					)}
					{keyDisabled ? <p className="mt-1 text-xs text-fg-muted">服务器未配置密钥存储（WORKROOM_SECRET_KEY），无法保存密钥。</p> : null}
				</div>
			</div>
			<div className="mt-3 space-y-2">
				<label className="flex items-start gap-2 text-sm">
					<input type="checkbox" data-testid={id("private")} checked={d.allowPrivateNetwork} onChange={(e) => set({ allowPrivateNetwork: e.target.checked })} className="mt-0.5 size-4 accent-[var(--accent)]" />
					允许内网地址（需服务器管理员已放行）
				</label>
				{needsEgress ? (
					<label className="flex items-start gap-2 text-sm">
						<input type="checkbox" data-testid={id("egress")} checked={d.egressAcknowledged} onChange={(e) => set({ egressAcknowledged: e.target.checked })} className="mt-0.5 size-4 accent-[var(--accent)]" />
						<span>我确认：工作区里的文件和命令会发送到该服务商的云端，不再留在本组织内。启用前必须确认。</span>
					</label>
				) : null}
			</div>
			<div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
				<div>
					<Label htmlFor={id("ct")}>创建超时（秒）</Label>
					<Input id={id("ct")} data-testid={id("create-timeout")} type="number" min={1} value={d.createTimeoutSec} onChange={(e) => set({ createTimeoutSec: e.target.value })} />
				</div>
				<div>
					<Label htmlFor={id("idle")}>空闲回收（分钟）</Label>
					<Input id={id("idle")} data-testid={id("idle-timeout")} type="number" min={1} value={d.idleMin} onChange={(e) => set({ idleMin: e.target.value })} />
				</div>
				<div>
					<Label htmlFor={id("life")}>最长存活（小时）</Label>
					<Input id={id("life")} data-testid={id("lifetime")} type="number" min={0.1} step="any" value={d.lifetimeHours} onChange={(e) => set({ lifetimeHours: e.target.value })} />
				</div>
			</div>
			{missingAck ? <p data-testid={id("need-egress")} role="alert" className="mt-3 text-sm text-danger">启用前需要先勾选上面的数据外发确认。</p> : null}
			{note}
			<div className="mt-3 flex flex-wrap items-center gap-2">
				<Button variant="primary" size="sm" disabled={busy || !dirty || missingAck} onClick={save} data-testid={id("save")}>
					保存
				</Button>
				{dirty ? <Button size="sm" onClick={() => { setD(base); setReplacing(false); }}>放弃修改</Button> : null}
				<span className="flex-1" />
				<span className="text-xs text-fg-subtle" data-testid={id("sdk")}>
					SDK：{p.sdk.name} {p.sdk.version ?? "未安装"}
				</span>
			</div>
			<div className="mt-4 border-t border-border pt-3" data-testid={id("test")}>
				<div className="flex flex-wrap items-center gap-2">
					<Button size="sm" disabled={!!testing || dirty} onClick={() => void runTest("health")} data-testid={id("test-health")}>
						{testing === "health" ? <Spinner /> : null}连通性
					</Button>
					<Button size="sm" disabled={!!testing || dirty} onClick={() => void runTest("roundtrip")} data-testid={id("test-roundtrip")}>
						{testing === "roundtrip" ? <Spinner /> : null}完整测试
					</Button>
					<span className="text-xs text-fg-muted">{dirty ? "有未保存的修改，先保存再测试。" : "完整测试会临时创建一个沙箱，只使用合成数据，结束后立即销毁。"}</span>
				</div>
				{testErr ? <p role="alert" data-testid={id("test-error")} className="mt-2 rounded-lg bg-danger-soft px-3 py-1.5 text-sm text-danger">{testErr}</p> : null}
				{test ? <TestResult t={test} id={id("test-result")} /> : <p className="mt-2 text-xs text-fg-subtle">还没有测试过。</p>}
			</div>
			<div className="mt-3">
				<Fold title="能力" testId={id("caps")} hint={p.capabilities.isolation}>
					<p className="mb-2 text-sm text-fg-muted" data-testid={id("isolation")}>隔离方式：{p.capabilities.isolation}</p>
					<table className="w-full text-sm">
						<tbody>
							{CAPS.map((c) => {
								const s = SUPPORT[p.capabilities[c.key] as CapabilitySupport];
								return (
									<tr key={c.key} className="border-t border-border first:border-t-0">
										<th scope="row" className="py-1.5 pr-3 text-left font-normal text-fg-muted">{c.label}</th>
										<td className="py-1.5 text-right"><Badge tone={s.tone}>{s.text}</Badge></td>
									</tr>
								);
							})}
							<tr className="border-t border-border">
								<th scope="row" className="py-1.5 pr-3 text-left font-normal text-fg-muted">技能文件</th>
								<td className="py-1.5 text-right"><Badge tone={p.capabilities.skills === "upload_readonly" ? "success" : "neutral"}>{p.capabilities.skills === "upload_readonly" ? "上传为只读" : "不支持"}</Badge></td>
							</tr>
						</tbody>
					</table>
				</Fold>
			</div>
		</article>
	);
}

function TestResult({ t, id }: { t: SandboxProviderTestDTO; id: string }) {
	return (
		<div data-testid={id} data-ok={t.ok} className="mt-2 text-sm">
			<div className="flex flex-wrap items-center gap-2">
				{t.ok ? <CheckCircle2 aria-hidden className="size-4 text-success" /> : <XCircle aria-hidden className="size-4 text-danger" />}
				<span className={t.ok ? "text-success" : "text-danger"}>{t.ok ? "成功" : "失败"}</span>
				<span className="text-fg-muted">{t.kind === "roundtrip" ? "完整测试" : "连通性"} · {fmtTime(t.at)} · 用时 {fmtMs(t.durationMs)}{t.version ? ` · 版本 ${t.version}` : ""}</span>
			</div>
			<p className="mt-1 break-words text-fg-muted">{t.detail}</p>
			{t.steps?.length ? (
				<ul className="mt-1 space-y-0.5 text-xs">
					{t.steps.map((s) => (
						<li key={s.step} className="flex flex-wrap gap-2">
							<span className={s.ok ? "text-success" : "text-danger"}>{s.ok ? "通过" : "失败"}</span>
							<span>{s.step}</span>
							<span className="text-fg-subtle">{fmtMs(s.ms)}</span>
							{s.detail ? <span className="break-words text-fg-muted">{s.detail}</span> : null}
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

function Instances({ inst }: { inst: ReturnType<typeof useApi<{ instances: SandboxInstanceDTO[] }>> }) {
	const rows = inst.data?.instances ?? [];
	return (
		<section data-testid="sandbox-instances">
			<SectionHead title="运行中的远程沙箱" />
			<Loadable state={inst} what="沙箱列表">
				{rows.length === 0 ? (
					<div className="rounded-xl border border-border bg-surface">
						<EmptyState title="还没有远程沙箱">有工作区在远程位置运行代码后，会在这里列出。</EmptyState>
					</div>
				) : (
					<Table>
						{rows.map((r) => (
							<Row key={r.id}>
								<span className="w-24 font-medium">{PROVIDER_NAME[r.provider]}</span>
								<span className="min-w-0 flex-1 truncate text-fg-muted" title={r.spaceId}>空间 {r.spaceId}</span>
								<Badge tone={r.state === "ready" ? "success" : r.state === "error" || r.state === "lost" ? "danger" : "neutral"}>{STATE[r.state]}</Badge>
								<span className="text-xs text-fg-muted">最近使用 {fmtTime(r.lastUsedAt)}</span>
								{r.lastError ? <span className="w-full break-words text-xs text-danger">{r.lastError}</span> : null}
							</Row>
						))}
					</Table>
				)}
			</Loadable>
		</section>
	);
}
