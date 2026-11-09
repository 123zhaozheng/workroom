// Gateway behaviour on top of native pi-ai providers, against local mock upstreams:
//   * failover wraps the native streams: retryable failure BEFORE output → the model's fallback answers; attempts recorded; usage = all calls
//   * non-retryable errors (400) are not failed over
//   * `compat` flags reach the wire (developer vs system role), keyless local servers, Authorization: Bearer for Claude relays
//   * blocked providers (no key) are listed as blocked and cannot be selected
process.env.WORKROOM_RT_RETRY_MAX ??= "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { waitFor } from "../src/runtime/testing.ts";
import { ANTHROPIC_KEY, OPENAI_KEY, startAnthropicMock, startOpenAIMock } from "./models-mock-servers.ts";

const SECRET = "test-secret-key-for-model-gateway-0123456789";
const lastAssistant = (s: any) => s.entries.filter((e: any) => e.kind === "assistant").at(-1);
const stateOf = (t: TestApp, token: string, c: any) => t.json("GET", `/api/conversations/${c.spaceId}/${c.conversationId}/state`, { token });
const ask = async (t: TestApp, token: string, c: any, text: string, done: (s: any) => boolean) => {
	await t.json("POST", `/api/conversations/${c.spaceId}/${c.conversationId}/messages`, { token, json: { text, requestId: randomUUID() } });
	return waitFor(async () => {
		const s = await stateOf(t, token, c);
		return !s.live.busy && s.queue.length === 0 && done(s) ? s : undefined;
	}, { timeoutMs: 30_000, what: `answer to ${text}` });
};
const newConv = async (t: TestApp, token: string, modelId: string) => (await t.json("POST", "/api/conversations", { token, json: { modelId } })).conversation;
const addProvider = async (t: TestApp, token: string, body: Record<string, unknown>) => (await t.json("POST", "/api/admin/model-providers", { token, json: body })).provider;
const addModel = (t: TestApp, token: string, providerId: string, body: Record<string, unknown>) => t.json("POST", `/api/admin/model-providers/${providerId}/models`, { token, json: body });

