// Knowledge & memory module (group C). Auto-loaded by server/src/modules.ts.
// Services: "knowledge" (core KnowledgeService contract), "knowledgeAdmin" (full Knowledge facade, incl. file hooks for D).
import type { Hono } from "hono";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AppContext, AppEnv, FileVersionRef, Principal, ResourceRef, WorkroomModule } from "../core/contracts.ts";
import { HttpError, jsonBody, principalOf } from "../core/http.ts";
import type {
	AddKbDocRequest,
	CreateKbRequest,
	KbCapabilities,
	KbEvalSample,
	KbScope,
	KbSearchRequest,
	ConversationCitationStatus,
	RetrievalEventDTO,
	UpdateGovernanceRequest,
} from "../../../shared/knowledge.ts";
import { KNOWLEDGE_MIGRATIONS } from "./schema.ts";
import { KnowledgeStore } from "./service.ts";
import { IngestPipeline } from "./pipeline.ts";
import { MarkdownMemory, parseScopeId, scopeId, type MemFile } from "./memory-md.ts";
import { VfsError } from "../vfs/types.ts";
import { migrateMemoryToMarkdown } from "./memory-migrate.ts";
import { MemoryBackend } from "../vfs/backends/memory.ts";
import { knowledgeExtension } from "./extension.ts";
import { embeddingStatus, type EmbeddingProvider } from "./embeddings.ts";
import { runEval } from "./eval.ts";
import { findRetrievalEvents, pruneRetrievalEvents } from "./events.ts";
import { SUPPORTED_FORMATS } from "./parsers.ts";
import { ocrSupport, TesseractOcr } from "./ocr.ts";

/** Facade provided as service "knowledgeAdmin". */
export class Knowledge {
	readonly ctx: AppContext;
	readonly store: KnowledgeStore;
	readonly memory: MarkdownMemory;
	readonly pipeline: IngestPipeline;
	embeddings: EmbeddingProvider | null = null;
	constructor(ctx: AppContext) {
		this.ctx = ctx;
		this.store = new KnowledgeStore(ctx);
		this.memory = new MarkdownMemory(ctx, this.store.access);
		this.pipeline = new IngestPipeline(ctx, this.store);
		this.store.onWork = () => this.pipeline.kick();
		// Offline OCR when its packages are installed (WORKROOM_KB_OCR=0 disables it).
		const ocr = ocrSupport();
		this.ocrStatus = process.env.WORKROOM_KB_OCR === "0" ? { ok: false, missing: "disabled by WORKROOM_KB_OCR=0" } : ocr;
		if (this.ocrStatus.ok) this.pipeline.ocr = new TesseractOcr(ctx.config.dataDir);
	}
	readonly ocrStatus: { ok: true } | { ok: false; missing: string };
	/** Files module hook: new file version → re-index KB docs that follow the file. */
	fileVersionAdded(fileId: string, ref: FileVersionRef, by?: Principal): string[] {
		return this.store.fileVersionAdded(fileId, ref, by);
	}
	/** Files module hook: file deleted → its KB docs leave retrieval immediately. */
	fileDeleted(fileId: string): number {
		return this.store.fileDeleted(fileId);
	}
	/** For E's /admin/trace (M18-B): retrieval events of an org matching a correlation id. */
	retrievalEvents(orgId: string, q: string): RetrievalEventDTO[] {
		return findRetrievalEvents(this.ctx.db, orgId, q);
	}
	setEmbeddingProvider(p: EmbeddingProvider | null): void {
		this.embeddings = p;
	}
	capabilities(): KbCapabilities {
		return {
			fulltext: { status: "ready", detail: "SQLite FTS5（trigram 分词，支持中文子串）+ BM25/覆盖度重排；2 字词使用 LIKE 回退" },
			vector: embeddingStatus(this.embeddings),
			ocr: this.ocrStatus.ok
				? { status: "ready", detail: "离线 OCR：tesseract.js（WASM）+ 本地 chi_sim/eng 语言数据；图片与无文本层的 PDF 页面（栅格化后识别，单文档最多 100 页）" }
				: { status: "blocked", detail: `OCR 不可用（缺少 ${this.ocrStatus.missing}）；图片与扫描件 PDF 会显示 ocr_unavailable / no_text 失败` },
			formats: this.ocrStatus.ok ? [...SUPPORTED_FORMATS, "image"] : SUPPORTED_FORMATS,
		};
	}
}

