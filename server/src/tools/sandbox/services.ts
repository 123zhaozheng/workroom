// Long-running sandboxed processes ("services"): e.g. an MCP stdio server kept alive for a conversation, with stdin/stdout piped.
// The registry enforces idle/lifetime limits, a global cap, one instance per key, and stops everything on shutdown.
import { PassThrough, Transform, type Readable, type Writable } from "node:stream";
import type { DriverId, DriverServiceProcess, ServiceRuntime } from "./driver.ts";
import { tailBuffer } from "./util.ts";

export type ServiceExitReason = "exit" | "stopped" | "idle" | "lifetime" | "shutdown";
export interface ServiceExit {
	exitCode: number | null;
	signal: string | null;
	reason: ServiceExitReason;
}

export interface SandboxServiceInfo {
	key: string;
	id: string;
	spaceId: string;
	conversationId?: number;
	runtime: ServiceRuntime;
	startedAt: string;
	lastActivityAt: string;
	driver: DriverId;
	running: boolean;
}

/** Handle returned to callers (marketplace MCP runner, …). */
export class SandboxService {
	readonly key: string;
	readonly id: string;
	readonly spaceId: string;
	readonly conversationId: number | undefined;
	readonly runtime: ServiceRuntime;
	readonly driver: DriverId;
	readonly startedAt = new Date();
	lastActivity = Date.now();
	readonly stdin: Writable;
	readonly stdout: Readable;
	readonly exited: Promise<ServiceExit>;
	running = true;
	readonly #proc: DriverServiceProcess;
	readonly #stderr = tailBuffer();
	#reason: ServiceExitReason = "exit";
	#timer: NodeJS.Timeout | undefined;
	#lifeTimer: NodeJS.Timeout | undefined;
	readonly #idleMs: number;
	readonly #onGone: (s: SandboxService) => void;

	constructor(init: { key: string; id: string; spaceId: string; conversationId?: number; runtime: ServiceRuntime; driver: DriverId; proc: DriverServiceProcess; idleTimeoutMs: number; maxLifetimeMs: number; onGone: (s: SandboxService) => void }) {
		this.key = init.key;
		this.id = init.id;
		this.spaceId = init.spaceId;
		this.conversationId = init.conversationId;
		this.runtime = init.runtime;
		this.driver = init.driver;
		this.#proc = init.proc;
		this.#idleMs = init.idleTimeoutMs;
		this.#onGone = init.onGone;
		// Activity is tracked by Transforms that sit in front of the real pipes (attaching a 'data' listener to the child's stdout
		// directly would start the flow before the consumer is attached and lose data).
		const touch = () => (this.lastActivity = Date.now());
		this.stdout = new Transform({ transform: (c, _e, cb) => (touch(), cb(null, c)) });
		init.proc.stdout.pipe(this.stdout as Transform);
		const stdin = new Transform({ transform: (c, _e, cb) => (touch(), cb(null, c)) });
		stdin.on("error", () => {});
		stdin.pipe(init.proc.stdin);
		this.stdin = stdin;
		init.proc.stderr.on("data", (b: Buffer) => this.#stderr.push(b));
		init.proc.stderr.on("error", () => {});
		init.proc.stdout.on("error", () => {});
		this.exited = init.proc.exited.then((r) => {
			this.running = false;
			clearTimeout(this.#timer);
			clearTimeout(this.#lifeTimer);
			try {
				stdin.destroy();
				(this.stdout as PassThrough).end();
			} catch {
				/* closed */
			}
			this.#onGone(this);
			return { exitCode: r.exitCode, signal: r.signal, reason: this.#reason };
		});
		this.#lifeTimer = setTimeout(() => void this.#stopFor("lifetime"), init.maxLifetimeMs);
		this.#lifeTimer.unref();
		this.#arm();
	}
	#arm(): void {
		clearTimeout(this.#timer);
		const left = this.#idleMs - (Date.now() - this.lastActivity);
		this.#timer = setTimeout(() => (Date.now() - this.lastActivity >= this.#idleMs ? void this.#stopFor("idle") : this.#arm()), Math.max(50, left));
		this.#timer.unref();
	}
	async #stopFor(reason: ServiceExitReason): Promise<void> {
		if (!this.running) return;
		this.#reason = reason;
		await this.#proc.kill();
		await this.exited;
	}
	/** Last 64 KB of stderr as text. */
	stderrTail(): string {
		return this.#stderr.text();
	}
	/** Stop the service and everything it started (idempotent). */
	async stop(): Promise<void> {
		if (!this.running) return void (await this.exited);
		await this.#stopFor("stopped");
	}
	/** @internal */
	stopFor(reason: ServiceExitReason): Promise<void> {
		return this.#stopFor(reason);
	}
	info(): SandboxServiceInfo {
		return { key: this.key, id: this.id, spaceId: this.spaceId, conversationId: this.conversationId, runtime: this.runtime, startedAt: this.startedAt.toISOString(), lastActivityAt: new Date(this.lastActivity).toISOString(), driver: this.driver, running: this.running };
	}
}
