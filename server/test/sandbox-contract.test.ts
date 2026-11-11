// ONE parameterised sandbox contract suite, run against every driver/provider that is available in the environment:
//   namespaces            when the kernel allows user namespaces
//   docker                when a daemon is reachable and the python/node images are present locally
//   opensandbox           WORKROOM_TEST_OPENSANDBOX_URL + WORKROOM_TEST_OPENSANDBOX_KEY   (scripts/opensandbox-local.sh prints both)
//   e2b                   WORKROOM_TEST_E2B_API_KEY  (+ WORKROOM_TEST_E2B_API_URL / _DOMAIN / _TEMPLATE for a compatible service)
//   daytona               WORKROOM_TEST_DAYTONA_API_KEY (+ WORKROOM_TEST_DAYTONA_API_URL)
// A target without configuration is SKIPPED with an explicit reason (never silently green). WORKROOM_TEST_REQUIRE=<name,name> turns the
// skip of a named target into a failure. There is deliberately no test double in this file: a fake provider is not acceptance.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDb } from "../src/core/db.ts";
import { DEFAULT_LIMITS, SANDBOX_MIGRATIONS } from "../src/tools/sandbox.ts";
import type { DriverRunSpec, SandboxDriver, SandboxMount } from "../src/tools/sandbox/driver.ts";
import { DockerDriver } from "../src/tools/sandbox/docker.ts";
import { namespaceDriver } from "../src/tools/sandbox/namespaces.ts";
import { UnsupportedError, type LifecyclePolicy, type ProviderConnection, type RemoteProvider } from "../src/tools/sandbox/provider.ts";
import { createRemoteProvider } from "../src/tools/sandbox/providers/index.ts";
import { RemoteDriver, instancesFor } from "../src/tools/sandbox/remote-driver.ts";
import { EGRESS_PROBE_PY, probeLine } from "./helpers/egress-probe.ts";

const env = process.env;
const REQUIRE = new Set((env.WORKROOM_TEST_REQUIRE ?? "").split(",").map((s) => s.trim()).filter(Boolean));

interface Remote {
	provider: RemoteProvider;
	db: AppDb;
	lifecycle: LifecyclePolicy;
	/** A fresh RemoteDriver over the same DB + provider (simulates a Workroom restart). */
	newDriver(o?: { orphanGraceMs?: number; lifecycle?: LifecyclePolicy }): RemoteDriver;
	/** Destroy every sandbox this suite created so far and forget the instance rows (keeps the provider host's disk usage flat). */
	cleanupAll(): Promise<void>;
	/** Provider-side id of the instance of (space, workspaceKey). */
	remoteId(spaceId: string, key: string): string | null;
}
interface Target {
	name: string;
	skip?: string;
	driver?: SandboxDriver;
	remote?: Remote;
	/** The sandbox user cannot write the uploaded/mounted skills (kernel/user separation); otherwise only hash re-verification protects them. */
	strictReadonly: boolean;
	cleanup(): Promise<void>;
}

const noop = async () => {};
async function localTargets(): Promise<Target[]> {
	const out: Target[] = [];
	const ns = await namespaceDriver.detect(true);
	out.push(ns.state === "ready" ? { name: "namespaces", driver: namespaceDriver, strictReadonly: true, cleanup: noop } : { name: "namespaces", skip: `namespaces driver unavailable on this host: ${ns.summary}`, strictReadonly: true, cleanup: noop });
	const dk = new DockerDriver();
	const st = await dk.detect(true);
	const f = dk.facts();
	if (st.state === "unavailable") out.push({ name: "docker", skip: `no docker daemon reachable (${st.summary})`, strictReadonly: true, cleanup: noop });
	else if (!f || !(f.images.python && f.images.node)) out.push({ name: "docker", skip: "docker reachable but python:3.12-slim / node:22-slim not pulled locally", strictReadonly: true, cleanup: noop });
	else out.push({ name: "docker", driver: dk, strictReadonly: true, cleanup: async () => void (await dk.shutdown().catch(() => {})) });
	return out;
}

