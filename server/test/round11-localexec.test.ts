// Round 11 (R4): local (in-browser) execution unified with the cloud sandbox.
// Routing rules, the broker (claim race, wrong user, unclaimed/timeout → cloud, tab lost, abort), output files landing in the host workspace
// with quota checks, the code_run tool through the real tool machinery, the HTTP API, the SSE presence hook, and the real cloud wrapper
// (namespaces driver of this machine) so a snippet means the same thing in both places.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { orgMember } from "./fixtures/util.ts";
import { answer, call, fixedActor, toolHarness } from "./fixtures/tool-harness.ts";
import { decideBackend, scanCode, type RouteInput } from "../src/tools/localexec/route.ts";
import { LocalExecBroker, type TabConnection } from "../src/tools/localexec/broker.ts";
import { LocalExec, jsWrapper, type CloudRunInput } from "../src/tools/localexec/service.ts";
import { createLocalExecExtension } from "../src/tools/localexec/extension.ts";
import { Sandbox } from "../src/tools/sandbox.ts";
import type { LocalJobClaimResponse } from "../../shared/localexec.ts";

const base: RouteInput = { enabled: true, preference: "local", language: "javascript", code: "return 1+1", inputBytes: 0, timeoutSec: 10, tabConnected: true, browserLanguages: ["javascript"] };

// ------------------------------------------------------------------ routing (pure)
test("routing: browser only when every condition holds, otherwise cloud with the first reason", () => {
	assert.deepEqual(decideBackend(base).backend, "browser");
	const cloud = (patch: Partial<RouteInput>, reason: string) => {
		const d = decideBackend({ ...base, ...patch });
		assert.equal(d.backend, "cloud", JSON.stringify(patch));
		assert.equal(d.reason, reason, JSON.stringify(patch));
		assert.ok(d.why.length > 0);
	};
	cloud({ enabled: false }, "disabled");
	cloud({ preference: "cloud" }, "pref_cloud");
	cloud({ forceCloud: true }, "forced_cloud");
	cloud({ language: "python" }, "language");
	cloud({ inputBytes: 20 * 1024 * 1024 + 1 }, "inputs_too_large");
	cloud({ timeoutSec: 31 }, "timeout_too_long");
	cloud({ tabConnected: false }, "no_tab");
	// boundaries stay in the browser
	assert.equal(decideBackend({ ...base, inputBytes: 20 * 1024 * 1024, timeoutSec: 30 }).backend, "browser");
	// python only when the build says the browser can run it
	assert.equal(decideBackend({ ...base, language: "python", code: "print(1)", browserLanguages: ["javascript", "python"] }).backend, "browser");
	// priority: forced cloud wins over everything, disabled over the rest
	assert.equal(decideBackend({ ...base, forceCloud: true, enabled: false }).reason, "forced_cloud");
	assert.equal(decideBackend({ ...base, enabled: false, preference: "cloud" }).reason, "disabled");
});

test("routing: static scan sends network / subprocess / package-install / Node-only code to the cloud", () => {
	const js: [string, string][] = [
		["const r = await fetch('https://x.test')", "needs_network"],
		["new XMLHttpRequest()", "needs_network"],
		["new WebSocket('wss://x')", "needs_network"],
		["const m = await import('node:http')", "needs_network"],
		["importScripts('a.js')", "needs_network"],
		["const cp = require('child_process')", "needs_process"],
		["execSync('ls')", "needs_process"],
		["// npm install left-pad", "needs_install"],
		["const fs = require('fs')", "needs_node"],
		["console.log(process.env.HOME)", "needs_node"],
		["Buffer.from('a')", "needs_node"],
	];
	for (const [code, reason] of js) assert.equal(scanCode("javascript", code)?.reason, reason, code);
	const py: [string, string][] = [
		["import requests\nrequests.get('x')", "needs_network"],
		["from urllib.request import urlopen", "needs_network"],
		["import socket", "needs_network"],
		["import subprocess", "needs_process"],
		["import os\nos.system('ls')", "needs_process"],
		["os.popen('ls')", "needs_process"],
		["# pip install numpy", "needs_install"],
		["!pip install pandas", "needs_install"],
		["import micropip", "needs_install"],
	];
	for (const [code, reason] of py) assert.equal(scanCode("python", code)?.reason, reason, code);
	// pure computation passes
	assert.equal(scanCode("javascript", "const xs = [1,2,3].map((x) => x * 2); return xs.reduce((a, b) => a + b, 0);"), undefined);
	assert.equal(scanCode("javascript", "const t = await files.read('in.csv'); await files.write('out.txt', t.toUpperCase());"), undefined);
	assert.equal(scanCode("python", "import json, math\nprint(math.sqrt(2))"), undefined);
});

// ------------------------------------------------------------------ broker
const where = { spaceId: "sp1", conversationId: 7 };
function fakeTab(b: LocalExecBroker, tabId: string, userId = "u1", w = where) {
	const events: { event: string; data: any }[] = [];
	const conn: TabConnection = { ...w, userId, tabId, send: (event, data) => void events.push({ event, data }) };
	const detach = b.attach(conn);
	return { events, detach, conn };
}
const spec = (over: Partial<Parameters<LocalExecBroker["dispatch"]>[0]> = {}) => ({ ...where, userId: "u1", language: "javascript" as const, code: "return 1", timeoutSec: 5, inputs: [], writeFile: (p: string) => p, ...over });

