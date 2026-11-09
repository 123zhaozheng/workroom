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
/** Parse an IPv6 literal (compressed, with optional trailing dotted quad) into 8 hextets; null if malformed. */
function parseV6(ip: string): number[] | null {
	let s = ip.toLowerCase();
	const pct = s.indexOf("%");
	if (pct >= 0) s = s.slice(0, pct); // zone id
	const halves = s.split("::");
	if (halves.length > 2) return null;
	const toHextets = (part: string): number[] | null => {
		if (part === "") return [];
		const out: number[] = [];
		const groups = part.split(":");
		for (let i = 0; i < groups.length; i++) {
			const g = groups[i]!;
			if (i === groups.length - 1 && g.includes(".")) {
				if (isIP(g) !== 4) return null;
				const n = v4ToInt(g);
				out.push(n >>> 16, n & 0xffff);
			} else if (/^[0-9a-f]{1,4}$/.test(g)) out.push(parseInt(g, 16));
			else return null;
		}
		return out;
	};
	const head = toHextets(halves[0]!);
	const tail = halves.length === 2 ? toHextets(halves[1]!) : [];
	if (!head || !tail) return null;
	if (halves.length === 1) return head.length === 8 ? head : null;
	const fill = 8 - head.length - tail.length;
	return fill < 1 ? null : [...head, ...new Array(fill).fill(0), ...tail];
}
const v4From = (hi: number, lo: number): string => [hi >>> 8, hi & 255, lo >>> 8, lo & 255].join(".");

export function isPrivateAddress(ip: string): boolean {
	if (isIP(ip) === 4) {
		const n = v4ToInt(ip);
		return V4_BLOCKS.some(([base, bits]) => (n & (bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0)) >>> 0 === v4ToInt(base));
	}
	const h = parseV6(ip);
	if (!h) return true; // unparseable → refuse
	const zeros = (a: number, b: number) => h.slice(a, b).every((x) => x === 0);
	if (zeros(0, 8)) return true; // ::
	if (zeros(0, 7) && h[7] === 1) return true; // ::1
	if (zeros(0, 5) && h[5] === 0xffff) return isPrivateAddress(v4From(h[6]!, h[7]!)); // ::ffff:a.b.c.d (any notation)
	if (zeros(0, 6)) return true; // deprecated IPv4-compatible ::a.b.c.d — never needed for public egress
	if (h[0] === 0x0064 && h[1] === 0xff9b) return true; // NAT64 well-known prefix (64:ff9b::/96, 64:ff9b:1::/48)
	if (h[0] === 0x2002) return isPrivateAddress(v4From(h[1]!, h[2]!)); // 6to4 embeds an IPv4 address
	if (h[0] === 0x2001 && h[1] === 0) return true; // Teredo (embeds an obfuscated IPv4 address)
	if ((h[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
	if ((h[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
	if ((h[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
	if ((h[0]! & 0xff00) === 0xff00) return true; // ff00::/8 multicast
	if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation
	return false;
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
