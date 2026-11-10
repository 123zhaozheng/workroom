// Labels and small helpers shared by the model-provider admin UI.
import type { AdminModelDTO, ModelProviderDTO, ModelProviderType } from "@shared/ops";
import { Badge } from "@/components/ui/misc";

/** Provider kinds in plain words. */
export const TYPE_LABEL: Record<ModelProviderType, string> = { "openai-completions": "OpenAI 兼容", "openai-responses": "OpenAI 兼容", "anthropic-messages": "Claude 兼容", builtin: "内置" };
export const TYPE_SHORT = TYPE_LABEL;
export const SCOPE_LABEL = { instance: "系统预置", org: "组织", user: "个人" } as const;

/** Preset names without the protocol / vendor-internal parentheses ("OpenAI 官方 (Responses)" → "OpenAI 官方"). */
export const presetName = (label: string): string => label.replace(/\s*[（(][^）)]*[）)]/g, "").trim();

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
			{m.input.includes("image") ? <Badge tone="info">看图</Badge> : null}
			{m.tools ? <Badge tone="info">用工具</Badge> : <Badge tone="warning" title="该模型不支持调用工具：智能体的工具将不可用">不能用工具</Badge>}
			{m.reasoning ? <Badge tone="info" title={`思考强度：${m.thinkingLevels.join(" / ")}`}>会思考</Badge> : null}
		</span>
	);
}

/** Status dot + word (never colour alone). */
export function statusOf(p: Pick<ModelProviderDTO, "health" | "healthDetail" | "lastCheck" | "circuit">): { tone: "good" | "warn" | "bad" | "off"; label: string; detail?: string } {
	if (p.health === "disabled") return { tone: "off", label: "已停用" };
	if (p.health !== "ready") return { tone: "bad", label: "不可用", detail: p.healthDetail };
	if (p.circuit?.open) return { tone: "warn", label: "暂停调用", detail: `连续失败 ${p.circuit.fails} 次，系统暂时不再调用，稍后自动重试` };
	if (p.lastCheck && !p.lastCheck.ok) return { tone: "warn", label: "测试失败", detail: p.lastCheck.detail };
	return { tone: "good", label: "就绪", detail: p.lastCheck ? `上次测试 ${new Date(p.lastCheck.at).toLocaleString()} 通过` : undefined };
}
const DOT: Record<string, string> = { good: "bg-success", warn: "bg-warning", bad: "bg-danger", off: "bg-fg-subtle" };
export function StatusDot({ p, testId }: { p: Parameters<typeof statusOf>[0]; testId?: string }) {
	const s = statusOf(p);
	return (
		<span className="inline-flex items-center gap-1.5 text-xs text-fg-muted" title={s.detail} data-testid={testId} data-tone={s.tone}>
			<span aria-hidden className={`size-2 rounded-full ${DOT[s.tone]}`} />
			{s.label}
		</span>
	);
}

export function visibilityText(v: AdminModelDTO["visibility"]): string {
	if (!v) return "全员";
	const parts = [v.departmentIds?.length ? `${v.departmentIds.length} 个部门` : "", v.projectIds?.length ? `${v.projectIds.length} 个项目` : "", v.userIds?.length ? `${v.userIds.length} 位成员` : ""].filter(Boolean);
	return parts.length ? `限定：${parts.join("、")}` : "全员";
}

export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
