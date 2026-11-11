// Round 11 (R4): in-memory broker between a code_run call on the server and a browser tab of the same user.
//   * A tab registers by opening the conversation's SSE stream with ?local=<tabId> (see runtime/routes.ts hook): that is its presence.
//   * dispatch() announces the job (SSE event `localjob`) to every tab of the run's user in that conversation. The first POST …/claim wins.
//   * The claiming tab fetches the declared inputs, runs the code in its isolated runtime and posts the result (+ output files).
//   * Nobody claims within claimWaitMs, the tab disconnects, the run times out, or the call is aborted → the job ends and the caller decides
//     (capacity failures are retried in the cloud once by the LocalExec service).
// Nothing here touches the filesystem: reads/writes are callbacks supplied by the dispatcher, so the existing workspace checks apply.
import { Buffer } from "node:buffer";
import { HttpError, newId } from "../../core/http.ts";
import { LOCAL_EXEC_LIMITS, type LocalExecLanguage, type LocalFailKind, type LocalJobAnnounce, type LocalJobCancel, type LocalJobClaimResponse, type LocalJobResultRequest } from "../../../../shared/localexec.ts";

/** The browser boots Pyodide (a ~10 MB wasm module) before the code starts; the run's own clock starts afterwards. */
const PYTHON_BOOT_MS = 45_000;

export interface TabConnection {
	spaceId: string;
	conversationId: number;
	userId: string;
	tabId: string;
	/** Pushes one SSE event to this connection. */
	send: (event: string, data: unknown) => void | Promise<unknown>;
}

export interface DispatchSpec {
	spaceId: string;
	conversationId: number;
	userId: string;
	language: LocalExecLanguage;
	code: string;
	timeoutSec: number;
	/** Declared inputs, already read by the dispatcher (bytes stay in memory until the job ends). */
	inputs: readonly { path: string; bytes: Uint8Array }[];
	/** Stores one output file in the host workspace (existing path/quota checks). Returns the stored relative path; throws on refusal. */
	writeFile: (path: string, bytes: Uint8Array) => string;
	signal?: AbortSignal;
}

export type JobOutcome =
	| { kind: "done"; result: LocalJobResultRequest; written: { path: string; size: number }[]; rejected: { path: string; reason: string }[] }
	| { kind: "failed"; fail: LocalFailKind; message: string }
	| { kind: "aborted" };

interface Job {
	id: string;
	spec: DispatchSpec;
	claimedBy?: string;
	startedAt?: number;
	settled: boolean;
	timers: NodeJS.Timeout[];
	settle: (o: JobOutcome) => void;
}

export interface BrokerOptions {
	claimWaitMs?: number;
	/** How long a claiming tab may be without any connection before its job is given up (an SSE reconnect is quick). */
	tabGraceMs?: number;
	/** Extra time after timeoutSec for the browser to report back. */
	resultGraceMs?: number;
}

export class LocalExecBroker {
	readonly claimWaitMs: number;
	readonly tabGraceMs: number;
	readonly resultGraceMs: number;
	readonly #conns = new Set<TabConnection>();
	readonly #jobs = new Map<string, Job>();
	readonly #graceTimers = new Map<string, NodeJS.Timeout>();

	constructor(o: BrokerOptions = {}) {
		this.claimWaitMs = o.claimWaitMs ?? LOCAL_EXEC_LIMITS.claimWaitMs;
		this.tabGraceMs = o.tabGraceMs ?? 6000;
		this.resultGraceMs = o.resultGraceMs ?? 5000;
	}

