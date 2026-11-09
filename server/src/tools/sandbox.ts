// Cloud execution sandbox (M11): per-space, per-conversation working directories; shell / Python / Node run inside
// Linux namespaces (user + mount + pid + net + ipc + uts), pivot_root into a minimal read-only system image with only the
// workspace writable, all capabilities dropped, no_new_privs, rlimits (address space, CPU, file size, open files,
// processes), wall-clock timeout that kills the whole namespace, no network by default.
// If the host cannot create these namespaces, execution is refused (never run unisolated).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { AppContext, Principal, Space } from "../core/contracts.ts";
import type { Migration } from "../core/db.ts";
import { HttpError, newId, nowIso } from "../core/http.ts";
import type { SandboxEntryDTO, SandboxInfoDTO, SandboxLimitsDTO, SandboxRunDTO } from "../../../shared/files.ts";

export const SANDBOX_MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "sandbox runs",
		sql: `
CREATE TABLE tool_sandbox_runs (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  conversation_id INTEGER,
  task_id INTEGER,
  call_id TEXT,
  user_id TEXT NOT NULL,
  language TEXT NOT NULL,
  code TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER,
  limits TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (space_id, task_id, call_id)
);
CREATE INDEX tool_sandbox_runs_conv ON tool_sandbox_runs(space_id, conversation_id, started_at);
`,
	},
];

export type Language = "shell" | "python" | "node";
export const DEFAULT_LIMITS: SandboxLimitsDTO = {
	timeoutMs: 30_000,
	memoryBytes: 512 * 1024 * 1024,
	cpuSeconds: 30,
	maxFileBytes: 64 * 1024 * 1024,
	maxProcesses: 64,
	network: false,
};
export const MAX_TIMEOUT_MS = 300_000;
export const RETENTION_HOURS = Number(process.env.WORKROOM_SANDBOX_RETENTION_HOURS ?? 72);
export const QUOTA_BYTES = Number(process.env.WORKROOM_SANDBOX_QUOTA_MB ?? 512) * 1024 * 1024;
const OUTPUT_CAP = 256 * 1024;

export const ISOLATION_TEXT =
	"Linux 命名空间：独立 user/mount/pid/net/ipc/uts；pivot_root 到最小只读系统镜像（/usr、必要的 /etc 文件、运行时），仅 /work（本会话工作目录）可写，/tmp 为内存盘；" +
	"丢弃全部 capabilities 并设置 no_new_privs；rlimit 限制地址空间、CPU 秒、单文件大小、打开文件数与进程数；超时杀死整个 pid 命名空间；默认无网络（只有 lo）。" +
	"不是虚拟机：与宿主共享内核，内核漏洞可逃逸；没有 cgroup 内存/IO 总量限制（单进程地址空间受限）；工作目录总量为运行前后检查的软配额。";

