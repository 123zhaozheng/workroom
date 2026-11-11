// Skills (M05): prompt presets, context-only SKILL.md skills and executable skills (resources + entry script + declared
// tool/permission requirements); immutable versions; per-user install with pin/upgrade/disable/rollback; per-version
// permission grants; run records with the exact version; drafts from a finished task → preview → validate → publish.
// Loading a skill's text (skill_load) never grants anything: skill_run checks the user's grant for that exact version.
import type { Context } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, section, ToolResultEntry, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AppContext, Principal, Space, ToolActor } from "../core/contracts.ts";
import type { Migration } from "../core/db.ts";
import { HttpError, newId, nowIso } from "../core/http.ts";
import type { SkillDraftDTO, SkillDTO, SkillKind, SkillPermission, SkillRunDTO, SkillValidationDTO, SkillVersionDTO } from "../../../shared/files.ts";
import { runtimeActorResolver, type ActorResolver } from "../files/actor.ts";
import type { ToolCallLog } from "./calls.ts";
import type { Sandbox } from "./sandbox.ts";
import type { Market } from "./market.ts";

export const SKILL_MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "skills",
		sql: `
CREATE TABLE skill_skills (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, scope TEXT NOT NULL, owner_user_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', latest_version_no INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX skill_skills_org ON skill_skills(org_id, scope);
CREATE TABLE skill_versions (
  id TEXT PRIMARY KEY, skill_id TEXT NOT NULL REFERENCES skill_skills(id), version_no INTEGER NOT NULL, kind TEXT NOT NULL,
  description TEXT NOT NULL, instructions TEXT NOT NULL, resources TEXT NOT NULL, entry TEXT, required_tools TEXT NOT NULL,
  required_permissions TEXT NOT NULL, change_note TEXT, source TEXT NOT NULL, validation TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (skill_id, version_no)
);
CREATE TRIGGER skill_versions_no_update BEFORE UPDATE ON skill_versions BEGIN SELECT RAISE(ABORT, 'skill versions are immutable'); END;
CREATE TABLE skill_installs (
  skill_id TEXT NOT NULL, user_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, pinned_version_no INTEGER,
  installed_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (skill_id, user_id)
);
CREATE TABLE skill_install_history (
  id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, user_id TEXT NOT NULL, action TEXT NOT NULL, from_version_no INTEGER, to_version_no INTEGER, at TEXT NOT NULL
);
CREATE TABLE skill_grants (
  version_id TEXT NOT NULL, user_id TEXT NOT NULL, skill_id TEXT NOT NULL, permissions TEXT NOT NULL, granted_at TEXT NOT NULL, PRIMARY KEY (version_id, user_id)
);
CREATE TABLE skill_runs (
  id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, version_id TEXT NOT NULL, version_no INTEGER NOT NULL, mode TEXT NOT NULL, user_id TEXT NOT NULL,
  space_id TEXT, conversation_id INTEGER, task_id INTEGER, call_id TEXT, status TEXT NOT NULL, detail TEXT, at TEXT NOT NULL
);
CREATE INDEX skill_runs_skill ON skill_runs(skill_id, at);
CREATE TABLE skill_drafts (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, description TEXT NOT NULL,
  instructions TEXT NOT NULL, resources TEXT NOT NULL, entry TEXT, required_tools TEXT NOT NULL, required_permissions TEXT NOT NULL,
  source TEXT NOT NULL, sample TEXT, validation TEXT, validated_stamp TEXT, published_skill_id TEXT, target_skill_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
`,
	},
];

const KINDS: SkillKind[] = ["prompt", "context", "executable"];
const PERM_RE = /^(sandbox\.exec|network|file\.write|tool:[A-Za-z0-9_-]{1,64})$/;

export const SKILL_CONTRACT =
	"技能内容仅作为上下文参考：加载技能不授予执行脚本、系统命令、联网或未选择工具的权限。只有用户为该技能的这个版本明确授权后，skill 工具的 action=run 才会在沙箱中运行它的脚本。不要编造技能中没有写明的步骤。";

export interface SkillRow {
	id: string;
	org_id: string;
	scope: "personal" | "project" | "department" | "org";
	owner_user_id: string;
	name: string;
	kind: SkillKind;
	status: string;
	latest_version_no: number;
	slug: string | null;
	scope_ref: string | null;
	published_version_no: number | null;
	listed: number;
	category: string | null;
	tags: string;
	unpublished_reason: string | null;
	created_at: string;
	updated_at: string;
}
export interface VersionRow {
	id: string;
	skill_id: string;
	version_no: number;
	kind: SkillKind;
	description: string;
	instructions: string;
	resources: string;
	entry: string | null;
	required_tools: string;
	required_permissions: string;
	change_note: string | null;
	source: string;
	validation: string | null;
	created_by: string;
	created_at: string;
	semver: string | null;
	package_sha256: string | null;
	package_size: number | null;
	manifest: string | null;
	checks: string | null;
}
export interface InstallRow {
	skill_id: string;
	user_id: string;
	enabled: number;
	pinned_version_no: number | null;
}
export type Resource = { path: string; sha256: string; size: number };
type Materialized = { resources: Resource[]; entry: string | null; perms: string[]; tools: string[] };
export interface SkillInput {
	readonly name: string;
	readonly kind: SkillKind;
	readonly scope?: "personal" | "org";
	readonly description?: string;
	readonly instructions: string;
	readonly resources?: readonly { path: string; content: string; encoding?: "utf8" | "base64" }[];
	readonly entry?: string;
	readonly requiredTools?: readonly string[];
	readonly requiredPermissions?: readonly string[];
	readonly changeNote?: string;
}

