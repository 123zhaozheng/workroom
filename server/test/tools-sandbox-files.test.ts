// Workspace file API (tree, preview, download, upload, mkdir, delete, move, publish) with the conversation's ACL, path-traversal and
// symlink-escape refusal, quota/size limits, the driver admin API, and the agent-side tools (sandbox_import, base64 sandbox_write_file).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { orgMember } from "./fixtures/util.ts";
import { answer, call, fixedActor, toolHarness } from "./fixtures/tool-harness.ts";
import { createSandboxExtension } from "../src/tools/sandbox-tools.ts";
import { Sandbox } from "../src/tools/sandbox.ts";
import { effectiveMime } from "../src/files/mime.ts";
import type { Files } from "../src/files/service.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

async function world(t: TestApp) {
	const a = await t.user("wsowner@example.com");
	const viewer = await orgMember(t, a, "wsview@example.com");
	const outsider = await t.user("wsout@example.com");
	const { project } = await t.json("POST", "/api/projects", { token: a.token, json: { kind: "space", name: "Workspace" } });
	await t.json("PUT", `/api/projects/${project.id}/members`, { token: a.token, json: { email: "wsview@example.com", role: "viewer" } });
	const sp = project.spaceId as string;
	const url = (path: string, q = "") => `/api/sandbox/${sp}/${path}${path.includes("?") ? "&" : "?"}conversationId=1${q}`;
	const put = (token: string, p: string, body: BodyInit, extra = "") => t.req("PUT", url(`file?path=${encodeURIComponent(p)}${extra}`), { token, body });
	return { a, viewer, outsider, project, sp, url, put };
}

