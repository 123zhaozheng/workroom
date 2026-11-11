// Round 9 (B2): per-conversation menu state — per-user star, per-conversation tags, soft delete, Markdown export —
// and the shared "which conversations may this caller see" lookup used by search.
//
// Permissions: every decision goes through Runtime.access() (ACL first, then existence; B1 extends it for shared projects
// and for deleted conversations) or the AccessControl service. Nothing here re-implements an ACL rule. Only the visible
// set comes from Runtime.list(), the same code path the sidebar uses.
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { LiveDoc, type EntryId, type EntryRecord } from "@earendil-works/pi-durable";
import type { Principal } from "../core/contracts.ts";
import { HttpError, nowIso } from "../core/http.ts";
import type { ConversationSummary } from "../../../shared/chat.ts";
import type { ConversationMetaDTO } from "../../../shared/round9.ts";
import { entryDTO } from "./dto.ts";
import type { CatalogRow, Runtime } from "./service.ts";

export const MAX_TAGS = 8;
export const MAX_TAG_LENGTH = 24;
/** Markdown export limits: entries scanned and bytes produced (the file says so when it is cut). */
export const EXPORT_MAX_ENTRIES = 20_000;
export const EXPORT_MAX_BYTES = 2 * 1024 * 1024;

export type CatalogRowX = CatalogRow & { deleted_at?: string | null; deleted_by?: string | null };

export interface VisibleConversation {
	readonly summary: ConversationSummary;
	readonly access: "own" | "member" | "shared";
}

export const keyOf = (spaceId: string, conversationId: number): string => `${spaceId}:${conversationId}`;

/** Trim, collapse whitespace, drop control characters, ≤ 24 characters each, case-insensitive de-dupe, ≤ 8 tags (extra ones are dropped). */
export function normaliseTags(input: unknown): string[] {
	if (!Array.isArray(input)) throw new HttpError(400, "invalid_tags", "tags 必须是字符串数组");
	if (input.length > 200) throw new HttpError(400, "invalid_tags", "标签过多");
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of input) {
		if (typeof raw !== "string") throw new HttpError(400, "invalid_tags", "tags 必须是字符串数组");
		const clean = [...raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()].slice(0, MAX_TAG_LENGTH).join("").trim();
		if (!clean) continue;
		const k = clean.toLowerCase();
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(clean);
		if (out.length >= MAX_TAGS) break;
	}
	return out;
}

/** A chat turn as search / preview / export see it: user displayText (test directives hidden) or assistant text. Everything else is not a turn. */
export function turnOf(e: EntryRecord, name?: (userId: string) => string | undefined): { role: "user" | "assistant"; text: string; entryId: number; author?: string } | undefined {
	if (e.kind !== "wr.input" && e.kind !== "pi.user" && e.kind !== "pi.assistant") return undefined;
	const d = entryDTO(e, name);
	if (d.kind === "user") {
		const text = (d.displayText ?? d.text).trim();
		return text ? { role: "user", text, entryId: e.id as number, ...(d.authorName ? { author: d.authorName } : {}) } : undefined;
	}
	if (d.kind === "assistant") {
		const text = d.text.trim();
		return text ? { role: "assistant", text, entryId: e.id as number } : undefined;
	}
	return undefined;
}

const notFound = () => new HttpError(404, "not_found", "会话不存在");

export class ConversationMeta {
	readonly rt: Runtime;
	/**
	 * Hook: how the visible conversations are listed. Defaults to Runtime.list() (active + archived, ≤ 200 each — the list cap).
	 * The integrator may replace it with an uncapped variant once B1's list supports it (see docs/requests/round9-b2.md).
	 */
	lister: (p: Principal, context: Context) => Promise<ConversationSummary[]>;

	constructor(rt: Runtime) {
		this.rt = rt;
		this.lister = async (p, context) => {
			const both = (q: { projectId?: string }) => Promise.all([rt.list(p, { ...q, limit: 200, archived: false }, context), rt.list(p, { ...q, limit: 200, archived: true }, context)]).then(([a, b]) => [...a, ...b]);
			const out = await both({});
			// Conversations shared with the caller through a container project are listed per project (not in recents).
			const identity = rt.ctx.services.get("identity");
			for (const projectId of identity.sharedProjectIds(p.userId, p.orgId)) out.push(...(await both({ projectId }).catch(() => [])));
			return out;
		};
	}

	get db() {
		return this.rt.ctx.db;
	}

	// ------------------------------------------------------------------ visibility

