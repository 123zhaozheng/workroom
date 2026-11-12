// /skills/<slug>/…: the skill packages the CURRENT identity may use (installed, own, or shared to them through the market scope rules).
// A view of the existing skills service — no second store. Reading resolves blobs only: it never starts, wakes or touches a sandbox and never
// materializes mounts. Writing is allowed ONLY inside a personal skill owned by the identity and is implemented as a new skill package
// version (an existing, separate mechanism: skill versions are not output versions). Everything else is read-only with a stated reason.
import type { AppContext, Principal, Space } from "../../core/contracts.ts";
import type { Market } from "../../tools/market.ts";
import type { SkillRow, Skills, VersionRow } from "../../tools/skills.ts";
import { PackageError, parseFrontmatter, parseSkillMd, type PackageFile } from "../../tools/skills-package.ts";
import { effectiveMime } from "../../files/mime.ts";
import { sha256 } from "../hostdir.ts";
import { VfsError, type Cap, type VfsBackend, type VfsContext, type VNode, type WriteResult } from "../types.ts";

const RO: readonly Cap[] = ["read"];
const RW_FILE: readonly Cap[] = ["read", "write", "edit", "remove"];
const RW_DIR: readonly Cap[] = ["read", "write"];

interface Entry {
	readonly slug: string;
	readonly skill: SkillRow;
	readonly version: VersionRow;
	/** A personal skill owned by the caller: the only writable kind. */
	readonly owned: boolean;
	readonly via: "me" | "org" | "department" | "project";
}

const SCOPE_LABEL: Record<string, string> = { org: "组织技能", department: "部门技能", project: "项目技能", personal: "个人技能" };

/** Map service errors (HttpError / PackageError) to the VFS contract; Chinese messages pass through. */
function mapError(e: unknown): never {
	if (e instanceof VfsError) throw e;
	if (e instanceof PackageError) throw new VfsError("bad_path", e.message);
	const x = e as { status?: number; message?: string };
	if (typeof x?.status === "number") {
		const code = x.status === 403 ? "forbidden" : x.status === 404 ? "not_found" : x.status === 413 ? "too_large" : x.status === 409 ? "exists" : "bad_path";
		throw new VfsError(code, x.message ?? "技能操作失败", x.status);
	}
	throw e;
}

