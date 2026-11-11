// Unit tests for the E2B and Daytona adapters.
//
// IMPORTANT: the SDK modules are replaced by small TEST DOUBLES ("fake e2b", "fake daytona") that record the arguments the adapter
// passes and let each test choose behaviour. They prove OUR argument mapping and control flow; they do NOT prove the real services
// behave this way. The LIVE section at the bottom talks to the real services and only runs when
//   WORKROOM_TEST_E2B_API_KEY / WORKROOM_TEST_DAYTONA_API_KEY
// are set (optionally WORKROOM_TEST_E2B_ENDPOINT, WORKROOM_TEST_E2B_DOMAIN, WORKROOM_TEST_DAYTONA_ENDPOINT).
// No keys existed when this was written: the live paths are implemented but NOT connected.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { UnsupportedError } from "../src/tools/sandbox/provider.ts";
import type { CreateOptions } from "../src/tools/sandbox/provider.ts";
import { createProvider as createE2b, scrubSecrets as scrubE2b } from "../src/tools/sandbox/providers/e2b.ts";
import type { E2bModule } from "../src/tools/sandbox/providers/e2b.ts";
import { buildShellLine, createProvider as createDaytona } from "../src/tools/sandbox/providers/daytona.ts";
import type { DaytonaModule } from "../src/tools/sandbox/providers/daytona.ts";
import { createProvider as createOpenSandbox, setOpenSandboxSdkLoaderForTests } from "../src/tools/sandbox/providers/opensandbox.ts";

const KEY = "e2b_0123456789abcdef0123456789abcdef";
const DKEY = "dtn_secretsecretsecret1234";

const baseCreate: CreateOptions = {
	metadata: { workroom: "1", instance: "i-1" },
	lifetimeMs: 4 * 3600_000,
	createTimeoutMs: 90_000,
};
/** Round 9: option names that would make a provider deny (or force) network. None may ever reach a vendor SDK. */
const NETWORK_OPTION = /network|internet|egress|block|deny|firewall/i;
const noNetworkOptions = (o: Record<string, unknown>) => Object.keys(o).filter((k) => NETWORK_OPTION.test(k));

function named(name: string, message: string, extra: Record<string, unknown> = {}): Error {
	const e = new Error(message);
	e.name = name;
	return Object.assign(e, extra);
}

// ---------------------------------------------------------------------------------------------------------------------------
// fake e2b (TEST DOUBLE)
// ---------------------------------------------------------------------------------------------------------------------------
interface FakeE2b {
	mod: E2bModule;
	calls: { create: Record<string, unknown>[]; connect: [string, Record<string, unknown>][]; list: Record<string, unknown>[]; kill: [string, Record<string, unknown>][]; run: [string, Record<string, unknown>][]; killedHandles: number; };
	behaviour: {
		run?: (cmd: string, opts: Record<string, unknown>) => { wait: () => Promise<{ exitCode: number }> };
		connectError?: Error;
		killResult?: boolean | Error;
		listItems?: { sandboxId: string; state: string; metadata: Record<string, string>; startedAt?: Date }[];
		createError?: Error;
		entries?: unknown[];
		fileBytes?: Uint8Array;
	};
	files: Record<string, unknown[]>;
}
function fakeE2b(): FakeE2b {
	const f: FakeE2b = {
		calls: { create: [], connect: [], list: [], kill: [], run: [], killedHandles: 0 },
		behaviour: {},
		files: { writes: [], removes: [], mkdirs: [], timeouts: [] },
		mod: undefined as unknown as E2bModule,
	};
	const instance = (id: string) => ({
		sandboxId: id,
		commands: {
			async run(cmd: string, opts: Record<string, unknown>) {
				f.calls.run.push([cmd, opts]);
				const h = f.behaviour.run?.(cmd, opts) ?? { wait: async () => ({ exitCode: 0 }) };
				return { wait: h.wait, kill: async () => { f.calls.killedHandles++; return true; } };
			},
		},
		files: {
			async read() { return f.behaviour.fileBytes ?? new Uint8Array([1, 2, 3]); },
			async write(p: string, d: Uint8Array) { f.files.writes!.push([p, d]); return {}; },
			async list() { return (f.behaviour.entries ?? []) as never; },
			async remove(p: string) { f.files.removes!.push(p); },
			async makeDir(p: string) { f.files.mkdirs!.push(p); return true; },
		},
		async setTimeout(ms: number) { f.files.timeouts!.push(ms); },
	});
	f.mod = {
		Sandbox: {
			async create(opts) { f.calls.create.push(opts); if (f.behaviour.createError) throw f.behaviour.createError; return instance("sbx-1"); },
			async connect(id, opts) { f.calls.connect.push([id, opts]); if (f.behaviour.connectError) throw f.behaviour.connectError; return instance(id); },
			list(opts) {
				f.calls.list.push(opts);
				let done = false;
				return { get hasNext() { return !done; }, async nextItems() { done = true; return f.behaviour.listItems ?? []; } };
			},
			async kill(id, opts) {
				f.calls.kill.push([id, opts]);
				const r = f.behaviour.killResult;
				if (r instanceof Error) throw r;
				return r ?? true;
			},
		},
	};
	return f;
}

