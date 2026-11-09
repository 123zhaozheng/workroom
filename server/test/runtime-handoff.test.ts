// M09-B handoff: a project member takes over with decisions, progress, pending items, deliverables, participants.
//   node --disable-warning=ExperimentalWarning --test server/test/runtime-handoff.test.ts
process.env.WORKROOM_FIXTURE_TOOLS = "1";
process.env.WORKROOM_RT_RETRY_BASE_MS ??= "20";
process.env.WORKROOM_RT_RETRY_MAX ??= "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { isSettled, waitFor } from "../src/runtime/testing.ts";
import type { ConversationHandoff, ProjectHandoff, SubmissionDTO } from "../../shared/chat.ts";

const rid = () => randomUUID();
type Conv = { spaceId: string; conversationId: number };
const base = (c: Conv) => `/api/conversations/${c.spaceId}/${c.conversationId}`;
const send = (t: TestApp, token: string, c: Conv, text: string) => t.json("POST", `${base(c)}/messages`, { token, json: { text, requestId: rid() } });
const settle = (t: TestApp, token: string, c: Conv, id: number) =>
	waitFor(async () => {
		const s = (await t.json("GET", `${base(c)}/submissions/${id}`, { token })) as SubmissionDTO;
		return isSettled(s) ? s : undefined;
	}, { timeoutMs: 20_000, what: `submission ${id}` });

