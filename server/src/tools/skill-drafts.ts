// Skills created in conversation (round 6, B2). The agent writes SKILL.md (+ resources/scripts) into a directory of its own
// conversation workspace and calls the controlled tool `skill_manage` { action: "submit_draft", dir }. The backend then:
//   1. resolves the acting principal / space / conversation server-side (never from model arguments),
//   2. reads `dir` strictly inside Sandbox.workdir(space, conversationId): no symlinks anywhere, no special files, size/count limits,
//      open with O_NOFOLLOW + dev/ino re-check against the lstat (TOCTOU),
//   3. builds the canonical package (skills-package.ts buildPackage: manifest validation, secret/network scan) and FIXES the snapshot:
//      canonical zip + per-file blobs + packageSha256 go into a draft row; later workspace edits cannot change what is approved,
//   4. opens a durable approval (effects.requestApproval, keyed by callId) whose detail is SkillDraftApprovalDetail,
//   5. on approval saves it from the snapshot blobs through Market.upload: a new PERSONAL skill (org policy free/review/disabled applies,
//      installs for the user), or, when a skill with that name already exists and the user may write it (own personal skill, or a market/org
//      skill they are author/admin of), a NEW VERSION of it. A market skill's new version is submitted for review (same rule as the market UI);
//      nothing runs and nothing is auto-approved.
//   The target is resolved at snapshot time, BEFORE the approval: a name clash with a skill the user may not write, a version that is not
//   greater than the existing ones, or content identical to an existing version fail the draft right there (no approval card), with an
//   actionable message for the agent. `skill_manage checkout` writes the current files of an accessible skill into /work/<dir> (host
//   workspace write path, no sandbox_exec) so the agent can edit them and submit the result as the new version.
//
// Idempotency (pi-durable replay): the draft is keyed by (space, conversation, callId). A rerun finds the row and reuses the snapshot (the
// workspace is not read again), requestApproval reattaches by callId, and an already saved draft returns the saved skill. A crash between
// Market.upload and the row update is healed by adopting the user's existing version with the same packageSha256 (also on 409 duplicate_content).
// => the whole execute is idempotent, hence replay: "safe" (checkout rewrites the same files; it refuses to overwrite edited content).
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { Hono } from "hono";
import type { AppContext, AppEnv, EffectsApi, Principal, ToolActor } from "../core/contracts.ts";
import type { Migration } from "../core/db.ts";
import { HttpError, newId, nowIso, principalOf } from "../core/http.ts";
import type { SkillDraftApprovalDetail, SkillDraftDTO, SkillDraftFileDTO, SkillDraftFindingDTO, SkillDraftState, SkillDraftTarget } from "../../../shared/skill-drafts.ts";
import { runtimeActorResolver, type ActorResolver } from "../files/actor.ts";
import type { ToolCallLog } from "./calls.ts";
import type { Market } from "./market.ts";
import type { Sandbox } from "./sandbox.ts";
import { cleanPath, isInside } from "./sandbox/workspace.ts";
import { requirePermission } from "./sandbox/perm.ts";
import { workspaceKeyOf, workspacePersistenceFor } from "./sandbox/persist.ts";
import { buildPackage, compareSemver, LIMITS, PackageError, sha256Hex } from "./skills-package.ts";
import type { Skills, SkillRow } from "./skills.ts";

// ------------------------------------------------------------------ storage
/** Register in the tools module with `version + 800` (see docs/requests/round6-b2.md). */
export const SKILL_DRAFT_MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "skill_ws_drafts",
		sql: `
CREATE TABLE skill_ws_drafts (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, space_id TEXT NOT NULL, conversation_id INTEGER NOT NULL, call_id TEXT NOT NULL,
  source_dir TEXT NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL, package_sha256 TEXT, files TEXT NOT NULL DEFAULT '[]',
  error TEXT, skill_id TEXT, version_no INTEGER, created_at TEXT NOT NULL, decided_at TEXT
);
CREATE UNIQUE INDEX skill_ws_drafts_call ON skill_ws_drafts(space_id, conversation_id, call_id);
CREATE INDEX skill_ws_drafts_user ON skill_ws_drafts(org_id, user_id, created_at);
`,
	},
	{
		// Where a skill was checked out into a conversation workspace: lets a repeated checkout overwrite an UNMODIFIED earlier checkout of the same skill.
		version: 2,
		name: "skill_ws_checkouts",
		sql: `
CREATE TABLE skill_ws_checkouts (
  space_id TEXT NOT NULL, conversation_id INTEGER NOT NULL, dir TEXT NOT NULL, skill_id TEXT NOT NULL, version_no INTEGER NOT NULL,
  files TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (space_id, conversation_id, dir)
);
`,
	},
];

interface DraftRow {
	id: string;
	org_id: string;
	user_id: string;
	space_id: string;
	conversation_id: number;
	call_id: string;
	source_dir: string;
	state: SkillDraftState;
	detail: string;
	package_sha256: string | null;
	/** JSON [{path, sha256, size}]: per-file blobs of the snapshot (the canonical zip is the blob named package_sha256). */
	files: string;
	error: string | null;
	skill_id: string | null;
	version_no: number | null;
	created_at: string;
	decided_at: string | null;
}

// ------------------------------------------------------------------ safe workspace snapshot
const bad = (msg: string, code = "bad_dir") => new HttpError(400, code, msg);
const MAX_ENTRIES = LIMITS.files * 4;

/** Validate the model-supplied `dir` (relative to /work) and return the clean relative path. */
export function cleanDir(dir: unknown): string {
	if (typeof dir !== "string" || !dir.trim()) throw bad("dir 必须是 /work 下的子目录，例如 weekly-report");
	if (dir.includes("\0") || dir.includes("\\")) throw bad("dir 含非法字符");
	if (/^[A-Za-z]:/.test(dir)) throw bad("dir 不能是盘符路径");
	if (dir.startsWith("/") && !/^\/work(\/|$)/.test(dir)) throw bad("dir 必须相对于 /work，不允许绝对路径");
	if (dir.split("/").includes("..")) throw bad("dir 不能包含 “..”");
	let rel: string;
	try {
		rel = cleanPath(dir);
	} catch (e) {
		throw bad(String((e as Error).message));
	}
	if (!rel) throw bad("dir 必须是 /work 下的子目录，不能是工作区根目录");
	return rel;
}

