// RemoteDriver unit tests against an in-memory TEST DOUBLE provider (server/test/helpers/fake-remote-provider.ts).
// These verify RemoteDriver's own logic only (instance table, manifest sync, path/symlink/size rules, mount verification, reaping,
// lifecycle). They are NOT acceptance of any real provider — that is server/test/sandbox-contract.test.ts against a live service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync, lstatSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDb } from "../src/core/db.ts";
import { DEFAULT_LIMITS, SANDBOX_MIGRATIONS } from "../src/tools/sandbox.ts";
import { RemoteDriver, instancesFor, normalizeRemotePath, treeHash } from "../src/tools/sandbox/remote-driver.ts";
import { UnsupportedError } from "../src/tools/sandbox/provider.ts";
import type { DriverRunSpec, SandboxMount } from "../src/tools/sandbox/driver.ts";
import { FAKE_CAPS, FakeRemoteProvider } from "./helpers/fake-remote-provider.ts";

function setup(opts: { lifecycle?: { createTimeoutSec: number; idleTimeoutSec: number; lifetimeSec: number }; provider?: FakeRemoteProvider; db?: AppDb; image?: string; resources?: { cpus?: number; memoryGb?: number; diskGb?: number } } = {}) {
	const root = mkdtempSync(join(tmpdir(), "wr-remote-"));
	const db = opts.db ?? new AppDb(":memory:");
	if (!opts.db) db.migrate("sandbox-test", SANDBOX_MIGRATIONS);
	const provider = opts.provider ?? new FakeRemoteProvider();
	const driver = new RemoteDriver({ db, provider, orgId: "org1", ...(opts.lifecycle ? { lifecycle: opts.lifecycle } : {}), ...(opts.image ? { image: opts.image } : {}), ...(opts.resources ? { resources: opts.resources } : {}) });
	const wd = join(root, "sandbox", "c1");
	mkdirSync(wd, { recursive: true });
	let n = 0;
	const spec = (code: string, o: Partial<DriverRunSpec> = {}): DriverRunSpec => ({
		runId: `run_${++n}_${Math.random().toString(36).slice(2, 6)}`,
		tenant: { orgId: "org1", spaceId: "s1", workspaceKey: "c1" },
		scratchBase: join(root, "sandbox"),
		workdir: wd,
		exec: { language: "python", code },
		limits: { ...DEFAULT_LIMITS, timeoutMs: 5000 },
		mounts: [],
		env: {},
		network: false,
		...o,
	});
	return { root, db, provider, driver, wd, spec, box: () => [...provider.boxes.values()].at(-1)! };
}
const read = (p: string) => readFileSync(p, "utf8");

test("round 9: no network refusal - an unverified provider runs with either spec.network value, and create() receives no network option at all", async () => {
	const provider = new FakeRemoteProvider();
	provider.capabilities = { ...FAKE_CAPS, networkOff: "unverified", networkOn: "unverified" };
	const { driver, spec } = setup({ provider });
	const a = await driver.run(spec("echo no-flag"));
	assert.equal(a.exitCode, 0, "formerly refused with 501 UNSUPPORTED");
	assert.equal(provider.created, 1);
	const opts = [...provider.boxes.values()][0]!.createOptions;
	for (const k of Object.keys(opts)) assert.doesNotMatch(k, /network|internet|egress|block|deny/i, `create option ${k}`);
	const b = await driver.run({ ...spec("echo yes"), network: true });
	assert.equal(b.exitCode, 0);
	assert.equal(provider.created, 1, "same sandbox, no recreation");
});

test("run: exit code, stdout/stderr, file roundtrip host → remote → host, manifest persisted, one instance row", async () => {
	const t = setup();
	writeFileSync(join(t.wd, "in.txt"), "hello");
	const r = await t.driver.run(t.spec("cat in.txt\nwrite out/o.txt result\nerr warn\nexit 3"));
	assert.equal(r.status, "error");
	assert.equal(r.exitCode, 3);
	assert.match(r.stdout, /hello/);
	assert.match(r.stderr, /warn/);
	assert.equal(read(join(t.wd, "out", "o.txt")), "result");
	const rows = instancesFor(t.db, "org1");
	assert.equal(rows.length, 1);
	assert.equal(rows[0]!.state, "ready");
	assert.equal(rows[0]!.workspaceKey, "c1");
	const m = JSON.parse(t.db.get<{ manifest: string }>("SELECT manifest FROM tool_sandbox_instances")!.manifest);
	assert.ok(m["in.txt"] && m["out/o.txt"] && m["out/"] === "dir");
});

