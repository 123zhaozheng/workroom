// MCP marketplace (round 4): a catalog of MCP servers described by `server.json` (the official MCP Registry format), with the same
// immutable-version / submission / scoped-review / publish workflow as skills, install into a connector (personal or org), per-user
// credentials, and stdio servers that only ever run inside the sandbox's service mode (never on the host).
//   remotes[]  (streamable-http)  → http connector (URL template variables + secret headers)
//   packages[] npm / pypi         → `npx` / `uvx` inside the sandbox — needs sandbox network (blocked otherwise, said so)
//   packages[] bundle (ours)      → zip with server.json + code, mounted read-only at /mcp/<slug>, run with node/python/sh
//   everything else (oci, nuget, cargo, mcpb, sse) → listed, but the install option is `blocked` with the reason
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppContext, Principal } from "../core/contracts.ts";
import type { Migration } from "../core/db.ts";
import { HttpError, newId, nowIso } from "../core/http.ts";
import type { McpCatalogDetailDTO, McpCatalogSummaryDTO, McpInstallOptionDTO, McpSubmissionInfoDTO, MarketScope, PackageCheckDTO, PackageFindingDTO, ServerJson, SubmissionDetailDTO, SubmissionState } from "../../../shared/files.ts";
import type { McpManager, McpServerRow, SandboxPackage } from "./mcp.ts";
import type { Market, SubRow } from "./market.ts";
import type { Sandbox } from "./sandbox.ts";
import { buildCanonicalZip, normalizeFiles, PackageError, safePath, scanFiles, sha256Hex, unzipPackage, type PackageFile } from "./skills-package.ts";

export const MCP_MARKET_MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "mcp market: catalog, immutable versions, sandbox stdio, per-user credentials",
		sql: `
CREATE TABLE mcp_catalog (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'personal', scope_ref TEXT, owner_user_id TEXT NOT NULL, category TEXT, tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active', latest_version_no INTEGER NOT NULL DEFAULT 0, published_version_no INTEGER, listed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (org_id, name)
);
CREATE TABLE mcp_catalog_versions (
  id TEXT PRIMARY KEY, catalog_id TEXT NOT NULL REFERENCES mcp_catalog(id), version_no INTEGER NOT NULL, semver TEXT NOT NULL, server_json TEXT NOT NULL,
  sha256 TEXT NOT NULL, bundle_sha256 TEXT, files TEXT, checks TEXT NOT NULL, change_note TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (catalog_id, version_no)
);
CREATE TRIGGER mcp_catalog_versions_no_update BEFORE UPDATE ON mcp_catalog_versions BEGIN SELECT RAISE(ABORT, 'catalog versions are immutable'); END;
CREATE TABLE mcp_catalog_publish (version_id TEXT PRIMARY KEY, catalog_id TEXT NOT NULL, version_no INTEGER NOT NULL, approved_at TEXT NOT NULL, submission_id TEXT, forced INTEGER NOT NULL DEFAULT 0);
ALTER TABLE mcp_servers ADD COLUMN approval_state TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE mcp_servers ADD COLUMN exec_mode TEXT NOT NULL DEFAULT 'host';
ALTER TABLE mcp_servers ADD COLUMN credential_mode TEXT NOT NULL DEFAULT 'shared';
ALTER TABLE mcp_servers ADD COLUMN catalog_version_id TEXT;
ALTER TABLE mcp_servers ADD COLUMN package_json TEXT;
ALTER TABLE mcp_user_settings ADD COLUMN secrets_enc TEXT;
ALTER TABLE mcp_user_settings ADD COLUMN tool_overrides TEXT NOT NULL DEFAULT '{}';
`,
	},
];

interface CatalogRow {
	id: string;
	org_id: string;
	name: string;
	slug: string;
	title: string;
	description: string;
	scope: MarketScope;
	scope_ref: string | null;
	owner_user_id: string;
	category: string | null;
	tags: string;
	status: string;
	latest_version_no: number;
	published_version_no: number | null;
	listed: number;
	created_at: string;
	updated_at: string;
}
interface CatVersionRow {
	id: string;
	catalog_id: string;
	version_no: number;
	semver: string;
	server_json: string;
	sha256: string;
	bundle_sha256: string | null;
	files: string | null;
	checks: string;
	change_note: string | null;
	created_by: string;
	created_at: string;
}

const NAME_RE = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEADER_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/** Environment variables a server definition may never set: they hijack the loader or the runtime. */
const FORBIDDEN_ENV = new Set(["PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME", "HOME", "SHELL", "IFS", "BASH_ENV", "ENV"]);
const RANGE_RE = /^[\^~<>=]|\s|\|\|/;

