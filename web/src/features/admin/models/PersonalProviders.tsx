// 个人自带密钥 (M15): the signed-in user's own providers (visible and usable only by them), when the org admin allows it.
// Mount in Settings:  <PersonalProviders />   (see docs/requests/models.md)
import { ShieldCheck } from "lucide-react";
import type { ModelProvidersResponse } from "@shared/ops";
import { useApi } from "@/lib/useApi";
import { Loadable } from "@/components/ui/misc";
import { ProviderPanel } from "./ProviderPanel";

export function PersonalProviders() {
	const allowed = useApi<{ personalProviders: boolean }>("/model-settings");
	const res = useApi<ModelProvidersResponse>(allowed.data?.personalProviders ? "/me/model-providers" : null);
	if (allowed.data && !allowed.data.personalProviders) {
		return <p className="text-[13px] text-fg-subtle">管理员没有开放“个人自带密钥”。</p>;
	}
	return (
		<section data-testid="personal-keys">
			<p className="mb-2 flex items-center gap-1.5 text-xs text-fg-subtle">
				<ShieldCheck className="size-3.5" />
				你的密钥加密保存在服务端，只有你能使用；对话里选择这些模型时，请求会直接发往你填写的地址，费用由你的服务商账户承担。
			</p>
			<Loadable state={res} what="个人服务商" need="GET /api/me/model-providers">
				<ProviderPanel base="/me/model-providers" personal canProviders canModels catalog={res.data} providers={res.data?.providers ?? []} reload={res.reload} />
			</Loadable>
		</section>
	);
}