test("replay idempotency: a second identical run uploads nothing and leaves the manifest unchanged", async () => {
	const t = setup();
	writeFileSync(join(t.wd, "a.txt"), "A");
	await t.driver.run(t.spec("echo one"));
	const before = t.db.get<{ manifest: string }>("SELECT manifest FROM tool_sandbox_instances")!.manifest;
	const sp = t.spec("echo one");
	await t.driver.run(sp);
	await t.driver.run({ ...sp, runId: "run_again" });
	assert.equal(t.db.get<{ manifest: string }>("SELECT manifest FROM tool_sandbox_instances")!.manifest, before);
	assert.equal(t.box().writes.filter((p) => p === "/work/a.txt").length, 1);
});

test("deletions propagate both ways", async () => {
	const t = setup();
	writeFileSync(join(t.wd, "keep.txt"), "k");
	writeFileSync(join(t.wd, "gone-remote.txt"), "g");
	writeFileSync(join(t.wd, "gone-host.txt"), "h");
	await t.driver.run(t.spec("echo sync"));
	rmSync(join(t.wd, "gone-host.txt"));
	await t.driver.run(t.spec("rm gone-remote.txt"));
	assert.equal(existsSync(join(t.wd, "gone-remote.txt")), false, "deleted remotely → deleted on host");
	assert.equal(t.box().text("/work/gone-host.txt"), undefined, "deleted on host → deleted remotely");
	assert.equal(read(join(t.wd, "keep.txt")), "k");
});

test("remote symlinks, fifos and illegal names are never copied to the host (with notes)", async () => {
	const t = setup();
	const r = await t.driver.run(t.spec("write ok.txt fine\nln link.txt /etc/passwd\nmkfifo pipe\nwrite a:b.txt x\nwrite bad\\name.txt x"));
	assert.equal(r.status, "ok");
	assert.equal(read(join(t.wd, "ok.txt")), "fine");
	for (const n of ["link.txt", "pipe", "a:b.txt", "bad\\name.txt"]) assert.equal(existsSync(join(t.wd, n)), false, n);
	assert.match(r.stderr, /符号链接未同步到宿主机：link\.txt/);
	assert.match(r.stderr, /特殊文件未同步到宿主机：pipe/);
	assert.match(r.stderr, /远端文件名不合法/);
});

test("host symlinks are refused (not uploaded, not followed) and a symlinked remote path cannot delete the host file", async () => {
	const t = setup();
	writeFileSync(join(t.root, "secret.txt"), "TOP");
	symlinkSync(join(t.root, "secret.txt"), join(t.wd, "sneaky"));
	const r = await t.driver.run(t.spec("cat sneaky"));
	assert.match(r.stdout, /<missing>/);
	assert.match(r.stderr, /符号链接未同步：sneaky/);
	assert.equal(t.box().text("/work/sneaky"), undefined);
	assert.ok(lstatSync(join(t.wd, "sneaky")).isSymbolicLink());
});

test("normalizeRemotePath rejects .., absolute, NUL and backslash", () => {
	for (const bad of ["../x", "a/../../x", "/etc/passwd", "a\0b", "a\\b", "", "a/./..", "x:y"]) assert.equal(normalizeRemotePath(bad), null, JSON.stringify(bad));
	assert.equal(normalizeRemotePath("a/b c/é.txt"), "a/b c/é.txt");
});

test("per-file size limit: oversized remote file is not downloaded, oversized host file is not uploaded", async () => {
	const t = setup();
	writeFileSync(join(t.wd, "huge.bin"), Buffer.alloc(3000));
	const lim = { ...DEFAULT_LIMITS, timeoutMs: 5000, maxFileBytes: 1000 };
	const r = await t.driver.run(t.spec("big made.bin 2000\nwrite small.txt ok", { limits: lim }));
	assert.equal(existsSync(join(t.wd, "made.bin")), false);
	assert.equal(read(join(t.wd, "small.txt")), "ok");
	assert.equal(t.box().text("/work/huge.bin"), undefined);
	assert.match(r.stderr, /超过单文件上限/);
});