const asStr = (v: unknown, max = 2000): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** Validate a server.json (official registry schema, subset we act on). Throws HttpError(400). */
export function parseServerJson(raw: unknown): ServerJson {
	let o: any = raw;
	if (o && typeof o === "object" && o.server && typeof o.server === "object") o = o.server; // registry API wrapper { server, _meta }
	if (!o || typeof o !== "object" || Array.isArray(o)) throw new HttpError(400, "server_json_invalid", "server.json 必须是 JSON 对象");
	if (JSON.stringify(o).length > 64 * 1024) throw new HttpError(400, "server_json_invalid", "server.json 超过 64 KB");
	const name = asStr(o.name, 200);
	if (!name || name.length < 3 || !NAME_RE.test(name) || name.split("/").length !== 2) throw new HttpError(400, "server_json_invalid", `name「${o.name}」必须是反向 DNS 命名空间 + “/” + 名称，如 io.github.user/weather`);
	const description = asStr(o.description, 4000);
	if (!description) throw new HttpError(400, "server_json_invalid", "server.json 缺少 description");
	const version = asStr(o.version, 64);
	if (!version) throw new HttpError(400, "server_json_invalid", "server.json 缺少 version");
	if (RANGE_RE.test(version)) throw new HttpError(400, "server_json_invalid", `version「${version}」不能是版本范围（官方 Registry 同样禁止）`);
	const inputs = (list: unknown, kind: "environmentVariables" | "headers", ctx: string) => {
		if (list === undefined) return undefined;
		if (!Array.isArray(list)) throw new HttpError(400, "server_json_invalid", `${ctx}.${kind} 必须是数组`);
		return list.map((e: any) => {
			const n = asStr(e?.name, 64);
			if (!n || !(kind === "headers" ? HEADER_RE : ENV_RE).test(n)) throw new HttpError(400, "server_json_invalid", `${ctx}.${kind} 中的名称「${e?.name}」不合法`);
			if (kind === "environmentVariables" && FORBIDDEN_ENV.has(n.toUpperCase())) throw new HttpError(400, "forbidden_env", `不允许设置环境变量 ${n}（会改变运行环境或加载器）`);
			return { name: n, description: asStr(e?.description, 500), isRequired: e?.isRequired === true, isSecret: e?.isSecret === true, default: asStr(e?.default, 500), choices: Array.isArray(e?.choices) ? e.choices.map(String).slice(0, 30) : undefined, value: asStr(e?.value, 500) };
		});
	};
	if (o.packages !== undefined && !Array.isArray(o.packages)) throw new HttpError(400, "server_json_invalid", "packages 必须是数组");
	if (o.remotes !== undefined && !Array.isArray(o.remotes)) throw new HttpError(400, "server_json_invalid", "remotes 必须是数组");
	const packages = (o.packages ?? []).map((p: any, i: number) => {
		const registryType = asStr(p?.registryType, 32);
		const identifier = asStr(p?.identifier, 300);
		if (!registryType || !identifier) throw new HttpError(400, "server_json_invalid", `packages[${i}] 需要 registryType 和 identifier`);
		const transport = p.transport && typeof p.transport === "object" ? { type: String(p.transport.type ?? "stdio"), url: asStr(p.transport.url) } : { type: "stdio" };
		const args = (a: unknown) => (Array.isArray(a) ? a.slice(0, 40).map((x: any) => ({ type: asStr(x?.type, 20), name: asStr(x?.name, 80), value: asStr(x?.value, 300), valueHint: asStr(x?.valueHint, 80) })) : undefined);
		return { registryType, registryBaseUrl: asStr(p.registryBaseUrl), identifier, version: asStr(p.version, 64), fileSha256: asStr(p.fileSha256, 64), runtimeHint: asStr(p.runtimeHint, 32), transport, runtimeArguments: args(p.runtimeArguments), packageArguments: args(p.packageArguments), environmentVariables: inputs(p.environmentVariables, "environmentVariables", `packages[${i}]`) };
	});
	const remotes = (o.remotes ?? []).map((r: any, i: number) => {
		const type = asStr(r?.type, 32);
		const url = asStr(r?.url, 1000);
		if (!type || !url) throw new HttpError(400, "server_json_invalid", `remotes[${i}] 需要 type 和 url`);
		try {
			new URL(url.replace(/\{[A-Za-z0-9_]+\}/g, "x"));
		} catch {
			throw new HttpError(400, "server_json_invalid", `remotes[${i}].url 不是有效的 URL`);
		}
		const variables: Record<string, any> = {};
		for (const [k, v] of Object.entries(r.variables ?? {})) variables[k] = { description: asStr((v as any)?.description, 500), isRequired: (v as any)?.isRequired === true, isSecret: (v as any)?.isSecret === true, default: asStr((v as any)?.default, 500), choices: Array.isArray((v as any)?.choices) ? (v as any).choices.map(String).slice(0, 30) : undefined };
		return { type, url, headers: inputs(r.headers, "headers", `remotes[${i}]`), variables };
	});
	if (!packages.length && !remotes.length) throw new HttpError(400, "server_json_invalid", "server.json 至少需要一个 packages 或 remotes 条目");
	return {
		$schema: asStr(o.$schema),
		name,
		description,
		title: asStr(o.title, 120),
		version,
		websiteUrl: asStr(o.websiteUrl),
		repository: o.repository && typeof o.repository === "object" && asStr(o.repository.url) ? { url: String(o.repository.url), source: asStr(o.repository.source, 20), subfolder: asStr(o.repository.subfolder, 200) } : undefined,
		packages,
		remotes,
		_meta: o._meta && typeof o._meta === "object" ? (JSON.parse(JSON.stringify(o._meta).slice(0, 8192) || "{}") as Record<string, unknown>) : undefined,
	} as ServerJson;
}

type Mutable<T extends readonly unknown[]> = T[number][];
const slugOfName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

export interface SandboxCaps {
	state: string;
	services: boolean;
	mounts: boolean;
	networkAllowed: boolean;
}

/** The ways an entry can be installed here, each with the reason when it cannot. */
export function installOptions(sj: ServerJson, caps: SandboxCaps | null, hasBundle: boolean): McpInstallOptionDTO[] {
	const out: McpInstallOptionDTO[] = [];
	for (const [i, r] of (sj.remotes ?? []).entries()) {
		const inputs: McpInstallOptionDTO["inputs"][number][] = [];
		for (const h of r.headers ?? []) inputs.push({ name: h.name, description: h.description, secret: h.isSecret === true, required: h.isRequired === true, where: "header" });
		for (const [k, v] of Object.entries(r.variables ?? {})) inputs.push({ name: k, description: v.description, secret: v.isSecret === true, required: v.isRequired === true, where: "variable" });
		out.push({ index: out.length, kind: "remote", label: `远程（${r.type}）`, transport: "http", url: r.url, inputs, blocked: r.type === "streamable-http" ? undefined : `暂不支持 ${r.type} 传输（仅 streamable-http）` });
		void i;
	}
	for (const p of sj.packages ?? []) {
		const inputs = (p.environmentVariables ?? []).map((e) => ({ name: e.name, description: e.description, secret: e.isSecret === true, required: e.isRequired === true, where: "env" as const }));
		let blocked: string | undefined;
		if (p.transport?.type && p.transport.type !== "stdio") blocked = `暂不支持 ${p.transport.type} 传输的软件包（仅 stdio）`;
		else if (!caps || caps.state !== "ready") blocked = "沙箱不可用：stdio 服务器只能在沙箱中运行（请管理员启用沙箱驱动）";
		else if (!caps.services || !caps.mounts) blocked = "当前沙箱驱动不支持常驻服务或只读挂载";
		else if (p.registryType === "npm" || p.registryType === "pypi") {
			if (!caps.networkAllowed) blocked = `需要联网下载 ${p.registryType} 包：沙箱默认无网络（管理员需在沙箱设置中允许联网，并使用 Docker 驱动）`;
		} else if (p.registryType === "bundle") {
			if (!hasBundle) blocked = "这是离线包条目，但没有随附代码包（请用 .zip 导入）";
		} else blocked = `暂不支持 ${p.registryType} 类型的软件包（支持 npm、pypi 与离线 bundle）`;
		out.push({ index: out.length, kind: "package", label: `${p.registryType}：${p.identifier}${p.version ? `@${p.version}` : ""}`, transport: "stdio", registryType: p.registryType, identifier: p.identifier, inputs, blocked });
	}
	return out;
}

