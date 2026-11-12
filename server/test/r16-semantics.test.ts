// Round 16 (docs/r16-harness-semantics.md): what the model is told matches what the backend does.
//   memory: an agent write never clobbers a user's edit (etag required / mismatch → nothing changes), credentials are refused
//   skills: a read-only skill's write error points at skill_manage checkout
//   delivery: same-name present_file overwrites (one card); job output is never delivered on its own and job_status says so
//   jobs: queued/running/done/failed/cancelled/timeout and "结果未知" after a restart interruption are told apart
//   team / browser: the delegate catalog names member ids; every browser result carries an observation with click coordinates
process.env.WORKROOM_RT_RETRY_MAX ??= "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { context, fakeApi, fixedActor } from "./fixtures/tool-harness.ts";
import { findMemorySecret } from "../src/knowledge/memory-md.ts";
import { createJobsExtension, type Jobs } from "../src/tools/jobs.ts";
import { renderObservation, type BrowserSessions } from "../src/tools/browser-sessions.ts";
import { renderTeamSection } from "../src/runtime/team.ts";
import { renderFilesSection } from "../src/vfs/tools.ts";

type Conv = { spaceId: string; conversationId: number };
const base = (c: Conv) => `/api/conversations/${c.spaceId}/${c.conversationId}`;
const call = (tool: string, args: unknown) => `[[call ${tool} ${JSON.stringify(args)}]]`;
const q = (path: string) => `scope=personal&path=${encodeURIComponent(path)}`;

async function say(t: TestApp, token: string, c: Conv, text: string) {
	const r = await t.json("POST", `${base(c)}/messages`, { token, json: { text, requestId: randomUUID() } });
	const deadline = Date.now() + 60_000;
	for (;;) {
		const s = await t.json("GET", `${base(c)}/submissions/${r.submissionId}`, { token });
		if (["done", "unanswered", "withdrawn"].includes(s.status)) return s;
		if (Date.now() > deadline) throw new Error("submission did not settle");
		await new Promise((x) => setTimeout(x, 50));
	}
}
async function entries(t: TestApp, c: Conv): Promise<any[]> {
	const h = await t.app.ctx.services.get("runtime").harness(c.spaceId, BACKGROUND_CONTEXT);
	const conv = (await h.conversation(c.conversationId as any, BACKGROUND_CONTEXT))!;
	return (await conv.entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT)).items as any[];
}
async function results(t: TestApp, c: Conv, name: string) {
	return (await entries(t, c)).filter((e) => e.kind === "pi.tool-result" && e.model?.[0]?.toolName === name).map((e) => ({ text: e.model[0].content.map((x: any) => x.text ?? "").join(""), isError: !!e.model[0].isError }));
}
async function sections(t: TestApp, c: Conv): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const e of await entries(t, c)) if (e.kind === "pi.system") Object.assign(out, e.model?.[0]?.sections ?? {});
	return out;
}
const newChat = async (t: TestApp, token: string, body: object = {}): Promise<Conv> => (await t.json("POST", "/api/conversations", { token, json: body })).conversation;
const getFile = async (t: TestApp, token: string, path: string) => (await t.req("GET", `/api/memory/file?${q(path)}`, { token })).json() as Promise<any>;
const putFile = (t: TestApp, token: string, path: string, content: string, ifMatch?: string) => t.req("PUT", `/api/memory/file?${q(path)}`, { token, json: { content }, headers: ifMatch === undefined ? {} : { "if-match": ifMatch } });

