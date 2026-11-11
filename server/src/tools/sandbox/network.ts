// Round 9: Workroom has no sandbox network policy of its own. This only DESCRIBES what the active driver / provider actually gives
// (a technical capability or a deployment/vendor setting), for the environment panel, the sandbox info and the admin page. Nothing here decides or refuses.
import type { SandboxDriver } from "./driver.ts";
import { dockerNetworkChoice } from "./docker.ts";

export const NETWORK_TEXT_PROVIDER = "由提供方决定（Workroom 不限制，也不修改提供方的网络设置）";

/** Plain-language network statement for a driver id (+ capability). Never claims connectivity that was not tested: a remote provider's reach is "decided by the provider". */
export function networkText(d: Pick<SandboxDriver, "id" | "capabilities">): string {
	switch (d.id) {
		case "docker": {
			const n = dockerNetworkChoice();
			if (n.name === "none") return n.source === "invalid" ? "无网络（WORKROOM_DOCKER_NETWORK 配置无效，已按 none 处理）" : "无网络（部署配置 WORKROOM_DOCKER_NETWORK=none）";
			return n.name === "bridge" ? "可联网（Docker 默认桥接网络）" : `可联网（Docker 网络 ${n.name}，出口规则由部署方配置）`;
		}
		case "namespaces":
			return "无网络（本机命名空间驱动的技术限制）";
		case "opensandbox":
		case "e2b":
		case "daytona":
			return NETWORK_TEXT_PROVIDER;
		default:
			return d.capabilities.network ? "可联网" : "无网络（没有可用的沙箱驱动）";
	}
}
