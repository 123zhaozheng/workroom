// Round 7b (group V): sandbox environment variables, four scopes (org / project / user / conversation), resolved at EVERY new command.
//
// Security model (read before changing anything). This is a GUARDRAIL, not a guarantee:
//  * Variables are NON-secret configuration (LANG, TZ, FEATURE_FLAG ...). Secrets belong to the credential feature. Values that look like
//    secrets are refused (best effort heuristics: they will miss some secrets and may refuse some harmless values).
//  * Names that change how the dynamic loader / language runtimes / TLS / proxies / git-ssh behave, or that the platform itself owns
//    (WORKROOM_*, SKILL_*, OPENSANDBOX_*, E2B_*, DAYTONA_*), are refused server-side, at write time AND again at resolve time (rows
//    written before a rule existed are dropped and reported in `denied`). Sandbox code can of course set its own environment inside its
//    own process; the deny list only protects what the platform injects.
//  * TMPDIR/TMP/TEMP/PWD/OLDPWD/LOGNAME are denied (path redirection / identity spoofing); LANG, LC_* and TZ are allowed.
//  * Audit rows carry action, scope, scopeRef, name and a 12 hex prefix of sha256(value) (to show that a value changed) - never the value.
//    The hash of a low-entropy value can be guessed; that is acceptable because values are declared non-secret.
//  * Effect timing: values are read at each Sandbox.run / service start. Running processes and running services keep the environment they
//    started with (`appliesToNewCommandsOnly: true`).
import { createHash } from "node:crypto";
import type { AppContext, Principal, Space } from "../../core/contracts.ts";
import type { Migration } from "../../core/db.ts";
import { HttpError, newId, nowIso } from "../../core/http.ts";
import type { EffectiveEnvDTO, EnvScope, EnvVarDTO } from "../../../../shared/workspace-safety.ts";

/** Exported; the integrator wires these into toolsModule.migrations with version offset +1100. */
export const ENV_MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "sandbox environment variables",
		sql: `
CREATE TABLE sandbox_env_vars (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, scope TEXT NOT NULL, scope_ref TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (org_id, scope, scope_ref, name)
);
CREATE INDEX sandbox_env_vars_ref ON sandbox_env_vars (org_id, scope, scope_ref);`,
	},
];

export const SCOPES: readonly EnvScope[] = ["org", "project", "user", "conversation"];
export const MAX_VARS_PER_SCOPE = 100;
export const MAX_VALUE_LENGTH = 4096;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SECRET_HINT = "请使用凭据功能保存密钥";