test("workspace files: list/preview/download/upload/mkdir/move/delete/publish, viewer read-only, outsider 403, lifecycle and usage shown", async () => {
	const t = await startTestApp();
	try {
		const { a, viewer, outsider, sp, url, put } = await world(t);
		// Upload (writer): creates parent folders, overwrites, reports size.
		const up = await put(a.token, "data/in.csv", "name,qty\n苹果,3\n");
		assert.equal(up.status, 200);
		assert.deepEqual(await up.json(), { path: "data/in.csv", size: new TextEncoder().encode("name,qty\n苹果,3\n").length });
		assert.equal((await put(a.token, "/work/pic.png", PNG)).status, 200, "a /work/ prefix is accepted");
		assert.equal((await put(a.token, "blob.bin", new Uint8Array([0, 1, 2, 255, 0]))).status, 200);
		assert.equal((await put(a.token, "notes/长文本.md", `# 标题\n${"行\n".repeat(200_000)}`)).status, 200);

		const files = await t.json("GET", url("files"), { token: a.token });
		assert.equal(files.canWrite, true);
		assert.deepEqual(files.entries.map((e: any) => e.path).sort(), ["blob.bin", "data", "data/in.csv", "notes", "notes/长文本.md", "pic.png"]);
		assert.ok(files.entries.every((e: any) => e.expiresAt && e.mtime), "every entry shows when it expires");
		assert.equal(files.entries.find((e: any) => e.path === "data").kind, "directory");
		assert.equal(files.usage.retentionHours, 72);
		assert.equal(files.usage.quotaBytes, 512 * 1024 * 1024);
		assert.ok(files.usage.conversationBytes > 400_000 && files.usage.spaceBytes >= files.usage.conversationBytes && files.usage.fileCount === 4);
		assert.equal(files.truncated, false);

		// Preview: text, truncated text, image, binary.
		const txt = (await t.json("GET", url("preview?path=data/in.csv"), { token: a.token })).preview;
		assert.deepEqual([txt.kind, txt.text, txt.language, txt.mime], ["text", "name,qty\n苹果,3\n", "csv", effectiveMime(undefined, "in.csv")]);
		const big = (await t.json("GET", url("preview?path=notes/长文本.md"), { token: a.token })).preview;
		assert.equal(big.kind, "text");
		assert.equal(big.truncated, true);
		assert.ok(big.text.length > 1000 && big.text.length <= 256 * 1024);
		assert.equal((await t.json("GET", url("preview?path=pic.png"), { token: a.token })).preview.kind, "image");
		assert.equal((await t.json("GET", url("preview?path=blob.bin"), { token: a.token })).preview.kind, "binary");
		assert.equal((await t.req("GET", url("preview?path=nope.txt"), { token: a.token })).status, 404);
		assert.equal((await t.req("GET", url("preview?path=data"), { token: a.token })).status, 404, "a directory has no preview");

		// Download: attachment by default; inline only for images and only when asked; always with a sandboxing CSP.
		const dl = await t.req("GET", url("file?path=data/in.csv"), { token: viewer.token });
		assert.equal(dl.status, 200);
		assert.equal(await dl.text(), "name,qty\n苹果,3\n");
		assert.match(dl.headers.get("content-disposition")!, /^attachment/);
		assert.match(dl.headers.get("content-security-policy")!, /sandbox/);
		assert.equal(dl.headers.get("x-content-type-options"), "nosniff");
		const img = await t.req("GET", url("file?path=pic.png&inline=1"), { token: viewer.token });
		assert.match(img.headers.get("content-disposition")!, /^inline/);
		assert.equal(img.headers.get("content-type"), "image/png");
		assert.match((await t.req("GET", url("file?path=data/in.csv&inline=1"), { token: viewer.token })).headers.get("content-disposition")!, /^attachment/);

		// Folder, move, delete.
		assert.deepEqual(await t.json("POST", `/api/sandbox/${sp}/mkdir`, { token: a.token, json: { conversationId: 1, path: "out/charts" } }), { path: "out/charts" });
		assert.deepEqual(await t.json("POST", `/api/sandbox/${sp}/move`, { token: a.token, json: { conversationId: 1, from: "pic.png", to: "out/charts/p.png" } }), { from: "pic.png", to: "out/charts/p.png" });
		await t.json("POST", `/api/sandbox/${sp}/move`, { token: a.token, json: { conversationId: 1, from: "blob.bin", to: "out/charts/p.png" }, expect: 409 });
		assert.equal((await t.req("DELETE", url("file?path=out"), { token: a.token })).status, 200);
		assert.equal(existsSync(join((t.app.ctx.services.get("sandbox") as Sandbox).workdir(t.app.ctx.services.get("identity").space(sp)!, 1), "out")), false, "a directory is deleted recursively");
		assert.equal((await t.req("DELETE", url("file?path=out"), { token: a.token })).status, 404);
		assert.equal((await t.req("DELETE", url("file?path="), { token: a.token })).status, 400, "the workspace root cannot be deleted");

		// Publish to the file library: a new immutable version with provenance; the sandbox copy is unaffected.
		const pub = await t.json("POST", `/api/sandbox/${sp}/publish`, { token: a.token, json: { conversationId: 1, path: "data/in.csv", name: "输入.csv" } });
		assert.equal(pub.version.name, "输入.csv");
		const lib = await t.req("GET", `/api/files/${pub.version.fileId}/versions/${pub.version.versionId}/download`, { token: a.token });
		assert.equal(await lib.text(), "name,qty\n苹果,3\n");

		// ACL: the viewer reads but cannot change anything; a user outside the space gets 403 everywhere.
		const vfiles = await t.json("GET", url("files"), { token: viewer.token });
		assert.equal(vfiles.canWrite, false);
		assert.deepEqual(vfiles.entries.map((e: any) => e.path).sort(), ["blob.bin", "data", "data/in.csv", "notes", "notes/长文本.md"], "the viewer sees the same workspace");
		assert.equal((await put(viewer.token, "v.txt", "x")).status, 403);
		assert.equal((await t.req("POST", `/api/sandbox/${sp}/mkdir`, { token: viewer.token, json: { conversationId: 1, path: "v" } })).status, 403);
		assert.equal((await t.req("DELETE", url("file?path=blob.bin"), { token: viewer.token })).status, 403);
		assert.equal((await t.req("POST", `/api/sandbox/${sp}/move`, { token: viewer.token, json: { conversationId: 1, from: "blob.bin", to: "z" } })).status, 403);
		assert.equal((await t.req("POST", `/api/sandbox/${sp}/publish`, { token: viewer.token, json: { conversationId: 1, path: "blob.bin" } })).status, 403);
		assert.ok(existsSync(join((t.app.ctx.services.get("sandbox") as Sandbox).workdir(t.app.ctx.services.get("identity").space(sp)!, 1), "blob.bin")), "the viewer's attempts changed nothing");
		for (const [m, p, body] of [["GET", url("files")], ["GET", url("preview?path=blob.bin")], ["GET", url("file?path=blob.bin")], ["GET", `/api/sandbox/${sp}`], ["GET", `/api/sandbox/${sp}/runs`], ["PUT", url("file?path=o.txt"), "x"], ["DELETE", url("file?path=blob.bin")], ["POST", `/api/sandbox/${sp}/mkdir`, JSON.stringify({ path: "o" })]] as [string, string, string?][]) {
			const r = await t.req(m, p, { token: outsider.token, body, headers: body?.startsWith("{") ? { "content-type": "application/json" } : undefined });
			assert.equal(r.status, 403, `${m} ${p}`);
		}
		assert.equal((await t.req("GET", url("files"))).status, 401, "anonymous");
	} finally {
		await t.dispose();
	}
});

