// Harness 检视: capture of every model request behind an org switch, API authorisation, retention. Real app + fixture model. Run:
//   node --disable-warning=ExperimentalWarning --test --test-concurrency=1 server/test/harness-inspect.test.ts
process.env.WORKROOM_FIXTURE_TOOLS = "1";
process.env.WORKROOM_RT_RETRY_BASE_MS ??= "20";
process.env.WORKROOM_RT_RETRY_MAX ??= "1";
process.env.WORKROOM_SSE_THROTTLE_MS ??= "20";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { isSettled, waitFor } from "../src/runtime/testing.ts";
import { HarnessInspect, buildPayload, type InspectRequest } from "../src/ops/harness-inspect.ts";
import type { HarnessRoundDetailDTO, HarnessRoundsResponse } from "../../shared/harness-inspect.ts";
import type { SubmissionDTO } from "../../shared/chat.ts";

type Conv = { spaceId: string; conversationId: number };
const base = (c: Conv) => `/api/conversations/${c.spaceId}/${c.conversationId}`;
const newChat = async (t: TestApp, token: string): Promise<Conv> => (await t.json("POST", "/api/conversations", { token, json: {} })).conversation;

async function ask(t: TestApp, token: string, c: Conv, text: string): Promise<void> {
	const r = await t.json("POST", `${base(c)}/messages`, { token, json: { text, requestId: randomUUID() } });
	await waitFor(async () => {
		const s = (await t.json("GET", `${base(c)}/submissions/${r.submissionId}`, { token })) as SubmissionDTO;
		return isSettled(s) ? s : undefined;
	}, { timeoutMs: 15_000, what: "submission settles" });
}
const setSwitch = (t: TestApp, token: string, enabled: boolean, expect = 200) => t.json("PUT", "/api/admin/settings/harness-inspect", { token, json: { enabled }, expect });
const roundsOf = (t: TestApp, token: string, c: Conv, expect = 200) => t.json<HarnessRoundsResponse>("GET", `${base(c)}/harness/rounds`, { token, expect });
const rowCount = (t: TestApp) => t.app.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ops_harness_rounds")!.n;
const tick = () => new Promise((r) => setTimeout(r, 30));

async function invite(t: TestApp, owner: { token: string }, name: string, role: "member" | "admin") {
	const inv = await t.json("POST", "/api/admin/invites", { token: owner.token, json: { role } });
	return t.user(`${name}@hi.example`, { inviteCode: inv.invite.code, name });
}

test("harness inspect: switch is off by default — nothing is captured and the API is empty", async () => {
	const t = await startTestApp();
	try {
		const owner = await t.user("hi-off@example.com");
		const st = await t.json("GET", "/api/harness-inspect/status", { token: owner.token });
		assert.equal(st.enabled, false);
		assert.equal(st.canInspect, true);
		assert.equal(st.canManage, true);
		const c = await newChat(t, owner.token);
		await ask(t, owner.token, c, "你好 [[reply 世界]]");
		await tick();
		assert.equal(rowCount(t), 0);
		const list = await roundsOf(t, owner.token, c);
		assert.deepEqual({ enabled: list.enabled, rounds: list.rounds, builds: list.builds }, { enabled: false, rounds: [], builds: [] });
		await t.json("GET", `${base(c)}/harness/rounds/hr_nope`, { token: owner.token, expect: 404 });
	} finally {
		await t.dispose();
	}
});

