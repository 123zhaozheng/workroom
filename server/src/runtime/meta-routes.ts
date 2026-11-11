// Round 9 (B2) HTTP routes: conversation star / tags / soft delete / export, conversation-meta, global search + preview.
// Contract: shared/round9.ts. Every handler delegates the permission decision to ConversationMeta / SearchIndex (Runtime.access).
import type { Hono } from "hono";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AppEnv } from "../core/contracts.ts";
import { HttpError, jsonBody, principalOf } from "../core/http.ts";
import type { ConversationMeta } from "./meta.ts";
import type { SearchIndex } from "./search.ts";

const ctx0 = BACKGROUND_CONTEXT;

function convId(raw: string): number {
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "invalid_id", "会话 id 无效");
	return n;
}

export function mountMetaRoutes(api: Hono<AppEnv>, meta: ConversationMeta, search: SearchIndex): void {
	api.get("/conversation-meta", async (c) => c.json({ items: await meta.list(principalOf(c), ctx0) }));

	api.put("/conversations/:spaceId/:id/star", async (c) => {
		const b = await jsonBody<{ starred?: unknown }>(c);
		const m = await meta.star(principalOf(c), c.req.param("spaceId"), convId(c.req.param("id")), b?.starred, ctx0);
		return c.json({ ok: true, meta: m, starred: m.starred });
	});

	api.put("/conversations/:spaceId/:id/tags", async (c) => {
		const b = await jsonBody<{ tags?: unknown }>(c);
		const m = await meta.setTags(principalOf(c), c.req.param("spaceId"), convId(c.req.param("id")), b?.tags, ctx0);
		return c.json({ ok: true, meta: m, tags: m.tags });
	});

	api.delete("/conversations/:spaceId/:id", async (c) => {
		const r = await meta.remove(principalOf(c), c.req.param("spaceId"), convId(c.req.param("id")), ctx0, c.get("requestId"));
		return c.json(r);
	});

	api.get("/conversations/:spaceId/:id/export", async (c) => {
		const format = (c.req.query("format") ?? "md").toLowerCase();
		if (format !== "md" && format !== "markdown") throw new HttpError(400, "unsupported_format", "目前只支持 format=md");
		const id = convId(c.req.param("id"));
		const out = await meta.exportMarkdown(principalOf(c), c.req.param("spaceId"), id, ctx0);
		return c.body(out.body, 200, {
			"content-type": "text/markdown; charset=utf-8",
			"content-disposition": `attachment; filename="conversation-${id}.md"; filename*=UTF-8''${encodeURIComponent(out.filename)}.md`,
			"cache-control": "no-store",
			...(out.truncated ? { "x-export-truncated": "1" } : {}),
		});
	});

	api.get("/search", async (c) => {
		const r = await search.search(principalOf(c), c.req.query("q") ?? "", Number(c.req.query("limit")) || undefined, ctx0);
		c.header("cache-control", "no-store");
		return c.json(r);
	});

	api.get("/search/preview/:spaceId/:conversationId", async (c) => {
		const raw = c.req.query("entryId");
		const entryId = raw === undefined || raw === "" ? undefined : Number(raw);
		const r = await search.preview(principalOf(c), c.req.param("spaceId"), convId(c.req.param("conversationId")), entryId, ctx0);
		c.header("cache-control", "no-store");
		return c.json(r);
	});
}
