// Round 16 — harness context cost and discoverability. Real app + fixture model + the Harness 检视 capture (the exact request sent to the model). Run:
//   node --disable-warning=ExperimentalWarning --test --test-concurrency=1 server/test/r16-harness-context.test.ts
process.env.WORKROOM_FIXTURE_TOOLS = "1";
process.env.WORKROOM_RT_RETRY_BASE_MS ??= "20";
process.env.WORKROOM_RT_RETRY_MAX ??= "1";
process.env.WORKROOM_SSE_THROTTLE_MS ??= "20";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { isSettled, waitFor } from "../src/runtime/testing.ts";
import { oldConversation } from "./helpers/legacy-conversation.ts";
import { ONDEMAND_TOOLS, rankScore } from "../src/tools/ondemand.ts";
import { renderCatalog, WORKING_RULES } from "../src/tools/harness-prompt.ts";
import type { HarnessRoundDetailDTO, HarnessRoundsResponse } from "../../shared/harness-inspect.ts";
import type { SubmissionDTO } from "../../shared/chat.ts";

type Conv = { spaceId: string; conversationId: number };
const base = (c: Conv) => `/api/conversations/${c.spaceId}/${c.conversationId}`;
const newChat = async (t: TestApp, token: string, json: Record<string, unknown> = {}): Promise<Conv> => (await t.json("POST", "/api/conversations", { token, json })).conversation;

async function ask(t: TestApp, token: string, c: Conv, text: string): Promise<void> {
	const r = await t.json("POST", `${base(c)}/messages`, { token, json: { text, requestId: randomUUID() } });
	await waitFor(async () => {
		const s = (await t.json("GET", `${base(c)}/submissions/${r.submissionId}`, { token })) as SubmissionDTO;
		return isSettled(s) ? s : undefined;
	}, { timeoutMs: 15_000, what: "submission settles" });
}

/** Every finished round of the conversation, oldest first, with the full captured request. */
async function rounds(t: TestApp, token: string, c: Conv, n: number): Promise<HarnessRoundDetailDTO[]> {
	const list = await waitFor(async () => {
		const l = await t.json<HarnessRoundsResponse>("GET", `${base(c)}/harness/rounds`, { token });
		return l.rounds.length >= n && l.rounds.every((r) => r.stopReason) ? l : undefined;
	}, { timeoutMs: 10_000, what: `${n} finished rounds` });
	return Promise.all(list.rounds.map(async (r) => (await t.json<{ round: HarnessRoundDetailDTO }>("GET", `${base(c)}/harness/rounds/${r.id}`, { token })).round));
}

// No tokenizer ships with the repo: ASCII ≈ 3.5 chars/token (JSON punctuation included), each CJK character ≈ 1 token. Calibrated against the
// pre-change greeting request: 9.3k estimated vs 8,092 provider-reported input tokens, i.e. it over-estimates by ~15% (docs/r16-harness-context.md).
export function estimateTokens(s: string): number {
	const cjk = (s.match(/[　-鿿＀-￯]/g) ?? []).length;
	return Math.round(cjk + (s.length - cjk) / 3.5);
}
const requestText = (r: HarnessRoundDetailDTO) => `${r.systemPrompt}\n${JSON.stringify(r.tools)}`;
const toolsJson = (r: HarnessRoundDetailDTO) => JSON.stringify(r.tools).length;

async function inspectOn(t: TestApp, name: string) {
	const o = await t.user(`${name}@example.com`);
	await t.json("PUT", "/api/admin/settings/harness-inspect", { token: o.token, json: { enabled: true } });
	return o;
}

