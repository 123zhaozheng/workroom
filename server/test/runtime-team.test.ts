// Assistants, subagents and team (M03) tests (group A).
//   node --disable-warning=ExperimentalWarning --test server/test/runtime-team.test.ts
process.env.WORKROOM_FIXTURE_TOOLS = "1";
process.env.WORKROOM_RT_RETRY_BASE_MS ??= "20";
process.env.WORKROOM_SSE_THROTTLE_MS ??= "20";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { isSettled, waitFor } from "../src/runtime/testing.ts";
import type { ConversationState, EntryDTO, SubmissionDTO } from "../../shared/chat.ts";

const rid = () => randomUUID();
type Conv = { spaceId: string; conversationId: number };
const base = (c: Conv) => `/api/conversations/${c.spaceId}/${c.conversationId}`;
const settle = (t: TestApp, token: string, c: Conv, id: number) =>
	waitFor(async () => {
		const s = (await t.json("GET", `${base(c)}/submissions/${id}`, { token })) as SubmissionDTO;
		return isSettled(s) ? s : undefined;
	}, { timeoutMs: 20_000, what: `submission ${id}` });
const send = (t: TestApp, token: string, c: Conv, text: string) => t.json("POST", `${base(c)}/messages`, { token, json: { text, requestId: rid() } });
const state = (t: TestApp, token: string, c: Conv): Promise<ConversationState> => t.json("GET", `${base(c)}/state?limit=100`, { token });
const delegateCall = (member: string, task: string, mode?: string) => `[[call delegate ${JSON.stringify({ member, task, ...(mode ? { mode } : {}) })}]]`;

const TEAM = {
	name: "研究小队",
	avatar: "🧭",
	description: "带三个成员的测试助手",
	instructions: "你是项目助理。",
	members: [
		{ id: "echoer", name: "回声员", type: "builtin_subagent", tools: ["wr_fixture_echo"], maxTurns: 4 },
		{ id: "notools", name: "无工具", type: "builtin_subagent", tools: [], maxTurns: 3 },
		{ id: "short", name: "短跑", type: "builtin_subagent", tools: ["wr_fixture_echo"], maxTurns: 1 },
		{ id: "mcpsvc", name: "外部服务", type: "external_tool", tools: [], maxTurns: 1, connectorId: "conn_x" },
		{ id: "partner", name: "合作方 Agent", type: "third_party_agent", tools: [], maxTurns: 1, connectorId: "conn_partner" },
	],
};

async function setup(t: TestApp) {
	const a = await t.user("team-a@example.com");
	const { assistant } = await t.json("POST", "/api/assistants", { token: a.token, json: TEAM });
	const { conversation: c, agent } = await t.json("POST", "/api/conversations", { token: a.token, json: { assistantId: assistant.id } });
	return { a, assistant, c: c as Conv, agent };
}

test("assistants (M03-A): identity stored apart from conversations; validation; visibility", async () => {
	const t = await startTestApp();
	try {
		const { a, assistant, c, agent } = await setup(t);
		assert.equal(assistant.name, "研究小队");
		assert.equal(assistant.avatar, "🧭");
		assert.equal(assistant.members.length, 5);
		assert.equal(agent.assistant.id, assistant.id);
		const list = await t.json("GET", "/api/assistants", { token: a.token });
		assert.deepEqual(list.assistants.map((x: any) => x.id), ["builtin:workroom", assistant.id]);
		// changing the assistant does not rewrite the conversation's run history; the binding stays by id
		await t.json("PATCH", `/api/assistants/${assistant.id}`, { token: a.token, json: { description: "改过的说明" } });
		const d = await t.json("GET", base(c), { token: a.token });
		assert.equal(d.agent.assistant.description, "改过的说明");
		// members must declare an explicit tools allowlist
		const bad = await t.json("POST", "/api/assistants", { token: a.token, json: { name: "x", members: [{ id: "m", type: "builtin_subagent", maxTurns: 2 }] }, expect: 400 });
		assert.equal(bad.error.code, "invalid_member");
		await t.json("POST", "/api/assistants", { token: a.token, json: { name: "x", members: [{ id: "m", type: "mystery", tools: [] }] }, expect: 400 });
		// another org cannot see or use it
		const o = await t.user("team-o@example.com");
		await t.json("GET", `/api/assistants/${assistant.id}`, { token: o.token, expect: 404 });
		await t.json("POST", "/api/conversations", { token: o.token, json: { assistantId: assistant.id }, expect: 404 });
	} finally {
		await t.dispose();
	}
});

test("subagent foreground (M03-B): task-owned child with explicit tool allowlist; result, source, owner, usage visible", async () => {
	const t = await startTestApp();
	try {
		const { a, c } = await setup(t);
		const r = await send(t, a.token, c, delegateCall("echoer", `[[call wr_fixture_echo {"text":"子任务数据"}]]`));
		assert.equal((await settle(t, a.token, c, r.submissionId)).status, "done");
		const st = await state(t, a.token, c);
		const sa = st.subagents[0]!;
		assert.equal(sa.status, "done");
		assert.equal(sa.memberType, "builtin_subagent");
		assert.equal(sa.mode, "foreground");
		assert.equal(sa.ownerUserId, a.me.userId);
		assert.equal(sa.source.conversationId, c.conversationId);
		assert.ok(sa.usage && sa.usage.fixture, "usage recorded (fixture, cost 0)");
		assert.match(sa.resultSummary ?? "", /echo\(.*\): 子任务数据/);
		const tr = st.entries.find((e) => e.kind === "tool_result" && (e as any).toolName === "delegate") as any;
		assert.match(tr.text, /成员「回声员」已完成/);
		assert.match(tr.text, /子任务数据/);
		const final = st.entries.filter((e) => e.kind === "assistant").at(-1) as any;
		assert.match(final.text, /子任务数据/, "parent summary quotes the delegate result");
		// the child: owned by the delegate call's task, tools = exactly the allowlist
		const child = await t.json("GET", `/api/conversations/${c.spaceId}/${sa.childConversationId}`, { token: a.token });
		assert.equal(child.conversation.kind, "subagent");
		assert.equal(child.conversation.owner.conversationId, c.conversationId);
		assert.deepEqual(child.agent.tools, ["wr_fixture_echo"]);
		assert.equal(child.agent.maxTurns, 4);
		// the child is read-only for users
		await t.json("POST", `/api/conversations/${c.spaceId}/${sa.childConversationId}/messages`, { token: a.token, json: { text: "hi", requestId: rid() }, expect: 409 });
		// tasks endpoint lists the delegation
		const tasks = await t.json("GET", `${base(c)}/tasks`, { token: a.token });
		assert.equal(tasks.subagents[0].delegationId, sa.delegationId);
	} finally {
		await t.dispose();
	}
});

