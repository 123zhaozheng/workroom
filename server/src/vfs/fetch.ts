// Download the real bytes behind an HTTP(S) URL for present_file / copy_to_work, through the project's egress policy: every hop is validated
// and DNS-pinned (netpolicy.pinnedRequest), redirects are re-checked (max 5), the body is streamed with a hard size limit and a timeout.
// Nothing of the server's identity travels: no cookies, no model keys, no browser session — only a plain User-Agent.
import { pinnedRequest } from "../tools/netpolicy.ts";
import { VfsError } from "./types.ts";

/** Download size limit (MB, env WORKROOM_FETCH_MAX_MB, default 50), read at each use. */
export const urlMaxBytes = (): number => Number(process.env.WORKROOM_FETCH_MAX_MB ?? 50) * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface Fetched {
	readonly bytes: Uint8Array;
	readonly contentType?: string;
	/** From a Content-Disposition filename, else the last URL path segment. */
	readonly fileName?: string;
	readonly finalUrl: string;
}

function dispositionName(h: string | undefined): string | undefined {
	if (!h) return undefined;
	const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(h);
	if (star) {
		try {
			return decodeURIComponent(star[1]!.trim().replace(/^"|"$/g, ""));
		} catch {
			/* fall through */
		}
	}
	const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(h);
	return plain?.[1]?.trim() || undefined;
}

export async function fetchBytes(raw: string, opts: { maxBytes?: number; timeoutMs?: number; signal?: AbortSignal; orgId?: string } = {}): Promise<Fetched> {
	const max = opts.maxBytes ?? urlMaxBytes();
	let url = raw;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		let res;
		try {
			res = await pinnedRequest(url, { method: "GET", headers: { "user-agent": "Workroom-Fetch/1", accept: "*/*" }, signal: opts.signal, timeoutMs: opts.timeoutMs ?? 30_000, orgId: opts.orgId });
		} catch (e) {
			const code = (e as { code?: string }).code;
			throw new VfsError("fetch_failed", code === "url_blocked" || code === "bad_url" || code === "dns_failed" ? (e as Error).message : `下载失败：${(e as Error).message}`, 400);
		}
		if (res.status >= 300 && res.status < 400 && res.headers.location) {
			res.body.resume();
			url = new URL(String(res.headers.location), url).href;
			continue;
		}
		if (res.status < 200 || res.status >= 300) {
			res.body.resume();
			throw new VfsError("fetch_failed", `下载失败：服务器返回 HTTP ${res.status}`, 400);
		}
		const declared = Number(res.headers["content-length"] ?? 0);
		if (declared > max) {
			res.body.destroy();
			throw new VfsError("too_large", `文件过大（${Math.round(declared / 1048576)} MB），上限 ${Math.round(max / 1048576)} MB`, 413);
		}
		const chunks: Buffer[] = [];
		let size = 0;
		await new Promise<void>((resolve, reject) => {
			res.body.on("data", (c: Buffer) => {
				size += c.length;
				if (size > max) {
					res.body.destroy();
					reject(new VfsError("too_large", `文件超过上限 ${Math.round(max / 1048576)} MB，已停止下载`, 413));
					return;
				}
				chunks.push(c);
			});
			res.body.on("end", () => resolve());
			res.body.on("error", (e) => reject(new VfsError("fetch_failed", `下载中断：${e.message}`, 400)));
		});
		const last = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "");
		const type = String(res.headers["content-type"] ?? "").split(";")[0]!.trim() || undefined;
		return { bytes: new Uint8Array(Buffer.concat(chunks)), contentType: type, fileName: dispositionName(res.headers["content-disposition"] as string | undefined) || last || undefined, finalUrl: url };
	}
	throw new VfsError("fetch_failed", "重定向次数过多", 400);
}
