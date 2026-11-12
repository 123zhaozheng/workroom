// Round 11 (R6): sandbox lifecycle statistics — percentiles, running time (closed + open intervals), cost with / without a price, prewarm what-if table,
// wasted prewarms, code_run backend counts, permissions and organisation isolation. Events / logs are SEEDED into the real tables (the lifecycle that
// writes them is covered by sandbox-lifecycle.test.ts and sandbox-prewarm.test.ts); everything else goes through the real HTTP API.
//   node --disable-warning=ExperimentalWarning --test --test-concurrency=1 server/test/r11-sandbox-stats.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestApp } from "./helpers/app.ts";
import { FakeRemoteProvider } from "./helpers/fake-remote-provider.ts";
import { DEFAULT_LIMITS } from "../src/tools/sandbox.ts";
import { RemoteDriver } from "../src/tools/sandbox/remote-driver.ts";
import type { DriverRunSpec } from "../src/tools/sandbox/driver.ts";
import { orgMember } from "./fixtures/util.ts";
import { answer, call, fixedActor, toolHarness } from "./fixtures/tool-harness.ts";
import { recordSandboxEvent, sandboxEventsOf, type SandboxEventKind, type SandboxEventTrigger } from "../src/tools/sandbox/lifecycle-events.ts";
import { codeRunStats, nearestRank, parseRange, percentiles, sandboxStats } from "../src/tools/sandbox/lifecycle-stats.ts";
import { createLocalExecExtension } from "../src/tools/localexec/extension.ts";
import type { LocalExec } from "../src/tools/localexec/service.ts";
import type { SandboxConversationStatsResponse, SandboxPricesDTO, SandboxStatsDTO } from "../../shared/sandbox-stats.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

interface Conv {
	spaceId: string;
	conversationId: number;
}

async function world() {
	const t = await startTestApp();
	const owner = await t.user("own@r11stats.example");
	const member = await orgMember(t, owner, "mem@r11stats.example");
	const stranger = await t.user("out@other-org.example");
	const mk = async (token: string) => (await t.json("POST", "/api/conversations", { token, json: {} })).conversation as Conv;
	const a = await mk(owner.token);
	const b = await mk(owner.token);
	const m = await mk(member.token);
	const x = await mk(stranger.token);
	const db = t.app.ctx.db;
	const seed = (org: string, c: Conv, kind: SandboxEventKind, trigger: SandboxEventTrigger, o: { provider?: string; durationMs?: number; runningMs?: number; at: number }) =>
		recordSandboxEvent(db, { orgId: org, spaceId: c.spaceId, workspaceKey: `c${c.conversationId}`, provider: o.provider ?? "opensandbox", kind, trigger, durationMs: o.durationMs, runningMs: o.runningMs, at: iso(o.at) });
	const instance = (org: string, c: Conv, provider: string, state: string, runningSince: number | null, id: string) =>
		db.run(
			"INSERT INTO tool_sandbox_instances (id, provider, space_id, workspace_key, remote_id, state, created_at, last_used_at, org_id, state_at, running_since) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			id, provider, c.spaceId, `c${c.conversationId}`, `r-${id}`, state, iso(Date.now() - 48 * HOUR), iso(Date.now() - HOUR), org, iso(Date.now() - HOUR), runningSince === null ? null : iso(runningSince),
		);
	const stats = (token: string, q = "") => t.json<SandboxStatsDTO>("GET", `/api/stats/sandbox${q}`, { token });
	return { t, owner, member, stranger, a, b, m, x, db, orgId: owner.me.orgId as string, seed, instance, stats };
}

// ------------------------------------------------------------------ percentiles
test("nearest-rank percentiles: empty, single value, unsorted input, exact ranks", () => {
	assert.equal(nearestRank([], 50), null);
	assert.deepEqual(percentiles([]), { n: 0, p50: null, p95: null });
	assert.deepEqual(percentiles([7]), { n: 1, p50: 7, p95: 7 });
	assert.deepEqual(percentiles([40, 10, 30, 20]), { n: 4, p50: 20, p95: 40 }, "rank ceil(0.5*4)=2, ceil(0.95*4)=4");
	const hundred = Array.from({ length: 100 }, (_, i) => i + 1).reverse();
	assert.deepEqual(percentiles(hundred), { n: 100, p50: 50, p95: 95 });
	assert.equal(nearestRank([1, 2, 3, 4, 5], 100), 5);
	assert.equal(nearestRank([1, 2, 3, 4, 5], 0), 1, "rank is clamped to 1");
	assert.deepEqual(percentiles([0, 0, 0]), { n: 3, p50: 0, p95: 0 });
});

