// Tools module (group D): tool call records, MCP connectors, skills, sandbox, browser.
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import type { AppContext, Principal, WorkroomModule } from "../core/contracts.ts";
import { HttpError, jsonBody, principalOf } from "../core/http.ts";
import { ToolCallLog, TOOL_CALL_MIGRATIONS } from "./calls.ts";
import { BLOCKED_CONNECTORS, createToolSearch, McpManager, MCP_MIGRATIONS } from "./mcp.ts";
import { Sandbox, SANDBOX_MIGRATIONS } from "./sandbox.ts";
import { createSandboxExtension } from "./sandbox-tools.ts";
import { BrowserService, createBrowserExtension } from "./browser.ts";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { contentDisposition } from "../files/module.ts";
import { effectiveMime } from "../files/mime.ts";
import type { Files } from "../files/service.ts";
import type { ConnectorCreateRequest, ConnectorListResponse, SandboxFilesResponse, SandboxRunsResponse, ToolCallListResponse } from "../../../shared/files.ts";

const codemodeSandboxes = new WeakMap<AppContext, CodemodeSandbox>();

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
	migrations: [
		...TOOL_CALL_MIGRATIONS,
		...MCP_MIGRATIONS.map((m) => ({ ...m, version: m.version + 100 })),
		...SANDBOX_MIGRATIONS.map((m) => ({ ...m, version: m.version + 200 })),
	],
	init(ctx) {
		ctx.services.provide("toolCalls", new ToolCallLog(ctx));
		ctx.services.provide("mcp", new McpManager(ctx));
		ctx.services.provide("sandbox", new Sandbox(ctx));
		ctx.services.provide("browser", new BrowserService(ctx));
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
		// Code mode: model-written JavaScript runs in QuickJS (WebAssembly, no host access) and calls tools as nested calls,
		// each with its own ACL check and replay policy.
		let codemodeSandbox = codemodeSandboxes.get(ctx);
		if (!codemodeSandbox) codemodeSandboxes.set(ctx, (codemodeSandbox = new CodemodeSandbox({ memoryLimitBytes: 128 * 1024 * 1024, timeoutMs: 120_000 })));
		const codemode = createCodemodeExtension({ sandbox: codemodeSandbox, models: false, namespaces: [{ name: "files", description: "File library tools", prefix: "file_" }, { name: "sandbox", description: "Sandbox tools", prefix: "sandbox_" }] });
		return [ext, createSandboxExtension(ctx), createBrowserExtension(ctx), codemode];
	},
	async start(ctx) {
		(ctx.services.get("mcp") as McpManager).start();
		(ctx.services.get("sandbox") as Sandbox).start();
	},
	async stop(ctx) {
		await (ctx.services.get("mcp") as McpManager).stop();
		(ctx.services.get("sandbox") as Sandbox).stop();
		await (ctx.services.get("browser") as BrowserService).stop();
		await codemodeSandboxes.get(ctx)?.close().catch(() => {});
		codemodeSandboxes.delete(ctx);
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

		// ---- sandbox (work panel): same ACL as the space's conversations; publishing needs write ----
		const sb = ctx.services.get("sandbox") as Sandbox;
		const spaceFor = async (c: any, action: "read" | "write") => {
			const p = principalOf(c);
			const space = ctx.services.get("identity").space(c.req.param("spaceId"));
			if (!space) throw new HttpError(404, "space_not_found", "空间不存在");
			await acl.require(p, action, { kind: "space", id: space.id });
			const cid = c.req.query("conversationId");
			return { p, space, conversationId: cid === undefined || cid === "" ? undefined : Number(cid) };
		};
		api.get("/sandbox/:spaceId", async (c) => {
			const { space } = await spaceFor(c, "read");
			return c.json({ info: sb.info(space), browser: (ctx.services.get("browser") as BrowserService).available() });
		});
		api.get("/sandbox/:spaceId/files", async (c) => {
			const { space, conversationId } = await spaceFor(c, "read");
			const out: SandboxFilesResponse = { entries: sb.entries(space, conversationId) };
			return c.json(out);
		});
		api.get("/sandbox/:spaceId/file", async (c) => {
			const { space, conversationId } = await spaceFor(c, "read");
			const f = sb.readFile(space, conversationId, c.req.query("path") ?? "");
			return new Response(f.bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": effectiveMime(undefined, f.name), "content-disposition": contentDisposition("attachment", f.name), "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'", "cache-control": "private, no-store" } });
		});
		api.get("/sandbox/:spaceId/runs", async (c) => {
			const { space, conversationId } = await spaceFor(c, "read");
			const out: SandboxRunsResponse = { runs: sb.runs(space.id, conversationId) };
			return c.json(out);
		});
		api.get("/sandbox/:spaceId/runs/:runId", async (c) => {
			const { space } = await spaceFor(c, "read");
			const run = sb.runDTO(c.req.param("runId"));
			if (!run || run.spaceId !== space.id) throw new HttpError(404, "not_found", "运行记录不存在");
			return c.json({ run });
		});
		api.post("/sandbox/:spaceId/publish", async (c) => {
			const { p, space } = await spaceFor(c, "write");
			const b = await jsonBody<{ conversationId?: number; path: string; name?: string; fileId?: string; changeNote?: string }>(c);
			const f = sb.readFile(space, b.conversationId, b.path);
			const name = b.name ?? f.name;
			const ref = await (ctx.services.get("files") as unknown as Files).putVersion(p, { fileId: b.fileId, name, mime: effectiveMime(undefined, name), bytes: f.bytes, provenance: { createdBy: p.userId, spaceId: space.id, conversationId: b.conversationId, changeNote: b.changeNote ?? `从沙箱 /work/${b.path} 发布`, origin: "upload", tool: "sandbox_publish" } as any });
			return c.json({ version: ref });
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
