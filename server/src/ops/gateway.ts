// Model gateway (M15): platform models (what users pick) are separate from upstream channels (provider, base URL,
// credential, limits, price). Routing runs INSIDE pi-ai as providers "workroom" (platform models) and "fixture"
// (the deterministic test model): each request selects a route per policy (priority, then weighted random), only among
// routes whose upstream supports what the transcript needs (images, tools), fails over on retryable errors *before any
// output was streamed*, and records every attempt in ops_route_attempts linked to space/conversation/task.
import { createModels, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream, isContextOverflow, isRetryableAssistantError, type Api, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type TranscriptContext, type Usage } from "@earendil-works/pi-ai";
import type { AppContext, ModelGateway, ModelRef, PlatformModel, Principal } from "../core/contracts.ts";
import { HttpError, newId, nowIso } from "../core/http.ts";
import { SecretBox, secretHint } from "../identity/secrets.ts";
import { logEvent, redactText } from "./log.ts";

export type ChannelKind = "anthropic" | "openai" | "openai-compatible" | "faux" | "fixture";
export type Capability = "text" | "image" | "tools" | "reasoning";
export type ErrorClass =
	| "rate_limit"
	| "overloaded"
	| "server"
	| "timeout"
	| "network"
	| "auth"
	| "context_overflow"
	| "bad_request"
	| "aborted"
	| "no_credentials"
	| "concurrency"
	| "local_rate_limit"
	| "circuit_open"
	| "capability_mismatch"
	| "unknown";

export const FIXTURE_PI_PROVIDER = "fixture";
export const FIXTURE_MODEL_ID = "workroom-fixture";
export const WORKROOM_PI_PROVIDER = "workroom";
const ROUTE_API = "workroom-route";
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export interface ChannelRow {
	id: string;
	org_id: string | null;
	name: string;
	provider: ChannelKind;
	base_url: string | null;
	api_key_enc: string | null;
	api_key_env: string | null;
	key_hint: string | null;
	status: "enabled" | "disabled";
	rpm_limit: number | null;
	concurrency_limit: number | null;
	timeout_ms: number | null;
	price: string | null;
	builtin: number;
	created_at: string;
	updated_at: string;
}
export interface PlatformModelRow {
	id: string;
	org_id: string | null;
	label: string;
	description: string | null;
	kind: "real" | "fixture";
	pi_provider: string;
	capabilities: string;
	thinking_levels: string;
	default_thinking: string | null;
	context_window: number | null;
	max_tokens: number | null;
	visibility: string | null;
	is_default: number;
	enabled: number;
	sort: number;
	builtin: number;
}
export interface RouteRow {
	id: string;
	platform_model_id: string;
	channel_id: string;
	upstream_model_id: string;
	priority: number;
	weight: number;
	enabled: number;
	capabilities: string | null;
}

interface Candidate {
	route: RouteRow;
	channel: ChannelRow;
	upstream: Model<Api>;
	streams: { streamSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream };
	apiKey: string | undefined;
	caps: Capability[];
	price: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
}

