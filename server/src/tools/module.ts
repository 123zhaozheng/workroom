// Tools module (group D): tool call records, MCP connectors, skills, sandbox, browser.
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import type { AppContext, Principal, WorkroomModule } from "../core/contracts.ts";
import { HttpError, jsonBody, principalOf } from "../core/http.ts";
import { ToolCallLog, TOOL_CALL_MIGRATIONS } from "./calls.ts";
import { BLOCKED_CONNECTORS, createToolSearch, McpManager, MCP_MIGRATIONS } from "./mcp.ts";
import { ISOLATION_TEXT, probeIsolation, Sandbox, SANDBOX_MIGRATIONS } from "./sandbox.ts";
import { pdfFontStatus } from "../files/generate.ts";
import { createSandboxExtension } from "./sandbox-tools.ts";
import { BrowserService, createBrowserExtension } from "./browser.ts";
import { createSkillsExtension, Skills, SKILL_MIGRATIONS, type SkillInput } from "./skills.ts";
import { createJobsExtension, Jobs, JOB_MIGRATIONS } from "./jobs.ts";
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

const D_TOOLS = ["file_create", "file_revise", "file_read", "file_list", "sandbox_exec", "sandbox_write_file", "sandbox_read_file", "sandbox_list", "sandbox_publish", "browse", "skill_list", "skill_load", "skill_run", "tool_search", "codemode"];
/** Tool names a skill may require: the runtime registry when available, else D's own tools plus discovered MCP tools. */
export function knownToolNames(ctx: AppContext): string[] {
	const names = new Set(D_TOOLS);
	try {
		const rt = ctx.services.has("runtime") ? (ctx.services.get("runtime") as any) : null;
		const reg = rt?.registry ?? rt?.manager?.registry;
		for (const t of reg?.snapshot?.().tools?.() ?? []) names.add(t.tool?.name ?? t.name);
	} catch {
		/* fall back to the static list */
	}
	for (const t of (ctx.services.get("mcp") as McpManager).piTools()) names.add(t.name);
	return [...names];
}

