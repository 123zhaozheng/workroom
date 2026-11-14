// Conversational "整理为技能" (skill distill + session_trace + built-in skill 「会话经验提炼」).
// Run: node --disable-warning=ExperimentalWarning --test server/test/skill-distill.test.ts
process.env.WORKROOM_FIXTURE_TOOLS = "1";
process.env.WORKROOM_RT_RETRY_BASE_MS ??= "20";
process.env.WORKROOM_RT_RETRY_MAX ??= "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { orgMember } from "./fixtures/util.ts";
import { waitFor } from "../src/runtime/testing.ts";
import { isSettled } from "../src/runtime/testing.ts";
import {
	buildTraceItems,
	buildTraceOverview,
	paginateTrace,
	redactTraceText,
	searchTraceItems,
	sliceTraceItem,
} from "../src/tools/skill-distill.ts";
import { BUILTIN_DISTILL_SKILL_NAME, SESSION_TRACE_TOOL } from "../../shared/skill-distill.ts";
import type { HarnessRoundDetailDTO, HarnessRoundsResponse } from "../../shared/harness-inspect.ts";
import type { SubmissionDTO } from "../../shared/chat.ts";

type Conv = { spaceId: string; conversationId: number };
const base = (c: Conv) => `/api/conversations/${c.spaceId}/${c.conversationId}`;

async function ask(t: TestApp, token: string, c: Conv, text: string): Promise<void> {
	const r = await t.json("POST", `${base(c)}/messages`, { token, json: { text, requestId: randomUUID() } });
	await waitFor(
		async () => {
			const s = (await t.json("GET", `${base(c)}/submissions/${r.submissionId}`, { token })) as SubmissionDTO;
			return isSettled(s) ? s : undefined;
		},
		{ timeoutMs: 20_000, what: "submission settles" },
	);
}

async function state(t: TestApp, token: string, c: Conv) {
	return t.json("GET", `${base(c)}/state`, { token });
}

