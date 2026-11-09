// Provider / model-entry persistence + validation shared by the admin routes, the personal-key routes, the config-file
// bootstrap and the legacy migration. Everything that touches an API key goes through Gateway.sealKey().
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import * as compatSchemas from "@earendil-works/pi-ai/providers/compat-schema";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import { compile } from "@earendil-works/pi-schema";
import { HttpError, newId, nowIso } from "../core/http.ts";
import { Allowlist, resolveTarget } from "./egress.ts";
import type { Gateway } from "./gateway.ts";
import { FORBIDDEN_HEADERS, normalizeBaseUrl, parseHttpUrl } from "./models-presets.ts";
import { AUTH_STYLES, GENERIC_TYPES, json, platformId, type AuthStyle, type EntryRow, type Fallback, type ModelSpec, type ProviderRow, type ProviderScope, type ProviderType, type Visibility } from "./models-types.ts";

const ENV_REF = /^WORKROOM_[A-Z0-9_]{3,64}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const INPUTS = ["text", "image"];
const MASK = "****";

export function validateEnvRef(name: unknown, any = false): string {
	if (typeof name !== "string" || !(any ? /^[A-Z][A-Z0-9_]{2,63}$/.test(name) : ENV_REF.test(name))) throw new HttpError(400, "invalid_env", "环境变量名必须以 WORKROOM_ 开头（只能引用名字，不能写入密钥本身）");
	return name;
}

function positiveInt(v: unknown, what: string, max = 10_000_000): number {
	if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) throw new HttpError(400, "invalid_model", `${what} 需为 1–${max} 的整数`);
	return v;
}

/** Validate an admin-supplied model definition / override against pi-ai's own schemas (compat per API, thinking map, cost). */
export function validateSpec(api: string, raw: unknown): ModelSpec {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "invalid_model", "模型定义需为对象");
	const b = raw as Record<string, unknown>;
	const s: ModelSpec = {};
	if (b.name !== undefined) {
		if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 200) throw new HttpError(400, "invalid_model", "显示名称不能为空且不超过 200 字");
		s.name = b.name.trim();
	}
	if (b.contextWindow !== undefined) s.contextWindow = positiveInt(b.contextWindow, "上下文窗口");
	if (b.maxTokens !== undefined) s.maxTokens = positiveInt(b.maxTokens, "最大输出 Token");
	if (s.contextWindow && s.maxTokens && s.maxTokens > s.contextWindow) throw new HttpError(400, "invalid_model", "最大输出 Token 不能超过上下文窗口");
	if (b.input !== undefined) {
		if (!Array.isArray(b.input) || b.input.length === 0 || b.input.some((x) => !INPUTS.includes(x as string)) || !b.input.includes("text")) throw new HttpError(400, "invalid_model", "输入模态取值 text / image，且必须包含 text");
		s.input = [...new Set(b.input as ("text" | "image")[])];
	}
	if (b.reasoning !== undefined) {
		if (typeof b.reasoning !== "boolean") throw new HttpError(400, "invalid_model", "reasoning 需为布尔值");
		s.reasoning = b.reasoning;
	}
	if (b.tools !== undefined) {
		if (typeof b.tools !== "boolean") throw new HttpError(400, "invalid_model", "tools 需为布尔值");
		s.tools = b.tools;
	}
	if (b.thinkingLevelMap !== undefined) {
		const m = b.thinkingLevelMap as Record<string, unknown>;
		if (m === null || typeof m !== "object" || Array.isArray(m)) throw new HttpError(400, "invalid_thinking", "thinkingLevelMap 需为对象");
		for (const [k, v] of Object.entries(m)) {
			if (!(MODEL_THINKING_LEVELS as readonly string[]).includes(k)) throw new HttpError(400, "invalid_thinking", `思考档位 ${k} 无效（${MODEL_THINKING_LEVELS.join("/")}）`);
			if (v !== null && typeof v !== "string") throw new HttpError(400, "invalid_thinking", `thinkingLevelMap.${k} 需为字符串（发往上游的值）或 null（不支持）`);
		}
		s.thinkingLevelMap = m as Record<string, string | null>;
	}
	if (b.cost !== undefined) {
		const c = b.cost as Record<string, unknown>;
		if (c === null || typeof c !== "object") throw new HttpError(400, "invalid_price", "cost 需为对象");
		const cost: NonNullable<ModelSpec["cost"]> = {};
		for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			if (c[k] === undefined) continue;
			if (typeof c[k] !== "number" || !Number.isFinite(c[k] as number) || (c[k] as number) < 0) throw new HttpError(400, "invalid_price", "价格需为每百万 Token 的非负数（input/output/cacheRead/cacheWrite）");
			cost[k] = c[k] as number;
		}
		s.cost = cost;
	}
	if (b.compat !== undefined) {
		const c = b.compat as Record<string, unknown>;
		if (c === null || typeof c !== "object" || Array.isArray(c)) throw new HttpError(400, "invalid_compat", "compat 需为对象");
		const schema = (compatSchemas.CompatSchemasByApi as Record<string, any>)[api];
		if (!schema) throw new HttpError(400, "invalid_compat", `API ${api} 没有 compat 选项`);
		const known = Object.keys(schema.properties ?? {});
		const unknown = Object.keys(c).filter((k) => !known.includes(k));
		if (unknown.length) throw new HttpError(400, "invalid_compat", `未知的 compat 选项：${unknown.join(", ")}（${api} 支持：${known.join(", ")}）`);
		const v = compile(schema);
		if (!v.check(c)) throw new HttpError(400, "invalid_compat", `compat 无效：${v.errors(c).map((e) => `${e.path || "/"} ${e.message}`).join("; ")}`);
		s.compat = c;
	}
	return s;
}

