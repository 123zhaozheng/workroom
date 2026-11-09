// Integrator acceptance M02-C: cancel, timeout, waiting-for-user, failure and success are independent run states.
process.env.WORKROOM_FIXTURE_TOOLS = "1"; // test-only approval tool
// Deterministic main-run timeout (A): an upstream timeout is retryable in pi, so production retries it with backoff
// (and the model gateway's breaker may open). With no retries the first upstream timeout ends the run → status "timeout".
process.env.WORKROOM_RT_RETRY_MAX = "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestApp } from "./helpers/app.ts";
import { waitFor } from "../src/runtime/testing.ts";

test("M02-C: done / waiting_approval / aborted / timeout / failed are distinct run states", { timeout: 240_000 }, async () => {
	const t = await startTestApp();
	try {
		const u = await t.user("states@acme.test");
		const newConv = async () => (await t.json("POST", "/api/conversations", { token: u.token, json: {} })).conversation;
		const send = (c: any, text: string) => t.json("POST", `/api/conversations/${c.spaceId}/${c.conversationId}/messages`, { token: u.token, json: { text, requestId: randomUUID() } });
		const state = (c: any) => t.json("GET", `/api/conversations/${c.spaceId}/${c.conversationId}/state`, { token: u.token });
		const settle = (c: any, want: string) => waitFor(async () => {
			const s = await state(c);
			return s.live.status === want ? s : undefined;
		}, { timeoutMs: want === "timeout" ? 150_000 : 30_000, what: `status ${want}` });

		const done = await newConv();
		await send(done, "你好");
		await settle(done, "done");

		const waiting = await newConv();
		await send(waiting, `[[call wr_fixture_approval {"title":"确认","summary":"需要你确认"}]]`);
		const w = await settle(waiting, "waiting_approval");
		assert.equal(w.approvals.filter((a: any) => a.status === "pending").length, 1);

		const cancelled = await newConv();
		await send(cancelled, "[[slow 20000]] 很长的回答");
		await waitFor(async () => (await state(cancelled)).live.busy || undefined, { what: "busy" });
		await t.json("POST", `/api/conversations/${cancelled.spaceId}/${cancelled.conversationId}/abort`, { token: u.token, json: {} });
		const a = await settle(cancelled, "aborted");
		assert.equal(a.live.failure?.reason, "aborted");

		const timedOut = await newConv();
		await send(timedOut, "[[fail timeout]] 调用上游");
		const to = await settle(timedOut, "timeout");
		assert.match(to.live.failure?.detail ?? "", /timed out/);

		const failed = await newConv();
		await send(failed, "[[fail]] 调用上游");
		const f = await settle(failed, "failed");
		assert.equal(f.live.failure?.reason, "model_error");

		const statuses = await Promise.all([done, waiting, cancelled, timedOut, failed].map(async (c) => (await state(c)).live.status));
		assert.deepEqual(statuses, ["done", "waiting_approval", "aborted", "timeout", "failed"]);
	} finally {
		await t.dispose();
	}
});