describe("e2b adapter (SDK test double)", () => {
	it("capabilities are honest: nothing 'supported' without a live run; advanced features unsupported", () => {
		const p = createE2b({ provider: "e2b", apiKey: KEY }, { loadSdk: async () => fakeE2b().mod });
		for (const [k, v] of Object.entries(p.capabilities)) assert.notEqual(v, "supported", `${k} must not claim "supported" before a live contract run`);
		for (const k of ["services", "pty", "preview", "snapshot", "pauseResume"] as const) assert.equal(p.capabilities[k], "unsupported");
		assert.equal(p.capabilities.location, "configurable");
	});

	it("create maps template/metadata/lifetime/timeout/env and passes endpoint + domain + key", async () => {
		const f = fakeE2b();
		const p = createE2b({ provider: "e2b", apiKey: KEY, endpoint: "https://api.e2b.example", domain: "sbx.example", template: "tpl-default" }, { loadSdk: async () => f.mod });
		const s = await p.create({ ...baseCreate, env: { A: "1" } });
		assert.equal(s.id, "sbx-1");
		const o = f.calls.create[0]!;
		assert.deepEqual(o.metadata, baseCreate.metadata);
		assert.equal(o.timeoutMs, baseCreate.lifetimeMs);
		assert.equal(o.requestTimeoutMs, baseCreate.createTimeoutMs);
		assert.equal(o.template, "tpl-default");
		assert.deepEqual(o.envs, { A: "1" });
		assert.equal(o.apiKey, KEY);
		assert.equal(o.apiUrl, "https://api.e2b.example");
		assert.equal(o.domain, "sbx.example");
		assert.equal("allowInternetAccess" in o, false, "round 9: no network option reaches the SDK");
		const s2 = await p.create({ ...baseCreate, template: "tpl-explicit" });
		assert.equal(f.calls.create[1]!.template, "tpl-explicit");
		assert.ok(s2);
	});

	it("official cloud: no endpoint/domain keys are passed at all", async () => {
		const f = fakeE2b();
		await createE2b({ provider: "e2b", apiKey: KEY }, { loadSdk: async () => f.mod }).create(baseCreate);
		assert.equal("apiUrl" in f.calls.create[0]!, false);
		assert.equal("domain" in f.calls.create[0]!, false);
		assert.equal("template" in f.calls.create[0]!, false);
	});

	it("round 9: create passes NO network option to the E2B SDK (no allowInternetAccess, true or false, no network block): the vendor default applies", async () => {
		const f = fakeE2b();
		const p = createE2b({ provider: "e2b", apiKey: KEY, template: "tpl" }, { loadSdk: async () => f.mod });
		await p.create(baseCreate);
		await p.create({ ...baseCreate, network: false } as never); // a stale caller still passing the removed flag must not turn it into an SDK option
		for (const c of f.calls.create) assert.deepEqual(noNetworkOptions(c), []);
		assert.equal("allowInternetAccess" in f.calls.create[0]!, false);
	});

	it("resource limits at create are refused with UnsupportedError", async () => {
		const f = fakeE2b();
		const p = createE2b({ provider: "e2b", apiKey: KEY }, { loadSdk: async () => f.mod });
		await assert.rejects(p.create({ ...baseCreate, resources: { cpus: 2 } }), UnsupportedError);
		assert.equal(f.calls.create.length, 0);
		// round 10 (same bug as Daytona): the platform's generic memory hint is NOT a request — creation proceeds without it
		await p.create({ ...baseCreate, defaultMemoryMb: 512 });
		assert.equal(f.calls.create.length, 1);
		assert.equal(JSON.stringify(f.calls.create[0]).includes("512"), false);
	});

	it("exec maps command/cwd/env/timeout and streams output; non-zero exit is status error, not a throw", async () => {
		const f = fakeE2b();
		f.behaviour.run = (_c, opts) => ({
			wait: async () => {
				(opts.onStdout as (s: string) => void)("hello ");
				(opts.onStdout as (s: string) => void)("world");
				(opts.onStderr as (s: string) => void)("warn");
				throw named("CommandExitError", "exit 3", { exitCode: 3 });
			},
		});
		const s = await createE2b({ provider: "e2b", apiKey: KEY }, { loadSdk: async () => f.mod }).create(baseCreate);
		const out: string[] = [];
		const r = await s.exec({ command: "make test", cwd: "/work", env: { X: "y" }, timeoutMs: 10_000, onStdout: (c) => out.push(c) });
		assert.deepEqual(r, { status: "error", exitCode: 3, stdout: "hello world", stderr: "warn" });
		assert.deepEqual(out, ["hello ", "world"]);
		const [cmd, opts] = f.calls.run[0]!;
		assert.equal(cmd, "make test");
		assert.equal(opts.cwd, "/work");
		assert.deepEqual(opts.envs, { X: "y" });
		assert.equal(opts.timeoutMs, 10_000);
		assert.equal(opts.background, true);
	});

	it("exec: remote TimeoutError -> status timeout and the remote process is killed", async () => {
		const f = fakeE2b();
		f.behaviour.run = (_c, opts) => ({ wait: async () => { (opts.onStdout as (s: string) => void)("partial"); throw named("TimeoutError", "deadline"); } });
		const s = await createE2b({ provider: "e2b", apiKey: KEY }, { loadSdk: async () => f.mod }).create(baseCreate);
		const r = await s.exec({ command: "sleep 99", cwd: "/work", timeoutMs: 1000 });
		assert.equal(r.status, "timeout");
		assert.equal(r.stdout, "partial");
		assert.equal(f.calls.killedHandles, 1);
	});

	it("exec: AbortSignal -> status killed and the remote process is killed (not merely abandoned)", async () => {
		const f = fakeE2b();
		f.behaviour.run = () => ({ wait: () => new Promise(() => {}) }); // never finishes
		const s = await createE2b({ provider: "e2b", apiKey: KEY }, { loadSdk: async () => f.mod }).create(baseCreate);
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 20);
		const r = await s.exec({ command: "sleep 99", cwd: "/work", timeoutMs: 60_000, signal: ac.signal });
		assert.equal(r.status, "killed");
		assert.equal(f.calls.killedHandles, 1);
		const pre = new AbortController();
		pre.abort();
		assert.equal((await s.exec({ command: "x", cwd: "/", timeoutMs: 1000, signal: pre.signal })).status, "killed");
		assert.equal(f.calls.run.length, 1, "an already-aborted signal must not start a command");
	});

	it("files: list reports symlinks as symlinks with relative paths; read honours maxBytes; remove is idempotent", async () => {
		const f = fakeE2b();
		f.behaviour.entries = [
			{ name: "a.txt", path: "/work/a.txt", type: "file", size: 5, modifiedTime: new Date(1000) },
			{ name: "d", path: "/work/d", type: "dir", size: 0 },
			{ name: "l", path: "/work/d/l", type: "symlink", size: 3, symlinkTarget: "/etc/passwd" },
			{ name: "b", path: "/work/d/b", type: "file", size: 1 },
		];
		const s = await createE2b({ provider: "e2b", apiKey: KEY }, { loadSdk: async () => f.mod }).create(baseCreate);
		const l = await s.list("/work/");
		assert.deepEqual(l.map((e) => [e.path, e.kind]), [["a.txt", "file"], ["d", "directory"], ["d/l", "symlink"], ["d/b", "file"]]);
		assert.equal(l[0]!.mtimeMs, 1000);
		f.behaviour.fileBytes = new Uint8Array(10);
		await assert.rejects(s.readFile("/work/a.txt", 5), /大小上限/);
		assert.equal((await s.readFile("/work/a.txt", 10)).byteLength, 10);
		await s.writeFile("/work/x", new Uint8Array([9]));
		await s.mkdir("/work/m");
		await s.remove("/work/x");
		assert.deepEqual(f.files.mkdirs, ["/work/m"]);
		await s.keepAlive(123_000);
		assert.deepEqual(f.files.timeouts, [123_000]);
	});

	it("connect: not found -> null; other errors propagate (scrubbed)", async () => {
		const f = fakeE2b();
		const p = createE2b({ provider: "e2b", apiKey: KEY }, { loadSdk: async () => f.mod });
		f.behaviour.connectError = named("SandboxNotFoundError", "nope");
		assert.equal(await p.connect("gone"), null);
		f.behaviour.connectError = named("AuthenticationError", `bad key ${KEY}`);
		await assert.rejects(p.connect("x"), (e: Error) => !e.message.includes(KEY) && /AuthenticationError/.test(e.name));
		f.behaviour.connectError = undefined;
		assert.equal((await p.connect("alive"))?.id, "alive");
	});

	it("list filters by metadata; destroy is idempotent", async () => {
		const f = fakeE2b();
		f.behaviour.listItems = [{ sandboxId: "s1", state: "running", metadata: { workroom: "1" }, startedAt: new Date("2026-01-01T00:00:00Z") }];
		const p = createE2b({ provider: "e2b", apiKey: KEY }, { loadSdk: async () => f.mod });
		const r = await p.list({ workroom: "1" });
		assert.deepEqual(f.calls.list[0]!.query, { metadata: { workroom: "1" } });
		assert.deepEqual(r, [{ id: "s1", state: "running", metadata: { workroom: "1" }, createdAt: "2026-01-01T00:00:00.000Z" }]);
		f.behaviour.killResult = false; // E2B: false = did not exist
		await p.destroy("missing");
		f.behaviour.killResult = named("SandboxNotFoundError", "x");
		await p.destroy("missing2");
		f.behaviour.killResult = named("RateLimitError", "429");
		await assert.rejects(p.destroy("s1"));
	});

	it("health: no key / auth failure / success; never contains the key", async () => {
		const f = fakeE2b();
		assert.deepEqual(await createE2b({ provider: "e2b" }, { loadSdk: async () => f.mod }).health(), { ok: false, detail: "未配置 API Key" });
		const bad = fakeE2b();
		bad.mod.Sandbox.list = () => ({ hasNext: true, nextItems: async () => { throw named("AuthenticationError", `401 invalid ${KEY}`); } });
		const h = await createE2b({ provider: "e2b", apiKey: KEY }, { loadSdk: async () => bad.mod }).health();
		assert.equal(h.ok, false);
		assert.ok(!h.detail.includes(KEY));
		assert.match(h.detail, /认证失败/);
		const boom = fakeE2b();
		boom.mod.Sandbox.list = () => ({ hasNext: true, nextItems: async () => { throw new Error(`ECONNREFUSED Authorization: Bearer ${KEY}`); } });
		const h2 = await createE2b({ provider: "e2b", apiKey: KEY }, { loadSdk: async () => boom.mod }).health();
		assert.ok(!h2.detail.includes(KEY));
		const ok = await createE2b({ provider: "e2b", apiKey: KEY }, { loadSdk: async () => f.mod }).health();
		assert.equal(ok.ok, true);
		assert.equal(f.calls.list[0]!.limit, 1);
	});

	it("errors from create never contain the credential", async () => {
		const f = fakeE2b();
		f.behaviour.createError = new Error(`request failed: headers {"X-API-KEY":"${KEY}"} Bearer ${KEY}`);
		const p = createE2b({ provider: "e2b", apiKey: KEY }, { loadSdk: async () => f.mod });
		await assert.rejects(p.create(baseCreate), (e: Error) => !e.message.includes(KEY) && e.message.includes("[已隐藏]"));
	});

	it("scrubSecrets covers literal keys and common credential shapes", () => {
		const t = scrubE2b(`k=${KEY} Authorization: Bearer abcdef123456 api_key=zzzz1234 x-api-key: "abcd1234"`, [KEY]);
		assert.ok(!/0123456789abcdef|abcdef123456|zzzz1234|abcd1234/.test(t), t);
	});
});