test("range / provider parsing: defaults, bad input, limits", () => {
	const now = Date.parse("2026-11-11T12:00:00.000Z");
	const d = parseRange(undefined, undefined, now);
	assert.equal(Date.parse(d.to), now + 1);
	assert.equal(Date.parse(d.to) - Date.parse(d.from), 30 * 24 * HOUR);
	assert.throws(() => parseRange("yesterday", undefined, now), /ISO/);
	assert.throws(() => parseRange("2026-11-02T00:00:00Z", "2026-11-01T00:00:00Z", now), /早于/);
	assert.throws(() => parseRange("2020-01-01T00:00:00Z", "2026-11-01T00:00:00Z", now), /最长 800 天/);
});

// ------------------------------------------------------------------ aggregation
test("organisation aggregation: counts by trigger, failures, cold start / resume P50 P95, idle pauses, archives, destroys, running time, range edges, provider filter", async () => {
	const w = await world();
	try {
		const T0 = Date.parse("2026-10-01T00:00:00.000Z");
		const at = (min: number) => T0 + min * MIN;
		const S = w.seed;
		// conversation A on opensandbox
		for (const [i, ms] of [100, 200, 300].entries()) S(w.orgId, w.a, "create", "exec", { durationMs: ms, at: at(10 + i) });
		S(w.orgId, w.a, "create", "prewarm", { durationMs: 400, at: at(20) });
		S(w.orgId, w.a, "create", "explicit", { durationMs: 1000, at: at(21) });
		S(w.orgId, w.a, "create_failed", "exec", { durationMs: 9000, at: at(22) });
		S(w.orgId, w.a, "resume", "exec", { durationMs: 50, at: at(30) });
		S(w.orgId, w.a, "resume", "exec", { durationMs: 150, at: at(31) });
		S(w.orgId, w.a, "resume_failed", "exec", { durationMs: 70, at: at(32) });
		S(w.orgId, w.a, "pause", "idle", { runningMs: 10 * MIN, at: at(40) });
		S(w.orgId, w.a, "pause", "idle", { runningMs: 10 * MIN, at: at(41) });
		S(w.orgId, w.a, "archive", "retention", { at: at(50) });
		S(w.orgId, w.a, "destroy", "expiry", { runningMs: 0, at: at(60) });
		// conversation B on e2b
		S(w.orgId, w.b, "create", "exec", { provider: "e2b", durationMs: 5000, at: at(70) });
		S(w.orgId, w.b, "pause", "idle", { provider: "e2b", runningMs: HOUR, at: at(80) });
		S(w.orgId, w.b, "destroy", "admin", { provider: "e2b", runningMs: 30 * MIN, at: at(90) });
		// range edges: before `from` and exactly `to` are out
		S(w.orgId, w.a, "create", "exec", { durationMs: 99999, at: T0 - 1 });
		S(w.orgId, w.a, "create", "exec", { durationMs: 99999, at: T0 + 24 * HOUR });
		// another organisation never shows up
		S(w.stranger.me.orgId, w.x, "create", "exec", { durationMs: 12345, at: at(15) });
		S(w.stranger.me.orgId, w.x, "pause", "idle", { runningMs: 5 * HOUR, at: at(16) });

		const q = `?from=${iso(T0)}&to=${iso(T0 + 24 * HOUR)}`;
		const s = await w.stats(w.owner.token, q);
		assert.equal(s.provider, null);
		assert.equal(s.total.creates, 6);
		assert.deepEqual(s.total.createsByTrigger, { exec: 4, prewarm: 1, explicit: 1 });
		assert.equal(s.total.createFailures, 1);
		assert.deepEqual(s.total.coldStart, { n: 6, p50: 300, p95: 5000 });
		assert.equal(s.total.resumes, 2);
		assert.equal(s.total.resumeFailures, 1);
		assert.deepEqual(s.total.resume, { n: 2, p50: 50, p95: 150 });
		assert.equal(s.total.idlePauses, 3);
		assert.equal(s.total.archives, 1);
		assert.equal(s.total.destroys, 2);
		assert.equal(s.total.runningMs, 20 * MIN + HOUR + 30 * MIN, "closed intervals that ended in the range");
		assert.equal(s.total.openRunningMs, 0, "now is outside the range: open intervals are not counted");
		assert.equal(s.total.costUsd, null, "no price configured");
		assert.equal(s.costComplete, false, "running time exists but nothing is priced");
		assert.deepEqual(s.byProvider.map((p) => p.provider), ["e2b", "opensandbox"]);
		const os = s.byProvider.find((p) => p.provider === "opensandbox")!;
		assert.equal(os.creates, 5);
		assert.deepEqual(os.coldStart, { n: 5, p50: 300, p95: 1000 });
		assert.equal(os.priceUsdPerHour, null);
		assert.equal(os.costUsd, null);
		// per conversation: B (1.5 h) before A (20 min); titles only for conversations the viewer may read (own personal ones)
		assert.deepEqual(s.conversations.map((c) => c.conversationId), [w.b.conversationId, w.a.conversationId]);
		assert.equal(s.conversations[1]!.creates, 5);
		assert.equal(s.conversations[1]!.runningMs, 20 * MIN);
		assert.equal(typeof s.conversations[0]!.title, "string");

		// provider filter narrows the lifecycle numbers
		const f = await w.stats(w.owner.token, `${q}&provider=e2b`);
		assert.equal(f.provider, "e2b");
		assert.equal(f.total.creates, 1);
		assert.deepEqual(f.total.coldStart, { n: 1, p50: 5000, p95: 5000 });
		assert.equal(f.total.runningMs, HOUR + 30 * MIN);
		assert.deepEqual(f.byProvider.map((p) => p.provider), ["e2b"]);
		assert.equal(f.conversations.length, 1);

		// bad input is a visible 400, never ignored
		for (const bad of ["?provider=nope", "?from=garbage", `?from=${iso(T0 + HOUR)}&to=${iso(T0)}`]) await w.t.json("GET", `/api/stats/sandbox${bad}`, { token: w.owner.token, expect: 400 });
		// the empty range: everything null / zero, no invented numbers
		const empty = await w.stats(w.owner.token, `?from=${iso(T0 - 10 * 24 * HOUR)}&to=${iso(T0 - 9 * 24 * HOUR)}`);
		assert.equal(empty.total.creates, 0);
		assert.deepEqual(empty.total.coldStart, { n: 0, p50: null, p95: null });
		assert.deepEqual(empty.total.resume, { n: 0, p50: null, p95: null });
		assert.equal(empty.byProvider.length, 0);
		assert.equal(empty.total.costUsd, null);
	} finally {
		await w.t.dispose();
	}
});

