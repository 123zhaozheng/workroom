// Request side of the credential flow: strict validation of what the agent asks for, the status-only durable doc, and the wait.
//
// Choice (documented in docs/credentials.md): a dedicated `wr.credential-requests` doc, NOT the approvals doc. An approval is "may the agent do
// this dangerous thing" (decline = refuse the action); a credential request is "please type a secret into this form" (decline = I will not
// give it). Mixing them would let one UI path approve or dismiss the other. The doc carries STATUS ONLY (no secret, no nonce); the source of
// truth is the `credential_requests` row, which the browser form talks to over authenticated HTTP.
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { defineDoc, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { CredentialStatusForModel } from "../../../../shared/workspace-safety.ts";
import { instanceAllowlist } from "../../ops/egress.ts";
import { HttpError } from "../../core/http.ts";
import type { CredentialStore, RequestRow, RequestSpec } from "./store.ts";

export const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const TTL_MIN_SEC = 60;
export const TTL_MAX_SEC = 30 * 86400;
const FORBIDDEN_INJECT_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "keep-alive", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate", "proxy-connection", "content-encoding", "expect"]);

const bad = (msg: string) => new HttpError(400, "invalid_credential_request", msg);

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Exact FQDN (>= 2 labels) or a single leading "*." followed by an FQDN (>= 2 labels). IPs only when the instance allowlist names them. */
export function normalizeHostPattern(raw: unknown): string {
	if (typeof raw !== "string") throw bad("targetHosts 的每一项必须是字符串");
	let h = raw.trim().toLowerCase();
	if (!h || h.length > 253) throw bad("目标主机无效");
	if (/[\s/@:?#\\]/.test(h.replace(/^\[|\]$/g, "")) && !isIP(h.replace(/^\[|\]$/g, ""))) throw bad(`目标主机 ${raw.slice(0, 80)} 只能是域名（不含协议、端口、路径）`);
	const wild = h.startsWith("*.");
	if (wild) h = h.slice(2);
	if (h.includes("*")) throw bad("通配符只允许开头的单个 “*.”");
	h = h.replace(/\.$/, "");
	const bare = h.replace(/^\[|\]$/g, "");
	if (isIP(bare)) {
		if (wild) throw bad("IP 地址不能使用通配符");
		const inst = instanceAllowlist();
		if (!inst.allowsIp(bare) && !inst.exactIp(bare)) throw bad(`目标主机 ${bare} 是 IP 地址；只有实例允许列表（WORKROOM_WEBHOOK_ALLOWLIST）列出的 IP 才可使用`);
		return bare;
	}
	const ascii = domainToASCII(h);
	if (!ascii) throw bad(`目标主机 ${raw.slice(0, 80)} 无效`);
	const labels = ascii.split(".");
	if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels[labels.length - 1]!)) throw bad(`目标主机 ${raw.slice(0, 80)} 必须是完整域名（至少两段）`);
	return wild ? `*.${ascii}` : ascii;
}

/** Does `host` (URL hostname, already lowercased/ASCII) match one pattern? A wildcard matches exactly ONE extra label. */
export function hostMatches(pattern: string, host: string): boolean {
	const h = host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
	if (pattern.startsWith("*.")) {
		const base = pattern.slice(2);
		return h.endsWith(`.${base}`) && !h.slice(0, -(base.length + 1)).includes(".") && h.length > base.length + 1;
	}
	return h === pattern;
}

export function validateInject(raw: unknown): { header: string; template: string } {
	if (raw === undefined || raw === null) return { header: "Authorization", template: "Bearer {secret}" };
	if (typeof raw !== "object") throw bad("inject 必须是 { header, template }");
	const o = raw as { header?: unknown; template?: unknown };
	const header = typeof o.header === "string" ? o.header.trim() : "";
	if (!/^[A-Za-z0-9-]{1,64}$/.test(header)) throw bad("inject.header 只能含字母、数字和连字符（最长 64）");
	if (FORBIDDEN_INJECT_HEADERS.has(header.toLowerCase())) throw bad(`inject.header 不能是 ${header}`);
	const template = typeof o.template === "string" ? o.template : "";
	if (template.length === 0 || template.length > 200 || /[\r\n\0]/.test(template) || !/^[\x20-\x7e]+$/.test(template)) throw bad("inject.template 必须是 1-200 个可打印 ASCII 字符");
	if (template.split("{secret}").length !== 2) throw bad("inject.template 必须恰好包含一个 {secret}");
	return { header, template };
}

/** Strict validation of the tool arguments. Everything the model supplied is treated as hostile. */
export function validateRequestArgs(args: Record<string, unknown>, store: CredentialStore): RequestSpec {
	const service = typeof args.service === "string" ? args.service.trim() : "";
	const purpose = typeof args.purpose === "string" ? args.purpose.trim() : "";
	if (!service || service.length > 80 || /[\u0000-\u001f]/.test(service)) throw bad("service 必须是 1-80 个字符的服务名");
	if (!purpose || purpose.length > 300 || /[\u0000-\u0008\u000b-\u001f]/.test(purpose)) throw bad("purpose 必须是 1-300 个字符，说明为什么需要这个凭据");
	const usage = args.usage === undefined ? "proxy" : args.usage;
	if (usage !== "proxy" && usage !== "env") throw bad('usage 必须是 "proxy" 或 "env"');
	const hostsRaw = args.targetHosts === undefined ? [] : args.targetHosts;
	if (!Array.isArray(hostsRaw) || hostsRaw.length > 10) throw bad("targetHosts 必须是最多 10 项的数组");
	const targetHosts = [...new Set(hostsRaw.map(normalizeHostPattern))];
	if (usage === "proxy" && targetHosts.length === 0) throw bad("usage 为 proxy 时 targetHosts 不能为空");
	const methodsRaw = args.methods === undefined ? ["GET"] : args.methods;
	if (!Array.isArray(methodsRaw) || methodsRaw.length === 0) throw bad("methods 必须是非空数组");
	const methods = [...new Set(methodsRaw.map((m) => String(m).toUpperCase()))];
	for (const m of methods) if (!(ALLOWED_METHODS as readonly string[]).includes(m)) throw bad(`methods 只允许 ${ALLOWED_METHODS.join("/")}`);
	const ttlSec = args.ttlSec === undefined ? 3600 : args.ttlSec;
	if (typeof ttlSec !== "number" || !Number.isInteger(ttlSec) || ttlSec < TTL_MIN_SEC || ttlSec > TTL_MAX_SEC) throw bad(`ttlSec 必须是 ${TTL_MIN_SEC} 到 ${TTL_MAX_SEC} 之间的整数（秒）`);
	let envName: string | undefined;
	if (usage === "env") {
		const problem = store.validateEnvName(args.envName as string);
		if (problem) throw bad(problem);
		envName = args.envName as string;
	} else if (args.envName !== undefined) throw bad("envName 只用于 usage 为 env 的请求");
	return { service, purpose, targetHosts, methods, inject: validateInject(args.inject), usage, ...(envName ? { envName } : {}), ttlSec };
}

// ------------------------------------------------------------------ durable status doc (status only)
export interface CredentialRequestStatusItem {
	requestId: string;
	callId: string;
	service: string;
	purpose: string;
	targetHosts: string[];
	usage: string;
	status: string;
	createdAt: string;
	expiresAt: string;
	decidedAt?: string;
	credentialId?: string;
}
/** fork: "initial" — a branch never inherits a pending request (it would be answered into the wrong conversation). */
export const CredentialRequestsDoc = defineDoc<{ items: Record<string, CredentialRequestStatusItem & Record<string, any>> }>({
	kind: "wr.credential-requests",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: {} }),
	checkpointWhen: (_v, _ops, info) => info.deltasSinceBase >= 32,
});