test("broker: announce → first claim wins, the other tab is told it was taken, a second claim is 409", async () => {
	const b = new LocalExecBroker({ claimWaitMs: 2000 });
	const t1 = fakeTab(b, "tab-aaaaaaaa");
	const t2 = fakeTab(b, "tab-bbbbbbbb");
	const other = fakeTab(b, "tab-cccccccc", "u2"); // another user's tab is never told
	const { jobId, outcome } = b.dispatch(spec({ inputs: [{ path: "in.txt", bytes: new TextEncoder().encode("hi") }] }));
	assert.equal(t1.events[0]!.event, "localjob");
	assert.equal(t1.events[0]!.data.jobId, jobId);
	assert.equal(t2.events[0]!.event, "localjob");
	assert.equal(other.events.length, 0, "a tab of another user gets nothing");
	const c = b.claim(jobId, "u1", "tab-aaaaaaaa", where);
	assert.equal(c.code, "return 1");
	assert.deepEqual(c.inputs, [{ path: "in.txt", size: 2 }]);
	assert.throws(() => b.claim(jobId, "u1", "tab-bbbbbbbb", where), (e: any) => e.status === 409 && e.code === "job_taken");
	assert.deepEqual(t2.events.at(-1), { event: "localjob-cancel", data: { jobId, reason: "taken" } });
	assert.equal(t1.events.some((e) => e.event === "localjob-cancel"), false, "the winner is not cancelled");
	assert.deepEqual([...b.input(jobId, "u1", "tab-aaaaaaaa", where, "in.txt")], [...new TextEncoder().encode("hi")]);
	b.complete(jobId, "u1", where, { tabId: "tab-aaaaaaaa", ok: true, stdout: "x", returnValue: "2" });
	const o = await outcome;
	assert.equal(o.kind, "done");
	assert.equal(b.pending(), 0);
});

test("broker: claim race with many tabs — exactly one winner", async () => {
	const b = new LocalExecBroker({ claimWaitMs: 2000 });
	const ids = Array.from({ length: 6 }, (_, i) => `tab-race-${i}-xxxx`);
	for (const id of ids) fakeTab(b, id);
	const { jobId } = b.dispatch(spec());
	const results = await Promise.all(ids.map(async (id) => { try { return b.claim(jobId, "u1", id, where) && "won"; } catch (e: any) { return e.code as string; } }));
	assert.equal(results.filter((r) => r === "won").length, 1, JSON.stringify(results));
	assert.equal(results.filter((r) => r === "job_taken").length, 5);
});

test("broker: wrong user, wrong conversation, unknown job and a tab that is not connected cannot claim or read; only the claimant reads inputs / reports", async () => {
	const b = new LocalExecBroker({ claimWaitMs: 2000 });
	fakeTab(b, "tab-aaaaaaaa");
	fakeTab(b, "tab-uuuuuuuu", "u2"); // u2 is connected, but it is not the run's user
	const { jobId } = b.dispatch(spec({ inputs: [{ path: "in.txt", bytes: new Uint8Array([1]) }] }));
	assert.throws(() => b.claim(jobId, "u2", "tab-uuuuuuuu", where), (e: any) => e.status === 404, "another user: same answer as 'no such job'");
	assert.throws(() => b.claim(jobId, "u1", "tab-aaaaaaaa", { spaceId: "sp1", conversationId: 8 }), (e: any) => e.status === 404, "another conversation");
	assert.throws(() => b.claim("lj_nope", "u1", "tab-aaaaaaaa", where), (e: any) => e.status === 404);
	assert.throws(() => b.claim(jobId, "u1", "tab-notconnected", where), (e: any) => e.status === 409 && e.code === "tab_not_connected");
	assert.throws(() => b.input(jobId, "u1", "tab-aaaaaaaa", where, "in.txt"), (e: any) => e.status === 403, "inputs only after claiming");
	b.claim(jobId, "u1", "tab-aaaaaaaa", where);
	fakeTab(b, "tab-bbbbbbbb");
	assert.throws(() => b.input(jobId, "u1", "tab-bbbbbbbb", where, "in.txt"), (e: any) => e.status === 403);
	assert.throws(() => b.input(jobId, "u1", "tab-aaaaaaaa", where, "secret.txt"), (e: any) => e.status === 404, "a job exposes only its declared inputs");
	assert.throws(() => b.complete(jobId, "u1", where, { tabId: "tab-bbbbbbbb", ok: true }), (e: any) => e.status === 403);
	assert.throws(() => b.complete(jobId, "u2", where, { tabId: "tab-aaaaaaaa", ok: true }), (e: any) => e.status === 404);
});

test("broker: nobody claims within the wait → unclaimed (the caller goes to the cloud); the tab is told to drop the job", async () => {
	const b = new LocalExecBroker({ claimWaitMs: 60 });
	const t = fakeTab(b, "tab-aaaaaaaa");
	const o = await b.dispatch(spec()).outcome;
	assert.deepEqual([o.kind, (o as any).fail], ["failed", "unclaimed"]);
	assert.equal(t.events.at(-1)!.event, "localjob-cancel");
	assert.equal(b.pending(), 0);
});