export function validateVisibility(v: unknown): Visibility | null {
	if (v === null || v === undefined) return null;
	if (typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "invalid_visibility", "visibility 需为对象或 null");
	const out: Visibility = {};
	for (const k of ["departmentIds", "projectIds", "userIds"] as const) {
		const a = (v as Record<string, unknown>)[k];
		if (a === undefined) continue;
		if (!Array.isArray(a) || a.some((x) => typeof x !== "string" || !x) || a.length > 200) throw new HttpError(400, "invalid_visibility", `${k} 需为字符串数组`);
		if (a.length) out[k] = a as string[];
	}
	return Object.keys(out).length ? out : null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "provider";

export interface ProviderInput {
	id?: string;
	name?: string;
	type?: string;
	builtinId?: string;
	preset?: string;
	baseUrl?: string | null;
	apiKey?: string | null;
	apiKeyEnv?: string | null;
	headers?: Record<string, string> | null;
	env?: Record<string, string> | null;
	keyless?: boolean;
	authStyle?: string;
	timeoutMs?: number | null;
	status?: string;
}

export interface Owner {
	scope: ProviderScope;
	orgId: string | null;
	userId: string | null;
	source: ProviderRow["source"];
	/** Config-file providers may name any environment variable; admins only WORKROOM_*. */
	anyEnv?: boolean;
	/** Fixed id (config file / env bootstrap). */
	fixedId?: boolean;
}

async function checkBaseUrl(gw: Gateway, scope: ProviderScope, url: string): Promise<void> {
	const u = parseHttpUrl(url);
	if (!u) throw new HttpError(400, "invalid_base_url", "Base URL 需以 http:// 或 https:// 开头");
	if (u.username || u.password) throw new HttpError(400, "invalid_base_url", "Base URL 不得包含用户名/密码（密钥请填在 API Key 里）");
	// Personal providers name hosts chosen by an end user: refuse internal / metadata addresses (SSRF).
	if (scope === "user") await resolveTarget(url, new Allowlist([]), gw.resolver);
}

function sealHeaders(gw: Gateway, h: Record<string, string>): string | null {
	const names = Object.keys(h);
	if (names.length === 0) return null;
	if (names.length > 20) throw new HttpError(400, "invalid_headers", "自定义请求头最多 20 个");
	for (const [k, v] of Object.entries(h)) {
		if (!HEADER_NAME.test(k) || FORBIDDEN_HEADERS.has(k.toLowerCase())) throw new HttpError(400, "invalid_headers", `请求头名称无效或不允许：${k}`);
		if (typeof v !== "string" || v.length > 4000 || /[\r\n]/.test(v)) throw new HttpError(400, "invalid_headers", `请求头 ${k} 的值无效`);
	}
	return gw.secrets.seal(JSON.stringify(h));
}

function sealEnv(gw: Gateway, env: Record<string, string>): string | null {
	if (Object.keys(env).length === 0) return null;
	for (const [k, v] of Object.entries(env)) if (!/^[A-Z][A-Z0-9_]{2,60}$/.test(k) || typeof v !== "string" || v.length > 2000) throw new HttpError(400, "invalid_env", `额外配置 ${k} 无效`);
	return gw.secrets.seal(JSON.stringify(env));
}

export async function createProviderRow(gw: Gateway, owner: Owner, input: ProviderInput, actorId: string | null): Promise<ProviderRow> {
	const name = (input.name ?? "").trim();
	if (!name || name.length > 80) throw new HttpError(400, "invalid", "名称必填，且不超过 80 字");
	const type = input.type as ProviderType;
	if (!(GENERIC_TYPES as readonly string[]).includes(type) && type !== "builtin") throw new HttpError(400, "invalid_type", `类型取值：${GENERIC_TYPES.join(" / ")} / builtin`);
	let id: string;
	let builtinId: string | null = null;
	if (type === "builtin") {
		builtinId = input.builtinId ?? "";
		if (!gw.builtinProviders().has(builtinId)) throw new HttpError(400, "invalid_builtin", `pi-ai 没有内置 provider「${builtinId}」`);
		if (owner.scope === "user") throw new HttpError(403, "builtin_not_personal", "pi-ai 内置 provider 在部署内只能有一个实例，不能作为个人密钥");
		id = builtinId;
		if (gw.rowOf(id)) throw new HttpError(409, "exists", `内置 provider「${id}」已在本部署中配置`);
	} else {
		if (input.id !== undefined && owner.fixedId) {
			if (!/^[a-z][a-z0-9-]{1,40}$/.test(input.id) || gw.isReserved(input.id)) throw new HttpError(400, "invalid_id", `provider id 无效或保留：${input.id}`);
			id = input.id;
			if (gw.rowOf(id)) throw new HttpError(409, "exists", `provider id 已存在：${id}`);
		} else {
			do id = `${slug(name)}-${newId("x").slice(-4)}`;
			while (gw.rowOf(id) || gw.isReserved(id));
		}
	}
	if (type !== "builtin" && !input.baseUrl?.trim()) throw new HttpError(400, "invalid", "Base URL 必填");
	if (input.baseUrl) await checkBaseUrl(gw, owner.scope, input.baseUrl);
	const authStyle = (input.authStyle ?? "default") as AuthStyle;
	if (!AUTH_STYLES.includes(authStyle)) throw new HttpError(400, "invalid_auth_style", `鉴权方式取值：${AUTH_STYLES.join(" / ")}`);
	if (input.timeoutMs != null && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 600_000)) throw new HttpError(400, "invalid", "timeoutMs 取值 1000–600000");
	if (input.apiKeyEnv && owner.scope === "user") throw new HttpError(400, "invalid_env", "个人服务商不能引用服务器环境变量");
	const keyEnv = input.apiKeyEnv ? validateEnvRef(input.apiKeyEnv, owner.anyEnv) : null;
	const sealed = input.apiKey ? gw.sealKey(String(input.apiKey)) : null; // 409 secret_key_missing without WORKROOM_SECRET_KEY
	const headersEnc = input.headers ? sealHeaders(gw, input.headers) : null;
	const envEnc = input.env ? sealEnv(gw, input.env) : null;
	const now = nowIso();
	gw.db.run(
		`INSERT INTO model_providers (id, scope, org_id, owner_user_id, name, type, builtin_id, preset, base_url, api_key_enc, api_key_env, key_hint, headers_enc, env_enc, keyless, auth_style, timeout_ms, status, source, created_by, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'enabled', ?, ?, ?, ?)`,
		id,
		owner.scope,
		owner.orgId,
		owner.userId,
		name,
		type,
		builtinId,
		input.preset ?? null,
		input.baseUrl ? normalizeBaseUrl(type, input.baseUrl) : null,
		sealed?.enc ?? null,
		keyEnv,
		sealed?.hint ?? null,
		headersEnc,
		envEnc,
		input.keyless ? 1 : 0,
		authStyle,
		input.timeoutMs ?? null,
		owner.source,
		actorId,
		now,
		now,
	);
	gw.invalidate();
	return gw.rowOf(id)!;
}