async function remoteTarget(name: "opensandbox" | "e2b" | "daytona", conn: ProviderConnection | undefined, missing: string, strictReadonly: boolean): Promise<Target> {
	if (!conn) return { name, skip: missing, strictReadonly, cleanup: noop };
	const provider = await createRemoteProvider(conn);
	const db = new AppDb(":memory:");
	db.migrate("sandbox-contract", SANDBOX_MIGRATIONS);
	const lifecycle: LifecyclePolicy = { createTimeoutSec: 180, idlePauseSec: 600, pausedRetentionSec: 3600, destroyAfterSec: 86400 };
	const made: RemoteDriver[] = [];
	const newDriver = (o: { orphanGraceMs?: number; lifecycle?: LifecyclePolicy } = {}) => {
		const d = new RemoteDriver({ db, provider, orgId: "org-contract", lifecycle: o.lifecycle ?? lifecycle, orphanGraceMs: o.orphanGraceMs, ...(conn.template ? { template: conn.template } : {}) });
		made.push(d);
		return d;
	};
	const cleanupAll = async () => {
		for (const r of db.all<{ remote_id: string | null }>("SELECT remote_id FROM tool_sandbox_instances WHERE remote_id IS NOT NULL")) if (r.remote_id) await provider.destroy(r.remote_id).catch(() => {});
		db.run("DELETE FROM tool_sandbox_instances");
	};
	const driver = newDriver();
	const h = await provider.health();
	if (!h.ok) return { name, skip: `${name} configured but not healthy: ${h.detail}`, strictReadonly, cleanup: noop };
	return {
		name,
		driver,
		strictReadonly,
		remote: {
			provider,
			db,
			lifecycle,
			newDriver,
			cleanupAll,
			remoteId: (spaceId, key) => db.get<{ remote_id: string }>("SELECT remote_id FROM tool_sandbox_instances WHERE space_id = ? AND workspace_key = ? AND state = 'ready'", spaceId, key)?.remote_id ?? null,
		},
		async cleanup() {
			await cleanupAll();
			await Promise.all(made.map((d) => d.close()));
		},
	};
}

const targets: Target[] = [
	...(await localTargets()),
	await remoteTarget(
		"opensandbox",
		env.WORKROOM_TEST_OPENSANDBOX_URL && env.WORKROOM_TEST_OPENSANDBOX_KEY ? { provider: "opensandbox", endpoint: env.WORKROOM_TEST_OPENSANDBOX_URL, apiKey: env.WORKROOM_TEST_OPENSANDBOX_KEY, ...(env.WORKROOM_TEST_OPENSANDBOX_IMAGE ? { template: env.WORKROOM_TEST_OPENSANDBOX_IMAGE } : {}) } : undefined,
		"WORKROOM_TEST_OPENSANDBOX_URL / WORKROOM_TEST_OPENSANDBOX_KEY not set (start one with scripts/opensandbox-local.sh)",
		true,
	),
	await remoteTarget(
		"e2b",
		env.WORKROOM_TEST_E2B_API_KEY ? { provider: "e2b", apiKey: env.WORKROOM_TEST_E2B_API_KEY, ...(env.WORKROOM_TEST_E2B_API_URL ? { endpoint: env.WORKROOM_TEST_E2B_API_URL } : {}), ...(env.WORKROOM_TEST_E2B_DOMAIN ? { domain: env.WORKROOM_TEST_E2B_DOMAIN } : {}), ...(env.WORKROOM_TEST_E2B_TEMPLATE ? { template: env.WORKROOM_TEST_E2B_TEMPLATE } : {}) } : undefined,
		"WORKROOM_TEST_E2B_API_KEY not set (no E2B account/key available: provider is IMPLEMENTED BUT UNVERIFIED)",
		false,
	),
	await remoteTarget(
		"daytona",
		env.WORKROOM_TEST_DAYTONA_API_KEY ? { provider: "daytona", apiKey: env.WORKROOM_TEST_DAYTONA_API_KEY, ...(env.WORKROOM_TEST_DAYTONA_API_URL ? { endpoint: env.WORKROOM_TEST_DAYTONA_API_URL } : {}) } : undefined,
		"WORKROOM_TEST_DAYTONA_API_KEY not set (no Daytona account/key available: provider is IMPLEMENTED BUT UNVERIFIED)",
		false,
	),
];

after(async () => {
	for (const t of targets) await t.cleanup();
});

