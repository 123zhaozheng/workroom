// Real API calls behind the sidebar menus (shared/round9.ts). Every function throws ApiError; callers show errorText().
import type { ConversationSummary } from "@shared/chat";
import type { DirectoryUserDTO, ProjectShareDTO } from "@shared/round9";
import { del, get, patch, post, put, qs } from "@/lib/api";
import { normalizeProject, notifyConversations, notifyProjects, type ConvRef, type UiProject } from "./model";

const conv = (c: ConvRef) => `/conversations/${c.spaceId}/${c.conversationId}`;
const done = <T>(v: T): T => {
	notifyConversations();
	return v;
};

export const starConversation = (c: ConvRef, starred: boolean) => put<{ ok?: boolean }>(`${conv(c)}/star`, { starred }).then(done);
export const setConversationTags = (c: ConvRef, tags: string[]) => put<{ ok?: boolean; tags?: string[] }>(`${conv(c)}/tags`, { tags }).then(done);
export const renameConversation = (c: ConvRef, title: string) => patch<{ conversation: ConversationSummary }>(conv(c), { title }).then(done);
export const archiveConversation = (c: ConvRef, archived: boolean) => patch<{ conversation: ConversationSummary }>(conv(c), { archived }).then(done);
export const deleteConversation = (c: ConvRef) => del<{ ok: boolean }>(conv(c)).then(done);
export const moveConversation = (c: ConvRef, projectId: string | null) => put<{ conversation: ConversationSummary }>(`${conv(c)}/project`, { projectId }).then((r) => (notifyProjects(), done(r)));

/** Markdown export: the server answers a text/markdown attachment; the browser gets it as a download. */
export async function exportConversation(c: ConvRef, title: string): Promise<void> {
	const text = await get<string>(`${conv(c)}/export${qs({ format: "md" })}`);
	const name = `${(title || "对话").replace(/[\\/:*?"<>|\n\r]+/g, " ").trim().slice(0, 80) || "对话"}.md`;
	const url = URL.createObjectURL(new Blob([typeof text === "string" ? text : JSON.stringify(text, null, 2)], { type: "text/markdown;charset=utf-8" }));
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	document.body.appendChild(a); // some browsers ignore the download name on a detached anchor
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function startConversationIn(projectId: string): Promise<ConversationSummary> {
	const r = await post<{ conversation: ConversationSummary }>("/conversations", { projectId });
	notifyConversations();
	notifyProjects();
	return r.conversation;
}

export const createProject = (name: string) => post<{ project: unknown }>("/projects", { name }).then((r) => (notifyProjects(), normalizeProject(r.project)));
export const renameProject = (id: string, name: string) => patch<{ project: unknown }>(`/projects/${id}`, { name }).then((r) => (notifyProjects(), normalizeProject(r.project)));
export const deleteProject = (id: string) => del<{ ok: boolean; detached?: number }>(`/projects/${id}`).then((r) => (notifyProjects(), notifyConversations(), r));

export const listShares = (id: string) => get<{ shares: ProjectShareDTO[] }>(`/projects/${id}/shares`).then((r) => r.shares);
export const addShare = (id: string, userId: string) => put<{ share: ProjectShareDTO }>(`/projects/${id}/shares/${userId}`, { permission: "read" }).then((r) => (notifyProjects(), r.share));
export const revokeShare = (id: string, userId: string) => del<{ ok: boolean }>(`/projects/${id}/shares/${userId}`).then((r) => (notifyProjects(), r));
export const searchDirectory = (q: string, signal?: AbortSignal) => get<{ users: DirectoryUserDTO[] }>(`/directory${qs({ q })}`, signal).then((r) => r.users);

export type { UiProject };