test("harness inspect: on — every round of a tool run is captured with system prompt, tools and the ordered messages", async () => {
	const t = await startTestApp();
	try {
		const owner = await t.user("hi-on@example.com");
		const st = await setSwitch(t, owner.token, true);
		assert.equal(st.enabled, true);
		const c = await newChat(t, owner.token);
		await ask(t, owner.token, c, `请回显 [[call wr_fixture_echo {"text":"ping"}]]`);
		const list = await waitFor(async () => {
			const l = await roundsOf(t, owner.token, c);
			return l.rounds.length >= 2 && l.rounds.every((r) => r.stopReason) ? l : undefined;
		}, { timeoutMs: 10_000, what: "two finished rounds" });
		assert.equal(list.enabled, true);
		assert.deepEqual(list.rounds.map((r) => r.roundIndex), [1, 2]);
		assert.equal(list.rounds[0]!.runId, list.rounds[1]!.runId, "both rounds belong to one run");
		assert.equal(list.rounds[0]!.stopReason, "toolUse");
		assert.equal(list.rounds[1]!.stopReason, "stop");
		assert.equal(list.rounds[1]!.model.modelId, "workroom-fixture");
		assert.ok(list.rounds[1]!.usage, "usage recorded after completion");
		assert.ok(list.rounds[1]!.messageTimestamp, "links to the assistant message it produced");

		const r1 = (await t.json<{ round: HarnessRoundDetailDTO }>("GET", `${base(c)}/harness/rounds/${list.rounds[0]!.id}`, { token: owner.token })).round;
		const r2 = (await t.json<{ round: HarnessRoundDetailDTO }>("GET", `${base(c)}/harness/rounds/${list.rounds[1]!.id}`, { token: owner.token })).round;
		assert.ok(r1.tools.some((x) => x.name === "wr_fixture_echo" && x.description && (x.parameters as any).properties?.text), "tool name, description and JSON schema");
		assert.ok(r1.systemPrompt.length > 0 || r1.systemSections.length > 0 || r1.tools.length > 0);
		const userText = (m: (typeof r1.messages)[number]) => m.content.map((b) => (b.type === "text" ? b.text : "")).join("");
		assert.equal(r1.messages.at(-1)!.role, "user");
		assert.match(userText(r1.messages.at(-1)!), /请回显/);
		assert.equal(r2.messages.length, r1.messages.length + 2, "round 2 adds the assistant tool call and its result");
		const asst = r2.messages.at(-2)!;
		assert.equal(asst.role, "assistant");
		assert.ok(asst.content.some((b) => b.type === "toolCall" && b.name === "wr_fixture_echo"));
		const tool = r2.messages.at(-1)!;
		assert.equal(tool.role, "tool");
		assert.match(userText(tool), /echo\(.*\): ping/);

		// the harness build was recorded for the run
		await waitFor(async () => ((await roundsOf(t, owner.token, c)).builds.length ? true : undefined), { timeoutMs: 5000, what: "build summary" });
		const build = (await roundsOf(t, owner.token, c)).builds[0]!;
		assert.equal(build.runId, list.rounds[0]!.runId);
		assert.ok(build.tools.some((x) => x.name === "wr_fixture_echo" && x.kind === "fixture" && x.offered));
		assert.ok(build.extensions.length > 0);
		assert.equal(build.model?.modelId, "workroom-fixture");
		assert.ok(build.environment);

		// the switch change is audited, and switching off removes what was captured
		const audited = t.app.ctx.db.all<{ action: string }>("SELECT action FROM id_audit WHERE action = 'settings.harness_inspect'");
		assert.equal(audited.length, 1);
		await setSwitch(t, owner.token, false);
		assert.equal(rowCount(t), 0);
		assert.deepEqual((await roundsOf(t, owner.token, c)).rounds, []);
	} finally {
		await t.dispose();
	}
});

test("harness inspect: permission and org isolation", async () => {
	const t = await startTestApp();
	try {
		const owner = await t.user("hi-perm@example.com");
		const member = await invite(t, owner, "plain", "member");
		const admin = await invite(t, owner, "boss", "admin");
		const outsider = await t.user("hi-outsider@example.com"); // its own org
		await setSwitch(t, owner.token, true);
		const c = await newChat(t, owner.token);
		await ask(t, owner.token, c, "hello [[reply hi]]");
		const list = await waitFor(async () => {
			const l = await roundsOf(t, owner.token, c);
			return l.rounds.length ? l : undefined;
		}, { timeoutMs: 8000, what: "captured round" });
		const rid = list.rounds[0]!.id;

		// a plain member cannot flip the switch, read the API, or see the entry point
		await setSwitch(t, member.token, true, 403);
		await roundsOf(t, member.token, c, 403);
		await t.json("GET", `${base(c)}/harness/rounds/${rid}`, { token: member.token, expect: 403 });
		const mst = await t.json("GET", "/api/harness-inspect/status", { token: member.token });
		assert.deepEqual({ canInspect: mst.canInspect, canManage: mst.canManage }, { canInspect: false, canManage: false });

		// an admin holds the permission but still needs access to the conversation (the owner's personal space is private)
		const ast = await t.json("GET", "/api/harness-inspect/status", { token: admin.token });
		assert.equal(ast.canInspect, true);
		const denied = await t.req("GET", `${base(c)}/harness/rounds`, { token: admin.token });
		assert.ok(denied.status === 403 || denied.status === 404, `admin without conversation access → ${denied.status}`);
		const deniedDetail = await t.req("GET", `${base(c)}/harness/rounds/${rid}`, { token: admin.token });
		assert.ok(deniedDetail.status === 403 || deniedDetail.status === 404);

		// another organisation (even with the switch on and the permission) cannot reach it
		await setSwitch(t, outsider.token, true);
		const cross = await t.req("GET", `${base(c)}/harness/rounds`, { token: outsider.token });
		assert.ok(cross.status === 403 || cross.status === 404, `cross-org → ${cross.status}`);
		const crossDetail = await t.req("GET", `${base(c)}/harness/rounds/${rid}`, { token: outsider.token });
		assert.ok(crossDetail.status === 403 || crossDetail.status === 404);
		// and the org-scoped query never returns another org's rows even if asked directly
		const hi = t.app.ctx.services.get("harnessInspect") as HarnessInspect;
		assert.equal(hi.list(outsider.me.orgId, c.spaceId, c.conversationId).length, 0);
		assert.equal(hi.get(outsider.me.orgId, c.spaceId, c.conversationId, rid), undefined);
		assert.ok(hi.get(owner.me.orgId, c.spaceId, c.conversationId, rid));
	} finally {
		await t.dispose();
	}
});

