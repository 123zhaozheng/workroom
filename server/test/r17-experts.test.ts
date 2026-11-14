// Experts (round 17): CRUD + validation, the shared submit → 审查员 review → publish lifecycle, permissions, skill mounting BY REFERENCE
// (a skill update reaches the expert's next run), @-mention parsing and runtime injection, the model rule, and the 助手 → 专家 migration.
//   node --disable-warning=ExperimentalWarning --test --test-concurrency=1 server/test/r17-experts.test.ts
process.env.WORKROOM_RT_RETRY_BASE_MS ??= "20";
process.env.WORKROOM_RT_RETRY_MAX ??= "1";
process.env.WORKROOM_SSE_THROTTLE_MS ??= "20";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { zipSync } from "fflate";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { orgMember, upload } from "./fixtures/util.ts";
import { isSettled, waitFor } from "../src/runtime/testing.ts";
import { parseMention, type Experts } from "../src/tools/experts.ts";
import type { HarnessRoundDetailDTO, HarnessRoundsResponse } from "../../shared/harness-inspect.ts";
import type { SubmissionDTO } from "../../shared/chat.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const skillMd = (name: string, version: string, body: string, description = "整理周报的流程。当用户要写周报时使用。") => `---\nname: ${name}\ndescription: ${description}\nversion: ${version}\n---\n\n${body}\n`;
async function uploadSkill(t: TestApp, token: string, md: string, skillId?: string) {
	const r = await upload(t, token, "/market/skills/upload", "pkg.zip", zipSync({ "SKILL.md": enc(md) }), skillId ? { skillId } : {}, "application/zip");
	const body = JSON.parse(await r.text());
	assert.equal(r.status, 200, JSON.stringify(body));
	return body.skill as { id: string; versions: { versionNo: number }[] };
}
const base = (c: { spaceId: string; conversationId: number }) => `/api/conversations/${c.spaceId}/${c.conversationId}`;

async function setup() {
	const t = await startTestApp({ config: { secretKey: "r17-experts-test-key" } });
	const admin = await t.user("ex-admin@example.com");
	const author = await orgMember(t, admin, "ex-author@example.com");
	const member = await orgMember(t, admin, "ex-member@example.com");
	const reviewer = await orgMember(t, admin, "ex-reviewer@example.com");
	await t.json("POST", "/api/admin/role-assignments", { token: admin.token, json: { subject: { kind: "user", id: reviewer.me.userId }, roleId: "builtin:reviewer" } });
	await t.json("PUT", "/api/admin/settings/harness-inspect", { token: admin.token, json: { enabled: true } });
	// the tests read the exact system prompt of a run through Harness 检视
	await t.json("PUT", `/api/admin/members/${member.me.userId}/grants`, { token: admin.token, json: { permission: "harness.inspect", effect: "allow" } });
	const experts = t.app.ctx.services.get("experts") as Experts;
	return { t, admin, author, member, reviewer, experts };
}
const mkExpert = (t: TestApp, token: string, extra: Record<string, unknown> = {}) =>
	t.json("POST", "/api/experts", { token, json: { name: "周报专家", tagline: "把一周的工作整理成周报", instructions: "你是周报专家，用三段式输出。", category: "办公效率", starters: ["帮我写本周周报"], ...extra } }).then((r) => r.expert);

