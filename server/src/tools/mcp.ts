// MCP connectors (M04): system (org admin) and personal server configs, encrypted secrets, health/status, tool discovery,
// namespaced deferred pi tools, per-user enablement checked at call time, call records, approval + effect protocol for writes.
import type { Context } from "@earendil-works/chord/context";
import { defineTool, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AppContext, Decision, EffectsApi, Principal, ToolActor } from "../core/contracts.ts";
import type { Migration } from "../core/db.ts";
import { HttpError, newId, nowIso } from "../core/http.ts";
import type { ConnectorDTO, ConnectorStatus, ConnectorToolDTO } from "../../../shared/files.ts";
import type { Market } from "./market.ts";
import type { Sandbox } from "./sandbox.ts";
import { serviceTransport } from "./sandbox/mcp-transport.ts";
import { runtimeActorResolver, type ActorResolver } from "../files/actor.ts";
import { redactText, summarizeArgs, type ToolCallLog } from "./calls.ts";
import { checkUrl, pinnedFetch } from "./netpolicy.ts";
import { SecretBox } from "./secrets.ts";
import { ONDEMAND_TOOLS, ondemandGroupOf, rankScore } from "./ondemand.ts";
import type { ToolPolicy } from "./policy.ts";

export const MCP_MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "mcp connectors",
		sql: `
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  owner_user_id TEXT,
  handle TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  transport TEXT NOT NULL,
  command TEXT,
  args TEXT,
  url TEXT,
  env TEXT,
  secrets_enc TEXT,
  secret_names TEXT NOT NULL DEFAULT '[]',
  tool_policies TEXT NOT NULL DEFAULT '{}',
  access TEXT NOT NULL DEFAULT 'members',
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'unchecked',
  status_detail TEXT,
  ever_ready INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  tools_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX mcp_servers_org ON mcp_servers(org_id, scope);
CREATE TABLE mcp_user_settings (
  server_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (server_id, user_id)
);
`,
	},
];

export interface McpServerRow {
	id: string;
	org_id: string;
	scope: "system" | "personal";
	owner_user_id: string | null;
	handle: string;
	name: string;
	transport: "stdio" | "http";
	command: string | null;
	args: string | null;
	url: string | null;
	env: string | null;
	secrets_enc: string | null;
	secret_names: string;
	tool_policies: string;
	access: string;
	enabled: number;
	status: ConnectorStatus;
	status_detail: string | null;
	ever_ready: number;
	last_checked_at: string | null;
	tools_json: string;
	created_by: string;
	created_at: string;
	updated_at: string;
	deleted_at: string | null;
	/** Marketplace round: personal connectors may need a reviewer's approval before the first connection. */
	approval_state: "approved" | "pending" | "rejected";
	/** host = process on the server (operator allowlist, admin only, legacy); sandbox = stdio server inside the sandbox service mode. */
	exec_mode: "host" | "sandbox";
	/** shared = one credential set (connector row); per_user = every user stores their own (mcp_user_settings.secrets_enc). */
	credential_mode: "shared" | "per_user";
	catalog_version_id: string | null;
	/** Sandbox stdio: { runtime, argv, bundle?: { sha256, slug }, network } */
	package_json: string | null;
}

export interface SandboxPackage {
	runtime: "node" | "python" | "shell";
	argv: string[];
	/** Catalog version whose uploaded bundle (server code) is mounted read-only at /mcp/<slug>. */
	bundleVersionId?: string;
	network?: boolean;
}

interface DiscoveredTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; title?: string };
}

interface Live {
	client: Client;
	secrets: string[];
	stamp: string;
	lastUsed: number;
}

/** Known third-party connectors that need real credentials/OAuth apps we do not have: listed as blocked, never faked. */
export const BLOCKED_CONNECTORS = [
	{ kind: "email (IMAP/SMTP, Gmail, Outlook)", reason: "blocked: 需要邮箱 OAuth 应用或凭据，本部署未配置" },
	{ kind: "calendar (Google / Microsoft 365)", reason: "blocked: 需要 OAuth 客户端与租户授权，本部署未配置" },
	{ kind: "cloud drive (Google Drive / OneDrive)", reason: "blocked: 需要 OAuth 客户端，本部署未配置" },
	{ kind: "chat (Slack / Teams / 飞书 / 钉钉)", reason: "blocked: 需要应用凭据，本部署未配置" },
];

/** Secret values plus their credential part ("Bearer abc…" → also "abc…"), for redaction. */
export function expandSecrets(values: readonly string[]): string[] {
	const out = new Set<string>();
	for (const v of values) {
		if (!v) continue;
		out.add(v);
		const last = v.trim().split(/\s+/).pop()!;
		if (last !== v && last.length >= 6) out.add(last);
	}
	return [...out];
}

const NAME_RE = /[^a-zA-Z0-9_-]/g;
export function piToolName(handle: string, tool: string): string {
	const base = `mcp__${handle}__${tool.replace(NAME_RE, "_")}`;
	if (base.length <= 64) return base;
	let h = 0;
	for (const ch of tool) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return `${base.slice(0, 55)}_${h.toString(36).slice(0, 8)}`;
}

function slug(s: string): string {
	const x = s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20);
	return x || "server";
}

const STDIO_ALLOW = () => (process.env.WORKROOM_MCP_STDIO_ALLOW ?? "").split("\n").flatMap((l) => l.split(";")).map((s) => s.trim()).filter(Boolean);

/** stdio connectors run a process on the server: only commands the operator allowlisted (exact command line prefix). */
export function stdioAllowed(command: string, args: readonly string[]): boolean {
	const line = [command, ...args].join(" ");
	return STDIO_ALLOW().some((prefix) => line === prefix || line.startsWith(`${prefix} `));
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout;
	return Promise.race([p, new Promise<T>((_, rej) => (timer = setTimeout(() => rej(new Error(`${what} 超时（${ms} ms）`)), ms)))]).finally(() => clearTimeout(timer));
}

