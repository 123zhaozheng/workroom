// 沙箱 (admin, sandbox.policy.manage): where workspace code runs. ONE channel is active for the whole organisation: a cloud provider, or
// 平台内置沙箱 (the server's own driver). Per-provider cards hold the connection settings; connection tests; instances.
// The access key is write-only: it is never read back, only "已保存 ••••1234" is shown. Nothing falls back silently.
import { CheckCircle2, KeyRound, Server, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { CapabilitySupport, SandboxDriverAdminDTO, SandboxInstanceDTO, SandboxProviderConfigDTO, SandboxProviderId, SandboxProviderTestDTO, SandboxProviderUpdate, SandboxProvidersAdminDTO } from "@shared/sandbox";
import { errorText, post, put } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge, EmptyState, Loadable, Spinner } from "@/components/ui/misc";
import { Fold, Row, SectionHead, Table, useAct } from "./common";
import { PrewarmSettings } from "./PrewarmSettings";

export const PROVIDER_NAME: Record<"local" | SandboxProviderId, string> = { local: "平台内置沙箱", opensandbox: "OpenSandbox", e2b: "E2B", daytona: "Daytona" };

const CAPS: { key: keyof SandboxProviderConfigDTO["capabilities"]; label: string }[] = [
	{ key: "exec", label: "运行命令" },
	{ key: "streamOutput", label: "实时输出" },
	{ key: "cancel", label: "中途停止" },
	{ key: "commandTimeout", label: "命令超时" },
	{ key: "files", label: "文件读写" },
	{ key: "networkOn", label: "出站网络（由提供方决定）" },
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
	unverified: { text: "未验证", tone: "warning" },
	unsupported: { text: "不支持", tone: "neutral" },
};
const LOCATION: Record<SandboxProviderConfigDTO["capabilities"]["location"], { text: string; tone: "success" | "warning" | "info" }> = {
	self_hosted: { text: "自托管", tone: "success" },
	vendor_cloud: { text: "厂商云：数据会离开组织", tone: "warning" },
	configurable: { text: "自托管或厂商云，取决于地址", tone: "info" },
};
const STATE: Record<SandboxInstanceDTO["state"], string> = { creating: "创建中", ready: "可用", pausing: "暂停中", paused: "已暂停", resuming: "恢复中", archived: "已归档", stopping: "停止中", destroyed: "已销毁", lost: "已丢失", error: "出错" };

