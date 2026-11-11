// RuntimeService implementation: catalog (ACL/display only), conversations, submissions, branches, state.
// All conversation / entry / branch / submission / run facts are read from pi-durable; rt_conversations holds only
// spaceId, createdBy, title, projectId, kind, archived, createdAt/updatedAt.
import { randomUUID } from "node:crypto";
import { type Context } from "@earendil-works/chord/context";
import { configure, ConversationBusy, ConversationIdle, InboxDoc, LiveDoc, UsageDoc, AgentDoc, type Conversation, type ConversationId, type EntryId, type EntryRecord, type Harness, type SubmissionId, type ConversationRecord, type TaskId, type ToolExecutionApi, type PromptInput, type Extension } from "@earendil-works/pi-durable";
import type { AccessControl, Action, AppContext, InputEntryData, ModelRef, Principal, RuntimeService, Space, ToolActor } from "../core/contracts.ts";
import { HttpError, nowIso } from "../core/http.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AbortResponse, AgentDTO, ApprovalDTO, AssistantDTO, ConversationKind, ConversationState, ConversationSummary, EffectDTO, EntriesPage, EntryDTO, PromoteResponse, SubagentDTO, SubmissionDTO, TasksResponse, WithdrawResponse } from "../../../shared/chat.ts";
import { ApprovalsDoc, AssistantDoc, EffectsDoc, InputEntry, NoticeEntry, SpaceDoc, StartEntry, TeamDoc, UnplacedInputEntry } from "./docs.ts";
import { entryDTO, liveDTO, queueDTO, submissionDTO, taskNodeDTO, usageFromState } from "./dto.ts";
import { FIXTURE_LABEL, FIXTURE_MODEL_ID, FIXTURE_PROVIDER, isFixtureModel, stripDirectives } from "./fixture-model.ts";
import type { HarnessManager } from "./harness-manager.ts";
import type { AssistantStore } from "./assistants.ts";
import { liveConversations, tableHasColumn } from "../identity/projects.ts";

export interface CatalogRow {
	space_id: string;
	conversation_id: number;
	created_by: string;
	title: string;
	project_id: string | null;
	kind: ConversationKind;
	archived: number;
	created_at: string;
	updated_at: string;
	/** Round 9 (runtime migration by the meta module): set = soft-deleted; every list/access path treats the conversation as gone. */
	deleted_at?: string | null;
}

const DEFAULT_TITLE = "新对话";

/**
 * Server-side title from a message: fixture directives stripped (JSON-aware), first meaningful line, whitespace
 * collapsed, ≤ 40 characters. Empty → keep "新对话" and try the next message. A PATCHed title is never overwritten.
 */
export function titleFrom(text: string): string {
	const line = stripDirectives(text)
		.split("\n")
		.map((l) => l.replace(/\s+/g, " ").trim())
		.find((l) => l.length > 0 && /[\p{L}\p{N}]/u.test(l));
	if (!line) return "";
	return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}

export function cid(n: number): ConversationId {
	return n as ConversationId;
}

export class Runtime implements RuntimeService {
	readonly ctx: AppContext;
	readonly manager: HarnessManager;
	assistants?: AssistantStore;

	constructor(ctx: AppContext, manager: HarnessManager) {
		this.ctx = ctx;
		this.manager = manager;
		// Round 9: identity extends READ on a conversation to the grantees of its container project; it asks us which project that is.
		if (ctx.services.has("identity")) ctx.services.get("identity").setConversationProjectResolver((spaceId, conversationId) => this.projectOfConversation(spaceId, conversationId));
		try {
			ctx.db.run("CREATE INDEX IF NOT EXISTS rt_conversations_project ON rt_conversations (project_id)");
		} catch {
			/* catalog table not there (unit tests without migrations) */
		}
	}

	/**
	 * The container/legacy project a conversation belongs to, or null (none / soft-deleted). Subagent child conversations have no catalog
	 * row: they resolve through their owner chain to the root conversation.
	 */
	async projectOfConversation(spaceId: string, conversationId: number): Promise<string | null> {
		let id = conversationId;
		for (let depth = 0; depth < 8; depth++) {
			const row = this.row(spaceId, id);
			if (row) return row.deleted_at ? null : row.project_id;
			const harness = await this.manager.get(spaceId);
			const rec = await harness.commit((tx) => tx.conversation(cid(id)), BACKGROUND_CONTEXT);
			if (!rec?.owner) return null;
			id = rec.owner.conversationId as number;
		}
		return null;
	}

	get acl(): AccessControl {
		return this.ctx.services.get("acl");
	}

	// ------------------------------------------------------------------ RuntimeService contract

	harness(spaceId: string, _context: Context): Promise<Harness> {
		return this.manager.get(spaceId);
	}

	async spaceOfConversation(spaceId: string, conversationId: number): Promise<Space | null> {
		const row = this.row(spaceId, conversationId);
		if (!row) return null;
		return this.ctx.services.get("identity").space(spaceId);
	}