test("subagent limits: no inherited tools; maxTurns reports unfinished work; external/third-party types refuse", async () => {
	const t = await startTestApp();
	try {
		const { a, c } = await setup(t);
		// a member with tools [] cannot call the parent's tools (tool_unavailable inside the child)
		await settle(t, a.token, c, (await send(t, a.token, c, delegateCall("notools", `[[call wr_fixture_echo {"text":"越权"}]]`))).submissionId);
		let st = await state(t, a.token, c);
		const sa = st.subagents.find((s) => s.memberId === "notools")!;
		const child = await t.json("GET", `/api/conversations/${c.spaceId}/${sa.childConversationId}`, { token: a.token });
		assert.deepEqual(child.agent.tools, []);
		const ce: EntryDTO[] = (await t.json("GET", `/api/conversations/${c.spaceId}/${sa.childConversationId}/entries`, { token: a.token })).items;
		const ctr = ce.find((e) => e.kind === "tool_result") as any;
		assert.equal(ctr.isError, true);
		assert.doesNotMatch(ctr.text, /echo\(/);

		// maxTurns 1: the round runs, then the child ends unanswered (turn_limit); the parent reports what was finished
		await settle(t, a.token, c, (await send(t, a.token, c, delegateCall("short", `[[call wr_fixture_echo {"text":"半成品"}]]`))).submissionId);
		st = await state(t, a.token, c);
		const sh = st.subagents.find((s) => s.memberId === "short")!;
		assert.equal(sh.status, "failed");
		assert.equal(sh.failure, "turn_limit");
		const tr = st.entries.filter((e) => e.kind === "tool_result" && (e as any).toolName === "delegate").at(-1) as any;
		assert.match(tr.text, /未完成（turn_limit）/);
		assert.match(tr.text, /已完成部分[\s\S]*半成品/);
		assert.equal(tr.isError, true);

		// external_tool is not a chat role; third_party_agent needs connector permission and is blocked here
		await settle(t, a.token, c, (await send(t, a.token, c, delegateCall("mcpsvc", "做点事"))).submissionId);
		await settle(t, a.token, c, (await send(t, a.token, c, delegateCall("partner", "把数据发给合作方"))).submissionId);
		st = await state(t, a.token, c);
		const trs = st.entries.filter((e) => e.kind === "tool_result" && (e as any).toolName === "delegate").slice(-2) as any[];
		assert.match(trs[0].text, /external_tool/);
		assert.match(trs[1].text, /第三方 Agent .* 不可用|blocked|未接入/);
		assert.ok(trs.every((x) => x.isError));
	} finally {
		await t.dispose();
	}
});

test("subagent background: continues after the parent's abort and reports back as a follow-up", async () => {
	const t = await startTestApp();
	try {
		const { a, c } = await setup(t);
		const r = await send(t, a.token, c, delegateCall("echoer", "[[slow 1200]] [[reply 后台结论]]", "background"));
		assert.equal((await settle(t, a.token, c, r.submissionId)).status, "done");
		let st = await state(t, a.token, c);
		const sa = st.subagents[0]!;
		assert.equal(sa.mode, "background");
		assert.equal(sa.status, "running");
		// the user stops the parent (Esc) — background work is a boundary and keeps going
		await t.json("POST", `${base(c)}/abort`, { token: a.token, json: {} });
		st = await waitFor(async () => {
			const s = await state(t, a.token, c);
			return s.subagents[0]!.status === "done" && s.entries.some((e) => e.kind === "user" && (e as any).via?.kind === "subagent_report") && !s.live.busy && s.entries.at(-1)!.kind === "assistant" ? s : undefined;
		}, { timeoutMs: 20_000, what: "background report arrives" });
		const report = st.entries.find((e) => e.kind === "user" && (e as any).via?.kind === "subagent_report") as any;
		assert.match(report.text, /成员「回声员」已完成：.*后台结论/);
		assert.equal(report.userId, a.me.userId);
		assert.match((st.entries.at(-1) as any).text, /后台结论/);
		// abort with background: true reaches background work too
		const r2 = await send(t, a.token, c, delegateCall("echoer", "[[slow 3000]] [[reply 不该完成]]", "background"));
		await settle(t, a.token, c, r2.submissionId);
		await t.json("POST", `${base(c)}/abort`, { token: a.token, json: { background: true } });
		const st2 = await waitFor(async () => {
			const s = await state(t, a.token, c);
			const d = s.subagents.find((x) => x.task.includes("不该完成"));
			return d && d.status !== "running" ? s : undefined;
		}, { what: "background delegation aborted" });
		assert.equal(st2.subagents.find((x) => x.task.includes("不该完成"))!.status, "aborted");
	} finally {
		await t.dispose();
	}
});
