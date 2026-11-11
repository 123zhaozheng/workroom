// HTTP routes for credentials (mounted under /api). Session auth only. There is NO route that returns a plaintext secret.
//
// Secret-bearing bodies (fulfil, rotate): same-origin check, hard 16 KB cap, parsed here (never via a logging middleware), and no code path
// puts the body or any part of it into an error message, a log line or an audit row.
import type { Context as HonoContext } from "hono";
import type { Hono } from "hono";
import type { AppContext, AppEnv } from "../../core/contracts.ts";
import { HttpError, principalOf } from "../../core/http.ts";
import type { CredentialFulfillRequest } from "../../../../shared/workspace-safety.ts";
import { credentialsFor } from "./store.ts";

export const MAX_SECRET_BODY_BYTES = 16 * 1024;

/** Reject cross-site browser requests: when an Origin header is present it must be this server's own origin (or WORKROOM_PUBLIC_URL). */
function sameOrigin(c: HonoContext<AppEnv>): void {
	const origin = c.req.header("origin");
	if (!origin) return; // non-browser clients (Bearer token) send none; browsers always send it on cross-site POSTs
	let oh: string;
	try {
		oh = new URL(origin).host;
	} catch {
		throw new HttpError(403, "bad_origin", "跨站请求被拒绝");
	}
	const allowed = new Set([new URL(c.req.url).host, c.req.header("host") ?? ""]);
	try {
		if (process.env.WORKROOM_PUBLIC_URL) allowed.add(new URL(process.env.WORKROOM_PUBLIC_URL).host);
	} catch {
		/* ignore a malformed public url */
	}
	if (!allowed.has(oh)) throw new HttpError(403, "bad_origin", "跨站请求被拒绝");
}

/** Read the JSON body with a hard size cap, without ever echoing it. */
async function secretBody<T>(c: HonoContext<AppEnv>): Promise<Partial<T>> {
	sameOrigin(c);
	const declared = Number(c.req.header("content-length") ?? "0");
	if (declared > MAX_SECRET_BODY_BYTES) throw new HttpError(413, "body_too_large", "请求体过大");
	const reader = c.req.raw.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (reader) {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > MAX_SECRET_BODY_BYTES) {
				await reader.cancel().catch(() => {});
				throw new HttpError(413, "body_too_large", "请求体过大");
			}
			chunks.push(value);
		}
	}
	try {
		const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("shape");
		return v as Partial<T>;
	} catch {
		throw new HttpError(400, "bad_json", "请求体不是有效 JSON");
	}
}

export function registerCredentialRoutes(api: Hono<AppEnv>, ctx: AppContext): void {
	const svc = () => credentialsFor(ctx);

	api.get("/credentials/status", (c) => {
		principalOf(c);
		const s = svc().secretStore;
		return c.json({ store: { id: s.id, available: s.available, ...(s.available ? {} : { reason: s.reason }) } });
	});

	// ---------------------------------------------------------------- requests (the form)
	api.get("/credential-requests", (c) => {
		const p = principalOf(c);
		return c.json({ requests: svc().listRequests(p, c.req.query("status")).map((r) => svc().requestDto(r)) });
	});

	/** The form's data AND its single-use nonce (requester only, only while pending). The nonce never goes through the model. */
	api.get("/credential-requests/:id", async (c) => {
		const p = principalOf(c);
		const s = svc();
		const r = s.requestFor(p, c.req.param("id"));
		const nonce = await s.issueNonce(p, r.id);
		c.header("cache-control", "no-store");
		return c.json({ request: s.requestDto(s.request(r.id)!), ...(nonce ? { nonce } : {}), store: { id: s.secretStore.id, available: s.secretStore.available, ...(s.secretStore.available ? {} : { reason: s.secretStore.reason }) } });
	});

	api.post("/credential-requests/:id/fulfill", async (c) => {
		const p = principalOf(c);
		const body = await secretBody<CredentialFulfillRequest>(c);
		const out = await svc().fulfil(p, c.req.param("id"), body);
		c.header("cache-control", "no-store");
		return c.json({ request: out.request, credential: out.credential, idempotent: out.idempotent });
	});
	api.post("/credential-requests/:id/decline", async (c) => {
		const p = principalOf(c);
		sameOrigin(c);
		return c.json({ request: await svc().close(p, c.req.param("id"), "declined") });
	});
	api.post("/credential-requests/:id/cancel", async (c) => {
		const p = principalOf(c);
		sameOrigin(c);
		return c.json({ request: await svc().close(p, c.req.param("id"), "cancelled") });
	});

	// ---------------------------------------------------------------- credentials (metadata only)
	api.get("/credentials", async (c) => c.json({ credentials: await svc().list(principalOf(c)) }));
	api.get("/credentials/:id", async (c) => c.json({ credential: await svc().metadata(principalOf(c), c.req.param("id")) }));
	api.post("/credentials/:id/revoke", async (c) => {
		const p = principalOf(c);
		sameOrigin(c);
		return c.json({ credential: await svc().revoke(p, c.req.param("id")) });
	});
	/** Rotation: the owner submits the new value directly (authenticated body, same caps as fulfil). */
	api.post("/credentials/:id/rotate", async (c) => {
		const p = principalOf(c);
		const body = await secretBody<{ secret: string }>(c);
		c.header("cache-control", "no-store");
		return c.json({ credential: await svc().rotate(p, c.req.param("id"), body.secret) });
	});
	api.delete("/credentials/:id", async (c) => {
		const p = principalOf(c);
		sameOrigin(c);
		await svc().remove(p, c.req.param("id"));
		return c.json({ ok: true });
	});
}