test("failover across native providers: 503 before output → fallback answers; 400 is not failed over; every attempt recorded, usage bills all calls", { timeout: 90_000 }, async () => {
	const primary = await startOpenAIMock({ reply: "主力回复" });
	const backup = await startAnthropicMock({ reply: "备用回复（Claude 兼容）" });
	const t = await startTestApp({ config: { secretKey: SECRET } });
	try {
		const a = await t.user("admin@a.example");
		const p1 = await addProvider(t, a.token, { name: "主力", type: "openai-completions", baseUrl: `${primary.url}/v1`, apiKey: OPENAI_KEY });
		const p2 = await addProvider(t, a.token, { name: "备用", type: "anthropic-messages", baseUrl: backup.url, apiKey: ANTHROPIC_KEY });
		await addModel(t, a.token, p1.id, { id: "main-model", name: "主力模型", contextWindow: 128000, maxTokens: 8192, cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } });
		await addModel(t, a.token, p2.id, { id: "backup-model", name: "备用模型", contextWindow: 200000, maxTokens: 8192, cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } });
		// fallbacks must reference real models of this org
		await t.json("PATCH", `/api/admin/model-providers/${p1.id}/models/main-model`, { token: a.token, json: { fallbacks: [{ provider: p2.id, modelId: "nope" }] }, expect: 400 });
		await t.json("PATCH", `/api/admin/model-providers/${p1.id}/models/main-model`, { token: a.token, json: { fallbacks: [{ provider: p2.id, modelId: "backup-model" }] } });
		const c = await newConv(t, a.token, `${p1.id}/main-model`);

		primary.failNext(503);
		const s1 = await ask(t, a.token, c, "你好", (s) => !!lastAssistant(s)?.text);
		assert.equal(lastAssistant(s1).text, "备用回复（Claude 兼容）", "the fallback answered");
		assert.equal(lastAssistant(s1).model.provider, p2.id, "the message honestly names the provider that answered");
		assert.equal(primary.requests.filter((r) => r.method === "POST").length, 1);
		assert.equal(backup.requests.filter((r) => r.method === "POST").length, 1);
		const att = t.app.ctx.db.all<any>("SELECT * FROM ops_route_attempts ORDER BY started_at, attempt_no");
		assert.deepEqual(att.map((x) => [x.channel_id, x.status, x.error_class, x.failover]), [[p1.id, "error", "server", 0], [p2.id, "ok", null, 1]]);
		assert.equal(att[0].request_key, att[1].request_key);
		assert.ok(att[1].cost_total > 0 && att[1].cost_source === "model_price", "cost comes from the native model price");

		// next request: the primary is healthy again → it answers (no sticky breaker)
		const s2 = await ask(t, a.token, c, "再来一次", (s) => lastAssistant(s)?.text === "主力回复");
		assert.equal(lastAssistant(s2).model.provider, p1.id);

		// 400 (bad request) is not retryable: no failover, the run ends with the upstream error
		const before = backup.requests.length;
		primary.failNext(400);
		await t.json("POST", `/api/conversations/${c.spaceId}/${c.conversationId}/messages`, { token: a.token, json: { text: "坏请求", requestId: randomUUID() } });
		const s3 = await waitFor(async () => {
			const s = await stateOf(t, a.token, c);
			return !s.live.busy && s.entries.some((e: any) => e.kind === "assistant" && e.stopReason === "error") ? s : undefined;
		}, { timeoutMs: 30_000, what: "400 settles" });
		assert.equal(backup.requests.length, before, "no failover on a non-retryable error");
		assert.match(lastAssistant(s3).errorMessage, /400/);
		const last = t.app.ctx.db.get<any>("SELECT * FROM ops_route_attempts ORDER BY started_at DESC, attempt_no DESC LIMIT 1")!;
		assert.deepEqual([last.error_class, last.retryable, last.failover], ["bad_request", 0, 0]);
	} finally {
		await t.dispose();
		await primary.close();
		await backup.close();
	}
});

