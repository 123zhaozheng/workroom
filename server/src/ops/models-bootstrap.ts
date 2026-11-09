// Startup population of model providers, in this order (all pure DB work, no network):
//   1. legacy WORKROOM_ANTHROPIC_* / WORKROOM_OPENAI_* / WORKROOM_OPENAI_COMPAT_* env vars  -> instance providers env-anthropic / env-openai / env-compat
//   2. one-time migration of the pre-round-4 channel / platform-model / route tables        -> providers, model entries, fallbacks, legacy aliases
//   3. workroom.models.json (WORKROOM_MODELS_CONFIG, <data dir>/, or ./)                      -> instance providers (source "config"), authoritative for those
// Keys are NEVER read from the file: providers name an environment variable (`apiKeyEnv`) which is resolved when a request is made.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AppContext } from "../core/contracts.ts";
import { nowIso } from "../core/http.ts";
import type { Gateway } from "./gateway.ts";
import { logEvent } from "./log.ts";
import { createProviderRow, saveEntry, updateProviderRow, validateEnvRef, type ProviderInput } from "./models-service.ts";
import { GENERIC_TYPES, json, type ModelSpec, type ProviderRow } from "./models-types.ts";

export interface ConfigReport {
	path?: string;
	providers: string[];
	errors: string[];
}
export const configReport: ConfigReport = { providers: [], errors: [] };

const slugId = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const metaGet = (ctx: AppContext, k: string) => ctx.db.get<{ value: string }>("SELECT value FROM model_meta WHERE key = ?", k)?.value;
const metaSet = (ctx: AppContext, k: string, v: string) => ctx.db.run("INSERT INTO model_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", k, v, nowIso());

/** ModelSpec equivalent of a pi-ai catalog model (what the admin would otherwise type in by hand). */
export function specFromModel(m: Model<Api>): ModelSpec {
	const spec: ModelSpec = { name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens, input: [...m.input] as ("text" | "image")[], reasoning: m.reasoning, cost: { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead, cacheWrite: m.cost.cacheWrite } };
	if ((m as any).thinkingLevelMap) spec.thinkingLevelMap = (m as any).thinkingLevelMap;
	if ((m as any).compat) spec.compat = (m as any).compat;
	return spec;
}

// ------------------------------------------------------------------------------------------------ upsert helper (instance providers)
async function upsertInstanceProvider(gw: Gateway, id: string, input: ProviderInput, source: "env" | "config", opts: { anyEnv?: boolean } = {}): Promise<ProviderRow> {
	const existing = gw.rowOf(id);
	const owner = { scope: "instance" as const, orgId: null, userId: null, source, anyEnv: opts.anyEnv, fixedId: true };
	if (existing) {
		if (existing.source !== source) throw new Error(`provider id「${id}」已被其他来源（${existing.source}）占用`);
		const { type: _t, builtinId: _b, id: _i, ...patch } = input;
		return updateProviderRow(gw, existing, patch, owner);
	}
	return createProviderRow(gw, owner, { ...input, id }, null);
}

// ------------------------------------------------------------------------------------------------ 1. env
const ENV_DEFAULT_MODELS = { anthropic: "claude-sonnet-5-5", openai: "gpt-6-sol" };

