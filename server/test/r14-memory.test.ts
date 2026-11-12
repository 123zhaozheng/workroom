// Round 14 (requirement §6, V04–V07, V16 memory parts, §11.1 item 1): Markdown long-term memory through the REAL runtime and fixture model.
//   V04 new conversation sees the current MEMORY.md; the agent maintains preferences.md with write/edit
//   V05 a front-end save is in the very next model request; the old DB text never is
//   V06 agent edit vs. front-end save with a stale etag → 409, nothing overwritten (and the other way round)
//   V07 deleting a topic removes its index line and search hits and nothing is resurrected after restart / migration re-run
//   V16 isolation: other people's memory, shared conversations, traversal, symlink escape
//   migration: backup + report + Markdown content, one-time
process.env.WORKROOM_RT_RETRY_MAX ??= "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { joinOrg } from "../src/knowledge/testing.ts";
import { migrateMemoryToMarkdown, MIGRATION_MARKER } from "../src/knowledge/memory-migrate.ts";

type Conv = { spaceId: string; conversationId: number };
const base = (c: Conv) => `/api/conversations/${c.spaceId}/${c.conversationId}`;
const call = (tool: string, args: unknown) => `[[call ${tool} ${JSON.stringify(args)}]]`;
const q = (scope: string, path?: string) => `scope=${encodeURIComponent(scope)}${path === undefined ? "" : `&path=${encodeURIComponent(path)}`}`;

async function say(t: TestApp, token: string, c: Conv, text: string, extra: object = {}) {
	const r = await t.json("POST", `${base(c)}/messages`, { token, json: { text, requestId: randomUUID(), ...extra } });
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
	return (await entries(t, c)).filter((e) => e.kind === "pi.tool-result" && e.model?.[0]?.toolName === name).map((e) => ({ text: e.model[0].content.map((x: any) => x.text ?? "").join(""), isError: !!e.model[0].isError, details: e.model[0].details }));
}
/** Effective system-prompt sections (pi re-sends only changed sections: fold all pi.system entries). */
async function sections(t: TestApp, c: Conv): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const e of await entries(t, c)) if (e.kind === "pi.system") Object.assign(out, e.model?.[0]?.sections ?? {});
	return out;
}
const newChat = async (t: TestApp, token: string, body: object = {}): Promise<Conv> => (await t.json("POST", "/api/conversations", { token, json: body })).conversation;
const getFile = (t: TestApp, token: string, scope: string, path: string) => t.req("GET", `/api/memory/file?${q(scope, path)}`, { token });
async function putFile(t: TestApp, token: string, scope: string, path: string, content: string, ifMatch?: string) {
	let match = ifMatch;
	if (match === undefined) {
		const cur = await getFile(t, token, scope, path);
		if (cur.status === 200) match = ((await cur.json()) as any).file.etag;
	}
	return t.req("PUT", `/api/memory/file?${q(scope, path)}`, { token, json: { content }, headers: match === undefined ? {} : { "if-match": match } });
}
const memDir = (t: TestApp, me: any) => (t.app.ctx.services.get("knowledgeAdmin") as any).memory.personalDir(me.orgId, me.userId) as string;

