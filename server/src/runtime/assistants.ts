// Assistant identities (M03-A): name, avatar, description, default model/tools/knowledge and team members, stored
// separately from conversations and runs (rt_assistants). A conversation binds an assistant at creation; the binding
// and a snapshot of its member declarations live in the conversation's `wr.assistant` pi document.
import type { AppContext, Principal } from "../core/contracts.ts";
import { HttpError, newId, nowIso } from "../core/http.ts";
import type { AssistantDTO, MemberDeclaration, MemberType } from "../../../shared/chat.ts";

const MEMBER_TYPES: readonly MemberType[] = ["builtin_subagent", "external_tool", "third_party_agent"];

/** Default team used when a conversation has no assistant (or the assistant declares no members). */
export const BUILTIN_MEMBERS: readonly MemberDeclaration[] = [
	{ id: "researcher", name: "资料研究员", type: "builtin_subagent", description: "检索资料并总结要点（只读）", tools: ["kb_search"], maxTurns: 4, instructions: "你是资料研究员。只做检索与归纳，不执行任何写操作。" },
	{ id: "writer", name: "写作助手", type: "builtin_subagent", description: "根据给定材料起草文字（不使用工具）", tools: [], maxTurns: 2, instructions: "你是写作助手。只根据任务中给出的材料写作。" },
];

export const BUILTIN_ASSISTANT: AssistantDTO = {
	id: "builtin:workroom",
	name: "Workroom 助手",
	description: "默认通用工作助手",
	members: BUILTIN_MEMBERS,
	scope: "org",
	createdBy: "system",
	createdAt: "1970-01-01T00:00:00.000Z",
	updatedAt: "1970-01-01T00:00:00.000Z",
	builtin: true,
};

interface Row {
	id: string;
	org_id: string;
	scope: "personal" | "org";
	owner_user_id: string;
	name: string;
	avatar: string | null;
	description: string;
	instructions: string | null;
	model: string | null;
	tools: string | null;
	knowledge: string | null;
	members: string;
	created_at: string;
	updated_at: string;
	archived_at: string | null;
}

export function validateMember(m: any, i: number): MemberDeclaration {
	if (!m || typeof m !== "object") throw new HttpError(400, "invalid_member", `成员 #${i + 1} 无效`);
	const id = String(m.id ?? "").trim();
	if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new HttpError(400, "invalid_member", `成员 #${i + 1} 的 id 只能包含字母数字 _ -`);
	if (!MEMBER_TYPES.includes(m.type)) throw new HttpError(400, "invalid_member", `成员 ${id} 的 type 必须是 ${MEMBER_TYPES.join(" / ")}`);
	if (!Array.isArray(m.tools) || m.tools.some((t: unknown) => typeof t !== "string")) throw new HttpError(400, "invalid_member", `成员 ${id} 必须显式声明 tools 白名单（可为空数组）`);
	const maxTurns = Number(m.maxTurns ?? 6);
	if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 50) throw new HttpError(400, "invalid_member", `成员 ${id} 的 maxTurns 必须是 1–50 的整数`);
	if ((m.type === "external_tool" || m.type === "third_party_agent") && !m.connectorId) throw new HttpError(400, "invalid_member", `成员 ${id}（${m.type}）必须声明 connectorId`);
	return {
		id,
		name: String(m.name ?? id).slice(0, 60),
		type: m.type,
		...(m.description ? { description: String(m.description).slice(0, 500) } : {}),
		...(m.model?.provider && m.model?.modelId ? { model: { provider: String(m.model.provider), modelId: String(m.model.modelId) } } : {}),
		...(m.thinkingLevel ? { thinkingLevel: m.thinkingLevel } : {}),
		tools: m.tools.filter((t: string) => t !== "delegate"),
		...(m.knowledgeScope?.kbIds ? { knowledgeScope: { kbIds: m.knowledgeScope.kbIds.map(String) } } : {}),
		maxTurns,
		...(m.budget ? { budget: { ...(m.budget.maxTokens ? { maxTokens: Number(m.budget.maxTokens) } : {}), ...(m.budget.maxCostUsd ? { maxCostUsd: Number(m.budget.maxCostUsd) } : {}) } } : {}),
		...(m.instructions ? { instructions: String(m.instructions).slice(0, 4000) } : {}),
		...(m.connectorId ? { connectorId: String(m.connectorId) } : {}),
	};
}