test("pure helpers: redact secrets, paginate list (max 50, summaries <=200), slice get (max 8000, nextFrom), search (max 20 hits)", () => {
	const longBody = "A".repeat(9500) + " secret=my_super_secret_token sk-ant-abcdefghijklmnop error_marker_xyz " + "B".repeat(2000);
	const entries: any[] = [];
	for (let i = 1; i <= 60; i++) {
		entries.push({
			id: i,
			conversationId: 1,
			kind: i % 2 === 1 ? "wr.input" : "pi.assistant",
			model: [
				{
					role: i % 2 === 1 ? "user" : "assistant",
					timestamp: 1_700_000_000_000 + i * 1000,
					content:
						i === 1
							? [{ type: "text", text: "请帮我把周报按模板整理出来，token=secret_123456 " + "详情".repeat(120) }]
							: i === 2
								? [{ type: "text", text: longBody }]
								: [{ type: "text", text: `第 ${i} 条消息，包含关键词 needle_hit_${i} ` + "内容".repeat(90) }],
				},
			],
			data: i % 2 === 1 ? { text: i === 1 ? "请帮我把周报按模板整理出来，token=secret_123456 " + "详情".repeat(120) : `第 ${i} 条用户消息 needle_hit_${i} ` + "内容".repeat(90) } : undefined,
		});
	}

	const toolCalls = [
		{
			id: "tc_1",
			tool: "write",
			args_summary: JSON.stringify({ path: "/work/a.md", token: "[REDACTED]" }),
			status: "ok",
			error: null,
			result_summary: "ok",
			call_id: null,
			started_at: new Date(1_700_000_002_500).toISOString(),
			started_ms: 1_700_000_002_500,
			duration_ms: 12,
		},
		{
			id: "tc_2",
			tool: "exec",
			args_summary: JSON.stringify({ command: "echo hi" }),
			status: "error",
			error: "Authorization: Bearer abcdef1234567890 failed needle_hit_err",
			result_summary: null,
			call_id: null,
			started_at: new Date(1_700_000_003_500).toISOString(),
			started_ms: 1_700_000_003_500,
			duration_ms: 50,
		},
	];

	const files = [
		{
			id: "fv_1",
			file_id: "f_1",
			version_no: 1,
			name: "周报.md",
			mime: "text/markdown",
			size: 1024,
			origin: "agent",
			tool: "present_file",
			change_note: null,
			created_at: new Date(1_700_000_004_500).toISOString(),
		},
	];

	const built = buildTraceItems({ entries, toolCalls, files, createdAt: new Date(1_700_000_000_000).toISOString() });
	assert.equal(built.items.length, 63);
	assert.ok(built.firstUserRequest.length <= 300);
	assert.ok(!built.firstUserRequest.includes("secret_123456"), "secret in firstUserRequest is redacted");

	for (const it of built.items) {
		assert.ok(it.summary.length <= 200, `summary <= 200 (got ${it.summary.length})`);
		assert.ok(!it.fullText.includes("secret_123456"));
		assert.ok(!it.fullText.includes("my_super_secret_token"));
		assert.ok(!it.fullText.includes("sk-ant-abcdefghijklmnop"));
		assert.ok(!it.fullText.includes("abcdef1234567890"));
	}

	// list pagination: default limit 20, max clamped to 50
	const p1 = paginateTrace(built.items, 0, 20);
	assert.equal(p1.items.length, 20);
	assert.equal(p1.total, 63);
	assert.equal(p1.nextOffset, 20);

	const pClamped = paginateTrace(built.items, 0, 999);
	assert.equal(pClamped.items.length, 50, "limit clamped to 50");
	assert.equal(pClamped.nextOffset, 50);

	const pLast = paginateTrace(built.items, 50, 50);
	assert.equal(pLast.items.length, 13);
	assert.equal(pLast.nextOffset, null);

	// get slicing: max 8000 chars per call, nextFrom advances cleanly
	const longItem = built.items.find((x) => x.id === "e2")!;
	const s1 = sliceTraceItem(longItem, 0, 99999);
	assert.equal(s1.text.length, 8000, "length clamped to 8000");
	assert.equal(s1.nextFrom, 8000);
	assert.equal(s1.total, longItem.fullText.length);

	const s2 = sliceTraceItem(longItem, s1.nextFrom!, 8000);
	assert.equal(s2.nextFrom, null);
	assert.equal(s1.text + s2.text, longItem.fullText);

	// search: case-insensitive, <= 20 hits, snippet <= 200
	const hits = searchTraceItems(built.items, "NEEDLE_HIT");
	assert.equal(hits.hits.length, 20);
	assert.equal(hits.truncated, true);
	assert.ok(hits.totalHits > 20);
	for (const h of hits.hits) {
		assert.ok(h.snippet.length <= 200, `snippet <= 200 (got ${h.snippet.length})`);
	}

	const errHits = searchTraceItems(built.items, "error_marker_xyz");
	assert.equal(errHits.hits.length, 1);
	assert.equal(errHits.hits[0]!.id, "e2");

	// overview bounded
	const ov = buildTraceOverview({
		spaceId: "sp_1",
		conversationId: 1,
		title: "测试会话",
		createdAt: new Date(1_700_000_000_000).toISOString(),
		items: built.items,
		toolCalls,
		files,
		firstUserRequest: built.firstUserRequest,
		userTurns: built.userTurns,
		assistantTurns: built.assistantTurns,
	});
	assert.equal(ov.counts.toolCallsOk, 1);
	assert.equal(ov.counts.toolCallsFailed, 1);
	assert.equal(ov.counts.filesProduced, 1);
	assert.ok(JSON.stringify(ov).length <= 3000);

	// redactTraceText covers AWS, GitHub, Slack, JWT, Bearer, PEM private keys
	const redacted = redactTraceText("AKIAABCDEFGHIJKLMNOP ghp_123456789012345678901234567890123456 xoxb-123456789012-abcdef");
	assert.doesNotMatch(redacted, /AKIAABCDEFGHIJKLMNOP/);
	assert.doesNotMatch(redacted, /ghp_1234567890/);
	assert.doesNotMatch(redacted, /xoxb-1234567890/);
});

