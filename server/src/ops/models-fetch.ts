// Model discovery for provider types (the `fetchModels` half of a pi-ai provider) and pi-ai catalog enrichment.
//   openai-completions / openai-responses : GET {baseUrl}/models              (OpenAI list shape; OpenRouter etc. add metadata)
//   anthropic-messages                    : GET {baseUrl}/v1/models?limit=…   (Anthropic list shape, paginated with after_id)
// Fetched ids become pi-ai `Model` objects: if pi-ai's built-in catalog knows the id (same host, or the official Anthropic / OpenAI
// catalogs for Claude/GPT ids served by a relay) its context window, price, thinking map and `compat` are used; otherwise
// conservative defaults that the admin is expected to review.
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { redactText } from "./log.ts";
import { PRESETS } from "./models-presets.ts";
import type { AuthStyle, ProviderRow } from "./models-types.ts";

export interface RemoteModel {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
	reasoning?: boolean;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	tools?: boolean;
	nonChat?: boolean;
}

export const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 8192;

let builtins: Map<string, Provider> | null = null;
/** pi-ai's own provider factories, constructed once (catalogs are static data; ~80 ms, ~10 MB). */
export async function builtinProviderMap(): Promise<Map<string, Provider>> {
	if (!builtins) {
		const all = await import("@earendil-works/pi-ai/providers/all");
		builtins = new Map(all.builtinProviders().map((p) => [p.id, p]));
	}
	return builtins;
}

const hostOf = (u: string | undefined): string | undefined => {
	try {
		return u ? new URL(u).host.toLowerCase() : undefined;
	} catch {
		return undefined;
	}
};

/** The pi-ai catalog model that describes `modelId` on this provider, if any. */
export function catalogModelFor(row: Pick<ProviderRow, "type" | "base_url" | "preset">, modelId: string, map: Map<string, Provider>): Model<Api> | undefined {
	const candidates: Provider[] = [];
	const preset = PRESETS.find((p) => p.key === row.preset)?.catalogFrom;
	if (preset && map.get(preset)) candidates.push(map.get(preset)!);
	const host = hostOf(row.base_url ?? undefined);
	if (host) for (const p of map.values()) if (hostOf(p.baseUrl) === host && !candidates.includes(p)) candidates.push(p);
	// Claude / GPT ids behind a relay: the official catalogs are the best available description.
	if (row.type === "anthropic-messages" && map.get("anthropic") && !candidates.includes(map.get("anthropic")!)) candidates.push(map.get("anthropic")!);
	if (row.type === "openai-responses" && map.get("openai") && !candidates.includes(map.get("openai")!)) candidates.push(map.get("openai")!);
	for (const p of candidates) {
		const m = p.getModels().find((x) => x.id === modelId && x.api === row.type);
		if (m) return m;
	}
	return undefined;
}

/** Wire auth for one request/list call. OpenAI SDKs need an apiKey even when the vendor wants a different header. */
export function requestAuth(type: string, style: AuthStyle, key: string | undefined): { apiKey?: string; headers: Record<string, string> } {
	if (!key) return { headers: {} };
	const anthropic = type === "anthropic-messages";
	switch (style) {
		case "bearer":
			return anthropic ? { headers: { Authorization: `Bearer ${key}` } } : { apiKey: key, headers: {} };
		case "x-api-key":
			return { apiKey: key, headers: anthropic ? {} : { "x-api-key": key } };
		case "api-key":
			return { apiKey: key, headers: { "api-key": key } };
		default:
			return { apiKey: key, headers: {} };
	}
}

const num = (v: unknown): number | undefined => {
	const n = typeof v === "string" ? Number(v) : v;
	return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
};
const NON_CHAT = /(^|[-_/])(embed|embedding|whisper|tts|dall-e|moderation|rerank|davinci|babbage|transcribe|image-gen)/i;

export function parseRemoteList(body: unknown): RemoteModel[] {
	const list: any[] = Array.isArray(body) ? body : Array.isArray((body as any)?.data) ? (body as any).data : Array.isArray((body as any)?.models) ? (body as any).models : [];
	const out: RemoteModel[] = [];
	const seen = new Set<string>();
	for (const item of list) {
		const id = typeof item === "string" ? item : (item?.id ?? item?.name ?? item?.model);
		if (typeof id !== "string" || !id || seen.has(id)) continue;
		seen.add(id);
		const m: RemoteModel = { id };
		const display = item?.display_name ?? (typeof item?.name === "string" && item.name !== id ? item.name : undefined);
		if (typeof display === "string" && display) m.name = display;
		const ctx = num(item?.context_length ?? item?.context_window ?? item?.max_context_length ?? item?.max_model_len ?? item?.max_input_tokens ?? item?.top_provider?.context_length);
		if (ctx) m.contextWindow = ctx;
		const maxTok = num(item?.max_completion_tokens ?? item?.max_output_tokens ?? item?.max_tokens ?? item?.top_provider?.max_completion_tokens);
		if (maxTok) m.maxTokens = maxTok;
		const mods: unknown = item?.architecture?.input_modalities;
		if (Array.isArray(mods)) m.input = mods.includes("image") ? ["text", "image"] : ["text"];
		else if (item?.capabilities?.image_input?.supported === true) m.input = ["text", "image"];
		const sp: unknown = item?.supported_parameters;
		if (Array.isArray(sp)) {
			m.reasoning = sp.includes("reasoning") || sp.includes("include_reasoning");
			m.tools = sp.includes("tools");
		} else if (typeof item?.capabilities?.thinking?.supported === "boolean") m.reasoning = item.capabilities.thinking.supported;
		const pr = item?.pricing;
		if (pr && (pr.prompt !== undefined || pr.completion !== undefined)) {
			const per = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) * 1e6 : 0);
			m.cost = { input: per(pr.prompt), output: per(pr.completion), cacheRead: per(pr.input_cache_read), cacheWrite: per(pr.input_cache_write) };
		}
		if (NON_CHAT.test(id)) m.nonChat = true;
		out.push(m);
	}
	return out;
}

