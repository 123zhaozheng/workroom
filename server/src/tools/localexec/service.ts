// Round 11 (R4): code_run orchestration — settings, per-conversation preference, routing, browser job, cloud execution, automatic upgrade.
// The cloud path is the ordinary sandbox exec path (Sandbox.run → whatever driver/provider the admin configured, lifecycle and prewarm included).
// There is never a fallback to the Workroom host: a cloud failure is a visible error.
import type { AppContext, Principal, Space, ToolActor } from "../../core/contracts.ts";
import { HttpError, newId, nowIso } from "../../core/http.ts";
import type { LocalExecLanguage, LocalExecPreference, LocalExecStatusDTO, LocalFailKind } from "../../../../shared/localexec.ts";
import { MAX_TIMEOUT_MS, type Sandbox } from "../sandbox.ts";
import { workspaceKeyOf, workspacePersistenceFor } from "../sandbox/persist.ts";
import { LocalExecBroker, type BrokerOptions } from "./broker.ts";
import { CAPACITY_FAILURES, decideBackend, FAIL_TEXT, type RouteDecision, type RouteReason } from "./route.ts";

export interface CodeRunArgs {
	language: LocalExecLanguage;
	code: string;
	inputs?: readonly string[];
	timeoutSec?: number;
	/** "cloud" forces the cloud sandbox (e.g. after the browser run could not do what the code needs). */
	backend?: "auto" | "cloud";
}

export interface CodeRunReport {
	backend: "browser" | "cloud";
	reason: RouteReason | "browser_failed";
	why: string;
	status: "ok" | "error" | "timeout" | "killed" | "unknown" | "aborted";
	exitCode?: number | null;
	stdout: string;
	stderr: string;
	returnValue?: string;
	durationMs: number;
	/** Output files stored in the host workspace (browser runs), relative paths. */
	files: { path: string; size: number }[];
	rejectedFiles: { path: string; reason: string }[];
	notes: string[];
	/** Set when a browser run was given up on and the code ran in the cloud instead. */
	upgraded?: { from: "browser"; fail: LocalFailKind; message: string };
	cloudRunId?: string;
}

export interface CloudRunInput {
	principal: Principal;
	space: Space;
	conversationId: number;
	taskId?: number;
	callId?: string;
	/** The launcher language of the ordinary sandbox exec path (the user code itself sits in a hidden workspace file). */
	language: "node" | "python";
	code: string;
	timeoutMs: number;
	signal?: AbortSignal;
}
export type CloudRunner = (input: CloudRunInput) => Promise<{ id: string; status: string; exitCode?: number | null; stdout: string; stderr: string; durationMs?: number }>;

const RETURN_MARK = "@@wr-return@@";
export const RUN_DIR = ".wr-run";

/** JavaScript wrapper for the cloud: the SAME contract as the browser runtime (async function body, `files` API, `return` value). */
export function jsWrapper(code: string): string {
	return `import { createRequire } from "node:module";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, relative, resolve, sep } from "node:path";
const root = process.cwd();
const safe = (p) => { const r = resolve(root, String(p).replace(/^\\/work(?=\\/|$)/, "")); if (r !== root && !r.startsWith(root + sep)) throw new Error("path is outside the working directory: " + p); return r; };
const files = {
  async read(p, enc = "utf8") { const b = await readFile(safe(p)); return enc === "bytes" ? new Uint8Array(b) : b.toString(enc); },
  async write(p, data) { const f = safe(p); await mkdir(dirname(f), { recursive: true }); await writeFile(f, typeof data === "string" ? data : new Uint8Array(data.buffer ?? data)); },
  async list() { const out = []; const walk = async (d) => { for (const e of await readdir(d, { withFileTypes: true })) { const f = resolve(d, e.name); if (e.name === ${JSON.stringify(RUN_DIR)}) continue; if (e.isDirectory()) await walk(f); else out.push(relative(root, f).split(sep).join("/")); } }; await walk(root); return out; },
};
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let value;
try { value = await new AsyncFunction("files", "require", ${JSON.stringify(code)})(files, createRequire(pathToFileURL(root + sep))); }
catch (e) { console.error(e && e.stack ? e.stack : String(e)); process.exitCode = 1; }
if (value !== undefined) { let j; try { j = JSON.stringify(value); } catch { j = String(value); } if (j !== undefined) console.log(${JSON.stringify(`\n${RETURN_MARK}`)} + j); }
`;
}

