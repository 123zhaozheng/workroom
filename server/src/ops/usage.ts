// Usage ledger (M17): a PROJECTION of pi-durable facts, never a second writable source of truth.
// Rows are derived from each conversation's entries (pi.assistant → model_request, pi.tool-result → tool_call,
// wr.input/pi.user → task, segmented runs → run) and reconciled against the authoritative `pi.usage` document
// (differences, e.g. compaction requests that write no entry, become explicit `adjustment` rows). Import is idempotent:
// rows are keyed (space_id, kind, entry_id, sub_key) and upserted; a rebuild deletes a space's rows and re-imports.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, ProviderDoc, UsageDoc, type EntryRecord, type Harness } from "@earendil-works/pi-durable";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import type { AppContext, BudgetGate, Principal, Space } from "../core/contracts.ts";
import { HttpError, newId, nowIso } from "../core/http.ts";
import type { Identity } from "../identity/module.ts";
import { classifyError, FIXTURE_PI_PROVIDER, WORKROOM_PI_PROVIDER } from "./gateway.ts";
import { logEvent, redactText } from "./log.ts";

export type Outcome = "success" | "failed" | "cancelled" | "timeout" | "awaiting_approval" | "in_progress";
type LedgerKind = "task" | "run" | "model_request" | "tool_call" | "adjustment";

interface Row {
	kind: LedgerKind;
	entryId: number;
	subKey?: string;
	conversationId: number;
	taskId?: number;
	userId?: string;
	automationId?: string;
	outcome: Outcome;
	platformModelId?: string;
	piProvider?: string;
	route?: string;
	toolName?: string;
	usage?: Usage;
	fixture: boolean;
	durationMs?: number;
	errorClass?: string;
	errorMessage?: string;
	at: string;
}

export type StatsScope = { kind: "personal" } | { kind: "project"; projectId: string } | { kind: "org" } | { kind: "department"; departmentId: string };

const emptyOutcomes = () => ({ success: 0, failed: 0, cancelled: 0, timeout: 0, awaiting_approval: 0, in_progress: 0, total: 0 });
const isFixtureKey = (provider: string | undefined) => provider === FIXTURE_PI_PROVIDER || provider === "faux-fixture";

export interface RuntimeDocs {
	ApprovalsDoc?: any;
	SpaceDoc?: any;
}