// The in-namespace bootstrap. Runs as uid 0 *inside* a fresh user namespace (mapped to the server's uid), builds the root,
// pivots into it, drops every capability and execs the program with rlimits. Arguments: ROOT WORK CODE RUNTIME NPROC AS CPU FSIZE -- argv...
const BOOT = String.raw`set -eu
ROOT=$1; WORK=$2; CODE=$3; RUNTIME=$4; NPROC=$5; AS=$6; CPU=$7; FSIZE=$8; shift 8; [ "$1" = "--" ] && shift
mount --make-rprivate /
mount -t tmpfs -o size=16m,mode=755 tmpfs "$ROOT"
for d in usr bin lib lib64 sbin; do
  if [ -L "/$d" ]; then ln -s "$(readlink "/$d")" "$ROOT/$d";
  elif [ -d "/$d" ]; then mkdir -p "$ROOT/$d"; mount --rbind "/$d" "$ROOT/$d"; mount -o remount,bind,ro "$ROOT/$d"; fi
done
mkdir -p "$ROOT/etc" "$ROOT/work" "$ROOT/code" "$ROOT/tmp" "$ROOT/proc" "$ROOT/dev" "$ROOT/runtime"
for f in passwd group hosts nsswitch.conf ld.so.cache ld.so.conf localtime mime.types; do
  if [ -e "/etc/$f" ]; then touch "$ROOT/etc/$f" 2>/dev/null || true; [ -d "/etc/$f" ] || mount --bind "/etc/$f" "$ROOT/etc/$f"; fi
done
for d in ld.so.conf.d ssl alternatives fonts; do
  if [ -d "/etc/$d" ]; then mkdir -p "$ROOT/etc/$d"; mount --rbind "/etc/$d" "$ROOT/etc/$d"; mount -o remount,bind,ro "$ROOT/etc/$d"; fi
done
mount --bind "$WORK" "$ROOT/work"
mount --bind "$CODE" "$ROOT/code"; mount -o remount,bind,ro "$ROOT/code"
if [ -n "$RUNTIME" ] && [ -d "$RUNTIME" ]; then mount --rbind "$RUNTIME" "$ROOT/runtime"; mount -o remount,bind,ro "$ROOT/runtime"; fi
mount -t tmpfs -o size=64m tmpfs "$ROOT/tmp"
mount -t proc -o nosuid,nodev,noexec proc "$ROOT/proc"
for n in null zero urandom random; do touch "$ROOT/dev/$n"; mount --bind "/dev/$n" "$ROOT/dev/$n"; done
mkdir -p "$ROOT/.old"; mount -o remount,ro "$ROOT"
cd "$ROOT"; pivot_root . .old; umount -l /.old; cd /work
exec /usr/bin/env -i PATH=/runtime/bin:/usr/local/bin:/usr/bin:/bin HOME=/work TMPDIR=/tmp LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1 \
  /usr/bin/prlimit --nproc="$NPROC" --as="$AS" --cpu="$CPU" --fsize="$FSIZE" --nofile=256 --core=0 -- \
  /usr/bin/setpriv --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all -- "$@"`;

let probed: { ok: boolean; detail: string } | undefined;
/** Whether this host can build the namespace sandbox (cached). */
export function probeIsolation(): { ok: boolean; detail: string } {
	if (probed) return probed;
	const tools = ["/usr/bin/unshare", "/usr/bin/prlimit", "/usr/bin/setpriv"].filter((p) => !existsSync(p));
	if (tools.length) return (probed = { ok: false, detail: `缺少 ${tools.join(", ")}` });
	const r = spawnSync("/usr/bin/unshare", ["--user", "--map-root-user", "--mount", "--pid", "--fork", "--net", "--ipc", "--uts", "--kill-child", "/bin/sh", "-c", "mount -t tmpfs tmpfs /mnt && echo ok"], { encoding: "utf8", timeout: 10_000 });
	probed = r.stdout?.trim() === "ok" ? { ok: true, detail: "namespaces available" } : { ok: false, detail: `无法创建隔离命名空间：${(r.stderr || r.error?.message || "unknown").slice(0, 200)}` };
	return probed;
}

/** Processes currently owned by our uid (RLIMIT_NPROC counts them all, so the limit is relative). */
function ownProcessCount(): number {
	const uid = process.getuid?.() ?? 0;
	let n = 0;
	for (const d of readdirSync("/proc")) {
		if (!/^\d+$/.test(d)) continue;
		try {
			if (statSync(`/proc/${d}`).uid === uid) n++;
		} catch {
			/* raced */
		}
	}
	return n;
}

export interface RunResult {
	status: "ok" | "error" | "timeout" | "killed";
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
}

