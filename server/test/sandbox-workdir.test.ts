// Round 10: the sandbox working directory is NOT fixed to /work (the Daytona default user is not root and cannot create it).
// Pure path rules, RemoteDriver against the in-memory TEST DOUBLE (including a non-root user), provider-config validation, the system-prompt
// section, model-facing path mapping and tool outputs. Real-provider proof of a non-default directory: sandbox-remote-e2e.test.ts (live OpenSandbox).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDb } from "../src/core/db.ts";
import { DEFAULT_LIMITS, SANDBOX_MIGRATIONS, type Sandbox } from "../src/tools/sandbox.ts";
import { RemoteDriver, RemoteDrivers } from "../src/tools/sandbox/remote-driver.ts";
import { providerConfigsFor } from "../src/tools/sandbox/provider-config.ts";
import { environmentsFor } from "../src/tools/sandbox/environment.ts";
import { createSandboxExtension } from "../src/tools/sandbox-tools.ts";
import { createSkillsExtension, renderSkillIndex } from "../src/tools/skills.ts";
import { cleanDir, snapshotDir } from "../src/tools/skill-drafts.ts";
import { renderSandboxSection } from "../src/tools/sandbox/prompt.ts";
import { DEFAULT_WORKDIR, displayPath, isWithin, mapMountTarget, mountRoot, normalizeWorkDir, resolveWorkDir, skillsRootFor, stripWorkPrefix, WorkDirError } from "../src/tools/sandbox/workdir.ts";
import type { DriverRunSpec, SandboxMount } from "../src/tools/sandbox/driver.ts";
import { startTestApp } from "./helpers/app.ts";
import { context, fakeApi, fixedActor } from "./fixtures/tool-harness.ts";
import { FakeRemoteProvider } from "./helpers/fake-remote-provider.ts";

// ------------------------------------------------------------------------------------------------ pure rules
test("normalizeWorkDir: accepts absolute normalised POSIX paths, drops duplicate/trailing slashes and '.', refuses everything else", () => {
	for (const [raw, want] of [
		["/work", "/work"],
		["/home/daytona/work", "/home/daytona/work"],
		["/home/daytona/work/", "/home/daytona/work"],
		["//home//daytona/./work", "/home/daytona/work"],
		["  /tmp/wr-work  ", "/tmp/wr-work"],
		["/data", "/data"],
		["/home/user/my.work_dir-1@x+y", "/home/user/my.work_dir-1@x+y"],
	] as const) assert.equal(normalizeWorkDir(raw), want, raw);

	const refuse = (raw: unknown, re: RegExp) => assert.throws(() => normalizeWorkDir(raw), (e: any) => e instanceof WorkDirError && re.test(e.message), String(raw));
	refuse("", /不能为空/);
	refuse("   ", /不能为空/);
	refuse(42, /文本/);
	refuse("work", /绝对路径/);
	refuse("./work", /绝对路径/);
	refuse("~/work", /绝对路径/);
	refuse("/", /根目录/);
	refuse("///", /根目录/);
	refuse("/home/daytona/../work", /“\.\.”/);
	refuse("/a/..", /“\.\.”/);
	refuse("/home\\daytona", /反斜杠/);
	refuse("/home/day\0tona", /控制字符/);
	refuse("/home/day\ntona", /控制字符/);
	refuse("/home/my work", /只能包含/);
	refuse("/home/a;rm -rf x", /只能包含/);
	refuse("/home/$HOME/x", /只能包含/);
	refuse("/home/中文/x", /只能包含/);
	refuse(`/${"a".repeat(201)}`, /200/);
	// system directories and everything below them
	for (const d of ["/etc", "/etc/work", "/proc", "/proc/1", "/sys", "/dev", "/dev/shm", "/usr", "/usr/local/work", "/bin", "/sbin", "/lib", "/lib64", "/lib32/x", "/boot", "/run", "/run/user", "/var/run", "/var/run/x"]) refuse(d, /系统目录/);
	// shared roots: refused themselves (the whole tree is chmod'ed and synced), fine one level down
	for (const d of ["/home", "/root", "/tmp", "/var", "/opt", "/mnt", "/srv", "/media", "/home/daytona", "/home/user"]) refuse(d, /本身/);
	for (const d of ["/root/work", "/tmp/x", "/var/work", "/opt/wr", "/home/daytona/work", "/library", "/lib64x"]) assert.equal(normalizeWorkDir(d), d, d);
	assert.equal(normalizeWorkDir(`/${"a".repeat(199)}`).length, 200, "exactly 200 chars is fine");
});

