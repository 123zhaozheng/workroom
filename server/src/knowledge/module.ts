// Knowledge & memory module (group C). Auto-loaded by server/src/modules.ts.
// Services: "knowledge" (core KnowledgeService contract), "knowledgeAdmin" (full Knowledge facade, incl. file hooks for D).
import type { Hono } from "hono";
import type { AppContext, AppEnv, FileVersionRef, Principal, ResourceRef, WorkroomModule } from "../core/contracts.ts";
import { HttpError, jsonBody, principalOf } from "../core/http.ts";
import type {
	AddKbDocRequest,
	CorrectMemoryRequest,
	CreateKbRequest,
	CreateMemoryRequest,
	KbCapabilities,
	KbEvalSample,
	KbScope,
	KbSearchRequest,
	MemoryScope,
	RetrievalEventDTO,
	UpdateGovernanceRequest,
	UpdateMemoryRequest,
} from "../../../shared/knowledge.ts";
import { KNOWLEDGE_MIGRATIONS } from "./schema.ts";
import { KnowledgeStore } from "./service.ts";
import { IngestPipeline } from "./pipeline.ts";
import { MemoryStore } from "./memory.ts";
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
	readonly memory: MemoryStore;
	readonly pipeline: IngestPipeline;
	embeddings: EmbeddingProvider | null = null;
	constructor(ctx: AppContext) {
		this.ctx = ctx;
		this.store = new KnowledgeStore(ctx);
		this.memory = new MemoryStore(ctx, this.store.access);
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
		const b = await jsonBody<{ samples: KbEvalSample[]; kbIds?: string[] }>(c);
		if (!Array.isArray(b.samples) || b.samples.length > 200) throw new HttpError(400, "invalid", "samples 必须是数组（最多 200 条）");
		return c.json(await runEval(s(), p, b.samples, { kbIds: b.kbIds, requestId: c.get("requestId") }));
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
		const ids = Array.isArray(b.chunkIds) ? b.chunkIds.slice(0, 200) : [];
		return c.json({ statuses: ids.map((id) => s().citationStatus(p, id)) });
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

	// ----- memory -----
	const m = () => k().memory;
	api.get("/memory/context", async (c) => {
		const p = principalOf(c);
		const spaceId = c.req.query("spaceId");
		if (!spaceId) throw new HttpError(400, "invalid", "需要 spaceId");
		await ctx.services.get("acl").require(p, "read", { kind: "space", id: spaceId });
		const space = ctx.services.get("identity").space(spaceId)!;
		return c.json(m().contextDTO(p, space));
	});
	api.get("/memory", (c) => {
		const p = principalOf(c);
		return c.json({
			memories: m().list(p, { scope: (c.req.query("scope") || undefined) as MemoryScope | undefined, projectId: c.req.query("projectId") || undefined, includeSuperseded: c.req.query("includeSuperseded") === "1" }),
		});
	});
	api.post("/memory", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<CreateMemoryRequest>(c);
		return c.json({ memory: m().create(p, { content: b.content, scope: b.scope, projectId: b.projectId, kind: b.kind }) });
	});
	api.get("/memory/:id", (c) => {
		const p = principalOf(c);
		return c.json({ memory: m().get(p, c.req.param("id")) });
	});
	api.get("/memory/:id/history", (c) => {
		const p = principalOf(c);
		return c.json({ revisions: m().history(p, c.req.param("id")) });
	});
	api.patch("/memory/:id", async (c) => {
		const p = principalOf(c);
		return c.json({ memory: m().update(p, c.req.param("id"), await jsonBody<UpdateMemoryRequest>(c)) });
	});
	api.post("/memory/:id/correct", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<CorrectMemoryRequest>(c);
		return c.json(m().correct(p, c.req.param("id"), b));
	});
	api.delete("/memory/:id", (c) => {
		const p = principalOf(c);
		m().delete(p, c.req.param("id"));
		return c.json({ ok: true });
	});
}

export const knowledgeModule: WorkroomModule = {
	name: "knowledge",
	migrations: KNOWLEDGE_MIGRATIONS,
	init(ctx) {
		const k = new Knowledge(ctx);
		instances.set(ctx, k);
		ctx.services.provide("knowledge", k.store);
		ctx.services.provide("knowledgeAdmin", k);
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
		k.pipeline.start();
	},
	async stop(ctx) {
		await knowledgeOf(ctx).pipeline.stop();
	},
};
