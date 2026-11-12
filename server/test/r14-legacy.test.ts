// Round 14, requirement V18 + the legacy part of V20: the browser execution path is gone. A new conversation has no code_run and only
// `exec` runs code (in the configured sandbox driver; there is no tab broker any more). An OLD conversation (agent that still enables the
// legacy extensions) keeps working: its legacy tools still run, and a persisted `code_run` call finishes with a clear error and executes nothing.
process.env.WORKROOM_RT_RETRY_MAX ??= "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { probeIsolation } from "../src/tools/sandbox.ts";
import { CODE_RUN_REMOVED } from "../src/vfs/legacy-code-run.ts";

type Conv = { spaceId: string; conversationId: number };
const base = (c: Conv) => `/api/conversations/${c.spaceId}/${c.conversationId}`;
const call = (tool: string, args: unknown) => `[[call ${tool} ${JSON.stringify(args)}]]`;

async function say(t: TestApp, token: string, c: Conv, text: string) {
	const r = await t.json("POST", `${base(c)}/messages`, { token, json: { text, requestId: randomUUID() } });
	const deadline = Date.now() + 60_000;
	for (;;) {
		const s = await t.json("GET", `${base(c)}/submissions/${r.submissionId}`, { token });
		if (["done", "unanswered", "withdrawn"].includes(s.status)) return s;
		if (Date.now() > deadline) throw new Error("submission did not settle");
		await new Promise((x) => setTimeout(x, 50));
	}
}
async function results(t: TestApp, c: Conv, name: string) {
	const h = await t.app.ctx.services.get("runtime").harness(c.spaceId, BACKGROUND_CONTEXT);
	const conv = (await h.conversation(c.conversationId as any, BACKGROUND_CONTEXT))!;
	const items = (await conv.entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT)).items as any[];
	return items.filter((e) => e.kind === "pi.tool-result" && e.model?.[0]?.toolName === name).map((e) => ({ text: e.model[0].content.map((x: any) => x.text ?? "").join(""), isError: !!e.model[0].isError }));
}

/** An "old" conversation: created without the round 14 removal of the legacy extensions/tools, as conversations of earlier rounds were. */
async function oldConversation(t: TestApp, userId: string, orgId: string, title: string): Promise<Conv> {
	const rt = t.app.ctx.services.get("runtime") as any;
	const space = t.app.ctx.services.get("identity").personalSpace(userId, orgId);
	const principal = { userId, orgId } as any;
	const model = await rt.defaultModel(principal);
	const harness = await rt.manager.get(space.id);
	const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: model.provider, modelId: model.modelId } } }, BACKGROUND_CONTEXT);
	const now = new Date().toISOString();
	t.app.ctx.db.run("INSERT INTO rt_conversations (space_id, conversation_id, created_by, title, project_id, kind, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'chat', 0, ?, ?)", space.id, conv.id as number, userId, title, space.projectId ?? null, now, now);
	return { spaceId: space.id, conversationId: conv.id as number };
}

const skip = probeIsolation().ok ? false : probeIsolation().detail;

test("V18: a new conversation has no code_run; exec is the only code path and runs in the configured sandbox driver", { skip, timeout: 120_000 }, async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("leg-new@example.com");
		const c: Conv = (await t.json("POST", "/api/conversations", { token: a.token, json: { title: "新对话" } })).conversation;
		const state = await t.json("GET", base(c), { token: a.token });
		assert.ok(!state.agent.tools.includes("code_run"), "code_run is not offered");
		assert.ok(state.agent.tools.includes("exec"));
		// the browser execution endpoints and the SSE broker are gone
		assert.equal((await t.req("GET", `/api/conversations/${c.spaceId}/${c.conversationId}/local-exec`, { token: a.token })).status, 404);
		assert.equal((await t.req("GET", "/api/sandbox/local-exec", { token: a.token })).status, 404);
		assert.equal(t.app.ctx.services.has("localExec"), false);
		assert.equal((await t.json("GET", `/api/conversations/${c.spaceId}/${c.conversationId}/environment`, { token: a.token })).local, undefined);

		await say(t, a.token, c, call("exec", { command: "echo hi-from-exec" }));
		const ex = (await results(t, c, "exec"))[0]!;
		assert.ok(!ex.isError, ex.text);
		assert.match(ex.text, /hi-from-exec/);
		const runs = t.app.ctx.db.all<{ driver: string }>("SELECT driver FROM tool_sandbox_runs WHERE space_id = ? AND conversation_id = ?", c.spaceId, c.conversationId);
		assert.equal(runs.length, 1);
		assert.ok(["namespaces", "docker"].includes(runs[0]!.driver), `a sandbox driver ran it, got ${runs[0]!.driver}`);

		// a code_run call in a new conversation cannot resolve (unknown tool): nothing is executed
		await say(t, a.token, c, call("code_run", { language: "python", code: "open('x','w').write('1')" }));
		assert.equal(t.app.ctx.db.all("SELECT 1 FROM tool_sandbox_runs WHERE space_id = ? AND conversation_id = ?", c.spaceId, c.conversationId).length, 1);
	} finally {
		await t.dispose();
	}
});

test("V18/V20: an old conversation's legacy code_run ends with the clear error (terminal, nothing executed); its other legacy tools still run; its state still loads", { skip, timeout: 120_000 }, async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("leg-old@example.com");
		const c = await oldConversation(t, a.me.userId, a.me.orgId, "旧对话");
		const offered: string[] = (await t.json("GET", base(c), { token: a.token })).agent.tools;
		for (const n of ["code_run", "sandbox_exec", "sandbox_write_file", "sandbox_read_file", "sandbox_list", "file_create", "file_read", "file_list", "memory_save", "skill"]) assert.ok(offered.includes(n), `legacy ${n} registered in the old conversation: ${offered.join(",")}`);

		const before = t.app.ctx.db.all("SELECT 1 FROM tool_sandbox_runs").length;
		const s = await say(t, a.token, c, call("code_run", { language: "python", code: "open('should-not-exist','w').write('1')" }));
		assert.equal(s.status, "done", "the task reaches a terminal state");
		const r = (await results(t, c, "code_run"))[0]!;
		assert.ok(r.isError);
		assert.equal(r.text, CODE_RUN_REMOVED);
		assert.equal(t.app.ctx.db.all("SELECT 1 FROM tool_sandbox_runs").length, before, "nothing was executed");

		// the other legacy tools of the old conversation still work
		await say(t, a.token, c, call("sandbox_write_file", { path: "legacy.txt", content: "旧工具" }));
		await say(t, a.token, c, call("sandbox_read_file", { path: "legacy.txt" }));
		const rd = (await results(t, c, "sandbox_read_file"))[0]!;
		assert.ok(!rd.isError, rd.text);
		assert.match(rd.text, /旧工具/);
		await say(t, a.token, c, call("sandbox_exec", { language: "shell", code: "echo legacy-exec" }));
		const ex = (await results(t, c, "sandbox_exec"))[0]!;
		assert.ok(!ex.isError, ex.text);
		assert.match(ex.text, /legacy-exec/);

		// V20 part: the history with legacy tool results still builds the state DTO and the conversation list
		const state = await t.json("GET", `${base(c)}/state`, { token: a.token });
		assert.ok(state.entries.length > 0);
		assert.ok(state.entries.some((e: any) => e.kind === "tool_result" && e.toolName === "code_run" && e.isError), "the legacy code_run result is in the history");
				const list = await t.json("GET", `/api/conversations?spaceId=${c.spaceId}`, { token: a.token });
		assert.ok(JSON.stringify(list).includes("旧对话"));
	} finally {
		await t.dispose();
	}
});
