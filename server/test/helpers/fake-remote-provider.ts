// TEST DOUBLE — NOT A PROVIDER. An in-memory RemoteProvider used ONLY by sandbox-remote-driver.test.ts to unit-test RemoteDriver's
// own logic (instance table, manifest, path/size/symlink rules, mount verification, reaping). It interprets exactly the helper shell
// commands RemoteDriver emits plus a tiny "program" language for the user code. It proves nothing about any real provider: real
// acceptance is server/test/sandbox-contract.test.ts against a live service.
import { createHash } from "node:crypto";
import type { CreateOptions, ExecOptions, ExecResult, PauseOptions, ProviderCapabilities, RemoteEntry, RemoteProvider, RemoteSandboxInfo, RemoteSession } from "../../src/tools/sandbox/provider.ts";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
type Ent = { kind: "file"; bytes: Uint8Array; mode: number } | { kind: "symlink"; target: string } | { kind: "other" };

export class FakeBox {
	files = new Map<string, Ent>();
	dirs = new Set<string>(["/", "/work", "/tmp"]);
	/** Directories made read-only by `chmod -R a-w` (the fake models "unprivileged user cannot write"). */
	ro = new Set<string>();
	/**
	 * Round 10: models an unprivileged workload user that is NOT root (Daytona): it may only create directories / write files below these prefixes
	 * (creating "/work" fails with "Permission denied"). undefined = root-like (everything allowed).
	 */
	writable: string[] | undefined;
	user = "root";
	/** cwd and env of the last user program (round 10: tests assert the working directory and WORKROOM_WORKDIR). */
	lastRun: { cwd: string; env: Readonly<Record<string, string>> } | undefined;
	running = 0;
	maxRunning = 0;
	writes: string[] = [];
	execLog: string[] = [];
	alive = true;
	/** Round 11: paused / archived (the fake models a provider that keeps the filesystem; exec on a paused box fails). */
	paused = false;
	archived = false;
	readonly id: string;
	readonly metadata: Record<string, string>;
	/** Every option the adapter layer passed to create() (round 9: tests assert it carries no network deny/allow option). */
	readonly createOptions: Readonly<Record<string, unknown>>;
	readonly createdAt: string;
	constructor(id: string, metadata: Record<string, string>, createOptions: Readonly<Record<string, unknown>> = {}, createdAt = new Date().toISOString()) {
		this.id = id;
		this.metadata = metadata;
		this.createOptions = createOptions;
		this.createdAt = createdAt;
	}
	canCreate(path: string): boolean {
		return !this.writable || this.writable.some((w) => path === w || path.startsWith(`${w}/`));
	}
	put(path: string, text: string | Uint8Array) {
		this.files.set(path, { kind: "file", bytes: typeof text === "string" ? Buffer.from(text) : text, mode: 0o644 });
		let d = path.slice(0, path.lastIndexOf("/"));
		while (d) (this.dirs.add(d), (d = d.slice(0, d.lastIndexOf("/"))));
	}
	text(path: string): string | undefined {
		const e = this.files.get(path);
		return e?.kind === "file" ? Buffer.from(e.bytes).toString() : undefined;
	}
	under(dir: string) {
		return [...this.files.keys()].filter((p) => p.startsWith(`${dir}/`));
	}
}

export const FAKE_CAPS: ProviderCapabilities = {
	exec: "unverified", streamOutput: "unverified", cancel: "unverified", commandTimeout: "unverified", files: "unverified", networkOff: "unverified", networkOn: "unverified", // round 9: network capability bits are informational only, Workroom never refuses on them
	resourceLimits: "unverified", reconnect: "unverified", services: "unsupported", pty: "unsupported", preview: "unsupported", snapshot: "unsupported", pauseResume: "unsupported",
	skills: "upload_readonly", isolation: "in-memory test double", location: "self_hosted",
};

/** Round 11 options: which optional lifecycle methods the fake offers (the default fake is a provider WITHOUT pause: "recreate" mode). */
export interface FakeLifecycleOptions {
	pause?: boolean;
	archive?: boolean;
}

