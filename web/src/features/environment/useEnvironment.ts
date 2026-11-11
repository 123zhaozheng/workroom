// One conversation's execution environment (GET /conversations/:spaceId/:conversationId/environment).
// Reading is cheap and never creates a sandbox. Polling is light and only while it can change: the state is "preparing", or the caller says a sandbox
// tool call is running (`active`) and nothing exists yet. It stops by itself when the state is ready / failed (or local).
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationEnvironmentDTO } from "@shared/sandbox";
import { errorText, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";

export const ENV_POLL_MS = 1000;

export function environmentPath(spaceId: string | undefined, conversationId: number | undefined): string | null {
	return spaceId ? `/conversations/${encodeURIComponent(spaceId)}/${conversationId ?? "new"}/environment` : null;
}

// The button and the status line read the same conversation: a result one of them obtains (a poll, a prepare) is handed to the other at once,
// so a retry in the popover updates the inline line and vice versa. In-memory only.
type Listener = (d: ConversationEnvironmentDTO, from: symbol) => void;
const bus = new Map<string, Set<Listener>>();

export function useEnvironment(spaceId: string | undefined, conversationId: number | undefined, active = false) {
	const path = environmentPath(spaceId, conversationId);
	// pollMs must be known before the data: start with `active` only for remote-looking states, then follow the data
	const [poll, setPoll] = useState(false);
	const res = useApi<ConversationEnvironmentDTO>(path, { pollMs: poll ? ENV_POLL_MS : undefined });
	const d = res.data;
	const self = useRef(Symbol("env"));
	const received = useRef<ConversationEnvironmentDTO | undefined>(undefined);
	const setData = res.setData;
	useEffect(() => {
		if (!path) return;
		const fn: Listener = (next, from) => {
			if (from === self.current) return;
			received.current = next;
			setData(() => next);
		};
		let set = bus.get(path);
		if (!set) bus.set(path, (set = new Set()));
		set.add(fn);
		return () => void set.delete(fn);
	}, [path, setData]);
	useEffect(() => {
		if (path && d && d !== received.current) for (const fn of bus.get(path) ?? []) fn(d, self.current);
	}, [path, d]);
	const want = !!d && d.kind === "remote" && (d.state === "preparing" || (active && (d.state === "none" || d.state === "lost")));
	if (want !== poll) setPoll(want);
	const [busy, setBusy] = useState(false);
	const [retryError, setRetryError] = useState<string>();
	const prepare = useCallback(async () => {
		if (!path) return;
		setBusy(true);
		setRetryError(undefined);
		try {
			const next = await post<ConversationEnvironmentDTO>(`${path}/prepare`);
			res.setData(() => next);
		} catch (e) {
			setRetryError(errorText(e));
			res.reload();
		} finally {
			setBusy(false);
		}
	}, [path, res]);
	return { env: d, reload: res.reload, setData: res.setData, loading: res.loading, error: res.error, unavailable: res.unavailable, prepare, busy, retryError, path };
}
