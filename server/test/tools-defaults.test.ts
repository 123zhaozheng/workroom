// Default toolset through the REAL runtime: a default conversation is offered sandbox_exec, codemode, browse, browser_*,
// job_* and the file tools; they work from the chat API with per-call ACL; an org admin can switch groups off (enforced per
// call for model-issued AND code-mode nested calls).
process.env.WORKROOM_RT_RETRY_MAX ??= "1";
process.env.WORKROOM_RT_RETRY_BASE_MS ??= "20";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { orgMember } from "./fixtures/util.ts";
import { probeIsolation } from "../src/tools/sandbox.ts";

type Conv = { spaceId: string; conversationId: number };
const base = (c: Conv) => `/api/conversations/${c.spaceId}/${c.conversationId}`;

async function say(t: TestApp, token: string, c: Conv, text: string) {
	const r = await t.json("POST", `${base(c)}/messages`, { token, json: { text, requestId: randomUUID() } });
	const deadline = Date.now() + 30_000;
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

test("default conversation offers exec/codemode/browser/jobs/unified file tools; they run with per-call ACL; org policy switches groups off", { skip: probeIsolation().ok ? false : probeIsolation().detail }, async () => {
	const t = await startTestApp();
	try {
		const admin = await t.user("defaults@example.com");
		const member = await orgMember(t, admin, "defaults-member@example.com");
		const c: Conv = (await t.json("POST", "/api/conversations", { token: member.token, json: { title: "默认工具" } })).conversation;
		const detail = await t.json("GET", base(c), { token: member.token });
		const offered: string[] = detail.agent.tools;
		for (const name of ["exec", "present_file", "read", "write", "ls", "codemode", "browse", "browser_open", "browser_act", "job_start", "job_status", "tool_search"]) assert.ok(offered.includes(name), `${name} not offered: ${offered.join(",")}`);
		for (const name of ["sandbox_exec", "sandbox_publish", "file_create", "file_read", "code_run", "skill"]) assert.ok(!offered.includes(name), `round 14: ${name} is replaced in new conversations`);
		assert.ok(!offered.some((n) => n.startsWith("mcp__")), "connector tools stay deferred");
		assert.ok(!offered.some((n) => /^skill_(list|load|read|run)$/.test(n)), "legacy skill_* tools are deferred, not offered");

		await say(t, member.token, c, `[[call exec {"command":"python3 -c 'print(6*7)'"}]]`);
		assert.match((await results(t, c, "exec"))[0]!.text, /\b42\b/);
		const runs = await t.json("GET", `/api/sandbox/${c.spaceId}/runs?conversationId=${c.conversationId}`, { token: member.token });
		assert.equal(runs.runs[0].stdout.trim(), "42"); // the work panel's terminal data is real
		await say(t, member.token, c, `[[call codemode {"code":"const r = await tools.exec({command:'echo via-codemode'}); console.log(r.output ?? r)"}]]`);
		assert.match((await results(t, c, "codemode"))[0]!.text, /via-codemode/);

		// Policy: members cannot change it; the admin switches the sandbox group off → model-issued and nested calls blocked.
		await t.json("PUT", "/api/tools/policy", { token: member.token, json: { groups: { sandbox: false } }, expect: 403 });
		const pol = await t.json("PUT", "/api/tools/policy", { token: admin.token, json: { groups: { sandbox: false } } });
		assert.equal(pol.groups.find((g: any) => g.id === "sandbox").enabled, false);
		assert.equal((await t.json("GET", "/api/tools/capabilities", { token: member.token })).sandbox.status, "disabled_by_admin");
		await say(t, member.token, c, `[[call exec {"command":"echo should-not-run"}]]`);
		const blocked = (await results(t, c, "exec"))[1]!;
		assert.equal(blocked.isError, true);
		assert.match(blocked.text, /组织管理员已关闭/);
		await say(t, member.token, c, `[[call codemode {"code":"try { await tools.exec({command:'echo nested'}); console.log('ran') } catch (e) { console.log('nested blocked: ' + e) }"}]]`);
		const nested = (await results(t, c, "codemode"))[1]!;
		assert.match(nested.text, /nested blocked/);
		assert.doesNotMatch(nested.text, /\bran\b/);
		const allRuns = await t.json("GET", `/api/sandbox/${c.spaceId}/runs?conversationId=${c.conversationId}`, { token: member.token });
		assert.equal(allRuns.runs.length, 2, "no sandbox run happened while the group was off");
		await t.json("PUT", "/api/tools/policy", { token: admin.token, json: { groups: { sandbox: true } } });

		// Per-call ACL: another org's user cannot drive this conversation at all.
		const other = await t.user("defaults-other@example.com");
		await t.json("POST", `${base(c)}/messages`, { token: other.token, json: { text: "[[call exec {\"command\":\"id\"}]]", requestId: randomUUID() }, expect: 403 });
	} finally {
		await t.dispose();
	}
});
