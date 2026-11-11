// Round 9 (B2): global conversation search (Ctrl/Cmd+K).
//
// Index: rt_search_docs holds ONE row per user/assistant turn (user displayText with test directives removed, assistant answer text);
// tool calls/arguments/results, notices, thinking and every other entry kind are never indexed, so credential values, tool args and
// secrets handled by tools cannot appear. rt_search_fts is an external-content FTS5 trigram table over it (substring search, CJK
// included), kept in sync by triggers. rt_search_progress(space, conversation, last_entry_id) makes indexing incremental.
//
// Indexing is lazy and bounded: a search first brings the caller's visible conversations up to date within a time/entry budget
// (new conversations and most recently updated ones first, 4 at a time), then queries. A light background timer does the same for
// conversations in spaces whose harness is already open (it never wakes a cold space). Anything not yet caught up is reported as
// `partial: true`; title / tag / project matches never depend on the index.
//
// Permissions: the candidate set is the caller's own visible conversations (ConversationMeta.visible → Runtime.list, deleted removed);
// the SQL only ever sees those keys, so text of conversations the caller cannot read is neither matched nor returned.
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { EntryId, Harness } from "@earendil-works/pi-durable";
import type { Principal } from "../core/contracts.ts";
import { HttpError, nowIso } from "../core/http.ts";
import type { SearchHitDTO } from "../../../shared/round9.ts";
import { keyOf, turnOf, type ConversationMeta, type VisibleConversation } from "./meta.ts";
import { cid, type Runtime } from "./service.ts";

export const DOC_TEXT_MAX = 40_000;
export const SNIPPET_MAX = 160;
const MAX_TERMS = 8;
const FTS_ROWS = 600;

export interface SearchOptions {
	/** Time budget of the incremental indexing a search does before querying. */
	budgetMs: number;
	/** Entries read per search call at most. */
	budgetEntries: number;
	/** A conversation verified up to date is not re-checked for this long. */
	recheckMs: number;
	/** Background indexer period; 0 disables it. */
	backgroundMs: number;
}

export interface SearchResponse {
	results: SearchHitDTO[];
	indexedThrough?: string;
	/** Extra (not in the fixed contract): some visible conversations were not fully indexed within the budget. */
	partial?: boolean;
}

const cps = (s: string): number => [...s].length;
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** Split a query into at most 8 distinct lower-cased terms. */
export function queryTerms(q: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const t of q.toLowerCase().split(/\s+/)) {
		if (!t || seen.has(t)) continue;
		seen.add(t);
		out.push(t);
		if (out.length >= MAX_TERMS) break;
	}
	return out;
}

