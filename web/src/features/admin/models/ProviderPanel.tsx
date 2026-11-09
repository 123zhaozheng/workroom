// Provider list with health, per-provider actions (test connection, fetch model list, edit, enable, delete) and the model table
// (capability badges, enable/disable, visibility). Used by the admin tab (`/admin/model-providers`) and by the personal-key
// section of Settings (`/me/model-providers`).
import { ChevronDown, ChevronRight, DownloadCloud, KeyRound, Pencil, Plus, Trash2, Wifi } from "lucide-react";
import { useState } from "react";
import type { AdminModelDTO, FetchModelsResponse, ModelProviderDTO, ModelProvidersResponse, ProviderTestResponse } from "@shared/ops";
import { del, errorText, patch, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, Loadable } from "@/components/ui/misc";
import { Row, Table, useAct } from "@/features/admin/common";
import { ModelDialog } from "./ModelDialog";
import { ProviderDialog } from "./ProviderDialog";
import { CapabilityBadges, fmtPrice, fmtTokens, HealthBadge, SCOPE_LABEL, TYPE_SHORT, visibilityText } from "./shared";

export interface PanelProps {
	base: string;
	personal?: boolean;
	/** may create / edit / delete providers and keys (model.provider.manage, or any user for personal) */
	canProviders: boolean;
	/** may enable / disable models, set visibility (model.manage, or any user for personal) */
	canModels: boolean;
	catalog?: Pick<ModelProvidersResponse, "presets" | "builtins">;
	providers: ModelProviderDTO[];
	reload: () => void;
	defaultModelId?: string;
}

export function ProviderPanel(props: PanelProps) {
	const { base, personal, canProviders, providers, reload, catalog } = props;
	const [adding, setAdding] = useState(false);
	return (
		<div className="space-y-3" data-testid={personal ? "personal-providers" : "model-providers"}>
			{canProviders ? (
				<div className="flex justify-end">
					<Button variant="primary" size="sm" onClick={() => setAdding(true)} data-testid="add-provider">
						<Plus />
						{personal ? "添加我的服务商" : "添加服务商"}
					</Button>
				</div>
			) : (
				<p className="text-xs text-fg-subtle">你没有管理服务商和密钥的权限，只能查看。</p>
			)}
			{providers.length === 0 ? (
				<p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-[13px] text-fg-subtle">
					{personal ? "还没有个人服务商。添加后只有你自己能看到和使用。" : "还没有配置任何模型服务商。点击“添加服务商”，选择类型（如 OpenAI 兼容 / Claude 兼容），填 Base URL 与密钥，再“获取模型列表”。"}
				</p>
			) : (
				<Table testId="model-provider-list">
					{providers.map((p) => (
						<ProviderRowView key={p.id} p={p} {...props} />
					))}
				</Table>
			)}
			{adding ? <ProviderDialog open onOpenChange={setAdding} base={base} personal={personal} catalog={catalog} onSaved={reload} /> : null}
		</div>
	);
}