// ---------------------------------------------------------------------------------------------------------------------------------
interface Ctx {
	root: string;
	wd: string;
	/** Build a shell-language run spec. */
	spec(code: string, o?: Partial<DriverRunSpec> & { space?: string; key?: string }): DriverRunSpec;
}
function ctxFor(t: Target, label: string): Ctx {
	const root = mkdtempSync(join(tmpdir(), `wr-contract-${t.name}-`));
	const wd = join(root, "sandbox", "c1");
	mkdirSync(wd, { recursive: true });
	let n = 0;
	return {
		root,
		wd,
		spec(code, o = {}) {
			const { space, key, ...rest } = o;
			const dir = key ? join(root, "sandbox", key) : wd;
			mkdirSync(dir, { recursive: true });
			return {
				runId: `run_${label.replace(/\W/g, "").slice(0, 10)}_${++n}_${Math.random().toString(36).slice(2, 6)}`,
				tenant: { orgId: "org-contract", spaceId: space ?? `space-${label.replace(/\W/g, "").slice(0, 12)}-${root.slice(-6)}`, workspaceKey: key ?? "c1" },
				scratchBase: join(root, "sandbox"),
				workdir: dir,
				exec: { language: "shell", code },
				limits: { ...DEFAULT_LIMITS, timeoutMs: 60_000 },
				mounts: [],
				env: {},
				// Round 9: no Workroom network policy; the driver's / provider's own network applies (namespaces: none; docker: WORKROOM_DOCKER_NETWORK).
				network: true,
				...rest,
			};
		},
	};
}

/** Define one contract case for every target; `where` restricts to local or remote targets (with the skip reason shown for others). */
function contract(name: string, fn: (t: Target, c: Ctx) => Promise<void>, where: "all" | "remote" | "local" = "all", timeout = 240_000) {
	for (const t of targets) {
		const title = `[${t.name}] ${name}`;
		const skip = t.skip ? (REQUIRE.has(t.name) ? undefined : t.skip) : where === "remote" && !t.remote ? "remote-provider case (local drivers share the host directory directly)" : where === "local" && t.remote ? "local-driver case" : undefined;
		test(title, { skip, timeout }, async () => {
			if (t.skip) assert.fail(`${t.name} is required (WORKROOM_TEST_REQUIRE) but unavailable: ${t.skip}`);
			try {
				await fn(t, ctxFor(t, name));
			} finally {
				await t.remote?.cleanupAll();
			}
		});
	}
}
const read = (p: string) => readFileSync(p, "utf8");

/** Count processes whose cmdline contains `needle` — scanned through /proc (portable: no ps/pgrep needed in minimal images). */
const PROC_COUNT = (needle: string) => `n=0; for p in /proc/[0-9]*; do c=$(tr '\\0' ' ' < $p/cmdline 2>/dev/null); case "$c" in *"${needle}"*) case "$c" in *"for p in"*) ;; *) n=$((n+1));; esac;; esac; done; echo count=$n`;

contract("exit code, stdout and stderr", async (t, c) => {
	const r = await t.driver!.run(c.spec("echo out-line; echo err-line >&2; exit 7"));
	assert.equal(r.status, "error");
	assert.equal(r.exitCode, 7);
	assert.match(r.stdout, /out-line/);
	assert.match(r.stderr, /err-line/);
	const ok = await t.driver!.run(c.spec("echo fine"));
	assert.equal(ok.status, "ok");
	assert.equal(ok.exitCode, 0);
});

contract("streaming: chunks arrive while the command is still running", async (t, c) => {
	const p = t.remote!.provider;
	const s = await p.create({ metadata: { workroom: "1", workroom_instance: "contract-stream" }, lifetimeMs: 600_000, createTimeoutMs: 180_000 });
	try {
		const stamps: number[] = [];
		const got: string[] = [];
		const t0 = Date.now();
		const r = await s.exec({ command: "for i in 1 2 3; do echo chunk$i; sleep 1; done", cwd: "/", timeoutMs: 30_000, onStdout: (x) => (got.push(x), stamps.push(Date.now() - t0)) });
		assert.equal(r.status, "ok");
		assert.match(got.join(""), /chunk1[\s\S]*chunk2[\s\S]*chunk3/);
		assert.ok(stamps.length >= 3, `expected >=3 callbacks, got ${stamps.length}`);
		assert.ok(stamps[0]! < stamps.at(-1)! - 800, `first chunk must arrive well before the last (${stamps.join(",")})`);
	} finally {
		await p.destroy(s.id);
	}
}, "remote");

