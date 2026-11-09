// DTOs for group E routes (identity/org admin, models & routing, usage & budgets, automation, notifications,
// assistants, stats, audit). Owner: group E. Fields may be ADDED; existing fields are not removed or renamed.
// All timestamps are ISO-8601 strings (UTC). Money is USD as a JS number computed from reported tokens × prices.

// ---------------------------------------------------------------- identity / org
export type OrgRole = "owner" | "admin" | "member";
export type ProjectRole = "owner" | "editor" | "viewer";

export interface MeDTO {
	userId: string;
	orgId: string;
	orgName?: string;
	orgRole: OrgRole;
	name: string;
	email: string;
	departmentIds: string[];
	totpEnabled?: boolean;
}

export interface OrgMembershipDTO {
	orgId: string;
	orgName: string;
	role: OrgRole;
	current: boolean;
}

export interface MemberDTO {
	userId: string;
	name: string;
	email: string;
	role: OrgRole;
	status: "active" | "disabled";
	departmentIds: string[];
	joinedAt: string;
	lastSeenAt?: string;
	activeSessions: number;
	totpEnabled: boolean;
}

export interface DepartmentDTO {
	id: string;
	name: string;
	parentId?: string;
	memberCount: number;
	createdAt: string;
}

export interface DepartmentMemberDTO {
	userId: string;
	name: string;
	email: string;
	role: "member" | "manager";
}

export interface InviteDTO {
	code: string;
	email?: string;
	role: OrgRole;
	departmentId?: string;
	createdBy: string;
	createdAt: string;
	expiresAt: string;
	usedAt?: string;
	revokedAt?: string;
}

export interface SessionDTO {
	id: string;
	userId: string;
	userName?: string;
	createdAt: string;
	lastSeenAt?: string;
	expiresAt: string;
	userAgent?: string;
	current: boolean;
	revokedAt?: string;
	revokedReason?: string;
	authMethod: "password" | "oidc" | "invite";
}

export type ShareResourceKind = "conversation" | "file" | "project" | "kb" | "automation";
export interface ShareLinkDTO {
	id: string;
	resource: { kind: ShareResourceKind; id: string; spaceId?: string };
	/** Only returned once, at creation. */
	token?: string;
	/** Path the web app opens for the public read-only view: /s/<token>. Only at creation. */
	url?: string;
	permission: "read";
	createdBy: string;
	createdAt: string;
	expiresAt: string;
	revokedAt?: string;
	revokedReason?: string;
	lastUsedAt?: string;
	useCount: number;
	status: "active" | "expired" | "revoked" | "creator_lost_access";
}

/** Public, unauthenticated view of a share (GET /api/shared/:token). Read-only by construction. */
export interface SharedViewDTO {
	resource: { kind: ShareResourceKind; id: string; spaceId?: string };
	permission: "read";
	expiresAt: string;
	sharedBy: string;
	/** Rendered content when the owning module registered a renderer for this kind; otherwise absent. */
	content?: unknown;
}

export type AuditCategory = "auth" | "admin" | "grant" | "share" | "external_write" | "model" | "budget" | "automation" | "security";
export interface AuditEntryDTO {
	id: string;
	at: string;
	orgId?: string;
	actorUserId?: string;
	actorName?: string;
	action: string;
	category: AuditCategory;
	target?: string;
	detail?: unknown;
	requestId?: string;
}

export interface TotpSetupDTO {
	secret: string;
	otpauthUrl: string;
}

export interface OidcProviderDTO {
	id: string;
	name: string;
	issuer: string;
	clientId: string;
	/** Never returned in plaintext. */
	hasClientSecret: boolean;
	enabled: boolean;
	autoJoinRole: OrgRole;
	allowedDomains: string[];
	createdAt: string;
}

