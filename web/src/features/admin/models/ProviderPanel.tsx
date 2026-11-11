// 模型服务 list: one clean row per service (name, kind in plain words, status dot, model count). Opening a row shows its actions
// (test connection, fetch models, edit, enable, delete) and its model list. Used by the admin page (`/admin/model-providers`) and by
// the personal-key section of Settings (`/me/model-providers`).
import { ChevronRight, DownloadCloud, Pencil, Plus, Trash2, Wifi } from "lucide-react";
import { useState } from "react";
import type { AdminModelDTO, FetchModelsResponse, ModelProviderDTO, ModelProvidersResponse, ProviderTestResponse } from "@shared/ops";
import { del, errorText, patch, post } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useApi } from "@/lib/useApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, Loadable } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { Fold, Table, useAct } from "@/features/admin/common";
import { useConfirm } from "@/features/admin/confirm";
import { ModelDialog } from "./ModelDialog";
import { ProviderDialog } from "./ProviderDialog";
import { CapabilityBadges, fmtPrice, fmtTokens, StatusDot, SCOPE_LABEL, TYPE_LABEL, visibilityText } from "./shared";

export interface PanelProps {
	base: string;
	personal?: boolean;
	/** may create / edit / delete providers and keys (model.provider.manage, or any user for personal) */
	canProviders: boolean;
	/** may enable / disable models, set visibility (model.manage, or any user for personal) */
	canModels: boolean;
	catalog?: Pick<ModelProvidersResponse, "presets" | "builtins" | "settings">;
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
						{personal ? "添加我的服务" : "添加服务"}
					</Button>
				</div>
			) : null}
			{providers.length === 0 ? (
				<p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-fg-muted">{personal ? "还没有自己的模型服务" : "还没有模型服务"}</p>
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
	const { ask, dialog } = useConfirm();
	const writable = canProviders && !p.readOnly;
	const kind = p.type === "builtin" ? `内置 · ${p.builtinId}` : TYPE_LABEL[p.type];
	return (
		<div data-testid="model-provider-row" data-provider-id={p.id}>
			<button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2/60" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="provider-expand">
				<ChevronRight aria-hidden className={cn("size-4 shrink-0 text-fg-subtle transition-transform", open && "rotate-90")} />
				<span className="min-w-0 flex-1">
					<span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
						{p.name}
						{p.scope === "instance" ? <Badge tone="info">{SCOPE_LABEL.instance}</Badge> : null}
					</span>
					<span className="block text-xs text-fg-muted">
						{kind} · {p.modelCount} 个模型{p.enabledModelCount ? `，${p.enabledModelCount} 个已开放` : "，暂未开放"}
					</span>
				</span>
				<StatusDot p={p} testId="provider-status" />
			</button>
			{open ? (
				<div className="border-t border-border bg-surface-2/40 px-4 py-3" data-testid="provider-panel">
					<div className="mb-3 flex flex-wrap items-center gap-2">
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
												setFetchNote(r.ok ? undefined : `获取失败：${r.error ?? ""}`);
											} catch (e) {
												setFetchNote(`获取失败：${errorText(e)}`);
											}
										})
									}
								>
									<DownloadCloud />
									获取模型
								</Button>
								{p.circuit?.open && !p.readOnly ? (
									<Button size="sm" disabled={busy} onClick={() => run(() => post(`${base}/${p.id}/reset-circuit`, {}))} data-testid="reset-circuit">
										恢复调用
									</Button>
								) : null}
							</>
						) : null}
						<span className="flex-1" />
						{writable ? (
							<>
								<span className="flex items-center gap-2 text-sm text-fg-muted">
									<Switch aria-label={`启用 ${p.name}`} checked={p.status === "enabled"} busy={busy} onCheckedChange={(v) => run(() => patch(`${base}/${p.id}`, { status: v ? "enabled" : "disabled" }))} data-testid="provider-enable" />
									启用
								</span>
								<Button size="sm" disabled={busy} onClick={() => setEdit(true)} data-testid="provider-edit">
									<Pencil />
									编辑
								</Button>
								<Button
									size="sm"
									variant="ghost"
									aria-label={`删除 ${p.name}`}
									data-testid="provider-delete"
									disabled={busy}
									onClick={async () => {
										if (await ask({ title: `删除「${p.name}」？`, consequence: `这个服务下的 ${p.modelCount} 个模型都会被删除，使用这些模型的对话将无法继续发送，需要换用其他模型。`, confirmLabel: "删除服务", danger: true })) await run(() => del(`${base}/${p.id}`));
									}}
								>
									<Trash2 />
									删除
								</Button>
							</>
						) : null}
					</div>
					{note || test || fetchNote ? (
						<div className="mb-3 space-y-1 text-sm">
							{note}
							{fetchNote ? (
								<p className="text-danger" role="alert">
									{fetchNote}
								</p>
							) : null}
							{test ? <TestResult r={test} /> : null}
						</div>
					) : null}
					<ModelsTable p={p} base={base} personal={personal} canModels={canModels} canProviders={canProviders && !p.readOnly} onChanged={reload} defaultModelId={defaultModelId} />
					<div className="mt-3">
						<Fold title="技术详情" testId="provider-tech">
							<dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1 text-xs text-fg-muted">
								<dt>地址</dt>
								<dd className="break-all">{p.baseUrl ?? "内置地址"}</dd>
								<dt>密钥</dt>
								<dd>{p.credential.kind === "env" ? `环境变量 ${p.credential.envVar ?? ""}` : p.credential.kind === "stored" ? `已加密保存${p.credential.hint ? `（${p.credential.hint}）` : ""}` : p.keyless ? "不需要" : "未配置"}</dd>
								<dt>状态</dt>
								<dd>{p.healthDetail ?? (p.circuit?.open ? `连续失败 ${p.circuit.fails} 次，暂停调用` : "正常")}</dd>
								{p.rpmLimit || p.concurrencyLimit ? (
									<>
										<dt>限流</dt>
										<dd>
											{p.rpmLimit ? `每分钟 ${p.rpmLimit} 次` : ""}
											{p.rpmLimit && p.concurrencyLimit ? "，" : ""}
											{p.concurrencyLimit ? `同时 ${p.concurrencyLimit} 个` : ""}
										</dd>
									</>
								) : null}
							</dl>
						</Fold>
					</div>
				</div>
			) : null}
			{edit ? <ProviderDialog open onOpenChange={setEdit} base={base} personal={personal} existing={p} catalog={catalog} onSaved={reload} /> : null}
			{dialog}
		</div>
	);
}

