// HTTP API of the sandbox: driver status/settings (admin), workspace file API (tree, preview, download, upload, mkdir, delete, move,
// publish), run records. ACL = the space's ACL (viewer: read-only; non-members: 403); publishing/uploading/deleting need space write.
import type { Hono } from "hono";
import { resolve } from "node:path";
import type { AppContext, AppEnv, Principal } from "../core/contracts.ts";
import { HttpError, jsonBody, principalOf } from "../core/http.ts";
import { contentDisposition } from "../files/module.ts";
import { effectiveMime } from "../files/mime.ts";
import type { Files } from "../files/service.ts";
import type { SandboxRunsResponse } from "../../../shared/files.ts";
import type { SandboxDriverAdminDTO, SandboxDriverStatusDTO, SandboxDriverUpdate, WorkspaceFilesResponse } from "../../../shared/sandbox.ts";
import type { BrowserService } from "./browser.ts";
import { DEFAULT_LIMITS, type Sandbox } from "./sandbox.ts";
import { requirePermission } from "./sandbox/perm.ts";
import { isInlineImage } from "./sandbox/workspace.ts";
import { noneDriver } from "./sandbox/none.ts";
import { dockerNetworkChoice } from "./sandbox/docker.ts";
import { networkText } from "./sandbox/network.ts";
import type { DriverStatus, SandboxDriver } from "./sandbox/driver.ts";

/** Read a request body with a hard cap (works for chunked uploads without Content-Length). */
async function readCapped(req: Request, cap: number): Promise<Uint8Array> {
	const len = Number(req.headers.get("content-length") ?? 0);
	if (len > cap) throw new HttpError(413, "too_large", `文件不能超过 ${Math.round(cap / 1048576)} MB`);
	const reader = req.body?.getReader();
	if (!reader) return new Uint8Array(0);
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > cap) {
			await reader.cancel().catch(() => {});
			throw new HttpError(413, "too_large", `文件不能超过 ${Math.round(cap / 1048576)} MB`);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(size);
	let off = 0;
	for (const c of chunks) (out.set(c, off), (off += c.length));
	return out;
}