interface Link {
	spaceId?: string;
	orgId?: string;
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

/** Classify a failed upstream message. `retryable` = another route may succeed (failover allowed). */
export function classifyError(m: AssistantMessage): { cls: ErrorClass; retryable: boolean } {
	if (m.stopReason === "aborted") return { cls: "aborted", retryable: false };
	const msg = (m.errorMessage ?? "").toLowerCase();
	if (isContextOverflow(m)) return { cls: "context_overflow", retryable: false };
	if (/\b429\b|rate.?limit|too many requests|quota/.test(msg)) return { cls: "rate_limit", retryable: true };
	if (/\b529\b|overloaded|capacity/.test(msg)) return { cls: "overloaded", retryable: true };
	if (/timed? ?out|timeout|etimedout|deadline/.test(msg)) return { cls: "timeout", retryable: true };
	if (/econnrefused|econnreset|enotfound|eai_again|fetch failed|network|socket hang up|connection (error|closed|reset)/.test(msg)) return { cls: "network", retryable: true };
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

const json = <T>(s: string | null | undefined, fallback: T): T => {
	if (!s) return fallback;
	try {
		return JSON.parse(s) as T;
	} catch {
		return fallback;
	}
};

export class Gateway implements ModelGateway {
	readonly #ctx: AppContext;
	readonly #models: MutableModels;
	readonly secrets: SecretBox;
	/** In-process providers attached to "faux" channels (tests / local fakes). */
	readonly #attached = new Map<string, Provider>();
	#fixtureProvider: Provider | null = null;
	#fixtureDetail = "";
	#anthropic: Provider | null = null;
	#openai: Provider | null = null;
	#compat: { streamSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream } | null = null;
	readonly #inflight = new Map<string, number>();
	readonly #rpm = new Map<string, number[]>();
	readonly #breaker = new Map<string, { fails: number; openUntil: number }>();
	readonly #links = new Map<string, Link>();
	#cache: { models: PlatformModelRow[]; routes: RouteRow[]; channels: ChannelRow[] } | null = null;
	/** Injectable for deterministic tests. */
	random: () => number = Math.random;
	now: () => number = () => Date.now();
	/** Called after each finished request with its linkage (usage importer marks the conversation dirty). */
	onRequestFinished?: (link: { spaceId?: string; conversationId?: number }) => void;

	constructor(ctx: AppContext) {
		this.#ctx = ctx;
		this.secrets = new SecretBox(ctx.config.secretKey);
		// Ambient credentials are never used: the auth context sees no environment variables or files.
		this.#models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
		this.#models.setProvider(this.#routingProvider(WORKROOM_PI_PROVIDER, "Workroom"));
		this.#models.setProvider(this.#routingProvider(FIXTURE_PI_PROVIDER, "Workroom 测试模型"));
	}

	async loadUpstreams(): Promise<void> {
		this.#anthropic = (await import("@earendil-works/pi-ai/providers/anthropic")).anthropicProvider();
		this.#openai = (await import("@earendil-works/pi-ai/providers/openai")).openaiProvider();
		this.#compat = (await import("@earendil-works/pi-ai/api/openai-completions.lazy")).openAICompletionsApi();
		if (this.#ctx.config.fixtureModel) {
			try {
				const m = await import("../runtime/fixture-model.ts");
				this.#fixtureProvider = m.createFixtureModel().provider;
			} catch (e) {
				this.#fixtureDetail = `fixture script unavailable: ${(e as Error).message}`;
			}
		}
	}

	get db() {
		return this.#ctx.db;
	}

	piModels() {
		return this.#models;
	}

	invalidate(): void {
		this.#cache = null;
	}
	#data() {
		if (!this.#cache)
			this.#cache = {
				models: this.db.all<PlatformModelRow>("SELECT * FROM ops_platform_models ORDER BY sort, label"),
				routes: this.db.all<RouteRow>("SELECT * FROM ops_model_routes ORDER BY priority, id"),
				channels: this.db.all<ChannelRow>("SELECT * FROM ops_channels"),
			};
		return this.#cache;
	}

	/** Attach an in-process pi-ai provider to a "faux" channel (tests, local fakes). */
	attachProvider(channelId: string, provider: Provider): void {
		this.#attached.set(channelId, provider);
	}

	link(sessionId: string, l: Omit<Link, "at">): void {
		this.#links.set(sessionId, { ...l, at: this.now() });
		if (this.#links.size > 5000) {
			const cutoff = this.now() - 3600_000;
			for (const [k, v] of this.#links) if (v.at < cutoff) this.#links.delete(k);
		}
	}

	// ------------------------------------------------------------------ catalog
	channelCredential(ch: ChannelRow): { key?: string; source: "stored" | "env" | "none"; detail?: string } {
		if (ch.api_key_enc) {
			try {
				return { key: this.secrets.open(ch.api_key_enc), source: "stored" };
			} catch (e) {
				return { source: "none", detail: (e as Error).message };
			}
		}
		if (ch.api_key_env) {
			const v = process.env[ch.api_key_env];
			return v ? { key: v, source: "env" } : { source: "none", detail: `环境变量 ${ch.api_key_env} 未设置` };
		}
		return { source: "none" };
	}

	channelHealth(ch: ChannelRow): { health: "ready" | "blocked" | "circuit_open"; detail?: string } {
		if (ch.provider === "fixture") return this.#fixtureProvider ? { health: "ready" } : { health: "blocked", detail: this.#fixtureDetail || "fixture model disabled" };
		if (ch.provider === "faux") return this.#attached.has(ch.id) ? { health: "ready" } : { health: "blocked", detail: "未附加进程内 provider（仅测试用渠道）" };
		const cred = this.channelCredential(ch);
		if (!cred.key && ch.provider !== "openai-compatible") return { health: "blocked", detail: cred.detail ?? "未配置凭据" };
		if (ch.provider === "openai-compatible" && !ch.base_url) return { health: "blocked", detail: "缺少 base URL" };
		const b = this.#breaker.get(ch.id);
		if (b && b.openUntil > this.now()) return { health: "circuit_open", detail: `连续失败 ${b.fails} 次，熔断至 ${new Date(b.openUntil).toISOString()}` };
		return { health: "ready" };
	}

	#upstreamModel(ch: ChannelRow, route: RouteRow, pm: PlatformModelRow): { model: Model<Api>; streams: Candidate["streams"] } | null {
		const caps = json<Capability[]>(route.capabilities, json<Capability[]>(pm.capabilities, ["text"]));
		const synth = (api: string, provider: string, baseUrl: string): Model<Api> => ({
			id: route.upstream_model_id,
			name: route.upstream_model_id,
			api,
			provider,
			baseUrl,
			reasoning: caps.includes("reasoning"),
			input: caps.includes("image") ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: pm.context_window ?? 128_000,
			maxTokens: pm.max_tokens ?? 8192,
		});
		const fromProvider = (p: Provider | null) => {
			if (!p) return null;
			const base = p.getModels().find((m) => m.id === route.upstream_model_id) ?? synth(p.getModels()[0]?.api ?? "", p.id, p.baseUrl ?? p.getModels()[0]?.baseUrl ?? "");
			return { model: { ...base, ...(ch.base_url ? { baseUrl: ch.base_url } : {}) } as Model<Api>, streams: p };
		};
		switch (ch.provider) {
			case "anthropic":
				return fromProvider(this.#anthropic);
			case "openai":
				return fromProvider(this.#openai);
			case "openai-compatible":
				return this.#compat && ch.base_url ? { model: synth("openai-completions", "openai-compatible", ch.base_url), streams: this.#compat } : null;
			case "faux":
				return fromProvider(this.#attached.get(ch.id) ?? null);
			case "fixture":
				return fromProvider(this.#fixtureProvider);
		}
		return null;
	}

	#routeCaps(route: RouteRow, upstream: Model<Api>): Capability[] {
		const explicit = json<Capability[] | null>(route.capabilities, null);
		if (explicit) return explicit;
		const caps: Capability[] = ["text", "tools"];
		if (upstream.input.includes("image")) caps.push("image");
		if (upstream.reasoning) caps.push("reasoning");
		return caps;
	}

	platformStatus(pm: PlatformModelRow): { status: PlatformModel["status"]; detail?: string } {
		const d = this.#data();
		const routes = d.routes.filter((r) => r.platform_model_id === pm.id && r.enabled);
		const details: string[] = [];
		for (const r of routes) {
			const ch = d.channels.find((c) => c.id === r.channel_id);
			if (!ch || ch.status !== "enabled") continue;
			const h = this.channelHealth(ch);
			if (h.health !== "blocked") return { status: pm.kind === "fixture" ? "fixture" : "ready" };
			if (h.detail) details.push(`${ch.name}: ${h.detail}`);
		}
		return { status: "blocked", detail: routes.length === 0 ? "未配置路由" : `无可用渠道（${details.join("；") || "渠道已停用"}）` };
	}

	visibleTo(pm: PlatformModelRow, p: Principal): boolean {
		if (!pm.enabled) return false;
		if (pm.org_id && pm.org_id !== p.orgId) return false;
		const vis = json<{ departmentIds?: string[]; projectIds?: string[] } | null>(pm.visibility, null);
		if (!vis) return true;
		if (p.orgRole !== "member") return true;
		if (vis.departmentIds?.length && vis.departmentIds.some((d) => p.departmentIds.includes(d))) return true;
		if (vis.projectIds?.length) {
			const ph = vis.projectIds.map(() => "?").join(",");
			if (this.db.get(`SELECT 1 FROM id_project_members WHERE user_id = ? AND removed_at IS NULL AND project_id IN (${ph})`, p.userId, ...vis.projectIds)) return true;
		}
		return !vis.departmentIds?.length && !vis.projectIds?.length;
	}

	toPlatformModel(pm: PlatformModelRow): PlatformModel & { thinkingLevels: string[]; defaultThinking?: string; contextWindow?: number; isDefault: boolean; fixture: boolean; description?: string } {
		const st = this.platformStatus(pm);
		const thinkingLevels = json<string[]>(pm.thinking_levels, ["off"]);
		return {
			id: pm.id,
			label: pm.kind === "fixture" ? `${pm.label}（测试模型，非真实 AI）` : pm.label,
			description: pm.description ?? undefined,
			ref: { provider: pm.pi_provider, modelId: pm.id, ...(pm.default_thinking ? { thinkingLevel: pm.default_thinking as ModelRef["thinkingLevel"] } : {}) },
			status: st.status,
			statusDetail: st.detail,
			capabilities: json(pm.capabilities, ["text"]),
			thinkingLevels,
			defaultThinking: pm.default_thinking ?? undefined,
			contextWindow: pm.context_window ?? undefined,
			isDefault: !!pm.is_default,
			fixture: pm.kind === "fixture",
		};
	}

	async listFor(p: Principal): Promise<PlatformModel[]> {
		return this.#data()
			.models.filter((m) => this.visibleTo(m, p))
			.map((m) => this.toPlatformModel(m));
	}

	async defaultModel(p: Principal): Promise<ModelRef> {
		const list = await this.listFor(p);
		const pick = list.find((m) => (m as any).isDefault && m.status === "ready") ?? list.find((m) => m.status === "ready") ?? list.find((m) => m.status === "fixture") ?? list[0];
		if (!pick) throw new HttpError(409, "no_model", "没有可用模型");
		return pick.ref;
	}

	/** Model id → platform row for pi models of one routing provider. */
	#piModelsFor(provider: string): Model<Api>[] {
		return this.#data()
			.models.filter((m) => m.pi_provider === provider && m.enabled)
			.map((m) => {
				const caps = json<Capability[]>(m.capabilities, ["text"]);
				const levels = json<string[]>(m.thinking_levels, ["off"]);
				const map: Record<string, null> = {};
				for (const l of THINKING) if (l !== "off" && !levels.includes(l)) map[l] = null;
				return {
					id: m.id,
					name: m.kind === "fixture" ? `${m.label}（测试模型，非真实 AI）` : m.label,
					api: ROUTE_API,
					provider,
					baseUrl: "",
					reasoning: caps.includes("reasoning"),
					...(caps.includes("reasoning") ? { thinkingLevelMap: map } : {}),
					input: caps.includes("image") ? ["text", "image"] : ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: m.context_window ?? 128_000,
					maxTokens: m.max_tokens ?? 8192,
				} as Model<Api>;
			});
	}

	#routingProvider(id: string, name: string): Provider {
		return {
			id,
			name,
			auth: { apiKey: { name: "Workroom gateway (server-side credentials)", resolve: async () => ({ auth: {}, source: "workroom-gateway" }) } },
			getModels: () => this.#piModelsFor(id),
			stream: (model, context, options) => this.route(model as Model<Api>, context, options as SimpleStreamOptions),
			streamSimple: (model, context, options) => this.route(model, context, options),
		};
	}

	// ------------------------------------------------------------------ routing
	#candidates(pm: PlatformModelRow, needs: { image: boolean; tools: boolean }): { ordered: Candidate[]; skipped: { channel?: ChannelRow; route: RouteRow; cls: ErrorClass; detail: string }[] } {
		const d = this.#data();
		const skipped: { channel?: ChannelRow; route: RouteRow; cls: ErrorClass; detail: string }[] = [];
		const ok: Candidate[] = [];
		for (const route of d.routes.filter((r) => r.platform_model_id === pm.id && r.enabled)) {
			const channel = d.channels.find((c) => c.id === route.channel_id);
			if (!channel || channel.status !== "enabled") continue;
			const up = this.#upstreamModel(channel, route, pm);
			if (!up) {
				skipped.push({ channel, route, cls: "no_credentials", detail: this.channelHealth(channel).detail ?? "provider unavailable" });
				continue;
			}
			const caps = this.#routeCaps(route, up.model);
			const missing = [needs.image && !caps.includes("image") ? "image" : null, needs.tools && !caps.includes("tools") ? "tools" : null].filter(Boolean);
			if (missing.length) {
				skipped.push({ channel, route, cls: "capability_mismatch", detail: `route lacks ${missing.join("+")}` });
				continue;
			}
			const cred = this.channelCredential(channel);
			if ((channel.provider === "anthropic" || channel.provider === "openai") && !cred.key) {
				skipped.push({ channel, route, cls: "no_credentials", detail: cred.detail ?? "no credentials" });
				continue;
			}
			const b = this.#breaker.get(channel.id);
			if (b && b.openUntil > this.now()) {
				skipped.push({ channel, route, cls: "circuit_open", detail: `circuit open until ${new Date(b.openUntil).toISOString()}` });
				continue;
			}
			ok.push({ route, channel, upstream: up.model, streams: up.streams, apiKey: cred.key ?? (channel.provider === "openai-compatible" ? "not-required" : undefined), caps, price: json(channel.price, null) });
		}
		// priority ascending; within a priority, weighted random order without replacement
		const ordered: Candidate[] = [];
		const prios = [...new Set(ok.map((c) => c.route.priority))].sort((a, b) => a - b);
		for (const pr of prios) {
			const group = ok.filter((c) => c.route.priority === pr);
			while (group.length) {
				const total = group.reduce((s, c) => s + Math.max(0, c.route.weight), 0);
				let pick = 0;
				if (total > 0) {
					let x = this.random() * total;
					pick = group.findIndex((c) => (x -= Math.max(0, c.route.weight)) < 0);
					if (pick < 0) pick = group.length - 1;
				}
				ordered.push(group.splice(pick, 1)[0]!);
			}
		}
		return { ordered, skipped };
	}

	#rewriteForUpstream(context: TranscriptContext, pm: PlatformModelRow, cand: Candidate): TranscriptContext {
		const routeTag = `${cand.upstream.provider}/${cand.upstream.id}`;
		const messages = context.messages.map((m) => {
			if (m.role !== "assistant" || m.provider !== pm.pi_provider || m.model !== pm.id) return m;
			// Same upstream produced it → restore upstream identity so provider-native data (thinking signatures, ids) is kept.
			if (m.responseModel === routeTag) return { ...m, provider: cand.upstream.provider, api: cand.upstream.api, model: cand.upstream.id };
			return m;
		});
		return { ...context, messages } as TranscriptContext;
	}

