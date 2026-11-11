// Host-side operations on a conversation workspace (the directory mounted at /work): path validation that holds on Windows and Linux,
// listing, preview, write/mkdir/delete/move with symlink-escape protection, and size accounting. Policy (ACL, quota, run records)
// lives in the Sandbox service and the HTTP routes; this file only touches the filesystem and never leaves the workdir.
import { isUtf8 } from "node:buffer";
import { chownSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { HttpError } from "../../core/http.ts";
import type { WorkspaceEntryDTO, WorkspacePreviewDTO } from "../../../../shared/sandbox.ts";
import { effectiveMime, extOf } from "../../files/mime.ts";

export const LIST_CAP = 2000;
export const PREVIEW_BYTES = 256 * 1024;
const BAD_SEGMENT = /[<>:"|?*\u0000-\u001f]/;

const bad = (msg: string) => new HttpError(400, "bad_path", msg);

/**
 * Normalise a user/agent supplied path to a clean POSIX relative path ("" = the workdir root).
 * Accepts `a/b`, `/work/a/b`, `a\b` (Windows browsers/tools); refuses `..`, drive letters / NTFS stream syntax (`:`), control characters,
 * reserved punctuation and names ending in `.` or space (these misbehave on Windows hosts), and over-long names.
 */
export function cleanPath(input: unknown): string {
	if (typeof input !== "string") throw bad("路径必须是字符串");
	let p = input.replace(/\\/g, "/");
	if (p.includes("\0")) throw bad("路径包含非法字符");
	p = p.replace(/^\/+work(?=\/|$)/, "");
	const out: string[] = [];
	for (const seg of p.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") throw bad("路径必须在工作目录内");
		if (BAD_SEGMENT.test(seg)) throw bad(`路径含有不允许的字符：${JSON.stringify(seg).slice(0, 60)}`);
		if (/[. ]$/.test(seg)) throw bad("文件名不能以点或空格结尾");
		if (seg.length > 255) throw bad("文件名过长");
		out.push(seg);
	}
	const clean = out.join("/");
	if (clean.length > 1024) throw bad("路径过长");
	return clean;
}

const lc = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
export function isInside(root: string, p: string): boolean {
	const r = lc(root);
	const q = lc(p);
	return q === r || q.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * Resolve `rel` inside `workdir`. Every existing component is checked: a symlink (created by sandboxed code!) that resolves outside
 * the workdir is refused, for reads and writes alike (`followFinal: false` lets delete/rename act on a final symlink itself). Returns the absolute path and the clean relative path.
 */
export function resolveIn(workdir: string, rel: unknown, opts: { followFinal?: boolean } = {}): { abs: string; rel: string } {
	const clean = cleanPath(rel);
	const realRoot = realpathSync.native(workdir);
	let cur = workdir;
	const segs = clean ? clean.split("/") : [];
	for (const [i, seg] of segs.entries()) {
		cur = join(cur, seg);
		if (i === segs.length - 1 && opts.followFinal === false) break; // deleting/renaming a symlink acts on the link itself, never its target
		let st;
		try {
			st = lstatSync(cur);
		} catch {
			continue; // does not exist (yet): the rest is created inside the checked ancestor
		}
		if (st.isSymbolicLink()) {
			let real: string;
			try {
				real = realpathSync.native(cur);
			} catch {
				throw bad("路径指向工作目录之外（失效的符号链接）");
			}
			if (!isInside(realRoot, real)) throw bad("路径指向工作目录之外");
		}
	}
	return { abs: clean ? join(workdir, ...clean.split("/")) : workdir, rel: clean };
}

export function dirSize(p: string): { bytes: number; files: number } {
	let bytes = 0;
	let files = 0;
	const walk = (d: string) => {
		let list;
		try {
			list = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of list) {
			const f = join(d, e.name);
			if (e.isDirectory()) walk(f);
			else if (e.isFile()) {
				try {
					bytes += lstatSync(f).size;
					files++;
				} catch {
					/* raced */
				}
			}
		}
	};
	if (existsSync(p)) walk(p);
	return { bytes, files };
}

export function listEntries(workdir: string, retentionHours: number, cap = LIST_CAP, opts: { skipTop?: (name: string) => boolean; prefix?: string; noExpiry?: boolean } = {}): { entries: WorkspaceEntryDTO[]; truncated: boolean } {
	const out: WorkspaceEntryDTO[] = [];
	let truncated = false;
	const walk = (d: string) => {
		let list;
		try {
			list = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		list.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
		for (const e of list) {
			if (out.length >= cap) {
				truncated = true;
				return;
			}
			if (d === workdir && opts.skipTop?.(e.name)) continue; // names a persistent store shadows (memories/, project/)
			const f = join(d, e.name);
			let st;
			try {
				st = lstatSync(f);
			} catch {
				continue;
			}
			const dir = e.isDirectory();
			const rel = f.slice(workdir.length + 1).split(sep).join("/");
			out.push({
				path: opts.prefix ? `${opts.prefix}/${rel}` : rel,
				kind: dir ? "directory" : "file",
				size: dir ? 0 : st.size,
				mtime: st.mtime.toISOString(),
				...(opts.noExpiry ? {} : { expiresAt: new Date(st.mtimeMs + retentionHours * 3600_000).toISOString() }),
				...(e.isSymbolicLink() ? { symlink: true } : {}),
			});
			if (dir) walk(f);
		}
	};
	walk(workdir);
	return { entries: out, truncated };
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"]);
const TEXT_LANG: Record<string, string> = { md: "markdown", markdown: "markdown", json: "json", csv: "csv", tsv: "csv", py: "python", js: "javascript", mjs: "javascript", ts: "typescript", sh: "shell", html: "html", css: "css", xml: "xml", yml: "yaml", yaml: "yaml", txt: "text", log: "text", sql: "sql" };

export function isInlineImage(name: string): boolean {
	return IMAGE_EXT.has(extOf(name));
}

/** Read the bytes of a regular file inside the workdir (refuses directories and symlinks leaving the workdir). */
export function readBytes(workdir: string, rel: string, maxBytes: number, opts: { head?: number } = {}): { bytes: Uint8Array; size: number; name: string; mtime: Date } {
	const { abs } = resolveIn(workdir, rel);
	let fd: number;
	try {
		fd = openSync(abs, constants.O_RDONLY);
	} catch {
		throw new HttpError(404, "not_found", "文件不存在");
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) throw new HttpError(404, "not_found", "文件不存在");
		if (opts.head === undefined && st.size > maxBytes) throw new HttpError(413, "too_large", `文件过大（${st.size} 字节）`);
		const want = Math.min(st.size, opts.head ?? st.size);
		const buf = Buffer.alloc(want);
		let off = 0;
		while (off < want) {
			const n = readSync(fd, buf, off, want - off, off);
			if (n === 0) break;
			off += n;
		}
		// The realpath check above happened before open: make sure the opened file is still inside the workdir (swap race).
		if (!isInside(realpathSync.native(workdir), realpathSync.native(abs))) throw bad("路径指向工作目录之外");
		return { bytes: new Uint8Array(buf.subarray(0, off)), size: st.size, name: basename(abs), mtime: st.mtime };
	} finally {
		closeSync(fd);
	}
}

/** Size of the regular file at `rel` (0 when absent) — an overwrite only adds the difference to the quota. */
export function existingSize(workdir: string, rel: string): number {
	try {
		const st = lstatSync(resolveIn(workdir, rel).abs);
		return st.isFile() ? st.size : 0;
	} catch {
		return 0;
	}
}

export function preview(workdir: string, rel: string, retentionHours: number): WorkspacePreviewDTO {
	const f = readBytes(workdir, rel, Infinity, { head: PREVIEW_BYTES + 4 });
	const mime = effectiveMime(undefined, f.name);
	const base = { path: cleanPath(rel), name: f.name, size: f.size, mime, mtime: f.mtime.toISOString(), expiresAt: new Date(f.mtime.getTime() + retentionHours * 3600_000).toISOString() };
	if (isInlineImage(f.name) && mime.startsWith("image/")) return { ...base, kind: "image" };
	let slice = f.bytes.subarray(0, Math.min(f.bytes.length, PREVIEW_BYTES));
	const truncated = f.size > PREVIEW_BYTES;
	if (truncated) while (slice.length && !isUtf8(slice) && slice.length > PREVIEW_BYTES - 4) slice = slice.subarray(0, slice.length - 1); // cut mid-character
	const head = slice.subarray(0, 8192);
	const text = !head.includes(0) && isUtf8(slice);
	if (!text) return { ...base, kind: "binary" };
	return { ...base, kind: "text", text: Buffer.from(slice).toString("utf8"), truncated, language: TEXT_LANG[extOf(f.name)] };
}

export interface Owner {
	uid: number;
	gid: number;
}
const chown = (p: string, owner?: Owner) => {
	if (!owner) return;
	try {
		chownSync(p, owner.uid, owner.gid);
	} catch {
		/* best effort */
	}
};

/** mkdir -p inside the workdir, giving every directory it creates to `owner` when the server runs as root for a container user. */
export function mkdirp(workdir: string, rel: string, owner?: Owner): string {
	const { abs, rel: clean } = resolveIn(workdir, rel);
	let cur = workdir;
	for (const seg of clean ? clean.split("/") : []) {
		cur = join(cur, seg);
		if (!existsSync(cur)) {
			mkdirSync(cur);
			chown(cur, owner);
		} else if (!lstatSync(cur).isDirectory() && !lstatSync(cur).isSymbolicLink()) throw new HttpError(409, "not_a_directory", `${seg} 已存在且不是目录`);
	}
	return abs;
}

export function writeBytes(workdir: string, rel: string, bytes: Uint8Array, owner?: Owner): string {
	const { abs, rel: clean } = resolveIn(workdir, rel);
	if (!clean) throw bad("需要文件路径");
	mkdirp(workdir, dirname(clean) === "." ? "" : dirname(clean), owner);
	if (existsSync(abs) && lstatSync(abs).isDirectory()) throw new HttpError(409, "is_a_directory", "目标是目录");
	const fd = openSync(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o644);
	try {
		let off = 0;
		while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
	} finally {
		closeSync(fd);
	}
	chown(abs, owner);
	return clean;
}

export function remove(workdir: string, rel: string): { removed: string; kind: "file" | "directory" } {
	const { abs, rel: clean } = resolveIn(workdir, rel, { followFinal: false });
	if (!clean) throw bad("不能删除工作目录本身");
	let st;
	try {
		st = lstatSync(abs);
	} catch {
		throw new HttpError(404, "not_found", "文件或目录不存在");
	}
	const kind = st.isDirectory() ? "directory" : "file";
	rmSync(abs, { recursive: true, force: true }); // lstat-based: a symlink is removed, never followed
	return { removed: clean, kind };
}

export function move(workdir: string, from: string, to: string): { from: string; to: string } {
	const a = resolveIn(workdir, from, { followFinal: false });
	const b = resolveIn(workdir, to);
	if (!a.rel || !b.rel) throw bad("需要源路径和目标路径");
	if (!existsSync(a.abs)) throw new HttpError(404, "not_found", "源文件不存在");
	if (existsSync(b.abs)) throw new HttpError(409, "exists", "目标已存在");
	if (b.rel === a.rel || b.rel.startsWith(`${a.rel}/`)) throw bad("不能移动到自身内部");
	mkdirp(workdir, dirname(b.rel) === "." ? "" : dirname(b.rel));
	renameSync(a.abs, b.abs);
	return { from: a.rel, to: b.rel };
}
