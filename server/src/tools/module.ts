// Tools module (group D): tool call records, MCP connectors, skills, sandbox, browser.
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import type { AppContext, Principal, WorkroomModule } from "../core/contracts.ts";
import { HttpError, jsonBody, principalOf } from "../core/http.ts";
import { ToolCallLog, TOOL_CALL_MIGRATIONS } from "./calls.ts";
import { BLOCKED_CONNECTORS, createToolSearch, McpManager, MCP_MIGRATIONS } from "./mcp.ts";
import { Sandbox, SANDBOX_MIGRATIONS } from "./sandbox.ts";
import { registerSandboxRoutes } from "./sandbox-routes.ts";
import { PROVIDER_CONFIG_MIGRATIONS } from "./sandbox/provider-config.ts"; // round 7: remote sandbox providers
import { registerSandboxProviderRoutes } from "./sandbox/provider-routes.ts";
import { ENV_MIGRATIONS } from "./sandbox/env-vars.ts"; // round 7b: sandbox env vars
import { registerSandboxEnvRoutes } from "./sandbox/env-routes.ts";
import { PERSIST_MIGRATIONS, workspacePersistenceFor } from "./sandbox/persist.ts"; // round 7b: persistent workspace versions
import { registerPersistRoutes } from "./sandbox/persist-routes.ts";
import { registerEnvironmentRoutes } from "./sandbox/environment-routes.ts"; // round 8: /conversations/:s/:c/environment
import { PREWARM_MIGRATIONS, prewarmFor } from "./sandbox/prewarm.ts"; // round 11 (R2b): intent-based prewarm + its log
import { registerPrewarmRoutes } from "./sandbox/prewarm-routes.ts";
import { registerSandboxStatsRoutes } from "./sandbox/lifecycle-stats-routes.ts"; // round 11 (R6): /stats/sandbox, /conversations/:s/:c/sandbox-stats, /sandbox/prices
import { createLegacyCodeRunExtension } from "../vfs/legacy-code-run.ts"; // round 14: replaces the removed browser execution; legacy only
import { CREDENTIAL_MIGRATIONS } from "./credentials/store.ts"; // round 7b: credentials
import { createCredentialExtension, CREDENTIAL_TOOL_NAMES } from "./credentials/extension.ts";
import { registerCredentialRoutes } from "./credentials/routes.ts";
import { sandboxEnvFor } from "./sandbox/env-vars.ts";
import { pdfFontStatus } from "../files/generate.ts";
import { slideRendererAvailable } from "../files/slides.ts";
import { createSandboxExtension } from "./sandbox-tools.ts";
import { VfsRouter } from "../vfs/router.ts";
import { WorkBackend } from "../vfs/backends/work.ts";
import { UploadsBackend } from "../vfs/backends/uploads.ts";
import { LibraryBackend } from "../vfs/backends/library.ts";
import { SkillsBackend } from "../vfs/backends/skills.ts";
import { createVfsExtension } from "../vfs/tools.ts";
import { BrowserService, createBrowserExtension } from "./browser.ts";
import { createSkillsExtension, Skills, SKILL_MIGRATIONS, type SkillInput } from "./skills.ts";
import { Market, MARKET_MIGRATIONS } from "./market.ts"; // marketplace group
import { createSkillManageExtension, registerSkillDraftRoutes, SKILL_DRAFT_MIGRATIONS } from "./skill-drafts.ts"; // round 6: skills from conversation
import { McpMarket, MCP_MARKET_MIGRATIONS } from "./mcp-market.ts"; // marketplace group
import { registerMarketRoutes } from "./market-routes.ts"; // marketplace group
import { createJobsExtension, Jobs, JOB_MIGRATIONS } from "./jobs.ts";
import { BrowserSessions, createBrowserSessionExtension } from "./browser-sessions.ts";
import { createHarnessPromptExtension } from "./harness-prompt.ts";
import { createPolicyExtension, POLICY_MIGRATIONS, TOOL_GROUPS, ToolPolicy } from "./policy.ts";
import type { BrowserActionRequest, ConversationWorkDTO } from "../../../shared/files.ts";
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