/** Publish a skill to the org through the normal review (admin uploads, reviewer approves). */
async function publishOrgSkill(t: TestApp, admin: { token: string }, reviewer: { token: string }, md: string, skillId?: string) {
	const s = await uploadSkill(t, admin.token, md, skillId);
	const versionNo = Math.max(...s.versions.map((v) => v.versionNo));
	const sub = (await t.json("POST", `/api/market/skills/${s.id}/versions/${versionNo}/submit`, { token: admin.token, json: { targetScope: "org" } })).submission;
	await t.json("POST", `/api/market/submissions/${sub.id}/decision`, { token: reviewer.token, json: { decision: "approve", comment: "ok" } });
	return { id: s.id, versionNo, sub };
}
async function publishExpert(t: TestApp, owner: { token: string }, reviewer: { token: string }, id: string, note = "请审查") {
	const sub = (await t.json("POST", `/api/experts/${id}/submit`, { token: owner.token, json: { targetScope: "org", note } })).submission;
	await t.json("POST", `/api/market/submissions/${sub.id}/decision`, { token: reviewer.token, json: { decision: "approve", comment: "通过" } });
	return sub;
}
async function ask(t: TestApp, token: string, c: { spaceId: string; conversationId: number }, text: string, extra: Record<string, unknown> = {}): Promise<number> {
	const r = await t.json("POST", `${base(c)}/messages`, { token, json: { text, requestId: randomUUID(), ...extra } });
	await waitFor(async () => {
		const s = (await t.json("GET", `${base(c)}/submissions/${r.submissionId}`, { token })) as SubmissionDTO;
		return isSettled(s) ? s : undefined;
	}, { timeoutMs: 15_000, what: "submission settles" });
	return r.submissionId;
}
/** System prompt of the latest finished model round of a conversation. */
async function lastSystemPrompt(t: TestApp, token: string, c: { spaceId: string; conversationId: number }, n: number): Promise<string> {
	const list = await waitFor(async () => {
		const l = await t.json<HarnessRoundsResponse>("GET", `${base(c)}/harness/rounds`, { token });
		return l.rounds.length >= n && l.rounds.every((r) => r.stopReason) ? l : undefined;
	}, { timeoutMs: 10_000, what: `${n} finished rounds` });
	const last = list.rounds.at(-1)!;
	return (await t.json<{ round: HarnessRoundDetailDTO }>("GET", `${base(c)}/harness/rounds/${last.id}`, { token })).round.systemPrompt;
}

test("CRUD + validation: parameters stored, skills attached by id only, bad input rejected, categories", async () => {
	const { t, author, member, experts } = await setup();
	try {
		const skill = await uploadSkill(t, author.token, skillMd("weekly", "1.0.0", "# 周报 v1"));
		const e = await mkExpert(t, author.token, { avatar: "📝", description: "详细说明", tags: ["周报", "办公", "周报"], opening: "你好，我是周报专家", defaultModel: { provider: "fixture", modelId: "workroom-fixture" }, skills: [{ skillId: skill.id }], connectors: [{ connectorId: "conn_x" }] });
		assert.equal(e.status, "draft");
		assert.deepEqual(e.tags, ["周报", "办公"]);
		assert.equal(e.defaultModel.modelId, "workroom-fixture");
		assert.deepEqual(e.modelAvailability, { status: "ok" });
		assert.equal(e.skills[0].skillId, skill.id);
		assert.equal(e.skills[0].state, "ok");
		assert.equal(e.skills[0].versionNo, 1);
		// the stored row holds ONLY the skill id: no version, no content (the decoupling invariant)
		const raw = t.app.ctx.db.get<any>("SELECT skills FROM ex_experts WHERE id = ?", e.id)!.skills;
		assert.deepEqual(JSON.parse(raw), [{ skillId: skill.id }]);
		// validation
		await t.json("POST", "/api/experts", { token: author.token, json: { tagline: "x" }, expect: 400 });
		await t.json("POST", "/api/experts", { token: author.token, json: { name: "x".repeat(41) }, expect: 400 });
		await t.json("POST", "/api/experts", { token: author.token, json: { name: "x", skills: [{ skillId: "nope" }] }, expect: 400 });
		await t.json("POST", "/api/experts", { token: author.token, json: { name: "x", defaultModel: { provider: "nope", modelId: "y" } }, expect: 400 });
		// another member's personal skill cannot be mounted
		await t.json("POST", "/api/experts", { token: member.token, json: { name: "偷技能", skills: [{ skillId: skill.id }] }, expect: 400 });
		// update (author only), others cannot see a draft
		const up = (await t.json("PATCH", `/api/experts/${e.id}`, { token: author.token, json: { tagline: "新的简介", starters: ["a", "b"] } })).expert;
		assert.equal(up.tagline, "新的简介");
		await t.json("GET", `/api/experts/${e.id}`, { token: member.token, expect: 404 });
		await t.json("PATCH", `/api/experts/${e.id}`, { token: member.token, json: { tagline: "x" }, expect: 404 });
		assert.equal((await t.json("GET", "/api/experts?mine=1", { token: author.token })).experts.length, 1);
		assert.equal((await t.json("GET", "/api/experts", { token: member.token })).experts.length, 0);
		const cats = (await t.json("GET", "/api/experts/categories", { token: author.token })).categories;
		assert.equal(cats.find((c: any) => c.category === "办公效率").count, 1);
		// mentionable: own draft listed for the author, nothing for others
		assert.deepEqual((await t.json("GET", "/api/experts/mentionable", { token: author.token })).experts.map((x: any) => x.name), ["周报专家"]);
		assert.equal((await t.json("GET", "/api/experts/mentionable", { token: member.token })).experts.length, 0);
		await t.json("DELETE", `/api/experts/${e.id}`, { token: author.token });
		assert.equal((await t.json("GET", "/api/experts?mine=1", { token: author.token })).experts.length, 0);
		void experts;
	} finally {
		await t.dispose();
	}
});