export function registerSandboxRoutes(api: Hono<AppEnv>, ctx: AppContext): void {
	const sb = ctx.services.get("sandbox") as Sandbox;
	const acl = ctx.services.get("acl");
	const authz = () => (ctx.services.has("authz") ? ctx.services.get("authz") : undefined);

	// Driver settings: the catalog permission `sandbox.policy.manage` (owner/admin hold it by default; roles can grant or deny it). Only when the
	// authz service is absent (unit harnesses) does it fall back to the org role.
	const canManage = async (p: Principal): Promise<boolean> => {
		const a = authz();
		if (!a) return p.orgRole === "owner" || p.orgRole === "admin";
		try {
			return await a.has(p, "sandbox.policy.manage");
		} catch {
			return false;
		}
	};
	const requireManage = async (p: Principal) => {
		if (!(await canManage(p))) throw new HttpError(403, "forbidden", "只有组织管理员（或拥有“管理沙箱与工具策略”权限的成员）可以修改沙箱驱动设置");
	};

	// ---------- driver status / settings (host-wide: one sandbox per server) ----------
	const statusDTO = (d: SandboxDriver, st: DriverStatus, manage: boolean): SandboxDriverStatusDTO => ({
		id: d.id as SandboxDriverStatusDTO["id"],
		label: d.label,
		state: st.state,
		summary: st.summary,
		details: manage ? st.details : [],
		howToEnable: st.howToEnable,
		checkedAt: st.checkedAt,
		capabilities: d.capabilities,
		isolates: d.notes.isolates,
		doesNotIsolate: d.notes.doesNotIsolate,
	});
	async function driverDTO(p: Principal, force = false, extraDeprecations: readonly string[] = []): Promise<SandboxDriverAdminDTO> {
		const r = await sb.drivers.resolve(force);
		const manage = await canManage(p);
		const s = sb.drivers.settings();
		const none = noneDriver(() => "沙箱已关闭或没有可用的驱动");
		const prep = sb.drivers.docker.prepareProgress();
		const settingNone: DriverStatus = { id: "none", state: "ready", summary: "关闭沙箱（所有代码执行、终端、沙箱内技能/MCP 都不可用）", details: [], checkedAt: new Date().toISOString() };
		return {
			setting: s.driver,
			effective: r.effective,
			reason: r.reason,
			// Round 9: no Workroom network policy. `network` is a read-only mirror of the active driver's capability (deprecated).
			network: r.effective !== "none" && r.driver.capabilities.network ? "allowed" : "none",
			networkText: networkText(r.driver),
			...(manage ? { dockerNetwork: dockerNetworkChoice(), deprecations: [...sb.drivers.legacyNotes(), ...extraDeprecations] } : {}),
			docker: { image: s.docker.image, pythonImage: s.docker.pythonImage, nodeImage: s.docker.nodeImage, cpus: s.docker.cpus, autoPull: s.docker.autoPull, ...(manage ? { bin: s.docker.bin, host: s.docker.host } : {}) },
			drivers: [statusDTO(sb.drivers.namespaces, r.statuses.namespaces, manage), statusDTO(sb.drivers.docker, r.statuses.docker, manage), statusDTO(none, settingNone, manage)],
			prepare: prep ? { mode: prep.mode, state: prep.state, startedAt: prep.startedAt, finishedAt: prep.finishedAt, log: manage ? prep.log.slice(-40) : [] } : undefined,
			maxConcurrent: s.maxConcurrent,
			services: manage ? sb.listServices().map((x) => ({ key: x.key, id: x.id, runtime: x.runtime, startedAt: x.startedAt, lastActivityAt: x.lastActivityAt, driver: x.driver as SandboxDriverStatusDTO["id"], running: x.running })) : [],
			canManage: manage,
			fromEnvironment: sb.drivers.fromEnvironment(),
		};
	}
	api.get("/sandbox/driver", async (c) => c.json(await driverDTO(principalOf(c))));
	api.put("/sandbox/driver", async (c) => {
		const p = principalOf(c);
		await requireManage(p);
		const patch = await jsonBody<SandboxDriverUpdate>(c);
		sb.drivers.update(p, patch);
		sb.applySettings();
		// `network` (round 8 and earlier) is accepted and ignored: Workroom has no sandbox network policy any more.
		return c.json(await driverDTO(p, true, patch.network !== undefined ? ["请求里的 network 字段已停用，被忽略：沙箱网络不再由 Workroom 控制（本机 Docker 由部署配置 WORKROOM_DOCKER_NETWORK 决定，第三方沙箱遵循提供方）"] : []));
	});
	api.post("/sandbox/driver/detect", async (c) => {
		const p = principalOf(c);
		await requireManage(p);
		return c.json(await driverDTO(p, true));
	});
	api.post("/sandbox/driver/prepare", async (c) => {
		const p = principalOf(c);
		await requireManage(p);
		const b = await jsonBody<{ mode?: "pull" | "build" }>(c).catch(() => ({}) as { mode?: "pull" | "build" });
		const mode = b.mode === "build" ? "build" : "pull";
		if (!sb.drivers.docker.facts() && (await sb.drivers.docker.detect(true)).state === "unavailable") throw new HttpError(409, "docker_unavailable", "Docker 不可用，无法准备镜像。请先安装并启动 Docker。");
		void sb.drivers.docker.prepare(mode, resolve(import.meta.dirname, "../../sandbox"));
		return c.json(await driverDTO(p));
	});

	// ---------- workspace ----------
	const spaceFor = async (c: any, action: "read" | "write") => {
		const p = principalOf(c);
		const space = ctx.services.get("identity").space(c.req.param("spaceId"));
		if (!space) throw new HttpError(404, "space_not_found", "空间不存在");
		await acl.require(p, action, { kind: "space", id: space.id });
		if (action === "write") await requirePermission(ctx, p, "sandbox.use");
		const cid = c.req.query("conversationId");
		const conversationId = cid === undefined || cid === "" ? undefined : Number(cid);
		if (conversationId !== undefined && !Number.isInteger(conversationId)) throw new HttpError(400, "invalid", "conversationId 无效");
		return { p, space, conversationId };
	};

	api.get("/sandbox/:spaceId", async (c) => {
		const { space } = await spaceFor(c, "read");
		return c.json({ info: await sb.info(space), browser: (ctx.services.get("browser") as BrowserService).available() });
	});
	api.get("/sandbox/:spaceId/files", async (c) => {
		const { p, space, conversationId } = await spaceFor(c, "read");
		const out: WorkspaceFilesResponse = { ...sb.workspace(space, conversationId, p), canWrite: (await acl.check(p, "write", { kind: "space", id: space.id })).allow };
		return c.json(out);
	});
	api.get("/sandbox/:spaceId/preview", async (c) => {
		const { p, space, conversationId } = await spaceFor(c, "read");
		return c.json({ preview: sb.preview(space, conversationId, c.req.query("path") ?? "", p) });
	});
	api.get("/sandbox/:spaceId/file", async (c) => {
		const { p, space, conversationId } = await spaceFor(c, "read");
		const f = sb.readFile(space, conversationId, c.req.query("path") ?? "", p);
		// Raster/SVG images may be shown inline (an <img> in the work panel); everything else is a download. Never executable in our origin.
		const inline = c.req.query("inline") === "1" && isInlineImage(f.name);
		return new Response(f.bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": effectiveMime(undefined, f.name), "content-disposition": contentDisposition(inline ? "inline" : "attachment", f.name), "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'", "cache-control": "private, no-store" } });
	});
	api.put("/sandbox/:spaceId/file", async (c) => {
		const { p, space, conversationId } = await spaceFor(c, "write");
		const path = c.req.query("path") ?? "";
		const bytes = await readCapped(c.req.raw, DEFAULT_LIMITS.maxFileBytes);
		if (c.req.query("overwrite") === "0") {
			try {
				sb.preview(space, conversationId, path, p);
				throw new HttpError(409, "exists", "文件已存在");
			} catch (e) {
				if (e instanceof HttpError && e.status === 409) throw e;
			}
		}
		const rel = sb.writeFile(space, conversationId, path, bytes, p);
		return c.json({ path: rel, size: bytes.length });
	});
	api.post("/sandbox/:spaceId/mkdir", async (c) => {
		const { p, space } = await spaceFor(c, "write");
		const b = await jsonBody<{ conversationId?: number; path: string }>(c);
		return c.json({ path: sb.mkdir(space, b.conversationId, b.path, p) });
	});
	api.delete("/sandbox/:spaceId/file", async (c) => {
		const { p, space, conversationId } = await spaceFor(c, "write");
		return c.json(sb.remove(space, conversationId, c.req.query("path") ?? "", p));
	});
	api.post("/sandbox/:spaceId/move", async (c) => {
		const { p, space } = await spaceFor(c, "write");
		const b = await jsonBody<{ conversationId?: number; from: string; to: string }>(c);
		return c.json(sb.move(space, b.conversationId, b.from, b.to, p));
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
		const f = sb.readFile(space, b.conversationId, b.path, p);
		const name = b.name ?? f.name;
		const ref = await (ctx.services.get("files") as unknown as Files).putVersion(p, { fileId: b.fileId, name, mime: effectiveMime(undefined, name), bytes: f.bytes, provenance: { createdBy: p.userId, spaceId: space.id, conversationId: b.conversationId, changeNote: b.changeNote ?? `从沙箱 ${sb.shown(space, sb.relPath(space, b.path))} 发布`, origin: "upload", tool: "sandbox_publish" } as any });
		return c.json({ version: ref });
	});
}
