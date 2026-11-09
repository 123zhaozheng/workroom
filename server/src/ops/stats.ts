// Analytics (round 4, stats group). Every figure is an aggregate over stored records, never an estimate:
//   usage_ledger (projection of pi-durable facts), file_versions, kb_retrieval_events, auto_runs.
// Definitions live in docs/stats.md. Scope permission: the RBAC `authz` service when present (stats.*.view / stats.export),
// otherwise the existing usage scope rules (UsageService.scopeFilter).
import type { AppContext, AuthzScope, Principal } from "../core/contracts.ts";
import { HttpError } from "../core/http.ts";
import type { Identity } from "../identity/module.ts";
import type {
	OutcomeCounts,
	StatsConversationRowDTO,
	StatsGranularity,
	StatsKpiDTO,
	StatsKpiKey,
	StatsOverviewDTO,
	StatsScopeOption,
	StatsScopesDTO,
	StatsSeriesItemDTO,
	StatsToolRowDTO,
	StatsTopRowDTO,
} from "../../../shared/ops.ts";
import type { StatsScope, UsageService } from "./usage.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const BILLABLE = new Set(["model_request", "tool_call", "adjustment"]);
const LATENCY_BOUNDS = [250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000, null] as const;
const OUTCOMES = ["success", "failed", "cancelled", "timeout", "awaiting_approval", "in_progress"] as const;

export interface StatsQuery {
	from?: string;
	to?: string;
	granularity?: string;
	/** Minutes east of UTC (e.g. 480 for Asia/Shanghai). Buckets, the calendar and the punch card are local to this offset. */
	tz?: number;
	largeContextTokens?: number;
}

interface Resolved {
	scope: StatsScope;
	key: string;
	label: string;
	orgId: string;
	userId: string;
	personalSpaceId?: string;
	projectSpaceId?: string;
	demo: boolean;
}
interface Cols {
	org?: string;
	user?: string;
	space?: string;
	project?: string;
	dept?: string;
}
const LEDGER: Cols = { org: "l.org_id", user: "l.user_id", project: "l.project_id", dept: "l.department_ids" };
const FILES: Cols = { org: "(SELECT s.org_id FROM id_spaces s WHERE s.id = v.space_id)", user: "v.created_by", space: "v.space_id" };
const KB: Cols = { org: "k.org_id", user: "k.user_id", space: "k.space_id" };
const AUTO: Cols = { org: "r.org_id", user: "(SELECT a.owner_user_id FROM auto_automations a WHERE a.id = r.automation_id)", space: "r.space_id" };

export const scopeKey = (s: StatsScope): string => (s.kind === "project" ? `project:${s.projectId}` : s.kind === "department" ? `department:${s.departmentId}` : s.kind);