function cleanPath(p: string): string {
	const x = String(p ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
	if (!x || x.split("/").some((s) => s === ".." || s === "") || x.length > 200) throw new HttpError(400, "bad_resource_path", `资源路径无效：${p}`);
	return x;
}

export class Skills {
	readonly #ctx: AppContext;
	resolveActor: ActorResolver;
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
		this.resolveActor = runtimeActorResolver(ctx);
	}
	get #db() {
		return this.#ctx.db;
	}
	get #market(): Market {
		return this.#ctx.services.get("market") as Market;
	}

	skill(id: string): SkillRow | undefined {
		return this.#db.get<SkillRow>("SELECT * FROM skill_skills WHERE id = ?", id);
	}
	version(skillId: string, no: number): VersionRow | undefined {
		return this.#db.get<VersionRow>("SELECT * FROM skill_versions WHERE skill_id = ? AND version_no = ?", skillId, no);
	}
	versions(skillId: string): VersionRow[] {
		return this.#db.all<VersionRow>("SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version_no DESC", skillId);
	}
	install(skillId: string, userId: string): InstallRow | undefined {
		return this.#db.get<InstallRow>("SELECT * FROM skill_installs WHERE skill_id = ? AND user_id = ?", skillId, userId);
	}

	// ----- ACL ("skill" resources) -----
	async decide(p: Principal, action: string, id: string): Promise<{ allow: boolean; reason: string }> {
		const s = this.skill(id);
		if (!s) return { allow: false, reason: "not_found" };
		if (s.org_id !== p.orgId) return { allow: false, reason: "other_org" };
		const owner = s.owner_user_id === p.userId;
		if (action === "read" || action === "use") {
			if (owner) return { allow: true, reason: "owner" };
			if (s.scope === "personal") return { allow: false, reason: "personal_skill" };
			if (!s.listed) return { allow: false, reason: "unlisted" };
			if (s.scope === "org") return { allow: true, reason: "org_skill" };
			if (s.scope === "department") return s.scope_ref && this.#market.deptScope(p).has(s.scope_ref) ? { allow: true, reason: "department_skill" } : { allow: false, reason: "other_department" };
			const space = s.scope_ref ? this.#ctx.services.get("identity").projectSpace(s.scope_ref) : null;
			if (space && (await this.#ctx.services.get("acl").check(p, "read", { kind: "space", id: space.id })).allow) return { allow: true, reason: "project_skill" };
			return { allow: false, reason: "other_project" };
		}
		if (owner) return { allow: true, reason: "owner" };
		if (s.scope !== "personal" && (await this.#market.isManager(p))) return { allow: true, reason: "market_manager" };
		return { allow: false, reason: "not_owner" };
	}
	async #require(p: Principal, action: string, id: string): Promise<SkillRow> {
		const s = this.skill(id);
		if (!s) throw new HttpError(404, "not_found", "技能不存在");
		await this.#ctx.services.get("acl").require(p, action as any, { kind: "skill", id });
		return s;
	}

	// ----- authoring -----
	#materialize(input: SkillInput, kind: SkillKind): Materialized {
		const resources: Resource[] = [];
		const seen = new Set<string>();
		for (const r of input.resources ?? []) {
			const path = cleanPath(r.path);
			if (seen.has(path)) throw new HttpError(400, "duplicate_resource", `重复的资源 ${path}`);
			seen.add(path);
			const bytes = r.encoding === "base64" ? new Uint8Array(Buffer.from(r.content, "base64")) : new TextEncoder().encode(r.content);
			if (bytes.byteLength > 5 * 1024 * 1024) throw new HttpError(413, "too_large", `资源 ${path} 过大`);
			const { sha256, size } = this.#ctx.blobs.put(bytes);
			resources.push({ path, sha256, size });
		}
		const perms = [...new Set((input.requiredPermissions ?? []).map(String))];
		for (const p of perms) if (!PERM_RE.test(p)) throw new HttpError(400, "bad_permission", `未知权限 ${p}`);
		let entry: string | null = null;
		if (kind === "executable") {
			if (!input.entry) throw new HttpError(400, "entry_required", "可执行技能需要 entry（入口脚本）");
			entry = cleanPath(input.entry);
			if (!seen.has(entry)) throw new HttpError(400, "entry_missing", `入口脚本 ${entry} 不在资源中`);
			if (!/\.(py|sh|mjs|js)$/.test(entry)) throw new HttpError(400, "entry_type", "入口脚本必须是 .py、.sh、.mjs 或 .js");
			if (!perms.includes("sandbox.exec")) perms.unshift("sandbox.exec");
		} else if (input.entry) throw new HttpError(400, "entry_not_allowed", "只有可执行技能可以声明入口脚本");
		return { resources, entry, perms, tools: [...new Set((input.requiredTools ?? []).map(String))] };
	}

	async createSkill(p: Principal, input: SkillInput, extra: { source?: "manual" | "from_task"; validation?: SkillValidationDTO } = {}): Promise<SkillRow> {
		const name = String(input.name ?? "").trim().slice(0, 80);
		if (!name) throw new HttpError(400, "invalid", "技能名称必填");
		if (!KINDS.includes(input.kind)) throw new HttpError(400, "invalid", "kind 必须是 prompt、context 或 executable");
		if (!String(input.instructions ?? "").trim()) throw new HttpError(400, "invalid", "技能说明（instructions）必填");
		const scope = input.scope === "org" ? "org" : "personal";
		if (scope === "org") await this.#market.require(p, "skill.marketplace.manage", undefined, "只有技能市场管理员可以直接发布组织技能；成员请上传技能包并提交审核");
		const m = this.#materialize(input, input.kind);
		const id = newId("skl");
		const now = nowIso();
		this.#db.tx(() => {
			this.#db.run("INSERT INTO skill_skills (id, org_id, scope, owner_user_id, name, kind, latest_version_no, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)", id, p.orgId, scope, p.userId, name, input.kind, now, now);
			this.#insertVersion(id, 1, p, input, m, extra);
		});
		// Legacy JSON path: an organisation admin publishing an org skill is a direct (audited, forced) publish; a personal skill
		// under a "review" policy goes to the review queue. Packages go through the marketplace upload instead (market.ts).
		if (scope === "org") this.#market.adminDirectPublish(p, id, 1);
		else await this.#market.afterLegacyVersion(p, this.skill(id)!, 1);
		return this.skill(id)!;
	}

	#insertVersion(skillId: string, no: number, p: Principal, input: SkillInput, m: Materialized, extra: { source?: string; validation?: SkillValidationDTO }): void {
		this.#db.run(
			"INSERT INTO skill_versions (id, skill_id, version_no, kind, description, instructions, resources, entry, required_tools, required_permissions, change_note, source, validation, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			newId("skv"), skillId, no, input.kind, String(input.description ?? "").slice(0, 2000), String(input.instructions).slice(0, 100_000), JSON.stringify(m.resources), m.entry, JSON.stringify(m.tools), JSON.stringify(m.perms),
			input.changeNote ?? (no === 1 ? "初版" : null), extra.source ?? "manual", extra.validation ? JSON.stringify(extra.validation) : null, p.userId, nowIso(),
		);
	}

	async addVersion(p: Principal, skillId: string, input: Omit<SkillInput, "name" | "scope"> & { name?: string }, extra: { source?: "manual" | "from_task"; validation?: SkillValidationDTO } = {}): Promise<VersionRow> {
		const s = await this.#require(p, "write", skillId);
		const kind = input.kind ?? s.kind;
		if (!KINDS.includes(kind)) throw new HttpError(400, "invalid", "kind 无效");
		if (!String(input.instructions ?? "").trim()) throw new HttpError(400, "invalid", "技能说明（instructions）必填");
		const full: SkillInput = { ...input, name: s.name, kind };
		const m = this.#materialize(full, kind);
		const no = this.#db.tx(() => {
			const n = this.skill(skillId)!.latest_version_no + 1;
			this.#insertVersion(skillId, n, p, full, m, extra);
			this.#db.run("UPDATE skill_skills SET latest_version_no = ?, kind = ?, updated_at = ? WHERE id = ?", n, kind, nowIso(), skillId);
			return n;
		});
		await this.#market.afterLegacyVersion(p, this.skill(skillId)!, no);
		return this.version(skillId, no)!;
	}

	// ----- installation lifecycle -----
	effectiveVersionNo(s: SkillRow, inst: InstallRow | undefined): number {
		return inst?.pinned_version_no ?? this.#market.latestUsable(s);
	}
	/** A version a user may be moved to: it exists and (for distributed skills) was approved. */
	#pinnable(s: SkillRow, no: number): void {
		const v = this.version(s.id, no);
		if (!v) throw new HttpError(404, "version_not_found", "版本不存在");
		const u = this.#market.usable(s, v);
		if (!u.ok) throw new HttpError(409, u.reason, u.message);
	}
	#history(skillId: string, userId: string, action: string, from: number | null, to: number | null): void {
		this.#db.run("INSERT INTO skill_install_history (id, skill_id, user_id, action, from_version_no, to_version_no, at) VALUES (?, ?, ?, ?, ?, ?, ?)", newId("skh"), skillId, userId, action, from, to, nowIso());
	}
	async installFor(p: Principal, skillId: string, pinVersionNo?: number | null): Promise<void> {
		const s = await this.#require(p, "use", skillId);
		if (pinVersionNo != null) this.#pinnable(s, pinVersionNo);
		const prev = this.install(skillId, p.userId);
		this.#db.run(
			"INSERT INTO skill_installs (skill_id, user_id, enabled, pinned_version_no, installed_at, updated_at) VALUES (?, ?, 1, ?, ?, ?) ON CONFLICT(skill_id, user_id) DO UPDATE SET enabled = 1, pinned_version_no = excluded.pinned_version_no, updated_at = excluded.updated_at",
			skillId, p.userId, pinVersionNo ?? null, nowIso(), nowIso(),
		);
		this.#history(skillId, p.userId, "install", prev ? this.effectiveVersionNo(s, prev) : null, pinVersionNo ?? this.#market.latestUsable(s));
	}
	uninstall(p: Principal, skillId: string): void {
		const s = this.skill(skillId)!;
		const inst = this.install(skillId, p.userId);
		if (!inst) return;
		this.#db.run("DELETE FROM skill_installs WHERE skill_id = ? AND user_id = ?", skillId, p.userId);
		this.#history(skillId, p.userId, "uninstall", this.effectiveVersionNo(s, inst), null);
	}
	listDrafts(p: Principal): SkillDraftDTO[] {
		return this.#db.all<any>("SELECT * FROM skill_drafts WHERE org_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 100", p.orgId, p.userId).map((r) => this.draftDTO(r));
	}
	async setInstall(p: Principal, skillId: string, patch: { enabled?: boolean; pinnedVersionNo?: number | null }): Promise<void> {
		const s = await this.#require(p, "use", skillId);
		const inst = this.install(skillId, p.userId);
		if (!inst) throw new HttpError(404, "not_installed", "尚未安装该技能");
		const from = this.effectiveVersionNo(s, inst);
		if (patch.pinnedVersionNo !== undefined) {
			if (patch.pinnedVersionNo !== null) this.#pinnable(s, patch.pinnedVersionNo);
			this.#db.run("UPDATE skill_installs SET pinned_version_no = ?, updated_at = ? WHERE skill_id = ? AND user_id = ?", patch.pinnedVersionNo, nowIso(), skillId, p.userId);
			this.#history(skillId, p.userId, patch.pinnedVersionNo === null ? "follow_latest" : "pin", from, patch.pinnedVersionNo ?? this.#market.latestUsable(s));
		}
		if (patch.enabled !== undefined) {
			this.#db.run("UPDATE skill_installs SET enabled = ?, updated_at = ? WHERE skill_id = ? AND user_id = ?", patch.enabled ? 1 : 0, nowIso(), skillId, p.userId);
			this.#history(skillId, p.userId, patch.enabled ? "enable" : "disable", from, from);
		}
	}
	async upgrade(p: Principal, skillId: string): Promise<number> {
		const s = await this.#require(p, "use", skillId);
		const inst = this.install(skillId, p.userId);
		if (!inst) throw new HttpError(404, "not_installed", "尚未安装该技能");
		const from = this.effectiveVersionNo(s, inst);
		const latest = this.#market.latestUsable(s);
		this.#pinnable(s, latest || 1);
		this.#db.run("UPDATE skill_installs SET pinned_version_no = ?, updated_at = ? WHERE skill_id = ? AND user_id = ?", latest, nowIso(), skillId, p.userId);
		this.#history(skillId, p.userId, "upgrade", from, latest);
		return latest;
	}
	/** Back to the version used before the last change (history), else the previous version number. Pins it. */
	async rollback(p: Principal, skillId: string): Promise<number> {
		const s = await this.#require(p, "use", skillId);
		const inst = this.install(skillId, p.userId);
		if (!inst) throw new HttpError(404, "not_installed", "尚未安装该技能");
		const cur = this.effectiveVersionNo(s, inst);
		const h = this.#db.get<{ from_version_no: number | null }>("SELECT from_version_no FROM skill_install_history WHERE skill_id = ? AND user_id = ? AND to_version_no = ? AND from_version_no IS NOT NULL AND from_version_no != ? AND action IN ('upgrade','pin','follow_latest','install') ORDER BY at DESC, rowid DESC LIMIT 1", skillId, p.userId, cur, cur);
		const target = h?.from_version_no ?? cur - 1;
		if (target < 1 || !this.version(skillId, target)) throw new HttpError(409, "no_previous_version", "没有可回滚的旧版本");
		this.#pinnable(s, target);
		this.#db.run("UPDATE skill_installs SET pinned_version_no = ?, updated_at = ? WHERE skill_id = ? AND user_id = ?", target, nowIso(), skillId, p.userId);
		this.#history(skillId, p.userId, "rollback", cur, target);
		return target;
	}
	async grant(p: Principal, skillId: string, versionNo: number, permissions: readonly string[]): Promise<void> {
		await this.#require(p, "use", skillId);
		const v = this.version(skillId, versionNo);
		if (!v) throw new HttpError(404, "version_not_found", "版本不存在");
		const declared: string[] = JSON.parse(v.required_permissions);
		const extra = permissions.filter((x) => !declared.includes(x));
		if (extra.length) throw new HttpError(400, "undeclared_permission", `不能授予技能未声明的权限：${extra.join(", ")}`);
		this.#db.run("INSERT INTO skill_grants (version_id, user_id, skill_id, permissions, granted_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(version_id, user_id) DO UPDATE SET permissions = excluded.permissions, granted_at = excluded.granted_at", v.id, p.userId, skillId, JSON.stringify([...new Set(permissions)]), nowIso());
	}
	granted(versionId: string, userId: string): string[] {
		const g = this.#db.get<{ permissions: string }>("SELECT permissions FROM skill_grants WHERE version_id = ? AND user_id = ?", versionId, userId);
		return g ? JSON.parse(g.permissions) : [];
	}

	// ----- on-demand mounts: which skills a conversation has loaded -----
	/** Remember that this conversation loaded/read/ran `skill` (upsert; moves it to the front of the recency order). */
	markLoaded(spaceId: string, conversationId: number, skill: SkillRow, version: VersionRow): void {
		// Strictly increasing per conversation, so "most recently loaded" is well defined even within one millisecond.
		const max = this.#db.get<{ m: string | null }>("SELECT MAX(loaded_at) AS m FROM skill_conv_loaded WHERE space_id = ? AND conversation_id = ?", spaceId, conversationId)?.m;
		let at = Date.now();
		if (max && Date.parse(max) >= at) at = Date.parse(max) + 1;
		this.#db.run(
			"INSERT INTO skill_conv_loaded (space_id, conversation_id, skill_id, version_id, loaded_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(space_id, conversation_id, skill_id) DO UPDATE SET version_id = excluded.version_id, loaded_at = excluded.loaded_at",
			spaceId, conversationId, skill.id, version.id, new Date(at).toISOString(),
		);
	}
	/** Loaded skills of a conversation, most recent first. */
	loadedRows(spaceId: string, conversationId: number): { skill_id: string; version_id: string; loaded_at: string }[] {
		return this.#db.all("SELECT skill_id, version_id, loaded_at FROM skill_conv_loaded WHERE space_id = ? AND conversation_id = ? ORDER BY loaded_at DESC, rowid DESC", spaceId, conversationId);
	}

	recordRun(r: { skill: SkillRow; version: VersionRow; mode: "load" | "run" | "validate"; userId: string; actor?: ToolActor; status: "ok" | "error" | "denied"; detail?: string }): string {
		const id = newId("skr");
		this.#db.run(
			"INSERT INTO skill_runs (id, skill_id, version_id, version_no, mode, user_id, space_id, conversation_id, task_id, call_id, status, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			id, r.skill.id, r.version.id, r.version.version_no, r.mode, r.userId, r.actor?.space.id ?? null, r.actor?.conversationId ?? null, r.actor?.taskId ?? null, r.actor?.callId ?? null, r.status, r.detail?.slice(0, 2000) ?? null, nowIso(),
		);
		return id;
	}
	runs(skillId: string, userId?: string): SkillRunDTO[] {
		const rows = userId ? this.#db.all<any>("SELECT * FROM skill_runs WHERE skill_id = ? AND user_id = ? ORDER BY at DESC, rowid DESC LIMIT 200", skillId, userId) : this.#db.all<any>("SELECT * FROM skill_runs WHERE skill_id = ? ORDER BY at DESC, rowid DESC LIMIT 200", skillId);
		return rows.map((r) => ({ id: r.id, skillId: r.skill_id, versionId: r.version_id, versionNo: r.version_no, mode: r.mode, userId: r.user_id, spaceId: r.space_id ?? undefined, conversationId: r.conversation_id ?? undefined, taskId: r.task_id ?? undefined, status: r.status, detail: r.detail ?? undefined, at: r.at }));
	}

	// ----- DTOs -----
	versionDTO(v: VersionRow): SkillVersionDTO {
		return {
			versionId: v.id,
			versionNo: v.version_no,
			description: v.description,
			instructions: v.instructions,
			resources: JSON.parse(v.resources),
			entry: v.entry ?? undefined,
			requiredTools: JSON.parse(v.required_tools),
			requiredPermissions: JSON.parse(v.required_permissions),
			changeNote: v.change_note ?? undefined,
			createdAt: v.created_at,
			createdBy: v.created_by,
			source: v.source as "manual" | "from_task",
			validation: v.validation ? JSON.parse(v.validation) : undefined,
		};
	}
	async dto(p: Principal, s: SkillRow, withVersions = false, space?: Space): Promise<SkillDTO> {
		const inst = this.install(s.id, p.userId);
		const eff = this.effectiveVersionNo(s, inst);
		const effV = this.version(s.id, eff);
		const manage = (await this.decide(p, "write", s.id)).allow;
		const via = this.#market.scopeInstallsFor(p, space).filter((r) => r.skill_id === s.id).map((r) => r.scope_kind as "org" | "department" | "project");
		const versions = withVersions ? this.versions(s.id).filter((v) => manage || this.#market.versionApproved(v.id)).map((v) => this.versionDTO(v)) : undefined;
		return {
			id: s.id,
			name: s.name,
			slug: this.#market.slugOf(s),
			kind: s.kind,
			scope: s.scope,
			ownerUserId: s.owner_user_id,
			latestVersionNo: manage ? s.latest_version_no : this.#market.latestUsable(s),
			publishedVersionNo: s.published_version_no ?? undefined,
			listed: s.listed === 1,
			status: s.status as "active" | "archived",
			versions,
			install: inst ? { enabled: inst.enabled === 1, pinnedVersionNo: inst.pinned_version_no, effectiveVersionNo: eff, grantedPermissions: (effV ? this.granted(effV.id, p.userId) : []) as SkillPermission[] } : undefined,
			viaScope: via.length ? via : undefined,
			canManage: manage,
		};
	}
	/** Skills the caller may see: their own, plus listed (approved) org / own-department / own-project skills. */
	async visible(p: Principal): Promise<SkillRow[]> {
		const rows = this.#db.all<SkillRow>("SELECT * FROM skill_skills WHERE org_id = ? AND status = 'active' ORDER BY updated_at DESC", p.orgId);
		let projects: Set<string | undefined> | undefined;
		const depts = this.#market.deptScope(p);
		const out: SkillRow[] = [];
		for (const s of rows) {
			if (s.owner_user_id === p.userId) out.push(s);
			else if (s.listed === 1 && s.scope === "org") out.push(s);
			else if (s.listed === 1 && s.scope === "department" && s.scope_ref && depts.has(s.scope_ref)) out.push(s);
			else if (s.listed === 1 && s.scope === "project" && s.scope_ref) {
				projects ??= new Set((await this.#ctx.services.get("acl").readableSpaces(p)).map((x) => x.projectId));
				if (projects.has(s.scope_ref)) out.push(s);
			}
		}
		return out;
	}
	/**
	 * Skills in effect for a user (in `space`): personal installs, plus org / department / project installs that apply there, minus ones the
	 * user switched off. Only approved versions of distributed skills count. Slug clashes: org > department > project > personal.
	 */
	async active(p: Principal, space?: Space): Promise<{ skill: SkillRow; version: VersionRow; via: "me" | "org" | "department" | "project" }[]> {
		const visible = await this.visible(p);
		const byId = new Map(visible.map((s) => [s.id, s]));
		const cands = new Map<string, { skill: SkillRow; pinned: number | null; via: "me" | "org" | "department" | "project" }>();
		for (const r of this.#market.scopeInstallsFor(p, space)) {
			const s = byId.get(r.skill_id);
			if (s && !cands.has(s.id)) cands.set(s.id, { skill: s, pinned: r.pinned_version_no, via: r.scope_kind as "org" | "department" | "project" });
		}
		for (const s of visible) {
			const inst = this.install(s.id, p.userId);
			if (!inst) continue;
			if (!inst.enabled) cands.delete(s.id);
			else cands.set(s.id, { skill: s, pinned: inst.pinned_version_no, via: "me" });
		}
		const rank = { org: 0, department: 1, project: 2, personal: 3 } as const;
		const out: { skill: SkillRow; version: VersionRow; via: "me" | "org" | "department" | "project" }[] = [];
		const slugs = new Set<string>();
		for (const c of [...cands.values()].sort((a, b) => rank[a.skill.scope] - rank[b.skill.scope] || a.skill.name.localeCompare(b.skill.name))) {
			const v = this.version(c.skill.id, c.pinned ?? this.#market.latestUsable(c.skill));
			if (!v || !this.#market.usable(c.skill, v).ok) continue;
			const slug = this.#market.slugOf(c.skill);
			if (slugs.has(slug)) continue;
			slugs.add(slug);
			out.push({ skill: c.skill, version: v, via: c.via });
		}
		return out;
	}
	/** Resolve a skill for use by an actor: visible, installed (for me or via a scope), enabled, approved; returns the effective (pinned or latest) version. */
	async resolveForUse(p: Principal, name: string, space?: Space): Promise<{ skill: SkillRow; version: VersionRow }> {
		await this.#market.require(p, "skill.use", undefined, "没有使用技能的权限（skill.use）");
		const s = (await this.visible(p)).find((x) => x.name === name || x.id === name || this.#market.slugOf(x) === name);
		if (!s) throw new HttpError(404, "skill_not_found", `没有可用的技能「${name}」`);
		const d = await this.#ctx.services.get("acl").check(p, "use", { kind: "skill", id: s.id });
		if (!d.allow) throw new HttpError(403, "forbidden", `无权使用技能「${name}」（${d.reason}）`);
		const own = this.install(s.id, p.userId);
		let pinned: number | null;
		if (own) {
			if (!own.enabled) throw new HttpError(403, "skill_disabled", `技能「${s.name}」已停用`);
			pinned = own.pinned_version_no;
		} else {
			const via = this.#market.scopeInstallsFor(p, space).find((r) => r.skill_id === s.id);
			if (!via) throw new HttpError(403, "not_installed", `技能「${s.name}」尚未安装`);
			pinned = via.pinned_version_no;
		}
		const v = this.version(s.id, pinned ?? this.#market.latestUsable(s));
		if (!v) throw new HttpError(404, "version_not_found", this.#market.latestUsable(s) === 0 ? `技能「${s.name}」还没有通过审核的版本` : "技能版本不存在");
		const u = this.#market.usable(s, v);
		if (!u.ok) throw new HttpError(403, u.reason, u.message);
		return { skill: s, version: v };
	}

	// ----- execution of executable skills (sandbox) -----
	/**
	 * Run a skill's script. With the sandbox mounts contract the package is materialised once, content-addressed, and mounted READ-ONLY at
	 * /skills/<slug>/ (the skill cannot modify itself); the input goes to a file under /work (the only writable place). Without mount
	 * support the files are copied into /work/.skills (legacy fallback; the copy is writable — reported in the run detail).
	 */
	async execute(p: Principal, space: Space, skill: SkillRow, v: VersionRow, input: string, ids: { conversationId?: number; taskId?: number; callId?: string; workdirKey?: number; script?: string; slugOverride?: string }): Promise<{ status: string; stdout: string; stderr: string; exitCode?: number; runId: string; readOnly: boolean }> {
		const sb = this.#ctx.services.get("sandbox") as Sandbox;
		const wdKey = ids.workdirKey ?? ids.conversationId;
		const entry = ids.script ?? v.entry!;
		const language = entry.endsWith(".py") ? "python" : entry.endsWith(".sh") ? "shell" : "node";
		const caps = await sb.capabilities().catch(() => null);
		const useMounts = !!caps?.mounts;
		const runKey = (ids.callId ?? newId("in")).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
		let root: string;
		let mounts: { hostPath: string; target: string; readOnly: boolean }[] = [];
		let inputPath: string;
		if (useMounts) {
			const { dir, slug } = this.#market.materialize(skill, v, ids.slugOverride);
			root = `/skills/${slug}`;
			// Mounts are on demand: the provider mounts the skills this conversation has loaded. A skill run always mounts its own skill:
			// record it as loaded (most recent) and only add it explicitly when the provider would not (drafts, no conversation, slug clash).
			let provided = false;
			if (!ids.slugOverride && wdKey != null) {
				this.markLoaded(space.id, wdKey, skill, v);
				provided = (await this.#market.loadedMountPlan(p, space, wdKey)).mounts.some((x) => x.mount.target === root);
			}
			if (!provided) mounts = [{ hostPath: dir, target: root, readOnly: true }];
			inputPath = `/work/.skill-run/${runKey}/input.txt`;
			sb.writeFile(space, wdKey, `.skill-run/${runKey}/input.txt`, new TextEncoder().encode(input));
		} else {
			const resources = this.#market.versionFiles(skill, v);
			const dir = `.skills/${skill.id}-v${v.version_no}`;
			for (const r of resources) sb.writeFile(space, wdKey, `${dir}/${r.path}`, r.bytes);
			sb.writeFile(space, wdKey, `${dir}/.input.txt`, new TextEncoder().encode(input));
			root = `/work/${dir}`;
			inputPath = `/work/${dir}/.input.txt`;
		}
		const code =
			language === "node"
				? `import { readFileSync } from "node:fs"; process.env.SKILL_DIR = ${JSON.stringify(root)}; process.env.SKILL_INPUT_FILE = ${JSON.stringify(inputPath)}; process.argv[2] = readFileSync(${JSON.stringify(inputPath)}, "utf8"); await import(${JSON.stringify(`${root}/${entry}`)});`
				: language === "python"
					? `import runpy, sys, os\nsys.dont_write_bytecode = True\nos.environ["SKILL_DIR"] = ${JSON.stringify(root)}\nos.environ["SKILL_INPUT_FILE"] = ${JSON.stringify(inputPath)}\nsys.argv = [${JSON.stringify(entry)}, open(${JSON.stringify(inputPath)}).read()]\nrunpy.run_path(${JSON.stringify(`${root}/${entry}`)}, run_name="__main__")\n`
					: `SKILL_DIR=${JSON.stringify(root)} SKILL_INPUT_FILE=${JSON.stringify(inputPath)} sh ${JSON.stringify(`${root}/${entry}`)} "$(cat ${JSON.stringify(inputPath)})"`;
		const run = await sb.run({ principal: p, space, conversationId: wdKey, taskId: ids.taskId, callId: ids.callId, language, code, mounts });
		return { status: run.status, stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode, runId: run.id, readOnly: useMounts };
	}

	// ----- drafts from a finished task -----
	draftDTO(r: any): SkillDraftDTO {
		return {
			id: r.id,
			name: r.name,
			kind: r.kind,
			description: r.description,
			instructions: r.instructions,
			resources: JSON.parse(r.resources).map((x: any) => ({ path: x.path, size: x.size, sha256: x.sha256 })),
			entry: r.entry ?? undefined,
			requiredTools: JSON.parse(r.required_tools),
			requiredPermissions: JSON.parse(r.required_permissions),
			source: JSON.parse(r.source),
			sample: r.sample ? JSON.parse(r.sample) : undefined,
			validation: r.validation && r.validated_stamp === r.updated_at ? JSON.parse(r.validation) : undefined,
			publishedSkillId: r.published_skill_id ?? undefined,
		};
	}
	draftRow(p: Principal, id: string): any {
		const r = this.#db.get<any>("SELECT * FROM skill_drafts WHERE id = ?", id);
		if (!r || r.user_id !== p.userId || r.org_id !== p.orgId) throw new HttpError(404, "not_found", "草稿不存在");
		return r;
	}

	/** Steps of a conversation as recorded by the tool layer (tool calls, sandbox runs, produced files) + the first input. */
	async draftFromConversation(p: Principal, spaceId: string, conversationId: number, name?: string): Promise<SkillDraftDTO> {
		await this.#ctx.services.get("acl").require(p, "read", { kind: "conversation", id: String(conversationId), spaceId });
		const calls = this.#db.all<any>("SELECT tool, args_summary, status FROM tool_calls WHERE space_id = ? AND conversation_id = ? ORDER BY started_ms", spaceId, conversationId);
		const ok = calls.filter((c) => c.status === "ok");
		if (!ok.length) throw new HttpError(409, "no_successful_steps", "该会话没有成功的工具步骤，无法整理成技能");
		const failed = calls.length - ok.length;
		const files = this.#db.all<any>("SELECT name, version_no, tool FROM file_versions WHERE space_id = ? AND conversation_id = ? ORDER BY created_at", spaceId, conversationId);
		const runs = this.#db.all<any>("SELECT language, code, stdout FROM tool_sandbox_runs WHERE space_id = ? AND conversation_id = ? AND status = 'ok' ORDER BY started_at", spaceId, conversationId);
		const firstInput = await this.#firstInput(spaceId, conversationId).catch(() => undefined);
		const tools = [...new Set(ok.map((c) => c.tool as string))].filter((t) => !t.startsWith("skill_"));
		const perms = new Set<string>();
		for (const t of tools) {
			if (t === "sandbox_exec") perms.add("sandbox.exec");
			else if (["file_create", "file_revise", "sandbox_publish"].includes(t)) perms.add("file.write");
			else if (t.startsWith("mcp__") || t === "browse") perms.add(`tool:${t}`);
		}
		const lastRun = runs[runs.length - 1];
		const kind: SkillKind = lastRun ? "executable" : "context";
		const resources: Resource[] = [];
		let entry: string | null = null;
		if (lastRun) {
			entry = lastRun.language === "python" ? "main.py" : lastRun.language === "node" ? "main.mjs" : "main.sh";
			const { sha256, size } = this.#ctx.blobs.put(new TextEncoder().encode(lastRun.code));
			resources.push({ path: entry, sha256, size });
			perms.add("sandbox.exec");
		}
		const title = (name ?? firstInput?.slice(0, 30) ?? `会话 ${conversationId} 的做法`).trim();
		const steps = ok.map((c, i) => `${i + 1}. 使用 \`${c.tool}\`（参数摘要：${String(c.args_summary).slice(0, 160)}）`).join("\n");
		const outputs = files.length ? files.map((f) => `- ${f.name}（v${f.version_no}，由 ${f.tool ?? "上传"} 产生）`).join("\n") : "- （无文件产出）";
		const instructions = `---\nname: ${title}\ndescription: 从一次成功的任务整理的做法${firstInput ? `：${firstInput.slice(0, 80)}` : ""}\n---\n\n# ${title}\n\n## 何时使用\n${firstInput ? `当用户提出类似需求时：「${firstInput.slice(0, 200)}」` : "当用户需要重复这次任务时。"}\n\n## 步骤\n${steps}\n\n## 产出\n${outputs}\n${entry ? `\n## 脚本\n入口脚本 \`${entry}\` 来自该任务最后一次成功的沙箱运行；用 skill 工具 action=run 执行（需要用户授权 sandbox.exec）。\n` : ""}\n## 注意\n${SKILL_CONTRACT}${failed ? `\n\n（来源任务中有 ${failed} 个失败的步骤未纳入。）` : ""}\n`;
		const sample = { input: firstInput ?? "", expectContains: lastRun ? String(lastRun.stdout).trim().split("\n")[0]?.slice(0, 200) || undefined : undefined };
		const id = newId("skd");
		const now = nowIso();
		this.#db.run(
			"INSERT INTO skill_drafts (id, org_id, user_id, name, kind, description, instructions, resources, entry, required_tools, required_permissions, source, sample, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			id, p.orgId, p.userId, title, kind, `从会话 ${conversationId} 整理`, instructions, JSON.stringify(resources), entry, JSON.stringify(tools), JSON.stringify([...perms]), JSON.stringify({ spaceId, conversationId }), JSON.stringify(sample), now, now,
		);
		return this.draftDTO(this.#db.get<any>("SELECT * FROM skill_drafts WHERE id = ?", id));
	}

	async #firstInput(spaceId: string, conversationId: number): Promise<string | undefined> {
		if (!this.#ctx.services.has("runtime")) return undefined;
		const harness: any = await this.#ctx.services.get("runtime").harness(spaceId, BACKGROUND_CONTEXT);
		const conv = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
		if (!conv) return undefined;
		const page = await conv.entries({ order: "ascending" }, 50, undefined, BACKGROUND_CONTEXT);
		for (const e of page.items) if (e.kind === "wr.input" && e.data?.text) return String(e.data.text);
		for (const e of page.items) if (e.kind === "pi.user") {
			const c = e.model?.[0]?.content;
			return typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => x.text ?? "").join("") : undefined;
		}
		return undefined;
	}

	updateDraft(p: Principal, id: string, patch: { name?: string; kind?: SkillKind; description?: string; instructions?: string; requiredPermissions?: string[]; requiredTools?: string[]; sample?: { input: string; expectContains?: string }; targetSkillId?: string | null }): SkillDraftDTO {
		const r = this.draftRow(p, id);
		if (r.published_skill_id) throw new HttpError(409, "already_published", "草稿已发布");
		const next = {
			name: patch.name ?? r.name,
			kind: patch.kind ?? r.kind,
			description: patch.description ?? r.description,
			instructions: patch.instructions ?? r.instructions,
			required_permissions: JSON.stringify(patch.requiredPermissions ?? JSON.parse(r.required_permissions)),
			required_tools: JSON.stringify(patch.requiredTools ?? JSON.parse(r.required_tools)),
			sample: patch.sample ? JSON.stringify(patch.sample) : r.sample,
			target: patch.targetSkillId === undefined ? r.target_skill_id : patch.targetSkillId,
		};
		if (!KINDS.includes(next.kind)) throw new HttpError(400, "invalid", "kind 无效");
		for (const x of JSON.parse(next.required_permissions)) if (!PERM_RE.test(x)) throw new HttpError(400, "bad_permission", `未知权限 ${x}`);
		const stamp = nowIso() === r.updated_at ? `${nowIso()}~` : nowIso();
		this.#db.run("UPDATE skill_drafts SET name = ?, kind = ?, description = ?, instructions = ?, required_permissions = ?, required_tools = ?, sample = ?, target_skill_id = ?, updated_at = ? WHERE id = ?", next.name, next.kind, next.description, next.instructions, next.required_permissions, next.required_tools, next.sample, next.target, stamp, id);
		return this.draftDTO(this.#db.get<any>("SELECT * FROM skill_drafts WHERE id = ?", id));
	}

	/** Validation = static checks + a sample run: executable → the entry runs in a throwaway sandbox dir and must succeed (and
	 *  print `expectContains`); prompt/context → a fixture-model run (pi-ai faux provider, "测试模型，非真实 AI") must load the
	 *  draft's instructions through the skill tool contract and finish. */
	async validateDraft(p: Principal, id: string, knownTools: () => string[]): Promise<SkillDraftDTO> {
		const r = this.draftRow(p, id);
		const checks: { name: string; ok: boolean; detail?: string }[] = [];
		const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
		add("名称", !!String(r.name).trim());
		add("说明非空", String(r.instructions).trim().length >= 20, `${String(r.instructions).length} 字符`);
		const perms: string[] = JSON.parse(r.required_permissions);
		add("权限声明合法", perms.every((x) => PERM_RE.test(x)), perms.join(", ") || "（无）");
		const known = new Set(knownTools());
		const tools: string[] = JSON.parse(r.required_tools);
		const missing = tools.filter((t) => !known.has(t));
		add("所需工具可用", missing.length === 0, missing.length ? `缺少：${missing.join(", ")}` : tools.join(", ") || "（无）");
		const usesTool = (t: string) => tools.includes(t);
		if (usesTool("sandbox_exec") || r.kind === "executable") add("声明 sandbox.exec", perms.includes("sandbox.exec"));
		if (usesTool("file_create") || usesTool("file_revise")) add("声明 file.write", perms.includes("file.write"));
		// Round 9: a declared `network` permission stays a user grant item; whether the sandbox can reach a network depends on its driver / provider (no Workroom switch).
		if (perms.includes("network")) add("联网权限已声明", true, "使用者需单独授权；沙箱能否联网取决于所用的执行环境");
		const sample = r.sample ? JSON.parse(r.sample) : { input: "" };
		if (r.kind === "executable") {
			const resources: Resource[] = JSON.parse(r.resources);
			add("入口脚本存在", !!r.entry && resources.some((x) => x.path === r.entry), r.entry ?? "（无）");
			try {
				const space = this.#ctx.services.get("identity").personalSpace(p.userId, p.orgId);
				const fakeSkill = { id: `draft-${r.id}`, name: r.name } as SkillRow;
				const fakeVersion = { version_no: 0, resources: r.resources, entry: r.entry, instructions: r.instructions, description: r.description } as VersionRow;
				const out = await this.execute(p, space, fakeSkill, fakeVersion, sample.input ?? "", { workdirKey: -1, slugOverride: `draft-${String(r.id).slice(-8).toLowerCase().replace(/[^a-z0-9]/g, "x")}` });
				const okRun = out.status === "ok";
				add("样例运行成功", okRun, `${out.status}${out.stderr ? `：${out.stderr.slice(0, 200)}` : ""}`);
				if (sample.expectContains) add("样例输出符合预期", out.stdout.includes(sample.expectContains), `期望包含「${sample.expectContains}」`);
			} catch (e: any) {
				add("样例运行成功", false, String(e?.message ?? e).slice(0, 200));
			}
		} else {
			try {
				const res = await fixtureSampleRun(String(r.instructions), sample.input ?? "");
				add("样例运行（测试模型，非真实 AI）", res.ok, res.detail);
			} catch (e: any) {
				add("样例运行（测试模型，非真实 AI）", false, String(e?.message ?? e).slice(0, 200));
			}
		}
		const validation: SkillValidationDTO = { ok: checks.every((c) => c.ok), at: nowIso(), checks };
		this.#db.run("UPDATE skill_drafts SET validation = ?, validated_stamp = updated_at WHERE id = ?", JSON.stringify(validation), id);
		return this.draftDTO(this.#db.get<any>("SELECT * FROM skill_drafts WHERE id = ?", id));
	}

	async publishDraft(p: Principal, id: string, scope: "personal" | "org" = "personal"): Promise<SkillRow> {
		const r = this.draftRow(p, id);
		if (r.published_skill_id) throw new HttpError(409, "already_published", "草稿已发布");
		const d = this.draftDTO(r);
		if (!d.validation) throw new HttpError(409, "not_validated", "请先用样例验证（修改后需重新验证）");
		if (!d.validation.ok) throw new HttpError(409, "validation_failed", "样例验证未通过，不能发布");
		const resources = (JSON.parse(r.resources) as Resource[]).map((x) => ({ path: x.path, content: Buffer.from(this.#ctx.blobs.get(x.sha256)!).toString("base64"), encoding: "base64" as const }));
		const input: SkillInput = { name: r.name, kind: r.kind, scope, description: r.description, instructions: r.instructions, resources, entry: r.entry ?? undefined, requiredTools: JSON.parse(r.required_tools), requiredPermissions: JSON.parse(r.required_permissions), changeNote: "从任务整理" };
		let skill: SkillRow;
		if (r.target_skill_id) {
			await this.addVersion(p, r.target_skill_id, input, { source: "from_task", validation: d.validation });
			skill = this.skill(r.target_skill_id)!;
		} else {
			skill = await this.createSkill(p, input, { source: "from_task", validation: d.validation });
			await this.installFor(p, skill.id);
		}
		this.#db.run("UPDATE skill_drafts SET published_skill_id = ? WHERE id = ?", skill.id, id);
		return skill;
	}
}

/** A sample run on the fixture model: the model loads the instructions via a `skill_load`-shaped tool, then answers. */
async function fixtureSampleRun(instructions: string, input: string): Promise<{ ok: boolean; detail: string }> {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	let loaded = "";
	const load = defineTool({
		name: "skill_load",
		description: "Load the skill draft",
		parameters: obj({ name: str() }),
		async execute() {
			loaded = instructions;
			return { output: [{ type: "text", text: `${instructions}\n\n${SKILL_CONTRACT}` }] };
		},
	});
	faux.setResponses([fauxAssistantMessage([fauxToolCall("skill_load", { name: "draft" }, { id: "v1" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("已按技能步骤处理（测试模型）。")])]);
	const registry = createRegistry();
	registry.install(defineExtension({ name: "draft", tools: [load] }));
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
	try {
		const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const settled = await (await root.submit({ type: "input", content: input || "按技能执行" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		const page = await root.entries({}, 20, undefined, BACKGROUND_CONTEXT);
		const results = page.items.filter((e) => ToolResultEntry.is(e));
		const ok = settled.status === "done" && loaded === instructions && results.length === 1;
		return { ok, detail: ok ? "测试模型加载了技能说明并完成运行" : `运行状态 ${settled.status}` };
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
}

// ----- agent tools -----
export const SKILL_PROMPT_MAX_LINES = 50;
const oneLine = (x: string, max: number) => {
	const t = String(x ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Prompt section text for the skills a user may use now: "name (slug) — description", ≤ 50 lines, with an explicit "N more" line (never a silent cut). */
export function renderSkillIndex(entries: readonly { name: string; slug: string; description: string }[]): string | undefined {
	if (!entries.length) return undefined;
	const shown = entries.slice(0, SKILL_PROMPT_MAX_LINES);
	const lines = [
		"可用技能（按需使用：用 skill 工具 action=load 读取说明，action=read 读取技能包文件，action=run 运行可执行技能；不要凭记忆假设技能内容。要修改已安装的技能：skill_manage action=checkout 取出当前文件 → 在 /work 里编辑并提高 version → skill_manage action=submit_draft，用户确认后保存为新版本；不要用 sandbox_exec 复制 /skills/）：",
		...shown.map((e) => `- ${oneLine(e.name, 60)} (${oneLine(e.slug, 80)}) — ${oneLine(e.description, 120) || "（无描述）"}`),
	];
	if (entries.length > shown.length) lines.push(`另有 ${entries.length - shown.length} 个技能未列出，用 skill 工具 action=search 查找`);
	return lines.join("\n");
}

type SkillAction = "list" | "search" | "load" | "read" | "run";
const SKILL_ACTIONS: readonly SkillAction[] = ["list", "search", "load", "read", "run"];
const ACTION_PARAMS: Record<SkillAction, { required: readonly string[]; optional: readonly string[] }> = {
	list: { required: [], optional: [] },
	search: { required: ["query"], optional: [] },
	load: { required: ["name"], optional: [] },
	read: { required: ["name", "path"], optional: ["offset"] },
	run: { required: ["name"], optional: ["input", "script"] },
};
const PARAM_NAMES = ["name", "query", "path", "offset", "input", "script"] as const;

/** Strict per-action validation of the unified `skill` tool's arguments (400 invalid_args). */
export function validateSkillArgs(args: Record<string, unknown>): { action: SkillAction; name?: string; query?: string; path?: string; offset?: number; input?: string; script?: string } {
	const action = args.action as SkillAction;
	if (!SKILL_ACTIONS.includes(action)) throw new HttpError(400, "invalid_args", `action 必须是 ${SKILL_ACTIONS.join("、")} 之一`);
	const spec = ACTION_PARAMS[action];
	const allowed = new Set([...spec.required, ...spec.optional]);
	const extra = PARAM_NAMES.filter((k) => args[k] !== undefined && args[k] !== null && !allowed.has(k));
	if (extra.length) throw new HttpError(400, "invalid_args", `action=${action} 不接受参数：${extra.join(", ")}（可用参数：${[...allowed].join(", ") || "无"}）`);
	const missing = spec.required.filter((k) => args[k] === undefined || args[k] === null || (typeof args[k] === "string" && !String(args[k]).trim()));
	if (missing.length) throw new HttpError(400, "invalid_args", `action=${action} 缺少必填参数：${missing.join(", ")}`);
	for (const k of ["name", "query", "path", "input", "script"] as const) if (args[k] != null && typeof args[k] !== "string") throw new HttpError(400, "invalid_args", `参数 ${k} 必须是字符串`);
	if (args.offset != null && (typeof args.offset !== "number" || !Number.isFinite(args.offset) || args.offset < 0)) throw new HttpError(400, "invalid_args", "参数 offset 必须是不小于 0 的数字");
	return { action, name: args.name as string | undefined, query: args.query as string | undefined, path: args.path as string | undefined, offset: args.offset as number | undefined, input: args.input as string | undefined, script: args.script as string | undefined };
}

export function createSkillsExtension(ctx: AppContext, opts: { resolveActor?: ActorResolver } = {}): Extension {
	const skills = () => ctx.services.get("skills") as Skills;
	const market = () => ctx.services.get("market") as Market;
	const resolve = (api: ToolExecutionApi<any>, c: Context) => (opts.resolveActor ?? skills().resolveActor)(api, c);
	const log = () => ctx.services.get("toolCalls") as ToolCallLog;
	type Out = { text: string; isError?: boolean; details?: Record<string, string | number | boolean | { runId: string; spaceId: string }> };

	const describe = (mk: Market, { skill, version }: { skill: SkillRow; version: VersionRow }) =>
		`- ${skill.name}（/skills/${mk.slugOf(skill)}，${skill.kind}，v${version.version_no}${version.semver ? ` ${version.semver}` : ""}）：${version.description}${version.required_permissions !== "[]" ? `；需要授权：${JSON.parse(version.required_permissions).join(", ")}` : ""}`;

	// ----- shared implementations (the unified `skill` tool and the legacy skill_* tools call the same code) -----
	async function doList(actor: ToolActor, limit = 100): Promise<Out> {
		const act = await skills().active(actor.principal, actor.space);
		const mk = market();
		if (!act.length) return { text: "（用户没有启用的技能）" };
		const lines = act.slice(0, limit).map((a) => describe(mk, a));
		if (act.length > limit) lines.push(`另有 ${act.length - limit} 个技能未列出，用 skill 工具 action=search 查找`);
		return { text: lines.join("\n") };
	}
	async function doSearch(actor: ToolActor, query: string): Promise<Out> {
		const act = await skills().active(actor.principal, actor.space);
		const mk = market();
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		const hits = act
			.map((a) => {
				const hay = `${a.skill.name} ${mk.slugOf(a.skill)} ${a.version.description} ${a.skill.category ?? ""} ${a.skill.tags}`.toLowerCase();
				const name = `${a.skill.name} ${mk.slugOf(a.skill)}`.toLowerCase();
				return { a, s: words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0) + (name.includes(w) ? 1 : 0), 0), all: words.every((w) => hay.includes(w)) };
			})
			.filter((x) => x.s > 0)
			.sort((x, y) => Number(y.all) - Number(x.all) || y.s - x.s || x.a.skill.name.localeCompare(y.a.skill.name));
		if (!hits.length) return { text: `没有找到与「${query}」匹配的可用技能（共 ${act.length} 个可用技能；用 action=list 查看全部）` };
		const top = hits.slice(0, 20);
		const lines = top.map((h) => describe(mk, h.a));
		if (hits.length > top.length) lines.push(`另有 ${hits.length - top.length} 个匹配未列出，请换更具体的关键词`);
		return { text: lines.join("\n") };
	}
	/** After a load/read/run: say explicitly when the mount cap pushed older loaded skills out. */
	async function overflowNote(actor: ToolActor): Promise<string> {
		const plan = await market().loadedMountPlan(actor.principal, actor.space, actor.conversationId);
		return plan.skipped.length ? `\n注意：本会话已加载的技能超过沙箱挂载上限 ${market().mountCap}，以下较早加载的技能不再挂载到沙箱：${plan.skipped.map((x) => market().slugOf(x)).join(", ")}；需要在沙箱里使用它们的文件时请重新 action=load。` : "";
	}
	async function doLoad(actor: ToolActor, name: string): Promise<Out & { details: Out["details"] }> {
		const { skill, version } = await skills().resolveForUse(actor.principal, name, actor.space);
		skills().markLoaded(actor.space.id, actor.conversationId, skill, version);
		skills().recordRun({ skill, version, mode: "load", userId: actor.principal.userId, actor, status: "ok" });
		const res = (JSON.parse(version.resources) as Resource[]).filter((r) => r.path !== "SKILL.md");
		const slug = market().slugOf(skill);
		const text = `<skill name="${skill.name}" kind="${skill.kind}" version="${version.version_no}"${version.semver ? ` semver="${version.semver}"` : ""} dir="/skills/${slug}">\n${version.instructions}\n</skill>\n${res.length ? `资源（沙箱中只读挂载在 /skills/${slug}/ ，可用 skill 工具 action=read 读取文本）：${res.map((r) => r.path).join(", ")}\n` : ""}${SKILL_CONTRACT}${await overflowNote(actor)}`;
		return { text, details: { skillId: skill.id, versionId: version.id, versionNo: version.version_no } };
	}
	async function doRead(actor: ToolActor, name: string, path: string, offset?: number): Promise<Out> {
		const { skill, version } = await skills().resolveForUse(actor.principal, name, actor.space);
		const f = market().versionFiles(skill, version).find((x) => x.path === path.replace(/^\/+/, ""));
		if (!f) throw new HttpError(404, "file_not_found", `技能「${skill.name}」里没有文件 ${path}`);
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(f.bytes);
		} catch {
			throw new HttpError(415, "binary_file", `${path} 不是文本文件`);
		}
		skills().markLoaded(actor.space.id, actor.conversationId, skill, version);
		const off = Math.max(0, Math.floor(offset ?? 0));
		const chunk = text.slice(off, off + 30_000);
		return { text: `${chunk}${off + chunk.length < text.length ? `\n…（已截断，继续读取请传 offset=${off + chunk.length}）` : ""}${await overflowNote(actor)}`, details: { skillId: skill.id, versionNo: version.version_no, path: f.path } };
	}
	async function doRun(actor: ToolActor, name: string, input: string | undefined, scriptArg: string | undefined): Promise<Out> {
		const s = skills();
		const { skill, version } = await s.resolveForUse(actor.principal, name, actor.space);
		const deny = (msg: string): never => {
			s.recordRun({ skill, version, mode: "run", userId: actor.principal.userId, actor, status: "denied", detail: msg });
			throw new HttpError(403, "skill_not_granted", msg);
		};
		if (version.kind !== "executable" || !version.entry) deny(`技能「${skill.name}」v${version.version_no} 不是可执行技能，只能用 skill 工具 action=load 作为上下文`);
		let script: string | undefined;
		if (scriptArg && scriptArg !== version.entry) {
			if (!(JSON.parse(version.resources) as Resource[]).some((r) => r.path === scriptArg) || !/\.(py|sh|mjs|js)$/.test(scriptArg)) throw new HttpError(400, "script_not_found", `技能包里没有可运行的脚本 ${scriptArg}`);
			script = scriptArg;
		}
		const need: string[] = JSON.parse(version.required_permissions);
		const have = s.granted(version.id, actor.principal.userId);
		const missing = need.filter((x) => !have.includes(x));
		if (missing.length) deny(`技能「${skill.name}」v${version.version_no} 需要用户授权：${missing.join(", ")}（加载技能文本不等于授权）`);
		await ctx.services.get("acl").require(actor.principal, "write", { kind: "space", id: actor.space.id });
		const out = await s.execute(actor.principal, actor.space, skill, version, input ?? "", { conversationId: actor.conversationId, taskId: actor.taskId, callId: actor.callId, script });
		s.recordRun({ skill, version, mode: "run", userId: actor.principal.userId, actor, status: out.status === "ok" ? "ok" : "error", detail: `${out.status} exit=${out.exitCode} run=${out.runId}` });
		const text = `技能「${skill.name}」v${version.version_no}：${out.status}${out.exitCode !== undefined ? `（exit ${out.exitCode}）` : ""}\n${out.stdout ? `stdout:\n${out.stdout}\n` : ""}${out.stderr ? `stderr:\n${out.stderr}` : ""}`;
		return { text, isError: out.status !== "ok", details: { skillId: skill.id, versionNo: version.version_no, run: { runId: out.runId, spaceId: actor.space.id } } };
	}
	const wrap = (o: Out) => ({ output: [{ type: "text" as const, text: o.text }], ...(o.isError !== undefined ? { isError: o.isError } : {}), ...(o.details ? { details: o.details as any } : {}) });

	// ----- the unified tool -----
	// replay: "unsafe" — one tool covers action=run, which executes a script with workspace side effects; after a crash mid-call the model
	// gets an `interrupted` result instead of a silent re-run. The other actions are read-only (load/read only upsert the idempotent
	// "loaded in this conversation" row), so an interrupted one is simply re-issued by the model.
	const skillTool = defineTool({
		name: "skill",
		description:
			"Use the skills the user has installed (listed in the system prompt). action=list shows them all; action=search needs `query`; action=load needs `name` (name or slug) and returns the skill's instructions (SKILL.md) — loading also mounts its package read-only at /skills/<slug>/ in later sandbox runs and never grants permission to run scripts; " +
			"action=read needs `name` and `path` (optional `offset`) and returns a text file of the package; action=run needs `name` (optional `input`, `script`) and runs an executable skill in the sandbox (needs the user's grant for that exact version). Parameters not used by the chosen action are rejected.",
		parameters: obj({
			action: oneOf(SKILL_ACTIONS as unknown as ["list", "search", "load", "read", "run"], { description: "list | search | load | read | run" }),
			name: opt(str({ description: "Skill name or slug (load/read/run)" })),
			query: opt(str({ description: "Search words (search)" })),
			path: opt(str({ description: "Package-relative file path (read)" })),
			offset: opt(num({ description: "Character offset to continue a truncated read (read)" })),
			input: opt(str({ description: "Input string for the script (run)" })),
			script: opt(str({ description: "Package-relative script path, default: the skill's entry (run)" })),
		}),
		replay: "unsafe",
		async execute(args, api, c) {
			const actor = await resolve(api, c);
			return log().around({ tool: "skill", actor, args }, async () => {
				const a = validateSkillArgs(args as Record<string, unknown>);
				switch (a.action) {
					case "list":
						return wrap(await doList(actor));
					case "search":
						return wrap(await doSearch(actor, a.query!));
					case "load":
						return wrap(await doLoad(actor, a.name!));
					case "read":
						return wrap(await doRead(actor, a.name!, a.path!, a.offset));
					case "run":
						return wrap(await doRun(actor, a.name!, a.input, a.script));
				}
			});
		},
	});

	// ----- legacy tools: still executable (replay of existing transcripts, old calls), not offered to the model -----
	const list = defineTool({
		name: "skill_list",
		description: "(legacy; use the skill tool) List the skills the user has installed and enabled.",
		parameters: obj({}),
		replay: "safe",
		deferred: true,
		async execute(_a, api, c) {
			const actor = await resolve(api, c);
			return wrap(await doList(actor, 1000));
		},
	});
	const load = defineTool({
		name: "skill_load",
		description: "(legacy; use the skill tool action=load) Load an installed skill's instructions (SKILL.md) or prompt preset as context. Loading does not grant permission to run its scripts.",
		parameters: obj({ name: str() }),
		replay: "safe",
		deferred: true,
		async execute(args, api, c) {
			const actor = await resolve(api, c);
			return log().around({ tool: "skill_load", actor, args }, async () => wrap(await doLoad(actor, args.name)));
		},
	});
	const run = defineTool({
		name: "skill_run",
		description: "(legacy; use the skill tool action=run) Run an installed executable skill's entry script in the sandbox with an input string. Requires the user's grant for that exact skill version.",
		parameters: obj({ name: str(), input: opt(str()), script: opt(str({ description: "Package-relative script path, default: the skill's entry" })) }),
		replay: "unsafe",
		deferred: true,
		async execute(args, api, c) {
			const actor = await resolve(api, c);
			return log().around({ tool: "skill_run", actor, args }, async () => wrap(await doRun(actor, args.name, args.input, args.script)));
		},
	});
	const read = defineTool({
		name: "skill_read",
		description: "(legacy; use the skill tool action=read) Read a text file from an installed skill's package by relative path.",
		parameters: obj({ name: str(), path: str(), offset: opt(num()) }),
		replay: "safe",
		deferred: true,
		async execute(args, api, c) {
			const actor = await resolve(api, c);
			return log().around({ tool: "skill_read", actor, args }, async () => wrap(await doRead(actor, args.name, args.path, args.offset)));
		},
	});

	return defineExtension({
		name: "wr.skills",
		tools: [list, load, run, read, skillTool],
		sections: [
			section("skills", async (input, context) => {
				try {
					if (!ctx.services.has("runtime")) return undefined;
					const rt = ctx.services.get("runtime") as { promptScope?: (i: unknown, c: Context) => Promise<{ space: Space; principal: Principal | null } | null> };
					const scope = typeof rt.promptScope === "function" ? await rt.promptScope(input, context) : null;
					if (!scope?.principal) return undefined; // revoked / unknown actor: nothing actor-dependent
					const mk = market();
					if (!(await mk.can(scope.principal, "skill.use"))) return undefined;
					const act = await skills().active(scope.principal, scope.space);
					return renderSkillIndex(act.map(({ skill, version }) => ({ name: skill.name, slug: mk.slugOf(skill), description: version.description })));
				} catch {
					return undefined;
				}
			}),
		],
	});
}