const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`);

export function SandboxProviders() {
	const res = useApi<SandboxProvidersAdminDTO>("/sandbox/providers");
	const inst = useApi<{ instances: SandboxInstanceDTO[] }>("/sandbox/instances");
	return (
		<Loadable state={res} what="沙箱设置">
			{res.data ? (
				<div className="space-y-6" data-testid="sandbox-admin">
					{!res.data.secretStorage ? (
						<p data-testid="secret-missing" role="status" className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
							未配置密钥存储，无法保存访问密钥（需设置 WORKROOM_SECRET_KEY）。
						</p>
					) : null}
					<Channel data={res.data} reload={res.reload} />
					{res.data.policy.orgDefault !== "local" ? <PrewarmSettings /> : null}
					<section aria-label="渠道设置" className="space-y-3">
						<SectionHead title="渠道设置" />
						{res.data.providers.map((p) => (
							<ProviderCard key={p.provider} p={p} secretStorage={res.data!.secretStorage} reload={res.reload} />
						))}
					</section>
					<Instances inst={inst} />
				</div>
			) : null}
		</Loadable>
	);
}

/** 当前使用的沙箱渠道: the single choice. Server-enforced: choosing one deactivates the others. */
function Channel({ data, reload }: { data: SandboxProvidersAdminDTO; reload: () => void }) {
	const drv = useApi<SandboxDriverAdminDTO>("/sandbox/driver");
	const { busy, run, note } = useAct(() => {
		reload();
		drv.reload();
	});
	const { policy, providers } = data;
	const active = policy.orgDefault;
	const def = providers.find((p) => p.provider === active);
	const d = drv.data;
	const choose = (v: "local" | SandboxProviderId) =>
		run(() => (v === "local" ? put("/sandbox/provider-policy", { orgDefault: "local" }) : put(`/sandbox/providers/${v}`, { enabled: true })));
	const radio = "mt-0.5 size-4 shrink-0 accent-[var(--accent)]";
	const row = (on: boolean) => `flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm ${on ? "border-accent" : "border-border"}`;
	return (
		<section data-testid="sandbox-channel" className="rounded-xl border border-border bg-surface p-4">
			<fieldset disabled={busy} className="min-w-0">
				<legend className="mb-2 text-sm font-medium">当前使用的沙箱渠道</legend>
				<div className="space-y-2" role="radiogroup" aria-label="当前使用的沙箱渠道">
					<label data-testid="channel-local" data-active={active === "local"} className={row(active === "local")}>
						<input type="radio" name="sandbox-channel" value="local" checked={active === "local"} onChange={() => void choose("local")} className={radio} />
						<span className="min-w-0 flex-1">
							<span className="block font-medium">{PROVIDER_NAME.local}</span>
							{d?.effective === "none" ? <span className="block text-xs text-fg-muted">当前不可用</span> : null}
						</span>
					</label>
					{providers.map((p) => {
						const on = active === p.provider;
						return (
							<label key={p.provider} data-testid={`channel-${p.provider}`} data-active={on} className={`${row(on)} ${!p.apiKeySet && !on ? "opacity-70" : ""}`}>
								<input type="radio" name="sandbox-channel" value={p.provider} checked={on} disabled={!p.apiKeySet && !on} onChange={() => void choose(p.provider)} className={radio} />
								<span className="min-w-0 flex-1">
									<span className="block font-medium">{PROVIDER_NAME[p.provider]}</span>
									<span className="block text-xs text-fg-muted">
										{LOCATION[p.capabilities.location].text}{p.apiKeySet ? "" : " · 未配置密钥"}
									</span>
								</span>
							</label>
						);
					})}
				</div>
			</fieldset>
			{note}
			{active === "local" && d?.effective === "none" ? (
				<p data-testid="local-unavailable" role="alert" className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
					平台内置沙箱不可用：{d.reason}
				</p>
			) : null}
			{def && !def.enabled ? (
				<p data-testid="channel-inactive" role="alert" className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
					当前渠道「{PROVIDER_NAME[def.provider]}」没有启用。
					<Button size="sm" className="ml-2" disabled={busy} onClick={() => void choose(def.provider)} data-testid="channel-reactivate">启用它</Button>
				</p>
			) : def && (!def.lastTest || !def.lastTest.ok) ? (
				<p data-testid="default-unhealthy" role="alert" className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
					{def.lastTest ? `当前渠道「${PROVIDER_NAME[def.provider]}」最近一次测试失败：${def.lastTest.detail}。` : `当前渠道「${PROVIDER_NAME[def.provider]}」还没有测试过连接。`}
					不会自动改用平台内置沙箱。
				</p>
			) : null}
		</section>
	);
}

interface Draft {
	endpoint: string;
	domain: string;
	template: string;
	/** Daytona: "snapshot" (snapshot / Daytona default size) or "image" (image-based; explicit size allowed). */
	mode: "snapshot" | "image";
	image: string;
	cpus: string;
	memoryGb: string;
	diskGb: string;
	/** Working directory inside the sandbox ("" = the provider default shown as placeholder). */
	workDir: string;
	allowPrivateNetwork: boolean;
	egressAcknowledged: boolean;
	createTimeoutSec: string;
	idlePauseMin: string;
	retentionHours: string;
	destroyDays: string;
	apiKey: string;
	clearKey: boolean;
}
const toDraft = (p: SandboxProviderConfigDTO): Draft => ({
	endpoint: p.endpoint ?? "",
	domain: p.domain ?? "",
	template: p.template ?? "",
	mode: p.image ? "image" : "snapshot",
	image: p.image ?? "",
	cpus: p.resources?.cpus !== undefined ? String(p.resources.cpus) : "",
	memoryGb: p.resources?.memoryGb !== undefined ? String(p.resources.memoryGb) : "",
	diskGb: p.resources?.diskGb !== undefined ? String(p.resources.diskGb) : "",
	workDir: p.workDir ?? "",
	allowPrivateNetwork: p.allowPrivateNetwork,
	egressAcknowledged: p.egressAcknowledged,
	createTimeoutSec: String(p.createTimeoutSec),
	idlePauseMin: String(+(p.idlePauseSec / 60).toFixed(2)),
	retentionHours: String(+(p.pausedRetentionSec / 3600).toFixed(2)),
	destroyDays: String(+(p.destroyAfterSec / 86400).toFixed(2)),
	apiKey: "",
	clearKey: false,
});

/** Explicit resources from the form; empty fields = provider default. null when nothing is set (clears). */
function resourcesOf(d: Draft, disk: boolean): { cpus?: number; memoryGb?: number; diskGb?: number } | null {
	const n = (v: string) => (v.trim() === "" ? undefined : Number(v));
	const out: { cpus?: number; memoryGb?: number; diskGb?: number } = {};
	const c = n(d.cpus);
	const m = n(d.memoryGb);
	const g = disk ? n(d.diskGb) : undefined;
	if (c !== undefined) out.cpus = c;
	if (m !== undefined) out.memoryGb = m;
	if (g !== undefined) out.diskGb = g;
	return Object.keys(out).length ? out : null;
}

function ProviderCard({ p, secretStorage, reload }: { p: SandboxProviderConfigDTO; secretStorage: boolean; reload: () => void }) {
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
	const missingAck = p.enabled && needsEgress && !d.egressAcknowledged;

	const save = () => {
		const body: SandboxProviderUpdate = {
			// No `enabled` here: saving a card never changes which channel is active (that is the 当前使用的沙箱渠道 choice).
			endpoint: d.endpoint.trim(),
			...(p.provider === "e2b" ? { domain: d.domain.trim() } : {}),
			...(p.provider === "daytona"
				? d.mode === "image"
					? { template: "", image: d.image.trim(), resources: resourcesOf(d, true) }
					: { template: d.template.trim(), image: "", resources: null }
				: p.provider === "opensandbox"
					? { template: d.template.trim(), resources: resourcesOf(d, false) }
					: { template: d.template.trim() }),
			workDir: d.workDir.trim() === "" ? null : d.workDir.trim(), // null clears → the provider default
			allowPrivateNetwork: d.allowPrivateNetwork,
			egressAcknowledged: d.egressAcknowledged,
			createTimeoutSec: Math.round(Number(d.createTimeoutSec)),
			idlePauseSec: Math.round(Number(d.idlePauseMin) * 60),
			pausedRetentionSec: Math.round(Number(d.retentionHours) * 3600),
			destroyAfterSec: Math.round(Number(d.destroyDays) * 86400),
			...(d.clearKey ? { apiKey: null } : d.apiKey ? { apiKey: d.apiKey } : {}),
		};
		void run(() => put(`/sandbox/providers/${p.provider}`, body as unknown as Record<string, unknown>));
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
				<span className="flex-1" />
				{p.enabled ? <Badge tone="success" data-testid={id("active")}>当前使用</Badge> : <span data-testid={id("inactive")} className="text-xs text-fg-subtle">未使用</span>}
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
				{p.provider === "daytona" ? (
					<div className="sm:col-span-2">
						<Label htmlFor={id("mode")}>创建方式</Label>
						<Select id={id("mode")} data-testid={id("mode")} value={d.mode} onChange={(e) => set({ mode: e.target.value as Draft["mode"] })}>
							<option value="snapshot">快照 / 默认规格</option>
							<option value="image">镜像（可指定 CPU、内存、磁盘）</option>
						</Select>
					</div>
				) : null}
				{p.provider === "daytona" && d.mode === "image" ? (
					<div>
						<Label htmlFor={id("image")}>镜像</Label>
						<Input id={id("image")} data-testid={id("image")} value={d.image} onChange={(e) => set({ image: e.target.value })} placeholder="例如 python:3.12-slim" autoComplete="off" />
					</div>
				) : (
					<div>
						<Label htmlFor={id("template")}>{p.provider === "daytona" ? "快照（留空用默认）" : "模板 / 镜像"}</Label>
						<Input id={id("template")} data-testid={id("template")} value={d.template} onChange={(e) => set({ template: e.target.value })} autoComplete="off" />
					</div>
				)}
				{p.provider === "opensandbox" || (p.provider === "daytona" && d.mode === "image") ? (
					<div className="grid grid-cols-3 gap-2 sm:col-span-2" data-testid={id("resources")}>
						<div>
							<Label htmlFor={id("cpus")}>CPU（核）</Label>
							<Input id={id("cpus")} data-testid={id("cpus")} inputMode="decimal" value={d.cpus} onChange={(e) => set({ cpus: e.target.value })} placeholder="默认" />
						</div>
						<div>
							<Label htmlFor={id("mem")}>内存（GiB）</Label>
							<Input id={id("mem")} data-testid={id("mem")} inputMode="decimal" value={d.memoryGb} onChange={(e) => set({ memoryGb: e.target.value })} placeholder="默认" />
						</div>
						{p.provider === "daytona" ? (
							<div>
								<Label htmlFor={id("disk")}>磁盘（GiB）</Label>
								<Input id={id("disk")} data-testid={id("disk")} inputMode="decimal" value={d.diskGb} onChange={(e) => set({ diskGb: e.target.value })} placeholder="默认" />
							</div>
						) : null}
					</div>
				) : null}
				<div className="sm:col-span-2">
					<Label htmlFor={id("workdir")}>工作目录</Label>
					<Input id={id("workdir")} data-testid={id("workdir")} value={d.workDir} onChange={(e) => set({ workDir: e.target.value })} placeholder={p.defaultWorkDir ?? "留空使用默认值"} autoComplete="off" spellCheck={false} />
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
							<Input id={id("apikey")} data-testid={id("apikey")} type="password" value={d.apiKey} onChange={(e) => set({ apiKey: e.target.value })} disabled={keyDisabled} placeholder={keyDisabled ? "未配置密钥存储" : "粘贴新密钥，保存后不再显示"} autoComplete="off" />
							{replacing ? <Button size="sm" onClick={() => { setReplacing(false); set({ apiKey: "" }); }}>取消</Button> : null}
						</div>
					)}
					{keyDisabled ? <p className="mt-1 text-xs text-fg-muted">未配置密钥存储，无法保存密钥。</p> : null}
				</div>
			</div>
			<div className="mt-3 space-y-2">
				<div className="flex items-center gap-2 text-sm">
					<Switch data-testid={id("private")} aria-label="允许内网地址" checked={d.allowPrivateNetwork} onCheckedChange={(v) => set({ allowPrivateNetwork: v })} />
					<span>允许内网地址</span>
				</div>
				{needsEgress ? (
					<label className="flex items-start gap-2 text-sm">
						<input type="checkbox" data-testid={id("egress")} checked={d.egressAcknowledged} onChange={(e) => set({ egressAcknowledged: e.target.checked })} className="mt-0.5 size-4 accent-[var(--accent)]" />
						<span>我确认：文件和命令会发送到该服务商云端，不再留在本组织内。</span>
					</label>
				) : null}
			</div>
			<div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-4">
				<div>
					<Label htmlFor={id("ct")}>创建超时（秒）</Label>
					<Input id={id("ct")} data-testid={id("create-timeout")} type="number" min={1} value={d.createTimeoutSec} onChange={(e) => set({ createTimeoutSec: e.target.value })} />
				</div>
				<div>
					<Label htmlFor={id("idle")}>空闲暂停（分钟）</Label>
					<Input id={id("idle")} data-testid={id("idle-pause")} type="number" min={1} step="any" value={d.idlePauseMin} onChange={(e) => set({ idlePauseMin: e.target.value })} />
				</div>
				<div>
					<Label htmlFor={id("ret")}>快速恢复（小时）</Label>
					<Input id={id("ret")} data-testid={id("paused-retention")} type="number" min={0.1} step="any" value={d.retentionHours} onChange={(e) => set({ retentionHours: e.target.value })} />
				</div>
				<div>
					<Label htmlFor={id("destroy")}>未使用销毁（天）</Label>
					<Input id={id("destroy")} data-testid={id("destroy-after")} type="number" min={0.1} step="any" value={d.destroyDays} onChange={(e) => set({ destroyDays: e.target.value })} />
				</div>
			</div>
			{missingAck ? <p data-testid={id("need-egress")} role="alert" className="mt-3 text-sm text-danger">启用前需先确认数据外发。</p> : null}
			{note}
			<div className="mt-3 flex flex-wrap items-center gap-2">
				<Button variant="primary" size="sm" disabled={busy || !dirty || missingAck} onClick={save} data-testid={id("save")}>
					保存
				</Button>
				{dirty ? <Button size="sm" onClick={() => { setD(base); setReplacing(false); }}>放弃修改</Button> : null}
			</div>
			<p data-testid={id("net-note")} className="mt-3 text-sm text-fg-muted">
				联网由提供方决定
			</p>
			<div className="mt-4 border-t border-border pt-3" data-testid={id("test")}>
				<div className="flex flex-wrap items-center gap-2">
					<Button size="sm" disabled={!!testing || dirty} onClick={() => void runTest("health")} data-testid={id("test-health")}>
						{testing === "health" ? <Spinner /> : null}连通性
					</Button>
					<Button size="sm" disabled={!!testing || dirty} onClick={() => void runTest("roundtrip")} data-testid={id("test-roundtrip")}>
						{testing === "roundtrip" ? <Spinner /> : null}完整测试
					</Button>
					{dirty ? <span className="text-xs text-fg-muted">先保存再测试</span> : null}
				</div>
				{testErr ? <p role="alert" data-testid={id("test-error")} className="mt-2 rounded-lg bg-danger-soft px-3 py-1.5 text-sm text-danger">{testErr}</p> : null}
				{test ? <TestResult t={test} id={id("test-result")} /> : null}
			</div>
			<div className="mt-3">
				<Fold title="能力与技术详情" testId={id("caps")}>
					<p className="mb-2 text-sm text-fg-muted" data-testid={id("isolation")}>隔离方式：{p.capabilities.isolation}</p>
					<p className="mb-2 text-xs text-fg-subtle" data-testid={id("sdk")}>
						SDK：{p.sdk.name} {p.sdk.version ?? "未安装"}
					</p>
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
						<EmptyState title="还没有远程沙箱" />
					</div>
				) : (
					<Table>
						{rows.map((r) => (
							<Row key={r.id}>
								<span className="w-24 font-medium">{PROVIDER_NAME[r.provider]}</span>
								<span className="min-w-0 flex-1 truncate text-fg-muted" title={r.spaceId}>工作区</span>
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