export class AssistantStore {
	readonly #ctx: AppContext;
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}

	#dto(r: Row): AssistantDTO {
		return {
			id: r.id,
			name: r.name,
			...(r.avatar ? { avatar: r.avatar } : {}),
			description: r.description,
			...(r.instructions ? { instructions: r.instructions } : {}),
			...(r.model ? { model: JSON.parse(r.model) } : {}),
			...(r.tools ? { tools: JSON.parse(r.tools) } : {}),
			...(r.knowledge ? { knowledge: JSON.parse(r.knowledge) } : {}),
			members: JSON.parse(r.members),
			scope: r.scope,
			createdBy: r.owner_user_id,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
		};
	}

	byId(id: string): AssistantDTO | undefined {
		if (id === BUILTIN_ASSISTANT.id) return BUILTIN_ASSISTANT;
		const r = this.#ctx.db.get<Row>("SELECT * FROM rt_assistants WHERE id = ?", id);
		return r ? this.#dto(r) : undefined;
	}

	/** Visible to the principal: builtin, own personal ones, and org-scoped ones of the principal's org. */
	get(p: Principal, id: string): AssistantDTO | undefined {
		if (id === BUILTIN_ASSISTANT.id) return BUILTIN_ASSISTANT;
		const r = this.#ctx.db.get<Row>("SELECT * FROM rt_assistants WHERE id = ? AND archived_at IS NULL AND org_id = ? AND (scope = 'org' OR owner_user_id = ?)", id, p.orgId, p.userId);
		return r ? this.#dto(r) : undefined;
	}

	list(p: Principal): AssistantDTO[] {
		const rows = this.#ctx.db.all<Row>("SELECT * FROM rt_assistants WHERE archived_at IS NULL AND org_id = ? AND (scope = 'org' OR owner_user_id = ?) ORDER BY created_at", p.orgId, p.userId);
		return [BUILTIN_ASSISTANT, ...rows.map((r) => this.#dto(r))];
	}

	#validate(b: any, partial: boolean) {
		const out: Record<string, unknown> = {};
		if (!partial || b.name !== undefined) {
			const name = String(b.name ?? "").trim();
			if (!name || name.length > 60) throw new HttpError(400, "invalid_name", "助手名称必填且不超过 60 字");
			out.name = name;
		}
		if (b.avatar !== undefined) out.avatar = b.avatar ? String(b.avatar).slice(0, 2000) : null;
		if (b.description !== undefined || !partial) out.description = String(b.description ?? "").slice(0, 2000);
		if (b.instructions !== undefined) out.instructions = b.instructions ? String(b.instructions).slice(0, 8000) : null;
		if (b.model !== undefined) out.model = b.model?.provider && b.model?.modelId ? JSON.stringify({ provider: String(b.model.provider), modelId: String(b.model.modelId) }) : null;
		if (b.tools !== undefined) out.tools = Array.isArray(b.tools) ? JSON.stringify(b.tools.map(String)) : null;
		if (b.knowledge !== undefined) out.knowledge = b.knowledge?.kbIds ? JSON.stringify({ kbIds: b.knowledge.kbIds.map(String) }) : null;
		if (b.members !== undefined || !partial) {
			const members = Array.isArray(b.members) ? b.members.map(validateMember) : [];
			if (new Set(members.map((m: MemberDeclaration) => m.id)).size !== members.length) throw new HttpError(400, "invalid_member", "成员 id 重复");
			out.members = JSON.stringify(members);
		}
		return out;
	}

	async create(p: Principal, b: any): Promise<AssistantDTO> {
		const scope = b.scope === "org" ? "org" : "personal";
		if (scope === "org") await this.#ctx.services.get("acl").require(p, "admin", { kind: "org", id: p.orgId });
		const v = this.#validate(b, false);
		const id = newId("ast");
		const now = nowIso();
		this.#ctx.db.run(
			"INSERT INTO rt_assistants (id, org_id, scope, owner_user_id, name, avatar, description, instructions, model, tools, knowledge, members, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			id,
			p.orgId,
			scope,
			p.userId,
			v.name as string,
			(v.avatar as string) ?? null,
			v.description as string,
			(v.instructions as string) ?? null,
			(v.model as string) ?? null,
			(v.tools as string) ?? null,
			(v.knowledge as string) ?? null,
			v.members as string,
			now,
			now,
		);
		return this.byId(id)!;
	}

	async #own(p: Principal, id: string): Promise<Row> {
		const r = this.#ctx.db.get<Row>("SELECT * FROM rt_assistants WHERE id = ? AND archived_at IS NULL AND org_id = ?", id, p.orgId);
		if (!r || (r.scope === "personal" && r.owner_user_id !== p.userId)) throw new HttpError(404, "assistant_not_found", "助手不存在");
		if (r.scope === "org") await this.#ctx.services.get("acl").require(p, "admin", { kind: "org", id: p.orgId });
		return r;
	}

	async update(p: Principal, id: string, b: any): Promise<AssistantDTO> {
		if (id === BUILTIN_ASSISTANT.id) throw new HttpError(403, "builtin", "内置助手不可修改");
		await this.#own(p, id);
		const v = this.#validate(b, true);
		const cols = Object.keys(v);
		if (cols.length) this.#ctx.db.run(`UPDATE rt_assistants SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...(cols.map((c) => v[c] ?? null) as any[]), nowIso(), id);
		return this.byId(id)!;
	}

	async archive(p: Principal, id: string): Promise<void> {
		if (id === BUILTIN_ASSISTANT.id) throw new HttpError(403, "builtin", "内置助手不可删除");
		await this.#own(p, id);
		this.#ctx.db.run("UPDATE rt_assistants SET archived_at = ? WHERE id = ?", nowIso(), id);
	}
}
