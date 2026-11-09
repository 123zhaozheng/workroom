import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, get } from "./api";

export interface ApiState<T> {
	data: T | undefined;
	error: ApiError | Error | undefined;
	loading: boolean;
	/** The route is not provided by the running server (module not connected). */
	unavailable: boolean;
	reload: () => void;
	setData: (fn: (prev: T | undefined) => T | undefined) => void;
}

/** GET a JSON resource. `path === null` skips the request. `pollMs` re-fetches while mounted (silent). */
export function useApi<T>(path: string | null, opts: { pollMs?: number } = {}): ApiState<T> {
	const [data, setDataState] = useState<T>();
	const [error, setError] = useState<ApiError | Error>();
	const [loading, setLoading] = useState(path !== null);
	const [tick, setTick] = useState(0);
	const first = useRef(true);

	useEffect(() => {
		first.current = true;
		setDataState(undefined);
		setError(undefined);
	}, [path]);

	useEffect(() => {
		if (path === null) {
			setLoading(false);
			return;
		}
		const ac = new AbortController();
		if (first.current) setLoading(true);
		get<T>(path, ac.signal)
			.then((d) => {
				setDataState(d);
				setError(undefined);
			})
			.catch((e) => {
				if ((e as Error)?.name !== "AbortError") setError(e);
			})
			.finally(() => {
				if (!ac.signal.aborted) {
					setLoading(false);
					first.current = false;
				}
			});
		return () => ac.abort();
	}, [path, tick]);

	useEffect(() => {
		if (!opts.pollMs || path === null) return;
		const t = setInterval(() => setTick((x) => x + 1), opts.pollMs);
		return () => clearInterval(t);
	}, [opts.pollMs, path]);

	const reload = useCallback(() => setTick((x) => x + 1), []);
	const setData = useCallback((fn: (prev: T | undefined) => T | undefined) => setDataState((p) => fn(p)), []);
	return { data, error, loading, unavailable: error instanceof ApiError && error.unavailable, reload, setData };
}
