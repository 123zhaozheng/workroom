// Driver `namespaces` (Linux only, no daemon): shell / Python 3 / Node run inside fresh user + mount + pid + net + ipc + uts namespaces,
// pivot_root into a minimal read-only system image with only /work writable, all capabilities dropped, no_new_privs, rlimits,
// wall-clock timeout that kills the whole namespace, no network. If the host cannot create the namespaces the driver reports
// `unavailable` — callers never fall back to running unisolated.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DriverRunSpec, DriverServiceProcess, DriverServiceSpec, DriverStatus, IsolationNotes, ProcessRef, RunResult, SandboxDriver, SandboxMount } from "./driver.ts";
import { capped, checkEnv, shQuote, tailBuffer } from "./util.ts";

export const NAMESPACES_NOTES: IsolationNotes = {
	isolates: [
		"独立 user/mount/pid/net/ipc/uts 命名空间；pivot_root 到最小只读系统镜像（/usr、必要的 /etc 文件、Node 运行时），仅 /work（本会话工作目录）可写，/tmp 为 64 MB 内存盘",
		"看不到数据目录（app.sqlite、blobs、其他空间/会话）、源码、/home、/root",
		"丢弃全部 capabilities 并设置 no_new_privs；rlimit 限制地址空间、CPU 秒、单文件大小、打开文件数、进程数",
		"墙钟超时或取消 → 杀死整个 pid 命名空间（含后台子进程）",
		"无网络（只有未启用的 lo）",
	],
	doesNotIsolate: [
		"不是虚拟机：与宿主共享内核，内核漏洞可逃逸；以服务进程的 uid 映射运行",
		"没有 cgroup：内存/CPU 限制是每进程 rlimit，不是总量；没有 IO/带宽限制",
		"使用宿主机自带的 python3/node 与系统库（版本与可用的数据分析库取决于宿主）",
		"磁盘配额是软配额（运行前后检查）；进程数限制按宿主 uid 计数，是近似值",
		"只有 Linux；Windows 与 macOS 请使用 docker 驱动",
	],
};

// The in-namespace bootstrap. Runs as uid 0 *inside* a fresh user namespace (mapped to the server's uid), builds the root,
// pivots into it, drops every capability and execs the program with rlimits.
// Arguments: ROOT WORK CODE RUNTIME NPROC AS CPU FSIZE -- argv...   Environment: WR_MOUNTS (host\ttarget\tro|rw lines), WR_CWD.
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
for d in ld.so.conf.d ssl alternatives fonts libreoffice; do
  if [ -d "/etc/$d" ]; then mkdir -p "$ROOT/etc/$d"; mount --rbind "/etc/$d" "$ROOT/etc/$d"; mount -o remount,bind,ro "$ROOT/etc/$d"; fi
done
mount --bind "$WORK" "$ROOT/work"
mount --bind "$CODE" "$ROOT/code"; mount -o remount,bind,ro "$ROOT/code"
if [ -n "$RUNTIME" ] && [ -d "$RUNTIME" ]; then mount --rbind "$RUNTIME" "$ROOT/runtime"; mount -o remount,bind,ro "$ROOT/runtime"; fi
if [ -n "\${WR_MOUNTS:-}" ]; then
  TAB="$(printf '\t')"
  while IFS="$TAB" read -r mh mt mro; do
    [ -n "$mh" ] || continue
    mkdir -p "$ROOT$mt"; mount --rbind "$mh" "$ROOT$mt"
    if [ "$mro" = ro ]; then mount -o remount,bind,ro "$ROOT$mt"; fi
  done <<WRMOUNTS
$WR_MOUNTS
WRMOUNTS
fi
mount -t tmpfs -o size=64m tmpfs "$ROOT/tmp"
mount -t proc -o nosuid,nodev,noexec proc "$ROOT/proc"
for n in null zero urandom random; do touch "$ROOT/dev/$n"; mount --bind "/dev/$n" "$ROOT/dev/$n"; done
mkdir -p "$ROOT/.old"; mount -o remount,ro "$ROOT"
CWD="\${WR_CWD:-/work}"
cd "$ROOT"; pivot_root . .old; umount -l /.old; cd "$CWD"
# Not exec'd: the shell stays pid 1 so a program killed by a signal (e.g. SIGXCPU) yields a normal 128+N exit status.
/usr/bin/env -i PATH=/runtime/bin:/usr/local/bin:/usr/bin:/bin HOME=/work TMPDIR=/tmp LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1 \
  /usr/bin/prlimit --nproc="$NPROC" --as="$AS" --cpu="$CPU:$((CPU + 2))" --fsize="$FSIZE" --nofile=256 --core=0 -- \
  /usr/bin/setpriv --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all -- /bin/sh /code/launch.sh "$@"
