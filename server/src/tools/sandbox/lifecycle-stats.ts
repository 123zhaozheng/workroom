// Round 11 (R6): read-only aggregation over the sandbox lifecycle events (tool_sandbox_events), the instance table, the tool call records
// and the prewarm log (tool_sandbox_prewarm_log). Nothing here writes lifecycle data; the only write is the price setting.
// Definitions and formulas: docs/r11-observability.md.
//
//  * Percentiles: nearest-rank. Sorted ascending x[0..n-1], P(p) = x[ceil(p/100 * n) - 1]. n = 0 -> null, n = 1 -> the single value for every p.
//  * Running time: an interval counts in the range in which it ENDS (pause / destroy events carry running_ms, stamped at the end). Intervals that
//    are still open (instance state ready/pausing, measured from instances.running_since) count up to `now`, and only when now lies inside the range.
//  * Cost: running hours x admin price per provider-hour (tool_sandbox_settings `sandbox_price:<org>`). No price -> null. Prices are never defaulted.
import type { AppContext, Principal } from "../../core/contracts.ts";
import { HttpError, nowIso } from "../../core/http.ts";
import type {
	SandboxConversationStatsDTO,
	SandboxLifecycleStatsDTO,
	SandboxPercentilesDTO,
	SandboxPrewarmTuningDTO,
	SandboxProviderStatsDTO,
	SandboxStatsDTO,
} from "../../../../shared/sandbox-stats.ts";
import { conversationIdOf, type SandboxEventKind, type SandboxEventTrigger } from "./lifecycle-events.ts";
import { prewarmFor, prewarmStats } from "./prewarm.ts";
import { PROVIDER_IDS } from "./provider.ts";

export const WHATIF_THRESHOLDS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] as const;
export const MAX_RANGE_DAYS = 800;
export const MAX_PRICE_USD_PER_HOUR = 10_000;
const TOP_CONVERSATIONS = 20;
const HOUR_MS = 3_600_000;

// ------------------------------------------------------------------ percentiles
/** Nearest-rank percentile of an unsorted sample; null when empty. */
export function nearestRank(values: readonly number[], p: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
	return sorted[rank - 1]!;
}
export function percentiles(values: readonly number[]): SandboxPercentilesDTO {
	return { n: values.length, p50: nearestRank(values, 50), p95: nearestRank(values, 95) };
}

// ------------------------------------------------------------------ prices (organisation setting)
const priceKey = (orgId: string) => `sandbox_price:${orgId}`;

export function readPrices(ctx: AppContext, orgId: string): Record<string, number> {
	try {
		const r = ctx.db.get<{ value: string }>("SELECT value FROM tool_sandbox_settings WHERE key = ?", priceKey(orgId));
		if (!r) return {};
		const v = JSON.parse(r.value) as Record<string, unknown>;
		const out: Record<string, number> = {};
		for (const id of PROVIDER_IDS) if (typeof v[id] === "number" && Number.isFinite(v[id]) && (v[id] as number) >= 0) out[id] = v[id] as number;
		return out;
	} catch {
		return {};
	}
}

