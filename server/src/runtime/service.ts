// RuntimeService implementation: catalog (ACL/display only), conversations, submissions, branches, state.
// All conversation / entry / branch / submission / run facts are read from pi-durable; rt_conversations holds only
// spaceId, createdBy, title, projectId, kind, archived, createdAt/updatedAt.
import { type Context } from "@earendil-works/chord/context";
import { ConversationBusy, ConversationIdle, InboxDoc, LiveDoc, UsageDoc, AgentDoc, type Conversation, type ConversationId, type EntryId, type EntryRecord, type Harness, type SubmissionId, type ConversationRecord, type TaskId, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { AccessControl, Action, AppContext, InputEntryData, ModelRef, Principal, RuntimeService, Space, ToolActor } from "../core/contracts.ts";
import { HttpError, nowIso } from "../core/http.ts";
import type { AgentDTO, ApprovalDTO, AssistantDTO, ConversationKind, ConversationState, ConversationSummary, EffectDTO, EntriesPage, EntryDTO, SubagentDTO, SubmissionDTO, TasksResponse } from "../../../shared/chat.ts";
import { ApprovalsDoc, AssistantDoc, EffectsDoc, InputEntry, SpaceDoc, StartEntry, TeamDoc } from "./docs.ts";
import { entryDTO, liveDTO, queueDTO, submissionDTO, taskNodeDTO, usageFromState } from "./dto.ts";
import { FIXTURE_LABEL, FIXTURE_MODEL_ID, FIXTURE_PROVIDER, isFixtureModel } from "./fixture-model.ts";
import type { HarnessManager } from "./harness-manager.ts";
import type { AssistantStore } from "./assistants.ts";

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
}