test("memory: an agent write never overwrites a user's edit; credentials are refused", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("r16-mem@example.com");
		const c = await newChat(t, a.token);
		assert.equal((await putFile(t, a.token, "prefs.md", "- 喜欢简短回答\n")).status, 200);
		const seen = (await getFile(t, a.token, "prefs.md")).file.etag as string;

		// no etag on an existing file: refused with guidance, content untouched
		await say(t, a.token, c, call("write", { path: "/memory/prefs.md", content: "agent 覆盖\n" }));
		const w1 = (await results(t, c, "write")).at(-1)!;
		assert.ok(w1.isError);
		assert.match(w1.text, /etag_required/);
		assert.match(w1.text, /expected_etag/);
		assert.match(JSON.stringify(await getFile(t, a.token, "prefs.md")), /喜欢简短回答/);

		// the person saves in the memory page meanwhile; the agent's write with the stale etag fails and nothing is lost
		assert.equal((await putFile(t, a.token, "prefs.md", "- 用户刚改的内容\n", seen)).status, 200);
		await say(t, a.token, c, call("write", { path: "/memory/prefs.md", content: "agent 覆盖\n", expected_etag: seen }));
		const w2 = (await results(t, c, "write")).at(-1)!;
		assert.ok(w2.isError);
		assert.match(w2.text, /etag_mismatch/);
		const cur = await getFile(t, a.token, "prefs.md");
		assert.match(JSON.stringify(cur), /用户刚改的内容/);

		// with the fresh etag the write goes through
		await say(t, a.token, c, call("write", { path: "/memory/prefs.md", content: "- 用户刚改的内容\n- 报告用中文\n", expected_etag: cur.file.etag }));
		assert.ok(!(await results(t, c, "write")).at(-1)!.isError);

		// credentials are not stored (new file or appended line); ordinary notes are
		await say(t, a.token, c, call("write", { path: "/memory/keys.md", content: "- 服务 api_key: sk-live-0123456789abcdef\n" }));
		const w3 = (await results(t, c, "write")).at(-1)!;
		assert.ok(w3.isError);
		assert.match(w3.text, /secret_refused/);
		assert.equal((await t.req("GET", `/api/memory/file?${q("keys.md")}`, { token: a.token })).status, 404);
		await say(t, a.token, c, call("write", { path: "/memory/notes.md", content: "- 项目周报每周五发\n" }));
		assert.ok(!(await results(t, c, "write")).at(-1)!.isError);
	} finally {
		await t.dispose();
	}
});

test("memory secret check only looks at new lines", () => {
	assert.equal(findMemorySecret("- 偏好中文\n"), undefined);
	assert.ok(findMemorySecret("- 密码：hunter2hunter2\n"));
	assert.ok(findMemorySecret("-----BEGIN RSA PRIVATE KEY-----\n"));
	assert.ok(findMemorySecret("token=abcdef123456"));
	const old = "api_key: sk-old-0123456789abcdef\n";
	assert.equal(findMemorySecret(`${old}- 新增一条\n`, old), undefined, "an existing line never blocks an unrelated edit");
});

test("skills: a read-only skill's write error points at skill_manage checkout", async () => {
	const t = await startTestApp();
	try {
		const admin = await t.user("r16-skl-admin@example.com");
		const inv = await t.json("POST", "/api/admin/invites", { token: admin.token, json: { role: "member" } });
		const member = await t.user("r16-skl-member@example.com", { inviteCode: inv.invite.code });
		const created = await t.json("POST", "/api/skills", { token: admin.token, json: { name: "org-ro", kind: "context", scope: "org", description: "只读", instructions: "# ro" } });
		await t.json("POST", `/api/market/skills/${created.skill.id}/install`, { token: member.token, json: { target: "me" } });
		const mc = await newChat(t, member.token);
		await say(t, member.token, mc, call("ls", { path: "/skills" }));
		const slug = /(org-ro-[a-z0-9]+)\//.exec((await results(t, mc, "ls"))[0]!.text)![1]!;
		await say(t, member.token, mc, call("write", { path: `/skills/${slug}/SKILL.md`, content: "x" }));
		const r = (await results(t, mc, "write"))[0]!;
		assert.ok(r.isError);
		assert.match(r.text, /read_only/);
		assert.match(r.text, /skill_manage/);
		assert.match(r.text, /checkout/);
		assert.match(r.text, /submit_draft/);
	} finally {
		await t.dispose();
	}
});

