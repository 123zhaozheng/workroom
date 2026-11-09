// Local rpm / concurrency limits and the circuit breaker (half-open recovery) around native provider streams, ported from the
// former channel-gateway tests (M15-C): limit hit → spills to the model's fallback or is REJECTED with a retryable coded error;
// breaker opens after N failures, half-opens after the window, recovers; failover interaction; billing per actual call.
process.env.WORKROOM_RT_RETRY_MAX ??= "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { startTestApp } from "./helpers/app.ts";
import { directHarness, fauxModel, PRICE } from "../src/ops/testing.ts";
import { waitFor } from "../src/runtime/testing.ts";
import type { Gateway } from "../src/ops/gateway.ts";

const SECRET = "test-secret-key-for-model-limits-0123456789";
const ask = async (conv: any, text: string) => (await (await conv.submit({ type: "input", content: text, requestId: randomUUID() }, ctx)).wait(ctx)).status as string;
const lastAssistant = async (conv: any) => (await conv.entries({ order: "descending" }, 20, undefined, ctx)).items.find((e: any) => e.kind === "pi.assistant")?.model?.[0];
const err = (msg = "500 internal server error") => fauxAssistantMessage([], { stopReason: "error", errorMessage: msg });
const setLimits = (t: any, gw: Gateway, id: string, cols: Record<string, number | null>) => {
	for (const [k, v] of Object.entries(cols)) t.app.ctx.db.run(`UPDATE model_providers SET ${k} = ? WHERE id = ?`, v, id);
	gw.invalidate();
};
async function setup() {
	const t = await startTestApp({ config: { secretKey: SECRET } });
	const a = await t.user("admin@a.example");
	const spaceId = (await t.json("GET", "/api/me", { token: a.token })).personalSpaceId as string;
	return { t, a, spaceId };
}

test("rpm limit: the second request spills to the fallback; without a fallback it is rejected with a coded, retryable error until the minute passes", async () => {
	const { t, a, spaceId } = await setup();
	try {
		const { pm, fauxes, channels, gw } = await fauxModel(t, a.token, [
			{ name: "limited", responses: [fauxAssistantMessage("limited-1"), fauxAssistantMessage("limited-2")] },
			{ name: "spill", responses: [fauxAssistantMessage("spill-1")] },
		]);
		setLimits(t, gw, channels[0]!.id, { rpm_limit: 1 });
		const { harness, close } = await directHarness(t, spaceId);
		try {
			const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: pm.ref } }, ctx);
			assert.equal(await ask(conv, "1"), "done");
			assert.equal(await ask(conv, "2"), "done");
			assert.equal((await lastAssistant(conv)).content[0].text, "spill-1");
			assert.equal(fauxes[0]!.state.callCount, 1);
			assert.equal(fauxes[1]!.state.callCount, 1);
			const sk = t.app.ctx.db.get<any>("SELECT * FROM ops_route_attempts WHERE status = 'skipped' AND error_class = 'local_rate_limit'")!;
			assert.equal(sk.channel_id, channels[0]!.id);
			assert.equal(sk.retryable, 1);
			// no fallback now (primary only, via a second model) → rejected, nothing sent upstream
			const solo = await fauxModel(t, a.token, [{ name: "solo", responses: [fauxAssistantMessage("a"), fauxAssistantMessage("b")] }]);
			setLimits(t, solo.gw, solo.channels[0]!.id, { rpm_limit: 1 });
			const c2 = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: solo.pm.ref } }, ctx);
			assert.equal(await ask(c2, "1"), "done");
			assert.equal(await ask(c2, "2"), "unanswered");
			const m = await lastAssistant(c2);
			assert.match(m.errorMessage, /^local_rate_limit: .*rate limit/);
			assert.equal(solo.fauxes[0]!.state.callCount, 1, "rejected before the upstream");
			// pi-ai's retry classifier treats it as retryable → pi-durable backs off and retries (= queues) instead of failing for good
			const { isRetryableAssistantError } = await import("@earendil-works/pi-ai");
			assert.equal(isRetryableAssistantError(m), true);
			solo.gw.now = () => Date.now() + 61_000;
			assert.equal(await ask(c2, "3"), "done", "window elapsed");
		} finally {
			await close();
		}
	} finally {
		await t.dispose();
	}
});

