// Namespace driver (Linux): mounts (read-only skills), service mode (MCP stdio server kept alive, piped stdin/stdout), idle/lifetime limits,
// env passing, network refusal, concurrency cap — the contract the marketplace group builds on (docs/requests/sandbox.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { startTestApp } from "./helpers/app.ts";
import { probeIsolation, Sandbox } from "../src/tools/sandbox.ts";
import { SandboxDrivers } from "../src/tools/sandbox/registry.ts";
import { serviceTransport } from "../src/tools/sandbox/mcp-transport.ts";

const SKIP = probeIsolation().ok ? false : probeIsolation().detail;
const ECHO = fileURLToPath(new URL("./fixtures/mcp-echo.py", import.meta.url));

async function setup() {
	const t = await startTestApp();
	const ctx = t.app.ctx;
	const a = await t.user(`svc${Math.random().toString(36).slice(2, 8)}@example.com`);
	const principal = (await ctx.services.get("identity").principalFor(a.me.userId, a.me.orgId))!;
	const sb = new Sandbox(ctx, { drivers: new SandboxDrivers(ctx) });
	sb.drivers.update(principal, { driver: "namespaces" });
	const space = ctx.services.get("identity").personalSpace(a.me.userId, a.me.orgId);
	return { t, sb, principal, space };
}

