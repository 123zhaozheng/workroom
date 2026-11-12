// Round 14 (docs/r14-virtual-backend.md §1): the /skills virtual backend.
//   V02 (+V24 "pure skill reads never start a sandbox"): ls / read of /skills (and /library) through the REAL runtime with a remote sandbox
//       provider configured create or connect NO sandbox; pagination; paths are virtual.
//   V03: installed / org skills are read-only (clear reason); the owner's personal skill is writable (write + edit → new skill package
//       version, visible through read); another user never sees it; copy_to_work of a skill folder (recursive) fills /work.
// FAKE provider = the labelled in-memory test double (it only counts calls). Fixture model only (no real AI).
process.env.WORKROOM_RT_RETRY_MAX ??= "1";
process.env.WORKROOM_SSE_THROTTLE_MS ??= "20";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { FakeRemoteProvider } from "./helpers/fake-remote-provider.ts";
import { providerConfigsFor } from "../src/tools/sandbox/provider-config.ts";
import type { Skills } from "../src/tools/skills.ts";
import type { VfsRouter } from "../src/vfs/router.ts";
import type { VfsContext } from "../src/vfs/types.ts";

type Conv = { spaceId: string; conversationId: number };
const base = (c: Conv) => `/api/conversations/${c.spaceId}/${c.conversationId}`;
const call = (tool: string, args: unknown) => `[[call ${tool} ${JSON.stringify(args)}]]`;
const PUBLIC_DNS = async () => [{ address: "93.184.216.34", family: 4 }];
const md = (name: string, description: string, body = "# 步骤\n\n先读数据，再出图。\n") => `---\nname: ${name}\ndescription: ${description}\nversion: 1.0.0\n---\n\n${body}`;

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
async function results(t: TestApp, c: Conv, name: string) {
	const h = await t.app.ctx.services.get("runtime").harness(c.spaceId, BACKGROUND_CONTEXT);
	const conv = (await h.conversation(c.conversationId as any, BACKGROUND_CONTEXT))!;
	const items = (await conv.entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT)).items as any[];
	return items.filter((e) => e.kind === "pi.tool-result" && e.model?.[0]?.toolName === name).map((e) => ({ text: e.model[0].content.map((x: any) => x.text ?? "").join(""), isError: !!e.model[0].isError, details: e.model[0].details }));
}
const upload = async (t: TestApp, token: string, files: { path: string; content: string }[]) => (await t.json("POST", "/api/market/skills/upload", { token, json: { files } })).skill as { id: string };

async function world() {
	const t = await startTestApp({ config: { secretKey: "workroom-test-secret-key-0123456789" } });
	const admin = await t.user("skl-admin@example.com");
	const inv = await t.json("POST", "/api/admin/invites", { token: admin.token, json: { role: "member" } });
	const member = await t.user("skl-member@example.com", { inviteCode: inv.invite.code });
	const ctx = t.app.ctx;
	const id = ctx.services.get("identity");
	const fake = new FakeRemoteProvider();
	const svc = providerConfigsFor(ctx);
	svc.resolver = PUBLIC_DNS;
	svc.factory = async () => fake;
	await t.json("PUT", "/api/sandbox/providers/opensandbox", { token: admin.token, json: { enabled: true, endpoint: "https://os.example.test", apiKey: "sk-fake-r14skills-0123456789", allowPrivateNetwork: false, egressAcknowledged: true } });
	await t.json("PUT", "/api/sandbox/provider-policy", { token: admin.token, json: { orgDefault: "opensandbox", allowProjectOverride: false } });
	const vctx = async (u: { me: any }, conversationId = 1): Promise<VfsContext> => ({ principal: (await id.principalFor(u.me.userId, u.me.orgId))!, space: id.personalSpace(u.me.userId, u.me.orgId), conversationId });
	const instances = () => ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tool_sandbox_instances")!.n;
	return { t, ctx, admin, member, fake, vctx, instances, vfs: ctx.services.get("vfs") as unknown as VfsRouter, skills: ctx.services.get("skills") as Skills };
}