test("concurrency limit: spills to the fallback while a request is in flight; released afterwards; per-model limit works too", async () => {
	const { t, a, spaceId } = await setup();
	try {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		const { pm, fauxes, channels, gw } = await fauxModel(t, a.token, [
			{ name: "single", responses: [async () => (await gate, fauxAssistantMessage("slow single"))] },
			{ name: "overflow", responses: [fauxAssistantMessage("overflow answer"), fauxAssistantMessage("overflow 2")] },
		]);
		setLimits(t, gw, channels[0]!.id, { concurrency_limit: 1 });
		const { harness, close } = await directHarness(t, spaceId);
		try {
			const c1 = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: pm.ref } }, ctx);
			const c2 = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: pm.ref } }, ctx);
			const s1 = await c1.submit({ type: "input", content: "first", requestId: "c1" }, ctx);
			await waitFor(() => gw.limits.inflight(channels[0]!.id) === 1);
			assert.equal((await (await c2.submit({ type: "input", content: "second", requestId: "c2" }, ctx)).wait(ctx)).status, "done");
			assert.equal((await lastAssistant(c2)).content[0].text, "overflow answer");
			release();
			assert.equal((await s1.wait(ctx)).status, "done");
			assert.equal(fauxes[0]!.state.callCount, 1);
			const sk = t.app.ctx.db.get<any>("SELECT * FROM ops_route_attempts WHERE status = 'skipped' AND error_class = 'concurrency'")!;
			assert.equal(sk.channel_id, channels[0]!.id);
			assert.equal(gw.limits.inflight(channels[0]!.id), 0);
			// per-MODEL rpm limit (provider itself unlimited)
			t.app.ctx.db.run("UPDATE model_entries SET rpm_limit = 1 WHERE provider_id = ?", channels[1]!.id);
			gw.invalidate();
			const only = await fauxModel(t, a.token, [{ name: "permodel", responses: [fauxAssistantMessage("x"), fauxAssistantMessage("y")] }]);
			t.app.ctx.db.run("UPDATE model_entries SET rpm_limit = 1 WHERE provider_id = ?", only.channels[0]!.id);
			only.gw.invalidate();
			const c3 = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: only.pm.ref } }, ctx);
			assert.equal(await ask(c3, "1"), "done");
			assert.equal(await ask(c3, "2"), "unanswered");
			assert.match((await lastAssistant(c3)).errorMessage, /^local_rate_limit: .*permodel/);
		} finally {
			await close();
		}
	} finally {
		await t.dispose();
	}
});

