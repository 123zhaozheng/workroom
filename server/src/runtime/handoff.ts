// Handoff views (M09-B): what a member taking over needs to know — decisions, progress, pending items, deliverables,
// participants. Everything is derived on read from pi-durable state (entries, submissions, pi.live, pi.inbox and the
// wr.* documents) plus the files service; there is no handoff table. ACL = the caller's CURRENT access.
import type { Context } from "@earendil-works/chord/context";
import { InboxDoc, LiveDoc, type Cursor, type EntryRecord, type Harness } from "@earendil-works/pi-durable";
import type { Principal } from "../core/contracts.ts";
import { HttpError, nowIso } from "../core/http.ts";
import type { ApprovalDTO, AssistantEntryDTO, ConversationHandoff, EffectDTO, HandoffDeliverable, HandoffParticipant, HandoffRun, ProjectHandoff, ProjectHandoffConversation, RunStatus, UserEntryDTO } from "../../../shared/chat.ts";
import { liveDTO, queueDTO } from "./dto.ts";
import { cid, type CatalogRow, type Runtime } from "./service.ts";

const MAX_ENTRIES = 2000;
const excerpt = (t: string | undefined, n = 300) => (t ? (t.length > n ? `${t.slice(0, n - 1)}…` : t) : undefined);

type FilesLike = {
	list?(p: Principal, opts: { spaceId?: string; projectId?: string; conversationId?: number; limit?: number }): Promise<{ id: string }[]>;
	detail?(p: Principal, fileId: string): Promise<{ file: { id: string; name: string }; versions: { versionId: string; versionNo: number; name: string; mime: string; createdAt: string; createdBy: string; provenance?: { conversationId?: number; spaceId?: string }; downloadUrl?: string; previewUrl?: string }[] }>;
};

export class Handoff {
	readonly #rt: Runtime;
	constructor(rt: Runtime) {
		this.#rt = rt;
	}

