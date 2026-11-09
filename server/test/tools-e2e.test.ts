// D's tools through the REAL runtime (group A) and its fixture model ("测试模型，非真实 AI") via the chat API:
// file_create → file card → file_revise v2 → file_read of an attachment; MCP write tool → durable approval → effect receipt.
process.env.WORKROOM_RT_RETRY_MAX ??= "1";
process.env.WORKROOM_RT_RETRY_BASE_MS ??= "20";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { upload } from "./fixtures/util.ts";

type Conv = { spaceId: string; conversationId: number };
const base = (c: Conv) => `/api/conversations/${c.spaceId}/${c.conversationId}`;
const hasRuntime = async () => {
	try {
		await import("../src/runtime/module.ts");
		return true;
	} catch {
		return false;
	}
};
const skip = (await hasRuntime()) ? false : "runtime module (group A) not present";

async function waitFor<T>(fn: () => Promise<T | undefined | false>, what: string, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	for (;;) {
		try {
			const v = await fn();
			if (v) return v as T;
		} catch (e) {
			last = e;
		}
		if (Date.now() > deadline) throw new Error(`timed out: ${what} ${last instanceof Error ? last.message : ""}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}
async function send(t: TestApp, token: string, c: Conv, text: string, extra: Record<string, unknown> = {}) {
	return t.json("POST", `${base(c)}/messages`, { token, json: { text, requestId: randomUUID(), ...extra } });
}
async function settled(t: TestApp, token: string, c: Conv, submissionId: number) {
	return waitFor(async () => {
		const s = await t.json("GET", `${base(c)}/submissions/${submissionId}`, { token });
		return ["done", "unanswered", "withdrawn"].includes(s.status) ? s : undefined;
	}, "submission settles");
}
async function toolResults(t: TestApp, c: Conv, name: string) {
	const h = await t.app.ctx.services.get("runtime").harness(c.spaceId, BACKGROUND_CONTEXT);
	const conv = (await h.conversation(c.conversationId as any, BACKGROUND_CONTEXT))!;
	const items = (await conv.entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT)).items as any[];
	return items.filter((e) => e.kind === "pi.tool-result" && e.model?.[0]?.toolName === name).map((e) => ({ text: e.model[0].content.map((x: any) => x.text ?? "").join(""), details: e.model[0].details, isError: !!e.model[0].isError }));
}

test("e2e: fixture model drives file_create → v1 card, file_revise → v2, file_read of an attachment, through the chat API", { skip }, async () => {
	const t = await startTestApp();
	try {
		const u = await t.user("e2e@example.com");
		const c: Conv = (await t.json("POST", "/api/conversations", { token: u.token, json: { title: "交付测试" } })).conversation;
		const create = JSON.stringify({ name: "周报", format: "docx", title: "周报", content: "## 本周\n- 完成文件模块\n- 完成测试" });
		const s1 = await send(t, u.token, c, `[[call file_create ${create}]]`);
		assert.equal((await settled(t, u.token, c, s1.submissionId)).status, "done");
		const [r1] = await toolResults(t, c, "file_create");
		assert.equal(r1!.isError, false, r1!.text);
		const art = r1!.details.artifact;
		assert.equal(art.versionNo, 1);
		assert.equal(art.name, "周报.docx");
		const detail = await t.json("GET", `/api/files/${art.fileId}`, { token: u.token });
		assert.equal(detail.file.spaceId, c.spaceId);
		const prov = detail.versions[0].provenance;
		assert.equal(prov.conversationId, c.conversationId);
		assert.equal(prov.tool, "file_create");
		assert.equal(typeof prov.taskId, "number");
		assert.ok(prov.callId);
		// The library lists it for this conversation.
		assert.equal((await t.json("GET", `/api/files?conversationId=${c.conversationId}&spaceId=${c.spaceId}`, { token: u.token })).files.length, 1);

		const revise = JSON.stringify({ fileId: art.fileId, changeNote: "补充下周计划", baseVersionId: art.versionId, title: "周报", content: "## 本周\n- 完成文件模块\n\n## 下周\n- 集成测试" });
		const s2 = await send(t, u.token, c, `[[call file_revise ${revise}]]`);
		assert.equal((await settled(t, u.token, c, s2.submissionId)).status, "done");
		const [r2] = await toolResults(t, c, "file_revise");
		assert.equal(r2!.isError, false, r2!.text);
		assert.equal(r2!.details.artifact.versionNo, 2);
		const v1 = await t.req("GET", `/api/files/${art.fileId}/versions/${art.versionId}/download`, { token: u.token });
		const v1Text = (await mammoth.extractRawText({ buffer: Buffer.from(await v1.arrayBuffer()) })).value;
		assert.doesNotMatch(v1Text, /下周/);
		const v2 = await t.req("GET", `/api/files/${art.fileId}/versions/${r2!.details.artifact.versionId}/download`, { token: u.token });
		assert.match((await mammoth.extractRawText({ buffer: Buffer.from(await v2.arrayBuffer()) })).value, /集成测试/);

		// Attachment → file_read (ACL as the run's author).
		const up = await (await upload(t, u.token, "/files", "需求.md", "# 需求\n导出 PDF 报告")).json();
		const s3 = await send(t, u.token, c, `[[call file_read ${JSON.stringify({ versionId: up.version.versionId })}]]`, { attachments: [{ fileId: up.file.id, versionId: up.version.versionId, name: "需求.md" }] });
		assert.equal((await settled(t, u.token, c, s3.submissionId)).status, "done");
		const [r3] = await toolResults(t, c, "file_read");
		assert.match(r3!.text, /导出 PDF 报告/);
		// Another user's file is not readable by this user's run.
		const other = await t.user("e2e-other@example.com");
		const theirs = await (await upload(t, other.token, "/files", "secret.md", "TOP SECRET")).json();
		const s4 = await send(t, u.token, c, `[[call file_read ${JSON.stringify({ versionId: theirs.version.versionId })}]]`);
		await settled(t, u.token, c, s4.submissionId);
		const r4 = (await toolResults(t, c, "file_read"))[1]!;
		assert.equal(r4.isError, true);
		assert.doesNotMatch(r4.text, /TOP SECRET/);
	} finally {
		await t.dispose();
	}
});

test("e2e: MCP write tool goes through the runtime's durable approval and effect receipt; read tool runs directly", { skip }, async () => {
	const fixture = fileURLToPath(new URL("./fixtures/mcp-fixture-server.ts", import.meta.url));
	const args = ["--disable-warning=ExperimentalWarning", fixture];
	process.env.WORKROOM_MCP_STDIO_ALLOW = [process.execPath, ...args].join(" ");
	const notes = join(mkdtempSync(join(tmpdir(), "wr-e2e-notes-")), "notes.txt");
	const t = await startTestApp();
	try {
		const admin = await t.user("e2e-admin@example.com");
		const { connector } = await t.json("POST", "/api/connectors", { token: admin.token, json: { name: "Notes", scope: "system", transport: "stdio", command: process.execPath, args, env: { FIXTURE_NOTES: notes } } });
		assert.equal(connector.status, "ready", connector.statusDetail);
		const c: Conv = (await t.json("POST", "/api/conversations", { token: admin.token, json: { title: "连接器" } })).conversation;
		const s0 = await send(t, admin.token, c, `[[call tool_search {"query":"append note notebook echo"}]]`);
		await settled(t, admin.token, c, s0.submissionId);
		const echo = `mcp__${connector.handle}__echo`;
		const addNote = `mcp__${connector.handle}__add_note`;
		const [search] = await toolResults(t, c, "tool_search");
		assert.match(search!.text, new RegExp(addNote));

		const s1 = await send(t, admin.token, c, `[[call ${echo} {"text":"ping"}]]`);
		await settled(t, admin.token, c, s1.submissionId);
		assert.match((await toolResults(t, c, echo))[0]!.text, /echo: ping/);

		const s2 = await send(t, admin.token, c, `[[call ${addNote} {"text":"来自 e2e"}]]`);
		const approval = await waitFor(async () => (await t.json("GET", `${base(c)}/state`, { token: admin.token })).approvals.find((a: any) => a.status === "pending"), "approval pending");
		assert.match(approval.summary, /add_note/);
		assert.throws(() => readFileSync(notes, "utf8")); // nothing written before approval
		await t.json("POST", `${base(c)}/approvals/${approval.approvalId}`, { token: admin.token, json: { decision: "approved" } });
		assert.equal((await settled(t, admin.token, c, s2.submissionId)).status, "done");
		const [w] = await toolResults(t, c, addNote);
		assert.equal(w!.isError, false, w!.text);
		assert.equal(readFileSync(notes, "utf8"), "来自 e2e\n");
		const state = await t.json("GET", `${base(c)}/state`, { token: admin.token });
		assert.ok(state.effects.some((e: any) => String(e.target ?? "").includes("add_note") || JSON.stringify(e).includes("add_note")));
		const rec = (await t.json("GET", `/api/tool-calls?spaceId=${c.spaceId}&conversationId=${c.conversationId}`, { token: admin.token })).calls;
		assert.ok(rec.some((r: any) => r.tool === addNote && r.status === "ok"));
	} finally {
		delete process.env.WORKROOM_MCP_STDIO_ALLOW;
		await t.dispose();
	}
});
