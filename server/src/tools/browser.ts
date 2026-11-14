// Server-side browser tool (M11): open a URL in headless Chromium (Playwright), extract text, optionally save a screenshot
// as a file version. Every request the page makes (navigation, redirects, subresources) passes the URL policy, so pages
// cannot reach loopback/private/metadata addresses unless the operator allowlisted them, and the organisation's network policy applies.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, win32 } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { bool, int, obj, opt, str } from "@earendil-works/pi-schema";
import type { AppContext, FileVersionRef, Principal, Space } from "../core/contracts.ts";
import { HttpError } from "../core/http.ts";
import { runtimeActorResolver, toolCallKey, type ActorResolver } from "../files/actor.ts";
import type { Files } from "../files/service.ts";
import type { BrowseResultDTO } from "../../../shared/files.ts";
import type { ToolCallLog } from "./calls.ts";
import { checkUrl, pinnedRequest } from "./netpolicy.ts";
import { requirePermission } from "./sandbox/perm.ts";

const MAX_RESPONSE = 25 * 1024 * 1024;

/**
 * Network guard for a browser context: Chromium never resolves or connects by itself. Every HTTP(S) request (navigation,
 * redirect hop, subresource, fetch/XHR) is re-issued by the server through `pinnedRequest`: URL policy check, then a socket
 * to the validated IP (pinned per origin for the context's lifetime, so a later DNS answer cannot rebind it), and the
 * response is fulfilled back into the page. WebSockets and other schemes are refused.
 */
export async function guardContext(context: any, blocked: string[], pins: Map<string, string> = new Map(), orgId?: string): Promise<Map<string, string>> {
	await context.route("**/*", async (route: any) => {
		const req = route.request();
		const u: string = req.url();
		if (u.startsWith("data:") || u.startsWith("blob:") || u === "about:blank") return route.continue();
		let origin = u;
		try {
			origin = new URL(u).origin;
		} catch {
			/* invalid → blocked below */
		}
		try {
			const headers: Record<string, string> = { ...(await req.allHeaders()) };
			for (const h of Object.keys(headers)) if (h.startsWith(":")) delete headers[h];
			headers["accept-encoding"] = "identity";
			const res = await pinnedRequest(u, { method: req.method(), headers, body: req.postDataBuffer() ?? undefined, pinned: pins.get(origin), orgId });
			pins.set(origin, res.address);
			const chunks: Buffer[] = [];
			let size = 0;
			for await (const c of res.body) {
				size += (c as Buffer).length;
				if (size > MAX_RESPONSE) throw new Error("response too large");
				chunks.push(c as Buffer);
			}
			const out: Record<string, string> = {};
			for (const [k, v] of Object.entries(res.headers)) if (v !== undefined && k !== "content-length" && k !== "transfer-encoding" && k !== "connection") out[k] = Array.isArray(v) ? v.join(k === "set-cookie" ? "\n" : ", ") : String(v);
			return route.fulfill({ status: res.status, headers: out, body: Buffer.concat(chunks) });
		} catch {
			blocked.push(u.slice(0, 200));
			return route.abort("blockedbyclient").catch(() => {});
		}
	});
	await context.routeWebSocket?.(/.*/, (ws: any) => ws.close({ code: 1008, reason: "blocked by policy" }));
	return pins;
}

type Browser = { newContext(o?: unknown): Promise<any>; close(): Promise<void>; isConnected(): boolean };
type Chromium = { launch(o?: unknown): Promise<Browser>; executablePath?(): string };

/** Directories where a globally installed `playwright` / `playwright-core` may live (Windows: %APPDATA%\npm\node_modules; nvm-windows; Homebrew; Linux). */
export function playwrightSearchRoots(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
	const j = platform === "win32" ? win32.join : posix.join;
	const roots = [
		env.WORKROOM_PLAYWRIGHT_ROOT,
		env.APPDATA ? j(env.APPDATA, "npm", "node_modules") : undefined,
		env.NPM_CONFIG_PREFIX ? j(env.NPM_CONFIG_PREFIX, platform === "win32" ? "node_modules" : "lib/node_modules") : undefined,
		j(dirname(process.execPath), "node_modules"),
		j(dirname(process.execPath), "..", "lib", "node_modules"),
		"/usr/local/lib/node_modules",
		"/usr/lib/node_modules",
		"/opt/homebrew/lib/node_modules",
		"/opt/node-tools/node_modules",
	];
	return [...new Set(roots.filter(Boolean) as string[])];
}