/** Mirror the row's STATUS into the doc (best effort: the DB row is authoritative, a doc failure never blocks the request). */
export async function publishStatus(api: ToolExecutionApi<any>, context: Context, r: RequestRow): Promise<void> {
	const spec = JSON.parse(r.spec) as RequestSpec;
	const item: CredentialRequestStatusItem = { requestId: r.id, callId: r.call_id, service: spec.service, purpose: spec.purpose, targetHosts: spec.targetHosts, usage: spec.usage, status: r.status, createdAt: r.created_at, expiresAt: r.expires_at, ...(r.decided_at ? { decidedAt: r.decided_at } : {}), ...(r.credential_id ? { credentialId: r.credential_id } : {}) };
	try {
		await api.commit(async (tx) => {
			const d = await tx.doc(CredentialRequestsDoc, api.conversationId);
			d.items[r.id] = item;
		}, context);
	} catch (err) {
		console.error("[credentials] status doc write failed", (err as Error)?.message ?? "error");
	}
}

// ------------------------------------------------------------------ wait
export const pollMs = (): number => Number(process.env.WORKROOM_CREDENTIAL_POLL_MS) || 500;

/**
 * Wait until the request leaves "pending" (fulfilled / declined / cancelled / expired / revoked). The authoritative state is the DB row, so this
 * is restart-safe: a replay of the (replay: "safe", idempotent by callId) tool finds the same row and waits again. An aborted run leaves the request pending (see below).
 */
export async function waitForDecision(store: CredentialStore, requestId: string, signal?: AbortSignal): Promise<RequestRow> {
	for (;;) {
		const r = store.request(requestId);
		if (!r) throw new HttpError(404, "request_not_found", "凭据请求不存在");
		const cur = store.expireIfDue(r);
		if (cur.status !== "pending") return cur;
		// An abort can be a user stopping the run OR the server shutting down; the two look the same here. The request is deliberately NOT
		// cancelled: it stays pending (still answerable after a restart, when this replay-safe tool re-attaches) until it expires or the user dismisses it.
		if (signal?.aborted) throw new Error("aborted");
		await new Promise<void>((resolve) => {
			const t = setTimeout(done, pollMs());
			const onAbort = () => done();
			signal?.addEventListener("abort", onAbort, { once: true });
			function done() {
				clearTimeout(t);
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}
		});
	}
}

/** What the model is told: status and ids only. */
export function statusForModel(r: RequestRow): CredentialStatusForModel {
	const msg: Record<RequestRow["status"], string> = {
		pending: "用户尚未处理该凭据请求",
		fulfilled: "用户已提供凭据，你看不到它的值。请用 credential_http 经服务器代理发起请求（凭据由服务器注入）",
		declined: "用户拒绝提供凭据。不要再次索取同一凭据；改用不需要凭据的方式，或告诉用户你需要它才能继续",
		cancelled: "凭据请求已取消",
		expired: "凭据请求已过期，用户没有提供凭据。如仍需要，可以重新发起请求",
		revoked: "该凭据已被撤销，不能再使用",
	};
	return { requestId: r.id, status: r.status, ...(r.credential_id && r.status === "fulfilled" ? { credentialId: r.credential_id } : {}), message: msg[r.status] };
}

