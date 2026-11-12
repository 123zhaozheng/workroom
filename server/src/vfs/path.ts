// Virtual path protocol: POSIX absolute paths; a relative path is relative to /work; "." and ".." are resolved lexically and may never
// climb above "/". Backslashes, NUL and over-long paths are refused. The result is the canonical form every backend receives.
import { VfsError } from "./types.ts";

const MAX_PATH = 1024;

export function normalizeVirtual(input: unknown, cwd = "/work"): string {
	if (typeof input !== "string") throw new VfsError("bad_path", "路径必须是字符串");
	let p = input.trim();
	if (!p) throw new VfsError("bad_path", "路径不能为空");
	if (p.length > MAX_PATH) throw new VfsError("bad_path", "路径过长");
	if (p.includes("\0")) throw new VfsError("bad_path", "路径包含非法字符");
	if (p.includes("\\")) throw new VfsError("bad_path", "请使用 / 作为路径分隔符");
	if (/^[A-Za-z]:/.test(p)) throw new VfsError("bad_path", "不支持盘符路径，请使用虚拟路径（/work、/memory 等）");
	if (!p.startsWith("/")) p = `${cwd.replace(/\/+$/, "")}/${p}`;
	const out: string[] = [];
	for (const seg of p.split("/")) {
		if (!seg || seg === ".") continue;
		if (seg === "..") {
			if (!out.length) throw new VfsError("bad_path", "路径不能越过根目录");
			out.pop();
			continue;
		}
		out.push(seg);
	}
	return `/${out.join("/")}`;
}

/** "/work/a/b" → { root: "/work", rel: "a/b" }; "/" → { root: "/", rel: "" }. */
export function splitRoot(path: string): { root: string; rel: string } {
	if (path === "/") return { root: "/", rel: "" };
	const i = path.indexOf("/", 1);
	return i === -1 ? { root: path, rel: "" } : { root: path.slice(0, i), rel: path.slice(i + 1) };
}

export const joinVirtual = (root: string, rel: string): string => (rel ? `${root}/${rel}` : root);
export const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
export const parentOf = (p: string): string => {
	const i = p.lastIndexOf("/");
	return i <= 0 ? "/" : p.slice(0, i);
};

/** A single file name a user/agent may give (present_file name, new topic file): no separators, no control characters. */
export function safeFileName(name: string): string {
	const n = name
		.normalize("NFC")
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/[\\/:*?"<>|]/g, "_")
		.trim()
		.replace(/^\.+/, "")
		.slice(0, 180);
	if (!n) throw new VfsError("bad_path", "文件名无效");
	return n;
}
