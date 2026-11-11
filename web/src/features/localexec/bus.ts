// Round 11 (R4): tiny bridge between the conversation's SSE stream (useConversation.ts) and the runner host (LocalExecHost.tsx).
import type { LocalJobAnnounce, LocalJobCancel } from "@shared/localexec";
import { runtimeSupported } from "./runtime/frame";

type Listener = (e: { kind: "job"; job: LocalJobAnnounce } | { kind: "cancel"; cancel: LocalJobCancel }) => void;
const listeners = new Set<Listener>();

/** One id per page load: this tab's identity for claims (the server accepts a claim only from a tab that holds an open stream with it). */
export const TAB_ID = (() => {
	try {
		return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
	} catch {
		return `t${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
	}
})();

/** Query string for the conversation stream: asks the server to treat this tab as a runner (only when the browser can really host the runtime). */
export function localStreamQuery(): string {
	return runtimeSupported() ? `?local=${TAB_ID}` : "";
}

export const localExecBus = {
	emit(e: Parameters<Listener>[0]) {
		for (const l of [...listeners]) l(e);
	},
	subscribe(l: Listener): () => void {
		listeners.add(l);
		return () => listeners.delete(l);
	},
};
