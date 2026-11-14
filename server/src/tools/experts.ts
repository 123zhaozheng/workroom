// Experts (round 17): the former 「助手」 as first-class marketplace objects. Configuration + immutable published versions; submission /
// review / publish reuse Market (kind "expert", unified 审查员 permission). Skills are attached BY ID and resolved on every run to their
// CURRENT usable version — an expert never holds a skill snapshot, so a skill update reaches the expert's next run without touching it.
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, section, type Extension } from "@earendil-works/pi-durable";
import type { AppContext, Principal, Space } from "../core/contracts.ts";
import { HttpError, newId, nowIso } from "../core/http.ts";
import { EXPERT_CATEGORIES, type ExpertConfigDTO, type ExpertDTO, type ExpertScope, type ExpertSkillDTO, type ExpertStatus, type MentionableExpertDTO } from "../../../shared/experts.ts";
import type { PackageCheckDTO, PackageFindingDTO, SubmissionDetailDTO, SubmissionDTO } from "../../../shared/files.ts";
import type { Market, SubRow, SubmissionKindHandler } from "./market.ts";
import type { Skills } from "./skills.ts";

export const EXPERT_MIGRATIONS = [
	{
		version: 1,
		name: "experts (round 17): configuration, immutable versions, installs",
		sql: `
CREATE TABLE ex_experts (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, name TEXT NOT NULL, avatar TEXT, tagline TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '通用', tags TEXT NOT NULL DEFAULT '[]', instructions TEXT NOT NULL DEFAULT '',
  opening TEXT NOT NULL DEFAULT '', starters TEXT NOT NULL DEFAULT '[]', default_model TEXT, skills TEXT NOT NULL DEFAULT '[]',
  connectors TEXT NOT NULL DEFAULT '[]', knowledge TEXT, tools TEXT, scope TEXT NOT NULL DEFAULT 'personal', scope_ref TEXT,
  published_version_no INTEGER, latest_version_no INTEGER NOT NULL DEFAULT 0, listed INTEGER NOT NULL DEFAULT 0, unpublished_reason TEXT,
  source TEXT NOT NULL DEFAULT 'user', legacy_updated_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
);
CREATE INDEX ex_experts_org ON ex_experts(org_id, scope);
CREATE TABLE ex_versions (
  id TEXT PRIMARY KEY, expert_id TEXT NOT NULL REFERENCES ex_experts(id), version_no INTEGER NOT NULL, config TEXT NOT NULL, change_note TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (expert_id, version_no)
);
CREATE TRIGGER ex_versions_no_update BEFORE UPDATE ON ex_versions BEGIN SELECT RAISE(ABORT, 'expert versions are immutable'); END;
CREATE TABLE ex_installs (expert_id TEXT NOT NULL, user_id TEXT NOT NULL, installed_at TEXT NOT NULL, PRIMARY KEY (expert_id, user_id));
`,
	},
];

interface Row {
	id: string;
	org_id: string;
	owner_user_id: string;
	name: string;
	avatar: string | null;
	tagline: string;
	description: string;
	category: string;
	tags: string;
	instructions: string;
	opening: string;
	starters: string;
	default_model: string | null;
	skills: string;
	connectors: string;
	knowledge: string | null;
	tools: string | null;
	scope: ExpertScope;
	scope_ref: string | null;
	published_version_no: number | null;
	latest_version_no: number;
	listed: number;
	unpublished_reason: string | null;
	source: "user" | "assistant";
	legacy_updated_at: string | null;
	created_at: string;
	updated_at: string;
	archived_at: string | null;
}
interface VerRow {
	id: string;
	expert_id: string;
	version_no: number;
	config: string;
	change_note: string | null;
	created_by: string;
	created_at: string;
}

const INJECTION = /(忽略|无视|忘记)(之前|以上|上面|所有)的?(指令|规则|提示)|ignore (all |any )?(previous|prior|above) (instructions|rules)|system prompt|越狱/i;
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const json = <T>(s: string | null | undefined, d: T): T => {
	try {
		return s ? (JSON.parse(s) as T) : d;
	} catch {
		return d;
	}
};

/** "@名称" → expert id. Only the given candidates are matched; the longest name wins; the name must end at a boundary (space, punctuation, end). */
export function parseMention(text: string, candidates: readonly { id: string; name: string }[]): { id: string; name: string } | undefined {
	let best: { id: string; name: string } | undefined;
	for (const c of candidates) {
		if (!c.name) continue;
		let from = 0;
		for (;;) {
			const i = text.indexOf(`@${c.name}`, from);
			if (i < 0) break;
			const end = i + 1 + c.name.length;
			const before = i === 0 ? "" : text[i - 1]!;
			const after = end >= text.length ? "" : text[end]!;
			if ((!before || /[\s，。,.;；:：!！?？(（]/.test(before)) && (!after || /[\s，。,.;；:：!！?？)）]/.test(after))) {
				if (!best || c.name.length > best.name.length) best = c;
				break;
			}
			from = i + 1;
		}
	}
	return best;
}