const instances = new WeakMap<AppContext, Knowledge>();
const MAX_STATUS_BATCH = 1000;

/** kb_search tool results of a conversation (pi transcript, read-only): callId, entry id and cited chunk ids. */
async function conversationCitations(ctx: AppContext, spaceId: string, conversationId: number): Promise<ConversationCitationStatus["calls"]> {
	const harness = await ctx.services.get("runtime").harness(spaceId, BACKGROUND_CONTEXT);
	const conv = await harness.conversation(conversationId as any, BACKGROUND_CONTEXT);
	if (!conv) throw new HttpError(404, "not_found", "会话不存在");
	const out: { entryId: number; callId: string; chunkIds: string[] }[] = [];
	let cursor: any;
	for (let page = 0; page < 200; page++) {
		const r = await conv.entries({ order: "ascending" }, 500, cursor, BACKGROUND_CONTEXT);
		for (const e of r.items) {
			const m = e.kind === "pi.tool-result" ? (e.model?.[0] as any) : undefined;
			if (m?.toolName !== "kb_search") continue;
			const cits = Array.isArray(m.details?.citations) ? m.details.citations : [];
			out.push({ entryId: e.id as number, callId: m.toolCallId, chunkIds: cits.map((x: any) => String(x.chunkId)).filter(Boolean) });
		}
		if (!r.next) break;
		cursor = r.next;
	}
	return out;
}
export function knowledgeOf(ctx: AppContext): Knowledge {
	const k = instances.get(ctx);
	if (!k) throw new Error("knowledge module not initialised");
	return k;
}

