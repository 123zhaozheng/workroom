// Round 11 (R4): HTTP API of local (in-browser) execution. All under /api.
//   GET  /sandbox/local-exec                                              → { enabled, canManage }      (any member; org switch)
//   PUT  /sandbox/local-exec            { enabled }                       → same                         (sandbox.policy.manage)
//   GET  /conversations/:spaceId/:conversationId/local-exec               → LocalExecStatusDTO           (space read)
//   PUT  /conversations/:spaceId/:conversationId/local-exec { preference } → LocalExecStatusDTO          (space write)
//   POST /conversations/:spaceId/:conversationId/local-exec/jobs/:jobId/claim   { tabId }  → LocalJobClaimResponse (run's user only; first wins)
//   GET  /conversations/:spaceId/:conversationId/local-exec/jobs/:jobId/input?path=&tabId= → bytes of a declared input
//   POST /conversations/:spaceId/:conversationId/local-exec/jobs/:jobId/result  LocalJobResultRequest
// Jobs are announced as SSE events on the conversation stream (see runtime/routes.ts); presence = the stream opened with ?local=<tabId>.
import type { Hono } from "hono";
import type { AppContext, AppEnv, Principal, Space } from "../../core/contracts.ts";
import { HttpError, jsonBody, principalOf } from "../../core/http.ts";
import type { LocalJobResultRequest } from "../../../../shared/localexec.ts";
import { requirePermission } from "../sandbox/perm.ts";
import type { LocalExec } from "./service.ts";

const MAX_RESULT_BYTES = 40 * 1024 * 1024;
const TAB_ID = /^[A-Za-z0-9_-]{8,64}$/;

async function readCappedText(req: Request, cap: number): Promise<string> {
	const len = Number(req.headers.get("content-length") ?? 0);
	if (len > cap) throw new HttpError(413, "too_large", "结果过大");
	const reader = req.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > cap) {
			await reader.cancel().catch(() => {});
			throw new HttpError(413, "too_large", "结果过大");
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export function registerLocalExecRoutes(api: Hono<AppEnv>, ctx: AppContext): void {
	const svc = () => ctx.services.get("localExec") as LocalExec;
	const authz = () => (ctx.services.has("authz") ? ctx.services.get("authz") : undefined);
	const canManage = async (p: Principal): Promise<boolean> => {
		const a = authz();
		if (!a) return p.orgRole === "owner" || p.orgRole === "admin";
		try {
			return await a.has(p, "sandbox.policy.manage");
		} catch {
			return false;
		}
	};

	api.get("/sandbox/local-exec", async (c) => {
		const p = principalOf(c);
		return c.json({ enabled: svc().enabled(p.orgId), canManage: await canManage(p), languages: svc().browserLanguages });
	});
	api.put("/sandbox/local-exec", async (c) => {
		const p = principalOf(c);
		if (!(await canManage(p))) throw new HttpError(403, "forbidden", "只有组织管理员（或拥有“管理沙箱与工具策略”权限的成员）可以修改本地执行设置");
		const b = await jsonBody<{ enabled?: unknown }>(c);
		if (typeof b.enabled !== "boolean") throw new HttpError(400, "invalid", "enabled 必须是布尔值");
		return c.json({ enabled: svc().setEnabled(p, b.enabled), canManage: true, languages: svc().browserLanguages });
	});

	const base = "/conversations/:spaceId/:conversationId/local-exec";
	const spaceOf = (p: Principal, spaceId: string): Space => {
		const s = ctx.services.get("identity").space(spaceId);
		if (!s || s.orgId !== p.orgId) throw new HttpError(404, "space_not_found", "空间不存在");
		return s;
	};
	const convOf = (raw: string): number => {
		const n = Number(raw);
		if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "invalid", "会话 id 无效");
		return n;
	};
	const scope = async (c: any, action: "read" | "write") => {
		const p = principalOf(c);
		const space = spaceOf(p, c.req.param("spaceId"));
		await ctx.services.get("acl").require(p, action, { kind: "space", id: space.id });
		return { p, space, conversationId: convOf(c.req.param("conversationId")) };
	};

	api.get(base, async (c) => {
		const { p, space, conversationId } = await scope(c, "read");
		return c.json(svc().status(p, space.id, conversationId));
	});
	api.put(base, async (c) => {
		const { p, space, conversationId } = await scope(c, "write");
		const b = await jsonBody<{ preference?: unknown }>(c);
		svc().setPreference(p, space.id, conversationId, b.preference as "local" | "cloud");
		return c.json(svc().status(p, space.id, conversationId));
	});

	// Job calls: the caller must be the run's own user with write access to the space (and sandbox.use); the broker re-checks user, space, conversation and tab.
	const jobScope = async (c: any) => {
		const s = await scope(c, "write");
		await requirePermission(ctx, s.p, "sandbox.use");
		return { ...s, where: { spaceId: s.space.id, conversationId: s.conversationId } };
	};
	api.post(`${base}/jobs/:jobId/claim`, async (c) => {
		const { p, where } = await jobScope(c);
		const b = await jsonBody<{ tabId?: string }>(c);
		if (typeof b.tabId !== "string" || !TAB_ID.test(b.tabId)) throw new HttpError(400, "invalid", "tabId 无效");
		return c.json(svc().broker.claim(c.req.param("jobId"), p.userId, b.tabId, where));
	});
	api.get(`${base}/jobs/:jobId/input`, async (c) => {
		const { p, where } = await jobScope(c);
		const tabId = c.req.query("tabId") ?? "";
		if (!TAB_ID.test(tabId)) throw new HttpError(400, "invalid", "tabId 无效");
		const bytes = svc().broker.input(c.req.param("jobId"), p.userId, tabId, where, c.req.query("path") ?? "");
		return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": "application/octet-stream", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
	});
	api.post(`${base}/jobs/:jobId/result`, async (c) => {
		const { p, where } = await jobScope(c);
		let body: LocalJobResultRequest;
		try {
			body = JSON.parse(await readCappedText(c.req.raw, MAX_RESULT_BYTES)) as LocalJobResultRequest;
		} catch (e) {
			if (e instanceof HttpError) throw e;
			throw new HttpError(400, "bad_json", "请求体不是有效 JSON");
		}
		if (!body || typeof body.tabId !== "string" || typeof body.ok !== "boolean") throw new HttpError(400, "invalid", "结果格式无效");
		return c.json(svc().broker.complete(c.req.param("jobId"), p.userId, where, body));
	});
}