// ---------------------------------------------------------------------------------------------------------------------------
// fake daytona (TEST DOUBLE)
// ---------------------------------------------------------------------------------------------------------------------------
interface FakeDaytona {
	mod: DaytonaModule;
	ctor: Record<string, unknown>[];
	created: Record<string, unknown>[];
	createOptions: ({ timeout?: number } | undefined)[];
	listQueries: (Record<string, unknown> | undefined)[];
	deleted: string[];
	sessionsCreated: string[];
	sessionsDeleted: string[];
	commands: { sessionId: string; command: string; runAsync?: boolean }[];
	executed: { command: string; cwd?: string }[];
	uploads: [string, number][];
	b: {
		getError?: Error;
		deleteError?: Error;
		state?: string;
		sandboxes?: { id: string; state: string; labels: Record<string, string>; createdAt?: string }[];
		logs?: (onOut: (c: string) => void, onErr: (c: string) => void) => Promise<void>;
		exitCode?: number | undefined;
		findResult?: { exitCode: number; result: string };
		listError?: Error;
		createError?: Error;
		started: number;
	};
}
function fakeDaytona(): FakeDaytona {
	const f: FakeDaytona = { ctor: [], created: [], createOptions: [], listQueries: [], deleted: [], sessionsCreated: [], sessionsDeleted: [], commands: [], executed: [], uploads: [], b: { started: 0 }, mod: undefined as unknown as DaytonaModule };
	const sandbox = (id: string) => ({
		id,
		state: f.b.state ?? "started",
		process: {
			async createSession(sid: string) { f.sessionsCreated.push(sid); },
			async executeSessionCommand(sid: string, req: { command: string; runAsync?: boolean }) { f.commands.push({ sessionId: sid, ...req }); return { cmdId: "cmd-1" }; },
			async getSessionCommand() { return { exitCode: "exitCode" in f.b ? f.b.exitCode : 0 }; },
			async getSessionCommandLogs(_s: string, _c: string, o: (c: string) => void, e: (c: string) => void) { await (f.b.logs ?? (async () => {}))(o, e); },
			async deleteSession(sid: string) { f.sessionsDeleted.push(sid); },
			async executeCommand(command: string, cwd?: string) { f.executed.push({ command, ...(cwd ? { cwd } : {}) }); return f.b.findResult ?? { exitCode: 0, result: "" }; },
		},
		fs: {
			async uploadFile(buf: Buffer, p: string) { f.uploads.push([p, buf.byteLength]); },
			async downloadFile() { return Buffer.from("abc"); },
			async deleteFile() {},
			async createFolder() {},
		},
		async start() { f.b.started++; },
		async refreshActivity() {},
		async setAutostopInterval() {},
	});
	f.mod = {
		Daytona: class {
			constructor(cfg: Record<string, unknown>) { f.ctor.push(cfg); }
			async create(p: Record<string, unknown>, o?: { timeout?: number }) { f.created.push(p); f.createOptions.push(o); if (f.b.createError) throw f.b.createError; return sandbox("dt-1"); }
			async get(id: string) { if (f.b.getError) throw f.b.getError; return sandbox(id); }
			list(q?: Record<string, unknown>) {
				f.listQueries.push(q);
				const err = f.b.listError;
				const items = f.b.sandboxes ?? [];
				return (async function* () { if (err) throw err; for (const i of items) yield { ...sandbox(i.id), state: i.state, labels: i.labels, createdAt: i.createdAt }; })();
			}
			async delete(sb: { id: string }) { if (f.b.deleteError) throw f.b.deleteError; f.deleted.push(sb.id); }
		} as unknown as DaytonaModule["Daytona"],
	};
	return f;
}

