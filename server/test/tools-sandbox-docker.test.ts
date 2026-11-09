// Docker driver against a REAL Docker daemon (skipped, with the reason, when none is reachable or no image is present).
// Covers: isolation properties inside the container, limits (memory, pids), timeout/cancel cleanup (no container left), read-only mounts,
// host paths with spaces/commas/unicode, long-running services (stdin/stdout piped, idle timeout, stop) and the MCP client transport.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { startTestApp } from "./helpers/app.ts";
import { Sandbox } from "../src/tools/sandbox.ts";
import { SandboxDrivers } from "../src/tools/sandbox/registry.ts";
import { DockerDriver } from "../src/tools/sandbox/docker.ts";
import { serviceTransport } from "../src/tools/sandbox/mcp-transport.ts";
import type { DriverStatus, SandboxDriver } from "../src/tools/sandbox/driver.ts";

const probe = new DockerDriver();
const status = await probe.detect(true);
const facts = probe.facts();
const SKIP = status.state === "ready" ? false : `no usable Docker daemon/image here: ${status.summary} — docker-driver verification is PENDING on a real Docker host`;
const ECHO = fileURLToPath(new URL("./fixtures/mcp-echo.py", import.meta.url));

const noNs: SandboxDriver = {
	id: "namespaces",
	label: "Linux 命名空间",
	capabilities: { network: false, services: true, mounts: true, cgroupLimits: false, hostRuntimes: true },
	notes: { isolates: [], doesNotIsolate: [] },
	async detect(): Promise<DriverStatus> {
		return { id: "namespaces", state: "unavailable", summary: "simulated Windows/macOS host", details: [], checkedAt: "" };
	},
	run: async () => {
		throw new Error("unused");
	},
	startService: async () => {
		throw new Error("unused");
	},
	reapStale: async () => 0,
	killStale: async () => false,
};
const containers = () => execFileSync("docker", ["ps", "-aq", "--filter", "label=workroom.sandbox=1"], { encoding: "utf8" }).split(/\s+/).filter(Boolean);

/**
 * `fullImage: false` forces the small public images (python:3.12-slim / node:22-slim): on hosts whose storage driver copies the image for
 * every container (the vfs fallback used on this CI box) the 700 MB data-science image takes ~17 s to start a container; overlay2 hosts do not care.
 */
async function setup(dataDir?: string, fullImage = false) {
	const t = await startTestApp(dataDir ? { dataDir } : {});
	const ctx = t.app.ctx;
	const a = await t.user(`dk${Math.random().toString(36).slice(2, 8)}@example.com`);
	const principal = (await ctx.services.get("identity").principalFor(a.me.userId, a.me.orgId))!;
	const sb = new Sandbox(ctx, { drivers: new SandboxDrivers(ctx, { namespaces: noNs }) });
	sb.drivers.update(principal, { driver: "docker", docker: fullImage ? {} : { image: "workroom/sandbox:not-used-in-this-test" } });
	const space = ctx.services.get("identity").personalSpace(a.me.userId, a.me.orgId);
	return { t, sb, principal, space };
}

