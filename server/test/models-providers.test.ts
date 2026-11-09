// Model providers, pi-ai native — through the REAL app, admin API and chat API, against local mock upstreams (no credentials):
//   * OpenAI-compatible Chat Completions provider + Anthropic Messages provider are added via the admin API,
//     "获取模型列表" (fetchModels) discovers their models, models are enabled / added by hand,
//   * a conversation is created with the native ref, a message is streamed back through pi-durable, and a tool call round-trips,
//   * the API keys never appear in any API response, log line, transcript or any file under the data dir.
// Real third-party providers (OpenAI, Anthropic, DeepSeek, ...) are NOT exercised: no credentials exist here.
process.env.WORKROOM_RT_RETRY_MAX ??= "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { waitFor } from "../src/runtime/testing.ts";
import { captureLogs } from "../src/ops/log.ts";
import { ANTHROPIC_KEY, OPENAI_KEY, startAnthropicMock, startOpenAIMock } from "./models-mock-servers.ts";

const SECRET = "test-secret-key-for-model-providers-0123456789";

const state = (t: TestApp, token: string, spaceId: string, id: number) => t.json("GET", `/api/conversations/${spaceId}/${id}/state`, { token });
const send = (t: TestApp, token: string, spaceId: string, id: number, text: string) => t.json("POST", `/api/conversations/${spaceId}/${id}/messages`, { token, json: { text, requestId: randomUUID() } });
/** Wait until the conversation is idle AND the last assistant text matches (the run may not have started right after submit returns). */
const idle = (t: TestApp, token: string, spaceId: string, id: number, answer?: RegExp) =>
	waitFor(async () => {
		const s = await state(t, token, spaceId, id);
		return !s.live.busy && s.queue.length === 0 && (!answer || answer.test(lastAssistant(s)?.text ?? "")) ? s : undefined;
	}, { timeoutMs: 30_000, what: `conversation idle${answer ? ` with answer ${answer}` : ""}` });
const lastAssistant = (s: any) => s.entries.filter((e: any) => e.kind === "assistant" && e.text).at(-1);

function filesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) out.push(...filesUnder(p));
		else out.push(p);
	}
	return out;
}