export async function updateProviderRow(gw: Gateway, row: ProviderRow, input: ProviderInput, owner: Owner): Promise<ProviderRow> {
	const set: string[] = [];
	const vals: (string | number | null)[] = [];
	const add = (col: string, v: string | number | null) => (set.push(`${col} = ?`), vals.push(v));
	if (input.name !== undefined) {
		const n = input.name.trim();
		if (!n || n.length > 80) throw new HttpError(400, "invalid", "名称必填，且不超过 80 字");
		add("name", n);
	}
	if (input.baseUrl !== undefined) {
		if (row.type !== "builtin") {
			if (!input.baseUrl?.trim()) throw new HttpError(400, "invalid", "Base URL 不能为空");
			await checkBaseUrl(gw, owner.scope, input.baseUrl);
			add("base_url", normalizeBaseUrl(row.type, input.baseUrl));
		}
	} else if (owner.scope === "user" && row.base_url) await checkBaseUrl(gw, "user", row.base_url);
	if (input.apiKey !== undefined) {
		if (input.apiKey === null) (add("api_key_enc", null), add("key_hint", null));
		else {
			const s = gw.sealKey(String(input.apiKey));
			add("api_key_enc", s.enc);
			add("key_hint", s.hint);
		}
	}
	if (input.apiKeyEnv !== undefined) {
		if (input.apiKeyEnv && owner.scope === "user") throw new HttpError(400, "invalid_env", "个人服务商不能引用服务器环境变量");
		add("api_key_env", input.apiKeyEnv ? validateEnvRef(input.apiKeyEnv, owner.anyEnv) : null);
	}
	if (input.headers !== undefined) {
		if (input.headers === null) add("headers_enc", null);
		else {
			// A header the client echoes back masked keeps its stored value, so the UI never needs the secret.
			const old = row.headers_enc ? (JSON.parse(gw.secrets.open(row.headers_enc)) as Record<string, string>) : {};
			const next: Record<string, string> = {};
			for (const [k, v] of Object.entries(input.headers)) next[k] = v === MASK ? (Object.entries(old).find(([ok]) => ok.toLowerCase() === k.toLowerCase())?.[1] ?? "") : v;
			add("headers_enc", sealHeaders(gw, next));
		}
	}
	if (input.env !== undefined) add("env_enc", input.env === null ? null : sealEnv(gw, input.env));
	if (input.keyless !== undefined) add("keyless", input.keyless ? 1 : 0);
	if (input.preset !== undefined) add("preset", input.preset);
	if (input.authStyle !== undefined) {
		if (!AUTH_STYLES.includes(input.authStyle as AuthStyle)) throw new HttpError(400, "invalid_auth_style", `鉴权方式取值：${AUTH_STYLES.join(" / ")}`);
		add("auth_style", input.authStyle);
	}
	if (input.timeoutMs !== undefined) {
		if (input.timeoutMs !== null && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 600_000)) throw new HttpError(400, "invalid", "timeoutMs 取值 1000–600000");
		add("timeout_ms", input.timeoutMs);
	}
	if (input.status !== undefined) {
		if (input.status !== "enabled" && input.status !== "disabled") throw new HttpError(400, "invalid", "status 无效");
		add("status", input.status);
	}
	if (set.length) {
		add("updated_at", nowIso());
		gw.db.run(`UPDATE model_providers SET ${set.join(", ")} WHERE id = ?`, ...vals, row.id);
	}
	await gw.reload(row.id);
	return gw.rowOf(row.id)!;
}