function classify(e: any, everReady: boolean): { status: ConnectorStatus; detail: string } {
	const msg = String(e?.message ?? e);
	const code = Number(e?.code);
	if (e?.name === "UnauthorizedError" || code === 401 || code === 403 || /\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(msg)) return { status: "unauthorized", detail: `服务端拒绝凭据：${msg.slice(0, 200)}` };
	return { status: everReady ? "needs_reconnect" : "error", detail: msg.slice(0, 300) };
}

export class McpManager {
	readonly #ctx: AppContext;
	readonly box: SecretBox;
	readonly #live = new Map<string, Live>();
	#connecting = new Map<string, Promise<Live>>();
	#toolCache: { stamp: string; tools: ToolRegistration[] } | null = null;
	#timer: NodeJS.Timeout | undefined;
	resolveActor: ActorResolver;
	/** Tests may inject an EffectsApi; otherwise the runtime's `effects` service is used. */
	effectsOverride?: EffectsApi;
	/** Called when the discovered tool set changes (runtime may reinstall the extension). */
	onToolsChanged?: () => void;

	constructor(ctx: AppContext) {
		this.#ctx = ctx;
		this.box = new SecretBox(ctx.config.secretKey);
		this.resolveActor = runtimeActorResolver(ctx);
	}

	start(): void {
		this.#timer = setInterval(() => this.#reapIdle(), 60_000);
		this.#timer.unref();
	}
	async stop(): Promise<void> {
		clearInterval(this.#timer);
		for (const k of [...this.#live.keys()]) await this.disconnect(k.split(":")[0]!);
	}
	#reapIdle(): void {
		for (const [k, l] of this.#live) if (Date.now() - l.lastUsed > 5 * 60_000) {
			this.#live.delete(k);
			void l.client.close().catch(() => {});
		}
	}
	/** Close the connection(s) of a connector (all users', or just one user's). */
	async disconnect(id: string, userId?: string): Promise<void> {
		const keys = [...this.#live.keys()].filter((k) => (userId ? k === `${id}:${userId}` : k === id || k.startsWith(`${id}:`)));
		for (const k of keys) {
			const l = this.#live.get(k);
			this.#live.delete(k);
			if (l) await l.client.close().catch(() => {});
		}
	}
	/** One live connection per connector, except where credentials or the sandbox process are per user. */
	#key(row: McpServerRow, userId?: string): string {
		return (row.credential_mode === "per_user" || row.exec_mode === "sandbox") && userId ? `${row.id}:${userId}` : row.id;
	}

	row(id: string): McpServerRow | undefined {
		return this.#ctx.db.get<McpServerRow>("SELECT * FROM mcp_servers WHERE id = ? AND deleted_at IS NULL", id);
	}
	rows(orgId?: string): McpServerRow[] {
		return orgId ? this.#ctx.db.all<McpServerRow>("SELECT * FROM mcp_servers WHERE org_id = ? AND deleted_at IS NULL ORDER BY created_at", orgId) : this.#ctx.db.all<McpServerRow>("SELECT * FROM mcp_servers WHERE deleted_at IS NULL ORDER BY created_at");
	}
	tools(row: McpServerRow): DiscoveredTool[] {
		return JSON.parse(row.tools_json) as DiscoveredTool[];
	}
	policyOf(row: McpServerRow, t: DiscoveredTool): "read" | "write" {
		const o = (JSON.parse(row.tool_policies) as Record<string, string>)[t.name];
		if (o === "read" || o === "write") return o;
		return t.annotations?.readOnlyHint === true ? "read" : "write";
	}
	/** The manager switched this tool off: the model never sees it and calls are refused. */
	toolDisabled(row: McpServerRow, tool: string): boolean {
		return (JSON.parse(row.tool_policies) as Record<string, string>)[tool] === "disabled";
	}
	/** Per-user, stricter-only overrides: "ask" = always confirm, "disabled" = off for me. */
	toolOverrides(row: McpServerRow, userId: string): Record<string, "ask" | "disabled"> {
		const r = this.#ctx.db.get<{ tool_overrides: string | null }>("SELECT tool_overrides FROM mcp_user_settings WHERE server_id = ? AND user_id = ?", row.id, userId);
		try {
			return r?.tool_overrides ? JSON.parse(r.tool_overrides) : {};
		} catch {
			return {};
		}
	}
	setToolOverrides(row: McpServerRow, userId: string, overrides: Record<string, "ask" | "disabled" | null>): Record<string, "ask" | "disabled"> {
		const cur = this.toolOverrides(row, userId);
		const known = new Set(this.tools(row).map((t) => t.name));
		for (const [k, v] of Object.entries(overrides)) {
			if (!known.has(k)) throw new HttpError(400, "unknown_tool", `连接没有工具 ${k}`);
			if (v === null) delete cur[k];
			else if (v === "ask" || v === "disabled") cur[k] = v;
			else throw new HttpError(400, "invalid", "覆盖值必须是 ask、disabled 或 null");
		}
		this.#ctx.db.run("INSERT INTO mcp_user_settings (server_id, user_id, enabled, updated_at, tool_overrides) VALUES (?, ?, 1, ?, ?) ON CONFLICT(server_id, user_id) DO UPDATE SET tool_overrides = excluded.tool_overrides, updated_at = excluded.updated_at", row.id, userId, nowIso(), JSON.stringify(cur));
		return cur;
	}
	/** Credentials the connection uses for `userId`: the connector's shared secrets, or (per_user) that user's own. Never exposed by any API. */
	secretMap(row: McpServerRow, userId?: string): Record<string, string> {
		try {
			if (row.credential_mode === "per_user") {
				const r = userId ? this.#ctx.db.get<{ secrets_enc: string | null }>("SELECT secrets_enc FROM mcp_user_settings WHERE server_id = ? AND user_id = ?", row.id, userId) : undefined;
				return r?.secrets_enc ? (JSON.parse(this.box.open(r.secrets_enc, `${row.id}:${userId}`)) as Record<string, string>) : {};
			}
			return row.secrets_enc ? (JSON.parse(this.box.open(row.secrets_enc, row.id)) as Record<string, string>) : {};
		} catch {
			return {};
		}
	}
	secretValues(row: McpServerRow, userId?: string): string[] {
		return expandSecrets(Object.values(this.secretMap(row, userId)));
	}
	mySecretNames(row: McpServerRow, userId: string): string[] {
		return Object.keys(this.secretMap(row, userId));
	}
	/** Store the caller's own credentials for a per_user connector (encrypted, AAD = connector + user). */
	setMySecrets(row: McpServerRow, userId: string, secrets: Readonly<Record<string, string>>): void {
		if (row.credential_mode !== "per_user") throw new HttpError(409, "shared_credentials", "该连接使用共享凭据，由管理员维护");
		const required = new Set<string>(JSON.parse(row.secret_names));
		for (const k of Object.keys(secrets)) if (!required.has(k)) throw new HttpError(400, "unknown_secret", `该连接不需要凭据 ${k}`);
		const names = Object.keys(secrets);
		const sealed = names.length ? this.box.seal(JSON.stringify(secrets), `${row.id}:${userId}`) : null; // throws without a secret key
		this.#ctx.db.run("INSERT INTO mcp_user_settings (server_id, user_id, enabled, updated_at, secrets_enc) VALUES (?, ?, 1, ?, ?) ON CONFLICT(server_id, user_id) DO UPDATE SET secrets_enc = excluded.secrets_enc, updated_at = excluded.updated_at", row.id, userId, nowIso(), sealed);
		void this.disconnect(row.id, userId);
		this.#toolCache = null;
	}

	// ----- access -----
	/** ACL resolver for ResourceRef kind "connector". read/use: may see/use it; write/admin: may manage it. */
	async decide(p: Principal, action: string, id: string): Promise<Decision> {
		const r = this.row(id);
		if (!r) return { allow: false, reason: "not_found" };
		if (r.org_id !== p.orgId) return { allow: false, reason: "other_org" };
		if (r.scope === "personal") return r.owner_user_id === p.userId ? { allow: true, reason: "owner" } : { allow: false, reason: "personal_connector" };
		// Organisation connectors are managed by whoever may add them (mcp.connector.add_org) or review them (market.review).
		const market = this.#ctx.services.get("market") as Market;
		const manager = (await market.can(p, "mcp.connector.add_org")) || (await market.can(p, "market.review"));
		if (action === "read" || action === "use") {
			if (r.access === "admins" && !manager) return { allow: false, reason: "admins_only" };
			return { allow: true, reason: "org_member" };
		}
		return manager ? { allow: true, reason: "connector_manager" } : { allow: false, reason: "not_admin" };
	}
	enabledFor(row: McpServerRow, userId: string): boolean {
		const s = this.#ctx.db.get<{ enabled: number }>("SELECT enabled FROM mcp_user_settings WHERE server_id = ? AND user_id = ?", row.id, userId);
		return s ? s.enabled === 1 : true;
	}
	/** Everything checked at call time: connector live, access by current ACL, user enablement, status. */
	async usable(p: Principal, row: McpServerRow): Promise<{ ok: true } | { ok: false; reason: string; message: string }> {
		const d = await this.#ctx.services.get("acl").check(p, "use", { kind: "connector", id: row.id });
		if (!d.allow) return { ok: false, reason: d.reason, message: `无权使用连接「${row.name}」（${d.reason}）` };
		if (!row.enabled) return { ok: false, reason: "disabled", message: `连接「${row.name}」已被停用` };
		if (!this.enabledFor(row, p.userId)) return { ok: false, reason: "user_disabled", message: `你已关闭连接「${row.name}」，在“连接”中启用后再试` };
		if (row.approval_state === "pending") return { ok: false, reason: "pending_approval", message: `连接「${row.name}」正在等待审核，通过后才会连接` };
		if (row.approval_state === "rejected") return { ok: false, reason: "rejected", message: `连接「${row.name}」未通过审核` };
		if (row.credential_mode === "per_user") {
			const need: string[] = JSON.parse(row.secret_names);
			const have = this.mySecretNames(row, p.userId);
			if (need.some((n) => !have.includes(n))) return { ok: false, reason: "no_credentials", message: `连接「${row.name}」需要你自己的凭据（${need.join("、")}），请在“我的连接”里填写` };
		}
		if (row.status === "unauthorized") return { ok: false, reason: "unauthorized", message: `连接「${row.name}」凭据被拒绝，需要重新授权` };
		return { ok: true };
	}

	// ----- config -----
	create(
		p: Principal,
		input: { name: string; scope: "system" | "personal"; transport: "stdio" | "http"; command?: string; args?: readonly string[]; url?: string; secrets?: Readonly<Record<string, string>>; env?: Readonly<Record<string, string>>; toolPolicies?: Readonly<Record<string, "read" | "write" | "disabled">>; access?: "members" | "admins" },
		opts: { approval?: "approved" | "pending"; sandbox?: SandboxPackage; credentialMode?: "shared" | "per_user"; requiredSecretNames?: readonly string[]; catalogVersionId?: string } = {},
	): McpServerRow {
		const name = String(input.name ?? "").trim().slice(0, 80);
		if (!name) throw new HttpError(400, "invalid", "连接名称必填");
		if (input.scope !== "system" && input.scope !== "personal") throw new HttpError(400, "invalid", "scope 必须是 system 或 personal");
		// System connectors need mcp.connector.add_org: enforced by the callers (routes, MCP market) with the authz service.
		if (input.transport === "stdio") {
			if (opts.sandbox) {
				// stdio inside the sandbox (service mode): allowed for personal and system connectors; never runs on the host.
				if (!opts.sandbox.argv.length) throw new HttpError(400, "invalid", "沙箱 stdio 连接需要 argv");
			} else {
				if (input.scope !== "system") throw new HttpError(403, "stdio_forbidden", "个人连接只能使用 HTTP，或通过 MCP 市场安装在沙箱中运行的 stdio 服务器（裸 stdio 会在服务器主机上启动进程，仅限管理员添加系统连接）");
				if (!input.command) throw new HttpError(400, "invalid", "stdio 连接需要 command");
				if (!stdioAllowed(input.command, input.args ?? [])) throw new HttpError(403, "stdio_not_allowlisted", "该命令不在运维允许列表（WORKROOM_MCP_STDIO_ALLOW）中");
			}
		} else if (input.transport === "http") {
			if (!input.url) throw new HttpError(400, "invalid", "HTTP 连接需要 url");
			new URL(input.url);
		} else throw new HttpError(400, "invalid", "transport 必须是 stdio 或 http");
		const secrets = input.secrets ?? {};
		const id = newId("mcp");
		let sealed: string | null = null;
		const perUser = opts.credentialMode === "per_user";
		if (Object.keys(secrets).length && !perUser) sealed = this.box.seal(JSON.stringify(secrets), id); // throws without a secret key
		if (perUser && Object.keys(secrets).length) throw new HttpError(400, "invalid", "每用户凭据的连接不在创建时保存凭据，请每位用户各自填写");
		if (perUser && !this.box.available) throw new HttpError(400, "secret_storage_unavailable", "服务器未配置 WORKROOM_SECRET_KEY，无法安全保存每用户凭据");
		const secretNames = perUser ? [...(opts.requiredSecretNames ?? [])] : Object.keys(secrets);
		let handle = slug(name);
		for (let n = 2; this.#ctx.db.get("SELECT 1 FROM mcp_servers WHERE handle = ?", handle); n++) handle = `${slug(name).slice(0, 17)}_${n}`;
		const now = nowIso();
		this.#ctx.db.run(
			`INSERT INTO mcp_servers (id, org_id, scope, owner_user_id, handle, name, transport, command, args, url, env, secrets_enc, secret_names, tool_policies, access, created_by, created_at, updated_at, approval_state, exec_mode, credential_mode, catalog_version_id, package_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, p.orgId, input.scope, input.scope === "personal" ? p.userId : null, handle, name, input.transport, input.command ?? null, input.args ? JSON.stringify(input.args) : null, input.url ?? null,
			input.env ? JSON.stringify(input.env) : null, sealed, JSON.stringify(secretNames), JSON.stringify(input.toolPolicies ?? {}), input.access === "admins" ? "admins" : "members", p.userId, now, now,
			opts.approval ?? "approved", opts.sandbox ? "sandbox" : "host", opts.credentialMode ?? "shared", opts.catalogVersionId ?? null, opts.sandbox ? JSON.stringify(opts.sandbox) : null,
		);
		this.#audit(p, "connector.create", id, { name, scope: input.scope, transport: input.transport, secretNames, approval: opts.approval ?? "approved", execMode: opts.sandbox ? "sandbox" : "host", credentialMode: opts.credentialMode ?? "shared" });
		return this.row(id)!;
	}

	update(p: Principal, row: McpServerRow, patch: { name?: string; enabled?: boolean; secrets?: Readonly<Record<string, string>>; toolPolicies?: Readonly<Record<string, "read" | "write" | "disabled">>; access?: "members" | "admins"; url?: string }): McpServerRow {
		if (patch.toolPolicies) for (const [k, v] of Object.entries(patch.toolPolicies)) if (v !== "read" && v !== "write" && v !== "disabled") throw new HttpError(400, "invalid", `工具 ${k} 的策略必须是 read、write 或 disabled`);
		if (patch.secrets !== undefined && row.credential_mode === "per_user") throw new HttpError(409, "per_user_credentials", "该连接使用每用户凭据，请每位用户在“我的连接”里各自填写");
		const sets: string[] = [];
		const vals: (string | number | null)[] = [];
		if (patch.name !== undefined) (sets.push("name = ?"), vals.push(String(patch.name).trim().slice(0, 80) || row.name));
		if (patch.enabled !== undefined) (sets.push("enabled = ?", "status = ?"), vals.push(patch.enabled ? 1 : 0, patch.enabled ? "unchecked" : "disabled"));
		if (patch.toolPolicies !== undefined) (sets.push("tool_policies = ?"), vals.push(JSON.stringify(patch.toolPolicies)));
		if (patch.access !== undefined) (sets.push("access = ?"), vals.push(patch.access === "admins" ? "admins" : "members"));
		if (patch.url !== undefined && row.transport === "http") (sets.push("url = ?"), vals.push(patch.url));
		if (patch.secrets !== undefined) {
			const names = Object.keys(patch.secrets);
			sets.push("secrets_enc = ?", "secret_names = ?", "status = ?");
			vals.push(names.length ? this.box.seal(JSON.stringify(patch.secrets), row.id) : null, JSON.stringify(names), "unchecked");
		}
		if (!sets.length) return row;
		sets.push("updated_at = ?");
		vals.push(nowIso());
		this.#ctx.db.run(`UPDATE mcp_servers SET ${sets.join(", ")} WHERE id = ?`, ...vals, row.id);
		void this.disconnect(row.id);
		this.#toolCache = null;
		this.#audit(p, "connector.update", row.id, { fields: Object.keys(patch), secretNames: patch.secrets ? Object.keys(patch.secrets) : undefined });
		return this.row(row.id)!;
	}

	remove(p: Principal, row: McpServerRow): void {
		this.#ctx.db.run("UPDATE mcp_servers SET deleted_at = ?, updated_at = ?, secrets_enc = NULL WHERE id = ?", nowIso(), nowIso(), row.id);
		this.#ctx.db.run("UPDATE mcp_user_settings SET secrets_enc = NULL WHERE server_id = ?", row.id);
		void this.disconnect(row.id);
		this.#toolCache = null;
		this.onToolsChanged?.();
		this.#audit(p, "connector.delete", row.id, { name: row.name });
	}

	setEnabledFor(userId: string, row: McpServerRow, enabled: boolean): void {
		this.#ctx.db.run("INSERT INTO mcp_user_settings (server_id, user_id, enabled, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(server_id, user_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at", row.id, userId, enabled ? 1 : 0, nowIso());
	}

	#audit(p: Principal, action: string, target: string, detail: unknown): void {
		try {
			this.#ctx.db.run("INSERT INTO id_audit (id, org_id, actor_user_id, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)", newId("aud"), p.orgId, p.userId, action, target, JSON.stringify(detail), nowIso());
		} catch {
			/* audit table owned by E; absence must not break connectors */
		}
	}

	#setStatus(id: string, status: ConnectorStatus, detail: string | null, tools?: DiscoveredTool[]): void {
		const prev = this.row(id);
		this.#ctx.db.run(
			`UPDATE mcp_servers SET status = ?, status_detail = ?, last_checked_at = ?, ever_ready = CASE WHEN ? = 'ready' THEN 1 ELSE ever_ready END${tools ? ", tools_json = ?" : ""} WHERE id = ?`,
			...([status, detail, nowIso(), status, ...(tools ? [JSON.stringify(tools)] : []), id] as (string | null)[]),
		);
		if (tools && prev && prev.tools_json !== JSON.stringify(tools)) {
			this.#toolCache = null;
			this.onToolsChanged?.();
		}
	}

	// ----- connections -----
	async #connect(row: McpServerRow, userId?: string): Promise<Live> {
		let secrets: Record<string, string> = {};
		if (row.credential_mode === "per_user") secrets = this.secretMap(row, userId);
		else if (row.secrets_enc) {
			try {
				secrets = JSON.parse(this.box.open(row.secrets_enc, row.id));
			} catch {
				throw Object.assign(new Error("保存的凭据无法解密（服务器密钥缺失或已更换），请重新填写凭据"), { reconnect: true });
			}
		}
		const client = new Client({ name: "workroom", version: "1.0.0" }, { capabilities: {} });
		if (row.transport === "stdio" && row.exec_mode === "sandbox") {
			await withTimeout(client.connect(await this.#sandboxTransport(row, userId, secrets)), 30_000, "连接");
		} else if (row.transport === "stdio") {
			if (!stdioAllowed(row.command!, JSON.parse(row.args ?? "[]"))) throw new Error("该命令已不在运维允许列表中");
			const transport = new StdioClientTransport({
				command: row.command!,
				args: JSON.parse(row.args ?? "[]"),
				// Only the SDK's safe default environment (PATH, HOME, …) plus this connector's own env: never the server's secrets.
				env: { ...getDefaultEnvironment(), ...(row.env ? JSON.parse(row.env) : {}), ...secrets },
				stderr: "pipe",
			});
			transport.stderr?.on("data", () => {}); // drained, never logged (may echo secrets)
			await withTimeout(client.connect(transport), 15_000, "连接");
		} else {
			const checked = await checkUrl(row.url!, { allowPrivate: row.scope === "system", orgId: row.org_id });
			// Every request connects to the validated, pinned address (no DNS rebinding between check and connect).
			const transport = new StreamableHTTPClientTransport(new URL(row.url!), { requestInit: { headers: secrets }, fetch: pinnedFetch({ allowPrivate: row.scope === "system", orgId: row.org_id, pins: new Map([[checked.url.origin, checked.addresses[0]!]]) }) as any });
			await withTimeout(client.connect(transport), 15_000, "连接");
		}
		const live: Live = { client, secrets: expandSecrets(Object.values(secrets)), stamp: row.updated_at, lastUsed: Date.now() };
		const key = this.#key(row, userId);
		client.onclose = () => {
			if (this.#live.get(key) === live) this.#live.delete(key);
		};
		return live;
	}

	/** stdio MCP servers never run on the host: they run in the sandbox's service mode (read-only package mount, no network unless allowed). */
	async #sandboxTransport(row: McpServerRow, userId: string | undefined, secrets: Record<string, string>): Promise<Transport> {
		const pkg = JSON.parse(row.package_json ?? "null") as SandboxPackage | null;
		if (!pkg) throw new Error("沙箱 stdio 连接缺少运行配置（package_json）");
		const uid = userId ?? row.owner_user_id ?? row.created_by;
		const principal = await this.#ctx.services.get("identity").principalFor(uid, row.org_id);
		if (!principal) throw new Error("连接的使用者已不存在或已停用");
		const space = this.#ctx.services.get("identity").personalSpace(principal.userId, principal.orgId);
		const mounts: { hostPath: string; target: string; readOnly: boolean }[] = [];
		let argv = pkg.argv;
		if (pkg.bundleVersionId) {
			const mm = this.#ctx.services.get("mcpMarket") as { materializeBundle(versionId: string): { dir: string; slug: string } };
			const b = mm.materializeBundle(pkg.bundleVersionId);
			mounts.push({ hostPath: b.dir, target: `/mcp/${b.slug}`, readOnly: true });
			argv = argv.map((a) => a.replaceAll("${MCP_DIR}", `/mcp/${b.slug}`));
		}
		const svc = await this.sandboxOverride(row.id, uid, async (sb) =>
			sb.acquireService(`mcp:${row.id}:${uid}`, { principal, space, runtime: pkg.runtime, argv, env: { ...(row.env ? JSON.parse(row.env) : {}), ...secrets }, mounts, network: pkg.network === true }),
		);
		return serviceTransport(svc);
	}
	/** Seam for tests: run the sandbox call through a replacement (a fake sandbox that spawns the process directly). */
	sandboxOverride: (connectorId: string, userId: string, fn: (sb: Sandbox) => Promise<import("./sandbox/services.ts").SandboxService>) => Promise<import("./sandbox/services.ts").SandboxService> = (_id, _u, fn) => fn(this.#ctx.services.get("sandbox") as Sandbox);

	async #client(row: McpServerRow, userId?: string): Promise<Live> {
		const key = this.#key(row, userId);
		const l = this.#live.get(key);
		if (l && l.stamp === row.updated_at) {
			l.lastUsed = Date.now();
			return l;
		}
		if (l) await this.disconnect(row.id, userId);
		let p = this.#connecting.get(key);
		if (!p) {
			p = this.#connect(row, userId).finally(() => this.#connecting.delete(key));
			this.#connecting.set(key, p);
		}
		const live = await p;
		this.#live.set(key, live);
		return live;
	}

	/** Health check: connect, list tools, record status. Never throws. */
	async check(id: string, userId?: string): Promise<McpServerRow> {
		const row = this.row(id);
		if (!row) throw new HttpError(404, "not_found", "连接不存在");
		if (!row.enabled) {
			this.#setStatus(id, "disabled", "已停用");
			return this.row(id)!;
		}
		if (row.approval_state !== "approved") {
			// Never connect (or probe a URL / start a process) for something a reviewer has not approved.
			this.#setStatus(id, "unchecked", row.approval_state === "pending" ? "等待审核，通过后才会连接" : "未通过审核");
			return this.row(id)!;
		}
		const uid = userId ?? (row.scope === "personal" ? row.owner_user_id ?? undefined : undefined);
		try {
			await this.disconnect(id, row.credential_mode === "per_user" || row.exec_mode === "sandbox" ? uid : undefined);
			const l = await this.#client(row, uid);
			const tools: DiscoveredTool[] = [];
			let cursor: string | undefined;
			for (let page = 0; page < 50; page++) {
				const r = await withTimeout(l.client.listTools(cursor ? { cursor } : undefined), 15_000, "工具发现");
				for (const t of r.tools) tools.push({ name: t.name, description: t.description ?? "", inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object" }, annotations: t.annotations as DiscoveredTool["annotations"] });
				cursor = r.nextCursor;
				if (!cursor) break;
			}
			this.#setStatus(id, "ready", `${tools.length} 个工具`, tools);
		} catch (e: any) {
			await this.disconnect(id, row.credential_mode === "per_user" || row.exec_mode === "sandbox" ? uid : undefined);
			const c = e?.reconnect ? { status: "needs_reconnect" as const, detail: String(e.message) } : classify(e, row.ever_ready === 1);
			this.#setStatus(id, c.status, redactText(c.detail, this.secretValues(row, uid)));
		}
		return this.row(id)!;
	}

	async callTool(row: McpServerRow, tool: string, args: Record<string, unknown>, opts: { idempotencyKey?: string; retry: boolean; userId?: string }): Promise<{ content: any[]; isError: boolean; structuredContent?: unknown }> {
		const attempt = async () => {
			const l = await this.#client(row, opts.userId);
			const r: any = await l.client.callTool({ name: tool, arguments: args, ...(opts.idempotencyKey ? { _meta: { idempotencyKey: opts.idempotencyKey } } : {}) }, undefined, { timeout: 60_000 });
			return { content: (r.content ?? []) as any[], isError: !!r.isError, structuredContent: r.structuredContent };
		};
		try {
			return await attempt();
		} catch (e: any) {
			await this.disconnect(row.id, opts.userId && this.#key(row, opts.userId) !== row.id ? opts.userId : undefined);
			if (/unauthori[sz]ed|\b401\b|\b403\b/i.test(String(e?.message)) || e?.code === 401) {
				this.#setStatus(row.id, "unauthorized", redactText(String(e.message), this.secretValues(row, opts.userId)));
				throw e;
			}
			if (!opts.retry) {
				this.#setStatus(row.id, "needs_reconnect", redactText(String(e?.message ?? e), this.secretValues(row, opts.userId)));
				throw e;
			}
			try {
				return await attempt();
			} catch (e2: any) {
				const c = classify(e2, true);
				this.#setStatus(row.id, c.status, redactText(c.detail, this.secretValues(row, opts.userId)));
				throw e2;
			}
		}
	}

	// ----- DTOs -----
	toolDTOs(row: McpServerRow, userId?: string): ConnectorToolDTO[] {
		const ov = userId ? this.toolOverrides(row, userId) : {};
		return this.tools(row).map((t) => ({
			name: piToolName(row.handle, t.name),
			tool: t.name,
			description: t.description,
			policy: this.policyOf(row, t),
			inputSchema: t.inputSchema,
			disabled: this.toolDisabled(row, t.name) || ov[t.name] === "disabled" || undefined,
			userOverride: ov[t.name],
		}));
	}
	async dto(p: Principal, row: McpServerRow): Promise<ConnectorDTO> {
		const use = await this.decide(p, "use", row.id);
		const manage = await this.decide(p, "admin", row.id);
		const sub = this.#ctx.db.get<{ id: string }>("SELECT id FROM market_submissions WHERE kind = 'mcp_connector' AND subject_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", row.id);
		return {
			id: row.id,
			handle: row.handle,
			name: row.name,
			scope: row.scope,
			transport: row.transport,
			command: manage.allow ? (row.command ?? undefined) : undefined,
			args: manage.allow && row.args ? JSON.parse(row.args) : undefined,
			url: row.url ?? undefined,
			secretNames: JSON.parse(row.secret_names),
			status: row.enabled ? row.status : "disabled",
			statusDetail: row.status_detail ?? undefined,
			lastCheckedAt: row.last_checked_at ?? undefined,
			tools: this.toolDTOs(row, p.userId),
			access: use.allow ? "allowed" : "forbidden",
			accessReason: use.allow ? undefined : use.reason,
			enabledForMe: this.enabledFor(row, p.userId),
			canManage: manage.allow,
			market: {
				approvalState: row.approval_state,
				submissionId: sub?.id,
				execMode: row.exec_mode,
				credentialMode: row.credential_mode,
				catalogId: row.catalog_version_id ? (this.#ctx.db.get<{ catalog_id: string }>("SELECT catalog_id FROM mcp_catalog_versions WHERE id = ?", row.catalog_version_id)?.catalog_id ?? undefined) : undefined,
				mySecretNames: row.credential_mode === "per_user" ? this.mySecretNames(row, p.userId) : [],
				toolOverrides: this.toolOverrides(row, p.userId),
				requiredSecretNames: row.credential_mode === "per_user" ? JSON.parse(row.secret_names) : [],
			},
		};
	}

	// ----- pi tools -----
	/** Namespaced deferred tools of every discovered connector (all tenants; access is enforced per call and in tool_search). */
	piTools(): ToolRegistration[] {
		const rows = this.rows().filter((r) => r.enabled);
		const stamp = rows.map((r) => `${r.id}:${r.updated_at}:${r.tools_json.length}:${r.tool_policies}`).join("|");
		if (this.#toolCache?.stamp === stamp) return this.#toolCache.tools;
		const tools: ToolRegistration[] = [];
		const seen = new Set<string>();
		for (const r of rows) for (const t of this.tools(r)) {
			if (this.toolDisabled(r, t.name)) continue; // switched off by the manager: the model never sees it
			const name = piToolName(r.handle, t.name);
			if (seen.has(name)) continue;
			seen.add(name);
			tools.push(this.#piTool(r.id, r.name, t, this.policyOf(r, t), name));
		}
		this.#toolCache = { stamp, tools };
		return tools;
	}

	#piTool(serverId: string, serverName: string, t: DiscoveredTool, policy: "read" | "write", name: string): ToolRegistration {
		const schema = { type: "object", ...t.inputSchema } as Record<string, unknown>;
		delete schema.$schema;
		return defineTool<any>({
			name,
			description: `[${serverName}${policy === "write" ? " · 写操作，需要确认" : ""}] ${t.description || t.name}`.slice(0, 1024),
			parameters: schema,
			deferred: true,
			// Model only: the registry is process-wide, so code mode's searchTools() could otherwise list other orgs' connector
			// tools by name. Access is still re-checked on every call.
			callers: ["model"],
			// Reads may rerun after a crash. Writes are replay-safe only through the effects protocol: a rerun finds the
			// recorded receipt (done) or an unconfirmed dispatch (needs_reconciliation) and never calls the server blindly.
			replay: "safe",
			execute: (args, api, context) => this.execute(serverId, t.name, policy, (args ?? {}) as Record<string, unknown>, api, context),
		});
	}

	async execute(serverId: string, tool: string, policy: "read" | "write", args: Record<string, unknown>, api: ToolExecutionApi<any>, context: Context): Promise<ToolExecutionResult> {
		const actor = await this.resolveActor(api, context);
		const log = this.#ctx.services.get("toolCalls") as ToolCallLog;
		const row = this.row(serverId);
		const toolName = row ? piToolName(row.handle, tool) : `mcp__?__${tool}`;
		const uid = actor.principal.userId;
		const secrets = row ? this.secretValues(row, uid) : [];
		const recId = log.start({ tool: toolName, connectorId: serverId, actor, args, secrets });
		const fail = (status: "error" | "denied" | "needs_reconciliation", message: string): ToolExecutionResult => {
			log.finish(recId, { status, error: message, secrets });
			return { output: [{ type: "text", text: message }], isError: true, details: { connectorId: serverId, tool, status } };
		};
		if (!row) return fail("error", "该连接已被删除");
		const u = await this.usable(actor.principal, row);
		if (!u.ok) return fail("denied", u.message);
		if (!this.tools(row).some((x) => x.name === tool)) return fail("error", `连接「${row.name}」已不再提供工具 ${tool}，请重新检查连接`);
		if (this.toolDisabled(row, tool)) return fail("denied", `管理员已关闭连接「${row.name}」的工具 ${tool}`);
		const override = this.toolOverrides(row, uid)[tool];
		if (override === "disabled") return fail("denied", `你已关闭连接「${row.name}」的工具 ${tool}（可在“我的连接”里重新开启）`);
		// "ask" = the caller wants a confirmation even for tools the connector declares read-only.
		const effective: "read" | "write" = override === "ask" ? "write" : policy;
		try {
			let result: { content: any[]; isError: boolean; structuredContent?: unknown };
			if (effective === "read") {
				result = await this.callTool(row, tool, args, { retry: true, userId: uid });
			} else {
				const effects = this.effectsOverride ?? (this.#ctx.services.has("effects") ? (this.#ctx.services.get("effects") as EffectsApi) : null);
				if (!effects) return fail("denied", "写操作需要审批与回执服务（运行内核未提供 effects），本次未执行");
				const summary = `通过连接「${row.name}」调用 ${tool}，参数：${summarizeArgs(args, secrets, 600)}`;
				const decision = await effects.requestApproval(api, { title: `确认外部操作：${row.name} / ${tool}`, summary, detail: JSON.parse(summarizeArgs(args, secrets)), risk: "medium" }, context);
				if (decision.decision !== "approved") return fail("denied", `用户未批准此操作${decision.note ? `（${decision.note}）` : ""}，未执行`);
				const outcome = await effects.externalEffect(api, { key: `mcp:${serverId}:${tool}:${actor.callId}`, target: `${row.name}/${tool}`, summary }, async (idempotencyKey) => {
					const r = await this.callTool(row, tool, args, { idempotencyKey, retry: false, userId: uid });
					return JSON.parse(JSON.stringify({ content: r.content, isError: r.isError })) as any;
				}, context);
				if (outcome.status === "needs_reconciliation") return fail("needs_reconciliation", `外部写操作结果不确定（进程在执行中断开），未自动重做，请人工核对：${outcome.detail}（effect ${outcome.effectId}）`);
				result = outcome.receipt as any;
			}
			const output = this.#content(result.content, secrets);
			const text = output.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
			log.finish(recId, { status: result.isError ? "error" : "ok", error: result.isError ? text.slice(0, 500) : undefined, result: text.slice(0, 300), secrets });
			return { output: output.length ? output : [{ type: "text", text: "（无输出）" }], isError: result.isError, details: { connectorId: serverId, connector: row.name, tool, policy: effective } };
		} catch (e: any) {
			// The approval wait was handed to a durable watcher (the call must end without executing): not a failure of the connector.
			if (e?.code === "approval_parked") {
				log.finish(recId, { status: "denied", error: "等待审批（已转入后台等待），未执行", secrets });
				throw e;
			}
			const msg = redactText(String(e?.message ?? e), secrets);
			log.finish(recId, { status: "error", error: msg, secrets });
			return { output: [{ type: "text", text: `调用连接「${row.name}」的 ${tool} 失败：${msg}` }], isError: true, details: { connectorId: serverId, tool, status: this.row(serverId)?.status ?? "error" } };
		}
	}

	#content(content: any[], secrets: readonly string[]): any[] {
		const out: any[] = [];
		for (const c of content ?? []) {
			if (c?.type === "text") out.push({ type: "text", text: redactText(String(c.text), secrets) });
			else if (c?.type === "image" && typeof c.data === "string") out.push({ type: "image", data: c.data, mimeType: c.mimeType });
			else if (c?.type === "resource") out.push({ type: "text", text: redactText(JSON.stringify(c.resource).slice(0, 20_000), secrets) });
			else out.push({ type: "text", text: redactText(JSON.stringify(c).slice(0, 5000), secrets) });
		}
		return out;
	}
}

// ----- tool_search: restricted to what the acting user may use -----

/**
 * The tools tool_search may load for this actor: deferred tools (connector tools of servers the user may use and has enabled) and the
 * built-in on-demand tools hidden from this conversation (unless the org switched their group off). Legacy skill tools are never offered.
 */
export async function loadableTools(mgr: McpManager, ctx: AppContext, agent: { deferred: readonly ToolRegistration[]; extensions: readonly { tools?: readonly ToolRegistration[] }[]; tools: readonly ToolRegistration[] }, actor: ToolActor): Promise<ToolRegistration[]> {
	const policy = ctx?.services?.has("toolPolicy") ? (ctx.services.get("toolPolicy") as ToolPolicy) : undefined;
	const orgId = actor.principal.orgId;
	const allowedServers = new Map<string, boolean>();
	const byPiName = new Map<string, McpServerRow>();
	const rawName = new Map<string, string>();
	for (const r of mgr.rows(orgId)) for (const t of mgr.tools(r)) {
		byPiName.set(piToolName(r.handle, t.name), r);
		rawName.set(piToolName(r.handle, t.name), t.name);
	}
	const offered = new Set(agent.tools.map((t) => t.name));
	const hidden = agent.extensions.flatMap((e) => e.tools ?? []).filter((t) => ONDEMAND_TOOLS.includes(t.name) && !offered.has(t.name) && (t.callers === undefined || t.callers.includes("model")));
	const out: ToolRegistration[] = [];
	for (const t of [...agent.deferred, ...hidden]) {
		if (/^skill_(list|load|read|run)$/.test(t.name)) continue; // legacy skill tools: superseded by the `skill` tool, never offered
		if (policy && !policy.allowed(orgId, t.name)) continue; // switched off by the organisation: not listed, not loaded
		if (t.name.startsWith("mcp__")) {
			const r = byPiName.get(t.name);
			if (!r) continue; // another org's connector: never shown
			if (!allowedServers.has(r.id)) allowedServers.set(r.id, (await mgr.usable(actor.principal, r)).ok);
			if (!allowedServers.get(r.id)) continue;
			const raw = rawName.get(t.name)!;
			if (mgr.toolDisabled(r, raw) || mgr.toolOverrides(r, actor.principal.userId)[raw] === "disabled") continue; // off for this user
		}
		out.push(t);
	}
	return out;
}

function searchText(t: ToolRegistration): string {
	const g = ondemandGroupOf(t.name);
	return `${t.name.replace(/_/g, " ")} ${t.description} ${g ? `${g.label} ${g.keywords}` : ""}`;
}

export function createToolSearch(mgr: McpManager, ctx: AppContext) {
	return defineTool({
		name: "tool_search",
		description:
			"按需加载工具：搜索「按需能力」目录里的内置工具和已连接的连接器（MCP）工具，命中的工具从下一步起可直接调用并保持可用。" +
			"系统提示中没有、但任务需要的能力（凭据、后台任务、实时浏览器、脚本编排、连接器等）先用它查找；只搜当前用户可用的工具。",
		parameters: obj({ query: str({ description: "需要的能力，如「申请 API 密钥」「后台运行」「create calendar event」" }), limit: opt(num()) }, { open: true }),
		callers: ["model"],
		replay: "safe",
		async execute({ query, limit }, api, context) {
			if (!query.trim()) throw new Error("query must not be empty");
			const actor: ToolActor = await mgr.resolveActor(api, context);
			const agent = await api.agent(context);
			const candidates = await loadableTools(mgr, ctx, agent, actor);
			const max = Math.max(1, Math.min(Math.floor(limit ?? 8), 20));
			const ranked = candidates
				.map((t) => ({ t, s: rankScore(query, searchText(t)) }))
				.filter((x) => x.s > 0)
				.sort((a, b) => b.s - a.s)
				// Single shared bigrams (e.g. "用户") are noise: load only candidates close to the best match.
				.filter((x, _i, all) => x.s >= all[0]!.s * 0.25)
				.slice(0, max)
				.map((x) => x.t);
			const loaded = ranked.map((t) => t.name);
			// Skills the user has active are discovered here too (they are used by reading /skills/<name>/SKILL.md, not as tools).
			let skillHint = "";
			try {
				const sk = ctx?.services?.has("skills") ? (ctx.services.get("skills") as any) : null;
				if (sk) {
					const active = (await sk.active(actor.principal, actor.space, actor.conversationId)) as { skill: { name: string }; version: { description: string } }[];
					const hits = active.map((a) => ({ a, s: rankScore(query, `${a.skill.name} ${a.version.description}`) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).slice(0, 5);
					if (hits.length) skillHint = `\n\nMatching skills (use the skill tool: action=load with name=<slug>):\n${hits.map((h) => `- ${h.a.skill.name}: ${h.a.version.description.slice(0, 120)}`).join("\n")}`;
				}
			} catch {
				/* skills are optional here */
			}
			const miss = candidates.length ? `No matching tools. Loadable now: ${candidates.slice(0, 30).map((t) => t.name).join(", ")}${candidates.length > 30 ? ", …" : ""}` : "No matching tools found (or none you may use).";
			const text = (loaded.length ? `Loaded ${loaded.length} tool(s). They are available from your next call:\n${ranked.map((t) => `- ${t.name}: ${t.description.split("\n")[0]!.slice(0, 160)}`).join("\n")}` : miss) + skillHint;
			return { output: [{ type: "text", text }], details: { loaded }, ...(loaded.length ? { control: { addTools: loaded } } : {}) };
		},
	});
}
