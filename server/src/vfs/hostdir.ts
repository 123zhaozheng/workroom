// Shared helpers for backends whose content lives in a host directory (/work, /memory): symlink-safe resolution (round 7 resolveIn),
// listing, atomic writes (temp file + rename), removal and a bounded walk for search. Errors are VfsErrors with virtual paths only.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as ws from "../tools/sandbox/workspace.ts";
import { effectiveMime } from "../files/mime.ts";
import { joinVirtual } from "./path.ts";
import { VfsError, type Cap, type VNode } from "./types.ts";

export const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

export function resolveHost(root: string, rel: string, opts: { followFinal?: boolean } = {}): string {
	mkdirSync(root, { recursive: true });
	try {
		return ws.resolveIn(root, rel, opts).abs;
	} catch (e) {
		throw new VfsError("forbidden", (e as Error).message.includes("之外") ? "路径指向允许范围之外" : "路径无效", 403);
	}
}

export function hostNode(root: string, rel: string, vroot: string, caps: { file: readonly Cap[]; dir: readonly Cap[] }, withEtag = false): VNode | null {
	const abs = resolveHost(root, rel);
	let st;
	try {
		st = statSync(abs);
	} catch {
		return null;
	}
	const path = joinVirtual(vroot, rel);
	const name = rel ? rel.slice(rel.lastIndexOf("/") + 1) : vroot.slice(1);
	if (st.isDirectory()) return { path, name, type: "dir", mtime: st.mtime.toISOString(), caps: caps.dir };
	if (!st.isFile()) return null;
	return { path, name, type: "file", size: st.size, mtime: st.mtime.toISOString(), mime: effectiveMime(undefined, name), caps: caps.file, ...(withEtag && st.size <= 32 * 1024 * 1024 ? { etag: sha256(readFileSync(abs)) } : {}) };
}

export function hostList(root: string, rel: string, vroot: string, caps: { file: readonly Cap[]; dir: readonly Cap[] }, opts: { cursor?: string; limit: number; hide?: (name: string) => boolean }): { entries: VNode[]; truncated: boolean } {
	const abs = resolveHost(root, rel);
	let st;
	try {
		st = statSync(abs);
	} catch {
		throw new VfsError("not_found", `${joinVirtual(vroot, rel)} 不存在`, 404);
	}
	if (!st.isDirectory()) throw new VfsError("not_a_directory", `${joinVirtual(vroot, rel)} 不是目录`);
	const names = readdirSync(abs)
		.filter((n) => !n.startsWith(".wr-") && n !== ".wake-mirror-dirty" && !(opts.hide?.(n) ?? false))
		.sort((a, b) => a.localeCompare(b));
	const start = opts.cursor ? names.findIndex((n) => n > opts.cursor!) : 0;
	const page = start < 0 ? [] : names.slice(start, start + opts.limit);
	const entries: VNode[] = [];
	for (const n of page) {
		const child = rel ? `${rel}/${n}` : n;
		let lst;
		try {
			lst = lstatSync(join(abs, n));
		} catch {
			continue;
		}
		if (lst.isSymbolicLink()) {
			// a link is shown only when it stays inside the root
			try {
				resolveHost(root, child);
			} catch {
				continue;
			}
		}
		const node = hostNode(root, child, vroot, caps);
		if (node) entries.push(node);
	}
	return { entries, truncated: start >= 0 && start + opts.limit < names.length };
}

export function hostRead(root: string, rel: string, vroot: string, maxBytes: number): Uint8Array {
	const abs = resolveHost(root, rel);
	let st;
	try {
		st = statSync(abs);
	} catch {
		throw new VfsError("not_found", `${joinVirtual(vroot, rel)} 不存在`, 404);
	}
	if (st.isDirectory()) throw new VfsError("not_a_file", `${joinVirtual(vroot, rel)} 是目录，请用 ls`);
	if (st.size > maxBytes) throw new VfsError("too_large", `文件过大（${Math.round(st.size / 1048576)} MB），上限 ${Math.round(maxBytes / 1048576)} MB`, 413);
	return new Uint8Array(readFileSync(abs));
}

/** Write atomically (temp + rename) so a reader never sees a half-written file. Parents are created. Returns the previous sha (or null). */
export function hostWriteAtomic(root: string, rel: string, vroot: string, bytes: Uint8Array, expectedEtag?: string): { before: string | null; after: string } {
	if (!rel) throw new VfsError("bad_path", "需要文件路径");
	const abs = resolveHost(root, rel);
	let before: string | null = null;
	if (existsSync(abs)) {
		const st = statSync(abs);
		if (st.isDirectory()) throw new VfsError("not_a_file", `${joinVirtual(vroot, rel)} 是目录`);
		before = sha256(readFileSync(abs));
	}
	if (expectedEtag !== undefined && expectedEtag !== (before ?? "")) throw new VfsError("etag_mismatch", `${joinVirtual(vroot, rel)} 已被修改（etag 不一致），请重新读取后再写`, 409);
	const after = sha256(bytes);
	if (before === after) return { before, after };
	mkdirSync(dirname(abs), { recursive: true });
	const tmp = join(dirname(abs), `.wr-tmp-${randomBytes(6).toString("hex")}`);
	writeFileSync(tmp, bytes);
	renameSync(tmp, abs);
	return { before, after };
}

export function hostRemove(root: string, rel: string, vroot: string, recursive: boolean): void {
	if (!rel) throw new VfsError("forbidden", `不能删除 ${vroot} 本身`, 403);
	const abs = resolveHost(root, rel, { followFinal: false });
	let st;
	try {
		st = lstatSync(abs);
	} catch {
		throw new VfsError("not_found", `${joinVirtual(vroot, rel)} 不存在`, 404);
	}
	if (st.isDirectory() && !recursive && readdirSync(abs).length) throw new VfsError("bad_path", `${joinVirtual(vroot, rel)} 是非空目录：确实要删除整个目录请传 recursive: true`);
	rmSync(abs, { recursive: true, force: true });
}

/** Bounded depth-first walk yielding file paths relative to the root (dot-internal files skipped). */
export function* hostWalk(root: string, rel: string, cap = 5000): Generator<{ rel: string; abs: string; size: number }> {
	const start = resolveHost(root, rel);
	const stack = [{ abs: start, rel }];
	let seen = 0;
	while (stack.length && seen < cap) {
		const cur = stack.pop()!;
		let names: string[];
		try {
			names = readdirSync(cur.abs);
		} catch {
			continue;
		}
		for (const n of names.sort()) {
			if (n.startsWith(".wr-")) continue;
			const abs = join(cur.abs, n);
			const r = cur.rel ? `${cur.rel}/${n}` : n;
			let st;
			try {
				st = lstatSync(abs);
			} catch {
				continue;
			}
			if (st.isSymbolicLink()) continue;
			if (st.isDirectory()) stack.push({ abs, rel: r });
			else if (st.isFile()) {
				seen++;
				yield { rel: r, abs, size: st.size };
			}
		}
	}
}
