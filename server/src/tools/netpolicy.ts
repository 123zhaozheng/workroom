// Outbound URL policy (SSRF guard) for browse and personal MCP-over-HTTP connectors.
// Blocks loopback, private, link-local (incl. cloud metadata 169.254.169.254), CGNAT, multicast and unspecified addresses
// unless the exact host[:port] is listed in WORKROOM_URL_ALLOWLIST (comma separated, operator-controlled).
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HttpError } from "../core/http.ts";

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
export async function checkUrl(raw: string, opts: { allowPrivate?: boolean } = {}): Promise<UrlCheck> {
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
	else {
		try {
			addresses = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
		} catch {
			throw new HttpError(400, "dns_failed", `无法解析域名 ${host}`);
		}
	}
	if (!allowlisted && !opts.allowPrivate) {
		const bad = addresses.find(isPrivateAddress);
		if (bad || host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal")
			throw new HttpError(400, "url_blocked", `不允许访问内网或元数据地址（${host} → ${bad ?? host}）`);
	}
	return { url, addresses, allowlisted };
}
