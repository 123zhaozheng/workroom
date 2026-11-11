// Round 7 (group S): per-organisation configuration of REMOTE sandbox providers, the selection policy (who may pick which provider),
// per-project overrides and the connection test.
//
// Security model (read this before changing anything):
//  * API keys are sealed with SecretBox (AES-256-GCM, AAD bound to org + provider) and are NEVER returned, logged or audited. Without
//    WORKROOM_SECRET_KEY a key is refused (400 secret_storage_unavailable), never stored in plaintext.
//  * Endpoint SSRF: a per-org admin must not be able to aim Workroom at the host's internal network. Public https endpoints are fine.
//    Loopback / private / link-local / CGNAT addresses (and any hostname resolving to one) are accepted ONLY when BOTH (a) the org admin
//    set `allowPrivateNetwork` AND (b) the operator's instance allowlist (env WORKROOM_WEBHOOK_ALLOWLIST, see ops/egress.ts) names the
//    address/host. Cloud-metadata addresses additionally need an exact instance-allowlist entry. `http:` is accepted only for such
//    allowlisted private targets; vendor/public endpoints must be `https:`. TLS verification is never switched off (there is no flag).
//  * The endpoint is re-validated at save, at connection test and before EVERY provider construction (`connection()`).
//    Residual risk: the vendor SDKs perform their own DNS resolution and fetch, so a DNS-rebinding answer between our check and the SDK's
//    connect cannot be pinned from here. Mitigations: validation at every use, the instance allowlist, https + certificate checks.
//  * Connection tests only ever create a throwaway sandbox (provider defaults, no network option) holding a synthetic file; the sandbox is always destroyed.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isIP } from "node:net";
import type { AppContext, Principal, Space } from "../../core/contracts.ts";
import type { Migration } from "../../core/db.ts";
import { HttpError, newId, nowIso } from "../../core/http.ts";
import { Allowlist, resolveTarget, systemResolver, type Resolver } from "../../ops/egress.ts";
import { isPrivateAddress } from "../netpolicy.ts";
import { SecretBox } from "../secrets.ts";
import { DEFAULT_LIFECYCLE, PROVIDER_IDS, type LifecyclePolicy, type ProviderConnection, type ProviderId, type RemoteProvider } from "./provider.ts";
import type { SandboxProviderCapabilitiesDTO, SandboxProviderConfigDTO, SandboxProviderTestDTO, SandboxProviderUpdate, SandboxProvidersAdminDTO, SandboxSelectionPolicyDTO } from "../../../../shared/sandbox.ts";

/** Export; the integrator wires these into toolsModule.migrations with version offset +900. */
export const PROVIDER_CONFIG_MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "sandbox provider configs, selection policy, project overrides",
		sql: `
CREATE TABLE tool_sandbox_providers (
  org_id TEXT NOT NULL, provider TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
  endpoint TEXT, domain TEXT, template TEXT,
  api_key_sealed TEXT, api_key_hint TEXT,
  allow_private_network INTEGER NOT NULL DEFAULT 0, egress_ack INTEGER NOT NULL DEFAULT 0,
  create_timeout_sec INTEGER NOT NULL, idle_timeout_sec INTEGER NOT NULL, lifetime_sec INTEGER NOT NULL,
  last_test TEXT, caps_json TEXT,
  updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, provider)
);
CREATE TABLE tool_sandbox_provider_policy (
  org_id TEXT PRIMARY KEY, org_default TEXT NOT NULL DEFAULT 'local', allow_project_override INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE tool_sandbox_project_provider (
  project_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, provider TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
);`,
	},
];

interface Row {
	org_id: string;
	provider: string;
	enabled: number;
	endpoint: string | null;
	domain: string | null;
	template: string | null;
	api_key_sealed: string | null;
	api_key_hint: string | null;
	allow_private_network: number;
	egress_ack: number;
	create_timeout_sec: number;
	idle_timeout_sec: number;
	lifetime_sec: number;
	last_test: string | null;
	caps_json: string | null;
	updated_by: string;
	updated_at: string;
}

const LABEL: Record<ProviderId, string> = { opensandbox: "OpenSandbox（自托管）", e2b: "E2B", daytona: "Daytona" };
/** Installed SDK package per provider (exact version is read from node_modules at runtime). The opensandbox package name is a best guess: owned by the adapter author. */
const SDK_PACKAGE: Record<ProviderId, string> = { opensandbox: "@alibaba-group/opensandbox", e2b: "e2b", daytona: "@daytonaio/sdk" };
/** Whether data leaves the organisation by default (vendor cloud) — OpenSandbox is self-hosted by construction. */
const DEFAULT_LOCATION: Record<ProviderId, SandboxProviderCapabilitiesDTO["location"]> = { opensandbox: "self_hosted", e2b: "vendor_cloud", daytona: "vendor_cloud" };