test("admin adds OpenAI-compatible + Anthropic providers → fetch models → chat streams + tool round trip through pi-durable; keys never leak", { timeout: 120_000 }, async () => {
	const openai = await startOpenAIMock();
	const anth = await startAnthropicMock();
	const logs = captureLogs(true);
	const t = await startTestApp({ config: { secretKey: SECRET } });
	const seen: string[] = []; // every API response body we look at
	const get = async (path: string, token: string) => {
		const r = await t.json("GET", path, { token });
		seen.push(JSON.stringify(r));
		return r;
	};
	try {
		const a = await t.user("admin@a.example");
		const tok = a.token;

		// ---- OpenAI-compatible Chat Completions provider
		const created = await t.json("POST", "/api/admin/model-providers", { token: tok, json: { name: "Mock OpenAI 兼容", type: "openai-completions", baseUrl: `${openai.url}/v1/`, apiKey: OPENAI_KEY, preset: "openai-compatible", headers: { "X-Org-Tag": "acme" } } });
		seen.push(JSON.stringify(created));
		const oa = created.provider;
		assert.equal(oa.type, "openai-completions");
		assert.equal(oa.baseUrl, `${openai.url}/v1`, "trailing slash trimmed, /v1 kept for OpenAI-style APIs");
		assert.deepEqual(oa.credential, { kind: "stored", hint: `****${OPENAI_KEY.slice(-4)}` });
		assert.deepEqual(oa.headerNames, ["X-Org-Tag"]);
		assert.equal(oa.health, "ready");
		assert.equal(oa.scope, "org");
		assert.equal(created.models.length, 0, "no models before 获取模型列表");

		const fetched = await t.json("POST", `/api/admin/model-providers/${oa.id}/fetch-models`, { token: tok, json: {} });
		seen.push(JSON.stringify(fetched));
		assert.equal(fetched.ok, true);
		assert.deepEqual(fetched.models.map((m: any) => m.modelId).sort(), ["mock-chat", "mock-vision", "text-embedding-mock"]);
		assert.ok(fetched.models.every((m: any) => m.enabled === false), "fetched models start disabled");
		assert.equal(fetched.models.find((m: any) => m.modelId === "text-embedding-mock").nonChat, true);
		const listReq = openai.requests.find((r) => r.method === "GET" && r.url === "/v1/models")!;
		assert.equal(listReq.headers.authorization, `Bearer ${OPENAI_KEY}`, "the key is sent to the vendor only");
		assert.equal(listReq.headers["x-org-tag"], "acme", "custom headers are sent on the list request too");

		// Nothing is offered to users until models are enabled.
		assert.equal((await get("/api/models", tok)).models.filter((m: any) => m.ref.provider === oa.id).length, 0);
		await t.json("PATCH", `/api/admin/model-providers/${oa.id}/models`, { token: tok, json: { modelIds: ["mock-chat", "mock-vision"], enabled: true } });
		// Hand-made model with every field the spec names; compat validated by pi-ai's own schema.
		const manual = await t.json("POST", `/api/admin/model-providers/${oa.id}/models`, {
			token: tok,
			json: { id: "manual/big-reasoner", name: "手动推理模型", contextWindow: 262144, maxTokens: 32768, input: ["text", "image"], reasoning: true, thinkingLevelMap: { minimal: null, low: "low", high: "high" }, cost: { input: 1.5, output: 6, cacheRead: 0.15, cacheWrite: 1.9 }, compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" } },
		});
		assert.equal(manual.model.modelId, "manual/big-reasoner", "slash in model ids is fine");
		assert.deepEqual(manual.model.input, ["text", "image"]);
		assert.deepEqual(manual.model.thinkingLevels, ["off", "low", "medium", "high"]);
		assert.deepEqual(manual.model.cost, { input: 1.5, output: 6, cacheRead: 0.15, cacheWrite: 1.9 });
		await t.json("POST", `/api/admin/model-providers/${oa.id}/models`, { token: tok, json: { id: "bad", name: "x", compat: { supportsDeveloperRole: "yes" } }, expect: 400 });
		await t.json("POST", `/api/admin/model-providers/${oa.id}/models`, { token: tok, json: { id: "bad2", name: "x", compat: { notAFlag: true } }, expect: 400 });
		await t.json("PATCH", `/api/admin/model-providers/${oa.id}/models/manual%2Fbig-reasoner`, { token: tok, json: { description: "内部评测用" } });

		// ---- Anthropic Messages provider (base URL given WITH /v1 → normalised)
		const created2 = await t.json("POST", "/api/admin/model-providers", { token: tok, json: { name: "Mock Claude 兼容", type: "anthropic-messages", baseUrl: `${anth.url}/v1`, apiKey: ANTHROPIC_KEY, preset: "claude-relay" } });
		seen.push(JSON.stringify(created2));
		const an = created2.provider;
		assert.equal(an.baseUrl, anth.url, "trailing /v1 stripped for Anthropic (the SDK appends /v1/messages)");
		const f2 = await t.json("POST", `/api/admin/model-providers/${an.id}/fetch-models`, { token: tok, json: { enable: "all" } });
		assert.deepEqual(f2.models.map((m: any) => m.modelId).sort(), ["claude-mock-1", "claude-mock-vision"]);
		assert.equal(f2.models.find((m: any) => m.modelId === "claude-mock-1").name, "Claude Mock 1", "display_name from /v1/models");
		assert.ok(anth.requests.some((r) => r.url?.startsWith("/v1/models") && r.headers["x-api-key"] === ANTHROPIC_KEY && r.headers["anthropic-version"]));

		// Test connection: a real list + a tiny real completion, neither recorded as usage.
		const test1 = await t.json("POST", `/api/admin/model-providers/${oa.id}/test`, { token: tok, json: { modelId: "mock-chat" } });
		assert.equal(test1.ok, true, JSON.stringify(test1));
		assert.equal(test1.list.count, 3);
		assert.match(test1.completion.text, /你好/);
		assert.equal(t.app.ctx.db.get<any>("SELECT COUNT(*) AS n FROM ops_route_attempts")!.n, 0, "connection tests are not usage");
		const badKey = await t.json("POST", "/api/admin/model-providers", { token: tok, json: { name: "坏密钥", type: "openai-completions", baseUrl: `${openai.url}/v1`, apiKey: "sk-wrong-KEY-000000000000" } });
		const bad = await t.json("POST", `/api/admin/model-providers/${badKey.provider.id}/test`, { token: tok, json: {} });
		assert.equal(bad.ok, false);
		assert.match(bad.list.detail, /401/);
		assert.ok(!JSON.stringify(bad).includes("sk-wrong-KEY-000000000000"), "error details never echo keys");
		const failedFetch = await t.json("POST", `/api/admin/model-providers/${badKey.provider.id}/fetch-models`, { token: tok, json: {} });
		assert.equal(failedFetch.ok, false);
		assert.match(failedFetch.error, /401/);
		await t.json("DELETE", `/api/admin/model-providers/${badKey.provider.id}`, { token: tok });

		// ---- /api/models: backward-compatible PlatformModel list + provider name, capabilities, thinking levels
		const list = await get("/api/models", tok);
		const chat = list.models.find((m: any) => m.ref.provider === oa.id && m.ref.modelId === "mock-chat");
		assert.ok(chat, JSON.stringify(list.models.map((m: any) => m.id)));
		assert.equal(chat.id, `${oa.id}/mock-chat`);
		assert.equal(chat.status, "ready");
		assert.equal(chat.providerName, "Mock OpenAI 兼容");
		assert.equal(chat.providerType, "openai-completions");
		assert.deepEqual(chat.ref, { provider: oa.id, modelId: "mock-chat" });
		assert.ok(chat.capabilities.includes("text") && chat.capabilities.includes("tools"));
		assert.ok(Array.isArray(chat.thinkingLevels));
		assert.equal(list.models.some((m: any) => m.ref.modelId === "text-embedding-mock"), false);
		const man = list.models.find((m: any) => m.ref.modelId === "manual/big-reasoner");
		assert.deepEqual(man.capabilities.sort(), ["image", "reasoning", "text", "tools"]);
		assert.equal(man.contextWindow, 262144);
		assert.ok(list.models.some((m: any) => m.fixture && m.status === "fixture"), "the test fixture model is still there, labelled");
		assert.match(list.models.find((m: any) => m.fixture).label, /测试模型.*非真实 AI/);

		// ---- chat through the real API: OpenAI-compatible (stream, then a tool call round trip)
		for (const [prov, modelRef, label, reply, mock] of [
			[oa, "mock-chat", "openai", /OpenAI 兼容 mock/, openai],
			[an, "claude-mock-1", "anthropic", /Claude 兼容 mock/, anth],
		] as const) {
			const { conversation } = await t.json("POST", "/api/conversations", { token: tok, json: { modelId: `${prov.id}/${modelRef}`, title: `${label} 对话` } });
			assert.deepEqual(conversation.model ?? (await state(t, tok, conversation.spaceId, conversation.conversationId)).agent.model, { provider: prov.id, modelId: modelRef });
			const before = mock.requests.length;
			await send(t, tok, conversation.spaceId, conversation.conversationId, "你好");
			let s = await idle(t, tok, conversation.spaceId, conversation.conversationId, reply);
			assert.match(lastAssistant(s).text, reply, `${label} streamed answer`);
			assert.equal(s.agent.model.provider, prov.id);
			assert.equal(s.agent.fixture, false);
			const req = mock.requests.slice(before).find((r) => r.method === "POST")!;
			assert.equal(req.body.model, modelRef);
			assert.equal(req.body.stream, true);
			if (label === "openai") {
				assert.equal(req.headers.authorization, `Bearer ${OPENAI_KEY}`);
				assert.equal(req.headers["x-org-tag"], "acme", "provider custom headers are sent on chat requests");
			} else assert.equal(req.headers["x-api-key"], ANTHROPIC_KEY);
			// tool call round trip: model asks for file_list, pi-durable executes it, the model answers from the result
			await send(t, tok, conversation.spaceId, conversation.conversationId, "看看有哪些文件 [[tool]]");
			s = await idle(t, tok, conversation.spaceId, conversation.conversationId, /工具已返回/);
			const tr = s.entries.find((e: any) => e.kind === "tool_result" && e.toolName === "file_list");
			assert.ok(tr && !tr.isError, `${label}: file_list executed through pi-durable: ${JSON.stringify(tr)}`);
			assert.match(lastAssistant(s).text, /工具已返回/, `${label} final answer after the tool result`);
			const withTools = mock.requests.slice(before).filter((r) => r.method === "POST");
			assert.ok(withTools.length >= 3, "message, tool call, tool result = separate upstream requests");
			assert.ok(JSON.stringify(withTools.at(-1)!.body).includes("file_list"));
			await get(`/api/conversations/${conversation.spaceId}/${conversation.conversationId}/entries`, tok);
			seen.push(JSON.stringify(s));
			// usage attribution: attempts recorded against the native provider / model
			const routes = await get(`/api/conversations/${conversation.spaceId}/${conversation.conversationId}/routes`, tok);
			assert.ok(routes.attempts.length >= 3);
			assert.ok(routes.attempts.every((x: any) => x.providerId === prov.id && x.upstreamModelId === modelRef && x.status === "ok"));
			assert.equal(routes.attempts[0].providerName, prov.name);
			assert.equal(routes.attempts[0].platformModelId, `${prov.id}/${modelRef}`);
		}

		// ---- the usage ledger attributes requests to provider/model
		const usage = await t.json("GET", "/api/usage/ledger?scope=personal&kind=model_request", { token: tok });
		seen.push(JSON.stringify(usage));
		assert.ok(usage.items.some((i: any) => i.platformModelId === `${oa.id}/mock-chat`));

		// ---- other surfaces that must not carry keys
		for (const path of ["/api/admin/model-providers", `/api/admin/model-providers/${oa.id}`, `/api/admin/model-providers/${an.id}/models`, "/api/admin/route-attempts", "/api/admin/audit?limit=500", "/api/admin/audit.csv"]) {
			if (path.endsWith(".csv")) seen.push(await (await t.req("GET", path, { token: tok })).text());
			else await get(path, tok);
		}
		const audit = await t.json("GET", "/api/admin/audit?category=model&limit=200", { token: tok });
		assert.ok(audit.items?.some?.((x: any) => x.action === "model.provider.create") ?? JSON.stringify(audit).includes("model.provider.create"));

		// ---- the keys appear nowhere: responses, logs, transcripts, and no file under the data dir (encrypted at rest)
		const secrets = [OPENAI_KEY, ANTHROPIC_KEY, OPENAI_KEY.slice(8), ANTHROPIC_KEY.slice(12)];
		for (const s of secrets) {
			assert.ok(!seen.some((b) => b.includes(s)), `API responses must not contain ${s.slice(0, 12)}…`);
			assert.ok(!logs.some((l) => l.includes(s)), "logs must not contain keys");
		}
		await t.stop();
		for (const f of filesUnder(t.dataDir)) {
			const buf = readFileSync(f);
			for (const s of secrets) assert.ok(!buf.includes(Buffer.from(s)), `${f} must not contain a plaintext key`);
		}
	} finally {
		captureLogs(false);
		await t.dispose();
		await openai.close();
		await anth.close();
	}
});
