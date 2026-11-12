// Round 13: a space skipped at start-up because of a not-yet-expired foreign lease must resume on its own; the wake
// mirror (rt_space_runtime) is a repairable scheduling index.
//   node --disable-warning=ExperimentalWarning --test server/test/r13-lease-resume.test.ts
process.env.WORKROOM_FIXTURE_TOOLS = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { waitFor } from "../src/runtime/testing.ts";
import { runtimeState } from "../src/runtime/module.ts";
import { AppDb } from "../src/core/db.ts";

const KNOBS = ["WORKROOM_RT_RESUME_SWEEP_MS", "WORKROOM_RT_RESUME_RETRY_BASE_MS", "WORKROOM_RT_RESUME_RETRY_MAX"];
function withKnobs(v: Record<string, string>): () => void {
	const saved = KNOBS.map((k) => [k, process.env[k]] as const);
	for (const k of KNOBS) delete process.env[k];
	Object.assign(process.env, v);
	return () => {
		for (const [k, x] of saved) if (x === undefined) delete process.env[k];
		else process.env[k] = x;
	};
}

/** Leave a conversation with a run in flight, wake mirror active, then stop (work stays pending in durable storage). */
async function seedPending(dataDir: string, email: string) {
	const t = await startTestApp({ dataDir, config: { instanceId: "old-proc" } });
	const a = await t.user(email);
	const { conversation: c } = await t.json("POST", "/api/conversations", { token: a.token, json: {} });
	const path = `/api/conversations/${c.spaceId}/${c.conversationId}`;
	const r = await t.json("POST", `${path}/messages`, { token: a.token, json: { text: "[[slow 1500]] [[reply 租约到期后恢复]]", requestId: randomUUID() } });
	await waitFor(() => t.app.ctx.db.get<any>("SELECT wake_active FROM rt_space_runtime WHERE space_id = ?", c.spaceId)?.wake_active === 1, { what: "active" });
	await t.stop();
	return { c, path, submissionId: r.submissionId as string, email };
}
function editDb(dataDir: string, fn: (db: AppDb) => void) {
	const db = new AppDb(join(dataDir, "app.sqlite"));
	try {
		fn(db);
	} finally {
		db.close();
	}
}
async function login(t: TestApp, email: string) {
	return (await t.json("POST", "/api/auth/login", { json: { email, password: "password123" } })).token as string;
}

for (const mode of ["retry timer", "periodic sweep"] as const) {
	test(`lease resume (${mode}): a live foreign lease at start-up is retried after expiry; the pending run completes with no request`, async () => {
		const restore = withKnobs(mode === "retry timer" ? { WORKROOM_RT_RESUME_SWEEP_MS: "0", WORKROOM_RT_RESUME_RETRY_BASE_MS: "50" } : { WORKROOM_RT_RESUME_SWEEP_MS: "150", WORKROOM_RT_RESUME_RETRY_MAX: "0" });
		const dataDir = mkdtempSync(join(tmpdir(), "wr-r13-lease-"));
		let t: TestApp | undefined;
		try {
			const s = await seedPending(dataDir, `lease-${mode.split(" ")[0]}@example.com`);
			// the old process died: its lease row (another owner) still has ~1 s to live
			editDb(dataDir, (db) => {
				db.run("UPDATE rt_space_runtime SET wake_active = 1 WHERE space_id = ?", s.c.spaceId);
				db.run("INSERT OR REPLACE INTO rt_space_leases (space_id, owner, acquired_at, heartbeat_at, expires_at) VALUES (?, 'dead-owner', ?, ?, ?)", s.c.spaceId, Date.now(), Date.now(), Date.now() + 1000);
			});
			t = await startTestApp({ dataDir, config: { instanceId: "new-proc" } });
			const m = runtimeState(t.app.ctx).manager;
			assert.equal(m.isOpen(s.c.spaceId), false, "refused at start-up: lease still live");
			assert.equal(t.app.ctx.db.get<any>("SELECT wake_active FROM rt_space_runtime WHERE space_id = ?", s.c.spaceId).wake_active, 1);
			// nothing touches the space; it opens by itself once the lease expired
			await waitFor(() => m.isOpen(s.c.spaceId), { what: "opened after lease expiry", timeoutMs: 8000 });
			assert.equal(t.app.ctx.db.get<any>("SELECT owner FROM rt_space_leases WHERE space_id = ?", s.c.spaceId).owner, "new-proc");
			const token = await login(t, s.email);
			const done = await waitFor(async () => {
				const x = await t!.json("GET", `${s.path}/submissions/${s.submissionId}`, { token });
				return x.status === "done" ? x : undefined;
			}, { what: "pending run completes", timeoutMs: 15000 });
			assert.equal(done.status, "done");
		} finally {
			await t?.dispose();
			rmSync(dataDir, { recursive: true, force: true });
			restore();
		}
	});
}

