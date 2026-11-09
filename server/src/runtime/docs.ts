// pi-durable typed documents owned by the runtime (all facts live in the space's durable.sqlite, never in app.sqlite).
import { defineDoc, defineEntry } from "@earendil-works/pi-durable";
import type { ApprovalDTO, EffectDTO, SubagentDTO } from "../../../shared/chat.ts";
import type { InputEntryData } from "../core/contracts.ts";

/** Session doc: which Workroom space this storage belongs to (lets tools resolve their space from `api`). */
export const SpaceDoc = defineDoc<{ spaceId: string; orgId: string }>({
	kind: "wr.space",
	version: 1,
	scope: "session",
	initial: () => ({ spaceId: "", orgId: "" }),
	checkpointWhen: () => true,
});

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? U[] : T[K] };

/** Approvals requested by tool calls of this conversation. fork: "initial" → a branch never inherits pending approvals. */
export const ApprovalsDoc = defineDoc<{ items: Record<string, Mutable<ApprovalDTO> & Record<string, any>> }>({
	kind: "wr.approvals",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: {} }),
	checkpointWhen: (_v, _ops, info) => info.deltasSinceBase >= 32,
});

/** External write effects (intent → dispatching → receipt). fork: "initial" → a branch can never "re-run" or resurrect them. */
export const EffectsDoc = defineDoc<{ items: Record<string, Mutable<EffectDTO> & Record<string, any>> }>({
	kind: "wr.effects",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: {} }),
	checkpointWhen: (_v, _ops, info) => info.deltasSinceBase >= 32,
});

/** Delegations (subagents) started from this conversation. fork: "initial": a branch does not own the original's subagents. */
export const TeamDoc = defineDoc<{ delegations: Record<string, Mutable<SubagentDTO> & Record<string, any>>; reported: number[] }>({
	kind: "wr.team",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ delegations: {}, reported: [] }),
	checkpointWhen: (_v, _ops, info) => info.deltasSinceBase >= 32,
});

/**
 * Which assistant identity this conversation runs as, and its member declarations (snapshot at creation).
 * rewindable + asOf: a fork keeps the declaration as of its fork entry.
 */
// members/member hold MemberDeclaration values (typed loosely: interfaces are not JsonObject-assignable).
export const AssistantDoc = defineDoc<{ assistantId: string | null; name: string; members: any[]; member?: any }>({
	kind: "wr.assistant",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ assistantId: null, name: "", members: [] }),
	checkpointWhen: () => true,
});

/** The entry every admitted user input is placed as (model still sees the plain user message). */
export const InputEntry = defineEntry<InputEntryData & Record<string, any>>("wr.input");
/** Display-only start marker written when a conversation is created (lets "edit first message" fork before it). */
export const StartEntry = defineEntry<{ createdBy: string; at: string }>("wr.start");
/** Display-only trace of an input that was withdrawn / aborted before it was placed (so the outcome survives reload). */
export const UnplacedInputEntry = defineEntry<InputEntryData & Record<string, any>>("wr.input-unplaced");
/** Display-only runtime notice in the transcript (not seen by the model), e.g. a model fallback with its reason. */
export const NoticeEntry = defineEntry<{ text: string; code: string }>("wr.notice");
