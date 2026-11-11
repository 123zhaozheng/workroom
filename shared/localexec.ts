// Round 11 (R4): local (in-browser) execution unified with the cloud sandbox. Contracts shared by server and web.
// Kept in its own file so the sandbox DTOs (shared/sandbox.ts) only gain one optional field.

/** Conversation preference: "local" = browser first when the code qualifies (default), "cloud" = always the cloud sandbox. */
export type LocalExecPreference = "local" | "cloud";

/** Optional block of ConversationEnvironmentDTO (`local`) and the answer of GET …/local-exec. */
export interface LocalExecStatusDTO {
	/** Organisation switch (admin: 沙箱 › 本地执行). */
	readonly enabled: boolean;
	/** A browser tab of THIS user is currently connected to this conversation and able to run code. */
	readonly connected: boolean;
	/** What this conversation prefers (default "local"). Only effective while `enabled`. */
	readonly preference: LocalExecPreference;
}

export type LocalExecLanguage = "javascript" | "python";

/** Why a browser run was given up on (all are capacity reasons: the job is retried in the cloud once). */
export type LocalFailKind = "timeout" | "oom" | "unsupported" | "tab_lost" | "unclaimed";

/** SSE event `localjob` (announce) on the conversation stream: a tab of the run's user may claim it. */
export interface LocalJobAnnounce {
	readonly jobId: string;
	readonly language: LocalExecLanguage;
	readonly timeoutSec: number;
}
/** SSE event `localjob-cancel`: stop this job (taken by someone else, timed out, or the run was stopped). */
export interface LocalJobCancel {
	readonly jobId: string;
	readonly reason: "taken" | "timeout" | "aborted" | "done";
}

/** POST …/local-exec/jobs/:jobId/claim → the job itself (first claim wins; later ones get 409). */
export interface LocalJobClaimResponse {
	readonly jobId: string;
	readonly language: LocalExecLanguage;
	readonly code: string;
	readonly timeoutSec: number;
	/** Workspace paths made available to the code; fetch with GET …/jobs/:jobId/input?path=. */
	readonly inputs: readonly { readonly path: string; readonly size: number }[];
	/** Hard limits the runtime must apply. */
	readonly limits: { readonly maxOutputChars: number; readonly maxOutputFiles: number; readonly maxOutputBytes: number };
}

/** POST …/local-exec/jobs/:jobId/result. Output files travel as base64 and are written to the host workspace by the server. */
export interface LocalJobResultRequest {
	readonly tabId: string;
	readonly ok: boolean;
	readonly stdout?: string;
	readonly stderr?: string;
	/** JSON text of the code's return value (undefined when none). */
	readonly returnValue?: string;
	readonly durationMs?: number;
	readonly error?: { readonly kind: LocalFailKind | "error"; readonly message: string };
	readonly files?: readonly { readonly path: string; readonly base64: string }[];
}

export const LOCAL_EXEC_LIMITS = {
	/** Input bytes that may be handed to a browser run; more → cloud. */
	maxInputBytes: 20 * 1024 * 1024,
	/** Longest run the browser takes; longer → cloud. */
	maxTimeoutSec: 30,
	/** A tab must claim within this long, else cloud. */
	claimWaitMs: 3000,
	maxOutputChars: 1_000_000,
	maxOutputFiles: 50,
	maxOutputBytes: 20 * 1024 * 1024,
} as const;
