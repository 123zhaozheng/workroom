// Round 14 delivery guarantees (docs/r14-virtual-backend.md §3, §5): V13 URL delivery, V15 crash between save and tool result (real SIGKILL),
// older-call replay never moves the current file back, V16 path safety in /work and /library isolation, V19 rename keeps paths and downloads,
// legacy outputs migration (§11.1 item 2).
process.env.WORKROOM_RT_RETRY_MAX ??= "1";
process.env.WORKROOM_FIXTURE_TOOLS = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { waitFor } from "../src/runtime/testing.ts";
import type { Library } from "../src/files/library.ts";
import type { VfsRouter } from "../src/vfs/router.ts";

type Conv = { spaceId: string; conversationId: number };
const base = (c: Conv) => `/api/conversations/${c.spaceId}/${c.conversationId}`;
const call = (tool: string, args: unknown) => `[[call ${tool} ${JSON.stringify(args)}]]`;
const ROOT = resolve(import.meta.dirname, "../..");

async function say(t: TestApp, token: string, c: Conv, text: string) {
	const r = await t.json("POST", `${base(c)}/messages`, { token, json: { text, requestId: randomUUID() } });
	return waitFor(async () => {
		const s = await t.json("GET", `${base(c)}/submissions/${r.submissionId}`, { token });
		return ["done", "unanswered", "withdrawn"].includes(s.status) ? s : undefined;
	}, { timeoutMs: 60_000, what: "submission settles" });
}
async function results(t: TestApp, c: Conv, name: string) {
	const h = await t.app.ctx.services.get("runtime").harness(c.spaceId, BACKGROUND_CONTEXT);
	const conv = (await h.conversation(c.conversationId as any, BACKGROUND_CONTEXT))!;
	const items = (await conv.entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT)).items as any[];
	return items.filter((e) => e.kind === "pi.tool-result" && e.model?.[0]?.toolName === name).map((e) => ({ text: e.model[0].content.map((x: any) => x.text ?? "").join(""), isError: !!e.model[0].isError, details: e.model[0].details }));
}
function serve(handler: (path: string) => { status: number; body?: Buffer | string; headers?: Record<string, string | undefined> }): Promise<{ url: string; server: Server; port: number }> {
	return new Promise((res) => {
		const server = createServer((req, r) => {
			const out = handler(req.url ?? "/");
			r.writeHead(out.status, Object.fromEntries(Object.entries(out.headers ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string>);
			r.end(out.body ?? "");
		});
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as any).port as number;
			res({ url: `http://127.0.0.1:${port}`, server, port });
		});
	});
}

test("V13: a URL delivery saves the real bytes (still downloadable after the URL dies); errors and oversize produce no output", { timeout: 120_000 }, async () => {
	const pdf = Buffer.from("%PDF-1.4\n% r14 test\n");
	const up = await serve((p) => (p === "/report.pdf" ? { status: 200, body: pdf, headers: { "content-type": "application/pdf" } } : p === "/redirect" ? { status: 302, headers: { location: "/report.pdf" } } : p === "/big" ? { status: 200, body: Buffer.alloc(3 * 1024 * 1024, 1) } : { status: 404 }));
	process.env.WORKROOM_URL_ALLOWLIST = `127.0.0.1:${up.port}`;
	const t = await startTestApp();
	try {
		const a = await t.user("r14-url@example.com");
		const c: Conv = (await t.json("POST", "/api/conversations", { token: a.token, json: { title: "URL 交付" } })).conversation;
		await say(t, a.token, c, call("present_file", { source: `${up.url}/redirect`, name: "研究报告.pdf" }));
		const r = (await results(t, c, "present_file"))[0]!;
		assert.ok(!r.isError, r.text);
		assert.equal(r.details.item.name, "研究报告.pdf");
		assert.equal(r.details.item.size, pdf.length);
		await new Promise<void>((x) => up.server.close(() => x()));
		const dl = await t.req("GET", r.details.item.downloadUrl, { token: a.token });
		assert.deepEqual(Buffer.from(await dl.arrayBuffer()), pdf, "the saved bytes outlive the URL");
		const again = await serve((p) => (p === "/big" ? { status: 200, body: Buffer.alloc(3 * 1024 * 1024, 1) } : { status: 404 }));
		process.env.WORKROOM_URL_ALLOWLIST = `127.0.0.1:${again.port}`;
		process.env.WORKROOM_FETCH_MAX_MB = "1";
		await say(t, a.token, c, call("present_file", { source: `${again.url}/missing.pdf` }));
		await say(t, a.token, c, call("present_file", { source: `${again.url}/big` }));
		const errs = (await results(t, c, "present_file")).slice(1);
		assert.ok(errs[0]!.isError && /404/.test(errs[0]!.text), errs[0]!.text);
		assert.ok(errs[1]!.isError && /too_large|上限/.test(errs[1]!.text), errs[1]!.text);
		assert.equal((await t.json("GET", `/api/library?spaceId=${c.spaceId}&conversationId=${c.conversationId}`, { token: a.token })).items.length, 1, "failed downloads produce no output");
		// a private address that is not allowlisted is refused by the egress policy
		delete process.env.WORKROOM_URL_ALLOWLIST;
		await say(t, a.token, c, call("present_file", { source: `${again.url}/big` }));
		assert.match((await results(t, c, "present_file")).at(-1)!.text, /内网|url_blocked|不允许/);
		await new Promise<void>((x) => again.server.close(() => x()));
	} finally {
		delete process.env.WORKROOM_FETCH_MAX_MB;
		delete process.env.WORKROOM_URL_ALLOWLIST;
		await t.dispose();
	}
});

