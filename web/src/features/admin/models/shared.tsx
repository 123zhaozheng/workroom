// Labels and small helpers shared by the model-provider admin UI.
import type { AdminModelDTO, ModelProviderDTO, ModelProviderType } from "@shared/ops";
import { Badge } from "@/components/ui/misc";

export const TYPE_LABEL: Record<ModelProviderType, string> = {
	"openai-completions": "OpenAI 兼容 · Chat Completions",
	"openai-responses": "OpenAI Responses",
	"anthropic-messages": "Claude 兼容 · Anthropic Messages",
	builtin: "pi-ai 内置",
};
export const TYPE_SHORT: Record<ModelProviderType, string> = { "openai-completions": "Chat Completions", "openai-responses": "Responses", "anthropic-messages": "Messages", builtin: "内置" };
export const SCOPE_LABEL = { instance: "实例（配置文件/环境变量）", org: "组织", user: "个人" } as const;

/** What the SDKs append to the base URL — shown under the field so the operator can check the final address. */
export function endpointExample(type: ModelProviderType, baseUrl: string): { chat: string; list: string; note?: string } {
	const b = baseUrl.trim().replace(/\/+$/, "") || "<Base URL>";
	if (type === "anthropic-messages") {
		const base = b.replace(/\/v1$/i, "");
		return { chat: `${base}/v1/messages`, list: `${base}/v1/models`, note: "Base URL 不要带 /v1（带了会自动去掉）。" };
	}
	if (type === "openai-responses") return { chat: `${b}/responses`, list: `${b}/models`, note: "多数第三方只实现 Chat Completions，不实现 Responses：不确定时选 Chat Completions。" };
	return { chat: `${b}/chat/completions`, list: `${b}/models`, note: "Base URL 一般以 /v1 结尾（DeepSeek 可不带；智谱是 /api/paas/v4；百炼是 /compatible-mode/v1）。" };
}

export function fmtTokens(n: number | undefined): string {
	if (!n) return "—";
	if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}K`;
	return String(n);
}
export const fmtPrice = (c: AdminModelDTO["cost"]): string => (c.input || c.output ? `$${+c.input.toFixed(4)} / $${+c.output.toFixed(4)}` : "未设置");

export function CapabilityBadges({ m }: { m: Pick<AdminModelDTO, "input" | "reasoning" | "tools" | "thinkingLevels"> }) {
	return (
		<span className="flex flex-wrap gap-1" data-testid="capability-badges">
			<Badge>文本</Badge>
			{m.input.includes("image") ? <Badge tone="info">图片</Badge> : null}
			{m.tools ? <Badge tone="info">工具</Badge> : <Badge tone="warning" title="该模型不接收工具定义：Agent 的工具将不可用">无工具</Badge>}
			{m.reasoning ? <Badge tone="info" title={`思考档位：${m.thinkingLevels.join(" / ")}`}>推理 · {m.thinkingLevels.filter((l) => l !== "off").join("/") || "—"}</Badge> : null}
		</span>
	);
}

export function HealthBadge({ p }: { p: Pick<ModelProviderDTO, "health" | "healthDetail" | "lastCheck"> }) {
	if (p.health === "ready") return <Badge tone={p.lastCheck && !p.lastCheck.ok ? "warning" : "success"} title={p.lastCheck ? `上次测试 ${new Date(p.lastCheck.at).toLocaleString()}：${p.lastCheck.ok ? "通过" : (p.lastCheck.detail ?? "失败")}` : undefined}>{p.lastCheck && !p.lastCheck.ok ? "测试失败" : "就绪"}</Badge>;
	if (p.health === "disabled") return <Badge>已停用</Badge>;
	return <Badge tone="danger" title={p.healthDetail}>不可用</Badge>;
}

export function visibilityText(v: AdminModelDTO["visibility"]): string {
	if (!v) return "全员";
	const parts = [v.departmentIds?.length ? `${v.departmentIds.length} 个部门` : "", v.projectIds?.length ? `${v.projectIds.length} 个项目` : "", v.userIds?.length ? `${v.userIds.length} 位成员` : ""].filter(Boolean);
	return parts.length ? `限定：${parts.join("、")}` : "全员";
}

export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