function mountRoutes(api: Hono<AppEnv>, ctx: AppContext): void {
	const k = () => knowledgeOf(ctx);
	const s = () => k().store;

	// ----- knowledge bases -----
	api.get("/kb/capabilities", (c) => {
		principalOf(c);
		return c.json(k().capabilities());
	});
	api.post("/kb/search", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<KbSearchRequest>(c);
		if (typeof b.query !== "string") throw new HttpError(400, "invalid", "query 必填");
		return c.json(await s().search(p, b.query, { ...b, trace: { source: "api", requestId: c.get("requestId") } }));
	});
	api.post("/kb/eval", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ samples: KbEvalSample[]; kbIds?: string[]; explain?: boolean }>(c);
		if (!Array.isArray(b.samples) || b.samples.length > 200) throw new HttpError(400, "invalid", "samples 必须是数组（最多 200 条）");
		return c.json(await runEval(s(), p, b.samples, { kbIds: b.kbIds, requestId: c.get("requestId"), explain: !!b.explain }));
	});
	api.get("/kb/admin/retrieval-events", (c) => {
		const p = principalOf(c);
		const role = s().access.liveOrgRole(p.userId, p.orgId);
		if (role !== "owner" && role !== "admin") throw new HttpError(403, "forbidden", "只有组织管理员可以查看检索事件", { reason: "not_admin" });
		const q = c.req.query("q")?.trim();
		if (!q) throw new HttpError(400, "invalid", "q 必填：requestId / <spaceId>:<conversationId> / callId / 事件 id / queryHash");
		return c.json({ events: k().retrievalEvents(p.orgId, q) });
	});
	api.get("/kb/citations/:chunkId/status", (c) => {
		const p = principalOf(c);
		return c.json(s().citationStatus(p, c.req.param("chunkId")));
	});
	api.post("/kb/citations/status", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ chunkIds: string[] }>(c);
		if (!Array.isArray(b.chunkIds) || b.chunkIds.length > MAX_STATUS_BATCH) throw new HttpError(400, "invalid", `chunkIds 必须是数组（最多 ${MAX_STATUS_BATCH} 个）`);
		const statuses = [...new Set(b.chunkIds.map(String))].map((id) => s().citationStatus(p, id));
		return c.json({ statuses, byChunkId: Object.fromEntries(statuses.map((x) => [x.chunkId, x])) });
	});
	// Every citation kb_search produced in one conversation, with its current validity (M06-C 失效提示 for old answers).
	api.get("/kb/conversations/:spaceId/:conversationId/citation-status", async (c) => {
		const p = principalOf(c);
		const spaceId = c.req.param("spaceId");
		const conversationId = Number(c.req.param("conversationId"));
		if (!Number.isInteger(conversationId) || conversationId <= 0) throw new HttpError(400, "invalid_id", "会话 id 无效");
		await ctx.services.get("acl").require(p, "read", { kind: "conversation", id: String(conversationId), spaceId });
		const calls = await conversationCitations(ctx, spaceId, conversationId);
		const ids = [...new Set(calls.flatMap((x) => x.chunkIds))];
		const statuses = ids.map((id) => s().citationStatus(p, id));
		const out: ConversationCitationStatus = {
			spaceId,
			conversationId,
			calls,
			byChunkId: Object.fromEntries(statuses.map((x) => [x.chunkId, x])),
			stale: statuses.filter((x) => x.status !== "valid").length,
		};
		return c.json(out);
	});
	api.get("/kb/files/:fileId/status", (c) => {
		const p = principalOf(c);
		return c.json(s().fileStatus(p, c.req.param("fileId")));
	});
	api.get("/kb", (c) => {
		const p = principalOf(c);
		return c.json({ kbs: s().listKbs(p, { projectId: c.req.query("projectId") || undefined, scope: (c.req.query("scope") || undefined) as KbScope | undefined }) });
	});
	api.post("/kb", async (c) => {
		const p = principalOf(c);
		return c.json({ kb: s().createKb(p, await jsonBody<CreateKbRequest>(c)) });
	});
	api.get("/kb/:id", (c) => {
		const p = principalOf(c);
		return c.json({ kb: s().kbSummary(p, s().requireKb(p, "read", c.req.param("id"))) });
	});
	api.patch("/kb/:id", async (c) => {
		const p = principalOf(c);
		return c.json({ kb: s().updateKb(p, c.req.param("id"), await jsonBody<{ name?: string; description?: string }>(c)) });
	});
	api.delete("/kb/:id", (c) => {
		const p = principalOf(c);
		s().deleteKb(p, c.req.param("id"));
		return c.json({ ok: true });
	});
	api.put("/kb/:id/maintainers", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ userId?: string; email?: string; maintainer: boolean }>(c);
		return c.json({ kb: s().setMaintainer(p, c.req.param("id"), b, b.maintainer !== false) });
	});

	// ----- documents -----
	api.get("/kb/:id/docs", (c) => {
		const p = principalOf(c);
		return c.json({ docs: s().listDocs(p, c.req.param("id")) });
	});
	api.post("/kb/:id/docs", async (c) => {
		const p = principalOf(c);
		return c.json({ doc: await s().addDoc(p, c.req.param("id"), await jsonBody<AddKbDocRequest>(c)) });
	});
	api.get("/kb/:id/docs/:docId", (c) => {
		const p = principalOf(c);
		return c.json(s().getDoc(p, c.req.param("id"), c.req.param("docId")));
	});
	api.post("/kb/:id/docs/:docId/retry", (c) => {
		const p = principalOf(c);
		return c.json({ doc: s().retry(p, c.req.param("id"), c.req.param("docId")) });
	});
	api.patch("/kb/:id/docs/:docId/governance", async (c) => {
		const p = principalOf(c);
		return c.json({ doc: s().updateGovernance(p, c.req.param("id"), c.req.param("docId"), await jsonBody<UpdateGovernanceRequest>(c)) });
	});
	api.delete("/kb/:id/docs/:docId", (c) => {
		const p = principalOf(c);
		s().deleteDoc(p, c.req.param("id"), c.req.param("docId"));
		return c.json({ ok: true });
	});

	// ----- memory (round 14: Markdown files, one service shared with the agent's /memory backend) -----
	const m = () => k().memory;
	const asHttp = (e: unknown): never => {
		if (e instanceof VfsError) throw new HttpError(e.status, e.code === "etag_mismatch" ? "memory_conflict" : e.code, e.message);
		throw e;
	};
	const scopeOf = (c: { req: { query(n: string): string | undefined } }) => parseScopeId(c.req.query("scope") ?? "personal");
	const pathOf = (c: { req: { query(n: string): string | undefined } }) => {
		const path = c.req.query("path");
		if (!path) throw new HttpError(400, "invalid", "需要 path");
		return path;
	};
	const ifMatch = (c: { req: { header(n: string): string | undefined } }) => {
		const h = c.req.header("if-match");
		return h === undefined ? undefined : h.replace(/^W\//, "").replace(/^"|"$/g, "");
	};
	const fileDto = (f: MemFile) => ({ path: f.path, name: f.name, size: f.size, mtime: f.mtime, etag: f.etag, markdown: f.markdown });
	api.get("/memory/scopes", (c) => c.json({ scopes: m().scopesOf(principalOf(c)) }));
	api.get("/memory/files", (c) => {
		const p = principalOf(c);
		try {
			return c.json({ scope: scopeId(scopeOf(c)), files: m().list(p, scopeOf(c)).map(fileDto) });
		} catch (e) {
			return asHttp(e);
		}
	});
	api.get("/memory/file", (c) => {
		const p = principalOf(c);
		try {
			const r = m().read(p, scopeOf(c), pathOf(c));
			c.header("ETag", `"${r.file.etag}"`);
			return c.json({ file: fileDto(r.file), content: r.content, writable: m().can(p, scopeOf(c)).write });
		} catch (e) {
			return asHttp(e);
		}
	});
	api.put("/memory/file", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ content?: string }>(c);
		if (typeof b.content !== "string") throw new HttpError(400, "invalid", "需要 content");
		try {
			const r = m().write(p, scopeOf(c), pathOf(c), b.content, { ifMatch: ifMatch(c), requireIfMatch: true });
			c.header("ETag", `"${r.file.etag}"`);
			return c.json({ file: fileDto(r.file), status: r.status });
		} catch (e) {
			return asHttp(e);
		}
	});
	api.delete("/memory/file", (c) => {
		const p = principalOf(c);
		try {
			return c.json({ ok: true, ...m().remove(p, scopeOf(c), pathOf(c), { ifMatch: ifMatch(c) }) });
		} catch (e) {
			return asHttp(e);
		}
	});
	api.post("/memory/topics", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ scope?: string; title?: string; content?: string }>(c);
		try {
			return c.json({ file: fileDto(m().createTopic(p, parseScopeId(b.scope ?? "personal"), String(b.title ?? ""), b.content).file) });
		} catch (e) {
			return asHttp(e);
		}
	});
	// The database memory model is retired: its routes no longer write a competing copy.
	const gone = () => {
		throw new HttpError(410, "memory_moved", "记忆已改为 Markdown 文件（MEMORY.md 与主题文件）：请使用“记忆”页面，或在对话中让 Agent 维护 /memory。旧的数据库记忆接口已停用。");
	};
	api.post("/memory", gone);
	api.patch("/memory/:id", gone);
	api.post("/memory/:id/correct", gone);
	api.delete("/memory/:id", gone);
	api.get("/memory/context", gone);
	api.get("/memory/:id", gone);
	api.get("/memory/:id/history", gone);
}

