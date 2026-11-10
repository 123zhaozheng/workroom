// Skills created in conversation (round 6, B2). The agent writes SKILL.md (+ resources/scripts) into a directory of its own
// conversation workspace and calls the controlled tool `skill_manage` { action: "submit_draft", dir }. The backend then:
//   1. resolves the acting principal / space / conversation server-side (never from model arguments),
//   2. reads `dir` strictly inside Sandbox.workdir(space, conversationId): no symlinks anywhere, no special files, size/count limits,
//      open with O_NOFOLLOW + dev/ino re-check against the lstat (TOCTOU),
//   3. builds the canonical package (skills-package.ts buildPackage: manifest validation, secret/network scan) and FIXES the snapshot:
//      canonical zip + per-file blobs + packageSha256 go into a draft row; later workspace edits cannot change what is approved,
//   4. opens a durable approval (effects.requestApproval, keyed by callId) whose detail is SkillDraftApprovalDetail,
//   5. on approval saves it as the user's PERSONAL skill through Market.upload (org policy free/review/disabled applies, installs for the
//      user) from the snapshot blobs. Nothing is published to the market, nothing runs, nothing is auto-approved.
//
// Idempotency (pi-durable replay): the draft is keyed by (space, conversation, callId). A rerun finds the row and reuses the snapshot (the
// workspace is not read again), requestApproval reattaches by callId, and an already saved draft returns the saved skill. A crash between
// Market.upload and the row update is healed by adopting the user's existing version with the same packageSha256 (also on 409 duplicate_content).
// => the whole execute is idempotent, hence replay: "safe".
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { Hono } from "hono";
import type { AppContext, AppEnv, EffectsApi, Principal, ToolActor } from "../core/contracts.ts";
import type { Migration } from "../core/db.ts";
import { HttpError, newId, nowIso, principalOf } from "../core/http.ts";
import type { SkillDraftApprovalDetail, SkillDraftDTO, SkillDraftFileDTO, SkillDraftFindingDTO, SkillDraftState } from "../../../shared/skill-drafts.ts";
import { runtimeActorResolver, type ActorResolver } from "../files/actor.ts";
import type { ToolCallLog } from "./calls.ts";
import type { Market } from "./market.ts";
import type { Sandbox } from "./sandbox.ts";
import { cleanPath, isInside } from "./sandbox/workspace.ts";
import { buildPackage, LIMITS, PackageError, sha256Hex } from "./skills-package.ts";

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

	/** The user's own active personal skill with this slug (a new version is added instead of a new skill). */
	#ownSkill(p: Principal, slug: string): { id: string; name: string; latest_version_no: number } | undefined {
		return this.#db.get("SELECT id, name, latest_version_no FROM skill_skills WHERE org_id = ? AND owner_user_id = ? AND scope = 'personal' AND slug = ? AND status = 'active'", p.orgId, p.userId, slug);
	}
	#semverOf(skillId: string, no: number): string | undefined {
		return this.#db.get<{ semver: string | null }>("SELECT semver FROM skill_versions WHERE skill_id = ? AND version_no = ?", skillId, no)?.semver ?? undefined;
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
		const failed = (sourceDir: string, findings: SkillDraftFindingDTO[], files: { path: string; bytes: Uint8Array }[] = []): { row: DraftRow; created: boolean } => {
			const msg = findings.filter((f) => f.severity === "error").map((f) => f.message).join("；") || "草稿无法生成";
			const name = lastSeg(sourceDir);
			const detail: SkillDraftApprovalDetail = {
				kind: "skill_draft", draftId: base.id, name, title: name, description: "", version: "", skillKind: "", sourceDir,
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
		// Fix the snapshot: canonical zip + every file as blobs. From here on the workspace is irrelevant.
		this.#ctx.blobs.put(built.zip);
		const stored = built.files.map((f) => ({ path: f.path, ...this.#ctx.blobs.put(f.bytes) }));
		const files: SkillDraftFileDTO[] = built.files.map((f) => ({ path: f.path, size: f.bytes.byteLength, sha256: sha256Hex(f.bytes), executable: isExecutable(f.path) }));
		const own = this.#ownSkill(p, m.name);
		const detail: SkillDraftApprovalDetail = {
			kind: "skill_draft", draftId: base.id, name: m.name, title: m.title ?? m.name, description: m.description, version: m.version, skillKind: m.kind, sourceDir: snap.rel,
			files, totalBytes: files.reduce((n, f) => n + f.size, 0), packageSha256: built.packageSha256,
			requiredPermissions: [...m.requiredPermissions], requiredTools: [...m.requiredTools],
			findings: built.check.findings.map((f) => ({ severity: f.severity, code: f.code, message: f.message })),
			...(own ? { updatesSkill: { id: own.id, name: own.name, ...(this.#semverOf(own.id, own.latest_version_no) ? { fromVersion: this.#semverOf(own.id, own.latest_version_no)! } : {}) } } : {}),
		};
		const row = insert({ source_dir: snap.rel, state: "pending", detail: JSON.stringify(detail), package_sha256: built.packageSha256, files: JSON.stringify(stored), error: null });
		return { row, created: row.id === base.id };
	}

	/** Approval request for a pending draft (title/summary say exactly what happens). */
	approvalRequest(r: DraftRow, orgId: string) {
		const d = JSON.parse(r.detail) as SkillDraftApprovalDetail;
		const pol = this.#market.policy(orgId).personalSkill;
		const parts = [d.updatesSkill ? `在你已有的个人技能「${d.updatesSkill.name}」上新增版本 v${d.version}（仅你可用）` : `保存为仅你可用的个人技能 v${d.version}`, "不会自动执行，也不会发布到商城"];
		if (pol === "review") parts.push("组织策略要求审核：保存后需通过审核才能使用");
		return { title: `保存为个人技能：${d.title}`, summary: parts.join("；"), risk: riskOf(d.findings, d.files, d.requiredPermissions), detail: d };
	}

	/** Terminal state change, once: returns false when somebody else already decided. */
	#finish(r: DraftRow, state: "saved" | "rejected" | "failed", extra: { error?: string; skillId?: string; versionNo?: number } = {}): boolean {
		const res = this.#db.run("UPDATE skill_ws_drafts SET state = ?, decided_at = ?, error = ?, skill_id = ?, version_no = ? WHERE id = ? AND state = 'pending'", state, nowIso(), extra.error ?? null, extra.skillId ?? null, extra.versionNo ?? null, r.id);
		return res.changes > 0;
	}

	/** The user's version with the same canonical package (heals a crash between Market.upload and the row update). */
	#adopt(p: Principal, slug: string, sha: string): { skillId: string; versionNo: number } | undefined {
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
			const done = (skillId: string, versionNo: number, extra: Record<string, unknown> = {}): DraftRow => {
				if (this.#finish(r, "saved", { skillId, versionNo })) this.#market.audit(p, "skill.draft.saved", r.id, { draftId: r.id, skillId, versionNo, sha256: r.package_sha256, scope: "personal", ...extra });
				return this.row(r.id)!;
			};
			// Healed retry: the version already exists.
			const prior = this.#adopt(p, d.name, r.package_sha256!);
			if (prior) return done(prior.skillId, prior.versionNo, { adopted: true });
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
			const own = this.#ownSkill(p, d.name);
			try {
				const res = await this.#market.upload(p, {
					...(own ? { skillId: own.id } : {}),
					files: raw.map((f) => ({ path: f.path, content: Buffer.from(f.bytes).toString("base64"), encoding: "base64" as const })),
					changeNote: (changeNote ?? `由会话草稿保存（${r.id}）`).slice(0, 500),
				});
				if (res.version.package_sha256 !== r.package_sha256) return fail("保存后的版本与草稿快照不一致", "verify");
				return done(res.skill.id, res.version.version_no, { review: !!res.submission });
			} catch (e: any) {
				if (e?.code === "duplicate_content") {
					const again = this.#adopt(p, d.name, r.package_sha256!);
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
		if (r.state === "failed") return `技能草稿「${d.name}」未能保存：${r.error ?? "失败"}\n${fl ? `检查结果：\n${fl}\n` : ""}请修改 /work/${d.sourceDir} 中的文件后重新调用 skill_manage submit_draft。`;
		if (r.state === "rejected") return `用户拒绝了技能草稿「${d.name}」v${d.version}，没有保存任何内容。${r.error ? `原因：${r.error}` : ""}`;
		if (r.state === "saved") {
			const review = this.#market.policy(orgId).personalSkill === "review";
			return `技能「${d.name}」v${d.version} 已保存为用户的个人技能（draft ${r.id}，技能 ${r.skill_id}，版本 ${r.version_no}）。${review ? "组织策略要求审核：通过审核之前它还不能使用。" : "已为用户启用，可以用 skill_load 加载。"}它没有被发布到商城。`;
		}
		return `技能草稿「${d.name}」v${d.version} 等待用户确认（draft ${r.id}）。`;
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
			"Save a skill you wrote in the conversation workspace as the user's personal skill. First write SKILL.md (frontmatter: name, description, version) and any scripts/references into /work/<dir> " +
			"with sandbox_write_file, then call action \"submit_draft\" with that relative dir. The package is checked and frozen, the user is asked to confirm, and only then it is saved as a personal skill " +
			"(never published to the marketplace, never run). If the result lists errors, fix the files and submit again. action \"get_draft\" reads a draft you submitted earlier.",
		parameters: obj({ action: oneOf(["submit_draft", "get_draft"]), dir: opt(str({ description: "Directory under /work that contains SKILL.md, e.g. weekly-report" })), draftId: opt(str()) }),
		// Idempotent by construction: snapshot keyed by callId, approval keyed by callId, save adopts an existing identical version.
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
				if (args.action !== "submit_draft") throw new HttpError(400, "invalid", "action 必须是 submit_draft 或 get_draft");
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
