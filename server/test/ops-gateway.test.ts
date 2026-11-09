// Model gateway: routing inside pi-ai, failover before output, capability matching, limits, credentials, mapping records.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { startTestApp } from "./helpers/app.ts";
import { directHarness, fauxModel, PRICE } from "../src/ops/testing.ts";
import type { Gateway } from "../src/ops/gateway.ts";
import { waitFor } from "../src/runtime/testing.ts";

const SECRET = "test-secret-key-for-gateway-0123456789";
const ask = async (h: any, conv: any, text: string, requestId: string) => {
	const s = await conv.submit({ type: "input", content: text, requestId }, ctx);
	return s.wait(ctx);
};
const lastAssistant = async (conv: any) => {
	const page = await conv.entries({ order: "descending" }, 20, undefined, ctx);
	return page.items.find((e: any) => e.kind === "pi.assistant")?.model?.[0];
};

test("failover: first channel errors before output → second answers; every attempt recorded and mapped to the platform model", async () => {
	const t = await startTestApp({ config: { secretKey: SECRET } });
	try {
		const a = await t.user("admin@a.example");
		const { pm, channels, fauxes, gw } = await fauxModel(t, a.token, [
			{ name: "primary", responses: [fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service Unavailable" })] },
			{ name: "backup", responses: [fauxAssistantMessage("答案来自备用渠道")] },
		]);
		const listed = await t.json("GET", "/api/models", { token: a.token });
		const shown = listed.models.find((m: any) => m.id === pm.id);
		assert.equal(shown.status, "ready");
		assert.deepEqual(shown.ref, { provider: "workroom", modelId: pm.id });
		const spaceId = a.me ? (await t.json("GET", "/api/me", { token: a.token })).personalSpaceId : "";
		const { harness, close } = await directHarness(t, spaceId);
		try {
			const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "workroom", modelId: pm.id } } }, ctx);
			const settled = await ask(harness, conv, "你好", "r1");
			assert.equal(settled.status, "done");
			const msg = await lastAssistant(conv);
			assert.equal(msg.content[0].text, "答案来自备用渠道");
			// The user-facing identity is the platform model; the actual route is recorded on the message.
			assert.equal(msg.provider, "workroom");
			assert.equal(msg.model, pm.id);
			assert.equal(msg.responseModel, "up-backup/backup-model");
			assert.equal(fauxes[0]!.state.callCount, 1);
			assert.equal(fauxes[1]!.state.callCount, 1);
			const attempts = t.app.ctx.db.all<any>("SELECT * FROM ops_route_attempts WHERE platform_model_id = ? ORDER BY attempt_no", pm.id);
			assert.equal(attempts.length, 2);
			assert.equal(attempts[0].request_key, attempts[1].request_key);
			assert.deepEqual([attempts[0].channel_id, attempts[0].status, attempts[0].error_class, attempts[0].retryable, attempts[0].failover], [channels[0].id, "error", "server", 1, 0]);
			assert.deepEqual([attempts[1].channel_id, attempts[1].status, attempts[1].upstream_model, attempts[1].failover], [channels[1].id, "ok", "backup-model", 1]);
			assert.equal(attempts[1].space_id, spaceId);
			assert.equal(attempts[1].conversation_id, Number(conv.id)); // linked through E's pi hook (pi.provider sessionId)
			assert.ok(attempts[1].task_id > 0);
			assert.ok(attempts[1].latency_ms >= 0);
			// Cost from the channel price × reported tokens; final message usage = all actual attempts.
			const expected = (attempts[1].input_tokens * PRICE.input + attempts[1].output_tokens * PRICE.output + attempts[1].cache_read * PRICE.cacheRead + attempts[1].cache_write * PRICE.cacheWrite) / 1e6;
			assert.ok(Math.abs(attempts[1].cost_total - expected) < 1e-12);
			assert.equal(attempts[1].cost_source, "channel_price");
			// The final message bills every actual call (the failed attempt's reported usage included).
			assert.ok(Math.abs(msg.usage.cost.total - (attempts[0].cost_total + attempts[1].cost_total)) < 1e-12);
			assert.equal(msg.usage.input, attempts[0].input_tokens + attempts[1].input_tokens);
			// Admin view of route attempts, filtered by conversation.
			const view = await t.json("GET", `/api/admin/route-attempts?spaceId=${spaceId}&conversationId=${conv.id}`, { token: a.token });
			assert.equal(view.attempts.length, 2);
			assert.equal(view.attempts.find((x: any) => x.status === "ok").channelName, "backup");
			// A second request: circuit is still closed after a single failure → primary tried again.
			fauxes[0]!.setResponses([fauxAssistantMessage("primary ok")]);
			await ask(harness, conv, "再来", "r2");
			assert.equal((await lastAssistant(conv)).responseModel, "up-primary/primary-model");
			assert.equal(gw.inflight(channels[0].id), 0);
		} finally {
			await close();
		}
	} finally {
		await t.dispose();
	}
});