test("broker: claimed but never answered → timeout after timeoutSec + grace; a tab that disconnects for good → tab_lost; a quick reconnect keeps the job", async () => {
	const b = new LocalExecBroker({ claimWaitMs: 1000, resultGraceMs: 50, tabGraceMs: 80 });
	const t = fakeTab(b, "tab-aaaaaaaa");
	let j = b.dispatch(spec({ timeoutSec: 0.05 }));
	b.claim(j.jobId, "u1", "tab-aaaaaaaa", where);
	let o = await j.outcome;
	assert.deepEqual([o.kind, (o as any).fail], ["failed", "timeout"]);
	assert.deepEqual(t.events.at(-1), { event: "localjob-cancel", data: { jobId: j.jobId, reason: "timeout" } });

	j = b.dispatch(spec({ timeoutSec: 5 }));
	b.claim(j.jobId, "u1", "tab-aaaaaaaa", where);
	t.detach();
	const t2 = fakeTab(b, "tab-aaaaaaaa"); // SSE reconnect of the same tab inside the grace
	await new Promise((r) => setTimeout(r, 160));
	assert.equal(b.pending(), 1, "reconnected tab keeps its job");
	t2.detach();
	o = await j.outcome;
	assert.deepEqual([o.kind, (o as any).fail], ["failed", "tab_lost"]);
});

test("broker: abort cancels a pending and a claimed job (stop button); an already aborted signal never reaches a tab", async () => {
	const b = new LocalExecBroker({ claimWaitMs: 2000 });
	const t = fakeTab(b, "tab-aaaaaaaa");
	const ac = new AbortController();
	const j = b.dispatch(spec({ signal: ac.signal }));
	ac.abort();
	assert.equal((await j.outcome).kind, "aborted");
	assert.deepEqual(t.events.at(-1), { event: "localjob-cancel", data: { jobId: j.jobId, reason: "aborted" } });
	const ac2 = new AbortController();
	const j2 = b.dispatch(spec({ signal: ac2.signal }));
	b.claim(j2.jobId, "u1", "tab-aaaaaaaa", where);
	ac2.abort();
	assert.equal((await j2.outcome).kind, "aborted");
	const pre = AbortSignal.abort();
	const before = t.events.length;
	assert.equal((await b.dispatch(spec({ signal: pre })).outcome).kind, "aborted");
	assert.equal(t.events.length, before, "nothing announced for an aborted call");
	assert.equal(b.pending(), 0);
});

test("broker: a tab connecting later still sees a pending job; presence follows connections", async () => {
	const b = new LocalExecBroker({ claimWaitMs: 2000 });
	assert.equal(b.connected("sp1", 7, "u1"), false);
	const j = b.dispatch(spec());
	const t = fakeTab(b, "tab-aaaaaaaa");
	assert.equal(t.events[0]!.event, "localjob");
	assert.equal(b.connected("sp1", 7, "u1"), true);
	assert.equal(b.connected("sp1", 7, "u2"), false);
	assert.equal(b.connected("sp1", 8, "u1"), false);
	b.shutdown();
	assert.equal((await j.outcome).kind, "aborted");
});

test("broker: output files go through the dispatcher's writeFile; refusals are reported per file; failed runs keep nothing; limits enforced", async () => {
	const b = new LocalExecBroker({ claimWaitMs: 2000 });
	fakeTab(b, "tab-aaaaaaaa");
	const stored: string[] = [];
	const writeFile = (p: string) => {
		if (p.startsWith("bad")) throw new Error("路径不合法");
		stored.push(p);
		return p;
	};
	const b64 = (s: string) => Buffer.from(s).toString("base64");
	let j = b.dispatch(spec({ writeFile }));
	b.claim(j.jobId, "u1", "tab-aaaaaaaa", where);
	const r = b.complete(j.jobId, "u1", where, { tabId: "tab-aaaaaaaa", ok: true, files: [{ path: "out/a.txt", base64: b64("A") }, { path: "bad/../x", base64: b64("B") }] });
	assert.deepEqual(r, { written: 1, rejected: 1 });
	let o: any = await j.outcome;
	assert.deepEqual(o.written, [{ path: "out/a.txt", size: 1 }]);
	assert.equal(o.rejected[0].path, "bad/../x");
	assert.deepEqual(stored, ["out/a.txt"]);
	// error result: files ignored
	j = b.dispatch(spec({ writeFile }));
	b.claim(j.jobId, "u1", "tab-aaaaaaaa", where);
	b.complete(j.jobId, "u1", where, { tabId: "tab-aaaaaaaa", ok: false, error: { kind: "error", message: "boom" }, files: [{ path: "z.txt", base64: b64("Z") }] });
	o = await j.outcome;
	assert.equal(o.kind, "done");
	assert.deepEqual(o.written, []);
	assert.equal(stored.includes("z.txt"), false);
	// capacity failure reported by the runtime → failed(kind)
	j = b.dispatch(spec({ writeFile }));
	b.claim(j.jobId, "u1", "tab-aaaaaaaa", where);
	b.complete(j.jobId, "u1", where, { tabId: "tab-aaaaaaaa", ok: false, error: { kind: "oom", message: "out of memory" } });
	o = await j.outcome;
	assert.deepEqual([o.kind, o.fail], ["failed", "oom"]);
	// too many files
	j = b.dispatch(spec({ writeFile }));
	b.claim(j.jobId, "u1", "tab-aaaaaaaa", where);
	assert.throws(() => b.complete(j.jobId, "u1", where, { tabId: "tab-aaaaaaaa", ok: true, files: Array.from({ length: 51 }, (_, i) => ({ path: `f${i}`, base64: "" })) }), (e: any) => e.status === 413);
});

