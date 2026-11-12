// Background jobs (M14-C): long sandbox / browse / generation work runs as a pi-durable task created with
// `{ ownership: conversation, background: true }` — it does not keep the conversation busy (the chat keeps answering), it
// survives restarts (the task is resumed by the space's Harness), and it is cancelled through `harness.abortTask()`.
// Status lives in two places with one authority each: the pi task decides *whether* the job is still live; `tool_jobs`
// (app.sqlite) holds the job's catalog row (budget, status, outputs, errors) for listing without opening a Harness;
// the conversation doc `wr.jobs` mirrors {status, updatedAt} so conversation watchers/SSE see changes.
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createHash } from "node:crypto";
import { defineDoc, defineExtension, defineTask, defineTool, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { arr, bool, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { AppContext, FileVersionRef, Principal, Space } from "../core/contracts.ts";
import type { Migration } from "../core/db.ts";
import { HttpError, nowIso } from "../core/http.ts";
import type { JobDTO, JobKind, JobStatus } from "../../../shared/files.ts";
import { runtimeActorResolver, type ActorResolver } from "../files/actor.ts";
import { FORMATS, generate, type Format } from "../files/generate.ts";
import { effectiveMime, extOf } from "../files/mime.ts";
import type { Files } from "../files/service.ts";
import type { BrowserService } from "./browser.ts";
import type { ToolCallLog } from "./calls.ts";
import { requirePermission } from "./sandbox/perm.ts";
import { DEFAULT_LIMITS, JOB_MAX_TIMEOUT_MS, killStaleSandbox, type Sandbox } from "./sandbox.ts";

export const JOB_MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "background jobs",
		sql: `
CREATE TABLE tool_jobs (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, space_id TEXT NOT NULL, conversation_id INTEGER NOT NULL, user_id TEXT NOT NULL,
  kind TEXT NOT NULL, title TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL, task_id INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
  restart_policy TEXT NOT NULL, budget TEXT NOT NULL, progress TEXT, summary TEXT, error TEXT, outputs TEXT NOT NULL DEFAULT '[]',
  sandbox_run_id TEXT, pid INTEGER, cancel_requested_by TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX tool_jobs_conv ON tool_jobs(space_id, conversation_id, created_at);
`,
	},
];

const TERMINAL: readonly JobStatus[] = ["done", "failed", "cancelled", "timeout"];
/** Marks a failure whose real outcome is unknown (the process died mid-run): job_status reports it as 结果未知, not as a plain failure. */
const UNKNOWN_PREFIX = "结果未知：";
const STATUS_LABEL: Record<JobStatus, string> = { queued: "排队中", running: "运行中", done: "已完成", failed: "失败", cancelled: "已取消", timeout: "超时" };

/** Where the model can reach a finished job's output files (they live in /work; present_file delivers them). */
function outputPaths(r: JobRow): string[] {
	const input = JSON.parse(r.input) as JobInput;
	if (r.kind === "sandbox") return (input.sandbox?.publish ?? []).map((p) => `/work/${p.replace(/^\.?\/+/, "")}`);
	return (JSON.parse(r.outputs) as FileVersionRef[]).filter((o) => !/\.(png|jpe?g)$/i.test(o.name)).map((o) => `/work/jobs/${r.id}/${o.name}`);
}

/** Conversation mirror of job status (fork: "initial": a branch does not inherit the original's jobs). */
export const JobsDoc = defineDoc<{ jobs: Record<string, { status: string; title: string; kind: string; updatedAt: string }>; tasks?: Record<string, number> }>({
	kind: "wr.jobs",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ jobs: {} }),
	checkpointWhen: (_v, _ops, info) => info.deltasSinceBase >= 32,
});