test("delivery: same-name present_file overwrites with one card; a background job's output is not a delivery", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("r16-del@example.com");
		const c = await newChat(t, a.token);
		await say(t, a.token, c, call("write", { path: "/work/report.md", content: "# v1\n" }));
		await say(t, a.token, c, call("present_file", { source: "/work/report.md" }));
		await say(t, a.token, c, call("write", { path: "/work/report.md", content: "# v2\n", expected_etag: undefined }));
		await say(t, a.token, c, call("present_file", { source: "/work/report.md" }));
		const rs = await results(t, c, "present_file");
		assert.match(rs[0]!.text, /已交付/);
		assert.match(rs[1]!.text, /已更新（同名覆盖）/);
		const lib = t.app.ctx.services.get("library") as any;
		const items = lib.ofConversation(c.spaceId, c.conversationId).filter((i: any) => i.status === "active");
		assert.equal(items.length, 1, "one current file, one card");

		// a job output lands in the file service only: nothing appears in the library until present_file
		const jobs = t.app.ctx.services.get("jobs") as Jobs;
		const id = t.app.ctx.services.get("identity");
		const principal = (await id.principalFor(a.me.userId, a.me.orgId))!;
		const space = id.space(c.spaceId)!;
		const row = jobs.create(principal, space, c.conversationId, "r16-del-job", { kind: "generate", generate: { format: "md", name: "job.md", content: "x" } } as any);
		jobs.finish(row.id, "done", { summary: "ok", outputs: [{ fileId: "f", versionId: "v", versionNo: 1, name: "job.md" } as any] });
		assert.equal(lib.ofConversation(c.spaceId, c.conversationId).filter((i: any) => i.name === "job.md").length, 0);
		const ext = createJobsExtension(t.app.ctx, { resolveActor: fixedActor(t.app.ctx, a.me.userId, a.me.orgId, c.spaceId) });
		const status = ext.tools!.find((x) => x.name === "job_status")!;
		const out = await status.execute({} as any, fakeApi({ conversationId: c.conversationId, taskId: 1, callId: "js1" }), context);
		const text = (out.output![0] as any).text as string;
		assert.match(text, /已完成/);
		assert.match(text, new RegExp(`/work/jobs/${row.id}/job\\.md`));
		assert.match(text, /尚未交付/);
		assert.match(text, /present_file/);
	} finally {
		await t.dispose();
	}
});

test("job_status tells running / done / failed / cancelled / timeout apart and marks restart interruptions as 结果未知", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("r16-job@example.com");
		const c = await newChat(t, a.token);
		const jobs = t.app.ctx.services.get("jobs") as Jobs;
		const id = t.app.ctx.services.get("identity");
		const principal = (await id.principalFor(a.me.userId, a.me.orgId))!;
		const space = id.space(c.spaceId)!;
		const mk = (key: string, title: string) => jobs.create(principal, space, c.conversationId, key, { kind: "sandbox", title, sandbox: { language: "shell", code: "echo" } } as any);
		const queued = mk("k-q", "排队的");
		const failed = mk("k-f", "失败的");
		const cancelled = mk("k-c", "取消的");
		const timeout = mk("k-t", "超时的");
		const unknown = mk("k-u", "被打断的");
		jobs.finish(failed.id, "failed", { error: "exit 1" });
		jobs.finish(cancelled.id, "cancelled", { error: "已由用户取消" });
		jobs.finish(timeout.id, "timeout", { error: "超过时间预算" });
		jobs.finish(unknown.id, "failed", { error: "结果未知：服务重启中断了任务（第 1 次运行）" });
		const ext = createJobsExtension(t.app.ctx, { resolveActor: fixedActor(t.app.ctx, a.me.userId, a.me.orgId, c.spaceId) });
		const status = ext.tools!.find((x) => x.name === "job_status")!;
		const text = ((await status.execute({} as any, fakeApi({ conversationId: c.conversationId, taskId: 1, callId: "js2" }), context)).output![0] as any).text as string;
		const line = (j: { id: string }) => text.split("\n").find((l) => l.startsWith(`- ${j.id}`))!;
		assert.match(line(queued), /排队中/);
		assert.match(line(failed), /失败（failed）/);
		assert.match(line(cancelled), /已取消/);
		assert.match(line(timeout), /超时/);
		assert.match(line(unknown), /结果未知/);
		assert.doesNotMatch(line(failed), /结果未知/);
	} finally {
		await t.dispose();
	}
});