test("running time includes still-running sandboxes up to now (only when now is in the range); paused / destroyed instances do not count", async () => {
	const w = await world();
	try {
		const now = Date.parse("2026-11-11T12:00:00.000Z");
		w.seed(w.orgId, w.a, "pause", "idle", { runningMs: 30 * MIN, at: now - 5 * HOUR });
		w.instance(w.orgId, w.a, "opensandbox", "ready", now - 2 * HOUR, "i-a");
		w.instance(w.orgId, w.b, "e2b", "pausing", now - 30 * MIN, "i-b");
		w.instance(w.orgId, w.m, "opensandbox", "paused", now - 10 * HOUR, "i-m"); // paused: not running (another org's member? same org: member is in the org)
		w.instance(w.stranger.me.orgId, w.x, "opensandbox", "ready", now - 9 * HOUR, "i-x"); // other organisation
		const inRange = await sandboxStats(w.t.app.ctx, w.orgId, { from: iso(now - 7 * 24 * HOUR), to: iso(now + HOUR), provider: null, now });
		assert.equal(inRange.total.openRunningMs, 2 * HOUR + 30 * MIN);
		assert.equal(inRange.total.runningMs, 30 * MIN + 2 * HOUR + 30 * MIN);
		const a = inRange.conversations.find((c) => c.conversationId === w.a.conversationId)!;
		assert.equal(a.runningMs, 30 * MIN + 2 * HOUR);
		assert.equal(a.openRunningMs, 2 * HOUR);
		// a range that ended before now does not count the open interval (it has not ended in it)
		const past = await sandboxStats(w.t.app.ctx, w.orgId, { from: iso(now - 7 * 24 * HOUR), to: iso(now - HOUR), provider: null, now });
		assert.equal(past.total.openRunningMs, 0);
		assert.equal(past.total.runningMs, 30 * MIN);
		// provider filter applies to the open intervals too
		const e2b = await sandboxStats(w.t.app.ctx, w.orgId, { from: iso(now - 7 * 24 * HOUR), to: iso(now + HOUR), provider: "e2b", now });
		assert.equal(e2b.total.runningMs, 30 * MIN);
		// the live API agrees about "up to now": a 2 h open interval is at least 2 h and not wildly more
		w.instance(w.orgId, w.m, "daytona", "ready", Date.now() - 2 * HOUR, "i-live");
		const live = await w.stats(w.owner.token, `?provider=daytona`);
		assert.ok(live.total.openRunningMs >= 2 * HOUR && live.total.openRunningMs < 2 * HOUR + 2 * MIN, String(live.total.openRunningMs));
	} finally {
		await w.t.dispose();
	}
});