test("quota: files that would exceed the workspace quota are not synced back", async () => {
	const t = setup();
	process.env.WORKROOM_SANDBOX_QUOTA_MB = "1";
	try {
		const r = await t.driver.run(t.spec(`big a.bin 600000\nbig b.bin 600000`));
		const got = ["a.bin", "b.bin"].filter((n) => existsSync(join(t.wd, n)));
		assert.equal(got.length, 1, "only one fits in 1 MB");
		assert.match(r.stderr, /配额不足/);
	} finally {
		delete process.env.WORKROOM_SANDBOX_QUOTA_MB;
	}
});

test("host edits made during the run win (host version kept, noted)", async () => {
	const t = setup();
	writeFileSync(join(t.wd, "shared.txt"), "v1");
	await t.driver.run(t.spec("echo sync"));
	const sp = t.spec("write shared.txt remote-edit");
	const p = t.driver.run(sp);
	await new Promise((r) => setTimeout(r, 0));
	// the run is in flight (fake is synchronous-ish); edit the host file after upload by hooking the next tick is racy, so emulate: edit before pull via a sleep program
	await p;
	assert.equal(read(join(t.wd, "shared.txt")), "remote-edit"); // no concurrent edit → remote wins
	writeFileSync(join(t.wd, "shared.txt"), "host-edit-2");
	const sp2 = t.spec("write shared.txt remote-edit-2\nsleep 150");
	const run2 = t.driver.run(sp2);
	await new Promise((r) => setTimeout(r, 60));
	writeFileSync(join(t.wd, "shared.txt"), "host-edit-3"); // while the program sleeps
	const r2 = await run2;
	assert.equal(read(join(t.wd, "shared.txt")), "host-edit-3");
	assert.match(r2.stderr, /宿主机上同时修改了 shared\.txt/);
});

test("mounts: uploaded once with hash verification, read-only, tamper is repaired, skip when marker matches", async () => {
	const t = setup();
	const skill = join(t.root, "mounts", "skill1");
	mkdirSync(join(skill, "scripts"), { recursive: true });
	writeFileSync(join(skill, "SKILL.md"), "# skill");
	writeFileSync(join(skill, "scripts", "run.py"), "print(1)");
	const m: SandboxMount = { hostPath: skill, target: "/skills/skill1", readOnly: true };
	const r1 = await t.driver.run(t.spec("write /skills/skill1/SKILL.md pwned", { mounts: [m] }));
	assert.equal(r1.status, "error", "write into the read-only mount fails");
	assert.equal(t.box().text("/skills/skill1/SKILL.md"), "# skill");
	assert.match(t.box().text("/skills/skill1/.workroom-sha256") ?? "", /^[0-9a-f]{64}$/);
	const w1 = t.box().writes.filter((p) => p.startsWith("/skills/")).length;
	await t.driver.run(t.spec("echo again", { mounts: [m] }));
	assert.equal(t.box().writes.filter((p) => p.startsWith("/skills/")).length, w1, "same hash marker → no re-upload");
	// tamper (as a single-user provider would allow): next run detects and restores
	t.box().put("/skills/skill1/SKILL.md", "TAMPERED");
	await t.driver.run(t.spec("echo third", { mounts: [m] }));
	assert.equal(t.box().text("/skills/skill1/SKILL.md"), "# skill");
	// expected hash is exactly treeHash of the host files
	const marker = t.box().text("/skills/skill1/.workroom-sha256");
	assert.equal(marker, treeHash([{ rel: "SKILL.md", sha: (await import("node:crypto")).createHash("sha256").update("# skill").digest("hex") }, { rel: "scripts/run.py", sha: (await import("node:crypto")).createHash("sha256").update("print(1)").digest("hex") }]));
});

test("single-user provider: the run notes say skills are protected by hash re-verification only", async () => {
	const provider = new FakeRemoteProvider();
	provider.singleUser = true;
	const t = setup({ provider });
	const skill = join(t.root, "mounts", "s");
	mkdirSync(skill, { recursive: true });
	writeFileSync(join(skill, "a.md"), "A");
	const r = await t.driver.run(t.spec("echo hi", { mounts: [{ hostPath: skill, target: "/skills/s", readOnly: true }] }));
	assert.match(r.stderr, /单用户沙箱/);
});

