// Round 7b contract (integrator-owned): persistent workspaces, sandbox environment variables, credentials.
// Layers are distinct and must never be conflated in UI or docs:
//   conversation/orchestration checkpoints (pi-durable) ≠ workspace file versions (this file) ≠ sandbox memory/process snapshots
//   (provider feature, not used unless declared + verified). pi-durable never restores sandbox files or processes.

// ───────────────────────────── 1. persistent workspace (versions of /work) ─────────────────────────────
export type WorkspaceSaveState =
	| "saved" // working copy equals the head version
	| "dirty" // working copy has changes not yet committed
	| "saving"
	| "failed" // last commit failed; working copy kept, NOT eligible for cleanup
	| "conflict" // a commit found a newer head than its base; nothing overwritten
	| "restoring"
	| "restored"; // working copy was rebuilt from a version and verified

export interface WorkspaceSaveStatusDTO {
	readonly spaceId: string;
	/** "c<conversationId>" or "shared". */
	readonly workspaceKey: string;
	readonly state: WorkspaceSaveState;
	readonly headVersion: number | null;
	readonly lastSavedAt?: string;
	readonly lastAttemptAt?: string;
	/** Plain reason of the last failure / conflict. */
	readonly failure?: string;
	/** Paths changed since the head version (capped list) and total count. */
	readonly unsynced: { readonly count: number; readonly paths: readonly string[] };
	/** Paths excluded by policy (caches, temp) — informational. */
	readonly excludedPatterns: readonly string[];
	readonly restore?: { readonly fromVersion: number; readonly at: string; readonly verified: boolean; readonly conflicts: readonly string[] };
	/** Honest loss window statement for the active driver (e.g. "运行中的命令结束前，其在远程沙箱中的改动尚未保存"). */
	readonly lossWindow: string;
}

export interface WorkspaceVersionDTO {
	readonly version: number;
	readonly createdAt: string;
	readonly createdBy: string;
	/** Why: "run_end" | "before_publish" | "turn_end" | "periodic" | "manual" | "restore". */
	readonly reason: string;
	readonly fileCount: number;
	readonly totalBytes: number;
	readonly manifestSha256: string;
}

/** Org policy (sandbox.policy.manage). */
export interface WorkspacePersistPolicyDTO {
	/** Glob-ish patterns (relative to /work) never saved: dependency caches, temp files. */
	readonly exclude: readonly string[];
	readonly maxFileBytes: number;
	readonly maxFiles: number;
	readonly maxTotalBytes: number;
	/** Keep at most N versions per workspace (older ones pruned; the head and the last restore source are never pruned). */
	readonly keepVersions: number;
	/** Working copies idle longer than this are removed ONLY when state is "saved" (head committed). */
	readonly workingCopyRetentionHours: number;
	/** Periodic sync for long-running jobs (supplement only). 0 = off. */
	readonly periodicSyncSec: number;
}

// ───────────────────────────── 2. sandbox environment variables (non-secret) ─────────────────────────────
export type EnvScope = "org" | "project" | "user" | "conversation";

export interface EnvVarDTO {
	readonly id: string;
	readonly scope: EnvScope;
	/** org id / project id / user id / "<spaceId>:<conversationId>". */
	readonly scopeRef: string;
	readonly name: string;
	readonly value: string;
	/** Org-level only: lower scopes may not override this name. */
	readonly locked: boolean;
	readonly updatedBy: string;
	readonly updatedAt: string;
}

export interface EffectiveEnvDTO {
	/** Final variables a NEW command in this conversation gets (name → value + which scope won). */
	readonly vars: readonly { readonly name: string; readonly value: string; readonly from: EnvScope; readonly overridden: readonly EnvScope[] }[];
	/** Always true: changes apply to commands started after the change; running processes / existing services keep their environment. */
	readonly appliesToNewCommandsOnly: true;
	readonly denied: readonly { readonly name: string; readonly reason: string }[];
}

// ───────────────────────────── 3. credentials ─────────────────────────────
export type CredentialUsage = "proxy" | "env";
export type CredentialScope = "user" | "project" | "org";

/** What the agent asks for (tool `credential_request`). Never contains a secret. */
export interface CredentialRequestDTO {
	readonly id: string;
	readonly service: string;
	readonly purpose: string;
	/** Hosts the credential may be sent to (proxy), e.g. ["api.github.com"]. Exact hosts, no wildcards beyond a single leading "*.". */
	readonly targetHosts: readonly string[];
	/** HTTP methods allowed through the proxy (default ["GET"]). */
	readonly methods: readonly string[];
	/** How the secret is applied by the proxy: header name and a template containing {secret}. */
	readonly inject: { readonly header: string; readonly template: string };
	/** "proxy" (default, secret stays server-side) or "env" (needs extra explicit consent, see envConsentText). */
	readonly usage: CredentialUsage;
	/** For usage "env": the variable name the restricted process receives. */
	readonly envName?: string;
	readonly ttlSec: number;
	readonly status: "pending" | "fulfilled" | "declined" | "cancelled" | "expired" | "revoked";
	readonly conversationId: number;
	readonly spaceId: string;
	readonly requestedFor: string;
	readonly createdAt: string;
	readonly expiresAt: string;
	/** Set when fulfilled: the stored credential's id (metadata only). */
	readonly credentialId?: string;
	/** Honest warning shown when usage is "env". */
	readonly envConsentText?: string;
}

/** POST /api/credential-requests/:id/fulfill (TLS, same-origin, CSRF-protected session). Body is never logged. */
export interface CredentialFulfillRequest {
	readonly secret: string;
	/** "once": usable for this request's TTL only, not saved; "save": stored (encrypted) for later reuse in `scope`. */
	readonly persist: "once" | "save";
	readonly scope?: CredentialScope;
	/** Required true when usage is "env". */
	readonly envConsent?: boolean;
	/** Idempotency: the form's nonce issued with the request (single use). */
	readonly nonce: string;
}

/** Metadata only. There is NO API that returns a plaintext secret. */
export interface CredentialDTO {
	readonly id: string;
	readonly name: string;
	readonly scope: CredentialScope;
	readonly scopeRef: string;
	readonly ownerId: string;
	readonly targetHosts: readonly string[];
	readonly methods: readonly string[];
	readonly usage: CredentialUsage;
	readonly createdAt: string;
	readonly expiresAt?: string;
	readonly revokedAt?: string;
	readonly version: number;
	readonly lastUsedAt?: string;
	/** e.g. "••••1234" — only when the owner chose to show a hint. */
	readonly hint?: string;
}

/** What `credential_request` / the proxy tool return to the model: status only. */
export interface CredentialStatusForModel {
	readonly requestId: string;
	readonly status: CredentialRequestDTO["status"];
	readonly credentialId?: string;
	readonly message: string;
}
