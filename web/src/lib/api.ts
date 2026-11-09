// Thin fetch wrapper for the Workroom HTTP API (/api/*, cookie auth).
// An endpoint that the server does not (yet) route is reported as `unavailable` so pages can
// show an honest "未连接" state instead of fake data.

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly detail?: unknown;
	/** True when the route does not exist on this server (module not installed / not built yet) or the server is unreachable. */
	readonly unavailable: boolean;
	constructor(status: number, code: string, message: string, detail?: unknown, unavailable = false) {
		super(message);
		this.status = status;
		this.code = code;
		this.detail = detail;
		this.unavailable = unavailable;
	}
}

type Json = Record<string, unknown> | unknown[];

export interface ApiInit extends Omit<RequestInit, "body"> {
	body?: Json | FormData;
	signal?: AbortSignal;
}

export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
	const headers = new Headers(init.headers);
	let body: BodyInit | undefined;
	if (init.body instanceof FormData) body = init.body;
	else if (init.body !== undefined) {
		headers.set("content-type", "application/json");
		body = JSON.stringify(init.body);
	}
	let res: Response;
	try {
		res = await fetch(`/api${path}`, { ...init, headers, body, credentials: "same-origin" });
	} catch (e) {
		if ((e as Error)?.name === "AbortError") throw e;
		throw new ApiError(0, "network", "无法连接服务器", undefined, true);
	}
	const ct = res.headers.get("content-type") ?? "";
	if (!res.ok) {
		if (ct.includes("application/json")) {
			const j = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; detail?: unknown } } | null;
			const err = j?.error;
			throw new ApiError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? res.statusText, err?.detail, err?.code === "not_implemented");
		}
		// Hono's default notFound / proxy errors are not JSON → route not present on this server.
		const unavailable = res.status === 404 || res.status === 502 || res.status === 503 || res.status === 504;
		throw new ApiError(res.status, unavailable ? "unavailable" : `http_${res.status}`, unavailable ? "该功能的服务端接口尚未连接" : res.statusText, undefined, unavailable);
	}
	if (res.status === 204) return undefined as T;
	if (ct.includes("application/json")) return (await res.json()) as T;
	return (await res.text()) as unknown as T;
}

export const get = <T>(path: string, signal?: AbortSignal) => api<T>(path, { signal });
export const post = <T>(path: string, body?: Json | FormData) => api<T>(path, { method: "POST", body: body ?? {} });
export const put = <T>(path: string, body?: Json) => api<T>(path, { method: "PUT", body: body ?? {} });
export const patch = <T>(path: string, body?: Json) => api<T>(path, { method: "PATCH", body: body ?? {} });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
	const u = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
	const s = u.toString();
	return s ? `?${s}` : "";
}

export function uuid(): string {
	return crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function errorText(e: unknown): string {
	if (e instanceof ApiError) return e.message || e.code;
	if (e instanceof Error) return e.message;
	return String(e);
}
