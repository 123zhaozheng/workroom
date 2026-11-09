// Server-side browser tool (M11): open a URL in headless Chromium (Playwright), extract text, optionally save a screenshot
// as a file version. Every request the page makes (navigation, redirects, subresources) passes the URL policy, so pages
// cannot reach loopback/private/metadata addresses unless the operator allowlisted them.
import { createRequire } from "node:module";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { bool, int, obj, opt, str } from "@earendil-works/pi-schema";
import type { AppContext, FileVersionRef, Principal, Space } from "../core/contracts.ts";
import { HttpError } from "../core/http.ts";
import { runtimeActorResolver, toolCallKey, type ActorResolver } from "../files/actor.ts";
import type { Files } from "../files/service.ts";
import type { BrowseResultDTO } from "../../../shared/files.ts";
import type { ToolCallLog } from "./calls.ts";
import { checkUrl } from "./netpolicy.ts";

type Browser = { newContext(o?: unknown): Promise<any>; close(): Promise<void>; isConnected(): boolean };

function loadPlaywright(): { chromium: { launch(o?: unknown): Promise<Browser> } } | null {
	const req = createRequire(import.meta.url);
	for (const id of [process.env.WORKROOM_PLAYWRIGHT_PATH, "playwright", "/opt/node-tools/node_modules/playwright", "playwright-core"]) {
		if (!id) continue;
		try {
			return req(id);
		} catch {
			/* next */
		}
	}
	return null;
}

export class BrowserService {
	readonly #ctx: AppContext;
	#browser: Promise<Browser> | null = null;
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}
	available(): { ok: boolean; detail: string } {
		return loadPlaywright() ? { ok: true, detail: "Chromium (Playwright)" } : { ok: false, detail: "服务器未安装 Playwright/Chromium" };
	}
	async #get(): Promise<Browser> {
		if (this.#browser) {
			const b = await this.#browser.catch(() => null);
			if (b?.isConnected()) return b;
		}
		const pw = loadPlaywright();
		if (!pw) throw new HttpError(503, "browser_unavailable", "服务器未安装 Playwright/Chromium");
		this.#browser = pw.chromium.launch();
		return this.#browser;
	}
	async stop(): Promise<void> {
		const b = await this.#browser?.catch(() => null);
		this.#browser = null;
		await b?.close().catch(() => {});
	}

	async browse(input: { url: string; screenshot?: boolean; maxChars?: number; principal: Principal; space: Space; save?: { conversationId?: number; taskId?: number; callId?: string; idempotencyKey?: string } }): Promise<BrowseResultDTO & { blocked: string[] }> {
		await checkUrl(input.url);
		const browser = await this.#get();
		const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block", javaScriptEnabled: true, viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
		const blocked: string[] = [];
		const verdicts = new Map<string, boolean>();
		try {
			await context.route("**/*", async (route: any) => {
				const u = route.request().url();
				if (u.startsWith("data:") || u.startsWith("blob:") || u === "about:blank") return route.continue();
				const key = (() => {
					try {
						const x = new URL(u);
						return `${x.protocol}//${x.host}`;
					} catch {
						return u;
					}
				})();
				let ok = verdicts.get(key);
				if (ok === undefined) {
					ok = await checkUrl(u).then(() => true, () => false);
					verdicts.set(key, ok);
				}
				if (ok) return route.continue();
				blocked.push(u.slice(0, 200));
				return route.abort("blockedbyclient");
			});
			const page = await context.newPage();
			const resp = await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
			await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
			const finalUrl = page.url();
			await checkUrl(finalUrl); // a redirect chain may not end in a blocked address
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
		description: "Open a public web page in a server-side headless browser and return its title and visible text; optionally save a screenshot to the file library. Private/internal addresses are blocked.",
		parameters: obj({ url: str(), screenshot: opt(bool()), maxChars: opt(int({ minimum: 500, maximum: 100000 })) }),
		// GET of a page is safe to repeat; the screenshot write is idempotent per tool call.
		replay: "safe",
		async execute(args, api, context: Context) {
			const actor = await resolve(api, context);
			const r = await (ctx.services.get("toolCalls") as ToolCallLog).around({ tool: "browse", actor, args }, async () => {
				if (args.screenshot) await ctx.services.get("acl").require(actor.principal, "write", { kind: "space", id: actor.space.id });
				return (ctx.services.get("browser") as BrowserService).browse({ url: args.url, screenshot: args.screenshot, maxChars: args.maxChars, principal: actor.principal, space: actor.space, save: { conversationId: actor.conversationId, taskId: actor.taskId, callId: actor.callId, idempotencyKey: toolCallKey(actor, "screenshot") } });
			}, (x) => `${x.status} ${x.finalUrl}`);
			const text = `# ${r.title || "(无标题)"}\nURL: ${r.finalUrl}${r.status ? `（HTTP ${r.status}）` : ""}${r.blocked.length ? `\n已拦截 ${r.blocked.length} 个内网/禁止的请求` : ""}${r.screenshot ? `\n截图已保存：${r.screenshot.name}（versionId=${r.screenshot.versionId}）` : ""}\n\n${r.text}`;
			return { output: [{ type: "text", text }], details: { url: r.url, finalUrl: r.finalUrl, title: r.title, status: r.status ?? null, ...(r.screenshot ? { screenshot: { ...r.screenshot }, artifact: { ...r.screenshot } } : {}) } };
		},
	});
	return defineExtension({ name: "wr.browser", tools: [browse] });
}
