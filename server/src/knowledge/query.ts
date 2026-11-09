// Query planning for the trigram FTS index.
// - Latin/digit words of ≥3 chars → quoted FTS terms.
// - CJK runs of ≥3 chars → the run itself (when short) + its overlapping trigrams (n-gram recall; bm25 rewards chunks that
//   contain more / rarer trigrams, i.e. the longer contiguous overlaps).
// - Terms shorter than 3 chars cannot hit a trigram index: when the query has no ≥3-char term at all they become LIKE
//   terms (substring scan over live chunks); otherwise they only contribute to the coverage re-rank.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const TOKEN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}_]+/gu;
const MAX_TERMS = 48;
const STOP = new Set(["the", "and", "for", "are", "was", "with", "that", "this", "from", "what", "how", "who", "why", "when", "which", "does", "you", "your", "our"]);

export interface QueryPlan {
	/** FTS5 MATCH expression, or null when no term is long enough. */
	match: string | null;
	/** LIKE fallback terms (only when match is null). */
	like: string[];
	/** All normalized terms used for coverage / snippet. */
	terms: string[];
	/** CJK bigrams (question words / particles removed): LIKE fallback when the trigram MATCH finds nothing. */
	bigrams: string[];
}

const STOP_BIGRAMS = new Set(["什么", "多少", "多久", "怎么", "怎样", "如何", "哪些", "哪个", "哪里", "是否", "可以", "能否", "需要", "请问", "一下", "有没", "没有", "我们", "你们", "他们"]);
const PARTICLES = /[的了是吗呢在和与及或也都就把被给对从让吧啊么]/;

export function cjkBigrams(tok: string): string[] {
	const out: string[] = [];
	for (let i = 0; i + 2 <= tok.length; i++) {
		const g = tok.slice(i, i + 2);
		if (!STOP_BIGRAMS.has(g) && !PARTICLES.test(g)) out.push(g);
	}
	return out;
}

export function normalizeQuery(q: string): string {
	return q.normalize("NFKC").toLowerCase().trim();
}

const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;

export function planQuery(raw: string): QueryPlan {
	const q = normalizeQuery(raw);
	const tokens = q.match(TOKEN) ?? [];
	const fts = new Set<string>();
	const short = new Set<string>();
	const terms = new Set<string>();
	const bigrams = new Set<string>();
	for (const tok of tokens) {
		if (CJK.test(tok)) {
			terms.add(tok);
			for (const g of cjkBigrams(tok)) bigrams.add(g);
			if (tok.length < 3) {
				short.add(tok);
				continue;
			}
			if (tok.length <= 8) fts.add(tok);
			for (let i = 0; i + 3 <= tok.length; i++) fts.add(tok.slice(i, i + 3));
		} else {
			if (tok.length < 3) {
				short.add(tok);
				terms.add(tok);
			} else if (!STOP.has(tok) || tokens.length === 1) {
				fts.add(tok);
				terms.add(tok);
			}
		}
	}
	const ftsTerms = [...fts].slice(0, MAX_TERMS);
	const bg = [...bigrams].slice(0, 12);
	if (ftsTerms.length) return { match: ftsTerms.map(quote).join(" OR "), like: [], terms: [...terms], bigrams: bg };
	return { match: null, like: [...short].filter((t) => t.length > 0).slice(0, 8), terms: [...terms], bigrams: bg };
}

export function escapeLike(t: string): string {
	return t.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Fraction of query terms (CJK runs count by their trigram/bigram coverage) present in text. */
export function coverage(text: string, terms: readonly string[]): number {
	if (!terms.length) return 0;
	const t = normalizeQuery(text);
	let sum = 0;
	for (const term of terms) {
		if (t.includes(term)) {
			sum += 1;
			continue;
		}
		if (CJK.test(term) && term.length >= 3) {
			let hit = 0;
			const grams = term.length - 2;
			for (let i = 0; i < grams; i++) if (t.includes(term.slice(i, i + 3))) hit++;
			sum += hit / grams;
		}
	}
	return sum / terms.length;
}

/** Count of (non-overlapping) occurrences of short terms — LIKE fallback score. */
export function occurrences(text: string, terms: readonly string[]): number {
	const t = normalizeQuery(text);
	let n = 0;
	for (const term of terms) {
		if (!term) continue;
		let i = t.indexOf(term);
		while (i >= 0) {
			n++;
			i = t.indexOf(term, i + term.length);
		}
	}
	return n;
}

/** Best window (~maxLen chars) of `text` containing the most query term hits. Plain text, ellipsis-marked. */
export function makeSnippet(text: string, terms: readonly string[], maxLen = 220): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length <= maxLen) return clean;
	const lower = normalizeQuery(clean);
	const probes = new Set<string>();
	for (const t of terms) {
		if (CJK.test(t) && t.length > 3) for (let i = 0; i + 3 <= t.length; i++) probes.add(t.slice(i, i + 3));
		else probes.add(t);
	}
	const hits: number[] = [];
	for (const p of probes) {
		if (!p) continue;
		let i = lower.indexOf(p);
		while (i >= 0 && hits.length < 500) {
			hits.push(i);
			i = lower.indexOf(p, i + 1);
		}
	}
	let start = 0;
	if (hits.length) {
		hits.sort((a, b) => a - b);
		let best = 0;
		let j = 0;
		for (let i = 0; i < hits.length; i++) {
			while (hits[i]! - hits[j]! > maxLen * 0.8) j++;
			if (i - j + 1 > best) {
				best = i - j + 1;
				start = hits[j]!;
			}
		}
		start = Math.max(0, start - Math.floor(maxLen * 0.15));
	}
	const end = Math.min(clean.length, start + maxLen);
	start = Math.max(0, end - maxLen);
	return `${start > 0 ? "…" : ""}${clean.slice(start, end).trim()}${end < clean.length ? "…" : ""}`;
}