// ------------------------------------------------------------------ app level
async function world(t: TestApp) {
	const a = await t.user("lx-owner@example.com");
	const member = await orgMember(t, a, "lx-member@example.com");
	const identity = t.app.ctx.services.get("identity");
	const spaceId = identity.personalSpace(a.me.userId, a.me.orgId).id;
	const ctx = t.app.ctx;
	const svc = ctx.services.get("localExec") as LocalExec;
	const sb = ctx.services.get("sandbox") as Sandbox;
	const conv = `/api/conversations/${spaceId}`;
	// These tests exercise the browser path, which round 12 keeps but no longer chooses by default (see "round 12: default preference").
	svc.defaultPreference = "local";
	return { a, member, spaceId, ctx, svc, sb, conv };
}

/** A browser tab simulator: reacts to `localjob` like web/src/features/localexec does, through the real HTTP API. */
function tabSim(t: TestApp, w: Awaited<ReturnType<typeof world>>, conversationId: number, token: string, tabId: string, behave: (job: LocalJobClaimResponse, readInput: (p: string) => Promise<string>) => Promise<Record<string, unknown>>, userId = w.a.me.userId) {
	const claims: { status: number; body?: any }[] = [];
	const conn: TabConnection = {
		spaceId: w.spaceId,
		conversationId,
		userId,
		tabId,
		send: (event, data: any) => {
			if (event !== "localjob") return;
			void (async () => {
				const base = `${w.conv}/${conversationId}/local-exec/jobs/${data.jobId}`;
				const res = await t.req("POST", `${base}/claim`, { token, json: { tabId } });
				const body = await res.json();
				claims.push({ status: res.status, body });
				if (res.status !== 200) return;
				const readInput = async (p: string) => (await (await t.req("GET", `${base}/input?tabId=${tabId}&path=${encodeURIComponent(p)}`, { token })).text());
				const result = await behave(body, readInput);
				await t.req("POST", `${base}/result`, { token, json: { tabId, ...result } });
			})();
		},
	};
	const detach = w.svc.broker.attach(conn);
	return { claims, detach };
}

const b64 = (x: string) => Buffer.from(x).toString("base64");
const hasNamespaces = async (sb: Sandbox) => (await sb.drivers.resolve()).effective !== "none";

test("code_run through the tool machinery: browser when a tab is connected (files land in the host workspace), upgrade on timeout, code errors are not retried, scan and backend=cloud go to the cloud", async () => {
	const t = await startTestApp();
	const cloudCalls: CloudRunInput[] = [];
	try {
		const w = await world(t);
		w.svc.setCloudRunner(async (i) => {
			cloudCalls.push(i);
			// the code lives in the host workspace (hidden temp path) while the cloud command runs and is gone afterwards
			const m = /"(\.wr-run\/[^"]+)"/.exec(i.code)!;
			assert.ok(m, i.code);
			assert.ok(existsSync(join(w.sb.workdir(i.space, i.conversationId), m[1]!)), "code file exists in the workspace during the cloud run");
			return { id: "run_fake", status: "ok", exitCode: 0, stdout: "cloud says hi\n@@wr-return@@42", stderr: "", durationMs: 5 };
		});
		const h = await toolHarness([createLocalExecExtension(w.ctx, { resolveActor: fixedActor(w.ctx, w.a.me.userId, w.a.me.orgId, w.spaceId) })], [
			call("code_run", { language: "javascript", code: "// ok\nawait files.write('out/r.txt','hello'); return 42", inputs: ["in.txt"] }, "c1"),
			call("code_run", { language: "javascript", code: "// slow\nreturn 'slow'" }, "c2"),
			call("code_run", { language: "javascript", code: "// boom\nthrow new Error('boom')" }, "c3"),
			call("code_run", { language: "javascript", code: "return fetch('https://x.test')" }, "c4"),
			call("code_run", { language: "javascript", code: "return 1", backend: "cloud" }, "c5"),
			answer("done"),
		]);
		const convId = Number(h.root.id);
		const space = w.ctx.services.get("identity").space(w.spaceId)!;
		w.sb.writeFile(space, convId, "in.txt", new TextEncoder().encode("input-text"));
		let readBack = "";
		const tab = tabSim(t, w, convId, w.a.token, "tab-sim-0001", async (job, readInput) => {
			if (job.code.includes("// slow")) return { ok: false, error: { kind: "timeout", message: "超时" } };
			if (job.code.includes("// boom")) return { ok: false, stderr: "Error: boom", error: { kind: "error", message: "boom" } };
			readBack = await readInput("in.txt");
			return { ok: true, stdout: "from browser\n", returnValue: "42", durationMs: 3, files: [{ path: "out/r.txt", base64: b64("hello") }] };
		});
		await h.run("go");
		const r = await h.results();
		await h.close();
		tab.detach();
		assert.equal(r.length, 5, JSON.stringify(r.map((x) => x.text)));
		// c1: browser
		assert.equal(r[0]!.isError, false, r[0]!.text);
		assert.match(r[0]!.text, /^backend: browser/);
		assert.match(r[0]!.text, /return: 42/);
		assert.match(r[0]!.text, /files written: out\/r\.txt \(5 B\)/);
		assert.equal(r[0]!.details.localExec.backend, "browser");
		assert.equal(readBack, "input-text");
		assert.equal(readFileSync(join(w.sb.workdir(space, convId), "out", "r.txt"), "utf8"), "hello", "output file landed in the host workspace");
		// c2: browser timed out → cloud once, with a note
		assert.match(r[1]!.text, /^backend: cloud/);
		assert.match(r[1]!.text, /note: 浏览器内运行失败（超时），已自动改在云端沙箱重新运行一次/);
		assert.equal(r[1]!.details.localExec.upgraded, true);
		assert.equal(r[1]!.isError, false);
		// c3: the code's own error is reported, NOT retried
		assert.equal(r[2]!.isError, true);
		assert.match(r[2]!.text, /^backend: browser/);
		assert.match(r[2]!.text, /boom/);
		// c4/c5: cloud right away
		assert.match(r[3]!.text, /^backend: cloud（云端沙箱；代码需要联网（fetch\(）/);
		assert.match(r[4]!.text, /^backend: cloud（云端沙箱；调用方要求使用云端沙箱/);
		assert.equal(cloudCalls.length, 3, "c2 (upgrade), c4 (scan), c5 (forced)");
		assert.ok(cloudCalls.every((c) => c.language === "node" && /"\.wr-run\/r_[a-z0-9]+\.mjs"/.test(c.code) && c.timeoutMs === 20_000));
		assert.deepEqual(readdirSync(join(w.sb.workdir(space, convId), ".wr-run")), [], "temp code files removed");
		// the cloud return value is lifted out of stdout
		assert.match(r[3]!.text, /stdout:\ncloud says hi\nreturn: 42/);
	} finally {
		await t.dispose();
	}
});