export const toolsModule: WorkroomModule = {
	name: "tools",
	migrations: [
		...TOOL_CALL_MIGRATIONS,
		...MCP_MIGRATIONS.map((m) => ({ ...m, version: m.version + 100 })),
		...SANDBOX_MIGRATIONS.map((m) => ({ ...m, version: m.version + 200 })),
		...SKILL_MIGRATIONS.map((m) => ({ ...m, version: m.version + 300 })),
		...JOB_MIGRATIONS.map((m) => ({ ...m, version: m.version + 400 })),
	],
	init(ctx) {
		ctx.services.provide("toolCalls", new ToolCallLog(ctx));
		ctx.services.provide("mcp", new McpManager(ctx));
		ctx.services.provide("sandbox", new Sandbox(ctx));
		ctx.services.provide("browser", new BrowserService(ctx));
		ctx.services.provide("skills", new Skills(ctx));
		ctx.services.provide("jobs", new Jobs(ctx));
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
		return [ext, createSandboxExtension(ctx), createBrowserExtension(ctx), createSkillsExtension(ctx), createJobsExtension(ctx), codemode];
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

		// ---- background jobs (M14-C): space ACL; cancel needs write ----
		const jobs = ctx.services.get("jobs") as Jobs;
		api.get("/jobs", async (c) => {
			const p = principalOf(c);
			const q = c.req.query();
			let spaceIds: string[];
			if (q.spaceId) {
				await acl.require(p, "read", { kind: "space", id: q.spaceId });
				spaceIds = [q.spaceId];
			} else spaceIds = (await acl.readableSpaces(p)).map((s) => s.id);
			const rows = jobs.list(spaceIds, { conversationId: q.conversationId ? Number(q.conversationId) : undefined, status: q.status });
			const writable = new Map<string, boolean>();
			for (const id of new Set(rows.map((r) => r.space_id))) writable.set(id, (await acl.check(p, "write", { kind: "space", id })).allow);
			return c.json({ jobs: rows.map((r) => jobs.dto(r, writable.get(r.space_id))) });
		});
		api.get("/jobs/:id", async (c) => {
			const p = principalOf(c);
			const r = jobs.row(c.req.param("id"));
			if (!r) throw new HttpError(404, "not_found", "任务不存在");
			await acl.require(p, "read", { kind: "space", id: r.space_id });
			return c.json({ job: jobs.dto(r, (await acl.check(p, "write", { kind: "space", id: r.space_id })).allow) });
		});
		api.post("/jobs/:id/cancel", async (c) => c.json({ job: await jobs.cancel(principalOf(c), c.req.param("id")) }));

		// ---- capabilities (M14-A, tools side): what this user can use right now, and what is unavailable and why ----
		api.get("/tools/capabilities", async (c) => {
			const p = principalOf(c);
			const iso = probeIsolation();
			const br = (ctx.services.get("browser") as BrowserService).available();
			const conns = await Promise.all(mgr.rows(p.orgId).filter((r) => r.scope === "system" || r.owner_user_id === p.userId).map((r) => mgr.dto(p, r)));
			const sk = ctx.services.get("skills") as Skills;
			return c.json({
				deliverables: { formats: ["md", "html", "csv", "docx", "xlsx", "pptx", "pdf"], tools: ["file_create", "file_revise", "file_read", "file_list"], pdfCjkFont: pdfFontStatus() },
				sandbox: { status: iso.ok ? "ready" : "unavailable", detail: iso.ok ? ISOLATION_TEXT : iso.detail, languages: ["shell", "python", "node"], network: false },
				codemode: { status: "ready", detail: "QuickJS（WebAssembly）脚本，可调用会话中的工具" },
				browser: { status: br.ok ? "ready" : "unavailable", detail: br.detail },
				connectors: conns.map((x) => ({ id: x.id, name: x.name, status: x.status, statusDetail: x.statusDetail, access: x.access, enabledForMe: x.enabledForMe, tools: x.tools.length, usable: x.access === "allowed" && x.enabledForMe && (x.status === "ready" || x.status === "needs_reconnect") })),
				blockedConnectors: BLOCKED_CONNECTORS,
				skills: sk.active(p).map(({ skill, version }) => {
					const need: string[] = JSON.parse(version.required_permissions);
					const have = sk.granted(version.id, p.userId);
					return { id: skill.id, name: skill.name, kind: skill.kind, versionNo: version.version_no, missingGrants: need.filter((x) => !have.includes(x)) };
				}),
				media: {
					audio: { status: "blocked", detail: "未配置语音识别/合成服务或模型凭据" },
					video: { status: "blocked", detail: "未配置视频生成/理解服务或模型凭据" },
					imageInput: { status: "depends_on_model", detail: "取决于所选模型的能力（模型网关，E 组）" },
				},
			});
		});

		// ---- skills ----
		const skills = ctx.services.get("skills") as Skills;
		(ctx.services.get("identity") as any).registerResolver?.("skill", (p: Principal, action: string, res: { id: string }) => skills.decide(p, action, res.id));
		const skillOr404 = async (c: any, action: "read" | "use" | "write") => {
			const p = principalOf(c);
			const s = skills.skill(c.req.param("id"));
			if (!s) throw new HttpError(404, "not_found", "技能不存在");
			await acl.require(p, action, { kind: "skill", id: s.id });
			return { p, s };
		};
		api.get("/skills", async (c) => {
			const p = principalOf(c);
			return c.json({ skills: await Promise.all(skills.visible(p).map((s) => skills.dto(p, s))) });
		});
		api.post("/skills", async (c) => {
			const p = principalOf(c);
			const s = skills.createSkill(p, await jsonBody<SkillInput>(c));
			if (c.req.query("install") !== "0") await skills.installFor(p, s.id);
			return c.json({ skill: await skills.dto(p, s, true) });
		});
		api.post("/skills/drafts", async (c) => {
			const p = principalOf(c);
			const b = await jsonBody<{ spaceId: string; conversationId: number; name?: string }>(c);
			return c.json({ draft: await skills.draftFromConversation(p, b.spaceId, Number(b.conversationId), b.name) });
		});
		api.get("/skills/drafts/:id", (c) => c.json({ draft: skills.draftDTO(skills.draftRow(principalOf(c), c.req.param("id"))) }));
		api.patch("/skills/drafts/:id", async (c) => c.json({ draft: skills.updateDraft(principalOf(c), c.req.param("id"), await jsonBody(c)) }));
		api.post("/skills/drafts/:id/validate", async (c) => c.json({ draft: await skills.validateDraft(principalOf(c), c.req.param("id"), () => knownToolNames(ctx)) }));
		api.post("/skills/drafts/:id/publish", async (c) => {
			const p = principalOf(c);
			const b = await jsonBody<{ scope?: "personal" | "org" }>(c).catch(() => ({}) as { scope?: "personal" | "org" });
			const s = await skills.publishDraft(p, c.req.param("id"), b.scope);
			return c.json({ skill: await skills.dto(p, s, true) });
		});
		api.get("/skills/:id", async (c) => {
			const { p, s } = await skillOr404(c, "read");
			return c.json({ skill: await skills.dto(p, s, true) });
		});
		api.post("/skills/:id/versions", async (c) => {
			const p = principalOf(c);
			await skills.addVersion(p, c.req.param("id"), await jsonBody(c));
			return c.json({ skill: await skills.dto(p, skills.skill(c.req.param("id"))!, true) });
		});
		api.post("/skills/:id/install", async (c) => {
			const { p, s } = await skillOr404(c, "use");
			const b = await jsonBody<{ pinVersionNo?: number | null }>(c).catch(() => ({}) as { pinVersionNo?: number | null });
			await skills.installFor(p, s.id, b.pinVersionNo ?? null);
			return c.json({ skill: await skills.dto(p, skills.skill(s.id)!) });
		});
		api.patch("/skills/:id/install", async (c) => {
			const { p, s } = await skillOr404(c, "use");
			await skills.setInstall(p, s.id, await jsonBody(c));
			return c.json({ skill: await skills.dto(p, skills.skill(s.id)!) });
		});
		api.post("/skills/:id/install/upgrade", async (c) => {
			const { p, s } = await skillOr404(c, "use");
			await skills.upgrade(p, s.id);
			return c.json({ skill: await skills.dto(p, skills.skill(s.id)!) });
		});
		api.post("/skills/:id/install/rollback", async (c) => {
			const { p, s } = await skillOr404(c, "use");
			await skills.rollback(p, s.id);
			return c.json({ skill: await skills.dto(p, skills.skill(s.id)!) });
		});
		api.post("/skills/:id/grants", async (c) => {
			const { p, s } = await skillOr404(c, "use");
			const b = await jsonBody<{ versionNo: number; permissions: string[] }>(c);
			await skills.grant(p, s.id, Number(b.versionNo), b.permissions ?? []);
			return c.json({ skill: await skills.dto(p, skills.skill(s.id)!) });
		});
		api.get("/skills/:id/runs", async (c) => {
			const { p, s } = await skillOr404(c, "read");
			const manage = (await skills.decide(p, "write", s.id)).allow;
			return c.json({ runs: skills.runs(s.id, manage ? undefined : p.userId) });
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
