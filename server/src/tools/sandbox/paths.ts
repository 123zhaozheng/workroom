// Host-side path helpers shared by the sandbox drivers (and usable by other modules that must locate host tools):
// executable lookup that works on Windows (PATHEXT, Program Files), and translation of host paths for `docker --mount`.
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";

const isWin = (platform: NodeJS.Platform) => platform === "win32";

/** Extensions tried for a bare executable name (`docker` → `docker.exe`). Never `.cmd`/`.bat`: they cannot be spawned without a shell. */
function exeNames(name: string, platform: NodeJS.Platform): string[] {
	if (!isWin(platform)) return [name];
	return /\.(exe|com)$/i.test(name) ? [name] : [`${name}.exe`, `${name}.com`];
}

function isFile(p: string): boolean {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}
function isExecutable(p: string, platform: NodeJS.Platform): boolean {
	if (!isFile(p)) return false;
	if (isWin(platform)) return true;
	try {
		accessSync(p, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Find an executable by bare name on PATH, then in `extraDirs`. Returns an absolute path or undefined. Absolute `name` is checked directly. */
export function findExecutable(name: string, extraDirs: readonly string[] = [], opts: { platform?: NodeJS.Platform; pathEnv?: string } = {}): string | undefined {
	const platform = opts.platform ?? process.platform;
	const sep = isWin(platform) ? ";" : delimiter;
	const names = exeNames(name, platform);
	if (/[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) return [name, ...(isWin(platform) && !/\.(exe|com)$/i.test(name) ? [`${name}.exe`] : [])].find((n) => isExecutable(n, platform));
	const dirs = [...(opts.pathEnv ?? process.env.PATH ?? process.env.Path ?? "").split(sep).filter(Boolean), ...extraDirs];
	for (const d of dirs) for (const n of names) {
		const p = join(d, n);
		if (isExecutable(p, platform)) return p;
	}
	return undefined;
}

/** Places a docker CLI commonly lives when the server was started from a service/GUI with a minimal PATH. */
export function dockerSearchDirs(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
	if (platform === "win32") {
		const pf = env.ProgramFiles ?? "C:\\Program Files";
		return [join(pf, "Docker", "Docker", "resources", "bin"), join(env.LOCALAPPDATA ?? "", "Programs", "Rancher Desktop", "resources", "resources", "win32", "bin"), join(homedir(), ".rd", "bin")].filter((d) => d && !d.startsWith("Programs"));
	}
	if (platform === "darwin") return ["/usr/local/bin", "/opt/homebrew/bin", "/Applications/Docker.app/Contents/Resources/bin", join(homedir(), ".docker", "bin"), join(homedir(), ".rd", "bin"), join(homedir(), ".orbstack", "bin")];
	return ["/usr/local/bin", "/usr/bin", "/snap/bin"];
}

/** Directories searched for LibreOffice's `soffice` (Linux/macOS/Windows). Used by files/slides.ts (see docs/requests/sandbox.md). */
export function sofficeCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
	if (platform === "win32") {
		const dirs = [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432, "C:\\Program Files", "C:\\Program Files (x86)", env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Programs") : undefined].filter(Boolean) as string[];
		return [...new Set(dirs)].flatMap((d) => ["LibreOffice", "LibreOffice 7", "LibreOffice 24", "LibreOffice 25"].map((v) => join(d, v, "program", "soffice.exe")));
	}
	if (platform === "darwin") return ["/Applications/LibreOffice.app/Contents/MacOS/soffice", "/opt/homebrew/bin/soffice", "/usr/local/bin/soffice"];
	return ["/usr/bin/soffice", "/usr/local/bin/soffice", "/usr/lib/libreoffice/program/soffice", "/opt/libreoffice/program/soffice", "/snap/bin/libreoffice"];
}

/** Locate LibreOffice: `WORKROOM_SOFFICE` override, PATH (`soffice`, `libreoffice`), then the platform's usual install locations. */
export function findSoffice(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | undefined {
	if (env.WORKROOM_SOFFICE && exists(env.WORKROOM_SOFFICE)) return env.WORKROOM_SOFFICE;
	for (const c of sofficeCandidates(platform, env)) if (exists(c)) return c;
	return findExecutable("soffice", [], { platform }) ?? findExecutable("libreoffice", [], { platform });
}

/** `WORKROOM_SANDBOX_PATH_MAP="/data=/host/data;/srv=/mnt/srv"`: for a server that itself runs in a container and talks to the host's docker. */
export function parsePathMap(spec: string | undefined): [string, string][] {
	return (spec ?? "").split(";").map((s) => s.trim()).filter(Boolean).flatMap((s) => {
		const i = s.indexOf("=");
		return i > 0 ? [[s.slice(0, i), s.slice(i + 1)] as [string, string]] : [];
	});
}

/**
 * Translate a path of the server's filesystem into the path the Docker daemon must be given in a bind mount.
 * - Windows (Docker Desktop, WSL2/Hyper-V backend): the CLI accepts native `C:\Users\me\data`; we strip `\\?\` prefixes, upper-case the drive
 *   letter and use backslashes consistently (`UNC` paths keep their `\\server\share` form).
 * - macOS/Linux: unchanged (resolved real path), optionally rewritten through `WORKROOM_SANDBOX_PATH_MAP`.
 */
export function toDockerHostPath(p: string, platform: NodeJS.Platform = process.platform, pathMap: [string, string][] = parsePathMap(process.env.WORKROOM_SANDBOX_PATH_MAP)): string {
	for (const [from, to] of pathMap) if (p === from || p.startsWith(from.endsWith("/") || from.endsWith("\\") ? from : `${from}/`) || p.startsWith(`${from}\\`)) return to + p.slice(from.length);
	if (!isWin(platform)) return p;
	let q = p;
	if (q.startsWith("\\\\?\\UNC\\")) q = `\\\\${q.slice(8)}`;
	else if (q.startsWith("\\\\?\\") || q.startsWith("//?/")) q = q.slice(4);
	q = q.replace(/\//g, "\\");
	return q.replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`);
}

/** One `--mount` value: `type=bind,source=…,target=…[,readonly]`. Go's CSV parser needs fields containing `,` or `"` quoted. */
export function bindMountArg(source: string, target: string, readOnly: boolean): string {
	if (/[\r\n\0]/.test(source) || /[\r\n\0]/.test(target)) throw new Error("mount path contains control characters");
	const field = (k: string, v: string) => (/[",]/.test(v) ? `"${k}=${v.replace(/"/g, '""')}"` : `${k}=${v}`);
	return ["type=bind", field("source", source), field("target", target), ...(readOnly ? ["readonly"] : [])].join(",");
}
