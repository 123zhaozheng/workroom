// Model gateway (M15), pi-ai native.
//
// Every 模型服务商 (provider) an admin / user / config file declares is a REAL pi-ai Provider, built with
// createProvider({ id, name, baseUrl, headers, auth, models, fetchModels, api }) and registered with setProvider() in the ONE
// MutableModels instance the runtime hands to every Harness (piModels()). Keys are exposed to pi-ai through a CredentialStore
// backed by the app DB (encrypted, models-store.ts); fetched catalogs persist through a DB ModelsStore. Conversations store the
// native pi-durable ref { provider: <provider id>, modelId }.
//
// What pi-ai does not do, and this thin layer adds on top of the native providers:
//   * org visibility / default model / personal providers (listFor, visibleTo)
//   * failover: each provider's streams are wrapped (wrapProvider); when a request fails BEFORE any output with a retryable error
//     and the model has fallbacks, the same transcript goes to the next native model. No models are synthesised.
//   * per-request attempt records (ops_route_attempts) linked to space / conversation / task, for usage attribution.
import { calculateCost, createAssistantMessageEventStream, createProvider, isContextOverflow, isRetryableAssistantError, getSupportedThinkingLevels, type Api, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type TranscriptContext, type Usage } from "@earendil-works/pi-ai";
import { createModels, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { AppContext, ModelGateway, ModelRef, PlatformModel, Principal } from "../core/contracts.ts";
import { HttpError, newId, nowIso } from "../core/http.ts";
import { SecretBox } from "../identity/secrets.ts";
import { Allowlist, resolveTarget } from "./egress.ts";
import { pinnedFetch } from "../tools/netpolicy.ts";
import { logEvent, redactText } from "./log.ts";
import type { HarnessInspect } from "./harness-inspect.ts";
import { DEFAULT_BREAKER_THRESHOLD, DEFAULT_BREAKER_WINDOW_MS, Limiter, type Acquire, type LimitClass } from "./models-limits.ts";
import { builtinProviderMap, listRemoteModels, modelFromRemote, requestAuth, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from "./models-fetch.ts";
import { normalizeBaseUrl } from "./models-presets.ts";
import { DbCredentialStore, DbModelsStore, providerEnv, providerHeaders, providerKey } from "./models-store.ts";
import { FIXTURE_MODEL_ID, FIXTURE_PI_PROVIDER, platformId, RESERVED_PROVIDER_IDS, WORKROOM_PI_PROVIDER, json, type AliasRow, type EntryRow, type ModelSpec, type ProviderRow, type Visibility } from "./models-types.ts";

export { FIXTURE_MODEL_ID, FIXTURE_PI_PROVIDER, WORKROOM_PI_PROVIDER };
export type Capability = "text" | "image" | "tools" | "reasoning";
export type ErrorClass = "local_rate_limit" | "concurrency" | "circuit_open" | "rate_limit" | "overloaded" | "server" | "timeout" | "network" | "auth" | "context_overflow" | "bad_request" | "aborted" | "no_credentials" | "capability_mismatch" | "unknown";

const ALIAS_API = "workroom-alias";

export interface ListedModel extends PlatformModel {
	description?: string;
	thinkingLevels: string[];
	defaultThinking?: string;
	contextWindow?: number;
	maxTokens?: number;
	isDefault: boolean;
	fixture: boolean;
	providerId: string;
	providerName: string;
	providerType: string;
	scope: "instance" | "org" | "user" | "fixture";
	personal: boolean;
	input: string[];
	reasoning: boolean;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** Pre-4 refs { provider: "workroom", modelId } kept working through an alias; hidden from /api/models. */
	legacy?: boolean;
}

interface Link {
	spaceId?: string;
	orgId?: string;
	/** The user the run acts for (set by the wr.ops hook from the run's input): the model is re-checked against THEIR current access. */
	userId?: string;
	/** Round 13: the request belongs to a run whose execution identity could not be established — refused, never let through. */
	unresolved?: boolean;
	conversationId?: number;
	taskId?: number;
	at: number;
}

const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
function addUsage(t: Usage, u: Usage | undefined): void {
	if (!u) return;
	t.input += u.input;
	t.output += u.output;
	t.cacheRead += u.cacheRead;
	t.cacheWrite += u.cacheWrite;
	t.totalTokens += u.totalTokens;
	t.cost.input += u.cost.input;
	t.cost.output += u.cost.output;
	t.cost.cacheRead += u.cost.cacheRead;
	t.cost.cacheWrite += u.cost.cacheWrite;
	t.cost.total += u.cost.total;
}

/** Classify a failed upstream message. `retryable` = another model may succeed (failover allowed). */
export function classifyError(m: AssistantMessage): { cls: ErrorClass; retryable: boolean } {
	if (m.stopReason === "aborted") return { cls: "aborted", retryable: false };
	const msg = (m.errorMessage ?? "").toLowerCase();
	const local = /^(local_rate_limit|concurrency|circuit_open)\b/.exec(msg)?.[1];
	if (local) return { cls: local as ErrorClass, retryable: true };
	if (isContextOverflow(m)) return { cls: "context_overflow", retryable: false };
	// pi-ai's provider errors start with the HTTP status ("503 …", "400: {…}"): the status decides before any word in the body does.
	const status = Number(/^\s*(?:http\s*)?(\d{3})\b/.exec(msg)?.[1]);
	if (status) {
		if (status === 429) return { cls: "rate_limit", retryable: true };
		if (status === 529) return { cls: "overloaded", retryable: true };
		if (status === 408 || status === 504) return { cls: "timeout", retryable: true };
		if (status === 401 || status === 403) return { cls: "auth", retryable: true };
		if (status >= 500) return { cls: "server", retryable: true };
		if (status >= 400) return { cls: "bad_request", retryable: false };
	}
	if (/\b429\b|rate.?limit|too many requests|quota/.test(msg)) return { cls: "rate_limit", retryable: true };
	if (/\b529\b|overloaded|capacity/.test(msg)) return { cls: "overloaded", retryable: true };
	if (/timed? ?out|timeout|etimedout|deadline/.test(msg)) return { cls: "timeout", retryable: true };
	if (/econnrefused|econnreset|enotfound|eai_again|fetch failed|network|socket hang up|connection (error|closed|reset)/.test(msg)) return { cls: "network", retryable: true };
	if (/provider is not configured|no api key/.test(msg)) return { cls: "no_credentials", retryable: true };
	if (/\b(401|403)\b|unauthori[sz]ed|invalid (x-)?api.?key|authentication|permission denied|forbidden/.test(msg)) return { cls: "auth", retryable: true };
	if (/\b5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout|upstream/.test(msg)) return { cls: "server", retryable: true };
	if (/\b(400|404|413|422)\b|invalid request|bad request|not found|unsupported/.test(msg)) return { cls: "bad_request", retryable: false };
	return { cls: "unknown", retryable: isRetryableAssistantError(m) };
}

function transcriptNeeds(context: TranscriptContext): { image: boolean; tools: boolean } {
	let image = false;
	let tools = false;
	for (const m of context.messages) {
		if ((m.role === "user" || m.role === "toolResult") && Array.isArray(m.content) && m.content.some((c: any) => c.type === "image")) image = true;
		if (m.role === "system" && (m.toolsAdded?.length ?? 0) > 0) tools = true;
		if (m.role === "assistant" && m.content.some((c) => c.type === "toolCall")) tools = true;
	}
	return { image, tools };
}

const errorMessage = (model: { provider: string; id: string; api?: string }, text: string, stopReason: "error" | "aborted" = "error"): AssistantMessage => ({ role: "assistant", content: [], api: (model.api ?? "unknown") as Api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason, errorMessage: text, timestamp: Date.now() });

/** Merge admin overrides (ModelSpec) onto a pi-ai Model. `compat` / `cost` merge per key; `thinkingLevelMap` replaces. */
export function applySpec(model: Model<Api>, spec: ModelSpec | undefined): Model<Api> {
	if (!spec) return model;
	const m: Record<string, unknown> = { ...model };
	if (spec.name) m.name = spec.name;
	if (spec.contextWindow) m.contextWindow = spec.contextWindow;
	if (spec.maxTokens) m.maxTokens = spec.maxTokens;
	if (spec.input) m.input = spec.input;
	if (spec.reasoning !== undefined) m.reasoning = spec.reasoning;
	if (spec.thinkingLevelMap) m.thinkingLevelMap = spec.thinkingLevelMap;
	if (spec.cost) m.cost = { ...model.cost, ...spec.cost };
	if (spec.compat) m.compat = { ...((model as any).compat ?? {}), ...spec.compat };
	return m as unknown as Model<Api>;
}

export class Gateway implements ModelGateway {
	readonly #ctx: AppContext;
	readonly #models: MutableModels;
	readonly secrets: SecretBox;
	readonly credentials: DbCredentialStore;
	/** In-process providers attached to "faux" rows (tests / local fakes). */
	readonly #attached = new Map<string, Provider>();
	#fixtureProvider: Provider | null = null;
	#fixtureDetail = "";
	#builtins = new Map<string, Provider>();
	readonly #links = new Map<string, Link>();
	#rows: Map<string, ProviderRow> | null = null;
	#entries: Map<string, Map<string, EntryRow>> | null = null;
	/** Injectable for deterministic tests (also drives the limiter / breaker clock). */
	get now(): () => number {
		return this.#now;
	}
	set now(f: () => number) {
		this.#now = f;
		this.limits.now = f;
	}
	#now: () => number = () => Date.now();
	/** Local rpm / concurrency limits and circuit breaker around every provider's streams. */
	readonly limits = new Limiter(() => this.#now());
	/** Called after each finished request with its linkage (usage importer marks the conversation dirty). */
	onRequestFinished?: (link: { spaceId?: string; conversationId?: number }) => void;
	/** Harness 检视: records each request's final transcript when the org switch is on (set by the ops module). */
	inspector?: Pick<HarnessInspect, "begin">;
	/** Resolver override for tests of the personal-provider egress guard. */
	resolver?: Parameters<typeof resolveTarget>[2];

	constructor(ctx: AppContext) {
		this.#ctx = ctx;
		this.secrets = new SecretBox(ctx.config.secretKey);
		this.credentials = new DbCredentialStore(ctx.db, this.secrets);
		// Ambient credentials are never used: pi-ai sees no environment variables or files, so the dev/CI `ANTHROPIC_API_KEY`
		// etc. can never leak into a request. Keys come ONLY from the CredentialStore (or a WORKROOM_-prefixed env ref we resolve).
		this.#models = createModels({ credentials: this.credentials, modelsStore: new DbModelsStore(ctx.db), authContext: { env: async () => undefined, fileExists: async () => false } });
	}

	get db() {
		return this.#ctx.db;
	}
	piModels(): MutableModels {
		return this.#models;
	}

	/** Build every registered provider from the DB. Called once from the module's init (async: loads pi-ai catalogs). */
	async loadBuiltins(): Promise<void> {
		this.#builtins = await builtinProviderMap();
	}
	async load(): Promise<void> {
		if (this.#builtins.size === 0) await this.loadBuiltins();
		if (this.#ctx.config.fixtureModel) {
			try {
				const m = await import("../runtime/fixture-model.ts");
				this.#fixtureProvider = m.createFixtureModel({ tokensPerSecond: Number(process.env.WORKROOM_FIXTURE_TPS) || undefined }).provider;
				this.#models.setProvider(this.wrapProvider(this.#fixtureProvider, null));
			} catch (e) {
				this.#fixtureDetail = `fixture script unavailable: ${(e as Error).message}`;
			}
		}
		for (const row of this.providerRows()) this.#register(row);
		this.#registerAliases();
		await this.#models.refresh({ allowNetwork: false }); // restore persisted catalogs (DbModelsStore) without any network call
	}

	// ------------------------------------------------------------------ rows & entries (cached; invalidate on every write)
	invalidate(): void {
		this.#rows = null;
		this.#entries = null;
	}
	providerRows(): ProviderRow[] {
		this.#rows ??= new Map(this.db.all<ProviderRow>("SELECT * FROM model_providers ORDER BY created_at, id").map((r) => [r.id, r]));
		return [...this.#rows.values()];
	}
	rowOf(id: string): ProviderRow | undefined {
		this.providerRows();
		return this.#rows!.get(id);
	}
	entriesOf(providerId: string): Map<string, EntryRow> {
		if (!this.#entries) {
			this.#entries = new Map();
			for (const e of this.db.all<EntryRow>("SELECT * FROM model_entries ORDER BY sort, model_id")) {
				let m = this.#entries.get(e.provider_id);
				if (!m) this.#entries.set(e.provider_id, (m = new Map()));
				m.set(e.model_id, e);
			}
		}
		return this.#entries.get(providerId) ?? new Map();
	}
	entryOf(providerId: string, modelId: string): EntryRow | undefined {
		return this.entriesOf(providerId).get(modelId);
	}

	/** (Re)build one provider from its DB row and register it; removes it when the row is gone. */
	async reload(id: string): Promise<void> {
		this.invalidate();
		const row = this.rowOf(id);
		if (!row) {
			this.#models.deleteProvider(id);
			this.#attached.delete(id);
			return;
		}
		this.#register(row);
		await this.#models.refresh({ providers: [id], allowNetwork: false });
	}

	attachProvider(providerId: string, provider: Provider): void {
		this.#attached.set(providerId, provider);
		const row = this.rowOf(providerId);
		if (row) this.#register(row);
	}

	#register(row: ProviderRow): void {
		try {
			const p = this.#build(row);
			if (p) this.#models.setProvider(p);
			else this.#models.deleteProvider(row.id);
		} catch (e) {
			logEvent("error", "model.provider_build_failed", { provider: row.id, detail: (e as Error).message });
			this.#models.deleteProvider(row.id);
		}
	}

	baseUrlOf(row: ProviderRow): string {
		return row.base_url ? normalizeBaseUrl(row.type, row.base_url) : "";
	}

	#api(type: ProviderRow["type"]) {
		switch (type) {
			case "openai-completions":
				return openAICompletionsApi();
			case "openai-responses":
				return openAIResponsesApi();
			case "anthropic-messages":
				return anthropicMessagesApi();
		}
		return undefined;
	}

	/** The pi-ai provider for a row. Generic types use createProvider(); builtin / faux wrap an existing provider. */
	#build(row: ProviderRow): Provider | null {
		if (row.type === "faux") {
			const p = this.#attached.get(row.id);
			return p ? this.wrapProvider(this.#withPolicy(p, row), row) : null;
		}
		if (row.type === "builtin") {
			const b = this.#builtins.get(row.builtin_id ?? row.id);
			return b ? this.wrapProvider(this.#withPolicy(b, row), row) : null;
		}
		const api = this.#api(row.type);
		if (!api) return null;
		const baseUrl = this.baseUrlOf(row);
		const id = row.id;
		const base = createProvider({
			id,
			name: row.name,
			baseUrl: baseUrl || undefined,
			// Custom headers are applied through auth (below) so they are decrypted per request and never sit in the provider object.
			auth: {
				apiKey: {
					name: `${row.name} API key`,
					resolve: async ({ credential }) => {
						const r = this.rowOf(id);
						if (!r) return undefined;
						const custom = providerHeaders(r, this.secrets);
						const hasHeaders = Object.keys(custom).length > 0;
						if (!credential?.key && !r.keyless && !hasHeaders) return undefined;
						const a = requestAuth(r.type, r.auth_style, credential?.key);
						const headers = { ...a.headers, ...custom };
						// OpenAI/Anthropic SDKs refuse to send without SOME auth value; keyless local servers get a placeholder
						// unless the headers already carry an Authorization / x-api-key.
						const hasAuthHeader = Object.keys(headers).some((k) => ["authorization", "x-api-key"].includes(k.toLowerCase()));
						const apiKey = a.apiKey ?? (hasAuthHeader ? undefined : "not-required");
						return { auth: { ...(apiKey ? { apiKey } : {}), ...(Object.keys(headers).length ? { headers } : {}) }, env: credential?.env, source: credential?.key ? "stored credential" : "keyless / custom headers" };
					},
				},
			},
			models: this.#manualModels(row, baseUrl),
			fetchModels: async (c) => {
				const r = this.rowOf(id);
				if (!r) return [];
				await this.guardTarget(r);
				const { models } = await listRemoteModels({ row: r, baseUrl: this.baseUrlOf(r), key: r.keyless ? undefined : providerKey(r, this.secrets).key, headers: providerHeaders(r, this.secrets), signal: c.signal, fetchImpl: r.scope === "user" ? pinnedFetch() : undefined }); // key from the store, not c.credential.key: bearer-style auth resolves without an apiKey
				this.db.run("UPDATE model_providers SET last_fetch_at = ? WHERE id = ?", nowIso(), id);
				return models.map((m) => modelFromRemote(r, this.baseUrlOf(r), m, this.#builtins));
			},
			api,
		});
		return this.wrapProvider(this.#withPolicy(base, row), row);
	}

	#manualModels(row: ProviderRow, baseUrl: string): Model<Api>[] {
		return [...this.entriesOf(row.id).values()].filter((e) => e.manual).map((e) => this.#manualModel(row, e, baseUrl, row.type as Api));
	}
	#manualModel(row: ProviderRow, e: EntryRow, baseUrl: string, api: Api): Model<Api> {
		const spec = json<ModelSpec>(e.spec, {});
		const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...(spec.cost ?? {}) };
		return {
			id: e.model_id,
			name: spec.name ?? e.model_id,
			api,
			provider: row.id,
			baseUrl,
			reasoning: !!spec.reasoning,
			input: spec.input ?? ["text"],
			cost,
			contextWindow: spec.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
			maxTokens: spec.maxTokens ?? DEFAULT_MAX_TOKENS,
			...(spec.thinkingLevelMap ? { thinkingLevelMap: spec.thinkingLevelMap } : {}),
			...(spec.compat ? { compat: spec.compat } : {}),
		} as unknown as Model<Api>;
	}

	/** Overlay the admin's per-model overrides on whatever the provider lists (static, fetched, or built-in catalog) and add manual models it lacks. */
	#withPolicy(base: Provider, row: ProviderRow): Provider {
		const effective = (): Model<Api>[] => {
			const entries = this.entriesOf(row.id);
			const list = base.getModels().map((m) => applySpec(m as Model<Api>, json<ModelSpec | undefined>(entries.get(m.id)?.spec, undefined)));
			for (const e of entries.values()) {
				if (!e.manual || list.some((m) => m.id === e.model_id)) continue;
				const first = base.getModels()[0];
				list.push(this.#manualModel(row, e, row.base_url ? this.baseUrlOf(row) : (first?.baseUrl ?? base.baseUrl ?? ""), (first?.api ?? row.type) as Api));
			}
			return list;
		};
		return { ...base, getModels: effective, getAllModels: effective };
	}

	// ------------------------------------------------------------------ streams: failover + attempt records
	/** Wrap a native provider's streams. Everything else (auth, catalog, refreshModels, ...) is the provider's own. */
	wrapProvider(p: Provider, row: ProviderRow | null): Provider {
		const run = (streamer: (m: Model<Api>, c: TranscriptContext, o?: any) => AssistantMessageEventStream) => (model: Model<Api>, context: TranscriptContext, options?: any) => this.#instrument(model, context, options ?? {}, row, (m, o) => streamer(m, context, o));
		return { ...p, stream: run((m, c, o) => p.stream(m as any, c, o)) as Provider["stream"], streamSimple: run((m, c, o) => p.streamSimple(m, c, o)) };
	}

	link(sessionId: string, l: Omit<Link, "at">): void {
		this.#links.set(sessionId, { ...l, at: this.now() });
		if (this.#links.size > 5000) {
			const cutoff = this.now() - 3600_000;
			for (const [k, v] of this.#links) if (v.at < cutoff) this.#links.delete(k);
		}
	}

	/** Personal providers resolve user-supplied hosts: re-check before every request that they are not internal addresses. */
	async guardTarget(row: ProviderRow): Promise<void> {
		if (row.scope !== "user" || !row.base_url) return;
		await resolveTarget(row.base_url, new Allowlist([]), this.resolver);
	}

	#limitScopes(row: ProviderRow, m: Model<Api>): [Parameters<Limiter["tryAcquire"]>[0], Parameters<Limiter["tryAcquire"]>[1]] {
		const e = this.entryOf(m.provider, m.id);
		const scopes = [{ key: row.id, label: row.name, rpm: row.rpm_limit, concurrency: row.concurrency_limit }, { key: `${row.id}/${m.id}`, label: `${row.name} / ${m.name}`, rpm: e?.rpm_limit, concurrency: e?.concurrency_limit }];
		return [scopes, { key: row.id, label: row.name, threshold: row.breaker_threshold ?? DEFAULT_BREAKER_THRESHOLD, windowMs: row.breaker_window_ms ?? DEFAULT_BREAKER_WINDOW_MS }];
	}

	#fallbacksOf(provider: string, modelId: string): ModelRef[] {
		return json<ModelRef[]>(this.entryOf(provider, modelId)?.fallbacks, []);
	}

	#instrument(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions & { metadata?: Record<string, unknown> }, row: ProviderRow | null, run: (m: Model<Api>, o: any) => AssistantMessageEventStream): AssistantMessageEventStream {
		const out = createAssistantMessageEventStream();
		void this.#runAttempts(model, context, options, row, run, out).catch((err) => {
			const msg = errorMessage(model, `gateway: ${redactText((err as Error).message)}`);
			out.push({ type: "error", reason: "error", error: msg });
			out.end(msg);
		});
		return out;
	}

	async #runAttempts(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions & { metadata?: Record<string, unknown> }, rowAtBuild: ProviderRow | null, run: (m: Model<Api>, o: any) => AssistantMessageEventStream, out: AssistantMessageEventStream): Promise<void> {
		// the row captured when the provider was built may be stale (limits, timeout edited since): always use the current one
		const row = rowAtBuild ? (this.rowOf(rowAtBuild.id) ?? rowAtBuild) : null;
		const t0 = this.now();
		const requestKey = newId("rq");
		const meta = (options.metadata ?? {}) as Record<string, unknown>;
		const record = meta.wrNoRecord !== true;
		const link: Link & { sessionId?: string } = { ...(options.sessionId ? this.#links.get(options.sessionId) : undefined), at: t0, sessionId: options.sessionId };
		if (!link.spaceId && typeof meta.wrSpaceId === "string") link.spaceId = meta.wrSpaceId;
		// Enforced here, at the one place every request passes: a model the acting user may no longer use (visibility changed,
		// personal-key policy switched off, a collaborator continuing someone else's personal-key conversation) never reaches the upstream.
		// Round 13: checked on EVERY call, including a fallback's own inner call (wrNoFailover only stops chaining and double accounting,
		// never the permission check); and a run whose identity is unknown is refused instead of passing unchecked.
		const unresolved = link.unresolved === true && !link.userId;
		if (unresolved || (link.userId && link.orgId)) {
			const why = unresolved ? "无法确认这次运行代表哪位用户（执行身份缺失），已拒绝调用模型" : await this.#denial(link.userId!, link.orgId!, model);
			if (why) {
				const msg = errorMessage(model, `model_not_allowed: ${why}`);
				if (record) this.#insertAttempt({ requestKey, attemptNo: 1, model, row, link, status: "error", cls: "bad_request", error: msg.errorMessage, retryable: false, failover: false, startedAt: new Date(t0).toISOString(), endedAt: nowIso(), fixture: false });
				out.push({ type: "error", reason: "error", error: msg });
				out.end(msg);
				if (record) this.onRequestFinished?.(link);
				return;
			}
		}
		// Capture point of the Harness inspector: this is the final transcript, exactly what the provider receives.
		const capture = record
			? this.inspector?.begin({ orgId: link.orgId, spaceId: link.spaceId, userId: link.userId, conversationId: link.conversationId, taskId: link.taskId, requestKey, startedAt: t0, model, context: context as never, options })
			: undefined;
		const upstreamMeta = Object.fromEntries(Object.entries(meta).filter(([k]) => !k.startsWith("wr")));
		const { metadata: _m, ...rest } = options;
		const baseOpts: SimpleStreamOptions = { ...rest, ...(Object.keys(upstreamMeta).length ? { metadata: upstreamMeta } : {}), ...(!rest.timeoutMs && row?.timeout_ms ? { timeoutMs: row.timeout_ms } : {}), ...(row?.scope === "user" ? { fetch: pinnedFetch() } : {}) };

		const needs = transcriptNeeds(context);
		const chain: Model<Api>[] = [model];
		const deniedFallbacks: { m: Model<Api>; row: ProviderRow | null; why: string }[] = [];
		// A fallback is called through Models (its own auth) with wrNoRecord/wrNoFailover: the OUTER loop records its attempt and
		// the fallback's own wrapper must neither record again nor chain further fallbacks (no A→B→A loops).
		for (const fb of meta.wrNoFailover === true ? [] : this.#fallbacksOf(model.provider, model.id)) {
			const m = this.#models.getModel(fb.provider, fb.modelId);
			if (!m || chain.some((c) => c.provider === m.provider && c.id === m.id)) continue;
			const frow = this.rowOf(m.provider);
			if (frow && frow.status !== "enabled") continue;
			if (needs.image && !m.input.includes("image")) continue;
			if (needs.tools && this.entryOf(m.provider, m.id)?.spec && json<ModelSpec>(this.entryOf(m.provider, m.id)!.spec, {}).tools === false) continue;
			// Round 13: a fallback is a model like any other — the acting user must be allowed to use it, checked before any credential is
			// fetched or request sent. A denied fallback is recorded as skipped (visible in the route record) and never called.
			if (link.userId && link.orgId) {
				const why = await this.#denial(link.userId, link.orgId, m);
				if (why) {
					deniedFallbacks.push({ m, row: frow ?? null, why });
					continue;
				}
			}
			chain.push(m);
		}

		const spent = zeroUsage();
		let lastDenied: { cls: LimitClass; detail: string } | undefined;
		let last: { msg: AssistantMessage; model: Model<Api> } | undefined;
		let attemptNo = 0;
		let failovers = 0;
		if (record) for (const d of deniedFallbacks) this.#insertAttempt({ requestKey, attemptNo: ++attemptNo, model: d.m, row: d.row, link, status: "skipped", cls: "bad_request", error: `model_not_allowed: ${d.why}`, retryable: false, failover: true, startedAt: new Date(t0).toISOString(), endedAt: nowIso(), fixture: false });
		for (let i = 0; i < chain.length; i++) {
			const cand = chain[i]!;
			const candRow = i === 0 ? row : (this.rowOf(cand.provider) ?? null);
			const startedAt = this.now();
			// Local limits + circuit breaker (the fixture has no provider row: never limited). A fallback called through Models is already
			// accounted for by the outer loop (wrNoFailover), so only the outer call acquires.
			let acq: Extract<Acquire, { release: unknown }> | undefined;
			if (candRow && meta.wrNoFailover !== true && meta.wrNoRecord !== true) {
				const got = this.limits.tryAcquire(...this.#limitScopes(candRow, cand));
				if ("denied" in got) {
					lastDenied ??= got.denied;
					if (record) this.#insertAttempt({ requestKey, attemptNo: ++attemptNo, model: cand, row: candRow, link, status: "skipped", cls: got.denied.cls, error: got.denied.detail, retryable: true, failover: failovers > 0, startedAt: new Date(startedAt).toISOString(), endedAt: nowIso(), fixture: false });
					continue;
				}
				acq = got;
			}
			let started = false;
			let firstToken: number | null = null;
			let final: AssistantMessage | undefined;
			try {
				let stream: AssistantMessageEventStream;
				if (i === 0) {
					if (candRow) await this.guardTarget(candRow);
					stream = run(cand, baseOpts);
				} else {
					// Fallback providers resolve THEIR OWN auth through Models: drop whatever was resolved for the primary.
					const { apiKey: _k, headers: _h, env: _e, ...fbOpts } = baseOpts as SimpleStreamOptions & { env?: unknown };
					stream = this.#models.streamSimple(cand, context as never, { ...fbOpts, metadata: { ...(fbOpts.metadata ?? {}), wrNoRecord: true, wrNoFailover: true }, ...(candRow?.timeout_ms && !fbOpts.timeoutMs ? { timeoutMs: candRow.timeout_ms } : {}) });
				}
				let startEv: AssistantMessageEvent | undefined;
				for await (const ev of stream) {
					if (ev.type === "start") {
						startEv = ev;
						continue;
					}
					if (ev.type === "done") {
						final = ev.message;
						break;
					}
					if (ev.type === "error") {
						final = ev.error;
						break;
					}
					if (!started) {
						started = true;
						firstToken = this.now() - startedAt;
						if (startEv) out.push(startEv);
					}
					out.push(ev);
				}
				final ??= await stream.result();
			} catch (e) {
				final = errorMessage(cand, redactText((e as Error).message), options.signal?.aborted ? "aborted" : "error");
			}
			// Scripted in-process (faux) providers report zero cost; real pi-ai APIs price usage from model.cost themselves.
			if (candRow?.type === "faux" && final.usage && !final.usage.cost.total) calculateCost(cand, final.usage);
			const isErr = final.stopReason === "error" || final.stopReason === "aborted";
			addUsage(spent, final.usage ?? zeroUsage());
			const cls = isErr ? classifyError(final) : undefined;
			acq?.release(!isErr ? "ok" : final.stopReason === "aborted" ? "aborted" : cls && ["server", "network", "timeout", "overloaded", "auth"].includes(cls.cls) ? "infra_fail" : "other");
			const canFailover = isErr && !started && final.stopReason === "error" && !!cls?.retryable && !options.signal?.aborted && i < chain.length - 1;
			const isFixture = cand.provider === FIXTURE_PI_PROVIDER;
			if (record) {
				const id = this.#insertAttempt({ requestKey, attemptNo: ++attemptNo, model: cand, row: candRow, link, status: !isErr ? "ok" : final.stopReason === "aborted" ? "aborted" : "error", cls: cls?.cls, error: final.errorMessage, retryable: cls?.retryable, failover: failovers > 0, latency: this.now() - startedAt, firstToken, usage: final.usage, costSource: isFixture ? "fixture" : final.usage?.cost?.totalFromProvider ? "provider" : (cand.cost.input || cand.cost.output) ? "model_price" : "unpriced", stopReason: final.stopReason, startedAt: new Date(startedAt).toISOString(), endedAt: nowIso(), fixture: isFixture });
				logEvent(isErr ? "warn" : "debug", "model.route_attempt", { requestKey, routeAttemptId: id, spaceId: link.spaceId, conversationId: link.conversationId, taskId: link.taskId, provider: cand.provider, model: cand.id, status: isErr ? final.stopReason : "ok", cls: cls?.cls });
			}
			last = { msg: final, model: cand };
			if (canFailover) {
				failovers++;
				continue;
			}
			break;
		}
		if (!last) {
			// every candidate was denied by a local limit / open circuit: nothing reached an upstream. Retryable by pi-durable (backoff = queue).
			const m = errorMessage(model, `${lastDenied!.cls}: ${lastDenied!.detail}`);
			out.push({ type: "error", reason: "error", error: m });
			out.end(m);
			capture?.finish(m);
			if (record) this.onRequestFinished?.(link);
			return;
		}
		const msg: AssistantMessage = last.msg;
		if (failovers > 0) {
			// Several upstream calls served this request: the message bills ALL of them (M15-C: actual calls), identity = the model that answered.
			msg.usage = spent;
			msg.timestamp = t0;
			msg.durationMs = this.now() - t0;
		}
		// Latency stats (M17-C) read durationMs from the message: the whole request as the user experienced it.
		if (msg.durationMs === undefined) msg.durationMs = this.now() - t0;
		if (!msg.responseModel) msg.responseModel = `${msg.provider}/${msg.model}`;
		if (msg.stopReason === "error" || msg.stopReason === "aborted") out.push({ type: "error", reason: msg.stopReason, error: msg });
		else out.push({ type: "done", reason: msg.stopReason as "stop" | "length" | "toolUse" | "deferred", message: msg });
		out.end(msg);
		capture?.finish(msg);
		if (record) this.onRequestFinished?.(link);
	}

	#insertAttempt(a: { requestKey: string; attemptNo: number; model: Model<Api>; row: ProviderRow | null; link: Link & { sessionId?: string }; status: string; cls?: ErrorClass; error?: string; retryable?: boolean; failover: boolean; latency?: number; firstToken?: number | null; usage?: Usage; costSource?: string; stopReason?: string; startedAt: string; endedAt?: string; fixture: boolean }): string {
		const id = newId("ra");
		const u = a.usage;
		this.db.run(
			`INSERT INTO ops_route_attempts (id, request_key, attempt_no, platform_model_id, pi_provider, channel_id, channel_provider, upstream_model, status, error_class, error_message, retryable, failover, latency_ms, first_token_ms, input_tokens, output_tokens, cache_read, cache_write, cost_total, cost_source, stop_reason, fixture, session_id, space_id, org_id, conversation_id, task_id, started_at, ended_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			a.requestKey,
			a.attemptNo,
			platformId(a.model.provider, a.model.id),
			a.model.provider,
			a.row?.id ?? a.model.provider,
			a.row?.type ?? null,
			a.model.id,
			a.status,
			a.cls ?? null,
			a.error ? redactText(a.error).slice(0, 1000) : null,
			a.retryable === undefined ? null : a.retryable ? 1 : 0,
			a.failover ? 1 : 0,
			a.latency ?? null,
			a.firstToken ?? null,
			u?.input ?? null,
			u?.output ?? null,
			u?.cacheRead ?? null,
			u?.cacheWrite ?? null,
			u?.cost.total ?? null,
			a.costSource ?? null,
			a.stopReason ?? null,
			a.fixture ? 1 : 0,
			a.link.sessionId ?? null,
			a.link.spaceId ?? null,
			a.link.orgId ?? a.row?.org_id ?? null,
			a.link.conversationId ?? null,
			a.link.taskId ?? null,
			a.startedAt,
			a.endedAt ?? null,
		);
		return id;
	}

	// ------------------------------------------------------------------ legacy alias provider
	#registerAliases(): void {
		const aliases = this.db.all<AliasRow>("SELECT * FROM model_aliases");
		if (aliases.length === 0) {
			this.#models.deleteProvider(WORKROOM_PI_PROVIDER);
			return;
		}
		const target = (a: AliasRow) => this.#models.getModel(a.provider_id, a.model_id);
		const retag = (src: AssistantMessageEventStream, alias: Model<Api>): AssistantMessageEventStream => {
			const out = createAssistantMessageEventStream();
			const tag = (m: AssistantMessage | undefined) => {
				if (m) {
					m.provider = alias.provider;
					m.model = alias.id;
					m.api = ALIAS_API as Api;
				}
			};
			void (async () => {
				let final: AssistantMessage | undefined;
				for await (const ev of src) {
					tag((ev as any).partial);
					tag((ev as any).message);
					tag((ev as any).error);
					out.push(ev);
					if (ev.type === "done") final = ev.message;
					else if (ev.type === "error") final = ev.error;
				}
				out.end(final ?? (await src.result()));
			})().catch((e) => {
				const m = errorMessage(alias, `gateway: ${redactText((e as Error).message)}`);
				out.push({ type: "error", reason: "error", error: m });
				out.end(m);
			});
			return out;
		};
		const stream = (model: Model<Api>, context: TranscriptContext, options?: any) => {
			const a = this.db.get<AliasRow>("SELECT * FROM model_aliases WHERE alias_id = ?", model.id);
			const t = a ? target(a) : undefined;
			if (!t) {
				const out = createAssistantMessageEventStream();
				const m = errorMessage(model, `gateway: legacy model ${model.id} no longer maps to an available model`);
				out.push({ type: "error", reason: "error", error: m });
				out.end(m);
				return out;
			}
			const { apiKey: _k, headers: _h, env: _e, ...opts } = options ?? {};
			return retag(this.#models.streamSimple(t, context as never, opts), model);
		};
		this.#models.setProvider({
			id: WORKROOM_PI_PROVIDER,
			name: "Workroom (legacy model ids)",
			auth: { apiKey: { name: "legacy alias", resolve: async () => ({ auth: {}, source: "alias" }) } },
			getModels: () =>
				this.db.all<AliasRow>("SELECT * FROM model_aliases").flatMap((a) => {
					const t = target(a);
					return t ? [{ ...t, id: a.alias_id, name: a.label ?? t.name, provider: WORKROOM_PI_PROVIDER, api: ALIAS_API as Api, baseUrl: "" } as Model<Api>] : [];
				}),
			stream: stream as Provider["stream"],
			streamSimple: stream,
		});
	}
	refreshAliases(): void {
		this.#registerAliases();
	}

	// ------------------------------------------------------------------ availability
	/** Does the provider have everything needed to send a request? (credentials / base URL) */
	providerHealth(row: ProviderRow): { health: "ready" | "blocked" | "disabled"; detail?: string } {
		if (row.status !== "enabled") return { health: "disabled", detail: "已停用" };
		if (!this.#models.getProvider(row.id)) return { health: "blocked", detail: row.type === "faux" ? "未附加进程内 provider（仅测试用）" : row.type === "builtin" ? `pi-ai 没有内置 provider「${row.builtin_id}」` : "provider 未能构建（见服务端日志）" };
		if (row.type !== "builtin" && row.type !== "faux" && !row.base_url) return { health: "blocked", detail: "缺少 Base URL" };
		if (row.type === "faux") return { health: "ready" };
		const k = providerKey(row, this.secrets);
		const hasHeaders = !!row.headers_enc;
		const hasEnv = !!row.env_enc;
		if (!k.key && !row.keyless && !hasHeaders && !(row.type === "builtin" && hasEnv)) return { health: "blocked", detail: k.detail ?? "未配置密钥（可勾选“无需密钥”用于本地服务）" };
		return { health: "ready" };
	}

	// ------------------------------------------------------------------ visibility
	/** Fine-grained permission when the RBAC service is present (round 4), else the org role (owner/admin). */
	async can(p: Principal, permission: "model.use" | "model.manage" | "model.provider.manage"): Promise<boolean> {
		if (this.#ctx.services.has("authz")) {
			try {
				return await this.#ctx.services.get("authz").has(p, permission);
			} catch {
				/* unknown permission id etc.: fall back to the org role */
			}
		}
		return permission === "model.use" ? true : p.orgRole !== "member";
	}
	/** Sees every enabled model regardless of visibility rules (model.manage). */
	isModelAdmin(p: Principal): Promise<boolean> {
		return this.can(p, "model.manage");
	}

	personalProvidersAllowed(orgId: string): boolean {
		return this.db.get<{ value: string }>("SELECT value FROM ops_settings WHERE org_id = ? AND key = 'personal_providers'", orgId)?.value === "on";
	}

	providerVisibleTo(row: ProviderRow, p: Principal, personalOn: boolean): boolean {
		if (row.scope === "instance") return true;
		if (row.org_id !== p.orgId) return false;
		if (row.scope === "user") return row.owner_user_id === p.userId && personalOn;
		return true;
	}

	entryVisibleTo(e: EntryRow | undefined, p: Principal, admin: boolean): boolean {
		if (!e || !e.enabled) return false;
		const vis = json<Visibility | null>(e.visibility, null);
		if (!vis || admin) return true;
		if (vis.userIds?.includes(p.userId)) return true;
		if (vis.departmentIds?.length && vis.departmentIds.some((d) => p.departmentIds.includes(d))) return true;
		if (vis.projectIds?.length) {
			const ph = vis.projectIds.map(() => "?").join(",");
			if (this.db.get(`SELECT 1 FROM id_project_members WHERE user_id = ? AND removed_at IS NULL AND project_id IN (${ph})`, p.userId, ...vis.projectIds)) return true;
		}
		return !vis.departmentIds?.length && !vis.projectIds?.length && !vis.userIds?.length;
	}

	orgDefault(orgId: string): ModelRef | undefined {
		const r = this.db.get<{ value: string }>("SELECT value FROM ops_settings WHERE org_id = ? AND key = 'default_model'", orgId);
		// no org choice: the operator's default from workroom.models.json ("defaultModel")
		return json<ModelRef | undefined>(r?.value ?? this.db.get<{ value: string }>("SELECT value FROM model_meta WHERE key = 'instance_default'")?.value, undefined);
	}

	#toListed(row: ProviderRow, m: Model<Api>, e: EntryRow | undefined, health: { health: string; detail?: string }, isDefault: boolean): ListedModel {
		const spec = json<ModelSpec>(e?.spec, {});
		const levels = getSupportedThinkingLevels(m as Model<Api>).filter((l) => l !== ("max" as string)) as string[];
		const caps: Capability[] = ["text", ...(spec.tools === false ? [] : (["tools"] as const)), ...(m.input.includes("image") ? (["image"] as const) : []), ...(m.reasoning ? (["reasoning"] as const) : [])];
		return {
			id: platformId(row.id, m.id),
			label: m.name,
			description: e?.description ?? undefined,
			ref: { provider: row.id, modelId: m.id, ...(e?.default_thinking ? { thinkingLevel: e.default_thinking as ModelRef["thinkingLevel"] } : {}) },
			status: health.health === "ready" ? "ready" : "blocked",
			statusDetail: health.health === "ready" ? undefined : health.detail,
			capabilities: caps,
			thinkingLevels: levels,
			defaultThinking: e?.default_thinking ?? undefined,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			isDefault,
			fixture: false,
			providerId: row.id,
			providerName: row.name,
			providerType: row.type === "builtin" ? `builtin:${row.builtin_id}` : row.type,
			scope: row.scope,
			personal: row.scope === "user",
			input: [...m.input],
			reasoning: m.reasoning,
			cost: m.cost ? { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead, cacheWrite: m.cost.cacheWrite } : undefined,
		};
	}

	fixtureListed(): ListedModel | null {
		if (!this.#fixtureProvider) return null;
		const m = this.#fixtureProvider.getModels()[0];
		return {
			id: FIXTURE_MODEL_ID,
			label: "测试模型（非真实 AI）",
			description: "确定性脚本回复，用于测试与演示；不是真实 AI，费用记 0。",
			ref: { provider: FIXTURE_PI_PROVIDER, modelId: FIXTURE_MODEL_ID },
			status: "fixture",
			capabilities: ["text", "image", "tools"],
			thinkingLevels: ["off"],
			contextWindow: m?.contextWindow ?? 200_000,
			maxTokens: m?.maxTokens ?? 16_384,
			isDefault: false,
			fixture: true,
			providerId: FIXTURE_PI_PROVIDER,
			providerName: "测试模型（Fixture）",
			providerType: "fixture",
			scope: "fixture",
			personal: false,
			input: ["text", "image"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
	}

	async listFor(p: Principal): Promise<PlatformModel[]> {
		if (!(await this.can(p, "model.use"))) return [];
		const admin = await this.isModelAdmin(p);
		const personalOn = this.personalProvidersAllowed(p.orgId);
		const def = this.orgDefault(p.orgId);
		const out: ListedModel[] = [];
		for (const row of this.providerRows()) {
			if (!this.providerVisibleTo(row, p, personalOn)) continue;
			const health = this.providerHealth(row);
			if (health.health === "disabled") continue;
			const prov = this.#models.getProvider(row.id);
			if (!prov) continue;
			const entries = this.entriesOf(row.id);
			for (const m of prov.getModels()) {
				const e = entries.get(m.id);
				if (!this.entryVisibleTo(e, p, admin)) continue;
				out.push(this.#toListed(row, m as Model<Api>, e, health, def?.provider === row.id && def.modelId === m.id));
			}
		}
		// Same display name from different providers: add the provider so users can tell them apart.
		const counts = new Map<string, number>();
		for (const m of out) counts.set(m.label, (counts.get(m.label) ?? 0) + 1);
		for (const m of out) if ((counts.get(m.label) ?? 0) > 1) (m as { label: string }).label = `${m.label} · ${m.providerName}`;
		out.sort((a, b) => Number(a.personal) - Number(b.personal) || (this.entryOf(a.providerId, a.ref.modelId)?.sort ?? 0) - (this.entryOf(b.providerId, b.ref.modelId)?.sort ?? 0) || a.label.localeCompare(b.label));
		const fx = this.fixtureListed();
		if (fx) out.push(fx);
		// Legacy ids (conversations created before provider-native refs) stay valid but are not offered in pickers.
		for (const a of this.db.all<AliasRow>("SELECT * FROM model_aliases WHERE org_id IS NULL OR org_id = ?", p.orgId)) {
			const t = out.find((x) => x.ref.provider === a.provider_id && x.ref.modelId === a.model_id);
			if (t) out.push({ ...t, id: a.alias_id, label: a.label ?? t.label, ref: { provider: WORKROOM_PI_PROVIDER, modelId: a.alias_id }, isDefault: false, legacy: true });
		}
		return out;
	}

	async defaultModel(p: Principal): Promise<ModelRef> {
		const list = (await this.listFor(p)).filter((m) => !(m as ListedModel).legacy);
		const pick = list.find((m) => (m as ListedModel).isDefault && m.status === "ready") ?? list.find((m) => m.status === "ready") ?? list.find((m) => m.status === "fixture") ?? list[0];
		if (!pick) throw new HttpError(409, "no_model", "没有可用模型");
		return pick.ref;
	}

	/** Why the acting user may not use `model` now (undefined = allowed). Fixture and the legacy alias are always allowed (the alias re-checks its target). */
	async #denial(userId: string, orgId: string, model: Model<Api>): Promise<string | undefined> {
		if (model.provider === FIXTURE_PI_PROVIDER || model.provider === WORKROOM_PI_PROVIDER) return undefined;
		let p: Principal | null = null;
		try {
			p = await this.#ctx.services.get("identity").principalFor(userId, orgId);
		} catch {
			return undefined; // no identity service (unit harness): nothing to enforce against
		}
		if (!p) return "用户已停用或移出组织";
		const row = this.rowOf(model.provider);
		if (!row) return `服务商 ${model.provider} 不存在`;
		if (!(await this.can(p, "model.use"))) return "没有使用模型的权限";
		if (!this.providerVisibleTo(row, p, this.personalProvidersAllowed(p.orgId))) return row.scope === "user" ? "这是他人的个人自带密钥模型，或管理员已关闭个人自带密钥" : "该模型不属于当前组织";
		if (this.providerHealth(row).health === "disabled") return "服务商已停用";
		if (!this.entryVisibleTo(this.entryOf(row.id, model.id), p, await this.isModelAdmin(p))) return `模型 ${model.id} 已停用或对你不可见`;
		return undefined;
	}

	/** May `p` use this native ref right now? */
	async canUse(p: Principal, ref: { provider: string; modelId: string }): Promise<boolean> {
		return (await this.listFor(p)).some((m) => m.ref.provider === ref.provider && m.ref.modelId === ref.modelId);
	}

	// ------------------------------------------------------------------ admin helpers
	credentialInfo(row: ProviderRow): { kind: "none" | "stored" | "env"; envVar?: string; hint?: string } {
		return row.api_key_enc ? { kind: "stored", hint: row.key_hint ?? undefined } : row.api_key_env ? { kind: "env", envVar: row.api_key_env } : { kind: "none" };
	}
	sealKey(key: string): { enc: string; hint: string } {
		return { enc: this.secrets.seal(key), hint: key.length <= 8 ? "****" : `****${key.slice(-4)}` };
	}
	/** Effective pi-ai model list of a provider (catalog + overrides + manual), as the runtime sees it. */
	effectiveModels(providerId: string): Model<Api>[] {
		return [...(this.#models.getProvider(providerId)?.getModels() ?? [])] as Model<Api>[];
	}
	hasAttached(id: string): boolean {
		return this.#attached.has(id);
	}
	builtinProviders(): Map<string, Provider> {
		return this.#builtins;
	}
	isReserved(id: string): boolean {
		return RESERVED_PROVIDER_IDS.has(id) || this.#builtins.has(id);
	}

	/**
	 * "获取模型列表": the provider's native fetchModels() through Models.refresh(). The result is persisted by the DB ModelsStore.
	 * Throws a sanitised Error (HTTP status / network reason) on failure.
	 */
	async fetchCatalog(providerId: string, signal?: AbortSignal): Promise<void> {
		const row = this.rowOf(providerId);
		if (!row) throw new HttpError(404, "not_found", "服务商不存在");
		const h = this.providerHealth(row);
		if (h.health !== "ready") throw new HttpError(409, "provider_not_ready", h.detail ?? "服务商不可用");
		if (!(await this.#models.checkAuth(providerId))) throw new HttpError(409, "provider_not_ready", "未配置凭据");
		const res = await this.#models.refresh({ providers: [providerId], force: true, signal });
		const err = res.errors.get(providerId);
		if (err) throw new Error(redactText(err.message));
	}

	/** Test connection: (1) list models, (2) a tiny real completion. Neither is recorded as usage. */
	async testProvider(providerId: string, opts: { modelId?: string } = {}): Promise<{ ok: boolean; list: { ok: boolean; skipped?: boolean; detail?: string; count?: number; latencyMs?: number; url?: string }; completion: { ok: boolean; modelId?: string; detail?: string; latencyMs?: number; text?: string } }> {
		const row = this.rowOf(providerId);
		if (!row) throw new HttpError(404, "not_found", "服务商不存在");
		const h = this.providerHealth(row);
		if (h.health === "blocked") return { ok: false, list: { ok: false, skipped: true, detail: h.detail }, completion: { ok: false, detail: h.detail } };
		const result: Awaited<ReturnType<Gateway["testProvider"]>> = { ok: false, list: { ok: false }, completion: { ok: false } };
		const generic = row.type === "openai-completions" || row.type === "openai-responses" || row.type === "anthropic-messages";
		if (generic) {
			try {
				await this.guardTarget(row);
				const k = providerKey(row, this.secrets);
				const r = await listRemoteModels({ row, baseUrl: this.baseUrlOf(row), key: row.keyless ? undefined : k.key, headers: providerHeaders(row, this.secrets), signal: AbortSignal.timeout(20_000), fetchImpl: row.scope === "user" ? pinnedFetch() : undefined });
				result.list = { ok: true, count: r.models.length, latencyMs: r.latencyMs, url: r.url };
			} catch (e) {
				result.list = { ok: false, detail: redactText((e as Error).message) };
			}
		} else result.list = { ok: true, skipped: true, detail: "该类型不使用 /models 列表接口" };
		const candidates = this.effectiveModels(providerId);
		const enabled = candidates.filter((m) => this.entryOf(providerId, m.id)?.enabled);
		const model = (opts.modelId ? candidates.find((m) => m.id === opts.modelId) : undefined) ?? enabled[0] ?? candidates[0];
		if (!model) result.completion = { ok: false, detail: "没有可用于测试的模型：请先“获取模型列表”或手动添加一个模型" };
		else {
			const t0 = Date.now();
			try {
				const msg = await this.#models.completeSimple(model, { messages: [{ role: "user", content: "Reply with the single word: OK", timestamp: Date.now() }] }, { maxTokens: 24, signal: AbortSignal.timeout(45_000), metadata: { wrNoRecord: true }, ...(row.scope === "user" ? { fetch: pinnedFetch() } : {}) });
				const text = msg.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
				result.completion = msg.stopReason === "error" || msg.stopReason === "aborted" ? { ok: false, modelId: model.id, detail: redactText(msg.errorMessage ?? msg.stopReason), latencyMs: Date.now() - t0 } : { ok: true, modelId: model.id, text: text.slice(0, 80), latencyMs: Date.now() - t0 };
			} catch (e) {
				result.completion = { ok: false, modelId: model.id, detail: redactText((e as Error).message), latencyMs: Date.now() - t0 };
			}
		}
		result.ok = result.list.ok && result.completion.ok;
		this.db.run("UPDATE model_providers SET last_check = ? WHERE id = ?", JSON.stringify({ at: nowIso(), ok: result.ok, list: result.list.ok, completion: result.completion.ok, detail: result.ok ? undefined : (result.list.detail ?? result.completion.detail)?.slice(0, 300) }), providerId);
		this.invalidate();
		return result;
	}

	/** platform id → display name for every model the runtime can run (stats / traces label lookups). */
	modelLabels(): Map<string, string> {
		const out = new Map<string, string>();
		for (const row of this.providerRows()) for (const m of this.effectiveModels(row.id)) out.set(platformId(row.id, m.id), m.name);
		for (const a of this.db.all<AliasRow>("SELECT * FROM model_aliases")) out.set(a.alias_id, a.label ?? this.#models.getModel(a.provider_id, a.model_id)?.name ?? a.alias_id);
		if (this.#fixtureProvider) out.set(FIXTURE_MODEL_ID, "测试模型（非真实 AI）");
		return out;
	}
	envOf(row: ProviderRow): string[] {
		return Object.keys(providerEnv(row, this.secrets) ?? {});
	}
	headerNames(row: ProviderRow): string[] {
		return Object.keys(providerHeaders(row, this.secrets));
	}
}
