// Analytics API: aggregates equal the underlying rows exactly (seeded known records vs independent JS computation),
// permission scoping (member / project / department / org / other org), simulated + demo handling, CSV export, granularity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { percentile } from "../src/ops/stats.ts";

const SECRET = "test-secret-key-for-stats-0123456789";
const TZ = 480; // Asia/Shanghai
const FROM = "2026-09-30T16:00:00.000Z"; // local 2026-10-01 00:00
const TO = "2026-10-08T16:00:00.000Z"; // local 2026-10-09 00:00 (exclusive)
const PREV_FROM = "2026-09-22T16:00:00.000Z";
const Q = `from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&tz=${TZ}&granularity=day`;

interface L {
	kind: "task" | "run" | "model_request" | "tool_call" | "adjustment";
	at: string;
	user: string;
	space: string;
	org: string;
	project?: string | null;
	dept?: string;
	conv: number;
	outcome: string;
	model?: string;
	route?: string;
	tool?: string;
	i?: number;
	o?: number;
	cr?: number;
	cw?: number;
	cost?: number;
	fixture?: number;
	dur?: number;
	err?: string;
	demo?: number;
}
let seq = 0;
function insertLedger(t: TestApp, r: L): void {
	const tot = (r.i ?? 0) + (r.o ?? 0) + (r.cr ?? 0) + (r.cw ?? 0);
	t.app.ctx.db.run(
		`INSERT INTO usage_ledger (id, kind, space_id, org_id, project_id, user_id, department_ids, conversation_id, entry_id, sub_key, task_id, outcome, platform_model_id, pi_provider, route, tool_name, input_tokens, output_tokens, cache_read, cache_write, total_tokens, cost, cost_from_provider, fixture, duration_ms, error_class, at, imported_at, demo)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', NULL, ?, ?, 'workroom', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
		`seed:${++seq}`,
		r.kind,
		r.space,
		r.org,
		r.project ?? null,
		r.user,
		r.dept ?? ",",
		r.conv,
		seq,
		r.outcome,
		r.model ?? null,
		r.route ?? null,
		r.tool ?? null,
		r.i ?? 0,
		r.o ?? 0,
		r.cr ?? 0,
		r.cw ?? 0,
		tot,
		r.cost ?? 0,
		r.fixture ?? 0,
		r.dur ?? null,
		r.err ?? null,
		r.at,
		"2026-11-09T00:00:00.000Z",
		r.demo ?? 0,
	);
}
const BILLABLE = ["model_request", "tool_call", "adjustment"];
const ms = (iso: string) => Date.parse(iso);
const local = (iso: string) => new Date(ms(iso) + TZ * 60_000);
const dayOf = (iso: string) => local(iso).toISOString().slice(0, 10);
const inRange = (r: L, from: string, to: string) => r.at >= from && r.at < to;

interface World {
	t: TestApp;
	a: { token: string; me: any };
	m: { token: string; me: any };
	v: { token: string; me: any }; // project viewer
	mgr: { token: string; me: any }; // department manager
	other: { token: string; me: any }; // another org
	aSpace: string;
	mSpace: string;
	pSpace: string;
	projectId: string;
	deptId: string;
	rows: L[];
}

async function world(): Promise<World> {
	const t = await startTestApp({ config: { secretKey: SECRET } });
	const a = await t.user("admin@a.example", { name: "管理员甲" });
	const inv = async () => (await t.json("POST", "/api/admin/invites", { token: a.token, json: {} })).invite.code;
	const m = await t.user("member@a.example", { inviteCode: await inv(), name: "成员乙" });
	const v = await t.user("viewer@a.example", { inviteCode: await inv(), name: "查看者丙" });
	const mgr = await t.user("mgr@a.example", { inviteCode: await inv(), name: "经理丁" });
	const other = await t.user("admin@other.example");
	const aSpace = (await t.json("GET", "/api/me", { token: a.token })).personalSpaceId;
	const mSpace = (await t.json("GET", "/api/me", { token: m.token })).personalSpaceId;
	const { project } = await t.json("POST", "/api/projects", { token: a.token, json: { kind: "space", name: "项目一" } });
	await t.json("PUT", `/api/projects/${project.id}/members`, { token: a.token, json: { email: "member@a.example", role: "editor" } });
	await t.json("PUT", `/api/projects/${project.id}/members`, { token: a.token, json: { email: "viewer@a.example", role: "viewer" } });
	const dep = await t.json("POST", "/api/admin/departments", { token: a.token, json: { name: "研发部" } });
	const deptId = dep.department?.id ?? dep.id;
	await t.json("PUT", `/api/admin/departments/${deptId}/members`, { token: a.token, json: { userId: mgr.me.userId, role: "manager" } });
	await t.json("PUT", `/api/admin/departments/${deptId}/members`, { token: a.token, json: { userId: m.me.userId, role: "member" } });
	const org = a.me.orgId;
	const A = a.me.userId;
	const M = m.me.userId;
	const dM = `,${deptId},`;
	const rows: L[] = [];
	const add = (r: L) => rows.push(r);
	const base = { org, space: aSpace, user: A, project: null as string | null };
	// ---- admin A, personal space, conv 1: Oct 1 local (a run with a tool round + a failed request), real model "claude" via anthropic
	add({ ...base, kind: "task", conv: 1, at: "2026-10-01T01:00:00.000Z", outcome: "success" }); // local Oct 1 09:00 (Thu)
	add({ ...base, kind: "model_request", conv: 1, at: "2026-10-01T01:00:05.000Z", outcome: "success", model: "claude", route: "anthropic/claude-x", i: 100, o: 50, cr: 20, cw: 10, cost: 0.01, dur: 800 });
	add({ ...base, kind: "tool_call", conv: 1, at: "2026-10-01T01:00:06.000Z", outcome: "success", tool: "web_search", dur: 300 });
	add({ ...base, kind: "tool_call", conv: 1, at: "2026-10-01T01:00:07.000Z", outcome: "failed", tool: "web_search", dur: 500 });
	add({ ...base, kind: "model_request", conv: 1, at: "2026-10-01T01:00:09.000Z", outcome: "success", model: "claude", route: "anthropic/claude-x", i: 200, o: 80, cost: 0.02, dur: 1500 });
	add({ ...base, kind: "run", conv: 1, at: "2026-10-01T01:00:05.000Z", outcome: "success", model: "claude", route: "anthropic/claude-x", i: 300, o: 130, cr: 20, cw: 10, cost: 0.03 });
	// conv 2: crosses UTC midnight → local Oct 2 01:30 (Fri) ; failed with an error class on a gpt route
	add({ ...base, kind: "task", conv: 2, at: "2026-10-01T17:30:00.000Z", outcome: "failed" });
	add({ ...base, kind: "model_request", conv: 2, at: "2026-10-01T17:30:02.000Z", outcome: "failed", model: "gpt", route: "openai/gpt-y", i: 40, o: 0, cost: 0.004, dur: 4200, err: "rate_limit" });
	add({ ...base, kind: "run", conv: 2, at: "2026-10-01T17:30:02.000Z", outcome: "failed", model: "gpt", route: "openai/gpt-y", i: 40, cost: 0.004 });
	// conv 3: timeout + cancelled + awaiting approval runs, Oct 3 local
	add({ ...base, kind: "task", conv: 3, at: "2026-10-03T03:00:00.000Z", outcome: "timeout" });
	add({ ...base, kind: "model_request", conv: 3, at: "2026-10-03T03:00:01.000Z", outcome: "timeout", model: "gpt", route: "openai/gpt-y", i: 10, cost: 0.001, dur: 61_000, err: "timeout" });
	add({ ...base, kind: "run", conv: 3, at: "2026-10-03T03:00:01.000Z", outcome: "timeout", model: "gpt", route: "openai/gpt-y", i: 10, cost: 0.001 });
	add({ ...base, kind: "run", conv: 3, at: "2026-10-03T04:00:01.000Z", outcome: "cancelled" });
	add({ ...base, kind: "run", conv: 3, at: "2026-10-03T05:00:01.000Z", outcome: "awaiting_approval" });
	add({ ...base, kind: "run", conv: 3, at: "2026-10-03T06:00:01.000Z", outcome: "in_progress" });
	// adjustment (compaction) attributable to claude
	add({ ...base, kind: "adjustment", conv: 1, at: "2026-10-04T02:00:00.000Z", outcome: "success", model: "claude", i: 500, o: 0, cost: 0.05 });
	// ---- simulated fixture usage in the same personal space (test model): never real tokens/cost
	add({ ...base, kind: "task", conv: 4, at: "2026-10-05T02:00:00.000Z", outcome: "success", fixture: 1 });
	add({ ...base, kind: "model_request", conv: 4, at: "2026-10-05T02:00:01.000Z", outcome: "success", model: "workroom-fixture", route: "fixture/workroom-fixture", i: 1000, o: 500, fixture: 1, dur: 20 });
	add({ ...base, kind: "run", conv: 4, at: "2026-10-05T02:00:01.000Z", outcome: "success", model: "workroom-fixture", route: "fixture/workroom-fixture", i: 1000, o: 500, fixture: 1 });
	// ---- member M in the project space (editor), department member
	const pSpace = (t.app.ctx.db.get<any>("SELECT id FROM id_spaces WHERE project_id = ?", project.id)).id;
	const mp = { org, space: pSpace, user: M, project: project.id as string | null, dept: dM };
	add({ ...mp, kind: "task", conv: 10, at: "2026-10-02T02:00:00.000Z", outcome: "success" });
	add({ ...mp, kind: "model_request", conv: 10, at: "2026-10-02T02:00:01.000Z", outcome: "success", model: "claude", route: "anthropic/claude-x", i: 300, o: 100, cost: 0.02, dur: 600 });
	add({ ...mp, kind: "tool_call", conv: 10, at: "2026-10-02T02:00:02.000Z", outcome: "success", tool: "calc", dur: 20 });
	add({ ...mp, kind: "run", conv: 10, at: "2026-10-02T02:00:01.000Z", outcome: "success", model: "claude", route: "anthropic/claude-x", i: 300, o: 100, cost: 0.02 });
	// member personal
	const mm = { org, space: mSpace, user: M, project: null as string | null, dept: dM };
	add({ ...mm, kind: "task", conv: 11, at: "2026-10-06T10:15:00.000Z", outcome: "success" });
	add({ ...mm, kind: "model_request", conv: 11, at: "2026-10-06T10:15:01.000Z", outcome: "success", model: "claude", route: "anthropic/claude-x", i: 70, o: 30, cost: 0.005, dur: 900 });
	add({ ...mm, kind: "run", conv: 11, at: "2026-10-06T10:15:01.000Z", outcome: "success", model: "claude", route: "anthropic/claude-x", i: 70, o: 30, cost: 0.005 });
	// ---- previous period (Sep 22..30 local): for deltas
	add({ ...base, kind: "task", conv: 20, at: "2026-09-25T01:00:00.000Z", outcome: "success" });
	add({ ...base, kind: "model_request", conv: 20, at: "2026-09-25T01:00:01.000Z", outcome: "success", model: "claude", route: "anthropic/claude-x", i: 60, o: 40, cost: 0.006, dur: 1000 });
	add({ ...base, kind: "run", conv: 20, at: "2026-09-25T01:00:01.000Z", outcome: "success", model: "claude", route: "anthropic/claude-x", i: 60, o: 40, cost: 0.006 });
	// ---- outside everything but inside the 365-day calendar window
	add({ ...base, kind: "run", conv: 21, at: "2026-03-10T01:00:00.000Z", outcome: "success" });
	// ---- demo-marked row in a REAL org must never be counted; other org's rows must never leak
	add({ ...base, kind: "run", conv: 99, at: "2026-10-02T01:00:00.000Z", outcome: "success", demo: 1, i: 999999 });
	add({ ...base, kind: "model_request", conv: 99, at: "2026-10-02T01:00:00.000Z", outcome: "success", demo: 1, model: "claude", i: 999999, cost: 99 });
	for (const r of rows) insertLedger(t, r);
	const oOrg = other.me.orgId;
	const oSpace = (await t.json("GET", "/api/me", { token: other.token })).personalSpaceId;
	for (let i = 0; i < 5; i++) insertLedger(t, { kind: "run", at: "2026-10-02T01:00:00.000Z", user: other.me.userId, space: oSpace, org: oOrg, conv: 500 + i, outcome: "success" });
	// ---- other tables
	const db = t.app.ctx.db;
	for (const [i, at] of ["2026-10-01T01:00:00.000Z", "2026-10-02T02:00:00.000Z", "2026-10-02T03:00:00.000Z", "2026-10-03T03:00:00.000Z", "2026-09-25T01:00:00.000Z"].entries()) {
		db.run(
			"INSERT INTO kb_retrieval_events (id, org_id, user_id, source, space_id, conversation_id, query_hash, query_len, kb_ids, hit_count, reason, latency_ms, at) VALUES (?, ?, ?, 'tool', ?, 1, ?, 3, '[]', ?, ?, ?, ?)",
			`kb${i}`,
			org,
			A,
			aSpace,
			`h${i}`,
			i === 1 ? 0 : i === 2 ? 0 : 2,
			i === 1 ? "no_evidence" : i === 2 ? "forbidden" : null,
			10 + i,
			at,
		);
	}
	db.run("INSERT INTO kb_retrieval_events (id, org_id, user_id, source, space_id, conversation_id, query_hash, query_len, kb_ids, hit_count, latency_ms, at) VALUES ('kbe', ?, ?, 'eval', ?, 1, 'e', 3, '[]', 0, 1, '2026-10-02T01:00:00.000Z')", org, A, aSpace);
	for (const [i, [origin, at, sp, by]] of (
		[
			["agent", "2026-10-01T01:00:03.000Z", aSpace, A],
			["agent", "2026-10-02T02:00:03.000Z", pSpace, M],
			["upload", "2026-10-02T02:00:04.000Z", aSpace, A],
			["automation", "2026-10-04T02:00:04.000Z", aSpace, A],
			["agent", "2026-09-25T01:00:04.000Z", aSpace, A],
		] as const
	).entries()) {
		db.run("INSERT INTO file_files (id, org_id, space_id, project_id, name, origin, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'f', ?, ?, ?, ?)", `ff${i}`, org, sp, sp === pSpace ? project.id : null, origin, by, at, at);
		db.run("INSERT INTO file_versions (id, file_id, version_no, space_id, name, mime, size, sha256, created_by, created_at, origin, provenance) VALUES (?, ?, 1, ?, 'f', 'text/plain', 1, ?, ?, ?, ?, '{}')", `fv${i}`, `ff${i}`, sp, `sha${i}`, by, at, origin);
	}
	db.run("INSERT INTO auto_automations (id, org_id, owner_user_id, space_id, name, prompt, trigger, timezone, condition, destination, created_at, updated_at) VALUES ('au1', ?, ?, ?, 'n', 'p', '{}', 'UTC', '{}', '{}', ?, ?)", org, A, aSpace, FROM, FROM);
	for (const [i, [st, at]] of (
		[
			["succeeded", "2026-10-01T00:00:00.000Z"],
			["succeeded", "2026-10-02T00:00:00.000Z"],
			["failed", "2026-10-03T00:00:00.000Z"],
			["succeeded", "2026-09-25T00:00:00.000Z"],
		] as const
	).entries())
		db.run("INSERT INTO auto_runs (id, automation_id, org_id, scheduled_for, trigger, status, request_id, space_id, created_at) VALUES (?, 'au1', ?, ?, 'cron', ?, ?, ?, ?)", `ar${i}`, org, at, st, `rq${i}`, aSpace, at);
	return { t, a, m, v, mgr, other, aSpace, mSpace, pSpace, projectId: project.id, deptId, rows };
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const kpi = (o: any, key: string) => o.kpis.find((k: any) => k.key === key);

test("overview aggregates equal the underlying rows exactly (org scope, tz +8, daily buckets, previous-period deltas)", async () => {
	const w = await world();
	try {
		const o = await w.t.json("GET", `/api/stats/overview?scope=org&${Q}`, { token: w.a.token });
		const org = w.a.me.orgId;
		const R = w.rows.filter((r) => !r.demo);
		const cur = R.filter((r) => inRange(r, FROM, TO));
		const prev = R.filter((r) => inRange(r, PREV_FROM, FROM));
		const count = (rs: L[], kind: string) => rs.filter((r) => r.kind === kind).length;
		const real = (rs: L[]) => rs.filter((r) => BILLABLE.includes(r.kind) && !r.fixture);
		const tok = (rs: L[], k: "i" | "o") => sum(rs.map((r) => r[k] ?? 0));
		assert.equal(o.range.from, FROM);
		assert.equal(o.previous.from, PREV_FROM);
		assert.equal(o.granularity, "day");
		assert.deepEqual(o.series.buckets, ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);

		assert.equal(kpi(o, "conversations").value, new Set(cur.filter((r) => r.kind === "task").map((r) => `${r.space}:${r.conv}`)).size);
		assert.equal(kpi(o, "runs").value, count(cur, "run"));
		assert.equal(kpi(o, "modelRequests").value, count(cur, "model_request"));
		assert.equal(kpi(o, "toolCalls").value, count(cur, "tool_call"));
		assert.equal(kpi(o, "inputTokens").value, tok(real(cur), "i"));
		assert.equal(kpi(o, "outputTokens").value, tok(real(cur), "o"));
		assert.equal(kpi(o, "cacheTokens").value, sum(real(cur).map((r) => (r.cr ?? 0) + (r.cw ?? 0))));
		assert.ok(Math.abs(kpi(o, "cost").value - sum(real(cur).map((r) => r.cost ?? 0))) < 1e-12);
		// Simulated (fixture) tokens are reported apart and never inside the real totals.
		assert.equal(kpi(o, "inputTokens").simulatedValue, 1000);
		assert.equal(kpi(o, "outputTokens").simulatedValue, 500);
		assert.equal(o.simulation.simulatedRequests, 1);
		assert.equal(o.simulation.realRequests, count(cur, "model_request") - 1);
		assert.equal(o.simulation.onlySimulated, false);
		// Success rate = success / (success + failed + timeout); cancelled / awaiting / in progress are not in the denominator.
		const runs = cur.filter((r) => r.kind === "run");
		const ok = runs.filter((r) => r.outcome === "success").length;
		const den = ok + runs.filter((r) => r.outcome === "failed" || r.outcome === "timeout").length;
		assert.equal(kpi(o, "successRate").value, ok / den);
		// Latency: nearest-rank over REAL model requests only.
		const d = cur.filter((r) => r.kind === "model_request" && !r.fixture && r.dur != null).map((r) => r.dur!).sort((a, b) => a - b);
		assert.equal(kpi(o, "latencyP50").value, percentile(d, 0.5));
		assert.equal(kpi(o, "latencyP95").value, percentile(d, 0.95));
		assert.equal(o.latency.p95, percentile(d, 0.95));
		assert.equal(o.latency.source, "real");
		assert.equal(o.latency.count, d.length);
		for (const b of o.latency.buckets) {
			const lo = o.latency.buckets[o.latency.buckets.indexOf(b) - 1]?.le ?? 0;
			assert.equal(b.count, d.filter((x) => x > lo && (b.le === null || x <= b.le)).length, `latency bucket ${b.le}`);
		}
		// Other tables
		assert.equal(kpi(o, "filesProduced").value, 3); // agent x2 + automation x1 in range; upload excluded, previous-period one excluded
		assert.equal(kpi(o, "knowledgeSearches").value, 4); // 'eval' source and previous period excluded
		assert.equal(kpi(o, "automationRuns").value, 3);
		assert.deepEqual(o.automation.byStatus, { succeeded: 2, failed: 1 });
		assert.deepEqual(o.files.byOrigin, { agent: 2, automation: 1 });
		assert.deepEqual({ s: o.knowledge.searches, h: o.knowledge.withHits, n: o.knowledge.noEvidence, e: o.knowledge.otherEmpty }, { s: 4, h: 2, n: 1, e: 1 });
		assert.equal(o.knowledge.hitRate, 0.5);
		assert.equal(o.knowledge.noEvidenceRate, 0.25);
		assert.deepEqual(o.knowledge.byReason, { no_evidence: 1, forbidden: 1 });

		// Previous period + deltas
		assert.equal(kpi(o, "runs").previous, count(prev, "run"));
		assert.equal(kpi(o, "runs").delta, count(cur, "run") - count(prev, "run"));
		assert.equal(kpi(o, "runs").deltaPct, (count(cur, "run") - count(prev, "run")) / count(prev, "run"));
		assert.equal(kpi(o, "inputTokens").previous, 60);
		assert.equal(kpi(o, "filesProduced").previous, 1);
		assert.equal(kpi(o, "knowledgeSearches").previous, 1);
		// Sparklines: one point per bucket, and sums of additive metrics equal the totals.
		for (const k of ["runs", "modelRequests", "toolCalls", "inputTokens", "outputTokens", "filesProduced", "knowledgeSearches", "automationRuns"]) {
			const kp = kpi(o, k);
			assert.equal(kp.spark.length, o.series.buckets.length);
			assert.equal(sum(kp.spark.map((x: number | null) => x ?? 0)), kp.value, `spark sum ${k}`);
		}
		const runsByDay = (day: string) => cur.filter((r) => r.kind === "run" && dayOf(r.at) === day).length;
		assert.deepEqual(kpi(o, "runs").spark, o.series.buckets.map(runsByDay));
		assert.equal(kpi(o, "runs").spark[1], 2); // local Oct 2: conv 2 (crossed UTC midnight) + conv 10; the demo-marked row is excluded

		// Outcomes (docs/ops.md §3.2): per counting unit, every state separately; totals add up.
		for (const [unit, kind] of [["tasks", "task"], ["runs", "run"], ["modelRequests", "model_request"], ["toolCalls", "tool_call"]] as const) {
			const rs = cur.filter((r) => r.kind === kind);
			const exp: Record<string, number> = { success: 0, failed: 0, cancelled: 0, timeout: 0, awaiting_approval: 0, in_progress: 0 };
			for (const r of rs) exp[r.outcome]!++;
			assert.deepEqual(o.outcomes[unit], { ...exp, total: rs.length }, unit);
		}
		assert.equal(o.outcomes.runs.awaiting_approval, 1);
		assert.equal(o.outcomes.runs.timeout, 1);
		// Tools: calls / errors / avg duration straight from tool_call rows
		const web = cur.filter((r) => r.kind === "tool_call" && r.tool === "web_search");
		const ws = o.tools.find((x: any) => x.tool === "web_search");
		assert.deepEqual({ calls: ws.calls, errors: ws.errors, rate: ws.errorRate, avg: ws.avgDurationMs }, { calls: 2, errors: 1, rate: 0.5, avg: 400 });
		assert.equal(sum(o.tools.map((x: any) => x.calls)), count(cur, "tool_call"));
		assert.equal(o.tools[0].tool, "web_search");
		// Calendar: 365 local days ending with the day of `to`; each day equals the rows of that local day.
		assert.equal(o.calendar.to, "2026-10-08");
		assert.equal(o.calendar.from, "2025-10-09");
		const calDay = (day: string) => o.calendar.days.find((x: any) => x.day === day);
		assert.equal(calDay("2026-10-02").runs, 2);
		assert.equal(calDay("2026-10-02").modelRequests, 2);
		assert.equal(calDay("2026-10-03").failedRuns, 1); // the timeout run
		assert.equal(calDay("2026-03-10").runs, 1);
		assert.equal(sum(o.calendar.days.map((x: any) => x.runs)), R.filter((r) => r.kind === "run" && r.at >= "2025-10-08T16:00:00.000Z" && r.at < TO).length);
		// Punch card: weekday Mon=0..Sun=6 x local hour. 2026-10-01 09:00 local is a Thursday.
		const cell = (wd: number, h: number) => o.punchCard.cells.find((x: any) => x.weekday === wd && x.hour === h);
		assert.equal(cell(3, 9).runs, 1);
		assert.equal(cell(4, 1).modelRequests, 1); // Friday 01:30 (UTC+8 crossing midnight)
		assert.equal(sum(o.punchCard.cells.map((x: any) => x.runs)), count(cur, "run"));
		assert.equal(sum(o.punchCard.cells.map((x: any) => x.toolCalls)), count(cur, "tool_call"));
		// Series by model / provider / route: per-bucket request counts and token totals
		const reqs = cur.filter((r) => r.kind === "model_request");
		for (const [dimName, keyOf] of [["model", (r: L) => r.model!], ["provider", (r: L) => r.route!.split("/")[0]!], ["route", (r: L) => r.route!]] as const) {
			const items = o.series[dimName] as any[];
			assert.equal(sum(items.map((x) => x.totalRequests)), reqs.length, `${dimName} requests`);
			for (const it of items) {
				const mine = reqs.filter((r) => keyOf(r) === it.key);
				assert.equal(it.totalRequests, mine.length, `${dimName}:${it.key}`);
				assert.deepEqual(it.requests, o.series.buckets.map((b: string) => mine.filter((r) => dayOf(r.at) === b).length));
			}
		}
		const claude = o.series.model.find((x: any) => x.key === "claude");
		// claude tokens = its model_request rows + the compaction adjustment attributed to it
		assert.equal(claude.totalTokens, sum(cur.filter((r) => (r.kind === "model_request" || r.kind === "adjustment") && r.model === "claude").map((r) => (r.i ?? 0) + (r.o ?? 0) + (r.cr ?? 0) + (r.cw ?? 0))));
		const fx = o.series.model.find((x: any) => x.key === "workroom-fixture");
		assert.equal(fx.simulated, true);
		assert.equal(fx.totalSimulatedTokens, 1500);
		assert.equal(claude.simulated, false);
		assert.equal(o.series.provider.find((x: any) => x.key === "fixture").simulated, true);
		assert.equal(claude.failedRequests, 0);
		assert.equal(o.series.model.find((x: any) => x.key === "gpt").failedRequests, 2);
		// Top users (org scope): runs per user straight from rows; names resolved; the other org never appears
		const byUser = (u: string) => cur.filter((r) => r.kind === "run" && r.user === u).length;
		const tuA = o.topUsers.find((x: any) => x.id === w.a.me.userId);
		assert.equal(tuA.runs, byUser(w.a.me.userId));
		assert.equal(tuA.name, "管理员甲");
		assert.equal(tuA.failedRuns, 2);
		assert.equal(tuA.simulatedTokens, 1500);
		assert.equal(o.topUsers.find((x: any) => x.id === w.m.me.userId).runs, byUser(w.m.me.userId));
		assert.ok(!o.topUsers.some((x: any) => x.id === w.other.me.userId));
		const tp = o.topProjects.find((x: any) => x.id === w.projectId);
		assert.deepEqual({ name: tp.name, runs: tp.runs, tokens: tp.tokens }, { name: "项目一", runs: 1, tokens: 400 });
		// Drilldown: admin has no read access to a member's personal conversation (titles are not disclosed, no link)
		const memberConv = o.conversations.find((x: any) => x.spaceId === w.mSpace);
		assert.equal(memberConv.title, null);
		assert.equal(memberConv.link, null);
		assert.ok(o.conversations.every((x: any) => x.spaceId !== "other"));
		assert.equal(o.demo, false);
		assert.equal(org, o.scope === "org" ? org : "");
	} finally {
		await w.t.dispose();
	}
});

test("calendar / punch-card token totals count each billed row once (run rows are display sums, not extra spend)", async () => {
	const w = await world();
	try {
		const o = await w.t.json("GET", `/api/stats/overview?scope=org&${Q}`, { token: w.a.token });
		const cur = w.rows.filter((r) => !r.demo && inRange(r, FROM, TO) && BILLABLE.includes(r.kind));
		const tokens = sum(cur.map((r) => (r.i ?? 0) + (r.o ?? 0) + (r.cr ?? 0) + (r.cw ?? 0)));
		assert.equal(sum(o.punchCard.cells.map((c: any) => c.tokens)), tokens);
		assert.equal(sum(o.calendar.days.filter((d: any) => d.day >= "2026-10-01").map((d: any) => d.tokens)), tokens);
		// real + simulated token KPIs add up to the same billed tokens
		const k = (key: string) => o.kpis.find((x: any) => x.key === key);
		assert.equal(k("inputTokens").value + k("outputTokens").value + k("cacheTokens").value + k("inputTokens").simulatedValue + k("outputTokens").simulatedValue, tokens);
	} finally {
		await w.t.dispose();
	}
});

test("permission scoping: member / project / department / org / other org", async () => {
	const w = await world();
	try {
		const get = (path: string, token: string, expect = 200) => w.t.json("GET", `/api/stats/${path}`, { token, expect });
		// A plain member: personal only. Their personal numbers are their own rows (their project-space work is "personal" usage too: user-based, as in /usage).
		const mine = await get(`overview?scope=personal&${Q}`, w.m.token);
		const mRuns = w.rows.filter((r) => !r.demo && r.user === w.m.me.userId && r.kind === "run" && inRange(r, FROM, TO)).length;
		assert.equal(mine.kpis.find((k: any) => k.key === "runs").value, mRuns);
		assert.deepEqual(mine.topUsers, [], "personal scope never lists other users");
		assert.equal(mine.scope, "personal");
		await get(`overview?scope=org&${Q}`, w.m.token, 403);
		await get(`overview?scope=project:${w.projectId}&${Q}`, w.m.token, 403); // editor is not owner/admin
		await get(`overview?scope=project:${w.projectId}&${Q}`, w.v.token, 403); // viewer neither
		await get(`overview?scope=department:${w.deptId}&${Q}`, w.m.token, 403); // plain department member
		await get(`export.csv?chart=kpis&scope=org&${Q}`, w.m.token, 403);
		await get(`export.csv?chart=kpis&scope=project:${w.projectId}&${Q}`, w.m.token, 403);
		// The scope list offers each viewer exactly what they may open
		assert.deepEqual((await get("scopes", w.m.token)).scopes.map((s: any) => s.key), ["personal"]);
		const aScopes = (await get("scopes", w.a.token)).scopes.map((s: any) => s.key);
		assert.deepEqual(aScopes.sort(), ["org", "personal", `department:${w.deptId}`, `project:${w.projectId}`].sort());
		// Department manager: their department only (members' ledger rows carry the department id), nothing org-wide
		assert.deepEqual((await get("scopes", w.mgr.token)).scopes.map((s: any) => s.key).sort(), ["personal", `department:${w.deptId}`].sort());
		const dep = await get(`overview?scope=department:${w.deptId}&${Q}`, w.mgr.token);
		const dRuns = w.rows.filter((r) => !r.demo && r.dept === `,${w.deptId},` && r.kind === "run" && inRange(r, FROM, TO)).length;
		assert.equal(dep.kpis.find((k: any) => k.key === "runs").value, dRuns);
		assert.ok(dRuns > 0 && dRuns < w.rows.filter((r) => r.kind === "run").length);
		await get(`overview?scope=org&${Q}`, w.mgr.token, 403);
		// authz: department heads view their department by default, but exporting needs the explicit stats.export permission
		await get(`export.csv?chart=kpis&scope=department:${w.deptId}&${Q}`, w.mgr.token, 403);
		await w.t.json("PUT", `/api/admin/members/${w.mgr.me.userId}/grants`, { token: w.a.token, json: { permission: "stats.export", effect: "allow" } });
		assert.ok((await w.t.req("GET", `/api/stats/export.csv?chart=kpis&scope=department:${w.deptId}&${Q}`, { token: w.mgr.token })).ok);
		await get(`export.csv?chart=kpis&scope=org&${Q}`, w.mgr.token, 403); // still no org view
		// Project owner (admin A, owner of the project): project scope = rows of that project only
		const proj = await get(`overview?scope=project:${w.projectId}&${Q}`, w.a.token);
		assert.equal(proj.kpis.find((k: any) => k.key === "runs").value, 1);
		assert.equal(proj.kpis.find((k: any) => k.key === "toolCalls").value, 1);
		assert.deepEqual(proj.topProjects, []);
		assert.deepEqual(proj.topUsers.map((u: any) => u.id), [w.m.me.userId]);
		// Files / knowledge in project scope come from the project's space only
		assert.equal(proj.kpis.find((k: any) => k.key === "filesProduced").value, 1);
		assert.equal(proj.kpis.find((k: any) => k.key === "knowledgeSearches").value, 0);
		// A project from another org does not exist for us; a stranger's org sees none of this data
		await get(`overview?scope=project:${w.projectId}&${Q}`, w.other.token, 403);
		const foreign = await get(`overview?scope=org&${Q}`, w.other.token);
		assert.equal(foreign.kpis.find((k: any) => k.key === "runs").value, 5);
		assert.equal(foreign.kpis.find((k: any) => k.key === "modelRequests").value, 0);
		assert.deepEqual(foreign.topUsers.map((u: any) => u.id), [w.other.me.userId]);
		await get(`overview?scope=bogus&${Q}`, w.a.token, 400);
		await get(`overview?scope=org&from=${encodeURIComponent(TO)}&to=${encodeURIComponent(FROM)}`, w.a.token, 400);
		await w.t.req("GET", `/api/stats/overview?scope=org&${Q}`).then((r) => assert.equal(r.status, 401));
	} finally {
		await w.t.dispose();
	}
});

test("RBAC authz is authoritative: grants widen, role assignments apply, denies beat allows, export needs stats.export", async () => {
	const w = await world();
	try {
		assert.ok(w.t.app.ctx.services.has("authz"), "authz service present");
		const grant = (uid: string, permission: string, effect: "allow" | "deny", scope?: any) => w.t.json("PUT", `/api/admin/members/${uid}/grants`, { token: w.a.token, json: { permission, effect, scope } });
		const M = w.m.me.userId;
		await w.t.json("GET", `/api/stats/overview?scope=project:${w.projectId}&${Q}`, { token: w.m.token, expect: 403 });
		await grant(M, "stats.project.view", "allow", { kind: "project", id: w.projectId });
		const ok = await w.t.json("GET", `/api/stats/overview?scope=project:${w.projectId}&${Q}`, { token: w.m.token });
		assert.equal(ok.kpis.find((k: any) => k.key === "runs").value, 1);
		assert.ok((await w.t.json("GET", "/api/stats/scopes", { token: w.m.token })).scopes.some((s: any) => s.key === `project:${w.projectId}`));
		await w.t.json("GET", `/api/stats/overview?scope=org&${Q}`, { token: w.m.token, expect: 403 });
		// viewing is not exporting
		assert.equal((await w.t.req("GET", `/api/stats/export.csv?chart=tools&scope=project:${w.projectId}&${Q}`, { token: w.m.token })).status, 403);
		await grant(M, "stats.export", "allow");
		assert.equal((await w.t.req("GET", `/api/stats/export.csv?chart=tools&scope=project:${w.projectId}&${Q}`, { token: w.m.token })).status, 200);
		// a role assignment (built-in auditor, org scope) opens the org view
		await w.t.json("POST", "/api/admin/role-assignments", { token: w.a.token, json: { subject: { kind: "user", id: w.v.me.userId }, roleId: "builtin:auditor", scope: { kind: "org" } } });
		assert.equal((await w.t.req("GET", `/api/stats/overview?scope=org&${Q}`, { token: w.v.token })).status, 200);
		// a second (non-owner) org admin has everything, until a direct deny on stats.org.view (deny beats allow)
		const code = (await w.t.json("POST", "/api/admin/invites", { token: w.a.token, json: { role: "admin" } })).invite.code;
		const admin2 = await w.t.user("admin2@a.example", { inviteCode: code });
		assert.equal((await w.t.req("GET", `/api/stats/overview?scope=org&${Q}`, { token: admin2.token })).status, 200);
		await grant(admin2.me.userId, "stats.org.view", "deny");
		assert.equal((await w.t.req("GET", `/api/stats/overview?scope=org&${Q}`, { token: admin2.token })).status, 403);
		assert.ok(!(await w.t.json("GET", "/api/stats/scopes", { token: admin2.token })).scopes.some((s: any) => s.key === "org"));
		// the org owner can never be locked out of their own statistics
		assert.equal((await w.t.req("GET", `/api/stats/overview?scope=org&${Q}`, { token: w.a.token })).status, 200);
		// personal stats stay available to everyone with stats.personal.view (every built-in base role)
		assert.equal((await w.t.req("GET", `/api/stats/overview?scope=personal&${Q}`, { token: admin2.token })).status, 200);
	} finally {
		await w.t.dispose();
	}
});

test("simulated (test-model) usage is flagged, never counted as real tokens/cost; demo rows never leak into real orgs; demo orgs are flagged", async () => {
	const t = await startTestApp({ config: { secretKey: SECRET } });
	try {
		const a = await t.user("admin@a.example");
		const org = a.me.orgId;
		const space = (await t.json("GET", "/api/me", { token: a.token })).personalSpaceId;
		const base = { org, space, user: a.me.userId, conv: 1 };
		insertLedger(t, { ...base, kind: "task", at: "2026-10-02T01:00:00.000Z", outcome: "success", fixture: 1 });
		insertLedger(t, { ...base, kind: "model_request", at: "2026-10-02T01:00:01.000Z", outcome: "success", model: "workroom-fixture", route: "fixture/workroom-fixture", i: 321, o: 123, fixture: 1, dur: 15 });
		insertLedger(t, { ...base, kind: "run", at: "2026-10-02T01:00:01.000Z", outcome: "success", model: "workroom-fixture", fixture: 1 });
		const q = `from=${encodeURIComponent("2026-10-01T00:00:00.000Z")}&to=${encodeURIComponent("2026-10-08T00:00:00.000Z")}&granularity=day`;
		const o = await t.json("GET", `/api/stats/overview?scope=personal&${q}`, { token: a.token });
		const k = (key: string) => o.kpis.find((x: any) => x.key === key);
		assert.equal(o.simulation.onlySimulated, true);
		assert.equal(k("inputTokens").value, 0);
		assert.equal(k("inputTokens").simulatedValue, 321);
		assert.equal(k("outputTokens").simulatedValue, 123);
		assert.equal(k("cost").value, 0);
		assert.equal(k("latencyP50").value, null, "simulated latency is not reported as a real latency");
		assert.equal(k("latencyP50").simulatedValue, 15);
		assert.equal(o.latency.source, "simulated");
		assert.ok(o.notes.some((n: string) => n.includes("模拟")));
		assert.equal(o.series.model[0].simulated, true);
		assert.equal(o.demo, false);
		// a demo-marked row in this real org stays invisible
		insertLedger(t, { ...base, conv: 2, kind: "run", at: "2026-10-02T02:00:00.000Z", outcome: "success", demo: 1 });
		assert.equal((await t.json("GET", `/api/stats/overview?scope=personal&${q}`, { token: a.token })).kpis.find((x: any) => x.key === "runs").value, 1);
		// Flag the org as demo: the same rows now show up (they are demo data), the response says so, and the scope list says so.
		t.app.ctx.db.run("INSERT INTO ops_demo_orgs (org_id, label, created_at) VALUES (?, '演示', ?)", org, "2026-11-09T00:00:00.000Z");
		const d = await t.json("GET", `/api/stats/overview?scope=personal&${q}`, { token: a.token });
		assert.equal(d.demo, true);
		assert.equal(d.kpis.find((x: any) => x.key === "runs").value, 2);
		assert.equal((await t.json("GET", "/api/stats/scopes", { token: a.token })).demo, true);
		// Demo-marked rows have no drilldown link (no such conversation exists) and survive a projection rebuild.
		assert.ok(d.conversations.every((c: any) => c.link === null));
		const usage = t.app.ctx.services.get("usage") as any;
		await usage.rebuildSpace(space).catch(() => undefined);
		assert.equal(t.app.ctx.db.get<any>("SELECT COUNT(*) AS n FROM usage_ledger WHERE demo = 1 AND space_id = ?", space).n, 1);
	} finally {
		await t.dispose();
	}
});

test("CSV export per chart: same numbers as the overview, BOM + header, audited, permission-controlled", async () => {
	const w = await world();
	try {
		const o = await w.t.json("GET", `/api/stats/overview?scope=org&${Q}`, { token: w.a.token });
		const csv = async (chart: string, extra = "") => {
			const res = await w.t.req("GET", `/api/stats/export.csv?scope=org&chart=${chart}&${Q}${extra}`, { token: w.a.token });
			assert.equal(res.status, 200, chart);
			assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
			assert.match(res.headers.get("content-disposition") ?? "", new RegExp(`stats-${chart}-org\\.csv`));
			const bytes = new Uint8Array(await res.arrayBuffer());
			assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM for spreadsheet apps");
			return new TextDecoder("utf-8", { ignoreBOM: false }).decode(bytes).trim().split("\r\n").map((l) => l.split(","));
		};
		const tools = await csv("tools");
		assert.deepEqual(tools[0], ["tool", "calls", "errors", "errorRate", "avgDurationMs"]);
		assert.equal(tools.length - 1, o.tools.length);
		assert.deepEqual(tools[1], ["web_search", "2", "1", "0.5", "400"]);
		const cal = await csv("calendar");
		assert.equal(cal.length - 1, o.calendar.days.length);
		assert.equal(sum(cal.slice(1).map((r) => Number(r[1]))), sum(o.calendar.days.map((d: any) => d.runs)));
		const pc = await csv("punchcard");
		assert.equal(pc.length - 1, o.punchCard.cells.length);
		assert.equal(pc.find((r) => r[0] === "周四" && r[1] === "9")?.[2], "1");
		const sm = await csv("series-model", "&metric=tokens");
		assert.deepEqual(sm[0], ["bucket", "key", "label", "source", "tokens", "simulatedTokens"]);
		assert.equal(sm.length - 1, o.series.model.length * o.series.buckets.length);
		assert.ok(sm.some((r) => r[1] === "workroom-fixture" && r[3] === "模拟"));
		const out = await csv("outcomes");
		assert.equal(out.length, 5);
		assert.equal((await csv("kpis")).length - 1, o.kpis.length);
		for (const c of ["series-provider", "series-route", "latency", "top-users", "top-projects", "conversations", "knowledge"]) assert.ok((await csv(c)).length >= 1, c);
		await w.t.req("GET", `/api/stats/export.csv?scope=org&chart=nope&${Q}`, { token: w.a.token }).then((r) => assert.equal(r.status, 400));
		const audits = w.t.app.ctx.db.all<any>("SELECT * FROM id_audit WHERE action = 'stats.export'");
		assert.ok(audits.length >= 10);
		assert.ok(audits.every((x) => x.actor_user_id === w.a.me.userId && x.target === "org"));
		// A member exports their own personal data only
		assert.equal((await w.t.req("GET", `/api/stats/export.csv?scope=personal&chart=tools&${Q}`, { token: w.m.token })).status, 200);
		assert.equal((await w.t.req("GET", `/api/stats/export.csv?scope=org&chart=tools&${Q}`, { token: w.m.token })).status, 403);
	} finally {
		await w.t.dispose();
	}
});

test("granularity: hour / day / week buckets are local, zero-filled and clamped when they would explode", async () => {
	const w = await world();
	try {
		const hour = await w.t.json("GET", `/api/stats/overview?scope=org&from=${encodeURIComponent("2026-09-30T16:00:00.000Z")}&to=${encodeURIComponent("2026-10-02T16:00:00.000Z")}&tz=${TZ}&granularity=hour`, { token: w.a.token });
		assert.equal(hour.granularity, "hour");
		assert.equal(hour.series.buckets.length, 48);
		assert.equal(hour.series.buckets[0], "2026-10-01 00:00");
		const iHour = hour.series.buckets.indexOf("2026-10-01 09:00");
		assert.equal(hour.kpis.find((k: any) => k.key === "runs").spark[iHour], 1);
		assert.equal(sum(hour.kpis.find((k: any) => k.key === "runs").spark), hour.kpis.find((k: any) => k.key === "runs").value);
		const week = await w.t.json("GET", `/api/stats/overview?scope=org&${Q.replace("granularity=day", "granularity=week")}`, { token: w.a.token });
		assert.deepEqual(week.series.buckets, ["2026-09-28", "2026-10-05"]); // Mondays
		const wRuns = week.kpis.find((k: any) => k.key === "runs").spark;
		const R = w.rows.filter((r) => !r.demo && r.kind === "run" && inRange(r, FROM, TO));
		assert.deepEqual(wRuns, [R.filter((r) => dayOf(r.at) < "2026-10-05").length, R.filter((r) => dayOf(r.at) >= "2026-10-05").length]);
		const clamped = await w.t.json("GET", `/api/stats/overview?scope=org&from=${encodeURIComponent("2026-07-01T00:00:00.000Z")}&to=${encodeURIComponent("2026-10-08T00:00:00.000Z")}&granularity=hour`, { token: w.a.token });
		assert.equal(clamped.requestedGranularity, "hour");
		assert.equal(clamped.granularity, "day");
		// Empty range: honest empty state note, null (not 0) for rates and latency
		const empty = await w.t.json("GET", `/api/stats/overview?scope=org&from=${encodeURIComponent("2020-01-01T00:00:00.000Z")}&to=${encodeURIComponent("2020-01-08T00:00:00.000Z")}`, { token: w.a.token });
		assert.equal(empty.kpis.find((k: any) => k.key === "runs").value, 0);
		assert.equal(empty.kpis.find((k: any) => k.key === "successRate").value, null);
		assert.equal(empty.kpis.find((k: any) => k.key === "latencyP95").value, null);
		assert.ok(empty.notes[0].includes("此范围内没有记录"));
		assert.equal(empty.latency.source, "none");
	} finally {
		await w.t.dispose();
	}
});
