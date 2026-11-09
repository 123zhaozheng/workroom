// Single-owner lease and wake-state tests (group A).
//   node --disable-warning=ExperimentalWarning --test server/test/runtime-lease.test.ts
process.env.WORKROOM_FIXTURE_TOOLS = "1";
process.env.WORKROOM_RT_RETRY_BASE_MS ??= "20";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startTestApp } from "./helpers/app.ts";
import { waitFor } from "../src/runtime/testing.ts";
import { runtimeState } from "../src/runtime/module.ts";

const rid = () => randomUUID();

test("lease: a second instance on the same data dir is refused while the owner is live; takes over after it stops", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "wr-lease-"));
	const t1 = await startTestApp({ dataDir, config: { instanceId: "owner-1" } });
	const t2 = await startTestApp({ dataDir, config: { instanceId: "owner-2" } });
	try {
		const a = await t1.user("lease@example.com");
		const { conversation: c } = await t1.json("POST", "/api/conversations", { token: a.token, json: {} });
		const path = `/api/conversations/${c.spaceId}/${c.conversationId}`;
		const row = t1.app.ctx.db.get<any>("SELECT * FROM rt_space_leases WHERE space_id = ?", c.spaceId);
		assert.equal(row.owner, "owner-1");
		assert.ok(row.expires_at > Date.now());
		const refused = await t2.json("GET", path, { token: a.token, expect: 503 });
		assert.equal(refused.error.code, "space_busy");
		assert.equal(runtimeState(t2.app.ctx).manager.isOpen(c.spaceId), false);
		await t1.stop(); // releases the lease, work stays pending in storage
		assert.equal(t2.app.ctx.db.get<any>("SELECT * FROM rt_space_leases WHERE space_id = ?", c.spaceId), undefined);
		const d = await t2.json("GET", path, { token: a.token });
		assert.equal(d.conversation.conversationId, c.conversationId);
		assert.equal(t2.app.ctx.db.get<any>("SELECT owner FROM rt_space_leases WHERE space_id = ?", c.spaceId).owner, "owner-2");
	} finally {
		await t1.stop();
		await t2.stop();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("lease: losing the lease closes the harness; it is not reopened while another owner holds it", async () => {
	const prev = process.env.WORKROOM_LEASE_TTL_MS;
	process.env.WORKROOM_LEASE_TTL_MS = "900"; // heartbeat every 300 ms
	const t = await startTestApp();
	try {
		const a = await t.user("lease-lost@example.com");
		const { conversation: c } = await t.json("POST", "/api/conversations", { token: a.token, json: {} });
		const m = runtimeState(t.app.ctx).manager;
		assert.ok(m.isOpen(c.spaceId));
		// heartbeat keeps renewing it
		const e0 = t.app.ctx.db.get<any>("SELECT expires_at FROM rt_space_leases WHERE space_id = ?", c.spaceId).expires_at;
		await waitFor(() => t.app.ctx.db.get<any>("SELECT expires_at FROM rt_space_leases WHERE space_id = ?", c.spaceId).expires_at > e0, { what: "heartbeat renews" });
		// another instance takes the row (e.g. after this process stalled past expiry)
		t.app.ctx.db.run("UPDATE rt_space_leases SET owner = 'intruder', expires_at = ? WHERE space_id = ?", Date.now() + 60_000, c.spaceId);
		await waitFor(() => !m.isOpen(c.spaceId), { what: "harness closed after lease loss" });
		const r = await t.json("GET", `/api/conversations/${c.spaceId}/${c.conversationId}`, { token: a.token, expect: 503 });
		assert.equal(r.error.code, "space_busy");
		// once the intruder's lease expires, this instance can take over again
		t.app.ctx.db.run("UPDATE rt_space_leases SET expires_at = ? WHERE space_id = ?", Date.now() - 1, c.spaceId);
		await t.json("GET", `/api/conversations/${c.spaceId}/${c.conversationId}`, { token: a.token });
	} finally {
		await t.dispose();
		if (prev === undefined) delete process.env.WORKROOM_LEASE_TTL_MS;
		else process.env.WORKROOM_LEASE_TTL_MS = prev;
	}
});

test("wake state: rt_space_runtime mirrors onWake (active while a run works, inactive after)", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("wake@example.com");
		const { conversation: c } = await t.json("POST", "/api/conversations", { token: a.token, json: {} });
		const r = await t.json("POST", `/api/conversations/${c.spaceId}/${c.conversationId}/messages`, { token: a.token, json: { text: "[[slow 600]] [[reply ok]]", requestId: rid() } });
		await waitFor(() => t.app.ctx.db.get<any>("SELECT wake_active FROM rt_space_runtime WHERE space_id = ?", c.spaceId)?.wake_active === 1, { what: "active" });
		await waitFor(async () => (await t.json("GET", `/api/conversations/${c.spaceId}/${c.conversationId}/submissions/${r.submissionId}`, { token: a.token })).status === "done");
		await waitFor(() => t.app.ctx.db.get<any>("SELECT wake_active FROM rt_space_runtime WHERE space_id = ?", c.spaceId)?.wake_active === 0, { what: "inactive" });
		// app.sqlite holds no conversation facts beyond the catalog's ACL/display columns
		const cols = t.app.ctx.db.all<{ name: string }>("PRAGMA table_info(rt_conversations)").map((x) => x.name).sort();
		assert.deepEqual(cols, ["archived", "conversation_id", "created_at", "created_by", "kind", "project_id", "space_id", "title", "updated_at"]);
	} finally {
		await t.dispose();
	}
});
