// HTTP routes of the skills / MCP marketplace (mounted under /api by the tools module). Authorisation lives in Market / McpMarket
// (scoped permissions from the RBAC catalog: skill.review, skill.publish, skill.marketplace.manage, mcp.connector.*).
import type { Hono } from "hono";
import type { AppContext, AppEnv } from "../core/contracts.ts";
import { HttpError, jsonBody, principalOf } from "../core/http.ts";
import type { McpManager } from "./mcp.ts";
import type { McpMarket } from "./mcp-market.ts";
import type { Market } from "./market.ts";

/** Multipart `file` (.zip) or JSON `{ files: [{path, content, encoding}] }` (folder upload read by the browser). */
async function readUpload(c: any): Promise<{ zip?: Uint8Array; files?: { path: string; content: string; encoding?: "utf8" | "base64" }[]; fields: Record<string, string> }> {
	const type = c.req.header("content-type") ?? "";
	if (type.includes("multipart/form-data")) {
		const body = await c.req.parseBody();
		const f = body.file;
		const fields: Record<string, string> = {};
		for (const [k, v] of Object.entries(body)) if (typeof v === "string") fields[k] = v;
		if (!(f instanceof File)) throw new HttpError(400, "file_required", "请用 multipart 字段 file 上传 .zip 技能包");
		if (f.size > 13 * 1024 * 1024) throw new HttpError(413, "upload_too_large", "上传内容过大");
		return { zip: new Uint8Array(await f.arrayBuffer()), fields };
	}
	const b = await jsonBody<{ files?: { path: string; content: string; encoding?: "utf8" | "base64" }[]; zipBase64?: string; changeNote?: string; skillId?: string; entryId?: string; serverJson?: unknown }>(c);
	const fields: Record<string, string> = {};
	for (const k of ["changeNote", "skillId", "entryId"] as const) if (typeof b[k] === "string") fields[k] = b[k]!;
	if (b.zipBase64) return { zip: new Uint8Array(Buffer.from(b.zipBase64, "base64")), fields };
	return { files: b.files, fields, ...(b.serverJson !== undefined ? { serverJson: b.serverJson } : {}) } as any;
}