test("code_run: no connected tab → cloud (reason no_tab); a tab that never claims → cloud after the wait; preference cloud and the admin switch route to the cloud; tab_lost upgrades", async () => {
	const t = await startTestApp();
	try {
		const w = await world(t);
		const calls: string[] = [];
		w.svc.setCloudRunner(async (i) => (calls.push(i.code), { id: "run_fake", status: "ok", exitCode: 0, stdout: "", stderr: "", durationMs: 1 }));
		const space = w.ctx.services.get("identity").space(w.spaceId)!;
		const actor = (conversationId: number) => ({ principal: w.ctx.services.get("identity").principalFor(w.a.me.userId, w.a.me.orgId) as any, space, conversationId, taskId: 1, callId: "k" });
		const principal = (await w.ctx.services.get("identity").principalFor(w.a.me.userId, w.a.me.orgId))!;
		const run = (conversationId: number, extra: Record<string, unknown> = {}) => w.svc.run({ actor: { principal, space, conversationId, taskId: 1, callId: "k" }, args: { language: "javascript", code: "return 1", ...extra } as any });
		void actor;
		let r = await run(11);
		assert.deepEqual([r.backend, r.reason], ["cloud", "no_tab"]);
		// a tab is connected but silent
		Object.assign(w.svc.broker, { claimWaitMs: 80 });
		const silent = w.svc.broker.attach({ spaceId: w.spaceId, conversationId: 12, userId: w.a.me.userId, tabId: "tab-silent-01", send: () => {} });
		r = await run(12);
		assert.deepEqual([r.backend, r.reason, r.upgraded?.fail], ["cloud", "browser_failed", "unclaimed"]);
		assert.match(r.notes[0]!, /没有标签页接手/);
		silent();
		// conversation preference (HTTP) → cloud even with an eager tab
		const eager = tabSim(t, w, 13, w.a.token, "tab-eager-001", async () => ({ ok: true, stdout: "b\n" }));
		assert.equal((await run(13)).backend, "browser");
		await t.json("PUT", `${w.conv}/13/local-exec`, { token: w.a.token, json: { preference: "cloud" } });
		r = await run(13);
		assert.deepEqual([r.backend, r.reason], ["cloud", "pref_cloud"]);
		await t.json("PUT", `${w.conv}/13/local-exec`, { token: w.a.token, json: { preference: "local" } });
		assert.equal((await run(13)).backend, "browser");
		// organisation switch off → cloud; a plain member cannot flip it
		await t.json("PUT", "/api/sandbox/local-exec", { token: w.member.token, json: { enabled: false }, expect: 403 });
		assert.deepEqual(await t.json("PUT", "/api/sandbox/local-exec", { token: w.a.token, json: { enabled: false } }), { enabled: false, canManage: true, languages: ["javascript", "python"] });
		r = await run(13);
		assert.deepEqual([r.backend, r.reason], ["cloud", "disabled"]);
		assert.equal((await t.json("GET", "/api/sandbox/local-exec", { token: w.member.token })).enabled, false);
		await t.json("PUT", "/api/sandbox/local-exec", { token: w.a.token, json: { enabled: true } });
		assert.equal((await run(13)).backend, "browser");
		eager.detach();
		// the claiming tab vanishes mid-run → upgrade
		Object.assign(w.svc.broker, { tabGraceMs: 40 });
		let lost: () => void = () => {};
		lost = w.svc.broker.attach({ spaceId: w.spaceId, conversationId: 14, userId: w.a.me.userId, tabId: "tab-flaky-001", send: (ev, data: any) => { if (ev === "localjob") { w.svc.broker.claim(data.jobId, w.a.me.userId, "tab-flaky-001", { spaceId: w.spaceId, conversationId: 14 }); setTimeout(lost, 10); } } });
		r = await run(14);
		assert.deepEqual([r.backend, r.upgraded?.fail], ["cloud", "tab_lost"]);
		assert.equal(calls.length, 5, "no_tab, unclaimed, pref, disabled, tab_lost");
		// abort while a tab is running it: the run ends as aborted and the tab is told to stop
		const events: string[] = [];
		const ac = new AbortController();
		const slow = w.svc.broker.attach({ spaceId: w.spaceId, conversationId: 15, userId: w.a.me.userId, tabId: "tab-slow-0001", send: (ev, data: any) => { events.push(ev); if (ev === "localjob") w.svc.broker.claim(data.jobId, w.a.me.userId, "tab-slow-0001", { spaceId: w.spaceId, conversationId: 15 }); } });
		const p = w.svc.run({ actor: { principal, space, conversationId: 15, taskId: 1, callId: "k" }, args: { language: "javascript", code: "return 1" }, signal: ac.signal });
		await new Promise((x) => setTimeout(x, 50));
		ac.abort();
		r = await p;
		assert.equal(r.status, "aborted");
		assert.ok(events.includes("localjob-cancel"));
		slow();
	} finally {
		await t.dispose();
	}
});

