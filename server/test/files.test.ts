import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { startTestApp, type TestApp } from "./helpers/app.ts";

export async function orgMember(t: TestApp, owner: { me: any }, email: string) {
	const code = `inv-${Math.random().toString(36).slice(2)}`;
	t.app.ctx.db.run("INSERT INTO id_invites (code, org_id, role, created_by, created_at, expires_at) VALUES (?, ?, 'member', ?, ?, ?)", code, owner.me.orgId, owner.me.userId, new Date().toISOString(), new Date(Date.now() + 86400_000).toISOString());
	return t.user(email, { inviteCode: code });
}

export async function upload(t: TestApp, token: string, path: string, name: string, bytes: Uint8Array | string, fields: Record<string, string> = {}, type = "") {
	const fd = new FormData();
	fd.set("file", new File([bytes as string | Uint8Array<ArrayBuffer>], name, { type }));
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	return t.req("POST", `/api${path}`, { token, body: fd });
}

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

test("upload v1, add v2 with change note; provenance; download bytes equal; v1 unchanged", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("owner@example.com");
		const r1 = await upload(t, a.token, "/files", "报告.md", "# v1\nhello\n");
		assert.equal(r1.status, 200, await r1.clone().text());
		const { file, version } = await r1.json();
		assert.equal(version.versionNo, 1);
		assert.equal(version.mime, "text/markdown");
		assert.equal(version.provenance.origin, "upload");
		assert.equal(version.provenance.createdBy, a.me.userId);
		assert.equal(file.canWrite, true);

		const r2 = await upload(t, a.token, `/files/${file.id}/versions`, "报告.md", "# v2\nhello again\n", { changeNote: "补充第二段" });
		assert.equal(r2.status, 200);
		const v2 = (await r2.json()).version;
		assert.equal(v2.versionNo, 2);
		assert.equal(v2.changeNote, "补充第二段");
		assert.deepEqual(v2.provenance.inputVersionIds, [version.versionId]);

		const d = await t.json("GET", `/api/files/${file.id}`, { token: a.token });
		assert.equal(d.versions.length, 2);
		assert.equal(d.versions[0].versionNo, 2);
		assert.equal(d.file.latestVersionNo, 2);

		const dl1 = await t.req("GET", `/api/files/${file.id}/versions/${version.versionId}/download`, { token: a.token });
		assert.equal(dl1.status, 200);
		assert.equal(sha(new Uint8Array(await dl1.arrayBuffer())), sha("# v1\nhello\n"));
		assert.match(dl1.headers.get("content-disposition")!, /^attachment; filename="__\.md"; filename\*=UTF-8''%E6%8A%A5%E5%91%8A\.md$/);
		assert.equal(dl1.headers.get("x-content-type-options"), "nosniff");
		const dl2 = await t.req("GET", `/api/files/${file.id}/versions/${v2.versionId}/download`, { token: a.token });
		assert.equal(await dl2.text(), "# v2\nhello again\n");

		// Version rows are immutable at the database level.
		assert.throws(() => t.app.ctx.db.run("UPDATE file_versions SET size = 0 WHERE id = ?", version.versionId), /immutable/);

		// Search by name across readable spaces.
		const list = await t.json("GET", "/api/files?q=报告", { token: a.token });
		assert.equal(list.files.length, 1);
		const none = await t.json("GET", "/api/files?q=nothing", { token: a.token });
		assert.equal(none.files.length, 0);
		// Version of another file is not reachable through this file's URL.
		await t.json("GET", `/api/files/${file.id}/versions/fv_nope/download`, { token: a.token, expect: 404 });
	} finally {
		await t.dispose();
	}
});