const DEFAULT_TITLE = "新对话";

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

	async createConversation(principal: Principal, spaceId: string, options: { title?: string; projectId?: string; kind?: "chat" | "automation"; model?: ModelRef; assistantId?: string }, context: Context): Promise<{ conversationId: number }> {
		const space = this.manager.space(spaceId);
		await this.acl.require(principal, "write", { kind: "space", id: spaceId });
		const assistant = options.assistantId ? this.assistants?.get(principal, options.assistantId) : undefined;
		if (options.assistantId && !assistant) throw new HttpError(404, "assistant_not_found", "助手不存在或无权使用");
		const model = options.model ?? (assistant?.model as ModelRef | undefined) ?? (await this.defaultModel(principal));
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
			options.title?.trim() || DEFAULT_TITLE,
			options.projectId ?? space.projectId ?? null,
			options.kind ?? "chat",
			now,
			now,
		);
		return { conversationId: conv.id as number };
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
	 * The user a run acts for: the first input of the current run (pi.live run inputs → submissions → wr.input data);
	 * else the newest wr.input entry; else (task-owned child) the owner conversation's run, transitively.
	 */
	async principalOfRun(harness: Harness, conversationId: number, context: Context, depth = 0): Promise<{ userId: string; orgId: string } | null> {
		if (depth > 8) return null;
		const live = await harness.snapshot(LiveDoc, cid(conversationId), context);
		for (const sid of live?.run?.inputs ?? []) {
			const sub = await harness.submission(sid, context);
			const rec = sub ? await sub.status(context) : undefined;
			const entryId = (rec as any)?.entry as EntryId | undefined;
			if (entryId === undefined) continue;
			const e = await harness.commit((tx) => tx.entry(InputEntry, entryId), context);
			if (e?.data?.userId) return { userId: e.data.userId, orgId: e.data.orgId };
		}
		const conv = await harness.conversation(cid(conversationId), context);
		if (!conv) return null;
		let cursor: any;
		for (let page = 0; page < 20; page++) {
			const p = await conv.entries({ order: "descending" }, 100, cursor, context);
			for (const e of p.items) if (InputEntry.is(e) && e.data?.userId) return { userId: e.data.userId, orgId: e.data.orgId };
			if (!p.next) break;
			cursor = p.next;
		}
		const rec = await harness.commit((tx) => tx.conversation(cid(conversationId)), context);
		if (rec?.owner) return this.principalOfRun(harness, rec.owner.conversationId as number, context, depth + 1);
		return null;
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
		if (row && action === "write" && row.archived) throw new HttpError(409, "archived", "会话已归档");
		return { harness, conv, row, record };
	}

	summary(spaceId: string, conversationId: number, row: CatalogRow | undefined, record?: ConversationRecord, status?: ConversationSummary["status"]): ConversationSummary {
		const base: ConversationSummary = row
			? {
					spaceId,
					conversationId,
					title: row.title,
					kind: row.kind,
					...(row.project_id ? { projectId: row.project_id } : {}),
					createdBy: row.created_by,
					createdAt: row.created_at,
					updatedAt: row.updated_at,
					archived: !!row.archived,
				}
			: { spaceId, conversationId, title: `子任务会话 #${conversationId}`, kind: "subagent", createdBy: "", createdAt: "", updatedAt: "", archived: false };
		return {
			...base,
			...(record?.parent ? { parent: { conversationId: record.parent.conversationId as number, entryId: record.parent.at as number } } : {}),
			...(record?.owner ? { owner: { conversationId: record.owner.conversationId as number, taskId: record.owner.taskId as number } } : {}),
			...(status ? { status } : {}),
		};
	}

	async list(p: Principal, q: { spaceId?: string; projectId?: string; q?: string; limit?: number; archived?: boolean }, context: Context): Promise<ConversationSummary[]> {
		const identity = this.ctx.services.get("identity");
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
		const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
		const params: any[] = spaces.map((s) => s.id);
		let sql = `SELECT * FROM rt_conversations WHERE space_id IN (${spaces.map(() => "?").join(",")}) AND archived = ?`;
		params.push(q.archived ? 1 : 0);
		if (q.q?.trim()) {
			sql += " AND title LIKE ?";
			params.push(`%${q.q.trim()}%`);
		}
		sql += " ORDER BY updated_at DESC LIMIT ?";
		params.push(limit);
		const rows = this.ctx.db.all<CatalogRow>(sql, ...params);
		const out: ConversationSummary[] = [];
		for (const r of rows) {
			const h = this.manager.openHarness(r.space_id);
			if (!h) {
				out.push(this.summary(r.space_id, r.conversation_id, r));
				continue;
			}
			try {
				const record = await h.commit((tx) => tx.conversation(cid(r.conversation_id)), context);
				const live = await h.snapshot(LiveDoc, cid(r.conversation_id), context);
				out.push(this.summary(r.space_id, r.conversation_id, r, record, live?.run ? "running" : undefined));
			} catch {
				out.push(this.summary(r.space_id, r.conversation_id, r));
			}
		}
		return out;
	}

	touch(spaceId: string, conversationId: number): void {
		this.ctx.db.run("UPDATE rt_conversations SET updated_at = ? WHERE space_id = ? AND conversation_id = ?", nowIso(), spaceId, conversationId);
	}

	async patch(p: Principal, spaceId: string, conversationId: number, body: { title?: string; archived?: boolean }, context: Context): Promise<ConversationSummary> {
		await this.require(p, "write", spaceId, conversationId);
		const row = this.row(spaceId, conversationId);
		if (!row) throw new HttpError(404, "not_found", "会话不存在");
		if (body.title !== undefined) {
			const t = String(body.title).trim();
			if (!t || t.length > 200) throw new HttpError(400, "invalid_title", "标题不能为空且不超过 200 字");
			this.ctx.db.run("UPDATE rt_conversations SET title = ?, updated_at = ? WHERE space_id = ? AND conversation_id = ?", t, nowIso(), spaceId, conversationId);
		}
		if (body.archived !== undefined) this.ctx.db.run("UPDATE rt_conversations SET archived = ?, updated_at = ? WHERE space_id = ? AND conversation_id = ?", body.archived ? 1 : 0, nowIso(), spaceId, conversationId);
		const { record } = await this.access(p, "read", spaceId, conversationId, context);
		return this.summary(spaceId, conversationId, this.row(spaceId, conversationId), record);
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

	/** Resolve a request's modelId: platform id (models service) or "provider/modelId". */
	async resolveModel(p: Principal, modelId: string | undefined): Promise<ModelRef | undefined> {
		if (!modelId) return undefined;
		if (this.ctx.services.has("models")) {
			const list = await this.ctx.services.get("models").listFor(p);
			const m = list.find((x) => x.id === modelId);
			if (m) {
				if (m.status === "blocked") throw new HttpError(409, "model_blocked", `模型不可用：${m.statusDetail ?? "未配置凭据"}`);
				return m.ref;
			}
		}
		const [provider, ...rest] = modelId.split("/");
		if (provider && rest.length) {
			if (!this.manager.models().getModel(provider, rest.join("/"))) throw new HttpError(400, "unknown_model", "未知模型");
			return { provider, modelId: rest.join("/") };
		}
		throw new HttpError(400, "unknown_model", "未知模型");
	}

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

	async submit(p: Principal, spaceId: string, conversationId: number, input: InputEntryData & { requestId: string; whenBusy?: "steer" | "followUp" | "reject" }, context: Context): Promise<SubmissionDTO> {
		if (typeof input.requestId !== "string" || !input.requestId || input.requestId.length > 200) throw new HttpError(400, "invalid_request_id", "requestId 必填");
		if (typeof input.text !== "string" || !input.text.trim()) throw new HttpError(400, "empty", "消息不能为空");
		if (input.text.length > 100_000) throw new HttpError(413, "too_long", "消息过长");
		const { harness, conv, row } = await this.access(p, "write", spaceId, conversationId, context);
		if (!row) throw new HttpError(409, "read_only", "子任务会话只读");
		if (this.ctx.services.has("budget")) {
			const b = await this.ctx.services.get("budget").checkSubmit(p, spaceId, row.project_id ?? undefined);
			if (!b.allow) throw new HttpError(402, "budget_exceeded", `预算不足：${b.reason}`, { reason: b.reason });
		}
		const data: InputEntryData = {
			text: input.text,
			userId: p.userId,
			orgId: p.orgId,
			...(input.attachments?.length ? { attachments: input.attachments } : {}),
			...(input.knowledgeRefs?.length ? { knowledgeRefs: input.knowledgeRefs } : {}),
			...(input.via ? { via: input.via } : {}),
		};
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
			const t = input.text.replace(/\[\[[^\]]*\]\]/g, "").trim().split("\n")[0]!.slice(0, 40);
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
			title?.trim() || `${row?.title ?? "会话"}（分支）`,
			row?.project_id ?? null,
			now,
			now,
		);
		const record = await harness.commit((tx) => tx.conversation(fork.id), context);
		return { conv: fork, summary: this.summary(spaceId, fork.id as number, this.row(spaceId, fork.id as number), record) };
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

	async abort(p: Principal, spaceId: string, conversationId: number, body: { background?: boolean }, context: Context): Promise<void> {
		const { conv } = await this.access(p, "write", spaceId, conversationId, context);
		await conv.abort(context, body.background ? { background: true } : undefined);
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

	toDTOs(entries: readonly EntryRecord[]): EntryDTO[] {
		const names = new Map<string, string | undefined>();
		const name = (u: string) => {
			if (!names.has(u)) names.set(u, this.userName(u));
			return names.get(u);
		};
		return entries.filter((e) => e.kind !== "pi.system").map((e) => entryDTO(e, name));
	}

	async entries(p: Principal, spaceId: string, conversationId: number, q: { before?: number; limit?: number }, context: Context): Promise<EntriesPage> {
		const { conv } = await this.access(p, "read", spaceId, conversationId, context);
		const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
		const query = q.before ? { maxEntryId: (Number(q.before) - 1) as EntryId, order: "descending" as const } : { order: "descending" as const };
		const page = await conv.entries(query, limit, undefined, context);
		const items = [...page.items].reverse();
		return { items: this.toDTOs(items), ...(page.next && items.length ? { next: items[0]!.id as number } : {}) };
	}

	async agentDTO(harness: Harness, conv: Conversation, context: Context): Promise<AgentDTO> {
		const agent = await conv.agent(context);
		const ad = await harness.snapshot(AssistantDoc, conv.id, context);
		let assistant: AssistantDTO | undefined;
		if (ad?.assistantId) assistant = this.assistants?.byId(ad.assistantId);
		return {
			...(agent.model ? { model: { provider: agent.model.provider, modelId: agent.model.modelId } } : {}),
			thinkingLevel: agent.thinkingLevel,
			fixture: isFixtureModel(agent.model),
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
				if (rec?.parent && (rec.parent.conversationId as number) === conversationId) branches.push(this.summary(spaceId, r.conversation_id, r, rec));
			});
		}
		const live = await harness.snapshot(LiveDoc, conv.id, context);
		return {
			conversation: this.summary(spaceId, conversationId, row, record, live?.run ? "running" : undefined),
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
	async state(spaceId: string, harness: Harness, conv: Conversation, view: { entries: readonly EntryRecord[]; before?: EntryId; docs: Record<string, any>; conversation: ConversationRecord }, revision: number, context: Context): Promise<ConversationState> {
		const conversationId = conv.id as number;
		const { approvals, effects, subagents } = await this.docs(harness, conversationId, context);
		const live = view.docs[LiveDoc.definition.kind];
		const hasAnswer = view.before !== undefined || view.entries.some((e) => e.kind === "pi.assistant");
		const ld = liveDTO(live, approvals, hasAnswer);
		return {
			conversation: this.summary(spaceId, conversationId, this.row(spaceId, conversationId), view.conversation, ld.status),
			entries: this.toDTOs(view.entries),
			hasEarlier: view.before !== undefined,
			live: ld,
			queue: queueDTO(view.docs[InboxDoc.definition.kind]),
			approvals,
			effects,
			subagents,
			usage: usageFromState(view.docs[UsageDoc.definition.kind]),
			agent: await this.agentDTO(harness, conv, context),
			revision,
			at: nowIso(),
		};
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