test("docker (real): container isolation, persistence in /work, no network, read-only root, non-root", { skip: SKIP, timeout: 180_000 }, async () => {
	const { t, sb, principal, space } = await setup();
	try {
		assert.equal((await sb.capabilities()).driver, "docker");
		const py = await sb.run({
			principal, space, conversationId: 1, language: "python", env: { GREETING: "你好" },
			code: `import os, socket, sys
print("uid", os.getuid(), "gid", os.getgid())
print("cwd", os.getcwd(), "home", os.environ["HOME"], "greeting", os.environ.get("GREETING"))
print("root", sorted(os.listdir("/")))
open("out.csv", "w").write("a,b\\n1,2\\n")
open("/tmp/x", "w").write("tmpfs ok"); print("tmp", open("/tmp/x").read())
for p in ("/usr/evil", "/etc/evil", "/code/evil"):
    try: open(p, "w"); print("write", p, "ALLOWED")
    except OSError as e: print("ro", p, e.errno)
s = socket.socket(); s.settimeout(3)
try: print("net", s.connect_ex(("1.1.1.1", 80)))
except Exception as e: print("net", type(e).__name__)
print("exists", os.path.exists("/home/user/workroom"), os.path.exists(${JSON.stringify(join(t.dataDir, "app.sqlite"))}), os.path.exists(${JSON.stringify(t.dataDir)}))
`,
		});
		assert.equal(py.status, "ok", py.stderr);
		assert.match(py.stdout, /uid (10001|\d+) gid/);
		assert.doesNotMatch(py.stdout, /uid 0 /);
		assert.match(py.stdout, /cwd \/work home \/tmp\/home greeting 你好/);
		assert.match(py.stdout, /tmp tmpfs ok/);
		assert.doesNotMatch(py.stdout, /ALLOWED/);
		assert.match(py.stdout, /ro \/usr\/evil 30/);
		assert.match(py.stdout, /ro \/code\/evil 30/);
		assert.doesNotMatch(py.stdout, /net 0\b/);
		assert.doesNotMatch(py.stdout, /workroom|app\.sqlite|'orgs'|'blobs'/);
		assert.match(py.stdout, /exists False False False/);
		assert.equal((py as any).driver, "docker");
		// The file the container wrote is on the host workspace, and the next run (a new container) sees it: persistence.
		assert.equal(readFileSync(join(sb.workdir(space, 1), "out.csv"), "utf8"), "a,b\n1,2\n");
		const sh = await sb.run({ principal, space, conversationId: 1, language: "shell", code: "cat out.csv; echo $(id -u); hostname; ls /work" });
		assert.equal(sh.status, "ok", sh.stderr);
		assert.match(sh.stdout, /a,b\n1,2/);
		assert.match(sh.stdout, /sandbox/);
		const nd = await sb.run({ principal, space, conversationId: 1, language: "node", code: "import fs from 'node:fs'; console.log(process.version, fs.readFileSync('out.csv','utf8').split('\\n').length); fs.writeFileSync('n.txt','node')" });
		assert.equal(nd.status, "ok", nd.stderr);
		assert.match(nd.stdout, /v22\.\d+\.\d+ 3/);
		assert.equal(readFileSync(join(sb.workdir(space, 1), "n.txt"), "utf8"), "node");
		// Failing script: exit code and stderr surface.
		const bad = await sb.run({ principal, space, conversationId: 1, language: "python", code: "import sys; print('x'); sys.exit(7)" });
		assert.deepEqual([bad.status, bad.exitCode], ["error", 7]);
		assert.deepEqual(containers(), [], "every container was removed");
	} finally {
		await t.dispose();
	}
});

test("docker (real): the full sandbox image has the data/document libraries and CJK fonts (needs `docker build -t workroom/sandbox:1 server/sandbox`)", { skip: SKIP || (facts?.images.primary ? false : "workroom/sandbox:1 is not built on this Docker host"), timeout: 240_000 }, async () => {
	const { t, sb, principal, space } = await setup(undefined, true);
	try {
		{
			const d = await sb.run({ principal, space, conversationId: 1, language: "python", timeoutMs: 120_000, code: "import numpy, pandas, matplotlib, openpyxl\nimport pandas as pd\nprint(pd.DataFrame({'a':[1,2]}).sum().a)\nimport matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt; plt.plot([1,2]); plt.savefig('c.png'); print('png', __import__('os').path.getsize('c.png') > 500)" });
			assert.equal(d.status, "ok", d.stderr);
			assert.match(d.stdout, /3\npng True/);
			const n = await sb.run({ principal, space, conversationId: 1, language: "node", timeoutMs: 120_000, code: "console.log(process.version)" });
			assert.match(n.stdout, /^v22\./);
		}
		assert.deepEqual(containers(), [], "every container was removed");
	} finally {
		await t.dispose();
	}
});