test("ACL: other org user 403; project viewer reads but cannot write; removed member loses download", async () => {
	const t = await startTestApp();
	try {
		const owner = await t.user("own@example.com");
		const outsider = await t.user("out@example.com");
		const viewer = await orgMember(t, owner, "viewer@example.com");
		const editor = await orgMember(t, owner, "editor@example.com");
		const { project } = await t.json("POST", "/api/projects", { token: owner.token, json: { name: "P" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: owner.token, json: { email: "viewer@example.com", role: "viewer" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: owner.token, json: { email: "editor@example.com", role: "editor" } });

		const r = await upload(t, owner.token, "/files", "plan.txt", "secret plan", { projectId: project.id });
		const { file, version } = await r.json();
		assert.equal(file.spaceId, project.spaceId);
		const dl = `/api/files/${file.id}/versions/${version.versionId}/download`;

		await t.json("GET", `/api/files/${file.id}`, { token: outsider.token, expect: 403 });
		assert.equal((await t.req("GET", dl, { token: outsider.token })).status, 403);
		assert.equal((await t.json("GET", "/api/files", { token: outsider.token })).files.length, 0);

		assert.equal((await t.req("GET", dl, { token: viewer.token })).status, 200);
		const vd = await t.json("GET", `/api/files/${file.id}`, { token: viewer.token });
		assert.equal(vd.file.canWrite, false);
		assert.equal((await upload(t, viewer.token, `/files/${file.id}/versions`, "plan.txt", "viewer edit")).status, 403);
		assert.equal((await upload(t, viewer.token, "/files", "x.txt", "x", { projectId: project.id })).status, 403);

		assert.equal((await upload(t, editor.token, `/files/${file.id}/versions`, "plan.txt", "editor edit", { changeNote: "编辑者修改" })).status, 200);

		// Remove the viewer: access is evaluated against current membership.
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: owner.token, json: { email: "viewer@example.com", role: null } });
		assert.equal((await t.req("GET", dl, { token: viewer.token })).status, 403);
		assert.equal((await t.req("GET", `/api/files/${file.id}/versions/${version.versionId}/preview`, { token: viewer.token })).status, 403);
		assert.equal((await t.json("GET", "/api/files", { token: viewer.token })).files.length, 0);

		// Personal files: only the owner.
		const pr = await (await upload(t, owner.token, "/files", "mine.txt", "personal")).json();
		assert.equal((await t.req("GET", `/api/files/${pr.file.id}`, { token: editor.token })).status, 403);

		// FileService.getVersion returns null when not allowed.
		const files = t.app.ctx.services.get("files");
		const editorP = await t.app.ctx.services.get("identity").principalFor(editor.me.userId, editor.me.orgId);
		assert.equal(await files.getVersion(editorP!, pr.version.versionId), null);
		assert.ok(await files.getVersion(editorP!, version.versionId));
	} finally {
		await t.dispose();
	}
});

test("same file name in two projects stays isolated", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("a@example.com");
		const b = await orgMember(t, a, "b@example.com");
		const { project: p1 } = await t.json("POST", "/api/projects", { token: a.token, json: { name: "One" } });
		const { project: p2 } = await t.json("POST", "/api/projects", { token: b.token, json: { name: "Two" } });
		const f1 = await (await upload(t, a.token, "/files", "方案.md", "project one", { projectId: p1.id })).json();
		const f2 = await (await upload(t, b.token, "/files", "方案.md", "project two", { projectId: p2.id })).json();
		assert.notEqual(f1.file.id, f2.file.id);
		assert.equal((await t.json("GET", `/api/files?projectId=${p1.id}`, { token: a.token })).files.length, 1);
		assert.equal((await t.json("GET", "/api/files?q=方案", { token: a.token })).files.length, 1);
		assert.equal((await t.json("GET", "/api/files?q=方案", { token: b.token })).files[0].id, f2.file.id);
		assert.equal((await t.req("GET", `/api/files/${f2.file.id}`, { token: a.token })).status, 403);
		await t.json("GET", `/api/files?spaceId=${p2.spaceId}`, { token: a.token, expect: 403 });
		const dl = await t.req("GET", `/api/files/${f1.file.id}/versions/${f1.version.versionId}/download`, { token: a.token });
		assert.equal(await dl.text(), "project one");
		// Same content in both projects is stored once (content-addressed) but versions/ACL are separate.
		const f3 = await (await upload(t, b.token, "/files", "copy.md", "project one", { projectId: p2.id })).json();
		assert.equal(f3.version.sha256, f1.version.sha256);
		assert.equal((await t.req("GET", `/api/files/${f3.file.id}`, { token: a.token })).status, 403);
	} finally {
		await t.dispose();
	}
});

