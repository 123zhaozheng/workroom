// Retrieval events (M18-B): every search is recorded with correlation ids and is findable by requestId or
// <spaceId>:<conversationId>; query text is redacted per WORKROOM_REDACT and never written to logs.
process.env.WORKROOM_FIXTURE_TOOLS ??= "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestApp } from "./helpers/app.ts";
import { isSettled, waitFor } from "../src/runtime/testing.ts";
import { captureLogs } from "../src/ops/log.ts";
import { joinOrg, kbWithDoc, MIME } from "../src/knowledge/testing.ts";

test("retrieval events: correlation by requestId and conversation, redaction, admin-only, org-scoped, structured log", async () => {
	const t = await startTestApp();
	try {
		const alice = await t.user("alice@example.com"); // org owner
		const bob = await joinOrg(t, alice.me.orgId, "bob@example.com");
		const { kb } = await kbWithDoc(t, alice.token, { name: "Ops", scope: "org" }, { name: "runbook.md", mime: MIME.md, bytes: "# Runbook\n\nRestart the walrus service with care." });
		const search = async (token: string, requestId: string, query: string, extra: Record<string, unknown> = {}) => {
			const res = await t.req("POST", "/api/kb/search", { token, json: { query, ...extra }, headers: { "x-request-id": requestId } });
			assert.equal(res.status, 200);
			return res.json();
		};
		const lines = captureLogs(true);
		await search(bob.token, "req-kb-1", "walrus service password=hunter2secret");
		captureLogs(false);
		const ev = (await t.json("GET", "/api/kb/admin/retrieval-events?q=req-kb-1", { token: alice.token })).events;
		assert.equal(ev.length, 1);
		const e = ev[0];
		assert.equal(e.source, "api");
		assert.equal(e.requestId, "req-kb-1");
		assert.equal(e.userId, bob.me.userId);
		assert.deepEqual(e.kbIds, [kb.id]);
		assert.equal(e.hitCount, 1);
		assert.equal(e.reason, undefined);
		assert.ok(e.latencyMs >= 0 && typeof e.queryHash === "string" && e.queryHash.length === 16);
		assert.match(e.query, /walrus service password=\*\*\*/, "secrets masked in standard mode");
		assert.doesNotMatch(e.query, /hunter2secret/);
		// The structured log line carries the correlation ids and the hash, never the query text.
		const line = lines.map((l) => JSON.parse(l)).find((l) => l.event === "kb.search");
		assert.equal(line.requestId, "req-kb-1");
		assert.equal(line.queryHash, e.queryHash);
		assert.equal(line.hits, 1);
		assert.ok(!JSON.stringify(line).includes("walrus"));

		// Strict redaction: no query text stored at all; diagnostics reason recorded for a miss.
		process.env.WORKROOM_REDACT = "strict";
		try {
			await search(bob.token, "req-kb-2", "nonexistent quokka topic");
		} finally {
			delete process.env.WORKROOM_REDACT;
		}
		const e2 = (await t.json("GET", "/api/kb/admin/retrieval-events?q=req-kb-2", { token: alice.token })).events[0];
		assert.equal(e2.query, undefined);
		assert.equal(e2.reason, "no_evidence");
		assert.equal(e2.hitCount, 0);
		// Forbidden explicit KB ids are recorded too.
		const other = await t.user("eve@other.com");
		await search(other.token, "req-kb-3", "walrus", { kbIds: [kb.id] });
		const e3 = (await t.json("GET", "/api/kb/admin/retrieval-events?q=req-kb-3", { token: other.token })).events;
		assert.equal(e3.length, 1, "eve (owner of her own org) sees her own org's event");
		assert.equal(e3[0].reason, "forbidden");
		assert.deepEqual(e3[0].forbiddenKbIds, [kb.id]);
		// Org-scoped lookup: alice cannot see eve's org events and vice versa.
		assert.equal((await t.json("GET", "/api/kb/admin/retrieval-events?q=req-kb-3", { token: alice.token })).events.length, 0);
		assert.equal((await t.json("GET", "/api/kb/admin/retrieval-events?q=req-kb-1", { token: other.token })).events.length, 0);
		// Members cannot read events.
		await t.json("GET", "/api/kb/admin/retrieval-events?q=req-kb-1", { token: bob.token, expect: 403 });

		// Tool path: findable by <spaceId>:<conversationId>, with taskId + callId.
		const c = (await t.json("POST", "/api/conversations", { token: bob.token, json: {} })).conversation;
		const base = `/api/conversations/${c.spaceId}/${c.conversationId}`;
		const r = await t.json("POST", `${base}/messages`, { token: bob.token, json: { text: '[[call kb_search {"query":"walrus"}]]', requestId: randomUUID() } });
		await waitFor(async () => {
			const s = await t.json("GET", `${base}/submissions/${r.submissionId}`, { token: bob.token });
			return isSettled(s) ? s : undefined;
		});
		const te = (await t.json("GET", `/api/kb/admin/retrieval-events?q=${c.spaceId}:${c.conversationId}`, { token: alice.token })).events;
		assert.equal(te.length, 1);
		assert.equal(te[0].source, "tool");
		assert.equal(te[0].conversationId, c.conversationId);
		assert.ok(te[0].callId && Number.isInteger(te[0].taskId));
		assert.equal(te[0].hitCount, 1);
		// The same lookup is what E's /admin/trace merges (service method).
		const k = t.app.ctx.services.get("knowledgeAdmin") as any;
		assert.equal(k.retrievalEvents(alice.me.orgId, te[0].callId).length, 1);
	} finally {
		await t.dispose();
	}
});