test("writable mounts and services are UnsupportedError (501); no host fallback", async () => {
	const t = setup();
	const dir = join(t.root, "m");
	mkdirSync(dir);
	await assert.rejects(t.driver.run(t.spec("echo x", { mounts: [{ hostPath: dir, target: "/data", readOnly: false }] })), (e: any) => e instanceof UnsupportedError && e.status === 501 && e.code === "UNSUPPORTED");
	await assert.rejects(t.driver.startService({} as never), (e: any) => e instanceof UnsupportedError);
	assert.equal(t.driver.capabilities.services, false);
	assert.equal(t.driver.capabilities.mounts, true);
});

test("missing tenant is refused (a remote run must know whose sandbox it is)", async () => {
	const t = setup();
	await assert.rejects(t.driver.run({ ...t.spec("echo x"), tenant: undefined }), /租户/);
});

test("tenant isolation: two spaces / two conversations never share a remote sandbox or its files", async () => {
	const t = setup();
	writeFileSync(join(t.wd, "mine.txt"), "s1");
	await t.driver.run(t.spec("echo one"));
	const wd2 = join(t.root, "sandbox2", "c1");
	mkdirSync(wd2, { recursive: true });
	await t.driver.run(t.spec("cat mine.txt", { workdir: wd2, tenant: { orgId: "org1", spaceId: "s2", workspaceKey: "c1" } }));
	assert.equal(t.provider.boxes.size, 2);
	const [a, b] = [...t.provider.boxes.values()];
	assert.equal(a!.text("/work/mine.txt"), "s1");
	assert.equal(b!.text("/work/mine.txt"), undefined);
	mkdirSync(join(t.root, "sandbox", "c2"), { recursive: true });
	const r3 = await t.driver.run(t.spec("cat mine.txt", { tenant: { orgId: "org1", spaceId: "s1", workspaceKey: "c2" }, workdir: join(t.root, "sandbox", "c2") }));
	assert.equal(t.provider.boxes.size, 3);
	assert.match(r3.stdout, /<missing>/);
	assert.deepEqual(new Set(instancesFor(t.db, "org1").map((i) => `${i.spaceId}/${i.workspaceKey}`)), new Set(["s1/c1", "s2/c1", "s1/c2"]));
	// a driver for another org refuses a foreign tenant
	await assert.rejects(t.driver.run(t.spec("echo x", { tenant: { orgId: "org2", spaceId: "s1", workspaceKey: "c1" } })), /组织不匹配/);
});

test("reconnect after driver restart: a new RemoteDriver with the same DB reuses the remote id; files intact, no re-upload", async () => {
	const t = setup();
	writeFileSync(join(t.wd, "f.txt"), "persist");
	await t.driver.run(t.spec("echo first"));
	const id = instancesFor(t.db, "org1")[0]!.remoteId;
	const d2 = new RemoteDriver({ db: t.db, provider: t.provider, orgId: "org1" });
	const w = t.box().writes.length;
	const r = await d2.run(t.spec("cat f.txt"));
	assert.match(r.stdout, /persist/);
	assert.equal(t.provider.created, 1);
	assert.equal(instancesFor(t.db, "org1")[0]!.remoteId, id);
	assert.equal(t.box().writes.filter((p) => p === "/work/f.txt").length, 1);
	void w;
});

test("lost sandbox (destroyed externally): marked lost, recreated, fully re-synced from the host", async () => {
	const t = setup();
	writeFileSync(join(t.wd, "f.txt"), "keep me");
	await t.driver.run(t.spec("write made.txt remote-made"));
	const old = instancesFor(t.db, "org1")[0]!;
	t.provider.kill(old.remoteId!);
	const r = await t.driver.run(t.spec("cat f.txt\ncat made.txt"));
	assert.match(r.stdout, /keep me/);
	assert.match(r.stdout, /remote-made/, "a file the earlier run synced home is re-uploaded");
	assert.match(r.stderr, /远端沙箱已不存在/);
	const rows = instancesFor(t.db, "org1");
	assert.equal(rows.find((x) => x.id === old.id)!.state, "lost");
	assert.equal(rows.filter((x) => x.state === "ready").length, 1);
	assert.equal(t.provider.created, 2);
});

