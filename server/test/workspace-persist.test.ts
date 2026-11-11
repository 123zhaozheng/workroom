// Round 7b (group P): persistent workspace — versions, limits, safety, conflicts, restore, reaping, reconciliation, permissions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { orgMember } from "./fixtures/util.ts";
import type { AppEnv, Principal, Space } from "../src/core/contracts.ts";
import { HttpError } from "../src/core/http.ts";
import { PERSIST_MIGRATIONS, RUN_RECONCILED_NOTE, workspacePersistenceFor, type WorkspacePersistence } from "../src/tools/sandbox/persist.ts";
import { registerPersistRoutes } from "../src/tools/sandbox/persist-routes.ts";

const KEY = "c1";

interface World {
	t: TestApp;
	svc: WorkspacePersistence;
	owner: { token: string; me: any };
	member: { token: string; me: any };
	outsider: { token: string; me: any };
	space: Space;
	wd: string;
	p: (u: { me: any }) => Promise<Principal>;
	ownerP: Principal;
	write(rel: string, content: string | Uint8Array): void;
	call(u: { me: any }, method: string, path: string, json?: unknown): Promise<{ status: number; body: any }>;
}

async function world(): Promise<World> {
	const t = await startTestApp();
	const ctx = t.app.ctx;
	// Until the integrator wires PERSIST_MIGRATIONS into toolsModule (offset 1000) the tables are created here.
	if (!ctx.db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'workspace_versions'")) ctx.db.migrate("tools-p-test", PERSIST_MIGRATIONS);
	const owner = await t.user("pown@p.example");
	const member = await orgMember(t, owner, "pmem@p.example");
	const outsider = await t.user("pout@o.example");
	const { project } = await t.json("POST", "/api/projects", { token: owner.token, json: { kind: "space", name: "Persist" } });
	await t.json("PUT", `/api/projects/${project.id}/members`, { token: owner.token, json: { email: "pmem@p.example", role: "viewer" } });
	const space = ctx.services.get("identity").space(project.spaceId as string)!;
	const p = async (u: { me: any }) => (await ctx.services.get("identity").principalFor(u.me.userId, u.me.orgId))!;
	const hono = new Hono<AppEnv>();
	hono.onError((err, c) => (err instanceof HttpError ? c.json({ error: { code: err.code, message: err.message } }, err.status as 400) : c.json({ error: { code: "internal", message: String(err) } }, 500)));
	hono.use("*", async (c, next) => {
		const [uid, oid] = c.req.header("x-who")!.split("|");
		c.set("principal", (await ctx.services.get("identity").principalFor(uid!, oid!))!);
		await next();
	});
	const api = new Hono<AppEnv>();
	registerPersistRoutes(api, ctx);
	hono.route("/api", api);
	const wd = join(space.dir, "sandbox", KEY);
	return {
		t, svc: workspacePersistenceFor(ctx), owner, member, outsider, space, wd, p, ownerP: await p(owner),
		write(rel, content) {
			const f = join(wd, rel);
			mkdirSync(dirname(f), { recursive: true });
			writeFileSync(f, content);
		},
		async call(u, method, path, json) {
			const res = await hono.fetch(new Request(`http://x${path}`, { method, headers: { "x-who": `${u.me.userId}|${u.me.orgId}`, "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) }));
			const text = await res.text();
			return { status: res.status, body: text ? JSON.parse(text) : undefined };
		},
	};
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const base = (w: World) => `/api/workspaces/${w.space.id}/${KEY}`;

test("commit creates versions, is idempotent, skips excluded paths, keeps the working copy", async () => {
	const w = await world();
	try {
		w.write("a.txt", "alpha");
		w.write("sub/b.py", "print(1)");
		w.write("node_modules/x/index.js", "junk");
		w.write("cache.tmp", "junk");
		w.write("sub/__pycache__/b.pyc", "junk");
		const st0 = await w.svc.status(w.ownerP, w.space, KEY);
		assert.equal(st0.state, "dirty");
		assert.equal(st0.unsynced.count, 2);
		assert.ok(st0.excludedPatterns.includes("node_modules/"));
		assert.match(st0.lossWindow, /工作目录/);

		const r1 = await w.svc.commit(w.ownerP, w.space, KEY, "manual");
		assert.equal(r1.ok, true);
		assert.equal(r1.created, true);
		assert.equal(r1.version, 1);
		assert.equal(r1.status.state, "saved");
		assert.equal(r1.status.headVersion, 1);
		assert.equal(readFileSync(join(w.wd, "a.txt"), "utf8"), "alpha");
		assert.ok(existsSync(join(w.wd, "node_modules/x/index.js")), "excluded files stay in the working copy");

		const r2 = await w.svc.commit(w.ownerP, w.space, KEY, "run_end");
		assert.equal(r2.ok, true);
		assert.equal(r2.created, false, "same manifest: no new version");
		assert.equal(r2.version, 1);

		w.write("a.txt", "alpha 2");
		assert.equal((await w.svc.status(w.ownerP, w.space, KEY)).state, "dirty");
		const r3 = await w.svc.commit(w.ownerP, w.space, KEY, "turn_end");
		assert.equal(r3.version, 2);
		const versions = await w.svc.versions(w.ownerP, w.space, KEY);
		assert.deepEqual(versions.map((v) => [v.version, v.reason, v.fileCount]), [[2, "turn_end", 2], [1, "manual", 2]]);
		const man = await w.svc.manifest(w.ownerP, w.space, KEY, 1);
		assert.deepEqual(man.map((e) => e.path), ["a.txt", "sub/b.py"]);
		assert.equal(man[0]!.sha256, sha("alpha"));
		assert.ok(w.t.app.ctx.blobs.has(sha("alpha 2")));
	} finally {
		await w.t.dispose();
	}
});

test("limits fail explicitly (no silent truncation) and keep the working copy; policy applies", async () => {
	const w = await world();
	try {
		await w.svc.setPolicy(w.ownerP, { maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 15 });
		w.write("a", "12345");
		w.write("b", "12345");
		w.write("c", "1");
		let r = await w.svc.commit(w.ownerP, w.space, KEY, "manual");
		assert.equal(r.ok, false);
		assert.equal(r.status.state, "failed");
		assert.match(r.status.failure!, /文件数超过上限 2/);
		rmSync(join(w.wd, "c"));
		rmSync(join(w.wd, "b"));
		w.write("big", "x".repeat(11));
		r = await w.svc.commit(w.ownerP, w.space, KEY, "manual");
		assert.match(r.status.failure!, /big.*超过单文件上限/);
		rmSync(join(w.wd, "big"));
		w.write("b", "12345");
		await w.svc.setPolicy(w.ownerP, { maxFiles: 10, maxFileBytes: 8, maxTotalBytes: 8 });
		r = await w.svc.commit(w.ownerP, w.space, KEY, "manual");
		assert.match(r.status.failure!, /总大小超过上限/);
		assert.equal(r.status.headVersion, null, "nothing saved");
		assert.equal(readFileSync(join(w.wd, "a"), "utf8"), "12345");
		assert.equal((await w.svc.versions(w.ownerP, w.space, KEY)).length, 0);
	} finally {
		await w.t.dispose();
	}
});

test("symlinks and special files are never followed or saved; unsafe restore paths are refused", async () => {
	const w = await world();
	try {
		w.write("ok.txt", "fine");
		const secret = join(w.t.dataDir, "outside-secret.txt");
		writeFileSync(secret, "TOP-SECRET");
		symlinkSync(secret, join(w.wd, "link.txt"));
		symlinkSync(w.t.dataDir, join(w.wd, "dirlink"));
		const r = await w.svc.commit(w.ownerP, w.space, KEY, "manual");
		assert.equal(r.ok, true);
		assert.ok(r.notes.some((n) => n.startsWith("link.txt")) && r.notes.some((n) => n.startsWith("dirlink")), r.notes.join("|"));
		const man = await w.svc.manifest(w.ownerP, w.space, KEY, 1);
		assert.deepEqual(man.map((e) => e.path), ["ok.txt"]);
		assert.ok(!w.t.app.ctx.blobs.has(sha("TOP-SECRET")), "the link target was not read");
		// A copy holding a symlink is not eligible for reaping (it cannot be recreated from the version).
		assert.equal(await w.svc.isSafeToReap(w.space, KEY), false);

		// Crafted manifest with an escaping path: refused, nothing written outside.
		const bad = [{ path: "../../escape.txt", size: 1, sha256: sha("x"), mode: 0o644 }];
		const db = w.t.app.ctx.db;
		w.t.app.ctx.blobs.put(new TextEncoder().encode("x"));
		db.run(
			"INSERT INTO workspace_versions (id, org_id, space_id, workspace_key, version, parent_version, manifest_sha256, manifest, file_count, total_bytes, reason, created_by, created_at) VALUES ('wsv_bad', ?, ?, ?, 9, 1, ?, ?, 1, 1, 'manual', 'u', ?)",
			w.space.orgId, w.space.id, KEY, createHash("sha256").update(JSON.stringify(bad.map((e) => [e.path, e.size, e.sha256, e.mode]))).digest("hex"), JSON.stringify(bad), new Date().toISOString(),
		);
		rmSync(join(w.wd, "link.txt"));
		rmSync(join(w.wd, "dirlink"));
		await assert.rejects(w.svc.restore(w.ownerP, w.space, KEY, { version: 9 }), (e: any) => e.status === 500 && /不安全路径/.test(e.message));
		assert.ok(!existsSync(join(w.space.dir, "escape.txt")) && !existsSync(join(w.space.dir, "sandbox", "escape.txt")));
		assert.equal(readFileSync(join(w.wd, "ok.txt"), "utf8"), "fine");
	} finally {
		await w.t.dispose();
	}
});

test("concurrent commits: one version, no corruption; stale base conflicts and overwrites nothing", async () => {
	const w = await world();
	try {
		w.write("a.txt", "one");
		const [a, b] = await Promise.all([w.svc.commit(w.ownerP, w.space, KEY, "manual"), w.svc.commit(w.ownerP, w.space, KEY, "run_end")]);
		assert.equal(a.ok && b.ok, true);
		assert.equal([a, b].filter((r) => r.created).length, 1);
		assert.equal((await w.svc.versions(w.ownerP, w.space, KEY)).length, 1);

		w.write("a.txt", "two");
		assert.equal((await w.svc.commit(w.ownerP, w.space, KEY, "manual")).version, 2);
		// A writer that started from version 1 is stale now.
		w.write("a.txt", "three");
		const stale = await w.svc.commit(w.ownerP, w.space, KEY, "manual", { baseVersion: 1 });
		assert.equal(stale.ok, false);
		assert.equal(stale.status.state, "conflict");
		assert.match(stale.status.failure!, /第 1 版.*第 2 版|最新为第 2 版/);
		assert.equal((await w.svc.versions(w.ownerP, w.space, KEY)).length, 2, "nothing written");
		assert.equal(readFileSync(join(w.wd, "a.txt"), "utf8"), "three");
		// Not eligible for reaping while in conflict; saving again on top of the head resolves it.
		assert.equal(await w.svc.isSafeToReap(w.space, KEY), false);
		const ok = await w.svc.commit(w.ownerP, w.space, KEY, "manual");
		assert.equal(ok.status.state, "saved");
		assert.equal(ok.version, 3);
		// Two stale writers at once: exactly one wins.
		w.write("a.txt", "four");
		const [x, y] = await Promise.all([w.svc.commit(w.ownerP, w.space, KEY, "manual", { baseVersion: 3 }), w.svc.commit(w.ownerP, w.space, KEY, "manual", { baseVersion: 3 })]);
		assert.equal([x, y].filter((r) => r.created).length, 1);
		assert.equal((await w.svc.versions(w.ownerP, w.space, KEY)).length, 4);
	} finally {
		await w.t.dispose();
	}
});

test("failure keeps the working copy, reports the reason and blocks reaping", async () => {
	const w = await world();
	try {
		w.write("a.txt", "keep me");
		await w.svc.setPolicy(w.ownerP, { maxFileBytes: 3 });
		const r = await w.svc.commit(w.ownerP, w.space, KEY, "run_end");
		assert.equal(r.ok, false);
		assert.equal(r.status.state, "failed");
		assert.ok(r.status.failure);
		assert.equal((await w.svc.status(w.ownerP, w.space, KEY)).state, "failed", "sticky until a commit succeeds");
		assert.equal(await w.svc.isSafeToReap(w.space, KEY), false);
		old(w.wd);
		const reap = await w.svc.reapWorkingCopies(Date.now() + 100 * 3600_000);
		assert.deepEqual(reap.removed, []);
		assert.equal(reap.kept.length, 1);
		assert.equal(readFileSync(join(w.wd, "a.txt"), "utf8"), "keep me");
	} finally {
		await w.t.dispose();
	}
});

function old(dir: string, ageMs = 200 * 3600_000): void {
	const t = new Date(Date.now() - ageMs);
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const f = join(dir, e.name);
		if (e.isDirectory()) old(f, ageMs);
		utimesSync(f, t, t);
	}
	utimesSync(dir, t, t);
}

test("reaper removes only idle, saved copies equal to the head", async () => {
	const w = await world();
	try {
		const wd2 = join(w.space.dir, "sandbox", "c2");
		mkdirSync(wd2, { recursive: true });
		writeFileSync(join(wd2, "unsaved.txt"), "never committed");
		w.write("a.txt", "saved content");
		w.write("node_modules/m.js", "cache");
		assert.equal((await w.svc.commit(w.ownerP, w.space, KEY, "manual")).ok, true);
		assert.equal(await w.svc.isSafeToReap(w.space, KEY), true);

		// Recent: nothing removed.
		let r = await w.svc.reapWorkingCopies();
		assert.deepEqual(r.removed, []);
		old(w.wd);
		old(wd2);
		// Now idle: the saved copy goes, the never-saved one stays.
		r = await w.svc.reapWorkingCopies();
		assert.deepEqual(r.removed, [`${w.space.id}/${KEY}`], JSON.stringify(r.kept));
		assert.ok(r.kept.some((k) => k.workspace.endsWith("/c2")));
		assert.ok(!existsSync(w.wd));
		assert.equal(readFileSync(join(wd2, "unsaved.txt"), "utf8"), "never committed");

		// A saved copy modified after the commit is dirty → kept.
		const rr = await w.svc.restore(w.ownerP, w.space, KEY, {});
		assert.equal(rr.fromVersion, 1);
		w.write("a.txt", "edited later");
		old(w.wd);
		r = await w.svc.reapWorkingCopies();
		assert.deepEqual(r.removed, []);
		assert.equal(readFileSync(join(w.wd, "a.txt"), "utf8"), "edited later");
	} finally {
		await w.t.dispose();
	}
});

test("restore after the working copy is gone verifies hashes and modes; ensureReady restores before a run", async () => {
	const w = await world();
	try {
		w.write("a.txt", "alpha");
		w.write("bin/run.sh", "#!/bin/sh\necho hi\n");
		chmodSync(join(w.wd, "bin/run.sh"), 0o755);
		w.write("data/Ünï.csv", "x,y\n1,2\n");
		assert.equal((await w.svc.commit(w.ownerP, w.space, KEY, "manual")).ok, true);
		rmSync(w.wd, { recursive: true, force: true });
		const st = await w.svc.status(w.ownerP, w.space, KEY);
		assert.equal(st.state, "dirty");
		assert.equal(st.unsynced.count, 3);

		const st2 = await w.svc.ensureReady(w.ownerP, w.space, KEY);
		assert.equal(st2.state, "restored");
		assert.deepEqual(st2.restore && { v: st2.restore.fromVersion, ok: st2.restore.verified, c: st2.restore.conflicts }, { v: 1, ok: true, c: [] });
		assert.equal(readFileSync(join(w.wd, "a.txt"), "utf8"), "alpha");
		assert.equal(readFileSync(join(w.wd, "data/Ünï.csv"), "utf8"), "x,y\n1,2\n");
		assert.ok((await import("node:fs")).statSync(join(w.wd, "bin/run.sh")).mode & 0o100, "exec bit restored");
		assert.equal((await w.svc.status(w.ownerP, w.space, KEY)).state, "restored", "clean after restore");
		// ensureReady with an existing copy is a no-op.
		w.write("a.txt", "newer");
		assert.equal((await w.svc.ensureReady(w.ownerP, w.space, KEY)).state, "dirty");
		assert.equal(readFileSync(join(w.wd, "a.txt"), "utf8"), "newer");
		assert.ok(!existsSync(join(w.space.dir, "sandbox", ".restore-tmp", "x")));
	} finally {
		await w.t.dispose();
	}
});

test("restore refuses to overwrite unsynced changes (conflict lists paths); keep-both saves them first; older version restore", async () => {
	const w = await world();
	try {
		w.write("a.txt", "v1");
		await w.svc.commit(w.ownerP, w.space, KEY, "manual");
		w.write("a.txt", "v2");
		await w.svc.commit(w.ownerP, w.space, KEY, "manual");
		w.write("a.txt", "unsaved work");
		w.write("new.txt", "also unsaved");
		await assert.rejects(w.svc.restore(w.ownerP, w.space, KEY, { version: 1 }), (e: any) => e.status === 409 && e.code === "workspace_dirty");
		assert.equal(readFileSync(join(w.wd, "a.txt"), "utf8"), "unsaved work");
		const st = await w.svc.status(w.ownerP, w.space, KEY);
		assert.equal(st.state, "dirty"); // a refused restore changed nothing: still just unsaved changes (not a conflict)
		assert.deepEqual(st.restore?.conflicts, ["a.txt", "new.txt"]);
		assert.equal(st.restore?.verified, false);

		// keep-both: current contents become version 3, then version 1 is restored.
		const r = await w.svc.restore(w.ownerP, w.space, KEY, { version: 1, force: "keep-both" });
		assert.equal(r.keptAsVersion, 3);
		assert.equal(readFileSync(join(w.wd, "a.txt"), "utf8"), "v1");
		assert.ok(!existsSync(join(w.wd, "new.txt")));
		const m3 = await w.svc.manifest(w.ownerP, w.space, KEY, 3);
		assert.deepEqual(m3.map((e) => [e.path, e.sha256]), [["a.txt", sha("unsaved work")], ["new.txt", sha("also unsaved")]]);
		assert.equal(r.status.state, "restored");
		assert.equal(r.status.headVersion, 1);
		// The next save builds on the restored version, with a fresh number.
		w.write("a.txt", "v1 + edit");
		assert.equal((await w.svc.commit(w.ownerP, w.space, KEY, "manual")).version, 4);
	} finally {
		await w.t.dispose();
	}
});

test("tampered or missing blob: restore fails loudly and touches nothing", async () => {
	const w = await world();
	try {
		w.write("a.txt", "precious");
		w.write("b.txt", "other");
		await w.svc.commit(w.ownerP, w.space, KEY, "manual");
		const blobs = w.t.app.ctx.blobs as any;
		writeFileSync(blobs.path(sha("precious")), "TAMPERED");
		rmSync(w.wd, { recursive: true, force: true });
		await assert.rejects(w.svc.restore(w.ownerP, w.space, KEY, {}), (e: any) => e.status === 500 && e.code === "restore_verify_failed" && /a\.txt.*sha256 不一致/.test(e.message));
		assert.ok(!existsSync(w.wd), "no partial working copy");
		const tmpRoot = join(w.space.dir, "sandbox", ".restore-tmp");
		assert.ok(!existsSync(tmpRoot) || readdirSync(tmpRoot).length === 0, "temp dir cleaned");
		const st = await w.svc.status(w.ownerP, w.space, KEY);
		assert.equal(st.state, "failed");
		assert.match(st.failure!, /篡改|不一致/);
		assert.equal(st.restore?.verified, false);
		// Missing blob is reported too.
		rmSync(blobs.path(sha("other")));
		await assert.rejects(w.svc.restore(w.ownerP, w.space, KEY, {}), (e: any) => e.status === 500);
		// A tampered manifest row is refused as well.
		w.t.app.ctx.db.run("UPDATE workspace_versions SET manifest = replace(manifest, 'a.txt', 'z.txt') WHERE space_id = ?", w.space.id);
		await assert.rejects(w.svc.restore(w.ownerP, w.space, KEY, {}), (e: any) => /清单校验失败/.test(e.message));
	} finally {
		await w.t.dispose();
	}
});

test("keepVersions prunes old versions but never the head or the restore source", async () => {
	const w = await world();
	try {
		await w.svc.setPolicy(w.ownerP, { keepVersions: 2 });
		for (let i = 1; i <= 4; i++) {
			w.write("a.txt", `v${i}`);
			await w.svc.commit(w.ownerP, w.space, KEY, "manual");
		}
		assert.deepEqual((await w.svc.versions(w.ownerP, w.space, KEY)).map((v) => v.version), [4, 3]);
		await w.svc.restore(w.ownerP, w.space, KEY, { version: 3 });
		w.write("a.txt", "v5");
		await w.svc.commit(w.ownerP, w.space, KEY, "manual");
		const vs = (await w.svc.versions(w.ownerP, w.space, KEY)).map((v) => v.version);
		assert.ok(vs.includes(5) && vs.includes(4) && vs.includes(3), vs.join(","));
	} finally {
		await w.t.dispose();
	}
});

test("cross-tenant and ACL: other org 404, viewer cannot write, versions need a space match", async () => {
	const w = await world();
	try {
		w.write("a.txt", "secret plan");
		const save = await w.call(w.owner, "POST", `${base(w)}/save`);
		assert.equal(save.status, 200, JSON.stringify(save.body));
		assert.equal(save.body.saved.version, 1);
		assert.equal((await w.call(w.owner, "GET", `${base(w)}/status`)).body.status.state, "saved");
		assert.equal((await w.call(w.owner, "GET", `${base(w)}/versions`)).body.versions.length, 1);

		for (const [m, path, body] of [["GET", "status"], ["POST", "save"], ["GET", "versions"], ["GET", "versions/1"], ["POST", "restore", { version: 1 }]] as const) {
			const r = await w.call(w.outsider, m, `${base(w)}/${path}`, body);
			assert.ok(r.status === 404 || r.status === 403, `${m} ${path} → ${r.status}`);
			assert.ok(!JSON.stringify(r.body).includes("secret plan"));
		}
		// Viewer (project viewer): read yes, write no.
		assert.equal((await w.call(w.member, "GET", `${base(w)}/status`)).status, 200);
		assert.equal((await w.call(w.member, "GET", `${base(w)}/versions`)).status, 200);
		assert.equal((await w.call(w.member, "POST", `${base(w)}/save`)).status, 403);
		assert.equal((await w.call(w.member, "POST", `${base(w)}/restore`, { version: 1 })).status, 403);
		// Service level: other org's principal with the real space object.
		const op = await w.p(w.outsider);
		await assert.rejects(w.svc.commit(op, w.space, KEY, "manual"), (e: any) => e.status === 404);
		await assert.rejects(w.svc.manifest(op, w.space, KEY, 1), (e: any) => e.status === 404);
		// Another personal space of the same org: the version number does not leak across spaces.
		const mySpace = w.t.app.ctx.services.get("identity").personalSpace(w.owner.me.userId, w.owner.me.orgId);
		await assert.rejects(w.svc.manifest(w.ownerP, mySpace, KEY, 1), (e: any) => e.status === 404 && e.code === "version_not_found");
		// Bad workspace keys are refused (no path injection).
		assert.equal((await w.call(w.owner, "GET", `/api/workspaces/${w.space.id}/..%2F..%2Fetc/status`)).status >= 400, true);
		assert.equal((await w.call(w.owner, "GET", `/api/workspaces/${w.space.id}/evil/status`)).status, 400);
	} finally {
		await w.t.dispose();
	}
});

test("HTTP restore: dirty is refused (409), keep-both works, save conflict/limit statuses", async () => {
	const w = await world();
	try {
		w.write("a.txt", "one");
		await w.call(w.owner, "POST", `${base(w)}/save`);
		w.write("a.txt", "two");
		const dirty = await w.call(w.owner, "POST", `${base(w)}/restore`, { version: 1 });
		assert.equal(dirty.status, 409);
		assert.equal(dirty.body.error.code, "workspace_dirty");
		assert.equal(readFileSync(join(w.wd, "a.txt"), "utf8"), "two");
		assert.equal((await w.call(w.owner, "POST", `${base(w)}/restore`, { version: "x" })).status, 400);
		assert.equal((await w.call(w.owner, "POST", `${base(w)}/restore`, { version: 1, force: "yes" })).status, 400);
		const kb = await w.call(w.owner, "POST", `${base(w)}/restore`, { version: 1, force: "keep-both" });
		assert.equal(kb.status, 200, JSON.stringify(kb.body));
		assert.equal(kb.body.restored.keptAsVersion, 2);
		assert.equal(readFileSync(join(w.wd, "a.txt"), "utf8"), "one");
		assert.equal((await w.call(w.owner, "POST", `${base(w)}/restore`, { version: 99 })).status, 404);
		await w.svc.setPolicy(w.ownerP, { maxFileBytes: 2 });
		const lim = await w.call(w.owner, "POST", `${base(w)}/save`);
		assert.equal(lim.status, 422);
		assert.equal(lim.body.status.state, "failed");
	} finally {
		await w.t.dispose();
	}
});

test("interrupted runs are reconciled to unknown, never re-run, and exposed", async () => {
	const w = await world();
	try {
		const db = w.t.app.ctx.db;
		const ins = (id: string, status: string, stderr: string) =>
			db.run("INSERT INTO tool_sandbox_runs (id, space_id, conversation_id, user_id, language, code, status, stderr, limits, started_at) VALUES (?, ?, 1, 'u', 'shell', 'sleep 999', ?, ?, '{}', ?)", id, w.space.id, status, stderr, new Date().toISOString());
		ins("run_a", "running", "");
		ins("run_b", "running", "partial output");
		ins("run_c", "ok", "");
		const r = w.svc.reconcileInterruptedRuns();
		assert.equal(r.count, 2);
		const row = (id: string) => db.get<{ status: string; stderr: string; finished_at: string | null }>("SELECT status, stderr, finished_at FROM tool_sandbox_runs WHERE id = ?", id)!;
		assert.equal(row("run_a").status, "unknown");
		assert.equal(row("run_a").stderr, RUN_RECONCILED_NOTE);
		assert.equal(row("run_b").stderr, `partial output\n${RUN_RECONCILED_NOTE}`);
		assert.ok(row("run_a").finished_at);
		assert.equal(row("run_c").status, "ok");
		assert.equal(w.svc.reconcileInterruptedRuns().count, 0, "idempotent");
		assert.deepEqual(w.svc.interruptedRuns(w.space.id).map((x) => x.runId).sort(), ["run_a", "run_b"]);
		assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tool_sandbox_runs WHERE status = 'running'")!.n, 0);
	} finally {
		await w.t.dispose();
	}
});

test("policy: defaults, validation, only sandbox.policy.manage holders, org-scoped", async () => {
	const w = await world();
	try {
		const get = await w.call(w.owner, "GET", "/api/workspace-policy");
		assert.equal(get.status, 200);
		assert.deepEqual(get.body.policy, get.body.defaults);
		assert.equal(get.body.policy.maxFileBytes, 50 * 1024 * 1024);
		assert.equal(get.body.policy.keepVersions, 20);
		assert.equal((await w.call(w.member, "GET", "/api/workspace-policy")).status, 403);
		assert.equal((await w.call(w.member, "PUT", "/api/workspace-policy", { keepVersions: 5 })).status, 403);
		const put = await w.call(w.owner, "PUT", "/api/workspace-policy", { keepVersions: 5, exclude: ["dist/", "*.log"] });
		assert.equal(put.status, 200, JSON.stringify(put.body));
		assert.equal(put.body.policy.keepVersions, 5);
		assert.equal(put.body.policy.maxFiles, 5000, "partial update keeps other fields");
		for (const bad of [{ keepVersions: 0 }, { maxFiles: 1.5 }, { exclude: ["../x"] }, { exclude: "x" }, { bogus: 1 }, { periodicSyncSec: 5 }, { maxFileBytes: 10 ** 12 }]) {
			assert.equal((await w.call(w.owner, "PUT", "/api/workspace-policy", bad)).status, 400, JSON.stringify(bad));
		}
		// Exclusion patterns take effect: dist/ and *.log are not saved, node_modules/ is no longer excluded (replaced list).
		w.write("dist/o.js", "x");
		w.write("app.log", "x");
		w.write("keep.txt", "x");
		w.write("node_modules/n.js", "x");
		await w.svc.commit(w.ownerP, w.space, KEY, "manual");
		assert.deepEqual((await w.svc.manifest(w.ownerP, w.space, KEY, 1)).map((e) => e.path), ["keep.txt", "node_modules/n.js"]);
		// Other org keeps defaults.
		const other = await w.call(w.outsider, "GET", "/api/workspace-policy");
		assert.equal(other.body.policy.keepVersions, 20);
	} finally {
		await w.t.dispose();
	}
});