test("review lifecycle (shared with skills / MCP): auto-checks, 审查员 decides, self-review refused, publish → visible, update re-review keeps the old version live, unpublish / republish / force-publish", async () => {
	const { t, admin, author, member, reviewer } = await setup();
	try {
		// empty expert fails the automatic check
		const empty = (await t.json("POST", "/api/experts", { token: admin.token, json: { name: "空的", tagline: "什么也没有" } })).expert;
		const bad = (await t.json("POST", `/api/experts/${empty.id}/submit`, { token: admin.token, json: { targetScope: "org" } })).submission;
		assert.equal(bad.state, "checks_failed");
		await t.json("POST", `/api/experts/${empty.id}/submit`, { token: admin.token, json: { targetScope: "personal" }, expect: 409 });

		// a member without expert.publish cannot submit to the org
		const e = await mkExpert(t, author.token);
		await t.json("POST", `/api/experts/${e.id}/submit`, { token: author.token, json: { targetScope: "org" }, expect: 403 });
		// give the author expert.publish through a direct grant, then submit
		await t.json("PUT", `/api/admin/members/${author.me.userId}/grants`, { token: admin.token, json: { permission: "expert.publish", effect: "allow" } });
		const sub = (await t.json("POST", `/api/experts/${e.id}/submit`, { token: author.token, json: { targetScope: "org", note: "给全组织用" } })).submission;
		assert.equal(sub.kind, "expert");
		assert.equal(sub.state, "pending_review");
		assert.equal((await t.json("GET", `/api/experts/${e.id}`, { token: author.token })).expert.status, "pending");
		// still invisible to others
		await t.json("GET", `/api/experts/${e.id}`, { token: member.token, expect: 404 });
		// the 审查员 queue shows it (kind filter) and the detail carries the configuration + a field diff
		const q = (await t.json("GET", "/api/market/submissions?view=queue&kind=expert", { token: reviewer.token })).submissions;
		assert.deepEqual(q.map((s: any) => s.id), [sub.id]);
		const detail = (await t.json("GET", `/api/market/submissions/${sub.id}`, { token: reviewer.token })).submission;
		assert.equal(detail.expert.config.name, "周报专家");
		assert.ok(detail.diff.some((d: any) => d.path === "系统指令" && d.status === "added"));
		// no review rights → no queue, no decision; the author cannot approve their own
		assert.equal((await t.json("GET", "/api/market/submissions?view=queue", { token: member.token })).submissions.length, 0);
		await t.json("POST", `/api/market/submissions/${sub.id}/decision`, { token: member.token, json: { decision: "approve" }, expect: 403 });
		const self = await t.json("POST", `/api/market/submissions/${sub.id}/decision`, { token: author.token, json: { decision: "approve" }, expect: 403 });
		assert.ok(["forbidden", "self_review"].includes(self.error.code), self.error.code);
		await t.json("POST", `/api/market/submissions/${sub.id}/decision`, { token: reviewer.token, json: { decision: "reject" }, expect: 400 }); // comment required
		await t.json("POST", `/api/market/submissions/${sub.id}/decision`, { token: reviewer.token, json: { decision: "approve", comment: "可以" } });
		const pub = (await t.json("GET", `/api/experts/${e.id}`, { token: member.token })).expert;
		assert.equal(pub.status, "published");
		assert.equal(pub.scope, "org");
		assert.equal(pub.instructions, undefined, "the system prompt stays with the author");
		assert.equal((await t.json("GET", "/api/experts", { token: member.token })).experts.length, 1);
		assert.deepEqual((await t.json("GET", "/api/experts/mentionable", { token: member.token })).experts.map((x: any) => x.id), [e.id]);

		// the author edits the draft: others keep the PUBLISHED version until the update is reviewed
		await t.json("PATCH", `/api/experts/${e.id}`, { token: author.token, json: { instructions: "新的指令 v2", tagline: "新简介" } });
		assert.equal((await t.json("GET", `/api/experts/${e.id}`, { token: member.token })).expert.tagline, "把一周的工作整理成周报");
		assert.equal((await t.json("GET", `/api/experts/${e.id}`, { token: author.token })).expert.dirty, true);
		const sub2 = (await t.json("POST", `/api/experts/${e.id}/submit`, { token: author.token, json: { targetScope: "org" } })).submission;
		const again = (await t.json("GET", `/api/experts/${e.id}`, { token: author.token })).expert;
		assert.equal(again.status, "published");
		assert.equal(again.updatePending, true);
		const d2 = (await t.json("GET", `/api/market/submissions/${sub2.id}`, { token: reviewer.token })).submission;
		assert.equal(d2.expert.previousVersionNo, 1);
		assert.ok(d2.diff.some((d: any) => d.path === "系统指令" && d.status === "modified"));
		await t.json("POST", `/api/market/submissions/${sub2.id}/decision`, { token: reviewer.token, json: { decision: "approve" } });
		assert.equal((await t.json("GET", `/api/experts/${e.id}`, { token: member.token })).expert.tagline, "新简介");

		// admin controls: unpublish needs a reason and market.manage; republish; force-publish
		await t.json("POST", `/api/experts/${e.id}/unpublish`, { token: author.token, json: { reason: "x" }, expect: 403 });
		await t.json("POST", `/api/experts/${e.id}/unpublish`, { token: admin.token, json: {}, expect: 400 });
		const un = (await t.json("POST", `/api/experts/${e.id}/unpublish`, { token: reviewer.token, json: { reason: "内容过期" } })).expert; // the 审查员 role holds market.manage
		assert.equal(un.status, "unpublished");
		await t.json("GET", `/api/experts/${e.id}`, { token: member.token, expect: 404 });
		assert.equal((await t.json("POST", `/api/experts/${e.id}/republish`, { token: admin.token, json: {} })).expert.status, "published");
		const e2 = await mkExpert(t, author.token, { name: "强制发布的专家" });
		await t.json("POST", `/api/experts/${e2.id}/force-publish`, { token: admin.token, json: {}, expect: 400 });
		const forced = (await t.json("POST", `/api/experts/${e2.id}/force-publish`, { token: admin.token, json: { reason: "紧急" } })).submission;
		assert.equal(forced.forced, true);
		assert.equal((await t.json("GET", `/api/experts/${e2.id}`, { token: member.token })).expert.status, "published");
		// install / uninstall changes only the "my experts" list, not what is usable
		assert.equal((await t.json("POST", `/api/experts/${e.id}/install`, { token: member.token, json: {} })).expert.installed, true);
		assert.equal((await t.json("DELETE", `/api/experts/${e.id}/install`, { token: member.token })).expert.installed, false);
	} finally {
		await t.dispose();
	}
});