test("no failover after output started; non-retryable errors are not failed over; all-routes-down error names each link", async () => {
	const t = await startTestApp({ config: { secretKey: SECRET } });
	try {
		const a = await t.user("admin@a.example");
		const spaceId = (await t.json("GET", "/api/me", { token: a.token })).personalSpaceId;
		const partialThenError = fauxAssistantMessage([{ type: "text", text: "部分输出" }], { stopReason: "error", errorMessage: "502 Bad Gateway mid-stream" });
		const { pm, fauxes } = await fauxModel(t, a.token, [
			{ name: "p1", responses: [partialThenError, fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 invalid request: bad schema" }), fauxAssistantMessage([], { stopReason: "error", errorMessage: "fetch failed: ECONNREFUSED" })] },
			{ name: "p2", responses: [fauxAssistantMessage([], { stopReason: "error", errorMessage: "529 overloaded_error" })] },
		]);
		const { harness, close } = await directHarness(t, spaceId);
		try {
			const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "workroom", modelId: pm.id } } }, ctx);
			const s1 = await ask(harness, conv, "x", "a1");
			assert.equal(s1.status, "unanswered");
			assert.equal(fauxes[1]!.state.callCount, 0, "output already streamed → no failover");
			const s2 = await ask(harness, conv, "y", "a2");
			assert.equal(s2.status, "unanswered");
			assert.equal(fauxes[1]!.state.callCount, 0, "400 bad_request is not retryable → no failover");
			const s3 = await ask(harness, conv, "z", "a3");
			assert.equal(s3.status, "unanswered");
			assert.equal(fauxes[1]!.state.callCount, 1, "network error → failover to p2");
			const rows = t.app.ctx.db.all<any>("SELECT status, error_class, failover FROM ops_route_attempts WHERE platform_model_id = ? ORDER BY started_at, attempt_no", pm.id);
			assert.deepEqual(rows.map((r) => r.error_class), ["server", "bad_request", "network", "overloaded"]);
			assert.deepEqual(rows.map((r) => r.failover), [0, 0, 0, 1]);
		} finally {
			await close();
		}
	} finally {
		await t.dispose();
	}
});

