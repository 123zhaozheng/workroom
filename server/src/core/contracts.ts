// Frozen cross-module contracts (owner: main/integrator).
// Groups implement these; changes go through the integrator (docs/ownership.md).
// Rule: pi-durable is the single source of truth for conversations, entries, branches (fork parent),
// submissions, runs, tasks, subagent ownership and checkpoints. Nothing in the app DB may hold an
// independently writable copy of those facts. The app DB holds identity, ACL, catalog/display metadata,
// blobs/file versions, knowledge indexes, automation definitions and usage projections.

import type { Hono } from "hono";
import type { Extension, Harness } from "@earendil-works/pi-durable";
import type { Context as ChordContext } from "@earendil-works/chord/context";
import type { AppDb, Migration } from "./db.ts";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { BlobStore } from "./blobs.ts";
import type { AppConfig } from "./config.ts";

// ---------- identity / ACL (implemented by group E in server/src/identity) ----------
export type OrgRole = "owner" | "admin" | "member";
export type ProjectRole = "owner" | "editor" | "viewer";

export interface Principal {
	readonly userId: string;
	readonly orgId: string;
	readonly orgRole: OrgRole;
	readonly displayName: string;
	readonly email: string;
	readonly departmentIds: readonly string[];
	/** Server-side session id, for revocation. Absent for system actors (automation). */
	readonly sessionId?: string;
	/** Set when this principal acts on behalf of an automation (re-resolved at fire time). */
	readonly via?: { readonly kind: "automation"; readonly automationId: string };
}

export type ResourceRef =
	| { kind: "org"; id: string }
	| { kind: "space"; id: string }
	| { kind: "project"; id: string }
	| { kind: "conversation"; id: string; spaceId: string }
	| { kind: "file"; id: string }
	| { kind: "kb"; id: string }
	| { kind: "tool"; id: string }
	| { kind: "connector"; id: string }
	| { kind: "model"; id: string }
	| { kind: "automation"; id: string }
	| { kind: "skill"; id: string };

export type Action = "read" | "write" | "admin" | "use" | "share" | "delete";

export interface Decision {
	readonly allow: boolean;
	/** Machine-readable reason, e.g. "not_member", "revoked", "role_viewer". */
	readonly reason: string;
}

export interface Space {
	readonly id: string;
	readonly orgId: string;
	readonly kind: "personal" | "project";
	readonly ownerUserId?: string;
	readonly projectId?: string;
	/** Directory holding this space's pi-durable storage and sandbox dirs. Never shared across spaces. */
	readonly dir: string;
}

export interface AccessControl {
	/** Always evaluated against current state (memberships, revocations). Never cached across requests. */
	check(principal: Principal, action: Action, resource: ResourceRef): Promise<Decision>;
	/** Throws HttpError(403) when denied. */
	require(principal: Principal, action: Action, resource: ResourceRef): Promise<void>;
	/** Spaces the principal may read, for listing. */
	readableSpaces(principal: Principal): Promise<Space[]>;
}

export interface IdentityService {
	resolveSessionToken(token: string): Promise<Principal | null>;
	/** Re-resolve a principal from durable ids (for background work / automations). Null if user disabled or removed. */
	principalFor(userId: string, orgId: string): Promise<Principal | null>;
	space(spaceId: string): Space | null;
	personalSpace(userId: string, orgId: string): Space;
	projectSpace(projectId: string): Space | null;
}

// ---------- runtime (group A, server/src/runtime) ----------
/** Data stored in our `wr.input` entry for every user input admitted through the API. */
export interface InputEntryData {
	readonly text: string;
	readonly userId: string;
	readonly orgId: string;
	/** File versions attached to this input (ids from the files module). */
	readonly attachments?: readonly { fileId: string; versionId: string; name: string }[];
	/** Knowledge bases / docs referenced with chips. */
	readonly knowledgeRefs?: readonly { kbId: string; docId?: string; name: string }[];
	readonly via?: { kind: "automation"; automationId: string; runId: string } | { kind: "delegate" | "subagent_report"; id: string };
}

/** Who a tool call acts for: resolved from the run's inputs, then re-checked against current ACL. */
export interface ToolActor {
	readonly principal: Principal;
	readonly space: Space;
	readonly conversationId: number;
	readonly taskId: number;
	readonly callId: string;
}

