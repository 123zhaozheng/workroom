// Outbound URL policy (SSRF guard) for browse and personal MCP-over-HTTP connectors.
// Blocks loopback, private, link-local (incl. cloud metadata 169.254.169.254), CGNAT, multicast and unspecified addresses
// unless the exact host[:port] is listed in WORKROOM_URL_ALLOWLIST (comma separated, operator-controlled).
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { HttpError } from "../core/http.ts";

type Resolver = (host: string) => Promise<string[]>;
const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
let resolver: Resolver = defaultResolver;
/** Tests: replace DNS resolution (e.g. a name that rebinds to 127.0.0.1 after validation). null restores the system resolver. */
export function setResolverForTests(r: Resolver | null): void {
	resolver = r ?? defaultResolver;
}

function v4ToInt(ip: string): number {
	return ip.split(".").reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
}
const V4_BLOCKS: [string, number][] = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
];
export function isPrivateAddress(ip: string): boolean {
	if (isIP(ip) === 4) {
		const n = v4ToInt(ip);
		return V4_BLOCKS.some(([base, bits]) => (n & (bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0)) >>> 0 === v4ToInt(base));
	}
	const s = ip.toLowerCase();
	if (s === "::" || s === "::1") return true;
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
	if (mapped) return isPrivateAddress(mapped[1]!);
	return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s) || s.startsWith("64:ff9b:");
}

function allowlist(): Set<string> {
	return new Set((process.env.WORKROOM_URL_ALLOWLIST ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

export interface UrlCheck {
	readonly url: URL;
	readonly addresses: string[];
	readonly allowlisted: boolean;
}

/** Validate scheme and resolve the host; throw 400 url_blocked when it points at a non-public address. */
export async function checkUrl(raw: string, opts: { allowPrivate?: boolean; pinned?: string } = {}): Promise<UrlCheck> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new HttpError(400, "bad_url", "URL 无效");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new HttpError(400, "url_blocked", `不允许的协议 ${url.protocol}`);
	if (url.username || url.password) throw new HttpError(400, "url_blocked", "URL 不能包含用户名或密码");
	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	const port = url.port || (url.protocol === "https:" ? "443" : "80");
	const listed = allowlist();
	const allowlisted = listed.has(`${host}:${port}`) || listed.has(host);
	let addresses: string[];
	if (isIP(host)) addresses = [host];
	else if (opts.pinned) addresses = [opts.pinned]; // already validated for this origin: never re-resolved
	else {
		try {
			addresses = await resolver(host);
		} catch {
			throw new HttpError(400, "dns_failed", `无法解析域名 ${host}`);
		}
		if (!addresses.length) throw new HttpError(400, "dns_failed", `无法解析域名 ${host}`);
	}
	if (!allowlisted && !opts.allowPrivate) {
		// An address is acceptable when public, or when the operator allowlisted that exact IP (or IP:port).
		const bad = addresses.find((a) => isPrivateAddress(a) && !listed.has(a) && !listed.has(`${a}:${port}`));
		if (bad || host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal")
			throw new HttpError(400, "url_blocked", `不允许访问内网或元数据地址（${host} → ${bad ?? host}）`);
	}
	return { url, addresses, allowlisted };
}

export interface PinnedResponse {
	readonly status: number;
	readonly headers: IncomingHttpHeaders;
	readonly body: Readable;
	readonly address: string;
}

/**
 * HTTP(S) request whose TCP connection goes to the address validated by `checkUrl` (DNS pinning): the name is resolved
 * once, checked, and the socket connects to that IP — a second resolution (DNS rebinding) can never redirect it. TLS still
 * verifies the certificate against the hostname (SNI = hostname). Redirects are not followed; callers re-check each hop.
 */
export async function pinnedRequest(raw: string, init: { method?: string; headers?: Record<string, string>; body?: Uint8Array | string | null; signal?: AbortSignal; allowPrivate?: boolean; timeoutMs?: number; pinned?: string } = {}): Promise<PinnedResponse> {
	const { url, addresses } = await checkUrl(raw, { allowPrivate: init.allowPrivate, pinned: init.pinned });
	const address = addresses[0]!;
	const family = isIP(address) === 6 ? 6 : 4;
	const req = (url.protocol === "https:" ? httpsRequest : httpRequest)({
		protocol: url.protocol,
		hostname: url.hostname.replace(/^\[|\]$/g, ""),
		port: url.port || undefined,
		path: `${url.pathname}${url.search}`,
		method: init.method ?? "GET",
		headers: { ...init.headers, host: url.host },
		servername: isIP(url.hostname) ? undefined : url.hostname,
		lookup: ((_h: string, o: any, cb: any) => (o?.all ? cb(null, [{ address, family }]) : cb(null, address, family))) as any,
		signal: init.signal,
		timeout: init.timeoutMs ?? 20_000,
	});
	return new Promise<PinnedResponse>((resolve, reject) => {
		req.on("response", (res) => resolve({ status: res.statusCode ?? 502, headers: res.headers, body: res, address }));
		req.on("timeout", () => req.destroy(new Error(`连接 ${url.host} 超时`)));
		req.on("error", reject);
		if (init.body) req.write(init.body);
		req.end();
	});
}

/** fetch-compatible wrapper over pinnedRequest (for SDK clients such as MCP streamable HTTP). */
export function pinnedFetch(opts: { allowPrivate?: boolean; pins?: Map<string, string> } = {}) {
	const pins = opts.pins ?? new Map<string, string>(); // origin → validated address, for the lifetime of this client
	return async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const headers: Record<string, string> = {};
		new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => (headers[k] = v));
		let body: Uint8Array | string | null = null;
		if (typeof init.body === "string") body = init.body;
		else if (init.body instanceof Uint8Array) body = init.body;
		else if (init.body instanceof ArrayBuffer) body = new Uint8Array(init.body);
		else if (init.body) body = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
		const origin = new URL(href).origin;
		const r = await pinnedRequest(href, { method: init.method ?? "GET", headers, body, signal: init.signal ?? undefined, allowPrivate: opts.allowPrivate, pinned: pins.get(origin) });
		pins.set(origin, r.address);
		const h = new Headers();
		for (const [k, v] of Object.entries(r.headers)) if (v !== undefined) for (const x of Array.isArray(v) ? v : [v]) h.append(k, String(x));
		const nullBody = r.status === 204 || r.status === 304 || (init.method ?? "GET") === "HEAD";
		return new Response(nullBody ? null : (Readable.toWeb(r.body) as ReadableStream), { status: r.status, headers: h });
	};
}