test("round 9: a changed network flag never recreates the sandbox; a legacy row created under the removed no-network policy (network=0) is recreated once, lazily", async () => {
	const t = setup();
	await t.driver.run(t.spec("echo a"));
	await t.driver.run(t.spec("echo b", { network: true }));
	await t.driver.run(t.spec("echo c", { network: false }));
	assert.equal(t.provider.created, 1, "flag changes do not matter");
	assert.equal(instancesFor(t.db, "org1").filter((x) => x.state === "ready").length, 1);
	assert.equal((t.db.get<{ network: number }>("SELECT network FROM tool_sandbox_instances WHERE state = 'ready'"))!.network, 1, "new rows are written as 'no deny option'");
	// simulate an instance created by the previous version under policy "none" (created WITH a deny option)
	t.db.run("UPDATE tool_sandbox_instances SET network = 0 WHERE state = 'ready'");
	const r = await t.driver.run(t.spec("echo d"));
	assert.equal(r.exitCode, 0);
	assert.match(r.stderr, /旧版本的“无网络”策略/);
	assert.equal(t.provider.created, 2);
	assert.equal(instancesFor(t.db, "org1").filter((x) => x.state === "ready").length, 1);
	await t.driver.run(t.spec("echo e"));
	assert.equal(t.provider.created, 2, "recreated only once");
});

test("timeout and cancel map to statuses and the fake process really stops", async () => {
	const t = setup();
	const r = await t.driver.run(t.spec("sleep 5000", { limits: { ...DEFAULT_LIMITS, timeoutMs: 100 } }));
	assert.equal(r.status, "timeout");
	assert.equal(t.box().running, 0);
	const ac = new AbortController();
	setTimeout(() => ac.abort(), 80);
	const r2 = await t.driver.run(t.spec("sleep 5000", { signal: ac.signal }));
	assert.equal(r2.status, "killed");
	assert.equal(t.box().running, 0);
	const pre = new AbortController();
	pre.abort();
	assert.equal((await t.driver.run(t.spec("echo x", { signal: pre.signal }))).status, "killed");
});

test("streaming callbacks are not required by the driver, but stdout is complete and ordered", async () => {
	const t = setup();
	const r = await t.driver.run(t.spec("echo a\necho b\necho c"));
	assert.equal(r.stdout, "a\nb\nc\n");
});

test("one run at a time per instance (mutex), different instances in parallel", async () => {
	const t = setup();
	await Promise.all([t.driver.run(t.spec("sleep 80")), t.driver.run(t.spec("sleep 80")), t.driver.run(t.spec("sleep 80"))]);
	assert.equal(t.box().maxRunning, 1);
	assert.equal(t.provider.created, 1);
});

test("create failure: clear 503, instance row in error, nothing runs, no fallback", async () => {
	const provider = new FakeRemoteProvider();
	provider.failCreate = new Error("quota exceeded key_ABCDEFGHIJKLMNOP");
	const t = setup({ provider });
	await assert.rejects(t.driver.run(t.spec("echo x")), (e: any) => e.status === 503 && /创建沙箱失败/.test(e.message) && /不会回退到本机/.test(e.message) && !/ABCDEFGHIJKLMNOP/.test(e.message));
	const rows = instancesFor(t.db, "org1");
	assert.equal(rows[0]!.state, "error");
	assert.doesNotMatch(rows[0]!.lastError ?? "", /ABCDEFGHIJKLMNOP/);
	provider.failCreate = undefined;
	assert.equal((await t.driver.run(t.spec("echo ok"))).status, "ok", "recovers once the provider works again");
});

test("reapIdle destroys idle and expired instances, never a busy one; row state follows", async () => {
	let now = Date.now();
	const provider = new FakeRemoteProvider();
	const db = new AppDb(":memory:");
	db.migrate("sandbox-test", SANDBOX_MIGRATIONS);
	const driver = new RemoteDriver({ db, provider, orgId: "org1", lifecycle: { createTimeoutSec: 30, idleTimeoutSec: 60, lifetimeSec: 3600 }, now: () => now });
	const t = setup({ provider, db, lifecycle: { createTimeoutSec: 30, idleTimeoutSec: 60, lifetimeSec: 3600 } });
	await driver.run(t.spec("echo x"));
	assert.equal(await driver.reapIdle(now + 30_000), 0);
	const busy = driver.run(t.spec("sleep 120"));
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(await driver.reapIdle(now + 10 * 3600_000), 0, "a run is in progress");
	await busy;
	assert.equal(await driver.reapIdle(now + 120_000 + 1_000_000), 1);
	assert.equal(instancesFor(db, "org1")[0]!.state, "destroyed");
	assert.equal(provider.destroyedIds.length, 1);
	now += 1;
});