/** Plain-text excerpt (≤ 160 chars) around the first occurrence of any term; light markdown removed. */
export function snippetOf(text: string, terms: readonly string[]): string {
	const plain = text
		.replace(/```[a-z]*\n?/gi, " ")
		.replace(/[`*_>#]+/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
	if (!plain) return "";
	const lower = plain.toLowerCase();
	let at = -1;
	for (const t of terms) {
		const i = lower.indexOf(t);
		if (i >= 0 && (at < 0 || i < at)) at = i;
	}
	const chars = [...plain];
	if (chars.length <= SNIPPET_MAX) return plain;
	// positions are in UTF-16 units; convert the hit to a code point index. Room for both ellipses is always kept.
	const hit = at < 0 ? 0 : [...plain.slice(0, at)].length;
	const room = SNIPPET_MAX - 2;
	let start = Math.max(0, hit - 40);
	const end = Math.min(chars.length, start + room);
	start = Math.max(0, end - room);
	return `${start > 0 ? "…" : ""}${chars.slice(start, end).join("")}${end < chars.length ? "…" : ""}`;
}

type Budget = { until: number; entries: number };

export class SearchIndex {
	readonly rt: Runtime;
	readonly meta: ConversationMeta;
	readonly opts: SearchOptions;
	readonly #verified = new Map<string, number>();
	readonly #locks = new Map<string, Promise<unknown>>();
	#timer: NodeJS.Timeout | undefined;
	#ticking = false;

	constructor(rt: Runtime, meta: ConversationMeta, opts: SearchOptions) {
		this.rt = rt;
		this.meta = meta;
		this.opts = opts;
	}

	get db() {
		return this.rt.ctx.db;
	}

	// ------------------------------------------------------------------ lifecycle

	start(): void {
		if (this.opts.backgroundMs <= 0 || this.#timer) return;
		this.#timer = setInterval(() => void this.tick().catch((e) => console.error("[search] background index", e?.message ?? e)), this.opts.backgroundMs);
		this.#timer.unref();
	}

	stop(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
	}

	/** One background pass: conversations of already-open spaces, newest first. Never opens a space. Returns entries indexed. */
	async tick(budgetMs = 1_000, budgetEntries = 2_000): Promise<number> {
		if (this.#ticking) return 0;
		this.#ticking = true;
		try {
			const budget: Budget = { until: Date.now() + budgetMs, entries: budgetEntries };
			const before = budget.entries;
			const rows = this.db.all<{ space_id: string; conversation_id: number }>("SELECT space_id, conversation_id FROM rt_conversations WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 300");
			for (const r of rows) {
				if (Date.now() > budget.until || budget.entries <= 0) break;
				const harness = this.rt.manager.openHarness(r.space_id);
				if (!harness) continue;
				await this.#index(harness, r.space_id, r.conversation_id, budget).catch(() => {});
			}
			return before - budget.entries;
		} finally {
			this.#ticking = false;
		}
	}

	// ------------------------------------------------------------------ indexing

	#serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.#locks.get(key) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		const tail = next.catch(() => {});
		this.#locks.set(key, tail);
		void tail.then(() => {
			if (this.#locks.get(key) === tail) this.#locks.delete(key);
		});
		return next;
	}

	/** Bring one conversation's index up to its newest entry (within `budget`). true = caught up. */
	#index(harness: Harness, spaceId: string, conversationId: number, budget: Budget): Promise<boolean> {
		const key = keyOf(spaceId, conversationId);
		return this.#serial(key, async () => {
			const ctx = BACKGROUND_CONTEXT;
			const conv = await harness.conversation(cid(conversationId), ctx);
			if (!conv) return true;
			const prog = this.db.get<{ last_entry_id: number }>("SELECT last_entry_id FROM rt_search_progress WHERE space_id = ? AND conversation_id = ?", spaceId, conversationId);
			let last: number = prog?.last_entry_id ?? -1;
			if (last < 0) {
				// A branch's visible history starts with its parent's entries: those belong to the parent's index, not ours.
				const record = await harness.commit((tx) => tx.conversation(cid(conversationId)), ctx);
				last = record?.parent ? (record.parent.at as number) : 0;
			}
			const tail = await conv.entries({ order: "descending" }, 1, undefined, ctx);
			const newest = (tail.items[0]?.id as number | undefined) ?? 0;
			if (newest <= last) {
				if (!prog) this.#saveProgress(spaceId, conversationId, last, []);
				this.#verified.set(key, Date.now());
				return true;
			}
			let cursor: any;
			for (;;) {
				const page = await conv.entries({ minEntryId: (last + 1) as EntryId, order: "ascending" }, 100, cursor, ctx);
				const docs: { entryId: number; role: "user" | "assistant"; text: string }[] = [];
				let maxId: number = last;
				for (const e of page.items) {
					maxId = Math.max(maxId, e.id as number);
					const t = turnOf(e);
					if (t) docs.push({ entryId: t.entryId, role: t.role, text: t.text.length > DOC_TEXT_MAX ? t.text.slice(0, DOC_TEXT_MAX) : t.text });
				}
				if (page.items.length) this.#saveProgress(spaceId, conversationId, maxId, docs);
				budget.entries -= page.items.length;
				last = maxId;
				if (!page.next || !page.items.length) {
					this.#verified.set(key, Date.now());
					return true;
				}
				cursor = page.next;
				if (budget.entries <= 0 || Date.now() > budget.until) return false;
			}
		});
	}

	#saveProgress(spaceId: string, conversationId: number, lastEntryId: number, docs: readonly { entryId: number; role: string; text: string }[]): void {
		this.db.tx(() => {
			for (const d of docs) this.db.run("INSERT INTO rt_search_docs (space_id, conversation_id, entry_id, role, text) VALUES (?, ?, ?, ?, ?) ON CONFLICT (space_id, conversation_id, entry_id) DO NOTHING", spaceId, conversationId, d.entryId, d.role, d.text);
			this.db.run(
				"INSERT INTO rt_search_progress (space_id, conversation_id, last_entry_id, indexed_at) VALUES (?, ?, ?, ?) ON CONFLICT (space_id, conversation_id) DO UPDATE SET last_entry_id = max(last_entry_id, excluded.last_entry_id), indexed_at = excluded.indexed_at",
				spaceId,
				conversationId,
				lastEntryId,
				nowIso(),
			);
		});
	}

	/** Bring the given conversations up to date within the budget. Returns whether all were verified and the oldest indexed_at left behind. */
	async #refresh(vis: readonly VisibleConversation[]): Promise<{ complete: boolean; oldest?: string }> {
		const budget: Budget = { until: Date.now() + this.opts.budgetMs, entries: this.opts.budgetEntries };
		const progress = new Map<string, string>();
		for (const r of this.db.all<{ space_id: string; conversation_id: number; indexed_at: string }>("SELECT space_id, conversation_id, indexed_at FROM rt_search_progress WHERE space_id IN (SELECT value FROM json_each(?))", JSON.stringify([...new Set(vis.map((v) => v.summary.spaceId))]))) progress.set(keyOf(r.space_id, r.conversation_id), r.indexed_at);
		const now = Date.now();
		const todo = vis.filter((v) => now - (this.#verified.get(keyOf(v.summary.spaceId, v.summary.conversationId)) ?? 0) > this.opts.recheckMs);
		// never-indexed first, then newest
		todo.sort((a, b) => Number(progress.has(keyOf(a.summary.spaceId, a.summary.conversationId))) - Number(progress.has(keyOf(b.summary.spaceId, b.summary.conversationId))));
		const behind: string[] = [];
		let i = 0;
		while (i < todo.length) {
			if (Date.now() > budget.until || budget.entries <= 0) {
				for (const v of todo.slice(i)) behind.push(progress.get(keyOf(v.summary.spaceId, v.summary.conversationId)) ?? "");
				break;
			}
			const batch = todo.slice(i, i + 4);
			i += batch.length;
			await Promise.all(
				batch.map(async (v) => {
					const { spaceId, conversationId } = v.summary;
					try {
						const harness = await this.rt.manager.get(spaceId);
						if (!(await this.#index(harness, spaceId, conversationId, budget))) behind.push(progress.get(keyOf(spaceId, conversationId)) ?? "");
					} catch (e) {
						behind.push(progress.get(keyOf(spaceId, conversationId)) ?? "");
						console.error("[search] index", spaceId, conversationId, (e as Error)?.message ?? e);
					}
				}),
			);
		}
		const known = behind.filter(Boolean).sort();
		return { complete: behind.length === 0, ...(known.length ? { oldest: known[0] } : {}) };
	}

	// ------------------------------------------------------------------ query

	/**
	 * GET /search. Empty query → the caller's most recently updated conversations. 1 character → title / tag prefix only.
	 * ≥ 2 characters → title, tag, project name and message text (terms ≥ 3 characters through the FTS5 trigram index, shorter
	 * terms through LIKE on the indexed turns). Multiple terms must all match (messages: within one turn).
	 */
	async search(p: Principal, rawQuery: string, limitIn: number | undefined, context: Context = BACKGROUND_CONTEXT): Promise<SearchResponse> {
		const q = rawQuery.trim().replace(/\s+/g, " ").slice(0, 200);
		const limit = Math.min(Math.max(Math.trunc(Number(limitIn)) || 20, 1), 50);
		const vis = await this.meta.visible(p, context);
		const meta = this.meta.metaOf(p.userId, vis.map((v) => v.summary));
		const projectNames = this.#projectNames(vis);
		const hitOf = (v: VisibleConversation, matchedIn: SearchHitDTO["matchedIn"], snippet: string, entryId?: number): SearchHitDTO => {
			const s = v.summary;
			const m = meta.get(keyOf(s.spaceId, s.conversationId))!;
			const projectName = s.projectName ?? (s.projectId ? projectNames.get(s.projectId) : undefined);
			return {
				spaceId: s.spaceId,
				conversationId: s.conversationId,
				title: s.title,
				...(s.projectId ? { projectId: s.projectId } : {}),
				...(projectName ? { projectName } : {}),
				tags: m.tags,
				starred: m.starred,
				matchedIn,
				snippet,
				...(entryId !== undefined ? { entryId } : {}),
				updatedAt: s.updatedAt,
				access: v.access,
			};
		};
		const terms = queryTerms(q);
		if (!terms.length) return { results: vis.slice(0, limit).map((v) => hitOf(v, [], "")), indexedThrough: nowIso() };

		if (cps(q) < 2) {
			const t = terms[0]!;
			const results: SearchHitDTO[] = [];
			for (const v of vis) {
				const m = meta.get(keyOf(v.summary.spaceId, v.summary.conversationId))!;
				const inTitle = v.summary.title.toLowerCase().startsWith(t);
				const inTag = m.tags.some((g) => g.toLowerCase().startsWith(t));
				if (inTitle || inTag) results.push(hitOf(v, [...(inTitle ? ["title" as const] : []), ...(inTag ? ["tag" as const] : [])], ""));
				if (results.length >= limit) break;
			}
			return { results, indexedThrough: nowIso() };
		}

		const refreshed = await this.#refresh(vis);
		const messageHits = this.#messageHits(vis, terms);
		const scored: { hit: SearchHitDTO; score: number; at: string }[] = [];
		const qLower = terms.join(" ");
		for (const v of vis) {
			const s = v.summary;
			const key = keyOf(s.spaceId, s.conversationId);
			const m = meta.get(key)!;
			const all = (text: string) => terms.every((t) => text.toLowerCase().includes(t));
			const inTitle = all(s.title);
			const inTag = m.tags.some((g) => all(g));
			const pname = s.projectName ?? (s.projectId ? projectNames.get(s.projectId) : undefined);
			const inProject = !!pname && all(pname);
			const msg = messageHits.get(key);
			if (!inTitle && !inTag && !inProject && !msg) continue;
			const matchedIn: SearchHitDTO["matchedIn"][number][] = [];
			if (inTitle) matchedIn.push("title");
			if (inTag) matchedIn.push("tag");
			if (inProject) matchedIn.push("project");
			if (msg) matchedIn.push("message");
			const score = (inTitle ? (s.title.toLowerCase().startsWith(qLower) ? 120 : 100) : 0) + (inTag ? 60 : 0) + (inProject ? 30 : 0) + (msg ? 10 : 0);
			scored.push({ hit: hitOf(v, matchedIn, msg ? snippetOf(msg.text, terms) : "", msg?.entryId), score, at: s.updatedAt });
		}
		scored.sort((a, b) => b.score - a.score || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
		return {
			results: scored.slice(0, limit).map((x) => x.hit),
			indexedThrough: refreshed.complete ? nowIso() : refreshed.oldest || undefined,
			...(refreshed.complete ? {} : { partial: true }),
		};
	}

	#projectNames(vis: readonly VisibleConversation[]): Map<string, string> {
		const ids = [...new Set(vis.map((v) => v.summary.projectId).filter((x): x is string => !!x))];
		const out = new Map<string, string>();
		if (!ids.length) return out;
		try {
			for (const r of this.db.all<{ id: string; name: string }>("SELECT id, name FROM id_projects WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids))) out.set(r.id, r.name);
		} catch (e) {
			console.error("[search] project names", (e as Error)?.message ?? e);
		}
		return out;
	}

	/** Best matching turn per visible conversation. */
	#messageHits(vis: readonly VisibleConversation[], terms: readonly string[]): Map<string, { entryId: number; text: string }> {
		const out = new Map<string, { entryId: number; text: string }>();
		if (!vis.length) return out;
		const keys = JSON.stringify(vis.map((v) => keyOf(v.summary.spaceId, v.summary.conversationId)));
		const long = terms.filter((t) => cps(t) >= 3);
		const short = terms.filter((t) => cps(t) < 3);
		const likeSql = short.map(() => " AND d.text LIKE ? ESCAPE '\\'").join("");
		const likeParams = short.map((t) => `%${escapeLike(t)}%`);
		type Row = { space_id: string; conversation_id: number; entry_id: number; text: string };
		let rows: Row[];
		if (long.length) {
			const match = long.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
			rows = this.db.all<Row>(
				`SELECT d.space_id, d.conversation_id, d.entry_id, d.text FROM rt_search_fts f JOIN rt_search_docs d ON d.id = f.rowid
				 WHERE rt_search_fts MATCH ? AND (d.space_id || ':' || d.conversation_id) IN (SELECT value FROM json_each(?))${likeSql}
				 ORDER BY bm25(rt_search_fts) LIMIT ?`,
				match,
				keys,
				...likeParams,
				FTS_ROWS,
			);
		} else {
			// Only 2-character terms: LIKE over the visible turns; the earliest matching turn of each conversation.
			rows = this.db.all<Row>(
				`SELECT d.space_id, d.conversation_id, min(d.entry_id) AS entry_id, d.text FROM rt_search_docs d
				 WHERE (d.space_id || ':' || d.conversation_id) IN (SELECT value FROM json_each(?))${likeSql}
				 GROUP BY d.space_id, d.conversation_id LIMIT ?`,
				keys,
				...likeParams,
				FTS_ROWS,
			);
		}
		for (const r of rows) {
			const k = keyOf(r.space_id, r.conversation_id);
			if (!out.has(k)) out.set(k, { entryId: r.entry_id, text: r.text });
		}
		return out;
	}

	// ------------------------------------------------------------------ preview

	/** GET /search/preview/:spaceId/:conversationId?entryId= — ≤ 6 turns around the hit; read access (ConversationMeta.access). */
	async preview(p: Principal, spaceId: string, conversationId: number, entryId: number | undefined, context: Context = BACKGROUND_CONTEXT) {
		if (entryId !== undefined && (!Number.isInteger(entryId) || entryId <= 0)) throw new HttpError(400, "invalid_id", "entryId 无效");
		return this.meta.turnsAround(p, spaceId, conversationId, entryId, context, 6);
	}
}