export class ListError extends Error {
	readonly status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.status = status;
	}
}

export interface ListOptions {
	row: Pick<ProviderRow, "type" | "base_url" | "auth_style">;
	baseUrl: string;
	key?: string;
	headers: Record<string, string>;
	signal: AbortSignal;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

/** The provider type's model-list request. Errors never contain the key (and are redacted again). */
export async function listRemoteModels(o: ListOptions): Promise<{ models: RemoteModel[]; url: string; latencyMs: number }> {
	const f = o.fetchImpl ?? fetch;
	const anthropic = o.row.type === "anthropic-messages";
	const auth = requestAuth(o.row.type, o.row.auth_style, o.key);
	const headers: Record<string, string> = { accept: "application/json", ...(anthropic ? { "anthropic-version": ANTHROPIC_VERSION } : {}), ...(auth.apiKey && !anthropic ? { authorization: `Bearer ${auth.apiKey}` } : {}), ...(anthropic && auth.apiKey ? { "x-api-key": auth.apiKey } : {}), ...auth.headers, ...o.headers };
	const signal = AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs ?? 20_000)]);
	const t0 = Date.now();
	const models: RemoteModel[] = [];
	let url = "";
	let after: string | undefined;
	for (let page = 0; page < 10; page++) {
		url = anthropic ? `${o.baseUrl}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}` : `${o.baseUrl}/models`;
		let res: Response;
		try {
			res = await f(url, { headers, signal, redirect: "manual" });
		} catch (e) {
			const err = e as Error & { cause?: { code?: string; message?: string } };
			const why = err.cause?.code ?? err.cause?.message ?? err.message;
			throw new ListError(redactText(`无法连接 ${url}：${why}`));
		}
		const text = await res.text();
		if (res.status >= 300 && res.status < 400) throw new ListError(`${url} 返回重定向 ${res.status}（不跟随）；请检查 Base URL`, res.status);
		if (!res.ok) throw new ListError(redactText(`GET ${url} → HTTP ${res.status}${text ? `：${text.slice(0, 300).replace(/\s+/g, " ")}` : ""}`), res.status);
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			throw new ListError(`GET ${url} 返回的不是 JSON（可能 Base URL 缺少 /v1 或指向了网页）：${redactText(text.slice(0, 120).replace(/\s+/g, " "))}`, res.status);
		}
		models.push(...parseRemoteList(body));
		const b = body as { has_more?: boolean; last_id?: string };
		if (anthropic && b?.has_more && b.last_id) {
			after = b.last_id;
			continue;
		}
		break;
	}
	return { models, url, latencyMs: Date.now() - t0 };
}

/** Build the pi-ai Model for a fetched id: catalog metadata first, then what the endpoint told us, then defaults. */
export function modelFromRemote(row: Pick<ProviderRow, "id" | "type" | "base_url" | "preset">, baseUrl: string, r: RemoteModel, map: Map<string, Provider>): Model<Api> {
	const cat = catalogModelFor(row, r.id, map);
	const model: Record<string, unknown> = {
		id: r.id,
		name: r.name ?? cat?.name ?? r.id,
		api: row.type,
		provider: row.id,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	};
	if (cat) {
		for (const k of ["reasoning", "input", "cost", "contextWindow", "maxTokens", "thinkingLevelMap", "compat", "promptCache", "samplingParams", "samplingParamsByThinkingLevel", "headers"] as const) {
			const v = (cat as any)[k];
			if (v !== undefined) model[k] = structuredClone(v);
		}
	}
	if (r.contextWindow) model.contextWindow = r.contextWindow;
	if (r.maxTokens) model.maxTokens = Math.min(r.maxTokens, (model.contextWindow as number) || r.maxTokens);
	if (r.input) model.input = r.input;
	if (r.reasoning !== undefined && !cat) model.reasoning = r.reasoning;
	if (r.cost && !cat) model.cost = r.cost;
	return model as unknown as Model<Api>;
}
