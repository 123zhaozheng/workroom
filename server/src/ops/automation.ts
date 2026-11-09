// Automations (M12): one-off / cron (IANA timezone, croner) / manual / webhook triggers, previewable next runs,
// trigger conditions, output destinations, and an authorized scope = the owner principal RE-RESOLVED at fire time.
// Anti-reentrancy: claiming a run inserts a row unique on (automation_id, scheduled_for) in the same transaction that
// advances next_run_at; the pi submission uses requestId `auto:<id>:<scheduledFor>` so a restart that re-submits a
// claimed run is deduplicated by pi. Missed runs after downtime are coalesced into one occurrence and then skipped
// (missedPolicy "skip") or run once (missedPolicy "run_once").
import { Cron } from "croner";
import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { AppContext, Principal } from "../core/contracts.ts";
import { HttpError, newId, nowIso } from "../core/http.ts";
import { audit, type Identity } from "../identity/module.ts";
import { sha256Hex } from "../identity/secrets.ts";
import { logEvent, redactText } from "./log.ts";
import type { NotifyService, NotificationRef } from "./notify.ts";
import type { UsageService } from "./usage.ts";

export type Trigger = { kind: "once"; at: string } | { kind: "cron"; expr: string } | { kind: "manual" } | { kind: "webhook" };
export type RunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timeout" | "skipped" | "refused";
export type Condition = { kind: "always" } | { kind: "previous_status"; statuses: RunStatus[] };
export interface Destination {
	conversation: "new" | "reuse";
	inApp: boolean;
	channelIds: string[];
}

const TERMINAL: RunStatus[] = ["succeeded", "failed", "cancelled", "timeout", "skipped", "refused"];

export function validTimezone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

export function localTime(iso: string, tz: string): string {
	return new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZoneName: "short" }).format(new Date(iso));
}

/** Scheduled time of a run (manual/webhook runs use their creation time). */
export const runWhen = (run: { scheduled_for: string; created_at: string }): string => (/^\d{4}-/.test(run.scheduled_for) ? run.scheduled_for : run.created_at);

/** Next `count` fire times strictly after `from`. */
export function nextRuns(trigger: Trigger, timezone: string, from: Date, count: number): string[] {
	if (!validTimezone(timezone)) throw new HttpError(400, "invalid_timezone", `无效时区：${timezone}`);
	if (trigger.kind === "once") {
		const t = Date.parse(trigger.at);
		if (!Number.isFinite(t)) throw new HttpError(400, "invalid_trigger", "一次性任务时间无效");
		return t > from.getTime() ? [new Date(t).toISOString()] : [];
	}
	if (trigger.kind === "cron") {
		let cron: Cron;
		try {
			cron = new Cron(trigger.expr, { timezone, paused: true });
		} catch (e) {
			throw new HttpError(400, "invalid_cron", `cron 表达式无效：${(e as Error).message}`);
		}
		const out = cron.nextRuns(count, from).map((d) => d.toISOString());
		cron.stop();
		return out;
	}
	return [];
}

interface AutomationRow {
	id: string;
	org_id: string;
	owner_user_id: string;
	space_id: string;
	project_id: string | null;
	name: string;
	prompt: string;
	assistant_id: string | null;
	model_id: string | null;
	trigger: string;
	timezone: string;
	condition: string;
	destination: string;
	max_concurrent: number;
	missed_policy: "skip" | "run_once";
	max_duration_ms: number;
	enabled: number;
	webhook_token_hash: string | null;
	reuse_conversation_id: number | null;
	next_run_at: string | null;
	created_at: string;
	updated_at: string;
	deleted_at: string | null;
}

export class AutomationService {
	readonly #ctx: AppContext;
	readonly #notify: NotifyService;
	readonly #usage: UsageService;
	readonly #watching = new Map<string, Promise<void>>();
	#timer?: NodeJS.Timeout;
	#ticking: Promise<void> | null = null;
	#stopped = false;
	now: () => number = () => Date.now();
	/** A scheduled occurrence older than this (relative to now) counts as missed (server was down). */
	graceMs = 5 * 60_000;