describe("daytona adapter (SDK test double)", () => {
	it("capabilities are honest and Daytona is vendor-cloud", () => {
		const p = createDaytona({ provider: "daytona", apiKey: DKEY }, { loadSdk: async () => fakeDaytona().mod });
		for (const [k, v] of Object.entries(p.capabilities)) assert.notEqual(v, "supported", `${k}`);
		assert.equal(p.capabilities.location, "vendor_cloud");
		for (const k of ["services", "pty", "preview", "snapshot", "pauseResume"] as const) assert.equal(p.capabilities[k], "unsupported");
		assert.equal(p.capabilities.resourceLimits, "unverified", "round 10: image mode takes CPU/memory/disk (not verified live)");
	});

	it("without a configured endpoint the official API URL is passed explicitly (host DAYTONA_API_URL never redirects the key)", async () => {
		const f = fakeDaytona();
		const prev = process.env.DAYTONA_API_URL;
		process.env.DAYTONA_API_URL = "https://attacker.example/api";
		try {
			await createDaytona({ provider: "daytona", apiKey: DKEY }, { loadSdk: async () => f.mod }).create(baseCreate);
		} finally {
			if (prev === undefined) delete process.env.DAYTONA_API_URL;
			else process.env.DAYTONA_API_URL = prev;
		}
		assert.deepEqual(f.ctor[0], { apiKey: DKEY, apiUrl: "https://app.daytona.io/api" });
	});

	it("constructs the client from explicit config only (key, endpoint, target)", async () => {
		const f = fakeDaytona();
		await createDaytona({ provider: "daytona", apiKey: DKEY, endpoint: "https://daytona.example/api", options: { target: "eu" } }, { loadSdk: async () => f.mod }).create(baseCreate);
		assert.deepEqual(f.ctor[0], { apiKey: DKEY, apiUrl: "https://daytona.example/api", target: "eu" });
	});

	it("create maps labels/env/snapshot/lifetime/timeout; round 9: never sets networkBlockAll or any network option (Daytona organisation defaults apply)", async () => {
		const f = fakeDaytona();
		const p = createDaytona({ provider: "daytona", apiKey: DKEY, template: "snap-default" }, { loadSdk: async () => f.mod });
		await p.create({ ...baseCreate, env: { A: "1" } });
		const c = f.created[0]!;
		assert.deepEqual(c.labels, baseCreate.metadata);
		assert.deepEqual(c.envVars, { A: "1" });
		assert.equal(c.snapshot, "snap-default");
		assert.equal(c.ttlMinutes, 240);
		assert.equal(c.autoStopInterval, 240);
		assert.equal("networkBlockAll" in c, false);
		assert.equal(f.createOptions[0]!.timeout, 90);
		await p.create({ ...baseCreate, network: false, template: "snap-x" } as never);
		assert.equal("networkBlockAll" in f.created[1]!, false);
		assert.deepEqual(noNetworkOptions(f.created[1]!), []);
		assert.equal(f.created[1]!.snapshot, "snap-x");
	});

	it("round 10 (reported bug): the platform's generic memory limit is only a hint — default/snapshot creation succeeds and sends no resources", async () => {
		const f = fakeDaytona();
		const p = createDaytona({ provider: "daytona", apiKey: DKEY, template: "snap-x" }, { loadSdk: async () => f.mod });
		await p.create({ ...baseCreate, defaultMemoryMb: 512 });
		await createDaytona({ provider: "daytona", apiKey: DKEY }, { loadSdk: async () => f.mod }).create({ ...baseCreate, defaultMemoryMb: 512 });
		assert.equal(f.created.length, 2);
		for (const c of f.created) {
			assert.equal("resources" in c, false, "no resources in snapshot/default mode");
			assert.equal("image" in c, false);
		}
		assert.equal(f.created[0]!.snapshot, "snap-x");
		assert.equal("snapshot" in f.created[1]!, false, "no snapshot configured → Daytona default");
	});

	it("round 10: explicit resources are sent only in image mode (cpu cores, memory/disk GiB); explicit resources without an image are refused, never ignored", async () => {
		const f = fakeDaytona();
		await createDaytona({ provider: "daytona", apiKey: DKEY, image: "python:3.12-slim", resources: { cpus: 2, memoryGb: 4, diskGb: 10 } }, { loadSdk: async () => f.mod }).create({ ...baseCreate, defaultMemoryMb: 512 });
		assert.equal(f.created[0]!.image, "python:3.12-slim");
		assert.deepEqual(f.created[0]!.resources, { cpu: 2, memory: 4, disk: 10 });
		assert.equal("snapshot" in f.created[0]!, false);
		await createDaytona({ provider: "daytona", apiKey: DKEY, image: "python:3.12-slim" }, { loadSdk: async () => f.mod }).create(baseCreate);
		assert.equal("resources" in f.created[1]!, false, "image without explicit resources → Daytona default size");
		await assert.rejects(createDaytona({ provider: "daytona", apiKey: DKEY, resources: { cpus: 2 } }, { loadSdk: async () => f.mod }).create(baseCreate), (e: any) => e instanceof UnsupportedError && /镜像/.test(e.message));
		await assert.rejects(createDaytona({ provider: "daytona", apiKey: DKEY }, { loadSdk: async () => f.mod }).create({ ...baseCreate, resources: { memoryGb: 2 } }), UnsupportedError);
		assert.equal(f.created.length, 2, "the refused creates never reached the SDK");
	});

	it("buildShellLine quotes cwd/env/command and rejects bad env names", () => {
		const l = buildShellLine("echo \"$A\" && echo 'x'", "/work/it's", { A: "va'l ue" });
		assert.equal(l, `env 'A=va'\\''l ue' /bin/sh -c 'cd '\\''/work/it'\\''\\'\\'''\\''s'\\'' && echo "$A" && echo '\\''x'\\'''`);
		assert.throws(() => buildShellLine("true", "/", { "A B": "1" }), /环境变量名/);
		assert.equal(buildShellLine("true", "/w"), `/bin/sh -c 'cd '\\''/w'\\'' && true'`);
	});

	it("exec runs an async session command with cwd/env in the line, streams, reads the exit code and always deletes the session", async () => {
		const f = fakeDaytona();
		f.b.logs = async (o, e) => { o("out1"); e("err1"); o("out2"); };
		f.b.exitCode = 0;
		const s = await createDaytona({ provider: "daytona", apiKey: DKEY }, { loadSdk: async () => f.mod }).create(baseCreate);
		const got: string[] = [];
		const r = await s.exec({ command: "ls", cwd: "/work", env: { K: "v" }, timeoutMs: 5000, onStdout: (c) => got.push(c) });
		assert.deepEqual(r, { status: "ok", exitCode: 0, stdout: "out1out2", stderr: "err1" });
		assert.deepEqual(got, ["out1", "out2"]);
		assert.equal(f.commands[0]!.runAsync, true);
		assert.match(f.commands[0]!.command, /^env 'K=v' \/bin\/sh -c 'cd /);
		assert.deepEqual(f.sessionsDeleted, f.sessionsCreated);
		f.b.exitCode = 7;
		assert.equal((await s.exec({ command: "false", cwd: "/", timeoutMs: 5000 })).status, "error");
	});

	it("exec: client deadline -> status timeout + session deleted (remote kill); abort -> killed", async () => {
		const f = fakeDaytona();
		f.b.logs = () => new Promise(() => {}); // hangs
		const s = await createDaytona({ provider: "daytona", apiKey: DKEY }, { loadSdk: async () => f.mod }).create(baseCreate);
		const r = await s.exec({ command: "sleep 99", cwd: "/", timeoutMs: 30 });
		assert.equal(r.status, "timeout");
		assert.equal(f.sessionsDeleted.length, 1);
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 20);
		const r2 = await s.exec({ command: "sleep 99", cwd: "/", timeoutMs: 60_000, signal: ac.signal });
		assert.equal(r2.status, "killed");
		assert.equal(f.sessionsDeleted.length, 2);
		const pre = new AbortController();
		pre.abort();
		assert.equal((await s.exec({ command: "x", cwd: "/", timeoutMs: 1000, signal: pre.signal })).status, "killed");
		assert.equal(f.sessionsCreated.length, 2, "pre-aborted signal must not create a session");
	});

	it("exec errors are scrubbed", async () => {
		const f = fakeDaytona();
		f.b.logs = async () => { throw new Error(`stream failed Bearer ${DKEY}`); };
		const s = await createDaytona({ provider: "daytona", apiKey: DKEY }, { loadSdk: async () => f.mod }).create(baseCreate);
		await assert.rejects(s.exec({ command: "x", cwd: "/", timeoutMs: 1000 }), (e: Error) => !e.message.includes(DKEY));
		assert.equal(f.sessionsDeleted.length, 1);
	});

	it("list reports symlinks via find (lstat), skips junk records, relative paths", async () => {
		const f = fakeDaytona();
		f.b.findResult = { exitCode: 0, result: "f\t5\t1700000000.5\ta.txt\x1ed\t4096\t1700000001.0\tsub\x1el\t3\t1700000002.0\tsub/link\x1e\x1ep\t0\t1.0\tfifo\x1e" };
		const s = await createDaytona({ provider: "daytona", apiKey: DKEY }, { loadSdk: async () => f.mod }).create(baseCreate);
		const l = await s.list("/work");
		assert.deepEqual(l.map((e) => [e.path, e.kind, e.size]), [["a.txt", "file", 5], ["sub", "directory", 4096], ["sub/link", "symlink", 3], ["fifo", "other", 0]]);
		assert.equal(l[0]!.mtimeMs, 1700000000500);
		assert.match(f.executed[0]!.command, /^find '\/work' -mindepth 1 -printf /);
		f.b.findResult = { exitCode: 1, result: "find: unknown predicate" };
		await assert.rejects(s.list("/work"), /列目录失败/);
	});

	it("connect: not found/destroyed -> null; stopped is started; alive returns a session", async () => {
		const f = fakeDaytona();
		const p = createDaytona({ provider: "daytona", apiKey: DKEY }, { loadSdk: async () => f.mod });
		f.b.getError = named("DaytonaNotFoundError", "Sandbox not found", { statusCode: 404 });
		assert.equal(await p.connect("gone"), null);
		f.b.getError = named("DaytonaAuthenticationError", `no ${DKEY}`, { statusCode: 401 });
		await assert.rejects(p.connect("x"), (e: Error) => !e.message.includes(DKEY));
		f.b.getError = undefined;
		f.b.state = "destroyed";
		assert.equal(await p.connect("d"), null);
		f.b.state = "stopped";
		assert.equal((await p.connect("st"))?.id, "st");
		assert.equal(f.b.started, 1);
		f.b.state = "started";
		assert.equal((await p.connect("ok"))?.id, "ok");
		assert.equal(f.b.started, 1);
	});

	it("list filters by labels; destroy is idempotent", async () => {
		const f = fakeDaytona();
		f.b.sandboxes = [{ id: "a", state: "started", labels: { workroom: "1" }, createdAt: "2026-02-02T00:00:00Z" }];
		const p = createDaytona({ provider: "daytona", apiKey: DKEY }, { loadSdk: async () => f.mod });
		assert.deepEqual(await p.list({ workroom: "1" }), [{ id: "a", state: "started", metadata: { workroom: "1" }, createdAt: "2026-02-02T00:00:00Z" }]);
		assert.deepEqual(f.listQueries[0], { labels: { workroom: "1" } });
		await p.destroy("a");
		assert.deepEqual(f.deleted, ["a"]);
		f.b.getError = named("DaytonaNotFoundError", "nf", { statusCode: 404 });
		await p.destroy("again");
		f.b.getError = undefined;
		f.b.deleteError = named("DaytonaNotFoundError", "nf", { statusCode: 404 });
		await p.destroy("raced");
		f.b.deleteError = named("DaytonaInternalServerError", "boom", { statusCode: 500 });
		await assert.rejects(p.destroy("a"));
	});

	it("files map to the SDK; health is a limit-1 list and never leaks the key", async () => {
		const f = fakeDaytona();
		const p = createDaytona({ provider: "daytona", apiKey: DKEY }, { loadSdk: async () => f.mod });
		const s = await p.create(baseCreate);
		await s.writeFile("/work/a", new Uint8Array([1, 2]));
		assert.deepEqual(f.uploads, [["/work/a", 2]]);
		await assert.rejects(s.readFile("/work/a", 2), /大小上限/);
		assert.equal((await s.readFile("/work/a", 3)).byteLength, 3);
		assert.deepEqual(await createDaytona({ provider: "daytona" }, { loadSdk: async () => f.mod }).health(), { ok: false, detail: "未配置 API Key" });
		const h = await p.health();
		assert.equal(h.ok, true);
		assert.equal(f.listQueries.at(-1)!.limit, 1);
		f.b.listError = named("DaytonaAuthenticationError", `401 ${DKEY}`, { statusCode: 401 });
		const bad = await createDaytona({ provider: "daytona", apiKey: DKEY }, { loadSdk: async () => f.mod }).health();
		assert.equal(bad.ok, false);
		assert.ok(!bad.detail.includes(DKEY));
		f.b.listError = new Error(`getaddrinfo ENOTFOUND; token=${DKEY}`);
		const down = await createDaytona({ provider: "daytona", apiKey: DKEY }, { loadSdk: async () => f.mod }).health();
		assert.ok(!down.detail.includes(DKEY));
	});
});