test("HTTP API: conversation preference and status, environment DTO carries `local`, other users and viewers cannot claim or read a job", async () => {
	const t = await startTestApp();
	try {
		const w = await world(t);
		const st = await t.json("GET", `${w.conv}/21/local-exec`, { token: w.a.token });
		assert.deepEqual(st, { enabled: true, connected: false, preference: "local" });
		const att = w.svc.broker.attach({ spaceId: w.spaceId, conversationId: 21, userId: w.a.me.userId, tabId: "tab-api-0001", send: () => {} });
		assert.deepEqual(await t.json("PUT", `${w.conv}/21/local-exec`, { token: w.a.token, json: { preference: "cloud" } }), { enabled: true, connected: true, preference: "cloud" });
		await t.json("PUT", `${w.conv}/21/local-exec`, { token: w.a.token, json: { preference: "mars" }, expect: 400 });
		await t.json("PUT", `${w.conv}/0/local-exec`, { token: w.a.token, json: { preference: "cloud" }, expect: 400 });
		const env = await t.json("GET", `${w.conv}/21/environment`, { token: w.a.token });
		assert.deepEqual(env.local, { enabled: true, connected: true, preference: "cloud" });
		assert.ok(env.kind && env.label, "the existing environment fields are still there");
		const envNew = await t.json("GET", `${w.conv}/new/environment`, { token: w.a.token });
		assert.deepEqual(envNew.local, { enabled: true, connected: false, preference: "local" });
		// the member of the org has no access to the owner's personal space
		await t.json("GET", `${w.conv}/21/local-exec`, { token: w.member.token, expect: 403 });
		await t.json("PUT", `${w.conv}/21/local-exec`, { token: w.member.token, json: { preference: "local" }, expect: 403 });
		// a job of the owner: another user (even connected) gets 403/404 and cannot disturb it
		await t.json("PUT", `${w.conv}/21/local-exec`, { token: w.a.token, json: { preference: "local" } });
		const memberTab = w.svc.broker.attach({ spaceId: w.spaceId, conversationId: 21, userId: w.member.me.userId, tabId: "tab-mem-0001", send: () => {} });
		const { jobId, outcome } = w.svc.broker.dispatch({ spaceId: w.spaceId, conversationId: 21, userId: w.a.me.userId, language: "javascript", code: "return 1", timeoutSec: 5, inputs: [{ path: "x", bytes: new Uint8Array([1]) }], writeFile: (p) => p });
		const claimUrl = `${w.conv}/21/local-exec/jobs/${jobId}/claim`;
		const bad = await t.req("POST", claimUrl, { token: w.member.token, json: { tabId: "tab-mem-0001" } });
		assert.ok(bad.status === 403 || bad.status === 404, `member claim → ${bad.status}`);
		assert.equal((await t.req("POST", claimUrl, { token: w.a.token, json: { tabId: "x" } })).status, 400, "tab id format");
		assert.equal((await t.req("POST", claimUrl, { token: w.a.token, json: { tabId: "tab-unknown-1" } })).status, 409, "a tab that is not connected cannot claim");
		assert.equal((await t.req("POST", claimUrl)).status, 401);
		assert.equal((await t.req("POST", claimUrl, { token: w.a.token, json: { tabId: "tab-api-0001" } })).status, 200);
		assert.equal((await t.req("POST", claimUrl, { token: w.a.token, json: { tabId: "tab-api-0001" } })).status, 409, "second claim");
		const inputUrl = `${w.conv}/21/local-exec/jobs/${jobId}/input?tabId=tab-api-0001&path=`;
		assert.equal((await t.req("GET", `${inputUrl}x`, { token: w.member.token })).status >= 400, true);
		assert.equal((await t.req("GET", `${inputUrl}other.txt`, { token: w.a.token })).status, 404);
		assert.equal((await (await t.req("GET", `${inputUrl}x`, { token: w.a.token })).arrayBuffer()).byteLength, 1);
		const resUrl = `${w.conv}/21/local-exec/jobs/${jobId}/result`;
		assert.equal((await t.req("POST", resUrl, { token: w.member.token, json: { tabId: "tab-api-0001", ok: true } })).status >= 400, true);
		assert.equal((await t.req("POST", resUrl, { token: w.a.token, json: { tabId: "tab-api-0001" } })).status, 400, "missing ok");
		assert.equal((await t.req("POST", resUrl, { token: w.a.token, json: { tabId: "tab-api-0001", ok: true, stdout: "fine" } })).status, 200);
		assert.equal(((await outcome) as any).result.stdout, "fine");
		assert.equal((await t.req("POST", resUrl, { token: w.a.token, json: { tabId: "tab-api-0001", ok: true } })).status, 404, "a finished job is gone");
		att();
		memberTab();
	} finally {
		await t.dispose();
	}
});