	constructor(ctx: AppContext, notify: NotifyService, usage: UsageService) {
		this.#ctx = ctx;
		this.#notify = notify;
		this.#usage = usage;
	}
	get db() {
		return this.#ctx.db;
	}
	get #identity(): Identity {
		return this.#ctx.services.get("identity") as Identity;
	}

	// ------------------------------------------------------------------ lifecycle
	/**
	 * Recovery runs on the first tick, never inside module start(): the runtime installs every module's pi extensions in
	 * its own start() (it loads last) and no harness may open before that.
	 */
	async start(tickMs: number): Promise<void> {
		this.#stopped = false;
		if (tickMs > 0) {
			const loop = () => {
				if (this.#stopped) return;
				void this.tick().finally(() => {
					if (this.#stopped) return;
					this.#timer = setTimeout(loop, tickMs);
					this.#timer.unref?.();
				});
			};
			this.#timer = setTimeout(loop, Math.min(tickMs, 1000));
			this.#timer.unref?.();
		}
	}
	async stop(): Promise<void> {
		this.#stopped = true;
		clearTimeout(this.#timer);
		await this.#ticking;
	}

	/** After a restart: re-submit claimed-but-unsubmitted runs (pi dedupes by requestId) and re-attach watchers. */
	#recovered = false;
	async recover(): Promise<void> {
		this.#recovered = true;
		for (const r of this.db.all<any>("SELECT * FROM auto_runs WHERE status IN ('pending','running') ORDER BY created_at")) {
			const a = this.get(r.automation_id);
			if (!a) continue;
			if (r.status === "pending") this.#spawn(r.id, () => this.#execute(a, r.id));
			else if (r.submission_id != null) this.#spawn(r.id, () => this.#watch(a, r.id));
		}
	}

	#spawn(runId: string, fn: () => Promise<void>): void {
		if (this.#watching.has(runId)) return;
		const p = fn()
			.catch((e) => {
				this.#finish(runId, "failed", { error: String((e as Error)?.message ?? e) });
			})
			.finally(() => this.#watching.delete(runId));
		this.#watching.set(runId, p);
	}

	/** Wait until all in-flight run executions/watchers settle (tests). */
	async idle(): Promise<void> {
		while (this.#watching.size) await Promise.allSettled([...this.#watching.values()]);
		await this.#notify.idle();
	}

	// ------------------------------------------------------------------ CRUD helpers
	get(id: string): AutomationRow | null {
		return this.db.get<AutomationRow>("SELECT * FROM auto_automations WHERE id = ? AND deleted_at IS NULL", id) ?? null;
	}

	computeNext(trigger: Trigger, tz: string, from: number): string | null {
		return nextRuns(trigger, tz, new Date(from), 1)[0] ?? null;
	}

	create(p: Principal, input: { name: string; prompt: string; spaceId: string; trigger: Trigger; timezone: string; condition?: Condition; destination?: Partial<Destination>; maxConcurrent?: number; missedPolicy?: "skip" | "run_once"; maxDurationMs?: number; assistantId?: string; modelId?: string; enabled?: boolean }): { row: AutomationRow; webhookToken?: string } {
		const space = this.#identity.space(input.spaceId);
		if (!space) throw new HttpError(404, "space_not_found", "空间不存在");
		const id = newId("auto");
		const token = input.trigger.kind === "webhook" ? randomBytes(24).toString("base64url") : undefined;
		const next = input.enabled === false ? null : this.computeNext(input.trigger, input.timezone, this.now());
		const dest: Destination = { conversation: input.destination?.conversation ?? "new", inApp: input.destination?.inApp ?? true, channelIds: input.destination?.channelIds ?? [] };
		this.#checkChannels(p, dest.channelIds);
		this.db.run(
			`INSERT INTO auto_automations (id, org_id, owner_user_id, space_id, project_id, name, prompt, assistant_id, model_id, trigger, timezone, condition, destination, max_concurrent, missed_policy, max_duration_ms, enabled, webhook_token_hash, next_run_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			p.orgId,
			p.userId,
			space.id,
			space.projectId ?? null,
			input.name.trim(),
			input.prompt,
			input.assistantId ?? null,
			input.modelId ?? null,
			JSON.stringify(input.trigger),
			input.timezone,
			JSON.stringify(input.condition ?? { kind: "always" }),
			JSON.stringify(dest),
			Math.max(1, Math.min(input.maxConcurrent ?? 1, 10)),
			input.missedPolicy ?? "skip",
			Math.max(10_000, Math.min(input.maxDurationMs ?? 30 * 60_000, 24 * 3600_000)),
			input.enabled === false ? 0 : 1,
			token ? sha256Hex(token) : null,
			next,
			nowIso(),
			nowIso(),
		);
		return { row: this.get(id)!, webhookToken: token };
	}

	#checkChannels(p: Principal, ids: readonly string[]): void {
		for (const c of ids) if (!this.db.get("SELECT 1 FROM ops_notify_channels WHERE id = ? AND org_id = ? AND deleted_at IS NULL AND (owner_user_id = ? OR shared = 1)", c, p.orgId, p.userId)) throw new HttpError(404, "channel_not_found", `通知渠道不存在或无权使用：${c}`);
	}

	update(p: Principal, a: AutomationRow, patch: Partial<{ name: string; prompt: string; trigger: Trigger; timezone: string; condition: Condition; destination: Partial<Destination>; maxConcurrent: number; missedPolicy: "skip" | "run_once"; maxDurationMs: number; enabled: boolean; modelId: string | null; assistantId: string | null }>): AutomationRow {
		const trigger: Trigger = patch.trigger ?? JSON.parse(a.trigger);
		const tz = patch.timezone ?? a.timezone;
		const enabled = patch.enabled ?? !!a.enabled;
		const dest: Destination = { ...JSON.parse(a.destination), ...(patch.destination ?? {}) };
		if (patch.destination?.channelIds) this.#checkChannels(p, dest.channelIds);
		const next = enabled ? this.computeNext(trigger, tz, this.now()) : null;
		this.db.run(
			`UPDATE auto_automations SET name = ?, prompt = ?, trigger = ?, timezone = ?, condition = ?, destination = ?, max_concurrent = ?, missed_policy = ?, max_duration_ms = ?, enabled = ?, model_id = ?, assistant_id = ?, next_run_at = ?, updated_at = ?, webhook_token_hash = CASE WHEN ? THEN webhook_token_hash ELSE NULL END WHERE id = ?`,
			patch.name?.trim() || a.name,
			patch.prompt ?? a.prompt,
			JSON.stringify(trigger),
			tz,
			JSON.stringify(patch.condition ?? JSON.parse(a.condition)),
			JSON.stringify(dest),
			Math.max(1, Math.min(patch.maxConcurrent ?? a.max_concurrent, 10)),
			patch.missedPolicy ?? a.missed_policy,
			patch.maxDurationMs ?? a.max_duration_ms,
			enabled ? 1 : 0,
			patch.modelId === undefined ? a.model_id : patch.modelId,
			patch.assistantId === undefined ? a.assistant_id : patch.assistantId,
			next,
			nowIso(),
			trigger.kind === "webhook" ? 1 : 0,
			a.id,
		);
		return this.get(a.id)!;
	}

	rotateWebhookToken(a: AutomationRow): string {
		const token = randomBytes(24).toString("base64url");
		this.db.run("UPDATE auto_automations SET webhook_token_hash = ?, updated_at = ? WHERE id = ?", sha256Hex(token), nowIso(), a.id);
		return token;
	}

	byWebhookToken(token: string): AutomationRow | null {
		return this.db.get<AutomationRow>("SELECT * FROM auto_automations WHERE webhook_token_hash = ? AND deleted_at IS NULL", sha256Hex(token)) ?? null;
	}

	// ------------------------------------------------------------------ scheduling
	tick(now = this.now()): Promise<void> {
		if (this.#ticking) return this.#ticking;
		this.#ticking = (async () => {
			try {
				if (!this.#recovered) await this.recover();
				const due = this.db.all<AutomationRow>("SELECT * FROM auto_automations WHERE enabled = 1 AND deleted_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at", new Date(now).toISOString());
				for (const a of due) this.#fireDue(a, now);
			} finally {
				this.#ticking = null;
			}
		})();
		return this.#ticking;
	}

	#fireDue(a: AutomationRow, now: number): void {
		const trigger = JSON.parse(a.trigger) as Trigger;
		// Coalesce every occurrence that became due (e.g. while the server was down) into the latest one.
		let latest = a.next_run_at!;
		let missed = 0;
		if (trigger.kind === "cron") {
			for (let i = 0; i < 10_000; i++) {
				const n = nextRuns(trigger, a.timezone, new Date(latest), 1)[0];
				if (!n || Date.parse(n) > now) break;
				latest = n;
				missed++;
			}
		}
		const late = now - Date.parse(latest) > this.graceMs;
		const next = trigger.kind === "cron" ? this.computeNext(trigger, a.timezone, Math.max(now, Date.parse(latest))) : null;
		const catchup = missed > 0 || late;
		const claim = this.db.tx(() => {
			const runId = newId("run");
			const skipMissed = catchup && a.missed_policy === "skip";
			const r = this.db.run(
				"INSERT INTO auto_runs (id, automation_id, org_id, scheduled_for, trigger, status, reason, request_id, space_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(automation_id, scheduled_for) DO NOTHING",
				runId,
				a.id,
				a.org_id,
				latest,
				catchup ? "catchup" : "schedule",
				skipMissed ? "skipped" : "pending",
				skipMissed ? `missed: ${missed + 1} occurrence(s) while the scheduler was not running (policy skip)` : catchup ? `catch-up of ${missed + 1} missed occurrence(s) (policy run_once)` : null,
				`auto:${a.id}:${latest}`,
				a.space_id,
				nowIso(),
			);
			this.db.run("UPDATE auto_automations SET next_run_at = ?, enabled = CASE WHEN ? THEN 0 ELSE enabled END, updated_at = ? WHERE id = ? AND next_run_at = ?", next, trigger.kind === "once" ? 1 : 0, nowIso(), a.id, a.next_run_at);
			if (r.changes === 0) return null; // already claimed: a previous process fired this occurrence
			if (skipMissed) this.db.run("UPDATE auto_runs SET ended_at = ? WHERE id = ?", nowIso(), runId);
			return skipMissed ? null : runId;
		});
		if (claim) this.#spawn(claim, () => this.#execute(a, claim));
	}

	/** Manual run / re-run / webhook trigger. `dedupeKey` makes repeated webhook deliveries idempotent. */
	runNow(a: AutomationRow, trigger: "manual" | "webhook" | "rerun", opts: { dedupeKey?: string; rerunOf?: string } = {}): { runId: string; duplicate: boolean } {
		const scheduledFor = `${trigger}:${opts.dedupeKey ?? `${nowIso()}:${randomBytes(4).toString("hex")}`}`;
		const runId = newId("run");
		const r = this.db.run(
			"INSERT INTO auto_runs (id, automation_id, org_id, scheduled_for, trigger, status, request_id, space_id, rerun_of, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?) ON CONFLICT(automation_id, scheduled_for) DO NOTHING",
			runId,
			a.id,
			a.org_id,
			scheduledFor,
			trigger,
			`auto:${a.id}:${scheduledFor}`,
			a.space_id,
			opts.rerunOf ?? null,
			nowIso(),
		);
		if (r.changes === 0) return { runId: this.db.get<{ id: string }>("SELECT id FROM auto_runs WHERE automation_id = ? AND scheduled_for = ?", a.id, scheduledFor)!.id, duplicate: true };
		this.#spawn(runId, () => this.#execute(a, runId));
		return { runId, duplicate: false };
	}

	#finish(runId: string, status: RunStatus, extra: { reason?: string; error?: string } = {}): boolean {
		const r = this.db.run("UPDATE auto_runs SET status = ?, reason = COALESCE(?, reason), error = ?, ended_at = ? WHERE id = ? AND status NOT IN ('succeeded','failed','cancelled','timeout','skipped','refused')", status, extra.reason ?? null, extra.error ? redactText(extra.error).slice(0, 1000) : null, nowIso(), runId);
		return r.changes === 1;
	}

	async #execute(a0: AutomationRow, runId: string): Promise<void> {
		const run = this.db.get<any>("SELECT * FROM auto_runs WHERE id = ?", runId);
		const a = this.get(a0.id) ?? a0;
		const log = { automationId: a.id, runId, requestId: run.request_id, spaceId: a.space_id };
		// 1. authorized scope: re-resolve the owner NOW (disabled / removed owner ⇒ refused).
		const owner = await this.#identity.principalFor(a.owner_user_id, a.org_id);
		if (!owner) {
			this.#finish(runId, "refused", { reason: "owner_inactive: 负责人已停用或已移出组织" });
			audit(this.db, a.org_id, null, "automation.run_refused", a.id, { runId, reason: "owner_inactive" });
			logEvent("warn", "automation.refused", { ...log, reason: "owner_inactive" });
			return this.#notifyRun(a, runId);
		}
		const principal: Principal = { ...owner, via: { kind: "automation", automationId: a.id } };
		const acl = await this.#identity.check(principal, "write", { kind: "space", id: a.space_id });
		if (!acl.allow) {
			this.#finish(runId, "refused", { reason: `no_access: ${acl.reason}` });
			audit(this.db, a.org_id, a.owner_user_id, "automation.run_refused", a.id, { runId, reason: acl.reason });
			return this.#notifyRun(a, runId);
		}
		// 2. trigger condition
		const cond = JSON.parse(a.condition) as Condition;
		if (cond.kind === "previous_status") {
			const prev = this.db.get<{ status: string }>("SELECT status FROM auto_runs WHERE automation_id = ? AND id != ? AND status IN ('succeeded','failed','cancelled','timeout') ORDER BY created_at DESC LIMIT 1", a.id, runId);
			if (prev && !cond.statuses.includes(prev.status as RunStatus)) {
				this.#finish(runId, "skipped", { reason: `condition: previous run ${prev.status} not in [${cond.statuses.join(",")}]` });
				return;
			}
		}
		// 3. concurrency (skip policy)
		const running = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM auto_runs WHERE automation_id = ? AND status = 'running' AND id != ?", a.id, runId)!.n;
		if (running >= a.max_concurrent) {
			this.#finish(runId, "skipped", { reason: `concurrency: ${running} run(s) still running (max ${a.max_concurrent})` });
			logEvent("info", "automation.skipped_concurrency", log);
			return;
		}
		// 4. budget
		const budget = await this.#usage.checkSubmit(principal, a.space_id, a.project_id ?? undefined);
		if (!budget.allow) {
			this.#finish(runId, "refused", { reason: `budget: ${budget.reason}` });
			return this.#notifyRun(a, runId);
		}
		if (!this.#ctx.services.has("runtime")) {
			this.#finish(runId, "failed", { error: "runtime_unavailable: 运行内核未加载" });
			return this.#notifyRun(a, runId);
		}
		const rt = this.#ctx.services.get("runtime");
		// Claim the running slot atomically (a concurrent run may have started in between).
		const claimed = this.db.tx(() => {
			const n = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM auto_runs WHERE automation_id = ? AND status = 'running'", a.id)!.n;
			if (n >= a.max_concurrent) return false;
			return this.db.run("UPDATE auto_runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'", nowIso(), runId).changes === 1;
		});
		if (!claimed) {
			this.#finish(runId, "skipped", { reason: "concurrency: limit reached" });
			return;
		}
		const dest = JSON.parse(a.destination) as Destination;
		let conversationId = run.conversation_id as number | null;
		if (conversationId == null) {
			if (dest.conversation === "reuse" && a.reuse_conversation_id != null) conversationId = a.reuse_conversation_id;
			else {
				let model: any;
				if (a.model_id && this.#ctx.services.has("models")) model = (await this.#ctx.services.get("models").listFor(principal)).find((m) => m.id === a.model_id)?.ref;
				const created = await rt.createConversation(principal, a.space_id, { title: `${a.name} · ${localTime(runWhen(run), a.timezone)}`, kind: "automation", ...(a.project_id ? { projectId: a.project_id } : {}), ...(model ? { model } : {}), ...(a.assistant_id ? { assistantId: a.assistant_id } : {}) } as any, BACKGROUND_CONTEXT);
				conversationId = created.conversationId;
				if (dest.conversation === "reuse") this.db.run("UPDATE auto_automations SET reuse_conversation_id = ? WHERE id = ?", conversationId, a.id);
			}
			this.db.run("UPDATE auto_runs SET conversation_id = ? WHERE id = ?", conversationId, runId);
		}
		const sub = await rt.submitInput(principal, a.space_id, conversationId!, { text: a.prompt, userId: owner.userId, orgId: owner.orgId, via: { kind: "automation", automationId: a.id, runId }, requestId: run.request_id, whenBusy: "followUp" }, BACKGROUND_CONTEXT);
		this.db.run("UPDATE auto_runs SET submission_id = ? WHERE id = ?", sub.submissionId, runId);
		logEvent("info", "automation.submitted", { ...log, conversationId: conversationId!, submissionId: sub.submissionId });
		await this.#watch(a, runId);
	}

	async #watch(a: AutomationRow, runId: string): Promise<void> {
		const run = this.db.get<any>("SELECT * FROM auto_runs WHERE id = ?", runId);
		const rt = this.#ctx.services.get("runtime");
		const harness = await rt.harness(a.space_id, BACKGROUND_CONTEXT);
		const sub = await harness.submission(run.submission_id, BACKGROUND_CONTEXT);
		if (!sub) {
			this.#finish(runId, "failed", { error: "submission not found in pi storage" });
			return this.#notifyRun(a, runId);
		}
		const startedAt = Date.parse(run.started_at ?? run.created_at);
		const remaining = Math.max(1, startedAt + a.max_duration_ms - Date.now());
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(new Error("automation timeout")), remaining);
		timer.unref?.();
		let settled: any;
		try {
			settled = await sub.wait(withAbortSignal(ac.signal, BACKGROUND_CONTEXT));
		} catch (e) {
			if (!ac.signal.aborted) throw e;
			// Timed out: stop the work in pi, record timeout.
			const conv = await harness.conversation(run.conversation_id, BACKGROUND_CONTEXT);
			await conv?.abort(BACKGROUND_CONTEXT).catch(() => undefined);
			this.#finish(runId, "timeout", { reason: `exceeded max duration ${a.max_duration_ms} ms` });
			this.#usage.markDirty(a.space_id, run.conversation_id);
			return this.#notifyRun(a, runId);
		} finally {
			clearTimeout(timer);
		}
		const cur = this.db.get<any>("SELECT status FROM auto_runs WHERE id = ?", runId);
		if (cur.status === "cancelled") return this.#notifyRun(a, runId);
		if (settled.status === "done") this.#finish(runId, "succeeded");
		else if (settled.reason === "aborted") this.#finish(runId, "cancelled", { reason: "aborted" });
		else if (settled.reason === "turn_limit") this.#finish(runId, "timeout", { reason: "turn_limit" });
		else this.#finish(runId, "failed", { reason: settled.reason, error: typeof settled.detail === "string" ? settled.detail : settled.detail ? JSON.stringify(settled.detail) : settled.reason });
		this.#usage.markDirty(a.space_id, run.conversation_id);
		logEvent("info", "automation.finished", { automationId: a.id, runId, conversationId: run.conversation_id, status: settled.status, reason: settled.reason });
		return this.#notifyRun(a, runId);
	}

	async cancel(p: Principal, runId: string): Promise<void> {
		const run = this.db.get<any>("SELECT * FROM auto_runs WHERE id = ? AND org_id = ?", runId, p.orgId);
		if (!run) throw new HttpError(404, "not_found", "运行记录不存在");
		if (TERMINAL.includes(run.status)) throw new HttpError(409, "already_finished", "运行已结束");
		this.#finish(runId, "cancelled", { reason: `cancelled by ${p.userId}` });
		if (run.submission_id != null && this.#ctx.services.has("runtime")) {
			const harness = await this.#ctx.services.get("runtime").harness(run.space_id, BACKGROUND_CONTEXT);
			const r = await harness.abortSubmission(run.submission_id, BACKGROUND_CONTEXT, run.conversation_id);
			if (r === "already_placed") await (await harness.conversation(run.conversation_id, BACKGROUND_CONTEXT))?.abort(BACKGROUND_CONTEXT);
		}
		audit(this.db, p.orgId, p.userId, "automation.run_cancel", run.automation_id, { runId });
	}

	async #notifyRun(a: AutomationRow, runId: string): Promise<void> {
		const run = this.db.get<any>("SELECT * FROM auto_runs WHERE id = ?", runId);
		const dest = JSON.parse(a.destination) as Destination;
		const link = run.conversation_id != null ? `/c/${a.space_id}/${run.conversation_id}` : `/automations/${a.id}`;
		const refs: NotificationRef[] = [{ kind: "run", id: runId, label: run.status }];
		if (run.conversation_id != null) refs.push({ kind: "conversation", id: String(run.conversation_id), spaceId: a.space_id, label: a.name });
		try {
			for (const f of this.db.all<any>("SELECT file_id, id, name, version_no FROM file_versions WHERE space_id = ? AND conversation_id = ? AND created_at >= ? ORDER BY created_at", a.space_id, run.conversation_id ?? -1, run.started_at ?? run.created_at)) refs.push({ kind: "file", id: f.file_id, label: `${f.name} v${f.version_no}`, spaceId: a.space_id });
		} catch {
			/* files module not present */
		}
		const statusText: Record<string, string> = { succeeded: "已完成", failed: "失败", cancelled: "已取消", timeout: "超时", refused: "被拒绝执行", skipped: "已跳过" };
		const title = `自动化「${a.name}」${statusText[run.status] ?? run.status}`;
		const body = [run.reason, run.error].filter(Boolean).join(" · ") || `计划时间 ${localTime(runWhen(run), a.timezone)}`;
		const owner = this.db.get<{ id: string }>("SELECT id FROM id_users WHERE id = ?", a.owner_user_id);
		if (!owner) return;
		const nid = this.#notify.createInApp({ orgId: a.org_id, userId: a.owner_user_id, kind: "automation_run", title, body, link, status: run.status, refs, runId });
		if (!dest.inApp) this.db.run("UPDATE ops_notifications SET read_at = ? WHERE id = ?", nowIso(), nid);
		if (dest.channelIds.length && run.status !== "refused") this.#notify.deliver(nid, dest.channelIds, { event: "automation.run.finished", automation: { id: a.id, name: a.name }, run: { id: runId, status: run.status, scheduledFor: run.scheduled_for, reason: run.reason ?? undefined, conversationId: run.conversation_id ?? undefined, spaceId: a.space_id }, link, deliverables: refs.filter((r) => r.kind === "file") }, a.org_id, runId);
		else if (dest.channelIds.length) this.#notify.deliver(nid, dest.channelIds, { event: "automation.run.refused", automation: { id: a.id, name: a.name }, run: { id: runId, status: run.status, reason: run.reason ?? undefined }, link }, a.org_id, runId);
	}
}
