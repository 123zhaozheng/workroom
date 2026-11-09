// Test support for group E tests (faux-backed channels, direct pi-durable harness over the gateway).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type Extension } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AppContext } from "../core/contracts.ts";
import type { Gateway } from "./gateway.ts";

export interface TestAppLike {
	app: { ctx: AppContext; modules: readonly { extensions?(ctx: AppContext): Extension[] }[] };
	json<T = any>(method: string, path: string, opts?: { token?: string; json?: unknown; expect?: number }): Promise<T>;
}

export interface FauxChannelSpec {
	name: string;
	responses: FauxResponseStep[];
	upstreamModelId?: string;
	input?: ("text" | "image")[];
	priority?: number;
	weight?: number;
	rpmLimit?: number;
	concurrencyLimit?: number;
	capabilities?: string[];
	price?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export const PRICE = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

/** Create an org platform model routed to N faux-backed channels through the admin API. */
export async function fauxModel(t: TestAppLike, adminToken: string, specs: FauxChannelSpec[], model: { label?: string; capabilities?: string[] } = {}) {
	const gw = t.app.ctx.services.get("models") as unknown as Gateway;
	const { model: pm } = await t.json("POST", "/api/admin/models", { token: adminToken, json: { label: model.label ?? "Team Model", capabilities: model.capabilities ?? ["text", "image", "tools"] } });
	const channels: any[] = [];
	const fauxes = [];
	for (const [i, s] of specs.entries()) {
		const { channel } = await t.json("POST", "/api/admin/channels", { token: adminToken, json: { name: s.name, provider: "faux", price: s.price ?? PRICE, rpmLimit: s.rpmLimit, concurrencyLimit: s.concurrencyLimit } });
		const upstream = s.upstreamModelId ?? `${s.name}-model`;
		const faux = fauxProvider({ provider: `up-${s.name}`, api: `faux-${s.name}`, models: [{ id: upstream, input: s.input ?? ["text", "image"] }] });
		faux.setResponses(s.responses);
		gw.attachProvider(channel.id, faux.provider);
		await t.json("POST", `/api/admin/models/${pm.id}/routes`, { token: adminToken, json: { channelId: channel.id, upstreamModelId: upstream, priority: s.priority ?? i, weight: s.weight ?? 1, ...(s.capabilities ? { capabilities: s.capabilities } : {}) } });
		channels.push(channel);
		fauxes.push(faux);
	}
	gw.invalidate();
	return { pm, channels, fauxes, gw };
}

/** A pi-durable Harness on its own storage that uses the gateway's Models and E's extension (no runtime module needed). */
export async function directHarness(t: TestAppLike, spaceId: string, opts: { extensions?: Extension[]; retries?: number } = {}) {
	const ctx = t.app.ctx;
	const registry = createRegistry();
	for (const m of t.app.modules) if ((m as any).name === "ops") for (const e of m.extensions?.(ctx) ?? []) registry.install(e);
	for (const e of opts.extensions ?? []) registry.install(e);
	const dir = mkdtempSync(join(tmpdir(), "wr-e-harness-"));
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(dir, "durable.sqlite")),
		{ models: (ctx.services.get("models") as unknown as Gateway).piModels(), registry, settings: { stream: { metadata: { wrSpaceId: spaceId } }, retry: { maxRetries: opts.retries ?? 0, baseDelayMs: 1 } } },
		BACKGROUND_CONTEXT,
	);
	return { harness, dir, close: () => harness.close(BACKGROUND_CONTEXT) };
}
