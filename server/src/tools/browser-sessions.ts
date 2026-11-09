// Interactive browser sessions (M11-B): one live Chromium page per conversation, driven by the agent (tools) or taken over by
// a space member through the API. Every action refreshes a screenshot (version++). Same network guard as `browse` (URL
// policy + DNS-pinned server-side requests). Viewers (space read) can watch; members with write access can act and take
// over. Sessions live in the owning process's memory: they are closed when idle and do not survive a restart.
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { AppContext, Principal } from "../core/contracts.ts";
import { HttpError, newId, nowIso } from "../core/http.ts";
import type { BrowserActionRequest, BrowserSessionDTO } from "../../../shared/files.ts";
import { runtimeActorResolver, type ActorResolver } from "../files/actor.ts";
import { guardContext, type BrowserService } from "./browser.ts";
import type { ToolCallLog } from "./calls.ts";
import { checkUrl } from "./netpolicy.ts";
import { requirePermission } from "./sandbox/perm.ts";

const VIEWPORT = { width: 1280, height: 800 };
export const SESSION_IDLE_MS = Number(process.env.WORKROOM_BROWSER_IDLE_MS ?? 15 * 60_000);
const MAX_SESSIONS = Number(process.env.WORKROOM_BROWSER_MAX_SESSIONS ?? 20);

interface Session {
	id: string;
	spaceId: string;
	conversationId: number;
	createdBy: string;
	context: any;
	page: any;
	pins: Map<string, string>;
	blocked: string[];
	controller: { kind: "agent" } | { kind: "user"; userId: string; name?: string };
	version: number;
	shot: Buffer;
	url: string;
	title: string;
	lastAction?: string;
	createdAt: string;
	updatedAt: string;
	lastUsed: number;
	queue: Promise<unknown>;
}