// ------------------------------------------------------------------ cost
test("estimated cost: no price -> null everywhere; price -> hours x price per provider; partial prices flagged; clearing a price removes the cost; validation and permission", async () => {
	const w = await world();
	try {
		const T0 = Date.parse("2026-10-01T00:00:00.000Z");
		w.seed(w.orgId, w.a, "pause", "idle", { runningMs: 90 * MIN, at: T0 + HOUR });
		w.seed(w.orgId, w.b, "destroy", "admin", { provider: "e2b", runningMs: 2 * HOUR, at: T0 + 2 * HOUR });
		const q = `?from=${iso(T0)}&to=${iso(T0 + 24 * HOUR)}`;
		const none = await w.stats(w.owner.token, q);
		assert.equal(none.total.costUsd, null);
		assert.ok(none.byProvider.every((p) => p.costUsd === null && p.priceUsdPerHour === null));
		assert.ok(none.conversations.every((c) => c.costUsd === null));
		assert.deepEqual((await w.t.json<SandboxPricesDTO>("GET", "/api/sandbox/prices", { token: w.owner.token })).prices, {});

		// one provider priced: the cost is that provider's, and the total is flagged incomplete (e2b has running time but no price)
		const put = await w.t.json<SandboxPricesDTO>("PUT", "/api/sandbox/prices", { token: w.owner.token, json: { prices: { opensandbox: 0.4 } } });
		assert.deepEqual(put.prices, { opensandbox: 0.4 });
		const part = await w.stats(w.owner.token, q);
		assert.equal(part.total.costUsd, 0.6, "1.5 h x 0.4");
		assert.equal(part.costComplete, false);
		assert.equal(part.byProvider.find((p) => p.provider === "opensandbox")!.costUsd, 0.6);
		assert.equal(part.byProvider.find((p) => p.provider === "e2b")!.costUsd, null);
		assert.equal(part.byProvider.find((p) => p.provider === "opensandbox")!.priceUsdPerHour, 0.4);

		// both priced: complete; per-conversation cost = its own hours x its provider's price
		await w.t.json("PUT", "/api/sandbox/prices", { token: w.owner.token, json: { prices: { e2b: 1.25 } } });
		const full = await w.stats(w.owner.token, q);
		assert.equal(full.costComplete, true);
		assert.equal(full.total.costUsd, 0.6 + 2.5);
		assert.equal(full.conversations.find((c) => c.conversationId === w.b.conversationId)!.costUsd, 2.5);
		assert.equal(full.conversations.find((c) => c.conversationId === w.a.conversationId)!.costUsd, 0.6);
		// the provider filter prices just that provider
		assert.equal((await w.stats(w.owner.token, `${q}&provider=e2b`)).total.costUsd, 2.5);

		// price 0 is a real price (free), null clears
		await w.t.json("PUT", "/api/sandbox/prices", { token: w.owner.token, json: { prices: { e2b: 0, opensandbox: null } } });
		const zero = await w.stats(w.owner.token, q);
		assert.equal(zero.byProvider.find((p) => p.provider === "e2b")!.costUsd, 0);
		assert.equal(zero.byProvider.find((p) => p.provider === "opensandbox")!.costUsd, null);
		await w.t.json("PUT", "/api/sandbox/prices", { token: w.owner.token, json: { prices: { e2b: null } } });
		assert.equal((await w.stats(w.owner.token, q)).total.costUsd, null, "all prices cleared: no cost, nothing invented");

		// validation: visible 400s
		for (const bad of [{ prices: { e2b: -1 } }, { prices: { e2b: "3" } }, { prices: { e2b: 99999 } }, { prices: { nope: 1 } }, { prices: [] }, {}, { prices: { e2b: true } }]) {
			await w.t.json("PUT", "/api/sandbox/prices", { token: w.owner.token, json: bad, expect: 400 });
		}
		// permission: a plain member neither reads nor writes prices
		await w.t.json("GET", "/api/sandbox/prices", { token: w.member.token, expect: 403 });
		await w.t.json("PUT", "/api/sandbox/prices", { token: w.member.token, json: { prices: { e2b: 1 } }, expect: 403 });
		// the change is audited
		const audited = w.db.all<{ action: string }>("SELECT action FROM id_audit WHERE action = 'sandbox.prices.update'");
		assert.ok(audited.length >= 4, String(audited.length));
		// prices are organisation-level: the other organisation sees none
		assert.deepEqual((await w.t.json<SandboxPricesDTO>("GET", "/api/sandbox/prices", { token: w.stranger.token })).prices, {});
	} finally {
		await w.t.dispose();
	}
});