/** Explicit override, then the project's own install, then global installs. `playwright-core` (no bundled browsers) works with a system Chrome/Edge. */
function playwrightCandidates(): string[] {
	const roots = playwrightSearchRoots();
	return [process.env.WORKROOM_PLAYWRIGHT_PATH, "playwright", ...roots.map((r) => join(r, "playwright")), "playwright-core", ...roots.map((r) => join(r, "playwright-core"))].filter(Boolean) as string[];
}

function loadPlaywright(): { chromium: Chromium } | null {
	const req = createRequire(import.meta.url);
	for (const id of playwrightCandidates()) {
		try {
			return req(id);
		} catch {
			/* next */
		}
	}
	return null;
}

/** Installed Chrome / Edge / Chromium to use when Playwright's own Chromium download is absent (always true for Edge on Windows 10/11). */
export function systemBrowserCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
	if (env.WORKROOM_CHROME_PATH) return [env.WORKROOM_CHROME_PATH];
	if (platform === "win32") {
		const bases = [env["ProgramFiles(x86)"], env.ProgramFiles, env.ProgramW6432, env.LOCALAPPDATA].filter(Boolean) as string[];
		return bases.flatMap((b) => [win32.join(b, "Microsoft", "Edge", "Application", "msedge.exe"), win32.join(b, "Google", "Chrome", "Application", "chrome.exe"), win32.join(b, "Chromium", "Application", "chrome.exe")]);
	}
	if (platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
	return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/snap/bin/chromium"];
}

/** What a launch would use: Playwright's bundled Chromium if present, else a system browser. */
function browserPlan(pw: { chromium: Chromium }): { launches: ({ executablePath?: string })[]; label: string } {
	const launches: { executablePath?: string }[] = [];
	let label = "";
	try {
		const bundled = pw.chromium.executablePath?.();
		if (bundled && existsSync(bundled)) (launches.push({}), (label = "Chromium (Playwright)"));
	} catch {
		/* no bundled browser */
	}
	for (const p of systemBrowserCandidates()) if (existsSync(p)) (launches.push({ executablePath: p }), (label ||= `系统浏览器 ${p}`));
	return { launches, label };
}

