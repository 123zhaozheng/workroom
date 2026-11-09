// Cloud execution: namespace sandbox (no network, timeout kills, confined filesystem), publish, routes, code mode, browse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { startTestApp } from "./helpers/app.ts";
import { orgMember } from "./fixtures/util.ts";
import { answer, call, context, fakeApi, fixedActor, toolHarness } from "./fixtures/tool-harness.ts";
import { createSandboxExtension, createSandboxTools } from "../src/tools/sandbox-tools.ts";
import { createBrowserExtension } from "../src/tools/browser.ts";
import { probeIsolation, type Sandbox } from "../src/tools/sandbox.ts";
import { checkUrl, isPrivateAddress } from "../src/tools/netpolicy.ts";

test("sandbox: confined filesystem, no network, timeout kills the process tree, publish to library, routes share the space ACL", { skip: probeIsolation().ok ? false : probeIsolation().detail }, async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("sb@example.com");
		const viewer = await orgMember(t, a, "sbview@example.com");
		const outsider = await t.user("sbout@example.com");
		const { project } = await t.json("POST", "/api/projects", { token: a.token, json: { name: "Exec" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: a.token, json: { email: "sbview@example.com", role: "viewer" } });
		const ctx = t.app.ctx;
		const ext = createSandboxExtension(ctx, { resolveActor: fixedActor(ctx, a.me.userId, a.me.orgId, project.spaceId) });
		const secretPath = join(t.dataDir, "app.sqlite");
		const h = await toolHarness([ext], [
			call("sandbox_exec", { language: "python", code: `import os, socket\nopen('result.csv','w').write('a,b\\n1,2\\n')\nprint('cwd', os.getcwd())\nprint('root', sorted(os.listdir('/')))\nprint('secret', os.path.exists(${JSON.stringify(secretPath)}))\nprint('repo', os.path.exists('/home/user/workroom'))\ns = socket.socket(); s.settimeout(3)\ntry:\n  print('net', s.connect_ex(('1.1.1.1', 80)))\nexcept Exception as e:\n  print('net', type(e).__name__)\ntry:\n  open('/usr/evil', 'w')\nexcept Exception as e:\n  print('ro', type(e).__name__)\n` }, "x1"),
			call("sandbox_exec", { language: "shell", code: "(sleep 4321 &) ; sleep 4322", timeoutMs: 1500 }, "x2"),
			call("sandbox_exec", { language: "node", code: "import fs from 'node:fs'; console.log(fs.readFileSync('result.csv','utf8').trim().split('\\n').length)" }, "x3"),
			call("sandbox_publish", { path: "result.csv", name: "结果.csv" }, "x4"),
			answer("done"),
		]);
		await h.run("compute");
		const r = await h.results();
		assert.equal(r[0]!.isError, false, r[0]!.text);
		assert.match(r[0]!.text, /cwd \/work/);
		assert.match(r[0]!.text, /secret False/);
		assert.match(r[0]!.text, /repo False/);
		assert.match(r[0]!.text, /net (101|OSError|113|111)/);
		assert.doesNotMatch(r[0]!.text, /net 0\b/);
		assert.match(r[0]!.text, /ro OSError/);
		assert.doesNotMatch(r[0]!.text, /'home'|'root'|'opt'/);
		assert.equal(r[1]!.isError, true);
		assert.match(r[1]!.text, /status: timeout/);
		let survivors = "";
		try {
			survivors = execFileSync("pgrep", ["-f", "sleep 432[12]"], { encoding: "utf8" });
		} catch {
			/* pgrep exits 1 when nothing matches */
		}
		assert.equal(survivors.trim(), "", "sandboxed processes survived the timeout");
		assert.match(r[2]!.text, /stdout:\n2/);
		assert.equal(r[3]!.isError, false, r[3]!.text);
		assert.equal(r[3]!.details?.artifact?.name ?? (await t.json("GET", `/api/files?projectId=${project.id}`, { token: a.token })).files[0].name, "结果.csv");
		await h.close();

		const conv = Number(h.root.id);
		const files = await t.json("GET", `/api/sandbox/${project.spaceId}/files?conversationId=${conv}`, { token: a.token });
		assert.ok(files.entries.some((e: any) => e.path === "result.csv" && e.expiresAt));
		const runs = await t.json("GET", `/api/sandbox/${project.spaceId}/runs?conversationId=${conv}`, { token: viewer.token });
		assert.equal(runs.runs.length, 3);
		assert.deepEqual(runs.runs.map((x: any) => x.status).sort(), ["ok", "ok", "timeout"]);
		const dl = await t.req("GET", `/api/sandbox/${project.spaceId}/file?conversationId=${conv}&path=result.csv`, { token: viewer.token });
		assert.equal(await dl.text(), "a,b\n1,2\n");
		assert.equal((await t.req("GET", `/api/sandbox/${project.spaceId}/file?conversationId=${conv}&path=../../../app.sqlite`, { token: a.token })).status, 400);
		assert.equal((await t.req("GET", `/api/sandbox/${project.spaceId}/runs`, { token: outsider.token })).status, 403);
		const info = await t.json("GET", `/api/sandbox/${project.spaceId}`, { token: a.token });
		assert.equal(info.info.isolation, "namespaces");
		assert.equal(info.info.limits.network, false);
		await t.json("POST", `/api/sandbox/${project.spaceId}/publish`, { token: viewer.token, json: { conversationId: conv, path: "result.csv" }, expect: 403 });

		// Viewer's agent cannot execute code in the project's sandbox.
		const vt = createSandboxTools(ctx, { resolveActor: fixedActor(ctx, viewer.me.userId, viewer.me.orgId, project.spaceId) });
		await assert.rejects(vt.exec.execute({ language: "shell", code: "echo hi" } as any, fakeApi({ conversationId: conv, taskId: 900, callId: "v" }), context), /role_viewer|无权/);

		// Lifecycle: files idle past retention are reaped; fresh files stay.
		const sb = ctx.services.get("sandbox") as Sandbox;
		const space = ctx.services.get("identity").space(project.spaceId)!;
		const wd = sb.workdir(space, conv);
		mkdirSync(join(wd, "old"), { recursive: true });
		writeFileSync(join(wd, "old", "stale.txt"), "x");
		const past = new Date(Date.now() - 1000 * 3600 * 24 * 30);
		utimesSync(join(wd, "old", "stale.txt"), past, past);
		assert.equal(sb.reap(), 1);
		assert.equal(existsSync(join(wd, "old")), false);
		assert.equal(existsSync(join(wd, "result.csv")), true);
	} finally {
		await t.dispose();
	}
});