export async function deleteProviderRow(gw: Gateway, row: ProviderRow): Promise<void> {
	gw.db.tx(() => {
		gw.db.run("DELETE FROM model_entries WHERE provider_id = ?", row.id);
		gw.db.run("DELETE FROM model_catalog WHERE provider_id = ?", row.id);
		gw.db.run("DELETE FROM model_aliases WHERE provider_id = ?", row.id);
		gw.db.run("DELETE FROM model_providers WHERE id = ?", row.id);
	});
	await gw.reload(row.id);
	gw.refreshAliases();
}

export interface EntryPatch {
	manual?: boolean;
	spec?: unknown;
	/** Drop all overrides on a catalog model. */
	resetSpec?: boolean;
	enabled?: boolean;
	visibility?: unknown;
	fallbacks?: unknown;
	defaultThinking?: string | null;
	sort?: number;
	description?: string | null;
}

export function validateFallbacks(gw: Gateway, row: ProviderRow, v: unknown): Fallback[] {
	if (!Array.isArray(v) || v.length > 5) throw new HttpError(400, "invalid_fallbacks", "fallbacks 需为不超过 5 项的数组");
	const out: Fallback[] = [];
	for (const f of v) {
		if (!f || typeof f.provider !== "string" || typeof f.modelId !== "string") throw new HttpError(400, "invalid_fallbacks", "每项需为 { provider, modelId }");
		const fr = gw.rowOf(f.provider);
		const ok = fr && (fr.scope === "instance" || (fr.scope === "org" && fr.org_id === row.org_id) || (fr.scope === "user" && fr.owner_user_id === row.owner_user_id && fr.id === row.id));
		if (!ok || !gw.effectiveModels(f.provider).some((m) => m.id === f.modelId)) throw new HttpError(400, "invalid_fallbacks", `备用模型 ${f.provider}/${f.modelId} 不存在或不可用于此服务商`);
		out.push({ provider: f.provider, modelId: f.modelId });
	}
	return out;
}