test("greeting: small request, no duplicated interface text, rules first, capabilities discoverable", async () => {
	const t = await startTestApp();
	try {
		const o = await inspectOn(t, "r16-greet");
		const c = await newChat(t, o.token);
		await ask(t, o.token, c, "你好呀");
		const [r] = await rounds(t, o.token, c, 1);
		const names = r!.tools.map((x) => x.name);
		for (const n of ONDEMAND_TOOLS) assert.ok(!names.includes(n), `${n} is not offered up front`);
		assert.ok(names.includes("tool_search"), "tool_search is the way to the on-demand tools");
		assert.ok(names.includes("exec") && names.includes("present_file") && names.includes("read"), "everyday tools stay offered");

		// the same interface text is not in the system prompt a second time
		for (const x of r!.tools) {
			const head = x.description.slice(0, 40);
			assert.ok(head.length < 20 || !r!.systemPrompt.includes(head), `${x.name} description is repeated in the system prompt`);
		}
		assert.ok(!r!.systemSections.some((s) => s.key === "codemode"), "no catalog of every tool's declaration");
		assert.deepEqual(r!.systemSections.map((s) => s.key).slice(0, 2), ["rules", "on_demand"], "standing rules first, then the capability catalog");
		assert.ok(r!.systemPrompt.includes(WORKING_RULES));
		assert.ok(WORKING_RULES.length <= 700, `rules stay short (${WORKING_RULES.length})`);
		for (const n of ["credential_request", "job_start", "browser_open", "skill_manage", "codemode", "tool_search"]) assert.ok(r!.systemPrompt.includes(n), `${n} is named in the catalog`);

		// budget with a wide margin (measured: ~1.3k system chars + ~5.2k tools JSON; before the change 11.0k + 15.7k)
		assert.ok(r!.systemPrompt.length < 3000, `system prompt ${r!.systemPrompt.length}`);
		assert.ok(toolsJson(r!) < 8000, `tools JSON ${toolsJson(r!)}`);
		assert.ok(requestText(r!).length < 10_000, `request ${requestText(r!).length}`);
		console.log(`[r16 greeting] system=${r!.systemPrompt.length} chars, tools=${r!.tools.length} (${toolsJson(r!)} chars JSON), est. input tokens=${estimateTokens(requestText(r!))}`);
	} finally {
		await t.dispose();
	}
});

test("on-demand tool: tool_search loads it, the next round and the next run still offer it, and it runs", async () => {
	const t = await startTestApp();
	try {
		const o = await inspectOn(t, "r16-load");
		const c = await newChat(t, o.token);
		await ask(t, o.token, c, `查一下后台任务 [[call tool_search {"query":"查看后台任务进度"}]]`);
		const [r1, r2] = await rounds(t, o.token, c, 2);
		assert.ok(!r1!.tools.some((x) => x.name === "job_status"));
		assert.ok(r2!.tools.some((x) => x.name === "job_status" && x.description && (x.parameters as any)), "loaded for the very next round, with its full schema");
		assert.ok(r2!.tools.some((x) => x.name === "job_start") && r2!.tools.some((x) => x.name === "job_cancel"), "the whole group is loaded");
		assert.ok(!r2!.systemPrompt.includes("后台长任务（"), "a loaded group leaves the catalog");
		const result = r2!.messages.findLast((m) => m.role === "tool")!;
		assert.match(JSON.stringify(result.content), /Loaded \d+ tool/);

		// next run of the same conversation: still offered and callable
		await ask(t, o.token, c, `[[call job_status {}]]`);
		const all = await rounds(t, o.token, c, 4);
		assert.ok(all[2]!.tools.some((x) => x.name === "job_status"), "still offered in a later run");
		const last = all.at(-1)!;
		const lastTool = last.messages.findLast((m) => m.role === "tool")!;
		assert.ok(!JSON.stringify(lastTool.content).includes("not available") && !lastTool.isError, "job_status ran (not rejected as unoffered)");
		console.log(`[r16 deferred task] round1=${estimateTokens(requestText(r1!))} + round2=${estimateTokens(requestText(r2!))} est. tokens (extra round: ${estimateTokens(requestText(r1!))})`);

		// a fresh conversation starts without it again (loading is per conversation)
		const c2 = await newChat(t, o.token);
		await ask(t, o.token, c2, "你好");
		assert.ok(!(await rounds(t, o.token, c2, 1))[0]!.tools.some((x) => x.name === "job_status"));
	} finally {
		await t.dispose();
	}
});

test("tool_search: Chinese queries find the right group; org policy still switches groups off", async () => {
	const t = await startTestApp();
	try {
		const o = await inspectOn(t, "r16-search");
		const c = await newChat(t, o.token);
		await ask(t, o.token, c, `[[call tool_search {"query":"需要用户提供 API 密钥来调用接口"}]]`);
		const [, r2] = await rounds(t, o.token, c, 2);
		assert.ok(r2!.tools.some((x) => x.name === "credential_request"), "credential tools found by a Chinese need");
		assert.ok(!r2!.tools.some((x) => x.name === "browser_open"), "unrelated groups stay out");

		await t.json("PUT", "/api/tools/policy", { token: o.token, json: { groups: { browser: false } } });
		const c2 = await newChat(t, o.token);
		await ask(t, o.token, c2, `[[call tool_search {"query":"打开浏览器网页 点击"}]]`);
		const rs = await rounds(t, o.token, c2, 2);
		assert.ok(!rs[1]!.tools.some((x) => x.name === "browser_open"), "a group switched off by the organisation is not loadable");
		assert.ok(!rs[0]!.systemPrompt.includes("实时浏览器"), "...and not advertised");
	} finally {
		await t.dispose();
	}
});

