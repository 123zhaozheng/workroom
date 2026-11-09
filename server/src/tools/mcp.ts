// MCP connectors (M04): system (org admin) and personal server configs, encrypted secrets, health/status, tool discovery,
// namespaced deferred pi tools, per-user enablement checked at call time, call records, approval + effect protocol for writes.
import type { Context } from "@earendil-works/chord/context";
import { defineTool, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AppContext, Decision, EffectsApi, Principal, ToolActor } from "../core/contracts.ts";
import type { Migration } from "../core/db.ts";
import { HttpError, newId, nowIso } from "../core/http.ts";
import type { ConnectorDTO, ConnectorStatus, ConnectorToolDTO } from "../../../shared/files.ts";
import { runtimeActorResolver, type ActorResolver } from "../files/actor.ts";
import { redactText, summarizeArgs, type ToolCallLog } from "./calls.ts";
import { checkUrl, pinnedFetch } from "./netpolicy.ts";
import { SecretBox } from "./secrets.ts";

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
		for (const id of [...this.#live.keys()]) await this.disconnect(id);
	}
	#reapIdle(): void {
		for (const [id, l] of this.#live) if (Date.now() - l.lastUsed > 5 * 60_000) void this.disconnect(id);
	}
	async disconnect(id: string): Promise<void> {
		const l = this.#live.get(id);
		this.#live.delete(id);
		if (l) await l.client.close().catch(() => {});
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
		const o = (JSON.parse(row.tool_policies) as Record<string, "read" | "write">)[t.name];
		if (o === "read" || o === "write") return o;
		return t.annotations?.readOnlyHint === true ? "read" : "write";
	}
	secretValues(row: McpServerRow): string[] {
		if (!row.secrets_enc) return [];
		try {
			return expandSecrets(Object.values(JSON.parse(this.box.open(row.secrets_enc, row.id)) as Record<string, string>));
		} catch {
			return [];
		}
	}

	// ----- access -----
	/** ACL resolver for ResourceRef kind "connector". read/use: may see/use it; write/admin: may manage it. */
	async decide(p: Principal, action: string, id: string): Promise<Decision> {
		const r = this.row(id);
		if (!r) return { allow: false, reason: "not_found" };
		if (r.org_id !== p.orgId) return { allow: false, reason: "other_org" };
		const isAdmin = p.orgRole === "owner" || p.orgRole === "admin";
		if (r.scope === "personal") return r.owner_user_id === p.userId ? { allow: true, reason: "owner" } : { allow: false, reason: "personal_connector" };
		if (action === "read" || action === "use") {
			if (r.access === "admins" && !isAdmin) return { allow: false, reason: "admins_only" };
			return { allow: true, reason: "org_member" };
		}
		return isAdmin ? { allow: true, reason: p.orgRole } : { allow: false, reason: "not_admin" };
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
		if (row.status === "unauthorized") return { ok: false, reason: "unauthorized", message: `连接「${row.name}」凭据被拒绝，需要重新授权` };
		return { ok: true };
	}

	// ----- config -----
	create(p: Principal, input: { name: string; scope: "system" | "personal"; transport: "stdio" | "http"; command?: string; args?: readonly string[]; url?: string; secrets?: Readonly<Record<string, string>>; env?: Readonly<Record<string, string>>; toolPolicies?: Readonly<Record<string, "read" | "write">>; access?: "members" | "admins" }): McpServerRow {
		const name = String(input.name ?? "").trim().slice(0, 80);
		if (!name) throw new HttpError(400, "invalid", "连接名称必填");
		if (input.scope !== "system" && input.scope !== "personal") throw new HttpError(400, "invalid", "scope 必须是 system 或 personal");
		if (input.scope === "system" && p.orgRole === "member") throw new HttpError(403, "forbidden", "只有组织管理员可以添加系统连接");
		if (input.transport === "stdio") {
			if (input.scope !== "system") throw new HttpError(403, "stdio_forbidden", "个人连接只能使用 HTTP（stdio 会在服务器上启动进程，仅限管理员添加系统连接）");
			if (!input.command) throw new HttpError(400, "invalid", "stdio 连接需要 command");
			if (!stdioAllowed(input.command, input.args ?? [])) throw new HttpError(403, "stdio_not_allowlisted", "该命令不在运维允许列表（WORKROOM_MCP_STDIO_ALLOW）中");
		} else if (input.transport === "http") {
			if (!input.url) throw new HttpError(400, "invalid", "HTTP 连接需要 url");
			new URL(input.url);
		} else throw new HttpError(400, "invalid", "transport 必须是 stdio 或 http");
		const secrets = input.secrets ?? {};
		const id = newId("mcp");
		let sealed: string | null = null;
		if (Object.keys(secrets).length) sealed = this.box.seal(JSON.stringify(secrets), id); // throws without a secret key
		let handle = slug(name);
		for (let n = 2; this.#ctx.db.get("SELECT 1 FROM mcp_servers WHERE handle = ?", handle); n++) handle = `${slug(name).slice(0, 17)}_${n}`;
		const now = nowIso();
		this.#ctx.db.run(
			`INSERT INTO mcp_servers (id, org_id, scope, owner_user_id, handle, name, transport, command, args, url, env, secrets_enc, secret_names, tool_policies, access, created_by, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, p.orgId, input.scope, input.scope === "personal" ? p.userId : null, handle, name, input.transport, input.command ?? null, input.args ? JSON.stringify(input.args) : null, input.url ?? null,
			input.env ? JSON.stringify(input.env) : null, sealed, JSON.stringify(Object.keys(secrets)), JSON.stringify(input.toolPolicies ?? {}), input.access === "admins" ? "admins" : "members", p.userId, now, now,
		);
		this.#audit(p, "connector.create", id, { name, scope: input.scope, transport: input.transport, secretNames: Object.keys(secrets) });
		return this.row(id)!;
	}

	update(p: Principal, row: McpServerRow, patch: { name?: string; enabled?: boolean; secrets?: Readonly<Record<string, string>>; toolPolicies?: Readonly<Record<string, "read" | "write">>; access?: "members" | "admins"; url?: string }): McpServerRow {
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
	async #connect(row: McpServerRow): Promise<Live> {
		let secrets: Record<string, string> = {};
		if (row.secrets_enc) {
			try {
				secrets = JSON.parse(this.box.open(row.secrets_enc, row.id));
			} catch {
				throw Object.assign(new Error("保存的凭据无法解密（服务器密钥缺失或已更换），请重新填写凭据"), { reconnect: true });
			}
		}
		const client = new Client({ name: "workroom", version: "1.0.0" }, { capabilities: {} });
		if (row.transport === "stdio") {
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
			const checked = await checkUrl(row.url!, { allowPrivate: row.scope === "system" });
			// Every request connects to the validated, pinned address (no DNS rebinding between check and connect).
			const transport = new StreamableHTTPClientTransport(new URL(row.url!), { requestInit: { headers: secrets }, fetch: pinnedFetch({ allowPrivate: row.scope === "system", pins: new Map([[checked.url.origin, checked.addresses[0]!]]) }) as any });
			await withTimeout(client.connect(transport), 15_000, "连接");
		}
		const live: Live = { client, secrets: expandSecrets(Object.values(secrets)), stamp: row.updated_at, lastUsed: Date.now() };
		client.onclose = () => {
			if (this.#live.get(row.id) === live) this.#live.delete(row.id);
		};
		return live;
	}

	async #client(row: McpServerRow): Promise<Live> {
		const l = this.#live.get(row.id);
		if (l && l.stamp === row.updated_at) {
			l.lastUsed = Date.now();
			return l;
		}
		if (l) await this.disconnect(row.id);
		let p = this.#connecting.get(row.id);
		if (!p) {
			p = this.#connect(row).finally(() => this.#connecting.delete(row.id));
			this.#connecting.set(row.id, p);
		}
		const live = await p;
		this.#live.set(row.id, live);
		return live;
	}

	/** Health check: connect, list tools, record status. Never throws. */
	async check(id: string): Promise<McpServerRow> {
		const row = this.row(id);
		if (!row) throw new HttpError(404, "not_found", "连接不存在");
		if (!row.enabled) {
			this.#setStatus(id, "disabled", "已停用");
			return this.row(id)!;
		}
		try {
			await this.disconnect(id);
			const l = await this.#client(row);
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
			await this.disconnect(id);
			const c = e?.reconnect ? { status: "needs_reconnect" as const, detail: String(e.message) } : classify(e, row.ever_ready === 1);
			this.#setStatus(id, c.status, redactText(c.detail, this.secretValues(row)));
		}
		return this.row(id)!;
	}

	async callTool(row: McpServerRow, tool: string, args: Record<string, unknown>, opts: { idempotencyKey?: string; retry: boolean }): Promise<{ content: any[]; isError: boolean; structuredContent?: unknown }> {
		const attempt = async () => {
			const l = await this.#client(row);
			const r: any = await l.client.callTool({ name: tool, arguments: args, ...(opts.idempotencyKey ? { _meta: { idempotencyKey: opts.idempotencyKey } } : {}) }, undefined, { timeout: 60_000 });
			return { content: (r.content ?? []) as any[], isError: !!r.isError, structuredContent: r.structuredContent };
		};
		try {
			return await attempt();
		} catch (e: any) {
			await this.disconnect(row.id);
			if (/unauthori[sz]ed|\b401\b|\b403\b/i.test(String(e?.message)) || e?.code === 401) {
				this.#setStatus(row.id, "unauthorized", redactText(String(e.message), this.secretValues(row)));
				throw e;
			}
			if (!opts.retry) {
				this.#setStatus(row.id, "needs_reconnect", redactText(String(e?.message ?? e), this.secretValues(row)));
				throw e;
			}
			try {
				return await attempt();
			} catch (e2: any) {
				const c = classify(e2, true);
				this.#setStatus(row.id, c.status, redactText(c.detail, this.secretValues(row)));
				throw e2;
			}
		}
	}

	// ----- DTOs -----
	toolDTOs(row: McpServerRow): ConnectorToolDTO[] {
		return this.tools(row).map((t) => ({ name: piToolName(row.handle, t.name), tool: t.name, description: t.description, policy: this.policyOf(row, t), inputSchema: t.inputSchema }));
	}
	async dto(p: Principal, row: McpServerRow): Promise<ConnectorDTO> {
		const use = await this.decide(p, "use", row.id);
		const manage = await this.decide(p, "admin", row.id);
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
			tools: this.toolDTOs(row),
			access: use.allow ? "allowed" : "forbidden",
			accessReason: use.allow ? undefined : use.reason,
			enabledForMe: this.enabledFor(row, p.userId),
			canManage: manage.allow,
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
		const secrets = row ? this.secretValues(row) : [];
		const recId = log.start({ tool: toolName, connectorId: serverId, actor, args, secrets });
		const fail = (status: "error" | "denied" | "needs_reconciliation", message: string): ToolExecutionResult => {
			log.finish(recId, { status, error: message, secrets });
			return { output: [{ type: "text", text: message }], isError: true, details: { connectorId: serverId, tool, status } };
		};
		if (!row) return fail("error", "该连接已被删除");
		const u = await this.usable(actor.principal, row);
		if (!u.ok) return fail("denied", u.message);
		if (!this.tools(row).some((x) => x.name === tool)) return fail("error", `连接「${row.name}」已不再提供工具 ${tool}，请重新检查连接`);
		try {
			let result: { content: any[]; isError: boolean; structuredContent?: unknown };
			if (policy === "read") {
				result = await this.callTool(row, tool, args, { retry: true });
			} else {
				const effects = this.effectsOverride ?? (this.#ctx.services.has("effects") ? (this.#ctx.services.get("effects") as EffectsApi) : null);
				if (!effects) return fail("denied", "写操作需要审批与回执服务（运行内核未提供 effects），本次未执行");
				const summary = `通过连接「${row.name}」调用 ${tool}，参数：${summarizeArgs(args, secrets, 600)}`;
				const decision = await effects.requestApproval(api, { title: `确认外部操作：${row.name} / ${tool}`, summary, detail: JSON.parse(summarizeArgs(args, secrets)), risk: "medium" }, context);
				if (decision.decision !== "approved") return fail("denied", `用户未批准此操作${decision.note ? `（${decision.note}）` : ""}，未执行`);
				const outcome = await effects.externalEffect(api, { key: `mcp:${serverId}:${tool}:${actor.callId}`, target: `${row.name}/${tool}`, summary }, async (idempotencyKey) => {
					const r = await this.callTool(row, tool, args, { idempotencyKey, retry: false });
					return JSON.parse(JSON.stringify({ content: r.content, isError: r.isError })) as any;
				}, context);
				if (outcome.status === "needs_reconciliation") return fail("needs_reconciliation", `外部写操作结果不确定（进程在执行中断开），未自动重做，请人工核对：${outcome.detail}（effect ${outcome.effectId}）`);
				result = outcome.receipt as any;
			}
			const output = this.#content(result.content, secrets);
			const text = output.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
			log.finish(recId, { status: result.isError ? "error" : "ok", error: result.isError ? text.slice(0, 500) : undefined, result: text.slice(0, 300), secrets });
			return { output: output.length ? output : [{ type: "text", text: "（无输出）" }], isError: result.isError, details: { connectorId: serverId, connector: row.name, tool, policy } };
		} catch (e: any) {
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

// ----- tool_search restricted to what the acting user may use -----
function tokens(s: string): string[] {
	return s.toLowerCase().split(/[^a-z0-9一-鿿]+/).filter(Boolean);
}
function score(query: string, text: string): number {
	const q = tokens(query);
	const t = tokens(text);
	if (!q.length) return 0;
	let s = 0;
	for (const w of q) {
		const exact = t.filter((x) => x === w).length;
		const partial = t.filter((x) => x !== w && (x.includes(w) || w.includes(x))).length;
		s += exact * 2 + partial * 0.5;
		if (/[一-鿿]/.test(w) && text.includes(w)) s += 1;
	}
	return s;
}

export function createToolSearch(mgr: McpManager, ctx: AppContext) {
	return defineTool({
		name: "tool_search",
		description:
			"# Tool discovery\n\nSearches the deferred tools you may use (for example tools of connected MCP servers / connectors) and loads the matches for your next call. " +
			"Only connectors the current user may use and has enabled are searched. Always use this to find connector tools.",
		parameters: obj({ query: str({ description: "What you need, e.g. 'create calendar event' or 'search issues'." }), limit: opt(num()) }, { open: true }),
		callers: ["model"],
		replay: "safe",
		async execute({ query, limit }, api, context) {
			if (!query.trim()) throw new Error("query must not be empty");
			const actor: ToolActor = await mgr.resolveActor(api, context);
			const agent = await api.agent(context);
			const allowedServers = new Map<string, boolean>();
			const byPiName = new Map<string, McpServerRow>();
			for (const r of mgr.rows(actor.principal.orgId)) for (const t of mgr.tools(r)) byPiName.set(piToolName(r.handle, t.name), r);
			const candidates = [];
			for (const t of agent.deferred) {
				if (t.name.startsWith("mcp__")) {
					const r = byPiName.get(t.name);
					if (!r) continue; // another org's connector: never shown
					if (!allowedServers.has(r.id)) allowedServers.set(r.id, (await mgr.usable(actor.principal, r)).ok);
					if (!allowedServers.get(r.id)) continue;
				}
				candidates.push(t);
			}
			const max = Math.max(1, Math.min(Math.floor(limit ?? 8), 20));
			const ranked = candidates
				.map((t) => ({ t, s: score(query, `${t.name.replace(/_/g, " ")} ${t.description}`) }))
				.filter((x) => x.s > 0)
				.sort((a, b) => b.s - a.s)
				.slice(0, max)
				.map((x) => x.t);
			const loaded = ranked.map((t) => t.name);
			const text = loaded.length ? `Loaded ${loaded.length} tool(s). They are available from your next call:\n${ranked.map((t) => `- ${t.name}: ${t.description.split("\n")[0]}`).join("\n")}` : "No matching tools found (or no connector you may use offers them).";
			void ctx;
			return { output: [{ type: "text", text }], details: { loaded }, ...(loaded.length ? { control: { addTools: loaded } } : {}) };
		},
	});
}