	// ---------------------------------------------------------------- presence
	/** Registers a tab connection; announces unclaimed jobs it may take. Returns the detach function (call when the stream closes). */
	attach(c: TabConnection): () => void {
		this.#conns.add(c);
		const g = this.#graceTimers.get(c.tabId);
		if (g) (clearTimeout(g), this.#graceTimers.delete(c.tabId));
		for (const j of this.#jobs.values()) if (!j.claimedBy && this.#matches(j, c)) this.#push(c, "localjob", this.#announce(j));
		return () => {
			this.#conns.delete(c);
			if (this.#hasTab(c.tabId)) return;
			// The tab has no connection left: its running jobs are lost unless it reconnects shortly.
			const t = setTimeout(() => {
				this.#graceTimers.delete(c.tabId);
				if (this.#hasTab(c.tabId)) return;
				for (const j of [...this.#jobs.values()]) if (j.claimedBy === c.tabId) this.#end(j, { kind: "failed", fail: "tab_lost", message: "浏览器标签页已断开" });
			}, this.tabGraceMs);
			this.#graceTimers.set(c.tabId, t);
		};
	}
	#hasTab(tabId: string): boolean {
		for (const c of this.#conns) if (c.tabId === tabId) return true;
		return false;
	}
	/** True when a tab of this user is connected to this conversation. */
	connected(spaceId: string, conversationId: number, userId: string): boolean {
		for (const c of this.#conns) if (c.spaceId === spaceId && c.conversationId === conversationId && c.userId === userId) return true;
		return false;
	}
	pending(): number {
		return this.#jobs.size;
	}

	#matches(j: Job, c: TabConnection): boolean {
		return c.spaceId === j.spec.spaceId && c.conversationId === j.spec.conversationId && c.userId === j.spec.userId;
	}
	#announce(j: Job): LocalJobAnnounce {
		return { jobId: j.id, language: j.spec.language, timeoutSec: j.spec.timeoutSec };
	}
	#push(c: TabConnection, event: string, data: unknown): void {
		try {
			void Promise.resolve(c.send(event, data)).catch(() => {});
		} catch {
			/* a dead stream is removed by its own detach */
		}
	}
	#cancel(j: Job, reason: LocalJobCancel["reason"], except?: string): void {
		for (const c of this.#conns) if (this.#matches(j, c) && c.tabId !== except) this.#push(c, "localjob-cancel", { jobId: j.id, reason } satisfies LocalJobCancel);
	}

	// ---------------------------------------------------------------- dispatch
	/** Announce a job and wait for its outcome. Never rejects: failures are outcomes. */
	dispatch(spec: DispatchSpec): { jobId: string; outcome: Promise<JobOutcome> } {
		const id = newId("lj");
		let settle!: (o: JobOutcome) => void;
		const outcome = new Promise<JobOutcome>((r) => (settle = r));
		const job: Job = { id, spec, settled: false, timers: [], settle };
		this.#jobs.set(id, job);
		if (spec.signal?.aborted) {
			// Never announced: nothing for a tab to cancel.
			job.settled = true;
			this.#jobs.delete(id);
			settle({ kind: "aborted" });
			return { jobId: id, outcome };
		}
		const claimTimer = setTimeout(() => {
			if (!job.claimedBy) this.#end(job, { kind: "failed", fail: "unclaimed", message: "没有浏览器标签页在时限内接手" });
		}, this.claimWaitMs);
		job.timers.push(claimTimer);
		spec.signal?.addEventListener("abort", () => this.#end(job, { kind: "aborted" }), { once: true });
		for (const c of this.#conns) if (this.#matches(job, c)) this.#push(c, "localjob", this.#announce(job));
		return { jobId: id, outcome };
	}

	#end(j: Job, o: JobOutcome): void {
		if (j.settled) return;
		j.settled = true;
		for (const t of j.timers) clearTimeout(t);
		this.#jobs.delete(j.id);
		this.#cancel(j, o.kind === "aborted" ? "aborted" : o.kind === "failed" && o.fail === "timeout" ? "timeout" : "done");
		j.settle(o);
	}

	// ---------------------------------------------------------------- tab-side calls (HTTP routes)
	#job(jobId: string, userId: string, space: { spaceId: string; conversationId: number }): Job {
		const j = this.#jobs.get(jobId);
		// Same answer for "no such job" and "someone else's job": nothing about other users' runs leaks.
		if (!j || j.spec.userId !== userId || j.spec.spaceId !== space.spaceId || j.spec.conversationId !== space.conversationId) throw new HttpError(404, "job_not_found", "任务不存在或已结束");
		return j;
	}

	/** First claim wins. The tab must be connected (has an open stream for this conversation as this user). */
	claim(jobId: string, userId: string, tabId: string, where: { spaceId: string; conversationId: number }): LocalJobClaimResponse {
		const j = this.#job(jobId, userId, where);
		if (!this.#hasTabFor(tabId, userId, where)) throw new HttpError(409, "tab_not_connected", "该标签页没有连接到此对话");
		if (j.claimedBy) throw new HttpError(409, "job_taken", "任务已被另一个标签页接手");
		j.claimedBy = tabId;
		j.startedAt = Date.now();
		for (const t of j.timers) clearTimeout(t);
		j.timers = [];
		this.#cancel(j, "taken", tabId);
		const t = setTimeout(() => this.#end(j, { kind: "failed", fail: "timeout", message: `浏览器内运行超过 ${j.spec.timeoutSec} 秒未返回` }), j.spec.timeoutSec * 1000 + this.resultGraceMs + (j.spec.language === "python" ? PYTHON_BOOT_MS : 0));
		j.timers.push(t);
		return {
			jobId: j.id,
			language: j.spec.language,
			code: j.spec.code,
			timeoutSec: j.spec.timeoutSec,
			inputs: j.spec.inputs.map((i) => ({ path: i.path, size: i.bytes.length })),
			limits: { maxOutputChars: LOCAL_EXEC_LIMITS.maxOutputChars, maxOutputFiles: LOCAL_EXEC_LIMITS.maxOutputFiles, maxOutputBytes: LOCAL_EXEC_LIMITS.maxOutputBytes },
		};
	}
	#hasTabFor(tabId: string, userId: string, w: { spaceId: string; conversationId: number }): boolean {
		for (const c of this.#conns) if (c.tabId === tabId && c.userId === userId && c.spaceId === w.spaceId && c.conversationId === w.conversationId) return true;
		return false;
	}

	/** Bytes of one DECLARED input (a job never exposes other workspace files). */
	input(jobId: string, userId: string, tabId: string, where: { spaceId: string; conversationId: number }, path: string): Uint8Array {
		const j = this.#job(jobId, userId, where);
		if (j.claimedBy !== tabId) throw new HttpError(403, "not_claimant", "只有接手任务的标签页可以读取输入");
		const f = j.spec.inputs.find((i) => i.path === path);
		if (!f) throw new HttpError(404, "input_not_found", "不是该任务声明的输入文件");
		return f.bytes;
	}

	/** The claiming tab reports back. Output files are written through the dispatcher's writeFile (path + quota checks); refusals are reported, not hidden. */
	complete(jobId: string, userId: string, where: { spaceId: string; conversationId: number }, r: LocalJobResultRequest): { written: number; rejected: number } {
		const j = this.#job(jobId, userId, where);
		if (j.claimedBy !== r.tabId) throw new HttpError(403, "not_claimant", "只有接手任务的标签页可以提交结果");
		const kind = r.error?.kind;
		if (!r.ok && kind && kind !== "error") {
			// Capacity failure reported by the runtime itself: no files are kept.
			this.#end(j, { kind: "failed", fail: kind, message: r.error?.message ?? "" });
			return { written: 0, rejected: 0 };
		}
		const written: { path: string; size: number }[] = [];
		const rejected: { path: string; reason: string }[] = [];
		const files = r.ok ? (r.files ?? []) : []; // a failed run keeps no files
		let total = 0;
		if (files.length > LOCAL_EXEC_LIMITS.maxOutputFiles) throw new HttpError(413, "too_many_files", `输出文件不能超过 ${LOCAL_EXEC_LIMITS.maxOutputFiles} 个`);
		const decoded = files.map((f) => {
			if (typeof f?.path !== "string" || typeof f?.base64 !== "string") throw new HttpError(400, "invalid", "输出文件格式无效");
			const bytes = new Uint8Array(Buffer.from(f.base64, "base64"));
			total += bytes.length;
			return { path: f.path, bytes };
		});
		if (total > LOCAL_EXEC_LIMITS.maxOutputBytes) throw new HttpError(413, "too_large", `输出文件合计不能超过 ${Math.round(LOCAL_EXEC_LIMITS.maxOutputBytes / 1048576)} MB`);
		for (const f of decoded) {
			try {
				written.push({ path: j.spec.writeFile(f.path, f.bytes), size: f.bytes.length });
			} catch (e: any) {
				rejected.push({ path: f.path, reason: String(e?.message ?? e).slice(0, 300) });
			}
		}
		this.#end(j, { kind: "done", result: r, written, rejected });
		return { written: written.length, rejected: rejected.length };
	}

	/** Test/shutdown helper: ends every job as aborted. */
	shutdown(): void {
		for (const j of [...this.#jobs.values()]) this.#end(j, { kind: "aborted" });
		for (const t of this.#graceTimers.values()) clearTimeout(t);
		this.#graceTimers.clear();
	}
}
