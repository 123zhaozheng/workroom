// Model list for the switcher. GET /api/models is read tolerantly: the current shape
// ({ id, label, status, statusDetail, capabilities[], thinkingLevels[], defaultThinking, ref:{provider,modelId}, isDefault, fixture })
// and richer shapes (provider display name, capability object, context window) are both accepted.
import { useMemo } from "react";
import { FIXTURE_LABEL } from "@shared/chat";
import type { ModelCapability, ThinkingLevel } from "@shared/ops";
import { useApi } from "@/lib/useApi";
import { listOf } from "@/features/chat/pickers";

export interface ModelInfo {
	id: string;
	label: string;
	status: "ready" | "blocked" | "fixture";
	statusDetail?: string;
	isDefault: boolean;
	fixture: boolean;
	description?: string;
	provider: string;
	/** Display name of the provider (group header). */
	providerName: string;
	capabilities: ModelCapability[];
	thinkingLevels: ThinkingLevel[];
	defaultThinking?: ThinkingLevel;
	contextWindow?: number;
	ref?: { provider: string; modelId: string };
	/** The viewer's own provider (personal key). */
	personal?: boolean;
}
/** Kept for pages that only need the label/status of a model. */
export type ModelOption = Pick<ModelInfo, "id" | "label" | "status" | "statusDetail" | "isDefault" | "fixture">;

const PROVIDER_NAMES: Record<string, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	"openai-compatible": "OpenAI 兼容",
	google: "Google",
	deepseek: "DeepSeek",
	qwen: "通义千问",
	moonshot: "Moonshot",
	zhipu: "智谱",
	fixture: "测试",
	faux: "测试",
	workroom: "平台模型",
};
const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
export const THINKING_LABEL: Record<ThinkingLevel, string> = { off: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高" };

function caps(v: unknown): ModelCapability[] {
	const out = new Set<ModelCapability>();
	const add = (k: string) => {
		const x = k.toLowerCase();
		if (x === "image" || x === "images" || x === "vision" || x === "multimodal") out.add("image");
		else if (x === "tools" || x === "tool" || x === "functions" || x === "function_calling") out.add("tools");
		else if (x === "reasoning" || x === "thinking") out.add("reasoning");
		else if (x === "text") out.add("text");
	};
	if (Array.isArray(v)) for (const k of v) typeof k === "string" && add(k);
	else if (v && typeof v === "object") for (const [k, on] of Object.entries(v)) if (on) add(k);
	return [...out];
}

export function normalizeModel(raw: unknown): ModelInfo | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const id = typeof r.id === "string" ? r.id : undefined;
	if (!id) return null;
	const ref = r.ref && typeof r.ref === "object" ? (r.ref as { provider?: string; modelId?: string }) : undefined;
	const provObj = r.provider && typeof r.provider === "object" ? (r.provider as { id?: string; name?: string }) : undefined;
	const provId = (typeof r.providerId === "string" ? r.providerId : undefined) ?? (typeof r.provider === "string" ? r.provider : provObj?.id) ?? ref?.provider ?? "other";
	const status = r.status === "blocked" || r.status === "fixture" ? r.status : "ready";
	const fixture = status === "fixture" || r.fixture === true;
	const name = (typeof r.providerName === "string" && r.providerName) || provObj?.name || (fixture ? PROVIDER_NAMES.fixture! : PROVIDER_NAMES[provId] ?? (provId === "other" ? "其他" : provId));
	const levels = Array.isArray(r.thinkingLevels) ? (r.thinkingLevels.filter((l): l is ThinkingLevel => LEVELS.includes(l as ThinkingLevel)) as ThinkingLevel[]) : [];
	const capList = caps(r.capabilities);
	// round-4 fields: input: ["text","image"], reasoning: boolean
	if (Array.isArray(r.input) && r.input.includes("image") && !capList.includes("image")) capList.push("image");
	if (r.reasoning === true && !capList.includes("reasoning")) capList.push("reasoning");
	return {
		id,
		label: typeof r.label === "string" ? r.label : typeof r.name === "string" ? r.name : id,
		status,
		statusDetail: typeof r.statusDetail === "string" ? r.statusDetail : undefined,
		isDefault: r.isDefault === true,
		fixture,
		description: typeof r.description === "string" ? r.description : undefined,
		provider: provId,
		providerName: name,
		capabilities: levels.some((l) => l !== "off") && !capList.includes("reasoning") ? [...capList, "reasoning"] : capList,
		thinkingLevels: levels,
		defaultThinking: LEVELS.includes(r.defaultThinking as ThinkingLevel) ? (r.defaultThinking as ThinkingLevel) : undefined,
		contextWindow: typeof r.contextWindow === "number" ? r.contextWindow : undefined,
		ref: ref?.provider && ref.modelId ? { provider: ref.provider, modelId: ref.modelId } : undefined,
		personal: r.personal === true || undefined,
	};
}

/** The fixture model is always labelled with exactly one standard label, whatever the platform label says. */
export const modelName = (m: Pick<ModelInfo, "label" | "fixture" | "status">) => (m.fixture || m.status === "fixture" ? FIXTURE_LABEL : m.label);

export const supportsThinking = (m: ModelInfo | undefined) => !!m && m.thinkingLevels.filter((l) => l !== "off").length > 0 && m.thinkingLevels.length > 1;

export function useModels() {
	const res = useApi<unknown>("/models");
	const models = useMemo(() => listOf<unknown>(res.data, "models").map(normalizeModel).filter((m): m is ModelInfo => !!m), [res.data]);
	const defaultModelId = res.data && typeof res.data === "object" ? ((res.data as { defaultModelId?: string }).defaultModelId ?? undefined) : undefined;
	const groups = useMemo(() => {
		const map = new Map<string, ModelInfo[]>();
		for (const m of models) map.set(m.providerName, [...(map.get(m.providerName) ?? []), m]);
		return [...map.entries()].map(([name, items]) => ({ name, items }));
	}, [models]);
	return { models, groups, defaultModelId, loading: res.loading, unavailable: res.unavailable, error: res.error };
}

// ---- per-viewer default choice (the user default). Per-conversation choice is the conversation's own model on the server.
const KEY = "wr.model.default.v1";
export interface ModelChoice {
	id?: string;
	thinking?: ThinkingLevel;
}
export function readDefaultChoice(): ModelChoice {
	try {
		const raw = localStorage.getItem(KEY);
		return raw ? (JSON.parse(raw) as ModelChoice) : {};
	} catch {
		return {};
	}
}
export function writeDefaultChoice(c: ModelChoice): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(c));
	} catch {
		/* storage unavailable: the choice lasts for this page only */
	}
}

/** Resolve what the switcher should show for a new conversation. */
export function resolveChoice(models: ModelInfo[], choice: ModelChoice, serverDefaultId?: string): { model?: ModelInfo; thinking?: ThinkingLevel } {
	const usable = models.filter((m) => m.status !== "blocked");
	const model = usable.find((m) => m.id === choice.id) ?? usable.find((m) => m.id === serverDefaultId) ?? usable.find((m) => m.isDefault) ?? usable.find((m) => m.status === "ready") ?? usable[0];
	if (!model) return {};
	const thinking = supportsThinking(model) ? (choice.id === model.id && choice.thinking && model.thinkingLevels.includes(choice.thinking) ? choice.thinking : model.defaultThinking) : undefined;
	return { model, thinking };
}
