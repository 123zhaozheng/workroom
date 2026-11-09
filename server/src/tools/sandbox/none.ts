// Driver `none`: nothing runs. Every call fails with a message that says how to enable a real driver.
import { HttpError } from "../../core/http.ts";
import type { DriverStatus, IsolationNotes, SandboxDriver } from "./driver.ts";

export const NONE_NOTES: IsolationNotes = { isolates: ["不执行任何代码"], doesNotIsolate: ["沙箱功能（代码执行、终端、技能脚本、沙箱内 MCP）全部不可用；文件库、知识库、对话等其他功能不受影响"] };

export function enableHint(): string {
	if (process.platform === "win32") return "在 Windows 上请安装并启动 Docker Desktop（https://www.docker.com/products/docker-desktop/，WSL 2 后端、Linux 容器），然后由管理员在“沙箱”设置中选择自动或 Docker，并点击“准备沙箱镜像”。详见 docs/windows.md。";
	if (process.platform === "darwin") return "在 macOS 上请安装并启动 Docker Desktop（或 OrbStack / Colima），然后由管理员在“沙箱”设置中选择自动或 Docker，并点击“准备沙箱镜像”。";
	return "在 Linux 上请允许非特权 user namespace 并安装 util-linux（命名空间驱动），或安装 Docker Engine（docker 驱动），然后由管理员在“沙箱”设置中重新检测。";
}

export function noneDriver(reason: () => string): SandboxDriver {
	const fail = (): never => {
		throw new HttpError(503, "sandbox_unavailable", `沙箱不可用：${reason()} ${enableHint()}`);
	};
	return {
		id: "none",
		label: "未启用",
		capabilities: { network: false, services: false, mounts: false, cgroupLimits: false, hostRuntimes: false },
		notes: NONE_NOTES,
		async detect(): Promise<DriverStatus> {
			return { id: "none", state: "unavailable", summary: reason(), details: [], howToEnable: enableHint(), checkedAt: new Date().toISOString() };
		},
		async run() {
			return fail();
		},
		async startService() {
			return fail();
		},
		async reapStale() {
			return 0;
		},
		async killStale() {
			return false;
		},
	};
}