const D_TOOLS = ["file_create", "file_revise", "file_read", "file_list", "sandbox_exec", "sandbox_write_file", "sandbox_read_file", "sandbox_list", "sandbox_publish", "sandbox_import", "code_run", "browse", "skill", "skill_manage", "credential_request", "credential_http", "credential_list", "skill_list", "skill_load", "skill_read", "skill_run", "tool_search", "codemode"];
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
		...POLICY_MIGRATIONS.map((m) => ({ ...m, version: m.version + 500 })),
		...MARKET_MIGRATIONS.map((m) => ({ ...m, version: m.version + 600 })), // marketplace group
		...MCP_MARKET_MIGRATIONS.map((m) => ({ ...m, version: m.version + 700 })), // marketplace group
		...SKILL_DRAFT_MIGRATIONS.map((m) => ({ ...m, version: m.version + 800 })), // skill drafts (round 6)
		...PROVIDER_CONFIG_MIGRATIONS.map((m) => ({ ...m, version: m.version + 900 })), // sandbox provider configs (round 7)
		...ENV_MIGRATIONS.map((m) => ({ ...m, version: m.version + 1100 })), // sandbox env vars (round 7b)
		...PERSIST_MIGRATIONS.map((m) => ({ ...m, version: m.version + 1000 })), // workspace versions (round 7b)
		...CREDENTIAL_MIGRATIONS.map((m) => ({ ...m, version: m.version + 1200 })), // credentials (round 7b)
		...PREWARM_MIGRATIONS.map((m) => ({ ...m, version: m.version + 1500 })), // sandbox prewarm log (round 11, R2b)
	],
	init(ctx) {
		ctx.services.provide("toolCalls", new ToolCallLog(ctx));
		ctx.services.provide("mcp", new McpManager(ctx));
		ctx.services.provide("sandbox", new Sandbox(ctx));
		ctx.services.provide("browser", new BrowserService(ctx));
		ctx.services.provide("skills", new Skills(ctx));
		ctx.services.provide("market", new Market(ctx)); // marketplace group
		ctx.services.provide("mcpMarket", new McpMarket(ctx)); // marketplace group
		ctx.services.provide("jobs", new Jobs(ctx));
		ctx.services.provide("sandboxPrewarm", prewarmFor(ctx)); // round 11 (R2b): the runtime calls it after a user message is accepted
		ctx.services.provide("toolPolicy", new ToolPolicy(ctx));
		// Round 14: the agent's virtual filesystem (/skills /memory /library /uploads /work). Other modules register their backends on it
		// (knowledge: /memory; skills: /skills) — see docs/r14-virtual-backend.md.
		const vfs = new VfsRouter();
		vfs.register(new WorkBackend(ctx));
		vfs.register(new UploadsBackend(ctx));
		vfs.register(new LibraryBackend(ctx));
		vfs.register(new SkillsBackend(ctx));
		(ctx.services as any).provide("vfs", vfs);
		const sessions = new BrowserSessions(ctx);
		ctx.services.provide("browserSessions", sessions);
		// Work items of a conversation (for ConversationState.work — see docs/requests/D.md).
		ctx.services.provide("work", {
			forConversation: (spaceId: string, conversationId: number): ConversationWorkDTO => ({
				jobs: (ctx.services.get("jobs") as Jobs).forConversation(spaceId, conversationId),
				browserSessions: sessions.forConversation(spaceId, conversationId),
				// round 14: the conversation's delivered outputs — the single source of chat file cards and the side panel's 输出
				outputs: (ctx.services as any).has("library") ? ((ctx.services as any).get("library") as { ofConversation(s: string, c: number): ConversationWorkDTO["outputs"] }).ofConversation(spaceId, conversationId) : [],
			}),
		});
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
		const codemode = createCodemodeExtension({ sandbox: codemodeSandbox, models: false, inlineBudget: 0 }); // native tools carry their schemas; the wr.harness section replaces the catalog
		return [createPolicyExtension(ctx), createHarnessPromptExtension(ctx), ext, createVfsExtension(ctx), createSandboxExtension(ctx), createLegacyCodeRunExtension(), createBrowserExtension(ctx), createSkillsExtension(ctx), createSkillManageExtension(ctx), createCredentialExtension(ctx), createJobsExtension(ctx), createBrowserSessionExtension(ctx), codemode];
	},
	async start(ctx) {
		// Before the sandbox accepts runs: runs left "running" by a crash become "unknown" (never re-executed).
		workspacePersistenceFor(ctx).reconcileInterruptedRuns();
		// Ordinary env vars may never use a name a credential is injected under.
		sandboxEnvFor(ctx).isCredentialEnvName = (orgId: string, name: string) =>
			!!ctx.db.get("SELECT 1 FROM credentials WHERE org_id = ? AND usage = 'env' AND env_name = ? COLLATE NOCASE AND revoked_at IS NULL LIMIT 1", orgId, name);
		(ctx.services.get("mcp") as McpManager).start();
		(ctx.services.get("sandbox") as Sandbox).start();
		(ctx.services.get("market") as Market).start(); // marketplace group: skills mount provider
		(ctx.services.get("browserSessions") as BrowserSessions).start();
	},
	async stop(ctx) {
		(ctx.services.get("market") as Market).stop(); // marketplace group
		await (ctx.services.get("mcp") as McpManager).stop();
		await (ctx.services.get("sandbox") as Sandbox).stop();
		await (ctx.services.get("browserSessions") as BrowserSessions).stop();
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

		// ---- sandbox: driver status/settings, workspace file API, runs, publish (server/src/tools/sandbox-routes.ts) ----
		registerEnvironmentRoutes(api, ctx); // round 8 (Q2)
		registerPrewarmRoutes(api, ctx); // round 11 (R2b): /sandbox/prewarm
		registerSandboxStatsRoutes(api, ctx); // round 11 (R6): before /sandbox/:spaceId so /sandbox/prices is not captured
		registerSandboxEnvRoutes(api, ctx); // round 7b: /sandbox-env/*
		registerPersistRoutes(api, ctx); // round 7b: /workspaces/*, /workspace-policy
		registerCredentialRoutes(api, ctx); // round 7b: /credential-requests/*, /credentials/*
		registerSandboxProviderRoutes(api, ctx); // before /sandbox/:spaceId so /sandbox/providers etc. are not captured
		registerSandboxRoutes(api, ctx);

		// ---- default toolset policy (per org; enforced per call in a beforeTool hook) ----
		const policy = ctx.services.get("toolPolicy") as ToolPolicy;
		const policyDTO = (orgId: string) => {
			const g = policy.groups(orgId);
			return { groups: Object.entries(TOOL_GROUPS).map(([id, d]) => ({ id, label: d.label, enabled: g[id as keyof typeof g] })) };
		};
		api.get("/tools/policy", (c) => c.json(policyDTO(principalOf(c).orgId)));
		api.put("/tools/policy", async (c) => {
			const p = principalOf(c);
			await ctx.services.get("authz").require(p, "sandbox.policy.manage", undefined);
			policy.set(p, (await jsonBody<{ groups: Record<string, boolean> }>(c)).groups ?? {});
			return c.json(policyDTO(p.orgId));
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

		// ---- interactive browser sessions (M11-B): watch = space read; act / take over / close = space write ----
		const bs = ctx.services.get("browserSessions") as BrowserSessions;
		const sessionFor = async (c: any, action: "read" | "write") => {
			const p = principalOf(c);
			const s = bs.get(c.req.param("id"));
			if (!s) throw new HttpError(404, "not_found", "浏览会话不存在或已关闭");
			await acl.require(p, action, { kind: "space", id: s.spaceId });
			return { p, s };
		};
		const canWrite = async (p: Principal, spaceId: string) => (await acl.check(p, "write", { kind: "space", id: spaceId })).allow;
		api.get("/browser-sessions", async (c) => {
			const p = principalOf(c);
			const q = c.req.query();
			let spaceIds: string[];
			if (q.spaceId) {
				await acl.require(p, "read", { kind: "space", id: q.spaceId });
				spaceIds = [q.spaceId];
			} else spaceIds = (await acl.readableSpaces(p)).map((s) => s.id);
			const list = bs.list(spaceIds, q.conversationId ? Number(q.conversationId) : undefined);
			return c.json({ sessions: await Promise.all(list.map(async (s) => bs.dto(s, await canWrite(p, s.spaceId)))) });
		});
		api.post("/browser-sessions", async (c) => {
			const p = principalOf(c);
			const b = await jsonBody<{ spaceId: string; conversationId: number; url: string }>(c);
			await acl.require(p, "write", { kind: "space", id: b.spaceId });
			const s = await bs.open(p, b.spaceId, Number(b.conversationId), b.url, "user");
			return c.json({ session: bs.dto(s, true) });
		});
		api.get("/browser-sessions/:id", async (c) => {
			const { p, s } = await sessionFor(c, "read");
			return c.json({ session: bs.dto(s, await canWrite(p, s.spaceId)) });
		});
		api.get("/browser-sessions/:id/screenshot", async (c) => {
			const { s } = await sessionFor(c, "read");
			return new Response(bs.screenshot(s.id) as unknown as Uint8Array<ArrayBuffer>, { headers: { "content-type": "image/png", "cache-control": "private, no-store", "x-content-type-options": "nosniff", "x-session-version": String(s.version) } });
		});
		api.post("/browser-sessions/:id/actions", async (c) => {
			const { p, s } = await sessionFor(c, "write");
			const updated = await bs.act(p, s.id, await jsonBody<BrowserActionRequest>(c), "user");
			return c.json({ session: bs.dto(updated, true) });
		});
		api.post("/browser-sessions/:id/takeover", async (c) => {
			const { p, s } = await sessionFor(c, "write");
			return c.json({ session: bs.dto(bs.takeover(p, s.id), true) });
		});
		api.post("/browser-sessions/:id/release", async (c) => {
			const { p, s } = await sessionFor(c, "write");
			return c.json({ session: bs.dto(bs.release(p, s.id), true) });
		});
		api.delete("/browser-sessions/:id", async (c) => {
			const { s } = await sessionFor(c, "write");
			await bs.close(s.id);
			return c.json({ ok: true });
		});
		api.get("/work/:spaceId/:conversationId", async (c) => {
			const p = principalOf(c);
			const spaceId = c.req.param("spaceId");
			await acl.require(p, "read", { kind: "space", id: spaceId });
			const cid = Number(c.req.param("conversationId"));
			const w = (ctx.services.get("work") as { forConversation(s: string, c: number): ConversationWorkDTO }).forConversation(spaceId, cid);
			const cw = await canWrite(p, spaceId);
			return c.json({ work: { jobs: w.jobs.map((j) => ({ ...j, canCancel: cw })), browserSessions: w.browserSessions.map((x) => ({ ...x, canControl: cw })) } });
		});

		// ---- capabilities (M14-A, tools side): what this user can use right now, and what is unavailable and why ----
		api.get("/tools/capabilities", async (c) => {
			const p = principalOf(c);
			const cap = await (ctx.services.get("sandbox") as Sandbox).capabilities();
			const br = (ctx.services.get("browser") as BrowserService).available();
			const conns = await Promise.all(mgr.rows(p.orgId).filter((r) => r.scope === "system" || r.owner_user_id === p.userId).map((r) => mgr.dto(p, r)));
			const sk = ctx.services.get("skills") as Skills;
			return c.json({
				deliverables: { formats: ["md", "html", "csv", "docx", "xlsx", "pptx", "pdf"], tools: ["file_create", "file_revise", "file_read", "file_list"], pdfCjkFont: pdfFontStatus(), pptxSlideImages: slideRendererAvailable() },
				policy: policyDTO(p.orgId).groups,
				sandbox: { status: !policy.groups(p.orgId).sandbox ? "disabled_by_admin" : cap.state === "ready" ? "ready" : cap.state === "needs_setup" ? "needs_setup" : "unavailable", detail: cap.state === "ready" ? `${cap.label}：${(ctx.services.get("sandbox") as Sandbox).isolationFor(cap.driver)}` : cap.detail, driver: cap.driver, languages: ["shell", "python", "node"], network: cap.network.allowed },
				codemode: { status: "ready", detail: "QuickJS（WebAssembly）脚本，可调用会话中的工具" },
				browser: { status: br.ok ? "ready" : "unavailable", detail: br.detail },
				connectors: conns.map((x) => ({ id: x.id, name: x.name, status: x.status, statusDetail: x.statusDetail, access: x.access, enabledForMe: x.enabledForMe, tools: x.tools.length, usable: x.access === "allowed" && x.enabledForMe && (x.status === "ready" || x.status === "needs_reconnect") })),
				blockedConnectors: BLOCKED_CONNECTORS,
				skills: (await sk.active(p)).map(({ skill, version }) => {
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
		const market = ctx.services.get("market") as Market;
		registerMarketRoutes(api, ctx); // marketplace group: /market/*, per-user connector credentials and tool settings
		registerSkillDraftRoutes(api, ctx); // GET /api/skill-drafts/:id (owner only)
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
			return c.json({ skills: await Promise.all((await skills.visible(p)).map((s) => skills.dto(p, s))) });
		});
		api.post("/skills", async (c) => {
			const p = principalOf(c);
			const input = await jsonBody<SkillInput>(c);
			if (input.scope === "org") await market.require(p, "skill.marketplace.manage", undefined, "只有技能市场管理员可以直接发布组织技能；成员请上传技能包并提交审核");
			const s = await skills.createSkill(p, input);
			if (c.req.query("install") !== "0") await skills.installFor(p, s.id);
			return c.json({ skill: await skills.dto(p, s, true) });
		});
		api.post("/skills/drafts", async (c) => {
			const p = principalOf(c);
			const b = await jsonBody<{ spaceId: string; conversationId: number; name?: string }>(c);
			return c.json({ draft: await skills.draftFromConversation(p, b.spaceId, Number(b.conversationId), b.name) });
		});
		api.get("/skills/drafts", (c) => c.json({ drafts: skills.listDrafts(principalOf(c)) }));
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
		api.delete("/skills/:id/install", async (c) => {
			const { p, s } = await skillOr404(c, "use");
			skills.uninstall(p, s.id);
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
			// Marketplace policy: personal connectors may need a reviewer's approval before the first connection.
			const mkt = ctx.services.get("market") as Market;
			let approval: "approved" | "pending" = "approved";
			if (b.scope === "personal") {
				await mkt.require(p, "mcp.connector.add_personal", undefined, "没有添加个人连接器的权限");
				const pol = mkt.policy(p.orgId).personalMcp;
				if (pol === "disabled") throw new HttpError(403, "policy_disabled", "组织策略不允许添加个人连接器");
				if (pol === "approval") approval = "pending";
			} else if (b.scope === "system") await mkt.require(p, "mcp.connector.add_org", undefined, "没有添加组织连接器的权限（mcp.connector.add_org）");
			const row = mgr.create(p, b, { approval });
			let submissionId: string | undefined;
			if (approval === "pending") submissionId = await (ctx.services.get("mcpMarket") as McpMarket).requestConnectorApproval(p, row);
			const checked = b.check === false || approval === "pending" ? row : await mgr.check(row.id, p.userId);
			return c.json({ connector: await mgr.dto(p, checked), submissionId });
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
			return c.json({ connector: await mgr.dto(p, await mgr.check(row.id, p.userId)) });
		});
		// Reconnect: managers may supply new credentials; anyone who may use it can re-run the connection check.
		api.post("/connectors/:id/reconnect", async (c) => {
			const p = principalOf(c);
			let row = mgr.row(c.req.param("id"));
			if (!row) throw new HttpError(404, "not_found", "连接不存在");
			await acl.require(p, "use", { kind: "connector", id: row.id });
			const b = await jsonBody<{ secrets?: Record<string, string> }>(c).catch(() => ({}) as { secrets?: Record<string, string> });
			if (b.secrets) {
				await acl.require(p, "admin", { kind: "connector", id: row.id });
				row = mgr.update(p, row, { secrets: b.secrets });
			}
			await mgr.disconnect(row.id);
			return c.json({ connector: await mgr.dto(p, await mgr.check(row.id, p.userId)) });
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
