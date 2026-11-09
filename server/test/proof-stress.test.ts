// Stress loop for the X-PROOF hard-kill scenario (a): SIGKILL while the fixture streams, restart, the run must finish.
// Opt-in (slow): WORKROOM_PROOF_STRESS=20 node --disable-warning=ExperimentalWarning --test server/test/proof-stress.test.ts
// Regression guard for the stranded-retry-sleep bug (host wake timer firing ~1 ms before the sleep was due; see
// docs/runtime.md §3). The kill point varies inside the slow window. On failure it prints the space's wake row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { waitFor } from "../src/runtime/testing.ts";

const N = Number(process.env.WORKROOM_PROOF_STRESS ?? 0);
const ROOT = resolve(import.meta.dirname, "../..");

const freePort = () =>
	new Promise<number>((res) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => res(p));
		});
	});

test(`X-PROOF stress: hard kill mid-stream × ${N || "(skipped)"}`, { skip: N > 0 ? false : "set WORKROOM_PROOF_STRESS=<iterations>", timeout: Math.max(N, 1) * 60_000 }, async () => {
	const failures: string[] = [];
	for (let i = 1; i <= N; i++) {
		const dir = mkdtempSync(join(tmpdir(), "wr-stress-"));
		const port = await freePort();
		const log = join(dir, "server.log");
		let child: ChildProcess | undefined;
		const start = async () => {
			const out = openSync(log, "a");
			child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/src/main.ts"], { cwd: ROOT, env: { ...process.env, WORKROOM_DATA_DIR: dir, PORT: String(port), HOST: "127.0.0.1", WORKROOM_INSTANCE_ID: "stress-1", WORKROOM_FIXTURE_TOOLS: "1", WORKROOM_RT_RETRY_BASE_MS: "50", WORKROOM_WEB_DIST: join(dir, "nw") }, stdio: ["ignore", out, out] });
			await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => undefined))?.ok, { timeoutMs: 20_000, what: "server up" });
		};
		const kill = async () => {
			const c = child!;
			const e = new Promise((r) => c.once("exit", r));
			c.kill("SIGKILL");
			await e;
		};
		const req = async (m: string, p: string, token?: string, json?: unknown) => (await fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { "content-type": "application/json" } : {}) }, body: json ? JSON.stringify(json) : undefined })).json();
		try {
			await start();
			const { token } = await req("POST", "/api/auth/register", undefined, { email: "s@example.com", name: "s", password: "password123" });
			const { conversation: c } = await req("POST", "/api/conversations", token, {});
			const base = `/api/conversations/${c.spaceId}/${c.conversationId}`;
			const s = await req("POST", `${base}/messages`, token, { text: "[[slow 4000]] 硬杀 [[reply 完成]]", requestId: `r${i}` });
			await waitFor(async () => (await req("GET", `${base}/submissions/${s.submissionId}`, token)).status === "applied", { what: "applied" });
			await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 1500)));
			await kill();
			await start();
			const done = await waitFor(async () => {
				const x = await req("GET", `${base}/submissions/${s.submissionId}`, token);
				return x.status === "done" || x.status === "unanswered" ? x : undefined;
			}, { timeoutMs: 30_000, what: "settled" }).catch(() => undefined);
			if (done?.status !== "done") {
				const db = new DatabaseSync(join(dir, "app.sqlite"));
				const wake = db.prepare("SELECT * FROM rt_space_runtime").all();
				db.close();
				failures.push(`#${i}: ${JSON.stringify(done)} now=${Date.now()} wake=${JSON.stringify(wake)}\n${readFileSync(log, "utf8").slice(-1500)}`);
			}
		} finally {
			if (child && child.exitCode === null) await kill();
			rmSync(dir, { recursive: true, force: true });
		}
	}
	assert.deepEqual(failures, [], `${failures.length}/${N} iterations stranded:\n${failures.join("\n")}`);
});
