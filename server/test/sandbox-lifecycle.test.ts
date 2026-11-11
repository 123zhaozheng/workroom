// Round 11 (R1 + R3): remote sandbox lifecycle — states, idle pause, retention/archive, destroy-after, resume, recreate mode, events.
// FAKE = the labelled in-memory test double (server/test/helpers/fake-remote-provider.ts, with and without pause support): it proves Workroom's own
// state machine, locking and bookkeeping. It proves nothing about a vendor; the live OpenSandbox pause/resume is covered by the LIVE test at the end
// (skipped with a reason unless WORKROOM_TEST_OPENSANDBOX_URL / _KEY are set).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDb } from "../src/core/db.ts";
import { DEFAULT_LIMITS, SANDBOX_MIGRATIONS } from "../src/tools/sandbox.ts";
import { RemoteDriver, instancesFor } from "../src/tools/sandbox/remote-driver.ts";
import { recordSandboxEvent, sandboxEventsOf, conversationIdOf } from "../src/tools/sandbox/lifecycle-events.ts";
import { PROVIDER_CONFIG_MIGRATIONS, providerConfigsFor } from "../src/tools/sandbox/provider-config.ts";
import { DEFAULT_LIFECYCLE, type LifecyclePolicy } from "../src/tools/sandbox/provider.ts";
import type { DriverRunSpec } from "../src/tools/sandbox/driver.ts";
import { startTestApp } from "./helpers/app.ts";
import { FakeRemoteProvider, type FakeLifecycleOptions } from "./helpers/fake-remote-provider.ts";
import { createRemoteProvider } from "../src/tools/sandbox/providers/index.ts";
import type { Sandbox } from "../src/tools/sandbox.ts";
import type { ConversationEnvironmentDTO } from "../../shared/sandbox.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const LC: LifecyclePolicy = { createTimeoutSec: 30, idlePauseSec: 300, pausedRetentionSec: 86_400, destroyAfterSec: 604_800 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(life: FakeLifecycleOptions = {}, lifecycle: LifecyclePolicy = LC) {
	const root = mkdtempSync(join(tmpdir(), "wr-life-"));
	const clock = { t: Date.UTC(2026, 10, 11, 8, 0, 0) };
	const db = new AppDb(":memory:");
	db.migrate("sandbox-test", SANDBOX_MIGRATIONS);
	const provider = new FakeRemoteProvider(life);
	provider.hooks.create = () => void (clock.t += 1500); // cold start takes 1.5 s
	provider.hooks.resume = () => void (clock.t += 700); // resume takes 0.7 s
	provider.hooks.pause = () => void (clock.t += 400);
	const driver = new RemoteDriver({ db, provider, orgId: "org1", lifecycle, now: () => clock.t });
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
	const events = () => sandboxEventsOf(db, "org1", "s1", 1);
	const row = () => instancesFor(db, "org1")[0]!;
	return { root, clock, db, provider, driver, wd, spec, events, row, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
test("provider pause: ready → (idle < 5 min: nothing) → paused → resumed on the next run; files and installed state survive, only changed host files are uploaded", async () => {
	const t = setup({ pause: true });
	try {
		const first = await t.driver.run(t.spec("write a.txt keep-me\nwrite deps.txt installed"));
		assert.equal(first.exitCode, 0);
		const ranAt = t.clock.t;
		assert.equal(t.row().state, "ready");
		// vendor-side hints and timeout: slightly above the idle-pause time (300 s + 120 s margin + the 5 s command), extended by keepAlive on every use
		const created = [...t.provider.boxes.values()][0]!;
		assert.equal(created.createOptions.lifetimeMs, (300 + 120) * 1000 + 5000);
		assert.deepEqual(created.createOptions.lifecycle, { idlePauseSec: 300, pausedRetentionSec: 86_400, destroyAfterSec: 604_800 });

		t.clock.t = ranAt + 4 * MIN + 59_000;
		assert.equal(await t.driver.reapIdle(), 0, "idle 4:59 < idlePause");
		assert.equal(t.row().state, "ready");

		t.clock.t = ranAt + 5 * MIN;
		assert.equal(await t.driver.reapIdle(), 1);
		assert.equal(t.row().state, "paused");
		assert.equal(t.row().resumeMode, "provider");
		assert.equal(t.provider.pauseCalls.length, 1);
		assert.equal(t.provider.pauseCalls[0]!.retainMs, (86_400 + 120) * 1000, "the provider must keep it for the fast-resume window plus slack");
		assert.equal(t.provider.destroyedIds.length, 0, "pausing is not destroying");
		assert.equal(await t.driver.reapIdle(), 0, "a second pass does nothing");

		// the user (or another tool) changed the host workspace while it was paused
		writeFileSync(join(t.wd, "b.txt"), "from-host");
		const writesBefore = created.writes.length;
		t.clock.t += 10 * MIN;
		const r = await t.driver.run(t.spec("cat a.txt\ncat deps.txt\ncat b.txt"));
		assert.equal(r.exitCode, 0);
		assert.equal(r.stdout, "keep-me\ninstalled\nfrom-host\n", "files and in-sandbox state survived; the host change was synced after the resume");
		assert.equal(t.provider.created, 1, "resumed, not recreated");
		assert.equal(t.provider.resumeCalls.length, 1);
		const uploaded = created.writes.slice(writesBefore).filter((p) => p.startsWith("/work/"));
		assert.deepEqual(uploaded, ["/work/b.txt"], "manifest sync: only the changed file went up");
		assert.equal(t.row().state, "ready");
		assert.equal(t.provider.keepAliveCalls.at(-1)!.ms, (300 + 120) * 1000 + 5000, "the vendor timeout is extended after the resume");
		assert.doesNotMatch(r.stderr, /重新创建|恢复/, "a fast resume needs no note");

		// events: create (cold start), pause (running time), resume (resume time)
		const ev = t.events();
		assert.deepEqual(ev.map((e) => [e.kind, e.trigger]), [["create", "exec"], ["pause", "idle"], ["resume", "exec"]]);
		assert.equal(ev[0]!.duration_ms, 1500);
		assert.equal(ev[0]!.running_ms, null);
		assert.equal(ev[1]!.running_ms, 5 * MIN + 0, "running time = pause moment − last create (clock at the pass start)");
		assert.equal(ev[2]!.duration_ms, 700);
		assert.ok(ev.every((e) => e.conversation_id === 1 && e.provider === "opensandbox" && e.org_id === "org1" && e.space_id === "s1"));
	} finally {
		t.cleanup();
	}
});

test("busy instance is never paused; once the run is over the pass pauses it (and a destroy-after pass never touches a running one either)", async () => {
	const t = setup({ pause: true });
	try {
		await t.driver.run(t.spec("echo warm"));
		t.clock.t += 20 * MIN;
		const busy = t.driver.run(t.spec("sleep 250"));
		await sleep(40);
		t.clock.t += 30 * DAY; // far beyond every threshold
		assert.equal(await t.driver.reapIdle(), 0, "a run is in progress");
		assert.equal(t.provider.pauseCalls.length, 0);
		assert.equal(t.provider.destroyedIds.length, 0);
		assert.equal((await busy).exitCode, 0);
		assert.equal(t.row().state, "ready");
		t.clock.t += 6 * MIN;
		assert.equal(await t.driver.reapIdle(), 1);
		assert.equal(t.row().state, "paused");
	} finally {
		t.cleanup();
	}
});

test("a run that arrives while the sandbox is being paused waits for the pause, then resumes it and runs", async () => {
	const t = setup({ pause: true });
	try {
		await t.driver.run(t.spec("write a.txt before"));
		t.clock.t += 6 * MIN;
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const orig = t.provider.pause!;
		t.provider.pause = async (id, o) => {
			await gate; // the vendor is slow to pause
			return orig(id, o);
		};
		const reaping = t.driver.reapIdle();
		await sleep(40);
		assert.equal(t.db.get<{ state: string }>("SELECT state FROM tool_sandbox_instances")!.state, "pausing");
		const run = t.driver.run(t.spec("cat a.txt\necho after"));
		let finished = false;
		void run.then(() => (finished = true));
		await sleep(60);
		assert.equal(finished, false, "the run waits on the per-workspace lock the pause holds");
		assert.equal(t.provider.resumeCalls.length, 0);
		release();
		assert.equal(await reaping, 1);
		const r = await run;
		assert.equal(r.exitCode, 0, r.stderr);
		assert.equal(r.stdout, "before\nafter\n");
		assert.equal(t.provider.pauseCalls.length, 1);
		assert.equal(t.provider.resumeCalls.length, 1);
		assert.equal(t.provider.created, 1);
		assert.deepEqual(t.events().map((e) => e.kind), ["create", "pause", "resume"]);
	} finally {
		t.cleanup();
	}
});

test("a pause that is queued behind a run does not pause a sandbox that was just used (the decision is re-made inside the lock)", async () => {
	const t = setup({ pause: true });
	try {
		await t.driver.run(t.spec("echo one"));
		t.clock.t += 10 * MIN; // idle long enough for a pause ...
		const slow = t.driver.run(t.spec("sleep 120\necho done")); // ... but a run takes the lock first
		await sleep(20);
		const reaping = t.driver.reapIdle(); // sees the busy instance and skips it
		assert.equal(await reaping, 0);
		assert.equal((await slow).exitCode, 0);
		assert.equal(t.row().state, "ready");
		assert.equal(await t.driver.reapIdle(), 0, "last_used_at was just refreshed by that run");
		assert.equal(t.provider.pauseCalls.length, 0);
	} finally {
		t.cleanup();
	}
});

test("retention: paused longer than the fast-resume window → archived (provider can archive); resume from archived works and is marked", async () => {
	const t = setup({ pause: true, archive: true });
	try {
		await t.driver.run(t.spec("write a.txt cold"));
		const ranAt = t.clock.t;
		t.clock.t = ranAt + 5 * MIN;
		assert.equal(await t.driver.reapIdle(), 1);
		const pausedAt = t.clock.t;
		t.clock.t = pausedAt + 86_400_000 - 1000;
		assert.equal(await t.driver.reapIdle(), 0, "1 s before the window ends");
		assert.equal(t.row().state, "paused");
		t.clock.t = pausedAt + 86_400_000;
		assert.equal(await t.driver.reapIdle(), 1);
		assert.equal(t.row().state, "archived");
		assert.equal(t.row().resumeMode, "provider");
		assert.equal(t.provider.archiveCalls.length, 1);
		assert.equal(t.provider.destroyedIds.length, 0);
		// an explicit / prewarm prepare resumes it; the trigger is recorded
		await t.driver.prepare(t.spec("true", { trigger: "prewarm" }));
		assert.equal(t.row().state, "ready");
		const ev = t.events();
		assert.deepEqual(ev.map((e) => [e.kind, e.trigger, e.detail]), [["create", "exec", null], ["pause", "idle", null], ["archive", "retention", null], ["resume", "prewarm", "from_archived"]]);
		const r = await t.driver.run(t.spec("cat a.txt"));
		assert.equal(r.stdout, "cold\n");
	} finally {
		t.cleanup();
	}
});

test("retention on a provider that cannot archive: the sandbox just stays paused", async () => {
	const t = setup({ pause: true });
	try {
		await t.driver.run(t.spec("echo x"));
		t.clock.t += 5 * MIN;
		await t.driver.reapIdle();
		t.clock.t += 3 * DAY;
		assert.equal(await t.driver.reapIdle(), 0);
		assert.equal(t.row().state, "paused");
		assert.equal(t.events().some((e) => e.kind === "archive"), false);
	} finally {
		t.cleanup();
	}
});

test("destroyAfter: unused for the destroy window → destroyed from paused, from archived and from (a missed) ready; the event carries the running time (0 when it was not running)", async () => {
	// paused → destroyed
	let t = setup({ pause: true });
	try {
		await t.driver.run(t.spec("echo x"));
		const ranAt = t.clock.t;
		t.clock.t = ranAt + 6 * MIN;
		await t.driver.reapIdle();
		t.clock.t = ranAt + 604_800_000 - 1000;
		assert.equal(await t.driver.reapIdle(), 0);
		t.clock.t = ranAt + 604_800_000;
		assert.equal(await t.driver.reapIdle(), 1);
		assert.equal(t.row().state, "destroyed");
		assert.equal(t.provider.destroyedIds.length, 1);
		const d = t.events().at(-1)!;
		assert.deepEqual([d.kind, d.trigger, d.running_ms], ["destroy", "expiry", 0]);
	} finally {
		t.cleanup();
	}
	// archived → destroyed
	t = setup({ pause: true, archive: true });
	try {
		await t.driver.run(t.spec("echo x"));
		const ranAt = t.clock.t;
		t.clock.t = ranAt + 5 * MIN;
		await t.driver.reapIdle();
		t.clock.t = ranAt + 2 * DAY;
		await t.driver.reapIdle();
		assert.equal(t.row().state, "archived");
		t.clock.t = ranAt + 7 * DAY;
		assert.equal(await t.driver.reapIdle(), 1);
		assert.equal(t.row().state, "destroyed");
		assert.equal(t.provider.destroyedIds.length, 1);
	} finally {
		t.cleanup();
	}
	// a ready sandbox the reaper never got to (process was down) is destroyed, not paused
	t = setup({ pause: true });
	try {
		await t.driver.run(t.spec("echo x"));
		t.clock.t += 8 * DAY;
		assert.equal(await t.driver.reapIdle(), 1);
		assert.equal(t.row().state, "destroyed");
		assert.equal(t.provider.pauseCalls.length, 0);
		const d = t.events().at(-1)!;
		assert.deepEqual([d.kind, d.trigger], ["destroy", "expiry"]);
		assert.ok(d.running_ms! > 0, "it was running (idle) the whole time");
	} finally {
		t.cleanup();
	}
});

test("resume failure → recreate + full resync with a note (never a host fallback); the failure is an event, the new sandbox a create event", async () => {
	for (const how of ["error", "gone"] as const) {
		const t = setup({ pause: true });
		try {
			await t.driver.run(t.spec("write a.txt persisted\nwrite sub/c.txt deep"));
			t.clock.t += 6 * MIN;
			await t.driver.reapIdle();
			const first = [...t.provider.boxes.values()][0]!;
			if (how === "error") t.provider.failResume = new Error("vendor says no (token=abcdef123456)");
			else t.provider.kill(first.id); // deleted behind our back while paused
			const r = await t.driver.run(t.spec("cat a.txt\ncat sub/c.txt"));
			assert.equal(r.exitCode, 0, r.stderr);
			assert.equal(r.stdout, "persisted\ndeep\n", "the host workspace was uploaded in full to the new sandbox");
			assert.equal(t.provider.created, 2);
			assert.match(r.stderr, /恢复已暂停的远端沙箱失败.*重新创建.*重新同步/);
			assert.doesNotMatch(r.stderr, /abcdef123456/, "vendor text is scrubbed");
			const second = [...t.provider.boxes.values()][1]!;
			assert.ok(second.writes.includes("/work/a.txt") && second.writes.includes("/work/sub/c.txt"), "full resync");
			const ev = t.events();
			assert.deepEqual(ev.map((e) => e.kind), ["create", "pause", "resume_failed", "create"]);
			assert.equal(ev[3]!.detail, "after_resume_failed");
			assert.ok(ev[2]!.detail && !ev[2]!.detail.includes("abcdef123456"));
			const rows = instancesFor(t.db, "org1");
			assert.equal(rows.filter((x) => x.state === "ready").length, 1);
			assert.equal(rows.filter((x) => x.state === "lost").length, 1);
		} finally {
			t.cleanup();
		}
	}
});

test("recreate mode (provider cannot pause): idle → the sandbox is destroyed and the row says paused/recreate; the next run rebuilds it from the host workspace with a note", async () => {
	const t = setup(); // no pause support
	try {
		assert.equal(t.provider.pause, undefined);
		await t.driver.run(t.spec("write a.txt survives"));
		t.clock.t += 5 * MIN;
		assert.equal(await t.driver.reapIdle(), 1);
		assert.equal(t.row().state, "paused");
		assert.equal(t.row().resumeMode, "recreate");
		assert.equal(t.row().remoteId, null);
		assert.equal(t.provider.destroyedIds.length, 1, "nothing in flight → destroyed");
		assert.equal([...t.provider.boxes.values()][0]!.alive, false);
		assert.equal(await t.driver.reapIdle(), 0);

		t.clock.t += 20 * MIN;
		const r = await t.driver.run(t.spec("cat a.txt"));
		assert.equal(r.stdout, "survives\n", "files come back from the host workspace");
		assert.match(r.stderr, /因空闲已回收.*重新创建.*依赖需要重新安装/);
		assert.equal(t.provider.created, 2);
		const rows = instancesFor(t.db, "org1");
		assert.deepEqual(rows.map((x) => x.state).sort(), ["destroyed", "ready"]);
		const ev = t.events();
		assert.deepEqual(ev.map((e) => [e.kind, e.trigger, e.detail]), [["create", "exec", null], ["pause", "idle", "recreate"], ["create", "exec", "after_pause_recreate"]]);
		assert.equal(ev[2]!.duration_ms, 1500);
		// and it keeps cycling
		t.clock.t += 6 * MIN;
		assert.equal(await t.driver.reapIdle(), 1);
		assert.equal(t.row().resumeMode, "recreate");
	} finally {
		t.cleanup();
	}
});

test("recreate mode: busy is never recycled; a paused/recreate row is closed (no provider call) after destroyAfter", async () => {
	const t = setup();
	try {
		await t.driver.run(t.spec("echo x"));
		t.clock.t += 30 * MIN;
		const busy = t.driver.run(t.spec("sleep 200"));
		await sleep(30);
		t.clock.t += 40 * DAY;
		assert.equal(await t.driver.reapIdle(), 0);
		assert.equal(t.provider.destroyedIds.length, 0, "a busy sandbox is never destroyed or recycled");
		await busy;
		t.clock.t += 6 * MIN;
		assert.equal(await t.driver.reapIdle(), 1);
		assert.equal(t.provider.destroyedIds.length, 1);
		t.clock.t += 8 * DAY;
		assert.equal(await t.driver.reapIdle(), 1);
		assert.equal(t.row().state, "destroyed");
		assert.equal(t.provider.destroyedIds.length, 1, "the remote sandbox was already gone");
	} finally {
		t.cleanup();
	}
});

test("pause failure: the sandbox stays ready (still usable), the error is visible and the next pass retries; stuck pausing/resuming rows are healed", async () => {
	const t = setup({ pause: true });
	try {
		await t.driver.run(t.spec("echo x"));
		t.clock.t += 6 * MIN;
		t.provider.failPause = new Error("vendor busy");
		assert.equal(await t.driver.reapIdle(), 0);
		assert.equal(t.row().state, "ready");
		assert.match(t.row().lastError ?? "", /暂停失败.*vendor busy/);
		assert.equal(t.events().some((e) => e.kind === "pause"), false);
		t.provider.failPause = undefined;
		assert.equal(await t.driver.reapIdle(), 1);
		assert.equal(t.row().state, "paused");
		// a process died in the middle of a pause / resume: the rows must not stay stuck
		const id = t.row().id;
		t.db.run("UPDATE tool_sandbox_instances SET state = 'resuming', state_at = ? WHERE id = ?", new Date(t.clock.t - HOUR).toISOString(), id);
		assert.equal(await t.driver.reapIdle(), 1);
		assert.equal(t.row().state, "paused");
		t.db.run("UPDATE tool_sandbox_instances SET state = 'pausing', state_at = ? WHERE id = ?", new Date(t.clock.t - HOUR).toISOString(), id);
		assert.equal(await t.driver.reapIdle(), 1);
		assert.equal(t.row().state, "ready");
	} finally {
		t.cleanup();
	}
});

test("admin destroy of a paused instance is an event with trigger admin; create failures are events with the failed duration", async () => {
	const t = setup({ pause: true });
	try {
		t.provider.failCreate = new Error("quota exceeded (key=sk-secret-123456789)");
		await assert.rejects(t.driver.prepare(t.spec("true", { trigger: "prewarm" })), /创建沙箱失败/);
		let ev = t.events();
		assert.deepEqual([ev[0]!.kind, ev[0]!.trigger, ev[0]!.duration_ms], ["create_failed", "prewarm", 1500]);
		assert.ok(!ev[0]!.detail!.includes("sk-secret-123456789"));
		t.provider.failCreate = undefined;
		await t.driver.run(t.spec("echo x"));
		t.clock.t += 6 * MIN;
		await t.driver.reapIdle();
		const id = t.row().id;
		assert.equal(await t.driver.destroyInstance(id), true);
		ev = t.events();
		assert.deepEqual(ev.at(-1) && [ev.at(-1)!.kind, ev.at(-1)!.trigger, ev.at(-1)!.running_ms], ["destroy", "admin", 0]);
		assert.equal(t.row().state, "destroyed");
	} finally {
		t.cleanup();
	}
});

// ---------------------------------------------------------------------------------------------------------------------------------
test("migrations: old instance rows survive the table rebuild (hard expiry dropped, state_at filled), the live-unique index covers paused rows; provider rows get the new lifecycle defaults", () => {
	const db = new AppDb(":memory:");
	db.migrate("sandbox-test", SANDBOX_MIGRATIONS.filter((m) => m.version <= 4));
	db.run(
		"INSERT INTO tool_sandbox_instances (id, provider, space_id, workspace_key, remote_id, state, created_at, last_used_at, expires_at, org_id, manifest, network, work_dir) VALUES ('old1','opensandbox','s1','c1','r1','ready','2026-11-01T00:00:00.000Z','2026-11-01T01:00:00.000Z','2026-11-01T04:00:00.000Z','org1','{\"a\":\"x\"}',1,'/work')",
	);
	db.run("INSERT INTO tool_sandbox_instances (id, provider, space_id, workspace_key, remote_id, state, created_at, last_used_at, expires_at, org_id, manifest, network) VALUES ('old2','opensandbox','s1','c2',NULL,'destroyed','2026-11-01T00:00:00.000Z','2026-11-01T01:00:00.000Z','2026-11-01T04:00:00.000Z','org1','{}',1)");
	db.migrate("sandbox-test", SANDBOX_MIGRATIONS);
	const ready = db.get<Record<string, unknown>>("SELECT * FROM tool_sandbox_instances WHERE id = 'old1'")!;
	assert.equal(ready.state, "ready");
	assert.equal(ready.remote_id, "r1");
	assert.equal(ready.manifest, '{"a":"x"}');
	assert.equal(ready.work_dir, "/work");
	assert.equal(ready.expires_at, null, "the old 4 h hard lifetime is gone for live rows");
	assert.equal(ready.state_at, "2026-11-01T01:00:00.000Z");
	assert.equal(ready.resume_mode, null);
	assert.equal(db.get<{ expires_at: string | null }>("SELECT expires_at FROM tool_sandbox_instances WHERE id = 'old2'")!.expires_at, "2026-11-01T04:00:00.000Z", "terminal rows keep their history");
	// the new states are accepted and the live index covers them (one live instance per workspace)
	db.run("UPDATE tool_sandbox_instances SET state = 'paused', resume_mode = 'provider' WHERE id = 'old1'");
	assert.throws(() => db.run("INSERT INTO tool_sandbox_instances (id, provider, space_id, workspace_key, state, created_at, last_used_at, org_id) VALUES ('dup','opensandbox','s1','c1','creating','t','t','org1')"), /UNIQUE/);
	assert.throws(() => db.run("UPDATE tool_sandbox_instances SET state = 'sleeping' WHERE id = 'old1'"), /CHECK/);
	assert.throws(() => db.run("UPDATE tool_sandbox_instances SET resume_mode = 'x' WHERE id = 'old1'"), /CHECK/);
	// events table
	recordSandboxEvent(db, { orgId: "org1", spaceId: "s1", workspaceKey: "c12", provider: "e2b", kind: "pause", trigger: "idle", runningMs: 1234.6, at: "2026-11-11T00:00:00.000Z" });
	recordSandboxEvent(db, { orgId: "org1", spaceId: "s1", workspaceKey: "shared", provider: "e2b", kind: "destroy", trigger: "admin" });
	const evs = db.all<{ conversation_id: number | null; running_ms: number | null; duration_ms: number | null; trigger: string }>("SELECT * FROM tool_sandbox_events ORDER BY id");
	assert.deepEqual(evs.map((e) => [e.conversation_id, e.running_ms, e.duration_ms, e.trigger]), [[12, 1235, null, "idle"], [null, null, null, "admin"]]);
	assert.equal(conversationIdOf("c42"), 42);
	assert.equal(conversationIdOf("c-1"), null);
	// a bookkeeping failure never throws (bad kind violates the CHECK)
	assert.doesNotThrow(() => recordSandboxEvent(db, { orgId: "o", spaceId: "s", workspaceKey: "c1", provider: "e2b", kind: "nope" as never, trigger: "idle" }));

	// provider config columns: existing rows get the defaults; the old columns stay (an older build can still open the database)
	const pdb = new AppDb(":memory:");
	pdb.migrate("p", PROVIDER_CONFIG_MIGRATIONS.filter((m) => m.version <= 3));
	pdb.run("INSERT INTO tool_sandbox_providers (org_id, provider, enabled, create_timeout_sec, idle_timeout_sec, lifetime_sec, updated_by, updated_at) VALUES ('org1','e2b',0,60,900,7200,'u','t')");
	pdb.migrate("p", PROVIDER_CONFIG_MIGRATIONS);
	const pr = pdb.get<Record<string, number>>("SELECT * FROM tool_sandbox_providers")!;
	assert.deepEqual([pr.create_timeout_sec, pr.idle_pause_sec, pr.paused_retention_sec, pr.destroy_after_sec], [60, 300, 86_400, 604_800]);
	assert.deepEqual([pr.idle_timeout_sec, pr.lifetime_sec], [900, 7200]);
	assert.deepEqual(DEFAULT_LIFECYCLE, { createTimeoutSec: 120, idlePauseSec: 300, pausedRetentionSec: 86_400, destroyAfterSec: 604_800 });
});

// ---------------------------------------------------------------------------------------------------------------------------------
test("conversation DTO: paused (fast / recreate) and resuming states; GET never touches the provider; prepare with trigger explicit / prewarm is recorded; bad trigger → 400", async () => {
	const t = await startTestApp({ config: { secretKey: "workroom-test-secret-key-0123456789" } });
	try {
		const owner = await t.user("own@life.example");
		const ctx = t.app.ctx;
		const identity = ctx.services.get("identity");
		const space = identity.personalSpace(owner.me.userId, owner.me.orgId);
		const sb = ctx.services.get("sandbox") as Sandbox;
		const fake = new FakeRemoteProvider({ pause: true });
		const calls: string[] = [];
		const spied = new Proxy(fake, {
			get(target, prop, recv) {
				const v = Reflect.get(target, prop, recv);
				return typeof v === "function" && typeof prop === "string" && prop !== "constructor" ? (...a: unknown[]) => (calls.push(prop), (v as (...x: unknown[]) => unknown).apply(target, a)) : v;
			},
		}) as FakeRemoteProvider;
		const svc = providerConfigsFor(ctx);
		svc.resolver = async () => [{ address: "93.184.216.34", family: 4 }];
		svc.factory = async () => spied;
		await t.json("PUT", "/api/sandbox/providers/opensandbox", { token: owner.token, json: { enabled: true, endpoint: "https://os.example.test", apiKey: "sk-fake-life-0123456789", egressAcknowledged: true, idlePauseSec: 120, pausedRetentionSec: 3600, destroyAfterSec: 86_400 } });
		await t.json("PUT", "/api/sandbox/provider-policy", { token: owner.token, json: { orgDefault: "opensandbox", allowProjectOverride: false } });
		const path = `/api/conversations/${space.id}/7/environment`;
		const get = () => t.json<ConversationEnvironmentDTO>("GET", path, { token: owner.token });
		const prepare = (body?: unknown) => t.json<ConversationEnvironmentDTO>("POST", `${path}/prepare`, { token: owner.token, ...(body !== undefined ? { json: body } : {}) });

		assert.equal((await get()).state, "none");
		assert.equal((await prepare({ trigger: "explicit" })).state, "ready");
		await t.json("POST", `${path}/prepare`, { token: owner.token, json: { trigger: "prewarm" }, expect: 400 }); // a client cannot claim the server-internal prewarm trigger
		assert.equal(fake.created, 1);

		const driver = sb.remote.drivers()[0]!;
		assert.deepEqual([driver.lifecycle.idlePauseSec, driver.lifecycle.pausedRetentionSec, driver.lifecycle.destroyAfterSec], [120, 3600, 86_400], "per-provider configuration reaches the driver");
		assert.equal(await driver.reapIdle(Date.now() + 3 * MIN), 1);
		calls.length = 0;
		for (let i = 0; i < 3; i++) {
			const e = await get();
			assert.equal(e.state, "paused");
			assert.equal(e.resumeMode, "fast");
			assert.ok(e.updatedAt);
			assert.equal(e.kind, "remote");
		}
		assert.deepEqual(calls, [], "GET never touches the provider (no connect / list / health / pause / resume)");
		assert.equal(fake.resumeCalls.length, 0);

		// resuming is visible while the resume runs (the fake's resume hook reads the DTO from inside the resume)
		let during: ConversationEnvironmentDTO | undefined;
		const origResume = fake.resume!;
		fake.resume = async (id, signal) => {
			during = await get();
			return origResume(id, signal);
		};
		const after = await prepare({ trigger: "explicit" });
		assert.equal(during?.state, "resuming");
		assert.equal(during?.resumeMode, "fast");
		assert.equal(after.state, "ready");
		assert.equal(after.resumeMode, undefined);
		assert.equal(fake.created, 1);

		// prewarm (the server-internal path agent B uses) and the recorded triggers
		await driver.reapIdle(Date.now() + 10 * MIN);
		assert.equal((await get()).state, "paused");
		const { ConversationEnvironments } = await import("../src/tools/sandbox/environment.ts");
		const principal = (await identity.principalFor(owner.me.userId, owner.me.orgId))!;
		const envs = new ConversationEnvironments(ctx);
		assert.equal((await envs.prepare(principal, space, 7, undefined, { trigger: "prewarm" })).state, "ready");
		const kinds = sandboxEventsOf(ctx.db, owner.me.orgId, space.id, 7).map((e) => `${e.kind}:${e.trigger}`);
		assert.deepEqual(kinds, ["create:explicit", "pause:idle", "resume:explicit", "pause:idle", "resume:prewarm"]);

		// recreate mode as the DTO sees it
		const fake2 = new FakeRemoteProvider();
		svc.factory = async () => fake2;
		await t.json("PUT", "/api/sandbox/providers/opensandbox", { token: owner.token, json: { endpoint: "https://os2.example.test" } });
		const space2 = `/api/conversations/${space.id}/8/environment`;
		await t.json("POST", `${space2}/prepare`, { token: owner.token });
		const d2 = sb.remote.drivers().find((d) => d.provider === fake2)!;
		assert.ok((await d2.reapIdle(Date.now() + 3 * MIN)) >= 1);
		const e2 = await t.json<ConversationEnvironmentDTO>("GET", space2, { token: owner.token });
		assert.equal(e2.state, "paused");
		assert.equal(e2.resumeMode, "recreate");
	} finally {
		await t.dispose();
	}
});

// ---------------------------------------------------------------------------------------------------------------------------------
const LIVE_URL = process.env.WORKROOM_TEST_OPENSANDBOX_URL;
const LIVE_KEY = process.env.WORKROOM_TEST_OPENSANDBOX_KEY;
const skipLive = LIVE_URL && LIVE_KEY ? undefined : "LIVE: WORKROOM_TEST_OPENSANDBOX_URL / WORKROOM_TEST_OPENSANDBOX_KEY not set (scripts/opensandbox-local.sh)";

test("LIVE OpenSandbox · real pause/resume through RemoteDriver: idle → paused, a file and installed state survive the resume, timings are recorded, destroy cleans up", { skip: skipLive, timeout: 240_000 }, async () => {
	const provider = await createRemoteProvider({ provider: "opensandbox", endpoint: LIVE_URL!, apiKey: LIVE_KEY! });
	assert.equal(provider.capabilities.pauseResume, "supported");
	assert.equal(typeof provider.pause, "function");
	const root = mkdtempSync(join(tmpdir(), "wr-life-live-"));
	const db = new AppDb(":memory:");
	db.migrate("sandbox-live", SANDBOX_MIGRATIONS);
	const clock = { offset: 0 };
	const driver = new RemoteDriver({ db, provider, orgId: "org-live", lifecycle: { createTimeoutSec: 120, idlePauseSec: 300, pausedRetentionSec: 3600, destroyAfterSec: 86_400 }, now: () => Date.now() + clock.offset });
	const wd = join(root, "sandbox", "c1");
	mkdirSync(wd, { recursive: true });
	let n = 0;
	const spec = (code: string, o: Partial<DriverRunSpec> = {}): DriverRunSpec => ({ runId: `live_${++n}_${Math.random().toString(36).slice(2, 6)}`, tenant: { orgId: "org-live", spaceId: "s-live", workspaceKey: "c1" }, scratchBase: join(root, "sandbox"), workdir: wd, exec: { language: "shell", code }, limits: { ...DEFAULT_LIMITS, timeoutMs: 60_000 }, mounts: [], env: {}, network: true, ...o });
	try {
		// state that only a live sandbox keeps (outside the synced working directory): proves the SAME sandbox came back
		const a = await driver.run(spec("echo from-host > made-in-sandbox.txt; echo kept-in-tmp > /tmp/state.txt; echo ok"));
		assert.equal(a.exitCode, 0, a.stderr);
		const remoteId = db.get<{ remote_id: string }>("SELECT remote_id FROM tool_sandbox_instances")!.remote_id;
		clock.offset = 6 * MIN; // idle for 6 minutes
		assert.equal(await driver.reapIdle(), 1);
		const rows = instancesFor(db, "org-live");
		assert.equal(rows[0]!.state, "paused");
		assert.equal(rows[0]!.resumeMode, "provider");
		// a paused sandbox is really paused: the vendor says so
		const info = await fetch(`${LIVE_URL}/v1/sandboxes/${remoteId}`, { headers: { "OPEN-SANDBOX-API-KEY": LIVE_KEY! } }).then((r) => r.json() as Promise<{ status?: { state?: string } }>);
		assert.equal(info.status?.state, "Paused");
		const b = await driver.run(spec("cat /tmp/state.txt; cat made-in-sandbox.txt"));
		assert.equal(b.exitCode, 0, b.stderr);
		assert.equal(b.stdout, "kept-in-tmp\nfrom-host\n", "the paused sandbox itself came back (a recreate would have lost /tmp/state.txt)");
		assert.equal(db.get<{ remote_id: string }>("SELECT remote_id FROM tool_sandbox_instances WHERE state = 'ready'")!.remote_id, remoteId);
		const ev = sandboxEventsOf(db, "org-live", "s-live", 1);
		assert.deepEqual(ev.map((e) => e.kind), ["create", "pause", "resume"]);
		assert.ok(ev[0]!.duration_ms! > 0 && ev[2]!.duration_ms! > 0, "cold start and resume were measured");
		console.log(`[live] cold start ${ev[0]!.duration_ms} ms, resume ${ev[2]!.duration_ms} ms`);
		// destroy-after
		clock.offset = 6 * MIN + 2 * DAY;
		assert.equal(await driver.reapIdle(), 1);
		assert.equal(await provider.connect(remoteId), null, "destroyed for real");
	} finally {
		for (const r of db.all<{ remote_id: string | null }>("SELECT remote_id FROM tool_sandbox_instances WHERE remote_id IS NOT NULL")) if (r.remote_id) await provider.destroy(r.remote_id).catch(() => {});
		rmSync(root, { recursive: true, force: true });
		await (provider as { close?: () => Promise<void> }).close?.();
	}
});
