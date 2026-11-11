// Round 11 (R2b): intent-based background prewarm of the remote sandbox.
//
// Hard rules (tested in server/test/sandbox-prewarm.test.ts):
//  * Called AFTER a user message was accepted, never awaited: the chat run does not wait for, and cannot be failed by, a sandbox start.
//  * Pure chat never starts a sandbox: only a message whose intent score reaches the threshold does, and only when the organisation's channel is a
//    remote provider, the user may write to the space and has sandbox.use, and the setting is on.
//  * One prewarm in flight per workspace; a live (ready) or already preparing sandbox is left alone; a paused one counts as not ready (prepare resumes it).
//  * Tier (c) is untouched: the first sandbox tool call still creates the sandbox on demand.
//  * Every decision is logged (tool_sandbox_prewarm_log) so the threshold can be tuned from real traffic (R6); `markExec` closes the loop.
import type { AppContext, Principal, Space } from "../../core/contracts.ts";
import type { Migration } from "../../core/db.ts";
import { HttpError, nowIso } from "../../core/http.ts";
import type { SandboxPrewarmSettingsDTO, SandboxPrewarmStatsDTO, SandboxPrewarmSweepRow } from "../../../../shared/prewarm.ts";
import { DEFAULT_PREWARM_THRESHOLD, scoreExecIntent, type IntentAttachment } from "./intent.ts";
import { environmentsFor } from "./environment.ts";
import { providerConfigsFor } from "./provider-config.ts";
import { hasPermission } from "./perm.ts";
import { workspaceKeyOf } from "./persist.ts";

/** Module version offset in the tools module (see tools/module.ts). */
export const PREWARM_MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "sandbox prewarm log",
		sql: `
CREATE TABLE tool_sandbox_prewarm_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  score REAL NOT NULL,
  threshold REAL NOT NULL,
  fired INTEGER NOT NULL,
  reason TEXT NOT NULL,
  signals TEXT NOT NULL DEFAULT '',
  used_at TEXT
);
CREATE INDEX tool_sandbox_prewarm_log_conv ON tool_sandbox_prewarm_log(org_id, space_id, conversation_id, at);
CREATE INDEX tool_sandbox_prewarm_log_org ON tool_sandbox_prewarm_log(org_id, at);
`,
	},
];

/** Why a decision did or did not start a prewarm. Only "fired" starts one; "below" rows feed the recall estimate. */
export type PrewarmReason = "fired" | "below" | "ready" | "inflight" | "capped" | "failed_recently";

export const DEFAULT_PREWARM: SandboxPrewarmSettingsDTO = { enabled: true, threshold: DEFAULT_PREWARM_THRESHOLD };
/** Prewarms in flight per organisation at the same moment (a burst of conversations must not open an unbounded number of sandboxes). */
export const MAX_PREWARMS_PER_ORG = 4;
/** After a failed start the next message does not retry for this long (the failure stays visible; the first exec call still tries). */
const FAILED_COOLDOWN_MS = 2 * 60_000;
/** An exec marks fired rows of its conversation younger than this as "used". */
const USED_WINDOW_MS = 24 * 3600_000;
const LOG_RETENTION_MS = 90 * 24 * 3600_000;

const settingsKey = (orgId: string) => `prewarm:${orgId}`;

export interface PrewarmMessage {
	readonly text: string;
	readonly attachments?: readonly IntentAttachment[];
	/** Messages written by the runtime itself (automation, subagent report) never prewarm. */
	readonly via?: unknown;
	/** Looks up the default tool names of the conversation's assistant (called only after the cheap gates passed). */
	readonly assistantTools?: () => Promise<readonly string[] | undefined>;
}

