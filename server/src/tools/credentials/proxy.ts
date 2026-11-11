// Credential proxy: the SERVER performs the HTTP request, injecting the secret into one header. The model never sees the value.
//
// Guarantees (tests: server/test/credentials.test.ts):
//  - https only; the URL host must match the credential's targetHosts (exact, or "*." = exactly one label); optional port allow-list (443 default);
//  - DNS is resolved once, every address must be public (egress.ts resolveTarget; only the INSTANCE allowlist can unlock private ranges, the org
//    allowlist is deliberately not consulted), and the socket is pinned to the validated address (TLS verifies the original hostname);
//  - no redirects are followed (a 3xx is returned with its Location host; a follow-up call is validated again);
//  - HTTP(S)_PROXY and friends are ignored (direct connection, own Agent);
//  - user headers may not collide with the injected header or hop-by-hop headers; body <= 1 MB, response <= 2 MB, 30 s overall timeout;
//  - the secret (raw, base64 in all alignments, url-safe base64, percent-encoded, JSON-escaped, hex, and the same for the injected header value) is
//    scrubbed from status line, headers and body before anything is returned or recorded.
import { isIP } from "node:net";
import { Agent, request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import type { AppContext, ToolActor } from "../../core/contracts.ts";
import { Allowlist, resolveTarget, systemResolver, type ResolvedTarget, type Resolver } from "../../ops/egress.ts";
import { HttpError } from "../../core/http.ts";
import { ALLOWED_METHODS, hostMatches } from "./requests.ts";
import { credentialsFor } from "./store.ts";

export const LIMITS = { requestBytes: 1024 * 1024, responseBytes: 2 * 1024 * 1024, timeoutMs: 30_000, modelChars: 200_000 } as const;

export interface ProxyConfig {
	resolver: Resolver;
	/** Extra TLS options (tests: an explicit test CA). Never used to disable verification. */
	tls?: { ca?: string | Buffer };
	/** Allowed destination ports (default 443). Operators may add more with WORKROOM_CREDENTIAL_EXTRA_PORTS=8443,9443. */
	allowedPorts: Set<number>;
	timeoutMs: number;
}
const configs = new WeakMap<AppContext, ProxyConfig>();
export function proxyConfigFor(ctx: AppContext): ProxyConfig {
	let c = configs.get(ctx);
	if (!c) {
		const extra = (process.env.WORKROOM_CREDENTIAL_EXTRA_PORTS ?? "").split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
		configs.set(ctx, (c = { resolver: systemResolver, allowedPorts: new Set([443, ...extra]), timeoutMs: LIMITS.timeoutMs }));
	}
	return c;
}

// ------------------------------------------------------------------ scrubbing
function b64Needles(buf: Buffer): string[] {
	const out: string[] = [];
	for (let k = 0; k < 3; k++) {
		const e = Buffer.concat([Buffer.alloc(k, 0x41), buf]).toString("base64");
		const start = k === 0 ? 0 : Math.ceil((8 * k) / 6);
		const end = Math.floor((8 * (k + buf.length)) / 6);
		const core = e.slice(start, end);
		if (core.length >= 8) {
			out.push(core, core.replaceAll("+", "-").replaceAll("/", "_"));
		}
	}
	return out;
}

/** Every representation of `value` a server could plausibly echo. Raw value always; derived forms only when long enough to be unambiguous. */
export function secretForms(value: string): string[] {
	const set = new Set<string>([value]);
	const buf = Buffer.from(value, "utf8");
	for (const n of b64Needles(buf)) set.add(n);
	for (const n of [encodeURIComponent(value), encodeURI(value), JSON.stringify(value).slice(1, -1), buf.toString("hex"), buf.toString("hex").toUpperCase()]) if (n.length >= 8) set.add(n);
	return [...set].filter((s) => s.length > 0);
}

export function scrub(text: string, needles: readonly string[]): { text: string; hits: number } {
	let out = text;
	let hits = 0;
	for (const n of needles) {
		if (!n || !out.includes(n)) continue;
		const parts = out.split(n);
		hits += parts.length - 1;
		out = parts.join("[REDACTED]");
	}
	return { text: out, hits };
}

// ------------------------------------------------------------------ pinned request
export interface RawResponse {
	status: number;
	statusMessage: string;
	headers: IncomingHttpHeaders;
	body: Buffer;
	truncated: boolean;
}

export function pinnedRequest(t: ResolvedTarget, o: { method: string; headers: Record<string, string>; body?: Buffer; timeoutMs: number; maxBytes: number; tls?: ProxyConfig["tls"]; signal?: AbortSignal }): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		if (o.signal?.aborted) return reject(new Error("aborted"));
		const host = t.url.hostname.replace(/^\[|\]$/g, "");
		const headers: Record<string, string> = { "user-agent": "Workroom-credential-proxy/1", accept: "*/*", ...o.headers, "accept-encoding": "identity" };
		if (o.body) headers["content-length"] = String(o.body.length);
		// Own Agent: never the global one, so proxy environment variables (HTTP(S)_PROXY / NODE_USE_ENV_PROXY) cannot apply.
		const agent = new Agent({ keepAlive: false });
		let done = false;
		const finish = (fn: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			o.signal?.removeEventListener("abort", onAbort);
			agent.destroy();
			fn();
		};
		const req = httpsRequest(
			{
				protocol: "https:",
				hostname: host,
				port: t.url.port || 443,
				path: `${t.url.pathname}${t.url.search}`,
				method: o.method,
				headers,
				agent,
				servername: isIP(host) ? undefined : host,
				rejectUnauthorized: true,
				...(o.tls?.ca ? { ca: o.tls.ca } : {}),
				// Pin: whatever the socket asks DNS for, it gets the address validated by resolveTarget.
				lookup: ((_h: string, opts: any, cb: any) => (opts?.all ? cb(null, [{ address: t.address, family: t.family }]) : cb(null, t.address, t.family))) as any,
			},
			(res) => {
				const chunks: Buffer[] = [];
				let size = 0;
				let truncated = false;
				res.on("data", (c: Buffer) => {
					if (truncated) return;
					size += c.length;
					if (size > o.maxBytes) {
						truncated = true;
						chunks.push(c.subarray(0, c.length - (size - o.maxBytes)));
						finish(() => resolve({ status: res.statusCode ?? 0, statusMessage: res.statusMessage ?? "", headers: res.headers, body: Buffer.concat(chunks), truncated }));
						res.destroy();
						return;
					}
					chunks.push(c);
				});
				res.on("end", () => finish(() => resolve({ status: res.statusCode ?? 0, statusMessage: res.statusMessage ?? "", headers: res.headers, body: Buffer.concat(chunks), truncated })));
				res.on("error", (e) => finish(() => reject(e)));
				res.on("aborted", () => finish(() => reject(new Error("response aborted"))));
			},
		);
		const timer = setTimeout(() => req.destroy(new Error(`timeout after ${o.timeoutMs} ms`)), o.timeoutMs);
		const onAbort = () => req.destroy(new Error("aborted"));
		o.signal?.addEventListener("abort", onAbort, { once: true });
		req.on("error", (e) => finish(() => reject(e)));
		req.end(o.body);
	});
}