export class FakeRemoteProvider implements RemoteProvider {
	readonly id = "opensandbox" as const;
	readonly label = "Fake (test double)";
	capabilities = FAKE_CAPS;
	boxes = new Map<string, FakeBox>();
	created = 0;
	destroyedIds: string[] = [];
	failCreate: Error | undefined;
	/** Skip the read-only enforcement (models a single-user provider). */
	singleUser = false;
	/** Round 10: new sandboxes get a non-root user that can only write below `writable` (e.g. ["/home/daytona", "/tmp"]); "/work" does not exist and cannot be created. */
	nonRoot: { user: string; writable: string[] } | undefined;
	#n = 0;
	// ---- round 11: lifecycle test controls ----
	pauseCalls: { id: string; retainMs: number }[] = [];
	resumeCalls: string[] = [];
	archiveCalls: string[] = [];
	keepAliveCalls: { id: string; ms: number }[] = [];
	failPause: Error | undefined;
	failResume: Error | undefined;
	/** Called inside create/pause/resume/archive: tests advance an injected clock here to get non-zero durations. */
	hooks: { create?: () => void; pause?: () => void; resume?: () => void; archive?: () => void } = {};
	/** Present only when constructed with { pause: true } (a provider that can pause); absent = "recreate" mode. */
	pause?: (id: string, o: PauseOptions) => Promise<void>;
	resume?: (id: string, signal?: AbortSignal) => Promise<RemoteSession | null>;
	archive?: (id: string) => Promise<void>;

	constructor(life: FakeLifecycleOptions = {}) {
		if (life.pause) {
			this.capabilities = { ...FAKE_CAPS, pauseResume: "unverified" };
			this.pause = async (id, o) => {
				if (this.failPause) throw this.failPause;
				const b = this.boxes.get(id);
				if (!b?.alive) throw new Error("sandbox gone");
				this.pauseCalls.push({ id, retainMs: o.retainMs });
				this.hooks.pause?.();
				b.paused = true;
			};
			this.resume = async (id) => {
				this.resumeCalls.push(id);
				this.hooks.resume?.();
				if (this.failResume) throw this.failResume;
				const b = this.boxes.get(id);
				if (!b?.alive) return null;
				b.paused = false;
				b.archived = false;
				return this.#session(b);
			};
			if (life.archive) {
				this.archive = async (id) => {
					const b = this.boxes.get(id);
					if (!b?.alive || !b.paused) throw new Error("only a paused sandbox can be archived");
					this.archiveCalls.push(id);
					this.hooks.archive?.();
					b.archived = true;
				};
			}
		}
	}

	async health() {
		return { ok: true, detail: "fake ok" };
	}
	async create(o: CreateOptions): Promise<RemoteSession> {
		this.hooks.create?.();
		if (this.failCreate) throw this.failCreate;
		const id = `fake-${++this.#n}`;
		const box = new FakeBox(id, { ...o.metadata }, { ...o });
		if (this.nonRoot) {
			box.user = this.nonRoot.user;
			box.writable = [...this.nonRoot.writable];
			box.dirs = new Set(["/", "/tmp", "/home", ...this.nonRoot.writable.filter((w) => w.startsWith("/home/"))]);
		}
		this.boxes.set(id, box);
		this.created++;
		return this.#session(box);
	}
	async connect(id: string): Promise<RemoteSession | null> {
		const b = this.boxes.get(id);
		return b?.alive && !b.paused ? this.#session(b) : null;
	}
	async list(metadata: Readonly<Record<string, string>>): Promise<RemoteSandboxInfo[]> {
		return [...this.boxes.values()].filter((b) => b.alive && Object.entries(metadata).every(([k, v]) => b.metadata[k] === v)).map((b) => ({ id: b.id, state: "Running", metadata: b.metadata, createdAt: b.createdAt }));
	}
	async destroy(id: string): Promise<void> {
		const b = this.boxes.get(id);
		if (b) b.alive = false;
		this.destroyedIds.push(id);
	}
	/** Simulate an external deletion (expiry / admin). */
	kill(id: string) {
		this.boxes.get(id)!.alive = false;
	}

