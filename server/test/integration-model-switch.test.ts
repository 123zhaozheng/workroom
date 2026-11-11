// Switching the model of an existing conversation: PATCH /conversations/:spaceId/:id { modelId, thinkingLevel }.
process.env.WORKROOM_RT_RETRY_MAX ??= "0";
process.env.WORKROOM_SSE_THROTTLE_MS ??= "20";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { fauxModel } from "../src/ops/testing.ts";
import { isSettled, waitFor } from "../src/runtime/testing.ts";
import type { EntryDTO, SubmissionDTO } from "../../shared/chat.ts";

type C = { spaceId: string; conversationId: number };
const base = (c: C) => `/api/conversations/${c.spaceId}/${c.conversationId}`;

async function ask(t: TestApp, token: string, c: C, text: string): Promise<SubmissionDTO> {
	const r = await t.json("POST", `${base(c)}/messages`, { token, json: { text, requestId: randomUUID() } });
	return waitFor(async () => {
		const s = (await t.json("GET", `${base(c)}/submissions/${r.submissionId}`, { token })) as SubmissionDTO;
		return isSettled(s) ? s : undefined;
	}, { timeoutMs: 20_000, what: "submission settles" });
}
const entries = async (t: TestApp, token: string, c: C): Promise<EntryDTO[]> => (await t.json("GET", `${base(c)}/entries?limit=200`, { token })).items;
const answers = async (t: TestApp, token: string, c: C) => (await entries(t, token, c)).filter((e) => e.kind === "assistant") as any[];
const modelOf = async (t: TestApp, token: string, c: C) => (await t.json("GET", base(c), { token })).agent;

async function setup() {
	const t = await startTestApp();
	const owner = await t.user("owner@sw.example", { name: "Owner" });
	const mkMember = async (name: string) => {
		const inv = await t.json("POST", "/api/admin/invites", { token: owner.token, json: { role: "member" } });
		return t.user(`${name}@sw.example`, { inviteCode: inv.invite.code, name });
	};
	const alice = await mkMember("alice");
	const fast = await fauxModel(t, owner.token, [{ name: "fast", responses: [fauxAssistantMessage("来自 fast 1"), fauxAssistantMessage("来自 fast 2")] }], { label: "Fast 模型" });
	const deep = await fauxModel(t, owner.token, [{ name: "deep", responses: [fauxAssistantMessage("来自 deep 1"), fauxAssistantMessage("来自 deep 2")] }], { label: "Deep 模型" });
	return { t, owner, alice, fast, deep };
}

test("model switch: PATCH applies from the next request, leaves a traceable notice, and the next answer comes from the new model", { timeout: 60_000 }, async () => {
	const { t, alice, fast, deep } = await setup();
	try {
		const { conversation } = await t.json("POST", "/api/conversations", { token: alice.token, json: { modelId: fast.pm.id } });
		const c: C = conversation;
		assert.equal((await ask(t, alice.token, c, "第一问")).status, "done");
		assert.equal((await answers(t, alice.token, c))[0].text, "来自 fast 1");
		assert.deepEqual((await modelOf(t, alice.token, c)).model, fast.pm.ref);

		const r = await t.json("PATCH", base(c), { token: alice.token, json: { modelId: deep.pm.id } });
		assert.deepEqual(r.agent.model, deep.pm.ref, "the answer carries the resulting agent");
		assert.deepEqual((await modelOf(t, alice.token, c)).model, deep.pm.ref);
		const notice = (await entries(t, alice.token, c)).find((e) => e.kind === "notice") as any;
		assert.match(notice.text, /已切换模型：Fast 模型 → Deep 模型/);
		assert.equal(notice.code, "model_switched");
		assert.equal(notice.text.includes("Alice") || notice.text.includes("alice"), true, "names who switched");

		assert.equal((await ask(t, alice.token, c, "第二问")).status, "done");
		const as = await answers(t, alice.token, c);
		assert.equal(as[1].text, "来自 deep 1");
		assert.deepEqual(as[0].model, fast.pm.ref, "earlier answers keep the model that produced them");
		assert.deepEqual(as[1].model, deep.pm.ref);
		assert.equal(fast.fauxes[0]!.state.callCount, 1);
		assert.equal(deep.fauxes[0]!.state.callCount, 1);

		// switching to the model already in use is a no-op: no second notice
		await t.json("PATCH", base(c), { token: alice.token, json: { modelId: deep.pm.id } });
		assert.equal((await entries(t, alice.token, c)).filter((e) => e.kind === "notice").length, 1);
		// title / archive still work through the same route, and an unknown model changes nothing at all
		const bad = await t.json("PATCH", base(c), { token: alice.token, json: { title: "不应生效", modelId: "nope/none" }, expect: 400 });
		assert.equal(bad.error.code, "unknown_model");
		assert.notEqual((await t.json("GET", base(c), { token: alice.token })).conversation.title, "不应生效");
		await t.json("PATCH", base(c), { token: alice.token, json: { title: "改名" } });
	} finally {
		await t.dispose();
	}
});

