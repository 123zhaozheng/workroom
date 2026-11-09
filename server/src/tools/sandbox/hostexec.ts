// Run a trusted host program (LibreOffice, pdftoppm, …) WITHOUT a sandbox but with the guard rails a server needs: no shell, clean
// environment, wall-clock timeout that kills the whole process tree (taskkill /T on Windows, process group elsewhere), output cap.
// For server-internal jobs on hosts where no sandbox driver can provide the tool (e.g. soffice.exe on Windows). It is NOT isolation: callers
// must opt in explicitly (see docs/requests/sandbox.md — pptx preview rendering) because the input documents are untrusted.
import { spawn, spawnSync } from "node:child_process";
import type { RunResult } from "./driver.ts";
import { capped } from "./util.ts";

const KEEP_ENV = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "LANG", "LC_ALL"];

export function killTree(pid: number | undefined): void {
	if (!pid) return;
	try {
		if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 });
		else process.kill(-pid, "SIGKILL");
	} catch {
		/* already gone */
	}
}

export function runHost(argv: readonly string[], opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; signal?: AbortSignal } = {}): Promise<RunResult> {
	const [bin, ...args] = argv;
	const started = Date.now();
	if (!bin) return Promise.resolve({ status: "error", exitCode: null, stdout: "", stderr: "empty command", durationMs: 0 });
	const env: Record<string, string> = {};
	for (const k of KEEP_ENV) if (process.env[k] !== undefined) env[k] = process.env[k]!;
	Object.assign(env, opts.env);
	const out = capped();
	const err = capped();
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(bin, args, { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32", shell: false });
		} catch (e: any) {
			return resolve({ status: "error", exitCode: null, stdout: "", stderr: String(e?.message ?? e), durationMs: 0 });
		}
		let timedOut = false;
		let aborted = false;
		let done = false;
		const kill = () => killTree(child.pid);
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, opts.timeoutMs ?? 60_000);
		const onAbort = () => {
			aborted = true;
			kill();
		};
		if (opts.signal?.aborted) onAbort();
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (b: Buffer) => out.push(b));
		child.stderr.on("data", (b: Buffer) => err.push(b));
		const finish = (code: number | null, extra = "") => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			kill(); // stragglers (e.g. a LibreOffice helper left running)
			const status = timedOut ? "timeout" : aborted ? "killed" : code === 0 ? "ok" : "error";
			resolve({ status, exitCode: code, stdout: out.text(), stderr: `${err.text()}${extra}${timedOut ? `\n[host] 超过时间限制 ${opts.timeoutMs ?? 60_000} ms，已终止进程树` : ""}`, durationMs: Date.now() - started });
		};
		child.on("error", (e) => finish(127, e.message));
		child.on("close", (c) => finish(c));
	});
}