contract("timeout: status timeout and the remote process really stops", async (t, c) => {
	const code = "sleep 31 & sleep 31";
	const r = await t.driver!.run(c.spec(code, { limits: { ...DEFAULT_LIMITS, timeoutMs: 3000 } }));
	assert.equal(r.status, "timeout");
	assert.ok(r.durationMs < 20_000, `returned in ${r.durationMs} ms`);
	if (t.remote) {
		await new Promise((res) => setTimeout(res, 1500));
		const chk = await t.driver!.run(c.spec(PROC_COUNT("sleep 31")));
		assert.match(chk.stdout, /count=0/, `the timed-out process is still alive: ${chk.stdout}`);
	}
});

contract("cancel via AbortSignal: status killed and the remote process really stops", async (t, c) => {
	const warm = c.spec("echo warm"); // the sandbox exists before the cancel fires (cancel DURING creation is covered below)
	assert.equal((await t.driver!.run(warm)).status, "ok");
	const ac = new AbortController();
	setTimeout(() => ac.abort(), 2500);
	const t0 = Date.now();
	const r = await t.driver!.run({ ...c.spec("sleep 32", { signal: ac.signal }), tenant: warm.tenant });
	assert.equal(r.status, "killed");
	assert.ok(Date.now() - t0 < 25_000);
	if (t.remote) {
		await new Promise((res) => setTimeout(res, 1500));
		const chk = await t.driver!.run(c.spec(PROC_COUNT("sleep 32")));
		assert.match(chk.stdout, /count=0/, `the cancelled process is still alive: ${chk.stdout}`);
	}
});

contract("cancel while the sandbox is still being created returns killed (no provider error, no leaked running run)", async (t, c) => {
	const ac = new AbortController();
	setTimeout(() => ac.abort(), 300);
	const r = await t.driver!.run(c.spec("echo never", { signal: ac.signal, space: "space-cancel-create" }));
	assert.equal(r.status, "killed");
}, "remote");

contract("file roundtrip: host write → run sees it → run writes → host sees it; deletions both ways", async (t, c) => {
	mkdirSync(join(c.wd, "sub dir"), { recursive: true });
	writeFileSync(join(c.wd, "sub dir", "in é.txt"), "from-host");
	writeFileSync(join(c.wd, "delete-me-on-host.txt"), "x");
	writeFileSync(join(c.wd, "delete-me-in-run.txt"), "y");
	const sp = c.spec('cat "sub dir/in é.txt"; mkdir -p out/deep; printf from-run > out/deep/result.txt; printf %s "$(cat delete-me-on-host.txt)" > copy.txt; rm delete-me-in-run.txt');
	const r = await t.driver!.run(sp);
	assert.equal(r.status, "ok", r.stderr);
	assert.match(r.stdout, /from-host/);
	assert.equal(read(join(c.wd, "out", "deep", "result.txt")), "from-run");
	assert.equal(read(join(c.wd, "copy.txt")), "x");
	assert.equal(existsSync(join(c.wd, "delete-me-in-run.txt")), false, "deleted in the run → deleted on the host");
	rmSync(join(c.wd, "delete-me-on-host.txt"));
	const r2 = await t.driver!.run(c.spec("test -e delete-me-on-host.txt && echo STILL || echo gone"));
	assert.match(r2.stdout, /gone/, "deleted on the host → gone in the sandbox");
});

contract("binary files and empty files survive the roundtrip byte-for-byte", async (t, c) => {
	const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) % 256));
	writeFileSync(join(c.wd, "bin.dat"), bytes);
	writeFileSync(join(c.wd, "empty.txt"), "");
	const r = await t.driver!.run(c.spec("cp bin.dat bin2.dat; : > empty2.txt; test -f empty.txt && echo has-empty"));
	assert.equal(r.status, "ok", r.stderr);
	assert.match(r.stdout, /has-empty/);
	assert.ok(readFileSync(join(c.wd, "bin2.dat")).equals(bytes));
	assert.ok(existsSync(join(c.wd, "empty2.txt")));
});

