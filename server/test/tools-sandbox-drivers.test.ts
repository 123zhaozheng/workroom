// Sandbox drivers without a real Docker daemon: driver selection and auto-detection, the exact `docker run` command line produced by the docker
// driver (checked through a fake docker CLI that records every call), timeout/cancel/cleanup behaviour, Windows path translation, mount rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { Sandbox } from "../src/tools/sandbox.ts";
import { SandboxDrivers } from "../src/tools/sandbox/registry.ts";
import { normalizeTarget, type DriverStatus, type SandboxDriver } from "../src/tools/sandbox/driver.ts";
import { bindMountArg, findExecutable, findSoffice, parsePathMap, toDockerHostPath } from "../src/tools/sandbox/paths.ts";
import { cleanPath } from "../src/tools/sandbox/workspace.ts";
import { FALLBACK_NODE_IMAGE, FALLBACK_PYTHON_IMAGE } from "../src/tools/sandbox/docker.ts";

const SHIM = fileURLToPath(new URL("./fixtures/docker-shim.mjs", import.meta.url));

/** A fake docker CLI (shell wrapper around docker-shim.mjs) + its state dir. */
function makeShim(env: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "wr-shim-"));
	const bin = join(dir, "docker");
	writeFileSync(bin, `#!/bin/sh\nexport SHIM_DIR=${JSON.stringify(dir)}\n${Object.entries(env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join("\n")}\nexec ${JSON.stringify(process.execPath)} --disable-warning=ExperimentalWarning ${JSON.stringify(SHIM)} "$@"\n`);
	chmodSync(bin, 0o755);
	const calls = () => (existsSync(join(dir, "calls.jsonl")) ? readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { cmd: string; args: string[] }) : []);
	return { dir, bin, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const unavailableNs: SandboxDriver = {
	id: "namespaces",
	label: "Linux 命名空间",
	capabilities: { network: false, services: true, mounts: true, cgroupLimits: false, hostRuntimes: true },
	notes: { isolates: [], doesNotIsolate: [] },
	async detect(): Promise<DriverStatus> {
		return { id: "namespaces", state: "unavailable", summary: "此主机不能使用命名空间沙箱", details: ["simulated: no user namespaces (Windows/macOS)"], checkedAt: new Date().toISOString() };
	},
	async run() {
		throw new Error("not used");
	},
	async startService() {
		throw new Error("not used");
	},
	async reapStale() {
		return 0;
	},
	async killStale() {
		return false;
	},
};

/** A sandbox whose namespace driver is "unavailable" (like Windows/macOS) and whose docker CLI is the shim. */
async function windowsLikeSandbox(t: TestApp, shim: ReturnType<typeof makeShim>, docker: Record<string, unknown> = {}) {
	const ctx = t.app.ctx;
	const a = await t.user(`drv${Math.random().toString(36).slice(2, 8)}@example.com`);
	const principal = (await ctx.services.get("identity").principalFor(a.me.userId, a.me.orgId))!;
	const sb = new Sandbox(ctx, { drivers: new SandboxDrivers(ctx, { namespaces: unavailableNs }) });
	sb.drivers.update(principal, { driver: "auto", docker: { bin: shim.bin, image: "workroom/sandbox:1", ...docker } as any });
	const space = ctx.services.get("identity").personalSpace(a.me.userId, a.me.orgId);
	return { sb, principal, space, ctx };
}

test("driver selection: auto prefers namespaces, then docker, then none; explicit choices are never silently downgraded", async () => {
	const t = await startTestApp();
	const shim = makeShim({ SHIM_IMAGES: "workroom/sandbox:1" });
	try {
		const ctx = t.app.ctx;
		const a = await t.user("sel@example.com");
		const p = (await ctx.services.get("identity").principalFor(a.me.userId, a.me.orgId))!;
		// A host with working namespaces and a working docker: auto → namespaces.
		const readyNs: SandboxDriver = { ...unavailableNs, async detect() { return { id: "namespaces", state: "ready", summary: "ok", details: [], checkedAt: "" } as DriverStatus; } };
		const both = new SandboxDrivers(ctx, { namespaces: readyNs });
		both.update(p, { driver: "auto", docker: { bin: shim.bin } });
		assert.equal((await both.resolve(true)).effective, "namespaces");
		// Explicit docker on the same host → docker (not namespaces).
		both.update(p, { driver: "docker" });
		const d = await both.resolve(true);
		assert.equal(d.effective, "docker");
		assert.match(d.reason, /管理员选择了 Docker/);
		// No namespaces (Windows/macOS), docker ready → auto → docker.
		const win = new SandboxDrivers(ctx, { namespaces: unavailableNs });
		win.update(p, { driver: "auto", docker: { bin: shim.bin } });
		const w = await win.resolve(true);
		assert.equal(w.effective, "docker");
		assert.match(w.reason, /命名空间不可用，改用 Docker/);
		// No namespaces, docker CLI missing → none with a how-to-enable message.
		win.update(p, { docker: { bin: join(shim.dir, "does-not-exist") } });
		const n = await win.resolve(true);
		assert.equal(n.effective, "none");
		assert.match(n.reason, /没有可用的沙箱驱动/);
		assert.match(n.reason, /Docker/);
		await assert.rejects(n.driver.run({} as never), (e: any) => e.status === 503 && /沙箱不可用/.test(e.message) && /(Docker Desktop|Docker Engine|命名空间)/.test(e.message));
		// Explicit docker but not usable → none (never namespaces silently).
		both.update(p, { driver: "docker", docker: { bin: join(shim.dir, "does-not-exist") } });
		const x = await both.resolve(true);
		assert.equal(x.effective, "none");
		assert.match(x.reason, /已选择 Docker 驱动，但不可用/);
		// Explicit none.
		both.update(p, { driver: "none" });
		assert.match((await both.resolve(true)).reason, /已关闭/);
		// Settings persist across instances (app.sqlite) and are validated.
		assert.equal(new SandboxDrivers(ctx).settings().driver, "none");
		assert.throws(() => both.update(p, { driver: "vm" as any }), /driver 必须是/);
		assert.throws(() => both.update(p, { docker: { image: "bad image;rm -rf" } }), /不是合法的镜像名/);
		assert.throws(() => both.update(p, { docker: { host: "http://evil" } }), /host 必须以/);
	} finally {
		shim.cleanup();
		await t.dispose();
	}
});

test("docker detection reports why it is not usable: missing CLI, daemon down, Windows containers, missing images", async () => {
	const t = await startTestApp();
	const cleanups: (() => void)[] = [];
	try {
		const cases: [Record<string, string>, RegExp, string][] = [
			[{ SHIM_DOWN: "1" }, /Docker Desktop 没有运行|无法连接 Docker 守护进程/, "unavailable"],
			[{ SHIM_OS: "windows" }, /Windows 容器模式/, "unavailable"],
			[{ SHIM_IMAGES: "" }, /镜像尚未准备/, "needs_setup"],
			[{ SHIM_IMAGES: "workroom/sandbox:1" }, /可用/, "ready"],
		];
		for (const [env, re, state] of cases) {
			const shim = makeShim(env);
			cleanups.push(shim.cleanup);
			const { sb } = await windowsLikeSandbox(t, shim);
			const st = (await sb.drivers.resolve(true)).statuses.docker;
			assert.equal(st.state, state, JSON.stringify(env));
			assert.match(st.summary, re);
			if (state !== "ready") assert.ok(st.howToEnable && st.howToEnable.length > 20, "has how-to-enable text");
		}
	} finally {
		cleanups.forEach((f) => f());
		await t.dispose();
	}
});

test("docker driver: the container is started with network none, read-only root, non-root user, dropped caps, limits, work/code mounts; always removed", async () => {
	const t = await startTestApp();
	const shim = makeShim({ SHIM_IMAGES: "workroom/sandbox:1" });
	try {
		const { sb, principal, space, ctx } = await windowsLikeSandbox(t, shim);
		const skills = join(sb.mountsRoot(), "skills", "pdf, report");
		mkdirSync(skills, { recursive: true });
		const run = await sb.run({ principal, space, conversationId: 7, language: "python", code: "print('hi')", env: { API_TOKEN: "s3cret" }, mounts: [{ hostPath: skills, target: "/skills/pdf-report", readOnly: true }] });
		assert.equal(run.status, "ok", run.stderr);
		assert.match(run.stdout, /shim-stdout/);
		assert.equal((run as any).driver, "docker");
		const calls = shim.calls();
		const runCall = calls.find((c) => c.cmd === "run")!;
		const a = runCall.args;
		const has = (...seq: string[]) => a.some((_, i) => seq.every((s, j) => a[i + j] === s));
		assert.ok(has("--network", "none"), "no network by default");
		assert.ok(a.includes("--read-only"));
		assert.ok(has("--cap-drop", "ALL"));
		assert.ok(has("--security-opt", "no-new-privileges"));
		assert.ok(has("--memory", "512m") && has("--memory-swap", "512m"));
		assert.ok(a.includes("--pids-limit") && a.includes("--cpus"));
		assert.ok(has("--pull", "never"));
		assert.ok(has("--tmpfs", "/tmp:rw,nosuid,nodev,size=64m"));
		const user = a[a.indexOf("--user") + 1]!;
		assert.match(user, /^\d+:\d+$/);
		assert.notEqual(user, "0:0", "never root in the container (docker, not rootless)");
		assert.ok(a.some((x) => x === "workroom.sandbox=1") && a.some((x) => /^workroom\.instance=[0-9a-f]{16}$/.test(x)));
		const mounts = a.filter((_, i) => a[i - 1] === "--mount");
		const wd = realpathSync(sb.workdir(space, 7));
		assert.ok(mounts.includes(`type=bind,source=${wd},target=/work`), `work mount rw: ${mounts.join(" | ")}`);
		assert.ok(mounts.some((m) => /target=\/code,readonly$/.test(m)), "code is read-only");
		assert.ok(mounts.includes(`type=bind,"source=${realpathSync(skills)}",target=/skills/pdf-report,readonly`), `comma in a host path is CSV-quoted: ${mounts.join(" | ")}`);
		// Secrets never appear on the command line (env file in the scratch dir instead).
		assert.ok(!a.join(" ").includes("s3cret"));
		assert.ok(a.includes("--env-file"));
		const image = a[a.length - 3]; // image python3 /code/main.py
		assert.equal(image, "workroom/sandbox:1");
		assert.deepEqual(a.slice(-2), ["python3", "/code/main.py"]);
		// Cleanup: the container is removed explicitly, scratch is gone.
		const name = a[a.indexOf("--name") + 1]!;
		assert.ok(calls.some((c) => c.cmd === "rm" && c.args.includes("-f") && c.args.includes(name)), "docker rm -f after the run");
		assert.deepEqual(existsSync(join(sb.root(space), ".runs")) ? readdirSync(join(sb.root(space), ".runs")) : [], [], "scratch removed");
		void ctx;
	} finally {
		shim.cleanup();
		await t.dispose();
	}
});
test("docker driver: timeout and cancellation kill then remove the container; OOM and infra failures are reported honestly", async () => {
	const t = await startTestApp();
	const hang = makeShim({ SHIM_IMAGES: "workroom/sandbox:1", SHIM_RUN: "hang" });
	const oom = makeShim({ SHIM_IMAGES: "workroom/sandbox:1", SHIM_RUN: "oom" });
	const infra = makeShim({ SHIM_IMAGES: "workroom/sandbox:1", SHIM_RUN: "infra" });
	try {
		let h = await windowsLikeSandbox(t, hang);
		const t0 = Date.now();
		const r = await h.sb.run({ principal: h.principal, space: h.space, conversationId: 1, language: "shell", code: "sleep 100", timeoutMs: 1000 });
		assert.equal(r.status, "timeout");
		assert.ok(Date.now() - t0 < 8000);
		assert.match(r.stderr, /已终止并删除容器/);
		let names = hang.calls().filter((c) => c.cmd === "run").map((c) => c.args[c.args.indexOf("--name") + 1]);
		assert.ok(hang.calls().some((c) => c.cmd === "rm" && c.args.includes("-f") && c.args.includes(names[0]!)), "docker rm -f (kill + remove) on timeout");

		const ac = new AbortController();
		setTimeout(() => ac.abort(), 300);
		const c = await h.sb.run({ principal: h.principal, space: h.space, conversationId: 1, language: "shell", code: "sleep 100", timeoutMs: 60_000, signal: ac.signal });
		assert.equal(c.status, "killed");
		assert.match(c.stderr, /已被取消/);

		h = await windowsLikeSandbox(t, oom);
		const o = await h.sb.run({ principal: h.principal, space: h.space, conversationId: 1, language: "python", code: "x=' '*10**10" });
		assert.equal(o.status, "killed");
		assert.match(o.stderr, /超过内存限制 512 MB/);

		h = await windowsLikeSandbox(t, infra);
		await assert.rejects(h.sb.run({ principal: h.principal, space: h.space, conversationId: 1, language: "python", code: "1" }), (e: any) => e.status === 503 && /沙箱不可用/.test(e.message));
		assert.equal(h.sb.runs(h.space.id, 1)[0]!.status, "error", "the run row records the infrastructure failure");
	} finally {
		[hang, oom, infra].forEach((s) => s.cleanup());
		await t.dispose();
	}
});

test("docker driver: a missing image is pulled once (autoPull), fallback public images are used per language; network needs admin opt-in and a capable driver", async () => {
	const t = await startTestApp();
	const shim = makeShim({ SHIM_IMAGES: "" });
	try {
		const { sb, principal, space } = await windowsLikeSandbox(t, shim);
		const r = await sb.run({ principal, space, conversationId: 2, language: "node", code: "console.log(1)" });
		assert.equal(r.status, "ok", r.stderr);
		const pulls = shim.calls().filter((c) => c.cmd === "pull").map((c) => c.args[1]);
		assert.deepEqual(pulls.sort(), [FALLBACK_NODE_IMAGE, FALLBACK_PYTHON_IMAGE].sort());
		const run1 = shim.calls().filter((c) => c.cmd === "run").at(-1)!.args;
		assert.equal(run1[run1.indexOf(FALLBACK_NODE_IMAGE)], FALLBACK_NODE_IMAGE, "node code runs in the node image");
		await sb.run({ principal, space, conversationId: 2, language: "python", code: "print(1)" });
		const run2 = shim.calls().filter((c) => c.cmd === "run").at(-1)!.args;
		assert.ok(run2.includes(FALLBACK_PYTHON_IMAGE));
		assert.equal(shim.calls().filter((c) => c.cmd === "pull").length, 2, "no second pull");

		// Network: refused unless the admin allows it; then `--network bridge`.
		await assert.rejects(sb.run({ principal, space, conversationId: 2, language: "shell", code: "curl x", network: true }), (e: any) => e.status === 403 && e.code === "network_disabled");
		sb.drivers.update(principal, { network: "allowed" });
		await sb.run({ principal, space, conversationId: 2, language: "shell", code: "curl x", network: true });
		const net = shim.calls().filter((c) => c.cmd === "run").at(-1)!.args;
		assert.equal(net[net.indexOf("--network") + 1], "bridge");
		const cap = await sb.capabilities();
		assert.deepEqual([cap.driver, cap.state, cap.network.allowed, cap.services, cap.mounts], ["docker", "ready", true, true, true]);
	} finally {
		shim.cleanup();
		await t.dispose();
	}
});

test("startup reaper removes orphaned containers of this data dir only, before the first run", async () => {
	const t = await startTestApp();
	const shim = makeShim({ SHIM_IMAGES: "workroom/sandbox:1" });
	try {
		writeFileSync(join(shim.dir, "ps"), "aaa111\nbbb222\n");
		const { sb, principal, space } = await windowsLikeSandbox(t, shim);
		sb.start();
		await sb.run({ principal, space, conversationId: 3, language: "shell", code: "true" });
		const calls = shim.calls();
		const ps = calls.find((c) => c.cmd === "ps")!;
		assert.ok(ps.args.includes("label=workroom.sandbox=1") && ps.args.some((x) => /^label=workroom\.instance=[0-9a-f]{16}$/.test(x)), "filtered by this instance's label");
		const rmIdx = calls.findIndex((c) => c.cmd === "rm" && c.args.includes("aaa111") && c.args.includes("bbb222"));
		const runIdx = calls.findIndex((c) => c.cmd === "run");
		assert.ok(rmIdx >= 0 && rmIdx < runIdx, "orphans removed before the first run starts");
		await sb.stop();
	} finally {
		shim.cleanup();
		await t.dispose();
	}
});

test("Windows path translation for bind mounts, mount CSV quoting, target validation, executable lookup and LibreOffice detection", () => {
	// Docker Desktop (Windows) takes native paths; \\?\ prefixes, lower-case drives and forward slashes are normalised.
	assert.equal(toDockerHostPath("C:\\Users\\me\\workroom\\data\\orgs\\o1\\sandbox\\c7", "win32", []), "C:\\Users\\me\\workroom\\data\\orgs\\o1\\sandbox\\c7");
	assert.equal(toDockerHostPath("c:/Users/me/data", "win32", []), "C:\\Users\\me\\data");
	assert.equal(toDockerHostPath("\\\\?\\D:\\Workroom Data\\x", "win32", []), "D:\\Workroom Data\\x");
	assert.equal(toDockerHostPath("\\\\?\\UNC\\nas\\share\\wr", "win32", []), "\\\\nas\\share\\wr");
	assert.equal(toDockerHostPath("/Users/me/data", "darwin", []), "/Users/me/data");
	// Server inside a container talking to the host's docker: explicit prefix map.
	assert.deepEqual(parsePathMap("/data=/srv/wr;/x=/y"), [["/data", "/srv/wr"], ["/x", "/y"]]);
	assert.equal(toDockerHostPath("/data/orgs/o/work", "linux", [["/data", "/srv/wr"]]), "/srv/wr/orgs/o/work");
	assert.equal(toDockerHostPath("/database/x", "linux", [["/data", "/srv/wr"]]), "/database/x", "prefix must match a whole path segment");
	// --mount value: commas and quotes in paths must be CSV-quoted; the Windows drive colon needs no quoting.
	assert.equal(bindMountArg("C:\\Users\\me\\data", "/work", false), "type=bind,source=C:\\Users\\me\\data,target=/work");
	assert.equal(bindMountArg("/a,b/c", "/skills/x", true), 'type=bind,"source=/a,b/c",target=/skills/x,readonly');
	assert.equal(bindMountArg('/a"b', "/m", false), 'type=bind,"source=/a""b",target=/m');
	assert.throws(() => bindMountArg("/a\nb", "/m", false), /control characters/);
	// Mount targets.
	assert.equal(normalizeTarget("/skills//pdf/./x"), "/skills/pdf/x");
	for (const bad of ["/", "/work", "/work/x", "/tmp", "/usr/lib", "/etc", "/code", "/proc/1", "skills/x", "/skills/../etc", "/a,b", "/a\\b", "/lib64/x"]) assert.throws(() => normalizeTarget(bad), /./, bad);
	// Windows executable lookup: PATHEXT-style .exe resolution, never .cmd.
	const bin = mkdtempSync(join(tmpdir(), "wr-bin-"));
	writeFileSync(join(bin, "docker.exe"), "");
	writeFileSync(join(bin, "other.cmd"), "");
	assert.equal(findExecutable("docker", [], { platform: "win32", pathEnv: bin }), join(bin, "docker.exe"));
	assert.equal(findExecutable("other", [], { platform: "win32", pathEnv: bin }), undefined);
	assert.equal(findExecutable("docker", [bin], { platform: "win32", pathEnv: "" }), join(bin, "docker.exe"));
	rmSync(bin, { recursive: true, force: true });
	// LibreOffice on Windows lives under Program Files\LibreOffice\program\soffice.exe.
	const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" } as NodeJS.ProcessEnv;
	assert.equal(findSoffice("win32", env, (p) => p === "C:\\Program Files\\LibreOffice\\program\\soffice.exe"), "C:\\Program Files\\LibreOffice\\program\\soffice.exe");
	assert.equal(findSoffice("darwin", {}, (p) => p === "/Applications/LibreOffice.app/Contents/MacOS/soffice"), "/Applications/LibreOffice.app/Contents/MacOS/soffice");
	assert.equal(findSoffice("win32", { ...env, WORKROOM_SOFFICE: "D:\\LO\\soffice.exe" }, (p) => p === "D:\\LO\\soffice.exe"), "D:\\LO\\soffice.exe");
});

test("workspace paths: traversal, absolute, drive-letter, backslash and device-name tricks are refused or normalised", () => {
	for (const p of ["../x", "a/../../x", "..", "a/..", "C:\\Windows\\x", "c:/x", "a/b:stream", "a\\..\\..\\x", "x\0y", "a/b./c", "con<", "/work/../etc"]) assert.throws(() => cleanPath(p), (e: any) => e.status === 400 && e.code === "bad_path", JSON.stringify(p));
	assert.equal(cleanPath("/work/a/b.txt"), "a/b.txt");
	assert.equal(cleanPath("a\\b\\c.txt"), "a/b/c.txt");
	assert.equal(cleanPath("/workspace/x"), "workspace/x", "only a whole /work segment is stripped");
	assert.equal(cleanPath("./a//b/"), "a/b");
	assert.equal(cleanPath(""), "");
	assert.equal(cleanPath("结果/报表 2026.csv"), "结果/报表 2026.csv");
});

test("runHost: no shell, clean environment, timeout kills the whole process tree, exit codes and output are reported", async () => {
	const { runHost } = await import("../src/tools/sandbox/hostexec.ts");
	process.env.WR_SECRET_FOR_TEST = "leak";
	try {
		const ok = await runHost([process.execPath, "-e", "console.log('hi', process.env.WR_SECRET_FOR_TEST, process.env.EXTRA); process.stderr.write('e')"], { env: { EXTRA: "x" } });
		assert.deepEqual([ok.status, ok.exitCode, ok.stdout.trim(), ok.stderr], ["ok", 0, "hi undefined x", "e"]);
		const bad = await runHost([process.execPath, "-e", "process.exit(3)"]);
		assert.deepEqual([bad.status, bad.exitCode], ["error", 3]);
		const t0 = Date.now();
		const hang = await runHost([process.execPath, "-e", "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)//wr-host-grandchild'], {stdio:'ignore'}); setInterval(()=>{},1000)"], { timeoutMs: 800 });
		assert.equal(hang.status, "timeout");
		assert.ok(Date.now() - t0 < 6000);
		const { execFileSync } = await import("node:child_process");
		let left = "";
		try {
			left = execFileSync("pgrep", ["-f", "wr-host-grandchild"], { encoding: "utf8" });
		} catch {
			/* none */
		}
		assert.equal(left.trim(), "", "grandchild died with the tree");
		const missing = await runHost(["definitely-not-a-program-xyz"]);
		assert.deepEqual([missing.status, missing.exitCode], ["error", 127]);
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 200);
		assert.equal((await runHost([process.execPath, "-e", "setInterval(()=>{},1000)"], { signal: ac.signal })).status, "killed");
	} finally {
		delete process.env.WR_SECRET_FOR_TEST;
	}
});