	async createConversation(principal: Principal, spaceId: string, options: { title?: string; projectId?: string; kind?: "chat" | "automation"; model?: ModelRef; assistantId?: string }, context: Context): Promise<{ conversationId: number; notice?: string }> {
		const space = this.manager.space(spaceId);
		await this.acl.require(principal, "write", { kind: "space", id: spaceId });
		// Round 9: a project id on a personal-space conversation must be the caller's own container project (never somebody else's, never another org's).
		if (options.projectId && !space.projectId) {
			const cp = this.ctx.services.get("identity").containerProject(options.projectId);
			if (!cp || cp.orgId !== principal.orgId) throw new HttpError(404, "project_not_found", "项目不存在");
			if (cp.ownerId !== principal.userId || space.ownerUserId !== principal.userId) throw new HttpError(403, "forbidden", "只能把对话放进自己的项目", { reason: "not_project_owner" });
		}
		const assistant = options.assistantId ? this.assistants?.get(principal, options.assistantId) : undefined;
		if (options.assistantId && !assistant) throw new HttpError(404, "assistant_not_found", "助手不存在或无权使用");
		// The assistant's default model is re-checked for THIS principal; when it is not allowed or blocked the
		// conversation falls back to the default model and records a visible notice (never a silent swap).
		let notice: { text: string; code: string } | undefined;
		let model = options.model;
		if (!model && assistant?.model) {
			const chk = await this.checkModel(principal, assistant.model);
			if (chk.ok) model = chk.ref;
			else {
				model = await this.defaultModel(principal);
				notice = { code: chk.code, text: `助手「${assistant.name}」的默认模型不可用（${chk.reason}），本会话改用「${this.modelLabel(model)}」。` };
			}
		}
		model ??= await this.defaultModel(principal);
		const harness = await this.manager.get(spaceId);
		const conv = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					model: { provider: model.provider, modelId: model.modelId },
					...(model.thinkingLevel ? { thinkingLevel: model.thinkingLevel } : {}),
					...(assistant?.instructions ? { instructions: assistant.instructions } : {}),
				},
				init: async (tx, id) => {
					await tx.appendEntry(StartEntry, id, { data: { createdBy: principal.userId, at: nowIso() } });
					if (notice) await tx.appendEntry(NoticeEntry, id, { data: notice });
					if (assistant) {
						const d = await tx.doc(AssistantDoc, id);
						d.assistantId = assistant.id;
						d.name = assistant.name;
						d.members = structuredClone(assistant.members) as any;
					}
				},
			},
			context,
		);
		const now = nowIso();
		this.ctx.db.run(
			"INSERT INTO rt_conversations (space_id, conversation_id, created_by, title, project_id, kind, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
			spaceId,
			conv.id as number,
			principal.userId,
			String(options.title ?? "").trim().slice(0, 200) || DEFAULT_TITLE,
			options.projectId ?? space.projectId ?? null,
			options.kind ?? "chat",
			now,
			now,
		);
		return { conversationId: conv.id as number, ...(notice ? { notice: notice.text } : {}) };
	}

	async submitInput(principal: Principal, spaceId: string, conversationId: number, input: InputEntryData & { requestId: string; whenBusy?: "steer" | "followUp" | "reject" }, context: Context): Promise<{ submissionId: number }> {
		const s = await this.submit(principal, spaceId, conversationId, input, context);
		return { submissionId: s.submissionId };
	}

	async actorForTool(api: { conversationId: unknown; taskId: unknown; callId: string }, spaceId: string, context: Context): Promise<ToolActor> {
		const full = api as unknown as ToolExecutionApi;
		if (!spaceId && typeof full.snapshot === "function") spaceId = (await full.snapshot(SpaceDoc, context))?.spaceId ?? "";
		if (!spaceId) throw new HttpError(500, "no_space", "无法确定工具调用所属空间");
		const space = this.manager.space(spaceId);
		const harness = await this.manager.get(spaceId);
		const conversationId = api.conversationId as number;
		const who = await this.principalOfRun(harness, conversationId, context);
		if (!who) throw new HttpError(403, "no_principal", "无法确定该运行代表的用户");
		const principal = await this.ctx.services.get("identity").principalFor(who.userId, who.orgId);
		if (!principal) throw new HttpError(403, "forbidden", "该用户已被停用或移出组织（revoked）", { reason: "revoked" });
		// Current ACL, every call: a revoked membership applies mid-run and a branch never resurrects access.
		const d = await this.acl.check(principal, "write", { kind: "conversation", id: String(conversationId), spaceId });
		if (!d.allow) throw new HttpError(403, "forbidden", `工具调用被拒绝：用户已无权访问该会话（${d.reason}）`, { reason: d.reason });
		return { principal, space, conversationId, taskId: api.taskId as number, callId: api.callId };
	}

	/**
	 * The input a run acts for: the first placed input of the current run (pi.live run inputs → submissions →
	 * wr.input data); else the newest wr.input entry; else (task-owned child) the owner conversation's, transitively.
	 */
	async inputOfRun(harness: Harness, conversationId: number, context: Context, depth = 0): Promise<(InputEntryData & { entryId: number }) | null> {
		if (depth > 8) return null;
		const live = await harness.snapshot(LiveDoc, cid(conversationId), context);
		for (const sid of live?.run?.inputs ?? []) {
			const sub = await harness.submission(sid, context);
			const rec = sub ? await sub.status(context) : undefined;
			const entryId = (rec as any)?.entry as EntryId | undefined;
			if (entryId === undefined) continue;
			const e = await harness.commit((tx) => tx.entry(InputEntry, entryId), context);
			if (e?.data?.userId) return { ...(e.data as InputEntryData), entryId: e.id as number };
		}
		const conv = await harness.conversation(cid(conversationId), context);
		if (!conv) return null;
		let cursor: any;
		for (let page = 0; page < 20; page++) {
			const p = await conv.entries({ order: "descending" }, 100, cursor, context);
			for (const e of p.items) if (InputEntry.is(e) && e.data?.userId) return { ...(e.data as InputEntryData), entryId: e.id as number };
			if (!p.next) break;
			cursor = p.next;
		}
		const rec = await harness.commit((tx) => tx.conversation(cid(conversationId)), context);
		if (rec?.owner) return this.inputOfRun(harness, rec.owner.conversationId as number, context, depth + 1);
		return null;
	}

	/** The user a run acts for (see inputOfRun). */
	async principalOfRun(harness: Harness, conversationId: number, context: Context): Promise<{ userId: string; orgId: string } | null> {
		const input = await this.inputOfRun(harness, conversationId, context);
		return input ? { userId: input.userId, orgId: input.orgId } : null;
	}

	// ------------------------------------------------------------------ extras used by C / D (duck-typed there)

	/** Space id of a running tool call (from the storage's `wr.space` session doc). */
	async spaceIdForTool(api: { snapshot: ToolExecutionApi["snapshot"] }, context: Context): Promise<string> {
		const id = (await api.snapshot(SpaceDoc, context))?.spaceId;
		if (!id) throw new HttpError(500, "no_space", "无法确定工具调用所属空间");
		return id;
	}

	/** actorForTool without a spaceId, plus the run's input (attachments, knowledgeRefs, via). */
	async actorForToolCall(api: ToolExecutionApi, context: Context): Promise<ToolActor & { input?: InputEntryData }> {
		const spaceId = await this.spaceIdForTool(api, context);
		const actor = await this.actorForTool(api, spaceId, context);
		const input = await this.inputOfRun(await this.manager.get(spaceId), api.conversationId as number, context);
		return { ...actor, ...(input ? { input } : {}) };
	}

	async inputForTool(api: ToolExecutionApi, context: Context): Promise<InputEntryData | undefined> {
		const spaceId = await this.spaceIdForTool(api, context);
		return (await this.inputOfRun(await this.manager.get(spaceId), api.conversationId as number, context)) ?? undefined;
	}

	/**
	 * Scope for prompt sections: the conversation's space and the acting principal, re-resolved and re-checked against
	 * current ACL (null principal = revoked / no access: render nothing actor-dependent).
	 */
	async promptScope(input: PromptInput, context: Context): Promise<{ space: Space; principal: Principal | null } | null> {
		const spaceId = (await input.read.snapshot(SpaceDoc, context))?.spaceId;
		if (!spaceId) return null;
		const space = this.ctx.services.get("identity").space(spaceId);
		if (!space) return null;
		const who = await this.principalOfRun(await this.manager.get(spaceId), input.conversationId as number, context);
		if (!who) return { space, principal: null };
		const principal = await this.ctx.services.get("identity").principalFor(who.userId, who.orgId);
		if (!principal) return { space, principal: null };
		const d = await this.acl.check(principal, "read", { kind: "conversation", id: String(input.conversationId), spaceId });
		return { space, principal: d.allow ? principal : null };
	}

	/** Re-install an extension by name in every space's registry (e.g. MCP tools changed). */
	reinstallExtension(ext: Extension): void {
		this.manager.installExtension(ext);
	}

	// ------------------------------------------------------------------ catalog

	row(spaceId: string, conversationId: number): CatalogRow | undefined {
		return this.ctx.db.get<CatalogRow>("SELECT * FROM rt_conversations WHERE space_id = ? AND conversation_id = ?", spaceId, conversationId);
	}

	async require(p: Principal, action: Action, spaceId: string, conversationId: number): Promise<void> {
		await this.acl.require(p, action, { kind: "conversation", id: String(conversationId), spaceId });
	}

	/** ACL first (so other users get 403 without learning anything), then existence (catalog row or task-owned child). */
	async access(p: Principal, action: Action, spaceId: string, conversationId: number, context: Context): Promise<{ harness: Harness; conv: Conversation; row?: CatalogRow; record: ConversationRecord }> {
		if (!Number.isInteger(conversationId) || conversationId <= 0) throw new HttpError(400, "invalid_id", "会话 id 无效");
		await this.require(p, action, spaceId, conversationId);
		const row = this.row(spaceId, conversationId);
		const harness = await this.manager.get(spaceId);
		const conv = await harness.conversation(cid(conversationId), context);
		if (!conv) throw new HttpError(404, "not_found", "会话不存在");
		const record = (await harness.commit((tx) => tx.conversation(cid(conversationId)), context))!;
		if (!row && !record.owner) throw new HttpError(404, "not_found", "会话不存在");
		// Soft-deleted conversations are gone for everybody (a task-owned child follows its root conversation).
		if (row?.deleted_at) throw new HttpError(404, "not_found", "会话不存在");
		if (!row && record.owner && (await this.projectOfConversationDeleted(spaceId, conversationId))) throw new HttpError(404, "not_found", "会话不存在");
		if (row && action === "write" && row.archived) throw new HttpError(409, "archived", "会话已归档");
		return { harness, conv, row, record };
	}

	/** Is the root of a task-owned child conversation soft-deleted? */
	async projectOfConversationDeleted(spaceId: string, conversationId: number): Promise<boolean> {
		if (!tableHasColumn(this.ctx.db, "rt_conversations", "deleted_at")) return false;
		let id = conversationId;
		for (let depth = 0; depth < 8; depth++) {
			const row = this.row(spaceId, id);
			if (row) return !!row.deleted_at;
			const harness = await this.manager.get(spaceId);
			const rec = await harness.commit((tx) => tx.conversation(cid(id)), BACKGROUND_CONTEXT);
			if (!rec?.owner) return false;
			id = rec.owner.conversationId as number;
		}
		return false;
	}

	/** How `viewer` reaches a conversation of `spaceId`: own personal space, legacy project space (member), or through a project share. */
	accessOf(viewer: string, spaceId: string): "own" | "member" | "shared" | undefined {
		const sp = this.ctx.db.get<{ kind: string; owner_user_id: string | null }>("SELECT kind, owner_user_id FROM id_spaces WHERE id = ?", spaceId);
		if (!sp) return undefined;
		if (sp.kind === "project") return "member";
		return sp.owner_user_id === viewer ? "own" : "shared";
	}

	/** `viewer` (user id) adds the viewer-relative `access` field; the project name is always resolved. */
	summary(spaceId: string, conversationId: number, row: CatalogRow | undefined, record?: ConversationRecord, status?: ConversationSummary["status"], viewer?: string): ConversationSummary {
		const projectName = row?.project_id ? this.ctx.db.get<{ name: string }>("SELECT name FROM id_projects WHERE id = ?", row.project_id)?.name : undefined;
		const access = viewer ? this.accessOf(viewer, spaceId) : undefined;
		const base: ConversationSummary = row
			? {
					spaceId,
					conversationId,
					title: row.title,
					kind: row.kind,
					...(row.project_id ? { projectId: row.project_id } : {}),
					...(projectName ? { projectName } : {}),
					...(access ? { access } : {}),
					createdBy: row.created_by,
					createdAt: row.created_at,
					updatedAt: row.updated_at,
					archived: !!row.archived,
				}
			: { spaceId, conversationId, title: `子任务会话 #${conversationId}`, kind: "subagent", ...(access ? { access } : {}), createdBy: "", createdAt: "", updatedAt: "", archived: false };
		return {
			...base,
			...(record?.parent ? { parent: { conversationId: record.parent.conversationId as number, entryId: record.parent.at as number } } : {}),
			...(record?.owner ? { owner: { conversationId: record.owner.conversationId as number, taskId: record.owner.taskId as number } } : {}),
			...(status ? { status } : {}),
		};
	}

	/**
	 * Conversations the caller can see. Without `projectId`: own personal space + legacy project spaces (conversations shared with me through a
	 * container project are NOT mixed into recents; they are listed under their project). With a container `projectId`: the owner's conversations
	 * in it (owner: own; grantee: read-only, access "shared"); unknown / other-org / unshared projects are a plain 404. Soft-deleted rows never appear.
	 */
	async list(p: Principal, q: { spaceId?: string; projectId?: string; q?: string; limit?: number; archived?: boolean; maxLimit?: number }, context: Context): Promise<ConversationSummary[]> {
		const identity = this.ctx.services.get("identity");
		// HTTP callers are capped at 200; internal callers (search/meta visibility) may pass maxLimit up to 5000.
		const cap = Math.min(Math.max(Number(q.maxLimit) || 200, 200), 5000);
		const limit = Math.min(Math.max(Number(q.limit) || 50, 1), cap);
		const live = liveConversations(this.ctx.db);
		const params: any[] = [];
		let where: string;
		if (q.projectId && identity.containerProject(q.projectId)) {
			const cp = identity.containerProject(q.projectId)!;
			const isOwner = cp.orgId === p.orgId && cp.ownerId === p.userId;
			if (cp.orgId !== p.orgId || (!isOwner && !identity.hasProjectShare(p.userId, p.orgId, cp.id))) throw new HttpError(404, "project_not_found", "项目不存在");
			const ownerSpace = identity.personalSpace(cp.ownerId, cp.orgId);
			if (q.spaceId && q.spaceId !== ownerSpace.id) return [];
			where = "space_id = ? AND project_id = ?";
			params.push(ownerSpace.id, cp.id);
		} else {
			let spaces = await this.acl.readableSpaces(p);
			if (q.spaceId) spaces = spaces.filter((s) => s.id === q.spaceId);
			if (q.projectId) {
				const ps = identity.projectSpace(q.projectId);
				spaces = spaces.filter((s) => s.id === ps?.id);
			}
			if (spaces.length === 0) {
				if (q.spaceId || q.projectId) throw new HttpError(403, "forbidden", "无权访问该空间");
				return [];
			}
			where = `space_id IN (${spaces.map(() => "?").join(",")})`;
			params.push(...spaces.map((s) => s.id));
		}
		let sql = `SELECT * FROM rt_conversations WHERE ${where} AND archived = ?${live}`;
		params.push(q.archived ? 1 : 0);
		if (q.q?.trim()) {
			sql += " AND title LIKE ? ESCAPE '\\'";
			params.push(`%${q.q.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
		}
		sql += " ORDER BY updated_at DESC LIMIT ?";
		params.push(limit);
		const rows = this.ctx.db.all<CatalogRow>(sql, ...params);
		const out: ConversationSummary[] = [];
		for (const r of rows) {
			const h = this.manager.openHarness(r.space_id);
			if (!h) {
				out.push(this.summary(r.space_id, r.conversation_id, r, undefined, undefined, p.userId));
				continue;
			}
			try {
				const record = await h.commit((tx) => tx.conversation(cid(r.conversation_id)), context);
				const live = await h.snapshot(LiveDoc, cid(r.conversation_id), context);
				out.push(this.summary(r.space_id, r.conversation_id, r, record, live?.run ? "running" : undefined, p.userId));
			} catch {
				out.push(this.summary(r.space_id, r.conversation_id, r, undefined, undefined, p.userId));
			}
		}
		return out;
	}

	touch(spaceId: string, conversationId: number): void {
		this.ctx.db.run("UPDATE rt_conversations SET updated_at = ? WHERE space_id = ? AND conversation_id = ?", nowIso(), spaceId, conversationId);
	}

	async patch(p: Principal, spaceId: string, conversationId: number, body: { title?: string; archived?: boolean; modelId?: string; thinkingLevel?: string }, context: Context): Promise<ConversationSummary> {
		await this.require(p, "write", spaceId, conversationId);
		const row = this.row(spaceId, conversationId);
		if (!row || row.deleted_at) throw new HttpError(404, "not_found", "会话不存在");
		// Validate and apply the model switch first: a refused switch must not leave a half-applied PATCH (title/archived).
		if (body.modelId !== undefined || body.thinkingLevel !== undefined) {
			if (body.modelId === undefined) throw new HttpError(400, "invalid_model", "切换思考强度需要同时给出 modelId");
			await this.switchModel(p, spaceId, conversationId, body.modelId, body.thinkingLevel, context);
		}
		if (body.title !== undefined) {
			const t = String(body.title).trim();
			if (!t || t.length > 200) throw new HttpError(400, "invalid_title", "标题不能为空且不超过 200 字");
			this.ctx.db.run("UPDATE rt_conversations SET title = ?, updated_at = ? WHERE space_id = ? AND conversation_id = ?", t, nowIso(), spaceId, conversationId);
		}
		if (body.archived !== undefined) this.ctx.db.run("UPDATE rt_conversations SET archived = ?, updated_at = ? WHERE space_id = ? AND conversation_id = ?", body.archived ? 1 : 0, nowIso(), spaceId, conversationId);
		const { record } = await this.access(p, "read", spaceId, conversationId, context);
		return this.summary(spaceId, conversationId, this.row(spaceId, conversationId), record, undefined, p.userId);
	}

	/**
	 * Round 9: put a conversation into one of the caller's container projects, or take it out (projectId null). A conversation never changes space:
	 * only the catalog relation changes (nothing durable, no files, no workspace, no usage moves). Only the creator, only conversations in the
	 * caller's personal space (legacy project-space conversations are refused), only the caller's own container project. Idempotent.
	 */
	async moveToProject(p: Principal, spaceId: string, conversationId: number, projectId: string | null, context: Context): Promise<{ conversation: ConversationSummary; visibleTo: number }> {
		if (projectId !== null && (typeof projectId !== "string" || !projectId)) throw new HttpError(400, "invalid", "projectId 必须是项目 id 或 null");
		const { record, row } = await this.access(p, "read", spaceId, conversationId, context);
		if (!row) throw new HttpError(409, "read_only", "子任务会话不能移动");
		const identity = this.ctx.services.get("identity");
		const space = identity.space(spaceId);
		if (!space) throw new HttpError(404, "not_found", "会话不存在");
		if (space.kind === "project") throw new HttpError(409, "legacy_project_conversation", "旧版项目里的对话不能移动");
		if (space.ownerUserId !== p.userId || row.created_by !== p.userId) throw new HttpError(403, "forbidden", "只有对话的创建者可以移动对话", { reason: "not_creator" });
		if (row.kind !== "chat" && row.kind !== "branch") throw new HttpError(409, "not_movable", "该类对话不能移动");
		let target: { id: string; name: string } | undefined;
		if (projectId !== null) {
			const cp = identity.containerProject(projectId);
			if (!cp || cp.orgId !== p.orgId) throw new HttpError(404, "project_not_found", "项目不存在");
			if (cp.ownerId !== p.userId) throw new HttpError(403, "forbidden", "只能把对话放进自己的项目", { reason: "not_project_owner" });
			target = cp;
		}
		const from = row.project_id;
		if ((from ?? null) !== (target?.id ?? null)) {
			const at = nowIso();
			this.ctx.db.tx(() => {
				this.ctx.db.run("UPDATE rt_conversations SET project_id = ? WHERE space_id = ? AND conversation_id = ?", target?.id ?? null, spaceId, conversationId);
				for (const pid of [from, target?.id]) if (pid) this.ctx.db.run("UPDATE id_projects SET updated_at = ? WHERE id = ? AND kind = 'container'", at, pid);
			});
			if (this.ctx.services.has("audit")) (this.ctx.services.get("audit") as { record(i: unknown): string }).record({ orgId: p.orgId, actorUserId: p.userId, action: "conversation.project.move", target: `${spaceId}/${conversationId}`, detail: { from, to: target?.id ?? null } });
		}
		const visibleTo = target ? (this.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM id_project_shares WHERE project_id = ?", target.id)?.n ?? 0) : 0;
		return { conversation: this.summary(spaceId, conversationId, this.row(spaceId, conversationId), record, undefined, p.userId), visibleTo };
	}

	// ------------------------------------------------------------------ models

	async defaultModel(p: Principal): Promise<ModelRef> {
		if (this.ctx.services.has("models")) {
			try {
				return await this.ctx.services.get("models").defaultModel(p);
			} catch {
				/* fall through */
			}
		}
		return { provider: FIXTURE_PROVIDER, modelId: FIXTURE_MODEL_ID };
	}

	/**
	 * Resolve a request's modelId. With the model gateway (group E) only models it lists for the principal are accepted
	 * (platform id, or "provider/modelId" of a listed ref) — never a raw provider model the gateway did not offer.
	 * Without a gateway only the fixture model exists.
	 */
	async resolveModel(p: Principal, modelId: string | undefined, thinkingLevel?: unknown): Promise<ModelRef | undefined> {
		if (!modelId) {
			if (thinkingLevel !== undefined && thinkingLevel !== null) throw new HttpError(400, "invalid_thinking_level", "指定思考强度需要同时指定模型");
			return undefined;
		}
		const { ref, levels } = await this.#pickModel(p, modelId);
		const level = this.#validateThinking(levels, thinkingLevel);
		return level ? { ...ref, thinkingLevel: level } : ref;
	}

	/** modelId → the principal's listed model (platform id or "provider/modelId") with the levels it supports. */
	async #pickModel(p: Principal, modelId: string): Promise<{ ref: ModelRef; levels: readonly string[] }> {
		if (typeof modelId !== "string" || modelId.length > 200) throw new HttpError(400, "unknown_model", "未知模型");
		if (this.ctx.services.has("models")) {
			const list = await this.ctx.services.get("models").listFor(p);
			const m = list.find((x) => x.id === modelId || `${x.ref.provider}/${x.ref.modelId}` === modelId);
			if (!m) throw new HttpError(400, "unknown_model", "未知模型或无权使用该模型");
			if (m.status === "blocked") throw new HttpError(409, "model_blocked", `模型不可用：${m.statusDetail ?? "未配置凭据"}`);
			return { ref: m.ref, levels: m.thinkingLevels ?? ["off"] };
		}
		if (modelId === `${FIXTURE_PROVIDER}/${FIXTURE_MODEL_ID}` || modelId === FIXTURE_MODEL_ID) return { ref: { provider: FIXTURE_PROVIDER, modelId: FIXTURE_MODEL_ID }, levels: ["off"] };
		throw new HttpError(400, "unknown_model", "未知模型");
	}

	/** undefined / null → no explicit level; otherwise it must be one the model supports. */
	#validateThinking(levels: readonly string[], level: unknown): ModelRef["thinkingLevel"] | undefined {
		if (level === undefined || level === null || level === "") return undefined;
		if (typeof level !== "string" || !levels.includes(level)) throw new HttpError(400, "invalid_thinking_level", `该模型不支持思考强度「${String(level)}」（支持：${levels.join(" / ") || "无"}）`, { supported: [...levels] });
		return level as ModelRef["thinkingLevel"];
	}

	/**
	 * Switch the model (and thinking level) of an existing conversation: pi-durable `configure()` in one commit with a visible
	 * `wr.notice` entry ("已切换模型"), so the switch is traceable. Applies from the next request (a running one finishes on the
	 * old model). Write access and the gateway's model visibility for the ACTING user are checked here; the gateway re-checks per
	 * request. Branches keep their own agent (a fork copies the agent as of its fork point); switching a branch never touches the parent.
	 */
	async switchModel(p: Principal, spaceId: string, conversationId: number, modelId: string, thinkingLevel: unknown, context: Context): Promise<{ changed: boolean }> {
		const { harness, conv, row } = await this.access(p, "write", spaceId, conversationId, context);
		if (!row) throw new HttpError(409, "read_only", "子任务会话只读");
		if (typeof modelId !== "string" || !modelId) throw new HttpError(400, "invalid_model", "modelId 必填");
		const { ref, levels } = await this.#pickModel(p, modelId);
		// An omitted level means "the model's own default" (a level of the previous model may not exist on this one).
		const level = this.#validateThinking(levels, thinkingLevel) ?? ref.thinkingLevel;
		const before = await conv.agent(context);
		const same = before.model?.provider === ref.provider && before.model?.modelId === ref.modelId;
		if (same && (before.thinkingLevel === level || level === undefined)) return { changed: false };
		const from = this.modelLabel(before.model);
		const to = this.modelLabel(ref);
		const text = `已切换模型：${from} → ${to}${level ? `（思考强度：${level}）` : ""}，由 ${p.displayName || p.email} 操作，从下一次请求起生效。`;
		// One commit: the agent change and the notice. The notice goes in as a passive `write` submission (not a raw appendEntry):
		// that is the supported way to add an entry to a conversation that may be mid-run, and it never changes what the model sees.
		await harness.commit(async (tx) => {
			await configure(tx, cid(conversationId), { model: { provider: ref.provider, modelId: ref.modelId }, thinkingLevel: level ?? null });
			await conv.submit(tx, { type: "write", requestId: `model-switch:${randomUUID()}`, entry: { kind: NoticeEntry.kind, data: { text, code: "model_switched" } } });
		}, context);
		this.ctx.db.run("UPDATE rt_conversations SET updated_at = ? WHERE space_id = ? AND conversation_id = ?", nowIso(), spaceId, conversationId);
		return { changed: true };
	}

	/** Is `ref` usable by `p` now? Checked against the gateway's list for the principal (org/department scope, enabled, credentials). */
	async checkModel(p: Principal, ref: { provider: string; modelId: string }): Promise<{ ok: true; ref: ModelRef } | { ok: false; code: "model_not_allowed" | "model_blocked"; reason: string }> {
		if (this.ctx.services.has("models")) {
			const list = await this.ctx.services.get("models").listFor(p);
			const m = list.find((x) => x.ref.provider === ref.provider && x.ref.modelId === ref.modelId);
			if (!m) return { ok: false, code: "model_not_allowed", reason: `模型 ${ref.provider}/${ref.modelId} 不在你可用的模型列表中` };
			if (m.status === "blocked") return { ok: false, code: "model_blocked", reason: `模型「${m.label}」不可用：${m.statusDetail ?? "未配置凭据"}` };
			return { ok: true, ref: m.ref };
		}
		if (isFixtureModel(ref) && ref.modelId === FIXTURE_MODEL_ID) return { ok: true, ref: { provider: ref.provider, modelId: ref.modelId } };
		return { ok: false, code: "model_not_allowed", reason: `模型 ${ref.provider}/${ref.modelId} 未配置` };
	}

	/** Validate client-supplied attachment / knowledge chips (shape only; tools re-check access when they read them). */
	validateRefs(input: { attachments?: unknown; knowledgeRefs?: unknown }): void {
		const str = (v: unknown, max = 200) => typeof v === "string" && v.length > 0 && v.length <= max;
		if (input.attachments !== undefined) {
			if (!Array.isArray(input.attachments) || input.attachments.length > 20 || !input.attachments.every((a: any) => a && str(a.fileId) && str(a.versionId) && str(a.name, 500))) throw new HttpError(400, "invalid_attachments", "附件格式无效");
		}
		if (input.knowledgeRefs !== undefined) {
			if (!Array.isArray(input.knowledgeRefs) || input.knowledgeRefs.length > 20 || !input.knowledgeRefs.every((k: any) => k && str(k.kbId) && (k.docId === undefined || str(k.docId)) && str(k.name, 500))) throw new HttpError(400, "invalid_knowledge_refs", "知识引用格式无效");
		}
	}

	/** Simulated (fixture) model: the fixture provider, or a gateway platform model labelled as the test model. */
	readonly isSimulated = (provider: string, modelId: string): boolean => {
		if (provider === FIXTURE_PROVIDER) return true;
		try {
			return /测试模型|非真实 ?AI/.test(this.manager.models().getModel(provider, modelId)?.name ?? "");
		} catch {
			return false;
		}
	};

	modelLabel(ref: { provider: string; modelId: string } | undefined): string {
		if (!ref) return "未选择模型";
		if (isFixtureModel(ref)) return FIXTURE_LABEL;
		const m = this.manager.models().getModel(ref.provider, ref.modelId);
		return m?.name ?? `${ref.provider}/${ref.modelId}`;
	}

	// ------------------------------------------------------------------ submissions

	composeContent(input: { text: string; attachments?: InputEntryData["attachments"]; knowledgeRefs?: InputEntryData["knowledgeRefs"] }): string {
		let content = input.text;
		if (input.attachments?.length) content += `\n\n[附件] ${input.attachments.map((a) => `${a.name} (fileId=${a.fileId}, versionId=${a.versionId})`).join("; ")}`;
		if (input.knowledgeRefs?.length) content += `\n\n[引用知识] ${input.knowledgeRefs.map((k) => `${k.name} (kbId=${k.kbId}${k.docId ? `, docId=${k.docId}` : ""})`).join("; ")}`;
		return content;
	}

	/**
	 * An input that claims to come from an automation must act as that automation's owner. Running it as anybody else
	 * ("run as other") needs `automation.run_as_others`. Delegation/subagent inputs carry the delegating user already.
	 */
	async #checkRunAs(p: Principal, input: { via?: InputEntryData["via"] }): Promise<void> {
		const via = input.via;
		if (via?.kind !== "automation") return;
		const row = this.ctx.services.has("automation") ? (this.ctx.services.get("automation") as { get(id: string): { owner_user_id: string } | null }).get(via.automationId) : null;
		if (row && row.owner_user_id === p.userId) return;
		await this.ctx.services.get("authz").require(p, "automation.run_as_others");
	}

	/** Everything that can refuse an input (shape, run-as, access, budget) — checked before anything durable changes. */
	async #admit(p: Principal, spaceId: string, conversationId: number, input: InputEntryData & { requestId: string }, context: Context) {
		if (typeof input.requestId !== "string" || !input.requestId || input.requestId.length > 200) throw new HttpError(400, "invalid_request_id", "requestId 必填");
		if (typeof input.text !== "string" || !input.text.trim()) throw new HttpError(400, "empty", "消息不能为空");
		if (input.text.length > 100_000) throw new HttpError(413, "too_long", "消息过长");
		this.validateRefs(input);
		await this.#checkRunAs(p, input);
		const a = await this.access(p, "write", spaceId, conversationId, context);
		if (!a.row) throw new HttpError(409, "read_only", "子任务会话只读");
		if (this.ctx.services.has("budget")) {
			const b = await this.ctx.services.get("budget").checkSubmit(p, spaceId, a.row.project_id ?? undefined);
			if (!b.allow) throw new HttpError(402, "budget_exceeded", `预算不足：${b.reason}`, { reason: b.reason });
		}
		return { ...a, row: a.row };
	}

	/** Queue operations on one conversation (withdraw / promote) run one after another, so a double click or two tabs cannot interleave. */
	readonly #queueLocks = new Map<string, Promise<unknown>>();
	#serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.#queueLocks.get(key) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		const tail = next.catch(() => {});
		this.#queueLocks.set(key, tail);
		void tail.then(() => {
			if (this.#queueLocks.get(key) === tail) this.#queueLocks.delete(key);
		});
		return next;
	}

	async submit(p: Principal, spaceId: string, conversationId: number, input: InputEntryData & { requestId: string; whenBusy?: "steer" | "followUp" | "reject" }, context: Context): Promise<SubmissionDTO> {
		const { harness, conv, row } = await this.#admit(p, spaceId, conversationId, input, context);
		const data: InputEntryData = {
			text: input.text,
			userId: p.userId,
			orgId: p.orgId,
			...(input.attachments?.length ? { attachments: input.attachments } : {}),
			...(input.knowledgeRefs?.length ? { knowledgeRefs: input.knowledgeRefs } : {}),
			...(input.via ? { via: input.via } : {}),
		};
		// requestId in the entry links the message to its submission, so its outcome can be shown on it after reload.
		(data as any).requestId = input.requestId;
		let sub;
		try {
			sub = await conv.submit(
				{
					type: "input",
					content: this.composeContent(input),
					requestId: input.requestId,
					whenBusy: input.whenBusy ?? "followUp",
					entry: { kind: InputEntry.kind, data: data as any },
				},
				context,
			);
		} catch (err) {
			if (err instanceof ConversationBusy) throw new HttpError(409, "busy", "会话正在运行");
			if (err instanceof ConversationIdle) throw new HttpError(409, "idle", "会话空闲");
			throw err;
		}
		if (row.title === DEFAULT_TITLE) {
			const t = titleFrom(input.text);
			if (t) this.ctx.db.run("UPDATE rt_conversations SET title = ? WHERE space_id = ? AND conversation_id = ? AND title = ?", t, spaceId, conversationId, DEFAULT_TITLE);
		}
		this.touch(spaceId, conversationId);
		return this.submissionStatus(harness, conversationId, sub.id, context);
	}

	async submissionStatus(harness: Harness, conversationId: number, id: SubmissionId | number, context: Context): Promise<SubmissionDTO> {
		const sub = await harness.submission(id as SubmissionId, context);
		const rec = sub ? await sub.status(context) : undefined;
		if (!rec || (rec.conversationId as number) !== conversationId) throw new HttpError(404, "not_found", "提交不存在");
		let mode: "steer" | "followUp" | "write" | undefined;
		if (rec.status === "queued") {
			const inbox = await harness.snapshot(InboxDoc, cid(conversationId), context);
			mode = inbox?.items.find((i) => (i.id as number) === (id as number))?.mode;
		}
		return submissionDTO(rec, mode);
	}

	// ------------------------------------------------------------------ branches

	async #branch(p: Principal, spaceId: string, harness: Harness, conv: Conversation, row: CatalogRow | undefined, at: EntryId, title: string | undefined, context: Context): Promise<{ conv: Conversation; summary: ConversationSummary }> {
		const fork = await conv.fork(at, { ownership: { kind: "ownerless" } }, context);
		const now = nowIso();
		this.ctx.db.run(
			"INSERT INTO rt_conversations (space_id, conversation_id, created_by, title, project_id, kind, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'branch', 0, ?, ?)",
			spaceId,
			fork.id as number,
			p.userId,
			String(title ?? "").trim().slice(0, 200) || `${row?.title ?? "会话"}（分支）`.slice(0, 200),
			row?.project_id ?? null,
			now,
			now,
		);
		const record = await harness.commit((tx) => tx.conversation(fork.id), context);
		return { conv: fork, summary: this.summary(spaceId, fork.id as number, this.row(spaceId, fork.id as number), record, undefined, p.userId) };
	}

	async #visibleEntry(conv: Conversation, entryId: number, context: Context): Promise<EntryRecord> {
		const p = await conv.entries({ minEntryId: entryId as EntryId, maxEntryId: entryId as EntryId }, 1, undefined, context);
		const e = p.items[0];
		if (!e) throw new HttpError(404, "entry_not_found", "该消息不在此会话中");
		return e;
	}

	async #previousEntry(conv: Conversation, entryId: number, context: Context): Promise<EntryRecord | undefined> {
		const p = await conv.entries({ maxEntryId: (entryId - 1) as EntryId, order: "descending" }, 1, undefined, context);
		return p.items[0];
	}

	async fork(p: Principal, spaceId: string, conversationId: number, body: { entryId: number; title?: string }, context: Context): Promise<ConversationSummary> {
		const { harness, conv, row } = await this.access(p, "write", spaceId, conversationId, context);
		await this.#visibleEntry(conv, Number(body.entryId), context);
		return (await this.#branch(p, spaceId, harness, conv, row, body.entryId as EntryId, body.title, context)).summary;
	}

	/** Edit = fork before the edited user entry, then submit the new text there. The original is untouched. */
	async edit(p: Principal, spaceId: string, conversationId: number, body: { entryId: number; text: string; requestId: string }, context: Context): Promise<{ conversation: ConversationSummary; submissionId: number }> {
		const { harness, conv, row } = await this.access(p, "write", spaceId, conversationId, context);
		const edited = await this.#visibleEntry(conv, Number(body.entryId), context);
		if (edited.kind !== InputEntry.kind && edited.kind !== "pi.user") throw new HttpError(400, "not_user_entry", "只能编辑用户消息");
		const prev = await this.#previousEntry(conv, edited.id as number, context);
		if (!prev) throw new HttpError(409, "cannot_fork", "该消息之前没有可分叉的位置");
		const old = (edited.data as any) ?? {};
		const { summary } = await this.#branch(p, spaceId, harness, conv, row, prev.id, undefined, context);
		const s = await this.submit(p, spaceId, summary.conversationId, { text: body.text, requestId: body.requestId, attachments: old.attachments, knowledgeRefs: old.knowledgeRefs, userId: p.userId, orgId: p.orgId }, context);
		return { conversation: summary, submissionId: s.submissionId };
	}

	/** Regenerate = fork at the turn's user entry, then submit a continue there. */
	async regenerate(p: Principal, spaceId: string, conversationId: number, body: { entryId: number }, context: Context): Promise<{ conversation: ConversationSummary; submissionId: number }> {
		const { harness, conv, row } = await this.access(p, "write", spaceId, conversationId, context);
		let e = await this.#visibleEntry(conv, Number(body.entryId), context);
		if (e.kind !== InputEntry.kind && e.kind !== "pi.user") {
			const before = await conv.entries({ maxEntryId: e.id, order: "descending" }, 200, undefined, context);
			const user = before.items.find((x) => x.kind === InputEntry.kind || x.kind === "pi.user");
			if (!user) throw new HttpError(409, "no_user_turn", "找不到这一轮的用户输入");
			e = user;
		}
		const { conv: fork, summary } = await this.#branch(p, spaceId, harness, conv, row, e.id, undefined, context);
		const sub = await fork.submit({ type: "continue", requestId: `regenerate:${conversationId}:${e.id}:${fork.id}` }, context);
		return { conversation: summary, submissionId: sub.id as number };
	}

	/**
	 * 停止. pi-durable's abort ends the run and withdraws the inputs still QUEUED behind it (a stopped conversation keeps no queue);
	 * everything already in the conversation stays: the applied user input, every completed step and tool result, and the error
	 * results of the calls the stop cut off. Nothing the person already sent is removed. The withdrawn queued inputs are returned
	 * (and kept as display-only 「未送达」 markers) so the client can put them back into the composer instead of discarding them.
	 * An approval that was still waiting belongs to a call that was just aborted: it is cancelled so it cannot be "approved" for nothing.
	 */
	async abort(p: Principal, spaceId: string, conversationId: number, body: { background?: boolean }, context: Context): Promise<AbortResponse> {
		const { harness, conv } = await this.access(p, "write", spaceId, conversationId, context);
		const queued = ((await harness.snapshot(InboxDoc, conv.id, context))?.items ?? []).filter((i) => i.mode !== "write").map((i) => ({ id: i.id as number, entry: (i as any).entry }));
		await conv.abort(context, body.background ? { background: true } : undefined);
		const unsent = await this.recordUnplaced(harness, conv, queued, context);
		const cancelledApprovals = await this.#cancelPendingApprovals(harness, conv.id, context);
		await this.#flagCutOffEffects(harness, conv.id, context);
		// A run aborted during a tool call made no model request: tell the usage ledger (group E) to re-import.
		if (this.ctx.services.has("usage")) (this.ctx.services.get("usage") as { markDirty?: (s: string, c: number) => void }).markDirty?.(spaceId, conversationId);
		return { ok: true, unsent, cancelledApprovals };
	}

	/**
	 * An external write the stop cut off while it was being sent (status "dispatching") may or may not have reached its target. The
	 * aborted tool never got to record that, so it is surfaced as 待核对 now (the person verifies; nothing is re-run on its own).
	 */
	async #flagCutOffEffects(harness: Harness, conversationId: ConversationId, context: Context): Promise<void> {
		const cut = Object.values((await harness.snapshot(EffectsDoc, conversationId, context))?.items ?? {}).filter((e) => e.status === "dispatching");
		if (!cut.length) return;
		await harness.commit(async (tx) => {
			const d = await tx.doc(EffectsDoc, conversationId);
			for (const it of Object.values(d.items)) {
				if (it.status !== "dispatching") continue;
				it.status = "needs_reconciliation";
				it.error = `外部写入结果未知（发送过程中被「停止」中断）：${it.target} · ${it.summary}`;
				it.updatedAt = nowIso();
				it.history = [...(it.history ?? []), "stopped"];
			}
		}, context);
	}

	/** After a stop no tool call of this conversation is waiting any more: its pending approvals are settled as cancelled (no decider, nothing executed). */
	async #cancelPendingApprovals(harness: Harness, conversationId: ConversationId, context: Context): Promise<number> {
		const pending = Object.values((await harness.snapshot(ApprovalsDoc, conversationId, context))?.items ?? {}).filter((a) => a.status === "pending");
		if (!pending.length) return 0;
		return harness.commit(async (tx) => {
			const d = await tx.doc(ApprovalsDoc, conversationId);
			let n = 0;
			for (const it of Object.values(d.items)) {
				if (it.status !== "pending") continue;
				it.status = "cancelled";
				it.decidedAt = nowIso();
				it.note = "已随「停止」取消：这一步没有执行";
				n++;
			}
			return n;
		}, context);
	}

	async continue(p: Principal, spaceId: string, conversationId: number, body: { requestId?: string }, context: Context): Promise<SubmissionDTO> {
		const { harness, conv } = await this.access(p, "write", spaceId, conversationId, context);
		try {
			const sub = await conv.submit({ type: "continue", ...(body.requestId ? { requestId: body.requestId } : {}) }, context);
			return this.submissionStatus(harness, conversationId, sub.id, context);
		} catch (err) {
			if (err instanceof ConversationBusy) throw new HttpError(409, "busy", "会话正在运行，无法继续");
			throw err;
		}
	}

	// ------------------------------------------------------------------ reads

	userName(userId: string): string | undefined {
		return this.ctx.db.get<{ name: string }>("SELECT name FROM id_users WHERE id = ?", userId)?.name;
	}

	/** Entry DTOs (pi.system hidden) with each user message's submission outcome read from pi-durable. */
	async toDTOs(harness: Harness, entries: readonly EntryRecord[], context: Context): Promise<EntryDTO[]> {
		const names = new Map<string, string | undefined>();
		const name = (u: string) => {
			if (!names.has(u)) names.set(u, this.userName(u));
			return names.get(u);
		};
		const visible = entries.filter((e) => e.kind !== "pi.system");
		const dtos = visible.map((e) => entryDTO(e, name, this.isSimulated));
		const lookups: { i: number; conversationId: number; requestId: string }[] = [];
		visible.forEach((e, i) => {
			const rid = (e.data as any)?.requestId;
			if ((e.kind === InputEntry.kind || e.kind === UnplacedInputEntry.kind) && typeof rid === "string") lookups.push({ i, conversationId: e.conversationId as number, requestId: rid });
		});
		if (lookups.length) {
			const recs = await harness.commit((tx) => Promise.all(lookups.map((l) => tx.submissionByRequest(cid(l.conversationId), l.requestId))), context);
			lookups.forEach((l, k) => {
				const rec = recs[k];
				if (!rec) return;
				const s = submissionDTO(rec);
				(dtos[l.i] as any).submission = { submissionId: s.submissionId, status: s.status, ...(s.reason ? { reason: s.reason } : {}), ...(s.answerEntryId !== undefined ? { answerEntryId: s.answerEntryId } : {}) };
			});
		}
		return dtos;
	}

	/**
	 * Inputs settled without ever being placed (withdrawn, or dropped by an abort) leave no entry in pi. Append a
	 * display-only `wr.input-unplaced` write (never seen by the model) so the message and its outcome survive reload.
	 */
	async recordUnplaced(harness: Harness, conv: Conversation, items: readonly { id: number; entry?: any }[], context: Context): Promise<AbortResponse["unsent"]> {
		const recorded: AbortResponse["unsent"][number][] = [];
		for (const it of items) {
			const sub = await harness.submission(it.id as SubmissionId, context);
			const rec = sub ? await sub.status(context) : undefined;
			if (!rec || rec.type !== "input" || rec.status !== "unanswered" || rec.entry !== undefined) continue;
			const d = (it.entry?.data ?? {}) as InputEntryData;
			const data = { ...((it.entry?.data as object) ?? {}), ...(rec.requestId ? { requestId: rec.requestId } : {}), submissionId: it.id, reason: rec.reason };
			await conv.submit({ type: "write", requestId: `unplaced:${it.id}`, entry: { kind: UnplacedInputEntry.kind, data: data as any } }, context);
			recorded.push({ submissionId: it.id, text: d.text ?? "", ...(d.attachments?.length ? { attachments: d.attachments } : {}), ...(d.knowledgeRefs?.length ? { knowledgeRefs: d.knowledgeRefs } : {}) });
		}
		return recorded;
	}

	/**
	 * Withdraw a queued input (POST …/withdraw). With `restore` the caller takes the message back into its composer: the
	 * display-only "未送达" marker is then not written, and the input (text + attachments) is returned. `already_placed` means
	 * the input was applied first: it is in the conversation, nothing is restored.
	 */
	async withdraw(p: Principal, spaceId: string, conversationId: number, submissionId: number, context: Context, opts: { restore?: boolean } = {}): Promise<WithdrawResponse> {
		const { harness, conv } = await this.access(p, "write", spaceId, conversationId, context);
		if (!Number.isInteger(submissionId) || submissionId <= 0) throw new HttpError(400, "invalid_id", "提交 id 无效");
		return this.#serial(`${spaceId}:${conversationId}`, async () => {
			const inbox = await harness.snapshot(InboxDoc, conv.id, context);
			const item = inbox?.items.find((i) => (i.id as number) === submissionId);
			const r = await harness.abortSubmission(submissionId as SubmissionId, context, conv.id);
			if (r === "not_found") throw new HttpError(404, "not_found", "提交不存在");
			const restoring = !!opts.restore && r === "aborted" && !!item && item.mode !== "write";
			if (r === "aborted" && item && !restoring) await this.recordUnplaced(harness, conv, [{ id: submissionId, entry: (item as any).entry }], context);
			const d = ((item as any)?.entry?.data ?? {}) as InputEntryData;
			return {
				result: r,
				submission: await this.submissionStatus(harness, conversationId, submissionId, context),
				...(restoring ? { input: { text: d.text, ...(d.attachments?.length ? { attachments: d.attachments } : {}), ...(d.knowledgeRefs?.length ? { knowledgeRefs: d.knowledgeRefs } : {}) } } : {}),
			};
		});
	}

	/**
	 * 立即发送: turn a queued follow-up into a steer. pi-durable has no "change mode" operation, so it is withdrawn
	 * (`abortSubmission`) and the same input is submitted again with `whenBusy: "steer"` under the deterministic requestId
	 * `${requestId}::now` — a retry / double click / second tab finds that submission and returns it (replayed) instead of sending twice.
	 * Everything that could refuse the new submission is checked BEFORE the withdraw; if the resubmit still fails the input is
	 * recorded as an unsent message (never silently lost) and the error is raised. A steer never interrupts a running tool or a
	 * pending approval: pi-durable places it at the run's next model step (after the approval is decided).
	 */
	async promote(p: Principal, spaceId: string, conversationId: number, submissionId: number, context: Context): Promise<PromoteResponse> {
		const { harness, conv, row } = await this.access(p, "write", spaceId, conversationId, context);
		if (!row) throw new HttpError(409, "read_only", "子任务会话只读");
		if (!Number.isInteger(submissionId) || submissionId <= 0) throw new HttpError(400, "invalid_id", "提交 id 无效");
		return this.#serial(`${spaceId}:${conversationId}`, async () => {
			const sub = await harness.submission(submissionId as SubmissionId, context);
			const rec = sub ? await sub.status(context) : undefined;
			if (!rec || (rec.conversationId as number) !== conversationId) throw new HttpError(404, "not_found", "提交不存在");
			const dto = () => this.submissionStatus(harness, conversationId, submissionId, context);
			const inbox = await harness.snapshot(InboxDoc, conv.id, context);
			const item = inbox?.items.find((i) => (i.id as number) === submissionId) as any;
			if (rec.type !== "input") return { result: "not_found", submission: await dto() };
			if (item?.mode === "steer") return { result: "promoted", effect: "steered", replayed: true, submission: await dto() };
			if (!item) {
				if (rec.status === "placed" || rec.status === "done" || (rec as any).entry !== undefined) return { result: "already_applied", submission: await dto() };
				// withdrawn: either by the user, or by an earlier promote of this very input → replay its steer
				const nowRec = rec.requestId ? await harness.commit((tx) => tx.submissionByRequest(conv.id, `${rec.requestId}::now`), context) : undefined;
				if (nowRec) {
					const nowDto = await this.submissionStatus(harness, conversationId, nowRec.id as number, context);
					return { result: "promoted", effect: nowDto.status === "received" ? "steered" : "started", replayed: true, submission: nowDto };
				}
				return { result: "not_found", submission: await dto() };
			}
			const data = { ...((item.entry?.data ?? {}) as InputEntryData) } as InputEntryData & { requestId?: string };
			const nowRid = `${rec.requestId ?? data.requestId ?? `sub-${submissionId}`}::now`;
			await this.#admit(p, spaceId, conversationId, { ...data, requestId: nowRid }, context);
			// Durable intent BEFORE the withdraw: if the process dies between withdraw and resubmit, startup finishes the resubmit (same requestId).
			const intentKey = [spaceId, conversationId, submissionId] as const;
			this.ctx.db.run("INSERT OR REPLACE INTO rt_promote_intents (space_id, conversation_id, submission_id, now_request_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?)", ...intentKey, nowRid, JSON.stringify({ ...data, requestId: nowRid }), nowIso());
			const clearIntent = () => this.ctx.db.run("DELETE FROM rt_promote_intents WHERE space_id = ? AND conversation_id = ? AND submission_id = ?", ...intentKey);
			const r = await harness.abortSubmission(submissionId as SubmissionId, context, conv.id);
			if (r !== "aborted") {
				clearIntent();
				return { result: r === "not_found" ? "not_found" : "already_applied", submission: await dto() };
			}
			data.requestId = nowRid;
			let nowSub;
			try {
				nowSub = await conv.submit({ type: "input", content: this.composeContent(data), requestId: nowRid, whenBusy: "steer", entry: { kind: InputEntry.kind, data: data as any } }, context);
			} catch (err) {
				await this.recordUnplaced(harness, conv, [{ id: submissionId, entry: item.entry }], context).catch(() => {});
				clearIntent();
				throw new HttpError(500, "promote_failed", "立即发送失败，消息已保留为「未送达」，请重新发送", { cause: String((err as Error)?.message ?? err) });
			}
			clearIntent();
			this.touch(spaceId, conversationId);
			const nowDto = await this.submissionStatus(harness, conversationId, nowSub.id, context);
			return { result: "promoted", effect: nowDto.status === "received" ? "steered" : "started", submission: nowDto };
		});
	}

	/** Startup: finish "send now" operations interrupted between withdraw and resubmit. Never sends twice (requestId), never drops silently. */
	async reconcilePromoteIntents(context: Context = BACKGROUND_CONTEXT): Promise<{ resubmitted: number; cleared: number }> {
		let resubmitted = 0;
		let cleared = 0;
		const rows = this.ctx.db.all<{ space_id: string; conversation_id: number; submission_id: number; now_request_id: string; data: string }>("SELECT * FROM rt_promote_intents");
		for (const r of rows) {
			const del = () => this.ctx.db.run("DELETE FROM rt_promote_intents WHERE space_id = ? AND conversation_id = ? AND submission_id = ?", r.space_id, r.conversation_id, r.submission_id);
			try {
				const harness = await this.manager.get(r.space_id);
				const conv = await harness.conversation(cid(r.conversation_id), context);
				if (!conv) {
					del();
					continue;
				}
				const nowRec = await harness.commit((tx) => tx.submissionByRequest(conv.id, r.now_request_id), context);
				const inbox = await harness.snapshot(InboxDoc, conv.id, context);
				const stillQueued = inbox?.items.some((i) => (i.id as number) === r.submission_id);
				if (!nowRec && !stillQueued) {
					const sub = await harness.submission(r.submission_id as SubmissionId, context);
					const rec = sub ? await sub.status(context) : undefined;
					// Only when the original was really withdrawn and never placed: resubmit it as steer under the promised requestId.
					if (rec && rec.status !== "placed" && rec.status !== "done" && (rec as any).entry === undefined) {
						const data = JSON.parse(r.data) as InputEntryData & { requestId: string };
						await conv.submit({ type: "input", content: this.composeContent(data), requestId: r.now_request_id, whenBusy: "steer", entry: { kind: InputEntry.kind, data: data as any } }, context);
						resubmitted++;
					}
				}
				del();
				cleared++;
			} catch (e) {
				console.error("[runtime] promote intent", r.space_id, r.conversation_id, r.submission_id, e);
			}
		}
		return { resubmitted, cleared };
	}

	async entries(p: Principal, spaceId: string, conversationId: number, q: { before?: number; limit?: number }, context: Context): Promise<EntriesPage> {
		const { harness, conv } = await this.access(p, "read", spaceId, conversationId, context);
		const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
		const query = q.before ? { maxEntryId: (Number(q.before) - 1) as EntryId, order: "descending" as const } : { order: "descending" as const };
		const page = await conv.entries(query, limit, undefined, context);
		const items = [...page.items].reverse();
		return { items: await this.toDTOs(harness, items, context), ...(page.next && items.length ? { next: items[0]!.id as number } : {}) };
	}

	async agentDTO(harness: Harness, conv: Conversation, context: Context): Promise<AgentDTO> {
		const agent = await conv.agent(context);
		const ad = await harness.snapshot(AssistantDoc, conv.id, context);
		let assistant: AssistantDTO | undefined;
		if (ad?.assistantId) assistant = this.assistants?.byId(ad.assistantId);
		return {
			...(agent.model ? { model: { provider: agent.model.provider, modelId: agent.model.modelId } } : {}),
			thinkingLevel: agent.thinkingLevel,
			fixture: !!agent.model && this.isSimulated(agent.model.provider, agent.model.modelId),
			modelLabel: this.modelLabel(agent.model),
			tools: agent.tools.map((t) => t.name),
			...(agent.maxTurns ? { maxTurns: agent.maxTurns } : {}),
			...(assistant ? { assistant } : {}),
		};
	}

	async detail(p: Principal, spaceId: string, conversationId: number, context: Context) {
		const { harness, conv, row, record } = await this.access(p, "read", spaceId, conversationId, context);
		const branchRows = this.ctx.db.all<CatalogRow>("SELECT * FROM rt_conversations WHERE space_id = ? AND kind = 'branch' AND conversation_id > ? ORDER BY conversation_id", spaceId, conversationId);
		const branches: ConversationSummary[] = [];
		if (branchRows.length) {
			const recs = await harness.commit((tx) => Promise.all(branchRows.map((r) => tx.conversation(cid(r.conversation_id)))), context);
			branchRows.forEach((r, i) => {
				const rec = recs[i];
				// A read-only viewer only sees branches that are in the same project (the others are not readable by them).
				if (rec?.parent && (rec.parent.conversationId as number) === conversationId && !r.deleted_at && (this.accessOf(p.userId, spaceId) !== "shared" || r.project_id === row?.project_id)) branches.push(this.summary(spaceId, r.conversation_id, r, rec, undefined, p.userId));
			});
		}
		const live = await harness.snapshot(LiveDoc, conv.id, context);
		return {
			conversation: this.summary(spaceId, conversationId, row, record, live?.run ? "running" : undefined, p.userId),
			...(record.parent ? { parent: { conversationId: record.parent.conversationId as number, entryId: record.parent.at as number } } : {}),
			branches,
			agent: await this.agentDTO(harness, conv, context),
		};
	}

	async docs(harness: Harness, conversationId: number, context: Context): Promise<{ approvals: ApprovalDTO[]; effects: EffectDTO[]; subagents: SubagentDTO[] }> {
		const id = cid(conversationId);
		const [ap, ef, team] = await Promise.all([harness.snapshot(ApprovalsDoc, id, context), harness.snapshot(EffectsDoc, id, context), harness.snapshot(TeamDoc, id, context)]);
		const approvals = Object.values(ap?.items ?? {}) as ApprovalDTO[];
		const subagents = Object.values(team?.delegations ?? {}) as SubagentDTO[];
		// Surface approvals that subagent children are waiting on (the user decides them from the parent's view).
		for (const s of subagents) {
			if (s.childConversationId === undefined || s.status !== "running") continue;
			const childAp = await harness.snapshot(ApprovalsDoc, cid(s.childConversationId), context);
			for (const a of Object.values(childAp?.items ?? {})) approvals.push(a as ApprovalDTO);
		}
		approvals.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
		return { approvals, effects: Object.values(ef?.items ?? {}) as EffectDTO[], subagents };
	}

	/** Build the full ConversationState from a view value (watch) plus our own documents. */
	async state(spaceId: string, harness: Harness, conv: Conversation, view: { entries: readonly EntryRecord[]; before?: EntryId; docs: Record<string, any>; conversation: ConversationRecord }, revision: number, context: Context, viewer?: string): Promise<ConversationState> {
		const conversationId = conv.id as number;
		const { approvals, effects, subagents } = await this.docs(harness, conversationId, context);
		const live = view.docs[LiveDoc.definition.kind];
		const hasAnswer = view.before !== undefined || view.entries.some((e) => e.kind === "pi.assistant");
		const ld = liveDTO(live, approvals, hasAnswer);
		return {
			conversation: this.summary(spaceId, conversationId, this.row(spaceId, conversationId), view.conversation, ld.status, viewer),
			entries: await this.toDTOs(harness, view.entries, context),
			hasEarlier: view.before !== undefined,
			live: ld,
			queue: queueDTO(view.docs[InboxDoc.definition.kind]),
			approvals,
			effects,
			subagents,
			usage: usageFromState(view.docs[UsageDoc.definition.kind], this.isSimulated),
			agent: await this.agentDTO(harness, conv, context),
			...this.workOf(spaceId, conversationId),
			revision,
			at: nowIso(),
		};
	}

	/** Jobs + browser sessions from group D's `work` service, when loaded. Never fails the state. */
	workOf(spaceId: string, conversationId: number): { work?: ConversationState["work"] } {
		if (!this.ctx.services.has("work")) return {};
		try {
			return { work: (this.ctx.services.get("work") as { forConversation(s: string, c: number): NonNullable<ConversationState["work"]> }).forConversation(spaceId, conversationId) };
		} catch (err) {
			console.error("[runtime] work service failed", (err as Error)?.message ?? err);
			return {};
		}
	}

	async tasks(p: Principal, spaceId: string, conversationId: number, context: Context): Promise<TasksResponse> {
		const { harness } = await this.access(p, "read", spaceId, conversationId, context);
		const watch = await harness.watchTaskGraph(context);
		const graph = watch.value;
		await watch.stop();
		// The conversation's subtree: tasks of this conversation, and of conversations owned by those tasks (transitively).
		const nodes = Object.values(graph.tasks);
		const convs = new Set<number>([conversationId]);
		let grew = true;
		while (grew) {
			grew = false;
			for (const n of nodes) {
				if (!convs.has(n.conversationId as number)) continue;
				for (const c of n.conversations) if (!convs.has(c as number)) (convs.add(c as number), (grew = true));
			}
		}
		const tasks = nodes.filter((n) => convs.has(n.conversationId as number)).map(taskNodeDTO);
		const { subagents } = await this.docs(harness, conversationId, context);
		return { tasks, subagents };
	}

	agentStateOf(harness: Harness, conversationId: number, context: Context) {
		return harness.snapshot(AgentDoc, cid(conversationId), context);
	}
}

export type { TaskId };