test("reapStale: orphans with our install label are destroyed; other installs, young sandboxes and tracked ones are kept", async () => {
	const t = setup();
	await t.driver.run(t.spec("echo tracked"));
	const tracked = t.box();
	const lbl = tracked.metadata;
	const { FakeBox } = await import("./helpers/fake-remote-provider.ts");
	const old = new Date(Date.now() - 3600_000).toISOString();
	const orphan = new FakeBox("orphan-1", { workroom: "1", workroom_install: lbl.workroom_install!, workroom_org: lbl.workroom_org!, workroom_instance: "sbi_gone" }, {}, old);
	const foreign = new FakeBox("foreign-1", { workroom: "1", workroom_install: "someone-else", workroom_org: lbl.workroom_org! }, {}, old);
	const young = new FakeBox("young-1", { workroom: "1", workroom_install: lbl.workroom_install!, workroom_org: lbl.workroom_org!, workroom_instance: "sbi_new" }, {});
	for (const b of [orphan, foreign, young]) t.provider.boxes.set(b.id, b);
	const n = await t.driver.reapStale();
	assert.equal(n, 1);
	assert.deepEqual(t.provider.destroyedIds, ["orphan-1"]);
	assert.equal(tracked.alive, true);
	assert.equal(foreign.alive, true);
	assert.equal(young.alive, true);
});

test("labels carry no user data and the driver exposes honest capabilities", async () => {
	const t = setup();
	await t.driver.run(t.spec("echo x"));
	const md = t.box().metadata;
	assert.deepEqual(Object.keys(md).sort(), ["workroom", "workroom_install", "workroom_instance", "workroom_org"]);
	// No label is (or embeds, as a token) the org or space id. Substring checks on "s1" were flaky: random base36 instance ids can contain it.
	for (const v of Object.values(md)) for (const id of ["org1", "s1"]) assert.ok(!String(v).split(/[^A-Za-z0-9]+/).includes(id), `label ${v} carries ${id}`);
	assert.equal(t.driver.id, "opensandbox");
	assert.ok(t.driver.notes.doesNotIsolate.some((x) => /chmod/.test(x)));
	assert.equal((await t.driver.detect()).state, "ready");
});

test("RemoteDrivers: local choice → null; provider choice → RemoteDriver; unusable provider → 503 with the reason (never local); config change rebuilds", async () => {
	const { RemoteDrivers } = await import("../src/tools/sandbox/remote-driver.ts");
	const db = new AppDb(":memory:");
	db.migrate("sandbox-test", SANDBOX_MIGRATIONS);
	const provider = new FakeRemoteProvider();
	let eff: any = { kind: "local" };
	let why = "";
	let key = "k1";
	let built = 0;
	const cfg = {
		effectiveFor: () => eff,
		explain: () => why,
		connection: async () => ({ provider: "opensandbox" as const, endpoint: "http://x", apiKey: key }),
		lifecycle: () => ({ createTimeoutSec: 10, idleTimeoutSec: 60, lifetimeSec: 600 }),
		factory: async () => (built++, provider),
	};
	const rd = new RemoteDrivers({ db } as any, { configs: () => cfg });
	const space = { id: "s1", orgId: "org1", kind: "personal", dir: "/x" } as any;
	assert.equal(await rd.forSpace(space), null);
	eff = { kind: "provider", provider: "opensandbox", orgId: "org1" };
	const d1 = await rd.forSpace(space);
	assert.equal(d1?.id, "opensandbox");
	assert.equal(await rd.forSpace(space), d1, "cached while the connection is unchanged");
	key = "k2";
	const d2 = await rd.forSpace(space);
	assert.notEqual(d2, d1);
	assert.equal(built, 2);
	why = "沙箱提供方 OpenSandbox 已被管理员停用（不会回退到本机执行）";
	await assert.rejects(rd.forSpace(space), (e: any) => e.status === 503 && /不会回退/.test(e.message));
	assert.match(rd.notesFor("opensandbox").isolates.join(" "), /远端沙箱/);
});

