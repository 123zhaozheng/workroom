// Driver `docker`: one throw-away container per run, driven through the docker CLI (Docker Desktop on Windows and macOS —
// on Windows the CLI talks to the daemon over `npipe:////./pipe/docker_engine` by itself — or Docker Engine on Linux; `DOCKER_HOST`
// and docker contexts are honoured because we only ever exec the CLI).
//
// Per container: pinned image (python3 + node + data libs, see server/sandbox/Dockerfile; public slim images as fallback),
// the network chosen by the DEPLOYMENT (env WORKROOM_DOCKER_NETWORK, default Docker's own `bridge`; there is no per-user or per-admin switch),
// memory/CPU/pids limits (cgroups), read-only root fs, non-root user, all capabilities dropped + no-new-privileges, `/work` = the conversation workspace (bind), `/tmp` = tmpfs, `/code` (and extra mounts) read-only.
// The container is always removed (explicit `rm -f` after every run, a startup reaper for orphans labelled `workroom.sandbox=1`).
import { spawn, type ChildProcess } from "node:child_process";
import { chownSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError } from "../../core/http.ts";
import { storeMounts, type DriverRunSpec, type DriverServiceProcess, type DriverServiceSpec, type DriverStatus, type IsolationNotes, type ProcessRef, type RunResult, type SandboxDriver, type SandboxMount, type ServiceRuntime } from "./driver.ts";
import { bindMountArg, dockerSearchDirs, findExecutable, toDockerHostPath } from "./paths.ts";
import { capped, checkEnv, runCli } from "./util.ts";

// Public fallback images, pinned by digest (multi-arch index digests, python 3.12-slim / node 22-slim, pulled 2026-11-09). Bump deliberately.
export const FALLBACK_PYTHON_IMAGE = "python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b";
export const FALLBACK_NODE_IMAGE = "node:22-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d";
export const DEFAULT_IMAGE = "workroom/sandbox:1";
export const CONTAINER_UID = 10001;

export interface DockerSettings {
	/** docker CLI path (default: PATH + usual install dirs). */
	bin?: string;
	/** Value for DOCKER_HOST (default: the CLI's current context). */
	host?: string;
	/** Preferred image with python3 + node + data libs. */
	image: string;
	pythonImage: string;
	nodeImage: string;
	/** CPU quota per container (fractions allowed). */
	cpus: number;
	/** Pull missing fallback images automatically on first use. */
	autoPull: boolean;
}

/**
 * Deployment-level network of the sandbox containers. Round 9: Workroom no longer has a "no network" policy of its own; containers join
 * Docker's default `bridge` network (internet reachable) unless the operator sets WORKROOM_DOCKER_NETWORK to `none` (really offline) or to the
 * name of a user-defined Docker network (e.g. one whose egress the operator restricts with firewall rules). Read at call time (no restart for tests).
 * `host` (shares the server's network stack, including its loopback services) and `container:*` are refused: an invalid value fails closed to `none`.
 */
export interface DockerNetworkChoice {
	readonly name: string;
	readonly source: "default" | "env" | "invalid";
	readonly warning?: string;
}
export function dockerNetworkChoice(env: NodeJS.ProcessEnv = process.env): DockerNetworkChoice {
	const raw = (env.WORKROOM_DOCKER_NETWORK ?? "").trim();
	if (!raw) return { name: "bridge", source: "default" };
	if (raw === "host" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(raw))
		return { name: "none", source: "invalid", warning: `WORKROOM_DOCKER_NETWORK=${raw.slice(0, 40)} 无效或不允许（host 与 container:* 会共享服务器网络栈）：已按 none（无网络）处理，请修正部署配置` };
	return { name: raw, source: "env" };
}

export const DEFAULT_DOCKER_SETTINGS: DockerSettings = { image: DEFAULT_IMAGE, pythonImage: FALLBACK_PYTHON_IMAGE, nodeImage: FALLBACK_NODE_IMAGE, cpus: 1, autoPull: true };

