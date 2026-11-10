// 个人自带密钥 (M15): the signed-in user's own providers (visible and usable only by them), when the org admin allows it.
// Mounted in Settings.
import { ShieldCheck } from "lucide-react";
import type { ModelProvidersResponse } from "@shared/ops";
import { useApi } from "@/lib/useApi";
import { Loadable } from "@/components/ui/misc";
import { ProviderPanel } from "./ProviderPanel";

export function PersonalProviders() {
	const allowed = useApi<{ personalProviders: boolean }>("/model-settings");
	const res = useApi<ModelProvidersResponse>(allowed.data?.personalProviders ? "/me/model-providers" : null);
	if (allowed.data && !allowed.data.personalProviders) {
		return <p className="text-sm text-fg-muted">管理员没有开放自带密钥。</p>;
	}
	return (
		<section data-testid="personal-keys">
			<p className="mb-3 flex items-start gap-1.5 text-xs text-fg-muted">
				<ShieldCheck aria-hidden className="mt-0.5 size-3.5 shrink-0" />
				密钥加密保存，只有你能使用。用这些模型对话时，内容会直接发给你填写的地址，费用由你自己的服务账户承担。
			</p>
			<Loadable state={res} what="我的模型服务">
				<ProviderPanel base="/me/model-providers" personal canProviders canModels catalog={res.data} providers={res.data?.providers ?? []} reload={res.reload} />
			</Loadable>
		</section>
	);
}
