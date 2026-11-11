// 我的连接: connector cards (status, re-check, per-user enablement, reconnect with new credentials) plus the marketplace additions:
// approval state of personal connectors, sandbox execution, my own credentials (names only), per-tool allow / confirm / off.
import { Plug, RefreshCw, ShieldAlert } from "lucide-react";
import { useState } from "react";
import type { ConnectorDTO, ConnectorListResponse, ConnectorStatus } from "@shared/files";
import { patch, post, put } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { fullTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge, Blocked, EmptyState, Loadable } from "@/components/ui/misc";
import { useAct } from "./common";

const CSTATUS: Record<ConnectorStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
	ready: { label: "可用", tone: "success" },
	needs_reconnect: { label: "需要重新连接", tone: "warning" },
	unauthorized: { label: "凭据被拒绝", tone: "danger" },
	error: { label: "连接出错", tone: "danger" },
	unchecked: { label: "尚未检查", tone: "neutral" },
	disabled: { label: "已停用", tone: "neutral" },
};

export function Connectors() {
	const conns = useApi<ConnectorListResponse>("/connectors");
	return (
		<Loadable state={conns} what="连接">
			{conns.data ? (
				<div className="space-y-2" data-testid="connectors">
					{conns.data.secretStorage === "unavailable" ? <Blocked title="密钥存储不可用">需要密钥的连接无法保存。</Blocked> : null}
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
	);
}

function ConnectorCard({ c, onChanged }: { c: ConnectorDTO; onChanged: () => void }) {
	const { busy, err, run } = useAct(onChanged);
	const [secrets, setSecrets] = useState<Record<string, string>>({});
	const [mine, setMine] = useState<Record<string, string>>({});
	const st = CSTATUS[c.status];
	const m = c.market;
	const pending = m?.approvalState === "pending";
	const rejected = m?.approvalState === "rejected";
	const needMine = m?.credentialMode === "per_user" && m.requiredSecretNames.some((n) => !m.mySecretNames.includes(n));
	return (
		<div data-testid="connector" data-approval={m?.approvalState} className="rounded-xl border border-border bg-surface p-3">
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-medium">{c.name}</span>
				<Badge>{c.scope === "system" ? "系统" : "个人"}</Badge>
				{m?.execMode === "sandbox" ? <Badge title="stdio 服务器在沙箱中运行，不在宿主机上">沙箱运行</Badge> : null}
				{m?.credentialMode === "per_user" ? <Badge title="每位用户使用自己的凭据">每人凭据</Badge> : null}
				{pending ? (
					<Badge tone="warning">
						<ShieldAlert /> 等待审核
					</Badge>
				) : null}
				{rejected ? <Badge tone="danger">未通过审核</Badge> : null}
				<span className="flex-1" />
				{c.access === "forbidden" ? <Badge tone="danger">无权限{c.accessReason ? `：${c.accessReason}` : ""}</Badge> : null}
				<Badge tone={st.tone}>{st.label}</Badge>
				{c.access === "allowed" ? (
					<>
						<span className="flex items-center gap-2 text-xs text-fg-muted">
							<Switch aria-label={`${c.name} 我的任务可用`} data-testid="connector-enable" checked={c.enabledForMe} busy={busy} onCheckedChange={(v) => run(() => put(`/connectors/${c.id}/enablement`, { enabled: v }))} />
							我的任务可用
						</span>
						<Button size="sm" disabled={busy || pending || rejected} data-testid="connector-reconnect" onClick={() => run(() => post(`/connectors/${c.id}/reconnect`))}>
							<RefreshCw />
							{c.status === "needs_reconnect" || c.status === "error" || c.status === "unauthorized" ? "重新连接" : "检查"}
						</Button>
					</>
				) : null}
			</div>
			{pending ? <p className="mt-1 text-xs text-warning">组织策略要求审核：审核员批准前不会向该地址发送任何请求，模型也看不到它的工具。</p> : null}
			{c.statusDetail && !pending ? <p className="mt-1 text-xs text-fg-muted">{c.statusDetail}</p> : null}
			{c.access === "allowed" && c.canManage && c.secretNames.length && m?.credentialMode !== "per_user" && (c.status === "unauthorized" || c.status === "needs_reconnect") ? (
				<form
					className="mt-2 flex flex-wrap items-center gap-2"
					data-testid="connector-secrets"
					onSubmit={(e) => {
						e.preventDefault();
						void run(() => post(`/connectors/${c.id}/reconnect`, { secrets }));
					}}
				>
					{c.secretNames.map((n) => (
						<Input key={n} type="password" value={secrets[n] ?? ""} onChange={(e) => setSecrets((x) => ({ ...x, [n]: e.target.value }))} placeholder={`新的 ${n}`} className="h-8 w-56 text-xs" aria-label={n} />
					))}
					<Button size="sm" type="submit" disabled={busy}>
						更新凭据并重连
					</Button>
				</form>
			) : null}
			{c.access === "allowed" && m?.credentialMode === "per_user" ? (
				<form
					className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-3 py-2"
					data-testid="my-secrets"
					onSubmit={(e) => {
						e.preventDefault();
						void run(() => put(`/connectors/${c.id}/my-secrets`, { secrets: mine }).then(() => setMine({})));
					}}
				>
					<span className="text-xs text-fg-muted">我的凭据：{m.mySecretNames.length ? `已保存 ${m.mySecretNames.join("、")}（只显示名称）` : needMine ? "尚未填写，填写后才能使用" : "无"}</span>
					{m.requiredSecretNames.map((n) => (
						<Input key={n} type="password" autoComplete="off" value={mine[n] ?? ""} onChange={(e) => setMine((x) => ({ ...x, [n]: e.target.value }))} placeholder={n} className="h-8 w-52 text-xs" aria-label={`我的 ${n}`} />
					))}
					<Button size="sm" type="submit" disabled={busy || m.requiredSecretNames.some((n) => !mine[n])} data-testid="my-secrets-save">
						保存我的凭据
					</Button>
				</form>
			) : null}
			{c.lastCheckedAt ? <p className="mt-0.5 text-xs text-fg-subtle">上次检查 {fullTime(c.lastCheckedAt)}</p> : null}
			{c.tools.length ? (
				<ul className="mt-2 flex flex-wrap gap-1.5" data-testid="connector-tools">
					{c.tools.map((t) => (
						<li key={t.name} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2/50 py-0.5 pl-2 pr-1 text-xs" data-tool={t.tool} data-disabled={!!t.disabled}>
							<span className={t.disabled ? "text-fg-subtle line-through" : ""}>{t.tool}</span>
							{t.policy === "write" ? <span className="text-fg-subtle">（写操作，需确认）</span> : null}
							{c.access === "allowed" ? (
								<>
									<Select
										aria-label={`我对 ${t.tool} 的设置`}
										className="h-6 px-2 text-xs"
										value={t.userOverride ?? "default"}
										disabled={busy}
										onChange={(e) => run(() => put(`/connectors/${c.id}/my-tools`, { overrides: { [t.tool]: e.target.value === "default" ? null : e.target.value } }))}
									>
										<option value="default">默认</option>
										<option value="ask">每次确认</option>
										<option value="disabled">对我关闭</option>
									</Select>
									{c.canManage ? (
										<Select
											aria-label={`管理员对 ${t.tool} 的策略`}
											className="h-6 px-2 text-xs"
											value={t.disabled && !t.userOverride ? "disabled" : t.policy}
											disabled={busy}
											onChange={(e) => run(() => patch(`/connectors/${c.id}`, { toolPolicies: { ...Object.fromEntries(c.tools.filter((x) => x.disabled && !x.userOverride).map((x) => [x.tool, "disabled"])), [t.tool]: e.target.value } }))}
										>
											<option value="read">允许</option>
											<option value="write">需确认</option>
											<option value="disabled">全员关闭</option>
										</Select>
									) : null}
								</>
							) : null}
						</li>
					))}
				</ul>
			) : null}
			{err ? <p className="mt-1 text-xs text-danger">{err}</p> : null}
		</div>
	);
}