export function registerMarketRoutes(api: Hono<AppEnv>, ctx: AppContext): void {
	const market = ctx.services.get("market") as Market;
	const mm = ctx.services.get("mcpMarket") as McpMarket;
	const mgr = ctx.services.get("mcp") as McpManager;
	const needTarget = (v: unknown): "me" | "project" | "department" | "org" => {
		if (v === "me" || v === "project" || v === "department" || v === "org") return v;
		throw new HttpError(400, "invalid", "target 必须是 me、project、department 或 org");
	};

	// ---------------------------------------------------------------- meta / policy
	api.get("/market/me", async (c) => c.json({ me: await market.me(principalOf(c)) }));
	api.get("/market/policy", (c) => c.json({ policy: market.policy(principalOf(c).orgId) }));
	api.put("/market/policy", async (c) => c.json({ policy: await market.setPolicy(principalOf(c), await jsonBody(c)) }));

	// ---------------------------------------------------------------- skills: browse
	api.get("/market/skills", async (c) => c.json({ skills: await market.list(principalOf(c), c.req.query()) }));
	api.get("/market/categories", async (c) => c.json({ categories: await market.categories(principalOf(c)) }));
	api.post("/market/skills/upload", async (c) => {
		const p = principalOf(c);
		const u = await readUpload(c);
		const out = await market.upload(p, { skillId: u.fields.skillId, zip: u.zip, files: u.files, changeNote: u.fields.changeNote });
		return c.json({ skill: await market.detail(p, out.skill.id, out.version.version_no), versionNo: out.version.version_no, checks: out.check, submission: out.submission });
	});
	api.get("/market/skills/:id", async (c) => c.json({ skill: await market.detail(principalOf(c), c.req.param("id"), c.req.query("version") ? Number(c.req.query("version")) : undefined) }));
	api.get("/market/skills/:id/versions/:no/file", async (c) => c.json({ file: await market.readFile(principalOf(c), c.req.param("id"), Number(c.req.param("no")), c.req.query("path") ?? "") }));
	api.get("/market/skills/:id/versions/:no/package", async (c) => {
		const f = await market.packageBytes(principalOf(c), c.req.param("id"), Number(c.req.param("no")));
		return new Response(f.bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${f.name}"`, "x-content-type-options": "nosniff", "cache-control": "private, no-store" } });
	});
	api.post("/market/skills/:id/versions/:no/submit", async (c) => {
		const b = await jsonBody<{ targetScope: any; targetRef?: string; note?: string }>(c);
		return c.json({ submission: await market.submit(principalOf(c), c.req.param("id"), Number(c.req.param("no")), b) });
	});
	api.post("/market/skills/:id/rate", async (c) => {
		const b = await jsonBody<{ stars: number; comment?: string }>(c);
		return c.json({ rating: await market.rate(principalOf(c), c.req.param("id"), Number(b.stars), b.comment) });
	});
	api.post("/market/skills/:id/install", async (c) => {
		const b = await jsonBody<{ target?: string; scopeRef?: string; pinVersionNo?: number | null }>(c).catch(() => ({}) as { target?: string; scopeRef?: string; pinVersionNo?: number | null });
		return c.json({ skill: await market.install(principalOf(c), c.req.param("id"), { target: needTarget(b.target ?? "me"), scopeRef: b.scopeRef, pinVersionNo: b.pinVersionNo }) });
	});
	api.delete("/market/skills/:id/install", async (c) => {
		await market.uninstall(principalOf(c), c.req.param("id"), needTarget(c.req.query("target") ?? "me"), c.req.query("scopeRef"));
		return c.json({ ok: true });
	});
	api.post("/market/skills/:id/unpublish", async (c) => c.json({ skill: await market.unpublish(principalOf(c), c.req.param("id"), (await jsonBody<{ reason: string }>(c)).reason) }));
	api.post("/market/skills/:id/republish", async (c) => c.json({ skill: await market.republish(principalOf(c), c.req.param("id")) }));
	api.post("/market/skills/:id/force-publish", async (c) => {
		const b = await jsonBody<{ versionNo: number; reason: string; targetScope?: any; targetRef?: string }>(c);
		return c.json({ submission: await market.forcePublish(principalOf(c), c.req.param("id"), Number(b.versionNo), b.reason, { scope: b.targetScope, ref: b.targetRef }) });
	});

	// ---------------------------------------------------------------- review queue
	api.get("/market/submissions", async (c) => c.json({ submissions: await market.listSubmissions(principalOf(c), c.req.query()) }));
	api.get("/market/submissions/:id", async (c) => c.json({ submission: await market.submissionDetail(principalOf(c), c.req.param("id")) }));
	api.post("/market/submissions/:id/decision", async (c) => c.json({ submission: await market.decide(principalOf(c), c.req.param("id"), await jsonBody(c)) }));
	api.post("/market/submissions/:id/publish", async (c) => c.json({ submission: await market.publishApproved(principalOf(c), c.req.param("id")) }));
	api.post("/market/submissions/:id/withdraw", async (c) => c.json({ submission: await market.withdraw(principalOf(c), c.req.param("id")) }));

	// ---------------------------------------------------------------- MCP catalog
	api.get("/market/mcp", async (c) => c.json({ entries: await mm.list(principalOf(c), c.req.query()) }));
	api.post("/market/mcp/import", async (c) => {
		const p = principalOf(c);
		const u: any = await readUpload(c);
		const out = await mm.import(p, { serverJson: u.serverJson, zip: u.zip, entryId: u.fields.entryId, changeNote: u.fields.changeNote });
		return c.json({ entry: await mm.detail(p, out.entry.id, out.version.version_no), versionNo: out.version.version_no, checks: out.check });
	});
	api.get("/market/mcp/:id", async (c) => c.json({ entry: await mm.detail(principalOf(c), c.req.param("id"), c.req.query("version") ? Number(c.req.query("version")) : undefined) }));
	api.get("/market/mcp/:id/versions/:no/file", async (c) => c.json({ file: await mm.readFile(principalOf(c), c.req.param("id"), Number(c.req.param("no")), c.req.query("path") ?? "server.json") }));
	api.post("/market/mcp/:id/versions/:no/submit", async (c) => c.json({ submission: await mm.submit(principalOf(c), c.req.param("id"), Number(c.req.param("no")), await jsonBody(c)) }));
	api.post("/market/mcp/:id/force-publish", async (c) => {
		const b = await jsonBody<{ versionNo: number; reason: string; targetScope?: any; targetRef?: string }>(c);
		return c.json({ submission: await mm.forcePublish(principalOf(c), c.req.param("id"), Number(b.versionNo), b.reason, { scope: b.targetScope, ref: b.targetRef }) });
	});
	api.post("/market/mcp/:id/unpublish", async (c) => {
		await mm.unpublish(principalOf(c), c.req.param("id"), (await jsonBody<{ reason: string }>(c)).reason);
		return c.json({ ok: true });
	});
	api.post("/market/mcp/:id/install", async (c) => {
		const p = principalOf(c);
		const out = await mm.install(p, c.req.param("id"), await jsonBody(c));
		return c.json({ connector: await mgr.dto(p, out.connector), submissionId: out.submissionId });
	});

	// ---------------------------------------------------------------- connectors: my credentials, my tool settings
	const connectorFor = async (c: any) => {
		const p = principalOf(c);
		const row = mgr.row(c.req.param("id"));
		if (!row) throw new HttpError(404, "not_found", "连接不存在");
		await ctx.services.get("acl").require(p, "use", { kind: "connector", id: row.id });
		return { p, row };
	};
	api.put("/connectors/:id/my-secrets", async (c) => {
		const { p, row } = await connectorFor(c);
		mgr.setMySecrets(row, p.userId, (await jsonBody<{ secrets: Record<string, string> }>(c)).secrets ?? {});
		market.audit(p, "connector.my_secrets", row.id, { names: mgr.mySecretNames(row, p.userId) });
		const checked = await mgr.check(row.id, p.userId);
		return c.json({ connector: await mgr.dto(p, checked) });
	});
	api.delete("/connectors/:id/my-secrets", async (c) => {
		const { p, row } = await connectorFor(c);
		mgr.setMySecrets(row, p.userId, {});
		return c.json({ connector: await mgr.dto(p, mgr.row(row.id)!) });
	});
	api.put("/connectors/:id/my-tools", async (c) => {
		const { p, row } = await connectorFor(c);
		mgr.setToolOverrides(row, p.userId, (await jsonBody<{ overrides: Record<string, "ask" | "disabled" | null> }>(c)).overrides ?? {});
		return c.json({ connector: await mgr.dto(p, row) });
	});
}
