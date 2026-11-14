// Organisation network access policy: storage (tool_net_policy), cache, HTTP API (admin › 角色与权限 › 网络访问) and audit.
// Rules and the fixed security floor live in netpolicy.ts / shared/netpolicy.ts; this file only stores and serves the policy.
// Permission `network.manage` (owner/admin hold it by default) guards read and write. One row per organisation; no row = default
// policy (all public addresses allowed, empty lists), i.e. exactly the behaviour before this setting existed.
import type { Hono } from "hono";
import type { AppContext, AppEnv, Principal } from "../core/contracts.ts";
import type { Migration } from "../core/db.ts";
import { HttpError, jsonBody, nowIso, principalOf } from "../core/http.ts";
import { DEFAULT_NET_POLICY, normalizeNetPolicy, type NetPolicyAdminDTO, type NetPolicyDTO } from "../../../shared/netpolicy.ts";
import { envInternalList, setPolicySource, testUrl } from "./netpolicy.ts";

export const NET_POLICY_MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "network access policy (per organisation)",
		sql: `CREATE TABLE tool_net_policy (org_id TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'open', allow TEXT NOT NULL DEFAULT '[]', block TEXT NOT NULL DEFAULT '[]', internal TEXT NOT NULL DEFAULT '[]', updated_by TEXT NOT NULL, updated_at TEXT NOT NULL);`,
	},
];

interface Row {
	org_id: string;
	mode: string;
	allow: string;
	block: string;
	internal: string;
	updated_by: string;
	updated_at: string;
}

export class NetPolicyService {
	readonly #ctx: AppContext;
	readonly #cache = new Map<string, { policy: NetPolicyDTO; row?: Row }>();
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}
	/** Make netpolicy.ts consult this service (per organisation). */
	readonly #source = (orgId: string): NetPolicyDTO => this.policy(orgId);
	install(): void {
		setPolicySource(this.#source);
	}
	uninstall(): void {
		setPolicySource(null, this.#source);
	}
	#load(orgId: string): { policy: NetPolicyDTO; row?: Row } {
		const hit = this.#cache.get(orgId);
		if (hit) return hit;
		const row = this.#ctx.db.get<Row>("SELECT * FROM tool_net_policy WHERE org_id = ?", orgId);
		let policy = DEFAULT_NET_POLICY;
		if (row) {
			try {
				const n = normalizeNetPolicy({ mode: row.mode, allow: JSON.parse(row.allow), block: JSON.parse(row.block), internal: JSON.parse(row.internal) });
				if (n.ok) policy = n.policy;
			} catch {
				/* a damaged row reads as the default policy rather than breaking every outbound request */
			}
		}
		const v = { policy, row };
		this.#cache.set(orgId, v);
		return v;
	}
	/** Effective policy of an organisation (cached; every write invalidates). */
	policy(orgId: string): NetPolicyDTO {
		return this.#load(orgId).policy;
	}
	admin(orgId: string): NetPolicyAdminDTO {
		const { policy, row } = this.#load(orgId);
		return { policy, env: { internal: envInternalList() }, ...(row ? { updatedAt: row.updated_at, updatedBy: row.updated_by } : {}), isDefault: !row };
	}
	async require(p: Principal): Promise<void> {
		await this.#ctx.services.get("authz").require(p, "network.manage");
	}
	set(p: Principal, input: unknown): NetPolicyAdminDTO {
		const n = normalizeNetPolicy(input);
		if (!n.ok) throw new HttpError(400, "invalid", n.error);
		const before = this.policy(p.orgId);
		const at = nowIso();
		this.#ctx.db.run(
			"INSERT INTO tool_net_policy (org_id, mode, allow, block, internal, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(org_id) DO UPDATE SET mode = excluded.mode, allow = excluded.allow, block = excluded.block, internal = excluded.internal, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
			p.orgId, n.policy.mode, JSON.stringify(n.policy.allow), JSON.stringify(n.policy.block), JSON.stringify(n.policy.internal), p.userId, at,
		);
		this.#cache.delete(p.orgId);
		this.#audit(p, "network.policy.update", { before, after: n.policy });
		return this.admin(p.orgId);
	}
	reset(p: Principal): NetPolicyAdminDTO {
		const before = this.policy(p.orgId);
		this.#ctx.db.run("DELETE FROM tool_net_policy WHERE org_id = ?", p.orgId);
		this.#cache.delete(p.orgId);
		this.#audit(p, "network.policy.reset", { before, after: DEFAULT_NET_POLICY });
		return this.admin(p.orgId);
	}
	#audit(p: Principal, action: string, detail: unknown): void {
		(this.#ctx.services.get("audit") as { record(i: unknown): string }).record({ orgId: p.orgId, actorUserId: p.userId, action, target: p.orgId, detail, category: "security" });
	}
}

export function registerNetPolicyRoutes(api: Hono<AppEnv>, ctx: AppContext): void {
	const svc = () => ctx.services.get("netPolicy") as NetPolicyService;
	api.get("/admin/network-policy", async (c) => {
		const p = principalOf(c);
		await svc().require(p);
		return c.json(svc().admin(p.orgId));
	});
	api.put("/admin/network-policy", async (c) => {
		const p = principalOf(c);
		await svc().require(p);
		return c.json(svc().set(p, await jsonBody(c)));
	});
	api.delete("/admin/network-policy", async (c) => {
		const p = principalOf(c);
		await svc().require(p);
		return c.json(svc().reset(p));
	});
	// Dry run: the decision the real check would make for a URL (DNS lookup only, no connection). `policy` tests unsaved edits.
	api.post("/admin/network-policy/test", async (c) => {
		const p = principalOf(c);
		await svc().require(p);
		const body = await jsonBody<{ url?: unknown; policy?: unknown }>(c);
		if (typeof body.url !== "string" || !body.url.trim() || body.url.length > 2000) throw new HttpError(400, "invalid", "请输入要测试的网址");
		let policy: NetPolicyDTO | undefined;
		if (body.policy !== undefined) {
			const n = normalizeNetPolicy(body.policy);
			if (!n.ok) throw new HttpError(400, "invalid", n.error);
			policy = n.policy;
		}
		return c.json(await testUrl(body.url, { orgId: p.orgId, policy }));
	});
}