test("capability routing: image transcripts skip text-only routes; tool contract preserved across failover", async () => {
	const t = await startTestApp({ config: { secretKey: SECRET } });
	try {
		const a = await t.user("admin@a.example");
		const spaceId = (await t.json("GET", "/api/me", { token: a.token })).personalSpaceId;
		let toolsSeenByB: string[] = [];
		const { pm, fauxes } = await fauxModel(t, a.token, [
			{ name: "textonly", input: ["text"], responses: [fauxAssistantMessage("text route")] },
			{
				name: "vision",
				responses: [
					fauxAssistantMessage("我看到了图片"),
					(context) => {
						toolsSeenByB = context.messages.flatMap((m: any) => (m.role === "system" ? (m.toolsAdded ?? []).map((x: any) => x.name) : []));
						return fauxAssistantMessage([fauxToolCall("lookup", { q: "pi" }, { id: "call-1" })], { stopReason: "toolUse" });
					},
					(context) => fauxAssistantMessage(`结果：${(context.messages.at(-1) as any).content[0].text}`),
				],
			},
		]);
		const lookup = defineTool({ name: "lookup", description: "look something up", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } as any, execute: async (args: any) => ({ output: [{ type: "text", text: `found ${args.q}` }] }) } as any);
		const { harness, close } = await directHarness(t, spaceId, { extensions: [defineExtension({ name: "test.tools", tools: [lookup] })] });
		try {
			const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "workroom", modelId: pm.id } } }, ctx);
			const img = { type: "image", data: Buffer.from("fake-png").toString("base64"), mimeType: "image/png" };
			const s = await conv.submit({ type: "input", content: [{ type: "text", text: "看图" }, img] as any, requestId: "img1" }, ctx);
			assert.equal((await s.wait(ctx)).status, "done");
			assert.equal((await lastAssistant(conv)).content[0].text, "我看到了图片");
			assert.equal(fauxes[0]!.state.callCount, 0, "text-only route must not receive images");
			const skipped = t.app.ctx.db.get<any>("SELECT * FROM ops_route_attempts WHERE status = 'skipped' AND error_class = 'capability_mismatch'");
			assert.match(skipped.error_message, /lacks image/);
			// Text-only route that claims no tools: the tool-using transcript still reaches a tools-capable route.
			const s2 = await conv.submit({ type: "input", content: "查一下", requestId: "tool1" }, ctx);
			assert.equal((await s2.wait(ctx)).status, "done");
			assert.ok(toolsSeenByB.includes("lookup"), "tool declarations reach the routed upstream");
			assert.equal((await lastAssistant(conv)).content[0].text, "结果：found pi");
		} finally {
			await close();
		}
		// No route supports images at all → explicit failure naming the unavailable link (M14-A).
		const only = await fauxModel(t, a.token, [{ name: "t2", input: ["text"], responses: [fauxAssistantMessage("never")] }], { label: "TextOnly", capabilities: ["text"] });
		const d2 = await directHarness(t, spaceId);
		try {
			const conv = await d2.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "workroom", modelId: only.pm.id } } }, ctx);
			const s = await conv.submit({ type: "input", content: [{ type: "text", text: "图" }, { type: "image", data: "aGk=", mimeType: "image/png" }] as any, requestId: "img2" }, ctx);
			assert.equal((await s.wait(ctx)).status, "unanswered");
			const m = await lastAssistant(conv);
			assert.match(m.errorMessage, /no available route.*needs image.*capability_mismatch/);
		} finally {
			await d2.close();
		}
	} finally {
		await t.dispose();
	}
});

test("rate and concurrency limits per channel spill over to the next route; limits recorded as skipped attempts", async () => {
	const t = await startTestApp({ config: { secretKey: SECRET } });
	try {
		const a = await t.user("admin@a.example");
		const spaceId = (await t.json("GET", "/api/me", { token: a.token })).personalSpaceId;
		const { pm, fauxes } = await fauxModel(t, a.token, [
			{ name: "limited", rpmLimit: 1, responses: [fauxAssistantMessage("limited-1"), fauxAssistantMessage("limited-2")] },
			{ name: "spill", responses: [fauxAssistantMessage("spill-1")] },
		]);
		const { harness, close } = await directHarness(t, spaceId);
		try {
			const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "workroom", modelId: pm.id } } }, ctx);
			await ask(harness, conv, "1", "l1");
			await ask(harness, conv, "2", "l2");
			assert.equal(fauxes[0]!.state.callCount, 1);
			assert.equal(fauxes[1]!.state.callCount, 1);
			const sk = t.app.ctx.db.get<any>("SELECT * FROM ops_route_attempts WHERE status = 'skipped' AND error_class = 'local_rate_limit'");
			assert.ok(sk);
		} finally {
			await close();
		}
	} finally {
		await t.dispose();
	}
});