export class Experts {
	readonly #ctx: AppContext;
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}
	get #db() {
		return this.#ctx.db;
	}
	get #market(): Market {
		return this.#ctx.services.get("market") as Market;
	}
	get #skills(): Skills {
		return this.#ctx.services.get("skills") as Skills;
	}
	#rt(): any {
		return this.#ctx.services.has("runtime") ? (this.#ctx.services.get("runtime") as any) : null;
	}

	// ------------------------------------------------------------ rows, configuration, assistants migration
	row(id: string): Row | undefined {
		return this.#db.get<Row>("SELECT * FROM ex_experts WHERE id = ?", id);
	}
	version(id: string, no: number): VerRow | undefined {
		return this.#db.get<VerRow>("SELECT * FROM ex_versions WHERE expert_id = ? AND version_no = ?", id, no);
	}
	#config(r: Row): ExpertConfigDTO {
		return {
			name: r.name,
			...(r.avatar ? { avatar: r.avatar } : {}),
			tagline: r.tagline,
			description: r.description,
			category: r.category,
			tags: json<string[]>(r.tags, []),
			instructions: r.instructions,
			opening: r.opening,
			starters: json<string[]>(r.starters, []),
			defaultModel: json(r.default_model, null),
			skills: json(r.skills, []),
			connectors: json(r.connectors, []),
			knowledge: json(r.knowledge, null),
			tools: json(r.tools, null),
		};
	}
	/** What the viewer runs: the author their draft, everyone else the published version's snapshot. */
	effective(p: Principal, r: Row): ExpertConfigDTO | undefined {
		if (r.owner_user_id === p.userId) return this.#config(r);
		if (!r.published_version_no || !r.listed) return undefined;
		const v = this.version(r.id, r.published_version_no);
		return v ? (JSON.parse(v.config) as ExpertConfigDTO) : undefined;
	}
	#snapshot(r: Row, by: string, note?: string): VerRow {
		const no = r.latest_version_no + 1;
		const id = newId("exv");
		this.#db.run("INSERT INTO ex_versions (id, expert_id, version_no, config, change_note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, r.id, no, JSON.stringify(this.#config(r)), note?.slice(0, 500) ?? null, by, nowIso());
		this.#db.run("UPDATE ex_experts SET latest_version_no = ? WHERE id = ?", no, r.id);
		r.latest_version_no = no;
		return this.version(r.id, no)!;
	}

	/** Old 助手 (rt_assistants) → experts, lazily and idempotently: same id, org assistants arrive published (they were already shared). */
	syncAssistants(orgId: string): void {
		if (!this.#db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rt_assistants'")) return;
		const rows = this.#db.all<any>("SELECT * FROM rt_assistants WHERE org_id = ?", orgId);
		for (const a of rows) {
			const cur = this.row(a.id);
			if (a.archived_at) {
				if (cur && !cur.archived_at) this.#db.run("UPDATE ex_experts SET archived_at = ?, listed = 0 WHERE id = ?", a.archived_at, a.id);
				continue;
			}
			if (cur && cur.legacy_updated_at === a.updated_at) continue;
			const vals = [a.name, a.avatar, str(a.description, 80), a.description ?? "", a.instructions ?? "", a.model, a.knowledge, a.tools, a.scope === "org" ? "org" : "personal", a.updated_at] as const;
			if (!cur) {
				this.#db.run(
					"INSERT INTO ex_experts (id, org_id, owner_user_id, name, avatar, tagline, description, instructions, default_model, knowledge, tools, scope, source, legacy_updated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'assistant', ?, ?, ?)",
					a.id, a.org_id, a.owner_user_id, vals[0], vals[1], vals[2], vals[3], vals[4], vals[5], vals[6], vals[7], vals[8], vals[9], a.created_at, a.updated_at,
				);
			} else {
				this.#db.run("UPDATE ex_experts SET name = ?, avatar = ?, tagline = ?, description = ?, instructions = ?, default_model = ?, knowledge = ?, tools = ?, scope = ?, legacy_updated_at = ?, updated_at = ? WHERE id = ?", vals[0], vals[1], vals[2], vals[3], vals[4], vals[5], vals[6], vals[7], vals[8], vals[9], a.updated_at, a.id);
			}
			if (a.scope === "org") {
				const r = this.row(a.id)!;
				const v = this.#snapshot(r, a.owner_user_id, "由旧助手迁移");
				this.#db.run("UPDATE ex_experts SET published_version_no = ?, listed = 1 WHERE id = ?", v.version_no, a.id);
			}
		}
	}

	// ------------------------------------------------------------ visibility
	#visibleTo(p: Principal, r: Row): boolean {
		if (r.org_id !== p.orgId || r.archived_at) return false;
		if (r.owner_user_id === p.userId) return true;
		if (!r.listed || !r.published_version_no) return false;
		if (r.scope === "org") return true;
		if (r.scope === "department") return !!r.scope_ref && this.#market.deptScope(p).has(r.scope_ref);
		return false;
	}
	/** The expert if the principal may see it (else undefined). */
	resolve(p: Principal, id: string): Row | undefined {
		this.syncAssistants(p.orgId);
		const r = this.row(id);
		return r && this.#visibleTo(p, r) ? r : undefined;
	}
	#statusOf(r: Row): { status: ExpertStatus; updatePending: boolean } {
		const pending = !!this.#db.get("SELECT 1 FROM market_submissions WHERE kind = 'expert' AND subject_id = ? AND state = 'pending_review'", r.id);
		if (r.published_version_no) return { status: r.listed ? "published" : "unpublished", updatePending: pending };
		return { status: pending ? "pending" : "draft", updatePending: false };
	}

	// ------------------------------------------------------------ skill resolution (the decoupled mount)
	/** Each mounted skill as it resolves NOW for `p`: its current usable version, or why it is skipped. Never cached, never a snapshot. */
	async resolveSkills(p: Principal, refs: readonly { skillId: string }[]): Promise<ExpertSkillDTO[]> {
		const out: ExpertSkillDTO[] = [];
		const canUse = await this.#market.can(p, "skill.use");
		for (const { skillId } of refs) {
			const s = this.#skills.skill(skillId);
			if (!s || s.org_id !== p.orgId || s.status !== "active") {
				out.push({ skillId, name: s?.name ?? "（已删除的技能）", state: "missing", message: "技能已不存在" });
				continue;
			}
			if (!canUse) {
				out.push({ skillId, name: s.name, state: "no_permission", message: "你没有使用技能的权限" });
				continue;
			}
			const d = await this.#ctx.services.get("acl").check(p, "use", { kind: "skill", id: s.id });
			if (!d.allow && d.reason === "unlisted") {
				out.push({ skillId, name: s.name, state: "unlisted", message: `技能「${s.name}」已下架${s.unpublished_reason ? `：${s.unpublished_reason}` : ""}` });
				continue;
			}
			if (!d.allow) {
				out.push({ skillId, name: s.name, state: "forbidden", message: s.scope === "personal" ? "这是作者的个人技能，你无权使用" : "你无权使用该技能" });
				continue;
			}
			const v = this.#skills.version(s.id, this.#market.latestUsable(s));
			if (!v) {
				out.push({ skillId, name: s.name, state: "unapproved", message: "还没有通过审核的版本" });
				continue;
			}
			const u = this.#market.usable(s, v);
			if (!u.ok) {
				out.push({ skillId, name: s.name, state: u.reason === "unlisted" ? "unlisted" : "unapproved", message: u.message });
				continue;
			}
			out.push({ skillId, name: s.name, slug: this.#market.slugOf(s), description: v.description, versionNo: v.version_no, ...(v.semver ? { semver: v.semver } : {}), state: "ok" });
		}
		return out;
	}
	/** Skill ids the conversation's current expert mounts for `p` (used by Skills.active / resolveForUse so no separate install is needed). */
	async mountedSkillIds(p: Principal, space: Space | undefined, conversationId: number | undefined): Promise<string[]> {
		if (!space || conversationId == null) return [];
		const rt = this.#rt();
		if (!rt?.expertForRun) return [];
		const cur = (await rt.expertForRun(space.id, conversationId).catch(() => undefined)) as { expertId?: string } | undefined;
		if (!cur?.expertId) return [];
		const r = this.resolve(p, cur.expertId);
		const cfg = r && this.effective(p, r);
		return cfg ? cfg.skills.map((x) => x.skillId) : [];
	}

	/** The system-prompt text of an expert for `p` (fresh on every run). */
	async promptFor(p: Principal, expertId: string, opts: { skipInstructions?: boolean } = {}): Promise<string | undefined> {
		const r = this.resolve(p, expertId);
		const cfg = r && this.effective(p, r);
		if (!cfg) return undefined;
		const skills = await this.resolveSkills(p, cfg.skills);
		const ok = skills.filter((s) => s.state === "ok");
		const skipped = skills.filter((s) => s.state !== "ok");
		const lines = [`## 专家：${cfg.name}`, ...(cfg.tagline ? [cfg.tagline] : []), ...(!opts.skipInstructions && cfg.instructions ? ["", cfg.instructions] : [])];
		if (ok.length) lines.push("", "专家挂载的技能（始终是技能当前已发布的版本；用 read 读取 /skills/<slug>/SKILL.md 了解用法）：", ...ok.map((s) => `- ${s.name} v${s.versionNo} (/skills/${s.slug}) — ${(s.description ?? "").replace(/\s+/g, " ").slice(0, 120)}`));
		if (skipped.length) lines.push("", "以下挂载技能本次暂不可用，已跳过（不要假设能使用它们，必要时告诉用户）：", ...skipped.map((s) => `- ${s.name}：${s.message}`));
		return lines.join("\n");
	}

	// ------------------------------------------------------------ DTOs
	async #dto(p: Principal, r: Row, opts: { forList?: boolean } = {}): Promise<ExpertDTO> {
		const mine = r.owner_user_id === p.userId;
		const cfg = this.effective(p, r) ?? this.#config(r);
		const st = this.#statusOf(r);
		const model = cfg.defaultModel;
		let availability: ExpertDTO["modelAvailability"];
		if (model && this.#rt()?.checkModel) {
			const chk = await this.#rt().checkModel(p, model);
			availability = chk.ok ? { status: "ok" } : { status: chk.code === "model_blocked" ? "blocked" : "not_allowed", reason: chk.reason };
		}
		const owner = await this.#ctx.services.get("identity").principalFor(r.owner_user_id, r.org_id).catch(() => null);
		const publishedCfg = r.published_version_no ? (JSON.parse(this.version(r.id, r.published_version_no)?.config ?? "null") as ExpertConfigDTO | null) : null;
		return {
			id: r.id,
			name: cfg.name,
			...(cfg.avatar ? { avatar: cfg.avatar } : {}),
			tagline: cfg.tagline,
			description: cfg.description,
			category: cfg.category,
			tags: cfg.tags,
			...(mine ? { instructions: cfg.instructions } : {}),
			opening: cfg.opening,
			starters: cfg.starters,
			defaultModel: model,
			...(availability ? { modelAvailability: availability } : {}),
			skills: opts.forList ? cfg.skills.map((s) => ({ skillId: s.skillId, name: this.#skills.skill(s.skillId)?.name ?? "技能", state: "ok" as const })) : await this.resolveSkills(p, cfg.skills),
			connectors: cfg.connectors.map((c) => ({ connectorId: c.connectorId })),
			knowledge: cfg.knowledge,
			tools: cfg.tools,
			scope: r.scope,
			...(r.scope_ref ? { scopeRef: r.scope_ref } : {}),
			status: st.status,
			...(st.updatePending ? { updatePending: true } : {}),
			...(mine && publishedCfg && JSON.stringify(publishedCfg) !== JSON.stringify(this.#config(r)) ? { dirty: true } : {}),
			...(r.published_version_no ? { publishedVersionNo: r.published_version_no } : {}),
			...(r.unpublished_reason ? { unpublishedReason: r.unpublished_reason } : {}),
			source: r.source,
			ownerId: r.owner_user_id,
			...(owner ? { ownerName: owner.displayName } : {}),
			mine,
			installed: !!this.#db.get("SELECT 1 FROM ex_installs WHERE expert_id = ? AND user_id = ?", r.id, p.userId),
			canEdit: mine,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
		};
	}

	async list(p: Principal, q: { q?: string; category?: string; scope?: string; mine?: string; installed?: string } = {}): Promise<ExpertDTO[]> {
		this.syncAssistants(p.orgId);
		const rows = this.#db.all<Row>("SELECT * FROM ex_experts WHERE org_id = ? AND archived_at IS NULL ORDER BY updated_at DESC", p.orgId).filter((r) => this.#visibleTo(p, r));
		const needle = q.q?.trim().toLowerCase();
		const out: ExpertDTO[] = [];
		for (const r of rows) {
			const mine = r.owner_user_id === p.userId;
			if (q.mine === "1" ? !mine : !(mine ? true : r.listed === 1)) continue;
			if (q.category && r.category !== q.category) continue;
			if (q.scope && r.scope !== q.scope) continue;
			if (q.installed === "1" && !this.#db.get("SELECT 1 FROM ex_installs WHERE expert_id = ? AND user_id = ?", r.id, p.userId)) continue;
			const dto = await this.#dto(p, r, { forList: true });
			if (needle && !`${dto.name} ${dto.tagline} ${dto.description} ${dto.tags.join(" ")}`.toLowerCase().includes(needle)) continue;
			out.push(dto);
		}
		return out;
	}
	categories(p: Principal): { category: string; count: number }[] {
		this.syncAssistants(p.orgId);
		const counts = new Map<string, number>(EXPERT_CATEGORIES.map((c) => [c, 0]));
		for (const r of this.#db.all<Row>("SELECT * FROM ex_experts WHERE org_id = ? AND archived_at IS NULL", p.orgId)) if (this.#visibleTo(p, r) && (r.listed === 1 || r.owner_user_id === p.userId)) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
		return [...counts].map(([category, count]) => ({ category, count }));
	}
	async mentionable(p: Principal): Promise<MentionableExpertDTO[]> {
		this.syncAssistants(p.orgId);
		const rows = this.#db.all<Row>("SELECT * FROM ex_experts WHERE org_id = ? AND archived_at IS NULL ORDER BY name", p.orgId).filter((r) => this.#visibleTo(p, r) && (r.owner_user_id === p.userId || r.listed === 1));
		const installed = new Set(this.#db.all<{ expert_id: string }>("SELECT expert_id FROM ex_installs WHERE user_id = ?", p.userId).map((x) => x.expert_id));
		return rows
			.map((r): MentionableExpertDTO => {
				const cfg = this.effective(p, r) ?? this.#config(r);
				return { id: r.id, name: cfg.name, ...(cfg.avatar ? { avatar: cfg.avatar } : {}), tagline: cfg.tagline, category: cfg.category, defaultModel: cfg.defaultModel, mine: r.owner_user_id === p.userId, installed: installed.has(r.id), status: this.#statusOf(r).status };
			})
			.sort((a, b) => Number(b.mine || b.installed) - Number(a.mine || a.installed) || a.name.localeCompare(b.name))
			.slice(0, 100);
	}
	async mentionIn(p: Principal, text: string): Promise<{ id: string; name: string } | undefined> {
		if (!text.includes("@")) return undefined;
		return parseMention(text, await this.mentionable(p));
	}
	async get(p: Principal, id: string): Promise<ExpertDTO> {
		const r = this.resolve(p, id);
		if (!r) throw new HttpError(404, "expert_not_found", "专家不存在或无权查看");
		return this.#dto(p, r);
	}

	// ------------------------------------------------------------ authoring
	async #clean(p: Principal, b: any, partial: boolean, cur?: Row): Promise<Record<string, unknown>> {
		const out: Record<string, unknown> = {};
		const has = (k: string) => b[k] !== undefined;
		if (!partial || has("name")) {
			const name = str(b.name, 40);
			if (!name) throw new HttpError(400, "invalid_name", "专家名称必填，且不超过 40 字");
			if (String(b.name).trim().length > 40) throw new HttpError(400, "invalid_name", "专家名称不超过 40 字");
			out.name = name;
		}
		if (has("avatar")) out.avatar = b.avatar ? str(b.avatar, 2000) : null;
		if (has("tagline")) out.tagline = str(b.tagline, 80);
		if (has("description")) out.description = str(b.description, 4000);
		if (has("category")) out.category = str(b.category, 20) || "通用";
		if (has("tags")) out.tags = JSON.stringify(Array.isArray(b.tags) ? [...new Set<string>(b.tags.map((t: unknown) => str(t, 20)).filter(Boolean))].slice(0, 8) : []);
		if (has("instructions")) out.instructions = str(b.instructions, 8000);
		if (has("opening")) out.opening = str(b.opening, 500);
		if (has("starters")) out.starters = JSON.stringify(Array.isArray(b.starters) ? b.starters.map((t: unknown) => str(t, 80)).filter(Boolean).slice(0, 6) : []);
		if (has("defaultModel")) {
			const m = b.defaultModel;
			if (m?.provider && m?.modelId) {
				const ref = { provider: String(m.provider), modelId: String(m.modelId) };
				const chk = this.#rt()?.checkModel ? await this.#rt().checkModel(p, ref) : { ok: true };
				if (!chk.ok) throw new HttpError(chk.code === "model_blocked" ? 409 : 400, chk.code, chk.reason);
				out.default_model = JSON.stringify(ref);
			} else out.default_model = null;
		}
		if (has("skills")) {
			if (!Array.isArray(b.skills) || b.skills.length > 20) throw new HttpError(400, "invalid_skills", "挂载技能最多 20 个");
			const ids = [...new Set<string>(b.skills.map((x: any) => String(typeof x === "string" ? x : x?.skillId ?? "")))].filter(Boolean);
			const visible = new Set((await this.#skills.visible(p)).map((s) => s.id));
			for (const id of ids) if (!visible.has(id)) throw new HttpError(400, "skill_not_found", "挂载的技能不存在或你无权使用");
			out.skills = JSON.stringify(ids.map((skillId) => ({ skillId })));
		}
		if (has("connectors")) {
			const ids = Array.isArray(b.connectors) ? [...new Set<string>(b.connectors.map((x: any) => String(typeof x === "string" ? x : x?.connectorId ?? "")))].filter(Boolean).slice(0, 10) : [];
			out.connectors = JSON.stringify(ids.map((connectorId) => ({ connectorId })));
		}
		if (has("knowledge")) out.knowledge = b.knowledge?.kbIds?.length ? JSON.stringify({ kbIds: b.knowledge.kbIds.map(String).slice(0, 20) }) : null;
		if (has("tools")) out.tools = Array.isArray(b.tools) ? JSON.stringify(b.tools.map(String)) : null;
		void cur;
		return out;
	}

	async create(p: Principal, b: any): Promise<ExpertDTO> {
		await this.#market.require(p, "expert.create", undefined, "没有创建专家的权限（expert.create）");
		this.syncAssistants(p.orgId);
		const v = await this.#clean(p, b, false);
		const id = newId("exp");
		const now = nowIso();
		const cols = ["id", "org_id", "owner_user_id", "created_at", "updated_at", ...Object.keys(v)];
		this.#db.run(`INSERT INTO ex_experts (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, id, p.orgId, p.userId, now, now, ...(Object.values(v) as any[]));
		this.#market.audit(p, "expert.create", id, { name: v.name });
		return this.get(p, id);
	}
	#own(p: Principal, id: string): Row {
		this.syncAssistants(p.orgId);
		const r = this.row(id);
		if (!r || r.org_id !== p.orgId || r.archived_at || r.owner_user_id !== p.userId) throw new HttpError(404, "expert_not_found", "专家不存在或不是你创建的");
		return r;
	}
	async update(p: Principal, id: string, b: any): Promise<ExpertDTO> {
		const r = this.#own(p, id);
		if (r.source === "assistant") throw new HttpError(409, "legacy_assistant", "这是由旧助手迁移来的专家，请用旧助手接口修改（团队成员声明仍存放在那里）");
		const v = await this.#clean(p, b, true, r);
		const cols = Object.keys(v);
		if (cols.length) this.#db.run(`UPDATE ex_experts SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...(Object.values(v) as any[]), nowIso(), id);
		return this.get(p, id);
	}
	async archive(p: Principal, id: string): Promise<void> {
		this.syncAssistants(p.orgId);
		const r = this.row(id);
		if (!r || r.org_id !== p.orgId || r.archived_at) throw new HttpError(404, "expert_not_found", "专家不存在");
		if (r.owner_user_id !== p.userId && !(await this.#market.isManager(p))) throw new HttpError(403, "forbidden", "只有作者或市场管理员可以删除专家");
		this.#db.run("UPDATE ex_experts SET archived_at = ?, listed = 0 WHERE id = ?", nowIso(), id);
		this.#market.audit(p, "expert.archive", id, {});
	}
	install(p: Principal, id: string, on: boolean): void {
		if (!this.resolve(p, id)) throw new HttpError(404, "expert_not_found", "专家不存在或无权查看");
		if (on) this.#db.run("INSERT INTO ex_installs (expert_id, user_id, installed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", id, p.userId, nowIso());
		else this.#db.run("DELETE FROM ex_installs WHERE expert_id = ? AND user_id = ?", id, p.userId);
	}

	// ------------------------------------------------------------ checks + submission
	async #checks(p: Principal, cfg: ExpertConfigDTO, target: ExpertScope, ref: string | null): Promise<PackageCheckDTO> {
		const f: PackageFindingDTO[] = [];
		const err = (code: string, message: string) => f.push({ severity: "error", code, message });
		const warn = (code: string, message: string) => f.push({ severity: "warn", code, message });
		if (!cfg.name) err("no_name", "缺少名称");
		if (!cfg.tagline) err("no_tagline", "缺少一句话简介");
		if (!cfg.instructions && !cfg.skills.length) err("empty", "既没有系统指令，也没有挂载技能，这个专家什么也做不了");
		if (cfg.instructions && INJECTION.test(cfg.instructions)) warn("injection", "系统指令里有疑似覆盖上层规则的措辞，请审查员留意");
		const skills = await this.resolveSkills(p, cfg.skills);
		for (const s of skills) {
			if (s.state === "missing") err("skill_missing", `挂载的技能「${s.name}」已不存在`);
			else if (s.state !== "ok") warn("skill_unusable", `挂载的技能「${s.name}」当前不可用：${s.message}`);
			else {
				const row = this.#skills.skill(s.skillId)!;
				if (row.scope === "personal" && target !== "personal") warn("skill_personal", `技能「${s.name}」是个人技能，其他人使用此专家时会被跳过；请先把它发布到部门或组织`);
				else if (row.scope === "department" && target === "org") warn("skill_scope", `技能「${s.name}」只对部门可见，组织内其他人使用此专家时会被跳过`);
				else if (row.scope === "department" && target === "department" && row.scope_ref !== ref) warn("skill_scope", `技能「${s.name}」属于另一个部门，目标部门的成员使用时会被跳过`);
			}
		}
		if (cfg.defaultModel && this.#rt()?.checkModel) {
			const chk = await this.#rt().checkModel(p, cfg.defaultModel);
			if (!chk.ok) warn("model_unavailable", `默认模型当前不可用：${chk.reason}（使用者会回退到自己的模型）`);
		}
		if (cfg.connectors.length) warn("connectors", "挂载了连接器：使用者需要自己已连接并有权使用这些连接器");
		return { ok: !f.some((x) => x.severity === "error"), at: nowIso(), findings: f, stats: { fileCount: 0, totalBytes: JSON.stringify(cfg).length, packageBytes: 0, scriptCount: 0 } };
	}
	async submit(p: Principal, id: string, input: { targetScope: ExpertScope; targetRef?: string; note?: string }): Promise<SubmissionDTO> {
		const r = this.#own(p, id);
		const target = input.targetScope;
		if (target === "personal") throw new HttpError(409, "not_required", "个人专家自己使用不需要审查；要分享给部门或组织请选择对应范围");
		if (target !== "department" && target !== "org") throw new HttpError(400, "invalid", "targetScope 必须是 department 或 org");
		if (target === "department" && !input.targetRef) throw new HttpError(400, "invalid", "部门范围需要 targetRef");
		await this.#market.require(p, "expert.publish", target === "org" ? { kind: "org" } : { kind: "department", id: input.targetRef! }, "没有向该范围发布专家的权限（expert.publish）");
		const cfg = this.#config(r);
		const checks = await this.#checks(p, cfg, target, input.targetRef ?? null);
		const ver = this.#snapshot(r, p.userId, input.note);
		const subId = this.#market.openSubmission(p, { kind: "expert", subjectId: id, subjectName: r.name, versionId: ver.id, versionNo: ver.version_no, target, ref: target === "org" ? null : (input.targetRef ?? null), note: input.note, checks });
		return this.#market.submissionDTO(p, subId);
	}

	// ------------------------------------------------------------ admin
	async unpublish(p: Principal, id: string, reason: string): Promise<ExpertDTO> {
		await this.#market.require(p, "market.manage", undefined, "只有市场管理员可以下架专家");
		if (!reason?.trim()) throw new HttpError(400, "reason_required", "下架必须填写理由");
		const r = this.row(id);
		if (!r || r.org_id !== p.orgId || r.archived_at) throw new HttpError(404, "expert_not_found", "专家不存在");
		if (!r.listed) throw new HttpError(409, "not_listed", "专家当前未上架");
		this.#db.tx(() => {
			this.#db.run("UPDATE ex_experts SET listed = 0, unpublished_reason = ?, updated_at = ? WHERE id = ?", reason.trim().slice(0, 500), nowIso(), id);
			this.#market.moveSubmissions("expert", id, "published", "unpublished", p, "unpublish", reason.trim());
		});
		this.#market.audit(p, "expert.unpublish", id, { reason });
		return this.#dto(p, this.row(id)!);
	}
	async republish(p: Principal, id: string): Promise<ExpertDTO> {
		await this.#market.require(p, "market.manage", undefined, "只有市场管理员可以重新上架专家");
		const r = this.row(id);
		if (!r || r.org_id !== p.orgId || r.archived_at) throw new HttpError(404, "expert_not_found", "专家不存在");
		if (r.listed || !r.published_version_no) throw new HttpError(409, "not_unlisted", "专家不是已下架状态");
		this.#db.tx(() => {
			this.#db.run("UPDATE ex_experts SET listed = 1, unpublished_reason = NULL, updated_at = ? WHERE id = ?", nowIso(), id);
			this.#market.moveSubmissions("expert", id, "unpublished", "published", p, "republish");
		});
		this.#market.audit(p, "expert.republish", id, {});
		return this.#dto(p, this.row(id)!);
	}
	async forcePublish(p: Principal, id: string, reason: string, target: { scope?: ExpertScope; ref?: string } = {}): Promise<SubmissionDTO> {
		await this.#market.require(p, "market.manage", undefined, "只有市场管理员可以强制发布");
		if (!reason?.trim()) throw new HttpError(400, "reason_required", "强制发布必须填写理由");
		const r = this.row(id);
		if (!r || r.org_id !== p.orgId || r.archived_at) throw new HttpError(404, "expert_not_found", "专家不存在");
		const scope = target.scope === "department" ? "department" : "org";
		const ver = this.#snapshot(r, p.userId, `强制发布：${reason.trim()}`);
		const subId = this.#market.directApproveOther(p, { kind: "expert", subjectId: id, subjectName: r.name, versionId: ver.id, versionNo: ver.version_no, target: scope, ref: scope === "org" ? null : (target.ref ?? null), note: `强制发布：${reason.trim()}`, checks: await this.#checks(p, this.#config(r), scope, target.ref ?? null) });
		this.#market.audit(p, "expert.force_publish", id, { reason });
		return this.#market.submissionDTO(p, subId);
	}

	// ------------------------------------------------------------ Market handler (review screen + what publishing does)
	handler(): SubmissionKindHandler {
		return {
			family: "expert",
			onPublished: (sub: SubRow) => {
				const v = this.#db.get<VerRow>("SELECT * FROM ex_versions WHERE id = ?", sub.version_id!);
				if (!v) return;
				this.#db.run("UPDATE ex_experts SET scope = ?, scope_ref = ?, published_version_no = MAX(COALESCE(published_version_no, 0), ?), listed = 1, unpublished_reason = NULL, updated_at = ? WHERE id = ?", sub.target_scope === "personal" ? "personal" : sub.target_scope, sub.target_scope === "org" ? null : sub.target_ref, v.version_no, nowIso(), v.expert_id);
			},
			onDecision: () => {},
			submissionInfo: (sub: SubRow): Partial<SubmissionDetailDTO> => {
				const v = this.#db.get<VerRow>("SELECT * FROM ex_versions WHERE id = ?", sub.version_id!);
				const cfg = v ? (JSON.parse(v.config) as ExpertConfigDTO) : undefined;
				const prev = v ? this.#db.get<VerRow>("SELECT * FROM ex_versions WHERE expert_id = ? AND version_no < ? ORDER BY (version_no = (SELECT published_version_no FROM ex_experts WHERE id = ?)) DESC, version_no DESC LIMIT 1", v.expert_id, v.version_no, v.expert_id) : undefined;
				const prevCfg = prev ? (JSON.parse(prev.config) as ExpertConfigDTO) : undefined;
				const diff = cfg ? this.#fieldDiff(prevCfg, cfg) : [];
				const skills = (cfg?.skills ?? []).map((s) => ({ skillId: s.skillId, name: this.#skills.skill(s.skillId)?.name ?? "（已删除）", state: "ok" as const }));
				return {
					files: [],
					permissionDelta: { added: [], removed: [] },
					diff,
					checks: sub.checks ? JSON.parse(sub.checks) : undefined,
					...(cfg ? { expert: { config: cfg, skills, ...(prev ? { previousVersionNo: prev.version_no } : {}) } } : {}),
				};
			},
		};
	}
	/** Field-level diff shown to the reviewer: each configuration field as a tiny "file" (so the existing diff view renders it). */
	#fieldDiff(prev: ExpertConfigDTO | undefined, next: ExpertConfigDTO): SubmissionDetailDTO["diff"] {
		const fields: [string, (c: ExpertConfigDTO) => string][] = [
			["名称", (c) => c.name],
			["一句话简介", (c) => c.tagline],
			["详细说明", (c) => c.description],
			["系统指令", (c) => c.instructions],
			["开场白", (c) => c.opening],
			["示例问题", (c) => c.starters.join("\n")],
			["默认模型", (c) => (c.defaultModel ? `${c.defaultModel.provider}/${c.defaultModel.modelId}` : "（跟随会话）")],
			["挂载技能", (c) => c.skills.map((s) => `${this.#skills.skill(s.skillId)?.name ?? s.skillId}`).join("\n")],
			["连接器", (c) => c.connectors.map((s) => s.connectorId).join("\n")],
			["工具白名单", (c) => (c.tools ? c.tools.join("\n") : "（默认）")],
		];
		return fields.map(([path, get]) => {
			const a = prev ? get(prev) : undefined;
			const b = get(next);
			if (a === b) return { path, status: "unchanged" as const };
			const aLines = a === undefined ? [] : a.split("\n");
			const bLines = b.split("\n");
			return {
				path,
				status: a === undefined ? ("added" as const) : ("modified" as const),
				added: bLines.length,
				removed: aLines.length,
				hunks: [{ oldStart: 1, newStart: 1, lines: [...aLines.map((s) => ({ t: "-" as const, s })), ...bLines.map((s) => ({ t: "+" as const, s }))] }],
			};
		});
	}
}

/** Prompt section `expert`: who the current run answers as (the @-mentioned expert of this message, else the conversation's bound one). */
export function createExpertsExtension(ctx: AppContext): Extension {
	const expert = section("expert", async (input: any, context: Context) => {
		try {
			const rt = ctx.services.get("runtime") as any;
			if (typeof rt.promptScope !== "function" || typeof rt.expertForRun !== "function") return undefined;
			const scope = await rt.promptScope(input, context);
			if (!scope?.principal) return undefined;
			const cur = (await rt.expertForRun(scope.space.id, input.conversationId as number, context)) as { expertId?: string; boundId?: string } | undefined;
			if (!cur?.expertId) return undefined;
			const ex = ctx.services.get("experts") as Experts;
			// A conversation bound to a migrated 助手 already carries its instructions in the agent: not repeated for that same expert.
			const skip = cur.boundId === cur.expertId && ex.row(cur.expertId)?.source === "assistant";
			return await ex.promptFor(scope.principal, cur.expertId, { skipInstructions: skip });
		} catch {
			return undefined;
		}
	});
	return defineExtension({ name: "wr.experts", sections: [expert] });
}
