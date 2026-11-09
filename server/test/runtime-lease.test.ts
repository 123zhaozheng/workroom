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

test("recovery: a storage write after the in-memory lease expired fails the Harness; it is reopened and the run finishes", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("reopen@example.com");
		const { conversation: c } = await t.json("POST", "/api/conversations", { token: a.token, json: {} });
		const m = runtimeState(t.app.ctx).manager;
		const r = await t.json("POST", `/api/conversations/${c.spaceId}/${c.conversationId}/messages`, { token: a.token, json: { text: "[[slow 500]] [[reply 重新打开后完成]]", requestId: rid() } });
		const h1 = m.openHarness(c.spaceId)!;
		m.expireLeaseInMemory(c.spaceId); // the next commit (the answer) is refused by the storage guard
		const end = await h1.closed;
		assert.equal(end.kind, "failed");
		assert.match(String((end as any).error?.message ?? (end as any).error), /lease/);
		await waitFor(() => m.openHarness(c.spaceId) && m.openHarness(c.spaceId) !== h1, { what: "reopened" });
		const s = await waitFor(async () => {
			const x = await t.json("GET", `/api/conversations/${c.spaceId}/${c.conversationId}/submissions/${r.submissionId}`, { token: a.token });
			return x.status === "done" ? x : undefined;
		}, { what: "run finishes after reopen" });
		assert.equal(s.status, "done");
	} finally {
		await t.dispose();
	}
});

test("recovery: start() reopens spaces with due work and arms a timer for a future sleep", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "wr-wake-"));
	let t = await startTestApp({ dataDir });
	try {
		const a = await t.user("sleep@example.com");
		const { conversation: c } = await t.json("POST", "/api/conversations", { token: a.token, json: {} });
		await t.stop();
		// as if the last process had recorded a sleep due in 400 ms
		const { AppDb } = await import("../src/core/db.ts");
		const db = new AppDb(join(dataDir, "app.sqlite"));
		db.run("UPDATE rt_space_runtime SET wake_active = 0, wake_at = ? WHERE space_id = ?", Date.now() + 400, c.spaceId);
		db.close();
		t = await startTestApp({ dataDir });
		const m = runtimeState(t.app.ctx).manager;
		assert.equal(m.isOpen(c.spaceId), false);
		assert.ok(m.pendingWakeTimers.has(c.spaceId));
		await waitFor(() => m.isOpen(c.spaceId), { what: "opened when the sleep is due" });
		// due immediately → opened during start()
		await t.stop();
		const db2 = new AppDb(join(dataDir, "app.sqlite"));
		db2.run("UPDATE rt_space_runtime SET wake_active = 1, wake_at = NULL WHERE space_id = ?", c.spaceId);
		db2.close();
		t = await startTestApp({ dataDir });
		assert.ok(runtimeState(t.app.ctx).manager.isOpen(c.spaceId));
	} finally {
		await t.dispose();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("idle eviction: an idle harness is closed (lease released), reopened on demand; a watched one is kept; a sleep wakes an evicted space", async () => {
	const saved = { idle: process.env.WORKROOM_RT_IDLE_MS, sweep: process.env.WORKROOM_RT_IDLE_SWEEP_MS, base: process.env.WORKROOM_RT_RETRY_BASE_MS, max: process.env.WORKROOM_RT_RETRY_MAX };
	process.env.WORKROOM_RT_IDLE_MS = "300";
	process.env.WORKROOM_RT_IDLE_SWEEP_MS = "100";
	const t = await startTestApp();
	try {
		const a = await t.user("evict@example.com");
		const { conversation: c } = await t.json("POST", "/api/conversations", { token: a.token, json: {} });
		const path = `/api/conversations/${c.spaceId}/${c.conversationId}`;
		const m = runtimeState(t.app.ctx).manager;
		const r = await t.json("POST", `${path}/messages`, { token: a.token, json: { text: "[[reply 一次]]", requestId: rid() } });
		await waitFor(async () => (await t.json("GET", `${path}/submissions/${r.submissionId}`, { token: a.token })).status === "done");
		// idle → evicted, lease released, wake row kept
		await waitFor(() => !m.isOpen(c.spaceId), { what: "evicted" });
		assert.equal(t.app.ctx.db.get<any>("SELECT 1 AS x FROM rt_space_leases WHERE space_id = ?", c.spaceId), undefined);
		assert.ok(t.app.ctx.db.get<any>("SELECT wake_active FROM rt_space_runtime WHERE space_id = ?", c.spaceId));
		// reopen on demand: reading works and the transcript is intact
		const es = (await t.json("GET", `${path}/entries`, { token: a.token })).items;
		assert.ok(es.some((e: any) => e.kind === "assistant" && e.text.includes("一次")));
		assert.ok(m.isOpen(c.spaceId));
		// a watched space (SSE open) is never evicted
		const { sseReader } = await import("../src/runtime/testing.ts");
		const sse = sseReader(await t.req("GET", `${path}/events`, { token: a.token }));
		await sse.next((e) => e.event === "snapshot");
		await new Promise((res) => setTimeout(res, 700));
		assert.ok(m.isOpen(c.spaceId), "held by the watcher");
		await sse.close();
		await waitFor(() => !m.isOpen(c.spaceId), { what: "evicted after the watcher left" });

		// a sleeping task (retry backoff) lets the space be evicted; the armed wake reopens it and the retry runs
		process.env.WORKROOM_RT_RETRY_MAX = "1";
		process.env.WORKROOM_RT_RETRY_BASE_MS = "1500";
		const f = await t.json("POST", `${path}/messages`, { token: a.token, json: { text: "[[fail transient]]", requestId: rid() } });
		// first attempt failed; pi committed a durable retry backoff (a sleep)
		await waitFor(async () => (await t.json("GET", `${path}/state`, { token: a.token })).live.retry, { what: "retry backoff" });
		await waitFor(() => !m.isOpen(c.spaceId) && m.pendingWakeTimers.has(c.spaceId), { what: "evicted while sleeping", timeoutMs: 1400 });
		const row = t.app.ctx.db.get<any>("SELECT wake_active, wake_at FROM rt_space_runtime WHERE space_id = ?", c.spaceId);
		assert.equal(row.wake_active, 0);
		assert.ok(row.wake_at > Date.now(), "wake_at kept for the scheduler");
		assert.equal(t.app.ctx.db.get<any>("SELECT 1 AS x FROM rt_space_leases WHERE space_id = ?", c.spaceId), undefined);
		// no request touches the space: the wake timer alone reopens it when the sleep is due
		await waitFor(() => m.isOpen(c.spaceId), { what: "reopened by the wake timer", timeoutMs: 5000 });
		assert.equal(m.pendingWakeTimers.has(c.spaceId), false);
		// the retry ran (the run can only end after its second attempt)
		const s = await waitFor(async () => {
			const x = await t.json("GET", `${path}/submissions/${f.submissionId}`, { token: a.token });
			return x.status === "unanswered" ? x : undefined;
		});
		assert.equal(s.reason, "model_error");
	} finally {
		await t.dispose();
		for (const [k, v] of [["WORKROOM_RT_IDLE_MS", saved.idle], ["WORKROOM_RT_IDLE_SWEEP_MS", saved.sweep], ["WORKROOM_RT_RETRY_BASE_MS", saved.base], ["WORKROOM_RT_RETRY_MAX", saved.max]] as const) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
});