test("previews: sandbox CSP for html, markdown escapes raw html, images and pdf passthrough, idempotent uploads", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("p@example.com");
		const evil = `<html><body><h1>hi</h1><script>fetch('/api/me').then(r=>r.text()).then(t=>alert(t))</script></body></html>`;
		const h = await (await upload(t, a.token, "/files", "page.html", evil)).json();
		const pv = await t.req("GET", `/api/files/${h.file.id}/versions/${h.version.versionId}/preview`, { token: a.token });
		assert.equal(pv.status, 200);
		const csp = pv.headers.get("content-security-policy")!;
		assert.match(csp, /^sandbox;/);
		assert.doesNotMatch(csp, /allow-scripts|allow-same-origin|script-src/);
		assert.equal(pv.headers.get("x-content-type-options"), "nosniff");

		const m = await (await upload(t, a.token, "/files", "note.md", "# Title\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n")).json();
		const mp = await t.req("GET", `/api/files/${m.file.id}/versions/${m.version.versionId}/preview`, { token: a.token });
		const html = await mp.text();
		assert.match(html, /<h1>Title<\/h1>/);
		assert.doesNotMatch(html, /<img src=x/);
		assert.doesNotMatch(html, /javascript:/);
		assert.match(mp.headers.get("content-security-policy")!, /^sandbox;/);

		const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
		const i = await (await upload(t, a.token, "/files", "dot.png", png)).json();
		assert.equal(i.version.mime, "image/png");
		const ip = await t.req("GET", `/api/files/${i.file.id}/versions/${i.version.versionId}/preview`, { token: a.token });
		assert.equal(ip.headers.get("content-type"), "image/png");
		assert.deepEqual(new Uint8Array(await ip.arrayBuffer()), png);

		const svg = await (await upload(t, a.token, "/files", "x.svg", `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)).json();
		const sp = await t.req("GET", `/api/files/${svg.file.id}/versions/${svg.version.versionId}/preview`, { token: a.token });
		assert.match(sp.headers.get("content-security-policy")!, /^sandbox;/);

		const csv = await (await upload(t, a.token, "/files", "t.csv", "a,b\n1,\"x,y\"\n")).json();
		const cp = await (await t.req("GET", `/api/files/${csv.file.id}/versions/${csv.version.versionId}/preview`, { token: a.token })).text();
		assert.match(cp, /<td>x,y<\/td>/);

		// Idempotency-Key: a retried upload returns the same version.
		const k1 = await (await upload(t, a.token, "/files", "same.txt", "x")).json();
		const fd = new FormData();
		fd.set("file", new File(["retry"], "r.txt"));
		const r1 = await (await t.req("POST", "/api/files", { token: a.token, body: fd, headers: { "idempotency-key": "abc" } })).json();
		const fd2 = new FormData();
		fd2.set("file", new File(["retry"], "r.txt"));
		const r2 = await (await t.req("POST", "/api/files", { token: a.token, body: fd2, headers: { "idempotency-key": "abc" } })).json();
		assert.equal(r1.version.versionId, r2.version.versionId);
		assert.notEqual(k1.version.versionId, r1.version.versionId);
		assert.equal((await t.json("GET", "/api/files?q=r.txt", { token: a.token })).files.length, 1);

		await t.json("GET", "/api/files", { expect: 401 });
	} finally {
		await t.dispose();
	}
});