test("lease resume: retry timers are cancelled on stop (no reopen after shutdown)", async () => {
	const restore = withKnobs({ WORKROOM_RT_RESUME_SWEEP_MS: "100", WORKROOM_RT_RESUME_RETRY_BASE_MS: "50" });
	const dataDir = mkdtempSync(join(tmpdir(), "wr-r13-lease-"));
	try {
		const s = await seedPending(dataDir, "lease-stop@example.com");
		editDb(dataDir, (db) => db.run("INSERT OR REPLACE INTO rt_space_leases (space_id, owner, acquired_at, heartbeat_at, expires_at) VALUES (?, 'dead-owner', ?, ?, ?)", s.c.spaceId, Date.now(), Date.now(), Date.now() + 400));
		const t = await startTestApp({ dataDir, config: { instanceId: "new-proc" } });
		const m = runtimeState(t.app.ctx).manager;
		await t.stop();
		await new Promise((r) => setTimeout(r, 900));
		assert.equal(m.isOpen(s.c.spaceId), false);
		editDb(dataDir, (db) => assert.equal(db.get<any>("SELECT owner FROM rt_space_leases WHERE space_id = ?", s.c.spaceId).owner, "dead-owner"));
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
		restore();
	}
});

test("mirror repair: a failed rt_space_runtime write is retried by the sweep and the repair marker is cleared", async () => {
	const restore = withKnobs({ WORKROOM_RT_RESUME_SWEEP_MS: "100" });
	const t = await startTestApp();
	try {
		const a = await t.user("mirror-sweep@example.com");
		const { conversation: c } = await t.json("POST", "/api/conversations", { token: a.token, json: {} });
		const m = runtimeState(t.app.ctx).manager;
		const db = t.app.ctx.db as any;
		const orig = db.run.bind(db);
		let failing = true;
		db.run = (sql: string, ...args: unknown[]) => {
			if (failing && /rt_space_runtime/.test(sql)) throw new Error("disk I/O error (simulated)");
			return orig(sql, ...args);
		};
		const marker = join(t.app.ctx.services.get("identity").space(c.spaceId)!.dir, ".wake-mirror-dirty");
		const r = await t.json("POST", `/api/conversations/${c.spaceId}/${c.conversationId}/messages`, { token: a.token, json: { text: "[[slow 300]] [[reply ok]]", requestId: randomUUID() } });
		await waitFor(() => existsSync(marker), { what: "repair marker written" });
		assert.ok(m.isOpen(c.spaceId));
		failing = false;
		await waitFor(() => !existsSync(marker), { what: "marker cleared after the sweep repaired the mirror" });
		await waitFor(async () => (await t.json("GET", `/api/conversations/${c.spaceId}/${c.conversationId}/submissions/${r.submissionId}`, { token: a.token })).status === "done");
		// the mirror now reflects the harness again (inactive once the run is done)
		await waitFor(() => t.app.ctx.db.get<any>("SELECT wake_active FROM rt_space_runtime WHERE space_id = ?", c.spaceId)?.wake_active === 0, { what: "mirror caught up" });
	} finally {
		await t.dispose();
		restore();
	}
});

test("mirror repair: after a crash with a failed mirror write, start-up finds the marker and resumes the space", async () => {
	const restore = withKnobs({ WORKROOM_RT_RESUME_SWEEP_MS: "0" });
	const dataDir = mkdtempSync(join(tmpdir(), "wr-r13-mirror-"));
	let t = await startTestApp({ dataDir, config: { instanceId: "old-proc" } });
	try {
		const a = await t.user("mirror-crash@example.com");
		const { conversation: c } = await t.json("POST", "/api/conversations", { token: a.token, json: {} });
		const path = `/api/conversations/${c.spaceId}/${c.conversationId}`;
		const db = t.app.ctx.db as any;
		const orig = db.run.bind(db);
		db.run = (sql: string, ...args: unknown[]) => {
			if (/rt_space_runtime/.test(sql)) throw new Error("disk I/O error (simulated)");
			return orig(sql, ...args);
		};
		const marker = join(t.app.ctx.services.get("identity").space(c.spaceId)!.dir, ".wake-mirror-dirty");
		const r = await t.json("POST", `${path}/messages`, { token: a.token, json: { text: "[[slow 1500]] [[reply 镜像修复后恢复]]", requestId: randomUUID() } });
		await waitFor(() => existsSync(marker), { what: "marker written" });
		await t.stop();
		// the mirror never learnt about the pending run: scheduling index says "nothing to do"
		editDb(dataDir, (d) => d.run("DELETE FROM rt_space_runtime WHERE space_id = ?", c.spaceId));
		assert.ok(existsSync(marker));
		t = await startTestApp({ dataDir, config: { instanceId: "new-proc" } });
		assert.ok(runtimeState(t.app.ctx).manager.isOpen(c.spaceId), "opened by the marker scan");
		await waitFor(async () => (await t.json("GET", `${path}/submissions/${r.submissionId}`, { token: a.token })).status === "done", { what: "run completes", timeoutMs: 15000 });
		assert.equal(existsSync(marker), false, "marker cleared once the mirror was written");
		assert.ok(t.app.ctx.db.get<any>("SELECT 1 AS x FROM rt_space_runtime WHERE space_id = ?", c.spaceId));
	} finally {
		await t.dispose();
		rmSync(dataDir, { recursive: true, force: true });
		restore();
	}
});