test("V04: a new conversation gets the current MEMORY.md; the agent maintains preferences.md with write/edit and the next conversation sees it", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("mem-a@example.com");
		assert.equal((await putFile(t, a.token, "personal", "MEMORY.md", "# 长期记忆\n\n- [偏好](preferences.md)\n- 核心：回答用简体中文 MEM-CORE-1\n")).status, 200);
		const c1 = await newChat(t, a.token);
		await say(t, a.token, c1, "[[reply ok]]");
		const s1 = (await sections(t, c1)).memory ?? "";
		assert.match(s1, /MEM-CORE-1/);
		assert.match(s1, /\/memory\/MEMORY\.md/);

		// the agent: write a new preferences file, then edit it (both through the unified tools)
		await say(t, a.token, c1, call("write", { path: "/memory/preferences.md", content: "# 偏好\n- 回答先给结论\n" }));
		const w = (await results(t, c1, "write"))[0]!;
		assert.ok(!w.isError, w.text);
		await say(t, a.token, c1, call("edit", { path: "/memory/preferences.md", old_text: "- 回答先给结论\n", new_text: "- 回答先给结论\n- 数字用万元（对话依据：用户明确要求）\n" }));
		const e = (await results(t, c1, "edit"))[0]!;
		assert.ok(!e.isError, e.text);
		const onDisk = readFileSync(join(memDir(t, a.me), "preferences.md"), "utf8");
		assert.equal(onDisk, "# 偏好\n- 回答先给结论\n- 数字用万元（对话依据：用户明确要求）\n");
		// the front-end reads exactly the same bytes
		assert.equal(((await (await getFile(t, a.token, "personal", "preferences.md")).json()) as any).content, onDisk);

		// a NEW conversation: the index is in its prompt and the agent can read the topic file the other conversation wrote
		const c2 = await newChat(t, a.token);
		await say(t, a.token, c2, call("read", { path: "/memory/preferences.md" }));
		assert.match((await sections(t, c2)).memory ?? "", /MEM-CORE-1/);
		assert.match((await results(t, c2, "read"))[0]!.text, /数字用万元/);
		await say(t, a.token, c2, call("ls", { path: "/memory" }));
		const ls = (await results(t, c2, "ls"))[0]!.text;
		assert.match(ls, /\[文件\] MEMORY\.md .*\(read,write,edit,remove\)/);
		assert.match(ls, /\[文件\] preferences\.md/);
		assert.match(ls, /\[目录\] shared\//);
		assert.doesNotMatch(ls, /\/home\/|\/tmp\/|orgs\//, "no host path");
	} finally {
		await t.dispose();
	}
});

test("V04: injection budget — a long MEMORY.md is cut with a note naming the topic files; the files are never modified; env budget is honoured", async () => {
	const t = await startTestApp();
	const prev = process.env.WORKROOM_MEMORY_PROMPT_CHARS;
	process.env.WORKROOM_MEMORY_PROMPT_CHARS = "800";
	try {
		const a = await t.user("mem-budget@example.com");
		await putFile(t, a.token, "personal", "projects/apollo.md", "# Apollo\n");
		const long = `# 长期记忆\n- [Apollo](projects/apollo.md)\nHEAD-MARK\n${"很长的一行记忆内容。".repeat(400)}\nTAIL-MARK\n`;
		await putFile(t, a.token, "personal", "MEMORY.md", long);
		const before = readFileSync(join(memDir(t, a.me), "MEMORY.md"), "utf8");
		const c = await newChat(t, a.token);
		await say(t, a.token, c, "[[reply ok]]");
		const s = (await sections(t, c)).memory ?? "";
		assert.ok(s.length < 1400, `section is bounded: ${s.length}`);
		assert.match(s, /HEAD-MARK/);
		assert.doesNotMatch(s, /TAIL-MARK/);
		assert.match(s, /已截断.*\/memory\/MEMORY\.md.*\/memory\/projects\/apollo\.md/);
		assert.equal(readFileSync(join(memDir(t, a.me), "MEMORY.md"), "utf8"), before, "the file on disk is untouched");
	} finally {
		if (prev === undefined) delete process.env.WORKROOM_MEMORY_PROMPT_CHARS;
		else process.env.WORKROOM_MEMORY_PROMPT_CHARS = prev;
		await t.dispose();
	}
});