test("Sandbox integration: a space whose org policy selects a provider runs through RemoteDriver (run record says so); a disabled/unconfigured provider fails clearly and NEVER runs locally", async () => {
	const { startTestApp } = await import("./helpers/app.ts");
	const { PROVIDER_CONFIG_MIGRATIONS, providerConfigsFor } = await import("../src/tools/sandbox/provider-config.ts");
	const t = await startTestApp({ config: { secretKey: "workroom-test-secret-key-0123456789" } });
	try {
		const a = await t.user("rd@example.com");
		const ctx = t.app.ctx;
		if (!ctx.db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'tool_sandbox_providers'")) ctx.db.migrate("tools-s-test", PROVIDER_CONFIG_MIGRATIONS);
		const svc = providerConfigsFor(ctx);
		svc.resolver = async () => [{ address: "93.184.216.34", family: 4 }];
		const fake = new FakeRemoteProvider();
		svc.factory = async () => fake;
		const principal = (await ctx.services.get("identity").principalFor(a.me.userId, a.me.orgId))!;
		const space = ctx.services.get("identity").personalSpace(a.me.userId, a.me.orgId);
		const sb = ctx.services.get("sandbox") as import("../src/tools/sandbox.ts").Sandbox;
		await svc.update(principal, "opensandbox", { endpoint: "https://os.example.com", apiKey: "os-key-123456789", enabled: true, egressAcknowledged: true });
		await svc.setPolicy(principal, { orgDefault: "opensandbox" });
		const run = await sb.run({ principal, space, conversationId: 9, language: "python", code: "echo via-remote\nwrite made.txt hi" });
		assert.equal(run.status, "ok", run.stderr);
		assert.equal(run.driver, "opensandbox");
		assert.match(run.stdout, /via-remote/);
		assert.match(run.isolation ?? "", /远端沙箱/);
		assert.equal(fake.created, 1);
		assert.equal(readFileSync(join(sb.workdir(space, 9), "made.txt"), "utf8"), "hi");
		const row = ctx.db.get<{ workspace_key: string; org_id: string; space_id: string }>("SELECT * FROM tool_sandbox_instances")!;
		assert.deepEqual([row.workspace_key, row.org_id, row.space_id], ["c9", a.me.orgId, space.id]);
		// no silent fallback (round 10: the active channel cannot be disabled through the API; a legacy / hand-edited row still fails loudly)
		await assert.rejects(svc.update(principal, "opensandbox", { enabled: false }), (e: any) => e.status === 409 && e.code === "active_provider");
		ctx.db.run("UPDATE tool_sandbox_providers SET enabled = 0 WHERE provider = 'opensandbox'");
		await assert.rejects(sb.run({ principal, space, conversationId: 9, language: "python", code: "echo should-not-run" }), (e: any) => e.status === 503 && /不会回退/.test(e.message));
		assert.equal(fake.created, 1);
		await assert.rejects(sb.startService({ principal, space, conversationId: 9, runtime: "shell", argv: ["sleep", "1"] }), (e: any) => e.status === 503 || e.status === 501);
	} finally {
		await t.dispose();
	}
});


test("round 10: generic platform limits are passed as a hint (defaultMemoryMb), never as explicit resources; admin resources/image are passed through", async () => {
	const t = setup();
	await t.driver.run(t.spec("echo x"));
	const o = t.box().createOptions as any;
	assert.equal(o.resources, undefined, "no explicit resources unless an admin configured them (the reported Daytona/E2B refusal)");
	assert.ok(typeof o.defaultMemoryMb === "number" && o.defaultMemoryMb >= 64);
	const t2 = setup({ image: "python:3.12-slim", resources: { cpus: 2, memoryGb: 4 } });
	await t2.driver.run(t2.spec("echo y"));
	const o2 = t2.box().createOptions as any;
	assert.deepEqual(o2.resources, { cpus: 2, memoryGb: 4 });
	assert.equal(o2.image, "python:3.12-slim");
});
