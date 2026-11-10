// Default toolset policy. Every installed tool is offered to a default conversation (pi selects all installed extensions;
// MCP tools are deferred behind tool_search). Organisation admins can switch off whole tool groups; the switch is enforced
// in a `beforeTool` hook for every call — model-issued and nested (code mode) — and every tool still re-checks the acting
// user's ACL itself. Files tools cannot be switched off (they only write into the user's own library under ACL).
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, hook, ToolTask, type Extension } from "@earendil-works/pi-durable";
import type { AppContext, Principal } from "../core/contracts.ts";
import type { Migration } from "../core/db.ts";
import { HttpError, newId, nowIso } from "../core/http.ts";

export const POLICY_MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "org tool policy",
		sql: `CREATE TABLE tool_org_policy (org_id TEXT NOT NULL, tool_group TEXT NOT NULL, enabled INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (org_id, tool_group));`,
	},
];

export const TOOL_GROUPS = {
	sandbox: { label: "代码执行（沙箱）", match: (n: string) => n.startsWith("sandbox_") },
	codemode: { label: "脚本编排（Code Mode）", match: (n: string) => n === "codemode" },
	browser: { label: "服务端浏览器", match: (n: string) => n === "browse" || n.startsWith("browser_") },
	jobs: { label: "后台长任务", match: (n: string) => n.startsWith("job_") },
	connectors: { label: "外部连接器（MCP）", match: (n: string) => n.startsWith("mcp__") || n === "tool_search" },
	skills: { label: "技能", match: (n: string) => n === "skill" || n.startsWith("skill_") },
} as const;
export type ToolGroup = keyof typeof TOOL_GROUPS;

export function groupOf(tool: string): ToolGroup | undefined {
	for (const [g, d] of Object.entries(TOOL_GROUPS)) if (d.match(tool)) return g as ToolGroup;
	return undefined;
}

export class ToolPolicy {
	readonly #ctx: AppContext;
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}
	/** Effective enablement per group for an org (default: enabled). */
	groups(orgId: string): Record<ToolGroup, boolean> {
		const out = Object.fromEntries(Object.keys(TOOL_GROUPS).map((g) => [g, true])) as Record<ToolGroup, boolean>;
		for (const r of this.#ctx.db.all<{ tool_group: string; enabled: number }>("SELECT tool_group, enabled FROM tool_org_policy WHERE org_id = ?", orgId)) if (r.tool_group in out) out[r.tool_group as ToolGroup] = r.enabled === 1;
		return out;
	}
	allowed(orgId: string, tool: string): boolean {
		const g = groupOf(tool);
		return g === undefined || this.groups(orgId)[g];
	}
	set(p: Principal, groups: Partial<Record<string, boolean>>): Record<ToolGroup, boolean> {
		// Permission (sandbox.policy.manage) is checked by the route with the authz service.
		for (const [g, v] of Object.entries(groups)) {
			if (!(g in TOOL_GROUPS)) throw new HttpError(400, "invalid", `未知工具组 ${g}`);
			this.#ctx.db.run("INSERT INTO tool_org_policy (org_id, tool_group, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(org_id, tool_group) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at", p.orgId, g, v ? 1 : 0, p.userId, nowIso());
		}
		try {
			this.#ctx.db.run("INSERT INTO id_audit (id, org_id, actor_user_id, action, target, detail, at) VALUES (?, ?, ?, 'tools.policy.set', ?, ?, ?)", newId("aud"), p.orgId, p.userId, p.orgId, JSON.stringify(groups), nowIso());
		} catch {
			/* audit table owned by E */
		}
		return this.groups(p.orgId);
	}
}

/** Hook extension: blocks calls of tool groups the conversation's organisation switched off. */
export function createPolicyExtension(ctx: AppContext): Extension {
	const policy = () => ctx.services.get("toolPolicy") as ToolPolicy;
	return defineExtension({
		name: "wr.tool-policy",
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call: { name: string }, api: any, context: Context) => {
					if (!groupOf(call.name) || !ctx.services.has("runtime")) return undefined;
					const rt = ctx.services.get("runtime") as any;
					const spaceId: string | undefined = await rt.spaceIdForTool?.(api, context).catch(() => undefined);
					const space = spaceId ? ctx.services.get("identity").space(spaceId) : null;
					if (!space) return undefined; // the tool's own actor/ACL check still applies
					if (policy().allowed(space.orgId, call.name)) return undefined;
					const g = groupOf(call.name)!;
					return { block: `组织管理员已关闭「${TOOL_GROUPS[g].label}」（${g}），本次调用未执行` };
				},
			} as any),
		],
	});
}
