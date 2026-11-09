// Provider presets (UI examples + docs/models.md) and base URL normalisation.
// Presets carry NO credentials and no verification claim: base URLs are the vendors' documented endpoints as of writing and
// must be checked against the vendor's current docs. `catalogFrom` names a pi-ai built-in provider whose catalog
// (context window, price, thinking map, compat flags) is used to enrich fetched models with the same id.
import type { AuthStyle, GenericType } from "./models-types.ts";

export interface ProviderPreset {
	key: string;
	label: string;
	type: GenericType | "builtin";
	baseUrl?: string;
	builtinId?: string;
	keyless?: boolean;
	authStyle?: AuthStyle;
	catalogFrom?: string;
	/** Chinese operator hint shown under the picker. */
	hint: string;
	/** Example model ids (only suggestions for manual entry; real lists come from "获取模型列表"). */
	exampleModels?: string[];
}

export const PRESETS: ProviderPreset[] = [
	{ key: "anthropic", label: "Anthropic 官方 (Claude)", type: "anthropic-messages", baseUrl: "https://api.anthropic.com", catalogFrom: "anthropic", hint: "Base URL 不要带 /v1；密钥为 sk-ant-… 的 API Key。", exampleModels: ["claude-sonnet-5-5"] },
	{ key: "claude-relay", label: "Claude 兼容中转 (Anthropic Messages)", type: "anthropic-messages", baseUrl: "", catalogFrom: "anthropic", hint: "填中转站给你的地址（不带 /v1；带了会自动去掉）。若中转要求 Authorization: Bearer，鉴权方式选 bearer。" },
	{ key: "openai", label: "OpenAI 官方 (Responses)", type: "openai-responses", baseUrl: "https://api.openai.com/v1", catalogFrom: "openai", hint: "Base URL 带 /v1；密钥为 sk-… 的 API Key。" },
	{ key: "openai-compatible", label: "OpenAI 兼容 (Chat Completions)", type: "openai-completions", baseUrl: "", hint: "绝大多数第三方/自建网关选这个。Base URL 一般以 /v1 结尾（以厂商文档为准）。" },
	{ key: "deepseek", label: "DeepSeek", type: "openai-completions", baseUrl: "https://api.deepseek.com", catalogFrom: "deepseek", hint: "兼容 Chat Completions；pi-ai 内置 DeepSeek 的 compat 识别（thinking 参数等）。", exampleModels: ["deepseek-chat", "deepseek-reasoner"] },
	{ key: "qwen", label: "通义千问 / 百炼 DashScope（兼容模式）", type: "openai-completions", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", hint: "国际站为 dashscope-intl.aliyuncs.com；深度思考需在模型上设 compat.thinkingFormat = qwen。", exampleModels: ["qwen-plus", "qwen3-max"] },
	{ key: "moonshot", label: "Moonshot / Kimi", type: "openai-completions", baseUrl: "https://api.moonshot.cn/v1", catalogFrom: "moonshotai-cn", hint: "国际站为 api.moonshot.ai/v1。", exampleModels: ["kimi-k2-0905-preview"] },
	{ key: "zhipu", label: "智谱 GLM (BigModel)", type: "openai-completions", baseUrl: "https://open.bigmodel.cn/api/paas/v4", hint: "注意版本路径是 /api/paas/v4（不是 /v1）。思考参数用 compat.thinkingFormat = zai。", exampleModels: ["glm-4.6"] },
	{ key: "openrouter", label: "OpenRouter", type: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", catalogFrom: "openrouter", hint: "“获取模型列表”会带回价格与上下文长度；模型 id 形如 anthropic/claude-…。" },
	{ key: "siliconflow", label: "硅基流动 SiliconFlow", type: "openai-completions", baseUrl: "https://api.siliconflow.cn/v1", hint: "模型 id 形如 Qwen/Qwen3-…；列表接口不含上下文长度，需手动核对。" },
	{ key: "ollama", label: "本地 Ollama", type: "openai-completions", baseUrl: "http://localhost:11434/v1", keyless: true, hint: "无需密钥；建议设 compat.supportsDeveloperRole=false、supportsReasoningEffort=false。Docker 内访问宿主机用 host.docker.internal。", exampleModels: ["llama3.1:8b"] },
	{ key: "vllm", label: "本地 vLLM", type: "openai-completions", baseUrl: "http://localhost:8000/v1", keyless: true, hint: "启动时若带 --api-key 则不要勾选“无需密钥”。工具调用需 --enable-auto-tool-choice 与 --tool-call-parser。" },
	{ key: "lmstudio", label: "本地 LM Studio", type: "openai-completions", baseUrl: "http://localhost:1234/v1", keyless: true, hint: "在 LM Studio 的 Developer 页启动本地服务器。" },
	{ key: "azure", label: "Azure OpenAI（pi-ai 内置）", type: "builtin", builtinId: "azure", hint: "走 pi-ai 内置 azure provider：密钥 + 额外配置 AZURE_OPENAI_BASE_URL（或 AZURE_OPENAI_RESOURCE_NAME）。每个部署实例只能配置一个。" },
];

/** OpenAI SDKs append /chat/completions (or /responses) to baseUrl: keep it as the vendor documents it, only trim slashes. */
export function normalizeBaseUrl(type: string, raw: string): string {
	let u = raw.trim().replace(/\/+$/, "");
	// The Anthropic SDK appends /v1/messages itself: a trailing /v1 would produce /v1/v1/messages.
	if (type === "anthropic-messages") u = u.replace(/\/v1$/i, "");
	return u;
}

export function parseHttpUrl(raw: string): URL | null {
	try {
		const u = new URL(raw);
		return u.protocol === "http:" || u.protocol === "https:" ? u : null;
	} catch {
		return null;
	}
}

/** Header names that must not be set by admins (hop-by-hop / request framing). */
export const FORBIDDEN_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "content-type"]);