// ------------------------------------------------------------------ permissions, isolation, per-conversation endpoint
test("permissions: org endpoint needs organisation stats access; conversation endpoint needs read on the conversation and hides cost without it; other org gets 404", async () => {
	const w = await world();
	try {
		const T0 = Date.now() - 2 * HOUR;
		w.seed(w.orgId, w.m, "create", "exec", { durationMs: 700, at: T0 });
		w.seed(w.orgId, w.m, "pause", "idle", { runningMs: HOUR, at: T0 + HOUR });
		w.seed(w.orgId, w.a, "create", "prewarm", { durationMs: 900, at: T0 });
		w.seed(w.stranger.me.orgId, w.x, "create", "exec", { durationMs: 4242, at: T0 });
		await w.t.json("PUT", "/api/sandbox/prices", { token: w.owner.token, json: { prices: { opensandbox: 2 } } });

		// organisation endpoint
		await w.t.json("GET", "/api/stats/sandbox", { token: w.member.token, expect: 403 });
		await w.t.json("GET", "/api/stats/sandbox", { expect: 401 });
		const org = await w.stats(w.owner.token);
		assert.equal(org.total.creates, 2, "owner's org only: the member's and the owner's conversations, not the other organisation");
		const mine = org.conversations.find((c) => c.spaceId === w.m.spaceId && c.conversationId === w.m.conversationId)!;
		assert.equal(mine.title, null, "the org admin cannot read the member's personal conversation, so no title");
		assert.equal(typeof org.conversations.find((c) => c.spaceId === w.a.spaceId && c.conversationId === w.a.conversationId)!.title, "string");
		const other = await w.stats(w.stranger.token).catch((e) => e);
		// the stranger is the owner of their own org and sees only their own numbers
		assert.equal((other as SandboxStatsDTO).total.creates, 1);
		assert.deepEqual((other as SandboxStatsDTO).total.coldStart, { n: 1, p50: 4242, p95: 4242 });

		// conversation endpoint
		const url = (c: Conv) => `/api/conversations/${c.spaceId}/${c.conversationId}/sandbox-stats`;
		const asMember = await w.t.json<SandboxConversationStatsResponse>("GET", url(w.m), { token: w.member.token });
		assert.equal(asMember.stats.creates, 1);
		assert.deepEqual(asMember.stats.coldStart, { n: 1, p50: 700, p95: 700 });
		assert.equal(asMember.stats.runningMs, HOUR);
		assert.equal(asMember.costVisible, false);
		assert.equal(asMember.stats.costUsd, null, "no cost for a user without organisation stats access, even though a price is configured");
		assert.ok(!JSON.stringify(asMember).includes("opensandbox"), "no provider names / prices leak");
		const asOwner = await w.t.json<SandboxConversationStatsResponse>("GET", url(w.a), { token: w.owner.token });
		assert.equal(asOwner.costVisible, true);
		assert.equal(asOwner.stats.creates, 1);
		assert.equal(asOwner.stats.costUsd, 0, "price configured, no running time yet -> 0");
		// someone who cannot read the conversation
		const denied = await w.t.req("GET", url(w.m), { token: w.owner.token });
		assert.ok(denied.status === 403 || denied.status === 404, String(denied.status));
		// other organisation: the space does not exist for them; unknown conversation: 404; bad id: 400
		await w.t.json("GET", url(w.a), { token: w.stranger.token, expect: 404 });
		await w.t.json("GET", `/api/conversations/${w.a.spaceId}/99999/sandbox-stats`, { token: w.owner.token, expect: 404 });
		await w.t.json("GET", `/api/conversations/${w.a.spaceId}/abc/sandbox-stats`, { token: w.owner.token, expect: 400 });
		await w.t.json("GET", url(w.a), { expect: 401 });
		// a conversation without any sandbox: zeros, nulls
		const none = await w.t.json<SandboxConversationStatsResponse>("GET", url(w.b), { token: w.owner.token });
		assert.equal(none.stats.creates, 0);
		assert.deepEqual(none.stats.coldStart, { n: 0, p50: null, p95: null });
	} finally {
		await w.t.dispose();
	}
});

