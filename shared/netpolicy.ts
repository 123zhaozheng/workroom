// 网络访问策略（组织级）：名单语法、校验、匹配，以及管理 API 的 DTO。服务端（server/src/tools/netpolicy.ts）与管理后台
// （web/src/features/admin/NetworkTab.tsx）共用同一份实现，所以界面里的格式校验与服务端的判定不会不一致。
// 保持无依赖（只用全局 URL）。安全底线（协议、凭据 URL、DNS 固定、元数据地址）不在这里：它们不可配置，写在 netpolicy.ts。

export type NetMode = "open" | "allowlist";
export type NetListKind = "allow" | "block" | "internal";

export interface NetPolicyDTO {
	/** open：全部公网允许；allowlist：只允许 allow 与 internal 名单内的主机。 */
	readonly mode: NetMode;
	/** 仅 allowlist 模式使用。 */
	readonly allow: readonly string[];
	/** 任何模式下都拦截（优先于其它名单）。 */
	readonly block: readonly string[];
	/** 内网例外：允许访问这些主机/IP 解析到的内网地址（云元数据地址除外）。同时视为「允许」。 */
	readonly internal: readonly string[];
}

/** 新库默认：全部公网允许、名单为空 —— 与引入该策略之前的行为完全一致。 */
export const DEFAULT_NET_POLICY: NetPolicyDTO = { mode: "open", allow: [], block: [], internal: [] };
export const NET_LIST_MAX = 200;

export const NET_LIST_LABEL: Readonly<Record<NetListKind, string>> = { allow: "允许名单", block: "阻止名单", internal: "内网例外" };

export interface NetPolicyAdminDTO {
	readonly policy: NetPolicyDTO;
	/** 环境变量 WORKROOM_URL_ALLOWLIST 里的条目：由运维设置，与 internal 合并生效，界面只读。 */
	readonly env: { readonly internal: readonly string[] };
	readonly updatedAt?: string;
	readonly updatedBy?: string;
	readonly isDefault: boolean;
}

export type NetRule = "ok" | "bad_url" | "protocol" | "credentials" | "blocklist" | "not_in_allowlist" | "metadata" | "private" | "dns";
export interface NetTestResult {
	readonly allowed: boolean;
	readonly rule: NetRule;
	/** 给人看的结论与原因。 */
	readonly reason: string;
	readonly host?: string;
	readonly port?: string;
	/** DNS 解析结果（只解析，不发起连接）。 */
	readonly addresses?: readonly string[];
	/** 放行的依据：公网 / 允许名单 / 内网例外 / 环境变量。 */
	readonly via?: "public" | "allowlist" | "internal" | "env";
}

// ------------------------------------------------------------------ entries
// 一条名单条目 = `主机[:端口]`，主机可以是域名、`*.example.com`（所有子域名，不含 example.com 本身）、IPv4、IPv6（IPv6 带端口写成 [::1]:8080）。
// 不写端口 = 任意端口。三个名单共用同一套语法。

const LABEL = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$/;
const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** WHATWG 规范化的 IPv6 文本（小写、压缩）；不是合法 IPv6 返回 null。 */
function v6Canon(h: string): string | null {
	if (!h.includes(":")) return null;
	try {
		const u = new URL(`http://[${h}]`).hostname;
		return u.slice(1, -1);
	} catch {
		return null;
	}
}
/** 条目/地址里的主机文本规范化：IPv6 走规范形式，其余小写。 */
export function normalizeHostText(h: string): string {
	const s = h.trim().toLowerCase().replace(/^\[|\]$/g, "");
	return v6Canon(s) ?? s;
}

/**
 * 云元数据服务地址与名称：界面里配置的「内网例外」不能放行它们（只有运维环境变量保持原有的放行能力）。
 * 整个 169.254.0.0/16（链路本地，含 AWS/GCP/Azure 的 169.254.169.254 与 ECS 的 169.254.170.2）一并视为元数据网段。
 */
export const METADATA_NAMES: ReadonlySet<string> = new Set(["metadata.google.internal"]);
const METADATA_ADDRS = new Set(["100.100.100.200", "192.0.0.192", "fd00:ec2::254", "::ffff:a9fe:a9fe"]);
export function isMetadataLiteral(host: string): boolean {
	const h = normalizeHostText(host);
	return METADATA_NAMES.has(h) || METADATA_ADDRS.has(h) || h.startsWith("169.254.");
}

export interface SplitEntry {
	readonly host: string;
	readonly port?: string;
}
/** 把条目拆成主机与端口；格式不对返回 null（不做合法性检查）。 */
export function splitEntry(raw: string): SplitEntry | null {
	const s = raw.trim().toLowerCase();
	if (!s) return null;
	const br = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
	if (br) return { host: normalizeHostText(br[1]!), ...(br[2] ? { port: br[2] } : {}) };
	if (v6Canon(s)) return { host: normalizeHostText(s) }; // 不带方括号的 IPv6 字面量：整体是主机
	const i = s.lastIndexOf(":");
	if (i < 0) return { host: s };
	if (s.indexOf(":") !== i) return null;
	return { host: s.slice(0, i), ...(s.slice(i + 1) ? { port: s.slice(i + 1) } : {}) };
}