export const DOCKER_NOTES: IsolationNotes = {
	isolates: [
		"每次运行一个独立容器（独立 pid/mount/net/ipc/uts 命名空间 + cgroup）：根文件系统只读，非 root 用户，丢弃全部 capabilities，no-new-privileges，Docker 默认 seccomp 配置",
		"仅 /work（本会话工作目录，绑定挂载）可写，/tmp 为内存盘；技能等额外挂载为只读；看不到数据目录、源码、宿主其他文件",
		"容器有自己的网络命名空间（看不到宿主机 127.0.0.1 上的服务）；网络由部署方通过环境变量 WORKROOM_DOCKER_NETWORK 决定：默认 Docker 桥接网络（可访问互联网），也可设为 none 或自建网络。没有面向用户或管理页面的联网开关",
		"内存、CPU、进程数是 cgroup 总量限制；另有单文件大小、打开文件数、CPU 秒 rlimit；超时或取消 → 终止并删除容器",
		"使用固定版本的镜像（python3 + node + 常用数据分析库），不依赖宿主机安装的运行时",
	],
	doesNotIsolate: [
		"容器与宿主（Windows/macOS 上是 Docker Desktop 的 Linux 虚拟机）共享内核，内核/运行时漏洞可逃逸；不是每个任务一台虚拟机",
		"桥接网络下容器可访问互联网，也可能访问网桥网关、宿主所在局域网与云元数据地址（169.254.169.254）；本平台的 URL 策略不作用于沙箱内的联网，Workroom 不代为配置防火墙。需要限制出口时，部署方应使用带出口规则的自建 Docker 网络并设置 WORKROOM_DOCKER_NETWORK，或设为 none",
		"没有磁盘配额：工作目录总量是运行前后检查的软配额；容器内 /tmp 内存盘占用计入容器内存",
		"能访问 Docker 守护进程的人本来就拥有宿主机管理权限：Workroom 服务账号应只用于运行 Workroom",
		"Windows/macOS 上绑定挂载经过文件共享层（WSL2/VirtioFS），写入性能低于原生，权限位不完全等同于 Linux",
	],
};

export interface DockerFacts {
	bin: string;
	serverVersion: string;
	os: string;
	arch: string;
	rootless: boolean;
	desktop: boolean;
	operatingSystem: string;
	images: { primary: boolean; python: boolean; node: boolean };
}

export interface PrepareProgress {
	mode: "pull" | "build";
	state: "running" | "done" | "failed";
	startedAt: string;
	finishedAt?: string;
	log: string[];
}

const instructionsInstall = (image: string) =>
	process.platform === "win32"
		? `1) 安装 Docker Desktop for Windows（https://www.docker.com/products/docker-desktop/，使用 WSL 2 后端，Linux 容器模式）并启动它。2) 在 Docker Desktop 设置 → Resources → File sharing 中确保 Workroom 的数据目录所在盘可共享（WSL 2 后端默认可用）。3) 重新打开此页面，点击“准备沙箱镜像”（或在终端运行 docker pull python:3.12-slim 与 docker pull node:22-slim；完整镜像：docker build -t ${image} server/sandbox）。`
		: process.platform === "darwin"
			? `1) 安装并启动 Docker Desktop for Mac（或 OrbStack / Colima）。2) 回到此页面点击“准备沙箱镜像”（或运行 docker pull python:3.12-slim 与 docker pull node:22-slim；完整镜像：docker build -t ${image} server/sandbox）。`
			: `1) 安装 Docker Engine（https://docs.docker.com/engine/install/）并启动 docker 服务；运行 Workroom 的账号需在 docker 组内或使用 rootless Docker。2) 回到此页面点击“准备沙箱镜像”（或运行 docker pull python:3.12-slim 与 docker pull node:22-slim；完整镜像：docker build -t ${image} server/sandbox）。`;