export function saveEntry(gw: Gateway, row: ProviderRow, modelId: string, patch: EntryPatch, opts: { create?: boolean } = {}): EntryRow {
	if (!modelId || modelId.length > 300) throw new HttpError(400, "invalid_model", "模型 ID 无效");
	const existing = gw.entryOf(row.id, modelId);
	const api = row.type === "builtin" ? (gw.effectiveModels(row.id)[0]?.api ?? "openai-completions") : row.type;
	let spec = json<ModelSpec>(existing?.spec, {});
	if (patch.resetSpec) spec = {};
	if (patch.spec !== undefined) spec = { ...spec, ...validateSpec(api, patch.spec) };
	const manual = patch.manual ?? existing?.manual ?? 0;
	if (!existing && !manual && !gw.effectiveModels(row.id).some((m) => m.id === modelId)) throw new HttpError(404, "model_not_found", `服务商的模型目录中没有「${modelId}」：请先“获取模型列表”，或作为手动模型添加`);
	if (manual && !spec.name) spec.name = existing ? (spec.name ?? modelId) : modelId;
	const enabled = patch.enabled === undefined ? (existing?.enabled ?? (manual ? 1 : 0)) : patch.enabled ? 1 : 0;
	const visibility = patch.visibility === undefined ? (existing?.visibility ?? null) : (() => { const v = validateVisibility(patch.visibility); return v ? JSON.stringify(v) : null; })();
	const fallbacks = patch.fallbacks === undefined ? (existing?.fallbacks ?? null) : (() => { const f = validateFallbacks(gw, row, patch.fallbacks); return f.length ? JSON.stringify(f) : null; })();
	let defaultThinking = existing?.default_thinking ?? null;
	if (patch.defaultThinking !== undefined) {
		if (patch.defaultThinking !== null && !(MODEL_THINKING_LEVELS as readonly string[]).includes(patch.defaultThinking)) throw new HttpError(400, "invalid_thinking", "默认思考档位无效");
		defaultThinking = patch.defaultThinking;
	}
	const now = nowIso();
	const specJson = Object.keys(spec).length ? JSON.stringify(spec) : null;
	gw.db.run(
		`INSERT INTO model_entries (provider_id, model_id, manual, spec, enabled, visibility, fallbacks, default_thinking, sort, description, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(provider_id, model_id) DO UPDATE SET manual = excluded.manual, spec = excluded.spec, enabled = excluded.enabled, visibility = excluded.visibility, fallbacks = excluded.fallbacks,
		   default_thinking = excluded.default_thinking, sort = excluded.sort, description = excluded.description, updated_at = excluded.updated_at`,
		row.id,
		modelId,
		manual ? 1 : 0,
		specJson,
		enabled,
		visibility,
		fallbacks,
		defaultThinking,
		patch.sort ?? existing?.sort ?? 0,
		patch.description === undefined ? (existing?.description ?? null) : patch.description,
		existing?.created_at ?? now,
		now,
	);
	gw.invalidate();
	return gw.entryOf(row.id, modelId)!;
}

