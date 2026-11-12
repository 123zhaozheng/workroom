// Round 12: what the reworked message flow reads from the server — the measured "准备工作空间" record of a new conversation,
// and real timings on entries (message time, model response duration, tool duration) instead of client-side guesses.
process.env.WORKROOM_FIXTURE_TOOLS = "1"; // test-only echo tool
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { startTestApp } from "./helpers/app.ts";
import { waitFor } from "../src/runtime/testing.ts";

test("round 12: a new conversation records its workspace preparation (measured), entries carry real timings", { timeout: 60_000 }, async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("r12-flow@example.com");
		const { conversation } = await t.json("POST", "/api/conversations", { token: a.token, json: {} });
		const base = `/api/conversations/${conversation.spaceId}/${conversation.conversationId}`;
		let s = await t.json("GET", `${base}/state`, { token: a.token });
		const ws = s.entries.filter((e: any) => e.kind === "workspace");
		assert.equal(ws.length, 1, "exactly one workspace record");
		assert.ok(ws[0].ms >= 1 && ws[0].ms < 60_000, `measured ms: ${ws[0].ms}`);
		const keys = ws[0].items.map((i: any) => i.key);
		assert.deepEqual(keys.slice(0, 2), ["storage", "workdir"]);
		assert.ok(keys.includes("env"), "the execution environment is reported");
		assert.ok(ws[0].items.every((i: any) => typeof i.ok === "boolean" && typeof i.label === "string"));
		// the working directory really exists now (created, not promised)
		const space = t.app.ctx.services.get("identity").space(conversation.spaceId)!;
		const sb = t.app.ctx.services.get("sandbox") as any;
		assert.ok(existsSync(`${sb.root(space)}/c${conversation.conversationId}`), "workdir created at creation time");
		// no remote sandbox was started for it (pure chat never starts one)
		assert.equal(t.app.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tool_sandbox_instances WHERE space_id = ?", conversation.spaceId)?.n ?? 0, 0);

		const before = Date.now();
		await t.json("POST", `${base}/messages`, { token: a.token, json: { text: `[[call wr_fixture_echo {"text":"hi"}]] 你好`, requestId: randomUUID() } });
		s = await waitFor(async () => {
			const x = await t.json("GET", `${base}/state`, { token: a.token });
			return !x.live.busy && x.entries.some((e: any) => e.kind === "assistant" && !e.toolCalls.length) ? x : undefined;
		}, { timeoutMs: 20_000, what: "answer" });
		const user = s.entries.find((e: any) => e.kind === "user");
		assert.ok(typeof user.timestamp === "number" && user.timestamp >= before - 1000, `user timestamp ${user.timestamp}`);
		const asst = s.entries.filter((e: any) => e.kind === "assistant");
		assert.ok(asst.every((e: any) => typeof e.timestamp === "number" && typeof e.durationMs === "number" && e.durationMs >= 0), JSON.stringify(asst.map((e: any) => [e.timestamp, e.durationMs])));
		const res = s.entries.filter((e: any) => e.kind === "tool_result");
		assert.ok(res.length >= 1, "the echo tool ran");
		assert.ok(res.every((e: any) => typeof e.timestamp === "number" && typeof e.durationMs === "number"), "tool results carry their time and duration");
		// a second conversation in the same space gets its own record; the first keeps exactly one
		const { conversation: c2 } = await t.json("POST", "/api/conversations", { token: a.token, json: {} });
		const s2 = await t.json("GET", `/api/conversations/${c2.spaceId}/${c2.conversationId}/state`, { token: a.token });
		assert.equal(s2.entries.filter((e: any) => e.kind === "workspace").length, 1);
		assert.equal(s.entries.filter((e: any) => e.kind === "workspace").length, 1);
	} finally {
		await t.dispose();
	}
});