test("V15 (service level): an older call replayed after a newer delivery never moves the current file back; a replayed call returns its receipt", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("r14-replay@example.com");
		const c: Conv = (await t.json("POST", "/api/conversations", { token: a.token, json: { title: "重放" } })).conversation;
		const lib = (t.app.ctx.services as any).get("library") as Library;
		const p = (await t.app.ctx.services.get("identity").principalFor(a.me.userId, a.me.orgId))!;
		const space = t.app.ctx.services.get("identity").space(c.spaceId)!;
		const enc = (s: string) => new TextEncoder().encode(s);
		const first = await lib.present(p, { space, conversationId: c.conversationId, name: "a.md", bytes: enc("one"), source: "work:/work/a.md", callKey: "k1" });
		// call A saves revision 2 and crashes before its receipt (simulated: the file service write with A's idempotency key, no receipt)
		await (t.app.ctx.services.get("files") as any).putVersion(p, { fileId: first.item.fileId, name: "a.md", mime: "text/markdown", bytes: enc("two (A)"), provenance: { origin: "agent", createdBy: p.userId, spaceId: space.id, conversationId: c.conversationId, tool: "present_file" }, idempotencyKey: "present:kA" });
		const b = await lib.present(p, { space, conversationId: c.conversationId, name: "a.md", bytes: enc("three (B)"), source: "work:/work/a.md", callKey: "kB" });
		assert.equal(b.status, "updated");
		const replayA = await lib.present(p, { space, conversationId: c.conversationId, name: "a.md", bytes: enc("two (A)"), source: "work:/work/a.md", callKey: "kA" });
		assert.equal(replayA.superseded, true, "the old call is recognized as superseded");
		assert.equal(await (await t.req("GET", first.item.downloadUrl, { token: a.token })).text(), "three (B)", "current content stays the newer one");
		const replayB = await lib.present(p, { space, conversationId: c.conversationId, name: "a.md", bytes: enc("ignored"), source: "x", callKey: "kB" });
		assert.deepEqual(replayB, b, "a replay returns the recorded result");
		assert.equal(t.app.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM lib_items WHERE conversation_id = ? AND space_id = ?", c.conversationId, c.spaceId)!.n, 1);
	} finally {
		await t.dispose();
	}
});

async function freePort(): Promise<number> {
	return new Promise((res) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const p = (s.address() as any).port;
			s.close(() => res(p));
		});
	});
}