export interface Snapshot {
	rel: string;
	files: { path: string; bytes: Uint8Array }[];
}

/**
 * Read every file of `<workdir>/<rel>`. Refuses symlinks (the directory itself, any parent inside the workdir, any entry), special files
 * (fifo/socket/device), more than LIMITS.files files / LIMITS.fileBytes per file / LIMITS.totalBytes in total.
 */
export function snapshotDir(workdir: string, dir: unknown): Snapshot {
	const rel = cleanDir(dir);
	const segs = rel.split("/");
	let rootSt;
	try {
		rootSt = lstatSync(workdir);
	} catch {
		throw bad("工作区不存在", "dir_not_found");
	}
	if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) throw bad("工作区不是普通目录");
	const realRoot = realpathSync.native(workdir);
	// Every component from the workdir down to `dir` must be a plain directory (no symlink anywhere on the way).
	let cur = workdir;
	for (const seg of segs) {
		cur = join(cur, seg);
		let st;
		try {
			st = lstatSync(cur);
		} catch {
			throw bad(`目录不存在：/work/${rel}`, "dir_not_found");
		}
		if (st.isSymbolicLink()) throw bad(`路径经过符号链接，已拒绝：/work/${rel}`, "symlink_refused");
		if (!st.isDirectory()) throw bad(`不是目录：/work/${rel}`);
	}
	const realDir = realpathSync.native(cur);
	if (realDir !== join(realRoot, ...segs) || !isInside(realRoot, realDir)) throw bad("目录不在会话工作区内", "symlink_refused");

	const out: { path: string; bytes: Uint8Array }[] = [];
	let total = 0;
	let entries = 0;
	const stack: string[] = [""];
	while (stack.length) {
		const sub = stack.pop()!;
		const absDir = sub ? join(cur, ...sub.split("/")) : cur;
		for (const name of readdirSync(absDir).sort()) {
			if (++entries > MAX_ENTRIES) throw bad(`目录条目过多（超过 ${MAX_ENTRIES}）`, "too_many_files");
			const relPath = sub ? `${sub}/${name}` : name;
			const abs = join(absDir, name);
			const st = lstatSync(abs);
			if (st.isSymbolicLink()) throw bad(`包含符号链接，已拒绝：${relPath}`, "symlink_refused");
			if (st.isDirectory()) {
				stack.push(relPath);
				continue;
			}
			if (!st.isFile()) throw bad(`包含特殊文件（管道/设备/套接字），已拒绝：${relPath}`, "special_file");
			if (out.length >= LIMITS.files) throw bad(`文件数量超过上限 ${LIMITS.files}`, "too_many_files");
			if (st.size > LIMITS.fileBytes) throw bad(`文件过大：${relPath}（上限 ${Math.round(LIMITS.fileBytes / 1048576)} MB）`, "file_too_large");
			if (total + st.size > LIMITS.totalBytes) throw bad(`总大小超过上限 ${Math.round(LIMITS.totalBytes / 1048576)} MB`, "package_too_large");
			const bytes = readPlainFile(abs, st, realDir);
			total += bytes.byteLength;
			if (total > LIMITS.totalBytes) throw bad(`总大小超过上限 ${Math.round(LIMITS.totalBytes / 1048576)} MB`, "package_too_large");
			out.push({ path: relPath, bytes });
		}
	}
	return { rel, files: out };
}

/** Open without following a final symlink or blocking on a fifo, then prove the descriptor is the file we lstat'ed (dev+ino) and still inside `realDir`. */
function readPlainFile(abs: string, st: { dev: number | bigint; ino: number | bigint; size: number }, realDir: string): Uint8Array {
	let fd: number;
	try {
		fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	} catch {
		throw bad(`无法安全读取（可能是符号链接或已被替换）：${abs.slice(realDir.length + 1)}`, "symlink_refused");
	}
	try {
		const f = fstatSync(fd);
		if (!f.isFile() || f.dev !== st.dev || f.ino !== st.ino) throw bad(`文件在读取时被替换，已拒绝：${abs.slice(realDir.length + 1)}`, "changed_during_read");
		if (f.size > LIMITS.fileBytes) throw bad(`文件过大：${abs.slice(realDir.length + 1)}`, "file_too_large");
		let real: string;
		try {
			real = realpathSync.native(abs);
		} catch {
			throw bad("文件在读取时被替换", "changed_during_read");
		}
		if (!isInside(realDir, real)) throw bad(`路径指向目录之外，已拒绝：${abs.slice(realDir.length + 1)}`, "symlink_refused");
		const buf = Buffer.allocUnsafe(f.size);
		let got = 0;
		while (got < f.size) {
			const n = readSync(fd, buf, got, f.size - got, got);
			if (n <= 0) break;
			got += n;
		}
		const after = lstatSync(abs);
		if (after.isSymbolicLink() || after.ino !== st.ino || after.dev !== st.dev) throw bad("文件在读取时被替换，已拒绝", "changed_during_read");
		return new Uint8Array(buf.buffer, buf.byteOffset, got);
	} finally {
		closeSync(fd);
	}
}

// ------------------------------------------------------------------ helpers
const isExecutable = (p: string): boolean => /(^|\/)scripts\//.test(p) || /\.(py|sh|mjs|js)$/i.test(p);
const HIGH_CODES = new Set(["network_use", "network_undeclared", "network_declared", "sensitive_path", "obfuscated", "hidden_chars", "secret_in_package"]);
const lastSeg = (rel: string) => rel.split("/").at(-1) ?? rel;

function riskOf(findings: readonly SkillDraftFindingDTO[], files: readonly SkillDraftFileDTO[], perms: readonly string[]): "low" | "medium" | "high" {
	if (findings.some((f) => f.severity === "warn" && HIGH_CODES.has(f.code))) return "high";
	if (files.some((f) => f.executable) || perms.length || findings.some((f) => f.severity === "warn" && (f.code === "exec_call" || f.code === "prompt_injection"))) return "medium";
	return "low";
}

/** 1.2.3 → 1.2.4 (suggestion for the agent; prerelease / build parts are dropped). */
const bumpPatch = (v: string): string => {
	const [maj, min, pat] = v.split(/[-+]/)[0]!.split(".").map(Number);
	return `${maj}.${min}.${(pat ?? 0) + 1}`;
};

const textOf = (s: string) => [{ type: "text" as const, text: s }];

