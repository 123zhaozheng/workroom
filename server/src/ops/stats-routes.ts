// Analytics routes (round 4): GET /stats/scopes, GET /stats/overview, GET /stats/export.csv.
// /stats, /usage and /usage/export.csv (E) are unchanged; these are additive.
import type { Context as HonoContext, Hono } from "hono";
import type { AppContext, AppEnv } from "../core/contracts.ts";
import { HttpError, principalOf } from "../core/http.ts";
import { audit } from "../identity/module.ts";
import { toCsv } from "../identity/csv.ts";
import type { OpsState } from "./module.ts";
import { StatsService, scopeKey, type StatsQuery } from "./stats.ts";
import type { StatsScope } from "./usage.ts";

function parseScope(q: string | undefined): StatsScope {
	if (!q || q === "personal") return { kind: "personal" };
	if (q === "org") return { kind: "org" };
	if (q.startsWith("project:")) return { kind: "project", projectId: q.slice(8) };
	if (q.startsWith("department:")) return { kind: "department", departmentId: q.slice(11) };
	throw new HttpError(400, "invalid_scope", "scope 取值：personal | org | project:<id> | department:<id>");
}

const stats = new WeakMap<AppContext, StatsService>();
export function statsService(ctx: AppContext, s: OpsState): StatsService {
	let v = stats.get(ctx);
	if (!v) stats.set(ctx, (v = new StatsService(ctx, s.usage)));
	return v;
}

export function registerStatsRoutes(api: Hono<AppEnv>, ctx: AppContext, s: OpsState): void {
	const svc = statsService(ctx, s);
	ctx.services.provide("stats", svc);
	const query = (c: HonoContext<AppEnv>): StatsQuery => {
		const lc = Number(c.req.query("largeContextTokens"));
		const tz = c.req.query("tz");
		return { from: c.req.query("from"), to: c.req.query("to"), granularity: c.req.query("granularity"), tz: tz === undefined || tz === "" ? 0 : Number(tz), ...(lc > 0 ? { largeContextTokens: lc } : {}) };
	};
	api.get("/stats/scopes", async (c) => c.json(await svc.scopes(principalOf(c))));
	api.get("/stats/overview", async (c) => c.json(await svc.overview(principalOf(c), parseScope(c.req.query("scope")), query(c))));
	api.get("/stats/export.csv", async (c) => {
		const p = principalOf(c);
		const scope = parseScope(c.req.query("scope"));
		const chart = c.req.query("chart") ?? "";
		const metric = c.req.query("metric") === "tokens" ? "tokens" : "requests";
		const out = await svc.exportRows(p, scope, query(c), chart, metric);
		audit(ctx.db, p.orgId, p.userId, "stats.export", scopeKey(scope), { chart, rows: out.rows.length, demo: out.overview.demo }, { requestId: c.get("requestId"), category: "admin" });
		c.header("content-type", "text/csv; charset=utf-8");
		c.header("content-disposition", `attachment; filename="stats-${out.name}-${scopeKey(scope).replace(/[^a-z0-9_-]/gi, "_")}.csv"`);
		const demo = out.overview.demo ? "﻿" : "﻿";
		return c.body(demo + toCsv(out.columns, out.rows));
	});
}
