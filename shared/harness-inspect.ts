// Harness 检视 (Harness inspector) DTOs, shared by server (server/src/ops/harness-inspect*.ts) and web (web/src/features/inspect).
// Admin-only debugging aid: what was really sent to the model on every round of an agent run. Off by default per organization.

export interface HarnessInspectStatus {
	/** The org-level switch. */
	readonly enabled: boolean;
	/** The viewer holds `harness.inspect` (may open the inspector). */
	readonly canInspect: boolean;
	/** The viewer may flip the switch (`org.security.manage`). */
	readonly canManage: boolean;
	/** Captured rounds older than this many days are dropped; at most `maxRoundsPerConversation` are kept per conversation. */
	readonly retentionDays: number;
	readonly maxRoundsPerConversation: number;
}

export interface InspectToolDTO {
	readonly name: string;
	readonly description: string;
	/** JSON schema of the arguments, as handed to the provider. */
	readonly parameters: unknown;
}

export type InspectContentBlock =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "thinking"; readonly text: string; readonly redacted?: boolean }
	| { readonly type: "toolCall"; readonly id: string; readonly name: string; readonly arguments: unknown }
	/** Images are never stored; only their type and size. */
	| { readonly type: "image"; readonly mimeType: string; readonly bytes: number };

export interface InspectMessageDTO {
	readonly role: "system" | "user" | "assistant" | "tool";
	readonly content: readonly InspectContentBlock[];
	readonly timestamp?: number;
	/** tool: the call this result answers. */
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly isError?: boolean;
	/** assistant: which model produced it and why it stopped. */
	readonly model?: string;
	readonly stopReason?: string;
	/** system (mid-transcript): prompt sections / tools it changes. */
	readonly sections?: Readonly<Record<string, string | null>>;
	readonly toolsAdded?: readonly string[];
	readonly toolsRemoved?: readonly string[];
	/** Marks a record where messages were dropped to fit the size cap (role "system", text explains). */
	readonly omitted?: number;
}

export interface InspectUsageDTO {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly reasoning?: number;
	readonly totalTokens: number;
	readonly costTotal?: number;
}

export interface HarnessRoundSummaryDTO {
	readonly id: string;
	readonly spaceId: string;
	readonly conversationId: number;
	/** Rounds of one agent run (a user message and the tool rounds that followed it) share a `runId`. */
	readonly runId: string;
	/** The pi-durable generation task of this single request (each round is its own task). */
	readonly taskId?: number;
	/** 1-based position of this model request inside its run. */
	readonly roundIndex: number;
	/** ms since epoch when the request reached the gateway. */
	readonly startedAt: number;
	readonly durationMs?: number;
	readonly model: { readonly provider: string; readonly modelId: string };
	/** "provider/model" that actually answered when a fallback model took over. */
	readonly servedBy?: string;
	readonly thinkingLevel?: string;
	/** Absent while the request is in flight (or when the process stopped before it finished). */
	readonly stopReason?: string;
	readonly error?: string;
	readonly usage?: InspectUsageDTO;
	/** Timestamp of the assistant message this round produced (matches `EntryDTO.timestamp` of that entry). */
	readonly messageTimestamp?: number;
	readonly messageCount: number;
	readonly toolCount: number;
	readonly systemChars: number;
	readonly sizeBytes: number;
	/** Some text was cut to respect the per-record size cap. */
	readonly truncated: boolean;
}

export interface HarnessRoundDetailDTO extends HarnessRoundSummaryDTO {
	/** The full current system prompt (leading system message plus every section). */
	readonly systemPrompt: string;
	/** Named prompt sections (key → size) that made up the prompt, in order. */
	readonly systemSections: readonly { readonly key: string; readonly chars: number }[];
	readonly tools: readonly InspectToolDTO[];
	/** Ordered messages sent after the leading system message. */
	readonly messages: readonly InspectMessageDTO[];
	/** Request options that matter; never credentials or headers. */
	readonly options: Readonly<Record<string, unknown>>;
	readonly modelInfo?: { readonly api?: string; readonly contextWindow?: number; readonly maxTokens?: number; readonly reasoning?: boolean };
}

export type HarnessToolKind = "builtin" | "mcp" | "skill" | "kernel" | "fixture" | "other";

export interface HarnessBuildToolDTO {
	readonly name: string;
	/** Extension that registered it. */
	readonly source: string;
	readonly kind: HarnessToolKind;
	/** Offered to the model on requests (false = callable by other tools only). */
	readonly offered: boolean;
}

export interface HarnessBuildDTO {
	readonly id: string;
	readonly conversationId: number;
	readonly runId: string;
	readonly createdAt: string;
	readonly model?: { readonly provider: string; readonly modelId: string; readonly label?: string };
	readonly thinkingLevel?: string;
	readonly maxTurns?: number;
	readonly cwd?: string;
	/** Assistant instructions appended after the extension sections (truncated). */
	readonly instructions?: string;
	readonly assistant?: { readonly id?: string; readonly name?: string };
	/** Prompt sections in render order with the extension that contributes each. */
	readonly promptSections: readonly { readonly key: string; readonly source: string }[];
	readonly extensions: readonly { readonly name: string; readonly kind: HarnessToolKind; readonly tools: readonly string[] }[];
	readonly tools: readonly HarnessBuildToolDTO[];
	readonly deferredTools: readonly string[];
	/** Where `exec` runs, as the sandbox reports it. */
	readonly environment?: { readonly label?: string; readonly usable: boolean; readonly detail?: string };
}

export interface HarnessRoundsResponse {
	readonly enabled: boolean;
	readonly rounds: readonly HarnessRoundSummaryDTO[];
	readonly builds: readonly HarnessBuildDTO[];
}

export interface HarnessRoundResponse {
	readonly round: HarnessRoundDetailDTO;
}