interface JobRow {
	id: string;
	org_id: string;
	space_id: string;
	conversation_id: number;
	user_id: string;
	kind: JobKind;
	title: string;
	input: string;
	status: JobStatus;
	task_id: number | null;
	attempts: number;
	restart_policy: "rerun" | "fail";
	budget: string;
	progress: string | null;
	summary: string | null;
	error: string | null;
	outputs: string;
	sandbox_run_id: string | null;
	pid: number | null;
	cancel_requested_by: string | null;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
	updated_at: string;
}

export interface JobInput {
	readonly kind: JobKind;
	readonly title?: string;
	readonly sandbox?: { language: "shell" | "python" | "node"; code: string; publish?: string[] };
	readonly browse?: { url: string; screenshot?: boolean };
	readonly generate?: { format: Format; name: string; title?: string; content?: string; sections?: unknown; table?: unknown; sheets?: unknown; slides?: unknown };
	readonly timeoutMs?: number;
	readonly cpuSeconds?: number;
	readonly restartPolicy?: "rerun" | "fail";
}

class Interrupted extends Error {}
const json = (x: unknown): any => JSON.parse(JSON.stringify(x));

export class Jobs {
	readonly #ctx: AppContext;
	resolveActor: ActorResolver;
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
		this.resolveActor = runtimeActorResolver(ctx);
	}
	row(id: string): JobRow | undefined {
		return this.#ctx.db.get<JobRow>("SELECT * FROM tool_jobs WHERE id = ?", id);
	}
	#set(id: string, fields: Partial<Record<keyof JobRow, string | number | null>>): void {
		const keys = Object.keys(fields);
		this.#ctx.db.run(`UPDATE tool_jobs SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...(keys.map((k) => (fields as any)[k]) as (string | number | null)[]), nowIso(), id);
	}
	dto(r: JobRow, canCancel?: boolean): JobDTO {
		return {
			id: r.id,
			kind: r.kind,
			title: r.title,
			status: r.status,
			spaceId: r.space_id,
			conversationId: r.conversation_id,
			userId: r.user_id,
			taskId: r.task_id ?? undefined,
			budget: JSON.parse(r.budget),
			restartPolicy: r.restart_policy,
			attempts: r.attempts,
			progress: r.progress ?? undefined,
			summary: r.summary ?? undefined,
			error: r.error ?? undefined,
			outputs: JSON.parse(r.outputs),
			sandboxRunId: r.sandbox_run_id ?? undefined,
			cancelRequestedBy: r.cancel_requested_by ?? undefined,
			createdAt: r.created_at,
			startedAt: r.started_at ?? undefined,
			finishedAt: r.finished_at ?? undefined,
			updatedAt: r.updated_at,
			canCancel,
		};
	}
	forConversation(spaceId: string, conversationId: number): JobDTO[] {
		return this.#ctx.db.all<JobRow>("SELECT * FROM tool_jobs WHERE space_id = ? AND conversation_id = ? ORDER BY created_at DESC LIMIT 100", spaceId, conversationId).map((r) => this.dto(r));
	}
	list(spaceIds: readonly string[], filter: { conversationId?: number; status?: string }): JobRow[] {
		if (!spaceIds.length) return [];
		const where = [`space_id IN (${spaceIds.map(() => "?").join(",")})`];
		const params: (string | number)[] = [...spaceIds];
		if (filter.conversationId !== undefined) (where.push("conversation_id = ?"), params.push(filter.conversationId));
		if (filter.status) (where.push("status = ?"), params.push(filter.status));
		return this.#ctx.db.all<JobRow>(`SELECT * FROM tool_jobs WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 200`, ...params);
	}

	/** Validate and insert the catalog row (deterministic id per tool call: a replayed job_start finds its job). */
	create(p: Principal, space: Space, conversationId: number, key: string, input: JobInput): JobRow {
		const id = `job_${createHash("sha256").update(`${space.id}:${key}`).digest("hex").slice(0, 24)}`;
		const existing = this.row(id);
		if (existing) return existing;
		if (!["sandbox", "browse", "generate"].includes(input.kind)) throw new HttpError(400, "bad_kind", "kind 必须是 sandbox、browse 或 generate");
		if (input.kind === "sandbox" && !input.sandbox?.code) throw new HttpError(400, "invalid", "sandbox 任务需要 sandbox.code");
		if (input.kind === "browse" && !input.browse?.url) throw new HttpError(400, "invalid", "browse 任务需要 browse.url");
		if (input.kind === "generate" && (!input.generate?.name || !FORMATS.includes(input.generate.format))) throw new HttpError(400, "invalid", "generate 任务需要 generate.name 与 format");
		const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 10 * 60_000, 1000), JOB_MAX_TIMEOUT_MS);
		const budget = { timeoutMs, cpuSeconds: Math.max(1, Math.min(input.cpuSeconds ?? Math.ceil(timeoutMs / 1000), Math.ceil(timeoutMs / 1000))), memoryBytes: DEFAULT_LIMITS.memoryBytes };
		const title = (input.title ?? (input.kind === "sandbox" ? `后台运行 ${input.sandbox!.language}` : input.kind === "browse" ? `抓取 ${input.browse!.url}` : `生成 ${input.generate!.name}`)).slice(0, 120);
		const now = nowIso();
		this.#ctx.db.run(
			"INSERT OR IGNORE INTO tool_jobs (id, org_id, space_id, conversation_id, user_id, kind, title, input, status, restart_policy, budget, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)",
			id, p.orgId, space.id, conversationId, p.userId, input.kind, title, JSON.stringify(input), input.restartPolicy === "rerun" ? "rerun" : "fail", JSON.stringify(budget), now, now,
		);
		return this.row(id)!;
	}
	/** Test seam: awaited by job_start right after the task+mapping commit and before the projection write (simulates a crash window). */
	afterTaskCommitted?: (jobId: string) => Promise<void>;
	/** Projection write: tool_jobs.task_id mirrors the durable mapping `JobsDoc.tasks[jobId]`; safe to repeat, rebuilt on replay / task start. */
	attachTask(id: string, taskId: number): void {
		this.#ctx.db.run("UPDATE tool_jobs SET task_id = COALESCE(task_id, ?) WHERE id = ?", taskId, id);
	}

	async cancel(p: Principal, id: string): Promise<JobDTO> {
		const r = this.row(id);
		if (!r) throw new HttpError(404, "not_found", "任务不存在");
		await this.#ctx.services.get("acl").require(p, "write", { kind: "space", id: r.space_id });
		if (TERMINAL.includes(r.status)) return this.dto(r, true);
		this.#set(id, { cancel_requested_by: p.userId });
		if (r.task_id !== null && this.#ctx.services.has("runtime")) {
			const h = await this.#ctx.services.get("runtime").harness(r.space_id, BACKGROUND_CONTEXT);
			await h.abortTask(r.task_id as any, BACKGROUND_CONTEXT);
		} else this.finish(id, "cancelled", { error: `已由用户取消` });
		return this.dto(this.row(id)!, true);
	}

	finish(id: string, status: JobStatus, f: { summary?: string; error?: string; outputs?: FileVersionRef[] } = {}): void {
		const r = this.row(id);
		if (!r || TERMINAL.includes(r.status)) return;
		this.#set(id, { status, summary: f.summary?.slice(0, 4000) ?? r.summary, error: f.error?.slice(0, 2000) ?? null, outputs: JSON.stringify(f.outputs ?? JSON.parse(r.outputs)), finished_at: nowIso(), pid: null });
	}

	/** One attempt of a job, inside the job task's phase. Throws Interrupted when the Harness is closing (task stays pending). */
	async execute(id: string, taskId: number, attempt: number, signal: AbortSignal): Promise<JobStatus> {
		const r = this.row(id)!;
		const input = JSON.parse(r.input) as JobInput;
		const budget = JSON.parse(r.budget) as { timeoutMs: number; cpuSeconds: number };
		const identity = this.#ctx.services.get("identity");
		const principal = await identity.principalFor(r.user_id, r.org_id);
		const space = identity.space(r.space_id);
		if (!principal || !space) {
			this.finish(id, "failed", { error: "发起人已被停用或空间不存在（revoked）" });
			return "failed";
		}
		const d = await this.#ctx.services.get("acl").check(principal, "write", { kind: "space", id: space.id });
		if (!d.allow) {
			this.finish(id, "failed", { error: `发起人已无权在该空间运行任务（${d.reason}）` });
			return "failed";
		}
		this.#set(id, { status: "running", attempts: attempt, started_at: r.started_at ?? nowIso(), progress: attempt > 1 ? `服务重启后第 ${attempt} 次运行` : "运行中", error: null });
		const files = this.#ctx.services.get("files") as unknown as Files;
		// browse/generate outputs also land in /work so present_file can deliver them (sandbox jobs already wrote theirs there)
		const toWork = (name: string, bytes: Uint8Array) => {
			try {
				(this.#ctx.services.get("sandbox") as Sandbox).writeFile(space, r.conversation_id, `jobs/${id}/${name}`, bytes, principal);
			} catch {
				/* the version in the file service is still recorded; the output list then simply omits a /work path that cannot be read */
			}
		};
		const put = (name: string, mime: string, bytes: Uint8Array, key: string, note: string) => {
			if (r.kind !== "sandbox") toWork(name, bytes);
			return files.putVersion(principal, { name, mime, bytes, idempotencyKey: `job:${id}:${key}`, provenance: { createdBy: principal.userId, spaceId: space.id, conversationId: r.conversation_id, taskId, callId: `job:${id}`, changeNote: note, origin: principal.via ? "automation" : "agent", tool: `job:${r.kind}` } as any });
		};
		const ac = new AbortController();
		const onAbort = () => ac.abort();
		signal.addEventListener("abort", onAbort, { once: true });
		// Sandbox jobs enforce the budget inside the sandbox (wall clock + RLIMIT_CPU); others race a deadline here.
		const deadline = r.kind === "sandbox" ? undefined : setTimeout(() => ac.abort(new Error("budget")), budget.timeoutMs);
		try {
			if (r.kind === "sandbox") {
				const sb = this.#ctx.services.get("sandbox") as Sandbox;
				const run = await sb.run({ principal, space, conversationId: r.conversation_id, taskId, callId: `job:${id}:${attempt}`, language: input.sandbox!.language, code: input.sandbox!.code, timeoutMs: budget.timeoutMs, maxTimeoutMs: JOB_MAX_TIMEOUT_MS, cpuSeconds: budget.cpuSeconds, signal, onSpawn: (pid) => this.#set(id, { pid }) });
				this.#set(id, { sandbox_run_id: run.id, pid: null });
				if (signal.aborted) throw new Interrupted();
				const outputs: FileVersionRef[] = [];
				for (const path of input.sandbox!.publish ?? []) {
					try {
						const f = sb.readFile(space, r.conversation_id, path, principal); // round 11: memories/ and project/ are routed by principal
						outputs.push(await put(f.name, effectiveMime(undefined, f.name), f.bytes, `out:${path}`, `后台任务「${r.title}」的输出 ${sb.shown(space, sb.relPath(space, path))}`));
					} catch (e: any) {
						if (run.status === "ok") throw new Error(`输出文件 ${path} 不存在或无法读取：${e?.message ?? e}`);
					}
				}
				const tail = `${run.stdout.slice(-1500)}${run.stderr ? `\n[stderr]\n${run.stderr.slice(-800)}` : ""}`;
				const status: JobStatus = run.status === "ok" ? "done" : run.status === "timeout" || /超过 CPU 时间限制/.test(run.stderr) ? "timeout" : "failed";
				this.finish(id, status, { summary: tail, outputs, error: status === "done" ? undefined : `${run.status}${run.exitCode !== undefined ? ` (exit ${run.exitCode})` : ""}` });
				return status;
			}
			const race = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, rej) => ac.signal.addEventListener("abort", () => rej(signal.aborted ? new Interrupted() : new Error("budget")), { once: true }))]);
			if (r.kind === "browse") {
				const br = this.#ctx.services.get("browser") as BrowserService;
				const res = await race(br.browse({ url: input.browse!.url, screenshot: input.browse!.screenshot !== false, principal, space, save: { conversationId: r.conversation_id, taskId, callId: `job:${id}`, idempotencyKey: `job:${id}:shot` } }));
				const md = await put(`网页正文-${new URL(res.finalUrl).hostname}.md`, "text/markdown", new TextEncoder().encode(`# ${res.title}\n\n来源：${res.finalUrl}\n\n${res.text}\n`), "text", `抓取 ${res.finalUrl}`);
				this.finish(id, "done", { summary: `${res.title} (${res.finalUrl})`, outputs: [md, ...(res.screenshot ? [res.screenshot] : [])] });
				return "done";
			}
			const g = input.generate!;
			const gen = await race(generate(g.format, g as any));
			const name = extOf(g.name) === g.format ? g.name : `${g.name}.${g.format}`;
			const ref = await put(name, gen.mime, gen.bytes, "doc", "后台生成");
			this.finish(id, "done", { summary: `${ref.name} v${ref.versionNo}`, outputs: [ref] });
			return "done";
		} catch (e: any) {
			if (e instanceof Interrupted || signal.aborted) throw new Interrupted();
			const timedOut = ac.signal.aborted && String(ac.signal.reason?.message) === "budget";
			const status: JobStatus = timedOut ? "timeout" : "failed";
			this.finish(id, status, { error: timedOut ? `超过时间预算 ${budget.timeoutMs} ms` : String(e?.message ?? e) });
			return status;
		} finally {
			clearTimeout(deadline);
			signal.removeEventListener("abort", onAbort);
		}
	}

	/** Before re-running after a restart: kill a sandbox left over by the previous process. */
	cleanupStale(id: string): void {
		const r = this.row(id);
		if (r?.pid) killStaleSandbox(r.pid);
		this.#set(id, { pid: null });
	}
}