test("assistants: a tool allowlist offers exactly those tools (on-demand ones included); [] offers none", async () => {
	const t = await startTestApp();
	try {
		const o = await inspectOn(t, "r16-assist");
		const { assistant } = await t.json("POST", "/api/assistants", { token: o.token, json: { name: "受限助手", members: [], tools: ["ls", "job_status"] } });
		const c = await newChat(t, o.token, { assistantId: assistant.id });
		await ask(t, o.token, c, `[[call job_status {}]]`);
		const [r1, r2] = await rounds(t, o.token, c, 2);
		assert.deepEqual(r1!.tools.map((x) => x.name).sort(), ["job_status", "ls"]);
		assert.ok(!r1!.systemSections.some((s) => s.key === "on_demand"), "nothing could load the on-demand tools: no catalog");
		assert.ok(!JSON.stringify(r2!.messages.findLast((m) => m.role === "tool")!.content).includes("not available"), "the allowed on-demand tool runs");

		const none = (await t.json("POST", "/api/assistants", { token: o.token, json: { name: "无工具助手", members: [], tools: [] } })).assistant;
		const c2 = await newChat(t, o.token, { assistantId: none.id });
		await ask(t, o.token, c2, "你好");
		assert.deepEqual((await rounds(t, o.token, c2, 1))[0]!.tools, []);
	} finally {
		await t.dispose();
	}
});

test("conversation created before round 16 keeps offering every tool (nothing hidden, no catalog) and still executes them", async () => {
	const t = await startTestApp();
	try {
		const o = await inspectOn(t, "r16-old");
		const c = await oldConversation(t, o.me.userId, o.me.orgId, "旧会话");
		await ask(t, o.token, c, `[[call job_status {}]]`);
		const [r1, r2] = await rounds(t, o.token, c, 2);
		for (const n of ["job_status", "credential_request", "browser_open", "skill_manage", "codemode"]) assert.ok(r1!.tools.some((x) => x.name === n), `${n} still offered`);
		assert.ok(!r1!.systemSections.some((s) => s.key === "on_demand"), "nothing is on demand there");
		assert.ok(r1!.systemSections.some((s) => s.key === "rules"), "the standing rules apply to old conversations too");
		assert.ok(r1!.systemPrompt.length < 3500, `Code Mode catalog no longer duplicated (${r1!.systemPrompt.length})`);
		const res = r2!.messages.findLast((m) => m.role === "tool")!;
		assert.ok(!res.isError && !JSON.stringify(res.content).includes("not available"), "the call ran");
	} finally {
		await t.dispose();
	}
});

test("pure helpers: ranking handles Chinese and English; catalog lists only what is hidden", () => {
	assert.ok(rankScore("后台长任务进度", "job status 后台长任务 异步 进度") > rankScore("后台长任务进度", "browser click 浏览器"));
	assert.ok(rankScore("create calendar event", "calendar create event") > 0);
	assert.equal(rankScore("", "anything"), 0);
	assert.equal(renderCatalog([], 0), undefined);
	const only = renderCatalog(["job_start"], 3)!;
	assert.match(only, /job_start/);
	assert.doesNotMatch(only, /credential_request/);
	assert.match(only, /3 个连接器工具/);
});

test("code mode: loaded on demand; a script reaches on-demand tools by name and can read their declarations", async () => {
	const t = await startTestApp();
	try {
		const o = await inspectOn(t, "r16-code");
		const c = await newChat(t, o.token);
		await ask(t, o.token, c, `[[call tool_search {"query":"脚本编排 批量调用工具"}]]`);
		const [, r2] = await rounds(t, o.token, c, 2);
		assert.ok(r2!.tools.some((x) => x.name === "codemode"));
		assert.ok(r2!.systemSections.some((s) => s.key === "codemode") && r2!.systemPrompt.includes("describeTool"), "short Code Mode note once loaded");
		assert.ok(r2!.systemPrompt.length < 3500, "no per-tool declaration catalog");
		const code = "const d = await describeTool('credential_http'); const s = await tools.job_status({}); return JSON.stringify({ d: JSON.stringify(d).includes('url'), s: String(s).length > 0 });";
		await ask(t, o.token, c, `[[call codemode ${JSON.stringify({ code })}]]`);
		const all = await rounds(t, o.token, c, 4);
		const out = JSON.stringify(all.at(-1)!.messages.findLast((m) => m.role === "tool")!.content);
		assert.match(out, /d\\":true/, out);
		assert.match(out, /s\\":true/, out);
	} finally {
		await t.dispose();
	}
});
