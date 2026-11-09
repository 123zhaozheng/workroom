// Route permission policy: a single, auditable table mapping admin HTTP routes (of any module) to the permission they need.
// Enforced by one middleware registered ahead of every module's routes, so ops/models/stats handlers keep their existing
// `requireOrgAdmin(...)` call (which is satisfied for the duration of a request the policy already authorised) without each
// file hard-coding roles. Routes not in the table are NOT gated here (their handlers decide); the identity routes check
// their own, finer-grained permissions (department scope etc.) directly.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Hono } from "hono";
import type { AppContext, AppEnv } from "../core/contracts.ts";
import { HttpError } from "../core/http.ts";
import type { Identity } from "./module.ts";

interface Policy {
	readonly methods: readonly string[] | "*";
	/** Path relative to /api, `:param` segments match one path segment, trailing `/*` matches any suffix. */
	readonly path: string;
	readonly permission: string;
}

const READ = ["GET", "HEAD"];
const WRITE = ["POST", "PUT", "PATCH", "DELETE"];

/** Built-in policy for the ops module's admin routes (models/channels, usage maintenance, budgets, trace). */
const POLICIES: Policy[] = [
	{ methods: "*", path: "/admin/models", permission: "model.manage" },
	{ methods: "*", path: "/admin/models/:id", permission: "model.manage" },
	{ methods: "*", path: "/admin/models/:id/*", permission: "model.manage" },
	{ methods: "*", path: "/admin/routes/:id", permission: "model.manage" },
	{ methods: "*", path: "/admin/route-attempts", permission: "model.manage" },
	{ methods: "*", path: "/admin/channels", permission: "model.provider.manage" },
	{ methods: "*", path: "/admin/channels/:id", permission: "model.provider.manage" },
	{ methods: "*", path: "/admin/channels/:id/*", permission: "model.provider.manage" },
	{ methods: "*", path: "/admin/settings/savings", permission: "budget.manage" },
	{ methods: "*", path: "/admin/settings/webhook-allowlist", permission: "org.security.manage" },
	{ methods: ["POST"], path: "/admin/usage/import", permission: "billing.view" },
	{ methods: READ, path: "/admin/usage/reconcile", permission: "billing.view" },
	{ methods: ["POST"], path: "/admin/usage/rebuild", permission: "org.settings.manage" },
	{ methods: WRITE, path: "/admin/budgets", permission: "budget.manage" },
	{ methods: WRITE, path: "/admin/budgets/:id", permission: "budget.manage" },
	{ methods: "*", path: "/admin/trace", permission: "trace.view" },
];

const store = new AsyncLocalStorage<{ permission: string }>();

/** True while handling a request whose route policy was already authorised by the middleware. */
export function policyAuthorized(): boolean {
	return store.getStore() !== undefined;
}

const compiled = new Map<Policy, RegExp>();
function matcher(p: Policy): RegExp {
	let r = compiled.get(p);
	if (!r) {
		const src = p.path
			.split("/")
			.map((seg) => (seg === "*" ? ".*" : seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
			.join("/");
		r = new RegExp(`^${src}/?$`);
		compiled.set(p, r);
	}
	return r;
}

/** Other modules may add their own admin route policies (e.g. marketplace review routes → "skill.review"). */
export function registerRoutePolicy(policy: Policy): void {
	POLICIES.push(policy);
}

export function registerPolicyMiddleware(api: Hono<AppEnv>, ctx: AppContext, id: Identity): void {
	void ctx;
	api.use("*", async (c, next) => {
		const path = c.req.path.replace(/^\/api(?=\/)/, "");
		const method = c.req.method.toUpperCase();
		const hit = POLICIES.find((p) => (p.methods === "*" || p.methods.includes(method)) && matcher(p).test(path));
		if (!hit) return next();
		const p = c.get("principal");
		if (!p) throw new HttpError(401, "unauthenticated", "请先登录");
		await id.authz.require(p, hit.permission);
		return store.run({ permission: hit.permission }, next);
	});
}