const RANGE = { createTimeoutSec: [10, 600], idleTimeoutSec: [60, 86400], lifetimeSec: [300, 604800] } as const;
const TEMPLATE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const DOMAIN_RE = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** Static capability placeholder: nothing is known until a connection test ran. Clearly marked in `isolation`. */
function placeholderCaps(provider: ProviderId): SandboxProviderCapabilitiesDTO {
	return { exec: "unverified", streamOutput: "unverified", cancel: "unverified", commandTimeout: "unverified", files: "unverified", networkOff: "unverified", networkOn: "unverified", resourceLimits: "unverified", reconnect: "unverified", services: "unverified", pty: "unverified", preview: "unverified", snapshot: "unverified", pauseResume: "unverified", skills: "unsupported", isolation: "未验证：尚未运行连接测试，能力以测试结果为准（占位值）", location: DEFAULT_LOCATION[provider] };
}

/** Installed package version from node_modules (walks up from this file); null when not installed. */
export function sdkVersion(name: string): string | null {
	let dir = import.meta.dirname;
	for (let i = 0; i < 8; i++) {
		try {
			const pj = JSON.parse(readFileSync(join(dir, "node_modules", name, "package.json"), "utf8"));
			if (typeof pj.version === "string") return pj.version;
		} catch {
			/* keep walking */
		}
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return null;
}

/** Remove the API key and anything that looks like a credential from text that may reach a response, audit row or log. */
export function scrubSecrets(text: string, ...secrets: (string | undefined | null)[]): string {
	let out = String(text);
	for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[已隐藏]");
	return out
		.replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [已隐藏]")
		.replace(/\b(authorization|x-api-key|api[_-]?key|apikey|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi, "$1$2[已隐藏]")
		.replace(/\b(sk|e2b|dtn|key)[_-][A-Za-z0-9_-]{12,}/gi, "[已隐藏]")
		.slice(0, 500);
}

const intIn = (name: keyof typeof RANGE, v: unknown): number => {
	const [lo, hi] = RANGE[name];
	if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new HttpError(400, "invalid", `${name} 必须是 ${lo}–${hi} 之间的整数（秒）`);
	return v;
};

export type EffectiveSandbox = { kind: "local" } | { kind: "provider"; provider: ProviderId; orgId: string };

export type ProviderFactory = (conn: ProviderConnection) => Promise<RemoteProvider>;
/** Default factory: A1's `createRemoteProvider` in ./providers/index.ts (dynamic, so this file works before the adapters exist). */
const defaultFactory: ProviderFactory = async (conn) => {
	const spec = "./providers/index.ts";
	let mod: any;
	try {
		mod = await import(spec);
	} catch {
		throw new HttpError(501, "adapter_missing", "适配器未安装");
	}
	if (typeof mod.createRemoteProvider !== "function") throw new HttpError(501, "adapter_missing", "适配器未安装");
	return mod.createRemoteProvider(conn);
};

const configs = new WeakMap<AppContext, SandboxProviderConfigs>();
/** Lazy per-context accessor (also fine to `ctx.services.provide("sandboxProviders", providerConfigsFor(ctx))` at init). */
export function providerConfigsFor(ctx: AppContext): SandboxProviderConfigs {
	let s = configs.get(ctx);
	if (!s) configs.set(ctx, (s = new SandboxProviderConfigs(ctx)));
	return s;
}

export class SandboxProviderConfigs {
	readonly #ctx: AppContext;
	readonly #box: SecretBox;
	/** Tests replace these (clearly labelled test doubles). */
	resolver: Resolver = systemResolver;
	factory: ProviderFactory = defaultFactory;
	readonly #testing = new Set<string>();
	readonly #testLog = new Map<string, number[]>();

	constructor(ctx: AppContext) {
		this.#ctx = ctx;
		this.#box = new SecretBox(ctx.config.secretKey);
	}

	// ---------- permissions ----------
	async canManage(p: Principal): Promise<boolean> {
		if (!this.#ctx.services.has("authz")) return p.orgRole === "owner" || p.orgRole === "admin";
		try {
			return await this.#ctx.services.get("authz").has(p, "sandbox.policy.manage", { kind: "org" });
		} catch {
			return false;
		}
	}
	async requireManage(p: Principal): Promise<void> {
		if (!(await this.canManage(p))) throw new HttpError(403, "forbidden", "没有权限：管理沙箱与工具策略（sandbox.policy.manage）。请联系组织管理员。");
	}
	#audit(p: Principal, action: string, target: string, detail: unknown): void {
		try {
			this.#ctx.db.run("INSERT INTO id_audit (id, org_id, actor_user_id, action, target, detail, at, category) VALUES (?, ?, ?, ?, ?, ?, ?, 'admin')", newId("aud"), p.orgId, p.userId, action, target, JSON.stringify(detail ?? {}), nowIso());
		} catch {
			/* the audit table belongs to the identity module */
		}
	}
	static provider(id: string): ProviderId {
		if (!(PROVIDER_IDS as readonly string[]).includes(id)) throw new HttpError(404, "provider_not_found", `未知的沙箱提供方：${id.slice(0, 40)}`);
		return id as ProviderId;
	}

	// ---------- rows / dto ----------
	#row(orgId: string, provider: ProviderId): Row | undefined {
		return this.#ctx.db.get<Row>("SELECT * FROM tool_sandbox_providers WHERE org_id = ? AND provider = ?", orgId, provider);
	}
	#aad(orgId: string, provider: ProviderId): string {
		return `sandbox-provider:${orgId}:${provider}`;
	}
	/** Admin DTO of one provider. Never contains the key. */
	dto(p: Principal | { orgId: string }, provider: ProviderId): SandboxProviderConfigDTO {
		const r = this.#row(p.orgId, provider);
		let caps = placeholderCaps(provider);
		if (r?.caps_json) {
			try {
				caps = JSON.parse(r.caps_json);
			} catch {
				/* keep placeholder */
			}
		}
		let lastTest: SandboxProviderTestDTO | undefined;
		if (r?.last_test) {
			try {
				lastTest = JSON.parse(r.last_test);
			} catch {
				/* ignore */
			}
		}
		const pkg = SDK_PACKAGE[provider];
		return {
			provider,
			label: LABEL[provider],
			enabled: r?.enabled === 1,
			...(r?.endpoint ? { endpoint: r.endpoint } : {}),
			...(r?.domain ? { domain: r.domain } : {}),
			...(r?.template ? { template: r.template } : {}),
			apiKeySet: !!r?.api_key_sealed,
			...(r?.api_key_sealed && r.api_key_hint ? { apiKeyHint: r.api_key_hint } : {}),
			allowPrivateNetwork: r?.allow_private_network === 1,
			egressAcknowledged: r?.egress_ack === 1,
			createTimeoutSec: r?.create_timeout_sec ?? DEFAULT_LIFECYCLE.createTimeoutSec,
			idleTimeoutSec: r?.idle_timeout_sec ?? DEFAULT_LIFECYCLE.idleTimeoutSec,
			lifetimeSec: r?.lifetime_sec ?? DEFAULT_LIFECYCLE.lifetimeSec,
			capabilities: caps,
			sdk: { name: pkg, version: sdkVersion(pkg) },
			...(lastTest ? { lastTest } : {}),
			...(r ? { updatedAt: r.updated_at } : {}),
		};
	}
	async list(p: Principal): Promise<SandboxProvidersAdminDTO> {
		await this.requireManage(p);
		return { providers: PROVIDER_IDS.map((id) => this.dto(p, id)), policy: this.policy(p), secretStorage: this.#box.available, canManage: true };
	}

	// ---------- SSRF ----------
	/**
	 * Validate an endpoint URL for `orgId` (see the header comment for the rules). Returns the normalised URL string without trailing slash.
	 * Throws HttpError(400). `allowPrivate` is the org admin's flag; the instance allowlist is the operator's.
	 */
	async checkEndpoint(_orgId: string, raw: string, allowPrivate: boolean): Promise<string> {
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			throw new HttpError(400, "invalid_url", "服务地址无效");
		}
		if (url.protocol !== "https:" && url.protocol !== "http:") throw new HttpError(400, "invalid_url", "服务地址仅支持 https（内网自托管且已加入实例允许列表时可用 http）");
		if (url.username || url.password) throw new HttpError(400, "invalid_url", "服务地址不得包含用户名/密码（请使用 API 密钥字段）");
		// Empty org allowlist: only the operator's instance allowlist can unlock private ranges (resolveTarget also blocks cloud metadata).
		const t = await resolveTarget(url.href, new Allowlist([]), this.resolver);
		const host = url.hostname.replace(/^\[|\]$/g, "");
		let addrs: string[];
		if (isIP(host)) addrs = [host];
		else addrs = (await this.resolver(host).catch(() => [])).map((a) => a.address);
		if (!addrs.length) addrs = [t.address];
		const priv = addrs.some((a) => isPrivateAddress(a)) || host.toLowerCase() === "localhost" || host.toLowerCase().endsWith(".localhost");
		if (priv && !allowPrivate) throw new HttpError(400, "blocked_address", `${host} 指向内网/保留地址；如确为自托管内网服务，需由管理员勾选“允许内网地址”，并由服务器运维将其加入实例允许列表`);
		if (url.protocol === "http:" && !priv) throw new HttpError(400, "https_required", "公网服务地址必须使用 https（TLS 证书始终会被校验）");
		if (priv && !isIP(host) && !instanceAllowsHost(host) && !addrs.every((a) => new Allowlist(instanceEntries()).allowsIp(a))) throw new HttpError(400, "blocked_address", `${host} 未在实例允许列表中`);
		return url.href.replace(/\/+$/, "");
	}
	async #checkDomain(orgId: string, domain: string, allowPrivate: boolean): Promise<void> {
		if (!DOMAIN_RE.test(domain) && !isIP(domain)) throw new HttpError(400, "invalid", "domain 格式无效（只填主机名，不含协议和路径）");
		if (isIP(domain) || domain === "localhost" || domain.endsWith(".localhost")) {
			await this.checkEndpoint(orgId, `https://${isIP(domain) === 6 ? `[${domain}]` : domain}`, allowPrivate);
			return;
		}
		// Wildcard sandbox domains often do not resolve bare; best effort: if they resolve, every address must pass.
		const addrs = await this.resolver(domain).catch(() => []);
		if (addrs.some((a) => isPrivateAddress(a.address))) await this.checkEndpoint(orgId, `https://${domain}`, allowPrivate);
	}

	// ---------- update ----------
	async update(p: Principal, providerId: string, patch: SandboxProviderUpdate): Promise<SandboxProviderConfigDTO> {
		await this.requireManage(p);
		const provider = SandboxProviderConfigs.provider(providerId);
		if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new HttpError(400, "invalid", "请求体无效");
		const bool = (k: string, v: unknown): boolean => {
			if (typeof v !== "boolean") throw new HttpError(400, "invalid", `${k} 必须是布尔值`);
			return v;
		};
		const str = (k: string, v: unknown, max: number): string => {
			if (typeof v !== "string" || v.length > max || /[\u0000-\u001f]/.test(v)) throw new HttpError(400, "invalid", `${k} 必须是不超过 ${max} 字符的文本`);
			return v.trim();
		};
		const old = this.#row(p.orgId, provider);
		const next = {
			enabled: old?.enabled === 1,
			endpoint: old?.endpoint ?? "",
			domain: old?.domain ?? "",
			template: old?.template ?? "",
			allowPrivate: old?.allow_private_network === 1,
			ack: old?.egress_ack === 1,
			createTimeoutSec: old?.create_timeout_sec ?? DEFAULT_LIFECYCLE.createTimeoutSec,
			idleTimeoutSec: old?.idle_timeout_sec ?? DEFAULT_LIFECYCLE.idleTimeoutSec,
			lifetimeSec: old?.lifetime_sec ?? DEFAULT_LIFECYCLE.lifetimeSec,
			sealed: old?.api_key_sealed ?? null,
			hint: old?.api_key_hint ?? null,
		};
		const changed: string[] = [];
		if (patch.enabled !== undefined) ((next.enabled = bool("enabled", patch.enabled)), changed.push("enabled"));
		if (patch.allowPrivateNetwork !== undefined) ((next.allowPrivate = bool("allowPrivateNetwork", patch.allowPrivateNetwork)), changed.push("allowPrivateNetwork"));
		if (patch.egressAcknowledged !== undefined) ((next.ack = bool("egressAcknowledged", patch.egressAcknowledged)), changed.push("egressAcknowledged"));
		if (patch.endpoint !== undefined) ((next.endpoint = str("endpoint", patch.endpoint, 500)), changed.push("endpoint"));
		if (patch.domain !== undefined) {
			next.domain = str("domain", patch.domain, 253).toLowerCase();
			changed.push("domain");
		}
		if (patch.template !== undefined) {
			next.template = str("template", patch.template, 128);
			if (next.template && !TEMPLATE_RE.test(next.template)) throw new HttpError(400, "invalid", "template 只能包含字母、数字和 . _ : / @ -，且以字母或数字开头");
			changed.push("template");
		}
		for (const k of ["createTimeoutSec", "idleTimeoutSec", "lifetimeSec"] as const) if (patch[k] !== undefined) ((next[k] = intIn(k, patch[k])), changed.push(k));
		if (next.idleTimeoutSec > next.lifetimeSec) throw new HttpError(400, "invalid", "空闲回收时间不能超过最长存活时间");
		let keyStatus: "set" | "cleared" | "unchanged" = "unchanged";
		let plainKey: string | undefined;
		if (patch.apiKey === null) {
			next.sealed = null;
			next.hint = null;
			keyStatus = "cleared";
		} else if (patch.apiKey !== undefined) {
			if (typeof patch.apiKey !== "string" || patch.apiKey.length < 8 || patch.apiKey.length > 512 || /[\s\u0000-\u001f]/.test(patch.apiKey)) throw new HttpError(400, "invalid", "API 密钥格式无效（8–512 个字符，不含空白）");
			plainKey = patch.apiKey;
			next.sealed = this.#box.seal(plainKey, this.#aad(p.orgId, provider)); // throws secret_storage_unavailable without WORKROOM_SECRET_KEY
			next.hint = plainKey.length >= 12 ? plainKey.slice(-4) : null;
			keyStatus = "set";
		}
		// Endpoint / domain: SSRF check whenever present and either changed or the network flag changed.
		const netChanged = patch.endpoint !== undefined || patch.domain !== undefined || patch.allowPrivateNetwork !== undefined || patch.enabled === true;
		if (netChanged) {
			if (next.endpoint) next.endpoint = await this.checkEndpoint(p.orgId, next.endpoint, next.allowPrivate);
			if (next.domain) await this.#checkDomain(p.orgId, next.domain, next.allowPrivate);
		}
		if (next.enabled) {
			if (!next.sealed) throw new HttpError(400, "missing_field", "启用前必须先设置 API 密钥");
			if (provider === "opensandbox" && !next.endpoint) throw new HttpError(400, "missing_field", "OpenSandbox 必须配置服务地址（endpoint）");
			if (this.#needsEgressAck(provider, next.endpoint, next.allowPrivate) && !next.ack) throw new HttpError(400, "egress_ack_required", "该提供方在组织外部运行：工作区文件与命令会离开组织。启用前管理员必须确认（egressAcknowledged）");
		}
		const now = nowIso();
		this.#ctx.db.run(
			`INSERT INTO tool_sandbox_providers (org_id, provider, enabled, endpoint, domain, template, api_key_sealed, api_key_hint, allow_private_network, egress_ack, create_timeout_sec, idle_timeout_sec, lifetime_sec, updated_by, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(org_id, provider) DO UPDATE SET enabled = excluded.enabled, endpoint = excluded.endpoint, domain = excluded.domain, template = excluded.template, api_key_sealed = excluded.api_key_sealed, api_key_hint = excluded.api_key_hint, allow_private_network = excluded.allow_private_network, egress_ack = excluded.egress_ack, create_timeout_sec = excluded.create_timeout_sec, idle_timeout_sec = excluded.idle_timeout_sec, lifetime_sec = excluded.lifetime_sec, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
			p.orgId, provider, next.enabled ? 1 : 0, next.endpoint || null, next.domain || null, next.template || null, next.sealed, next.hint, next.allowPrivate ? 1 : 0, next.ack ? 1 : 0, next.createTimeoutSec, next.idleTimeoutSec, next.lifetimeSec, p.userId, now,
		);
		// Audit: field names + key status only. The key (and its hint) never enter the audit row; the endpoint is logged as origin only.
		let origin: string | undefined;
		try {
			origin = next.endpoint ? new URL(next.endpoint).origin : undefined;
		} catch {
			/* ignore */
		}
		this.#audit(p, "sandbox.provider.update", provider, { changed, enabled: next.enabled, apiKey: keyStatus, ...(origin ? { endpointOrigin: origin } : {}), allowPrivateNetwork: next.allowPrivate, egressAcknowledged: next.ack });
		return this.dto(p, provider);
	}
	/** Vendor cloud (E2B / Daytona) or any non-private remote endpoint: data leaves the organisation. A self-hosted private-network endpoint does not need the acknowledgement. */
	#needsEgressAck(provider: ProviderId, endpoint: string, allowPrivate: boolean): boolean {
		if (allowPrivate && endpoint) {
			try {
				const h = new URL(endpoint).hostname.replace(/^\[|\]$/g, "");
				if (isIP(h) ? isPrivateAddress(h) : true) return false; // validated as private+allowlisted at save time
			} catch {
				/* fall through */
			}
		}
		return true;
	}

	// ---------- use ----------
	async #connectionOf(orgId: string, provider: ProviderId, requireEnabled: boolean): Promise<ProviderConnection | null> {
		const r = this.#row(orgId, provider);
		if (!r || (requireEnabled && r.enabled !== 1)) return null;
		let apiKey: string | undefined;
		if (r.api_key_sealed) {
			try {
				apiKey = this.#box.open(r.api_key_sealed, this.#aad(orgId, provider));
			} catch {
				throw new HttpError(409, "needs_reconnect", "沙箱提供方的 API 密钥无法解密（服务器密钥已变更？），请管理员重新填写");
			}
		}
		let endpoint = r.endpoint ?? undefined;
		if (endpoint) endpoint = await this.checkEndpoint(orgId, endpoint, r.allow_private_network === 1); // re-validated before every construction
		if (r.domain) await this.#checkDomain(orgId, r.domain, r.allow_private_network === 1);
		return { provider, ...(endpoint ? { endpoint } : {}), ...(r.domain ? { domain: r.domain } : {}), ...(apiKey ? { apiKey } : {}), ...(r.template ? { template: r.template } : {}) };
	}
	/** Decrypted, re-validated connection of an ENABLED provider (null when missing/disabled). Async because the endpoint is re-resolved. Never log the result. */
	connection(orgId: string, provider: ProviderId): Promise<ProviderConnection | null> {
		return this.#connectionOf(orgId, provider, true);
	}
	lifecycle(orgId: string, provider: ProviderId): LifecyclePolicy {
		const r = this.#row(orgId, provider);
		return r ? { createTimeoutSec: r.create_timeout_sec, idleTimeoutSec: r.idle_timeout_sec, lifetimeSec: r.lifetime_sec } : DEFAULT_LIFECYCLE;
	}
	isEnabled(orgId: string, provider: ProviderId): boolean {
		return this.#row(orgId, provider)?.enabled === 1;
	}

	// ---------- selection policy ----------
	/** Admin read of the policy (sandbox.policy.manage). */
	async policyFor(p: Principal): Promise<SandboxSelectionPolicyDTO> {
		await this.requireManage(p);
		return this.policy(p);
	}
	/** What a project member sees: current override, whether managers may change it, and the choosable providers (no secrets). */
	projectChoice(p: Principal, projectId: string): { provider: "local" | ProviderId | null; allowed: boolean; options: { id: ProviderId; label: string; enabled: boolean }[] } {
		const space = this.#ctx.services.get("identity").projectSpace(projectId);
		if (!space || space.orgId !== p.orgId) throw new HttpError(404, "project_not_found", "项目不存在");
		return { provider: this.projectOverride(projectId), allowed: this.policy(p).allowProjectOverride, options: PROVIDER_IDS.map((id) => ({ id, label: LABEL[id], enabled: this.isEnabled(p.orgId, id) })) };
	}
	policy(p: Principal | { orgId: string }): SandboxSelectionPolicyDTO {
		const r = this.#ctx.db.get<{ org_default: string; allow_project_override: number }>("SELECT org_default, allow_project_override FROM tool_sandbox_provider_policy WHERE org_id = ?", p.orgId);
		const d = r?.org_default;
		return { orgDefault: d && (PROVIDER_IDS as readonly string[]).includes(d) ? (d as ProviderId) : "local", allowProjectOverride: r?.allow_project_override === 1 };
	}
	async setPolicy(p: Principal, dto: Partial<SandboxSelectionPolicyDTO>): Promise<SandboxSelectionPolicyDTO> {
		await this.requireManage(p);
		const cur = this.policy(p);
		const orgDefault = dto?.orgDefault ?? cur.orgDefault;
		if (orgDefault !== "local" && !(PROVIDER_IDS as readonly string[]).includes(orgDefault as string)) throw new HttpError(400, "invalid", "orgDefault 必须是 local 或已知的提供方");
		if (dto?.allowProjectOverride !== undefined && typeof dto.allowProjectOverride !== "boolean") throw new HttpError(400, "invalid", "allowProjectOverride 必须是布尔值");
		const allow = dto?.allowProjectOverride ?? cur.allowProjectOverride;
		if (orgDefault !== "local" && !this.isEnabled(p.orgId, orgDefault as ProviderId)) throw new HttpError(409, "provider_disabled", "只能把已启用的提供方设为组织默认；请先配置并启用它");
		this.#ctx.db.run("INSERT INTO tool_sandbox_provider_policy (org_id, org_default, allow_project_override, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(org_id) DO UPDATE SET org_default = excluded.org_default, allow_project_override = excluded.allow_project_override, updated_by = excluded.updated_by, updated_at = excluded.updated_at", p.orgId, orgDefault, allow ? 1 : 0, p.userId, nowIso());
		this.#audit(p, "sandbox.provider.policy", p.orgId, { orgDefault, allowProjectOverride: allow });
		return { orgDefault: orgDefault as SandboxSelectionPolicyDTO["orgDefault"], allowProjectOverride: allow };
	}
	/** Project manager picks this project's sandbox. `null` clears the override (always allowed to the manager). */
	async setProjectProvider(p: Principal, projectId: string, choice: string | null): Promise<{ provider: "local" | ProviderId | null }> {
		const space = this.#ctx.services.get("identity").projectSpace(projectId);
		if (!space || space.orgId !== p.orgId) throw new HttpError(404, "project_not_found", "项目不存在");
		if (this.#ctx.services.has("authz")) await this.#ctx.services.get("authz").require(p, "project.manage", { kind: "project", id: projectId });
		else if (p.orgRole !== "owner" && p.orgRole !== "admin") throw new HttpError(403, "forbidden", "没有权限：管理项目（project.manage）");
		if (choice === null) {
			this.#ctx.db.run("DELETE FROM tool_sandbox_project_provider WHERE project_id = ?", projectId);
			this.#audit(p, "sandbox.provider.project", projectId, { provider: null });
			return { provider: null };
		}
		if (choice !== "local" && !(PROVIDER_IDS as readonly string[]).includes(choice)) throw new HttpError(400, "invalid", "provider 必须是 local、已知的提供方或 null");
		if (!this.policy(p).allowProjectOverride) throw new HttpError(403, "override_not_allowed", "组织管理员未允许项目自行选择沙箱");
		if (choice !== "local" && !this.isEnabled(p.orgId, choice as ProviderId)) throw new HttpError(409, "provider_disabled", "该提供方未启用");
		this.#ctx.db.run("INSERT INTO tool_sandbox_project_provider (project_id, org_id, provider, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET provider = excluded.provider, updated_by = excluded.updated_by, updated_at = excluded.updated_at", projectId, p.orgId, choice, p.userId, nowIso());
		this.#audit(p, "sandbox.provider.project", projectId, { provider: choice });
		return { provider: choice as "local" | ProviderId };
	}
	projectOverride(projectId: string): "local" | ProviderId | null {
		const r = this.#ctx.db.get<{ provider: string }>("SELECT provider FROM tool_sandbox_project_provider WHERE project_id = ?", projectId);
		return r && (r.provider === "local" || (PROVIDER_IDS as readonly string[]).includes(r.provider)) ? (r.provider as "local" | ProviderId) : null;
	}
	/**
	 * Which sandbox a space uses. Personal spaces: org default. Project spaces: the project's override while the org still allows overrides,
	 * else the org default. NO silent fallback: a chosen provider that is disabled/unconfigured stays chosen and runs fail with `explain()`.
	 */
	effectiveFor(space: Space): EffectiveSandbox {
		const pol = this.policy({ orgId: space.orgId });
		let choice: "local" | ProviderId = pol.orgDefault;
		if (space.kind === "project" && space.projectId && pol.allowProjectOverride) choice = this.projectOverride(space.projectId) ?? choice;
		return choice === "local" ? { kind: "local" } : { kind: "provider", provider: choice, orgId: space.orgId };
	}
	/** Human-readable reason for a run error when the effective provider is not usable (empty string when usable or local). */
	explain(space: Space): string {
		const e = this.effectiveFor(space);
		if (e.kind === "local") return "";
		const r = this.#row(e.orgId, e.provider);
		if (!r) return `组织选择了沙箱提供方 ${LABEL[e.provider]}，但尚未配置。请管理员在“沙箱 → 提供方”中配置（不会回退到本机执行）`;
		if (r.enabled !== 1) return `沙箱提供方 ${LABEL[e.provider]} 已被管理员停用，当前空间无法执行代码（不会回退到本机执行）`;
		if (!r.api_key_sealed) return `沙箱提供方 ${LABEL[e.provider]} 缺少 API 密钥（不会回退到本机执行）`;
		return "";
	}

	// ---------- connection test ----------
	async test(p: Principal, providerId: string, kind: "health" | "roundtrip"): Promise<SandboxProviderTestDTO> {
		await this.requireManage(p);
		const provider = SandboxProviderConfigs.provider(providerId);
		if (kind !== "health" && kind !== "roundtrip") throw new HttpError(400, "invalid", "kind 必须是 health 或 roundtrip");
		if (this.#testing.has(p.orgId)) throw new HttpError(429, "test_in_progress", "已有一个连接测试正在进行，请稍后再试");
		const now = Date.now();
		const recent = (this.#testLog.get(p.orgId) ?? []).filter((t) => now - t < 60_000);
		if (recent.length >= 10) throw new HttpError(429, "rate_limited", "连接测试过于频繁（每分钟最多 10 次）");
		this.#testLog.set(p.orgId, [...recent, now]);
		this.#testing.add(p.orgId);
		const started = Date.now();
		const steps: { step: string; ok: boolean; ms: number; detail?: string }[] = [];
		let key: string | undefined;
		const done = (ok: boolean, detail: string, version?: string): SandboxProviderTestDTO => {
			const out: SandboxProviderTestDTO = { ok, at: nowIso(), kind, detail: scrubSecrets(detail, key), ...(version ? { version } : {}), durationMs: Date.now() - started, ...(kind === "roundtrip" && steps.length ? { steps } : {}) };
			return out;
		};
		let caps: unknown;
		try {
			let conn: ProviderConnection | null;
			try {
				conn = await this.#connectionOf(p.orgId, provider, false);
			} catch (e) {
				return this.#finish(p, provider, done(false, (e as Error).message), undefined);
			}
			if (!conn) return this.#finish(p, provider, done(false, "尚未保存该提供方的配置"), undefined);
			key = conn.apiKey;
			let prov: RemoteProvider;
			try {
				prov = await this.factory(conn);
			} catch (e) {
				return this.#finish(p, provider, done(false, e instanceof HttpError && e.code === "adapter_missing" ? "适配器未安装" : `无法创建适配器：${(e as Error).message}`), undefined);
			}
			caps = prov.capabilities;
			const lc = this.lifecycle(p.orgId, provider);
			const timed = async <T>(step: string, fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> => {
				const t0 = Date.now();
				const ac = new AbortController();
				const timer = setTimeout(() => ac.abort(), ms);
				try {
					const v = await fn(ac.signal);
					steps.push({ step, ok: true, ms: Date.now() - t0 });
					return v;
				} catch (e) {
					steps.push({ step, ok: false, ms: Date.now() - t0, detail: scrubSecrets(ac.signal.aborted ? `超时（${ms} ms）` : (e as Error).message, key) });
					throw e;
				} finally {
					clearTimeout(timer);
				}
			};
			try {
				const h = await prov.health(AbortSignal.timeout(20_000));
				if (!h.ok) return this.#finish(p, provider, done(false, h.detail), caps);
				if (kind === "health") return this.#finish(p, provider, done(true, h.detail, h.version), caps);
				// Roundtrip with a throwaway sandbox: provider defaults, short lifetime, synthetic data only.
				let sessionId: string | undefined;
				try {
					const session = await timed("create", (signal) => prov.create({ ...(conn.template ? { template: conn.template } : {}), metadata: { workroom: "1", purpose: "connection-test" }, lifetimeMs: 300_000, createTimeoutMs: lc.createTimeoutSec * 1000, signal }), lc.createTimeoutSec * 1000 + 5000);
					sessionId = session.id;
					const exec = await timed("exec", async (signal) => {
						const r = await session.exec({ command: "echo workroom-ok", cwd: "/tmp", timeoutMs: 20_000, signal });
						if (r.status !== "ok" || !r.stdout.includes("workroom-ok")) throw new Error(`命令未按预期返回（status=${r.status}）`);
						return r;
					}, 30_000);
					void exec;
					const payload = `workroom-connection-test ${newId("t")}\n`;
					await timed("file", async () => {
						const bytes = new TextEncoder().encode(payload);
						await session.writeFile("/tmp/workroom-test.txt", bytes);
						const back = new TextDecoder().decode(await session.readFile("/tmp/workroom-test.txt", 4096));
						if (back !== payload) throw new Error("读回的文件内容与写入不一致");
					}, 30_000);
				} catch (e) {
					return this.#finish(p, provider, done(false, `往返测试失败：${(e as Error).message}`, h.version), caps, async () => sessionId && (await this.#destroy(prov, sessionId, steps, key)));
				}
				await this.#destroy(prov, sessionId!, steps, key);
				const ok = steps.every((s) => s.ok);
				return this.#finish(p, provider, done(ok, ok ? "往返测试通过：创建、执行、文件读写、销毁均正常" : "往返测试未完全通过", h.version), caps);
			} catch (e) {
				return this.#finish(p, provider, done(false, (e as Error).message), caps);
			}
		} finally {
			this.#testing.delete(p.orgId);
		}
	}
	async #destroy(prov: RemoteProvider, id: string, steps: { step: string; ok: boolean; ms: number; detail?: string }[], key?: string): Promise<void> {
		const t0 = Date.now();
		try {
			await prov.destroy(id);
			steps.push({ step: "destroy", ok: true, ms: Date.now() - t0 });
		} catch (e) {
			steps.push({ step: "destroy", ok: false, ms: Date.now() - t0, detail: scrubSecrets((e as Error).message, key) });
		}
	}
	async #finish(p: Principal, provider: ProviderId, res: SandboxProviderTestDTO, caps: unknown, cleanup?: () => Promise<unknown>): Promise<SandboxProviderTestDTO> {
		if (cleanup) await cleanup().catch(() => {});
		// Steps may have gained a destroy entry in cleanup: `res.steps` shares the array, so the stored copy includes it.
		const stored = JSON.stringify(res);
		this.#ctx.db.run("UPDATE tool_sandbox_providers SET last_test = ?" + (caps ? ", caps_json = ?" : "") + " WHERE org_id = ? AND provider = ?", ...(caps ? [stored, JSON.stringify(caps), p.orgId, provider] : [stored, p.orgId, provider]));
		this.#audit(p, "sandbox.provider.test", provider, { kind: res.kind, ok: res.ok, durationMs: res.durationMs });
		return res;
	}
}

function instanceEntries(): string[] {
	return (process.env.WORKROOM_WEBHOOK_ALLOWLIST ?? "").split(",");
}
function instanceAllowsHost(host: string): boolean {
	return new Allowlist(instanceEntries()).allowsHost(host);
}
