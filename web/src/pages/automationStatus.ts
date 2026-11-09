import type { AutomationRunStatus } from "@shared/ops";

export const RUN: Record<AutomationRunStatus, { label: string; tone: "neutral" | "info" | "success" | "danger" | "warning" }> = {
	pending: { label: "等待中", tone: "info" },
	running: { label: "运行中", tone: "info" },
	succeeded: { label: "成功", tone: "success" },
	failed: { label: "失败", tone: "danger" },
	cancelled: { label: "已取消", tone: "neutral" },
	timeout: { label: "超时", tone: "warning" },
	skipped: { label: "已跳过", tone: "neutral" },
	refused: { label: "被拒绝", tone: "danger" },
};