test("workspace files: path traversal, absolute and Windows-style paths, symlink escapes planted by sandboxed code, size and quota limits", async () => {
	const t = await startTestApp();
	const prevQuota = process.env.WORKROOM_SANDBOX_QUOTA_MB;
	try {
		const { a, sp, url, put } = await world(t);
		const sb = t.app.ctx.services.get("sandbox") as Sandbox;
		const space = t.app.ctx.services.get("identity").space(sp)!;
		const wd = sb.workdir(space, 1);
		const secret = join(t.dataDir, "app.sqlite");
		assert.ok(existsSync(secret));

		for (const p of ["../x.txt", "a/../../x.txt", "..%2F..%2Fapp.sqlite", "..\\..\\app.sqlite", "C:\\Windows\\win.ini", "c:/boot.ini", "ok/../../../etc/passwd", "a/b:stream", "con<x"]) {
			const dec = decodeURIComponent(p);
			assert.equal((await put(a.token, dec, "pwn")).status, 400, `PUT ${p}`);
			assert.equal((await t.req("GET", url(`file?path=${encodeURIComponent(dec)}`), { token: a.token })).status, 400, `GET ${p}`);
			assert.equal((await t.req("GET", url(`preview?path=${encodeURIComponent(dec)}`), { token: a.token })).status, 400, `preview ${p}`);
			assert.equal((await t.req("DELETE", url(`file?path=${encodeURIComponent(dec)}`), { token: a.token })).status, 400, `DELETE ${p}`);
		}
		assert.equal((await t.req("POST", `/api/sandbox/${sp}/mkdir`, { token: a.token, json: { conversationId: 1, path: "../evil" } })).status, 400);
		assert.equal((await t.req("POST", `/api/sandbox/${sp}/move`, { token: a.token, json: { conversationId: 1, from: "x", to: "../../y" } })).status, 400);
		// Absolute paths are interpreted relative to /work (never the host), so "/etc/passwd" is simply "etc/passwd" inside the workspace.
		assert.equal((await t.req("GET", url("file?path=/etc/passwd"), { token: a.token })).status, 404);
		assert.equal((await put(a.token, "/etc/hosts", "mine")).status, 200);
		assert.equal(readFileSync(join(wd, "etc", "hosts"), "utf8"), "mine");
		assert.notEqual(readFileSync("/etc/hosts", "utf8"), "mine");

		// Symlinks created by sandboxed code (here: planted from the host side) pointing outside the workspace.
		symlinkSync(secret, join(wd, "stolen.db"));
		symlinkSync(t.dataDir, join(wd, "escape"));
		symlinkSync("/etc", join(wd, "etc-link"));
		writeFileSync(join(wd, "inside.txt"), "inside");
		symlinkSync(join(wd, "inside.txt"), join(wd, "ok-link"));
		assert.equal((await t.req("GET", url("file?path=stolen.db"), { token: a.token })).status, 400, "file symlink out of the workspace");
		assert.equal((await t.req("GET", url("preview?path=stolen.db"), { token: a.token })).status, 400);
		assert.equal((await t.req("GET", url("file?path=escape/app.sqlite"), { token: a.token })).status, 400, "directory symlink out of the workspace");
		assert.equal((await t.req("GET", url("file?path=etc-link/passwd"), { token: a.token })).status, 400);
		assert.equal((await put(a.token, "escape/planted.txt", "pwn")).status, 400, "writes through a directory symlink are refused");
		assert.equal(existsSync(join(t.dataDir, "planted.txt")), false);
		assert.equal((await put(a.token, "etc-link/planted.txt", "pwn")).status, 400);
		assert.equal((await t.req("POST", `/api/sandbox/${sp}/mkdir`, { token: a.token, json: { conversationId: 1, path: "escape/newdir" } })).status, 400);
		assert.equal(existsSync(join(t.dataDir, "newdir")), false);
		assert.equal((await t.req("POST", `/api/sandbox/${sp}/publish`, { token: a.token, json: { conversationId: 1, path: "stolen.db" } })).status, 400, "publish cannot exfiltrate through a symlink either");
		assert.equal(await (await t.req("GET", url("file?path=ok-link"), { token: a.token })).text(), "inside", "a symlink that stays inside the workspace is fine");
		const listing = await t.json("GET", url("files"), { token: a.token });
		assert.equal(listing.entries.find((e: any) => e.path === "stolen.db").symlink, true);
		// Deleting a symlink removes the link, never the target.
		assert.equal((await t.req("DELETE", url("file?path=escape"), { token: a.token })).status, 200);
		assert.equal((await t.req("DELETE", url("file?path=stolen.db"), { token: a.token })).status, 200);
		assert.ok(existsSync(secret) && existsSync(t.dataDir), "targets untouched");

		// Size and quota limits.
		const tooBig = await t.req("PUT", url("file?path=big.bin"), { token: a.token, body: new Uint8Array(65 * 1024 * 1024) });
		assert.equal(tooBig.status, 413);
		assert.equal(existsSync(join(wd, "big.bin")), false);
		process.env.WORKROOM_SANDBOX_QUOTA_MB = "0.03"; // ≈ 31 KB per space
		assert.equal((await put(a.token, "q1.bin", new Uint8Array(20_000))).status, 200);
		const over = await put(a.token, "q2.bin", new Uint8Array(20_000));
		assert.equal(over.status, 507);
		assert.match((await over.json()).error.message, /配额不足/);
		assert.equal(existsSync(join(wd, "q2.bin")), false);
		assert.equal((await put(a.token, "q1.bin", new Uint8Array(21_000))).status, 200, "overwriting counts the file once? (still within the quota)");
		const small = await put(a.token, "q3.txt", "tiny");
		assert.equal(small.status, 200);
		const u = (await t.json("GET", url("files"), { token: a.token })).usage;
		assert.equal(Math.round(u.quotaBytes), Math.round(0.03 * 1024 * 1024));
		assert.ok(u.spaceBytes > 20_000);
		// Deleting frees quota.
		assert.equal((await t.req("DELETE", url("file?path=q1.bin"), { token: a.token })).status, 200);
		assert.equal((await put(a.token, "q2.bin", new Uint8Array(20_000))).status, 200);
	} finally {
		if (prevQuota === undefined) delete process.env.WORKROOM_SANDBOX_QUOTA_MB;
		else process.env.WORKROOM_SANDBOX_QUOTA_MB = prevQuota;
		await t.dispose();
	}
});