test("output files: written through the workspace path + quota checks — over quota / bad path are reported per file and the run is an error", async () => {
	const t = await startTestApp();
	const saved = process.env.WORKROOM_SANDBOX_QUOTA_MB;
	try {
		const w = await world(t);
		w.svc.setCloudRunner(async () => ({ id: "x", status: "ok", stdout: "", stderr: "", durationMs: 1 }));
		const space = w.ctx.services.get("identity").space(w.spaceId)!;
		const principal = (await w.ctx.services.get("identity").principalFor(w.a.me.userId, w.a.me.orgId))!;
		const tab = tabSim(t, w, 31, w.a.token, "tab-files-001", async () => ({
			ok: true,
			stdout: "done\n",
			files: [
				{ path: "ok/small.txt", base64: b64("fits") },
				{ path: "../escape.txt", base64: b64("no") },
				{ path: "big.bin", base64: Buffer.alloc(2 * 1024 * 1024, 1).toString("base64") },
			],
		}));
		process.env.WORKROOM_SANDBOX_QUOTA_MB = "1";
		const r = await w.svc.run({ actor: { principal, space, conversationId: 31, taskId: 1, callId: "k" }, args: { language: "javascript", code: "return 1" } });
		process.env.WORKROOM_SANDBOX_QUOTA_MB = saved;
		if (saved === undefined) delete process.env.WORKROOM_SANDBOX_QUOTA_MB;
		tab.detach();
		assert.equal(r.backend, "browser");
		assert.equal(r.status, "error", "a refused file makes the run an error the model can see");
		assert.deepEqual(r.files, [{ path: "ok/small.txt", size: 4 }]);
		assert.deepEqual(r.rejectedFiles.map((f) => f.path).sort(), ["../escape.txt", "big.bin"]);
		assert.match(r.rejectedFiles.find((f) => f.path === "big.bin")!.reason, /配额|超过/);
		assert.match(r.rejectedFiles.find((f) => f.path === "../escape.txt")!.reason, /路径/);
		assert.match(LocalExec.text(r), /files NOT written: .*big\.bin/);
		const wd = w.sb.workdir(space, 31);
		assert.equal(readFileSync(join(wd, "ok", "small.txt"), "utf8"), "fits");
		assert.equal(existsSync(join(wd, "big.bin")), false);
		assert.equal(existsSync(join(wd, "..", "escape.txt")), false);
	} finally {
		if (saved === undefined) delete process.env.WORKROOM_SANDBOX_QUOTA_MB;
		else process.env.WORKROOM_SANDBOX_QUOTA_MB = saved;
		await t.dispose();
	}
});

test("input files: missing file is a plain error; large inputs (> 20 MB) go to the cloud; inputs are read from the host workspace", async () => {
	const t = await startTestApp();
	try {
		const w = await world(t);
		w.svc.setCloudRunner(async () => ({ id: "x", status: "ok", stdout: "", stderr: "", durationMs: 1 }));
		const space = w.ctx.services.get("identity").space(w.spaceId)!;
		const principal = (await w.ctx.services.get("identity").principalFor(w.a.me.userId, w.a.me.orgId))!;
		const tab = tabSim(t, w, 41, w.a.token, "tab-input-001", async () => ({ ok: true }));
		const run = (args: Record<string, unknown>) => w.svc.run({ actor: { principal, space, conversationId: 41, taskId: 1, callId: "k" }, args: { language: "javascript", code: "return 1", ...args } as any });
		await assert.rejects(() => run({ inputs: ["nope.csv"] }), (e: any) => e.status === 404 || /不存在|not/i.test(e.message));
		await assert.rejects(() => run({ inputs: ["../../etc/passwd"] }), (e: any) => e.status === 400);
		w.sb.writeFile(space, 41, "big.bin", new Uint8Array(21 * 1024 * 1024));
		const r = await run({ inputs: ["big.bin"] });
		assert.deepEqual([r.backend, r.reason], ["cloud", "inputs_too_large"]);
		w.sb.writeFile(space, 41, "small.txt", new Uint8Array(10));
		assert.equal((await run({ inputs: ["small.txt"] })).backend, "browser");
		assert.equal((await run({ language: "python", code: "print(1)" })).backend, "browser", "python is routed to the browser runtime (Pyodide)");
		assert.deepEqual(((await run({ language: "python", code: "import requests" })) as any).reason, "needs_network");
		await assert.rejects(() => run({ code: "   " }), (e: any) => e.status === 400);
		await assert.rejects(() => run({ language: "ruby" }), (e: any) => e.status === 400);
		tab.detach();
	} finally {
		await t.dispose();
	}
});