export interface RuntimeService {
	/** The owner's Harness for a space (opened lazily under the single-owner lease). */
	harness(spaceId: string, context: ChordContext): Promise<Harness>;
	/** Resolve the acting principal for a running tool call (see ToolActor). Throws if access is revoked. */
	actorForTool(api: { conversationId: unknown; taskId: unknown; callId: string }, spaceId: string, context: ChordContext): Promise<ToolActor>;
	/** Space a pi conversation belongs to (from the catalog). */
	spaceOfConversation(spaceId: string, conversationId: number): Promise<Space | null>;
	/** Admit a user input on behalf of a principal (used by API and automations). requestId dedupes. */
	submitInput(principal: Principal, spaceId: string, conversationId: number, input: InputEntryData & { requestId: string; whenBusy?: "steer" | "followUp" | "reject" }, context: ChordContext): Promise<{ submissionId: number }>;
	createConversation(principal: Principal, spaceId: string, options: { title?: string; projectId?: string; kind?: "chat" | "automation"; model?: ModelRef; assistantId?: string }, context: ChordContext): Promise<{ conversationId: number }>;
	/** Like actorForTool, resolving the space from the storage's `wr.space` doc; `input` = first placed input of the current run. */
	actorForToolCall(api: ToolApiLike, context: ChordContext): Promise<ToolActor & { input?: InputEntryData }>;
	inputForTool(api: ToolApiLike, context: ChordContext): Promise<InputEntryData | undefined>;
	spaceIdForTool(api: Pick<ToolApiLike, "snapshot">, context: ChordContext): Promise<string>;
	/** Scope for system-prompt sections; principal null = revoked. */
	promptScope(input: import("@earendil-works/pi-durable").PromptInput, context: ChordContext): Promise<{ space: Space; principal: Principal | null } | null>;
	/** Re-install an extension in every open harness (e.g. after MCP tool discovery). */
	reinstallExtension(ext: Extension): void;
}

