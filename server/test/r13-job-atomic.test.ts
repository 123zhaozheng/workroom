// R13 item 7: job_start creates the job task and records job -> task in ONE durable commit (JobsDoc.tasks), so a replay of the
// same tool call after a crash between "task created" and "projection written" finds the task instead of creating a second one.
// What this really simulates: a graceful app stop while job_start is parked in the crash window (task + mapping committed, tool_jobs
// projection not yet written), then a reopen on the same data dir so the runtime replays the in-flight replay:"safe" tool call with
// its original call id. It is NOT a SIGKILL; the durable commit boundaries are the real ones.
process.env.WORKROOM_RT_RETRY_MAX ??= "1";
process.env.WORKROOM_RT_RETRY_BASE_MS ??= "20";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { JobsDoc } from "../src/tools/jobs.ts";

type Conv = { spaceId: string; conversationId: number };
const base = (c: Conv) => `/api/conversations/${c.spaceId}/${c.conversationId}`;

async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 30_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const v = await fn();
			if (v) return v as T;
		} catch {}
		if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
		await new Promise((r) => setTimeout(r, 100));
	}
}
const mapping = async (t: TestApp, c: Conv) => {
	const h = await (t.app.ctx.services.get("runtime") as any).harness(c.spaceId, BACKGROUND_CONTEXT);
	return ((await h.snapshot(JobsDoc, c.conversationId, BACKGROUND_CONTEXT)) as any)?.tasks as Record<string, number> | undefined;
};

test("job_start replay after a crash between task creation and projection write creates no second task; projection is rebuilt", async () => {
	let t = await startTestApp();
	const dataDir = t.dataDir;
	try {
		const u = await t.user("atomic-jobs@example.com");
		const c: Conv = (await t.json("POST", "/api/conversations", { token: u.token, json: { title: "原子" } })).conversation;
		const jobs = t.app.ctx.services.get("jobs") as any;
		let parked = false;
		const release: Array<() => void> = [];
		jobs.afterTaskCommitted = () => {
			parked = true;
			return new Promise<void>((_, rej) => release.push(() => rej(new Error("process stopped in the crash window")))); // never reaches attachTask
		};
		const args = { kind: "generate", title: "原子任务", generate: { format: "md", name: "atomic", content: "hello" } };
		await t.json("POST", `${base(c)}/messages`, { token: u.token, json: { text: `[[call job_start ${JSON.stringify(args)}]]`, requestId: randomUUID() } });
		await waitFor(() => parked, "job_start parked after the commit");
		const m1 = await waitFor(() => mapping(t, c).then((x) => (x && Object.keys(x).length ? x : undefined)), "durable mapping committed");
		const [jobId, taskId] = Object.entries(m1)[0];
		// The projection was never written in this process (the window was real), unless the task itself already adopted it.
		const stopping = t.stop();
		await new Promise((r) => setTimeout(r, 500));
		release.forEach((f) => f()); // the old process is gone; its tool call must not be able to finish its own commit
		await stopping;

		// The projection is lost: the process died before writing it (and the background task may have run before that).
		const raw = new DatabaseSync(join(dataDir, "app.sqlite"));
		raw.prepare("UPDATE tool_jobs SET task_id = NULL WHERE id = ?").run(jobId);
		raw.close();
		t = await startTestApp({ dataDir }); // replay of the in-flight job_start with its original call id
		const t2 = t;
		const jobs2 = t2.app.ctx.services.get("jobs") as any;
		await waitFor(() => jobs2.row(jobId)?.task_id === taskId, "projection rebuilt after replay", 40_000);
		const m2 = await mapping(t2, c);
		assert.deepEqual(m2, { [jobId]: taskId }, "exactly one task recorded for the job, same id as before the crash");
		assert.equal(jobs2.row(jobId).task_id, taskId);
		const rows = t2.app.ctx.db.all<{ n: number }>("SELECT count(*) AS n FROM tool_jobs").map((r) => r.n);
		assert.deepEqual(rows, [1]);
		const h = await (t2.app.ctx.services.get("runtime") as any).harness(c.spaceId, BACKGROUND_CONTEXT);
		const rec = await h.getTask(taskId + 1, BACKGROUND_CONTEXT);
		assert.equal(rec, undefined, "no second task was created after the replay");
	} finally {
		await t.dispose();
		rmSync(dataDir, { recursive: true, force: true });
	}
});
