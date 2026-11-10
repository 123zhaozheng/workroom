// Round 5 (UI group 2): user messages carry `displayText` (fixture test directives stripped) and `hasTestDirectives`;
// `text` stays the raw input so existing consumers keep working.
//   node --disable-warning=ExperimentalWarning --test server/test/round5-display.test.ts
process.env.WORKROOM_FIXTURE_TOOLS = "1";
process.env.WORKROOM_RT_RETRY_BASE_MS ??= "20";
process.env.WORKROOM_RT_RETRY_MAX ??= "1";
process.env.WORKROOM_SSE_THROTTLE_MS ??= "20";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestApp } from "./helpers/app.ts";
import { isSettled, waitFor } from "../src/runtime/testing.ts";
import { entryDTO, userDisplay } from "../src/runtime/dto.ts";
import type { ConversationState, EntryDTO, SubmissionDTO, UserEntryDTO } from "../../shared/chat.ts";

test("userDisplay: strips every directive (JSON-aware), flags them, leaves plain text untouched", () => {
	assert.deepEqual(userDisplay("你好，世界"), { displayText: "你好，世界", hasTestDirectives: false });
	assert.deepEqual(userDisplay("  保留  空格 "), { displayText: "  保留  空格 ", hasTestDirectives: false });
	const raw = '帮我写周报 [[call file_create {"name":"周报","content":"# a ]] b\\n[[x]]"}]] [[slow 500]] 谢谢';
	const d = userDisplay(raw);
	assert.equal(d.hasTestDirectives, true);
	assert.equal(d.displayText, "帮我写周报 谢谢");
	assert.ok(!d.displayText.includes("[[") && !d.displayText.includes("file_create"));
	// only directives: nothing left to show
	assert.deepEqual(userDisplay("[[fail]]"), { displayText: "", hasTestDirectives: true });
	assert.deepEqual(userDisplay("[[reply 好的]]"), { displayText: "", hasTestDirectives: true });
	// unknown [[...]] is ordinary text, not a directive
	assert.deepEqual(userDisplay("见 [[附录]] 第二节"), { displayText: "见 [[附录]] 第二节", hasTestDirectives: false });
});

test("entryDTO: wr.input and pi.user entries get displayText, text is unchanged", () => {
	const raw = '[[call kb_search {"query":"报销"}]] 查一下报销时限';
	const e = entryDTO({ id: 7, conversationId: 1, kind: "wr.input", data: { text: raw, userId: "u1" }, model: [{ role: "user", content: raw }] } as any) as UserEntryDTO;
	assert.equal(e.kind, "user");
	assert.equal(e.text, raw);
	assert.equal(e.displayText, "查一下报销时限");
	assert.equal(e.hasTestDirectives, true);
	const p = entryDTO({ id: 8, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "[[slow 10]]你好" }] } as any) as UserEntryDTO;
	assert.equal(p.text, "[[slow 10]]你好");
	assert.equal(p.displayText, "你好");
	assert.equal(p.hasTestDirectives, true);
});

test("API: entries and SSE state expose displayText for user messages; text is the raw input", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("r5-disp@example.com");
		const c = (await t.json("POST", "/api/conversations", { token: a.token, json: {} })).conversation as { spaceId: string; conversationId: number };
		const base = `/api/conversations/${c.spaceId}/${c.conversationId}`;
		const raw = '整理要点 [[call wr_fixture_echo {"text":"hi"}]] [[reply 好的]]';
		const r = (await t.json("POST", `${base}/messages`, { token: a.token, json: { text: raw, requestId: randomUUID() } })) as { submissionId: number };
		await waitFor(async () => {
			const s = (await t.json("GET", `${base}/submissions/${r.submissionId}`, { token: a.token })) as SubmissionDTO;
			return isSettled(s) ? s : undefined;
		}, { timeoutMs: 20_000, what: "submission settles" });
		const items: EntryDTO[] = (await t.json("GET", `${base}/entries?limit=100`, { token: a.token })).items;
		const user = items.find((e) => e.kind === "user") as UserEntryDTO;
		assert.equal(user.text, raw, "text keeps the raw input");
		assert.equal(user.displayText, "整理要点");
		assert.equal(user.hasTestDirectives, true);
		const st = (await t.json("GET", `${base}/state`, { token: a.token })) as ConversationState;
		const su = st.entries.find((e) => e.kind === "user") as UserEntryDTO;
		assert.equal(su.displayText, "整理要点");
		assert.equal(su.text, raw);

		// a plain message: displayText equals text and no flag
		const r2 = (await t.json("POST", `${base}/messages`, { token: a.token, json: { text: "再补充一句", requestId: randomUUID() } })) as { submissionId: number };
		await waitFor(async () => {
			const s = (await t.json("GET", `${base}/submissions/${r2.submissionId}`, { token: a.token })) as SubmissionDTO;
			return isSettled(s) ? s : undefined;
		}, { timeoutMs: 20_000, what: "second submission settles" });
		const items2: EntryDTO[] = (await t.json("GET", `${base}/entries?limit=100`, { token: a.token })).items;
		const plain = items2.filter((e) => e.kind === "user").at(-1) as UserEntryDTO;
		assert.equal(plain.text, "再补充一句");
		assert.equal(plain.displayText, "再补充一句");
		assert.equal(plain.hasTestDirectives, false);
	} finally {
		await t.dispose();
	}
});
