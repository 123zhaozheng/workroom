// Round 9 front-end model for the sidebar tree, the project page and the conversation menu.
// Contract: shared/round9.ts. Older servers answer GET /projects with the pre-round-9 shape (role / spaceId, no kind / access); normalise() maps it
// to a legacy "space" project so the UI keeps working against either.
import type { ConversationSummary } from "@shared/chat";
import type { ConversationMetaDTO, ProjectDTO } from "@shared/round9";
import type { ProjectRole } from "@/lib/types";

/** A project as the UI uses it: the contract DTO plus what legacy projects still carry. */
export interface UiProject extends ProjectDTO {
	/** Legacy projects: the caller's role (owner / editor / viewer). */
	readonly role?: ProjectRole;
	readonly description?: string;
}

export function normalizeProject(raw: unknown): UiProject {
	const r = raw as Partial<UiProject> & { id: string; name: string };
	const kind = r.kind ?? "space";
	return {
		id: r.id,
		name: r.name,
		kind,
		spaceId: r.spaceId,
		ownerId: r.ownerId ?? "",
		ownerName: r.ownerName,
		access: r.access ?? (kind === "container" ? "owner" : "member"),
		shared: r.shared ?? false,
		conversationCount: r.conversationCount ?? 0,
		createdAt: r.createdAt ?? "",
		updatedAt: r.updatedAt ?? r.createdAt ?? "",
		role: r.role,
		description: r.description,
	};
}

export const isContainer = (p: Pick<UiProject, "kind">) => p.kind === "container";
export const isSharedToMe = (p: Pick<UiProject, "access">) => p.access === "shared_read";
export const isLegacy = (p: Pick<UiProject, "kind">) => p.kind === "space";
/** Container projects the caller owns: the only ones a conversation can be moved into and the only ones that can be shared. */
export const isOwnContainer = (p: UiProject) => isContainer(p) && p.access === "owner";
/** May start a new conversation in the project. */
export const canStartIn = (p: UiProject) => (isContainer(p) ? p.access === "owner" : p.role !== "viewer");

export interface ConvRef {
	readonly spaceId: string;
	readonly conversationId: number;
}
export const convKey = (c: ConvRef) => `${c.spaceId}/${c.conversationId}`;
export const convPath = (c: ConvRef, entryId?: number) => `/c/${c.spaceId}/${c.conversationId}${entryId ? `?entry=${entryId}` : ""}`;

export interface ConvMeta {
	readonly starred: boolean;
	readonly tags: readonly string[];
}
export const NO_META: ConvMeta = { starred: false, tags: [] };
export function metaMap(items: readonly ConversationMetaDTO[] | undefined): Map<string, ConvMeta> {
	const m = new Map<string, ConvMeta>();
	for (const i of items ?? []) m.set(convKey(i), { starred: i.starred, tags: i.tags });
	return m;
}

/** What the caller may do with one conversation (the server enforces every rule again). */
export interface ConvPerms {
	readonly write: boolean;
	readonly move: boolean;
	/** Reason the move entry is disabled, when it is shown but not usable. */
	readonly moveBlocked?: string;
	readonly del: boolean;
	readonly share: boolean;
}
export function convPerms(c: ConversationSummary, project: UiProject | undefined, meId: string | undefined): ConvPerms {
	// ConversationSummary.access (round 9) says how the caller reaches it; the project list is the fallback for older servers.
	const shared = c.access === "shared" || (!!project && isSharedToMe(project));
	const legacy = c.access === "member" || (!!project && isLegacy(project));
	const viewer = legacy && project?.role === "viewer";
	const write = !shared && !viewer && c.kind !== "subagent";
	const own = !!meId && c.createdBy === meId;
	return {
		write,
		move: write && own,
		moveBlocked: legacy ? "旧版项目中的对话不能移动" : write && !own ? "只有创建者可以移动" : undefined,
		del: !shared && !viewer && (own || (legacy && project?.role === "owner")),
		share: write,
	};
}

export const TAG_MAX = 24;
export const TAGS_MAX = 8;
export function cleanTags(tags: readonly string[]): string[] {
	const out: string[] = [];
	for (const t of tags) {
		const v = t.trim().slice(0, TAG_MAX);
		if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
	}
	return out.slice(0, TAGS_MAX);
}

/** The sidebar's own refresh signals (the chat page already fires wr:conversations-changed). */
export const CONV_EVENT = "wr:conversations-changed";
export const PROJECT_EVENT = "wr:projects-changed";
export const notifyConversations = () => window.dispatchEvent(new Event(CONV_EVENT));
export const notifyProjects = () => window.dispatchEvent(new Event(PROJECT_EVENT));
