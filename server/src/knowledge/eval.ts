// Retrieval evaluation: run samples (query → expected hit) through the real search path for a principal.
import type { Principal } from "../core/contracts.ts";
import type { CitationDTO, KbEvalResult, KbEvalSample } from "../../../shared/knowledge.ts";
import type { KnowledgeStore } from "./service.ts";

export function matches(c: CitationDTO, e: KbEvalSample["expect"]): boolean {
	if (e.fileName && c.fileName !== e.fileName) return false;
	if (e.page !== undefined && c.page !== e.page) return false;
	if (e.section && !(c.section ?? "").includes(e.section)) return false;
	if (e.contains && !c.snippet.toLowerCase().includes(e.contains.toLowerCase())) return false;
	return true;
}

export async function runEval(store: KnowledgeStore, p: Principal, samples: readonly KbEvalSample[], opts: { kbIds?: string[]; k?: number; requestId?: string; explain?: boolean } = {}): Promise<KbEvalResult> {
	const k = opts.k ?? 5;
	const out: KbEvalResult["samples"][number][] = [];
	let rr = 0;
	let recall = 0;
	let positives = 0;
	for (const s of samples) {
		const res = await store.search(p, s.query, { kbIds: opts.kbIds, limit: Math.max(k, 10), debug: true, trace: { source: "eval", requestId: opts.requestId } });
		const why = (pass: boolean) => (opts.explain || !pass ? { kbDecisions: res.debug?.kbDecisions ?? [] } : {});
		const top = res.citations[0] ? `${res.citations[0].fileName} · ${res.citations[0].locator}` : undefined;
		if (s.expect.reason) {
			const pass = res.diagnostics.reason === s.expect.reason && res.citations.length === 0;
			out.push({ id: s.id, pass, rank: null, reason: res.diagnostics.reason, top, ...why(pass) });
			continue;
		}
		positives++;
		const idx = res.citations.findIndex((c) => matches(c, s.expect));
		const rank = idx >= 0 ? idx + 1 : null;
		if (rank !== null && rank <= k) recall++;
		if (rank !== null) rr += 1 / rank;
		const pass = rank !== null && rank <= k;
		out.push({ id: s.id, pass, rank, reason: res.diagnostics.reason, top, ...why(pass) });
	}
	return {
		total: samples.length,
		passed: out.filter((s) => s.pass).length,
		recallAt5: positives ? Math.round((recall / positives) * 1000) / 1000 : 1,
		mrr: positives ? Math.round((rr / positives) * 1000) / 1000 : 1,
		samples: out,
	};
}