export async function removeEntry(gw: Gateway, row: ProviderRow, modelId: string): Promise<void> {
	gw.db.run("DELETE FROM model_entries WHERE provider_id = ? AND model_id = ?", row.id, modelId);
	gw.invalidate();
}

// ---------------------------------------------------------------- DTOs
export function providerDto(gw: Gateway, row: ProviderRow, viewerOrgId?: string) {
	const h = gw.providerHealth(row);
	const entries = [...gw.entriesOf(row.id).values()];
	return {
		id: row.id,
		name: row.name,
		scope: row.scope,
		orgId: row.org_id ?? undefined,
		ownerUserId: row.owner_user_id ?? undefined,
		type: row.type === "builtin" ? ("builtin" as const) : row.type,
		builtinId: row.builtin_id ?? undefined,
		preset: row.preset ?? undefined,
		baseUrl: row.base_url ?? undefined,
		authStyle: row.auth_style,
		keyless: !!row.keyless,
		credential: gw.credentialInfo(row),
		headerNames: gw.headerNames(row),
		envKeys: gw.envOf(row),
		timeoutMs: row.timeout_ms ?? undefined,
		status: row.status,
		health: h.health,
		healthDetail: h.detail,
		lastCheck: json(row.last_check, undefined),
		lastFetchAt: row.last_fetch_at ?? undefined,
		source: row.source,
		modelCount: gw.effectiveModels(row.id).length,
		enabledModelCount: entries.filter((e) => e.enabled).length,
		/** Instance-level (operator / env / config file) providers are read-only for org admins. */
		readOnly: row.scope === "instance" && viewerOrgId !== undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

const NON_CHAT = /(^|[-_/])(embed|embedding|whisper|tts|dall-e|moderation|rerank|davinci|babbage|transcribe|image-gen)/i;

export function adminModelDto(gw: Gateway, row: ProviderRow, m: Model<Api>, def?: { provider: string; modelId: string }) {
	const e = gw.entryOf(row.id, m.id);
	const spec = json<ModelSpec>(e?.spec, {});
	return {
		id: platformId(row.id, m.id),
		providerId: row.id,
		modelId: m.id,
		name: m.name,
		manual: !!e?.manual,
		overridden: !!e?.spec && !e.manual,
		enabled: !!e?.enabled,
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		input: [...m.input],
		reasoning: m.reasoning,
		thinkingLevels: getSupportedThinkingLevels(m).filter((l) => (l as string) !== "max"),
		thinkingLevelMap: (m as any).thinkingLevelMap ?? undefined,
		cost: { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead, cacheWrite: m.cost.cacheWrite },
		compat: (m as any).compat ?? undefined,
		tools: spec.tools !== false,
		capabilities: ["text", ...(spec.tools === false ? [] : ["tools"]), ...(m.input.includes("image") ? ["image"] : []), ...(m.reasoning ? ["reasoning"] : [])],
		visibility: json<Visibility | null>(e?.visibility, null),
		fallbacks: json<Fallback[]>(e?.fallbacks, []),
		defaultThinking: e?.default_thinking ?? undefined,
		description: e?.description ?? undefined,
		sort: e?.sort ?? 0,
		nonChat: NON_CHAT.test(m.id),
		isDefault: def?.provider === row.id && def.modelId === m.id,
	};
}