/** Patch the prices: a number sets, null clears. Throws HttpError(400) on anything else. The caller checks the permission. */
export function writePrices(ctx: AppContext, p: Principal, patch: unknown): Record<string, number> {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new HttpError(400, "invalid", "请求体无效");
	const body = (patch as { prices?: unknown }).prices;
	if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid", "prices 必须是对象");
	const next = readPrices(ctx, p.orgId);
	for (const [id, v] of Object.entries(body as Record<string, unknown>)) {
		if (!(PROVIDER_IDS as readonly string[]).includes(id)) throw new HttpError(400, "invalid", `未知的沙箱提供方：${id.slice(0, 40)}`);
		if (v === null) {
			delete next[id];
			continue;
		}
		if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_PRICE_USD_PER_HOUR) throw new HttpError(400, "invalid", `单价必须是 0 到 ${MAX_PRICE_USD_PER_HOUR} 之间的数字（USD/小时）`);
		next[id] = Math.round(v * 1e6) / 1e6;
	}
	ctx.db.run(
		"INSERT INTO tool_sandbox_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
		priceKey(p.orgId), JSON.stringify(next), p.userId, nowIso(),
	);
	try {
		ctx.db.run("INSERT INTO id_audit (id, org_id, actor_user_id, action, target, detail, at, category) VALUES (?, ?, ?, ?, ?, ?, ?, 'admin')", `aud_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, p.orgId, p.userId, "sandbox.prices.update", "sandbox-prices", JSON.stringify(next), nowIso());
	} catch {
		/* the audit table belongs to the identity module */
	}
	return next;
}

// ------------------------------------------------------------------ accumulation
interface EventRow {
	provider: string;
	space_id: string;
	conversation_id: number | null;
	kind: SandboxEventKind;
	trigger: SandboxEventTrigger;
	duration_ms: number | null;
	running_ms: number | null;
}

class Acc {
	creates = 0;
	byTrigger = { exec: 0, prewarm: 0, explicit: 0 };
	createFailures = 0;
	cold: number[] = [];
	resumes = 0;
	resumeFailures = 0;
	resume: number[] = [];
	idlePauses = 0;
	archives = 0;
	destroys = 0;
	/** Closed + open running time per provider (cost needs the provider). */
	running = new Map<string, number>();
	open = 0;
	runs(provider: string, ms: number, open: boolean): void {
		this.running.set(provider, (this.running.get(provider) ?? 0) + ms);
		if (open) this.open += ms;
	}
	add(e: EventRow): void {
		switch (e.kind) {
			case "create":
				this.creates++;
				if (e.trigger === "exec" || e.trigger === "prewarm" || e.trigger === "explicit") this.byTrigger[e.trigger]++;
				if (e.duration_ms !== null) this.cold.push(e.duration_ms);
				break;
			case "create_failed":
				this.createFailures++;
				break;
			case "resume":
				this.resumes++;
				if (e.duration_ms !== null) this.resume.push(e.duration_ms);
				break;
			case "resume_failed":
				this.resumeFailures++;
				break;
			case "pause":
				if (e.trigger === "idle") this.idlePauses++;
				if (e.running_ms !== null) this.runs(e.provider, e.running_ms, false);
				break;
			case "archive":
				this.archives++;
				break;
			case "destroy":
				this.destroys++;
				if (e.running_ms !== null) this.runs(e.provider, e.running_ms, false);
				break;
		}
	}
	dto(prices: Readonly<Record<string, number>>, scope: readonly string[]): SandboxLifecycleStatsDTO {
		let runningMs = 0;
		for (const ms of this.running.values()) runningMs += ms;
		return {
			creates: this.creates,
			createsByTrigger: { ...this.byTrigger },
			createFailures: this.createFailures,
			coldStart: percentiles(this.cold),
			resumes: this.resumes,
			resumeFailures: this.resumeFailures,
			resume: percentiles(this.resume),
			idlePauses: this.idlePauses,
			archives: this.archives,
			destroys: this.destroys,
			runningMs,
			openRunningMs: this.open,
			costUsd: costOf(this.running, prices, scope),
		};
	}
}

/** Σ hours × price over the providers in `scope` that have a price; null when none of them has one. */
function costOf(running: ReadonlyMap<string, number>, prices: Readonly<Record<string, number>>, scope: readonly string[]): number | null {
	const priced = scope.filter((id) => prices[id] !== undefined);
	if (priced.length === 0) return null;
	let usd = 0;
	for (const id of priced) usd += ((running.get(id) ?? 0) / HOUR_MS) * prices[id]!;
	return Math.round(usd * 1e6) / 1e6;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** Parse the from / to query (ISO instants). Default: the last 30 days up to now. */
export function parseRange(fromRaw: string | undefined, toRaw: string | undefined, now = Date.now()): { from: string; to: string } {
	const parse = (s: string, name: string): string => {
		const t = Date.parse(s);
		if (!ISO.test(s) || !Number.isFinite(t)) throw new HttpError(400, "invalid", `${name} 必须是 ISO 时间（例如 2026-11-01T00:00:00Z）`);
		return new Date(t).toISOString();
	};
	const to = toRaw ? parse(toRaw, "to") : new Date(now + 1).toISOString();
	const from = fromRaw ? parse(fromRaw, "from") : new Date(Date.parse(to) - 30 * 86_400_000).toISOString();
	if (Date.parse(from) >= Date.parse(to)) throw new HttpError(400, "invalid", "from 必须早于 to");
	if (Date.parse(to) - Date.parse(from) > MAX_RANGE_DAYS * 86_400_000) throw new HttpError(400, "invalid", `时间范围最长 ${MAX_RANGE_DAYS} 天`);
	return { from, to };
}

export function parseProvider(raw: string | undefined): string | null {
	if (raw === undefined || raw === "") return null;
	if (!(PROVIDER_IDS as readonly string[]).includes(raw)) throw new HttpError(400, "invalid", `provider 取值：${PROVIDER_IDS.join(" | ")}`);
	return raw;
}

// ------------------------------------------------------------------ the aggregation
interface OpenRow {
	provider: string;
	space_id: string;
	workspace_key: string;
	running_since: string | null;
	created_at: string;
}

interface Collected {
	total: Acc;
	byProvider: Map<string, Acc>;
	byConv: Map<string, { spaceId: string; conversationId: number; acc: Acc }>;
}

function collect(ctx: AppContext, orgId: string, from: string, to: string, provider: string | null, now: number, conv?: { spaceId: string; conversationId: number }): Collected {
	const out: Collected = { total: new Acc(), byProvider: new Map(), byConv: new Map() };
	const provAcc = (id: string) => out.byProvider.get(id) ?? (out.byProvider.set(id, new Acc()), out.byProvider.get(id)!);
	const convAcc = (spaceId: string, id: number) => {
		const k = `${spaceId}:${id}`;
		let e = out.byConv.get(k);
		if (!e) out.byConv.set(k, (e = { spaceId, conversationId: id, acc: new Acc() }));
		return e.acc;
	};
	const wheres = ["org_id = ?", "at >= ?", "at < ?"];
	const args: (string | number)[] = [orgId, from, to];
	if (provider) (wheres.push("provider = ?"), args.push(provider));
	if (conv) (wheres.push("space_id = ?", "conversation_id = ?"), args.push(conv.spaceId, conv.conversationId));
	const events = ctx.db.all<EventRow>(`SELECT provider, space_id, conversation_id, kind, "trigger" AS trigger, duration_ms, running_ms FROM tool_sandbox_events WHERE ${wheres.join(" AND ")}`, ...args);
	for (const e of events) {
		out.total.add(e);
		provAcc(e.provider).add(e);
		if (e.conversation_id !== null) convAcc(e.space_id, e.conversation_id).add(e);
	}
	// Still-running sandboxes: only when "now" lies inside the range (an interval counts where it ends; an open one ends "now").
	const fromMs = from ? Date.parse(from) : -Infinity;
	const toMs = to === "9999" ? Infinity : Date.parse(to);
	if (fromMs <= now && now < toMs) {
		const rows = ctx.db.all<OpenRow>(
			`SELECT provider, space_id, workspace_key, running_since, created_at FROM tool_sandbox_instances WHERE org_id = ? AND state IN ('ready','pausing')${provider ? " AND provider = ?" : ""}`,
			orgId, ...(provider ? [provider] : []),
		);
		for (const r of rows) {
			const cid = conversationIdOf(r.workspace_key);
			if (conv && (r.space_id !== conv.spaceId || cid !== conv.conversationId)) continue;
			const ms = Math.max(0, now - Date.parse(r.running_since ?? r.created_at));
			out.total.runs(r.provider, ms, true);
			provAcc(r.provider).runs(r.provider, ms, true);
			if (cid !== null) convAcc(r.space_id, cid).runs(r.provider, ms, true);
		}
	}
	return out;
}

/** Providers a cost is computed over: the filter, or every provider that has a price. */
const costScope = (provider: string | null, prices: Readonly<Record<string, number>>): string[] => (provider ? [provider] : Object.keys(prices));

export function prewarmTuning(ctx: AppContext, orgId: string, from: string, to: string): SandboxPrewarmTuningDTO {
	const st = prewarmStats(ctx, orgId, from, { untilIso: to, thresholds: WHATIF_THRESHOLDS });
	const cfg = prewarmFor(ctx).settings(orgId);
	// Wasted = a fired prewarm whose sandbox (the next prewarm-triggered create / resume of that conversation) was paused or destroyed before any exec
	// used it. `used_at` is stamped when the exec happens, so an exec AFTER the pause (it would have resumed the sandbox) does not rescue the prewarm.
	const fired = ctx.db.all<{ id: number; space_id: string; conversation_id: number; at: string; used_at: string | null }>(
		"SELECT id, space_id, conversation_id, at, used_at FROM tool_sandbox_prewarm_log WHERE org_id = ? AND fired = 1 AND at >= ? AND at < ? ORDER BY space_id, conversation_id, id",
		orgId, from, to,
	);
	let wasted = 0;
	let pending = 0;
	let wastedRunningMs = 0;
	for (let i = 0; i < fired.length; i++) {
		const f = fired[i]!;
		const next = fired[i + 1];
		const nextAt = next && next.space_id === f.space_id && next.conversation_id === f.conversation_id ? next.at : "9999";
		const start = ctx.db.get<{ id: number; workspace_key: string; provider: string }>(
			`SELECT id, workspace_key, provider FROM tool_sandbox_events WHERE org_id = ? AND space_id = ? AND conversation_id = ? AND "trigger" = 'prewarm' AND kind IN ('create','resume') AND at >= ? AND at < ? ORDER BY id LIMIT 1`,
			orgId, f.space_id, f.conversation_id, f.at, nextAt,
		);
		if (!start) continue; // the start failed (or is still running): no sandbox, nothing wasted
		const end = ctx.db.get<{ at: string; running_ms: number | null }>(
			`SELECT at, running_ms FROM tool_sandbox_events WHERE org_id = ? AND space_id = ? AND workspace_key = ? AND provider = ? AND kind IN ('pause','destroy') AND id > ? ORDER BY id LIMIT 1`,
			orgId, f.space_id, start.workspace_key, start.provider, start.id,
		);
		const usedInTime = f.used_at !== null && (!end || f.used_at <= end.at);
		if (usedInTime) continue;
		if (!end) pending++;
		else {
			wasted++;
			wastedRunningMs += end.running_ms ?? 0;
		}
	}
	return { threshold: cfg.threshold, enabled: cfg.enabled, decisions: st.decisions, fired: st.fired, firedUsed: st.firedUsed, precision: st.precision, recall: st.recall, wasted, pending, wastedRunningMs, whatIf: st.sweep };
}

export interface SandboxStatsOptions {
	readonly from: string;
	readonly to: string;
	readonly provider: string | null;
	/** Decides which conversation titles may be shown (the viewer's read access); default: none. */
	readonly titleOf?: (spaceId: string, conversationId: number) => Promise<string | null>;
	readonly now?: number;
}

/** Organisation-wide statistics (permission checked by the caller). */
export async function sandboxStats(ctx: AppContext, orgId: string, o: SandboxStatsOptions): Promise<SandboxStatsDTO> {
	const now = o.now ?? Date.now();
	const prices = readPrices(ctx, orgId);
	const c = collect(ctx, orgId, o.from, o.to, o.provider, now);
	const scope = costScope(o.provider, prices);
	const total = c.total.dto(prices, scope);
	const byProvider: SandboxProviderStatsDTO[] = [...c.byProvider.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([id, acc]) => ({ provider: id, priceUsdPerHour: prices[id] ?? null, ...acc.dto(prices, [id]) }));
	// Every provider with running time must be priced for the total cost to be complete.
	const costComplete = [...c.total.running.entries()].every(([id, ms]) => ms <= 0 || prices[id] !== undefined);
	const rows = [...c.byConv.values()]
		.map((x) => ({ x, dto: x.acc.dto(prices, scope) }))
		.sort((a, b) => b.dto.runningMs - a.dto.runningMs || b.dto.creates - a.dto.creates || a.x.conversationId - b.x.conversationId)
		.slice(0, TOP_CONVERSATIONS);
	const conversations: SandboxConversationStatsDTO[] = [];
	for (const { x, dto } of rows) conversations.push({ spaceId: x.spaceId, conversationId: x.conversationId, title: (await o.titleOf?.(x.spaceId, x.conversationId)) ?? null, ...dto });
	return {
		from: o.from,
		to: o.to,
		generatedAt: new Date(now).toISOString(),
		provider: o.provider,
		total,
		costComplete,
		byProvider,
		conversations,
		prewarm: prewarmTuning(ctx, orgId, o.from, o.to),
	};
}

/** One conversation over its whole life (events and open intervals up to now). `costVisible` false -> cost is always null. */
export function conversationSandboxStats(ctx: AppContext, orgId: string, spaceId: string, conversationId: number, costVisible: boolean, now = Date.now()): { stats: SandboxLifecycleStatsDTO } {
	const prices = costVisible ? readPrices(ctx, orgId) : {};
	const c = collect(ctx, orgId, "", "9999", null, now, { spaceId, conversationId });
	return { stats: c.total.dto(prices, costScope(null, prices)) };
}
