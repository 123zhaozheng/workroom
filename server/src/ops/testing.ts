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
	/** USD per million tokens; faux providers have no real pricing, so this is what usage is costed with. */
	price?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export const PRICE = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

/**
 * Register scripted in-process pi-ai providers (fauxProvider, type "faux" rows) as ORG providers of the admin's org with their model enabled.
 * The first spec is the primary model; the rest become its failover chain (`fallbacks`). `pm` = the primary: `pm.ref` is the native pi ref,
 * `pm.id` its platform id ("<provider>/<modelId>", what /api/models and conversations accept).
 */
export async function fauxModel(t: TestAppLike, adminToken: string, specs: FauxChannelSpec[], model: { label?: string } = {}) {
	const gw = t.app.ctx.services.get("models") as unknown as Gateway;
	const me = (await t.json("GET", "/api/me", { token: adminToken })).me as { orgId: string };
	const now = new Date().toISOString();
	const refs: { provider: string; modelId: string }[] = [];
	const fauxes = [];
	const channels: { id: string; name: string }[] = [];
	for (const s of specs) {
		const upstream = s.upstreamModelId ?? `${s.name}-model`;
		const id = `up-${s.name}`;
		const faux = fauxProvider({ provider: id, api: `faux-${s.name}`, models: [{ id: upstream, input: s.input ?? ["text", "image"], cost: s.price ?? PRICE }] });
		faux.setResponses(s.responses);
		t.app.ctx.db.run("INSERT INTO model_providers (id, scope, org_id, name, type, keyless, status, source, created_at, updated_at) VALUES (?, 'org', ?, ?, 'faux', 1, 'enabled', 'test', ?, ?)", id, me.orgId, s.name, now, now);
		refs.push({ provider: id, modelId: upstream });
		fauxes.push(faux);
		channels.push({ id, name: s.name });
	}
	for (const [i, r] of refs.entries()) {
		const fallbacks = i === 0 && refs.length > 1 ? JSON.stringify(refs.slice(1)) : null;
		t.app.ctx.db.run("INSERT INTO model_entries (provider_id, model_id, manual, spec, enabled, fallbacks, created_at, updated_at) VALUES (?, ?, 0, ?, 1, ?, ?, ?)", r.provider, r.modelId, JSON.stringify({ name: i === 0 ? (model.label ?? "Team Model") : `${specs[i]!.name} model` }), fallbacks, now, now);
	}
	gw.invalidate();
	for (const [i, f] of fauxes.entries()) gw.attachProvider(refs[i]!.provider, f.provider);
	const pm = { id: `${refs[0]!.provider}/${refs[0]!.modelId}`, ref: refs[0]! };
	return { pm, channels, fauxes, gw, refs };
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