exit $?`.replace(/\\\$/g, "$");

let probed: { ok: boolean; detail: string } | undefined;
/** Whether this host can build the namespace sandbox (cached, synchronous: spawns `unshare` once). */
export function probeNamespaces(): { ok: boolean; detail: string } {
	if (probed) return probed;
	if (process.platform !== "linux") return (probed = { ok: false, detail: `命名空间驱动只支持 Linux（当前为 ${process.platform}）` });
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

/** Kill a sandbox process group left behind by a previous process (crash/restart), if it is still ours. */
export function killStaleNamespaces(pid: number | null | undefined): boolean {
	if (!pid || process.platform !== "linux") return false;
	try {
		const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
		if (!cmd.includes("wr-sandbox")) return false;
		process.kill(-pid, "SIGKILL");
		return true;
	} catch {
		return false;
	}
}

function mountLines(mounts: readonly SandboxMount[]): string {
	for (const m of mounts) if (/[\t\r\n\0]/.test(m.hostPath) || /[\t\r\n\0]/.test(m.target)) throw new Error("mount path contains control characters");
	return mounts.map((m) => `${m.hostPath}\t${m.target}\t${m.readOnly ? "ro" : "rw"}`).join("\n");
}

interface Prepared {
	scratch: string;
	args: string[];
	env: NodeJS.ProcessEnv;
}

function prepare(opts: { scratchBase: string; id: string; workdir: string; argv: readonly string[]; code?: { file: string; text: string }; runtime: "python" | "node" | "shell"; limits: DriverRunSpec["limits"]; mounts: readonly SandboxMount[]; env: Readonly<Record<string, string>>; cwd?: string }): Prepared {
	checkEnv(opts.env);
	const scratch = join(opts.scratchBase, ".runs", opts.id);
	const rootDir = join(scratch, "root");
	const codeDir = join(scratch, "code");
	mkdirSync(rootDir, { recursive: true });
	mkdirSync(codeDir, { recursive: true });
	if (opts.code) writeFileSync(join(codeDir, opts.code.file), opts.code.text);
	const exports = Object.entries(opts.env).map(([k, v]) => `export ${k}=${shQuote(v)}`).join("\n");
	writeFileSync(join(codeDir, "launch.sh"), `${exports}\nexec "$@"\n`);
	const needsNode = opts.runtime === "node";
	const nodeRuntime = dirname(dirname(process.execPath));
	const l = opts.limits;
	const nproc = ownProcessCount() + l.maxProcesses;
	const args = [
		"--user", "--map-root-user", "--mount", "--pid", "--fork", "--net", "--ipc", "--uts", "--kill-child",
		"/bin/sh", "-c", BOOT, "wr-sandbox", rootDir, opts.workdir, codeDir, needsNode ? nodeRuntime : "", String(nproc), String(needsNode ? l.memoryBytes * 2 : l.memoryBytes), String(l.cpuSeconds), String(l.maxFileBytes), "--", ...opts.argv,
	];
	const env: NodeJS.ProcessEnv = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", WR_MOUNTS: mountLines(opts.mounts), ...(opts.cwd ? { WR_CWD: opts.cwd } : {}) };
	return { scratch, args, env };
}

function programFor(spec: DriverRunSpec): { argv: string[]; code?: { file: string; text: string }; runtime: "python" | "node" | "shell" } {
	if ("language" in spec.exec) {
		const { language, code } = spec.exec;
		const file = language === "python" ? "main.py" : language === "node" ? "main.mjs" : "main.sh";
		const argv = language === "python" ? ["/usr/bin/env", "python3", "/code/main.py"] : language === "node" ? ["/runtime/bin/node", `--max-old-space-size=${Math.floor(spec.limits.memoryBytes / 2 / 1048576)}`, "/code/main.mjs"] : ["/bin/sh", "/code/main.sh"];
		return { argv, code: { file, text: code }, runtime: language };
	}
	return { argv: [...spec.exec.argv], runtime: spec.exec.runtime ?? (spec.exec.argv[0]?.includes("node") ? "node" : "shell") };
}

class NamespaceDriver implements SandboxDriver {
	readonly id = "namespaces" as const;
	readonly label = "Linux 命名空间";
	readonly capabilities = { network: false, services: true, mounts: true, cgroupLimits: false, hostRuntimes: true };
	readonly notes = NAMESPACES_NOTES;

	async detect(): Promise<DriverStatus> {
		const p = probeNamespaces();
		const checkedAt = new Date().toISOString();
		if (p.ok) return { id: "namespaces", state: "ready", summary: "Linux 命名空间可用", details: ["unshare + prlimit + setpriv 可用，已成功创建 user/mount/pid/net 命名空间"], checkedAt };
		return { id: "namespaces", state: "unavailable", summary: "此主机不能使用命名空间沙箱", details: [p.detail], howToEnable: process.platform === "linux" ? "需要 Linux 内核允许非特权 user namespace（sysctl kernel.unprivileged_userns_clone=1 / user.max_user_namespaces>0，AppArmor 不得限制），并安装 util-linux（unshare、prlimit、setpriv）。无法满足时请改用 docker 驱动。" : "命名空间驱动只支持 Linux。请安装 Docker Desktop（Windows / macOS）并使用 docker 驱动。", checkedAt };
	}

	async run(spec: DriverRunSpec): Promise<RunResult> {
		const prog = programFor(spec);
		const prep = prepare({ scratchBase: spec.scratchBase, id: spec.runId, workdir: spec.workdir, argv: prog.argv, code: prog.code, runtime: prog.runtime, limits: spec.limits, mounts: spec.mounts, env: spec.env });
		const started = Date.now();
		const out = capped();
		const err = capped();
		const child = spawn("/usr/bin/unshare", prep.args, { detached: true, stdio: ["ignore", "pipe", "pipe"], env: prep.env });
		if (child.pid) spec.onSpawn?.({ driver: "namespaces", pid: child.pid });
		child.stdout.on("data", (b: Buffer) => out.push(b));
		child.stderr.on("data", (b: Buffer) => err.push(b));
		const killAll = () => {
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {
				/* gone */
			}
		};
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			killAll();
		}, spec.limits.timeoutMs);
		// Cancellation (run aborted by the user / harness closing) kills the whole namespace too.
		let cancelled = false;
		const onAbort = () => {
			cancelled = true;
			killAll();
		};
		if (spec.signal?.aborted) onAbort();
		spec.signal?.addEventListener("abort", onAbort, { once: true });
		const { code: exitCode, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
			child.on("error", () => res({ code: 127, signal: null }));
			child.on("close", (c, s) => res({ code: c, signal: s }));
		});
		clearTimeout(timer);
		spec.signal?.removeEventListener("abort", onAbort);
		killAll();
		rmSync(prep.scratch, { recursive: true, force: true });
		let stderr = err.text();
		const status: RunResult["status"] = timedOut ? "timeout" : cancelled || signal ? "killed" : exitCode === 0 ? "ok" : exitCode === 137 || exitCode === 152 ? "killed" : "error";
		if (timedOut) stderr += `\n[sandbox] 超过时间限制 ${spec.limits.timeoutMs} ms，已终止整个进程组`;
		else if (cancelled) stderr += "\n[sandbox] 运行已被取消，已终止整个进程组";
		else if (exitCode === 152 || signal === "SIGXCPU") stderr += `\n[sandbox] 超过 CPU 时间限制 ${spec.limits.cpuSeconds} 秒`;
		return { status, exitCode, stdout: out.text(), stderr, durationMs: Date.now() - started };
	}

	async startService(spec: DriverServiceSpec): Promise<DriverServiceProcess> {
		const prep = prepare({ scratchBase: spec.scratchBase, id: spec.serviceId, workdir: spec.workdir, argv: spec.argv, runtime: spec.runtime, limits: spec.limits, mounts: spec.mounts, env: spec.env, cwd: spec.cwd });
		const child = spawn("/usr/bin/unshare", prep.args, { detached: true, stdio: ["pipe", "pipe", "pipe"], env: prep.env });
		const ref: ProcessRef = { driver: "namespaces", pid: child.pid };
		if (child.pid) spec.onSpawn?.(ref);
		const killAll = () => {
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {
				/* gone */
			}
		};
		const exited = new Promise<{ exitCode: number | null; signal: string | null }>((res) => {
			child.on("error", () => res({ exitCode: 127, signal: null }));
			child.on("close", (c, s) => res({ exitCode: c, signal: s }));
		}).then((r) => {
			killAll();
			rmSync(prep.scratch, { recursive: true, force: true });
			return r;
		});
		child.stdin.on("error", () => {});
		return {
			ref,
			stdin: child.stdin!,
			stdout: child.stdout!,
			stderr: child.stderr!,
			exited,
			async kill() {
				killAll();
				await exited;
			},
		};
	}

	async reapStale(): Promise<number> {
		return 0; // namespace sandboxes are children of the server (--kill-child); individual leftovers are killed through killStale(pid) by job recovery.
	}
	async killStale(ref: ProcessRef): Promise<boolean> {
		return killStaleNamespaces(ref.pid);
	}
}

export const namespaceDriver: SandboxDriver = new NamespaceDriver();
