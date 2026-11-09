import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationDetailResponse, ConversationState, EntriesPage, EntryDTO, SubmissionDTO } from "@shared/chat";
import { ApiError, get } from "@/lib/api";

export type StreamStatus = "connecting" | "live" | "reconnecting" | "closed";

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
		const es = new EventSource(`/api/conversations/${spaceId}/${conversationId}/events`, { withCredentials: true });
		const onState = (ev: MessageEvent<string>) => {
			try {
				setState(JSON.parse(ev.data) as ConversationState);
				setStatus("live");
			} catch {
				/* ignore malformed frame */
			}
		};
		es.addEventListener("snapshot", onState);
		es.addEventListener("state", onState);
		es.addEventListener("error", (ev) => {
			const data = (ev as MessageEvent<string>).data;
			if (data) {
				try {
					setError(JSON.parse(data));
				} catch {
					setError({ code: "error", message: data });
				}
				es.close();
				setStatus("closed");
				return;
			}
			setStatus(es.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
		});
		es.onopen = () => setStatus("live");
		return () => es.close();
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
	return { items, track, dismiss };
}
