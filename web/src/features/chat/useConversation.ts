import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationDetailResponse, ConversationState, EntriesPage, EntryDTO, SubmissionDTO } from "@shared/chat";
import { ApiError, get, post } from "@/lib/api";
import { localExecBus, localStreamQuery } from "@/features/localexec/bus";

export type StreamStatus = "connecting" | "live" | "reconnecting" | "offline" | "closed";

/**
 * Live conversation state over SSE (`snapshot` on connect, `state` on change). Closing the page only stops
 * the subscription — the run continues on the server. EventSource reconnects by itself; on reconnect a
 * fresh snapshot replaces the state, so no event is "missed".
 */
export function useConversationStream(spaceId: string, conversationId: number) {
	const [state, setState] = useState<ConversationState>();
	const [status, setStatus] = useState<StreamStatus>("connecting");
	const [error, setError] = useState<{ code: string; message: string }>();

	useEffect(() => {
		setState(undefined);
		setError(undefined);
		setStatus("connecting");
		let es: EventSource | null = null;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let attempts = 0;
		let disposed = false;
		const connect = () => {
			es = new EventSource(`/api/conversations/${spaceId}/${conversationId}/events${localStreamQuery()}`, { withCredentials: true });
			const onState = (ev: MessageEvent<string>) => {
				try {
					setState(JSON.parse(ev.data) as ConversationState);
					setStatus("live");
					setError(undefined);
					attempts = 0;
				} catch {
					/* ignore malformed frame */
				}
			};
			es.addEventListener("snapshot", onState);
			// Round 11 (R4): code_run jobs for this tab (see features/localexec).
			es.addEventListener("localjob", (ev) => { try { localExecBus.emit({ kind: "job", job: JSON.parse((ev as MessageEvent<string>).data) }); } catch { /* ignore */ } });
			es.addEventListener("localjob-cancel", (ev) => { try { localExecBus.emit({ kind: "cancel", cancel: JSON.parse((ev as MessageEvent<string>).data) }); } catch { /* ignore */ } });
			es.addEventListener("state", onState);
			es.addEventListener("error", (ev) => {
				const data = (ev as MessageEvent<string>).data;
				if (data) {
					// Server-sent error: the server closes the stream. Transient ones (runtime restarted, lease moved)
					// are retried with backoff; access errors are final.
					let err = { code: "error", message: data };
					try {
						err = JSON.parse(data);
					} catch {
						/* plain text */
					}
					es?.close();
					const final = /forbidden|not_found|unauthenticated/.test(err.code);
					setError(final || attempts > 5 ? err : undefined);
					setStatus(final ? "closed" : "reconnecting");
					if (!final && !disposed) retry = setTimeout(connect, Math.min(8000, 800 * 2 ** attempts++));
					return;
				}
				setStatus(es?.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
				if (es?.readyState === EventSource.CLOSED && !disposed) retry = setTimeout(connect, Math.min(8000, 800 * 2 ** attempts++));
			});
			es.onopen = () => setStatus("live");
		};
		connect();
		// A dropped network can leave an SSE connection hanging silently: react to the browser's own signal,
		// say so, and open a fresh stream (→ full snapshot) as soon as the network is back.
		const onOffline = () => {
			setStatus("offline");
		};
		const onOnline = () => {
			if (disposed) return;
			es?.close();
			if (retry) clearTimeout(retry);
			attempts = 0;
			setStatus("reconnecting");
			connect();
		};
		window.addEventListener("offline", onOffline);
		window.addEventListener("online", onOnline);
		return () => {
			disposed = true;
			if (retry) clearTimeout(retry);
			window.removeEventListener("offline", onOffline);
			window.removeEventListener("online", onOnline);
			es?.close();
		};
	}, [spaceId, conversationId]);

	return { state, status, error };
}

export function useConversationDetail(spaceId: string, conversationId: number) {
	const [detail, setDetail] = useState<ConversationDetailResponse>();
	const [parentDetail, setParentDetail] = useState<ConversationDetailResponse>();
	const [error, setError] = useState<ApiError | Error>();
	const [tick, setTick] = useState(0);
	useEffect(() => {
		let alive = true;
		get<ConversationDetailResponse>(`/conversations/${spaceId}/${conversationId}`)
			.then(async (d) => {
				if (!alive) return;
				setDetail(d);
				setError(undefined);
				const parent = d.parent ?? d.conversation.parent;
				if (parent) {
					const p = await get<ConversationDetailResponse>(`/conversations/${spaceId}/${parent.conversationId}`).catch(() => undefined);
					if (alive) setParentDetail(p);
				} else setParentDetail(undefined);
			})
			.catch((e) => alive && setError(e));
		return () => {
			alive = false;
		};
	}, [spaceId, conversationId, tick]);
	return { detail, parentDetail, error, reload: useCallback(() => setTick((x) => x + 1), []) };
}

/** Older entries loaded on demand ("加载更早的消息"), merged before the live window. */
export function useEarlierEntries(spaceId: string, conversationId: number) {
	const [earlier, setEarlier] = useState<EntryDTO[]>([]);
	const [hasMore, setHasMore] = useState<boolean | undefined>(undefined);
	const [loading, setLoading] = useState(false);
	useEffect(() => {
		setEarlier([]);
		setHasMore(undefined);
	}, [spaceId, conversationId]);
	const load = useCallback(
		async (beforeId: number) => {
			setLoading(true);
			try {
				const p = await get<EntriesPage>(`/conversations/${spaceId}/${conversationId}/entries?before=${beforeId}&limit=100`);
				setEarlier((e) => [...p.items, ...e]);
				setHasMore(p.next !== undefined);
			} finally {
				setLoading(false);
			}
		},
		[spaceId, conversationId],
	);
	return { earlier, hasMore, loading, load };
}

export interface TrackedSubmission {
	requestId: string;
	text: string;
	mode: string;
	submission: SubmissionDTO;
	at: number;
}

const TERMINAL = new Set(["done", "unanswered", "withdrawn"]);

/** Steer / follow-up feedback: poll each submission until it is answered, not applied, or withdrawn. */
export function useSubmissionTracker(spaceId: string, conversationId: number) {
	const [items, setItems] = useState<TrackedSubmission[]>([]);
	const itemsRef = useRef(items);
	itemsRef.current = items;
	useEffect(() => setItems([]), [spaceId, conversationId]);
	useEffect(() => {
		const t = setInterval(async () => {
			const pending = itemsRef.current.filter((i) => !TERMINAL.has(i.submission.status));
			if (!pending.length) return;
			for (const p of pending) {
				try {
					const r = await get<SubmissionDTO>(`/conversations/${spaceId}/${conversationId}/submissions/${p.submission.submissionId}`);
					const s = (r as unknown as { submission?: SubmissionDTO }).submission ?? r;
					setItems((xs) => xs.map((x) => (x.requestId === p.requestId ? { ...x, submission: { ...x.submission, ...s } } : x)));
				} catch {
					/* keep last known */
				}
			}
		}, 1200);
		return () => clearInterval(t);
	}, [spaceId, conversationId]);
	const track = useCallback((s: TrackedSubmission) => setItems((xs) => [...xs.filter((x) => x.requestId !== s.requestId), s]), []);
	const dismiss = useCallback((requestId: string) => setItems((xs) => xs.filter((x) => x.requestId !== requestId)), []);
	/** Withdraw an input that has not been applied yet (POST …/submissions/:id/withdraw) and show the server's answer. */
	const withdraw = useCallback(
		async (requestId: string) => {
			const it = itemsRef.current.find((x) => x.requestId === requestId);
			if (!it) return;
			const r = await post<{ result?: string; submission?: SubmissionDTO }>(`/conversations/${spaceId}/${conversationId}/submissions/${it.submission.submissionId}/withdraw`);
			const sub = r.submission;
			if (sub) setItems((xs) => xs.map((x) => (x.requestId === requestId ? { ...x, submission: { ...x.submission, ...sub } } : x)));
		},
		[spaceId, conversationId],
	);
	return { items, track, dismiss, withdraw };
}
