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
	/** Set when approving adds a new version of the user's own existing personal skill. */
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
