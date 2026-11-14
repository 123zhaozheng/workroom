// Experts (round 17): the former 「助手」, shown in the 专家 page, mentionable with @ in a conversation.
// Skills / connectors are attached BY ID (never a snapshot): the runtime resolves each skill's current published version on every run.
import type { AvatarConfig } from "./bot-avatar/config.ts";

export type ExpertScope = "personal" | "department" | "org";
export type ExpertStatus = "draft" | "pending" | "published" | "unpublished";
export type ExpertSkillState = "ok" | "missing" | "forbidden" | "unlisted" | "unapproved" | "disabled" | "no_permission";

export const EXPERT_CATEGORIES = ["办公效率", "研发", "数据分析", "写作", "设计", "运营", "法务财务", "通用"] as const;

export interface ExpertModelRef {
	readonly provider: string;
	readonly modelId: string;
}
/** The editable configuration (also what an immutable version snapshots). Skills are references only. */
export interface ExpertConfigDTO {
	readonly name: string;
	/** Legacy text avatar (old 助手); no longer drawn — see avatarConfig. */
	readonly avatar?: string;
	/** The expert's bot avatar (shape / colors / eyes as JSON, see shared/bot-avatar/config.ts). Missing in old snapshots: the id's default look applies. */
	readonly avatarConfig?: AvatarConfig;
	readonly tagline: string;
	readonly description: string;
	readonly category: string;
	readonly tags: readonly string[];
	readonly instructions: string;
	readonly opening: string;
	readonly starters: readonly string[];
	/** null = follow the conversation's model. */
	readonly defaultModel: ExpertModelRef | null;
	readonly skills: readonly { readonly skillId: string }[];
	readonly connectors: readonly { readonly connectorId: string }[];
	readonly knowledge: { readonly kbIds: readonly string[] } | null;
	/** null = default tool set; a list = exactly those tools. */
	readonly tools: readonly string[] | null;
}
/** A mounted skill as it resolves RIGHT NOW for the viewer. */
export interface ExpertSkillDTO {
	readonly skillId: string;
	readonly name: string;
	readonly slug?: string;
	readonly description?: string;
	readonly versionNo?: number;
	readonly semver?: string;
	readonly state: ExpertSkillState;
	readonly message?: string;
}
export interface ExpertDTO {
	readonly id: string;
	readonly name: string;
	readonly avatar?: string;
	/** Always present in API responses (stored value, or the id's stable default for legacy rows). */
	readonly avatarConfig?: AvatarConfig;
	readonly tagline: string;
	readonly description: string;
	readonly category: string;
	readonly tags: readonly string[];
	/** Only for the author (the system prompt of the expert). */
	readonly instructions?: string;
	readonly opening: string;
	readonly starters: readonly string[];
	readonly defaultModel: ExpertModelRef | null;
	readonly modelAvailability?: { readonly status: "ok" | "not_allowed" | "blocked"; readonly reason?: string };
	readonly skills: readonly ExpertSkillDTO[];
	readonly connectors: readonly { readonly connectorId: string; readonly name?: string }[];
	readonly knowledge: { readonly kbIds: readonly string[] } | null;
	readonly tools: readonly string[] | null;
	readonly scope: ExpertScope;
	readonly scopeRef?: string;
	readonly status: ExpertStatus;
	/** Published and a newer submission is waiting for review (others keep using the published version). */
	readonly updatePending?: boolean;
	/** The author's draft differs from the published version. */
	readonly dirty?: boolean;
	readonly publishedVersionNo?: number;
	readonly unpublishedReason?: string;
	readonly source: "user" | "assistant";
	readonly ownerId: string;
	readonly ownerName?: string;
	readonly mine: boolean;
	readonly installed: boolean;
	readonly canEdit: boolean;
	readonly createdAt: string;
	readonly updatedAt: string;
}
/** What the @ popup and the composer need. */
export interface MentionableExpertDTO {
	readonly id: string;
	readonly name: string;
	readonly avatar?: string;
	readonly avatarConfig?: AvatarConfig;
	readonly tagline: string;
	readonly category: string;
	readonly defaultModel: ExpertModelRef | null;
	readonly mine: boolean;
	readonly installed: boolean;
	readonly status: ExpertStatus;
}
/** The expert bound to / current in a conversation (agent DTO). */
export interface ConversationExpertDTO {
	readonly boundId?: string;
	readonly boundName?: string;
	readonly boundAvatar?: string;
	readonly boundAvatarConfig?: AvatarConfig;
	/** The user chose a model explicitly in this conversation: an expert's default model never overrides it. */
	readonly modelExplicit: boolean;
}
/** The review screen of an expert submission. */
export interface ExpertSubmissionInfoDTO {
	readonly config: ExpertConfigDTO;
	readonly skills: readonly ExpertSkillDTO[];
	readonly previousVersionNo?: number;
}