// ------------------------------------------------------------------ the tool's engine
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", "accept-encoding", "expect"]);
const SHOW_HEADERS = /^(content-type|content-length|content-language|location|retry-after|etag|last-modified|link|cache-control|date|www-authenticate|x-request-id|request-id|x-ratelimit-[a-z-]+|ratelimit-[a-z-]+)$/;

export interface HttpArgs {
	credentialId?: string;
	requestId?: string;
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: string;
}

export interface ProxyResult {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	body: string;
	bodyBytes: number;
	truncated: boolean;
	scrubbed: boolean;
	/** For 3xx: where it points (NOT followed). */
	redirect?: { location: string; host: string; sameHost: boolean };
	host: string;
}

const refuse = (code: string, msg: string, status = 400) => new HttpError(status, code, msg);

export async function credentialHttp(ctx: AppContext, actor: ToolActor, args: HttpArgs, signal?: AbortSignal): Promise<ProxyResult> {
	const store = credentialsFor(ctx);
	const cfg = proxyConfigFor(ctx);
	if (!args.credentialId && !args.requestId) throw refuse("credential_ref_required", "需要 credentialId 或 requestId");
	const method = String(args.method ?? "").toUpperCase();
	if (!(ALLOWED_METHODS as readonly string[]).includes(method)) throw refuse("method_not_allowed", `method 只允许 ${ALLOWED_METHODS.join("/")}`);
	let url: URL;
	try {
		url = new URL(String(args.url ?? ""));
	} catch {
		throw refuse("invalid_url", "url 无效");
	}
	if (url.protocol !== "https:") throw refuse("https_required", "只允许 https 地址");
	if (url.username || url.password) throw refuse("invalid_url", "url 不得包含用户名/密码");
	const port = url.port ? Number(url.port) : 443;
	if (!cfg.allowedPorts.has(port)) throw refuse("port_not_allowed", `不允许访问端口 ${port}`);
	const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();

	// Lifecycle + ACL (refusal is audited, without any request detail).
	const row = await store.authorizeProxy(actor, { credentialId: args.credentialId, requestId: args.requestId });
	const hosts = JSON.parse(row.target_hosts) as string[];
	const methods = JSON.parse(row.methods) as string[];
	const inject = JSON.parse(row.inject) as { header: string; template: string };
	const deny = (code: string, msg: string): never => {
		store.audit(actor.principal, "credential.use_denied", row.id, { credentialId: row.id, reason: code, host, method, via: "proxy" });
		throw refuse(code, msg, 403);
	};
	if (!methods.includes(method)) deny("method_not_allowed", `该凭据只允许 ${methods.join("/")}，不允许 ${method}`);
	if (!hosts.some((p) => hostMatches(p, host))) deny("host_not_allowed", `该凭据只能发往 ${hosts.join("、")}，不能发往 ${host}`);

	// Headers / body: strictly validated, nothing the model sends may carry or displace the credential.
	const headers: Record<string, string> = {};
	for (const [k, v] of Object.entries(args.headers ?? {})) {
		const name = k.trim();
		if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name)) throw refuse("invalid_header", `请求头名 ${k.slice(0, 40)} 无效`);
		if (typeof v !== "string" || /[\r\n\0]/.test(v) || v.length > 8192) throw refuse("invalid_header", `请求头 ${name} 的值无效`);
		const lower = name.toLowerCase();
		if (lower === inject.header.toLowerCase()) throw refuse("header_collision", `不能自行设置 ${name}：该头由服务器注入凭据`);
		if (HOP_BY_HOP.has(lower)) throw refuse("header_not_allowed", `不允许设置请求头 ${name}`);
		headers[name] = v;
	}
	let body: Buffer | undefined;
	if (args.body !== undefined) {
		if (typeof args.body !== "string") throw refuse("invalid_body", "body 必须是字符串");
		body = Buffer.from(args.body, "utf8");
		if (body.length > LIMITS.requestBytes) throw refuse("body_too_large", `请求体超过 ${LIMITS.requestBytes / 1024} KB`);
		if (method === "GET") throw refuse("invalid_body", "GET 不能带请求体");
	}

	// Network policy (before the secret is opened): resolve once, all addresses public unless the INSTANCE allowlist says otherwise.
	const target = await resolveTarget(url.toString(), new Allowlist([]), cfg.resolver).catch((e: unknown) => {
		if (e instanceof HttpError) store.audit(actor.principal, "credential.use_denied", row.id, { credentialId: row.id, reason: e.code, host, method, via: "proxy" });
		throw e;
	});

	const secret = await store.openSealed(row);
	const injected = inject.template.split("{secret}").join(secret);
	const needles = [...new Set([...secretForms(secret), ...secretForms(injected)])].sort((a, b) => b.length - a.length);
	let raw: RawResponse;
	try {
		raw = await pinnedRequest(target, { method, headers: { ...headers, [inject.header]: injected }, body, timeoutMs: cfg.timeoutMs, maxBytes: LIMITS.responseBytes, tls: cfg.tls, signal });
	} catch (e) {
		const reason = scrub(String((e as Error)?.message ?? e), needles).text.slice(0, 200);
		store.audit(actor.principal, "credential.use", row.id, { credentialId: row.id, via: "proxy", host, method, status: 0, error: true, spaceId: actor.space.id, conversationId: actor.conversationId });
		throw new HttpError(502, "upstream_failed", `请求 ${host} 失败：${reason}`);
	}
	store.markUsed(row);
	store.audit(actor.principal, "credential.use", row.id, { credentialId: row.id, via: "proxy", host, method, status: raw.status, spaceId: actor.space.id, conversationId: actor.conversationId });

	let hits = 0;
	const clean = (s: string): string => {
		const r = scrub(s, needles);
		hits += r.hits;
		return r.text;
	};
	const outHeaders: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw.headers)) if (SHOW_HEADERS.test(k) && v !== undefined) outHeaders[k] = clean(Array.isArray(v) ? v.join(", ") : String(v));
	const ct = String(raw.headers["content-type"] ?? "");
	const textual = /^(text\/|application\/(json|xml|x-www-form-urlencoded|javascript|yaml|.*\+(json|xml)))|charset=/i.test(ct) || ct === "";
	let text: string;
	if (textual) {
		text = clean(raw.body.toString("utf8"));
		if (text.length > LIMITS.modelChars) text = `${text.slice(0, LIMITS.modelChars)}…`;
	} else text = `[二进制内容 ${raw.body.length} 字节，未返回；content-type: ${clean(ct).slice(0, 80)}]`;
	const result: ProxyResult = { status: raw.status, statusText: clean(raw.statusMessage), headers: outHeaders, body: text, bodyBytes: raw.body.length, truncated: raw.truncated || text.endsWith("…"), scrubbed: hits > 0, host };
	const loc = raw.headers.location;
	if (raw.status >= 300 && raw.status < 400 && typeof loc === "string") {
		let lh = "";
		let abs = loc;
		try {
			const u = new URL(loc, url);
			lh = u.hostname.toLowerCase();
			abs = u.toString();
		} catch {
			/* keep raw */
		}
		result.redirect = { location: clean(abs), host: lh, sameHost: lh === host };
	}
	if (hits > 0) store.audit(actor.principal, "credential.use", row.id, { credentialId: row.id, via: "proxy", host, method, note: "response_scrubbed", scrubbed: hits });
	return result;
}
