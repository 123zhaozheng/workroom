// Model providers (模型服务商), pi-ai native. One row = one pi-ai Provider registered in the single MutableModels instance
// the runtime uses (createProvider({ id, name, baseUrl, headers, auth, models, fetchModels, api }) + setProvider).
// Conversations store the native pi-durable ref { provider: row.id, modelId }.
import type { ModelRef } from "../core/contracts.ts";

/** Wire protocols that pi-ai ships an API implementation for and that "any compatible endpoint" can speak. */
export const GENERIC_TYPES = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type GenericType = (typeof GENERIC_TYPES)[number];
/** `builtin` = one of pi-ai's own provider factories (bedrock, google, mistral, azure, ...); `faux` = in-process test provider. */
export type ProviderType = GenericType | "builtin" | "faux";
export type ProviderScope = "instance" | "org" | "user";
export type AuthStyle = "default" | "bearer" | "x-api-key" | "api-key";
export const AUTH_STYLES: readonly AuthStyle[] = ["default", "bearer", "x-api-key", "api-key"];

export const FIXTURE_PI_PROVIDER = "fixture";
export const FIXTURE_MODEL_ID = "workroom-fixture";
/** Legacy alias provider: keeps refs `{provider:"workroom", modelId:<old platform model id>}` of existing conversations working. */
export const WORKROOM_PI_PROVIDER = "workroom";
export const RESERVED_PROVIDER_IDS = new Set<string>([FIXTURE_PI_PROVIDER, WORKROOM_PI_PROVIDER]);

export interface ProviderRow {
	id: string;
	scope: ProviderScope;
	org_id: string | null;
	owner_user_id: string | null;
	name: string;
	type: ProviderType;
	builtin_id: string | null;
	preset: string | null;
	base_url: string | null;
	api_key_enc: string | null;
	api_key_env: string | null;
	key_hint: string | null;
	headers_enc: string | null;
	env_enc: string | null;
	keyless: number;
	auth_style: AuthStyle;
	timeout_ms: number | null;
	status: "enabled" | "disabled";
	source: "admin" | "personal" | "config" | "env" | "migration" | "test";
	last_check: string | null;
	last_fetch_at: string | null;
	created_by: string | null;
	created_at: string;
	updated_at: string;
}

export interface Visibility {
	departmentIds?: string[];
	projectIds?: string[];
	userIds?: string[];
}

/** Partial pi Model fields an admin may define (manual model) or override on a fetched / built-in catalog model. */
export interface ModelSpec {
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	/** USD per million tokens. */
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	/** pi-ai `compat` for the model's api (OpenAICompletionsCompat / OpenAIResponsesCompat / AnthropicMessagesCompat). */
	compat?: Record<string, unknown>;
	/** Whether the endpoint accepts tool definitions at all (display + failover choice; pi-ai has no such flag). */
	tools?: boolean;
}

export interface EntryRow {
	provider_id: string;
	model_id: string;
	manual: number;
	spec: string | null;
	enabled: number;
	visibility: string | null;
	fallbacks: string | null;
	default_thinking: string | null;
	sort: number;
	description: string | null;
	created_at: string;
	updated_at: string;
}

export interface AliasRow {
	alias_id: string;
	provider_id: string;
	model_id: string;
	label: string | null;
	org_id: string | null;
	created_at: string;
}

export type Fallback = ModelRef;

export const platformId = (provider: string, modelId: string): string => (provider === FIXTURE_PI_PROVIDER ? modelId : provider === WORKROOM_PI_PROVIDER ? modelId : `${provider}/${modelId}`);

export function json<T>(s: string | null | undefined, fallback: T): T {
	if (!s) return fallback;
	try {
		return JSON.parse(s) as T;
	} catch {
		return fallback;
	}
}