test("compat flags reach the wire; keyless local server works; Claude relay with Authorization: Bearer; blocked without a key", { timeout: 90_000 }, async () => {
	const local = await startOpenAIMock({ key: null, reply: "本地模型回复" });
	const relay = await startAnthropicMock({ reply: "中转站回复" });
	const t = await startTestApp({ config: { secretKey: SECRET } });
	try {
		const a = await t.user("admin@a.example");
		// Keyless (Ollama / vLLM style) — no apiKey stored, "无需密钥"
		const ollama = await addProvider(t, a.token, { name: "本地 Ollama", type: "openai-completions", baseUrl: `${local.url}/v1`, keyless: true, preset: "ollama" });
		assert.equal(ollama.health, "ready");
		assert.deepEqual(ollama.credential, { kind: "none" });
		const fetched = await t.json("POST", `/api/admin/model-providers/${ollama.id}/fetch-models`, { token: a.token, json: {} });
		assert.equal(fetched.ok, true);
		// A reasoning model: default compat sends the system prompt as "developer"; compat.supportsDeveloperRole=false sends "system".
		await addModel(t, a.token, ollama.id, { id: "think-default", name: "默认 compat", reasoning: true, contextWindow: 32000, maxTokens: 4000 });
		await addModel(t, a.token, ollama.id, { id: "think-compat", name: "关闭 developer", reasoning: true, contextWindow: 32000, maxTokens: 4000, compat: { supportsDeveloperRole: false, supportsReasoningEffort: false } });
		const roleOf = async (modelId: string) => {
			const c = await newConv(t, a.token, `${ollama.id}/${modelId}`);
			const before = local.requests.length;
			await ask(t, a.token, c, "你好", (s) => lastAssistant(s)?.text === "本地模型回复");
			const req = local.requests.slice(before).find((r) => r.method === "POST")!;
			return { first: req.body.messages[0].role, hasEffort: "reasoning_effort" in req.body, auth: req.headers.authorization };
		};
		assert.equal((await roleOf("think-default")).first, "developer");
		const withCompat = await roleOf("think-compat");
		assert.equal(withCompat.first, "system", "compat.supportsDeveloperRole=false is honoured by pi-ai");
		assert.equal(withCompat.hasEffort, false);

		// Claude-compatible relay that wants Authorization: Bearer instead of x-api-key
		const rel = await addProvider(t, a.token, { name: "Claude 中转", type: "anthropic-messages", baseUrl: relay.url, apiKey: ANTHROPIC_KEY, authStyle: "bearer", preset: "claude-relay" });
		const f2 = await t.json("POST", `/api/admin/model-providers/${rel.id}/fetch-models`, { token: a.token, json: { enable: "all" } });
		assert.equal(f2.ok, true, JSON.stringify(f2));
		const lr = relay.requests.find((r) => r.url?.startsWith("/v1/models"))!;
		assert.equal(lr.headers.authorization, `Bearer ${ANTHROPIC_KEY}`);
		assert.equal(lr.headers["x-api-key"], undefined);
		const c2 = await newConv(t, a.token, `${rel.id}/claude-mock-1`);
		await ask(t, a.token, c2, "你好", (s) => lastAssistant(s)?.text === "中转站回复");
		const chat = relay.requests.filter((r) => r.method === "POST").at(-1)!;
		assert.equal(chat.headers.authorization, `Bearer ${ANTHROPIC_KEY}`);
		assert.equal(chat.headers["x-api-key"], undefined, "authStyle=bearer sends only the Authorization header");

		// Missing key → blocked, with a reason; cannot be selected; becomes ready once a key is added
		const nokey = await addProvider(t, a.token, { name: "没密钥", type: "openai-completions", baseUrl: `${local.url}/v1` });
		assert.equal(nokey.health, "blocked");
		await addModel(t, a.token, nokey.id, { id: "m", name: "无密钥模型" });
		const list = await t.json("GET", "/api/models", { token: a.token });
		const m = list.models.find((x: any) => x.id === `${nokey.id}/m`);
		assert.equal(m.status, "blocked");
		assert.match(m.statusDetail, /密钥/);
		await t.json("POST", "/api/conversations", { token: a.token, json: { modelId: `${nokey.id}/m` }, expect: 409 });
		const fixed = await t.json("PATCH", `/api/admin/model-providers/${nokey.id}`, { token: a.token, json: { apiKey: "sk-late-key-000000000000" } });
		assert.equal(fixed.provider.health, "ready");
		// A key referenced by environment variable name (WORKROOM_ prefix only) — resolved at request time, never stored
		await t.json("POST", "/api/admin/model-providers", { token: a.token, json: { name: "x", type: "openai-completions", baseUrl: `${local.url}/v1`, apiKeyEnv: "ANTHROPIC_API_KEY" }, expect: 400 });
		process.env.WORKROOM_TEST_PROVIDER_KEY = "sk-from-env-0000000000";
		const envProv = await addProvider(t, a.token, { name: "环境变量密钥", type: "openai-completions", baseUrl: `${local.url}/v1`, apiKeyEnv: "WORKROOM_TEST_PROVIDER_KEY" });
		assert.deepEqual(envProv.credential, { kind: "env", envVar: "WORKROOM_TEST_PROVIDER_KEY" });
		assert.equal(envProv.health, "ready");
		const raw = t.app.ctx.db.get<any>("SELECT api_key_enc, api_key_env FROM model_providers WHERE id = ?", envProv.id)!;
		assert.equal(raw.api_key_enc, null);
		// Ambient provider env (e.g. a developer's ANTHROPIC_API_KEY) is never used by pi-ai
		process.env.OPENAI_API_KEY = "sk-ambient-must-never-be-used";
		const auth = await t.app.ctx.services.get("models").piModels().getAuth(nokey.id);
		assert.notEqual(auth?.auth.apiKey, "sk-ambient-must-never-be-used");
	} finally {
		delete process.env.WORKROOM_TEST_PROVIDER_KEY;
		delete process.env.OPENAI_API_KEY;
		await t.dispose();
		await local.close();
		await relay.close();
	}
});