// ------------------------------------------------------------------ time helpers (all local = UTC + tz minutes)
const pad = (n: number) => String(n).padStart(2, "0");
const dayLabel = (localMs: number) => {
	const d = new Date(localMs);
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const hourLabel = (localMs: number) => `${dayLabel(localMs)} ${pad(new Date(localMs).getUTCHours())}:00`;
const floorDay = (ms: number) => Math.floor(ms / DAY) * DAY;
/** Monday 00:00 of the local week containing the instant. */
const floorWeek = (ms: number) => {
	const d = floorDay(ms);
	return d - ((new Date(d).getUTCDay() + 6) % 7) * DAY;
};

function bucketList(fromMs: number, toMs: number, gran: StatsGranularity, tz: number): string[] {
	const off = tz * 60_000;
	const out: string[] = [];
	const lastLocal = toMs - 1 + off;
	if (gran === "hour") for (let t = Math.floor((fromMs + off) / HOUR) * HOUR; t <= lastLocal; t += HOUR) out.push(hourLabel(t));
	else if (gran === "day") for (let t = floorDay(fromMs + off); t <= lastLocal; t += DAY) out.push(dayLabel(t));
	else for (let t = floorWeek(fromMs + off); t <= lastLocal; t += 7 * DAY) out.push(dayLabel(t));
	return out;
}
const tzMod = (tz: number) => `'${tz >= 0 ? "+" : "-"}${Math.abs(tz)} minutes'`;
function bucketSql(col: string, gran: StatsGranularity, tz: number): string {
	const m = tzMod(tz);
	if (gran === "hour") return `strftime('%Y-%m-%d %H:00', ${col}, ${m})`;
	if (gran === "day") return `strftime('%Y-%m-%d', ${col}, ${m})`;
	return `date(${col}, ${m}, '-6 days', 'weekday 1')`;
}

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: number[], q: number): number | null {
	if (!sorted.length) return null;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

const emptyCounts = (): OutcomeCounts => ({ success: 0, failed: 0, cancelled: 0, timeout: 0, awaiting_approval: 0, in_progress: 0, total: 0 });

interface LedgerAgg {
	b: string;
	kind: string;
	outcome: string;
	fixture: number;
	n: number;
	i: number;
	o: number;
	cr: number;
	cw: number;
	t: number;
	cost: number;
}
interface Agg {
	ledger: LedgerAgg[];
	convTotal: number;
	conv: Map<string, number>;
	dur: { b: string; d: number; fx: number }[];
	files: { b: string; origin: string; n: number }[];
	kb: { b: string; source: string; reason: string | null; hit: number; n: number; lat: number }[];
	auto: { b: string; status: string; n: number }[];
}

export class StatsService {
	readonly #ctx: AppContext;
	readonly #usage: UsageService;
	constructor(ctx: AppContext, usage: UsageService) {
		this.#ctx = ctx;
		this.#usage = usage;
	}
	get #db() {
		return this.#ctx.db;
	}
	get #id() {
		return this.#ctx.services.get("identity") as Identity;
	}

	isDemoOrg(orgId: string): boolean {
		return !!this.#db.get("SELECT 1 FROM ops_demo_orgs WHERE org_id = ?", orgId);
	}

	// ------------------------------------------------------------------ permission
	/**
	 * With the RBAC `authz` service present it is authoritative: personal = stats.personal.view; org = stats.org.view;
	 * department = stats.department.view (department heads hold it by default); project = stats.project.view (project owners
	 * hold it by default); export of anything but your own data = stats.export. Without it the legacy rule applies
	 * (UsageService.scopeFilter: personal any member, project owner / org admin, department manager / org admin, org admin).
	 */
	async #canView(p: Principal, scope: StatsScope): Promise<boolean> {
		if (this.#ctx.services.has("authz")) {
			const authz = this.#ctx.services.get("authz");
			const [perm, as]: [string, AuthzScope | undefined] =
				scope.kind === "personal" ? ["stats.personal.view", undefined] : scope.kind === "org" ? ["stats.org.view", { kind: "org" }] : scope.kind === "project" ? ["stats.project.view", { kind: "project", id: scope.projectId }] : ["stats.department.view", { kind: "department", id: scope.departmentId }];
			try {
				return await authz.has(p, perm, as);
			} catch {
				return false;
			}
		}
		try {
			await this.#usage.scopeFilter(p, scope);
			return true;
		} catch (e) {
			if (e instanceof HttpError && (e.status === 403 || e.status === 404)) return false;
			throw e;
		}
	}
	async canExport(p: Principal, scope: StatsScope): Promise<boolean> {
		if (!(await this.#canView(p, scope))) return false;
		if (scope.kind === "personal" || !this.#ctx.services.has("authz")) return true;
		try {
			return await this.#ctx.services.get("authz").has(p, "stats.export", { kind: "org" });
		} catch {
			return false;
		}
	}

	async #resolve(p: Principal, scope: StatsScope): Promise<Resolved> {
		if (!(await this.#canView(p, scope))) throw new HttpError(403, "forbidden", "无权查看该范围的统计", { scope: scopeKey(scope) });
		const id = this.#id;
		const orgName = this.#db.get<{ name: string }>("SELECT name FROM id_orgs WHERE id = ?", p.orgId)?.name ?? "组织";
		const r: Resolved = { scope, key: scopeKey(scope), label: "", orgId: p.orgId, userId: p.userId, demo: this.isDemoOrg(p.orgId) };
		switch (scope.kind) {
			case "personal":
				r.label = "个人";
				r.personalSpaceId = id.personalSpace(p.userId, p.orgId).id;
				break;
			case "org":
				r.label = `组织：${orgName}`;
				break;
			case "project": {
				const pr = this.#db.get<{ name: string }>("SELECT name FROM id_projects WHERE id = ? AND org_id = ?", scope.projectId, p.orgId);
				if (!pr) throw new HttpError(404, "project_not_found", "项目不存在");
				r.label = `项目：${pr.name}`;
				r.projectSpaceId = id.projectSpace(scope.projectId)?.id;
				break;
			}
			case "department": {
				const d = this.#db.get<{ name: string }>("SELECT name FROM id_departments WHERE id = ? AND org_id = ?", scope.departmentId, p.orgId);
				if (!d) throw new HttpError(404, "department_not_found", "部门不存在");
				r.label = `部门：${d.name}`;
				break;
			}
		}
		return r;
	}

	/** SQL for "row belongs to this scope" on a table described by `c` (aliases are part of the column expressions). */
	#frag(r: Resolved, c: Cols): { sql: string; params: (string | number)[] } {
		const parts: string[] = [];
		const params: (string | number)[] = [];
		if (c.org) (parts.push(`${c.org} = ?`), params.push(r.orgId));
		switch (r.scope.kind) {
			case "personal":
				if (c.user) (parts.push(`${c.user} = ?`), params.push(r.userId));
				else if (c.space) (parts.push(`${c.space} = ?`), params.push(r.personalSpaceId!));
				break;
			case "project":
				if (c.project) (parts.push(`${c.project} = ?`), params.push(r.scope.projectId));
				else if (c.space) (parts.push(`${c.space} = ?`), params.push(r.projectSpaceId ?? "-"));
				break;
			case "department":
				if (c.dept) (parts.push(`${c.dept} LIKE ?`), params.push(`%,${r.scope.departmentId},%`));
				else if (c.user) (parts.push(`${c.user} IN (SELECT user_id FROM id_department_members WHERE department_id = ? AND removed_at IS NULL)`), params.push(r.scope.departmentId));
				break;
		}
		return { sql: parts.join(" AND ") || "1 = 1", params };
	}
	/** Ledger filter incl. the demo guard: real orgs never see demo-marked rows. */
	#lf(r: Resolved, alias = "l") {
		const f = this.#frag(r, LEDGER);
		return { sql: `${f.sql}${r.demo ? "" : ` AND ${alias}.demo = 0`}`, params: f.params };
	}

	// ------------------------------------------------------------------ scopes list
	async scopes(p: Principal): Promise<StatsScopesDTO> {
		const orgName = this.#db.get<{ name: string }>("SELECT name FROM id_orgs WHERE id = ?", p.orgId)?.name ?? "组织";
		const scopes: StatsScopeOption[] = [{ key: "personal", kind: "personal", label: "个人" }];
		if (await this.#canView(p, { kind: "org" })) scopes.push({ key: "org", kind: "org", label: `组织：${orgName}` });
		for (const d of this.#db.all<{ id: string; name: string }>("SELECT id, name FROM id_departments WHERE org_id = ? AND archived_at IS NULL ORDER BY name", p.orgId)) if (await this.#canView(p, { kind: "department", departmentId: d.id })) scopes.push({ key: `department:${d.id}`, kind: "department", label: `部门：${d.name}` });
		for (const pr of this.#db.all<{ id: string; name: string }>("SELECT id, name FROM id_projects WHERE org_id = ? AND archived_at IS NULL ORDER BY name", p.orgId)) if (await this.#canView(p, { kind: "project", projectId: pr.id })) scopes.push({ key: `project:${pr.id}`, kind: "project", label: `项目：${pr.name}` });
		return { orgId: p.orgId, orgName, demo: this.isDemoOrg(p.orgId), scopes, exportable: scopes.length > 0 };
	}

	// ------------------------------------------------------------------ aggregation
	#collect(r: Resolved, from: string, to: string, gran: StatsGranularity | null, tz: number): Agg {
		const db = this.#db;
		const B = (col: string) => (gran ? bucketSql(col, gran, tz) : "'*'");
		const lf = this.#lf(r);
		const ledger = db.all<LedgerAgg>(
			`SELECT ${B("l.at")} AS b, l.kind, l.outcome, l.fixture, COUNT(*) AS n, COALESCE(SUM(l.input_tokens),0) AS i, COALESCE(SUM(l.output_tokens),0) AS o, COALESCE(SUM(l.cache_read),0) AS cr, COALESCE(SUM(l.cache_write),0) AS cw, COALESCE(SUM(l.total_tokens),0) AS t, COALESCE(SUM(l.cost),0) AS cost
			 FROM usage_ledger l WHERE ${lf.sql} AND l.at >= ? AND l.at < ? GROUP BY b, l.kind, l.outcome, l.fixture`,
			...lf.params,
			from,
			to,
		);
		const convKey = "l.space_id || ':' || l.conversation_id";
		const conv = new Map<string, number>();
		if (gran) for (const x of db.all<{ b: string; n: number }>(`SELECT ${B("l.at")} AS b, COUNT(DISTINCT ${convKey}) AS n FROM usage_ledger l WHERE ${lf.sql} AND l.kind = 'task' AND l.at >= ? AND l.at < ? GROUP BY b`, ...lf.params, from, to)) conv.set(x.b, x.n);
		const convTotal = db.get<{ n: number }>(`SELECT COUNT(DISTINCT ${convKey}) AS n FROM usage_ledger l WHERE ${lf.sql} AND l.kind = 'task' AND l.at >= ? AND l.at < ?`, ...lf.params, from, to)!.n;
		const dur = db.all<{ b: string; d: number; fx: number }>(`SELECT ${B("l.at")} AS b, l.duration_ms AS d, l.fixture AS fx FROM usage_ledger l WHERE ${lf.sql} AND l.kind = 'model_request' AND l.duration_ms IS NOT NULL AND l.at >= ? AND l.at < ?`, ...lf.params, from, to);
		const ff = this.#frag(r, FILES);
		const files = db.all<{ b: string; origin: string; n: number }>(`SELECT ${B("v.created_at")} AS b, v.origin, COUNT(*) AS n FROM file_versions v WHERE ${ff.sql} AND v.origin != 'upload' AND v.created_at >= ? AND v.created_at < ? GROUP BY b, v.origin`, ...ff.params, from, to);
		const kf = this.#frag(r, KB);
		const kb = db.all<Agg["kb"][number]>(`SELECT ${B("k.at")} AS b, k.source, k.reason, (k.hit_count > 0) AS hit, COUNT(*) AS n, COALESCE(SUM(k.latency_ms),0) AS lat FROM kb_retrieval_events k WHERE ${kf.sql} AND k.source != 'eval' AND k.at >= ? AND k.at < ? GROUP BY b, k.source, k.reason, hit`, ...kf.params, from, to);
		const af = this.#frag(r, AUTO);
		const auto = db.all<{ b: string; status: string; n: number }>(`SELECT ${B("r.created_at")} AS b, r.status, COUNT(*) AS n FROM auto_runs r WHERE ${af.sql} AND r.created_at >= ? AND r.created_at < ? GROUP BY b, r.status`, ...af.params, from, to);
		return { ledger, convTotal, conv, dur, files, kb, auto };
	}

	/** KPI values over the aggregate (all buckets, or one bucket label). Rates / latency are null when there is nothing to divide. */
	#values(agg: Agg, only?: string): Record<StatsKpiKey, number | null> & { _sim: Record<string, number> } {
		const L = only === undefined ? agg.ledger : agg.ledger.filter((x) => x.b === only);
		const n = (kind: string, pred?: (x: LedgerAgg) => boolean) => L.filter((x) => x.kind === kind && (!pred || pred(x))).reduce((s, x) => s + x.n, 0);
		const bill = L.filter((x) => BILLABLE.has(x.kind));
		const real = bill.filter((x) => !x.fixture);
		const sim = bill.filter((x) => x.fixture);
		const sum = (a: LedgerAgg[], k: "i" | "o" | "cr" | "cw" | "t" | "cost") => a.reduce((s, x) => s + x[k], 0);
		const runsOk = n("run", (x) => x.outcome === "success");
		const runsDen = runsOk + n("run", (x) => x.outcome === "failed" || x.outcome === "timeout");
		const ds = agg.dur.filter((x) => only === undefined || x.b === only);
		const realD = ds.filter((x) => !x.fx).map((x) => x.d).sort((a, b) => a - b);
		const simD = ds.filter((x) => x.fx).map((x) => x.d).sort((a, b) => a - b);
		const sumN = <T extends { b: string; n: number }>(a: T[], pred?: (x: T) => boolean) => a.filter((x) => (only === undefined || x.b === only) && (!pred || pred(x))).reduce((s, x) => s + x.n, 0);
		return {
			conversations: only === undefined ? agg.convTotal : (agg.conv.get(only) ?? 0),
			runs: n("run"),
			modelRequests: n("model_request"),
			toolCalls: n("tool_call"),
			filesProduced: sumN(agg.files),
			knowledgeSearches: sumN(agg.kb),
			automationRuns: sumN(agg.auto),
			successRate: runsDen ? runsOk / runsDen : null,
			latencyP50: percentile(realD, 0.5),
			latencyP95: percentile(realD, 0.95),
			inputTokens: sum(real, "i"),
			outputTokens: sum(real, "o"),
			cacheTokens: sum(real, "cr") + sum(real, "cw"),
			cost: sum(real, "cost"),
			_sim: { inputTokens: sum(sim, "i"), outputTokens: sum(sim, "o"), cacheTokens: sum(sim, "cr") + sum(sim, "cw"), total: sum(sim, "t"), latencyP50: percentile(simD, 0.5) ?? NaN, latencyP95: percentile(simD, 0.95) ?? NaN },
		};
	}

	/** Large-context failure concentration (same definition as GET /stats largeContext, docs/ops.md §3.4) over this scope. */
	#largeContext(r: Resolved, from: string, to: string, threshold: number): StatsOverviewDTO["largeContext"] {
		const lf = this.#lf(r);
		const large = this.#db.all<{ outcome: string; error_class: string | null; platform_model_id: string | null; route: string | null; automation_id: string | null; tool_round: number }>(
			`SELECT outcome, error_class, platform_model_id, route, automation_id, EXISTS (SELECT 1 FROM usage_ledger t WHERE t.space_id = l.space_id AND t.conversation_id = l.conversation_id AND t.kind = 'tool_call' AND t.entry_id < l.entry_id AND t.entry_id > COALESCE((SELECT MAX(i.entry_id) FROM usage_ledger i WHERE i.space_id = l.space_id AND i.conversation_id = l.conversation_id AND i.kind = 'task' AND i.entry_id < l.entry_id), 0)) AS tool_round
			 FROM usage_ledger l WHERE ${lf.sql} AND l.at >= ? AND l.at < ? AND l.kind = 'model_request' AND (input_tokens + cache_read + cache_write) >= ?`,
			...lf.params,
			from,
			to,
			threshold,
		);
		const failed = large.filter((x) => x.outcome !== "success");
		const byErrorClass: Record<string, number> = {};
		for (const x of failed) byErrorClass[x.error_class ?? "unknown"] = (byErrorClass[x.error_class ?? "unknown"] ?? 0) + 1;
		const group = (key: (x: (typeof large)[number]) => string) => {
			const m = new Map<string, { requests: number; failed: number }>();
			for (const x of large) {
				const k = key(x);
				const g = m.get(k) ?? { requests: 0, failed: 0 };
				g.requests++;
				if (x.outcome !== "success") g.failed++;
				m.set(k, g);
			}
			return [...m].map(([k, g]) => ({ key: k, ...g, failureRate: g.failed / g.requests })).sort((a, b) => b.failed - a.failed || b.requests - a.requests);
		};
		return {
			thresholdTokens: threshold,
			requests: large.length,
			failed: failed.length,
			failureRate: large.length ? failed.length / large.length : null,
			byErrorClass,
			byModel: group((x) => x.platform_model_id ?? "unknown"),
			byRoute: group((x) => x.route ?? "unknown"),
			byStage: group((x) => (x.automation_id ? "automation" : x.tool_round ? "after_tools" : "first_turn")),
		};
	}

	// ------------------------------------------------------------------ overview
	async overview(p: Principal, scope: StatsScope, q: StatsQuery): Promise<StatsOverviewDTO> {
		const r = await this.#resolve(p, scope);
		const tz = Math.max(-840, Math.min(840, Math.trunc(Number(q.tz) || 0)));
		const toMs = q.to ? Date.parse(q.to) : this.#usage.now();
		const fromMs = q.from ? Date.parse(q.from) : toMs - 30 * DAY;
		if (!Number.isFinite(toMs) || !Number.isFinite(fromMs) || fromMs >= toMs) throw new HttpError(400, "invalid_range", "时间范围无效：from 必须早于 to（ISO 8601）");
		if (toMs - fromMs > 800 * DAY) throw new HttpError(400, "range_too_long", "时间范围最长 800 天");
		const requested: StatsGranularity = q.granularity === "hour" || q.granularity === "week" ? q.granularity : "day";
		let gran = requested;
		if (gran === "hour" && toMs - fromMs > 14 * DAY) gran = "day";
		if (gran === "day" && toMs - fromMs > 400 * DAY) gran = "week";
		const from = new Date(fromMs).toISOString();
		const to = new Date(toMs).toISOString();
		const len = toMs - fromMs;
		const prevFrom = new Date(fromMs - len).toISOString();
		const buckets = bucketList(fromMs, toMs, gran, tz);

		await this.#usage.importDirty({ orgId: p.orgId });
		const cur = this.#collect(r, from, to, gran, tz);
		const prev = this.#collect(r, prevFrom, from, null, tz);
		const cv = this.#values(cur);
		const pv = this.#values(prev);
		const perBucket = buckets.map((b) => this.#values(cur, b));
		const simReq = cur.ledger.filter((x) => x.kind === "model_request" && x.fixture).reduce((s, x) => s + x.n, 0);
		const realReq = cur.ledger.filter((x) => x.kind === "model_request" && !x.fixture).reduce((s, x) => s + x.n, 0);

		const kpiKeys: StatsKpiKey[] = ["conversations", "runs", "modelRequests", "toolCalls", "filesProduced", "knowledgeSearches", "automationRuns", "successRate", "latencyP50", "latencyP95", "inputTokens", "outputTokens", "cacheTokens", "cost"];
		const kpis: StatsKpiDTO[] = kpiKeys.map((key) => {
			const value = cv[key];
			const previous = pv[key];
			const delta = value != null && previous != null ? value - previous : null;
			const k: StatsKpiDTO = { key, value, previous, delta, deltaPct: key !== "successRate" && delta != null && previous ? delta / previous : null, spark: perBucket.map((v) => v[key]) };
			const simV = key === "inputTokens" || key === "outputTokens" || key === "cacheTokens" ? cv._sim[key] : key === "latencyP50" || key === "latencyP95" ? cv._sim[key] : undefined;
			if (simV !== undefined && Number.isFinite(simV) && simV > 0) k.simulatedValue = simV;
			return k;
		});

		// Outcomes: one OutcomeCounts per counting unit (docs/ops.md §3.2).
		const counts = (kind: string): OutcomeCounts => {
			const c = emptyCounts();
			for (const x of cur.ledger) if (x.kind === kind && (OUTCOMES as readonly string[]).includes(x.outcome)) ((c as any)[x.outcome] += x.n), (c.total += x.n);
			return c;
		};

		const lf = this.#lf(r);
		const range = [from, to] as const;
		const lq = <T>(sql: string, ...extra: (string | number)[]) => this.#db.all<T>(sql.replace("{W}", `${lf.sql} AND l.at >= ? AND l.at < ?`), ...lf.params, ...range, ...extra);

		// Calendar: the 365 local days ending with the day of `to`.
		const lastDay = floorDay(toMs - 1 + tz * 60_000);
		const calStartLocal = lastDay - 364 * DAY;
		const calFrom = new Date(calStartLocal - tz * 60_000).toISOString();
		const calRows = this.#db.all<{ day: string; kind: string; outcome: string; n: number; t: number }>(
			`SELECT strftime('%Y-%m-%d', l.at, ${tzMod(tz)}) AS day, l.kind, l.outcome, COUNT(*) AS n, COALESCE(SUM(CASE WHEN l.kind = 'run' THEN 0 ELSE l.total_tokens END),0) AS t FROM usage_ledger l WHERE ${lf.sql} AND l.at >= ? AND l.at < ? AND l.kind IN ('run','model_request','tool_call','adjustment') GROUP BY day, l.kind, l.outcome`,
			...lf.params,
			calFrom,
			to,
		);
		const days = new Map<string, { day: string; runs: number; modelRequests: number; toolCalls: number; tokens: number; failedRuns: number }>();
		for (const x of calRows) {
			const d = days.get(x.day) ?? { day: x.day, runs: 0, modelRequests: 0, toolCalls: 0, tokens: 0, failedRuns: 0 };
			if (x.kind === "run") (d.runs += x.n), x.outcome === "failed" || x.outcome === "timeout" ? (d.failedRuns += x.n) : 0;
			if (x.kind === "model_request") d.modelRequests += x.n;
			if (x.kind === "tool_call") d.toolCalls += x.n;
			d.tokens += x.t;
			days.set(x.day, d);
		}

		// Punch card: weekday (Mon = 0) × local hour over the selected range.
		const pc = new Map<string, { weekday: number; hour: number; runs: number; modelRequests: number; toolCalls: number; tokens: number }>();
		for (const x of lq<{ w: string; h: string; kind: string; n: number; t: number }>(`SELECT strftime('%w', l.at, ${tzMod(tz)}) AS w, strftime('%H', l.at, ${tzMod(tz)}) AS h, l.kind, COUNT(*) AS n, COALESCE(SUM(CASE WHEN l.kind = 'run' THEN 0 ELSE l.total_tokens END),0) AS t FROM usage_ledger l WHERE {W} AND l.kind IN ('run','model_request','tool_call','adjustment') GROUP BY w, h, l.kind`)) {
			const weekday = (Number(x.w) + 6) % 7;
			const hour = Number(x.h);
			const c = pc.get(`${weekday}-${hour}`) ?? { weekday, hour, runs: 0, modelRequests: 0, toolCalls: 0, tokens: 0 };
			if (x.kind === "run") c.runs += x.n;
			if (x.kind === "model_request") c.modelRequests += x.n;
			if (x.kind === "tool_call") c.toolCalls += x.n;
			c.tokens += x.t;
			pc.set(`${weekday}-${hour}`, c);
		}

		// Series by model / provider / route (model requests; tokens include compaction adjustments attributable to a model).
		// display names of every native model ("<provider>/<modelId>"), fixture and legacy aliases included (gateway.modelLabels)
		const labels: Map<string, string> = this.#ctx.services.has("models") ? (this.#ctx.services.get("models") as unknown as { modelLabels(): Map<string, string> }).modelLabels() : new Map();
		const seriesRows = this.#db.all<{ b: string; m: string; route: string | null; fixture: number; outcome: string; kind: string; n: number; t: number }>(
			`SELECT ${bucketSql("l.at", gran, tz)} AS b, COALESCE(l.platform_model_id, 'unknown') AS m, l.route, l.fixture, l.outcome, l.kind, COUNT(*) AS n, COALESCE(SUM(l.total_tokens),0) AS t FROM usage_ledger l WHERE ${lf.sql} AND l.at >= ? AND l.at < ? AND l.kind IN ('model_request','adjustment') GROUP BY b, m, l.route, l.fixture, l.outcome, l.kind`,
			...lf.params,
			...range,
		);
		const bIdx = new Map(buckets.map((b, i) => [b, i]));
		const dim = (keyOf: (x: (typeof seriesRows)[number]) => string, labelOf: (k: string) => string): StatsSeriesItemDTO[] => {
			const m = new Map<string, StatsSeriesItemDTO & { _real: number }>();
			for (const x of seriesRows) {
				const i = bIdx.get(x.b);
				if (i === undefined) continue;
				const k = keyOf(x);
				let it = m.get(k);
				if (!it) {
					it = { key: k, label: labelOf(k), simulated: false, requests: buckets.map(() => 0), tokens: buckets.map(() => 0), simulatedTokens: buckets.map(() => 0), totalRequests: 0, totalTokens: 0, totalSimulatedTokens: 0, failedRequests: 0, _real: 0 };
					m.set(k, it);
				}
				if (x.kind === "model_request") {
					it.requests[i]! += x.n;
					it.totalRequests += x.n;
					if (x.outcome !== "success") it.failedRequests += x.n;
				}
				it.tokens[i]! += x.t;
				it.totalTokens += x.t;
				if (x.fixture) (it.simulatedTokens[i]! += x.t), (it.totalSimulatedTokens += x.t);
				else it._real += x.n;
			}
			const all = [...m.values()].map(({ _real, ...it }) => ({ ...it, simulated: _real === 0 })).sort((a, b) => b.totalRequests - a.totalRequests || b.totalTokens - a.totalTokens || a.key.localeCompare(b.key));
			if (all.length <= 8) return all;
			const top = all.slice(0, 7);
			const rest = all.slice(7);
			const other: StatsSeriesItemDTO = { key: "__other", label: "其他", simulated: rest.every((x) => x.simulated), requests: buckets.map(() => 0), tokens: buckets.map(() => 0), simulatedTokens: buckets.map(() => 0), totalRequests: 0, totalTokens: 0, totalSimulatedTokens: 0, failedRequests: 0 };
			for (const x of rest) {
				buckets.forEach((_, i) => ((other.requests[i]! += x.requests[i]!), (other.tokens[i]! += x.tokens[i]!), (other.simulatedTokens[i]! += x.simulatedTokens[i]!)));
				other.totalRequests += x.totalRequests;
				other.totalTokens += x.totalTokens;
				other.totalSimulatedTokens += x.totalSimulatedTokens;
				other.failedRequests += x.failedRequests;
			}
			return [...top, other];
		};
		const providerOf = (route: string | null) => (route ? route.split("/")[0]! : "unknown");
		const series = {
			buckets,
			model: dim((x) => x.m, (k) => labels.get(k) ?? k),
			provider: dim((x) => providerOf(x.route), (k) => k),
			route: dim((x) => x.route ?? "unknown", (k) => k),
		};

		// Tools
		const tools: StatsToolRowDTO[] = lq<{ tool: string; calls: number; errors: number; avg: number | null }>(`SELECT COALESCE(l.tool_name, 'unknown') AS tool, COUNT(*) AS calls, SUM(l.outcome != 'success') AS errors, AVG(l.duration_ms) AS avg FROM usage_ledger l WHERE {W} AND l.kind = 'tool_call' GROUP BY tool ORDER BY calls DESC, tool LIMIT 15`).map((x) => ({ tool: x.tool, calls: x.calls, errors: x.errors, errorRate: x.calls ? x.errors / x.calls : 0, avgDurationMs: x.avg == null ? null : Math.round(x.avg) }));

		// Latency (real requests when any exist; otherwise the simulated ones, labelled)
		const durs = cur.dur;
		const realD = durs.filter((x) => !x.fx).map((x) => x.d).sort((a, b) => a - b);
		const simD = durs.filter((x) => x.fx).map((x) => x.d).sort((a, b) => a - b);
		const useD = realD.length ? realD : simD;
		const lb = LATENCY_BOUNDS.map((le, i) => ({ le, count: useD.filter((d) => (le === null ? d > LATENCY_BOUNDS[i - 1]! : d <= le && (i === 0 || d > LATENCY_BOUNDS[i - 1]!))).length }));
		const latency = { count: useD.length, source: (realD.length ? "real" : simD.length ? "simulated" : "none") as "real" | "simulated" | "none", p50: percentile(useD, 0.5), p90: percentile(useD, 0.9), p95: percentile(useD, 0.95), p99: percentile(useD, 0.99), max: useD.length ? useD[useD.length - 1]! : null, avg: useD.length ? Math.round(useD.reduce((s, x) => s + x, 0) / useD.length) : null, buckets: lb };

		// Top users / projects
		const userName = new Map(this.#db.all<{ id: string; name: string }>("SELECT id, name FROM id_users").map((u) => [u.id, u.name]));
		const projName = new Map(this.#db.all<{ id: string; name: string; org_id: string }>("SELECT id, name, org_id FROM id_projects WHERE org_id = ?", p.orgId).map((x) => [x.id, x.name]));
		const topBy = (col: "user_id" | "project_id"): StatsTopRowDTO[] =>
			[...lq<{ k: string | null; kind: string; outcome: string; fixture: number; n: number; t: number; c: number }>(`SELECT l.${col} AS k, l.kind, l.outcome, l.fixture, COUNT(*) AS n, COALESCE(SUM(l.total_tokens),0) AS t, COALESCE(SUM(l.cost),0) AS c FROM usage_ledger l WHERE {W} AND l.kind IN ('run','model_request','tool_call','adjustment') GROUP BY k, l.kind, l.outcome, l.fixture`).reduce((acc, x) => {
				const key = x.k ?? "";
				let row = acc.get(key);
				if (!row) acc.set(key, (row = { id: key, name: col === "user_id" ? (userName.get(key) ?? "（未知成员）") : key === "" ? "个人空间" : (projName.get(key) ?? "（已离开的项目）"), runs: 0, modelRequests: 0, toolCalls: 0, tokens: 0, simulatedTokens: 0, failedRuns: 0, cost: 0 }));
				if (x.kind === "run") (row.runs += x.n), x.outcome === "failed" || x.outcome === "timeout" ? (row.failedRuns += x.n) : 0;
				if (x.kind === "model_request") row.modelRequests += x.n;
				if (x.kind === "tool_call") row.toolCalls += x.n;
				if (x.kind === "run") return acc; // run rows carry per-run sums for display only; billing lives in model_request / tool_call / adjustment rows
				if (x.fixture) row.simulatedTokens += x.t;
				else (row.tokens += x.t), (row.cost += x.c);
				return acc;
			}, new Map<string, StatsTopRowDTO>()).values()].filter((x) => (col === "user_id" ? x.id !== "" : true)).sort((a, b) => b.runs - a.runs || b.modelRequests - a.modelRequests || a.name.localeCompare(b.name)).slice(0, 10);
		const topUsers = scope.kind === "personal" ? [] : topBy("user_id");
		const topProjects = scope.kind === "project" ? [] : topBy("project_id");

		// Conversations drilldown (titles / links only where the viewer may read the conversation and it really exists)
		const convRows = lq<{ space_id: string; cid: number; user_id: string | null; project_id: string | null; runs: number; reqs: number; failed: number; tokens: number; sim: number; last: string; demo: number }>(
			`SELECT l.space_id, l.conversation_id AS cid, MAX(l.user_id) AS user_id, MAX(l.project_id) AS project_id, SUM(l.kind='run') AS runs, SUM(l.kind='model_request') AS reqs, SUM(l.kind='run' AND l.outcome IN ('failed','timeout')) AS failed, COALESCE(SUM(CASE WHEN l.kind IN ('model_request','tool_call','adjustment') THEN l.total_tokens ELSE 0 END),0) AS tokens, MAX(l.fixture) AS sim, MAX(l.at) AS last, MAX(l.demo) AS demo FROM usage_ledger l WHERE {W} GROUP BY l.space_id, l.conversation_id HAVING runs > 0 ORDER BY runs DESC, reqs DESC, last DESC LIMIT 12`,
		);
		const readable = async (spaceId: string, cid: number, demoRow: boolean): Promise<{ title: string | null; link: string | null }> => {
			if (demoRow) return { title: this.#db.get<{ title: string }>("SELECT title FROM rt_conversations WHERE space_id = ? AND conversation_id = ?", spaceId, cid)?.title ?? `演示对话 #${cid}`, link: null };
			let ok = false;
			try {
				ok = (await this.#id.check(p, "read", { kind: "conversation", id: String(cid), spaceId })).allow;
			} catch {
				ok = false;
			}
			if (!ok) return { title: null, link: null };
			const t = this.#db.get<{ title: string }>("SELECT title FROM rt_conversations WHERE space_id = ? AND conversation_id = ?", spaceId, cid);
			return { title: t?.title ?? `对话 #${cid}`, link: t ? `/c/${spaceId}/${cid}` : null };
		};
		const conversations: StatsConversationRowDTO[] = [];
		for (const x of convRows) {
			const rd = await readable(x.space_id, x.cid, !!x.demo);
			conversations.push({ spaceId: x.space_id, conversationId: x.cid, title: rd.title, userName: x.user_id ? (userName.get(x.user_id) ?? null) : null, projectId: x.project_id ?? undefined, projectName: x.project_id ? projName.get(x.project_id) : undefined, runs: x.runs, modelRequests: x.reqs, failedRuns: x.failed, tokens: x.tokens, simulated: !!x.sim, lastAt: x.last, link: rd.link });
		}
		const recentFailures: StatsOverviewDTO["recentFailures"] = [];
		for (const x of lq<{ at: string; space_id: string; cid: number; outcome: string; error_class: string | null; m: string | null; fixture: number; demo: number }>(`SELECT l.at, l.space_id, l.conversation_id AS cid, l.outcome, l.error_class, l.platform_model_id AS m, l.fixture, l.demo FROM usage_ledger l WHERE {W} AND l.kind = 'model_request' AND l.outcome IN ('failed','timeout') ORDER BY l.at DESC LIMIT 8`)) {
			const rd = await readable(x.space_id, x.cid, !!x.demo);
			recentFailures.push({ at: x.at, spaceId: x.space_id, conversationId: x.cid, outcome: x.outcome as any, errorClass: x.error_class ?? undefined, model: x.m ? (labels.get(x.m) ?? x.m) : undefined, title: rd.title, link: rd.link, simulated: !!x.fixture });
		}

		// Knowledge
		const kbS = { searches: 0, withHits: 0, noEvidence: 0, otherEmpty: 0, lat: 0, byReason: {} as Record<string, number>, bySource: {} as Record<string, number> };
		const kbSpark = buckets.map(() => ({ searches: 0, noEvidence: 0 }));
		for (const x of cur.kb) {
			kbS.searches += x.n;
			kbS.lat += x.lat;
			kbS.bySource[x.source] = (kbS.bySource[x.source] ?? 0) + x.n;
			const empty = !x.hit;
			const noEv = empty && (x.reason == null || x.reason === "no_evidence");
			if (x.hit) kbS.withHits += x.n;
			else {
				kbS.byReason[x.reason ?? "no_evidence"] = (kbS.byReason[x.reason ?? "no_evidence"] ?? 0) + x.n;
				noEv ? (kbS.noEvidence += x.n) : (kbS.otherEmpty += x.n);
			}
			const i = bIdx.get(x.b);
			if (i !== undefined) (kbSpark[i]!.searches += x.n), noEv ? (kbSpark[i]!.noEvidence += x.n) : 0;
		}
		const knowledge = { searches: kbS.searches, withHits: kbS.withHits, noEvidence: kbS.noEvidence, otherEmpty: kbS.otherEmpty, hitRate: kbS.searches ? kbS.withHits / kbS.searches : null, noEvidenceRate: kbS.searches ? kbS.noEvidence / kbS.searches : null, avgLatencyMs: kbS.searches ? Math.round(kbS.lat / kbS.searches) : null, byReason: kbS.byReason, bySource: kbS.bySource, spark: kbSpark };
		const autoBy: Record<string, number> = {};
		for (const x of cur.auto) autoBy[x.status] = (autoBy[x.status] ?? 0) + x.n;
		const filesBy: Record<string, number> = {};
		for (const x of cur.files) filesBy[x.origin] = (filesBy[x.origin] ?? 0) + x.n;

		const large = this.#largeContext(r, from, to, q.largeContextTokens && q.largeContextTokens > 0 ? q.largeContextTokens : 32_000);

		const notes: string[] = [];
		if (!cv.runs && !cv.modelRequests && !cv.toolCalls) {
			const ext = this.#db.get<{ lo: string | null; hi: string | null; n: number }>(`SELECT MIN(l.at) AS lo, MAX(l.at) AS hi, COUNT(*) AS n FROM usage_ledger l WHERE ${lf.sql}`, ...lf.params)!;
			notes.push(ext.n ? `此范围内没有记录；该范围之外有 ${ext.n} 条记录（${ext.lo?.slice(0, 10)} 至 ${ext.hi?.slice(0, 10)}）。` : "此范围内没有记录：该范围内还没有任何对话产生用量。");
		}
		if (simReq > 0 && realReq === 0) notes.push("此范围内只有测试模型（模拟）请求：Token 与耗时是模拟值，费用记为 0，不代表真实用量。");

		return {
			generatedAt: new Date(this.#usage.now()).toISOString(),
			scope: r.key,
			scopeLabel: r.label,
			orgName: this.#db.get<{ name: string }>("SELECT name FROM id_orgs WHERE id = ?", p.orgId)?.name ?? "组织",
			demo: r.demo,
			range: { from, to },
			previous: { from: prevFrom, to: from },
			granularity: gran,
			requestedGranularity: requested,
			tzOffsetMinutes: tz,
			kpis,
			simulation: { simulatedRequests: simReq, realRequests: realReq, onlySimulated: simReq > 0 && realReq === 0, simulatedTokens: { input: cv._sim.inputTokens!, output: cv._sim.outputTokens!, cacheRead: 0, cacheWrite: 0, total: cv._sim.total! } },
			calendar: { from: dayLabel(calStartLocal), to: dayLabel(lastDay), days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)) },
			punchCard: { cells: [...pc.values()].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour) },
			series,
			outcomes: { tasks: counts("task"), runs: counts("run"), modelRequests: counts("model_request"), toolCalls: counts("tool_call") },
			tools,
			latency,
			topUsers,
			topProjects,
			conversations,
			recentFailures,
			largeContext: large,
			knowledge,
			automation: { total: Object.values(autoBy).reduce((s, x) => s + x, 0), byStatus: autoBy },
			files: { versions: Object.values(filesBy).reduce((s, x) => s + x, 0), byOrigin: filesBy },
			notes,
		};
	}

	// ------------------------------------------------------------------ CSV (one table per chart; same data as the chart)
	async exportRows(p: Principal, scope: StatsScope, q: StatsQuery, chart: string, metric: string): Promise<{ columns: string[]; rows: Record<string, unknown>[]; name: string; overview: StatsOverviewDTO }> {
		if (!(await this.canExport(p, scope))) throw new HttpError(403, "forbidden", "无权导出该范围的统计数据");
		const o = await this.overview(p, scope, q);
		const sim = (b: boolean) => (b ? "模拟" : "真实");
		const need = (cols: string[], rows: readonly object[], name: string) => ({ columns: cols, rows: rows as Record<string, unknown>[], name, overview: o });
		switch (chart) {
			case "kpis":
				return need(["metric", "value", "previous", "delta", "deltaPct", "simulatedValue"], o.kpis.map((k) => ({ metric: k.key, value: k.value, previous: k.previous, delta: k.delta, deltaPct: k.deltaPct, simulatedValue: k.simulatedValue })), "kpis");
			case "calendar":
				return need(["day", "runs", "modelRequests", "toolCalls", "tokens", "failedRuns"], o.calendar.days, "calendar");
			case "punchcard":
				return need(["weekday", "hour", "runs", "modelRequests", "toolCalls", "tokens"], o.punchCard.cells.map((c) => ({ ...c, weekday: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][c.weekday] })), "punchcard");
			case "series-model":
			case "series-provider":
			case "series-route": {
				const items = chart === "series-model" ? o.series.model : chart === "series-provider" ? o.series.provider : o.series.route;
				const useTokens = metric === "tokens";
				const rows: Record<string, unknown>[] = [];
				items.forEach((it) => o.series.buckets.forEach((b, i) => rows.push({ bucket: b, key: it.key, label: it.label, source: sim(it.simulated), requests: it.requests[i], tokens: it.tokens[i], simulatedTokens: it.simulatedTokens[i] })));
				return need(["bucket", "key", "label", "source", useTokens ? "tokens" : "requests", ...(useTokens ? ["simulatedTokens"] : [])], rows, chart);
			}
			case "outcomes":
				return need(["unit", ...OUTCOMES, "total"], (["tasks", "runs", "modelRequests", "toolCalls"] as const).map((u) => ({ unit: u, ...o.outcomes[u] })), "outcomes");
			case "tools":
				return need(["tool", "calls", "errors", "errorRate", "avgDurationMs"], o.tools, "tools");
			case "latency":
				return need(["le", "count", "source"], o.latency.buckets.map((b) => ({ le: b.le ?? "inf", count: b.count, source: o.latency.source })), "latency");
			case "top-users":
				return need(["id", "name", "runs", "failedRuns", "modelRequests", "toolCalls", "tokens", "simulatedTokens", "cost"], o.topUsers, "top-users");
			case "top-projects":
				return need(["id", "name", "runs", "failedRuns", "modelRequests", "toolCalls", "tokens", "simulatedTokens", "cost"], o.topProjects, "top-projects");
			case "conversations":
				return need(["spaceId", "conversationId", "title", "userName", "projectName", "runs", "failedRuns", "modelRequests", "tokens", "simulated", "lastAt"], o.conversations, "conversations");
			case "knowledge":
				return need(["bucket", "searches", "noEvidence"], o.series.buckets.map((b, i) => ({ bucket: b, ...o.knowledge.spark[i] })), "knowledge");
			default:
				throw new HttpError(400, "invalid_chart", "chart 取值：kpis | calendar | punchcard | series-model | series-provider | series-route | outcomes | tools | latency | top-users | top-projects | conversations | knowledge");
		}
	}
}