export const knowledgeModule: WorkroomModule = {
	name: "knowledge",
	migrations: KNOWLEDGE_MIGRATIONS,
	init(ctx) {
		const k = new Knowledge(ctx);
		instances.set(ctx, k);
		ctx.services.provide("knowledge", k.store);
		ctx.services.provide("knowledgeAdmin", k);
		// the tools module (earlier in the init order) provides the router: /memory is served by the Markdown memory service
		if (ctx.services.has("vfs" as never)) ((ctx.services as any).get("vfs") as { register(b: unknown): void }).register(new MemoryBackend(ctx, k.memory));
	},
	routes(api, ctx) {
		mountRoutes(api, ctx);
	},
	extensions(ctx) {
		const k = knowledgeOf(ctx);
		return [knowledgeExtension(ctx, k.store, k.memory)];
	},
	async start(ctx) {
		const k = knowledgeOf(ctx);
		const identity = ctx.services.get("identity") as unknown as { registerResolver?: (kind: ResourceRef["kind"], r: (p: Principal, action: string, res: ResourceRef) => Promise<any>) => void };
		identity.registerResolver?.("kb", async (p, action, res) => k.store.access.decision(p, action, k.store.kbRow(res.id)));
		pruneRetrievalEvents(ctx.db);
		migrateMemoryToMarkdown(ctx, k.memory);
		k.pipeline.start();
	},
	async stop(ctx) {
		await knowledgeOf(ctx).pipeline.stop();
	},
};