export class DockerDriver implements SandboxDriver {
	readonly id = "docker" as const;
	readonly label = "Docker 容器";
	/** `network` reports the deployment's choice (WORKROOM_DOCKER_NETWORK): false only when the operator set `none`. */
	get capabilities() {
		return { network: dockerNetworkChoice().name !== "none", services: true, mounts: true, cgroupLimits: true, hostRuntimes: false };
	}
	readonly notes = DOCKER_NOTES;
	readonly #settings: () => DockerSettings;
	readonly #instanceKey: string;
	#facts: DockerFacts | undefined;
	#status: DriverStatus | undefined;
	#statusAt = 0;
	#pending: Promise<DriverStatus> | undefined;
	#prepare: PrepareProgress | undefined;
	/** Container name → true while we own it (for shutdown cleanup). */
	readonly #live = new Set<string>();

	constructor(settings: () => DockerSettings = () => DEFAULT_DOCKER_SETTINGS, instanceKey = "default") {
		this.#settings = settings;
		this.#instanceKey = instanceKey;
	}

	// ---------- CLI plumbing ----------
	#bin(): string | undefined {
		const s = this.#settings();
		return findExecutable(s.bin || "docker", dockerSearchDirs());
	}
	#env(): NodeJS.ProcessEnv {
		const s = this.#settings();
		const env: NodeJS.ProcessEnv = { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*", DOCKER_CLI_HINTS: "false" };
		if (s.host) env.DOCKER_HOST = s.host;
		return env;
	}
	#cli(args: readonly string[], opts: { timeoutMs?: number } = {}) {
		const bin = this.#bin();
		if (!bin) return Promise.resolve({ code: null, stdout: "", stderr: "", timedOut: false, error: "docker CLI not found" });
		return runCli(bin, args, { env: this.#env(), timeoutMs: opts.timeoutMs });
	}

	/** Facts gathered by the last successful detect(); undefined when docker is not usable. */
	facts(): DockerFacts | undefined {
		return this.#facts;
	}
	prepareProgress(): PrepareProgress | undefined {
		return this.#prepare;
	}

	// ---------- detection ----------
	detect(force = false): Promise<DriverStatus> {
		const ttl = this.#status?.state === "ready" ? 30_000 : 4_000;
		if (!force && this.#status && Date.now() - this.#statusAt < ttl) return Promise.resolve(this.#status);
		this.#pending ??= this.#detect().finally(() => (this.#pending = undefined));
		return this.#pending;
	}
	invalidate(): void {
		this.#statusAt = 0;
	}
	async #detect(): Promise<DriverStatus> {
		const checkedAt = new Date().toISOString();
		const set = (s: DriverStatus) => {
			this.#status = s;
			this.#statusAt = Date.now();
			return s;
		};
		const settings = this.#settings();
		const bin = this.#bin();
		this.#facts = undefined;
		if (!bin) {
			return set({ id: "docker", state: "unavailable", summary: "未找到 docker 命令", details: [`在 PATH 与常见安装目录中没有 ${settings.bin || "docker"}`], howToEnable: instructionsInstall(settings.image), checkedAt });
		}
		const v = await this.#cli(["version", "--format", "{{.Server.Version}}|{{.Server.Os}}|{{.Server.Arch}}"], { timeoutMs: 10_000 });
		if (v.code !== 0) {
			const why = (v.timedOut ? "docker version 超时（守护进程无响应）" : v.stderr || v.error || "unknown").trim().split("\n").slice(0, 3).join(" ");
			const desktop = process.platform === "win32" || process.platform === "darwin";
			return set({ id: "docker", state: "unavailable", summary: desktop ? "Docker Desktop 没有运行" : "无法连接 Docker 守护进程", details: [`docker CLI: ${bin}`, why.slice(0, 400)], howToEnable: desktop ? "请启动 Docker Desktop，等待左下角显示 “Engine running”，再刷新此页面。" : "请启动 docker 服务（sudo systemctl start docker），并确认当前账号有权访问 /var/run/docker.sock（加入 docker 组，或使用 rootless Docker / 设置 DOCKER_HOST）。", checkedAt });
		}
		const [serverVersion = "", os = "", arch = ""] = v.stdout.trim().split("|");
		if (os && os !== "linux") {
			return set({ id: "docker", state: "unavailable", summary: "Docker 处于 Windows 容器模式", details: [`Server OS: ${os}`], howToEnable: "请在 Docker Desktop 托盘菜单选择 “Switch to Linux containers…”。", checkedAt });
		}
		const info = await this.#cli(["info", "--format", "{{json .SecurityOptions}}|{{.OperatingSystem}}"], { timeoutMs: 10_000 });
		const [sec = "", operatingSystem = ""] = info.code === 0 ? info.stdout.trim().split("|") : ["", ""];
		const rootless = /rootless/i.test(sec);
		const desktop = /docker desktop/i.test(operatingSystem);
		const has = async (img: string) => (await this.#cli(["image", "inspect", "--format", "{{.Id}}", img], { timeoutMs: 10_000 })).code === 0;
		const [primary, python, node] = await Promise.all([has(settings.image), has(settings.pythonImage), has(settings.nodeImage)]);
		this.#facts = { bin, serverVersion, os, arch, rootless, desktop, operatingSystem, images: { primary, python, node } };
		const net = dockerNetworkChoice();
		const details = [`docker CLI: ${bin}`, `Docker ${serverVersion}（${operatingSystem || "linux"}/${arch}${rootless ? "，rootless" : ""}）`, `镜像 ${settings.image}: ${primary ? "已就绪" : "未找到"}`, `镜像 ${settings.pythonImage}: ${python ? "已就绪" : "未找到"}`, `镜像 ${settings.nodeImage}: ${node ? "已就绪" : "未找到"}`, `容器网络：${net.name}${net.source === "default" ? "（默认，Docker 桥接网络）" : net.source === "env" ? "（部署配置 WORKROOM_DOCKER_NETWORK）" : ""}`];
		if (net.warning) details.push(net.warning);
		if (this.#prepare?.state === "running") details.push(`正在准备镜像（${this.#prepare.mode}）…`);
		const ready = primary || (python && node);
		if (ready) return set({ id: "docker", state: "ready", summary: `Docker ${serverVersion} 可用（${primary ? settings.image : "公共 slim 镜像"}）`, details, checkedAt });
		return set({ id: "docker", state: "needs_setup", summary: "Docker 可用，但沙箱镜像尚未准备", details, howToEnable: `管理员点击“准备沙箱镜像”（拉取 ${settings.pythonImage.split("@")[0]} 与 ${settings.nodeImage.split("@")[0]}，约 200 MB），或在终端运行：docker pull python:3.12-slim && docker pull node:22-slim；完整数据分析镜像：docker build -t ${settings.image} server/sandbox（见 server/sandbox/README.md）。`, checkedAt });
	}

	/** Pull the public fallback images (mode "pull") or build the full image from server/sandbox/Dockerfile (mode "build"). Resolves when finished. */
	prepare(mode: "pull" | "build", contextDir?: string): Promise<PrepareProgress> {
		if (this.#prepare?.state === "running") return this.#preparing!;
		const bin = this.#bin();
		const st: PrepareProgress = { mode, state: "running", startedAt: new Date().toISOString(), log: [] };
		this.#prepare = st;
		const log = (l: string) => {
			for (const line of l.split(/\r?\n/)) if (line.trim()) st.log.push(line.slice(0, 300));
			if (st.log.length > 80) st.log.splice(0, st.log.length - 80);
		};
		const s = this.#settings();
		const steps: string[][] = mode === "pull" ? [["pull", s.pythonImage], ["pull", s.nodeImage]] : [["build", "-t", s.image, contextDir ?? "server/sandbox"]];
		this.#preparing = (async () => {
			try {
				if (!bin) throw new Error("docker CLI not found");
				for (const args of steps) {
					log(`$ docker ${args.join(" ")}`);
					const code = await new Promise<number | null>((res) => {
						const c = spawn(bin, args, { env: this.#env(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
						c.stdout.on("data", (d: Buffer) => log(d.toString("utf8")));
						c.stderr.on("data", (d: Buffer) => log(d.toString("utf8")));
						c.on("error", (e) => (log(String(e.message)), res(null)));
						c.on("close", res);
					});
					if (code !== 0) throw new Error(`docker ${args[0]} 失败（exit ${code}）`);
				}
				st.state = "done";
			} catch (e: any) {
				log(String(e?.message ?? e));
				st.state = "failed";
			}
			st.finishedAt = new Date().toISOString();
			this.invalidate();
			return st;
		})();
		return this.#preparing;
	}
	#preparing: Promise<PrepareProgress> | undefined;

	/** Resolve the image for a runtime, pulling a missing fallback image once when autoPull is on. */
	async #imageFor(runtime: ServiceRuntime): Promise<string> {
		let st = await this.detect();
		const s = this.#settings();
		if (st.state !== "ready" && s.autoPull && this.#facts) {
			await this.prepare("pull");
			st = await this.detect(true);
		}
		const f = this.#facts;
		if (st.state !== "ready" || !f) throw new HttpError(503, "sandbox_unavailable", `沙箱不可用：${st.summary}。${st.howToEnable ?? ""}`);
		if (f.images.primary) return s.image;
		if (runtime === "node") return s.nodeImage;
		return s.pythonImage; // python and shell
	}

	// ---------- container construction ----------
	#userSpec(): { user: string; chownWorkdir: boolean } {
		const f = this.#facts;
		if (process.platform === "linux" && !f?.desktop) {
			if (f?.rootless) return { user: "0:0", chownWorkdir: false }; // container root == the unprivileged host user
			const uid = process.getuid?.() ?? 0;
			if (uid !== 0) return { user: `${uid}:${process.getgid?.() ?? uid}`, chownWorkdir: false };
			return { user: `${CONTAINER_UID}:${CONTAINER_UID}`, chownWorkdir: true };
		}
		return { user: `${CONTAINER_UID}:${CONTAINER_UID}`, chownWorkdir: false };
	}

	/** Make the workspace writable for the container user (root server on Linux: hand the directory to the container uid). */
	prepareWorkdir(workdir: string): void {
		if (this.#userSpec().chownWorkdir) {
			try {
				chownSync(workdir, CONTAINER_UID, CONTAINER_UID);
			} catch {
				/* best effort */
			}
		}
	}
	/** uid/gid that host-side writes into the workspace should be given (root server on Linux), or undefined. */
	workspaceOwner(): { uid: number; gid: number } | undefined {
		return this.#userSpec().chownWorkdir ? { uid: CONTAINER_UID, gid: CONTAINER_UID } : undefined;
	}

	#mountArgs(workdir: string, codeDir: string | undefined, mounts: readonly SandboxMount[]): string[] {
		const src = (p: string) => toDockerHostPath(realpathSync.native(p));
		const args = ["--mount", bindMountArg(src(workdir), "/work", false)];
		if (codeDir) args.push("--mount", bindMountArg(src(codeDir), "/code", true));
		for (const m of mounts) args.push("--mount", bindMountArg(src(m.hostPath), m.target, m.readOnly));
		return args;
	}

	#baseArgs(name: string, id: string, o: { limits: DriverRunSpec["limits"]; network: boolean; interactive: boolean; cwd?: string; envFile?: string }): string[] {
		const s = this.#settings();
		const l = o.limits;
		const mem = `${Math.max(64, Math.floor(l.memoryBytes / 1048576))}m`;
		const user = this.#userSpec().user;
		return [
			"run", "--name", name, "--label", "workroom.sandbox=1", "--label", `workroom.instance=${this.#instanceKey}`, "--label", `workroom.run=${id}`,
			"--pull", "never", "--init", "--entrypoint", "",
			// o.network=false only for server-internal isolated jobs (execIsolated); everything a user/model runs gets the deployment's network.
			"--network", o.network ? dockerNetworkChoice().name : "none",
			"--memory", mem, "--memory-swap", mem, "--cpus", String(s.cpus), "--pids-limit", String(Math.max(16, l.maxProcesses)),
			"--ulimit", "core=0", "--ulimit", "nofile=1024:1024", "--ulimit", `fsize=${l.maxFileBytes}:${l.maxFileBytes}`, "--ulimit", `cpu=${l.cpuSeconds}:${l.cpuSeconds + 2}`,
			"--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
			"--user", user, "--hostname", "sandbox", "-w", o.cwd ?? "/work",
			"-e", "HOME=/tmp/home", "-e", "TMPDIR=/tmp", "-e", "LANG=C.UTF-8", "-e", "PYTHONDONTWRITEBYTECODE=1", "-e", "MPLCONFIGDIR=/tmp/mpl", "-e", "XDG_CACHE_HOME=/tmp/.cache", "-e", "NPM_CONFIG_CACHE=/tmp/.npm",
			...(o.envFile ? ["--env-file", o.envFile] : []),
			...(o.interactive ? ["-i"] : []),
		];
	}

	#writeEnv(dir: string, env: Readonly<Record<string, string>>): string | undefined {
		checkEnv(env);
		const entries = Object.entries(env);
		if (!entries.length) return undefined;
		for (const [k, v] of entries) if (/[\r\n]/.test(v)) throw new Error(`environment value of ${k} may not contain newlines`);
		const f = join(dir, "env.list");
		writeFileSync(f, `${entries.map(([k, v]) => `${k}=${v}`).join("\n")}\n`, { mode: 0o600 });
		return f;
	}

	#program(spec: { exec: DriverRunSpec["exec"]; limits: DriverRunSpec["limits"] }): { argv: string[]; code?: { file: string; text: string }; runtime: ServiceRuntime } {
		if ("language" in spec.exec) {
			const { language, code } = spec.exec;
			const file = language === "python" ? "main.py" : language === "node" ? "main.mjs" : "main.sh";
			const argv = language === "python" ? ["python3", "/code/main.py"] : language === "node" ? ["node", `--max-old-space-size=${Math.floor(spec.limits.memoryBytes / 2 / 1048576)}`, "/code/main.mjs"] : ["/bin/sh", "/code/main.sh"];
			return { argv, code: { file, text: code }, runtime: language };
		}
		return { argv: [...spec.exec.argv], runtime: spec.exec.runtime ?? (spec.exec.argv[0] === "node" ? "node" : "shell") };
	}

	async #remove(name: string): Promise<void> {
		this.#live.delete(name);
		await this.#cli(["rm", "-f", "-v", name], { timeoutMs: 20_000 });
	}
	/**
	 * Stop a container that may not exist yet. `docker run` can still be pulling/creating/starting (slow image copy on vfs, a busy daemon)
	 * when a timeout or cancellation fires, so a single `docker kill` misses it — and `docker rm -f` on a name that does not exist yet
	 * *succeeds silently* and killing the CLI at that moment would leave the daemon to finish creating an orphan. So: poll until the container
	 * exists, remove it (kill + delete), and only then let the attached CLI end (it exits by itself once its container is gone).
	 */
	async #terminate(name: string, child: ChildProcess, closed: () => boolean): Promise<void> {
		const t0 = Date.now();
		let removedAt = 0;
		while (!closed() && Date.now() - t0 < 90_000) {
			const ex = await this.#cli(["container", "inspect", "--format", "{{.Id}}", name], { timeoutMs: 10_000 });
			if (closed()) return;
			if (ex.code === 0) {
				await this.#cli(["rm", "-f", "-v", name], { timeoutMs: 20_000 });
				removedAt ||= Date.now();
			}
			if (removedAt && Date.now() - removedAt > 3000) child.kill("SIGKILL");
			await new Promise((res) => setTimeout(res, 100));
		}
		if (!closed()) child.kill("SIGKILL");
	}
	static #infraFailure(stderr: string): boolean {
		return /Cannot connect to the Docker daemon|error during connect|Is the docker daemon running|pipe\/docker_engine|dockerDesktopLinuxEngine|Unable to find image|No such image|pull access denied/i.test(stderr);
	}

	// ---------- run ----------
	async run(spec: DriverRunSpec): Promise<RunResult> {
		const prog = this.#program(spec);
		const image = await this.#imageFor(prog.runtime);
		const bin = this.#bin()!;
		const scratch = join(spec.scratchBase, ".runs", spec.runId);
		const codeDir = join(scratch, "code");
		mkdirSync(codeDir, { recursive: true });
		if (prog.code) writeFileSync(join(codeDir, prog.code.file), prog.code.text);
		const name = `wr-${spec.runId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(-48)}`;
		const started = Date.now();
		this.prepareWorkdir(spec.workdir);
		for (const st of spec.stores ?? []) if (!st.readOnly) this.prepareWorkdir(st.hostPath); // round 11: persistent stores are written by the container user too
		let envFile: string | undefined;
		try {
			envFile = this.#writeEnv(scratch, spec.env);
			const args = [...this.#baseArgs(name, spec.runId, { limits: spec.limits, network: spec.network, interactive: false, envFile }), ...this.#mountArgs(spec.workdir, codeDir, [...spec.mounts, ...storeMounts(spec.stores)]), image, ...prog.argv];
			const out = capped();
			const err = capped();
			this.#live.add(name);
			const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: this.#env(), windowsHide: true });
			spec.onSpawn?.({ driver: "docker", container: name, pid: child.pid });
			child.stdout.on("data", (b: Buffer) => out.push(b));
			child.stderr.on("data", (b: Buffer) => err.push(b));
			let timedOut = false;
			let cancelled = false;
			let closed = false;
			let terminating: Promise<void> | undefined;
			const stop = () => (terminating ??= this.#terminate(name, child, () => closed));
			const timer = setTimeout(() => {
				timedOut = true;
				void stop();
			}, spec.limits.timeoutMs);
			const onAbort = () => {
				cancelled = true;
				void stop();
			};
			if (spec.signal?.aborted) onAbort();
			spec.signal?.addEventListener("abort", onAbort, { once: true });
			const { code: exitCode, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
				child.on("error", (e) => (err.push(Buffer.from(`${e.message}\n`)), res({ code: 125, signal: null })));
				child.on("close", (c, s) => ((closed = true), res({ code: c, signal: s })));
			});
			clearTimeout(timer);
			spec.signal?.removeEventListener("abort", onAbort);
			await terminating;
			let oom = false;
			if (exitCode === 137 && !timedOut && !cancelled) {
				const r = await this.#cli(["inspect", "--format", "{{.State.OOMKilled}}", name], { timeoutMs: 10_000 });
				oom = r.stdout.trim() === "true";
			}
			await this.#remove(name);
			let stderr = err.text();
			if (exitCode === 125 && DockerDriver.#infraFailure(stderr)) {
				this.invalidate();
				throw new HttpError(503, "sandbox_unavailable", `沙箱不可用：docker 报告 ${stderr.trim().split("\n").pop()?.slice(0, 300)}`);
			}
			const status: RunResult["status"] = timedOut ? "timeout" : cancelled || signal ? "killed" : exitCode === 0 ? "ok" : exitCode === 137 || exitCode === 152 ? "killed" : "error";
			if (timedOut) stderr += `\n[sandbox] 超过时间限制 ${spec.limits.timeoutMs} ms，已终止并删除容器`;
			else if (cancelled) stderr += "\n[sandbox] 运行已被取消，已终止并删除容器";
			else if (oom) stderr += `\n[sandbox] 超过内存限制 ${Math.round(spec.limits.memoryBytes / 1048576)} MB，进程被终止`;
			else if (exitCode === 152) stderr += `\n[sandbox] 超过 CPU 时间限制 ${spec.limits.cpuSeconds} 秒`;
			return { status, exitCode, stdout: out.text(), stderr, durationMs: Date.now() - started };
		} finally {
			await this.#remove(name);
			rmSync(scratch, { recursive: true, force: true });
		}
	}

	// ---------- services ----------
	async startService(spec: DriverServiceSpec): Promise<DriverServiceProcess> {
		const image = await this.#imageFor(spec.runtime);
		const bin = this.#bin()!;
		const scratch = join(spec.scratchBase, ".runs", spec.serviceId);
		const codeDir = join(scratch, "code");
		mkdirSync(codeDir, { recursive: true });
		const name = `wr-${spec.serviceId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(-48)}`;
		this.prepareWorkdir(spec.workdir);
		let child;
		try {
			const envFile = this.#writeEnv(scratch, spec.env);
			const args = [...this.#baseArgs(name, spec.serviceId, { limits: spec.limits, network: spec.network, interactive: true, cwd: spec.cwd, envFile }), ...this.#mountArgs(spec.workdir, codeDir, spec.mounts), image, ...spec.argv];
			this.#live.add(name);
			child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: this.#env(), windowsHide: true });
		} catch (e) {
			rmSync(scratch, { recursive: true, force: true });
			throw e;
		}
		const ref: ProcessRef = { driver: "docker", container: name, pid: child.pid };
		spec.onSpawn?.(ref);
		child.stdin.on("error", () => {});
		let removed: Promise<void> | undefined;
		let closed = false;
		const cleanup = () => (removed ??= this.#remove(name).then(() => rmSync(scratch, { recursive: true, force: true })));
		const exited = new Promise<{ exitCode: number | null; signal: string | null }>((res) => {
			child.on("error", () => ((closed = true), res({ exitCode: 125, signal: null })));
			child.on("close", (c, s) => ((closed = true), res({ exitCode: c, signal: s })));
		}).then(async (r) => {
			await cleanup();
			return r;
		});
		return {
			ref,
			stdin: child.stdin!,
			stdout: child.stdout!,
			stderr: child.stderr!,
			exited,
			kill: async () => {
				await this.#terminate(name, child, () => closed);
				await exited;
				await cleanup();
			},
		};
	}

	// ---------- cleanup ----------
	async reapStale(): Promise<number> {
		if (!this.#bin()) return 0;
		const r = await this.#cli(["ps", "-aq", "--no-trunc", "--filter", "label=workroom.sandbox=1", "--filter", `label=workroom.instance=${this.#instanceKey}`], { timeoutMs: 15_000 });
		if (r.code !== 0) return 0;
		const ids = r.stdout.split(/\s+/).filter(Boolean);
		if (ids.length) await this.#cli(["rm", "-f", "-v", ...ids], { timeoutMs: 60_000 });
		return ids.length;
	}
	async killStale(ref: ProcessRef): Promise<boolean> {
		if (!ref.container || !/^wr-[a-zA-Z0-9_.-]+$/.test(ref.container)) return false;
		const r = await this.#cli(["rm", "-f", "-v", ref.container], { timeoutMs: 20_000 });
		return r.code === 0;
	}
	/** Remove every container this driver still owns (server shutdown). */
	async shutdown(): Promise<void> {
		await Promise.all([...this.#live].map((n) => this.#remove(n)));
	}
}

