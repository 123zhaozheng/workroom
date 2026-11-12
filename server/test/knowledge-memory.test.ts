// Memory routes (round 14): Markdown files per scope (personal / project / org), If-Match conflicts, ACL per scope, topics + index lines,
// the retired database routes (410). Agent-side behaviour (prompt injection, tools, migration) is in r14-memory.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { joinOrg } from "../src/knowledge/testing.ts";

const q = (scope: string, path?: string) => `scope=${encodeURIComponent(scope)}${path === undefined ? "" : `&path=${encodeURIComponent(path)}`}`;
const getFile = (t: TestApp, token: string, scope: string, path: string) => t.req("GET", `/api/memory/file?${q(scope, path)}`, { token });
const putFile = (t: TestApp, token: string, scope: string, path: string, content: string, ifMatch?: string) =>
	t.req("PUT", `/api/memory/file?${q(scope, path)}`, { token, json: { content }, headers: ifMatch === undefined ? {} : { "if-match": ifMatch } });

test("memory files: scopes, per-scope permissions, personal isolation, path safety", async () => {
	const t = await startTestApp();
	try {
		const alice = await t.user("alice@example.com", { name: "Alice" });
		const bob = await joinOrg(t, alice.me.orgId, "bob@example.com");
		const { project } = await t.json("POST", "/api/projects", { token: alice.token, json: { kind: "space", name: "Apollo" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: alice.token, json: { email: "bob@example.com", role: "viewer" } });
		const ps = `project:${project.id}`;

		const aliceScopes = (await t.json("GET", "/api/memory/scopes", { token: alice.token })).scopes;
		assert.deepEqual(aliceScopes.map((s: any) => [s.id, s.writable]), [["personal", true], [ps, true], ["org", true]]);
		const bobScopes = (await t.json("GET", "/api/memory/scopes", { token: bob.token })).scopes;
		assert.deepEqual(bobScopes.map((s: any) => [s.id, s.writable]), [["personal", true], [ps, false], ["org", false]], "viewer reads project memory, cannot write; members cannot write org memory");

		assert.equal((await putFile(t, alice.token, "personal", "MEMORY.md", "# 长期记忆\nALICE-PRIVATE")).status, 200);
		assert.equal((await putFile(t, alice.token, ps, "MEMORY.md", "# 项目\nAPOLLO")).status, 200);
		assert.equal((await putFile(t, alice.token, "org", "MEMORY.md", "# 企业\nORG")).status, 200);
		assert.equal((await putFile(t, bob.token, ps, "x.md", "hack")).status, 403);
		assert.equal((await putFile(t, bob.token, "org", "x.md", "hack")).status, 403);
		assert.equal((await t.req("DELETE", `/api/memory/file?${q(ps, "MEMORY.md")}`, { token: bob.token })).status, 403);
		const bobView = (await (await getFile(t, bob.token, ps, "MEMORY.md")).json()) as any;
		assert.match(bobView.content, /APOLLO/);
		assert.equal(bobView.writable, false);

		// "personal" always means the caller's OWN directory: bob never reaches alice's
		assert.equal((await getFile(t, bob.token, "personal", "MEMORY.md")).status, 404);
		assert.deepEqual((await t.json("GET", `/api/memory/files?${q("personal")}`, { token: bob.token })).files, []);
		assert.equal((await t.json("GET", `/api/memory/files?${q("personal")}`, { token: alice.token })).files.length, 1);

		// scopes of other projects cannot be addressed
		const { project: other } = await t.json("POST", "/api/projects", { token: alice.token, json: { kind: "space", name: "Zeus" } });
		assert.equal((await getFile(t, bob.token, `project:${other.id}`, "MEMORY.md")).status, 403);
		assert.equal((await t.req("GET", `/api/memory/files?${q("galaxy")}`, { token: bob.token })).status, 400);

		// path safety: traversal, absolute, non-Markdown writes, hidden names
		for (const bad of ["../x.md", "a/../../x.md", "/etc/passwd", "a\\b.md", ".hidden.md", "notes.txt"]) {
			const r = await putFile(t, alice.token, "personal", bad, "x");
			assert.ok(r.status === 400 || r.status === 404, `${bad}: ${r.status}`);
		}
		assert.equal((await getFile(t, alice.token, "personal", "../../x")).status, 400);

		// bob removed from the project → the project scope is gone for him immediately
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: alice.token, json: { email: "bob@example.com", role: null } });
		assert.equal((await getFile(t, bob.token, ps, "MEMORY.md")).status, 403);
		assert.deepEqual((await t.json("GET", "/api/memory/scopes", { token: bob.token })).scopes.map((s: any) => s.id), ["personal", "org"]);
	} finally {
		await t.dispose();
	}
});