test("SSE presence: the conversation stream opened with ?local=<tab> registers the tab and announces jobs as `localjob` events; closing it removes the tab", async () => {
	const t = await startTestApp();
	try {
		const w = await world(t);
		const { conversation } = await t.json("POST", "/api/conversations", { token: w.a.token, json: { spaceId: w.spaceId } });
		const cid = (conversation.conversationId ?? conversation.id) as number;
		const res = await t.req("GET", `/api/conversations/${w.spaceId}/${cid}/events?local=tab-sse-0001`, { token: w.a.token });
		assert.equal(res.status, 200);
		const reader = res.body!.getReader();
		let seen = "";
		const dec = new TextDecoder();
		const until = async (re: RegExp, ms = 5000) => {
			const end = Date.now() + ms;
			while (!re.test(seen) && Date.now() < end) {
				const x = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 200))]);
				if (x && !x.done) seen += dec.decode(x.value);
			}
			return re.test(seen);
		};
		assert.ok(await until(/event: snapshot/), "stream is up");
		assert.equal(w.svc.broker.connected(w.spaceId, cid, w.a.me.userId), true);
		assert.equal(w.svc.broker.connected(w.spaceId, cid, w.member.me.userId), false);
		const { jobId } = w.svc.broker.dispatch({ spaceId: w.spaceId, conversationId: cid, userId: w.a.me.userId, language: "javascript", code: "return 1", timeoutSec: 5, inputs: [], writeFile: (p) => p });
		assert.ok(await until(/event: localjob\n/), `localjob announced: ${seen.slice(-300)}`);
		assert.match(seen, new RegExp(`"jobId":"${jobId}"`));
		await reader.cancel();
		for (let i = 0; i < 20 && w.svc.broker.connected(w.spaceId, cid, w.a.me.userId); i++) await new Promise((r) => setTimeout(r, 50));
		assert.equal(w.svc.broker.connected(w.spaceId, cid, w.a.me.userId), false, "closing the stream removes the tab");
		// a stream without ?local= is not a runner
		const plain = await t.req("GET", `/api/conversations/${w.spaceId}/${cid}/events`, { token: w.a.token });
		const pr = plain.body!.getReader();
		await pr.read();
		assert.equal(w.svc.broker.connected(w.spaceId, cid, w.a.me.userId), false);
		await pr.cancel();
		w.svc.broker.shutdown();
	} finally {
		await t.dispose();
	}
});

test("cloud wrapper really runs on the machine's own sandbox driver: same contract as the browser (async body, files API, return value, errors), temp file cleaned", async (tc) => {
	const t = await startTestApp();
	try {
		const w = await world(t);
		if (!(await hasNamespaces(w.sb))) return tc.skip("no local sandbox driver on this machine");
		const space = w.ctx.services.get("identity").space(w.spaceId)!;
		const principal = (await w.ctx.services.get("identity").principalFor(w.a.me.userId, w.a.me.orgId))!;
		const run = (args: Record<string, unknown>) => w.svc.run({ actor: { principal, space, conversationId: 51, taskId: 1, callId: `k${Math.random()}` }, args: { language: "javascript", ...args } as any });
		w.sb.writeFile(space, 51, "in.txt", new TextEncoder().encode("abc"));
		const r = await run({ code: "const t = await files.read('in.txt'); await files.write('out/up.txt', t.toUpperCase()); console.log('hi', 1+1); return { n: (await files.list()).length, t };", inputs: ["in.txt"], backend: "cloud" });
		assert.equal(r.status, "ok", JSON.stringify(r));
		assert.equal(r.backend, "cloud");
		assert.equal(r.stdout, "hi 2\n");
		assert.deepEqual(JSON.parse(r.returnValue!), { n: 2, t: "abc" });
		assert.equal(readFileSync(join(w.sb.workdir(space, 51), "out", "up.txt"), "utf8"), "ABC", "files.write in the cloud lands in the workspace");
		assert.deepEqual(readdirSync(join(w.sb.workdir(space, 51), ".wr-run")), []);
		const e = await run({ code: "throw new Error('kaboom')", backend: "cloud" });
		assert.equal(e.status, "error");
		assert.match(e.stderr, /kaboom/);
		const esc = await run({ code: "await files.read('../../etc/passwd')", backend: "cloud" });
		assert.equal(esc.status, "error");
		assert.match(esc.stderr, /outside the working directory/);
		const py = await w.svc.run({ actor: { principal, space, conversationId: 51, taskId: 1, callId: "kpy" }, args: { language: "python", code: "print(sum(range(5)))" } });
		assert.deepEqual([py.backend, py.reason, py.stdout.trim()], ["cloud", "no_tab", "10"], "python runs in the cloud when no tab is connected");
		const pyNet = await w.svc.run({ actor: { principal, space, conversationId: 51, taskId: 1, callId: "kpy2" }, args: { language: "python", code: "import subprocess\nprint('x')" } });
		assert.deepEqual([pyNet.backend, pyNet.reason], ["cloud", "needs_process"]);
		// the wrapper is plain JS (syntax check for odd code content)
		assert.doesNotThrow(() => new Function(jsWrapper("return `a${'$'}{1}` + \"\u2028\"").replace(/^import .*$/gm, "").replace(/await /g, "")));
	} finally {
		await t.dispose();
	}
});

test("round 12: a conversation without an explicit choice prefers the cloud (本地环境 is greyed out); an explicit local choice is still honoured", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("lx-default@example.com");
		const spaceId = t.app.ctx.services.get("identity").personalSpace(a.me.userId, a.me.orgId).id;
		const conv = `/api/conversations/${spaceId}`;
		assert.deepEqual(await t.json("GET", `${conv}/41/local-exec`, { token: a.token }), { enabled: true, connected: false, preference: "cloud" });
		assert.equal((await t.json("GET", `${conv}/new/environment`, { token: a.token })).local.preference, "cloud");
		assert.equal((await t.json("PUT", `${conv}/41/local-exec`, { token: a.token, json: { preference: "local" } })).preference, "local");
		assert.equal((await t.json("GET", `${conv}/41/local-exec`, { token: a.token })).preference, "local");
	} finally {
		await t.dispose();
	}
});
