// Provider factory: loads exactly one adapter (and its optional SDK) on demand. Used by provider-config.ts (`defaultFactory`).
import { HttpError } from "../../../core/http.ts";
import type { ProviderConnection, ProviderId, RemoteProvider } from "../provider.ts";

type Adapter = { createProvider?: (conn: ProviderConnection) => RemoteProvider };

export async function createRemoteProvider(conn: ProviderConnection): Promise<RemoteProvider> {
	let mod: Adapter;
	try {
		switch (conn.provider as ProviderId) {
			case "opensandbox":
				mod = await import("./opensandbox.ts");
				break;
			case "e2b":
				mod = await import("./e2b.ts");
				break;
			case "daytona":
				mod = await import("./daytona.ts");
				break;
			default:
				throw new HttpError(400, "invalid", `未知的沙箱提供方：${String((conn as { provider?: unknown }).provider)}`);
		}
	} catch (e) {
		if (e instanceof HttpError) throw e;
		throw new HttpError(501, "adapter_missing", `沙箱提供方 ${conn.provider} 的适配器不可用（${String((e as Error)?.message ?? e).slice(0, 200)}）。不会回退到本机执行。`);
	}
	if (typeof mod.createProvider !== "function") throw new HttpError(501, "adapter_missing", `沙箱提供方 ${conn.provider} 的适配器没有导出 createProvider`);
	return mod.createProvider(conn);
}
