// Round 6 contract (integrator-owned): skills created in conversation, plus on-demand skill tools.
// The backend (server/src/tools/skill-drafts.ts) produces these. The chat UI renders them: an approval whose
// `detail.kind === "skill_draft"` is a skill draft card.

export interface SkillDraftFileDTO {
	/** Path relative to the package root, e.g. "SKILL.md", "scripts/run.py". */
	readonly path: string;
	readonly size: number;
	readonly sha256: string;
	/** True for files the sandbox may execute (scripts/ or .py/.sh/.mjs/.js). */
	readonly executable: boolean;
}

export interface SkillDraftFindingDTO {
	readonly severity: "info" | "warn" | "error";
	readonly code: string;
	readonly message: string;
}

/**
 * What approving does, resolved by the server BEFORE the approval is requested (so a predictable failure never reaches the user after
 * they said yes): a new personal skill, or a new version of an existing skill the user may write (their own personal skill, or a
 * market/org skill they are author/admin of).
 */
export interface SkillDraftTarget {
	readonly mode: "new" | "update";
	/** update: the skill that gets the new version. */
	readonly skillId?: string;
	/** update: display name of that skill. */
	readonly skillName?: string;
	/** "personal": the user's own personal skill (or a new one); "market": a distributed (org / department / project) skill. */
	readonly scope: "personal" | "market";
	readonly marketScope?: "org" | "department" | "project";
	/** update: the highest existing version of the skill (the new one must be greater). */
	readonly fromVersion?: string;
	readonly toVersion: string;
	/** True when the new version is not usable before a review (org policy for personal skills; always for market skills). */
	readonly reviewRequired: boolean;
	/** One short line for the approval card, e.g. 「更新市场技能「weekly-report」：v1.0.0 → v1.1.0；提交审核，通过前仍用旧版本」. */
	readonly text: string;
}

/**
 * `ApprovalDTO.detail` of the approval a `skill_manage` submit_draft call opens. The snapshot is fixed at submit time:
 * later edits in the workspace do not change what is approved.
 */
export interface SkillDraftApprovalDetail {
	readonly kind: "skill_draft";
	readonly draftId: string;
	/** Manifest `name` (slug), e.g. "weekly-report". */
	readonly name: string;
	/** Display title (manifest title, else name). */
	readonly title: string;
	/** What the skill is for (manifest description). */
	readonly description: string;
	/** Manifest semver. */
	readonly version: string;
	readonly skillKind: string;
	readonly files: readonly SkillDraftFileDTO[];
	readonly totalBytes: number;
	readonly packageSha256: string;
	readonly requiredPermissions: readonly string[];
	readonly requiredTools: readonly string[];
	/** Static-check findings (secrets, scripts, network use…). An error finding means it cannot be saved. */
	readonly findings: readonly SkillDraftFindingDTO[];
	/** What approving does (new personal skill vs a new version of an existing one). Absent on drafts created before this field existed. */
	readonly target?: SkillDraftTarget;
	/** Set when approving adds a new version of an existing skill (personal or market); kept for older readers, see `target`. */
	readonly updatesSkill?: { readonly id: string; readonly name: string; readonly fromVersion?: string };
	/** Directory the agent submitted, relative to the conversation workspace (/work). */
	readonly sourceDir: string;
}

export type SkillDraftState = "pending" | "saved" | "rejected" | "failed";

export interface SkillDraftDTO {
	readonly id: string;
	readonly state: SkillDraftState;
	readonly detail: SkillDraftApprovalDetail;
	readonly spaceId: string;
	readonly conversationId: number;
	readonly createdAt: string;
	readonly decidedAt?: string;
	/** Set when saved. */
	readonly skillId?: string;
	readonly versionNo?: number;
	readonly error?: string;
}
