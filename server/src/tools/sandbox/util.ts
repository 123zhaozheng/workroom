// Small helpers shared by the sandbox drivers.
import { spawn } from "node:child_process";

export const OUTPUT_CAP = 256 * 1024;

/** Collects output up to a cap (keeps the head) and says how much was dropped. */
export function capped(cap = OUTPUT_CAP): { push(b: Buffer): void; text(): string } {
	const parts: Buffer[] = [];
	let size = 0;
	let dropped = 0;
	return {
		push(b) {
			if (size >= cap) {
				dropped += b.length;
				return;
			}
			const take = b.subarray(0, cap - size);
			parts.push(take);
			size += take.length;
			dropped += b.length - take.length;
		},
		text() {
			const s = Buffer.concat(parts).toString("utf8");
			return dropped ? `${s}\n…（输出过长，已截断 ${dropped} 字节）` : s;
		},
	};
}

/** Keeps the last `cap` bytes (for stderr of long-running services). */
export function tailBuffer(cap = 64 * 1024): { push(b: Buffer): void; text(): string } {
	let buf = Buffer.alloc(0);
	return {
		push(b) {
			buf = buf.length + b.length > cap ? Buffer.concat([buf, b]).subarray(-cap) : Buffer.concat([buf, b]);
		},
		text: () => buf.toString("utf8"),
	};
}

export interface CliResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	error?: string;
}

/** Run a short CLI command to completion (no shell). Never throws: spawn errors come back in `error`. */
export function runCli(bin: string, args: readonly string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string; cwd?: string } = {}): Promise<CliResult> {
	return new Promise((resolve) => {
		let out = "";
		let err = "";
		let timedOut = false;
		let settled = false;
		let child;
		try {
			child = spawn(bin, [...args], { stdio: ["pipe", "pipe", "pipe"], env: opts.env ?? process.env, cwd: opts.cwd, windowsHide: true });
		} catch (e: any) {
			return resolve({ code: null, stdout: "", stderr: "", timedOut: false, error: String(e?.message ?? e) });
		}
		const done = (r: CliResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(r);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, opts.timeoutMs ?? 15_000);
		child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
		child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
		child.on("error", (e) => done({ code: null, stdout: out, stderr: err, timedOut, error: e.message }));
		child.on("close", (code) => done({ code, stdout: out, stderr: err, timedOut }));
		child.stdin.on("error", () => {});
		child.stdin.end(opts.input ?? "");
	});
}

/** Single-quote a string for POSIX sh. */
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Validate user-supplied environment variables for a sandboxed process. */
export function checkEnv(env: Readonly<Record<string, string>>): void {
	for (const [k, v] of Object.entries(env)) {
		if (!ENV_NAME.test(k) || k.startsWith("WR_")) throw new Error(`invalid environment variable name ${JSON.stringify(k)}`);
		if (typeof v !== "string" || v.includes("\0")) throw new Error(`invalid value for ${k}`);
	}
}