// ---------------------------------------------------------------- models / channels / routing
export type ModelCapability = "text" | "image" | "tools" | "reasoning";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** What users pick (GET /api/models). `ref` is passed to conversations as the pi model ref. */
export interface PlatformModelDTO {
	id: string;
	label: string;
	description?: string;
	ref: { provider: string; modelId: string; thinkingLevel?: ThinkingLevel };
	status: "ready" | "blocked" | "fixture";
	statusDetail?: string;
	capabilities: ModelCapability[];
	thinkingLevels: ThinkingLevel[];
	defaultThinking?: ThinkingLevel;
	contextWindow?: number;
	isDefault: boolean;
	/** True for the deterministic test model: UI must label it "测试模型，非真实 AI". */
	fixture: boolean;
	// ---- round 4 (pi-ai native providers): all optional so older clients keep working
	maxTokens?: number;
	/** Native pi-ai provider id (= ref.provider) and its display name, e.g. "DeepSeek". */
	providerId?: string;
	providerName?: string;
	providerType?: string;
	scope?: "instance" | "org" | "user" | "fixture";
	/** The viewer's own provider (个人自带密钥). */
	personal?: boolean;
	input?: ("text" | "image")[];
	reasoning?: boolean;
	/** USD per million tokens. */
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

// ---- model providers (模型服务商): each is a real pi-ai Provider (createProvider + setProvider); keys are never returned
export type ModelProviderType = "openai-completions" | "openai-responses" | "anthropic-messages" | "builtin";
export type ModelProviderScope = "instance" | "org" | "user";
export type ModelAuthStyle = "default" | "bearer" | "x-api-key" | "api-key";

export interface ModelProviderDTO {
	/** The pi-ai provider id (what conversations store as ref.provider). */
	id: string;
	name: string;
	scope: ModelProviderScope;
	orgId?: string;
	ownerUserId?: string;
	type: ModelProviderType;
	/** pi-ai built-in provider id when type = "builtin" (azure, google, mistral, ...). */
	builtinId?: string;
	preset?: string;
	baseUrl?: string;
	authStyle: ModelAuthStyle;
	keyless: boolean;
	/** The key itself is never returned. */
	credential: { kind: "none" | "stored" | "env"; envVar?: string; hint?: string };
	/** Names only; values are sealed server-side. */
	headerNames: string[];
	envKeys: string[];
	timeoutMs?: number;
	status: "enabled" | "disabled";
	health: "ready" | "blocked" | "disabled";
	healthDetail?: string;
	lastCheck?: { at: string; ok: boolean; list?: boolean; completion?: boolean; detail?: string };
	lastFetchAt?: string;
	source: "admin" | "personal" | "config" | "env" | "migration" | "test";
	modelCount: number;
	enabledModelCount: number;
	/** Instance-level (workroom.models.json / env) providers are read-only for org admins. */
	readOnly: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface AdminModelDTO {
	/** Platform id "<providerId>/<modelId>". */
	id: string;
	providerId: string;
	modelId: string;
	name: string;
	manual: boolean;
	/** A catalog (fetched / built-in) model whose fields the admin overrode. */
	overridden: boolean;
	enabled: boolean;
	contextWindow: number;
	maxTokens: number;
	input: ("text" | "image")[];
	reasoning: boolean;
	thinkingLevels: ThinkingLevel[];
	thinkingLevelMap?: Record<string, string | null>;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	compat?: Record<string, unknown>;
	tools: boolean;
	capabilities: ModelCapability[];
	visibility: { departmentIds?: string[]; projectIds?: string[]; userIds?: string[] } | null;
	fallbacks: { provider: string; modelId: string }[];
	defaultThinking?: ThinkingLevel;
	description?: string;
	sort: number;
	/** Looks like an embedding / speech / image model: not offered by default. */
	nonChat: boolean;
	isDefault: boolean;
}

export interface ModelProviderPreset {
	key: string;
	label: string;
	type: ModelProviderType;
	baseUrl?: string;
	builtinId?: string;
	keyless?: boolean;
	authStyle?: ModelAuthStyle;
	catalogFrom?: string;
	hint: string;
	exampleModels?: string[];
}

export interface ModelProvidersResponse {
	providers: ModelProviderDTO[];
	presets: ModelProviderPreset[];
	/** Admin only. */
	builtins?: { id: string; name: string; baseUrl?: string; models: number; auth: string[]; configured: boolean }[];
	fixture?: { id: string; name: string; detail: string } | null;
	settings?: { personalProviders: boolean; defaultModel: { provider: string; modelId: string } | null; secretKeyConfigured: boolean; config: { path: string | null; providers: string[]; errors: string[] } };
}

export interface CreateModelProviderRequest {
	name: string;
	type: ModelProviderType;
	builtinId?: string;
	preset?: string;
	baseUrl?: string;
	/** Stored encrypted; needs WORKROOM_SECRET_KEY (409 secret_key_missing). */
	apiKey?: string;
	/** Name of a WORKROOM_* environment variable holding the key (admin providers only). */
	apiKeyEnv?: string;
	/** Custom request headers; values are sealed. */
	headers?: Record<string, string>;
	/** Provider-scoped config for pi-ai built-ins, e.g. AZURE_OPENAI_BASE_URL. */
	env?: Record<string, string>;
	keyless?: boolean;
	authStyle?: ModelAuthStyle;
	timeoutMs?: number;
	/** Manual models to add at the same time. */
	models?: (Partial<AdminModelSpec> & { id: string; enabled?: boolean })[];
	/** Run 获取模型列表 right after creating; enableFetched switches the chat ones on. */
	fetchModels?: boolean;
	enableFetched?: boolean;
}
/** null clears (apiKey, headers, env, timeoutMs); a header value "****" keeps the stored value. */
export type UpdateModelProviderRequest = Partial<Omit<CreateModelProviderRequest, "type" | "builtinId" | "models" | "fetchModels" | "enableFetched" | "apiKey" | "headers" | "env" | "timeoutMs">> & { status?: "enabled" | "disabled"; apiKey?: string | null; headers?: Record<string, string> | null; env?: Record<string, string> | null; timeoutMs?: number | null };

/** What a manual model / an override may define (pi-ai Model fields; compat is validated against pi-ai's schema for the provider's API). */
export interface AdminModelSpec {
	name: string;
	contextWindow: number;
	maxTokens: number;
	input: ("text" | "image")[];
	reasoning: boolean;
	thinkingLevelMap: Record<string, string | null>;
	cost: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	compat: Record<string, unknown>;
	tools: boolean;
}
export type UpdateAdminModelRequest = Partial<AdminModelSpec> & {
	enabled?: boolean;
	visibility?: AdminModelDTO["visibility"];
	fallbacks?: AdminModelDTO["fallbacks"];
	defaultThinking?: ThinkingLevel | null;
	description?: string | null;
	sort?: number;
	/** Drop every override on a catalog model. */
	resetSpec?: boolean;
};

export interface ProviderTestResponse {
	ok: boolean;
	list: { ok: boolean; skipped?: boolean; detail?: string; count?: number; latencyMs?: number; url?: string };
	completion: { ok: boolean; modelId?: string; detail?: string; latencyMs?: number; text?: string };
}
export interface FetchModelsResponse {
	ok: boolean;
	error?: string;
	count?: number;
	provider: ModelProviderDTO;
	models: AdminModelDTO[];
}

export type RouteErrorClass =
	| "rate_limit"
	| "overloaded"
	| "server"
	| "timeout"
	| "network"
	| "auth"
	| "context_overflow"
	| "bad_request"
	| "aborted"
	| "no_credentials"
	| "concurrency"
	| "local_rate_limit"
	| "circuit_open"
	| "capability_mismatch"
	| "unknown";

export interface RouteAttemptDTO {
	id: string;
	requestKey: string;
	attemptNo: number;
	platformModelId: string;
	channelId?: string;
	channelName?: string;
	provider?: string;
	upstreamModelId?: string;
	status: "ok" | "error" | "aborted" | "skipped";
	errorClass?: RouteErrorClass;
	errorMessage?: string;
	retryable?: boolean;
	failover: boolean;
	latencyMs?: number;
	firstTokenMs?: number;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; costTotal: number };
	fixture: boolean;
	spaceId?: string;
	conversationId?: number;
	taskId?: number;
	startedAt: string;
	endedAt?: string;
}

// ---------------------------------------------------------------- usage / stats / budgets
export type Outcome = "success" | "failed" | "cancelled" | "timeout" | "awaiting_approval" | "in_progress";
/** Explicit definitions are in docs/ops.md §Usage. */
export interface OutcomeCounts {
	success: number;
	failed: number;
	cancelled: number;
	timeout: number;
	awaiting_approval: number;
	in_progress: number;
	total: number;
}

export interface TokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface UsageSummaryDTO {
	scope: StatsScope;
	from?: string;
	to?: string;
	tasks: OutcomeCounts;
	runs: OutcomeCounts;
	modelRequests: OutcomeCounts;
	toolCalls: OutcomeCounts;
	tokens: TokenTotals;
	/** USD; fixture usage is always 0 and excluded. */
	cost: number;
	fixtureRequests: number;
	routeAttempts: { total: number; failovers: number; skipped: number; byErrorClass: Record<string, number> };
	byModel: { platformModelId: string; requests: number; tokens: number; cost: number; failed: number }[];
	byRoute: { channelId: string; upstreamModelId: string; attempts: number; ok: number; failed: number }[];
}

export type StatsScope = { kind: "personal" } | { kind: "project"; projectId: string } | { kind: "org" } | { kind: "department"; departmentId: string };

export interface LatencyDistributionDTO {
	count: number;
	p50?: number;
	p90?: number;
	p99?: number;
	max?: number;
	/** Histogram buckets: upper bound ms → count (last bucket upper = null means +inf). */
	buckets: { le: number | null; count: number }[];
}

export interface StatsDTO extends UsageSummaryDTO {
	latency: LatencyDistributionDTO;
	largeContext: {
		thresholdTokens: number;
		requests: number;
		failed: number;
		failureRate: number | null;
		byErrorClass: Record<string, number>;
		/** key = platform model id / actual route ("provider/upstreamModel") / task stage ("first_turn" | "after_tools" | "automation"). */
		byModel: { key: string; requests: number; failed: number; failureRate: number }[];
		byRoute: { key: string; requests: number; failed: number; failureRate: number }[];
		byStage: { key: string; requests: number; failed: number; failureRate: number }[];
	};
	errorClasses: Record<string, number>;
	/** Never a fabricated number: confirmed = user-confirmed records; estimate only if an admin configured the basis. */
	savedHours: { confirmed: number | null; estimate: { value: number; basis: string; label: "estimate" } | null };
	daily: { day: string; tasks: number; modelRequests: number; tokens: number; cost: number }[];
}

export interface UsageLedgerRowDTO {
	id: string;
	kind: "task" | "run" | "model_request" | "tool_call";
	at: string;
	orgId: string;
	spaceId: string;
	projectId?: string;
	userId?: string;
	conversationId: number;
	entryId: number;
	taskId?: number;
	outcome: Outcome;
	platformModelId?: string;
	provider?: string;
	route?: string;
	toolName?: string;
	tokens: TokenTotals;
	cost: number;
	fixture: boolean;
	durationMs?: number;
	errorClass?: string;
}

export type BudgetScopeKind = "org" | "department" | "project" | "user";
export interface BudgetDTO {
	id: string;
	scope: { kind: BudgetScopeKind; id: string; name?: string };
	period: "day" | "month" | "total";
	limitCost?: number;
	limitTokens?: number;
	action: "block" | "warn";
	enabled: boolean;
	createdAt: string;
	/** Current consumption for the active period (from the usage ledger projection). */
	spent: { cost: number; tokens: number; periodStart?: string };
	state: "ok" | "warn" | "exceeded";
}

// ---------------------------------------------------------------- automation / notifications
export type AutomationTrigger =
	| { kind: "once"; at: string }
	| { kind: "cron"; expr: string }
	| { kind: "manual" }
	| { kind: "webhook" };

export type AutomationCondition = { kind: "always" } | { kind: "previous_status"; statuses: AutomationRunStatus[] };

export interface AutomationDestinationDTO {
	/** new = new conversation per run; reuse = append to one conversation. */
	conversation: "new" | "reuse";
	inApp: boolean;
	channelIds: string[];
}

export interface AutomationDTO {
	id: string;
	name: string;
	prompt: string;
	ownerUserId: string;
	spaceId: string;
	projectId?: string;
	assistantId?: string;
	modelId?: string;
	trigger: AutomationTrigger;
	timezone: string;
	condition: AutomationCondition;
	destination: AutomationDestinationDTO;
	concurrency: { max: number; policy: "skip" };
	missedPolicy: "skip" | "run_once";
	maxDurationMs: number;
	enabled: boolean;
	nextRunAt?: string;
	/** nextRunAt rendered in the automation's timezone, e.g. "2026-03-09 09:00:00 EDT". */
	nextRunLocal?: string;
	lastRun?: AutomationRunDTO;
	/** Only at creation / rotation for webhook triggers. */
	webhookToken?: string;
	webhookUrl?: string;
	createdAt: string;
	updatedAt: string;
}

export type AutomationRunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timeout" | "skipped" | "refused";
export interface AutomationRunDTO {
	id: string;
	automationId: string;
	scheduledFor: string;
	scheduledForLocal: string;
	trigger: "schedule" | "manual" | "webhook" | "catchup" | "rerun";
	status: AutomationRunStatus;
	reason?: string;
	error?: string;
	spaceId?: string;
	conversationId?: number;
	submissionId?: number;
	requestId: string;
	startedAt?: string;
	endedAt?: string;
	createdAt: string;
	rerunOf?: string;
	/** Link the UI opens. */
	link?: string;
	notifications: { id: string; status: string; deliveries: NotificationDeliveryDTO[] }[];
}

export interface NextRunPreviewDTO {
	timezone: string;
	runs: { at: string; local: string }[];
	error?: string;
}

export interface NotificationDTO {
	id: string;
	kind: "automation_run" | "budget" | "system";
	title: string;
	body: string;
	link?: string;
	status?: string;
	refs: { kind: "conversation" | "file" | "run"; id: string; label?: string; spaceId?: string }[];
	runId?: string;
	createdAt: string;
	readAt?: string;
}

export interface NotifyChannelDTO {
	id: string;
	kind: "webhook" | "email";
	name: string;
	target: string;
	enabled: boolean;
	status: "ready" | "blocked";
	statusDetail?: string;
	hasSecret: boolean;
	createdAt: string;
}

export interface NotificationDeliveryDTO {
	id: string;
	notificationId: string;
	channelId: string;
	status: "pending" | "sent" | "failed" | "blocked";
	attempt: number;
	httpStatus?: number;
	error?: string;
	createdAt: string;
	deliveredAt?: string;
}

// ---------------------------------------------------------------- assistants
export interface AssistantDTO {
	id: string;
	scope: "personal" | "project" | "org";
	projectId?: string;
	ownerUserId: string;
	name: string;
	avatar?: string;
	description: string;
	instructions: string;
	modelId?: string;
	tools: string[];
	knowledge: { kbId: string; name?: string }[];
	createdAt: string;
	updatedAt: string;
	canEdit: boolean;
}

// ---------------------------------------------------------------- tracing
export interface TraceDTO {
	query: string;
	audit: AuditEntryDTO[];
	routeAttempts: RouteAttemptDTO[];
	ledger: UsageLedgerRowDTO[];
	automationRuns: AutomationRunDTO[];
	notifications: NotificationDTO[];
	/** Contributed by other modules (D's tool calls, C's retrieval events, …), redacted. */
	events: TraceEventDTO[];
	eventErrors?: { source: string; error: string }[];
	sources: string[];
}

export interface TraceEventDTO {
	source: string;
	kind: string;
	id: string;
	at: string;
	spaceId?: string;
	conversationId?: number;
	taskId?: number;
	callId?: string;
	requestId?: string;
	status?: string;
	summary: string;
	detail?: unknown;
}

// ================================================================ requests & envelopes (route table: docs/ops.md §9)
export interface ErrorBody {
	error: { code: string; message: string; detail?: unknown };
}

// ---- org / members / invites / departments / sessions
export interface UpdateMemberRoleRequest {
	role: OrgRole;
}
export interface CreateInviteRequest {
	email?: string;
	role?: OrgRole;
	departmentId?: string;
	/** 1..720, default 72 */
	ttlHours?: number;
}
export interface CreateDepartmentRequest {
	name: string;
	parentId?: string;
}
export interface UpdateDepartmentRequest {
	name?: string;
	parentId?: string | null;
}
export interface SetDepartmentMemberRequest {
	userId: string;
	role: "member" | "manager" | null;
}
export interface SetProjectMemberRequest {
	email?: string;
	userId?: string;
	role: ProjectRole | null;
}
export interface CreateShareRequest {
	kind: ShareResourceKind;
	id: string;
	spaceId?: string;
	expiresInHours?: number;
}
export interface AuditQuery {
	/** comma list */
	category?: string;
	/** exact, or prefix with trailing "*" */
	action?: string;
	actorUserId?: string;
	target?: string;
	requestId?: string;
	/** matches ids inside detail (conversationId, effectId, approvalId, runId, …) */
	ref?: string;
	since?: string;
	until?: string;
	/** cursor: id of the last item of the previous page */
	before?: string;
	limit?: number;
}
export interface CreateOidcProviderRequest {
	name: string;
	issuer: string;
	clientId: string;
	clientSecret?: string;
	allowedDomains?: string[];
	autoJoinRole?: "admin" | "member";
}

// ---- budgets / usage settings
export interface CreateBudgetRequest {
	scope: { kind: BudgetScopeKind; id?: string };
	period: "day" | "month" | "total";
	limitCost?: number;
	limitTokens?: number;
	action?: "block" | "warn";
}
export type UpdateBudgetRequest = Partial<Pick<CreateBudgetRequest, "period" | "limitCost" | "limitTokens" | "action">> & { enabled?: boolean };
export interface BudgetCheckResponse {
	allow: boolean;
	reason?: string;
}
export interface TimeSavingRequest {
	minutes: number;
	note?: string;
	spaceId?: string;
	conversationId?: number;
}

// ---- automations / notifications
export interface CreateAutomationRequest {
	name: string;
	prompt: string;
	/** default: personal space; or projectId */
	spaceId?: string;
	projectId?: string;
	trigger: AutomationTrigger;
	timezone: string;
	condition?: AutomationCondition;
	destination?: Partial<AutomationDestinationDTO>;
	maxConcurrent?: number;
	missedPolicy?: "skip" | "run_once";
	maxDurationMs?: number;
	modelId?: string;
	assistantId?: string;
	enabled?: boolean;
}
/** PATCH; `enabled: false` disables (no further scheduled runs), `enabled: true` re-enables and recomputes nextRunAt. */
export type UpdateAutomationRequest = Partial<Omit<CreateAutomationRequest, "spaceId" | "projectId">>;
export interface PreviewNextRunsRequest {
	trigger: AutomationTrigger;
	timezone: string;
	/** ISO; default now */
	from?: string;
	/** 1..50, default 5 */
	count?: number;
}
export interface RunNowResponse {
	runId: string;
	run: AutomationRunDTO;
}
export interface CreateNotifyChannelRequest {
	kind: "webhook" | "email";
	name: string;
	target: string;
	/** HMAC signing secret (webhook); requires WORKROOM_SECRET_KEY */
	secret?: string;
	/** org-wide channel; admins only */
	shared?: boolean;
}
export interface WebhookAllowlistDTO {
	entries: string[];
	instance: string[];
}

// ---------------------------------------------------------------- analytics dashboard (round 4, stats group)
// GET /stats/scopes, GET /stats/overview, GET /stats/export.csv. Every number is derived from stored records
// (usage_ledger, tool/file/knowledge/automation tables); see docs/stats.md for the exact definitions.
export type StatsGranularity = "hour" | "day" | "week";
export type StatsScopeKey = string; // "personal" | "org" | "project:<id>" | "department:<id>"

export interface StatsScopeOption {
	key: StatsScopeKey;
	kind: "personal" | "org" | "project" | "department";
	label: string;
}
export interface StatsScopesDTO {
	orgId: string;
	orgName: string;
	/** True when the viewer's org is a flagged demo org: all numbers are synthetic and must carry a banner. */
	demo: boolean;
	scopes: StatsScopeOption[];
	/** Charts whose CSV the viewer may export (same permission as viewing the scope, plus optional authz `stats.export`). */
	exportable: boolean;
}

export type StatsKpiKey =
	| "conversations"
	| "runs"
	| "modelRequests"
	| "toolCalls"
	| "filesProduced"
	| "knowledgeSearches"
	| "automationRuns"
	| "successRate"
	| "latencyP50"
	| "latencyP95"
	| "inputTokens"
	| "outputTokens"
	| "cacheTokens"
	| "cost";

export interface StatsKpiDTO {
	key: StatsKpiKey;
	/** null = no data in the period (never a made-up zero for rates / latency). */
	value: number | null;
	/** Same metric over the immediately preceding period of equal length; null when there is no previous period or no data. */
	previous: number | null;
	/** value - previous (percentage points for successRate); null when either side is null. */
	delta: number | null;
	/** (value - previous) / previous; null when previous is 0/null and for successRate. */
	deltaPct: number | null;
	/** One point per bucket of `series.buckets` (null = no data in that bucket). */
	spark: (number | null)[];
	/** Tokens/cost: how much came from simulated (fixture / test-model) usage; those never count into `value`. */
	simulatedValue?: number;
}

export interface StatsSeriesItemDTO {
	key: string;
	label: string;
	/** Every request of this item came from a simulated (fixture) model. */
	simulated: boolean;
	requests: number[];
	/** Real + simulated tokens per bucket (simulated part also in `simulatedTokens`). */
	tokens: number[];
	simulatedTokens: number[];
	totalRequests: number;
	totalTokens: number;
	totalSimulatedTokens: number;
	/** Failed (non-success) requests in the period. */
	failedRequests: number;
}

export interface StatsOutcomeBreakdownDTO {
	tasks: OutcomeCounts;
	runs: OutcomeCounts;
	modelRequests: OutcomeCounts;
	toolCalls: OutcomeCounts;
}

export interface StatsToolRowDTO {
	tool: string;
	calls: number;
	errors: number;
	errorRate: number;
	avgDurationMs: number | null;
}

export interface StatsTopRowDTO {
	id: string;
	name: string;
	runs: number;
	modelRequests: number;
	toolCalls: number;
	tokens: number;
	simulatedTokens: number;
	failedRuns: number;
	cost: number;
}

export interface StatsConversationRowDTO {
	spaceId: string;
	conversationId: number;
	/** null when the viewer may not read the conversation (title is not disclosed) or it is demo data. */
	title: string | null;
	userName: string | null;
	projectId?: string;
	projectName?: string;
	runs: number;
	modelRequests: number;
	failedRuns: number;
	tokens: number;
	simulated: boolean;
	lastAt: string;
	/** In-app link, only when the viewer may open the conversation and it exists (never for demo backfill). */
	link: string | null;
}

export interface StatsOverviewDTO {
	generatedAt: string;
	scope: StatsScopeKey;
	scopeLabel: string;
	orgName: string;
	demo: boolean;
	range: { from: string; to: string };
	previous: { from: string; to: string };
	granularity: StatsGranularity;
	/** Differs from `granularity` when the requested one would create too many buckets (hour > 14 days, day > 400 days). */
	requestedGranularity: StatsGranularity;
	tzOffsetMinutes: number;
	kpis: StatsKpiDTO[];
	simulation: {
		/** model requests by simulated (fixture/test-model) vs real models in the period. */
		simulatedRequests: number;
		realRequests: number;
		onlySimulated: boolean;
		simulatedTokens: TokenTotals;
	};
	/** Always the 365 local days ending with the day of `range.to`, independent of the range filter. */
	calendar: { from: string; to: string; days: { day: string; runs: number; modelRequests: number; toolCalls: number; tokens: number; failedRuns: number }[] };
	/** weekday (0 = Monday … 6 = Sunday) × local hour, within the selected range. */
	punchCard: { cells: { weekday: number; hour: number; runs: number; modelRequests: number; toolCalls: number; tokens: number }[] };
	series: {
		buckets: string[];
		model: StatsSeriesItemDTO[];
		provider: StatsSeriesItemDTO[];
		route: StatsSeriesItemDTO[];
	};
	outcomes: StatsOutcomeBreakdownDTO;
	tools: StatsToolRowDTO[];
	latency: { count: number; source: "real" | "simulated" | "none"; p50: number | null; p90: number | null; p95: number | null; p99: number | null; max: number | null; avg: number | null; buckets: { le: number | null; count: number }[] };
	topUsers: StatsTopRowDTO[];
	topProjects: StatsTopRowDTO[];
	conversations: StatsConversationRowDTO[];
	recentFailures: { at: string; spaceId: string; conversationId: number; outcome: Outcome; errorClass?: string; model?: string; title: string | null; link: string | null; simulated: boolean }[];
	largeContext: StatsDTO["largeContext"];
	knowledge: { searches: number; withHits: number; noEvidence: number; otherEmpty: number; hitRate: number | null; noEvidenceRate: number | null; avgLatencyMs: number | null; byReason: Record<string, number>; bySource: Record<string, number>; spark: { searches: number; noEvidence: number }[] };
	automation: { total: number; byStatus: Record<string, number> };
	files: { versions: number; byOrigin: Record<string, number> };
	/** Why a section may be empty, in Chinese, for the empty states. */
	notes: string[];
}

export type StatsExportChart = "kpis" | "calendar" | "punchcard" | "series-model" | "series-provider" | "series-route" | "outcomes" | "tools" | "latency" | "top-users" | "top-projects" | "conversations" | "knowledge";