test("delegate catalog: the model is told member ids (and only where delegate exists)", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("r16-team@example.com");
		const { assistant } = await t.json("POST", "/api/assistants", { token: a.token, json: { name: "小队", members: [{ id: "echoer", name: "回声员", type: "builtin_subagent", description: "复述输入", tools: [], maxTurns: 2 }, { id: "mcpsvc", name: "外部服务", type: "external_tool", tools: [], maxTurns: 1, connectorId: "conn_x" }] } });
		const c = (await t.json("POST", "/api/conversations", { token: a.token, json: { assistantId: assistant.id } })).conversation as Conv;
		await say(t, a.token, c, "你好");
		const sec = (await sections(t, c)).team ?? "";
		assert.match(sec, /echoer：回声员，复述输入/);
		assert.match(sec, /mcpsvc.*不可委派/);
		// default assistant: the built-in team
		const d = await newChat(t, a.token);
		await say(t, a.token, d, "你好");
		assert.match((await sections(t, d)).team ?? "", /researcher：/);
	} finally {
		await t.dispose();
	}
	assert.equal(renderTeamSection({ member: { id: "x" }, members: [] }), undefined, "a member's own child conversation has no team");
	assert.equal(renderTeamSection({ members: [], tools: ["read"] }), undefined, "an allowlist without members leaves delegate out");
});

test("browser: every result carries an observation with click coordinates and the action just done", async () => {
	const els = [{ tag: "a", label: "去下一页", x: 200, y: 150 }, { tag: "input", type: "text", label: "搜索", x: 250, y: 320, focused: true }];
	const text = renderObservation({ title: "首页", url: "http://x/", version: 2, lastAction: "Agent：点击 (200, 150)", controller: { kind: "agent" }, blocked: [] }, "正文内容", els);
	assert.match(text, /刚才的操作：Agent：点击 \(200, 150\)/);
	assert.match(text, /1\. a “去下一页” \(200,150\)/);
	assert.match(text, /2\. input\[text\] “搜索” \(250,320\) ←焦点/);
	assert.match(text, /URL: http:\/\/x\//);
	assert.match(renderObservation({ url: "http://x/", version: 1, controller: { kind: "agent" }, blocked: [] }, "", []), /没有可点击元素/);

	// the collector reads the page through one evaluate call and survives a page that errors
	const { BrowserSessions: Cls } = await import("../src/tools/browser-sessions.ts");
	const fake = Object.create(Cls.prototype) as BrowserSessions;
	assert.deepEqual(await fake.elements({ page: { evaluate: async () => els } } as any), els);
	assert.deepEqual(await fake.elements({ page: { evaluate: async () => Promise.reject(new Error("closed")) } } as any), []);
});

test("the model-facing files section stays short and states the delivery and memory rules once", () => {
	const s = renderFilesSection({ backend: "沙盒", sharedSpace: false });
	assert.ok(s.length < 800, `files section is ${s.length} chars`);
	for (const must of [/skill_manage/, /expected_etag/, /present_file/, /copy_to_work/, /密码或密钥/, /同名覆盖/]) assert.match(s, must);
});
