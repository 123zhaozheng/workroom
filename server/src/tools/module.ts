// Tools module (group D): tool call records, MCP connectors, skills, sandbox, browser.
import type { WorkroomModule } from "../core/contracts.ts";
import { principalOf } from "../core/http.ts";
import { ToolCallLog, TOOL_CALL_MIGRATIONS } from "./calls.ts";
import type { ToolCallListResponse } from "../../../shared/files.ts";

export const toolsModule: WorkroomModule = {
	name: "tools",
	migrations: [...TOOL_CALL_MIGRATIONS],
	init(ctx) {
		ctx.services.provide("toolCalls", new ToolCallLog(ctx));
	},
	routes(api, ctx) {
		const log = ctx.services.get("toolCalls") as ToolCallLog;
		// Tool call records: own calls, or calls in spaces the caller can read (conversation ACL = space ACL).
		api.get("/tool-calls", async (c) => {
			const p = principalOf(c);
			const q = c.req.query();
			const acl = ctx.services.get("acl");
			let spaceIds: string[] | undefined;
			if (q.spaceId) {
				await acl.require(p, "read", { kind: "space", id: q.spaceId });
				spaceIds = [q.spaceId];
			} else spaceIds = (await acl.readableSpaces(p)).map((s) => s.id);
			const out: ToolCallListResponse = { calls: log.list({ spaceIds, conversationId: q.conversationId ? Number(q.conversationId) : undefined, tool: q.tool, limit: q.limit ? Number(q.limit) : undefined }) };
			return c.json(out);
		});
	},
};