// ---------------------------------------------------------------------------------------------------------------------------
// Missing SDK: run in a child process whose module resolution refuses e2b / @daytonaio/sdk, whether or not they are installed here.
// ---------------------------------------------------------------------------------------------------------------------------
describe("opensandbox adapter (SDK test double)", () => {
	function fakeOpenSandbox() {
		const created: Record<string, unknown>[] = [];
		const sb = { id: "osb-1", commands: { run: async () => ({ logs: { stdout: [], stderr: [] } }), interrupt: async () => {} }, files: {}, getInfo: async () => ({ status: { state: "Running" } }), renew: async () => ({}), close: async () => {} };
		const mod = {
			ConnectionConfig: class {
				constructor(_o: Record<string, unknown>) {}
			},
			Sandbox: { create: async (o: Record<string, unknown>) => (created.push(o), sb), connect: async () => sb },
			SandboxManager: { create: () => ({ listSandboxInfos: async () => ({ items: [] }), killSandbox: async () => {}, close: async () => {} }) },
		};
		return { created, mod };
	}

	it("round 9: create sends NO networkPolicy / egress option (server defaults apply); a stale caller's `network` flag is not forwarded", async () => {
		const f = fakeOpenSandbox();
		setOpenSandboxSdkLoaderForTests(async () => f.mod as never);
		try {
			const p = createOpenSandbox({ provider: "opensandbox", apiKey: "sk-os-0123456789abcdef", endpoint: "http://127.0.0.1:8080" } as never);
			await p.create({ ...baseCreate, defaultMemoryMb: 512 });
			await p.create({ ...baseCreate, network: false } as never);
			assert.equal(f.created.length, 2);
			for (const c of f.created) {
				assert.deepEqual(noNetworkOptions(c), [], "no network-related create option at all");
				assert.equal("networkPolicy" in c, false);
			}
			assert.deepEqual(f.created[0]!.resource, { memory: "512Mi" });
		} finally {
			setOpenSandboxSdkLoaderForTests(null);
		}
	});

	it("round 9: capability bits: networkOff is not something Workroom relies on (never 'supported' by assumption); networkOn matches the earlier live verification", async () => {
		const p = createOpenSandbox({ provider: "opensandbox", apiKey: "sk-os-0123456789abcdef", endpoint: "http://127.0.0.1:8080" } as never);
		assert.notEqual(p.capabilities.networkOff, "supported");
		assert.equal(p.capabilities.networkOn, "supported");
	});
});