export class BrowserService {
	readonly #ctx: AppContext;
	#browser: Promise<Browser> | null = null;
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}
	available(): { ok: boolean; detail: string } {
		const pw = loadPlaywright();
		if (!pw) return { ok: false, detail: "服务器未安装 Playwright（运行 npm i playwright-core，并安装 Chrome 或 Edge；或 npm i -g playwright && npx playwright install chromium）" };
		const plan = browserPlan(pw);
		return plan.launches.length ? { ok: true, detail: plan.label } : { ok: false, detail: "找不到可用的浏览器：请安装 Chrome / Edge，或运行 npx playwright install chromium，或用 WORKROOM_CHROME_PATH 指定浏览器可执行文件" };
	}
	async #get(): Promise<Browser> {
		if (this.#browser) {
			const b = await this.#browser.catch(() => null);
			if (b?.isConnected()) return b;
		}
		const pw = loadPlaywright();
		const av = this.available();
		if (!pw || !av.ok) throw new HttpError(503, "browser_unavailable", av.detail);
		this.#browser = (async () => {
			let last: unknown;
			for (const o of browserPlan(pw).launches) {
				try {
					return await pw.chromium.launch(o);
				} catch (e) {
					last = e;
				}
			}
			throw new HttpError(503, "browser_unavailable", `浏览器启动失败：${String((last as Error)?.message ?? last).split("\n")[0]}`);
		})();
		this.#browser.catch(() => (this.#browser = null));
		return this.#browser;
	}
	/** Shared Chromium for interactive sessions (each session gets its own guarded context). */
	browserForSessions(): Promise<Browser> {
		return this.#get();
	}
	async stop(): Promise<void> {
		const b = await this.#browser?.catch(() => null);
		this.#browser = null;
		await b?.close().catch(() => {});
	}

	async browse(input: { url: string; screenshot?: boolean; maxChars?: number; principal: Principal; space: Space; save?: { conversationId?: number; taskId?: number; callId?: string; idempotencyKey?: string } }): Promise<BrowseResultDTO & { blocked: string[] }> {
		const orgId = input.principal.orgId;
		const first = await checkUrl(input.url, { orgId });
		const browser = await this.#get();
		const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block", javaScriptEnabled: true, viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
		const blocked: string[] = [];
		try {
			// The address validated above is the one the page connects to (pinned for the origin).
			const pins = await guardContext(context, blocked, new Map([[first.url.origin, first.addresses[0]!]]), orgId);
			const page = await context.newPage();
			const resp = await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
			await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
			const finalUrl = page.url();
			await checkUrl(finalUrl, { pinned: pins.get(new URL(finalUrl).origin), orgId }); // a redirect chain may not end in a blocked address
			const title = await page.title();
			const raw: string = await page.evaluate(() => (document.body ? (document.body as HTMLElement).innerText : ""));
			const max = input.maxChars ?? 20_000;
			const text = raw.length > max ? `${raw.slice(0, max)}\n…（已截断，共 ${raw.length} 字符）` : raw;
			let screenshot: FileVersionRef | undefined;
			if (input.screenshot) {
				const png: Buffer = await page.screenshot({ type: "png", fullPage: false });
				const host = new URL(finalUrl).hostname.replace(/[^a-z0-9.-]/gi, "_");
				screenshot = await (this.#ctx.services.get("files") as unknown as Files).putVersion(input.principal, {
					name: `网页截图-${host}.png`,
					mime: "image/png",
					bytes: new Uint8Array(png),
					idempotencyKey: input.save?.idempotencyKey,
					provenance: { createdBy: input.principal.userId, spaceId: input.space.id, conversationId: input.save?.conversationId, taskId: input.save?.taskId, callId: input.save?.callId, changeNote: `截图：${finalUrl}`, origin: "agent", tool: "browse" } as any,
				});
			}
			return { url: input.url, finalUrl, title, text, status: resp?.status(), screenshot, blocked };
		} finally {
			await context.close().catch(() => {});
		}
	}
}

export function createBrowserExtension(ctx: AppContext, opts: { resolveActor?: ActorResolver } = {}) {
	const resolve = opts.resolveActor ?? runtimeActorResolver(ctx);
	const browse = defineTool({
		name: "browse",
		description: "一次性读取公开网页：返回标题和可见文本，可选保存截图（中间文件，不会自动交付）。内网地址被拦截；需要点击、填表等交互用 browser_open / browser_act。",
		parameters: obj({ url: str(), screenshot: opt(bool()), maxChars: opt(int({ minimum: 500, maximum: 100000 })) }),
		// GET of a page is safe to repeat; the screenshot write is idempotent per tool call.
		replay: "safe",
		async execute(args, api, context: Context) {
			const actor = await resolve(api, context);
			const r = await (ctx.services.get("toolCalls") as ToolCallLog).around({ tool: "browse", actor, args }, async () => {
				await requirePermission(ctx, actor.principal, "sandbox.browser");
				if (args.screenshot) await ctx.services.get("acl").require(actor.principal, "write", { kind: "space", id: actor.space.id });
				return (ctx.services.get("browser") as BrowserService).browse({ url: args.url, screenshot: args.screenshot, maxChars: args.maxChars, principal: actor.principal, space: actor.space, save: { conversationId: actor.conversationId, taskId: actor.taskId, callId: actor.callId, idempotencyKey: toolCallKey(actor, "screenshot") } });
			}, (x) => `${x.status} ${x.finalUrl}`);
			const text = `# ${r.title || "(无标题)"}\nURL: ${r.finalUrl}${r.status ? `（HTTP ${r.status}）` : ""}${r.blocked.length ? `\n已拦截 ${r.blocked.length} 个内网/禁止的请求` : ""}${r.screenshot ? `\n截图已保存为中间文件（未交付给用户）：${r.screenshot.name}` : ""}\n\n${r.text}`;
			return { output: [{ type: "text", text }], details: { url: r.url, finalUrl: r.finalUrl, title: r.title, status: r.status ?? null, ...(r.screenshot ? { screenshot: { ...r.screenshot }, artifact: { ...r.screenshot } } : {}) } };
		},
	});
	return defineExtension({ name: "wr.browser", tools: [browse] });
}