test("circuit breaker: opens after 3 failures, skipped while open, HALF-OPEN probe after the window recovers (or re-opens on failure); every skip is recorded", async () => {
	const { t, a, spaceId } = await setup();
	try {
		const br = await fauxModel(t, a.token, [
			{ name: "flaky", responses: [err(), err(), err(), fauxAssistantMessage("flaky recovered"), err("503 unavailable"), fauxAssistantMessage("flaky again")] },
			{ name: "steady", responses: Array.from({ length: 8 }, () => fauxAssistantMessage("steady")) },
		], { label: "Breaker" });
		const { harness, close } = await directHarness(t, spaceId);
		let clock = Date.now();
		br.gw.now = () => clock;
		try {
			const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: br.pm.ref } }, ctx);
			for (let i = 0; i < 4; i++) assert.equal(await ask(conv, `q${i}`), "done");
			assert.equal(br.fauxes[0]!.state.callCount, 3, "4th request skipped the open circuit");
			const open = t.app.ctx.db.get<any>("SELECT * FROM ops_route_attempts WHERE error_class = 'circuit_open'")!;
			assert.equal(open.channel_id, br.channels[0]!.id);
			assert.equal(open.status, "skipped");
			const dto = (await t.json("GET", `/api/admin/model-providers/${br.channels[0]!.id}`, { token: a.token })).provider;
			assert.equal(dto.circuit.open, true);
			// window elapsed → half-open: ONE probe goes upstream and recovers the circuit
			clock += 31_000;
			assert.equal(await ask(conv, "probe"), "done");
			assert.equal((await lastAssistant(conv)).content[0].text, "flaky recovered");
			assert.equal(br.gw.limits.circuit(br.channels[0]!.id).open, false);
			// closed again: next request goes to flaky first (and its 503 fails over to steady; failures counted from 1)
			assert.equal(await ask(conv, "after"), "done");
			assert.equal((await lastAssistant(conv)).content[0].text, "steady");
			assert.equal(br.fauxes[0]!.state.callCount, 5);
		} finally {
			await close();
		}
		// A failing probe re-opens the circuit for another window
		const re = await fauxModel(t, a.token, [{ name: "dead", responses: [err(), err(), err(), err(), fauxAssistantMessage("back")] }, { name: "okay", responses: Array.from({ length: 6 }, () => fauxAssistantMessage("okay")) }]);
		const d2 = await directHarness(t, spaceId);
		let c2 = Date.now();
		re.gw.now = () => c2;
		try {
			const conv = await d2.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: re.pm.ref } }, ctx);
			for (let i = 0; i < 3; i++) await ask(conv, `x${i}`);
			assert.equal(re.gw.limits.circuit(re.channels[0]!.id).open, true);
			c2 += 31_000;
			await ask(conv, "probe-fails"); // 4th dead response
			assert.equal(re.fauxes[0]!.state.callCount, 4);
			assert.equal(re.gw.limits.circuit(re.channels[0]!.id).open, true, "failed probe re-opens");
			await ask(conv, "skipped");
			assert.equal(re.fauxes[0]!.state.callCount, 4, "still open");
			// manual reset closes it
			await t.json("POST", `/api/admin/model-providers/${re.channels[0]!.id}/reset-circuit`, { token: a.token });
			await ask(conv, "after-reset");
			assert.equal((await lastAssistant(conv)).content[0].text, "back");
		} finally {
			await d2.close();
		}
		// 400-class errors never open the circuit (the upstream answered)
		const bad = await fauxModel(t, a.token, [{ name: "badreq", responses: Array.from({ length: 5 }, () => err("400 invalid request")) }]);
		const d3 = await directHarness(t, spaceId);
		try {
			const conv = await d3.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: bad.pm.ref } }, ctx);
			for (let i = 0; i < 4; i++) await ask(conv, `b${i}`);
			assert.equal(bad.gw.limits.circuit(bad.channels[0]!.id).open, false);
			assert.equal(bad.fauxes[0]!.state.callCount, 4);
		} finally {
			await d3.close();
		}
	} finally {
		await t.dispose();
	}
});