function TestResult({ r }: { r: ProviderTestResponse | { error: string } }) {
	if ("error" in r)
		return (
			<p className="text-danger" role="alert">
				测试没有通过：{r.error}
			</p>
		);
	return (
		<div className="rounded-lg bg-surface px-3 py-2" data-testid="provider-test-result">
			<p className={r.list.ok ? "text-success" : "text-danger"}>{r.list.skipped ? "该服务不提供模型列表，已跳过" : r.list.ok ? `能获取模型列表（${r.list.count} 个，${r.list.latencyMs} 毫秒）` : `获取模型列表失败：${r.list.detail ?? ""}`}</p>
			<p className={r.completion.ok ? "text-success" : "text-danger"}>{r.completion.ok ? `能正常对话（${r.completion.modelId}，${r.completion.latencyMs} 毫秒）` : `试聊失败：${r.completion.detail ?? ""}`}</p>
		</div>
	);
}

function ModelsTable({ p, base, personal, canModels, canProviders, onChanged, defaultModelId }: { p: ModelProviderDTO; base: string; personal?: boolean; canModels: boolean; canProviders: boolean; onChanged: () => void; defaultModelId?: string }) {
	const res = useApi<{ models: AdminModelDTO[] }>(`${base}/${p.id}/models`);
	const [filter, setFilter] = useState("");
	const [onlyOn, setOnlyOn] = useState(false);
	const [editing, setEditing] = useState<AdminModelDTO>();
	const [adding, setAdding] = useState(false);
	const { ask, dialog } = useConfirm();
	const { busy, run, note } = useAct(() => {
		res.reload();
		onChanged();
	});
	const models = (res.data?.models ?? []).filter((m) => (!onlyOn || m.enabled) && (!filter || `${m.name} ${m.modelId}`.toLowerCase().includes(filter.toLowerCase())));
	const off = (res.data?.models ?? []).filter((m) => !m.enabled && !m.nonChat);
	const mayToggle = personal ? canProviders : canModels && !p.readOnly;
	return (
		<div data-testid="provider-models">
			<div className="mb-2 flex flex-wrap items-center gap-2">
				<h4 className="text-sm font-medium">模型</h4>
				<Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="筛选模型" aria-label="筛选模型" className="h-8 w-44 text-sm" />
				<span className="flex items-center gap-2 text-xs text-fg-muted">
					<Switch aria-label="只看已开放" checked={onlyOn} onCheckedChange={setOnlyOn} />
					只看已开放
				</span>
				<span className="flex-1" />
				{mayToggle && off.length > 0 ? (
					<Button
						size="sm"
						disabled={busy}
						onClick={async () => {
							if (await ask({ title: `开放全部对话模型（${off.length} 个）？`, consequence: personal ? "这些模型会出现在你的模型列表里。" : "这些模型会对全体成员开放，成员发送的内容会发给这个服务。", confirmLabel: "全部开放" })) await run(() => patch(`${base}/${p.id}/models`, { modelIds: off.map((m) => m.modelId), enabled: true }));
						}}
						data-testid="enable-all-chat"
					>
						开放全部对话模型（{off.length}）
					</Button>
				) : null}
				{mayToggle ? (
					<Button size="sm" disabled={busy} onClick={() => setAdding(true)} data-testid="add-model">
						<Plus />
						手动添加
					</Button>
				) : null}
			</div>
			{note}
			<Loadable state={res} what="模型">
				{models.length === 0 ? (
					<p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-fg-muted">{(res.data?.models ?? []).length === 0 ? "还没有模型" : "没有符合筛选的模型。"}</p>
				) : (
					<div className="overflow-hidden rounded-lg border border-border bg-surface [&>div+div]:border-t [&>div+div]:border-border" data-testid="model-table">
						{models.map((m) => (
							<div key={m.modelId} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm", m.nonChat && !m.enabled && "opacity-70")} data-testid="model-row" data-model-id={m.modelId}>
								<span className="min-w-0 flex-1 basis-56">
									<span className="flex flex-wrap items-center gap-1.5 font-medium">
										{m.name}
										{m.manual ? <Badge>手动添加</Badge> : null}
										{m.overridden ? <Badge tone="warning">已调整</Badge> : null}
										{m.nonChat ? <Badge title="看起来是向量、语音或图像模型，一般不适合对话">可能不是对话模型</Badge> : null}
										{m.isDefault || m.id === defaultModelId ? <Badge tone="success">默认</Badge> : null}
									</span>
									<span className="block truncate text-xs text-fg-muted">
										{m.modelId} · 上下文 {fmtTokens(m.contextWindow)} · 价格 {fmtPrice(m.cost)}
										{!personal && m.enabled ? ` · 开放给${visibilityText(m.visibility)}` : ""}
									</span>
								</span>
								<CapabilityBadges m={m} />
								<span className="flex items-center gap-2 text-sm text-fg-muted">
									<Switch aria-label={`${personal ? "启用" : "对成员开放"} ${m.name}`} checked={m.enabled} disabled={!mayToggle} busy={busy} onCheckedChange={(v) => run(() => patch(`${base}/${p.id}/models/${encodeURIComponent(m.modelId)}`, { enabled: v }))} data-testid="model-enable" />
									{personal ? "启用" : "对成员开放"}
								</span>
								{mayToggle ? (
									<Button size="icon-sm" variant="ghost" aria-label={`编辑 ${m.name}`} onClick={() => setEditing(m)}>
										<Pencil />
									</Button>
								) : null}
								{m.manual && mayToggle ? (
									<Button
										size="icon-sm"
										variant="ghost"
										aria-label={`删除 ${m.name}`}
										disabled={busy}
										onClick={async () => {
											if (await ask({ title: `删除模型「${m.name}」？`, consequence: "使用这个模型的对话将无法继续发送，需要换用其他模型。", confirmLabel: "删除模型", danger: true })) await run(() => del(`${base}/${p.id}/models/${encodeURIComponent(m.modelId)}`));
										}}
									>
										<Trash2 />
									</Button>
								) : null}
							</div>
						))}
					</div>
				)}
			</Loadable>
			{adding ? <ModelDialog open onOpenChange={setAdding} provider={p} base={base} personal={personal} onSaved={() => (res.reload(), onChanged())} /> : null}
			{editing ? <ModelDialog open onOpenChange={() => setEditing(undefined)} provider={p} base={base} personal={personal} model={editing} onSaved={() => (res.reload(), onChanged())} /> : null}
			{dialog}
		</div>
	);
}