// ───────────────────────────── name deny list ─────────────────────────────
const RUNTIME_HOOKS = new Set([
	"PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME", "PYTHONINSPECT", "PYTHONUSERBASE", "PYTHONBREAKPOINT", "PYTHONHTTPSVERIFY", "PYTHONEXECUTABLE",
	"NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_REPL_HISTORY",
	"PERL5OPT", "PERL5LIB", "PERLLIB", "RUBYOPT", "RUBYLIB", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "CLASSPATH",
	"BASH_ENV", "ENV", "PROMPT_COMMAND", "SHELLOPTS", "BASHOPTS", "IFS", "PS4", "GCONV_PATH", "LOCPATH", "NLSPATH", "HOSTALIASES", "RES_OPTIONS", "LOCALDOMAIN", "GLIBC_TUNABLES",
	"OPENSSL_CONF", "OPENSSL_MODULES",
]);
const IDENTITY_AND_PATHS = new Set(["PATH", "HOME", "SHELL", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "PWD", "OLDPWD", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]);
const TLS_AND_TRUST = new Set(["SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "CURL_HOME", "PIP_CERT", "PIP_CONFIG_FILE", "WGETRC", "CARGO_HTTP_CAINFO"]);
const GIT_SSH = new Set(["GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS", "SSH_AUTH_SOCK", "GIT_EXEC_PATH", "GIT_PROXY_COMMAND", "GIT_TEMPLATE_DIR", "GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_EDITOR", "EDITOR", "VISUAL", "PAGER"]);
const PREFIXES: readonly (readonly [prefix: string, reason: string])[] = [
	["LD_", "动态链接器变量（LD_*）可注入任意代码，不允许设置"],
	["DYLD_", "动态链接器变量（DYLD_*）可注入任意代码，不允许设置"],
	["MALLOC_", "内存分配器调试变量（MALLOC_*）会改变进程行为，不允许设置"],
	["BASH_FUNC_", "Shell 函数导入变量（BASH_FUNC_*）可注入代码，不允许设置"],
	["GIT_CONFIG", "Git 配置注入变量（GIT_CONFIG*）可执行任意命令，不允许设置"],
	["NPM_CONFIG_", "npm 配置变量（NPM_CONFIG_*）可重定向仓库或注入脚本，不允许设置"],
	["SSL_", "TLS 信任变量（SSL_*）会改变证书校验，不允许设置"],
	["WORKROOM_", "WORKROOM_* 是平台保留前缀，不允许设置"],
	["SKILL_", "SKILL_* 是平台保留前缀，不允许设置"],
	["OPENSANDBOX_", "OPENSANDBOX_* 是平台保留前缀，不允许设置"],
	["E2B_", "E2B_* 是平台保留前缀，不允许设置"],
	["DAYTONA_", "DAYTONA_* 是平台保留前缀，不允许设置"],
];

/** Plain reason when `name` must not be set as an ordinary sandbox variable; null when allowed (format is checked separately). */
export function denyReason(name: string): string | null {
	const u = name.toUpperCase();
	if (RUNTIME_HOOKS.has(u)) return `${name} 会改变解释器/运行时/Shell 的加载行为，不允许设置`;
	if (IDENTITY_AND_PATHS.has(u)) return `${name} 由平台控制（路径与身份），不允许设置`;
	if (u === "PROXY" || u.endsWith("_PROXY")) return `${name} 是代理变量：沙箱出口由组织网络策略统一管理，不允许设置`;
	if (TLS_AND_TRUST.has(u)) return `${name} 会改变证书校验或信任链，不允许设置`;
	if (GIT_SSH.has(u)) return `${name} 可指定要执行的程序或凭据通道，不允许设置`;
	for (const [prefix, reason] of PREFIXES) if (u.startsWith(prefix)) return reason;
	return null;
}

// ───────────────────────────── value heuristics ─────────────────────────────
function entropy(s: string): number {
	const freq = new Map<string, number>();
	for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
	let h = 0;
	for (const n of freq.values()) h -= (n / s.length) * Math.log2(n / s.length);
	return h;
}
/** True when the value looks like a key/token/private material. Heuristic: expect misses and the occasional false positive. */
export function looksLikeSecret(value: string): boolean {
	if (/-----BEGIN [A-Z0-9 ]*(PRIVATE KEY|CERTIFICATE|PGP)/.test(value)) return true;
	if (/(^|[^A-Za-z0-9])(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|ghu_[A-Za-z0-9]{8,}|ghs_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|AIza[A-Za-z0-9_-]{20,})/.test(value)) return true;
	if (/(^|[^A-Za-z0-9])(AKIA|ASIA)[A-Z0-9]{16}($|[^A-Za-z0-9])/.test(value)) return true;
	if (/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/.test(value)) return true;
	if (/\/\/[^\s/:@]+:[^\s/@]+@/.test(value)) return true; // scheme://user:password@host
	for (const seg of value.match(/[A-Za-z0-9+=_-]{32,}/g) ?? []) {
		const hex = /^[0-9a-fA-F]+$/.test(seg);
		const classes = Number(/[a-z]/.test(seg)) + Number(/[A-Z]/.test(seg)) + Number(/[0-9]/.test(seg));
		if (entropy(seg) >= 3.5 && (hex || classes >= 3)) return true;
	}
	return false;
}

/** Validate a candidate variable. Returns a plain refusal reason, or null when acceptable. `credentialName` is the C-group hook. */
export function validateVar(name: unknown, value: unknown, isCredentialName: () => boolean = () => false): string | null {
	if (typeof name !== "string" || !NAME_RE.test(name)) return "变量名只能由字母、数字和下划线组成，不能以数字开头，最长 64 个字符";
	const d = denyReason(name);
	if (d) return d;
	if (isCredentialName()) return `${name} 已被凭据功能占用，请通过凭据功能管理，不能作为普通变量设置`;
	if (typeof value !== "string") return "变量值必须是字符串";
	if (value.length > MAX_VALUE_LENGTH) return `变量值不能超过 ${MAX_VALUE_LENGTH} 个字符`;
	if (value.includes("\0")) return "变量值不能包含 NUL 字符";
	if (looksLikeSecret(value)) return SECRET_HINT;
	return null;
}

interface Row {
	id: string;
	org_id: string;
	scope: string;
	scope_ref: string;
	name: string;
	value: string;
	locked: number;
	updated_by: string;
	updated_at: string;
}
const dto = (r: Row): EnvVarDTO => ({ id: r.id, scope: r.scope as EnvScope, scopeRef: r.scope_ref, name: r.name, value: r.value, locked: r.locked === 1, updatedBy: r.updated_by, updatedAt: r.updated_at });
const sha = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 12);

export interface ResolvedEnv {
	readonly env: Record<string, string>;
	readonly effective: EffectiveEnvDTO;
}

export class SandboxEnvVars {
	readonly #ctx: AppContext;
	/**
	 * Hook for the credentials group: true when `name` is registered as a credential env name in this org. Such names are refused as ordinary
	 * variables and dropped at resolve time. Default: false (integrator/C replaces it, e.g. `svc.isCredentialEnvName = (o, n) => creds.hasEnvName(o, n)`).
	 */
	isCredentialEnvName: (orgId: string, name: string) => boolean = () => false;

	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}

	// ---------- scope authorization ----------
	async #hasPerm(p: Principal, perm: string, scope?: { kind: "project"; id: string }): Promise<boolean> {
		if (!this.#ctx.services.has("authz")) return p.orgRole === "owner" || p.orgRole === "admin";
		try {
			return await this.#ctx.services.get("authz").has(p, perm, scope as never);
		} catch {
			return false;
		}
	}
	async #aclAllows(p: Principal, action: "read" | "write", kind: "project" | "space", id: string): Promise<boolean> {
		const d = await this.#ctx.services.get("acl").check(p, action, { kind, id } as never);
		return d.allow;
	}

	/**
	 * Validate scope + scopeRef and authorize. Cross-org or missing targets are 404; same-org without permission is 403.
	 * Returns the canonical scopeRef.
	 */
	async authorize(p: Principal, scope: string, scopeRef: string, mode: "read" | "write"): Promise<{ scope: EnvScope; scopeRef: string }> {
		if (!(SCOPES as readonly string[]).includes(scope)) throw new HttpError(400, "invalid_scope", "scope 必须是 org / project / user / conversation");
		const s = scope as EnvScope;
		const notFound = (what: string) => new HttpError(404, "not_found", `${what}不存在`);
		const identity = this.#ctx.services.get("identity");
		if (s === "org") {
			if (scopeRef !== p.orgId) throw notFound("组织");
			if (!(await this.#hasPerm(p, "sandbox.policy.manage"))) throw new HttpError(403, "forbidden", "没有权限：管理沙箱与工具策略（sandbox.policy.manage）。请联系组织管理员。");
		} else if (s === "project") {
			const space = identity.projectSpace(scopeRef);
			if (!space || space.orgId !== p.orgId) throw notFound("项目");
			if (mode === "write") {
				if (!(await this.#hasPerm(p, "project.manage", { kind: "project", id: scopeRef }))) throw new HttpError(403, "forbidden", "没有权限：管理项目（project.manage）。项目变量只有项目管理者可以修改");
			} else if (!(await this.#aclAllows(p, "read", "project", scopeRef))) throw new HttpError(403, "forbidden", "只有项目成员可以查看项目变量");
		} else if (s === "user") {
			if (scopeRef !== p.userId) {
				const inOrg = this.#ctx.db.get("SELECT 1 AS x FROM id_org_members WHERE org_id = ? AND user_id = ? AND removed_at IS NULL", p.orgId, scopeRef);
				if (!inOrg) throw notFound("用户");
				throw new HttpError(403, "forbidden", "只能查看和修改自己的个人变量");
			}
		} else {
			const i = scopeRef.lastIndexOf(":");
			const spaceId = i > 0 ? scopeRef.slice(0, i) : "";
			const convId = i > 0 ? scopeRef.slice(i + 1) : "";
			const space = spaceId ? identity.space(spaceId) : null;
			if (!space || space.orgId !== p.orgId || !/^\d+$/.test(convId)) throw notFound("会话");
			if (!(await this.#aclAllows(p, mode === "write" ? "write" : "read", "space", spaceId))) throw new HttpError(403, "forbidden", mode === "write" ? "没有该会话所在空间的写入权限" : "没有该会话所在空间的访问权限");
			if (this.#ctx.services.has("runtime") && !(await this.#ctx.services.get("runtime").spaceOfConversation(spaceId, Number(convId)))) throw notFound("会话");
		}
		return { scope: s, scopeRef };
	}

	// ---------- CRUD ----------
	async list(p: Principal, scope: string, scopeRef: string): Promise<EnvVarDTO[]> {
		const a = await this.authorize(p, scope, scopeRef, "read");
		return this.#ctx.db.all<Row>("SELECT * FROM sandbox_env_vars WHERE org_id = ? AND scope = ? AND scope_ref = ? ORDER BY name", p.orgId, a.scope, a.scopeRef).map(dto);
	}

	async set(p: Principal, scope: string, scopeRef: string, name: string, input: { value?: unknown; locked?: unknown }): Promise<EnvVarDTO> {
		const a = await this.authorize(p, scope, scopeRef, "write");
		const reason = validateVar(name, input.value, () => this.isCredentialEnvName(p.orgId, name));
		if (reason) throw new HttpError(400, reason === SECRET_HINT ? "looks_like_secret" : "invalid_env_var", reason);
		if (input.locked !== undefined && typeof input.locked !== "boolean") throw new HttpError(400, "invalid", "locked 必须是布尔值");
		if (input.locked === true && a.scope !== "org") throw new HttpError(400, "invalid", "只有组织级变量可以锁定");
		const db = this.#ctx.db;
		const prev = db.get<Row>("SELECT * FROM sandbox_env_vars WHERE org_id = ? AND scope = ? AND scope_ref = ? AND name = ?", p.orgId, a.scope, a.scopeRef, name);
		if (!prev) {
			const n = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sandbox_env_vars WHERE org_id = ? AND scope = ? AND scope_ref = ?", p.orgId, a.scope, a.scopeRef)!.n;
			if (n >= MAX_VARS_PER_SCOPE) throw new HttpError(409, "too_many", `每个范围最多 ${MAX_VARS_PER_SCOPE} 个变量`);
		}
		const value = input.value as string;
		const locked = a.scope === "org" ? (input.locked === undefined ? (prev?.locked ?? 0) === 1 : input.locked === true) : false;
		const at = nowIso();
		const id = prev?.id ?? newId("env");
		db.tx(() => {
			db.run(
				"INSERT INTO sandbox_env_vars (id, org_id, scope, scope_ref, name, value, locked, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(org_id, scope, scope_ref, name) DO UPDATE SET value = excluded.value, locked = excluded.locked, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
				id, p.orgId, a.scope, a.scopeRef, name, value, locked ? 1 : 0, p.userId, at,
			);
			this.#audit(p, prev ? "sandbox.env.update" : "sandbox.env.create", a.scope, a.scopeRef, name, { valueSha256: sha(value), ...(prev ? { previousSha256: sha(prev.value) } : {}), locked });
		});
		return dto(db.get<Row>("SELECT * FROM sandbox_env_vars WHERE id = ?", id)!);
	}

	async delete(p: Principal, scope: string, scopeRef: string, name: string): Promise<void> {
		const a = await this.authorize(p, scope, scopeRef, "write");
		const db = this.#ctx.db;
		const prev = db.get<Row>("SELECT * FROM sandbox_env_vars WHERE org_id = ? AND scope = ? AND scope_ref = ? AND name = ?", p.orgId, a.scope, a.scopeRef, name);
		if (!prev) throw new HttpError(404, "not_found", "变量不存在");
		db.tx(() => {
			db.run("DELETE FROM sandbox_env_vars WHERE id = ?", prev.id);
			this.#audit(p, "sandbox.env.delete", a.scope, a.scopeRef, name, { previousSha256: sha(prev.value) });
		});
	}

	#audit(p: Principal, action: string, scope: string, scopeRef: string, name: string, detail: Record<string, unknown>): void {
		try {
			this.#ctx.db.run("INSERT INTO id_audit (id, org_id, actor_user_id, action, target, detail, at, category) VALUES (?, ?, ?, ?, ?, ?, ?, 'admin')", newId("aud"), p.orgId, p.userId, action, `${scope}:${scopeRef}:${name}`, JSON.stringify({ scope, scopeRef, name, ...detail }), nowIso());
		} catch {
			/* the audit table belongs to the identity module */
		}
	}

	// ---------- resolution (called for every new command / service start) ----------
	/**
	 * Effective environment for a NEW command: precedence conversation > user > project > org, except org variables with locked=true, which
	 * lower scopes cannot override (their values are ignored and listed in `denied`). `p` is the user running the conversation (user scope).
	 * Rows whose name is no longer allowed (deny list grew, credential name registered later) are dropped and listed in `denied`.
	 */
	resolve(p: Principal, space: Space, conversationId?: number | string): ResolvedEnv {
		if (space.orgId !== p.orgId) throw new HttpError(404, "not_found", "空间不存在");
		const db = this.#ctx.db;
		const layers: { scope: EnvScope; ref: string }[] = [{ scope: "org", ref: p.orgId }];
		if (space.kind === "project" && space.projectId) layers.push({ scope: "project", ref: space.projectId });
		layers.push({ scope: "user", ref: p.userId });
		if (conversationId !== undefined && conversationId !== null) layers.push({ scope: "conversation", ref: `${space.id}:${conversationId}` });
		const won = new Map<string, { value: string; from: EnvScope; overridden: EnvScope[]; locked: boolean }>();
		const denied: { name: string; reason: string }[] = [];
		for (const layer of layers) {
			const rows = db.all<Row>("SELECT * FROM sandbox_env_vars WHERE org_id = ? AND scope = ? AND scope_ref = ? ORDER BY name", p.orgId, layer.scope, layer.ref);
			for (const r of rows) {
				const bad = validateVar(r.name, r.value, () => this.isCredentialEnvName(p.orgId, r.name));
				if (bad) {
					denied.push({ name: r.name, reason: `${layer.scope === "org" ? "组织" : layer.scope === "project" ? "项目" : layer.scope === "user" ? "个人" : "会话"}级变量已被忽略：${bad}` });
					continue;
				}
				const cur = won.get(r.name);
				if (cur?.locked) {
					denied.push({ name: r.name, reason: `组织已锁定 ${r.name}，${layer.scope === "project" ? "项目" : layer.scope === "user" ? "个人" : "会话"}级的值被忽略` });
					continue;
				}
				won.set(r.name, { value: r.value, from: layer.scope, overridden: cur ? [...cur.overridden, cur.from] : [], locked: layer.scope === "org" && r.locked === 1 });
			}
		}
		const env: Record<string, string> = {};
		const vars = [...won.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, w]) => {
			env[name] = w.value;
			return { name, value: w.value, from: w.from, overridden: w.overridden };
		});
		return { env, effective: { vars, appliesToNewCommandsOnly: true, denied } };
	}

	/** Effective view for the API: the caller needs read access to the space; conversation (optional) must exist in it. */
	async effectiveFor(p: Principal, spaceId: string, conversationId?: string): Promise<EffectiveEnvDTO> {
		const space = this.#ctx.services.get("identity").space(spaceId);
		if (!space || space.orgId !== p.orgId) throw new HttpError(404, "not_found", "空间不存在");
		if (!(await this.#aclAllows(p, "read", "space", spaceId))) throw new HttpError(403, "forbidden", "没有该空间的访问权限");
		if (conversationId !== undefined) {
			if (!/^\d+$/.test(conversationId)) throw new HttpError(400, "invalid", "conversationId 必须是数字");
			if (this.#ctx.services.has("runtime") && !(await this.#ctx.services.get("runtime").spaceOfConversation(spaceId, Number(conversationId)))) throw new HttpError(404, "not_found", "会话不存在");
		}
		return this.resolve(p, space, conversationId).effective;
	}
}

/**
 * Merge for Sandbox.run / startService: ordinary variables first, platform-owned variables (WORKROOM_*, credential env injected by the
 * credentials group, PATH, HOME, proxy settings ...) LAST so they always win; deny-listed names in `vars` are dropped even if present.
 */
export function mergeSandboxEnv(vars: Readonly<Record<string, string>>, platform: Readonly<Record<string, string>>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(vars)) if (!denyReason(k)) out[k] = v;
	return { ...out, ...platform };
}

const instances = new WeakMap<AppContext, SandboxEnvVars>();
/** Lazy per-AppContext service (no services.provide needed). */
export function sandboxEnvFor(ctx: AppContext): SandboxEnvVars {
	let s = instances.get(ctx);
	if (!s) instances.set(ctx, (s = new SandboxEnvVars(ctx)));
	return s;
}
