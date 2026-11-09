// Outbound webhook egress policy (SSRF + DNS rebinding):
//  1. Resolve the hostname ONCE per attempt; every resolved address must be allowed.
//  2. Connect to that exact validated address (pinned `lookup`), so a second DNS answer can never redirect the socket.
//     TLS still verifies the certificate for the original hostname (SNI = hostname).
//  3. Private, loopback, link-local, CGNAT, multicast, reserved and unspecified ranges are refused unless allowlisted.
//     Cloud metadata endpoints are refused unless the INSTANCE allowlist (env) names them exactly.
//  4. No redirects are followed (a 3xx is a failed delivery).
// Allowlists: instance-wide `WORKROOM_WEBHOOK_ALLOWLIST` (comma list of IPs / CIDRs / hostnames), and per-org
// `ops_settings(key='webhook_allowlist')` managed by org admins (IPs / CIDRs / hostnames; cannot unlock metadata).
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { HttpError } from "../core/http.ts";

const PRIVATE = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["2001:db8::", 32]] as const) PRIVATE.addSubnet(net, bits, "ipv6");
const METADATA_IPS = new Set(["169.254.169.254", "169.254.170.2", "100.100.100.200", "fd00:ec2::254"]);
const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata", "instance-data", "instance-data.ec2.internal"]);

export interface ResolvedTarget {
	url: URL;
	address: string;
	family: 4 | 6;
}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
export const systemResolver: Resolver = (host) => dnsLookup(host, { all: true, verbatim: true });

const normalize = (ip: string): string => {
	const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
	return m ? m[1]! : ip.toLowerCase();
};

export class Allowlist {
	readonly #ips = new BlockList();
	readonly #exact = new Set<string>();
	readonly #hosts = new Set<string>();
	constructor(entries: readonly string[]) {
		for (const raw of entries) {
			const e = raw.trim().toLowerCase();
			if (!e) continue;
			const [ip, bits] = e.split("/");
			const fam = isIP(ip ?? "");
			if (fam) {
				const type = fam === 4 ? "ipv4" : "ipv6";
				if (bits !== undefined) this.#ips.addSubnet(ip!, Number(bits), type);
				else {
					this.#ips.addAddress(ip!, type);
					this.#exact.add(normalize(ip!));
				}
			} else if (/^[a-z0-9.-]+$/.test(e)) this.#hosts.add(e);
			else throw new HttpError(400, "invalid_allowlist", `允许列表条目无效：${raw}`);
		}
	}
	allowsHost(host: string): boolean {
		return this.#hosts.has(host.toLowerCase());
	}
	allowsIp(ip: string): boolean {
		const n = normalize(ip);
		return this.#ips.check(n, isIP(n) === 6 ? "ipv6" : "ipv4");
	}
	exactIp(ip: string): boolean {
		return this.#exact.has(normalize(ip));
	}
}

export function instanceAllowlist(): Allowlist {
	return new Allowlist((process.env.WORKROOM_WEBHOOK_ALLOWLIST ?? "").split(","));
}

/** Validate a URL and resolve it to one pinned, allowed address. Throws HttpError(400) with a precise reason. */
export async function resolveTarget(rawUrl: string, orgAllow: Allowlist, resolver: Resolver = systemResolver): Promise<ResolvedTarget> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new HttpError(400, "invalid_url", "Webhook 地址无效");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new HttpError(400, "invalid_url", "Webhook 仅支持 http(s)");
	if (url.username || url.password) throw new HttpError(400, "invalid_url", "Webhook 地址不得包含用户名/密码");
	const inst = instanceAllowlist();
	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (METADATA_HOSTS.has(host) && !inst.allowsHost(host)) throw new HttpError(400, "blocked_address", `禁止访问云元数据地址：${host}`);
	const hostAllowed = inst.allowsHost(host) || orgAllow.allowsHost(host);
	let addrs: { address: string; family: number }[];
	if (isIP(host)) addrs = [{ address: host, family: isIP(host) }];
	else {
		try {
			addrs = await resolver(host);
		} catch (e) {
			throw new HttpError(400, "dns_failed", `无法解析 ${host}：${(e as Error).message}`);
		}
	}
	if (!addrs.length) throw new HttpError(400, "dns_failed", `无法解析 ${host}`);
	for (const a of addrs) {
		const ip = normalize(a.address);
		if (METADATA_IPS.has(ip) && !inst.exactIp(ip)) throw new HttpError(400, "blocked_address", `禁止访问云元数据地址：${ip}`);
		const priv = PRIVATE.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");
		if (priv && !hostAllowed && !inst.allowsIp(ip) && !orgAllow.allowsIp(ip)) throw new HttpError(400, "blocked_address", `${host} 解析到内网/保留地址 ${ip}，未在允许列表中`);
	}
	const first = addrs[0]!;
	return { url, address: normalize(first.address), family: (isIP(normalize(first.address)) === 6 ? 6 : 4) as 4 | 6 };
}

/** POST to a pinned address. Never follows redirects. Resolves with the HTTP status. */
export function pinnedPost(t: ResolvedTarget, headers: Record<string, string>, body: string, timeoutMs: number): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = (t.url.protocol === "https:" ? httpsRequest : httpRequest)(
			{
				protocol: t.url.protocol,
				hostname: t.url.hostname.replace(/^\[|\]$/g, ""),
				port: t.url.port || undefined,
				path: `${t.url.pathname}${t.url.search}`,
				method: "POST",
				headers: { ...headers, "content-length": Buffer.byteLength(body).toString() },
				servername: isIP(t.url.hostname) ? undefined : t.url.hostname,
				// Pin: whatever the socket asks DNS for, it gets the address we validated.
				lookup: ((_h: string, opts: any, cb: any) => (opts?.all ? cb(null, [{ address: t.address, family: t.family }]) : cb(null, t.address, t.family))) as any,
				timeout: timeoutMs,
			},
			(res) => {
				res.resume();
				res.on("end", () => resolve(res.statusCode ?? 0));
				res.on("error", reject);
			},
		);
		req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
		req.on("error", reject);
		req.end(body);
	});
}
