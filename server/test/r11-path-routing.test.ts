// Round 11 (R5): path-prefix routing of workspace files to persistent host-side stores (project/ per container project; round 14: the per-user
// memories/ store is gone, long-term memory is the Markdown /memory root and `memories/` is just an ordinary conversation folder),
// with ONE execution entry. Real app + SQLite for routing / ACL / persistence / snapshots / quota / local driver; the RemoteDriver with the in-memory
// TEST DOUBLE provider for the sync (up / down / conflict copy); a LIVE OpenSandbox case when WORKROOM_TEST_OPENSANDBOX_* is set. Run:
//   node --disable-warning=ExperimentalWarning --test --test-concurrency=1 server/test/r11-path-routing.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { AppDb } from "../src/core/db.ts";
import { DEFAULT_LIMITS, SANDBOX_MIGRATIONS, Sandbox } from "../src/tools/sandbox.ts";
import { RemoteDriver } from "../src/tools/sandbox/remote-driver.ts";
import { backupDataDir } from "../src/ops/backup.ts";
import { workspacePersistenceFor } from "../src/tools/sandbox/persist.ts";
import { renderSandboxSection } from "../src/tools/sandbox/prompt.ts";
import type { DriverRunSpec } from "../src/tools/sandbox/driver.ts";
import type { StoreMount } from "../src/tools/sandbox/stores.ts";
import { DockerDriver } from "../src/tools/sandbox/docker.ts";
import { SandboxDrivers } from "../src/tools/sandbox/registry.ts";
import type { DriverStatus, SandboxDriver } from "../src/tools/sandbox/driver.ts";
import { answer, call, fixedActor, toolHarness } from "./fixtures/tool-harness.ts";
import { createSandboxExtension } from "../src/tools/sandbox-tools.ts";
import { FakeRemoteProvider } from "./helpers/fake-remote-provider.ts";
import type { Principal, Space } from "../src/core/contracts.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const rejects = async (fn: () => unknown, status: number, code: string, msg?: RegExp) => {
	try {
		await fn();
	} catch (e: any) {
		assert.equal(e.status, status, `${code}: ${e.message}`);
		assert.equal(e.code, code, e.message);
		if (msg) assert.match(e.message, msg);
		return;
	}
	assert.fail(`expected ${status} ${code}`);
};

interface World {
	t: TestApp;
	sb: Sandbox;
	owner: { token: string; me: any; p: Principal; space: Space };
	m1: { token: string; me: any; p: Principal }; // holds a READ share of the project
	m2: { token: string; me: any; p: Principal }; // same org, no share
	out: { token: string; me: any; p: Principal; space: Space }; // another org
	project: { id: string };
	c1: number; // conversations of the project
	c2: number;
	c3: number; // not in a project
}
async function world(cfg: { secretKey?: string } = {}): Promise<World> {
	const t = await startTestApp(cfg.secretKey ? { config: { secretKey: cfg.secretKey } } : {});
	const id = t.app.ctx.services.get("identity");
	const reg = async (email: string, inv?: string) => {
		const u = await t.user(email, inv ? { inviteCode: inv } : {});
		return { ...u, p: (await id.principalFor(u.me.userId, u.me.orgId))! };
	};
	const owner0 = await reg("r5owner@a.example");
	const mk = async (email: string) => {
		const inv = await t.json("POST", "/api/admin/invites", { token: owner0.token, json: { role: "member" } });
		return reg(email, inv.invite.code);
	};
	const m1 = await mk("r5m1@a.example");
	const m2 = await mk("r5m2@a.example");
	const out0 = await reg("r5out@b.example");
	const project = (await t.json("POST", "/api/projects", { token: owner0.token, json: { name: "R5 项目" } })).project;
	await t.json("PUT", `/api/projects/${project.id}/shares/${m1.me.userId}`, { token: owner0.token, json: { permission: "read" } });
	const conv = async (body: Record<string, unknown> = {}) => (await t.json("POST", "/api/conversations", { token: owner0.token, json: body })).conversation.conversationId as number;
	const c1 = await conv({ projectId: project.id });
	const c2 = await conv({ projectId: project.id });
	const c3 = await conv({});
	return {
		t,
		sb: t.app.ctx.services.get("sandbox") as Sandbox,
		owner: { ...owner0, space: id.personalSpace(owner0.me.userId, owner0.me.orgId) },
		m1,
		m2,
		out: { ...out0, space: id.personalSpace(out0.me.userId, out0.me.orgId) },
		project,
		c1,
		c2,
		c3,
	};
}
const withEnv = async (k: string, v: string, fn: () => Promise<void>) => {
	const prev = process.env[k];
	process.env[k] = v;
	try {
		await fn();
	} finally {
		if (prev === undefined) delete process.env[k];
		else process.env[k] = prev;
	}
};