	/** Conversations the caller may read right now (same path as the sidebar list), soft-deleted ones removed, newest first. */
	async visible(p: Principal, context: Context = BACKGROUND_CONTEXT): Promise<VisibleConversation[]> {
		const all = (await this.lister(p, context)).filter((s) => s.kind !== "subagent");
		const seen = new Set<string>();
		const uniq = all.filter((s) => {
			const k = keyOf(s.spaceId, s.conversationId);
			if (seen.has(k)) return false;
			seen.add(k);
			return true;
		});
		const deleted = this.#deletedKeys(uniq.map((s) => s.spaceId));
		const identity = this.rt.ctx.services.get("identity");
		const out: VisibleConversation[] = [];
		for (const s of uniq) {
			if (deleted.has(keyOf(s.spaceId, s.conversationId))) continue;
			let access = s.access;
			if (!access) {
				const space = identity.space(s.spaceId);
				access = space?.kind === "personal" && space.ownerUserId === p.userId ? "own" : space?.kind === "project" ? "member" : "shared";
			}
			out.push({ summary: s, access });
		}
		out.sort((a, b) => (a.summary.updatedAt < b.summary.updatedAt ? 1 : a.summary.updatedAt > b.summary.updatedAt ? -1 : b.summary.conversationId - a.summary.conversationId));
		return out;
	}