function ProviderRowView({ p, base, personal, canProviders, canModels, catalog, reload, defaultModelId }: PanelProps & { p: ModelProviderDTO }) {
	const [open, setOpen] = useState(false);
	const [edit, setEdit] = useState(false);
	const [test, setTest] = useState<ProviderTestResponse | { error: string }>();
	const [fetchNote, setFetchNote] = useState<string>();
	const { busy, run, note } = useAct(reload);
	const writable = canProviders && !p.readOnly;
	return (
		<div data-testid="model-provider-row" data-provider-id={p.id}>
			<Row>
				<button type="button" className="flex size-6 items-center justify-center text-fg-subtle" aria-label={open ? "收起" : "展开"} onClick={() => setOpen(!open)}>
					{open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
				</button>
				<span className="min-w-0 flex-1">
					<span className="flex flex-wrap items-center gap-1.5 font-medium">
						{p.name}
						<Badge>{p.type === "builtin" ? `内置 · ${p.builtinId}` : TYPE_SHORT[p.type]}</Badge>
						{p.scope === "instance" ? <Badge tone="info" title="来自 workroom.models.json 或环境变量，只读">{SCOPE_LABEL.instance.slice(0, 2)}</Badge> : null}
						{p.keyless ? <Badge>无需密钥</Badge> : null}
					</span>
					<span className="block truncate text-xs text-fg-subtle">
						{p.baseUrl ?? "（pi-ai 内置端点）"} · 密钥：{p.credential.kind === "env" ? `环境变量 ${p.credential.envVar ?? ""}` : p.credential.kind === "stored" ? `已加密保存${p.credential.hint ? `（${p.credential.hint}）` : ""}` : p.keyless ? "无" : "未配置"} · {p.enabledModelCount} 个模型已启用 / 共 {p.modelCount} 个
						{p.healthDetail ? ` · ${p.healthDetail}` : ""}
					</span>
				</span>
				<HealthBadge p={p} />
				{canProviders ? (
					<>
						<Button
							size="sm"
							disabled={busy || p.health === "disabled"}
							data-testid="provider-test"
							onClick={() =>
								run(async () => {
									setTest(undefined);
									try {
										setTest(await post<ProviderTestResponse>(`${base}/${p.id}/test`, {}));
									} catch (e) {
										setTest({ error: errorText(e) });
									}
								})
							}
						>
							<Wifi />
							测试连接
						</Button>
						<Button
							size="sm"
							disabled={busy || p.health !== "ready" || (p.readOnly && !personal)}
							data-testid="provider-fetch"
							onClick={() =>
								run(async () => {
									setFetchNote(undefined);
									try {
										const r = await post<FetchModelsResponse>(`${base}/${p.id}/fetch-models`, {});
										setFetchNote(r.ok ? `已获取 ${r.count} 个模型，请在下方选择要对成员开放的模型。` : `获取失败：${r.error ?? ""}`);
										setOpen(true);
									} catch (e) {
										setFetchNote(`获取失败：${errorText(e)}`);
									}
								})
							}
						>
							<DownloadCloud />
							获取模型列表
						</Button>
					</>
				) : null}
				{writable ? (
					<>
						<Button size="icon-sm" variant="ghost" aria-label="编辑" disabled={busy} onClick={() => setEdit(true)} data-testid="provider-edit">
							<Pencil />
						</Button>
						<label className="flex items-center gap-1.5 text-xs text-fg-muted">
							<input type="checkbox" checked={p.status === "enabled"} disabled={busy} onChange={(e) => run(() => patch(`${base}/${p.id}`, { status: e.target.checked ? "enabled" : "disabled" }))} />
							启用
						</label>
						<Button
							size="icon-sm"
							variant="ghost"
							aria-label="删除"
							disabled={busy}
							onClick={() => {
								if (window.confirm(`删除服务商「${p.name}」及其全部模型配置？已使用这些模型的会话将无法继续发送。`)) void run(() => del(`${base}/${p.id}`));
							}}
						>
							<Trash2 />
						</Button>
					</>
				) : null}
			</Row>
			{note || test || fetchNote ? (
				<div className="space-y-1 px-3 pb-2.5 text-xs">
					{note}
					{fetchNote ? <p className={fetchNote.startsWith("获取失败") ? "text-danger" : "text-success"}>{fetchNote}</p> : null}
					{test ? <TestResult r={test} /> : null}
				</div>
			) : null}
			{open ? <ModelsTable p={p} base={base} personal={personal} canModels={canModels} canProviders={canProviders && !p.readOnly} onChanged={reload} defaultModelId={defaultModelId} /> : null}
			{edit ? <ProviderDialog open onOpenChange={setEdit} base={base} personal={personal} existing={p} catalog={catalog} onSaved={reload} /> : null}
		</div>
	);
}

function TestResult({ r }: { r: ProviderTestResponse | { error: string } }) {
	if ("error" in r) return <p className="text-danger">测试失败：{r.error}</p>;
	return (
		<div className="rounded-lg bg-surface-2 px-2.5 py-1.5" data-testid="provider-test-result">
			<p className={r.list.ok ? "text-success" : "text-danger"}>
				① 获取模型列表：{r.list.skipped ? `跳过（${r.list.detail ?? ""}）` : r.list.ok ? `成功，${r.list.count} 个模型（${r.list.latencyMs} ms）` : `失败：${r.list.detail ?? ""}`}
			</p>
			<p className={r.completion.ok ? "text-success" : "text-danger"}>② 一次极小的真实对话（{r.completion.modelId ?? "无模型"}）：{r.completion.ok ? `成功，回复「${r.completion.text ?? ""}」（${r.completion.latencyMs} ms）` : `失败：${r.completion.detail ?? ""}`}</p>
			<p className="text-fg-subtle">连接测试不计入用量。</p>
		</div>
	);
}

function ModelsTable({ p, base, personal, canModels, canProviders, onChanged, defaultModelId }: { p: ModelProviderDTO; base: string; personal?: boolean; canModels: boolean; canProviders: boolean; onChanged: () => void; defaultModelId?: string }) {
	const res = useApi<{ models: AdminModelDTO[] }>(`${base}/${p.id}/models`);
	const [filter, setFilter] = useState("");
	const [onlyOn, setOnlyOn] = useState(false);
	const [editing, setEditing] = useState<AdminModelDTO>();
	const [adding, setAdding] = useState(false);
	const { busy, run, note } = useAct(() => {
		res.reload();
		onChanged();
	});
	const models = (res.data?.models ?? []).filter((m) => (!onlyOn || m.enabled) && (!filter || `${m.name} ${m.modelId}`.toLowerCase().includes(filter.toLowerCase())));
	const off = (res.data?.models ?? []).filter((m) => !m.enabled && !m.nonChat);
	const mayToggle = personal ? canProviders : canModels && !p.readOnly;
	return (
		<div className="border-t border-border bg-surface-2/40 px-3 py-3" data-testid="provider-models">
			<div className="mb-2 flex flex-wrap items-center gap-2">
				<Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="筛选模型…" className="h-8 w-48 text-[13px]" />
				<label className="flex items-center gap-1.5 text-xs text-fg-muted">
					<input type="checkbox" checked={onlyOn} onChange={(e) => setOnlyOn(e.target.checked)} />
					只看已启用
				</label>
				<span className="flex-1" />
				{mayToggle && off.length > 0 ? (
					<Button size="sm" disabled={busy} onClick={() => run(() => patch(`${base}/${p.id}/models`, { modelIds: off.map((m) => m.modelId), enabled: true }))} data-testid="enable-all-chat">
						启用全部对话模型（{off.length}）
					</Button>
				) : null}
				{mayToggle ? (
					<Button size="sm" disabled={busy} onClick={() => setAdding(true)} data-testid="add-model">
						<Plus />
						手动添加模型
					</Button>
				) : null}
			</div>
			{note}
			<Loadable state={res} what="模型" need="GET /api/admin/model-providers/:id/models">
				{models.length === 0 ? (
					<p className="text-[13px] text-fg-subtle">{(res.data?.models ?? []).length === 0 ? "该服务商还没有模型：点击“获取模型列表”，或“手动添加模型”。" : "没有符合筛选的模型。"}</p>
				) : (
					<div className="overflow-hidden rounded-lg border border-border bg-surface [&>div+div]:border-t [&>div+div]:border-border" data-testid="model-table">
						{models.map((m) => (
							<div key={m.modelId} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px] ${m.nonChat && !m.enabled ? "opacity-60" : ""}`} data-testid="model-row" data-model-id={m.modelId}>
								<span className="min-w-0 flex-1 basis-56">
									<span className="flex items-center gap-1.5 font-medium">
										{m.name}
										{m.manual ? <Badge>手动</Badge> : null}
										{m.overridden ? <Badge tone="warning" title="已覆盖目录中的参数">已调整</Badge> : null}
										{m.nonChat ? <Badge title="看起来是向量/语音/图像模型，默认不适合对话">非对话？</Badge> : null}
										{m.isDefault || m.id === defaultModelId ? <Badge tone="success">默认</Badge> : null}
									</span>
									<span className="block truncate font-mono text-xs text-fg-subtle">{m.modelId}</span>
								</span>
								<CapabilityBadges m={m} />
								<span className="w-28 text-xs text-fg-muted" title="上下文窗口 / 最大输出">
									{fmtTokens(m.contextWindow)} / {fmtTokens(m.maxTokens)}
								</span>
								<span className="w-28 text-xs text-fg-muted" title="美元/百万 Token（输入/输出）">
									{fmtPrice(m.cost)}
								</span>
								{!personal ? <span className="w-28 truncate text-xs text-fg-muted">{visibilityText(m.visibility)}</span> : null}
								<label className="flex items-center gap-1.5 text-xs text-fg-muted">
									<input type="checkbox" checked={m.enabled} disabled={busy || !mayToggle} onChange={(e) => run(() => patch(`${base}/${p.id}/models/${encodeURIComponent(m.modelId)}`, { enabled: e.target.checked }))} data-testid="model-enable" />
									{personal ? "启用" : "对成员开放"}
								</label>
								{mayToggle ? (
									<Button size="icon-sm" variant="ghost" aria-label="编辑模型" onClick={() => setEditing(m)}>
										<Pencil />
									</Button>
								) : null}
								{m.manual && mayToggle ? (
									<Button size="icon-sm" variant="ghost" aria-label="删除模型" disabled={busy} onClick={() => run(() => del(`${base}/${p.id}/models/${encodeURIComponent(m.modelId)}`))}>
										<Trash2 />
									</Button>
								) : null}
							</div>
						))}
					</div>
				)}
			</Loadable>
			<p className="mt-2 flex items-center gap-1 text-xs text-fg-subtle">
				<KeyRound className="size-3.5" />
				从厂商获取的模型默认不开放；价格、上下文长度若厂商列表未提供，会使用 pi-ai 目录值或保守默认值，请核对。
			</p>
			{adding ? <ModelDialog open onOpenChange={setAdding} provider={p} base={base} personal={personal} onSaved={() => (res.reload(), onChanged())} /> : null}
			{editing ? <ModelDialog open onOpenChange={() => setEditing(undefined)} provider={p} base={base} personal={personal} model={editing} onSaved={() => (res.reload(), onChanged())} /> : null}
		</div>
	);
}
