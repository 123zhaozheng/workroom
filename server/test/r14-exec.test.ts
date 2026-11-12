// Round 14 exec guarantees: V10 — a remote sandbox failure is reported as a failure (never a host fallback, never "done");
// V24 — a command cut off by a process crash is NOT run again after the restart (exec is replay-unsafe): the result says it was interrupted.
process.env.WORKROOM_RT_RETRY_MAX ??= "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startTestApp } from "./helpers/app.ts";
import { FakeRemoteProvider } from "./helpers/fake-remote-provider.ts";
import { providerConfigsFor } from "../src/tools/sandbox/provider-config.ts";
import { waitFor } from "../src/runtime/testing.ts";
import { probeIsolation } from "../src/tools/sandbox.ts";

type Conv = { spaceId: string; conversationId: number };
const base = (c: Conv) => `/api/conversations/${c.spaceId}/${c.conversationId}`;
const call = (tool: string, args: unknown) => `[[call ${tool} ${JSON.stringify(args)}]]`;
const ROOT = resolve(import.meta.dirname, "../..");
const PUBLIC_DNS = async () => [{ address: "93.184.216.34", family: 4 }];

test("V10: a remote sandbox that cannot be created/synced makes exec fail visibly; nothing runs on the host; file tools keep working without it", { timeout: 120_000 }, async () => {
	const t = await startTestApp({ config: { secretKey: "workroom-test-secret-key-0123456789" } });
	try {
		const admin = await t.user("r14-exec-admin@example.com");
		const fake = new FakeRemoteProvider();
		const svc = providerConfigsFor(t.app.ctx);
		svc.resolver = PUBLIC_DNS as never;
		svc.factory = async () => fake;
		await t.json("PUT", "/api/sandbox/providers/opensandbox", { token: admin.token, json: { enabled: true, endpoint: "https://os.example.test", apiKey: "sk-fake-r14exec-0123456789", allowPrivateNetwork: false, egressAcknowledged: true } });
		await t.json("PUT", "/api/sandbox/provider-policy", { token: admin.token, json: { orgDefault: "opensandbox", allowProjectOverride: false } });
		const c: Conv = (await t.json("POST", "/api/conversations", { token: admin.token, json: { title: "远端失败" } })).conversation;
		fake.failCreate = new Error("provider unreachable (simulated)");
		const r = await t.json("POST", `${base(c)}/messages`, { token: admin.token, json: { text: `${call("write", { path: "/work/a.txt", content: "hello" })} ${call("exec", { command: "cat a.txt > host-proof.txt" })} ${call("read", { path: "/work/a.txt" })}`, requestId: randomUUID() } });
		await waitFor(async () => {
			const s = await t.json("GET", `${base(c)}/submissions/${r.submissionId}`, { token: admin.token });
			return ["done", "unanswered"].includes(s.status) ? s : undefined;
		}, { timeoutMs: 60_000, what: "run settles" });
		const st = await t.json("GET", `${base(c)}/state?limit=200`, { token: admin.token });
		const res = (name: string) => st.entries.find((e: any) => e.kind === "tool_result" && e.toolName === name);
		assert.equal(res("write").isError, false, "writing /work does not need the sandbox");
		assert.equal(res("exec").isError, true, `exec must fail visibly: ${res("exec").text}`);
		assert.match(res("exec").text, /provider unreachable|创建|沙箱|失败/);
		assert.doesNotMatch(res("exec").text, /退出码 0/);
		assert.equal(res("read").isError, false, "reading /work does not need the sandbox either");
		const wd = (t.app.ctx.services.get("sandbox") as any).workdir(t.app.ctx.services.get("identity").space(c.spaceId), c.conversationId);
		assert.ok(!existsSync(join(wd, "host-proof.txt")), "the command never ran on the host");
	} finally {
		await t.dispose();
	}
});

async function freePort(): Promise<number> {
	return new Promise((res) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const p = (s.address() as any).port;
			s.close(() => res(p));
		});
	});
}

test("V24: a command cut off by SIGKILL is not run again after the restart; the result says the outcome is unknown", { skip: probeIsolation().ok ? false : probeIsolation().detail, timeout: 180_000 }, async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "wr-r14-exec-kill-"));
	const port = await freePort();
	const log = join(dataDir, "server.log");
	let child: ChildProcess | undefined;
	const start = async () => {
		child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/src/main.ts"], {
			cwd: ROOT,
			env: { ...process.env, WORKROOM_DATA_DIR: dataDir, PORT: String(port), HOST: "127.0.0.1", WORKROOM_INSTANCE_ID: "r14-exec-node", WORKROOM_RT_RETRY_BASE_MS: "50", WORKROOM_WEB_DIST: join(dataDir, "no-web") },
			stdio: ["ignore", openSync(log, "a"), openSync(log, "a")],
		});
		await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => undefined))?.ok, { timeoutMs: 20_000, what: "server up" });
	};
	const kill = async () => {
		const e = new Promise((r) => child!.once("exit", r));
		child!.kill("SIGKILL");
		await e;
	};
	const req = async (method: string, path: string, token?: string, json?: unknown) => {
		const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json !== undefined ? { "content-type": "application/json" } : {}) }, body: json === undefined ? undefined : JSON.stringify(json) });
		const text = await r.text();
		if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${text}`);
		return text ? JSON.parse(text) : undefined;
	};
	const findLog = (): string | undefined => {
		const walk = (d: string): string | undefined => {
			for (const n of readdirSync(d, { withFileTypes: true })) {
				const p = join(d, n.name);
				if (n.isDirectory()) {
					const r = walk(p);
					if (r) return r;
				} else if (n.name === "runs.log") return p;
			}
			return undefined;
		};
		return walk(join(dataDir, "orgs"));
	};
	try {
		await start();
		const { token } = await req("POST", "/api/auth/register", undefined, { email: "r14execkill@example.com", name: "r14", password: "password123" });
		const { conversation: c } = await req("POST", "/api/conversations", token, { title: "命令中断" });
		await req("POST", `${base(c)}/messages`, token, { text: call("exec", { command: "echo start >> runs.log; sleep 600; echo end >> runs.log", timeout_ms: 300000 }), requestId: randomUUID() });
		await waitFor(async () => {
			const f = existsSync(join(dataDir, "orgs")) ? findLog() : undefined;
			return f && readFileSync(f, "utf8").includes("start") ? f : undefined;
		}, { timeoutMs: 60_000, what: "the command started" });
		await kill();
		await start();
		const st = await waitFor(async () => {
			const s = await req("GET", `${base(c)}/state?limit=200`, token);
			return !s.live.busy && s.entries.some((e: any) => e.kind === "tool_result" && e.toolName === "exec") ? s : undefined;
		}, { timeoutMs: 90_000, what: "the cut-off exec settled" });
		const r = st.entries.find((e: any) => e.kind === "tool_result" && e.toolName === "exec");
		assert.equal(r.isError, true, r.text);
		assert.match(r.text, /interrupted|aborted|中断|未知/i);
		await new Promise((x) => setTimeout(x, 1500));
		const lines = readFileSync(findLog()!, "utf8").trim().split("\n");
		assert.deepEqual(lines, ["start"], `the command ran exactly once and was not replayed: ${JSON.stringify(lines)}`);
	} catch (err) {
		console.error(readFileSync(log, "utf8").slice(-3000));
		throw err;
	} finally {
		if (child && child.exitCode === null) await kill();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

void BACKGROUND_CONTEXT;