test("docker (real): memory limit, pids limit, timeout and cancellation leave no container behind", { skip: SKIP, timeout: 240_000 }, async () => {
	const { t, sb, principal, space } = await setup();
	try {
		const oom = await sb.run({ principal, space, conversationId: 2, language: "python", timeoutMs: 60_000, code: "b = bytearray(2 * 1024**3)\nfor i in range(0, len(b), 4096): b[i] = 1\nprint('survived')" });
		assert.equal(oom.status, "killed", `${oom.stdout}${oom.stderr}`);
		assert.match(oom.stderr, /超过内存限制/);
		assert.doesNotMatch(oom.stdout, /survived/);

		const pids = await sb.run({ principal, space, conversationId: 2, language: "python", timeoutMs: 30_000, code: "import os, time\nkids = 0\nfor i in range(300):\n    try:\n        pid = os.fork()\n    except OSError as e:\n        print('fork failed after', kids, e.errno); break\n    if pid == 0:\n        time.sleep(20); os._exit(0)\n    kids += 1\nelse:\n    print('NO LIMIT')\nos.system('kill 0')" });
		assert.match(pids.stdout, /fork failed after \d+ 11/, `${pids.stdout}${pids.stderr}`);
		assert.doesNotMatch(pids.stdout, /NO LIMIT/);

		const t0 = Date.now();
		const to = await sb.run({ principal, space, conversationId: 2, language: "shell", code: "(sleep 4321 &); sleep 4322", timeoutMs: 1500 });
		assert.equal(to.status, "timeout");
		assert.ok(Date.now() - t0 < 15_000, `timeout took ${Date.now() - t0} ms`);
		assert.match(to.stderr, /已终止并删除容器/);

		const ac = new AbortController();
		setTimeout(() => ac.abort(), 800);
		const c = await sb.run({ principal, space, conversationId: 2, language: "shell", code: "sleep 4323", timeoutMs: 60_000, signal: ac.signal });
		assert.equal(c.status, "killed");
		assert.match(c.stderr, /已被取消/);

		assert.deepEqual(containers(), [], "no container survives timeout/cancel/OOM");
		const ps = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" });
		assert.doesNotMatch(ps, /sleep 432[123]/, "no stray process of the sandboxed code on the host");
	} finally {
		await t.dispose();
	}
});

test("docker (real): read-only mounts, writable workspace mount, host paths with spaces/commas/unicode, mount provider", { skip: SKIP, timeout: 120_000 }, async () => {
	const base = mkdtempSync(join(tmpdir(), "wr dock, ü-"));
	const { t, sb, principal, space } = await setup(join(base, "data dir"));
	try {
		const skill = join(sb.mountsRoot(), "skills", "my, skill-ü");
		mkdirSync(skill, { recursive: true });
		writeFileSync(join(skill, "hello.py"), "import os\nprint('skill says hi', os.listdir(os.path.dirname(__file__)))\n");
		const direct = await sb.run({ principal, space, conversationId: 3, language: "shell", code: "python3 /skills/hello/hello.py; touch /skills/hello/x 2>&1 || echo 'ro ok'; ls /", mounts: [{ hostPath: skill, target: "/skills/hello", readOnly: true }] });
		assert.equal(direct.status, "ok", direct.stderr);
		assert.match(direct.stdout, /skill says hi \['hello\.py'\]/);
		assert.match(direct.stdout, /ro ok/);
		assert.match(direct.stdout, /skills/);
		// Provider: every run of the conversation gets the mount without passing it.
		const off = sb.addMountProvider("skills", () => [{ hostPath: skill, target: "/skills/auto", readOnly: true }]);
		const viaProvider = await sb.run({ principal, space, conversationId: 3, language: "shell", code: "cat /skills/auto/hello.py | head -1" });
		assert.match(viaProvider.stdout, /import os/);
		off();
		// Rules are enforced before anything starts.
		const other = mkdtempSync(join(tmpdir(), "wr-out-"));
		for (const [m, re] of [
			[{ hostPath: other, target: "/skills/x", readOnly: true }, /不在允许的目录/],
			[{ hostPath: join(t.dataDir, "app.sqlite"), target: "/skills/db", readOnly: true }, /不在允许的目录/],
			[{ hostPath: skill, target: "/skills/w", readOnly: false }, /readOnly/],
			[{ hostPath: skill, target: "/work/x", readOnly: true }, /reserved/],
		] as const) await assert.rejects(sb.run({ principal, space, conversationId: 3, language: "shell", code: "true", mounts: [m] }), (e: any) => e.status === 400 && re.test(e.message), JSON.stringify(m));
		// Workspace path with unicode name written by the host is visible; written by the container is readable on the host.
		sb.writeFile(space, 3, "数据/表 1.csv", new TextEncoder().encode("x,y\n"));
		const u = await sb.run({ principal, space, conversationId: 3, language: "python", code: "import os\nprint(os.listdir('数据'))\nopen('数据/新.txt','w').write('容器写入')\nopen('数据/表 1.csv','a').write('3,4\\n')" });
		assert.equal(u.status, "ok", u.stderr);
		assert.match(u.stdout, /表 1\.csv/);
		assert.equal(readFileSync(join(sb.workdir(space, 3), "数据", "新.txt"), "utf8"), "容器写入");
		assert.equal(readFileSync(join(sb.workdir(space, 3), "数据", "表 1.csv"), "utf8"), "x,y\n3,4\n", "a host-written file can be edited in place by the container user");
		assert.ok(statSync(join(sb.workdir(space, 3), "数据")).isDirectory());
		assert.deepEqual(containers(), []);
	} finally {
		await t.dispose();
	}
});

