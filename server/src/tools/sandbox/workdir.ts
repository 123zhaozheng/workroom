// Round 10: where the conversation workspace lives INSIDE the sandbox (pure functions, no I/O).
//
// Local drivers (namespaces / docker) always mount the workspace at /work and skills at /skills/<slug>.
// Remote providers get a configurable working directory: the Daytona default user is not root, so a fixed root-level /work cannot be created.
//   - `DEFAULT_WORKDIR`: deterministic default per provider (used when the admin leaves the field empty).
//   - `normalizeWorkDir`: validation of what an admin typed (absolute POSIX path, no "..", not "/" nor a system directory, <= 200 chars).
//   - `mapMountTarget`: read-only mounts (skills) are re-rooted next to the working directory, so a non-root user can create them as well.
//   - `stripWorkPrefix`: file tools accept a path relative, as "/work/…", or prefixed with the real working directory.
import { posix } from "node:path";
import type { ProviderId } from "./provider.ts";

export const LOCAL_WORKDIR = "/work";
export const LOCAL_SKILLS_ROOT = "/skills";
export const WORKDIR_MAX_CHARS = 200;

/** Default working directory per remote provider. opensandbox keeps "/work" (the live tests and existing deployments rely on it). */
export const DEFAULT_WORKDIR: Readonly<Record<ProviderId, string>> = { opensandbox: "/work", e2b: "/home/user/work", daytona: "/home/daytona/work" };

export class WorkDirError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkDirError";
	}
}

/** Directories (and everything below them) that can never be a working directory: the whole tree is chmod'ed and synced. */
const SYSTEM_DIRS = ["/etc", "/proc", "/sys", "/dev", "/usr", "/bin", "/sbin", "/boot", "/run", "/var/run"];
const SYSTEM_LIB = /^\/lib(32|64|x32)?(\/|$)/;
/** Shared roots that are refused as the directory itself (the working directory would swallow every user's files); subdirectories are fine. */
const SHARED_ROOTS = ["/home", "/root", "/tmp", "/var", "/opt", "/mnt", "/srv", "/media", "/snap"];
const SEGMENT = /^[A-Za-z0-9._@+-]+$/;

/**
 * Validate and normalise a working directory typed by an admin. Returns the normalised absolute POSIX path
 * (duplicate and trailing slashes and "." segments are dropped). Throws WorkDirError with a plain Chinese message.
 */
export function normalizeWorkDir(input: unknown): string {
	if (typeof input !== "string") throw new WorkDirError("工作目录必须是文本");
	const raw = input.trim();
	if (!raw) throw new WorkDirError("工作目录不能为空（留空表示使用默认值）");
	if (raw.length > WORKDIR_MAX_CHARS) throw new WorkDirError(`工作目录不能超过 ${WORKDIR_MAX_CHARS} 个字符`);
	if (/[\u0000-\u001f\u007f]/.test(raw)) throw new WorkDirError("工作目录不能包含控制字符");
	if (raw.includes("\\")) throw new WorkDirError("工作目录必须使用 / 分隔（沙箱是 Linux，不支持反斜杠）");
	if (!raw.startsWith("/")) throw new WorkDirError("工作目录必须是以 / 开头的绝对路径，例如 /home/daytona/work");
	const parts: string[] = [];
	for (const seg of raw.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") throw new WorkDirError("工作目录不能包含 “..”");
		if (!SEGMENT.test(seg)) throw new WorkDirError(`工作目录只能包含字母、数字和 . _ @ + -（目录名 ${JSON.stringify(seg).slice(0, 40)} 不符合）`);
		parts.push(seg);
	}
	const p = `/${parts.join("/")}`;
	if (p === "/") throw new WorkDirError("工作目录不能是根目录 /");
	if (p.length > WORKDIR_MAX_CHARS) throw new WorkDirError(`工作目录不能超过 ${WORKDIR_MAX_CHARS} 个字符`);
	if (SYSTEM_DIRS.some((d) => p === d || p.startsWith(`${d}/`)) || SYSTEM_LIB.test(p)) throw new WorkDirError(`工作目录不能是系统目录或其子目录（${p}）`);
	if (SHARED_ROOTS.includes(p) || /^\/home\/[^/]+$/.test(p)) throw new WorkDirError(`工作目录不能是 ${p} 本身（整个目录会被同步，请使用它下面的子目录，例如 ${p === "/" ? "" : p}/work）`);
	return p;
}

/** The working directory a provider uses: the admin's value, else the provider's default. `configured` is assumed to be valid already (it was validated on save). */
export function resolveWorkDir(provider: ProviderId, configured?: string | null): string {
	return configured && configured.trim() ? configured : DEFAULT_WORKDIR[provider];
}

/** Directory under which read-only mounts (skills …) live for this working directory: "/" for "/work", otherwise the parent of the working directory. */
export function mountRoot(workDir: string): string {
	return workDir === LOCAL_WORKDIR ? "/" : posix.dirname(workDir);
}

/** Where a mount target (e.g. /skills/pdf) really is in the sandbox: unchanged for "/work", else `<dirname(workDir)>/<target without leading slash>`. */
export function mapMountTarget(workDir: string, target: string): string {
	if (workDir === LOCAL_WORKDIR) return target;
	const root = mountRoot(workDir);
	return posix.join(root, target.replace(/^\/+/, ""));
}

/** Directory holding the skills (read-only) in the sandbox. */
export function skillsRootFor(workDir: string): string {
	return mapMountTarget(workDir, LOCAL_SKILLS_ROOT);
}

/** `a` is `b` or lies inside `b` (POSIX paths). */
export function isWithin(a: string, b: string): boolean {
	return a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`);
}

/**
 * Strip the real working directory from the front of a model-supplied path ("/home/daytona/work/a.txt" → "a.txt").
 * Other shapes are returned unchanged: relative paths and "/work/…" are handled by workspace.cleanPath. Backslashes count as separators (same as cleanPath).
 */
export function stripWorkPrefix(path: string, workDir: string | null | undefined): string {
	if (!workDir || workDir === LOCAL_WORKDIR || typeof path !== "string") return path;
	const p = path.replace(/\\/g, "/");
	if (p === workDir || p === `${workDir}/`) return "";
	if (p.startsWith(`${workDir}/`)) return p.slice(workDir.length + 1).replace(/^\/+/, "");
	return path;
}

/** Display path of a workspace-relative path for the model: "<workDir>/<rel>" ("" → the working directory itself). */
export function displayPath(workDir: string, rel: string): string {
	return rel ? `${workDir === "/" ? "" : workDir}/${rel}` : workDir;
}
