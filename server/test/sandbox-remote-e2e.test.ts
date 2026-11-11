// LIVE end-to-end through the app (not a contract double): an org admin configures OpenSandbox over HTTP, makes it the org default, and the
// ordinary Sandbox.run path then executes remotely with env vars and persistent workspace versions. Then the remote sandbox is destroyed
// out-of-band AND the host working copy is removed (both "expired"); the next run recreates the sandbox and restores /work from the last
// saved version (hash-verified). Skipped unless a real OpenSandbox server is configured:
//   WORKROOM_TEST_OPENSANDBOX_URL=http://127.0.0.1:8080 WORKROOM_TEST_OPENSANDBOX_KEY=... (scripts/opensandbox-local.sh)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { startTestApp } from "./helpers/app.ts";
import type { Sandbox } from "../src/tools/sandbox.ts";
import { workspacePersistenceFor } from "../src/tools/sandbox/persist.ts";
import { createRemoteProvider } from "../src/tools/sandbox/providers/index.ts";
import { EGRESS_PROBE_PY, probeLine } from "./helpers/egress-probe.ts";

const URL_ = process.env.WORKROOM_TEST_OPENSANDBOX_URL;
const KEY = process.env.WORKROOM_TEST_OPENSANDBOX_KEY;
const skip = URL_ && KEY ? undefined : "LIVE test: WORKROOM_TEST_OPENSANDBOX_URL / WORKROOM_TEST_OPENSANDBOX_KEY not set (start one with scripts/opensandbox-local.sh)";

test("LIVE OpenSandbox through the app: admin config → org default → run with env vars → saved version → sandbox + host copy expire → restored", { skip, timeout: 900_000 }, async () => {
	const prevAllow = process.env.WORKROOM_WEBHOOK_ALLOWLIST;
	process.env.WORKROOM_WEBHOOK_ALLOWLIST = new URL(URL_!).hostname; // operator allowlist for the self-hosted endpoint (intranet case)
	const t = await startTestApp({ config: { secretKey: "test-master-key-for-live-e2e-only-0123456789" } });
	try {
		const owner = await t.user(`live-${Date.now()}@example.com`);
		const ctx = t.app.ctx;
		// Round 9: there is no network switch. Admin: configure + enable + default.
		await t.json("PUT", "/api/sandbox/providers/opensandbox", { token: owner.token, json: { enabled: true, endpoint: URL_, apiKey: KEY, allowPrivateNetwork: true, egressAcknowledged: true } });
		await t.json("PUT", "/api/sandbox/provider-policy", { token: owner.token, json: { orgDefault: "opensandbox", allowProjectOverride: false } });
		const listed = await t.json("GET", "/api/sandbox/providers", { token: owner.token });
		assert.ok(!JSON.stringify(listed).includes(KEY!), "API never returns the key");
		const test1 = (await t.json("POST", "/api/sandbox/providers/opensandbox/test", { token: owner.token, json: { kind: "roundtrip" } })).test;
		assert.equal(test1.ok, true, JSON.stringify(test1));

		const identity = ctx.services.get("identity");
		const principal = (await identity.principalFor(owner.me.userId, owner.me.orgId))!;
		const space = identity.personalSpace(owner.me.userId, owner.me.orgId);
		const sb = ctx.services.get("sandbox") as Sandbox;
		await t.json("PUT", `/api/sandbox-env/user/${encodeURIComponent(owner.me.userId)}/GREETING`, { token: owner.token, json: { value: "hello-from-org-env" } });

		const r1 = await sb.run({ principal, space, conversationId: 7, language: "shell", code: 'echo "$GREETING" > note.txt && echo done' });
		assert.equal(r1.exitCode, 0, r1.stderr);
		assert.equal(r1.driver, "opensandbox");
		assert.doesNotMatch(r1.stderr, /按“可联网”处理|无法保证断网/, "round 9: the old no-network note is gone");
		const persist = workspacePersistenceFor(ctx);
		const st1 = await persist.status(principal, space, "c7");
		assert.equal(st1.state, "saved");
		assert.ok(st1.headVersion && st1.headVersion >= 1);

		// Both copies "expire": destroy the remote sandbox out-of-band, and remove the host working copy (it was saved, so this is the reaper's case).
		const row = ctx.db.get<{ remote_id: string }>("SELECT remote_id FROM tool_sandbox_instances WHERE space_id = ? AND workspace_key = 'c7' AND state = 'ready'", space.id)!;
		const provider = await createRemoteProvider({ provider: "opensandbox", endpoint: URL_, apiKey: KEY });
		await provider.destroy(row.remote_id);
		const wd = sb.workdir(space, 7);
		rmSync(wd, { recursive: true, force: true });
		assert.equal(existsSync(wd), false);

		const r2 = await sb.run({ principal, space, conversationId: 7, language: "shell", code: "cat note.txt" });
		assert.equal(r2.exitCode, 0, r2.stderr);
		assert.equal(r2.stdout.trim(), "hello-from-org-env");
		const st2 = await persist.status(principal, space, "c7");
		assert.equal(st2.restore?.verified, true);
		const row2 = ctx.db.get<{ remote_id: string }>("SELECT remote_id FROM tool_sandbox_instances WHERE space_id = ? AND workspace_key = 'c7' AND state = 'ready'", space.id)!;
		assert.notEqual(row2.remote_id, row.remote_id, "a new remote sandbox was created");

		// Round 9: the legacy `network` field of PUT /sandbox/driver is accepted and ignored (with a note); runs are never refused because of it.
		const legacy = await t.json("PUT", "/api/sandbox/driver", { token: owner.token, json: { network: "none" } });
		assert.ok((legacy.deprecations as string[]).some((x) => /network/.test(x)), "the response says the field is ignored");
		const r3 = await sb.run({ principal, space, conversationId: 7, language: "shell", code: "echo still-runs" });
		assert.equal(r3.exitCode, 0, r3.stderr);

		// LIVE egress probe (report, do not fake): what this OpenSandbox sandbox really reaches. The server's own network config / this
		// environment's proxy may limit it; Workroom sent no network option.
		const probe = await sb.run({ principal, space, conversationId: 7, language: "python", code: EGRESS_PROBE_PY });
		console.log(probeLine("opensandbox via the app", probe.stdout, probe.stderr));
		if (process.env.WORKROOM_TEST_REQUIRE_EGRESS === "1") assert.match(probe.stdout, /^https 200$/m);
		const row3 = ctx.db.get<{ remote_id: string }>("SELECT remote_id FROM tool_sandbox_instances WHERE space_id = ? AND workspace_key = 'c7' AND state = 'ready'", space.id)!;
		assert.equal(row3.remote_id, row2.remote_id, "the ignored legacy field did not recreate the sandbox");
		await provider.destroy(row2.remote_id);
	} finally {
		await t.dispose();
		if (prevAllow === undefined) delete process.env.WORKROOM_WEBHOOK_ALLOWLIST;
		else process.env.WORKROOM_WEBHOOK_ALLOWLIST = prevAllow;
	}
});

