// Tools module (group D): tool call records, MCP connectors, skills, sandbox, browser.
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import type { AppContext, Principal, WorkroomModule } from "../core/contracts.ts";
import { HttpError, jsonBody, principalOf } from "../core/http.ts";
import { ToolCallLog, TOOL_CALL_MIGRATIONS } from "./calls.ts";
import { BLOCKED_CONNECTORS, createToolSearch, McpManager, MCP_MIGRATIONS } from "./mcp.ts";
import type { ConnectorCreateRequest, ConnectorListResponse, ToolCallListResponse } from "../../../shared/files.ts";

function mcpExtension(mgr: McpManager, ctx: AppContext): Extension {
	const search = createToolSearch(mgr, ctx);
	// `tools` is read by the registry at every snapshot: newly discovered connector tools appear without a reinstall.
	return {
		name: "wr.mcp",
		get tools(): readonly ToolRegistration[] {
			return [search as ToolRegistration, ...mgr.piTools()];
		},
	};
}

export const toolsModule: WorkroomModule = {
	name: "tools",
	migrations: [...TOOL_CALL_MIGRATIONS.map((m) => m), ...MCP_MIGRATIONS.map((m) => ({ ...m, version: m.version + 100 }))],
	init(ctx) {
		ctx.services.provide("toolCalls", new ToolCallLog(ctx));
		ctx.services.provide("mcp", new McpManager(ctx));
	},
	extensions(ctx) {
		const mgr = ctx.services.get("mcp") as McpManager;
		const ext = mcpExtension(mgr, ctx);
		mgr.onToolsChanged = () => {
			if (!ctx.services.has("runtime")) return;
			const rt = ctx.services.get("runtime") as any;
			try {
				rt.reinstallExtension?.(ext);
			} catch (e) {
				console.error("[tools] reinstall wr.mcp failed", e);
			}
		};
		return [ext];
	},
	async start(ctx) {
		(ctx.services.get("mcp") as McpManager).start();
	},
	async stop(ctx) {
		await (ctx.services.get("mcp") as McpManager).stop();
	},
	routes(api, ctx) {
		const log = ctx.services.get("toolCalls") as ToolCallLog;
		const mgr = ctx.services.get("mcp") as McpManager;
		const acl = ctx.services.get("acl");
		(ctx.services.get("identity") as any).registerResolver?.("connector", (p: Principal, action: string, res: { id: string }) => mgr.decide(p, action, res.id));

		// Tool call records: calls in spaces the caller can read (conversation ACL = space ACL).
		api.get("/tool-calls", async (c) => {
			const p = principalOf(c);
			const q = c.req.query();
			let spaceIds: string[] | undefined;
			if (q.spaceId) {
				await acl.require(p, "read", { kind: "space", id: q.spaceId });
				spaceIds = [q.spaceId];
			} else spaceIds = (await acl.readableSpaces(p)).map((s) => s.id);
			const out: ToolCallListResponse = { calls: log.list({ spaceIds, conversationId: q.conversationId ? Number(q.conversationId) : undefined, tool: q.tool, limit: q.limit ? Number(q.limit) : undefined }) };
			return c.json(out);
		});

		// ---- connectors ----
		const managed = async (p: Principal, id: string) => {
			const row = mgr.row(id);
			if (!row) throw new HttpError(404, "not_found", "连接不存在");
			await acl.require(p, "admin", { kind: "connector", id });
			return row;
		};
		api.get("/connectors", async (c) => {
			const p = principalOf(c);
			const rows = mgr.rows(p.orgId).filter((r) => r.scope === "system" || r.owner_user_id === p.userId);
			const out: ConnectorListResponse = { connectors: await Promise.all(rows.map((r) => mgr.dto(p, r))), secretStorage: mgr.box.available ? "available" : "unavailable", blocked: BLOCKED_CONNECTORS };
			return c.json(out);
		});
		api.post("/connectors", async (c) => {
			const p = principalOf(c);
			const b = await jsonBody<ConnectorCreateRequest & { check?: boolean; access?: "members" | "admins" }>(c);
			const row = mgr.create(p, b);
			const checked = b.check === false ? row : await mgr.check(row.id);
			return c.json({ connector: await mgr.dto(p, checked) });
		});
		api.get("/connectors/:id", async (c) => {
			const p = principalOf(c);
			const row = mgr.row(c.req.param("id"));
			if (!row) throw new HttpError(404, "not_found", "连接不存在");
			await acl.require(p, "read", { kind: "connector", id: row.id });
			return c.json({ connector: await mgr.dto(p, row) });
		});
		api.patch("/connectors/:id", async (c) => {
			const p = principalOf(c);
			const row = await managed(p, c.req.param("id"));
			const b = await jsonBody<{ name?: string; enabled?: boolean; secrets?: Record<string, string>; toolPolicies?: Record<string, "read" | "write">; access?: "members" | "admins"; url?: string }>(c);
			const updated = mgr.update(p, row, b);
			return c.json({ connector: await mgr.dto(p, updated) });
		});
		api.delete("/connectors/:id", async (c) => {
			const p = principalOf(c);
			mgr.remove(p, await managed(p, c.req.param("id")));
			return c.json({ ok: true });
		});
		api.post("/connectors/:id/check", async (c) => {
			const p = principalOf(c);
			const row = mgr.row(c.req.param("id"));
			if (!row) throw new HttpError(404, "not_found", "连接不存在");
			await acl.require(p, "use", { kind: "connector", id: row.id });
			return c.json({ connector: await mgr.dto(p, await mgr.check(row.id)) });
		});
		api.put("/connectors/:id/enablement", async (c) => {
			const p = principalOf(c);
			const row = mgr.row(c.req.param("id"));
			if (!row) throw new HttpError(404, "not_found", "连接不存在");
			await acl.require(p, "use", { kind: "connector", id: row.id });
			const b = await jsonBody<{ enabled: boolean }>(c);
			mgr.setEnabledFor(p.userId, row, !!b.enabled);
			return c.json({ connector: await mgr.dto(p, mgr.row(row.id)!) });
		});
		api.get("/connectors/:id/calls", async (c) => {
			const p = principalOf(c);
			const row = mgr.row(c.req.param("id"));
			if (!row) throw new HttpError(404, "not_found", "连接不存在");
			await acl.require(p, "read", { kind: "connector", id: row.id });
			const manage = (await acl.check(p, "admin", { kind: "connector", id: row.id })).allow;
			const calls = log.list({ userId: manage ? undefined : p.userId, connectorId: row.id, limit: 200 });
			return c.json({ calls });
		});
	},
};