class Lock {
	readonly #tails = new Map<string, Promise<unknown>>();
	async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.#tails.get(key) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		this.#tails.set(key, next);
		try {
			return await next;
		} finally {
			if (this.#tails.get(key) === next) this.#tails.delete(key);
		}
	}
}

// ------------------------------------------------------------------ service
export class SkillDrafts {
	readonly #ctx: AppContext;
	readonly #lock = new Lock();
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}
	get #db() {
		return this.#ctx.db;
	}
	get #market(): Market {
		return this.#ctx.services.get("market") as Market;
	}
	get #sandbox(): Sandbox {
		return this.#ctx.services.get("sandbox") as Sandbox;
	}
	get #skills(): Skills {
		return this.#ctx.services.get("skills") as Skills;
	}

	row(id: string): DraftRow | undefined {
		return this.#db.get<DraftRow>("SELECT * FROM skill_ws_drafts WHERE id = ?", id);
	}
	#byCall(spaceId: string, conversationId: number, callId: string): DraftRow | undefined {
		return this.#db.get<DraftRow>("SELECT * FROM skill_ws_drafts WHERE space_id = ? AND conversation_id = ? AND call_id = ?", spaceId, conversationId, callId);
	}
	dto(r: DraftRow): SkillDraftDTO {
		return {
			id: r.id,
			state: r.state,
			detail: JSON.parse(r.detail) as SkillDraftApprovalDetail,
			spaceId: r.space_id,
			conversationId: r.conversation_id,
			createdAt: r.created_at,
			...(r.decided_at ? { decidedAt: r.decided_at } : {}),
			...(r.skill_id ? { skillId: r.skill_id } : {}),
			...(r.version_no != null ? { versionNo: r.version_no } : {}),
			...(r.error ? { error: r.error } : {}),
		};
	}
	/** Owner-only read (same org). Other users get 404, never a hint that the draft exists. */
	forOwner(p: Principal, id: string): DraftRow {
		const r = this.row(id);
		if (!r || r.org_id !== p.orgId || r.user_id !== p.userId) throw new HttpError(404, "not_found", "技能草稿不存在");
		return r;
	}

	/** Active skills that occupy `slug` for this user: their own personal skill and any market/org skill (the same rule as Market.upload's slug_taken). */
	#occupants(p: Principal, slug: string): SkillRow[] {
		return this.#db.all<SkillRow>("SELECT * FROM skill_skills WHERE org_id = ? AND slug = ? AND status = 'active' AND (owner_user_id = ? OR scope != 'personal') ORDER BY CASE WHEN scope = 'personal' THEN 0 ELSE 1 END, created_at", p.orgId, slug, p.userId);
	}
	/** A name for a personal copy that is free (`<name>-custom`, `-custom-2`, …). */
	#freeCopyName(p: Principal, name: string): string {
		for (let i = 1; i < 50; i++) {
			const suffix = i === 1 ? "-custom" : `-custom-${i}`;
			const cand = `${name.slice(0, 64 - suffix.length).replace(/-+$/, "")}${suffix}`;
			if (!this.#occupants(p, cand).length) return cand;
		}
		return `${name.slice(0, 40).replace(/-+$/, "")}-${newId("c").slice(-6).toLowerCase()}`;
	}

	/**
	 * Decide what approving this package would do, before anything is asked of the user.
	 *  - no skill with this name: a new personal skill;
	 *  - a skill with this name the user may write (own personal; market/org skill where decide(write) allows): a new version of it;
	 *  - a skill the user may not write: refused (a predictable slug_taken after the approval is exactly what this prevents).
	 * For updates the version must be greater than every existing version and the content must differ from all of them.
	 */
	async #resolveTarget(p: Principal, m: { name: string; version: string }, sha: string): Promise<{ target: SkillDraftTarget; skill?: SkillRow } | { error: SkillDraftFindingDTO }> {
		const refuse = (code: string, message: string): { error: SkillDraftFindingDTO } => ({ error: { severity: "error", code, message } });
		const review = this.#market.policy(p.orgId).personalSkill === "review";
		const occupants = this.#occupants(p, m.name);
		if (!occupants.length) {
			const text = `新建个人技能 v${m.version}，仅你可用${review ? "；组织策略要求审核，通过后才能使用" : ""}`;
			return { target: { mode: "new", scope: "personal", toVersion: m.version, reviewRequired: review, text } };
		}
		let skill: SkillRow | undefined;
		for (const s of occupants) {
			if ((await this.#skills.decide(p, "write", s.id)).allow) {
				skill = s;
				break;
			}
		}
		if (!skill) {
			const other = occupants[0]!;
			const copy = this.#freeCopyName(p, m.name);
			return refuse(
				"name_taken_not_writable",
				`名称「${m.name}」属于${other.scope === "personal" ? "你的另一个技能" : "市场中的技能"}，而当前用户没有更新它的权限（只有该技能的作者或市场管理员可以上传新版本）。` +
					`可以这样处理：1）把 SKILL.md 里的 name 改成 ${copy}（或别的名称）后重新调用 submit_draft，保存为用户自己的个人副本，原技能不受影响；2）告诉用户请该技能的作者或市场管理员来更新。不要重复提交同一个 name。`,
			);
		}
		const market = skill.scope !== "personal";
		if (market && !(await this.#market.canSubmitTo(p, skill.scope, skill.scope_ref))) {
			const copy = this.#freeCopyName(p, m.name);
			return refuse(
				"submit_not_allowed",
				`可以编辑市场技能「${skill.name}」，但当前用户没有向它所在范围提交新版本审核的权限（skill.publish），保存后新版本无法生效。` +
					`可以把 SKILL.md 里的 name 改成 ${copy} 后重新提交，保存为个人副本；或请有发布权限的人来更新。`,
			);
		}
		const versions = this.#skills.versions(skill.id);
		const same = versions.find((v) => v.package_sha256 === sha);
		if (same) return refuse("duplicate_content", `内容与技能「${skill.name}」的已有版本 v${same.version_no}${same.semver ? `（${same.semver}）` : ""}完全相同，没有任何改动。请先修改文件（并提高 version）再提交（duplicate_content）。`);
		const semvers = versions.map((v) => v.semver).filter((x): x is string => !!x);
		const top = semvers.sort(compareSemver).at(-1);
		if (semvers.includes(m.version)) return refuse("version_exists", `版本号 ${m.version} 已存在，已有版本不可修改。请在 SKILL.md 里把 version 提高到大于 ${top}（例如 ${bumpPatch(top!)}）后重新提交（version_exists）。`);
		if (top && compareSemver(m.version, top) <= 0) return refuse("version_not_increasing", `版本号 ${m.version} 不大于技能「${skill.name}」现有的最高版本 ${top}。请在 SKILL.md 里把 version 提高到大于 ${top}（例如 ${bumpPatch(top)}）后重新提交（version_not_increasing）。`);
		const reviewRequired = market ? true : review;
		const from = top ? `v${top} → ` : "";
		const text = market
			? `更新市场技能「${skill.name}」：${from}v${m.version}；将提交审核，通过前使用者仍用旧版本`
			: `更新你的个人技能「${skill.name}」：${from}v${m.version}${review ? "；组织策略要求审核，通过后才能使用新版本" : ""}`;
		return {
			skill,
			target: {
				mode: "update", skillId: skill.id, skillName: skill.name, scope: market ? "market" : "personal", ...(market ? { marketScope: skill.scope as "org" | "department" | "project" } : {}),
				...(top ? { fromVersion: top } : {}), toVersion: m.version, reviewRequired, text,
			},
		};
	}

	/** Create (or find) the draft of this tool call. The workspace is read only when no row exists yet. */
	async snapshot(actor: ToolActor, dir: string): Promise<{ row: DraftRow; created: boolean }> {
		const existing = this.#byCall(actor.space.id, actor.conversationId, actor.callId);
		if (existing) return { row: existing, created: false };
		const p = actor.principal;
		const now = nowIso();
		const base = { id: newId("skd"), org_id: p.orgId, user_id: p.userId, space_id: actor.space.id, conversation_id: actor.conversationId, call_id: actor.callId, created_at: now };
		const insert = (r: Omit<DraftRow, "decided_at" | "skill_id" | "version_no" | "created_at" | "id" | "org_id" | "user_id" | "space_id" | "conversation_id" | "call_id">): DraftRow => {
			const res = this.#db.run(
				"INSERT OR IGNORE INTO skill_ws_drafts (id, org_id, user_id, space_id, conversation_id, call_id, source_dir, state, detail, package_sha256, files, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				base.id, base.org_id, base.user_id, base.space_id, base.conversation_id, base.call_id, r.source_dir, r.state, r.detail, r.package_sha256, r.files, r.error, base.created_at,
			);
			const row = this.#byCall(base.space_id, base.conversation_id, base.call_id)!;
			if (res.changes) this.#market.audit(p, "skill.draft.submit", row.id, { draftId: row.id, spaceId: row.space_id, conversationId: row.conversation_id, callId: row.call_id, dir: r.source_dir, state: r.state, sha256: r.package_sha256 });
			return row;
		};
		const failed = (sourceDir: string, findings: SkillDraftFindingDTO[], files: { path: string; bytes: Uint8Array }[] = [], meta?: { name: string; title: string; description: string; version: string; skillKind: string }): { row: DraftRow; created: boolean } => {
			const msg = findings.filter((f) => f.severity === "error").map((f) => f.message).join("；") || "草稿无法生成";
			const name = meta?.name ?? lastSeg(sourceDir);
			const detail: SkillDraftApprovalDetail = {
				kind: "skill_draft", draftId: base.id, name, title: meta?.title ?? name, description: meta?.description ?? "", version: meta?.version ?? "", skillKind: meta?.skillKind ?? "", sourceDir,
				files: files.map((f) => ({ path: f.path, size: f.bytes.byteLength, sha256: sha256Hex(f.bytes), executable: isExecutable(f.path) })),
				totalBytes: files.reduce((n, f) => n + f.bytes.byteLength, 0), packageSha256: "", requiredPermissions: [], requiredTools: [], findings,
			};
			const row = insert({ source_dir: sourceDir, state: "failed", detail: JSON.stringify(detail), package_sha256: null, files: "[]", error: msg });
			if (row.id === base.id) this.#market.audit(p, "skill.draft.failed", row.id, { draftId: row.id, stage: "build", error: msg.slice(0, 500) });
			return { row, created: row.id === base.id };
		};

		let snap: Snapshot;
		try {
			snap = snapshotDir(this.#sandbox.workdir(actor.space, actor.conversationId), dir);
		} catch (e) {
			if (!(e instanceof HttpError)) throw e;
			return failed(String(dir).slice(0, 200), [{ severity: "error", code: e.code, message: e.message }]);
		}
		let built: ReturnType<typeof buildPackage>;
		try {
			built = buildPackage(snap.files, now);
		} catch (e) {
			if (!(e instanceof PackageError)) throw e;
			const findings: SkillDraftFindingDTO[] = (e.findings ?? [{ severity: "error", code: e.code, message: e.message }]).map((f) => ({ severity: f.severity, code: f.code, message: f.message }));
			return failed(snap.rel, findings, snap.files);
		}
		const m = built.parsed.manifest;
		// Resolve what approving would do NOW, before the user is asked: a new personal skill or a new version of an existing skill.
		const resolved = await this.#resolveTarget(p, m, built.packageSha256);
		if ("error" in resolved) return failed(snap.rel, [resolved.error], snap.files, { name: m.name, title: m.title ?? m.name, description: m.description, version: m.version, skillKind: m.kind });
		const { target } = resolved;
		// Fix the snapshot: canonical zip + every file as blobs. From here on the workspace is irrelevant.
		this.#ctx.blobs.put(built.zip);
		const stored = built.files.map((f) => ({ path: f.path, ...this.#ctx.blobs.put(f.bytes) }));
		const files: SkillDraftFileDTO[] = built.files.map((f) => ({ path: f.path, size: f.bytes.byteLength, sha256: sha256Hex(f.bytes), executable: isExecutable(f.path) }));
		const detail: SkillDraftApprovalDetail = {
			kind: "skill_draft", draftId: base.id, name: m.name, title: m.title ?? m.name, description: m.description, version: m.version, skillKind: m.kind, sourceDir: snap.rel,
			files, totalBytes: files.reduce((n, f) => n + f.size, 0), packageSha256: built.packageSha256,
			requiredPermissions: [...m.requiredPermissions], requiredTools: [...m.requiredTools],
			findings: built.check.findings.map((f) => ({ severity: f.severity, code: f.code, message: f.message })),
			target,
			...(target.mode === "update" ? { updatesSkill: { id: target.skillId!, name: target.skillName!, ...(target.fromVersion ? { fromVersion: target.fromVersion } : {}) } } : {}),
		};
		const row = insert({ source_dir: snap.rel, state: "pending", detail: JSON.stringify(detail), package_sha256: built.packageSha256, files: JSON.stringify(stored), error: null });
		return { row, created: row.id === base.id };
	}

	/** Approval request for a pending draft (title/summary say exactly what happens). */
	approvalRequest(r: DraftRow, orgId: string) {
		const d = JSON.parse(r.detail) as SkillDraftApprovalDetail;
		const pol = this.#market.policy(orgId).personalSkill;
		const t = d.target;
		const risk = riskOf(d.findings, d.files, d.requiredPermissions);
		if (t?.mode === "update" && t.scope === "market") {
			const parts = [`为市场技能「${t.skillName}」新增版本 v${d.version}${t.fromVersion ? `（现有最高版本 ${t.fromVersion}）` : ""}`, "不会自动执行", "新版本会提交审核，通过前使用者仍用旧版本"];
			return { title: `更新市场技能：${d.title}`, summary: parts.join("；"), risk, detail: d };
		}
		const parts = [d.updatesSkill ? `在你已有的个人技能「${d.updatesSkill.name}」上新增版本 v${d.version}（仅你可用）` : `保存为仅你可用的个人技能 v${d.version}`, "不会自动执行，也不会发布到商城"];
		if (pol === "review") parts.push("组织策略要求审核：保存后需通过审核才能使用");
		return { title: d.updatesSkill ? `更新个人技能：${d.title}` : `保存为个人技能：${d.title}`, summary: parts.join("；"), risk, detail: d };
	}

	/** Terminal state change, once: returns false when somebody else already decided. */
	#finish(r: DraftRow, state: "saved" | "rejected" | "failed", extra: { error?: string; skillId?: string; versionNo?: number } = {}): boolean {
		const res = this.#db.run("UPDATE skill_ws_drafts SET state = ?, decided_at = ?, error = ?, skill_id = ?, version_no = ? WHERE id = ? AND state = 'pending'", state, nowIso(), extra.error ?? null, extra.skillId ?? null, extra.versionNo ?? null, r.id);
		return res.changes > 0;
	}

	/** The version with the same canonical package (heals a crash between Market.upload and the row update): of the target skill for an update, else the user's personal skill. */
	#adopt(p: Principal, slug: string, sha: string, targetSkillId?: string): { skillId: string; versionNo: number } | undefined {
		if (targetSkillId) {
			const t = this.#db.get<{ skill_id: string; version_no: number }>("SELECT skill_id, version_no FROM skill_versions WHERE skill_id = ? AND package_sha256 = ? ORDER BY version_no DESC LIMIT 1", targetSkillId, sha);
			return t ? { skillId: t.skill_id, versionNo: t.version_no } : undefined;
		}
		const v = this.#db.get<{ skill_id: string; version_no: number }>(
			"SELECT v.skill_id, v.version_no FROM skill_versions v JOIN skill_skills s ON s.id = v.skill_id WHERE s.org_id = ? AND s.owner_user_id = ? AND s.scope = 'personal' AND s.slug = ? AND s.status = 'active' AND v.package_sha256 = ? ORDER BY v.version_no DESC LIMIT 1",
			p.orgId, p.userId, slug, sha,
		);
		return v ? { skillId: v.skill_id, versionNo: v.version_no } : undefined;
	}

	/** Save an approved draft from its snapshot. Idempotent; never reads the workspace. */
	async save(p: Principal, draftId: string, changeNote?: string): Promise<DraftRow> {
		return this.#lock.run(draftId, async () => {
			let r = this.row(draftId)!;
			if (r.state !== "pending") return r;
			const d = JSON.parse(r.detail) as SkillDraftApprovalDetail;
			const fail = (message: string, stage: string): DraftRow => {
				if (this.#finish(r, "failed", { error: message })) this.#market.audit(p, "skill.draft.failed", r.id, { draftId: r.id, stage, error: message.slice(0, 500) });
				return this.row(r.id)!;
			};
			const targetSkillId = d.target?.mode === "update" ? d.target.skillId : undefined;
			/** A new version of a market/org skill goes through review like any other distributed version (idempotent: one submission per version). */
			const submitForReview = async (skillId: string, versionNo: number): Promise<{ submission?: string; submissionState?: string; note?: string }> => {
				if (d.target?.scope !== "market") return {};
				const skill = this.#skills.skill(skillId);
				if (!skill || skill.scope === "personal") return {};
				const have = this.#db.get<{ id: string; state: string }>("SELECT id, state FROM market_submissions WHERE kind = 'skill' AND subject_id = ? AND version_no = ? AND state NOT IN ('withdrawn','superseded') ORDER BY created_at DESC LIMIT 1", skillId, versionNo);
				if (have) return { submission: have.id, submissionState: have.state };
				try {
					const sub = await this.#market.submit(p, skillId, versionNo, { targetScope: skill.scope, ...(skill.scope_ref ? { targetRef: skill.scope_ref } : {}), note: `由会话草稿更新（${r.id}）` });
					return { submission: sub.id, submissionState: sub.state };
				} catch (e) {
					// The version is saved; say plainly that it was NOT submitted (shown to the agent and the user).
					return { note: `新版本已保存，但没有提交审核：${e instanceof HttpError ? e.message : String((e as Error)?.message ?? e)}` };
				}
			};
			const done = (skillId: string, versionNo: number, extra: { note?: string; [k: string]: unknown } = {}): DraftRow => {
				const { note, ...audit } = extra;
				if (this.#finish(r, "saved", { skillId, versionNo, ...(note ? { error: String(note).slice(0, 500) } : {}) })) {
					this.#market.audit(p, "skill.draft.saved", r.id, { draftId: r.id, skillId, versionNo, sha256: r.package_sha256, scope: d.target?.scope === "market" ? (d.target.marketScope ?? "market") : "personal", update: d.target?.mode === "update", ...audit, ...(note ? { submissionError: note } : {}) });
				}
				return this.row(r.id)!;
			};
			// Healed retry: the version already exists.
			const prior = this.#adopt(p, d.name, r.package_sha256!, targetSkillId);
			if (prior) return done(prior.skillId, prior.versionNo, { adopted: true, ...(await submitForReview(prior.skillId, prior.versionNo)) });
			// Rebuild the files from the snapshot blobs and prove they are exactly what was approved.
			const stored = JSON.parse(r.files) as { path: string; sha256: string; size: number }[];
			const raw: { path: string; bytes: Uint8Array }[] = [];
			for (const f of stored) {
				const bytes = this.#ctx.blobs.get(f.sha256);
				if (!bytes || sha256Hex(bytes) !== f.sha256) return fail("草稿快照已损坏或丢失，请重新提交", "snapshot");
				raw.push({ path: f.path, bytes });
			}
			try {
				if (buildPackage(raw, nowIso()).packageSha256 !== r.package_sha256) return fail("草稿快照与已批准的内容不一致，请重新提交", "snapshot");
			} catch (e) {
				return fail(`草稿快照无法通过校验：${(e as Error).message}`, "snapshot");
			}
			// Update target: recorded at snapshot time; drafts from before that field fall back to the user's own personal skill with this name.
			const updateId = targetSkillId ?? this.#occupants(p, d.name).find((s) => s.scope === "personal" && s.owner_user_id === p.userId)?.id;
			try {
				const res = await this.#market.upload(p, {
					...(updateId ? { skillId: updateId } : {}),
					files: raw.map((f) => ({ path: f.path, content: Buffer.from(f.bytes).toString("base64"), encoding: "base64" as const })),
					changeNote: (changeNote ?? `由会话草稿保存（${r.id}）`).slice(0, 500),
				});
				if (res.version.package_sha256 !== r.package_sha256) return fail("保存后的版本与草稿快照不一致", "verify");
				return done(res.skill.id, res.version.version_no, { review: !!res.submission, ...(await submitForReview(res.skill.id, res.version.version_no)) });
			} catch (e: any) {
				if (e?.code === "duplicate_content") {
					const again = this.#adopt(p, d.name, r.package_sha256!, targetSkillId);
					if (again) return done(again.skillId, again.versionNo, { adopted: true });
				}
				if (e instanceof HttpError) return fail(`${e.message}（${e.code}）`, "upload");
				throw e;
			}
		});
	}

	reject(p: Principal, draftId: string, note?: string): DraftRow {
		const r = this.row(draftId)!;
		if (this.#finish(r, "rejected", note ? { error: note.slice(0, 500) } : {})) this.#market.audit(p, "skill.draft.rejected", r.id, { draftId: r.id, ...(note ? { note: note.slice(0, 300) } : {}) });
		return this.row(draftId)!;
	}

	/** Result text for the agent. */
	describe(r: DraftRow, orgId: string): string {
		const d = JSON.parse(r.detail) as SkillDraftApprovalDetail;
		const fl = d.findings.filter((f) => f.severity !== "info").map((f) => `- [${f.severity}] ${f.message}`).join("\n");
		const t = d.target;
		if (r.state === "failed") {
			const tail = d.findings.some((f) => f.code === "name_taken_not_writable" || f.code === "submit_not_allowed")
				? "没有创建审批，也没有保存任何内容。按上面的建议处理后重新调用 skill_manage submit_draft。"
				: `请修改 /work/${d.sourceDir} 中的文件后重新调用 skill_manage submit_draft。`;
			return `技能草稿「${d.name}」未能保存：${r.error ?? "失败"}\n${fl ? `检查结果：\n${fl}\n` : ""}${tail}`;
		}
		if (r.state === "rejected") return `用户拒绝了技能草稿「${d.name}」v${d.version}，没有保存任何内容。${r.error ? `原因：${r.error}` : ""}`;
		if (r.state === "saved") {
			const ids = `draft ${r.id}，技能 ${r.skill_id}，版本 ${r.version_no}`;
			if (t?.mode === "update" && t.scope === "market") {
				const sub = r.skill_id && r.version_no != null ? this.#db.get<{ id: string; state: string }>("SELECT id, state FROM market_submissions WHERE kind = 'skill' AND subject_id = ? AND version_no = ? ORDER BY created_at DESC LIMIT 1", r.skill_id, r.version_no) : undefined;
				const status = sub
					? sub.state === "checks_failed"
						? `新版本已保存并提交，但自动检查未通过（提交 ${sub.id}），需要修改后重新提交新版本。`
						: `新版本已提交审核（提交 ${sub.id}，状态 ${sub.state}）：通过审核之前，使用者（包括用户）仍在用旧版本，新版本还不能使用。`
					: `${r.error ?? "新版本已保存，但没有提交审核。"}新版本在通过审核之前不能使用；告诉用户可在「能力」里提交审核。`;
				return `已为市场技能「${t.skillName ?? d.name}」保存新版本 ${d.version}${t.fromVersion ? `（原最高版本 ${t.fromVersion}）` : ""}（${ids}）。${status}它的内容没有被运行。`;
			}
			const review = this.#market.policy(orgId).personalSkill === "review";
			const tail = review ? "组织策略要求审核：通过审核之前它还不能使用。" : "已为用户启用，可以用 skill_load 加载。";
			if (t?.mode === "update") return `技能「${d.name}」已在用户的个人技能上新增版本 ${d.version}${t.fromVersion ? `（原最高版本 ${t.fromVersion}）` : ""}（${ids}）。${tail}它没有被发布到商城。`;
			return `技能「${d.name}」v${d.version} 已保存为用户的个人技能（${ids}）。${tail}它没有被发布到商城。`;
		}
		return `技能草稿「${d.name}」v${d.version} 等待用户确认（draft ${r.id}）。`;
	}

	// ------------------------------------------------------------ checkout (current files of an accessible skill → /work/<dir>)
	/**
	 * Write the current approved version of a skill the user can read into the conversation workspace through the same host write path
	 * as sandbox_write_file (workspace rules, quota, no symlinks), so the agent can edit it and submit_draft the result as a new version.
	 * An existing non-empty directory is only reused when it is an UNMODIFIED earlier checkout of the same skill; anything else is refused.
	 */
	async checkout(actor: ToolActor, input: { name?: string; skillId?: string; dir?: string }): Promise<{ text: string; details: Record<string, string | number | boolean> }> {
		const p = actor.principal;
		const key = (input.skillId ?? input.name ?? "").trim();
		if (!key) throw new HttpError(400, "invalid", "checkout 需要 name（技能名称或 slug）或 skillId");
		await this.#market.require(p, "skill.use", undefined, "没有使用技能的权限（skill.use）");
		const visible = await this.#skills.visible(p);
		const matches = visible.filter((x) => x.id === key || x.name === key || this.#market.slugOf(x) === key);
		if (!matches.length) throw new HttpError(404, "skill_not_found", `没有你可以读取的技能「${key}」；先用 skill 工具 action=search 或 list 确认名称`);
		let skill = matches[0]!;
		for (const m of matches) {
			if ((await this.#skills.decide(p, "write", m.id)).allow) {
				skill = m;
				break;
			}
		}
		if (!(await this.#skills.decide(p, "read", skill.id)).allow) throw new HttpError(403, "forbidden", `无权读取技能「${skill.name}」`);
		const writable = (await this.#skills.decide(p, "write", skill.id)).allow;
		const slug = this.#market.slugOf(skill);
		// The current approved version (what users run). An author whose skill has no approved version yet starts from their latest.
		const usableNo = this.#market.latestUsable(skill);
		const no = usableNo || (writable ? skill.latest_version_no : 0);
		const v = no ? this.#skills.version(skill.id, no) : undefined;
		if (!v) throw new HttpError(409, "no_approved_version", `技能「${skill.name}」还没有通过审核的版本，无法取出文件`);
		if (usableNo) {
			const u = this.#market.usable(skill, v);
			if (!u.ok) throw new HttpError(409, u.reason, u.message);
		}
		const rel = cleanDir(input.dir ?? slug);
		const files = this.#market.versionFiles(skill, v);
		const total = files.reduce((n, f) => n + f.bytes.byteLength, 0);

		return this.#lock.run(`checkout:${actor.space.id}:${actor.conversationId}:${rel}`, async () => {
			const wd = this.#sandbox.workdir(actor.space, actor.conversationId);
			let existing: Snapshot["files"] = [];
			try {
				existing = snapshotDir(wd, rel).files;
			} catch (e) {
				if (!(e instanceof HttpError) || e.code !== "dir_not_found") throw e;
			}
			const marker = this.#db.get<{ skill_id: string; version_no: number; files: string }>("SELECT skill_id, version_no, files FROM skill_ws_checkouts WHERE space_id = ? AND conversation_id = ? AND dir = ?", actor.space.id, actor.conversationId, rel);
			const prev = marker && marker.skill_id === skill.id ? (JSON.parse(marker.files) as { path: string; sha256: string }[]) : undefined;
			const stale: string[] = [];
			let replaced = 0;
			if (existing.length) {
				const known = new Map((prev ?? []).map((f) => [f.path, f.sha256]));
				const changed = existing.filter((f) => known.get(f.path) !== sha256Hex(f.bytes)).map((f) => f.path);
				if (!prev || changed.length) {
					throw new HttpError(
						409,
						"dir_not_empty",
						`/work/${rel} 里已有内容，而且${prev ? `其中有你改动过或新增的文件（${changed.slice(0, 5).join("、")}${changed.length > 5 ? " 等" : ""}）` : "它不是这个技能的检出目录"}，为避免覆盖已拒绝检出。` +
							`${prev ? `要保留改动，直接继续编辑并调用 skill_manage submit_draft { dir: "${rel}" } 即可；` : ""}要重新检出，请换一个 dir（例如 ${rel}-2）。`,
					);
				}
				const fresh = new Set(files.map((f) => f.path));
				for (const f of existing) {
					replaced += f.bytes.byteLength;
					if (!fresh.has(f.path)) stale.push(f.path);
				}
			}
			const us = this.#sandbox.usage(actor.space, actor.conversationId);
			if (us.spaceBytes - replaced + total > us.quotaBytes) throw new HttpError(507, "sandbox_quota", `工作目录配额不足：技能文件共 ${Math.round(total / 1024)} KB，已用 ${Math.round(us.spaceBytes / 1048576)} MB，配额 ${Math.round(us.quotaBytes / 1048576)} MB；请先清理不需要的文件`);
			// Record the checkout first: a crash half-way leaves a directory that is still recognised as an unmodified checkout of this skill.
			this.#db.run(
				"INSERT INTO skill_ws_checkouts (space_id, conversation_id, dir, skill_id, version_no, files, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(space_id, conversation_id, dir) DO UPDATE SET skill_id = excluded.skill_id, version_no = excluded.version_no, files = excluded.files, created_at = excluded.created_at",
				actor.space.id, actor.conversationId, rel, skill.id, v.version_no, JSON.stringify(files.map((f) => ({ path: f.path, sha256: sha256Hex(f.bytes) }))), nowIso(),
			);
			for (const path of stale) this.#sandbox.remove(actor.space, actor.conversationId, `${rel}/${path}`);
			for (const f of files) this.#sandbox.writeFile(actor.space, actor.conversationId, `${rel}/${f.path}`, f.bytes);
			await workspacePersistenceFor(this.#ctx).commit(p, actor.space, workspaceKeyOf(actor.conversationId), "file_write").catch((e) => console.error("[skill_manage] workspace commit failed", e));

			const sem = v.semver ?? undefined;
			const canSubmit = writable && (skill.scope === "personal" || (await this.#market.canSubmitTo(p, skill.scope, skill.scope_ref)));
			const where = skill.scope === "personal" ? "个人技能" : `市场技能（${skill.scope === "org" ? "组织" : skill.scope === "department" ? "部门" : "项目"}）`;
			const next = canSubmit
				? `下一步：用 sandbox_read_file / sandbox_write_file 修改 /work/${rel} 里的文件；把 SKILL.md 里的 version 提高到大于 ${sem ?? "现有版本"}${sem ? `（例如 ${bumpPatch(sem)}）` : ""}，name 保持 ${slug} 不变；然后调用 skill_manage { action: "submit_draft", dir: "${rel}" }。用户确认后会保存为该技能的新版本${skill.scope === "personal" ? "" : "并提交审核，通过审核之前使用者仍用旧版本"}。`
				: `注意：用户没有更新这个${where}的权限（只有作者或市场管理员可以）。这些文件只能作为参考；若要基于它做自己的版本，把 SKILL.md 的 name 改成 ${this.#freeCopyName(p, slug)}（或别的名称）再 submit_draft，会保存为用户的个人副本，原技能不受影响。`;
			const text = `已把${where}「${skill.name}」${sem ? ` ${sem}` : ""}（版本 ${v.version_no}）的 ${files.length} 个文件写入 /work/${rel}：${files.map((f) => f.path).join("、")}。${stale.length ? `（已移除旧检出里不再存在的文件：${stale.join("、")}）` : ""}\n${next}`;
			return { text, details: { skillId: skill.id, versionNo: v.version_no, dir: rel, files: files.length, canUpdate: canSubmit } };
		});
	}
}

const instances = new WeakMap<AppContext, SkillDrafts>();
/** The per-app service (created lazily: no `ctx.services.provide` needed in module.ts). */
export function skillDraftsFor(ctx: AppContext): SkillDrafts {
	let s = instances.get(ctx);
	if (!s) instances.set(ctx, (s = new SkillDrafts(ctx)));
	return s;
}

// ------------------------------------------------------------------ agent tool
export function createSkillManageExtension(ctx: AppContext, opts: { resolveActor?: ActorResolver } = {}): Extension {
	const resolve = (api: ToolExecutionApi<any>, c: Context) => (opts.resolveActor ?? runtimeActorResolver(ctx))(api, c);
	const drafts = () => skillDraftsFor(ctx);
	const log = () => ctx.services.get("toolCalls") as ToolCallLog;
	const market = () => ctx.services.get("market") as Market;

	const skillManage = defineTool({
		name: "skill_manage",
		description:
			"Create a skill, or update an existing one, from files in the conversation workspace. Workflow: (1) to UPDATE an installed skill, call action \"checkout\" with its `name` (name or slug) or `skillId` and optionally `dir` (default: the slug) — " +
			"it writes the skill's current approved files into /work/<dir> without sandbox_exec (do not copy /skills/<name> by hand); to CREATE a new one, just start writing files. (2) Edit or write SKILL.md (frontmatter: name, description, version) and any scripts/references in /work/<dir> " +
			"with sandbox_write_file; keep `name` unchanged when updating, and raise `version` above the skill's current highest version (e.g. 1.0.0 → 1.0.1) — an unchanged version or identical content is rejected immediately. " +
			"(3) call action \"submit_draft\" with that relative dir. The package is checked and frozen, then the user is asked to confirm; only after they confirm it is saved: a new personal skill, or a NEW VERSION of the existing skill of that name " +
			"(your personal skill, or a market/org skill the user is author/admin of — its new version is submitted for review and others keep the old version until approved). Nothing is run. " +
			"If the name belongs to a market skill the user may not update, submit_draft refuses at once (no approval) and tells you to choose another name (e.g. <name>-custom, saved as a personal copy) or ask the author. " +
			"If the result lists errors, fix the files and submit again. action \"get_draft\" reads a draft you submitted earlier.",
		parameters: obj({
			action: oneOf(["submit_draft", "get_draft", "checkout"]),
			dir: opt(str({ description: "Directory under /work, e.g. weekly-report: the package to submit (submit_draft), or where to put the checked-out files (checkout; default: the skill's slug)" })),
			draftId: opt(str()),
			name: opt(str({ description: "checkout: the skill's name or slug" })),
			skillId: opt(str({ description: "checkout: the skill's id (alternative to name)" })),
		}),
		// Idempotent by construction: snapshot keyed by callId, approval keyed by callId, save adopts an existing identical version; checkout rewrites identical files and refuses to overwrite edits.
		replay: "safe",
		async execute(args, api, c) {
			const actor = await resolve(api, c);
			return log().around({ tool: "skill_manage", actor, args }, async () => {
				const svc = drafts();
				const p = actor.principal;
				if (args.action === "get_draft") {
					if (!args.draftId) throw new HttpError(400, "invalid", "get_draft 需要 draftId");
					const r = svc.forOwner(p, args.draftId);
					return { output: textOf(svc.describe(r, p.orgId)), details: { draftId: r.id, state: r.state, ...(r.skill_id ? { skillId: r.skill_id, versionNo: r.version_no } : {}) } };
				}
				if (args.action === "checkout") {
					await ctx.services.get("acl").require(p, "write", { kind: "space", id: actor.space.id });
					await requirePermission(ctx, p, "sandbox.use");
					const out = await svc.checkout(actor, { name: args.name, skillId: args.skillId, dir: args.dir });
					return { output: textOf(out.text), details: out.details };
				}
				if (args.action !== "submit_draft") throw new HttpError(400, "invalid", "action 必须是 submit_draft、get_draft 或 checkout");
				await ctx.services.get("acl").require(p, "write", { kind: "space", id: actor.space.id });
				// Refuse early (no draft, no approval) when the org does not allow personal skills for this user.
				const mk = market();
				if (mk.policy(p.orgId).personalSkill === "disabled") {
					if (!(await mk.can(p, "skill.publish"))) throw new HttpError(403, "forbidden", "组织策略不允许个人技能，无法保存");
				} else if (!(await mk.can(p, "skill.upload"))) throw new HttpError(403, "forbidden", "没有上传/保存技能的权限");

				let { row } = await svc.snapshot(actor, args.dir ?? "");
				if (row.state === "pending") {
					const req = svc.approvalRequest(row, p.orgId);
					const decision = await (ctx.services.get("effects") as EffectsApi).requestApproval(api, { title: req.title, summary: req.summary, risk: req.risk, detail: req.detail as any }, c);
					// Re-resolve the acting principal after the (possibly long) wait: access may have been revoked meanwhile.
					const after = await resolve(api, c);
					row = decision.decision === "approved" ? await svc.save(after.principal, row.id) : svc.reject(after.principal, row.id, decision.note);
				}
				return {
					output: textOf(svc.describe(row, p.orgId)),
					isError: row.state === "failed",
					details: { draftId: row.id, state: row.state, ...(row.skill_id ? { skillId: row.skill_id, versionNo: row.version_no } : {}) },
				};
			});
		},
	});

	return defineExtension({ name: "wr.skill-manage", tools: [skillManage] });
}

// ------------------------------------------------------------------ read-only HTTP
/** GET /api/skill-drafts/:id → { draft: SkillDraftDTO } (owner only, same org). */
export function registerSkillDraftRoutes(api: Hono<AppEnv>, ctx: AppContext): void {
	api.get("/skill-drafts/:id", (c) => {
		const svc = skillDraftsFor(ctx);
		return c.json({ draft: svc.dto(svc.forOwner(principalOf(c), c.req.param("id"))) });
	});
}