export class SandboxPrewarm {
	readonly #ctx: AppContext;
	readonly #inflight = new Set<string>();
	readonly #orgInflight = new Map<string, number>();
	/** Test hook: every detached promise (decision, prepare) until it settles. */
	readonly #pending = new Set<Promise<unknown>>();
	#track<T>(pr: Promise<T>): Promise<T> {
		this.#pending.add(pr);
		void pr.finally(() => this.#pending.delete(pr)).catch(() => {});
		return pr;
	}

	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}

	// ---------- settings (org level, tool_sandbox_settings key/value) ----------
	settings(orgId: string): SandboxPrewarmSettingsDTO {
		try {
			const r = this.#ctx.db.get<{ value: string }>("SELECT value FROM tool_sandbox_settings WHERE key = ?", settingsKey(orgId));
			if (!r) return DEFAULT_PREWARM;
			const v = JSON.parse(r.value) as Partial<SandboxPrewarmSettingsDTO>;
			return {
				enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULT_PREWARM.enabled,
				threshold: typeof v.threshold === "number" && v.threshold >= 0 && v.threshold <= 1 ? v.threshold : DEFAULT_PREWARM.threshold,
			};
		} catch {
			return DEFAULT_PREWARM;
		}
	}

	async readSettings(p: Principal): Promise<SandboxPrewarmSettingsDTO> {
		await providerConfigsFor(this.#ctx).requireManage(p);
		return this.settings(p.orgId);
	}

	async updateSettings(p: Principal, patch: { enabled?: unknown; threshold?: unknown }): Promise<SandboxPrewarmSettingsDTO> {
		await providerConfigsFor(this.#ctx).requireManage(p);
		if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new HttpError(400, "invalid", "请求体无效");
		const cur = this.settings(p.orgId);
		if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new HttpError(400, "invalid", "enabled 必须是布尔值");
		if (patch.threshold !== undefined && (typeof patch.threshold !== "number" || !Number.isFinite(patch.threshold) || patch.threshold < 0 || patch.threshold > 1)) throw new HttpError(400, "invalid", "threshold 必须是 0 到 1 之间的数字");
		const next: SandboxPrewarmSettingsDTO = { enabled: (patch.enabled as boolean | undefined) ?? cur.enabled, threshold: (patch.threshold as number | undefined) ?? cur.threshold };
		this.#ctx.db.run(
			"INSERT INTO tool_sandbox_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
			settingsKey(p.orgId), JSON.stringify(next), p.userId, nowIso(),
		);
		try {
			this.#ctx.db.run("INSERT INTO id_audit (id, org_id, actor_user_id, action, target, detail, at, category) VALUES (?, ?, ?, ?, ?, ?, ?, 'admin')", `aud_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, p.orgId, p.userId, "sandbox.prewarm.update", "prewarm", JSON.stringify(next), nowIso());
		} catch {
			/* the audit table belongs to the identity module */
		}
		return next;
	}

	// ---------- the hook ----------
	/**
	 * Called by the runtime right after a user message was accepted. Synchronous and non-blocking: returns immediately, everything else runs detached
	 * and never throws into the caller.
	 */
	onUserMessage(p: Principal, space: Space, conversationId: number, msg: PrewarmMessage): void {
		if (msg.via) return;
		this.#track(this.#evaluate(p, space, conversationId, msg).catch((e) => console.warn("[sandbox] prewarm decision failed:", e instanceof Error ? e.message : e)));
	}

	/** Test helper: wait until everything started so far (decisions and the prepare calls they started) has settled. */
	async idle(): Promise<void> {
		while (this.#pending.size) await Promise.allSettled([...this.#pending]);
	}

	async #evaluate(p: Principal, space: Space, conversationId: number, msg: PrewarmMessage): Promise<void> {
		const cfg = this.settings(space.orgId);
		if (!cfg.enabled) return;
		// Cheap gates first: nothing below touches a provider.
		if (providerConfigsFor(this.#ctx).effectiveFor(space).kind !== "provider") return;
		if (!(await this.#mayUse(p, space))) return;
		const usedSandbox = this.#usedSandbox(space, conversationId);
		let assistantTools: readonly string[] | undefined;
		try {
			assistantTools = await msg.assistantTools?.();
		} catch {
			assistantTools = undefined;
		}
		const { p: score, signals } = scoreExecIntent({ text: msg.text, attachments: msg.attachments, usedSandbox, assistantTools });
		const wants = score >= cfg.threshold;
		if (!wants) return this.#log(space, conversationId, score, cfg.threshold, "below", signals);

		const env = await environmentsFor(this.#ctx).get(p, space, conversationId);
		if (env.kind !== "remote" || !env.canPrepare) return;
		// "paused" (R1) and "archived" count as NOT ready: prepare resumes them. "preparing" / "resuming" are already on their way.
		const state: string = env.state;
		if (state === "ready") return this.#log(space, conversationId, score, cfg.threshold, "ready", signals);
		if (state === "preparing" || state === "resuming") return this.#log(space, conversationId, score, cfg.threshold, "inflight", signals);
		if (env.state === "failed" && env.updatedAt && Date.now() - Date.parse(env.updatedAt) < FAILED_COOLDOWN_MS) return this.#log(space, conversationId, score, cfg.threshold, "failed_recently", signals);

		const key = `${space.orgId}|${space.id}|${workspaceKeyOf(conversationId)}`;
		if (this.#inflight.has(key)) return this.#log(space, conversationId, score, cfg.threshold, "inflight", signals);
		if ((this.#orgInflight.get(space.orgId) ?? 0) >= MAX_PREWARMS_PER_ORG) return this.#log(space, conversationId, score, cfg.threshold, "capped", signals);
		this.#inflight.add(key);
		this.#orgInflight.set(space.orgId, (this.#orgInflight.get(space.orgId) ?? 0) + 1);
		this.#log(space, conversationId, score, cfg.threshold, "fired", signals);
		// Detached on purpose: the caller (and the chat run) never waits for the provider.
		void this.#track(
			environmentsFor(this.#ctx)
				.prepare(p, space, conversationId, undefined, { trigger: "prewarm" })
				.catch((e) => console.warn("[sandbox] prewarm failed:", e instanceof Error ? e.message : e))
				.finally(() => {
					this.#inflight.delete(key);
					const n = (this.#orgInflight.get(space.orgId) ?? 1) - 1;
					if (n <= 0) this.#orgInflight.delete(space.orgId);
					else this.#orgInflight.set(space.orgId, n);
				}),
		);
	}

	async #mayUse(p: Principal, space: Space): Promise<boolean> {
		try {
			await this.#ctx.services.get("acl").require(p, "write", { kind: "space", id: space.id });
		} catch {
			return false;
		}
		return hasPermission(this.#ctx, p, "sandbox.use");
	}

	#usedSandbox(space: Space, conversationId: number): boolean {
		try {
			if (this.#ctx.db.get("SELECT 1 AS x FROM tool_sandbox_runs WHERE space_id = ? AND conversation_id = ? LIMIT 1", space.id, conversationId)) return true;
			return !!this.#ctx.db.get("SELECT 1 AS x FROM tool_sandbox_instances WHERE org_id = ? AND space_id = ? AND workspace_key = ? LIMIT 1", space.orgId, space.id, workspaceKeyOf(conversationId));
		} catch {
			return false;
		}
	}

	// ---------- log (R6) ----------
	#log(space: Space, conversationId: number, score: number, threshold: number, reason: PrewarmReason, signals: readonly string[]): void {
		try {
			this.#ctx.db.run(
				"INSERT INTO tool_sandbox_prewarm_log (org_id, space_id, conversation_id, at, score, threshold, fired, reason, signals) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				space.orgId, space.id, conversationId, nowIso(), Math.round(score * 1000) / 1000, threshold, reason === "fired" ? 1 : 0, reason, signals.join(",").slice(0, 300),
			);
			if (Math.random() < 0.01) this.#ctx.db.run("DELETE FROM tool_sandbox_prewarm_log WHERE at < ?", new Date(Date.now() - LOG_RETENTION_MS).toISOString());
		} catch (e) {
			console.warn("[sandbox] prewarm log failed:", e instanceof Error ? e.message : e);
		}
	}

	/**
	 * A sandbox exec happened in this conversation: (1) the latest still-unmarked decision (the message that led to it) and (2) every fired prewarm of the
	 * last 24 h that was not yet marked are stamped `used_at`. Never throws.
	 */
	markExec(orgId: string, spaceId: string, conversationId: number): void {
		try {
			const now = nowIso();
			const since = new Date(Date.now() - USED_WINDOW_MS).toISOString();
			this.#ctx.db.run(
				"UPDATE tool_sandbox_prewarm_log SET used_at = ? WHERE id = (SELECT id FROM tool_sandbox_prewarm_log WHERE org_id = ? AND space_id = ? AND conversation_id = ? AND used_at IS NULL AND at >= ? ORDER BY id DESC LIMIT 1)",
				now, orgId, spaceId, conversationId, since,
			);
			this.#ctx.db.run("UPDATE tool_sandbox_prewarm_log SET used_at = ? WHERE org_id = ? AND space_id = ? AND conversation_id = ? AND fired = 1 AND used_at IS NULL AND at >= ?", now, orgId, spaceId, conversationId, since);
		} catch {
			/* the log is advisory */
		}
	}

	stats(orgId: string, sinceIso = new Date(Date.now() - 30 * 24 * 3600_000).toISOString()): SandboxPrewarmStatsDTO {
		return prewarmStats(this.#ctx, orgId, sinceIso);
	}
}

const ratio = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);
export const SWEEP_THRESHOLDS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7] as const;

/**
 * Precision / recall-style counts for tuning the threshold. Only decisions that were really "fired" or "below threshold" count: a message that
 * passed the threshold but found a sandbox already live / preparing says nothing about the threshold.
 *   precision = fired prewarms that were followed by an exec / fired prewarms
 *   recall    = fired and used / (fired and used + below-threshold messages followed by an exec)   [an estimate: see docs/r11-prewarm.md]
 */
export function prewarmStats(ctx: AppContext, orgId: string, sinceIso: string, opts: { untilIso?: string; thresholds?: readonly number[] } = {}): SandboxPrewarmStatsDTO {
	const rows = ctx.db.all<{ score: number; fired: number; reason: string; used: number }>(
		"SELECT score, fired, reason, CASE WHEN used_at IS NULL THEN 0 ELSE 1 END AS used FROM tool_sandbox_prewarm_log WHERE org_id = ? AND at >= ? AND at < ?",
		orgId, sinceIso, opts.untilIso ?? "9999",
	);
	const decisive = rows.filter((r) => r.reason === "fired" || r.reason === "below");
	const fired = decisive.filter((r) => r.fired === 1);
	const firedUsed = fired.filter((r) => r.used === 1).length;
	const missed = decisive.filter((r) => r.fired === 0 && r.used === 1).length;
	const sweep: SandboxPrewarmSweepRow[] = (opts.thresholds ?? SWEEP_THRESHOLDS).map((t) => {
		const tp = decisive.filter((r) => r.score >= t && r.used === 1).length;
		const fp = decisive.filter((r) => r.score >= t && r.used === 0).length;
		const fn = decisive.filter((r) => r.score < t && r.used === 1).length;
		return { threshold: t, truePositive: tp, falsePositive: fp, falseNegative: fn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) };
	});
	return { since: sinceIso, decisions: rows.length, fired: fired.length, firedUsed, missed, precision: ratio(firedUsed, fired.length), recall: ratio(firedUsed, firedUsed + missed), sweep };
}

const cache = new WeakMap<AppContext, SandboxPrewarm>();
export function prewarmFor(ctx: AppContext): SandboxPrewarm {
	let s = cache.get(ctx);
	if (!s) cache.set(ctx, (s = new SandboxPrewarm(ctx)));
	return s;
}