// ------------------------------------------------------------------ prewarm tuning
test("prewarm tuning: precision / recall at the logged decisions and the what-if table 0.1 … 0.9 from the logged scores", async () => {
	const w = await world();
	try {
		const T0 = Date.now() - HOUR;
		const row = (id: number, score: number, fired: number, reason: string, used: boolean, org = w.orgId) =>
			w.db.run(
				"INSERT INTO tool_sandbox_prewarm_log (org_id, space_id, conversation_id, at, score, threshold, fired, reason, signals, used_at) VALUES (?, ?, ?, ?, ?, 0.3, ?, ?, '', ?)",
				org, w.a.spaceId, id, iso(T0 + id), score, fired, reason, used ? iso(T0 + id + 1000) : null,
			);
		row(1, 0.95, 1, "fired", true);
		row(2, 0.65, 1, "fired", true);
		row(3, 0.45, 1, "fired", false);
		row(4, 0.35, 1, "fired", true);
		row(5, 0.25, 0, "below", true);
		row(6, 0.15, 0, "below", false);
		row(7, 0.05, 0, "below", false);
		row(8, 0.5, 0, "ready", true); // says nothing about the threshold
		row(9, 0.9, 1, "fired", true, w.stranger.me.orgId); // other organisation
		const s = await w.stats(w.owner.token);
		const p = s.prewarm;
		assert.equal(p.threshold, 0.3);
		assert.equal(p.enabled, true);
		assert.equal(p.decisions, 8);
		assert.equal(p.fired, 4);
		assert.equal(p.firedUsed, 3);
		assert.equal(p.precision, 0.75);
		assert.equal(p.recall, 0.75, "3 / (3 + 1 below-threshold message that was followed by an exec)");
		assert.deepEqual(p.whatIf.map((r) => r.threshold), [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
		const at = (t: number) => p.whatIf.find((r) => r.threshold === t)!;
		const tri = (t: number) => [at(t).truePositive, at(t).falsePositive, at(t).falseNegative, at(t).precision, at(t).recall];
		assert.deepEqual(tri(0.1), [4, 2, 0, 0.667, 1]);
		assert.deepEqual(tri(0.2), [4, 1, 0, 0.8, 1]);
		assert.deepEqual(tri(0.3), [3, 1, 1, 0.75, 0.75], "equals the actual precision / recall at the current threshold");
		assert.deepEqual(tri(0.4), [2, 1, 2, 0.667, 0.5]);
		assert.deepEqual(tri(0.5), [2, 0, 2, 1, 0.5]);
		assert.deepEqual(tri(0.6), [2, 0, 2, 1, 0.5]);
		assert.deepEqual(tri(0.7), [1, 0, 3, 1, 0.25]);
		assert.deepEqual(tri(0.9), [1, 0, 3, 1, 0.25]);
		// the range limits the log; an empty range has no ratios
		const none = await w.stats(w.owner.token, `?from=${iso(T0 - 5 * 24 * HOUR)}&to=${iso(T0 - 4 * 24 * HOUR)}`);
		assert.equal(none.prewarm.decisions, 0);
		assert.equal(none.prewarm.precision, null);
		assert.equal(none.prewarm.recall, null);
		assert.ok(none.prewarm.whatIf.every((r) => r.precision === null && r.recall === null));
		// the configured threshold is reported
		await w.t.json("PUT", "/api/sandbox/prewarm", { token: w.owner.token, json: { threshold: 0.5 } });
		assert.equal((await w.stats(w.owner.token)).prewarm.threshold, 0.5);
		// the provider filter does not change the (organisation-wide) prewarm block
		assert.equal((await w.stats(w.owner.token, "?provider=e2b")).prewarm.fired, 4);
	} finally {
		await w.t.dispose();
	}
});

test("wasted prewarms: fired, and the sandbox was paused / destroyed before any exec; an exec after the pause does not rescue it; still-running ones are pending; failed starts are neither", async () => {
	const w = await world();
	try {
		const T0 = Date.now() - 3 * HOUR;
		const S = w.seed;
		const convs: Conv[] = [];
		for (let i = 0; i < 6; i++) convs.push((await w.t.json("POST", "/api/conversations", { token: w.owner.token, json: {} })).conversation as Conv);
		const fire = (c: Conv, used: number | null) =>
			w.db.run(
				"INSERT INTO tool_sandbox_prewarm_log (org_id, space_id, conversation_id, at, score, threshold, fired, reason, signals, used_at) VALUES (?, ?, ?, ?, 0.8, 0.3, 1, 'fired', '', ?)",
				w.orgId, c.spaceId, c.conversationId, iso(T0), used === null ? null : iso(used),
			);
		// 0: unused, paused after 4 min -> wasted (240 s of running time)
		fire(convs[0]!, null);
		S(w.orgId, convs[0]!, "create", "prewarm", { durationMs: 500, at: T0 + 1000 });
		S(w.orgId, convs[0]!, "pause", "idle", { runningMs: 4 * MIN, at: T0 + 5 * MIN });
		// 1: used 30 s after the start, before the pause -> fine
		fire(convs[1]!, T0 + 30_000);
		S(w.orgId, convs[1]!, "create", "prewarm", { durationMs: 500, at: T0 + 2000 });
		S(w.orgId, convs[1]!, "pause", "idle", { runningMs: 5 * MIN, at: T0 + 5 * MIN });
		// 2: the exec came 10 min later, after the pause -> still wasted (300 s)
		fire(convs[2]!, T0 + 10 * MIN);
		S(w.orgId, convs[2]!, "create", "prewarm", { durationMs: 500, at: T0 + 1000 });
		S(w.orgId, convs[2]!, "pause", "idle", { runningMs: 5 * MIN, at: T0 + 5 * MIN });
		// 3: unused and still running -> pending
		fire(convs[3]!, null);
		S(w.orgId, convs[3]!, "create", "prewarm", { durationMs: 500, at: T0 + 1000 });
		// 4: the start failed -> no sandbox, neither wasted nor pending
		fire(convs[4]!, null);
		S(w.orgId, convs[4]!, "create_failed", "prewarm", { durationMs: 500, at: T0 + 1000 });
		// 5: prewarm resumed a paused sandbox that was then destroyed unused -> wasted (60 s)
		fire(convs[5]!, null);
		S(w.orgId, convs[5]!, "resume", "prewarm", { durationMs: 80, at: T0 + 1000 });
		S(w.orgId, convs[5]!, "destroy", "expiry", { runningMs: MIN, at: T0 + 2 * MIN });
		const p = (await w.stats(w.owner.token)).prewarm;
		assert.equal(p.fired, 6);
		assert.equal(p.firedUsed, 2);
		assert.equal(p.wasted, 3);
		assert.equal(p.wastedRunningMs, 4 * MIN + 5 * MIN + MIN);
		assert.equal(p.pending, 1);
	} finally {
		await w.t.dispose();
	}
});

// ------------------------------------------------------------------ code_run backends (R4)
test("code_run backend counts come from the tool-call records; the real tool writes '<backend> <status> <reason>'", async () => {
	const w = await world();
	try {
		const ctx = w.t.app.ctx;
		const space = ctx.services.get("identity").personalSpace(w.owner.me.userId, w.orgId);
		const svc = ctx.services.get("localExec") as LocalExec;
		svc.setCloudRunner(async () => ({ id: "run_fake", status: "ok", exitCode: 0, stdout: "x", stderr: "", durationMs: 3 }));
		// round 12: a conversation prefers the cloud by default (本地环境 is greyed out) -> every call runs in the cloud (reasons pref_cloud / forced_cloud)
		const h = await toolHarness([createLocalExecExtension(ctx, { resolveActor: fixedActor(ctx, w.owner.me.userId, w.orgId, space.id) })], [
			call("code_run", { language: "javascript", code: "return 1" }, "c1"),
			call("code_run", { language: "javascript", code: "return 2", backend: "cloud" }, "c2"),
			answer("done"),
		]);
		await h.run("go");
		await h.close();
		const rows = ctx.db.all<{ result_summary: string }>("SELECT result_summary FROM tool_calls WHERE tool = 'code_run' ORDER BY started_at, rowid");
		assert.deepEqual(rows.map((r) => r.result_summary), ["cloud ok pref_cloud", "cloud ok forced_cloud"]);
		assert.deepEqual(codeRunStats(ctx, w.orgId, "", "9999"), { browser: 0, cloud: 2, upgraded: 0 });

		// records of the other shapes (browser run, upgraded run, an older record without a reason, a failed run) and another organisation / conversation
		const ins = (org: string, c: Conv, summary: string | null, status = "ok", n = 0) =>
			ctx.db.run(
				"INSERT INTO tool_calls (id, tool, org_id, user_id, space_id, conversation_id, task_id, call_id, args_summary, status, result_summary, started_at, started_ms) VALUES (?, 'code_run', ?, 'u', ?, ?, 1, ?, '{}', ?, ?, ?, 0)",
				`tc_seed_${n}_${Math.random().toString(36).slice(2)}`, org, c.spaceId, c.conversationId, `s${n}`, status, summary, new Date().toISOString(),
			);
		ins(w.orgId, w.m, "browser ok ok", "ok", 1);
		ins(w.orgId, w.m, "browser ok ok", "ok", 2);
		ins(w.orgId, w.m, "browser error ok", "ok", 3);
		ins(w.orgId, w.m, "cloud ok browser_failed upgraded", "ok", 4);
		ins(w.orgId, w.b, "cloud error needs_network", "ok", 5);
		ins(w.orgId, w.b, "browser ok", "ok", 6); // older format
		ins(w.orgId, w.b, null, "error", 7); // threw: no backend known
		ins(w.stranger.me.orgId, w.x, "browser ok ok", "ok", 8);
		const s = await w.stats(w.owner.token);
		assert.deepEqual(s.codeRun, { browser: 4, cloud: 4, upgraded: 1 });
		// the member's conversation lives in another space than the tool harness conversation, so its numbers are exactly the four seeded records
		const conv = await w.t.json<SandboxConversationStatsResponse>("GET", `/api/conversations/${w.m.spaceId}/${w.m.conversationId}/sandbox-stats`, { token: w.member.token });
		assert.deepEqual(conv.codeRun, { browser: 3, cloud: 1, upgraded: 1 });
		// outside the range nothing is counted
		const old = await w.stats(w.owner.token, `?from=${iso(Date.now() - 20 * 24 * HOUR)}&to=${iso(Date.now() - 10 * 24 * HOUR)}`);
		assert.deepEqual(old.codeRun, { browser: 0, cloud: 0, upgraded: 0 });
	} finally {
		await w.t.dispose();
	}
});

// ------------------------------------------------------------------ the real lifecycle writes what the aggregation reads
test("FAKE · real RemoteDriver lifecycle (create, idle pause, resume, idle pause) on the app database: the API numbers equal the recorded events", async () => {
	const w = await world();
	const root = mkdtempSync(join(tmpdir(), "wr-r11stats-"));
	try {
		const space = w.t.app.ctx.services.get("identity").personalSpace(w.owner.me.userId, w.orgId);
		const clock = { t: Date.UTC(2026, 10, 11, 8, 0, 0) };
		const provider = new FakeRemoteProvider({ pause: true });
		provider.hooks.create = () => void (clock.t += 1500);
		provider.hooks.resume = () => void (clock.t += 700);
		const driver = new RemoteDriver({ db: w.db, provider, orgId: w.orgId, lifecycle: { createTimeoutSec: 30, idlePauseSec: 300, pausedRetentionSec: 86_400, destroyAfterSec: 604_800 }, now: () => clock.t });
		const wd = join(root, "sandbox", "c7");
		mkdirSync(wd, { recursive: true });
		let n = 0;
		const spec = (): DriverRunSpec => ({ runId: `run_${++n}`, tenant: { orgId: w.orgId, spaceId: space.id, workspaceKey: "c7" }, scratchBase: join(root, "sandbox"), workdir: wd, exec: { language: "python", code: "write a.txt x" }, limits: { ...DEFAULT_LIMITS, timeoutMs: 5000 }, mounts: [], env: {}, network: false, trigger: "exec" });
		const t0 = clock.t;
		await driver.run(spec());
		clock.t += 5 * MIN;
		assert.equal(await driver.reapIdle(), 1);
		clock.t += 20 * MIN;
		await driver.run(spec()); // resumes
		clock.t += 5 * MIN;
		assert.equal(await driver.reapIdle(), 1);

		const ev = sandboxEventsOf(w.db, w.orgId, space.id, 7);
		assert.deepEqual(ev.map((e) => e.kind), ["create", "pause", "resume", "pause"]);
		const runningSum = ev.filter((e) => e.kind === "pause").reduce((a, e) => a + (e.running_ms ?? 0), 0);
		assert.ok(runningSum >= 10 * MIN);
		const s = await w.stats(w.owner.token, `?from=${iso(t0 - HOUR)}&to=${iso(t0 + DAY)}`);
		assert.equal(s.total.creates, 1);
		assert.deepEqual(s.total.createsByTrigger, { exec: 1, prewarm: 0, explicit: 0 });
		assert.deepEqual(s.total.coldStart, { n: 1, p50: 1500, p95: 1500 });
		assert.deepEqual(s.total.resume, { n: 1, p50: 700, p95: 700 });
		assert.equal(s.total.idlePauses, 2);
		assert.equal(s.total.runningMs, runningSum, "the API's running time is the sum of the pause events' running_ms");
		assert.equal(s.total.openRunningMs, 0);
		assert.equal(s.byProvider[0]!.provider, "opensandbox");
		assert.equal(s.conversations[0]!.conversationId, 7);
		// a price turns the same running time into cost
		await w.t.json("PUT", "/api/sandbox/prices", { token: w.owner.token, json: { prices: { opensandbox: 3.6 } } });
		const priced = await w.stats(w.owner.token, `?from=${iso(t0 - HOUR)}&to=${iso(t0 + DAY)}`);
		assert.equal(priced.total.costUsd, Math.round((runningSum / HOUR) * 3.6 * 1e6) / 1e6);
		assert.equal(priced.costComplete, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
		await w.t.dispose();
	}
});
