// Skills marketplace (round 4): package upload → immutable versions (zip blob + per-file blobs) → submission → automated checks →
// scoped reviewer → approve/reject/request changes → publish; install scopes (me / project / department / org); ratings;
// admin unpublish / force-publish; read-only materialisation of installed skills for the sandbox (/skills/<slug>/).
// Every state change is an event row (market_events) mirrored into the identity audit log.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, sep } from "node:path";
import type { AppContext, AuthzScope, Principal, Space } from "../core/contracts.ts";
import type { Migration } from "../core/db.ts";
import { HttpError, newId, nowIso } from "../core/http.ts";
import type { MarketMeDTO, MarketPolicyDTO, MarketScope, MarketSkillDetailDTO, MarketSkillSummaryDTO, MarketVersionDTO, PackageCheckDTO, PackageFileDTO, PackageFindingDTO, SkillManifestDTO, SubmissionDTO, SubmissionDetailDTO, SubmissionEventDTO, SubmissionKind, SubmissionState } from "../../../shared/files.ts";
import { buildPackage, compareSemver, diffPackages, LIMITS, normalizeFiles, PackageError, sha256Hex, unzipPackage, type PackageFile } from "./skills-package.ts";
import type { InstallRow, Resource, SkillRow, Skills, VersionRow } from "./skills.ts";
import type { Sandbox } from "./sandbox.ts";
import type { SandboxMount } from "./sandbox/driver.ts";

export const MARKET_MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "market: package versions, submissions, scope installs, ratings, policy",
		sql: `
ALTER TABLE skill_skills ADD COLUMN slug TEXT;
ALTER TABLE skill_skills ADD COLUMN scope_ref TEXT;
ALTER TABLE skill_skills ADD COLUMN published_version_no INTEGER;
ALTER TABLE skill_skills ADD COLUMN listed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE skill_skills ADD COLUMN category TEXT;
ALTER TABLE skill_skills ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE skill_skills ADD COLUMN unpublished_reason TEXT;
ALTER TABLE skill_versions ADD COLUMN semver TEXT;
ALTER TABLE skill_versions ADD COLUMN package_sha256 TEXT;
ALTER TABLE skill_versions ADD COLUMN package_size INTEGER;
ALTER TABLE skill_versions ADD COLUMN manifest TEXT;
ALTER TABLE skill_versions ADD COLUMN checks TEXT;
UPDATE skill_skills SET published_version_no = latest_version_no, listed = 1 WHERE scope = 'org';
CREATE TABLE skill_version_publish (
  version_id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, version_no INTEGER NOT NULL, approved_at TEXT NOT NULL, submission_id TEXT, forced INTEGER NOT NULL DEFAULT 0
);
INSERT INTO skill_version_publish (version_id, skill_id, version_no, approved_at, forced)
  SELECT v.id, v.skill_id, v.version_no, v.created_at, 1 FROM skill_versions v JOIN skill_skills s ON s.id = v.skill_id WHERE s.scope = 'org';
CREATE TABLE market_submissions (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, kind TEXT NOT NULL, subject_id TEXT NOT NULL, subject_name TEXT NOT NULL, version_id TEXT, version_no INTEGER,
  target_scope TEXT NOT NULL, target_ref TEXT, submitter_id TEXT NOT NULL, state TEXT NOT NULL, note TEXT, checks TEXT, forced INTEGER NOT NULL DEFAULT 0,
  decided_by TEXT, decided_at TEXT, decision_comment TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX market_submissions_org ON market_submissions(org_id, state);
CREATE INDEX market_submissions_subject ON market_submissions(subject_id);
CREATE TABLE market_events (
  id TEXT PRIMARY KEY, submission_id TEXT NOT NULL, org_id TEXT NOT NULL, at TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL,
  from_state TEXT, to_state TEXT, comment TEXT, detail TEXT
);
CREATE INDEX market_events_sub ON market_events(submission_id, at);
CREATE TABLE skill_scope_installs (
  skill_id TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_ref TEXT NOT NULL DEFAULT '', installed_by TEXT NOT NULL, pinned_version_no INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1, installed_at TEXT NOT NULL, PRIMARY KEY (skill_id, scope_kind, scope_ref)
);
CREATE TABLE skill_ratings (skill_id TEXT NOT NULL, user_id TEXT NOT NULL, stars INTEGER NOT NULL, comment TEXT, at TEXT NOT NULL, PRIMARY KEY (skill_id, user_id));
CREATE TABLE market_policy (org_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (org_id, key));
`,
	},
	{
		version: 2,
		name: "skills: per-conversation loaded skills (on-demand sandbox mounts)",
		sql: `
CREATE TABLE skill_conv_loaded (
  space_id TEXT NOT NULL, conversation_id INTEGER NOT NULL, skill_id TEXT NOT NULL, version_id TEXT NOT NULL, loaded_at TEXT NOT NULL,
  PRIMARY KEY (space_id, conversation_id, skill_id)
);
`,
	},
];

let tmpSeq = 0;
/** Remove a directory tree whose directories were made read-only (chmod u+w on the way down; never follows symlinks). */
function rmReadOnlyTree(path: string): void {
	try {
		const walk = (p: string) => {
			const st = lstatSync(p);
			if (!st.isDirectory()) return;
			chmodSync(p, 0o755);
			for (const n of readdirSync(p)) walk(join(p, n));
		};
		walk(path);
	} catch {
		/* best effort */
	}
	rmSync(path, { recursive: true, force: true });
}

/**
 * Write `files` into `dir` atomically and read-only: everything goes to a unique sibling temp directory, which is renamed into place
 * (a loser of a race with identical content just discards its copy). Paths are re-checked to stay inside the temp directory.
 * Safe to run concurrently, also from several processes. No-op when `dir` already exists.
 */
export function writeContentAddressed(dir: string, files: readonly { path: string; bytes: Uint8Array }[]): void {
	if (existsSync(dir)) return;
	// Unique temp dir per call (pid + counter + random): two parallel materialisations of the same content never share a directory.
	const tmp = `${dir}.tmp-${process.pid}-${(tmpSeq++).toString(36)}-${randomBytes(4).toString("hex")}`;
	mkdirSync(tmp, { recursive: true });
	try {
		const dirs = new Set<string>([tmp]);
		for (const f of files) {
			const target = join(tmp, f.path);
			if (!target.startsWith(tmp + sep)) throw new HttpError(500, "bad_skill_path", `技能资源路径越界：${f.path}`);
			mkdirSync(dirname(target), { recursive: true });
			for (let d = dirname(target); d.length > tmp.length; d = dirname(d)) dirs.add(d);
			writeFileSync(target, f.bytes, { flag: "wx" }); // never follows or overwrites an existing entry
			chmodSync(target, /(^|\/)scripts\/|\.(sh|py|mjs|js)$/.test(f.path) ? 0o555 : 0o444);
		}
		for (const d of [...dirs].sort((a, b) => b.length - a.length)) chmodSync(d, 0o555);
		try {
			renameSync(tmp, dir);
		} catch (e) {
			if (!existsSync(dir)) throw e; // lost a race with another materialisation of identical content
			rmReadOnlyTree(tmp);
		}
	} catch (e) {
		rmReadOnlyTree(tmp);
		throw e;
	}
}

/** Hard cap of skill packages mounted into one sandbox run (most recently loaded win; the rest are reported, never dropped silently). */
export const MAX_SKILL_MOUNTS = 32;

/** Allowed state changes of a submission. Anything else is a 409. */
export const TRANSITIONS: Readonly<Record<SubmissionState, readonly SubmissionState[]>> = {
	checks_failed: [],
	pending_review: ["approved", "rejected", "changes_requested", "withdrawn", "superseded"],
	changes_requested: ["withdrawn", "superseded"],
	rejected: [],
	approved: ["published", "withdrawn"],
	published: ["unpublished"],
	unpublished: ["published"],
	withdrawn: [],
	superseded: [],
};

export interface SubRow {
	id: string;
	org_id: string;
	kind: SubmissionKind;
	subject_id: string;
	subject_name: string;
	version_id: string | null;
	version_no: number | null;
	target_scope: MarketScope;
	target_ref: string | null;
	submitter_id: string;
	state: SubmissionState;
	note: string | null;
	checks: string | null;
	forced: number;
	decided_by: string | null;
	decided_at: string | null;
	decision_comment: string | null;
	created_at: string;
	updated_at: string;
}

const DEFAULT_POLICY: MarketPolicyDTO = { personalSkill: "free", personalMcp: "free" };

export interface UploadInput {
	skillId?: string;
	zip?: Uint8Array;
	files?: readonly { path: string; content: string; encoding?: "utf8" | "base64" }[];
	changeNote?: string;
}