// Round 10: the working directory is configurable per provider (Daytona's default user cannot create /work). Proof against a REAL provider that a
// non-default directory is honoured end to end: files sync both ways, it is the cwd, WORKROOM_WORKDIR names it, read-only mounts are re-rooted next
// to it, the model-facing paths follow it, and changing it re-syncs the whole workspace into the new directory (same sandbox).
test("LIVE OpenSandbox: a non-default working directory (/tmp/wr-work) is honoured: sync both ways, cwd, env, skills mount, change → full resync", { skip, timeout: 900_000 }, async () => {
	const prevAllow = process.env.WORKROOM_WEBHOOK_ALLOWLIST;
	process.env.WORKROOM_WEBHOOK_ALLOWLIST = new URL(URL_!).hostname;
	const t = await startTestApp({ config: { secretKey: "test-master-key-for-live-e2e-only-0123456789" } });
	const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	let provider: Awaited<ReturnType<typeof createRemoteProvider>> | undefined;
	let remoteId: string | undefined;
	try {
		const owner = await t.user(`live-wd-${Date.now()}@example.com`);
		const ctx = t.app.ctx;
		// invalid values are refused over HTTP before anything is stored
		for (const bad of ["/etc", "relative", "/a/../b"]) {
			const r = await t.req("PUT", "/api/sandbox/providers/opensandbox", { token: owner.token, json: { workDir: bad } });
			assert.equal(r.status, 400, bad);
		}
		await t.json("PUT", "/api/sandbox/providers/opensandbox", { token: owner.token, json: { enabled: true, endpoint: URL_, apiKey: KEY, allowPrivateNetwork: true, egressAcknowledged: true, workDir: "/tmp/wr-work" } });
		await t.json("PUT", "/api/sandbox/provider-policy", { token: owner.token, json: { orgDefault: "opensandbox", allowProjectOverride: false } });
		const cfg = (await t.json("GET", "/api/sandbox/providers", { token: owner.token })).providers.find((p: any) => p.provider === "opensandbox");
		assert.equal(cfg.workDir, "/tmp/wr-work");
		assert.equal(cfg.defaultWorkDir, "/work");

		const identity = ctx.services.get("identity");
		const principal = (await identity.principalFor(owner.me.userId, owner.me.orgId))!;
		const space = identity.personalSpace(owner.me.userId, owner.me.orgId);
		const sb = ctx.services.get("sandbox") as Sandbox;
		const W = "/tmp/wr-work";
		assert.deepEqual(sb.layout(space), { kind: "remote", provider: "opensandbox", workDir: W, skillsRoot: "/tmp/skills" });
		const env1 = await t.json("GET", `/api/conversations/${space.id}/21/environment`, { token: owner.token });
		assert.equal(env1.workDir, W);
		assert.equal(env1.skillsDir, "/tmp/skills");

		// host → remote: the file tool is given the REAL absolute path; the run sees it in the configured directory and relative to cwd
		sb.writeFile(space, 21, `${W}/in.txt`, new TextEncoder().encode("from-host"));
		sb.writeFile(space, 21, "/work/legacy.txt", new TextEncoder().encode("legacy-form"));
		const skillHost = join(sb.mountsRoot(), `wd-live-${Date.now()}`);
		mkdirSync(skillHost, { recursive: true });
		writeFileSync(join(skillHost, "SKILL.md"), "# live skill\n");
		const mount = { hostPath: skillHost, target: "/skills/wd-live", readOnly: true };
		const r1 = await sb.run({
			principal, space, conversationId: 21, language: "shell", mounts: [mount],
			code: 'echo "cwd=$(pwd)"; echo "env=$WORKROOM_WORKDIR"; echo "in=$(cat in.txt)"; echo "legacy=$(cat legacy.txt)"; echo "abs=$(cat /tmp/wr-work/in.txt)"; printf from-remote > made.txt; mkdir -p deep/er && printf nested > deep/er/n.txt; echo "skill=$(cat /tmp/skills/wd-live/SKILL.md)"; echo "skills-ls=$(ls /tmp/skills)"; (echo hacked >> /tmp/skills/wd-live/SKILL.md) 2>/dev/null; true',
		});
		assert.equal(r1.exitCode, 0, r1.stderr);
		assert.match(r1.stdout, /^cwd=\/tmp\/wr-work$/m);
		assert.match(r1.stdout, /^env=\/tmp\/wr-work$/m);
		assert.match(r1.stdout, /^in=from-host$/m);
		assert.match(r1.stdout, /^legacy=legacy-form$/m, "a path given as /work/… landed in the same workspace");
		assert.match(r1.stdout, /^abs=from-host$/m);
		assert.match(r1.stdout, /^skill=# live skill$/m, "the skill is mounted next to the working directory");
		assert.match(r1.stdout, /^skills-ls=wd-live$/m);
		// remote → host
		assert.equal(readFileSync(join(sb.workdir(space, 21), "made.txt"), "utf8"), "from-remote");
		assert.equal(readFileSync(join(sb.workdir(space, 21), "deep", "er", "n.txt"), "utf8"), "nested");
		const inst = ctx.db.get<{ remote_id: string; work_dir: string }>("SELECT remote_id, work_dir FROM tool_sandbox_instances WHERE space_id = ? AND workspace_key = 'c21' AND state = 'ready'", space.id)!;
		remoteId = inst.remote_id;
		assert.equal(inst.work_dir, W);
		// the skill stayed intact (read-only, or repaired by the per-run hash check)
		const r1b = await sb.run({ principal, space, conversationId: 21, language: "shell", mounts: [mount], code: "cat /tmp/skills/wd-live/SKILL.md" });
		assert.equal(r1b.stdout.trim(), "# live skill");

		// the admin changes the directory: same sandbox, whole workspace uploaded again into the new directory
		await t.json("PUT", "/api/sandbox/providers/opensandbox", { token: owner.token, json: { workDir: "/tmp/wr-work2" } });
		const r2 = await sb.run({ principal, space, conversationId: 21, language: "shell", mounts: [mount], code: 'echo "cwd=$(pwd)"; echo "in=$(cat in.txt)"; echo "made=$(cat made.txt)"; echo "nested=$(cat deep/er/n.txt)"; echo "skill=$(cat /tmp/skills/wd-live/SKILL.md)"' });
		assert.equal(r2.exitCode, 0, r2.stderr);
		assert.match(r2.stdout, /^cwd=\/tmp\/wr-work2$/m);
		assert.match(r2.stdout, /^in=from-host$/m);
		assert.match(r2.stdout, /^made=from-remote$/m);
		assert.match(r2.stdout, /^nested=nested$/m);
		assert.match(r2.stderr, /沙箱工作目录已从 \/tmp\/wr-work 改为 \/tmp\/wr-work2/);
		const inst2 = ctx.db.get<{ remote_id: string; work_dir: string }>("SELECT remote_id, work_dir FROM tool_sandbox_instances WHERE space_id = ? AND workspace_key = 'c21' AND state = 'ready'", space.id)!;
		assert.equal(inst2.remote_id, inst.remote_id, "the same remote sandbox was reused");
		assert.equal(inst2.work_dir, "/tmp/wr-work2");

		// cleared → provider default (/work for OpenSandbox), and the run still works there
		await t.json("PUT", "/api/sandbox/providers/opensandbox", { token: owner.token, json: { workDir: null } });
		const r3 = await sb.run({ principal, space, conversationId: 21, language: "shell", code: 'echo "cwd=$(pwd)"; echo "in=$(cat in.txt)"' });
		assert.equal(r3.exitCode, 0, r3.stderr);
		assert.match(r3.stdout, /^cwd=\/work$/m);
		assert.match(r3.stdout, /^in=from-host$/m);

		provider = await createRemoteProvider({ provider: "opensandbox", endpoint: URL_, apiKey: KEY });
	} finally {
		try {
			if (provider && remoteId) await provider.destroy(remoteId);
		} catch {
			/* best effort */
		}
		await t.dispose();
		if (prevAllow === undefined) delete process.env.WORKROOM_WEBHOOK_ALLOWLIST;
		else process.env.WORKROOM_WEBHOOK_ALLOWLIST = prevAllow;
	}
});