export type EntryResult = { readonly ok: true; readonly entry: string } | { readonly ok: false; readonly error: string };

/** 校验并规范化一条名单条目。可以直接粘贴网址（会取出主机和端口）。 */
export function parseNetEntry(raw: string, kind: NetListKind): EntryResult {
	let s = raw.trim().toLowerCase();
	if (!s) return { ok: false, error: "不能为空" };
	if (s.includes("://")) {
		try {
			const u = new URL(s);
			if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "只支持 http / https 网址" };
			s = u.port ? `${u.hostname}:${u.port}` : u.hostname;
		} catch {
			return { ok: false, error: "网址格式不对" };
		}
	}
	if (s.length > 260) return { ok: false, error: "太长了" };
	if (/[\s/?#@\\]/.test(s)) return { ok: false, error: "只写域名或 IP（可带端口），不要带路径或空格" };
	const sp = splitEntry(s);
	if (!sp) return { ok: false, error: "格式不对，应为 域名、*.域名、IP，或 域名:端口" };
	const { host, port } = sp;
	if (port !== undefined && !(/^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) return { ok: false, error: "端口应为 1–65535" };
	if (host.startsWith("*")) {
		if (!host.startsWith("*.") || host.length <= 2) return { ok: false, error: "通配符只能写成 *.example.com（匹配所有子域名）" };
		const rest = host.slice(2);
		if (rest.includes("*")) return { ok: false, error: "通配符只能出现在最前面" };
		if (!rest.split(".").every((l) => LABEL.test(l))) return { ok: false, error: "域名里只能有英文字母、数字、连字符；中文域名请写 xn-- 形式" };
	} else if (!(V4.test(host) || v6Canon(host))) {
		if (host.length > 253 || !host.split(".").every((l) => LABEL.test(l))) return { ok: false, error: "域名里只能有英文字母、数字、连字符；中文域名请写 xn-- 形式" };
	}
	if (kind === "internal" && isMetadataLiteral(host)) return { ok: false, error: "云元数据地址始终被拦截，不能加入内网例外" };
	const shown = host.includes(":") ? (port ? `[${host}]:${port}` : host) : port ? `${host}:${port}` : host;
	return { ok: true, entry: shown };
}

/** 一条条目（宽松解析：环境变量里的历史写法也能用）是否匹配主机:端口。 */
export function matchNetEntry(entry: string, host: string, port?: string): boolean {
	const e = splitEntry(entry);
	if (!e) return false;
	if (e.port !== undefined && e.port !== port) return false;
	const h = normalizeHostText(host);
	if (e.host.startsWith("*.")) return h.endsWith(e.host.slice(1)) && h.length > e.host.length - 1;
	return e.host === h;
}
export function matchAnyNet(list: readonly string[], host: string, port?: string): boolean {
	return list.some((e) => matchNetEntry(e, host, port));
}
/** 返回命中的第一条条目（给「为什么」用）。 */
export function findNetMatch(list: readonly string[], host: string, port?: string): string | undefined {
	return list.find((e) => matchNetEntry(e, host, port));
}

/** 校验整份策略（保存与「测试网址」共用）：规范化、去重、限制数量。 */
export function normalizeNetPolicy(input: unknown): { ok: true; policy: NetPolicyDTO } | { ok: false; error: string } {
	if (!input || typeof input !== "object") return { ok: false, error: "策略格式不对" };
	const o = input as Record<string, unknown>;
	if (o.mode !== "open" && o.mode !== "allowlist") return { ok: false, error: "外网访问模式只能是 open（全部公网允许）或 allowlist（仅允许名单内域名）" };
	const lists: Record<NetListKind, string[]> = { allow: [], block: [], internal: [] };
	for (const kind of ["allow", "block", "internal"] as const) {
		const raw = o[kind] ?? [];
		if (!Array.isArray(raw)) return { ok: false, error: `${NET_LIST_LABEL[kind]}应为列表` };
		if (raw.length > NET_LIST_MAX) return { ok: false, error: `${NET_LIST_LABEL[kind]}最多 ${NET_LIST_MAX} 条` };
		const seen = new Set<string>();
		for (const item of raw) {
			if (typeof item !== "string") return { ok: false, error: `${NET_LIST_LABEL[kind]}里有不是文本的条目` };
			const r = parseNetEntry(item, kind);
			if (!r.ok) return { ok: false, error: `${NET_LIST_LABEL[kind]}「${item.slice(0, 80)}」：${r.error}` };
			if (!seen.has(r.entry)) (seen.add(r.entry), lists[kind].push(r.entry));
		}
	}
	return { ok: true, policy: { mode: o.mode, ...lists } };
}