test("agent tools: sandbox_write_file (utf8/base64) and sandbox_import from the library respect ACL and quota", async () => {
	const t = await startTestApp();
	try {
		const { a, viewer, project, sp } = await world(t);
		const ctx = t.app.ctx;
		const files = ctx.services.get("files") as unknown as Files;
		const principal = (await ctx.services.get("identity").principalFor(a.me.userId, a.me.orgId))!;
		const ref = await files.putVersion(principal, { name: "客户名单.csv", mime: "text/csv", bytes: new TextEncoder().encode("id,name\n1,甲\n"), provenance: { createdBy: a.me.userId, spaceId: sp, origin: "upload" } as any });
		const h = await toolHarness([createSandboxExtension(ctx, { resolveActor: fixedActor(ctx, a.me.userId, a.me.orgId, sp) })], [
			call("sandbox_write_file", { path: "img/p.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64"), encoding: "base64" }, "w1"),
			call("sandbox_import", { fileId: ref.fileId }, "i1"),
			call("sandbox_import", { fileId: ref.fileId, path: "in/data.csv" }, "i2"),
			call("sandbox_import", { fileId: "file_missing" }, "i3"),
			call("sandbox_list", {}, "l1"),
			answer("done"),
		]);
		await h.run("work");
		const r = await h.results();
		assert.equal(r[0]!.isError, false, r[0]!.text);
		assert.match(r[0]!.text, /7 字节/);
		assert.equal(r[1]!.isError, false, r[1]!.text);
		assert.match(r[1]!.text, /\/work\/客户名单\.csv/);
		assert.match(r[2]!.text, /\/work\/in\/data\.csv/);
		assert.equal(r[3]!.isError, true);
		assert.match(r[4]!.text, /客户名单\.csv/);
		const wd = (ctx.services.get("sandbox") as Sandbox).workdir(ctx.services.get("identity").space(sp)!, Number(h.root.id));
		assert.deepEqual([...readFileSync(join(wd, "img", "p.png"))], [0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
		assert.equal(readFileSync(join(wd, "in", "data.csv"), "utf8"), "id,name\n1,甲\n");
		await h.close();
		// A viewer's agent cannot write into the workspace.
		const vh = await toolHarness([createSandboxExtension(ctx, { resolveActor: fixedActor(ctx, viewer.me.userId, viewer.me.orgId, sp) })], [call("sandbox_import", { fileId: ref.fileId }, "v1"), call("sandbox_write_file", { path: "x", content: "y" }, "v2"), answer("no")]);
		await vh.run("try");
		const vr = await vh.results();
		assert.ok(vr.every((x) => x.isError), JSON.stringify(vr.map((x) => x.text)));
		await vh.close();
		void project;
	} finally {
		await t.dispose();
	}
});

test("driver admin API: status for everyone, settings only for admins; disabling the sandbox is visible in info/capabilities and explains how to enable", async () => {
	const t = await startTestApp();
	try {
		const { a, viewer, sp } = await world(t);
		const st = await t.json("GET", "/api/sandbox/driver", { token: a.token });
		assert.equal(st.canManage, true);
		assert.ok(["namespaces", "docker", "none"].includes(st.effective));
		assert.deepEqual(st.drivers.map((d: any) => d.id), ["namespaces", "docker", "none"]);
		for (const d of st.drivers) assert.ok(d.isolates.length && d.doesNotIsolate.length && d.summary, `driver ${d.id} documents what it isolates and what it does not`);
		assert.equal(st.network, "none");
		assert.equal(st.docker.pythonImage.startsWith("python:3.12-slim@sha256:"), true);
		const mem = await t.json("GET", "/api/sandbox/driver", { token: viewer.token });
		assert.equal(mem.canManage, false);
		assert.ok(mem.drivers.every((d: any) => d.details.length === 0), "diagnostic details are admin-only");
		await t.json("PUT", "/api/sandbox/driver", { token: viewer.token, json: { driver: "none" }, expect: 403 });
		await t.json("POST", "/api/sandbox/driver/prepare", { token: viewer.token, json: {}, expect: 403 });

		const off = await t.json("PUT", "/api/sandbox/driver", { token: a.token, json: { driver: "none", network: "allowed" } });
		assert.equal(off.effective, "none");
		assert.equal(off.setting, "none");
		assert.equal(off.network, "allowed");
		assert.equal(off.fromEnvironment, false);
		const info = await t.json("GET", `/api/sandbox/${sp}`, { token: viewer.token });
		assert.equal(info.info.isolation, "unavailable");
		assert.match(info.info.isolationDetail, /已关闭/);
		assert.equal(info.info.driver.id, "none");
		assert.ok(info.info.driver.howToEnable.length > 20);
		const caps = await t.json("GET", "/api/tools/capabilities", { token: a.token });
		assert.equal(caps.sandbox.status, "unavailable");
		assert.equal(caps.sandbox.driver, "none");
		// The file API keeps working without a driver (browse/download/upload do not execute anything).
		assert.equal((await t.req("PUT", `/api/sandbox/${sp}/file?path=a.txt&conversationId=1`, { token: a.token, body: "x" })).status, 200);
		const sb = t.app.ctx.services.get("sandbox") as Sandbox;
		const principal = (await t.app.ctx.services.get("identity").principalFor(a.me.userId, a.me.orgId))!;
		await assert.rejects(sb.run({ principal, space: t.app.ctx.services.get("identity").space(sp)!, conversationId: 1, language: "shell", code: "true" }), (e: any) => e.status === 503 && e.code === "sandbox_unavailable" && /Docker|命名空间/.test(e.message));

		const back = await t.json("PUT", "/api/sandbox/driver", { token: a.token, json: { driver: "auto", network: "none", docker: { cpus: 2, autoPull: false } } });
		assert.equal(back.setting, "auto");
		assert.equal(back.docker.cpus, 2);
		assert.equal(back.docker.autoPull, false);
		await t.json("PUT", "/api/sandbox/driver", { token: a.token, json: { driver: "bogus" }, expect: 400 });
		await t.json("PUT", "/api/sandbox/driver", { token: a.token, json: { maxConcurrent: 0 }, expect: 400 });
		// With Docker pointed at nothing, preparing images says so instead of pretending.
		await t.json("PUT", "/api/sandbox/driver", { token: a.token, json: { docker: { bin: "/nonexistent/docker" } } });
		await t.json("POST", "/api/sandbox/driver/prepare", { token: a.token, json: { mode: "pull" }, expect: 409 });
		const det = await t.json("POST", "/api/sandbox/driver/detect", { token: a.token });
		assert.equal(det.drivers[1].state, "unavailable");
		assert.match(det.drivers[1].summary, /未找到 docker/);
		void mkdirSync;
	} finally {
		await t.dispose();
	}
});

test("RBAC: the 访客 role (no sandbox.use / sandbox.browser) is refused by sandbox tools, code mode, browser tools, job_start and the write routes; driver settings need sandbox.policy.manage", async () => {
	const { CodemodeSandbox } = await import("@earendil-works/pi-codemode");
	const { createCodemodeExtension } = await import("@earendil-works/pi-durable/codemode");
	const { createBrowserExtension } = await import("../src/tools/browser.ts");
	const { createJobsExtension } = await import("../src/tools/jobs.ts");
	const { fakeApi, context } = await import("./fixtures/tool-harness.ts");
	const t = await startTestApp();
	const cm = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024, timeoutMs: 30_000 });
	try {
		const owner = await t.user("rbacowner@example.com");
		const mk = async (email: string, base?: string) => {
			const u = await orgMember(t, owner, email);
			if (base) await t.json("POST", "/api/admin/role-assignments", { token: owner.token, json: { subject: { kind: "user", id: u.me.userId }, roleId: base, scope: { kind: "org" } } });
			return u;
		};
		const guest = await mk("rbacguest@example.com", "builtin:guest");
		const member = await mk("rbacmember@example.com");
		const { project } = await t.json("POST", "/api/projects", { token: owner.token, json: { kind: "space", name: "RBAC" } });
		for (const e of ["rbacguest@example.com", "rbacmember@example.com"]) await t.json("PUT", `/api/projects/${project.id}/members`, { token: owner.token, json: { email: e, role: "editor" } });
		const sp = project.spaceId as string;
		const ctx = t.app.ctx;
		const authz = ctx.services.get("authz");
		const pr = async (u: any) => (await ctx.services.get("identity").principalFor(u.me.userId, u.me.orgId))!;
		assert.equal(await authz.has(await pr(guest), "sandbox.use"), false, "precondition: the guest role lacks sandbox.use");
		assert.equal(await authz.has(await pr(member), "sandbox.use"), true);

		// Routes: the guest is a project editor (space ACL would allow writes) but the role forbids the sandbox.
		const url = (path: string) => `/api/sandbox/${sp}/${path}`;
		const gput = await t.req("PUT", `${url("file?path=a.txt")}&conversationId=1`, { token: guest.token, body: "x" });
		assert.equal(gput.status, 403);
		assert.match((await gput.json()).error.message, /sandbox\.use/);
		assert.equal((await t.req("POST", url("mkdir"), { token: guest.token, json: { conversationId: 1, path: "d" } })).status, 403);
		assert.equal((await t.req("PUT", `${url("file?path=a.txt")}&conversationId=1`, { token: member.token, body: "x" })).status, 200, "a plain member (sandbox.use) can");
		assert.equal((await t.req("GET", `${url("files")}?conversationId=1`, { token: guest.token })).status, 200, "reading the workspace of a conversation the guest may read stays allowed");
		// Driver settings: sandbox.policy.manage only (members and guests cannot, owner can).
		for (const u of [guest, member]) await t.json("PUT", "/api/sandbox/driver", { token: u.token, json: { network: "allowed" }, expect: 403 });
		assert.equal((await t.json("GET", "/api/sandbox/driver", { token: guest.token })).canManage, false);
		await t.json("PUT", "/api/sandbox/driver", { token: owner.token, json: { network: "allowed" } });

		// Tools through the real tool machinery: every sandbox tool and code mode are blocked for the guest, allowed for the member.
		const run = async (u: any, calls: ReturnType<typeof call>[]) => {
			const h = await toolHarness([createSandboxExtension(ctx, { resolveActor: fixedActor(ctx, u.me.userId, u.me.orgId, sp) }), createCodemodeExtension({ sandbox: cm, models: false })], [...calls, answer("done")]);
			await h.run("go");
			const r = await h.results();
			await h.close();
			return r;
		};
		const calls = () => [call("sandbox_exec", { language: "shell", code: "echo hi" }, "g1"), call("sandbox_write_file", { path: "g.txt", content: "x" }, "g2"), call("sandbox_list", {}, "g3"), call("codemode", { code: "console.log(1)" }, "g4")];
		const gr = await run(guest, calls());
		assert.equal(gr.length, 4);
		assert.ok(gr.every((x) => x.isError), JSON.stringify(gr.map((x) => [x.name, x.isError, x.text.slice(0, 60)])));
		assert.ok(gr.every((x) => /sandbox\.use|没有权限/.test(x.text)), JSON.stringify(gr.map((x) => x.text)));
		assert.ok(gr.find((x) => x.name === "codemode"), "code mode itself is refused, not only its nested calls");
		const mr = await run(member, [call("sandbox_write_file", { path: "m.txt", content: "x" }, "m1"), call("sandbox_list", {}, "m2"), call("codemode", { code: "console.log('qjs ok')" }, "m3")]);
		assert.ok(mr.every((x) => !x.isError), JSON.stringify(mr.map((x) => x.text)));

		// Browser tools and background jobs: direct execution refuses for the guest before doing anything.
		const bt = createBrowserExtension(ctx, { resolveActor: fixedActor(ctx, guest.me.userId, guest.me.orgId, sp) }).tools![0]!;
		await assert.rejects(bt.execute({ url: "http://example.com/" } as any, fakeApi({ conversationId: 1, taskId: 1, callId: "b" }), context), /sandbox\.browser/);
		const jt = createJobsExtension(ctx, { resolveActor: fixedActor(ctx, guest.me.userId, guest.me.orgId, sp) }).tools!.find((x: any) => x.name === "job_start")!;
		await assert.rejects(jt.execute({ kind: "sandbox", sandbox: { language: "shell", code: "true" } } as any, fakeApi({ conversationId: 1, taskId: 2, callId: "j" }), context), /sandbox\.use/);

		// Network egress needs sandbox.network on top of the admin switch: a member has sandbox.use but not sandbox.network.
		const sb = ctx.services.get("sandbox") as Sandbox;
		const space = ctx.services.get("identity").space(sp)!;
		await assert.rejects(sb.run({ principal: await pr(member), space, conversationId: 1, language: "shell", code: "true", network: true }), (e: any) => e.status === 403 && /sandbox\.network/.test(e.message));
		await t.json("PUT", "/api/sandbox/driver", { token: owner.token, json: { network: "none" } });
	} finally {
		await cm.close();
		await t.dispose();
	}
});