export class BrowserSessions {
	readonly #ctx: AppContext;
	readonly #sessions = new Map<string, Session>();
	#timer: NodeJS.Timeout | undefined;
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}
	start(): void {
		this.#timer = setInterval(() => void this.reap(), 60_000);
		this.#timer.unref();
	}
	async stop(): Promise<void> {
		clearInterval(this.#timer);
		for (const id of [...this.#sessions.keys()]) await this.close(id);
	}
	async reap(now = Date.now()): Promise<number> {
		let n = 0;
		for (const s of [...this.#sessions.values()]) if (now - s.lastUsed > SESSION_IDLE_MS) (await this.close(s.id), n++);
		return n;
	}

	dto(s: Session, canControl?: boolean): BrowserSessionDTO {
		return {
			id: s.id,
			spaceId: s.spaceId,
			conversationId: s.conversationId,
			url: s.url,
			title: s.title,
			controller: s.controller,
			viewport: VIEWPORT,
			version: s.version,
			screenshotUrl: `/browser-sessions/${s.id}/screenshot`,
			lastAction: s.lastAction,
			blockedRequests: s.blocked.length,
			createdBy: s.createdBy,
			createdAt: s.createdAt,
			updatedAt: s.updatedAt,
			expiresAt: new Date(s.lastUsed + SESSION_IDLE_MS).toISOString(),
			canControl,
		};
	}
	get(id: string): Session | undefined {
		return this.#sessions.get(id);
	}
	forConversation(spaceId: string, conversationId: number): BrowserSessionDTO[] {
		return [...this.#sessions.values()].filter((s) => s.spaceId === spaceId && s.conversationId === conversationId).map((s) => this.dto(s));
	}
	list(spaceIds: readonly string[], conversationId?: number): Session[] {
		return [...this.#sessions.values()].filter((s) => spaceIds.includes(s.spaceId) && (conversationId === undefined || s.conversationId === conversationId));
	}
	screenshot(id: string): Buffer {
		const s = this.#sessions.get(id);
		if (!s) throw new HttpError(404, "not_found", "浏览会话不存在或已关闭");
		s.lastUsed = Date.now();
		return s.shot;
	}

	async #serial<T>(s: Session, fn: () => Promise<T>): Promise<T> {
		const run = s.queue.then(fn, fn);
		s.queue = run.catch(() => {});
		return run;
	}
	async #refresh(s: Session, action: string): Promise<void> {
		await s.page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
		await s.page.waitForLoadState("networkidle", { timeout: 1_500 }).catch(() => {});
		s.url = s.page.url();
		s.title = await s.page.title().catch(() => "");
		s.shot = await s.page.screenshot({ type: "png" });
		s.version++;
		s.lastAction = action;
		s.updatedAt = nowIso();
		s.lastUsed = Date.now();
	}

	/** Open (or reuse) the conversation's session and navigate to `url`. */
	async open(p: Principal, spaceId: string, conversationId: number, url: string, by: "agent" | "user"): Promise<Session> {
		await requirePermission(this.#ctx, p, "sandbox.browser");
		const existing = [...this.#sessions.values()].find((s) => s.spaceId === spaceId && s.conversationId === conversationId);
		if (existing) {
			await this.act(p, existing.id, { type: "navigate", url }, by);
			return existing;
		}
		if (this.#sessions.size >= MAX_SESSIONS) throw new HttpError(429, "too_many_sessions", "服务器上的浏览会话已达上限，请先关闭不用的会话");
		const first = await checkUrl(url);
		const browser = await (this.#ctx.services.get("browser") as BrowserService).browserForSessions();
		const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block", viewport: VIEWPORT, locale: "zh-CN" });
		const blocked: string[] = [];
		const pins = await guardContext(context, blocked, new Map([[first.url.origin, first.addresses[0]!]]));
		const page = await context.newPage();
		page.on("dialog", (d: any) => d.dismiss().catch(() => {}));
		// One tab per session: popups are closed and their URL opened in the main page (still through the guard).
		context.on("page", (pg: any) => {
			if (pg === page) return;
			const target = pg.url();
			void pg.close().catch(() => {});
			if (/^https?:/.test(target)) void page.goto(target).catch(() => {});
		});
		const now = nowIso();
		const s: Session = { id: newId("bs"), spaceId, conversationId, createdBy: p.userId, context, page, pins, blocked, controller: by === "user" ? { kind: "user", userId: p.userId, name: p.displayName } : { kind: "agent" }, version: 0, shot: Buffer.alloc(0), url, title: "", createdAt: now, updatedAt: now, lastUsed: Date.now(), queue: Promise.resolve() };
		this.#sessions.set(s.id, s);
		try {
			await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
		} catch (e: any) {
			s.lastAction = `打开失败：${String(e?.message ?? e).split("\n")[0]}`;
		}
		await this.#refresh(s, `打开 ${url}`);
		return s;
	}

	async act(p: Principal, id: string, a: BrowserActionRequest, by: "agent" | "user"): Promise<Session> {
		await requirePermission(this.#ctx, p, "sandbox.browser");
		const s = this.#sessions.get(id);
		if (!s) throw new HttpError(404, "not_found", "浏览会话不存在或已关闭");
		if (by === "agent" && s.controller.kind === "user") throw new HttpError(409, "taken_over", `用户 ${s.controller.name ?? s.controller.userId} 正在接管该浏览器，Agent 暂不能操作`);
		if (by === "user" && !(s.controller.kind === "user" && s.controller.userId === p.userId)) throw new HttpError(409, "not_controller", "请先接管该浏览器再操作");
		return this.#serial(s, async () => {
			const page = s.page;
			let label: string;
			// Clicks / key presses may start a navigation asynchronously: wait briefly for it before the screenshot.
			const nav = ["click", "press"].includes(a.type) ? page.waitForEvent("framenavigated", { timeout: 1500 }).catch(() => null) : null;
			switch (a.type) {
				case "navigate": {
					if (!a.url) throw new HttpError(400, "invalid", "navigate 需要 url");
					const u = new URL(a.url);
					const c = await checkUrl(a.url, { pinned: s.pins.get(u.origin) });
					if (!s.pins.has(u.origin)) s.pins.set(u.origin, c.addresses[0]!);
					await page.goto(a.url, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch((e: any) => {
						throw new HttpError(502, "navigation_failed", `无法打开页面：${String(e?.message ?? e).split("\n")[0]}`);
					});
					label = `打开 ${a.url}`;
					break;
				}
				case "click": {
					const x = Number(a.x), y = Number(a.y);
					if (!(x >= 0 && x <= VIEWPORT.width && y >= 0 && y <= VIEWPORT.height)) throw new HttpError(400, "invalid", "点击坐标超出视口");
					await page.mouse.click(x, y);
					label = `点击 (${Math.round(x)}, ${Math.round(y)})`;
					break;
				}
				case "type": {
					const text = String(a.text ?? "").slice(0, 2000);
					await page.keyboard.type(text, { delay: 5 });
					label = `输入 ${text.length} 个字符`;
					break;
				}
				case "press": {
					const key = String(a.key ?? "");
					if (!/^[A-Za-z0-9+]{1,30}$/.test(key)) throw new HttpError(400, "invalid", "按键名无效");
					await page.keyboard.press(key);
					label = `按键 ${key}`;
					break;
				}
				case "scroll": {
					const dy = Math.max(-5000, Math.min(5000, Number(a.deltaY ?? 600)));
					await page.mouse.wheel(0, dy);
					label = `滚动 ${dy}`;
					break;
				}
				case "back":
					await page.goBack({ timeout: 10_000 }).catch(() => {});
					label = "后退";
					break;
				case "forward":
					await page.goForward({ timeout: 10_000 }).catch(() => {});
					label = "前进";
					break;
				case "reload":
					await page.reload({ timeout: 10_000 }).catch(() => {});
					label = "刷新";
					break;
				default:
					throw new HttpError(400, "invalid", "未知操作");
			}
			if (nav) await nav;
			await this.#refresh(s, `${by === "user" ? "用户" : "Agent"}：${label}`);
			return s;
		});
	}

	takeover(p: Principal, id: string): Session {
		const s = this.#sessions.get(id);
		if (!s) throw new HttpError(404, "not_found", "浏览会话不存在或已关闭");
		s.controller = { kind: "user", userId: p.userId, name: p.displayName };
		s.lastAction = `${p.displayName} 接管了浏览器`;
		s.updatedAt = nowIso();
		s.lastUsed = Date.now();
		return s;
	}
	release(p: Principal, id: string): Session {
		const s = this.#sessions.get(id);
		if (!s) throw new HttpError(404, "not_found", "浏览会话不存在或已关闭");
		if (s.controller.kind === "user" && s.controller.userId !== p.userId) throw new HttpError(409, "not_controller", "只有当前接管者可以交还控制");
		s.controller = { kind: "agent" };
		s.lastAction = `${p.displayName} 交还给 Agent`;
		s.updatedAt = nowIso();
		return s;
	}
	async close(id: string): Promise<void> {
		const s = this.#sessions.get(id);
		this.#sessions.delete(id);
		await s?.context.close().catch(() => {});
	}
	async text(s: Session, max = 4000): Promise<string> {
		const t: string = await s.page.evaluate(() => (document.body ? (document.body as HTMLElement).innerText : "")).catch(() => "");
		return t.length > max ? `${t.slice(0, max)}…` : t;
	}
}

export function createBrowserSessionExtension(ctx: AppContext, opts: { resolveActor?: ActorResolver } = {}): Extension {
	const resolve = opts.resolveActor ?? runtimeActorResolver(ctx);
	const sessions = () => ctx.services.get("browserSessions") as BrowserSessions;
	const log = () => ctx.services.get("toolCalls") as ToolCallLog;
	const result = async (s: any) => {
		const text = await sessions().text(s);
		return { output: [{ type: "text" as const, text: `# ${s.title || "(无标题)"}\nURL: ${s.url}\n控制者：${s.controller.kind === "agent" ? "Agent" : `用户（${s.controller.name ?? s.controller.userId}）`}；截图版本 v${s.version}${s.blocked.length ? `；已拦截 ${s.blocked.length} 个请求` : ""}\n\n${text}` }], details: { browserSession: JSON.parse(JSON.stringify(sessions().dto(s))) } };
	};
	const withActor = async <T>(tool: string, api: any, args: unknown, context: Context, fn: (a: any) => Promise<T>) => {
		const actor = await resolve(api, context);
		return log().around({ tool, actor, args }, async () => {
			await requirePermission(ctx, actor.principal, "sandbox.browser");
			await ctx.services.get("acl").require(actor.principal, "write", { kind: "space", id: actor.space.id });
			return fn(actor);
		});
	};
	const open = defineTool({
		name: "browser_open",
		description: "Open a page in this conversation's live browser session (the user can watch and take over). Returns title and visible text.",
		parameters: obj({ url: str() }),
		replay: "safe",
		execute: async (args, api, context) => withActor("browser_open", api, args, context, async (a) => result(await sessions().open(a.principal, a.space.id, a.conversationId, args.url, "agent"))),
	});
	const act = defineTool({
		name: "browser_act",
		description: "Act in this conversation's live browser session: click (x,y in the 1280×800 viewport), type text, press a key, scroll, navigate, back/forward/reload. Refused while a user has taken over.",
		parameters: obj({ type: oneOf(["navigate", "click", "type", "press", "scroll", "back", "forward", "reload"]), url: opt(str()), x: opt(int()), y: opt(int()), text: opt(str()), key: opt(str()), deltaY: opt(int()) }),
		// Clicks and typing can submit forms on the remote site: never repeated after a crash.
		replay: "unsafe",
		execute: async (args, api, context) =>
			withActor("browser_act", api, args, context, async (a) => {
				const s = sessions().list([a.space.id], a.conversationId)[0];
				if (!s) throw new HttpError(404, "no_session", "本会话还没有浏览器，请先 browser_open");
				return result(await sessions().act(a.principal, s.id, args as BrowserActionRequest, "agent"));
			}),
	});
	const close = defineTool({
		name: "browser_close",
		description: "Close this conversation's live browser session.",
		parameters: obj({}),
		replay: "safe",
		execute: async (_args, api, context) =>
			withActor("browser_close", api, {}, context, async (a) => {
				for (const s of sessions().list([a.space.id], a.conversationId)) await sessions().close(s.id);
				return { output: [{ type: "text" as const, text: "已关闭浏览器会话" }] };
			}),
	});
	return defineExtension({ name: "wr.browser-session", tools: [open, act, close] });
}