function capped(): { push(b: Buffer): void; text(): string } {
	const parts: Buffer[] = [];
	let size = 0;
	let dropped = 0;
	return {
		push(b) {
			if (size >= OUTPUT_CAP) {
				dropped += b.length;
				return;
			}
			const take = b.subarray(0, OUTPUT_CAP - size);
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

function dirSize(p: string): number {
	let n = 0;
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const f = join(d, e.name);
			if (e.isDirectory()) walk(f);
			else if (e.isFile()) n += lstatSync(f).size;
		}
	};
	if (existsSync(p)) walk(p);
	return n;
}

export class Sandbox {
	readonly #ctx: AppContext;
	#timer: NodeJS.Timeout | undefined;
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}

	root(space: Space): string {
		return join(space.dir, "sandbox");
	}
	workdir(space: Space, conversationId: number | undefined): string {
		const d = join(this.root(space), conversationId === undefined ? "shared" : `c${conversationId}`);
		mkdirSync(d, { recursive: true });
		return d;
	}
	/** Resolve a path inside a workdir; refuses escapes (.., absolute, symlinks pointing outside). */
	resolveIn(workdir: string, rel: string): string {
		const p = resolve(workdir, rel.replace(/^\/+(work\/?)?/, ""));
		if (p !== workdir && !p.startsWith(workdir + sep)) throw new HttpError(400, "bad_path", "路径必须在工作目录内");
		if (existsSync(p)) {
			const real = realpathSync(p);
			const realRoot = realpathSync(workdir);
			if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new HttpError(400, "bad_path", "路径指向工作目录之外");
		}
		return p;
	}

	info(space: Space): SandboxInfoDTO {
		const iso = probeIsolation();
		return { spaceId: space.id, isolation: iso.ok ? "namespaces" : "unavailable", isolationDetail: iso.ok ? ISOLATION_TEXT : iso.detail, limits: DEFAULT_LIMITS, retentionHours: RETENTION_HOURS, usedBytes: dirSize(this.root(space)), quotaBytes: QUOTA_BYTES };
	}

	entries(space: Space, conversationId: number | undefined): SandboxEntryDTO[] {
		const wd = this.workdir(space, conversationId);
		const out: SandboxEntryDTO[] = [];
		const walk = (d: string) => {
			for (const e of readdirSync(d, { withFileTypes: true })) {
				if (out.length >= 2000) return;
				const f = join(d, e.name);
				const st = lstatSync(f);
				const rel = relative(wd, f).split(sep).join("/");
				out.push({ path: rel, kind: e.isDirectory() ? "directory" : "file", size: e.isDirectory() ? 0 : st.size, mtime: st.mtime.toISOString(), expiresAt: new Date(st.mtimeMs + RETENTION_HOURS * 3600_000).toISOString() });
				if (e.isDirectory()) walk(f);
			}
		};
		walk(wd);
		return out;
	}

	/** Execute code in the sandbox. Records a run row (idempotent per tool call). */
	async run(input: { principal: Principal; space: Space; conversationId?: number; taskId?: number; callId?: string; language: Language; code: string; timeoutMs?: number; network?: boolean }): Promise<SandboxRunDTO> {
		const iso = probeIsolation();
		if (!iso.ok) throw new HttpError(503, "sandbox_unavailable", `沙箱不可用：${iso.detail}`);
		if (input.network) throw new HttpError(403, "network_disabled", "沙箱默认不允许联网；本部署未开放沙箱网络");
		if (!["shell", "python", "node"].includes(input.language)) throw new HttpError(400, "bad_language", "language 必须是 shell、python 或 node");
		const timeoutMs = Math.min(Math.max(input.timeoutMs ?? DEFAULT_LIMITS.timeoutMs, 1000), MAX_TIMEOUT_MS);
		const limits: SandboxLimitsDTO = { ...DEFAULT_LIMITS, timeoutMs, cpuSeconds: Math.ceil(timeoutMs / 1000) };
		const wd = this.workdir(input.space, input.conversationId);
		const used = dirSize(this.root(input.space));
		if (used > QUOTA_BYTES) throw new HttpError(507, "sandbox_quota", `工作目录已用 ${Math.round(used / 1048576)} MB，超过配额 ${Math.round(QUOTA_BYTES / 1048576)} MB；请先发布需要的文件并清理`);
		const id = newId("run");
		const started = Date.now();
		this.#ctx.db.run(
			"INSERT INTO tool_sandbox_runs (id, space_id, conversation_id, task_id, call_id, user_id, language, code, status, limits, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)",
			id, input.space.id, input.conversationId ?? null, input.taskId ?? null, input.callId ?? null, input.principal.userId, input.language, input.code.slice(0, 200_000), JSON.stringify(limits), nowIso(),
		);
		const r = await this.#exec(input.space, wd, input.language, input.code, limits, id);
		this.#ctx.db.run("UPDATE tool_sandbox_runs SET status = ?, exit_code = ?, stdout = ?, stderr = ?, duration_ms = ?, finished_at = ? WHERE id = ?", r.status, r.exitCode, r.stdout, r.stderr, Date.now() - started, nowIso(), id);
		return this.runDTO(id)!;
	}

	async #exec(space: Space, wd: string, language: Language, code: string, limits: SandboxLimitsDTO, runId: string): Promise<RunResult> {
		const scratch = join(this.root(space), ".runs", runId);
		const rootDir = join(scratch, "root");
		const codeDir = join(scratch, "code");
		mkdirSync(rootDir, { recursive: true });
		mkdirSync(codeDir, { recursive: true });
		const file = language === "python" ? "main.py" : language === "node" ? "main.mjs" : "main.sh";
		writeFileSync(join(codeDir, file), code);
		const nodeRuntime = dirname(dirname(process.execPath));
		const argv = language === "python" ? ["/usr/bin/env", "python3", "/code/main.py"] : language === "node" ? ["/runtime/bin/node", `--max-old-space-size=${Math.floor(limits.memoryBytes / 2 / 1048576)}`, "/code/main.mjs"] : ["/bin/sh", "/code/main.sh"];
		const nproc = ownProcessCount() + limits.maxProcesses;
		const args = [
			"--user", "--map-root-user", "--mount", "--pid", "--fork", "--net", "--ipc", "--uts", "--kill-child",
			"/bin/sh", "-c", BOOT, "wr-sandbox", rootDir, wd, codeDir, language === "node" ? nodeRuntime : "", String(nproc), String(language === "node" ? limits.memoryBytes * 2 : limits.memoryBytes), String(limits.cpuSeconds), String(limits.maxFileBytes), "--", ...argv,
		];
		const started = Date.now();
		const out = capped();
		const err = capped();
		const child = spawn("/usr/bin/unshare", args, { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } });
		child.stdout.on("data", (b: Buffer) => out.push(b));
		child.stderr.on("data", (b: Buffer) => err.push(b));
		let timedOut = false;
		const killAll = () => {
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {
				/* gone */
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killAll();
		}, limits.timeoutMs);
		const { code: exitCode, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => child.on("close", (c, s) => res({ code: c, signal: s })));
		clearTimeout(timer);
		killAll();
		rmSync(scratch, { recursive: true, force: true });
		let stderr = err.text();
		const status: RunResult["status"] = timedOut ? "timeout" : signal ? "killed" : exitCode === 0 ? "ok" : exitCode === 137 || exitCode === 152 ? "killed" : "error";
		if (timedOut) stderr += `\n[sandbox] 超过时间限制 ${limits.timeoutMs} ms，已终止整个进程组`;
		else if (exitCode === 152 || signal === "SIGXCPU") stderr += `\n[sandbox] 超过 CPU 时间限制 ${limits.cpuSeconds} 秒`;
		return { status, exitCode, stdout: out.text(), stderr, durationMs: Date.now() - started };
	}

	runDTO(id: string): SandboxRunDTO | null {
		const r = this.#ctx.db.get<any>("SELECT * FROM tool_sandbox_runs WHERE id = ?", id);
		if (!r) return null;
		return {
			id: r.id,
			spaceId: r.space_id,
			conversationId: r.conversation_id ?? undefined,
			taskId: r.task_id ?? undefined,
			callId: r.call_id ?? undefined,
			userId: r.user_id,
			language: r.language,
			code: r.code,
			status: r.status,
			exitCode: r.exit_code ?? undefined,
			stdout: r.stdout,
			stderr: r.stderr,
			durationMs: r.duration_ms ?? undefined,
			startedAt: r.started_at,
			finishedAt: r.finished_at ?? undefined,
			limits: JSON.parse(r.limits),
			isolation: ISOLATION_TEXT,
		};
	}
	runByCall(spaceId: string, taskId: number, callId: string): SandboxRunDTO | null {
		const r = this.#ctx.db.get<{ id: string }>("SELECT id FROM tool_sandbox_runs WHERE space_id = ? AND task_id = ? AND call_id = ?", spaceId, taskId, callId);
		return r ? this.runDTO(r.id) : null;
	}
	runs(spaceId: string, conversationId?: number, limit = 50): SandboxRunDTO[] {
		const rows = conversationId === undefined
			? this.#ctx.db.all<{ id: string }>("SELECT id FROM tool_sandbox_runs WHERE space_id = ? ORDER BY started_at DESC LIMIT ?", spaceId, limit)
			: this.#ctx.db.all<{ id: string }>("SELECT id FROM tool_sandbox_runs WHERE space_id = ? AND conversation_id = ? ORDER BY started_at DESC LIMIT ?", spaceId, conversationId, limit);
		return rows.map((r) => this.runDTO(r.id)!);
	}

	/** Lifecycle: delete workspace files idle longer than the retention period (published files live on in the library). */
	reap(now = Date.now()): number {
		let removed = 0;
		const orgs = join(this.#ctx.config.dataDir, "orgs");
		if (!existsSync(orgs)) return 0;
		const cutoff = now - RETENTION_HOURS * 3600_000;
		const sweep = (d: string): boolean => {
			let empty = true;
			for (const e of readdirSync(d, { withFileTypes: true })) {
				const f = join(d, e.name);
				if (e.isDirectory()) {
					if (sweep(f)) {
						rmSync(f, { recursive: true, force: true });
					} else empty = false;
				} else if (lstatSync(f).mtimeMs < cutoff) {
					rmSync(f, { force: true });
					removed++;
				} else empty = false;
			}
			return empty;
		};
		for (const org of readdirSync(orgs)) {
			const spaces = join(orgs, org, "spaces");
			if (!existsSync(spaces)) continue;
			for (const s of readdirSync(spaces)) {
				const sb = join(spaces, s, "sandbox");
				if (existsSync(sb)) for (const c of readdirSync(sb)) if (c !== ".runs") sweep(join(sb, c));
			}
		}
		return removed;
	}

	start(): void {
		this.#timer = setInterval(() => {
			try {
				this.reap();
			} catch (e) {
				console.error("[sandbox] reap failed", e);
			}
		}, 3600_000);
		this.#timer.unref();
	}
	stop(): void {
		clearInterval(this.#timer);
	}

	readFile(space: Space, conversationId: number | undefined, path: string): { bytes: Uint8Array; name: string } {
		const p = this.resolveIn(this.workdir(space, conversationId), path);
		if (!existsSync(p) || !statSync(p).isFile()) throw new HttpError(404, "not_found", "文件不存在");
		if (statSync(p).size > 100 * 1024 * 1024) throw new HttpError(413, "too_large", "文件过大");
		return { bytes: new Uint8Array(readFileSync(p)), name: p.split(sep).pop()! };
	}
	writeFile(space: Space, conversationId: number | undefined, path: string, bytes: Uint8Array): string {
		const wd = this.workdir(space, conversationId);
		const p = this.resolveIn(wd, path);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, bytes);
		return relative(wd, p).split(sep).join("/");
	}
}