test("model switch: a model the member may not use is refused (and the conversation keeps its model); a thinking level the model lacks is refused", { timeout: 60_000 }, async () => {
	const { t, owner, alice, fast, deep } = await setup();
	try {
		// `deep` becomes visible to the owner only
		await t.json("PATCH", `/api/admin/model-providers/${deep.refs[0]!.provider}/models/${deep.refs[0]!.modelId}`, { token: owner.token, json: { visibility: { userIds: [owner.me.userId] } } });
		const { conversation } = await t.json("POST", "/api/conversations", { token: alice.token, json: { modelId: fast.pm.id } });
		const c: C = conversation;
		const denied = await t.json("PATCH", base(c), { token: alice.token, json: { modelId: deep.pm.id }, expect: 400 });
		assert.equal(denied.error.code, "unknown_model");
		assert.deepEqual((await modelOf(t, alice.token, c)).model, fast.pm.ref);
		assert.equal((await entries(t, alice.token, c)).filter((e) => e.kind === "notice").length, 0, "no notice for a refused switch");
		// the faux models support no reasoning levels: "high" is refused, "off" is accepted
		const lv = await t.json("PATCH", base(c), { token: alice.token, json: { modelId: fast.pm.id, thinkingLevel: "high" }, expect: 400 });
		assert.equal(lv.error.code, "invalid_thinking_level");
		await t.json("PATCH", base(c), { token: alice.token, json: { thinkingLevel: "off" }, expect: 400 }); // level without a model
		// the owner (who may see it) can switch to it in their own conversation
		const mine = (await t.json("POST", "/api/conversations", { token: owner.token, json: { modelId: fast.pm.id } })).conversation as C;
		await t.json("PATCH", base(mine), { token: owner.token, json: { modelId: deep.pm.id } });
		assert.deepEqual((await modelOf(t, owner.token, mine)).model, deep.pm.ref);
		// creation validates the level the same way (it used to be ignored)
		const badCreate = await t.json("POST", "/api/conversations", { token: alice.token, json: { modelId: fast.pm.id, thinkingLevel: "high" }, expect: 400 });
		assert.equal(badCreate.error.code, "invalid_thinking_level");
		await t.json("POST", "/api/conversations", { token: alice.token, json: { modelId: fast.pm.id, thinkingLevel: "off" } });
		// another user's conversation: 403 (no write access, nothing disclosed)
		await t.json("PATCH", base(c), { token: owner.token, json: { modelId: fast.pm.id }, expect: 403 });
	} finally {
		await t.dispose();
	}
});