test("breaker threshold/window and limits are configurable through the admin API; the fixture model never trips a breaker", async () => {
	const { t, a } = await setup();
	try {
		const { provider } = await t.json("POST", "/api/admin/model-providers", { token: a.token, json: { name: "限流服务商", type: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", keyless: true, rpmLimit: 30, concurrencyLimit: 2, breakerThreshold: 5, breakerWindowMs: 10000, models: [{ id: "m", name: "m", rpmLimit: 10 }] } });
		assert.deepEqual([provider.rpmLimit, provider.concurrencyLimit, provider.breakerThreshold, provider.breakerWindowMs, provider.circuit.open], [30, 2, 5, 10000, false]);
		const upd = await t.json("PATCH", `/api/admin/model-providers/${provider.id}`, { token: a.token, json: { rpmLimit: null, concurrencyLimit: 4 } });
		assert.deepEqual([upd.provider.rpmLimit, upd.provider.concurrencyLimit], [undefined, 4]);
		const m = await t.json("PATCH", `/api/admin/model-providers/${provider.id}/models/m`, { token: a.token, json: { concurrencyLimit: 1 } });
		assert.deepEqual([m.model.rpmLimit, m.model.concurrencyLimit], [10, 1]);
		await t.json("PATCH", `/api/admin/model-providers/${provider.id}`, { token: a.token, json: { rpmLimit: 0 }, expect: 400 });
		await t.json("PATCH", `/api/admin/model-providers/${provider.id}`, { token: a.token, json: { breakerWindowMs: 5 }, expect: 400 });
		// fixture: failing requests (upstream timeout directive) never produce circuit_open
		if (!t.app.ctx.services.has("runtime")) return;
		const { conversation } = await t.json("POST", "/api/conversations", { token: a.token, json: { modelId: "workroom-fixture" } });
		for (let i = 0; i < 5; i++) {
			await t.json("POST", `/api/conversations/${conversation.spaceId}/${conversation.conversationId}/messages`, { token: a.token, json: { text: `[[fail timeout]] ${i}`, requestId: randomUUID() } });
			await waitFor(async () => {
				const s = await t.json("GET", `/api/conversations/${conversation.spaceId}/${conversation.conversationId}/state`, { token: a.token });
				return !s.live.busy && s.queue.length === 0 && s.entries.filter((e: any) => e.kind === "assistant").length >= i + 1 ? s : undefined;
			}, { timeoutMs: 30_000, what: "fixture failure settles" });
		}
		await t.json("POST", `/api/conversations/${conversation.spaceId}/${conversation.conversationId}/messages`, { token: a.token, json: { text: "[[reply 恢复了]]", requestId: randomUUID() } });
		const s = await waitFor(async () => {
			const st = await t.json("GET", `/api/conversations/${conversation.spaceId}/${conversation.conversationId}/state`, { token: a.token });
			return !st.live.busy && st.entries.some((e: any) => e.kind === "assistant" && typeof e.text === "string" && e.text.includes("恢复了")) ? st : undefined;
		}, { timeoutMs: 30_000, what: "fixture answers after failures" });
		assert.ok(s);
		assert.equal(t.app.ctx.db.get<any>("SELECT COUNT(*) AS n FROM ops_route_attempts WHERE error_class IN ('circuit_open','local_rate_limit','concurrency')")!.n, 0);
	} finally {
		await t.dispose();
	}
});

test("failover × billing: a failed attempt's reported usage and the fallback's both count; final message usage = every actual call", async () => {
	const { t, a, spaceId } = await setup();
	try {
		const { pm, gw } = await fauxModel(t, a.token, [
			{ name: "primary", responses: [err("503 Service Unavailable")] },
			{ name: "backup", responses: [fauxAssistantMessage("答案来自备用")] },
		]);
		const { harness, close } = await directHarness(t, spaceId);
		try {
			const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: pm.ref } }, ctx);
			assert.equal(await ask(conv, "你好"), "done");
			const msg = await lastAssistant(conv);
			const at = t.app.ctx.db.all<any>("SELECT * FROM ops_route_attempts ORDER BY attempt_no");
			assert.deepEqual(at.map((x) => [x.status, x.failover]), [["error", 0], ["ok", 1]]);
			assert.ok(Math.abs(msg.usage.cost.total - (at[0].cost_total + at[1].cost_total)) < 1e-12);
			assert.equal(msg.usage.input + msg.usage.cacheWrite + msg.usage.cacheRead, at.reduce((n, x) => n + x.input_tokens + x.cache_read + x.cache_write, 0));
			const expected = (at[1].input_tokens * PRICE.input + at[1].output_tokens * PRICE.output + at[1].cache_read * PRICE.cacheRead + at[1].cache_write * PRICE.cacheWrite) / 1e6;
			assert.ok(Math.abs(at[1].cost_total - expected) < 1e-12, "cost = model price × reported tokens");
			assert.equal(gw.limits.circuit("up-primary").fails, 1);
		} finally {
			await close();
		}
	} finally {
		await t.dispose();
	}
});