function checkServerJson(sj: ServerJson, bundle: PackageFile[] | null): PackageCheckDTO {
	const findings: PackageFindingDTO[] = [];
	const add = (severity: PackageFindingDTO["severity"], code: string, message: string) => findings.push({ severity, code, message });
	for (const r of sj.remotes ?? []) {
		let u: URL | null = null;
		try {
			u = new URL(r.url.replace(/\{[A-Za-z0-9_]+\}/g, "x"));
		} catch {
			/* validated earlier */
		}
		if (u && u.protocol !== "https:") add("warn", "remote_not_tls", `远程地址 ${u.origin} 不是 HTTPS：凭据与数据会以明文传输`);
		if (u && /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1)/.test(u.hostname)) add("warn", "remote_private", `远程地址 ${u.hostname} 是内网/本机地址`);
		if (r.type !== "streamable-http") add("warn", "unsupported_transport", `远程传输 ${r.type} 本平台暂不支持`);
		if ((r.headers ?? []).some((h) => h.isSecret !== true && /^(authorization|x-api-key|api-key|cookie)$/i.test(h.name))) add("warn", "secret_header_not_marked", "认证相关请求头没有标记 isSecret，可能被明文展示");
	}
	for (const p of sj.packages ?? []) {
		if (!["npm", "pypi", "bundle"].includes(p.registryType)) add("warn", "unsupported_package", `软件包类型 ${p.registryType} 本平台暂不支持运行`);
		if (p.registryType === "npm" || p.registryType === "pypi") add("warn", "needs_network", `${p.registryType} 包需要在沙箱内联网下载依赖`);
		if (!p.version && (p.registryType === "npm" || p.registryType === "pypi")) add("warn", "unpinned_package", `${p.identifier} 没有固定版本：每次启动可能拿到不同代码`);
		if ((p.environmentVariables ?? []).some((e) => e.isSecret !== true && /key|token|secret|password/i.test(e.name))) add("warn", "secret_env_not_marked", "疑似凭据的环境变量没有标记 isSecret");
	}
	if (!sj.repository?.url) add("info", "no_repository", "没有 repository 链接，审核员无法对照源码");
	if (bundle) {
		const sc = scanFiles(bundle);
		findings.push(...sc.findings);
	}
	return { ok: !findings.some((f) => f.severity === "error"), at: nowIso(), findings, stats: { fileCount: bundle?.length ?? 0, totalBytes: bundle?.reduce((n, f) => n + f.bytes.byteLength, 0) ?? 0, packageBytes: 0, scriptCount: 0 } };
}

