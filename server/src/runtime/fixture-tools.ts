// Test-only tools, installed only when WORKROOM_FIXTURE_TOOLS=1 (never in a normal deployment).
// They exercise the runtime contracts end to end: ToolActor/ACL, approvals, and external effects with receipts.
// Side effects go to <dataDir>/fixture-effects/<key>.count (one line per perform() call) so tests can count them
// across a SIGKILL.
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { bool, num, obj, opt, str } from "@earendil-works/pi-schema";
import type { Effects } from "./effects.ts";
import type { Runtime } from "./service.ts";

export const fixtureToolsEnabled = (): boolean => process.env.WORKROOM_FIXTURE_TOOLS === "1";

function sleep(ms: number, context: Context): Promise<void> {
	return new Promise((resolve, reject) => {
		const signal = context.abortSignal;
		if (signal?.aborted) return reject(new Error("aborted"));
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(t);
			reject(new Error("aborted"));
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

const safeKey = (k: string) => k.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "default";

export function effectCounterPath(dataDir: string, key: string): string {
	return join(dataDir, "fixture-effects", `${safeKey(key)}.count`);
}

export function createFixtureTools(rt: Runtime, effects: Effects): Extension {
	const dataDir = rt.ctx.config.dataDir;
	const text = (s: string) => [{ type: "text" as const, text: s }];

	const echo = defineTool({
		name: "wr_fixture_echo",
		description: "[test tool] Echo text back after re-checking the acting user's current access.",
		parameters: obj({ text: str() }),
		replay: "safe",
		execute: async (args, api, context) => {
			const actor = await rt.actorForTool(api, "", context);
			return { output: text(`echo(${actor.principal.displayName}): ${args.text}`), details: { userId: actor.principal.userId } };
		},
	});

	const wait = defineTool({
		name: "wr_fixture_wait",
		description: "[test tool] Wait for ms milliseconds, then report.",
		parameters: obj({ ms: num() }),
		replay: "safe",
		execute: async (args, api, context) => {
			await rt.actorForTool(api, "", context);
			await sleep(Math.min(Math.max(args.ms, 0), 600_000), context);
			await rt.actorForTool(api, "", context);
			return { output: text(`waited ${args.ms}ms`) };
		},
	});

	const effect = defineTool({
		name: "wr_fixture_effect",
		description: "[test tool] Perform a fake external write through the effects protocol (intent → dispatching → receipt).",
		parameters: obj({ key: str(), holdMs: opt(num()), holdAfterMs: opt(num()), target: opt(str()), unknownOutcome: opt(bool()) }),
		replay: "safe",
		execute: async (args, api, context) => {
			const actor = await rt.actorForTool(api, "", context);
			const outcome = await effects.externalEffect(
				api,
				{ key: args.key, target: args.target ?? "fixture://outbox", summary: `fixture write ${args.key} for ${actor.principal.email}` },
				async (idempotencyKey) => {
					const file = effectCounterPath(dataDir, args.key);
					mkdirSync(join(dataDir, "fixture-effects"), { recursive: true });
					appendFileSync(file, `${idempotencyKey}\n`);
					const fd = openSync(file, "r+");
					fsyncSync(fd);
					closeSync(fd);
					if (args.holdMs) await sleep(args.holdMs, context);
					if (args.unknownOutcome) throw new Error("fixture: target timed out after the request was sent (outcome unknown)");
					return { sent: args.key, idempotencyKey, at: new Date().toISOString() };
				},
				context,
			);
			if (args.holdAfterMs && !(outcome.status === "done" && outcome.replayed)) await sleep(args.holdAfterMs, context);
			const body = outcome.status === "done" ? { status: "done", replayed: outcome.replayed, receipt: outcome.receipt } : { status: outcome.status, effectId: outcome.effectId, detail: outcome.detail };
			return { output: text(JSON.stringify(body)), details: body as any, isError: outcome.status !== "done" };
		},
	});

	const approval = defineTool({
		name: "wr_fixture_approval",
		description: "[test tool] Ask the user to approve an action, then report the decision.",
		parameters: obj({ title: str(), summary: str(), risk: opt(str()) }),
		replay: "safe",
		execute: async (args, api, context) => {
			const decision = await effects.requestApproval(api, { title: args.title, summary: args.summary, risk: (["low", "medium", "high"].includes(args.risk ?? "") ? args.risk : "medium") as "low" | "medium" | "high" }, context);
			return { output: text(`decision: ${decision.decision}${decision.note ? ` (${decision.note})` : ""}`), details: decision as any };
		},
	});

	return defineExtension({ name: "wr-fixture-tools", tools: [echo, wait, effect, approval] });
}
