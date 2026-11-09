// Local request limits and circuit breaker per provider (and optionally per model), applied around the native provider streams
// (gateway.wrapProvider). pi-ai has no such thing: its retry only reacts AFTER the upstream pushed back.
//   rpm          sliding 60 s window of started requests
//   concurrency  requests in flight
//   breaker      N consecutive infrastructure failures (server/network/timeout/overloaded/auth) open the circuit for `windowMs`;
//                afterwards it is HALF-OPEN: exactly one probe request is let through; success closes it, failure re-opens it.
// A denied request is never sent upstream. The gateway tries the model's fallbacks first; with none left the request fails with a
// retryable error whose first word is the error code (`local_rate_limit` | `concurrency` | `circuit_open`) and whose text matches pi-ai's
// retry patterns ("rate limit", "too many requests", "service unavailable"), so pi-durable retries with backoff — i.e. it queues.
export type LimitClass = "local_rate_limit" | "concurrency" | "circuit_open";
export type Outcome = "ok" | "infra_fail" | "other" | "aborted";
export const DEFAULT_BREAKER_THRESHOLD = 3;
export const DEFAULT_BREAKER_WINDOW_MS = 30_000;

export interface Scope {
	key: string;
	label: string;
	rpm?: number | null;
	concurrency?: number | null;
}
export interface BreakerCfg {
	key: string;
	label: string;
	threshold: number;
	windowMs: number;
}
export type Acquire = { denied: { cls: LimitClass; detail: string } } | { release: (o: Outcome) => void };

interface BreakerState {
	fails: number;
	openUntil: number;
	probing: boolean;
}

export class Limiter {
	now: () => number;
	readonly #inflight = new Map<string, number>();
	readonly #rpm = new Map<string, number[]>();
	readonly #breaker = new Map<string, BreakerState>();
	constructor(now: () => number) {
		this.now = now;
	}

	tryAcquire(scopes: Scope[], br: BreakerCfg | null): Acquire {
		const now = this.now();
		let probe: BreakerState | undefined;
		if (br && br.threshold > 0) {
			const b = this.#breaker.get(br.key);
			if (b) {
				if (b.openUntil > now) return { denied: { cls: "circuit_open", detail: `服务商「${br.label}」连续失败 ${b.fails} 次，熔断中，约 ${Math.ceil((b.openUntil - now) / 1000)} 秒后半开重试 — service unavailable` } };
				if (b.fails >= br.threshold) {
					if (b.probing) return { denied: { cls: "circuit_open", detail: `服务商「${br.label}」正在半开探测中，其它请求暂缓 — service unavailable` } };
					b.probing = true;
					probe = b;
				}
			}
		}
		const deny = (cls: LimitClass, detail: string): Acquire => {
			if (probe) probe.probing = false;
			return { denied: { cls, detail } };
		};
		for (const s of scopes) {
			if (s.concurrency && (this.#inflight.get(s.key) ?? 0) >= s.concurrency) return deny("concurrency", `「${s.label}」已达并发上限 ${s.concurrency}（too many requests in flight）`);
			if (s.rpm) {
				const w = (this.#rpm.get(s.key) ?? []).filter((t) => t > now - 60_000);
				this.#rpm.set(s.key, w);
				if (w.length >= s.rpm) return deny("local_rate_limit", `「${s.label}」已达每分钟 ${s.rpm} 次的本地限流（rate limit）`);
			}
		}
		for (const s of scopes) {
			this.#inflight.set(s.key, (this.#inflight.get(s.key) ?? 0) + 1);
			if (s.rpm) this.#rpm.get(s.key)!.push(now);
		}
		let done = false;
		return {
			release: (o) => {
				if (done) return;
				done = true;
				for (const s of scopes) this.#inflight.set(s.key, Math.max(0, (this.#inflight.get(s.key) ?? 1) - 1));
				if (!br || br.threshold <= 0) return;
				const b = this.#breaker.get(br.key);
				if (o === "ok" || o === "other") return void this.#breaker.delete(br.key); // the upstream answered: circuit closes
				if (o === "aborted") {
					if (b) b.probing = false;
					return;
				}
				const nb = b ?? { fails: 0, openUntil: 0, probing: false };
				nb.fails++;
				if (nb.probing || nb.fails >= br.threshold) nb.openUntil = this.now() + br.windowMs;
				nb.probing = false;
				this.#breaker.set(br.key, nb);
			},
		};
	}

	inflight(key: string): number {
		return this.#inflight.get(key) ?? 0;
	}
	circuit(key: string): { open: boolean; halfOpen: boolean; until?: number; fails: number } {
		const b = this.#breaker.get(key);
		if (!b) return { open: false, halfOpen: false, fails: 0 };
		const open = b.openUntil > this.now();
		return { open, halfOpen: !open && b.fails > 0 && b.openUntil > 0, until: open ? b.openUntil : undefined, fails: b.fails };
	}
	reset(key?: string): void {
		if (key) this.#breaker.delete(key);
		else this.#breaker.clear();
	}
}
