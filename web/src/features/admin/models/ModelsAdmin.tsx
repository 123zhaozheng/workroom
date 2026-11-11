// 模型服务 page: org default model and the "members may bring their own key" policy, then the service list. Technical facts (the
// read-only config file, key encryption) sit in the collapsed 技术详情. The admin shell mounts <ModelsAdmin /> only.
import { FlaskConical } from "lucide-react";
import type { ModelProvidersResponse, PlatformModelDTO } from "@shared/ops";
import { put } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge, Loadable } from "@/components/ui/misc";
import { Fold, useAct } from "@/features/admin/common";
import { useConfirm } from "@/features/admin/confirm";
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
	const { ask, dialog } = useConfirm();
	const settings = res.data?.settings;
	const choices = (models.data?.models ?? []).filter((m) => !m.fixture && !m.personal && !(m as { legacy?: boolean }).legacy && m.status === "ready");
	return (
		<div className="space-y-8" data-testid="models-admin">
			{note}
			<section data-testid="model-settings" aria-label="模型设置">
				<div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-xl border border-border bg-surface p-4 text-sm">
					<label className="flex flex-wrap items-center gap-2">
						<span className="text-fg-muted">默认模型</span>
						<Select
							aria-label="默认模型"
							value={settings?.defaultModel && choices.some((m) => m.ref.provider === settings.defaultModel!.provider && m.ref.modelId === settings.defaultModel!.modelId) ? `${settings.defaultModel.provider}/${settings.defaultModel.modelId}` : ""}
							disabled={busy || !canModels}
							className="max-w-64"
							data-testid="default-model"
							onChange={(e) => {
								const m = choices.find((x) => x.id === e.target.value);
								void run(() => put("/admin/model-settings", { defaultModel: m ? { provider: m.ref.provider, modelId: m.ref.modelId } : null }));
							}}
						>
							<option value="">自动（第一个可用的模型）</option>
							{choices.map((m) => (
								<option key={m.id} value={m.id}>
									{m.label}
								</option>
							))}
						</Select>
					</label>
					<span className="flex items-center gap-2">
						<Switch
							aria-label="允许成员自带密钥"
							checked={!!settings?.personalProviders}
							disabled={!canProviders}
							busy={busy}
							data-testid="personal-providers-toggle"
							onCheckedChange={async (on) => {
								if (on && !(await ask({ title: "允许成员使用自己的密钥？", consequence: "成员可以在设置里添加自己的模型服务和密钥。他们发送的内容会直接发给所选服务，不经过你配置的服务，也不受这里的模型开放范围限制。", items: ["密钥只保存给本人，管理员看不到", "随时可以再关闭"], confirmLabel: "允许", danger: true }))) return;
								await run(() => put("/admin/model-settings", { personalProviders: on }));
							}}
						/>
						允许成员自带密钥
					</span>
				</div>
				{settings && !settings.secretKeyConfigured ? <p className="mt-2 text-xs text-warning">服务端还没有开启密钥加密，暂时不能直接保存密钥。</p> : null}
			</section>

			{/* data-testid kept from the old channels list so existing e2e checks ("keys never shown") still apply */}
			<section data-testid="admin-channels" aria-label="模型服务">
				<Loadable state={res} what="模型服务">
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
						<p className="mt-3 flex items-start gap-2 rounded-xl border border-dashed border-border px-3 py-2 text-xs text-fg-muted" data-testid="fixture-note">
							<FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0" />
							<span>
								<Badge tone="warning">测试模型</Badge> 固定脚本回复，不是真实的 AI，费用为 0。
							</span>
						</p>
					) : null}
					{settings?.config.path || settings ? (
						<div className="mt-4">
							<Fold title="技术详情" testId="models-tech">
								<dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1 text-xs text-fg-muted">
									<dt>密钥加密</dt>
									<dd>{settings?.secretKeyConfigured ? "已开启" : "未开启（服务端缺少 WORKROOM_SECRET_KEY）"}</dd>
									{settings?.config.path ? (
										<>
											<dt>配置文件</dt>
											<dd className="break-all">
												{settings.config.path}：已加载 {settings.config.providers.length} 个服务（只读）
												{settings.config.errors.length ? <span className="text-danger"> 问题：{settings.config.errors.join("；")}</span> : null}
											</dd>
										</>
									) : null}
									{res.data?.fixture ? (
										<>
											<dt>测试模型</dt>
											<dd>{res.data.fixture.detail}</dd>
										</>
									) : null}
								</dl>
							</Fold>
						</div>
					) : null}
				</Loadable>
			</section>
			{dialog}
		</div>
	);
}