test("credentials: refused without secret key, sealed at rest, never returned; env refs restricted; real providers blocked without creds; fixture labelled", async () => {
	const t0 = await startTestApp({ config: { secretKey: undefined } });
	try {
		const a = await t0.user("admin@a.example");
		await t0.json("POST", "/api/admin/channels", { token: a.token, json: { name: "x", provider: "anthropic", apiKey: "sk-ant-api03-SECRETSECRET" }, expect: 409 });
		// env-var credentials are allowed without a secret key — but only WORKROOM_* names
		await t0.json("POST", "/api/admin/channels", { token: a.token, json: { name: "x", provider: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" }, expect: 400 });
		const ok = await t0.json("POST", "/api/admin/channels", { token: a.token, json: { name: "x", provider: "anthropic", apiKeyEnv: "WORKROOM_TEST_UNSET_KEY" } });
		assert.equal(ok.channel.health, "blocked");
		assert.match(ok.channel.healthDetail, /WORKROOM_TEST_UNSET_KEY/);
		await new Promise((r) => setTimeout(r, 20));
	} finally {
		await t0.dispose();
	}
	const t = await startTestApp({ config: { secretKey: SECRET, fixtureModel: true } });
	try {
		const a = await t.user("admin@a.example");
		const { channel } = await t.json("POST", "/api/admin/channels", { token: a.token, json: { name: "Anthropic team", provider: "anthropic", apiKey: "sk-ant-api03-SECRETSECRETSECRET" } });
		assert.deepEqual(channel.credential, { kind: "stored", hint: "****CRET" });
		assert.ok(!JSON.stringify(await t.json("GET", "/api/admin/channels", { token: a.token })).includes("SECRETSECRET"));
		const raw = t.app.ctx.db.get<any>("SELECT api_key_enc FROM ops_channels WHERE id = ?", channel.id);
		assert.match(raw.api_key_enc, /^v1:/);
		assert.ok(!raw.api_key_enc.includes("SECRET"));
		const audit = await t.json("GET", "/api/admin/audit?category=model", { token: a.token });
		assert.ok(!JSON.stringify(audit).includes("SECRETSECRET"));
		const models = await t.json("GET", "/api/models", { token: a.token });
		const claude = models.models.find((m: any) => m.id === "claude");
		assert.equal(claude.status, "blocked"); // WORKROOM_ANTHROPIC_API_KEY not set; ambient ANTHROPIC_* never used
		assert.match(claude.statusDetail, /WORKROOM_ANTHROPIC_API_KEY/);
		const fixture = models.models.find((m: any) => m.id === "workroom-fixture");
		assert.equal(fixture.status, "fixture");
		assert.equal(fixture.fixture, true);
		assert.match(fixture.label, /测试模型，非真实 AI/);
		assert.deepEqual(fixture.ref, { provider: "fixture", modelId: "workroom-fixture" });
		assert.equal(models.defaultModelId, "workroom-fixture");
		// Redaction of secrets echoed in upstream errors.
		const leak = await fauxModel(t, a.token, [{ name: "leaky", responses: [fauxAssistantMessage([], { stopReason: "error", errorMessage: "401 invalid x-api-key: sk-ant-api03-LEAKEDLEAKEDLEAKED" })] }], { label: "Leaky" });
		const spaceId = (await t.json("GET", "/api/me", { token: a.token })).personalSpaceId;
		const d = await directHarness(t, spaceId);
		try {
			const conv = await d.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "workroom", modelId: leak.pm.id } } }, ctx);
			await ask(d.harness, conv, "hi", "leak1");
		} finally {
			await d.close();
		}
		const row = t.app.ctx.db.get<any>("SELECT error_message, error_class FROM ops_route_attempts WHERE platform_model_id = ?", leak.pm.id);
		assert.equal(row.error_class, "auth");
		assert.ok(!row.error_message.includes("LEAKED"), row.error_message);
	} finally {
		await t.dispose();
	}
});