	#session(box: FakeBox): RemoteSession {
		const self = this;
		return {
			id: box.id,
			async exec(o) {
				return self.#exec(box, o);
			},
			async writeFile(path, bytes) {
				if (!box.alive) throw new Error("sandbox gone");
				if (self.#blocked(box, path) || !box.canCreate(path)) throw new Error("permission denied");
				box.writes.push(path);
				box.put(path, bytes);
			},
			async readFile(path, max) {
				const e = box.files.get(path);
				if (e?.kind !== "file") throw new Error(`not a file: ${path}`);
				if (e.bytes.length > max) throw new Error("too large");
				return e.bytes;
			},
			async list(dir) {
				const out: RemoteEntry[] = [];
				for (const d of box.dirs) if (d.startsWith(`${dir}/`)) out.push({ path: d.slice(dir.length + 1), kind: "directory", size: 0 });
				for (const [p, e] of box.files) if (p.startsWith(`${dir}/`)) out.push({ path: p.slice(dir.length + 1), kind: e.kind === "file" ? "file" : e.kind === "symlink" ? "symlink" : "other", size: e.kind === "file" ? e.bytes.length : 0 });
				return out;
			},
			async remove(path) {
				self.#rm(box, path);
			},
			async mkdir(path) {
				if (!box.canCreate(path)) throw new Error("permission denied");
				box.dirs.add(path);
			},
			async keepAlive(ms) {
				self.keepAliveCalls.push({ id: box.id, ms });
			},
		};
	}
	#blocked(box: FakeBox, path: string) {
		return !this.singleUser && [...box.ro].some((d) => path === d || path.startsWith(`${d}/`));
	}
	#rm(box: FakeBox, path: string) {
		for (const k of [...box.files.keys()]) if (k === path || k.startsWith(`${path}/`)) box.files.delete(k);
		for (const d of [...box.dirs]) if (d === path || d.startsWith(`${path}/`)) box.dirs.delete(d);
		for (const d of [...box.ro]) if (d === path || d.startsWith(`${path}/`)) box.ro.delete(d);
	}
	#treeHash(box: FakeBox, dir: string, skipMarker: boolean) {
		const lines = box.under(dir).filter((p) => box.files.get(p)!.kind === "file" && !(skipMarker && p.endsWith("/.workroom-sha256"))).map((p) => ({ rel: p.slice(dir.length + 1), sha: sha((box.files.get(p) as any).bytes) })).sort((a, b) => Buffer.compare(Buffer.from(a.rel), Buffer.from(b.rel))).map((e) => `${e.sha}  ./${e.rel}\n`);
		return sha(lines.join(""));
	}

	#unro(box: FakeBox, path: string): void {
		for (const d of [...box.ro]) if (d === path || d.startsWith(`${path}/`)) box.ro.delete(d);
	}
	async #exec(box: FakeBox, o: ExecOptions): Promise<ExecResult> {
		if (!box.alive) throw new Error("sandbox gone");
		if (box.paused) throw new Error("sandbox is paused");
		box.execLog.push(`${o.privileged ? "#" : "$"} ${o.command}`);
		const ok = (stdout = ""): ExecResult => ({ status: "ok", exitCode: 0, stdout, stderr: "" });
		const c = o.command;
		const q = (s: string) => s.replace(/^'|'$/g, "").replace(/'\\''/g, "'");
		let m: RegExpExecArray | null;
		if (c === "true") return ok();
		if ((m = /^mkdir -p '([^']+)' && chmod a\+rwx '[^']+'$/.exec(c))) {
			if (!box.canCreate(m[1]!)) return { status: "error", exitCode: 1, stdout: "", stderr: `mkdir: cannot create directory '${m[1]}': Permission denied` };
			let d = m[1]!;
			while (d) (box.dirs.add(d), (d = d.slice(0, d.lastIndexOf("/"))));
			return ok();
		}
		if ((m = /^test -d '([^']+)' && test -w '[^']+' && test -x '[^']+'$/.exec(c))) return box.dirs.has(m[1]!) && box.canCreate(`${m[1]}/x`) ? ok() : { status: "error", exitCode: 1, stdout: "", stderr: "" };
		if (c === "id -un 2>/dev/null || whoami") return ok(`${box.user}\n`);
		if (/^chmod -R a\+rwX /.test(c)) return ok();
		if ((m = /^rm -rf -- (.+)$/.exec(c))) {
			for (const a of m[1]!.match(/'(?:[^']|'\\'')*'/g) ?? []) this.#rm(box, q(a));
			return ok();
		}
		if ((m = /^cd '([^']+)' && find \. -type f -exec sha256sum \{\} \+ > '([^']+)' 2>\/dev\/null; true$/.exec(c))) {
			const W = m[1]!;
			const lines = box.under(W).filter((p) => box.files.get(p)!.kind === "file").map((p) => `${sha((box.files.get(p) as any).bytes)}  .${p.slice(W.length)}`);
			box.put(m[2]!, `${lines.join("\n")}\n`);
			return ok();
		}
		if ((m = /^rm -f '([^']+)'$/.exec(c))) return (box.files.delete(m[1]!), ok());
		if ((m = /^rm -rf '(\/tmp\/\.wr-[^']+)'$/.exec(c))) return (this.#rm(box, m[1]!), ok());
		if ((m = /^mkdir -p '(\/tmp\/\.wr-[^']+)' && chmod 755/.exec(c))) return (box.dirs.add(m[1]!), ok());
		if (/^chmod 644 /.test(c)) return ok();
		if ((m = /^cd '([^']+)' 2>\/dev\/null \|\| exit 3; M=/.exec(c))) {
			const dir = m[1]!;
			if (!box.dirs.has(dir)) return { status: "error", exitCode: 3, stdout: "", stderr: "" };
			return ok(`${box.text(`${dir}/.workroom-sha256`) ?? ""} ${this.#treeHash(box, dir, true)}\n`);
		}
		if ((m = /^chmod -R u\+w '([^']+)' 2>\/dev\/null; rm -rf '[^']+'; mkdir -p '[^']+'$/.exec(c))) return (this.#rm(box, m[1]!), box.dirs.add(m[1]!), ok());
		if (/^chmod a\+x /.test(c)) return ok();
		if ((m = /^cd '([^']+)' && find \. -type f \| LC_ALL=C sort/.exec(c))) return ok(`${this.#treeHash(box, m[1]!, false)}\n`);
		if ((m = /^chmod -R u\+w '([^']+)'; rm -rf '[^']+'$/.exec(c))) return (this.#rm(box, m[1]!), ok());
		if ((m = /^chmod -R a-w,a\+rX '([^']+)'$/.exec(c))) return (box.ro.add(m[1]!), ok());
		if ((m = /^chmod -R u\+w '([^']+)' 2>\/dev\/null; true$/.exec(c))) return (this.#unro(box, m[1]!), ok()); // round 11 (R5): make a read-only store writable again before re-seeding it
		if ((m = /^test -w '([^']+)' && echo writable \|\| echo protected$/.exec(c))) return ok(this.singleUser ? "writable\n" : "protected\n");
		// user program
		if ((m = /^(?:python3|\/bin\/sh|node(?: --max-old-space-size=\d+)?) '([^']+)'$/.exec(c))) {
			box.lastRun = { cwd: o.cwd, env: { ...(o.env ?? {}) } };
			return this.#program(box, box.text(m[1]!) ?? "", o);
		}
		return { status: "error", exitCode: 127, stdout: "", stderr: `fake: unknown command ${c.slice(0, 120)}` };
	}

	async #program(box: FakeBox, code: string, o: ExecOptions): Promise<ExecResult> {
		let stdout = "";
		let stderr = "";
		const abs = (p: string) => (p.startsWith("/") ? p : `${o.cwd}/${p}`);
		box.running++;
		box.maxRunning = Math.max(box.maxRunning, box.running);
		try {
			for (const line of code.split("\n").map((l) => l.trim()).filter(Boolean)) {
				const [op, a, ...rest] = line.split(" ");
				const arg = rest.join(" ");
				if (op === "echo") (stdout += `${[a, ...rest].join(" ")}\n`, o.onStdout?.(`${[a, ...rest].join(" ")}\n`));
				else if (op === "err") stderr += `${[a, ...rest].join(" ")}\n`;
				else if (op === "write") {
					if (this.#blocked(box, abs(a!))) {
						stderr += `permission denied: ${a}\n`;
						return { status: "error", exitCode: 1, stdout, stderr };
					}
					box.put(abs(a!), arg);
				} else if (op === "big") box.put(abs(a!), new Uint8Array(Number(arg)).fill(65));
				else if (op === "rm") this.#rm(box, abs(a!));
				else if (op === "mkdir") box.dirs.add(abs(a!));
				else if (op === "ln") box.files.set(abs(a!), { kind: "symlink", target: arg });
				else if (op === "mkfifo") box.files.set(abs(a!), { kind: "other" });
				else if (op === "cat") stdout += `${box.text(abs(a!)) ?? "<missing>"}\n`;
				else if (op === "exit") return { status: Number(a) === 0 ? "ok" : "error", exitCode: Number(a), stdout, stderr };
				else if (op === "sleep") {
					const until = Date.now() + Number(a);
					while (Date.now() < until) {
						if (o.signal?.aborted) return { status: "killed", exitCode: null, stdout, stderr };
						if (Date.now() - (until - Number(a)) > o.timeoutMs) return { status: "timeout", exitCode: null, stdout, stderr };
						await new Promise((r) => setTimeout(r, 10));
					}
				} else return { status: "error", exitCode: 2, stdout, stderr: `${stderr}fake program: unknown op ${op}` };
			}
			return { status: "ok", exitCode: 0, stdout, stderr };
		} finally {
			box.running--;
		}
	}
}
