// Round 11 (R4): client of the local-execution API (conversation preference + status). The environment panel (main agent) uses these.
import { useCallback, useEffect, useState } from "react";
import type { LocalExecPreference, LocalExecStatusDTO } from "@shared/localexec";
import { get, put } from "@/lib/api";

export const getLocalExec = (spaceId: string, conversationId: number) => get<LocalExecStatusDTO>(`/conversations/${spaceId}/${conversationId}/local-exec`);
export const setLocalExecPreference = (spaceId: string, conversationId: number, preference: LocalExecPreference) => put<LocalExecStatusDTO>(`/conversations/${spaceId}/${conversationId}/local-exec`, { preference });

/** Status of a conversation's local execution, refreshed on demand; `setPreference` saves and returns the new status. */
export function useLocalExec(spaceId: string, conversationId: number) {
	const [status, setStatus] = useState<LocalExecStatusDTO>();
	const [error, setError] = useState<string>();
	const reload = useCallback(() => {
		getLocalExec(spaceId, conversationId).then(setStatus, (e) => setError(String(e?.message ?? e)));
	}, [spaceId, conversationId]);
	useEffect(reload, [reload]);
	const setPreference = useCallback(
		async (p: LocalExecPreference) => {
			try {
				setStatus(await setLocalExecPreference(spaceId, conversationId, p));
				setError(undefined);
			} catch (e) {
				setError(String((e as Error)?.message ?? e));
			}
		},
		[spaceId, conversationId],
	);
	return { status, error, reload, setPreference };
}