test("V02/V24: ls / read of /skills and /library with a remote provider configured create and connect NO sandbox; pagination; virtual paths", { timeout: 120_000 }, async () => {
	const w = await world();
	try {
		const { t, admin, fake } = w;
		await upload(t, admin.token, [{ path: "SKILL.md", content: md("report-kit", "出报表。当用户要做数据报表时使用。") }, { path: "scripts/analyze.py", content: "print('hi')\n" }, { path: "references/notes.txt", content: "参考资料" }]);
		for (let i = 1; i <= 5; i++) await upload(t, admin.token, [{ path: "SKILL.md", content: md(`pg-0${i}`, `第 ${i} 号`) }]);
		const c: Conv = (await t.json("POST", "/api/conversations", { token: admin.token, json: { title: "技能读取" } })).conversation;

		await say(t, admin.token, c, call("ls", { path: "/" }));
		assert.match((await results(t, c, "ls"))[0]!.text, /\[目录\] skills\//);

		await say(t, admin.token, c, call("ls", { path: "/skills", limit: 3 }));
		const p1 = (await results(t, c, "ls"))[1]!;
		assert.ok(!p1.isError, p1.text);
		assert.match(p1.text, /还有更多/);
		const cursor = /cursor="([^"]+)"/.exec(p1.text)![1]!;
		assert.equal(p1.text.split("\n").filter((l: string) => l.startsWith("[目录]")).length, 3);
		await say(t, admin.token, c, call("ls", { path: "/skills", cursor, limit: 10 }));
		const p2 = (await results(t, c, "ls"))[2]!;
		assert.equal(p2.text.split("\n").filter((l: string) => l.startsWith("[目录]")).length, 3, "6 skills = 3 + 3");
		assert.doesNotMatch(p2.text, /还有更多/);
		assert.match(p1.text + p2.text, /report-kit\//);

		await say(t, admin.token, c, call("ls", { path: "/skills/report-kit" }));
		const dir = (await results(t, c, "ls"))[3]!.text;
		assert.match(dir, /\[文件\] SKILL\.md/);
		assert.match(dir, /\[目录\] scripts\//);
		await say(t, admin.token, c, call("read", { path: "/skills/report-kit/SKILL.md" }));
		const rd = (await results(t, c, "read"))[0]!;
		assert.ok(!rd.isError, rd.text);
		assert.match(rd.text, /name: report-kit/);
		await say(t, admin.token, c, call("read", { path: "/skills/report-kit/scripts/analyze.py" }));
		assert.match((await results(t, c, "read"))[1]!.text, /print\('hi'\)/);
		await say(t, admin.token, c, call("ls", { path: "/library" }));
		assert.ok(!(await results(t, c, "ls"))[4]!.isError);
		await say(t, admin.token, c, call("search", { path: "/skills", query: "analyze", mode: "name" }));
		assert.match((await results(t, c, "search"))[0]!.text, /\/skills\/report-kit\/scripts\/analyze\.py/);

		for (const r of [...(await results(t, c, "ls")), ...(await results(t, c, "read"))]) assert.doesNotMatch(r.text, /\/home\/|\/tmp\/|orgs\/|spaces\/|blob/, `no host path: ${r.text.slice(0, 120)}`);
		assert.equal(fake.created, 0, "no provider sandbox was created");
		assert.equal(fake.boxes.size, 0);
		assert.equal(w.instances(), 0, "no sandbox instance row");
	} finally {
		await w.t.dispose();
	}
});

test("V03: installed / org skills are read-only with a reason; the owner's personal skill is writable (new version); others never see it", async () => {
	const w = await world();
	try {
		const { t, admin, member, vfs, skills } = w;
		const a = await w.vctx(admin);
		const m = await w.vctx(member);

		// an org skill published by the admin, installed by the member (market skill installed → read-only)
		const created = await t.json("POST", "/api/skills", { token: admin.token, json: { name: "org-guide", kind: "context", scope: "org", description: "组织指南", instructions: "# 组织指南\n\n按规范办。" } });
		const orgId = created.skill.id as string;
		await t.json("POST", `/api/market/skills/${orgId}/install`, { token: member.token, json: { target: "me" } });
		const orgSlug = (await vfs.list(m, "/skills")).entries.map((e) => e.name).find((n) => n.startsWith("org-guide"))!;
		assert.ok(orgSlug, "member sees the installed org skill");
		const md0 = await vfs.read(m, `/skills/${orgSlug}/SKILL.md`);
		assert.match(new TextDecoder().decode(md0.bytes), /按规范办/, "a legacy version gets a synthesized SKILL.md");
		assert.deepEqual(md0.node.caps, ["read"]);
		const root = (await vfs.list(m, "/skills")).entries.find((e) => e.name === orgSlug)!;
		assert.deepEqual(root.caps, ["read"]);
		assert.match(root.note ?? "", /只读/);
		const before = skills.versions(orgId).length;
		const ro = (p: Promise<unknown>) => assert.rejects(p, (e: any) => e.code === "read_only" && /组织技能/.test(e.message) && /copy_to_work/.test(e.message));
		await ro(vfs.write(m, `/skills/${orgSlug}/SKILL.md`, new TextEncoder().encode("x")));
		await ro(vfs.write(m, `/skills/${orgSlug}/extra.txt`, new TextEncoder().encode("x")));
		await ro(vfs.remove(m, `/skills/${orgSlug}/SKILL.md`, {}));
		assert.equal(skills.versions(orgId).length, before, "no version created by refused writes");

		// the owner's personal skill
		const mine = await upload(t, member.token, [{ path: "SKILL.md", content: md("my-notes", "我的笔记技能") }, { path: "references/tips.txt", content: "tip one\n" }]);
		const top = (await vfs.list(m, "/skills")).entries.find((e) => e.name === "my-notes")!;
		assert.deepEqual(top.caps, ["read", "write"]);
		const tips = await vfs.read(m, "/skills/my-notes/references/tips.txt");
		assert.deepEqual(tips.node.caps, ["read", "write", "edit", "remove"]);
		const v1 = skills.versions(mine.id).length;
		const w1 = await vfs.write(m, "/skills/my-notes/references/tips.txt", new TextEncoder().encode("tip one\ntip two\n"), { expectedEtag: tips.node.etag });
		assert.equal(w1.status, "updated");
		assert.equal(skills.versions(mine.id).length, v1 + 1, "a write is a new skill package version");
		assert.equal(new TextDecoder().decode((await vfs.read(m, "/skills/my-notes/references/tips.txt")).bytes), "tip one\ntip two\n");
		await assert.rejects(vfs.write(m, "/skills/my-notes/references/tips.txt", new TextEncoder().encode("z"), { expectedEtag: tips.node.etag }), (e: any) => e.code === "etag_mismatch");
		assert.equal((await vfs.write(m, "/skills/my-notes/references/tips.txt", new TextEncoder().encode("tip one\ntip two\n"), {})).status, "unchanged");
		assert.equal(skills.versions(mine.id).length, v1 + 1, "unchanged content makes no version");
		const w2 = await vfs.write(m, "/skills/my-notes/scripts/run.py", new TextEncoder().encode("print(1)\n"), {});
		assert.equal(w2.status, "created");
		assert.ok((await vfs.list(m, "/skills/my-notes")).entries.some((e) => e.name === "scripts" && e.type === "dir"));
		// SKILL.md stays a valid skill: name pinned, instructions follow the body
		await assert.rejects(vfs.write(m, "/skills/my-notes/SKILL.md", new TextEncoder().encode(md("other-name", "x")), {}), (e: any) => /my-notes/.test(e.message));
		await vfs.write(m, "/skills/my-notes/SKILL.md", new TextEncoder().encode(md("my-notes", "我的笔记技能", "# 新正文\n\n改过了。\n")), {});
		assert.match(skills.version(mine.id, skills.skill(mine.id)!.latest_version_no)!.instructions, /改过了/);
		// remove: a file, a directory (needs recursive), never SKILL.md
		await assert.rejects(vfs.remove(m, "/skills/my-notes/scripts", {}), (e: any) => /recursive/.test(e.message));
		await vfs.remove(m, "/skills/my-notes/scripts", { recursive: true });
		assert.equal(await vfs.stat(m, "/skills/my-notes/scripts/run.py"), null);
		await assert.rejects(vfs.remove(m, "/skills/my-notes/SKILL.md", {}), (e: any) => e.code === "forbidden");

		// the author's other person: no access, no existence leak (same errors as a skill that does not exist)
		assert.ok(!(await vfs.list(a, "/skills")).entries.some((e) => e.name === "my-notes"));
		assert.equal(await vfs.stat(a, "/skills/my-notes"), null);
		await assert.rejects(vfs.read(a, "/skills/my-notes/SKILL.md"), (e: any) => e.code === "not_found");
		await assert.rejects(vfs.list(a, "/skills/my-notes"), (e: any) => e.code === "not_found");
		const probe = await vfs.write(a, "/skills/my-notes/references/tips.txt", new TextEncoder().encode("hijack"), {}).then(() => "wrote", (e: any) => e.code);
		assert.equal(probe, "not_found");
		const ghost = await vfs.write(a, "/skills/no-such-skill/references/tips.txt", new TextEncoder().encode("x"), {}).then(() => "wrote", (e: any) => e.code);
		assert.equal(probe, ghost, "an unreadable skill answers exactly like a missing one");
		assert.match(new TextDecoder().decode((await vfs.read(m, "/skills/my-notes/references/tips.txt")).bytes), /tip two/, "the owner's skill is untouched");

		// creating a new personal skill through /skills: needs a valid SKILL.md whose name is the folder
		await assert.rejects(vfs.write(m, "/skills/fresh/notes.txt", new TextEncoder().encode("x"), {}), (e: any) => e.code === "not_found" && /SKILL\.md/.test(e.message));
		await assert.rejects(vfs.write(m, "/skills/fresh/SKILL.md", new TextEncoder().encode(md("different", "x")), {}), (e: any) => e.code === "bad_path");
		const made = await vfs.write(m, "/skills/fresh/SKILL.md", new TextEncoder().encode(md("fresh", "新技能")), {});
		assert.equal(made.status, "created");
		assert.ok((await vfs.list(m, "/skills")).entries.some((e) => e.name === "fresh"));
		assert.ok(!(await vfs.list(a, "/skills")).entries.some((e) => e.name === "fresh"));
	} finally {
		await w.t.dispose();
	}
});

test("V03: edit through the runtime on an owned skill; copy_to_work(recursive) puts the skill folder into /work; read-only skill edit is refused; no sandbox", { timeout: 120_000 }, async () => {
	const w = await world();
	try {
		const { t, admin, member, fake, skills } = w;
		const mine = await upload(t, admin.token, [{ path: "SKILL.md", content: md("data-kit", "数据工具") }, { path: "scripts/analyze.py", content: "print('analyze')\n" }, { path: "references/readme.txt", content: "v1 text\n" }]);
		const c: Conv = (await t.json("POST", "/api/conversations", { token: admin.token, json: { title: "编辑技能" } })).conversation;

		await say(t, admin.token, c, call("edit", { path: "/skills/data-kit/references/readme.txt", old_text: "v1 text", new_text: "v2 text" }));
		const ed = (await results(t, c, "edit"))[0]!;
		assert.ok(!ed.isError, ed.text);
		await say(t, admin.token, c, call("read", { path: "/skills/data-kit/references/readme.txt" }));
		assert.match((await results(t, c, "read"))[0]!.text, /v2 text/);
		assert.equal(skills.versions(mine.id).length, 2);

		await say(t, admin.token, c, call("copy_to_work", { source: "/skills/data-kit" }));
		assert.match((await results(t, c, "copy_to_work"))[0]!.text, /recursive/, "directory copy needs recursive");
		await say(t, admin.token, c, call("copy_to_work", { source: "/skills/data-kit", recursive: true }));
		const cp = (await results(t, c, "copy_to_work"))[1]!;
		assert.ok(!cp.isError, cp.text);
		await say(t, admin.token, c, call("ls", { path: "/work/data-kit/scripts" }));
		assert.match((await results(t, c, "ls")).at(-1)!.text, /analyze\.py/);
		await say(t, admin.token, c, call("read", { path: "/work/data-kit/references/readme.txt" }));
		assert.match((await results(t, c, "read")).at(-1)!.text, /v2 text/, "the copy carries the current version");
		// the copy is a plain /work file: editing it does not touch the skill
		await say(t, admin.token, c, call("write", { path: "/work/data-kit/references/readme.txt", content: "scratch\n" }));
		assert.match(new TextDecoder().decode((await w.vfs.read(await w.vctx(admin), "/skills/data-kit/references/readme.txt")).bytes), /v2 text/);

		// another member: the admin's personal skill is invisible; their own conversation cannot edit a read-only (installed org) skill
		const created = await t.json("POST", "/api/skills", { token: admin.token, json: { name: "org-ro", kind: "context", scope: "org", description: "只读", instructions: "# ro" } });
		await t.json("POST", `/api/market/skills/${created.skill.id}/install`, { token: member.token, json: { target: "me" } });
		const mc: Conv = (await t.json("POST", "/api/conversations", { token: member.token, json: { title: "成员" } })).conversation;
		await say(t, member.token, mc, call("ls", { path: "/skills" }));
		const lsm = (await results(t, mc, "ls"))[0]!.text;
		assert.match(lsm, /org-ro/);
		assert.doesNotMatch(lsm, /data-kit/);
		await say(t, member.token, mc, call("read", { path: "/skills/data-kit/SKILL.md" }));
		assert.match((await results(t, mc, "read"))[0]!.text, /not_found/);
		const slug = /(org-ro-[a-z0-9]+)\//.exec(lsm)![1]!;
		await say(t, member.token, mc, call("edit", { path: `/skills/${slug}/SKILL.md`, old_text: "# ro", new_text: "# changed" }));
		const refused = (await results(t, mc, "edit"))[0]!;
		assert.ok(refused.isError);
		assert.match(refused.text, /read_only/);
		assert.match(refused.text, /组织技能/);

		assert.equal(fake.created, 0, "none of this started a sandbox");
		assert.equal(w.instances(), 0);
	} finally {
		await w.t.dispose();
	}
});