export class LocalExec {
	readonly broker: LocalExecBroker;
	/** Languages the browser runtime can run in this build (python only when the runtime proves it can serve it without network access). */
	browserLanguages: LocalExecLanguage[] = ["javascript", "python"];
	readonly #ctx: AppContext;
	#cloud?: CloudRunner;

	constructor(ctx: AppContext, opts: { broker?: BrokerOptions; cloud?: CloudRunner; browserLanguages?: LocalExecLanguage[] } = {}) {
		this.#ctx = ctx;
		this.broker = new LocalExecBroker(opts.broker);
		this.#cloud = opts.cloud;
		if (opts.browserLanguages) this.browserLanguages = opts.browserLanguages;
	}
	get #sb(): Sandbox {
		return this.#ctx.services.get("sandbox") as Sandbox;
	}
	/** Test hook: replace the cloud executor. */
	setCloudRunner(fn: CloudRunner | undefined): void {
		this.#cloud = fn;
	}

	// ---------------------------------------------------------------- settings (tool_sandbox_settings rows, no new table)
	enabled(orgId: string): boolean {
		const r = this.#ctx.db.get<{ value: string }>("SELECT value FROM tool_sandbox_settings WHERE key = ?", `local_exec:${orgId}`);
		if (!r) return true; // default on
		try {
			return JSON.parse(r.value).enabled !== false;
		} catch {
			return true;
		}
	}
	setEnabled(p: Principal, enabled: boolean): boolean {
		this.#ctx.db.run("INSERT INTO tool_sandbox_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at", `local_exec:${p.orgId}`, JSON.stringify({ enabled }), p.userId, nowIso());
		return this.enabled(p.orgId);
	}
	/** What a conversation without an explicit choice prefers. Round 12: "cloud" — the 本地环境 option is greyed out until the desktop app ships. */
	defaultPreference: LocalExecPreference = "cloud";
	preference(spaceId: string, conversationId: number): LocalExecPreference {
		const r = this.#ctx.db.get<{ value: string }>("SELECT value FROM tool_sandbox_settings WHERE key = ?", `local_pref:${spaceId}:${conversationId}`);
		return r?.value === "local" || r?.value === "cloud" ? r.value : this.defaultPreference;
	}
	setPreference(p: Principal, spaceId: string, conversationId: number, pref: LocalExecPreference): LocalExecPreference {
		if (pref !== "local" && pref !== "cloud") throw new HttpError(400, "invalid", "preference 只能是 local 或 cloud");
		if (!Number.isInteger(conversationId) || conversationId <= 0) throw new HttpError(400, "invalid", "会话 id 无效");
		this.#ctx.db.run("INSERT INTO tool_sandbox_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at", `local_pref:${spaceId}:${conversationId}`, pref, p.userId, nowIso());
		return this.preference(spaceId, conversationId);
	}
	status(p: Principal, spaceId: string, conversationId: number): LocalExecStatusDTO {
		return { enabled: this.enabled(p.orgId), connected: this.broker.connected(spaceId, conversationId, p.userId), preference: this.preference(spaceId, conversationId) };
	}

	// ---------------------------------------------------------------- code_run
	async run(a: { actor: ToolActor; args: CodeRunArgs; signal?: AbortSignal }): Promise<CodeRunReport> {
		const { actor, args } = a;
		if (args.language !== "javascript" && args.language !== "python") throw new HttpError(400, "bad_language", "language 必须是 javascript 或 python");
		if (typeof args.code !== "string" || !args.code.trim()) throw new HttpError(400, "invalid", "code 不能为空");
		if (args.code.length > 200_000) throw new HttpError(413, "too_large", "代码过长（上限 200000 字符）");
		const timeoutSec = Math.min(Math.max(Math.round(args.timeoutSec ?? 20), 1), MAX_TIMEOUT_MS / 1000);
		const paths = [...new Set((args.inputs ?? []).map(String))];
		if (paths.length > 20) throw new HttpError(400, "invalid", "inputs 最多 20 个文件");
		// Inputs are read from the host workspace (authoritative; the cloud sandbox is synced from it). A missing file is a plain error either way.
		const inputs: { path: string; bytes: Uint8Array }[] = [];
		let inputBytes = 0;
		for (const p of paths) {
			const rel = this.#sb.relPath(actor.space, p);
			const f = this.#sb.readFile(actor.space, actor.conversationId, rel, actor.principal); // round 11: memories/ and project/ are routed by principal
			inputs.push({ path: rel, bytes: f.bytes });
			inputBytes += f.bytes.length;
		}
		const decision: RouteDecision = decideBackend({
			enabled: this.enabled(actor.principal.orgId),
			preference: this.preference(actor.space.id, actor.conversationId),
			forceCloud: args.backend === "cloud",
			language: args.language,
			code: args.code,
			inputBytes,
			timeoutSec,
			tabConnected: this.broker.connected(actor.space.id, actor.conversationId, actor.principal.userId),
			browserLanguages: this.browserLanguages,
		});
		const notes: string[] = [];
		if (decision.backend === "cloud") return this.#cloudRun(actor, args, timeoutSec, { reason: decision.reason, why: decision.why + (decision.match ? `（${decision.match}）` : ""), notes, signal: a.signal });

		// ---- browser
		const started = Date.now();
		const { outcome } = this.broker.dispatch({
			spaceId: actor.space.id,
			conversationId: actor.conversationId,
			userId: actor.principal.userId,
			language: args.language,
			code: args.code,
			timeoutSec,
			inputs,
			writeFile: (path, bytes) => this.#sb.writeFile(actor.space, actor.conversationId, path, bytes, actor.principal),
			signal: a.signal,
		});
		const o = await outcome;
		if (o.kind === "aborted") return { backend: "browser", reason: "ok", why: decision.why, status: "aborted", stdout: "", stderr: "", durationMs: Date.now() - started, files: [], rejectedFiles: [], notes: ["已停止"] };
		if (o.kind === "failed") {
			if (!CAPACITY_FAILURES.has(o.fail)) return { backend: "browser", reason: "ok", why: decision.why, status: "error", stdout: "", stderr: o.message, durationMs: Date.now() - started, files: [], rejectedFiles: [], notes };
			const text = FAIL_TEXT[o.fail] ?? o.fail;
			notes.push(`浏览器内运行失败（${text}），已自动改在云端沙箱重新运行一次`);
			const r = await this.#cloudRun(actor, args, timeoutSec, { reason: "browser_failed", why: `浏览器内运行失败（${text}）`, notes, signal: a.signal });
			return { ...r, upgraded: { from: "browser", fail: o.fail, message: o.message } };
		}
		const r = o.result;
		if (o.written.length) await workspacePersistenceFor(this.#ctx).commit(actor.principal, actor.space, workspaceKeyOf(actor.conversationId), "file_write").catch((e) => console.error("[localexec] commit failed", e));
		const failed = !r.ok || o.rejected.length > 0;
		return {
			backend: "browser",
			reason: "ok",
			why: decision.why,
			status: failed ? "error" : "ok",
			stdout: r.stdout ?? "",
			stderr: [r.stderr ?? "", !r.ok && r.error?.message ? r.error.message : ""].filter(Boolean).join("\n"),
			...(r.returnValue !== undefined ? { returnValue: r.returnValue } : {}),
			durationMs: r.durationMs ?? Date.now() - started,
			files: o.written,
			rejectedFiles: o.rejected,
			notes,
		};
	}

	async #cloudRun(actor: ToolActor, args: CodeRunArgs, timeoutSec: number, c: { reason: CodeRunReport["reason"]; why: string; notes: string[]; signal?: AbortSignal }): Promise<CodeRunReport> {
		const ext = args.language === "javascript" ? "mjs" : "py";
		const rel = `${RUN_DIR}/${newId("r")}.${ext}`;
		const source = args.language === "javascript" ? jsWrapper(args.code) : args.code;
		// The code lives in the host workspace (hidden temp path); a remote sandbox receives it with the ordinary workspace sync.
		this.#sb.writeFile(actor.space, actor.conversationId, rel, new TextEncoder().encode(source));
		const run = (this.#cloud ?? ((i: CloudRunInput) => this.#sb.run(i as any)))({
			principal: actor.principal,
			space: actor.space,
			conversationId: actor.conversationId,
			taskId: actor.taskId,
			callId: actor.callId,
			language: args.language === "javascript" ? "node" : "python",
			// A two-line launcher: the sandbox's own node / python (whatever the driver or provider mounts) runs the hidden file from the working directory.
			code: args.language === "javascript" ? `import { pathToFileURL } from "node:url";\nawait import(new URL(${JSON.stringify(rel)}, pathToFileURL(process.cwd() + "/")).href);\n` : `import runpy\nrunpy.run_path(${JSON.stringify(rel)}, run_name="__main__")\n`,
			timeoutMs: timeoutSec * 1000,
			signal: c.signal,
		});
		let r: Awaited<typeof run>;
		try {
			r = await run;
		} finally {
			try {
				this.#sb.remove(actor.space, actor.conversationId, rel);
			} catch {
				/* the temp file may already be gone */
			}
		}
		let stdout = r.stdout;
		let returnValue: string | undefined;
		const at = stdout.lastIndexOf(RETURN_MARK);
		if (at >= 0) {
			returnValue = stdout.slice(at + RETURN_MARK.length).trim();
			stdout = stdout.slice(0, at).replace(/\n$/, "");
		}
		return {
			backend: "cloud",
			reason: c.reason,
			why: c.why,
			status: r.status as CodeRunReport["status"],
			exitCode: r.exitCode,
			stdout,
			stderr: r.stderr,
			...(returnValue !== undefined ? { returnValue } : {}),
			durationMs: r.durationMs ?? 0,
			files: [],
			rejectedFiles: [],
			notes: c.notes,
			cloudRunId: r.id,
		};
	}

	/** Plain text for the model. First line says where it ran and why. */
	static text(r: CodeRunReport): string {
		const where = r.backend === "browser" ? `backend: browser（在用户浏览器的隔离环境内运行；${r.why}）` : `backend: cloud（云端沙箱；${r.why}）`;
		return [
			where,
			...r.notes.map((n) => `note: ${n}`),
			`status: ${r.status}${r.exitCode !== undefined && r.exitCode !== null ? ` (exit ${r.exitCode})` : ""}, ${r.durationMs} ms`,
			r.stdout ? `stdout:\n${r.stdout}` : "",
			r.stderr ? `stderr:\n${r.stderr}` : "",
			r.returnValue !== undefined ? `return: ${r.returnValue}` : "",
			r.files.length ? `files written: ${r.files.map((f) => `${f.path} (${f.size} B)`).join(", ")}` : "",
			r.rejectedFiles.length ? `files NOT written: ${r.rejectedFiles.map((f) => `${f.path}: ${f.reason}`).join("; ")}` : "",
		]
			.filter(Boolean)
			.join("\n");
	}
}
