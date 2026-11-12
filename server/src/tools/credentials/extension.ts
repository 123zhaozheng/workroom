// Agent tools for credentials (pi-durable extension "wr.credentials"): credential_request, credential_http, credential_list.
// The model supplies WHAT it needs and WHERE it may be sent; the value is typed by the user into a server form and only the server ever sees it.
//
// Replay:
//   credential_request  "safe"   - idempotent by (space, conversation, callId); a replay reattaches to the same request row and waits again.
//   credential_http     "unsafe" - an external request may have been sent: after a crash it is NOT re-sent, the model gets an `interrupted`
//                                  result and must verify state (pass an Idempotency-Key header yourself when the API supports it).
//   credential_list     "safe"   - metadata only.
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { arr, int, map, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { AppContext, ToolActor } from "../../core/contracts.ts";
import { HttpError } from "../../core/http.ts";
import { runtimeActorResolver, type ActorResolver } from "../../files/actor.ts";
import type { ToolCallLog } from "../calls.ts";
import { credentialHttp, type ProxyResult } from "./proxy.ts";
import { publishStatus, statusForModel, validateRequestArgs, waitForDecision } from "./requests.ts";
import { credentialsFor } from "./store.ts";

const text = (t: string) => [{ type: "text" as const, text: t }];

export function formatProxyResult(r: ProxyResult): string {
	const lines = [`HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ""}  (${r.host})`];
	for (const [k, v] of Object.entries(r.headers)) lines.push(`${k}: ${v}`);
	if (r.redirect) lines.push("", `未跟随重定向 → ${r.redirect.location}（主机 ${r.redirect.host}${r.redirect.sameHost ? "，与请求相同" : "，与请求不同"}）。如需继续，请再次调用 credential_http；每次调用都会重新校验主机，凭据只会发给其允许的主机。`);
	if (r.scrubbed) lines.push("", "注意：响应中出现了凭据的值，已替换为 [REDACTED]。");
	if (r.truncated) lines.push("", `注意：响应过长，已截断（共 ${r.bodyBytes} 字节）。`);
	lines.push("", r.body);
	return lines.join("\n");
}

export function createCredentialExtension(ctx: AppContext, opts: { resolveActor?: ActorResolver } = {}): Extension {
	const resolve = (api: ToolExecutionApi<any>, c: Context): Promise<ToolActor> => (opts.resolveActor ?? runtimeActorResolver(ctx))(api, c);
	const store = () => credentialsFor(ctx);
	const log = () => ctx.services.get("toolCalls") as ToolCallLog;

	const request = defineTool({
		name: "credential_request",
		description:
			"Ask the user for a secret (API key/token) for an external service. You never receive the value: the user types it into a form in the app, then you use it through credential_http. " +
			"Give the service, why you need it, and the exact hosts it may be sent to (api.github.com, or *.example.com for one subdomain level). Default: GET-only, Authorization: Bearer. " +
			'usage "env" (secret exposed to a sandbox command as an env var) is a last resort and needs extra user consent. ' +
			"Waits for the user; result is a status (fulfilled/declined/expired/cancelled) plus credentialId when fulfilled. If declined, do not ask again for the same thing.",
		parameters: obj({
			service: str({ description: "Service name shown to the user, e.g. GitHub" }),
			purpose: str({ description: "Why you need it and what you will do with it (shown to the user)" }),
			targetHosts: opt(arr(str(), { description: "Hosts the secret may be sent to. Required for usage proxy.", maxItems: 10 })),
			methods: opt(arr(oneOf(["GET", "POST", "PUT", "PATCH", "DELETE"]), { description: 'Default ["GET"]' })),
			inject: opt(obj({ header: str(), template: str({ description: "Must contain {secret} exactly once, e.g. Bearer {secret}" }) })),
			usage: opt(oneOf(["proxy", "env"])),
			envName: opt(str({ description: "Environment variable name (usage env only)" })),
			ttlSec: opt(int({ minimum: 60, maximum: 30 * 86400, description: "How long the user has to answer / a one-time credential stays valid (seconds). Default 3600." })),
		}),
		replay: "safe",
		async execute(args, api, c) {
			const actor = await resolve(api, c);
			return log().around({ tool: "credential_request", actor, args }, async () => {
				const svc = store();
				const p = actor.principal;
				if (p.via) throw new HttpError(403, "forbidden", "自动化运行没有人可以输入凭据，不能请求凭据");
				await ctx.services.get("acl").require(p, "write", { kind: "space", id: actor.space.id });
				const spec = validateRequestArgs(args as Record<string, unknown>, svc);
				const row = svc.createRequest(actor, spec); // 503 "未配置" when no secret store is configured: nothing is created
				await publishStatus(api, c, row);
				const final = await waitForDecision(svc, row.id, c.abortSignal);
				await publishStatus(api, c, final);
				const st = statusForModel(final);
				return { output: text(JSON.stringify(st)), details: { ...st }, isError: false };
			}, (r) => String((r.details as { status?: string }).status));
		},
	});

	const http = defineTool({
		name: "credential_http",
		description:
			"Send ONE HTTPS request through the server with a credential the user provided (credentialId from credential_request/credential_list, or requestId). " +
			"The server injects the secret and only sends to the credential's allowed hosts and methods; the secret is scrubbed from the response. " +
			"Redirects are not followed (a 3xx returns its Location; calling again re-checks the host). Body max 1 MB, response max 2 MB, 30 s. " +
			"External effects, not repeated after an interruption: check state before retrying; pass an Idempotency-Key header if the API supports it.",
		parameters: obj({
			credentialId: opt(str()),
			requestId: opt(str()),
			method: oneOf(["GET", "POST", "PUT", "PATCH", "DELETE"]),
			url: str({ description: "https:// URL on one of the credential's hosts" }),
			headers: opt(map(str(), { description: "Extra request headers (not the injected header, not hop-by-hop headers)" })),
			body: opt(str({ description: "Request body (text), max 1 MB" })),
		}),
		replay: "unsafe",
		executionMode: "sequential",
		async execute(args, api, c) {
			const actor = await resolve(api, c);
			return log().around({ tool: "credential_http", actor, args: { ...args, body: args.body === undefined ? undefined : `${args.body.length} 字符` } }, async () => {
				await ctx.services.get("acl").require(actor.principal, "write", { kind: "space", id: actor.space.id });
				const r = await credentialHttp(ctx, actor, args as Parameters<typeof credentialHttp>[2], c.abortSignal);
				return { output: text(formatProxyResult(r)), details: { status: r.status, host: r.host, scrubbed: r.scrubbed, ...(r.redirect ? { redirectHost: r.redirect.host } : {}) }, isError: false };
			}, (r) => `HTTP ${(r.details as { status: number }).status}`);
		},
	});

	const list = defineTool({
		name: "credential_list",
		description: "List the user's saved credentials you may use here (id, service, hosts/methods, expiry; never the value).",
		parameters: obj({}),
		replay: "safe",
		async execute(_args, api, c) {
			const actor = await resolve(api, c);
			return log().around({ tool: "credential_list", actor, args: {} }, async () => {
				const svc = store();
				const out: Record<string, unknown>[] = [];
				for (const d of await svc.list(actor.principal)) {
					if (d.revokedAt || (d.expiresAt && Date.parse(d.expiresAt) <= svc.now())) continue;
					const row = svc.row(d.id)!;
					if (d.usage !== "proxy" || !(await svc.canUse(actor.principal, row, { spaceId: actor.space.id, conversationId: actor.conversationId }))) continue;
					out.push({ credentialId: d.id, service: d.name, scope: d.scope, targetHosts: d.targetHosts, methods: d.methods, ...(d.expiresAt ? { expiresAt: d.expiresAt } : {}) });
				}
				return { output: text(JSON.stringify({ credentials: out })), details: { count: out.length } };
			}, (r) => `${(r.details as { count: number }).count} credentials`);
		},
	});

	return defineExtension({ name: "wr.credentials", tools: [request, http, list] });
}

/** Tool names for tool policy / knownToolNames lists in server/src/tools/module.ts and policy.ts. */
export const CREDENTIAL_TOOL_NAMES = ["credential_request", "credential_http", "credential_list"] as const;
