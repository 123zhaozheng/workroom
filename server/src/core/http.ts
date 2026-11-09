import type { Context as HonoContext, MiddlewareHandler } from "hono";
import type { AppEnv, Principal } from "./contracts.ts";

export class HttpError extends Error {
	readonly status: number;
	readonly code: string;
	readonly detail?: unknown;
	constructor(status: number, code: string, message?: string, detail?: unknown) {
		super(message ?? code);
		this.status = status;
		this.code = code;
		this.detail = detail;
	}
}

export function principalOf(c: HonoContext<AppEnv>): Principal {
	const p = c.get("principal");
	if (!p) throw new HttpError(401, "unauthenticated", "请先登录");
	return p;
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
	principalOf(c);
	await next();
};

export async function jsonBody<T>(c: HonoContext<AppEnv>): Promise<T> {
	try {
		return (await c.req.json()) as T;
	} catch {
		throw new HttpError(400, "bad_json", "请求体不是有效 JSON");
	}
}

export function newId(prefix: string): string {
	// time-sortable id: prefix_<ms base36><random>
	const t = Date.now().toString(36).padStart(9, "0");
	const r = crypto.getRandomValues(new Uint8Array(8));
	return `${prefix}_${t}${Array.from(r, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export const nowIso = (): string => new Date().toISOString();