export class Market {
	readonly #ctx: AppContext;
	/** Tests may replace the permission check (e.g. to exercise a department-scoped reviewer without role plumbing). */
	authzOverride?: (p: Principal, permission: string, scope?: AuthzScope) => Promise<boolean>;
	#names = new Map<string, string>();
	#offProvider: (() => void) | undefined;
	/** Mount cap per run (tests may lower it). */
	mountCap = MAX_SKILL_MOUNTS;

	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}
	get #db() {
		return this.#ctx.db;
	}
	get skills(): Skills {
		return this.#ctx.services.get("skills") as Skills;
	}

	start(): void {
		const sb = this.#sandbox();
		if (!sb) return;
		// Every run / service of a conversation sees the caller's installed skills read-only at /skills/<slug>/.
		// On demand: only the skills this conversation has loaded (skill load/read/run), re-checked against what is active NOW, so
		// uninstall / unpublish / department removal / re-pin take effect on the next run. Over the cap the most recent win, and the run says so.
		this.#offProvider = sb.addMountProvider("skills", async ({ principal, space, conversationId, notes }) => {
			const plan = await this.loadedMountPlan(principal, space, conversationId);
			if (plan.skipped.length) notes?.push(`[技能挂载] 已加载的技能超过挂载上限 ${MAX_SKILL_MOUNTS}，以下技能本次未挂载（较早加载的先被省略）：${plan.skipped.map((x) => this.slugOf(x)).join(", ")}；需要时请用 skill 工具 action=load 重新加载。`);
			if (plan.failed.length) notes?.push(`[技能挂载] 以下技能的文件无法挂载：${plan.failed.map((x) => this.slugOf(x)).join(", ")}`);
			return plan.mounts.map((x) => x.mount);
		});
	}
	stop(): void {
		this.#offProvider?.();
	}
	#sandbox(): Sandbox | null {
		return this.#ctx.services.has("sandbox") ? (this.#ctx.services.get("sandbox") as Sandbox) : null;
	}

	// ------------------------------------------------------------ permissions
	async can(p: Principal, permission: string, scope?: AuthzScope): Promise<boolean> {
		if (this.authzOverride) return this.authzOverride(p, permission, scope);
		// The RBAC authz service is always provided by the identity module; without it nothing is granted (fail closed).
		return this.#ctx.services.has("authz") ? this.#ctx.services.get("authz").has(p, permission, scope) : false;
	}
	async require(p: Principal, permission: string, scope?: AuthzScope, message?: string): Promise<void> {
		if (!(await this.can(p, permission, scope))) throw new HttpError(403, "forbidden", message ?? `缺少权限 ${permission}`);
	}
	/** Anyone allowed to review/administer skills at org level. */
	async isManager(p: Principal): Promise<boolean> {
		return this.can(p, "skill.marketplace.manage");
	}
	async #userName(orgId: string, userId: string): Promise<string> {
		const k = `${orgId}:${userId}`;
		const hit = this.#names.get(k);
		if (hit) return hit;
		const pr = await this.#ctx.services.get("identity").principalFor(userId, orgId).catch(() => null);
		const n = pr?.displayName ?? userId;
		if (this.#names.size > 500) this.#names.clear();
		this.#names.set(k, n);
		return n;
	}

	// ------------------------------------------------------------ policy
	policy(orgId: string): MarketPolicyDTO {
		const out: any = { ...DEFAULT_POLICY };
		for (const r of this.#db.all<{ key: string; value: string }>("SELECT key, value FROM market_policy WHERE org_id = ?", orgId)) if (r.key in out) out[r.key] = r.value;
		return out;
	}
	async setPolicy(p: Principal, patch: Partial<MarketPolicyDTO>): Promise<MarketPolicyDTO> {
		await this.require(p, "skill.marketplace.manage", undefined, "只有技能市场管理员可以修改策略");
		const ok: Record<string, string[]> = { personalSkill: ["free", "review", "disabled"], personalMcp: ["free", "approval", "disabled"] };
		for (const [k, v] of Object.entries(patch)) {
			if (!ok[k]?.includes(String(v))) throw new HttpError(400, "invalid", `策略 ${k} 的取值无效：${v}`);
			this.#db.run("INSERT INTO market_policy (org_id, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at", p.orgId, k, String(v), p.userId, nowIso());
		}
		this.audit(p, "market.policy.set", p.orgId, patch);
		return this.policy(p.orgId);
	}

	async me(p: Principal): Promise<MarketMeDTO> {
		const sb = this.#sandbox();
		const cap = sb ? await sb.capabilities().catch(() => null) : null;
		const pol = this.policy(p.orgId);
		return {
			canUploadSkill: pol.personalSkill !== "disabled" ? await this.can(p, "skill.upload") : await this.can(p, "skill.publish"),
			canReviewSkills: await this.canReviewAnything(p, "skill"),
			canReviewMcp: await this.canReviewAnything(p, "mcp"),
			canManageMarket: await this.isManager(p),
			canPublishOrg: await this.can(p, "skill.publish"),
			canAddOrgConnector: await this.can(p, "mcp.connector.add_org"),
			policy: pol,
			sandbox: { state: cap?.state ?? "unavailable", detail: cap?.detail, mounts: !!cap?.mounts, services: !!cap?.services },
			limits: { uploadBytes: LIMITS.uploadBytes, totalBytes: LIMITS.totalBytes, fileBytes: LIMITS.fileBytes, files: LIMITS.files },
		};
	}
	/** Reviewer of any scope: org level, or any department the caller is in (department-scoped reviewers only see their own subtree's queue). */
	async canReviewAnything(p: Principal, family: "skill" | "mcp"): Promise<boolean> {
		const perm = family === "skill" ? "skill.review" : "mcp.connector.review";
		if (await this.can(p, perm)) return true;
		for (const d of p.departmentIds) if (await this.can(p, perm, { kind: "department", id: d })) return true;
		return false;
	}

	audit(p: Principal | { orgId: string; userId: string }, action: string, target: string, detail: unknown): void {
		try {
			this.#db.run("INSERT INTO id_audit (id, org_id, actor_user_id, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)", newId("aud"), p.orgId, p.userId, action, target, JSON.stringify(detail ?? {}), nowIso());
		} catch {
			/* audit table owned by the identity module; absence must not break the market */
		}
	}

	// ------------------------------------------------------------ rows & helpers
	sub(id: string): SubRow | undefined {
		return this.#db.get<SubRow>("SELECT * FROM market_submissions WHERE id = ?", id);
	}
	versionApproved(versionId: string): boolean {
		return !!this.#db.get("SELECT 1 FROM skill_version_publish WHERE version_id = ?", versionId);
	}
	/** Newest version a follower of the skill gets: the author's own latest for free personal skills, otherwise the latest approved one. */
	latestUsable(s: SkillRow): number {
		if (s.scope === "personal" && this.policy(s.org_id).personalSkill !== "review") return s.latest_version_no;
		return s.published_version_no ?? 0;
	}
	usable(s: SkillRow, v: VersionRow): { ok: true } | { ok: false; reason: string; message: string } {
		if (s.scope === "personal") {
			const pol = this.policy(s.org_id).personalSkill;
			if (pol === "disabled") return { ok: false, reason: "policy_disabled", message: "组织策略不允许使用个人技能" };
			if (pol === "review" && !this.versionApproved(v.id)) return { ok: false, reason: "pending_review", message: `技能「${s.name}」v${v.version_no} 尚未通过审核` };
			return { ok: true };
		}
		if (!s.listed) return { ok: false, reason: "unlisted", message: `技能「${s.name}」已下架${s.unpublished_reason ? `：${s.unpublished_reason}` : ""}` };
		if (!this.versionApproved(v.id)) return { ok: false, reason: "not_approved", message: `技能「${s.name}」v${v.version_no} 未经审核，不能使用` };
		return { ok: true };
	}
	slugOf(s: SkillRow): string {
		if (s.slug) return s.slug;
		const base = String(s.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
		const slug = `${base || "skill"}-${s.id.slice(-6)}`;
		this.#db.run("UPDATE skill_skills SET slug = ? WHERE id = ? AND slug IS NULL", slug, s.id);
		return slug;
	}
	versionFiles(s: SkillRow, v: VersionRow): PackageFile[] {
		const res: Resource[] = JSON.parse(v.resources);
		const out: PackageFile[] = [];
		for (const r of res) {
			const bytes = this.#ctx.blobs.get(r.sha256);
			if (!bytes) throw new HttpError(500, "blob_missing", `技能资源缺失 ${r.path}`);
			out.push({ path: r.path, bytes });
		}
		if (!out.some((f) => f.path === "SKILL.md")) {
			// Legacy (pre-package) versions keep their text in the row: synthesise the SKILL.md the sandbox will see.
			const md = `---\nname: ${this.slugOf(s)}\ndescription: ${JSON.stringify(v.description || s.name)}\n---\n\n${v.instructions}\n`;
			out.unshift({ path: "SKILL.md", bytes: new TextEncoder().encode(md) });
		}
		return out;
	}

	// ------------------------------------------------------------ upload
	/** Parse + validate + store a package as a new skill (personal scope) or a new version of `skillId`. */
	async upload(p: Principal, input: UploadInput): Promise<{ skill: SkillRow; version: VersionRow; check: PackageCheckDTO; submission?: SubmissionDTO }> {
		const pol = this.policy(p.orgId);
		if (pol.personalSkill === "disabled") await this.require(p, "skill.publish", undefined, "组织策略不允许上传个人技能");
		else await this.require(p, "skill.upload", undefined, "没有上传技能的权限");
		let raw: { path: string; bytes: Uint8Array }[];
		try {
			if (input.zip) raw = unzipPackage(input.zip);
			else if (input.files?.length) {
				let total = 0;
				raw = input.files.map((f) => {
					const bytes = f.encoding === "base64" ? new Uint8Array(Buffer.from(f.content, "base64")) : new TextEncoder().encode(f.content);
					total += bytes.byteLength;
					if (total > LIMITS.uploadBytes) throw new PackageError("upload_too_large", `上传内容超过 ${Math.round(LIMITS.uploadBytes / 1048576)} MB`);
					return { path: f.path, bytes };
				});
			} else throw new PackageError("empty_package", "没有收到文件：上传 .zip，或提供 files 数组");
		} catch (e) {
			throw this.#pkgError(e);
		}
		let built: ReturnType<typeof buildPackage>;
		try {
			built = buildPackage(raw, nowIso());
		} catch (e) {
			throw this.#pkgError(e);
		}
		const m = built.parsed.manifest;
		let skill: SkillRow | undefined;
		if (input.skillId) {
			skill = this.skills.skill(input.skillId);
			if (!skill) throw new HttpError(404, "not_found", "技能不存在");
			if (!(await this.skills.decide(p, "write", skill.id)).allow) throw new HttpError(403, "forbidden", "只有技能的作者或市场管理员可以上传新版本");
			if (this.slugOf(skill) !== m.name) throw new HttpError(409, "name_mismatch", `包的 name「${m.name}」必须与已有技能「${this.slugOf(skill)}」一致；要发布另一个技能请新建`);
		} else {
			const taken = this.#db.get<{ id: string; scope: string }>("SELECT id, scope FROM skill_skills WHERE org_id = ? AND slug = ? AND status = 'active' AND (owner_user_id = ? OR scope != 'personal')", p.orgId, m.name, p.userId);
			if (taken) throw new HttpError(409, "slug_taken", `名称「${m.name}」已被占用（${taken.scope === "personal" ? "你的另一个技能" : "市场中的技能"}）；若要更新它，请在该技能上传新版本，否则请改 name`);
		}
		const existing = skill ? this.skills.versions(skill.id) : [];
		const same = existing.find((v) => v.package_sha256 === built.packageSha256);
		if (same) throw new HttpError(409, "duplicate_content", `内容与已有版本 v${same.version_no} 完全相同，无需重复上传`);
		const dupSemver = existing.find((v) => v.semver === m.version);
		if (dupSemver) throw new HttpError(409, "version_exists", `版本号 ${m.version} 已存在（v${dupSemver.version_no}）；已发布的版本不可修改，请递增 version`);
		// Store blobs: the canonical zip is the version identity; per-file blobs serve the tree, diff and read-only materialisation.
		this.#ctx.blobs.put(built.zip);
		const resources: Resource[] = built.files.map((f) => ({ path: f.path, ...this.#ctx.blobs.put(f.bytes) }));
		const now = nowIso();
		const title = (m.title ?? m.name).slice(0, 80);
		const checks: PackageCheckDTO = built.check;
		const { skillId, no } = this.#db.tx(() => {
			let id = skill?.id;
			let n = 1;
			if (!id) {
				id = newId("skl");
				this.#db.run(
					"INSERT INTO skill_skills (id, org_id, scope, owner_user_id, name, kind, latest_version_no, created_at, updated_at, slug, category, tags) VALUES (?, ?, 'personal', ?, ?, ?, 1, ?, ?, ?, ?, ?)",
					id, p.orgId, p.userId, title, m.kind, now, now, m.name, m.category ?? null, JSON.stringify(m.tags),
				);
			} else {
				n = skill!.latest_version_no + 1;
				this.#db.run("UPDATE skill_skills SET latest_version_no = ?, kind = ?, category = ?, tags = ?, updated_at = ? WHERE id = ?", n, m.kind, m.category ?? null, JSON.stringify(m.tags), now, id);
			}
			this.#db.run(
				"INSERT INTO skill_versions (id, skill_id, version_no, kind, description, instructions, resources, entry, required_tools, required_permissions, change_note, source, validation, created_by, created_at, semver, package_sha256, package_size, manifest, checks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'package', NULL, ?, ?, ?, ?, ?, ?, ?)",
				newId("skv"), id, n, m.kind, m.description, built.parsed.body.slice(0, 100_000), JSON.stringify(resources), m.entry ?? null, JSON.stringify(m.requiredTools), JSON.stringify(m.requiredPermissions),
				input.changeNote?.slice(0, 500) ?? (n === 1 ? "初版" : null), p.userId, now, m.version, built.packageSha256, built.zip.byteLength, JSON.stringify(m), JSON.stringify(checks),
			);
			return { skillId: id, no: n };
		});
		const row = this.skills.skill(skillId)!;
		const version = this.skills.version(skillId, no)!;
		this.audit(p, "skill.upload", skillId, { slug: m.name, version: m.version, versionNo: no, sha256: built.packageSha256, warnings: checks.findings.filter((f) => f.severity === "warn").length });
		let submission: SubmissionDTO | undefined;
		if (!input.skillId && pol.personalSkill === "free") await this.skills.installFor(p, skillId);
		if (row.scope === "personal" && pol.personalSkill === "review") {
			const sub = await this.submit(p, skillId, no, { targetScope: "personal", note: "个人技能（组织策略要求审核）" });
			submission = await this.#subDTO(p, this.sub(sub.id)!);
			if (!input.skillId) await this.skills.installFor(p, skillId);
		}
		return { skill: this.skills.skill(skillId)!, version, check: checks, submission };
	}
	#pkgError(e: unknown): HttpError {
		if (e instanceof HttpError) return e;
		if (e instanceof PackageError) {
			const status = /too_large|too_many|zip_bomb/.test(e.code) ? 413 : 400;
			return new HttpError(status, e.code, e.message, e.findings ? { findings: e.findings } : undefined);
		}
		throw e;
	}

	// ------------------------------------------------------------ submissions
	/** Submit one version for distribution at `targetScope`. Runs the automated checks; the result is pending_review or checks_failed. */
	async submit(p: Principal, skillId: string, versionNo: number, input: { targetScope: MarketScope; targetRef?: string; note?: string }): Promise<SubmissionDTO> {
		const s = this.skills.skill(skillId);
		if (!s || s.org_id !== p.orgId) throw new HttpError(404, "not_found", "技能不存在");
		if (!(await this.skills.decide(p, "write", s.id)).allow) throw new HttpError(403, "forbidden", "只有技能的作者或市场管理员可以提交审核");
		const v = this.skills.version(skillId, versionNo);
		if (!v) throw new HttpError(404, "version_not_found", "版本不存在");
		const target = input.targetScope;
		const ref = input.targetRef ?? null;
		if (!["personal", "project", "department", "org"].includes(target)) throw new HttpError(400, "invalid", "targetScope 无效");
		await this.#requirePublishRight(p, target, ref);
		if (target === "personal" && this.policy(p.orgId).personalSkill !== "review") throw new HttpError(409, "not_required", "组织策略未要求个人技能审核");
		if (this.versionApproved(v.id) && this.#sameTarget(s, target, ref) && s.listed) throw new HttpError(409, "already_published", `v${versionNo} 已经发布`);
		// Automated checks (re-run at submit time, because org context changes: slug taken, version order, tool availability).
		const stored: PackageCheckDTO | undefined = v.checks ? JSON.parse(v.checks) : undefined;
		const findings: PackageFindingDTO[] = [...(stored?.findings ?? [])];
		const add = (severity: PackageFindingDTO["severity"], code: string, message: string) => findings.push({ severity, code, message });
		const manifest: SkillManifestDTO | undefined = v.manifest ? JSON.parse(v.manifest) : undefined;
		if (!v.package_sha256) add("info", "legacy_version", "这是旧格式（非包）版本，没有 SKILL.md 包与静态扫描结果；建议上传为技能包");
		if (target !== "personal") {
			const slug = this.slugOf(s);
			const clash = this.#db.get<{ id: string }>("SELECT id FROM skill_skills WHERE org_id = ? AND slug = ? AND id != ? AND status = 'active' AND listed = 1 AND scope != 'personal'", s.org_id, slug, s.id);
			if (clash) add("error", "slug_taken", `市场中已有另一个名为「${slug}」的技能`);
			if (s.published_version_no) {
				const pub = this.skills.version(s.id, s.published_version_no);
				if (pub?.semver && v.semver && compareSemver(v.semver, pub.semver) <= 0 && v.version_no > pub.version_no) add("error", "version_not_increasing", `版本 ${v.semver} 必须大于已发布的 ${pub.semver}`);
			}
		}
		const perms: string[] = JSON.parse(v.required_permissions);
		if (perms.includes("network")) add("warn", "network_unsatisfiable", "声明了 network 权限：使用前需要用户授权；能否联网取决于所用的执行环境");
		const known = new Set(this.#knownTools());
		const missingTools = (JSON.parse(v.required_tools) as string[]).filter((t) => !known.has(t));
		if (missingTools.length) add("warn", "unknown_tool", `依赖的工具当前不可用：${missingTools.join("、")}`);
		const errs = findings.filter((f) => f.severity === "error");
		const checks: PackageCheckDTO = { ok: errs.length === 0, at: nowIso(), findings, stats: stored?.stats ?? { fileCount: JSON.parse(v.resources).length, totalBytes: 0, packageBytes: v.package_size ?? 0, scriptCount: 0 } };
		const id = newId("sub");
		const now = nowIso();
		this.#db.tx(() => {
			// A newer submission of the same skill replaces the older pending one (the reviewer should only see the latest).
			for (const old of this.#db.all<SubRow>("SELECT * FROM market_submissions WHERE kind = 'skill' AND subject_id = ? AND state IN ('pending_review','changes_requested')", skillId)) this.#move(old, "superseded", p, "superseded", `被 v${versionNo} 的新提交取代`);
			this.#db.run(
				"INSERT INTO market_submissions (id, org_id, kind, subject_id, subject_name, version_id, version_no, target_scope, target_ref, submitter_id, state, note, checks, created_at, updated_at) VALUES (?, ?, 'skill', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				id, p.orgId, skillId, s.name, v.id, versionNo, target, ref, p.userId, checks.ok ? "pending_review" : "checks_failed", input.note?.slice(0, 1000) ?? null, JSON.stringify(checks), now, now,
			);
			this.#event(id, p.orgId, p.userId, "submit", undefined, checks.ok ? "pending_review" : "checks_failed", input.note);
		});
		void manifest;
		this.audit(p, "skill.submit", skillId, { submissionId: id, versionNo, target, ref, ok: checks.ok });
		return this.#subDTO(p, this.sub(id)!);
	}
	/** Open a submission for a non-skill subject (MCP catalog version, personal connector). Supersedes older open ones of the same subject. */
	openSubmission(p: Principal, input: { kind: SubmissionKind; subjectId: string; subjectName: string; versionId?: string; versionNo?: number; target: MarketScope; ref?: string | null; note?: string; checks: PackageCheckDTO }): string {
		const id = newId("sub");
		const now = nowIso();
		const state: SubmissionState = input.checks.ok ? "pending_review" : "checks_failed";
		this.#db.tx(() => {
			for (const old of this.#db.all<SubRow>("SELECT * FROM market_submissions WHERE kind = ? AND subject_id = ? AND state IN ('pending_review','changes_requested')", input.kind, input.subjectId)) this.#move(old, "superseded", p, "superseded", "被新的提交取代");
			this.#db.run(
				"INSERT INTO market_submissions (id, org_id, kind, subject_id, subject_name, version_id, version_no, target_scope, target_ref, submitter_id, state, note, checks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				id, p.orgId, input.kind, input.subjectId, input.subjectName, input.versionId ?? null, input.versionNo ?? null, input.target, input.ref ?? null, p.userId, state, input.note?.slice(0, 1000) ?? null, JSON.stringify(input.checks), now, now,
			);
			this.#event(id, p.orgId, p.userId, "submit", undefined, state, input.note);
		});
		this.audit(p, `${input.kind === "skill" ? "skill" : "mcp"}.submit`, input.subjectId, { submissionId: id, target: input.target, ref: input.ref, ok: input.checks.ok });
		return id;
	}
	submissionDTO(p: Principal, id: string): Promise<SubmissionDTO> {
		return this.#subDTO(p, this.sub(id)!);
	}
	/** Force-publish / admin-direct for MCP kinds goes through the same trail. */
	directApproveOther(p: Principal, input: { kind: SubmissionKind; subjectId: string; subjectName: string; versionId?: string; versionNo?: number; target: MarketScope; ref?: string | null; note: string; checks: PackageCheckDTO }): string {
		const id = this.openSubmission(p, input);
		this.#db.tx(() => {
			const sub = this.sub(id)!;
			this.#move(sub, "approved", p, "approve", input.note, { decided: true, forced: true });
			this.#publish(sub, p, input.note);
		});
		return id;
	}
	#sameTarget(s: SkillRow, target: MarketScope, ref: string | null): boolean {
		return s.scope === target && (s.scope_ref ?? null) === (target === "org" || target === "personal" ? null : ref);
	}
	#knownTools(): string[] {
		try {
			const rt = this.#ctx.services.has("runtime") ? (this.#ctx.services.get("runtime") as any) : null;
			const reg = rt?.registry ?? rt?.manager?.registry;
			const names = new Set<string>(["file_create", "file_revise", "file_read", "file_list", "sandbox_exec", "sandbox_write_file", "sandbox_read_file", "sandbox_list", "sandbox_publish", "browse", "skill", "skill_list", "skill_load", "skill_read", "skill_run", "tool_search", "codemode"]);
			for (const t of reg?.snapshot?.().tools?.() ?? []) names.add(t.tool?.name ?? t.name);
			for (const t of (this.#ctx.services.get("mcp") as any).piTools()) names.add(t.name);
			return [...names];
		} catch {
			return [];
		}
	}
	/** Predicts `submit` for a version at `target`/`ref` (same publish-right rule) without side effects, so callers can refuse before asking the user. */
	async canSubmitTo(p: Principal, target: MarketScope, ref: string | null): Promise<boolean> {
		try {
			await this.#requirePublishRight(p, target, ref);
			return true;
		} catch {
			return false;
		}
	}
	/** Who may put something at a scope: org/department → skill.publish there; project → write access to the project space. */
	async #requirePublishRight(p: Principal, target: MarketScope, ref: string | null): Promise<void> {
		if (target === "personal") return;
		if (target === "org") return this.require(p, "skill.publish", { kind: "org" }, "没有向组织发布技能的权限（skill.publish）");
		if (!ref) throw new HttpError(400, "invalid", `${target === "department" ? "部门" : "项目"}范围需要 targetRef`);
		if (target === "department") return this.require(p, "skill.publish", { kind: "department", id: ref }, "没有向该部门发布技能的权限");
		const space = this.#ctx.services.get("identity").projectSpace(ref);
		if (!space || space.orgId !== p.orgId) throw new HttpError(404, "project_not_found", "项目不存在");
		await this.#ctx.services.get("acl").require(p, "write", { kind: "space", id: space.id });
	}

	#event(subId: string, orgId: string, actorId: string, action: string, from: SubmissionState | undefined, to: SubmissionState | undefined, comment?: string, detail?: unknown): void {
		this.#db.run("INSERT INTO market_events (id, submission_id, org_id, at, actor_id, action, from_state, to_state, comment, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", newId("mev"), subId, orgId, nowIso(), actorId, action, from ?? null, to ?? null, comment?.slice(0, 2000) ?? null, detail ? JSON.stringify(detail) : null);
	}
	/** Validated state change + event. */
	#move(sub: SubRow, to: SubmissionState, actor: { userId: string }, action: string, comment?: string, extra: { decided?: boolean; forced?: boolean } = {}): void {
		if (!TRANSITIONS[sub.state].includes(to)) throw new HttpError(409, "bad_transition", `提交已是「${sub.state}」状态，不能转为「${to}」`);
		this.#db.run(
			"UPDATE market_submissions SET state = ?, updated_at = ?, decided_by = CASE WHEN ? THEN ? ELSE decided_by END, decided_at = CASE WHEN ? THEN ? ELSE decided_at END, decision_comment = CASE WHEN ? THEN ? ELSE decision_comment END, forced = CASE WHEN ? THEN 1 ELSE forced END WHERE id = ?",
			to, nowIso(), extra.decided ? 1 : 0, actor.userId, extra.decided ? 1 : 0, nowIso(), extra.decided ? 1 : 0, comment ?? null, extra.forced ? 1 : 0, sub.id,
		);
		this.#event(sub.id, sub.org_id, actor.userId, action, sub.state, to, comment);
		sub.state = to;
	}

	/** Permission part of "may decide": scoped reviewer. The submitter-is-not-the-reviewer rule is applied separately. */
	async reviewScopeAllows(p: Principal, sub: SubRow): Promise<boolean> {
		if (sub.org_id !== p.orgId) return false;
		const perm = sub.kind === "skill" ? "skill.review" : "mcp.connector.review";
		if (sub.target_scope === "org") return this.can(p, perm, { kind: "org" });
		if (sub.target_scope === "department" && sub.target_ref) return this.can(p, perm, { kind: "department", id: sub.target_ref });
		if (sub.target_scope === "project" && sub.target_ref) {
			if (await this.can(p, perm, { kind: "org" })) return true;
			const space = this.#ctx.services.get("identity").projectSpace(sub.target_ref);
			return !!space && (await this.#ctx.services.get("acl").check(p, "admin", { kind: "space", id: space.id })).allow;
		}
		// personal skill (policy review) / personal connector: org-level reviewers, or a department reviewer of one of the submitter's departments.
		if (await this.can(p, perm, { kind: "org" })) return true;
		const submitter = await this.#ctx.services.get("identity").principalFor(sub.submitter_id, sub.org_id).catch(() => null);
		for (const d of submitter?.departmentIds ?? []) if (await this.can(p, perm, { kind: "department", id: d })) return true;
		return false;
	}
	async canDecide(p: Principal, sub: SubRow): Promise<boolean> {
		return sub.state === "pending_review" && sub.submitter_id !== p.userId && (await this.reviewScopeAllows(p, sub));
	}

	async decide(p: Principal, id: string, input: { decision: "approve" | "reject" | "request_changes"; comment?: string; publish?: boolean; force?: boolean }): Promise<SubmissionDTO> {
		const sub = this.sub(id);
		if (!sub || sub.org_id !== p.orgId) throw new HttpError(404, "not_found", "提交不存在");
		if (!["approve", "reject", "request_changes"].includes(input.decision)) throw new HttpError(400, "invalid", "decision 必须是 approve、reject 或 request_changes");
		if (sub.state !== "pending_review") throw new HttpError(409, "bad_transition", `提交已是「${sub.state}」状态，不能再审批`);
		const comment = input.comment?.trim() ?? "";
		const scoped = await this.reviewScopeAllows(p, sub);
		let forced = false;
		if (!scoped) throw new HttpError(403, "forbidden", "你没有审核该范围提交的权限（skill.review 按组织/部门/项目授权）");
		if (sub.submitter_id === p.userId) {
			// Separation of duties. The only way around it is an explicit, audited force by a market manager.
			const manager = sub.kind === "skill" ? await this.isManager(p) : await this.can(p, "mcp.connector.review", { kind: "org" });
			if (!input.force || !manager) throw new HttpError(403, "self_review", "不能审核自己提交的内容；需要另一位审核员（市场管理员可附理由强制通过并留审计）");
			if (!comment) throw new HttpError(400, "reason_required", "强制通过必须填写理由");
			forced = true;
		}
		if ((input.decision === "reject" || input.decision === "request_changes") && !comment) throw new HttpError(400, "comment_required", "驳回或要求修改必须写明原因");
		const to: SubmissionState = input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "changes_requested";
		this.#db.tx(() => {
			this.#move(sub, to, p, input.decision, comment || undefined, { decided: true, forced });
			if (sub.kind !== "skill" && to !== "approved") (this.#ctx.services.get("mcpMarket") as { onDecision(sub: SubRow, to: SubmissionState): void }).onDecision(sub, to);
			if (to === "approved") {
				this.#recordApproval(sub, forced);
				if (input.publish !== false) this.#publish(sub, p, comment || undefined);
			}
		});
		this.audit(p, `${sub.kind === "skill" ? "skill" : "mcp"}.${input.decision}`, sub.subject_id, { submissionId: sub.id, versionNo: sub.version_no, forced, published: to === "approved" && input.publish !== false });
		return this.#subDTO(p, this.sub(id)!);
	}
	/** Approved but not yet published (decide with publish:false): publish later. */
	async publishApproved(p: Principal, id: string): Promise<SubmissionDTO> {
		const sub = this.sub(id);
		if (!sub || sub.org_id !== p.orgId) throw new HttpError(404, "not_found", "提交不存在");
		if (sub.state !== "approved") throw new HttpError(409, "bad_transition", "只有已批准的提交可以发布");
		if (!(await this.reviewScopeAllows(p, sub)) && sub.submitter_id !== p.userId) throw new HttpError(403, "forbidden", "无权发布");
		this.#db.tx(() => this.#publish(sub, p));
		return this.#subDTO(p, this.sub(id)!);
	}
	async withdraw(p: Principal, id: string): Promise<SubmissionDTO> {
		const sub = this.sub(id);
		if (!sub || sub.org_id !== p.orgId) throw new HttpError(404, "not_found", "提交不存在");
		if (sub.submitter_id !== p.userId && !(await this.isManager(p))) throw new HttpError(403, "forbidden", "只有提交人可以撤回");
		this.#db.tx(() => {
			this.#move(sub, "withdrawn", p, "withdraw");
			if (sub.kind !== "skill") (this.#ctx.services.get("mcpMarket") as { onDecision(sub: SubRow, to: SubmissionState): void }).onDecision(sub, "withdrawn");
		});
		return this.#subDTO(p, this.sub(id)!);
	}

	#recordApproval(sub: SubRow, forced: boolean): void {
		if (sub.kind !== "skill" || !sub.version_id) return;
		this.#db.run("INSERT INTO skill_version_publish (version_id, skill_id, version_no, approved_at, submission_id, forced) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(version_id) DO NOTHING", sub.version_id, sub.subject_id, sub.version_no, nowIso(), sub.id, forced ? 1 : 0);
	}
	/** approved → published: the skill takes the target scope, becomes listed, and followers move to the new version. */
	#publish(sub: SubRow, actor: { userId: string }, comment?: string): void {
		if (sub.kind === "mcp_catalog" || sub.kind === "mcp_connector") {
			(this.#ctx.services.get("mcpMarket") as { onPublished(sub: SubRow, actor: { userId: string }): void }).onPublished(sub, actor);
			this.#move(sub, "published", actor, "publish", comment);
			return;
		}
		const s = this.skills.skill(sub.subject_id)!;
		const slug = this.slugOf(s);
		if (sub.target_scope !== "personal") {
			const clash = this.#db.get("SELECT id FROM skill_skills WHERE org_id = ? AND slug = ? AND id != ? AND status = 'active' AND listed = 1 AND scope != 'personal'", s.org_id, slug, s.id);
			if (clash) throw new HttpError(409, "slug_taken", `市场中已有另一个名为「${slug}」的技能`);
		}
		const personal = sub.target_scope === "personal";
		this.#db.run(
			"UPDATE skill_skills SET scope = ?, scope_ref = ?, published_version_no = MAX(COALESCE(published_version_no, 0), ?), listed = CASE WHEN ? THEN listed ELSE 1 END, unpublished_reason = NULL, updated_at = ? WHERE id = ?",
			sub.target_scope, personal || sub.target_scope === "org" ? null : sub.target_ref, sub.version_no, personal ? 1 : 0, nowIso(), s.id,
		);
		this.#move(sub, "published", actor, "publish", comment);
	}

	/** Admin override: publish a version immediately (no reviewer), with a mandatory reason, flagged as forced in the audit trail. */
	async forcePublish(p: Principal, skillId: string, versionNo: number, reason: string, target: { scope?: MarketScope; ref?: string } = {}): Promise<SubmissionDTO> {
		await this.require(p, "skill.marketplace.manage", undefined, "只有技能市场管理员可以强制发布");
		if (!reason?.trim()) throw new HttpError(400, "reason_required", "强制发布必须填写理由");
		const s = this.skills.skill(skillId);
		if (!s || s.org_id !== p.orgId) throw new HttpError(404, "not_found", "技能不存在");
		const v = this.skills.version(skillId, versionNo);
		if (!v) throw new HttpError(404, "version_not_found", "版本不存在");
		const scope = target.scope ?? (s.scope === "personal" ? "org" : s.scope);
		const id = this.#directPublish(p, s, v, scope, scope === "org" ? null : (target.ref ?? s.scope_ref ?? null), `强制发布：${reason.trim()}`);
		this.audit(p, "skill.force_publish", skillId, { versionNo, reason, scope });
		return this.#subDTO(p, this.sub(id)!);
	}
	#directPublish(p: { userId: string; orgId: string }, s: SkillRow, v: VersionRow, scope: MarketScope, ref: string | null, note: string): string {
		const id = newId("sub");
		const now = nowIso();
		this.#db.tx(() => {
			this.#db.run(
				"INSERT INTO market_submissions (id, org_id, kind, subject_id, subject_name, version_id, version_no, target_scope, target_ref, submitter_id, state, note, forced, decided_by, decided_at, decision_comment, created_at, updated_at) VALUES (?, ?, 'skill', ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, 1, ?, ?, ?, ?, ?)",
				id, p.orgId, s.id, s.name, v.id, v.version_no, scope, ref, p.userId, note, p.userId, now, note, now, now,
			);
			const sub = this.sub(id)!;
			this.#event(id, p.orgId, p.userId, "force_publish", undefined, "pending_review", note);
			this.#move(sub, "approved", p, "approve", note, { decided: true, forced: true });
			this.#recordApproval(sub, true);
			this.#publish(sub, p, note);
		});
		return id;
	}
	/** Legacy admin-created org skills / versions: direct publish, recorded exactly like a forced publish. */
	adminDirectPublish(p: Principal, skillId: string, versionNo: number): void {
		const s = this.skills.skill(skillId)!;
		const v = this.skills.version(skillId, versionNo)!;
		this.#directPublish(p, s, v, "org", null, "管理员直接发布");
		this.audit(p, "skill.force_publish", skillId, { versionNo, reason: "admin_direct" });
	}

	async unpublish(p: Principal, skillId: string, reason: string): Promise<MarketSkillSummaryDTO> {
		await this.require(p, "skill.marketplace.manage", undefined, "只有技能市场管理员可以下架技能");
		if (!reason?.trim()) throw new HttpError(400, "reason_required", "下架必须填写理由");
		const s = this.skills.skill(skillId);
		if (!s || s.org_id !== p.orgId) throw new HttpError(404, "not_found", "技能不存在");
		if (!s.listed) throw new HttpError(409, "not_listed", "技能当前未上架");
		this.#db.tx(() => {
			this.#db.run("UPDATE skill_skills SET listed = 0, unpublished_reason = ?, updated_at = ? WHERE id = ?", reason.trim().slice(0, 500), nowIso(), skillId);
			for (const sub of this.#db.all<SubRow>("SELECT * FROM market_submissions WHERE kind = 'skill' AND subject_id = ? AND state = 'published'", skillId)) this.#move(sub, "unpublished", p, "unpublish", reason.trim());
		});
		this.audit(p, "skill.unpublish", skillId, { reason });
		return (await this.#summary(p, this.skills.skill(skillId)!))!;
	}
	async republish(p: Principal, skillId: string): Promise<MarketSkillSummaryDTO> {
		await this.require(p, "skill.marketplace.manage", undefined, "只有技能市场管理员可以重新上架");
		const s = this.skills.skill(skillId);
		if (!s || s.org_id !== p.orgId) throw new HttpError(404, "not_found", "技能不存在");
		if (s.listed || s.scope === "personal" || !s.published_version_no) throw new HttpError(409, "not_unlisted", "技能不是已下架状态");
		this.#db.tx(() => {
			this.#db.run("UPDATE skill_skills SET listed = 1, unpublished_reason = NULL, updated_at = ? WHERE id = ?", nowIso(), skillId);
			for (const sub of this.#db.all<SubRow>("SELECT * FROM market_submissions WHERE kind = 'skill' AND subject_id = ? AND state = 'unpublished'", skillId)) this.#move(sub, "published", p, "republish");
		});
		this.audit(p, "skill.republish", skillId, {});
		return (await this.#summary(p, this.skills.skill(skillId)!))!;
	}

	/** Called by Skills when a version is added through the legacy JSON API: admins publish directly, personal+review auto-submits. */
	async afterLegacyVersion(p: Principal, s: SkillRow, versionNo: number): Promise<void> {
		if (s.scope !== "personal" && (await this.isManager(p))) this.adminDirectPublish(p, s.id, versionNo);
		else if (s.scope === "personal" && this.policy(s.org_id).personalSkill === "review") await this.submit(p, s.id, versionNo, { targetScope: "personal", note: "个人技能（组织策略要求审核）" });
	}

	// ------------------------------------------------------------ DTOs: listing & detail
	#installCount(skillId: string): number {
		const a = this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM skill_installs WHERE skill_id = ? AND enabled = 1", skillId)!.n;
		const b = this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM skill_scope_installs WHERE skill_id = ? AND enabled = 1", skillId)!.n;
		return a + b;
	}
	#rating(skillId: string): { avg?: number; count: number } {
		const r = this.#db.get<{ n: number; avg: number | null }>("SELECT COUNT(*) AS n, AVG(stars) AS avg FROM skill_ratings WHERE skill_id = ?", skillId)!;
		return { avg: r.avg === null ? undefined : Math.round(r.avg * 10) / 10, count: r.n };
	}
	#installedFor(p: Principal, skillId: string): MarketSkillSummaryDTO["installedFor"] {
		const out: { target: "me" | "project" | "department" | "org"; scopeRef?: string; versionNo: number | null }[] = [];
		const own = this.skills.install(skillId, p.userId);
		if (own?.enabled) out.push({ target: "me", versionNo: own.pinned_version_no });
		for (const r of this.#db.all<{ scope_kind: "project" | "department" | "org"; scope_ref: string; pinned_version_no: number | null }>("SELECT scope_kind, scope_ref, pinned_version_no FROM skill_scope_installs WHERE skill_id = ? AND enabled = 1", skillId)) out.push({ target: r.scope_kind, scopeRef: r.scope_ref || undefined, versionNo: r.pinned_version_no });
		return out;
	}
	async #summary(p: Principal, s: SkillRow): Promise<MarketSkillSummaryDTO> {
		const pubNo = s.published_version_no ?? undefined;
		const pub = pubNo ? this.skills.version(s.id, pubNo) : undefined;
		const shown = pub ?? (s.scope === "personal" ? this.skills.version(s.id, s.latest_version_no) : undefined);
		const perms: any[] = shown ? JSON.parse(shown.required_permissions) : [];
		const rating = this.#rating(s.id);
		return {
			id: s.id,
			slug: this.slugOf(s),
			name: s.name,
			description: shown?.description ?? "",
			scope: s.scope as MarketScope,
			scopeRef: s.scope_ref ?? undefined,
			category: s.category ?? undefined,
			tags: JSON.parse(s.tags || "[]"),
			kind: s.kind,
			ownerUserId: s.owner_user_id,
			ownerName: await this.#userName(s.org_id, s.owner_user_id),
			version: pub?.semver ?? undefined,
			versionNo: pubNo,
			requiredPermissions: perms,
			installCount: this.#installCount(s.id),
			ratingAvg: rating.avg,
			ratingCount: rating.count,
			listed: s.listed === 1,
			updatedAt: s.updated_at,
			installedFor: this.#installedFor(p, s.id),
		};
	}

	/**
	 * Department scope of a user: own departments plus all their ancestors. A department-scoped skill / install applies to members of that
	 * department AND its sub-departments (same subtree rule as authz grants: a grant on a department covers its descendants).
	 */
	deptScope(p: Principal): Set<string> {
		return new Set(this.#ctx.services.get("identity").departmentScopeIds(p.orgId, p.departmentIds));
	}

	async #visibleListed(p: Principal): Promise<SkillRow[]> {
		const rows = this.#db.all<SkillRow>("SELECT * FROM skill_skills WHERE org_id = ? AND status = 'active' AND listed = 1 AND scope != 'personal' ORDER BY updated_at DESC", p.orgId);
		const spaces = await this.#ctx.services.get("acl").readableSpaces(p);
		const projects = new Set(spaces.map((x) => x.projectId).filter(Boolean));
		const depts = this.deptScope(p);
		return rows.filter((s) => s.scope === "org" || (s.scope === "department" && !!s.scope_ref && depts.has(s.scope_ref)) || (s.scope === "project" && !!s.scope_ref && projects.has(s.scope_ref)) || s.owner_user_id === p.userId);
	}

	async list(p: Principal, q: { q?: string; category?: string; scope?: string; sort?: string; installed?: string }): Promise<MarketSkillSummaryDTO[]> {
		let rows = await this.#visibleListed(p);
		if (q.scope && q.scope !== "all") rows = rows.filter((s) => s.scope === q.scope);
		if (q.category) rows = rows.filter((s) => s.category === q.category);
		const items = await Promise.all(rows.map((s) => this.#summary(p, s)));
		let out = items;
		const needle = q.q?.trim().toLowerCase();
		if (needle) {
			const words = needle.split(/\s+/).filter(Boolean);
			out = out.filter((x) => words.every((w) => `${x.name} ${x.slug} ${x.description} ${x.tags.join(" ")} ${x.category ?? ""} ${x.ownerName ?? ""}`.toLowerCase().includes(w)));
		}
		if (q.installed === "1") out = out.filter((x) => x.installedFor.length > 0);
		if (q.installed === "0") out = out.filter((x) => x.installedFor.length === 0);
		const sort = q.sort ?? "popular";
		out.sort((a, b) => (sort === "recent" ? (a.updatedAt < b.updatedAt ? 1 : -1) : sort === "rating" ? (b.ratingAvg ?? 0) - (a.ratingAvg ?? 0) || b.ratingCount - a.ratingCount : sort === "name" ? a.name.localeCompare(b.name, "zh") : b.installCount - a.installCount || (a.updatedAt < b.updatedAt ? 1 : -1)));
		return out;
	}
	async categories(p: Principal): Promise<{ category: string; count: number }[]> {
		const m = new Map<string, number>();
		for (const s of await this.#visibleListed(p)) if (s.category) m.set(s.category, (m.get(s.category) ?? 0) + 1);
		return [...m.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
	}

	/** May the caller look inside this version (files, diff, package)? Author/manager, listed+approved for those who can see the skill, or a reviewer with an open submission. */
	async canSeeVersion(p: Principal, s: SkillRow, v: VersionRow): Promise<boolean> {
		if (s.org_id !== p.orgId) return false;
		if (s.owner_user_id === p.userId || (await this.isManager(p))) return true;
		if ((await this.skills.decide(p, "read", s.id)).allow && this.versionApproved(v.id) && (s.listed || s.scope === "personal")) return true;
		for (const sub of this.#db.all<SubRow>("SELECT * FROM market_submissions WHERE kind = 'skill' AND subject_id = ? AND version_id = ?", s.id, v.id)) if (await this.reviewScopeAllows(p, sub)) return true;
		return false;
	}

	#versionDTO(s: SkillRow, v: VersionRow): MarketVersionDTO {
		const sub = this.#db.get<SubRow>("SELECT * FROM market_submissions WHERE kind = 'skill' AND version_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", v.id);
		return { versionNo: v.version_no, semver: v.semver ?? undefined, packageSha256: v.package_sha256 ?? undefined, packageSize: v.package_size ?? undefined, changeNote: v.change_note ?? undefined, createdAt: v.created_at, createdBy: v.created_by, approved: this.versionApproved(v.id), submissionState: sub?.state, checks: v.checks ? JSON.parse(v.checks) : undefined };
	}
	fileList(v: VersionRow): PackageFileDTO[] {
		return (JSON.parse(v.resources) as Resource[]).map((r) => ({ path: r.path, size: r.size, sha256: r.sha256 }));
	}

	async detail(p: Principal, skillId: string, versionNo?: number): Promise<MarketSkillDetailDTO> {
		const s = this.skills.skill(skillId);
		if (!s || s.org_id !== p.orgId) throw new HttpError(404, "not_found", "技能不存在");
		const d = await this.skills.decide(p, "read", s.id);
		if (!d.allow && !(await this.#hasReviewOpen(p, s))) throw new HttpError(403, "forbidden", "无权查看该技能");
		const manage = (await this.skills.decide(p, "write", s.id)).allow;
		const summary = await this.#summary(p, s);
		const shownNo = versionNo ?? s.published_version_no ?? s.latest_version_no;
		const sv = this.skills.version(s.id, shownNo) ?? this.skills.version(s.id, s.latest_version_no)!;
		if (!(await this.canSeeVersion(p, s, sv))) throw new HttpError(403, "forbidden", "该版本尚未发布，只有作者与审核员可以查看");
		const all = this.skills.versions(s.id);
		const visible = manage ? all : all.filter((v) => this.versionApproved(v.id));
		const ratings = this.#db.all<{ user_id: string; stars: number; comment: string | null; at: string }>("SELECT * FROM skill_ratings WHERE skill_id = ? ORDER BY at DESC LIMIT 30", s.id);
		const mine = ratings.find((r) => r.user_id === p.userId) ?? this.#db.get<any>("SELECT * FROM skill_ratings WHERE skill_id = ? AND user_id = ?", s.id, p.userId);
		const canOrg = (await this.isManager(p)) && s.scope === "org" && !!s.listed;
		return {
			...summary,
			manifest: sv.manifest ? JSON.parse(sv.manifest) : undefined,
			readme: sv.instructions,
			files: this.fileList(sv),
			versions: visible.map((v) => this.#versionDTO(s, v)),
			myRating: mine ? { stars: mine.stars, comment: mine.comment ?? undefined } : undefined,
			ratings: await Promise.all(ratings.map(async (r) => ({ stars: r.stars, comment: r.comment ?? undefined, userName: await this.#userName(s.org_id, r.user_id), at: r.at }))),
			canManage: manage,
			canInstallOrg: canOrg,
			canSubmit: manage,
			unpublishedReason: s.unpublished_reason ?? undefined,
			latestVersionNo: manage ? s.latest_version_no : (s.published_version_no ?? 0),
		};
	}
	async #hasReviewOpen(p: Principal, s: SkillRow): Promise<boolean> {
		for (const sub of this.#db.all<SubRow>("SELECT * FROM market_submissions WHERE kind = 'skill' AND subject_id = ?", s.id)) if (await this.reviewScopeAllows(p, sub)) return true;
		return false;
	}

	async readFile(p: Principal, skillId: string, versionNo: number, path: string): Promise<{ path: string; size: number; text: string | null; binary: boolean; truncated: boolean }> {
		const s = this.skills.skill(skillId);
		const v = s ? this.skills.version(skillId, versionNo) : undefined;
		if (!s || !v) throw new HttpError(404, "not_found", "版本不存在");
		if (!(await this.canSeeVersion(p, s, v))) throw new HttpError(403, "forbidden", "无权查看该版本");
		const r = (JSON.parse(v.resources) as Resource[]).find((x) => x.path === path);
		if (!r) throw new HttpError(404, "file_not_found", "文件不在包内");
		const bytes = this.#ctx.blobs.get(r.sha256);
		if (!bytes) throw new HttpError(500, "blob_missing", "文件内容缺失");
		let text: string | null = null;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, 200_000));
		} catch {
			text = null;
		}
		return { path, size: r.size, text, binary: text === null, truncated: bytes.byteLength > 200_000 };
	}
	async packageBytes(p: Principal, skillId: string, versionNo: number): Promise<{ bytes: Uint8Array; name: string }> {
		const s = this.skills.skill(skillId);
		const v = s ? this.skills.version(skillId, versionNo) : undefined;
		if (!s || !v) throw new HttpError(404, "not_found", "版本不存在");
		if (!(await this.canSeeVersion(p, s, v))) throw new HttpError(403, "forbidden", "无权下载该版本");
		if (!v.package_sha256) throw new HttpError(404, "no_package", "旧格式版本没有技能包");
		const bytes = this.#ctx.blobs.get(v.package_sha256);
		if (!bytes) throw new HttpError(500, "blob_missing", "包内容缺失");
		return { bytes, name: `${this.slugOf(s)}-${v.semver ?? `v${v.version_no}`}.zip` };
	}

	async rate(p: Principal, skillId: string, stars: number, comment?: string): Promise<{ avg?: number; count: number }> {
		const s = this.skills.skill(skillId);
		if (!s || s.org_id !== p.orgId) throw new HttpError(404, "not_found", "技能不存在");
		if (!(await this.skills.decide(p, "use", s.id)).allow) throw new HttpError(403, "forbidden", "无权评价该技能");
		if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new HttpError(400, "invalid", "评分必须是 1 到 5 的整数");
		this.#db.run("INSERT INTO skill_ratings (skill_id, user_id, stars, comment, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(skill_id, user_id) DO UPDATE SET stars = excluded.stars, comment = excluded.comment, at = excluded.at", skillId, p.userId, stars, comment?.slice(0, 500) ?? null, nowIso());
		return this.#rating(skillId);
	}

	// ------------------------------------------------------------ submissions: listing and review detail
	async #subDTO(p: Principal, r: SubRow): Promise<SubmissionDTO> {
		const checks: PackageCheckDTO | undefined = r.checks ? JSON.parse(r.checks) : undefined;
		const v = r.version_id ? this.#db.get<VersionRow>("SELECT * FROM skill_versions WHERE id = ?", r.version_id) : undefined;
		return {
			id: r.id,
			kind: r.kind,
			subjectId: r.subject_id,
			subjectName: r.subject_name,
			versionNo: r.version_no ?? undefined,
			semver: v?.semver ?? undefined,
			targetScope: r.target_scope,
			targetRef: r.target_ref ?? undefined,
			submitterId: r.submitter_id,
			submitterName: await this.#userName(r.org_id, r.submitter_id),
			state: r.state,
			note: r.note ?? undefined,
			forced: r.forced === 1,
			decidedBy: r.decided_by ?? undefined,
			decisionComment: r.decision_comment ?? undefined,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
			warnCount: checks?.findings.filter((f) => f.severity === "warn").length ?? 0,
			errorCount: checks?.findings.filter((f) => f.severity === "error").length ?? 0,
			canDecide: await this.canDecide(p, r),
		};
	}

	/** view: mine = submitted by the caller; queue = pending in scopes the caller reviews; history = decided ones in those scopes. */
	async listSubmissions(p: Principal, q: { view?: string; kind?: string; state?: string }): Promise<SubmissionDTO[]> {
		const kinds = q.kind === "mcp" ? ["mcp_catalog", "mcp_connector"] : q.kind === "skill" ? ["skill"] : ["skill", "mcp_catalog", "mcp_connector"];
		const rows = this.#db.all<SubRow>(`SELECT * FROM market_submissions WHERE org_id = ? AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 300`, p.orgId, ...kinds);
		const out: SubRow[] = [];
		for (const r of rows) {
			if (q.state && r.state !== q.state) continue;
			if (q.view === "mine") {
				if (r.submitter_id === p.userId) out.push(r);
			} else if (await this.reviewScopeAllows(p, r)) {
				const pending = r.state === "pending_review";
				if (q.view === "history" ? !pending : pending) out.push(r);
			}
		}
		return Promise.all(out.map((r) => this.#subDTO(p, r)));
	}

	async submissionDetail(p: Principal, id: string): Promise<SubmissionDetailDTO> {
		const r = this.sub(id);
		if (!r || r.org_id !== p.orgId) throw new HttpError(404, "not_found", "提交不存在");
		if (r.submitter_id !== p.userId && !(await this.reviewScopeAllows(p, r))) throw new HttpError(403, "forbidden", "无权查看该提交");
		const base = await this.#subDTO(p, r);
		const events: SubmissionEventDTO[] = await Promise.all(
			this.#db.all<any>("SELECT * FROM market_events WHERE submission_id = ? ORDER BY at, rowid", id).map(async (e) => ({ at: e.at, actorId: e.actor_id, actorName: await this.#userName(r.org_id, e.actor_id), action: e.action, fromState: e.from_state ?? undefined, toState: e.to_state ?? undefined, comment: e.comment ?? undefined })),
		);
		if (r.kind !== "skill") {
			const info = (this.#ctx.services.get("mcpMarket") as { submissionInfo(sub: SubRow): any }).submissionInfo(r);
			return { ...base, ...info, events };
		}
		const s = this.skills.skill(r.subject_id)!;
		const v = this.#db.get<VersionRow>("SELECT * FROM skill_versions WHERE id = ?", r.version_id!)!;
		// Compare against the previous approved version when there is one, otherwise the previous upload.
		const prev = this.#db.get<VersionRow>(
			"SELECT v.* FROM skill_versions v WHERE v.skill_id = ? AND v.version_no < ? ORDER BY (EXISTS (SELECT 1 FROM skill_version_publish x WHERE x.version_id = v.id)) DESC, v.version_no DESC LIMIT 1",
			s.id, v.version_no,
		);
		const next = this.versionFiles(s, v);
		const diff = diffPackages(prev ? this.versionFiles(s, prev) : null, next);
		const perms: string[] = JSON.parse(v.required_permissions);
		const pperms: string[] = prev ? JSON.parse(prev.required_permissions) : [];
		return {
			...base,
			manifest: v.manifest ? JSON.parse(v.manifest) : undefined,
			checks: r.checks ? JSON.parse(r.checks) : undefined,
			files: this.fileList(v),
			permissionDelta: { added: perms.filter((x) => !pperms.includes(x)), removed: pperms.filter((x) => !perms.includes(x)) },
			previousVersionNo: prev?.version_no,
			diff,
			events,
		};
	}

	// ------------------------------------------------------------ installs
	/** Install a skill for me / a project / a department / the whole org. Only approved & listed skills can be distributed beyond their author. */
	async install(p: Principal, skillId: string, input: { target: "me" | "project" | "department" | "org"; scopeRef?: string; pinVersionNo?: number | null }): Promise<MarketSkillSummaryDTO> {
		const s = this.skills.skill(skillId);
		if (!s || s.org_id !== p.orgId) throw new HttpError(404, "not_found", "技能不存在");
		if (!(await this.skills.decide(p, "use", s.id)).allow) throw new HttpError(403, "forbidden", "无权使用该技能");
		const t = input.target;
		if (t === "me") {
			await this.skills.installFor(p, skillId, input.pinVersionNo ?? null);
			this.audit(p, "skill.install", skillId, { target: "me" });
			return this.#summary(p, this.skills.skill(skillId)!);
		}
		if (s.scope === "personal" || !s.listed || !s.published_version_no) throw new HttpError(409, "not_published", "技能尚未通过审核并发布，不能安装到项目、部门或组织");
		if (input.pinVersionNo != null) {
			const pv = this.skills.version(skillId, input.pinVersionNo);
			if (!pv || !this.versionApproved(pv.id)) throw new HttpError(409, "version_not_approved", "只能固定到已审核通过的版本");
		}
		let ref = "";
		if (t === "org") {
			await this.require(p, "skill.marketplace.manage", undefined, "只有技能市场管理员可以安装到整个组织");
			if (s.scope !== "org") throw new HttpError(409, "scope_mismatch", `这是${s.scope === "department" ? "部门" : "项目"}范围的技能，不能安装到整个组织`);
		} else if (t === "department") {
			ref = input.scopeRef ?? "";
			if (!ref) throw new HttpError(400, "invalid", "需要 scopeRef（部门 id）");
			await this.require(p, "skill.publish", { kind: "department", id: ref }, "没有向该部门安装技能的权限");
			if (s.scope === "department" && s.scope_ref !== ref) throw new HttpError(409, "scope_mismatch", "该技能属于另一个部门");
			if (s.scope === "project") throw new HttpError(409, "scope_mismatch", "项目范围的技能不能安装到部门");
		} else if (t === "project") {
			ref = input.scopeRef ?? "";
			const space = ref ? this.#ctx.services.get("identity").projectSpace(ref) : null;
			if (!space || space.orgId !== p.orgId) throw new HttpError(404, "project_not_found", "项目不存在");
			await this.#ctx.services.get("acl").require(p, "write", { kind: "space", id: space.id });
			if (s.scope === "project" && s.scope_ref !== ref) throw new HttpError(409, "scope_mismatch", "该技能属于另一个项目");
			if (s.scope === "department") throw new HttpError(409, "scope_mismatch", "部门范围的技能不能安装到项目");
		} else throw new HttpError(400, "invalid", "target 必须是 me、project、department 或 org");
		this.#db.run(
			"INSERT INTO skill_scope_installs (skill_id, scope_kind, scope_ref, installed_by, pinned_version_no, enabled, installed_at) VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT(skill_id, scope_kind, scope_ref) DO UPDATE SET pinned_version_no = excluded.pinned_version_no, enabled = 1, installed_by = excluded.installed_by",
			skillId, t, ref, p.userId, input.pinVersionNo ?? null, nowIso(),
		);
		this.audit(p, "skill.install", skillId, { target: t, ref });
		return this.#summary(p, this.skills.skill(skillId)!);
	}
	async uninstall(p: Principal, skillId: string, target: "me" | "project" | "department" | "org", scopeRef?: string): Promise<void> {
		const s = this.skills.skill(skillId);
		if (!s || s.org_id !== p.orgId) throw new HttpError(404, "not_found", "技能不存在");
		if (target === "me") return this.skills.uninstall(p, skillId);
		if (target === "org") await this.require(p, "skill.marketplace.manage");
		else if (target === "department") await this.require(p, "skill.publish", { kind: "department", id: scopeRef ?? "" });
		else {
			const space = this.#ctx.services.get("identity").projectSpace(scopeRef ?? "");
			if (!space) throw new HttpError(404, "project_not_found", "项目不存在");
			await this.#ctx.services.get("acl").require(p, "write", { kind: "space", id: space.id });
		}
		this.#db.run("DELETE FROM skill_scope_installs WHERE skill_id = ? AND scope_kind = ? AND scope_ref = ?", skillId, target, target === "org" ? "" : (scopeRef ?? ""));
		this.audit(p, "skill.uninstall", skillId, { target, scopeRef });
	}
	/** Scope installs that apply to this user (org, own departments, the space's project). */
	scopeInstallsFor(p: Principal, space?: Space): { skill_id: string; scope_kind: string; scope_ref: string; pinned_version_no: number | null }[] {
		const rows = this.#db.all<{ skill_id: string; scope_kind: string; scope_ref: string; pinned_version_no: number | null }>("SELECT i.skill_id, i.scope_kind, i.scope_ref, i.pinned_version_no FROM skill_scope_installs i JOIN skill_skills s ON s.id = i.skill_id WHERE i.enabled = 1 AND s.org_id = ?", p.orgId);
		const depts = this.deptScope(p);
		return rows.filter((r) => r.scope_kind === "org" || (r.scope_kind === "department" && depts.has(r.scope_ref)) || (r.scope_kind === "project" && !!space?.projectId && r.scope_ref === space.projectId));
	}

	// ------------------------------------------------------------ materialisation + mounts
	mountsRoot(): string {
		const sb = this.#sandbox();
		if (sb) return sb.mountsRoot();
		const d = join(this.#ctx.config.dataDir, "sandbox-mounts");
		mkdirSync(d, { recursive: true });
		return d;
	}
	/**
	 * Write the version's files below `<mountsRoot>/skills/<slug>-<digest>/` once (content-addressed: same bytes → same directory) and
	 * make them read-only. The sandbox mounts that directory read-only at /skills/<slug>; a skill can never modify its own files.
	 */
	materialize(s: SkillRow, v: VersionRow, slugOverride?: string): { dir: string; slug: string } {
		const slug = slugOverride ?? this.slugOf(s);
		// Defence in depth: the slug and every stored path end up in host file names. Whatever the database holds, nothing may escape
		// <mountsRoot>/skills (no separators, no "..", no NUL, no absolute or backslash paths).
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(slug) || slug.includes("..")) throw new HttpError(500, "bad_skill_slug", `技能 slug 不合法：${slug}`);
		const files = this.versionFiles(s, v);
		for (const f of files) {
			if (!f.path || f.path.length > 200 || f.path.includes("\0") || f.path.includes("\\") || f.path.startsWith("/") || f.path.split("/").some((x) => x === "" || x === "." || x === "..")) throw new HttpError(500, "bad_skill_path", `技能资源路径不合法：${JSON.stringify(f.path)}`);
		}
		const digest = (v.package_sha256 ?? sha256Hex(new TextEncoder().encode(JSON.stringify(files.map((f) => [f.path, sha256Hex(f.bytes)]))))).slice(0, 16);
		if (!/^[0-9a-f]{16}$/.test(digest)) throw new HttpError(500, "bad_skill_digest", "技能包摘要不合法");
		const base = join(this.mountsRoot(), "skills");
		const dir = join(base, `${slug}-${digest}`);
		if (existsSync(dir)) return { dir, slug };
		writeContentAddressed(dir, files);
		return { dir, slug };
	}

	/**
	 * Mounts of the skills this conversation has loaded, re-validated against skills.active() (so a skill that is no longer usable by this
	 * principal is never mounted), pinned to the version that is active now. At most `mountCap`, most recently loaded first; the
	 * overflow is returned in `skipped` for the caller to report.
	 */
	async loadedMountPlan(p: Principal, space: Space, conversationId: number | undefined): Promise<{ mounts: { skill: SkillRow; version: VersionRow; mount: SandboxMount }[]; skipped: SkillRow[]; failed: SkillRow[] }> {
		const none = { mounts: [], skipped: [], failed: [] };
		if (conversationId == null) return none;
		const rows = this.skills.loadedRows(space.id, conversationId);
		if (!rows.length) return none;
		const active = new Map((await this.skills.active(p, space)).map((a) => [a.skill.id, a]));
		const cands: { skill: SkillRow; version: VersionRow }[] = [];
		for (const r of rows) {
			const a = active.get(r.skill_id);
			if (!a) continue;
			const files: Resource[] = JSON.parse(a.version.resources);
			if (!a.version.entry && !files.some((f) => f.path !== "SKILL.md")) continue;
			cands.push(a);
		}
		const out: { skill: SkillRow; version: VersionRow; mount: SandboxMount }[] = [];
		const failed: SkillRow[] = [];
		for (const { skill, version } of cands.slice(0, this.mountCap)) {
			try {
				const { dir, slug } = this.materialize(skill, version);
				out.push({ skill, version, mount: { hostPath: dir, target: `/skills/${slug}`, readOnly: true } });
			} catch (e) {
				console.error("[market] materialize failed", skill.id, e);
				failed.push(skill);
			}
		}
		return { mounts: out, skipped: cands.slice(this.mountCap).map((x) => x.skill).reverse(), failed };
	}

	/** Mounts for every skill the caller has active (only those that ship more than a SKILL.md or have an entry). Not used by the sandbox any more (on-demand mounts); kept for inspection. */
	async mountPlan(p: Principal, space?: Space): Promise<{ skill: SkillRow; version: VersionRow; mount: SandboxMount }[]> {
		const out: { skill: SkillRow; version: VersionRow; mount: SandboxMount }[] = [];
		for (const { skill, version } of await this.skills.active(p, space)) {
			const files: Resource[] = JSON.parse(version.resources);
			if (!version.entry && !files.some((f) => f.path !== "SKILL.md")) continue;
			try {
				const { dir, slug } = this.materialize(skill, version);
				out.push({ skill, version, mount: { hostPath: dir, target: `/skills/${slug}`, readOnly: true } });
			} catch (e) {
				console.error("[market] materialize failed", skill.id, e);
			}
			if (out.length >= this.mountCap) break;
		}
		return out;
	}
}

export type { InstallRow };