test("cross-tenant: org B cannot see or use org A's models, channels, routes or route attempts", async () => {
	const t = await startTestApp({ config: { secretKey: SECRET } });
	try {
		const a = await t.user("admin@a.example");
		const b = await t.user("admin@b.example");
		const { pm, channels } = await fauxModel(t, a.token, [{ name: "a-only", responses: [fauxAssistantMessage("a")] }], { label: "A private model" });
		const bModels = await t.json("GET", "/api/models", { token: b.token });
		assert.ok(!bModels.models.some((m: any) => m.id === pm.id));
		const bAdmin = JSON.stringify([await t.json("GET", "/api/admin/models", { token: b.token }), await t.json("GET", "/api/admin/channels", { token: b.token }), await t.json("GET", "/api/admin/route-attempts", { token: b.token })]);
		assert.ok(!bAdmin.includes(pm.id) && !bAdmin.includes(channels[0].id) && !bAdmin.includes("A private model"));
		for (const [m, path, json] of [
			["PATCH", `/api/admin/models/${pm.id}`, { label: "x" }],
			["POST", `/api/admin/models/${pm.id}/routes`, { channelId: channels[0].id, upstreamModelId: "x" }],
			["PATCH", `/api/admin/channels/${channels[0].id}`, { name: "x" }],
			["POST", `/api/admin/channels/${channels[0].id}/test`, {}],
		] as const)
			assert.equal((await t.req(m, path, { token: b.token, json })).status, 404, `${m} ${path}`);
		// B's own model cannot route through A's channel
		const { model: bpm } = await t.json("POST", "/api/admin/models", { token: b.token, json: { label: "B" } });
		await t.json("POST", `/api/admin/models/${bpm.id}/routes`, { token: b.token, json: { channelId: channels[0].id, upstreamModelId: "x" }, expect: 404 });
		const id = t.app.ctx.services.get("identity") as any;
		const pb = await id.principalFor(b.me.userId, b.me.orgId);
		assert.deepEqual(await id.check(pb, "use", { kind: "model", id: pm.id }), { allow: false, reason: "other_org" });
		// Members cannot administer models
		const inv = await t.json("POST", "/api/admin/invites", { token: a.token, json: {} });
		const m = await t.user("m@a.example", { inviteCode: inv.invite.code });
		await t.json("GET", "/api/admin/channels", { token: m.token, expect: 403 });
		const pm2 = (await t.json("GET", "/api/models", { token: m.token })).models.find((x: any) => x.id === pm.id);
		assert.ok(pm2, "org members see org models");
		// Visibility restricted to a department → plain members outside it don't see it
		const dep = await t.json("POST", "/api/admin/departments", { token: a.token, json: { name: "R&D" } });
		await t.json("PATCH", `/api/admin/models/${pm.id}`, { token: a.token, json: { visibility: { departmentIds: [dep.department.id] } } });
		assert.ok(!(await t.json("GET", "/api/models", { token: m.token })).models.some((x: any) => x.id === pm.id));
		await t.json("PUT", `/api/admin/departments/${dep.department.id}/members`, { token: a.token, json: { userId: m.me.userId, role: "member" } });
		assert.ok((await t.json("GET", "/api/models", { token: m.token })).models.some((x: any) => x.id === pm.id));
	} finally {
		await t.dispose();
	}
});

test("end-to-end through the runtime API: shown model ↔ recorded route for the conversation (skipped without runtime)", async (tt) => {
	const t = await startTestApp({ config: { secretKey: SECRET } });
	try {
		if (!t.app.ctx.services.has("runtime")) return tt.skip("runtime module not loaded");
		const a = await t.user("admin@a.example");
		const { pm } = await fauxModel(t, a.token, [
			{ name: "down", responses: [fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 unavailable" })] },
			{ name: "up", responses: [fauxAssistantMessage("来自 up 渠道")] },
		]);
		const { conversation } = await t.json("POST", "/api/conversations", { token: a.token, json: { modelId: pm.id, title: "routing" } });
		const { spaceId, conversationId } = conversation;
		const sent = await t.json("POST", `/api/conversations/${spaceId}/${conversationId}/messages`, { token: a.token, json: { text: "hi", requestId: "e2e-1" } });
		await waitFor(async () => {
			const s = await t.json("GET", `/api/conversations/${spaceId}/${conversationId}/submissions/${sent.submissionId}`, { token: a.token });
			return s.status === "done" || s.status === "unanswered" ? s : false;
		});
		const routes = await t.json("GET", `/api/conversations/${spaceId}/${conversationId}/routes`, { token: a.token });
		assert.deepEqual(routes.attempts.map((x: any) => [x.channelName, x.status, x.failover]), [["down", "error", false], ["up", "ok", true]]);
		assert.ok(routes.attempts.every((x: any) => x.conversationId === conversationId && x.spaceId === spaceId));
		const other = await t.user("o@b.example");
		await t.json("GET", `/api/conversations/${spaceId}/${conversationId}/routes`, { token: other.token, expect: 403 });
		void (t.app.ctx.services.get("models") as unknown as Gateway);
	} finally {
		await t.dispose();
	}
});