test("M09-B handoff: editor takes over (reads handoff, approves, continues); viewer reads only; removed member 403", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("ho-a@example.com", { name: "Alice" });
		const inv = async () => (await t.json("POST", "/api/admin/invites", { token: a.token, json: { role: "member" } })).invite.code;
		const b = await t.user("ho-b@example.com", { inviteCode: await inv(), name: "Bob" });
		const v = await t.user("ho-c@example.com", { inviteCode: await inv(), name: "Carol" });
		const { project } = await t.json("POST", "/api/projects", { token: a.token, json: { name: "交接项目" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: a.token, json: { email: "ho-b@example.com", role: "editor" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: a.token, json: { email: "ho-c@example.com", role: "viewer" } });
		const { conversation: c } = await t.json("POST", "/api/conversations", { token: a.token, json: { projectId: project.id, title: "客户方案" } });
		const hasFiles = t.app.ctx.services.has("files");

		// A works: a deliverable, an external write with unknown outcome, then an approval left pending
		if (hasFiles) await settle(t, a.token, c, (await send(t, a.token, c, `[[call file_create {"name":"方案草稿","format":"md","content":"# 方案\\n要点"}]]`)).submissionId);
		await settle(t, a.token, c, (await send(t, a.token, c, `[[call wr_fixture_effect {"key":"crm-sync","unknownOutcome":true}]]`)).submissionId);
		const pend = await send(t, a.token, c, `[[call wr_fixture_approval {"title":"发送方案","summary":"把方案邮件发给客户"}]]`);
		await waitFor(async () => ((await t.json("GET", `${base(c)}/handoff`, { token: a.token })) as ConversationHandoff).pending.approvals.length === 1, { what: "approval pending" });

		// B reads the handoff
		let h: ConversationHandoff = await t.json("GET", `${base(c)}/handoff`, { token: b.token });
		assert.equal(h.status, "waiting_approval");
		assert.equal(h.access.canWrite, true);
		assert.equal(h.pending.approvals[0]!.summary, "把方案邮件发给客户");
		assert.equal(h.pending.effects.length, 1);
		assert.equal(h.pending.effects[0]!.status, "needs_reconciliation");
		assert.equal(h.runs.length, hasFiles ? 3 : 2);
		assert.equal(h.runs.at(-1)!.status, "applied");
		assert.equal(h.runs[0]!.status, "done");
		assert.equal(h.runs[0]!.requestedByName, "Alice");
		assert.ok(h.runs[0]!.answerExcerpt);
		if (hasFiles) {
			assert.equal(h.deliverables.length, 1);
			assert.match(h.deliverables[0]!.name, /方案草稿/);
			assert.equal(h.deliverables[0]!.conversationId, c.conversationId);
		} else assert.equal(h.deliverablesUnavailable, "files service not loaded");
		const roles = Object.fromEntries(h.participants.map((x) => [x.name, x.role]));
		assert.deepEqual(roles, { Alice: "owner", Bob: "editor", Carol: "viewer" });
		assert.equal(h.decisions.length, 0);

		// B takes over: approves, then continues; a failing run becomes "continuable"
		await t.json("POST", `${base(c)}/approvals/${h.pending.approvals[0]!.approvalId}`, { token: b.token, json: { decision: "approved", note: "已与客户确认" } });
		await settle(t, a.token, c, pend.submissionId);
		await settle(t, b.token, c, (await send(t, b.token, c, "接手后继续 [[reply 继续完成]]")).submissionId);
		await settle(t, b.token, c, (await send(t, b.token, c, "[[fail]]")).submissionId);
		h = await t.json("GET", `${base(c)}/handoff`, { token: b.token });
		assert.deepEqual(h.decisions.map((d) => [d.decision, d.decidedByName, d.note]), [["approved", "Bob", "已与客户确认"]]);
		assert.equal(h.pending.approvals.length, 0);
		assert.equal(h.pending.continuable?.reason, "model_error");
		assert.equal(h.status, "failed");
		assert.deepEqual(h.runs.slice(-2).map((r) => [r.requestedByName, r.status, r.reason ?? ""]), [["Bob", "done", ""], ["Bob", "unanswered", "model_error"]]);
		const bob = h.participants.find((x) => x.name === "Bob")!;
		assert.equal(bob.messages, 2);
		assert.equal(bob.decisions, 1);
		await t.json("POST", `${base(c)}/continue`, { token: b.token, json: {} });

		// project-level handoff
		const ph: ProjectHandoff = await t.json("GET", `/api/projects/${project.id}/handoff`, { token: b.token });
		assert.equal(ph.project.name, "交接项目");
		const pc = ph.conversations.find((x) => x.conversation.conversationId === c.conversationId)!;
		assert.equal(pc.conversation.title, "客户方案");
		assert.equal(pc.needsReconciliation, 1);
		if (hasFiles) assert.equal(pc.deliverables, 1);
		assert.equal(ph.members.length, 3);

		// viewer: reads both, cannot act
		const hv: ConversationHandoff = await t.json("GET", `${base(c)}/handoff`, { token: v.token });
		assert.equal(hv.access.canWrite, false);
		assert.equal(((await t.json("GET", `/api/projects/${project.id}/handoff`, { token: v.token })) as ProjectHandoff).access.canWrite, false);
		await t.json("POST", `${base(c)}/messages`, { token: v.token, json: { text: "x", requestId: rid() }, expect: 403 });
		await t.json("POST", `${base(c)}/continue`, { token: v.token, json: {}, expect: 403 });
		const eff = hv.pending.effects[0]!;
		await t.json("POST", `${base(c)}/effects/${eff.effectId}/reconcile`, { token: v.token, json: { outcome: "done" }, expect: 403 });

		// removed member: 403 on both handoff views
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: a.token, json: { email: "ho-b@example.com", role: null } });
		await t.json("GET", `${base(c)}/handoff`, { token: b.token, expect: 403 });
		await t.json("GET", `/api/projects/${project.id}/handoff`, { token: b.token, expect: 403 });
		// outsider: 403
		const o = await t.user("ho-out@example.com");
		await t.json("GET", `${base(c)}/handoff`, { token: o.token, expect: 403 });
		await t.json("GET", `/api/projects/${project.id}/handoff`, { token: o.token, expect: 403 });
		// the handoff kept no table of its own
		assert.equal(t.app.ctx.db.all<any>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'rt_%' ORDER BY name").map((r) => r.name).join(","), "rt_assistants,rt_conversations,rt_space_leases,rt_space_runtime");
	} finally {
		await t.dispose();
	}
});