	#files(): FilesLike | undefined {
		const s = this.#rt.ctx.services;
		return s.has("files") ? (s.get("files") as unknown as FilesLike) : undefined;
	}

	#role(userId: string, projectId: string | undefined, ownerUserId: string | undefined): HandoffParticipant["role"] {
		if (!projectId) return userId === ownerUserId ? "owner" : null;
		const r = this.#rt.ctx.db.get<{ role: string }>("SELECT pm.role FROM id_project_members pm JOIN id_projects p ON p.id = pm.project_id WHERE pm.project_id = ? AND pm.user_id = ? AND pm.removed_at IS NULL AND p.archived_at IS NULL", projectId, userId);
		return (r?.role as HandoffParticipant["role"]) ?? null;
	}

	/** File versions of `spaceId` whose provenance names `conversationId` (or every file of the project when omitted). */
	async deliverables(p: Principal, opts: { spaceId?: string; projectId?: string; conversationId?: number }): Promise<{ items: HandoffDeliverable[]; unavailable?: string }> {
		const files = this.#files();
		if (!files?.list || !files.detail) return { items: [], unavailable: "files service not loaded" };
		const list = await files.list(p, { ...opts, limit: 100 });
		const out: HandoffDeliverable[] = [];
		for (const f of list) {
			const d = await files.detail(p, f.id).catch(() => undefined);
			for (const v of d?.versions ?? []) {
				if (opts.conversationId !== undefined && v.provenance?.conversationId !== opts.conversationId) continue;
				out.push({
					fileId: f.id,
					versionId: v.versionId,
					versionNo: v.versionNo,
					name: v.name,
					mime: v.mime,
					createdAt: v.createdAt,
					createdBy: v.createdBy,
					createdByName: this.#rt.userName(v.createdBy),
					...(v.provenance?.conversationId !== undefined ? { conversationId: v.provenance.conversationId } : {}),
					...(v.downloadUrl ? { downloadUrl: v.downloadUrl } : {}),
					...(v.previewUrl ? { previewUrl: v.previewUrl } : {}),
				});
			}
		}
		out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		return { items: out };
	}

	async #allEntries(harness: Harness, conversationId: number, context: Context): Promise<EntryRecord[]> {
		const conv = (await harness.conversation(cid(conversationId), context))!;
		const out: EntryRecord[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await conv.entries({ order: "ascending" }, 200, cursor, context);
			out.push(...page.items);
			cursor = page.next;
		} while (cursor && out.length < MAX_ENTRIES);
		return out;
	}

	async conversation(p: Principal, spaceId: string, conversationId: number, context: Context): Promise<ConversationHandoff> {
		const { harness, conv, row, record } = await this.#rt.access(p, "read", spaceId, conversationId, context);
		const space = this.#rt.manager.space(spaceId);
		const dtos = await this.#rt.toDTOs(harness, await this.#allEntries(harness, conversationId, context), context);
		const byId = new Map(dtos.map((d) => [d.id, d]));
		const { approvals, effects, subagents } = await this.#rt.docs(harness, conversationId, context);
		const live = await harness.snapshot(LiveDoc, conv.id, context);
		const inbox = await harness.snapshot(InboxDoc, conv.id, context);
		const hasAnswer = dtos.some((d) => d.kind === "assistant");
		const status: RunStatus = liveDTO(live, approvals, hasAnswer).status;

		const runs: HandoffRun[] = [];
		const counts = new Map<string, { messages: number; decisions: number }>();
		const bump = (u: string, k: "messages" | "decisions") => {
			const c = counts.get(u) ?? { messages: 0, decisions: 0 };
			c[k]++;
			counts.set(u, c);
		};
		for (const d of dtos) {
			if (d.kind !== "user") continue;
			const u = d as UserEntryDTO;
			if (u.userId) bump(u.userId, "messages");
			const answer = u.submission?.answerEntryId !== undefined ? (byId.get(u.submission.answerEntryId) as AssistantEntryDTO | undefined) : undefined;
			runs.push({
				...(u.submission ? { submissionId: u.submission.submissionId, status: u.submission.status, ...(u.submission.reason ? { reason: u.submission.reason } : {}) } : {}),
				entryId: u.id,
				...(u.userId ? { requestedBy: u.userId, requestedByName: u.authorName } : {}),
				text: excerpt(u.text, 500)!,
				...(answer ? { answerExcerpt: excerpt(answer.text) } : {}),
				...(u.via ? { via: u.via } : {}),
				...(u.placed === false ? { placed: false } : {}),
			});
		}
		const decisions = approvals
			.filter((a) => a.status !== "pending")
			.map((a) => {
				if (a.decidedBy) bump(a.decidedBy, "decisions");
				return { approvalId: a.approvalId, conversationId: a.conversationId, title: a.title, summary: a.summary, ...(a.toolName ? { toolName: a.toolName } : {}), decision: a.status as "approved" | "rejected", decidedBy: a.decidedBy ?? "", decidedByName: a.decidedBy ? this.#rt.userName(a.decidedBy) : undefined, decidedAt: a.decidedAt ?? "", ...(a.note ? { note: a.note } : {}) };
			});
		// participants: everyone who wrote or decided here, plus the space's current members
		const ids = new Set(counts.keys());
		if (row?.created_by) ids.add(row.created_by);
		if (space.projectId) for (const m of this.#rt.ctx.db.all<{ user_id: string }>("SELECT user_id FROM id_project_members WHERE project_id = ? AND removed_at IS NULL", space.projectId)) ids.add(m.user_id);
		const participants: HandoffParticipant[] = [...ids].map((u) => ({ userId: u, name: this.#rt.userName(u), role: this.#role(u, space.projectId, space.ownerUserId), messages: counts.get(u)?.messages ?? 0, decisions: counts.get(u)?.decisions ?? 0 }));
		const lastAnswer = [...dtos].reverse().find((d) => d.kind === "assistant" && (d as AssistantEntryDTO).stopReason === "stop") as AssistantEntryDTO | undefined;
		const del = await this.deliverables(p, { spaceId, conversationId });
		const w = await this.#rt.acl.check(p, "write", { kind: "conversation", id: String(conversationId), spaceId });
		return {
			conversation: this.#rt.summary(spaceId, conversationId, row, record, status),
			status,
			generatedAt: nowIso(),
			decisions,
			runs,
			pending: {
				approvals: approvals.filter((a) => a.status === "pending"),
				effects: effects.filter((e) => e.status === "needs_reconciliation"),
				queued: queueDTO(inbox),
				...(!live?.run && live?.runFailure ? { continuable: { reason: live.runFailure.reason, ...(live.runFailure.detail ? { detail: live.runFailure.detail } : {}) } } : {}),
				runningSubagents: subagents.filter((s) => s.status === "running"),
			},
			deliverables: del.items,
			...(del.unavailable ? { deliverablesUnavailable: del.unavailable } : {}),
			participants,
			subagents,
			...(lastAnswer ? { lastAnswer: excerpt(lastAnswer.text, 1000) } : {}),
			access: { canWrite: w.allow, reason: w.reason },
		};
	}

	async project(p: Principal, projectId: string, context: Context): Promise<ProjectHandoff> {
		const acl = this.#rt.acl;
		await acl.require(p, "read", { kind: "project", id: projectId });
		const space = this.#rt.ctx.services.get("identity").projectSpace(projectId);
		const pr = this.#rt.ctx.db.get<{ id: string; name: string; description: string }>("SELECT id, name, description FROM id_projects WHERE id = ?", projectId);
		if (!space || !pr) throw new HttpError(404, "project_not_found", "项目不存在");
		const harness = await this.#rt.manager.get(space.id);
		const rows = this.#rt.ctx.db.all<CatalogRow>("SELECT * FROM rt_conversations WHERE space_id = ? AND archived = 0 ORDER BY updated_at DESC LIMIT 200", space.id);
		const del = await this.deliverables(p, { projectId });
		const conversations: ProjectHandoffConversation[] = [];
		for (const r of rows) {
			const id = cid(r.conversation_id);
			const [live, inbox] = await Promise.all([harness.snapshot(LiveDoc, id, context), harness.snapshot(InboxDoc, id, context)]);
			const { approvals, effects } = await this.#rt.docs(harness, r.conversation_id, context);
			const conv = (await harness.conversation(id, context))!;
			const last = (await conv.entries({ order: "descending" }, 30, undefined, context)).items.find((e) => e.kind === "pi.assistant" && (e.model?.[0] as any)?.stopReason === "stop");
			const lastText = last ? ((last.model?.[0] as any)?.content ?? []).flatMap((c: any) => (c.type === "text" ? [c.text] : [])).join("") : undefined;
			const record = await harness.commit((tx) => tx.conversation(id), context);
			const status = liveDTO(live, approvals as ApprovalDTO[], !!last).status;
			conversations.push({
				conversation: this.#rt.summary(space.id, r.conversation_id, r, record, status),
				status,
				pendingApprovals: approvals.filter((a) => a.status === "pending").length,
				needsReconciliation: (effects as EffectDTO[]).filter((e) => e.status === "needs_reconciliation").length,
				queued: inbox?.items.length ?? 0,
				continuable: !live?.run && !!live?.runFailure,
				deliverables: del.items.filter((d) => d.conversationId === r.conversation_id).length,
				...(lastText ? { lastAnswer: excerpt(lastText) } : {}),
			});
		}
		const members = this.#rt.ctx.db.all<{ user_id: string; role: string }>("SELECT user_id, role FROM id_project_members WHERE project_id = ? AND removed_at IS NULL", projectId).map((m) => ({ userId: m.user_id, name: this.#rt.userName(m.user_id), role: m.role as HandoffParticipant["role"], messages: 0, decisions: 0 }));
		const w = await acl.check(p, "write", { kind: "project", id: projectId });
		return {
			project: { id: pr.id, name: pr.name, ...(pr.description ? { description: pr.description } : {}), spaceId: space.id },
			generatedAt: nowIso(),
			members,
			conversations,
			deliverables: del.items,
			...(del.unavailable ? { deliverablesUnavailable: del.unavailable } : {}),
			access: { canWrite: w.allow, reason: w.reason },
		};
	}
}