export class SkillsBackend implements VfsBackend {
	readonly root = "/skills";
	readonly label = "当前可用的技能（先读 SKILL.md；只有你自己的个人技能可写）";
	readonly #ctx: AppContext;
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}
	get #skills(): Skills {
		return this.#ctx.services.get("skills") as Skills;
	}
	get #market(): Market {
		return this.#ctx.services.get("market") as Market;
	}
	available(): boolean {
		return this.#ctx.services.has("skills") && this.#ctx.services.has("market");
	}
	rootCaps(): readonly Cap[] {
		return RO;
	}

	/** The skills this identity may use right now, by slug. Metadata only (no package bytes are read here). */
	async #catalog(ctx: VfsContext): Promise<Entry[]> {
		const p: Principal = ctx.principal;
		if (!(await this.#market.can(p, "skill.use"))) return [];
		const out: Entry[] = [];
		const slugs = new Set<string>();
		const space: Space = ctx.space;
		for (const a of await this.#skills.active(p, space)) {
			const slug = this.#market.slugOf(a.skill);
			slugs.add(slug);
			out.push({ slug, skill: a.skill, version: a.version, owned: a.skill.scope === "personal" && a.skill.owner_user_id === p.userId, via: a.via });
		}
		// Own personal skills that are not installed (or switched off) are still the author's to read and edit.
		if (this.#market.policy(p.orgId).personalSkill !== "disabled") {
			for (const s of await this.#skills.visible(p)) {
				if (s.scope !== "personal" || s.owner_user_id !== p.userId) continue;
				const slug = this.#market.slugOf(s);
				if (slugs.has(slug)) continue;
				const v = this.#skills.version(s.id, s.latest_version_no);
				if (!v) continue;
				slugs.add(slug);
				out.push({ slug, skill: s, version: v, owned: true, via: "me" });
			}
		}
		// An owned skill is always edited on top of its LATEST version (what a pinned install shows may be older).
		for (let i = 0; i < out.length; i++) {
			const e = out[i]!;
			if (e.owned && e.version.version_no !== e.skill.latest_version_no) {
				const v = this.#skills.version(e.skill.id, e.skill.latest_version_no);
				if (v) out[i] = { ...e, version: v };
			}
		}
		return out.sort((a, b) => a.slug.localeCompare(b.slug));
	}
	async #entry(ctx: VfsContext, slug: string): Promise<Entry | undefined> {
		return (await this.#catalog(ctx)).find((e) => e.slug === slug);
	}
	#files(e: Entry): PackageFile[] {
		try {
			return this.#market.versionFiles(e.skill, e.version);
		} catch (err) {
			if ((err as { code?: string }).code === "blob_missing") throw new VfsError("unavailable", `技能「${e.slug}」的部分文件已缺失，暂时无法读取`, 500);
			throw err;
		}
	}
	#reason(e: Entry): string {
		return `只读：${e.via === "me" && e.skill.scope !== "personal" ? "已安装的" : ""}${SCOPE_LABEL[e.skill.scope] ?? "技能"}`;
	}

	#rootNode(e: Entry): VNode {
		return { path: `/skills/${e.slug}`, name: e.slug, type: "dir", mtime: e.skill.updated_at, caps: e.owned ? RW_DIR : RO, note: e.owned ? `${e.skill.name}（个人技能，可编辑）` : `${e.skill.name}（${this.#reason(e)}）` };
	}
	#fileNode(e: Entry, f: PackageFile): VNode {
		return { path: `/skills/${e.slug}/${f.path}`, name: f.path.split("/").pop()!, type: "file", size: f.bytes.length, mtime: e.version.created_at, mime: effectiveMime(undefined, f.path), etag: sha256(f.bytes), caps: e.owned ? RW_FILE : RO, ...(e.owned ? {} : { note: this.#reason(e) }) };
	}
	#dirNode(e: Entry, sub: string): VNode {
		return { path: `/skills/${e.slug}/${sub}`, name: sub.split("/").pop()!, type: "dir", mtime: e.version.created_at, caps: e.owned ? RW_DIR : RO, ...(e.owned ? {} : { note: this.#reason(e) }) };
	}
	#split(rel: string): { slug: string; sub: string } {
		const i = rel.indexOf("/");
		return i < 0 ? { slug: rel, sub: "" } : { slug: rel.slice(0, i), sub: rel.slice(i + 1) };
	}

	async stat(ctx: VfsContext, rel: string): Promise<VNode | null> {
		if (!rel) return { path: "/skills", name: "skills", type: "dir", caps: RO };
		const { slug, sub } = this.#split(rel);
		const e = await this.#entry(ctx, slug);
		if (!e) return null;
		if (!sub) return this.#rootNode(e);
		const files = this.#files(e);
		const f = files.find((x) => x.path === sub);
		if (f) return this.#fileNode(e, f);
		return files.some((x) => x.path.startsWith(`${sub}/`)) ? this.#dirNode(e, sub) : null;
	}

	async list(ctx: VfsContext, rel: string, opts: { cursor?: string; limit: number }) {
		let entries: VNode[];
		if (!rel) entries = (await this.#catalog(ctx)).map((e) => this.#rootNode(e));
		else {
			const { slug, sub } = this.#split(rel);
			const e = await this.#entry(ctx, slug);
			if (!e) throw new VfsError("not_found", `/skills/${rel} 不存在`, 404);
			const files = this.#files(e);
			if (sub && files.some((x) => x.path === sub)) throw new VfsError("not_a_directory", `/skills/${rel} 不是目录`);
			const prefix = sub ? `${sub}/` : "";
			const under = files.filter((x) => x.path.startsWith(prefix));
			if (!under.length) throw new VfsError("not_found", `/skills/${rel} 不存在`, 404);
			const seen = new Map<string, VNode>();
			for (const f of under) {
				const rest = f.path.slice(prefix.length);
				const slash = rest.indexOf("/");
				if (slash < 0) seen.set(rest, this.#fileNode(e, f));
				else if (!seen.has(rest.slice(0, slash))) seen.set(rest.slice(0, slash), this.#dirNode(e, `${prefix}${rest.slice(0, slash)}`));
			}
			entries = [...seen.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
		}
		const start = opts.cursor ? entries.findIndex((n) => n.name > opts.cursor!) : 0;
		const page = start < 0 ? [] : entries.slice(start, start + opts.limit);
		return { entries: page, truncated: start >= 0 && start + opts.limit < entries.length };
	}

	async read(ctx: VfsContext, rel: string) {
		const { slug, sub } = this.#split(rel);
		const e = await this.#entry(ctx, slug);
		if (!e) throw new VfsError("not_found", `/skills/${rel} 不存在`, 404);
		if (!sub) throw new VfsError("not_a_file", `/skills/${rel} 是目录，请用 ls`);
		const f = this.#files(e).find((x) => x.path === sub);
		if (!f) throw new VfsError("not_found", `/skills/${rel} 不存在`, 404);
		return { node: this.#fileNode(e, f), bytes: f.bytes };
	}

	// ---------------------------------------------------------------- writes
	#denyReadOnly(e: Entry, what: string): never {
		throw new VfsError("read_only", `/skills/${e.slug} 是${SCOPE_LABEL[e.skill.scope] ?? "技能"}${e.via === "me" && e.skill.scope !== "personal" ? "（已安装）" : ""}，不能${what}：只有你自己创建的个人技能可以修改。需要改动时请 copy_to_work（recursive: true）到 /work 后修改副本。`, 403);
	}

	/** Publish `files` as the next package version of an owned skill. */
	async #commit(ctx: VfsContext, e: Entry, files: PackageFile[], note: string): Promise<void> {
		const md = files.find((f) => f.path === "SKILL.md");
		let instructions = e.version.instructions;
		let description = e.version.description;
		if (md) {
			let fm: ReturnType<typeof parseFrontmatter>;
			try {
				fm = parseFrontmatter(new TextDecoder().decode(md.bytes));
			} catch (err) {
				return mapError(err);
			}
			if (typeof fm.data.name === "string" && fm.data.name.trim() !== e.slug) throw new VfsError("bad_path", `SKILL.md 的 name 必须保持为「${e.slug}」（它决定技能目录名）`);
			if (typeof fm.data.description === "string" && fm.data.description.trim()) description = fm.data.description.trim();
			instructions = fm.body.trim() ? fm.body : instructions;
		}
		try {
			await this.#skills.addVersion(ctx.principal, e.skill.id, {
				kind: e.version.kind,
				description,
				instructions,
				resources: files.map((f) => ({ path: f.path, content: Buffer.from(f.bytes).toString("base64"), encoding: "base64" as const })),
				entry: e.version.entry ?? undefined,
				requiredTools: JSON.parse(e.version.required_tools),
				requiredPermissions: JSON.parse(e.version.required_permissions),
				changeNote: note,
			});
		} catch (err) {
			mapError(err);
		}
	}

	async write(ctx: VfsContext, rel: string, bytes: Uint8Array, opts: { expectedEtag?: string }): Promise<WriteResult> {
		const { slug, sub } = this.#split(rel);
		if (!sub) throw new VfsError("not_a_file", `/skills/${slug} 是目录：请写入其中的文件，例如 /skills/${slug}/SKILL.md`);
		const e = await this.#entry(ctx, slug);
		if (!e) return this.#create(ctx, slug, sub, bytes);
		if (!e.owned) this.#denyReadOnly(e, "写入");
		const files = this.#files(e);
		const cur = files.find((f) => f.path === sub);
		if (files.some((f) => f.path.startsWith(`${sub}/`))) throw new VfsError("not_a_file", `/skills/${rel} 是目录`);
		if (opts.expectedEtag !== undefined && opts.expectedEtag !== (cur ? sha256(cur.bytes) : undefined)) throw new VfsError("etag_mismatch", `/skills/${rel} 已被修改（etag 不一致），请重新读取后再写`, 409);
		if (cur && sha256(cur.bytes) === sha256(bytes)) return { node: this.#fileNode(e, cur), status: "unchanged" };
		const next = [...files.filter((f) => f.path !== sub), { path: sub, bytes }];
		await this.#commit(ctx, e, next, `${cur ? "修改" : "新增"} ${sub}`);
		const fresh = await this.stat(ctx, rel);
		return { node: fresh!, status: cur ? "updated" : "created" };
	}

	/** A brand-new folder = a new personal skill, only through a valid SKILL.md (the upload path validates and installs it). */
	async #create(ctx: VfsContext, slug: string, sub: string, bytes: Uint8Array): Promise<WriteResult> {
		if (sub !== "SKILL.md") throw new VfsError("not_found", `技能「${slug}」不存在：新建个人技能请先写入 /skills/${slug}/SKILL.md（需要带 name: ${slug} 与 description 的 frontmatter），再添加其他文件`, 404);
		let parsed;
		try {
			parsed = parseSkillMd([{ path: "SKILL.md", bytes }]);
		} catch (err) {
			return mapError(err);
		}
		if (parsed.manifest.name !== slug) throw new VfsError("bad_path", `SKILL.md 的 name「${parsed.manifest.name}」必须与目录名「${slug}」一致`);
		try {
			await this.#market.upload(ctx.principal, { files: [{ path: "SKILL.md", content: Buffer.from(bytes).toString("utf8") }], changeNote: "通过 /skills 创建" });
		} catch (err) {
			mapError(err);
		}
		const node = await this.stat(ctx, `${slug}/SKILL.md`);
		if (!node) throw new VfsError("unavailable", "技能已创建，但按当前组织策略暂时不可使用（可能需要审核）", 202);
		return { node, status: "created" };
	}

	async remove(ctx: VfsContext, rel: string, opts: { recursive?: boolean }): Promise<{ removed: string }> {
		const { slug, sub } = this.#split(rel);
		const e = await this.#entry(ctx, slug);
		if (!e) throw new VfsError("not_found", `/skills/${rel} 不存在`, 404);
		if (!e.owned) this.#denyReadOnly(e, "删除");
		if (!sub) throw new VfsError("forbidden", "不能在这里删除整个技能：请在技能管理页面处理", 403);
		const files = this.#files(e);
		const isFile = files.some((f) => f.path === sub);
		const under = files.filter((f) => f.path === sub || f.path.startsWith(`${sub}/`));
		if (!under.length) throw new VfsError("not_found", `/skills/${rel} 不存在`, 404);
		if (!isFile && !opts.recursive) throw new VfsError("bad_path", `/skills/${rel} 是目录：确实要删除请传 recursive: true`);
		if (under.some((f) => f.path === "SKILL.md")) throw new VfsError("forbidden", "SKILL.md 不能删除（技能必须有它）", 403);
		await this.#commit(ctx, e, files.filter((f) => !under.includes(f)), `删除 ${sub}`);
		return { removed: `/skills/${rel}` };
	}
}