test("V05: a front-end save is in the next model request's system sections; the old DB text is never injected", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("mem-v5@example.com");
		// an old DB row (the retired model) must not be read any more
		t.app.ctx.db.run(
			"INSERT INTO mem_items (id, org_id, scope, owner_user_id, kind, content, source, status, version, created_by, created_at, updated_by, updated_at) VALUES ('mem_old', ?, 'private', ?, 'preference', 'OLD-DB-TEXT 来自数据库的旧记忆', 'user', 'active', 1, ?, '2026-01-01T00:00:00Z', ?, '2026-01-01T00:00:00Z')",
			a.me.orgId, a.me.userId, a.me.userId, a.me.userId,
		);
		await putFile(t, a.token, "personal", "MEMORY.md", "# 长期记忆\nNEW-V1 第一版\n");
		const c = await newChat(t, a.token);
		await say(t, a.token, c, "[[reply one]]");
		let m = (await sections(t, c)).memory ?? "";
		assert.match(m, /NEW-V1/);
		assert.doesNotMatch(m, /OLD-DB-TEXT/);
		// the user edits in the page (PUT with the etag he read)
		assert.equal((await putFile(t, a.token, "personal", "MEMORY.md", "# 长期记忆\nNEW-V2 第二版\n")).status, 200);
		await say(t, a.token, c, "[[reply two]]");
		m = (await sections(t, c)).memory ?? "";
		assert.match(m, /NEW-V2/);
		assert.doesNotMatch(m, /NEW-V1/, "no stale cache");
		assert.doesNotMatch(m, /OLD-DB-TEXT/);
		// the retired routes do not write a competing copy
		assert.equal((await t.req("POST", "/api/memory", { token: a.token, json: { content: "x", scope: "private" } })).status, 410);
		assert.equal(t.app.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM mem_items")!.n, 1);
	} finally {
		await t.dispose();
	}
});

test("V06: agent edit then a front-end save with the stale etag → 409 and the agent's text survives; the reverse order is refused to the agent", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("mem-v6@example.com");
		const w = await putFile(t, a.token, "personal", "preferences.md", "# 偏好\n- 简体中文\n");
		const etagSeenByUser = ((await w.json()) as any).file.etag as string;
		const c = await newChat(t, a.token);
		// the agent edits while the user still has the old version open
		await say(t, a.token, c, call("edit", { path: "/memory/preferences.md", old_text: "- 简体中文\n", new_text: "- 简体中文\n- AGENT-LINE\n" }));
		assert.ok(!(await results(t, c, "edit"))[0]!.isError);
		const res = await putFile(t, a.token, "personal", "preferences.md", "# 偏好\nUSER-LOCAL-DRAFT\n", etagSeenByUser);
		assert.equal(res.status, 409);
		const err = ((await res.json()) as any).error;
		assert.equal(err.code, "memory_conflict");
		assert.match(err.message, /已被修改/);
		const now = ((await (await getFile(t, a.token, "personal", "preferences.md")).json()) as any);
		assert.match(now.content, /AGENT-LINE/);
		assert.doesNotMatch(now.content, /USER-LOCAL-DRAFT/);

		// reverse: the user saves, the agent still holds the previous etag → the agent's write/edit are refused, the user's text survives
		const saved = await putFile(t, a.token, "personal", "preferences.md", "# 偏好\nUSER-SAVED\n", now.file.etag);
		assert.equal(saved.status, 200);
		await say(t, a.token, c, call("write", { path: "/memory/preferences.md", content: "agent clobber", expected_etag: now.file.etag }));
		const wr = (await results(t, c, "write"))[0]!;
		assert.ok(wr.isError);
		assert.match(wr.text, /etag_mismatch|已被修改/);
		await say(t, a.token, c, call("edit", { path: "/memory/preferences.md", old_text: "USER-SAVED", new_text: "agent edit", expected_etag: now.file.etag }));
		assert.ok((await results(t, c, "edit")).at(-1)!.isError);
		assert.equal(readFileSync(join(memDir(t, a.me), "preferences.md"), "utf8"), "# 偏好\nUSER-SAVED\n");
	} finally {
		await t.dispose();
	}
});

