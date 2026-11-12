// Round 13 (kernel review items 1–3), reproduced first, then fixed:
//  1. 重新生成 / 继续 run as the person who pressed it — never as the author of the message they continue from.
//  2. a model fallback is checked against the acting user like any model; a request whose identity cannot be established is refused.
//  3. an assistant's tool allowlist (and knowledge scope) applies to the main agent: [] = no tools, a list = exactly those, nested calls too.
process.env.WORKROOM_RT_RETRY_MAX ??= "0";
process.env.WORKROOM_FIXTURE_TOOLS = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { waitFor } from "../src/runtime/testing.ts";
import { ANTHROPIC_KEY, OPENAI_KEY, startAnthropicMock, startOpenAIMock } from "./models-mock-servers.ts";
import type { Gateway } from "../src/ops/gateway.ts";

const SECRET = "test-secret-key-for-r13-identity-0123456789";
const stateOf = (t: TestApp, token: string, c: { spaceId: string; conversationId: number }) => t.json("GET", `/api/conversations/${c.spaceId}/${c.conversationId}/state`, { token });
const idle = (t: TestApp, token: string, c: { spaceId: string; conversationId: number }, what: string, extra: (s: any) => boolean = () => true) =>
	waitFor(async () => {
		const s = await stateOf(t, token, c);
		return !s.live.busy && s.queue.length === 0 && extra(s) ? s : undefined;
	}, { timeoutMs: 30_000, what });
const lastAssistant = (s: any) => s.entries.filter((e: any) => e.kind === "assistant").at(-1);
const posts = (m: { requests: { method: string }[] }) => m.requests.filter((r) => r.method === "POST").length;

async function org(t: TestApp) {
	const owner = await t.user("owner@r13.example", { name: "Owner" });
	const inv = await t.json("POST", "/api/admin/invites", { token: owner.token, json: { role: "member" } });
	const editor = await t.user("editor@r13.example", { inviteCode: inv.invite.code, name: "Editor" });
	return { owner, editor };
}