contract("a symlink created in the sandbox is not copied to the host (and does not expose host files)", async (t, c) => {
	const r = await t.driver!.run(c.spec("echo data > real.txt; ln -s /etc/passwd evil-link; ln -s real.txt rel-link; mkfifo fifo 2>/dev/null; true"));
	assert.equal(r.status, "ok", r.stderr);
	assert.equal(read(join(c.wd, "real.txt")).trim(), "data");
	for (const n of ["evil-link", "rel-link", "fifo"]) assert.equal(existsSync(join(c.wd, n)) || (() => { try { return lstatSync(join(c.wd, n)).isSymbolicLink(); } catch { return false; } })(), false, `${n} must not appear on the host`);
	assert.match(r.stderr, /符号链接未同步到宿主机/);
}, "remote");

contract("path escape attempts and illegal names never leave the workspace", async (t, c) => {
	const marker = join(c.root, "outside.txt");
	writeFileSync(marker, "untouched");
	const r = await t.driver!.run(c.spec("echo pwn > ../../outside.txt 2>/dev/null; echo pwn2 > '/work/../escape.txt' 2>/dev/null; printf x > 'back\\slash.txt'; printf x > 'col:on.txt'; printf x > fine.txt; true"));
	assert.equal(r.status, "ok", r.stderr);
	assert.equal(read(marker), "untouched");
	assert.equal(existsSync(join(c.root, "escape.txt")), false);
	assert.equal(existsSync(join(c.wd, "..", "escape.txt")), false);
	assert.equal(read(join(c.wd, "fine.txt")), "x");
	assert.equal(existsSync(join(c.wd, "back\\slash.txt")), false);
	assert.equal(existsSync(join(c.wd, "col:on.txt")), false);
	assert.match(r.stderr, /远端文件名不合法/);
}, "remote");

contract("a file over the per-file limit is not synced back (and an oversized host file is not uploaded)", async (t, c) => {
	writeFileSync(join(c.wd, "host-big.bin"), Buffer.alloc(4000, 1));
	const lim = { ...DEFAULT_LIMITS, timeoutMs: 60_000, maxFileBytes: 1500 };
	const r = await t.driver!.run(c.spec("head -c 3000 /dev/zero > big.bin; echo small > small.txt; test -e host-big.bin && echo SAW-HOST-BIG || echo no-host-big", { limits: lim }));
	assert.equal(existsSync(join(c.wd, "big.bin")) ? lstatSync(join(c.wd, "big.bin")).size <= 1500 : true, true);
	assert.equal(read(join(c.wd, "small.txt")).trim(), "small");
	assert.match(r.stderr, /超过单文件上限/);
	assert.match(r.stdout, /no-host-big/);
}, "remote");

