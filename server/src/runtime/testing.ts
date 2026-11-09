// Test support for runtime-backed tests (any group may import it): SSE reader, polling helpers.
import type { ConversationState, SubmissionDTO } from "../../../shared/chat.ts";

export interface SseEvent {
	event: string;
	data: any;
	id?: string;
}

/** Read an SSE Response incrementally. `next(pred)` resolves with the first event matching pred. `close()` cancels the body. */
export function sseReader(res: Response) {
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	const queue: SseEvent[] = [];
	let ended = false;
	let waiters: (() => void)[] = [];
	const pump = (async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let i: number;
				while ((i = buf.indexOf("\n\n")) !== -1) {
					const raw = buf.slice(0, i);
					buf = buf.slice(i + 2);
					const ev: SseEvent = { event: "message", data: undefined };
					const dataLines: string[] = [];
					for (const line of raw.split("\n")) {
						if (line.startsWith("event:")) ev.event = line.slice(6).trim();
						else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
						else if (line.startsWith("id:")) ev.id = line.slice(3).trim();
					}
					const d = dataLines.join("\n");
					try {
						ev.data = d ? JSON.parse(d) : undefined;
					} catch {
						ev.data = d;
					}
					queue.push(ev);
					for (const w of waiters.splice(0)) w();
				}
			}
		} catch {
			/* cancelled */
		} finally {
			ended = true;
			for (const w of waiters.splice(0)) w();
		}
	})();
	let cursor = 0;
	return {
		events: queue,
		get ended() {
			return ended;
		},
		async next(pred: (e: SseEvent) => boolean = () => true, timeoutMs = 15_000): Promise<SseEvent> {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				while (cursor < queue.length) {
					const e = queue[cursor++]!;
					if (pred(e)) return e;
				}
				if (ended) throw new Error(`SSE ended before a matching event (got ${queue.map((q) => q.event).join(",")})`);
				const left = deadline - Date.now();
				if (left <= 0) throw new Error(`SSE timeout waiting for event (got ${queue.map((q) => q.event).join(",")})`);
				await new Promise<void>((r) => {
					const t = setTimeout(r, left);
					waiters.push(() => {
						clearTimeout(t);
						r();
					});
				});
			}
		},
		/** Wait for a state/snapshot event whose ConversationState satisfies pred. */
		async state(pred: (s: ConversationState) => boolean, timeoutMs = 15_000): Promise<ConversationState> {
			return (await this.next((e) => (e.event === "state" || e.event === "snapshot") && pred(e.data), timeoutMs)).data;
		},
		async close(): Promise<void> {
			await reader.cancel().catch(() => {});
			await pump;
		},
	};
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {}): Promise<T> {
	const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
	let last: unknown;
	for (;;) {
		try {
			const v = await fn();
			if (v) return v as T;
			last = v;
		} catch (e) {
			last = e;
		}
		if (Date.now() > deadline) throw new Error(`waitFor timed out: ${opts.what ?? ""} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
		await new Promise((r) => setTimeout(r, opts.intervalMs ?? 50));
	}
}

export const isSettled = (s: SubmissionDTO) => s.status === "done" || s.status === "unanswered" || s.status === "withdrawn";
