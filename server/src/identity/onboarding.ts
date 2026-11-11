// First-login onboarding flag (round 9). Per user, server-side, so a finished onboarding is not shown again on any device.
//
//   GET  /me                          → { me: { …existing, onboarded: boolean }, … }   (also on the login / register responses)
//   POST /me/onboarding/complete { skipped?: string[] } → { onboarded: true }          (idempotent; the first call wins)
//
// Kept out of identity/module.ts and routes.ts on purpose: the column lives in its own migration namespace ("identity-onboarding")
// and `onboarded` is added to the existing responses by a small wrapper, so the identity files only gain one registration line.
//
// Users that existed before this round have no `onboarded_at`, so they see the (skippable) onboarding once. Operators who do not
// want it at all (SSO-only rollouts, scripted browsers) set WORKROOM_ONBOARDING=off: every user then reads as onboarded.
import type { Hono } from "hono";
import type { AppContext, AppEnv } from "../core/contracts.ts";
import { HttpError, jsonBody, nowIso, principalOf } from "../core/http.ts";
import type { AuditService } from "./module.ts";

const MIGRATIONS = [{ version: 1, name: "id_users.onboarded_at", sql: "ALTER TABLE id_users ADD COLUMN onboarded_at TEXT;" }];

/** Step ids the client may report as skipped (free text is never stored). */
const STEP_IDS = new Set(["welcome", "appearance", "security", "model", "done"]);

export function onboardingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return /^(off|0|false|no)$/i.test(env.WORKROOM_ONBOARDING ?? "");
}

export function isOnboarded(ctx: AppContext, userId: string): boolean {
	if (onboardingDisabled()) return true;
	return !!ctx.db.get<{ onboarded_at: string | null }>("SELECT onboarded_at FROM id_users WHERE id = ?", userId)?.onboarded_at;
}

/** Patch `onboarded` into any successful JSON response that carries `{ me: { userId } }` (GET /me, login, register, OIDC). */
async function withOnboarded(ctx: AppContext, res: Response): Promise<Response> {
	if (res.status !== 200 || !(res.headers.get("content-type") ?? "").includes("application/json")) return res;
	let body: any;
	try {
		body = await res.clone().json();
	} catch {
		return res;
	}
	const userId = body?.me?.userId;
	if (typeof userId !== "string") return res;
	body.me.onboarded = isOnboarded(ctx, userId);
	const headers = new Headers(res.headers);
	headers.delete("content-length");
	return new Response(JSON.stringify(body), { status: res.status, headers });
}

export function registerOnboarding(api: Hono<AppEnv>, ctx: AppContext): void {
	ctx.db.migrate("identity-onboarding", MIGRATIONS);

	api.use("*", async (c, next) => {
		await next();
		const m = c.req.method;
		const path = c.req.path.replace(/^\/api(?=\/)/, "");
		if ((m === "GET" && path === "/me") || (m === "POST" && (path === "/auth/login" || path === "/auth/register" || path === "/auth/switch-org"))) c.res = await withOnboarded(ctx, c.res);
	});

	api.post("/me/onboarding/complete", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ skipped?: unknown }>(c).catch(() => ({}) as { skipped?: unknown });
		if (b.skipped !== undefined && (!Array.isArray(b.skipped) || b.skipped.length > 10 || b.skipped.some((x) => typeof x !== "string"))) throw new HttpError(400, "invalid", "skipped 必须是步骤编号数组");
		const skipped = [...new Set((b.skipped as string[] | undefined) ?? [])].filter((s) => STEP_IDS.has(s));
		// First call wins: the timestamp is never rewritten, so a repeated call (second tab, retry) changes nothing and is not audited again.
		const r = ctx.db.run("UPDATE id_users SET onboarded_at = ? WHERE id = ? AND onboarded_at IS NULL", nowIso(), p.userId);
		if (r.changes === 1) (ctx.services.get("audit") as AuditService).record({ orgId: p.orgId, actorUserId: p.userId, action: "user.onboarding_complete", target: p.userId, detail: { skipped }, category: "auth", requestId: c.get("requestId") });
		return c.json({ onboarded: true });
	});
}
