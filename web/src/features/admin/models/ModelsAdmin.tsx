// 模型与渠道 tab (MODELS group, round 4): pi-ai native 模型服务商. Providers (OpenAI-compatible Chat Completions, OpenAI Responses,
// Claude-compatible Messages, pi-ai built-ins) → test connection → 获取模型列表 → enable models / set visibility.
// The admin shell mounts <ModelsAdmin /> only.
import { FlaskConical, Info } from "lucide-react";
import type { ModelProvidersResponse, PlatformModelDTO } from "@shared/ops";
import { put } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Select } from "@/components/ui/input";
import { Badge, Loadable } from "@/components/ui/misc";
import { useAct } from "@/features/admin/common";
import { useViewerPerms } from "@/features/admin/rbac-ui";
import { ProviderPanel } from "./ProviderPanel";

export { PersonalProviders } from "./PersonalProviders";

export function ModelsAdmin() {
	const perms = useViewerPerms();
	const canProviders = perms.org.has("model.provider.manage");
	const canModels = perms.org.has("model.manage");
	const res = useApi<ModelProvidersResponse>("/admin/model-providers");
	const models = useApi<{ models: PlatformModelDTO[]; defaultModelId?: string }>("/models");
	const { busy, run, note } = useAct(() => {
		res.reload();
		models.reload();
	});
	const settings = res.data?.settings;
	const choices = (models.data?.models ?? []).filter((m) => !m.fixture && !m.personal && !(m as { legacy?: boolean }).legacy && m.status === "ready");
	return (
		<div className="space-y-6" data-testid="models-admin">
			{note}
			<section className="rounded-xl border border-border bg-surface p-3 text-[13px]" data-testid="model-settings">
				<div className="flex flex-wrap items-center gap-x-6 gap-y-2">
					<label className="flex items-center gap-2">
						<span className="text-fg-muted">组织默认模型</span>
						<Select
							value={settings?.defaultModel && choices.some((m) => m.ref.provider === settings.defaultModel!.provider && m.ref.modelId === settings.defaultModel!.modelId) ? `${settings.defaultModel.provider}/${settings.defaultModel.modelId}` : ""}
							disabled={busy || !canModels}
							className="h-8 max-w-64 text-[13px]"
							data-testid="default-model"
							onChange={(e) => {
								const m = choices.find((x) => x.id === e.target.value);
								void run(() => put("/admin/model-settings", { defaultModel: m ? { provider: m.ref.provider, modelId: m.ref.modelId } : null }));
							}}
						>
							<option value="">自动（第一个可用模型）</option>
							{choices.map((m) => (
								<option key={m.id} value={m.id}>
									{m.label}
								</option>
							))}
						</Select>
					</label>
					<label className="flex items-center gap-1.5">
						<input type="checkbox" checked={!!settings?.personalProviders} disabled={busy || !canProviders} onChange={(e) => run(() => put("/admin/model-settings", { personalProviders: e.target.checked }))} data-testid="personal-providers-toggle" />
						允许成员自带密钥（个人服务商，仅本人可见可用）
					</label>
				</div>
				{settings && !settings.secretKeyConfigured ? <p className="mt-2 text-xs text-warning">服务端未配置 WORKROOM_SECRET_KEY：无法直接保存密钥。可改用“引用环境变量名”的方式（WORKROOM_ 开头）。</p> : null}
				{settings?.config.path ? (
					<p className="mt-2 flex items-start gap-1 text-xs text-fg-subtle">
						<Info className="mt-0.5 size-3.5 shrink-0" />
						<span>
							配置文件 <code>{settings.config.path}</code>：已加载 {settings.config.providers.length} 个服务商（只读）。
							{settings.config.errors.length ? <span className="text-danger"> 问题：{settings.config.errors.join("；")}</span> : null}
						</span>
					</p>
				) : null}
			</section>

			<section>
				<h3 className="mb-2 text-[13px] font-medium text-fg-muted">模型服务商（每个都是一个 pi-ai provider；密钥只在服务端，从不返回浏览器）</h3>
				<Loadable state={res} what="模型服务商" need="GET /api/admin/model-providers">
					<ProviderPanel
						base="/admin/model-providers"
						canProviders={canProviders}
						canModels={canModels}
						catalog={res.data}
						providers={res.data?.providers ?? []}
						defaultModelId={models.data?.defaultModelId}
						reload={() => {
							res.reload();
							models.reload();
						}}
					/>
					{res.data?.fixture ? (
						<p className="mt-3 flex items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2 text-xs text-fg-muted" data-testid="fixture-note">
							<FlaskConical className="size-4 shrink-0" />
							<span>
								<Badge tone="warning">测试模型，非真实 AI</Badge> {res.data.fixture.detail}
							</span>
						</p>
					) : null}
				</Loadable>
			</section>
		</div>
	);
}