test("defaults per provider are deterministic; configured value wins; empty means default", () => {
	assert.deepEqual({ ...DEFAULT_WORKDIR }, { opensandbox: "/work", e2b: "/home/user/work", daytona: "/home/daytona/work" });
	assert.equal(resolveWorkDir("opensandbox"), "/work");
	assert.equal(resolveWorkDir("e2b"), "/home/user/work");
	assert.equal(resolveWorkDir("daytona"), "/home/daytona/work");
	assert.equal(resolveWorkDir("daytona", ""), "/home/daytona/work");
	assert.equal(resolveWorkDir("daytona", null), "/home/daytona/work");
	assert.equal(resolveWorkDir("daytona", "/data/wr"), "/data/wr");
});

test("mount targets are re-rooted next to the working directory; '/work' keeps them unchanged", () => {
	assert.equal(mapMountTarget("/work", "/skills/pdf"), "/skills/pdf");
	assert.equal(skillsRootFor("/work"), "/skills");
	assert.equal(mountRoot("/work"), "/");
	assert.equal(mapMountTarget("/home/daytona/work", "/skills/pdf"), "/home/daytona/skills/pdf");
	assert.equal(skillsRootFor("/home/daytona/work"), "/home/daytona/skills");
	assert.equal(mapMountTarget("/home/user/work", "/skills/a-b"), "/home/user/skills/a-b");
	assert.equal(mapMountTarget("/tmp/wr-work", "/skills/x"), "/tmp/skills/x");
	assert.equal(mapMountTarget("/data", "/skills/x"), "/skills/x", "a top-level directory has '/' as its parent");
	assert.equal(mapMountTarget("/a/b/c", "/skills/x/y"), "/a/b/skills/x/y");
	assert.equal(isWithin("/a/b/c", "/a/b"), true);
	assert.equal(isWithin("/a/b", "/a/b"), true);
	assert.equal(isWithin("/a/bc", "/a/b"), false);
});

test("stripWorkPrefix: the real working directory prefix maps to the same relative path as relative and /work/… forms; others are untouched", () => {
	const W = "/home/daytona/work";
	assert.equal(stripWorkPrefix(`${W}/out/a.txt`, W), "out/a.txt");
	assert.equal(stripWorkPrefix(`${W}`, W), "");
	assert.equal(stripWorkPrefix(`${W}/`, W), "");
	assert.equal(stripWorkPrefix(`${W}//x`, W), "x");
	assert.equal(stripWorkPrefix("out/a.txt", W), "out/a.txt");
	assert.equal(stripWorkPrefix("/work/out/a.txt", W), "/work/out/a.txt", "left for cleanPath, which strips /work");
	assert.equal(stripWorkPrefix(`${W}x/a`, W), `${W}x/a`, "a longer sibling name is not the working directory");
	assert.equal(stripWorkPrefix("/etc/passwd", W), "/etc/passwd");
	assert.equal(stripWorkPrefix("a", "/work"), "a");
	assert.equal(stripWorkPrefix("/work/a", undefined), "/work/a");
	assert.equal(displayPath(W, "a/b.txt"), `${W}/a/b.txt`);
	assert.equal(displayPath("/work", "b.txt"), "/work/b.txt");
	assert.equal(displayPath(W, ""), W);
});

test("skill_manage dir: relative, /work/…, and the real working directory all name the same directory; the root is still refused", () => {
	const W = "/home/daytona/work";
	assert.equal(cleanDir("weekly-report", W), "weekly-report");
	assert.equal(cleanDir("/work/weekly-report", W), "weekly-report");
	assert.equal(cleanDir(`${W}/weekly-report`, W), "weekly-report");
	assert.equal(cleanDir("/work/weekly-report"), "weekly-report");
	assert.throws(() => cleanDir(W, W), /工作目录/);
	assert.throws(() => cleanDir("/etc/x", W), /绝对路径/);
	assert.throws(() => cleanDir(`${W}/../x`, W), /“\.\.”/);
	// messages name the real path
	const tmp = mkdtempSync(join(tmpdir(), "wr-wd-"));
	assert.throws(() => snapshotDir(tmp, `${W}/nope`, W), (e: any) => e.message.includes(`${W}/nope`) && e.code === "dir_not_found");
	assert.throws(() => snapshotDir(tmp, "nope"), (e: any) => e.message.includes("/work/nope"));
});