export class McpMarket {
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
	get #mgr(): McpManager {
		return this.#ctx.services.get("mcp") as McpManager;
	}
	async caps(): Promise<SandboxCaps | null> {
		if (!this.#ctx.services.has("sandbox")) return null;
		const sb = this.#ctx.services.get("sandbox") as Sandbox;
		const c = await sb.capabilities().catch(() => null);
		return c ? { state: c.state, services: c.services, mounts: c.mounts, networkAllowed: c.network.allowed } : null;
	}

	row(id: string): CatalogRow | undefined {
		return this.#db.get<CatalogRow>("SELECT * FROM mcp_catalog WHERE id = ?", id);
	}
	version(id: string, no: number): CatVersionRow | undefined {
		return this.#db.get<CatVersionRow>("SELECT * FROM mcp_catalog_versions WHERE catalog_id = ? AND version_no = ?", id, no);
	}
	versions(id: string): CatVersionRow[] {
		return this.#db.all<CatVersionRow>("SELECT * FROM mcp_catalog_versions WHERE catalog_id = ? ORDER BY version_no DESC", id);
	}
	approved(versionId: string): boolean {
		return !!this.#db.get("SELECT 1 FROM mcp_catalog_publish WHERE version_id = ?", versionId);
	}

	// ------------------------------------------------------------ import
	/** Import a server.json (object or registry wrapper) or an offline bundle (.zip with server.json + code). New entry = personal draft. */
	async import(p: Principal, input: { serverJson?: unknown; zip?: Uint8Array; entryId?: string; changeNote?: string }): Promise<{ entry: CatalogRow; version: CatVersionRow; check: PackageCheckDTO }> {
		await this.#market.require(p, "mcp.connector.add_personal", undefined, "没有添加连接器的权限");
		if (this.#market.policy(p.orgId).personalMcp === "disabled") await this.#market.require(p, "mcp.connector.add_org", undefined, "组织策略不允许个人添加连接器");
		let sj: ServerJson;
		let files: PackageFile[] | null = null;
		if (input.zip) {
			let raw: { path: string; bytes: Uint8Array }[];
			try {
				raw = unzipPackage(input.zip);
				files = normalizeFiles(raw).files;
			} catch (e) {
				if (e instanceof PackageError) throw new HttpError(/too_large|too_many|zip_bomb/.test(e.code) ? 413 : 400, e.code, e.message);
				throw e;
			}
			const f = files.find((x) => x.path === "server.json");
			if (!f) throw new HttpError(400, "server_json_missing", "离线包的根目录需要 server.json");
			let parsed: unknown;
			try {
				parsed = JSON.parse(new TextDecoder().decode(f.bytes));
			} catch {
				throw new HttpError(400, "server_json_invalid", "server.json 不是有效的 JSON");
			}
			sj = parseServerJson(parsed);
			for (const pkg of sj.packages ?? []) if (pkg.registryType === "bundle") {
				try {
					const entry = safePath(pkg.identifier);
					if (!files.some((x) => x.path === entry)) throw new HttpError(400, "bundle_entry_missing", `离线包的入口 ${entry} 不在包内`);
				} catch (e) {
					if (e instanceof PackageError) throw new HttpError(400, e.code, e.message);
					throw e;
				}
			}
		} else sj = parseServerJson(input.serverJson);
		if (!files && (sj.packages ?? []).some((x) => x.registryType === "bundle") && !(sj.remotes ?? []).length && !(sj.packages ?? []).some((x) => x.registryType !== "bundle")) throw new HttpError(400, "bundle_files_missing", "registryType 为 bundle 的条目需要用 .zip 一起上传代码");
		const check = checkServerJson(sj, files);
		const errors = check.findings.filter((f) => f.severity === "error");
		if (errors.length) throw new HttpError(400, "scan_failed", `静态检查发现 ${errors.length} 个必须修复的问题：${errors.map((e) => e.message).join("；")}`, { findings: check.findings });
		const canonical = JSON.stringify(sj);
		const sha = sha256Hex(new TextEncoder().encode(canonical + (files ? files.map((f) => `\n${f.path}:${sha256Hex(f.bytes)}`).join("") : "")));
		let entry = input.entryId ? this.row(input.entryId) : this.#db.get<CatalogRow>("SELECT * FROM mcp_catalog WHERE org_id = ? AND name = ?", p.orgId, sj.name);
		if (entry && entry.org_id !== p.orgId) throw new HttpError(404, "not_found", "条目不存在");
		if (entry && entry.owner_user_id !== p.userId && !(await this.#canManage(p))) throw new HttpError(409, "name_taken", `名称「${sj.name}」已被他人占用；请使用你自己命名空间下的 name`);
		if (entry && entry.name !== sj.name) throw new HttpError(409, "name_mismatch", `server.json 的 name「${sj.name}」必须与已有条目「${entry.name}」一致`);
		const existing = entry ? this.versions(entry.id) : [];
		if (existing.some((v) => v.sha256 === sha)) throw new HttpError(409, "duplicate_content", "内容与已有版本完全相同");
		const dup = existing.find((v) => v.semver === sj.version);
		if (dup) throw new HttpError(409, "version_exists", `版本 ${sj.version} 已存在（v${dup.version_no}）；已发布的版本不可修改，请递增 version（Registry 同样不允许覆盖）`);
		let bundleSha: string | null = null;
		let fileRows: string | null = null;
		if (files) {
			const zip = buildCanonicalZip(files);
			bundleSha = this.#ctx.blobs.put(zip).sha256;
			fileRows = JSON.stringify(files.map((f) => ({ path: f.path, ...this.#ctx.blobs.put(f.bytes) })));
		}
		const now = nowIso();
		const meta = (sj._meta ?? {}) as Record<string, any>;
		const id = this.#db.tx(() => {
			let cid = entry?.id;
			let no = 1;
			if (!cid) {
				cid = newId("mcc");
				this.#db.run("INSERT INTO mcp_catalog (id, org_id, name, slug, title, description, scope, owner_user_id, category, tags, latest_version_no, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'personal', ?, ?, ?, 1, ?, ?)", cid, p.orgId, sj.name, slugOfName(sj.name), sj.title ?? sj.name.split("/")[1]!, sj.description.slice(0, 1000), p.userId, asStr(meta.category, 40) ?? null, JSON.stringify(Array.isArray(meta.tags) ? meta.tags.slice(0, 12).map(String) : []), now, now);
			} else {
				no = entry!.latest_version_no + 1;
				this.#db.run("UPDATE mcp_catalog SET latest_version_no = ?, title = ?, description = ?, updated_at = ? WHERE id = ?", no, sj.title ?? entry!.title, sj.description.slice(0, 1000), now, cid);
			}
			this.#db.run("INSERT INTO mcp_catalog_versions (id, catalog_id, version_no, semver, server_json, sha256, bundle_sha256, files, checks, change_note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", newId("mcv"), cid, no, sj.version, canonical, sha, bundleSha, fileRows, JSON.stringify(check), input.changeNote?.slice(0, 500) ?? (no === 1 ? "初版" : null), p.userId, now);
			return cid;
		});
		entry = this.row(id)!;
		this.#market.audit(p, "mcp.catalog.import", id, { name: sj.name, version: sj.version, bundle: !!files, warnings: check.findings.filter((f) => f.severity === "warn").length });
		return { entry, version: this.version(id, entry.latest_version_no)!, check };
	}
	async #canManage(p: Principal): Promise<boolean> {
		return this.#market.can(p, "mcp.connector.review", { kind: "org" });
	}

	// ------------------------------------------------------------ submissions
	async submit(p: Principal, id: string, versionNo: number, input: { targetScope: MarketScope; targetRef?: string; note?: string }) {
		const e = this.row(id);
		if (!e || e.org_id !== p.orgId) throw new HttpError(404, "not_found", "条目不存在");
		if (e.owner_user_id !== p.userId && !(await this.#canManage(p))) throw new HttpError(403, "forbidden", "只有条目的作者或市场管理员可以提交审核");
		const v = this.version(id, versionNo);
		if (!v) throw new HttpError(404, "version_not_found", "版本不存在");
		const t = input.targetScope;
		if (t === "org") await this.#market.require(p, "mcp.connector.add_org", { kind: "org" }, "没有向组织发布连接器的权限（mcp.connector.add_org）");
		else if (t === "department" && input.targetRef) await this.#market.require(p, "mcp.connector.add_org", { kind: "department", id: input.targetRef }, "没有向该部门发布连接器的权限");
		else if (t === "project" && input.targetRef) {
			const space = this.#ctx.services.get("identity").projectSpace(input.targetRef);
			if (!space || space.orgId !== p.orgId) throw new HttpError(404, "project_not_found", "项目不存在");
			await this.#ctx.services.get("acl").require(p, "write", { kind: "space", id: space.id });
		} else throw new HttpError(400, "invalid", "targetScope 必须是 org、department 或 project（部门/项目需要 targetRef）");
		const checks: PackageCheckDTO = JSON.parse(v.checks);
		const subId = this.#market.openSubmission(p, { kind: "mcp_catalog", subjectId: id, subjectName: e.title, versionId: v.id, versionNo, target: t, ref: input.targetRef ?? null, note: input.note, checks });
		return this.#market.submissionDTO(p, subId);
	}
	/** Admin direct publish of a catalog version (audited as forced; reason mandatory). */
	async forcePublish(p: Principal, id: string, versionNo: number, reason: string, target: { scope?: MarketScope; ref?: string } = {}) {
		await this.#market.require(p, "mcp.connector.review", { kind: "org" }, "只有 MCP 市场管理员可以强制发布");
		if (!reason?.trim()) throw new HttpError(400, "reason_required", "强制发布必须填写理由");
		const e = this.row(id);
		const v = e ? this.version(id, versionNo) : undefined;
		if (!e || !v || e.org_id !== p.orgId) throw new HttpError(404, "not_found", "条目或版本不存在");
		const scope = target.scope ?? "org";
		const subId = this.#market.directApproveOther(p, { kind: "mcp_catalog", subjectId: id, subjectName: e.title, versionId: v.id, versionNo, target: scope, ref: scope === "org" ? null : (target.ref ?? null), note: `强制发布：${reason.trim()}`, checks: JSON.parse(v.checks) });
		this.#market.audit(p, "mcp.force_publish", id, { versionNo, reason });
		return this.#market.submissionDTO(p, subId);
	}
	async unpublish(p: Principal, id: string, reason: string): Promise<void> {
		await this.#market.require(p, "mcp.connector.review", { kind: "org" }, "只有 MCP 市场管理员可以下架");
		if (!reason?.trim()) throw new HttpError(400, "reason_required", "下架必须填写理由");
		const e = this.row(id);
		if (!e || e.org_id !== p.orgId) throw new HttpError(404, "not_found", "条目不存在");
		this.#db.run("UPDATE mcp_catalog SET listed = 0, updated_at = ? WHERE id = ?", nowIso(), id);
		this.#market.audit(p, "mcp.unpublish", id, { reason });
	}

	/** Hooks called by Market when a submission of an MCP kind is decided. */
	onPublished(sub: SubRow, _actor: { userId: string }): void {
		if (sub.kind === "mcp_catalog") {
			const v = this.#db.get<CatVersionRow>("SELECT * FROM mcp_catalog_versions WHERE id = ?", sub.version_id!)!;
			this.#db.run("INSERT INTO mcp_catalog_publish (version_id, catalog_id, version_no, approved_at, submission_id, forced) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(version_id) DO NOTHING", v.id, v.catalog_id, v.version_no, nowIso(), sub.id, sub.forced);
			this.#db.run("UPDATE mcp_catalog SET scope = ?, scope_ref = ?, published_version_no = MAX(COALESCE(published_version_no, 0), ?), listed = 1, updated_at = ? WHERE id = ?", sub.target_scope, sub.target_scope === "org" ? null : sub.target_ref, v.version_no, nowIso(), v.catalog_id);
		} else {
			const row = this.#mgr.row(sub.subject_id);
			if (row && row.approval_state !== "approved") {
				this.#db.run("UPDATE mcp_servers SET approval_state = 'approved', status = 'unchecked', status_detail = NULL, updated_at = ? WHERE id = ?", nowIso(), row.id);
				void this.#mgr.check(row.id, row.owner_user_id ?? undefined).catch(() => {});
			}
		}
	}
	onDecision(sub: SubRow, to: SubmissionState): void {
		if (sub.kind !== "mcp_connector") return;
		if (to === "rejected" || to === "withdrawn") this.#db.run("UPDATE mcp_servers SET approval_state = 'rejected', status_detail = ?, updated_at = ? WHERE id = ? AND approval_state = 'pending'", to === "rejected" ? "未通过审核" : "已撤回审核申请", nowIso(), sub.subject_id);
	}

	/** Personal connector that needs approval: open the submission (reviewers see URL / command and the secret NAMES, never values). */
	async requestConnectorApproval(p: Principal, row: McpServerRow): Promise<string> {
		const findings: PackageFindingDTO[] = [];
		if (row.transport === "http" && row.url && !row.url.startsWith("https://")) findings.push({ severity: "warn", code: "remote_not_tls", message: "连接地址不是 HTTPS" });
		if (row.exec_mode === "sandbox") findings.push({ severity: "info", code: "sandbox_stdio", message: "stdio 服务器将在沙箱中运行" });
		const checks: PackageCheckDTO = { ok: true, at: nowIso(), findings, stats: { fileCount: 0, totalBytes: 0, packageBytes: 0, scriptCount: 0 } };
		return this.#market.openSubmission(p, { kind: "mcp_connector", subjectId: row.id, subjectName: row.name, target: "personal", note: `个人连接器：${row.name}`, checks });
	}

	submissionInfo(sub: SubRow): Partial<SubmissionDetailDTO> {
		const empty = { files: [], permissionDelta: { added: [], removed: [] }, diff: [] as SubmissionDetailDTO["diff"] };
		if (sub.kind === "mcp_connector") {
			const r = this.#mgr.row(sub.subject_id);
			const info: McpSubmissionInfoDTO = { name: r?.name ?? sub.subject_name, transport: r?.transport ?? "http", url: r?.url ?? undefined, command: r?.command ?? undefined, secretNames: r ? JSON.parse(r.secret_names) : [], execMode: r?.exec_mode };
			return { ...empty, mcp: info, checks: sub.checks ? JSON.parse(sub.checks) : undefined };
		}
		const v = this.#db.get<CatVersionRow>("SELECT * FROM mcp_catalog_versions WHERE id = ?", sub.version_id!)!;
		const sj = JSON.parse(v.server_json) as ServerJson;
		const first = [...(sj.remotes ?? []), ...(sj.packages ?? [])][0];
		const secretNames = [...(sj.remotes ?? []).flatMap((r) => (r.headers ?? []).filter((h) => h.isSecret)).map((h) => h.name), ...(sj.packages ?? []).flatMap((p) => (p.environmentVariables ?? []).filter((e) => e.isSecret)).map((e) => e.name)];
		const files = v.files ? (JSON.parse(v.files) as { path: string; size: number; sha256: string }[]) : [];
		const prev = this.#db.get<CatVersionRow>("SELECT v.* FROM mcp_catalog_versions v WHERE v.catalog_id = ? AND v.version_no < ? ORDER BY v.version_no DESC LIMIT 1", v.catalog_id, v.version_no);
		const info: McpSubmissionInfoDTO = { name: sj.name, transport: sj.remotes?.length ? "http" : "stdio", url: sj.remotes?.[0]?.url, command: first && "identifier" in first ? `${first.registryType}:${first.identifier}` : undefined, secretNames, execMode: sj.remotes?.length ? undefined : "sandbox" };
		// The diff between two server.json documents (pretty-printed) so a reviewer sees exactly what changed.
		const diff: Mutable<SubmissionDetailDTO["diff"]> = [];
		if (prev) {
			const a = JSON.stringify(JSON.parse(prev.server_json), null, 2).split("\n");
			const b = JSON.stringify(sj, null, 2).split("\n");
			const lines: { t: " " | "+" | "-"; s: string }[] = [];
			const setA = new Set(a);
			const setB = new Set(b);
			for (const l of a) if (!setB.has(l)) lines.push({ t: "-", s: l });
			for (const l of b) if (!setA.has(l)) lines.push({ t: "+", s: l });
			diff.push({ path: "server.json", status: lines.length ? "modified" : "unchanged", added: lines.filter((l) => l.t === "+").length, removed: lines.filter((l) => l.t === "-").length, hunks: lines.length ? [{ oldStart: 1, newStart: 1, lines }] : undefined });
		} else diff.push({ path: "server.json", status: "added", added: JSON.stringify(sj, null, 2).split("\n").length });
		return { ...empty, files: [{ path: "server.json", size: v.server_json.length, sha256: v.sha256 }, ...files], diff, mcp: info, checks: JSON.parse(v.checks), previousVersionNo: prev?.version_no };
	}

	// ------------------------------------------------------------ listing
	async #visible(p: Principal): Promise<CatalogRow[]> {
		const rows = this.#db.all<CatalogRow>("SELECT * FROM mcp_catalog WHERE org_id = ? AND status = 'active' ORDER BY updated_at DESC", p.orgId);
		const projects = new Set((await this.#ctx.services.get("acl").readableSpaces(p)).map((x) => x.projectId).filter(Boolean));
		return rows.filter((r) => r.owner_user_id === p.userId || (r.listed === 1 && (r.scope === "org" || (r.scope === "department" && !!r.scope_ref && p.departmentIds.includes(r.scope_ref)) || (r.scope === "project" && !!r.scope_ref && projects.has(r.scope_ref)))));
	}
	#installCount(catalogId: string): number {
		return this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM mcp_servers WHERE deleted_at IS NULL AND catalog_version_id IN (SELECT id FROM mcp_catalog_versions WHERE catalog_id = ?)", catalogId)!.n;
	}
	#summary(p: Principal, r: CatalogRow): McpCatalogSummaryDTO {
		const v = (r.published_version_no ? this.version(r.id, r.published_version_no) : undefined) ?? this.version(r.id, r.latest_version_no);
		const sj = v ? (JSON.parse(v.server_json) as ServerJson) : undefined;
		const pending = this.#db.get("SELECT 1 FROM market_submissions WHERE kind = 'mcp_catalog' AND subject_id = ? AND state = 'pending_review'", r.id);
		return {
			id: r.id,
			name: r.name,
			title: r.title,
			description: r.description,
			scope: r.scope,
			category: r.category ?? undefined,
			tags: JSON.parse(r.tags || "[]"),
			version: v?.semver,
			versionNo: r.published_version_no ?? undefined,
			transports: [...new Set<"http" | "stdio">([...(sj?.remotes ?? []).map(() => "http" as const), ...(sj?.packages ?? []).map(() => "stdio" as const)])],
			installCount: this.#installCount(r.id),
			listed: r.listed === 1,
			ownerUserId: r.owner_user_id,
			updatedAt: r.updated_at,
			installed: !!this.#db.get("SELECT 1 FROM mcp_servers WHERE deleted_at IS NULL AND org_id = ? AND catalog_version_id IN (SELECT id FROM mcp_catalog_versions WHERE catalog_id = ?) AND (scope = 'system' OR owner_user_id = ?)", p.orgId, r.id, p.userId),
			status: r.listed ? "published" : pending ? "pending_review" : r.published_version_no ? "unpublished" : "draft",
		};
	}
	async list(p: Principal, q: { q?: string; mine?: string; category?: string }): Promise<McpCatalogSummaryDTO[]> {
		let rows = await this.#visible(p);
		rows = q.mine === "1" ? rows.filter((r) => r.owner_user_id === p.userId) : rows.filter((r) => r.listed === 1);
		if (q.category) rows = rows.filter((r) => r.category === q.category);
		let out = rows.map((r) => this.#summary(p, r));
		const needle = q.q?.trim().toLowerCase();
		if (needle) out = out.filter((x) => needle.split(/\s+/).every((w) => `${x.name} ${x.title} ${x.description} ${x.tags.join(" ")} ${x.category ?? ""}`.toLowerCase().includes(w)));
		return out.sort((a, b) => b.installCount - a.installCount || (a.updatedAt < b.updatedAt ? 1 : -1));
	}
	async detail(p: Principal, id: string, versionNo?: number): Promise<McpCatalogDetailDTO> {
		const r = this.row(id);
		if (!r || r.org_id !== p.orgId) throw new HttpError(404, "not_found", "条目不存在");
		const visible = (await this.#visible(p)).some((x) => x.id === id);
		const reviewer = !visible && (await this.#hasReviewOpen(p, r));
		if (!visible && !reviewer) throw new HttpError(403, "forbidden", "无权查看该条目");
		const manage = r.owner_user_id === p.userId || (await this.#canManage(p));
		const no = versionNo ?? r.published_version_no ?? r.latest_version_no;
		const v = this.version(id, no);
		if (!v) throw new HttpError(404, "version_not_found", "版本不存在");
		if (!manage && !reviewer && !this.approved(v.id)) throw new HttpError(403, "forbidden", "该版本尚未发布");
		const sj = JSON.parse(v.server_json) as ServerJson;
		return {
			...this.#summary(p, r),
			serverJson: sj,
			options: installOptions(sj, await this.caps(), !!v.bundle_sha256),
			versions: this.versions(id).filter((x) => manage || this.approved(x.id)).map((x) => ({ versionNo: x.version_no, semver: x.semver, createdAt: x.created_at, approved: this.approved(x.id), changeNote: x.change_note ?? undefined })),
			canManage: manage,
			canSubmit: manage,
			latestVersionNo: manage ? r.latest_version_no : (r.published_version_no ?? 0),
		};
	}
	async #hasReviewOpen(p: Principal, r: CatalogRow): Promise<boolean> {
		for (const sub of this.#db.all<SubRow>("SELECT * FROM market_submissions WHERE kind = 'mcp_catalog' AND subject_id = ?", r.id)) if (await this.#market.reviewScopeAllows(p, sub)) return true;
		return false;
	}

	// ------------------------------------------------------------ install
	/**
	 * Install an entry as a connector. `me` = personal connector (subject to the personal-MCP policy: free / approval / disabled);
	 * `org` = system connector for everyone (needs mcp.connector.add_org, entry must be published org-wide).
	 * stdio packages become sandbox connectors; remotes become HTTP connectors. Secrets are encrypted (shared) or collected per user.
	 */
	async install(p: Principal, id: string, input: { target: "me" | "org"; optionIndex: number; versionNo?: number; name?: string; variables?: Record<string, string>; secrets?: Record<string, string>; credentialMode?: "shared" | "per_user"; access?: "members" | "admins"; toolPolicies?: Record<string, "read" | "write" | "disabled"> }): Promise<{ connector: McpServerRow; submissionId?: string }> {
		const e = this.row(id);
		if (!e || e.org_id !== p.orgId) throw new HttpError(404, "not_found", "条目不存在");
		const visible = (await this.#visible(p)).some((x) => x.id === id);
		if (!visible) throw new HttpError(403, "forbidden", "无权使用该条目");
		const v = this.version(id, input.versionNo ?? e.published_version_no ?? e.latest_version_no);
		if (!v) throw new HttpError(404, "version_not_found", "版本不存在");
		const own = e.owner_user_id === p.userId;
		if (!this.approved(v.id) && !(own && input.target === "me")) throw new HttpError(409, "not_approved", "该版本尚未通过审核，只有作者可以安装到自己名下试用");
		const sj = JSON.parse(v.server_json) as ServerJson;
		const opts = installOptions(sj, await this.caps(), !!v.bundle_sha256);
		const opt = opts[input.optionIndex];
		if (!opt) throw new HttpError(400, "invalid", "optionIndex 无效");
		if (opt.blocked) throw new HttpError(409, "option_blocked", opt.blocked);
		const policy = this.#market.policy(p.orgId);
		let scope: "personal" | "system";
		if (input.target === "org") {
			await this.#market.require(p, "mcp.connector.add_org", undefined, "没有添加组织连接器的权限（mcp.connector.add_org）");
			if (e.scope !== "org" || !e.listed) throw new HttpError(409, "not_published", "只有已发布到整个组织的条目才能安装为组织连接");
			scope = "system";
		} else {
			await this.#market.require(p, "mcp.connector.add_personal", undefined, "没有添加个人连接器的权限");
			if (policy.personalMcp === "disabled") throw new HttpError(403, "policy_disabled", "组织策略不允许添加个人连接器");
			scope = "personal";
		}
		const perUser = input.credentialMode === "per_user" && scope === "system";
		const secrets: Record<string, string> = {};
		const env: Record<string, string> = {};
		const variables = input.variables ?? {};
		for (const inp of opt.inputs) {
			if (inp.where === "variable") continue; // URL template variables are substituted below
			const val = input.secrets?.[inp.name] ?? variables[inp.name];
			if (inp.secret || inp.where === "header") {
				if (perUser && inp.secret) continue; // every user supplies their own later
				if (val) secrets[inp.name] = String(val);
				else if (inp.required) throw new HttpError(400, "secret_required", `需要填写 ${inp.name}`);
			} else if (val) env[inp.name] = String(val);
			else if (inp.required) throw new HttpError(400, "input_required", `需要填写 ${inp.name}`);
		}
		const secretNames = opt.inputs.filter((i) => i.secret && i.where !== "variable").map((i) => i.name);
		const name = (input.name?.trim() || e.title).slice(0, 80);
		let row: McpServerRow;
		if (opt.kind === "remote") {
			const r = sj.remotes![opt.index]!;
			let url = r.url;
			for (const [k, def] of Object.entries(r.variables ?? {})) {
				const val = variables[k] ?? input.secrets?.[k] ?? def.default;
				if (def.isRequired && !val) throw new HttpError(400, "input_required", `需要填写 URL 变量 ${k}`);
				url = url.replaceAll(`{${k}}`, encodeURIComponent(String(val ?? "")));
			}
			if (/\{[A-Za-z0-9_]+\}/.test(url)) throw new HttpError(400, "input_required", "URL 中还有未填写的变量");
			row = this.#mgr.create(p, { name, scope, transport: "http", url, secrets: perUser ? undefined : secrets, access: input.access, toolPolicies: input.toolPolicies }, { approval: scope === "personal" && policy.personalMcp === "approval" ? "pending" : "approved", credentialMode: perUser ? "per_user" : "shared", requiredSecretNames: secretNames, catalogVersionId: v.id });
		} else {
			const pkg = sj.packages!.find((x) => `${x.registryType}:${x.identifier}` === `${opt.registryType}:${opt.identifier}`)!;
			const argsOf = (list: typeof pkg.packageArguments) => (list ?? []).flatMap((a) => (a.value !== undefined ? (a.type === "named" && a.name ? [a.name, a.value] : [a.value]) : []));
			let sandbox: SandboxPackage;
			if (pkg.registryType === "npm") sandbox = { runtime: "node", argv: ["npx", "-y", `${pkg.identifier}${pkg.version ? `@${pkg.version}` : ""}`, ...argsOf(pkg.packageArguments)], network: true };
			else if (pkg.registryType === "pypi") sandbox = { runtime: "python", argv: ["uvx", `${pkg.identifier}${pkg.version ? `==${pkg.version}` : ""}`, ...argsOf(pkg.packageArguments)], network: true };
			else {
				const runtime = pkg.runtimeHint === "python" ? "python" : pkg.runtimeHint === "shell" ? "shell" : "node";
				sandbox = { runtime, argv: [runtime === "python" ? "python3" : runtime === "shell" ? "sh" : "node", `\${MCP_DIR}/${safePath(pkg.identifier)}`, ...argsOf(pkg.packageArguments)], bundleVersionId: v.id, network: false };
			}
			row = this.#mgr.create(p, { name, scope, transport: "stdio", secrets: perUser ? undefined : secrets, env, access: input.access, toolPolicies: input.toolPolicies }, { approval: scope === "personal" && policy.personalMcp === "approval" ? "pending" : "approved", sandbox, credentialMode: perUser ? "per_user" : "shared", requiredSecretNames: secretNames, catalogVersionId: v.id });
		}
		let submissionId: string | undefined;
		if (row.approval_state === "pending") submissionId = await this.requestConnectorApproval(p, row);
		else if (!perUser) await this.#mgr.check(row.id, p.userId);
		this.#market.audit(p, "mcp.install", row.id, { catalogId: id, version: v.semver, target: input.target, option: opt.label, approval: row.approval_state, perUser });
		return { connector: this.#mgr.row(row.id)!, submissionId };
	}

	/** A file of an offline bundle (code review). Visible to the author, market managers, reviewers of an open submission, and — once approved — anyone who can see the entry. */
	async readFile(p: Principal, id: string, versionNo: number, path: string): Promise<{ path: string; size: number; text: string | null; binary: boolean; truncated: boolean }> {
		const e = this.row(id);
		const v = e ? this.version(id, versionNo) : undefined;
		if (!e || !v || e.org_id !== p.orgId) throw new HttpError(404, "not_found", "版本不存在");
		const own = e.owner_user_id === p.userId || (await this.#canManage(p));
		const visible = (await this.#visible(p)).some((x) => x.id === id) && this.approved(v.id);
		if (!own && !visible && !(await this.#hasReviewOpen(p, e))) throw new HttpError(403, "forbidden", "无权查看该版本");
		if (path === "server.json") return { path, size: v.server_json.length, text: JSON.stringify(JSON.parse(v.server_json), null, 2), binary: false, truncated: false };
		const f = (JSON.parse(v.files ?? "[]") as { path: string; sha256: string; size: number }[]).find((x) => x.path === path);
		if (!f) throw new HttpError(404, "file_not_found", "文件不在包内");
		const bytes = this.#ctx.blobs.get(f.sha256);
		if (!bytes) throw new HttpError(500, "blob_missing", "文件内容缺失");
		let text: string | null = null;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, 200_000));
		} catch {
			text = null;
		}
		return { path, size: f.size, text, binary: text === null, truncated: bytes.byteLength > 200_000 };
	}

	// ------------------------------------------------------------ bundles (read-only materialisation)
	materializeBundle(versionId: string): { dir: string; slug: string } {
		const v = this.#db.get<CatVersionRow>("SELECT * FROM mcp_catalog_versions WHERE id = ?", versionId);
		if (!v?.files || !v.bundle_sha256) throw new Error("该连接没有随附代码包");
		const entry = this.row(v.catalog_id)!;
		const slug = slugOfName(entry.name).slice(0, 40);
		const sb = this.#ctx.services.has("sandbox") ? (this.#ctx.services.get("sandbox") as Sandbox) : null;
		const root = sb ? sb.mountsRoot() : join(this.#ctx.config.dataDir, "sandbox-mounts");
		const dir = join(root, "mcp", `${slug}-${v.bundle_sha256.slice(0, 16)}`);
		if (existsSync(dir)) return { dir, slug };
		const tmp = `${dir}.tmp-${process.pid}-${Date.now().toString(36)}`;
		mkdirSync(tmp, { recursive: true });
		try {
			const dirs = new Set<string>([tmp]);
			for (const f of JSON.parse(v.files) as { path: string; sha256: string }[]) {
				const bytes = this.#ctx.blobs.get(f.sha256);
				if (!bytes) throw new Error(`代码包文件缺失：${f.path}`);
				const target = join(tmp, f.path);
				mkdirSync(dirname(target), { recursive: true });
				for (let d = dirname(target); d.length > tmp.length; d = dirname(d)) dirs.add(d);
				writeFileSync(target, bytes);
				chmodSync(target, 0o555);
			}
			for (const d of [...dirs].sort((a, b) => b.length - a.length)) chmodSync(d, 0o555);
			try {
				renameSync(tmp, dir);
			} catch (e) {
				if (!existsSync(dir)) throw e;
				chmodSync(tmp, 0o755);
				rmSync(tmp, { recursive: true, force: true });
			}
		} catch (e) {
			chmodSync(tmp, 0o755);
			rmSync(tmp, { recursive: true, force: true });
			throw e;
		}
		return { dir, slug };
	}
}