async function bootstrapEnv(ctx: AppContext, gw: Gateway): Promise<void> {
	const env = process.env;
	const cat = (provider: string, modelId: string): ModelSpec | undefined => {
		const m = gw.builtinProviders().get(provider)?.getModels().find((x) => x.id === modelId);
		return m ? specFromModel(m as Model<Api>) : undefined;
	};
	const defs: { id: string; name: string; type: ProviderInput["type"]; baseUrl: string; keyEnv: string; keyless?: boolean; modelId: string; label: string; spec?: ModelSpec; show: boolean; legacyAlias: string }[] = [
		{ id: "env-anthropic", name: "Anthropic（环境变量）", type: "anthropic-messages", baseUrl: env.WORKROOM_ANTHROPIC_BASE_URL || "https://api.anthropic.com", keyEnv: "WORKROOM_ANTHROPIC_API_KEY", modelId: env.WORKROOM_ANTHROPIC_MODEL || ENV_DEFAULT_MODELS.anthropic, label: "Claude", spec: cat("anthropic", env.WORKROOM_ANTHROPIC_MODEL || ENV_DEFAULT_MODELS.anthropic), show: !!env.WORKROOM_ANTHROPIC_API_KEY, legacyAlias: "claude" },
		{ id: "env-openai", name: "OpenAI（环境变量）", type: "openai-responses", baseUrl: env.WORKROOM_OPENAI_BASE_URL || "https://api.openai.com/v1", keyEnv: "WORKROOM_OPENAI_API_KEY", modelId: env.WORKROOM_OPENAI_MODEL || ENV_DEFAULT_MODELS.openai, label: "GPT", spec: cat("openai", env.WORKROOM_OPENAI_MODEL || ENV_DEFAULT_MODELS.openai), show: !!env.WORKROOM_OPENAI_API_KEY, legacyAlias: "gpt" },
		{ id: "env-compat", name: "OpenAI 兼容端点（环境变量）", type: "openai-completions", baseUrl: env.WORKROOM_OPENAI_COMPAT_BASE_URL ?? "", keyEnv: "WORKROOM_OPENAI_COMPAT_API_KEY", keyless: !env.WORKROOM_OPENAI_COMPAT_API_KEY, modelId: env.WORKROOM_OPENAI_COMPAT_MODEL || "default", label: env.WORKROOM_OPENAI_COMPAT_LABEL || "兼容模型", show: !!env.WORKROOM_OPENAI_COMPAT_BASE_URL, legacyAlias: "compat" },
	];
	for (const d of defs) {
		if (!d.show) continue;
		try {
			const row = await upsertInstanceProvider(gw, d.id, { name: d.name, type: d.type, baseUrl: d.baseUrl, apiKeyEnv: d.keyless ? null : d.keyEnv, keyless: d.keyless }, "env", { anyEnv: true });
			saveEntry(gw, row, d.modelId, { manual: true, spec: { ...(d.spec ?? { contextWindow: 128_000, maxTokens: 8192 }), name: d.label }, enabled: true, sort: d.id === "env-anthropic" ? 10 : d.id === "env-openai" ? 20 : 30 });
		} catch (e) {
			configReport.errors.push(`${d.id}: ${(e as Error).message}`);
			logEvent("error", "model.env_bootstrap_failed", { provider: d.id, detail: (e as Error).message });
		}
	}
}

// ------------------------------------------------------------------------------------------------ 2. legacy tables
interface OldChannel { id: string; org_id: string | null; name: string; provider: string; base_url: string | null; api_key_enc: string | null; api_key_env: string | null; key_hint: string | null; status: string; timeout_ms: number | null; price: string | null; builtin: number }
interface OldModel { id: string; org_id: string | null; label: string; description: string | null; kind: string; capabilities: string; thinking_levels: string; default_thinking: string | null; context_window: number | null; max_tokens: number | null; visibility: string | null; is_default: number; enabled: number; sort: number; builtin: number }
interface OldRoute { platform_model_id: string; channel_id: string; upstream_model_id: string; priority: number; enabled: number; capabilities: string | null }

const OLD_TYPE: Record<string, ProviderRow["type"]> = { anthropic: "anthropic-messages", openai: "openai-responses", "openai-compatible": "openai-completions" };
const LEVELS = ["minimal", "low", "medium", "high", "xhigh"];

/**
 * Pre-round-4 data: channels → providers (same ciphertext, same WORKROOM_SECRET_KEY), org platform models → manual model entries on their
 * first route's provider, further routes → that model's `fallbacks`, price → model cost, visibility/default carried over, and every old
 * platform-model id → an alias so conversations holding `{provider:"workroom", modelId:<old id>}` keep working. Runs once.
 */