test("code mode: model-written JavaScript runs in QuickJS without host access and calls tools as nested calls", async () => {
	const t = await startTestApp();
	const sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024, timeoutMs: 30_000 });
	try {
		const a = await t.user("cm@example.com");
		const ctx = t.app.ctx;
		const space = ctx.services.get("identity").personalSpace(a.me.userId, a.me.orgId);
		const ext = createSandboxExtension(ctx, { resolveActor: fixedActor(ctx, a.me.userId, a.me.orgId, space.id) });
		const h = await toolHarness([ext, createCodemodeExtension({ sandbox, models: false })], [
			call("codemode", { code: `console.log(typeof process, typeof require, typeof fetch);\nawait tools.sandbox_write_file({ path: "cm.txt", content: "from quickjs" });\nconst listing = await tools.sandbox_list({});\nconsole.log(listing);` }, "cm1"),
			answer("ok"),
		]);
		await h.run("script it");
		const r = await h.results();
		assert.equal(r[0]!.name, "codemode");
		assert.equal(r[0]!.isError, false, r[0]!.text);
		assert.match(r[0]!.text, /undefined undefined undefined/);
		assert.match(r[0]!.text, /cm\.txt/);
		const calls = ctx.db.all<any>("SELECT tool FROM tool_calls WHERE space_id = ? ORDER BY started_ms", space.id).map((x) => x.tool);
		assert.deepEqual(calls, ["sandbox_write_file", "sandbox_list"]);
		await h.close();
	} finally {
		await sandbox.close();
		await t.dispose();
	}
});

test("URL policy blocks private, loopback and metadata addresses", async () => {
	for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) assert.equal(isPrivateAddress(ip), true, ip);
	for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"]) assert.equal(isPrivateAddress(ip), false, ip);
	await assert.rejects(checkUrl("http://169.254.169.254/latest/meta-data"), /内网|元数据/);
	await assert.rejects(checkUrl("http://localhost:8080/"), /内网|元数据/);
	await assert.rejects(checkUrl("file:///etc/passwd"), /协议/);
	await assert.rejects(checkUrl("http://user:pw@example.com/"), /用户名/);
});

test("browse: local page text + screenshot saved as a file version; subrequests to private addresses blocked", async () => {
	const t = await startTestApp();
	const server = createServer((req, res) => {
		if (req.url === "/next") {
			res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end();
			return;
		}
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>测试页面</title><body><h1>季度数据</h1><p>收入 120 万</p><img src="http://169.254.169.254/latest/meta-data/x.png"></body>`);
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${(server.address() as any).port}`;
	try {
		const a = await t.user("br@example.com");
		const ctx = t.app.ctx;
		const space = ctx.services.get("identity").personalSpace(a.me.userId, a.me.orgId);
		const ext = createBrowserExtension(ctx, { resolveActor: fixedActor(ctx, a.me.userId, a.me.orgId, space.id) });
		const browse = ext.tools![0]!;
		// Not allowlisted: the local server is a private address.
		await assert.rejects(browse.execute({ url: `${base}/` } as any, fakeApi({ conversationId: 1, taskId: 1, callId: "b0" }), context), /内网/);
		process.env.WORKROOM_URL_ALLOWLIST = new URL(base).host;
		const r = await browse.execute({ url: `${base}/`, screenshot: true } as any, fakeApi({ conversationId: 1, taskId: 2, callId: "b1" }), context);
		const text = (r.output as any)[0].text as string;
		assert.match(text, /# 测试页面/);
		assert.match(text, /收入 120 万/);
		assert.match(text, /已拦截 1 个/);
		const shot = (r.details as any).screenshot;
		assert.equal(shot.mime, "image/png");
		const png = new Uint8Array(await (await t.req("GET", `/api/files/${shot.fileId}/versions/${shot.versionId}/download`, { token: a.token })).arrayBuffer());
		assert.deepEqual([...png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
		const d = await t.json("GET", `/api/files/${shot.fileId}`, { token: a.token });
		assert.equal(d.versions[0].provenance.tool, "browse");
		// Replay of the same call does not create a second screenshot version.
		const again = await browse.execute({ url: `${base}/`, screenshot: true } as any, fakeApi({ conversationId: 1, taskId: 2, callId: "b1" }), context);
		assert.equal((again.details as any).screenshot.versionId, shot.versionId);
		// A redirect into the metadata address is refused.
		await assert.rejects(browse.execute({ url: `${base}/next` } as any, fakeApi({ conversationId: 1, taskId: 3, callId: "b2" }), context));
	} finally {
		delete process.env.WORKROOM_URL_ALLOWLIST;
		await new Promise((r) => server.close(r));
		await t.dispose();
	}
});
