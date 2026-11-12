// Round 14: the agent's virtual filesystem. One POSIX namespace (/skills /memory /library /uploads /work), each root served by a backend
// that enforces its own permissions and operation rules. Agent-facing paths are always virtual: host directories, object keys and provider
// paths never appear in results or errors.
import type { Principal, Space } from "../core/contracts.ts";

export type NodeType = "file" | "dir";
/** What the CURRENT identity can really do with a node (enforced by the backend, not by the prompt). */
export type Cap = "read" | "write" | "edit" | "remove" | "exec";

export interface VNode {
	/** Absolute virtual path, e.g. "/work/out/a.csv". */
	readonly path: string;
	readonly name: string;
	readonly type: NodeType;
	readonly size?: number;
	readonly mtime?: string;
	readonly mime?: string;
	/** Content revision for conditional writes (sha256 of the bytes); an implementation detail, not a version. */
	readonly etag?: string;
	readonly caps: readonly Cap[];
	/** Short human note, e.g. "只读：已安装技能" */
	readonly note?: string;
}

/** Who acts, where: resolved from the run's persisted execution identity (round 13), never from message history. */
export interface VfsContext {
	readonly principal: Principal;
	readonly space: Space;
	readonly conversationId: number;
	readonly taskId?: number;
	readonly callId?: string;
	readonly signal?: AbortSignal;
}

export type VfsErrorCode =
	| "bad_path"
	| "unknown_root"
	| "not_found"
	| "not_a_file"
	| "not_a_directory"
	| "forbidden"
	| "read_only"
	| "use_present_file"
	| "etag_mismatch"
	| "exists"
	| "no_match"
	| "ambiguous_match"
	| "too_large"
	| "quota"
	| "unavailable"
	| "binary"
	| "fetch_failed";

export class VfsError extends Error {
	readonly code: VfsErrorCode;
	readonly status: number;
	constructor(code: VfsErrorCode, message: string, status = 400) {
		super(message);
		this.code = code;
		this.status = status;
	}
}

export interface WriteResult {
	readonly node: VNode;
	readonly status: "created" | "updated" | "unchanged";
}

export interface ListResult {
	readonly entries: readonly VNode[];
	/** More entries exist after this page (pass `cursor` = the last returned name to continue). */
	readonly truncated: boolean;
}

/**
 * A backend serves one virtual root. `rel` is the path below the root without a leading slash ("" = the root itself), already
 * normalized (no "..", no empty segments). Backends throw VfsError; anything else is reported as an internal error.
 */
export interface VfsBackend {
	/** "/work", "/memory", … */
	readonly root: string;
	/** One line for the root listing and the prompt. */
	readonly label: string;
	/** Is the root usable by this identity here at all (e.g. /uploads without a conversation)? */
	available(ctx: VfsContext): boolean | Promise<boolean>;
	/** Caps of the root directory for this identity (what `ls /` shows). */
	rootCaps(ctx: VfsContext): readonly Cap[] | Promise<readonly Cap[]>;
	stat(ctx: VfsContext, rel: string): Promise<VNode | null>;
	list(ctx: VfsContext, rel: string, opts: { cursor?: string; limit: number }): Promise<ListResult>;
	read(ctx: VfsContext, rel: string): Promise<{ node: VNode; bytes: Uint8Array }>;
	write?(ctx: VfsContext, rel: string, bytes: Uint8Array, opts: { expectedEtag?: string }): Promise<WriteResult>;
	remove?(ctx: VfsContext, rel: string, opts: { recursive?: boolean }): Promise<{ removed: string }>;
	/** Optional fast search; the router falls back to walking `list`. */
	search?(ctx: VfsContext, rel: string, query: string, mode: "name" | "content", limit: number): Promise<{ hits: readonly SearchHit[]; truncated: boolean }>;
}

export interface SearchHit {
	readonly path: string;
	readonly line?: number;
	readonly text?: string;
}

export const ROOT_ORDER = ["/skills", "/memory", "/library", "/uploads", "/work"] as const;