const fakeReq = (over: Partial<InspectRequest> & { messages?: any[] } = {}): InspectRequest => ({
	orgId: "org1",
	spaceId: "sp1",
	userId: "u1",
	conversationId: 1,
	taskId: 7,
	requestKey: `rq_${Math.random()}`,
	startedAt: Date.now(),
	model: { id: "m", provider: "p", api: "openai-completions", contextWindow: 1000, maxTokens: 100, reasoning: false } as never,
	context: { messages: over.messages ?? [{ role: "system", content: "SYS", toolsAdded: [{ name: "t", description: "d", parameters: { type: "object" } }] }, { role: "user", content: "hi", timestamp: 1 }] },
	options: { apiKey: "sk-supersecret1234567890", headers: { authorization: "Bearer abcdefghijklmnop" }, env: { TOKEN: "x" }, temperature: 0.2, reasoning: "high", metadata: { wrSpaceId: "sp1", trace: "abc" } } as never,
	...over,
});

test("harness inspect: credentials never reach storage; text secrets are masked; images become placeholders", async () => {
	const t = await startTestApp();
	try {
		const hi = new HarnessInspect(t.app.ctx);
		const owner = await t.user("hi-secret@example.com");
		hi.setEnabled(owner.me.orgId, owner.me.userId, true);
		const img = "A".repeat(4000);
		const cap = hi.begin(fakeReq({ orgId: owner.me.orgId, messages: [{ role: "system", content: "SYS" }, { role: "user", content: [{ type: "text", text: "my key is sk-abcdefghijklmnop1234" }, { type: "image", mimeType: "image/png", data: img }], timestamp: 1 }] }));
		assert.ok(cap);
		await tick();
		const stored = t.app.ctx.db.get<{ payload: string; thinking_level: string }>("SELECT payload, thinking_level FROM ops_harness_rounds")!;
		assert.doesNotMatch(stored.payload, /supersecret|abcdefghijklmnop\b|Bearer|"TOKEN"|AAAA/);
		assert.doesNotMatch(stored.payload, /sk-abcdefghijklmnop1234/);
		const p = JSON.parse(stored.payload);
		assert.equal(p.options.temperature, 0.2);
		assert.equal(p.options.reasoning, "high");
		assert.deepEqual(p.options.metadata, { trace: "abc" });
		assert.deepEqual(p.messages[0].content[1], { type: "image", mimeType: "image/png", bytes: 3000 });
		assert.equal(stored.thinking_level, "high");
	} finally {
		await t.dispose();
	}
});

test("harness inspect: retention — per-conversation cap and per-record size cap with truncation markers", async () => {
	const t = await startTestApp();
	try {
		const owner = await t.user("hi-ret@example.com");
		const orgId = owner.me.orgId;
		const hi = new HarnessInspect(t.app.ctx, { maxRoundsPerConversation: 3, maxRecordBytes: 20_000, retentionDays: 14 });
		hi.setEnabled(orgId, owner.me.userId, true);
		for (let i = 1; i <= 5; i++) {
			hi.begin(fakeReq({ orgId, startedAt: 1000 + i, taskId: 7 + i }))!;
			await tick();
		}
		const rows = hi.list(orgId, "sp1", 1);
		assert.equal(rows.length, 3, "oldest rounds are dropped past the cap");
		assert.deepEqual(rows.map((r) => r.startedAt), [1003, 1004, 1005]);
		// another conversation is unaffected
		hi.begin(fakeReq({ orgId, conversationId: 2 }));
		await tick();
		assert.equal(hi.list(orgId, "sp1", 2).length, 1);

		// a huge transcript is cut down under the byte cap, flagged, with a visible marker
		const big = "x".repeat(300_000);
		const messages = [{ role: "system", content: "SYS" }, ...Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `${i}:${big}`, timestamp: i }))];
		hi.begin(fakeReq({ orgId, conversationId: 3, messages }));
		await tick();
		const sum = hi.list(orgId, "sp1", 3)[0]!;
		assert.equal(sum.truncated, true);
		assert.ok(sum.sizeBytes <= 20_000, `size ${sum.sizeBytes}`);
		const detail = hi.get(orgId, "sp1", 3, sum.id)!;
		assert.ok(detail.messages.some((m) => m.omitted && /省略/.test((m.content[0] as any).text)), "dropped messages are announced");
		assert.ok(detail.messages.some((m) => m.content.some((b) => b.type === "text" && /已截断/.test(b.text))));

		const pure = buildPayload(fakeReq({ messages: [{ role: "system", content: "S" }, { role: "user", content: "y".repeat(500_000), timestamp: 1 }] }), 1_500_000);
		assert.equal(pure.truncated, true);
		assert.ok(pure.bytes <= 1_500_000);
	} finally {
		await t.dispose();
	}
});
