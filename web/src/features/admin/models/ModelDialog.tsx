// Add a model by hand / edit one: id, display name, context window, max output tokens, input modalities, reasoning + thinking
// levels, price per million tokens, tools, compatibility flags, org visibility (departments / members), fallbacks, default thinking.
// Everyday fields first; thinking levels, compatibility flags, fallbacks and per-model limits live in the collapsed 高级设置.
import { useState } from "react";
import type { AdminModelDTO, ModelProviderDTO, PlatformModelDTO, ThinkingLevel, UpdateAdminModelRequest } from "@shared/ops";
import { errorText, patch, post } from "@/lib/api";
import { Fold } from "@/features/admin/common";
import { useApi } from "@/lib/useApi";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { useDepartments } from "@/features/admin/rbac-ui";
import { THINKING_LEVELS } from "./shared";

const COMPAT_HELP = `例如 {"supportsDeveloperRole": false, "supportsReasoningEffort": false, "maxTokensField": "max_tokens", "thinkingFormat": "qwen"}`;

export function ModelDialog({ open, onOpenChange, provider, base, personal, model, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; provider: ModelProviderDTO; base: string; personal?: boolean; model?: AdminModelDTO; onSaved: () => void }) {
	const editing = !!model;
	const [id, setId] = useState(model?.modelId ?? "");
	const [name, setName] = useState(model?.name ?? "");
	const [ctx, setCtx] = useState(String(model?.contextWindow ?? 128000));
	const [maxTokens, setMaxTokens] = useState(String(model?.maxTokens ?? 8192));
	const [image, setImage] = useState(model?.input.includes("image") ?? false);
	const [reasoning, setReasoning] = useState(model?.reasoning ?? false);
	const [levels, setLevels] = useState<Set<string>>(new Set(model?.thinkingLevels.filter((l) => l !== "off") ?? ["low", "medium", "high"]));
	const [tools, setTools] = useState(model?.tools ?? true);
	const [cost, setCost] = useState({ input: String(model?.cost.input ?? 0), output: String(model?.cost.output ?? 0), cacheRead: String(model?.cost.cacheRead ?? 0), cacheWrite: String(model?.cost.cacheWrite ?? 0) });
	const [compat, setCompat] = useState(model?.compat ? JSON.stringify(model.compat, null, 2) : "");
	const [description, setDescription] = useState(model?.description ?? "");
	const [defaultThinking, setDefaultThinking] = useState<string>(model?.defaultThinking ?? "");
	const [vis, setVis] = useState({ departmentIds: new Set(model?.visibility?.departmentIds ?? []), userIds: new Set(model?.visibility?.userIds ?? []) });
	const [mrpm, setMrpm] = useState(model?.rpmLimit ? String(model.rpmLimit) : "");
	const [mconc, setMconc] = useState(model?.concurrencyLimit ? String(model.concurrencyLimit) : "");
	const [fallbacks, setFallbacks] = useState<string[]>((model?.fallbacks ?? []).map((f) => `${f.provider}/${f.modelId}`));
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	const deps = useDepartments();
	const members = useApi<{ members: { userId: string; name: string; email: string }[] }>(!personal && open ? "/org/members" : null);
	const all = useApi<{ models: PlatformModelDTO[] }>(!personal && open ? "/models" : null);
	const fallbackOptions = (all.data?.models ?? []).filter((m) => !m.fixture && m.id !== model?.id && !m.personal);

	const toggle = <T,>(set: Set<T>, v: T): Set<T> => {
		const n = new Set(set);
		if (n.has(v)) n.delete(v);
		else n.add(v);
		return n;
	};

	const submit = async () => {
		setBusy(true);
		setErr(undefined);
		try {
			let compatObj: Record<string, unknown> | undefined;
			if (compat.trim()) {
				try {
					compatObj = JSON.parse(compat) as Record<string, unknown>;
				} catch {
					throw new Error("compat 不是合法的 JSON");
				}
			}
			const levelMap: Record<string, string | null> = {};
			if (reasoning) for (const l of THINKING_LEVELS) if (!levels.has(l)) levelMap[l] = null;
			const spec = {
				name: name.trim() || undefined,
				contextWindow: Number(ctx),
				maxTokens: Number(maxTokens),
				input: image ? ["text", "image"] : ["text"],
				reasoning,
				...(reasoning ? { thinkingLevelMap: levelMap } : {}),
				tools,
				cost: { input: Number(cost.input) || 0, output: Number(cost.output) || 0, cacheRead: Number(cost.cacheRead) || 0, cacheWrite: Number(cost.cacheWrite) || 0 },
				...(compatObj ? { compat: compatObj } : {}),
			};
			const visibility = personal ? undefined : vis.departmentIds.size || vis.userIds.size ? { ...(vis.departmentIds.size ? { departmentIds: [...vis.departmentIds] } : {}), ...(vis.userIds.size ? { userIds: [...vis.userIds] } : {}) } : null;
			const extra = {
				description: description.trim() || null,
				rpmLimit: mrpm ? Number(mrpm) : null,
				concurrencyLimit: mconc ? Number(mconc) : null,
				defaultThinking: (defaultThinking || null) as ThinkingLevel | null,
				...(personal ? {} : { visibility, fallbacks: fallbacks.map((f) => ({ provider: f.slice(0, f.indexOf("/")), modelId: f.slice(f.indexOf("/") + 1) })) }),
			};
			if (editing) await patch(`${base}/${provider.id}/models/${encodeURIComponent(model!.modelId)}`, { ...spec, ...extra } as UpdateAdminModelRequest as never);
			else await post(`${base}/${provider.id}/models`, { id: id.trim(), ...spec, ...extra, enabled: true } as never);
			onOpenChange(false);
			onSaved();
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={editing ? `编辑模型：${model!.name}` : `添加模型到「${provider.name}」`} className="max-h-[90vh] max-w-2xl overflow-y-auto" data-testid="model-dialog">
				<div className="space-y-3.5 text-sm">
					<div className="grid gap-3 sm:grid-cols-2">
						<div>
							<Label>模型 ID（厂商文档里的名称）</Label>
							<Input value={id} disabled={editing} onChange={(e) => setId(e.target.value)} placeholder="deepseek-chat" data-testid="model-id" />
						</div>
						<div>
							<Label>显示名称</Label>
							<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="DeepSeek V3" data-testid="model-name" />
						</div>
						<div>
							<Label>上下文长度（Token）</Label>
							<Input value={ctx} onChange={(e) => setCtx(e.target.value.replace(/\D/g, ""))} />
						</div>
						<div>
							<Label>最大输出（Token）</Label>
							<Input value={maxTokens} onChange={(e) => setMaxTokens(e.target.value.replace(/\D/g, ""))} />
						</div>
					</div>

					<div className="flex flex-wrap gap-x-5 gap-y-1.5">
						<label className="flex items-center gap-1.5">
							<input type="checkbox" checked disabled />
							文本输入
						</label>
						<label className="flex items-center gap-1.5">
							<input type="checkbox" checked={image} onChange={(e) => setImage(e.target.checked)} />
							图片输入
						</label>
						<label className="flex items-center gap-1.5">
							<input type="checkbox" checked={tools} onChange={(e) => setTools(e.target.checked)} />
							支持工具调用
						</label>
						<label className="flex items-center gap-1.5">
							<input type="checkbox" checked={reasoning} onChange={(e) => setReasoning(e.target.checked)} />
							推理 / 思考模型
						</label>
					</div>
					<div>
						<Label>价格（美元 / 百万 Token）</Label>
						<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
							{(["input", "output", "cacheRead", "cacheWrite"] as const).map((k) => (
								<label key={k} className="text-xs text-fg-muted">
									{k === "input" ? "输入" : k === "output" ? "输出" : k === "cacheRead" ? "缓存读" : "缓存写"}
									<Input value={cost[k]} onChange={(e) => setCost({ ...cost, [k]: e.target.value.replace(/[^\d.]/g, "") })} className="mt-0.5 h-8" />
								</label>
							))}
						</div>
					</div>

					{!personal ? (
						<>
							<div>
								<Label>对哪些成员开放（都不选 = 全体成员）</Label>
								<div className="grid gap-2 sm:grid-cols-2">
									<div className="max-h-28 overflow-y-auto rounded-lg border border-border p-2">
										<div className="mb-1 text-xs text-fg-muted">部门</div>
										{(deps.data?.departments ?? []).map((d) => (
											<label key={d.id} className="flex items-center gap-1.5 py-0.5">
												<input type="checkbox" checked={vis.departmentIds.has(d.id)} onChange={() => setVis({ ...vis, departmentIds: toggle(vis.departmentIds, d.id) })} />
												{d.name}
											</label>
										))}
										{(deps.data?.departments ?? []).length === 0 ? <span className="text-xs text-fg-muted">没有部门</span> : null}
									</div>
									<div className="max-h-28 overflow-y-auto rounded-lg border border-border p-2">
										<div className="mb-1 text-xs text-fg-muted">指定成员</div>
										{(members.data?.members ?? []).map((m) => (
											<label key={m.userId} className="flex items-center gap-1.5 py-0.5">
												<input type="checkbox" checked={vis.userIds.has(m.userId)} onChange={() => setVis({ ...vis, userIds: toggle(vis.userIds, m.userId) })} />
												{m.name}
											</label>
										))}
									</div>
								</div>
							</div>
						</>
					) : null}

					<Fold title="高级设置" testId="model-advanced">
						<div className="space-y-3.5">
					{reasoning ? (
						<div className="rounded-lg border border-border px-3 py-2">
							<Label>可用的思考强度</Label>
							<div className="flex flex-wrap gap-x-4 gap-y-1">
								{THINKING_LEVELS.map((l) => (
									<label key={l} className="flex items-center gap-1.5">
										<input type="checkbox" checked={levels.has(l)} onChange={() => setLevels(toggle(levels, l))} />
										{l}
									</label>
								))}
							</div>
							<div className="mt-2">
								<Label>默认思考强度</Label>
								<Select aria-label="默认思考强度" value={defaultThinking} onChange={(e) => setDefaultThinking(e.target.value)}>
									<option value="">不指定</option>
									<option value="off">off</option>
									{[...levels].map((l) => (
										<option key={l} value={l}>
											{l}
										</option>
									))}
								</Select>
							</div>
						</div>
					) : null}

					<div>
						<Label>兼容性设置（键值对，可留空）</Label>
						<Textarea value={compat} onChange={(e) => setCompat(e.target.value)} rows={3} placeholder={COMPAT_HELP} className="font-mono text-xs" data-testid="model-compat" />
					</div>

							{!personal ? (
								<>
							<div>
								<Label>备用模型</Label>
								{fallbacks.map((f, i) => (
									<div key={i} className="mb-1 flex gap-1.5">
										<Select aria-label={`备用模型 ${i + 1}`} value={f} onChange={(e) => setFallbacks(fallbacks.map((x, j) => (j === i ? e.target.value : x)))} className="flex-1">
											{fallbackOptions.map((m) => (
												<option key={m.id} value={m.id}>
													{m.label}（{m.providerName ?? m.ref.provider}）
												</option>
											))}
										</Select>
										<Button size="sm" variant="ghost" onClick={() => setFallbacks(fallbacks.filter((_, j) => j !== i))}>
											移除
										</Button>
									</div>
								))}
								{fallbacks.length < 5 && fallbackOptions.length > 0 ? (
									<Button size="sm" variant="ghost" onClick={() => setFallbacks([...fallbacks, fallbackOptions[0]!.id])}>
										添加备用模型
									</Button>
								) : null}
							</div>
								</>
							) : null}
					<div className="grid grid-cols-2 gap-2">
						<label className="text-xs text-fg-muted">
							每分钟请求上限（可空）
							<Input value={mrpm} onChange={(e) => setMrpm(e.target.value.replace(/\D/g, ""))} className="mt-0.5 h-8" />
						</label>
						<label className="text-xs text-fg-muted">
							同时进行的请求上限（可空）
							<Input value={mconc} onChange={(e) => setMconc(e.target.value.replace(/\D/g, ""))} className="mt-0.5 h-8" />
						</label>
					</div>
						</div>
					</Fold>
					<div>
						<Label>说明（可选）</Label>
						<Input value={description} onChange={(e) => setDescription(e.target.value)} />
					</div>
					{err ? (
						<p className="rounded-lg bg-danger-soft px-3 py-1.5 text-danger" role="alert">
							{err}
						</p>
					) : null}
					<div className="flex justify-end gap-2">
						{editing && model!.overridden ? (
							<Button
								variant="ghost"
								disabled={busy}
								onClick={async () => {
									setBusy(true);
									try {
										await patch(`${base}/${provider.id}/models/${encodeURIComponent(model!.modelId)}`, { resetSpec: true });
										onOpenChange(false);
										onSaved();
									} catch (e) {
										setErr(errorText(e));
									} finally {
										setBusy(false);
									}
								}}
							>
								恢复目录默认值
							</Button>
						) : null}
						<Button variant="ghost" onClick={() => onOpenChange(false)}>
							取消
						</Button>
						<Button variant="primary" disabled={busy || (!editing && !id.trim())} onClick={() => void submit()} data-testid="model-save">
							{busy ? "保存中…" : "保存"}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