test("V07: deleting a topic removes its index line and search hits; nothing comes back after a migration re-run or a restart", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "wr-v07-"));
	let t = await startTestApp({ dataDir });
	try {
		const a = await t.user("mem-v7@example.com");
		const topic = (await t.json("POST", "/api/memory/topics", { token: a.token, json: { scope: "personal", title: "咖啡店选址", content: "# 咖啡店选址\nZEBRA-TOKEN 靠近地铁口\n" } })).file;
		assert.match(((await (await getFile(t, a.token, "personal", "MEMORY.md")).json()) as any).content, /咖啡店选址/);
		const c = await newChat(t, a.token);
		await say(t, a.token, c, call("search", { query: "ZEBRA-TOKEN", mode: "content", path: "/memory" }));
		assert.match((await results(t, c, "search"))[0]!.text, new RegExp(`/memory/${topic.path}:2`));
		// a stale DB row with the same text must not bring it back either
		t.app.ctx.db.run(
			"INSERT INTO mem_items (id, org_id, scope, owner_user_id, kind, content, source, status, version, created_by, created_at, updated_by, updated_at) VALUES ('mem_z', ?, 'private', ?, 'fact', 'ZEBRA-TOKEN 靠近地铁口', 'user', 'active', 1, ?, '2026-01-01T00:00:00Z', ?, '2026-01-01T00:00:00Z')",
			a.me.orgId, a.me.userId, a.me.userId, a.me.userId,
		);

		const del = await t.json("DELETE", `/api/memory/file?${q("personal", topic.path)}`, { token: a.token });
		assert.equal(del.indexUpdated, true);
		assert.doesNotMatch(((await (await getFile(t, a.token, "personal", "MEMORY.md")).json()) as any).content, /咖啡店选址/);
		await say(t, a.token, c, call("search", { query: "ZEBRA-TOKEN", mode: "content", path: "/memory" }));
		assert.match((await results(t, c, "search"))[1]!.text, /没有找到/);
		await say(t, a.token, c, call("search", { query: "咖啡店选址", mode: "name", path: "/memory" }));
		assert.match((await results(t, c, "search"))[2]!.text, /没有找到/);
		await say(t, a.token, c, "[[reply next]]");
		assert.doesNotMatch((await sections(t, c)).memory ?? "", /ZEBRA-TOKEN|咖啡店选址/);

		// migration re-run and restart: marker set → nothing is imported again
		const k = t.app.ctx.services.get("knowledgeAdmin") as any;
		assert.equal(migrateMemoryToMarkdown(t.app.ctx, k.memory).ran, false);
		await t.stop();
		t = await startTestApp({ dataDir });
		assert.equal((await getFile(t, a.token, "personal", topic.path)).status, 404);
		assert.equal(existsSync(join(memDir(t, a.me), "facts.md")), false, "the DB row was not imported after the migration ran");
		const files = (await t.json("GET", `/api/memory/files?${q("personal")}`, { token: a.token })).files.map((f: any) => f.path);
		assert.deepEqual(files, ["MEMORY.md"]);
	} finally {
		await t.dispose();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("V16 (memory): other people's memory is invisible; shared conversations get no personal memory; traversal and symlink escapes are refused; caps are truthful", async () => {
	const t = await startTestApp();
	const outside = mkdtempSync(join(tmpdir(), "wr-v16-out-"));
	try {
		const alice = await t.user("mem-alice@example.com");
		const bob = await joinOrg(t, alice.me.orgId, "mem-bob@example.com");
		await putFile(t, alice.token, "personal", "MEMORY.md", "# 长期记忆\nALICE-SECRET-MEM\n");
		await putFile(t, alice.token, "org", "MEMORY.md", "# 企业\nORG-SHARED-MEM\n");

		// bob's agent: no alice memory in prompt, ls, read or search; but the org scope is readable and read-only for him
		const bc = await newChat(t, bob.token);
		await say(t, bob.token, bc, [call("ls", { path: "/memory" }), call("read", { path: "/memory/MEMORY.md" }), call("search", { query: "ALICE-SECRET-MEM", mode: "content", path: "/" }), call("ls", { path: "/memory/shared/org" }), call("write", { path: "/memory/shared/org/hack.md", content: "x" })].join(" "));
		const bs = (await sections(t, bc)).memory ?? "";
		assert.doesNotMatch(bs, /ALICE-SECRET-MEM/);
		assert.match(bs, /ORG-SHARED-MEM/);
		assert.doesNotMatch((await results(t, bc, "ls"))[0]!.text, /MEMORY\.md|preferences/, "bob's own personal memory is empty");
		assert.ok((await results(t, bc, "read"))[0]!.isError);
		assert.doesNotMatch((await results(t, bc, "search"))[0]!.text, /ALICE-SECRET-MEM/);
		const orgLs = (await results(t, bc, "ls"))[1]!.text;
		assert.match(orgLs, /MEMORY\.md .*\(read\)/, "a member's cap on org memory is read only");
		assert.ok((await results(t, bc, "write"))[0]!.isError);
		assert.equal(existsSync(join(t.dataDir, "orgs", alice.me.orgId, "memory", "org", "hack.md")), false);

		// a shared PROJECT conversation (space project): no personal memory for anyone, shared scopes only
		const { project } = await t.json("POST", "/api/projects", { token: alice.token, json: { kind: "space", name: "Apollo" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: alice.token, json: { email: "mem-bob@example.com", role: "editor" } });
		await putFile(t, alice.token, `project:${project.id}`, "MEMORY.md", "# 项目\nAPOLLO-SHARED-MEM\n");
		const pc = await newChat(t, alice.token, { spaceId: project.spaceId });
		await say(t, alice.token, pc, [call("ls", { path: "/memory" }), call("read", { path: "/memory/MEMORY.md" }), call("search", { query: "ALICE-SECRET-MEM", mode: "content" }), call("ls", { path: "/memory/shared/project" })].join(" "));
		const ps = (await sections(t, pc)).memory ?? "";
		assert.doesNotMatch(ps, /ALICE-SECRET-MEM/);
		assert.match(ps, /APOLLO-SHARED-MEM/);
		assert.doesNotMatch((await results(t, pc, "ls"))[0]!.text, /MEMORY\.md/);
		const rd = (await results(t, pc, "read"))[0]!;
		assert.ok(rd.isError);
		assert.match(rd.text, /forbidden|不可用/);
		assert.doesNotMatch((await results(t, pc, "search"))[0]!.text, /ALICE-SECRET-MEM/);
		assert.match((await results(t, pc, "ls"))[1]!.text, new RegExp(project.id));
		await say(t, bob.token, pc, call("read", { path: "/memory/MEMORY.md" }));
		assert.ok((await results(t, pc, "read")).at(-1)!.isError, "bob in the shared conversation cannot read personal memory either (his own is not offered there)");

		// a conversation of a container project with a READ share is readable by others → counts as shared: no personal memory
		const cp = (await t.json("POST", "/api/projects", { token: alice.token, json: { name: "共享容器" } })).project;
		const own = await newChat(t, alice.token, { projectId: cp.id });
		await say(t, alice.token, own, call("read", { path: "/memory/MEMORY.md" }));
		assert.ok(!(await results(t, own, "read"))[0]!.isError, "unshared container project: personal memory is available");
		assert.match((await sections(t, own)).memory ?? "", /ALICE-SECRET-MEM/);
		await t.json("PUT", `/api/projects/${cp.id}/shares/${bob.me.userId}`, { token: alice.token, json: { permission: "read" } });
		const shared = await newChat(t, alice.token, { projectId: cp.id });
		await say(t, alice.token, shared, [call("read", { path: "/memory/MEMORY.md" }), call("ls", { path: "/memory" })].join(" "));
		assert.ok((await results(t, shared, "read"))[0]!.isError);
		assert.doesNotMatch((await results(t, shared, "ls"))[0]!.text, /MEMORY\.md/);
		assert.doesNotMatch((await sections(t, shared)).memory ?? "", /ALICE-SECRET-MEM/);
		assert.match((await sections(t, shared)).memory ?? "", /ORG-SHARED-MEM/, "shared scopes still apply");

		// path traversal: leaving /memory lands in another root (unknown) or is refused; never in the host (a plain personal conversation)
		const plain = await newChat(t, alice.token);
		await say(t, alice.token, plain, [call("read", { path: "/memory/../etc/passwd" }), call("read", { path: "/memory/shared/../../../etc/passwd" }), call("write", { path: "/memory/../../x.md", content: "x" }), call("write", { path: "/memory/a/../../../y.md", content: "x" })].join(" "));
		const trav = await results(t, plain, "read");
		assert.match(trav[0]!.text, /unknown_root/);
		assert.match(trav[1]!.text, /bad_path|unknown_root/);
		for (const r of await results(t, plain, "write")) assert.match(r.text, /bad_path|unknown_root/);
		assert.equal(existsSync(join(t.dataDir, "x.md")) || existsSync(join(t.dataDir, "..", "x.md")), false);

		// symlink escape inside the personal directory (planted behind the service's back): refused, never followed
		const secretFile = join(outside, "secret.txt");
		writeFileSync(secretFile, "OUTSIDE-SECRET");
		mkdirSync(join(outside, "dir"));
		writeFileSync(join(outside, "dir", "in.md"), "OUTSIDE-DIR-SECRET");
		const mdir = memDir(t, alice.me);
		symlinkSync(secretFile, join(mdir, "evil.md"));
		symlinkSync(join(outside, "dir"), join(mdir, "escape"));
		await say(t, alice.token, plain, [call("read", { path: "/memory/evil.md" }), call("read", { path: "/memory/escape/in.md" }), call("write", { path: "/memory/escape/new.md", content: "pwn" }), call("write", { path: "/memory/evil.md", content: "pwn" }), call("ls", { path: "/memory" }), call("search", { query: "OUTSIDE", mode: "content", path: "/memory" })].join(" "));
		const reads = await results(t, plain, "read");
		assert.match(reads.at(-2)!.text, /forbidden.*允许范围之外|forbidden.*路径无效|错误（forbidden）/);
		assert.match(reads.at(-1)!.text, /错误（forbidden）/);
		assert.doesNotMatch(reads.at(-2)!.text + reads.at(-1)!.text, /OUTSIDE|不可用/, "refused because of the link, not because personal memory is unavailable");
		for (const r of (await results(t, plain, "write")).slice(-2)) assert.match(r.text, /错误（forbidden）/);
		assert.equal(readdirSync(join(outside, "dir")).join(","), "in.md", "nothing was created outside");
		assert.equal(readFileSync(secretFile, "utf8"), "OUTSIDE-SECRET");
		const lsOut = (await results(t, plain, "ls")).at(-1)!.text;
		assert.doesNotMatch(lsOut, /evil\.md|escape/, "escaping links are not even listed");
		assert.doesNotMatch((await results(t, plain, "search")).at(-1)!.text, /OUTSIDE/);
		assert.deepEqual(((await t.json("GET", `/api/memory/files?${q("personal")}`, { token: alice.token })).files as any[]).map((f) => f.path), ["MEMORY.md"]);
	} finally {
		rmSync(outside, { recursive: true, force: true });
		await t.dispose();
	}
});

test("§4.2 unification: existing non-Markdown files in the old memories directory stay and remain visible; /work has no memories store any more", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("mem-old@example.com");
		const dir = memDir(t, a.me);
		mkdirSync(join(dir, "notes"), { recursive: true });
		writeFileSync(join(dir, "data.csv"), "a,b\n1,2\n");
		writeFileSync(join(dir, "notes", "idea.txt"), "plain idea");
		const files = (await t.json("GET", `/api/memory/files?${q("personal")}`, { token: a.token })).files as any[];
		assert.deepEqual(files.map((f) => [f.path, f.markdown]).sort(), [["data.csv", false], ["notes/idea.txt", false]]);
		const c = await newChat(t, a.token);
		await say(t, a.token, c, [call("ls", { path: "/memory" }), call("read", { path: "/memory/data.csv" }), call("write", { path: "/memory/data.csv", content: "x" }), call("ls", { path: "/work" })].join(" "));
		const ls = (await results(t, c, "ls"))[0]!.text;
		assert.match(ls, /\[文件\] data\.csv .*\(read,remove\)/, "caps are truthful: not writable through the memory tools");
		assert.match(ls, /\[目录\] notes\//);
		assert.match((await results(t, c, "read"))[0]!.text, /1,2/);
		assert.ok((await results(t, c, "write"))[0]!.isError);
		assert.equal(readFileSync(join(dir, "data.csv"), "utf8"), "a,b\n1,2\n");
		assert.doesNotMatch((await results(t, c, "ls"))[1]!.text, /memories/);
	} finally {
		await t.dispose();
	}
});

test("§11.1 migration: DB memories → Markdown per scope/owner with backup + report; duplicates merged, conflicts kept side by side, non-Markdown files listed; one-time, never re-imported", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "wr-mig-"));
	let t = await startTestApp({ dataDir });
	try {
		const alice = await t.user("mig-alice@example.com");
		const bob = await joinOrg(t, alice.me.orgId, "mig-bob@example.com");
		const { project } = await t.json("POST", "/api/projects", { token: alice.token, json: { kind: "space", name: "Apollo" } });
		const ins = (id: string, scope: string, owner: string | null, proj: string | null, kind: string, content: string, status = "active", at = "2026-01-01T00:00:00Z") =>
			t.app.ctx.db.run(
				"INSERT INTO mem_items (id, org_id, scope, owner_user_id, project_id, kind, content, source, status, version, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'user', ?, 1, ?, ?, ?, ?)",
				id, alice.me.orgId, scope, owner, proj, kind, content, status, alice.me.userId, at, alice.me.userId, at,
			);
		ins("m1", "private", alice.me.userId, null, "preference", "回答使用简体中文", "active", "2026-01-01T00:00:01Z");
		ins("m2", "private", alice.me.userId, null, "preference", "回答使用简体中文 ", "active", "2026-01-01T00:00:02Z"); // exact duplicate (whitespace)
		ins("m3", "private", alice.me.userId, null, "fact", "汇报对象：张经理", "active", "2026-01-01T00:00:03Z");
		ins("m4", "private", alice.me.userId, null, "constraint", "汇报对象：李总监", "active", "2026-01-01T00:00:04Z"); // conflicts with m3 (same key, other value)
		ins("m5", "private", alice.me.userId, null, "background", "我是财务分析师", "active", "2026-01-01T00:00:05Z");
		ins("m6", "private", alice.me.userId, null, "fact", "DELETED-MEMORY 已删除", "deleted");
		ins("m7", "private", alice.me.userId, null, "fact", "SUPERSEDED-MEMORY 旧版本", "superseded");
		ins("m8", "private", bob.me.userId, null, "preference", "BOB-ONLY 偏好表格", "active");
		ins("m9", "project", null, project.id, "fact", "项目客户是蓝鲸科技");
		ins("m10", "org", null, null, "constraint", "对外文件须法务审核");
		t.app.ctx.db.run("INSERT INTO mem_revisions (memory_id, version, change, content, by_user_id, at) VALUES ('m1', 1, 'create', '回答使用简体中文', ?, '2026-01-01T00:00:01Z')", alice.me.userId);
		// the old per-user memories folder holds a non-Markdown file: it stays and is reported
		const adir = memDir(t, alice.me);
		mkdirSync(adir, { recursive: true });
		writeFileSync(join(adir, "legacy.csv"), "k,v\n");
		// make the migration run again as if this were the first start of the round-14 build
		t.app.ctx.db.run("DELETE FROM kb_meta WHERE key = ?", MIGRATION_MARKER);
		const k = t.app.ctx.services.get("knowledgeAdmin") as any;
		const r = migrateMemoryToMarkdown(t.app.ctx, k.memory);
		assert.equal(r.ran, true);

		// backup (all rows incl. revisions) and report
		const bdir = join(dataDir, "backups", "r14");
		const backupName = readdirSync(bdir).filter((f) => /^memory-.*\.json$/.test(f) && f !== "memory-report.json").sort().at(-1)!;
		const backup = JSON.parse(readFileSync(join(bdir, backupName), "utf8"));
		assert.equal(backup.memItems.length, 10);
		assert.equal(backup.memRevisions.length, 1);
		const report = JSON.parse(readFileSync(join(bdir, "memory-report.json"), "utf8"));
		assert.deepEqual(report.importedByScope, { private: 5, project: 1, org: 1 }, "alice: m1(+m2 merged) m3 m4 m5 = 4, bob: 1");
		assert.equal(report.duplicatesMerged, 1);
		assert.equal(report.conflictsKept, 1);
		assert.equal(report.conflicts?.length ?? report.details.flatMap((d: any) => d.conflicts).length, 1);
		assert.deepEqual(report.details.flatMap((d: any) => d.duplicates).map((d: any) => d.mergedIds), [["m1", "m2"]]);
		assert.deepEqual(report.source, { ...report.source, total: 10, active: 8, superseded: 1, deleted: 1 });
		assert.deepEqual(report.nonMarkdownFiles.map((f: any) => f.path), ["legacy.csv"]);
		assert.equal(report.backup.startsWith("backups/r14/memory-"), true);

		// Markdown content per scope/owner
		const pref = readFileSync(join(adir, "preferences.md"), "utf8");
		assert.equal(pref, "# 偏好\n\n- 回答使用简体中文\n");
		const facts = readFileSync(join(adir, "facts.md"), "utf8");
		assert.match(facts, /汇报对象：张经理（待确认：与另一条同名记忆内容不一致）/);
		assert.match(facts, /汇报对象：李总监（待确认：与另一条同名记忆内容不一致）/);
		assert.doesNotMatch(facts, /DELETED-MEMORY|SUPERSEDED-MEMORY/);
		assert.match(readFileSync(join(adir, "profile.md"), "utf8"), /我是财务分析师/);
		const index = readFileSync(join(adir, "MEMORY.md"), "utf8");
		for (const f of ["preferences.md", "facts.md", "profile.md"]) assert.match(index, new RegExp(`\\]\\(${f.replace(".", "\\.")}\\)`));
		assert.ok(existsSync(join(adir, "legacy.csv")), "non-Markdown file untouched");
		assert.doesNotMatch(readFileSync(join(memDir(t, bob.me), "preferences.md"), "utf8"), /回答使用简体中文|张经理/, "scopes/owners are not mixed");
		assert.match(readFileSync(join(memDir(t, bob.me), "preferences.md"), "utf8"), /BOB-ONLY/);
		assert.match(readFileSync(join(dataDir, "orgs", alice.me.orgId, "memory", "project", project.id, "facts.md"), "utf8"), /蓝鲸科技/);
		assert.match(readFileSync(join(dataDir, "orgs", alice.me.orgId, "memory", "org", "facts.md"), "utf8"), /法务审核/);
		// the DB rows stay (not deleted) …
		assert.equal(t.app.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM mem_items")!.n, 10);
		// … and the front-end lists the migrated files (incl. the old non-Markdown one)
		const listed = (await t.json("GET", `/api/memory/files?${q("personal")}`, { token: alice.token })).files.map((f: any) => f.path);
		assert.deepEqual(listed, ["MEMORY.md", "facts.md", "legacy.csv", "preferences.md", "profile.md"]);

		// one-time: a user deletes a migrated file, rows are added to the DB later, the app restarts → nothing is imported again
		assert.equal((await t.req("DELETE", `/api/memory/file?${q("personal", "profile.md")}`, { token: alice.token })).status, 200);
		ins("m11", "private", alice.me.userId, null, "background", "LATE-DB-ROW", "active");
		assert.equal(migrateMemoryToMarkdown(t.app.ctx, k.memory).ran, false);
		await t.stop();
		t = await startTestApp({ dataDir });
		assert.equal(existsSync(join(adir, "profile.md")), false, "a deleted migrated file is not re-created");
		assert.doesNotMatch(readFileSync(join(adir, "facts.md"), "utf8"), /LATE-DB-ROW/);
		assert.equal(readdirSync(bdir).filter((f) => /^memory-.*\.json$/.test(f) && f !== "memory-report.json").length >= 1, true);
	} finally {
		await t.dispose();
		rmSync(dataDir, { recursive: true, force: true });
	}
});
