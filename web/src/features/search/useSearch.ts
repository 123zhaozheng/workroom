// Debounced conversation search (GET /search, shared/round9.ts). Stale answers are dropped (AbortController + sequence), the failure kind is
// kept apart so the UI can say "无权限" / "暂不可用" / "出错了" plainly.
import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchHitDTO } from "@shared/round9";
import { ApiError, errorText, get, qs } from "@/lib/api";

export type SearchErrorKind = "forbidden" | "unavailable" | "other";
export interface SearchState {
	status: "idle" | "loading" | "ok" | "error";
	hits: SearchHitDTO[];
	error?: { kind: SearchErrorKind; message: string };
	indexedThrough?: string;
	/** The query the shown hits belong to. */
	forQuery: string;
}
const IDLE: SearchState = { status: "idle", hits: [], forQuery: "" };

export function classifyError(e: unknown): { kind: SearchErrorKind; message: string } {
	if (e instanceof ApiError) {
		if (e.status === 403) return { kind: "forbidden", message: "无权限：你没有权限搜索这些内容。" };
		if (e.unavailable) return { kind: "unavailable", message: "搜索暂时不可用。" };
	}
	return { kind: "other", message: errorText(e) };
}

export function useSearch(query: string, opts: { debounceMs?: number; limit?: number; enabled?: boolean } = {}) {
	const { debounceMs = 200, limit = 20, enabled = true } = opts;
	const [state, setState] = useState<SearchState>(IDLE);
	const [tick, setTick] = useState(0);
	const q = query.trim();
	const seq = useRef(0);

	useEffect(() => {
		if (!enabled || !q) {
			seq.current++;
			setState(IDLE);
			return;
		}
		const mine = ++seq.current;
		const ac = new AbortController();
		setState((s) => ({ ...s, status: "loading", error: undefined }));
		const t = setTimeout(() => {
			get<{ results: SearchHitDTO[]; indexedThrough?: string }>(`/search${qs({ q, limit })}`, ac.signal)
				.then((r) => mine === seq.current && setState({ status: "ok", hits: r.results ?? [], indexedThrough: r.indexedThrough, forQuery: q }))
				.catch((e) => {
					if ((e as Error)?.name === "AbortError" || mine !== seq.current) return;
					setState({ status: "error", hits: [], error: classifyError(e), forQuery: q });
				});
		}, debounceMs);
		return () => {
			clearTimeout(t);
			ac.abort();
		};
	}, [q, enabled, debounceMs, limit, tick]);

	const retry = useCallback(() => setTick((x) => x + 1), []);
	return { ...state, retry };
}