test("memory files: If-Match conflicts never overwrite, topics add an index line, deleting a topic removes it, old DB routes are gone (410)", async () => {
	const t = await startTestApp();
	try {
		const alice = await t.user("alice@example.com", { name: "Alice" });
		const w1 = await putFile(t, alice.token, "personal", "preferences.md", "# 偏好\n- 简体中文\n");
		const etag1 = ((await w1.json()) as any).file.etag as string;
		assert.equal(w1.headers.get("etag"), `"${etag1}"`);
		// overwrite without If-Match is refused; with a stale etag it is a 409 and nothing changes
		assert.equal((await putFile(t, alice.token, "personal", "preferences.md", "blind")).status, 428);
		const w2 = await putFile(t, alice.token, "personal", "preferences.md", "# 偏好\n- 简体中文\n- 结论先行\n", etag1);
		assert.equal(w2.status, 200);
		const stale = await putFile(t, alice.token, "personal", "preferences.md", "stale overwrite", etag1);
		assert.equal(stale.status, 409);
		const err = ((await stale.json()) as any).error;
		assert.equal(err.code, "memory_conflict");
		assert.match(err.message, /已被修改.*没有保存.*重新读取/);
		assert.match(((await (await getFile(t, alice.token, "personal", "preferences.md")).json()) as any).content, /结论先行/);

		// topics: file + link line in MEMORY.md (created on demand); delete removes the file AND the line, nothing else
		const topic = (await t.json("POST", "/api/memory/topics", { token: alice.token, json: { scope: "personal", title: "Apollo 项目" } })).file;
		assert.equal(topic.path, "projects/Apollo-项目.md");
		const idx1 = ((await (await getFile(t, alice.token, "personal", "MEMORY.md")).json()) as any).content as string;
		assert.match(idx1, /- \[Apollo 项目\]\(projects\/Apollo-项目\.md\)/);
		await t.json("POST", "/api/memory/topics", { token: alice.token, json: { scope: "personal", title: "Apollo 项目" }, expect: 409 });
		const idxEtag = ((await (await getFile(t, alice.token, "personal", "MEMORY.md")).json()) as any).file.etag as string;
		await putFile(t, alice.token, "personal", "MEMORY.md", `${idx1}- [偏好](preferences.md)\n- 保留这一行\n`, idxEtag);
		const del = await t.json("DELETE", `/api/memory/file?${q("personal", topic.path)}`, { token: alice.token });
		assert.equal(del.indexUpdated, true);
		const idx2 = ((await (await getFile(t, alice.token, "personal", "MEMORY.md")).json()) as any).content as string;
		assert.doesNotMatch(idx2, /Apollo/);
		assert.match(idx2, /\[偏好\]\(preferences\.md\)/);
		assert.match(idx2, /保留这一行/);
		assert.equal((await getFile(t, alice.token, "personal", topic.path)).status, 404);

		// the database routes no longer write a competing copy
		for (const [m, p] of [["POST", "/api/memory"], ["PATCH", "/api/memory/mem_1"], ["DELETE", "/api/memory/mem_1"], ["POST", "/api/memory/mem_1/correct"]] as const) {
			const r = await t.req(m, p, { token: alice.token, json: { content: "x", scope: "private" } });
			assert.equal(r.status, 410, `${m} ${p}`);
			assert.match(((await r.json()) as any).error.message, /Markdown/);
		}
	} finally {
		await t.dispose();
	}
});