test("model switch: a project viewer cannot switch; an editor can; a branch keeps its own model and the parent is untouched by switching a branch", { timeout: 60_000 }, async () => {
	const { t, owner, alice, fast, deep } = await setup();
	try {
		const viewer = await (async () => {
			const inv = await t.json("POST", "/api/admin/invites", { token: owner.token, json: { role: "member" } });
			return t.user("viewer@sw.example", { inviteCode: inv.invite.code, name: "Viewer" });
		})();
		const { project } = await t.json("POST", "/api/projects", { token: alice.token, json: { kind: "space", name: "切换项目" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: alice.token, json: { email: "viewer@sw.example", role: "viewer" } });
		const { conversation } = await t.json("POST", "/api/conversations", { token: alice.token, json: { projectId: project.id, modelId: fast.pm.id } });
		const c: C = conversation;
		assert.equal((await ask(t, alice.token, c, "q1")).status, "done");
		assert.equal((await t.json("GET", base(c), { token: viewer.token })).agent.model.modelId, fast.pm.ref.modelId, "the viewer can read it");
		await t.json("PATCH", base(c), { token: viewer.token, json: { modelId: deep.pm.id }, expect: 403 });
		assert.deepEqual((await modelOf(t, alice.token, c)).model, fast.pm.ref);

		// fork before the switch: the branch keeps the model it was forked with
		const first = (await entries(t, alice.token, c)).find((e) => e.kind === "assistant")!;
		const { conversation: br } = await t.json("POST", `${base(c)}/fork`, { token: alice.token, json: { entryId: first.id } });
		await t.json("PATCH", base(c), { token: alice.token, json: { modelId: deep.pm.id } });
		assert.deepEqual((await modelOf(t, alice.token, c)).model, deep.pm.ref);
		assert.deepEqual((await modelOf(t, alice.token, br)).model, fast.pm.ref, "an existing branch is not switched with its parent");
		assert.equal((await ask(t, alice.token, br, "分支继续")).status, "done");
		assert.deepEqual((await answers(t, alice.token, br)).at(-1).model, fast.pm.ref);
		// switching the branch leaves the parent alone
		await t.json("PATCH", base(br), { token: alice.token, json: { modelId: deep.pm.id } });
		assert.deepEqual((await modelOf(t, alice.token, br)).model, deep.pm.ref);
		await t.json("PATCH", base(br), { token: alice.token, json: { modelId: fast.pm.id } });
		assert.deepEqual((await modelOf(t, alice.token, c)).model, deep.pm.ref);
		// a branch forked at an entry AFTER the switch starts from the new model (a fork copies the agent as of its fork point)
		assert.equal((await ask(t, alice.token, c, "切换后的提问")).status, "done");
		const lastParent = (await entries(t, alice.token, c)).filter((e) => e.kind === "assistant").at(-1)!;
		const { conversation: br2 } = await t.json("POST", `${base(c)}/fork`, { token: alice.token, json: { entryId: lastParent.id } });
		assert.deepEqual((await modelOf(t, alice.token, br2)).model, deep.pm.ref);
	} finally {
		await t.dispose();
	}
});

test("model switch while a request is in flight: that request finishes on the old model, the notice is in the transcript, and the next message uses the new model", { timeout: 60_000 }, async () => {
	const { t, owner, alice, deep } = await setup();
	try {
		// a "slow" model whose first request is held until we release it
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let started = false;
		const slow = await fauxModel(t, owner.token, [{ name: "slow", responses: [async () => ((started = true), await gate, fauxAssistantMessage("慢模型的答复"))] }], { label: "Slow 模型" });
		const { conversation } = await t.json("POST", "/api/conversations", { token: alice.token, json: { modelId: slow.pm.id } });
		const c: C = conversation;
		const r = await t.json("POST", `${base(c)}/messages`, { token: alice.token, json: { text: "慢问题", requestId: randomUUID() } });
		await waitFor(async () => (started ? true : undefined), { timeoutMs: 10_000, what: "request in flight" });
		await t.json("PATCH", base(c), { token: alice.token, json: { modelId: deep.pm.id } });
		release();
		const s = await waitFor(async () => {
			const x = (await t.json("GET", `${base(c)}/submissions/${r.submissionId}`, { token: alice.token })) as SubmissionDTO;
			return isSettled(x) ? x : undefined;
		}, { timeoutMs: 20_000, what: "in-flight run settles" });
		assert.equal(s.status, "done");
		const es = await entries(t, alice.token, c);
		assert.equal(es.filter((e) => e.kind === "assistant").length, 1, "exactly one answer, no duplicated or lost run");
		assert.equal((es.find((e) => e.kind === "assistant") as any).text, "慢模型的答复");
		assert.deepEqual((es.find((e) => e.kind === "assistant") as any).model, slow.pm.ref, "the in-flight request was not retargeted");
		assert.equal(es.filter((e) => e.kind === "notice").length, 1, "the switch is traceable in the transcript");
		assert.deepEqual((await modelOf(t, alice.token, c)).model, deep.pm.ref);
		assert.equal((await ask(t, alice.token, c, "下一问")).status, "done");
		assert.deepEqual((await answers(t, alice.token, c)).at(-1).model, deep.pm.ref);
	} finally {
		await t.dispose();
	}
});