type JobState = { phase: "exec" };
type JobResult = { status: JobStatus };

export function createJobsExtension(ctx: AppContext, opts: { resolveActor?: ActorResolver } = {}): Extension {
	const jobs = () => ctx.services.get("jobs") as Jobs;
	const mirror = async (tx: any, conversationId: any, r: JobRow | undefined) => {
		if (!r) return;
		const doc = await tx.doc(JobsDoc, conversationId);
		doc.jobs[r.id] = { status: r.status, title: r.title, kind: r.kind, updatedAt: r.updated_at };
	};

	const JobTask = defineTask<{ jobId: string }, JobState, JobResult>({
		name: "wr.job",
		version: 1,
		initial: () => ({ phase: "exec" }),
		phases: {
			exec: async (task, runtime, context) => {
				const j = jobs();
				const id = task.input.jobId;
				let r = j.row(id);
				const done = async (status: JobStatus) => runtime.commit(async (tx) => (await mirror(tx, runtime.conversationId, j.row(id)), { status: "terminal", outcome: { status: "completed", result: { status } } }), context);
				// Ownership: the durable mapping (written atomically with this task's creation) decides, not the app-db projection.
				let owner: number | undefined;
				await runtime.commit(async (tx) => void (owner = (await tx.doc(JobsDoc, runtime.conversationId)).tasks?.[id]), context);
				if (!r || owner !== (task.id as unknown as number) || (r.task_id !== null && r.task_id !== (task.id as number))) return void (await done(r?.status ?? "failed")); // not this job's task
				j.attachTask(id, task.id as number); // rebuild the projection if the starter crashed before writing it
				if (TERMINAL.includes(r.status)) return void (await done(r.status));
				// Attempt bookkeeping in durable memos: a memo that already exists means a previous process ran this attempt.
				let attempt = 1;
				while ((await runtime.memo<boolean>(`attempt:${attempt}`, context)) !== undefined) attempt++;
				if (attempt > 1) {
					j.cleanupStale(id);
					if (r.restart_policy !== "rerun" || attempt > 3) {
						j.finish(id, "failed", { error: `${UNKNOWN_PREFIX}服务重启中断了任务（第 ${attempt - 1} 次运行），它可能已部分或全部执行；该任务声明为不可重跑（restartPolicy=${r.restart_policy}），未自动重做。重做前先检查 /work 与外部状态` });
						return void (await done("failed"));
					}
				}
				await runtime.memo(`attempt:${attempt}`, true, context);
				await runtime.commit(async (tx) => void (await mirror(tx, runtime.conversationId, { ...j.row(id)!, status: "running" })), context);
				let status: JobStatus;
				try {
					status = await j.execute(id, task.id as number, attempt, runtime.signal);
				} catch (e) {
					if (e instanceof Interrupted) throw e; // Harness closing or abort mark: the task stays live (resume / abort handler)
					throw e;
				}
				r = j.row(id);
				await done(r?.status ?? status);
			},
		},
		abort: async (task, runtime, context) => {
			const j = jobs();
			const id = task.input.jobId;
			const r = j.row(id);
			j.cleanupStale(id);
			if (r && !TERMINAL.includes(r.status)) j.finish(id, "cancelled", { error: r.cancel_requested_by ? "已由用户取消" : "任务被中止" });
			await runtime.commit(async (tx) => (await mirror(tx, runtime.conversationId, j.row(id)), { status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});

	const resolve = (api: ToolExecutionApi<any>, c: Context) => (opts.resolveActor ?? jobs().resolveActor)(api, c);
	const log = () => ctx.services.get("toolCalls") as ToolCallLog;

	const start = defineTool({
		name: "job_start",
		description:
			"在后台启动耗时任务并立即返回任务 id：sandbox（运行代码，publish 列出要登记的输出文件）、browse（抓取页面，保存正文）、generate（生成大文档）。" +
			`对话可继续；任务有时间/CPU 预算（timeoutMs 最长 ${Math.round(JOB_MAX_TIMEOUT_MS / 60000)} 分钟），可取消。用 job_status 查看。任务输出只是中间文件，不会自动交付：完成后对其 /work 路径调用 present_file。`,
		parameters: obj({
			kind: oneOf(["sandbox", "browse", "generate"]),
			title: opt(str()),
			sandbox: opt(obj({ language: oneOf(["shell", "python", "node"]), code: str({ minLength: 1 }), publish: opt(arr(str(), { description: "任务结束时登记为任务输出的文件（/work 下的相对路径，如 out/report.csv）；不等于交付" })) })),
			browse: opt(obj({ url: str(), screenshot: opt(bool()) })),
			generate: opt(obj({ format: oneOf(FORMATS), name: str(), title: opt(str()), content: opt(str()) }, { open: true })),
			timeoutMs: opt(int({ minimum: 1000, maximum: JOB_MAX_TIMEOUT_MS })),
			cpuSeconds: opt(int({ minimum: 1 })),
			restartPolicy: opt(oneOf(["rerun", "fail"], { description: "服务重启后：从头重跑（仅限可重复执行的任务）或标记结果未知（默认 fail）" })),
		}),
		// Replay-safe: the job id is derived from the tool call, so a rerun finds the same job and task instead of starting another.
		replay: "safe",
		async execute(args, api, context) {
			const actor = await resolve(api, context);
			const r = await log().around({ tool: "job_start", actor, args: { ...args, sandbox: args.sandbox ? { language: args.sandbox.language, code: `${args.sandbox.code.length} 字符`, publish: args.sandbox.publish } : undefined } }, async () => {
				await ctx.services.get("acl").require(actor.principal, "write", { kind: "space", id: actor.space.id });
				if (args.kind === "sandbox") await requirePermission(ctx, actor.principal, "sandbox.use");
				if (args.kind === "browse") await requirePermission(ctx, actor.principal, "sandbox.browser");
				const row = jobs().create(actor.principal, actor.space, actor.conversationId, `${actor.conversationId}:${actor.taskId}:${actor.callId}`, args as JobInput);
				if (row.task_id === null) {
					// One durable commit: create the task AND record job -> task in the conversation doc. A replay (same call id, so same job id)
					// finds the mapping and returns the existing task instead of creating a second one.
					const taskId = await api.commit(async (tx) => {
						const doc = await tx.doc(JobsDoc, actor.conversationId as any);
						const existing = doc.tasks?.[row.id];
						if (existing !== undefined) return existing;
						const created = (await tx.createTask(JobTask, { jobId: row.id }, { ownership: { kind: "conversation" }, conversationId: actor.conversationId as any, background: true })) as unknown as number;
						doc.tasks ??= {};
						doc.tasks[row.id] = created;
						return created;
					}, context);
					await jobs().afterTaskCommitted?.(row.id);
					jobs().attachTask(row.id, taskId);
				}
				return jobs().row(row.id)!;
			}, (x) => x.id);
			return { output: [{ type: "text", text: `已在后台启动任务 ${r.id}（${r.title}），预算 ${JSON.parse(r.budget).timeoutMs} ms。用 job_status 查看进度；对话可以继续。启动不代表完成，更不代表已交付。` }], details: { job: json(jobs().dto(r)) } };
		},
	});

	const status = defineTool({
		name: "job_status",
		description: "查看本会话的后台任务（或指定 jobId）：运行中 / 已完成 / 失败 / 已取消 / 超时 / 结果未知，以及输出文件的 /work 路径。结果未知表示重启打断，先核对状态再决定是否重做。",
		parameters: obj({ jobId: opt(str()) }),
		replay: "safe",
		async execute(args, api, context) {
			const actor = await resolve(api, context);
			await ctx.services.get("acl").require(actor.principal, "read", { kind: "space", id: actor.space.id });
			const list = jobs().forConversation(actor.space.id, actor.conversationId).filter((j) => !args.jobId || j.id === args.jobId);
			const line = (j: (typeof list)[number]) => {
				const unknown = j.status === "failed" && !!j.error?.startsWith(UNKNOWN_PREFIX);
				const paths = j.status === "done" ? outputPaths(jobs().row(j.id)!) : [];
				const out = paths.length ? `；输出文件（中间产物，尚未交付，需要给用户时对它调用 present_file）：${paths.join("、")}` : j.outputs.length ? `；输出：${j.outputs.map((o) => o.name).join("、")}` : "";
				return `- ${j.id} ${j.title}: ${unknown ? "结果未知" : STATUS_LABEL[j.status]}（${j.status}）${j.attempts > 1 ? `（第 ${j.attempts} 次）` : ""}${j.error ? ` — ${j.error}` : ""}${out}${j.summary ? `\n  ${j.summary.split("\n").slice(-5).join("\n  ")}` : ""}`;
			};
			const text = list.length ? list.map(line).join("\n") : "（没有后台任务）";
			return { output: [{ type: "text", text }], details: { jobs: json(list) } };
		},
	});

	const cancel = defineTool({
		name: "job_cancel",
		description: "取消本会话的后台任务。",
		parameters: obj({ jobId: str() }),
		replay: "safe",
		async execute(args, api, context) {
			const actor = await resolve(api, context);
			const r = jobs().row(args.jobId);
			if (!r || r.space_id !== actor.space.id || r.conversation_id !== actor.conversationId) throw new HttpError(404, "not_found", "本会话没有这个任务");
			const j = await jobs().cancel(actor.principal, args.jobId);
			return { output: [{ type: "text", text: `任务 ${j.id}：${j.status}` }], details: { job: json(j) } };
		},
	});

	return defineExtension({ name: "wr.jobs", tools: [start, status, cancel], tasks: [JobTask] });
}
