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
