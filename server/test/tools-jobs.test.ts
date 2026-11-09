// Background jobs (M14-C) through the REAL runtime: job_start returns at once, the chat keeps answering, status/cancel via
// API, budgets, results published as file versions, and behaviour across a server restart (rerun vs fail policy).
process.env.WORKROOM_RT_RETRY_MAX ??= "1";
process.env.WORKROOM_RT_RETRY_BASE_MS ??= "20";

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { orgMember } from "./fixtures/util.ts";
import { probeIsolation } from "../src/tools/sandbox.ts";

type Conv = { spaceId: string; conversationId: number };
const base = (c: Conv) => `/api/conversations/${c.spaceId}/${c.conversationId}`;
const skip = probeIsolation().ok ? false : probeIsolation().detail;

async function waitFor<T>(fn: () => Promise<T | undefined | false>, what: string, timeoutMs = 30_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	for (;;) {
		try {
			const v = await fn();
			if (v) return v as T;
			last = v;
		} catch (e) {
			last = e;
		}
		if (Date.now() > deadline) throw new Error(`timed out: ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
		await new Promise((r) => setTimeout(r, 100));
	}
}
async function say(t: TestApp, token: string, c: Conv, text: string) {
	const r = await t.json("POST", `${base(c)}/messages`, { token, json: { text, requestId: randomUUID() } });
	return waitFor(async () => {
		const s = await t.json("GET", `${base(c)}/submissions/${r.submissionId}`, { token });
		return ["done", "unanswered", "withdrawn"].includes(s.status) ? s : undefined;
	}, "submission settles");
}
const jobsOf = async (t: TestApp, token: string, c: Conv) => (await t.json("GET", `/api/jobs?spaceId=${c.spaceId}&conversationId=${c.conversationId}`, { token })).jobs as any[];
const startJob = (args: Record<string, unknown>) => `[[call job_start ${JSON.stringify(args)}]]`;
const noSleepers = (marker: string) => {
	try {
		return execFileSync("pgrep", ["-f", marker], { encoding: "utf8" }).trim() === "";
	} catch {
		return true;
	}
};

test("jobs: background sandbox job, chat stays usable, results published, cancel and budget, viewer cannot cancel", { skip }, async () => {
	const t = await startTestApp();
	try {
		const u = await t.user("jobs@example.com");
		const viewer = await orgMember(t, u, "jobs-viewer@example.com");
		const { project } = await t.json("POST", "/api/projects", { token: u.token, json: { name: "Jobs" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: u.token, json: { email: "jobs-viewer@example.com", role: "viewer" } });
		const c: Conv = (await t.json("POST", "/api/conversations", { token: u.token, json: { spaceId: project.spaceId, title: "后台任务" } })).conversation;

		const t0 = Date.now();
		const s1 = await say(t, u.token, c, startJob({ kind: "sandbox", title: "慢统计", sandbox: { language: "shell", code: "sleep 3; echo 'a,b' > out.csv; echo finished", publish: ["out.csv"] }, timeoutMs: 60_000 }));
		assert.equal(s1.status, "done");
		assert.ok(Date.now() - t0 < 2500, "job_start must return before the job ends");
		let [job] = await jobsOf(t, u.token, c);
		assert.ok(["queued", "running"].includes(job.status), job.status);
		assert.equal(job.budget.timeoutMs, 60_000);
		// The chat answers a follow-up while the job is still running.
		const s2 = await say(t, u.token, c, "顺便问一下：现在进度如何？");
		assert.equal(s2.status, "done");
		assert.ok(["queued", "running"].includes((await jobsOf(t, u.token, c))[0].status));
		const state = await t.json("GET", `${base(c)}/state`, { token: u.token });
		assert.notEqual(state.live.status, "running", "background job must not keep the conversation busy");

		job = await waitFor(async () => (await jobsOf(t, u.token, c)).find((j) => j.status === "done"), "job done");
		assert.equal(job.outputs.length, 1);
		assert.equal(job.outputs[0].name, "out.csv");
		assert.match(job.summary, /finished/);
		const dl = await t.req("GET", `/api/files/${job.outputs[0].fileId}/versions/${job.outputs[0].versionId}/download`, { token: u.token });
		assert.equal(await dl.text(), "a,b\n");
		const prov = (await t.json("GET", `/api/files/${job.outputs[0].fileId}`, { token: u.token })).versions[0].provenance;
		assert.equal(prov.conversationId, c.conversationId);
		assert.equal(prov.tool, "job:sandbox");
		// The pi doc mirror is visible to conversation watchers.
		const h = await t.app.ctx.services.get("runtime").harness(c.spaceId, (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT);
		const { JobsDoc } = await import("../src/tools/jobs.ts");
		const mirror = await h.snapshot(JobsDoc, c.conversationId as any, (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT);
		assert.equal(mirror?.jobs[job.id]?.status, "done");

		// Cancel from the API: the sandbox process tree is killed, status cancelled. Viewers can watch but not cancel.
		await say(t, u.token, c, startJob({ kind: "sandbox", title: "长任务", sandbox: { language: "shell", code: "sleep 4931" } }));
		const long = await waitFor(async () => (await jobsOf(t, u.token, c)).find((j) => j.title === "长任务" && j.status === "running"), "long job running");
		assert.equal((await jobsOf(t, viewer.token, c)).find((j) => j.id === long.id).canCancel, false);
		await t.json("POST", `/api/jobs/${long.id}/cancel`, { token: viewer.token, expect: 403 });
		await t.json("POST", `/api/jobs/${long.id}/cancel`, { token: u.token });
		const cancelled = await waitFor(async () => (await jobsOf(t, u.token, c)).find((j) => j.id === long.id && j.status === "cancelled"), "cancelled");
		assert.equal(cancelled.cancelRequestedBy, u.me.userId);
		await waitFor(async () => noSleepers("sleep 4931"), "no leftover processes", 5000);

		// Budgets: wall clock → timeout; CPU seconds → timeout.
		await say(t, u.token, c, startJob({ kind: "sandbox", title: "超时", sandbox: { language: "shell", code: "sleep 30" }, timeoutMs: 1500 }));
		const to = await waitFor(async () => (await jobsOf(t, u.token, c)).find((j) => j.title === "超时" && j.status !== "queued" && j.status !== "running"), "timeout");
		assert.equal(to.status, "timeout");
		await say(t, u.token, c, startJob({ kind: "sandbox", title: "CPU", sandbox: { language: "python", code: "while True:\n  pass" }, timeoutMs: 20_000, cpuSeconds: 1 }));
		const cpu = await waitFor(async () => (await jobsOf(t, u.token, c)).find((j) => j.title === "CPU" && !["queued", "running"].includes(j.status)), "cpu budget");
		assert.equal(cpu.status, "timeout", JSON.stringify(cpu));

		// Generation job publishes a real file.
		await say(t, u.token, c, startJob({ kind: "generate", title: "大报告", generate: { format: "docx", name: "年度报告", title: "年度报告", content: "## 一\n内容" } }));
		const gen = await waitFor(async () => (await jobsOf(t, u.token, c)).find((j) => j.title === "大报告" && j.status === "done"), "generate");
		assert.equal(gen.outputs[0].name, "年度报告.docx");
	} finally {
		await t.dispose();
	}
});

test("jobs across a server restart: restartPolicy=rerun reruns and publishes; restartPolicy=fail is marked failed, never blindly redone", { skip }, async () => {
	let t = await startTestApp();
	const dataDir = t.dataDir;
	try {
		const u = await t.user("restart-jobs@example.com");
		const c: Conv = (await t.json("POST", "/api/conversations", { token: u.token, json: { title: "重启" } })).conversation;
		await say(t, u.token, c, startJob({ kind: "sandbox", title: "可重跑", restartPolicy: "rerun", sandbox: { language: "shell", code: "echo run >> runs.log; sleep 3; cp runs.log result.txt", publish: ["result.txt"] } }));
		await say(t, u.token, c, startJob({ kind: "sandbox", title: "不可重跑", sandbox: { language: "shell", code: "echo charge >> side-effects.log; sleep 3953" } }));
		await waitFor(async () => (await jobsOf(t, u.token, c)).filter((j) => j.status === "running").length === 2, "both running");
		await waitFor(async () => {
			const files = (await t.json("GET", `/api/sandbox/${c.spaceId}/files?conversationId=${c.conversationId}`, { token: u.token })).entries.map((e: any) => e.path);
			return files.includes("runs.log") && files.includes("side-effects.log");
		}, "both scripts started");
		await t.stop(); // graceful stop: harness closes, sandboxes killed, tasks stay live in storage

		t = await startTestApp({ dataDir });
		const token = (await t.json("POST", "/api/auth/login", { json: { email: "restart-jobs@example.com", password: "password123" } })).token;
		const rerun = await waitFor(async () => (await jobsOf(t, token, c)).find((j) => j.title === "可重跑" && j.status === "done"), "rerun job done after restart", 40_000);
		assert.equal(rerun.attempts, 2);
		const out = await t.req("GET", `/api/files/${rerun.outputs[0].fileId}/versions/${rerun.outputs[0].versionId}/download`, { token });
		assert.equal(await out.text(), "run\nrun\n"); // ran again from scratch (the log shows both attempts)
		const failed = await waitFor(async () => (await jobsOf(t, token, c)).find((j) => j.title === "不可重跑" && j.status === "failed"), "fail-policy job failed", 40_000);
		assert.match(failed.error, /重启/);
		assert.ok(noSleepers("sleep 3953"));
		const space = t.app.ctx.services.get("identity").space(c.spaceId)!;
		const log = (t.app.ctx.services.get("sandbox") as any).readFile(space, c.conversationId, "side-effects.log");
		assert.equal(new TextDecoder().decode(log.bytes), "charge\n"); // not redone
	} finally {
		await t.dispose();
		(await import("node:fs")).rmSync(dataDir, { recursive: true, force: true });
	}
});