export function migrateLegacy(ctx: AppContext, gw: Gateway): { providers: number; models: number; aliases: number } {
	const done = { providers: 0, models: 0, aliases: 0 };
	if (metaGet(ctx, "legacy_migrated")) return done;
	const db = ctx.db;
	const channels = db.all<OldChannel>("SELECT * FROM ops_channels WHERE builtin = 0 AND provider IN ('anthropic','openai','openai-compatible')");
	const provOf = new Map<string, { id: string; price?: { input: number; output: number; cacheRead: number; cacheWrite: number } }>();
	const now = nowIso();
	db.tx(() => {
		for (const ch of channels) {
			const id = `legacy-${slugId(ch.id) || slugId(ch.name)}`;
			const type = OLD_TYPE[ch.provider]!;
			const baseUrl = ch.base_url || (type === "anthropic-messages" ? "https://api.anthropic.com" : type === "openai-responses" ? "https://api.openai.com/v1" : null);
			db.run(
				`INSERT OR IGNORE INTO model_providers (id, scope, org_id, name, type, base_url, api_key_enc, api_key_env, key_hint, keyless, auth_style, timeout_ms, status, source, created_at, updated_at)
				 VALUES (?, 'org', ?, ?, ?, ?, ?, ?, ?, ?, 'default', ?, ?, 'migration', ?, ?)`,
				id,
				ch.org_id,
				ch.name,
				type,
				baseUrl,
				ch.api_key_enc,
				ch.api_key_env,
				ch.key_hint,
				ch.provider === "openai-compatible" && !ch.api_key_enc && !ch.api_key_env ? 1 : 0,
				ch.timeout_ms,
				ch.status,
				now,
				now,
			);
			provOf.set(ch.id, { id, price: json(ch.price, undefined) });
			done.providers++;
		}
		const models = db.all<OldModel>("SELECT * FROM ops_platform_models");
		const routes = db.all<OldRoute>("SELECT * FROM ops_model_routes WHERE enabled = 1 ORDER BY priority, rowid");
		const entry = (providerId: string, modelId: string, spec: ModelSpec, extra: { enabled: number; visibility?: string | null; fallbacks?: string | null; thinking?: string | null; description?: string | null; sort?: number }) => {
			const r = db.run(
				`INSERT OR IGNORE INTO model_entries (provider_id, model_id, manual, spec, enabled, visibility, fallbacks, default_thinking, sort, description, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				providerId,
				modelId,
				JSON.stringify(spec),
				extra.enabled,
				extra.visibility ?? null,
				extra.fallbacks ?? null,
				extra.thinking ?? null,
				extra.sort ?? 0,
				extra.description ?? null,
				now,
				now,
			);
			if (r.changes) done.models++;
		};
		for (const pm of models) {
			if (pm.kind === "fixture") continue;
			const caps = json<string[]>(pm.capabilities, ["text"]);
			const levels = json<string[]>(pm.thinking_levels, ["off"]);
			const mine = routes.filter((r) => r.platform_model_id === pm.id);
			const targets = mine.map((r) => ({ r, p: provOf.get(r.channel_id) })).filter((x): x is { r: OldRoute; p: { id: string; price?: any } } => !!x.p);
			let primary: { providerId: string; modelId: string } | undefined;
			if (targets.length) {
				const first = targets[0]!;
				primary = { providerId: first.p.id, modelId: first.r.upstream_model_id };
				const spec = (t: typeof first, name: string): ModelSpec => ({
					name,
					contextWindow: pm.context_window ?? undefined,
					maxTokens: pm.max_tokens ?? undefined,
					input: (t.r.capabilities ? json<string[]>(t.r.capabilities, caps) : caps).includes("image") ? ["text", "image"] : ["text"],
					reasoning: caps.includes("reasoning"),
					...(caps.includes("reasoning") ? { thinkingLevelMap: Object.fromEntries(LEVELS.filter((l) => !levels.includes(l)).map((l) => [l, null])) } : {}),
					...(t.p.price ? { cost: t.p.price } : {}),
					tools: caps.includes("tools"),
				});
				const fallbacks = targets.slice(1).map((t) => ({ provider: t.p.id, modelId: t.r.upstream_model_id }));
				entry(first.p.id, first.r.upstream_model_id, spec(first, pm.label), { enabled: pm.enabled ? 1 : 0, visibility: pm.visibility, fallbacks: fallbacks.length ? JSON.stringify(fallbacks) : null, thinking: pm.default_thinking, description: pm.description, sort: pm.sort });
				for (const t of targets.slice(1)) entry(t.p.id, t.r.upstream_model_id, spec(t, `${pm.label}（备用）`), { enabled: 0 });
				if (pm.is_default && pm.org_id) db.run("INSERT OR IGNORE INTO ops_settings (org_id, key, value, updated_at) VALUES (?, 'default_model', ?, ?)", pm.org_id, JSON.stringify({ provider: first.p.id, modelId: first.r.upstream_model_id }), now);
			} else if (pm.builtin) {
				// env-seeded models (claude / gpt / compat) → the env provider created in step 1, when its variables are set.
				const envProv = { claude: "env-anthropic", gpt: "env-openai", compat: "env-compat" }[pm.id];
				const row = envProv ? gw.rowOf(envProv) : undefined;
				const mid = row ? [...gw.entriesOf(row.id).keys()][0] : undefined;
				if (row && mid) primary = { providerId: row.id, modelId: mid };
			}
			if (primary) {
				db.run("INSERT OR IGNORE INTO model_aliases (alias_id, provider_id, model_id, label, org_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", pm.id, primary.providerId, primary.modelId, pm.label, pm.org_id, now);
				done.aliases++;
			}
		}
		metaSet(ctx, "legacy_migrated", JSON.stringify({ at: now, ...done }));
	});
	gw.invalidate();
	if (done.providers || done.models || done.aliases) logEvent("info", "model.legacy_migrated", done);
	return done;
}

// ------------------------------------------------------------------------------------------------ 3. workroom.models.json
interface ConfigModel extends Record<string, unknown> { id?: string }
interface ConfigProvider {
	name?: string;
	type?: string;
	/** pi's models.json calls the wire protocol `api`; accepted as an alias of `type`. */
	api?: string;
	builtin?: string;
	baseUrl?: string;
	apiKeyEnv?: string;
	apiKey?: unknown;
	headers?: Record<string, string | { env: string }>;
	env?: Record<string, string | { env: string }>;
	authStyle?: string;
	keyless?: boolean;
	timeoutMs?: number;
	preset?: string;
	models?: ConfigModel[];
	enable?: string[];
}
interface ConfigFile {
	providers?: Record<string, ConfigProvider>;
	defaultModel?: string;
}

function resolveRefs(label: string, m: Record<string, string | { env: string }> | undefined): Record<string, string> | undefined {
	if (!m) return undefined;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(m)) {
		if (typeof v === "string") out[k] = v;
		else if (v && typeof v === "object" && typeof v.env === "string") {
			validateEnvRef(v.env, true);
			const val = process.env[v.env];
			if (!val) throw new Error(`${label}.${k}: 环境变量 ${v.env} 未设置`);
			out[k] = val;
		} else throw new Error(`${label}.${k} 需为字符串或 { "env": "NAME" }`);
	}
	return out;
}

export function configPath(ctx: AppContext): string | undefined {
	const explicit = process.env.WORKROOM_MODELS_CONFIG;
	if (explicit) return resolve(explicit);
	for (const p of [join(ctx.config.dataDir, "workroom.models.json"), resolve("workroom.models.json")]) if (existsSync(p)) return p;
	return undefined;
}

export async function applyConfigFile(ctx: AppContext, gw: Gateway): Promise<void> {
	const path = configPath(ctx);
	configReport.path = path;
	const wanted = new Set<string>();
	if (path) {
		let cfg: ConfigFile | undefined;
		try {
			cfg = JSON.parse(readFileSync(path, "utf8")) as ConfigFile;
		} catch (e) {
			configReport.errors.push(`${path}: ${(e as Error).message}`);
			logEvent("error", "model.config_unreadable", { path, detail: (e as Error).message });
		}
		for (const [id, d] of Object.entries(cfg?.providers ?? {})) {
			try {
				if ("apiKey" in d) throw new Error("不允许在文件中写入密钥（apiKey）：改用 apiKeyEnv 指向环境变量名");
				const type = (d.builtin ? "builtin" : (d.type ?? d.api)) as ProviderInput["type"];
				if (type !== "builtin" && !(GENERIC_TYPES as readonly string[]).includes(type ?? "")) throw new Error(`type 取值 ${GENERIC_TYPES.join(" / ")}（或 builtin 字段）`);
				const pid = type === "builtin" ? d.builtin! : id;
				const row = await upsertInstanceProvider(gw, pid, { name: d.name ?? id, type, builtinId: d.builtin, preset: d.preset, baseUrl: d.baseUrl, apiKeyEnv: d.apiKeyEnv ?? null, headers: resolveRefs(`${id}.headers`, d.headers) ?? null, env: resolveRefs(`${id}.env`, d.env) ?? null, authStyle: d.authStyle ?? "default", keyless: !!d.keyless, timeoutMs: d.timeoutMs ?? null }, "config", { anyEnv: true });
				wanted.add(pid);
				await gw.reload(row.id);
				const listed = new Set<string>();
				for (const m of d.models ?? []) {
					const { id: mid, enabled, visibility, fallbacks: _fb, defaultThinking, description, sort, ...spec } = m as Record<string, any>;
					if (typeof mid !== "string") throw new Error(`${id}.models[]: 缺少 id`);
					listed.add(mid);
					saveEntry(gw, row, mid, { manual: true, spec, enabled: enabled ?? true, visibility, defaultThinking, description, sort });
				}
				// stale manual models of this provider (removed from the file) go away; catalog models are switched on via "enable"
				for (const e of [...gw.entriesOf(row.id).values()]) if (e.manual && !listed.has(e.model_id)) ctx.db.run("DELETE FROM model_entries WHERE provider_id = ? AND model_id = ?", row.id, e.model_id);
				gw.invalidate();
				await gw.reload(row.id);
				for (const mid of d.enable ?? []) {
					try {
						saveEntry(gw, row, mid, { enabled: true });
					} catch (e) {
						configReport.errors.push(`${id}.enable「${mid}」: ${(e as Error).message}`);
					}
				}
				// fallbacks last: they may point at models declared later in the file
				for (const m of d.models ?? []) if ((m as any).fallbacks) saveEntry(gw, row, (m as any).id, { fallbacks: (m as any).fallbacks });
				configReport.providers.push(pid);
			} catch (e) {
				configReport.errors.push(`${id}: ${(e as Error).message}`);
				logEvent("error", "model.config_provider_invalid", { provider: id, detail: (e as Error).message });
			}
		}
		if (cfg?.defaultModel) {
			const [prov, ...rest] = cfg.defaultModel.split("/");
			metaSet(ctx, "instance_default", JSON.stringify({ provider: prov, modelId: rest.join("/") }));
		}
	}
	// Providers that came from the file but are no longer in it are removed (the file is authoritative for source = "config").
	for (const r of gw.providerRows()) if (r.source === "config" && !wanted.has(r.id)) {
		ctx.db.run("DELETE FROM model_providers WHERE id = ?", r.id);
		ctx.db.run("DELETE FROM model_catalog WHERE provider_id = ?", r.id);
	}
	gw.invalidate();
}

/** Run before Gateway.load(): everything is DB-only. */
export async function bootstrapModels(ctx: AppContext, gw: Gateway): Promise<void> {
	configReport.errors = [];
	configReport.providers = [];
	await gw.loadBuiltins();
	await bootstrapEnv(ctx, gw);
	migrateLegacy(ctx, gw);
	await applyConfigFile(ctx, gw);
}