test("routing + ACL matrix: owner, read-share viewer, other member, other org, no principal", async () => {
	const w = await world();
	try {
		const { sb, owner, m1, m2, out } = w;
		const r = (p: Principal | undefined, conv: number, path: string, write = false, space: Space = owner.space) => () => sb.route(space, conv, path, p, write);

		// owner: the project store in a project conversation (read + write); round 14: `memories/` is no store any more
		assert.equal(sb.route(owner.space, w.c1, "memories/a.md", owner.p, true).store, "conversation", "memories/ is an ordinary conversation folder now");
		assert.deepEqual(pick(sb.route(owner.space, w.c1, "project/b/c.md", owner.p, true)), { store: "project", rel: "b/c.md", writable: true, prefix: "project" });
		assert.equal(sb.route(owner.space, w.c1, "notes/x.md", owner.p, true).store, "conversation");
		await rejects(r(owner.p, w.c3, "project/x.md"), 404, "no_project_store", /没有 project\//);
		assert.deepEqual(sb.stores.available(owner.p, owner.space, w.c1), ["project"]);
		assert.deepEqual(sb.stores.available(owner.p, owner.space, w.c3), []);

		// the store and the conversation are different host directories; the store is not inside the conversation directory
		const wd = sb.workdir(owner.space, w.c1);
		const prj = sb.route(owner.space, w.c1, "project", owner.p);
		assert.ok(!prj.root.startsWith(wd), `${prj.root} is outside ${wd}`);
		assert.ok(prj.root.startsWith(t_dir(w)), "stores live under the server data dir");

		// read-share viewer of the project (another member of the org): project is READ-only
		assert.deepEqual(pick(sb.route(owner.space, w.c1, "project/b/c.md", m1.p)), { store: "project", rel: "b/c.md", writable: false, prefix: "project" });
		await rejects(r(m1.p, w.c1, "project/b/c.md", true), 403, "project_readonly", /只读/);
		assert.deepEqual(sb.stores.available(m1.p, owner.space, w.c1), ["project"]);
		await rejects(r(m1.p, w.c3, "project/x.md"), 404, "no_project_store"); // a conversation outside the project: no project folder, share or not
		// a share does not cross into another project's conversation
		assert.equal(sb.stores.available(m1.p, owner.space, w.c3).length, 0);

		// other member without a share, and another org: nothing
		for (const who of [m2.p, out.p]) {
			await rejects(r(who, w.c1, "project/b/c.md"), 404, "no_project_store");
			assert.deepEqual(sb.stores.available(who, owner.space, w.c1), []);
			const listed = sb.workspace(owner.space, w.c1, who).entries.map((e) => e.path);
			assert.ok(!listed.some((p) => p.startsWith("memories") || p.startsWith("project")), `no store entries for ${who.userId}`);
		}
		// no principal: a store path is refused, never written into the conversation directory
		await rejects(r(undefined, w.c1, "project/a.md", true), 404, "no_project_store");
		assert.equal(sb.route(owner.space, w.c1, "plain.txt", undefined, true).store, "conversation");

		// the owner's data really is invisible to the viewer: write, then try to read it as everybody else
		sb.writeFile(owner.space, w.c1, "project/shared.md", enc("shared"), owner.p);
		assert.equal(dec(sb.readFile(owner.space, w.c1, "project/shared.md", m1.p).bytes), "shared", "a read share can read project/");
		await rejects(() => sb.readFile(owner.space, w.c1, "project/shared.md", m2.p), 404, "no_project_store");
		await rejects(() => sb.writeFile(owner.space, w.c1, "project/hack.md", enc("x"), m1.p), 403, "project_readonly");
		await rejects(() => sb.remove(owner.space, w.c1, "project/shared.md", m1.p), 403, "project_readonly");
		await rejects(() => sb.move(owner.space, w.c1, "project/shared.md", "project/s2.md", m1.p), 403, "project_readonly");
		await rejects(() => sb.mkdir(owner.space, w.c1, "project/d", m1.p), 403, "project_readonly");
		assert.equal(existsSync(join(sb.route(owner.space, w.c1, "project", owner.p).root, "hack.md")), false);

		// revoking the share takes the project folder away immediately
		await w.t.json("DELETE", `/api/projects/${w.project.id}/shares/${m1.me.userId}`, { token: owner.token });
		await rejects(r(m1.p, w.c1, "project/shared.md"), 404, "no_project_store");
		// moving the conversation out of the project: the folder is gone for the owner too (the files stay in the project)
		await w.t.json("PUT", `/api/conversations/${owner.space.id}/${w.c2}/project`, { token: owner.token, json: { projectId: null } });
		await rejects(r(owner.p, w.c2, "project/shared.md"), 404, "no_project_store");
		assert.equal(dec(sb.readFile(owner.space, w.c1, "project/shared.md", owner.p).bytes), "shared");
	} finally {
		await w.t.dispose();
	}
});
const pick = (r: { store: string; rel: string; writable: boolean; prefix: string }) => ({ store: r.store, rel: r.rel, writable: r.writable, prefix: r.prefix });
const t_dir = (w: World) => join(w.t.dataDir, "orgs");

test("legacy project space: no project/ store (only container projects have it); memories/ is an ordinary folder of the conversation", async () => {
	const w = await world();
	try {
		const { t, sb, owner, m1 } = w;
		const lp = (await t.json("POST", "/api/projects", { token: owner.token, json: { kind: "space", name: "旧版项目" } })).project;
		await t.json("PUT", `/api/projects/${lp.id}/members`, { token: owner.token, json: { email: "r5m1@a.example", role: "editor" } });
		const m2 = w.m2;
		await t.json("PUT", `/api/projects/${lp.id}/members`, { token: owner.token, json: { email: "r5m2@a.example", role: "viewer" } });
		const space = t.app.ctx.services.get("identity").projectSpace(lp.id)!;
		const cid = (await t.json("POST", "/api/conversations", { token: owner.token, json: { projectId: lp.id } })).conversation.conversationId as number;
		// round 14: no per-person store; a folder named memories/ belongs to the (shared) conversation like any other
		sb.writeFile(space, cid, "memories/who.txt", enc("shared-conv-file"), owner.p);
		assert.equal(dec(sb.readFile(space, cid, "memories/who.txt", m1.p).bytes), "shared-conv-file");
		assert.equal(existsSync(join(sb.workdir(space, cid), "memories", "who.txt")), true);
		void m2;
		for (const p of [owner.p, m1.p]) await rejects(() => sb.route(space, cid, "project/x", p), 404, "no_project_store");
	} finally {
		await w.t.dispose();
	}
});

test("persistence across conversations over HTTP: project/ follows the project; nothing leaks to a conversation outside it; memories/ is conversation-local", async () => {
	const w = await world();
	try {
		const { t, owner, m1, m2 } = w;
		const url = (conv: number, path: string, extra = "") => `/api/sandbox/${owner.space.id}/${path}${path.includes("?") ? "&" : "?"}conversationId=${conv}${extra}`;
		const put = (tok: string, conv: number, p: string, body: string) => t.req("PUT", url(conv, `file?path=${encodeURIComponent(p)}`), { token: tok, body });
		assert.equal((await put(owner.token, w.c1, "memories/a.md", "# note one")).status, 200); // an ordinary conversation folder now
		assert.equal((await put(owner.token, w.c1, "project/plan/p.md", "plan")).status, 200);
		assert.equal((await put(owner.token, w.c1, "local.txt", "only in c1")).status, 200);

		const list = async (conv: number, token = owner.token) => (await t.json("GET", url(conv, "files"), { token })).entries as { path: string; kind: string; expiresAt?: string }[];
		// conversation 2 (same project): both folders and their files; its own files are separate
		const l2 = (await list(w.c2)).map((e) => e.path);
		assert.ok(l2.includes("project") && l2.includes("project/plan/p.md"));
		assert.ok(!l2.includes("local.txt"), "conversation files stay conversation-scoped");
		assert.ok(!l2.includes("memories/a.md"), "memories/ is conversation-local now, not a per-user store");
		assert.equal((await list(w.c2)).find((e) => e.path === "project/plan/p.md")!.expiresAt, undefined, "persistent files do not expire");
		assert.equal((await t.json("GET", url(w.c2, "preview?path=project/plan/p.md"), { token: owner.token })).preview.text, "plan");

		// conversation 3 (no project): no project/ ; it is absent and refused
		const l3 = (await list(w.c3)).map((e) => e.path);
		assert.ok(!l3.some((p) => p.startsWith("project")));
		assert.equal((await t.req("GET", url(w.c3, "file?path=project/plan/p.md"), { token: owner.token })).status, 404);
		assert.equal((await put(owner.token, w.c3, "project/x.md", "no")).status, 404);
		assert.equal(readdirSync(w.sb.workdir(owner.space, w.c3)).includes("project"), false, "a refused write never lands in the conversation directory");

		// mkdir / move / delete go through the same router
		await t.json("POST", `/api/sandbox/${owner.space.id}/mkdir`, { token: owner.token, json: { conversationId: w.c2, path: "project/topics/ai" } });
		assert.deepEqual(await t.json("POST", `/api/sandbox/${owner.space.id}/move`, { token: owner.token, json: { conversationId: w.c1, from: "project/plan/p.md", to: "project/topics/ai/a.md" } }), { from: "project/plan/p.md", to: "project/topics/ai/a.md" });
		// across stores a single file is copied then removed; folders are refused; the store folders themselves cannot be removed or renamed
		assert.deepEqual(await t.json("POST", `/api/sandbox/${owner.space.id}/move`, { token: owner.token, json: { conversationId: w.c1, from: "local.txt", to: "project/local.txt" } }), { from: "local.txt", to: "project/local.txt" });
		assert.equal(existsSync(join(w.sb.workdir(owner.space, w.c1), "local.txt")), false);
		assert.equal(await (await t.req("GET", url(w.c2, "file?path=project/local.txt"), { token: owner.token })).text(), "only in c1");
		await t.json("POST", `/api/sandbox/${owner.space.id}/move`, { token: owner.token, json: { conversationId: w.c1, from: "project/plan", to: "plan" }, expect: 400 });
		await t.json("DELETE", url(w.c1, "file?path=project"), { token: owner.token, expect: 400 });
		assert.equal((await t.json("DELETE", url(w.c2, "file?path=project/topics/ai/a.md"), { token: owner.token })).removed, "project/topics/ai/a.md");
		assert.ok(!(await list(w.c1)).some((e) => e.path === "project/topics/ai/a.md"));

		// publish from a store
		const pub = await t.json("POST", `/api/sandbox/${owner.space.id}/publish`, { token: owner.token, json: { conversationId: w.c2, path: "project/local.txt" } });
		assert.equal(pub.version.name, "local.txt");

		// everyone else: 403 at the space ACL, and the router refuses them too (matrix test above)
		for (const who of [m1, m2, w.out]) assert.equal((await t.req("GET", url(w.c1, "files"), { token: who.token })).status, 403);
		// a second user's conversation has none of the owner's files
		const m1space = t.app.ctx.services.get("identity").personalSpace(m1.me.userId, m1.me.orgId);
		const m1conv = (await t.json("POST", "/api/conversations", { token: m1.token, json: {} })).conversation.conversationId as number;
		assert.equal((await t.req("GET", `/api/sandbox/${m1space.id}/file?path=project/topics/ai/a.md&conversationId=${m1conv}`, { token: m1.token })).status, 404);
		void m2;
	} finally {
		await w.t.dispose();
	}
});

test("a conversation's version history never contains project/ (also not when a conversation kept its own folder of that name)", async () => {
	const w = await world();
	try {
		const { t, sb, owner } = w;
		sb.writeFile(owner.space, w.c1, "report.md", enc("conversation file"), owner.p);
		sb.writeFile(owner.space, w.c1, "project/p.md", enc("ours"), owner.p);
		// a legacy conversation that created its own project/ folder before the store existed
		mkdirSync(join(sb.workdir(owner.space, w.c1), "project"), { recursive: true });
		writeFileSync(join(sb.workdir(owner.space, w.c1), "project", "legacy.txt"), "old");
		const persist = workspacePersistenceFor(t.app.ctx);
		const res = await persist.commit(owner.p, owner.space, `c${w.c1}`, "manual");
		assert.equal(res.ok, true, JSON.stringify(res.status));
		const v = await t.json("GET", `/api/workspaces/${owner.space.id}/c${w.c1}/versions/${res.version}`, { token: owner.token });
		assert.deepEqual(v.manifest.map((e: any) => e.path), ["report.md"], "only the conversation's own file is versioned");
		// the legacy file is hidden from the listing and says so on the next run instead of vanishing silently
		const listed = sb.workspace(owner.space, w.c1, owner.p).entries.map((e) => e.path);
		assert.ok(!listed.includes("project/legacy.txt"));
		assert.ok(existsSync(join(sb.workdir(owner.space, w.c1), "project", "legacy.txt")), "kept on disk");
		// restoring an older version leaves the stores alone
		rmRf(join(sb.workdir(owner.space, w.c1), "report.md"));
		await persist.restore(owner.p, owner.space, `c${w.c1}`, { version: res.version!, force: "keep-both" }).catch(() => {});
		assert.equal(dec(sb.readFile(owner.space, w.c2, "project/p.md", owner.p).bytes), "ours");
	} finally {
		await w.t.dispose();
	}
});
import { rmSync } from "node:fs";
const rmRf = (p: string) => rmSync(p, { recursive: true, force: true });

test("store quota: a clear Chinese error per store, overwrites count only the difference, and a full store is mounted read-only with a note", async () => {
	const w = await world();
	try {
		const { sb, owner } = w;
		await withEnv("WORKROOM_SANDBOX_STORE_QUOTA_MB", "0.01", async () => {
			// 0.01 MB = 10485 bytes
			sb.writeFile(owner.space, w.c1, "project/a.bin", new Uint8Array(6000), owner.p);
			await rejects(() => sb.writeFile(owner.space, w.c1, "project/b.bin", new Uint8Array(6000), owner.p), 507, "store_quota", /项目目录（project\/）已满.*上限/);
			sb.writeFile(owner.space, w.c1, "project/a.bin", new Uint8Array(9000), owner.p); // overwrite: only the difference counts
			// the conversation workspace has its own (space) quota and is unaffected
			sb.writeFile(owner.space, w.c1, "big.bin", new Uint8Array(50_000), owner.p);
			// a store over its cap: the run gets it read-only and is told
			const notes: string[] = [];
			sb.writeFile(owner.space, w.c1, "project/a.bin", new Uint8Array(10_000), owner.p);
			writeFileSync(join(sb.route(owner.space, w.c1, "project", owner.p).root, "grown.bin"), new Uint8Array(5000)); // pushed over the cap by something outside the API
			const ms = sb.stores.mounts(owner.p, owner.space, w.c1, notes);
			assert.equal(ms.find((m) => m.name === "project")!.readOnly, true);
			assert.match(notes.join("\n"), /项目目录（project\/）已用 .*，超过上限 .*：本次以只读方式提供/);
		});
	} finally {
		await w.t.dispose();
	}
});

test("a data-dir backup includes the persistent stores (they are user data) but not the per-conversation sandbox directories", async () => {
	const w = await world();
	try {
		const { sb, owner } = w;
		// personal Markdown memory lives in the (former) memories store directory and is part of the data dir backup too
		const memDir = join(w.t.dataDir, "orgs", owner.space.orgId, "stores", "memories", owner.me.userId);
		mkdirSync(memDir, { recursive: true });
		writeFileSync(join(memDir, "keep.md"), "keep me");
		sb.writeFile(owner.space, w.c1, "project/keep.md", enc("keep me too"), owner.p);
		sb.writeFile(owner.space, w.c1, "conv-only.txt", enc("scratch"), owner.p);
		const dest = join(mkdtempSync(join(tmpdir(), "wr-r5-bak-")), "b");
		const m = await backupDataDir(w.t.dataDir, dest);
		const paths = m.files.map((f) => f.path);
		assert.ok(paths.some((p) => /\/stores\/memories\/[^/]+\/keep\.md$/.test(p)), paths.join("\n"));
		assert.ok(paths.some((p) => /\/stores\/project\/[^/]+\/keep\.md$/.test(p)));
		assert.ok(!paths.some((p) => p.endsWith("conv-only.txt")), "conversation working copies are not part of a default backup");
	} finally {
		await w.t.dispose();
	}
});

test("agent file tools: memories/ is an ordinary conversation folder; project/ is refused outside a project (never lands in the conversation directory)", async () => {
	const w = await world();
	try {
		const { t, sb, owner } = w;
		const h = await toolHarness([createSandboxExtension(t.app.ctx, { resolveActor: fixedActor(t.app.ctx, owner.me.userId, owner.me.orgId, owner.space.id) })], [
			call("sandbox_write_file", { path: "memories/prefs.md", content: "likes tea" }, "t1"),
			call("sandbox_write_file", { path: "/work/memories/abs.md", content: "abs path" }, "t2"),
			call("sandbox_list", {}, "t3"),
			call("sandbox_read_file", { path: "memories/prefs.md" }, "t4"),
			call("sandbox_write_file", { path: "project/x.md", content: "no project here" }, "t5"),
			answer("done"),
		]);
		try {
			await h.run("remember this");
			const res = await h.results();
			assert.equal(res[0]!.isError, false, res[0]!.text);
			assert.match(res[0]!.text, /已写入 \/work\/memories\/prefs\.md/);
			assert.match(res[1]!.text, /已写入 \/work\/memories\/abs\.md/);
			assert.match(res[2]!.text, /memories/);
			assert.equal(res[3]!.text, "likes tea");
			assert.equal(res[4]!.isError, true);
			assert.match(res[4]!.text, /没有 project\//);
			const convDir = sb.workdir(owner.space, 1);
			assert.equal(readFileSync(join(convDir, "memories", "prefs.md"), "utf8"), "likes tea");
			assert.equal(existsSync(join(convDir, "project")), false);
		} finally {
			await h.close();
		}
	} finally {
		await w.t.dispose();
	}
});

test("the sandbox prompt mentions project/ only when the conversation is in a project (no memories/ line any more)", async () => {
	const base = { kind: "local" as const, label: "平台内置沙箱（Docker）", workDir: "/work", skillsRoot: "/skills", usable: true };
	const none = renderSandboxSection(base);
	assert.doesNotMatch(none, /memories|project\//);
	const both = renderSandboxSection({ ...base, stores: ["project"] });
	assert.match(both, /project\/ 是本项目所有会话共享的目录/);
	assert.doesNotMatch(both, /memories/);
	assert.equal(renderSandboxSection({ ...base, stores: ["project"] }), both, "pure function of its input (prompt caches stay warm)");
	// through the real section: the owner of a project conversation sees project/, a conversation outside the project nothing
	const w = await world();
	try {
		const { sb, owner } = w;
		assert.deepEqual(sb.stores.available(owner.p, owner.space, w.c1), ["project"]);
		assert.deepEqual(sb.stores.available(owner.p, owner.space, w.c3), []);
	} finally {
		await w.t.dispose();
	}
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Local driver: ONE tree inside the sandbox, the stores bind-mounted below /work
// ---------------------------------------------------------------------------------------------------------------------------------
test("local driver: the sandbox sees project/ inside /work; writes land in the store, not in the conversation directory; read-only when full", async (tc) => {
	const w = await world();
	try {
		const { sb, owner } = w;
		if ((await sb.drivers.resolve()).effective === "none") return tc.skip("no local sandbox driver on this machine");
		sb.writeFile(owner.space, w.c1, "project/p.md", enc("from project"), owner.p);
		sb.writeFile(owner.space, w.c1, "conv.txt", enc("conv"), owner.p);
		const run = (conv: number, code: string) => sb.run({ principal: owner.p, space: owner.space, conversationId: conv, language: "shell", code });
		const r1 = await run(w.c2, "cat project/p.md; echo; ls /work; mkdir -p project/out && echo p2 > project/out/q.txt");
		assert.equal(r1.exitCode, 0, r1.stderr);
		assert.match(r1.stdout, /from project/);
		assert.doesNotMatch(r1.stdout, /conv\.txt/, "conversation 2 does not see conversation 1's own files (single tree, per conversation)");
		assert.equal(readFileSync(join(sb.route(owner.space, w.c2, "project", owner.p).root, "out", "q.txt"), "utf8").trim(), "p2");
		// visible from the very next conversation, and through the file API
		assert.equal(dec(sb.readFile(owner.space, w.c1, "project/out/q.txt", owner.p).bytes).trim(), "p2");
		assert.equal((await run(w.c1, "cat project/out/q.txt")).stdout.trim(), "p2");
		// nothing of the store was written into the conversation directory (only an empty mount point may exist there)
		for (const n of ["project"]) {
			const d = join(sb.workdir(owner.space, w.c2), n);
			assert.ok(!existsSync(d) || readdirSync(d).length === 0, `${n} mount point in the conversation dir is empty`);
		}
		// a conversation outside the project has no project/ in the sandbox
		const r3 = await run(w.c3, "ls /work; test -e project && echo HAS-PROJECT || echo no-project");
		assert.match(r3.stdout, /no-project/);
		// full store → read-only mount + a note, the run itself still works
		await withEnv("WORKROOM_SANDBOX_STORE_QUOTA_MB", "0.001", async () => {
			writeFileSync(join(sb.route(owner.space, w.c2, "project", owner.p).root, "fill.bin"), new Uint8Array(3000)); // over the ~1 KB cap
			const r4 = await run(w.c2, "cat project/p.md; echo; (echo no > project/c.md) 2>&1 || echo write-refused; echo ok-conv > conv-ok.txt");
			assert.match(r4.stdout, /from project/);
			assert.match(r4.stdout, /write-refused|Read-only/i);
			assert.match(r4.stderr, /项目目录（project\/）已用 .*本次以只读方式提供/);
			assert.equal(existsSync(join(sb.route(owner.space, w.c2, "project", owner.p).root, "c.md")), false);
		});
		// the history of the conversation does not hold the stores
		const v = await workspacePersistenceFor(w.t.app.ctx).commit(owner.p, owner.space, `c${w.c2}`, "manual");
		const manifest = (await w.t.json("GET", `/api/workspaces/${owner.space.id}/c${w.c2}/versions/${v.version}`, { token: owner.token })).manifest.map((e: any) => e.path);
		assert.ok(!manifest.some((p: string) => /^project\//.test(p)), manifest.join(","));
	} finally {
		await w.t.dispose();
	}
});

test("docker driver (real Docker daemon, small public images): the same single tree; project/ read-only; writes by the container user land in the stores", { timeout: 240_000 }, async (tc) => {
	if (process.env.WORKROOM_TEST_DOCKER === "0") return tc.skip("WORKROOM_TEST_DOCKER=0");
	const probe = new DockerDriver();
	const st = await probe.detect(true);
	const facts = probe.facts();
	if (st.state === "unavailable" || !facts?.images.python) return tc.skip("no usable Docker daemon / python:3.12-slim image on this machine");
	const w = await world();
	try {
		const { owner } = w;
		const noNs: SandboxDriver = {
			id: "namespaces", label: "Linux 命名空间", capabilities: { network: false, services: true, mounts: true, cgroupLimits: false, hostRuntimes: true }, notes: { isolates: [], doesNotIsolate: [] },
			detect: async (): Promise<DriverStatus> => ({ id: "namespaces", state: "unavailable", summary: "simulated Windows/macOS host", details: [], checkedAt: "" }),
			run: async () => { throw new Error("unused"); }, startService: async () => { throw new Error("unused"); }, reapStale: async () => 0, killStale: async () => false,
		};
		const sb = new Sandbox(w.t.app.ctx, { drivers: new SandboxDrivers(w.t.app.ctx, { namespaces: noNs }) });
		sb.drivers.update(owner.p, { driver: "docker", docker: { image: "workroom/sandbox:not-used-in-this-test" } });
		assert.equal((await sb.capabilities()).driver, "docker");
		sb.writeFile(owner.space, w.c1, "project/p.md", enc("docker project"), owner.p);
		const r = await sb.run({ principal: owner.p, space: owner.space, conversationId: w.c2, language: "python", code: `import os
print(open("project/p.md").read(), sorted(os.listdir("/work")))
open("project/from-docker.md", "w").write("written by the container user")
os.makedirs("project/sub", exist_ok=True)
open("project/sub/q.txt", "w").write("p")
open("plain.txt", "w").write("conversation")
` });
		assert.equal(r.status, "ok", r.stderr);
		assert.match(r.stdout, /docker project \['project'/);
		assert.equal(readFileSync(join(sb.route(owner.space, w.c2, "project", owner.p).root, "from-docker.md"), "utf8"), "written by the container user");
		assert.equal(readFileSync(join(sb.route(owner.space, w.c2, "project", owner.p).root, "sub", "q.txt"), "utf8"), "p");
		assert.equal(dec(sb.readFile(owner.space, w.c2, "plain.txt", owner.p).bytes), "conversation");
		assert.equal(dec(sb.readFile(owner.space, w.c1, "project/from-docker.md", owner.p).bytes), "written by the container user", "visible from the other conversation");
		// full store → kernel read-only mount
		await withEnv("WORKROOM_SANDBOX_STORE_QUOTA_MB", "0.001", async () => {
			writeFileSync(join(sb.route(owner.space, w.c2, "project", owner.p).root, "fill.bin"), new Uint8Array(3000));
			const ro = await sb.run({ principal: owner.p, space: owner.space, conversationId: w.c2, language: "python", code: 'try:\n    open("project/x.md", "w").write("x"); print("WROTE")\nexcept OSError as e:\n    print("refused", e.errno)\nprint(open("project/p.md").read())' });
			assert.match(ro.stdout, /refused 30/);
			assert.match(ro.stderr, /以只读方式提供/);
		});
	} finally {
		await w.t.dispose();
	}
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Remote drivers: the store is uploaded into <workdir>/project and synced back into ITS host store (test double provider)
// ---------------------------------------------------------------------------------------------------------------------------------
function remoteSetup() {
	const root = mkdtempSync(join(tmpdir(), "wr-r5-"));
	const db = new AppDb(":memory:");
	db.migrate("sandbox-test", SANDBOX_MIGRATIONS);
	const provider = new FakeRemoteProvider();
	const driver = new RemoteDriver({ db, provider, orgId: "org1" });
	const dir = (n: string) => {
		const d = join(root, n);
		mkdirSync(d, { recursive: true });
		return d;
	};
	const prj = dir("stores/project/p1");
	const wds = { c1: dir("sandbox/c1"), c2: dir("sandbox/c2") };
	let n = 0;
	const store = (name: "project", hostPath: string, o: Partial<StoreMount> = {}): StoreMount => ({ name, hostPath, readOnly: false, ownerKey: "project:p1:rw", quotaBytes: 1 << 30, usedBytes: 0, ...o });
	const spec = (conv: "c1" | "c2", code: string, stores: StoreMount[], o: Partial<DriverRunSpec> = {}): DriverRunSpec => ({
		runId: `run_${++n}_${Math.random().toString(36).slice(2, 6)}`,
		tenant: { orgId: "org1", spaceId: "s1", workspaceKey: conv },
		scratchBase: join(root, "sandbox"),
		workdir: wds[conv],
		exec: { language: "python", code },
		limits: { ...DEFAULT_LIMITS, timeoutMs: 5000 },
		mounts: [],
		stores,
		env: {},
		network: false,
		...o,
	});
	return { root, db, provider, driver, prj, wds, store, spec, manifest: (key: string) => JSON.parse(db.get<{ manifest: string }>("SELECT manifest FROM tool_sandbox_instances WHERE workspace_key = ?", key)!.manifest) as Record<string, string> };
}

test("remote sync: the store goes up into <workdir>/project, remote changes go back into the STORE (never the conversation dir), second conversation sees them", async () => {
	const t = remoteSetup();
	mkdirSync(join(t.prj, "docs"));
	writeFileSync(join(t.prj, "docs", "spec.md"), "spec");
	writeFileSync(join(t.prj, "seed.md"), "seed note");
	writeFileSync(join(t.wds.c1, "conv.txt"), "conv only");
	const stores = [t.store("project", t.prj)];

	const r1 = await t.driver.run(t.spec("c1", "cat project/seed.md\ncat project/docs/spec.md\nwrite project/new.md remote-note\nwrite project/docs/more.md more\nwrite plain.txt plain", stores));
	assert.equal(r1.exitCode, 0, r1.stderr);
	assert.match(r1.stdout, /seed note/);
	assert.match(r1.stdout, /spec/);
	assert.equal(readFileSync(join(t.prj, "new.md"), "utf8"), "remote-note");
	assert.equal(readFileSync(join(t.prj, "docs", "more.md"), "utf8"), "more");
	assert.equal(readFileSync(join(t.wds.c1, "plain.txt"), "utf8"), "plain");
	assert.equal(existsSync(join(t.wds.c1, "project")), false, "a store is never written into the conversation directory");
	assert.equal(existsSync(join(t.prj, "plain.txt")), false);
	const m = t.manifest("c1");
	assert.ok(m["project/seed.md"] && m["project/new.md"] && m["project/docs/spec.md"] && m["conv.txt"] && m["plain.txt"]);
	assert.equal(m["@store:project"], "project:p1:rw");

	// a different conversation (its own sandbox) is seeded with what conversation 1 saved
	const r2 = await t.driver.run(t.spec("c2", "cat project/new.md\ncat project/docs/more.md\ncat conv.txt", stores));
	assert.match(r2.stdout, /remote-note/);
	assert.match(r2.stdout, /more/);
	assert.match(r2.stdout, /<missing>/, "conversation 2 does not see conversation 1's own file");
	// uploads happen once: a second run with unchanged stores uploads nothing
	const box1 = [...t.provider.boxes.values()][0]!;
	const before = box1.writes.filter((p) => p.startsWith("/work/project/")).length;
	await t.driver.run(t.spec("c1", "echo again", stores));
	assert.equal(box1.writes.filter((p) => p.startsWith("/work/project/")).length, before);
	// host-side edit of a store file (API, another conversation) reaches the sandbox on the next run; a delete on the host deletes it remotely
	writeFileSync(join(t.prj, "seed.md"), "seed v2");
	rmRf(join(t.prj, "new.md"));
	const r3 = await t.driver.run(t.spec("c1", "cat project/seed.md\ncat project/new.md", stores));
	assert.match(r3.stdout, /seed v2/);
	assert.match(r3.stdout, /<missing>/);
	// deleting in the sandbox deletes the store file (it was synced before and the host copy is unchanged)
	await t.driver.run(t.spec("c1", "rm project/seed.md", stores));
	assert.equal(existsSync(join(t.prj, "seed.md")), false);
});

test("remote sync: concurrent writers of the same project file keep both versions (conflict copy + a note); nothing is silently lost", async () => {
	const t = remoteSetup();
	writeFileSync(join(t.prj, "shared.md"), "v0");
	const stores = () => [t.store("project", t.prj)];
	await t.driver.run(t.spec("c1", "cat project/shared.md", stores())); // both sandboxes know v0
	await t.driver.run(t.spec("c2", "cat project/shared.md", stores()));
	// conversation 1 edits the file in its sandbox and keeps running; meanwhile conversation 2 saves a different version into the store
	const slow = t.driver.run(t.spec("c1", "write project/shared.md from-c1\nsleep 400", stores()));
	await new Promise((r) => setTimeout(r, 150));
	const fast = await t.driver.run(t.spec("c2", "write project/shared.md from-c2", stores()));
	assert.equal(fast.exitCode, 0, fast.stderr);
	assert.equal(readFileSync(join(t.prj, "shared.md"), "utf8"), "from-c2");
	const r = await slow;
	assert.equal(r.exitCode, 0, r.stderr);
	const copies = readdirSync(t.prj).filter((f) => /^shared\.conflict-\d{8}-\d{6}\.md$/.test(f));
	assert.equal(copies.length, 1, readdirSync(t.prj).join(","));
	assert.equal(readFileSync(join(t.prj, copies[0]!), "utf8"), "from-c1", "the sandbox's version is kept next to the file");
	assert.equal(readFileSync(join(t.prj, "shared.md"), "utf8"), "from-c2", "the file keeps the version that reached the store first");
	assert.match(r.stderr, new RegExp(`project/shared\\.md 在别处（另一个会话）也被修改过：这次沙箱里的版本另存为 project/${copies[0]!.replace(/\./g, "\\.")}`));
	// the conflict copy travels like any file: the next run of conversation 1 has it, and the original is the store's version again
	const again = await t.driver.run(t.spec("c1", `cat project/shared.md\ncat project/${copies[0]}`, stores()));
	assert.match(again.stdout, /from-c2/);
	assert.match(again.stdout, /from-c1/);
	// two conflicts in the same second do not overwrite each other
	const slow2 = t.driver.run(t.spec("c1", "write project/shared.md c1-b\nsleep 300", stores()));
	await new Promise((r2) => setTimeout(r2, 120));
	await t.driver.run(t.spec("c2", "write project/shared.md c2-b", stores()));
	await slow2;
	assert.ok(readdirSync(t.prj).filter((f) => f.includes(".conflict-")).length >= 2);
});

test("remote sync: read-only project is uploaded, never synced back (note), another person / access change re-seeds the folder, a revoked store disappears from the sandbox, over-cap files are refused", async () => {
	const t = remoteSetup();
	writeFileSync(join(t.prj, "ro.md"), "project text");
	const ro = [t.store("project", t.prj, { readOnly: true, ownerKey: "project:p1:ro" })];
	const r1 = await t.driver.run(t.spec("c1", "cat project/ro.md\nwrite project/ro.md hacked\nwrite project/new.md new", ro));
	assert.match(r1.stdout, /project text/);
	assert.equal(readFileSync(join(t.prj, "ro.md"), "utf8"), "project text", "a read-only store is never written");
	assert.equal(existsSync(join(t.prj, "new.md")), false);

	// somebody with write access later: the folder is re-seeded (clean start), and now writes are synced
	const rw = [t.store("project", t.prj)];
	const r2 = await t.driver.run(t.spec("c1", "cat project/ro.md\nwrite project/new.md new", rw));
	assert.match(r2.stdout, /project text/);
	assert.equal(readFileSync(join(t.prj, "new.md"), "utf8"), "new");

	// the folder of one project, then another project in the same sandbox: the second never sees the first one's files
	await t.driver.run(t.spec("c2", "cat project/ro.md", rw));
	const prj2 = join(t.root, "stores", "project", "p2");
	mkdirSync(prj2, { recursive: true });
	const b = [t.store("project", prj2, { ownerKey: "project:p2:rw" })];
	const rb = await t.driver.run(t.spec("c2", "cat project/ro.md\nwrite project/b.md b-note", b));
	assert.match(rb.stdout, /<missing>/, "the other project's sandbox folder was wiped before seeding");
	assert.equal(readFileSync(join(prj2, "b.md"), "utf8"), "b-note");
	assert.equal(existsSync(join(t.prj, "b.md")), false, "its file did not go to the first project's store");
	// access revoked: the run has no stores at all → the folder is removed from the sandbox, and files written there are not saved (note)
	const rn = await t.driver.run(t.spec("c2", "cat project/b.md\nwrite project/sneaky.md x", []));
	assert.match(rn.stdout, /<missing>/);
	assert.match(rn.stderr, /project\/ 在这次运行中没有对应的持久目录/);
	assert.equal(existsSync(join(prj2, "sneaky.md")), false);
	assert.equal(existsSync(join(t.wds.c2, "project")), false);

	// size cap of a store: a remote write beyond it is refused with a Chinese note, the rest of the run is unaffected
	const capped = [t.store("project", t.prj, { quotaBytes: 2000 })];
	const rc = await t.driver.run(t.spec("c1", "big project/huge.bin 5000\nwrite project/small.md ok", capped));
	assert.equal(existsSync(join(t.prj, "huge.bin")), false);
	assert.match(rc.stderr, /项目目录（project\/）已满（上限 .*），未保存：project\/huge\.bin/);
	assert.equal(readFileSync(join(t.prj, "small.md"), "utf8"), "ok");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// LIVE OpenSandbox (self-hosted): the stores through the app and a real remote sandbox
// ---------------------------------------------------------------------------------------------------------------------------------
const LIVE_URL = process.env.WORKROOM_TEST_OPENSANDBOX_URL;
const LIVE_KEY = process.env.WORKROOM_TEST_OPENSANDBOX_KEY;
test("LIVE OpenSandbox: project/ written in one conversation is read in another; a concurrent host edit becomes a conflict copy", { skip: LIVE_URL && LIVE_KEY ? undefined : "LIVE: WORKROOM_TEST_OPENSANDBOX_URL / _KEY not set", timeout: 600_000 }, async () => {
	const prevAllow = process.env.WORKROOM_WEBHOOK_ALLOWLIST;
	process.env.WORKROOM_WEBHOOK_ALLOWLIST = new URL(LIVE_URL!).hostname;
	const w = await world({ secretKey: "test-master-key-for-live-e2e-only-0123456789" });
	try {
		const { t, sb, owner } = w;
		await t.json("PUT", "/api/sandbox/providers/opensandbox", { token: owner.token, json: { enabled: true, endpoint: LIVE_URL, apiKey: LIVE_KEY, allowPrivateNetwork: true, egressAcknowledged: true } });
		await t.json("PUT", "/api/sandbox/provider-policy", { token: owner.token, json: { orgDefault: "opensandbox", allowProjectOverride: false } });
		const run = (conv: number, code: string) => sb.run({ principal: owner.p, space: owner.space, conversationId: conv, language: "shell", code });
		const r1 = await run(w.c1, "echo live-memory > project/live.md && mkdir -p project/d && echo live-project > project/d/p.md && echo conv > mine.txt && ls");
		assert.equal(r1.exitCode, 0, r1.stderr);
		assert.equal(r1.driver, "opensandbox");
		assert.equal(readFileSync(join(sb.route(owner.space, w.c1, "project", owner.p).root, "live.md"), "utf8").trim(), "live-memory");
		assert.equal(readFileSync(join(sb.route(owner.space, w.c1, "project", owner.p).root, "d", "p.md"), "utf8").trim(), "live-project");
		assert.equal(existsSync(join(sb.workdir(owner.space, w.c1), "live.md")), false);
		const r2 = await run(w.c2, "cat project/live.md project/d/p.md; ls");
		assert.equal(r2.exitCode, 0, r2.stderr);
		assert.match(r2.stdout, /live-memory\s+live-project/);
		assert.doesNotMatch(r2.stdout, /mine\.txt/);
		const r3 = await run(w.c3, "test -d project && echo HAS-PROJECT || echo no-project");
		assert.match(r3.stdout, /no-project/);
		// a host-side change between two runs reaches the sandbox; a sandbox change made while the host changed is kept as a conflict copy
		sb.writeFile(owner.space, w.c1, "project/live.md", enc("edited-on-host"), owner.p);
		const r4 = await run(w.c1, "cat project/live.md");
		assert.match(r4.stdout, /edited-on-host/);
		const slow = run(w.c1, "echo from-sandbox > project/live.md; sleep 14");
		await new Promise((r) => setTimeout(r, 8000)); // the command has started (upload + exec) well before this
		sb.writeFile(owner.space, w.c1, "project/live.md", enc("host-concurrent"), owner.p);
		const r5 = await slow;
		const dirOf = sb.route(owner.space, w.c1, "project", owner.p).root;
		const copies = readdirSync(dirOf).filter((f) => f.startsWith("live.conflict-"));
		assert.equal(copies.length, 1, `${r5.stderr}\n${readdirSync(dirOf)}`);
		assert.equal(readFileSync(join(dirOf, copies[0]!), "utf8").trim(), "from-sandbox");
		assert.equal(readFileSync(join(dirOf, "live.md"), "utf8"), "host-concurrent");
		assert.match(r5.stderr, /另存为 project\/live\.conflict-/);
	} finally {
		if (prevAllow === undefined) delete process.env.WORKROOM_WEBHOOK_ALLOWLIST;
		else process.env.WORKROOM_WEBHOOK_ALLOWLIST = prevAllow;
		await w.t.dispose();
	}
});