	#deletedKeys(spaceIds: readonly string[]): Set<string> {
		const spaces = [...new Set(spaceIds)];
		if (!spaces.length) return new Set();
		const rows = this.db.all<{ space_id: string; conversation_id: number }>("SELECT space_id, conversation_id FROM rt_conversations WHERE deleted_at IS NOT NULL AND space_id IN (SELECT value FROM json_each(?))", JSON.stringify(spaces));
		return new Set(rows.map((r) => keyOf(r.space_id, r.conversation_id)));
	}

	/** starred (this user) + tags for a set of conversations. */
	metaOf(userId: string, convs: readonly { spaceId: string; conversationId: number }[]): Map<string, { starred: boolean; tags: string[] }> {
		const out = new Map<string, { starred: boolean; tags: string[] }>();
		for (const c of convs) out.set(keyOf(c.spaceId, c.conversationId), { starred: false, tags: [] });
		if (!convs.length) return out;
		const spaces = JSON.stringify([...new Set(convs.map((c) => c.spaceId))]);
		for (const r of this.db.all<{ space_id: string; conversation_id: number }>("SELECT space_id, conversation_id FROM rt_conversation_stars WHERE user_id = ? AND space_id IN (SELECT value FROM json_each(?))", userId, spaces)) {
			const m = out.get(keyOf(r.space_id, r.conversation_id));
			if (m) m.starred = true;
		}
		for (const r of this.db.all<{ space_id: string; conversation_id: number; tag: string }>("SELECT space_id, conversation_id, tag FROM rt_conversation_tags WHERE space_id IN (SELECT value FROM json_each(?)) ORDER BY pos, rowid", spaces)) {
			out.get(keyOf(r.space_id, r.conversation_id))?.tags.push(r.tag);
		}
		return out;
	}

	/** GET /conversation-meta */
	async list(p: Principal, context: Context = BACKGROUND_CONTEXT): Promise<ConversationMetaDTO[]> {
		const vis = await this.visible(p, context);
		const meta = this.metaOf(p.userId, vis.map((v) => v.summary));
		return vis.map((v) => {
			const m = meta.get(keyOf(v.summary.spaceId, v.summary.conversationId))!;
			return { spaceId: v.summary.spaceId, conversationId: v.summary.conversationId, starred: m.starred, tags: m.tags };
		});
	}

	// ------------------------------------------------------------------ access helper

	/** Runtime.access() (ACL, existence, B1's deleted/shared rules) plus our own deleted_at check: a deleted conversation is 404 for everyone. */
	async access(p: Principal, action: "read" | "write", spaceId: string, conversationId: number, context: Context) {
		const a = await this.rt.access(p, action, spaceId, conversationId, context);
		const row = a.row as CatalogRowX | undefined;
		if (!row || row.deleted_at) throw notFound();
		return { ...a, row };
	}

	// ------------------------------------------------------------------ star / tags

	/** Per-user flag; read access is enough (a shared reader may star what they can see). */
	async star(p: Principal, spaceId: string, conversationId: number, starred: unknown, context: Context): Promise<ConversationMetaDTO> {
		if (typeof starred !== "boolean") throw new HttpError(400, "invalid_starred", "starred 必须是布尔值");
		await this.access(p, "read", spaceId, conversationId, context);
		if (starred) this.db.run("INSERT INTO rt_conversation_stars (user_id, space_id, conversation_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", p.userId, spaceId, conversationId, nowIso());
		else this.db.run("DELETE FROM rt_conversation_stars WHERE user_id = ? AND space_id = ? AND conversation_id = ?", p.userId, spaceId, conversationId);
		const m = this.metaOf(p.userId, [{ spaceId, conversationId }]).get(keyOf(spaceId, conversationId))!;
		return { spaceId, conversationId, starred: m.starred, tags: m.tags };
	}

	/** Per-conversation tags; needs WRITE access (readers and shared readers cannot change them). Allowed on archived conversations. */
	async setTags(p: Principal, spaceId: string, conversationId: number, raw: unknown, context: Context): Promise<ConversationMetaDTO> {
		const tags = normaliseTags(raw);
		try {
			await this.access(p, "write", spaceId, conversationId, context);
		} catch (err) {
			// Runtime.access() refuses write on archived conversations AFTER the ACL passed; tagging is metadata, so it stays allowed.
			if (!(err instanceof HttpError && err.code === "archived")) throw err;
			await this.access(p, "read", spaceId, conversationId, context);
		}
		this.db.tx(() => {
			this.db.run("DELETE FROM rt_conversation_tags WHERE space_id = ? AND conversation_id = ?", spaceId, conversationId);
			tags.forEach((t, i) => this.db.run("INSERT INTO rt_conversation_tags (space_id, conversation_id, tag, pos, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", spaceId, conversationId, t, i, p.userId, nowIso()));
		});
		const m = this.metaOf(p.userId, [{ spaceId, conversationId }]).get(keyOf(spaceId, conversationId))!;
		return { spaceId, conversationId, starred: m.starred, tags: m.tags };
	}

	// ------------------------------------------------------------------ soft delete

	/**
	 * DELETE /conversations/:spaceId/:id — the creator (who must still have write access) or a space admin ("admin" on the space:
	 * the personal-space owner, or a project owner). Soft: rt_conversations.deleted_at/deleted_by are set; durable data, files and
	 * the search index rows stay on the server. A running conversation is aborted FIRST (background tasks included, the same
	 * Conversation.abort the "stop" button uses) and the delete only then marks the row; the audit record says whether a run was stopped.
	 */
	async remove(p: Principal, spaceId: string, conversationId: number, context: Context, requestId?: string): Promise<{ ok: true; wasRunning: boolean }> {
		const { harness, conv, row } = await this.access(p, "read", spaceId, conversationId, context);
		let allowed = false;
		if (row.created_by === p.userId) allowed = (await this.rt.acl.check(p, "write", { kind: "conversation", id: String(conversationId), spaceId })).allow;
		if (!allowed) allowed = (await this.rt.acl.check(p, "admin", { kind: "space", id: spaceId })).allow;
		if (!allowed) throw new HttpError(403, "forbidden", "只有会话创建者或空间管理员可以删除会话");

		const live = await harness.snapshot(LiveDoc, conv.id, context);
		const wasRunning = !!live?.run;
		try {
			await conv.abort(context, { background: true });
		} catch (err) {
			// idle conversations have nothing to abort
			if (wasRunning) throw err;
		}
		if (wasRunning) {
			const until = Date.now() + 5_000;
			while (Date.now() < until && (await harness.snapshot(LiveDoc, conv.id, context))?.run) await new Promise((r) => setTimeout(r, 25));
			if (this.rt.ctx.services.has("usage")) (this.rt.ctx.services.get("usage") as { markDirty?: (s: string, c: number) => void }).markDirty?.(spaceId, conversationId);
		}
		const at = nowIso();
		const r = this.db.run("UPDATE rt_conversations SET deleted_at = ?, deleted_by = ? WHERE space_id = ? AND conversation_id = ? AND deleted_at IS NULL", at, p.userId, spaceId, conversationId);
		if (r.changes === 0) throw notFound();
		(this.rt.ctx.services.get("audit") as { record(input: unknown): string }).record({
			orgId: p.orgId,
			actorUserId: p.userId,
			action: "conversation.delete",
			target: `${spaceId}/${conversationId}`,
			detail: { spaceId, conversationId, title: row.title, createdBy: row.created_by, kind: row.kind, wasRunning, soft: true },
			...(requestId ? { requestId } : {}),
		});
		return { ok: true, wasRunning };
	}

	// ------------------------------------------------------------------ export

	/** GET …/export?format=md — Markdown of the user/assistant turns (read access). */
	async exportMarkdown(p: Principal, spaceId: string, conversationId: number, context: Context): Promise<{ filename: string; body: string; truncated: boolean }> {
		const { conv, row } = await this.access(p, "read", spaceId, conversationId, context);
		const names = new Map<string, string | undefined>();
		const name = (u: string) => {
			if (!names.has(u)) names.set(u, this.rt.userName(u));
			return names.get(u);
		};
		const entries: EntryRecord[] = [];
		let cursor: any;
		let more = false;
		for (;;) {
			const page = await conv.entries({ order: "ascending" }, 200, cursor, context);
			entries.push(...page.items);
			if (!page.next) break;
			if (entries.length >= EXPORT_MAX_ENTRIES) {
				more = true;
				break;
			}
			cursor = page.next;
		}
		const toolResults = new Map<string, boolean>();
		for (const e of entries) {
			if (e.kind !== "pi.tool-result") continue;
			const d = entryDTO(e);
			if (d.kind === "tool_result") toolResults.set(d.callId, d.isError);
		}
		const lines: string[] = [`# ${row.title.replace(/\s+/g, " ").trim() || "未命名会话"}`, "", `- 创建时间：${row.created_at}`, `- 最近更新：${row.updated_at}`, `- 导出时间：${nowIso()}`, `- 会话：${spaceId} / ${conversationId}`, ""];
		let size = lines.join("\n").length;
		let truncated = more;
		const push = (block: string): boolean => {
			if (size + block.length > EXPORT_MAX_BYTES / 3) {
				// ~3 bytes per CJK character: stay under the byte cap in the worst case
				truncated = true;
				return false;
			}
			lines.push(block, "");
			size += block.length + 1;
			return true;
		};
		for (const e of entries) {
			const d = entryDTO(e, name);
			if (d.kind === "user" && (e.kind === "wr.input" || e.kind === "pi.user")) {
				const text = (d.displayText ?? d.text).trim();
				if (text && !push(`## 用户${d.authorName ? `（${d.authorName}）` : ""}\n\n${text}`)) break;
			} else if (d.kind === "assistant") {
				const parts: string[] = [];
				if (d.text.trim()) parts.push(d.text.trim());
				for (const call of d.toolCalls) parts.push(`> 工具调用：\`${call.name}\`${argKeys(call.arguments)}${toolResults.has(call.id) ? (toolResults.get(call.id) ? " — 失败" : " — 完成") : ""}`);
				if (parts.length && !push(`## 助手\n\n${parts.join("\n\n")}`)) break;
			}
		}
		if (truncated) lines.push("> （内容过长，导出已截断）", "");
		const safe = row.title.replace(/[\u0000-\u001f\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || `conversation-${conversationId}`;
		return { filename: safe, body: lines.join("\n"), truncated };
	}

	/** Up to `limit` chat turns around `entryId` (or the latest ones), for the search preview pane (read access). */
	async turnsAround(p: Principal, spaceId: string, conversationId: number, entryId: number | undefined, context: Context, limit = 6): Promise<{ title: string; turns: { role: "user" | "assistant"; text: string; entryId: number }[] }> {
		const { conv, row } = await this.access(p, "read", spaceId, conversationId, context);
		const query = entryId ? { maxEntryId: (entryId + 40) as EntryId, order: "descending" as const } : { order: "descending" as const };
		const page = await conv.entries(query, 120, undefined, context);
		const names = new Map<string, string | undefined>();
		const name = (u: string) => (names.has(u) ? names.get(u) : (names.set(u, this.rt.userName(u)), names.get(u)));
		const turns = [...page.items]
			.reverse()
			.map((e) => turnOf(e, name))
			.filter((t): t is NonNullable<typeof t> => !!t)
			.map((t) => ({ role: t.role, text: t.text.length > 800 ? `${t.text.slice(0, 799)}…` : t.text, entryId: t.entryId }));
		let hit = turns.length - 1;
		if (entryId) {
			const i = turns.findLastIndex((t) => t.entryId <= entryId);
			hit = i < 0 ? 0 : i;
		}
		let start = Math.max(0, hit - 2);
		const end = Math.min(turns.length, start + limit);
		start = Math.max(0, end - limit);
		return { title: row.title, turns: turns.slice(start, end) };
	}
}

/** Argument NAMES only (never values): a one-line hint of what the call was about without leaking what was passed. */
function argKeys(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const keys = Object.keys(args as object).slice(0, 6);
	return keys.length ? `（参数：${keys.join("、")}）` : "";
}