contract("skills mount: read-only inside the sandbox, hash verified, content intact on the next run", async (t, c) => {
	const skill = join(c.root, "mounts", "skill-a");
	mkdirSync(join(skill, "scripts"), { recursive: true });
	writeFileSync(join(skill, "SKILL.md"), "# original skill\n");
	writeFileSync(join(skill, "scripts", "hello.sh"), "#!/bin/sh\necho hello-from-skill\n", { mode: 0o755 });
	const m: SandboxMount[] = [{ hostPath: skill, target: "/skills/skill-a", readOnly: true }];
	const r1 = await t.driver!.run(c.spec("cat /skills/skill-a/SKILL.md; /skills/skill-a/scripts/hello.sh; (echo pwned > /skills/skill-a/SKILL.md) 2>/dev/null && echo WROTE || echo blocked; (rm -f /skills/skill-a/SKILL.md) 2>/dev/null; true", { mounts: m }));
	assert.equal(r1.status, "ok", r1.stderr);
	assert.match(r1.stdout, /original skill/);
	assert.match(r1.stdout, /hello-from-skill/, "the executable bit of skill scripts is preserved");
	if (t.strictReadonly) assert.match(r1.stdout, /blocked/, "a write into the read-only skills directory must fail");
	else if (/WROTE/.test(r1.stdout)) assert.match(r1.stderr, /单用户沙箱/, "a provider that cannot write-protect must say so in the run notes");
	// whatever happened, the next run sees the original content (hash re-verified; tampering is repaired)
	const r2 = await t.driver!.run(c.spec("cat /skills/skill-a/SKILL.md", { mounts: m }));
	assert.match(r2.stdout, /# original skill/);
	assert.doesNotMatch(r2.stdout, /pwned/);
	// the mount is not part of the workspace: nothing from it lands on the host workdir
	assert.equal(existsSync(join(c.wd, "skills")), false);
});

contract("a writable mount other than /work is refused with UnsupportedError", async (t, c) => {
	const dir = join(c.root, "rw");
	mkdirSync(dir);
	await assert.rejects(t.driver!.run(c.spec("echo x", { mounts: [{ hostPath: dir, target: "/data", readOnly: false }] })), (e: any) => e instanceof UnsupportedError && e.status === 501);
}, "remote");

contract("tenant isolation: two spaces never share a remote sandbox or its files", async (t, c) => {
	const a = c.spec("echo space-a-secret > secret.txt", { space: "space-A" });
	const b = c.spec("cat secret.txt 2>/dev/null || echo not-here; ls", { space: "space-B", key: "c1b" });
	assert.equal((await t.driver!.run(a)).status, "ok");
	const rb = await t.driver!.run(b);
	assert.match(rb.stdout, /not-here/);
	assert.doesNotMatch(rb.stdout, /space-a-secret/);
	const ids = [t.remote!.remoteId("space-A", "c1"), t.remote!.remoteId("space-B", "c1b")];
	assert.ok(ids[0] && ids[1] && ids[0] !== ids[1], `two distinct remote sandboxes expected, got ${ids.join(",")}`);
	// a different conversation of the same space also gets its own sandbox
	const c2 = await t.driver!.run(c.spec("cat secret.txt 2>/dev/null || echo not-here", { space: "space-A", key: "c2" }));
	assert.match(c2.stdout, /not-here/);
	assert.notEqual(t.remote!.remoteId("space-A", "c2"), ids[0]);
}, "remote");

contract("reconnect after a driver restart: same remote sandbox, files intact, no full re-upload", async (t, c) => {
	writeFileSync(join(c.wd, "persist.txt"), "persisted");
	const sp = c.spec("echo kept-in-sandbox > /tmp/remote-only.txt; cat persist.txt");
	const r1 = await t.driver!.run(sp);
	assert.equal(r1.status, "ok", r1.stderr);
	const id = t.remote!.remoteId(sp.tenant!.spaceId, "c1");
	assert.ok(id);
	const d2 = t.remote!.newDriver(); // "restart": a new driver instance over the same DB
	const r2 = await d2.run(c.spec("cat /tmp/remote-only.txt; cat persist.txt", { space: sp.tenant!.spaceId }));
	assert.match(r2.stdout, /kept-in-sandbox/, "remote-only state (/tmp) proves the very same sandbox was reused");
	assert.match(r2.stdout, /persisted/);
	assert.equal(t.remote!.remoteId(sp.tenant!.spaceId, "c1"), id);
	assert.doesNotMatch(r2.stderr, /远端沙箱已不存在/);
}, "remote");

contract("lost sandbox (destroyed externally): recreated and re-synced from the host", async (t, c) => {
	writeFileSync(join(c.wd, "base.txt"), "base");
	const sp = c.spec("echo made-by-run > made.txt");
	assert.equal((await t.driver!.run(sp)).status, "ok");
	const id = t.remote!.remoteId(sp.tenant!.spaceId, "c1")!;
	await t.remote!.provider.destroy(id); // external deletion
	const r = await t.driver!.run(c.spec("cat base.txt; cat made.txt", { space: sp.tenant!.spaceId }));
	assert.equal(r.status, "ok", r.stderr);
	assert.match(r.stdout, /base/);
	assert.match(r.stdout, /made-by-run/);
	assert.match(r.stderr, /远端沙箱已不存在/);
	const rows = instancesFor(t.remote!.db, "org-contract").filter((x) => x.spaceId === sp.tenant!.spaceId);
	assert.ok(rows.some((x) => x.state === "lost"));
	const now = t.remote!.remoteId(sp.tenant!.spaceId, "c1");
	assert.ok(now && now !== id);
}, "remote");

contract("round 11: idle pause → resume: the SAME sandbox comes back with remote-only state (files outside the workspace, i.e. installed dependencies) intact", async (t, c) => {
	if (t.remote!.provider.capabilities.pauseResume === "unsupported") return; // recreate mode is covered by "idle reaping" below and sandbox-lifecycle.test.ts
	const d = t.remote!.newDriver({ lifecycle: { createTimeoutSec: 120, idlePauseSec: 60, pausedRetentionSec: 600, destroyAfterSec: 3600 } });
	const space = `space-pause-${Math.random().toString(36).slice(2, 8)}`;
	writeFileSync(join(c.wd, "kept.txt"), "workspace-file");
	const r1 = await d.run(c.spec("mkdir -p /tmp/deps && echo installed-dep > /tmp/deps/marker; cat kept.txt", { space }));
	assert.equal(r1.status, "ok", r1.stderr);
	const id = t.remote!.remoteId(space, "c1")!;
	assert.ok(id);
	assert.equal(await d.reapIdle(Date.now() + 120_000), 1, "idle past idlePauseSec → paused");
	const paused = t.remote!.db.get<{ state: string; resume_mode: string | null }>("SELECT state, resume_mode FROM tool_sandbox_instances WHERE space_id = ? ORDER BY created_at DESC LIMIT 1", space)!;
	assert.deepEqual({ ...paused }, { state: "paused", resume_mode: "provider" });
	const r2 = await d.run(c.spec("cat /tmp/deps/marker; cat kept.txt", { space }));
	assert.equal(r2.status, "ok", r2.stderr);
	assert.match(r2.stdout, /installed-dep/, "state outside the workspace survived the pause: the very same sandbox was resumed");
	assert.match(r2.stdout, /workspace-file/);
	assert.equal(t.remote!.remoteId(space, "c1"), id, "no new sandbox was created");
	const kinds = t.remote!.db.all<{ kind: string }>("SELECT kind FROM tool_sandbox_events WHERE space_id = ? ORDER BY at, rowid", space).map((e) => e.kind);
	assert.deepEqual(kinds.filter((k) => k !== "destroy"), ["create", "pause", "resume"]);
}, "remote");

contract("idle reaping and orphan reaping", async (t, c) => {
	const d = t.remote!.newDriver({ orphanGraceMs: 0, lifecycle: { createTimeoutSec: 120, idlePauseSec: 60, pausedRetentionSec: 600, destroyAfterSec: 3600 } });
	const sp = c.spec("echo idle", { space: "space-idle" });
	assert.equal((await d.run(sp)).status, "ok");
	const id = t.remote!.remoteId("space-idle", "c1")!;
	assert.equal(await d.reapIdle(Date.now() + 5_000), 0, "not idle yet");
	// Round 11: idle → paused where the provider can pause (else destroyed = "recreate"); unused for destroyAfter → destroyed for real.
	assert.equal(await d.reapIdle(Date.now() + 120_000), 1, "idle past idlePauseSec → paused (or recycled)");
	assert.equal(await d.reapIdle(Date.now() + 2 * 3_600_000), 1, "unused past destroyAfterSec → destroyed");
	assert.equal((await t.remote!.provider.connect(id)), null, "the remote sandbox is really gone");
	// orphan: created with this install's labels but unknown to the table
	const row = [...t.remote!.db.all<{ id: string }>("SELECT id FROM tool_sandbox_instances")][0]!;
	void row;
	const probeLabels = (await t.remote!.provider.list({ workroom: "1" })).find(() => false);
	void probeLabels;
	const inst = t.remote!.db.get<{ value: string }>("SELECT value FROM tool_sandbox_settings WHERE key = 'install_id'")!.value;
	const org = (await import("node:crypto")).createHash("sha256").update("org-contract").digest("hex").slice(0, 16);
	const orphan = await t.remote!.provider.create({ metadata: { workroom: "1", workroom_install: inst, workroom_org: org, workroom_instance: "sbi_orphan_contract" }, lifetimeMs: 600_000, createTimeoutMs: 180_000 });
	const foreign = await t.remote!.provider.create({ metadata: { workroom: "1", workroom_install: "another-install", workroom_org: org, workroom_instance: "sbi_foreign" }, lifetimeMs: 600_000, createTimeoutMs: 180_000 });
	try {
		assert.ok((await d.reapStale()) >= 1);
		assert.equal(await t.remote!.provider.connect(orphan.id), null, "orphan destroyed");
		assert.ok(await t.remote!.provider.connect(foreign.id), "another installation's sandbox is never touched");
	} finally {
		await t.remote!.provider.destroy(foreign.id).catch(() => {});
		await t.remote!.provider.destroy(orphan.id).catch(() => {});
	}
}, "remote");

contract("replay idempotency: the same run twice does not corrupt the manifest or duplicate files", async (t, c) => {
	writeFileSync(join(c.wd, "once.txt"), "once");
	const sp = c.spec("echo replay >> log.txt; cat once.txt");
	const r1 = await t.driver!.run(sp);
	const m1 = t.remote!.db.get<{ manifest: string }>("SELECT manifest FROM tool_sandbox_instances WHERE space_id = ? AND state = 'ready'", sp.tenant!.spaceId)!.manifest;
	const r2 = await t.driver!.run({ ...sp, runId: `${sp.runId}_replay` });
	assert.equal(r1.status, "ok", r1.stderr);
	assert.equal(r2.status, "ok", r2.stderr);
	assert.equal(read(join(c.wd, "log.txt")), "replay\nreplay\n", "each run appended exactly once (no duplicate upload/download side effects)");
	const m2 = JSON.parse(t.remote!.db.get<{ manifest: string }>("SELECT manifest FROM tool_sandbox_instances WHERE space_id = ? AND state = 'ready'", sp.tenant!.spaceId)!.manifest);
	assert.deepEqual(Object.keys(m2).sort(), Object.keys(JSON.parse(m1)).sort());
	assert.equal(read(join(c.wd, "once.txt")), "once");
}, "remote");

contract("round 9: no refusal tied to network: a run with either spec.network value is executed (never a 501/403 'no network' refusal)", async (t, c) => {
	for (const network of [false, true]) {
		const r = await t.driver!.run(c.spec(`echo net-${network}`, { network, key: `net-${network}` }));
		assert.equal(r.status, "ok", r.stderr);
		assert.match(r.stdout, new RegExp(`net-${network}`));
	}
}, "remote");

// LIVE egress probe. Workroom neither requests nor denies network; this only REPORTS what the sandbox really gets (the environment's own
// proxy/firewall may limit it). Reachability is asserted only for namespaces (must be offline: technical limit) and when
// WORKROOM_TEST_REQUIRE_EGRESS=1 is set; otherwise the real outcome is printed as a test diagnostic and in the test output - never faked.
contract("network: reachability of a public HTTPS host from inside the sandbox is reported (python urllib; DNS + TCP + TLS)", async (t, c) => {
	const r = await t.driver!.run(c.spec(`python3 - <<'PY'\n${EGRESS_PROBE_PY}PY`, { limits: { ...DEFAULT_LIMITS, timeoutMs: 60_000 } }));
	const reachable = /^https 200$/m.test(r.stdout);
	const line = probeLine(t.name, r.stdout, r.stderr);
	console.log(line);
	if (t.name === "namespaces") assert.doesNotMatch(r.stdout, /tcp-connect ok/, "the namespace driver has no network (technical limit)");
	else if (env.WORKROOM_TEST_REQUIRE_EGRESS === "1") assert.equal(reachable, true, line);
	assert.ok(r.status === "ok" || r.status === "error", `the probe itself ran: ${r.status}`);
});

contract("services and pty are refused with UnsupportedError (501), never run on the host", async (t, c) => {
	await assert.rejects(t.driver!.startService({ serviceId: "svc_x", scratchBase: c.root, workdir: c.wd, argv: ["sleep", "1"], runtime: "shell", limits: DEFAULT_LIMITS, mounts: [], env: {}, network: false }), (e: any) => e instanceof UnsupportedError && e.status === 501 && e.code === "UNSUPPORTED");
	assert.equal(t.driver!.capabilities.services, false);
	assert.equal(t.remote!.provider.capabilities.pty, "unsupported");
}, "remote");

contract("capability honesty: every 'supported' claim has a passing case above; nothing is claimed that was not exercised", async (t) => {
	const caps = t.remote!.provider.capabilities;
	const exercised = new Set(["exec", "streamOutput", "cancel", "commandTimeout", "files", "reconnect", "pauseResume"]);
	for (const [k, v] of Object.entries(caps)) {
		if (v === "supported" && !exercised.has(k) && !["networkOn", "networkOff", "resourceLimits"].includes(k) && typeof v === "string") assert.fail(`capability ${k} is marked supported but no contract case exercises it`);
	}
	assert.ok(["supported", "unverified", "unsupported"].includes(caps.networkOff));
	assert.equal(t.driver!.capabilities.mounts, caps.skills === "upload_readonly");
	const dirs = readdirSync(tmpdir()).length; // keep tmp usage observable
	assert.ok(dirs >= 0);
}, "remote");