test("docker (real): service mode — MCP stdio server inside a container over stdin/stdout, env, mounts, idle timeout, stop removes the container", { skip: SKIP, timeout: 180_000 }, async () => {
	const { t, sb, principal, space } = await setup();
	try {
		const dir = join(sb.mountsRoot(), "mcp", "echo");
		mkdirSync(dir, { recursive: true });
		copyFileSync(ECHO, join(dir, "echo.py"));
		const svc = await sb.acquireService("mcp:echo:1", { principal, space, conversationId: 4, runtime: "python", argv: ["python3", "/mcp/echo/echo.py"], env: { MCP_TOKEN: "tok-123" }, mounts: [{ hostPath: dir, target: "/mcp/echo", readOnly: true }], idleTimeoutMs: 60_000 });
		assert.equal(svc.running, true);
		assert.equal((await sb.acquireService("mcp:echo:1", { principal, space, conversationId: 4, runtime: "python", argv: ["python3", "/mcp/echo/echo.py"] })), svc, "same key → same service");
		assert.equal(sb.listServices().length, 1);
		const client = new Client({ name: "wr-test", version: "1" });
		await client.connect(serviceTransport(svc));
		const tools = await client.listTools();
		assert.deepEqual(tools.tools.map((x) => x.name), ["echo"]);
		const r = (await client.callTool({ name: "echo", arguments: { text: "ping" } })) as any;
		assert.match(r.content[0].text, /^ping\|uid=\d+\|token=tok-123\|cwd=\/work$/);
		assert.doesNotMatch(r.content[0].text, /uid=0\|/);
		for (let i = 0; i < 40 && !/tools\/call/.test(svc.stderrTail()); i++) await new Promise((r) => setTimeout(r, 50));
		assert.match(svc.stderrTail(), /handled tools\/call/);
		assert.equal(containers().length, 1);
		await client.close(); // closing the transport stops the service
		const exit = await svc.exited;
		assert.equal(exit.reason, "stopped");
		assert.equal(svc.running, false);
		assert.deepEqual(containers(), [], "stop() removed the container");
		assert.equal(sb.listServices().length, 0);

		// Idle timeout stops an unused service; shutdown stops the rest.
		const idle = await sb.startService({ principal, space, conversationId: 4, runtime: "shell", argv: ["sh", "-c", "cat"], idleTimeoutMs: 1500 });
		idle.stdin.write("hello\n");
		const chunks: Buffer[] = [];
		idle.stdout.on("data", (d: Buffer) => chunks.push(d));
		const ex = await idle.exited;
		assert.equal(ex.reason, "idle");
		assert.equal(Buffer.concat(chunks).toString(), "hello\n");
		const long = await sb.startService({ principal, space, conversationId: 4, runtime: "shell", argv: ["sleep", "1000"] });
		assert.equal(containers().length, 1);
		await sb.stop();
		assert.equal((await long.exited).reason, "shutdown");
		assert.deepEqual(containers(), []);
	} finally {
		await t.dispose();
	}
});

test("docker (real): startup reaper removes a container orphaned by a crashed server", { skip: SKIP, timeout: 120_000 }, async () => {
	const { t, sb, principal, space } = await setup();
	try {
		// Simulate a crash: start a labelled container the way the driver does, then never clean it up.
		const run = sb.run({ principal, space, conversationId: 5, language: "shell", code: "sleep 300", timeoutMs: 120_000 });
		for (let i = 0; i < 100 && containers().length === 0; i++) await new Promise((r) => setTimeout(r, 100));
		assert.equal(containers().length, 1);
		// A fresh Sandbox object for the same data dir = the restarted server: its start() reaps the orphan first.
		const reborn = new Sandbox(t.app.ctx, { drivers: new SandboxDrivers(t.app.ctx, { namespaces: noNs }) });
		reborn.start();
		await reborn.run({ principal, space, conversationId: 5, language: "shell", code: "true" });
		assert.equal(containers().length, 0, "the orphan is gone");
		await run.catch(() => {});
		await reborn.stop();
		assert.ok(existsSync(sb.workdir(space, 5)));
	} finally {
		await t.dispose();
	}
});
