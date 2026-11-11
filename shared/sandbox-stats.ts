// Round 11 (R6): sandbox lifecycle statistics (cold start, resume, idle pauses, running time, estimated cost, prewarm tuning).
// Definitions: docs/r11-observability.md.
import type { SandboxPrewarmSweepRow } from "./prewarm.ts";

/** Nearest-rank percentiles of a sample; n = 0 gives nulls (shown as "—"). */
export interface SandboxPercentilesDTO {
	readonly n: number;
	readonly p50: number | null;
	readonly p95: number | null;
}

export interface SandboxLifecycleStatsDTO {
	/** Sandboxes created (create events), by what asked for them. */
	readonly creates: number;
	readonly createsByTrigger: { readonly exec: number; readonly prewarm: number; readonly explicit: number };
	readonly createFailures: number;
	/** Cold start = create() + readiness, milliseconds. */
	readonly coldStart: SandboxPercentilesDTO;
	readonly resumes: number;
	readonly resumeFailures: number;
	readonly resume: SandboxPercentilesDTO;
	/** Pauses by the idle reaper. */
	readonly idlePauses: number;
	readonly archives: number;
	readonly destroys: number;
	/** Closed running intervals that ended in the range + still-running intervals up to now (when now is inside the range). */
	readonly runningMs: number;
	/** The part of runningMs that belongs to still-running sandboxes. */
	readonly openRunningMs: number;
	/** Estimated cost in USD = running hours × the configured price; null when no price is configured for this provider. */
	readonly costUsd: number | null;
}

export interface SandboxProviderStatsDTO extends SandboxLifecycleStatsDTO {
	readonly provider: string;
	/** USD per provider-hour (admin setting); null = not configured. */
	readonly priceUsdPerHour: number | null;
}

export interface SandboxConversationStatsDTO extends SandboxLifecycleStatsDTO {
	readonly spaceId: string;
	readonly conversationId: number;
	/** Only when the viewer may read the conversation. */
	readonly title: string | null;
}

/** Where code_run ran (R4): logged in the tool call record ("<backend> <status> <reason>[ upgraded]"). */
export interface SandboxCodeRunStatsDTO {
	readonly browser: number;
	readonly cloud: number;
	/** Browser runs that failed for a capacity reason and were retried in the cloud (counted under `cloud` as well). */
	readonly upgraded: number;
}

export interface SandboxPrewarmTuningDTO {
	readonly threshold: number;
	readonly enabled: boolean;
	readonly decisions: number;
	readonly fired: number;
	/** Fired and followed by an exec. */
	readonly firedUsed: number;
	readonly precision: number | null;
	readonly recall: number | null;
	/** Fired prewarms whose sandbox was paused / destroyed without any exec having used it. */
	readonly wasted: number;
	/** Fired prewarms whose sandbox is still running and not used yet (not counted as wasted). */
	readonly pending: number;
	/** Running time the wasted prewarms cost (ms). */
	readonly wastedRunningMs: number;
	/** What-if thresholds 0.1 … 0.9 from the logged scores. */
	readonly whatIf: readonly SandboxPrewarmSweepRow[];
}

export interface SandboxStatsDTO {
	readonly from: string;
	readonly to: string;
	readonly generatedAt: string;
	/** Provider filter (null = all). The prewarm block is organisation-wide and ignores it. */
	readonly provider: string | null;
	readonly total: SandboxLifecycleStatsDTO;
	/** True when every provider with running time has a price (so the total cost is complete). */
	readonly costComplete: boolean;
	readonly byProvider: readonly SandboxProviderStatsDTO[];
	/** Top conversations by running time (at most 20). */
	readonly conversations: readonly SandboxConversationStatsDTO[];
	readonly codeRun: SandboxCodeRunStatsDTO;
	readonly prewarm: SandboxPrewarmTuningDTO;
}

/** One conversation: counts and times only; `costUsd` is null unless the viewer may see organisation cost. */
export interface SandboxConversationStatsResponse {
	readonly spaceId: string;
	readonly conversationId: number;
	readonly stats: SandboxLifecycleStatsDTO;
	readonly codeRun: SandboxCodeRunStatsDTO;
	readonly costVisible: boolean;
}

export interface SandboxPricesDTO {
	/** USD per provider-hour; a provider without an entry has no price (no cost is shown for it). */
	readonly prices: Readonly<Record<string, number>>;
}