export class UsageService implements BudgetGate {
	readonly #ctx: AppContext;
	readonly #dirty = new Map<string, { spaceId: string; conversationId: number }>();
	#timer?: NodeJS.Timeout;
	docs: RuntimeDocs = {};
	/** Injectable clock for period math in tests. */
	now: () => number = () => Date.now();

	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}
	get db() {
		return this.#ctx.db;
	}
	get #identity(): Identity {
		return this.#ctx.services.get("identity") as Identity;
	}

	markDirty(spaceId: string | undefined, conversationId: number | undefined): void {
		if (!spaceId || conversationId === undefined) return;
		this.#dirty.set(`${spaceId}:${conversationId}`, { spaceId, conversationId });
		this.db.run("INSERT INTO usage_import_state (space_id, conversation_id, dirty) VALUES (?, ?, 1) ON CONFLICT(space_id, conversation_id) DO UPDATE SET dirty = 1", spaceId, conversationId);
	}

	start(intervalMs: number): void {
		// Dirty conversations survive restarts in usage_import_state.dirty.
		for (const r of this.db.all<{ space_id: string; conversation_id: number }>("SELECT space_id, conversation_id FROM usage_import_state WHERE dirty = 1")) this.#dirty.set(`${r.space_id}:${r.conversation_id}`, { spaceId: r.space_id, conversationId: r.conversation_id });
		const tick = () => {
			void this.importDirty()
				.catch((e) => logEvent("error", "usage.import_failed", { error: String(e?.message ?? e) }))
				.finally(() => {
					this.#timer = setTimeout(tick, intervalMs);
					this.#timer.unref?.();
				});
		};
		this.#timer = setTimeout(tick, intervalMs);
		this.#timer.unref?.();
	}
	stop(): void {
		clearTimeout(this.#timer);
	}

	async #harness(spaceId: string): Promise<Harness | null> {
		if (!this.#ctx.services.has("runtime")) return null;
		return this.#ctx.services.get("runtime").harness(spaceId, BACKGROUND_CONTEXT);
	}

	async importDirty(filter?: { orgId?: string }): Promise<number> {
		let n = 0;
		for (const [k, d] of [...this.#dirty]) {
			if (filter?.orgId && this.#identity.space(d.spaceId)?.orgId !== filter.orgId) continue;
			this.#dirty.delete(k);
			try {
				await this.importConversation(d.spaceId, d.conversationId);
				n++;
			} catch (e) {
				this.#dirty.set(k, d);
				logEvent("warn", "usage.import_conversation_failed", { spaceId: d.spaceId, conversationId: d.conversationId, error: String((e as Error).message) });
			}
		}
		return n;
	}

	/** Re-derive all ledger rows of one conversation from pi (idempotent upsert). */
	async importConversation(spaceId: string, conversationId: number, harness?: Harness): Promise<{ rows: number; reconciliation: unknown }> {
		const space = this.#identity.space(spaceId);
		if (!space) throw new HttpError(404, "space_not_found", "空间不存在");
		const h = harness ?? (await this.#harness(spaceId));
		if (!h) throw new HttpError(503, "runtime_unavailable", "运行内核未加载");
		const ctx = BACKGROUND_CONTEXT;
		const conv = await h.conversation(conversationId as any, ctx);
		if (!conv) throw new HttpError(404, "conversation_not_found", "会话不存在");
		const entries: EntryRecord[] = [];
		let cursor: any;
		do {
			const page = await conv.entries({ order: "ascending" }, 500, cursor, ctx);
			entries.push(...page.items);
			cursor = page.next;
		} while (cursor);
		const live = await h.snapshot(LiveDoc, conv.id, ctx);
		const approvals = this.docs.ApprovalsDoc ? await h.snapshot(this.docs.ApprovalsDoc, conv.id, ctx).catch(() => undefined) : undefined;
		const pendingApproval = !!approvals && Object.values((approvals as any).items ?? {}).some((a: any) => a.status === "pending");
		const rows = this.#derive(entries, conversationId, space, { busy: !!live?.run, runFailure: (live?.runFailure as any)?.reason, pendingApproval });
		// Reconcile against authoritative pi.usage (own conversation only; forks start from "initial").
		const piUsage = await h.snapshot(UsageDoc, conv.id, ctx);
		const recon = this.#reconcile(rows, piUsage as any, conversationId);
		rows.push(...recon.adjustments);
		const provider = await h.snapshot(ProviderDoc, conv.id, ctx);
		const projectId = space.projectId ?? null;
		const depts = new Map<string, string>();
		const deptsOf = (userId?: string) => {
			if (!userId) return null;
			if (!depts.has(userId)) depts.set(userId, "," + this.db.all<{ department_id: string }>("SELECT dm.department_id FROM id_department_members dm JOIN id_departments d ON d.id = dm.department_id WHERE dm.user_id = ? AND d.org_id = ? AND dm.removed_at IS NULL", userId, space.orgId).map((r) => r.department_id).join(",") + ",");
			return depts.get(userId)!;
		};
		const importedAt = nowIso();
		this.db.tx(() => {
			const keep = new Set<string>();
			for (const r of rows) {
				const u = r.usage;
				const userId = r.userId ?? space.ownerUserId ?? null;
				const id = `${spaceId}:${r.kind}:${r.entryId}:${r.subKey ?? ""}`;
				keep.add(id);
				this.db.run(
					`INSERT INTO usage_ledger (id, kind, space_id, org_id, project_id, user_id, department_ids, conversation_id, entry_id, sub_key, task_id, outcome, platform_model_id, pi_provider, route, tool_name, input_tokens, output_tokens, cache_read, cache_write, total_tokens, cost, cost_from_provider, fixture, duration_ms, error_class, error_message, automation_id, at, imported_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(id) DO UPDATE SET outcome = excluded.outcome, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, cache_read = excluded.cache_read, cache_write = excluded.cache_write, total_tokens = excluded.total_tokens, cost = excluded.cost, duration_ms = excluded.duration_ms, error_class = excluded.error_class, error_message = excluded.error_message, user_id = excluded.user_id, department_ids = excluded.department_ids, imported_at = excluded.imported_at`,
					id,
					r.kind,
					spaceId,
					space.orgId,
					projectId,
					userId,
					deptsOf(userId ?? undefined),
					conversationId,
					r.entryId,
					r.subKey ?? "",
					r.taskId ?? null,
					r.outcome,
					r.platformModelId ?? null,
					r.piProvider ?? null,
					r.route ?? null,
					r.toolName ?? null,
					u?.input ?? 0,
					u?.output ?? 0,
					u?.cacheRead ?? 0,
					u?.cacheWrite ?? 0,
					u?.totalTokens ?? 0,
					r.fixture ? 0 : (u?.cost.total ?? 0),
					u?.cost.totalFromProvider ? 1 : 0,
					r.fixture ? 1 : 0,
					r.durationMs ?? null,
					r.errorClass ?? null,
					r.errorMessage ? redactText(r.errorMessage).slice(0, 500) : null,
					r.automationId ?? null,
					r.at,
					importedAt,
				);
			}
			// Adjustment rows that no longer apply are removed (projection follows the source).
			for (const old of this.db.all<{ id: string }>("SELECT id FROM usage_ledger WHERE space_id = ? AND conversation_id = ? AND kind = 'adjustment'", spaceId, conversationId)) if (!keep.has(old.id)) this.db.run("DELETE FROM usage_ledger WHERE id = ?", old.id);
			this.db.run(
				"INSERT INTO usage_import_state (space_id, conversation_id, dirty, imported_at, usage_check) VALUES (?, ?, 0, ?, ?) ON CONFLICT(space_id, conversation_id) DO UPDATE SET dirty = 0, imported_at = excluded.imported_at, usage_check = excluded.usage_check",
				spaceId,
				conversationId,
				importedAt,
				JSON.stringify(recon.check),
			);
			if (provider?.sessionId) this.db.run("UPDATE ops_route_attempts SET space_id = COALESCE(space_id, ?), org_id = COALESCE(org_id, ?), conversation_id = COALESCE(conversation_id, ?) WHERE session_id = ?", spaceId, space.orgId, conversationId, provider.sessionId);
		});
		return { rows: rows.length, reconciliation: recon.check };
	}

	#derive(entries: EntryRecord[], conversationId: number, space: Space, live: { busy: boolean; runFailure?: string; pendingApproval: boolean }): Row[] {
		const rows: Row[] = [];
		const own = (e: EntryRecord) => (e.conversationId as unknown as number) === conversationId;
		let lastUser: string | undefined;
		let lastAutomation: string | undefined;
		let pendingInputs: Row[] = [];
		let run: { row: Row; inputs: Row[]; lastStop?: string; lastErrorClass?: string; own: boolean } | null = null;
		const closeRun = (outcome: Outcome) => {
			if (!run) return;
			run.row.outcome = outcome;
			for (const t of run.inputs) t.outcome = outcome;
			if (run.own) rows.push(run.row);
			run = null;
		};
		for (const e of entries) {
			const ts = (m: { timestamp?: number } | undefined) => new Date(m?.timestamp ?? Date.now()).toISOString();
			if (e.kind === "wr.input" || e.kind === "pi.user") {
				const d = (e.data ?? {}) as any;
				if (e.kind === "wr.input") {
					lastUser = d.userId ?? lastUser;
					lastAutomation = d.via?.automationId;
				}
				// An input arriving after a failed (error) attempt with no later retry closes that run as failed.
				if (run && run.lastStop === "error") closeRun(run.lastErrorClass === "timeout" ? "timeout" : "failed");
				const userMsg = e.model?.find((m) => m.role === "user") as { timestamp?: number } | undefined;
				const t: Row = { kind: "task", entryId: e.id as unknown as number, conversationId, userId: lastUser, automationId: lastAutomation, outcome: "in_progress", fixture: false, at: ts(userMsg) };
				if (own(e)) rows.push(t);
				if (run) run.inputs.push(t);
				else pendingInputs.push(t);
				continue;
			}
			if (e.kind === "pi.assistant") {
				const m = e.model?.[0] as AssistantMessage | undefined;
				if (!m) continue;
				const fixture = isFixtureKey(m.provider);
				const isErr = m.stopReason === "error" || m.stopReason === "aborted";
				const cls = isErr ? classifyError(m).cls : undefined;
				const outcome: Outcome = m.stopReason === "aborted" ? "cancelled" : m.stopReason === "error" ? (cls === "timeout" ? "timeout" : "failed") : "success";
				const row: Row = {
					kind: "model_request",
					entryId: e.id as unknown as number,
					conversationId,
					taskId: e.byTaskId as unknown as number | undefined,
					userId: lastUser,
					automationId: lastAutomation,
					outcome,
					platformModelId: m.provider === WORKROOM_PI_PROVIDER || m.provider === FIXTURE_PI_PROVIDER ? m.model : `${m.provider}/${m.model}`,
					piProvider: m.provider,
					route: m.responseModel,
					usage: m.usage,
					fixture,
					durationMs: m.durationMs,
					errorClass: cls,
					errorMessage: m.errorMessage,
					at: ts(m),
				};
				if (own(e)) rows.push(row);
				if (!run) {
					run = { row: { ...row, kind: "run", usage: { ...m.usage, cost: { ...m.usage.cost } }, outcome: "in_progress", errorMessage: undefined }, inputs: pendingInputs, own: own(e) };
					pendingInputs = [];
				} else if (run.row.usage) {
					const u = run.row.usage;
					u.input += m.usage.input;
					u.output += m.usage.output;
					u.cacheRead += m.usage.cacheRead;
					u.cacheWrite += m.usage.cacheWrite;
					u.totalTokens += m.usage.totalTokens;
					u.cost.total += m.usage.cost.total;
				}
				run.row.fixture = run.row.fixture || fixture;
				run.lastStop = m.stopReason;
				run.lastErrorClass = cls;
				if (m.stopReason === "stop" || m.stopReason === "length") closeRun("success");
				else if (m.stopReason === "aborted") closeRun("cancelled");
				continue;
			}
			if (e.kind === "pi.tool-result") {
				const m = e.model?.[0] as ToolResultMessage | undefined;
				if (!m || !own(e)) continue;
				rows.push({ kind: "tool_call", entryId: e.id as unknown as number, conversationId, taskId: e.byTaskId as unknown as number | undefined, userId: lastUser, automationId: lastAutomation, outcome: m.isError ? "failed" : "success", toolName: m.toolName, usage: m.usage, fixture: false, durationMs: m.durationMs, at: new Date(m.timestamp ?? Date.now()).toISOString() });
			}
		}
		// End of transcript.
		if (run) {
			const r = run as NonNullable<typeof run>;
			if (live.busy) closeRun(live.pendingApproval ? "awaiting_approval" : "in_progress");
			else if (live.runFailure === "turn_limit") closeRun("timeout");
			else if (live.runFailure === "aborted") closeRun("cancelled");
			else if (r.lastStop === "error") closeRun(r.lastErrorClass === "timeout" ? "timeout" : "failed");
			else if (live.runFailure) closeRun("failed");
			else closeRun("in_progress");
		}
		for (const t of pendingInputs) t.outcome = live.runFailure === "aborted" ? "cancelled" : "in_progress";
		return rows;
	}

	#reconcile(rows: Row[], pi: { models: Record<string, Usage>; tools: Record<string, Usage> } | undefined, conversationId: number) {
		const adjustments: Row[] = [];
		const sumBy = (kind: LedgerKind, keyOf: (r: Row) => string) => {
			const m = new Map<string, Usage>();
			for (const r of rows.filter((x) => x.kind === kind && x.usage)) {
				const k = keyOf(r);
				const t = m.get(k) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
				t.input += r.usage!.input;
				t.output += r.usage!.output;
				t.cacheRead += r.usage!.cacheRead;
				t.cacheWrite += r.usage!.cacheWrite;
				t.totalTokens += r.usage!.totalTokens;
				t.cost.total += r.usage!.cost.total;
				m.set(k, t);
			}
			return m;
		};
		const modelSums = sumBy("model_request", (r) => `${r.piProvider}/${r.platformModelId?.includes("/") ? r.platformModelId.split("/").slice(1).join("/") : r.platformModelId}`);
		const toolSums = sumBy("tool_call", (r) => r.toolName ?? "");
		const check = { piCost: 0, ledgerCost: 0, piTokens: 0, ledgerTokens: 0, adjustments: 0, match: true };
		const diff = (bucket: "models" | "tools", key: string, piU: Usage, led: Usage | undefined) => {
			check.piCost += piU.cost.total;
			check.piTokens += piU.totalTokens;
			check.ledgerCost += led?.cost.total ?? 0;
			check.ledgerTokens += led?.totalTokens ?? 0;
			const dTokens = piU.totalTokens - (led?.totalTokens ?? 0);
			const dCost = piU.cost.total - (led?.cost.total ?? 0);
			if (dTokens !== 0 || Math.abs(dCost) > 1e-9) {
				check.adjustments++;
				const provider = bucket === "models" ? key.split("/")[0] : undefined;
				adjustments.push({
					kind: "adjustment",
					entryId: conversationId,
					subKey: `${bucket}:${key}`,
					conversationId,
					outcome: "success",
					platformModelId: bucket === "models" ? key.split("/").slice(1).join("/") : undefined,
					piProvider: provider,
					toolName: bucket === "tools" ? key : undefined,
					usage: { input: piU.input - (led?.input ?? 0), output: piU.output - (led?.output ?? 0), cacheRead: piU.cacheRead - (led?.cacheRead ?? 0), cacheWrite: piU.cacheWrite - (led?.cacheWrite ?? 0), totalTokens: dTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: dCost } },
					fixture: isFixtureKey(provider),
					errorMessage: "pi.usage counted spend without a transcript entry (e.g. compaction)",
					at: nowIso(),
				});
			}
		};
		for (const [k, u] of Object.entries(pi?.models ?? {})) diff("models", k, u, modelSums.get(k));
		for (const [k, u] of Object.entries(pi?.tools ?? {})) diff("tools", k, u, toolSums.get(k));
		check.match = check.adjustments === 0;
		return { adjustments, check };
	}

	/** Delete a space's projection and re-import every catalogued conversation (plus any listed ids). */
	async rebuildSpace(spaceId: string, extraConversationIds: number[] = []): Promise<{ conversations: number; rows: number }> {
		const ids = new Set<number>(extraConversationIds);
		try {
			for (const r of this.db.all<{ conversation_id: number }>("SELECT conversation_id FROM rt_conversations WHERE space_id = ?", spaceId)) ids.add(r.conversation_id);
		} catch {
			/* runtime catalog not present */
		}
		for (const r of this.db.all<{ conversation_id: number }>("SELECT conversation_id FROM usage_import_state WHERE space_id = ?", spaceId)) ids.add(r.conversation_id);
		this.db.run("DELETE FROM usage_ledger WHERE space_id = ?", spaceId);
		let rows = 0;
		for (const id of ids) rows += (await this.importConversation(spaceId, id)).rows;
		return { conversations: ids.size, rows };
	}

	/** Space-level check: sum of every conversation's pi.usage (harness.usage) vs the projection. */
	async reconcileSpace(spaceId: string): Promise<{ pi: { tokens: number; cost: number }; ledger: { tokens: number; cost: number }; match: boolean }> {
		const h = await this.#harness(spaceId);
		if (!h) throw new HttpError(503, "runtime_unavailable", "运行内核未加载");
		const u = await h.usage(BACKGROUND_CONTEXT);
		const pi = { tokens: 0, cost: 0 };
		for (const b of [u.models, u.tools]) for (const v of Object.values(b)) (pi.tokens += v.totalTokens), (pi.cost += v.cost.total);
		const l = this.db.get<{ t: number; c: number }>("SELECT COALESCE(SUM(total_tokens),0) AS t, COALESCE(SUM(CASE WHEN fixture = 1 THEN 0 ELSE cost END),0) AS c FROM usage_ledger WHERE space_id = ? AND kind IN ('model_request','tool_call','adjustment')", spaceId)!;
		// Fixture spend is costed 0 in the ledger; pi's fixture cost is 0 as well.
		return { pi, ledger: { tokens: l.t, cost: l.c }, match: pi.tokens === l.t && Math.abs(pi.cost - l.c) < 1e-9 };
	}

	// ------------------------------------------------------------------ scope / queries
	/** SQL filter for a stats scope after permission checks. Throws 403 when not allowed. */
	async scopeFilter(p: Principal, scope: StatsScope): Promise<{ where: string; params: (string | number)[]; attemptsWhere: string; attemptsParams: string[] }> {
		const id = this.#identity;
		switch (scope.kind) {
			case "personal": {
				const ps = id.personalSpace(p.userId, p.orgId);
				return { where: "l.org_id = ? AND l.user_id = ?", params: [p.orgId, p.userId], attemptsWhere: "a.space_id = ?", attemptsParams: [ps.id] };
			}
			case "project": {
				await id.require(p, "admin", { kind: "project", id: scope.projectId }).catch(async (e) => {
					if ((await id.check(p, "admin", { kind: "org", id: p.orgId })).allow && id.db.get("SELECT 1 FROM id_projects WHERE id = ? AND org_id = ?", scope.projectId, p.orgId)) return;
					throw e;
				});
				const sp = id.projectSpace(scope.projectId)!;
				return { where: "l.org_id = ? AND l.project_id = ?", params: [p.orgId, scope.projectId], attemptsWhere: "a.space_id = ?", attemptsParams: [sp.id] };
			}
			case "department": {
				const dep = id.db.get<any>("SELECT * FROM id_departments WHERE id = ? AND org_id = ?", scope.departmentId, p.orgId);
				if (!dep) throw new HttpError(404, "department_not_found", "部门不存在");
				const mgr = id.db.get("SELECT 1 FROM id_department_members WHERE department_id = ? AND user_id = ? AND role = 'manager' AND removed_at IS NULL", scope.departmentId, p.userId);
				if (!mgr) await id.require(p, "admin", { kind: "org", id: p.orgId });
				return { where: "l.org_id = ? AND l.department_ids LIKE ?", params: [p.orgId, `%,${scope.departmentId},%`], attemptsWhere: "a.org_id = ? AND 0", attemptsParams: [p.orgId] };
			}
			case "org":
				await id.require(p, "admin", { kind: "org", id: p.orgId });
				return { where: "l.org_id = ?", params: [p.orgId], attemptsWhere: "a.org_id = ?", attemptsParams: [p.orgId] };
		}
	}

	async summary(p: Principal, scope: StatsScope, range: { from?: string; to?: string }) {
		const f = await this.scopeFilter(p, scope);
		let where = f.where;
		const params = [...f.params];
		let aw = f.attemptsWhere;
		const ap: (string | number)[] = [...f.attemptsParams];
		if (range.from) (where += " AND l.at >= ?"), params.push(range.from), (aw += " AND a.started_at >= ?"), ap.push(range.from);
		if (range.to) (where += " AND l.at < ?"), params.push(range.to), (aw += " AND a.started_at < ?"), ap.push(range.to);
		const counts = (kind: LedgerKind) => {
			const o = emptyOutcomes() as Record<string, number>;
			for (const r of this.db.all<{ outcome: string; n: number }>(`SELECT outcome, COUNT(*) AS n FROM usage_ledger l WHERE ${where} AND l.kind = ? GROUP BY outcome`, ...params, kind)) {
				o[r.outcome] = r.n;
				o.total! += r.n;
			}
			return o as ReturnType<typeof emptyOutcomes>;
		};
		const tok = this.db.get<any>(`SELECT COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o, COALESCE(SUM(cache_read),0) AS cr, COALESCE(SUM(cache_write),0) AS cw, COALESCE(SUM(total_tokens),0) AS t, COALESCE(SUM(cost),0) AS c, COALESCE(SUM(CASE WHEN kind='model_request' AND fixture=1 THEN 1 ELSE 0 END),0) AS fx FROM usage_ledger l WHERE ${where} AND l.kind IN ('model_request','tool_call','adjustment')`, ...params);
		const att = this.db.all<{ status: string; error_class: string | null; failover: number; n: number }>(`SELECT status, error_class, failover, COUNT(*) AS n FROM ops_route_attempts a WHERE ${aw} GROUP BY status, error_class, failover`, ...ap);
		const byErrorClass: Record<string, number> = {};
		let total = 0,
			failovers = 0,
			skipped = 0;
		for (const r of att) {
			total += r.n;
			if (r.failover) failovers += r.n;
			if (r.status === "skipped") skipped += r.n;
			if (r.error_class) byErrorClass[r.error_class] = (byErrorClass[r.error_class] ?? 0) + r.n;
		}
		const byModel = this.db.all<any>(`SELECT platform_model_id AS m, COUNT(*) AS n, COALESCE(SUM(total_tokens),0) AS t, COALESCE(SUM(cost),0) AS c, SUM(CASE WHEN outcome != 'success' THEN 1 ELSE 0 END) AS f FROM usage_ledger l WHERE ${where} AND l.kind = 'model_request' GROUP BY platform_model_id ORDER BY n DESC`, ...params).map((r) => ({ platformModelId: r.m ?? "unknown", requests: r.n, tokens: r.t, cost: r.c, failed: r.f }));
		const byRoute = this.db.all<any>(`SELECT channel_id AS ch, upstream_model AS up, COUNT(*) AS n, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN status IN ('error','aborted') THEN 1 ELSE 0 END) AS f FROM ops_route_attempts a WHERE ${aw} AND channel_id IS NOT NULL GROUP BY channel_id, upstream_model ORDER BY n DESC`, ...ap).map((r) => ({ channelId: r.ch, upstreamModelId: r.up ?? "", attempts: r.n, ok: r.ok, failed: r.f }));
		return {
			scope,
			from: range.from,
			to: range.to,
			tasks: counts("task"),
			runs: counts("run"),
			modelRequests: counts("model_request"),
			toolCalls: counts("tool_call"),
			tokens: { input: tok.i, output: tok.o, cacheRead: tok.cr, cacheWrite: tok.cw, total: tok.t },
			cost: tok.c,
			fixtureRequests: tok.fx,
			routeAttempts: { total, failovers, skipped, byErrorClass },
			byModel,
			byRoute,
			_where: { where, params },
		};
	}

	async stats(p: Principal, scope: StatsScope, range: { from?: string; to?: string; largeContextTokens?: number }) {
		const s = await this.summary(p, scope, range);
		const { where, params } = s._where;
		const durations = this.db.all<{ d: number }>(`SELECT duration_ms AS d FROM usage_ledger l WHERE ${where} AND l.kind = 'model_request' AND duration_ms IS NOT NULL ORDER BY duration_ms`, ...params).map((r) => r.d);
		const q = (x: number) => (durations.length ? durations[Math.min(durations.length - 1, Math.floor(x * durations.length))] : undefined);
		const bounds = [250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000, null];
		const buckets = bounds.map((le, i) => ({ le, count: durations.filter((d) => (le === null ? d > bounds[i - 1]! : d <= le && (i === 0 || d > bounds[i - 1]!))).length }));
		const threshold = range.largeContextTokens ?? 32_000;
		const large = this.db.all<{ outcome: string; error_class: string | null }>(`SELECT outcome, error_class FROM usage_ledger l WHERE ${where} AND l.kind = 'model_request' AND (input_tokens + cache_read + cache_write) >= ?`, ...params, threshold);
		const largeFailed = large.filter((r) => r.outcome !== "success");
		const largeBy: Record<string, number> = {};
		for (const r of largeFailed) largeBy[r.error_class ?? "unknown"] = (largeBy[r.error_class ?? "unknown"] ?? 0) + 1;
		const errorClasses: Record<string, number> = {};
		for (const r of this.db.all<{ c: string; n: number }>(`SELECT error_class AS c, COUNT(*) AS n FROM usage_ledger l WHERE ${where} AND l.kind = 'model_request' AND error_class IS NOT NULL GROUP BY error_class`, ...params)) errorClasses[r.c] = r.n;
		const daily = this.db.all<any>(`SELECT substr(at,1,10) AS day, SUM(kind='task') AS tasks, SUM(kind='model_request') AS mr, SUM(CASE WHEN kind IN ('model_request','tool_call','adjustment') THEN total_tokens ELSE 0 END) AS tok, SUM(CASE WHEN kind IN ('model_request','tool_call','adjustment') THEN cost ELSE 0 END) AS cost FROM usage_ledger l WHERE ${where} GROUP BY day ORDER BY day`, ...params).map((r) => ({ day: r.day, tasks: r.tasks, modelRequests: r.mr, tokens: r.tok, cost: r.cost }));
		// Saved hours: only user-confirmed records, or an explicitly labelled estimate when an admin configured the basis.
		let sw = "org_id = ?";
		const sparams: string[] = [p.orgId];
		if (scope.kind === "personal") (sw += " AND user_id = ?"), sparams.push(p.userId);
		else if (scope.kind === "project") (sw += " AND project_id = ?"), sparams.push(scope.projectId);
		else if (scope.kind === "department") (sw += " AND user_id IN (SELECT user_id FROM id_department_members WHERE department_id = ? AND removed_at IS NULL)"), sparams.push(scope.departmentId);
		if (range.from) (sw += " AND created_at >= ?"), sparams.push(range.from);
		if (range.to) (sw += " AND created_at < ?"), sparams.push(range.to);
		const confirmed = this.db.get<{ m: number | null; n: number }>(`SELECT SUM(minutes) AS m, COUNT(*) AS n FROM usage_time_savings WHERE ${sw}`, ...sparams);
		const minutesPer = this.db.get<{ value: string }>("SELECT value FROM ops_settings WHERE org_id = ? AND key = 'saved_minutes_per_successful_task'", p.orgId);
		const estimate = minutesPer ? { value: Math.round(((s.tasks.success * Number(minutesPer.value)) / 60) * 100) / 100, basis: `管理员设定：每个成功任务按 ${Number(minutesPer.value)} 分钟估算（非实测）`, label: "estimate" as const } : null;
		const { _where, ...pub } = s;
		return {
			...pub,
			latency: { count: durations.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: durations[durations.length - 1], buckets },
			largeContext: { thresholdTokens: threshold, requests: large.length, failed: largeFailed.length, failureRate: large.length ? largeFailed.length / large.length : null, byErrorClass: largeBy },
			errorClasses,
			savedHours: { confirmed: confirmed?.n ? Math.round(((confirmed.m ?? 0) / 60) * 100) / 100 : null, estimate },
			daily,
		};
	}

	async ledger(p: Principal, scope: StatsScope, q: { from?: string; to?: string; kind?: string; limit?: number }) {
		const f = await this.scopeFilter(p, scope);
		let where = f.where;
		const params = [...f.params];
		if (q.from) (where += " AND l.at >= ?"), params.push(q.from);
		if (q.to) (where += " AND l.at < ?"), params.push(q.to);
		if (q.kind) (where += " AND l.kind = ?"), params.push(q.kind);
		const limit = Math.min(Math.max(q.limit ?? 500, 1), 10_000);
		return this.db.all<any>(`SELECT * FROM usage_ledger l WHERE ${where} ORDER BY l.at DESC, l.entry_id DESC LIMIT ${limit}`, ...params).map(ledgerDto);
	}

	// ------------------------------------------------------------------ budgets
	periodStart(period: string): string | null {
		const d = new Date(this.now());
		if (period === "day") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
		if (period === "month") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
		return null;
	}

	budgetSpent(b: any): { cost: number; tokens: number; periodStart?: string } {
		const start = this.periodStart(b.period);
		let where = "org_id = ? AND fixture = 0 AND kind IN ('model_request','tool_call','adjustment')";
		const params: (string | number)[] = [b.org_id];
		if (b.scope_kind === "user") (where += " AND user_id = ?"), params.push(b.scope_id);
		else if (b.scope_kind === "project") (where += " AND project_id = ?"), params.push(b.scope_id);
		else if (b.scope_kind === "department") (where += " AND department_ids LIKE ?"), params.push(`%,${b.scope_id},%`);
		if (start) (where += " AND at >= ?"), params.push(start);
		const r = this.db.get<{ c: number; t: number }>(`SELECT COALESCE(SUM(cost),0) AS c, COALESCE(SUM(total_tokens),0) AS t FROM usage_ledger WHERE ${where}`, ...params)!;
		return { cost: r.c, tokens: r.t, periodStart: start ?? undefined };
	}

	budgetState(b: any): { spent: { cost: number; tokens: number; periodStart?: string }; state: "ok" | "warn" | "exceeded" } {
		const spent = this.budgetSpent(b);
		const over = (b.limit_cost != null && spent.cost >= b.limit_cost) || (b.limit_tokens != null && spent.tokens >= b.limit_tokens);
		const near = (b.limit_cost != null && spent.cost >= 0.8 * b.limit_cost) || (b.limit_tokens != null && spent.tokens >= 0.8 * b.limit_tokens);
		return { spent, state: over ? "exceeded" : near ? "warn" : "ok" };
	}

	/** BudgetGate: evaluated at submit time (runtime) and at automation fire time. Imports pending usage first. */
	async checkSubmit(principal: Principal, spaceId: string, projectId?: string): Promise<{ allow: true } | { allow: false; reason: string }> {
		await this.importDirty({ orgId: principal.orgId });
		const space = this.#identity.space(spaceId);
		const proj = projectId ?? space?.projectId;
		const budgets = this.db.all<any>("SELECT * FROM usage_budgets WHERE org_id = ? AND enabled = 1 AND action = 'block'", principal.orgId);
		for (const b of budgets) {
			const applies = b.scope_kind === "org" || (b.scope_kind === "user" && b.scope_id === principal.userId) || (b.scope_kind === "project" && b.scope_id === proj) || (b.scope_kind === "department" && principal.departmentIds.includes(b.scope_id));
			if (!applies) continue;
			const st = this.budgetState(b);
			if (st.state === "exceeded") {
				const what = b.limit_cost != null && st.spent.cost >= b.limit_cost ? `费用 ${st.spent.cost.toFixed(4)} / ${b.limit_cost} USD` : `Token ${st.spent.tokens} / ${b.limit_tokens}`;
				return { allow: false, reason: `${b.scope_kind}:${b.scope_id} ${b.period} 预算已用尽（${what}）` };
			}
		}
		return { allow: true };
	}
}

export function ledgerDto(r: any) {
	return {
		id: r.id,
		kind: r.kind,
		at: r.at,
		orgId: r.org_id,
		spaceId: r.space_id,
		projectId: r.project_id ?? undefined,
		userId: r.user_id ?? undefined,
		conversationId: r.conversation_id,
		entryId: r.entry_id,
		taskId: r.task_id ?? undefined,
		outcome: r.outcome,
		platformModelId: r.platform_model_id ?? undefined,
		provider: r.pi_provider ?? undefined,
		route: r.route ?? undefined,
		toolName: r.tool_name ?? undefined,
		tokens: { input: r.input_tokens, output: r.output_tokens, cacheRead: r.cache_read, cacheWrite: r.cache_write, total: r.total_tokens },
		cost: r.cost,
		fixture: !!r.fixture,
		durationMs: r.duration_ms ?? undefined,
		errorClass: r.error_class ?? undefined,
		automationId: r.automation_id ?? undefined,
	};
}

export const newBudgetId = () => newId("bud");