// ---------- models / usage (group E, server/src/ops) ----------
export interface ModelRef {
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface ModelGateway {
	/** The pi-ai Models instance handed to every Harness (providers + credentials live server-side only). */
	piModels(): import("@earendil-works/pi-ai/models").Models;
	/** Platform models a principal may pick, with availability ("ready" | "blocked: no credentials" | "fixture"). */
	listFor(principal: Principal): Promise<PlatformModel[]>;
	defaultModel(principal: Principal): Promise<ModelRef>;
}

export interface PlatformModel {
	readonly id: string; // platform model id shown to users
	readonly label: string;
	readonly ref: ModelRef;
	readonly status: "ready" | "blocked" | "fixture";
	readonly statusDetail?: string;
	readonly capabilities: readonly ("text" | "image" | "tools" | "reasoning")[];
}

// ---------- knowledge (group C) ----------
export interface Citation {
	readonly kbId: string;
	readonly docId: string;
	readonly fileId: string;
	readonly versionId: string;
	readonly versionNo: number;
	readonly fileName: string;
	readonly chunkId: string;
	readonly page?: number;
	readonly section?: string;
	readonly snippet: string;
	readonly score: number;
}

export interface KnowledgeService {
	search(principal: Principal, query: string, options: { kbIds?: string[]; projectId?: string; limit?: number }): Promise<{ citations: Citation[]; diagnostics: { reason?: "no_evidence" | "index_not_ready" | "forbidden" | "error"; detail?: string; searchedKbIds: string[] } }>;
}

// ---------- files (group D) ----------
export interface FileVersionRef {
	readonly fileId: string;
	readonly versionId: string;
	readonly versionNo: number;
	readonly name: string;
	readonly mime: string;
	readonly size: number;
	readonly sha256: string;
}

export interface FileProvenance {
	readonly createdBy: string;
	readonly spaceId: string;
	readonly projectId?: string;
	readonly conversationId?: number;
	readonly taskId?: number;
	readonly callId?: string;
	readonly submissionId?: number;
	readonly inputVersionIds?: readonly string[];
	readonly changeNote?: string;
	readonly origin: "upload" | "agent" | "automation";
}

export interface FileService {
	/** Create a new file (v1) or append an immutable version to an existing file. */
	putVersion(principal: Principal, input: { fileId?: string; name: string; mime: string; bytes: Uint8Array; provenance: FileProvenance; idempotencyKey?: string }): Promise<FileVersionRef>;
	getVersion(principal: Principal, versionId: string): Promise<{ ref: FileVersionRef; bytes: Uint8Array; provenance: FileProvenance } | null>;
}

// ---------- approvals & external effects (provided by group A, consumed by D and others) ----------
/** Minimal view of pi-durable's ToolExecutionApi needed by effects (pass the real `api`). */
export type ToolApiLike = import("@earendil-works/pi-durable").ToolExecutionApi;

export interface ApprovalRequest {
	readonly title: string;
	/** Exactly what will happen if approved (shown to the user verbatim). */
	readonly summary: string;
	readonly detail?: JsonValue;
	readonly risk: "low" | "medium" | "high";
	/** Who may decide; default: any principal with write access to the conversation's space. */
	readonly approverUserIds?: readonly string[];
}
export interface ApprovalDecision {
	readonly decision: "approved" | "rejected";
	readonly by: string;
	readonly at: string;
	readonly note?: string;
}
export type EffectOutcome<T> =
	| { readonly status: "done"; readonly receipt: T; readonly replayed: boolean }
	| { readonly status: "needs_reconciliation"; readonly detail: string; readonly effectId: string };

export interface EffectsApi {
	/** Durable approval: stored in a `wr.approvals` doc (fork: "initial"); survives restarts; a replay-safe tool rerun reattaches by callId. */
	requestApproval(api: ToolApiLike, request: ApprovalRequest, context: ChordContext): Promise<ApprovalDecision>;
	/**
	 * External write with intent → dispatching → receipt, recorded in a `wr.effects` doc before/after `perform`.
	 * On replay: receipt present → returns it (replayed: true, perform NOT called);
	 * dispatching without receipt → needs_reconciliation (perform NOT called again). Tools must be `replay: "safe"`.
	 */
	externalEffect<T extends JsonValue>(api: ToolApiLike, spec: { key: string; target: string; summary: string; idempotencyKey?: string }, perform: (idempotencyKey: string) => Promise<T>, context: ChordContext): Promise<EffectOutcome<T>>;
}

/** Optional budget gate (group E). Runtime calls it before admitting input / starting subagents. */
export interface BudgetGate {
	checkSubmit(principal: Principal, spaceId: string, projectId?: string): Promise<{ allow: true } | { allow: false; reason: string }>;
}

// ---------- module system ----------
export interface Services {
	identity: IdentityService;
	acl: AccessControl;
	runtime: RuntimeService;
	models: ModelGateway;
	knowledge: KnowledgeService;
	files: FileService;
	effects: EffectsApi;
	budget: BudgetGate;
	[name: string]: unknown;
}

export interface AppContext {
	readonly config: AppConfig;
	readonly db: AppDb;
	readonly blobs: BlobStore;
	readonly services: ServiceRegistry;
	/** All loaded modules (runtime uses this to install every module's pi-durable extensions). */
	readonly modules: readonly WorkroomModule[];
}

export interface ServiceRegistry {
	provide<K extends keyof Services & string>(name: K, service: Services[K]): void;
	/** Late-bound lookup; throws if the providing module was not initialised. */
	get<K extends keyof Services & string>(name: K): Services[K];
	has(name: string): boolean;
}

export type AppEnv = { Variables: { principal: Principal | null; requestId: string } };

export interface WorkroomModule {
	readonly name: string;
	readonly migrations?: readonly Migration[];
	/** Provide services. Runs in module order; do not call other services here. */
	init?(ctx: AppContext): void | Promise<void>;
	/** Mount routes under /api. */
	routes?(app: Hono<AppEnv>, ctx: AppContext): void;
	/** pi-durable extensions this module contributes; installed into every space's registry. */
	extensions?(ctx: AppContext): Extension[];
	/** Background work after all modules initialised (schedulers, resume). */
	start?(ctx: AppContext): Promise<void>;
	stop?(ctx: AppContext): Promise<void>;
}