test("item 1: 重新生成 and 继续 run as the operator — an editor cannot use the original author's admin-only model", { timeout: 90_000 }, async () => {
	const up = await startOpenAIMock({ reply: "仅管理员模型的回答" });
	const t = await startTestApp({ config: { secretKey: SECRET } });
	try {
		const { owner, editor } = await org(t);
		const prov = (await t.json("POST", "/api/admin/model-providers", { token: owner.token, json: { name: "网关", type: "openai-completions", baseUrl: `${up.url}/v1`, apiKey: OPENAI_KEY } })).provider;
		await t.json("POST", `/api/admin/model-providers/${prov.id}/models`, { token: owner.token, json: { id: "admin-only", name: "admin-only" } });
		await t.json("PATCH", `/api/admin/model-providers/${prov.id}/models/admin-only`, { token: owner.token, json: { visibility: { userIds: [owner.me.userId] } } });
		assert.ok(!(await t.json("GET", "/api/models", { token: editor.token })).models.some((m: any) => m.id === `${prov.id}/admin-only`), "the editor cannot see the model");
		const { project } = await t.json("POST", "/api/projects", { token: owner.token, json: { kind: "space", name: "共享项目" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: owner.token, json: { userId: editor.me.userId, role: "editor" } });
		const { conversation: c } = await t.json("POST", "/api/conversations", { token: owner.token, json: { projectId: project.id, modelId: `${prov.id}/admin-only` } });
		await t.json("POST", `/api/conversations/${c.spaceId}/${c.conversationId}/messages`, { token: owner.token, json: { text: "你好", requestId: randomUUID() } });
		const s0 = await idle(t, owner.token, c, "owner's answer", (s) => !!lastAssistant(s)?.text);
		assert.equal(lastAssistant(s0).text, "仅管理员模型的回答");
		const before = posts(up);

		// the editor presses 重新生成 on the owner's answer
		const r = await t.json("POST", `/api/conversations/${c.spaceId}/${c.conversationId}/regenerate`, { token: editor.token, json: { entryId: lastAssistant(s0).id } });
		const branch = r.conversation;
		const s1 = await idle(t, editor.token, branch, "regenerated run settles", (s) => lastAssistant(s)?.stopReason === "error" || s.live.status === "failed");
		const a1 = lastAssistant(s1);
		assert.match(a1?.errorMessage ?? JSON.stringify(s1.live.failure), /model_not_allowed/, "refused as the editor");
		assert.equal(posts(up), before, "the restricted model never received the editor's request");
		const rt = t.app.ctx.services.get("runtime") as any;
		const harness = await rt.harness(branch.spaceId, BACKGROUND_CONTEXT);
		const rec = await harness.snapshot((await import("../src/runtime/docs.ts")).RunActorDoc, branch.conversationId, BACKGROUND_CONTEXT);
		assert.deepEqual(Object.values(rec.bySubmission).map((x: any) => [x.userId, x.via]), [[editor.me.userId, "regenerate"]], "the regenerate submission is recorded as the editor's");

		// 继续 by the editor on the owner's conversation: same rule
		const cont = await t.json("POST", `/api/conversations/${c.spaceId}/${c.conversationId}/continue`, { token: editor.token, json: { requestId: randomUUID() } });
		assert.ok(cont.submissionId);
		await idle(t, editor.token, c, "continue settles");
		assert.equal(posts(up), before, "a continue by the editor never reaches the restricted model either");

		// the owner can regenerate: the same path works for a permitted operator
		const r2 = await t.json("POST", `/api/conversations/${c.spaceId}/${c.conversationId}/regenerate`, { token: owner.token, json: { entryId: lastAssistant(s0).id } });
		const s2 = await idle(t, owner.token, r2.conversation, "owner's regenerate answers", (s) => !!lastAssistant(s)?.text);
		assert.equal(lastAssistant(s2).text, "仅管理员模型的回答");
	} finally {
		await t.dispose();
		await up.close();
	}
});

test("item 2: a restricted fallback is never called for a user who may not use it; an unresolved identity is refused", { timeout: 90_000 }, async () => {
	const primary = await startOpenAIMock({ reply: "主力回复" });
	const backup = await startAnthropicMock({ reply: "受限备用回复" });
	const t = await startTestApp({ config: { secretKey: SECRET } });
	try {
		const { owner, editor } = await org(t);
		const p1 = (await t.json("POST", "/api/admin/model-providers", { token: owner.token, json: { name: "主力", type: "openai-completions", baseUrl: `${primary.url}/v1`, apiKey: OPENAI_KEY } })).provider;
		const p2 = (await t.json("POST", "/api/admin/model-providers", { token: owner.token, json: { name: "备用", type: "anthropic-messages", baseUrl: backup.url, apiKey: ANTHROPIC_KEY } })).provider;
		await t.json("POST", `/api/admin/model-providers/${p1.id}/models`, { token: owner.token, json: { id: "main", name: "main" } });
		await t.json("POST", `/api/admin/model-providers/${p2.id}/models`, { token: owner.token, json: { id: "restricted-backup", name: "restricted-backup" } });
		await t.json("PATCH", `/api/admin/model-providers/${p2.id}/models/restricted-backup`, { token: owner.token, json: { visibility: { userIds: [owner.me.userId] } } });
		await t.json("PATCH", `/api/admin/model-providers/${p1.id}/models/main`, { token: owner.token, json: { fallbacks: [{ provider: p2.id, modelId: "restricted-backup" }] } });

		// the member: primary 503 → the restricted fallback is skipped (recorded), never called; the run fails visibly
		const { conversation: c } = await t.json("POST", "/api/conversations", { token: editor.token, json: { modelId: `${p1.id}/main` } });
		primary.failNext(503);
		await t.json("POST", `/api/conversations/${c.spaceId}/${c.conversationId}/messages`, { token: editor.token, json: { text: "你好", requestId: randomUUID() } });
		const s = await idle(t, editor.token, c, "member's run settles", (x) => lastAssistant(x)?.stopReason === "error" || x.live.status === "failed");
		assert.notEqual(lastAssistant(s)?.text, "受限备用回复");
		assert.equal(posts(backup), 0, "the restricted fallback received nothing");
		const skipped = t.app.ctx.db.all<any>("SELECT * FROM ops_route_attempts WHERE pi_provider = ? AND status = 'skipped'", p2.id);
		assert.ok(skipped.length >= 1 && /model_not_allowed/.test(skipped[0].error_message), "the skipped fallback is in the route record with its reason");

		// the owner may use it: the same failure fails over to it
		const { conversation: oc } = await t.json("POST", "/api/conversations", { token: owner.token, json: { modelId: `${p1.id}/main` } });
		primary.failNext(503);
		await t.json("POST", `/api/conversations/${oc.spaceId}/${oc.conversationId}/messages`, { token: owner.token, json: { text: "你好", requestId: randomUUID() } });
		const so = await idle(t, owner.token, oc, "owner's failover", (x) => !!lastAssistant(x)?.text);
		assert.equal(lastAssistant(so).text, "受限备用回复");

		// a request linked to a run whose identity could not be established is refused before any upstream call
		const g = t.app.ctx.services.get("models") as unknown as Gateway;
		g.link("r13-unresolved-session", { unresolved: true } as any);
		const models = g.piModels();
		const m = models.getModel(p1.id, "main")!;
		const before = posts(primary);
		const stream = models.streamSimple(m, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as any, { sessionId: "r13-unresolved-session" });
		let err = "";
		for await (const ev of stream as any) if (ev.type === "error") err = ev.error?.errorMessage ?? "";
		assert.match(err, /执行身份缺失/);
		assert.equal(posts(primary), before, "nothing was sent upstream");
	} finally {
		await t.dispose();
		await primary.close();
		await backup.close();
	}
});

test("item 3: an assistant's tool allowlist is the main agent's real tool set ([] = none, a list = exactly those); knowledge scope recorded and applied", { timeout: 90_000 }, async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("tools@r13.example");
		const rt = t.app.ctx.services.get("runtime") as any;
		const agentOf = async (c: any) => {
			const h = await rt.harness(c.spaceId, BACKGROUND_CONTEXT);
			const conv = await h.conversation(c.conversationId, BACKGROUND_CONTEXT);
			return conv.agent(BACKGROUND_CONTEXT);
		};
		const mk = async (body: Record<string, unknown>) => {
			const r = await t.json("POST", "/api/assistants", { token: a.token, json: { name: `助手-${randomUUID().slice(0, 6)}`, members: [], ...body } });
			const id = (r.assistant ?? r).id;
			return (await t.json("POST", "/api/conversations", { token: a.token, json: { assistantId: id } })).conversation;
		};
		const none = await mk({ tools: [] });
		const ag0 = await agentOf(none);
		assert.equal(ag0.tools.length, 0, `offered: ${ag0.tools.map((x: any) => x.name)}`);
		assert.equal(ag0.callable.length, 0, "nested calls cannot reach any tool either");
		// the model asks for a tool anyway: it does not run
		await t.json("POST", `/api/conversations/${none.spaceId}/${none.conversationId}/messages`, { token: a.token, json: { text: `[[call wr_fixture_echo {"text":"越权"}]]`, requestId: randomUUID() } });
		const s0 = await idle(t, a.token, none, "tool-less run settles");
		assert.ok(!s0.entries.some((e: any) => e.kind === "tool_result" && !e.isError && /越权/.test(e.text)), "the echo tool did not run");

		const one = await mk({ tools: ["wr_fixture_echo"] });
		const ag1 = await agentOf(one);
		assert.deepEqual(ag1.tools.map((x: any) => x.name), ["wr_fixture_echo"]);

		const dflt = await mk({});
		assert.ok((await agentOf(dflt)).tools.length > 5, "no allowlist = the product default tool set");

		const scoped = await mk({ tools: ["kb_search"], knowledge: { kbIds: ["kb_r13_only"] } });
		const { memberKnowledgeScope } = await import("../src/knowledge/extension.ts");
		const h = await rt.harness(scoped.spaceId, BACKGROUND_CONTEXT);
		const scope = await memberKnowledgeScope({ snapshot: (doc: any, id: any, c: any) => h.snapshot(doc, id, c) }, scoped.conversationId, BACKGROUND_CONTEXT);
		assert.deepEqual(scope, ["kb_r13_only"], "kb_search is limited to the assistant's knowledge scope");
	} finally {
		await t.dispose();
	}
});