test("POST /api/skills/distill + GET link + ACL + prompt section + session_trace tool + skill_manage flow", async () => {
	const t = await startTestApp();
	try {
		const owner = await t.user("distill-owner@example.com");
		const member = await orgMember(t, owner, "distill-member@example.com");
		// Enable harness inspect so we can verify system prompt sections cleanly
		await t.json("PUT", "/api/admin/settings/harness-inspect", { token: owner.token, json: { enabled: true } });

		// 1. Create a source conversation with real tool calls (write + present_file) and messages
		const src: Conv = (await t.json("POST", "/api/conversations", { token: owner.token, json: { title: "整理季度销售数据" } })).conversation;
		await ask(
			t,
			owner.token,
			src,
			`帮我整理销售数据 [[call write ${JSON.stringify({ path: "/work/summary.md", content: "# Q1 销售汇总\n总计 100 万" })}]]`,
		);
		await ask(
			t,
			owner.token,
			src,
			`把报告交付给我 [[call present_file ${JSON.stringify({ source: "/work/summary.md", name: "Q1销售汇总.md" })}]]`,
		);

		// 2. Normal conversation returns 404 from GET /api/skills/distill/:spaceId/:conversationId
		await t.json("GET", `/api/skills/distill/${src.spaceId}/${src.conversationId}`, { token: owner.token, expect: 404 });

		// 3. Another org member without access to src gets 403 on POST /api/skills/distill
		await t.json("POST", "/api/skills/distill", { token: member.token, json: { spaceId: src.spaceId, conversationId: src.conversationId }, expect: 403 });

		// 4. Owner starts distill → 200, new conversation in personal space, prefilled prompt, nothing auto-sent
		const started = await t.json("POST", "/api/skills/distill", {
			token: owner.token,
			json: { spaceId: src.spaceId, conversationId: src.conversationId },
		});
		const personalSpace = t.app.ctx.services.get("identity").personalSpace(owner.me.userId, owner.me.orgId);
		assert.equal(started.conversation.spaceId, personalSpace.id);
		assert.notEqual(started.conversation.conversationId, src.conversationId);
		assert.equal(started.conversation.title, "整理为技能：整理季度销售数据");
		assert.deepEqual(started.source, { spaceId: src.spaceId, conversationId: src.conversationId, title: "整理季度销售数据" });

		// Verify prompt content & size
		assert.match(started.prompt, new RegExp(BUILTIN_DISTILL_SKILL_NAME));
		assert.match(started.prompt, /session_trace/);
		assert.match(started.prompt, /skill_manage/);
		assert.match(started.prompt, /整理季度销售数据/);
		assert.match(started.prompt, /能力 › 我的技能/);
		assert.match(started.prompt, /提交审核/);
		assert.match(started.prompt, /帮我整理销售数据/);
		assert.ok(Buffer.byteLength(started.prompt, "utf8") <= 1600, `prompt should be ~1.5KB max, got ${Buffer.byteLength(started.prompt, "utf8")} bytes`);

		const distillConv: Conv = { spaceId: started.conversation.spaceId, conversationId: started.conversation.conversationId };
		// Nothing auto-sent
		const initialState = await state(t, owner.token, distillConv);
		assert.equal(
			initialState.entries.filter((e: any) => e.kind === "user" || e.kind === "assistant").length,
			0,
			"distill conversation starts with no auto-sent messages",
		);

		// 5. GET /api/skills/distill/:spaceId/:conversationId works for owner and rejects member
		const linkRes = await t.json("GET", `/api/skills/distill/${distillConv.spaceId}/${distillConv.conversationId}`, { token: owner.token });
		assert.deepEqual(linkRes.source, started.source);
		await t.json("GET", `/api/skills/distill/${distillConv.spaceId}/${distillConv.conversationId}`, { token: member.token, expect: 403 });

		// 6. Calling session_trace inside the distill conversation uses linked source by default, and prompt section is injected ONLY here
		await ask(
			t,
			owner.token,
			distillConv,
			`[[call ${SESSION_TRACE_TOOL} {"action":"overview"}]] [[call ${SESSION_TRACE_TOOL} {"action":"list","limit":2}]]`,
		);
		const dState = await state(t, owner.token, distillConv);
		const traceResults = dState.entries.filter((e: any) => e.kind === "tool_result" && e.toolName === SESSION_TRACE_TOOL);
		assert.equal(traceResults.length, 2);
		const ov = JSON.parse(traceResults[0].text);
		assert.equal(ov.title, "整理季度销售数据");
		assert.equal(ov.counts.userTurns, 2);
		assert.equal(ov.counts.filesProduced, 1);
		assert.ok(ov.toolsUsed.some((x: any) => x.tool === "write"));
		assert.ok(ov.filesProduced.some((f: any) => f.name === "Q1销售汇总.md"));

		const listPage = JSON.parse(traceResults[1].text);
		assert.equal(listPage.items.length, 2);
		assert.ok(listPage.total >= 4);
		assert.equal(listPage.nextOffset, 2);

		// get & search on linked source
		const firstId = listPage.items[0].id;
		await ask(
			t,
			owner.token,
			distillConv,
			`[[call ${SESSION_TRACE_TOOL} {"action":"get","id":${JSON.stringify(firstId)},"from":0,"length":200}]] [[call ${SESSION_TRACE_TOOL} {"action":"search","query":"Q1 销售"}]]`,
		);
		const dState2 = await state(t, owner.token, distillConv);
		const traceResults2 = dState2.entries.filter((e: any) => e.kind === "tool_result" && e.toolName === SESSION_TRACE_TOOL);
		const got = JSON.parse(traceResults2[2].text);
		assert.equal(got.item.id, firstId);
		assert.match(got.text, /帮我整理销售数据/);
		const searched = JSON.parse(traceResults2[3].text);
		assert.ok(searched.hits.length >= 1);

		// Verify system prompt section in distill conversation vs normal conversation
		const roundsDistill = await t.json<HarnessRoundsResponse>("GET", `${base(distillConv)}/harness/rounds`, { token: owner.token });
		const roundDetail = (
			await t.json<{ round: HarnessRoundDetailDTO }>("GET", `${base(distillConv)}/harness/rounds/${roundsDistill.rounds[0]!.id}`, {
				token: owner.token,
			})
		).round;
		assert.ok(roundDetail.systemSections.some((s) => s.key === "skill_distill"), "skill_distill section injected in distill conversation");
		assert.match(roundDetail.systemPrompt, new RegExp(BUILTIN_DISTILL_SKILL_NAME));
		assert.match(roundDetail.systemPrompt, /整理季度销售数据/);

		const roundsSrc = await t.json<HarnessRoundsResponse>("GET", `${base(src)}/harness/rounds`, { token: owner.token });
		const srcRound = (
			await t.json<{ round: HarnessRoundDetailDTO }>("GET", `${base(src)}/harness/rounds/${roundsSrc.rounds[0]!.id}`, { token: owner.token })
		).round;
		assert.ok(!srcRound.systemSections.some((s) => s.key === "skill_distill"), "skill_distill section NOT injected in normal conversation");

		// 7. session_trace in a normal conversation without explicit target fails; targeting someone else's conversation fails with 403
		await ask(t, owner.token, src, `[[call ${SESSION_TRACE_TOOL} {"action":"overview"}]]`);
		const srcState = await state(t, owner.token, src);
		const missingRes = srcState.entries.find((e: any) => e.kind === "tool_result" && e.toolName === SESSION_TRACE_TOOL);
		assert.equal(missingRes.isError, true);

		const memberConv: Conv = (await t.json("POST", "/api/conversations", { token: member.token, json: { title: "成员会话" } })).conversation;
		await ask(
			t,
			member.token,
			memberConv,
			`[[call ${SESSION_TRACE_TOOL} {"action":"overview","spaceId":${JSON.stringify(src.spaceId)},"conversationId":${src.conversationId}}]]`,
		);
		const memberState = await state(t, member.token, memberConv);
		const forbiddenRes = memberState.entries.find((e: any) => e.kind === "tool_result" && e.toolName === SESSION_TRACE_TOOL);
		assert.equal(forbiddenRes.isError, true);
		assert.match(forbiddenRes.text, /无权访问|拒绝|权限|forbidden|403/i);

		// 8. End-to-end creation via write + tool_search(skill_manage) + skill_manage submit_draft → approve → personal skill
		const skillMd = `---
name: sales-summary-distill
title: 季度销售汇总
description: 根据原始销售明细整理季度汇总报告并交付给用户。当用户要求整理季度销售数据时使用。
version: 1.0.0
---

# 季度销售汇总

## 何时使用
当需要按季度汇总销售明细并输出 Markdown 报告时使用。

## 步骤
1. 整理核心指标与总计，写入工作区文档。
2. 调用 present_file 交付给用户。
`;
		await ask(
			t,
			owner.token,
			distillConv,
			`[[call write ${JSON.stringify({ path: "/work/sales-summary-distill/SKILL.md", content: skillMd })}]] [[call tool_search {"query":"创建技能 skill_manage"}]]`,
		);
		await t.json("POST", `${base(distillConv)}/messages`, {
			token: owner.token,
			json: { text: `[[call skill_manage {"action":"submit_draft","dir":"sales-summary-distill"}]]`, requestId: randomUUID() },
		});
		const ap = await waitFor(async () => (await state(t, owner.token, distillConv)).approvals.find((a: any) => a.status === "pending"), {
			timeoutMs: 10_000,
			what: "skill_manage approval",
		});
		assert.equal(ap.toolName, "skill_manage");
		await t.json("POST", `${base(distillConv)}/approvals/${encodeURIComponent(ap.approvalId)}`, {
			token: owner.token,
			json: { decision: "approved" },
		});
		await waitFor(
			async () => {
				const s = await state(t, owner.token, distillConv);
				return !s.live.busy && s.queue.length === 0 ? s : undefined;
			},
			{ timeoutMs: 20_000, what: "skill_manage saved" },
		);

		const mySkills = await t.json("GET", "/api/skills", { token: owner.token });
		assert.ok(mySkills.skills.some((sk: any) => sk.slug === "sales-summary-distill" && sk.scope === "personal"), "distilled skill saved as personal skill");

		// 9. Shared project conversation: another member with read share CAN distill into their own personal space
		const { project } = await t.json("POST", "/api/projects", { token: owner.token, json: { name: "共享项目" } });
		await t.json("PUT", `/api/projects/${project.id}/shares/${member.me.userId}`, { token: owner.token, json: {} });
		await t.json("PUT", `${base(src)}/project`, { token: owner.token, json: { projectId: project.id } });
		const memberDistill = await t.json("POST", "/api/skills/distill", {
			token: member.token,
			json: { spaceId: src.spaceId, conversationId: src.conversationId },
		});
		const memberSpace = t.app.ctx.services.get("identity").personalSpace(member.me.userId, member.me.orgId);
		assert.equal(memberDistill.conversation.spaceId, memberSpace.id, "distill conversation is created in caller's own personal space");
	} finally {
		await t.dispose();
	}
});