// ------------------------------------------------------------------------------------------------ prompt section (pure)
test("system prompt section: kind, real working directory, skills root; unusable sandbox says so; /work is not claimed where it does not exist", () => {
	const daytona = renderSandboxSection({ kind: "remote", label: "Daytona", workDir: "/home/daytona/work", skillsRoot: "/home/daytona/skills", usable: true });
	assert.match(daytona, /云端沙箱 Daytona/);
	assert.match(daytona, /工作目录：\/home\/daytona\/work/);
	assert.match(daytona, /WORKROOM_WORKDIR/);
	assert.match(daytona, /相对路径/);
	assert.match(daytona, /\/home\/daytona\/skills\/<技能名>\/（|\/home\/daytona\/skills\/<技能名>\//);
	assert.match(daytona, /不要假设 \/work 存在/);
	assert.ok(!/技能目录（只读）：\/skills/.test(daytona));

	const local = renderSandboxSection({ kind: "local", label: "平台内置沙箱（Docker）", workDir: "/work", skillsRoot: "/skills", usable: true });
	assert.match(local, /平台内置沙箱（Docker）/);
	assert.match(local, /工作目录：\/work/);
	assert.match(local, /\/skills\/<技能名>\//);
	assert.ok(!/不要假设/.test(local));

	const os = renderSandboxSection({ kind: "remote", label: "OpenSandbox（自托管）", workDir: "/work", skillsRoot: "/skills", usable: true });
	assert.match(os, /云端沙箱 OpenSandbox/);
	assert.ok(!/不要假设/.test(os), "OpenSandbox keeps /work");

	const down = renderSandboxSection({ kind: "remote", label: "Daytona", workDir: "/home/daytona/work", skillsRoot: "/home/daytona/skills", usable: false, reason: "沙箱提供方 Daytona 缺少 API 密钥" });
	assert.match(down, /当前不可用：沙箱提供方 Daytona 缺少 API 密钥/);
	assert.match(down, /不要声称/);
	assert.ok(!/工作目录：/.test(down));
});

test("skill index (prompt) names the real paths of the active sandbox; defaults stay /work and /skills", () => {
	const e = [{ name: "报告", slug: "report-abc123", description: "d" }];
	const def = renderSkillIndex(e)!;
	assert.match(def, /在 \/work 里编辑/);
	assert.match(def, /复制 \/skills\//);
	const real = renderSkillIndex(e, { workDir: "/home/daytona/work", skillsRoot: "/home/daytona/skills" })!;
	assert.match(real, /在 \/home\/daytona\/work 里编辑/);
	assert.match(real, /复制 \/home\/daytona\/skills\//);
	assert.ok(!/在 \/work 里|复制 \/skills\//.test(real));
});

// ------------------------------------------------------------------------------------------------ RemoteDriver (fake provider)
function setup(opts: { provider?: FakeRemoteProvider; db?: AppDb; workDir?: string } = {}) {
	const root = mkdtempSync(join(tmpdir(), "wr-workdir-"));
	const db = opts.db ?? new AppDb(":memory:");
	if (!opts.db) db.migrate("sandbox-test", SANDBOX_MIGRATIONS);
	const provider = opts.provider ?? new FakeRemoteProvider();
	const driver = new RemoteDriver({ db, provider, orgId: "org1", ...(opts.workDir ? { workDir: opts.workDir } : {}) });
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
const nonRoot = () => {
	const p = new FakeRemoteProvider();
	p.nonRoot = { user: "daytona", writable: ["/home/daytona", "/tmp"] };
	return p;
};

test("THE BUG: a non-root sandbox user cannot create /work → a clear, visible error naming the directory and the user; nothing runs, no host fallback", async () => {
	const provider = nonRoot();
	const t = setup({ provider }); // default of the (fake) opensandbox provider = /work
	writeFileSync(join(t.wd, "in.txt"), "x");
	await assert.rejects(t.driver.run(t.spec("echo should-not-run")), (e: any) => {
		assert.equal(e.status, 503);
		assert.equal(e.code, "sandbox_workdir_unwritable");
		assert.match(e.message, /^工作目录 \/work 在沙箱内不可写（当前用户 daytona）：请管理员在“沙箱提供方”中把工作目录改为该用户可写的路径$/);
		return true;
	});
	assert.equal(t.box().lastRun, undefined, "the program never started");
	assert.equal(t.box().files.size, 0, "nothing was uploaded");
	// the error is what the environment shows while "preparing" ends: the failure marker
	const { remoteActivity } = await import("../src/tools/sandbox/remote-driver.ts");
	const f = remoteActivity.failures.get("org1|s1|c1|opensandbox");
	assert.match(f?.error ?? "", /不可写/);
	remoteActivity.ok("org1|s1|c1|opensandbox");
});

test("a configured, user-writable working directory works for a non-root user: sync both ways, cwd, WORKROOM_WORKDIR, relative paths", async () => {
	const provider = nonRoot();
	const W = "/home/daytona/work";
	const t = setup({ provider, workDir: W });
	assert.equal(t.driver.workDir, W);
	assert.equal(t.driver.skillsRoot, "/home/daytona/skills");
	writeFileSync(join(t.wd, "in.txt"), "hello");
	mkdirSync(join(t.wd, "sub"), { recursive: true });
	writeFileSync(join(t.wd, "sub", "s.txt"), "nested");
	const r = await t.driver.run(t.spec("cat in.txt\ncat sub/s.txt\nwrite out/o.txt result"));
	assert.equal(r.status, "ok", r.stderr);
	assert.match(r.stdout, /hello/);
	assert.match(r.stdout, /nested/);
	// host → remote landed in the configured directory, not in /work
	assert.equal(t.box().text(`${W}/in.txt`), "hello");
	assert.equal(t.box().text(`${W}/sub/s.txt`), "nested");
	assert.equal(t.box().text("/work/in.txt"), undefined);
	assert.equal(t.box().dirs.has("/work"), false, "/work was never created");
	// cwd and env of the program
	assert.equal(t.box().lastRun!.cwd, W);
	assert.equal(t.box().lastRun!.env.WORKROOM_WORKDIR, W);
	assert.equal(t.box().lastRun!.env.HOME, "/tmp", "HOME stays a writable place");
	// remote → host
	assert.equal(readFileSync(join(t.wd, "out", "o.txt"), "utf8"), "result");
	// a user-supplied WORKROOM_WORKDIR cannot lie about it
	await t.driver.run(t.spec("echo again", { env: { WORKROOM_WORKDIR: "/nope" } }));
	assert.equal(t.box().lastRun!.env.WORKROOM_WORKDIR, W);
	// second run: nothing re-uploaded
	const before = t.box().writes.length;
	await t.driver.run(t.spec("echo third"));
	assert.equal(t.box().writes.filter((p) => p.endsWith("/in.txt")).length, 1);
	assert.ok(t.box().writes.length >= before);
	// deletions propagate inside the configured directory
	rmHost(t.wd, "in.txt");
	await t.driver.run(t.spec("echo del"));
	assert.equal(t.box().text(`${W}/in.txt`), undefined);
});
const rmHost = (wd: string, rel: string) => void import("node:fs").then(({ rmSync }) => rmSync(join(wd, rel), { force: true }));

test("mounts (skills) are re-rooted next to the working directory: uploaded there, verified, read-only; /work keeps /skills", async () => {
	const provider = nonRoot();
	const t = setup({ provider, workDir: "/home/daytona/work" });
	const skill = join(t.root, "skill1");
	mkdirSync(skill, { recursive: true });
	writeFileSync(join(skill, "SKILL.md"), "# skill");
	const m: SandboxMount = { hostPath: skill, target: "/skills/skill1", readOnly: true };
	assert.equal(t.driver.mountTarget("/skills/skill1"), "/home/daytona/skills/skill1");
	const r = await t.driver.run(t.spec("write /home/daytona/skills/skill1/SKILL.md pwned\ncat /home/daytona/skills/skill1/SKILL.md", { mounts: [m] }));
	assert.match(r.stderr, /permission denied/, "the mount is read-only for the workload user");
	assert.equal(t.box().text("/home/daytona/skills/skill1/SKILL.md"), "# skill");
	assert.match(t.box().text("/home/daytona/skills/skill1/.workroom-sha256") ?? "", /^[0-9a-f]{64}$/);
	assert.equal(t.box().text("/skills/skill1/SKILL.md"), undefined, "nothing at the logical root-level target");
	const w1 = t.box().writes.filter((p) => p.startsWith("/home/daytona/skills/")).length;
	await t.driver.run(t.spec("echo again", { mounts: [m] }));
	assert.equal(t.box().writes.filter((p) => p.startsWith("/home/daytona/skills/")).length, w1, "same hash marker → no re-upload");

	// "/work" keeps the logical targets (local-driver compatible; OpenSandbox default)
	const t2 = setup();
	await t2.driver.run(t2.spec("echo x", { mounts: [m] }));
	assert.equal(t2.box().text("/skills/skill1/SKILL.md"), "# skill");
	assert.equal(t2.driver.skillsRoot, "/skills");
});

test("a working directory the user cannot write (configured wrongly) is refused with the same plain error", async () => {
	const t = setup({ provider: nonRoot(), workDir: "/data/work" });
	await assert.rejects(t.driver.run(t.spec("echo x")), (e: any) => e.status === 503 && /^工作目录 \/data\/work 在沙箱内不可写（当前用户 daytona）：请管理员/.test(e.message));
	// root-owned but created fine (privileged) yet not writable by the workload user → also refused
	const p = new FakeRemoteProvider();
	p.nonRoot = { user: "daytona", writable: ["/tmp"] };
	const t2 = setup({ provider: p, workDir: "/home/daytona/work" });
	await assert.rejects(t2.driver.run(t2.spec("echo x")), /不可写/);
});

test("a mount that would overlap the working directory is refused (e.g. working directory named 'skills')", async () => {
	const t = setup({ workDir: "/home/daytona/skills" }); // skills root = /home/daytona/skills → inside the working directory
	const skill = join(t.root, "sk");
	mkdirSync(skill, { recursive: true });
	writeFileSync(join(skill, "SKILL.md"), "# s");
	await assert.rejects(t.driver.run(t.spec("echo x", { mounts: [{ hostPath: skill, target: "/skills/sk", readOnly: true }] })), (e: any) => e.code === "bad_mount" && /重叠/.test(e.message));
});

test("changing the working directory re-syncs the whole workspace into the new directory (same sandbox, old directory left alone), once", async () => {
	const db = new AppDb(":memory:");
	db.migrate("sandbox-test", SANDBOX_MIGRATIONS);
	const provider = new FakeRemoteProvider();
	const a = setup({ db, provider });
	writeFileSync(join(a.wd, "keep.txt"), "K");
	const r1 = await a.driver.run(a.spec("echo one"));
	assert.equal(r1.exitCode, 0);
	assert.equal(a.box().text("/work/keep.txt"), "K");
	assert.equal(db.get<{ work_dir: string }>("SELECT work_dir FROM tool_sandbox_instances")!.work_dir, "/work");

	// the admin changes it: a NEW driver (the fingerprint changes) for the same provider and the same (host) workspace
	const b = new RemoteDriver({ db, provider, orgId: "org1", workDir: "/srv/wr" });
	const spec2 = { ...a.spec("cat keep.txt"), exec: { language: "python" as const, code: "cat keep.txt" } };
	const r2 = await b.run(spec2);
	assert.equal(r2.exitCode, 0, r2.stderr);
	assert.match(r2.stdout, /K/, "the program sees the file in the new directory");
	assert.equal(provider.created, 1, "the sandbox is reused");
	assert.equal(a.box().text("/srv/wr/keep.txt"), "K", "everything was uploaded again into the new directory");
	assert.equal(a.box().text("/work/keep.txt"), "K", "the old directory is not touched");
	assert.match(r2.stderr, /沙箱工作目录已从 \/work 改为 \/srv\/wr/);
	assert.equal(db.get<{ work_dir: string }>("SELECT work_dir FROM tool_sandbox_instances")!.work_dir, "/srv/wr");
	// not again
	const uploads = () => a.box().writes.filter((p) => !p.startsWith("/tmp/")).length; // (the program file itself goes to /tmp)
	const w = uploads();
	const r3 = await b.run({ ...a.spec("echo x") });
	assert.ok(!/工作目录已从/.test(r3.stderr));
	assert.equal(uploads(), w, "nothing re-uploaded the third time");
});

test("RemoteDrivers: the fingerprint includes the working directory (a change rebuilds the driver); layoutFor reads configuration only", async () => {
	const db = new AppDb(":memory:");
	db.migrate("sandbox-test", SANDBOX_MIGRATIONS);
	const provider = new FakeRemoteProvider();
	let workDir: string | undefined;
	let built = 0;
	let eff: any = { kind: "provider", provider: "daytona", orgId: "org1" };
	const cfg = {
		effectiveFor: () => eff,
		explain: () => "",
		connection: async () => ({ provider: "opensandbox" as const, endpoint: "http://x", apiKey: "k", ...(workDir ? { workDir } : {}) }),
		lifecycle: () => ({ createTimeoutSec: 10, idlePauseSec: 60, pausedRetentionSec: 600, destroyAfterSec: 3600 }),
		workDirOf: () => workDir,
		factory: async () => (built++, provider),
	};
	const rd = new RemoteDrivers({ db } as any, { configs: () => cfg });
	const space = { id: "s1", orgId: "org1", kind: "personal", dir: "/x" } as any;
	assert.deepEqual(rd.layoutFor(space), { provider: "daytona", workDir: "/home/daytona/work", skillsRoot: "/home/daytona/skills" }, "deterministic default for daytona");
	eff = { kind: "provider", provider: "e2b", orgId: "org1" };
	assert.equal(rd.layoutFor(space)!.workDir, "/home/user/work");
	eff = { kind: "provider", provider: "opensandbox", orgId: "org1" };
	assert.deepEqual(rd.layoutFor(space), { provider: "opensandbox", workDir: "/work", skillsRoot: "/skills" });
	const d1 = await rd.forSpace(space);
	assert.equal(d1!.workDir, "/work");
	assert.equal(await rd.forSpace(space), d1, "cached while nothing changed");
	assert.equal(built, 1);
	workDir = "/home/x/work";
	assert.deepEqual(rd.layoutFor(space), { provider: "opensandbox", workDir: "/home/x/work", skillsRoot: "/home/x/skills" });
	const d2 = await rd.forSpace(space);
	assert.notEqual(d2, d1, "a changed working directory rebuilds the driver");
	assert.equal(d2!.workDir, "/home/x/work");
	assert.equal(built, 2);
	eff = { kind: "local" };
	assert.equal(rd.layoutFor(space), null, "local drivers: null");
});

// ------------------------------------------------------------------------------------------------ whole app: provider config, layout, paths, outputs, prompt, environment
async function appWithProvider(email: string) {
	const t = await startTestApp({ config: { secretKey: "workroom-test-secret-key-0123456789" } });
	const a = await t.user(email);
	const ctx = t.app.ctx;
	const svc = providerConfigsFor(ctx);
	svc.resolver = async () => [{ address: "93.184.216.34", family: 4 }];
	const fake = nonRoot();
	svc.factory = async () => fake;
	const identity = ctx.services.get("identity");
	const principal = (await identity.principalFor(a.me.userId, a.me.orgId))!;
	const space = identity.personalSpace(a.me.userId, a.me.orgId);
	const sb = ctx.services.get("sandbox") as Sandbox;
	await svc.update(principal, "opensandbox", { endpoint: "https://os.example.com", apiKey: "os-key-123456789", enabled: true, egressAcknowledged: true });
	return { t, a, ctx, svc, fake, principal, space, sb };
}

test("provider config: workDir is validated, normalised, stored, shown (with the default), cleared by null/\"\", audited by field name only", async () => {
	const { t, svc, principal, ctx } = await appWithProvider("wd-cfg@example.com");
	try {
		const d0 = svc.dto(principal, "opensandbox");
		assert.equal(d0.workDir, undefined);
		assert.equal(d0.defaultWorkDir, "/work");
		assert.equal(svc.dto(principal, "daytona").defaultWorkDir, "/home/daytona/work");
		assert.equal(svc.dto(principal, "e2b").defaultWorkDir, "/home/user/work");

		const set = await svc.update(principal, "opensandbox", { workDir: "/home/daytona/work/" });
		assert.equal(set.workDir, "/home/daytona/work", "normalised");
		assert.equal(svc.effectiveWorkDir(principal.orgId, "opensandbox"), "/home/daytona/work");
		assert.equal((await svc.connection(principal.orgId, "opensandbox"))!.workDir, "/home/daytona/work", "passed to the driver through ProviderConnection");
		// editing something else keeps it
		assert.equal((await svc.update(principal, "opensandbox", { template: "base" })).workDir, "/home/daytona/work");

		for (const bad of ["relative/dir", "/", "/etc", "/usr/local/x", "/home/a/../b", "/proc", "/dev/x", "/lib64", "/boot", "/run", "/var/run/x", `/${"a".repeat(250)}`, "/home/x y", 5]) {
			await assert.rejects(svc.update(principal, "opensandbox", { workDir: bad as any }), (e: any) => e.status === 400 && e.code === "invalid_workdir", String(bad));
		}
		assert.equal(svc.dto(principal, "opensandbox").workDir, "/home/daytona/work", "a refused value changes nothing");

		for (const clear of [null, "", "   "]) {
			await svc.update(principal, "opensandbox", { workDir: "/data/wr" });
			const c = await svc.update(principal, "opensandbox", { workDir: clear as any });
			assert.equal(c.workDir, undefined, JSON.stringify(clear));
			assert.equal(svc.effectiveWorkDir(principal.orgId, "opensandbox"), "/work");
			assert.equal((await svc.connection(principal.orgId, "opensandbox"))!.workDir, undefined);
		}
		const audit = ctx.db.all<{ detail: string }>("SELECT detail FROM id_audit WHERE action = 'sandbox.provider.update' ORDER BY at");
		assert.ok(audit.some((r) => JSON.parse(r.detail).changed?.includes("workDir")));
	} finally {
		await t.dispose();
	}
});

test("whole path: configured working directory + non-root fake → run works, tools accept relative, /work/… and real-prefixed paths and print the real path; skills paths are real", async () => {
	const { t, a, ctx, svc, fake, principal, space, sb } = await appWithProvider("wd-run@example.com");
	try {
		await svc.update(principal, "opensandbox", { workDir: "/home/daytona/work" });
		await svc.setPolicy(principal, { orgDefault: "opensandbox" });
		const W = "/home/daytona/work";
		assert.deepEqual(sb.layout(space), { kind: "remote", provider: "opensandbox", workDir: W, skillsRoot: "/home/daytona/skills" });

		// 1) a run works (this is the reported bug: it used to fail with "mkdir: cannot create directory '/work': Permission denied")
		const run = await sb.run({ principal, space, conversationId: 4, language: "python", code: "echo via-remote\nwrite made.txt hi" });
		assert.equal(run.status, "ok", run.stderr);
		assert.equal(readFileSync(join(sb.workdir(space, 4), "made.txt"), "utf8"), "hi");
		assert.equal([...fake.boxes.values()][0]!.lastRun!.cwd, W);
		assert.equal(sb.info ? (await sb.info(space)).workDir : W, W);

		// 2) file tools: three spellings → one host-relative path
		const wd = sb.workdir(space, 4);
		assert.equal(sb.writeFile(space, 4, "a.txt", new TextEncoder().encode("1")), "a.txt");
		assert.equal(sb.writeFile(space, 4, "/work/b.txt", new TextEncoder().encode("2")), "b.txt");
		assert.equal(sb.writeFile(space, 4, `${W}/c.txt`, new TextEncoder().encode("3")), "c.txt");
		assert.equal(sb.writeFile(space, 4, `${W}/sub/d.txt`, new TextEncoder().encode("4")), "sub/d.txt");
		for (const f of ["a.txt", "b.txt", "c.txt", "sub/d.txt"]) assert.ok(existsSync(join(wd, f)), f);
		for (const p of ["c.txt", "/work/c.txt", `${W}/c.txt`]) assert.equal(new TextDecoder().decode(sb.readFile(space, 4, p).bytes), "3", p);
		assert.equal(sb.relPath(space, `${W}/sub/d.txt`), "sub/d.txt");
		assert.equal(sb.shown(space, "sub/d.txt"), `${W}/sub/d.txt`);
		assert.equal(sb.mkdir(space, 4, `${W}/newdir`), "newdir");
		sb.move(space, 4, `${W}/a.txt`, "/work/moved.txt");
		assert.ok(existsSync(join(wd, "moved.txt")) && !existsSync(join(wd, "a.txt")));
		sb.remove(space, 4, `${W}/moved.txt`);
		assert.ok(!existsSync(join(wd, "moved.txt")));
		assert.throws(() => sb.readFile(space, 4, `${W}/../etc/passwd`), /工作目录内/);
		assert.throws(() => sb.readFile(space, 4, "/etc/passwd"), (e: any) => e.status === 404 || e.status === 400 || /ENOENT|不存在/.test(String(e.message)), "an unrelated absolute path is just a (missing) relative one, never the host's /etc");

		// 3) the agent tools print the real path and describe the directory generically
		const ext = createSandboxExtension(ctx, { resolveActor: fixedActor(ctx, a.me.userId, a.me.orgId, space.id) });
		const tool = (name: string) => ext.tools!.find((x) => x.name === name)!;
		let n = 0;
		const call = (name: string, args: Record<string, unknown>) => tool(name).execute(args as any, fakeApi({ conversationId: 4, taskId: ++n, callId: `w${n}` }), context) as Promise<{ output: { text: string }[]; isError?: boolean }>;
		assert.match((await call("sandbox_write_file", { path: "out/r.txt", content: "abc" })).output[0]!.text, new RegExp(`已写入 ${W}/out/r\\.txt（3 字节）`));
		assert.match((await call("sandbox_write_file", { path: `${W}/out/r2.txt`, content: "abcd" })).output[0]!.text, new RegExp(`已写入 ${W}/out/r2\\.txt（4 字节）`));
		assert.match((await call("sandbox_read_file", { path: `${W}/out/r.txt` })).output[0]!.text, /abc/);
		for (const tl of ext.tools!) assert.ok(!/\/work\b/.test(tl.description ?? ""), `${tl.name} description must not hardcode /work`);
		assert.match(tool("sandbox_exec").description ?? "", /system prompt/);

		// 4) the system prompt section follows the CURRENT configuration
		const rt = ctx.services.get("runtime") as any;
		const orig = rt.promptScope;
		rt.promptScope = async () => ({ space, principal });
		try {
			const render = async () => ext.sections!.find((s) => s.key === "sandbox")!.render({} as any, context);
			const t1 = (await render())!;
			assert.match(t1, /云端沙箱 OpenSandbox/);
			assert.match(t1, new RegExp(`工作目录：${W}`));
			assert.match(t1, /\/home\/daytona\/skills\//);
			await svc.update(principal, "opensandbox", { workDir: "/data/wr2" });
			const t2 = (await render())!;
			assert.match(t2, /工作目录：\/data\/wr2/);
			assert.notEqual(t1, t2, "re-rendered for the next request: not frozen at conversation start");
			await svc.update(principal, "opensandbox", { workDir: "" });
			assert.match((await render())!, /工作目录：\/work/);
			// switching to the platform's own sandbox changes the section too
			await svc.setPolicy(principal, { orgDefault: "local" });
			const t3 = (await render())!;
			assert.match(t3, /平台内置沙箱/);
			assert.match(t3, /工作目录：\/work/);
			assert.ok(!/云端沙箱/.test(t3));
			// no sandbox permission / revoked actor → no section
			rt.promptScope = async () => ({ space, principal: null });
			assert.equal(await render(), undefined);
			rt.promptScope = async () => null;
			assert.equal(await render(), undefined);
			// provider chosen but unusable → the section says so instead of describing a directory
			rt.promptScope = async () => ({ space, principal });
			await svc.update(principal, "opensandbox", { enabled: true });
			await svc.setPolicy(principal, { orgDefault: "opensandbox" });
			ctx.db.run("UPDATE tool_sandbox_providers SET api_key_sealed = NULL WHERE org_id = ? AND provider = 'opensandbox'", principal.orgId); // misconfigured behind the admin's back
			const t4 = (await render())!;
			assert.match(t4, /当前不可用/);
			assert.ok(!/工作目录：/.test(t4), "an unusable sandbox is not described as if it worked");
		} finally {
			rt.promptScope = orig;
		}
	} finally {
		await t.dispose();
	}
});

test("environment DTO exposes the real working directory and the skills directory (workDir, skillsDir)", async () => {
	const { t, svc, principal, space } = await appWithProvider("wd-env@example.com");
	try {
		const envs = environmentsFor(t.app.ctx);
		// local (default policy): /work and /skills
		const local = await envs.get(principal, space, 11);
		assert.equal(local.workDir, "/work");
		assert.equal(local.skillsDir, "/skills");
		// remote with a configured directory
		await svc.update(principal, "opensandbox", { workDir: "/home/daytona/work" });
		await svc.setPolicy(principal, { orgDefault: "opensandbox" });
		const remote = await envs.get(principal, space, 11);
		assert.equal(remote.kind, "remote");
		assert.equal(remote.label, "OpenSandbox（自托管）");
		assert.equal(remote.workDir, "/home/daytona/work");
		assert.equal(remote.skillsDir, "/home/daytona/skills");
		// default when empty
		await svc.update(principal, "opensandbox", { workDir: null });
		assert.equal((await envs.get(principal, space, 11)).workDir, "/work");
	} finally {
		await t.dispose();
	}
});

test("skill tool output: load/list print the skills directory of the ACTIVE sandbox", async () => {
	const { t, a, ctx, svc, principal, space } = await appWithProvider("wd-skill@example.com");
	try {
		await svc.update(principal, "opensandbox", { workDir: "/home/daytona/work" });
		await svc.setPolicy(principal, { orgDefault: "opensandbox" });
		const md = `---\nname: wd-skill\ndescription: d\nversion: 1.0.0\n---\n\n# wd\n`;
		await t.json("POST", "/api/market/skills/upload", { token: a.token, json: { files: [{ path: "SKILL.md", content: md }, { path: "references/n.txt", content: "n" }] } });
		const ext = createSkillsExtension(ctx, { resolveActor: fixedActor(ctx, a.me.userId, a.me.orgId, space.id) });
		const tool = ext.tools!.find((x) => x.name === "skill")!;
		let n = 0;
		const text = async (args: Record<string, unknown>) => ((await tool.execute(args as any, fakeApi({ conversationId: 6, taskId: ++n, callId: `s${n}` }), context)) as any).output[0].text as string;
		const list = await text({ action: "list" });
		assert.match(list, /\/home\/daytona\/skills\/wd-skill[，/]/);
		assert.ok(!/（\/skills\//.test(list));
		const load = await text({ action: "load", name: "wd-skill" });
		assert.match(load, /dir="\/home\/daytona\/skills\/wd-skill"/);
		assert.match(load, /挂载在 \/home\/daytona\/skills\/wd-skill\//);
		// local again → /skills
		await svc.setPolicy(principal, { orgDefault: "local" });
		assert.match(await text({ action: "list" }), /（\/skills\/wd-skill，/);
	} finally {
		await t.dispose();
	}
});