	#priced(cand: Candidate | null, pm: PlatformModelRow, u: Usage): { usage: Usage; source: string } {
		const usage: Usage = { ...u, cost: { ...u.cost } };
		if (pm.kind === "fixture" || cand?.channel.provider === "fixture") {
			usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
			return { usage, source: "fixture" };
		}
		if (cand?.price) {
			const p = cand.price;
			usage.cost = { input: (u.input * p.input) / 1e6, output: (u.output * p.output) / 1e6, cacheRead: (u.cacheRead * p.cacheRead) / 1e6, cacheWrite: (u.cacheWrite * p.cacheWrite) / 1e6, total: 0 };
			usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
			return { usage, source: "channel_price" };
		}
		return { usage, source: u.cost.totalFromProvider ? "provider" : "catalog" };
	}

	#acquire(ch: ChannelRow): ErrorClass | null {
		const now = this.now();
		if (ch.concurrency_limit && (this.#inflight.get(ch.id) ?? 0) >= ch.concurrency_limit) return "concurrency";
		if (ch.rpm_limit) {
			const w = (this.#rpm.get(ch.id) ?? []).filter((t) => t > now - 60_000);
			if (w.length >= ch.rpm_limit) {
				this.#rpm.set(ch.id, w);
				return "local_rate_limit";
			}
			w.push(now);
			this.#rpm.set(ch.id, w);
		}
		this.#inflight.set(ch.id, (this.#inflight.get(ch.id) ?? 0) + 1);
		return null;
	}
	#release(ch: ChannelRow): void {
		this.#inflight.set(ch.id, Math.max(0, (this.#inflight.get(ch.id) ?? 1) - 1));
	}
	#breakerResult(ch: ChannelRow, ok: boolean, cls?: ErrorClass): void {
		if (ok) return void this.#breaker.delete(ch.id);
		if (!cls || !["server", "network", "timeout", "overloaded", "auth"].includes(cls)) return;
		const b = this.#breaker.get(ch.id) ?? { fails: 0, openUntil: 0 };
		b.fails++;
		if (b.fails >= 3) b.openUntil = this.now() + 30_000;
		this.#breaker.set(ch.id, b);
	}
	inflight(channelId: string): number {
		return this.#inflight.get(channelId) ?? 0;
	}
	resetBreakers(): void {
		this.#breaker.clear();
	}

	#insertAttempt(a: { requestKey: string; attemptNo: number; pm: PlatformModelRow; cand?: Candidate | null; channel?: ChannelRow; link: Link; status: string; cls?: ErrorClass; error?: string; retryable?: boolean; failover: boolean; latency?: number; firstToken?: number | null; usage?: Usage; costSource?: string; stopReason?: string; startedAt: string; endedAt?: string }): string {
		const id = newId("ra");
		const u = a.usage;
		const ch = a.cand?.channel ?? a.channel;
		this.db.run(
			`INSERT INTO ops_route_attempts (id, request_key, attempt_no, platform_model_id, pi_provider, channel_id, channel_provider, upstream_model, status, error_class, error_message, retryable, failover, latency_ms, first_token_ms, input_tokens, output_tokens, cache_read, cache_write, cost_total, cost_source, stop_reason, fixture, session_id, space_id, org_id, conversation_id, task_id, started_at, ended_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			a.requestKey,
			a.attemptNo,
			a.pm.id,
			a.pm.pi_provider,
			ch?.id ?? null,
			ch?.provider ?? null,
			a.cand?.upstream.id ?? null,
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
			a.pm.kind === "fixture" || ch?.provider === "fixture" ? 1 : 0,
			(a.link as any).sessionId ?? null,
			a.link.spaceId ?? null,
			a.link.orgId ?? null,
			a.link.conversationId ?? null,
			a.link.taskId ?? null,
			a.startedAt,
			a.endedAt ?? null,
		);
		return id;
	}

	route(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
		const out = createAssistantMessageEventStream();
		void this.#route(model, context, options ?? {}, out).catch((err) => {
			const msg: AssistantMessage = { role: "assistant", content: [], api: ROUTE_API, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: "error", errorMessage: `gateway: ${(err as Error).message}`, timestamp: Date.now() };
			out.push({ type: "error", reason: "error", error: msg });
			out.end(msg);
		});
		return out;
	}

	async #route(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions, out: AssistantMessageEventStream): Promise<void> {
		const pm = this.#data().models.find((m) => m.id === model.id && m.pi_provider === model.provider);
		const t0 = this.now();
		const requestKey = newId("rq");
		const sessionId = options.sessionId;
		const meta = (options.metadata ?? {}) as Record<string, unknown>;
		const link: Link & { sessionId?: string } = { ...(sessionId ? this.#links.get(sessionId) : undefined), at: t0, sessionId };
		if (!link.spaceId && typeof meta.wrSpaceId === "string") link.spaceId = meta.wrSpaceId;
		const fail = (text: string, cls: ErrorClass): void => {
			const msg: AssistantMessage = { role: "assistant", content: [], api: ROUTE_API, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: "error", errorMessage: text, timestamp: t0 };
			out.push({ type: "error", reason: "error", error: msg });
			out.end(msg);
			logEvent("warn", "model.route_failed", { requestKey, spaceId: link.spaceId, conversationId: link.conversationId, taskId: link.taskId, cls, detail: text });
			this.onRequestFinished?.(link);
		};
		if (!pm) return fail(`gateway: unknown platform model ${model.provider}/${model.id}`, "bad_request");
		const needs = transcriptNeeds(context);
		const { ordered, skipped } = this.#candidates(pm, needs);
		let attemptNo = 0;
		for (const s of skipped) this.#insertAttempt({ requestKey, attemptNo: ++attemptNo, pm, channel: s.channel, link, status: "skipped", cls: s.cls, error: s.detail, retryable: true, failover: false, startedAt: new Date(t0).toISOString(), endedAt: new Date(t0).toISOString() });
		if (ordered.length === 0) {
			const why = skipped.length ? skipped.map((s) => `${s.channel?.name ?? s.route.channel_id}: ${s.cls} (${s.detail})`).join("; ") : "no route configured";
			return fail(`gateway: no available route for ${pm.id} [needs ${needs.image ? "image " : ""}${needs.tools ? "tools" : "text"}]: ${why}`, skipped.some((s) => s.cls === "capability_mismatch") ? "capability_mismatch" : "no_credentials");
		}
		const spent = zeroUsage();
		let last: { msg: AssistantMessage; cand: Candidate } | null = null;
		let failovers = 0;
		for (let i = 0; i < ordered.length; i++) {
			const cand = ordered[i]!;
			const startedAt = this.now();
			const denied = this.#acquire(cand.channel);
			if (denied) {
				this.#insertAttempt({ requestKey, attemptNo: ++attemptNo, pm, cand, link, status: "skipped", cls: denied, error: denied === "concurrency" ? `concurrency limit ${cand.channel.concurrency_limit}` : `rpm limit ${cand.channel.rpm_limit}`, retryable: true, failover: failovers > 0, startedAt: new Date(startedAt).toISOString(), endedAt: new Date(startedAt).toISOString() });
				continue;
			}
			let started = false;
			let firstToken: number | null = null;
			let final: AssistantMessage | undefined;
			try {
				const { metadata: _m, ...rest } = options;
				const upstreamMeta = Object.fromEntries(Object.entries(meta).filter(([k]) => !k.startsWith("wr")));
				const upOpts: SimpleStreamOptions = {
					...rest,
					...(Object.keys(upstreamMeta).length ? { metadata: upstreamMeta } : {}),
					apiKey: cand.apiKey,
					...(cand.channel.timeout_ms ? { timeoutMs: cand.channel.timeout_ms } : {}),
				};
				if (upOpts.reasoning && !cand.upstream.reasoning) delete upOpts.reasoning;
				const stream = cand.streams.streamSimple(cand.upstream, this.#rewriteForUpstream(context, pm, cand), upOpts);
				let startEv: AssistantMessageEvent | undefined;
				const rw = (m: AssistantMessage): AssistantMessage => {
					m.provider = pm.pi_provider;
					m.model = pm.id;
					m.api = ROUTE_API;
					m.responseModel = `${cand.upstream.provider}/${cand.upstream.id}`;
					return m;
				};
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
						out.push({ type: "start", partial: rw((startEv as any)?.partial ?? ev.partial) });
					}
					rw(ev.partial);
					out.push(ev);
				}
				final ??= await stream.result();
			} catch (e) {
				final = { role: "assistant", content: [], api: cand.upstream.api, provider: cand.upstream.provider, model: cand.upstream.id, usage: zeroUsage(), stopReason: options.signal?.aborted ? "aborted" : "error", errorMessage: (e as Error).message, timestamp: startedAt };
			} finally {
				this.#release(cand.channel);
			}
			const priced = this.#priced(cand, pm, final.usage ?? zeroUsage());
			addUsage(spent, priced.usage);
			const latency = this.now() - startedAt;
			const isErr = final.stopReason === "error" || final.stopReason === "aborted";
			const cls = isErr ? classifyError(final) : undefined;
			this.#breakerResult(cand.channel, !isErr, cls?.cls);
			const canFailover = isErr && !started && final.stopReason === "error" && cls!.retryable && !options.signal?.aborted && i < ordered.length - 1;
			const attemptId = this.#insertAttempt({ requestKey, attemptNo: ++attemptNo, pm, cand, link, status: !isErr ? "ok" : final.stopReason === "aborted" ? "aborted" : "error", cls: cls?.cls, error: final.errorMessage, retryable: cls?.retryable, failover: failovers > 0, latency, firstToken, usage: priced.usage, costSource: priced.source, stopReason: final.stopReason, startedAt: new Date(startedAt).toISOString(), endedAt: nowIso() });
			logEvent(isErr ? "warn" : "debug", "model.route_attempt", { requestKey, routeAttemptId: attemptId, spaceId: link.spaceId, conversationId: link.conversationId, taskId: link.taskId, platformModel: pm.id, channel: cand.channel.id, upstream: cand.upstream.id, status: isErr ? final.stopReason : "ok", cls: cls?.cls, latency });
			last = { msg: final, cand };
			if (canFailover) {
				failovers++;
				continue;
			}
			break;
		}
		if (!last) {
			return fail(`gateway: all routes for ${pm.id} are saturated (concurrency/rate limits)`, "concurrency");
		}
		// Final message: platform identity, upstream route recorded in responseModel, usage = every actual attempt.
		const msg: AssistantMessage = { ...last.msg, provider: pm.pi_provider, model: pm.id, api: ROUTE_API, responseModel: `${last.cand.upstream.provider}/${last.cand.upstream.id}`, usage: spent };
		if (msg.stopReason === "error" || msg.stopReason === "aborted") out.push({ type: "error", reason: msg.stopReason, error: msg });
		else out.push({ type: "done", reason: msg.stopReason as "stop" | "length" | "toolUse" | "deferred", message: msg });
		out.end(msg);
		this.onRequestFinished?.(link);
	}

	// ------------------------------------------------------------------ admin helpers
	channelDto(ch: ChannelRow) {
		const h = this.channelHealth(ch);
		return {
			id: ch.id,
			orgId: ch.org_id ?? undefined,
			name: ch.name,
			provider: ch.provider,
			baseUrl: ch.base_url ?? undefined,
			credential: ch.api_key_enc ? { kind: "stored" as const, hint: ch.key_hint ?? undefined } : ch.api_key_env ? { kind: "env" as const, envVar: ch.api_key_env } : { kind: "none" as const },
			status: ch.status,
			health: h.health,
			healthDetail: h.detail,
			rpmLimit: ch.rpm_limit ?? undefined,
			concurrencyLimit: ch.concurrency_limit ?? undefined,
			timeoutMs: ch.timeout_ms ?? undefined,
			price: json(ch.price, undefined),
			builtin: !!ch.builtin,
			createdAt: ch.created_at,
			updatedAt: ch.updated_at,
		};
	}
	routeDto(r: RouteRow) {
		const d = this.#data();
		const ch = d.channels.find((c) => c.id === r.channel_id);
		const pm = d.models.find((m) => m.id === r.platform_model_id);
		const up = ch && pm ? this.#upstreamModel(ch, r, pm) : null;
		return { id: r.id, platformModelId: r.platform_model_id, channelId: r.channel_id, upstreamModelId: r.upstream_model_id, priority: r.priority, weight: r.weight, enabled: !!r.enabled, capabilities: up ? this.#routeCaps(r, up.model) : json(r.capabilities, []) };
	}
	sealKey(key: string): { enc: string; hint: string } {
		return { enc: this.secrets.seal(key), hint: secretHint(key) };
	}
}