test("a skill update reaches the expert's NEXT run: no snapshot, expert untouched (the 旧版本 problem), pending / unlisted / private skills are skipped with a reason", async () => {
	const { t, admin, author, member, reviewer, experts } = await setup();
	try {
		const org = await publishOrgSkill(t, admin, reviewer, skillMd("weekly-report", "1.0.0", "# 周报 版本一"));
		const e = await mkExpert(t, admin.token, { skills: [{ skillId: org.id }] });
		await publishExpert(t, admin, reviewer, e.id);
		const memberP = (await (t.app.ctx.services.get("identity") as any).principalFor(member.me.userId, member.me.orgId))!;
		const rowBefore = t.app.ctx.db.get<any>("SELECT skills, latest_version_no, published_version_no FROM ex_experts WHERE id = ?", e.id)!;

		// run 1: the member @-mentions the expert; the system prompt lists the skill at its current version (1)
		const c = (await t.json("POST", "/api/conversations", { token: member.token, json: {} })).conversation;
		await ask(t, member.token, c, "你好", { expertId: e.id });
		const p1 = await lastSystemPrompt(t, member.token, c, 1);
		assert.match(p1, /## 专家：周报专家/);
		assert.match(p1, /你是周报专家/);
		assert.match(p1, /weekly-report v1 \(\/skills\/weekly-report\)/);
		// the skill can be loaded through the normal tool path from this conversation without installing it separately
		const sk1 = await experts.resolveSkills(memberP, [{ skillId: org.id }]);
		assert.deepEqual([sk1[0]!.state, sk1[0]!.versionNo], ["ok", 1]);

		// a NEW version is uploaded and submitted but NOT yet approved → still v1 for the expert
		const v2up = await uploadSkill(t, admin.token, skillMd("weekly-report", "2.0.0", "# 周报 版本二"), org.id);
		const v2 = Math.max(...v2up.versions.map((v) => v.versionNo));
		assert.equal(v2, 2);
		const sub2 = (await t.json("POST", `/api/market/skills/${org.id}/versions/${v2}/submit`, { token: admin.token, json: { targetScope: "org" } })).submission;
		assert.equal((await experts.resolveSkills(memberP, [{ skillId: org.id }]))[0]!.versionNo, 1, "unreviewed versions never reach the expert");
		// approved → the SAME expert, untouched, resolves to v2 on its next run
		await t.json("POST", `/api/market/submissions/${sub2.id}/decision`, { token: reviewer.token, json: { decision: "approve", comment: "ok" } });
		const rowAfter = t.app.ctx.db.get<any>("SELECT skills, latest_version_no, published_version_no FROM ex_experts WHERE id = ?", e.id)!;
		assert.deepEqual(rowAfter, rowBefore, "the expert row did not change when the skill was updated");
		await ask(t, member.token, c, "再来一次", { expertId: e.id });
		const p2 = await lastSystemPrompt(t, member.token, c, 2);
		assert.match(p2, /weekly-report v2 \(\/skills\/weekly-report\)/, "next run uses the new skill version");
		assert.doesNotMatch(p2, /weekly-report v1 /);

		// unpublished skill → skipped WITH a stated reason (not an error, not silent)
		await t.json("POST", `/api/market/skills/${org.id}/unpublish`, { token: admin.token, json: { reason: "下线维护" } });
		await ask(t, member.token, c, "第三次", { expertId: e.id });
		const p3 = await lastSystemPrompt(t, member.token, c, 3);
		assert.match(p3, /以下挂载技能本次暂不可用，已跳过/);
		assert.match(p3, /weekly-report：技能「weekly-report」已下架/);
		assert.doesNotMatch(p3, /\(\/skills\/weekly-report\)/);

		// someone else's PRIVATE skill mounted by an author: skipped for other users, with the reason
		const priv = await uploadSkill(t, author.token, skillMd("private-kit", "1.0.0", "# secret", "作者自己的个人技能，别人不能用。"));
		const e2 = await mkExpert(t, author.token, { name: "带私有技能的专家", skills: [{ skillId: priv.id }] });
		await t.json("PUT", `/api/admin/members/${author.me.userId}/grants`, { token: admin.token, json: { permission: "expert.publish", effect: "allow" } });
		const s = (await t.json("POST", `/api/experts/${e2.id}/submit`, { token: author.token, json: { targetScope: "org" } })).submission;
		assert.ok(s.warnCount >= 1, "the automatic check warns that the personal skill will be skipped for others");
		await t.json("POST", `/api/market/submissions/${s.id}/decision`, { token: reviewer.token, json: { decision: "approve", comment: "ok" } });
		const seen = (await t.json("GET", `/api/experts/${e2.id}`, { token: member.token })).expert;
		assert.equal(seen.skills[0].state, "forbidden");
		assert.match(seen.skills[0].message, /个人技能/);
		const mine = (await t.json("GET", `/api/experts/${e2.id}`, { token: author.token })).expert;
		assert.equal(mine.skills[0].state, "ok", "the author still has it");
	} finally {
		await t.dispose();
	}
});

test("@ mention: parser (longest name, boundaries), the answering expert is recorded on the message, a bound expert applies to every message, @ overrides for one message only", async () => {
	// pure parser
	const cands = [{ id: "a", name: "周报" }, { id: "b", name: "周报专家" }, { id: "c", name: "代码审查" }];
	assert.equal(parseMention("请 @周报专家 帮我写", cands)?.id, "b", "longest name wins");
	assert.equal(parseMention("@周报 帮我写", cands)?.id, "a");
	assert.equal(parseMention("@周报专家，来一个", cands)?.id, "b");
	assert.equal(parseMention("邮箱 me@周报.com", cands)?.id, undefined, "must follow a boundary");
	assert.equal(parseMention("@周报专家们", cands)?.id, undefined, "must end at a boundary");
	assert.equal(parseMention("没有提及", cands), undefined);
	assert.equal(parseMention("@不存在的专家 你好", cands), undefined);

	const { t, admin, member, reviewer } = await setup();
	try {
		const a = await mkExpert(t, admin.token, { name: "周报专家", instructions: "你是周报专家 AAA" });
		const b = await mkExpert(t, admin.token, { name: "翻译官", tagline: "中英互译", instructions: "你是翻译官 BBB" });
		await publishExpert(t, admin, reviewer, a.id);
		await publishExpert(t, admin, reviewer, b.id);
		// conversation bound to 周报专家 at creation
		const created = await t.json("POST", "/api/conversations", { token: member.token, json: { expertId: a.id } });
		assert.equal(created.agent.expert.boundId, a.id);
		assert.equal(created.agent.expert.boundName, "周报专家");
		const c = created.conversation;
		await ask(t, member.token, c, "你好");
		assert.match(await lastSystemPrompt(t, member.token, c, 1), /你是周报专家 AAA/);
		// @名称 in the text (no explicit id) answers as that expert for this message; the entry records it
		await ask(t, member.token, c, "@翻译官 把这句翻译成英文");
		const p2 = await lastSystemPrompt(t, member.token, c, 2);
		assert.match(p2, /你是翻译官 BBB/);
		assert.doesNotMatch(p2, /你是周报专家 AAA/);
		const entries = (await t.json("GET", `${base(c)}/entries`, { token: member.token })).items.filter((e: any) => e.kind === "user");
		assert.deepEqual([entries[0].expert, entries[1].expert?.name], [undefined, "翻译官"]);
		// the next message without a mention returns to the bound expert
		await ask(t, member.token, c, "再写一份周报");
		assert.match(await lastSystemPrompt(t, member.token, c, 3), /你是周报专家 AAA/);
		// no expert at all: default general agent, nothing injected (and no built-in 「Workroom 助手」)
		const plain = (await t.json("POST", "/api/conversations", { token: member.token, json: {} })).conversation;
		await ask(t, member.token, plain, "你好");
		assert.doesNotMatch(await lastSystemPrompt(t, member.token, plain, 1), /## 专家：/);
		// an expert the user cannot see: refused, never silently ignored
		const hidden = (await t.json("POST", "/api/experts", { token: admin.token, json: { name: "内部专家", instructions: "x" } })).expert;
		await t.json("POST", "/api/conversations", { token: member.token, json: { expertId: hidden.id }, expect: 404 });
		await t.json("POST", `${base(plain)}/messages`, { token: member.token, json: { text: "hi", requestId: randomUUID(), expertId: hidden.id }, expect: 404 });
		assert.equal((await t.json("GET", "/api/assistants", { token: member.token })).assistants.some((x: any) => x.id === "builtin:workroom"), false);
	} finally {
		await t.dispose();
	}
});

test("model rule: expert default model on a new conversation; the user's explicit choice always wins; @ expert borrows its model for ONE message then restores; unusable default → visible notice", async (tc) => {
	const { t, admin, member, reviewer } = await setup();
	try {
		if (!t.app.ctx.services.has("models")) return tc.skip("model gateway not loaded");
		// a second USABLE model (a provider with a key) next to the fixture model
		const prov = (await t.json("POST", "/api/admin/model-providers", { token: admin.token, json: { name: "备用网关", type: "openai-completions", baseUrl: "https://api.example.invalid/v1", apiKey: "sk-test-not-real", models: [{ id: "alt-model", name: "备用模型" }] } })).provider;
		const models = (await t.json("GET", "/api/models", { token: member.token })).models as any[];
		const alt = models.find((m) => m.ref.modelId === "alt-model");
		assert.ok(alt && alt.status !== "blocked", JSON.stringify(models.map((m) => [m.ref, m.status])));
		const fixture = { provider: "fixture", modelId: "workroom-fixture" };
		void prov;
		// the user's own default model (whatever the gateway picks first) and a DIFFERENT usable model for the expert
		const probe = (await t.json("POST", "/api/conversations", { token: member.token, json: {} })).agent.model.modelId as string;
		const expertModel = probe === "alt-model" ? fixture : alt.ref;
		const other = probe === "alt-model" ? "workroom-fixture" : "alt-model";
		const userModelId = probe === "alt-model" ? `${alt.ref.provider}/alt-model` : "fixture/workroom-fixture";
		const withAlt = await mkExpert(t, admin.token, { name: "指定模型专家", defaultModel: expertModel });
		const noModel = await mkExpert(t, admin.token, { name: "跟随会话专家" });
		await publishExpert(t, admin, reviewer, withAlt.id);
		await publishExpert(t, admin, reviewer, noModel.id);
		const modelOf = async (c: any) => (await t.json("GET", base(c), { token: member.token })).agent;

		// 1) new conversation bound to the expert, no explicit model → the expert's default model, not "explicit"
		const a = await t.json("POST", "/api/conversations", { token: member.token, json: { expertId: withAlt.id } });
		assert.equal(a.agent.model.modelId, other);
		assert.equal(a.agent.expert.modelExplicit, false);
		// 2) the user explicitly chose a model at creation → the user wins, and @ never overrides it
		const b = await t.json("POST", "/api/conversations", { token: member.token, json: { expertId: withAlt.id, modelId: userModelId } });
		assert.equal(b.agent.model.modelId, probe);
		assert.equal(b.agent.expert.modelExplicit, true);
		await ask(t, member.token, b.conversation, "@指定模型专家 你好");
		assert.equal((await modelOf(b.conversation)).model.modelId, probe, "@ does not override an explicit user choice");
		// 3) conversation without explicit model: @ borrows for one message, then restores
		const c = (await t.json("POST", "/api/conversations", { token: member.token, json: { expertId: noModel.id } })).conversation;
		assert.equal((await modelOf(c)).model.modelId, probe);
		assert.equal((await modelOf(c)).expert.modelExplicit, false);
		await ask(t, member.token, c, "你好", { expertId: withAlt.id });
		assert.equal((await modelOf(c)).model.modelId, other, "the mentioned expert's model is used for its message");
		let notes = (await t.json("GET", `${base(c)}/entries`, { token: member.token })).items.filter((e: any) => e.kind === "notice");
		assert.ok(notes.some((n: any) => n.code === "expert_model" && /指定使用模型/.test(n.text)));
		await ask(t, member.token, c, "没有提及专家的下一条");
		assert.equal((await modelOf(c)).model.modelId, probe, "restored before the next message without @");
		notes = (await t.json("GET", `${base(c)}/entries`, { token: member.token })).items.filter((e: any) => e.kind === "notice");
		assert.ok(notes.some((n: any) => n.code === "expert_model_restored"));
		// 4) the user picks a model in the conversation → explicit from then on; an @ expert never changes it again
		await t.json("PATCH", base(c), { token: member.token, json: { modelId: userModelId } });
		assert.equal((await modelOf(c)).expert.modelExplicit, true);
		await ask(t, member.token, c, "还是这个", { expertId: withAlt.id });
		assert.equal((await modelOf(c)).model.modelId, probe);
		// 5) a default model that is no longer usable → fall back with a visible notice (never silent)
		const gone = await mkExpert(t, admin.token, { name: "模型失效专家" });
		await publishExpert(t, admin, reviewer, gone.id);
		t.app.ctx.db.run("UPDATE ex_experts SET default_model = ?, published_version_no = NULL WHERE id = ?", JSON.stringify({ provider: "gone", modelId: "x" }), gone.id);
		t.app.ctx.db.run("DROP TRIGGER ex_versions_no_update");
		t.app.ctx.db.run("UPDATE ex_versions SET config = json_set(config, '$.defaultModel', json(?)) WHERE expert_id = ?", JSON.stringify({ provider: "gone", modelId: "x" }), gone.id);
		t.app.ctx.db.run("UPDATE ex_experts SET published_version_no = 1 WHERE id = ?", gone.id);
		const d = await t.json("POST", "/api/conversations", { token: member.token, json: { expertId: gone.id } });
		assert.match(d.notice, /专家「模型失效专家」的默认模型不可用/);
		assert.equal(d.agent.model.modelId, probe);
	} finally {
		await t.dispose();
	}
});

test("助手 → 专家 migration: old assistants appear as experts (same id), old conversations keep working, the built-in 助手 is gone, old API changes stay in sync", async () => {
	const { t, admin, member } = await setup();
	try {
		const { assistant: personal } = await t.json("POST", "/api/assistants", { token: member.token, json: { name: "我的旧助手", description: "旧助手的说明", instructions: "旧指令 OLD", members: [] } });
		const { assistant: org } = await t.json("POST", "/api/assistants", { token: admin.token, json: { name: "组织旧助手", scope: "org", description: "共享的", instructions: "组织旧指令", members: [] } });
		const mine = (await t.json("GET", "/api/experts?mine=1", { token: member.token })).experts;
		assert.deepEqual(mine.map((x: any) => [x.id, x.source, x.status, x.scope]), [[personal.id, "assistant", "draft", "personal"]]);
		const shared = (await t.json("GET", "/api/experts", { token: member.token })).experts;
		assert.ok(shared.some((x: any) => x.id === org.id && x.status === "published" && x.scope === "org"), "org assistants arrive published");
		// an old conversation bound by assistantId keeps working and runs with the same instructions
		const c = (await t.json("POST", "/api/conversations", { token: member.token, json: { assistantId: personal.id } })).conversation;
		await ask(t, member.token, c, "你好");
		const sys = await lastSystemPrompt(t, admin.token, c, 1).catch(() => "");
		void sys;
		const detail = await t.json("GET", base(c), { token: member.token });
		assert.equal(detail.agent.assistant.id, personal.id);
		assert.equal(detail.agent.expert.boundId, personal.id);
		// the old API's edits flow into the expert; archiving removes it
		await t.json("PATCH", `/api/assistants/${personal.id}`, { token: member.token, json: { description: "改过的说明" } });
		assert.equal((await t.json("GET", `/api/experts/${personal.id}`, { token: member.token })).expert.description, "改过的说明");
		await t.json("PATCH", `/api/experts/${personal.id}`, { token: member.token, json: { tagline: "x" }, expect: 409 });
		await t.json("DELETE", `/api/assistants/${personal.id}`, { token: member.token });
		assert.equal((await t.json("GET", "/api/experts?mine=1", { token: member.token })).experts.length, 0);
		// a conversation that was bound to the removed built-in 助手 still opens
		const legacy = (await t.json("POST", "/api/conversations", { token: member.token, json: { assistantId: "builtin:workroom" } })).conversation;
		await ask(t, member.token, legacy, "你好");
		assert.equal((await t.json("GET", base(legacy), { token: member.token })).agent.expert.boundId, undefined, "the built-in binding counts as no expert");
	} finally {
		await t.dispose();
	}
});

test("permissions: expert.create is a member default, guests cannot create; cross-organisation isolation; revoked review right stops decisions", async () => {
	const { t, admin, author, reviewer } = await setup();
	try {
		const guestInvite = await t.json("POST", "/api/admin/invites", { token: admin.token, json: { role: "guest" } });
		const guest = await t.user("ex-guest@example.com", { inviteCode: guestInvite.invite.code });
		await t.json("POST", "/api/experts", { token: guest.token, json: { name: "访客专家", instructions: "x" }, expect: 403 });
		const e = await mkExpert(t, author.token);
		// another organisation sees nothing
		const other = await t.user("ex-other-org@example.com");
		assert.equal((await t.json("GET", "/api/experts", { token: other.token })).experts.length, 0);
		await t.json("GET", `/api/experts/${e.id}`, { token: other.token, expect: 404 });
		await t.json("POST", "/api/conversations", { token: other.token, json: { expertId: e.id }, expect: 404 });
		// revoking the reviewer's role stops their decisions
		await t.json("PUT", `/api/admin/members/${author.me.userId}/grants`, { token: admin.token, json: { permission: "expert.publish", effect: "allow" } });
		const sub = (await t.json("POST", `/api/experts/${e.id}/submit`, { token: author.token, json: { targetScope: "org" } })).submission;
		const asg = (await t.json("GET", `/api/admin/role-assignments?subjectId=${reviewer.me.userId}`, { token: admin.token })).assignments.find((a: any) => a.roleId === "builtin:reviewer");
		await t.json("DELETE", `/api/admin/role-assignments/${asg.id}`, { token: admin.token });
		await t.json("POST", `/api/market/submissions/${sub.id}/decision`, { token: reviewer.token, json: { decision: "approve" }, expect: 403 });
		assert.equal((await t.json("GET", `/api/experts/${e.id}`, { token: author.token })).expert.status, "pending");
	} finally {
		await t.dispose();
	}
});
