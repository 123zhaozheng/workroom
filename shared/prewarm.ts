// Round 11 (R2b): organisation-level settings and R6 statistics of the intent-based sandbox prewarm.
export interface SandboxPrewarmSettingsDTO {
	/** Start a remote sandbox in the background when a message looks like it needs code execution. */
	readonly enabled: boolean;
	/** 0..1; a message whose execution-intent score reaches it triggers the prewarm. Default 0.3. */
	readonly threshold: number;
}

export interface SandboxPrewarmSweepRow {
	readonly threshold: number;
	/** Messages that would have fired at this threshold and were followed by an exec. */
	readonly truePositive: number;
	readonly falsePositive: number;
	readonly falseNegative: number;
	readonly precision: number | null;
	readonly recall: number | null;
}

/** Counts from tool_sandbox_prewarm_log for tuning the threshold (docs/r11-prewarm.md). */
export interface SandboxPrewarmStatsDTO {
	readonly since: string;
	/** Decisions logged (messages scored for an organisation on a remote channel). */
	readonly decisions: number;
	readonly fired: number;
	/** Fired prewarms followed by a real exec in that conversation (precision numerator). */
	readonly firedUsed: number;
	/** Below-threshold messages that were nevertheless followed by an exec (recall misses). */
	readonly missed: number;
	readonly precision: number | null;
	readonly recall: number | null;
	/** Same counts re-evaluated at other thresholds from the logged scores. */
	readonly sweep: readonly SandboxPrewarmSweepRow[];
}