test("V15 (real crash): SIGKILL after the library commit and before the tool result is stored → after restart no second save, no second card", { timeout: 180_000 }, async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "wr-r14-kill-"));
	const marker = join(dataDir, "killed-once");
	const port = await freePort();
	const log = join(dataDir, "server.log");
	let child: ChildProcess | undefined;
	const start = async () => {
		child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/src/main.ts"], {
			cwd: ROOT,
			env: { ...process.env, WORKROOM_DATA_DIR: dataDir, PORT: String(port), HOST: "127.0.0.1", WORKROOM_INSTANCE_ID: "r14-node", WORKROOM_FIXTURE_TOOLS: "1", WORKROOM_RT_RETRY_BASE_MS: "50", WORKROOM_WEB_DIST: join(dataDir, "no-web"), WORKROOM_TEST_KILL_AFTER_PRESENT: marker },
			stdio: ["ignore", openSync(log, "a"), openSync(log, "a")],
		});
		await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => undefined))?.ok, { timeoutMs: 20_000, what: "server up" });
	};
	const req = async (method: string, path: string, token?: string, json?: unknown) => {
		const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json !== undefined ? { "content-type": "application/json" } : {}) }, body: json === undefined ? undefined : JSON.stringify(json) });
		const text = await r.text();
		if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${text}`);
		return text ? JSON.parse(text) : undefined;
	};
	try {
		await start();
		const { token } = await req("POST", "/api/auth/register", undefined, { email: "r14kill@example.com", name: "r14", password: "password123" });
		const { conversation: c } = await req("POST", "/api/conversations", token, { title: "崩溃窗口" });
		const exited = new Promise((r) => child!.once("exit", r));
		await req("POST", `${base(c)}/messages`, token, { text: `${call("write", { path: "/work/r.md", content: "崩溃前保存" })} ${call("present_file", { source: "/work/r.md" })}`, requestId: randomUUID() });
		await exited;
		assert.ok(existsSync(marker), "the process died inside the crash window");
		await start();
		const st = await waitFor(async () => {
			const s = await req("GET", `${base(c)}/state?limit=200`, token);
			return !s.live.busy && s.entries.some((e: any) => e.kind === "tool_result" && e.toolName === "present_file") ? s : undefined;
		}, { timeoutMs: 60_000, what: "the replayed present_file finished" });
		const res = st.entries.filter((e: any) => e.kind === "tool_result" && e.toolName === "present_file");
		assert.equal(res.length, 1, "one tool result");
		assert.equal(res[0].details.kind, "wr.presented");
		assert.equal(st.work.outputs.length, 1, "one output, no duplicate card");
		const fileId = st.work.outputs[0].fileId;
		const { file, versions } = await req("GET", `/api/files/${fileId}`, token);
		assert.equal(versions.length, 1, `no second save (${versions.length} internal revisions)`);
		void file;
	} catch (err) {
		console.error(readFileSync(log, "utf8").slice(-3000));
		throw err;
	} finally {
		if (child && child.exitCode === null) {
			const e = new Promise((r) => child!.once("exit", r));
			child.kill("SIGKILL");
			await e;
		}
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("V16 + V19: /work path safety; another person's library is invisible; a renamed conversation keeps its library path and download", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("r14-sec-a@example.com");
		const b = await t.user("r14-sec-b@example.com");
		const c: Conv = (await t.json("POST", "/api/conversations", { token: a.token, json: { title: "安全测试" } })).conversation;
		const vfs = (t.app.ctx.services as any).get("vfs") as VfsRouter;
		const id = t.app.ctx.services.get("identity");
		const ctxOf = async (u: any, conv: Conv) => ({ principal: (await id.principalFor(u.me.userId, u.me.orgId))!, space: id.space(conv.spaceId)!, conversationId: conv.conversationId });
		const va = await ctxOf(a, c);
		await assert.rejects(() => vfs.read(va, "/work/../../etc/passwd"), (e: any) => e.code === "bad_path" || e.code === "unknown_root");
		await assert.rejects(() => vfs.read(va, "../../etc/passwd"), (e: any) => e.code === "bad_path" || e.code === "unknown_root");
		await assert.rejects(() => vfs.list(va, "/proc"), (e: any) => e.code === "unknown_root");
		const wd = (t.app.ctx.services.get("sandbox") as any).workdir(id.space(c.spaceId), c.conversationId);
		const outside = mkdtempSync(join(tmpdir(), "wr-outside-"));
		writeFileSync(join(outside, "secret.txt"), "top secret");
		symlinkSync(outside, join(wd, "escape"));
		await assert.rejects(() => vfs.read(va, "/work/escape/secret.txt"), (e: any) => e.code === "forbidden");
		assert.ok(!(await vfs.list(va, "/work")).entries.some((n) => n.name === "escape"), "an escaping link is not listed");
		// a's delivered output
		const lib = (t.app.ctx.services as any).get("library") as Library;
		const out = await lib.present(va.principal, { space: va.space, conversationId: c.conversationId, name: "私密.md", bytes: new TextEncoder().encode("a only"), source: "work:/work/x", callKey: "sec-1" });
		// b (another org: own personal space) sees nothing of it, by path or listing
		const cb: Conv = (await t.json("POST", "/api/conversations", { token: b.token, json: {} })).conversation;
		const vb = await ctxOf(b, cb);
		assert.equal((await vfs.list(vb, "/library")).entries.length, 0);
		assert.equal(await vfs.stat(vb, out.item.path), null);
		await assert.rejects(() => vfs.read(vb, out.item.path), (e: any) => e.code === "not_found");
		assert.equal((await t.req("GET", out.item.downloadUrl, { token: b.token })).status >= 400, true);
		// V19: rename → same path, same download
		await t.json("PATCH", `${base(c)}`, { token: a.token, json: { title: "改名之后" } });
		const after = (await t.json("GET", `/api/library?spaceId=${c.spaceId}&conversationId=${c.conversationId}`, { token: a.token })).items[0];
		assert.equal(after.path, out.item.path, "the folder name is fixed at the first delivery");
		assert.equal(await (await t.req("GET", out.item.downloadUrl, { token: a.token })).text(), "a only");
		rmSync(outside, { recursive: true, force: true });
	} finally {
		await t.dispose();
	}
});

test("migration: pre-round-14 agent deliverables become current library files; uploads, screenshots and unknown sources stay out (report)", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("r14-mig@example.com");
		const c: Conv = (await t.json("POST", "/api/conversations", { token: a.token, json: { title: "旧成果" } })).conversation;
		const files = t.app.ctx.services.get("files") as any;
		const p = (await t.app.ctx.services.get("identity").principalFor(a.me.userId, a.me.orgId))!;
		const prov = (tool: string, origin = "agent") => ({ origin, createdBy: p.userId, spaceId: c.spaceId, conversationId: c.conversationId, tool });
		const enc = (s: string) => new TextEncoder().encode(s);
		// written directly to the file tables as a pre-round-14 deployment would have (the adoption hook is bypassed by clearing the rows after)
		const v1 = await files.putVersion(p, { name: "周报.md", mime: "text/markdown", bytes: enc("v1"), provenance: prov("file_create") });
		await files.putVersion(p, { fileId: v1.fileId, name: "周报.md", mime: "text/markdown", bytes: enc("v2"), provenance: prov("file_revise") });
		await files.putVersion(p, { name: "截图.png", mime: "image/png", bytes: enc("png"), provenance: prov("browse") });
		await files.putVersion(p, { name: "附件.csv", mime: "text/csv", bytes: enc("a,b"), provenance: { ...prov("upload", "upload") } });
		// V23: a background-job output or a screenshot written NOW does not become an output on its own
		await files.putVersion(p, { name: "任务输出.csv", mime: "text/csv", bytes: enc("x,y"), provenance: prov("job:sandbox") });
		assert.equal((t.app.ctx.services as any).get("library").ofConversation(c.spaceId, c.conversationId).filter((i: any) => i.name === "任务输出.csv" || i.name === "截图.png").length, 0, "job outputs and screenshots are not deliveries");
		t.app.ctx.db.run("DELETE FROM lib_items");
		t.app.ctx.db.run("DELETE FROM lib_migrations");
		const lib = (t.app.ctx.services as any).get("library") as Library;
		const r = lib.migrateLegacy(t.dataDir)!;
		assert.equal(r.migrated, 1);
		assert.deepEqual(r.skipped, { screenshot_or_browse: 1, upload: 1, job_output: 1 });
		const items = lib.ofConversation(c.spaceId, c.conversationId);
		assert.equal(items.length, 1);
		assert.equal(items[0]!.name, "周报.md");
		assert.equal(await (await t.req("GET", items[0]!.downloadUrl, { token: a.token })).text(), "v2", "the newest version is the current file");
		assert.ok(existsSync(join(t.dataDir, "backups", "r14", "library-report.json")));
		assert.equal(lib.migrateLegacy(t.dataDir), null, "runs once");
	} finally {
		await t.dispose();
	}
});