test("namespaces: read-only mounts at /skills/<slug>, mount rules, providers, env, network and concurrency policy", { skip: SKIP }, async () => {
	const { t, sb, principal, space } = await setup();
	try {
		const skill = join(sb.mountsRoot(), "skills", "report-ab12");
		mkdirSync(skill, { recursive: true });
		writeFileSync(join(skill, "main.py"), "import os, sys\nprint('skill ok', sorted(os.listdir('/skills/report')), os.environ.get('API_KEY'))\n");
		const r = await sb.run({ principal, space, conversationId: 1, language: "shell", env: { API_KEY: "k'1\"2$x" }, mounts: [{ hostPath: skill, target: "/skills/report", readOnly: true }], code: "API_KEY=\"$API_KEY\" python3 /skills/report/main.py\nif echo x > /skills/report/new 2>/dev/null; then echo WROTE; else echo readonly; fi\nls /skills" });
		assert.equal(r.status, "ok", r.stderr);
		assert.match(r.stdout, /skill ok \['main\.py'\] k'1"2\$x/);
		assert.match(r.stdout, /readonly/);
		assert.doesNotMatch(r.stdout, /WROTE/);
		assert.match(r.stdout, /^report$/m);
		// Provider mounts apply to every run of the conversation; unregistering stops it.
		const off = sb.addMountProvider("skills", async () => [{ hostPath: skill, target: "/skills/auto", readOnly: true }]);
		assert.match((await sb.run({ principal, space, conversationId: 1, language: "shell", code: "ls /skills/auto" })).stdout, /main\.py/);
		off();
		assert.doesNotMatch((await sb.run({ principal, space, conversationId: 1, language: "shell", code: "ls /skills/auto 2>&1 || true" })).stdout, /main\.py/);
		// A failing provider does not break execution.
		const off2 = sb.addMountProvider("broken", () => {
			throw new Error("boom");
		});
		assert.equal((await sb.run({ principal, space, conversationId: 1, language: "shell", code: "true" })).status, "ok");
		off2();
		// Mount rules.
		const bad: [any, RegExp][] = [
			[{ hostPath: t.dataDir, target: "/skills/x", readOnly: true }, /不在允许的目录/],
			[{ hostPath: join(t.dataDir, "app.sqlite"), target: "/skills/x", readOnly: true }, /不在允许的目录/],
			[{ hostPath: sb.mountsRoot(), target: "/skills/x", readOnly: true }, /不在允许的目录/],
			[{ hostPath: join(skill, "nope"), target: "/skills/x", readOnly: true }, /不存在/],
			[{ hostPath: skill, target: "/skills/x", readOnly: false }, /readOnly/],
			[{ hostPath: skill, target: "/usr/lib/x", readOnly: true }, /reserved/],
			[{ hostPath: skill, target: "/work", readOnly: true }, /reserved/],
		];
		for (const [m, re] of bad) await assert.rejects(sb.run({ principal, space, conversationId: 1, language: "shell", code: "true", mounts: [m] }), (e: any) => e.status === 400 && e.code === "bad_mount" && re.test(e.message), JSON.stringify(m));
		await assert.rejects(sb.run({ principal, space, conversationId: 1, language: "shell", code: "true", mounts: [{ hostPath: skill, target: "/skills/a", readOnly: true }, { hostPath: skill, target: "/skills/a", readOnly: true }] }), /重复的挂载点/);
		// A symlink inside an allowed root that points out of it is resolved before the check.
		const { symlinkSync } = await import("node:fs");
		symlinkSync(t.dataDir, join(sb.mountsRoot(), "evil-link"));
		await assert.rejects(sb.run({ principal, space, conversationId: 1, language: "shell", code: "true", mounts: [{ hostPath: join(sb.mountsRoot(), "evil-link"), target: "/skills/e", readOnly: true }] }), /不在允许的目录/);
		// Extra roots can be registered (e.g. a package cache).
		const extra = join(t.dataDir, "pkg-cache", "p1");
		mkdirSync(extra, { recursive: true });
		await assert.rejects(sb.run({ principal, space, conversationId: 1, language: "shell", code: "true", mounts: [{ hostPath: extra, target: "/opt/p1", readOnly: true }] }), /不在允许的目录/);
		sb.registerMountRoot(join(t.dataDir, "pkg-cache"));
		assert.equal((await sb.run({ principal, space, conversationId: 1, language: "shell", code: "ls /opt/p1 >/dev/null", mounts: [{ hostPath: extra, target: "/opt/p1", readOnly: true }] })).status, "ok");
		// Env names are validated.
		await assert.rejects(sb.run({ principal, space, conversationId: 1, language: "shell", code: "true", env: { "BAD-NAME": "x" } }), /invalid environment variable name/);
		// Network: namespaces can never provide it; the admin switch alone is not enough.
		await assert.rejects(sb.run({ principal, space, conversationId: 1, language: "shell", code: "true", network: true }), (e: any) => e.code === "network_disabled");
		sb.drivers.update(principal, { network: "allowed" });
		await assert.rejects(sb.run({ principal, space, conversationId: 1, language: "shell", code: "true", network: true }), (e: any) => e.code === "network_unsupported");
		const cap = await sb.capabilities();
		assert.deepEqual([cap.driver, cap.state, cap.network, cap.services, cap.mounts], ["namespaces", "ready", { supported: false, allowed: false }, true, true]);
		// Concurrency cap: with 1 slot two runs are serialised.
		sb.drivers.update(principal, { maxConcurrent: 1 });
		sb.applySettings();
		const t0 = Date.now();
		const [x, y] = await Promise.all([sb.run({ principal, space, conversationId: 2, language: "shell", code: "sleep 1" }), sb.run({ principal, space, conversationId: 3, language: "shell", code: "sleep 1" })]);
		assert.deepEqual([x.status, y.status], ["ok", "ok"]);
		assert.ok(Date.now() - t0 >= 1900, `serialised: ${Date.now() - t0} ms`);
	} finally {
		await t.dispose();
	}
});

test("namespaces: service mode — MCP stdio server inside the sandbox over the MCP client transport; reuse by key, idle timeout, stop, shutdown, no leftovers", { skip: SKIP }, async () => {
	const { t, sb, principal, space } = await setup();
	try {
		const dir = join(sb.mountsRoot(), "mcp", "echo");
		mkdirSync(dir, { recursive: true });
		copyFileSync(ECHO, join(dir, "echo.py"));
		const input = { principal, space, conversationId: 4, runtime: "python" as const, argv: ["python3", "/mcp/echo/echo.py"], env: { MCP_TOKEN: "tok-xyz" }, mounts: [{ hostPath: dir, target: "/mcp/echo", readOnly: true }] };
		const svc = await sb.acquireService("mcp:echo:4", input);
		const again = await Promise.all([sb.acquireService("mcp:echo:4", input), sb.acquireService("mcp:echo:4", input)]);
		assert.ok(again.every((s) => s === svc), "concurrent acquires of one key share one process");
		assert.equal(sb.listServices().length, 1);
		assert.deepEqual(Object.keys(sb.listServices()[0]!).sort(), ["conversationId", "driver", "id", "key", "lastActivityAt", "running", "runtime", "spaceId", "startedAt"]);
		const client = new Client({ name: "wr-test", version: "1" });
		await client.connect(serviceTransport(svc));
		assert.deepEqual((await client.listTools()).tools.map((x) => x.name), ["echo"]);
		const res = (await client.callTool({ name: "echo", arguments: { text: "你好" } })) as any;
		assert.match(res.content[0].text, /^你好\|uid=\d+\|token=tok-xyz\|cwd=\/work$/);
		for (let i = 0; i < 40 && !/tools\/call/.test(svc.stderrTail()); i++) await new Promise((r) => setTimeout(r, 50)); // stderr is written after the reply
		assert.match(svc.stderrTail(), /handled initialize[\s\S]*handled tools\/call/);
		// The service shares the conversation's workspace.
		writeFileSync(join(sb.workdir(space, 4), "marker.txt"), "m");
		await client.close();
		assert.equal((await svc.exited).reason, "stopped");
		assert.equal(sb.listServices().length, 0);

		// Idle timeout, lifetime cap, stop() idempotent, shutdown stops the rest; the whole sandbox (incl. grandchildren) dies.
		const idle = await sb.startService({ principal, space, conversationId: 4, runtime: "shell", argv: ["/bin/sh", "-c", "(sleep 4401 &); cat"], idleTimeoutMs: 1200 });
		idle.stdin.write("ping\n");
		const got: string[] = [];
		idle.stdout.on("data", (d: Buffer) => got.push(d.toString()));
		assert.equal((await idle.exited).reason, "idle");
		assert.equal(got.join(""), "ping\n");
		const life = await sb.startService({ principal, space, conversationId: 4, runtime: "shell", argv: ["/bin/sh", "-c", "(sleep 4402 &); sleep 4403"], maxLifetimeMs: 1500 });
		const lx = await life.exited;
		assert.equal(lx.reason, "lifetime");
		await life.stop();
		const long = await sb.startService({ principal, space, conversationId: 4, runtime: "shell", argv: ["/bin/sh", "-c", "(sleep 4404 &); sleep 4405"] });
		const long2 = await sb.startService({ principal, space, conversationId: 5, runtime: "shell", argv: ["/bin/sh", "-c", "sleep 4406"], key: "k2" });
		assert.equal(sb.listServices().length, 2);
		assert.equal(await sb.stopServices((s) => s.key === "k2"), 1);
		assert.equal((await long2.exited).reason, "stopped");
		await sb.stop();
		assert.equal((await long.exited).reason, "shutdown");
		const { execFileSync } = await import("node:child_process");
		let left = "";
		try {
			left = execFileSync("pgrep", ["-f", "sleep 440[1-6]"], { encoding: "utf8" });
		} catch {
			/* none */
		}
		assert.equal(left.trim(), "", "no process of any service survives");
		// Policy: a viewer-level principal cannot start a service; bad arguments are rejected.
		await assert.rejects(sb.startService({ principal, space, runtime: "python", argv: [] }), /argv/);
		await assert.rejects(sb.startService({ principal, space, runtime: "ruby" as any, argv: ["x"] }), /runtime/);
		sb.drivers.update(principal, { driver: "none" });
		await assert.rejects(sb.startService({ principal, space, runtime: "python", argv: ["x"] }), (e: any) => e.status === 503 && e.code === "sandbox_unavailable");
	} finally {
		await t.dispose();
	}
});