describe("missing optional SDK", () => {
	it("create throws UnsupportedError and health reports it, for both providers; nothing throws at import time", () => {
		const dir = mkdtempSync(join(tmpdir(), "wr-nosdk-"));
		try {
			const hooks = join(dir, "hooks.mjs");
			writeFileSync(hooks, `export async function resolve(spec, ctx, next) {
  if (spec === "e2b" || spec === "@daytonaio/sdk") { const e = new Error("Cannot find package '" + spec + "'"); e.code = "ERR_MODULE_NOT_FOUND"; throw e; }
  return next(spec, ctx);
}\n`);
			const reg = join(dir, "register.mjs");
			writeFileSync(reg, `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`);
			const script = join(dir, "run.mts");
			const root = pathToFileURL(join(import.meta.dirname, "..", "src", "tools", "sandbox")).href;
			writeFileSync(script, `
import { UnsupportedError } from "${root}/provider.ts";
import { createProvider as e2b } from "${root}/providers/e2b.ts";
import { createProvider as dt } from "${root}/providers/daytona.ts";
const out: Record<string, unknown> = {};
for (const [name, make] of [["e2b", e2b], ["daytona", dt]] as const) {
  const p = make({ provider: name, apiKey: "k-secret-123456" } as never);
  const h = await p.health();
  let err: unknown;
  try { await p.create({ metadata: {}, lifetimeMs: 60000, createTimeoutMs: 1000 }); } catch (e) { err = e; }
  out[name] = { healthOk: h.ok, healthDetail: h.detail, unsupported: err instanceof UnsupportedError, status: (err as { status?: number })?.status };
}
console.log(JSON.stringify(out));
`);
			const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", pathToFileURL(reg).href, script], { encoding: "utf8", timeout: 60_000 });
			assert.equal(r.status, 0, r.stderr);
			const out = JSON.parse(r.stdout.trim().split("\n").at(-1)!) as Record<string, { healthOk: boolean; healthDetail: string; unsupported: boolean; status: number }>;
			for (const k of ["e2b", "daytona"]) {
				assert.equal(out[k]!.healthOk, false);
				assert.match(out[k]!.healthDetail, /未安装 SDK/);
				assert.equal(out[k]!.unsupported, true);
				assert.equal(out[k]!.status, 501);
				assert.ok(!out[k]!.healthDetail.includes("k-secret-123456"));
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------------------------------------------------------
// LIVE: real services. Skipped (with the reason printed) unless the keys are provided. NOT CONNECTED in the authoring environment.
// ---------------------------------------------------------------------------------------------------------------------------
async function liveRoundtrip(p: ReturnType<typeof createE2b>, root: string): Promise<void> {
	const h = await p.health();
	assert.equal(h.ok, true, h.detail);
	const meta = { workroom: "1", "wr-test": `live-${Date.now()}` };
	const s = await p.create({ metadata: meta, lifetimeMs: 10 * 60_000, createTimeoutMs: 120_000 });
	try {
		await s.mkdir(`${root}/sub`);
		await s.writeFile(`${root}/sub/a.txt`, new TextEncoder().encode("hello"));
		assert.equal(new TextDecoder().decode(await s.readFile(`${root}/sub/a.txt`, 100)), "hello");
		const chunks: string[] = [];
		const r = await s.exec({ command: "echo $FOO; pwd; ln -s /etc/hostname link; echo err 1>&2; exit 3", cwd: root, env: { FOO: "bar" }, timeoutMs: 30_000, onStdout: (c) => chunks.push(c) });
		assert.equal(r.exitCode, 3);
		assert.match(r.stdout, /bar/);
		assert.match(r.stdout, new RegExp(root));
		assert.match(r.stderr, /err/);
		const l = await s.list(root);
		assert.equal(l.find((e) => e.path === "link")?.kind, "symlink", "symlinks must be reported, not followed");
		assert.ok(l.some((e) => e.path === "sub/a.txt" && e.kind === "file"));
		const t0 = Date.now();
		const to = await s.exec({ command: "sleep 60", cwd: root, timeoutMs: 3000 });
		assert.equal(to.status, "timeout");
		assert.ok(Date.now() - t0 < 20_000);
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 1500);
		assert.equal((await s.exec({ command: "sleep 60", cwd: root, timeoutMs: 60_000, signal: ac.signal })).status, "killed");
		// Round 9: informational only. Workroom does not ask for or against network; what the vendor's defaults give is reported, never asserted.
		const net = await s.exec({ command: "curl -sS -m 5 -o /dev/null -w %{http_code} https://example.com; echo rc=$?", cwd: root, timeoutMs: 20_000 });
		console.log(`[live ${p.id}] outbound https://example.com from the sandbox: ${net.stdout.trim()} ${net.stderr.trim().slice(0, 120)}`);
		const found = await p.list(meta);
		assert.ok(found.some((x) => x.id === s.id));
		assert.equal((await p.connect(s.id))?.id, s.id);
	} finally {
		await p.destroy(s.id);
	}
	await p.destroy(s.id); // idempotent
	assert.equal(await p.connect(s.id), null);
}

const e2bKey = process.env.WORKROOM_TEST_E2B_API_KEY;
const daytonaKey = process.env.WORKROOM_TEST_DAYTONA_API_KEY;

describe("LIVE e2b (real service)", { skip: e2bKey ? false : "WORKROOM_TEST_E2B_API_KEY is not set — live E2B path implemented but not connected" }, () => {
	it("full roundtrip: health, create(vendor defaults), files, exec, symlink listing, timeout/abort kill, list, connect, destroy", { timeout: 300_000 }, async () => {
		const p = createE2b({
			provider: "e2b",
			apiKey: e2bKey!,
			...(process.env.WORKROOM_TEST_E2B_ENDPOINT ? { endpoint: process.env.WORKROOM_TEST_E2B_ENDPOINT } : {}),
			...(process.env.WORKROOM_TEST_E2B_DOMAIN ? { domain: process.env.WORKROOM_TEST_E2B_DOMAIN } : {}),
		});
		await liveRoundtrip(p, "/tmp/wr-live");
	});
});

describe("LIVE daytona (real service)", { skip: daytonaKey ? false : "WORKROOM_TEST_DAYTONA_API_KEY is not set — live Daytona path implemented but not connected" }, () => {
	it("full roundtrip: health, create(vendor defaults), files, exec, symlink listing, timeout/abort kill, list, connect, destroy", { timeout: 300_000 }, async () => {
		const p = createDaytona({
			provider: "daytona",
			apiKey: daytonaKey!,
			...(process.env.WORKROOM_TEST_DAYTONA_ENDPOINT ? { endpoint: process.env.WORKROOM_TEST_DAYTONA_ENDPOINT } : {}),
		});
		await liveRoundtrip(p, "/tmp/wr-live");
	});
});
